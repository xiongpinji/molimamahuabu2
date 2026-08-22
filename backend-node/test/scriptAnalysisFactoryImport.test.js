'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');

function productionPackage(overrides = {}) {
  return {
    schema_version: '1.0',
    source: {
      title: '灯塔之夜',
      source_script: '停电夜，母亲点亮煤油灯，与女儿在旧客厅和解。',
      locked_facts: ['母女关系不能改', '结局是母女和解'],
    },
    normalized_script: {
      logline: '母女在停电之夜重新理解彼此。',
      genre: '家庭剧情',
      tone: '克制温暖',
      target_duration_seconds: 12,
      story_structure: [],
    },
    character_bible: [{
      character_id: 'character-1',
      name: '林夏',
      role: '女儿',
      description: '刚回家的年轻女性',
      personality: '倔强但柔软',
      appearance: '白色衬衫，短发',
    }],
    scene_bible: [{
      scene_number: 1,
      title: '旧客厅停电',
      location: '旧客厅',
      time: '夜',
      description: '停电后的旧客厅，煤油灯提供暖光。',
    }],
    prop_bible: [{
      prop_id: 'prop-1',
      name: '煤油灯',
      type: '陈设',
      description: '母亲保留多年的旧煤油灯',
      prompt: '一盏有使用痕迹的黄铜煤油灯',
    }],
    episodes: [{
      episode_number: 1,
      title: '第一集',
      scenes: [{
        scene_number: 1,
        shots: [{
          shot_number: 1,
          title: '灯亮',
          duration: 6,
          action: '母亲划燃火柴，女儿抬起头。',
          dialogue: [{ speaker: '母亲', text: '先坐下吧。' }],
          source_basis: ['母亲点亮煤油灯'],
          image_prompt: '暖色煤油灯照亮母女的脸',
          video_prompt: '摄影机缓慢推进，母亲点灯，女儿抬头',
          shot_type: '中景',
          angle: '平视',
          movement: '缓慢推进',
          continuity: {
            lighting: '煤油灯暖光持续',
            characters: ['character-1'],
            props: ['prop-1'],
          },
        }],
      }],
    }],
    continuity_rules: ['煤油灯始终位于桌面中央'],
    visual_direction: {
      emotional_tone: { primary: '克制温暖', evidence: ['母亲点亮煤油灯'] },
      recommendations: [{ rank: 1, name: '低照度家庭戏' }],
    },
    skill_snapshot: {
      id: 'cinematic-visual-director',
      name: '电影化视觉导演',
      version: '1.0.0',
      module: 'script_analysis',
      output_schema_version: '1.0',
    },
    review: { status: 'approved', issues: [] },
    ai_changes: [],
    approval_status: 'approved',
    ...overrides,
  };
}

