# 画布退款候选外部证据门禁范围修正

## 目标

- 通用视频失败退款结算变化不再触发 ToAPIs 私有头像真实生成证据刷新。
- ToAPIs 请求、能力、凭证、证据绑定和提交前门禁发生变化时，仍必须要求新鲜证据并失败关闭。
- 不增加跳过开关，不读取候选自报的豁免标记，不修改生产激活器的备份、活动任务、健康、CAS 或回滚检查。

## 根因

退款候选只修改了 `videoService.js` 的 `setVideoGenFailed`，将明确失败默认结算为退款。共享外部模型验证器把该通用计费函数包含在私有头像运行时投影中，因此把退款结算误判为私有头像生成能力变化，要求 24 小时内的真实供应商证据。

## 最小修改

- 私有头像运行时投影排除 `setVideoGenFailed`，与既有异步任务账务关联和 Wan3 专用签名投影规则保持一致。
- 其他 `videoService.js` 变化仍参与比较；已有“引用能力门禁变化必须刷新证据”的拒绝测试继续通过。
- 更新门禁轮换脚本中审核后的外部验证器 SHA-256，保持生产安装时精确字节校验。
- 线上共享门禁已由其他受保护发布独立推进；轮换脚本显式接受当前已核对的 activator/UI/external 三个共享哈希，同时继续拒绝未知哈希，避免把其他会话的升级回退掉。

## TDD 与验证

- 红灯：新增“通用失败退款结算不要求新鲜私有头像证据”测试，修改实现前失败。
- 绿灯：`sharedExternalModelReleaseGuard.test.js` 为 145 通过、0 失败、3 跳过。
- 轮换与回滚：`sharedReleaseGuardRotation.test.js` 为 40/40 通过。
- 增量范围和外部证据事务测试已运行；首次组合运行仅因审核哈希尚未更新而失败，更新为实际验证器哈希后轮换测试通过。
- 组合门禁回归：`node --test backend-node/test/sharedExternalModelReleaseGuard.test.js backend-node/test/sharedReleaseGuardRotation.test.js backend-node/test/sharedExternalEvidenceOnlyTransaction.test.js backend-node/test/incrementalReleaseScope.test.js` 为 232 通过、0 失败、3 跳过。
- 语法与字节校验：外部验证器 `node --check` 通过；轮换脚本 `bash -n` 通过；声明的外部验证器 SHA-256 与源文件一致。

## 发布边界

本文件记录代码候选，不表示共享生产门禁已经更新，也不表示退款候选已经上线。候选必须从实时 `/opt/moli-drama/current`（当前为 `canvas-video-parallel-pr220-20260902-a3b89193-r1`）重建；共享门禁升级作为独立安全变更审查和安装；安装成功后仍须重新执行退款候选 verify-only，再通过共享激活器切换。
