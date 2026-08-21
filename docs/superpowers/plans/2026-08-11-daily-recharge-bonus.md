# 充值套餐每日赠送积分实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将会员充值套餐改为永久基础积分一次到账，并连续 30 个上海自然日发放当日有效的每日赠送积分；会员有效期内禁止再次购买会员档，自定义充值保持可用。

**架构：** 以 `tenant_recharge_memberships` 保存唯一有效会员权益，以每日独立积分桶保存当日赠送额度，以预扣来源分配表记录一次生成从赠送积分和永久积分分别冻结多少。所有余额读取、预扣、确认、退款和过期处理都通过 SQLite immediate transaction 保证幂等与并发安全；午夜清零采用业务日期判定和惰性过期，不依赖定时任务。

**技术栈：** Node.js CommonJS、better-sqlite3、Express、Vue 3 `<script setup>`、Element Plus、Node test runner、Vite。

---

## 文件结构

### 新建

- `backend-node/migrations/55_daily_recharge_bonus.sql`：新增套餐/订单快照字段、会员权益、每日积分桶和预扣来源分配表，并迁移现有套餐。
- `backend-node/src/services/dailyRechargeBonusService.js`：统一上海自然日、会员状态、每日积分桶物化/过期和账户明细。
- `backend-node/test/dailyRechargeBonus.test.js`：日界线、30 天、桶幂等、过期和会员唯一性测试。
- `backend-node/test/alipayRechargeDailyBenefit.test.js`：套餐迁移、订单快照、购买门禁和支付结算测试。
- `backend-node/test/alipayRechargeRoutes.test.js`：充值 API 错误码和会员状态返回测试。
- `frontweb/test/rechargeDailyBonus.test.js`：套餐文案、管理员字段、会员购买禁用和余额拆分合同测试。

### 修改

- `backend-node/src/services/alipay-recharge-service.js`：套餐字段、订单权益快照、会员购买门禁和支付后原子建权。
- `backend-node/src/services/creditLedgerService.js`：租户账户余额拆分、赠送优先预扣、来源分配、跨日确认/退款。
- `backend-node/src/routes/alipay-recharge.js`：返回会员状态并映射会员购买冲突。
- `backend-node/src/routes/billing.js`：账户响应包含永久余额和今日赠送明细。
- `backend-node/src/services/platform-admin-service.js`：管理员租户列表的可用余额包含当日赠送，并返回永久/赠送拆分。
- `backend-node/test/creditLedger.test.js`：保持用户级旧账户行为不变。
- `backend-node/test/tenantCreditLedger.test.js`：租户赠送优先、混合预扣、跨日退款和幂等回归。
- `backend-node/test/billingRoutes.test.js`：账户兼容字段与新增明细。
- `backend-node/test/platform-admin-service.test.js`：管理员租户余额不遗漏当日赠送。
- `frontweb/src/utils/rechargePresentation.js`：基础积分、每日赠送、30 天文案和会员状态格式化。
- `frontweb/src/utils/billingDisplay.js`：保留总余额字段并规范化新增明细。
- `frontweb/src/components/RechargePackageAdminPanel.vue`：售价派生基础积分，编辑每日赠送积分。
- `frontweb/src/components/RechargePackageCard.vue`：展示永久基础积分、每日赠送和当日清零规则。
- `frontweb/src/views/RechargeCenter.vue`：加载会员状态、禁用套餐购买、显示余额拆分和到期日，自定义充值保持可用。
- `docs/plans/2026-08-11-daily-recharge-bonus-design.md`：实现完成后只更新状态与最终验证证据，不改已确认规则。

## 任务 1：建立可迁移的数据合同和上海自然日工具

**文件：**
- 创建：`backend-node/migrations/55_daily_recharge_bonus.sql`
- 创建：`backend-node/src/services/dailyRechargeBonusService.js`
- 创建：`backend-node/test/dailyRechargeBonus.test.js`

- [ ] **步骤 1：编写失败的迁移与日期测试**

在 `backend-node/test/dailyRechargeBonus.test.js` 建立内存库，先创建旧版 `recharge_packages` 和 `tenant_recharge_orders`，执行新迁移后断言：

