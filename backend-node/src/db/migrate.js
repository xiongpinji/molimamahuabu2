const fs = require('fs');
const path = require('path');
const { getDb } = require('./index.js');
const { loadConfig } = require('../config/index.js');

function stripLeadingComments(sql) {
  return sql
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return t.length > 0 && !t.startsWith('--');
    })
    .join('\n')
    .trim();
}

function runOne(database, sql, file, index) {
  const s = stripLeadingComments(sql);
  if (!s) return;
  try {
    database.exec(s);
    console.log('Ran migration:', file + (index >= 0 ? ' #' + (index + 1) : ''));
  } catch (err) {
    const msg = (err.message || '').toLowerCase();
    if (err.code === 'SQLITE_ERROR' && (msg.includes('duplicate column') || msg.includes('already exists'))) {
      console.log('Skip (already exists):', file + (index >= 0 ? ' #' + (index + 1) : ''));
    } else if (err.code === 'SQLITE_ERROR' && msg.includes('no such table')) {
      // ALTER TABLE 遇到表不存在时，记录警告并跳过（启动后 ensureAllColumns 会兜底建表补列）
      console.warn('Skip migration (table not found, will be ensured later):', file, '-', err.message);
    } else {
      throw err;
    }
  }
}

function runMigrations(database) {
  const migrationsDir = path.join(__dirname, '..', '..', 'migrations');
  if (!fs.existsSync(migrationsDir)) {
    console.log('Migrations dir missing, skipping:', migrationsDir);
    return;
  }
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const fullPath = path.join(migrationsDir, file);
    const sql = fs.readFileSync(fullPath, 'utf8');
    const statements = splitSqlStatements(sql);
    if (statements.length <= 1) {
      runOne(database, sql, file, -1);
    } else {
      statements.forEach((stmt, i) => runOne(database, stmt + ';', file, i));
    }
  }
}

function splitSqlStatements(sql) {
  const statements = [];
  let buffer = '';
  let inTrigger = false;
  for (const line of sql.split(/\r?\n/)) {
    const trimmed = line.trim();
    const upper = trimmed.toUpperCase();
    if (!inTrigger && upper.startsWith('CREATE TRIGGER')) inTrigger = true;
    buffer += `${line}\n`;
    if (inTrigger) {
      if (upper.endsWith('END;')) {
        statements.push(buffer.trim().replace(/;$/, ''));
        buffer = '';
        inTrigger = false;
      }
      continue;
    }
    if (trimmed.endsWith(';')) {
      statements.push(buffer.trim().replace(/;$/, ''));
      buffer = '';
    }
  }
  const tail = buffer.trim();
  if (tail) statements.push(tail.replace(/;$/, ''));
  return statements.filter((statement) => statement.length > 0);
}

/**
 * 通用：确保某张表存在指定列，不存在则 ALTER TABLE ADD COLUMN。
 * @param {object} database - better-sqlite3 实例
 * @param {string} table - 表名
 * @param {Array<{name:string, type:string}>} columns - 要确保存在的列
 */
function ensureColumns(database, table, columns) {
  let existing;
  try {
    existing = database.prepare(`PRAGMA table_info(${table})`).all();
  } catch (err) {
    if ((err.message || '').toLowerCase().includes('no such table')) {
      console.log(`ensureColumns: table ${table} not found, skip`);
      return;
    }
    throw err;
  }
  const names = new Set(existing.map((r) => r.name));
  for (const col of columns) {
    if (names.has(col.name)) continue;
    try {
      database.exec(`ALTER TABLE ${table} ADD COLUMN ${col.name} ${col.type}`);
      console.log(`ensureColumns: added ${table}.${col.name} (${col.type})`);
    } catch (e) {
      if ((e.message || '').toLowerCase().includes('duplicate column')) {
        // already exists (race / concurrent)
      } else {
        console.warn(`ensureColumns: failed to add ${table}.${col.name}:`, e.message);
      }
    }
  }
}

function tableExists(database, table) {
  return !!database
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table);
}

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function ensureRedrawWorkDurationConstraint(database) {
  if (!tableExists(database, 'redraw_works')) return;
  const table = database
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'redraw_works'")
    .get();
  const sql = table?.sql || '';
  const oldDurationCheck = /duration_ms\s+INTEGER\s+NOT\s+NULL\s+CHECK\s*\(\s*duration_ms\s+BETWEEN\s+15000\s+AND\s+3600000\s*\)/i;
  if (!oldDurationCheck.test(sql)) return;

  const tempTable = '__redraw_works_duration_rebuild';
  if (database.inTransaction) {
    throw new Error('redraw_works duration constraint migration requires no active transaction');
  }
  if (tableExists(database, tempTable)) {
    throw new Error('redraw_works duration rebuild temp table already exists');
  }
  const createTempSql = sql
    .replace(
      /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"redraw_works"|`redraw_works`|\[redraw_works\]|redraw_works)\s*\(/i,
      `CREATE TABLE ${quoteIdent(tempTable)} (`,
    )
    .replace(oldDurationCheck, 'duration_ms INTEGER NOT NULL CHECK (duration_ms BETWEEN 12000 AND 3600000)');
  if (createTempSql === sql || !createTempSql.startsWith(`CREATE TABLE ${quoteIdent(tempTable)}`)) {
    throw new Error('Unsupported redraw_works DDL for duration constraint migration');
  }

  const columns = database.prepare('PRAGMA table_info(redraw_works)').all().map((column) => column.name);
  const columnSql = columns.map(quoteIdent).join(', ');
  const indexes = database.prepare(`
    SELECT name, sql
    FROM sqlite_master
    WHERE type = 'index'
      AND tbl_name = 'redraw_works'
      AND sql IS NOT NULL
    ORDER BY name
  `).all();
  const foreignKeysEnabled = database.pragma('foreign_keys', { simple: true }) ? 1 : 0;

  try {
    database.pragma('foreign_keys = OFF');
    database.exec('BEGIN');
    database.exec(createTempSql);
    database.exec(`
      INSERT INTO ${quoteIdent(tempTable)} (${columnSql})
      SELECT ${columnSql} FROM redraw_works
    `);
    database.exec('DROP TABLE redraw_works');
    database.exec(`ALTER TABLE ${quoteIdent(tempTable)} RENAME TO redraw_works`);
    for (const index of indexes) {
      database.exec(index.sql);
    }
    database.exec('COMMIT');
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch (_) {}
    throw error;
  } finally {
    database.pragma(`foreign_keys = ${foreignKeysEnabled ? 'ON' : 'OFF'}`);
  }
}

const REDRAW_WORK_VERSION_STATUSES = [
  'draft',
  'analyzing',
  'asset_review',
  'ready_to_generate',
  'generating',
  'composing',
  'completed',
  'failed',
  'needs_attention',
  'needs_review',
  'blocked',
];

