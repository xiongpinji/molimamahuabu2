# 充值中心页面实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在不启用支付宝商户支付的前提下，交付独立 `/recharge` 充值中心、大图套餐卡片、固定 `1 元 = 100 积分` 自定义充值，以及可上传并编辑全部结构化广告内容的管理员套餐后台。

**架构：** 后端在现有 `recharge_packages` 上增加展示、排序和推荐字段，继续复用既有订单、回调验签和积分入账链；管理员上传沿用 `uploadService` 的 `/static/uploads/` 存储合同。前端新增独立充值视图和两个小组件，旧工作区充值区缩减为入口，后台套餐面板改为列表、表单、实时预览三栏。

**技术栈：** Node.js 20、Express、better-sqlite3、multer、Vue 3 `<script setup>`、Vue Router、Element Plus、Node test runner、Playwright、Vite。

---

## 实施边界

- 本计划不写入支付宝 App ID、应用私钥、公钥、商户号或回调地址。
- 本计划不发起真实支付；当 `configured=false` 时，所有购买按钮禁用，事件处理函数也必须在调用订单 API 前返回。
- 不修改 `processNotification`、积分原子入账、订单幂等或租户隔离语义。
- 不新增会员订阅、礼品卡、优惠券、任意 HTML/CSS 编辑器或删除套餐接口。
- 本计划只做本地实现、测试和提交，不部署 `/opt/moli-drama`。

## 文件结构与职责

### 新建

- `backend-node/migrations/49_recharge_package_presentation.sql`：新增套餐展示字段和单推荐套餐唯一索引。
- `frontweb/src/utils/rechargePresentation.js`：纯函数封装金额、积分、赠送与颜色兜底计算，供用户页、卡片和测试共享。
- `frontweb/src/components/RechargePackageCard.vue`：只负责渲染一张套餐卡片并发出购买事件。
- `frontweb/src/components/CustomRechargePanel.vue`：只负责自定义金额输入、快捷金额、积分预览和购买事件。
- `frontweb/src/views/RechargeCenter.vue`：装载充值数据、切换模式、展示订单抽屉并守卫支付入口。
- `frontweb/test/recharge-presentation.test.js`：覆盖 `1:100`、套餐基础/赠送积分和颜色兜底。
- `frontweb/e2e/recharge-center.spec.js`：用固定 API 响应验证用户页、后台、支付禁用和三种视口。

### 修改

- `backend-node/src/services/alipay-recharge-service.js`：补齐 schema、字段校验、单推荐事务和排序事务。
- `backend-node/src/routes/alipay-recharge.js`：增加排序处理器。
- `backend-node/src/routes/upload.js`：增加仅 JPEG/PNG/WebP 的套餐图上传中间件和复用存储处理器。
- `backend-node/src/routes/index.js`：挂载受 `requireAdmin + requireBillingManager` 保护的排序和上传路由。
- `backend-node/test/alipay-recharge-service.test.js`：覆盖展示字段、相对图片、排序、推荐唯一性和失败回滚。
- `backend-node/test/alipay-recharge-routes.test.js`：覆盖排序响应与两条新管理员路由的权限顺序。
- `backend-node/test/directorAssetUpload.test.js`：覆盖套餐图片格式限制和实际落盘地址。
- `frontweb/src/api/billing.js`：增加套餐顺序保存 API。
- `frontweb/src/api/upload.js`：增加管理员套餐图片上传 API。
- `frontweb/src/router/index.js`：新增 `/recharge`，旧 `section=recharge` 重定向到新页面。
- `frontweb/src/components/PlatformHeader.vue`：充值按钮直接打开 `recharge-center`。
- `frontweb/src/views/TenantConsole.vue`：移除完整充值表单，只保留积分概览和充值入口。
- `frontweb/src/components/RechargePackageAdminPanel.vue`：改成排序列表、结构化表单和实时卡片预览。
- `frontweb/src/App.vue`：充值中心内不重复显示悬浮账户徽标。
- `frontweb/test/alipay-recharge.test.js`：更新路由、组件、后台字段和支付禁用静态合同。

## 任务 1：扩展套餐展示数据合同

**文件：**
- 创建：`backend-node/migrations/49_recharge_package_presentation.sql`
- 修改：`backend-node/src/services/alipay-recharge-service.js:14-178`
- 测试：`backend-node/test/alipay-recharge-service.test.js:107-202`

- [ ] **步骤 1：编写展示字段与图片地址的失败测试**

在 `backend-node/test/alipay-recharge-service.test.js` 增加以下用例；测试必须明确所有默认值、长度限制和同源图片合同：

```js
test('管理员套餐保存全部结构化广告字段并接受同源上传地址', () => {
  const { db } = setup();
  const item = recharge.createPackage(db, {
    name: '春日创作包',
    badge_text: '限时加赠',
    ad_title: '让每个灵感都能开拍',
    ad_subtitle: '适合连续短剧生产',
    button_text: '立即充值',
    amount_yuan: '99.00',
    credits: 12800,
    image_url: '/static/uploads/recharge-packages/spring.webp',
    accent_color: '#FF7139',
    sort_order: 3,
    is_featured: true,
    status: 'active',
  });

  assert.equal(item.badge_text, '限时加赠');
  assert.equal(item.ad_title, '让每个灵感都能开拍');
  assert.equal(item.ad_subtitle, '适合连续短剧生产');
  assert.equal(item.button_text, '立即充值');
  assert.equal(item.accent_color, '#ff7139');
  assert.equal(item.sort_order, 3);
  assert.equal(item.is_featured, 1);
});

test('套餐拒绝越界文案、任意 CSS 颜色和非上传相对图片', () => {
  const { db } = setup();
  const base = {
    name: '边界套餐', ad_title: '有效标题', amount_yuan: '10', credits: 1000,
    image_url: 'https://cdn.example.com/card.webp', status: 'active',
  };
  for (const patch of [
    { badge_text: '超'.repeat(21) },
    { ad_title: '超'.repeat(49) },
    { ad_subtitle: '超'.repeat(81) },
    { button_text: '超'.repeat(21) },
    { accent_color: 'linear-gradient(red, blue)' },
    { image_url: '/static/other/not-uploaded.png' },
    { sort_order: -1 },
  ]) {
    assert.throws(
      () => recharge.createPackage(db, { ...base, ...patch }),
      (error) => error.code === 'INVALID_RECHARGE_PACKAGE',
    );
  }
});
```

