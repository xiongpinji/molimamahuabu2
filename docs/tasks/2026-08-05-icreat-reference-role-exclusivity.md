# iCreat 视频参考角色互斥修复

## 目标

- 修复生产画布中 `Seedance 2.0 Mini` 多图参考生成被 iCreat 以 HTTP 400 拒绝的问题。
- 多图参考模式只发送 `reference_image`；首尾帧模式只发送 `first_frame` / `last_frame`。
- 后端必须兼容旧前端或其他调用方，即使收到混合字段也不得向 iCreat 发出互斥角色组合。
- 不改模型价格、积分规则、模型开放状态和供应商 Key。

## 现场错误

生产画布 `/canvas/48` 在多图参考模式连接两张图片后，iCreat 返回：

`frame image roles (first_frame/last_frame) and reference roles (reference_image/reference_video/reference_audio) are mutually exclusive scenarios and must not be mixed`

## 根因

1. 前端构造视频请求时，在没有显式 `first-frame` 槽位的多图参考模式下，错误地把第一张普通参考图回退为 `first_frame_url`。
2. iCreat 请求构造器随后同时追加帧角色和其余参考图角色，没有执行供应商要求的场景互斥。
3. 两层行为组合后，第一张图成为 `first_frame`，第二张图成为 `reference_image`，触发 HTTP 400。该问题与本站积分计费无关。

## 修复合同

- 前端只在素材被明确标记为 `first-frame` 时发送首帧字段；普通多图参考不再隐式生成首帧。
- iCreat 后端构造器检测到任一帧角色后，不再追加参考图片或参考音频；没有帧角色时保留多图片和音频参考能力。
- 该防线同时覆盖当前画布、旧客户端和其他后端调用入口。

## 验收门

- [x] 前端失败测试证明多图参考请求曾错误携带首帧字段。
- [x] 后端失败测试证明混合输入曾生成 `first_frame + reference_image`。
- [x] 最小修复后两条失败测试转绿。
- [x] 后端 iCreat 专项测试和前端自由画布专项测试通过。
- [x] 前端生产构建通过，`canvas-credit-callout-v1` 受保护积分卡片仍在源码与产物中。
- [x] 双轴复审通过。
- [x] 从生产实时 `current` 克隆候选并通过共享发布门禁。
- [x] 发布后服务健康、公开站点、错误日志、数据库和 AI 音乐隔离检查通过。

## 红绿证据

- 修复前后端回归用例实际角色为 `['first_frame', 'reference_image']`，预期仅 `['first_frame']`，测试失败。
- 修复前前端多参考用例仍包含 `image_url` / `first_frame_url`，预期不存在，测试失败。
- 修复后两条定向测试均退出码 0；iCreat 专项 13/13、前端自由画布专项 23/23、后端全量 670/670 通过，前端生产构建成功。
- 积分卡片源码与构建产物均检出 `canvas-credit-callout-v1` 和“本次预计扣除”文案。

## 实时生产基线合并

- 首个候选从实时 `current` 克隆后误用本地整文件覆盖前端工具文件，构建发现会丢失线上已有的 `isCanvasGeneratedResultAsset` 导出，候选未切换并废弃。
- 最终候选重新从当时实时 `current` `/opt/moli-drama/releases/icreat-seedance-4s-runtime-20260804T232722CST` 克隆，只在实时文件上合入本次最小语义差异，保留线上新增导出。
- 实时基线中的旧 `standaloneCanvasFreeNodeGeneration.test.js` 已存在缺失导出引用，测试文件在加载阶段失败；该基线问题不属于本次修改，最终候选没有覆盖它，也没有把它误报为通过。
- 最终候选新增独立前端互斥回归测试并通过 1/1，iCreat 后端专项通过 13/13，生产构建 1844 个模块成功。
- 按实时线上基线重新执行最终双轴复审：规格轴 `APPROVE`、0 项；标准轴 `APPROVE`、0 个硬违规，1 项仅关于本地文件子集镜像不能独立复跑的验证限制；完整候选已经在生产机实跑测试、构建与预检。
- 生产预检全部通过；`canvas-credit-callout-v1` 源码与构建合同均通过，数据库完整性和模型价格检查正常。
- 切换前备份 `/opt/moli-drama/shared/backups/database-20260805T010115321Z.sqlite`，8,048,640 字节，SHA-256 `4c70bd2c240e18311a729edda0492c4859a0767cf3a3b0bdbbb3bf3dc4ea98f7`，独立验证 `valid=true`、完整性 `ok`。
- 切换前 `async_tasks`、`image_generations`、`video_generations`、`video_merges` 四类活动任务均为 0。

## 生产发布回读

- 共享门禁将 `current` 从 `/opt/moli-drama/releases/icreat-seedance-4s-runtime-20260804T232722CST` 切换到 `/opt/moli-drama/releases/icreat-reference-roles-livebase-20260805T085755CST`，门禁退出码 0。
- 激活脚本在服务启动窗口内出现 4 次短暂的本机连接拒绝；服务随后正常就绪。最终 `moli-drama.service` 为 `active/running`，主进程 PID `2184113`，`NRestarts=0`，进程工作目录指向新 release。
- `/health` 返回 `status=ok`；`https://molimama.vip/` 与 `https://shiping.djpsd.com/` 均返回 HTTP 200。
- 自 `2026-08-05 09:08:50` 起服务没有 `err..alert` 日志，也没有 `uncaught`、`unhandled`、`fatal` 或 `exception` 命中。
- 生产数据库 `/opt/moli-drama/shared/data/drama_generator.db` 执行 `quick_check` 返回 `ok`；发布后 `async_tasks`、`image_generations`、`video_generations`、`video_merges` 四类活动任务仍均为 0。
- AI 音乐进程 PID 仍为 `206874`（server）和 `206895`（worker），发布前后未变化。
- 在生产 `current` 内复跑 iCreat 后端专项 13/13、前端多图参考互斥回归 1/1，全部通过。
- 生产源码回读确认后端 `if (!hasFrameRole)` 保护存在，前端首帧只取显式 `first-frame` 槽位，不再从普通参考图回退。
