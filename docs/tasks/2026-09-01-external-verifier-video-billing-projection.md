# 视频失败重试账务关联的外部模型门禁投影修复

## 问题

PR #218 只在 `videoService` 中把已经创建的积分预扣记录绑定到对应异步任务，便于退款后的失败任务收敛并解除画布运行锁。共享 external verifier 仍把 `videoService` 的任意差异视为私人形象模型能力变化，因此错误要求重新执行两次付费验收。

## 边界

- 只把以下精确账务语句从私人形象能力投影中排除：
  - `UPDATE async_tasks SET credit_reservation_id = ?, model = ? WHERE id = ?`
  - 参数必须保持为 `reservation.id, billingModel, task.id`
- 不改变私人形象、Wan3、ToAPIs 客户端、参考素材或供应商请求的审计范围。
- 不修改生产数据库、外部模型证据、模型配置或 AI 音乐。
- shared verifier 的安装必须作为独立安全变更执行：先备份、校验旧/新哈希，原子替换，失败恢复。

## 验收

1. 精确账务关联变化使用过期私人形象证据仍可通过 verify-only。
2. 私人形象参考能力变化仍因证据过期而失败。
3. 共享 ToAPIs 客户端变化仍因证据过期而失败。
4. 既有 Wan3 专项投影仍通过。
5. `sharedExternalModelReleaseGuard.test.js` 全文件通过。

## 本地证据

- 新回归测试修复前失败，证明能够复现误判。
- 四项定向投影测试：4/4 通过。
- shared external verifier 全文件：144 通过、0 失败、3 跳过。
- 功能锁审计：通过；本变更没有修改任何已锁定业务保护路径。
