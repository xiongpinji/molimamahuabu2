# 兑换码运营闭环设计与验收

日期：2026-07-24

## 目标与现状

现有实现已经具备 SHA-256 摘要存储、单租户防重复、次数上限、到期/停用校验，以及兑换入账和账本写入的事务一致性。本次只补齐运营所需的缺口：

- 管理员按相同积分、用途、有效期和单码使用次数批量签发兑换码。
- 管理员可签发平台通用码，或绑定到一个指定租户。
- 明文只出现在批量创建响应中；管理端收到后立即在浏览器本地生成 CSV 并清除明文引用。
- 管理员可调整有效期、启用或停用兑换码。
- 管理员可按兑换码查看兑换租户、兑换用户、兑换时间以及对应账本记录。
- 兑换身份只取认证后的 `req.tenant.id` 和 `req.user.id`，忽略请求体中的租户或用户字段。

## 解释与取舍

1. “仅一次明文导出”解释为：服务端仅在创建响应返回明文，不提供再次导出或找回接口；列表、更新、明细、数据库和日志均不包含明文。前端自动下载一次 CSV，不把明文写入本地存储。
2. `tenant_id` 为空的通用码在总次数允许时可被不同租户各兑换一次；非空的绑定码只允许目标租户兑换。非目标租户统一收到“兑换码不存在”，不能探测码的状态、有效期或绑定目标。
3. 不新增数据表或明文字段，只为 `redeem_codes` 增加可空的 `tenant_id`。现有 `redeem_code_usages` 和 `tenant_credit_adjustments` 足以完成查询。
4. 批量上限设为 500，避免单次响应持有过多敏感明文；批次在同一事务内完成，任一条失败则整批回滚。
5. 有效期允许改为新的合法时间或清空为永久；已经过期的兑换码不会自动恢复，除非管理员显式修改有效期且状态仍为 `active`。

## 接口设计

### `POST /billing/admin/redeem-codes/batch`

请求：

```json
{
  "quantity": 10,
  "tenant_id": null,
  "label": "七月活动",
  "credits": 100,
  "max_redemptions": 1,
  "expires_at": "2026-07-31T15:59:59.000Z"
}
```

响应中的 `items` 每项仅本次包含 `code`。服务端后续任何接口都只返回 `code_hint`。

`tenant_id=null` 表示平台通用；指定真实租户 ID 时，整个批次都绑定到该租户。

### `PUT /billing/admin/redeem-codes/:codeId`

支持部分更新：

- `status`: `active` 或 `disabled`
- `expires_at`: 合法日期，或 `null` 表示永久

至少提供一个字段，其他字段保持不变。

### `GET /billing/admin/redeem-codes/:codeId/usages`

返回该兑换码的兑换记录及对应积分账本：

- `tenant_id`
- `user_id`
- `credits`
- `redeemed_at`
- `ledger_id`
- `ledger_amount`
- `ledger_reason`
- `ledger_created_at`

管理端使用已加载的账号和租户列表将 ID 映射为邮箱和工作区名称，不扩大后端依赖。

## 安全不变量

- `redeem_codes.code_hash` 继续保存规范化兑换码的 SHA-256，不新增可逆密文或明文字段。
- `redeem_codes.tenant_id` 只保存允许兑换的目标租户 ID；列表可显示该 ID，但不显示明文或哈希。
- 错误、审计和普通请求日志不得记录批量创建响应或兑换码明文。
- 批量响应之外的所有服务与路由返回值均不得出现 `code` 或 `code_hash`。
- 租户兑换路由只信任认证中间件写入的用户和租户上下文。
- 同一 `code_id + tenant_id` 只能有一条使用记录；兑换次数占用、使用记录和账本入账保持同一事务。

## 验收标准

- [x] 批量创建 1 至 500 个唯一兑换码，批次失败时不留下部分记录。
- [x] 数据库只保存哈希和提示；列表、更新、明细均不返回明文或哈希。
- [x] 管理端收到批量响应后自动下载一次 CSV，随后只保留脱敏数据。
- [x] 无效批量数量、积分、次数或日期返回 `INVALID_REDEEM_CODE`。
- [x] 管理员可修改有效期、清空有效期、启用和停用兑换码。
- [x] 明细包含兑换用户、租户、时间及一一对应的兑换账本记录。
- [x] 同租户重复或竞态兑换不重复入账；不同租户可在总次数允许时分别兑换。
- [x] 平台通用码保持兼容；租户 A 绑定码只允许 A 兑换，租户 B 得到通用不存在错误且 usage/账本为零。
- [x] 请求体伪造的 `tenant_id` / `user_id` 不影响实际入账租户和兑换人。
- [x] 普通租户只能查询自身流水；兑换明细接口只允许平台管理员访问。
- [x] 新增目标测试先失败后通过。
- [x] 后端全量测试、前端相关测试、前端全量测试和生产构建通过。
- [x] `git diff --check` 通过，最终提交不包含任务外改动。

## 验证记录

- 后端目标：`node --test test/redeem-code-service.test.js test/redeem-code-routes.test.js test/routerGenerationRoutes.test.js`，19/19 通过。
- 后端全量：`node --test --test-reporter=dot test/*.test.js`，354/354 通过。
- 前端目标：`node --test test/redeem-admin-console.test.js`，7/7 通过。
- 前端全量：`node --test --test-reporter=dot test/*.test.js`，283/283 通过。
- 前端生产构建：`npm run build` 通过。
- 批量上限实测：500 个兑换码成功写入 500 条哈希记录。
