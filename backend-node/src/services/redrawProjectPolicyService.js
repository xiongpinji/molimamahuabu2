'use strict';

const crypto = require('node:crypto');
const { appendWorkflowEvent } = require('./redrawWorkflowEventService');

const ALLOWED_FIELDS = new Set([
  'execution_mode',
  'budget_limit_credits',
  'max_auto_attempts_per_shot',
]);
const DANGEROUS_FIELDS = new Set(['__proto__', 'constructor', 'prototype']);
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function coded(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function assertAllowedFields(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw coded('REDRAW_PROJECT_POLICY_INVALID', '项目策略必须是对象');
  }
  for (const key of Object.keys(input)) {
    if (DANGEROUS_FIELDS.has(key)) {
      throw coded('REDRAW_PROJECT_POLICY_INVALID', `项目策略不接受字段 ${key}`);
    }
    if (!ALLOWED_FIELDS.has(key)) {
      throw coded('REDRAW_PROJECT_POLICY_UNKNOWN_FIELD', `项目策略不接受字段 ${key}`);
    }
  }
}

function optionalPositiveInteger(value, field, max = null) {
  if (value == null || value === '') return null;
  if (!Number.isInteger(value) || value <= 0 || (max != null && value > max)) {
    throw coded('REDRAW_PROJECT_POLICY_INVALID', `${field} 必须是有效正整数`);
  }
  return value;
}

function normalizeProjectPolicy(input = {}) {
  assertAllowedFields(input);
  if (!hasOwn(input, 'execution_mode')) {
    throw coded('REDRAW_PROJECT_POLICY_INVALID', 'execution_mode 必须是 safe 或 auto');
  }
  const executionMode = String(input.execution_mode || '').trim();
  if (!['safe', 'auto'].includes(executionMode)) {
    throw coded('REDRAW_PROJECT_POLICY_INVALID', 'execution_mode 必须是 safe 或 auto');
  }
  const budget = optionalPositiveInteger(
    hasOwn(input, 'budget_limit_credits') ? input.budget_limit_credits : null,
    'budget_limit_credits',
  );
  const attempts = optionalPositiveInteger(
    hasOwn(input, 'max_auto_attempts_per_shot') ? input.max_auto_attempts_per_shot : null,
    'max_auto_attempts_per_shot',
    5,
  );
  if (executionMode === 'auto' && (budget == null || attempts == null)) {
    throw coded('REDRAW_PROJECT_POLICY_INCOMPLETE', 'auto 模式必须同时提供预算和自动尝试上限');
  }
  return {
    execution_mode: executionMode,
    budget_limit_credits: budget,
    max_auto_attempts_per_shot: attempts,
  };
}

function projectPolicySnapshot(row) {
  return {
    execution_mode: row.execution_mode,
    budget_limit_credits: row.budget_limit_credits == null ? null : Number(row.budget_limit_credits),
    max_auto_attempts_per_shot: row.max_auto_attempts_per_shot == null
      ? null
      : Number(row.max_auto_attempts_per_shot),
    policy_version: Number(row.policy_version),
    updated_at: row.updated_at,
  };
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function evidenceHash(snapshot) {
  return crypto.createHash('sha256').update(stableJson(snapshot)).digest('hex');
}

function nextUpdatedAt(candidate, previous) {
  const previousMs = Date.parse(String(previous || ''));
  const candidateMs = Date.parse(String(candidate || ''));
  if (Number.isFinite(candidateMs) && (!Number.isFinite(previousMs) || candidateMs > previousMs)) {
    return new Date(candidateMs).toISOString();
  }
  const baseMs = Number.isFinite(previousMs) ? previousMs : Date.now();
  return new Date(baseMs + 1).toISOString();
}

function updateProjectPolicy(db, options = {}) {
  const tenantId = String(options.tenantId || '');
  const userId = String(options.userId || '');
  const projectId = Number(options.projectId);
  const expectedUpdatedAt = String(options.expectedUpdatedAt || '').trim();
  if (!expectedUpdatedAt) {
    throw coded('REDRAW_PROJECT_POLICY_EXPECTED_UPDATED_AT_REQUIRED', 'expected_updated_at 必填');
  }
  const normalized = normalizeProjectPolicy(options.input || {});
  const now = typeof options.now === 'function' ? options.now : () => new Date().toISOString();

  return db.transaction(() => {
    const existing = db.prepare(`
      SELECT *
      FROM redraw_projects
      WHERE id = ?
        AND tenant_id = ?
        AND user_id = ?
        AND deleted_at IS NULL
    `).get(projectId, tenantId, userId);
    if (!existing) throw coded('REDRAW_PROJECT_NOT_FOUND', '转绘项目不存在');
    if (String(existing.updated_at || '') !== expectedUpdatedAt) {
      throw coded('REDRAW_PROJECT_POLICY_CONFLICT', '项目策略已被其他操作更新');
    }

    const updatedAt = nextUpdatedAt(now(), existing.updated_at);
    const result = db.prepare(`
      UPDATE redraw_projects
      SET execution_mode = ?,
          budget_limit_credits = ?,
          max_auto_attempts_per_shot = ?,
          policy_version = policy_version + 1,
          updated_at = ?
      WHERE id = ?
        AND tenant_id = ?
        AND user_id = ?
        AND updated_at = ?
        AND deleted_at IS NULL
    `).run(
      normalized.execution_mode,
      normalized.budget_limit_credits,
      normalized.max_auto_attempts_per_shot,
      updatedAt,
      projectId,
      tenantId,
      userId,
      expectedUpdatedAt,
    );
    if (result.changes !== 1) {
      throw coded('REDRAW_PROJECT_POLICY_CONFLICT', '项目策略已被其他操作更新');
    }
    const updated = db.prepare('SELECT * FROM redraw_projects WHERE id = ?').get(projectId);
    const snapshot = projectPolicySnapshot(updated);
    appendWorkflowEvent(db, {
      tenantId,
      userId,
      projectId,
      resourceType: 'project',
      resourceId: String(projectId),
      fromState: String(existing.execution_mode || ''),
      toState: snapshot.execution_mode,
      reasonCode: 'project_policy_updated',
      evidenceHash: evidenceHash(snapshot),
      metadata: {
        from_policy: projectPolicySnapshot(existing),
        to_policy: snapshot,
      },
      createdAt: updatedAt,
    });
    return snapshot;
  })();
}

module.exports = {
  normalizeProjectPolicy,
  projectPolicySnapshot,
  updateProjectPolicy,
};