- [ ] **步骤 2：运行测试并确认红灯**

运行：

```powershell
cd backend-node
node --test --test-concurrency=1 test/alipay-recharge-service.test.js
```

预期：新用例失败，原因是 `badge_text` 等列尚不存在，且相对上传地址仍被 HTTPS 校验拒绝。

- [ ] **步骤 3：创建迁移并同步内存 schema**

`backend-node/migrations/49_recharge_package_presentation.sql` 写入：

```sql
ALTER TABLE recharge_packages ADD COLUMN badge_text TEXT NOT NULL DEFAULT '';
ALTER TABLE recharge_packages ADD COLUMN ad_title TEXT NOT NULL DEFAULT '';
ALTER TABLE recharge_packages ADD COLUMN ad_subtitle TEXT NOT NULL DEFAULT '';
ALTER TABLE recharge_packages ADD COLUMN button_text TEXT NOT NULL DEFAULT '立即购买';
ALTER TABLE recharge_packages ADD COLUMN accent_color TEXT NOT NULL DEFAULT '#ff7139';
ALTER TABLE recharge_packages ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE recharge_packages ADD COLUMN is_featured INTEGER NOT NULL DEFAULT 0 CHECK (is_featured IN (0, 1));
CREATE UNIQUE INDEX IF NOT EXISTS uq_recharge_packages_featured
  ON recharge_packages(is_featured) WHERE is_featured = 1;
```

在 `ensureSchema(db)` 的建表定义中加入同名列，并在 `CREATE TABLE IF NOT EXISTS` 后按 `PRAGMA table_info(recharge_packages)` 补齐旧内存数据库缺少的列。补列列表固定为：

```js
const PACKAGE_PRESENTATION_COLUMNS = [
  ['badge_text', "TEXT NOT NULL DEFAULT ''"],
  ['ad_title', "TEXT NOT NULL DEFAULT ''"],
  ['ad_subtitle', "TEXT NOT NULL DEFAULT ''"],
  ['button_text', "TEXT NOT NULL DEFAULT '立即购买'"],
  ['accent_color', "TEXT NOT NULL DEFAULT '#ff7139'"],
  ['sort_order', 'INTEGER NOT NULL DEFAULT 0'],
  ['is_featured', 'INTEGER NOT NULL DEFAULT 0 CHECK (is_featured IN (0, 1))'],
];
```

补列后执行与迁移相同的部分唯一索引创建语句，保证 `ensureSchema` 测试路径和真实迁移路径一致。

- [ ] **步骤 4：实现结构化字段规范化**

在 `normalizePackage` 中使用以下合同；字段名同时兼容现有 snake_case 和调用层可能传入的 camelCase：

```js
const badgeText = String(input.badgeText ?? input.badge_text ?? '').trim();
const adTitle = String(input.adTitle ?? input.ad_title ?? '').trim();
const adSubtitle = String(input.adSubtitle ?? input.ad_subtitle ?? '').trim();
const buttonText = String(input.buttonText ?? input.button_text ?? '立即购买').trim();
const accentColor = String(input.accentColor ?? input.accent_color ?? '#ff7139').trim().toLowerCase();
const sortOrder = Number(input.sortOrder ?? input.sort_order ?? 0);
const featuredInput = input.isFeatured ?? input.is_featured ?? false;
if (![true, false, 1, 0, '1', '0'].includes(featuredInput)) {
  throw rechargeError('INVALID_RECHARGE_PACKAGE', '推荐套餐标记不合法');
}
const isFeatured = [true, 1, '1'].includes(featuredInput) ? 1 : 0;

if (badgeText.length > 20 || !adTitle || adTitle.length > 48
  || adSubtitle.length > 80 || !buttonText || buttonText.length > 20
  || !/^#[0-9a-f]{6}$/i.test(accentColor)
  || !Number.isSafeInteger(sortOrder) || sortOrder < 0) {
  throw rechargeError('INVALID_RECHARGE_PACKAGE', '套餐广告文案、强调色或排序不合法');
}
let validRemoteImage = false;
try {
  const parsedImageUrl = new URL(imageUrl);
  validRemoteImage = parsedImageUrl.protocol === 'https:' && Boolean(parsedImageUrl.hostname);
} catch (_) {}
if (!validRemoteImage && !/^\/static\/uploads\/recharge-packages\/[A-Za-z0-9_./-]+$/.test(imageUrl)) {
  throw rechargeError('INVALID_RECHARGE_PACKAGE', '套餐广告图必须来自后台上传或有效 HTTPS 地址');
}
```

将新增字段加入 `INSERT`、`UPDATE` 与返回对象；不修改 `tenant_recharge_orders` 的快照列。

- [ ] **步骤 5：运行目标测试确认绿灯**

运行：

