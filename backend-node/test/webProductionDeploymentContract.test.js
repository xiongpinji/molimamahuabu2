const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const root = path.resolve(__dirname, '..', '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('生产镜像包含前端构建、后端运行时、FFmpeg 和健康检查', () => {
  const dockerfile = read('Dockerfile');
  assert.match(dockerfile, /npm run build:public/);
  assert.match(dockerfile, /WEB_DIST_PATH=/);
  assert.match(dockerfile, /ffmpeg/);
  assert.match(dockerfile, /python3/);
  assert.match(dockerfile, /make/);
  assert.match(dockerfile, /g\+\+/);
  assert.match(dockerfile, /HEALTHCHECK/);
  assert.doesNotMatch(dockerfile, /PLATFORM_JWT_SECRET\s*=/);
  assert.doesNotMatch(dockerfile, /PLATFORM_ADMIN_TOKEN\s*=/);
});

test('生产镜像内置固定哈希的 CPU 抠图链且不要求专用 GPU 运行时', () => {
  const dockerfile = read('Dockerfile');
  const requirements = read('deploy/rembg/requirements.lock');
  const wrapper = read('deploy/rembg/rembg-cpu');
  assert.match(wrapper, /print\(f["']rembg \{VERSION\}["']\)/);
  const notices = read('deploy/rembg/THIRD_PARTY_NOTICES.md');

  assert.match(dockerfile, /pip install .*--require-hashes/);
  assert.match(dockerfile, /rembg-cpu --version/);
  assert.match(dockerfile, /rembg-models\/u2netp\.onnx/);
  assert.match(dockerfile, /309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8/);
  assert.match(dockerfile, /IMAGE_TOOL_REMBG_VERSION=2\.0\.77/);
  assert.match(dockerfile, /U2NET_HOME=\/opt\/rembg-models/);
  assert.match(dockerfile, /IMAGE_TOOL_REMBG_MAX_CONCURRENCY=1/);
  assert.match(dockerfile, /IMAGE_TOOL_REMBG_MAX_TENANT_CONCURRENCY=1/);
  assert.match(dockerfile, /OMP_NUM_THREADS=1/);
  assert.doesNotMatch(dockerfile, /onnxruntime-gpu|cuda|rocm/i);
  assert.match(requirements, /rembg==2\.0\.77/);
  assert.match(requirements, /onnxruntime==/);
  assert.match(requirements, /--hash=sha256:/);
  assert.match(wrapper, /new_session\(model\)/);
  assert.match(wrapper, /^#!\/opt\/rembg\/bin\/python3/);
  assert.match(notices, /MIT/);
  assert.match(notices, /Apache-2\.0/);
});

test('网页生产构建显式启用公开平台模式', () => {
  const packageJson = JSON.parse(read('frontweb/package.json'));
  const buildScript = read('frontweb/scripts/build-public.mjs');

  assert.equal(packageJson.scripts['build:public'], 'node scripts/build-public.mjs');
  assert.match(buildScript, /VITE_PUBLIC_PLATFORM_MODE/);
  assert.match(buildScript, /true/);
  assert.match(buildScript, /build\(\)/);
});

test('生产 Compose 使用 HTTPS 入口、持久卷、健康检查和自动重启', () => {
  const compose = yaml.load(read('compose.production.yml'));
  const app = compose.services.app;
  const caddy = compose.services.caddy;

  assert.match(app.image, /^\$\{APP_IMAGE:\?/);
  assert.equal(app.restart, 'unless-stopped');
  assert.ok(app.healthcheck);
  assert.ok(app.volumes.includes('molimama_data:/var/lib/molimama'));
  assert.equal(caddy.restart, 'unless-stopped');
  assert.deepEqual(caddy.ports, ['80:80', '443:443']);
  assert.ok(caddy.depends_on.app);
  assert.ok(compose.volumes.molimama_data !== undefined);
  assert.ok(compose.volumes.caddy_data !== undefined);
});

test('生产示例环境文件只包含占位符且公开注册默认关闭', () => {
  const example = read('.env.production.example');
  assert.match(example, /^APP_DOMAIN=/m);
  assert.match(example, /^APP_IMAGE=ghcr\.io\/xiongpinji\/molimamahuabu2:sha-<commit-sha>$/m);
  assert.match(example, /^PLATFORM_REGISTRATION_ENABLED=false$/m);
  assert.match(example, /^PLATFORM_JWT_SECRET=CHANGE_ME_/m);
  assert.match(example, /^PLATFORM_ADMIN_TOKEN=CHANGE_ME_/m);
  assert.match(example, /^PLATFORM_EMAIL_VERIFICATION_ENABLED=true$/m);
  assert.match(example, /^SMTP_HOST=/m);
  assert.match(example, /^SMTP_FROM=/m);
  assert.match(example, /^SMTP_PASSWORD=CHANGE_ME_/m);
  assert.match(example, /^ALIPAY_APP_ID=$/m);
  assert.match(example, /^ALIPAY_SELLER_ID=$/m);
  assert.match(example, /^ALIPAY_PRIVATE_KEY=$/m);
  assert.match(example, /^ALIPAY_PUBLIC_KEY=$/m);
  assert.match(example, /^ALIPAY_NOTIFY_URL=https:\/\//m);
  assert.match(example, /^ALIPAY_RETURN_URL=https:\/\//m);
  assert.doesNotMatch(example, /sk-[A-Za-z0-9]/);
});

test('镜像 CI 会实际启动容器、检查网页并发布不可变镜像', () => {
  const workflow = read('.github/workflows/web-production-image.yml');
  assert.match(workflow, /docker build/);
  assert.match(workflow, /\/health/);
  assert.match(workflow, /docker run/);
  assert.match(workflow, /index\.html|茉莉妈妈/);
  assert.match(workflow, /\^rembg 2\.0\.77\$/);
  assert.match(workflow, /sha256sum --check/);
  assert.match(workflow, /docker network disconnect bridge/);
  assert.match(workflow, /rembg-cpu[\s\S]*i -m u2netp/);
  assert.match(workflow, /hasAlpha/);
  assert.match(workflow, /packages:\s*write/);
  assert.match(workflow, /docker push/);
  assert.match(workflow, /sha-\$\{GITHUB_SHA\}/);
  assert.doesNotMatch(workflow, /actions\/checkout@v\d/);
});

test('真实 AIHubCC 图片节点同链要求显式付费确认并使用隔离浏览器端口', () => {
  const packageJson = JSON.parse(read('frontweb/package.json'));
  const runner = read('frontweb/scripts/run-real-aihubcc-image-node-chain.mjs');
  const browserSpec = read('frontweb/e2e/image-node-toolbar-backend-integration.spec.js');

  assert.equal(
    packageJson.scripts['test:e2e:image-node-real'],
    'node scripts/run-real-aihubcc-image-node-chain.mjs',
  );
  assert.match(runner, /RUN_REAL_AIHUBCC_IMAGE_NODE_CHAIN/);
  assert.match(runner, /AIHUBCC_API_KEY/);
  assert.match(runner, /AIHUBCC_BASE_URL/);
  assert.match(runner, /AIHUBCC_IMAGE_MODEL/);
  assert.match(runner, /gpt-image-2-3\.5k/);
  assert.match(runner, /hostname\.toLowerCase\(\) !== 'aihubcc\.cc'/);
  assert.match(runner, /protocol !== 'https:'/);
  assert.match(runner, /server\.listen\(0, '127\.0\.0\.1'/);
  assert.match(runner, /PLAYWRIGHT_REUSE_SERVER: '0'/);
  assert.match(runner, /--trace=off/);
  assert.doesNotMatch(runner, /console\.log\(.*apiKey|process\.stdout\.write\(.*apiKey/);
  assert.match(browserSpec, /真实触发 AIHubCC gpt-image-2-3\.5k/);
  assert.match(browserSpec, /engine: 'provider-image-edit'/);
  assert.match(browserSpec, /imageToolHistory/);
  assert.match(browserSpec, /page\.reload/);
});

test('生产手册拉取已验证镜像且安全政策覆盖网页端责任边界', () => {
  const deployment = read('docs/WEB_PRODUCTION_DEPLOYMENT.md');
  const security = read('SECURITY.md');

  assert.match(deployment, /docker compose .* pull app/);
  assert.match(deployment, /sha-<commit-sha>/);
  assert.match(deployment, /-p molimama-canary/);
  assert.match(deployment, /预热项目不得挂载生产/);
  assert.match(deployment, /不应为了应用回滚而覆盖当前数据库/);
  assert.match(security, /网页端生产部署/);
  assert.match(security, /服务器端/);
  assert.match(security, /密钥/);
  assert.doesNotMatch(security, /本地离线桌面应用/);
});

test('网页生产门禁不审计或构建已退出交付路径的桌面安装包', () => {
  const dependencyWorkflow = read('.github/workflows/dependency-security.yml');
  const desktopWorkflow = read('.github/workflows/windows-desktop-build.yml');

  assert.doesNotMatch(dependencyWorkflow, /npm --prefix desktop/);
  assert.match(dependencyWorkflow, /pip-audit==2\.10\.0/);
  assert.match(dependencyWorkflow, /deploy\/rembg\/requirements\.lock/);
  assert.match(dependencyWorkflow, /npm --prefix backend-node run audit:licenses/);
  assert.match(dependencyWorkflow, /npm --prefix backend-node run audit:image-node-release/);
  assert.doesNotMatch(desktopWorkflow, /-\s+'frontweb\/\*\*'/);
  assert.doesNotMatch(desktopWorkflow, /-\s+'backend-node\/\*\*'/);
});