function rebuildTableFromSql(database, tableName, tempTable, createTempSql) {
  if (database.inTransaction) {
    throw new Error(`${tableName} rebuild requires no active transaction`);
  }
  if (tableExists(database, tempTable)) {
    throw new Error(`${tableName} status rebuild temp table already exists`);
  }
  if (!createTempSql.startsWith(`CREATE TABLE ${quoteIdent(tempTable)}`)) {
    throw new Error(`Unsupported ${tableName} DDL for status constraint migration`);
  }

  const columns = database.prepare(`PRAGMA table_info(${quoteIdent(tableName)})`).all().map((column) => column.name);
  const columnSql = columns.map(quoteIdent).join(', ');
  const dependentSql = database.prepare(`
    SELECT type, name, sql
    FROM sqlite_master
    WHERE tbl_name = ?
      AND type IN ('index', 'trigger')
      AND sql IS NOT NULL
    ORDER BY type, name
  `).all(tableName);
  const foreignKeysEnabled = database.pragma('foreign_keys', { simple: true }) ? 1 : 0;

  try {
    database.pragma('foreign_keys = OFF');
    database.exec('BEGIN');
    database.exec(createTempSql);
    database.exec(`
      INSERT INTO ${quoteIdent(tempTable)} (${columnSql})
      SELECT ${columnSql} FROM ${quoteIdent(tableName)}
    `);
    database.exec(`DROP TABLE ${quoteIdent(tableName)}`);
    database.exec(`ALTER TABLE ${quoteIdent(tempTable)} RENAME TO ${quoteIdent(tableName)}`);
    for (const item of dependentSql) {
      database.exec(item.sql);
    }
    database.exec('COMMIT');
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch (_) {}
    throw error;
  } finally {
    database.pragma(`foreign_keys = ${foreignKeysEnabled ? 'ON' : 'OFF'}`);
  }
}

function ensureRedrawStatusConstraint(database, tableName) {
  if (!tableExists(database, tableName)) return;
  const table = database
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName);
  const sql = table?.sql || '';
  if (/\bneeds_review\b/i.test(sql) && /\bblocked\b/i.test(sql)) return;

  const statusCheck = /status\s+TEXT\s+NOT\s+NULL\s+DEFAULT\s+'draft'\s+CHECK\s*\(\s*status\s+IN\s*\(([^)]*)\)\s*\)/i;
  if (!statusCheck.test(sql)) return;
  const tempTable = `__${tableName}_status_rebuild`;
  const nextStatusSql = `status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN (${REDRAW_WORK_VERSION_STATUSES.map((status) => `'${status}'`).join(', ')}))`;
  const createTempSql = sql
    .replace(
      new RegExp(`^CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(?:"${tableName}"|\`${tableName}\`|\\[${tableName}\\]|${tableName})\\s*\\(`, 'i'),
      `CREATE TABLE ${quoteIdent(tempTable)} (`,
    )
    .replace(statusCheck, nextStatusSql);
  if (createTempSql === sql) {
    throw new Error(`Unsupported ${tableName} DDL for status constraint migration`);
  }
  rebuildTableFromSql(database, tableName, tempTable, createTempSql);
}

function ensureRedrawWorkflowStatusConstraints(database) {
  ensureRedrawStatusConstraint(database, 'redraw_works');
  ensureRedrawStatusConstraint(database, 'redraw_versions');
}

function ensureRedrawWorkSourceIndex(database) {
  if (!tableExists(database, 'redraw_works')) return;
  database.transaction(() => {
    const duplicate = database.prepare(`
      SELECT tenant_id, user_id, source_fingerprint, COUNT(*) AS count
      FROM redraw_works
      WHERE deleted_at IS NULL
        AND tenant_id IS NOT NULL
        AND user_id IS NOT NULL
        AND source_fingerprint IS NOT NULL
        AND source_fingerprint <> ''
      GROUP BY tenant_id, user_id, source_fingerprint
      HAVING COUNT(*) > 1
      LIMIT 1
    `).get();
    if (duplicate) {
      const error = new Error(
        `redraw_works active source duplicates: tenant=${duplicate.tenant_id}, user=${duplicate.user_id}, source=${duplicate.source_fingerprint}, count=${duplicate.count}`,
      );
      error.code = 'REDRAW_WORK_SOURCE_DUPLICATE';
      throw error;
    }
    database.exec(`
      DROP INDEX IF EXISTS uq_redraw_work_source;
      CREATE UNIQUE INDEX IF NOT EXISTS uq_redraw_work_source
        ON redraw_works(tenant_id, user_id, source_fingerprint)
        WHERE deleted_at IS NULL;
    `);
  })();
}

/**
 * 全量兜底补列：覆盖所有表的所有业务列。
 * 对于旧数据库（用更早版本的 init 脚本创建、缺少部分列），
 * 在每次启动时自动补齐，避免 "no such column" 运行时错误。
 *
 * SQLite 不支持 ALTER TABLE ADD COLUMN ... NOT NULL（无默认值），
 * 所以原 schema 中 NOT NULL 的列在这里用 DEFAULT 兜底。
 */
