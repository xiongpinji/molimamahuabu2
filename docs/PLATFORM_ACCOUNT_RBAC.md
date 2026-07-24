# 平台账号权限与控制闭环

## 目标与边界

本阶段只补平台账号管理，不改租户成员角色、计费管理员令牌或业务资源归属规则。
普通业务账号继续使用 `user`；管理角色为 `admin`、`ops`、`support`、`read_only`。

现有登录令牌是无服务端会话的两小时 JWT，无法逐枚删除。因此强制退出采用账号级
`token_version`：签发时写入 JWT，每次受保护请求都与数据库当前版本比较。暂停账号、
变更平台角色或执行强制退出都会递增版本，使该账号此前签发的全部 JWT 立即失效。

旧库的 `platform_users.role` 带有只允许 `user/admin` 的 SQLite CHECK。为避免重建被多个
外键引用的用户表，本阶段新增 `platform_role` 保存扩展角色；API 仍统一对外返回 `role`。
暂停状态沿用现有 `status=disabled`，恢复为 `active`。

## 权限矩阵

| 能力 | admin | ops | support | read_only |
| --- | --- | --- | --- | --- |
| 查看账号列表 | 是 | 是 | 是 | 是 |
| 分配平台角色 | 是 | 否 | 否 | 否 |
| 暂停/恢复账号 | 是 | 是 | 否 | 否 |
| 强制账号退出 | 是 | 是 | 是 | 否 |

`user` 没有任何平台账号管理权限。角色判断只相信服务端从数据库读取的当前角色，
不相信前端隐藏按钮，也不直接相信 JWT 内可能过期的角色快照。

## API 与审计

- `GET /platform-admin/users`
- `PATCH /platform-admin/users/:userId/role`
- `PATCH /platform-admin/users/:userId/status`
- `POST /platform-admin/users/:userId/force-logout`

三个敏感动作分别记录：

- `platform.user.role_changed`
- `platform.user.status_changed`
- `platform.user.force_logout`

审计记录保存操作者、目标账号、结果和不含隐私的变更摘要。禁止暂停自己；禁止让系统
失去最后一个仍启用的 `admin`。

本地单用户业务接口继续沿用项目现有兼容策略；账号权限管理接口始终要求 Bearer 登录和上述
服务端权限中间件。既有模型计费、兑换码和调账接口仍使用独立管理员令牌，但公开模式下该
令牌必须与数据库当前 `admin` 角色共同通过，降级后的旧 JWT 不能借静态令牌继续操作。既有
账号管理入口还额外叠加细粒度权限中间件。调账操作者固定取 `req.user.id`，忽略请求体中的
同名伪造字段，并写入积分 adjustment。

## 验收标准

- [x] 四种管理角色严格符合权限矩阵，`user` 与越权角色得到 403。
- [x] 登录 JWT 带账号版本；版本不匹配、账号暂停或账号不存在均返回 401。
- [x] 暂停后旧 JWT 立即失效；恢复后旧 JWT 仍失效，必须重新登录。
- [x] 强制退出递增版本并使旧 JWT 立即失效。
- [x] 角色变更递增版本，旧角色令牌不能继续使用。
- [x] 每个敏感动作均由服务端鉴权并写入审计事件。
- [x] 不能暂停自己，不能暂停或降级最后一个启用的管理员。
- [x] 管理端仅展示当前角色允许的按钮，刷新后可读回账号角色与状态。
- [x] 后端目标测试与全量测试、前端相关与全量测试、生产构建、`git diff --check` 全部通过。
