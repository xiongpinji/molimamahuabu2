'use strict';

const {
  assertBlueprintLockable,
  normalizeEpisodeBlueprint,
  projectSourceFactsV2,
} = require('./redrawEpisodeBlueprintService');

const FORBIDDEN_KEY_PARTS = [
  'apikey', 'authorization', 'credential', 'generation', 'model', 'provider',
  'secret', 'token', 'url', 'uri', 'path', 'endpoint', 'request',
];
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function codedError(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  return error;
}

function requireContext(ctx) {
  if (!ctx?.db || typeof ctx.db.prepare !== 'function') {
    throw codedError('REDRAW_BLUEPRINT_CONTEXT_INVALID', '缺少数据库上下文');
  }
  const tenantId = String(ctx.tenantId ?? ctx.tenant_id ?? '').trim();
  const userId = String(ctx.userId ?? ctx.user_id ?? '').trim();
  if (!tenantId || !userId) {
    throw codedError('REDRAW_BLUEPRINT_CONTEXT_INVALID', '缺少所有者上下文');
  }
  return { db: ctx.db, tenantId, userId };
}

function workIdFrom(input) {
  const value = input && typeof input === 'object' ? input.workId ?? input.work_id : input;
  const workId = Number(value);
  if (!Number.isSafeInteger(workId) || workId <= 0) {
    throw codedError('REDRAW_BLUEPRINT_INPUT_INVALID', 'work_id 无效');
  }
  return workId;
}

function expectedUpdatedAt(input) {
  const value = String(input?.expectedUpdatedAt ?? input?.expected_updated_at ?? '').trim();
  if (!value) throw codedError('REDRAW_BLUEPRINT_INPUT_INVALID', 'expected_updated_at 必填');
  return value;
}

function expectedBlueprintHash(input) {
  const value = String(input?.expectedBlueprintHash ?? input?.expected_blueprint_hash ?? '').trim();
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw codedError('REDRAW_BLUEPRINT_INPUT_INVALID', 'expected_blueprint_hash 无效');
  }
  return value;
}

function assertOwnedWork(ctx, workId) {
  const row = ctx.db.prepare(`
    SELECT id, current_version
    FROM redraw_works
    WHERE tenant_id = ? AND user_id = ? AND id = ? AND deleted_at IS NULL
  `).get(ctx.tenantId, ctx.userId, workId);
  if (!row) throw codedError('REDRAW_BLUEPRINT_NOT_FOUND', '母本蓝图不存在');
  return row;
}

function currentRow(ctx, workId) {
  return ctx.db.prepare(`
    SELECT id, work_id, tenant_id, user_id, revision, status, blueprint_json,
           blueprint_hash, evidence_manifest_json, reviewed_by, reviewed_at,
           created_at, updated_at
    FROM redraw_episode_blueprints
    WHERE tenant_id = ? AND user_id = ? AND work_id = ?
    ORDER BY revision DESC, id DESC
    LIMIT 1
  `).get(ctx.tenantId, ctx.userId, workId);
}

function rowById(ctx, workId, id) {
  return ctx.db.prepare(`
    SELECT id, work_id, tenant_id, user_id, revision, status, blueprint_json,
           blueprint_hash, evidence_manifest_json, reviewed_by, reviewed_at,
           created_at, updated_at
    FROM redraw_episode_blueprints
    WHERE tenant_id = ? AND user_id = ? AND work_id = ? AND id = ?
  `).get(ctx.tenantId, ctx.userId, workId, id);
}

function mapRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    work_id: Number(row.work_id),
    tenant_id: row.tenant_id,
    user_id: row.user_id,
    revision: Number(row.revision),
    status: row.status,
    blueprint_hash: row.blueprint_hash,
    blueprint: JSON.parse(row.blueprint_json),
    evidence_manifest: JSON.parse(row.evidence_manifest_json),
    reviewed_by: row.reviewed_by || null,
    reviewed_at: row.reviewed_at || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function normalizedKey(key) {
  return String(key).replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function assertSafeString(value, name) {
  const text = String(value).trim();
  if (/^(?:[a-z]:[\\/]|\\\\|\/|file:\/\/)/i.test(text)
    || /https?:\/\//i.test(text)
    || /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(text)) {
    throw codedError('REDRAW_BLUEPRINT_FORBIDDEN_FIELD', `${name} 不允许 URL 或本地路径`);
  }
}

function assertSafeBlueprintValue(value, name = 'blueprint') {
  if (typeof value === 'string') {
    assertSafeString(value, name);
    return;
  }
  if (value == null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafeBlueprintValue(item, `${name}[${index}]`));
    return;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw codedError('REDRAW_BLUEPRINT_FORBIDDEN_FIELD', `${name} 不允许继承字段`);
  }
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw codedError('REDRAW_BLUEPRINT_FORBIDDEN_FIELD', `${name}.${key} 不允许继承字段`);
    }
  }
  for (const [key, item] of Object.entries(value)) {
    const normalized = normalizedKey(key);
    if (DANGEROUS_KEYS.has(key)
      || FORBIDDEN_KEY_PARTS.some((part) => normalized.includes(part))) {
      throw codedError('REDRAW_BLUEPRINT_FORBIDDEN_FIELD', `${name}.${key} 为禁止字段`);
    }
    assertSafeBlueprintValue(item, `${name}.${key}`);
  }
}