function ensureAllColumns(database) {
  ensureColumns(database, 'platform_users', [
    { name: 'platform_role', type: 'TEXT NOT NULL DEFAULT \'user\'' },
    { name: 'token_version', type: 'INTEGER NOT NULL DEFAULT 0' },
  ]);

  // --- dramas ---
  ensureColumns(database, 'dramas', [
    { name: 'user_id',         type: 'TEXT' },
    { name: 'tenant_id',       type: 'TEXT' },
    { name: 'folder_id',       type: 'INTEGER' },
    { name: 'title',          type: 'TEXT NOT NULL DEFAULT \'\'' },
    { name: 'description',    type: 'TEXT' },
    { name: 'genre',          type: 'TEXT' },
    { name: 'style',          type: 'TEXT DEFAULT \'realistic\'' },
    { name: 'tags',           type: 'TEXT' },
    { name: 'thumbnail',      type: 'TEXT' },
    { name: 'total_episodes', type: 'INTEGER DEFAULT 1' },
    { name: 'total_duration', type: 'INTEGER DEFAULT 0' },
    { name: 'status',         type: 'TEXT DEFAULT \'draft\'' },
    { name: 'metadata',       type: 'TEXT' },
    { name: 'created_at',     type: 'TEXT' },
    { name: 'updated_at',     type: 'TEXT' },
    { name: 'deleted_at',     type: 'TEXT' },
  ]);

  // --- episodes ---
  ensureColumns(database, 'episodes', [
    { name: 'drama_id',       type: 'INTEGER DEFAULT 0' },
    { name: 'episode_number', type: 'INTEGER DEFAULT 0' },
    { name: 'title',          type: 'TEXT DEFAULT \'\'' },
    { name: 'script_content', type: 'TEXT' },
    { name: 'description',    type: 'TEXT' },
    { name: 'duration',       type: 'INTEGER DEFAULT 0' },
    { name: 'video_url',      type: 'TEXT' },
    { name: 'thumbnail',      type: 'TEXT' },
    { name: 'status',         type: 'TEXT DEFAULT \'draft\'' },
    { name: 'created_at',     type: 'TEXT' },
    { name: 'updated_at',     type: 'TEXT' },
    { name: 'deleted_at',     type: 'TEXT' },
  ]);

  // --- storyboards ---
  ensureColumns(database, 'storyboards', [
    { name: 'episode_id',        type: 'INTEGER DEFAULT 0' },
    { name: 'scene_id',          type: 'INTEGER' },
    { name: 'storyboard_number', type: 'INTEGER DEFAULT 0' },
    { name: 'title',             type: 'TEXT' },
    { name: 'description',       type: 'TEXT' },
    { name: 'layout_description', type: 'TEXT' },   // 画面布局与人物站位（首尾帧模式空间合同）
    { name: 'location',          type: 'TEXT' },
    { name: 'time',              type: 'TEXT' },
    { name: 'duration',          type: 'REAL' },
    { name: 'dialogue',          type: 'TEXT' },
    { name: 'narration',         type: 'TEXT' },
    { name: 'action',            type: 'TEXT' },
    { name: 'atmosphere',        type: 'TEXT' },
    { name: 'image_prompt',      type: 'TEXT' },
    { name: 'video_prompt',      type: 'TEXT' },
    { name: 'image_model',       type: 'TEXT' },               // 分镜级图片模型覆盖，NULL/空值表示跟随项目默认
    { name: 'video_model',       type: 'TEXT' },               // 分镜级视频模型覆盖，NULL/空值表示跟随项目默认
    { name: 'characters',        type: 'TEXT' },
    { name: 'shot_type',         type: 'TEXT' },
    { name: 'angle',             type: 'TEXT' },
    { name: 'movement',          type: 'TEXT' },
    { name: 'image_url',         type: 'TEXT' },
    { name: 'local_path',        type: 'TEXT' },
    { name: 'main_panel_idx',    type: 'INTEGER' },
    { name: 'video_url',         type: 'TEXT' },
    { name: 'composed_image',    type: 'TEXT' },
    { name: 'result',            type: 'TEXT' },
    { name: 'emotion',           type: 'TEXT' },               // 当前情绪（兴奋/悲伤/紧张等）
    { name: 'emotion_intensity', type: 'INTEGER' },            // 情绪强度 3/2/1/0/-1
    { name: 'error_msg',         type: 'TEXT' },
    { name: 'segment_index',     type: 'INTEGER DEFAULT 0' },  // 剧情段落索引（0-based）
    { name: 'segment_title',     type: 'TEXT' },               // 剧情段落名称
    { name: 'angle_h',           type: 'TEXT' },               // 水平方向（front/left/back/right...）
    { name: 'angle_v',           type: 'TEXT' },               // 俯仰角度（worm/low/eye_level/high）
    { name: 'angle_s',           type: 'TEXT' },               // 景别（close_up/medium/wide）
    { name: 'lighting_style',    type: 'TEXT' },               // 灯光风格（natural/side/dramatic/golden_hour 等）
    { name: 'depth_of_field',    type: 'TEXT' },               // 景深（shallow/medium/deep/extreme_shallow）
    { name: 'polished_prompt',        type: 'TEXT' },               // 文字AI润色后的图片生成提示词（可编辑，生图时优先使用）
    { name: 'continuity_snapshot',   type: 'TEXT' },               // JSON: 连戏状态快照 {characters:{name:{position,clothing,expression,props}},lighting}
    { name: 'audio_local_path',      type: 'TEXT' },               // 对白 TTS 本地路径
    { name: 'audio_url',             type: 'TEXT' },               // 对白远程音频素材 URL
    { name: 'narration_audio_local_path', type: 'TEXT' },         // 解说旁白 TTS 本地路径
    { name: 'narration_audio_url',   type: 'TEXT' },               // 解说旁白远程音频素材 URL
    { name: 'creation_mode',     type: 'TEXT DEFAULT \'classic\'' }, // classic | universal
    { name: 'universal_segment_text', type: 'TEXT' },              // 全能模式片段描述（@ 引用等）
    { name: 'first_frame_image_id', type: 'INTEGER' },
    { name: 'last_frame_image_id',  type: 'INTEGER' },
    { name: 'last_frame_image_url', type: 'TEXT' },
    { name: 'last_frame_local_path', type: 'TEXT' },
    { name: 'status',            type: 'TEXT DEFAULT \'draft\'' },
    { name: 'created_at',        type: 'TEXT' },
    { name: 'updated_at',        type: 'TEXT' },
    { name: 'deleted_at',        type: 'TEXT' },
  ]);

  // --- characters ---
  ensureColumns(database, 'characters', [
    { name: 'drama_id',          type: 'INTEGER DEFAULT 0' },
    { name: 'name',              type: 'TEXT NOT NULL DEFAULT \'\'' },
    { name: 'role',              type: 'TEXT' },
    { name: 'description',       type: 'TEXT' },
    { name: 'personality',       type: 'TEXT' },
    { name: 'appearance',        type: 'TEXT' },
    { name: 'image_url',         type: 'TEXT' },
    { name: 'local_path',        type: 'TEXT' },
    { name: 'extra_images',      type: 'TEXT' },
    { name: 'voice_style',       type: 'TEXT' },
    { name: 'sort_order',        type: 'INTEGER DEFAULT 0' },
    { name: 'error_msg',         type: 'TEXT' },
    { name: 'identity_anchors',  type: 'TEXT' },   // JSON: 6层视觉锚点（骨相/五官/辨识标记/色值/皮肤/发型）
    { name: 'style_tokens',      type: 'TEXT' },   // 风格词 token 列表
    { name: 'color_palette',     type: 'TEXT' },   // JSON: Hex 色值数组
    { name: 'four_view_image_url', type: 'TEXT' }, // 四视图参考图 URL
    { name: 'polished_prompt',   type: 'TEXT' },   // 文字AI润色后的完整图片生成提示词（可编辑，生图时直接使用）
    { name: 'ref_image',         type: 'TEXT' },   // 用户上传的参考图（本地相对路径或 URL），独立于 AI 生成的主图
    { name: 'stages',            type: 'TEXT' },   // JSON: 多阶段造型 [{episode_range:[1,3], appearance:"..."}]
    { name: 'seedance2_asset', type: 'TEXT' },   // JSON: 即梦/Seedance2 素材库认证 hub_asset_id / asset_url 等
    { name: 'seedance2_voice_asset', type: 'TEXT' }, // JSON: Seedance 2.0 音色参考音频（仅 SD2 模型有效）
    { name: 'negative_prompt', type: 'TEXT' },
    { name: 'created_at',        type: 'TEXT' },
    { name: 'updated_at',        type: 'TEXT' },
    { name: 'deleted_at',        type: 'TEXT' },
  ]);

  // --- scenes ---
  ensureColumns(database, 'scenes', [
    { name: 'drama_id',         type: 'INTEGER DEFAULT 0' },
    { name: 'episode_id',       type: 'INTEGER' },
    { name: 'location',         type: 'TEXT' },
    { name: 'time',             type: 'TEXT' },
    { name: 'prompt',           type: 'TEXT' },
    { name: 'polished_prompt',  type: 'TEXT' },  // 文字AI润色后的完整四视图图片提示词，生图时直接使用
    { name: 'image_url',        type: 'TEXT' },
    { name: 'local_path',       type: 'TEXT' },
    { name: 'panorama_image_url', type: 'TEXT' },
    { name: 'panorama_local_path', type: 'TEXT' },
    { name: 'extra_images',     type: 'TEXT' },
    { name: 'ref_image',        type: 'TEXT' },  // 用户上传的参考图（本地相对路径或 URL）
    { name: 'negative_prompt',  type: 'TEXT' },
    { name: 'storyboard_count', type: 'INTEGER DEFAULT 0' },
    { name: 'error_msg',        type: 'TEXT' },
    { name: 'status',           type: 'TEXT DEFAULT \'draft\'' },
    { name: 'created_at',       type: 'TEXT' },
    { name: 'updated_at',       type: 'TEXT' },
    { name: 'deleted_at',       type: 'TEXT' },
  ]);

  // --- props ---
  ensureColumns(database, 'props', [
    { name: 'drama_id',    type: 'INTEGER DEFAULT 0' },
    { name: 'episode_id',  type: 'INTEGER' },
    { name: 'name',        type: 'TEXT NOT NULL DEFAULT \'\'' },
    { name: 'type',        type: 'TEXT' },
    { name: 'description', type: 'TEXT' },
    { name: 'prompt',      type: 'TEXT' },
    { name: 'image_url',    type: 'TEXT' },
    { name: 'local_path',   type: 'TEXT' },
    { name: 'extra_images', type: 'TEXT' },
    { name: 'ref_image',    type: 'TEXT' },  // 用户上传的参考图（本地相对路径或 URL）
    { name: 'negative_prompt', type: 'TEXT' },
    { name: 'error_msg',    type: 'TEXT' },
    { name: 'created_at',   type: 'TEXT' },
    { name: 'updated_at',   type: 'TEXT' },
    { name: 'deleted_at',   type: 'TEXT' },
  ]);

  ensureColumns(database, 'model_credit_prices', [
    { name: 'public_note', type: 'TEXT NOT NULL DEFAULT \'\'' },
  ]);

  // --- ai_service_configs ---（兜底建表：旧版 01_init.sql 可能未包含此表）
  try {
    database.exec(`CREATE TABLE IF NOT EXISTS ai_service_configs (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      service_type  TEXT NOT NULL DEFAULT 'text',
      provider      TEXT DEFAULT '',
      name          TEXT DEFAULT '',
      base_url      TEXT DEFAULT '',
      api_key       TEXT,
      model         TEXT,
      default_model TEXT,
      endpoint      TEXT,
      query_endpoint TEXT,
      priority      INTEGER DEFAULT 0,
      is_default    INTEGER DEFAULT 0,
      is_active     INTEGER DEFAULT 1,
      verification_status TEXT NOT NULL DEFAULT 'unverified',
      verification_checked_at TEXT,
      verified_at   TEXT,
      verification_error TEXT,
      settings      TEXT,
      created_at    TEXT,
      updated_at    TEXT,
      deleted_at    TEXT
    )`);
  } catch (_) {}
  ensureColumns(database, 'ai_service_configs', [
    { name: 'service_type',   type: 'TEXT NOT NULL DEFAULT \'text\'' },
    { name: 'provider',       type: 'TEXT DEFAULT \'\'' },
    { name: 'name',           type: 'TEXT DEFAULT \'\'' },
    { name: 'base_url',       type: 'TEXT DEFAULT \'\'' },
    { name: 'api_key',        type: 'TEXT' },
    { name: 'model',          type: 'TEXT' },
    { name: 'default_model',  type: 'TEXT' },
    { name: 'endpoint',       type: 'TEXT' },
    { name: 'query_endpoint', type: 'TEXT' },
    { name: 'priority',       type: 'INTEGER DEFAULT 0' },
    { name: 'is_default',     type: 'INTEGER DEFAULT 0' },
    { name: 'is_active',      type: 'INTEGER DEFAULT 1' },
    { name: 'verification_status', type: 'TEXT NOT NULL DEFAULT \'unverified\'' },
    { name: 'verification_checked_at', type: 'TEXT' },
    { name: 'verified_at',    type: 'TEXT' },
    { name: 'verification_error', type: 'TEXT' },
    { name: 'settings',       type: 'TEXT' },
    { name: 'verification_status', type: 'TEXT NOT NULL DEFAULT \'pending\'' },
    { name: 'verified_capabilities', type: 'TEXT NOT NULL DEFAULT \'{}\'' },
    { name: 'verified_at', type: 'TEXT' },
    { name: 'verification_error', type: 'TEXT' },
    { name: 'created_at',     type: 'TEXT' },
    { name: 'updated_at',     type: 'TEXT' },
    { name: 'deleted_at',     type: 'TEXT' },
  ]);

  // --- async_tasks ---
  ensureColumns(database, 'async_tasks', [
    { name: 'type',         type: 'TEXT NOT NULL DEFAULT \'\'' },
    { name: 'status',       type: 'TEXT NOT NULL DEFAULT \'pending\'' },
    { name: 'progress',     type: 'INTEGER DEFAULT 0' },
    { name: 'message',      type: 'TEXT' },
    { name: 'resource_id',  type: 'TEXT' },
    { name: 'completed_at', type: 'TEXT' },
    { name: 'error',        type: 'TEXT' },
    { name: 'result',       type: 'TEXT' },
    { name: 'created_at',   type: 'TEXT' },
    { name: 'updated_at',   type: 'TEXT' },
    { name: 'deleted_at',   type: 'TEXT' },
    { name: 'user_id',      type: 'TEXT' },
    { name: 'tenant_id',    type: 'TEXT' },
    { name: 'model',        type: 'TEXT' },
    { name: 'credit_reservation_id', type: 'TEXT' },
    { name: 'provider_task_id', type: 'TEXT' },
    { name: 'metadata',     type: 'TEXT' },
  ]);

  // --- image_generations ---
  ensureColumns(database, 'image_generations', [
    { name: 'storyboard_id',    type: 'INTEGER' },
    { name: 'drama_id',         type: 'INTEGER' },
    { name: 'episode_id',       type: 'INTEGER' },
    { name: 'scene_id',         type: 'INTEGER' },
    { name: 'character_id',     type: 'INTEGER' },
    { name: 'provider',         type: 'TEXT' },
    { name: 'image_type',       type: 'TEXT' },
    { name: 'prompt',           type: 'TEXT' },
    { name: 'negative_prompt',  type: 'TEXT' },
    { name: 'model',            type: 'TEXT' },
    { name: 'frame_type',       type: 'TEXT' },
    { name: 'reference_images', type: 'TEXT' },
    { name: 'use_first_frame_layout_lock', type: 'INTEGER' },
    { name: 'size',             type: 'TEXT' },
    { name: 'quality',          type: 'TEXT' },
    { name: 'image_url',        type: 'TEXT' },
    { name: 'local_path',       type: 'TEXT' },
    { name: 'width',            type: 'INTEGER' },
    { name: 'height',           type: 'INTEGER' },
    { name: 'status',           type: 'TEXT' },
    { name: 'task_id',          type: 'TEXT' },
    { name: 'completed_at',     type: 'TEXT' },
    { name: 'error_msg',        type: 'TEXT' },
    { name: 'created_at',       type: 'TEXT' },
    { name: 'updated_at',       type: 'TEXT' },
    { name: 'deleted_at',       type: 'TEXT' },
    { name: 'user_id',          type: 'TEXT' },
    { name: 'tenant_id',        type: 'TEXT' },
    { name: 'credit_reservation_id', type: 'TEXT' },
  ]);

  // --- video_generations ---
  ensureColumns(database, 'video_generations', [
    { name: 'drama_id',             type: 'INTEGER' },
    { name: 'storyboard_id',        type: 'INTEGER' },
    { name: 'provider',             type: 'TEXT' },
    { name: 'prompt',               type: 'TEXT' },
    { name: 'model',                type: 'TEXT' },
    { name: 'duration',             type: 'REAL' },
    { name: 'aspect_ratio',         type: 'TEXT' },
    { name: 'resolution',           type: 'TEXT' },
    { name: 'seed',                 type: 'INTEGER' },
    { name: 'camera_fixed',         type: 'INTEGER' },
    { name: 'watermark',            type: 'INTEGER' },
    { name: 'image_url',            type: 'TEXT' },
    { name: 'first_frame_url',      type: 'TEXT' },
    { name: 'last_frame_url',       type: 'TEXT' },
    { name: 'output_first_frame_url', type: 'TEXT' },
    { name: 'output_last_frame_url',  type: 'TEXT' },
    { name: 'reference_image_urls', type: 'TEXT' },
    { name: 'reference_video_url',  type: 'TEXT' },
    { name: 'reference_audio_url',  type: 'TEXT' },
    { name: 'reference_mode',       type: 'TEXT' },
    { name: 'generate_audio',       type: 'INTEGER NOT NULL DEFAULT 0' },
    { name: 'reference_video_urls', type: 'TEXT' },
    { name: 'source_conditioning_json', type: 'TEXT' },
    { name: 'ai_service_config_id', type: 'INTEGER' },
    { name: 'reference_audio_urls', type: 'TEXT' },
    { name: 'request_snapshot',     type: 'TEXT' },
    { name: 'video_url',            type: 'TEXT' },
    { name: 'local_path',           type: 'TEXT' },
    { name: 'status',               type: 'TEXT' },
    { name: 'task_id',              type: 'TEXT' },
    { name: 'provider_task_id',     type: 'TEXT' },
    { name: 'scene_id',             type: 'INTEGER' },
    { name: 'completed_at',         type: 'TEXT' },
    { name: 'error_msg',            type: 'TEXT' },
    { name: 'created_at',           type: 'TEXT' },
    { name: 'updated_at',           type: 'TEXT' },
    { name: 'deleted_at',           type: 'TEXT' },
    { name: 'user_id',              type: 'TEXT' },
    { name: 'tenant_id',            type: 'TEXT' },
    { name: 'credit_reservation_id', type: 'TEXT' },
  ]);

  // --- video_merges ---
  ensureColumns(database, 'video_merges', [
    { name: 'episode_id',   type: 'INTEGER' },
    { name: 'drama_id',     type: 'INTEGER' },
    { name: 'title',        type: 'TEXT' },
    { name: 'provider',     type: 'TEXT' },
    { name: 'model',        type: 'TEXT' },
    { name: 'status',       type: 'TEXT' },
    { name: 'scenes',       type: 'TEXT' },
    { name: 'merge_options', type: 'TEXT' },
    { name: 'task_id',      type: 'TEXT' },
    { name: 'merged_url',   type: 'TEXT' },
    { name: 'duration',     type: 'INTEGER' },
    { name: 'completed_at', type: 'TEXT' },
    { name: 'error_msg',    type: 'TEXT' },
    { name: 'created_at',   type: 'TEXT' },
    { name: 'deleted_at',   type: 'TEXT' },
  ]);

  // --- assets ---
  ensureColumns(database, 'assets', [
    { name: 'drama_id',     type: 'INTEGER' },
    { name: 'storyboard_id', type: 'INTEGER' },
    { name: 'name',         type: 'TEXT' },
    { name: 'type',         type: 'TEXT' },
    { name: 'category',     type: 'TEXT' },
    { name: 'url',          type: 'TEXT' },
    { name: 'local_path',   type: 'TEXT' },
    { name: 'file_size',    type: 'INTEGER' },
    { name: 'mime_type',    type: 'TEXT' },
    { name: 'width',        type: 'INTEGER' },
    { name: 'height',       type: 'INTEGER' },
    { name: 'duration',     type: 'REAL' },
    { name: 'metadata',     type: 'TEXT' },
    { name: 'image_gen_id', type: 'INTEGER' },
    { name: 'video_gen_id', type: 'INTEGER' },
    { name: 'created_at',   type: 'TEXT' },
    { name: 'updated_at',   type: 'TEXT' },
    { name: 'deleted_at',   type: 'TEXT' },
  ]);

  // --- redraw source analysis ---
  try {
    database.exec(`CREATE TABLE IF NOT EXISTS redraw_works (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      source_asset_id TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      current_step INTEGER DEFAULT 1,
      task_id TEXT,
      provider_task_id TEXT,
      credit_reservation_id TEXT,
      error_msg TEXT,
      created_at TEXT,
      updated_at TEXT,
      deleted_at TEXT
    )`);
    database.exec(`CREATE TABLE IF NOT EXISTS redraw_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_id TEXT NOT NULL,
      source_facts_json TEXT,
      facts_hash TEXT,
      created_at TEXT,
      updated_at TEXT,
      deleted_at TEXT
    )`);
    database.exec(`CREATE TABLE IF NOT EXISTS redraw_shots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_id TEXT NOT NULL,
      version_id INTEGER,
      shot_id TEXT,
      start_ms INTEGER,
      end_ms INTEGER,
      draft_json TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      created_at TEXT,
      updated_at TEXT,
      deleted_at TEXT,
      UNIQUE(work_id, shot_id)
    )`);
  } catch (_) {}
  ensureColumns(database, 'redraw_works', [
    { name: 'user_id', type: 'TEXT' },
    { name: 'source_asset_id', type: 'TEXT' },
    { name: 'status', type: 'TEXT NOT NULL DEFAULT \'draft\'' },
    { name: 'current_step', type: 'INTEGER DEFAULT 1' },
    { name: 'task_id', type: 'TEXT' },
    { name: 'provider_task_id', type: 'TEXT' },
    { name: 'credit_reservation_id', type: 'TEXT' },
    { name: 'error_msg', type: 'TEXT' },
    { name: 'created_at', type: 'TEXT' },
    { name: 'updated_at', type: 'TEXT' },
    { name: 'deleted_at', type: 'TEXT' },
  ]);
  ensureColumns(database, 'redraw_versions', [
    { name: 'work_id', type: 'TEXT NOT NULL DEFAULT \'\'' },
    { name: 'source_facts_json', type: 'TEXT' },
    { name: 'facts_hash', type: 'TEXT' },
    { name: 'localization_task_id', type: 'TEXT' },
    { name: 'localization_credit_reservation_id', type: 'TEXT' },
    { name: 'localization_input_hash', type: 'TEXT' },
    { name: 'localization_idempotency_key', type: 'TEXT' },
    { name: 'localization_model_snapshot_json', type: 'TEXT NOT NULL DEFAULT \'{}\'' },
    { name: 'created_at', type: 'TEXT' },
    { name: 'updated_at', type: 'TEXT' },
    { name: 'deleted_at', type: 'TEXT' },
  ]);
  ensureColumns(database, 'redraw_shots', [
    { name: 'work_id', type: 'TEXT NOT NULL DEFAULT \'\'' },
    { name: 'version_id', type: 'INTEGER' },
    { name: 'shot_id', type: 'TEXT' },
    { name: 'start_ms', type: 'INTEGER' },
    { name: 'end_ms', type: 'INTEGER' },
    { name: 'draft_json', type: 'TEXT' },
    { name: 'status', type: 'TEXT NOT NULL DEFAULT \'draft\'' },
    { name: 'created_at', type: 'TEXT' },
    { name: 'updated_at', type: 'TEXT' },
    { name: 'deleted_at', type: 'TEXT' },
  ]);

  // --- character_libraries ---
  ensureColumns(database, 'character_libraries', [
    { name: 'drama_id',          type: 'INTEGER' },   // NULL = 全局素材库；有值 = 本剧专属
    { name: 'name',              type: 'TEXT NOT NULL DEFAULT \'\'' },
    { name: 'category',          type: 'TEXT' },
    { name: 'image_url',         type: 'TEXT' },
    { name: 'local_path',        type: 'TEXT' },
    { name: 'description',       type: 'TEXT' },
    { name: 'appearance',        type: 'TEXT' },
    { name: 'tags',              type: 'TEXT' },
    { name: 'source_type',       type: 'TEXT' },
    { name: 'source_id',         type: 'TEXT' },
    { name: 'identity_anchors',  type: 'TEXT' },   // JSON: 6层视觉锚点（骨相/五官/辨识标记/色值/皮肤/发型）
    { name: 'style_tokens',      type: 'TEXT' },   // 风格词 token 列表
    { name: 'color_palette',     type: 'TEXT' },   // JSON: Hex 色值数组
    { name: 'four_view_image_url', type: 'TEXT' }, // 四视图参考图 URL（分镜图生图参考用）
    { name: 'created_at',        type: 'TEXT' },
    { name: 'updated_at',        type: 'TEXT' },
    { name: 'deleted_at',        type: 'TEXT' },
  ]);

  // --- scene_libraries ---
  ensureColumns(database, 'scene_libraries', [
    { name: 'drama_id',    type: 'INTEGER' },   // NULL = 全局素材库
    { name: 'location',    type: 'TEXT NOT NULL DEFAULT \'\'' },
    { name: 'time',        type: 'TEXT' },
    { name: 'prompt',      type: 'TEXT' },
    { name: 'description', type: 'TEXT' },
    { name: 'image_url',   type: 'TEXT' },
    { name: 'local_path',  type: 'TEXT' },
    { name: 'category',    type: 'TEXT' },
    { name: 'tags',        type: 'TEXT' },
    { name: 'source_type', type: 'TEXT' },
    { name: 'source_id',   type: 'TEXT' },
    { name: 'created_at',  type: 'TEXT' },
    { name: 'updated_at',  type: 'TEXT' },
    { name: 'deleted_at',  type: 'TEXT' },
  ]);

  // --- prop_libraries ---
  ensureColumns(database, 'prop_libraries', [
    { name: 'drama_id',    type: 'INTEGER' },   // NULL = 全局素材库
    { name: 'name',        type: 'TEXT NOT NULL DEFAULT \'\'' },
    { name: 'description', type: 'TEXT' },
    { name: 'prompt',      type: 'TEXT' },
    { name: 'image_url',   type: 'TEXT' },
    { name: 'local_path',  type: 'TEXT' },
    { name: 'category',    type: 'TEXT' },
    { name: 'tags',        type: 'TEXT' },
    { name: 'source_type', type: 'TEXT' },
    { name: 'source_id',   type: 'TEXT' },
    { name: 'created_at',  type: 'TEXT' },
    { name: 'updated_at',  type: 'TEXT' },
    { name: 'deleted_at',  type: 'TEXT' },
  ]);

  // --- image_proxy_cache ---
  try {
    database.exec(`CREATE TABLE IF NOT EXISTS image_proxy_cache (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      cache_key  TEXT NOT NULL UNIQUE,
      proxy_url  TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`);
  } catch (_) {}
  ensureColumns(database, 'image_proxy_cache', [
    { name: 'cache_key',  type: 'TEXT NOT NULL DEFAULT \'\'' },
    { name: 'proxy_url',  type: 'TEXT NOT NULL DEFAULT \'\'' },
    { name: 'created_at', type: 'TEXT NOT NULL DEFAULT \'\'' },
  ]);

  // --- ai_model_map（业务场景→模型路由映射表） ---
  try {
    database.exec(`CREATE TABLE IF NOT EXISTS ai_model_map (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      key            TEXT NOT NULL UNIQUE,
      service_type   TEXT NOT NULL DEFAULT 'text',
      config_id      INTEGER,
      model_override TEXT,
      description    TEXT,
      created_at     TEXT NOT NULL DEFAULT '',
      updated_at     TEXT NOT NULL DEFAULT ''
    )`);
  } catch (_) {}
  ensureColumns(database, 'ai_model_map', [
    { name: 'key',            type: 'TEXT NOT NULL DEFAULT \'\'' },
    { name: 'service_type',   type: 'TEXT NOT NULL DEFAULT \'text\'' },
    { name: 'config_id',      type: 'INTEGER' },
    { name: 'model_override', type: 'TEXT' },
    { name: 'description',    type: 'TEXT' },
    { name: 'created_at',     type: 'TEXT NOT NULL DEFAULT \'\'' },
    { name: 'updated_at',     type: 'TEXT NOT NULL DEFAULT \'\'' },
  ]);

  // --- storyboard_characters（分镜与角色库的关联表） ---
  try {
    database.exec(`CREATE TABLE IF NOT EXISTS storyboard_characters (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      storyboard_id  INTEGER NOT NULL,
      character_id   INTEGER NOT NULL,
      created_at     TEXT NOT NULL DEFAULT ''
    )`);
  } catch (_) {}

  // --- global_settings（全局键值设置表） ---
  try {
    database.exec(`CREATE TABLE IF NOT EXISTS global_settings (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT ''
    )`);
  } catch (_) {}
}

