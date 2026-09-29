'use strict';

/**
 * 用户视角 HTTP 冒烟（公开平台）：登录失败、跨租户角色库隔离、非管理员写全局设置。
 * 内存库，不碰生产。
 */
const express = require('express');
const Database = require('better-sqlite3');
const { setupRouter } = require('../src/routes');
const { runMigrationsAndEnsure } = require('../src/db/migrate');

const JWT_SECRET = 'predeploy-user-smoke-jwt-secret-32chars';
const ADMIN_TOKEN = 'predeploy-user-smoke-admin-token-32ch';
const PASSWORD = 'correct horse battery staple';

async function main() {
  const saved = {
    PUBLIC_PLATFORM_MODE: process.env.PUBLIC_PLATFORM_MODE,
    PLATFORM_REGISTRATION_ENABLED: process.env.PLATFORM_REGISTRATION_ENABLED,
    PLATFORM_EMAIL_VERIFICATION_ENABLED: process.env.PLATFORM_EMAIL_VERIFICATION_ENABLED,
    PLATFORM_JWT_SECRET: process.env.PLATFORM_JWT_SECRET,
    PLATFORM_ADMIN_TOKEN: process.env.PLATFORM_ADMIN_TOKEN,
  };
  process.env.PUBLIC_PLATFORM_MODE = 'true';
  process.env.PLATFORM_REGISTRATION_ENABLED = 'true';
  process.env.PLATFORM_EMAIL_VERIFICATION_ENABLED = 'false';
  process.env.PLATFORM_JWT_SECRET = JWT_SECRET;
  process.env.PLATFORM_ADMIN_TOKEN = ADMIN_TOKEN;

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

  async function req(pathname, { method = 'GET', token, body, tenantId } = {}) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    if (tenantId) headers['X-Tenant-Id'] = String(tenantId);
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
    const regA = await req('/auth/register', {
      method: 'POST',
      body: { email: 'smoke-a@example.com', password: PASSWORD },
    });
    check('用户A注册', regA.status === 201, `status=${regA.status}`);
    const tokenA = regA.data?.data?.token;
    const userA = regA.data?.data?.user || {};
    const tenantA = regA.data?.data?.tenant?.id || userA.tenant_id;

    const regB = await req('/auth/register', {
      method: 'POST',
      body: { email: 'smoke-b@example.com', password: PASSWORD },
    });
    check('用户B注册', regB.status === 201, `status=${regB.status}`);
    const tokenB = regB.data?.data?.token;
    const userB = regB.data?.data?.user || {};
    const tenantB = regB.data?.data?.tenant?.id || userB.tenant_id;

    const badLogin = await req('/auth/login', {
      method: 'POST',
      body: { email: 'smoke-a@example.com', password: 'definitely-wrong' },
    });
    check('错误密码登录失败', badLogin.status >= 400, `status=${badLogin.status}`);

    const goodLogin = await req('/auth/login', {
      method: 'POST',
      body: { email: 'smoke-a@example.com', password: PASSWORD },
    });
    check('正确密码登录成功', goodLogin.status === 200 && !!goodLogin.data?.data?.token, `status=${goodLogin.status}`);

    const meA = await req('/auth/me', { token: tokenA });
    check('用户A /auth/me', meA.status === 200, `status=${meA.status}`);

    const tenantCreateA = await req('/tenants', {
      method: 'POST',
      token: tokenA,
      body: { name: '冒烟租户A', slug: `smoke-a-${Date.now()}` },
    });
    check('用户A创建租户', tenantCreateA.status === 201, `status=${tenantCreateA.status}`);
    const resolvedTenantA = tenantCreateA.data?.data?.id || tenantA;

    const tenantCreateB = await req('/tenants', {
      method: 'POST',
      token: tokenB,
      body: { name: '冒烟租户B', slug: `smoke-b-${Date.now()}` },
    });
    check('用户B创建租户', tenantCreateB.status === 201, `status=${tenantCreateB.status}`);
    const resolvedTenantB = tenantCreateB.data?.data?.id || tenantB;

    const dramaCreateA = await req('/dramas', {
      method: 'POST',
      token: tokenA,
      tenantId: resolvedTenantA,
      body: { title: 'A项目' },
    });
    check('用户A创建项目', dramaCreateA.status === 201 || dramaCreateA.status === 200, `status=${dramaCreateA.status}`);
    const dramaA = Number(dramaCreateA.data?.data?.id);

    const dramaCreateB = await req('/dramas', {
      method: 'POST',
      token: tokenB,
      tenantId: resolvedTenantB,
      body: { title: 'B项目' },
    });
    check('用户B创建项目', dramaCreateB.status === 201 || dramaCreateB.status === 200, `status=${dramaCreateB.status}`);
    const dramaB = Number(dramaCreateB.data?.data?.id);

    const charCreate = await req('/character-library', {
      method: 'POST',
      token: tokenA,
      tenantId: resolvedTenantA,
      body: { drama_id: dramaA, name: '角色A', image_url: '/static/a.png' },
    });
    check('用户A创建角色库项', charCreate.status === 201, `status=${charCreate.status}`);
    const charId = Number(charCreate.data?.data?.id);

    const bareList = await req('/character-library', { token: tokenA, tenantId: resolvedTenantA });
    check(
      '裸 list 角色库要求 drama_id',
      bareList.status === 400 && bareList.data?.error?.code === 'DRAMA_ID_REQUIRED',
      `status=${bareList.status} code=${bareList.data?.error?.code}`,
    );

    const ownList = await req(`/character-library?drama_id=${dramaA}`, { token: tokenA, tenantId: resolvedTenantA });
    check('自有项目角色库可读', ownList.status === 200, `status=${ownList.status}`);

    const foreignList = await req(`/character-library?drama_id=${dramaA}`, { token: tokenB, tenantId: resolvedTenantB });
    check('跨租户 list 他人项目被拒', foreignList.status === 404, `status=${foreignList.status}`);

    const foreignGet = await req(`/character-library/${charId}`, { token: tokenB, tenantId: resolvedTenantB });
    check('跨租户 get 角色库被拒', foreignGet.status === 404, `status=${foreignGet.status}`);

    const foreignDelete = await req(`/character-library/${charId}`, {
      method: 'DELETE',
      token: tokenB,
      tenantId: resolvedTenantB,
    });
    check('跨租户 delete 角色库被拒', foreignDelete.status === 404, `status=${foreignDelete.status}`);

    const stillThere = charId && db.prepare('SELECT id FROM character_libraries WHERE id = ?').get(charId);
    check('跨租户删除未实际删库', !!stillThere);

    const promptWrite = await req('/settings/prompts/story_expansion_system', {
      method: 'PUT',
      token: tokenA,
      tenantId: resolvedTenantA,
      body: { content: 'hijack' },
    });
    check(
      '普通用户写全局 prompts 被拒',
      promptWrite.status === 401 || promptWrite.status === 403,
      `status=${promptWrite.status}`,
    );

    const sceneMapWrite = await req('/scene-model-map', {
      method: 'POST',
      token: tokenA,
      tenantId: resolvedTenantA,
      body: { key: 'smoke', model: 'x' },
    });
    check(
      '普通用户写 scene-model-map 被拒',
      sceneMapWrite.status === 401 || sceneMapWrite.status === 403,
      `status=${sceneMapWrite.status}`,
    );

    const failed = results.filter((item) => !item.ok);
    const summary = {
      contract: 'predeploy-user-http-smoke-v1',
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
