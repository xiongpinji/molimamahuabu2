# DJPSD 视频自动人脸处理修复

## 目标与边界

- 修复画布 `video-v1` 请求未启用 `params.auto_face_mask`，导致带人物参考图的视频任务触发人脸相关拦截的问题。
- 保留 `duration`、`aspect_ratio` 和参考图上传现有行为；不修改平台计费、供应商目录或模型价格。
- 供应商站点只负责生成。平台积分计费继续由本系统独立处理。
- 只有真实任务成功且结果视频可读取，才允许把修复发布到生产。

## 根因

`buildDjpsdOpenApiSubmitBody()` 使用 `Boolean(opts.auto_face_mask)`。画布生产入口没有传这个可选字段，`undefined` 被固定转换为 `false`，最终请求明确关闭了供应商的自动人脸处理。

修复为：未显式关闭时默认发送 `auto_face_mask: true`；底层调用方显式传 `false` 时仍可关闭。供应商 `strength` 未在画布提供自定义入口，继续使用其默认值 3；`aspect_ratio` 继续传递画布选择值。

## 测试驱动证据

1. 修改断言后先运行 `node --test backend-node/test/djpsdOpenApiVideo.test.js`：6/8 通过，两个失败都显示实际 `false`、期望 `true`。
2. 修改一行业务代码后重跑：8/8 通过。
3. 运行完整后端测试：667/667 通过，无失败、跳过或取消。

## 真实供应商验证

- 用户压缩包 SHA-256：`433F2AD7C60476FD019CF2B1E43846E4456F3B0DB793EBDFAD5D0510CE57AD69`。
- 人物参考图 `2.png` SHA-256：`EB6E8CB587BF5A41031D6526D40151001D1012DD11DA9F21CF1830C64009D441`。
- 压缩包 Python 文件里的 `API_KEY` 是非 ASCII 占位文本，不是真实 Key；未执行用户提供的 Python。真实验证只在生产服务器进程内读取后台已验证且启用的 DJPSD 配置，未输出或复制密钥。
- 请求模型：`video-v1`；10 秒；16:9；单张人物参考图；`auto_face_mask: true`。
- 任务 `325473`：请求受理，最终被供应商内容策略拒绝；供应商明确说明额度未扣除。该任务不计为可用性证明。
- 任务 `325780`：按上一任务错误建议改用不含真人指代的英文提示词；成功终态。结果文件读取为 HTTP 206、`video/mp4`，首个数据块 3067 字节。

结论：供应商支持该参数且真实人物参考视频可成功生成；本次故障的代码根因是平台适配器默认发送了 `false`。

## 发布验收

- [x] 定向回归测试通过。
- [x] 完整后端测试通过。
- [x] 真实供应商生成成功并验证结果文件。
- [x] 从生产实时 `/opt/moli-drama/current` 构建候选。
- [x] 共享受保护发布门禁、备份、活动任务、健康、日志和 AI 音乐进程检查通过。
- [x] 生产切换并回读生效代码。

## 生产发布记录

- 原 release：`/opt/moli-drama/releases/image-reference-runtime-hotfix-ad577bb-20260804T171850CST`。
- 新 release：`/opt/moli-drama/releases/djpsd-face-mask-eb588c0-20260804T184033CST`；从切换前实时 `current` 完整复制，只覆盖本任务的后端源码、测试和任务文档。
- 候选验证：DJPSD 视频专项 8/8；共享门禁 `canvas-credit-callout-v1` 源码与构建均通过；生产预检全部通过。
- 备份：`database-20260804T104113308Z.sqlite`，8,019,968 字节，SHA-256 `5d1b265a35295e2175163e0962cf2c39027911589c95b0e042baa9bfeb9316a6`，独立验证 `valid: true`、SQLite 完整性 `ok`。
- 切换：共享 `activate-protected-release.sh` 在部署锁和 CAS 检查下完成；切换前后四类活动任务均为 0。
- 上线回读：`current` 和主进程工作目录均指向新 release；服务 `active/running`、`NRestarts=0`；健康页和首页均为 HTTP 200；生产专项 8/8；近十分钟错误日志 0。
- AI 音乐隔离：服务进程和工作进程 PID 仍为 206874、206895，未被本次发布重启。