function normalizeDraft(blueprint) {
  assertSafeBlueprintValue(blueprint);
  try {
    return normalizeEpisodeBlueprint(blueprint);
  } catch (error) {
    if (error?.code) throw error;
    throw codedError('REDRAW_BLUEPRINT_INPUT_INVALID', '母本蓝图合同无效');
  }
}

function nextTimestamp(ctx, previous) {
  const raw = typeof ctx.now === 'function' ? ctx.now() : ctx.now;
  let millis = raw == null ? Date.now() : new Date(raw).getTime();
  if (!Number.isFinite(millis)) millis = Date.now();
  const previousMillis = Date.parse(String(previous || ''));
  if (Number.isFinite(previousMillis) && millis <= previousMillis) millis = previousMillis + 1;
  return new Date(millis).toISOString();
}

function getCurrentBlueprint(rawCtx, input) {
  const ctx = requireContext(rawCtx);
  const workId = workIdFrom(input);
  assertOwnedWork(ctx, workId);
  const row = currentRow(ctx, workId);
  if (!row) throw codedError('REDRAW_BLUEPRINT_NOT_FOUND', '母本蓝图不存在');
  return mapRow(row);
}

function createOrSaveDraft(rawCtx, input) {
  const ctx = requireContext(rawCtx);
  const workId = workIdFrom(input);
  const blueprint = normalizeDraft(input?.blueprint);
  const transaction = ctx.db.transaction(() => {
    assertOwnedWork(ctx, workId);
    const duplicate = ctx.db.prepare(`
      SELECT id, work_id, tenant_id, user_id, revision, status, blueprint_json,
             blueprint_hash, evidence_manifest_json, reviewed_by, reviewed_at,
             created_at, updated_at
      FROM redraw_episode_blueprints
      WHERE tenant_id = ? AND user_id = ? AND work_id = ? AND blueprint_hash = ?
      LIMIT 1
    `).get(ctx.tenantId, ctx.userId, workId, blueprint.blueprint_hash);
    if (duplicate) return mapRow(duplicate);

    const current = currentRow(ctx, workId);
    const now = nextTimestamp(rawCtx, current?.updated_at);
    const revision = Number(current?.revision || 0) + 1;
    const result = ctx.db.prepare(`
      INSERT INTO redraw_episode_blueprints
        (work_id, tenant_id, user_id, revision, status, blueprint_json, blueprint_hash,
         evidence_manifest_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)
    `).run(
      workId,
      ctx.tenantId,
      ctx.userId,
      revision,
      JSON.stringify(blueprint),
      blueprint.blueprint_hash,
      JSON.stringify(blueprint.evidence_manifest),
      now,
      now,
    );
    return mapRow(rowById(ctx, workId, result.lastInsertRowid));
  });
  return transaction();
}

function saveDraft(rawCtx, input) {
  const ctx = requireContext(rawCtx);
  const workId = workIdFrom(input);
  const expected = expectedUpdatedAt(input);
  const blueprint = normalizeDraft(input?.blueprint);
  const transaction = ctx.db.transaction(() => {
    assertOwnedWork(ctx, workId);
    const current = currentRow(ctx, workId);
    if (!current) throw codedError('REDRAW_BLUEPRINT_NOT_FOUND', '母本蓝图不存在');
    if (current.status !== 'draft') {
      throw codedError('REDRAW_BLUEPRINT_LOCKED', '已锁定蓝图修订不可修改');
    }
    if (String(current.updated_at) !== expected) {
      throw codedError('REDRAW_BLUEPRINT_CAS_CONFLICT', '母本蓝图已变化，请刷新后重试');
    }
    if (current.blueprint_hash === blueprint.blueprint_hash) return mapRow(current);
    const duplicate = ctx.db.prepare(`
      SELECT id
      FROM redraw_episode_blueprints
      WHERE tenant_id = ? AND user_id = ? AND work_id = ? AND blueprint_hash = ? AND id <> ?
      LIMIT 1
    `).get(ctx.tenantId, ctx.userId, workId, blueprint.blueprint_hash, current.id);
    if (duplicate) {
      throw codedError('REDRAW_BLUEPRINT_HASH_CONFLICT', '该母本蓝图内容已存在于其他修订');
    }
    const now = nextTimestamp(rawCtx, current.updated_at);
    const result = ctx.db.prepare(`
      UPDATE redraw_episode_blueprints
      SET blueprint_json = ?, blueprint_hash = ?, evidence_manifest_json = ?, updated_at = ?
      WHERE tenant_id = ? AND user_id = ? AND work_id = ?
        AND id = ? AND status = 'draft' AND updated_at = ?
    `).run(
      JSON.stringify(blueprint),
      blueprint.blueprint_hash,
      JSON.stringify(blueprint.evidence_manifest),
      now,
      ctx.tenantId,
      ctx.userId,
      workId,
      current.id,
      expected,
    );
    if (result.changes !== 1) {
      throw codedError('REDRAW_BLUEPRINT_CAS_CONFLICT', '母本蓝图已变化，请刷新后重试');
    }
    return mapRow(rowById(ctx, workId, current.id));
  });
  return transaction();
}