function seedProject(db, {
  userId = 'user-a',
  version = 3,
  status = 'approved',
  packageValue = productionPackage(),
} = {}) {
  const now = new Date().toISOString();
  const projectId = db.prepare(`
    INSERT INTO script_analysis_projects (
      user_id, title, source_script, locked_facts_json,
      analysis_json, review_json, status, current_version,
      created_at, updated_at
    ) VALUES (?, '灯塔之夜项目', ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    userId,
    packageValue.source.source_script,
    JSON.stringify(packageValue.source.locked_facts),
    JSON.stringify(packageValue),
    JSON.stringify(packageValue.review),
    status,
    version,
    now,
    now,
  ).lastInsertRowid;
  db.prepare(`
    INSERT INTO script_analysis_versions (
      project_id, version, source_script, package_json,
      ai_changes_json, approval_status, created_at
    ) VALUES (?, ?, ?, ?, '[]', ?, ?)
  `).run(
    projectId,
    version,
    packageValue.source.source_script,
    JSON.stringify(packageValue),
    status,
    now,
  );
  return projectId;
}

function createDb() {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  return db;
}

function loadService() {
  return require('../src/services/scriptAnalysisFactoryImportService');
}

test('总路由暴露受控的短剧工厂导入端点', () => {
  const indexSource = fs.readFileSync(path.join(__dirname, '../src/routes/index.js'), 'utf8');
  const routeSource = fs.readFileSync(path.join(__dirname, '../src/routes/scriptAnalysis.js'), 'utf8');

  assert.match(indexSource, /projects\/:id\/import-to-factory/);
  assert.match(routeSource, /importToFactory/);
});

test('审核通过的当前版本一次性导入完整短剧项目且重复确认幂等', () => {
  const db = createDb();
  try {
    const packageValue = productionPackage();
    const originalPackageJson = JSON.stringify(packageValue);
    const projectId = seedProject(db, { packageValue });
    const { importApprovedPackageToFactory } = loadService();
    const args = {
      projectId,
      version: 3,
      userId: 'user-a',
      tenantId: 'tenant-a',
    };

    const first = importApprovedPackageToFactory(db, { info() {} }, args);
    assert.equal(first.created, true);
    assert.equal(first.source_project_id, projectId);
    assert.equal(first.source_version, 3);

    const drama = db.prepare('SELECT * FROM dramas WHERE id = ?').get(first.drama_id);
    const metadata = JSON.parse(drama.metadata);
    assert.equal(drama.title, '灯塔之夜项目');
    assert.equal(drama.description, '母女在停电之夜重新理解彼此。');
    assert.equal(drama.genre, '家庭剧情');
    assert.equal(drama.user_id, 'user-a');
    assert.equal(drama.tenant_id, 'tenant-a');
    assert.equal(metadata.project_type, 'factory');
    assert.equal(metadata.script_analysis_import.source_project_id, projectId);
    assert.equal(metadata.script_analysis_import.source_version, 3);
    assert.equal(metadata.script_analysis_import.schema_version, 'script-analysis-factory-import@1.1');
    assert.deepEqual(metadata.script_analysis_import.locked_facts, packageValue.source.locked_facts);
    assert.deepEqual(metadata.script_analysis_import.skill_snapshot, packageValue.skill_snapshot);
    assert.deepEqual(metadata.script_analysis_import.package_snapshot, packageValue);

    assert.equal(db.prepare('SELECT COUNT(*) count FROM characters WHERE drama_id = ?').get(first.drama_id).count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) count FROM scenes WHERE drama_id = ?').get(first.drama_id).count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) count FROM props WHERE drama_id = ?').get(first.drama_id).count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) count FROM episodes WHERE drama_id = ?').get(first.drama_id).count, 1);
    const storyboard = db.prepare(`
      SELECT s.* FROM storyboards s
      JOIN episodes e ON e.id = s.episode_id
      WHERE e.drama_id = ?
    `).get(first.drama_id);
    assert.equal(storyboard.image_prompt, '暖色煤油灯照亮母女的脸');
    assert.equal(storyboard.video_prompt, '摄影机缓慢推进，母亲点灯，女儿抬头');
    assert.deepEqual(JSON.parse(storyboard.continuity_snapshot), {
      lighting: '煤油灯暖光持续',
      characters: ['character-1'],
      props: ['prop-1'],
    });
    const character = db.prepare('SELECT id FROM characters WHERE drama_id = ?').get(first.drama_id);
    assert.deepEqual(JSON.parse(storyboard.characters), [character.id]);
    assert.equal(db.prepare('SELECT COUNT(*) count FROM storyboard_props WHERE storyboard_id = ?').get(storyboard.id).count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) count FROM async_tasks').get().count, 0);
    assert.equal(db.prepare('SELECT package_json FROM script_analysis_versions WHERE project_id = ?').get(projectId).package_json, originalPackageJson);

    const now = new Date().toISOString();
    const legacySceneId = db.prepare(`
      INSERT INTO scenes (
        drama_id, episode_id, location, time, prompt,
        storyboard_count, status, created_at, updated_at
      ) VALUES (?, ?, '第1场', NULL, NULL, 1, 'draft', ?, ?)
    `).run(first.drama_id, storyboard.episode_id, now, now).lastInsertRowid;
    db.prepare('UPDATE storyboards SET scene_id = ?, characters = ? WHERE id = ?')
      .run(legacySceneId, '[]', storyboard.id);
    db.prepare('DELETE FROM storyboard_props WHERE storyboard_id = ?').run(storyboard.id);
    metadata.script_analysis_import.schema_version = 'script-analysis-factory-import@1.0';
    db.prepare('UPDATE dramas SET metadata = ? WHERE id = ?').run(JSON.stringify(metadata), first.drama_id);

    const second = importApprovedPackageToFactory(db, { info() {} }, args);
    assert.equal(second.created, false);
    assert.equal(second.repaired, true);
    assert.equal(second.drama_id, first.drama_id);
    assert.equal(db.prepare('SELECT COUNT(*) count FROM dramas').get().count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) count FROM storyboards').get().count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) count FROM scenes WHERE drama_id = ? AND deleted_at IS NULL').get(first.drama_id).count, 1);
    const repairedStoryboard = db.prepare('SELECT * FROM storyboards WHERE id = ?').get(storyboard.id);
    assert.equal(repairedStoryboard.scene_id, storyboard.scene_id);
    assert.deepEqual(JSON.parse(repairedStoryboard.characters), [character.id]);
    assert.equal(db.prepare('SELECT COUNT(*) count FROM storyboard_props WHERE storyboard_id = ?').get(storyboard.id).count, 1);
    const repairedMetadata = JSON.parse(db.prepare('SELECT metadata FROM dramas WHERE id = ?').get(first.drama_id).metadata);
    assert.equal(repairedMetadata.script_analysis_import.schema_version, 'script-analysis-factory-import@1.1');
  } finally {
    db.close();
  }
});

test('导入拒绝未审核、过期版本和其他用户访问', () => {
  const db = createDb();
  try {
    const projectId = seedProject(db, {
      status: 'needs_review',
      packageValue: productionPackage({
        approval_status: 'needs_review',
        review: { status: 'needs_review', issues: [] },
      }),
    });
    const { importApprovedPackageToFactory } = loadService();
    const base = { projectId, version: 3, userId: 'user-a', tenantId: null };

    assert.throws(
      () => importApprovedPackageToFactory(db, { info() {} }, base),
      (error) => error.code === 'FACTORY_IMPORT_NOT_APPROVED',
    );
    assert.throws(
      () => importApprovedPackageToFactory(db, { info() {} }, { ...base, version: 2 }),
      (error) => error.code === 'FACTORY_IMPORT_STALE_VERSION',
    );
    assert.throws(
      () => importApprovedPackageToFactory(db, { info() {} }, { ...base, userId: 'user-b' }),
      (error) => error.code === 'SCRIPT_ANALYSIS_PROJECT_NOT_FOUND',
    );
    assert.equal(db.prepare('SELECT COUNT(*) count FROM dramas').get().count, 0);
  } finally {
    db.close();
  }
});

test('任一生产数据写入失败时整个导入事务回滚', () => {
  const db = createDb();
  try {
    const projectId = seedProject(db);
    db.exec(`
      CREATE TRIGGER fail_factory_storyboard
      BEFORE INSERT ON storyboards
      BEGIN
        SELECT RAISE(ABORT, 'storyboard write failed');
      END;
    `);
    const { importApprovedPackageToFactory } = loadService();

    assert.throws(() => importApprovedPackageToFactory(db, { info() {} }, {
      projectId,
      version: 3,
      userId: 'user-a',
      tenantId: null,
    }), /storyboard write failed/);
    assert.equal(db.prepare('SELECT COUNT(*) count FROM dramas').get().count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) count FROM episodes').get().count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) count FROM characters').get().count, 0);
  } finally {
    db.close();
  }
});