/** 转绘工作流旧库兜底：只补列和事实层保护触发器，不改写既有数据。 */
function ensureRedrawCompatibility(database) {
  ensureColumns(database, 'redraw_projects', [
    { name: 'tenant_id', type: 'TEXT' },
    { name: 'user_id', type: 'TEXT' },
    { name: 'title', type: 'TEXT NOT NULL DEFAULT \'\'' },
    { name: 'default_locale', type: 'TEXT NOT NULL DEFAULT \'en-US\'' },
    { name: 'default_market', type: 'TEXT NOT NULL DEFAULT \'\'' },
    { name: 'localization_level', type: 'TEXT NOT NULL DEFAULT \'faithful\'' },
    { name: 'status', type: 'TEXT NOT NULL DEFAULT \'draft\'' },
    { name: 'created_at', type: 'TEXT' },
    { name: 'updated_at', type: 'TEXT' },
    { name: 'deleted_at', type: 'TEXT' },
    { name: 'execution_mode', type: 'TEXT NOT NULL DEFAULT \'safe\' CHECK (execution_mode IN (\'safe\', \'auto\'))' },
    { name: 'budget_limit_credits', type: 'INTEGER CHECK (budget_limit_credits IS NULL OR budget_limit_credits > 0)' },
    { name: 'max_auto_attempts_per_shot', type: 'INTEGER CHECK (max_auto_attempts_per_shot IS NULL OR max_auto_attempts_per_shot BETWEEN 1 AND 5)' },
    { name: 'policy_version', type: 'INTEGER NOT NULL DEFAULT 1 CHECK (policy_version > 0)' },
    { name: 'automation_policy_json', type: 'TEXT NOT NULL DEFAULT \'{}\'' },
  ]);

  database.exec(`
    CREATE TABLE IF NOT EXISTS redraw_workflow_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      project_id INTEGER NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      from_state TEXT,
      to_state TEXT NOT NULL,
      reason_code TEXT NOT NULL,
      evidence_hash TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      FOREIGN KEY(project_id) REFERENCES redraw_projects(id)
    );

    CREATE INDEX IF NOT EXISTS idx_redraw_workflow_events_project
      ON redraw_workflow_events(tenant_id, user_id, project_id, id DESC);

    CREATE TRIGGER IF NOT EXISTS redraw_workflow_events_immutable_update
    BEFORE UPDATE ON redraw_workflow_events
    BEGIN SELECT RAISE(ABORT, 'redraw workflow events are immutable'); END;

    CREATE TRIGGER IF NOT EXISTS redraw_workflow_events_immutable_delete
    BEFORE DELETE ON redraw_workflow_events
    BEGIN SELECT RAISE(ABORT, 'redraw workflow events are immutable'); END;
  `);

  ensureColumns(database, 'redraw_style_presets', [
    { name: 'tenant_id', type: 'TEXT' },
    { name: 'user_id', type: 'TEXT' },
    { name: 'stable_key', type: 'TEXT NOT NULL DEFAULT \'\'' },
    { name: 'name', type: 'TEXT NOT NULL DEFAULT \'\'' },
    { name: 'category', type: 'TEXT NOT NULL DEFAULT \'live_action\'' },
    { name: 'sort_order', type: 'INTEGER NOT NULL DEFAULT 0' },
    { name: 'version', type: 'INTEGER NOT NULL DEFAULT 1' },
    { name: 'prompt_template', type: 'TEXT NOT NULL DEFAULT \'\'' },
    { name: 'negative_prompt_template', type: 'TEXT NOT NULL DEFAULT \'\'' },
    { name: 'preview_asset_id', type: 'INTEGER' },
    { name: 'compatible_models_json', type: 'TEXT NOT NULL DEFAULT \'[]\'' },
    { name: 'supported_ratios_json', type: 'TEXT NOT NULL DEFAULT \'[]\'' },
    { name: 'verification_evidence_json', type: 'TEXT NOT NULL DEFAULT \'{}\'' },
    { name: 'status', type: 'TEXT NOT NULL DEFAULT \'draft\'' },
    { name: 'created_at', type: 'TEXT' },
    { name: 'updated_at', type: 'TEXT' },
    { name: 'deleted_at', type: 'TEXT' },
  ]);

  ensureColumns(database, 'redraw_works', [
    { name: 'project_id', type: 'INTEGER' },
    { name: 'tenant_id', type: 'TEXT' },
    { name: 'user_id', type: 'TEXT' },
    { name: 'title', type: 'TEXT NOT NULL DEFAULT \'\'' },
    { name: 'source_asset_id', type: 'INTEGER' },
    { name: 'source_fingerprint', type: 'TEXT NOT NULL DEFAULT \'\'' },
    { name: 'duration_ms', type: 'INTEGER NOT NULL DEFAULT 0' },
    { name: 'current_version', type: 'INTEGER NOT NULL DEFAULT 0' },
    { name: 'current_step', type: 'INTEGER NOT NULL DEFAULT 1' },
    { name: 'status', type: 'TEXT NOT NULL DEFAULT \'draft\'' },
    { name: 'created_at', type: 'TEXT' },
    { name: 'updated_at', type: 'TEXT' },
    { name: 'deleted_at', type: 'TEXT' },
  ]);

  ensureColumns(database, 'redraw_versions', [
    { name: 'work_id', type: 'INTEGER' },
    { name: 'tenant_id', type: 'TEXT' },
    { name: 'user_id', type: 'TEXT' },
    { name: 'version', type: 'INTEGER NOT NULL DEFAULT 1' },
    { name: 'locale', type: 'TEXT NOT NULL DEFAULT \'\'' },
    { name: 'market', type: 'TEXT NOT NULL DEFAULT \'\'' },
    { name: 'localization_level', type: 'TEXT NOT NULL DEFAULT \'faithful\'' },
    { name: 'source_facts_json', type: 'TEXT' },
    { name: 'glossary_json', type: 'TEXT NOT NULL DEFAULT \'{}\'' },
    { name: 'name_map_json', type: 'TEXT NOT NULL DEFAULT \'{}\'' },
    { name: 'culture_map_json', type: 'TEXT NOT NULL DEFAULT \'{}\'' },
    { name: 'style_snapshot_json', type: 'TEXT NOT NULL DEFAULT \'{}\'' },
    { name: 'capability_snapshot_json', type: 'TEXT NOT NULL DEFAULT \'{}\'' },
    { name: 'localization_task_id', type: 'TEXT' },
    { name: 'localization_credit_reservation_id', type: 'TEXT' },
    { name: 'localization_input_hash', type: 'TEXT' },
    { name: 'localization_idempotency_key', type: 'TEXT' },
    { name: 'localization_model_snapshot_json', type: 'TEXT NOT NULL DEFAULT \'{}\'' },
    { name: 'reference_bundle_required', type: 'INTEGER NOT NULL DEFAULT 0' },
    { name: 'facts_hash', type: 'TEXT' },
    { name: 'status', type: 'TEXT NOT NULL DEFAULT \'draft\'' },
    { name: 'created_at', type: 'TEXT' },
    { name: 'updated_at', type: 'TEXT' },
    { name: 'deleted_at', type: 'TEXT' },
  ]);

  database.exec(`
    CREATE TABLE IF NOT EXISTS redraw_asset_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      version_id INTEGER NOT NULL,
      tenant_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      quote_snapshot_json TEXT NOT NULL DEFAULT '{}',
      asset_ids_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'partial_failed', 'failed', 'needs_attention')),
      total_count INTEGER NOT NULL DEFAULT 0 CHECK (total_count >= 0),
      success_count INTEGER NOT NULL DEFAULT 0 CHECK (success_count >= 0),
      failed_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
      error_code TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      deleted_at TEXT,
      FOREIGN KEY(version_id) REFERENCES redraw_versions(id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_redraw_asset_batch_idempotency
      ON redraw_asset_batches(tenant_id, user_id, version_id, idempotency_key)
      WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_redraw_asset_batch_version
      ON redraw_asset_batches(version_id, status, updated_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_redraw_localization_idempotency
      ON redraw_versions(tenant_id, user_id, work_id, localization_idempotency_key)
      WHERE localization_idempotency_key IS NOT NULL
        AND trim(localization_idempotency_key) <> ''
        AND deleted_at IS NULL;
  `);

  ensureColumns(database, 'redraw_assets', [
    { name: 'version_id', type: 'INTEGER' },
    { name: 'tenant_id', type: 'TEXT' },
    { name: 'user_id', type: 'TEXT' },
    { name: 'kind', type: 'TEXT NOT NULL DEFAULT \'character\'' },
    { name: 'source_ref_json', type: 'TEXT NOT NULL DEFAULT \'{}\'' },
    { name: 'localized_name', type: 'TEXT NOT NULL DEFAULT \'\'' },
    { name: 'localized_description', type: 'TEXT NOT NULL DEFAULT \'\'' },
    { name: 'prompt', type: 'TEXT NOT NULL DEFAULT \'\'' },
    { name: 'asset_id', type: 'INTEGER' },
    { name: 'voice_asset_id', type: 'INTEGER' },
    { name: 'clean_plate_asset_id', type: 'INTEGER' },
    { name: 'mask_asset_id', type: 'INTEGER' },
    { name: 'generation_task_id', type: 'TEXT' },
    { name: 'credit_reservation_id', type: 'TEXT' },
    { name: 'version_number', type: 'INTEGER NOT NULL DEFAULT 1' },
    { name: 'approval_status', type: 'TEXT NOT NULL DEFAULT \'pending\'' },
    { name: 'approved_by', type: 'TEXT' },
    { name: 'approved_at', type: 'TEXT' },
    { name: 'status', type: 'TEXT NOT NULL DEFAULT \'draft\'' },
    { name: 'error_code', type: 'TEXT' },
    { name: 'error_message', type: 'TEXT' },
    { name: 'created_at', type: 'TEXT' },
    { name: 'updated_at', type: 'TEXT' },
    { name: 'deleted_at', type: 'TEXT' },
  ]);

  ensureColumns(database, 'redraw_shots', [
    { name: 'version_id', type: 'INTEGER' },
    { name: 'tenant_id', type: 'TEXT' },
    { name: 'user_id', type: 'TEXT' },
    { name: 'batch_index', type: 'INTEGER NOT NULL DEFAULT 1' },
    { name: 'shot_index', type: 'INTEGER NOT NULL DEFAULT 1' },
    { name: 'start_ms', type: 'INTEGER NOT NULL DEFAULT 0' },
    { name: 'end_ms', type: 'INTEGER NOT NULL DEFAULT 0' },
    { name: 'duration_ms', type: 'INTEGER NOT NULL DEFAULT 0' },
    { name: 'source_dialogue_json', type: 'TEXT NOT NULL DEFAULT \'[]\'' },
    { name: 'localized_dialogue_json', type: 'TEXT NOT NULL DEFAULT \'[]\'' },
    { name: 'references_json', type: 'TEXT NOT NULL DEFAULT \'[]\'' },
    { name: 'reference_bundle_json', type: 'TEXT NOT NULL DEFAULT \'{}\'' },
    { name: 'reference_bundle_hash', type: 'TEXT' },
    { name: 'reference_bundle_updated_at', type: 'TEXT' },
    { name: 'opening_state', type: 'TEXT NOT NULL DEFAULT \'\'' },
    { name: 'continuous_action', type: 'TEXT NOT NULL DEFAULT \'\'' },
    { name: 'ending_state', type: 'TEXT NOT NULL DEFAULT \'\'' },
    { name: 'prompt', type: 'TEXT NOT NULL DEFAULT \'\'' },
    { name: 'negative_prompt', type: 'TEXT NOT NULL DEFAULT \'\'' },
    { name: 'compiled_prompt_json', type: 'TEXT NOT NULL DEFAULT \'{}\'' },
    { name: 'video_generation_id', type: 'INTEGER' },
    { name: 'audio_asset_id', type: 'INTEGER' },
    { name: 'subtitle_asset_id', type: 'INTEGER' },
    { name: 'status', type: 'TEXT NOT NULL DEFAULT \'draft\'' },
    { name: 'error_code', type: 'TEXT' },
    { name: 'error_message', type: 'TEXT' },
    { name: 'created_at', type: 'TEXT' },
    { name: 'updated_at', type: 'TEXT' },
    { name: 'deleted_at', type: 'TEXT' },
  ]);

  ensureColumns(database, 'redraw_exports', [
    { name: 'version_id', type: 'INTEGER' },
    { name: 'tenant_id', type: 'TEXT' },
    { name: 'user_id', type: 'TEXT' },
    { name: 'export_type', type: 'TEXT NOT NULL DEFAULT \'video\'' },
    { name: 'video_merge_id', type: 'INTEGER' },
    { name: 'asset_id', type: 'INTEGER' },
    { name: 'subtitle_asset_id', type: 'INTEGER' },
    { name: 'project_asset_id', type: 'INTEGER' },
    { name: 'version_number', type: 'INTEGER NOT NULL DEFAULT 1' },
    { name: 'manifest_json', type: 'TEXT NOT NULL DEFAULT \'{}\'' },
    { name: 'status', type: 'TEXT NOT NULL DEFAULT \'pending\'' },
    { name: 'error_code', type: 'TEXT' },
    { name: 'error_message', type: 'TEXT' },
    { name: 'created_at', type: 'TEXT' },
    { name: 'updated_at', type: 'TEXT' },
    { name: 'deleted_at', type: 'TEXT' },
  ]);

  database.exec(`
    CREATE TRIGGER IF NOT EXISTS redraw_versions_facts_immutable_update
    BEFORE UPDATE OF source_facts_json, facts_hash ON redraw_versions
    WHEN (OLD.source_facts_json IS NOT NULL OR OLD.facts_hash IS NOT NULL)
       AND (NEW.source_facts_json IS NOT OLD.source_facts_json OR NEW.facts_hash IS NOT OLD.facts_hash)
    BEGIN
      SELECT RAISE(ABORT, 'redraw source facts immutable');
    END;
  `);
  database.exec(`
    CREATE TRIGGER IF NOT EXISTS redraw_versions_facts_immutable_delete
    BEFORE DELETE ON redraw_versions
    WHEN OLD.source_facts_json IS NOT NULL OR OLD.facts_hash IS NOT NULL
    BEGIN
      SELECT RAISE(ABORT, 'redraw source facts immutable');
    END;
  `);
}