```powershell
cd backend-node
node --test --test-concurrency=1 test/alipay-recharge-service.test.js
```

预期：该文件全部通过，原有自定义充值、通知幂等和积分入账测试仍为绿色。

- [ ] **步骤 6：提交任务 1**

```powershell
git add backend-node/migrations/49_recharge_package_presentation.sql backend-node/src/services/alipay-recharge-service.js backend-node/test/alipay-recharge-service.test.js
git commit -m "feat(充值): 扩展套餐广告字段"
```

## 任务 2：实现单推荐套餐与原子排序

**文件：**
- 修改：`backend-node/src/services/alipay-recharge-service.js:136-178,321-333`
- 修改：`backend-node/src/routes/alipay-recharge.js:41-66`
- 修改：`backend-node/src/routes/index.js:159-162`
- 测试：`backend-node/test/alipay-recharge-service.test.js`
- 测试：`backend-node/test/alipay-recharge-routes.test.js:137-153`

- [ ] **步骤 1：编写推荐唯一性与排序回滚的失败测试**

```js
test('新推荐套餐会在同一事务中替换旧推荐套餐', () => {
  const { db } = setup();
  const first = recharge.createPackage(db, packageInput('第一套餐', { sort_order: 0, is_featured: true }));
  const second = recharge.createPackage(db, packageInput('第二套餐', { sort_order: 1, is_featured: true }));
  const rows = recharge.listPackages(db);
  assert.equal(rows.find((item) => item.id === first.id).is_featured, 0);
  assert.equal(rows.find((item) => item.id === second.id).is_featured, 1);
});

test('管理员只能用完整且不重复的 ID 列表原子更新套餐顺序', () => {
  const { db } = setup();
  const a = recharge.createPackage(db, packageInput('A', { sort_order: 0 }));
  const b = recharge.createPackage(db, packageInput('B', { sort_order: 1 }));
  const c = recharge.createPackage(db, packageInput('C', { sort_order: 2 }));
  recharge.reorderPackages(db, [c.id, a.id, b.id]);
  assert.deepEqual(recharge.listPackages(db).map((item) => item.id), [c.id, a.id, b.id]);
  assert.throws(
    () => recharge.reorderPackages(db, [a.id, a.id, c.id]),
    (error) => error.code === 'INVALID_RECHARGE_PACKAGE_ORDER',
  );
  assert.deepEqual(recharge.listPackages(db).map((item) => item.id), [c.id, a.id, b.id]);
});
```

测试文件内增加以下辅助函数，并把文件中既有 `createPackage` / `updatePackage` 测试数据补上 `ad_title`，使旧账务用例继续满足新的必填合同：

```js
function packageInput(name, patch = {}) {
  return {
    name,
    ad_title: `${name}广告标题`,
    amount_yuan: '10.00',
    credits: 1000,
    image_url: `https://cdn.example.com/${encodeURIComponent(name)}.webp`,
    status: 'active',
    ...patch,
  };
}
```

`backend-node/test/alipay-recharge-routes.test.js` 中既有管理员建套餐请求也补充 `ad_title: '限时套餐广告'`；这只更新测试数据，不改变路由断言。

- [ ] **步骤 2：运行两个后端目标测试并确认失败**

```powershell
cd backend-node
node --test --test-concurrency=1 test/alipay-recharge-service.test.js test/alipay-recharge-routes.test.js
```

预期：`reorderPackages` 未导出，第二个推荐套餐触发唯一索引错误，排序路由尚未挂载。

- [ ] **步骤 3：用事务实现推荐替换和排序**

创建、更新套餐均通过事务包装；当 `value.is_featured === 1` 时先执行：

```js
db.prepare('UPDATE recharge_packages SET is_featured = 0, updated_at = ? WHERE is_featured = 1')
  .run(now);
