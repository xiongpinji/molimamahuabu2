# PR #217 一键转绘真实生成审核上下文一致性验证

## 范围与边界

- 范围：修复单镜真实生成入口与公开 `generation-gate` 对准备门禁使用不同可信资产读取上下文的问题。
- 边界：仅本地代码、测试和隔离验收数据诊断；不读取供应商 Key，不调用供应商，不付费，不写生产数据库，不推送，不合并，不部署。
- 既有付费验收状态与锁保持原样，不复用、不重试。

## 故障与根因证据

- 修复前，单镜产品生成入口返回 HTTP 409、`REDRAW_ASSET_REVIEW_REQUIRED`，供应商提交数保持为 0。
- 对同一隔离数据库、同一镜头做只读 A/B：真实生成上下文得到 45 项缺失；公开门禁上下文得到 `ok=true` 且 `missing=[]`。
- 差异收敛到路由装配：公开门禁向准备门禁传入 `assetReader.canRead/owns`，真实生成入口此前仅传 `storageRoot/canReadArtifact`。没有 `drama_id` 的已登记参考资产因缺少 `assetReader.owns` 被错误判为不可信。

## TDD 与实现

- 红测：新增路由测试，断言真实生成服务收到与公开门禁一致的 `preparationContext`；修复前因该字段为 `undefined` 按预期失败。
- 实现：路由内部新增唯一 `generationPreparationContext()`，真实生成与公开门禁共同复用；未改变审核规则、资产所有权规则、计费或供应商提交行为。
- 绿测：新增路由测试通过；路由测试 144/144，通过；生成测试 122 通过、1 跳过、0 失败；准备/审核/reference bundle 127/127，通过。相关测试合计 393 通过、1 跳过、0 失败。

## 完整回归状态

- 第一次完整后端回归：3823 项，3813 通过、9 跳过、1 失败。
- 唯一失败为功能锁要求本次 `backend-node/src/routes/redraw.js` 修改登记新鲜批准；不存在其他代码或行为回归失败。
- 本地 `HEAD^` 审计只覆盖最后一笔 5 文件提交，未覆盖 GitHub 合并引用相对 `main` 的整段 PR 差异，因此没有发现三项共享稳定性锁的当前批准仍指向“失败终态释放重复提交锁”。
- 功能锁与增量范围测试：62/62 通过。
- 独立功能锁真实差异审计：`ready=true`，`baseRef=HEAD^`，15 个变更路径，10 项受保护功能。
- 最终完整后端回归：3823 项，3814 通过、9 跳过、0 失败，退出码 0，耗时 1717648.3041 ms。

## Hosted CI 功能锁收口

- GitHub 合并引用相对最新 `origin/main` 的真实差异为 23 个文件；`stability.safe-provider-failover`、`stability.unknown-state-billing-reconciliation` 和 `stability.proactive-canary-and-public-evidence` 均实际触及 Fumin 运行时路径。
- 红测先将这三项锁的期望固定为：当前批准是 `pr-217-fumin-product-api-one-shot-acceptance`，`canvas-failed-generation-resubmit` 保留在批准历史；修复前 19 项功能锁测试中 4 项按预期失败。
- 实现只交换这三项锁中上述两份既有批准的当前位置和历史位置，并同步断言；未新增批准、未扩大授权、未修改运行时代码。
- 绿测：功能锁测试 19/19 通过；显式执行 `verify-feature-lock-manifest.js --base origin/main` 返回 `ready=true`、`changedPaths=23`、`protectedFeaturesFromBase=10`。
- 修复后定向回归：415 项，414 通过、1 跳过、0 失败；前端生产构建完成 1915 个模块，退出码 0。
- 修复后完整后端回归：3823 项，3814 通过、9 跳过、0 失败，退出码 0，耗时 1869159.474 ms。
- 本阶段不读取供应商 Key、不调用供应商、不付费、不写生产数据库、不合并、不部署。

## 付费样片人工拒绝后的本地修复

