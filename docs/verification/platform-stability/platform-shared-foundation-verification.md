# 公共运行底座完整验收证据

## 当前状态

- 阶段：阶段 1 本地候选验证完成，待代码审查与 Hosted CI
- 基线：`origin/main@897dfcbc28e3598fbc47e5731c61dfdeda2c9e80`
- 计划提交：`5061121ad6cdf671dc74eae07af2f06cdca47266`
- 实现提交：待本地提交后记录
- 范围：来源清单中精确 17 项 `module=shared` 功能；发布白名单精确 22 个文件
- 结论：本地适用链路与全量门禁已形成同批证据，但 Hosted CI、生产回读和生产写入/支付门禁尚未完成；17 项保持 `unverified`，不得提前写 `locked_pass`

## 生产只读边界

- 操作时 `current`：`/opt/moli-drama/releases/evidence-settings-pr175-20260821-eae7c5d3-r1`
- `moli-drama.service`：active
- 活动队列：5 个图片 processing 任务
- 结论：未切换生产、未写生产数据库、未付费、未启用 enforce、未触碰 AI 音乐；既有未激活候选未删除

## TDD 红灯与修复

1. 清单骨架：3 项中 1 项因阶段验收文件缺失失败；创建精确清单后 3/3 通过。
2. 认证：真实 Bearer token 在 `/auth/logout` 后仍可访问；修复为认证后退出并递增 token version，认证/RBAC/租户回归 51/51 通过。
3. 素材：Windows Junction 可把普通素材路径引向 storage root 外并返回 200；加入 canonical path、常规文件和根目录约束后，素材组 18 项为 17 pass、1 个文件 symlink 因 Windows EPERM 跳过，Junction 反例通过。
4. 积分与订单：同一幂等键可绑定不同模型/资源或套餐；加入语义身份冲突校验。首次全量随后发现同一生成请求在管理员调价后应复用原 reservation，修正为金额漂移复用原金额、账户/模型/资源变化仍冲突；账本相关复跑 41/41 通过。
5. HTTP 映射：套餐幂等冲突错误被映射为 500；修复为稳定 409，路由与服务回归 11/11 通过。
6. 功能锁：首次审计因触碰两个既有保护路径返回 `FEATURE_LOCKED`；按本轮获批计划写新批准原因和 7 项影响测试，功能锁审计现为 `ready=true`。

## 本地同批证据

- 认证/RBAC/租户：51/51
- 模型目录、价格、成本、公开 DTO 与线路证据失效：102/102
- 积分、订单、充值回调、对账及调价幂等兼容：相关组 47/47；兼容修正后聚焦组 41/41
- 前端 Node 全量：870/870，exit 0
- 前端生产构建：1902 modules，exit 0
- Playwright 真实本地后端：3/3，覆盖登录回跳、租户/素材/兑换/订单、角色权限/脱敏、390/1024/1440 视口，exit 0
- 最终结构、功能锁与范围聚焦测试：24/24
- 功能锁 CLI：`ready=true`，6 features，changed paths 14，基线保护锁 6
- 精确改动：changed 22、allowed 22、unexpected 0、missing 0
- 增量范围 CLI：`ready=true`，manifest 与实际改动均为相同 22 个文件；父目录使用 `origin/main@897dfcbc` 的临时 detached worktree，审计后已移除
- 平台验收结构：普通模式 exit 0，`valid=true`；`--require-complete` exit 1，当前 140 项中 124 项 `unverified`、16 项 `blocked`，属于预期阻断
- 后端全量：第一次运行因旧功能锁快照和调价幂等兼容各失败 1 项；修复后最终代码完整运行 2660 tests、2650 pass、0 fail、10 skip，exit 0
- 最终 Playwright 真实本地后端：3/3，exit 0；在账本兼容修正后重新执行

## 依赖与清理

- frontweb package-lock SHA256：`18BA50E97964D491CBD15CE54EB3FB65BE4470F04FA9F1D03845FB7B307CE82D`，依赖 Junction 目标 lock 同值
- backend-node package-lock SHA256：`8E47FA9060A8892CEA26799F1BD3988BABF48E89EC6B812A9BC6C4D42387AA14`，依赖 Junction 目标 lock 同值
- 未联网安装依赖；已移除两处依赖 Junction、Playwright `test-results`、后端测试 `data` 和两份全量日志，未删除依赖目标
- 未跟踪 node_modules、测试数据库、上传文件、Playwright trace 或截图

## 仍阻断

- Hosted CI 的真实 run URL 与合并提交 SHA
- 从届时实时 `main` 和实时 `/opt/moli-drama/current` 重建候选、共享门禁、生产回读与 AI 音乐隔离复核
- 生产写入与真实支付未在本阶段授权，不得以本地 SQLite、Mock 或浏览器夹具替代
