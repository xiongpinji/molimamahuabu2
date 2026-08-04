# iCreat Seedance 2.0 Mini / Fast 接入

## 目标

- 接入 iCreat 视频模型 `bytedance/seedance-2-0-mini` 与 `bytedance/seedance-2-0-fast`。
- 使用用户提供的 Key 分别完成一次真实生成、等待成功终态并验证结果视频可读取。
- 只有真实验证通过、后台状态为 `verified` 且平台已配置有效积分价格的模型，才允许出现在画布前端目录。
- API Key 只写入生产后台配置，不进入源码、测试、任务文档或日志。

## 官方接口合同

来源：<https://icreat.ai/hub/docs/zh-CN/api/dev-docs.html>

- 提交：`POST https://api.icreat.ai/v1/task/submit/{model}`。
- 状态：`POST https://api.icreat.ai/v1/task/query-status`。
- 结果：`POST https://api.icreat.ai/v1/task/get-result`。
- 鉴权：`Authorization: Bearer <API Key>`。
- Fast / Mini 模型码分别为 `bytedance/seedance-2-0-fast`、`bytedance/seedance-2-0-mini`。
- 两个变体仅支持 `480p`、`720p`；时长为 4 到 15 秒整数或 `-1`。

## 验收门

- [x] 核对生产实时配置、目录和平台价格，不重复建模或覆盖无关配置。
- [x] Mini 真实生成成功且结果文件可读取。
- [x] Fast 真实生成成功且结果文件可读取。
- [x] 后端专项测试、669 项全量测试和前端生产构建通过。
- [x] 双轴代码复审通过。
- [x] 从实时生产 `current` 构建候选，共享门禁、备份、活动任务和生产预检通过。
- [x] 生产写入两模型配置并从公开模型、画布模型、计费模型三套目录回读可选择状态。
- [x] 切换后健康、日志与 AI 音乐隔离检查通过。

## 真实生成证据

- 充值前 Mini 任务 `task-019fcd3a-6e7f-7f96-9498-5aa7c911852a` 和 Fast 任务 `task-019fcd3a-cbae-7334-adad-1fa48452043b` 均因供应商余额不足失败，未作为模型开放证据。
- 充值后 Mini 任务 `task-019fcd42-7b56-7dda-9efd-3f768bb9faa9` 成功终态；结果地址按 Range 请求返回 HTTP 206、`video/mp4`，首个 4096 字节可读取。
- 充值后 Fast 任务 `task-019fcd45-b864-7b3a-8f71-56f441f8e522` 成功终态；结果地址按 Range 请求返回 HTTP 206、`video/mp4`，首个 4096 字节可读取。
- 真实验证脚本只通过临时环境变量读取 Key；任务 ID 和非敏感结果元数据进入本文，Key 未写入仓库或日志。

## 生产配置与前端目录

- 生产配置 ID `9`：供应商 `icreat`、协议 `icreat_task`、名称 `iCreat Seedance 2.0`，默认模型为 Mini，优先级 80，保持原 `xai` 默认供应商不变。
- 两模型状态均由同一已真实验证配置提供，配置为 `active + verified`；前端显示名分别为 `Seedance 2.0 Mini` 和 `Seedance 2.0 Fast`。
- 平台价格分别为 60 积分/秒；供应商费用与本站积分规则分离。4 秒生成在本站各预计扣除 240 积分。
- 能力目录：比例 `16:9`、`9:16`、`1:1`；清晰度 `480p`、`720p`；时长 4 到 15 秒；最多 9 张图片和 1 条音频参考；不声明视频参考能力。
- 生产实时回读确认：公开视频模型目录、画布模型目录、计费模型目录均同时包含两个模型，名称、价格、计费单位和能力一致。
- 独立验收浏览器访问正式站会进入登录页，未借用或读取用户浏览器凭据，因此没有虚报登录态下的点击验收；正式站根页面返回 HTTP 200，目录可见性由生产服务的三套实时目录回读证明。

## 修复与验证

- 首轮规格复审发现仅修复计费层仍不完整：视频创建和实际执行层会继续按通用 5 秒下限拒绝 iCreat 4 秒任务。先新增完整创建链失败用例，再仅对两个目标模型把创建、配置默认值和执行层下限放宽到 4 秒。
- 新回归测试覆盖 Mini / Fast 的 4 秒任务创建、240 积分预扣和进入供应商调用；本地目标测试组合 45/45 通过。
- 修复 `calculateCharge()` 原先把 iCreat 的官方 4 秒时长误判为无效的问题，仅对两个目标模型放宽下限为 4 秒，并新增 Mini / Fast 4 秒计费回归测试。
- 本地后端全量 `npm test` 退出码 0；前端生产 `npm run build` 通过；积分卡片审计确认源码和构建产物均保留 `canvas-credit-callout-v1`。
- 前端历史静态测试仍有 6 个与本次无关的 `canvasInteractionEntrypoints` 旧正则断言失败；本次没有修改前端源码，也没有把这些历史失败宣称为通过。
- 最终候选发布中专项测试 40/40 通过，生产预检、数据库完整性、模型价格检查和共享积分门禁通过。
- 首轮规格复审发现并拦截 4 秒创建链遗漏；修复后再次执行标准轴和规格轴复审，两轴均为 `APPROVE`、0 个剩余问题。

## 生产发布证据

- 配置写入前数据库备份：`/opt/moli-drama/shared/backups/database-20260804T150100134Z.sqlite`，8,040,448 字节，SHA-256 `18d2799bd5af34e102cd05ec1b2262309d0eea7bb52acae5f7346190705fadc4`，备份验证有效、完整性 `ok`。
- 最终切换前数据库备份：`/opt/moli-drama/shared/backups/database-20260804T153137182Z.sqlite`，8,040,448 字节，SHA-256 `d97bf4527f14bc9ac010255db875ebe644cc927692e2eecbeb33ea1c7d976369`，独立验证 `valid=true`、完整性 `ok`。
- 原生产 release：`/opt/moli-drama/releases/djpsd-face-mask-eb588c0-20260804T184033CST`。
- 首次接入 release：`/opt/moli-drama/releases/icreat-seedance-4s-20260804T230950CST`。
- 最终生产 release：`/opt/moli-drama/releases/icreat-seedance-4s-runtime-20260804T232722CST`，从切换时实时 `current` 克隆，仅覆盖本任务源码和测试，并通过共享保护激活器 CAS 切换。
- 发布后 `moli-drama.service` 为 `active`，`MainPID=2039716`、`NRestarts=0`，工作目录指向 `/opt/moli-drama/current/backend-node`；本机健康接口正常，正式站 HTTP 200，近十分钟错误日志为 0，数据库完整性 `ok`，图片和视频活动生成任务均为 0。
- AI 音乐 `server.js` / `worker.js` 仍为 2026-07-07 启动的 PID `206874` / `206895`，8787 端口继续监听，未被本次发布重启或修改。

## 当前结论

充值后的两次真实生成和结果文件读取均已通过；两个 iCreat Seedance 2.0 模型已经以管理员显示名、本站积分价格和已核实能力进入生产画布目录。4 秒任务已在计费、创建和执行三层修复并部署，当前生产服务与受保护积分卡片合同正常。