- 既有 5 秒样片的用户人工结论为不通过：角色未遵循批准身份参考，声音为中文且不等于批准英文台词。该样片继续保留为失败证据，不因自动 ASR 结果或本次代码修复改写结论。
- 根因一：参考包有声路径此前没有写入 `locale_pack`、`dialogue_snapshot_hash` 和 `prompt_hash`，因此成片后的目标语言及精确对白验证不会被触发。
- 根因二：成功视频下载阶段重新读取默认存储配置，忽略一键转绘运行时传入的隔离存储根，导致供应商成功文件落到仓库默认目录而不是隔离验收目录。
- 根因三：供应商提示词虽然包含英文对白，但身份约束只写“portrayed by”，没有把身份图明确限定为唯一人脸来源，也没有禁止动作参考提供人物身份。
- 修复后，参考包有声生成在任何积分预扣或供应商提交前要求目标语言包就绪，并把批准英文对白快照绑定到请求；错误语言或错误对白的成片保持 `needs_attention`，积分保持 `held`，不导入成品资产。
- 身份提示词按实际 Fumin `reference_image` 顺序逐张编号，动作视频只允许提供动作、走位、构图与镜头运动；目标国家及身份包哈希进入不可复用的请求快照。
- 成片下载使用调用方传入的运行时存储根；对应测试证明文件写入隔离目录。
- 本地验收启动器另行补齐任务 `quota` 缺失时的同次用量差值计费证据；该修改只位于保留的隔离验收状态目录，不属于产品运行时代码。

### 同次验证证据

- 参考包、单镜生成与视频请求快照关联回归：184 项，183 通过、1 跳过、0 失败。
- Fumin 客户端、参考素材、候选质量、原生对白/音频与任务恢复回归：72 项，72 通过、0 失败。
- 目标语言/精确对白失败冻结定向回归：1 项，1 通过、0 失败；验证器收到的批准文本精确为英文。
- 隔离验收启动器合同测试：6 项，6 通过、0 失败；未发出网络请求。
- `git diff --check` 通过；仅有工作区既有 LF/CRLF 转换提示。

### 2026-09-02 真实验收前置收口

- 用户决策：保留签名语言 Worker 作为完整一键转绘验收门禁；它只负责验证目标语言/对白/音频证据，不改变 Seedance 模型、线上模型目录或供应商配置。仅文件可读的技术样片不再视为产品验收通过。
- 当前产品工作树 `HEAD` 为 `82ddd3a0f5fee893360135674563bb89d690cde2`；本地新增的语言级请求兼容修复未改变任何线上模型配置、Key、供应商端点或价格合同。
- 隔离付费验收启动器的唯一一次授权尝试在产品 API 入口被 `REDRAW_LOCALE_VERIFIER_NOT_READY` 拦截；供应商生成 POST、上传、扣费均为 0，隔离数据库中的视频生成和积分预扣均为 0。该 r10 状态与全局防重锁保留，不重试、不复用。
- 本地验收器现增加 `assertPaidAcceptanceLocaleVerifierReady` 前置契约：缺少 `assertReady` 或 ready pack 无效时立即失败，并把 `en-US` 规范化为语言级 `en` 请求；本地零费用启动器在装配路由时先执行该检查。
- 零费用验证：语言 Worker 预检在当前 Windows 环境明确返回 `ready=false`、`REDRAW_LOCALE_VERIFIER_NOT_READY`；前端一键转绘启动器 17 项中 16 通过、1 跳过；未发起供应商请求。
- Worker 源码只读回归补充：协议、发布范围、校准、模型暂存和 server 测试合计 65 项，60 通过、5 跳过；完整发现运行另有 1 项因当前 Windows 解释器缺少锁定依赖 `jiwer==4.0.0` 而无法导入。未安装依赖、未创建新环境；生产 Worker 仍必须使用部署目录中预置且依赖完整的独立 venv。

### 2026-09-02 线上语言 Worker 只读预检

