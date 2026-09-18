'use strict';

/**
 * 用户视角：画布多端 revision 对齐 + 生成并发上限冒烟（内存库，不碰生产）。
 * 合同：同一用户多端可读 revision；跨用户不可读；保存推进 revision；并发上限放开到 300。
 */
const express = require('express');
const Database = require('better-sqlite3');
const { setupRouter } = require('../src/routes');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const {
  resolveGenerationSubmitLimitPerMinute,
  resolvePipelineConcurrencyMax,
} = require('../src/services/generationLimits');

const JWT_SECRET = 'predeploy-canvas-sync-limits-jwt-secret32';
const ADMIN_TOKEN = 'predeploy-canvas-sync-limits-admin-tok32';
const PASSWORD = 'correct horse battery staple';

async function main() {
  const saved = {
    PUBLIC_PLATFORM_MODE: process.env.PUBLIC_PLATFORM_MODE,
    PLATFORM_REGISTRATION_ENABLED: process.env.PLATFORM_REGISTRATION_ENABLED,
    PLATFORM_EMAIL_VERIFICATION_ENABLED: process.env.PLATFORM_EMAIL_VERIFICATION_ENABLED,
    PLATFORM_JWT_SECRET: process.env.PLATFORM_JWT_SECRET,
    PLATFORM_ADMIN_TOKEN: process.env.PLATFORM_ADMIN_TOKEN,
    GENERATION_SUBMIT_LIMIT_PER_MINUTE: process.env.GENERATION_SUBMIT_LIMIT_PER_MINUTE,
    PIPELINE_CONCURRENCY_MAX: process.env.PIPELINE_CONCURRENCY_MAX,
  };
  process.env.PUBLIC_PLATFORM_MODE = 'true';
  process.env.PLATFORM_REGISTRATION_ENABLED = 'true';
  process.env.PLATFORM_EMAIL_VERIFICATION_ENABLED = 'false';
  process.env.PLATFORM_JWT_SECRET = JWT_SECRET;
  process.env.PLATFORM_ADMIN_TOKEN = ADMIN_TOKEN;
  delete process.env.GENERATION_SUBMIT_LIMIT_PER_MINUTE;
  delete process.env.PIPELINE_CONCURRENCY_MAX;

  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const app = express();
  app.use(express.json());
  app.use('/api/v1', setupRouter({}, db, { error() {}, warn() {}, info() {} }));
  const server = await new Promise((resolve) => {
    const running = app.listen(0, '127.0.0.1', () => resolve(running));
  });
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const results = [];

  const check = (name, ok, detail = '') => {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  };

  async function req(pathname, { method = 'GET', token, body, tenantId, admin } = {}) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    if (tenantId) headers['X-Tenant-Id'] = String(tenantId);
    if (admin) headers['x-platform-admin-token'] = ADMIN_TOKEN;
    const response = await fetch(`${base}${pathname}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await response.json(); } catch (_) { /* empty */ }
    return { status: response.status, data };
  }

  try {
    check(
      '默认每用户生成提交限流为 300/分钟',
      resolveGenerationSubmitLimitPerMinute() === 300,
      `limit=${resolveGenerationSubmitLimitPerMinute()}`,
    );
    check(
      '默认流水线并发上限为 300',
      resolvePipelineConcurrencyMax() === 300,
      `max=${resolvePipelineConcurrencyMax()}`,
    );

    const regA = await req('/auth/register', {
      method: 'POST',
      body: { email: 'canvas-sync-a@example.com', password: PASSWORD },
    });
    check('用户A注册', regA.status === 201, `status=${regA.status}`);
    const tokenA = regA.data?.data?.token;

    const regB = await req('/auth/register', {
      method: 'POST',
      body: { email: 'canvas-sync-b@example.com', password: PASSWORD },
    });
    check('用户B注册', regB.status === 201, `status=${regB.status}`);
    const tokenB = regB.data?.data?.token;

    const tenantA = await req('/tenants', {
      method: 'POST',
      token: tokenA,
      body: { name: '画布同步租户A', slug: `canvas-sync-a-${Date.now()}` },
    });
    check('用户A创建租户', tenantA.status === 201, `status=${tenantA.status}`);
    const tenantIdA = tenantA.data?.data?.id;

    const tenantB = await req('/tenants', {
      method: 'POST',
      token: tokenB,
      body: { name: '画布同步租户B', slug: `canvas-sync-b-${Date.now()}` },
    });
    check('用户B创建租户', tenantB.status === 201, `status=${tenantB.status}`);
    const tenantIdB = tenantB.data?.data?.id;

    const dramaCreate = await req('/dramas', {
      method: 'POST',
      token: tokenA,
      tenantId: tenantIdA,
      body: { title: '多端对齐项目', project_type: 'standalone_canvas' },
    });
    check(
      '用户A创建独立画布项目',
      dramaCreate.status === 201 || dramaCreate.status === 200,
      `status=${dramaCreate.status}`,
    );
    const dramaId = Number(dramaCreate.data?.data?.id);

    const rev0 = await req(`/dramas/${dramaId}/canvas-revision`, {
      token: tokenA,
      tenantId: tenantIdA,
    });
    check(
      '用户A可读本项目 canvas-revision',
      rev0.status === 200 && Number.isSafeInteger(Number(rev0.data?.data?.canvas_state_revision)),
      `status=${rev0.status} rev=${rev0.data?.data?.canvas_state_revision}`,
    );
    const baseRev = Number(rev0.data?.data?.canvas_state_revision);

    const foreignRev = await req(`/dramas/${dramaId}/canvas-revision`, {
      token: tokenB,
      tenantId: tenantIdB,
    });
    check(
      '用户B不可读他人 canvas-revision',
      foreignRev.status === 404,
      `status=${foreignRev.status}`,
    );

    const save = await req(`/dramas/${dramaId}/canvas-layout`, {
      method: 'PUT',
      token: tokenA,
      tenantId: tenantIdA,
      body: {
        base_canvas_revision: baseRev,
        canvas_layout: {
          version: 1,
          free_nodes: [{ id: 'n-remote', type: 'homeCanvasNode', position: { x: 12, y: 34 } }],
        },
      },
    });
    check('用户A保存画布推进 revision', save.status === 200, `status=${save.status}`);

    const rev1 = await req(`/dramas/${dramaId}/canvas-revision`, {
      token: tokenA,
      tenantId: tenantIdA,
    });
    check(
      '保存后 revision 递增（另一端可发现更新）',
      rev1.status === 200 && Number(rev1.data?.data?.canvas_state_revision) === baseRev + 1,
      `before=${baseRev} after=${rev1.data?.data?.canvas_state_revision}`,
    );

    const settingsGet = await req('/settings/generation', {
      token: tokenA,
      tenantId: tenantIdA,
    });
    check(
      '生成设置返回 concurrency_max=300',
      settingsGet.status === 200 && Number(settingsGet.data?.data?.concurrency_max) === 300,
      `status=${settingsGet.status} max=${settingsGet.data?.data?.concurrency_max}`,
    );

    const settingsPutUser = await req('/settings/generation', {
      method: 'PUT',
      token: tokenA,
      tenantId: tenantIdA,
      body: { concurrency: 50, video_concurrency: 50 },
    });
    check(
      '普通用户不可改全局生成并发',
      settingsPutUser.status === 401 || settingsPutUser.status === 403,
      `status=${settingsPutUser.status}`,
    );

    const userIdA = regA.data?.data?.user?.id;
    db.prepare("UPDATE platform_users SET role = 'admin', platform_role = 'admin' WHERE id = ?")
      .run(userIdA);

    const settingsPutAdmin = await req('/settings/generation', {
      method: 'PUT',
      token: tokenA,
      tenantId: tenantIdA,
      body: { concurrency: 50, video_concurrency: 80 },
    });
    check(
      '平台管理员可将图/视频并发调到 50/80（<=300）',
      settingsPutAdmin.status === 200
        && Number(settingsPutAdmin.data?.data?.concurrency) === 50
        && Number(settingsPutAdmin.data?.data?.video_concurrency) === 80,
      `status=${settingsPutAdmin.status} body=${JSON.stringify(settingsPutAdmin.data)}`,
    );

    const settingsPutOver = await req('/settings/generation', {
      method: 'PUT',
      token: tokenA,
      tenantId: tenantIdA,
      body: { concurrency: 301 },
    });
    check(
      '超过 300 的并发被拒绝',
      settingsPutOver.status === 400,
      `status=${settingsPutOver.status}`,
    );

    const failed = results.filter((item) => !item.ok);
    const summary = {
      contract: 'predeploy-canvas-sync-limits-user-smoke-v1',
      total: results.length,
      pass: results.length - failed.length,
      fail: failed.length,
      failed: failed.map((item) => item.name),
    };
    console.log(JSON.stringify(summary, null, 2));
    if (failed.length) process.exitCode = 1;
  } finally {
    await new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(resolve);
    });
    db.close();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