```js
test('旧套餐把一次性额外赠送迁移为每日赠送且基础积分固定为售价换算', () => {
  const db = setupLegacyRechargeDb();
  db.prepare(`INSERT INTO recharge_packages
    (id, name, amount_cents, credits, image_url, status, created_at, updated_at)
    VALUES ('vip-1', '会员档', 10000, 11000, '/static/uploads/recharge-packages/a.png', 'active', ?, ?)`)
    .run(NOW, NOW);

  runMigration(db, '55_daily_recharge_bonus.sql');

  const row = db.prepare(`SELECT credits, daily_bonus_credits, benefit_version
    FROM recharge_packages WHERE id = 'vip-1'`).get();
  assert.deepEqual(row, {
    credits: 10000,
    daily_bonus_credits: 1000,
    benefit_version: 'daily_30d_v1',
  });
});

test('支付日算第1天并覆盖连续30个上海自然日', () => {
  assert.deepEqual(bonus.shanghaiBenefitWindow('2026-08-11T15:59:00.000Z'), {
    startsOn: '2026-08-11',
    endsOn: '2026-09-10',
  });
  assert.equal(bonus.shanghaiBusinessDate('2026-08-11T16:00:00.000Z'), '2026-08-12');
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```powershell
cd backend-node
node --test test/dailyRechargeBonus.test.js
```

预期：FAIL，缺少迁移文件和 `dailyRechargeBonusService`。

- [ ] **步骤 3：编写最小迁移**

`backend-node/migrations/55_daily_recharge_bonus.sql` 必须包含以下精确合同：

```sql
ALTER TABLE recharge_packages ADD COLUMN daily_bonus_credits INTEGER NOT NULL DEFAULT 0;
ALTER TABLE recharge_packages ADD COLUMN benefit_version TEXT NOT NULL DEFAULT 'legacy_once';

ALTER TABLE tenant_recharge_orders ADD COLUMN base_credits INTEGER;
ALTER TABLE tenant_recharge_orders ADD COLUMN daily_bonus_credits INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tenant_recharge_orders ADD COLUMN benefit_days INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tenant_recharge_orders ADD COLUMN benefit_version TEXT NOT NULL DEFAULT 'legacy_once';