- SSH 只读回读的实时 current 为 `/opt/moli-drama/releases/canvas-failed-generation-resubmit-pr218-20260901-68a13b89-r3`，`RELEASE_COMMIT=68a13b899ff1a08854d434bedb00e4def890e649`。
- `/opt/moli-drama/shared/redraw-locale-verifier`、`verifier.env`、`worker.ready.json`、语言 Worker Unix socket 均不存在；`moli-redraw-locale-verifier.service` 为 `not-found/inactive`。current 仅携带受审计的部署说明和 systemd unit，不携带 shared venv、模型权重或 ready 状态。
- 结论：线上 ready attestation 不存在，完整语言验收门禁保持 `ready=false`。本轮只读检查未获取锁、未修改配置、未重启、未写生产数据库、未调用供应商或付费。
- 后续若要提供 Worker，必须作为独立运维阶段在 shared 目录准备依赖完整的 venv、签名 pack、模型/校准清单和离线 smoke，再重新执行只读预检；不得把 release 中的源码目录冒充为已 ready 的生产 Worker。

### 未完成边界

- 本次没有读取 Key、没有调用供应商、没有付费、没有重试旧任务、没有修改生产数据库、没有合并或部署。
- 当前仍未取得新的真实 Fumin 成片，因此不能宣称身份一致、英文对白、音轨、480p 或时长验收通过。下一次真实尝试必须在签名语言 Worker ready attestation 可用后，以当时全新 HEAD 重新授权；不得复用 r10 或旧 HEAD 授权。

### 2026-09-04 Hosted CI npm 审计网络韧性收口

- PR #217 的本地完整集成提交 `8c1dcc4da5599e63f40ac0182fd52816a6ee3665` 已快进推送到原 PR 分支；生产镜像、画布 E2E 与后端回归通过。
- Dependency Security 首次在后端 `npm audit`、唯一一次失败任务重跑在前端 `npm audit` 分别等待 5 分钟后返回官方审计端点网络超时；第二次运行中的后端审计已经成功，证明失败位置随外部网络请求移动，而不是固定依赖漏洞。
- 经用户明确批准，只为两个生产依赖审计步骤增加同一个 fail-closed 启动器：每个项目最多执行两次，只在明确的 audit 网络超时、endpoint error 或常见传输错误码出现时重试一次；漏洞退出码不重试、不改写，第二次网络失败仍返回失败。
- TDD 红灯先证明 workflow 仍直接调用 `npm audit`、启动器缺失、Windows `npm.cmd` 直接启动失败及脚本被 `.gitignore` 排除；绿灯合同测试为 9/9 通过，并锁定“漏洞证据与网络错误文本并存时也不得重试”。
- 修复后的本地真实审计使用 npm 官方 registry：前端 0 漏洞；后端报告 3 个 moderate 漏洞并按既有 `--audit-level=high` 合同退出 0。没有运行 `npm audit fix`，没有升级依赖或修改业务代码。
- 本阶段未读取供应商 Key、未调用供应商、未付费、未写生产数据库、未合并、未部署；新提交的 Hosted CI 结果必须另行等待，不由本地结果推导。

### 2026-09-04 当前 HEAD 单镜真实验收与结果地址解析收口