/** 49 号迁移前的最小兜底，确保旧 redraw_* 表具备索引依赖列。 */
function ensureRedrawMigrationColumns(database) {
  const required = {
    redraw_projects: [
      { name: 'tenant_id', type: 'TEXT' },
      { name: 'user_id', type: 'TEXT' },
      { name: 'updated_at', type: 'TEXT' },
    ],
    redraw_style_presets: [
      { name: 'stable_key', type: 'TEXT NOT NULL DEFAULT \'\'' },
      { name: 'version', type: 'INTEGER NOT NULL DEFAULT 1' },
      { name: 'category', type: 'TEXT NOT NULL DEFAULT \'live_action\'' },
      { name: 'status', type: 'TEXT NOT NULL DEFAULT \'draft\'' },
      { name: 'sort_order', type: 'INTEGER NOT NULL DEFAULT 0' },
    ],
    redraw_works: [
      { name: 'tenant_id', type: 'TEXT' },
      { name: 'user_id', type: 'TEXT' },
      { name: 'source_fingerprint', type: 'TEXT NOT NULL DEFAULT \'\'' },
      { name: 'updated_at', type: 'TEXT' },
      { name: 'deleted_at', type: 'TEXT' },
    ],
    redraw_versions: [
      { name: 'work_id', type: 'INTEGER' },
      { name: 'tenant_id', type: 'TEXT' },
      { name: 'user_id', type: 'TEXT' },
      { name: 'version', type: 'INTEGER NOT NULL DEFAULT 1' },
      { name: 'status', type: 'TEXT NOT NULL DEFAULT \'draft\'' },
      { name: 'updated_at', type: 'TEXT' },
      { name: 'deleted_at', type: 'TEXT' },
      { name: 'localization_task_id', type: 'TEXT' },
      { name: 'localization_credit_reservation_id', type: 'TEXT' },
      { name: 'localization_input_hash', type: 'TEXT' },
      { name: 'localization_idempotency_key', type: 'TEXT' },
      { name: 'localization_model_snapshot_json', type: 'TEXT NOT NULL DEFAULT \'{}\'' },
    ],
    redraw_assets: [
      { name: 'version_id', type: 'INTEGER' },
      { name: 'kind', type: 'TEXT NOT NULL DEFAULT \'character\'' },
      { name: 'approval_status', type: 'TEXT NOT NULL DEFAULT \'pending\'' },
      { name: 'updated_at', type: 'TEXT' },
    ],
    redraw_shots: [
      { name: 'version_id', type: 'INTEGER' },
      { name: 'batch_index', type: 'INTEGER NOT NULL DEFAULT 1' },
      { name: 'shot_index', type: 'INTEGER NOT NULL DEFAULT 1' },
      { name: 'status', type: 'TEXT NOT NULL DEFAULT \'draft\'' },
      { name: 'updated_at', type: 'TEXT' },
    ],
    redraw_exports: [
      { name: 'version_id', type: 'INTEGER' },
      { name: 'export_type', type: 'TEXT NOT NULL DEFAULT \'video\'' },
      { name: 'version_number', type: 'INTEGER NOT NULL DEFAULT 1' },
    ],
  };

  for (const [table, columns] of Object.entries(required)) {
    if (tableExists(database, table)) ensureColumns(database, table, columns);
  }
  ensureRedrawWorkSourceIndex(database);
}
/** 对已打开的 database 执行迁移与兜底补列（供 app 启动时调用） */
function runMigrationsAndEnsure(database) {
  if (database.inTransaction) {
    throw new Error('runMigrationsAndEnsure requires no active transaction');
  }
  ensureRedrawMigrationColumns(database);
  runMigrations(database);
  ensureAllColumns(database);
  ensureRedrawCompatibility(database);
  ensureRedrawWorkDurationConstraint(database);
  ensureRedrawWorkflowStatusConstraints(database);
  ensureRedrawWorkSourceIndex(database);
}

function main() {
  const config = loadConfig();
  const database = getDb(config.database);
  runMigrationsAndEnsure(database);
  console.log('Migrations complete.');
}

if (require.main === module) {
  main();
}

module.exports = { runMigrationsAndEnsure, ensureColumns };
