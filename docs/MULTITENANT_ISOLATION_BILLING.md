# 多租户、数据隔离与计费一期设计

## 目标

在公开平台模式下，把现有“用户拥有项目、用户账户扣积分”升级为“用户属于租户、租户拥有项目、租户账户扣积分”。

一期必须形成以下闭环：

1. 注册用户自动获得一个个人租户，并成为该租户的 `owner`。
2. 登录用户可创建租户、查看自己的租户、管理租户成员。
3. API 通过 `X-Tenant-Id` 选择当前租户；未提供时使用个人租户。
4. 非成员或停用成员选择租户时统一返回 `404`，不泄露租户是否存在。
5. 项目及其派生资源按当前租户隔离；同一租户成员可协作，不同租户不可访问。
6. 生成任务按当前租户预占、确认或退回积分，操作幂等键只需在租户内唯一。
7. 本地单用户模式继续兼容原有调用，不强制租户头。

## 关键取舍

- `platform_users.role` 仍表示平台级角色；租户角色单独存放在 `tenant_members.role`，两者不能混用。
- `dramas.user_id` 保留为创建者/历史兼容字段，授权以 `dramas.tenant_id` 为准。
- 新建租户使用独立租户积分账户，不共享用户个人积分。
- 模型价格仍由平台管理员统一配置；一期不支持租户自定义价格。
- 本期“计费”指积分账户、预占、确认、退款与审计，不包含支付渠道、充值订单、套餐订阅、发票和税务。
- 旧数据迁移到对应用户的个人租户；无法确定租户的遗留记录不自动暴露给其他租户。

## 数据模型

### 租户与成员

- `tenants`
  - `id`
  - `name`
  - `slug`
  - `status`: `active | disabled`
  - `created_by`
  - `created_at`
  - `updated_at`
- `tenant_members`
  - `tenant_id`
  - `user_id`
  - `role`: `owner | admin | member`
  - `status`: `active | disabled`
  - `created_at`
  - `updated_at`

### 租户计费

- `tenant_credit_accounts`
- `tenant_usage_reservations`
- `tenant_credit_ledger`

租户预占幂等约束为 `(tenant_id, operation_key)`；结算通过全局唯一的预占记录 ID 完成。

### 租户归属字段

一期为下列表增加 `tenant_id`：

- `dramas`
- `image_generations`
- `video_generations`
- `async_tasks`
- `audit_events`

所有能够关联项目的派生资源，授权时通过项目租户归属校验。

## API

- `GET /api/tenants`
- `POST /api/tenants`
- `GET /api/tenants/:tenantId/members`
- `POST /api/tenants/:tenantId/members`
- `DELETE /api/tenants/:tenantId/members/:userId`
- `GET /api/billing/account` 返回当前租户账户

公开平台下的业务请求可携带：

```http
X-Tenant-Id: <tenant-id>
```

## 权限规则

- `owner`: 租户全部管理权限。
- `admin`: 可添加/移除普通成员，不可移除所有者。
- `member`: 可使用租户项目和额度，不可管理成员。
- 禁止移除租户最后一个所有者。
- 跨租户资源访问统一返回 `404`。

## 验收门槛

1. 两个租户可以存在相同 `operation_key`，余额互不影响。
2. 同一用户切换租户后，只看到当前租户项目和余额。
3. 同租户成员可读取项目；非成员读取同一项目得到 `404`。
4. 注册后个人租户、成员关系和零余额账户同时存在。
5. 生成成功只增加当前租户 `spent`；失败只退回当前租户 `available`。
6. 后端全量测试、前端全量测试和前端构建通过。

## 后续阶段

- 前端租户切换器和成员管理页。
- 充值订单、套餐、订阅、支付回调、发票与对账。
- 租户级并发配额、用量报表、预算告警和管理员冻结。