- PR #217 的新 HEAD `7760dd3bf7fd6291cac944806b930f78b16bcc1a` 已通过四组 Hosted CI；随后按用户“开始下一项”的明确指令，仅对 `shot-24.part-01` 执行一次 Fumin `seedance-2.0-mini`、480p、9:16、5 秒、有声英文真实生成。目标对白为 `The World Cup starts my fortune.`，输入固定为 1 张 Ethan Cole 身份图和 1 段无原音轨动作参考。
- 新隔离状态 `pr217-fumin-single-shot-20260904-r17-current-head` 的 preflight 通过且提交前任务数为 0。实际生成取得唯一供应商任务号并上传 2 份参考素材；轮询遇到 `FUMIN_EPISODE_RESULT_UNKNOWN` 后立即停止，状态冻结为 `needs_attention`，未重试、未再次查询供应商、未取得或验收结果文件。
- 本地对比发现整集适配器遗漏了同仓库既有 Fumin 客户端已经支持的 `content.video_url`、`data.content.video_url` 及对应 `content.video.url` 完成结果路径。由于 r17 未保存原始供应商响应，不能反向断言本次响应的精确字段，只能确认这是一个可复现的解析合同缺口，不能把 r17 报告为真实成片失败或验收通过。
- TDD 红灯使用 `data.content.video_url` 稳定复现相同未知结果；最小修复只补齐既有已验证结果路径，不修改模型、请求参数、定价或轮询次数。单文件 27/27、Fumin 六文件 104 tests / 102 pass / 0 fail / 2 Windows symlink skip、功能锁与发布范围 66/66 均通过。
- r17 保持不可复用；本次没有生产数据库写入、合并、部署或第二次供应商提交。修复后的真实成片、音轨、英文对白、角色一致性和完整 5 秒仍未验证，后续若再次真实提交必须使用新的隔离状态和新的明确授权。

### 2026-09-04 r18 真实样片与末镜英文钩子修订

- 在 `HEAD=43a64fef17ab07691b2e9ee5679742105d2ad390` 上使用全新隔离状态 `pr217-fumin-single-shot-20260904-r18-parser-fixed` 执行一次真实 Fumin `seedance-2.0-mini`、480p、9:16、5 秒、有声单镜生成；共上传 1 张 Ethan Cole 身份图和 1 段无原音轨动作参考，只创建 1 个供应商任务，未重试。
- 结果文件 `shot-24.part-01.mp4` 可读取，SHA-256 为 `6f2df9dcf4334b80d97475e990bc80edd90a1d2e45047267486f86ab9f74c58f`；媒体为 H.264、496x864、24 fps、5.088 秒，并含 AAC 双声道音轨。音频非静音，均方音量约 -25.4 dB、峰值约 -3.2 dB；人工画面审核确认角色为非亚洲面孔并与 Ethan Cole 身份方向一致。
- 该样片没有通过精确对白门禁。批准文本为 `The World Cup starts my fortune.`，两套离线 ASR 均识别为归一化后的 `The World Cups, my fortune.`；因此任务终态保持 `FUMIN_EPISODE_EXACT_DIALOGUE_FAILED`。媒体可读、时长、音轨与角色方向通过不能覆盖精确对白失败。
- 根因收敛到末镜英文钩子本身的相邻词界不稳定：`Cup starts` 在生成语音中容易连读为 `Cups`。最小修订为 `The World Cup is where my fortune begins.`，保留“世界杯是财富起点”的原意，同时消除该相邻辅音歧义；未修改模型、供应商配置、价格、角色或镜头结构。
- TDD 红灯先证明现有真实整集 fixture 仍使用旧末镜表达，结果为 27 项中 26 通过、1 失败；更新 fixture 后同组 27/27 通过，并新增断言禁止重新引入 `World Cup starts`。
- 基于不可变 r8 包重新编译的本地 r9 包位于 `.codex-staging/episode-blueprint-fumin-readiness-20260904-r9-dialogue-revision`：蓝图哈希保持 `f62842d9fbdb006d84b8b7b63ff05c09e7e74850a5d0a86ab5fa01bc607aae8d`，本地化哈希更新为 `3d1787c323f374787ae82a8656b0d992eb15b25c6f8aad1440de6559d45a01f0`，整包 SHA-256 为 `4c3bec472d2586b936f48b0a4c5de55c20f284d30cb6ce02494757b48bad10d8`。
- r9 零付费 preflight 通过：8 张身份参考、24 段动作参考、24 个生产包、28 个执行单元，目标 `en-US`、美国角色名、480p、9:16、有声合同均完整；末镜提示词和对白快照只包含新句。供应商 GET/POST、上传、生成和计费次数均为 0。
- r18 仍是失败证据，r9 只证明修订后的产品数据与本地生成合同就绪，不代表真实成片已经通过。新的真实样片必须绑定后续新 HEAD、使用全新隔离状态并取得单独明确授权；不得复用 r18。