CREATE TABLE IF NOT EXISTS tenant_recharge_memberships (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  recharge_order_id TEXT NOT NULL UNIQUE,
  package_id TEXT NOT NULL,
  package_name TEXT NOT NULL,
  daily_bonus_credits INTEGER NOT NULL CHECK (daily_bonus_credits >= 0),
  starts_on TEXT NOT NULL,
  ends_on TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'expired')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_tenant_active_recharge_membership
  ON tenant_recharge_memberships(tenant_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS tenant_daily_bonus_buckets (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  membership_id TEXT NOT NULL,
  benefit_date TEXT NOT NULL,
  granted INTEGER NOT NULL CHECK (granted >= 0),
  available INTEGER NOT NULL CHECK (available >= 0),
  held INTEGER NOT NULL CHECK (held >= 0),
  spent INTEGER NOT NULL CHECK (spent >= 0),
  expired INTEGER NOT NULL CHECK (expired >= 0),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (membership_id, benefit_date)
);

CREATE TABLE IF NOT EXISTS tenant_usage_reservation_allocations (
  reservation_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  bonus_bucket_id TEXT,
  bonus_amount INTEGER NOT NULL CHECK (bonus_amount >= 0),
  permanent_amount INTEGER NOT NULL CHECK (permanent_amount >= 0),
  created_at TEXT NOT NULL,
  CHECK (bonus_amount + permanent_amount > 0)
);

UPDATE recharge_packages
SET daily_bonus_credits = CASE WHEN credits > amount_cents THEN credits - amount_cents ELSE 0 END,
    credits = amount_cents,
    benefit_version = 'daily_30d_v1'
WHERE benefit_version = 'legacy_once';

UPDATE tenant_recharge_orders
SET base_credits = credits
WHERE base_credits IS NULL;
```

- [ ] **步骤 4：实现上海自然日纯函数和幂等建表入口**

在 `dailyRechargeBonusService.js` 导出固定接口：

```js
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const BENEFIT_DAYS = 30;

function shanghaiBusinessDate(nowValue = Date.now()) {
  return new Date(new Date(nowValue).getTime() + SHANGHAI_OFFSET_MS)
    .toISOString().slice(0, 10);
}

function addCalendarDays(dateText, days) {
  const [year, month, day] = dateText.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function shanghaiBenefitWindow(nowValue = Date.now()) {
  const startsOn = shanghaiBusinessDate(nowValue);
  return { startsOn, endsOn: addCalendarDays(startsOn, BENEFIT_DAYS) };
}
```

`ensureSchema(db)` 使用与迁移相同的表和列作为启动兜底，不执行套餐数据二次迁移。

- [ ] **步骤 5：运行测试验证通过**

运行：

```powershell
cd backend-node
node --test test/dailyRechargeBonus.test.js
node --check src/services/dailyRechargeBonusService.js
```

预期：全部 PASS，语法检查退出 0。

- [ ] **步骤 6：Commit**

```powershell
git add backend-node/migrations/55_daily_recharge_bonus.sql backend-node/src/services/dailyRechargeBonusService.js backend-node/test/dailyRechargeBonus.test.js
git commit -m "feat: 建立每日赠送积分数据合同"
```

## 任务 2：实现会员权益和每日积分桶

**文件：**
- 修改：`backend-node/src/services/dailyRechargeBonusService.js`
- 修改：`backend-node/test/dailyRechargeBonus.test.js`

- [ ] **步骤 1：编写失败的会员与积分桶测试**

增加以下行为测试：

```js
test('同一会员同一天只创建一个赠送积分桶', () => {
  const db = setup();
  const membership = bonus.createMembership(db, {
    tenantId: 'tenant-a', orderId: 'order-1', packageId: 'vip-1', packageName: '会员档',
    dailyBonusCredits: 1000, now: '2026-08-11T02:00:00.000Z',
  });
  const first = bonus.materializeTodayBucket(db, 'tenant-a', '2026-08-11T03:00:00.000Z');
  const second = bonus.materializeTodayBucket(db, 'tenant-a', '2026-08-11T04:00:00.000Z');
  assert.equal(first.id, second.id);
  assert.equal(first.available, 1000);
  assert.equal(first.membership_id, membership.id);
});

test('昨日未使用赠送在次日读取时转为过期且不计入可用', () => {
  const db = setupActiveMembership({ dailyBonusCredits: 1000 });
  bonus.materializeTodayBucket(db, 'tenant-a', '2026-08-11T03:00:00.000Z');
  const state = bonus.getDailyBonusState(db, 'tenant-a', '2026-08-12T03:00:00.000Z');
  assert.equal(state.available, 1000);
  const yesterday = db.prepare(`SELECT available, expired FROM tenant_daily_bonus_buckets
    WHERE benefit_date = '2026-08-11'`).get();
  assert.deepEqual(yesterday, { available: 0, expired: 1000 });
});

test('第31个自然日不再创建赠送积分桶', () => {
  const db = setupActiveMembership({ startsAt: '2026-08-11T02:00:00.000Z' });
  assert.equal(bonus.materializeTodayBucket(db, 'tenant-a', '2026-09-10T00:00:00.000Z'), null);
  assert.equal(bonus.getActiveMembership(db, 'tenant-a', '2026-09-10T00:00:00.000Z'), null);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test backend-node/test/dailyRechargeBonus.test.js`

预期：FAIL，缺少 `createMembership`、`materializeTodayBucket`、`getDailyBonusState`。

- [ ] **步骤 3：实现会员和积分桶事务**

实现并导出：

```js
function getActiveMembership(db, tenantId, nowValue = Date.now()) {}
function createMembership(db, input) {}
function expirePastBuckets(db, tenantId, businessDate, nowIso) {}
function materializeTodayBucket(db, tenantId, nowValue = Date.now()) {}
function getDailyBonusState(db, tenantId, nowValue = Date.now()) {}
```

关键 SQL 更新必须满足：

```sql
UPDATE tenant_daily_bonus_buckets
SET expired = expired + available, available = 0, updated_at = ?
WHERE tenant_id = ? AND benefit_date < ? AND available > 0;
```

`createMembership` 先把 `ends_on <= starts_on` 的旧 active 行标记为 expired，再插入新行；仍存在有效 active 行时抛出 `RECHARGE_MEMBERSHIP_ACTIVE`。

- [ ] **步骤 4：运行测试验证通过**

运行：`node --test backend-node/test/dailyRechargeBonus.test.js`

预期：全部 PASS。

- [ ] **步骤 5：Commit**

```powershell
git add backend-node/src/services/dailyRechargeBonusService.js backend-node/test/dailyRechargeBonus.test.js
git commit -m "feat: 实现30天会员每日赠送权益"
```

## 任务 3：让积分账本按赠送优先并正确处理跨日退款

**文件：**
- 修改：`backend-node/src/services/creditLedgerService.js`
- 修改：`backend-node/test/tenantCreditLedger.test.js`
- 修改：`backend-node/test/creditLedger.test.js`

- [ ] **步骤 1：编写失败的混合预扣和跨日退款测试**

在 `tenantCreditLedger.test.js` 增加：

```js
test('租户预扣优先使用今日赠送再使用永久积分', () => {
  const db = setupDailyTenant({ permanent: 100, daily: 30, now: DAY_ONE });
  const reservation = credits.reserve(db, {
    tenantId: 'tenant-a', actorUserId: 'user-1', operationKey: 'video:mixed',
    model: 'seedance-2', resourceType: 'video', resourceId: 'v1', amount: 50, now: DAY_ONE,
  });
  const allocation = db.prepare(`SELECT bonus_amount, permanent_amount
    FROM tenant_usage_reservation_allocations WHERE reservation_id = ?`).get(reservation.id);
  assert.deepEqual(allocation, { bonus_amount: 30, permanent_amount: 20 });
  assert.equal(credits.getTenantAccount(db, 'tenant-a', DAY_ONE).available, 80);
});

test('跨日失败只退永久积分且过期赠送不复活', () => {
  const db = setupDailyTenant({ permanent: 100, daily: 30, now: DAY_ONE });
  const reservation = reserveMixed(db, 50, DAY_ONE);
  credits.refund(db, reservation.id, 'provider_failed', DAY_TWO);
  const account = credits.getTenantAccountBreakdown(db, 'tenant-a', DAY_TWO);
  assert.equal(account.permanent_available, 100);
  assert.equal(account.daily_bonus_available, 30);
  const oldBucket = db.prepare(`SELECT available, held, expired
    FROM tenant_daily_bonus_buckets WHERE benefit_date = '2026-08-11'`).get();
  assert.deepEqual(oldBucket, { available: 0, held: 0, expired: 30 });
});

test('跨日成功确认仍消费原日已冻结赠送', () => {
  const db = setupDailyTenant({ permanent: 100, daily: 30, now: DAY_ONE });
  const reservation = reserveMixed(db, 50, DAY_ONE);
  credits.confirm(db, reservation.id, DAY_TWO);
  assert.equal(credits.getTenantAccount(db, 'tenant-a', DAY_TWO).spent, 50);
  assert.equal(db.prepare(`SELECT spent FROM tenant_daily_bonus_buckets
    WHERE benefit_date = '2026-08-11'`).get().spent, 30);
});
```

并在 `creditLedger.test.js` 保留用户级路径的既有 deepEqual，证明个人旧账户响应未增加字段。

- [ ] **步骤 2：运行测试验证失败**

运行：

```powershell
cd backend-node
node --test test/tenantCreditLedger.test.js test/creditLedger.test.js
```

预期：新增租户测试 FAIL，用户级既有测试 PASS。

- [ ] **步骤 3：实现租户账户拆分与来源分配**

修改签名以允许测试注入时间，同时保持旧调用兼容：

```js
function getTenantAccount(db, tenantId, nowValue = Date.now()) {}
function getTenantAccountBreakdown(db, tenantId, nowValue = Date.now()) {}
function reserve(db, input) {}
function confirm(db, reservationId, nowValue = Date.now()) {}
function refund(db, reservationId, reason, nowValue = Date.now()) {}
```

`getTenantAccount` 继续只返回既有四个字段，避免破坏大量调用方；其中 `available` 改为永久可用加今日赠送可用。新增 `getTenantAccountBreakdown` 返回：

```js
return {
  tenant_id: tenantId,
  available: permanentAvailable + daily.available,
  held: row.held,
  spent: row.spent,
  permanent_available: permanentAvailable,
  daily_bonus_available: daily.available,
  daily_bonus_expires_at: daily.expiresAt,
  membership_ends_on: daily.membershipEndsOn,
};
```

`createTenantReservation` 在 immediate transaction 内计算：

```js
const bonusAmount = Math.min(amount, dailyState.available);
const permanentAmount = amount - bonusAmount;
if (permanentAmount > permanent.available) throw insufficientCredits();
```

随后原子更新积分桶、永久账户、总 held、预扣表、来源分配和 ledger。`settleTenant` 必须读取来源分配，按原积分桶日期决定退款进入 `available` 还是 `expired`。

- [ ] **步骤 4：运行定向和并发测试**

运行：

```powershell
cd backend-node
node --test test/tenantCreditLedger.test.js test/creditLedger.test.js test/tenantGenerationBilling.test.js
```

预期：全部 PASS；两个 SQLite 连接的同 operation key 仍只产生一次预扣。

- [ ] **步骤 5：Commit**

```powershell
git add backend-node/src/services/creditLedgerService.js backend-node/test/tenantCreditLedger.test.js backend-node/test/creditLedger.test.js
git commit -m "feat: 每日赠送积分优先参与生成结算"
```

## 任务 4：改造套餐、订单快照和支付宝结算

**文件：**
- 修改：`backend-node/src/services/alipay-recharge-service.js`
- 创建：`backend-node/test/alipayRechargeDailyBenefit.test.js`

- [ ] **步骤 1：编写失败的套餐与订单测试**

新增：

```js
test('新套餐基础积分由售价派生并保存每日赠送积分', () => {
  const row = recharge.createPackage(db, packageInput({ amount_yuan: '100.00', daily_bonus_credits: 1000 }));
  assert.equal(row.credits, 10000);
  assert.equal(row.daily_bonus_credits, 1000);
  assert.equal(row.benefit_version, 'daily_30d_v1');
});

test('会员有效期内拒绝当前档和其他档但允许自定义充值', () => {
  seedActiveMembership(db, 'tenant-a', '2026-08-11', '2026-09-10');
  assert.throws(() => recharge.createOrder(db, packageOrder('vip-1')), hasCode('RECHARGE_MEMBERSHIP_ACTIVE'));
  assert.throws(() => recharge.createOrder(db, packageOrder('vip-2')), hasCode('RECHARGE_MEMBERSHIP_ACTIVE'));
  assert.equal(recharge.createOrder(db, customOrder('20.00')).order_kind, 'custom');
});

test('已有待支付套餐订单时复用同档订单并拒绝切换其他档', () => {
  const first = recharge.createOrder(db, packageOrder('vip-1'));
  const repeated = recharge.createOrder(db, { ...packageOrder('vip-1'), clientOrderKey: 'another-key-0001' });
  assert.equal(repeated.id, first.id);
  assert.throws(
    () => recharge.createOrder(db, { ...packageOrder('vip-2'), clientOrderKey: 'another-key-0002' }),
    hasCode('RECHARGE_PACKAGE_ORDER_PENDING'),
  );
});

test('支付套餐原子到账基础积分并建立30天权益和首日赠送', () => {
  const order = createDailyPackageOrder(db, { amountCents: 10000, dailyBonusCredits: 1000 });
  const result = recharge.settleVerifiedTrade(db, {
    outTradeNo: order.out_trade_no, alipayTradeNo: 'ali-1', amountCents: 10000,
    now: '2026-08-11T03:00:00.000Z',
  });
  assert.equal(result.credited, true);
  assert.equal(credits.getTenantAccountBreakdown(db, 'tenant-a', '2026-08-11T03:00:00.000Z').permanent_available, 10000);
  assert.equal(credits.getTenantAccountBreakdown(db, 'tenant-a', '2026-08-11T03:00:00.000Z').daily_bonus_available, 1000);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tenant_recharge_memberships').get().n, 1);
});

test('部署前待支付旧订单仍把原credits一次性永久入账', () => {
  const order = seedLegacyPendingOrder(db, { credits: 11000 });
  recharge.settleVerifiedTrade(db, verifiedTrade(order));
  assert.equal(credits.getTenantAccountBreakdown(db, 'tenant-a').permanent_available, 11000);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tenant_recharge_memberships').get().n, 0);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test backend-node/test/alipayRechargeDailyBenefit.test.js`

预期：FAIL，现有服务仍一次性入账 `order.credits` 且没有会员门禁。

- [ ] **步骤 3：实现套餐和订单快照**

`normalizePackage` 不再信任前端传入基础积分：

```js
const baseCredits = amountCents;
const dailyBonusCredits = Number(input.dailyBonusCredits ?? input.daily_bonus_credits);
if (!Number.isSafeInteger(dailyBonusCredits) || dailyBonusCredits < 0 || dailyBonusCredits > 100_000_000) {
  throw rechargeError('INVALID_RECHARGE_PACKAGE', '每日赠送积分必须是0至100000000的整数');
}
```

新套餐固定写入：

```js
credits: baseCredits,
daily_bonus_credits: dailyBonusCredits,
benefit_version: 'daily_30d_v1',
```

`createOrder` 使用 `db.transaction(...).immediate()`。同租户已有待支付套餐订单时，同档请求返回原订单，跨档请求抛出 `RECHARGE_PACKAGE_ORDER_PENDING`，避免两个订单先后支付后产生重叠权益。新套餐订单写入 `base_credits`、`daily_bonus_credits`、`benefit_days=30` 和 `benefit_version`。自定义订单写入 `base_credits=credits`、每日赠送 0、天数 0、版本 `custom_v1`。

- [ ] **步骤 4：实现支付结算分支**

`settleVerifiedTrade` 接受可选 `now` 便于边界测试：

```js
function settleVerifiedTrade(db, { outTradeNo, alipayTradeNo, amountCents, now = Date.now() }) {}
```

在同一事务内：

```js
if (order.benefit_version === 'daily_30d_v1') {
  creditLedger.adjustTenantBalance(db, permanentRechargeAdjustment(order, order.base_credits));
  dailyBonus.createMembership(db, membershipInput(order, now));
  dailyBonus.materializeTodayBucket(db, order.tenant_id, now);
} else {
  creditLedger.adjustTenantBalance(db, permanentRechargeAdjustment(order, order.credits));
}
```

重复通知先返回已支付订单，不重复调整余额或创建权益。

- [ ] **步骤 5：运行测试验证通过**

运行：

```powershell
cd backend-node
node --test test/alipayRechargeDailyBenefit.test.js test/dailyRechargeBonus.test.js test/tenantCreditLedger.test.js
```

预期：全部 PASS。

- [ ] **步骤 6：Commit**

```powershell
git add backend-node/src/services/alipay-recharge-service.js backend-node/test/alipayRechargeDailyBenefit.test.js
git commit -m "feat: 充值套餐改为30天每日赠送"
```

## 任务 5：锁定后端 API 门禁和兼容响应

**文件：**
- 修改：`backend-node/src/routes/alipay-recharge.js`
- 修改：`backend-node/src/routes/billing.js`
- 修改：`backend-node/src/services/platform-admin-service.js`
- 创建：`backend-node/test/alipayRechargeRoutes.test.js`
- 修改：`backend-node/test/billingRoutes.test.js`
- 修改：`backend-node/test/platform-admin-service.test.js`

- [ ] **步骤 1：编写失败的路由测试**

```js
test('有效会员购买任意套餐返回409且自定义充值仍创建订单', () => {
  const handlers = createHandlersWithActiveMembership();
  handlers.createOrder(packageRequest('vip-2'), packageResponse);
  assert.equal(packageResponse.statusCode, 409);
  assert.equal(packageResponse.body.code, 'RECHARGE_MEMBERSHIP_ACTIVE');

  handlers.createOrder(customRequest('20.00'), customResponse);
  assert.equal(customResponse.statusCode, 201);
});

test('套餐列表响应携带当前会员状态', () => {
  handlers.listPackages(tenantRequest, res);
  assert.equal(res.body.data.membership.active, true);
  assert.equal(res.body.data.membership.ends_on, '2026-09-10');
  assert.ok(Array.isArray(res.body.data.packages));
});

test('账户接口保留总余额并返回永久和今日赠送明细', () => {
  handlers.getAccount(tenantRequest, res);
  assert.deepEqual(res.body.data, {
    tenant_id: 'tenant-a', available: 130, held: 0, spent: 0,
    permanent_available: 100,
    daily_bonus_available: 30,
    daily_bonus_expires_at: '2026-08-12T00:00:00+08:00',
    membership_ends_on: '2026-09-10',
  });
});

test('管理员租户列表的可用余额包含今日赠送', () => {
  const tenant = platformAdmin.listTenants(db).find((row) => row.id === 'tenant-a');
  assert.equal(tenant.available, 130);
  assert.equal(tenant.permanent_available, 100);
  assert.equal(tenant.daily_bonus_available, 30);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```powershell
cd backend-node
node --test test/alipayRechargeRoutes.test.js test/billingRoutes.test.js
```

预期：FAIL，套餐列表当前只返回数组，账户缺少新增明细，会员冲突未映射。

- [ ] **步骤 3：实现 API 响应和错误码**

`respondRechargeError` 增加：

```js
if (error.code === 'RECHARGE_MEMBERSHIP_ACTIVE') {
  response.error(res, 409, error.code, error.message);
  return true;
}
```

`RECHARGE_PACKAGE_ORDER_PENDING` 同样返回 409，并提供“请继续完成当前待支付会员订单”的稳定错误文案。

套餐列表改为：

```js
response.success(res, {
  packages: recharge.listAvailablePackages(db),
  membership: recharge.getMembershipStatus(db, req.tenant.id),
});
```

账户路由调用 `creditLedger.getTenantAccountBreakdown`；无账户时也返回新增字段的零值/null。管理员租户列表使用同一个上海业务日期聚合 `tenant_daily_bonus_buckets.available`，不能继续只读取 `tenant_credit_accounts.available`。

- [ ] **步骤 4：运行测试验证通过**

运行：

```powershell
cd backend-node
node --test test/alipayRechargeRoutes.test.js test/billingRoutes.test.js test/platform-admin-service.test.js test/alipayRechargeDailyBenefit.test.js
```

预期：全部 PASS。

- [ ] **步骤 5：Commit**

```powershell
git add backend-node/src/routes/alipay-recharge.js backend-node/src/routes/billing.js backend-node/src/services/platform-admin-service.js backend-node/test/alipayRechargeRoutes.test.js backend-node/test/billingRoutes.test.js backend-node/test/platform-admin-service.test.js
git commit -m "feat: 锁定会员充值后端门禁"
```

## 任务 6：更新前端数据适配和余额展示

**文件：**
- 修改：`frontweb/src/utils/rechargePresentation.js`
- 修改：`frontweb/src/utils/billingDisplay.js`
- 修改：`frontweb/test/billingDisplay.test.js`
- 创建：`frontweb/test/rechargeDailyBonus.test.js`

- [ ] **步骤 1：编写失败的前端纯函数测试**

```js
test('套餐指标展示永久基础积分和每日赠送而不再计算一次性赠送', () => {
  assert.deepEqual(packageCreditMetrics({
    amount_cents: 10000,
    credits: 10000,
    daily_bonus_credits: 1000,
  }), {
    amountYuan: 100,
    baseCredits: 10000,
    dailyBonusCredits: 1000,
    benefitDays: 30,
    creditsPerYuan: 100,
  });
});

test('积分账户保留总余额并规范化每日赠送明细', () => {
  assert.deepEqual(normalizeCreditAccount({
    available: 130, held: 4, spent: 20,
    permanent_available: 100, daily_bonus_available: 30,
    daily_bonus_expires_at: '2026-08-12T00:00:00+08:00', membership_ends_on: '2026-09-10',
  }), {
    available: 130, held: 4, spent: 20,
    permanentAvailable: 100, dailyBonusAvailable: 30,
    dailyBonusExpiresAt: '2026-08-12T00:00:00+08:00', membershipEndsOn: '2026-09-10',
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```powershell
cd frontweb
node --test test/billingDisplay.test.js test/rechargeDailyBonus.test.js
```

预期：FAIL，当前仍返回 `bonusCredits` 且账户只保留三个字段。

- [ ] **步骤 3：实现纯函数**

`packageCreditMetrics` 返回：

```js
return {
  amountYuan,
  baseCredits: amountCents,
  dailyBonusCredits: nonNegativeInteger(item?.daily_bonus_credits),
  benefitDays: 30,
  creditsPerYuan: amountYuan > 0 ? Number((amountCents / amountYuan).toFixed(2)) : 0,
};
```

`normalizeCreditAccount` 保留旧字段并增加 camelCase 明细字段；非法数字归零，非法日期归 null。

- [ ] **步骤 4：运行测试验证通过**

运行：`node --test frontweb/test/billingDisplay.test.js frontweb/test/rechargeDailyBonus.test.js`

预期：全部 PASS。

- [ ] **步骤 5：Commit**

```powershell
git add frontweb/src/utils/rechargePresentation.js frontweb/src/utils/billingDisplay.js frontweb/test/billingDisplay.test.js frontweb/test/rechargeDailyBonus.test.js
git commit -m "feat: 适配每日赠送积分前端数据"
```

## 任务 7：修改管理员套餐配置与用户充值中心

**文件：**
- 修改：`frontweb/src/components/RechargePackageAdminPanel.vue`
- 修改：`frontweb/src/components/RechargePackageCard.vue`
- 修改：`frontweb/src/views/RechargeCenter.vue`
- 修改：`frontweb/test/rechargeDailyBonus.test.js`

- [ ] **步骤 1：先写失败的组件合同测试**

读取三个 Vue 文件并断言：

```js
test('管理员只编辑每日赠送且基础积分由售价派生', () => {
  assert.match(adminPanel, /基础积分（永久）/);
  assert.match(adminPanel, /:model-value="baseCreditsPreview"/);
  assert.match(adminPanel, /每日赠送积分/);
  assert.match(adminPanel, /daily_bonus_credits/);
  assert.doesNotMatch(adminPanel, /v-model="draft\.credits"/);
});

test('用户套餐卡明确展示30天每日赠送和当日清零', () => {
  assert.match(packageCard, /充值到账/);
  assert.match(packageCard, /永久积分/);
  assert.match(packageCard, /连续 30 天/);
  assert.match(packageCard, /次日 00:00 清零/);
  assert.doesNotMatch(packageCard, /额外赠送/);
});

test('会员有效期内套餐全部禁用但自定义充值不禁用', () => {
  assert.match(rechargeCenter, /:disabled="!rechargeConfig\.configured \|\| membership\.active"/);
  assert.match(rechargeCenter, /有效期内不可重复购买会员档/);
  assert.match(rechargeCenter, /:disabled="!rechargeConfig\.configured"/);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test frontweb/test/rechargeDailyBonus.test.js`

预期：FAIL，组件仍展示一次性额外赠送并允许编辑到账总积分。

- [ ] **步骤 3：修改管理员表单**

表单字段使用：

```vue
<label>
  <span>基础积分（永久）</span>
  <el-input-number :model-value="baseCreditsPreview" disabled />
</label>
<label>
  <span>每日赠送积分</span>
  <el-input-number v-model="draft.daily_bonus_credits" :min="0" :max="100000000" :step="1" />
</label>
<div class="recommend-note">支付成功后连续 30 个自然日赠送；每日未用积分于北京时间次日 00:00 清零。</div>
```

`toPayload` 只提交 `amount_yuan` 和 `daily_bonus_credits`，不再提交可篡改的 `credits`。预览对象由计算属性补入 `credits: baseCreditsPreview`。

- [ ] **步骤 4：修改套餐卡与充值中心**

套餐卡文案：

```vue
<span>充值到账</span><strong>{{ formatNumber(baseCredits) }} 永久积分</strong>
<span>每日赠送</span><strong>+{{ formatNumber(dailyBonusCredits) }}</strong>
<p class="daily-bonus-rule">连续 30 天 · 每日仅限当日使用 · 次日 00:00 清零</p>
```

充值中心加载套餐响应对象：

```js
const nextPackages = Array.isArray(packagePayload?.packages) ? packagePayload.packages : []
membership.value = packagePayload?.membership?.active
  ? packagePayload.membership
  : { active: false, ends_on: null }
```

套餐卡 `disabled` 增加 `membership.active`；`CustomRechargePanel` 不增加会员禁用条件。顶部余额增加“永久积分”和“今日赠送”明细。

- [ ] **步骤 5：运行前端测试和构建**

运行：

```powershell
cd frontweb
node --test test/rechargeDailyBonus.test.js test/billingDisplay.test.js
npm run build
```

预期：测试全部 PASS；Vite 构建退出 0。

- [ ] **步骤 6：Commit**

```powershell
git add frontweb/src/components/RechargePackageAdminPanel.vue frontweb/src/components/RechargePackageCard.vue frontweb/src/views/RechargeCenter.vue frontweb/test/rechargeDailyBonus.test.js
git commit -m "feat: 更新每日赠送充值界面"
```

## 任务 8：完整回归、设计状态更新和发布前交接

**文件：**
- 修改：`docs/plans/2026-08-11-daily-recharge-bonus-design.md`

- [ ] **步骤 1：运行完整后端测试**

运行：

```powershell
cd backend-node
npm test
```

预期：0 fail；Windows 不支持的既有符号链接测试只能以明确 skip 计入，不能出现新增 skip。

- [ ] **步骤 2：运行完整前端测试与构建**

运行：

```powershell
cd frontweb
node --test test/*.test.js
npm run build
```

预期：0 fail，构建退出 0。

- [ ] **步骤 3：运行账本关键回归和差异检查**

运行：

```powershell
cd backend-node
node --test test/creditLedger.test.js test/tenantCreditLedger.test.js test/tenantGenerationBilling.test.js test/videoBilling.test.js test/imageBilling.test.js test/text-generation-billing.test.js test/alipayRechargeDailyBenefit.test.js test/alipayRechargeRoutes.test.js
cd ..
git diff --check
git status --short
```

预期：全部 PASS；`git diff --check` 无输出；状态只包含本任务预期文件。

- [ ] **步骤 4：审计需求覆盖**

逐项核对并在设计文档“状态”下记录实际证据：

- 30 天上海自然日边界。
- 当日清零与惰性过期。
- 赠送优先、混合预扣。
- 同日退款、跨日退款、跨日确认。
- 同档/跨档购买门禁。
- 自定义充值可用。
- 旧待支付订单兼容。
- 支付回调幂等。
- 前端管理、套餐卡、余额明细。

- [ ] **步骤 5：Commit**

```powershell
git add docs/plans/2026-08-11-daily-recharge-bonus-design.md
git commit -m "docs: 记录每日赠送积分验证证据"
```

- [ ] **步骤 6：生产前只读核对，不执行部署**

在获得单独部署授权后才执行生产动作。授权前只读完成：

```text
1. SSH 读取实时 /opt/moli-drama/current 和 RELEASE_COMMIT。
2. 核对其他会话是否有未完成的同项目修改或候选。
3. 核对 deploy.lock、活动任务、数据库 quick_check、服务和 AI 音乐进程。
4. 从实时 current 克隆新候选，只移植本计划提交 allowlist。
5. 备份数据库并在候选副本验证迁移。
6. 执行共享审计器，确认 canvas-credit-callout-v1 未回退。
7. 仅使用 activate-protected-release.sh 执行受保护切换。
```

预期：本实现阶段不写生产数据库、不创建生产支付订单、不切换 `/opt/moli-drama/current`。

## 最终自检

- 规格覆盖：设计文档第 1 至 13 节均映射到任务 1 至 8。
- 数据合同一致：`daily_bonus_credits`、`benefit_days`、`benefit_version`、`membership_ends_on` 在后端、API 和前端命名一致。
- 时间合同一致：所有实现和测试均使用 `Asia/Shanghai` 自然日，权益固定 30 天。
- 结算合同一致：赠送优先；确认消费原日冻结额度；跨日退款不复活赠送。
- 兼容合同一致：旧已支付不变，旧待支付按旧快照，自定义充值和用户级旧账户不变。
- 发布边界一致：计划不授权生产写入、真实支付或部署。
