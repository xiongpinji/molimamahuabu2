# 通用一键转绘开发与验证记录

## 2026-09-10 当前工作树：G3 普通浏览器完整产品链已通过

真实 Chromium 从空隔离数据库完成登录、母本上传与分析、本地化、三镜参考准备、批量生成、候选 QA、整集发布和页面刷新恢复，最终 1/1 通过（约 2.6 分钟）。首次运行暴露真实产品缺陷：自动准备流水线生成的动作参考已由服务端完整校验并进入参考包，但前端仍强制要求仅属于手工上传路径的 import candidate，导致批量生成按钮可用却不发请求。现由参考包响应补充 `version_id`、`shot_updated_at`、`source_sha256`，前端仅在 owner-scoped 服务端参考包、当前版本、镜头 CAS、源片 SHA 和完整证据全部一致，且不存在待核对上传操作时，允许自动准备包独立放行；手工上传 pending/unknown、候选漂移和旧包继续 fail closed。

聚焦回归：动作参考与生成页面 184/184；参考包 service 与 API 聚焦回归通过。随后当前未提交工作树的完整后端为 6594 项中 6582 pass、12 skip、0 fail；完整前端 2471/2471；语言 Worker 127 项中 119 pass、8 个 Windows/条件分支 skip、0 fail；启动器、媒体管线、模型回退及蓝图状态矩阵 153 项中 151 pass、2 个 Windows symlink skip、0 fail；特性锁 `ready=true`；生产前端构建通过（1929 modules）。常规后端入口已用仓库内 guard 隔离多输入 HTTP 用例；四个封闭 SFC 测试夹具已同步源音频接缝审核纯模块。首次未显式开启假供应商的浏览器命令只得到 1 skipped，不计成功；显式隔离后默认端口运行因本地端口/复用污染在本地化轮询处 `Failed to fetch`，改用全新 loopback 前后端端口后完整浏览器产品链 1/1（约 2.6 分钟）。页面刷新过程中由组件主动取消的旧 `GET /motion-reference` 会产生 Chromium `ERR_ABORTED`，现只把这一精确只读取消从网络失败计数中排除，其它请求失败仍使浏览器门禁失败。全部使用本地假供应商与隔离数据库；零真实模型、Key、付费、生产数据库、部署、Git 提交或推送。

当前仍不能称正式交付：默认 `git diff --check` 会把索引/工作树均为 CRLF 的 `backend-node/src/services/ttsService.js` 新增行误报为尾空白；以 `cr-at-eol` 识别仓库既有换行约定后，全树检查退出 0，且该文件 549 行全部为 CRLF、无混合或裸 CR。精确 Git 归属收口、授权后的提交/推送与同 HEAD Hosted CI、以及真实任意用户视频质量验收仍未完成。

PR #217 当前只读远端状态：OPEN、非 Draft、mergeState CLEAN，head 分支 `codex/redraw-complete-delivery-20260901`，远端精确 HEAD 仍为 `8c49a90773a4311992e4eb9b6a5bc2c9acdfa4ed`。其四项 Hosted CI 均是 2026-09-05 对该旧 HEAD 的 SUCCESS，不能证明当前工作树；当前无 review/comment 阻断。后续若获授权，应把本地当前分支显式推送到该 PR head 分支，再以新 40 位 HEAD 重新核对四项检查。

## 2026-09-10 当前工作树：G2 长音频 v2 锁定与 Facts 精度链已接通

经人工完整段接缝确认、窗口人物映射、逐句审核和母本审核后的长音频 v2 蓝图，现可使用实际 owner/source/asset/file-SHA 可信上下文完成服务端锁定并物化 Facts；对白来源与投影保留亚毫秒小数，镜头、视觉范围及旧 v1 路径仍保持整数约束。前端已移除过时的 review-only 硬阻断，真实组件会先保存最新 CAS，再重新计算阻断条件并调用锁定 API；只有收到所属作品的 `locked` 回执才允许进入本地化。

本轮本地证据：v2 实际组件 66/66；相邻前端审核回归 97/97；后端 v2、蓝图、修订、边界、来源证据与融合组合 242 项中 241 通过、1 项既有平台跳过；G2 分窗、任务绑定、接缝、恢复、v2、Facts 与来源重读总门禁 511 项中 510 通过、1 项既有平台跳过；特性锁 61/61；生产构建通过（1929 modules）。定向 diff-check 无错误，仅有 Git 的 LF/CRLF 提示。全部为本地合成证据，不代表真实 ASR、真实任意视频浏览器验收、Hosted CI、合并或生产交付；零供应商、付费、Key、生产数据库、SSH、部署和 Git 写入。下一步进入 G3 多输入/资源合同与真实浏览器主线收口。

## 2026-09-10 当前工作树：G2 人工接缝确认与同任务恢复已接通

长视频分窗对白发生内容冲突时，页面会读取 owner-scoped 持久候选，精确列出真正冲突的接缝，并要求用户选择前窗或后窗的一整段原文；请求不包含任何裁剪端点。选择先登记为带 SHA 的 task-owned v2 证据，随后由独立恢复端点 CAS 领取原分析任务和原 held reservation，跳过第二次 ASR，继续 Native、Fusion、Blueprint 写入。页面重载时可读取 `resume_pending` 并安全续行；语言冲突仍保持阻断。

本地证据：后端核心接缝/恢复组合 37/37，新增聚焦成功路径 2/2，路由/纯解析 4/4；前端接缝决策/API 3/3；生产构建通过（1929 modules）。全部使用合成源字节、合成 Worker/Native/Fusion，不是识别质量或真实用户视频验收；零真实供应商、付费、生产数据库、部署和 Git 写入。下一步进入 G2 v2 锁定/Facts 精度下游与剩余总门禁，完整产品目标继续 ACTIVE。

## 2026-09-10 前序工作树：完整段人工接缝选择解析器

同日继续完成 owner-scoped POST 与可恢复中间态：服务端先哈希复核源，再以 candidate/work/task 双 CAS 和 held reservation 约束将人工 v2 证据写回原 task；work/task 保持 `needs_attention`，task result 进入 `resume_pending`。响应丢失后的完全相同提交零写入返回同一回执，改变选择则 stale。正式 route factory 已进入测试，不接受客户端 owner/model/reservation。

随后完成 Orchestrator 原子 claim：只有精确 `resume_pending`、独立重算有效的人工 v2、同 owner/task/candidate/new CAS、同一 held reservation/model 才能把原 work/task CAS 为 `analyzing/processing`。durable payload 保留，重复领取 stale；任务与 reservation 行数不变，ASR/Native/Fusion 调用数不增加。合并候选 + 决策最终 36/36，fail/skip/cancel/todo 0。

人工 v2 validator 的原始 RED 为 4/3/1，旧 validator 只能重算自动聚合；加入人工决策重算分支后 4/4，三类篡改均拒绝。状态写入口原始 RED 为缺少导出，加入幂等反例后第二次 RED 精确落在旧只读解析器拒绝 `resume_pending`；最终聚焦真实 handler/SQLite 1/1，候选完整套件 32/32。只读 GET 历史“同路径无 POST”断言按新产品阶段准确变红，再锁定 GET 在初始化前、唯一 POST 在初始化后，聚焦 1/1。

新建 `redrawSourceAudioSeamDecision.test.js` 并按 TDD 实现 `resolveSourceAudioSeamDecision`。原始 RED 2/0/2；首轮 GREEN 后通过新增反例发现并修复“物理来源窗口错误充当逻辑 commit owner”。最终新解析器 + 原窗口聚合 51/51；原候选持久化 + owner-scoped 只读审核 251/251，均 fail/skip/cancel/todo 0。

解析器只接受实际冲突接缝的一侧完整来源，拒绝任意裁剪、缺失候选 SHA、伪窗口、部分选择和语言冲突；保留全部原始 Worker 回执、未选来源绑定及亚毫秒时标。当前已有 POST、数据库 CAS 和 Orchestrator 独占领取，但还没有 Native/Fusion/Blueprint 后半程或页面控件，因此不能声称接缝恢复、完整 G2 或产品交付已经完成。零真实模型、供应商、付费、生产、部署或 Git 写入。

## 2026-09-10 当前工作树：审核计划到防重运行链复核

以当前工作树直接运行计划中的聚焦入口：`redrawExecutionQueue + PlanReview + PlanPreview` 为 217/217，前端 `ExecutionQueue + PlanReview` 为 28/28，`redrawExecutionRun` 为 104/104，真实 Vue `ExecutionRunLifecycle` 为 114/114；均 native 0、无失败、跳过、取消或 todo。覆盖审核快照/队列 owner 与损坏拒绝、重复登记、真实双 SQLite 进程竞争、唯一 run、暂停 revision 竞争、重挂/新模块 pending 与 unknown 防重及显式恢复。计数存在导入重叠，不相加作为唯一覆盖率。

首次 `redrawExecutionRun` 为 104/103/1，唯一失败是 Windows 创建进程时自动补入 `HOMEDRIVE/HOMEPATH/LOGONSERVER/SYSTEMDRIVE/USERDOMAIN/USERNAME/USERPROFILE`，与传入最小环境的键集合断言冲突。独立原生 `spawnSync` 探针用仅八项环境稳定得到同一七项补入，确认不是业务服务、SQLite 或供应商失败。仅在正式测试的 `childEnvironment` 为 Windows 明确提供合成身份与当前私有临时目录，保留 `SystemRoot/WINDIR`；Linux 期望不变。完整复跑 104/104，真实子进程的默认配置、默认数据库和网络拒绝测试亦通过。未修改产品源码、模型或运行状态。

本证据只证明本地计划审核→不可变队列→运行记录/暂停恢复连接仍有效；未触发 advance 的真实 provider transport，不代表媒体内容质量、完整多输入、Hosted CI 或交付完成。HEAD 仍为 `8c49a90773a4311992e4eb9b6a5bc2c9acdfa4ed`，正式 Run 测试文件当前尚未跟踪；后续提交前须把它与全部主线变更一起纳入精确版本验证。零 Key、供应商、付费、生产、部署或 Git 写入。

## 2026-09-10 当前：G2.SEAM_READ 已本地双审收口

已注册 owner-scoped `GET /redraw/works/:id/source-audio-seam-review`：重建原窗口、复算候选 SHA，绑定当前作品/实际分析任务/源资产/原 held reservation，实际 hash 源文件并在 await 后复查快照。返回完整原文、小数时标与后续 CAS 令牌，不写库、不创建分析任务、不结算/重试，也不伪造成功蓝图。用户已采用的“完整保留识别段、冲突人工确认、不新增语音模型”保持不变。

原始 TDD RED 209/0/209 是三个缺少导出与路由注册造成，不能算 209 个独立缺陷。首版 209/209 后，独立 SPEC 找到真实 P1：GET 后置于全局租户初始化，读取也可能 INSERT 个人租户/成员。新增真实注册块与认证/租户链反例后 RED 220/210/10，观察到实际两行 INSERT；仅将本 GET 前移到认证后、初始化前并 SELECT 已有 active tenant/member，邻近 blueprint 初始化不改。最终 220/220，native 0、无 skip/cancel/todo/timeout；回执 `C:/Users/canqu/AppData/Local/Temp/g2r-6e9dc665ad354ab8a0e676245a8c3159/receipt.json` SHA `6141fb9c4785472bef9638837dd4800ed46873d151cb833b59550091accacdeb`。

最终三产品 SHA：SourceAudio `46eb212c4ef50ad91adf65d8812b36b08f3a76a8e5e6a65e60f435c2b37e9615`，redraw handler `2ebc9b8b3155220cbcafc6879f1c011fc1ac1c3be797c7d7f84d7a418d8c70c9`，index `8864316280288bd6215085eb2e4ae6dd2ac3025189d1ed96b8bb81967a7cd0ff`；新测试 `ad734cb8938a7d082b4d6efcfaf0c1fa9e3f4ebbbcb05f0dec2de0c54a6b83ca`。基线到收口只有这三个 backend src 文件变化；保留其他既有脏改动，未创建工作树或提交。

最终源码相邻回归与 receipt SHA：

- v2 草稿 57/57：`edfaf127fb3aeee6d6a2578973840d1d5e4d571361b6d6caeba2840a77ef47f6`。
- seam 持久候选 31/31：`5978a927e22b28a22e9a203203bdffa9f9336c963295bd8f6cb7f827fd6c5d2c`。
- task binding 48/48：`8697d48e9ad65bc465da65f79ed4974bf6869203b2b7f88c2918bef2a8d2734d`。
- window aggregation 49/49：`fa8afb28b96fb46491468760379cf56695ebaa47c2da7777197c5a21cc6ca13a`。
- 功能锁 61/61：`e4548b57db22f42e2ae18dbbb1c1b35985617364e8f39f7164cac21049c7f5b4`。

上述均 native 0、输入无漂移且无 skip/cancel/todo/timeout，计数不相加为去重覆盖。五业务套各 863 输入、feature 145 输入，共 971 去重引用已复算；五业务进程 PID 52516/49760/17112/63952/43552 已单独确认退出。feature 没有 PID 字段，以已完成启动器/native WaitForExit 留证，不把 `activities_remaining=[]` 当作 OS 审计。精确已跟踪范围 diff-check=0，Git LF/CRLF 提示非失败；其他 ttsService 既有空白不在本片范围。

根专用入口补足旧 CJS 观测盲点：当前 node_modules 为指向既有依赖目录的 Junction，现固定 69 包/501 文件并核对完整 require.cache 实路径；清单 SHA `5fdf944ae111e79ca8494a22fdb1afe8d7064f22b42029380c6a33f280786b36`。五业务回执 guard/closure true、uncovered=[]；它不是 OS 沙箱，也不覆盖 ESM/已移除缓存/原生内部文件访问。220 项使用真实聚合、内存 SQLite、合成源文件、实际 handler，以及 VM 搭载真实注册块/中间件；不是完整 HTTP/浏览器或真实 ASR 验收。候选 SHA 证明可信存储生产者回执的一致性，不是重 ASR/外部签名系统。

独立 `g2_seam_read_spec` 复审 PASS → 不同 `g2_seam_read_quality` APPROVE，必要问题 0；审查者未运行测试。根索引 `.codex-staging/g2-seam-read-verification-20260909-r1.json`。本次只对实际命中的五项功能锁追加授权历史，不改 protectedPaths/requiredTests/evidence；功能锁回退测试完整保留旧规范 JSON。

下一项：人工完整段选择、同任务同 reservation 显式继续，再接 v2 锁定/Facts；不重发原“开始分析”，不新增 ASR/任务/冻结，unknown 不允许通过人审重试或释放。本片不代表 G2 或通用一键转绘完整交付，主线仍未完成。HEAD `8c49a90773a4311992e4eb9b6a5bc2c9acdfa4ed`，按未提交工作树精确 SHA 留证，不借旧 CI。全程零真实 Worker/供应商/付费/Key/外部联网/安装/SSH/生产/Git 写入，未合并、部署或运行 Hosted CI。

## 2026-09-09 当前：G2.V2_REVIEW_UI 已本地双审收口

用户采用“完整保留识别出的对白段，不自动裁句；接缝内容冲突时停止并交给现有对白审核，不新增语音模型”。本片完成合法长音频 v2 蓝图 DTO 的页面无损审核：整段来源/修订端点保持原 JS Number，十进制移位显示与回写不经三位舍入；编辑、迁移后仍追溯唯一已保存原句。来源必须同时匹配已保存镜头/对白、resolved DTO、源身份、manifest/asset/SHA；窗口声音人物独立列出并显式映射，不自动并人。审核保存可用，v2 锁定/Facts 仍阻断；已锁定、源/CAS 漂移、迟到回执和卸载继续拒绝。

根正式 RED 66 项中 34 pass/32 fail，native 1，输入不变；目录 `.codex-staging/g2-v2-review-ui-20260909-r1-focused-formal-red-85ab96ba6b414402a82a2b7459e39e31`，receipt SHA `20670bfa66954310175c888a9696f55daf2df03061d849abecadc88d8a7ae27f`。第一版 64/66 两失败：真实 Vue select 指令需要宿主 options 接口，以及卸载后非响应式 disposed 未使 canEdit 缓存失效。仅补宿主接口、disposed 改 ref 并保留/增强断言后，最终 66/66。产品不改 v1 整数/三位秒、镜头整数切点和既有 trim/500 字符限制。

本片固定 Utils SHA `971190c121cd7dbff2341e90bb2717a2e4cba96c7073e7da1821f58e1ba2f761`，Panel `83a701f108c4826bbc354ffe07ab64398664bf3ecc53dbd30f9083d9ba485d17`，新测试 `755d24704082cd7c9963bb00d2f490dc31bce804f7d0ccad13c5dedf5cca4e5b`。最终定向目录 `.codex-staging/g2-v2-review-ui-20260909-r1-focused-final-green-324d1a806c1a42ed8547aefb509a4976`，receipt SHA `eb6bd7ce20b1d7c2af0b12e04718f8149f893ea679fa145d8fc0b3017bdbe9d5`。四旧前端分别 12/12、26/26、34/34、40/40；本轮后端 v2 57/57、correction 58/58、boundary 60/60、speaker 22/22。旧 speaker 唯一前置失败是测试宿主遗漏已有 loading/workspaceError；只补两 ref 和拒绝控制，保留旧断言，其他三套原文件未变。

功能锁仅追加实际命中的 `redraw.episode-blueprint-first`，未改 canary；回退本项后整个旧清单规范 JSON SHA `3908b3efb5e1a7a7680cb93ebf43dbe643960498a018cd9f4d09a48f61b96b57` 精确恢复。原登记失败记录保留。最终 60/60，目录 `.codex-staging/g4-unit-quote-root-feature-20260907-r1-g2-v2-ui-final-green-5164efc5671940d1a9f2e061036fa717`，receipt SHA `199f39d7b6de92d3f6f4b507f51d4a33b932e80a8e6df6b90a35918dd4a82187`。

十套最终运行 native 0、无 skip/cancel/todo/timeout；计数有重叠，不相加为去重覆盖。五前端各 97 来源引用、后端分别 550/552/552/553、功能锁 145 引用在收口复算无漂移；九个已知测试 PID 已退出，feature activities_remaining=[]。前端 stderr 均空；后端只有既有空库 migration/ensure 提示，不是 TAP 测试跳过。精确已跟踪范围 diff-check=0；全树既有 ttsService 尾空白不在本片范围。

独立 `g2_v2_ui_spec` SPEC PASS → 不同 `g2_v2_ui_quality` QUALITY PASS，必要问题 0；两位审查者只读证据、未运行测试。根索引 `.codex-staging/g2-v2-review-ui-verification-20260909-r1.json`。HEAD 仍 `8c49a90773a4311992e4eb9b6a5bc2c9acdfa4ed`，未提交工作树按精确来源 SHA 留证，不借旧 CI。真实 SFC script/template 编译/渲染主要通过组件方法与状态驱动，未完成浏览器 input/change/click 全链；Node 权限/API guard 不是 OS 沙箱，不冒称真实 ASR 或用户验收。

下一片：读取所属任务的持久 seam 候选、人工完整段选择、同任务同 reservation 显式继续；随后 v2 锁定/Facts 精度接入。已采用的人工确认选择不重复索要；unknown 不允许通过人审重试/释放。完整 G2/G3/G5/G6、默认集成回归和真实多输入交付仍须完成，产品目标 ACTIVE。本片零真实 Worker/供应商/付费/Key/外部联网/安装/生产/Git 写入，未合并、部署或运行 Hosted CI。

## 2026-09-09 前序：G2.V2_REVIEW 后端已本地双审收口

沿已批准“完整保留识别段，冲突人工确认、不新增模型”，仅实现成功长音频 v2 的后端审核消费链：独立重建校验 → AnalysisWindow/Native 提示 → 实际 Fusion → 原 v1 蓝图 → Workflow 创建/保存 → SourceDialogue 重读。服务端按 owner/work/source/实际资产文件 SHA 建立私有上下文，仅对应对白保留原始小数时标和窗口 speaker。原窗口 JSON 与原文不改，显示沿既有 trim；视觉/镜头时间、v1 整数与 reviewer 规则不放宽。v2 当前仍明确 review-only，不物化 Facts 或生成。

根原始 RED 50/15/35（native 1），`C:/Users/canqu/AppData/Local/Temp/g2v-194166f1ca834b51b15307af30c1abb3`，receipt SHA `de225e553acd5a2f1ab57b339bc2964a6f319d65e78b38e5f08631124e1c6618`。初版 50/48/2 的两失败是合成正例缺少既有必需 reviewer，原日志保留；只各补缺字段拒绝断言和合成人审字段后 50/50，未改产品审核规则。

独立 SPEC 发现来源降级绕过：客户端将 kind 改 subtitle、删除原音频并重写 refs、替换为已知 v1 资产，均可把既有整数时标/已映射 v2 草稿保存后锁定。新增正式 RED 55/52/3，`C:/Users/canqu/AppData/Local/Temp/g2v-3472238bee2f42b4bf812edc07d6ad0e`，receipt SHA `4063a96fd9ea01d340eedcb812c2f8b3537df4da4251a3d4a3a335f5b01edd2a`；三路径均实际到达 save/lock 而未拒绝，非基础设施错误。仅修 SourceDialogue 按真实 metadata 识别 v2、saveDraft 在 owner/current/CAS 后保留 current 的可信 source/ref/asset/SHA/kind。内部新分析新资产仍可建 revision 2，不按 work 全历史封禁。

P1 修复阶段定向 55/55，`C:/Users/canqu/AppData/Local/Temp/g2v-311d895ec91c43b1afe4b61e204883fd`，receipt SHA `cf78c4a9d9efadb08152ca1046a9b93c2b4b0c2b68a054c34afa45302d4b5dbc`，测试 SHA `88cdde32ab907d61a8bd17449f8b98e78d34ee315ca46c525e5df9ccee3ccdf2`；该阶段回归通过，原始日志保留。随后不同 QUALITY 指出两项 P2：多句修订会重复重建全轨可信 context；review-only 错误未进入路由业务分类，误报 500。新增真实构造计数与真实 handler 测试，正式 RED 57/55/2：`C:/Users/canqu/AppData/Local/Temp/g2v-291578228e714693ae98f2bdec575f00`，receipt SHA `390a5bbc895e483e6ef09d6ec2526507991f71778a885f84f625301103992846`；分别为 2≠1、500≠409，非环境错误。

最终仅增加调用内按 ref 缓存并将新本地错误码归入 `BLUEPRINT_AUDIO_V2_REVIEW_ONLY`，保留真实资产验证及逐句原始锚点校验，不改路由产品代码、不放开锁定。定向 GREEN 57/57：`C:/Users/canqu/AppData/Local/Temp/g2v-654debb336394ad482a95804323a87b2`，receipt SHA `6dc0f5ce2408834944942ce6fcc981d036007ec87f568722ce8e6ad064354afe`，测试 SHA `ef2fe8a4d8559edb47d7e0552f6b67629b55891dd0d34e5d7740c6bd7f8c83e5`。SourceDialogue 最终 SHA `b94ec415d07f9408424218d84bd483587e29a86743da98b9993035ccd4c615af`，Workflow `c31f872d129d5f135cd8e76ab67af717824a107752c384a3e5e9774e0305d0ff`。根逆向最小差异复算准确恢复质量修复前两服务和正式 RED 测试 SHA。

最终源码回归：SourceDialogue 70/70、对白修订 58/58、边界修订 60/60、Fusion 12/12、AnalysisWindow 12/12、Blueprint 16/16、speaker 22/22、任务绑定 48/48、seam 31/31、aggregate 49/49、功能锁 59/59。各套 native 0、无 skip/cancel/todo/timeout，计数不相加作去重覆盖；定向 source/guard/closure true，550 输入根复算零漂移。11 个具名测试运行对应 10 个不同 PID（系统复用一个 PID），最终均无存活进程；功能锁原生结束且 activities_remaining=[]。普通 Node guard 不是 OS/文件系统沙箱；aggregate 未声明模块闭包覆盖。旧 SourceAudio 的 37 pass/1 POSIX skip 属前序证据，本片未重跑，不列作本轮通过。

独立最终 `g2_v2_review_spec_final` SPEC PASS→不同的 `g2_v2_review_quality` QUALITY APPROVE，P1/P2 已关闭、必要问题 0；审查者只读现有回执，没有自行运行测试。根收口 `.codex-staging/g2-v2-review-verification-20260909-r1.json`。当前 HEAD 仍 `8c49a90773a4311992e4eb9b6a5bc2c9acdfa4ed`，工作树未提交；本片以来源 SHA 为准，不借旧 CI。精确已跟踪文件 diff-check=0；全树既有 ttsService 尾空白不在本片范围，不声称全树检查通过。

尚未完成：前端无损时间编辑/窗口人物映射、持久 seam 候选的人审 API/完整段选择、同任务同 reservation 显式继续、v2 锁定/Facts 下游精度验证。完整 G2 与产品目标继续 ACTIVE；不把合成 outer Audio/Vision、真实内部服务测试当作真实识别或用户验收。零真实 Worker/供应商/付费/Key/外部联网/生产/Git 写入，未合并、部署或运行 Hosted CI。

## 2026-09-09 前序：G2.SEAM_CANDIDATE 已本地双审收口

用户已采用“完整保留识别段，冲突人工确认”。本片只修复候选丢失：SourceAudio 全窗/全轨与源 CAS 通过后保存完整非成功诊断；当前异常链通过私有 WeakMap 绑定原始候选，Orchestrator 事务内再次核对真实任务与源，写入所属任务 result，保留 held，不创建成功资产/蓝图，不调用视觉或融合。内部 source-audio UUID 与实际 async task ID 分开，候选完整 SHA 不代替未来人审的独立验证。

根正式 RED 27/18/9（native 1），目录 `C:/Users/canqu/AppData/Local/Temp/g2s-ab657295e1944302b17a927cdbbf2667`；最终 GREEN 31/31（native 0），目录 `C:/Users/canqu/AppData/Local/Temp/g2s-9c1c60c705024d4a9d4dd9eafd2f757c`，receipt SHA `e81cf59e58a5e331ff093355d3a2a9c6ffd101ad4d68a4d9098e9697d4b5a2ed`。后加 4 个 source owner/SHA 事务边界用例是覆盖补充，不冒称另一个已复现缺陷。原 27 断言保持。源 SourceAudio SHA `846cedb0f424a23fe02ec9086e132d9cd0e2d5135ed6fbb527ede36618daef16`，Orchestrator `6bdc83cff8704b982160e66346fe2174157a7559cf77f14b5573a30c62c85108`，31 例测试 `3d1ef880f1e2dedd585c8ef444ea93e430054bb85713d42c1620ce6c4db81eb4`。

当前相邻回归：任务绑定 48/48、聚合 49/49、旧音频 37 pass/0 fail/1 个既有 POSIX skip，当前代码功能锁 58/58；均 native 0，无超时/输入漂移，定向及绑定 closure true。stderr 仅既有空库 migration/ensure 顺序提示，不是测试 skip；真正的平台 skip 另列。550 项定向来源闭包零漂移，四个已知测试 PID 退出；精确 diff-check 0，不把既有全树 ttsService 尾空白问题忽略为通过。

独立 `g2_seam_candidate_spec` SPEC PASS→不同 `g2_seam_candidate_quality` QUALITY APPROVE，两产品与新测试未发现问题；功能登记另有独立 SPEC 核验和根 58 项回归。审查者仅静态读源码及机器回执，不伪称另跑一套测试。根收口 `.codex-staging/g2-seam-candidate-verification-20260909-r1.json`。整个 G2 和产品目标保持 ACTIVE：下一片依序兼容 v2 聚合资产上下文，再接无蓝图冲突候选的页面读取、完整来源选择与同任务显式继续。无真实 Worker/供应商/付费/Key/外部联网/生产/Git 写入，未合并、部署或运行 Hosted CI；旧音频兼容测试仅使用本次本机 loopback 合成端点。本地 Node guards 不是 OS/文件系统沙箱。

## 2026-09-09 前序：G2.TASK_BINDING 已本地双审收口

当前冻结实现：Orchestrator SHA `5e114cd58ce10aae380dc58f2d45d33704d6134418856d934af9a32a109693fd`，SourceAudio `b1b27cb963f3fac727aa6cd2425371c4145fe19d37e6992880bd68036228de67`，Native `e3349820bd4bb6c8ba01747d812f88ed106a34631f85e520eea3eff7088445ea`；48 例测试 SHA `3977f7f6a8803e3eeb4eb012687aa2df41cf421537adfe5265c34561e759865b`。取消/替换/owner-source 失效后拒绝迟到登记、后续调用、蓝图/版本/事件与结算；已合法音频资产及 Native 回执保留，旧 held 不自动扣退。guard 从创建事务固定服务器身份，HTTP 无传入入口，服务检查实际输入；短/无/长轨、Native 及蓝图最终事务均复核。仅显式 guard 的 legacy direct-start 错误处理追加同事务保护，旧 `runAnalyzeTask` polling 不扩改。

根最终定向 `C:/Users/canqu/AppData/Local/Temp/g2b-7d3c72cb477d4a9586b1773e79895eb4` 为 48/48、native 0，receipt SHA `6b82476664251f66b4b4836ff3bbf2354e343e8eb4f4af573196128ffecbb635`；source/guard/closure true，零 skip/timeout。真实事务 BEGIN 前取消及有效 v2 两窗音频产出后取消控制通过；不把 v2 producer 成功冒充消费者全链成功。独立 `g2_task_binding_spec` SPEC PASS→新 `g2_task_binding_quality` QUALITY APPROVE，P1/P2=0。550 项输入引用收口时根复算零漂移，7 个已知验证/实际 FFmpeg PID 已退出。

相邻聚合 49/49，SourceAudio 37 pass/0 fail/1 个既有 POSIX skip，一小时合成源的真实 PCM 三窗 1/1（实际 FFmpeg 1 次，Worker 合成）；最终功能锁 57/57、native 0，`.codex-staging/g4-unit-quote-root-feature-20260907-r1-g2-task-binding-code-final-e4c2c9d805c1426d80fa6cf427af25ca/receipt.json` SHA `355306f1dd2720d8a3385e177d01d10eb91b9c2a96e7a4111078ee0315b0c271`。计数不累加作去重覆盖。本片精确 diff-check 0；全树仍有既有 `ttsService.js` CRLF 尾空白报告，未修无关文件、不称全树通过。

根收口 `.codex-staging/g2-task-binding-verification-20260909-r1.json`；下一片为所属任务非成功接缝候选持久化、v2 消费者兼容及现有对白人工审核后续行。完整 G2/产品目标保持 ACTIVE，未提交/推送/合并，未进行 Hosted CI、真实 Worker/供应商/付费/Key/生产/部署。普通 Node API guard 不是文件系统沙箱。

保留的正式原 RED：旧 36 例 SHA `9897524fde5859933b10fddb0afbd3a443da4a2b3f9e5f749eb23841ce989670`，短 TEMP `C:/Users/canqu/AppData/Local/Temp/g2b-e9ee859668d0410aba259af79c60a885` 为 36/2/34、native 1、source/guard/closure true。第一版补控制后 44/44；规格审查再发现 direct-start 错误结算仅事务外检查，补 RED `g2b-4c0319e5df934a0480f50151d111242c` 48/46/2 后修为上述 48/48。两条正常计费控制通过，缺口取消例失败，不归因为测试入口。长轨旧链曾继续到尚未兼容的 v2 Fusion，该后继欠项未被隐藏或算作完成。

此前 worktree 长路径两次 RED 全保留：第一轮闭包少一份静态来源 policy，第二轮补齐；早期第二素材夹具违背实际 owner+fingerprint 唯一索引及 Native receipt rename EPERM 均单独记录。改为不同源素材并使用自有短 TEMP 后本轮无 UNIQUE/EPERM，但未证明旧 EPERM 的具体外部根因；没有修改产品文件重命名策略或添加供应商重试。

本片两项命中功能锁授权已精确追加，57/57、native 0，旧规则/历史可逆保留；登记初次命错同文本条目及新测试路径排序错误的日志均保留，已只纠正本片元数据/断言，未削弱门禁。最新授权回执 `.codex-staging/g4-unit-quote-root-feature-20260907-r1-g2-task-binding-auth-final-4bf643d65fe240bd9c95cb759dd169f3/receipt.json` SHA `1704a33128aa352b3b64fd867a39978388ed89b7d2d8a87f411bb79cdc3e1a77`。这只是授权登记，不代表实现通过。

作者修改范围为三个产品服务和新定向测试；根负责受控入口、两项功能锁追加和两份主线文档。最终 GREEN、相邻回归、独立 SPEC → 不同 QUALITY 已完成；历史授权登记及失败工件全部保留。零真实 Worker/供应商/付费/Key/网络/安装/生产/Git 写入，不部署；总产品目标仍 ACTIVE。

2026-09-09 G2.PCM_WINDOWS 已本地双审收口：产品 SHA `9b9e4a3038ba9806531d3cf181246eda29d5d536f087dfbd419de2e176ab8e55`；作者与根聚合分别 49/49，兼容分别 37 pass/0 fail/1 个既有 POSIX skip，根最终八个真实 PCM 案例分别 1/1，功能锁 56/56，全部 native 0。八例包含一小时实际抽轨三窗成功和七个到达指定窗口的失败/unknown/哈希/4097 上限/源 CAS 负例；每例只有一次实际 FFmpeg，Worker 是合成替身，不代表 ASR 内容质量。负例零成功登记，实际 SQLite deferred-FK COMMIT 失败后当前任务 JSON 清理、兄弟文件保留已通过。独立 SPEC PASS→不同 QUALITY APPROVE；12 个最终验证 PID 已退出，选定来源和原素材无漂移。根收口 `.codex-staging/g2-pcm-windows-verification-20260909-r1.json` SHA `a28fac0deac1e0e59b14f5b0f5a92b558aaf3b815a2f9080c7656f4002f7b564`，253 项引用复算零漂移。只关闭本地 producer 子包，完整 G2 与整个产品目标继续 ACTIVE；零真实 Worker/供应商/付费/Key/生产/Git 写入、未部署。

本片保留的 RED：原始聚合 43/0/43 是同一个缺少导出入口；实际一小时整轨 115200078 字节超 Worker 限制。第一版后新增聚合 RED 49/46/3、实际第二窗 client INVALID 分类 RED 1/0/1、current Evidence RED 38/36/1 加唯一 POSIX skip（抵达真实 COMMIT 回滚后残留 JSON）；四修均经 GREEN。另经已审 loader 在内存重放 LF 规范旧源码，对十个坏长 WAV header 取得拒绝缺口证据；该回放发生在实现后，不是原字节备份或先于实现的 TDD，旧版 COMMIT 测试提前失败不计为真正 COMMIT RED。原始日志全部保留，各套件及重复运行计数不累加为去重覆盖。

下一片固定依赖：先沿 Orchestrator 的服务器真实 async_task 接入 SourceAudio/Native await 及最终写入前的任务绑定和取消/替换复核，失效不允许旧任务覆写新作品或改变既有 held 策略；随后持久化所属任务的非成功 seam 诊断，兼容 SourceDialogue/EvidenceFusion/AnalysisWindow 的 v2 原始绑定和时间精度，再接现有母本对白修订→保存→锁定/恢复。现审核页依赖已有蓝图与可解析音频资产，不能把内存 error.diagnostic 当作已经接好的人审。仅做本地主线 TDD，不新增模型或通用审批平台；下列前序时点均为历史。

本片技术具体化：保留旧整轨抽取命令一次，长轨用受限 RIFF fmt/data 解析和有界 PCM 流复制（规范 44 字节 header），不额外编解码、FFprobe 或新增模型；每窗实际文件仍小于 64 MiB。短轨 v1 入口和已有校验原样保留，仅长轨解析严格样本合同。PCM 末尾以样本数/16 保留 1/16 ms 精度；v2 段/binding 从原 Worker 秒值平移，允许亚毫秒，原文不 trim；trim 与 Math.round 仅用于核对原 DTO，不能反向重建来源。纯聚合入口为同服务的 aggregateSourceAudioWindows；成功窗保存 raw_source_evidence；内容冲突 SOURCE_AUDIO_SEAM_REVIEW_REQUIRED 携带非成功 error.diagnostic，不冒称持久化或人工恢复已接好。双向唯一配对且两代表逻辑归属相同才按较早物理索引选完整代表，逻辑 commit 仍独立半开计算；不同归属/缺失匹配不自动择近。真实 async task/cancel 绑定、消费者、诊断持久化与人工续行仍是后继欠项，不得省略后称完整 G2。

2026-09-09 当前收口：G3 双作品默认分析/无音轨修复子包已本地通过。普通登录和默认租户、ZIP 两项、显式第二项有轨分析、第一项无轨分析、重复上传/GET、跨用户 404 均在新隔离 HTTP `npedz9` 完整通过（native 0、1/1），终态 2 作品/2 任务/2 待审蓝图、Worker 1/Vision 2、quick_check=ok、零活动子进程。29 条媒体命令中 28 条 native 0，无轨抽 WAV 一条为预期非零 4294967274 并由既有无轨分支处理；不称所有媒体命令成功。Blueprint RED 16/14/2→作者与根 16/16，Fusion 作者与根 12/12，功能锁 54/54，均无跳过；独立 `g3_no_audio_spec` SPEC PASS→另一 `g3_no_audio_quality` APPROVE。仅修严格三字段全 null 与无轨 spoken 矛盾，其余 18 项选定产品输入未变。收口 `.codex-staging/g3-multi-input-no-audio-verification-20260909-r1.json` SHA `be4b644c0d0129dfd3c425b4f3565c2e81b42f2abb75ab6d837f6dfd43da4835`，60 项引用收口时根复算零漂移。之前 `CR97vG` 的真实无轨 500 和所有失败入口/fixture 原日志保留。该结论不是裸 npm test/Hosted CI、真实识别质量或完整 G3/产品交付。

当前 G2 客户端原回执保留子包已本地双审收口：仅 `preserveSourceEvidence === true` 在既有校验全部通过后，以 `structuredClone(response.result)` 返回 `rawSourceEvidence`，保留解析后 JSON 的秒级时间、原文本与原声明 SHA；默认 DTO、四字段 wire 请求、单窗 v1、旧类型兼容及 unknown 不重试不变。不声称保留原 wire 字节、重验 Worker 声明 SHA或已支持长视频。初始 RED `irdQnx` 为 28/26/2；初次 28/28 后质量审查发现嵌套数组别名，已补正式 RED `FIaSJ8` 29/28/1 并修复。最终作者 `mnpQkv` 与根 `7UJHwX` 分别 29/29、native 0、零跳过/超时，独立规格复审 SPEC PASS→质量复审 APPROVE。功能锁登记 55/55；全部仅合成字节与任务自有 named pipe，不是真实 Worker。根收口 `.codex-staging/g2-raw-source-evidence-verification-20260909-r1.json` SHA `926a2e9007d2967495f1241a968e158027594f506e7b4b088babf9257e7d1128`，36 项引用收口时复算零漂移。下一步按已批准规则接有界 PCM 分窗、严格聚合及人工冲突确认/恢复；完整 G2 和产品目标仍未完成。

G6 常规测试接入仍有明确欠项：`backend-node/test/redrawMultiInputProductAnalysisHttp.test.js` 依赖专用启动器设置的 `__g3MultiInputHttpGuard`，而当前 npm test 会收集此文件；裸入口会主动拒绝，不能据专用入口 1/1 声称常规测试或 CI 可通过。提交/推送/Hosted CI 前须完成可审计的隔离入口集成或分类，不能靠取消 guard、跳过后称通过来掩盖。本次未运行裸入口，也未调整 CI。

测试入口历史：r2 的快照失败已用原生探针确认是 Node Permission Model 禁止 fsync，不是时间戳或产品快照缺陷（报告 SHA `0141302514e8d094af2ba0805db91453ce490b31a374bc645ec272a403ccf365`）。r3/r4 桥接探针失败后均保留并弃用，未运行完整 HTTP。最终 r5 经独立规格/质量审查，沿既有隔离测试方式使用普通 Node、封闭合成环境、默认配置/DB 与外网入口拒绝；不是 OS/Node 文件系统沙箱。此前两个 r5 失败分别是 fixture 文件名误作事实文本、reversals 空数组，已仅修测试替身。原失败目录均不复用；最终当前 RED 才是无轨产品缺口。全部仅本地合成素材与最低层 ASR/视觉 doubles，不代表真实识别/生成质量或产品交付。

G2 确认后的只读定位：当前 SourceAudio 在视觉/蓝图之前运行，旧对白编辑要求已有合法蓝图及 resolved 来源，不能简单放宽检查承接接缝冲突。最小路径已写回唯一计划：PCM 窗口/原回执→严格聚合/v2→非成功冲突候选→现有同页完整候选选择→原任务显式继续，保留 source/task/owner/CAS 与 unknown 不重试；无法通过完整候选选择解决的冲突继续待处理。本条是源码定位与计划，不是新执行/识别/产品通过证据。

2026-09-09 用户决定（已采用，不再等待确认）：G2“完整保留识别出的对白段、不自动裁句；接缝冲突停止并交现有对白审核，不新增语音模型”。双作品默认分析回归和客户端原回执保留现已完成上述本地子包；下一执行范围为长轨有界 PCM 窗口、严格聚合及冲突人工确认/恢复。不得把识别段等同于语义完整句，也不扩大真实调用/下载/部署权限；G3 新容量阈值与 G5 最终配音批准方式仍独立待定。

历史执行范围（G3→G6 本地连接回归已在本文顶部收口，以下保留原计划，不再是下一项）：一个本次合成 ZIP 含无轨 MP4/有合成音轨 MOV 两个不同方向、不同 SHA 的短视频。通过真实普通 HTTP 登录、默认租户、建项目、multipart 上传与 GET 作品列表找回第二项，再显式进入真实 SourceAudio→NativeSource→Fusion，核对第二源片/WAV/帧证据与待审蓝图；另验无轨 Worker 零调用、重复/跨 owner 拒绝及零生成/TTS/导出。仅最低层视觉/ASR 客户端使用显式 doubles，不预塞 activeAnalysisFacts/蓝图，不改容量/模型/语言门禁。这是已批准默认分析矩阵的一片，不需要新的支持范围取舍；先新增 `redrawMultiInputProductAnalysisHttp.test.js`，产品出现实际业务失败才窄修。入口亲读后运行、保留完整日志并 SPEC→QUALITY；普通浏览器继续受真实就绪门禁约束，不注入假能力绕过，也不以本片替身结果称识别质量通过。


当前状态（2026-09-09）：G6 入口显示修复已完成本地 TDD、独立 SPEC PASS→QUALITY APPROVE 和 r6 实际浏览器复验。四个 SFC 仅修弹窗直接标签颜色、比例整行布局、局部状态标签颜色和空预算展示；不改 API/DB/预算策略、全局主题、模型或权限。聚焦 RED 14/7/7→GREEN 14/14，根复跑 14/14，相邻 source 24/24、works 19/19、parent 56/56、功能锁 53/53，均 native 0、无跳过/超时/选定输入漂移；计数不相加作去重覆盖。公开模式 r2 新编译 native 0，299 输入/131 输出，432 项引用复核零漂移。根收口 `.codex-staging/g6-entry-ui-verification-20260909-r1.json` SHA `2ef1dd4f472c42efdc8d45e42333a1490bf8dc08e8a8d553a6f617ebc7805f8c`。

r6 新隔离真实登录→空列表→建项目→上传新合成 14 秒 MP4→刷新作品/新作品入口/切回→退出→重新访问受保护地址回登录页已验；项目和上传各 1 次 POST/201，源与存储 SHA 均为 `16f54c00138ea4f3e27e9450c67d13addced0c7ccd6434b521e60d1ae8373088`，最终仅 1 项目/1 作品，quick_check=ok，分析/生成/执行/导出/积分流水/冻结记录均 0。浅/深主题弹窗直接标签可读；1280/1024 比例六项完整、DOM 横向无溢出，末项可选择；draft/作品标签可读，空预算显示“未设置”。实际 0 的展示由真实 Vue renderer 覆盖，未额外创建浏览器项目。错误密码 HTTP 401 已验，瞬时错误提示仍未捕获；r6 没有整页 reload，不借 r5 的该项。浏览器原生图像在会话中，未伪造本地截图文件。记录 `.codex-staging/g6-default-login-browser-20260909-r6-observation.json` SHA `feefdfd026af1ff631a9c34788eaf2c43b531017bc2a9f9ac505bb26a2be72f2`。

r6 通过已审启动器的 STOP 文件正常关闭（exec stdin 已关闭，未重新启动），native 0、无超时、父子进程已退出、13 个选定来源根复核无漂移；自有标签页关闭、viewport 恢复，r1–r6 均保留。当前源码仍未提交，不借旧 HEAD/CI。以上只关闭入口最小修复包，不代表整条分析→本地化→生成恢复→导出或全局主题验收；G2 长音轨、G3 资源/多输入、G5 独立批准配音、G6 全量回归/精确 HEAD CI/真实质量/用户验收仍开放，总目标 ACTIVE。继续推进已批准本地缺口；G2 操作定义已获用户确认；资源阈值及最终配音批准方式仍独立待定。零真实供应商/付费/Key/生产/Git 写入、未部署。

历史入口 r5：实际入口行为已通过，发现上述显示问题；其独立原始证据与失败状态保留。前序构建/审计记录以下均按当时时点理解，当前入口状态以上述 r6 为准。

补充验证（2026-09-09，当前工作树）：公开模式 Vite 编译已实跑通过，native 0、31.38 秒，299 个源/配置/所选工具输入前后不变，输出 131 文件；根复算源、产物及日志共 432 项零漂移，父/子进程均退出。新隔离目录 `g6-current-public-build-20260909-r1` 未复用旧 dist；`configFile:false/envDir:false`、清空子进程环境及网络拒绝先经独立静态 READY，再由根执行。唯一警告为部分 bundle 超过 500 kB，没有调整阈值。根收口 `.codex-staging/g6-current-public-build-verification-20260909-r1.json` SHA `704dc36dfbe765ea2f886e2398b0c66b405112543e2244e9f155a984d8b48106`。这是 Vite public 编译，不包含 release-asset compatibility finalizer、实际浏览器、API、媒体质量或 Hosted CI。另完成默认浏览器入口只读审计：旧测试确实新建项目并上传新合成源片，默认 full-product 并未预塞整集完成包；但假会话、注入 owner/tenant 与预制分析事实使其不能证明普通默认登录全链。下一安全步骤是复用现有 Login.vue 与 `/auth/login`/默认租户中间件，在新隔离服务中补真实登录与 SPA 验收，不沿用假身份。approved-dub 新批准方式仍等用户确认，不默认获批；整个产品目标保持 ACTIVE，未联网/调用供应商/付费/生产/Git 写入。

当前推进（2026-09-09）：G6.COMPOSE_PERMISSION_DURING_AWAIT 已本地双审收口。真实创建计划等待文件读取时撤销 token/user/member/tenant，最终事务 INSERT 与调度前拒绝；正常合成保持。实际 HTTP RED 5/1/4 → 完整 HTTP GREEN 81/81，unit+旧版合成 57/57，最终功能锁 52/52；当前身份审批原定向刷新 14/14。最终各套 native 0，无跳过、超时或输入漂移，进程退出；计数不相加为去重覆盖。独立 SPEC PASS → 不同 QUALITY PASS，Critical/Important/Minor=0。根证据 `.codex-staging/g6-compose-permission-verification-20260909-r1.json` SHA `a7607d86ac5e4db8f71e0640c58421022aa915e8fba65f17b23e5d8ed021d3e5`，128 项引用复核零漂移；两次无原生回执的中断运行保留且不计通过。HEAD 仍 `8c49a90773a4311992e4eb9b6a5bc2c9acdfa4ed`，未提交，以当前源 SHA 为准，不引用旧 CI。下一项为 approved-dub 的明确批准与来源绑定窄规格，尚未实施；长音轨、多输入、普通浏览器、全量回归/CI、真实质量与用户验收仍开放，总目标 ACTIVE。零真实供应商/付费/Key/生产/Git 写入、未部署；下列前序时点均为历史。

历史里程碑（2026-09-09，GET 数组拒绝）：G6.HTTP_EMPTY_ARRAY_GET_BODY 已本地双审收口。仅在 executionRunRequest 的 GET 条件增加数组拒绝；真实 HTTP RED 5/4/1（唯一 200≠400）→GREEN 5/5，相邻 Run/Candidate 31/31，最终源码功能锁 51/51，均 native 0、零跳过/超时/输入漂移、进程退出；HTTP 原始日志完整。SPEC PASS→不同 QUALITY APPROVE，P1/P2=0。根收口 `.codex-staging/g6-empty-array-get-body-verification-20260909-r1.json` SHA `79675d703f607219c1708fe7df061c8e67b943d489eeadabf37c835fb609acb1`，103 项引用复核零漂移。仅一个表达式逆转即精确恢复前路由字节；原 50 项功能锁测试、三锁历史及其余八锁保持。HEAD 仍 `8c49a90773a4311992e4eb9b6a5bc2c9acdfa4ed`，本片未提交，以工作树源 SHA 为准，不借历史 CI。下一项推进真实合成 await 中撤权的拒绝保护，并继续批准配音来源绑定规格；长音轨、多输入、浏览器、真实质量及用户验收仍未完成，总目标 ACTIVE。本轮零真实供应商/付费/生产/Git 写入，未部署；以下旧时点均为历史。

历史里程碑（2026-09-09，G5.6）：G5.6 第三片“四文件核验、受控播放器/字幕、原文件下载”已本地双审收口。实际经历入口 49/5/44、首版 50/40/10 和字幕结构 61/54/7 的失败验证；最终新测试 61/61、原提交防重 92/92、上下文 89/89，均 native 0、无跳过/超时/漂移、完整日志且进程退出。SPEC PASS→不同 QUALITY APPROVE；根封口 `.codex-staging/g56-unit-output-ui-verification-20260909-r1.json` SHA `715050c87a1870c2cb83cba53790e45d32615efc7cd8406cfee79d9dbb70b7ad`，70 项当前源与运行引用复核零漂移。仅完成 native/not_required 的本地真实 Vue renderer、合成 Blob 与真实 SHA；不代表普通浏览器解码、真实对白/角色或人审通过。HEAD 只读回核为 `8c49a90773a4311992e4eb9b6a5bc2c9acdfa4ed`，本片未提交，以工作树源码 SHA 为准，不借历史 CI。下一步先推进已批准的 G6 空数组 GET 请求体拒绝，再补 approved-dub 来源绑定具体规格；长音轨、多输入、浏览器、真实质量及用户验收仍未完成，总目标 ACTIVE。零供应商/付费/生产/Git 写入；以下旧时点均为历史。

最新执行状态（2026-09-09，本地）：G5.5a 四文件 HTTP 子包已独立 SPEC PASS → QUALITY APPROVE，P1/P2=0。根最终 40/40、native 0；相邻多作品 12/12、旧 Export/直接路由 19/19、Run/Candidate HTTP 31/31 均 native 0，无跳过、超时、收集错误或运行中输入漂移，进程全部退出。收口 `.codex-staging/g55-unit-export-http-verification-20260909-r1.json` SHA `3fc49ca0f2a8575e2882dd95410a4969408d1ea781d194ab46904218aeb58f37`，根复算 37 引用零漂移。仅两个路由产品文件变化，四个合成服务未改；旧 download 逻辑保持，交界处有单行 CRLF→LF，不作整体字节一致声明。下一项按唯一计划 G5.5b 接通现有 compose POST；仍缺页面完整闭环、多输入与真实质量验收，整个产品目标保持 ACTIVE。零供应商/付费/生产/Git 写入；以下旧执行点为历史。

G5.5a 最新实际运行（2026-09-09）：首轮修复回归 29 项中 13 pass / 16 fail、native 1，95.722 秒；0 跳过/超时/收集错误，76 选定输入无漂移，PID 35628 已退出。目录 `g55-unit-export-http-local-20260909-r1-http-root-unit-export-http-green-db185b7c7daa4744a59d49612d24a118`；receipt `d47da87c0f89fadcf76023539c1b9a505dc1ea356a4e5714643efbc83289317c`，TAP `dbac525ee433c3b6681b039f3421166691a78106bd96e2ae00bce35602a5d4f5`。unit DTO 已到达正例，但实际下载前置 409 尚未解除，流内故障不能记为已验证；旧 v1 对照重复插入源 fingerprint 的 UNIQUE 失败属于夹具错误。独立 SPEC 另发现跨 owner / 错租户拒绝会落入旧租户初始化，须补删除 membership 后零 DML 负例。保持原失败证据，先诊断再最小修复，不计 GREEN 或产品交付。五项本地功能授权 47/47 已独立双审，仅是授权登记通过；证明 `g55-feature-verification-20260909-r1.json` SHA `559c0f33b749b51e9a4cb109457c928d3d54ba458014e10c5214e80904adef27`。零真实供应商/付费/生产/Git 写入。

最新续行状态（2026-09-09，本地）：G5.4 单元合成与四文件服务读取已通过非作者 SPEC PASS→QUALITY APPROVE；作者 13/13，根最终 22/22；根旧 Composition 26/26、Export/直接路由 19/19、Release 19/19，分别 native 0、无跳过/超时/输入漂移，进程全部退出。根最终 receipt SHA `bb44f43aa6d6856406d680c1c64166ec51830b279fac7352465aeead35cba5cc`，TAP `14d41e56852841afb9c7bb30e88456f8e84e235ef5e59654a560d69651a4c239`；收口 `.codex-staging/g5-unit-composition-verification-20260909-r1.json` SHA `bd330dd207e6d5574e139d7a399bf1695cf6a92f3be4aafe64d73e9daef26c0f`，60 引用复算零漂移。旧 26 项入口是完成后日志，不能宣称实时采集；19 项不是实际 HTTP，重叠套件不累加。开始 G5.5a 真实鉴权 HTTP 下载接线，不提前宣称页面或 G5 完成。G3 已有 32 引用双审收口不变，实际 JWT/普通 SPA 两作品浏览器仍缺连接；已确认旧浏览器夹具有假 token/注入 owner，不当真实鉴权证据。G2 六项结构负例草案仍未执行，旧超限共同前置不能重复计六类 RED，完整句语义待确认合同保持。全产品目标 ACTIVE，零供应商/付费/生产/Git 写入；以下均为历史阶段记录。

G3 多作品入口正在实施，不能计作完成：后端正式 RED `g3-project-works-local-20260908-r1-author-works-red-56767ee2a71e4416a555992fa7acdef2` 为 12/0/12、native 1，证据完整；前端新草案已审读、尚未运行。此次五项功能锁登记保留全部旧历史和门禁，feature RED 46/6/40 → GREEN 46/46、native 0，目录 `g6-review-identity-20260908-r1-feature-g3-project-works-feature-green-0ac0b0e8250c46fda02ac5ecae1c7567`；这是授权登记回归，不是 UI、HTTP 或成片验收。未联网、供应商/付费/生产/Git 写入均为 0。

日期：2026-09-08。**当前结论：通用产品尚未开发验收完成；G5.3 只读发布清单已本地双审收口，G3 多作品新链通过首轮回归，G5.4 合成与四文件导出正在实施。** 局部测试通过不代表整集、生产或客户验收。

G3 最新实跑：新后端 12/12、作者新前端 19/19、根新前端 19/19，native 均为 0，无跳过/超时/输入漂移/收集错误。根 renderer 目录 `g3-project-works-ui-20260908-r1-root-works-ui-green-752c80aae89d4def8508d1bb273ffaa1`，receipt `8dc89cd1837f2c71c3691a08df2110801201366d4504b36ce9a852203ec27777`、TAP `c287a025d022eaf045d5ee58a6dcfde943ef3acc0e8a2b628cecae3156760bff`。旧严格 API fixture 未登记新只读列表，需要原字节兼容 RED 后仅补 handler、保留断言再回归；仍未完成产品独立双审或浏览器。功能锁登记已独立 SPEC PASS→QUALITY APPROVE，单独收口 `g3-project-works-feature-verification-20260908-r1.json` SHA `21893154a07a89a20128c953f181cf669a9c44511491ce14e5533bd6fbefbaa2`，12 项引用根复核零漂移，不将其当业务交付。

G5.4 正式 RED：`g5-unit-composition-local-20260908-r1-unit-author-composition-red-d9206d8bd3ea4f04a1985b32a6d00f36`，4/0/4、native 1，无跳过/超时/输入漂移，原始日志完整，PID 70244 已退出。三个用例因旧合成仅认 camelCase versionId，另一项缺少 Assembly 同步末检 API；8 个子测试尚未到达。receipt `80a8336a1df855af39fcc3ebcd6d8667aca44532be9f0cf5243eb84248f6a4dc`、TAP `ec7e5162f5a3a27b2d2801f6664157a60cb7c76b43d80bf2006bff6112b338c9`。限定三产品实现中，不冒称已生成合格成片；真实供应商、付费、生产、Git 写入仍为 0。

最新 G5.3 只读发布清单已本地收口：作者与根各 10/10，旧 v1 19/19，均 native 0、raw 完整、无跳过/超时/收集错误/输入漂移或活动进程；非作者 `g5_unit_release_spec` SPEC PASS 后，另一非作者 `g5_unit_release_quality` QUALITY APPROVE。根 receipt SHA `a2fc98648a63ecfda711a79ad2482d830fddc533c483ecc5b5555b669cc5762c`，TAP `f2cf7d91574f3febb0abd0a46fa74ad19da9242c384dbaf7f959d3308c027c36`；收口 `.codex-staging/g5-unit-release-verification-20260908-r1.json` SHA `86d863b129135cea087d4045ff99a153920b2af8ba34dbe456c96cb05d029e41`，48 项引用根复算零漂移。非英语/RTL 正向和字幕逐项反例仍待补；完整合成/四文件下载/批准配音/最终人审尚未接完。下面测试事务与观察会话中断过程保留为历史，不再表示当前仍在等待该运行。

本次续行最新状态：G6 默认租户页面入口已本地双审收口。作者及根默认用例分别 44/44；相邻 Workspace 28/28、Source 24/24、Parent 56/56、旧 Run 面板 12/12、候选 90/90、生命周期 114/114，原始 TAP/receipt 均 native 0、无跳过/超时/漂移/残留。非作者 `g6_default_tenant_spec` SPEC PASS 后，另一非作者 `g6_default_tenant_quality` QUALITY APPROVE。收口 `.codex-staging/g6-default-tenant-verification-20260908-r1.json` SHA `485ee7ee5443381e1fcf2d0d8b18cb491eee91a2585146f5cf3e7bf40ad76f1c`，根复算 48 项源码/入口/日志引用零漂移。当前六 SFC 集合 `ea93bab13985a0942167848c082f8f6cd6a4c6d9ba819f66d9df0f9346f22b95`；仅 renderer/API doubles，不是首次登录的真实鉴权 HTTP/浏览器，不关闭整个 G6。

G5.3 测试事务二次诊断：rollback-to/release 修正后仍为 10/8/2，原日志保留（receipt `a8ac828063d2c8bc2f16b55b9577bca69161ccc20831e01067e6facef749e3af`）。根运行唯一纯 SQLite 三库探针，确认该序列虽恢复业务行，却使文件第 27/95 字节变化；完整 ROLLBACK 则业务行、serialize、磁盘字节均恢复且无 journal，三个连接关闭、native 0。证据 `.codex-staging/g5-release-sqlite-transaction-probe-92c4156ec5734d7eb724de370bf2e7cd/report.json` SHA `444074cd31d05d926eb4badd159b81ecb33df439282e7faa713d7b33e4ff58d2`。据此仅把测试自建事务改为先检查空闲的 BEGIN/ROLLBACK，完整 hash 断言后才标记恢复；全部零 DML、文件集合、业务拒绝断言不变。新 test `21b38ed87ec88690ef90d22d2709c24c988835d1878dd6e2e667b60ba263f7d5`，产品 `9cbd5de015ab8e40512eca3e3724870ff4c61df0c89246994abe628386991614` 不改；原 r1 运行 session 24892 的观察句柄丢失且目录为空，无法取得 native 终态；根只读核实原 node/launcher/同唯一 temp 媒体进程均为 0，保留旧工件、不计通过。新 r2 只加实时原始日志与独立启动回执，入口 SHA `57dc5fefa3449887f89f999526bda9ce15ec4d21642c3a3c5384e3786aafe70f`，当前固定 unit session 29707/PID 60300 正在运行，GREEN 后才运行旧 release。下方中途状态保留为历史，不冒称本包已通过。

最新本地终态：G5.2 核心 9/9；根旧合成 26/26、HTTP 31/31、运行链 216/216、参考素材 65/65，分别 native 0，无跳过、超时、输入漂移或活动进程。非作者 `g5_assembly_spec_final` SPEC PASS 后，另一非作者 `g5_assembly_quality_final` QUALITY APPROVE。收口 `.codex-staging/g5-unit-assembly-core-verification-20260908-r1.json` SHA `516d244488130e79e914fb480fecc7a96dcbf741bbbe5ae9cb0420a8eaab1bc0`，根复算 24 个源码/入口/原始日志引用零漂移；不把重叠测试计数相加。素材、供应商响应和人审仍为明确合成夹具，外层成片导出与内容验收尚未完成。

并行 G3 已本地子包收口：正式页面 RED 为 28 项中 14 pass/14 fail，最小两 SFC 修复后作者 workspace 28/28、source 24/24、parent 56/56，根独立 28/28，均 native 0、原测试未改。两位非作者 SPEC PASS→QUALITY APPROVE，功能登记另作同顺序补审也通过。根 receipt SHA `93dfb38daf29eaa191cf2c8d5bd01a96006282919fea65b9d08013b3518b8746`，TAP SHA `ceea9a81a5410a86a66e7dbc700f84555219b946db4ad236a873ea82711a413c`；收口 `.codex-staging/g3-workspace-mutation-verification-20260908-r1.json` SHA `ae8ac57889a771ec4606a15d297004abe7b59dd786c3d3ac6cf406b4fccf74ef`，28 项引用复核零漂移。不能计作整个 G3 完成。该子包收口时的六 SFC 集合 `98eacd379d843b61abce586325f720e7b690db10d2068aa6d939c926391b083c`；以下 G4.8 与 G5 中途记录保留为历史，不代表此后阶段仍停在相同等待点。

G5.3 正式 RED 已到达实际单元 dispatch→candidate→review→release，4 项中 1 pass/3 fail、native 1；三种音频模式均被旧镜头审核要求拒绝，旧 v1 hash 正例通过。目录 `g5-unit-release-local-20260908-r1-unit-author-unit-red-fe7aa475513b407a8288c9f95da4f66c`，receipt SHA `5c0940ff0946b445bf03e9e8d7c2e2563efa565c9ba3b941a4114670d32dbc75`；无跳过、超时、源漂移。根审读唯一 service 新分支后已进入固定 GREEN，未取得终态前不宣称通过。

G5.3 首轮 GREEN 10 项中 8 pass/2 fail（含父项汇总），没有据此冒称通过。仅补诊断消息后查明 `run revision` 注入 UPDATE 所产生的测试自身 `fixture.sqlite-journal`，在外层 SAVEPOINT 尚未回滚时被完整文件集合比较检出；零额外业务 DML 断言已通过。这不是产品创建发布文件的证据。诊断目录 `g5-unit-release-local-20260908-r1-unit-author-unit-diagnostic-1346bdb9b46b40d987b7a1586a3db3fd`，receipt SHA `fa055be391e7fe93518509a3796bb025eda8c82f63c953a6a3224d0c27dcff18`、TAP SHA `bc74a44b520b95fda73b3cb94bed80abd813abff67f9c9ffdfe39a86dddc3f6f`。只修测试自己的幂等事务收尾，在原完整文件比较前 rollback/release，并新增数据库字节精确还原；不排除 journal、不放宽业务错误码、不改产品。修正测试 SHA `9ff54368cb94edb3998e71b979d68e6f363df25b82f33d1ac0fe5dd8f6abbd22`，旧测试和失败日志均保留，固定 GREEN 重新验证中。

G6 首次登录已取得正式本地 RED：44 项中 6 pass/38 fail、native 1，均为无 tenant 时原刷新按钮禁用/getProject 不可达等业务断言；无 guard/loader/意外 API/清理错误。根已核 receipt `20f1aab4e6e97d09e2ae84ff6eeb35fc148cb3761982d0b5064da9a7bef63224`、TAP `9a083bb42b1b346ef99ea52a6ef01363d006b05d9f64747a88dcf179e2eecc4a`，目录 `g6-default-tenant-20260908-r1-author-default-tenant-red-99d564112ddb4f05b4477bdc71b7ddda`。新 test SHA `0f5fe29021b6a93d8532f77b8cba9aadcbf564ef86bc5d5d2b3d1651bb0ce686`；只放行 RunPanel 原刷新按钮按当前请求读取项目 tenant/user 证明，不猜 ID、不改模型或全局鉴权。真实空选择登录浏览器链仍待后续验证。

**本轮完成：独立 SPEC PASS，QUALITY PASS，C0/I0/M0。** 父页面现在传递服务端真实项目策略，在读取失败、策略变化或账号/租户切换后阻断旧上下文；保留执行面板及原 pending/unknown，旧异步结果不能恢复确认。已核验素材只触发 readiness 只读刷新，不自动生成。合法登录但未选本地 tenant 的 Workspace 读取保持兼容；默认个人租户的完整执行仍列 G6，不用夹具预置租户冒充通过。

| 当前冻结测试 | 结果 |
|---|---|
| 父链（作者及根分别运行） | 各 56/56 |
| 候选／生命周期／原面板 | 90/90、114/114、12/12 |
| 相邻材料／计划／队列／源运行 | 11/11、13/13、15/15、24/24 |

全部 native 0、stderr 0、无 skip/cancel/todo/timeout/来源漂移或活动残留；套件不相加作去重覆盖。最终产品集 `3323bbf6d628439804e7eca16b21fea976a531a13f6d39663ba79bdb2b9c93c3`；作者冻结 SHA `f73988beaaee65bdbe358177f216f13474e8a4bbdf357dc429b8e3003ad3d7ae`，根核 58 引用零漂移。收口 `.codex-staging/g4-run-ui-parent-verification-20260908-r1.json`（13678 字节，SHA `c930b58ac5ec43f1f20e1a5f04c37669c0cc9bce04f640715722cb33589fb71d`）含 29 项精确引用及两位独立非作者审查回执。

根最终父链目录 `.codex-staging/g4-run-ui-parent-20260908-r1-root-quality-final-680ebcc5c2c149eb98201749ea9227ed`，receipt SHA `a26f1baa32c5edc24df6307ac079e3a636f37e22c0f9ab71d85696ddd03732a8`，TAP SHA `06a69f42019a7ffc221d33a1675922432607cb9e870fa201e1ea382a3b00c0a4`。相邻四套原始日志见收口；三处 Run 手工加载器绑定和一处精确 blocked 断言适配已独立审查，旧条件未删。

当前 G5.2：同 owner/run/plan 的已批准单元逐段去 padding、保留原音与父镜映射，首个真实本地正例已由作者及根分别跑通（各 1/1、native 0）。根目录 `g5-unit-assembly-20260908-r1-green-root-green-main-54bf155b73c743038d7fc574eeba4b7d`，receipt SHA `d4451f71a93935daaa5ffb987da90ae1c36465c7005cda6e8a38decfe268ff85`；无跳过/超时/stderr、选定来源不变、PID 66416 已退出。实测第 9 秒已是第二单元画面和声音，输出时长/SHA、映射和零 DML 检查通过。此前正式缺入口 RED（receipt `eb1220109648605e63d35e47ef853ef61d78883ccccaa447fb4876a90f23ad5b`）及夹具失败日志均保留。素材、生成响应和人审结论仍是明确合成夹具，不代表真实英语或角色质量；正在补立体声、状态漂移、音频模式及清理反例，相邻回归与独立双审待完成。发布、字幕、报告和实际下载尚未接通，不能计作 G5 完成。

并行 G6 身份审批小包已取得默认真实 HTTP 的 RED→GREEN：缺包、不完整包、坏哈希审批返回 409/原业务码，owner/CAS/action 与未知异常分支保持。根独立定向 14/14、功能锁 44/44，native 0、选定来源稳定、无超时/跳过/残留；原生回执为 `.codex-staging/g6-review-identity-20260908-r1-review-root-review-final-6a61c29097484b098678e59d6244ac99/receipt.json`（SHA `ca5bfedf69fda03c173108439e1f8791d5b058be4ee4f04554612d4e74ac9c9b`）与 `g6-review-identity-20260908-r1-feature-root-feature-final-4813c5f22862421ab07d94cb448c72b1/receipt.json`（SHA `d1fb867f3be2e8c701d44d0e06416b3aec358a8f18156d0f93d626c1a785bc5d`）。独立 SPEC PASS 后 QUALITY APPROVE 已完成，仅该精确错误映射本地收口，不能据此宣称完整 G6 或全后端通过。

G5 A+B 根最终 3/3、native 0：`.codex-staging/g5-unit-assembly-20260908-r1-green-root-ab-final-c5cec51cc76243f4931ff76de26edc58/receipt.json` SHA `54bcd6c47664733fc2d59d5471bd4817b06363951f47f75a1df61af459c0f71c`，选定输入稳定，PID 57336 已退出，无跳过/超时/stderr。实际同长度输出字节漂移和 FFprobe 返回后的批准 revision 漂移均到达目标并被拒绝，清理只移除自己的合成工作区，原批准候选保留。旧 2/3 失败的实际原因已定位为通用测试 probe 注入污染动作参考校验，已去除新增产品 hook、改用真实 `execFile` 回调，未放宽任何业务门禁。音画相对起点、实际 SAR/DAR 清单、replace/not_required 矩阵仍待 C+D；后续仍需独立双审及导出连接，不能把本地三项绿灯写成 G5 完成。

G6 身份审批小包最终双审：非作者 `g48_lifecycle_quality/test_quality` 先 SPEC PASS，非作者 `g5_unit_assembly` 后 QUALITY APPROVE，均未发现本小包违规或代码问题；根再次核对五源与 GREEN 回执无漂移。路线逆去新增一行并还原相邻 CRLF 后与正式 RED 整文件 SHA 一致；三项授权逆还原完整旧清单 canonical SHA `e67a86434acaca7e3979db1aa2d586ab158f410693b11661ccfcb97d6fdb4824`。只勾选身份审批错误修复局部退出项，不关闭 G6。

最新 G5 C+D：作者 9/9、native 0，根已亲读原始 TAP/receipt，无跳过、超时、来源漂移和活动进程。真实音频延后 500 ms 的两个起点对照、非方形像素清单、replace/not_required 三模式均通过；首轮 C 正式 3 失败仍保留。最终 D 目录 `g5-unit-assembly-20260908-r1-green-author-d-mode-coverage-d77d448eb4dd4ff88da326d362271959`，receipt SHA `eea4204ba5a0cd63532209933d5fa784ae4d20a71943a0a5021717e31c642755`，TAP SHA `a079f10a93aaaee6a879a39ece7eebf7548cdc0b4d8ba4bf2772414f81d3492c`。独立 SPEC 已 PASS，另一新非作者 QUALITY 审查中。根新的旧 Composition 回归 26/26、native 0、无跳过/超时/漂移，PID 56360 已退出；目录 `g5-unit-assembly-regression-20260908-r1-composition-root-post-cd-final-aa295d629a3d451fb0156ba6d0d17d39`，receipt SHA `bb0b29365c435d874752802ce1e4f5236d3bfc8cf9b8acd2801726ce1fdcab21`。运行链相邻回归仍在进行，不提前汇总通过。

并行 G3 页面包已进入正式测试：两份 SFC 基线与 G4.8 最终字节一致，新增单一 `redrawWorkspaceRuntime.test.js` 真实 mounted 夹具；原 Source 24/Parent 56 项不改。只追加 `redraw.episode-blueprint-first` 本次授权，功能锁正式 RED 45 项中 6 pass/39 fail（新精确记录尚未追加），追加后 45/45、native 0、来源未漂移；完整逆还原先前整清单 canonical SHA `8bd4745d9267890c3f56f4178c72489d5baa854dd0e51868355ed7d0e391a099`，旧规则与历史仍通过。GREEN 目录 `g6-review-identity-20260908-r1-feature-g3-workspace-feature-green-9fcc4ea8bac4469e94c220c34c14205b`；此功能锁测试不是页面业务 RED/GREEN。实际页面修复、相邻回归和双审仍待完成。

G1–G3 未完输入/证据合同、G4 普通浏览器执行、G5 其余、G6 全量与精确授权 CI/用户新输入验收继续开放。全仓既存 ttsService CRLF 诊断仍保留。当前零 Key/默认库/供应商/付费/生产/Git 写入。

### G4.8 前序过程（历史时点，不覆盖上述最终状态）

**G4.8 普通父链接线 GREEN，独立审查中（2026-09-08，最新）。** 六 SFC 集合 SHA `273f59cf7914ac11d35579e13a53ba6ae2b6c5bb42fe81ee41710c96fe314600`；作者冻结清单 `.codex-staging/g4-run-ui-parent-20260908-r1-author-freeze.json` SHA `26bf58a6ff1eb0e496df70c77b33be71bb28c893cab2d0a9e842529424e74735`，根回读 35 引用、0 漂移。作者与根四套测试均全绿：44/44、90/90、114/114、12/12，各 native 0、stderr 0、无跳过/超时/来源漂移或残留。根进程 41460/65272/57676/7908 均已退出；测试之间不相加作去重覆盖。普通页面已在真实 Vue 内存 renderer 接入 Run，共享源策略 epoch、刷新保留、迟到结果隔离和材料已核只读刷新取得证据；Run 原生命周期/人审逻辑未重写。

根父链日志目录 `g4-run-ui-parent-20260908-r1-root-parent-frozen-2a5bb7bcf6a044c89db5f35f34a9bed1` 的 receipt/TAP SHA 为 `d99101fcbac1cc34bf81d8ff8e44e1f3fe743fac3d8c78b1ce7ae593b0a0eb79` / `f4ed39aff0830d36ed7ebb7e8ba875184a4bed524c3614f893b3176ddb619bb8`。新独立 SPEC 正只读审查；额外四项旧父页面相邻测试入口准备中，预计旧手工 loader 缺少新 Run import 绑定，须实际执行后分类适配，不改旧业务断言。QUALITY 和这些相邻回归未完成前不关闭本包，仍无浏览器/真实媒体/供应商/生产/Git 操作。以下 RED 段落为原样保留的前序证据。

**G4.8 普通父链进入真实 TDD（2026-09-08，最新）：44/1/43，native 1。** 有效 RED 目录 `.codex-staging/g4-run-ui-parent-20260908-r1-fixture-fixed-red-e01f748557d2437abae4dd781813d034`，receipt SHA `a51321d6c3bab2211baf02bf0de890119424f51e57633e6ff1eaedc991f1af7b`、TAP SHA `9d12afd0a7bc48523d46e9aa3119a1c2414c312694c72eaced86832b25dc5327`。40 项在真实父链挂载后缺 Run 失败，1 项缺项目策略源，2 项复现同版本跨作品的本地化/事件污染。根已读原始失败与回执；PID 43936 已退出，无超时/跳过/取消/stderr/残留，源及依赖稳定。六 SFC 修改前集合 SHA `4a6a2863143446654e42914efe21c61a8c0eb498f20de7f8fec93159bc770208`。唯一作者正在原字节留存后的最小实现，尚无父链 GREEN、双审或浏览器验收。

首轮 `g4-run-ui-parent-20260908-r1-initial-red-eee76b261c0d4bfeada7599a18e1b4bf` 同为 44/1/43，但失败是测试 Element 替身把 options 传到只读 getter，明确不计产品 RED；只补替身 prop，产品未变。原 receipt `e97aa563e053fd665b9b89eb215d511668ed9d3264e58e93f187aba2e6384c52` / TAP `6109f23d043eb1f1b01c116297c4c7b854a6f49a9f8295a8f8038fbd9ac20792` 保留，PID 35816 已退出。原生摘要等待问题在运行前已由独立夹具预检纠正；两类均不改模型、不放宽产品检查。以下候选已收口和父链静态准备段落为前序时点。

**G4.8 候选播放/逐项人审本地收口（2026-09-08，当前）：SPEC PASS；QUALITY PASS，C0/I0/M0。** 当前 Vue `c8c7f88e58cc74cf29f2ae82984d5e7e87e6fdfae988a5c428f9268326eea0b2`，相对生命周期基线 191 增/5 删。根独立回归候选 90/90、原生命周期 114/114、原面板 12/12，各 native 0、源/480 来源/88 依赖稳定、无 stderr/跳过/超时或残留进程。SPEC 后补的 19 项只加强既有行为证据，未改产品；覆盖真实 pending 快照重载、同模块活动请求、并存生成未知原槽保护、改 hash/检查值防重及错误成功回执。线程名额限制下复用未参与本包实现的独立规格和质量审查代理，未用作者自审替代。

轻量收口 `.codex-staging/g4-run-ui-candidate-verification-20260908-r1.json` SHA `8074821f2b378ec94be0be0c59637166ccd7b91db1c4bee33410d9384b6090d2`，根回读 21 引用、0 漂移。root90 原始目录 `g4-run-ui-candidate-20260908-r1-root-evidence-extension-25940a5e431a4a9aa134f381c1afbdbd`，receipt/TAP SHA `f8451cea24a1227c356acc480dfc7d4bdefe0692f04ca7acb6bcaca96cd6cb0c` / `b5dfd6b0a418ea00e861fa88d5cd79ea418329871340835df1142ddc15e592d2`，PID 55060 已退出；root114/12 引用列于收口，PID 33984/57096 已退出。不同套件不相加作去重覆盖率。

这仍是 API 注入的真实 Vue 内存 renderer 证据，Blob 是明确不可解码的夹具，不代表浏览器播放或真实人物/对白听看通过。下一项为 Workspace→Source→Localization→Plan→Run 接线、真实策略源 epoch 与加载时保留实例；不改旧 shot 队列。全仓 whitespace 门禁尚有本包未动的 `backend-node/src/services/ttsService.js` CRLF/尾空白诊断，当前 SHA `dd68de20c5f50139a8e97cbe17a09ea6c430cac45bc40d24545c086068338684` 与前 480 来源快照一致，保留并交 G6，不能报告全仓通过。没有 Key/供应商/付费/生产/模型/Git 写入，完整目标保持 active；下方 RED/待审为历史时点。

父页面接线已交全新作者 `g48_parent_ui`，当前仅准备正式反例与隔离入口，尚无父链运行结果或产品修改；候选本包源已冻结，旧 90/114/12 继续作为后继回归。后继不另建平行规格或重新询问已批准的开发方向。

本轮只读确认：素材组件原上下文未包含策略 epoch，若只新增成功事件，准备在途的策略 ABA 会留下迟到回执缺口。因此接线范围包括同一策略对象进入材料既有 context/watch，完整复核后才发带发起 scope/epoch 的事件；父只能据此只读刷新 readiness。另把 Source loading/error 与 Plan 缺预览时保留 Run 实例、原 pending/unknown 锁和撤销旧确认列入真实父链反例。这些目前是已核代码的实现要求，不是已通过的测试结果。

**G4.8 候选播放/人审开始实现（2026-09-08）：首轮有效 RED 71/0/71。** 本地真实 Vue 挂载后确认缺候选按钮和 `loadCandidate`，非加载器故障；原产品未改，测试与入口已根全文核准。原始目录 `.codex-staging/g4-run-ui-candidate-20260908-r1-initial-red-4fe575cc004242349fd9b3b274d74262` 的 receipt SHA `1c7ae35997335df7144db0421863bc4355fbe8d0fa47f44a44aed0bfa3e42f66`、TAP SHA `15f3825b3b5677794d84802b087b25f1a94668c55e1e1d993b621473202dcad7`；native 1、stderr 空、source_unchanged=true、PID 59128 已退出。唯一作者正补受控 Blob、动态逐项人审及审核未知防重；旧 114/12 保持作回归。未取得本包 GREEN/双审，不代表真实浏览器播放、人物/对白质量或 G4 整体完成。

**G4.8 生命周期本地收口（2026-09-08，当前）：SPEC PASS；QUALITY PASS，C0/I0/M0。** 最终 Vue `b35d1c8cd678b454638dbf2ee209c14142d6955631846483e54becd8032072ef`，覆盖显式创建/暂停/解暂停/推进/原尝试核对、原 owner 回执保护、五类操作刷新遗留状态与防重。F1/F2 及 QUALITY 的 pause/pending 遗漏均通过各自 RED→最小修复→GREEN、独立复核；原失败工件保留。最后暂停补丁仅三行产品代码；114 项作者回归和旧 12 项通过后，root 再独立运行 **114/114、12/12**，各 native 0、无 skip/cancel/todo/timeout/stderr，Node 54012/55612 已退出，480 来源和 88 依赖前后稳定。两组不相加作去重覆盖率。

轻量收口 `.codex-staging/g4-run-ui-lifecycle-verification-20260908-r1.json` SHA `71509718075b63c20e69d1f9383f0964b1aa8ced39b642bc681ba257d47fac0c`，root 回读 14 引用、0 漂移。最终 root 生命周期目录 `g4-run-ui-lifecycle-20260908-r1-root-final-pause-707455a0c2a340c1b5949186af2c1ad7`，receipt/TAP SHA `e6438010e099c2ed1b5d82aab1afa37dafe2ca68cb429ad0fdaa71964a53ad86` / `b6de0241a537cad5dd892ec029ba3ad181ff7301c2f8424d87c4fde551a5fada`；相邻目录 `g4-run-ui-component-20260908-r1-root-final-pause-adjacent-4166fe1caba14742a31263a3cb75e33d`，receipt/TAP `7ab12f2f4a56ccb6f0110a913b347b172e22b10e50cc8cb462196fb0d649713f` / `ea107e5fb1a55c636ea96508f724e9ff1bed5625fe5785a68b8e3041796cb289`。这是注入 API 的真实 Vue 内存 renderer 验证，不是浏览器、视频内容或付费验证；没有 Git/生产/模型/Key 操作，完整目标仍 active。下一独立作者接候选受控播放与逐项人审，再接普通父页面；下方 FAIL/待修均为保留的历史时点。

**G4.8 修后复审：F2 PASS，F1 仍待补齐刷新恢复边界（2026-09-08）。** `4e269f8a54096a820f434f982c9a5b330e217064173ebd3537c9239e751fce63` 实际 81/81、旧 12/12，root 全文读 TAP 并核 receipt/TAP 哈希。独立 SPEC 仍定位合法 recover 迟到被 UI ticket 提前挡住原 advance 结清、首读已是 waiting_review 缺少关联未知操作的显式核对入口，以及原输出/claimed 唯一 attempt 证明不足。另确认真实页面结束留下的 storage pending 不能永远等待旧 JS 回执；只允许新模块按严格显式权威证据核对遗留意图，真实活动请求仍防双击，不能因刷新/Map 为空自动解锁。唯一作者正在同批补反例和最小修复，QUALITY 尚未开始。

本次 GREEN 原证据保留：`spec-reconcile-green-1-4640c027a05e4ac1a2c998a789e7b453` receipt `8357b617e1a9aa92bbe45463b13e65cd9bdd8d34ec94cbfa4e23ffb07c4be9f8`、TAP `f9e8ffc887157c2439cea89769a957f2d32b68e8abc7d785c8a95654b222850c`；`spec-reconcile-adjacent-e24ab5d12f3e4087abfcd953a71608ff` receipt `9029a0becf129ebaea9803a18ddc5478167be990f901052826855571136e000d`、TAP `df38ead31ba9f23542db52d0b657b041749b91792774709722def652b8ea8226`。两次 native 0，Node 54980/42964 均退出，来源稳定且无超时/skip/cancel/todo；这些只证明各自测试场景，不代替遗漏场景或真实浏览器验收。

**G4.8 两项 SPEC 修复已取得扩展 RED（2026-09-08）：81/55/26，native 1。** 原 42 项仍全部通过；新增失败实际复现原 advance/create/resume 意图无法结清、结清存储故障入口不可达，以及同 provider ID 的冲突证据覆盖旧回执。目录 `.codex-staging/g4-run-ui-lifecycle-20260908-r1-spec-reconcile-red-a34779aabc2c4b38841ae1275b4a731e`；receipt/TAP SHA `537a4a0b67ab1d5b2464c046320e086e4d0712672b33e3a2046baffb4b6d183d` / `e105331f5ed8b4f99d4b095ec2544674c5f4781b39501acbd31d415ba7bd879f`。产品仍为修前 `4de748…`，测试 `666a7e1fd95a43dc06b4a599a8b01bd55c4bf20ca50761f1184f37d0ee844bbc`；480 来源与 88 依赖运行前后稳定，无启动错误、超时、skip/cancel/todo。root 已读实际失败与汇总；唯一作者继续 Vue 最小修复，尚未取得修后 GREEN 或复审。夹具采用本次 recover 新物化路径 revision 4→6、人工审核模拟 7；稀疏 waiting_review 回执本身仍是合法公开合同，不因夹具选择收窄接口。

**G4.8 生命周期 GREEN 后的独立 SPEC：FAIL，两个 P1 待修（2026-09-08）。** Vue `4de748ab7793b703e561146fad5920552c324bdb9e4489fb4761f53b4a02b401` 相对存储基线新增 247 行、移除 43 行，新增显式暂停/解暂停/原尝试核对、持久状态/回执和 owner 事件失效处理。原矩阵 42/42、相邻 12/12 均为实际 native 0，但审查另确认：F1 成功 recover 仅结清自身槽，原 advance unknown 永久阻止后续单元；create/resume 未知控制意图也没有充分显式核对后的结清入口。F2 `settle` 只比较 provider ID，可用同 ID 的错误 run/task/inner request 证据覆盖唯一 safe receipt。仅冻结代码只读审查已证实，新增动态反例尚待执行；不把这些缺口隐藏在绿灯中。唯一作者获准本批 TDD 修复，未进入 QUALITY 或媒体实现。

本批严格恢复界限：生成未知只由当前 owner/scope/run/unit/原 attempt 的显式成功权威 recover 结清，已有 task/provider/request 不得冲突，写入/回读失败不解锁，原键和 hash 保留禁止重放；旧 GET、新确认、needs_attention 或未落库回执不解锁。create 只由充分核验的唯一合法 current run 结清创建意图；resume 需同 run 恰原 revision+1、已解暂停及原 unit/attempt/phase/output 一致的显式证据，公开 Run 缺少 phase 时用用户显式读取的真实 readiness，不造私有字段。控制意图核对不得解除并存的生成未知状态，不自动请求或推进。历史 run 仍仅查看，不扩成本批历史写入权限。

42 项 GREEN 目录 `.codex-staging/g4-run-ui-lifecycle-20260908-r1-matrix-green-1-058668d834884d628c27a271324f671b`，receipt/TAP SHA 为 `d2308e697b39d8f3ab2e0f61826dad02e6291db01009c8e18e83eaf7338913e9` / `16ddc97a027a8c2be0414e116f72fa7fc4c620211e081c2d9f9a7cd58c23fc1f`；Node 25852 已退出。旧 12 首轮 12/6/6 因假 Storage 缺 length/key，原日志 `lifecycle-matrix-adjacent-032484e5b5a74b489b02bd5478efada8` 保留（receipt `ec0999d452c8344efd219023f01cb567b3c835bc89379515c1a9c0c1bd29d691`、TAP `266cd4ab23ce2249304172bd1188b0c971b80c3d2672c39ba61a1c7570131f40`，Node 45492 已退出）。仅补两个真实接口，全部旧断言不变，test SHA `e9ab66dfb1560a473073cffc9d7a4c11329ceca9cf144ac643d0cd3d283b9234`；修后 `lifecycle-matrix-storage-fixture-adjacent-fe4d4fe2d5104dd5906d9c7a378763e1` 为 12/12，receipt/TAP `1219276902cf415f1fc7f27c7c991735d18a7a7a3bafd7f3c4c1cad10ec89085` / `f4e4cfaf347dc80bd67e2aa770d964c86bb97c734d0332a14eef2322396e3e7e`。原入口字节已归档，历史 closeout 不改写；新 launcher 仍验证原哈希并额外 pin 当前夹具及入口，未扩大 480/88 来源或 Node 94 文件读取权限。root 已回读两次 GREEN 完整 TAP；均非浏览器/供应商/真实交付验证。

**G4.8 完整生命周期矩阵 RED（2026-09-08）：42/18/24，native 1。** 当前有效证据目录为 `.codex-staging/g4-run-ui-lifecycle-20260908-r1-matrix-observation-red-17b8ae59d446477dbbed0a109b908082`；receipt SHA `91d7e50662e963553213e9a25143d7e0fcd8798bce25cea9b92e1430b8d341b3`、TAP SHA `109a34fcd323ad5ae1725f84b255988b040635d8b7abd80a38010de1ce27e3f7`。测试 SHA `4b7b7b9203267622327b4d3a4653aa74ed4383dbd9677675f49fedf8d5460979`，运行时产品仍为 Vue `190eff04545453660a590611d7fbf0bbf02ae489881fd4e9488058f9d0dc58ac`。原首四项及 M1 四个写后回读故障分支通过；有效失败覆盖持久 unknown/回执丢失、新模块不同确认重复 POST、owner ABA/focus 不撤销、pause/recover 缺失和 needs_attention 错误允许推进。独立 fixture 预审先修正真实 DTO 的 output_parameters、resume 计费、各 phase revision 与 action-specific safe receipt；未放宽产品合同。Node 34376 已退出，stderr/skip/cancel/todo/timeout/残留均 0，480 父引用及 88 依赖前后稳定。root 已读原始结果，现放行唯一作者在冻结测试上完成生命周期产品修复；未完成 GREEN、双审或普通页面接线。

首次完整矩阵 `.codex-staging/g4-run-ui-lifecycle-20260908-r1-matrix-red-d7736d5a2a474a54b312b62cdccfeffb` 保留：前八项通过，第九项 pending≠unknown 已捕获功能缺口，但第十项测试在断言前等待错误放行的重复 deferred POST，导致 60 秒保护终止自有 Node 48384。native -1、无汇总，不能计完整 RED；receipt SHA `3adac67d3ad15266c5ee418c917c54279f7e85b883e77c526874d11dfa20cf3b`、TAP SHA `49d98f3b17bf6bb7c1d31dadbfb7e1ff5f50515fcfd245de1122e954872e1f18`。仅修测试为先观察实际 POST 次数再结清 deferred；未加超时、改权限、改产品或重写历史日志。以上均为注入 API 的真实 Vue 内存 renderer 验证，不是浏览器、真实 HTTP 或供应商验收；无 Key、DB、生产、付费、模型或 Git 写入。

**存储子包已收口（2026-09-08，最新）：SPEC PASS；QUALITY PASS，C0/I0/M1，允许进入下一本地 TDD。** M1 是尚未直接覆盖“写成功后回读抛错/内容不同”的动态分支，非产品阻断，已明确纳入后继矩阵，不宣称零 finding。根收口 `.codex-staging/g4-run-ui-lifecycle-storage-verification-20260908-r1.json` SHA `c8c30e84a8e836fbb36957798b14f3290a86be7747cb86bf64ac94c7e189a9b4` 已逐项核 19 引用、0 差异；本次 Vue/四项测试/三个运行入口均保存原字节基线。下一步已交唯一作者补齐既定生命周期矩阵和 M1 测试，仅改新测试及对应测试 pin/说明，取得 RED 前保持 Vue `190eff…` 不变。两组通过不关闭完整 G4.8，后继未知恢复、回执、owner ABA、暂停/恢复/核对及媒体/父页面接线均仍需证据；下方“审查中”及 RED 记录是历史时点。

**生命周期存储子包 GREEN（2026-09-08，独立审查中）：新 4/4、原 12/12。** Vue 仅新增 18 行，SHA `190eff04545453660a590611d7fbf0bbf02ae489881fd4e9488058f9d0dc58ac`：在现有操作结构上按 scope/action/hash 固定槽读取锁，先写 JSON pending 并精确回读后才进入原 Map/API；存储缺失、读取异常或写入/回读失败阻止提交。未加无存储内存 fallback，旧 12 项及其夹具完全未改。新四项 GREEN 全部循环分支正常结束，证明 create/advance 的持久写入在 API 入口之前、三种存储故障零 POST，以及真实 Vue bootstrap/同模块双实例 advance 防重。

新 GREEN `.codex-staging/g4-run-ui-lifecycle-20260908-r1-storage-green-9a5783c6a2924d46a767c724c9c4e645` 的 receipt/TAP SHA 分别为 `b116b2d45f5552c82a3aa31ccde4d9a81557a7ca759c2d4b23a0dc97501959ab` / `6771b9030fefba711f1fa39bd7678d397a676d0bf353b949ee42f2543cf82eac`；旧 12 项相邻回归 `.codex-staging/g4-run-ui-component-20260908-r1-lifecycle-storage-adjacent-584dafc1a359453da3a69ecda14816f9` 的 receipt/TAP SHA 为 `20b088b7d60edbbe8a56868426355cdd089c67cf25690267a9b7373cc627ab7c` / `9e07a9cab4f3bd786b405c09f6b11ade64da41becb31787dd57e8916913c7e88`。两次 native 0、stderr/skip/cancel/todo/timeout/残留均 0，Node 49828/52396 已退出，480 父来源、88 依赖稳定。仅开始本子包独立 SPEC→QUALITY；跨新模块/新确认的作用域级 pending/unknown 恢复、回执持久、owner/storage ABA、pause/resume/recover 完整矩阵及普通页面接线仍未完成，不能据此放行真实生成或宣称 G4.8 关闭。

**生命周期有效 RED（2026-09-08，最新）：4/2/2、native 1。** 加载器仅限制 import 边界后，真实 Vue mount/unmount bootstrap 与同模块两实例仅一次 advance 均通过；业务失败确认为 create 的 POST 入口前未持久保存 pending，以及缺失 sessionStorage 时仍有 1 次 create POST。循环在首分支失败，尚不声称 advance/其他存储故障分支全部执行。有效日志 `.codex-staging/g4-run-ui-lifecycle-20260908-r1-loader-fixed-red-a2d37b33d1494b728abc514f4109cbd9`：receipt SHA `26f9282a9395618ab49ad9ada6d03f6040a07aa041b46d7bda4785ed0a0f56f6`、TAP SHA `7b72eebf80c9ccaa230418ffc7c2f8a8a0551d84b3d499abe81b2b77bfc02022`；Node 39736 已退出，stderr/timeout/skip/cancel/todo/残留均 0，480 父来源与 88 依赖稳定。现释放唯一作者仅在已有 reserve/locked 结构补持久 pending 与存储失败零 POST，不改 API/后端/父页面或扩大为状态框架。旧 12 项夹具原本已注入 sessionStorage，SHA `ca2308ac583fd0c52277c2f7630dcedd7f91d8869cbc963b8fbcfb8110d71d13` 未变，无须因推测修改旧测试。下方加载失败与首组通过记录继续保留为历史。

**生命周期组入场（2026-09-08）：首轮运行未到产品断言，不能记作产品 RED。** 新增真实 Vue memory renderer 的首 4 项测试并经只读测试审查补强同一条 pending 记录的完整作用域断言。静态启动脚本的重复文本/断参先修正，Parser 0 errors 后才运行；唯一一次运行结果为 4/0/4、native 1，均在 SFC 导入转换处报 `Identifier 'redrawAPI' has already been declared`。定位到 Vue import 正则可跨越非 Vue import；当前仅释放测试加载器的最小修正，产品仍固定首组 SHA `612487162221a436c337ee5cb4be5463fad85ea8074e74202691ecc52b3865d7`。原始日志保留在 `.codex-staging/g4-run-ui-lifecycle-20260908-r1-initial-red-3800c573eda44d65bb3d351f57820c0c`，receipt SHA `01488b032f3b866427d0cf051674ce64f72c6885a1adbbd60764a952eef09d51`，TAP SHA `fe4af62a2425b4754cffd86f5a3e70bb7a2ac19976eb9fca61f37e24c8cf4246`。Node 48288 已退出，stderr/timeout/skip/cancel/todo 均 0，480 父引用、88 依赖和本组源码前后稳定。真实 mount/bootstrap 尚未通过；完整 12 项矩阵、产品修复、双审和父页面接线均未关闭。未调用供应商、付费、生产或 Git 写入。

**组件当前检查点（2026-09-08）：首组 12/12 本地 GREEN，独立 SPEC / QUALITY 均 PASS、当前 0 未关闭发现。** 真实 DTO 的 revision 0 / 字符串 task_id 误拒先 11/1/10 RED 再 11/11；QUALITY 又发现唯一记录刷新后无法重选，新增第 12 项先 12/11/1 RED，再只清选中 ID（不清操作或回执）取得 12/12。当前 Vue SHA `612487162221a436c337ee5cb4be5463fad85ea8074e74202691ecc52b3865d7`，测试 SHA `ca2308ac583fd0c52277c2f7630dcedd7f91d8869cbc963b8fbcfb8110d71d13`；最终 GREEN receipt SHA `12eb0d730cce3cebab213e8f2ed2bcb8c03d79a0d9f6119d97a491f5f4d98285`、TAP SHA `773a27ed7326254bd8d04ae7f4ddd6ab55723339c800cbfac942607ac4a4c6b6`，native 0、stderr/skip/cancel/todo/timeout 0、44780 已退出、480 父来源和 88 依赖稳定。轻量收口 `.codex-staging/g4-run-ui-component-group1-verification-20260908-r1.json` SHA `f3d18aa8db10148fcef7f940dc440c4965d6223ce7eb3ba22eb32f38e2cca289` 已根核 13 引用 0 差异，并保存两个源码的原字节基线。下一组仅新增 lifecycle 正式测试，验证真实 Vue 重挂/新模块加载、持久 pending/unknown、原 owner 回执、暂停恢复；取得新 RED 前不改产品。组件仍未挂父页面，不将 setup-SFC 测试称浏览器或完整 G4.8 验收。下方 API 与首轮组件记录保留为历史。

**当前推进点（2026-09-08）：G4.8 运行 API 薄封装已通过本地 RED→GREEN、独立 SPEC 和 QUALITY，正准备组件 TDD。** 两个独立审查均 0 Critical / Important / Minor，仅放行下一本地组件组。轻量收口 `.codex-staging/g4-run-ui-api-verification-20260908-r1.json` SHA `002a2f2107b80525e6594e6e02e69ff97ef4c9649dadb932e53b19a5164c24b3`，9 个直接引用已根复核，无差异。唯一产品增量为 `frontweb/src/api/redraw.js` 相对本包原字节基线 +65/-0，SHA `76924469b752a1546c2a675e30a722eb2a2e7c8ceb5758f93cd4cf7e8f2603c1`。新增 5 GET / 6 POST 保留原始响应、安全回执和错误对象；GET 无 body，POST 不自动重试，动态人审检查键原样保留、每值仅传 basis/result。有效 RED 为 27/0/27，全部因缺少方法；修后同一测试为 **27/27、native 0**，无 skip/cancel/todo/timeout/stderr，Node 15908 已退出。首次测试发现入口失败单独保留，不计产品 RED；改为同一文件直接入口后成功运行，未增加读取或子进程许可。

本轮 API GREEN receipt `.codex-staging/g4-run-ui-20260908-r1-api-green-036589c0c29245349113debecdfb8614/receipt.json` SHA `67e464365abc6e4154a471fcbcc4ff03ed26275c5790f5045e1fdf647ec32aeb`，TAP SHA `28adfd93877d8731f2781b949f9290aa7f1034d5a6e2c9cb75b4fd517e63d776`，root 已全文回读。480 个父来源只放行明确 API 增量，其余无意外漂移，本轮运行前后相同；不称 HEAD 已包含未提交改动。组件完整运行/暂停/恢复、人审媒体界面、浏览器、多输入、合成导出及真实交付仍未完成。本轮无供应商、付费、生产、模型或 Git 写入。以下阶段状态为历史时点。

组件首小组现已取得实际 RED：8/0/8 均为 `RedrawExecutionRunPanel.vue` 缺失断言；无依赖/bootstrap 失败，stderr/skip/cancel/todo/timeout 为 0，Node 43280 已退出。receipt `.codex-staging/g4-run-ui-component-20260908-r1-group1-red-5c708d591a134106a57e32cd7385d826/receipt.json` SHA `71355eebbc215f1e16610e8dc2b5abc4888ba88456363c3eeb1ac20164478c1e`；480 父来源和 88 个固定真实依赖文件在运行期间不变。依赖根实际位于兄弟工作树，正式测试仍使用正常包名，由本地专用 preload 定点解析，未把本机路径写入正式测试。新增 Vue SHA `352618634b83eed15f280793a2f56e62d8b23d14f8a1d9dc5edebbfa27cb99c1` 后，首次 Green 尝试仍为 8/0/8，但均在测试 harness `new Function` 形参构造处报 `Arg string terminates parameters early`，不计产品 RED 或产品验收。失败 receipt `.codex-staging/g4-run-ui-component-20260908-r1-group1-green-ec8b7573a12447f99e1e281616292535/receipt.json` SHA `44b39e61cac650eb43f770c08857d035e692fcf6b7504ea096b96607d5c8a1b8`；480 父来源、88 依赖和当前 Vue 运行期间不变，进程已退出，无超时/残留。仅修测试加载器后再执行；不改父页面或冻结 API，组件未完成，不作为用户可用功能交付。

组件加载器已最小修复：不再把整个 Vue namespace 展开为 Function 形参，仅注入实际绑定，不改权限或产品。实际 `group1-harness-green-e5e6a0b5eb9d4e36b57e26fd1292ec15` 为 8/8 native 0；receipt SHA `9725b66afb189afa5860a7244b637750995310c0161df93cc0601cce9a04140b`，TAP SHA `e049ae0b14f2ebc916ef5ee831637953becec635c9e90c86f28dc99def9c4803`，进程已退出、stderr 0、source unchanged。但独立 DTO 窄审发现新建 run 的合法 revision 0 和正常 UUID task_id 被前端误拒，数字测试数据掩盖了这两个问题；正在先补真实 DTO 回归，不把这次 8/8 当本组签收。

**最新入场决定（2026-09-08）：G4.7核心HTTP/候选媒体允许进入G4.8本地页面接线，带一项明确非阻断后续工作。** SPEC r3正式PASS（SHA `eac3ae4281904a585443cb7968e52f3ced4ddf85e40d2f83befac746d98093ff`）；全新QUALITY为Critical0/Important0/Minor1（SHA `4a7d545c2408493d60dbdee35721e069acb4878b5b1032d4bc121c7f0cca9d7b`）。root全文核读两报告并事后核480引用0漂移，不重跑已通过命令。轻量收口`.codex-staging/g4-run-http-verification-20260908-r1.json` SHA `eb7de940abbbe4caa88f1ec90204016324ec46efd95b216748ab7d6d914e4716`的4直接引用核对0差异，关联当前23/8/43原生GREEN与完整源快照，未新建大型收集框架。

QUALITY M1是GET空JSON数组被当作空输入，只有静态证明、没有动态复现；不绕权、不写DB、不注入runtime或生成。root接受它为非阻断输入形状后续项，明确放入G6交付前的真实HTTP边界回归及最小修复，不据此宣称零findings或全部严格输入合同已满足。G4.8的GET包装不得携带body。后继唯一作者已放行原字节基线、新API RED测试、安全launcher/preload及静态入口准备；root未核准新运行入口前禁止Node/编译/浏览器运行，产品接线尚未实施。未改模型、未调用供应商/付费/生产/Git，完整目标继续active；以下各待审状态是历史。

G4.7 r3最终本地回归已完成（2026-09-08，待SPEC/QUALITY）：HTTP **23/23**、媒体 **8/8**、功能锁 **43/43**分别native0，无过滤/skip/cancel/todo/timeout/stderr，三组480引用before/after一致，root对当前480回读0漂移，所有自有顶层Node退出。新3个真实依赖竞态均409且0额外DML/transport、每个实际FileHandle响应前close恰好一次；最新HTTP无GC关闭警告。最新routes receipt/TAP SHA为`733df7cd39091223c760ef863f30eaa1447c3147deb87772d97edd35d62e49e8` / `adf08c34ed87b3768a8c14eba461e92a7ff100d3295673335980dcea5bddcf16`；media为`060a59cc0753933a0da832f2e12babf507d7438a00a44d21acacb2fbf1666c83` / `2f795d1f4eb2f36ccca92b133c5e62431612d8795198ec26c46d5aa8831f637a`；contracts为`0aef3c9168a066f53de0344d5152502a127bb8201162adf4baa99103e7bac8a7` / `c4fa1eb408d1b8ab6a80991dcc0e5a270b41eaadb4495df19daa17d2835d7438`。r3冻结`.codex-staging/g4-run-http-20260908-r3-root-author-freeze.json` SHA `6de93bf7b05dec00b4fcf314fe69f47a64c0dcc0b508ba88a0ed250caf7035c8`的36引用独立核对0差异。旧review57/adjacent136为未变服务的历史证据，不称本轮重跑；原blueprint夹具失败已更正分类。现只进入原SPEC的F1增量复核，QUALITY未开始，源码保持冻结；下文各“当前/正在运行”是历史。前端/完整G4/其余主线/真实验收仍未完成。

G4.7 r3当前状态（2026-09-08）：SPEC r2最终FAIL确认另5个直接传播的依赖失效码，报告SHA `1d4ef97e7c73e52ed664b47f690bd5000fd2d2a740f681af14afa296f46c7f59`；第一次23项20通过/3失败的receipt SHA `e326748cc2e405185285b11337595cd5819110f2651865ce3d0a5a91e739d7ae`保留，但现在明确其中blueprint不是产品RED：测试UPDATE locked蓝图撞不可变触发器。只增加5个局部409映射后focused31/30/1（receipt SHA `4905e6cfaea9822150132d5836a826d6fa1f748ad4586a6692c4c1e6640c2af0`），唯一剩余同一夹具失败；其余motion/localization的真实409和所有媒体回归通过。原500系统分类正确，不删除/弱化触发器。测试现改在两次实际SELECT之间改单一可变version.blueprint_hash，确认SQL成功并观察真实句柄关闭，产品不再修改。修后routes/media/contracts分别隔离运行，全部结束后才新冻结。第一次GC警告关联包装器未交接前抛错的条件性关闭缺口；已补测试异常回收，31项那轮无该警告，不推断成产品泄漏。正式QUALITY未开始。G4.8仅静态入场完成（SHA `a7e54705844593950eddb6b28a4b92962fa85a3abf0857705d9018e65ee0926c`），测试与产品实现0；真实policy源端epoch、safe receipt和未知防重已纳入。以下“最新/冻结/待审”均为历史时点，不代表G4.7关闭或整产品交付。

G4.7 修复后重新冻结（2026-09-08 最新）：真实新增RED为28项25通过/3失败；局部错误映射和probe失败后的原字节复核修复后，focused **28/28**（20 HTTP、8媒体）、原Review **57/57**、相邻兼容 **136/136**、功能锁 **43/43** 各native0，skip/cancel/todo/timeout/stderr均0，各组480引用before/after一致，根再次当前480回读无漂移，全部自有顶层Node退出。失败和成功原工件均保留，不相加成覆盖率。新冻结 `.codex-staging/g4-run-http-20260908-r2-root-author-freeze.json` SHA `d99013cec88c69c549ba1840ed727381ef135c97cb8165eb0aa98c2620e28398` 已回读全部receipt/TAP/原报告绑定零差异，现交原独立SPEC复核；通过后才交全新QUALITY。没有改模型、计费、生产或Git，没有真实供应商调用。以下r1失败/待修/冻结均是此前状态，不能当作当前仍在运行；G4.7整体仍待双审收口，普通页面和其余主线未完成。

2026-09-08 最新：G4.7 独立 SPEC r1 已完成，结论 FAIL / 1 个 P2：局部 HTTP 未映射实际可达的材料、制作包和源失效码，错误地返回500。审查报告 `.codex-staging/g4-run-http-20260908-r1-spec-review.md` SHA `bb132ea0dfd28237d5d0a554b246927b3ffbec7de26e1f070ca7ef5642df2051` 经根全文回读；无越权发送/重复计费或泄漏证据。root已解除该旧作者冻结，正以真实HTTP材料/源漂移、源I/O、probe启动前文件变化和候选人工拒绝补证，先保留RED再最小修复。旧16/7/136/43和冻结留作历史，不用修前GREEN代替修后验证；QUALITY尚未开始。所有执行仍仅本地隔离，未供应商/付费/生产/Git写入。下面冻结和待审文字为此前时点。

G4.7作者冻结待正式双审（2026-09-08，最新）：本地HTTP回归16/16、媒体7/7、相邻兼容136/136、功能锁43/43全部native0；各组无过滤、无skip/cancel/todo/timeout/stderr，480引用各自before/after一致，root再对当前引用逐项回读0漂移（历史入口/launcher按本次冻结SHA核对，不回写历史）。测试覆盖完整HTTP链、同一SQLite/listener重开、未知冻结防重、原预留一次确认、持久化双方失败且DB随后不可读时保留唯一任务ID、缺文件/撤权/错误脱敏、同FD换路径以及真实read回调被挂起时abort/stream-error不提前关FD、prepare最后失败清理。四组分开报告，不相加冒称去重覆盖；只有本轮顶层Node退出证据，不是OS后代census。原生数据与当前源复核见`2d18ff`、媒体逐案回读`868a65`。

作者冻结`.codex-staging/g4-run-http-20260908-r1-root-author-freeze.json` SHA `8af9b254320271263be26b3874d43baef14f3818d3029f5b93e43814c20066da`引用精确4轮receipt/TAP和最新source snapshot。修复了实际RED发现的媒体撤权、缺文件500、GET租户异常脱敏绕出及数字FD双关；没有改模型或计费引擎，功能锁清单也未改。窄审查已只读复核局部修复，但不替代正式SPEC/QUALITY。已交全新SPEC审查，产品/测试/入口冻结；UI接线及主线其他组仍未完成，fullDeliveryComplete=false。以下“正在运行/待修”均属前序历史，不表示当前仍有活动测试。

G4.7当前推进点（2026-09-08）：八个剩余执行/候选HTTP入口接线后，root-ports-green为11/11 native0；随后root-workflow-boundaries为14/14 native0、170220.2336ms，覆盖真正queued→HTTP创建/暂停/准备确认/恢复/提交/显式查询/候选读取/人工检查登记，以及自有SQLite和listener两次重开、无ID未知提交保持held和禁止重提、真实JWT及跨owner拒绝、私有参数注入拒绝。两组不相加充当独立覆盖。第二组回执`g4-run-http-20260908-r1-root-workflow-boundaries-6ec80d865f84452899935b1d6d176fd9/receipt.json` SHA `feded2c69284deaa7bec637cd393e46edec29d84e6086da2831b85bfad18346e`，TAP SHA `d9832328d9a0195a4ef7be69aa05d2f11d686a6450ff2854b6e429595c54b06a`；两组源码引用运行中不变，skip/cancel/todo/timeout为0。测试的人工检查登记是合成测试输入，不是用户实际听看通过。

G4.7待修边界：新media负向回归`root-media-boundaries-red-cf9ad85f3c3849bdbbc6318f926e2f78`为4项2通过/2失败，缺实际结果文件500而非409，流创建后停用成员仍200，已读取真实失败栈并保留全部日志。额度只读查询恢复可用后，全新独立窄审查另外定位新GET租户SELECT异常绕过局部安全响应，且提出数字FD显式destroy/手动close双关风险；该窄审不是SPEC/QUALITY终审。根正以fs.close与closeSync实际观察和异常响应测试补证，尚未宣称修复。源码继续本地冻结运行，UI、相邻回归、完整双审及整体交付未完成。下文入场/第一段/增量RED均为此前历史。

G4.7第一段本地GREEN（2026-09-08，未双审）：原作者和窄media检查者因usage limit终止，root接手唯一作者；其部分消息不计SPEC/QUALITY。已实现实际HTTP创建、只读发现所属run及受控候选媒体。根无过滤focused5/5、native0、57863.4296ms，480引用运行中稳定、顶层Node退出，回执`.codex-staging/g4-run-http-20260908-r1-root-initial-green-4fe788a51745424e85f06f1ca51b041e/receipt.json` SHA `07d5892d8c9fcadffdc2cd6d4431acf4bd14dac867bb606f4297b96f82350449`，TAP SHA `3e17ff9677f69128dbbb9ca26bec9a9890d04bb0248377547e263dc26c9394c8`（根回读`7bf083`）。包括真实注册/JWT、GET未初始化tenant零DML、候选实际HTTP字节/SHA/长度/返回文件ffprobe；候选此轮由实际服务dispatch创建，尚非HTTP advance全链。原DNS入口误拒、下载URL对象夹具错误及真实缺路由RED分开保留，模型没有改动。新增六项HTTP推进/暂停/解暂停/恢复/审核连接正在增量RED；后续安全/恢复矩阵、相邻回归、独立双审和UI仍未完成，不能关闭G4.7或整产品。

2026-09-08 续行：G4.7唯一作者正准备真实JWT/自有随机HTTP运行接口与候选媒体测试入场，尚无本包测试结果；根不重跑已关闭G4.6测试/收集器。并行只读G2消费者复核已结束，确认SourceDialogue/Fusion/Blueprint/前端voice-cluster四个必要兼容点，NativeAnalysis及AnalysisWindow不因v2增加产品改动。精确RED落点已并入唯一主计划；该映射未执行测试或改变产品、数据库、媒体、Key、网络及Git，不计为长音轨修复通过。继续单产品作者→SPEC→QUALITY→根回归，完整目标active。

G4.6本地关闭（2026-09-08）：服务端推进、显式解暂停及两种提交前中断恢复通过作者回归、独立SPEC/QUALITY和根回归。根advance无过滤24/24、native0、384372.4823ms，receipt SHA `0976ade6c3fedc43de71b810b6c7a3744f9472981f4a70a4714eaa91c8589a08`、TAP SHA `626c05b1af8899d2ea7e1de1aca92fda4b81e8010f4c0c6235dc40b4e360daf7`；根compat无过滤141/141、native0，receipt SHA `34fa6c9d517a1b2a5e73ef21a3d7f54b45085725f237041b573b42772c3a4ba0`、TAP SHA `e837eaf7a544ad43dc26df16fe87451be7b374a74580fe6c4759f5b82dd5b16a`。两组415引用运行前后稳定，skip/cancel/todo/timeout/stderr0，顶层Node退出；根读取实际日志/回执（`cce2df/8c7e58`）。新累计`.codex-staging/g4-advance-resume-verification-20260908-r1.json`为145339B、SHA `768570735981253587c93d8338065590fbe6fbd7f12d4842fb70867bcd0eed5a`，累计178源/283工件/1父/2文档，共464引用经独立回读0漂移（`cb2f67/4ed458`），并核对1760份历史父源完整字节副本。作者216/216与141/141、根24/24与141/141分别列出不相加；所有历史失败保留，旧累计器未重跑。本轮收集器native0但外层未捕获stdout，因此以实际新文件存在、内容和逐项hash回读作为生成成功证据，不靠空输出猜测。文档hash是采集时点，以下待运行/待审文字均为历史；fullDeliveryComplete=false。下一唯一产品作者仅接普通鉴权HTTP及受控候选媒体，之后接UI；没有供应商/付费/生产/Git写入。

G4.6双审通过并进入根回归（2026-09-08）：全新SPEC报告14769B、SHA `4349f30b7764ee2f604b41f3b19742c19f5c303bae98a7c92b3a2487028885c5`；全新QUALITY报告13935B、SHA `259689db6a09169ce404eea0e00fdb180590382b77b036d39e85e0df48c7d3e3`，根全文亲读并核对（`18498b/5f82a1`）。两审均0finding、tests_run=0，出口源和入口哈希稳定；不把静态审查算作新测试。根在冻结7项匹配后执行同一已审launcher：无过滤compat为141/141、native0、9436.7402ms、source_unchanged=true（`0cbaf2`），目录`g4-advance-resume-20260908-r1-root-compat-green-3b7e4b4e95dc4f25a83fab3b738e276f`。无过滤advance另在运行中，未提前标记通过。新累计器仅完成语法检查native0（`ed29fb`），尚未生成累计关闭证据；旧累计器未重跑。所有改动/测试仅本地隔离，不能据此称完整G4或客户交付完成。

G4.6进程证据措辞限定：各原生receipt的HasExited只直接证明本轮顶层Node退出；正式测试确实await受控Child的close及媒体调用返回，但`activities_remaining=[]`本身不是OS后代进程盘点。此前CIM查询被拒且未重试/提权，因此不宣称已独立盘点所有FFmpeg/FFprobe后代。下文“进程退出”按上述范围理解；该静态审查局限独立列出，不伪造全OS清场证据。

G4.6作者最终冻结（2026-09-08，待独立双审和根运行）：无过滤focused七文件216/216、native0、1310476.669ms；无过滤compat两文件141/141、native0，两组分别报告，不累计为去重覆盖。focused receipt为191340B、SHA `0ffdc66c90bfa1d7ab1c2ce214257e4abb121cabec897af73de8a95e2da710ae`，TAP为1734481B、SHA `1becc7bb65ed801ac8bd91cc52845439677fdf30c9e6d36ef4d741ff1f555607`。根读取75顶层案例和216原生计数后，独立核对全部10轮before/after各415引用一致、0skip/cancel/todo/timeout/stderr、进程均退出（`32de54/121cd4`）；不是把包装命令退出码当测试结果。冻结`.codex-staging/g4-advance-resume-20260908-r1-author-freeze.json`为45367B、SHA `4a7a3bd0b3207f0cf84de1bb50a133a729bf0a2e974e91f249976f7d82bcae66`，根完整读取非重复字段、10轮分类和当前5源/3基线/2入口，并独立复核452实际引用0漂移（`9e8897/121cd4`）。此前大JSON读取的输出截断未作为完整引用验证，改用结构化逐项哈希后才确认。两份主文档历史hash不回写；10轮失败与成功工件均保留。唯一作者已退出，已交全新SPEC；产品继续冻结。HTTP/UI、全量、真实新视频和用户验收仍未完成；下文“focused运行中”均为冻结前历史记录。

G4.6扩展矩阵与兼容进展（2026-09-08，完整focused仍在运行）：过滤14项首轮11通过/3失败，根亲读`4bfca4`；两项新guard业务CONFLICT被旧client统一包装为PREFLIGHT_INVALID，一项测试execFile注入未命中真实媒体路径，分别归类且保留。实际双Child竞争有SQLITE_BUSY和总1POST，未知/已知显式恢复与首候选真实审核后续行已在该轮通过。随后安全回执3型正式RED为3/0/3：主记录失败、备用亦失败、失败后无法读DB，根完整读取`60c908`；仅新advance保留原dispatch脱敏结果并停止提交后的DB回读，private guard仅重抛本次闭包自身确切错误。真实FD close注入断言命中1次，补free三个存储阶段及已claimed解暂停只写run。定向GREEN `guarded-receipt-free-green-f832dc008f0f42b2a895c26597b29696`为9/9、native0、137965.5253ms；receipt SHA `9ae7248a27dd402c4d7e9eba646e5233b65a6d63ca7c95715fe6bff1e252d852`、TAP SHA `afb9ba42eec8b663712f14f25d978ee18e13a5dc1a56d45dd519be221a618d07`，根读取`bca0be`。无过滤compat `final-compat-6e6c0c16ab5e4f529276488c6e7bc046`为141/141、native0、8678.1886ms，确为Run.test+featureLock两文件，不是历史含SourceConditioning的146套；receipt SHA `dcc87c08821c53537d5bf8de6ac1c64a19c5b03c54267461245fa58de053d9fe`、TAP SHA `22430d08dbf7ae82b48a8128c18dc7b7d62f3f38149935edd695a16c69d26b52`，根读全部141顶层项及计数`6a4108`。两轮skip/cancel/todo/timeout0、运行中源稳定且对应进程退出；focused/session50444尚未终态，不提前交双审。固定三二进制经实时SHA核对`8f05d2`并补启动前硬匹配；仅测试入口安全加强，未修改二进制/模型或下载依赖。各轮不相加，不称完整G4、HTTP/UI或交付通过。

G4.6基础三阶段GREEN（2026-09-08，未冻结/未双审）：`three-phases-green-temp-root-f9040003a39c4cde8514473b6e9fdfd5`为3/3、native0、48757.8498ms，两个真实重开SQLite的Child均native0且只调用一次底层合成POST，沿用原attempt/quote/已存在hold；根读取完整有效TAP及回执（`a47bc2`），独立核对运行前后415引用0漂移、父回执未变、stderr0（`6e4d78`）。receipt SHA `f4b898ecac89655ac719ba594cd48c6d42e3b0805f28826df9e41c8c65561987`、TAP SHA `61d81d4d3c11364be312e3aa9fdbd49350ceb915c6b2644f133ea1985685dbbe`；Node34476/session86904已退出。此前首GREEN为3/1/2、native1，两个Child因测试把tempRoot放在storageRoot中被既有安全门禁拒绝，0POST；根核对真实SourceVideo约束（`4b5a45/fd8e1a`），仅新测试改为受控父目录下独占兄弟temp并校验身份后清理，产品门禁未变。该失败receipt/TAP SHA为`8dbd42a314a1f41f27edebe6ffe109cc78cc3124ffdb115b5fbda6798c91b4d4`/`16983e7e6172902279d618d312938f41fb6a584ded52745a02a3a7f29d7605fd`，原始目录保留。415稳定仅指该次运行，不冒称仍在扩充矩阵中的当前源已冻结。后续允许同一隔离launcher以显式Node参数按测试名定向RED并记录pattern，最终完整回归必须无过滤；本地3项不等于整个G4.6、HTTP/UI、真实质量或交付完成。

G4.6正式首轮RED已核实（2026-09-08）：目录`.codex-staging/g4-advance-resume-20260908-r1-three-phases-red-9504b324a4174d6d8a1af197c8c33d82`，3项0通过/3失败、native1、33273.8109ms，skip/cancel/todo/timeout/stderr均0，source_unchanged=true。三个反例均先走真实隔离SQLite的idle暂停、claimed_unbound、claimed_bound状态，再因缺少`inspectExecutionRunAdvanceReadiness`入口失败；不是夹具或供应商失败，未启动Child。根完整读取非迁移TAP与回执（`55e605`）；receipt SHA `b3b4a226f4d3611b82c11662ddb60f6ec245677967fdbd6aaffa1a9a05e0a7f0`、TAP SHA `c1fd6877e76c7bac23a2f3b5f00d2e8823bdb855a950ab9269a65c2b779e3017`。Node40880/session23703已退出。已开放同一唯一作者的最小实现；随后根完整读取新测试的自有PID树退出保护（`253820`），允许仅本轮自有子进程树清理后执行最小GREEN。3项并不覆盖完整恢复矩阵，仍须新增策略/CAS/重复推进/竞争/未知态反例、相邻回归、SPEC/QUALITY及根验收；不得称G4.6或完整产品已通过。此前一次文档插入因不完整行锚点在写入前失败，没有修改历史证据。

**最新本地里程碑（2026-09-08）：** G4.6服务端推进/恢复已在G4.5候选技术复核、人工审核、原积分确认和批准后顺序放行基础上通过本地双审及根复核。作者聚焦216/216、兼容141/141，根推进24/24、兼容141/141，各自native0，重复覆盖不相加。下一执行点为普通鉴权HTTP与受控候选媒体，随后接普通UI。G1.1–G1.3b、G3.1a、G5.1a及G4此前局部成果保持；G2长音轨、G3其余多输入、G4完整页面执行恢复、G5其余合成导出、G6全量/真实/用户验收仍未完成。完整目标仍active；本地未提交证据不是CI、真实质量、用户或生产交付。

G4.5本地关闭（2026-09-08）：累计`.codex-staging/g4-unit-review-verification-20260908-r1.json`为97458B、SHA `de4b6cbb3a963f453aa44859466fe0ac3195acff192bdda021b644780558cc76`；根生成与独立回读176源/230工件/1父/2文档共409引用0漂移（`1454ea/c23932`）。根审核receipt SHA `0accb94ebb34e4f89f11de0e67caa6071a3066555f6341b61710122f33ee4253`、TAP SHA `11b05c97b9b792768340dc702d57f0940d7a951ab77211fb5f4bc904a46fbcc1`；兼容r2 receipt SHA `57c4127af7d4ff7e2cfbae56acbb0ce41a6389593cc2b8fcabfb1bc06a9ced9c`、TAP SHA `95ba8437e98c464ed6d3e5f6b00655ed0f7f66438df9d94a913d227a6cc2064d`。两组skip/cancel/todo/timeout/stderr0，分别363/365受验引用稳定，全部进程退出（`4d2692/71c5b1`）。原兼容失败及作者10轮原始证据保留；累计首轮仅因PowerShell单测试列表序列化为字符串在写入前停止，根只规范该精确单元素表示后成功，不改历史日志或测试。文档hash保留采集时点，以下中间状态仅属历史。fullDeliveryComplete=false；未测策略切换、独立review多进程、HTTP/UI和最终声音合成仍明确留在后继门禁。此后才交全新唯一G4.6作者；零真实Key/供应商/付费/生产/Git写入。

G4.5作者最终GREEN已冻结（2026-09-08）：review/claim/TaskBinding/dispatch/providerAssets/recovery六个文件合计192/192、native0、902446.4257ms、skip/cancel/todo/timeout0；363引用在运行中不变。根读全部顶层TAP及原始计数，当前源/历史工件无漂移（`b5b499`）；receipt SHA `b53f65c36f7917e99ef2d4040d481d9a232279769eb408197935f6ec5686dac9`、TAP SHA `05be2eda5345f1414d86050adce8d06f69874821a09037dad81e2d18c665f263`、stderr0。唯一作者回执`.codex-staging/g4-unit-review-20260908-r1-author-freeze.json`为25945B、SHA `b07cab4b9abdf90be02ab84d3c5d3f62d4215f79c790d72a5f2e149943155f18`；根全文读取并独立复核41引用及3固定二进制0漂移、HEAD匹配、activities=[]（`df3467/d9bed4`）。8个产品/正式测试文件已冻结；运行后只新增待root执行的compat选项与说明，前后hash分列，不改写原192项回执。策略动态切换、独立review多进程和完整重启/HTTP/UI/声音合成仍未测；当前尚待QUALITY与root，不是G4.5或完整产品交付完成。

G4.5独立双审已通过（2026-09-08）：SPEC报告`.codex-staging/g4-unit-review-spec-20260908-r1.md`为15496B、SHA `38a733933c5dd3b5b4622d788a717539aefc1a9cb0480da7f712d25ad4485da4`，根全文及哈希回读`a33d55`；QUALITY报告`.codex-staging/g4-unit-review-quality-20260908-r1.md`为10516B、SHA `9540c2a05a2889fc4b1bc8b85d6c82063601406fa89ad16225c8a9fbd1218dcb`，根全文及哈希回读`272274`。两者均无本包阻断发现，六份旧文件精确父差异、八份冻结源出入哈希0漂移；两审查者testsExecuted=0、activities=[]，不重复计算作者测试。产品继续冻结，root兼容与审核套件、累计证据回读尚未全部完成，不提前交下一产品作者。

G4.5根兼容首轮146/144/2失败已保留（2026-09-08）：目录`.codex-staging/g4-unit-review-20260908-r1-root-compat-green-500f49e7fde846359d0f301746d894c3`，receipt SHA `879df23ff0ed2b280395a4bd1bc020706a3399d5b3e9850c0706760612afcb80`、TAP SHA `78c377d98fedeee9a05f6589c178c0d47a2a7b390341b331f0d5a3fcabe181c1`；native1，skip/cancel/timeout0、source_unchanged=true、Node47596/session83686已退出。仅功能锁39/40报INVALID_BASE_REF，root全文读审计CLI并以真实只读Git对照确认：empty PATH为ENOENT，固定Git PATH后隔离配置需精确safe.directory，补该进程级值后HEAD^正确解析且native0（`5adef2/2ba155/6aff2e/8be057`）。这是启动器依赖缺失，不是产品RED或业务断言放宽；原8源、功能锁及原freeze/runner保持。仅新增固定Git二进制/最小环境的r2兼容入口，待根静态核准后重跑；独立review套件已在原无网络入口运行，不把未终态写成通过。另一次根只读引用命令把不存在的artifacts字段当数组产生非终止错误，未作通过依据；修正字段路径后41真实引用0漂移（`a4798f`）。

G4.5剩余矩阵真实RED（2026-09-08，历史失败保留）：`remaining-real-red-a1fb0c217f52469a8e3640aa07d44776`为51项47通过4失败、native1、0skip/cancel；4失败包含一个父聚合，实际两类缺口为paid/free未看听拒绝DTO误标human_reviewed，以及最后真实材料handle.close后原reservation.updated_at漂移仍批准。根读失败栈及TAP末段、核对receipt/TAP SHA（tool `44818a`），分别为`f0f25ad849584e5130ffca05dab474db5143e12884dbd8dd6786a2d97082205f`、`51bc69c929a2a90ae69bb7f19e1c2472a0baf3300c7820ee6a5c82221cbaf72d`。本轮实际safe receipt恢复正控、replace候选与混合赠送/普通积分确认已通过，但不代替完整矩阵；此前46/44/2由夹具路径和合成TTS凭据引起的失败单独保留，不算这两项产品RED。作者已最小修复，后续focused见上段；不得以51项或此前12项局部结果宣称完整G4.5、HTTP/UI或真实交付通过。

G4.5正式RED（2026-09-08）：新测试先用真实隔离SQLite、已审核多对白pack与真实合成MP4走既有dispatch/下载/候选落盘，再调用缺失的unit read/review。首次结果3项、0通过、3失败、native1，全部是候选创建和文件SHA/字节断言之后的缺服务断言；不是fixture/隔离错误，也不是供应商生成失败。根亲读完整非迁移TAP、回执并复核363引用0漂移（tool `b6e1b9`）。目录`.codex-staging/g4-unit-review-20260908-r1-initial-red-cdbf8f19265d4589b2b63cbbfb21f5f9`，receipt SHA `be831dd4765f70863254a989fcb006efa0a53866bc2fc5757aad670678276b95`，TAP SHA `f09cc26141a4b03bf6a8f00f5c1afafcfc76ec325057ee496d166a4c9c6b4b5b`，stderr0/skip0/timeout0，进程已退出。已向同唯一作者开放核定范围GREEN；G4.5仍未完成。此轮所有POST/GET仅最低层合成替身，真实供应商/付费/生产操作均0。

G4.5首段GREEN（2026-09-08，尚未双审）：初始真实候选3/3通过；随后新增反例先后确认缺ctx/db错误码、任意task.result被接受、伪quality标签放行及末单元只看前序status的问题。已窄修并取得`successor-completion-green` **12/12、native0**，包含真实planner两个完整parent（5秒+7秒）、两次真实本地候选接收、批准→第二领取、审批人/CAS漂移阻断、第一review或输出字节损坏时拒绝最终批准，及最终completed保留pause_requested=1。根完整读非迁移TAP及回执（tools `00ba71/43f415`），目录`.codex-staging/g4-unit-review-20260908-r1-successor-completion-green-5c46afd113f94471b4e6521285f58fac`；receipt SHA `81faec654fa5f97ad86b6a8f2b81021adf60863c0920d5be19b74b9840ea649f`，TAP SHA `955063c7438a6a520067d254dc60ce044cf11a746aa4d18c5690d51a437ad378`。此前一次FFmpeg同名临时文件冲突如实记为fixture失败；仅在新测试用唯一子目录修复，不覆盖原媒体、不改产品模型。拒绝/replay/账本回滚/漂移完整矩阵、相邻回归、SPEC/QUALITY及root最终验收仍继续；12项不与旧套件相加，不是HTTP/UI、成片、CI或真实客户验收。

## 主线与版本

2026-09-08 G4.4b本地关闭：累计`.codex-staging/g4-unit-dispatch-verification-20260907-r1.json`为86956B、SHA `ebe05076932277f059b93a3875985829f32f9c03cf978299de984046f42ba505`；根生成及独立回读174源/183工件/2文档/1父共360引用0漂移（tools `9ed5fc`/`52dfab`）。最终SPEC SHA `e28acd3dfdfc70a7c8039034a06478e54a675ba46c189b60036862bdf4885a5b`、QUALITY SHA `663e9b5554b873dbad5dbbb9266ac30f734b1e8cbb8dd550bbf7be87cb69b249`均通过，前轮各finding关闭。root另发现旧导出exact断言遗漏新增方法，正式RED98/97/1后仅改一行，原suite GREEN98/98；其receipt SHA `c76f928438f231da755a6703dfc32012805fc73cfd8596b336d932fecddc2a37`，含实际多进程登记/只读恢复/pause竞争，不等于跨进程POST测试。旧49/354的未执行测试清单引用保留原hash，由test-only补充映射精确绑定唯一变更，不覆写旧证据；产品字节未再变化。文档hash是本指针更新前快照。候选仍waiting_review、积分held，未自动内容QA/批准/推进后继；零真实Key/供应商/付费/生产/Git写入。

2026-09-07 G4.4b r2审查结论：聚焦45/45、根相邻354/354、独立功能锁43/43均native0且无skip/cancel/timeout/stderr，178冻结引用无漂移。三套receipt SHA依次为`7dabb2768dfcf78f7183973c6a388d680ce3e657dac828f160f5566d74861a7b`、`13486387b58d296a5c54ea95b333e6c83cbc1a6b96a438efde6ac1ef851cbcbf`、`0ec5e02c98836175b55dd71e8644c672e5da4dd17fce81bf8c2de2bb0c7af5d6`。SPEC r2 PASS关闭此前Key/价格及显示几何两项；QUALITY r1另发现marker末检未保护task与原held冻结绑定（报告SHA `20e512f376bdaae7d235d3983f40e84d9127835851efc1ba5af843f064785dcf`）。root完整亲读报告及精确产品路径后确认，开始同包最小TDD补修，尚无该新反例的运行结果，G4.4b继续未关闭。审查均只读原测试工件、testsExecuted=0，不重复累计覆盖；不改旧失败工件或声称真实生成/完整QA/普通页面/整产品已完成。

2026-09-07 G4.4b首轮冻结回归：作者focused40/40、根独立相邻354/354及功能锁43/43均native0，无skip/cancel/timeout/stderr；178源码快照在两套root测试前后另核0漂移。相邻原receipt SHA `5b2fe5e05bff8f950a6cc893a9addd2bfe51af41a89db973d7c87574319f3f03`、TAP `f45eec68cb58c2f9f3c550c6fb07aa8279ed84a34416620199af29141dd8f645`，实际175引用前后一致；功能锁receipt `5b25a5553daa81afc2584b38abbccafba82f530049dc450d400f73c8231ef416`、TAP `474acc6161152bc4e6f901f17d3ec9867c561b40a3087203d32948c7b0d1d585`，实际145引用前后一致（root `e9cb53`/`2c14bb`/`2eb88a`）。这不是G4.4b关闭：独立SPEC正在核实实际显示比例SAR/rotation、提交marker后报价/有效连接末检两项边界，尚未取得双审退出。保持唯一作者、零供应商/付费/生产/Git写入。

2026-09-07 G4.4b局部GREEN与G2正式产品RED：首条审核pack→真实签名素材handler→完整目标对白/名字→提交前数据库marker→最低fetch单POST→同attempt持久ID主链已1/1（root回读`5a6510`，receipt SHA `0a759cb30a7436592d35cec7531a59ec13d4fef7e1c0793343c819cde5292a7f`、TAP SHA `a58506f616e5a1a34c93c03e0a94b2f51a04cb218eb3a53607a907172fa49b1d`）。素材安全/兼容RED 12/8/4（含父聚合失败）复现MIME不符、合法大动作参考被新128MiB限制拒绝、图片原20MiB限制缺失；修后12/12，原20MiB图片/200MiB动作导入合同保留，旧resolver恢复同FD流式SHA，handler发送已验证字节。root完整非迁移TAP及receipt回读`bddd73`/`f7386e`/`159019`，GREEN receipt SHA `cce899ba209871d79099078495d43226bace52141252eef8fc84607075543ef3`、TAP SHA `b18df33a9722067e1bf1cd91daed1026e134aac69dce109cd3ab063e5274cbda`；两轮171引用各自前后稳定、无跳过/超时。大文件仅验证发布与旧resolver，不冒称整个prepared链大文件已通过；第一条GREEN亦不覆盖之后修改。查询恢复/账态/结果下载及独立双审仍在进行，G4.4b不关闭。

G2在G4短暂源冻结期间经root静态全读后实际执行一次：真实一小时源片→真实FFmpeg→115,200,078字节整轨WAV→唯一底层Worker替身，因超过64MiB返回`AUDIO_PATH_NOT_ALLOWED`，产品映射为`SOURCE_AUDIO_ANALYSIS_FAILED`，正式RED为1/0/1、native1，非夹具错误。root回执`g2-source-audio-windows-root-20260907-r1-bb31a2f3217844cb8003b7b3d8d54534/receipt.json` SHA `5f52e7d27d1ddd3dd70ddd11c08eec782a0cdfc4c67cedc8f5f314eefc823695`；原始TAP SHA `437284628d559fa48bb23855ee5734aa6c93c5fca5b65229cf04d13be8c9ef67`、Worker观测 SHA `d43b76c9ef15358f1ec1808758a57d06319b965d670476d7c7907618fddb4ace`。120引用前后/回读不变，源MP4/WAV不变，stderr/skip/cancel/timeout均0（tools `80ca31`/`9cf313`）。只有测试准备，未修改G2产品、未运行真实ASR或验证接缝；默认测试套件的显式local-only skip不计通过。G4作者已恢复唯一产品写入，G2保持冻结；全部零真实供应商/付费/生产/Git写入。

2026-09-07 G4.4b正式RED与入场：G4.4a累计`g4-unit-transport-verification-20260907-r1.json`为46338B、SHA `9567706e6ae85734f0f545370f65a0d32c5e101ad467c2e7f29bc6a41dc4c935`，root生成及独立回读165源/46工件/2文档/1父共214引用0漂移（tools `7896b8`/`0d7810`）；文档hash为当时快照，不回写旧回执。全新唯一G4.4b作者已准备真实单元测试；原fixture只增加审核前hook，默认行为保留，6产品尚未修改时root独立运行最小主链RED：真实审核pack、两张身份PNG、一段动作MP4、完整多句目标对白/角色名字、claim/bind准备通过，唯一失败为`dispatchClaimedExecutionUnitTask`未实现，不是fixture错误（tools `ba0344`/`f949e4`/`5b65d2`）。native1、1项0pass/1fail、0skip/cancel/timeout、stderr0，171引用前后及当前一致。目录`g4-unit-dispatch-author-20260907-r1-red-dispatch-r1-ae59c3a8b0b84454a3d110f82e51873f`；receipt SHA `82b06c2f69d54faa56996b32eb86fecd7d011d5125faefba8ee1ffd8b44097ea`、TAP SHA `7cfa8324c76eb50d65f3d517f9237f20111ab16c8b522b1b2beb38be4d1d3174`。进入唯一作者最小GREEN，仍不称实际素材发布/提交/恢复已实现或验收通过；所有网络仅可底层合成fetch替身，禁止真实Key/供应商/付费/生产/Git写入。

2026-09-07 G4.4a最终局部门禁：r3将一次标准百分号解码后的Key比较收敛到URL/ID共用校验，保留正常opaque ID与签名URL原串；畸形百分号ID按不安全值拒绝，不据此退款。新增ID反例RED 261/255/6，修后261/261及有限相邻281/281；query响应ID原本安全，不算额外原始泄漏。root独立281/281（目录`g4-unit-transport-author-20260907-r1-root-regression-final-r3-d273f2956232436cb70c0b2334c6b82f`）及最终功能锁43/43（目录`g4-unit-quote-root-feature-20260907-r1-g4-unit-transport-final-r2-93bea672423a4761884803cfbc4eeb20`，tool `b50710`），native0、无跳过/超时、源码前后稳定。作者r3冻结SHA `3552d12f5e8b5d8a68b3afc8169acb5dd53c525dfae34ac53c6380dc4aef14ac`；独立SPEC r3 SHA `ccb565e9604374d6fd88ce01ec44c9612f02512bc166e56a50291c672c2918c9`、QUALITY r2 SHA `befae68de8a5f5791d70681c4741b0e2d68e38801687e6c668d2f3b9b95a6a14`均通过，两个原finding关闭、无新finding。两审不额外计测试。汇总入口`.codex-staging/g4-unit-transport-root-closeout-20260907-r1.cjs`绑定当前165项源/测试与各原始回执，输出`g4-unit-transport-verification-20260907-r1.json`后须独立哈希回读；旧FAIL、r1/r2和父G4.3保留，不改历史源码hash。完整Feituo router/DB/media套件仍未运行。本段只证明低层端口，尚未实现素材发布/生产prompt/数据库提交marker/结果QA/HTTP/UI；后继作者在累计证据核对前仅只读准备。零真实Key/供应商/付费/生产/Git写入。

2026-09-07 G4.4a 编码回显修复复审：最低 fetch 反例 RED 为 252 项中 216 pass / 36 fail，旧 210 项和正常签名 6 项未回归；仅在结果 URL 校验处增加一次标准解码及查询参数解码比较后，作者 transport 252/252、有限回归 272/272，root 独立回归 272/272，均 native 0。作者 r2 冻结 SHA `5625918476fa91c8b393981ead83cf33a2833fea9fffe79dde8f98056010ca09`，root 当前 20 项引用加 2 项历史引用核对无漂移。SPEC r2 SHA `2908e0e58eb4c7c495ffdc594ab118c494b7c97295bdc7cee68eb768eed1c42d` 为 PASS，原 finding 关闭，已转新鲜独立 QUALITY；本包尚未正式关闭。旧 r1 的两个源码 hash 为历史快照，不再冒称当前值；旧 FAIL 与全部日志保留，其他旧客户端/父 158 项未变。

2026-09-07 G4.4a 独立复测与审查：root 核对作者冻结的 26 项直接引用无漂移，独立有限回归 230/230、功能锁 43/43 均 native 0、无跳过/超时、前后源码一致。SPEC r1（SHA `8ce6cb946b1d18d4476de2d5e924f0b8a704a598c423c82c158b16da2808d68f`）为 FAIL：部分百分号编码的当前 Key 可以经候选 URL 回显；这是合成源码路径的缺口，不是已发生生产泄露。回交原作者先做最低 fetch 反例，再最小修复并重新冻结；未进入 QUALITY，不关闭本包。`success:true` 可能是请求包络而不是视频完成，不凭该字段改动现有业务失败语义。旧冻结与所有测试记录保留，新测试通过前不以旧 230/230 覆盖该遗漏。

2026-09-07 G4.4a 入场（未实现/未验收）：G4.3 父累计 SHA `f73189216bead5b3d594cd8c8dd020c4261017b81dd599e39f55e62a0f15e74f` 已重新核对，HEAD/dirty checkout 未切换。两项只读映射确认：低层三协议客户端裁剪响应会丢失 ID/状态冲突，现成 static factory 不绑定 prepared owner/SHA；均不是模型不可用或需要改模型。主计划补齐单次 submit/query 端口合同，已派全新唯一作者准备2个新责任文件与隔离TDD入口，旧三客户端不改。后继仍需 owned 字节发布、完整本地化 unit prompt 和 run marker/结果/恢复连接；新端口不会冒称这些已完成。本轮零网络/供应商/付费/生产/Git写入，未复用旧付费授权。

2026-09-07 G4.3正式局部退出：根完整读取独立SPEC `50b4159b52797af807c85764adc264fce991a8b6fb66ebfbf4d6f6a7c2db141d`与QUALITY `97c0151978bef2ca8feae86b4eccc683a9df92d0fc022c7395bbfdd9d5c9d38d`，均无finding、testsExecuted=0、activities_remaining=[]。作者、root原生业务与功能锁验证分别保留，不重复计算覆盖率。累计`.codex-staging/g4-task-binding-verification-20260907-r1.json`为55836B，SHA `f73189216bead5b3d594cd8c8dd020c4261017b81dd599e39f55e62a0f15e74f`；生成及独立PowerShell回读158源/91工件/2文档/1父共252引用0漂移、native0（tools `450ecf`、`23ab25`）。文档hash保留本指针更新前的采集时点，不改写旧回执。`fullDeliveryComplete=false`，不声称实际供应商提交、HTTP/UI、结果QA、恢复、合成或完整交付已完成；未执行Git写入、网络、真实付费或生产操作。后继只沿唯一计划连接实际执行链。

2026-09-07 G4.3修后业务回归已完成，等待独立双审：作者九文件390/390，root独立绑定54/54、task/provider保护36/36，各native0、0skip/cancel/timeout。根功能锁首次42/41/1以`FEATURE_LOCKED`阻断unknown-state三服务缺本轮登记；追加精确登记反例RED43/5/38（逆向历史读取依赖新层导致传播失败，并非38个产品缺陷），再仅追加该功能unlock并完整保留旧history后GREEN43/43。root登记逆向恢复原整份清单canonical SHA `31ab78c8c58142d855026394c6daf968705836b7db9585426799811beee4ea10`，不改任何保护项、验证器或requiredTests。作者最终receipt SHA `b103c649f4392018b761fdab927116c6beeea61403c2e19f16a6b239d3b2261c`；root binding/guards/feature SHA分别为`d8baf8d83cf048a27e16e0b828c3333b774704bda11dbec9b7fa4891350c340c`、`10fdf7b3c02791a248107effa61980a65637383f641ee1db84a5e556d41a2676`、`984fedd91adb78c69582b9e2e814269257255a1f8ae8b14f24fba4fbaa331616`。原业务160引用是测试当时快照；root后改manifest/test两项以独立feature新证据覆盖，其他158当前无漂移（tool `ba636d`）。不因纯记录变更重复长业务回归，不把各套数字相加为覆盖率或客户验收。

2026-09-07 G4.3首轮局部GREEN已根读回原TAP与receipt（tool `015a55`）：binding 36/36、guards 36/36，各native0、0skip/cancel/timeout、stderr0，160引用前后稳定。receipt SHA分别为`d0c73556a1bd6d22873422a613dc74d028c2a55e06faad4f7cd3eae38b9e2982`、`b2ef72b65d1ac2869448f930c93abe200b62994561c4d49634ab5912f99fc1d8`。根随后明确补充存储损坏INVALID与非精确确认CONFLICT的区分，并核准新增定向RED入口（launcher SHA `70eb18f8c7e5fc065264e0256231e917bcff4535ce8475fb22d24a080818f619`、test SHA `0e9d2c58efbebe2048aae65dc3ebf6f9cea7716996ff0652170bac294d78610b`）。本段是中间验证，尚非最终回归/独立双审关闭；不重复累计测试数为功能数。

2026-09-07 G4.3正式RED完成并根读回原TAP（tool `aee3a8`）：`red-binding-718920bff795479b880873dce6df59ef`为3项接口缺失断言，native1；`red-guards-8d5181458be84843b2a8c595b513448b`为36项31通过5失败，native1，其中包含一个父级聚合失败，不等于5个不同缺陷。实际反例为直接超时错误退款、provider超时/legacy两路径错误结算及startup错误标failed；都使用独立合成DB，无route保护，不是fixture/launcher错误。两轮160引用前后一致，0skip/cancel/timeout，activities_remaining=[]。已交唯一作者实现GREEN；尚无新绑定成功或修复验证通过结论，未写真实账户/生产库或调用供应商。

2026-09-07 G4.3入场：G4.2全部活动终态后，创建全新作者返回`agent thread limit reached`，工具未提供释放已完成子代理的接口。根已向用户明确说明流程降级，复用已空闲的回执恢复worker为本包唯一作者，重新提供完整独立责任与TDD合同；该worker此前未参与G4.2实现或两阶段审查。仍保留实现→独立SPEC→独立QUALITY顺序，不开新用户会话/工作树，不并行产品写入。当前仅准备新测试、完整字节baseline及新隔离启动器，未经根静态核准不得执行测试；没有真实任务/账态或供应商验收结论。既有G4.2冻结工件保持原样，后继源码变化必须记录新哈希，不冒称仍是旧冻结版本。

2026-09-07 G4.2正式局部退出：SPEC SHA `24559cd184715be2e80ee7f1ca70eb0588acb88d8291b35defb9d1f43bae4242`、QUALITY SHA `23e7f85ca9865f2aa6a8cfa804ad85a953945d84013d7399b5fbb4c33033590b`均无发现，两审testsExecuted=0，作者及审查活动全部终态。根生成并独立回读`.codex-staging/g4-claim-verification-20260907-r1.json`：50080B，SHA `f8fc8ff9da868822410bf083671bbf3074db4131dac1bee6d82f3fec57ca5792`，149产品源/74本包工件/2文档/1父共226直接引用0漂移（tools `157d09`、`9522d9`）。作者full300与根claim32/storage98/feature42分别保留原生证据，不相加覆盖率；11历史轮次由作者closeout引用保留，未复制534父工件或重新跑已完成测试。本包仅就绪/领取完成，零任务/预留/真实生成；free与approved夹具不是实际计费/质量验收。当前转G4.3，`fullDeliveryComplete=false`；文档hash为本指针更新前采集时点，不回写旧证据。

2026-09-07 G4.2修后整组回归已终态：`regression-final-r2-8eb8c61316b74005bfb5f1f4328161b5` 为300/300、native0、0skip/cancel/timeout、stderr0；receipt SHA `8b62165d5120ad4d7dc05ea3544ff96be43a65d7d508995f6d0a7e65e09555c1`，TAP SHA `13c1cc4db7551227ede88ef7d3464049dda59a688d1bc5afb38e0e87b53c151f`。根独立重新读取151引用，当前0漂移，activities_remaining=[]；原作者会话和process handle在续行后已不存在，由只读回执恢复子代理整理终态，不重复测试或重启实现。本包仍等待SPEC→QUALITY，不因为300绿灯就宣称完整执行或产品通过。前段“整组仍运行”为历史时点，以下旧失败继续保留。

2026-09-07 G4.2仍在验证，未关闭：已实现只读readiness、独立运行确认hash、首次参数冻结及原子单元领取，仍零预留/任务/供应商。真实双进程均在零attempt时经历SQLITE_BUSY，最终同attempt且仅一个newly_claimed=true。恢复兼容反例先RED后GREEN：semantic readiness不再重复绑定revision，CAS仍由quote_hash严格绑定。随后两套整组回归都299/300，发现新顶层依赖初始化sharp破坏旧纯存储导入环境；保留失败记录，改成仅新路径需要时惰性加载，未放宽旧断言/preload。根修后独立claim32/32、旧run98/98、功能锁42/42均native0/0skip/0timeout/stderr0；receipt SHA分别为`950ec15bd3d78696a1295eb8703ec91c0e115c6879e80d88b87039489ba4e751`、`46c872943786bc4906aa02367ba9ae530f400d51b4bb8fe2525a963d44c6a7bc`、`b96fb65bab06f75231aa6f8f98e2484d070d1a6ee0d20ef30b5cebbd690a22eb`。前两份各绑定151源/入口引用，旧功能锁入口145；不相加为覆盖率。作者修后整组regression-final-r2仍运行，SPEC/QUALITY尚未开始，旧299/300不能冒称当前全绿。HEAD未改变，仍本地dirty实现，不是已提交/CI/真实视频质量/完整产品验收。

2026-09-07 G4.1已最终关闭：累计`.codex-staging/g4-run-storage-verification-20260907-r2.json`，173832B、SHA `9dbeabce93fba884819bfb89dfc2be1fb9065524bb715fec6cc53c2756ee2e13`；147源/534工件/2文档/1父共684引用经根另一次独立PowerShell读回0漂移。作者98/98与420/420、根独立420/420和42/42均native0；原P1与PATH中间失败保留，修复未改四份运行时/queue源。SPEC r2 `1525cdf771e04bbc0f690168cc2d4c04af6c4e4923bbdc66991ae763fe04cdba`、QUALITY r2 `9cbcfc60a3e589a3c3102875a9e6cc6873801db6cba5dff006498ff7c7a85848`均无发现，审查者testsExecuted=0，不把重复用例相加。六个实际child证明SQLITE_BUSY竞争、同run、GET零写、pause一次成功一次精确冲突，以及新helper的11项拒绝/空PATH/默认临时日志。仅Windows实际执行；未运行Linux、全量npm test或Hosted CI。全树ttsService旧diff-check非绿不掩盖。HEAD仍8c49a907的本地dirty字节；没有实际claim、预留、任务、供应商或生产操作。累计文档hash为本指针追加前快照；当前转入已定稿G4.2本地实施。

2026-09-07 G4.1存储逻辑作者与根独立回归均416/416、功能锁42/42，SPEC通过；但QUALITY确认正式测试依赖未交付的staging preload及Windows固定Node路径，干净checkout/Ubuntu CI不可用，故本包尚未关闭。正在由原作者做测试入口最小可移植性修复，保留真实两进程CAS与隔离防护；上述绿灯仅对应修前冻结字节，后续需重新回归和复审。本包不创建实际任务或付费预留，完整G4及产品交付仍未完成。

2026-09-07 G4.1已进入唯一作者本地TDD准备，尚未取得本包通过证据：范围固定为迁移77、新run service/test及最小历史queue读取入口。根复核旧queue完整字节基线与live一致（service SHA `0baf7c3ef17e34050d514d2f127db884685e2ee7896a8684ec48c5628a777221`，test SHA `d7d6473ffe6f65be81a19ff44d7b9ba225f8f803162627c46437a1cb8832f447`），完整隔离launcher SHA `34f3b9eb273d442ac04e20e9853cf684a0b583213e567d6aba4eb657aeea1fcd`获准。重点为owner/队列关联、两个独立进程并发防重、历史GET零写、pause revision CAS和未知状态不重试；本包不创建真实attempt、任务、预留或供应商调用。HEAD仍为下述8c49a907，未提交源码不等于当前HEAD或CI已包含实现。

2026-09-07 G4.0g逐单元只读报价已完成作者→SPEC→QUALITY→根原生回归→累计独立回读。累计 `.codex-staging/g4-unit-quote-verification-20260907-r1.json` 83378B、SHA `282119b0c77aafe773ceb6693a566f93570190e982b2b27f07792379aec2eafc`；143产品源/232工件/2文档/1父共378引用0漂移（root `1608e3`/`9fc76e`）。新服务95行与新测试323行，实际复用原calculateCharge，原价格服务及父140源均未改。显式分辨率/画幅、实际生成时长及顺序、free/paid和所有金额绑定quote_hash；缺价不当免费，非法/溢出阻断，始终executable:false。

作者RED 4pass/30fail是固定blocked尚未实现的正式行为差异，不是缺文件；新34/34与相邻366/366native0。根独立相邻366/366及单独功能锁42/42native0，均0skip/cancel/stderr、145源及启动器引用前后一致；不把作者/根的重复用例相加为新增测试数。真实两连接WAL记录当前完整旧价77、下一次报价free0，query_only/SQL追踪/total_changes/schema断言均通过；seed与第二连接写入明确属于合成夹具，不是报价DML或真实计费。根回归receipt SHA `3243d8c66d1c20b8b57b1df10605527b9f1d90afda7c3b68068a316289be50c9`，功能锁receipt SHA `0ad852fd540fac3d3bc2bb8abc65ca035394b9bdfce7ad4f0ee7136147e95e03`。SPEC receipt SHA `227b2e0d6d949e0d00af64abc411c26e8a7cdefae459d6718fd6b5029d39d93e`，QUALITY receipt SHA `066a7f11d9eed44c7ef919bb7db3033dad7d43524b0b137fd6f62354d9e8ac1a`，均无发现/无活动；两审testsExecuted=0，亲读原证据，不冒称自身重跑。

本次仍为HEAD `8c49a90773a4311992e4eb9b6a5bc2c9acdfa4ed`上的本地dirty字节；不证明owner/review/素材/执行就绪，不创建reservation/run/HTTP/UI或供应商任务。未读真实Key/配置/价格/账户，未联网、付费、生产操作、部署或Git写。旧G4.0f的2个退休端口测试排除保持原状态。本累计的文档hash是收口时快照，随后根只追加本指针和后续计划，不改历史receipt或冻结产品源。

2026-09-07 G4.0f 已完成唯一作者→SPEC→新QUALITY→根原生回归→累计独立回读。累计 `.codex-staging/g4-selected-readiness-verification-20260907-r1.json` 73660B、SHA `7d63756c03970d98ccdc668717f2a62f53aea4053943e91fafac22f4357bdd42`；140源/203工件/2文档/1父共346引用零漂移。作者332/332；根374/374和既有TTS HTTP兼容28/28均native0；不能重复累加fixture导入的测试数为新增功能数。SPEC receipt SHA `9df1460baec1ba668ca7119ed1cf7d52818e842d4b92c63dd958a952b2d87508`、QUALITY receipt SHA `e24efbee7a13c26410e5cc6d011baa06a1ab1f44f617c83018c65b0917bf79e1`，均findings=[]。仅六份责任源/测试变化；精确已选配置/音轨不改选、连接优先级沿用现有实际客户端，公开状态和私有指纹分离，仍`executable:false`。未改模型/线上配置，未调用供应商、付费、生产或Git写入。

根启动器历史如实保留：r1清env缺Git目录、r2缺沙箱SID对应的精确仓库信任，均只导致2个Git基线测试失败；r3完成374功能回归，但negative name-pattern未排除2个退休端口测试，被原网络guard拒绝。r4用显式skip-pattern后两组native均成功；Node24.17省略这2项而非记入skipped，旧启动器因此仍写valid=false。独立解释 `.codex-staging/g4-selected-readiness-root-20260907-r4-interpreted.json` SHA `b1958d593c7312d0b5daf201213077eb37b31f8b249baeed895c0088a795a89d` 逐项确认r3全部30名称减精确2项等于r4全部28，保留原记录、不再跑测试，QUALITY再次独立核对。排除的2项不是通过或native skip；全程未弱化network guard。Git修正仅本测试进程固定PATH与精确safe.directory，禁用global/system配置，未改全局Git。原untracked preview无独立旧源快照，只有父hash/原基线记录和保留的原测试完整字节；不冒称任意输入数学等价或真实生成质量。

2026-09-07 G4.0e普通单元素材HTTP/UI已局部关闭并完成累计独立回读：新receipt `.codex-staging/g4-materials-entry-verification-20260907-r1.json` 59168B，SHA `4fd0b89ad2ae488f012e0000032caabf3522baf042f31f76b3044d4e7b5f44c2`；136源/142工件/2文档/1父共281直接引用0漂移（根tool `428640`），HEAD仍8c49a907…的实际dirty字节，不是提交/CI。修后根81/81（Vue39+锁42）、独立SPEC原样反例1/1、真实自有loopback浏览器1/1，均native0且零skip；未变后端421仅继承修前r1，同一42锁不重复累计。浏览器GET7/POST1、在途刷新GET1/POST1/零写、同child保留、旧回执不回填、显式GET恢复真实5秒动作MP4；cleanup全通过。SPEC_PASS关闭S1，QUALITY_APPROVE/0发现；累计fullDeliveryComplete=false。

审查记录纠正亦保留：QUALITY首次误把AUTHOR freeze当SPEC并写出hash mismatch，根现场确认两者本来就是不同文件；corrected receipt SHA `af3c5e959772c4f9931a9b2639ad667a6219e7ddf8e49f6df00539e15aa244de`为最终代码审查依据。该审查者额外104/39项未按要求从OS-temp/preload启动且未持久rawlog，明确排除出正式测试和隔离证据，不能事后冒称已受guard保护；本包测试完成依据为根、作者与SPEC已保留的受保护原生证据。后续子代理任何测试先报启动器，由根核对后才能执行。原审查和失败工件不覆盖。现在交新作者G4.0f exact-selected执行前复核，再接run/attempt与报价/恢复；不改模型、不读真实Key、不付费、不部署、不Git写入。

2026-09-07 G4.0e冻结后根回归已459/459/native0（handler9、相邻205、Vue38、routes/source207），136源前后稳定；根回执SHA `e63d48b80d2ca45ed8a5f744d3a0730166adee75a232be1f440ece3f4c20a6be`。冻结浏览器1/1/native0，回执SHA `f9f66a84a834413c4b74f67ab9635023e7a351fd9118ec2011c1264e9b18d037`，实际GET7/POST1/刷新零写、cleanup正常；根亲读实际JSON和截图并ffprobe五秒合成动作参考（tool `22b16d` / `f542aa`），仍非转绘成片质量验收。独立SPEC另以真实父子模板编译并mount重现S1：首次POST未完成时父刷新卸载child，新child可再次检查并POST，post_count=2而非1，native1（根读回tool `bf9213` / `21d364`）。因此上述GREEN不能关闭本包，QUALITY尚未开始；须先保留child跨父刷新实例及在途gate，正式RED→GREEN并重审。根所有测试已终止，产品仍冻结到SPEC收执后交原作者最小修复；不改后端/模型/账态，不扩大为跨浏览器全局锁。

2026-09-07 G4.0e实施进展（未冻结，未双审关闭）：已接入单元素材GET/显式本地prepare与实际父/子页面。作者前序handler5/5、Vue及旧审核/队列38/38、功能锁42/42；后续处理证据失效及源I/O分类仍在补正式反例。隔离浏览器r2实际1/1，GET7/POST1、刷新零写、页面/外网错误0，自己的HTTP/context已关闭且新临时页目录已清理。根亲读原始report/cleanup/素材receipt并看截图（tool `08b9b1`），另独立ffprobe/hash（tool `e32658`）：动作参考12774字节，SHA `a0112b3585855f487a8946b3ce7cb8aef9ac6e4f7d052df6f1011bb20e32bbfc`，96×64/SAR4:3/DAR2:1/5秒/无音轨，与本次动作素材DTO一致；这是合成测试动作参考，不是480p转绘成片或声音验收。r1浏览器因重复tracing.start在打开页面前失败，后续EPERM遮蔽首因，轨迹仍保留；修正测试生命周期后新r2成功，不覆盖r1。旧派生回归首次240秒超时不计通过，单独r2完整22/22，prepared33/33。以上浏览器在源I/O小修前，仅属中间证据；最终冻结源码仍须独立SPEC/QUALITY及root回归/browser，完整G4和整产品均未完成。本轮仍零供应商、零付费、零生产/Git写入。

G4.0d累计生成与独立回读均native0（tool `d3f446` / `1f92f1`）：`g4-prepared-reference-verification-20260907-r1.json` 44228B、SHA `64c434e800de1b7a1be27bf749ab112b8e828067573424945835af519a7ac9cb`；132源/73本包工件/2文档/1父共208直接引用0漂移，另校验父177工件。旧失败与历史报告均保留，旧文档指纹保留采集时点，不回写。`fullDeliveryComplete=false`；本地G4.0d及Q1关闭，但HTTP/UI/readiness/run未被本回执冒称通过。全部作者、审查及根测试已终止后，才交下一全新唯一作者G4.0e；当前继续本地TDD，零真实Key/供应商/付费/生产/Git写入。

G4.0d 双审与根完整回归均已终态：SPEC_PASS报告SHA `32c297b61712c21fca070290c13cd3570056ed38b51691cc662ff6d596427751`（根 `01a86f` / `5e2fa1`），独立missing记录迟到竞态1/1 native0；QUALITY_APPROVE报告SHA `cbbff5ef05a2f789dd49b876da450befb8271995f8246d2f4c9605e38160af67`（根 `510ee9`），Critical/Important/Minor均0，独立真实FFprobe取消probe1/1 native0，已观察callback/close、零检查DML/文件变更/资源残留及重新读取恢复。根已亲读两个probe实际源码与TAP（`b1793b` / `6ca7c6`）。根完整新prepared33、原derivation22、旧合同172，共227/227，fail/skip/cancel0，三组native0、132源前后一致、diff-check0；回执 `g4-prepared-reference-root-20260907-r1.json` 60502B SHA `1645a7cd6cfbf97f12ddb82b5345ad9794768f3b82e82f554fe94cbea20ca5cd`（`3b672e`），session66625已退出。作者及两个审查者活动均已关闭，源码保持冻结，当前进行本包累计证据回读；只在成功后才开始G4.0e新作者。上述是当前本地字节的局部通过，不是新HEAD CI、真实英语/人物、整个G4或用户交付通过。

G4.0d作者最终冻结已根亲读及核对（tool `e8b503` / `c74d3c`）：freeze SHA `4bd92f32126233a3d58e14d2003e9ca5306d7cc7697305db73e6b1936eedd273`、report SHA `2595959adb12f42316e02de8acc365d41fc86c5268e76ee8a59d38d0ea152a11`，132源/23工件0漂移，activities_remaining=[]。3责任文件最终SHA为service `581e6307da8d4e36c659ab4ea32d411218b965824dcc10c5b6b09b7cfd0d47b7`、新test `960c9f5ac82015d0dd012d07907c3c341e222991905474063d9cdc7728ec9f4f`、旧test Q1追加 `e3621fe1af879df713c8b71768ac47dde212525065967a8af46cc476d98f775b`。正式RED2+7预期失败native1；新33+Q1 1+相邻4共38/38 native0。一次不存在placeholder入口的MODULE_NOT_FOUND单独保留为命令错误，不计产品RED。全新SPEC已接手；根完整prepared/derivation/legacy在冻结源上并行启动（tool `d486c8`，session66625），尚无终态，不称完整回归通过。QUALITY仍在SPEC最终PASS之后，下一作者须双审与根累计回读均通过后才能写产品；如需修复先停止/等完当前测试收执。此并行仅缩短纯本地测试等待，不扩大Key、供应商、Git或生产权限。

G4.0c累计回执已成功写入并独立逐项回读（tool `60ffa0` / `c57733`，native0）：`g4-unit-derivation-verification-20260907-r1.json` 67827B，SHA `3cf98db83f30e260b2bb48642630b414bd45b26017b14d3d8018fb03a57885b2`，131源/177工件/2文档/1父回执共311直接引用0漂移。`fullDeliveryComplete=false`，Q1明确保留为Minor，不称零已知缺陷。全部前置作者/双审/根进程关闭后才派发全新唯一产品作者G4.0d；旧累计文档保留采集时点，不回写历史。当前新包仅本地读取已登记材料及其Q1修复，无新增外部、Git或生产操作授权。

G4.0c最终根回归已结束并读回（tool `7a5366` / `ccfdaf`）：新派生21/21、旧unit/obscuration/feature172/172，共193/193；两组native0，fail/skip/cancel0，131源前后一致且diff-check0。回执 `g4-unit-derivation-root-20260907-r1.json` 58050B，SHA `c923ad12076278d23c5cdfba393f6c291fe12ea69ae33d7ec8e281e1c2521aa3`；两组TAP SHA分别 `0f620e341efa0e8f1f516a2149c7db6598b0bf9bea877fdcc6f4dbdebc40ea46`、`85a25ca68ec4df428ffa8724226ffbe90a3f5d735fbddcd7cec0e77171defa38`。根进程已退出，无在途媒体测试；进入本小包累计校验，保留所有原失败与合成媒体，不把本地通过冒称模型/人物/英语/CI或整个G4完成。唯一已知非阻断Q1如实保留并已在下一包计划登记。

G4.0c QUALITY正式APPROVE，Critical/Important均0、Minor Q1一项，报告 `g4-unit-derivation-quality-20260907-r1-report.json` SHA `a626e033d01fb01d6fd722b8d9648794eeb241a969c0a3876554fb95a19dfab7`，根全文及真实probe/TAP读回（tool `191d2c` / `470edc`）。Q1为已成功清理loser目录后再cleanup误附ENOENT，STALE拒绝/历史赢家/零新增登记仍正确；观察探针1/1 native0只代表现象复现，绝不是Q1已修复。计划G4.0d已承接正式RED→GREEN。根最终新suite已21/21、fail/skip/cancel0、551109ms，包含当前S1与普通125帧真实媒体；旧unit/obscuration/feature组仍在运行，不提前记整轮完成。QUALITY与SPEC均已关闭活动，全部产品源码继续冻结到根终态和累计回读。

G4.0c S1修后作者freeze-2 SHA `69d0943331ee26ab7ee6dc477b90626b51c9d9f9788c7710ec8fce7de7598806`已根读回，正式RED1/1预期失败native1、邻近6/6/native0及131当前源0漂移均核对（tool `538552` / `29edab` / `983930`）。独立SPEC r2原探针保持不变2/2/native0，报告SHA `dbbc4b65d99c9a68484f9ea5c5f1c212913e2fb46b83ee03a1f830deaec70976`，根全文读回tool `cf5196`，S1关闭。随后启动全新QUALITY；根在同一冻结源码上并行启动最终新派生suite与旧unit/obscuration/feature回归（tool `26b124`，session14534），两者仅独立临时fixture与工件，零产品源码写入。只有双方终态通过且根累计读回后才交下一作者；审查若要求修复，当前测试仍只能算修前SHA证据。后继G4.0d只读消费合同已在唯一计划固定，并经独立静态核对可实施，尚未编码或计作完成。

G4.0c SPEC独立审查终态为REQUEST_CHANGES，仅S1/P2：`mkdtempSync`实际成功后首次目录`lstat`注入EIO，`owned`尚未赋值，输出空目录真实保留而错误缺少`cleanup_code`；零新资产/登记仍成立。报告 `g4-unit-derivation-spec-20260907-r1-report.json` SHA `54e57274c3e060fa562613f30ad9e19fbc9b3ab3efe66dba1297a3dfa41032df`；根读实际探针/TAP/源调用栈（tool `6fd94a`）确认。两轮分别2项1通过1失败、3项2通过1失败，native1且无skip/cancel；赢家字节交换拒绝、整父/跨父正控通过。不是目录替换成功或数据库回滚失败，不要求扩大清理/全局原子锁。作者仅补未知身份残留的诚实报告及正式RED→GREEN；不开始QUALITY或后继产品写入。双连接证据仅为同Node线程异步媒体准备并发与同步immediate串行发布，不能称为同时多写事务证据。

G4.0c 作者已最终冻结并进入全新SPEC（尚未通过双审/根全套）：`g4-unit-derivation-author-20260907-r1-freeze-1.json` 52048B，SHA `81399838e44ed01cdd79732f05b059987b5a6e5f8a7b31bdc5a294a089b4262e`，根读回8责任源码SHA/size无漂移、前序非责任源无漂移、activities_remaining=[]（tool `5f62ab`）。最终新service SHA `49744094fec0986a241f3e3da712703e8d5873c044a7ec9f749b90b3a49017d1`，新test SHA `91260c4e30981571bb4ece75833d5f65253427c92c0d20eab9376cee4da6a2b5`。末次首stat EIO的有效残留报告RED→6/6定向GREEN native0，回执SHA `eb6bc52a6629a28463da685a834cfdd0522a4128f97b1a6ea6f74dab349962c5`（根tool `88e4d2`）；创建后身份尚未知的文件保留并报告cleanup_code，不猜归属删除。先前媒体/安全19项绑定修前service，作者逐组注明，不冒称完整20项已在最终SHA重跑。旧unit77/77、obscuration54/54、import40/40、motion+feature79/79、processing-bind9/9各native0且相关兼容源未变。根已准备新的完整derivation+旧unit/obscuration/feature runner，仅语法检查、尚未执行，等待SPEC→QUALITY。旧Windows目录替换EPERM未实际命中、fixture错误、注入未命中及诊断换行错误均原样保留分类；本阶段没有真实供应商、Key或生产/Git操作。

G4.0c 两组真实媒体GREEN已回读（tool `85c943`）：普通25fps单元1/1/native0/129.49秒，回执SHA `e3ddf345bc54f055781fed2d0b1622d554f6fa4fde0a986a31b1224a2f20ae59`；帧内起点/尾帧/单帧/全父复用/跨父/分数tick媒体组5/5/native0/144.475秒，回执SHA `d45c1c7fdac954634ffc7eedc9f1654e2260dc5e3686d1013c38814ecdcb9e33`。根对保留的普通单元独立4次FFprobe及SHA/proof envelope读回全部native0：实际125帧/125包、每帧2560tick、总320000tick=5秒、96×64/SAR4:3/DAR2:1、无音轨、父300帧且所取序号125–249。根回执 `g4-unit-ordinary-media-root-20260907-r2.json` SHA `3e7b8e1dfd320dcef838192766deb9f31be88f2272c0367b7c840d9c2580b51e`（tool `a83765`），三工件前后稳定。根r1错误地把完整output envelope的hash与其nested proof比较，在启动FFprobe前退出；原失败保留，r2只修正这条审计字段路径，不改产品/媒体或放宽检查。当前安全/原子性与旧合同回归仍在运行，尚未冻结/双审，不称完整G4通过。

G4 后继 selected config/capability 只读映射完成：报告 `.codex-staging/g4-readiness-selected-config-map-20260907-r1.md` SHA `e76e8e02037f33c6d6c0382fa41a0490e7a852bc4e60d12f782a75ed22ff4717`，根全文读回tool `ba5618`。确认只锁config ID不能阻止提交层换成该配置默认模型；默认选择器还可能通过listConfigs写default标志，不能充作只读检查。计划已补精确video/TTS选择、实际protocol/model/证据及凭据来源的无回退合同，保留各provider现有优先级和线上模型。此仅源码定位、testsExecuted=0，尚未实现readiness/claim或读取实际凭据，不把已有gate通过冒称unit已可真实执行。

G4.0c 普通帧数正式 RED 已到达真实产品派生入口：300帧的处理/导入/绑定前提通过，5秒125帧单元在真实FFmpeg处返回 `REDRAW_UNIT_REFERENCE_DERIVATION_MEDIA_FAILED`，native1、无超时/信号，回执 `g4-unit-derivation-author-20260907-r1-red-ordinary-frames-2.json` SHA `344757555785bb8b3f39d0ba9f5dda66e32b90f5cce19304a0cf28a2f672b939`（根读回tool `807735`）。此前同名首轮为合成fixture `assets.id`冲突，保留但不计产品RED。根又独立验证作者选定的平衡PTS+私有filter_script+仅尾帧setts方案：1/125/900项均native0，argv382–386字符；回执 `g4-unit-balanced-expression-probe-20260907-r1.json` SHA `dc559dfda825dcc6f470b7e974cc62aac3bfe9ea95abd0231efa155546b8b5c4`（tool `52d5bb`）。该实验只验证单帧解析与命令容量，不是900帧整链通过；正式产品GREEN和双审尚待完成。

G4.0c 正在本地 TDD，尚未冻结或交独立审查。根另以独立合成 lavfi 输入实际检验现逐帧嵌套表达式容量：100/300 项的真实 FFmpeg native=4294967274，日志明确为 `setpts` 解析过深；900 项为进程未启动的 `ENAMETOOLONG`。诊断回执 `.codex-staging/g4-unit-expression-probe-20260907-r1.json` SHA `44f08028e30214178cfb7d5d0edf9be71c28b7545262afcc3d146553b4bf660e`；根同参数 1/4/25 项正控全部 native0，回执 `.codex-staging/g4-unit-expression-control-20260907-r1.json` SHA `217f42a5112564b5ff9bc7e4546ae90d6648756a6dd96c8003a965b4f1256046`（tool `d22a0c`）。前者外层脚本 native0 只表示诊断完成，不能误记 FFmpeg 成功。已交唯一作者补普通高帧数实际产品反例及有界修复；原始日志保留，不猜精确阈值、不修改模型或缩小常见输入支持。此处无产品/数据库写入、无网络或付费，尚不是正式派生通过证据。

G6 隔离入口只读映射已完成，尚未实现/跑全套：`.codex-staging/g6-test-isolation-map-20260907-r1.md` SHA `34e99e26ebb6364eb74c1b030466b1a2c098ddbf6fe94f18b968dc56153b4995`，根已全文读回（tool `2d7840`）。默认loader三个路径在require时固定，createApp无cfg/db参数且能启动恢复/价格同步；临时源码镜像+合成YAML可保留真实loader，但原require.cache preload不等价。Git HEAD/HEAD^组、主动清空NODE_OPTIONS的发布脚本及原生DB/子进程须单列，不能扩成未经证明的“全量安全”白名单。根仅查询本机工具入口与Docker服务版本（tool `d54aca`）：docker/wsl/bash命令存在，但Docker配置与engine pipe均被权限拒绝、native1；没有读取配置内容、没有容器/安装/提升权限/重试。这仅表示本轮尚无可验证Docker隔离环境，不证明机器没有Docker或所有本地回归受阻。现有严格隔离下的定向本地实现/验证继续；testsExecuted仍0，G6不勾选。

G4.0b 累计回执已实际生成且独立回读通过（tool `7e9f44` / `86083c`，native0）：`.codex-staging/g4-unit-reference-verification-20260907-r1.json` SHA `7f3a41c33e22c906b9a11f6b5b9674fcc1e4174be6afdac3441a0e0c59a68d84`，126源、138工件、两份当时文档与1父回执，共267直接引用零漂移；fullDeliveryComplete=false。唯一新作者已开始G4.0c显式本地派生/登记，按既有六点规格继续TDD，尚无本包通过证据。独立G6协作者仅定位全量测试隔离入口，不运行应用/测试、不改产品或配置；本轮仍无供应商/付费/生产/Git写入。

G4.0b 最终局部双审通过：QUALITY r2-final APPROVE，原Q1/P2关闭，原样owner5+cleanup5独立10/10/native0、7源及26项受保护引用无漂移；回执 SHA `4fecb5897e173cc024f3d06f4c8e11ae4bcc3e0c14e57b13d8e2cf0db5f2b4b1`，报告 SHA `c3fd18a6a15a3c4a8b319de99bdf5966f2702558ad493406ee76118ee2e6f5cd`，根全文回读tool `423ecb`，原TAP已读tool `fe4286`。r2-final仅更正报告保存closure行号150→149；旧报告/回执保留，不是产品失败或额外重验。作者、SPEC、QUALITY与根测试均已停止，无产品并发写者。累计校验器将当前126源、最终双审/原生日志与历史工件绑定到 `.codex-staging/g4-unit-reference-verification-20260907-r1.json`，必须实际生成且独立回读成功才交全新G4.0c作者；旧累计文档hash保留历史时点，不回写。以下状态顺序保留历史，不代表新的未解决缺陷。

G4.0b Q1 修复版 r3 已冻结并完成新鲜根回归：作者实际仅改 candidate 记录断言抽取、unit 最终同步复用及正式测试三文件；旧 FD/path/cleanup/stream 失效语义不变，另外四源保持 r2。作者回执 SHA `66c00cef07ec9f0c12df3495c876f57d32a244b47a2b86362b1f0f9176a12b74`，正式 RED 6/2/4 native1，修后 10/10、正式套件/功能锁118/118、四份原探针29/29 native0。首次修后10/9/1是测试将自身UPDATE/ROLLBACK包含在serialize比较内的观察边界错误；原失败、SQLite头部诊断均保留，不充作产品RED，旧无写入用例不改。根独立内存还原三份前序源码 native0（tool `208e75`），已全文读作者及SPEC报告（tool `0ec9ab` / `711151`）。SPEC r3原探针19/19/native0后PASS，回执 SHA `9bb6977e87f078334ebba444d50337fc59392af3fe54a5870a68aa7c8934cb7b`。根11套512/512（483服务+29自有HTTP）、nativeExits `[0,0]`、fail/skip/cancel0、126源稳定，回执 SHA `957a2d1604c60978accc059214f8d45a1c7e87936e89c3e5254ad30fea5c0065`；原生终态及TAP已回读（tool `041412` / `02cd71`）。后续仍须QUALITY最终结论与累计校验关闭；以下r1/r2状态为历史记录。

G4.0b QUALITY r1 找到另一个既有门禁遗漏 Q1/P2，当前包未关闭：候选入口复查 active tenant/member，unit 最后cleanup后的检查却不含该scope。相同真实fixture入口禁用两例均拒绝，最后second-parent真实handle.close后禁用两例仍返回4refs。根读实际probe/TAP及原candidate成员/租户测试（tool `dbc6a5` / `8bb684` / `131e0c`），确认不是新增权限政策。独立聚焦72/72/native0，owner对照5/2/3/native1（2实质+父），TAP SHA `53401bed3431eca52f08fdd68ce771eb5308eaeb27ca47a66a648751e0d0b87a`；报告 SHA `ff1e9bafc5939467c9314f763e2abdcbdebc30c8fced8cc300307180251b5977`，receipt SHA `4b9a7b0f302e4a92cdf91625a1415176d20703c764afb98df7caad4876b8b25b`，根全文回读tool `c9ced0`。审查已冻结无活动，原作者接回Q1窄修：复用candidate既有scope/latest记录断言，旧含FD检查/关闭失效不弱化，unit末端同时执行记录与实际字节终检。此前502绿灯保留，不代替此缺陷关闭；新显式派生包仅完成实施细化，产品作者尚未启动。

G4.0b r2 根关联回归与SPEC复审已通过，QUALITY尚在进行：根11套502/502（473服务+29自有HTTP），nativeExits `[0,0]`，fail/skip/cancel0，126源前后稳定；收据 `.codex-staging/g4-unit-reference-root-20260907-r2.json` SHA `c4c474879fc7fdb38a8853a681b11561eb20b7847e3746861ba2a9c57bc364c3`，根实际读原生终态及两份TAP（tool `2643ba` / `5fa60e`）。独立SPEC原样19/19/native0后PASS、S1关闭，收据 SHA `f00e23891493c5c580d87a7f5ef134f16bb4b34a5f97b823381dc6fd2956ae48`、报告 SHA `45edc1db8df2faf7bdb00d33ff36b3fa7d382486e81a90cd15b4ac65fa5de4e4`；根全文回读tool `a32fa4`。没有因本地绿灯标记完整交付，尚待QUALITY、累计校验和独立回读后才进入下一产品写入。

G4.0b S1 修复版 r2 已冻结：仅新service与正式test改变，完整import行和嵌套完整asset行避免末端漏检及同名ID覆盖；service SHA `e3d47dd52fe5d1c46d01b332ef8e5b07ebfc3b16275cb3b0f3959e07af7694ad`、test SHA `fd9a83343ae2d10620060a808d2440e2a79e74d5062515aa42575c4f0fa6b1a7`。作者正式RED26/20/6（5个实际漏检+父测试）native1，GREEN26/26，新suite/feature108/108、原样SPEC探针19/19、unit/queue125/125均native0。收据 `.codex-staging/g4-unit-reference-author-20260907-r2-receipt.json` SHA `ebb5325bb2150721ddc8dd4f7ea7c4c1a2f0607d821d12eeeefc092347a0ebd9`；根完整读receipt/freeze脚本/修正源码/反例及RED栈（tool `1dde18` / `7bee2f`），内存回滚可重建两份r1原SHA，原四文件和探针不改。当前独立SPEC复审和根11套回归正在进行，尚不宣称本包关闭或开始下一产品写入。

G4 裁取公共整数刻度实验已补齐（仍非产品）：同一实际父片 timebase=1/12800，原请求 `[123,1137)` 不变，仅使用 `lcm(12800,1000)=64000`；唯一一次候选编码得到实际帧/包 PTS与DTS `[0,15808,50368]`、duration `[15808,34560,14528]`，总64896ticks=1014ms，H264/96×64/SAR4:3/DAR2:1/无B帧、旋转或音轨，解码仍红绿蓝。报告 `.codex-staging/g4-unit-trim-rational-20260907-r1.json` SHA `9cb1628cf6d1ce9c8a42d2744d2fe854338828930764c07b19aa660cae511a67`，收据 SHA `309392c0afc09e6ed3da635d09b8e32e3ad7649b42a6336ad9f2e1ad6ae6c61c`，实际MP4 SHA `a55da562140c1a08fabdd20e99684a5e69d2f0d03419177d7d7623ffc3c2b715`。11条原生命令exit0，根读完整脚本/回执并独立ffprobe和核7引用0漂移（tool `a1d8e9` / `db9be8`）。这证明本样本分数源tick的裁切边界可精确表达，不证明分数毫秒源帧、任意VFR或产品审批/派生已完成；旧实验及拒绝记录不覆盖。

G4.0b 根第一轮11套实际回归已结束：服务447/447、独立自有HTTP套件29/29，共476/476，nativeExits `[0,0]`、fail/skip/cancel0、126源前后稳定。收据 `.codex-staging/g4-unit-reference-root-20260907-r1.json` SHA `cee16cc584c3811574fd19e6181fbbd5790d3d17a6cca49ded6e782091c5f350`，根读TAP及原生终态（tool `b0f1d5` / `0f4104`）。但独立SPEC另有有效P2：候选初验拒绝的非法width/file_size/mime_type，在最后真实handle.close的await后变更却可成功返回；新service的candidateRow仅投影部分资产列，最后CAS漏检其余初验依赖。原探针14项10pass/4fail（3实质失败+聚合），TAP SHA `7f328830571c45c5e2ad2b2b246103eb8d58068022dffdebae7c5a4c40d0c5a8`；补探针明确changed=true/current非法/returned=true，5项1pass/4fail，TAP SHA `b3cda11d2911e770addf91fe138b5b5d81926bfce38c0c5134005fd18ece2b3a`。根读两探针及原始栈并比对既有validateMotionCandidate（tool `a63d59` / `497d24`），接受此为当前合同缺陷，待原作者正式RED→GREEN，尚不进入QUALITY或下一产品包。有效审批时间+1秒而同材料hash不变仅记等价观察，不创造按时间戳失效的新政策。

G4.0b 作者已冻结，尚待独立双审/根回归：收据 `.codex-staging/g4-unit-reference-author-20260907-r1-receipt.json` SHA `432f538f59461ac847dc5493c3433fa9f6c5a3b9d42e51f68d8c471659144576`；新材料+功能锁82/82、旧reference/motion/功能锁115/115、unit/queue125/125，各native0。最初partial夹具4秒不符合既有能力合同，已改合法5秒计划尾单元；旧失败和mutation敏感性证据按真实性质保留。另29项旧candidate HTTP测试被原断网preload拦截，原native1并非通过。根为该实际内存DB/合成媒体suite新增专用 staging guard：仅本进程自建且仍监听的 `http.Server.listen(0,'127.0.0.1')` 可达，拒绝既有本机端口/外网/TLS/跳转/默认config与DB；不是全后端沙箱。guard SHA `3eeaba802a734bec13c39638ab3bac2ae283bf227b2ca575e3e431729aa90e16`，selftest SHA `102c134be6cc8311694bd1aed1c81f36b5b0cc168bd97c42b32b50e8428dbafb`；根2/2 native0（tool `9d9e9b`），独立完整读取guard/selftest/实际suite审查PASS并再测2/2 native0（tool `d79057`）。原preload不变。当前根将服务与HTTP分组重验，实际结果未回读前不计全绿；无供应商/付费/生产/Git动作。

G4 裁取补充边界实验（仍非产品）：从第二帧中间开始 `[493,1137)` 实际保留绿/蓝两帧，PTS0/417、duration417/227、总644ms；单帧内 `[493,777)` 保留绿色一帧284ms。固定1/12800时请求123/1137ms分别为7872/5、72768/5ticks，明确零候选编码拒绝，未取整冒充精确；公倍数1/64000在数学上可表示，但本实验未验证该编码路线。报告 `.codex-staging/g4-unit-trim-edges-20260907-r1.json` SHA `80c44fda5221b1b17e47505863abe25f43d6161aeae51930e91a866b94daabba`；收据 SHA `b726c6436350bd3ef90cd5210be2b1072ff99141c011aa4a3a4a0252ef5371e0`。根完整读脚本并独立ffprobe两MP4、核18引用0漂移（tool `116ce1` / `9a79f3`，native0）。候选仍仅合成、零起点、无B帧/旋转、非方形像素；没有证明真实审批链或任意视频派生。原实验和全部失败/对照工件保留。

G4 后续裁取的单样本实验完成，尚未接入产品：原合成三帧 PTS 为 0/370/910ms、结束1540ms，裁取 `[123,1137)`。普通 trim 原生命令虽成功，却丢起点正在显示的首帧且只剩600ms；保留相交帧、钳制首PTS并修正末包时长的候选得到 PTS 0/247/787ms、duration 247/540/227ms，总1014ms，H264/96×64/SAR4:3/DAR2:1/无音轨。报告 `.codex-staging/g4-unit-trim-probe-20260907-r1.json` SHA `cf720c6dd00c41eda75df4618f694ed440f3d80642868c84095721c922d76af6`；MP4 SHA `f1491778e05b1febcc65e1cf27e24a54172ac347c8bacd9fae8eef0a8a24550b`。根独立 ffprobe 复核实际输出及14个工件引用0漂移（tool `cedc86` / `90abe3`，native0），收据 SHA `f215d382dc6ddd68c875db9bc73dbc9e909e9a8872f86ec28cc8cc474b054f54`。此仅零起点、1/1000 timebase、非方形像素的合成三帧样本；首相交索引非零、单帧、其它timebase和真实处理审批链均尚未验证，不是完整VFR/无损或派生功能通过。

G4.0a 累计回执已实际生成并独立读回（tool `9aae82` / `fe662f`，均 native0）：`.codex-staging/g4-unit-pack-verification-20260907-r1.json` SHA `5b89ed64dd743a774f2f75c7c59c19f452f3e5888e3f64b7959a95e2ed07f150`，123源、96工件、222个直接引用0漂移，完整交付标志仍为false。下一位唯一产品作者现进入 G4.0b 只读真实父材料连接；另一个独立实验仅用新的合成VFR媒体检查非帧对齐裁取，不修改产品，不把实验冒充派生功能完成。历史累计回执中的文档保持原时点SHA，不回写旧回执。

G4.0a 最终本地双审通过：作者 r3 回执 SHA `ca30ca5b8a39dec2a5cfb5194aa951b0be8134daa47a7ef5b1e194280f8014dd`；SPEC r3 PASS 回执 SHA `580a8bb4ada40d19567954e0a5102403c76f26f27d6a870c8067bceca0fcf848`；QUALITY r2 APPROVE 回执 SHA `4543dc24738c2a8a985dd3957df9ad6c6e0b8a176949a29593dc10de3aa54b5b`，报告 SHA `12007cc770de4bfbcf1b10ecb35b64978159544c10dbb51de65cd392a3146899`。根六套291/291/native0/skip0/123源稳定，回执 SHA `f66d92b28fb3269190de10bb980ff41c847e02d9073066fe3385b9627640e0a7`（tool `d15def`）；根另读完最终报告并核143引用及原生日志0漂移（tool `91a909`）。原QUALITY probe2保持不变32/32，正式43/43；完整对白、跨三父镜、长镜拆分、错误分类和源ID兼容有实际队列证据。最后两源码为 service `9594ebd1…da735`、test `f1cdbe2c…71119`。累计校验脚本仅在这组证据全部匹配时写入 `.codex-staging/g4-unit-pack-verification-20260907-r1.json`；下一作者需等实际成功和独立回读。本地事实适配局部完成，不等于 reference ready、真实生成、G4整体或完整交付。以下各 r1/r2 失败记录均按历史保留。

下一参考包修前 baseline r2 已完成114/114/native0/无跳过，六源前后未变（tool `22537f`，回执 SHA `8094c0e1a5b86e8b1de6616b8fa621b43efcae71b98a4928c69664d3a8e772fd`）；实际耗时约129.7秒，证实首次90秒仅为时限不足。此为旧参考包、motion与功能锁兼容，不是新增unit材料或真实观感验收。

G4.0a QUALITY r1 单项 P2 Q1：实际已审核队列接受 source asset `"91"`，compiler 对同一 numeric `91` 严格比较却报 STALE。根已完整读原生边界探针/TAP（32项31pass/1fail/native1；SHA `08fb66d43be789881f4ee9c7c74ffeba45ff30681fb1ca8f63b7d2e99716d907`），采纳仅源资产 ID 既有等价语义修复，不扩大其它 ID 归一化；回执 SHA `6aae04ddec1ac643ea0c94f4cb003e93cdbfdbb125597d9b97c2c67c9a38ba5e`。原作者接回原两文件做正式 RED→GREEN 后重新冻结。首次探针试图 UPDATE 已锁 blueprint 产生 trigger 错误，只是测试准备错误，已保留且不作产品 RED；有效第二探针使用追加 revision2。G4.0b 作者仍未启动。

下一参考包既有三套 baseline r1 在90秒进程时限终止（nativeExit=null、SIGTERM/ETIMEDOUT、摘要未产生），最后记录到103个已通过用例，不记为全绿或产品失败；六源未变、回执 SHA `77762b4819330dc010b1d0ce5756b60f7d1c6e2a1cb13c14a0841badc5ed9249`。只读进程审计确认无该测试入口遗留进程（tool `700462`），原日志保留；新 r2 仅将有界进程时限改为240秒，未修改测试或产品逻辑。此 baseline 与作者两文件不重叠。

G4.0a 修订 r2 的 S1—S4 已全部通过独立 SPEC 复审（回执 SHA `324570bd386103617a82914555f2bfd0632cff7857721dc004a8b6e818e4a4c8`）：原探针字节未改、34/34，正式聚焦41/41，均 native0、无跳过；跨三父镜和长镜拆分已改为实际隔离DB的 preview→save→prepare→get 链。根最终六套289/289、native0、123源前后稳定（回执 SHA `4b7f7d8e327b8435c4eda1d1bbd50a7f371a9bf7645ffdf1b3a4ec6c72ef801e`，TAP SHA `bccd7c62de0418fb96c796353a529a9b1570050e7e90d0be7bfb4f1b59d5d4c2`）。最终 service SHA `fbd3f4ff317fcf85f66e7f2e5a848985ad1d47145421c115ad94d7d0450acf52`、test SHA `d8eefa814567b6cb234aa6dcb6cd4fffdaf1682017b7c7ed11516ee63254ecce`。现进入全新独立 QUALITY，尚未关闭此包。下方 r1 记录保留为历史，不再表示四项未修复；测试导入重叠不累计为新覆盖。

G4.0a SPEC r1 已 REQUEST_CHANGES（报告 SHA `361f11e556eaf1c9a54b9f2ab76a953e106e642c53fe4686857dc0b736abe014`，回执 SHA `091a265e4394123f84e9b2fd433eb2d2e45588e6cf77a94e9c75f80cd401b9ac`）：缺全计划对白ID覆盖、吞既有蓝图错误、非法对白时间错误分类、cross3/长镜真实队列验收不足。独立34项31pass/3fail/native1含30既有+4探针，日志 SHA `5514219a4360e972dc895c6ae80d2dea976a12a830645c1120aec5bcde7e42d2`；根已读完整实际脚本/报告/TAP。漏对白是重算派生hash后的内部一致性反例，不声称当前getExecutionQueue已产出该状态或权限被绕过。仅原作者接回两文件一次修复，旧失败与根286绿灯保留，尚未交QUALITY。

G4.0a 作者 r1 已冻结（service `138df3aa48ac2b35e94fe88bde415186d41e94f30efdc74db38d69ba64714e1b`、test `16bea4a9ef2f3bf991c7b4e707d88b7697d2529ad3a411426c57495ea7db6139`）：有效 MODULE_NOT_FOUND RED native1，聚焦38/38含8自有+30导入既有测试，旧兼容248/248。根当前6套286/286、native0、skip/cancel0、123源前后稳定（tool `c0bcbc`，receipt SHA `b9265133c46a503e5c3d796858b6c25cc30f620c6d8af5fb3e6796dde7da81f6`）。此为首版测试绿灯，独立SPEC仍在审查；根已发现cross3/long-split关键测试手拼queue状态，尚不能作为实际getExecutionQueue链验收，不能提前关闭G4.0a或交QUALITY。

G5.1a 累计回执已实际生成（tool `927163`，native0）：121源、58工件、父G3链接，SHA `3505747b7056c0b25c0d310b39d5dd517c3e4ecc3d1b2025466c795b01864c5f`。根随后独立读回182引用/0漂移（tool `8356be`，native0）。现在唯一产品作者进入 G4.0a，仅新 unit production-pack service/test；既有队列登记/预览 baseline248/248 不当成新执行证明。G6清单仅346文件的分组库存（343待隔离验证、3独立宿主），receipt SHA `0849ed07891e772f54a83f62b52e4af972f473a36b3b5fbc3809c31c87913382`，执行测试0；其中G5旧测试SHA为库存当时快照，最终全套必须重算，不冒称当前全量冻结。

G5.1a 最终关闭的是本地几何与发布字节绑定子包：作者 r4、根 r2、QUALITY 各26/26/native0/无跳过；SPEC r2 PASS、QUALITY APPROVE。最终 service SHA `4e74d2d23263bdb7574e2bd0c0fbdf81f03a8939345ddffa472c65b0e8e7a5cc`、test SHA `8b22d194ce1cacf73d9c66bc163af239deaed5237feea1ec8ec80433f62b870e`，generation 依赖未变。根 r2 回执 SHA `90b1fba01234510edef13a7b4bb10f6040f2f1a05b1c2c41bd1c0448b74079f4`（tool `e997e5`），真实 FFprobe/像素结果继续保持9:16、音轨、边缘与顺序。SPEC 最初 P2 的原探针现在安全失败、0新资产；其 r2 回执 SHA `93f2f7c052257309ee0ca5eb73ede0e774a797ebddb023e96ee1d22d752b4fed`，另5/5。QUALITY 正式日志 SHA `b6f824aa0a53d12d1fc2420feaf0b752f49c92ee032c557b2c4108171b7a4ecd`，另14/14边界日志 SHA `aae857fd64d4ac8e63d714f96b82d17c6dce87b0853bc895e5b9671d518e2deb`；报告 SHA `084c42203e41ffebbbe05b622acb1bbf2618ccce8056582a1e77955aeddcdf2d`、回执 SHA `76095de424b42bf8c32fcb6c833b0c8330824eab8ef73f0cb11888801f2fbc5d`。根完整亲读最终报告/日志，并在累计 `.codex-staging/g5-composition-geometry-verification-20260907-r1.json` 验证源与证据绑定后，才开始新 G4 作者。重叠测试不累计，原生音轨、动态单元合成、真实供应商和完整产品尚未通过；以下修前记录按原时间保留，不再作为当前未修复状态。

G5.1a SPEC r1 为 REQUEST_CHANGES，唯一P2 `G5-SPEC-001`：实际probe与post-probe hash之后替换成非MP4，仍completed、3新资产且下载接受坏字节。根已读实际独立探针和native1；报告SHA `eff7262e73f754632d417a924145aaa962265a7c3290a982a79c9e80022f5069`，回执SHA `2a6a4d0e6aacb560e593cd3fde061616d77c730e57efcccf4e8c09f244035ef2`。原作者只接回发布前hash绑定修复及正式反例，不扩展文件平台；以下25项与像素绿灯属于修前冻结，不关闭该缺口。修后先SPEC复审，再QUALITY。

G5.1a 作者已冻结两文件（service `f199e0321b1c570a7f6e08c461eee295205f2025979aa1eefee9cdbceee62506`、test `ef28b84e719b3653e4455f35ab3000573e8af1ffe527a277d4ab2a812a482208`），正式25/25/native0。根独立新跑25/25/native0、skip/cancel0，并默认合成后另做真实FFprobe/RGB：160×288、SAR81:80、DAR9:16、约3秒和音轨；代表首帧46,080像素分类及外3像素边缘2,652点相对源均0差异，1.2秒后续帧全蓝，验证本合成样本的顺序。三源码前后相同；receipt `.codex-staging/g5-composition-geometry-root-20260907-r1.json` SHA `28e260721f0227e4d4bef4820462217f8edc473f21e6e9ab026004fcd0c2387d`（tool `5245ea`）。仅合成媒体的几何/方向/边缘/顺序局部证据，不是任意场景无裁切、真实对白、原生音轨或产品验收；独立SPEC进行中，尚未交QUALITY或关闭该包。

G6只读入口映射补充：当前默认glob为346个测试文件，3个涉及真实Bash/WSL-root夹具，须独立宿主隔离；其余343只列为可继续验证的主组候选，不是已安全/全绿。三个文件为 `canvasCreditReleaseContract.test.js`、`sharedReleaseGuardRotation.test.js`、`sharedExternalEvidenceOnlyTransaction.test.js`，操作目标在源码里是临时fixture，未观察到实际生产写入。全量入口必须保留真实YAML解析/迁移/磁盘DB/备份/命名管道/回环HTTP/FFmpeg语义，不能直接复用G5的config/DB抛错替身，也不能全局DB环境覆盖破坏原预填库恢复测试。后续先做最小明确隔离预检，宿主组三项和Python条件skip单列；不为“全绿”伪造命令缺失或默认成功。此处仅设计映射，未执行全套、安装器或WSL。

2026-09-07 G4 只读设计已收敛到一个 unit 事实编译器，明确完整源对白与父镜投影时间不可混用；取消额外 split 人工门禁、重复 DB compiler 和永久不可执行包状态。只保留真实准备/prompt 所需的有序视觉片段、完整对白、名字与精确绑定。尚未实现或测试，不记作执行闭环；当前唯一产品作者仍是 G5.1a 合成比例修复。

根已跑后续 G4 的既有 plan/preview/review/queue/old shot-pack 基线：248/248、native0、skip/cancel0（tool `92a86a`），13源前后 SHA 不变。使用禁止默认配置/DB/网络的测试进程 preload 和全新临时cwd，不调用实际配置；不含 G5 作者正在改的两文件。receipt `.codex-staging/g4-unit-pack-baseline-20260907-r1.json` SHA `acd3a1c8223be114aa84ef52b1bd63a6ad45d7bdabc1f8ea6f673b94f6e204ea`，日志SHA `df15edc812f7eb692c02be2e19330da24beb1da1e490fcdbd9acaac9c2c9c90c`。这是既有合同基线，不是 unit 编译器、readiness、claim 或真实执行已通过。

G3.1a 累计收口实际执行 native0（tool `484368`）：119源、23新工件、849父历史引用校验，receipt SHA `ad1c68907cae237e1395f5e32801ec4e88a300e46018ba2472b48c185437a6f8`。根又独立回读该新回执145引用/0漂移、native0（tool `efc482`），才交全新 G5.1a 作者；只允许 composition service/原正式测试修改，源码初始SHA `a1f1b18d…65cb7` / `b37ebf2f…fd7c`。G3父回执保持历史冻结，后续两文档进度更新不回写旧收据。G4 unit pack只读设计可并行，不能与当前产品写入或后续双审顺序竞争。

G3.1a 已通过独立双审并关闭该局部缺陷：SPEC **PASS**（20/20正式+3/3实际媒体边界+4/4路由；manifest SHA `f698477ed1c8a4e57bec60c2ede6537a99453071b77d8abbd2fd5cd05ccce687`），QUALITY **APPROVE**（20/20正式+1/1受控异步隔离；report SHA `38f3ca98dce9991329f1a17fdd49b78fc3bc307770bc7f6e2c304695c9c35858`，receipt SHA `332a63cdefa9a25b7ab5ae24c696ff9cbae34150308694a6d6908905de516cfe`）。根完整读回报告、实际探针及日志，结合下方根独立20/20+4/4；修复源保持 service `c54c1c76…dc4ac` / test `f062ecff…2d2310`。累计本地回执 `.codex-staging/g3-zip-publish-verification-20260907-r1.json` 保留父G1证据链接、当前源与新工件。下一包 G5.1a；不把当前局部闭环扩大为容量、多作品页面、完整G3或最终交付。

G5.1a 修前基线：根用禁止默认 config/DB 与网络入口的进程级本地 preload、显式内存DB和 `REQUIRE_LOCAL_FFMPEG=1` 跑原 composition 测试，**19/19、native0、skip/cancel0**（tool `5e47e1`；receipt SHA `df0e70f4b1ddb5f4afeca9e074578fefb7cdfdc91b6081d251b9e8ca22fe5de8`）。composition/service/test及generation三源无漂移；此处仅为旧回归基线，下面实际DAR失真反例仍未修复，不以旧测试全绿覆盖新缺陷。

G3.1a 作者冻结后，根独立上传 **20/20**、旧 createWorks 精确 **4/4**，均 native 0、skip/cancel 0，四源入退相同（tool `7231bd`；receipt `.codex-staging/g3-zip-publish-root-20260907-r1.json` SHA `853b51da7067a7e66b667cb70ce65b4e38c7167bdc65aeb32ce548bdd68f815b`）。作者正式 RED 20项中6预期失败/native1，GREEN20/20/native0，冻结 SHA `6d19ee330826d779d0d2b607c82c5549c55387bdc70132a0095f71405ab02cbe`。服务仅两阶段验证/发布、唯一索引暂存与NUL拒绝；尚待独立双审，不冒称后续磁盘/数据库失败跨文件原子性、ZIP容量或多作品页面已完成。

跨会话生产协调：我方已向 ToAPIs `.cn` 地址恢复任务回执仅本地、无 deploy.lock/候选/供应商/生产动作；本轮上传两文件与其地址恢复不重叠，未合入转绘代码不得纳入其候选。未因协调消息启动任何生产操作。

G3.1a 已开始本地 TDD：G1 页面累计回执 SHA `1468acba82c721063e92d888ab856361d317edd630f504aca4aa3a11d01c2133` 生成后，根另读回852引用、0漂移（tool `89c4af`）才交全新作者。责任限上传service/正式upload test，原route只做回归。根修前上传13/13、四个createWorks handler4/4、native均0（receipt SHA `e60cf21b53e25ea227a47e31b84bf270f6db798b73a559cf56e6e721b683f142`）；整个命令从新临时cwd运行，旧`tmp/clip.mp4`清理不会指向工作树同名文件。此处是修前基线，不是ZIP残留已修复。

G5 默认输入链反例补强：根新建隔离合成探针，清除原测试 `artifactVerifier/probeRunner/compositionRunner`，使用默认 generation 成片校验、默认合成及默认输出 probe，仍得到状态completed但DAR由9:16变5:9；最后保留比例断言native1，13个已记录原生命令均0。新receipt `.codex-staging/g5-composition-default-geometry-probe-20260907-r1-G1KfsD/receipt.json` SHA `973e1cf7076704e77f824a1bf0f6591bd54f921a17eb6278878cf368d8448e64`（tool `5d545b`），实际输出SHA `fa3af065b2e87d44bf5e81d897b117ca78bd9c1cc5a9a1ed761af82b2ca2c79e`。composition/test/generation三源入退相同；只用合成素材与内存DB，审批/TTS账态为fixture，不含供应商、真实配音或产品修改。证明缺陷不依赖原输入probe替身，G5修复仍待顺序实施。

G1.3b 最终本地收口：QUALITY r2 **APPROVE**，原 G1-QUALITY-001 关闭，独立541/541及10/10、native 0；报告 SHA `4c93ab61826e0e479d1710089aa6e3e72e596833f1ee8f51f31dfa51af81d16d`，最终清单 SHA `c7893e0732cddad9f403216d32e4317689857a5075de68846a5425ac91762dbf`。根已完整读报告/探针/原生日志后，独占新冻结验证：公开 no-env build native 0（33.76秒、回执 SHA `2f08f857c95f7bb86d2c309c7140b27afd0bb29111fec907ee1d0c58e23a633b`）；browser-r7 **1/1，native 0**（338.18秒，tool `e835a8`，回执 SHA `b20ecb701202f16ee751d9a44b13e30c252ccab7976eda1d7ecd05b9a3f8bcaa`），自有 Vite PID34016已退出；media/parser独立复核native0（tool `8991ed`，回执 SHA `be39afbef50543a4da667c6a4c875e0b99067ab8fc2aba3853e9835d049f7c5d`）。每次11源入退稳定。

新浏览器输出为真实当前HTTP处理产物：252319字节、SHA `197c85ce8648ee745365fb0a9ab777ef845db4e312524c7862de372cd8614e60`、320×180、SAR1:1/DAR16:9、48帧/包、4.000001秒、无音轨；精确比对PTS/时长/原报告和当前parser。页面四确认后导入并显式准备completed、生成POST=0。源为本地12秒/144帧合成视频；两项既有needs_attention fixture前提保持未知，未改成成功。此处不是转绘成片、真实用户登录/供应商或人工观感验收；旧schema/owner/时长失败与修前browser/build全部保留。累计源/工件/当前两文档绑定于 `.codex-staging/g1-motion-processing-page-verification-20260907-r1.json`，不冒称六组主线完成。

2026-09-07 继续收口 G1.3b：原作者只改 Step/runtime 两文件，905/905 聚焦回归后冻结 r3-final（SHA `df34a31d9b1ff3fed8cfc73150fdba85e2ec5344505f095c76cf988d9ddc2fec`）。根实际完整前端 **1754/1754、native 0、skip/cancel 0**，功能锁 **40/40**、audit ready 和 diff 均 native 0，117 个累计源文件入退稳定；根回执 `.codex-staging/g1-motion-processing-page-root-20260906-r3.json` SHA `58150c276d5983a11d17b147460337ff4864fd32d548eb78fa4287c2afe0328f`（原生终态 tool `fbe8f2`）。仍使用下述三文件精确 no-env/fresh-config 测试加载器，不冒称未经覆盖的默认环境全套通过。

SPEC r3 的审查代理在测试结束后曾遇平台额度中断，保留原状态后只完成回执收尾，未重跑测试或改源码。最终 **PASS**：正式 runtime **164/164**、独立 **15/15**，native 均 0，11 源/历史工件无漂移；报告 SHA `8d9deb1aaea146f29153ae42ff58249b7a3efab861c214ca238755854e13916c`，清单 SHA `4bddab4dbd1f7b8db06674c6fb724840f497b7e075e45f3042b709566798661c`。根已完整读报告、实际 TAP 与清单，才进入 QUALITY r2。新冻结的 build/browser/media 尚未运行，G1.3b 未关闭；不以旧 browser-r6 或旧1725替代新源码验收。

G3.1a 的 NUL 名称兼容基线已只读实测：对真实 ZIP 的两个文件名头写入原始 NUL，默认入口目前以 `ERR_INVALID_ARG_VALUE` 拒绝，storage/temp 均空，源码不变。独立 receipt `.codex-staging/g3-zip-nul-compat-probe-20260906-r1-bKXfBF/receipt.json` SHA `a5580ad193ca42fd4ded430603e0c9c69ff035878816e3942eae615254e7d6bd`（tool `8aaffc`，native 0）。这是后续索引暂存修复必须保留的拒绝语义，不是 ZIP 修复已完成。

G6全量后端入口只读审计：现有npm test等于串行 `node --test --test-concurrency=1 test/*.test.js`，无统一安全setup。config loader先读YAML再应用DB/存储环境覆盖，createApp可迁移和恢复任务；根亲读config源码确认，尚未裸跑全套或读取配置内容。后续test-only隔离必须保留回环集成/迁移/FFmpeg及原断言，同时阻断真实配置/数据库和外部连接；此处只是风险核查，不是新增隔离入口或全量测试已通过。

G1.3b QUALITY r1 随后确认一个真实owner状态缺口（REQUEST_CHANGES /1 P2）：user/tenant实际存储变化后，旧结果仍保留且可进入一次上传调用；后端鉴权未被证明绕过。四个实际auth helper反例全部native1，旧user可变读函数反例也失败，7项其它独立生命周期反例通过。报告 `.codex-staging/g1-motion-processing-page-quality-20260906-r1-report.md` SHA `1c8cc9400b5a7974701745ea22196c02c1a4c3096cb43fbe85cba0d3b201cc50`，最终清单SHA `5f15f419318b572b1024126d7833e4b3f0b5613996fedca0807e28b668200080`。原作者已接手仅Step/runtime测试修复，根未运行预备final build/browser；下面1725全绿是修前r2冻结的证据，不是该P2已经修复。

G1.3b r2 最新冻结的根全量前端为 **1725/1725、native0、skip/cancel0**；feature40/40、audit ready、diff均native0，117个累计源文件入退无漂移，回执 `.codex-staging/g1-motion-processing-page-root-20260906-r2.json` SHA `bf7aee9428203e1e291f25c6f83c858c70ba3d5fe508fab3845f7acf3f4a05f4`（tool `584d3f`）。三份旧middleware测试使用精确白名单no-env/fresh-config加载器，原测试正文不改；之前默认加载失败仍保留。SPEC r2 独立512/512及24/24后PASS，报告SHA `fb817829a30fb88287ddefdedd7e14b4f08432e1aa31d1195831578b1c5aa15d`，两项原问题关闭。当前正在独立QUALITY；新的browser/build尚待复跑，旧r5/r6不覆盖这次schema/helper修复。

G5 合成几何缺陷已实际复现，仍待实现修复：两段新造 160×288 / SAR81:80 / DAR9:16 的 1秒/2秒视频，由当前产品 `createComposition→runComposition` 默认合成命令产出3秒 MP4，状态 `completed`，但成片为 SAR1:1 / DAR5:9。根独立再次 ffprobe 与 SHA 检查确认（tool `f0bc35`）。实际输出 SHA `fa3af065b2e87d44bf5e81d897b117ca78bd9c1cc5a9a1ed761af82b2ca2c79e`；探针 receipt SHA `5bc5b8ebaa1a27661b8c110850ae6e6bf386ff7ca35a90b03800f6f18689a705`，路径 `.codex-staging/g5-composition-geometry-probe-20260906-r1-AZkXT7/receipt.json`。最后几何断言 native1，产品 FFmpeg/默认输出 probe native0；仅注入真实输入FFprobe与合成的候选/TTS账态，正弦音不是配音质量证据。未改服务/正式测试，媒体与失败日志保留；此反例进入 G5 必修门禁，不记作合成已验收。

G1.3b 作者已完成第一版冻结，回执 `.codex-staging/g1-motion-processing-page-verification-r1.json` SHA `068154d9b1ade973c8d67df54bd33af55ea347b244c8fd74141ebef8e485bb0d`；537/537、原 A/B 与新增默认后端浏览器各 1/1 为各自独立运行，不累加。根随后独立当前源码 build native 0（37.56 秒，sourceStable=true，回执 SHA `ffcdbc9e2d7e2486f7f1ec2d3689e7226033843883461ca7667dad380333c2ed`）及新链 browser-r6 1/1、native 0（tool `eb33d1`，自有 Vite PID 19144 已退出）。这些是修前冻结的技术链证据；SPEC 已发现前端报告 schema 接纳过宽与新浏览器时长容差相加问题，待原作者修复及双审后才能关闭页面包，不能把本次绿灯当完整产品完成。

根原始全量前端 r1 为 **1386 tests /1379 pass /7 fail、native 1**，日志与回执均保留。七项均在三份旧测试的 Vite 自动配置加载阶段被 esbuild 沙箱父目录读取拒绝，不是已通过。根未提升权限或读取 `.env`，仅为这三份原文件加入精确 import 白名单的临时配置 shim，直接导入原配置并使用 `mergeConfig`、`configFile:false/envDir:false`；原测试正文、断言和业务源码前后 SHA 不变。隔离复验原三文件 **8/8、native 0**，七次 middleware override，回执 `.codex-staging/g1-front-no-env-20260906-r1.json` SHA `2b0b616f1605f0e92bec793b50c6a468cc4528db965f38bac3798c82aaaa8230`、日志 SHA `bcda791c73c7fe32739a20455a5d072ce04b7cdc7df315d759bc9cbfa9896d9f`。这是明确 no-env 配置下的定向复验，不追改原始全量 native 1，不称未修改默认环境全套通过；最终源码仍需新全量回归。

G3 独立 ZIP 清理探针已取得有效 RED，未改产品：两个真实 12 秒 MP4 的合法 ZIP 默认入口通过；第二项实际 CRC 损坏时，错误为 `REDRAW_ZIP_ENTRY_READ_FAILED`，第一项新建的 1677 字节文件却保留。失败前后存储为 2→3 个文件，既有源片与哨兵完全不变，抽取临时目录已清空。最终零残留断言原生 exit 1，源码前后 SHA 不变。根亲读完整证据、实际断言及退出回执并复核 SHA；目录 `.codex-staging/g3-zip-cleanup-probe-20260906-r1-media-GURvom`，evidence SHA `9bfda7cdaa995c9af4e850ce01f39c51924652e7cba78bdc78cc94af92e1cf39`、native-exit SHA `565604952549f03aef0c46a2014388d849dc45538a8505166fd05a22721770e3`、日志 SHA `8bc93de7bb72313323ab7a4939f7f5a7149858b2257c2d43541b47ee46abfb6a`。不冒称原子清理已修复、容量已采用或多输入验收通过；复用此最小实际媒体反例进入后续正式 TDD。

G1.3b 已开始：G1.3a 累计回执 SHA `1039309f5add326bf013b931d6eff1862c7e1b406836d1aa22ebb8aa98a4144c`（113源/369工件/7声明变更）生成后，根独立读回485引用、0漂移才交给全新页面实现者。根仅给 `redraw.episode-blueprint-first` 追加页面本地授权，旧记录完整入history；授权正式RED1fail→完整feature40/40、audit ready:true，native均按各自结果保存。当前feature文件SHA `4505fae0cb186e64369b74737ce558b73ca3744b689a800823544899b02c8c88`，测试SHA `ee3d592c46bcd1066362e66111d28dd79cab541767c206902f5578f4840fd9a4`；逆向整旧清单canonical SHA `e2c5832e64bd08f2579ba97324c6571917ce9950e115444c15716367368a0723`。页面作者已取得新增入口/parser/runtime组合RED：166项中123pass/43fail、native1；这不是前端已通过或旧123覆盖新增行为。

根并行完成G2样本分窗技术预检，未写产品：原一小时WAV无损拆为3个带上下文的分析窗，实际48,960,078 / 49,920,078 / 20,160,078字节，完整commit覆盖及每窗/重叠PCM hash与母本区间一致，6个FFmpeg/ffprobe及探针native0（tool `89fd16`）。回执 `.codex-staging/g2-pcm-window-probe-20260906-r1.json` SHA `cfb783a8aa0e3905978cb90893a0e3338ee26076892b77b9d3ee386be567e056`，日志SHA `8645d9ce261754633de52aaf67b8f72a0e1d1a51bafc298e17b69dfcb568ba61`，原WAV前后SHA不变。仅证明有界无损提取，不证明ASR、完整语句接缝、人物归属、最终证据登记或G2完成。探针保留到唯一 `g2-pcm-window-probe-20260906-r1-media-0iS5lZ`，不覆写历史文件。

本轮独立探针补充：G1.3a QUALITY r1 为 **REQUEST_CHANGES / 1 P2**，报告 SHA `45fe2157133711b59a5252340751f975c08860febbb88bc5d7d859884471a299`。实际 90° display matrix 反例 native exit 1 已保留；修前 22/22 不覆盖此漏检。修复只针对上传 probe 旋转事实，不改变 G1.2、模型或人工确认。原作者修后 **131/131、native 0** 已收口，r3 回执 SHA `e78d0f134214c3e674531e03f6df92e2b9119a6865276140ae904afc897d488d`。根独立 **24/24、native 0**（tool `b33b0b`），14 源/依赖 SHA 无漂移，回执 SHA `6cf4064b23f2928d8f3bcec60cc85a47d67a76a2209eaf778fc49d964e403807`。SPEC r2 独立5/5后 **PASS**，报告 SHA `c80cd3f4227cabe6932ac31f96acde1953636834f83f11c810c81a8ec08dcf11`；QUALITY r2 原反例1/1＋窄兼容4/4后 **APPROVE**，报告 SHA `a028446fbcb28f956f3443c42b82f95d5bcb1a213a9a0e22706ddefadcdcd493`，回执 SHA `6dd9f7d891bf332530d9c610cdd8a76200dbf55951f5645f0f032dabffa73458`。根完整读回两份最终复审报告，原P2关闭，才进入累计证据收口与G1.3b。累计回执 `.codex-staging/g1-motion-processing-verification-20260906-r1.json` 保留旧失败证据；不代表页面、人工观感、G2–G6或生产验收。

G6 审批错误另用真实隔离 SQLite、全部实际迁移与默认 handler（不 mock reviewService）取得有效 **RED / native exit 1**：当前 owner/CAS 且无 identity_pack，实际为 500/INTERNAL_ERROR，而新合同要求 409/REDRAW_CHARACTER_IDENTITY_REQUIRED；真实 logger 捕获后者业务码。外 owner+旧 CAS 控制例仍先 404，当前 owner+旧 CAS 仍 409/REDRAW_REVIEW_CONFLICT。三例的 83 表内容/计数、asset/version/work 和 total_changes 均未改变，网络尝试为 0；仅 handler 层，不冒称 HTTP 监听或页面验收。回执 `.codex-staging/g6-identity-http-probe-20260906-r1.receipt.json` SHA `4e1810a084239611ce725881f94c0461e4d687d2c3cc5ad0a0b93cc5eaf95d84`，根已独立核对四工件 SHA 和原始断言结果。G6 产品修复尚未执行，后续正式测试可复用该最小真实夹具。

**历史批次完成项（2026-09-06，R2d.2b）：** 当前动作候选状态与鉴权媒体读取，是普通上传页面刷新恢复的最小前置。入场复核上一批 135 个条目无漂移；合同写在唯一主线计划。只复用已验证导入文件的 SHA/媒体合同，不新建转码或供应商流程；实现者与规格、质量审查分离，该批已解除页面前置依赖。以下至 R2d.2b 退出证据均为当时记录，最新状态以上方里程碑及本文末尾为准。

本批功能锁先得到缺少新授权的正式 RED（1 fail，exit 1）；追加五个实际路由保护项后，历史完整性断言通过，但提前运行全套为 33 pass / 2 fail，原因是实现者尚未创建 `redrawMotionCandidate.test.js`，审计器正确拒绝不存在的 impactTests 路径。保留该日志，不移除路径检查、不创建空占位测试；正式测试落地后再运行完整门禁。

正式测试落地后，功能锁二次回归已为 35/35、实际 exit 0（`r2-motion-candidate-feature-green-r2-20260906.tap`），未改门禁或断言。页面 API 先行 RED 为 5 fail、实际 exit 1（`r2-motion-reference-api-red-20260906.tap`），逐项因四个包装尚不存在而失败；前端运行时仍未变，不是页面已交付。

### R2d.2b 本地退出证据

- 真实 HTTP 专项 26/26；主代理修正唯一旧导出枚举后，`redrawReferenceArtifactImport`、`redrawMotionReference`、`redrawMotionDraft`、`redrawMotionCandidate` 四套共 134/134、0 fail/cancel/skip、实际 exit 0，日志 `r2-motion-candidate-root-regression-20260906.tap`。这是相关回归，不是全仓库/前端/Hosted CI。
- 独立规格报告 `r2-motion-candidate-spec-20260906-1748-report.md`，SHA `4ac2c0f30b2e2eb7837671f669d4c4c20b76408253ea1d554ded886dba2ae3e1`：独立 26/26、3/3 探针、窄导出 1/1 全 exit 0。之后质量报告 `r2-motion-candidate-quality-20260906-072406-report.md`，SHA `66788f8f48707dfee3fde0da28a7e00ffd34567874a40755aacc4ead4cbd1933`：4/4 独立断连/EIO/旧稿探针，exit 0，APPROVE。重叠测试不累计成更大的通过数。
- 根逆向只读检查：仅剥除新增 reader/export/handler/注册后，原导入服务 SHA 与两个路由全文均还原到父批精确字节；未改旧业务体。`r2-motion-candidate-root-scope-r1-20260906.json` 保留范围与当时验证。最终审计 11 features、56 tracked changedPaths、ready=true，syntax 与审计实际 exit 0。
- 旧日志全部保留：最初全套 RED 25 fail/1 cancelled 不作有效 RED 终态，单独 missing 路由实际 404≠200 的 focused RED 才为本批有效失败证据；旧三套 107/108 的唯一导出枚举失败经精确补断言后重跑 134 全绿。根有一次文档补丁因未匹配完整行拒绝，未产生修改，随后使用明确标题锚点落档；不涉及源码或测试修补。
- 限制：附加 binding metadata 用例只是读取兼容，不是完整 ready 状态机。实际媒体/bytes/SHA/ffprobe 已查，但未验收自动人物文字遮除、200 MiB/并发压力或普通页面。前端新增 5 项测试仍故意 RED，不声明全前端绿；未 commit/push/远程 CI/供应商/付费/生产/部署。

下一批严格从唯一计划 R2d.2c 接续四个页面/API 文件：草片警示、选择处理后 MP4、四项显式确认、一次上传、纯 GET 刷新恢复、候选/参考包一致性与 unknown 冻结；高级 ID/JSON 不作为普通必经路径。完整一键转绘目标仍未完成。

用户本轮明确：完整开发可复用的一键转绘功能，现有整集只用于测试；其他支持范围内的新上传视频也必须能够处理。执行计划已更新为 `docs/superpowers/plans/2026-09-05-redraw-mainline-final-delivery.md`。

- 工作树：`C:/Users/canqu/Documents/茉莉妈妈2/worktrees/redraw-complete-main-merge-20260901`。
- 分支：`codex/redraw-speech-aware-normalization-20260904`。
- 基线 HEAD：`8c49a90773a4311992e4eb9b6a5bc2c9acdfa4ed`；以下结果覆盖本轮未提交本地差异，不能称为新 HEAD 已通过 Hosted CI。
- 未 commit、push、合并或部署；无真实供应商请求、Key 读取、付费或生产数据库/shared 写入。

## 已完成的局部修复

1. 隔离 fallback 在首镜技术成功后保持 `waiting_first_shot_review`。显式批准必须绑定 run/route/HEAD/package/plan/unit/实际文件 SHA；续行不重提首镜，否决、hash 漂移、未知及并发不允许继续提交。
2. 未记录或待视觉审核不再记作完整验证成功；公开清单不包含审核人/供应商详情，CLI stderr 仅输出固定错误码，并抑制 Git 子进程原始诊断。
3. 固定 Fumin480 规范化设置 `480×864 + SAR 81:80`，实际 DAR 为 `9:16`；ffprobe 重读并交叉校验尺寸、SAR 与 DAR。不改上游模型/请求，不增加裁剪；不等于保持所有输入原始几何比例或已完成播放器视检。
4. 只刷新实际触及的 `redraw.episode-blueprint-first` 本地修复授权记录，保留原 `.cn` 授权完整历史、所有保护路径/状态/证据和其他功能锁。

首镜 gate 仍是有固定实验合同的隔离脚本，未接入通用产品队列，不代表任意输入已能完成。媒体修复仅对应已有固定档位，不是动态多模型规格实现。

## 上轮局部修复验证（不覆盖下方新增差异）

| 检查 | 实际结果 | 边界 |
|---|---|---|
| 八个相关 Node 脚本测试文件 | 148 项，146 通过、0 失败、2 跳过；exit 0 | 包含真实 FFmpeg 编解码/拼接；外部 HTTP 为注入假响应，两个符号链接用例因 Windows 权限跳过 |
| fallback 聚焦复审 | 41/41；exit 0 | 含三条真实 CLI 子进程错误脱敏反例；无真实供应商 |
| 前端状态/组件测试及蓝图审核工具 | 994/994；exit 0 | 不等于视觉质量验收 |
| Worker 测试 | 122 项，114 通过、0 失败、8 跳过；exit 0 | 使用既有项目隔离 venv；平台/可选依赖相关 skip 不计通过，未下载模型 |
| 三镜完整产品 Playwright | 1/1；exit 0 | 实际本地前后端、隔离 DB、浏览器；已有 harness 注入分析事实及供应商，不证明默认动态分析链 |
| 前端构建 | exit 0 | 已有大 chunk 提示；未发布 |
| feature-lock 测试与审计 | 21/21，审计 ready=true；exit 0 | 新鲜本地授权记录，不变更生产共享门禁 |
| 后端全量回归 | exit 1；尾部确认 4 项审核记录器失败 | 未全绿；完整输出过大被截断，不声称已取得全量通过/失败总数 |
| 审核记录器失败文件独立复核 | `redrawFullFrameReview.test.js` 10/10；exit 0 | 未改代码；不能用独立通过抵消全量失败，原因未确认 |
| 同新 HEAD Hosted CI | 未执行 | 尚未提交或推送，不引用基线绿灯覆盖差异 |
| 真实多输入转绘质量、默认分析链与用户交付 | 未执行/未通过本轮验收 | 不能用测试片素材盘点或模拟链替代 |

主要命令（工作树根目录）：

```powershell
node --test frontweb/scripts/run-redraw-video-model-fallback-live.test.mjs frontweb/scripts/episodeVideoRouteRegistry.test.mjs frontweb/scripts/episodeVideoProviderAdapter.test.mjs frontweb/scripts/run-redraw-episode-blueprint-live.test.mjs frontweb/scripts/fuminEpisodeExecutionPlan.test.mjs frontweb/scripts/fuminEpisodeMediaPipeline.test.mjs frontweb/scripts/fuminEpisodeProviderAdapter.test.mjs frontweb/scripts/run-redraw-fumin-full-episode-live.test.mjs
node --test frontweb/test/*.test.js frontweb/src/utils/redrawBlueprintReviewState.test.mjs
npm --prefix backend-node test
node --test backend-node/test/featureLockManifest.test.js
npm --prefix backend-node run audit:feature-lock
# REDRAW_E2E_FAKE_PROVIDER=1, PLAYWRIGHT_REUSE_SERVER=0，仅对本地子进程设置
npm --prefix frontweb run test:e2e:redraw-full-product
npm --prefix frontweb run build
git diff --check
```

Worker 使用 `C:/Users/canqu/Documents/茉莉妈妈2/.codex-staging/redraw-locale-hf-stage-20260902/venv/Scripts/python.exe`，执行 `-m unittest discover -s workers/redraw-locale-verifier/tests -p test_*.py -v`。子进程设置 `PYTHONNOUSERSITE=1`、`PYTHONUTF8=1`、`PYTHONDONTWRITEBYTECODE=1`、`HF_HUB_OFFLINE=1`、`TRANSFORMERS_OFFLINE=1` 与源目录 `PYTHONPATH`，未改 venv、依赖或模型。

环境问题如实保留：PATH 指向的 Hermes Python 未能运行测试；应用 bundled Python 缺 jiwer，初次测试失败。切换到已存在且包含固定依赖的项目 venv 后才取得上述结果，未跳过 normalization 测试来通过。浏览器/构建起初受沙箱读取 node_modules 链接目录限制，经允许后使用相同代码执行通过。

后端全量尾部失败位于 `backend-node/test/redrawFullFrameReview.test.js` 的 recorder init/decide/CLI、并发 decide、junction 拒绝、锁保留四项。随后相同代码单独运行 `node --test backend-node/test/redrawFullFrameReview.test.js` 为 10/10。尚不能确定是临时文件交互、资源竞争或其他环境差异；未放宽安全检查、修改该文件或把失败视为已修复。再次全量回归须完整持久化日志并记录退出码，不能只保留截断尾部。

## 独立审查

- 首轮规格审查发现 CLI 可能输出原始错误；追加三个真实子进程反例后修复，规格复核与代码质量审查均无剩余阻断。
- 固定 Fumin480 SAR/DAR 修改经独立数学/代码审查及真实 FFmpeg→MP4→ffprobe 验证；未改变供应商请求，播放器及实际人物构图仍须另外验收。
- 机器比对确认其他 10 个功能锁完全不变，目标锁的非授权字段不变，旧 `.cn` 授权原样保留。
- 复核绑定：fallback 代码 SHA-256 `8d289d0f98e81d744e88125952545b388c5e21517d74c109e686772eb6d492ad`；测试 SHA-256 `73ed1953c7635abe480c62e5e44d13ea53591b5b5e1e1986f1d7ca5e38eb2585`。

## 未完成的主线连接

1. 默认分析入口已存在，但背景音无语音、长输入、超过 64 段和跨镜完整对白还需通用处理及集成证据。
2. 现有蓝图审核需要逐句定位/纠错、时间和人物重新映射；画外声音不可默认绑定可见人脸。
3. 从当前上传视频准备动作参考、普通素材选择/上传不能要求内部资产 ID。
4. 依据当前已验证能力生成动态 N 单元计划并接入产品任务、暂停审核、恢复、防重及未知停止。
5. 原生音轨需贯通 readiness、候选发布、合成和下载；现有独立配音路径不能伪造 TTS 资产替代。
6. 多个独立新输入从空项目走默认产品链，最终由实际视听与用户操作证明可用。

### 输入合同补审（源码证据，尚未新增实测）

- UI 声明 MP4/MOV/ZIP；上传默认单文件 12 秒至 60 分钟，ZIP 每条 12 至 180 秒、最多 20 条，HTTP 包体上限 1 GiB。页面未清晰区分，默认路由没有配置 ZIP 展开总量/单条字节上限；现有注入限额测试不能代表默认值已有保护。
- 上传仅验证正宽高及媒体可探测等条件，不意味着所有编码、帧率、尺寸均满足下游。支持范围须前后端一致，不能仅凭文件扩展名保证能转绘。
- `RedrawSourceStep.vue` 没有沿用项目默认语言/市场而选择能力列表首项，且非空判断不能排除 `blocking` 能力；报价仍有英文固定文案。应防止用户选择的语言和国家被静默替换，不能把语言格式合法等同于该组合已验证可用。
- 三个优先反例：同一 181 秒 MP4 单独/ZIP 上传的边界差异及多条只选首项；非英文项目遇到首项英文或 blocking 能力；同一画面的无音轨与有轨全静音。分别落入上传、SourceStep/项目状态和源音频证据测试。识别超时不得当作静默来放行。

当前样本的 24 镜、28 单元、15 段对白和角色复核不再作为上述任务的完成条件。下一步按通用计划推进，不再把增加本样本付费轮次当作开发进度。

## 本轮通用输入批次（2026-09-05）

用户指令：开始推进主线剩余任务。仍在基线 `8c49a90773a4311992e4eb9b6a5bc2c9acdfa4ed` 的本地未提交差异上执行，不产生新 HEAD 或远程 CI 结论。

### 产品代码进展

1. SourceStep 沿用项目保存的 locale/market，能力列表顺序不再改变目标；迟到的能力/项目数据不覆盖用户的新选择。按精确组合及当前阶段 text/subtitles 能力放行，后续 video/voice 缺口保持可见。请求不再回退 en-US/US，确认、重试和提交提示不再固定写英文。
2. 源音轨的空转录有了严格分支：只有完整 ASR/VAD 成功、VAD 语音时长为零且完整时长与实际 WAV 匹配时，Worker 才返回可选 `no_speech_evidence`。客户端和源证据服务验证字段、请求和 hash，保留实际音轨 hash、空转录 hash 及 null 语言/概率；蓝图仍需审核。空转录但缺 VAD 证据、有语音却没有转录、元数据漂移、异常和超时不转成 silent，也不落库。
3. Recorder 当前可复现的四项失败来自沙箱祖先目录 `realpath(USERPROFILE)` 的 EPERM。同代码在明确授权的本地执行上下文四项通过；未改 recorder、安全校验、ACL 或原测试。历史全量缺失日志，不能据此追认其根因或当作通过。详见 `recorder-diagnostics-20260905/README.md`。

本批未增加语言或供应商模型预设，不下载模型、不改现有模型/生产配置；VAD 证据表示“未检测到语音”，不表示人工已经确认绝对无对白。真实复杂背景音乐、轻声/重叠语音与长输入质量仍是后续验收项。

### 新鲜验证与审查

| 检查 | 结果 | 证据边界 |
|---|---|---|
| 通用目标选择 TDD | 39 通过/9 预期失败 → 48/48 | 真实编译 SFC 脚本及 Vue 响应式状态 |
| 非英文文案 TDD | 31 通过/4 预期失败 → redraw 局部 169/169 | 模板、真实本地化提交成功/失败提示 |
| 前端全量单元 | 1007/1007，exit 0 | 默认沙箱首次因依赖链接读取失败；同代码获准本地执行后通过 |
| 一键转绘 workspace 浏览器 | 26/26，exit 0 | 本地 Vite/Chromium，测试接口 fixture；不是默认真实分析或供应商质量验证 |
| 三镜完整产品浏览器复验 | 1/1，exit 0 | 真实本地前后端、隔离 DB；分析事实及供应商仍为既有 harness 注入，不计默认动态分析通过 |
| 前端构建 | exit 0 | 保留既有大 chunk 警告，未部署 |
| Worker 全量离线测试 | 127 项，119 通过、8 跳过，exit 0 | 既有 venv；跳过的平台项不算通过 |
| 后端源分析/音频/融合/录审/功能锁 8 文件回归 | 155 项，154 通过、1 POSIX 权限项跳过，exit 0 | 串行、正常本地文件权限；完整 TAP 保留 |
| 源音轨独立复核 | Python 48 通过/1 跳过；Node 58 通过/1 跳过 | 包含真实 JS 客户端与本地 TCP 替身，畸形结果不注册证据 |
| 真实本地 ASR 静音 smoke | 12 秒/16 kHz/单声道 PCM，exit 0 | 使用既有 Whisper 缓存实际推理，网络审计钩子拒绝连接；没有模型下载或配置更改，未验证复杂背景音乐/低声对白 |
| 完整后端回归 | 4001 项，3991 通过、10 跳过、0 失败，exit 0 | 36 个 suite，串行 TAP，约 32 分 38 秒；平台跳过不计通过，完整日志保留 |
| 同新 HEAD Hosted CI | 未执行 | 未提交、未推送 |

语言修复和源音轨修复均已分别通过独立规格与代码质量审查，无剩余本批阻断项。功能锁仅刷新 `redraw.episode-blueprint-first` 本地授权，前轮授权完整进入历史，不触碰生产共享门禁。

离线真实静音证据：既有 ASR `model.bin` SHA-256 为 `3e305921506d8872816023e4c273e75d2419fb89b24da97b4fe7bce14170d671`，运行前实际读取核验；本次音轨 SHA-256 为 `6e49db6ecc812f32cb043fb3c02e4aea55329fa8df27724c5b4e2a76ed57c360`。实际 Worker 输出 `audio_duration_ms=12000`、`speech_duration_ms=0`、空 segments、null 语言/概率，未调用说话人聚类。证据仅限明确生成的静音测试波形，不泛化为所有视频的识别质量通过。

根代理本轮完整日志保存在 `C:/Users/canqu/Documents/茉莉妈妈2/.codex-staging/redraw-generic-source-regression-20260905T024600Z`；TDD 原始日志另保存在 `.codex-staging/source-no-speech-20260905`。日志含执行环境信息，仅本地保留。

完整后端命令为 `node --test --test-concurrency=1 --test-reporter=tap test/*.test.js`（`backend-node` cwd，已获准本地文件权限上下文），实际退出码在读取日志前保存。原 recorder 四项未被修改或跳过；本轮全量通过是新的执行证据，不追溯覆盖上一轮未留全日志的失败。回归期间 26 个 tracked 变更文件集合的 SHA-256 为 `61a27796eb8d600f3c3244be84de3b6fe61a65b316b94bf5dfa8b2066d01eb76`，复核未变化。机器记录为日志目录内 `verification.json`。

### 本批之后的明确顺序

1. 长输入和跨镜对白：保留完整转录/源时间，消除 64 段摘要和单镜夹短对白的损失，补默认动态分析链集成。
2. 事实纠错与素材操作：源片逐句定位/纠错/重映射，普通用户选择或上传身份图和动作参考，无需内部资产 ID。
3. 产品内动态执行与交付：按已验证能力拆分动态 N 单元、同项目状态/审核/恢复防重，贯通原生音轨发布、合成和下载。
4. 不同新输入的产品全链及视听验收；此前 fixed-episode 付费轮次不能抵扣这些完成条件。

因此本批是主线的两处输入能力修复，不是“通用一键转绘已完整交付”。

## 下一项落地：跨镜整句证据与消费边界（2026-09-05）

用户指令：开始进行下一项。本批继续在 `codex/redraw-speech-aware-normalization-20260904`、HEAD `8c49a90773a4311992e4eb9b6a5bc2c9acdfa4ed` 上本地开发；以下结果对应未提交工作树，不是该裸 HEAD、Hosted CI 或线上版本的验收结论。按子代理 TDD 执行，解析器、生成守卫、本地化和页面各自完成规格与质量审查；没有把付款实验作为产品开发进度。

### 本次已实现

1. **完整源对白回查。** 服务端在 owner、work、源资产、指纹、时长和原音频证据 SHA 校验后，唯一解析完整 ASR segment，同时保留原镜头内投影。校验安全路径、真实文件和读取前后状态；缺失、伪造、漂移、歧义或文件替换均明确 unresolved。真正没有 ASR 的旧人工蓝图为 not_available；删除引用或软删除证据不能伪装成旧人工数据。
2. **产品审核与整句回放。** 蓝图 GET/保存/锁定响应附带只读解析结果，不修改蓝图或 hash。页面分别展示镜头内范围和整句源范围，可回放完整原声；跨镜会提示。草稿、蓝图、源资产/指纹或播放地址不匹配时禁用并停止旧回放；迟到的播放结果不能干扰新视频。仅接受当前 work 的源视频地址，客户端不能注入服务端证据或文件路径。
3. **完整对白翻译预算。** 本地化使用完整源范围估计语音时长，不再要求模型把整句压进镜头内投影；输出仍使用现有严格蓝图合同，由服务端恢复投影时间。可信源解析进入输入/报价 hash，提交、排队调用和保存/锁定均重查证据。蓝图适配器不再要求模型返回解析器禁止的时间字段。
4. **生产前保护。** 生产包、视频生成及独立配音重新检查源证据；证据无效或真实跨镜而没有安全执行计划时阻止生产，保留明确原因，不建议用缩短对白绕过。新增测试覆盖报价到启动、事务前和排队后的文件漂移；排队本地化若先前已冻结费用，失败会走现有失败/释放路径，不能声称从未产生冻结记录。

跨两镜、多镜及边界原句现在可追溯、回放和计算翻译预算，**仍不能声称“不切句跨镜生成”已实现**。实际跨镜生成/TTS 继续返回 `REDRAW_CROSS_SHOT_DIALOGUE_PLAN_REQUIRED`；正常单镜及旧人工流程保持兼容，旧人工数据不标成已验证原句。旧本地化任务若缺少已持久化的输入快照，幂等恢复返回明确冲突，不用当前文件偷偷重建历史输入；本批未做历史迁移。

### 最终验证

| 检查 | 本批最终结果 | 范围与限制 |
|---|---|---|
| 后端相关 20 文件串行集成 | 746 项：744 通过、0 失败、2 跳过；exit 0 | 涵盖解析、真实文件/隔离 DB、路由、本地化、生产包、视频、配音、源分析和功能锁；不是本批全后端回归 |
| 前端默认单元集 | 1008/1008；exit 0 | 编译后的组件脚本与状态测试；不等于实际生成质量 |
| 蓝图审核工具额外入口 | 11/11；exit 0 | 位于 src，未包含在默认 test/*.test.js 中 |
| workspace 浏览器 | 27/27；exit 0 | 实际 Chromium/Vite 和本地 MP4 整句回放；接口使用 fixture |
| 三镜完整产品浏览器 | 1/1；exit 0 | 实际本地前后端和隔离 DB，从空库到发布/刷新；分析事实及供应商注入，不计默认动态分析或真实供应商验收 |
| 前端生产构建 | exit 0 | 保留既有大 chunk 提示，未部署 |
| 本地化独立复核 | 121/121；exit 0 | 包含提示词严格输出合同、源证据和预算；不证明真实翻译/发音质量 |
| 解析器独立相邻回归 | 107 项：106 通过、1 跳过；exit 0 | 与集成回归重叠，不叠加统计 |
| 功能锁完整测试 | 21/21；exit 0 | 本地授权及范围，无生产共享门禁修改 |
| 精确差异审计 | git diff --check exit 0 | 23 个不重叠的既有 dirty 文件逐字节 SHA 未变；三个重叠文件保留此前修改 |
| 本批全后端/Worker/Hosted CI/真实多输入 | 未执行 | 前批全量结果仍仅属于前批，不覆盖本次新增差异 |

两项集成跳过分别是 Windows 无创建符号链接权限、仅 POSIX 的可组写目录权限测试，均单独计数，不作为通过。TDD 与审查中暴露的真实反例已补测修复；前端初次全量因沙箱无法读取依赖链接目录失败，同代码获准正常本地执行后通过。所有失败/成功日志保留，不修改环境安全检查来绿灯。

日志根目录：`C:/Users/canqu/Documents/茉莉妈妈2/.codex-staging/redraw-cross-shot-20260905`。主要文件为 `backend-integrated-final.tap`、`frontend-final.tap`、`frontend-blueprint-utils.tap`、`browser-workspace-final.log`、`browser-product-chain.log` 和 `frontend-build.log`。机器记录 `verification.json` 保存命令、退出码、日志 SHA 和当前 48 文件差异集合，集合 SHA-256 为 `3dc52a2d008d587bca70d519d7a315726e57902a45e40ffc6c88cc6fe1797fae`；计划/总报告另行记录，不计入该代码/测试/清单集合。

功能锁精确比较：11 个 feature 中，6 个完全不变；另 5 个只更新本次本地授权、把旧授权原样追加到历史。其 protectedPaths、requiredTests、acceptance、evidence、status 等全部不变。五项为 `stability.proactive-canary-and-public-evidence`、`redraw.coverage-registration-http-route`、`redraw.clean-plate-local-media-registration`、`redraw.product-media-http-chain`、`redraw.episode-blueprint-first`；涉及的是上述共享服务/路由，不是扩大生产变更范围。既有模型和 .cn 线路代码未改。

### 接下来仍须完成

1. 长输入按连续时间窗分段分析并合并事实：完整证据不能被 64 段/16 KiB 预览摘要替代，也不能将一小时约 900 张 contact sheet 塞进一次 8000-token 视觉响应。补默认动态分析产品链，而非仅提高阈值。
2. 把本批可信完整源范围接入动态单元时间线，解决跨镜整句只翻译/生成一次、模型时长上限、镜头映射与审查恢复，再解除目前的明确阻断；不能先删守卫。
3. 继续事实纠错/人物重映射、普通身份/动作素材操作、原生音轨发布与下载，以及多个新输入的完整产品和视听验收。已完成逐句回放，不代表文本/时间/人物纠错 UI 已完整。

本批没有读取 Key、请求真实供应商、付费、SSH、生产数据库/shared 写入、推送、合并、部署或重启。只完成当前子批次，不声明通用一键转绘已完整交付。

## 下一项落地：长输入分窗与默认产品分析链（2026-09-05）

用户指令：开始推进下一项。仍为同一本地工作树、分支和 HEAD `8c49a90773a4311992e4eb9b6a5bc2c9acdfa4ed`，包含未提交修改；下述证据不属于裸 HEAD、Hosted CI 或线上版本。

### 本次完成的连接

1. **确定性分窗及全窗预检。** 每窗不超过 24 秒/6 张 contact sheet；按完整 ASR 段与窗口的正相交选择预览，64 段或 16 KiB 超限时按整数毫秒二分。不删完整转录、不夹短原始时间/ID/ref，继续只使用既有 160 字预览。全窗预检成功后才允许开始视觉调用；最小窗口仍过密或证据非法时零调用。1 小时级规划有算法测试，尚未完成 1 小时真实视觉推理。
2. **逐窗真实取帧与严格合并。** FFmpeg 输入侧限定窗口并标注绝对源时间，短窗颜色反例验证不会采入后窗画面。每窗结果严格校验后顺序合并，时间轴连续覆盖、ID 不碰撞；同名人物不自动合并，人工窗口边界及跨窗身份降为待审。全部成功后才注册一个最终视觉分析资产。
3. **完整产品链而非只测 helper。** 新建独立 25 秒视频并真实上传，经默认产品 API、音轨提取、源音频服务、原生视觉服务、全片融合、蓝图持久化与 owner GET；67 段源对白全数保留、每句唯一回查，跨窗原句时间仍完整。只在最底层替换 ASR 与视觉调用，不注入完成蓝图。音轨为本地合成波形、转录及视觉判断为 fixture，不能据此声称真实 ASR/内容质量通过。
4. **失败凭据和未知保护。** 请求前/响应后/校验后保存独占的脱敏窗口凭据，不覆盖旧产物。已返回 ID 的无效 JSON/schema、明确拒绝且无任务 ID按已知分析失败处理；超时、缺 ID 或异常携带任务 ID为未知，保留本地积分冻结并阻止再次分析。产品反例实证再次点击零新增请求/任务；不自动恢复、不自动重试。
5. **顺序与 hash 分离。** canonical facts 保持旧 2.0 规范化/hash 合同，原序叙事放入带独立 hash 的 `ordered_narratives`。编排器验证后仅向融合器投影原序，不冒用旧 facts_hash；多窗自动叙事 ID 加固定宽度序号，保留旧单窗 ID 和蓝图排序规则。产品 GET 原序及重复 GET hash 均验证。

### 本批最终证据

| 检查 | 结果 | 证据边界 |
|---|---|---|
| 22 文件后端串行集成 | 775 项：773 通过、0 失败、2 跳过；exit 0 | 268.324 秒；含窗口、默认产品链、源证据、蓝图、本地化、生成/TTS 守卫、路由、媒体、功能锁及发布范围；不是全后端测试 |
| 独立规格复核 | 52/52，exit 0 | 四套相关测试及源代码逐项核对，和集成测试重叠，不累加 |
| 独立质量复审 | 52/52，exit 0；无剩余 P1/P2 | 原“未知误退款”和“facts hash 回读改变”反例均关闭 |
| 默认产品链 | 3/3，包含在上述结果内 | 成功待审、明确无效结果停止、真实 routeMeta 形状超时保留冻结/重进零调用 |
| 功能锁测试与精确审计 | 21/21；11 项中 9 项完全不变 | 仅两项刷新 unlock、旧 unlock 原样追加历史；全部保护字段/requiredTests/证据/状态不变 |
| 代码保留与静态检查 | 既有 48 文件中 44 个逐字节未变；git diff --check exit 0 | 4 个重叠文件保留旧修改；新纳入本批的另 6 个文件已记录哈希 |
| 本批前端/浏览器/Worker 全量、Hosted CI、真实多输入模型质量 | 未执行 | 旧轮次的通过不能覆盖本批，也不证明长片人物或视听质量 |

两项跳过：Windows 缺 symlink 创建权限、POSIX 私有目录组写权限测试。跳过不计为通过。曾失败的 TDD、审查及中间回归日志均保留，不能用后续通过改写之前失败。

主证据目录：`C:/Users/canqu/Documents/茉莉妈妈2/.codex-staging/redraw-window-product-20260905`，最终日志为 `backend-integrated-final.tap`，机器记录为 `verification.json`。窗口实现的 RED/GREEN 位于本工作树 `.codex-staging/window-*-20260905.log`；机器记录保存全部 27 份本批日志的 SHA。最终当前 54 文件代码/测试/清单集合 SHA-256：`f6ccb6d0d94bea127bd9d278b5d782a73ce17a94dfc4e217fc059c64f8f3fe46`，回归完成后逐文件复核未漂移；计划和本报告另记文档哈希。

独立审查的非阻断补测建议：增加有序 sidecar 缺失/篡改 hash 的显式负例；当前拒绝分支已存在并经过代码审查，本批不把未运行的负例算作通过。

### 下一项与未完成边界

本地长输入分析连接已完成；**动态生成、人物全局重识别、通用视听质量和整体交付仍未完成**。跨镜生成/TTS 守卫继续保留。

下一子项是产品内的版本级只读动态执行预览：读取当前已保存的待审本地化与可信完整对白，按服务端当前验证能力规划任意所需单元、完整句边界及多父镜头映射，绑定源/蓝图/本地化/能力 hash；不能固定 5 秒或用锁定失败的数据伪造 locked。预览零任务/零冻结，之后才接持久化队列、幂等计费、候选归并与交付。人物纠错、普通身份/动作素材操作、原生音轨发布及多输入产品验收继续留在唯一主线计划中。

本轮未读取 Key、请求真实供应商、付费、SSH、修改模型或生产/shared 数据，也未提交、推送、合并、部署、重启。未将单集样片替代产品完成。

## 2026-09-05 版本级动态执行计划只读预览

本子项沿用户“开始下一项”执行。工作树与 HEAD 保持 `redraw-complete-main-merge-20260901` / `8c49a90773a4311992e4eb9b6a5bc2c9acdfa4ed`，本地未提交；新增产品接口 `GET /redraw/versions/:id/execution-plan`，没有修改模型或调用任何真实生成。

### 本地实现与明确边界

- 读取当前 owner 的精确版本/源蓝图 revision、已保存待审本地化，重新核验蓝图/本地化正文 hash 和原 ASR 文件证据；不伪造 locked。源视频本身本轮不重新读取字节，`source_media_readiness: not_checked`。
- 后端纯规划支持 N 单元、跨多个父镜的完整句、重叠语音连通区间、源时间与单元时间映射；分别记录保留时长、生成时长和 padding。过长整句、超限参考需求、缺口或漂移返回 blocked/空单元，不硬切/压速/删句。
- 同一配置证据与已有适配器取交集，不跨模型拼接能力，不从已验证标签推断缺失参数；SQL 只提取非 Key 字段和 settings 中的语言能力子项，不调用可能写稳定性事件的模型目录。缺画幅、时长、引用数量等证据明确阻断；WAN3 凭据绑定本批未检查，不能借预览放行。
- 原生音频按同 carrier、同 model 的语言证据读取，仍标注地区未验证；有精确地区的已验证 TTS 可形成 replace 预览，但本接口不执行或切换声音策略。
- 参考仅为逻辑需求（可见角色身份图＋父镜动作片段）；返回 `reference_requirements/requirement_hash`，不是已生成或已审核素材。所有响应始终 `executable: false`，保留源媒体/素材/凭据/动态执行器和必要地区验证的执行阻断。
- 新增八个本批修改路径中，五个是新增纳入本轮的路径，三个与既有差异重叠；上一批 54 个文件中其余 51 个 SHA 逐字节不变。新增授权涉及五项功能锁；既有保护路径、requiredTests、状态及证据不变，前序整个清单由 SHA `6d5795b7aa59d6f2c2f7bca9ef3637547fde51a16490599733e8c78c43f74649` 严格保护。

### 验证证据

| 验证 | 结果 | 范围 |
|---|---|---|
| 纯规划 TDD | RED 45 失败 → GREEN 45/45；exit 1 → 0 | 无 DB/媒体/网络的时间轴算法 |
| 产品入口＋纯规划 | 75/75、0 skip/fail、exit 0 | 真实本地 SQLite/真实 ASR 证据文件/产品 handler，模型能力为明确 fixture，不做真实推理 |
| 功能锁回归 | 22/22、exit 0 | 新授权及前序清单整体 SHA、原历史断言、真实当前门禁与拒绝反例 |
| 15 文件串行相关回归 | 634 项：633 pass、0 fail、1 skip，exit 0，180.089 s | 路由、能力、源对白、蓝图、本地化、生产包、生成、产品媒体链、功能锁和发布范围 |
| 独立规格审查 | 通过；独立 75/75，exit 0 | native 语言证据连接问题经 RED→GREEN 修复，参数/引用语义边界复核 |
| 独立质量审查 | 通过，Critical/Important/Minor 均无修复项 | 独立核心 75/75、当前清单定向 2/2 均 exit 0；实际只读链及授权历史校验完成 |
| 静态与保留审计 | 四文件 node --check、git diff --check 均 exit 0；HEAD 未变 | 59 文件 SHA 集合为 `d7bec816dfe8f33be7f051a97f52bd9647154f9c065de68d2d5326377000b96e`；机器记录保存最终逐文件复核 |

唯一跳过为 Windows `EPERM` 无法创建 symlink 的视频路径反例，不计通过。前期测试夹具与严格媒体/schema/不可变触发器不兼容的失败、native 分支 RED，以及各轮通过日志全部保留；没有放宽数据库约束或不可变触发器。

日志目录：`C:/Users/canqu/Documents/茉莉妈妈2/worktrees/redraw-complete-main-merge-20260901/.codex-staging/execution-plan-preview-20260905`；机器凭据为同目录 `verification.json`。最终相关回归 `backend-integrated-final.tap` 的 SHA-256 为 `a3a8e1571cc40f109de8ce3457fb896901bec474bf1631bc0513088e5f77bb7f`。新执行计划接口是只读 handler 验证及 GET 路由注册检查，不冒称本轮已完成真实浏览器用户流程。

本轮没有前端界面改动、浏览器新回归、真实视频/翻译质量验收、当前差异 Hosted CI、commit/push/merge 或任何生产操作。**通用一键转绘仍未整体交付**：下一项应接产品页面的计划审核与版本绑定持久化，再接幂等队列、逐单元计费/停止恢复、候选归并和最终视听发布；真实素材就绪、人物纠错与多输入验收仍依唯一主线计划推进。现有跨镜生成/TTS 守卫继续保留。


## 2026-09-05 页面计划审核与版本绑定保存

本轮完成既定只读预览之后的本地产品连接，工作树与 HEAD 仍为 `redraw-complete-main-merge-20260901` / `8c49a90773a4311992e4eb9b6a5bc2c9acdfa4ed`；全部为未提交差异，不是当前裸 HEAD 的 Hosted CI 或生产结果。

### 本地实现

- 新增 `GET/POST /redraw/versions/:id/execution-plan/review`。GET 在一致性只读事务中重新预览；POST 只接受 `expected_plan_hash`，在 immediate 事务内核验 owner/未删除版本、fresh ready、完整 hash/CAS，再查重和追加。重复保存不更新时间、不新建记录；任何 blocked、冲突、越权或损坏记录都不会触发生成。
- 迁移 74 新增独立 append-only 快照表与 UPDATE/DELETE 拒绝触发器；不改既有迁移运行器、版本/作品/本地化时间、状态或账态，保存后不会自我过期。当前 hash 的有效历史优先；否则按追加 ID 返回最新历史 stale，不依赖可回拨的系统时钟。A→B→A 的完整 hash 相同可复用原 A，不代表取得生成授权。
- 新面板位于现有本地化审核区域，展示完整跨镜原句/目标对白、源范围、保留/生成时长、尾部余量、父镜头映射、逻辑参考与执行缺口。用户检查后仅保存计划审核；刷新可读回快照，无需 JSON/内部 ID。参考仍不是已验证资产，原生音频仍不是地区验收成功。
- dirty/busy/版本变化、卸载、冲突或读取失败会撤销确认，迟到读写结果不回填当前上下文。另以真实失败测试修复相邻保存竞态：本地化请求返回时若已切版本或又修改草稿，保留新编辑，不把旧响应当新计划依据；SourceStep 展示及回调只接受当前版本。
- 所有保存计划保留 `executable: false` 和全部执行 blocker；`current` 仅表示读取时与服务端预览一致。未增加动态队列、生成按钮、报价、积分冻结、TTS/视频任务或执行授权。

### 验证记录

| 检查 | 最终结果与边界 |
|---|---|
| 后端 TDD | review 独立 51 项；最初缺表/接口 47 项预期 RED，时钟回拨/索引 2 项预期 RED。最终 review+preview 111/111、exit 0，含既有测试重复导入，不重复累加 |
| 前端 TDD | 13/13、exit 0；其中保存覆盖新草稿/旧版本返回为实际复现的 2 项 RED→GREEN；卸载反例实际返回迟到读写结果 |
| 15 文件后端串行相关回归 | 679 项：678 pass、0 fail、1 skip，exit 0，195.385 秒；不是全后端测试 |
| 前端全部单测＋蓝图工具 | 1032/1032、0 fail/skip、exit 0，30.887 秒 |
| 工作台浏览器 | 29/29、exit 0；新增审核→保存→重开恢复、未保存修改禁用、能力漂移/CAS 冲突重新确认、blocked零提交、手机宽度断言；API 使用严格 fixture，非真实模型，未冒称新接口与真实浏览器/数据库完整联调 |
| 构建/静态 | build exit 0，33.54 秒；保留既有大 chunk 警告。三项 node --check、git diff --check 均 exit 0 |
| 独立规格审查 | PASS；冻结后相关 94/94、0 fail/skip，另功能锁 23/23。独立计数含 30 项导入基线，不叠加为新增能力 |
| 独立质量审查 | APPROVE，Critical/Important/Minor 均 0。独立后端 111/111、前端聚焦 64/64、浏览器相关 2/2、功能锁 ready true、构建和静态检查通过；独立计数与主回归重叠，不累加 |

唯一 skip 为 Windows 无 symlink 创建权限的既有视频路径反例，不算通过。初次浏览器启动及前端全量的 7 项失败均为 esbuild 读取祖先目录被沙箱拒绝；获准以相同本地测试命令在非沙箱运行后通过，没有改业务安全代码。浏览器中间两轮另暴露测试夹具缺完成任务终态、把正常本地化 GET 误算写请求；补齐完整 fixture/精确读写断言后通过，未弱化生成门禁。全部失败和通过日志保留。

主证据目录：`C:/Users/canqu/Documents/茉莉妈妈2/worktrees/redraw-complete-main-merge-20260901/.codex-staging/execution-plan-review-20260905`；最终日志为 `backend-final.log`、`frontend-final.log`、`browser-final.log`、`build-final.log`。机器凭据为该目录 `verification.json`。最终 66 个代码/测试/清单文件集合 SHA-256：`8379e2b0b66e306cce55d559195b53ca20fdd4063cbe65e21823e92f5805ffa3`；前批 59 文件中 52 个逐字节未变，7 个本项重叠差异已独立复核。五项功能锁只追加当前真实授权/历史，前序清单 JSON 整体 SHA `36d45f66c8750427d0bc8b574213458f7c292d5d0fb13965e53cc7d30db79ee0` 保持。

最终浏览器全套后，仅补充移动端确认文案的 DOM Range 字符片段边界断言，两项相关页面用例 2/2、exit 0（`browser-text-bounds.log`）。未再修改业务代码；截图为 fixture 页面，不是成片、真实供应商或精确设计稿比对证据。

独立规格/质量审查以本会话子代理最终回执记录，不能把主代理日志冒称为审查者独立运行日志。质量审查无 LSP/ast-grep 工具，以 node --check、Vite build、聚焦行为/浏览器测试和 rg 扫描代替；没有放宽产品门禁。

### 下一项与尚未完成

下一子项是版本计划到幂等执行队列的本地连接：服务端重新核验已保存计划与上游绑定，逐单元状态、防重、首次候选待审暂停、失败/未知停止及刷新恢复；素材和声音就绪仍必须独立检查，不能靠保存计划绕过。随后依唯一主线推进真实素材准备、人物纠错、候选归并、原生音轨发布、合成下载和多输入质量验收。

本轮未读取真实 Key、访问供应商、付费、SSH、读写生产数据库/shared、修改线上模型，也未 commit/push/merge/deploy/restart。尚未运行当前差异的 Hosted CI、全 Worker、真实多输入生成或真实试听；**通用一键转绘仍未完整交付**，本项只交计划审核与保存连接。

## 2026-09-05 完整交付目标与 R1a 待就绪队列登记

按用户“规划好剩余任务设立目标 开始推进”建立当前任务的完整交付目标，沿唯一主线计划 R1—R8 顺序推进。目标仍为 active；八批依次是队列连接、输入/纠错/素材、逐单元执行与暂停恢复、原声合成导出、本地全链及精确 CI、真实多输入质量、同项目恢复交付、用户移交。固定整集仅为测试，不能替代通用产品完成。

工作树与 HEAD 仍为 `redraw-complete-main-merge-20260901` / `8c49a90773a4311992e4eb9b6a5bc2c9acdfa4ed`。本批使用已有 linked worktree 和依赖，修改尚未提交；历史裸 HEAD 的 CI 不覆盖本批。

### 本批实际实现

- 新增 `GET/POST /redraw/versions/:id/execution-queue` 与迁移 75 两张独立不可变表；按 owner/version/plan_hash 绑定已审核完整快照，整份有序 units 在同一 immediate 事务内原子追加。单位保留多父镜头、整句时间和原文/目标文映射，不伪装成旧 shot 队列。
- POST 只接受 `expected_plan_hash`，先校验 owner 和输入，再重算当前计划/CAS；未审、blocked、越权、漂移或损坏拒绝。重复登记返回原 ID/时间和单元；读取恢复在新 SQLite 连接实测，原业务表和审核记录不变。
- GET 当前 hash 优先，否则最近追加历史显示 stale；invalid 返回脱敏空单元。规格审查发现的 A→B→A 漏检已用 RED→GREEN 修复：POST 还独立检查最新追加队列，损坏 B 不能被健康 A 的幂等返回掩盖。GET 选择规则不改，不扫描/修复全部历史。
- 页面显式“登记执行队列（不生成）”，保存审核只做读取、不自动登记。展示待就绪单元与父镜映射；重复点击防重，刷新恢复，dirty/版本切换/卸载拒绝迟到读写，409 或未知错误必须先读取原队列，不自动重试。质量审查另发现并修复服务端能力阻断后历史队列隐藏：现在 blocked 计划仍只读展示 stale 队列，登记继续禁用；未保存草稿的隐藏/撤销规则不变。
- 全部队列 `executable:false`、单元 `pending`。登记不建生成任务、候选、报价、冻结或积分记录；真实素材/声音/凭据/执行器的原 blockers 保留。R1b 的领取、逐单元结果和真正暂停恢复须随 R3 实现，不将本批说成已接通生成。

### 验证与审查

| 检查 | 结果与边界 |
|---|---|
| 后端队列 TDD | 初次 30 pass/51 预期 fail；审查反例为 81 pass/1 预期 fail → queue+review 163/163，exit 0；含导入的旧 fixture 测试，不累加 |
| 前端 TDD | 最初缺登记能力 13 项预期 RED；版本切换中 POST 迟到有明确反例；服务端阻断丢历史为 27 pass/1 fail → queue+review 28/28 |
| 修复后 16 文件后端串行回归 | 762 项：761 pass、0 fail、1 skip，exit 0，209.433 秒；不是全后端测试 |
| 最终前端单测与蓝图工具 | 1047/1047、0 fail/skip、exit 0，27.206 秒 |
| 完整工作台浏览器 | 30/30、exit 0，约 1.4 分钟；最终包含显式登记一次/刷新恢复/修改失效/服务端阻断仍展示 stale 历史/零生成/移动宽度断言。API 为严格 fixture，不是新接口真实浏览器/DB 联调 |
| 功能锁与静态 | 24/24，exit 0；精确审计 ready=true；四文件 node --check、git diff --check 均 exit 0 |
| 前端构建 | exit 0，30.09 秒；既有大 chunk 警告保留 |
| 独立规格审查 | PASS，后端 P2 及质量反馈后的前端增量均复核；独立 backend queue+review 163/163、最终 front queue+review 28/28，均 exit 0 |
| 独立代码质量审查 | APPROVE，唯一页面 P2 已关闭，无剩余实质 P1/P2；独立后端 217/217、最终组件 28/28、diff-check exit 0。与主回归重叠，不累加；审查者未重跑完整浏览器或构建 |

唯一 skip 为 Windows 无 symlink 创建权限的既有媒体路径反例，不计通过。初次浏览器启动和一次前端回归因沙箱限制 esbuild 读取祖先目录而失败；获准以正常本地权限重跑通过，没有改变产品安全代码。前端一次复核命令仅包含 `test/*.test.js` 的 1035 项，随后补回既有蓝图工具并重新完整运行 1046 项，追加质量反例后最终 1047 项；不将不同范围混称同一回归。全部失败、审查反例与通过日志保留。

本批前序 66 个代码/测试/清单文件中 58 个逐字节未变，8 个本项重叠文件保留旧差异；新增 4 文件。前批 40 份工件 SHA 全部保持；旧 receipt 不修改。五项功能锁仅追加本轮真实授权与历史，撤销本批授权后的前序整个 JSON SHA 仍为 `8dc40a359b796a93de61a7f0282c4c93920870c2decf35390201f78a56c7ec81`，不更改保护范围、状态、requiredTests 或证据。

主机器记录：本工作树 `.codex-staging/execution-queue-20260905-verification.json`，记录当前 70 文件和 2 文档 SHA、历史保留复核、本批失败与成功工件、准确命令和退出码。最终日志为 `execution-queue-backend-reviewed-20260905.tap`、`execution-queue-frontend-quality-final-20260905.tap`、`execution-queue-browser-reviewed-20260905.log`、`execution-queue-build-quality-final-20260905.log`。独立规格/质量依据本任务子代理回执，机器记录不把主日志冒称审查者日志。技能流程落实为先 RED→GREEN、规格审查→质量审查，两个已复现问题修复后均再次复审；R1a 本地验证已完成。

本轮未读取 Key、请求供应商、付费、SSH、读写生产数据库/shared、修改线上模型，未 commit/push/merge/deploy/restart。没有真实多输入试听、当前差异 Hosted CI、全 Worker 或新队列与真实浏览器/DB 联调证据；这些仍在 R5—R8。

下一批 R2 优先补普通用户的对白/人物纠错与可用参考素材连接，随后才进入 R3 的真实就绪/领取/候选审核和 R4 的原生音轨合成。R1a 只交待就绪队列登记和读取，**完整一键转绘目标尚未完成**。

## 2026-09-05 R2a 逐句角色归属纠错与安全保存

工作树、分支及 HEAD 仍为上述 `redraw-complete-main-merge-20260901` / `codex/redraw-speech-aware-normalization-20260904` / `8c49a90773a4311992e4eb9b6a5bc2c9acdfa4ed`。本批为用户完整交付目标下的本地增量，未提交；R2a 不是完整事实纠错、真实模型生成或整套 R2 已交付。

### 实际实现与边界

- 现有对白列表支持选择单句或跨镜子集，已映射对白也能重新指定已有角色；画内角色必须在所有选中镜头可见，不能自动伪造可见人。姓名式新增画外角色由内部生成不冲突 ID，无需填写资产/角色 ID；角色和对白都需重新审核。
- 修改仅影响选中对白的说话人字段与审核状态，并撤销总体审核。原文字、语言、完整原声、镜内投影、证据引用、源/hash 和未选对白保持；旧整簇映射入口保留。应用只修改草稿，不自动保存、锁定或启动本地化/生成。
- 原 owner/CAS 草稿保存及锁定服务保持不变，未新建 schema/表。真实迁移/SQLite 联测使用前端实际 payload 保存、读回、批准、锁定并检查最终源镜头；源 ASR JSON 文件和 assets 记录原样，全部非蓝图工作流表原样。源视频在该测试中为 hash 夹具，不是视频解码或真实推理证据。
- 保存/锁定请求绑定工作、源身份、修订与 epoch。A→B→A 同 tick、修订切换或卸载后的成功/错误不能覆盖新草稿、清掉新请求或继续旧锁定；重复点击不重复请求。409 保留编辑并要求刷新。保存成功但锁定错误保留最新 CAS；同作品进度刷新不丢本地编辑，无效新记录不留旧可编辑草稿。
- 当前 Workspace 只有 `onBlueprintUpdated`；锁定成功经 SourceStep 的同一 updated 链传递。新增当前工作守卫，不添加未使用的另一套事件接口。

### 当前验证

| 检查 | 结果与证据范围 |
|---|---|
| 后端新增联测 | 16/16，exit 0，其中 10 项为导入的既有蓝图测试，6 项为本批夹具/联测；原证据回查、owner/CAS/locked、篡改文本/时间保持 unresolved、零其他业务写入 |
| 后端 9 文件相关串行回归 | 306/306，0 fail/skip、exit 0，19.845 秒；不是全后端测试 |
| 前端 TDD/聚焦 | 首次旧 23 通过、新 30 预期 RED；后续进度刷新/无效新修订 2 项实际 RED。最终 57/57，0 fail/skip、exit 0，保留中间失败及最新通过日志 |
| 前端默认全部单测＋蓝图工具 | 1081/1081，0 fail/skip、exit 0，33.473 秒；不包括全部 scripts 的真实验收启动器测试 |
| 工作台完整浏览器 | 实现者最终 34/34、2.7 分钟，主代理冻结后再次独立完整运行 34/34、2.3 分钟，均 exit 0；包含新增 4 条角色纠错/刷新/跨分页/迟到 PUT/lock。使用严格 API 夹具，不是新用户真实生成或完整浏览器/DB 联调 |
| 功能锁及静态 | 25/25；`--base HEAD` 审计 ready=true；JS 语法检查及 `git diff --check` exit 0 |
| 前端构建 | exit 0，40.97 秒，既有大 chunk 提示保留 |
| 独立规格审查 | PASS；独立前端 57/57、后端 215/215。最终全浏览器条件已由 34/34 终态日志闭合，不冒称为规格审查者独立浏览器运行 |
| 独立质量审查 | APPROVE，无实质问题；独立前端 34/34、后端 16/16、功能锁 25/25、相关浏览器 5/5 与静态检查。与主回归重叠，不累加；未提供 LSP，不冒称其检查通过 |

完整浏览器中间 33 通过/1 失败来自旧测试 `blueprintDelay:800`：trace 显示 GET 在 873.448 ms 返回，报价随后才发出；读取前断言跨过响应窗口。仅将该测试改为显式 deferred GET 门闩，先检查禁止本地化/零报价/零版本写入，再释放并检查放行，原断言保留。单例 1/1 与完整 34/34 均通过，没有放宽产品门禁。另保留 esbuild 祖先目录沙箱读取失败、一次本地浏览器 `ERR_NETWORK_CHANGED` 和旧下拉鼠标交互被浮层拦截的日志；分别使用获准的正常本地权限、明确环境复核及仓库既有 focus/Enter 测试交互后通过。

当前 72 个代码/测试/清单文件集合（按路径排序后的 `JSON.stringify([{file,sha256}])`）SHA-256 为 `b1eae854dbbe562982462d112deeb1cb76af35a7d8e0e371d6851ffdb75fd62e`。前批 70 文件中 64 个逐字节未变，6 个重叠文件保留前序改动，新增后端/前端联测 2 文件；前批 34 工件 SHA 全部保持，旧 receipt 不修改。只对 `redraw.episode-blueprint-first` 追加本次用户授权；撤销本批追加后，前序整个 manifest JSON SHA 仍为 `d650f7733e23c1598a388ca2ef9ede67a4b9046af97b4ab2bb605667f08b0515`。

最终主要日志均在本工作树 `.codex-staging/`：`r2-speaker-backend-regression-20260905.tap`、`r2-speaker-lifecycle-green-20260905-final.tap`、`r2-speaker-frontend-all-20260905.tap`、`r2-speaker-browser-reviewed-root-20260905.log`、`r2-speaker-build-20260905.log`。机器回执为 `.codex-staging/r2-speaker-correction-20260905-verification.json`。规格审查和质量审查为先后两个独立子代理，准确运行范围以本任务终态回执为据，不把主日志伪称独立审查者日志。R2a 本地验证完成，本轮未读 Key、请求供应商、付费、SSH、访问生产库/shared、改模型、commit/push/merge/deploy/restart；没有当前差异 Hosted CI、全 Worker、真实多输入视听或用户最终验收证据。

下一项继续 R2 的文本/完整时间修订、镜头纠错和普通身份/动作素材入口。素材服务中的 pending candidate 是导入资产而非已生成转绘视频；现有 owner/CAS/hash 上传接口可复用，但必须补普通用户预览/选择、从当前母本制作动作素材，以及身份包服装选择的真正 owner/version 归属检查，不能把全局文件可读当作拥有。完整目标保持 active，R3—R8 的执行、声音合成、质量与移交仍未完成。

## 2026-09-05 R2b 后端对白文本／完整时间人工修订

本批仅实现 R2b 的后端证据合同和下游消费，不代表页面纠错、真实母本回放或完整 R2 已完成。工作树、分支及 HEAD 不变，代码仍是未提交差异；不以旧 Hosted CI 覆盖本批。

### 实际改动

- 蓝图对白可带严格七字段 `source_correction`，保留原 ASR 文本、完整时间与证据 SHA 锚点；有效文本放在既有 `source_text`，镜内时间为修订完整范围与所属镜头的精确交集。无修订的 schema／DTO 保持原合同。
- 原始锚点从当前 owner／work／source 绑定的真实 ASR JSON 校验；原文按既有 DTO 的 `trim()` 规范形式比较，原文件字节不变。合法人工修订返回明确 `manual_correction` 来源和原始文本／时间；`resolved` 不表示 ASR 识别了人工文字或用户已经批准。
- create／save／lock 在 owner／CAS 后、任何写入或同 hash 返回前，重新核验有修订条目的证据。旧入参 schema 规范化顺序保留；不增加未修订旧稿的文件检查要求。错误只返回安全代码，客户端不能指定服务器 storageRoot。原 ASR 资产及全部非蓝图业务表在隔离数据库测试中保持不变。
- 修复正常工作流锁定后无法预览的问题：持久记录已经 `locked`、JSON 审核仍为 `approved` 是正常状态。执行预览不再额外要求 JSON 写成 `locked`；持久记录状态、逐项审核以及蓝图／记录／版本 hash 检查全部保留。普通与人工修订两条真实保存→锁定→执行预览链均有测试，未伪造成功 locked JSON。
- 现有本地化与计划消费者接收修订文本和完整发声窗口；完整范围改变而镜内投影不变也使蓝图／源对白 hash 改变。没有增加新表、生成任务、报价、积分冻结或供应商请求。

### 当前验证及待闭合项

| 检查 | 结果与范围 |
|---|---|
| 新增后端纠错联测 | 54/54，0 fail/skip；独立迁移／SQLite／ASR 文件夹具，不导入另一测试套件；源 MP4 仅为 hash 字节夹具，不证明媒体解码或试听 |
| 主代理 12 文件串行回归 | 588/588，0 fail/skip，exit 0，85.458 秒；包括纠错、原声守卫、蓝图、人物纠错、本地化、预览／审核／队列、路由和功能锁，不是全后端 |
| 既有前端纠错回归 | 57/57，0 fail/skip，exit 0，0.907 秒；角色纠错、源对白审核与蓝图工具，未改前端，不代表新文字／时间编辑器已实现 |
| 功能锁 | 26/26；审计 ready=true、exit 0；仅追加三个实际触及功能的本轮授权，恢复前序整个 JSON 的 hash 仍为 `481c54768dbfce521e7ca30e45c0427828161cdc30bfe5de3f9ac922221089f9` |
| 静态检查 | 7 个触及 JS 的 `node --check` 和 `git -c core.safecrlf=false diff --check` 均 exit 0 |
| 独立规格审查 | PASS；独立 54+26 项全部通过，另验证合法修订与未标记修改另一句／story 共存仍保留旧保存策略，ASR 不变；diff-check 通过 |
| 独立代码质量审查 | APPROVE、0 问题；独立 54/54、26/26、语法／diff-check／安全模式扫描通过。未提供 LSP 工具，不声称运行过 LSP；与主回归重叠，不累加 |

保留所有中间失败：最初 RED、整个修订属性访问器缺口、下游夹具缺 `culture_map`、真实预览锁状态失败，以及测试试图修改已锁定不可变记录的夹具错误；后两者分别以正确工作流和独立无效记录反例修正，没有放宽数据库不可变触发器。日志名包含 green 不等于当次通过，以实际总数／退出码为准。最终聚焦日志 `r2b-dialogue-backend-green-final-20260905.tap` 和主回归 `r2b-dialogue-root-regression-20260905.tap` 位于工作树 `.codex-staging/`。

此前 R2a receipt 及 62 份工件已逐字节复核不变；72 个前序代码／测试／清单中 67 个未变，5 个是本项必要重叠，另新增纳入两份原来干净的蓝图服务与一份纠错测试。当前 75 文件集合 SHA 为 `bf907d9d18a4cc39aa1a320d0a660d440baef455ef25534d5c48232f4e862098`，仅绑定这一时点未提交文件。

**明确新发现的真实连接缺口：** `/redraw/works/:id/source-video` 尚未注册在真实后端，仅存在于前端测试夹具；工作详情的静态源 URL 不被审核播放器接受，且原生 video 请求不携带 API Bearer。因此不能把前批 fixture 回放称为实际用户母本回放已完成。后端审查终态后先补 owner／source hash 绑定的鉴权读取及真实 HTTP 测试，再接页面文本／完整时间修订和原文对照。前端还必须按整份 correction 撤销旧 DTO，即使镜内投影未改变。

本批机器回执 `.codex-staging/r2b-dialogue-backend-20260905-verification.json` 记录 75 文件／2 文档和本批完整日志、边界及审查回执来源。功能锁审计同时保留默认 `HEAD^` 和显式 `--base HEAD` 两次 ready=true，后者准确检查当前未提交差异；既有 npm 配置镜像提示不改变结果。R2b 的后端合同／下游联测已完成本地验证，页面与真实媒体连接尚未完成。

本批未改前端、未重新运行浏览器／构建／全 Worker；没有实际新视频生成、真实 ASR／语言／音画质量、当前差异 Hosted CI 或用户最终验收证据。未读 Key、联网请求供应商、付费、SSH、读写生产库／shared、改线上模型、commit／push／merge／deploy／restart。完整目标保持 active。

## 2026-09-05 R2b 母本鉴权只读回放后端

沿上一节已发现的真实连接缺口补实现，工作树／分支／HEAD 不变。本节只记录后端媒体读取；前端 blob 与文字／时间编辑器、完整 R2b 仍未完成。

### 实现与审查修复

- 新增真实 `GET /redraw/works/:id/source-video`，复用 Bearer 认证；只接受一次 `expected_source_asset_id` 和 `expected_source_sha256`。由当前 owner 的未删除 work 选择源视频，不使用客户端路径、外部 URL 或静态 URL。
- 校验源资产类型／用途、归属、源指纹及已有 hash／size；旧资产 `file_size:null` 保留兼容。验证根／祖先／最终文件路径、禁止 symlink 与越界，从安全打开的 FD 异步按 64 KiB 复制并计算 SHA。只有绑定一致才发送私有临时快照，不重新打开原路径，也不把大视频整份加载进服务器 Buffer。
- 响应固定 MIME、length、SHA、inline、private/no-store、nosniff；Range 请求可返回完整 200。请求中止和发送失败关闭 FD，只移除本次快照，不清理原素材／其它请求。读取接口不启动 Worker、FFmpeg 分析、模型查询、报价或生成。
- RED 揭示创建流边界的 owner 漂移：最终 DB 绑定检查移到创建流之后、发送头之前；原媒体在快照校验后改变时仍只发送先前核验快照，不泄漏新字节。
- 独立规格审查揭示通用租户中间件副作用：新注册异用户 GET 404 原先仍新建 tenant/member 两行，缺失的 membership 还会被重建。此 GET 现单独注册在原 Bearer 之后、通用初始化之前，只 SELECT active tenant/member，继续同一个 redraw handler；其它路由、全局认证和租户初始化不改。未通过预建 fixture 或排除租户表来掩盖拒绝路径写入。

### 当前证据

| 检查 | 结果与范围 |
|---|---|
| 正式接口 TDD | 缺路由 27 项 RED；创建流竞态 20 pass/1 fail；只读租户反例 4 pass/2 fail。修复后正式 52/52、0 skip、exit 0，28.116 秒 |
| 实际媒体 | 本地 FFmpeg 分别生成 MP4/MOV，经真实迁移 SQLite、router、Bearer GET 返回；字节／SHA／响应头一致，返回文件再次 FFprobe 可读。其它故障注入使用明确的字节夹具，不是语音或画面质量证据 |
| 主代理最终 9 文件相关回归 | 327 项：326 pass、1 skip、0 fail、exit 0，112.406 秒；含转绘路由、源音频、对白修订、功能锁、租户、登录和生成门禁，不是全后端 |
| 独立规格复审 | PASS；正式 52 项＋独立新用户零写／读取 EIO／写入 ENOSPC 3 项，55/55、0 skip、exit 0；独立功能锁 27/27。与主回归重叠，不累加 |
| 功能锁与静态 | 功能锁 27/27，显式 `--base HEAD` 审计 ready=true；5 文件 node --check 和 diff-check exit 0 |
| 独立代码质量审查 | APPROVE、0 问题；独立 source-video 52＋功能锁 27 共 79/79；额外 EIO／ENOSPC／部分写入／响应流错误 4/4，均 exit 0；运行时语法及 diff-check 通过。与主回归重叠，不累加 |

唯一 skip 为既有 `analyzeSourceAudio rejects a group-writable existing private root on POSIX`，当前 Windows 未执行该 POSIX 权限反例，不计通过。新回放的 Windows junction 路径用例无跳过；Linux 权限行为、大文件浏览器内存／加载、前后端页面联调尚未验收。

主最终日志为 `.codex-staging/r2b-source-video-root-reviewed-regression-20260905.tap`；正式接口日志 `r2b-source-video-readonly-tenant-green-20260905.tap`，独立审查日志 `r2b-source-video-spec-final-20260905.tap`。原 59 MB 的失败断言日志、夹具缺时长错误、功能锁等待新增测试文件的失败，以及全部真实 RED 均保留。实现者仅清理了 27 个经精确确认的失败测试临时目录，可由测试重建；没有删除日志、历史候选或用户素材。

前批 receipt SHA 保持 `d8253d70058a0b7301868ae23848d08f3c1c3a238cb57723a03338163c5ec8dd`，14 份前批日志逐字节不变。75 个前序源码／测试／清单中 71 个未变，4 个为路由及功能锁必要重叠，新增 service/test 2 文件；当前 77 文件集合 SHA 为 `c8e750521965e527d1c7075e07d09a108669589a05ee1ce5ae5c175626a5064e`。五项功能锁只追加本轮真实授权及历史；撤销本批追加后整个前序清单 JSON SHA 为 `48d58abadc3575ac230c208cefd406e3d43aabe5bbe25ed86f9ec8a8af59aaf9`，保护范围／requiredTests／状态／证据均保留。

机器回执 `.codex-staging/r2b-source-video-20260905-verification.json` 记录本批精确文件／文档／日志及边界。独立质量日志为 `r2b-source-video-quality-independent-20260905.tap` 和 `r2b-source-video-quality-io-probes-20260905.tap`，两者虽沿用 `.tap` 扩展名，实际使用 Node 默认 spec reporter；不误报格式。主代理在页面修改前另外复跑既有前端对白审核／角色纠错／蓝图工具 57/57，exit 0，作为下一子步基线。

本批没有修改前端、运行新的浏览器／构建／全 Worker／Hosted CI；没有真实转绘生成或内容质量验收。未读 Key、请求供应商、付费、SSH、生产 DB/shared、改模型、commit/push/merge/deploy/restart。后端回放子步已完成本地双审验证；下一步连接页面鉴权 blob、逐句文本／完整时间修订及原识别对照，完整目标保持 active。

## 2026-09-05 R2b 页面母本回放与对白修订连接

沿同一计划接入已审后端，不新增接口平台。HEAD／分支不变，当前仍是未提交本地增量。首轮质量发现的媒体 409 恢复入口 P2 已由原实现者补正式反例后修复，增量规格 PASS、质量复审 APPROVE，R2b 本地双审完成；完整 R2 和主目标仍未完成。

- 页面显式“加载母本”，通过既有 Bearer 请求固定 source-video API，只发送源资产 ID／SHA 两个 CAS 参数。直接消费 Blob，忽略 work 的外部或静态 URL；每次请求独立 AbortController／epoch，作品、源、修订切换和卸载使旧响应失效，暂停播放器并释放自建 URL。媒体失败、409 和不可解码有明确状态，不自动下载重试或触发分析／报价／生成。
- 逐句编辑文字与完整起止秒数，使用安全整数毫秒，镜内时间只取完整范围与镜头交集。原始识别来自持久化服务端 DTO，可与人工修订并排核对；取消不改稿，应用只改草稿，保存／刷新后才有新核验结果，必须重新审核。重复编辑和恢复保留同一个原始 ASR 锚点，不改原音频证据。
- 实际产品联测发现前端只认 `asr`，而后端还支持 `audio`／`audio_transcript`／`transcript`；已先补反例再对齐。原始识别上限 16384 与有效对白上限 500 分开处理，拒绝 NUL。长原文仍完整保留，超过 500 字时显式恢复会报错且不改稿，不能截断或放宽后端合同。
- 在既有后端纠错测试新增四条实际前端 payload→真实 GET／PUT／lock 联测：重复修改原锚点、仅完整时间变化而镜内投影相同、保存后恢复原句，以及证据漂移后零数据库写入拒绝。源 MP4 在这些联测中仍是 hash 夹具；真实解码证据来自前一节的媒体接口测试，不能混称本测试已听看。

| 检查 | 当前终态与范围 |
|---|---|
| 页面 TDD 聚焦 | 初次 73 项中旧 57 pass／新 16 fail；补音频类型、长锚点、媒体身份及迟到释放反例，首轮冻结 82/82；质量修复后最终 83/83，0 fail/skip，exit 0 |
| 实际产品 payload 联测 | 后端纠错套件 58/58；冻结后与功能锁合跑 86/86，0 fail/skip，exit 0 |
| 相关后端 11 文件 | 603/603，0 fail/skip，exit 0，145.980 秒；不是全后端，也不累加与聚焦重叠的测试数 |
| 前端默认全部单测＋蓝图工具 | 修复前 1106/1106，修复后 1107/1107，0 fail/skip，exit 0，44.210 秒；不含 scripts 真实验收启动器全集 |
| Chromium 工作台 | 首轮实现者 34/34；质量修复后主代理独立全量 35/35，exit 0，2.0 分钟，独占 localhost:3019。使用严格 API 夹具及实际本地视频，普通用户路径检查 Bearer／精确 CAS、整句 seek/stop、取消／应用／保存／重审及媒体 409 页内恢复；不是真实数据库浏览器完整联调 |
| 功能锁／构建／静态 | 28/28，`--base HEAD` 审计 ready=true；修复后前端 build exit 0，31.20 秒，既有大 chunk 提示保留；5 个触及 JS 的 node --check 与 diff-check exit 0 |
| 独立规格审查 | 初轮 82/82＋86/86＋浏览器 2/2 PASS；修复后增量 83/83＋普通用户浏览器 3/3 再次 PASS，迟到响应／零自动下载保存生成边界保留 |
| 独立质量审查 | 首轮 82/82＋86/86 后发现 P2；修复后原样 409 探针及 83/83 通过，APPROVE，Critical／Important／Minor 均 0。与主回归重叠，不累加；质量审查者未重跑完整浏览器／构建 |

初次浏览器启动和前端全量中的 7 项失败均定位为 esbuild 读取祖先目录遭沙箱拒绝；获准对同一本地命令使用正常权限后通过，未为测试更改产品安全代码。所有 RED／中间失败日志保留，包括真实产品联测揭示的音频证据类型不兼容；日志名含 green 不作为通过依据。

本轮前端修改 API、蓝图 review utility、ReviewPanel、source review 测试和 workspace E2E，新增 dialogue correction 测试；既有 speaker 测试只运行不编辑。主代理只增补真实产品联测、唯一计划／总报告和 `redraw.episode-blueprint-first` 本次授权。大 Blob 内存／长视频加载体验、其它浏览器与 MOV 编解码、全 Worker、当前差异 Hosted CI、真实生成和用户内容验收仍未验证。没有读 Key、请求供应商、付费、SSH、访问生产 DB/shared、改模型、commit/push/merge/deploy/restart。

质量反例与关闭：初始无其它错误时，媒体 GET 409 令 `conflict=true/canEdit=false`，但错误只进入 `playbackError`，既有刷新按钮被外层 `visibleError` 隐藏。独立实际 SFC RED 保存在 `r2b-dialogue-ui-quality-media-409-recovery-red-20260905.log`（exit 1）；实现者补正式 SFC 25 pass／1 fail 和普通用户浏览器按钮缺失 RED，再仅在媒体 catch 增加 `if (conflict.value) localError.value = playbackError.value`。两位独立审查者复审关闭，原样探针 GREEN 和全部旧 RED 保留。用户刷新不自动下载，仍须明确点击加载；不新增全局错误平台。

本批 78 个源码／测试／清单的集合 SHA 为 `a8d6670013dd98dd5940ab51c885d26cd3bda6cfc5fc52b732b91e99fa78dd68`。前批 77 文件中 69 个逐字节未变，8 个必要重叠，新增前端纠错测试 1 文件；旧回放 receipt SHA 仍为 `ec63f0ae66008ae1e6654cb39886ab816a895b4175daa29179d4c33b3ceee4da`，其 30 个工件 SHA 均保持。功能锁只追加 `redraw.episode-blueprint-first` 的本次授权，撤销本批后前序整个 manifest JSON SHA 为 `247837359551f5316035e0ceec5633acca53b6783ba2e04b1382558e05f34f50`，其它保护字段不变。

新机器回执 `.codex-staging/r2b-dialogue-ui-20260905-verification.json` 绑定文件／文档／日志、真实退出码、失败历史与双审证据。最终主日志为 `r2b-dialogue-ui-frontend-quality-final-20260905.tap`、`r2b-dialogue-ui-browser-root-final-20260905.log`、`r2b-dialogue-ui-build-quality-final-20260905.log`。完整目标继续 active，下一项 R2c.1 连接镜头构图／动作／可见角色、场景／道具的显式纠错；切镜、素材、动态执行、合成及真实用户验收仍按唯一主线顺序推进。

## 2026-09-05—06 R2c.1 镜头、场景与道具事实编辑

本批 R2c.1 已完成本地实现与顺序双审：独立规格 PASS、质量 APPROVE，无阻断问题。完整 R2c／R2 和产品目标仍未完成。HEAD 仍为 `8c49a90773a4311992e4eb9b6a5bc2c9acdfa4ed`，未提交／推送。前端实现者的 4 文件冻结 SHA 见 `.codex-staging/r2c-visual-facts-implementation-20260905.json`；主代理和两位审查者在 2026-09-06 回读全部一致。

- 现有蓝图卡片可显式编辑镜头构图、运镜、起始／连续动作／结束状态、可见角色，以及场景地点／时间和道具名称。可见角色按名字选择，无需填写内部 ID；三类编辑共用一个局部编辑状态，与对白编辑互斥，支持取消和应用到草稿。
- 文本和白名单校验对齐现有后端合同；原始素材、ASR、引用／SHA、稳定 ID、镜头与整句时间、已有对白修订、置信度和未选对象保持。纯事实文字使总体待审；可见人物集合真正改变时，相关镜头全部对白也重新待审。同一集合仅排列不同不额外降级。不能删除画内对白仍引用的人物或暗改成画外。
- 应用不自动保存、分析、报价、生成或冻结积分；复用已有 owner、CAS、锁定和页面 epoch／媒体停止／409 刷新。后端运行时无需新增修改；新增联测将实际前端 helper 输出送入真实 handler 与迁移 SQLite，核验保存／读回／批准／锁定／事实投影、拒绝路径零写入和其它业务表不变。

| 检查 | 当前已取得的证据 |
|---|---|
| 正式 TDD | 前端 30 项缺 helper／编辑入口 RED；实际浏览器缺编辑按钮 RED；独立的播放停止反例 RED；新增后端 6 项缺 helper RED，均保留日志 |
| 新前端及兼容聚焦 | 新增 unit／实际 SFC 31/31；含 R2a／R2b 兼容聚焦 114/114，0 fail／skip，exit 0 |
| 实际产品保存联测 | 新增 6/6；与既有 workflow／对白修订／功能锁合跑 115/115，0 fail／skip，exit 0，14.515 秒 |
| 普通用户工作台 | R2b／R2c 聚焦 3/3，完整 Chromium workspace 36/36，exit 0，2.5 分钟；strict API fixture 和本地媒体，不冒称实际 HTTP＋SQLite 浏览器全链 |
| 完整前端 | 默认 `test/*.test.js`＋蓝图工具 1138/1138，0 fail／skip，exit 0，34.657 秒；不含 scripts 真实验收启动器全集 |
| 构建／功能锁 | build exit 0，34.00 秒，原有大 chunk 提示保留；功能锁 29/29，显式 `--base HEAD` 审计 ready=true |
| 独立双审 | 规格 PASS、质量 APPROVE，无阻断问题；各自独立前端 91/91、后端 35/35，均 exit 0、0 skip，冻结 SHA 一致。与主回归重叠不累加；两位未重跑完整前端／构建／workspace |

首轮后端真实执行的 6 项失败来自新增 fixture 共享 `evidence_refs` 数组，被既有循环／重复引用守卫拒绝。只对 fixture 执行 JSON 序列化，使其与实际 HTTP JSON 输入一致后 6/6 通过，没有修改或削弱生产服务守卫。功能锁正式新反例先 RED，追加 `redraw.episode-blueprint-first` 本轮授权后转绿；还原本次历史追加后，前序整份 manifest 的规范 JSON SHA 仍为 `ecd4a087041813f14fc5e60301759d4ed3845475b3220b2fdc2e9b41443f2810`。

2026-09-05 的完整前端和 build 日志没有终态，原运行句柄随后不存在；2026-09-06 只读进程核查确认对应 Node 测试／构建进程已停止，故这两份日志只记运行中断、退出码未知，不计通过。四个冻结源文件未变化后，才以新日志重新运行并显式持久化 `NODE_EXIT=0`／`BUILD_EXIT=0`。旧日志原样保留，没有因观察超时而并行启动重复进程。先前未给出结论且已不在当前代理树中的规格审查也未计通过，已重新委派独立审查。

有效全量日志：`.codex-staging/r2c-visual-facts-frontend-full-20260906.tap`、`r2c-visual-facts-build-20260906.log`；后端为 `r2c-visual-facts-backend-focused-20260905.tap`，工作台为 `r2c-visual-facts-browser-workspace-20260905.log`。本批未做新编辑器专门手机视觉验收、真实页面＋数据库全链、切镜、素材、Worker 全量、新 HEAD CI、供应商生成或用户内容验收。没有读取 Key、SSH、供应商／付费、生产 DB/shared、线上模型修改、commit/push/merge/deploy/restart。

双审回执为 `.codex-staging/r2c-visual-facts-spec-review-20260906/06_spec_review/compliance-report.md` 和 `r2c-visual-facts-quality-review-20260906.md`。质量审查特别限定：新后端 6 项的投影断言是锁定响应再投影，不是逐项核对下游 version／shot 表；既有 workflow 套件有持久化断言，但不能把新增 6 项单独称为完整下游数据库验收。本批没有审查后业务修复或源码漂移。

本批最终源码／测试／清单 80 文件集合 SHA 为 `1c9e7c1ab4252fbeb11c7cc10200dd554204af02a1ac2beac2ee2193b2076fda`，前序 78 文件中 73 个保持、5 个必要重叠，新增前后端事实测试 2 个。旧 R2b receipt SHA 仍为 `1fe79a37ef321a2046b06f07f3941968bddf1822169caaa08c8f605bad5d1cf9`，43 个旧工件逐字节不变。新回执 `.codex-staging/r2c-visual-facts-20260906-verification.json` 记录本批源码、文档、日志与实际边界；R2c.1 仅本地完成，接下来继续 R2c.2 切镜后的对白归属与源证据复核。

## 2026-09-06 R2c.2 切镜来源复核：后端本地双审完成，页面待接续

R2c.1 receipt 已在进入新阶段前逐项验证 80 个源文件、2 文档、39 工件及前批 43 工件，receipt SHA 为 `8285b601406d92694be51d5418dc180afb19a66a0a7b84ffd8bbc13bff7318b9`。之后为 R2c.2 修改同一计划／报告、功能锁和源文件是下一批增量，不覆写旧 receipt。当前切镜功能尚未完成，不以 R2c.1 的绿色证据替代。

新实现者已取得正式后端 RED：29 项中 2 pass／27 fail／0 skip、exit 1。首项真实产品保存返回 HTTP 200，但响应中的原对白解析已是 `SOURCE_DIALOGUE_PROJECTION_MISMATCH`，证明现有写前校验未覆盖普通 ASR 切镜。其它反例覆盖保存后漂移、同 hash／lock、删除对白／ID／标记／镜头及移到未核验镜、同源新修订、静默证据与原兼容。日志 `.codex-staging/r2c-boundary-backend-red-20260906.tap`，SHA `0cbc06f205d3255e6f8a08fdecac37cae5b1a4636e8bb0084001f68dac388c55`；主代理已读取真实失败行，不是把 fixture 初始化失败认作业务 RED。

本批仅派同一实现者修改蓝图规范化、工作流和现有源对白 resolver，加一个新 boundary 测试；前端等后端双审后再接。因空对白 resolver 直接返回 []，最小扩展一个只读范围核验入口以复用原安全文件读取，区分无音轨、VAD 零语音及全局 spoken 证据中的无对白区间，不扩大未切镜旧稿的保存策略。错误优先沿用现有人工修订 400 合同，不因新增未知错误码变成页面 500。

主代理的功能锁追加已经 RED→GREEN；当前完整功能锁 30/30、0 skip、exit 0，只追加本轮蓝图授权，回溯前序全 manifest 规范 JSON SHA 为 `484f5b23226f0ad61a9426655710bd0ec488d1cacddf6f5aa8279c8aad48290e`。运行时冻结后的 `audit:feature-lock -- --base HEAD` 为 ready true、exit 0；日志 `r2c-boundary-feature-audit-20260906.log` 含 `AUDIT_EXIT=0`。独立规格审查已启动，尚无双审终态。依旧零 Key／供应商／付费／生产／Git 写入，主目标保持 active。

实现前进一步核对发现：`shot.audio_contract.silent` 在现有规范中表示本镜未持有对白，不等于本镜时间段无物理语音；跨镜原句只归属一个镜。已纠正早期过严的静默建议，要求新增“本镜空对白、跨镜整句在另一镜唯一且完整核验”正向反例，不能把合法跨镜拒绝为缺失语音，也不能复制一句到两镜。这是范围验证语义修正，不改原始 ASR 或既有音频合同。

实现者最终后端候选已冻结：新增 boundary 37/37、0 skip；11 文件相关回归 395 项中 394 pass／1 skip／0 fail。唯一跳过为 `analyzeSourceAudio rejects a group-writable existing private root on POSIX`，Windows 不适用。两个命令工具退出码均为 0，TAP 本身未嵌入 EXIT 字段；不混淆这两种证据。对应 `r2c-boundary-backend-green-r4-20260906.tap` SHA `e3d937f488809234463510e354a1dbb8fe98dbe8f19e4ae06a3fa12b70c659e4`、`r2c-boundary-backend-focused-r2-20260906.tap` SHA `110168d0390017f30a2d51e74a798c6a364eab8f815ef0ed8a9d0947f6da46d2`；主代理已读终态并核对 hashes。三服务及新测试语法检查、精确 diff 检查均 exit 0。专项和相关测试重叠，不相加。

新增测试已通过真实保存／重新批准／锁定后的本地化规范化，再使用已保存的规范本地化审核 fixture 进入实际版本执行预览：父镜新边界 5500 ms、原句 4600–6800 ms 不截断、四句各一次且仍 `executable: false`。这是后端消费路径，不是浏览器默认分析／用户本地化／生成闭环，源视频 fixture 仍非可解码质量验收素材。全部 RED、跨镜语义反例及一次目标语言 fixture 错误的过渡失败原样保留；没有放宽业务规则来消除 fixture 错误。

此时前序 80 个源码文件仅声明的三服务和功能锁两文件变化，新增一个 boundary 测试；R2c.1 receipt SHA 及其 39 工件无漂移。切镜 UI 尚未实现，后端待独立规格→质量，完整 R2c.2／R2 不勾选。

独立规格审查随后发现 P1，后端尚不通过：原始未标记稿只转移对白归属而不改切点时，`inheritBoundaryCorrections` 过早返回，正确转移未撤销旧批准，错误投影也可保存并锁定。审查者以真实 handler 复现两个反例 exit 1，主代理核对提前返回条件后已交原实现者补正式 RED→最小修复；不能把前述 37／394 绿色测试当规格通过。修复后需重新冻结并回到规格复查，通过后才委派质量审查；旧日志与失败回执保留。

第一次规格修复新增 6 条正式 RED 后，专项 43/43、相关 400 pass／1 权限 skip／0 fail，工具 exit 0。主代理读取终态并核对 workflow／test 及相关日志 SHA；`specfix-r1-focused-20260906.tap` SHA `a222c87aed30ee827b999493e71300f8bd6048ad87fc746fef9027aba65f063e`。独立复查的原 2 反例通过，但又发现“同时移动并改 ID”仍可避开早退前的同 ID 比较，保存和锁定均 200，来源为 `SOURCE_DIALOGUE_SEGMENT_NOT_FOUND`；因此本轮复查仍 FAIL，而非双审通过。根已交同实现者将旧新 ID 差异也纳入 affected 种子，参数化覆盖未标记稿删除／新增／改名及同源修订；保留不切不移且 ID 未变的旧稿兼容。日志继续使用全新 specfix-r2 前缀，未覆盖任一次失败或通过记录。

第二次修复的 8 个 ID 差异反例均先 RED（52 项中 44 pass／8 fail，另含原 schema 重复 ID 正例），修后专项 52/52，11 文件相关回归 410 项中 409 pass／1 同上权限 skip／0 fail，工具 exit 0。主代理已读取日志及 hashes：`specfix-r2-green-20260906.tap` SHA `f774910be9666711fee14d38c8c47a5794683fd7121a306780a75b152d221322`，`specfix-r2-focused-20260906.tap` SHA `ccd9b22aae050c97cab258c615bbbb05ef1f9d39e6c14440c9b1fae285cd7e0a`。独立规格第三轮 `r2c-boundary-backend-spec-review-r3-20260906.md` 为 PASS：重新运行正式 52/52、原三反例及同源正常修订／真实 work 换源两条隔离绑定分支共 5/5，均有 `NODE_EXIT=0`；4 文件 SHA 入场／结束相同。前两轮 FAIL 不追改为通过。现在只进入独立质量审查，尚未开始 UI。

根最终静态日志 `r2c-boundary-backend-final-static-20260906.log` 记录三服务／新测试各 `NODE_CHECK_EXIT=0` 和 `DIFF_EXIT=0`；功能锁最终 30/30、`audit:feature-lock -- --base HEAD` ready true，两个新日志均显式 exit 0。当前 81 源码／测试／清单文件集合 SHA 为 `b7cb74a752b45e7e77fb0259224d2f564fe8806ca9588573c3a2def044c90d8f`；前序 80 文件中仅声明的 5 个重叠，新增 boundary 测试 1 个，旧 39 工件无漂移。后续若质量修复必须以新快照及回执记录，不能沿用这组 hash 宣称更新后的通过。

最终独立质量为 APPROVE，仅本批后端，无 P0–P2 或待确认阻断。回执 `r2c-boundary-backend-quality-review-20260906.md` SHA `2f5f6c95c430cd38bf44475d706c0244655317a6e5e5c68707437e65565fa925`；独立正式 52/52，另 4/4 交互／事务探针检查已修订对白切镜、空邻镜跨镜整句唯一归属、反复反向切点和下游物化失败回滚，工具 exit 0。结束四文件语法及 SHA 全保持；根已读取新日志和报告，不以实现者自审代替双审。机器回执为 `.codex-staging/r2c-boundary-backend-20260906-verification.json`，绑定这组 81 文件、唯一文档和完整成功／失败历史工件。

后端局部至此本地完成，继续执行同一计划中的原子切点／归属页面、保存后重审及真实 helper payload 联测；完整 R2c.2、R2 素材、单元执行、音轨合成、整产品回归／当前版本 CI、真实多输入和用户验收均未完成。没有前端或 Worker 全量新证据、供应商实测或生产行为，不将后端 gate 通过写成“一键转绘已交付”。

## 2026-09-06 R2c.2 原子切镜页面：本地双审完成

后端双审 receipt SHA 为 `a975526577773577b064b25a633aa221ea512d84a3975338b8d332b81588ab89`，进入本页面子步前 81 个源文件、2 文档、36 工件全部核对一致。页面子步的源码／联测／功能锁／文档变化属于新批次，不覆盖该 receipt 或其历史日志。HEAD 仍为 `8c49a90773a4311992e4eb9b6a5bc2c9acdfa4ed`，不提交／推送。

新实现者只负责既有审核工具、蓝图面板、新页面专项测试及工作台浏览器测试四个前端文件；主代理负责真实后端 payload 联测、功能锁及唯一计划／报告。修改运行时前，主代理亲读并确认两组有效 RED：

- Node helper／实际 SFC 36 项中 1 pass／35 fail、exit 1，日志 `r2c-boundary-ui-node-red-20260906-01.log`。除了缺少切点 helper／编辑器的预期失败，还复现保存返回待重审稿后旧面板仍发出 lock：实际调用 `['save','lock']`，要求只能 `['save']`。
- Chromium 实际页面 1 fail、exit 1，日志 `r2c-boundary-ui-browser-red-20260906-02.log` 及同名前缀 trace；失败是页面没有“调整与下一镜切点”入口。此前 `-01` 仅为本地 esbuild 沙箱路径权限失败，原日志保留，不计业务 RED，也没有因此安装依赖或修改业务规则。

根独立联测 RED 位于 `r2c-boundary-ui-backend-payload-red-20260906.tap`：3 项中原直接草稿链 1 pass，两条真实页面 payload 链因 helper 缺失 2 fail、exit 1。新增链分别覆盖切点和整句归属原子修改、先修订完整对白再切镜；目标是经真实保存／重审／锁定／本地化规范化和执行预览，而不是仅检查前端对象。其本地化审核持久化仍是隔离 fixture，不冒充普通用户完整默认管线。

功能锁仅向 `redraw.episode-blueprint-first` 追加本轮页面本地授权并保留历史；前序整份 manifest 规范 JSON SHA 为 `c6c187d2449ebf41850461b1b868471fb4bb86bdb861e10f29407ea847becc8a`。新历史完整性测试已 RED→GREEN；完整功能锁 31/31、0 skip、exit 0，日志 `r2c-boundary-ui-feature-full-20260906.tap`。保护范围、必跑测试与其它功能状态不改。

已批准该实现者进入 GREEN，但页面、真实 payload 联测、浏览器及独立规格／质量尚无本批终态。空对白页面草稿只能显示待服务器证据核验，不能声称已证明无语音；保存撤审后必须停止锁定，等待用户重新审核。持续保持零 Key／供应商／付费／生产／部署和 Git 写入边界，完整目标 active。

进行中联测更新：上述 3 条实际保存至预览链已全部通过（`r2c-boundary-ui-backend-payload-green-inprogress-20260906.tap`，3/3、exit 0），完整原句／人工修订锚点及四句各一次均保留。另补 6 条空对白页面 payload→真实服务器回归：无音轨和有效 VAD 接受但要求重审，缺证据／缺 VAD／非法 VAD／覆盖时长不足均 400 且零写。新增回归执行时并行实现者已写入 helper，因此首次就是 6/6、exit 0，**不是 RED**；历史文件名 `r2c-boundary-ui-empty-payload-red-20260906.tap` 不重命名、不覆盖，也不据文件名虚报失败。真正先失败的 helper／SFC 和上述 2 条有声 payload RED 仍保留。实现者页面专项现为 39/39，根已读取终态；这些进行中证据不能替代最终冻结、浏览器、相关回归和独立双审。

浏览器首轮 GREEN 尝试仍有两项失败，日志 `r2c-boundary-ui-browser-green-20260906-01.log`／trace 保留。一项是真实切镜至保存／重审／锁定已走通，但新严格夹具错误地把成功锁定之后的既有本地化报价也拒绝；根回查 `RedrawSourceStep.ensureLocalizationQuote`、蓝图 watcher、后端报价函数及原工作台测试，确认原合同就是锁前 0、锁后展示 1 次报价，尚未创建本地化或生成任务。故不改父页面、模型或计费，只精确修正新夹具的阶段边界，锁前／重复／错参报价仍失败、其它写请求仍拒绝。另一项是测试猜了不存在的“继续显示”按钮文字，按实际 DOM 的既有分页按钮定位；没有改变产品分页。此处采用系统化调试，未把测试假设错误当业务缺陷扩大修改范围。

根在 helper SHA `5866d73d48acf05c9ce5660ef80e360cf789047a5a979044ff1b18e36108c470` 上完成 11 文件相关后端：418 项中 417 pass／1 既有 POSIX 权限 skip／0 fail、exit 0，35.938 秒；日志 `r2c-boundary-ui-backend-focused-20260906.tap`。后端专项现为原 52 加本批 8 条页面联测，共 60 条，包含在相关回归中不重复累加。后端三个运行时和此前 36 工件保持原 SHA。

实现者最后自查补了空对白路径的非法源 ID／音频对象正式反例（1 fail、exit 1），再以局部输入校验修复；新专项 40 项、相关前端 143/143、exit 0。最终冻结 utility SHA 为 `6363c8f7192a5d786c585c7308ce98a9e9db16ee0a6e5fedf23671a4bb8b7747`，panel 为 `d816ec222f5ec9a22ebd9f10117b5c32de207f6290cfff4970ff384b4faeeb73`；正式测试及 workspace SHA 分别为 `27d71c0dc0d1e069bc79721561a9d5f1674fdfe2e4fa29e78b26a8a16bc0a7c3`／`749e22c038a9a26b45ecad81a2325b7799b5765722a3abb9adec70437523654d`。根在新 helper 上重新完成同一 11 文件相关后端，仍 417 pass／1 skip／0 fail、exit 0，39.709 秒，`r2c-boundary-ui-root-backend-final-20260906.tap`。

冻结后的默认全部前端单测加蓝图工具为 1178/1178、0 skip、exit 0，29.048 秒（`r2c-boundary-ui-root-frontend-all-r2-20260906.tap`）；构建 31.89 秒、exit 0（`r2c-boundary-ui-root-build-r2-20260906.log`），保留既有大 chunk 警告，不在本批顺手改构建架构。两项首次在沙箱内分别 7 fail／构建失败，根逐项核对均是 esbuild 读取祖先目录及 Vite 配置被拒绝；通过本机权限重跑相同命令、没有代码或依赖变化后通过。失败日志不删，不把环境失败混为业务 RED。

实现者完整 Chromium workspace 38/38、exit 0、2.3 分钟（`r2c-boundary-ui-workspace-20260906-01.log`），含新增两条普通用户切点／跨分页归属及既有纠错、媒体、迟到回执、队列、生成／导出夹具回归。根亲读终态并查看实际编辑器截图，但这些严格 API fixture 不能声称真实数据库浏览器默认链或生成质量通过。JS 语法与精确／全工作树 diff 检查通过，功能锁 31/31、显式 `--base HEAD` 审计 ready true，exit 0。

当前仅启动独立规格审查，尚未有本页面的规格／质量双审结论，因此不勾选 R2c.2 或整体 R2。没有重新调用真实供应商、付费、Worker 模型下载、生产或 Git 写入；所有结果属于当前未提交字节，不引用旧 HEAD CI 覆盖它们。

最终独立规格 PASS：143/143 前端、91/91 后端与功能锁、6/6 独立探针，均 exit 0、无跳过；报告 `r2c-boundary-ui-spec-review-20260906.md` SHA `8f059f4721623650dba21ec0c23d74e79cf6c3f5a066a3502bb73140dfb5a19e`。探针含 24 轮多句交替切镜、未标记纯归属、重复 DTO、不可见目标，以及总体 approved 但单句待审或画内映射无效的保存回执。另一位未参与页面实施的独立代码质量审查为 APPROVE、无 P0–P2：143 前端、仅本批新增 8 payload、31 功能锁、4 独立探针全 exit 0；报告 `r2c-boundary-ui-quality-review-20260906.md` SHA `67b0f18019c4ce27adb40437d358d2ce00894af525466227baf456a21128a7e2`。质量审查明确不把该审查者此前实施的后端 3 个运行时／原 52 项测试算本轮独立审查。两轮日志的完整工具原始输出和真实退出码均已回读，五个冻结文件入退 SHA 相同；这些重叠测试不累加。

R2c.2 后端与页面子步至此本地双审完成。机器回执 `.codex-staging/r2c-boundary-ui-20260906-verification.json` 绑定 82 个当前源码／测试／清单、唯一两份文档和本批工件；源集合 SHA `3bda6c10ae88aaf1741ab7988d13e01e38fcbf4b64f3c73a60a3dad70e73db98`，较前批 81 文件仅声明的 6 个重叠变化，新增前端专项 1 个，前批 36 工件原样。新编辑器移动端视觉／完整无障碍、真实浏览器数据库默认全链、Worker 全量、精确 HEAD CI 与真实多输入质量仍未验证，不用既有局部截图／fixture 或旧 CI 冒领。

下一项按既有主线接普通身份图上传／选择／审核，再补当前母本动作参考制作／登记／预览；该阶段收口时仅做接口只读定位，没有提前实现。R2 素材、R3 执行恢复、R4 音轨与下载、R5 多输入回归／CI、R6–R8 真实验收与移交仍未完成，目标 active。保持零 Key／供应商／付费／SSH／生产／commit/push/merge/deploy。

## 2026-09-06 R2d.1 身份图普通上传：开始本地 TDD

进入本批前实读 `r2c-boundary-ui-20260906-verification.json` 并逐项复算：82 源文件、2 文档、54 工件及父批 36 工件均无漂移；receipt 本体 SHA `e5c674bd6b1c36e95421345e5778e8e0237e7d3413bee9d604b7bc7605a59367`。此后本计划/报告及声明的 R2d.1 文件变化属于新批次，不覆盖前批证据。

主代理现跑的既有导入基线：`node --test --test-reporter=tap --test-concurrency=1 backend-node/test/redrawReferenceArtifactImport.test.js` 为 25/25、0 skip、exit 0；HTTP reference artifact/motion/abort 筛选为 7/7、0 skip、exit 0。原始日志分别 `r2d-identity-upload-root-import-baseline-20260906.tap`、`r2d-identity-upload-root-http-baseline-20260906.tap`，均含实际 `COMMAND_EXIT=0`。这些只证明现有导入测试通过，不是新页面或身份包刷新问题已通过。

功能锁仅追加 `redraw.episode-blueprint-first` 本地上传入口授权，旧清单整体规范 JSON SHA `17de8648f5ff5a3ee04472a3655dbcdc905b44428d192aaf8c6eb14b43b356b0`；新历史完整性测试先 1 fail，再 1 pass，日志 `r2d-identity-upload-feature-red-20260906.tap` / `r2d-identity-upload-feature-green-20260906.tap`。不变更保护路径、必跑列表、历史批准或模型信息；完整 feature 回归待本批新测试落地后执行。

新实现者负责 API、角色卡、真实专项/浏览器测试；经代码核实增加父 AssetStep 最小接线：当前 `identity-saved` 不返回异步刷新结论，且旧刷新会重新报价，需要无报价只读刷新回执来维持失败冻结，不能假定事件发出就是刷新成功。另发现上传可能保留旧身份包的审核绑定线索，随后启动下述独立只读诊断；不允许靠虚假清包 fixture 或客户端遮掩把该缺口计为完成。

独立真实 SQLite + 两张可解码 48×64 PNG 已复现缺陷：import→saveIdentityPack→真实 review handler 批准旧图 1；换图后当前图 2、旧包内仍图 1、pack/status ready 仍 true，再次未重存直接批准返回 200/approved。原 source_ref_json 字节未变；同一真实数据库和媒体经参考包身份校验/物理准备校验仍拒绝，所以本结论是审核状态误放行，不等于实际供应商生成绕过了所有门禁。诊断探针 `.codex-staging/r2d-identity-binding-audit-20260906/probe.cjs` 与全部本地工件保留，未发 HTTP 监听或调用供应商。探针以原函数追加诊断导出检查两个下游函数，未声称完整生产包编译或生成端到端。

页面正式 RED 已读取：Node/SFC 39 项中邻近 14 pass、新 25 fail，exit 1；Chromium 新两项均因不存在“选择身份图片”入口 fail，exit 1。原日志 `r2d-identity-upload-node-red-20260906-r2.log`、`r2d-identity-upload-browser-red-20260906-r2.log` 保留。首次 Node 测试加载器语法问题、首次浏览器 esbuild 祖先目录权限问题均不计业务 RED；后者仅以原命令本机权限升级取得真正缺入口失败。前端现仅有新正式测试及 workspace 夹具变化，运行时未改，按子代理驱动的共享依赖规则暂停 GREEN。

已在唯一计划确定前置最小修复：全新后端实现者只负责 import service 和既有 import test。成功 identity 导入在原 CAS/事务撤销顶层旧 identity_pack；保留 source_ref、其余 metadata、旧媒体行/文件，wardrobe 和幂等 replay 不撤销，冲突/失败不改旧包。既有 saveIdentityPack 本来即覆写顶层确认包，未见该调用链必须保留旧包审计版本的合同；不建立新历史平台，也不冒称所有历史错误绑定数据或其它替图入口已修好。待独立规格/质量终态后才恢复页面实施。完整功能锁基线 32/32、0 skip、exit 0，但 R2d.1 仍未完成，没有开始动作素材或真实生成。

上述诊断报告已固定：`r2d-identity-binding-audit-20260906/report.md` SHA `81e8f69c877f7bb9354ff974e3015e6feaa0ec4aca284061da978ac0aea8cc2e`；`probe-success.tool-output.log` 是已执行工具完整可见输出的逐字转录，不是后来重跑或原始重定向字节；原工具 chunk `797f03`、exit 0。根已读取全部报告和输出，保留两次诊断夹具调试失败及所有媒体。

前置修复正式 RED 40 项中 37 pass／3 fail／0 skip、exit 1；失败恰为真实新图仍读取旧包、相同图片新操作仍保留确认、事务当前 metadata 未撤销旧包。源码保持原 `fbbbe45004fee739c9f7eacd2c9860fe36884006f9d004a14d1b8f84fdabf535` 时根亲读失败。修复仅 service 8 行增加／1 行替换，测试新增 271 行保留原 25 项；GREEN 40/40、0 skip、exit 0，日志 `r2d-identity-invalidation-red-20260906.tap` / `r2d-identity-invalidation-green-20260906.tap`。实现冻结 service SHA `da9be5251f341952784b8cf19a2e2313eeec68e06694cc817cc4b0b0956ad8a4`，test SHA `cb33dad9c614ff77fdf206f58988854fef4b1523df2c41742103346d79aeeca2`。

根在该 service 上独立运行身份包＋review gate 73/73、HTTP import 筛选 7/7，均 0 skip、exit 0；日志 `r2d-identity-invalidation-root-related-20260906.tap` / `r2d-identity-invalidation-root-http-20260906.tap` 含真实退出码。正式链已走到换图后的 read/DTO/list 无包、未重存批准被拒绝、重新人工保存新包后批准 200 且绑定新图，旧媒体依然可解码。已知既有接口呈现缺口：服务正确抛 `REDRAW_CHARACTER_IDENTITY_REQUIRED`，review handler 仍将其包装 HTTP 500 `INTERNAL_ERROR`，本包未改 routes，不宣称 4xx 语义已修好；不把非成功包装误计为仍能批准，该项已明确放入唯一计划任务 3。

后端前置最终规格 PASS，报告 `r2d-identity-invalidation-spec-report-20260906.md` SHA `7ce44f80b2e9755b0f7ed5e629e7040fc9f9a69e80bbab45c62622f04943dbc1`：独立全 40/40 和新 9 顶层/15 项聚焦均 exit 0，聚焦完整 TAP 留档；全文件首次工具输出截断，不冒称另有全量 stdout 完整归档。随后独立质量 APPROVE、无 P0–P2，报告 `r2d-identity-invalidation-quality-report-20260906.md` SHA `c7354e2981c131bf0abbf3edd09ca3e49808a9c70a53a266d3931a65f9924816`；聚焦 15/15、exit 0，完整 TAP 留档。根已逐一读取报告/终态并复算两份源码 SHA 无漂移；语法、精确 diff 与 `audit:feature-lock -- --base HEAD` ready=true、exit 0（既有 LF/CRLF 和 npm 配置警告原样记录）。

只勾选两文件后端前置，机器回执 `.codex-staging/r2d-identity-invalidation-verification-20260906.json` 记录本批验证与仍待实施的页面 RED。解除本地共享依赖暂停后，继续原同一前端实现者的身份上传 GREEN；整个 R2d.1、动作素材、执行/合成以及通用真实交付仍未完成。源 HEAD 未变且全部仍未提交；无供应商/付费、Key、生产或部署行为。

并行只读输入复核已收口，完整接受边界表进入唯一计划的“R2 输入支持合同复核”。关键区分：上传允许单文件 12 秒–1 小时、ZIP 每项 12 秒–3 分钟、压缩文件 1 GiB；默认音频是整轨 16 kHz／16 bit／mono WAV，Worker 文件上限 64 MiB。1 小时 PCM 数据约 115.2 MB 超过该上限是源码静态推导，本轮未运行真实长音轨链，不冒称正式复现或修复；视觉分窗不替代音频分窗。默认 ZIP 展开资源上限未注入、页面只接首个返回作品，以及 MOV／ZIP／多尺寸的默认整链证据不足也已明确留项，不先断言所有这些输入必失败。

另经主代理亲读确认状态连接缺口：`redrawSourceAudioEvidenceService.invokeWorkerOnce` 保留音频 unknown，而 `redrawOrchestrator.startAnalysis` 只给视觉窗口 unknown 调用 `markNeedsAttention`，其余进入 `markFailure`。现有音频服务单测和视觉未知测试不能证明这条实际产品状态正确。计划在身份上传双审之后，先补真实 orchestrator／隔离数据库 RED 再最小修复，保持未知停止、不自动释放为明确失败；本轮只读定位未执行该修复。目标继续 active，不把支持矩阵文档算功能完成。

为后继补测保留当前基线：根运行 `node --test --test-reporter=tap --test-concurrency=1 backend-node/test/redrawWindowedProductAnalysis.test.js`，现有三项 3/3、0 skip、exit 0、9133.193 ms；完整日志 `.codex-staging/r2-source-audio-unknown-root-baseline-20260906.tap` SHA `71c4a37335f3f0761239644e9fd7e643f2fa4fc3a85bfe0f5d3e0ced2bcacd51`。源码 orchestrator SHA `35eb194c9482e5bfbb341df85ac5ea276ddd244f4b59d1c04d1ddb6be24c066f`，对应测试 SHA `0a0efa79f259ed982dee7a78ca1ab41256df5ecab0cbef2da2b7bd174d85bb61`。这些只覆盖原视觉窗口合同；音频 unknown 新 RED 尚未添加，不能据此消除该缺口。

## 2026-09-06 R2d.1 身份上传 UI：最终规格及全量本地回归

普通角色卡已接显式文件选择／上传、基本格式／大小／CAS 预检、固定 multipart 白名单和每操作稳定幂等键。成功或未知后的只读核对通过新 API 聚合器读取当前 assets、generation gate、character plan 和 work 四个既有 GET，全部完成并通过作用域检查后才发布，不重新报价、不重新上传、不自动保存包或批准。预览仍取鉴权 Blob；wardrobe 独立选择／确认和醒目积分合同保留。API 聚合器只新增只读入口，不改变旧 API 默认签名及旧保存包报价合同。

首次规格发现的 S1（同 CAS 刷新抢占令恢复一直 busy）、完整 workspace 的 S2（同 ID work DTO 替换误作新作用域）均由原实现者补正式 RED 修复；第二轮独立反例再发现 S3（旧批次报价在同范围 ABA 时回盖，以及上传冻结期间旧 startAssetBatch 续流发出一次 mock 提交）。S3 正式两项先业务 fail／exit 1，再通过复用已有 refresh epoch，在报价写入及消息／key／提交副作用之前拒绝旧流修复。这里的 mock 提交不是供应商或扣费；三轮旧 FAIL 报告、正式失败日志和未修改的独立探针全保留，不合并抹去。

最终独立规格 PASS：`r2d-identity-upload-spec-report-20260906-r3.md` SHA `f01e0f9a0e63818fefeb555c9969ca37b25ec9c1fe22bbe320cedae020b4744f`；独立正式专项 48/48 和三份原探针 7/7，均 exit 0。旧单卡晚 quote reject 的既有错误提示旁支仍在，探针只证明其零生成，不冒称已静默修复。后端缺包 handler 的 500 归一化仍是后继项；这不影响本批真实后端门禁已拒绝错误批准的事实。

根在最后冻结字节上实际验证：全前端含蓝图工具 **1212/1212、0 skip、exit 0**（`r2d-identity-upload-root-frontend-20260906-r4.tap`，30444.5108 ms）；build **exit 0、34.27 秒**（`r2d-identity-upload-root-build-20260906-r2.log`），既有大 chunk 警告不扩围。初轮沙箱全量的 7 项失败逐项证实为 esbuild 读取祖先目录／Vite config 权限拒绝，使用同一冻结源与相同本地命令提升本机权限后通过；旧环境日志保留，未改依赖或业务门禁。后续源变更后重新运行最后 r4／r2，不以早期绿灯覆盖新字节。

原实现者最后重点浏览器 **4/4**、完整 workspace **40/40（2.4 分钟）**，均真实 exit 0，日志为 `r2d-identity-upload-s3-browser-20260906.log`／`r2d-identity-upload-s3-workspace-20260906.log`；完整 runner session 63048 已退出（chunk c4a256）。根与规格审查者读取终态并复核五 SHA：API `07c54555…a76257`、Card `b4fc3553…50a31`、Step `bd5e6de1…981c`、新专项 `2902bfca…d8ab`、workspace `5b6c32bd…78ad9`。浏览器为严格本地 API fixture，不能代替真实 DB 默认页面链、Worker 推理或生成质量。

身份导入后端两文件仍与已双审 receipt 精确一致，复用该字节的 import 40/40、身份／review 73/73、HTTP import 7/7 证据；没有为每轮 UI 修复重复执行未变后端。功能锁 32/32、exit 0；最后 `audit:feature-lock -- --base HEAD` 为 ready=true、11 features、55 tracked changedPaths、exit 0。根精确 diff 与新 JS 语法通过；旧 R2c 的 54 工件及后端前置的 15 工件逐项 SHA 无漂移，当前累计来源 87 文件，前 82 文件只在声明的 API／workspace／功能锁两文件上变化。计数是不同验证范围，不能相加成独立功能数。

独立质量审查 APPROVE、无新增实质缺陷：报告 `r2d-identity-upload-quality-report-20260906.md` SHA `6c1fcfd343baafaf615ad1fcd6d7330bd35dad01c2dec5b00c77f041eff82acb`。审查者独立专项 48/48、原探针 7/7、另增真实 Vue 挂载／卸载父子交接探针 2/2，均实际 exit 0；根亲读报告、新探针及终态，复核五 SHA 一致。两项新探针证实四 GET 完成后才发布新 CAS／解冻、卸载卡片不丢父级冻结且重挂载可显式只读恢复；不是浏览器 DOM、HTTP 或供应商测试。质量机器回执 SHA `1a0fe74c1199fe4fc50e9d4797a21af76627584118688a2cbcf4241d157d446a`；日志为完整工具可见 stdout/stderr 经 apply_patch 保存，未冒称原 shell 重定向字节。

R2d.1 普通身份图上传与后端前置现本地双审完成，仅勾选该局部退出项。最终 UI 机器回执 `.codex-staging/r2d-identity-upload-verification-20260906.json` 绑定 87 累计源码、两份当前文档及本批证据，引用且不覆盖旧 R2c／后端前置 receipt。接续两文件音频 unknown 正式 RED／明确失败对照／防重修复；动作素材、长音轨、R3 执行恢复、R4 音轨导出、R5 多输入／精确 CI、R6–R8 真实验收仍未完成。零 Key／联网／供应商／付费／SSH／生产／commit/push/merge/CI/deploy；目标仍 active。

## 2026-09-06 R2 源音频 unknown：本地状态安全修复

上批身份 UI 回执已由根重新读取并逐项核验 87 源、2 文档、65 工件、2 父 receipt 均无漂移，本体 SHA `8d896ebb3930f02aff9943707ad28792c7718818d31a9014385d47be42de66e5`；此后本文／计划、声明的两文件运行时测试和功能锁变更属于新批次，不改旧 receipt。

全新实现者仅负责 orchestrator 与 windowed product test 的正式 RED→GREEN。根仅对实际触及的 `stability.proactive-canary-and-public-evidence`、`redraw.episode-blueprint-first` 追加本轮本地 unknown 状态授权；完整旧规范清单 SHA `db16f79b63ae570ec63f70677f11a026b9806781c12a3e99f95b92321a7e2ea2` 经历史回放逐字语义校验保持。授权测试先 1 fail／exit 1，再全 33/33、0 skip、exit 0；日志 `r2-source-audio-unknown-feature-red-20260906.tap`／`r2-source-audio-unknown-feature-green-20260906.tap`。未改变保护范围、必跑规则、旧批准、供应商或线上模型信息，不能把授权测试 GREEN 当业务修复完成。

实现阶段的首次 `red` 是错误 DTO 字段断言、原视觉 timeout 曾被误改写；随后的 `red-r2` 还包含误留旧用例断言，不能作本批单一有效 RED。根审计拦下并要求恢复原三项，保留这些日志和早期四项 GREEN，不冒报最终通过。有效 `red-r3` 为 5 项／4 pass／1 fail，exit 1，唯一失败确为音频 UNKNOWN 的 `failed` 与 `needs_attention`；当时运行时原 SHA `35eb194c9482e5bfbb341df85ac5ea276ddd244f4b59d1c04d1ddb6be24c066f` 已实读恢复。加入唯一错误分支后 `green-r3` 5/5、exit 0，但根继续要求将无效的 `released` 枚举断言改为实际 `refunded`、补全再次请求后状态／绑定／零产物断言，未将 r3 GREEN 直接放行。

根在当前运行时上只读撤去内存字符串中的本次一个条件分支，所得 SHA 精确等于上述基线，证明本批运行时代码未掺入其它变化；当前 SHA `bb9db6596cb681a904c045e1a75f6c4b9829576e36d9df45705ad69da446664e`。更早的已有脏差异属于前批，不能当本包新增或回退。当前 route 仍将音频错误包装 HTTP 500 `INTERNAL_ERROR` 并保留 `error.message`，本包不声明错误码呈现已归一化。

根源音频／视觉源证据相邻回归为 50 pass／1 skip／0 fail、exit 0、34225.5274 ms；`.codex-staging/r2-source-audio-unknown-root-evidence-20260906.tap` 中跳过项仅 `analyzeSourceAudio rejects a group-writable existing private root on POSIX`（Windows 无 POSIX mode），不是未解释失败或真实 Worker 模型验证。功能锁与业务测试计数不累加。后续规格／质量双审与最终回执尚待完成，目标 active。

原实现者终态后，由独立测试收尾者仅修测试：保留原三项完整旧断言，未知用例改实际 refunded 枚举，retry 后检查原任务／作品／预留的 ID、状态与绑定及四类产物仍为零。新 `green-r4` 为 5/5、0 skip、exit 0、12432.6773 ms，日志 SHA `4a11ba30bc87c1cd44a27cc376fdb8d6c6727c2038a965782f6ce572a7b411da`；当前测试 SHA `8a2bda9eb64015aaa5c2c842c28c1e75db093f0a051f2d01e9337591e098e164`，运行时仍 `bb9db659…46664e` 无漂移。根已读取全部关键断言，未以旧四项 GREEN 或没有状态的错误字段失败代替本次证据。

根在冻结运行时上完整运行 `redrawRoutes.test.js`：154/154、0 skip、exit 0、58953.8091 ms，日志 `r2-source-audio-unknown-root-routes-20260906.tap`；最终功能锁审计 ready=true、11 features、55 tracked changedPaths、exit 0，日志 `r2-source-audio-unknown-root-feature-audit-20260906.log`。两文件语法／精确 diff 和父 UI 65 工件 SHA 复核通过，87 累计源码只改变声明的 orchestrator、windowed test、feature test 和 manifest 四项。未重跑未改前端或冒领本批新的浏览器／CI；本次业务链测试调用真实本地媒体／数据层，仅底层 ASR 与视觉返回为 fixture。

本批最终独立规格 PASS：`r2-source-audio-unknown-spec-report-20260906.md` SHA `9f930cbaebb10d90837eb0d78778961f7903e6fc6bcf690bbd4796db2f8731b5`，独立 5/5 与 feature 33/33 均实际 exit 0。随后独立质量 APPROVE：`r2-source-audio-unknown-quality-report-20260906.md` SHA `f6a70cbc3964151e18932dcfb1cc1ed23f6a92a55abdecb52d40e1c583c849ca`，独立 5/5、exit 0；质量 TAP SHA `c77ce2073ddc7a2ec2a0aad1049e979cecf4bbd5f11e5acdf64f50bed727702e`。根亲读两报告、完整终态及关键测试，复核入退 runtime/test hash 一致，才勾选本地子项。两位审查者均独立以内存撤分支恢复原基线 SHA，未改磁盘源码或旧证据。

机器回执 `.codex-staging/r2-source-audio-unknown-verification-20260906.json` 绑定 87 累计源码、当前两文档和本批工件，父 UI 回执及其 65 工件原样。目标仍 active；R2 动作参考、长音轨及多输入边界、R3 执行与停止恢复、R4 音轨合成／下载、R5 全链矩阵／精确 CI、R6–R8 真实质量与移交仍未完成。下一步进入普通动作参考准备／上传／审核的本地连接，不重新开放旧未知付费运行，不改模型、不读 Key、不推送、不部署、不写生产。

## 2026-09-06 R2d.2a 本地动作草片：进入有界实现

前一轮属于有证据的局部推进，不是整体完成。本轮入场回读 HEAD／branch／linked worktree 及上批 87 源、2 文档、17 工件、1 父 receipt 全部无漂移；上批本体 SHA `e0c76d6642e02e2dfa51e7a4a716cb503e7ccd47a19a1ab27edf701962d4291a`。目标维持 active，沿唯一主线计划推进动作素材。

已查清现有普通入口缺口：ReferenceBundlePanel 仍要求 motion ID／JSON，图片 preview 不能读动作视频，母本静音裁片未接真实 owner/shot 接口。服务端已有待审 motion import 和后续绑定，不重建导入或付费引擎。本批只连接临时静音草片 GET；后续遮人物／文字、上传、四项人工审核、候选恢复预览与完整准备仍未完成，静音不等于已审核。

原新建实现代理因 thread limit 被工具拒绝，没有创建成功；已明确复用空闲代理为本批唯一实现者，保留与后续审查职责分离。没有以这一工具限制为理由扩大权限或改用并行写同一运行时。

功能锁只对新 route 触及的五项追加本地授权并保留历史；正式 RED 1 fail／exit 1 → 全 34/34、0 skip、exit 0。历史回放后全清单 canonical SHA 精确为 `63fac57104ace0acf9c1177f25c9655310fe0a0fbba923b8317bbd3f055d4ca5`，保护路径／规则／已有证据原样。此绿色仅是授权记录验证，不是动作接口完成。

首次草片 RED 因 fixture 低于作品最小 12 秒约束失败，不计有效反例，日志保留。更正 fixture 后新 `r2-motion-draft-red-r2-20260906.tap` 确为真实登录 HTTP `404 !== 200`，1 fail／exit 1，SHA `b996b0b38f197f6c99144d7a462ae0821ce07410cb04cd29a84fc29f1d43dcd1`。入场旧两 suite 日志显示 57/57 终态但首次工具实际退出码回执未留齐，不按完整可复核通过登记；改后将使用新日志记录正式兼容回归。当前实现与双审尚在进行，不勾选本批退出条件。

实现后的第一次根审计要求恢复源视频已有旧资产兼容：不能新增必填 metadata.sha256／file_size。正式 legacy RED 为 25 项中 22 pass／3 fail、exit 1；修复并增加静默源正例后 `r2-motion-draft-green-r2-20260906.tap` 为 26/26、0 fail/skip/cancel、真实 exit 0，SHA `8396dcf370b0c3893cf19b9563af85a453e85821d109367dd06a2d60def19b18`。null file_size、fingerprint-only／owner-only metadata 继续通过 work fingerprint 与实际固定 FD hash 绑定，不削弱存在的错误值校验。

根在该冻结版本运行旧 source-video／conditioning 57/57（32253.7485 ms）及完整 routes 154/154（57440.1356 ms），均 0 skip／真实 exit 0；日志 `r2-motion-draft-root-source-20260906.tap`／`r2-motion-draft-root-routes-20260906.tap`。功能锁审计 ready=true、11 features、56 tracked changedPaths、exit 0。去除新 handler/import/export 和唯一新 route 块后，原 routes/redraw 与 index 的 LF 规范文本均精确等于入场内容；没有把此前脏差异算成本批改动。

独立规格审查尚未放行：正式 26/26、功能锁 34/34 虽独立通过，但真实 HTTP／FFmpeg 探针将可达 `assets.duration` 设为非数值，返回 200 MP4，证实 `Math.abs` 的 NaN 比较静默放行。报告 `r2-motion-draft-spec-report-20260906.md` SHA `f6273282e5c4bf795fd4f750d49a6f70f113e1d4797dd3519992a4dbb7438abe` 为 FAIL／1 项 P2；单项探针 1 fail、exit 1。另一个 work duration 探针被 SQLite CHECK 拒绝，是不可达 fixture 而非第二个缺陷，原日志均保留。已退回同一实现者，仅补正式资产时长数值 RED 和最小检查，保留 null 兼容；规格再次通过之前不启动质量审查，不勾选草片后端完成。

时长修复闭环：正式 `duration-red` 为 28 项中 27 pass／1 fail、真实 exit 1，唯一业务失败为 200≠409；`duration-green` 为 28/28、0 skip、真实 exit 0，SHA `50f5fd205d590b7b63258399edd6c75259e13a0fbba280042cd24c9aec770833`。只在草片原比较处加非 null 时有限正数判断，旧 null 兼容有真实 HTTP／ffprobe 正例。根亲读和独立规格均以内存撤回唯一条件恢复前版 source SHA，并移除新增两项测试恢复原 26 项全文 SHA；没有放宽原断言或磁盘回退。

最终冻结上根再次取得原 source-video／conditioning **57/57、0 skip、exit 0**（33629.2615 ms，`r2-motion-draft-root-final-source-20260906.tap`）及完整 routes **154/154、0 skip、exit 0**（60999.9323 ms，`r2-motion-draft-root-final-routes-20260906.tap`）；五文件 JS 语法和声明范围 diff-check exit 0。当前累计源码 89 份：父批 87 份只改变 routes/index、routes/redraw、sourceVideo 和功能锁两份，另加入本批 conditioning 与 motion test；父 receipt 的 17 工件和 1 个上游引用重新核验全部无漂移。

独立规格修复复核 **PASS**：`r2-motion-draft-spec-report-r2-20260906.md` SHA `2fa3ef6d780b50d065a117f223622bb7bf8ed54a50f7881b3d72163a931a38db`。未修改的原反例独立 1/1、实际 409／零写，正式 28/28、0 skip、均真实 exit 0；五文件与 HEAD 入退一致，未变的功能锁沿用独立 34/34 并复算两源码 hash。随后才将独立质量交给此前仅做只读定位、不是本批实现者的空闲代理；仍不因规格通过而声称质量或界面交付完成。

独立质量继续挡下第二个实质缺口：入口只查一次 active tenant/member，处理中的发送前 owner JOIN 未重查资格。真实 FFmpeg 完成后由隔离 fixture 撤销当前成员或租户，当前请求仍为 200 MP4，而随后同一请求为 404；独立两项预期 404／实际 200，0 pass／2 fail、exit 1，撤权后的全库状态未被 GET 改动、请求临时目录已清理。根亲读原探针确认未替换 handler、快照或 FFmpeg，只在真实进程完成后施加撤权事件；其完整日志与探针 `r2-motion-draft-quality-revocation-20260906.tap`／`r2-motion-draft-quality-revocation-probe-20260906.cjs` 保留。本批须在新 motion 绑定复核中补与入口相同的 active 资格，不扩至全局 token 撤销或改写旧 source-video 合同；修复后重新走规格与质量，不能用旧 28 项 GREEN 抵消该反例。

该质量 FAIL 终态报告为 `r2-motion-draft-quality-report-20260906.md`，SHA `5f77412fd0be8cf6e6a7f64d3a3140a4893eff4690f695220d6e3fa29d04fe0d`。随后正式 revocation RED 30 项中 28 pass／2 fail、真实 exit 1，两项恰为 200≠404；最小修复仅在新 motionBinding 查询增加两条 active JOIN，GREEN 30/30、0 skip、真实 exit 0（44888.0246 ms），日志 SHA `b44e281e75998df6dc2fe0ec64e76b99ccb2cf8146577cc82de6d5906203aaf2`。根与规格代理分别以内存撤 JOIN 恢复上版 source SHA、移除尾部新增两项恢复原 28 项全文，旧接口运行时与其余三文件未改变。根首次比较误假定新加行是 CRLF，读取实际 LF 后只修正比较表达式，未改源码或以此声称业务失败。

最终规格 **r3 PASS**：`r2-motion-draft-spec-report-r3-20260906.md` SHA `a264d0e3e9b1ecc96d7281c4b50f1e7585a17e90d26b8f72a5fc6ea617ae4888`。独立正式 30/30（46663.9891 ms）、原 duration＋两撤权探针 3/3，均真实 exit 0、无 skip。相同 motionBinding 覆盖初始、处理前后与固定 FD 建流后发 headers 前资格复核；原不可变探针返回当前 404／随后 404，时长错误仍 409，合法 null 与旧源兼容全保留。最终运行时 source SHA 为 `fc13348e481e562357684ae4486ad15350634dd7967007c4d6938a878ad58b06`，正式 test SHA 为 `63af1cbc355a7d7ae5e6411157190998e2bd4abcdfb306f2171382a4a9ad904a`。

根在这次最终两 JOIN 字节上另跑旧接口重点 **7/7、0 skip、exit 0**（8768.7654 ms，`r2-motion-draft-root-final-compat-20260906.tap`），覆盖 AAC／strip／HMAC／pre-auth 以及原 source snapshot、建流边界和断连。此前完整旧 57／154 是 JOIN 修复前运行，按未改的旧函数和 route 字节追溯复用，不冒称全套在最后文件 hash 下重跑。最终 feature audit 仍 ready=true、11 features、56 tracked changedPaths、exit 0；新 source/test 语法与 scoped diff-check exit 0。规格 r3 终态后才启动原非实现作者的质量修复复核；旧 FAIL、全部 RED、历史 GREEN 原样保留。

最终独立质量 **r2 APPROVE**：`r2-motion-draft-quality-report-r2-20260906.md` SHA `9d7321720598679be9e2825e106cf341c56566a08cfb2f915057aecfd5944da8`。原不可变撤权反例独立 2/2（5105.4104 ms）、正式新增两项独立 2/2（4750.6923 ms），均真实 exit 0、无 skip，所有审查进程终态；未选择的原 28 项不算该次质量重跑。根亲读最终规格／质量报告及实际 TAP，复核五源码入退 SHA；只在两条门禁均终态后勾选 R2d.2a 四个后端退出项。

本批机器回执 `.codex-staging/r2-motion-draft-verification-20260906.json` 绑定 89 累计源码、当前两文档、本批日志／报告／原探针及父 unknown 回执。旧源兼容修复、duration 与撤权 RED、旧 FAIL 结论及未完成／无效夹具日志全部保留并分级说明；不是删失败取绿灯。仅本地真实 HTTP／隔离 SQLite／FFmpeg，未执行 POSIX 实际权限系统测试、界面草片预览、多输入默认全链或真实供应商验收；测试数不相加成独立功能数。

目标保持 active，完整 R2d.2、R2、R3—R8 仍未完成。下一步先补 owner-scoped 当前动作候选读取／预览和普通页面显式上传审核，避免内部 ID／JSON；不把静音自动当作人物与文字遮除，更不自动批准或触发参考生成。尚需处理长音轨、ZIP 多作品入口和支持边界，再接队列执行／恢复及音轨合成下载。本轮不读 Key、不调用供应商、不付费、不 SSH、不写生产或 shared、不改线上模型、不 commit/push/merge/CI/deploy；后续外部操作仍按对应明确授权。

## 2026-09-06 R2d.2c 普通动作素材页面：实施与独立浏览器回归中

入场已重验 R2d.2b 父回执 `r2-motion-candidate-verification-20260906.json` 的 113 个引用，0 漂移；HEAD 仍为 `8c49a90773a4311992e4eb9b6a5bc2c9acdfa4ed`，原 linked worktree／脏改动保留。新实现代理只负责四个页面/API 文件及两份新正式测试；主代理独立负责浏览器 fixture、功能锁和本报告。沿 R2d.2c 已批准合同，不新增设计或执行平台。

主代理创建两个可解码的本地测试图案 MP4（H.264、320×240、5 秒、零音轨），以普通用户 `user` 和严格拦截 API 验证页面；它们不是生成成片或人物遮除能力证据。第一次浏览器进程在沙箱目录读取权限阶段失败，未到页面；仅提升本机隔离回归进程权限，真实后端指向关闭端口，未修改业务配置或连接供应商。之后第一次页面联测有 fixture 缺少候选审核 GET，以及仅等视频预加载未主动播放的问题；修正测试夹具并以真实 play/pause 验证解码，不把它记为完整 RED。已有 API 和 SFC 的正式 RED 由实现者单独保留。

中期浏览器 5 项中 4 pass／1 fail，真实 exit 1；唯一未通过为未知上传后刷新按钮持续 busy，已交回实现者补取消请求生命周期反例。主代理相关 9 文件回归 135 项中 131 pass／4 fail：两项是旧测试剥离 import 的正则错误匹配 `expected_import_id`，仅把正则锚定到实际 import 行；一项是旧断言未包含新防重条件，改为同时要求原空列表和新冻结／epoch 条件；另一项发现直接 `crypto.randomUUID()` 绕过既有不安全上下文回退，要求实现者复用已有幂等键帮助函数，不弱化旧断言。所有失败日志保留，未宣称本批退出。

功能锁仅对实际触及的 `redraw.episode-blueprint-first` 追加本地页面授权，旧规则、路径、验收和历史全保留；正式授权 RED exit 1 后，36/36、0 skip、真实 exit 0。当前仍须完整回归、独立规格→质量及最终浏览器复测后才能勾选 R2d.2c。纯 GET 指上传回调和用户显式动作刷新；无待核对操作时原页面挂载报价不在本包重构范围，未知上传刷新页面必须保持防重，不能靠读取旧候选确认提交终态。

v1 修复后主代理相关回归 138/138、公开前端构建 exit 0；浏览器第一组 5/5 后扩展为 9 项，7 pass／2 fail：一项是 Blob HTTP 409 文案断言过窄，仅修测试；另一项是真实 A→B→A 预览丢失。独立规格报告 `r2d2c-motion-spec-20260906-independent-report.md` 为 **FAIL**：专项 23/23 不能抵消独立 7 探针中的 6 个失败。四组根因是 pending 候选被旧 ready 放行、候选缓存缺少当前源/CAS/version 绑定、队列 UI 和 retry 门禁遗漏、Panel 被动清理取消父级新读取。新增正式浏览器 `r2d2c-motion-browser-race-red-20260906-r6.log` 真实 exit 1，复现候选未返回时“生成本镜头”仍 enabled。全部旧报告、TAP 和 trace 保留，不以中期构建通过冒充完成。

修复仍由同一实现者接回；只额外允许既有 QueuePanel 的最小 disabled 属性及关联测试。主代理继续负责浏览器与历史兼容回归，规格重新 PASS 前不启动质量审查、不勾选页面退出。没有新增付费、模型、部署或生产权限。

四组修复的第一次冻结上，主代理全部 23 份转绘前端测试 **401/401**、动作浏览器 **10/10**、完整工作台 **50/50**、公开构建均实际 exit 0。旧对白测试另有同类 import 提取错误，仅锚定一行正则，单项 RED 后完整 **26/26**；原业务断言不变。独立规格 r2 正式与原探针 **45/45**，但追加目标隔离反例 **1 pass／2 fail**：无上传未知时，选中镜 unavailable 被误升级为全局冻结，另一个 ready 镜的合法 retry／batch 均被拒绝。因此 `r2d2c-motion-spec-r2-20260906-independent-report.md` 仍为 **FAIL**；新真实浏览器第 11 项同样 RED，`r2d2c-motion-target-scope-browser-red-20260906-r1.log` exit 1。保留前述绿色的准确适用版本，不以其抵消新反例；只修全局操作冻结与目标就绪的区分，再复审。

额外后端只读兼容核对确认：正常提示词／生产参数保存只更新 shot CAS，candidate reader 与 ready 资格不依赖导入时旧 CAS，因此有效绑定可按新 CAS 重读；该结论来自实际服务源码，不依赖前端 fixture。但完整“实际 prepare 绑定→保存→旧 CAS 409→新 CAS 同 import/SHA”后端组合用例尚未运行，仍保留为默认后端联测缺口。

目标隔离最小修复后的根验证为全部转绘前端 **405/405**、工作台 **51/51**、功能锁 **36/36**、公开构建与差异审计 exit 0。独立规格 r3 **PASS**（正式与两份原探针 52/52，额外 2/2），报告 SHA `cbebdec2153f5c5183adf272b17a5831c919c67445b17f2b9a4b0b96a9a4a208`；此后才启动全新独立质量代理。正式视觉比对因缺少 reference.png 与配套视觉合同而按技能预检暂停，已有功能截图保留；不伪造像素/WCAG通过，也不为此新建设计平台。

独立质量结果 **CHANGES_REQUESTED**，唯一 MEDIUM 合同缺口：同作品/version 的首镜上传 unknown 后，另一镜仍新增上传，实际 uploadCalls 与 marker 均由 1 变 2。报告 `r2d2c-motion-quality-20260906-report.md`、可重复原探针和 exit 1 日志保留；这不是安全漏洞或真实供应商付费越权结论。根亲读证据，并以真实浏览器 `r2d2c-motion-unknown-cross-shot-browser-red-20260906-r1.log` 再现另一镜文件 input 仍 enabled，真实 exit 1。原实现者仅修跨镜待核对上传的 UI/handler guard，未提交选择仍可正常首次提交；修后须重新规格→质量。上述 405/51 GREEN 是此修复前的准确版本，不冒充最终终态。

后继完整参考准备的只读定位已收束到三个真实连接断点，并写入唯一计划 R2d.2d：待绑定 marker 拦住 prepare；prepare 后新 CAS 未受控接纳；A-ready 上传 B 后旧 ready reuse 跳过 B 绑定。当前没有执行 prepare 或修改该后继运行时，仍等待 R2d.2c 双审终态。全程无 Key/供应商/付费/SSH/生产/Git/部署操作。

### R2d.2c 最终本地退出

同作用域跨镜防重修复的正式 RED 为四种 pending 阶段均可新增上传；原实现者最终 93/93、exit 0，未提交选择仍可正常首次上传，其他作品/version 不被锁。最终 ShotStep SHA `fa3d0ad6ae015ea8df362d46a803c4c7b10daf0de9ce5478aab5451fcc0925d5`，专项测试 SHA `6aff2a01cbe561b1f5bad730bc18dce27d3ee97ae3accf1a41e40d0494dd29d5`。

独立规格 **r4 PASS**：59/59、0 skip、exit 0，报告 SHA `eb302f53cde2c6579321d759894738b75bd6222322d62e7d446217e2e8de5586`。此后原质量审查者独立重跑不可变反例及正式组合，**r2 APPROVE**：59/59、exit 0，原反例明确 uploadCalls/marker 首次后为 1，切镜再操作后仍为 1。新报告 `r2d2c-motion-quality-r2-20260906-report.md` SHA `091c32d80ad6a54eb4033f275fe28737de550cca5635f3fe71f8b21c04cdd884`，日志 SHA `7f88c26ded9ab58b45c18fc49f8fbfedcfdaa392641e1f0e3c6549dd32d59347`；旧 FAIL 报告/日志/probe 原样保留，主代理完整亲读两审报告后才勾选局部五项。

根在最终冻结版本完成：转绘前端 **411/411**（`r2d2c-motion-all-redraw-final-20260906-r3.tap`）；完整工作台浏览器 **51/51**，含 11 个动作素材用例及真实 MP4 play/pause（`r2d2c-motion-workspace-browser-20260906-r3.log`）；公开构建 exit 0（`r2d2c-motion-public-build-20260906-r4.log`），保留既有大分包警告；未变功能锁 **36/36**，最后审计 ready=true、11 features、61 tracked changedPaths、exit 0。上述不相加为独立功能数，也不等于新后端、真实供应商、CI 或用户质量验收。

累计源码快照 100 份，仅父 91 源中的声明七项变化，新增九项纳入本批；16 文件冻结快照及父 20 工件 hash 全部一致。机器回执 `.codex-staging/r2-motion-ui-verification-20260906.json` 绑定源/两文档/本批证据及父 receipt。正式视觉比对按技能因缺少 reference.png 与视觉规格/设计系统输入暂停；功能截图不是正式视觉通过。

目标保持 active，R2d.2c 仅普通动作素材页面本地完成。下一步 R2d.2d 先修实际后端 A-ready→B 错误复用，再接显式准备与新 CAS 刷新，分别 TDD→SPEC→QUALITY；完整 R2、R3–R8 继续未完成。不读 Key、不调用供应商、不付费、不 commit/push/merge/CI、不 SSH/部署/重启、不写生产或 shared、不改线上模型。

## 2026-09-06 R2d.2d 已确认动作候选真实绑定：后端 TDD 入场

R2d.2c 回执 SHA `4008612eb29f5ef6b7076519b918a0fa00d3f8e6dde6b2cf551fa389f2777a11`，137 个引用实际全部一致后启动全新后端实现者。只拥有 preparation orchestrator 和原 orchestration test 两文件；页面消费者保持冻结。原后端 suite **54/54、0 skip、exit 0**，日志 `r2d2d-preparation-entry-baseline-20260906-r1.tap`。该基线不证明最新 import 替换已连接。

功能锁只追加 `redraw.product-media-http-chain` 本地实际绑定授权；新历史测试实际 RED exit 1，修后完整 **37/37、exit 0**，回放后的整清单 canonical SHA `39015bcaa464cb34ce86159327b9750d3f7976c3448791b9d4c3071ae4541cae`。没有改保护路径、原验收规则或旧授权；所有历史截图、RED、旧 receipt 保留。接续先用本地真实 MP4＋正式 import 复现旧 A-ready 被误复用，不能用旧占位媒体或手写最终 ready 冒充链路；净景复用与 motion 身份独立，避免只换动作素材引起新供应商成本。运行时及双审尚未终态，不勾选 R2d.2d。

正式业务 RED `r2d2d-motion-backend-red-r1.tap`：7 项中 1 pass／6 fail、exit 1，SHA `2eb6a0336a39d3a6ca7ed2af585e9f7440f45ebbfbd74a410bf0f01a30d5db5a`。真实导入 A→净景低层 fixture→正式人工审核→bind/build/save ready 正例通过；失败恰为 A-ready 上传 B 仍 reused A、同 CAS 旧报价未拒绝 B，以及最新 B 删除/丢失/损坏后回退 A（计数含失败父用例）。原作者第一次标名 GREEN-r1 的尝试实际 **61 项中 59 pass／2 fail**，不能按文件名宣称绿色。

其中一个真实绑定失败证明还需最小修改 trusted bundle builder：A/B 同时保留时 `currentMotionAsset` 强制唯一导致拒绝。主代理亲读源码/失败后，在既定本地准备范围内确认第三文件 `redrawReferenceBundleService.js` 的内部可选 ID 及既有校验连接；不复制 builder、不删除 A、不增加页面 ID 或绕过最新候选检查。另一个旧 pending fixture 缺少实际 reader 所需的 active owner/source 元数据，仅补旧 fixture 合同，不把占位媒体称真实导入。旧失败记录保留，修后仍需完整回归与独立双审。

首次冻结作者及独立正式套件 **63/63**，但独立规格新增真实并发探针 **2 pass／1 fail、exit 1**，结论 **SPEC FAIL**，报告 SHA `ab406d956882568a5d33a1324c319d0cacab9112a8594ab842cbc271a8a92774`。在 reader 最后 close await 内真实 B 上传完成，准备却仍返回 reused A，实际生成 gate 正确阻断；不是已经错误付费生成，但仍违反准备合同。原实现者接回 cleanup 最后异步边界修复，未启动质量审查或页面实施。

根五套旧邻接回归 **142 项中 141 pass／1 fail、exit 1**（`r2d2d-binding-root-adjacent-20260906-r1.tap`），唯一为产品 HTTP 首次报价 500。只读诊断发现两点：fixture 缺源 owner metadata；以及 `redraw_shots.work_id` 实际为 TEXT `1.0`，新 reader 要求文本 `1`。后者由真实蓝图和本地化 writer 的 Number(workId) 同样可达，不能当夹具问题。根只改原 HTTP fixture 一行 owner metadata，数字 bind／所有旧断言不动；`r2d2d-numeric-work-http-red-20260906-r1.tap` 仍 **0/1、exit 1、500≠200**，保留真实产品兼容反例。已在唯一计划列最小 reader 兼容前置包，待 cleanup 冻结后顺序实施。

功能锁审计首次仅入口文件名错误（MODULE_NOT_FOUND、未运行审计），保留 r1；按 package.json 的 `verify-feature-lock-manifest.js` 正式入口重跑 r2，ready=true、11 features、64 tracked changedPaths、exit 0。此审计不能抵消上述业务失败；完整 R2d.2d 仍未完成，目标 active，外部/生产/付费边界不变。

cleanup 正式 RED 为 4 项全部失败（含新 import／shot CAS／source owner 三个真实关闭窗口子例）；最小修复在最后 cleanup await 后同步比较先前数据库绑定快照，不重开或重哈希媒体、不复制 reader 校验。新完整 **67/67、exit 0**（`r2d2d-cleanup-backend-full-green-r1.tap`，SHA `e8d3da674cfadd9bb34d02b0b8983de1e1e66c5fd7dc92b198ba4f81cb3ac251`），原不可变独立探针 **3/3、exit 0**。根亲读修复并核验三文件 SHA 后才解除下一兼容包依赖；这仍不是新的独立 SPEC/QUALITY 放行。

随后才由另一实现者开始仅四文件 ID 兼容 TDD。合同只接受既有标准正整数文本及实际 SQLite 数字 bind 的单个 `.0` 后缀，并要求安全整数和权威作品相等；保留空字段旧兼容。小数、非数字、尾随字符、前导零、指数/hex、舍入伪等价、不安全整数和其他作品仍拒绝。原 String fixture 与真实 writer 都不改，新 Number bind 用例必须经过实际 SQLite 与鉴权 HTTP；不并行修改先前已冻结的准备消费者。页面、完整素材准备和总交付仍未完成。

### R2d.2d 第一后端子包最终本地退出

ID 兼容作者真实六项 RED 为 4 pass/2 fail、exit 1，仅两条原生 Number bind 的合法 HTTP 被拒绝；最小 reader 比较修复后 6/6。完整五套 191/191、0 skip、exit 0。`.codex-staging/r2d2d-work-id-compat-20260906-report.md` 如实摘录原工具命令/session/终态，不是原生 TAP；没有为了补证据回退源或重复五套。writer、原 String fixture 及原授权/CAS/媒体校验不变。根另以保持数字 bind 的旧产品 HTTP 运行 **1/1 GREEN**（`r2d2d-numeric-work-http-green-20260906-r1.tap`），真实收口旧 500，不靠 String 化夹具取绿。

根最终六套组合 `r2d2d-binding-root-combined-20260906-r2.tap` 为 **212/212、0 fail/skip/cancel、exit 0**，438109.1951 ms，SHA `5a195b6e639082b13644ae865baf08b533014c286f03a2448244d62a3ebf27fc`；覆盖 preparation、candidate、import、bundle、preparation gate 和产品 HTTP。最终功能锁 **37/37**、audit ready=true/11 features/65 tracked changedPaths、scoped diff-check exit 0，日志 `r2d2d-binding-root-final-static-20260906-r1.log` SHA `20e31dad4184fb16a22b0ca9a12c27aeefaabf19a55aaf3600f390b42316b97f`。这些与作者/两审场景重叠，不相加成独立功能数量。

独立规格 **r2 PASS**：原不可变探针 3/3、正式竞态/ID 合同 10/10、真实 HTTP 1/1，全部 exit 0/0 skip。报告 SHA `091bd877948134083753df5f4a79be786fbbc1123e2de4c304ef5c646342c046`。原 cleanup 反例现在返回 `REDRAW_REFERENCE_PREPARATION_DRIFT`，close 仍为 2，没有再次打开媒体回环。规格辅助范围审计首次因混合 LF/CRLF 判断错误失败，原脚本/日志保留；仅新增 r2b 修正审计表达式后，6/6 内存逆向字节检查通过，不是业务源码修复或掩盖范围漂移。

随后全新非实现审查者给出 **QUALITY r1 APPROVE**：独立重点 25/25、原探针 3/3、真实 HTTP 1/1，全部 exit 0/0 skip，范围审计 6/6。报告 `r2d2d-quality-independent-report-r1.md` SHA `a40695a66faa8fda35dc1a50ed731ab76e18ac0858ab38e2017bab5b1660cca2`。根亲读两份最终报告与原生日志，审查前后 branch/HEAD/八运行时与测试文件 SHA 一致；没有把旧 FAIL 或中期 GREEN 改写为最终结果。

本批保留 A 的记录/文件，以真实最新 B 的 bind 返回 ID 建包；坏 B、旧报价、并发变化和 unknown 不回退旧 A。已合格 clean_results 可复用，不因只换动作参考增加供应商或预留。产品 HTTP 旧用例含隔离媒体 fixture，真实 import/bind 和字节/hash 由正式用例与原探针另行验证；这仍不是普通页面到默认后端的完整浏览器验收，更不是模型生成质量。

机器回执 `.codex-staging/r2-motion-preparation-binding-verification-20260906.json` 累计 104 源、当前两文档、全部本包原始通过/失败/诊断证据及父 UI 回执。父快照只有声明的 6 源变化和 4 新源纳入，35 个父工件/parent 引用无漂移。只勾选后端兼容与组合再审两项，R2d.2d 页面四个退出条件、R2 与 R3–R8 保持未完成。

当前执行指针：**页面显式准备/受控新 CAS → 动作处理与长音轨/多输入 → 动态队列执行与恢复 → 音轨合成/导出 → 多输入本地回归及另行授权的精确版本 CI → 另行授权的真实质量 → 同项目恢复导出与用户移交**。本轮不读 Key、不调用供应商、不付费、不 commit/push/merge/CI、不 SSH/部署/重启、不写生产或 shared、不改线上模型；目标继续 active。

### R2d.2d 第二页面子包入场与正式 RED

后端完成回执 151 个引用本轮复核无漂移，HEAD 仍为 `8c49a90773a4311992e4eb9b6a5bc2c9acdfa4ed`。前端三套入场基线为 **60/60、0 fail/skip/cancel、exit 0**，原生日志 `.codex-staging/r2d2d-page-entry-baseline-20260906-r1.tap`。新实现者随后仅加正式真实 SFC 反例，**0/1、exit 1**：upload 明确成功且所有 fresh GET 完成后，显式 prepare 请求仍为 0 而不是 1。三套组合 **60 pass/1 fail**，唯一失败为新反例；原 runtime 未改。日志及字段分析保留在 `r2d2d-page-impl-red-20260906-r2.tap`、`r2d2d-page-impl-context-regression-20260906-r1.tap`、`r2d2d-page-impl-needs-context-20260906-r1.json`。

字段检查没有发现任务最终 CAS 回执，作者先停止 runtime 等待澄清。根依据批准合同确定以“本次任务明确完成”加“当前 source／候选／bundle／gate／媒体与不变业务内容”两个独立证据受控采纳当前 CAS，不把任务 GET 冒称最终 CAS 来源，也不新增后端接口。最小政策及反例范围已记入唯一计划，另有独立只读检查；本节不是运行时 GREEN 或完成证明。

默认后端浏览器映射发现旧 helper 直接 seed motion，而 normal integration 的公网 fetch guard 原只在另一模式启用。新的浏览器包限定原 spec：先封闭测试公网出口，以真实隔离 DB、普通上传、实际 import/ffprobe/prepare/bundle 和低层本地文件 provider 验证，不用路由 mock 或直接最终绑定冒充整链。三个本包文件逐项不属于现有清单 `protectedPaths`，故不重复添加无关 unlock；旧功能锁仍需回归。独立浏览器、页面 GREEN、规格与质量退出尚未发生，四个页面条件及总 R2–R8 保持未完成。

第二子包后续进展（此前入场状态保留）：页面作者最终冻结核心三套 **114/114**。扩展相关回归 135/136 的唯一失败为旧 `redrawShots.test.js` 整文件禁止 `task_id`，误拦新的只读准备回执。根亲读实际生成 handler 后另跑正式 RED **0/1**，仅将原危险字段规则限于三个真实生成入口，新增 3×5 字段注入检验；原积分文案／危险字段合同不删，整个 Shots **18/18**。根全部转绘前端 **466/466、0 skip/cancel、exit 0**（`r2d2d-page-root-all-redraw-20260906-r1.tap`，SHA `a2ce4f68d00dd8767bb552d50baffc008e88fc516d2d516964ac7a8a76647e69`）。正式视觉 preflight 五报告保留在 `r2d2d-page-visual-preflight-20260906/06_spec_review`；因批准视觉输入缺失，不冒称像素／WCAG通过。

根隔离公开模式编译成功，1923 modules、37.36 秒、exit 0，保留既有 chunk-size warning。使用新本地工件 `r2d2d-page-public-build-20260906-r1.mjs` 直接导入原 Vite config、`configFile:false/envDir:false`，输出到全新隔离目录，不读取 `.env`，不覆盖原 dist；这是公开模式编译，不是标准发布工件封装、候选或部署。

真实后端浏览器尚未通过：r1 在 Vite/esbuild 配置打包访问祖先目录时被权限拒绝，未进入测试；保留原日志及启动器。新 r2 仅改为直接导入现有 ESM config，仍禁 `.env`，已实际完成隔离数据库迁移并进入真实链；首先因新测试错误期望 motion import HTTP 201 失败，实际路由成功返回 **200、4 秒、320×180、零计费上传资产**。这是夹具断言错误，不修改产品成功状态码。r2 尚待测试服务器收尾，不能据已发生的上传推断 A→B 链通过。端口预检证据更正：沙箱拒绝 Get-NetTCPConnection/CIM，早期 `-ErrorAction SilentlyContinue` 的空输出不能证明空闲；后续使用有实际输出的 netstat，并保留 strictPort／真实 listen 拒绝复用。测试服务器仅按本轮日志 PID 与 StartTime 精确归属处理，不操作其他本地或线上进程。

后续终态补记：r2 的 Windows Playwright webServer 收尾未退出；按本轮日志、PID/StartTime/路径确认仅自有 Vite 32920 后精确结束该进程，runner 随即 exit 1，原业务失败未被掩盖。最终 r2 日志 SHA `01eaf1c56527f047cdd3853f9ba73cb858360d4cd22025e90400db64073c3cfb`。r3 改用本地 supervisor 持有其新建的 Process 实例，测试后只回收这一实例，避免枚举或终止其他 Node 进程；进程 40408 已明确退出，没有遗留监听或清理挂起。

r3 真正终态为 **1 fail、exit 1**，日志 `r2d2d-browser-entry-20260906-r3.log` SHA `9ea0db5ef6392f03b91ffa3389b00f8b375d9fa77457664223d331e153a3a4b2`。trace 显示隔离 version 2 的 shot 4 两轮净景准备/审核成功，随后 quote 为零项目且仍缺该镜动作；shot 5 已通过真实动作上传，但它的首次 quote 返回 **500 INTERNAL_ERROR**，未发该镜 prepare、未进入目标页面 A→B。现有内存 logger 的 JSON.stringify 丢失 Error message/stack，失败提前退出也未持久化 runtimeErrors，故不能仅凭公开错误确定根因。下一 r4 只补本用例安全错误字段与请求路径/hash 诊断附件，保留成功断言和所有产品代码，使用新输出及同一精确自有进程生命周期。

独立页面审查 `r2d2d-page-spec-20260906-r1.report.md` 为 **页面代码功能 SPEC PASS / 整体 PARTIAL、WAITING_EVIDENCE**：Motion 96/96、Shots 18/18、转绘前端 466/466、功能锁 37/37、audit ready，均 exit 0。审查者未运行作者独占的默认后端浏览器用例，报告是命令终态摘录，不冒称原生 TAP。浏览器尚未绿色，故未启动 QUALITY、未关闭 R2d.2d，更不宣称完整转绘、真实供应商质量、CI 或生产交付。

r4 诊断仍 exit 1，已确定实际异常为 `REDRAW_MOTION_CANDIDATE_NOT_FOUND`，在候选 reader 的 scope JOIN／作品 ID 校验处抛出，未到媒体 hash 校验。原生日志 SHA `64ffa67bbbf03ff6ec2dc74e54bf63c878d4663527c870a015c6bde9304343a9`；trace SHA `48a4e150e5f093e50807a6e59b7a9ae1b057eef64996a8515ee075ea4ae7cdec`，含安全错误附件。自有 Vite 54780 已明确退出，未重跑 r4。

诊断过程保留纠正：一度依据 `migrate.js` 兜底建表推测权威作品 ID 为 TEXT；独立只读复核发现实际先执行迁移 49 创建 INTEGER，该推断撤回，未修改任何 reader 或添加猜测修复。原正式 HTTP fixture 通过注册及 `ensurePersonalTenant` 建立 active tenant/member，当前浏览器 fixture 仅注入 request 身份，而两个只读 reader 额外要求持久化 active 成员 JOIN；下一步在该新用例记录真实缺失计数，仅补合法隔离 owner 前提后再次验证原链。不能提前把静态推断或初始化改动写成端到端通过。

r5 已以真实断言确认旧 fixture 的 tenant/member 均缺失；只在新 R2d.2d 用例单事务补固定本地 owner 的 active 两行，再断言持久状态。四个 reader/正式 HTTP 测试保持原冻结 SHA，权限 JOIN 未放宽。旧 quote500 已消失，所有前置净景准备/审核通过，并进入普通页面 A 的真实 multipart；零计费上传、asset SHA、320×180、4 秒均通过。随后首次新失败为候选视频 `readyState >= 2` 在 5 秒内未达，尚未显式 quote/prepare 或替换 B。日志 `r2d2d-browser-entry-20260906-r5.log` SHA `d2acc078cdd1a9efa80ec768a5808847911c1385b7ca2b9b2523f2b28a5576f2`，exit 1；自有 Vite 62916 已退出，未重跑。当前只读区分媒体请求拒绝、页面证据问题和视频 preload 行为，不先扩大超时或删除解码断言。该 fixture 初始化不代表真实登录验收。

r5 trace 后续确证：候选 video 元素不存在，三个镜头的公共候选 GET 都返回 404，没有媒体 GET，故不是 preload/解码或等待时长。`routes/index.js` 的只读素材租户门禁先于通用中间件执行，使用 `X-Tenant-Id` 或默认 `personal:${user.id}`，不沿用测试注入的 `req.tenant`。当前 fixture 缺选定租户 header，实际默认 personal 与它的固定 `tenant-redraw-local` 不匹配。独立复核正式 HTTP fixture 通过真实注册/personal tenant 初始化，因此默认个人租户匹配并保留 foreign header 404 反例。下一修正仅使本地会话按正式前端当前租户机制传递同一固定租户，不改权限门禁、业务接口、视频等待阈值或其他用例。

r6 默认后端浏览器仍为实际 RED、exit 1，未重跑。正式会话键 `moli_mama_tenant_id` 已由前端 Axios/受保护媒体自然传头，测试原生 fetch 仅专用模式补同头；所有本用例 redraw 请求租户一致性断言通过。A 真实上传和 candidate GET 已成功，接着 reference-bundle GET 返回精确 `REDRAW_REFERENCE_BUNDLE_NOT_FOUND`。对应 backend findOwnedShot 已通过，当前 work 的 bundle hash/update 为 null，尚未 bind/rebuild，不能称 reference_ready。SFC 的 Promise.all 因该首次无包错误中断，未请求 media、未建立上传 proof，也无法开始显式 prepare。这是产品页面首包衔接反例，不是解码/超时，测试成功断言保持不变。

r6 entry SHA `1a8f2dc5b1ca45f4d54f9c925f40e02fea1f739828fd901cc9dff404c4822bd6`；trace SHA `340cd601e9ca11e4363c5c894690f70e2ff8bf3f5436fe4d26b586f24a74ed93`。spec 冻结 SHA `6cde5ab39d2ea27712c5b46128975543422924db81963528b31926bcd721929a`，自有 Vite 58996 已退出、两端口无监听。新页面实现者仅对 SFC/原 Motion 测试做本次精确缺包合同 RED→GREEN；完成阶段仍必须真实 bundle，后端/API/权限不改。此前页面 SPEC 只覆盖旧 SHA，新的修复须重新独立审查，整体尚未通过。

首次无包修复正式 RED 为 **114 pass/3 fail（共 117）**，原 96 项不变；GREEN **117/117**，相邻五套 **158/158**，全部绿色 0 skip/cancel、exit 0。两文件冻结为 SFC `12ff930ef9d154b7a9ee8c74082efc74cd8f960ffaca1175ef12a068f91899c2`、Motion test `535feb88edfecddce0a61a2aefa932b9f2bcb30c333667a26a1dd66a718b4f1b`。只有 fresh confirmed 上传、双字段明确 null、精确 Axios 404 才按“未创建”继续读媒体；完成阶段未改。原生日志和反例矩阵见 `r2d2d-initial-bundle-receipt-20260906-r1.json`，根已完整回读。

作者浏览器 **r7 1 passed/exit 0**，实际越过 A→准备→B→准备全部原断言；该配置成功时仅留日志与 `.last-run.json`，没有留 JSON/截图/trace 附件。作者回执 `r2d2d-browser-author-receipt-20260906-r7.md`（SHA `80cf1fdc393d77a9ee9e3f547b0b21a6fa05b16c2bdaa6361ba0bb6837489495`）明确该缺口，没有补造当时状态。

根随后使用同一冻结 source/spec 做独立端到端 **r8 1 passed/exit 0**，case 57.1 秒/总 1.2 分钟；新配置保留原生 JSON 与成功 trace，自有 Vite 55124 正常退出，实际 netstat 无测试监听。`output/playwright/r2d2d-page-20260906-r8/report.json` SHA `01d8292263fe73007e72604d1b2c0784b36763adb08043b242920e090f060ed8`，含 owner 前提、完整链 JSON、B 页面 PNG body 和 trace 路径；根已解析原生结果，不从作者旧日志重造。A 为 import 3/asset 37、task completed；B 为 import 4/asset 38、task completed，两个包/evidence/CAS 均不同，Chromium 实际解码 4/5 帧，都是 320×180/4 秒。两次 provider/reservation 计数均保持基线 **7/9**（仅本地 fixture，不是真实供应商请求或扣费），旧 A 文件/行不变、零 video generation/生成 POST 断言通过。独立入口日志 SHA `cba1f9255928811e4a19bb87ff4860252b7ddd7dbcf52ce65bcfdb40a149109a`。

根新全前端 **487/487**，日志 SHA `bd1e15370f6fa3f76e519822555b2a03fb5781f7be97d4aa2a19d23477ec28f4`；功能锁 **37/37**+audit ready/11 features/65 changedPaths，日志 SHA `1a72ceae4d4f92dec19d3885f1f034d6fa9c1454a06f1d343bdb726e7346b604`；公开模式隔离编译 1923 modules/31.48 秒/exit 0，保留原 chunk-size warning，日志 SHA `907811888181204f5bac048719c8b9ea94a5b7d57be870619907f90b69eaedc0`。相对父后端回执 104 源只改变声明的四个前端源/测试，45 父工件无漂移（`r2d2d-page-root-source-scope-20260906-r2.json`）。当前等待新 SHA 的独立 SPEC 与随后 QUALITY；还未勾选四个整包退出条件，不作真实供应商、登录、视觉质量或总交付声明。

独立 SPEC 新终态为 **r2 PASS**：审查者核对新冻结源码、117/117、158/158、487/487、37/37、audit ready、独立 probe，以及根 r8 原生完整链附件；未发现未解决规格反例，无活动命令。报告 `r2d2d-page-spec-20260906-r2.report.md` SHA `3c3c474b04406ec01afcdbe227e21503fc2c038c7a0cc161106d8b3eecf40724`，根已完整回读；旧 r1 与所有日志保留。取得该终态后才启动全新非实现者 QUALITY，当前尚无质量最终结论，不提前勾选或进入下一运行时子包。

下一子项已仅做只读映射：有固定样片的真实 FFmpeg 全帧模糊原语，以及真实 coverage 遮罩生成/审核修订；未发现“当前 owner 源快照＋审核覆盖→通用自动遮除动作视频”的产品生产者。固定 SHA/尺寸和 ffprobe 自动写 obscured=true 不构成质量验收。该缺口已记回唯一计划，未修改后继代码、未运行新处理/Worker 模型或真实供应商，不能把这次 A/B 引用就绪验收扩大为自动遮除已完成。

#### R2d.2d 页面最终本地收口（2026-09-06）

新独立 QUALITY r1 **APPROVE**，报告 SHA `8a4ecb811242d758b6b9957bf42168c964540e6bf119fa1c70ca4e96b33f51fd`；局部 135/135、三测试语法及 scoped diff-check 均 exit 0。初报的一项 LOW Blob URL leak 经具体控制流和独立 probe 复核撤回：motionScope 包含 shot CAS，completion 先 applyWork，flush:sync watcher 会清理旧 URL；applyingMotionPreparation 只抑制重复读取，不抑制清理。根再次实际执行原 probe（SHA `c235de2965a61d2bd183f9ae83bc16afdec4dccb7c177cb73deadee82f51c617`）exit 0，断言 completion 时仅释放旧 URL、新 URL 仍存在，随后 dispose 释放新 URL。输出的 finalUrl 为空发生在 dispose 后，不能误读为页面完成后无预览。没有为误报新增代码。

源冻结未变：SFC `12ff930e…99c2`、Motion test `535feb88…4f1b`、Shots test `0e9d5fa9…3f63`、默认后端浏览器 spec `6cde5ab3…929a`。根此前独立 487/487、37/37+audit ready、公开模式编译和 r8 真实默认后端浏览器全部有原生终态；新 SPEC r2 PASS 后才进入 QUALITY。四个 R2d.2d 页面条件现有完整本地证据，累计快照见 `.codex-staging/r2-motion-page-preparation-verification-20260906.json`，父后端回执、旧失败日志、r7 成功未保留附件的限制均原样保留。

这次完成的是普通页面“当前动作 A 上传→显式准备→真实包就绪→换 B→再次准备”，并证明净景复用时零新增本地 provider/reservation。没有自动重试/生成，没有放宽权限或首包错误；隔离 owner 和底层供应商 fixture 不代表真实登录或真实供应商。正式视觉仍 **BLOCKED_PREFLIGHT**，整体目标保持 **active**，未执行 commit/push/CI/合并/部署/生产写入/Key/供应商/付费。

剩余顺序已更新回唯一计划：真实动作像素处理生产者→长音轨→多输入合同→动态单元执行/恢复→音轨与合成导出→完整多输入回归和获授权后的同 HEAD CI→真实多输入质量及同项目恢复导出→用户新视频验收。当前仅完成下一生产者的只读入口定位，尚无处理实现或质量通过证据；不重复已关闭的上传/候选/准备连接，不另立固定整集任务。

#### R2d.2e 设计入场与实际缺口（2026-09-06，仅只读核查和方案文档）

本轮重新核验当前 HEAD/分支，父页面回执 `d05c5eeee2cb7dad25ae42dca9faf19d7be0f47df404f38264fcba1972ce46a1` 的 262 个源/工件/parent 引用无漂移（tool `853cab`，exit 0），没有重跑或重标上轮测试。本地已安装 FFmpeg 的 `maskedmerge` 和 `gblur` 帮助查询均 exit 0，只证明滤镜存在，未生成新视频，不是处理质量证据。

独立只读 explorer 补全合同：reviewed manifest 无 owner/用户批准资格，必须再读当前 owner 的 DB 批准；帧时间基于源 ticks/time_base；mask 是保守审核区域而非精细生成遮罩；现有完整 reader 验证后只返回代表帧 requirements，不提供可渲染的逐帧流。根另实际读取生成投影确认：当前只发送 identity images＋motion video，没有向模型发送 clean plate。因此不能以“净景已在包内”为由认定全帧模糊背景已经有补偿。

上述事实使下一步成为真正的像素处理合同，而不是薄 API 接线。唯一计划新增 R2d.2e：推荐按审核轨迹逐帧局部去身份，保留其余场景；全帧模糊＋新增净景输入和引入新视频模型作为另外两种方案明确比较。推荐方案只产待审素材，不能自动宣称遮除/动作质量通过；其画面效果取舍须先确认。依据 brainstorming 技能，当前未修改处理运行时或正式测试、未生成新样片，不能称此项已实现；后续需正式 RED→GREEN、独立 SPEC→QUALITY 及真实质量验收。现有源码和旧回执/候选未改，0 Key/供应商/付费/生产/Git 操作，整体目标保持 active。

独立 critic 对“局部去身份、保留背景”方向给出 OKAY，确认不能将审计区域改称 fine inpaint mask，且当前投影不支持假定净景补偿。根已完成书面自检，澄清首帧展示区间正长度交集及合法空区域，最终方案待用户确认。此轮是新增实质源合同证据和设计收敛，不是正在运行的测试等待；没有活动媒体/供应商执行句柄。只读入场记录为 `.codex-staging/r2-motion-processing-design-entry-20260906-r1.json`，不得借此覆盖上轮页面完成回执或勾选 R2d.2e。

#### 六组剩余工作全量推进（2026-09-06，新用户指令后）

用户要求“规划好剩余6项-工作 全量推进”，本轮开始执行已推荐的局部人/字遮挡方向。唯一主线计划新增 G1–G6 的责任文件、依赖、失败反例与退出条件；不新增平行计划、不重做固定样片、不再次询问同一个开发方向。既有目标工具的 blocked 是前轮等待方案状态，本轮不据此停工；未调用工具伪改 active 或宣称目标已完成。

独立路线核对发现并保留两项实质断点：动态队列只有 immutable pending 事实，没有 unit attempt 消费者；release/composition 仍只消费独立配音，concat 禁用视频原音轨，报告也还不是 hash 绑定下载工件。上述均进入 G4/G5，不将老生成或音轨验证函数当整链接通。

独立计划审查先因 G2 缺聚合证据结构、G4 缺运行状态合同给出 REJECT；补齐 G2.0 后端单窗 Worker 复用、全轨/窗口/整句来源绑定和窗口 speaker 命名空间，以及 G4.0 run/attempt 表、领取/提交标记、unknown 恢复、quote_hash 与 HTTP 后，复审 **OKAY（可安全实施）**。这是计划审查，不是 G2/G4 已实现或真实内容通过。所有后继仍按单包 TDD 与独立 SPEC→QUALITY 验证。

本轮父页面回执 262 个 source/artifact/parent 引用入场无漂移，HEAD 仍 `8c49a90773a4311992e4eb9b6a5bc2c9acdfa4ed`，linked worktree/分支不变。根原相关基线 `g1-motion-coverage-root-baseline-20260906-r1.tap` **76/76、0 fail/skip、exit 0**；新 `loadReviewedMotionCoverage` 正式缺导出 RED 后实现，根独立重跑 `g1-motion-coverage-root-green-20260906-r1.tap` **44/44、0 fail/skip、exit 0**。读取者只返回当前 owner/批准/源/CAS 绑定的完整逐帧输入，保留切镜落帧中和不均匀 PTS，不渲染、不自动审核、不创建任务。

本次触及 `redraw.product-media-http-chain` 的授权精确追加，旧 unlock 完整进入历史；专用测试 RED→GREEN，根全功能锁 **38/38**，audit **ready:true / 11 features / 67 changedPaths**；保留既有 npm 配置 warning。原始日志均在本地 `.codex-staging/g1-motion-coverage-*`。当前等待 G1.1 最终相邻回归回执和独立规格/质量审查，不提前勾选 G1.1 或 G1。未运行像素处理、长语音、新媒体生成或真实供应商；0 Key/供应商/付费/生产/Git 写入/部署。

G1.1 初次独立 SPEC **PASS**、QUALITY **APPROVE / 1 LOW**，两位均实际运行 44/44。作者相邻最终 76/76、exit 0 已收到；其中第一次启动器丢失退出码句柄，保留原日志后只对未变源码补一次有终态的相邻运行，不冒称第一次有退出码。LOW 为新 motion reader 调用旧 timeline validator，坏时间范围错误显示为对白缺失；仍然 fail closed，但诊断错误。根决定在本包追加明确错误域反例，保持旧对白 validator/callers 不动，修复后再次 SPEC→QUALITY；不能用旧冻结 SHA 的 APPROVE 直接盖章新实现。

G1.2 独立静态审查选用 reviewed frames + Sharp 局部 union mask + FFmpeg VFR，原视频只作为受保护源快照和几何/时间基证据。另一个独立实现者仅执行合成媒体探针，最多三种变体、每种横竖两例；实际发现普通 concat 和重复末帧再截断都将期望 1.35 秒缩为 0.851 秒。显式 `setts` 末包 duration 才得到四帧 PTS `[0,.15,.45,.85]`、duration `[.15,.30,.40,.50]`、1.35 秒、无音轨，横 `96×64/SAR4:3` 与竖 `64×96/SAR1:1` 都通过。根没有重复构建，另用实际 ffprobe 和文件 SHA 独立复核两份通过输出，exit 0（tool `759907`）。

探针脚本/完整命令/结果为 `.codex-staging/g1-vfr-probe-20260906-r1.{cjs,log,json}`，全部 27 个工具命令 exit 0 只代表命令执行成功；六个技术用例中 **2 符合时间合同、4 不符合**。所有输出保留在唯一合成临时目录，不读用户素材、不调用供应商。唯一计划补齐 callback 生命周期、帧/遮罩字节复核、SAR/时基/末帧和输出待审合同；该探针不是产品像素服务或实际浏览器质量验收，G1.2 仍未完成。

G1.1 最终本地收口：LOW 修复的正式 RED 为 6 项中 3 预期失败（另外 3 项证明数据库直接拒绝非法范围），未移除 SQLite 约束。新完整 **50/50**，根独立重新运行同 SHA 也是 **50/50、0 fail/skip、exit 0**（`g1-motion-coverage-root-green-20260906-r2.tap`，原生终态 tool `ed0e36`）；旧 timeline 两项短回归 **2/2**。service 当前 SHA `fd0702c4ed6b462c334c8291df8d136fa1238297c071e35f495f99a16126cae2`，测试 `dc6e4c0cae07508e9ab5291329cd690d8e125891146fec1149c43b2aa110fbb5`，fixture 未变。

独立 SPEC r2 **PASS** 后，QUALITY r2 **APPROVE**，原 LOW 关闭、无新问题；两次都实际跑新 6 项、核对冻结 SHA。质量代理的角色是只读，两个 QUALITY 文件由根如实保存其最终回执，明确来源，不伪称代理自己写文件。只勾选 G1.1 当前镜头逐帧输入子包，六组总目标未完成。累计快照 `.codex-staging/g1-motion-coverage-verification-20260906-r1.json` 保留父页面回执及历史失败证据；后续 G1.2 像素实现按明确时间/像素合同开始，仍不触碰任何外部或生产授权边界。

G1.2 正式真实媒体 RED 已确认：真实 MP4 解码后进入原完整 reviewed coverage validator 的前提通过，服务缺失导致其余六项失败（red-r4：1 pass/6 fail，exit 1）。首版横竖、非均匀 30k/90k 时基、区域 RGB 与等编码基线、生命周期 7/7 GREEN 后，继续增加源音轨、切镜/单帧、取消、错误、漂移、旋转和不支持时基等反例。此前 red-r1–r3 是夹具准备错误，不充作功能 RED。

根源码复核发现“输出时长正确但原片提前结束”的漏洞：实际源 10 秒而合法源 SHA、work/coverage 记 12 秒时旧处理仍放行。正式 source-eof RED 为 Missing expected rejection；窄修改为检查真实视频流 duration_ts/time_base，上传服务本身也优先记录视频流时长。另一个资源 RED 确认 PNG/concat 写后仍保留 5 个句柄；改为写后关闭，仅 output 持有，输出 SHA 分块读取，避免长片线性句柄与整文件内存占用。扩展绿色 r4 为 41/41，包含 Windows symlink 权限不足时明确标记的窄判定 double，不能称该平台真实 symlink 攻击实测。最终修复后的联合回归和独立双审尚未收口，不能用该旧 41/41 直接批准当前代码。

G1.3 当前只完成只读合同审查，未改页面/路由。首选有界二进制 envelope、浏览器回传技术附件明确 unattested、服务器重建输入绑定，再沿用四项手工确认/import/prepare。审查定位了 prepare 原只核对 source/clip/duration 的缺口：新附件路径必须同时检查处理时 coverage/输入集合，禁止把旧产物换贴新覆盖。唯一计划已记录该最小合同及后端/页面两个包，不引入签名 secret、缓存或新数据库表。G2 hash/窗口 speaker namespace 消费合同也已细化；G3 ZIP 容量问题已异步询问用户，不阻停其他本地包。G2–G6 尚无本轮完成声明。

G1.2 首次冻结后根独立 **42/42、exit 0**，但独立 SPEC r1 实证发现 P1：最终 trusted reader 后再次 await 输出 stat，隔离成员停用后 consumer 仍先被调用，事后才拒绝；P2：source callback 三个辅助 assert 未统一过期。根亲读源码及完整反例后按接收审查流程处理，保留 r1 **FAIL** 报告（SHA `10afc936083105bcc04ebf078cfd1dbb7d7c3dab11af87065cb49f28767a860d`），没有以绿色旧测试盖过新漏洞。

两问题分别正式 RED：6 项失败，加输出在最终 reader 等待期间改变的 1 项失败。最小修正仅前移既有异步 stat、末端同步 fstat/路径/源终检，以及新 source callback 三个方法的 active 包装；旧 source 准备原语与冻结覆盖 reader 未改。作者新 **101/101（49 新＋52 source）、exit 0**，根独立新 **49/49、0 fail/skip/cancel、exit 0**，源码前后 hash 稳定。根机器回执 `g1-motion-obscuration-root-run-20260906-r2.json` SHA `b367c4f11f2abddd6c006e98d14675c262da19876a3547612e8710b0e38a5ca5`。SPEC r2 独立 8/8 后给 **PASS**，报告 SHA `a7022fe773cf1aa385835370a0d4af25f0238e9b13d5c2970324605dc1437c1e`，两个问题关闭；随后才派全新 QUALITY，尚待其结论。当前 motion/source/test 三 SHA 为 `dda7ea59…abde27`、`69d063cd…a5f817`、`4794086f…27132e`；fixture 未变。旧 42/176 不冒称为新 SHA 完整回归。

G1.3 准备阶段合法 claim/persist 会更新 shot CAS，故独立核对后明确：import 仍比较完整输入 hash；服务器另外从可信输入只剔除 `shot.expected_updated_at` 计算 material hash，prepare 用当前 CAS 重读并比较材料，同时保留原业务 baseline 对 prompt/dialogue/draft 的并发检查。不能泛化成忽略全部时间或业务漂移，也不能改变 G1.2 hash 含义。G5 只读映射确认 native evidence 的 MP4 hash、紧凑 validation hash、临时前 15 秒 WAV hash 不同，当前 locale 未验证；release、composition 多处 replace、HTTP blockers 和报告/剪映投影尚未连接。这些均作为明确待实现合同留在唯一计划，不是相应功能已通过。

G1.2 QUALITY r1 为 **REQUEST_CHANGES / 2 MEDIUM**，不是 APPROVE。报告 SHA `0cc4d667cb2cd15e8303150f36b793c3daf9d77bad223a0526d4bc8abaa76aa4`：Q1 在首个新 PNG open 成功、首次 FD stat 单次 EIO 时尚未 owned 登记，真实探针留下句柄/文件；Q2 单个输出 unlink EACCES 会中断其余安全自有 PNG/concat 清理。两条独立反例均 native exit 1；原常规短回归 7/7 不覆盖它们。根亲读代码和完整反例，已交原实现者逐项正式 RED→最小修复；不改安全目录/身份检查，不强删受阻输出，只回收其余可验证自有资源，服务边界保留结构化脱敏错误而非 raw ENOTEMPTY。本包仍未双审关闭；此前 SPEC PASS 及所有旧绿灯按各自 SHA 保留。

G2 只读入场复核已明确：64 MiB 拒绝来自 Worker server 的文件解析/读取层，非 JS client 或 `source_evidence.analyze_source_audio`。计划已指定同一个真实一小时 MP4 的“默认上传接受→完整 WAV→原 Worker 请求纯函数拒绝”反例，原错误为 `AUDIO_PATH_NOT_ALLOWED`、产品映射为 `SOURCE_AUDIO_ANALYSIS_FAILED`；不启动 Worker、不加载模型。当前只完成入口定位，尚未运行该真实媒体反例，不能计为 G2 实现或验收通过。

G1.2 QUALITY 修复后已冻结：motion service `0e0b52e3f1e190847eb302bb5698235b5a7c613cf6b74667f98b100a013e73eb`、source callback service `3a2c59122bb6773ac0c18989b6b2108225d3ff35e1391831c77532a63e5aae0e`。正式清理 RED 3/3 fail→GREEN 3/3 pass；另加文件/目录身份拒绝 2 项。作者完整 Motion **54/54**、SourceVideo **52/52**，各自日志保留 `NATIVE_EXIT=0`。根独立完整 **54/54、exit 0**、四文件运行前后 SHA 无漂移，回执 `.codex-staging/g1-motion-obscuration-root-run-20260906-r3.json` SHA `e8a0de768d0994a064dd31d6fbaa681cad7ee34f32bc86d79b90971c72a8bdbb`。受阻输出或身份不可信文件保留并结构化报错，不强删；本机 Windows 原生目录 rename 被 EPERM 拒绝，目录身份拒绝测试明确使用窄 lstat double，不能冒称实际目录替换验收。正式 SPEC/QUALITY 复审仍须分别收口，54/52 绿灯本身不关闭 G1.2。

G4 独立只读映射进一步发现三条必须覆盖的接入风险：视频恢复不等待整个 redraw Promise 链；generic 启动清理的下游会先做 30 分钟 held 退款；直接把预留挂到 video 会让底层 completed 提前确认。唯一计划已补新 unit 的有限类型保护、同步前置恢复、attempt 唯一结算责任和 31 分钟/反向直调/事务回滚测试。当前未修改这些服务，未运行对应测试，不能据此宣称恢复或账态已接通；旧 shot 与普通生成合同不得被本任务顺带重写。

G1.2 最终局部退出：根完整读回 SPEC r3 **PASS**（SHA `8ad4644cadc7e364479d090fb1e61240137bdfddd2a280247fc451492b89edd3`），再读回 QUALITY r2 **APPROVE**（SHA `6b6507253b04ec0c19bd43d87b51eea2b86a33830079f6a3e32a1bb343e8a3e1`）。SPEC 独立 13/13；QUALITY 独立 6/6 和原 Q1/Q2 两个未经修改的反例，各自 native exit 0，零剩余问题。根/作者完整 54/52 的证据归属保持不累加。只有像素服务及 callback 生命周期小包完成，G1.3 新处理 HTTP/页面未实现、人工实际观感未验收；下一包按唯一计划接通有界 envelope、回传附件的当前源绑定和 import/prepare 材料失效。新累计回执 `.codex-staging/g1-motion-obscuration-verification-20260906-r1.json` 不替代旧失败记录，不构成推送、CI、供应商或生产授权。

#### G1.3a 后端连接入场

依赖 G1.2 累计回执 SHA `d0f0bc2672629b2c58105bd8e31ec8752027890602ad56dfde82bfb2948db164` 已生成，根另一次独立回查全部 **339 项、0 漂移、exit 0**（tool `337da4`）。前置 SPEC/QUALITY 均有最终回执后，才派全新实现者承担后端 handler/report/import/prepare 连接，未并行改页面或 G2 实现。

首个真实夹具入场 RED 为缺产品 handler 与报告服务，**0 pass/2 fail、native exit 1**；三份既有产品责任文件前后 SHA 不变。证据 `.codex-staging/g1-motion-processing-backend-red-r1-result.json` 与对应完整日志（SHA `46d9ad84b8a3e2cbf037eaa612292f4da20dbf8740e94eb58308468384800942`）。该 RED 只证明入口缺失，实际 envelope/导入/准备行为仍待后续真实测试。

根同时为五项受影响功能锁仅追加此次本地授权，将旧 unlock 完整移入历史；新测试逐项逆向恢复后整份旧清单 canonical SHA 必须仍为 `be0cf030f2efcaca8ed05b3a2bf299ad7613c6c2a10128d602ecda1a08ab7e01`。授权记录 RED 1 fail→GREEN 1 pass，完整功能锁 **39/39、native exit 0**，显式 `--base HEAD` audit `ready:true`；没有删除保护路径、旧证据或必跑测试。当前清单文件 SHA `1bc34d4f7f4bb423c07ff3c03dea913f69ffd8e5bfe908fb74023d5e94b6270a`，功能锁测试 SHA `e9225f8c5bcd03e5da3b49a790315a2a34f7a8f4db19d8985cbb3e9d53100613`。记录就绪后实现者才获准修改本次责任文件；G1.3a 尚未完成。

G1.3a 连接首段作者 GREEN-r1 为 **4/4、native exit 0**，实际鉴权 router 响应 envelope 内 MP4 经真实 FFprobe 与 SHA 校验，包含错误 source/CAS/owner/query 拒绝和零业务写检查；根已读其 result 与当时源码。日志 SHA `7c67058df86b3148f17a9762f824e0653ca3bad4edd2e341baf5cda5ebc135d3`，回执 `.codex-staging/g1-motion-processing-backend-green-r1-result.json`。这只是接口首段的实现者测试，尚无根完整回归或独立双审；可选报告导入/prepare 和前端仍继续，不能计作 G1.3 完成。

G3 只读依赖核验完成：当前 adm-zip 0.6.0 的 DEFLATE 已支持按正 header.size 有界输出，故最小修复是先施加单片/剩余总量预算，保留原 getData/CRC，再核对实际字节；STORED 必须另检 compressedSize===size，避免伪小 size 绕过。已将真实安装 API、Unix 类型位、重复路径/descriptor 兼容及资源限制写回唯一计划，不新增解压框架。此为技术定位，尚未修改上传实现或完成测试，用户的 ZIP 容量选择仍待回复。

G2 根独立实际入场预检已完成：全新合成 64×64、3600 秒 MP4（11,186,014 字节）通过原 `expandSourceUpload` 默认时长/probe；真实抽取全轨 16 kHz mono PCM WAV 为 **115,200,078 字节**，确实超出 Worker **67,108,864 字节**。r1 原 Python uv trampoline 因本机权限错误未能启动，此失败记录保留；r2 只换用 bundled Python、复用已 hash 验证的原媒体，原 Worker 请求纯函数实际返回 **AUDIO_PATH_NOT_ALLOWED**，native exit 0，未导入 source_evidence、未加载模型。源 SHA `05c9849b35665c37e097b569819f401b2b7a85b059ff0a83f828ffb00605e075`，WAV SHA `0ae9f13946582c96d26393277429c75fa20d84a12c20de6167f85b431d96ff07`；r2 回执 SHA `e66de19a93f4f86cddaf1205546bca35207c95fe7a78e0bbd16b7cf1348765ca`（tool `155c8d`）。只证实“上传接受但完整音轨被原 Worker 拒绝”的实际断点，不是长轨分窗修复、正式产品成功 RED/GREEN 或语音质量通过；未改产品文件、Worker、供应商或数据库。

G1.3a 作者冻结回执为 `.codex-staging/g1-motion-processing-backend-verification-20260906-r1.json`，SHA `2e5e54c4410eaf98e1734f70ebc9b82006e0144c2b652c48455d13b42bcc9c63`。两套真实终态 **129/129＋217/217、native 0**，8 文件前后 SHA 一致。根亲读回执与源，并独立运行新增处理/真实 prepare **22/22、0 fail/skip/cancel、native 0**，13 责任/冻结依赖文件无漂移；根回执 SHA `e6a5def7a12a53230bcfa543e2a363dcc172ed682202ae9d7ff110a4cdee71fb`（tool `22007a`）。这不替代相邻旧路由、SPEC 或 QUALITY。

随后根完整 routes+feature 实际为 **193 项、192 pass、1 fail、native 1**（`g1-motion-processing-root-routes-feature-20260906-r1.tap`，tool `2f3bbc`）：唯一失败为旧 multipart 用例仍按5字段查找动作配置，新可选报告合同实际为6，导致读取 undefined.limits。已给原实现者明确第九文件的单用例修正范围，保留所有旧媒体限额/存储/文件名保护；没有为过测退回5字段或关闭测试。根另运行 feature audit `--base HEAD`，**ready:true、11 features、native 0**（tool `397b8d`）；audit 通过不掩盖路由测试失败。独立 SPEC 已运行同冻结22/22，但仍在核对旧 prepare 测试追加范围与此次测试修正，尚未给最终PASS，也未开始QUALITY。

G1.3a 第九文件修后作者 routes+feature **193/193、native 0**；根再独立运行完整同套 **193/193、0 fail/skip/cancel、native 0**（tool `713cf5`，r2 TAP SHA `96456cef285c94d614e6f912de24408f61feca91be50a725f62e0d41015fb720`）。新测试 SHA `2d95aa8487f775f2dc8ced947778da014337b047f620966d75eb82ddeb2e08c0`，原八文件不变。作者 r2 回执 SHA `7842c3d8dc36cede2a665239354e56257552e53df8d616cc3d3a10183990134b` 已亲读；根另外核对九文件0漂移（tool `f2fedb`）。

独立 SPEC 最终 **PASS**（report SHA `0a78e2b5fdb2a798bf39a563c23b46644fbddae78cb31f195d847f6b846938e1`，receipt SHA `25457c874b481f9b2925673731afdc7ffcd5ccfb633393e11027ab7a1c937c29`），独立22/22＋原A/B/限额兼容4/4均native 0。已如实纠正“字节级纯追加”：旧 prepare 内容/断言不变，但尾部三行 CRLF 变为 LF、新增一分隔LF；独立按明确offsets反向重建后精确命中父130557字节/SHA `5bcf2fc25a76e247844b9503ce2243c4d8c38274e13424abf0de5fbbf6ad01a1`。第九测试反向差异也精确命中原SHA，没有隐藏行为修改。根完整读回SPEC后才派全新QUALITY，当前仍等其结论；未勾选G1或G1.3b，也未运行新页面/供应商/CI/生产阶段。