```

新增并导出：

```js
function reorderPackages(db, packageIds) {
  ensureSchema(db);
  if (!Array.isArray(packageIds)) {
    throw rechargeError('INVALID_RECHARGE_PACKAGE_ORDER', '套餐顺序必须是完整 ID 列表');
  }
  const ids = packageIds.map((id) => String(id || '').trim());
  const existing = db.prepare('SELECT id FROM recharge_packages ORDER BY sort_order, created_at').all();
  if (ids.length !== existing.length || new Set(ids).size !== ids.length
    || existing.some((row) => !ids.includes(row.id))) {
    throw rechargeError('INVALID_RECHARGE_PACKAGE_ORDER', '套餐顺序与现有套餐不一致');
  }
  const update = db.prepare('UPDATE recharge_packages SET sort_order = ?, updated_at = ? WHERE id = ?');
  const now = new Date().toISOString();
  db.transaction(() => ids.forEach((id, index) => update.run(index, now, id)))();
  return listPackages(db);
}
```

`listPackages` 和 `listAvailablePackages` 统一改为 `ORDER BY sort_order ASC, created_at ASC`。

- [ ] **步骤 4：增加排序处理器与错误映射**

在 `alipay-recharge.js` 中将 `INVALID_RECHARGE_PACKAGE_ORDER` 映射为 HTTP 400，并增加：

```js
reorderAdminPackages: (req, res) => {
  try {
    response.success(res, recharge.reorderPackages(db, req.body?.package_ids));
  } catch (error) {
    if (respondRechargeError(res, error)) return;
    log.error('alipay recharge admin reorder packages', { error: error.message });
    response.internalError(res, error.message);
  }
},
```

在 `index.js` 的租户上下文中间件之前挂载：

```js
r.put('/billing/admin/recharge-packages/order', requireAdmin, requireBillingManager, alipayRecharge.reorderAdminPackages);
```

路由测试把该路径加入管理员保护数组，并直接调用处理器断言返回顺序。

- [ ] **步骤 5：运行后端目标测试确认通过**

```powershell
cd backend-node
node --test --test-concurrency=1 test/alipay-recharge-service.test.js test/alipay-recharge-routes.test.js
```

预期：两个文件全部通过。

- [ ] **步骤 6：提交任务 2**

```powershell
git add backend-node/src/services/alipay-recharge-service.js backend-node/src/routes/alipay-recharge.js backend-node/src/routes/index.js backend-node/test/alipay-recharge-service.test.js backend-node/test/alipay-recharge-routes.test.js
git commit -m "feat(充值): 支持套餐推荐与排序"
```

## 任务 3：增加受保护的套餐广告图上传

**文件：**
- 修改：`backend-node/src/routes/upload.js:9-62,227-285,414-425`
- 修改：`backend-node/src/routes/index.js:77-89,159-162,188-194`
- 测试：`backend-node/test/directorAssetUpload.test.js`
- 测试：`backend-node/test/alipay-recharge-routes.test.js:137-153`

- [ ] **步骤 1：编写格式、落盘与权限失败测试**

在 `directorAssetUpload.test.js` 增加一个临时目录用例，直接调用新 handler：

```js
test('套餐广告图只接受 JPEG PNG WebP 并保存到专用上传目录', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recharge-package-image-'));
  try {
    const handlers = uploadModule.routes({
      storage: { local_path: tempRoot, base_url: '' },
    }, { info() {}, warn() {}, error() {} });
    const rejected = captureResponse();
    handlers.uploadRechargePackageImage({ file: {
      buffer: Buffer.from('gif'), originalname: 'promo.gif', mimetype: 'image/gif', size: 3,
    } }, rejected);
    assert.equal(rejected.statusCode, 400);

    const accepted = captureResponse();
    handlers.uploadRechargePackageImage({ file: {
      buffer: Buffer.from('webp'), originalname: 'promo.webp', mimetype: 'image/webp', size: 4,
    } }, accepted);
    assert.equal(accepted.statusCode, 200);
    assert.match(accepted.body.data.url, /^\/static\/uploads\/recharge-packages\/.+\.webp$/);
    assert.equal(fs.existsSync(path.join(tempRoot, accepted.body.data.local_path)), true);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
```

路由测试同时断言上传路径包含 `requireAdmin, requireBillingManager`，且中间件顺序在文件写入 handler 之前。

- [ ] **步骤 2：运行上传与路由测试确认失败**

```powershell
cd backend-node
node --test --test-concurrency=1 test/directorAssetUpload.test.js test/alipay-recharge-routes.test.js
```

预期：`uploadRechargePackageImage` 与上传路由尚不存在。

- [ ] **步骤 3：复用上传服务实现专用 handler**

在 `upload.js` 增加：

```js
const rechargePackageImageTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
const rechargePackageImageUpload = multer({
  storage: memoryStorage,
  limits: { fileSize: maxSize },
  fileFilter: (_req, file, cb) => rechargePackageImageTypes.includes(file.mimetype || '')
    ? cb(null, true)
    : cb(new Error('套餐广告图只支持 jpg、png、webp')),
});
```

把现有 `uploadImage` 的存储路径解析抽成文件内私有 `saveImageUpload(req, res, category, logLabel)`；原处理器传 `uploads`，新处理器传 `uploads/recharge-packages`。新处理器在调用共享函数前再次检查 MIME，保证直接调用 handler 也不能绕过中间件：

```js
uploadRechargePackageImage: (req, res) => {
  if (!req.file?.buffer) return response.badRequest(res, '请选择文件');
  if (!rechargePackageImageTypes.includes(req.file.mimetype || '')) {
    return response.badRequest(res, '套餐广告图只支持 jpg、png、webp');
  }
  return saveImageUpload(req, res, 'uploads/recharge-packages', 'upload recharge package image');
},
```

由 `routes()` 返回带 Multer 错误映射的 `multerRechargePackageImageSingle`，文件超限返回 413，格式错误返回 400。

- [ ] **步骤 4：在管理员中间件之后挂载专用路由**

将 `const uploadHandlers = uploadModule.routes(cfg, log, db, { publicPlatformEnabled })` 移到管理员充值路由之前，并挂载：

```js
r.post(
  '/billing/admin/recharge-packages/image',
  requireAdmin,
  requireBillingManager,
  uploadHandlers.multerRechargePackageImageSingle,
  uploadHandlers.uploadRechargePackageImage,
);
```

删除后方重复的 `uploadHandlers` 声明，其他 `/upload/*` 路由继续使用同一个对象。

- [ ] **步骤 5：运行上传、路由和套餐服务测试**

```powershell
cd backend-node
node --test --test-concurrency=1 test/directorAssetUpload.test.js test/alipay-recharge-routes.test.js test/alipay-recharge-service.test.js
```

预期：全部通过；测试临时目录在 `finally` 中删除。

- [ ] **步骤 6：提交任务 3**

```powershell
git add backend-node/src/routes/upload.js backend-node/src/routes/index.js backend-node/test/directorAssetUpload.test.js backend-node/test/alipay-recharge-routes.test.js
git commit -m "feat(充值): 增加套餐广告图上传"
```

## 任务 4：建立前端充值数据与路由合同

**文件：**
- 创建：`frontweb/src/utils/rechargePresentation.js`
- 创建：`frontweb/test/recharge-presentation.test.js`
- 创建：`frontweb/src/views/RechargeCenter.vue`（最小可构建占位，任务 5 完成页面）
- 修改：`frontweb/src/api/billing.js:24-38,80-90`
- 修改：`frontweb/src/api/upload.js:3-20`
- 修改：`frontweb/src/router/index.js:94-121,143-148`
- 修改：`frontweb/src/components/PlatformHeader.vue:142-148`
- 修改：`frontweb/test/alipay-recharge.test.js`

- [ ] **步骤 1：编写纯函数和路由静态合同的失败测试**

`frontweb/test/recharge-presentation.test.js`：

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  creditsForCustomAmount,
  normalizeAccentColor,
  packageCreditMetrics,
  validCustomAmount,
} from '../src/utils/rechargePresentation.js'

test('自定义充值始终按 1 元兑换 100 积分', () => {
  assert.equal(creditsForCustomAmount(12.34), 1234)
  assert.equal(validCustomAmount(12.34, '1.00', '50000.00'), true)
  assert.equal(validCustomAmount(0.99, '1.00', '50000.00'), false)
})

test('套餐基础与赠送积分不会显示负赠送', () => {
  assert.deepEqual(packageCreditMetrics({ amount_cents: 9900, credits: 12800 }), {
    amountYuan: 99,
    baseCredits: 9900,
    bonusCredits: 2900,
    creditsPerYuan: 129.29,
  })
  assert.equal(packageCreditMetrics({ amount_cents: 1000, credits: 900 }).bonusCredits, 0)
})

test('管理员强调色不合法时回退茉莉橙', () => {
  assert.equal(normalizeAccentColor('#2A8CFF'), '#2a8cff')
  assert.equal(normalizeAccentColor('red'), '#ff7139')
})
```

更新 `alipay-recharge.test.js`，断言：

```js
assert.match(routerSource, /path:\s*'\/recharge'/)
assert.match(routerSource, /name:\s*'recharge-center'/)
assert.match(routerSource, /section === 'recharge'/)
assert.match(platformHeader, /name:\s*'recharge-center'/)
assert.match(billingApi, /recharge-packages\/order/)
assert.match(uploadApi, /billing\/admin\/recharge-packages\/image/)
```

- [ ] **步骤 2：运行前端目标测试确认失败**

```powershell
cd frontweb
node --test test/recharge-presentation.test.js test/alipay-recharge.test.js
```

预期：工具文件和新 API/路由尚不存在。

- [ ] **步骤 3：实现纯函数与 API**

`rechargePresentation.js` 使用以下完整导出合同：

```js
export const CUSTOM_RECHARGE_RATIO = 100
export const QUICK_RECHARGE_AMOUNTS = [10, 30, 50, 100, 300, 500]

export function creditsForCustomAmount(amount) {
  const value = Number(amount)
  return Number.isFinite(value) ? Math.round(value * CUSTOM_RECHARGE_RATIO) : 0
}

export function validCustomAmount(amount, min, max) {
  const value = Number(amount)
  return Number.isFinite(value) && value >= Number(min) && value <= Number(max)
    && /^\d{1,5}(?:\.\d{1,2})?$/.test(String(amount))
}

export function packageCreditMetrics(item) {
  const amountYuan = Number(item?.amount_cents || 0) / 100
  const credits = Number(item?.credits || 0)
  const baseCredits = Math.round(amountYuan * CUSTOM_RECHARGE_RATIO)
  return {
    amountYuan,
    baseCredits,
    bonusCredits: Math.max(credits - baseCredits, 0),
    creditsPerYuan: amountYuan > 0 ? Number((credits / amountYuan).toFixed(2)) : 0,
  }
}

export function normalizeAccentColor(value) {
  const color = String(value || '').trim().toLowerCase()
  return /^#[0-9a-f]{6}$/.test(color) ? color : '#ff7139'
}
```

`billing.js` 增加 `reorderRechargePackages(packageIds)`；`upload.js` 增加 `uploadRechargePackageImage(file)`，均使用设计文档中的精确路径和现有 `request` 实例。

- [ ] **步骤 4：增加充值路由和旧入口重定向**

在 `router/index.js` 增加：

```js
{
  path: '/recharge',
  name: 'recharge-center',
  component: () => import('@/views/RechargeCenter.vue'),
  meta: { title: '充值中心', requiresAuth: true }
},
```

在全局守卫最前面处理旧入口：

```js
if (to.name === 'tenant-console' && to.query.section === 'recharge') {
  return { name: 'recharge-center' }
}
```

`PlatformHeader.goRecharge()` 改为 `router.push({ name: 'recharge-center' })`；兑换入口保持原样。

同时创建最小 `RechargeCenter.vue` 占位组件，确保本任务提交单独执行 Vite 构建时可解析路由；任务 5 在同一文件上完成正式页面，不能留下不可构建的中间提交。

- [ ] **步骤 5：运行前端目标测试确认通过**

```powershell
cd frontweb
node --test test/recharge-presentation.test.js test/alipay-recharge.test.js
npm run build
```

预期：两个文件全部通过，Vite 生产构建退出码 0。

- [ ] **步骤 6：提交任务 4**

```powershell
git add frontweb/src/utils/rechargePresentation.js frontweb/test/recharge-presentation.test.js frontweb/src/views/RechargeCenter.vue frontweb/src/api/billing.js frontweb/src/api/upload.js frontweb/src/router/index.js frontweb/src/components/PlatformHeader.vue frontweb/test/alipay-recharge.test.js
git commit -m "feat(充值): 建立充值中心前端合同"
```

## 任务 5：实现独立用户充值中心

**文件：**
- 创建：`frontweb/src/components/RechargePackageCard.vue`
- 创建：`frontweb/src/components/CustomRechargePanel.vue`
- 修改：`frontweb/src/views/RechargeCenter.vue`
- 修改：`frontweb/src/views/TenantConsole.vue:35-51,103-181,250-330,369-388,485-526,558-574`
- 修改：`frontweb/src/App.vue:4`
- 修改：`frontweb/test/alipay-recharge.test.js`

- [ ] **步骤 1：编写用户页面静态合同的失败测试**

在 `alipay-recharge.test.js` 读取三个新文件并断言：

```js
for (const text of ['精选套餐', '自定义充值', '充值记录', '支付通道准备中']) {
  assert.match(rechargeCenter, new RegExp(text))
}
assert.match(rechargeCenter, /if \(!rechargeConfig\.value\.configured\) return/)
assert.match(rechargeCenter, /createAlipayRechargeOrder/)
assert.match(packageCard, /height:\s*230px/)
assert.match(packageCard, /item\.ad_title/)
assert.match(packageCard, /item\.ad_subtitle/)
assert.match(packageCard, /bonusCredits/)
assert.match(customPanel, /QUICK_RECHARGE_AMOUNTS/)
assert.match(customPanel, /creditsForCustomAmount/)
assert.doesNotMatch(tenantConsole, /createAlipayRechargeOrder/)
assert.match(tenantConsole, /name:\s*'recharge-center'/)
```

- [ ] **步骤 2：运行前端目标测试确认失败**

```powershell
cd frontweb
node --test test/recharge-presentation.test.js test/alipay-recharge.test.js
```

预期：三个 Vue 文件未创建，工作区仍包含旧充值逻辑。

- [ ] **步骤 3：实现套餐卡片组件**

`RechargePackageCard.vue` 的公共合同固定为：

```js
const props = defineProps({
  item: { type: Object, required: true },
  disabled: { type: Boolean, default: false },
  loading: { type: Boolean, default: false },
  preview: { type: Boolean, default: false },
})
const emit = defineEmits(['purchase'])
```

卡片根元素设置 `--package-accent: normalizeAccentColor(item.accent_color)`；图片区固定 `height: 230px; object-fit: cover`，加载失败后显示强调色占位层和套餐名。广告标题使用 `item.ad_title || item.name`，兼容迁移前已存在且展示字段为空的套餐。按钮文字规则：支付关闭时显示「支付通道准备中」，否则显示 `item.button_text || '立即购买'`；事件函数在 `disabled || preview` 时不得 emit。

内容顺序必须是广告图、推荐/角标、广告副标题/主标题、套餐名称/有效期、售价/到账积分/每元比例、基础积分/赠送积分、按钮。仅当 `bonusCredits > 0` 时展示赠送区。

- [ ] **步骤 4：实现自定义充值组件**

`CustomRechargePanel.vue` 的公共合同：

```js
const props = defineProps({
  config: { type: Object, required: true },
  disabled: { type: Boolean, default: false },
  loading: { type: Boolean, default: false },
})
const emit = defineEmits(['purchase'])
const amount = ref(10)
const credits = computed(() => creditsForCustomAmount(amount.value))

function submit() {
  if (props.disabled) return
  if (!validCustomAmount(amount.value, props.config.min_amount_yuan, props.config.max_amount_yuan)) {
    return ElMessage.warning(`充值金额需在 ${props.config.min_amount_yuan} 至 ${props.config.max_amount_yuan} 元之间`)
  }
  emit('purchase', Number(amount.value).toFixed(2))
}
```

模板包含六个快捷金额、固定比例说明、预计积分、金额范围、订单摘要和禁用原因；窄屏改为单列。

- [ ] **步骤 5：实现 RechargeCenter 数据流和支付双重守卫**

`RechargeCenter.vue` 在 `onMounted` 中并行读取：

```js
const [credit, config, packages, orders] = await Promise.all([
  getCreditAccount(),
  getAlipayRechargeConfig(),
  listRechargePackages(),
  listAlipayRechargeOrders(),
])
```

默认 `mode='packages'`。顶部显示当前可用积分、订单抽屉按钮和返回工作区按钮；套餐网格使用 `RechargePackageCard`。订单抽屉继续只使用现有本人订单 API。

唯一允许创建订单的函数为：

```js
async function beginRecharge(payload, target) {
  if (!rechargeConfig.value.configured) return
  payingTarget.value = target
  try {
    const result = await createAlipayRechargeOrder({
      ...payload,
      client_order_key: `recharge-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    })
    window.location.assign(result.payment_url)
  } finally {
    payingTarget.value = ''
  }
}
```

页面 CSS 使用视觉规格：最大宽度 1600px、桌面四列、1024px 以下两列、760px 以下一列；卡片最小高度 570px；推荐卡只在桌面上移 10px。没有套餐时仍保留模式切换和自定义充值。

- [ ] **步骤 6：缩减工作区旧充值区并处理悬浮徽标**

从 `TenantConsole.vue` 删除充值配置、套餐、订单、下单函数和整块套餐 DOM，只在积分概览卡加入：

```vue
<el-button type="primary" @click="router.push({ name: 'recharge-center' })">
  前往充值中心
</el-button>
```

保留兑换码和积分流水；`section=redeem` 的滚动逻辑不变。`App.vue` 的 `AccountBadge` 条件增加 `route.name !== 'recharge-center'`，避免充值页自带顶部账户信息时重复覆盖。

- [ ] **步骤 7：运行前端目标测试与构建**

```powershell
cd frontweb
node --test test/recharge-presentation.test.js test/alipay-recharge.test.js
npm run build
```

预期：目标测试全部通过，Vite 生产构建退出码 0。

- [ ] **步骤 8：提交任务 5**

```powershell
git add frontweb/src/components/RechargePackageCard.vue frontweb/src/components/CustomRechargePanel.vue frontweb/src/views/RechargeCenter.vue frontweb/src/views/TenantConsole.vue frontweb/src/App.vue frontweb/test/alipay-recharge.test.js
git commit -m "feat(充值): 新增独立充值中心"
```

## 任务 6：重构管理员套餐编辑器

**文件：**
- 修改：`frontweb/src/components/RechargePackageAdminPanel.vue:1-160`
- 修改：`frontweb/test/alipay-recharge.test.js`

- [ ] **步骤 1：编写后台全字段、上传、排序和预览失败测试**

```js
for (const text of [
  '套餐名称', '角标文案', '广告主标题', '广告副标题', '按钮文案',
  '售价（元）', '到账积分', '开始时间', '结束时间', '强调色', '推荐套餐', '状态',
]) {
  assert.match(adminPanel, new RegExp(text))
}
assert.match(adminPanel, /uploadRechargePackageImage/)
assert.match(adminPanel, /reorderRechargePackages/)
assert.match(adminPanel, /draggable="true"/)
assert.match(adminPanel, /上移/)
assert.match(adminPanel, /下移/)
assert.match(adminPanel, /RechargePackageCard/)
```

- [ ] **步骤 2：运行前端目标测试确认失败**

```powershell
cd frontweb
node --test test/alipay-recharge.test.js test/recharge-presentation.test.js
```

预期：旧后台只包含基础字段和 HTTPS 文本输入。

- [ ] **步骤 3：建立单一编辑草稿和完整 payload**

后台状态保持一个 `editing` 草稿，避免同时直接修改多张卡片：

```js
const emptyDraft = () => ({
  id: '', name: '', badge_text: '', ad_title: '', ad_subtitle: '',
  button_text: '立即购买', amount_yuan: 10, credits: 1000,
  starts_at: null, ends_at: null, image_url: '', accent_color: '#ff7139',
  sort_order: packages.value.length, is_featured: false, status: 'active',
})
```

加载旧套餐时，`normalizePackage` 将空的 `ad_title` 映射为套餐名称、空的 `button_text` 映射为「立即购买」，避免旧数据进入编辑器后无法理解。`toPayload` 必须发送设计中的全部字段。`validate` 同时检查文案长度、金额、积分、时间、`/static/uploads/recharge-packages/` 或 HTTPS 图片以及 `#RRGGBB`，错误信息直接指出具体字段。

- [ ] **步骤 4：实现图片选择、上传和失败保留**

文件输入使用：

```html
<input ref="imageInput" type="file" accept="image/jpeg,image/png,image/webp" hidden @change="uploadImage">
```

处理函数只在成功后替换草稿 URL：

```js
async function uploadImage(event) {
  const file = event.target.files?.[0]
  event.target.value = ''
  if (!file) return
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
    return ElMessage.warning('套餐广告图只支持 JPG、PNG、WebP')
  }
  uploading.value = true
  try {
    const result = await uploadRechargePackageImage(file)
    editing.image_url = result.url
  } finally {
    uploading.value = false
  }
}
```

上传或保存失败时不清空 `editing.image_url`；重新加载只发生在保存成功或排序失败回滚时。

- [ ] **步骤 5：实现拖动排序和键盘替代操作**

左栏每项使用原生 `draggable="true"`。`moveItem(fromIndex, toIndex)` 生成新数组后调用一个持久化函数：

```js
async function persistOrder(next) {
  const previous = packages.value
  packages.value = next
  try {
    packages.value = (await reorderRechargePackages(next.map((item) => item.id))).map(normalizePackage)
  } catch (error) {
    packages.value = previous
    throw error
  }
}
```

每项同时提供带 `aria-label` 的「上移」「下移」按钮；首项上移和末项下移禁用。推荐开关允许选择一个套餐，后端事务负责清除旧推荐，保存成功后重新读取列表。

- [ ] **步骤 6：实现三栏布局和实时预览**

桌面使用 `grid-template-columns: 300px minmax(420px, 1fr) minmax(320px, 420px)`；左栏套餐列表、中栏表单、右栏 `RechargePackageCard :item="previewItem" preview`。小于 1100px 改为两栏且预览移到下方，小于 760px 为单列。

新增套餐按钮切换到空草稿；现有套餐点击时复制到草稿。保存时根据是否有 `id` 调用创建或更新 API，成功后 `load()` 并重新选中保存对象。

- [ ] **步骤 7：运行前端目标测试和构建**

```powershell
cd frontweb
node --test test/alipay-recharge.test.js test/recharge-presentation.test.js
npm run build
```

预期：目标测试全部通过，生产构建退出码 0。

- [ ] **步骤 8：提交任务 6**

```powershell
git add frontweb/src/components/RechargePackageAdminPanel.vue frontweb/test/alipay-recharge.test.js
git commit -m "feat(充值): 完善套餐广告管理后台"
```

## 任务 7：浏览器验收与完整回归审计

**文件：**
- 创建：`frontweb/e2e/recharge-center.spec.js`

- [ ] **步骤 1：编写用户端浏览器测试**

测试用 `page.addInitScript` 写入 `moli_mama_session` 和 `moli_mama_tenant_id`，用 `page.route('**/api/v1/**')` 返回：

```js
const packages = [
  { id: 'plus', name: 'PLUS', badge_text: '3.20 折', ad_title: '轻量创作起步', ad_subtitle: '适合个人创作者', button_text: '选择 PLUS', amount_cents: 9900, credits: 12000, image_url: '/static/uploads/recharge-packages/plus.webp', accent_color: '#ff7139', sort_order: 0, is_featured: 0 },
  { id: 'pro', name: 'PRO', badge_text: '最受欢迎', ad_title: '高频短剧生产', ad_subtitle: '推荐工作室使用', button_text: '选择 PRO', amount_cents: 29900, credits: 42000, image_url: '/static/uploads/recharge-packages/pro.webp', accent_color: '#8c6cff', sort_order: 1, is_featured: 1 },
  { id: 'max', name: 'MAX', badge_text: '2.88 折', ad_title: '团队协作扩容', ad_subtitle: '覆盖连续生产', button_text: '选择 MAX', amount_cents: 69900, credits: 98000, image_url: '/static/uploads/recharge-packages/max.webp', accent_color: '#4d8dff', sort_order: 2, is_featured: 0 },
  { id: 'ultra', name: 'ULTRA', badge_text: '旗舰', ad_title: '规模化内容工厂', ad_subtitle: '适合成熟团队', button_text: '选择 ULTRA', amount_cents: 119900, credits: 180000, image_url: '/static/uploads/recharge-packages/ultra.webp', accent_color: '#51b7c8', sort_order: 3, is_featured: 0 },
]
```

支付配置固定返回 `configured: false`。`page.route('**/static/uploads/recharge-packages/**')` 返回一张带不同强调色的 SVG 测试图，保证广告图区域不是依赖 404 占位。测试断言默认展示四张卡片、PRO 推荐标识、按钮文字「支付通道准备中」；点击所有禁用按钮后，订单 POST 计数仍为 0。切换自定义充值、输入 `12.34` 后断言显示 `1,234` 积分。

- [ ] **步骤 2：增加三视口和后台浏览器断言**

依次设置 `1440×900`、`1024×900`、`390×844`，用卡片 `boundingBox()` 判断同一行分别为 4、2、1 张且页面无水平溢出。广告图高度允许 `228-232 px`。

管理员场景访问 `/billing-admin?tab=recharge`，API 返回同一套餐数组；断言全部结构化字段可见，选择套餐后修改广告标题会立即更新右侧预览，上传接口 mock 成功后草稿图片 URL 改为 `/static/uploads/recharge-packages/new.webp`，拖动或点击下移会发送完整且无重复的 `package_ids`。

- [ ] **步骤 3：运行 Playwright 并保存新鲜证据**

```powershell
cd frontweb
$previousPublicMode = $env:VITE_PUBLIC_PLATFORM_MODE
try {
  $env:VITE_PUBLIC_PLATFORM_MODE = '1'
  npx playwright test e2e/recharge-center.spec.js
  if ($LASTEXITCODE -ne 0) { throw "充值中心 E2E 失败，退出码 $LASTEXITCODE" }
} finally {
  if ($null -eq $previousPublicMode) { Remove-Item Env:VITE_PUBLIC_PLATFORM_MODE -ErrorAction SilentlyContinue }
  else { $env:VITE_PUBLIC_PLATFORM_MODE = $previousPublicMode }
}
```

预期：充值中心 E2E 全部通过；失败时保留 trace，不接受只看截图的人工推断。

- [ ] **步骤 4：运行全部目标测试与构建**

```powershell
cd backend-node
node --test --test-concurrency=1 test/alipay-recharge-service.test.js test/alipay-recharge-routes.test.js test/directorAssetUpload.test.js test/alipay-gateway.test.js test/creditLedger.test.js

cd ../frontweb
node --test test/alipay-recharge.test.js test/recharge-presentation.test.js
npm run build
```

预期：所有目标测试通过，生产构建退出码 0。

- [ ] **步骤 5：运行完整回归并如实记录基线**

```powershell
cd backend-node
npm test

cd ../frontweb
node --test test/*.test.js
```

预期：后端完整测试无失败。前端完整测试需与实施前基线比较；已知基线为 507 项中 6 项无关画布合同失败，不能把既有失败宣称为本功能通过，也不能顺手修改无关画布代码。

- [ ] **步骤 6：审计安全边界、差异和支付宝暂停状态**

```powershell
git diff --check
git status --short
git diff --name-only 4962d596..HEAD
rg -n "ALIPAY_APP_ID|ALIPAY_PRIVATE_KEY|ALIPAY_PUBLIC_KEY|ALIPAY_SELLER_ID" . -g '!node_modules/**' -g '!dist/**'
```

核对：本次提交不包含密钥值；`processNotification` 和积分入账语义未被改写；画布积分卡片受保护合同文件未被触碰；支付宝未配置时浏览器测试确认订单 POST 为 0。

- [ ] **步骤 7：提交任务 7**

```powershell
git add frontweb/e2e/recharge-center.spec.js
git commit -m "test(充值): 覆盖充值中心浏览器验收"
```

## 最终完成条件

只有以下条件同时成立才能报告完成：

1. 后端展示字段、推荐唯一性、原子排序、图片权限和既有充值账务目标测试全部通过。
2. 前端纯函数、静态合同、Playwright 三视口和生产构建全部通过。
3. `configured=false` 时按钮与事件函数双重阻止创建订单，浏览器观测到 0 次订单 POST。
4. 管理员能上传图片并编辑广告图、角标、主副标题、套餐名称、按钮文案、金额、积分、有效期、强调色、推荐、排序和状态。
5. 工作区旧入口正确跳转 `/recharge`，兑换码、积分流水和成员管理保持可用。
6. 没有写入支付宝商户配置，没有部署生产，没有修改无关画布代码。