function ownedVersion(ctx, workId, currentVersion) {
  return ctx.db.prepare(`
    SELECT id, work_id, tenant_id, user_id, version, source_facts_json, facts_hash,
           blueprint_hash, updated_at
    FROM redraw_versions
    WHERE tenant_id = ? AND user_id = ? AND work_id = ? AND deleted_at IS NULL
    ORDER BY CASE WHEN version = ? THEN 0 ELSE 1 END, version DESC, id DESC
    LIMIT 1
  `).get(ctx.tenantId, ctx.userId, workId, Number(currentVersion || 0));
}

function lockBlueprint(rawCtx, input) {
  const ctx = requireContext(rawCtx);
  const workId = workIdFrom(input);
  const expected = expectedUpdatedAt(input);
  const expectedHash = expectedBlueprintHash(input);
  const transaction = ctx.db.transaction(() => {
    const work = assertOwnedWork(ctx, workId);
    const current = currentRow(ctx, workId);
    if (!current) throw codedError('REDRAW_BLUEPRINT_NOT_FOUND', '母本蓝图不存在');
    if (current.status !== 'draft') {
      throw codedError('REDRAW_BLUEPRINT_LOCKED', '母本蓝图修订已经锁定');
    }
    if (String(current.updated_at) !== expected) {
      throw codedError('REDRAW_BLUEPRINT_CAS_CONFLICT', '母本蓝图已变化，请刷新后重试');
    }
    const blueprint = normalizeDraft(JSON.parse(current.blueprint_json));
    assertBlueprintLockable(blueprint);
    if (blueprint.blueprint_hash !== current.blueprint_hash
      || expectedHash !== current.blueprint_hash) {
      throw codedError('REDRAW_BLUEPRINT_HASH_MISMATCH', '母本蓝图哈希已变化，请刷新后重试');
    }
    const version = ownedVersion(ctx, workId, work.current_version);
    if (!version) throw codedError('REDRAW_BLUEPRINT_NOT_FOUND', '母本蓝图不存在');
    if (version.source_facts_json != null || version.facts_hash != null || version.blueprint_hash != null) {
      throw codedError('REDRAW_BLUEPRINT_VERSION_ALREADY_BOUND', '当前版本已有不可变母本事实');
    }
    const projected = projectSourceFactsV2(blueprint);
    const now = nextTimestamp(rawCtx, current.updated_at);
    const versionUpdate = ctx.db.prepare(`
      UPDATE redraw_versions
      SET source_facts_json = ?, facts_hash = ?, blueprint_hash = ?, updated_at = ?
      WHERE tenant_id = ? AND user_id = ? AND work_id = ? AND id = ?
        AND source_facts_json IS NULL AND facts_hash IS NULL AND blueprint_hash IS NULL
    `).run(
      JSON.stringify(projected),
      projected.facts_hash,
      blueprint.blueprint_hash,
      now,
      ctx.tenantId,
      ctx.userId,
      workId,
      version.id,
    );
    if (versionUpdate.changes !== 1) {
      throw codedError('REDRAW_BLUEPRINT_VERSION_ALREADY_BOUND', '当前版本已有不可变母本事实');
    }
    const locked = ctx.db.prepare(`
      UPDATE redraw_episode_blueprints
      SET status = 'locked', reviewed_by = ?, reviewed_at = ?, updated_at = ?
      WHERE tenant_id = ? AND user_id = ? AND work_id = ?
        AND id = ? AND status = 'draft' AND updated_at = ? AND blueprint_hash = ?
    `).run(
      ctx.userId,
      now,
      now,
      ctx.tenantId,
      ctx.userId,
      workId,
      current.id,
      expected,
      expectedHash,
    );
    if (locked.changes !== 1) {
      throw codedError('REDRAW_BLUEPRINT_CAS_CONFLICT', '母本蓝图已变化，请刷新后重试');
    }
    return mapRow(rowById(ctx, workId, current.id));
  });
  return transaction();
}

module.exports = {
  assertSafeBlueprintValue,
  createOrSaveDraft,
  getCurrentBlueprint,
  lockBlueprint,
  saveDraft,
};
