# 通用一键转绘产品完成计划

## 当前：G3 普通浏览器完整产品链已本地通过（2026-09-10）

- [x] 修复自动准备动作参考包被错误依赖手工 import candidate 的前端阻断。
- [x] 参考包 GET/PUT 回执绑定当前 `version_id + shot_updated_at + source_sha256`；任一漂移或上传 pending/unknown 仍禁止生成。
- [x] 动作参考/生成聚焦回归 184/184，参考包后端聚焦回归通过，前端生产构建 1929 modules 成功。
- [x] Chromium 从空隔离库完成母本上传分析、本地化、三镜参考准备、批量生成、候选 QA、整集发布及刷新恢复，1/1 通过。
- [x] 当前未提交工作树全量门禁：后端 6594 项中 6582 通过、12 跳过、0 失败；前端 2471/2471；语言 Worker 127 项中 119 通过、8 个平台/条件跳过、0 失败；启动器/媒体管线/回退/蓝图矩阵 153 项中 151 通过、2 个 Windows symlink 跳过、0 失败；特性锁 ready=true；生产构建 1929 modules；隔离 Chromium 1/1。
- [x] 常规后端测试入口已通过仓库内 guard 接入多输入 HTTP 用例，不再依赖专用启动器；前端四个封闭 SFC 测试夹具已同步新的源音频接缝审核纯模块及单选组件桩。

该结果使用本地假供应商，不等同真实模型内容质量或正式交付。默认 `git diff --check` 会把仓库索引和工作树均为 CRLF 的 `ttsService.js` 新增行误报为尾空白；启用 `cr-at-eol` 的全树检查退出 0，文件本身 549 行全部为规范 CRLF、无混合或裸 CR。仍需精确 Git 范围审计、获授权后的提交/推送与同 HEAD Hosted CI，以及单独授权的真实任意视频客户验收。本阶段不提交、不推送、不部署、不调用供应商。

## 当前：G2.V2_LOCK_FACTS 已本地实现并通过回归（2026-09-10）

- [x] 后端锁定使用从 owner-scoped 实际音频证据重建的可信 v2 上下文，不接受客户端 schema 标志授权精度。
- [x] 所有对白、人物映射与母本审核完成后，v2 可锁定并物化 Facts；对白小数毫秒保留，镜头/视觉/v1 整数约束不放宽。
- [x] 前端真实审核组件完成“保存最新 CAS → 重新检查 → 锁定 → locked 回执 → 本地化可用”，移除旧 review-only 限制；漂移、409、迟到回执、卸载与未审核路径仍阻断且不重试。
- [x] 验证：前端 v2 66/66、相邻审核 97/97；后端组合 242 项为 241 pass/1 既有平台 skip；功能锁 61/61；生产构建 1929 modules 成功。

G2 聚合总门禁已完成：分窗、任务绑定、接缝、恢复、v2、Facts 与来源重读合计 511 项中 510 通过、1 项既有平台跳过；另有实际 v2 组件 66/66、相邻前端 97/97、特性锁 61/61及生产构建通过。下一顺序进入 G3 多输入资源合同与普通浏览器产品链验收。本阶段不提交、不推送、不跑 Hosted CI、不调用供应商或生产系统。

## 当前：G2.SEAM_DECISION 完整段人工选择纯合同（2026-09-10）

后继 `resume_pending` 持久化已接入：正式 owner-scoped POST 位于认证租户上下文之后，只从服务端 owner 取作用域；请求仅含 work/task/candidate/work+task 双 CAS 与完整段 decisions。写前复用只读源文件哈希复核，事务内再次校验 candidate/task/work/source/reservation；只更新原 work/task，维持两者 `needs_attention`、原 reservation `held`，不创建任务、不运行 ASR/Native/Fusion。精确重复请求在当前源与状态仍一致时返回同一接收回执且零二次写；不同决策或漂移拒绝。采用 `resume_pending` 而非提前写 `processing`，避免进程在领取前退出产生无人执行的假运行态。

Orchestrator 独占 claim 已接入：重新解析并独立验证持久人工 v2，校验 owner/work/task/candidate SHA、work/task 新双 CAS、原 task/result、同一 reservation/model 且 held；事务 CAS 成功后才将原 work/task 改为 `analyzing/processing`，保持 durable `resume_pending` payload 供后半程及故障恢复使用。重复 claim、不同 owner/CAS 或已变化状态统一 stale；不创建任务、不改 reservation、不调用任何分析器。真实隔离测试确认领取前后任务总数不变、Worker 固定两次原分析调用、Native/Fusion 均 0。

人工 v2 证据已纳入独立 validator 重算：由原 windows、候选 reason/SHA 和 decisions 重建全部 segments、拒绝绑定、transcript SHA 与 commit owner；决策、未选绑定或输出文本被改写均无效。新解析/验证/路由定向 4/4；真实 route factory + 隔离 SQLite 聚焦 1/1；加入写入口后的候选完整套件 32/32。旧只读 GET 继续在 tenant initializer 前，POST 精确一处且在 initializer 后；旧静态断言按新阶段变红后升级并恢复 1/1。

已按用户采用的“完整保留识别段、冲突人工确认”进入下一片 TDD。新增纯解析器只允许对实际相邻接缝选择左/右完整来源窗口；输入不能携带裁剪时标、改写文本、伪窗口或不完整决策。物理来源与按完整句中点计算的逻辑 commit owner 分离，未选来源作为审计绑定保留，两侧原始 Worker 回执完整保留且不共享可变引用。决策强制绑定候选 SHA；`language_conflict` 继续用独立错误阻断，未借左右选择自动改语言。

正式 RED 先因导出不存在 2/0/2；首轮 GREEN 后新增跨接缝完整句反例，准确得到物理窗口误作逻辑 owner 的 2/1/1，再按半开 commit window 中点规则修复。最终新解析器与既有窗口聚合合跑 51/51；原候选持久化及只读审核链合跑 251/251，均 native 0、无 fail/skip/cancel/todo。计数有入口重叠，不相加作去重覆盖。未触发数据库写入、原任务续行、Native/Fusion、供应商或生成。

本片仍不代表接缝恢复闭环。下一步使用已领取的持久 audioEvidence 只续跑未完成的 Native/Fusion/Blueprint，并接真实 finalize/失败或 unknown 结算语义；不得重新运行 ASR、创建新任务或二次冻结积分。随后接页面审核控件和明确确认。

## 当前主线复核：审核计划到防重执行队列（2026-09-10）

按当前未提交工作树重新执行而非引用旧 CI：审核/持久队列后端 217/217、审核与队列页面 28/28、运行存储/并发 104/104、页面暂停恢复生命周期 114/114，全部 native 0、fail/skip/cancel/todo 0。由此确认当前源码仍能从已保存审核计划显式登记同一不可变队列、恢复同一运行记录，并在刷新/重挂/未知结果下防止重复写与重复提交；这些本地测试不会调用真实供应商，也不把 pending 队列说成生成完成。

运行存储首次复核为 104/103/1：Windows 会在显式最小 `spawn env` 之外自动补入登录环境变量，真实最小探针稳定复现同一七项，产品断言本身未失败。仅修改尚未跟踪的正式测试 `backend-node/test/redrawExecutionRun.test.js`：在 Windows 子进程环境中把这些系统自动项显式重定向到合成值/本次临时目录，Linux 白名单不变；随后完整 104/104。没有修改 run/queue/路由/页面产品源码。当前 HEAD 仍为 `8c49a90773a4311992e4eb9b6a5bc2c9acdfa4ed`，这不是提交、Hosted CI 或真实生成证据。

下一产品实现仍按唯一计划推进剩余 G2 人工接缝裁决与原任务续行，以及 G3 多输入/G6 普通浏览器和最终 CI/真实验收。`language_conflict` 在获得更具体产品决定前保持阻断，不借左右段选择自动改语言；这不影响已完成的队列连接复核。

## 当前：G2.SEAM_READ 持久接缝候选的人审读取已本地双审收口（2026-09-10）

上一片已完成无损对白审核，根索引 `40d8243b086e86cbfcd63c4e8744f6803421fcded33db521520e1a1212d3e0a2` 的 50 引用本轮开始前复算无漂移。继续用户已采用的完整段/人工确认方案，不重新询问产品选择。本片不是孤立 validator：必须有已注册的 owner-scoped GET，读取当前分析任务内的持久冲突候选，独立复算原窗，再提供人工审核所需完整内容及后续 CAS 令牌。此 GET 不写库、不恢复、不重新识别；完整段选择与同任务继续接在它之后，完整目标不缩减。

文件责任：新作者仅修改 `backend-node/src/services/redrawSourceAudioEvidenceService.js`（复用已有窗口/源文件验证）、`backend-node/src/routes/redraw.js`（一个只读 handler）、`backend-node/src/routes/index.js`（一个 GET 注册），新增 `backend-node/test/redrawSourceAudioSeamReviewRead.test.js`。根负责本片隔离启动器、实际命中五项功能锁精确追加、现有锁测试与文档。其他前端、Orchestrator、账本、模型、配置、迁移均不改；现有工作树继续使用，不创建新树、不 commit/push/CI/生产操作。

接口与不变量：

- SourceAudio 导出 `validatePersistedSourceAudioSeamCandidate(candidate)`：严格普通 JSON 和唯一字段集合，正 work/source ID、owner 与两种任务 ID、SHA；复用原始窗重建和 `aggregateSourceAudioWindows`，必须重新得到相同 `needs_review` 原因及全量 windows，再按原生产者 `stableStringify` 核对除自身外全体字段的 candidate SHA。不得接受成功 v2、伪造诊断、缺窗/改窗/改 reason/多余字段；不修改原文或小数时标，不把客户端自声明 SHA 当验证结果。共享原窗重建小函数允许替换 v2 原有重复映射，但 v2 成功校验合同不变。
- SourceAudio 导出异步 `getSourceAudioSeamReview(ctx, { workId })`，ctx 必须显式 db/storageRoot/tenantId/userId；可注入现有 fs 作受控测试。只读查当前未删除 owned work 和它的真实 `redraw_analysis` task；均 `needs_attention`、同 owner/resource/task/source，task result 为严格 `needs_review + source_audio_seam_review`。绑定 candidate 的 analysis_task_id，内部 source_audio_task_id 不冒充 DB task ID。任务 completed_at/provider_task_id 非空或无合法候选，均不可作为可审核内容返回。
- task/work reservation 必须相同；若非空，仅接受真实 owned `redraw_analysis` reservation、对应 resource/model、`held`。允许双方均无 reservation 的原免费路径；不调用账本结算、不新 reserve。普通 unknown 无候选保持不可审核，不通过 GET 重试/释放。
- 使用现有受限 source path/asset type/category/owner/hash 规则，实际读取源文件 SHA 与候选源 SHA 一致；不复制、转码、下载、写素材。文件打开后检查 descriptor/路径/stat 身份，hash 完成再检查；await 后重读 work/task/result/asset/reservation 与时间快照，任何漂移都拒绝，不返回旧审核令牌。源路径、owner 等细节不出现在错误响应。
- 注册 `GET /redraw/works/:id/source-audio-seam-review`，handler `getSourceAudioSeamReview`：跨 owner/不存在统一 404 `SOURCE_AUDIO_SEAM_REVIEW_NOT_FOUND`；非法 ID 400 `SOURCE_AUDIO_SEAM_REVIEW_INPUT_INVALID`；已属于该 owner 但候选/状态/源/CAS 失效 409 `SOURCE_AUDIO_SEAM_REVIEW_STALE`。非预期内部错误按现有安全 500。当前 GET 不接客户端 owner、candidate 或替代 source。
- 返回严格 DTO：`schema_version=redraw-source-audio-seam-review-v1`、`status=needs_review`、`work_id`、`analysis_task_id`、`source_asset_id`、`source_fingerprint`、`expected_work_updated_at`、`expected_task_updated_at`、`candidate_sha256`、`reason`、`audio_duration_ms`、`audio_sha256`、`windows`。windows 保留全部已验证原始回执，无 selected/default/success/资产成功标志，不暴露 tenant/user、本机路径或配置。令牌只是后续人工提交的 CAS 输入，不代表已有恢复入口。

测试与执行顺序：

- [x] 新测试先冻结并由根通过已读隔离入口运行 RED：正确 seam/language conflict 整段 round-trip、返回副本不改源、成功成品拒绝；篡改全层字段和自重算 SHA 仍不能绕过窗口聚合；非法对象不得执行 getter；source/task/owner/reservation/删除/unknown 隔离；实际源文件改字节、跨目录/链接、hash-await 中 work/task/asset/reservation/result 漂移；真实 handler 200/400/404/409 与静态注册精确 GET。比较隔离 SQLite 所有任务/作品/资产/版本/账本快照与 fixture 文件，无写入/新任务/扣退/调用。
- [x] 确认失败为目标缺口后才允许作者最小实现；禁止先写产品。复用真实聚合、SQLite、路由 handler 和本地源文件；只替换必要外层调用，测试不访问默认配置/库/Key，不执行真实 Worker/供应商/FFmpeg/网络，不运行裸 npm test。
- [x] 根 GREEN 后重跑已有 seam candidate 31、v2 review 57、task binding 48、aggregate 49 及精确功能锁；如果根入口还没通过安全审查不运行。保存 native TAP、原生退出、hash 前后、模块闭包，不合计重复覆盖；预期空库 migration 提示与 TAP skip 分开。五个最终业务测试 PID 根另查已退出；feature 仅依据完成的启动器/native WaitForExit，不将固定 activity 数组当作系统级进程证明。
- [x] 独立 SPEC → 不同 QUALITY 审查，必要发现闭环；根留下本片来源和日志索引后，进入已批准的完整段人工选择与同任务继续，不声称完整 G2 或真实产品交付。

根入口从已审 `.codex-staging/g2-v2-review-20260909-r1-run.ps1` 最小派生为本片专用路径、测试/receipt schema，保留清空环境、唯一短 TEMP、已安装固定 Node、既有禁止默认配置/库/网络/子进程 guards 和真实退出码/来源闭包检查。任何入口改动由根亲读并独立复核。所有 root/agent 运行都遵守本地边界；普通 Node guards 不是 OS 沙箱。

本片执行前补正：当前 `backend-node/node_modules` 是指向既有另一工作树依赖目录的 Junction，旧 guard 只记录当前 backend 前缀，不能把它的 closure=true 当作外部依赖全覆盖。新专用 preload 记录完整 CJS cache 的真实路径；根只读解析 7 个已知依赖入口的已安装 dependencies/optionalDependencies，固定 69 包、501 个代码/JSON/native/DLL 文件，运行前验证每份 SHA，并将清单纳入前后核对。清单 SHA `5fdf944ae111e79ca8494a22fdb1afe8d7064f22b42029380c6a33f280786b36`；不下载、安装或执行安装脚本。此 CJS 观测仍不覆盖 ESM、已删除缓存项或原生插件内部文件访问；路由测试未注入 fs 的描述符计数也不作系统级证明。功能锁先 RED 61/6/55，再 GREEN 61/61，native 0；完整 209 项业务测试冻结后才运行正式 RED。

正式 RED：测试 SHA `41a793ddbe14b39afb7cdc6aeee10802583b43a4005aa3f92d091b064715adf2`，根运行 `g2-seam-read-20260909-r1-run.ps1 -Label focused-red -ExpectedTests 209`，209/0/209、native 1、无 skip/cancel/todo/timeout；错误是三个未实现导出/handler 和未注册 GET，不能当作 209 个独立产品缺陷。日志位于 `C:/Users/canqu/AppData/Local/Temp/g2r-600faa506dff4895924175c55ba8b689`，receipt SHA `b40cb806767c9cd718a509e7984f93a5ecf20dcb475b7de518c2a1243bf0683a`；source/guard/完整 CJS closure 全部 true，未覆盖清单为空，PID 62112 已退出。独立预检通过后才运行；确认目标缺口后已允许作者仅改三产品，原测试冻结。

后继页面接点已只读确认：无蓝图的 `needs_attention` 仍在 SourceStep 源步骤，接缝区域应放任务卡与真实 BlueprintReviewPanel 之间，用独立 seam DTO；不得伪造 blueprint 或借本地化错误卡。当前 startAnalysis 错误分支未刷新 work，后继应补只读刷新，不重发 analyze。只有新 GET 的当前 owner/task/source/CAS 绑定成功回执可显示人工审核，普通 unknown、404/409/网络失败仍停住。完整段选择与显式同任务继续不在此 GET 片内提前实现。

首次实现 GREEN 209/209 后，相邻 v2 57/57、seam 31/31、binding 48/48、aggregate 49/49、功能锁 61/61 均通过，但 SPEC 初审发现 P1：新 GET 位于通用 tenantContext 后，`resolveForUser → ensurePersonalTenant` 会先写入首次用户的个人租户/成员，即使 handler 返回 404。因此已有 GREEN 仅覆盖 handler，不证明整条 GET 只读。根已亲读调用链确认；最小修正仅此 GET 移至已认证且通用租户初始化之前，采用既有 source-video 的 stored active membership SELECT 模式，缺失/无权 membership 返回本接口 404，非预期解析失败安全 500；不改全局租户行为。先补实际注册块与真实 auth/tenant 中间件组合的内存反例，再运行新 RED 后改产品。组合测试不监听网络、不运行完整 app 初始化，不能冒称完整浏览器/HTTP 验收；原 209 其余断言保持，唯一原挂载位置断言按只读主约束纠正。

P1 正式 RED：补 11 个实际注册块/认证/租户链用例后测试 SHA `ad734cb8938a7d082b4d6efcfaf0c1fa9e3f4ebbbcb05f0dec2de0c54a6b83ca`，根 220/210/10、native 1；原 208 业务用例、未认证拒绝、邻接 blueprint 保留两条初始化写入的对照通过。首访反例明确观察到 `tenants` 与 `tenant_members` 新增个人空间记录，其他失败对应挂载链、成员权限或错误分类，非入口问题。目录 `C:/Users/canqu/AppData/Local/Temp/g2r-f48a97ad18624f4284c7c7b9ffe0ecc1`，receipt SHA `a272db506667ca80aec9bb220c9257d6539d98bd4245aef6e9ad094ed712e2b1`；source/guard/完整 CJS closure true、无 skip/timeout，PID 52332 已退出。确认后才允许只改 index 挂载块，两个服务/handler 和测试继续冻结。

最终 P1 GREEN 220/220、native 0：`g2r-6e9dc665ad354ab8a0e676245a8c3159`，receipt SHA `6141fb9c4785472bef9638837dd4800ed46873d151cb833b59550091accacdeb`。最终 index SHA `8864316280288bd6215085eb2e4ae6dd2ac3025189d1ed96b8bb81967a7cd0ff`；SourceAudio/handler 保持首版冻结值。最终同源码回归 v2 57/57、seam 31/31、binding 48/48、aggregate 49/49、feature 61/61，均 native 0、无 skip/cancel/todo/timeout。五套业务各 863 来源、feature 145 来源，共 971 个去重引用收口时根复算无漂移；测试数量不相加为去重覆盖。两次遗漏 ExpectedTests 的启动器参数检查在创建测试进程前退出，补齐必填参数后才实际执行，未改门禁或测试。独立 `g2_seam_read_spec` 复审 PASS → 不同 `g2_seam_read_quality` APPROVE，Critical/Important/Minor 均 0。根索引 `.codex-staging/g2-seam-read-verification-20260909-r1.json` 保留全部阶段与失败证据。

本片仅完成可信存储候选的一致性验证和已认证只读入口；不提供对恶意重造全部 ASR/DB 回执的外部签名证明。实际注册块/真实中间件测试不等于完整 Express HTTP 或浏览器。下一顺序仍为候选整段人工选择及当前任务/原 reservation 的显式续行，再补 v2 锁定/Facts 消费；不得重发 startAnalysis、重跑 ASR 或把真正结果未知当作可审核。通用一键转绘总目标仍未完成。当前未提交工作树 HEAD `8c49a90773a4311992e4eb9b6a5bc2c9acdfa4ed`，不借历史 CI；无真实 Worker/供应商/付费/Key/安装/生产/Git 写入，未部署。

## 当前：G2.V2_REVIEW_UI 无损对白审核已本地双审收口（2026-09-09）

基线修正例外：产品未改时四旧套 source 12/12、correction 26/26、boundary 40/40；speaker 33/34，唯一失败是其提取实际 Workspace handler 的测试宿主遗漏已有 `loading/workspaceError` 引用（ReferenceError），不是本片产品回归。根仅给该旧用例注入这两个本地 ref，保留全部旧断言并增加 loading/error 拒绝控制；不改 Workspace 或放宽反例，其余三旧文件继续冻结。原失败日志保留，修正后重新固定测试 SHA。

沿已批准的完整识别段/人工冲突确认方案，接上一片已双审的后端草稿消费链。本片使实际审核组件能够加载、显示、修订、恢复和保存长音频 v2 对白，显式映射分窗声音人物；不新增模型、布局体系或后端成功标志。上一片根工件 SHA `272f71bb13711b90068c33ed5c14f6bd1c5d558b54d344200854ae13c7a89e53`，92 项引用已在开始前复算无漂移。

文件责任：作者仅修改 `frontweb/src/utils/redrawBlueprintReviewState.js`、`frontweb/src/components/redraw/RedrawBlueprintReviewPanel.vue`，新增 `frontweb/test/redrawAudioV2ReviewRuntime.test.js`；四套既有 source/correction/speaker/boundary 测试保留断言回归，仅有上述根负责的旧宿主修正。根负责本片受审启动器、实际命中的 `redraw.episode-blueprint-first` 单项功能锁历史、计划和证据。本片不触及 canary 保护路径，不追加该授权。不更改后端/模型/容量/实际 ASR 或生产配置，不创建新工作树。

- [x] 新定向测试冻结 `f54bccd83011f70554595707243433a1a20466c95a09980cf015e7d5f75dc6db`，根亲读实际 Vue script/template 与宿主后正式 RED：66 项、34 pass/32 fail、native 1，原始日志位于 `.codex-staging/g2-v2-review-ui-20260909-r1-focused-formal-red-85ab96ba6b414402a82a2b7459e39e31`。失败对应来源整数约束、缺少格式转换、窗口 cluster 拒绝和审核状态缺口；组件连带错误不单算独立缺陷。入口和输入前后不变，零 skip/cancel/timeout；确认后才允许作者改两产品。合成 record/DTO 不作为真实 ASR 证据，Vue 原生 v-model 指令未替换，仅内存宿主补齐 EventTarget/value/document.activeElement。
- [x] 来源上下文：只从唯一已保存对白 ID、原镜头、resolved DTO 的 `audio_evidence_schema_version` 与相同源身份、manifest ref/asset/SHA 绑定识别 v2；不凭客户端 draft 标志、speaker 前缀或小数值猜版本。编辑文字/映射人物/合法迁移后，仍从原已保存锚点复核，不把当前草稿投影当服务器重新验证结果。源、重复 ID/DTO、manifest 或状态漂移继续拒绝。
- [x] 精度：v2 整段来源/修订端点与投影保留原 JS Number 值；秒数字段打开再提交不得因三位舍入或乘除转换改变值。保留旧 v1 三位秒数/整数毫秒和镜头整数切点规则。覆盖 `1499125.4`、`1502125.6`、`1620125.4`、`1621125.6` 等实际聚合形状，包含跨镜头修订和恢复原句；所有七字段 `source_correction` 断言精确，不夹带 schema/context。
- [x] 人物与组件：已绑定 v2 的 `aw000001-speaker-cluster-1`、`aw000002-speaker-cluster-1` 独立列出/排序/映射，不能自动合并为同一人；人物改完或对白修改后仍能保存、重新取回来源。实际组件覆盖加载、整段时间显示、打开/应用/恢复编辑、映射、保存回执同步和 work/source/record 切换失效；不只测源代码字符串。
- [x] 门禁：对页面能验证的 v2 来源继续显示后端尚未开放锁定/Facts 的限制；不生成、预览或物化 Facts。已锁定、CAS 冲突、异步切作品和未知状态的原禁止行为保留；此限制不是整个产品完成状态，Facts 的精度接入仍按后继计划完成。
- [x] GREEN 后通过四套旧前端回归、相关后端 57 项/修订/边界/人物回归及功能锁；独立 `g2_v2_ui_spec` SPEC PASS 后由不同代理 `g2_v2_ui_quality` QUALITY PASS，必要问题 0。根核对精确输入/日志/运行终态并留证，下一片进入 seam 人审选择与原任务继续链路。

本片实际入口由根审查后固定为 `.codex-staging/g2-v2-review-ui-20260909-r1-run.ps1`，参数仅允许定向套与四套旧前端测试；每次清空环境、唯一 TEMP、已安装固定 Node/Vue、拒绝默认库/配置/网络/子进程/监听，完整 TAP/退出码与来源 SHA 前后核对。不是文件系统沙箱。不运行裸 npm test，不安装依赖，不读取 Key，不调用 Worker/供应商、不付费、不 commit/push/远程 CI/SSH/部署。模拟 API 回执不能当作真实识别、真实生成或最终浏览器交付证明。

本片最终：前端定向 66/66、旧 source 12/12、correction 26/26、speaker 34/34、boundary 40/40；后端 v2 57/57、correction 58/58、boundary 60/60、speaker 22/22；功能锁 60/60。十套均 native 0、无 skip/cancel/todo/timeout，计数有重叠、不累加作去重覆盖。Utils SHA `971190c121cd7dbff2341e90bb2717a2e4cba96c7073e7da1821f58e1ba2f761`，Panel `83a701f108c4826bbc354ffe07ab64398664bf3ecc53dbd30f9083d9ba485d17`，新测试 `755d24704082cd7c9963bb00d2f490dc31bce804f7d0ccad13c5dedf5cca4e5b`。正式 RED 后第一版 64/66 的失败分别为内存 select 宿主缺 options 和真实卸载后 computed 缓存未失效；仅补宿主接口、将 disposed 改响应式并补失效断言，不删除原断言。原失败记录全部保留。

本地闭环记录 `.codex-staging/g2-v2-review-ui-verification-20260909-r1.json`，包含原始日志、输入与独立审查。真实 SFC 编译/渲染不等于浏览器完整 input/change/click 事件验收；主要以组件方法和状态驱动断言。范围是合法蓝图 DTO，不扩张既有 trim/500 字符合同。持久 seam 候选读取/完整段选择、同任务同 reservation 显式继续、v2 锁定/Facts 下游精度仍未完成。下一片沿现有任务、owner/source/CAS 和已保存原窗接入，不重新识别、不自动裁句，unknown 仍不得通过人审触发重试或结算。完整 G2 和产品目标保持 ACTIVE。

## 前序：G2.V2_REVIEW 后端消费链已本地双审收口（2026-09-09）

沿用户已批准的“完整保留识别段，冲突人工确认、不新增模型”继续实现。本片完成标准不是孤立校验器：合成且完整验证的长音频 v2 成功证据经过实际 AnalysisWindow、Fusion、Blueprint、Workflow 草稿创建/保存和 SourceDialogue 读取，原始亚毫秒时标、完整识别段原文与分窗人物身份仍可追溯；旧 v1 和视觉时间的整数限制保留。已验证 G2.SEAM_CANDIDATE 原证据 51 引用本轮复核无漂移。

职责与顺序：

- SourceAudio：复用既有聚合器独立重建持久 v2 成功证据，核对全部窗口、coverage、选段来源、全轨 transcript SHA 和顶层派生字段；不把 needs_review 候选当成功、不重算或改写 Worker 原始 JSON/不新增模型。
- AnalysisWindow/Fusion：仅通过 v2 重建校验后接受对应 ASR 小数时标和窗口 speaker。蓝图只引用实际聚合资产 manifest ID，原始 window request ref 仍只在原证据内，不能伪造窗口资产。
- Blueprint/SourceDialogue/Workflow：以服务端从 owner/source/文件 SHA 已验证资产建立的按 manifest ref 上下文保留对应对白精度；不得由客户端字段或 speaker 名字猜版本。保持视觉/镜头/场景整数校验、v1 小数拒绝、说话人未确认不可锁定。SourceDialogue 先载入验证资产再处理投影与修订；Workflow 在 owner/CAS 事务内建立上下文并创建/保存草稿，继承切镜审核也复用该上下文。
- Orchestrator：实际分析写入草稿时传递已有 storageRoot，不引入默认路径。测试须经过真实内部调用证明，不只测试手工传参。

- [x] 定向测试先覆盖真实成功消费、保存后重读、人物映射后小数来源仍成立；篡改窗口/coverage/来源/聚合 SHA、owner/source/文件 SHA、假 v2/v1 小数继续拒绝。所有原窗 JSON 字节不变；拒绝不能落新蓝图/版本/结算。50 项测试冻结 SHA `0613d2c76942495a916723f3cba2d74ecb43a0fa0bb4215abce175e56c1f6228`。
- [x] 根审测试与封闭环境启动器后正式 RED：50 项，15 pass、35 fail，native 1；source/guard/closure 均 true，零 skip/timeout。失败对应未实现的 v2 重建、可信上下文、精度与保存链路，非基础设施失败；确认后才由作者改七个产品文件。
- [x] GREEN 后回归旧 SourceDialogue、Fusion、AnalysisWindow、Blueprint/修订、任务绑定和聚合；按精确阶段追加功能锁历史；独立 SPEC 后不同 QUALITY。最终定向 57/57；相邻 SourceDialogue 70、对白修订 58、边界修订 60、Fusion 12、AnalysisWindow 12、Blueprint 16、speaker 22、任务绑定 48、seam 31、aggregate 49、功能锁 59，分别全通过，不相加作去重覆盖。
- [x] 更新证据和下一步：前端完整精度/窗口人物映射、持久候选人审 API/同页选择、同任务显式继续仍需后续片完成；锁定物化/下游 Facts 未完成精度验证前，不声称 v2 已能生成交付。

本片审查历史：首轮实现 50/48/2，剩余两项是合成正例漏填既有必需 reviewer；仅各补缺 reviewer 拒绝断言及合成人审字段，未改产品审核规则，随后 50/50。独立 SPEC 发现客户端改 kind 为 subtitle、删除/替换 manifest 可抹去已保存 v2 来源并绕过 review-only；真实 save→lock RED 55/52/3 后修为按真实资产 metadata 识别版本、普通保存保留 current 可信 v2 来源，合法内部新分析仍可建 revision 2。不同 QUALITY 又发现多句修订重复重建全轨 context、review-only 误报 500；真实 RED 57/55/2 后，仅按 ref 做调用内缓存并改用既有 BLUEPRINT_ 业务错误分类，逐句绑定与零 Facts 写入不变。最终 57/57，独立 SPEC PASS→不同 QUALITY APPROVE，必要问题 0。

根收口 `.codex-staging/g2-v2-review-verification-20260909-r1.json`：最终十二套 native 0、无 skip/cancel/todo/timeout；定向 source/guard/closure true，550 项定向输入复算零漂移。11 个具名运行（10 个不同 PID，含一次系统 PID 复用）均已退出；功能锁原生完成且 activities_remaining 为空。HEAD 仍 `8c49a90773a4311992e4eb9b6a5bc2c9acdfa4ed`，以未提交工作树来源 SHA 为准，不引用旧 CI。总目标 ACTIVE，完整 G2 尚未完成。

下一片只读定位已完成，尚未实施：`redrawBlueprintReviewState.js` 的完整对白范围和窗口 speaker 校验、`RedrawBlueprintReviewPanel.vue` 的 `toFixed(3)`/三位秒数编辑会拒绝或舍入 v2。应从 record 中唯一已保存 dialogue ID 对应的 resolved source DTO、源身份和 manifest 绑定取得精度上下文，再用于当前草稿的编辑/迁移/映射；不能凭草稿 flag、名字前缀或小数值猜版本，也不能把 schema 塞进严格七字段 `source_correction`。原句/投影无损显示和编辑与镜头整数切点分离；沿四套既有对白源/修订/人物/切镜 Vue runtime 测试补反例，使用受审本地入口。未知状态、未确认 seam 与当前 v2 lock/Facts 阻断继续保持。

执行边界：沿已存在隔离 worktree，仅本地合成数据/隔离 SQLite 与受审测试入口；不读取 Key/.env/默认数据库/默认配置、不真实 Worker/供应商/付费、不联网安装、不 commit/push/CI、不生产/SSH/shared/部署。普通 Node guard 不是文件系统沙箱。作者拥有本片产品与新测试；根拥有启动器、功能锁、文档。不重新创建工作树，不删除旧证据。

## 当前：G2.SEAM_CANDIDATE 已本地双审收口（2026-09-09）

已采用用户选择：完整保留识别段，接缝冲突交人工确认；不新增语音模型。静态复核发现当前冲突诊断仅在内存，且普通 `startAnalysis` 会将它作为失败退款。先修复这个数据丢失点，随后接 v2 消费者与同页审核/显式继续；本片完成不能等同于人审恢复或 G2 完成。

- [x] RED：真实隔离 SQLite、Orchestrator、SourceAudio 与聚合器，使用合成 35 分钟 PCM 和两窗原始回执产生接缝/语言冲突。验证完整原文、原始亚毫秒时标、窗口 JSON、源 SHA、真实 async task 绑定、候选整体 SHA；零 Native/Fusion/成功资产/蓝图，原 reservation 保持 held。
- [x] GREEN：仅两个既有服务及一份新定向测试。聚合错误携带非成功 `redraw-source-audio-seam-candidate-v1` 诊断（整轨 SHA/时长、reason、全部原窗）；SourceAudio 在任务/源绑定复核后补源快照身份。Orchestrator 在真实当前任务事务中保存 `async_tasks.result.source_audio_seam_review`，绑定实际 `analysis_task_id` 并计算完整候选 SHA，task/work 置 `needs_attention`，`completed_at=NULL`；不创建新 schema 表、成功资产或伪 blueprint。
- [x] 守卫反例：缺失或错误的诊断/owner/source/schema/hash不登记人审候选；取消、替换、事务内失效不覆盖任何任务或结算；重复开始仍拒绝。普通失败退款、真实未知 held 的旧分支不变，未知不能借人审入口恢复。
- [x] 根审测试与隔离启动器后 RED/GREEN、任务绑定/聚合/兼容回归、功能锁精确追加，独立 SPEC PASS→不同 QUALITY APPROVE（两产品与新测试，问题 0）。全部仅本地，不读默认库/Key/配置，不运行真实 Worker/供应商，不付费、联网、安装、commit/push/CI 或生产操作。

候选不是成功证据；任何选段/源读取 API 后续仍须重新验证完整候选 SHA、owner/source/task/CAS，并保持无默认选项。确认只选择完整来源段，未确认或不可解冲突不能生成；确认后的显式继续复用同一任务、同一 reservation 和原始回执，不重做 ASR。此连接仍开放，不能以本片持久化取代。

当前内部交接细化：SourceAudio 仅为已经完成全窗/全轨验证并再次复核源快照的真实错误保留 WeakMap 条目（完整深拷贝诊断与既有源 CAS 闭包）。Orchestrator 的候选读取器在当前事务内核对原错误/完整诊断及实际绑定，再复核同一源 CAS；拒绝伪造相同 code 或篡改后的诊断。该 WeakMap 只服务当前内部异常链，随错误回收，不是跨请求人审的信任凭据；持久 JSON 后续必须独立核验，不因内存登记直接消费成功。

下游补图已确认：SourceDialogue、Fusion、AnalysisWindow，以及 Blueprint 的特定对白/修订时间与前端原句状态仍限制整数或旧 speaker。v2 兼容不得全局放宽镜头/视觉 timestamp，不得仅凭 speaker 前缀猜版本，也不得把音频 v2 改成蓝图 v2；应由已验证聚合资产的上下文放开对应来源精度，保留 v1 小数拒绝反例。Native 输入提示本身已保留原始时间/ID，不再重改它。此为下一片约束，当前不宣称已实施。

最终本地验证：根正式 RED 27/18/9，9 个失败分别为候选 schema/缺少持久化/最终源复核缺口；GREEN 31/31（原 27 断言保留，新增 4 个已发出候选的事务内/前源 owner/SHA 控制）。相邻任务绑定 48/48、聚合 49/49、旧 SourceAudio 37 pass/0 fail/1 个既有 POSIX skip、当前代码功能锁 58/58，均 native 0、无 timeout/验证输入漂移；计数不累加作去重覆盖。定向 source/guard/closure true，550 项输入引用根复核零漂移，四个已知测试 PID 已退出。`g2_seam_candidate_spec` SPEC PASS 后由不同的 `g2_seam_candidate_quality` QUALITY APPROVE，代码问题 0；审查者只读已存在机器回执，没有自行运行测试。根收口 `.codex-staging/g2-seam-candidate-verification-20260909-r1.json`，总目标 ACTIVE。

## 前序：G2.TASK_BINDING 已本地收口（2026-09-09）

沿下文已批准的真实任务/取消复核目标实施，不新增业务决策。成功标准：取消、换任务或 owner/源绑定失效后，迟到结果不能登记新的成功音频/视觉资产、蓝图、版本、事件或结算新作品；已经合法登记的前阶段资产与已有供应商回执保留。不承诺强杀已开始的请求，旧 held 不自动退款/扣款，不新增 schema、取消平台、模型或供应商合同。

- [x] RED：真实隔离 SQLite 创建分析任务，以 deferred 音频/视觉/融合返回复现取消、task 替换、owner/源变化和删除后的迟到成功/失败/unknown；断言新 work/task/reservation 不变。短轨、无轨、长轨下一窗口、最终事务失效均纳入对应服务测试。
- [x] GREEN：仅修改 `redrawOrchestrator.js`、`redrawSourceAudioEvidenceService.js`、`redrawNativeSourceAnalysisService.js`。Orchestrator 从真实创建事务构造只读同步任务守卫，server ctx 覆盖同名输入；绑定 work/task/owner/source/model/reservation，排除正常 progress/updated_at；服务实际身份参数必须匹配该守卫。SourceAudio 内部 UUID、四字段请求与单窗 v1 保持。
- [x] 所有异步阶段返回后、下一次 Worker/视觉前和现有最终写入事务内复核；Native 已收到的回执先保存，再拒绝迟到成功。专属失效错误不得被转换为供应商失败/unknown，也不得进入旧 markFailure/markNeedsAttention 改写新任务；当前有效任务的原计费合同不变。
- [x] 根亲读隔离入口和测试后执行 RED/GREEN、相邻回归及精确来源 SHA；只追加本片命中功能锁历史。独立 SPEC PASS 后由不同代理审 QUALITY APPROVE，P1/P2=0。此前发现的 direct-start 错误结算事务缺口经独立 RED→GREEN 关闭，未扩改旧 polling。

作者独占三个产品文件及其定向测试；根负责启动器、功能锁与两份主线文档。现有工作树与所有历史失败证据保留。固定边界：零真实 Worker/供应商/付费/Key/生产/网络/安装/Git 写入，不部署；合成媒体和底层 doubles 不作为真实识别质量证明。本片不提前宣称 seam 持久化、人审恢复、v2 消费者或完整 G2 已完成。

规格澄清：创建事务的 owner/source 复核针对当前 work 的 owner、source_asset_id/source_fingerprint 与请求及既有读取快照，在 reserve 前拒绝绑定失效；不新增或复制源文件预检器。实际资产存在、类别、owner、文件与哈希仍由既有 SourceAudio 流程校验，其发生于 reserve 后的原时序不作为本片新增完成项。长轨有效控制只证明 v2 producer 成功及后续取消阻断，不以未兼容的 Fusion 消费者冒充完整长轨分析成功。

最终本地证据：原 RED 36/2/34→增强控制 GREEN 44/44；规格审查发现 direct-start 错误结算缺口，再 RED 48/46/2→最终 GREEN 48/48。相邻聚合 49/49、SourceAudio 37 pass/0 fail/1 个既有 POSIX skip、一小时合成源真实 PCM 三窗 1/1（实际 FFmpeg 1 次，Worker 合成）；功能锁 57/57。最终各套 native 0，定向套 source/guard/closure true、无 skip/timeout；550 项定向输入引用收口时根复算零漂移，7 个已知验证/媒体 PID 已退出。计数不累加作去重覆盖。精确本片 diff-check 0；全树检查仍有既有 `ttsService.js` CRLF 尾空白报告，未修改或忽略为通过。

根收口记录：`.codex-staging/g2-task-binding-verification-20260909-r1.json`。仅关闭任务绑定子包，不代表完整 G2、裸 npm test/Hosted CI、真实识别或产品交付；HEAD 仍为 `8c49a90773a4311992e4eb9b6a5bc2c9acdfa4ed`，以未提交工作树的精确来源 SHA 为准，不借旧 CI。下一片按已批准顺序：持久化所属任务的非成功接缝冲突候选，兼容 v2 来源/时间精度，接现有母本对白审核与人工确认后继续。总目标保持 ACTIVE；不重新索要已确认的“完整保留识别段、冲突人工确认”选择。

2026-09-09 G2.PCM_WINDOWS 已本地双审收口：产品 SHA `9b9e4a3038ba9806531d3cf181246eda29d5d536f087dfbd419de2e176ab8e55`；作者与根聚合分别 49/49，兼容分别 37 pass/0 fail/1 个既有 POSIX skip，根最终八个真实 PCM 案例分别 1/1，功能锁 56/56，全部 native 0。八例包含一小时实际抽轨三窗成功和七个到达指定窗口的失败/unknown/哈希/4097 上限/源 CAS 负例；每例只有一次实际 FFmpeg，Worker 是合成替身，不代表 ASR 内容质量。负例零成功登记，实际 SQLite deferred-FK COMMIT 失败后当前任务 JSON 清理、兄弟文件保留已通过。独立 SPEC PASS→不同 QUALITY APPROVE；12 个最终验证 PID 已退出，选定来源和原素材无漂移。根收口 `.codex-staging/g2-pcm-windows-verification-20260909-r1.json` SHA `a28fac0deac1e0e59b14f5b0f5a92b558aaf3b815a2f9080c7656f4002f7b564`，253 项引用复算零漂移。只关闭本地 producer 子包，完整 G2 与整个产品目标继续 ACTIVE；零真实 Worker/供应商/付费/Key/生产/Git 写入、未部署。

本片保留的 RED：原始聚合 43/0/43 是同一个缺少导出入口；实际一小时整轨 115200078 字节超 Worker 限制。第一版后新增聚合 RED 49/46/3、实际第二窗 client INVALID 分类 RED 1/0/1、current Evidence RED 38/36/1 加唯一 POSIX skip（抵达真实 COMMIT 回滚后残留 JSON）；四修均经 GREEN。另经已审 loader 在内存重放 LF 规范旧源码，对十个坏长 WAV header 取得拒绝缺口证据；该回放发生在实现后，不是原字节备份或先于实现的 TDD，旧版 COMMIT 测试提前失败不计为真正 COMMIT RED。原始日志全部保留，各套件及重复运行计数不累加为去重覆盖。

下一片固定依赖：先沿 Orchestrator 的服务器真实 async_task 接入 SourceAudio/Native await 及最终写入前的任务绑定和取消/替换复核，失效不允许旧任务覆写新作品或改变既有 held 策略；随后持久化所属任务的非成功 seam 诊断，兼容 SourceDialogue/EvidenceFusion/AnalysisWindow 的 v2 原始绑定和时间精度，再接现有母本对白修订→保存→锁定/恢复。现审核页依赖已有蓝图与可解析音频资产，不能把内存 error.diagnostic 当作已经接好的人审。仅做本地主线 TDD，不新增模型或通用审批平台；下列前序时点均为历史。

本片技术具体化：保留旧整轨抽取命令一次，长轨用受限 RIFF fmt/data 解析和有界 PCM 流复制（规范 44 字节 header），不额外编解码、FFprobe 或新增模型；每窗实际文件仍小于 64 MiB。短轨 v1 入口和已有校验原样保留，仅长轨解析严格样本合同。PCM 末尾以样本数/16 保留 1/16 ms 精度；v2 段/binding 从原 Worker 秒值平移，允许亚毫秒，原文不 trim；trim 与 Math.round 仅用于核对原 DTO，不能反向重建来源。纯聚合入口为同服务的 aggregateSourceAudioWindows；成功窗保存 raw_source_evidence；内容冲突 SOURCE_AUDIO_SEAM_REVIEW_REQUIRED 携带非成功 error.diagnostic，不冒称持久化或人工恢复已接好。双向唯一配对且两代表逻辑归属相同才按较早物理索引选完整代表，逻辑 commit 仍独立半开计算；不同归属/缺失匹配不自动择近。真实 async task/cancel 绑定、消费者、诊断持久化与人工续行仍是后继欠项，不得省略后称完整 G2。

2026-09-09 当前收口：G3 双作品默认分析/无音轨修复子包已本地通过。普通登录和默认租户、ZIP 两项、显式第二项有轨分析、第一项无轨分析、重复上传/GET、跨用户 404 均在新隔离 HTTP `npedz9` 完整通过（native 0、1/1），终态 2 作品/2 任务/2 待审蓝图、Worker 1/Vision 2、quick_check=ok、零活动子进程。29 条媒体命令中 28 条 native 0，无轨抽 WAV 一条为预期非零 4294967274 并由既有无轨分支处理；不称所有媒体命令成功。Blueprint RED 16/14/2→作者与根 16/16，Fusion 作者与根 12/12，功能锁 54/54，均无跳过；独立 `g3_no_audio_spec` SPEC PASS→另一 `g3_no_audio_quality` APPROVE。仅修严格三字段全 null 与无轨 spoken 矛盾，其余 18 项选定产品输入未变。收口 `.codex-staging/g3-multi-input-no-audio-verification-20260909-r1.json` SHA `be4b644c0d0129dfd3c425b4f3565c2e81b42f2abb75ab6d837f6dfd43da4835`，60 项引用收口时根复算零漂移。之前 `CR97vG` 的真实无轨 500 和所有失败入口/fixture 原日志保留。该结论不是裸 npm test/Hosted CI、真实识别质量或完整 G3/产品交付。

当前 G2 客户端原回执保留子包已本地双审收口：仅 `preserveSourceEvidence === true` 在既有校验全部通过后，以 `structuredClone(response.result)` 返回 `rawSourceEvidence`，保留解析后 JSON 的秒级时间、原文本与原声明 SHA；默认 DTO、四字段 wire 请求、单窗 v1、旧类型兼容及 unknown 不重试不变。不声称保留原 wire 字节、重验 Worker 声明 SHA或已支持长视频。初始 RED `irdQnx` 为 28/26/2；初次 28/28 后质量审查发现嵌套数组别名，已补正式 RED `FIaSJ8` 29/28/1 并修复。最终作者 `mnpQkv` 与根 `7UJHwX` 分别 29/29、native 0、零跳过/超时，独立规格复审 SPEC PASS→质量复审 APPROVE。功能锁登记 55/55；全部仅合成字节与任务自有 named pipe，不是真实 Worker。根收口 `.codex-staging/g2-raw-source-evidence-verification-20260909-r1.json` SHA `926a2e9007d2967495f1241a968e158027594f506e7b4b088babf9257e7d1128`，36 项引用收口时复算零漂移。下一步按已批准规则接有界 PCM 分窗、严格聚合及人工冲突确认/恢复；完整 G2 和产品目标仍未完成。

G6 常规测试接入仍有明确欠项：`backend-node/test/redrawMultiInputProductAnalysisHttp.test.js` 依赖专用启动器设置的 `__g3MultiInputHttpGuard`，而当前 npm test 会收集此文件；裸入口会主动拒绝，不能据专用入口 1/1 声称常规测试或 CI 可通过。提交/推送/Hosted CI 前须完成可审计的隔离入口集成或分类，不能靠取消 guard、跳过后称通过来掩盖。本次未运行裸入口，也未调整 CI。

测试入口历史：r2 的快照失败已用原生探针确认是 Node Permission Model 禁止 fsync，不是时间戳或产品快照缺陷（报告 SHA `0141302514e8d094af2ba0805db91453ce490b31a374bc645ec272a403ccf365`）。r3/r4 桥接探针失败后均保留并弃用，未运行完整 HTTP。最终 r5 经独立规格/质量审查，沿既有隔离测试方式使用普通 Node、封闭合成环境、默认配置/DB 与外网入口拒绝；不是 OS/Node 文件系统沙箱。此前两个 r5 失败分别是 fixture 文件名误作事实文本、reversals 空数组，已仅修测试替身。原失败目录均不复用；最终当前 RED 才是无轨产品缺口。全部仅本地合成素材与最低层 ASR/视觉 doubles，不代表真实识别/生成质量或产品交付。

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

最新执行点（2026-09-09，本地）：G5.4 已本地双审收口，作者修复后 13/13、根最终 22/22；根旧 Composition 26/26、Export/直接路由 19/19、Release 19/19，全部 native 0。收口 `g5-unit-composition-verification-20260909-r1.json` SHA `bd330dd207e6d5574e139d7a399bf1695cf6a92f3be4aafe64d73e9daef26c0f`，60 项源码/运行/原始日志引用复算零漂移；开始 G5.5a 实际 HTTP 四文件读取，不提前关闭整个 G5。G3 多作品入口 32 引用双审收口不变，renderer 不当浏览器验收；现成浏览器夹具有假 token/注入 owner，实际 JWT 与普通 SPA 仍需连接。G2 仅六项结构失败测试草案，旧超限前置未解除，不重复计六类 RED；完整句语义的待确认操作定义不擅改。继续唯一计划与 ACTIVE 目标，零供应商/付费/生产/Git 写入；下面旧时点均为历史。

G3 多作品入口续行登记（2026-09-08）：正式后端 RED 为 12/0/12、native 1，11 项缺少列表 handler、1 项缺少 GET 注册；根亲读完整 receipt 与 TAP 终态，无基础设施失败或跳过。新增前端 19 项 renderer 草案已全文审读，等待固定隔离入口后 RED。按当前四个产品路径精确匹配，仅为 admin-provider-observability、proactive-canary-and-public-evidence、coverage-registration-http-route、product-media-http-chain、episode-blueprint-first 五锁追加此次只读列表/显式选择/路由访问隔离授权，旧 unlock 全量入 history，不改 acceptance/protectedPaths/requiredTests/evidence 或 auditor。新反向测试恢复登记前整份 canonical SHA `4379ca92bfee3b8b7457844fcdd3b24dceba5431767def7542950de28d451c5d`；登记 RED 46/6/40 后 GREEN 46/46、native 0、选定输入无漂移，原始日志保留。登记不代表作品功能已实现或浏览器已验；本地 SPEC/QUALITY 另审，产品作者仍按已审草案 TDD。

> **面向 AI 代理的工作者：** 使用 `executing-plans` 按本文顺序执行；独立本地子任务可由子代理协作，主代理统一审查。只有退出条件有证据时才能勾选。本文是唯一主线计划，不新增平行计划或通用审批/执行平台。

**目标：** 完整开发通用一键转绘功能，使任意用户在产品明确支持的范围内，从空项目上传自己的新视频，完成事实纠错、本地化、素材准备、生成、质量审核、合成与下载；不需编辑 JSON、寻找内部资产 ID 或运行整集 CLI。

续行执行状态：G6 默认租户入口已本地双审收口（`g6-default-tenant-verification-20260908-r1.json`，SHA `485ee7ee5443381e1fcf2d0d8b18cb491eee91a2585146f5cf3e7bf40ad76f1c`）。G5.3 只读 unit release 作者与根各 10/10、旧 v1 19/19，非作者 SPEC PASS→QUALITY APPROVE；新收口 `g5-unit-release-verification-20260908-r1.json` SHA `86d863b129135cea087d4045ff99a153920b2af8ba34dbe456c96cb05d029e41`，48 项源码/入口/日志引用根复核零漂移。旧失联验证不计通过，r2 实时日志补齐后取得实际终态。当前进入 G5.4 合成/四文件下载连接和 G3 多作品入口；两者仅本地，未接完 HTTP/UI、非英语/RTL 正向及最终听看验收仍开放，不关闭整个 G5/G6。

**当前执行点（2026-09-08）：G5.2 单元合成核心与 G3 页面访问隔离均已本地双审收口，进入 G5.3 只读发布清单及 G6 首次登录入口。** G5.2 核心 9/9，根相邻旧合成 26/26、HTTP 31/31、运行链 216/216、参考素材 65/65，分别 native 0、无 skip/cancel/todo/timeout/输入漂移。两位非作者依次 SPEC PASS、QUALITY APPROVE；根收口 `.codex-staging/g5-unit-assembly-core-verification-20260908-r1.json` SHA `516d244488130e79e914fb480fecc7a96dcbf741bbbe5ae9cb0420a8eaab1bc0`，24 项引用复算零漂移。只完成真实本地合成核心，不代表外层发布、最终人审或下载已接通。

G3 新测试实际 RED 28 项中 14 失败，最小两 SFC 修复后作者 28/28、原 Source 24/24、Parent 56/56，根独立 28/28，均 native 0；非作者 SPEC PASS 后 QUALITY APPROVE，功能登记也分别补审通过。收口 `.codex-staging/g3-workspace-mutation-verification-20260908-r1.json` SHA `ae8ac57889a771ec4606a15d297004abe7b59dd786c3d3ac6cf406b4fccf74ef`，28 项引用复算零漂移。该子包收口时的六 SFC 集合为 `98eacd379d843b61abce586325f720e7b690db10d2068aa6d939c926391b083c`，下述 G4.8 六源 SHA 是变更前历史冻结，不再宣称其全部源与当前字节一致。仅关闭页面访问隔离子包；全产品目标继续 active，零供应商、付费、Git 写入及生产操作。

**前序 G4.8 本地收口（历史）：** Workspace→Source→Localization→Plan→Run 及 Materials 已接通；独立 SPEC PASS、QUALITY PASS（C0/I0/M0）。作者父链 56/56、候选 90/90、生命周期 114/114、原面板 12/12；根独立父链 56/56；相邻材料 11/11、计划 13/13、队列 15/15、源运行 24/24，均 native 0，无跳过、超时、源漂移或残留进程。各套件不相加作去重覆盖。

最终六源集合 SHA `3323bbf6d628439804e7eca16b21fea976a531a13f6d39663ba79bdb2b9c93c3`；作者冻结 `g4-run-ui-parent-20260908-r1-author-quality-fix-freeze.json` SHA `f73988beaaee65bdbe358177f216f13474e8a4bbdf357dc429b8e3003ad3d7ae`，根回读 58 引用、0 漂移。轻量收口 `.codex-staging/g4-run-ui-parent-verification-20260908-r1.json` SHA `c930b58ac5ec43f1f20e1a5f04c37669c0cc9bce04f640715722cb33589fb71d` 绑定 29 项当前源/入口/原始回执；旧 RED/GREEN 工件不改写。本地真实 Vue 内存 renderer 不等于浏览器播放、视频内容、当前 HEAD CI 或完整交付，G4 整体与 G1–G6 剩余条件仍开放。

**架构：** 复用现有上传资产、音频/视觉证据、蓝图、本地化、生产包、候选审核、发布与导出。按当前已验证模型能力动态生成执行计划，贯穿同一项目的源、版本、单元、候选和下载工件；只补连接与合同缺口，不重写生产引擎或数据库。

父链两项审查 P2 已闭合（2026-09-08）：Source 在同 scope 策略 ABA 后保留读取失败、在途失效要求显式刷新；Workspace 对 user/tenant 的 storage/focus/排队 ABA 推进既有 policy epoch、失效请求序号并拒绝迟到 project/events/save/lock。修复保持已挂载 Run、原持久 pending/unknown 槽及禁止自动 POST；未改全应用 auth、API、模型或新增 owner 框架。对应真实 RED 与最终 56 项测试、SPEC→QUALITY 回执已纳入新冻结与收口。相邻三份旧测试只修手工 Run 绑定及精确 blocked 表达式适配，未移除旧业务条件。

首次登录兼容约束：Login 仅保存 session，未选本地 tenant 并不等于未登录。Workspace 的身份变化比较允许合法 session 配合 null tenant 选择上下文，保留原项目读取，不写入或编造默认租户；Run 既有更严格执行身份门禁不在本次变更内。G6 普通首次登录/默认个人租户端到端必须单列验收，确认无需寻找内部 tenant ID 也能进入有效执行；当前带预设 tenant 的 renderer 不能替代这条证据，必要连接沿服务端实际所属租户，不用测试种入 localStorage 冒充产品能力。

生命周期收口边界：创建、暂停、解暂停、推进、核对的遗留 pending/unknown 只能由绑定充分的显式权威证据定向结清；真实活动请求防双击，原键/hash 留存，旧请求不重放，跨 owner 迟到结果只写原槽。未知不能通过刷新、超时或新确认盲解锁。后继媒体/人审沿既有公开接口实施，不重新立项或检查模型线路；仍无 commit/push/远程 CI、供应商/付费或生产权限。

候选包收口边界：媒体字节 SHA 与候选身份哈希分开校验，原生播放器在失效/卸载时停止并撤销 URL；动态人工检查默认未检查，技术检查或 auto 不代替听看。审核先持久化原意图，pending/unknown 不能因新候选哈希或改检查结果重复 POST；显式匹配 GET 只结原审核槽，不清生成未知、不自动推进。SPEC 后追加 19 项既有行为证据、产品不变，最终 90 项全绿并经 QUALITY 确认。全仓 `diff --check` 尚有既存 `ttsService.js` 的 CRLF/尾空白诊断，其 SHA 与本包前 480 来源快照一致；保留并记入 G6，不把本包通过写成全仓门禁全绿。

普通父链作者 `g48_parent_ui` 已冻结退出，根和独立双审完成交接。全新作者 `g5_unit_assembly` 接续 G5；正式 RED 后，作者与根分别取得首个真实本地两单元裁剪合成测试 GREEN（各 1/1，详见 G5.2）。当前补齐立体声、批准状态漂移及清理等反例，再做相邻回归与独立双审；不把单个正例当作 G5 完成。不改已收口前端、不读配置/Key/默认库、不调用供应商，主计划与总报告仍由根维护。

父链接线细化：素材面板也接收同一 `projectPolicy`，仅纳入已有同步失效和请求上下文，防止准备在途时策略 safe→auto→safe 后旧成功事件被重新接受。复用现有 sequence/current 与完整 GET/hash/CAS 检查，不修改材料 API 或增加默认策略；成功事件绑定发起时的 policy epoch 和素材作用域，父复核后只允许刷新 readiness。Source 与 Plan 的 loading/error/缺预览均须保留已挂载 Run，阻断交互并撤销旧确认，但不释放在途或结果未知的持久锁。正式测试必须通过真实组件驱动这些分支，不能以 stub 直接发成功事件代替素材复核。

**技术栈：** Vue 3、Express、隔离 SQLite、Node.js 测试、Playwright、Python 语言 Worker、FFmpeg/FFprobe、现有供应商客户端。

## 1. 基线、授权与已有局部成果

- 日期：2026-09-05；工作树：`C:/Users/canqu/Documents/茉莉妈妈2/worktrees/redraw-complete-main-merge-20260901`。
- 分支：`codex/redraw-speech-aware-normalization-20260904`；基线 HEAD：`8c49a90773a4311992e4eb9b6a5bc2c9acdfa4ed`；PR #217。
- 基线 HEAD 曾有四项 Hosted CI 成功；当前存在本轮未提交差异，旧 CI 不能覆盖这些差异。回归、审查及 CI 必须绑定最终实际 HEAD。
- 初始批次限任务 1—3；2026-09-06 用户要求六组全量推进后，当前范围以 G1—G6 统一清单为准，先执行全部可在本地完成的实现、回归和移交准备。不读取 Key，不访问供应商，不付费，不执行生产操作。commit、push、远程 CI 及真实生成仍按当轮明确授权执行，本文不新增外部操作授权。
- 已有用户母本、蓝图、素材、隔离包和历史输出只作为回归案例及证据；镜头数、单元数、台词、角色、语言、文件路径及首镜 ID 均不得成为通用产品常量或完成标准。
- 本轮 fallback 局部候选已包含首镜待审核、hash 绑定审核、续行防重与本地锁；该脚本仍有历史样本约束，尚未接入通用产品，也未完成后续逐单元质量放行。
- 本轮媒体局部候选为固定 Fumin480 档位补充 `480×864 + SAR 81:80 = DAR 9:16`，读取并交叉校验实际 SAR/DAR；这是无新增裁剪的本地媒体修复，不是通用尺寸规划，也不代表所有播放器/人物构图已验收。
- r25 原始状态保持 `needs_attention`，不改成成功/明确失败、不复用、不自动重试。已有对账未发现对应任务/消费，不等于正式零扣费证明；无新证据不重复调查。材料：`C:/Users/canqu/Documents/茉莉妈妈2/.codex-staging/pr217-r25-cn-readonly-reconcile-20260905/reconciliation.md`。
- 已核验的 ToAPIs `.cn` 不重新立项；不改线上模型目录。历史单集和线路规格仅约束对应回归案例，不能覆盖用户最新的通用产品目标。

## 2. 已有能力与必须补齐的通用缺口

2026-09-08 历史执行点（G4.7 入场时，当前进展以页首为准）：G4.5候选复核/人工审核与G4.6推进/显式解暂停/提交前中断恢复均已完成本地双审及根回归。当时累计`.codex-staging/g4-advance-resume-verification-20260908-r1.json` SHA `768570735981253587c93d8338065590fbe6fbd7f12d4842fb70867bcd0eed5a`，根独立回读178源/283工件/1父/2文档共464引用0漂移；作者focused216/216、compat141/141，根advance24/24、compat141/141各自native0，覆盖不相加。当时唯一作者进入G4.7普通鉴权HTTP、运行发现和受控候选媒体的静态入场，尚未取得新HTTP RED/GREEN；之后连接UI及合成导出。G1.3b、G3.1a、G5.1a和此前局部成果保持，旧证据不重写。G1人工观感、G2/G3其余/G4完整页面执行/G5其余/G6和全产品真实验收仍未完成；不以dirty字节测试代替当前HEAD的CI或真实视频验收。

### 2026-09-05 目标与剩余执行顺序

用户要求“规划好剩余任务设立目标 开始推进”，已在当前任务建立完整交付目标。目标只在任务 1—6 的退出条件全部有证据且用户接受后完成；不因某个局部回归通过提前收口。保留唯一计划与总报告，不创建平行任务书。以下 R 编号是剩余工作的执行批次，不替代主任务，也不是完成率。

| 批次 | 对应主任务、依赖 | 实际产出与验收条件 | 当前状态 |
|---|---|---|---|
| R1 | 任务 2；依赖已完成的计划审核 | 版本/计划绑定的持久化 N 单元队列，重复创建不重建、刷新读取准确、旧计划明确 stale、不可执行条件如实展示；旧 shot 队列不改写成 unit 队列。R1a 先登记/读取，R1b 的执行领取与结果状态随 R3 接入。 | R1a 已完成本地验证；R1b 待 R3 |
| R2 | 任务 1、2；执行前置 | 统一 MP4/MOV/ZIP、时长/尺寸/声音/语言支持合同及页面；补对白文本/时间/人物纠错、聚类拆分重映射；从当前源片制作动作参考，身份图可选择/上传/审核，无需内部资产 ID。验证 owner、可读媒体、源/目标/素材 hash 与修改失效。 | 纠错、身份上传、音频未知、动作草片/候选、普通动作上传及显式准备 A→B 同链已完成本地双审；自动遮除、长音轨与多输入合同未完成 |
| R3 | 任务 2；依赖 R1、R2 | 将单元领取、真实就绪检查、已有计费/供应商任务、结果工件和队列连接；首个候选必须待审、批准后续行，每单元 QA；明确失败和未知均按策略停止，重复点击/刷新/重启不新增提交，未知不能重新领取。仅低层供应商在本地测试中替换。 | 未完成 |
| R4 | 任务 2；依赖 R3 | 多单元按源时间映射归并父镜候选，复用 QA；原生音轨证据贯穿 release/composition/export，配音分支保持真实资产合同；保留完整对白、构图与时间线，实际 MP4/字幕/报告下载 hash 等于本次发布工件。 | 未完成 |
| R5 | 任务 3；依赖 R2—R4 | 不同镜头数/方向/语言、长镜/跨镜/画外/静默/背景音乐矩阵；至少一条真实前后端浏览器链由本次上传媒体走默认分析，不注入最终蓝图/成片；预演未知、第 N 单元失败、拒绝、恢复、合成失败与 owner 隔离。完整回归、Worker、构建和独立审查后，另按授权提交/推送，精确 HEAD Hosted CI 4/4。 | 未完成 |
| R6 | 任务 4；依赖 R5 + 当轮明确付费授权 | 普通用户页面创建多个独立新视频项目，按目标名字/对白/人物/动作/声音/画面文字逐项实际听看；记录参数、次数、费用和技术/内容结论。历史单镜和固定整集不能替代。 | 未进入 |
| R7 | 任务 5；依赖 R6 同批工件 | 同项目暂停/重开恢复、逐段合成、播放和下载实测；无漏镜/重复/断句/断音，下载 hash 闭合，不为验收重录重复生成。 | 未进入 |
| R8 | 任务 6；依赖 R7 | 移交确切本地版本、依赖/Worker 检查、支持范围、使用与纠错恢复说明、脱敏报告；用户用新视频完成并接受。上线不是本轮退出条件。 | 未进入 |

R1 选择理由：现有 `generateBatch`、`redraw_shot` task/resource/预算与候选审核均以父镜为单位，不能将多父镜 unit 伪装成 shot；也不新建通用审批或计费平台。新增轻量队列关联审核快照，保留旧生成/账态路径，等 R2 的真实素材和 R3 的单元适配就绪才允许调度。计划保存或队列登记均不是执行授权。

#### R1a：审核计划到持久队列登记与恢复读取

本轮只实现登记和读取，明确不声称已完成调度、首候选审核、停止恢复或计费。使用现有 linked worktree 和依赖；原 66 文件/2 文档/40 工件 SHA 已核验无漂移，review/preview 基线 111/111。本轮不读 Key、不请求供应商、不付费、不提交/推送/部署；上一批历史 receipt 保留原样，新增证据单独记录。

**文件责任：** 新增 `backend-node/migrations/75_redraw_execution_queues.sql`、`backend-node/src/services/redrawExecutionQueueService.js`、`backend-node/test/redrawExecutionQueue.test.js`；修改 `backend-node/src/routes/redraw.js`、`backend-node/src/routes/index.js`。`redrawExecutionPlanReviewService.js` 仅追加 `validateSavedPlan: validPlan` 导出以复用已审校验，不复制或改变原逻辑。页面连接修改 `frontweb/src/api/redraw.js`、`frontweb/src/components/redraw/RedrawExecutionPlanReviewPanel.vue` 和 `frontweb/e2e/redraw-workspace.spec.js`，新增 `frontweb/test/redrawExecutionQueue.test.js`；本批独立测试不放宽上一批“保存审核不触发执行”的断言。主代理负责计划/总报告/功能锁授权和前端，后端实现者只负责后端上述 6 个文件。

- [x] **先 RED。** 真实迁移/隔离 SQLite + 当前完整音频证据 fixture；调用以下实际产品 handler，初次必须因为缺表或缺 handler 失败，保留完整日志和退出码。覆盖未审核、被阻断、owner/软删、请求带额外字段、过期 hash、重复请求/新连接、上游漂移、记录/单元损坏、零其它表写入、零 Key 查询。

```js
// request body 必须且只能包含 expected_plan_hash；服务端从已保存有效快照取 unit。
handler.prepareExecutionQueue(request({ expected_plan_hash: plan.plan_hash }), response);
assert.equal(response.body.data.queue.status, 'waiting_readiness');
assert.equal(response.body.data.queue.executable, false);
assert.equal(response.body.data.queue.units.length, plan.units.length);
// 第二次同请求得到同一个 queue.id，所有 unit.id/时间与 plan 映射不变。
```

- [x] **最小 GREEN。** `POST /redraw/versions/:id/execution-queue` 事务内先 owner 校验，重算当前审核与 hash/CAS，仅有效 current 审核可登记；一条 queue 与完整有序 units 原子插入。唯一键 owner/version/plan_hash，unit 唯一键 queue_id/unit_id 和 queue_id/ordinal。同 hash 重复请求返回原记录、不更新时间；不同 hash 可建立独立未执行队列，旧记录保留。不得写 async task、video、候选、version/work、积分或预留。
- [x] **读取与损坏防护。** `GET /redraw/versions/:id/execution-queue` 纯读，返回 `{preview, saved_review, queue}`；当前 plan_hash 优先，否则只显示最近历史队列 stale（按追加 id，不用时钟）。读取时校验 queue/review 的 owner/work/version/hash 和全部单元 id/顺序/内容 hash；损坏返回 invalid 且不回显单元内容。POST 独立核验当前选中与按追加 ID 最新的队列，任一损坏即拒绝，不能因 A→B→A 命中健康 A 而掩盖最新 B 损坏；不扫描或改写全部历史。公开 queue.status 仅 `waiting_readiness/stale/invalid`；所有单元状态仅 `pending`，`executable:false`，原 execution_blockers 全部保留。初版队列及单元 UPDATE/DELETE 拒绝，未来领取状态迁移必须显式演进，不能暗开调度。
- [x] **页面 TDD。** 有效 current 审核后可显式“登记执行队列（不生成）”；保存审核不会自动登记。展示待就绪单元数、源范围/父镜映射、实际阻断和队列状态，刷新可读回；版本/草稿/读取失败撤销当前可操作状态，迟到响应不污染新版本，409 或未知保存不自动重试。浏览器只发送 expected_plan_hash，不传计划/Key/模型/路径/是否就绪。
- [x] **审查与验证。** 后端聚焦、前端真实组件、既有 review 守卫、功能锁与构建；规格审查后质量审查。精确实际文件 SHA、命令退出码、失败和通过日志进入本批证据，总报告明确浏览器真实 DB 联调、执行器、停止恢复和真实素材仍未验收。只按本轮真实授权追加触及的本地功能锁历史，不改保护范围/证据/必跑测试。

聚焦命令（cwd 为工作树根目录）：

```powershell
node --test --test-reporter=tap --test-concurrency=1 backend-node/test/redrawExecutionQueue.test.js backend-node/test/redrawExecutionPlanReview.test.js backend-node/test/redrawExecutionPlanPreview.test.js
node --test --test-reporter=tap frontweb/test/redrawExecutionQueue.test.js frontweb/test/redrawExecutionPlanReview.test.js
node --test --test-reporter=tap backend-node/test/featureLockManifest.test.js
npm --prefix frontweb run build
git -c core.safecrlf=false diff --check
```

R1a 退出条件：当前审核计划可通过产品 API/界面建立并恢复同一份待就绪队列，防重/owner/过期/损坏/零执行边界有真实测试证据。R1 整体仍要在 R3 完成领取、逐单元结果及停止恢复后才能完成；本轮不把 pending 队列冒充可生成产品。

R1a 最终验证：相关后端 761 pass/1 环境 skip/0 fail；前端 1047/1047；严格 fixture 工作台浏览器 30/30；构建、功能锁和独立规格/质量审查通过。后端最新损坏历史和前端 blocked 时历史队列恢复均有 RED→GREEN。机器记录为工作树 `.codex-staging/execution-queue-20260905-verification.json`，详细范围及未验证项见唯一总报告；任务 1—6 和 R1b 不因此勾选。

公开队列固定为 `{id, work_id, version_id, plan_hash, status, executable:false, created_at, units, execution_blockers}`；正常单元为 `{id, ordinal, status:'pending', unit_hash, plan_unit}`，`plan_unit` 是完整原计划单元，不是单一父镜候选。invalid 返回 `plan_hash:null/created_at:null/units:[]`，保留当前 owner 的 work/version，不回显损坏内容。初版只保存计划事实，R3 应另设运行/尝试状态关联该不可变队列，避免原地更改已审事实。

#### R2—R4 实施前已核实的连接约束

#### R2a：逐句／选定子集角色纠错及安全保存

2026-09-05 目标续行：前批 70 文件、2 文档、34 工件 SHA 无漂移；基线蓝图工具＋整句审核 23/23。沿用户已批准的通用纠错设计继续本地实现，不另起规划或重新索要已批准的开发方向。此步使错误聚类可拆开、已映射说话人可纠正；原句文本／时间修改仍要在 R2 后续建立原证据与人工修订的明确关联，不能将任意改文直接当 ASR 验证成功。

**复用与边界：** 现有 `mapVoiceClusterToCharacter` 会整组映射并直接 approved，不能用于逐句纠错。新增小型纯函数复用现有数据检查及克隆，不修改旧全组 API；只改变选中对白的 `speaker_id/speaker_kind/off_screen/review_status`，撤销整体 review。原 dialogue ID、文字、语言、起止时间、evidence refs、source/manifest 均原样，未选对白不变。现有 owner/CAS 的 `saveBlueprint` 和 `lockBlueprint` 是唯一写入路径；不新建表或改源证据、不生成/冻结。

**文件与责任：** 实现子代理负责 `frontweb/src/utils/redrawBlueprintReviewState.js`、新增 `frontweb/test/redrawSpeakerCorrection.test.js`、`frontweb/src/components/redraw/RedrawBlueprintReviewPanel.vue`、`frontweb/src/views/RedrawWorkspace.vue` 的蓝图回执 guard、`frontweb/e2e/redraw-workspace.spec.js` 的新增行为测试。主代理负责新增 `backend-node/test/redrawSpeakerCorrection.test.js` 的真实隔离 SQLite/源证据联测、功能锁本次授权与测试、本文及总报告。后端现有 service/route/schema 不因新增 UI 而改写；若联测发现实际缺陷，先补 RED 再明确最小范围。

- [x] **纯函数 RED→GREEN。** `assignDialogueSpeakers(blueprint, dialogueIds, {character_id, off_screen})` 接受非空唯一的现有对白 ID 子集与已有角色、严格布尔画外状态；画内角色必须在全部目标镜头的 visible 列表，不能自动伪造可见人。`createOffScreenCharacterForDialogues(blueprint, dialogueIds, {name})` 只要求用户姓名，内部生成未占用稳定 ID，角色和选中对白均 needs_review；不依赖固定样片名字。两者均拒绝缺失／重复／危险 ID、继承数据、未知角色、空名；错误原子拒绝，输入不变；成功时 source/text/time/refs 不变、选中对白及整体审核失效、未选对白完全不变。

```js
const revised = assignDialogueSpeakers(blueprint, ['line-a'], {character_id:'role-b', off_screen:true});
assert.equal(revised.shots[0].dialogue[0].review_status, 'needs_review');
assert.equal(revised.review.status, 'needs_review');
assert.equal(revised.shots[1].dialogue[0].speaker_id, blueprint.shots[1].dialogue[0].speaker_id);
```

- [x] **页面 RED→GREEN。** 在现有逐句原声与对白列表选择一句或多句（包括已映射项），选择角色及画内／画外，或只填姓名新增画外角色；应用后必须重审，不能自动保存或锁定。保留原来的全组映射入口及全部旧测试；清空选择后不留隐藏操作。跨镜头加载更多仍保留明确选择数量；切工作／修订、卸载、冲突或 locked 清空操作状态。
- [x] **保存竞态 RED→GREEN。** 修复原 `saveDraft` await 后覆盖新工作及继续旧工作 lock 的缺口。增加精确工作／记录与请求 epoch 检查、卸载失效、防重；迟到成功或错误不能同步／emit／触发下一次 lock。面板锁定成功经 SourceStep 的 updated 链上报，`RedrawWorkspace.onBlueprintUpdated` 只接受当前工作回执，不添加未使用的第二个 handler。409 保留编辑并要求刷新，失败不自动重试，不清空新草稿；同作品非身份进度刷新不能丢失本地编辑，无效新修订不能继续编辑旧记录。
- [x] **真实数据联测。** 使用纯函数产出的实际 payload 经现有保存／读取／批准／锁定服务，验证修订 hash 变化、源 ASR 文件及资产 hash 原样、源解析仍 resolved、未重审不得锁定、批准后持久化说话人正确；包含异 owner、CAS 过期、锁定后不可改、原文篡改仍 unresolved，以及零新增视频/异步任务/积分预留。
- [x] **验证与审查。** 先新增行为 RED，再实现；前端真实组件＋严格浏览器 fixture、真实 DB 联测、蓝图／源证据／本地化／队列相邻回归、构建与功能锁。规格审查后质量审查；日志和精确差异进入新证据，不改 R1a receipt，不声称真实推理、人物一致性或整套 R2 已通过。

命令（工作树根）：`node --test frontweb/test/redrawSpeakerCorrection.test.js frontweb/src/utils/redrawBlueprintReviewState.test.mjs frontweb/test/redrawDialogueSourceReview.test.js`；`node --test --test-reporter=tap --test-concurrency=1 backend-node/test/redrawSpeakerCorrection.test.js backend-node/test/redrawBlueprintWorkflow.test.js backend-node/test/redrawSourceDialogue.test.js backend-node/test/redrawExecutionQueue.test.js backend-node/test/featureLockManifest.test.js`；完整前端/工作台/构建沿任务 3 原命令。源码冻结后逐文件回读；无 commit/push/Hosted CI、Key、供应商、生产/部署操作。

R2a 退出后继续 R2 的文本／完整时间修订、镜头纠正和普通身份／动作素材连接，不将角色选择 UI 代替事实纠错全部完成。素材定位已纠正旧假设：导入服务中的 candidate 是待审导入资产，并非必然要求先生成视频；后续以实际 owner/CAS/hash 导入接口为准。

R2a 本地退出证据：独立规格 PASS、质量 APPROVE；前端聚焦 57/57、默认全量加蓝图工具 1081/1081、后端九文件 306/306、最终工作台 34/34（主代理再次独立完整运行，2.3 分钟），构建和功能锁均 exit 0。原旧 800 ms 读取测试的时钟失败已用 trace 定位，改为显式 GET 门闩后保留全部零报价断言；全部中间失败保留。机器回执 `.codex-staging/r2-speaker-correction-20260905-verification.json` 绑定 72 文件/2 文档与当前日志，完整目标仍 active。

#### R2b：对白文本／完整时间人工修订及原证据回查

沿已批准蓝图审核器的文字和时间修正范围实施；不新增平行设计或重新授权历史付费。R2a 的 72 文件、2 文档、62 工件已逐项复核无漂移。原始 ASR 文件、资产元数据和 SHA 不可改，修订与原始识别必须可同时查看；不能删除严格原声校验来开放编辑。

**最小合同：** 可选 `dialogue.source_correction` 只含下列七个字段。原 `dialogue.id/source_language/evidence_refs` 不改；`source_text` 表示人工修订稿，`start_ms/end_ms` 为修订完整时间与所属镜头相交的投影。原始完整文本／时间必须由现有 resolver 从当前 owner 的原 ASR 文件逐项核验，不能信任浏览器提供的原文副本。完整时间必须是源时长内的安全整数毫秒、首尾递增且与当前镜头相交；仅改文字时也保留完整时间，不从镜内投影反推整句。

```js
turn.source_correction = {
  evidence_ref: original.evidence_ref,
  evidence_sha256: original.evidence_sha256,
  original_source_text: original.source_text,
  original_start_ms: original.source_start_ms,
  original_end_ms: original.source_end_ms,
  source_start_ms: correctedStartMs,
  source_end_ms: correctedEndMs,
};
turn.source_text = correctedText;
turn.start_ms = Math.max(correctedStartMs, shot.start_ms);
turn.end_ms = Math.min(correctedEndMs, shot.end_ms);
turn.review_status = 'needs_review';
blueprint.review = { status: 'needs_review' };
```

**输出语义：** 无修订的 resolver DTO 完全保持原合同；有修订且原证据／投影均有效时返回修订文本与完整时间，并明确 `source_origin: 'manual_correction'`、`original_source_text/original_start_ms/original_end_ms`。`resolved` 只表示证据关联和修订结构通过，不表示 ASR 自动识别出人工文本，也不表示用户已批准。后续本地化仍必须经蓝图逐项复审、锁定和现有哈希绑定，不能由草稿编辑触发生成。

**播放连接核查更正：** 真实 `routes/index.js`／`routes/redraw.js` 尚未注册 `/redraw/works/:id/source-video`；该路径目前只在前端严格测试夹具中提供。现工作详情返回的是静态源资产 URL，而审核播放器只接受上述 `/api/` 路径，不能声称真实母本已经可回放。R2b 后端修订合同终态后，页面接入前须补 owner/source hash 绑定的本地鉴权母本读取接口及真实路由测试，再复用播放器的整句 seek/stop；不把静态 URL 放入白名单绕过所有权校验。原生 video 标签不携带 Axios 的 Bearer，需复用现有鉴权 blob 与卸载／迟到响应释放模式。前端 DTO 还需比较整份 correction 与持久稿，完整时间改变但镜内投影相同也必须失效旧 resolved。

**文件责任及顺序：** 首个全新实现子代理只负责 `backend-node/src/services/redrawEpisodeBlueprintService.js` 的可选字段规范化、`redrawSourceDialogueService.js` 的严格原文回查／修订投影、`redrawBlueprintWorkflowService.js` 的有修订记录写前／锁前核验、`backend-node/src/routes/redraw.js` 的服务器 storageRoot 传递及安全错误映射，新增 `backend-node/test/redrawDialogueCorrection.test.js`。未修订旧蓝图的保存策略不扩大。主代理负责功能锁真实授权、本文／总报告和集成验证；后端终态后再派全新前端实现者，不并行修改同一来源。

真实工作流联测发现必要消费修复：`lockBlueprint` 正常将数据库记录锁定，JSON 审核状态保持 `approved`；执行预览却额外要求 JSON 状态为 `locked`，导致正常批准→锁定仍被 `BLUEPRINT_HASH_MISMATCH` 拒绝。已有预览夹具手工写入 locked JSON，未覆盖这一真实连接。允许本实现者额外最小修改 `redrawExecutionPlanPreviewService.js`：仍要求持久记录 locked、`assertBlueprintLockable` 通过及蓝图／记录／版本 hash 全部一致，移除与既有锁定服务矛盾的冗余 JSON 状态限制。新增普通及人工修订的实际工作流 RED→GREEN，draft／未审核／hash 漂移继续拒绝；不得为通过新测试伪造已锁 JSON 或降低其它门禁。

- [x] **后端 RED→GREEN。** 真实迁移／隔离 SQLite、原 ASR JSON，覆盖原文纠错与跨镜时间修订保存／读回／重审／锁定、原资产字节和非蓝图业务表不变；篡改原文锚点／语言／ID／证据 SHA／owner、未知字段／访问器／无效时间、错误投影、无 storageRoot、原文件漂移、CAS／locked 拒绝，重复同稿也先回查。缺少明确修订字段的原文或投影篡改继续 unresolved。create/save/lock 中只对存在修订的条目执行当前证据验证，任何无效修订均在写入前原子拒绝。
- [x] **下游证据联测。** 有效修订须进入现有本地化文本、整句发声窗口和动态计划；原始 ASR 同时可追溯。复核 V2 源投影／蓝图 hash 绑定，不为新字段放宽旧严格来源守卫或引入额外任务／计费。只有发现实际消费差距才最小修改对应服务，并补失败测试。
- [x] **页面 RED→GREEN。** 复用现有鉴权母本播放器和逐句完整时间定位，普通用户选择单句、编辑文本与完整起止秒数，显式应用到草稿。显示原始识别与人工修订对照，取消不改稿；重新编辑仍绑定同一原始证据，回到原文／原始时间可明确撤销修订。需保存／刷新才能得到新服务端源 DTO，不伪造服务器 resolved；修改后必须重新审核。保留 R2a 的跨版本／卸载／迟到请求／双击保护。
- [x] **审查与完整相关回归。** 新增测试先真实 RED，修复后后端相关回归、前端状态／SFC／工作台浏览器、功能锁、构建通过；独立规格再质量审查，记录新差异哈希和本批所有失败／成功日志。R2a receipt 保持原样，不提交／推送／调用供应商或生产操作。

后端入口：`node --test --test-reporter=tap --test-concurrency=1 backend-node/test/redrawDialogueCorrection.test.js backend-node/test/redrawSourceDialogue.test.js backend-node/test/redrawSourceDialogueGuards.test.js backend-node/test/redrawBlueprintWorkflow.test.js backend-node/test/redrawSpeakerCorrection.test.js`；后续加现有 localization／execution-plan 相关用例，前端沿本计划任务 3 的真实组件和浏览器命令。R2b 不代替后续镜头边界／场景／动作纠错及身份／动作素材普通入口。

R2b 后端子步退出证据：新增 54/54，主代理十二文件相关回归 588/588，既有前端纠错状态／组件／工具 57/57，均 0 fail/skip、exit 0；功能锁 26/26、`--base HEAD` 审计 ready=true、语法与 diff-check 通过。独立规格 PASS 后独立质量 APPROVE、0 问题；审查者分别独立执行 54+26 项，与主回归重叠不累加。机器回执 `.codex-staging/r2b-dialogue-backend-20260905-verification.json` 绑定当前 75 文件／2 文档；R2a receipt 和 62 工件原样保留。页面修订、真实母本鉴权回看、浏览器／构建／完整相关前端回归尚未补齐，故上方后两项及整套 R2b 不勾选。完整目标 active，不提交／推送／联网／付费／部署。

##### R2b 回放连接子步：当前 owner 母本的鉴权只读媒体

2026-09-05 续行前已逐项核验上一批 75 文件／2 文档／14 日志与 receipt 无漂移，继续使用现有 linked worktree 和依赖。此步落实前述已确定的鉴权回看连接，不改上传范围、原始文件或模型。直接放开静态 URL 会绕开 owner；给整个应用新增 cookie 鉴权或媒体票据会扩大范围；本步采用现有 Bearer API＋blob 播放模式。服务端以有界分块复制／校验的临时私有快照返回已核验字节，不将 1 GiB 视频整份读入 Node Buffer，不新增持久缓存或素材表。浏览器整份 blob 的加载／内存成本必须显示为待加载并在后续多输入回归中检验，不因选择这一模式宣称大文件体验已通过。

**责任文件：** 新增 `backend-node/src/services/redrawSourceVideoService.js` 和独立 `backend-node/test/redrawSourceVideo.test.js`；只在 `backend-node/src/routes/redraw.js` 加 handler 与安全错误映射、在 `backend-node/src/routes/index.js` 注册 GET。实现者不改现有 source-audio 服务，不调用其分析入口；按现有安全路径／snapshot 逻辑实现局部媒体读取。主代理负责功能锁追加授权与本文／总报告。后端双审终态后，再派新的页面实现者处理鉴权 blob、文字／完整时间编辑和旧 DTO 失效，不并行写同一文件。

独立规格反例补充：通用 `tenantContext` 会调用 `ensurePersonalTenant`，刚注册但未初始化租户的异用户即使 GET 返回 404，仍插入个人租户及成员各一条，违反本步零业务写入。不得靠预建测试租户或排除这两张表掩盖。只将本 GET 注册在原 `requireUser` 之后、通用租户初始化之前，局部 SELECT 当前 active tenant/member（请求头或既有 personal 默认），无权返回 404；后续服务 owner／CAS 仍保留。其它路由继续原中间件，不更改全局认证、租户初始化、静态权限或模型门禁。该最小修复仍限上述四文件，新增拒绝路径全库 SHA／total_changes 反例和旧路由初始化回归。

- [x] **真实 HTTP RED。** 独立迁移 SQLite、真实 register／Bearer／tenant 中间件和实际 router，调用下列 GET；先证明缺路由失败，再补合法 MP4／MOV 字节与 hash 检查。至少一项使用本地 FFmpeg 产生可解码视频，并对 HTTP 返回文件再次 FFprobe；不访问供应商。新测试不导入旧测试套件。

```js
const response = await fetch(`${base}/redraw/works/${workId}/source-video`
  + `?expected_source_asset_id=${sourceId}&expected_source_sha256=${sha256}`, {
  headers: { Authorization: `Bearer ${token}` },
});
assert.equal(response.status, 200);
assert.equal(response.headers.get('x-content-sha256'), sha256);
assert.equal(hash(Buffer.from(await response.arrayBuffer())), sha256);
```

- [x] **最小媒体 GREEN。** GET 必须且仅接受两个 expected 参数，work ID／asset ID 为正安全整数，SHA 为规范 64 位；先 owner 查询当前未删除 work，再比较请求 CAS。由 work 选择本地 `video/redraw_source` 资产，核验 metadata owner、work fingerprint、存在的资产 hash／size 绑定；旧上传可能未存 file_size，不因此拒绝真实旧稿。只允许 DB 本地 MP4／MOV 路径，无客户端路径或外部 URL。根目录、祖先／最终 symlink、越界、缺失、内容漂移均安全拒绝。
- [x] **字节与生命周期。** 安全打开源 FD，复制到唯一 0700 目录／0600 私有快照并分块计算 SHA，前后核验 inode／stat／路径和实际字节；流读取的是这一已核验快照而非重新打开原路径。流前重新核验 owner／source CAS，未完成校验前不发送媒体字节。响应 `private, no-store`、`nosniff`、确定的 video MIME／长度／SHA；Range 可返回完整 200，本步不构建通用 Range／票据平台。成功、错误、客户端断开均关闭 FD 并只清理该请求私有临时目录；不得清理源资产或其它请求。不得写任何业务表、启动 Worker／FFmpeg 分析／生成或读取模型／Key。
- [x] **反例和审查。** 覆盖未登录、异 tenant／user、软删、错误 source CAS、元数据归属／hash／size 漂移、未知 query、文件缺失／路径／symlink、打开／复制／发送边界竞态、断连清理、重复独立读取及所有业务表不变。继承既有上传合同，不增加更低的文件大小限制。聚焦及 redraw routes／source-audio／correction／功能锁回归通过，再独立规格→质量审查，保存新日志与 receipt，不改旧证据。

命令（工作树根）：`node --test --test-reporter=tap --test-concurrency=1 backend-node/test/redrawSourceVideo.test.js backend-node/test/redrawRoutes.test.js backend-node/test/redrawSourceAudioEvidence.test.js backend-node/test/redrawDialogueCorrection.test.js backend-node/test/featureLockManifest.test.js`。页面和用户体验须在后续真实浏览器连接中另验，后端媒体 GET 通过不替代该门禁。

后端回放子步退出：正式接口 52/52；主代理补含登录／租户／生成门禁的九文件回归 326 pass/1 既有 POSIX skip/0 fail；既有前端基线 57/57；功能锁 27/27、显式 HEAD 审计及静态通过。独立规格 55/55 后 PASS，独立质量 79/79 及额外 I/O 探针 4/4 后 APPROVE、0 问题，审查运行与主回归重叠不累加。新机器回执 `.codex-staging/r2b-source-video-20260905-verification.json` 绑定 77 文件／2 文档和本批日志；前批 receipt／14 日志保持不变。只完成后端，整套 R2b 与 R2 仍不勾选；后续按下段连接页面，不提交／推送／调用供应商／生产操作。

**后续页面接入的既定约束：** `frontweb/src/api/redraw.js` 通过现有 request 请求上述服务端固定路由与两个 CAS 参数，使用 `responseType:'blob'` 和请求取消；不信任 work.url/static 或客户端外部 URL。`RedrawBlueprintReviewPanel.vue` 只使用本组件创建的 object URL；源身份变化、卸载、失败和迟到响应撤销 blob／播放状态，加载只读母本不报价／不保存／不生成。未加载、加载失败或浏览器不能解码均有可见状态，不能保留另一作品的视频。保留正常 controls 及整句 seek/stop，不自动播放。

页面修订纯函数放入已有 `redrawBlueprintReviewState.js`：使用持久 record 上可核验的源 DTO 取得原始 ASR 锚点；若该 DTO 为人工修订，取其明确的 original 字段，不能把上一版修订再当原始识别。单句编辑仅改 effective text／完整时间／镜内交集与审核状态，取消不改稿；重复编辑保持同一原始锚点，显式撤销恢复原文及原完整时间并删除 correction。秒数输入精确到 0.001 秒，转换为安全整数毫秒后校验，拒绝非法／越界／不相交，不静默改范围。无可核验原证据、locked、保存／锁定中或冲突时禁止应用。草稿修订不合成服务器 resolved；`dialogueSourceForReview` 比较持久稿与草稿的完整 correction，即使完整时间变而投影相同，也让旧 DTO 失效，须保存／刷新重新取得。沿用 R2a 的工作／修订 epoch、A→B→A、卸载、迟到 PUT／lock 及 409 不重试守卫。页面须同时显示原始识别和人工修订，不以内部 ID／JSON 作为用户操作入口。

页面子步已开始，依赖的后端回放双审和 77 文件／2 文档／30 工件 receipt 已逐项回读通过。全新实现者负责 `frontweb/src/api/redraw.js`、`frontweb/src/utils/redrawBlueprintReviewState.js`、`frontweb/src/components/redraw/RedrawBlueprintReviewPanel.vue`、新增 `frontweb/test/redrawDialogueCorrection.test.js`、既有 `redrawDialogueSourceReview.test.js`／`redrawSpeakerCorrection.test.js` 的媒体与修订回归、`frontweb/e2e/redraw-workspace.spec.js` 的严格夹具及新交互；不改后端或全局 request。主代理负责功能锁／文档／联测及精确证据。先 pure／真实 SFC RED→GREEN，再页面浏览器；复用现有 UI，不新建播放器平台。原先 API pathname 判断不能用于 blob，必须改为本组件创建的 object URL 和下载时 source identity 绑定。错误、409、换源、卸载和迟到响应须明确 abort／stop／revoke；大文件体验及默认真实前后端联调仍单独记录，不能由 fixture 播放替代。

这些约束来自当前源码，不是新建通用平台的理由；实现时以原始用户流程为验收中心。

本页子步联测补充：主代理仅在既有 `backend-node/test/redrawDialogueCorrection.test.js` 新增真实 handler 联测，动态导入页面纯函数，使用实际 GET DTO→人工修订→PUT→GET→逐句复审→锁定；不在 fixture 中伪造修订已验证。四条初次 RED 已证明 helper 缺失，首次接通又揭示前端将音频证据误限为 `asr`：真实 resolver 同时认可 `asr/audio/audio_transcript/transcript`，须对齐而不改后端夹具逃避。后端允许 original ASR 文本最多 16384 字符、effective 修订稿最多 500 且不含 NUL；前端应分别校验，不截断原文。若已保存的长原文无法装入既有 500 字有效稿，恢复操作必须明确拒绝并保留当前稿，不能静默裁短或放宽后端。

R2b 页面最终退出：实际 UI payload 后端 58/58，相关后端十一文件 603/603；最终前端聚焦 83/83、默认全量加蓝图工具 1107/1107、主代理独立完整 Chromium 工作台 35/35，功能锁 28/28、显式 HEAD 审计／构建／静态均 exit 0。质量审查实际复现“媒体 409 冻结但隐藏页内刷新按钮”，先补正式 SFC／浏览器 RED 后只在媒体 catch 增加一行现有错误提示连接；规格增量 83/83＋浏览器 3/3 PASS，质量原样探针＋83/83 复审 APPROVE、无剩余问题。78 文件集合 SHA `a8d6670013dd98dd5940ab51c885d26cd3bda6cfc5fc52b732b91e99fa78dd68`，新回执 `.codex-staging/r2b-dialogue-ui-20260905-verification.json`；旧 77 文件 receipt 及 30 工件保留。只完成 R2b 本地合同／页面，不冒称真实浏览器与数据库全链、大 Blob 性能、真实转绘内容、CI 或完整 R2 通过。下一项按下方 R2c.1 可见事实编辑继续。

- **R2 纠错与素材。** 用 `redrawBlueprintWorkflowService.js`、`localizationService.js`、`redrawReferenceArtifactImportService.js`、`redrawReferencePreparationOrchestrator.js`、`RedrawBlueprintReviewPanel.vue` 和 `RedrawReferenceBundlePanel.vue` 的原有版本/上传/审核接口补连接。测试母本单文件和 ZIP 的既有不同限制、超过 64 段、复杂无对白音轨和识别失败；不静默缩小承诺，不凭声音聚类自动认人，不把逻辑 identity/motion requirement_hash 当素材文件 hash。修改事实后重新本地化/审核队列，上游不匹配时旧队列不能执行。
- **R3 任务与账态。** `redrawGenerationService.generateBatch()` 目前逐 shot 建任务后进入内存并发限制；`redrawBillingService.reserveShotGeneration()`、预算 JOIN 和 `redrawCandidateReviewService` 也只认 shot。新单元要有独立 unit/attempt/提交凭证/审核对象，报价按实际 unit 而非父镜数；复用 `creditLedgerService` 的幂等预留/结算，不把同一视频挂到多个 shot 提前达成“全部批准”。新入口须纳入 `modelGenerationGuard.js` 的明确路由防护，预算/次数/配置和运行许可只由服务端判定。
- **R3 重启与未知。** 必须同时验证 `taskService.failOrphanedAsyncTasksOnStartup()`、`videoService.resumeProcessingVideoGenerations()` 和 `app.js` 的恢复顺序；新任务类型不得落入通用 orphan failed/退款分支。未领取单元没有外部提交；已领取但回执未知保留待核对且不能再次领取；有 provider ID 仅查询同一任务，不重新 POST。真实测试中的故障注入覆盖领取前、持久记录后、POST 返回前、结果下载前及审核后五个时间点。
- **R3 审核与结算。** 现有 `videoService` 可能自动结算，既有 redraw 审核也负责结算，必须确定唯一结算负责人。沿现有 redraw 语义，候选技术成功仅进入待审，不因 video completed 提前认定通过；首片批准才允许后续领取，所有单元独立审核且审核绑定 plan/unit/attempt/实际文件 hash。否决不冒充供应商失败，不因重新打开页面重复扣费。
- **R4 质量与发布。** `redrawCandidateQualityService`、既有候选审核表和迁移 65 具有精确 shot 合同；不能随意加 unit_id、绕过迁移检查或将 unit ID 当 shot ID。保留原路径，新增单元审核关联和覆盖归并后才进入父镜发布；原生音轨传入 `redrawEpisodeReleaseService`、`redrawCompositionService`、`redrawExportService` 的同批工件哈希校验，不创建虚假 TTS 资产/收费记录。
- **R5 浏览器验收。** `redraw-backend-integration.spec.js` 的默认 harness 注入完成分析事实；新的关键链应复用其本地 DB/FFmpeg 设施，但走本次上传媒体的默认分析服务，只在最底层替换推理/生成。`redraw-live-product-harness.mjs` 的真实本地注册/登录可用于 owner 隔离；不得开启它已禁用的真实生成通道、不得用固定 shot-6/28 单元角色表代替新项目。

下表是本计划首次审计的基线快照，部分缺口已由上方 R1／R2 子批次解决；当前完成状态以对应退出证据及总报告为准，不能重复立项已完成工作。

| 环节 | 基线证据与当时缺口 |
|---|---|
| 动态母本入口 | `redraw.js:2088` 默认注入音频、视觉和融合服务；`redrawOrchestrator.runBlueprintPipeline()` 已从当前上传资产生成待审蓝图，不重做入口。现有全产品 E2E 注入 `activeAnalysisFacts`，未证明默认动态分析链。 |
| 空语音与长母本 | 无音轨可形成静默证据；有音轨但 ASR 空段会被 Worker 拒绝。视觉摘要超过 64 段或 16 KiB 失败，与上传默认 12 秒至 1 小时边界不一致；需要真实分段处理与清晰能力提示，不能静默截断或为通过测试缩小承诺范围。 |
| 跨镜对白 | `redrawEvidenceFusionService.segmentOwner()` 选重叠最多镜头并夹短对白时间，但保留整句；须保留完整源时间/文本证据，并让审核与拆分计划遵守同一对白覆盖合同。 |
| 事实与人物纠错 | 聚类待审、映射已有角色、创建画外角色和后端锁定门禁已有；UI 主要确认，缺逐句播放定位、ASR/时间/镜头纠错、错误聚类拆分及已映射对白重映射。不能默认声音聚类永远正确。 |
| 素材准备 | 身份包、媒体登记和准备门禁已有；动作参考依赖待审导入资产（不是已生成转绘视频），参考包表单仍暴露内部资产 ID，图片/动作参考导入 API 未形成普通用户完整操作。后续需补 owner/version 的素材选择与归属校验，不把全局文件可读当作拥有。 |
| 动态生成计划 | 已有父镜头绑定、对白安全边界和媒体规范化；Fumin 规划器固定 5 秒、最多两段且拒绝超过 10 秒镜头，产品路径则把时长夹在 5—15 秒。缺按已验证能力生成任意所需段数的产品计划及持久队列。 |
| 原生音轨交付 | 生成侧已有原生音频验证；`redrawEpisodeReleaseService.audioHash()` 仍要求独立对白资产，合成默认 `replace` 会舍弃视频原声、无独立对白时生成静音。须贯通原生音轨证据、readiness、发布 hash、合成与下载。 |
| 交付证据 | 页面、API、候选 QA、发布与下载已有；缺同一动态项目的用户全流程证据、多输入质量与恢复验证。单镜、脚本、模拟 CI 和某一部成片均不能单独证明通用产品完成。 |

#### R2c：镜头可见事实与切镜纠错（接续 R2b）

只读核查确认：镜头构图／运镜／起始／连续动作／结束状态、场景地点／时间和道具名称已经是可保存并投影的蓝图字段，页面仍为只读。切镜则同时影响相邻边界、对白归属／投影、spoken/silent 及画内角色合同，不能只开放两个时间输入。沿已批准事实纠错目标分两个有依赖的局部实现，R2b 双审完成后才开始修改同一组件；不新建工作树、事实平台或第二份计划。

- [x] **R2c.1 可见事实编辑。** 在既有蓝图卡片显式编辑 shot 的 `composition/camera_movement/opening_state/continuous_action/ending_state/visible_character_ids`、scene 的 `location/time`、prop 的 `name`，内部稳定 ID 由选择项绑定，用户无需填写。只修改选择对象的白名单字段及必要审核状态；原始证据文件／引用／SHA、source、镜头时间、对白原文与整句范围不变。可见角色必须是已存在且唯一的角色；不能删除仍被该镜画内对白引用的角色，也不能悄悄把对白改成画外。角色增减使该镜对白重新待审，总体审核撤销；纯视觉文字编辑撤销总体审核，识别 confidence 原样，不伪造模型置信度。
- [x] **页面与真实保存联测。** 复用 R2b `canEdit`、媒体停止及 CAS/epoch，明确应用／取消，仅改草稿；锁定／冲突／保存中不可应用。文本限制与现有后端一致：shot 五字段上限依次 500/300/500/500/500，scene 200/120，prop 200；trim 后非空，拒绝后端已有的 URL／路径／凭据模式，并拒绝 NUL、非字符串及未知字段。应用后不能沿用旧总体批准。至少覆盖普通用户选择角色名称、非法删除画内说话人、取消／多次编辑、保存刷新与重新审核，以及未选对象／原 ASR／全部非蓝图业务表不变。前端纯函数 payload 必须经真实 handler 保存／读回／批准／锁定，不能只做 API fixture。
- [x] **R2c.2 相邻边界与对白归属。** 先补真实 RED，再以原 ASR 稳定 turn.id 和完整时间重算投影；不得复制同一句或按新时间重建 ASR ID。相邻边界仍连续覆盖，移入镜须正相交且满足画内角色合同；原声无可核验整句证据明确阻断，不猜时间。需专门验证所有受影响原 ASR 投影：现有写前 resolver 仅核验带 correction 的对白，不能用普通稿锁定成功冒充切镜证据通过。实现前据 RED 选择最小局部加强，不放宽旧 gate 或原地改已锁记录。场景 source_ranges／因果 ID 不随切点机械变化；没有时间信息的 OCR 区域不得自动搬迁，需显式画面审核。保存后的新 hash／本地化／预览须真正消费新归属。
- [ ] **顺序双审与证据。** 每个有界实现先 RED→GREEN、规格→质量，保持 R2b receipt 不变；仅追加本次实际触及的本地功能锁授权。完整 R2c 及 R2 只有上述范围闭合才勾选，不将可见事实文字编辑当切镜、OCR 几何纠错或素材已完成。

R2c.1 文件责任：新的实现者仅改 `frontweb/src/utils/redrawBlueprintReviewState.js`、`frontweb/src/components/redraw/RedrawBlueprintReviewPanel.vue`、新 `frontweb/test/redrawVisualFactCorrection.test.js` 和既有 workspace E2E。主代理负责新 `backend-node/test/redrawVisualFactCorrection.test.js` 的真实保存联测、功能锁及本计划／总报告。未发现真实后端缺陷前不改运行时 schema/service/API。R2c.2 责任在第一步双审后依据实际反例确定，不并行修改共享文件。本批仍零 Key／供应商／付费／commit／push／生产／部署。

R2c.1 本地终态（2026-09-06）：新前端 31/31、兼容聚焦 114/114、相关后端 115/115、完整前端 1138/1138、工作台 36/36，build／功能锁／静态通过；独立规格 PASS、独立质量 APPROVE。两位各自前端 91/91、后端 35/35，与主回归重叠不相加。源码集合 80 文件 SHA `1c9e7c1ab4252fbeb11c7cc10200dd554204af02a1ac2beac2ee2193b2076fda`；前批 43 工件及 receipt 原样。2026-09-05 两个全量运行无终态且后来进程已停止，未计通过；2026-09-06 在未变化字节上重新取得显式退出码。机器回执 `.codex-staging/r2c-visual-facts-20260906-verification.json`；完整 R2c.2／素材／执行／合成及真实验收仍未完成。

**R2c.2 后端先行（2026-09-06，本地 TDD）。** 现有 owner／源绑定的 ASR 历史登记能防 manifest 删除后假装无 ASR，但不能记住哪个镜头曾人工切镜。只比较本次 save 前后边界，会在下一次 save／lock 丢失核验范围；扩大所有旧 ASR 草稿的写前门禁也不符合 R2b 兼容承诺。选用最小可选 `shot.manual_boundary: true`，放在既有 blueprint JSON／hash，不新建表或执行平台。标记只允许 true；由服务端比较已持久 current 生成并继承，不以客户端遗漏为撤销。

- [x] 新增真实迁移 SQLite／原 ASR 文件的 `backend-node/test/redrawBoundaryCorrection.test.js`，先证明普通 ASR 错误投影随切镜可保存这一缺陷；保留 RED 日志和真实退出码。
- [x] 最小服务端修复：边界变化的相邻镜、已有标记镜及其对白移入目标均进入复核范围；受影响原 turn ID 集合守恒，禁止删除／改 ID 或移动到未核验目标以缩小范围。每次 save（含同 hash）与 lock 都重新 resolver 核验标记镜内全部对白，原始文件／owner／源／manifest 漂移即零写入拒绝。后续保存／同源新修订不能删除标记；新源分析与同源改稿分开，不靠用户 payload 假装重新分析。
- [x] 必跑反例：切镜后错误投影；保存后原 ASR 漂移导致同 hash save／lock 拒绝；删标记／删 turn／改 ID／移出绕过；缺少完整原句证据的有对白切镜；owner／CAS／锁定拒绝；普通旧无 ASR 且不切镜的编辑仍可保存。静默镜不凭空造对白，也不能仅凭空数组冒充已核验无语音，复用现有明确无音轨／无语音证据合同。
- [x] 先完成后端规格／质量双审，再接相邻切点、对白归属及重审 UI；不能只完成后端拒绝就宣称用户能切镜。正确新范围必须经真实锁定、本地化和动态预览消费，原始证据与前序工件保持。

首个全新实现者仅负责 `redrawEpisodeBlueprintService.js` 的可选标记合同、`redrawBlueprintWorkflowService.js` 的派生／继承／写前锁前核验及新 boundary 测试。优先复用既有 resolver；若现有静默证据接口确不足以满足合同，先给出具体反例，由主代理明确最小追加文件责任。主代理负责功能锁与唯一文档，未完成前不并行改 UI／其它共享服务。只登记本轮已有本地开发授权，不触及线上模型、Key、供应商、生产或 Git 写入。

只读核查后的最小扩责：已有 resolver 在没有对白条目时直接返回空数组，其私有 silent 分支也未复核 `no_speech_evidence`；producer 已有明确无音轨与 VAD 零语音两种带源 hash 的证据，但未导出安全只读复核。因此由同一后端实现者再负责 `redrawSourceDialogueService.js`，只增加边界范围所需的只读复核入口，复用已有 owner／source／manifest／安全 FD 读取，不复制路径解析器、不改 Worker 或 producer、不改旧 DTO。新增测试区分：有效无音轨；有音轨且完整范围 VAD=0；全局 spoken 证据下当前无归属对白镜的真实无语音或跨镜唯一归属；缺证据／伪造或缺失 VAD／覆盖不足／原文件和 owner 漂移。不能以空对白数组直接放行，也不能一律阻塞无对白视频。总责任为 3 个运行时服务和 1 个新增测试，仍先 RED 后 GREEN。

空对白镜语义核实：规范化以是否持有 dialogue 决定 shot.spoken／silent（`redrawEpisodeBlueprintService.js`），融合服务也只把跨镜整句分配给一个镜。因此单镜 silent 并不证明其时间段没有物理语音。范围复核必须容纳声音跨过本镜、但原句已在另一镜以稳定 ID／原证据及完整范围唯一 resolved 的合法情形；不得为通过核验把一句复制进两镜。只有确无语音时才使用明确的无音轨／VAD 零语音证据；重叠原 ASR 全局遗失、重复或无法核验归属仍拒绝。追加该正向 RED，纠正早期只读建议中过严的“空对白镜不能有任何重叠 ASR”假设。

切镜的重新审核语义：边界／对白归属实际变化时，服务端撤销总体批准与 reviewer，使受影响对白待审；不能沿用切镜前的 approved 直接锁定。之后仅复核已标记、未再次变更边界或归属的稿件时，不反复撤销用户新批准，否则会形成永远无法锁定的循环。该连接须先写真实 RED，再实现合法切镜→保存→重新审核→锁定成功与源证据漂移失败两条路径。

后端独立规格反例已定位：仅改变稳定 turn ID 的所属镜而切点不变、且原稿无标记时，也必须进入同样的 affected／changed 集；不得因只比较切点而绕过复核与重审。只匹配新旧同时存在的 ID 仍不够，旧／新 ID 集合的删除、新增、改名也须作为复核种子，由原 ID 守恒拒绝替换，避免移动并改名逃过识别；同源人工新修订保持同样合同。普通未切、未移且 ID 未变化的旧无 ASR 文本编辑仍按原策略；操作时 work 的源确已变化才按既有新源分析路径处理，不用用户 payload 自称新分析来解除绑定。原实现者依次保留正式 RED 与修复；待规格复查通过才进入质量审查及下面的 UI。

**R2c.2 页面接续（后端双审通过后才实现）。** 沿用现有镜头卡片、源片播放器及保存／锁定 API，不新建接口或另一套审核台。新的界面实现者仅负责 `frontweb/src/utils/redrawBlueprintReviewState.js`、`frontweb/src/components/redraw/RedrawBlueprintReviewPanel.vue`、新 `frontweb/test/redrawBoundaryCorrection.test.js` 和既有 workspace E2E；主代理负责真实 helper payload→后端消费联测、功能锁及唯一文档。

后端前置已于 2026-09-06 双审完成：最终专项 52/52、相关 409 pass／1 POSIX 权限 skip／0 fail，功能锁 30/30、审计／静态通过；独立规格第三轮 PASS（52/52＋5 独立反例／兼容检查），随后独立质量 APPROVE（52/52＋4 交互／回滚探针），工具 exit 0。前两轮规格 P1 有正式 RED 和修复历史，不覆盖失败证据。81 文件集合 SHA `b7cb74a752b45e7e77fb0259224d2f564fe8806ca9588573c3a2def044c90d8f`，后端专用 receipt `.codex-staging/r2c-boundary-backend-20260906-verification.json`；这只放行下述页面实现，不勾选完整切镜或 R2。

- [x] 在相邻两镜之间只输入一个公共切点（秒，最多三位小数），同步预览两镜范围；同一表单显示受影响整句与明确的目标镜选择。切点与必要的归属变更一次原子应用，避免先改一项导致零相交而无法继续；仅改变归属、保持切点不变也可审核保存。跨多镜目标取全部镜头，不受当前分页限制；不自动猜新归属、人物或画外状态。
- [x] 采用专用有界纯 helper：`boundaryCorrectionForReview(record, blueprint, leftShotId, rightShotId, boundaryMs)` 产生整句及合法目标预览，`applyAdjacentBoundaryCorrection(record, blueprint, leftShotId, rightShotId, { boundary_ms, assignments: [{ dialogue_id, target_shot_id }] })` 原子更新。实际已保存 DTO 名为 `source_dialogue`；按全局唯一稳定 turn ID 找到保存前归属，先用既有 resolver DTO 校验保存前锚点，再严格核验当前草稿源／证据／有效修订范围。保留旧 source／original helper 的更严格语义，不把未保存投影冒称服务器已核验。无法核验完整句、非法目标或画内人物不可见时明确拒绝，失败不修改输入。
- [x] 同一句仅移动一次，保留 ID、原 ASR 与完整修订锚点；新投影为有效完整范围与目标镜的正相交。连续覆盖、顺序、源总时长不变；只更新受影响镜的 spoken／silent 所属对白合同，不将空对白等同物理静默。保留服务端标记，实际变化撤销总体和相关对白审核，无变化不反复撤销。场景 source_ranges、因果 ID、OCR 区域和非目标事实原样；显式提示 OCR 不自动迁移，需检查切点两侧画面。
- [x] 应用／取消、重复调整、编辑互斥和媒体停止接入现有 `canEdit`／source SHA／CAS／epoch。定位切点只 seek 已显式加载且身份匹配的受控 Blob 视频，不使用 work.url 或额外媒体请求。记录／源／版本变更、409、卸载及迟到回执清除新编辑状态。先以真实 SFC RED 修复“保存后服务端已撤销批准却继续 lock”的二次门禁，保留原合法 dirty save→lock，拒绝后不自动重试。
- [x] 新单测覆盖上述原子性、跨两／多镜、端点零相交、纯归属、无证据、合法静默、已修订整句、重复编辑、非法映射／数值／对象、取消／并发／只读；工作台测试按全局稳定 dialogue_id 唯一更新保存响应的 shot_id／投影，模拟服务端重审并拒绝未批准锁定，不能沿用无条件成功的 mock。主代理用真实后端联测证明 helper 输出可保存、重审锁定并消费新范围；浏览器 fixture 不称真实 DB 全链。规格→质量通过后才记录完整切镜局部完成，素材和后续主线仍未完成。

浏览器请求边界以既有产品合同为准：切点预览／应用／取消／保存／刷新和未锁定重审阶段，报价与生成均为零。用户成功锁定蓝图后，保留 `RedrawSourceStep` 原有的本地化报价展示，不改模型或计费逻辑；该新测试仅允许本次成功锁定后的单次精确本作品／目标语言报价请求，重复、锁前或错误参数仍拒绝，版本创建／本地化任务／生成均为零。原工作台已有锁前 0、锁后 1、用户点击开始后再创建版本的测试，新切镜夹具不得用预填报价／虚假 phase 隐藏这条路径，也不得把报价误记为供应商调用或付费生成。

R2c.2 页面本地退出（2026-09-06）：独立规格 PASS、随后质量 APPROVE。新前端 40 项、相关 143/143，根完整前端 1178/1178、相关后端 417 pass／1 旧 POSIX 权限 skip／0 fail、workspace 38/38、build／feature-lock／静态全部 exit 0；source 集合 82 文件 SHA `3bda6c10ae88aaf1741ab7988d13e01e38fcbf4b64f3c73a60a3dad70e73db98`，机器回执 `.codex-staging/r2c-boundary-ui-20260906-verification.json`。真实后端消费联测明确含本地化审核／能力 fixture，不冒称默认浏览器真实数据库和供应商全链；新移动端视觉、无障碍和真实多输入仍留后续回归。下一步只沿下述已定位缺口接身份图／动作素材，R2 整体及 R3–R8 不因此勾选。

R2 后续素材连接的 2026-09-06 只读定位（不是完成证据）：`RedrawAssetCard.vue` 现有服装下拉和身份确认仅消费当前版本已存在的图片，未提供身份主图上传／选择；后端 `importCharacterReferenceArtifact` 及图片导入 handler 已有，前端按钮/API 包装尚未连接。`RedrawReferenceBundlePanel.vue` 仍要求 motion asset ID／JSON；现有 motion-reference POST 可对现成片段做 owner／版本／镜头／源指纹／时段、SHA／尺寸／时长／无音轨核验，但 preparation orchestrator 只绑定 ready 片段，不会从新上传母本生成它。固定母本 CLI 和 live-product harness 的夹具裁剪不算通用产品能力。R2c 之后先复用真实图片导入接普通上传，再补当前母本 owner／SHA 绑定的动作片段准备、预览与显式审核，不另建模型目录或把历史 fixture 暴露为完成路径。

## 3. 文件责任范围

以下是定位范围，不代表所有文件都要改；先复现，再最小修复。表内同组文件均位于注明目录。

| 职责 | 现有文件与测试入口 |
|---|---|
| 上传、音频与动态事实 | `backend-node/src/services/` 下 `redrawUploadService.js`、`redrawSourceAudioEvidenceService.js`、`redrawNativeSourceAnalysisService.js`、`redrawEvidenceFusionService.js`、`redrawOrchestrator.js`；对应 `backend-node/test/redraw*.test.js`；`workers/redraw-locale-verifier/src/redraw_locale_worker/source_evidence.py` 及对应 Worker 测试。 |
| 蓝图、本地化、生产包 | `backend-node/src/services/redrawBlueprintWorkflowService.js`、`redrawEpisodeBlueprintService.js`、`localizationService.js`、`redrawShotProductionPackService.js`；对应蓝图、本地化与生产包测试。 |
| 素材与准备 | `backend-node/src/services/redrawReferenceArtifactImportService.js`、`redrawReferencePreparationOrchestrator.js`、`redrawReferenceBundleService.js`；`backend-node/test/redrawReferenceArtifactImport.test.js`、`redrawReferencePreparationOrchestration.test.js`。 |
| 计划、运行与停止 | `frontweb/scripts/fuminEpisodeExecutionPlan.mjs`、`run-redraw-episode-blueprint-live.mjs`、`run-redraw-video-model-fallback-live.mjs`、`episodeVideoProviderAdapter.mjs` 及同名测试；`backend-node/src/services/redrawGenerationService.js`、`redrawGenerationPolicyService.js` 及对应测试。 |
| QA、声音、合成、下载 | `backend-node/src/services/redrawCandidateReviewService.js`、`redrawEpisodeReleaseService.js`、`redrawCompositionService.js`、`redrawExportService.js` 及对应测试；`frontweb/scripts/fuminEpisodeMediaPipeline.mjs`、`fuminEpisodeProviderAdapter.mjs` 及同名测试。 |
| 产品界面与路由 | `backend-node/src/routes/redraw.js`、`backend-node/src/routes/index.js`；`frontweb/src/api/redraw.js`、`frontweb/src/views/RedrawWorkspace.vue`；`frontweb/src/components/redraw/` 下 `RedrawSourceStep.vue`、`RedrawBlueprintReviewPanel.vue`、`RedrawLocalizationReviewPanel.vue`、`RedrawAssetCard.vue`、`RedrawReferenceBundlePanel.vue`、`RedrawShotStep.vue`、`RedrawGenerationQueuePanel.vue`、`RedrawQualityReviewPanel.vue`、`RedrawEditStep.vue`、`RedrawEpisodeReleasePanel.vue`、`RedrawExportPanel.vue`。 |
| 用户流程与总证据 | `frontweb/e2e/redraw-full-product.spec.js`、`redraw-backend-integration.spec.js`、`redraw-full-product-live.spec.js`、`support/redraw-live-product-harness.mjs`；唯一总报告 `docs/verification/redraw/mainline-final-delivery.md`。 |

## 4. 任务与退出条件

### 当前执行批次：新输入的语言选择与无对白音轨

本批只解决下列已有缺口，完成它们不等于任务 1—3 全部完成。保留既有未提交差异，不改线上模型，不调用供应商。

- [x] 项目保存的目标语言/市场进入 SourceStep 时原样沿用；能力刷新不能覆盖用户刚作的选择。能力列表中排在首位的英文不是默认授权。
- [x] 按实际阶段能力显示可用性：缺文本/字幕能力不能放行本地化；仅缺后续视频/语音能力可先分析，但须显示后续缺口，不能把“能分析”显示成“能完整生成”。
- [x] 有音轨但没有对白：仅在完整 ASR/VAD 成功、明确语音时长为零且覆盖本次音轨时，形成带 hash 的“未检测到语音”待审证据。保留音轨与空转录 hash，不虚构语言或对白；空转录但缺证据、识别失败、超时和结果未知仍停止。
- [x] 回归至少覆盖：非英文项目遇到首项英文、刷新期间切换目标、目标组合不可用、无音轨、有轨且 VAD 为零、有语音但空识别、Worker 超时和证据漂移；均使用产品组件/服务，不修改固定样片素材。
- [x] 独立定位 recorder 四项当前复现，保留小型完整日志；确认沙箱祖先目录 realpath 权限差异，未改业务安全代码。历史全量无完整日志，未追认其根因或抵消失败。

证据：两项修复均经独立规格/质量审查；前端 1007/1007、页面 26/26、真实本地三镜产品链 1/1、后端完整 3991 通过/10 跳过/0 失败、Worker 119 通过/8 跳过，且既有本地 ASR 对 12 秒静音实际离线推理通过。各项均 exit 0，模拟边界与后续通用任务状态以总报告为准；未提交或运行新 HEAD 的 Hosted CI。

完成后继续长输入/跨镜对白、事实纠错、普通素材操作和产品动态执行链；不再启动固定整集付费实验替代这些开发。

下一批跨镜对白的兼容约束已只读确认：现有对白 `start_ms/end_ms` 是整集绝对时间，但 schema、本地化及生产包要求它落在所属镜头内；不可直接改为跨镜范围。完整原始范围已在音频证据中保留，锁后 `turn.id → source_dialogue_id → pack.dialogue.id` 及 owner/version/蓝图 hash 能回指原证据。优先实现服务端解析现有证据，而非先给所有 schema 复制新时间字段：核验 owner、源资产与文件 SHA 后唯一命中原 ASR segment，否则返回明确 unresolved，不能猜时间；草稿 ID/ref 可被修改，不能无条件信任。审核、本地化时长预算及通用单元规划须显式消费完整范围，保证整句只转换一次、生成一次。仅增加证据回查不能勾选“不切句生成”。反例包括跨两镜、跨多镜、中点在切镜边界、句尾恰好落边界，以及伪造 ID、缺失证据和 hash 漂移。

### 任务 1：明确通用输入、事实审核与生产合同（本地）

当前子批次（用户“开始进行下一项”）：跨镜整句证据与消费边界。先补下列连接，不把只读解析器或错误阻断当作跨镜生成已完成。

- [x] 从当前 owner/work/source/hash 绑定的原音频证据解析完整对白；保留镜头内投影和蓝图 hash 不变，伪造引用、漂移或歧义明确 unresolved，旧无 ASR 项明确 not_available。
- [x] 产品审核接口返回脱敏解析结果；页面区分“整句源范围”和“镜头内显示范围”，支持按完整范围回放原视频。用户改动对白或切换蓝图后不可继续使用旧解析结果。
- [x] 本地化/生成准备显式检查上述证据：不得把投影当成完整语音预算；在安全跨镜执行计划尚未接通时，明确阻止截句生产，不压缩台词来规避。无 ASR 的旧人工证据不能被声称为已完成原句验证。
- [x] 运行真实服务/隔离数据库、前端行为及页面回归，覆盖跨两镜、多镜、边界、证据越权/漂移和旧格式；保留日志、退出码与独立规格/质量审查。

本子批次完成证据：最终后端相关 20 文件集成回归 746 项（744 通过、2 平台跳过、0 失败），前端默认单测 1008/1008、蓝图工具另 11/11，workspace 浏览器 27/27，真实本地前后端三镜链 1/1，构建 exit 0。浏览器的分析/供应商使用 fixture；不证明默认长输入分析、真实翻译质量或跨镜生成可用。完整日志与当前差异 hashes 位于 `C:/Users/canqu/Documents/茉莉妈妈2/.codex-staging/redraw-cross-shot-20260905/verification.json`。主任务 1—3 尚未整体完成，不因这四个局部勾选而视为交付通过。

长视频补充分段原因已确认：除 64 段/16 KiB 摘要门槛外，当前将全片 contact sheet 放入单次视觉请求（1 小时约 900 张）且输出上限为 8000 tokens。单纯取消摘要门槛无法兑现长片支持；分段事实合并、跨窗人物/对白与全时间轴覆盖仍作为同一主线后续实现，不扩大本批供应商调用范围。

#### 当前执行子批次：长输入分窗接入默认分析链

沿本计划的“动态分析”补齐现有单次请求瓶颈，不改变目标模型、输入支持范围或既有跨镜生成守卫。单纯提高 64 段限制仍有画面/输出大小瓶颈；先压成全片摘要会丢失证据。因此采用完整证据保留、有限窗口逐段分析、全部成功后合并的实现。

- [x] **分窗 TDD。** 新增 `backend-node/src/services/redrawAnalysisWindowService.js` 及 `test/redrawAnalysisWindows.test.js`；默认每窗最多 24000 ms、最多 6 张既有采样规则 contact sheet。按与窗口正相交选择完整 ASR 段，保留源绝对时间/ID/ref；只沿用 160 字预览，不改完整证据。64 条或 16 KiB 超限时按整数毫秒二分，预检所有窗后才允许请求；最小窗口仍超限或非法/不安全证据明确失败，零请求。
- [x] **原生服务 TDD。** 修改 `redrawNativeSourceAnalysisService.js` 和对应测试，逐窗制作真实 sheet、请求和严格验证，失败即停、不重试。视觉结果时间为窗内相对时间，ASR/图像标签明确是源绝对时间。多窗 IDs 使用不碰撞的短 namespace，范围平移、index 重排、全片无缝覆盖并重新计算 hash；单窗保持旧合同。不得凭同名合并人物；跨窗身份/人工边界降为待审，原句交给全片融合只附加一次。全部成功才注册一个最终资产；保存各窗 provider ID/raw hash/usage/range，清理仅限本次临时产物。
- [x] **默认产品入口回归。** 新增 `backend-node/test/redrawWindowedProductAnalysis.test.js`，真实新媒体上传/分析路由、隔离 DB、实际 FFmpeg、源音频服务、原生视觉服务及融合/蓝图存储；只替换最底层 ASR 与视觉调用，不注入分析事实或完成蓝图。覆盖超过 64 段、多窗完整原句回查、owner 隔离、待审停止、半途失败不发布、不生成。
- [x] **独立审查及合并回归。** RED→GREEN 日志保留；先规格后质量审查。运行 native/window/product、融合/音频/蓝图/路由/生成守卫/功能锁相关串行测试；所有测试命令保存真实退出码。只按本次授权补锁记录，不改 requiredTests/protectedPaths 等门禁；不提交或推送。

本子批次不把 namespace 当作跨窗人物重识别，也不把窗口边界当已确认真实切镜。长片输出仍需人工审核，纠错/重映射 UI 是下一连接。

本次审查补充（仍属上述本地子批次）：

- 每个窗口在请求前、响应后和校验后落脱敏凭据；失败也保留已返回的 provider ID、有效 raw hash、数值 usage、窗口和 sheet 哈希，不注册成功资产、不保存原始响应或异常正文。历史工件不能覆盖。
- 规范化 `source_facts 2.0` 不再覆写数组：原序叙事及最后窗 hook 保存在 `diagnostics.ordered_narratives`，另有 `narrative_order_hash`。`redrawOrchestrator.js` 核验该 hash 后，仅给 fusion 构造无旧 facts_hash 的有序投影；`redrawEvidenceFusionService.js` 仅为多窗自动叙事 ID 加序号，保留旧单窗及蓝图 canonical sort。
- 真实传输超时、无响应 ID、异常携带任务 ID，均以明确 unknown 错误进入 `needs_attention`，保留本地冻结并阻止再次分析；只有明确拒绝且无任务 ID或已返回无效事实才走已知失败处理。测试包含真实 `routeMeta` 形状、未知后再次点击零新增请求；本批没有为未知结果实现自动恢复或重提。
- 由于编排器同时受 `stability.proactive-canary-and-public-evidence` 和 `redraw.episode-blueprint-first` 保护，只对这两项追加本地授权历史并刷新本轮 unlock；不改保护路径、requiredTests、证据、状态或任何线上模型/生产门禁。

动态执行的进一步只读定位已完成：现有脚本固定 5 秒、最多两段；产品一父镜一任务/一候选。真正跨镜本地化 lock 在生产包守卫中会回滚，现有 redraw capability 投影又缺时长/参考/音频参数证据，不能直接用“已验证模型”标签推断全部规划能力。下一子批次须先补**版本级只读预览**（可读取当前已保存待审本地化，不伪造 locked），用服务端能力证据交集规划 N 单元及多父时间映射，绑定源/蓝图/本地化/能力 hash，零任务零冻结；其后接持久化、幂等计费、候选归并和发布才可解除跨镜守卫。不要把纯 CLI 或预览算法称为动态生成已完成。

#### 当前执行子批次：版本级动态执行计划只读预览

用户“开始下一项”沿用上节范围；2026-09-05 开始时 HEAD 仍为 `8c49a90773a4311992e4eb9b6a5bc2c9acdfa4ed`，上一批 54 个文件 SHA 全部相同。本批仅本地开发、隔离回归和文档，不读 Key、不调用供应商、不付费、不提交/推送/部署，不改模型、生产库或共享门禁。

- [x] **纯规划 TDD。** 新增服务端 `redrawExecutionPlanService.js` 及单测：输入源绝对时间、完整对白、父镜合同和服务端规划能力；按已验证时长生成 N 单元，禁止硬切整句/重叠语音连通区间；父镜可映射多个单元、一个单元可映射多个父镜。明确保留源时长、生成时长及尾部 padding；每句恰好一次、全时间轴无缝覆盖、参考并集不超限。不固定样片、角色、语言、5 秒或两段上限。缺失能力/无法满足时返回明确 blocked，不能返回可执行的部分计划。
- [x] **服务端证据投影。** 新增只读预览服务，精确读取当前 owner 的 version/work/源 SHA、locked source blueprint 和已保存待审或 locked localization；重新核验内容 hash、locale/market、整句源证据。只 SELECT 必需的非 Key 配置列；视频规划能力仅取既有成功且可读的证据与适配器约束交集，缺时长/参考/原生音轨等证据即列出缺口，不升级或写回模型能力。
- [x] **只读产品 API。** 增加 `GET /redraw/versions/:id/execution-plan`；返回绑定源、蓝图 revision/hash、本地化内容/review/hash、能力/config hash 的确定性预览。始终 `executable: false`，待审本地化不伪装 locked；不创建 async task、视频任务、积分预留、媒体或新持久状态；不调用生成/报价/TTS/生产包锁定入口。既有跨镜守卫保留。前端展示和持久队列随后接入，不在本批声称用户已能执行这些单元。
- [x] **审查与验证。** 先 RED 再实现，真实隔离 DB/产品路由覆盖 owner 拒绝、hash/证据漂移、待审保存、能力缺失、长单元/跨多镜、零写与无 Key 查询；纯算法与现有跨镜守卫、蓝图/本地化/路由/功能锁串行回归，保留日志和实际退出码。独立规格后质量审查，只按本批真实授权登记受保护路径触及记录。

本子批次实现语义明确如下：

- `status: ready` 仅表示时间轴可规划，始终 `executable: false`；`execution_blockers` 保留源媒体未重读、素材未验证、凭据未检查和动态执行器未接通。源 SHA 校验是 work/blueprint/ASR 证据绑定，不冒称已对原 MP4 重新读取字节；完整源 ASR 文件仍由既有安全解析器校验。
- 未锁本地化不能依赖生产包/已审参考包，否则形成锁前死锁。因此每个可见角色一份 identity image、每父镜一段 motion video，仅作逻辑需求计数；公开字段为 `reference_requirements[].requirement_hash`，`reference_readiness: not_checked`。不是资产 SHA、素材已存在或角色一致性证明；真实素材及单元内裁剪/时长合同在执行接入时重新验证。
- 只读能力投影暂支持已有 Fumin、ToAPIs Seedance、飞拓 `xuan-*` 适配器合同，不更改其配置；未知协议或缺证据维度明确 blocked。WAN3 完整凭据绑定需读取 Key，本批不获此权，返回 `CREDENTIAL_BINDING_NOT_CHECKED`。ToAPIs 旧记录缺画幅时不从常量补齐。能力数组只是已批准范围，不声称所有参数组合均经过真实生成。
- 原生音频只从同一视频配置、同一模型的语言级证据读取，严格校验既有真人审核/音视频合同；具体地区不自动验证，保留 `TARGET_REGION_AUDIO_NOT_VERIFIED`。另有精确目标地区的已验证 TTS 时可列为 replace 规划路径；预览不执行 TTS、也不更改用户声音策略。
- 本批 route 注册涉及五项功能锁，只追加真实本地授权并保存完整前序；历史测试先核验新授权，再用前序整体 SHA 校验后执行原断言。既有 protectedPaths、requiredTests、状态及 evidence 不变，不属于共享门禁升级。

#### 当前执行子批次：页面计划审核与版本绑定保存

用户本轮“开始下一项”继续上述只读预览之后的既定连接；HEAD 未变，前批 59 个代码/测试/清单文件 hash 已逐项复核无漂移。使用现有隔离工作树、子代理 TDD、先规格后质量审查。本批仍不读 Key、不请求供应商、不付费、不提交/推送、不部署，不触碰生产库/shared。

- [x] **版本快照 TDD。** 新增独立 `redraw_execution_plan_reviews` 追加式表，owner/work/version/plan_hash 唯一绑定，保存服务端重新计算的完整预览和审核时间；不修改 version/work/localization 的更新时间、状态或 hash，避免保存自身使计划过期。`GET/POST /redraw/versions/:id/execution-plan/review` 返回 `{preview, saved_review}`；POST 只接受 `expected_plan_hash`，在 immediate 事务中重算并比较，blocked 或漂移拒绝，零任务/冻结/扣费。重复同 hash 幂等；GET 优先当前 hash 的历史快照，否则仅显示最新历史 stale。A→B→A 完整 hash 相同时可复用原 A；这不是运行授权。快照内容/hash/owner/version 不一致返回 invalid、不得展示损坏计划为已审核。
- [x] **产品审核 TDD。** 在现有本地化审核附近增加计划面板，展示目标语言/市场、候选能力、源范围/保留时长/生成时长/padding、父镜映射、完整原句/目标对白及逻辑参考需求，明确预览与执行缺口。用户确认已检查后只保存快照；不得出现本项启动生成按钮。未保存的本地化修改、加载失败、版本切换、上游变化、过期或损坏快照均撤销当前确认；迟到请求不能覆盖新版本，保存冲突须重新刷新和确认，不能自动重试保存。
- [x] **回归和收口。** 真实隔离 DB 验证迁移幂等、owner 隔离、严格 body、完整句快照、防重、上游/能力漂移、不可变快照和零副作用；前端真实组件行为及浏览器验证检查/保存/刷新/修改/竞态。相关旧守卫与功能锁、前端回归/构建保持，记录退出码和精确文件 hashes。只追加本轮真实功能锁授权，不修改保护范围/必跑测试/生产门禁。

本批沿用现有页面样式，不另建设计系统或通用审批平台。保存的 `executable: false` 与全部 execution_blockers 必须原样保留；`current` 只表示在读取时与服务器的当前预览一致，不能证明素材/真实音频/凭据/执行器就绪。后续动态队列必须重新校验，不得直接消费“保存成功”作为付费放行。

本子批次收口：最终相关后端 678 通过/1 权限跳过/0 失败，前端 1032/1032，工作台浏览器 29/29；移动文案边界补测 2/2，构建/静态/功能锁通过，独立规格 PASS 与质量 APPROVE。证据在总报告和 `.codex-staging/execution-plan-review-20260905/verification.json`；只是计划审核保存连接完成，以下主线任务仍保持未完成。

- [ ] 对照实际上传限制、页面文案、Worker 和已验证模型能力，记录一致的格式、时长、尺寸、语言与声音类型支持合同；承诺范围内补实现，范围调整须用户明确确认，不能静默降级或只保留容易通过的输入。
- [ ] 为有音轨无语音、纯静默、背景音乐、多人/画外对白、长对白和跨镜对白分别定义预期状态；保留原始证据及完整时间，不把 ASR 不确定/失败当静默，不删句、不截断输入。
- [ ] 定义可审核蓝图、目标人名/对白/文字、身份/动作素材与生产包的关联：owner、源 hash、版本、审核 hash、稳定镜头 ID、完整对白与素材 hash；修改上游即使旧计划、审核和发布证据失效。
- [ ] 定义能力驱动执行合同：当前验证证据和配置版本、允许时长/尺寸/参考/音轨能力、动态单元及父镜头映射、预算/提交上限、质量暂停与未知停止；不得固定样本角色、数量、语言或首镜 ID。

**退出条件：** 合同与 UI 一致，所有会影响生成的关键歧义有明确处理路径；差异落在本文及总报告，不要求用户靠外部 JSON 补齐核心流程。

### R2d.1：普通角色身份图上传（2026-09-06，本地）

R2c.2 已完成本地双审，机器回执 SHA `e5c674bd6b1c36e95421345e5778e8e0237e7d3413bee9d604b7bc7605a59367`；82 源文件、2 文档、54 工件及父批 36 工件均复核无漂移。以下只推进已有身份图导入接口的普通用户入口，不改模型，不将上传成功等同身份包批准或整套素材准备完成。

**现有合同与最小连接。** `POST /redraw/assets/:id/reference-artifact` 中的 ID 来自当前角色卡的 `redraw_assets.id`；multipart 只含 `file`、固定 `purpose=identity`、当前行 `expected_updated_at`，另传一次操作的 `Idempotency-Key`。owner/version/源归属由服务器查证，不接受用户输入内部资产 ID、路径、Key、模型或 source/version 字段。服务端已有 PNG/JPEG/WEBP 扩展名/MIME/magic/完整解码、20 MiB、宽高各 4096、像素及 SHA 校验；客户端只做相应基础文件预检，不冒充解码验证。成功写入角色主图并撤销相关审核，返回公开 DTO；仍须用户检查当前服务端预览、重新保存身份包并批准。

**文件责任。** 全新实现者负责 `frontweb/src/api/redraw.js`、`frontweb/src/components/redraw/RedrawAssetCard.vue`、新的 `frontweb/test/redrawIdentityUpload.test.js` 与既有 `frontweb/e2e/redraw-workspace.spec.js`；另最小修改 `RedrawAssetStep.vue` 的版本/刷新接线。只读核实该父级的旧 `identity-saved` 不返回异步结果，且 `refresh()` 默认报价，故上传后的无报价只读刷新需显式成功/失败回执；保留原保存包默认刷新合同，并防止旧批次报价绑定新素材继续执行。主代理负责既有后端导入/HTTP 联测的独立验证、功能锁授权登记和唯一计划/报告。其他已脏文件不得回退或顺手重构；前批切镜源码不在此批变更范围。

- [x] **先写真实失败测试。** API 包装 `uploadIdentityReference(assetId, file, { expected_updated_at, idempotencyKey })` 仅发上述 multipart；真实 SFC 选择文件后显式上传、连续双击只发一次、取消不提交、缺少/错误格式/超大小/CAS 缺失不提交。浏览器补精确 multipart 夹具及普通“选择图→上传→读取服务器图片→仍待身份审核”流程，不能仅验证 mock 成功文字。
- [x] **最小实现。** 角色卡显示可选文件格式/大小、选择文件名和明确上传按钮，无需填 ID；选图不自动请求。请求期间禁止相冲突的角色重绘/保存/批准/退回，选图/角色版本/行修订变化、A→B→A 和卸载令迟到响应失效。上传成功只触发既有 `identity-saved` 刷新链，读取当前服务器主图及未批准状态，不自动勾选三视图/真人/年龄/一致性，不自动保存包、批准、报价或生成。
- [x] **失败和刷新。** 400/403/409、网络失败、超时或响应不完整不得显示成功，不自动重发。冲突或结果无法确认时明确提示先刷新当前角色；刷新只读，不重新上传，不以旧版本迟到结果覆盖新版本。成功后等待刷新失败也不能复用旧已批准状态继续操作。图片预览继续用既有鉴权 Blob，不接受响应中的任意公网/本地路径。父级同版本早发晚到的普通刷新也不能覆盖新上传 CAS；上传、未知和刷新未完成期间，批次生成按钮及实际 handler 均阻断，完整当前作用域刷新后才解除，旧 quote/hash 不得恢复使用。只增局部请求 epoch／上传状态接线，保留原保存包默认报价合同。
- [x] **真实合同回归。** 新前端专项与既有身份/素材准备测试通过；现有 `redrawRoutes.test.js` 的 reference import HTTP 场景与 `redrawReferenceArtifactImport.test.js` 真实本地 DB/媒体校验通过，确认 upload→主图绑定→审核失效且零计费。若测试揭露后端缺陷，先记录反例和最小范围，不直接扩张接口。R2d.1 不处理 wardrobe 导入；已有 wardrobe 选择与独立确认合同保持。
- [x] **本地退出。** 规格 PASS 后质量 APPROVE；主代理读取完整实际退出码，完成全量前端、workspace、构建、相关后端及功能锁验证并绑定新文件 hashes。新测试和旧功能均保留，不以旧绿灯代替新字节验证；commit/push/CI/供应商/付费/部署仍不执行。

最小请求示例（代码接口名锁定，内部 ID 由当前角色卡提供）：

```js
await redrawAPI.uploadIdentityReference(asset.id, selectedFile, {
  expected_updated_at: asset.updated_at,
  idempotencyKey: operationKey,
})
```

专项命令：`node --test frontweb/test/redrawIdentityUpload.test.js frontweb/test/redrawCharacterIdentity.test.js frontweb/test/redrawPreparationWorkspace.test.js`；后端导入命令：`node --test --test-concurrency=1 backend-node/test/redrawReferenceArtifactImport.test.js`，HTTP 场景按实际测试名筛选。RED 预期为缺少包装/普通选择上传入口，不能把环境错误记作 RED。浏览器沿用已有 Playwright 本地 fixture，零真实供应商。

**R2d.1 后端前置最小修复。** 页面 RED 已完成（新 Node/SFC 25 fail、邻近 14 pass；浏览器 2 项缺入口 fail），页面运行时暂未改。独立真实 SQLite/双 PNG 探针证明：旧身份包已保存批准后换图，当前 `asset_id=2` 而包内图仍为 1，直接真实 review handler 返回 200 approved；下游参考包/物理准备校验仍拒绝。不能靠前端覆盖 ready 或伪造清包 fixture 解决。选择源头撤销旧确认的最小修复，不扩张中央状态平台：

- [x] 全新后端实现者仅改 `backend-node/src/services/redrawReferenceArtifactImportService.js` 与 `backend-node/test/redrawReferenceArtifactImport.test.js`。用已有真实 fixture 正式 RED 复现“import→saveIdentityPack→approve→换图→未重存再次 approve”误放行；不得以手写已批准 DTO 代替完整前置。
- [x] `purpose=identity` 成功时，在原有 CAS/事务中只删除当前 `source_ref_json` 的顶层 `identity_pack`，保留 source_ref/source 与其余 metadata 和既有媒体行/文件，不建立额外历史表、不假定新图已确认。若原来没有 identity_pack，原 JSON 字节保持。事务使用复读的 currentCharacter；CAS/owner/源键/文件校验失败不改旧包，数据库失败回滚资产/包/导入记录，幂等 replay 不清后来重新保存的新包。
- [x] 正式回归验证：换图后公开 DTO 无当前身份包且 not ready、未重存直接批准被原门禁拒绝且零写入；重新人工保存新包再批准通过；wardrobe 上传保留整个旧包，幂等 replay、同图新操作、冲突/失败原子性、其它来源 metadata 与旧图可读性保持。只处理新的 identity 导入，不宣称修复全部历史错误绑定数据或其它替图入口。
- [x] 原导入 25 项、身份包、review gate 与 HTTP 导入回归通过；规格审查 PASS 后质量 APPROVE，主代理复核运行时 hashes 后解除页面 GREEN。页面接续必须把新测试的旧包 ready=true 假设改为服务端修后真实 DTO；不追加客户端伪校验，不改模型/供应商。

后端前置本地终态：import 40/40，根身份/审批 73/73、HTTP 导入 7/7，feature 32/32 及 HEAD 审计/静态均 exit 0；独立规格 PASS（40/40＋聚焦 15/15）、质量 APPROVE（聚焦 15/15），重叠不累加。service SHA `da9be5251f341952784b8cf19a2e2313eeec68e06694cc817cc4b0b0956ad8a4`，test SHA `cb33dad9c614ff77fdf206f58988854fef4b1523df2c41742103346d79aeeca2`；机器回执 `.codex-staging/r2d-identity-invalidation-verification-20260906.json` 只证明此前后端前置。既有 handler 错误码归一化已列入任务 3 剩余项，不隐去。

随后页面本地退出已通过：正式专项 48/48、根全前端 1212/1212、完整 workspace 40/40、构建及功能锁均实际 exit 0；独立规格 PASS、随后质量 APPROVE，新增独立 Vue 生命周期探针 2/2。S1/S2/S3 三轮失败及旧探针原样保留，最后五源码入退 SHA 一致。最终 `.codex-staging/r2d-identity-upload-verification-20260906.json` 与总报告绑定实际范围；这里的普通身份图上传完成不代表动作准备、默认真实 DB 浏览器全链、语言／人物生成质量或整体交付。下一项优先执行下述音频 unknown 两文件修复。

**R2d.2 动作素材（进行中；草片、上传和显式准备同链已本地退出，真实像素处理未完成）。** 已有镜头 multipart 上传要求当前 shot CAS、静音单视频 MP4/H.264、源尺寸、当前镜头时长 ±100ms，以及用户显式确认四项全帧/遮人物/遮文字/保动作；上传只登记候选，不能直接设 `reference_ready`。母本自动裁片须满足 owner/version/shot/source-hash 的本地产物边界；下列 R2d.2a 已复用本地切段／去音轨核心完成后端，未调用需要 HTTPS/HMAC 供应商 URL 的公共入口，也不得将裁片/静音冒称人物文字已遮蔽。页面在后端双审后接续，不回头重复已完成的 R2d.1。

#### R2d.2a：从当前母本取得本地动作草片（后端先行）

沿已批准的“从当前母本制作动作参考、普通页面预览及人工审核”范围执行。本轮先接真实鉴权裁片，后接页面与待审导入；草片不代表人物／文字已遮除，不登记候选、不改参考包或 `reference_ready`。已有身份上传和音频 unknown 的 87 源／2 文档／17 工件及父回执入场核验全部一致，继续原 worktree，不创建另一份计划。

采用既有 Bearer＋受控 Blob 方式：增加 `GET /redraw/shots/:id/motion-draft`，仅接受 `expected_updated_at`、`expected_source_sha256` 两个 CAS 参数。镜头、版本、作品、当前源资产及范围均由服务端 owner JOIN 得出。复用 `redrawSourceVideoService` 的安全私有源快照和 `redrawSourceConditioningService` 的 FFmpeg 切段核心；不调用需要公共 HTTPS/HMAC 的 `prepareSourceConditioning`，不使用供应商 URL。只在唯一请求临时目录生成静音 H.264 MP4，返回前核验实际媒体与 hash，完成／错误／断连均清理本请求临时资源；不做持久缓存或数据库写入。

**责任：** 本批唯一实现者只改 `backend-node/src/services/redrawSourceVideoService.js`、`redrawSourceConditioningService.js`、`backend-node/src/routes/redraw.js`、`backend-node/src/routes/index.js`，新增 `backend-node/test/redrawMotionDraft.test.js`；保留原 source-video 与 signed provider conditioning 合同。主代理负责功能锁、本计划、总报告与独立回归。后端双审终态前不修改共享页面。

实施兼容核实：`shot.work_id` 是默认空字符串的后加冗余 TEXT，权威归属仍沿现有 `shot.version_id→version.work_id→work` 的完整 owner JOIN；冗余值为空不拒绝合法旧稿，非空则必须匹配实际 work.id。shot CAS 精确比较已有时间串，不强制把历史 SQLite 时间改成 ISO。以上只保留既有数据合同，不迁移或放宽归属。fresh spawn 被当前代理名额限制拒绝，实际复用空闲代理承担唯一实现，规格与质量职责仍独立。

- [x] 真实 HTTP RED：真实注册／Bearer／迁移 SQLite 和 FFmpeg 产生的 MP4/MOV，先因缺路由失败；修复后响应是当前镜头范围的可解码、源尺寸、单视频／零音轨 H.264 MP4，时长容差 ±100ms，实际 SHA 等于响应 SHA。只能说明已裁片静音，不能返回人工审核通过或已绑定素材。
- [x] 绑定与安全：owner/tenant（含已有 active 成员／租户资格）、shot/version/work/asset 软删、源 metadata owner、SHA、源尺寸／范围、shot CAS 及源 CAS 在处理前和发送前复核；未知／重复 query、URL／路径字段拒绝，未初始化租户的拒绝请求也零业务写入。继承源快照的路径／symlink／FD／竞态防护，切片不重新打开未经核验的原片；处理失败或断连不能返回部分成功媒体。
- [x] 生命周期与兼容：不整份 Buffer 读取大源；重复读取不创建 assets/imports/tasks/billing，不读取模型／Key，不发供应商请求。不修改旧母本播放器／签名 conditioning 行为。测试成功、过期、越权、媒体失败、处理中的上游变更、断连与清理，核验全库 SHA／total_changes 不变。
- [x] 先实现者 RED→GREEN，再独立规格→质量；主代理复核原回归、功能锁、源码与完整日志，新增不可变回执。完成此步后仍需普通页面裁片预览、遮除／上传／四项显式审核、服务端绑定及刷新恢复；不得勾选完整 R2d.2 或 R2。

R2d.2a 本地退出：最终正式 30/30、原不可变反例 3/3，独立规格 r3 PASS；随后质量 r2 APPROVE，原撤权探针 2/2＋正式新增两项 2/2，全部真实 exit 0。两次独立发现的非数值资产时长与处理中撤权均有正式 RED→GREEN，原 26／28 项全文保留，旧 FAIL 报告不覆盖。原 source-video／conditioning 完整 57/57 和 routes 154/154 在最后仅 motion JOIN 修复前跑过；旧函数未变可追溯复用，最终字节另跑重点兼容 7/7，不能冒称完整套件在最后 SHA 下重跑。功能锁 34/34、最终审计 ready=true；具体日志、字节、审查限制在唯一总报告及 `.codex-staging/r2-motion-draft-verification-20260906.json`。这只是鉴权静音草片后端，未完成普通页面、候选媒体恢复、人物／文字遮除或转绘质量验收。

后继页面的只读定位已闭合：`RedrawShotStep` 持有完整 `localWork` 与当前 shot/CAS，Editor→ReferenceBundlePanel 尚未传这些对象，后者只有 state/saving。shot 的 `source_video_ref` 没有 SHA，必须使用 work 的 `source_fingerprint`，不信任 static URL。既有 motion import 最新候选由服务端 owner/version/shot 选择，准备流程经 clean_results→bindReadyMotionReference→trusted bundle 自动绑定，不需要用户输入 motion ID；但此准备流程可能付费，裁片／预览／上传不能自动调用它。已有 bundle watcher 不监听 updated_at，后续上传成功须显式纯 GET 刷新并处理迟到状态。没有动作候选媒体 GET，图片 preview 不能复用为视频；刷新后候选预览仍是未完成项。继续实现时先补该实际媒体边界，再以普通用户角色、严格 API fixture 和真实后端分别验收，不能仅以源码字符串测试代替 UI。

后继候选恢复预览的额外合同：导入事务不改变 shot.updated_at，成功 DTO 只有白名单 asset 媒体字段和零费用，不能以 shot CAS 独自区分连续上传的 A／B。后续状态与视频读取必须绑定当前候选身份／文件 SHA，且已绑定 ready 的候选仍可预览；不能调用会写 metadata 的 bind 方法或把 import 重放当 GET。现有最新候选查询会跳过已删除 asset 回到旧记录，故还须明确并测试最新导入被删除时的显示策略，不能无提示恢复旧素材。当前私有 scope 校验不涵盖源尺寸、reviewed_by 和实际文件全部检查，须复用真实文件安全读取补足；上述只读定位不代表入口已实现。

#### R2d.2b：恢复当前动作候选与鉴权媒体（页面的最小前置）

沿已批准的参考素材导入设计，先补刷新所需的两个只读接口，再接普通页面。不新增候选表、审核平台或供应商能力；复用已经真实解码后导入的可信媒体及 SHA，不在每次预览时重新转码、复制文件或执行 ffprobe。读时核对导入记录、严格媒体 metadata、实际文件大小与完整 SHA；返回同一已核验 FD 的字节。这里证明与已校验导入字节相同，不把用户四项声明等同自动视觉验证。

- [x] `GET /redraw/shots/:id/motion-reference`：只接受且各一次 `expected_updated_at`、`expected_source_sha256`。owner/active tenant/member/shot/version/work/source 归属由服务端取得；返回 `{shot_id,version_id,shot_updated_at,source_sha256,status,candidate}`，status 为 `missing|available|unavailable`，candidate 仅 available 时含 `{import_id,asset}`，asset 沿既有导入白名单。available 仅表示候选可恢复预览，不是 `reference_ready`。最新 completed 导入资产删除、文件损坏或语义过期时 unavailable，不回退旧素材。
- [x] `GET /redraw/shots/:id/motion-reference/media`：另要求各一次 `expected_import_id`、`expected_file_sha256`，防止同 shot CAS 下上传 A/B 的预览串片。只从最新 completed 导入取资产；已绑定 ready 的候选仍可预览。未知参数、路径、外部 URL、客户端指定 asset/version 拒绝；参数错误 400，归属/撤权不存在 404，CAS/候选变化 409。响应 video/mp4、完整长度与 SHA、private no-store/nosniff；不暴露静态 URL、路径、Key、原始 metadata。
- [x] 严格核验当前源尺寸/范围、有效媒体数值、来源/owner/version/shot/source 绑定、四项人工声明及服务端 reviewed_by、导入和资产 SHA。物理文件必须在已批准 storageRoot 内、无 symlink/path escape，按小块哈希，不把整个 200 MiB 文件装 Buffer。状态与媒体在读取后复核资格/当前源/候选/文件，媒体使用同一已核验 FD 并在发头前再次确认；成功/错误/断连都释放自身句柄。GET 不初始化租户、不写 DB、资产文件或临时文件，不调用 import replay、bind、prepare 或供应商。
- [x] TDD 使用真实 HTTP/Bearer、隔离 SQLite、实际导入的 FFmpeg MP4：missing→上传→可预览→刷新→换图/候选 A/B 冲突，已绑定候选预览、删除最新不回退、owner/active membership/CAS/篡改/路径及断连；对实际响应 bytes/hash/ffprobe 和库 total_changes/资产目录不变作断言。保留原导入/草片回归。先规格、后质量，主代理验证后再解除页面依赖。

本批实现者只拥有 `backend-node/src/services/redrawReferenceArtifactImportService.js`、`backend-node/src/routes/redraw.js`、`backend-node/src/routes/index.js` 及新增 `backend-node/test/redrawMotionCandidate.test.js`。原 import/bind/prepare 行为保持；主代理拥有功能锁、唯一计划/报告与独立验证。物理读取若无法满足该窄合同，应先报告具体问题，不扩张读接口为新转码系统。后续普通页面包括草片/当前候选播放、选择处理后的 MP4、四项显式确认、上传和刷新恢复；不要求用户输入 ID/JSON，不自动调用可能付费的 preparation。

旧三套回归 108 项中唯一失败为原导入测试精确枚举只允许三个导出，与本批新增窄 reader 合同不一致；不是原导入行为失败。主代理仅接管 `backend-node/test/redrawReferenceArtifactImport.test.js` 的该枚举，追加 reader 名称及其空上下文拒绝断言，原三个函数及其错误断言保留，不隐藏导出绕过测试。旧失败日志原样保留；修后重新验证，不把 107/108 称全绿。

页面连接先行 RED 的范围仅为 `frontweb/test/redrawMotionReferenceApi.test.js`，不修改运行时、不将后端非终态当可用依赖。冻结四个薄包装：`getMotionDraft(shotId, identity, {signal})`、`getMotionReference(shotId, identity, {signal})`、`getMotionReferenceMedia(shotId, identity, {signal})`、`uploadMotionReference(shotId, file, {expected_updated_at,idempotencyKey,...四项布尔审核})`。前两 GET 只发 shot/source CAS，媒体 GET 多发 import/file SHA CAS；视频用既有鉴权 Blob、所有请求 silentError，支持取消，不透传额外输入。上传只用 multipart file/CAS/四项显式布尔和稳定 Idempotency-Key，不调用准备/生成、不重试失败。等 R2d.2b 双审终态后再实现与页面一起验收，不能以 API 包装代替可用页面。

#### R2d.2c：普通动作素材入口（后端双审后接续）

前置 R2d.2b 已于本地退出：主代理新旧四套相关回归 134/134、功能锁 35/35、syntax/HEAD 审计 exit 0；独立规格 PASS（26/26＋3 探针＋导出 1/1），随后质量 APPROVE（4/4 断连/EIO/旧稿探针）。源码三文件只新增 reader/handler/注册，逆向还原与上一批原字节一致；旧测试仅补窄导出合同。回执 `.codex-staging/r2-motion-candidate-verification-20260906.json` 绑定本批源和证据。页面 API 仍为 5 项真实缺接线 RED，前端运行时未改，接续从此处开始；不回头重做草片或候选后端。该后端退出不代表完整 ready 绑定、200 MiB 压力、页面、视觉净化或最终交付完成。

最小页面范围为已有 `api/redraw.js`、`RedrawShotStep.vue`、`RedrawShotEditor.vue`、`RedrawReferenceBundlePanel.vue`。ShotStep 持有远端候选、作用域请求 epoch 和上传冻结，Editor 只转发，Panel 负责本地选择/播放/四项确认。复用现有样式与组件，不新增页面平台；高级参考包 ID/JSON 编辑折叠且不作为普通必经路径。该包只关闭草片预览、人工处理后 MP4 上传、已确认候选恢复，**不关闭自动遮人物/文字或完整素材准备**。

- [x] 显式草片预览用鉴权 Blob，明确“仅裁片静音、人物和文字未遮除”，不自动选文件或确认。用户选择 MP4 后本地预览，取消零 POST；四项初始 false，换文件/镜头/源/CAS 清空。真实 upload 仍由后端检查编码/音轨/尺寸/时长，页面不能伪造 ready。
- [x] 选中待替换文件、上传中、等待刷新或未知时，按钮和单镜/批量/队列实际 handler 都受同一冻结条件约束；未提交的取消可撤销选择锁，已提交不能靠切镜取消。明确一次 multipart 幂等提交，零自动重发、prepare、quote 或生成。
- [x] 上传确认后使用本次新 `GET work→当前 shot/source CAS 的 candidate GET→bundle/generation-gate GET→候选 media`。不调用含 POST quote 的 `loadPreparationWorkspace()`；不把可能因 pollRequestActive 早退的 `refreshWork()` 当真实刷新屏障。当前候选 id/SHA 必须匹配 bundle.motion_reference 才能恢复既有生成 gate；available 不等于 ready，旧 A ready 不能放行新 B。
- [x] 局部递增 epoch＋work/version/shot/CAS/source 绑定，GET AbortController、Blob URL revoke、卸载释放；A→B→A 不接受旧轮结果。上传锁保留在 ShotStep，不随 Editor 切镜丢失。未知提交只读核对，GET 旧候选不能证明 POST 未落地；不自动解除未知或允许再上传。刷新后安全阻断使用按用户/租户/作品/版本/镜头划分的 sessionStorage pending marker，仅存操作身份与阻断标记，不存文件/ready/Key；该标记不证明操作已终止。人工同幂等键重放与未知操作最终对账另列恢复缺口，不能用 fixture 虚构后端操作状态。
- [x] 普通用户 strict API 浏览器用真实可解码本地 MP4/Blob 验证草片、选择取消、四确认一次上传、纯 GET 刷新、刷新页面同候选恢复、A/B 同 CAS、409/unknown/刷新失败/切镜/ABA/卸载，missing/unavailable 无旧素材回退。Node/SFC 测试不能替代真实浏览器，fixture 不代表默认真实后端完整链；待默认后端同链验收再关闭相应总门禁。

独立只读映射已完成上述状态边界，后续不重复扫描或新增平行设计。按 API/组件 RED→GREEN、独立规格→质量、主代理浏览器和回归退出；旧 JSON 高级通道、付费 preparation、自动遮除仍须按总计划单独验收，不把隐藏字段当功能开发完成。

首次独立规格审查复现四组阻断：候选 GET 未终态时旧 ready 放行、候选缓存未完整绑定当前 source/CAS/version、队列按钮与重试未共享门禁、子组件被动清理取消父级新候选读取。原实现者按正式反例修复，最小页面范围追加 `RedrawGenerationQueuePanel.vue` 的冻结属性接线，不新增队列平台。主代理真实浏览器已复现 pending 按钮与 A→B→A 预览问题；报告和失败日志保留。四组修复并重新规格 PASS 后才进入质量审查，以上五项仍不勾选。

规格 r3 已通过后，独立质量复现：shot 1 上传 unknown 留下 marker，切 shot 2 仍能新增第二次上传。按本包“未知时只读核对、不允许新增上传”合同，同 user/tenant/work/version 的待核对上传须同时阻断跨镜选择/上传 UI 和 upload handler；不是套用供应商单次付费次数，也不扩大为跨作品锁。未提交 selection 仍可首次上传/取消，unknown 与已确认 awaiting-refresh 保留不同语义。该窄修复再次 SPEC→QUALITY 终态前不勾选本包；主代理真实浏览器也已复现 input 未禁用，旧日志保留。

R2d.2c 最终本地退出：规格 r4 PASS，随后质量 r2 APPROVE；两者独立 59/59，原 unknown 跨镜反例由 uploadCalls/marker 1→2 变为始终 1。根最终转绘前端 411/411、工作台浏览器 51/51（含 11 个动作素材用例）、功能锁 36/36、公开构建与审计均 exit 0；16 文件冻结及父 20 工件无漂移。仅勾选本节五个局部条件；正式视觉比对因缺少批准基准未执行，默认后端完整准备、自动遮除、未知最终对账与总 R2–R8 仍未完成。机器回执为 `.codex-staging/r2-motion-ui-verification-20260906.json`，旧失败证据全部保留。

#### R2d.2d：已确认动作候选到真实参考包就绪（后端、页面同链及独立双审本地退出）

严格等 R2d.2c 独立规格与质量终态后实施，不重做草片/候选接口。只读已定位三个断点：已成功上传的 `awaiting-refresh` operation 要等 bundle 匹配才清除，却先挡住唯一显式 prepare；prepare 会更新 shot CAS，旧上传 CAS 不能直接复用；`isCurrentReady` 未比较最新导入候选，A-ready 上传 B 后仍可能 reuse A，跳过绑定。

复用 `RedrawShotPreparationPanel → startReferencePreparation → reference-preparation-quote/reference-preparations → redrawReferencePreparationOrchestrator.executeShot → bindReadyMotionReference → buildTrustedReferenceBundleInput/saveReferenceBundle`，不新增接口、准备引擎或模型目录。主要责任范围是 `redrawReferencePreparationOrchestrator.js`、`RedrawShotStep.vue` 及其现有相关测试；artifact import 的纯读取/绑定仅在现有窄接口确实不能满足合同后说明必要差异，禁止复制安全校验。

- [x] 先真实后端隔离 DB/导入/本地媒体 RED 复现 A-ready→B 被旧 ready reuse，以首次候选真实绑定作正例；页面另以 RED 复现已确认上传后无法显式开始准备。最小修复最新候选与 bundle 的一致性，保留有效旧参考的兼容，不把所有已有 ready 一律作废。
- [x] 已明确 POST 成功、当前候选身份/源已核对但尚未绑定时，仅开放用户显式报价和确认准备；上传中、未知、漂移仍阻断，生成仍要求真实 bundle/候选一致。上传回调不自动 quote/prepare，不靠删除 marker 或伪造 ready 解锁。
- [x] 显式准备完成后，以同 owner/work/version/shot/source 的受控响应采纳新 shot CAS，再 fresh GET work/candidate/bundle/gate；绑定身份变化或迟到响应拒绝，不把任意新 CAS 当作原操作完成。
- [x] 实际 `clean_results` 全部可复用时证明绑定完成且零 provider/零新增扣费预留；缺失净景仍走既有明确报价确认合同，本地测试只替换低层供应商，不作真实付费。首次 ready 和 A→B-ready 均核验库中 bundle/evidence/asset ID/SHA，不以 202 或 available 代替。补普通页面和默认后端联测、SPEC→QUALITY 后再勾选，不等于自动人物/文字遮除已完成。

执行顺序固定为两小包：先由全新实现者只改后端 orchestrator／原 orchestration test，实际导入/绑定及 A→B 复用问题经 SPEC→QUALITY 退出；再接已有页面的显式 prepare／受控新 CAS 并做默认后端同链验证。后端非终态时不并行改页面消费者。主代理仅负责该阶段功能锁历史、唯一文档及独立回归；不新增第三运行时文件，若现有 reader 确实不够须先提出具体必要性。motion 最新候选身份只用于准备报价/执行一致性，不混进净景依赖导致已合格 clean_results 被无谓重做。

入场证据：R2d.2c 回执 SHA `4008612eb29f5ef6b7076519b918a0fa00d3f8e6dde6b2cf551fa389f2777a11` 的 137 个引用全部复核一致后才启动；原 preparation orchestration 54/54、0 skip、exit 0。根仅对实际触及的 `redraw.product-media-http-chain` 追加本地授权，完整历史回放恢复原清单 canonical SHA `39015bcaa464cb34ce86159327b9750d3f7976c3448791b9d4c3071ae4541cae`；授权测试 RED→37/37、exit 0，不代表运行时修复完成。

真实 RED 后已确认必要的第三运行时范围：`redrawReferenceBundleService.js` 的 trusted builder。现有 `currentMotionAsset` 对所有同绑定资产要求恰好一项，正式保留 A 后绑定 B 会因两项匹配而失败。仅增加服务内部可选 `motion_reference_asset_id`，由真实 bind 返回 ID 传入并复用 `assertMotionAssetCurrent`；未提供仍按原唯一选择，`buildCurrentReferenceBindings` 输入合同不扩张。保持 A 行/文件不变，补非法/越权/坏绑定 ID 拒绝以及 bind 到 builder 间最新候选漂移保护；不新增前端 ID、路由、表或供应商。该第三文件已在同一 product-media 功能锁内，未再解锁其他功能。实施者仍独占本包源/测试，主代理独立回归原 bundle suite。

本包新发现的两项阻断必须先收口，不提前开页面：独立 SPEC 的最后 FileHandle.close await 窗口可在 B 导入完成后仍复用 A；原实现者补正式竞态 RED 和最后 await 后同步数据库绑定快照复核，不重开媒体回环。另一个真实 HTTP 500 不是仅测试噪声：默认蓝图 `sourceShotRecord` 和本地化 `shotParams` 均传 `Number(workId)`，SQLite TEXT 可保存 `1.0`，而草片/候选 reader 严格文本比较 `1` 拒绝合法同作品。主代理只补 HTTP fixture 的源 owner metadata，保留数字 bind 和全部旧断言，仍真实 RED；禁止改为 String(workId) 隐藏该产品可达问题。

- [x] **前置 ID 兼容窄包。** 当前 cleanup 三文件冻结后，再由另一实现者拥有 `redrawSourceVideoService.js`、`redrawReferenceArtifactImportService.js` 和原 `redrawMotionDraft.test.js`／`redrawMotionCandidate.test.js`，真实 HTTP/隔离 SQLite/MP4 RED→GREEN 仅修同一合法作品 ID 的 SQLite 存储表示比较。保留原空 work ID 兼容及 owner/active tenant/member/source/shot/version/CAS/文件安全检查；不同作品、非数字、小数和不安全整数仍拒绝，不改 writer、全局 ID 框架或生产数据。根旧 HTTP 数字 bind 用例必须真正恢复；依赖非终态时不并行改 reader 消费者。
- [x] **组合再审。** cleanup 与 ID 兼容均冻结后，原不可变 SPEC 探针、正式 preparation、原导入/草片/候选/参考包/准备门禁与产品 HTTP 回归通过，再独立 SPEC→QUALITY；本包不因旧 63/63 或其他 141/142 而放行。

第一后端子包最终退出（2026-09-06）：ID 合同真实 RED 4 pass/2 fail → GREEN 6/6；作者新旧五套 191/191 的工具终态如实摘录，不冒称原生 TAP。根原产品 HTTP 数字 bind 已实际 1/1 GREEN，最终六套组合原生 TAP 为 **212/212、0 skip/cancel、exit 0**；功能锁 **37/37**、审计 ready=true/11 features/65 tracked changedPaths、scoped diff-check 均通过。原规格反例重新独立 3/3、正式竞态/ID 10/10、HTTP 1/1 后 **SPEC r2 PASS**；其后全新质量审查者独立 25/25、原探针 3/3、HTTP 1/1，**QUALITY r1 APPROVE**。根亲读两报告和原生日志、核对冻结后才勾选这两个后端前置项，不勾选上面仍含页面条件的四项或整个 R2d.2d。

回执 `.codex-staging/r2-motion-preparation-binding-verification-20260906.json` 绑定 104 累计源、两份当前文档、本包新旧通过/失败证据及父 UI 回执。父 100 源中仅声明的 6 项变化，另新增 4 项进入累计快照；父 34 工件和 1 个 parent 引用无漂移。下一动作严格为同一 R2d.2d 页面子包：正式 RED 复现已确认上传阻断显式准备，最小接通 awaiting-refresh 与受控新 CAS，再走真实浏览器/默认后端同链和独立双审。继续本地执行，不重新验证模型、不增加供应商或 Git/生产权限。

第二页面子包入场（2026-09-06）：后端回执的 151 个引用复核无漂移，当前 HEAD `8c49a90773a4311992e4eb9b6a5bc2c9acdfa4ed`，三套前端基线 60/60、exit 0。全新页面实现者仅拥有 `RedrawShotStep.vue` 与 `redrawMotionReferenceUpload.test.js`；独立浏览器实现者仅拥有 `redraw-backend-integration.spec.js`，先封闭测试公网出口再运行真实隔离后端链；根维护本计划／报告及独立回归。实际清单逐路径核对表明本包三个文件均未在 `protectedPaths`，不重复追加无关功能解锁；仍执行完整历史测试和现有审计。

页面正式 RED 已复现：上传成功且 fresh work/candidate/bundle/gate/media 后，显式 prepare 实际调用 0，预期 1；原 60 项仍通过。作者据字段检查提出 NEEDS_CONTEXT 并保留 RED，未直接放宽 CAS。根亲读默认服务确认：任务 GET 的 completed、quote_hash 和目标镜头集合可证明本次确认请求终态，但不公开最终 shot CAS。这里的受控采纳不新增“任务返回最终 CAS”的合同：仅对本次明确 POST 返回的 task ID，核对 owner/type/resource version、metadata/result 的 quote 与快照、目标镜头及无 failed/needs_attention；再核对 fresh work 的同 owner/work/version/source 和镜头非准备业务内容未变，只有实际准备流程可改的状态／bundle／CAS 字段允许变化。新 CAS 下 candidate import ID、上传 asset ID/SHA、bundle、gate 和可读媒体仍须全部匹配，且视图／操作 epoch 未失效。两个证据同时成立才采纳当前 CAS，不声称该 CAS 直接由任务回执提供；普通轮询、202、未知、任意业务字段漂移和迟到响应不能解锁。本次只读独立检查还将检验这一最小政策，发现反例先修政策而非增加接口。

独立只读完成政策检查（`motion_prepare_completion_check`）已 PASS：上述双证据可以使用现有接口满足本节，不天然阻断默认产品流程。页面直接复用已有 `taskAPI.get`，不新增 API 包装文件；业务不变比较只针对公开 shot 投影，不能声称验证未公开数据库列。此结论没有运行测试，也不替代实现后的 SPEC／QUALITY 或通用 task 路由访问控制审计。

页面作者冻结后，根补一个必要的测试范围修正：原 `redrawShots.test.js` 将整份 SFC 的任何 `task_id` 读取都当成生成 payload，真实 RED 拒绝了本次合法只读任务回执。根只把原危险字段规则限定到三个实际生成 handler，保留原禁用字段和全部旧断言，并对 3×5 个危险字段注入做探针，18/18；没有拆分任务字段字符串掩盖问题。此第四文件仅属测试，不新增运行时或功能解锁。根全部转绘前端 466/466、0 fail/skip/cancel、exit 0；浏览器同链及独立双审仍须通过。

最终本地退出（2026-09-06）：浏览器 r4/r5 修正隔离 owner 前提，r6 修正真实当前租户 header 后，复现首次缺参考包的 HTTP 404 中断页面 fresh barrier。以下窄修复正式 RED→GREEN 已完成，作者 r7 与根独立 r8 同链各 1 passed、exit 0；r8 留存原生 JSON/截图 body/trace。新全前端 487/487、功能锁 37/37+audit ready、公开模式编译均通过。没有 seed 目标 bundle、伪造 ready 或修改后端权限。新 SHA 独立 SPEC r2 PASS 后，全新 QUALITY r1 APPROVE，局部 135/135。初报的 Blob URL leak 经同步 CAS watcher 控制流及独立 probe 验证为误报，已撤回且未增加重复清理代码；根复跑 probe exit 0，确认 completion 释放旧 URL、卸载再释放新 URL。四个页面条件据此勾选，累计回执为 `.codex-staging/r2-motion-page-preparation-verification-20260906.json`。正式视觉仍 BLOCKED_PREFLIGHT；真实登录、供应商质量、自动遮除、R2 总体及 R3–R8 均不因此完成。

**首次无包窄修复（同一页面子包）：** 仅原 SFC 与 MotionReferenceUpload 测试。以真实 Axios `response.status=404` 且 `response.data.error.code=REDRAW_REFERENCE_BUNDLE_NOT_FOUND` 复现上传后无法显式 prepare 的正式 RED。只对本次明确 POST 成功的 awaiting-refresh 上传、fresh work/current candidate 已一致且当前 shot 明确 `reference_bundle_hash=null`／`reference_bundle_updated_at=null` 的读屏障，将此精确错误作为“尚无包，ready=false”；缺字段或已有登记字段不能冒充已证明首次无包。仍须 gate 同版本、媒体可读、owner/source/import/SHA/epoch 与原操作匹配后才允许显式报价确认。其它 404、403、409、500、网络/身份/候选漂移继续冻结；已有包损坏或无本次确认上传不新增例外。任务完成的 fresh 校验仍必须拿到真实 ready bundle，缺包不能解除 marker。不得新增后端/API、fake bundle/hash、自动 POST、降低权限或媒体断言。新实现者正式 RED→GREEN 冻结后，原浏览器用例原样再验，再由独立 SPEC→QUALITY 收口；此前作者 114/114 与根 466/466 保留为旧快照，不当作新修复验证。

本后继步骤仍仅本地开发/测试；prepare 只允许在隔离 fixture 内运行，不授予真实供应商/Key/生产/部署/Git 权限。动作参考完整准备退出后，继续长音轨与多输入支持、R3 执行恢复及 R4 合成导出；其余 R5–R8 顺序不变。

下一项只读入口盘点（不启动后继运行时）：真正改像素的 `fuminCharacterNeutralMotion.mjs` 当前只是固定 496×864/24fps 的全帧降采样/模糊/灰度；其 CLI 仍锁固定母本 SHA 与样例镜头，不是当前 owner 源片产品入口。`run-redraw-full-frame-coverage-local.js` 与 `redrawFullFrameReviewService.js` 会生成/修订真实逐帧 PNG 遮罩，但不把遮罩应用成视频；Worker detector 只产检测/跟踪，未提供本轮模型 ready 或净化质量证据。因此下一批要补的是当前源快照/审核覆盖到待审动作产物的生产者，不再重做已接通的上传/候选/prepare。首个本地反例应使用非固定 SHA、非固定尺寸的真实片段，检查实际像素处理、尺寸/时长/静音合同，不能原样复制草片或仅凭 ffprobe 宣称人物/文字不可辨。具体处理合同仍须在同一计划内核定，质量审查未收口前不修改后继代码；本盘点不是已执行的新媒体测试。

**本次收口后的唯一下一步顺序：** ① 将上述真实像素处理生产者的输入快照、审核遮罩、输出待审和失败清理边界具体化，先做非样片的正式 RED，再最小实现及 SPEC→QUALITY；② 补原一小时支持所需的长音轨窗口、整句/说话人/绝对时间证据合并；③ 收口 MP4/MOV/ZIP 与页面/资源限制一致性。三项完成前不跳入 R3 动态执行。随后按总表依次 R3 防重执行恢复→R4 审核/音轨合成导出→R5 多输入完整回归与获授权后的精确 HEAD CI→R6 真实多输入→R7 同项目恢复导出→R8 用户移交。既有活跃目标继续有效，不新建重复目标，不将本次阶段退出标成总交付。

#### R2d.2e：当前源片的动作去身份处理——采用局部遮挡方案

2026-09-06 本轮只读进展：重新核对 HEAD `8c49a90773a4311992e4eb9b6a5bc2c9acdfa4ed`；父页面回执 SHA `d05c5eeee2cb7dad25ae42dca9faf19d7be0f47df404f38264fcba1972ce46a1` 的 104 源、157 工件、1 父回执共 262 项仍一致。本节是上述下一生产者的具体方案选择，不是新平行计划；未修改运行时/正式测试，未开始媒体生成。原父回执所记录的文档快照保持历史含义，本节新增文档不覆写旧证据。

**新证据改变了直接复用方案：**

1. `redrawFullFrameReviewService.validateReviewedCoverageManifest` 只验证 reviewed 覆盖；manifest 自身必须 `approval_status=pending/ready_for_reference=false`，不含 owner/version。用户批准在 owner-scoped `redraw_assets` 及 source_ref snapshot，不能把 manifest 的 reviewed 当用户批准。
2. 审核 PNG 是同尺寸二值保守覆盖；原生成和人工 polygon 修正都可能使用外接矩形，格式/哈希验证不证明精细轮廓。旧规格 `2026-08-15-redraw-full-frame-person-text-audit-design.md` §5.3/§13 明确不允许把它直接称为净景生成遮罩。新的动作去身份区域须具有独立派生含义和输出审核，不能篡改旧资格。
3. `loadReviewedReferenceCoverage` 对完整证据做验证，但只返回代表帧净景 requirements/绑定；每条轨迹只选一条 region，不返回连续 frames/masks。`loadReviewedReferenceCoverageBinding` 更只是轻量绑定，不能单独验证渲染输入。
4. `projectReferenceBundleForGeneration` 当前仅将身份图和动作视频投影给生成器（源码 1285–1322），没有把净景图加入 `referenceImageUrls`。因此“全帧模糊动作＋已有净景补背景”目前是未经实现的假设；不能因 bundle 内有净景证据就宣称模型已消费净景。

**三个方案及建议：**

| 方案 | 对当前产品的影响 | 选择建议 |
|---|---|---|
| A：逐帧局部去身份动作参考 | 从当前源快照和用户已批准的全帧人物/文字轨迹派生独立处理区域，局部降采样/模糊，保留其余场景和时间轴；需要可信逐帧投影、PTS 对齐及处理后人工审核。不是生成式补背景或精细 inpaint 遮罩。 | 推荐。与目前“身份图＋动作视频”的生成输入匹配，不依赖未传入的净景图补偿背景。 |
| B：全帧低细节动作＋独立净景参考 | 可复用固定样片的滤镜思路，但必须同时补净景生成投影、参考数量/能力规划和实际生成质量，否则全帧背景细节丢失。 | 本轮不直接采用；不能仅去掉固定尺寸常量就称通用能力完成。 |
| C：新增视频修复/姿态重建模型 | 需要新的模型、依赖、像素与动作质量证据及相应授权，不能假设现有供应商具备该能力。 | 不作为本轮本地补连接的默认方案。 |

**推荐 A 的用户可见合同：** 输入是当前项目已批准的完整人物/文字盘点；系统生成的动作预览会将这些区域变成低细节影像，其余画面保留场景。它不是最终演员视频，不承诺原人物已被真实替换；目标演员由后续既有生成阶段产生。模糊可能损失细小肢体动作，因此必须逐段检查“原身份不可辨、原文字不可读、动作仍可用”；不合格停在待审，不以文件可读自动放行。若用户要求动作参考本身是完整精细无人物净景，应选另一个独立生成式处理设计，不能把 A 换名冒充。

**A 获确认后必须落实的边界：**

- 复用当前私有源快照及 owner/active tenant/member/版本/源 SHA/shot CAS 校验；完整 reviewed validator 与 DB 用户批准同时成立，重新绑定 source/facts/analysis/shot range。不接受浏览器传文件路径、遮罩资格、Key 或模型；不复制一套权限校验，不改变旧草片与上传行为。
- 单独导出只够当前镜头处理所需的可信逐帧投影。使用源 `frame_index`、`timestamp_ticks` 和有理数 `time_base`，按源帧展示区间与 `[start_ms,end_ms)` 的正长度交集对齐；镜头起点在一帧内部时不能仅按时间戳筛选而丢首段。不从固定 FPS 或代表帧推断全段覆盖，不复用固定母本、角色、496×864 或 24fps。缺帧、应有轨迹却缺区域、未解决轨迹、漂移和未知均拒绝生成“已处理”产物；已明确无人/无文字的帧允许区域集合为空，不能将空集合一律当故障。
- 人物（含背景群演）和文字区域逐帧合并，建立独立 `motion_obscuration` 派生记录；记录规范处理策略、源/覆盖/帧区域集合及输出哈希，不把保守审核 PNG 标为 fine mask。源和所有历史遮罩/候选只读保留。
- 输出维持本次源尺寸、显示比例、镜头时间和运动顺序，去除音轨；变帧率、奇数尺寸或无法无损表达的边界不得静默裁剪/补帧/加速或降级成固定尺寸。实际处理失败、取消或上游漂移不注册通过状态，清理仅本次私有临时资源。
- 输出只到待审预览，四项人工确认不得预勾、不得写 `source_identity_obscured=true` 等已通过声明。人工检查后复用现有导入和显式准备链；保存前再次核对当前源/覆盖/产物 SHA，不能跨旧预览批准。这里不自动报价、生成或调用供应商。
- 首个正式 RED 必须使用非样片 SHA、至少横/竖两个不同尺寸的真实移动合成片段及非均匀 PTS：断言遮区真实像素变化、非遮区与等编码基线场景一致、原时间轴/帧顺序/音轨/hash 合同。另覆盖范围/权限/哈希漂移、取消/清理，以及页面预览/拒绝/批准/切镜失效。技术测试、人工去身份检查和真实生成质量分开记录，只有 SPEC→QUALITY 通过才退出本包。

独立设计 critic 已认可“局部去身份、保留非敏感背景”的推荐方向，未发现所读规格将全帧模糊列为唯一实现；同时指出全帧模糊不能靠尚未接入的净景投影补偿。此结论仅是设计挑战，不是功能 SPEC/QUALITY 或实际画面通过；本节 A/B 名称以本表为准。主代理自检另明确镜头起点落在帧内和合法空区域语义，未改变支持范围。

历史入场曾按 brainstorming 技能停在效果取舍确认。2026-09-06 用户在收到推荐方案和六组缺口报告后要求“规划好剩余6项-工作 全量推进”，本轮按推荐 A 开始本地执行，不再次索取相同开发方向的确认。该指令不使真实付费、Git 推送或生产操作自动获准。服务端可信逐帧输入→实际像素处理→页面待审连接依次 TDD、SPEC、QUALITY；R2–R8 仍须各自证据，不提前勾选。历史只读入场回执 `.codex-staging/r2-motion-processing-design-entry-20260906-r1.json` 保留。

### 2026-09-06 六组剩余工作：统一执行清单

本清单是最新执行视图，与上方 R1–R8 和下方任务 1–6 交叉对应，不另建平行计划。当前用户要求覆盖全部六组；可自行解决范围内实现/测试问题，不按每个函数反复请示。遇到新付费、外部写入、改变产品支持范围或真实效果取舍时，保留现有状态并明确提出所需决定。2026-09-07 目标工具实时回读为 active，继续完整目标；先前 blocked 记录只作为历史状态，不作为本轮不执行的理由。

| 顺序 | 交付组 | 执行与通过条件 | 状态 |
|---|---|---|---|
| G1 | 动作参考自动处理（R2d.2e） | 当前源与批准覆盖绑定；逐帧局部人物/文字降细节；原时间轴、场景、比例不被全帧模糊破坏；页面预览和四项人工确认后才可准备 | G1.1/G1.2/G1.3a/G1.3b 本地双审与页面链完成；人工效果及真实内容质量待验收 |
| G2 | 长音轨（R2） | 在既有 1 小时上限内有界提取/识别；全窗口源绑定、接缝整句、稳定说话人及绝对时间；任一未知不发布不完整证据 | 未完成 |
| G3 | 多输入合同（R2/R5） | MP4/MOV/ZIP 默认入口与页面限制一致；ZIP 全作品可达且解压有资源上限；横竖、无轨、背景音乐、多人、跨镜矩阵走当前上传媒体 | 未完成 |
| G4 | 动态执行与恢复（R1b/R3） | 不可变计划外关联运行状态；真实产品领取/生成/首候选待审/续行/逐单元 QA；刷新重启无重复提交，未知全局停止 | 未完成 |
| G5 | 声音、合成、导出（R4） | 子单元归并父镜，原生音轨或已批准配音贯穿审核发布；保留完整对白和构图；页面 MP4/字幕/报告 hash 闭合 | 未完成 |
| G6 | 全量验收与移交（R5–R8） | 本地全量回归与双审→获准后的同 HEAD CI→独立新视频真实质量→同项目恢复导出→用户新视频接受 | 未完成 |

执行规则：一个实现子代理独占当前写入文件；独立只读源码映射可并行。每包先记录预期 RED，再最小 GREEN、相关回归、独立 SPEC→QUALITY，主代理重新运行并核对实际差异。修复/审查通过才进入下一依赖包。只在下列对应项目全部完成时勾选整组，不以测试数量折算完成率。

#### G1.1 当前镜头可信逐帧输入（首包）

**文件责任：** 最小扩展 `backend-node/src/services/redrawReferenceBundleService.js`；新增 `backend-node/test/redrawMotionCoverage.test.js`，如需共享仅新增该测试专用 `backend-node/test/helpers/redrawMotionCoverageFixture.js`。不改旧 reader 的行为，不改 Worker、模型、路由、页面或数据库结构。主代理独占功能锁授权记录和本计划/总报告。

- [x] RED：通过真实迁移/隔离 SQLite、真实 reviewed JSON 和 PNG/mask 调用新导出 `loadReviewedMotionCoverage(ctx, { shot_id, expected_updated_at })`；首个测试断言其为函数，随后覆盖读取结果和拒绝分支。预期缺少导出导致失败，禁止 mock owner、批准或完整 validator。
- [x] GREEN：复用 `coverageScope`、`coverageEvidenceRow`、`readCoverageManifest`、`validateReviewedCoverageManifest`、`assertCoverageMatchesVersion`；读取当前所属 shot，并校验 active tenant/member、work/project/version/shot owner、源资产归属和源字节 SHA、shot CAS。只读，不登记资产/任务/预算。
- [x] 返回服务器私有 `redraw-motion-obscuration-input-v1`：owner/version/work/shot、source asset/hash、facts hash、coverage analysis/file hash、批准者/时间、shot 起止/CAS、源尺寸/time_base，以及按源帧展示区间与 shot 的正长度交集排列的 frames；每帧含原 frame_index/ticks、交集起止、人物和文字区域/mask 路径与 SHA。路径不能进入 HTTP 响应。区间精度依据 ticks/time_base，不用固定 FPS；起点在帧内保留该帧，纯边界相接不计入。
- [x] 不把保守审计 mask 标为 fine inpaint 或已去身份；合法无人/无字帧保留空区域，存在 visible 轨迹但缺区域/缺帧/未审核/上游漂移均拒绝。完整 PNG/mask 字节校验必须执行，代表帧净景 requirements 不能冒充逐帧输入。
- [x] 对照测试：不规则 PTS、起点落帧内、终点落帧内、全部人物/背景人物/文字及空区域、外租户/停用成员/软删父对象、错误源归属或 SHA、旧 CAS/批准、修改 PNG/mask、源范围或 facts/analysis 漂移。全部读取不写 DB/源/历史工件。
- [x] 独立 SPEC→QUALITY 和根回归，只勾选本小包，不称像素处理或 G1 已完成。

G1.1 收口：原始缺导出 RED 和初次 44/44 后，质量 LOW 的错误域修复再 RED（3/6 预期失败）→新完整 50/50；根独立新 50/50、旧时间线短回归 2/2、SPEC r2 PASS→QUALITY r2 APPROVE/零未解决项。原相邻 76/76 绑定修复前 SHA，不能冒称是修复后全套重跑；全功能锁 38/38 与 audit ready 保留。精确当前源、历史工件和限制见 `.codex-staging/g1-motion-coverage-verification-20260906-r1.json`。

```powershell
node --test --test-reporter=tap --test-concurrency=1 backend-node/test/redrawMotionCoverage.test.js
node --test --test-reporter=tap --test-concurrency=1 backend-node/test/redrawReferenceBundle.test.js backend-node/test/redrawCoverageRegistration.test.js backend-node/test/redrawMotionDraft.test.js
```

新测试核心断言（完整真实 fixture 放于上述测试文件，不注入已验证状态）：

```js
assert.equal(typeof referenceBundle.loadReviewedMotionCoverage, 'function');
const input = await referenceBundle.loadReviewedMotionCoverage(ctx, {
  shot_id: shot.id, expected_updated_at: shot.updated_at,
});
assert.equal(input.schema_version, 'redraw-motion-obscuration-input-v1');
assert.equal(input.approval_status, 'pending'); // 新派生输出尚未由用户审核。
assert.equal(db.prepare('SELECT total_changes() AS n').get().n, beforeChanges);
```

#### G1.2 实际像素处理与 G1.3 页面审核

**G1.2 已确定的最小实现合同（独立静态审查 + 本地 VFR 探针后）：**

1. 新内部服务入口为 `withMotionObscuration(ctx, { shot_id, expected_updated_at }, consume)`，不接受调用方传 frame/mask/模型/路径/质量结论。源服务只新增受控 `withSourceVideoSnapshot(ctx, input, consume)`，在 callback 完成或抛错后统一回收其私有快照；两个接口不直接暴露 HTTP。callback 期间提供待审 MP4 的只读 stream、大小、实际 SHA、处理报告及异步 current-binding 复核；不得把私有路径序列化给页面，不注册资产、任务或预算。G1.3 再连接普通页面的显式导入/审核流程。
2. G1.1 返回的 reviewed frame 是像素输入，原视频私有快照用于实际 probe、源 SHA 和当前归属复核。每个 frame/mask 以受控读取的实际字节重新核对 SHA 后处理，不在异步期间反复信任可变公开路径；完成编码后重新调用可信 reader 核对完整输入绑定，确认 owner/审核/CAS/源/帧/遮罩没有漂移。
3. Sharp 合并每帧 `person_regions` 全部 `story_role/background_extra` 和 `text_regions` 的二值 mask，只将 union 白区替换为固定保守高斯降细节（sigma 12 px），黑区使用原始 RGB 像素。合法空区域帧原样保留，不做全帧 blur。中间 PNG 黑区必须逐像素相等；MP4 是有损浏览器编码，不能承诺其字节或 RGB 与源完全相同。以相同编码参数的未遮挡基线对照画面，记录非遮区解码误差并保留人工背景确认，不把编码误差称为裁剪/去身份质量通过。
4. 编码使用原尺寸和实际源 SAR（不能隐式 setsar=1）、H.264/yuv420p、无音轨、无固定 FPS/补帧/裁剪/缩放。偶数尺寸、可解释的正 SAR、无未处理旋转以及可表达的时间基是浏览器输出的技术前提；否则明确 unsupported，不静默修改构图。输出元数据与逐帧/逐包时间全部 ffprobe 验证，浏览器实播在 G1.3 单独确认。
5. 以原时间基分母与 1000 的公共整数刻度驱动每帧 `clip_interval`，BigInt 运算后检查 FFmpeg rational/timebase 整数可表示性；concat duration 从绝对边界统一量化到微秒后相减，不能每帧独立四舍五入造成累计漂移。`fps_mode=passthrough`、无 B 帧，末包 duration 明确由最后 clip_interval 的刻度推导，不能硬编码帧数/时长。逐帧误差最多一个可解释的编码时基刻度/微秒舍入误差，首末范围和帧数量必须闭合；若不能保证，拒绝并保留错误，不降低检查。
6. 本地合成探针已证实 1 ms 时基下普通 concat 与“重复末帧 + -t”都会吞末帧时长；`setts` 显式末包 duration 后两种几何均通过。探针仅证明 4 帧示例：PTS `[0,.15,.45,.85]`、末帧 `.5`、总长 `1.35`。正式测试还必须覆盖 1/30000 或 1/90000 时基、切镜在帧内、单帧、合法空区域及实际 MP4 源/coverage，不把此探针代替产品验收。
7. `redraw-motion-obscuration-report-v1` 只记录 source/owner/work/version/shot/CAS、批准 coverage hashes、输入 frame/mask 集合 SHA、实际时序/几何/编码参数及输出 SHA/大小，固定 `approval_status: pending`。不写 `identity_obscured=true` 等人工质量结论。取消、FFmpeg/Sharp/probe失败或复核漂移均不调用成功消费者、不写业务 DB；回收仅限本次受保护私有目录中明确创建的文件，其他源、mask 和历史工件不变。

- [x] 新增聚焦服务 `backend-node/src/services/redrawMotionObscurationService.js` 和测试 `backend-node/test/redrawMotionObscuration.test.js`，复用 `redrawSourceVideoService.js` 私有源快照，不将原文件/历史 mask 变为写入目标。使用现有 FFmpeg/Sharp，不安装模型或依赖。源/覆盖快照校验失败和取消均不注册候选。
- [x] 先写横/竖两个真实移动片段的像素 RED：遮区应改变，中间 PNG 非遮区精确一致，MP4 与对等编码基线对照；不均匀 PTS 和跨帧切镜不漏首帧；维持尺寸/SAR/DAR/时序、输出无音轨，hash 来自实际文件。像素 GREEN 后核对取消/异常只清理当前私有临时文件。
- [x] 输出仅待审；处理报告绑定输入集合及实际输出 hash，不能自动填写四项质量通过声明。对不支持的编码边界显式拒绝，不偷偷缩放裁剪。
- [ ] 修改 `routes/redraw.js`、`routes/index.js`、`frontweb/src/api/redraw.js`、`RedrawShotStep.vue`，补对应 Motion 组件/API 与默认后端浏览器测试。页面发起当前镜头处理、实际播放、拒绝、四项显式确认、复用导入/准备；切镜或任何绑定变化清空确认并使旧批准失效。
- [ ] 既有 A/B 上传准备、coverage、source snapshot、角色身份包和功能锁回归不退化；技术与人工画面验收分开。全部完成且独立双审后关闭 G1。

G1.2 局部收口：SPEC P1/P2 和 QUALITY Q1/Q2 的正式失败均已修复，旧失败工件保留；根独立完整 Motion 54/54、作者 Motion 54/54＋SourceVideo 52/52，全部原生 exit 0。SPEC r3 独立 13/13 后 PASS，QUALITY r2 定向 6/6＋原两个反例均原生 exit 0 后 APPROVE、零剩余问题。只勾选本段前三项；G1.3 页面/接口、人工观感以及其余五组仍未完成。被阻止删除或身份不可信的文件按结构化失败保留，不递归强删；Windows 目录 EPERM 后的窄身份 double 不冒称原生替换验收。精确工作树/源码和历史证据绑定见 `.codex-staging/g1-motion-obscuration-verification-20260906-r1.json`。

**G1.3 页面连接的固定最小合同（2026-09-06 独立只读消费审查后）：**

- 保留原静音草稿和手工 MP4 导入。新增当前镜头的显式处理请求，只接受当前 CAS/源 SHA，不接受 frame、mask、路径、模型或通过结论；从 G1.2 callback 内完成流传输及绑定检查后才回收临时文件。HTTP 使用专有 envelope 类型，不把包装响应伪装为 MP4：8 字节 ASCII `RDMO0001`、4 字节大端 JSON 长度、严格 UTF-8 的原处理报告 JSON、实际 MP4。JSON 上限 8 MiB、视频沿用既有 200 MiB 上限；超出明确拒绝，不截断报告或媒体。原输入视频时长合同不变，这是新增待审附件的资源边界。
- 前端先检查固定头、版本、JSON 长度和总 Blob 长度，只读取有界报告；视频通过 `Blob.slice` 取得，剩余长度必须精确等于报告 output.size。拒绝非法 UTF-8/JSON/schema、截断、额外字节或不符的 source/shot/CAS；之后把真实 MP4 File 接入现有选择/播放/四项人工确认。不得预勾、自动上传、自动准备或生成。重新处理、手工换片、拒绝、切镜、scope 漂移都使旧报告/File/确认失效。错误和取消不自动重试。
- 同响应报告只是服务端这次处理的技术输出；经浏览器回传登记时，明确标记 `client_returned_unattested`，不冒称服务器签发证明。继续使用现有手工批准标准，不新增签名 secret、持久草稿表、缓存、模型或部署依赖。若以后要求密码学证明像素确由 renderer 生成，必须另立签名/持久处理来源合同，不能用附件 SHA 冒充。
- 人工导入可带可选、最多 8 MiB 的 `processing_report`；无附件的历史手工 MP4 路径不变。有附件时 import 从当前 owner/version/shot/CAS/source、批准 coverage 和实际逐帧/区域集合重建权威快照，对照完整身份/集合/哈希、实际上传字节 SHA 和媒体 probe；缺失/重复/额外元素或漂移拒绝。最终落库前再次复核。附件及其规范内容 hash 和**服务器自行核验的绑定事实**进入既有 asset metadata，同一事务写入；附件 hash 纳入幂等请求 hash，不能同 key 换报告。报告不能提供人工审核资格。
- 准备升级 ready 时，新增带附件候选必须再次与当前权威 coverage/输入集合核对，而不仅核对 source/clip/duration。独立映射指出 `assertPendingMatchesCurrentBindings` 原未比较处理时覆盖，因此必须补这一反例，防止旧处理视频被重新贴上新覆盖的 ready hash；只对新附件分支执行，原手工导入合同和四项确认不削弱。
- import 必须比较 G1.2 原完整 `input_binding_sha256`，不能放宽旧 CAS。同时由服务器从同一可信输入副本**只删除 `shot.expected_updated_at`**后计算并存 `material_binding_sha256`。prepare 的 claim/persist 本来会合法更新 CAS，故用当前 CAS 再读可信输入、比较这个不可变 material hash；不重写旧材料 hash、不删除审批时间或其他字段。material 相等只证明处理输入未变，不能证明时间变化必来自 prepare；必须保留原 `shotPreparationInput`/`assertBaselineCurrent` 对本次准备期间 prompt/dialogue/draft 等业务变化的校验和最终 CAS。覆盖真实 claim→persist→bindReady 成功，以及源/覆盖/审批/帧/遮罩变更拒绝、material hash 篡改拒绝、material 相同但业务基线变化仍拒绝；旧手工候选路径不受新增附件要求影响。
- 分两包串行实施：G1.3a 仅 backend 受控响应、报告绑定/导入/prepare 漂移及 HTTP 测试；G1.3b 才改 API、`RedrawShotStep`、`RedrawShotEditor`、`RedrawReferenceBundlePanel` 与现有默认后端浏览器测试。每包独立 RED/GREEN、SPEC→QUALITY；真实解码与手工效果验收分开。不能将此前 A/B 浏览器结果计作本新增入口通过。

**G1.3a 实施责任与固定入口：** 全新实现者只负责 `backend-node/src/routes/redraw.js`、`backend-node/src/routes/index.js`、`backend-node/src/services/redrawReferenceArtifactImportService.js`，新增聚焦 `redrawMotionProcessingReportService.js` 与 `backend-node/test/redrawMotionProcessing.test.js`；prepare 的业务基线如无实证缺口保持不变。新增 `GET /redraw/shots/:id/motion-processing?expected_updated_at=...&expected_source_sha256=...`，复用当前只读 owner 媒体路由的位置，严格两个参数、无额外字段。专有响应类型为 `application/vnd.moli.redraw-motion-processing.v1`，固定 envelope 如上。处理开始前校验当前所属源 SHA，响应开始前及 callback 生命周期内复核；错误/取消/断连不登记任何资产、任务或预留。报告校验服务只供 response/import/prepare 的本次既定三处消费，不改已冻结 G1.1/G1.2 算法和 hash，不抽取通用媒体平台。确有必要时，仅新增测试专用 helper 或在原 prepare 测试追加真实组合反例，不重写旧用例。主代理负责五项受影响功能锁的本次本地授权历史及其测试、唯一计划/报告和独立回归；授权记录不能抹去历史门禁。

**G1.3b 已核对的页面入口（只读映射，不是已实现）：** API 复用 `getMotionDraft` 的 `responseType: blob / silentError / signal`，专用有界 parser 不整包读入 ArrayBuffer。当前 request interceptor 返回 Blob 本身，Content-Type 可由 Blob.type 检验；局部有界解析失败 JSON Blob，不修改通用拦截器。Step 持有请求 epoch/AbortController/current scope，Panel 持有 File/URL/可读状态/四项手工确认，Editor 只透传；报告与 File 同寿命。特别覆盖“处理尚未产出 File 时取消”：现 `handleMotionSelection` 对空 selection 提前返回，必须走明确 invalidation，不可指望旧清空事件自动取消。

G1.3a 根完整 routes+feature 回归补充责任：新增可选 `processing_report` 后，旧 `redrawRoutes.test.js` 的 multipart 配置检查仍用 `fields===5` 查找对象，根实际 **193 项中 192 pass/1 fail、native exit 1**。允许原实现者仅更新这一用例到 6 字段、8 parts 和 8 MiB fieldSize，并保留原字符 20 MiB/memory、动作 200 MiB/disk 与随机安全文件名断言。该第九文件只是新增合同的测试适配，不允许修改其他旧测试或放宽媒体限额。失败日志保留，修复后完整回归与 SPEC→QUALITY 仍是退出条件。

G1.3a QUALITY r1 的唯一 P2 为上传视频旋转检查遗漏：真实 GET MP4 重封装添加 90° display matrix、仅更新报告输出大小/SHA，旧 import 仍登记 `output_media_verified=true`。源 probe 已检查旋转，上传 probe 尚未检查。原实现者只补 report service 的上传旋转事实校验及正式真实媒体反例；非零或无效旋转拒绝，未提供或可信零旋转允许。保留人工确认、无附件旧导入、零写/私有临时清理与全部 G1.2 冻结文件；保留独立 native exit 1 的原反例。修后重新冻结并按 SPEC→QUALITY 复审，不以修前 22/129/193 的绿灯关闭本包。

- [x] **G1.3a 后端局部收口：** P2 正式2项 RED→GREEN，修后完整 processing/prepare/import **131/131**，根独立新增/prepare **24/24**；SPEC r2 **PASS**、QUALITY r2 **APPROVE**，原真实旋转反例不改断言得到 native 0，均无剩余本包问题。历史193/217保留且不冒称修后重跑。累计回执 `.codex-staging/g1-motion-processing-verification-20260906-r1.json` 绑定精确 dirty 源，不是提交或 CI 证据。
- [x] **G1.3b 页面本地完成：** 原schema/时长及实际auth失效问题均修复并双审；新源码根浏览器1/1、构建、真实48帧MP4/parser复核通过。普通处理/预览/四确认/报告导入/显式准备已走通；本地注入owner与clean前提不等于真实登录、供应商或人工质量验收。

G1.3b 第一版作者已冻结，根独立新浏览器 r6 与构建分别 native 0；独立 SPEC 为 REQUEST_CHANGES（2 P2）：前端只检查简化九字段而非原处理报告 schema，新浏览器时长容差将报告 ticks 与微秒相加。原作者在本包内补正式 RED/GREEN：完整字段结构/类型/枚举/SHA 语法检查只用于页面提前拒绝，不重算后端 owner/coverage/媒体事实；新用例时长比较取 `max(实际输出 stream 一 tick, 1µs)`，仅允许浮点运算 machine-epsilon 余量，不改媒体或旧 A/B 测试。历史作者 r1、根 browser-r6/build-r1 与 SPEC 原失败全部保留，修后重新冻结和 SPEC→QUALITY，不能用修前绿灯勾选页面。

G1.3b r2 两项修复已获 SPEC PASS：独立正式测试512/512、保留原拒绝反例的探针24/24，11个源码冻结不变；完整正式报告fixture保持原服务所有字段和日期字符串。根该冻结源码前端1725/1725、feature40/40、audit ready及diff检查均native0（回执 `.codex-staging/g1-motion-processing-page-root-20260906-r2.json`，SHA `bf7aee9428203e1e291f25c6f83c858c70ba3d5fe508fab3845f7acf3f4a05f4`）。前端运行明确对三份原middleware测试使用精确白名单的no-env配置加载器，七次覆盖且原测试正文不变；不是原默认环境全套通过。接续独立QUALITY和本次新源码browser/build，仍不勾选G1整包。

QUALITY r1 确认一个P2：实际登录用户/租户存储变化不触发Vue缓存scope更新，旧动作处理File/report会迟到回填或进入新会话上传调用（并非后端越权成功）。四个实际auth helper反例native1，正式512/512不覆盖它。根已认可，原作者只改Step及现有上传runtime测试：在await结果/错误、选择与上传前实时核对用户+有效租户，监听相关storage变化并清理保留预览；不能清除已提交unknown标记或重写全局auth。按正式RED→GREEN再SPEC→QUALITY；保留该报告SHA `1c8cc9400b5a7974701745ea22196c02c1a4c3096cb43fbe85cba0d3b201cc50` 及全部旧证据。新浏览器和构建等这次修复冻结后才执行。

现有 R2d2d 默认后端浏览器测试只证明手工 A/B 上传准备。它的 `installGenericReviewedCoverage` 每镜一帧、固定 1/1000 时基，PNG 是另造纯色，不是 12 秒源 MP4 的真实逐帧解码。G1.3b 应保留旧用例，在新真实处理用例中从本次已上传源的真实 ffprobe PTS/time_base、全部解码 PNG 与对应 mask 构造合法 reviewed evidence，再复用现有注册/审批；不能只换时基常量放行。可参考 motion fixture 的媒体构造方法，不调用会重建另一 DB/owner/shots 的整个 fixture。新链必须实际解码服务返回 MP4、显式确认及导入报告、显式准备，并保持生成 POST 为零；网络 mock 仅用于前端迟到/取消/畸形 envelope，不能计作真实 renderer 证据。

#### G2 长音轨执行包

2026-09-09 用户确认后的实施顺序：先完成当前双作品回归，再依次实施有界 PCM 窗口/原 Worker 回执保存、严格聚合与冲突拒绝、v2 消费、蓝图前冲突候选及同页确认、原任务显式续行。第一片只触 `redrawSourceAudioEvidenceService.js`、必要的 `redrawLocaleVerifierClient.js` 长轨 opt-in 回执保留及相应测试；原单窗 v1、wire、64 MiB 和原文字不变。首次正式反例必须到达窗口/聚合目标注入点，不能继续把旧整轨超限重复计作各类 RED。

蓝图前的人工处理不通过放宽旧 `sourceCorrectionContext` 的 `resolved` 检查实现：候选保留全轨/每窗原文、时间、来源 SHA 与独立 analysis task 绑定，保持非成功状态、不伪造蓝图。后继拟在现有 `RedrawBlueprintReviewPanel` 中显示音频候选分支，复用已存在的母本视频读取，无默认选中；全部冲突选择完整来源段并经 owner/source/task/hash/CAS 复核后才登记可消费证据。未确认、未解决或未知保持不可生成；确认与继续原分析是显式操作，不自动重做 ASR、新建任务、冻结或结算。此处为实施设计，不代表该状态/接口/UI已存在；正式落码前仍须测试当前工作任务与账态合同，禁止借“人工审核”误解锁真正结果未知。

仅靠完整候选选择不能解决的矛盾继续保留待处理，不能静默修文、拆合或宣称全类冲突已经解决；若需要蓝图前文字/时间修订 overlay，则另行具体化来源与修订绑定，不把人工文本伪装为原 ASR。现有合法蓝图上的对白修订不改。真实 Worker/下载/能力绑定与供应商实测仍受原授权边界约束。


2026-09-07后继只读范围核对：不因`redrawEpisodeFactsService.js`存在旧cluster正则就扩大责任。默认链NativeSource先清空视觉对白，Fusion直接消费音频并生成voice_cluster蓝图；Blueprint锁定投影前拒绝所有未映射cluster，此后才调用Facts规范化。该路径尚无Facts阻塞反例，保留不变。第一个产品RED应直接调用SourceAudio服务、复用已留存一小时真实源、实际FFmpeg WAV与隔离DB，只替换最低Worker调用，断言三合格窗及一次v2登记；不能把已有假WAV harness或技术probe当产品通过。本次仅映射，未执行该RED，不改变既定接缝待确认语义。

**责任落点与顺序：** 先完成 `redrawLocaleVerifierClient.js` 原回执 opt-in 的独立 TDD/双审；随后以 `backend-node/src/services/redrawSourceAudioEvidenceService.js` 和聚焦 `redrawSourceAudioWindows.test.js` 接入有界 PCM/纯聚合验证。精确消费者入口为 `redrawSourceDialogueService.js`、`redrawEvidenceFusionService.js`、`redrawEpisodeBlueprintService.js`、`redrawNativeSourceAnalysisService.js` 及其测试，只有正式反例证明需要时做窄适配。Worker `source_evidence.py`/`engines.py` 和单窗协议保持不变，运行 Worker `test_source_evidence.py`/`test_server.py` 相邻回归；不通过提升 64 MiB 常量解决。每片先完成回执再开始依赖产品写入，不把中间原回执保真当作 G2 完成。

**真实入场反例已执行（局部预检，不是修复通过）：** 64 MiB 限制实际在 Worker `server.py` 的 `_resolve_source_audio_path` / `_read_source_audio_bytes`，错误码 `AUDIO_PATH_NOT_ALLOWED`；JS client 和 source-audio 服务最终映射为 `SOURCE_AUDIO_ANALYSIS_FAILED`，不是 JS 自有大小门禁。根生成同一个真实 1 小时低体积 MP4，使用原 `expandSourceUpload` 的默认时长/probe 成功接受，再抽完整 16 kHz mono PCM WAV、核验实际大小/SHA，并直接调用 `_analyze_source_audio_request(request, LocaleServerConfig(pack=None, allowed_root=..., asr=object(), source_audio_clusterer=object()))`，已确认原大小门禁拒绝。此纯函数在检查 ASR/clusterer 前拒绝，不启动 daemon/不加载模型；实际 `run_server` 启动先构造模型，不能据此前者宣称真实服务启动不加载模型。现有 `test_source_audio_action_rejects_unsafe_type_and_size_before_asr` 的稀疏 WAV 不是本次真实抽取证据。后续正式 G2 TDD 仍须在产品长轨成功断言上建立 RED，不能将“旧门禁正确拒绝”的预检 exit 0 当成长音轨功能已通过。

预检源为 64×64、3600 秒、11,186,014 字节，SHA `05c9849b35665c37e097b569819f401b2b7a85b059ff0a83f828ffb00605e075`；实际 WAV 115,200,078 字节，SHA `0ae9f13946582c96d26393277429c75fa20d84a12c20de6167f85b431d96ff07`，高于 67,108,864 字节门禁。r1 媒体/上传步骤成功，但系统 PATH Python 的 uv trampoline 被权限拒绝；完整原失败回执保留。r2 仅使用已提供的 bundled Python 重跑纯函数，复用并核对原媒体 SHA、未重编码，实际得到 `AUDIO_PATH_NOT_ALLOWED` 且 `source_evidence` 未导入，native exit 0。回执 `.codex-staging/g2-long-audio-real-preflight-20260906-r2.json` SHA `e66de19a93f4f86cddaf1205546bca35207c95fe7a78e0bbd16b7cf1348765ca`，原 source/Worker 文件未变。该合成正弦音源不代表长语音转录质量、浏览器上传或原子证据登记通过。

**G2.0 已确定的长音轨证据合同：** 后端将“全轨证据”和“单窗 Worker 回执”分开。未超限的单窗保持 v1；长轨使用 v1 超集 `redraw-source-audio-evidence-v2`，存储 category 仍为 `redraw_source_audio_evidence`。独立只读架构核查确认现有 Worker 每请求重新编号 speaker，跨窗口只能保守地命名空间隔离，交给现有逐句/子集角色纠错，不能自动声称同一个人。

样本级分窗技术预检已通过（尚非 G2 产品实现）：复用上面同一小时 WAV，用真实 FFmpeg `atrim=start_sample=...:end_sample=...,asetpts=PTS-STARTPTS` 和 PCM s16le 输出三个分析窗 `[0,1530)`、`[1470,3030)`、`[2970,3600)` 秒，commit 区间仍无缝覆盖 `[0,1500)`、`[1500,3000)`、`[3000,3600)`。实际大小分别48,960,078 / 49,920,078 / 20,160,078字节，均小于64 MiB；安全解析 RIFF 得到真实78字节 data offset，再用1 MiB有界读取对照每窗全部PCM和母本对应样本区间SHA，两个60秒重叠也逐字节哈希相同。六个FFmpeg/ffprobe命令及探针本身native0；原WAV前后SHA不变。工件 `.codex-staging/g2-pcm-window-probe-20260906-r1.json` SHA `cfb783a8aa0e3905978cb90893a0e3338ee26076892b77b9d3ee386be567e056`。新窗口文件保留供G2实现复用，不重新生成一小时母本；未调用Worker、未验证语句接缝/说话人/聚合登记，不据此勾选G2。

```js
// 全轨登记对象；哈希使用当前规范化工具，对象自身 sha/asset_id 不参与自身哈希。
{
  schema_version: 'redraw-source-audio-evidence-v2',
  task_id, work_id, tenant_id, user_id, source_asset_id,
  source_video_sha256, audio_sha256, audio_duration_ms,
  audio_format: { codec: 'pcm_s16le', sample_rate_hz: 16000, channels: 1, bit_depth: 16 },
  transcript_sha256, source_language, language_probability, dialogue_mode, created_at,
  window_policy: {
    worker_max_audio_bytes: 67108864, target_commit_ms: 1500000, overlap_ms: 30000,
    seam_rule: 'full_utterance_single_owner_or_reject',
  },
  coverage: {
    expected_duration_ms, committed_ranges: [{ window_id, start_ms, end_ms }],
    gap_ms: 0, full_coverage: true,
    seam_checks: [{ seam_ms, left_window_id, right_window_id, status: 'passed' }],
  },
  speaker_cluster_policy: { scope: 'window', cross_window_identity: 'unknown' },
  windows: [{
    window_id, index, analysis_range_ms: { start_ms, end_ms },
    commit_range_ms: { start_ms, end_ms }, request_id,
    audio_sha256, transcript_sha256, worker_status: 'completed', segment_count,
  }],
  segments: [{
    id, start_ms, end_ms, source_text, speaker_cluster_id, evidence_ref,
    speaker_cluster_scope: 'window', speaker_link_status: 'unknown',
    commit_window_id, selected_source_binding_index,
    source_bindings: [{
      role: 'selected_source', // 恰好一个实际输出来源；其余真实去重来源为 deduplicated_overlap。
      window_id, worker_request_id, worker_segment_index,
      worker_relative_range_ms: { start_ms, end_ms },
      absolute_range_ms: { start_ms, end_ms },
      window_audio_sha256, window_transcript_sha256, raw_worker_speaker_cluster_id,
      worker_source_text,
    }],
  }],
  no_speech_evidence,
}
```

规则固定如下：

1. 全轨 `audio_sha256` 来自整个规范 WAV 字节，不是任一窗口或 hash 拼接。25 分钟 commit 窗口加前后最多 30 秒上下文，每份实际 WAV（含 header）仍须小于 64 MiB；按 16 kHz 样本索引切分，不用有损重编码。commit 区间严格分割 `[0,audio_duration_ms)`，分析窗口可重叠；格式/实际大小/采样/源 hash 校验在调用前完成。
2. 窗口只调用一次原 Worker 请求，成功后保存该窗口原始 transcript/audio hash 与相对时间。顶层 segments 全为绝对源片时间，`absolute = analysis_start + relative`，不再由视觉窗口二次平移。窗口 speaker ID 以 `aw000001-` 这样的稳定索引前缀隔离，同名 raw cluster 不直接合并。前缀 ID 仍须通过现有 ID 长度/字符检查。
3. 接缝完整保留 ASR 识别段（不声称语义完整句），最终保留段中点决定逻辑 `commit_window_id`；物理来源由 `selected_source` binding 表达，不要求物理窗等于逻辑归属窗。规范文本相同且时间重叠、双向唯一匹配的重复段只保留一份，保留原文本/完整区间和真实来源绑定；缺少可信唯一匹配仍停止进入人工确认，不能以邻窗 fallback 绕过。人工选中邻窗完整段时不得虚构 owner 窗回执，speaker 前缀取所选物理窗。歧义、同文重复且无法唯一映射、段越出合法分析窗或冲突转录均拒绝自动聚合，不硬切、拼猜或重调 Worker；必要重做必须由用户后续显式发起。
4. v2 顶层 transcript hash 明确使用已提交、去重、全轨绝对时间顺序的 `[{ end_ms, source_text, start_ms }]`，JSON key 字典排序、UTF-8、不转义非 ASCII、无空白；不含 id/speaker/bindings/confidence/language/windows。静音是 SHA256(`[]`)。这不是复用任一 Worker hash：原 Worker 是对相对秒级 `{start,end,text}` 计算 hash，后端 v1 只传递/绑定、不重算，v1 原样保留。每窗 hash 保留在 windows 与全部 source_bindings，不移作全轨。所有含语音窗口的 language 必须符合当前单一源语言合同，冲突显式报告，不用多数票隐藏混合语言。probability 保守取已提交语音窗口最小值，不伪增可信度。所有窗口都合法零语音时才 `dialogue_mode=silent`、segments 空并记录各窗真实 VAD no_speech 证据；混合静默/语音则 spoken，静默覆盖仍留在 windows/coverage。
5. 每窗回执、覆盖/接缝、speaker namespace、来源绑定、4096 段上限及当前源 CAS 全部验证后才一次原子登记成功证据；外部 JSON 文件完成与 DB 索引提交间的失败按现有孤儿清理规则处理。不写中途成功资产；未知统一沿既有 `SOURCE_AUDIO_RESULT_UNKNOWN` 冻结且无重试，明确失败保留原明确失败策略，内容冲突与网络未知分开记录。
6. v1 读写保持原样；v2 消费者先完整验证新增窗口/覆盖及 source_bindings（至少一条、恰好一个 selected_source 且与 selected_source_binding_index 一致），再从顶层 segments 投影当前所需字段。不得换 schema 名伪造旧全轨回执、把窗口 SHA 当全轨 SHA，或移除 provenance 以绕过校验。SourceDialogue、EvidenceFusion 与 Blueprint 的旧 `speaker-cluster-N` 正则确实是兼容入口：新增显式 v2 / namespaced 分支，保留 `aw000001-speaker-cluster-1` 这样的 ID 到 fusion、blueprint 和角色纠错；不得把不同窗都投回 raw `speaker-cluster-1`，否则会制造错误身份合并。具名 view 不能冒称旧 v1 validator 已验证 v2；原始窗口/聚合 hash、全部去重来源和纠错关系保留至最终证据回查。segment id 必须在聚合时稳定生成，不能因消费时去掉 namespace 重新派生。

这项保守合同不承诺自动判定跨窗同一角色，用户仍可使用已实现的角色纠错；若要新增跨窗自动声纹识别，属于另一个实际能力和证据来源，不隐含在本次开发中。新增技术支持不等于真实长语音内容质量通过，后者仍进入 G6 实际听看。

根新增消费核查：`frontweb/src/utils/redrawBlueprintReviewState.js` 的 `unresolvedVoiceClusters` 也只接受旧 `speaker-cluster-N`，不是只有三个后端 validator 需要兼容。G2 的窄兼容责任因此包括该函数和原工具／角色纠错测试：只有正式 RED 后允许完整保留 `aw000001-speaker-cluster-1` 这样的窗口命名空间，两个窗口同名 raw cluster 必须显示为两个待映射聚类，原逐句或子集角色纠错仍可把用户确认的项映射到角色。不得去前缀合并或自动批准，也不另起说话人界面。只在 G1.3b 收口后进入此依赖包，不与页面作者并行改共享文件。

2026-09-08 独立只读消费者复核（六个直接源码和相关测试片段，未测试、未写文件）：最小兼容面为四项改动、两项只补保护回归。`redrawSourceDialogueService.js:89–132`强制payload/asset metadata为v1，并以旧speaker正则及单个no_speech验证，须先正式RED覆盖v2命名空间、来源 binding/唯一 selected_source/selected index/逻辑 commit_window_id（按 2026-09-09 已澄清草案）和全静音窗口。`redrawEvidenceFusionService.js:170–229`不辨schema且只做segments投影，必须拒绝缺损v2而非按v1放行，同时保留合法namespaced cluster；投影之外的provenance仍由原聚合资产回查。`redrawEpisodeBlueprintService.js:398–462`及前端`redrawBlueprintReviewState.js:467–532`只需窄扩speaker ID/排序，两个窗口同raw cluster仍分开、单项映射不影响另一项、voice_cluster未解决仍不许lock；不向exact dialogue turn塞入provenance。RED分别落原SourceDialogue、EvidenceFusion、EpisodeBlueprint及frontweb SpeakerCorrection测试，不新开说话人UI或manifest kind。`redrawNativeSourceAnalysisService.js:231–290`和`redrawAnalysisWindowService.js:26–61`只消费顶层绝对ms segments，当前无必要产品修改；仅在NativeSourceAnalysis原测试保护namespaced speaker保留、v2来源hash不进入有限prompt摘要、非法时间继续拒绝。这是dirty工作树静态结论，不是clean HEAD或测试通过；G2仍等唯一作者顺序进入，不与G4.7写入并行。

**接缝操作定义已确认（2026-09-09）：** 用户明确回复“采用，冲突时人工确认”，批准完整保留识别出的对白段、不自动裁句，接缝冲突停止并交给现有对白审核，不新增语音模型。当前 Worker 只返回文字段、起止与 speaker，没有“语义完整句”字段；此批准不把 ASR 段冒称语义完整句或真实识别质量已通过。实施沿既有全轨/窗口绑定和人工纠错合同，不静默丢词或拼猜。文本只 trim，不剥标点或一对多拼接；commit 为半开区间，中点恰等于边界归右窗；跨窗同文匹配必须双向唯一，两个完整代表若推导出不同 commit owner 则拒绝，不能贪心择近。蓝图创建前的非成功冲突候选如何接入现有审核须按下段明确来源锚定后实现，不能只保存错误日志就称闭环完成。

按上述已确认的操作定义，v2 段增加 `commit_window_id` 与 `selected_source_binding_index`，分别绑定逻辑时间提交区和实际输出代表来源。2026-09-09 独立只读审查发现旧草案强制物理 owner binding 会在 owner 漏识别、人工选择邻窗原段时迫使伪造来源，故未落地 v2 改为恰好一个 `selected_source`，其索引须等于 `selected_source_binding_index`；物理窗无需等于逻辑 commit 窗。输出文字／完整时间／speaker 全部来自所选原段，speaker 命名空间取物理窗；最终中点按半开区间重新计算逻辑 owner。其余 `deduplicated_overlap` 只能记录真实双向唯一匹配，冲突或人工否决的文本保留在原回执/候选里，不冒称已去重。该澄清不扩大自动 fallback，未解决冲突仍不发布成功 v2。客户端仅在本地显式 `preserveSourceEvidence:true` 时保留已验证原 Worker evidence 对象，wire 请求不增加字段、v1 默认返回不变；每窗原相对秒级对象和声明 transcript SHA 均保留，不用舍入毫秒重算秒级 SHA。顶层 v2 的全轨毫秒 canonical SHA 单独计算。最小共享校验导出可放现有 SourceAudio 模块，生产者、Fusion 与 SourceDialogue 复用，避免后者反向循环；前端只做 ID／显示兼容。这些澄清不引入供应商、模型、部署或费用。

2026-09-07 独立只读复核发现一个必须补齐的消费缺口：现有 `sourceCorrectionContext/applyDialogueSourceCorrection` 需要成功登记证据、已存在的蓝图 turn 且 `source_dialogue.status=resolved`；接缝聚合冲突发生在蓝图创建前，不能直接送进这条已实现纠错路径。因此“保存非成功冲突诊断并停止”只能作为中间安全行为，不是纠错闭环完成。后续须窄接入已有对白审核的候选/来源锚定，保留各窗全文、时间和原回执，审核前不得生成；不伪造成功 v2 或新增独立审核平台。Worker 的 source-audio 协议本身没有数字签名字段，此处原回执 SHA 不冒称签名；现有语言包签名合同另保持原样。SourceAudio 当前还缺最终源/任务 CAS 与 JSON/资产提交事务绑定，须正式反例后补；180秒超时、256KiB回执、蓝图每段500字符等旧边界不能靠截断绕过。此项为源码映射，未执行 Worker/新产品代码或改变待确认语义。

- [x] 复用已生成一小时低体积合成源，正式真实产品入口RED已证明整轨WAV为115,200,078字节并超过64MiB；源/音频SHA前后不变。该反例只以最低Worker替身执行大小拒绝，不证明真实ASR或分窗修复通过；root原始回执见唯一验收文档2026-09-07 G2条目。
- [ ] 有界 PCM 窗口覆盖全轨，无未报告空隙；窗口 hash 与全轨 hash 分别记录。低层 Worker 结果时间平移回全轨；接缝重叠去重完整保留识别段，不将两个窗口相同 cluster 名认成同一个人。
- [ ] 复用同一全轨说话人证据或持久映射；未能确认的映射进入人审，禁止伪造全局 speaker。每个窗口成功且完整性验证通过后才原子登记最终证据。
- [ ] RED/GREEN 覆盖接缝对白、多人同名 cluster、无轨、纯音乐、单窗口失败/超时、源漂移/取消、4096 段边界。unknown 保持 held/needs_attention，重复点击零新增分析。
- [ ] 根运行源音频/原默认分析/Worker 回归与 SPEC→QUALITY 后，实际 1 小时本地处理通过才勾选 G2；假 Worker 只证明连接，不声明真实长语音识别质量。

#### G3 多输入与资源合同执行包

**责任落点：** `redrawUploadService.js`、`routes/redraw.js`、`frontweb/src/components/redraw/RedrawSourceStep.vue`、`frontweb/src/views/RedrawWorkspace.vue`；`backend-node/test/redrawUpload.test.js`、`frontweb/test/redrawSourceRuntime.test.js`、`frontweb/e2e/redraw-backend-integration.spec.js`。

2026-09-08 G3 页面映射复核修正：G4.8 收口后，Source `refreshWork` 已有 alive/requestSequence/sourceContext 复核，Workspace `loadWorkspace` 的 events await 后及 `refreshProjectEvents` 也已有序号/项目/作品检查；旧“这些读取保护均缺失”的定位已过时，不据此重复修复。仍有待正式反例确认的写路径是 `ensureWork` 上传返回、`startAnalysis` 的 await 继续、`confirmLocalization` 二次报价后的访问 ABA/卸载，以及 Workspace `new` 路由接收明确外项目 work。已有读保护保持，旧报价 helper 的同 key 内容相等不等于页面访问轮次未变化。

本次页面子包只新增 `frontweb/test/redrawWorkspaceRuntime.test.js`，集中一份真实 SFC 编译/挂载 renderer/deferred 夹具；原 SourceRuntime 24 项及 Parent 56 项保持字节不变，作为相邻回归。正式反例覆盖跨项目/同值 ABA/卸载迟到上传、旧报价禁止 createVersion、旧 finally 不清新操作状态、合法新 work 接收和原读取防护。分析必须使用合法有报价且有 id 的 work，在真实 `await ensureWork` 微任务边界失效；普通 new 页面不能分析，不伪造带报价却无 id 的 DTO。读取刷新不能取消正常写确认，不能直接把频繁读请求序号当访问 epoch；未知/失败不自动重试。仅两份 SFC 可作最小修复，不改 API、helper、Run、全局 store 或模型。根负责单项 `redraw.episode-blueprint-first` 授权历史、入口和文档；作者不得并写。机械复用 G4 parent 的固定 Node/88 依赖、清空环境、精确文件读取和网络拒绝入口，见 `.codex-staging/g3-workspace-mutation-20260908-r1-entry.md`；该应用层保护不是 OS 沙箱。正式测试与双审通过后才关闭此页面缺口，选择器/资源限制/实际浏览器仍另验。

2026-09-06 独立只读映射补充（不是测试结果）：普通 MP4/MOV 默认 12–3600 秒，ZIP 条目原合同 12–180 秒、最多 20 个；不能将 ZIP 的每项上限冒称已支持 1 小时。路由的 1 GiB 只约束 multipart 原文件/压缩包，默认 `uploadLimits` 未设置展开单项/总量，所以不是“已有每项 1 GiB”。当前总量可选检查读 header.size，`getData()` 先完整展开再按 stat 检查，且逐项先持久化会在后项校验失败时留下前项本次文件。实现必须以实际输出字节执行有界展开/清理，不只添加一个 UI 数字。

本机锁文件及实际依赖均为 adm-zip 0.6.0。优先保留其 `entry.getData()` 和 CRC/descriptor 行为，不新增解压库或重写 inflater：该版本在 Node≥15 且 size>0 时，DEFLATED 已用 `maxOutputLength=header.size`；因此先要求安全正整数 size≤min(单片限额, 总限额−已实际展开量)，再解压并在写前核对 actual length===size 且不超预算即可约束实际输出。STORED 不经 inflater，而按 compressed slice 长度分配，必须额外前置校验 compressedSize 为非负安全整数且等于 size；size=0、方法非0/8、加密等明确拒绝。返回 Buffer 不被 entry 缓存，逐项写入后释放本地引用；这不是进程 RSS 或 GC 即时释放的保证，仍有压缩包和解压工作内存。具体阈值仍待用户回答，不能据此宣称新默认已采用。

ZIP 安全检查应在过滤目录前识别 Unix symlink：`header.made` 来源系统配合 `entry.attr >>> 16` 的完整 mode，不能用丢失类型位的 `header.fileAttr`。遍历原 `getEntries()` 保留的所有记录，对原名先拒绝 NUL/绝对路径/盘符/穿越，再规范分隔符并检验 Windows 大小写/目标别名；不要用会吞掉穿越片段的 Utils.canonical 或会覆盖同名项的 getEntry(name)。保留 data-descriptor 模式下中央 CRC 语义，不能强行要求合法本地头零值与中央头相等。合成测试补 STORED/DEFLATED、零/伪小/巨大 size、剩余总量、STORED 大 payload 小 size、CRC/descriptor、加密/符号链接/规范化重复及原子清理；当前只是实际依赖源码映射，尚未运行。

后端 createWorks 在事务中创建并返回全部 items；丢入口发生在 `RedrawSourceStep.ensureWork` 只取 `items[0]`。现有 Workspace 按 workId 具名路由、请求序列隔离可复用，但未有作品选择器，项目列表也总打开 workId=new。最小新增是同项目完整作品入口、显式选择和重开恢复，不自动批量分析。新增 ZIP 字节阈值必须作为明确可见的安全合同，不伪称此前默认已有限额；在进入写入前决定数值及资源依据，若实质收窄已承诺支持范围再请求用户决定。

2026-09-07 独立只读补充：当前没有 `GET /redraw/projects/:id/works`，单项 `getWork` 可恢复真实版本但创建响应丢失后不能枚举第二作品。因此多作品入口的最小包需 routes/redraw 的 owner/project/非删除轻量列表、routes/index GET 注册、前端 API 包装和 Workspace 选择器；无需因首项导航改写 SourceStep 或引入全局store。选择仍以具名路由为唯一权威，仅具名路由 project/work 访问变化（含 route ABA 的 visit epoch）时重建该作品子步骤；纯 owner/storage 变化保留已挂载 Run 与原 pending/unknown，通过既有 policy/visit epoch 失效列表、事件和确认；loading/普通刷新/步骤变化不重建，`onWorkUpdated` 拒绝旧scope/旧work的迟到事件；列表不承担版本真相，实际选中后由 getWork 读取。新增正式路由与当前浏览器回归必须覆盖“两项上传→显式第二项→刷新恢复”、A→B→A与零自动分析/生成。既有 `createWorkFromSource` 按 owner+fingerprint 跨项目复用是另一已发现合同边界；本包不静默改索引/迁移，不能据两个全新素材成功冒称跨项目同源行为已解决。当前仅源码映射，未改这些共享产品文件。

**原子清理真实反例已取得，尚未修复：** 独立探针生成两个真实 12 秒 MP4，合法 ZIP 经默认 `expandSourceUpload` 对照成功；仅损坏第二项 CRC 后，实际得到 `REDRAW_ZIP_ENTRY_READ_FAILED`，第一项仍残留于存储。最终“失败后存储字节完全相同”断言原生退出码 1；既有源片和哨兵未改，抽取临时目录为空，说明缺口在已持久化部分而非解压临时文件。源码前后 SHA `928a26c1783fcf602232fda4ea598555c82421f8daffb6f18bb13c5b90b18416` 不变。证据目录 `.codex-staging/g3-zip-cleanup-probe-20260906-r1-media-GURvom`，`evidence.json` SHA `9bfda7cdaa995c9af4e850ce01f39c51924652e7cba78bdc78cc94af92e1cf39`、`native-exit.json` SHA `565604952549f03aef0c46a2014388d849dc45538a8505166fd05a22721770e3`。没有 mock probe、解压或时长限制；正式修复须保留此反例并仅回收本次新建文件，不删除既有同 hash 素材。此证据不确定新容量数值，也不代表 G3 支持矩阵通过。

**G3.1a 可独立先行的最小缺陷包（G1 双审后，容量确认不阻断它）：** 只改 `redrawUploadService.js` 的 ZIP 解压/验证/发布顺序及正式 `redrawUpload.test.js`，有必要可增加该测试专用 helper。全条目 CRC 和默认媒体校验都成功后，才进入同步持久化循环；每条暂存到当前唯一 extractDir 内按索引命名的独立文件，原 entryName 仍供安全检查和返回显示，避免延迟发布时 `a.mp4` / `./a.mp4` 等旧接受名称覆盖同一暂存路径。无路径/时长/容量合同扩大或收窄，无全局 hash 回滚删除。

- [x] 正式真实媒体 RED：第二项 CRC 错、第二项媒体不合法/时长错时，断言整个存储目录哈希清单与之前一致且临时抽取清空；合法两项对照实际 probe/hash 可读，既有同 hash 和哨兵不变。原最小探针失败记录不改写。
- [x] GREEN 后补两个名称映射同一旧暂存路径的不同有效视频，确认两项返回的实际字节/hash 各自正确；保留旧 entryName 返回及内容去重，验证失败路径不得删除任何既有文件。
- [x] 索引暂存不得使原本无法作为文件路径的NUL名称变成可接收项：补真实raw ZIP名称回归，必要时在既有safeZipEntry补NUL拒绝，保持原合法名称/别名的内容与显示语义；其它ZIP资源/符号链接/规范化策略留后包，不借此扩展重写。
- [x] 上传聚焦、默认 handler 相关回归和 SPEC→QUALITY 通过后，只关闭“ZIP 验证失败的提前发布残留”。现接口没有跨文件 I/O 原子提交工具，发布中磁盘故障、DB 登记失败以及跨请求共享引用清理仍须后续单列验证，不能把同步循环或 `persisted_file_created` 当跨进程所有权证明。

2026-09-07 本地退出：作者RED20/14pass/6fail→GREEN20/20，根20/20+4/4；SPEC独立20/20+3/3实际MOV/时长/数量边界+4/4，QUALITY独立20/20+1/1受控异步隔离，全native0。QUALITY报告SHA `38f3ca98dce9991329f1a17fdd49b78fc3bc307770bc7f6e2c304695c9c35858`，回执SHA `332a63cdefa9a25b7ab5ae24c696ff9cbae34150308694a6d6908905de516cfe`；根已亲读实际源码、测试、双审报告与原生结果。异步探针注入probe用于时序，不冒称媒体真实性；默认媒体真实性另由正式/规格回归证明。历史提案中的失败后删除未采用，以验证前不发布解决这一缺陷。

- [ ] 以默认产品上传处理 MP4/MOV 和含两份合法视频的 ZIP；先复现 ZIP 只显示首作品及未配置展开限额，预期不得丢失第二作品入口。
- [ ] 在当前上传策略中落实压缩/单文件/条目数/总展开量限制并在页面同源展示。保持现有时长承诺；若资源安全需要实质改变接受范围，先呈现新旧限制和原因，不静默收窄。
- [ ] 覆盖非法路径、符号链接、膨胀包、重名、混合有效/无效项原子结果与清理；至少横竖视频、无轨/音乐、多人和跨镜对白经过本次媒体的默认分析链。
- [ ] 运行上传/事实纠错/默认分析/页面与浏览器回归，独立双审；每个组合单列通过/未测，不写“任意视频全通过”。

#### G4 动态执行与恢复执行包

**责任落点：** 新建 `backend-node/src/services/redrawExecutionRunService.js` 和相应 `redrawExecutionRun.test.js`、专用运行迁移（实施前检查实际迁移尾号，禁止抢占其他会话迁移编号）；小范围连接 `redrawExecutionQueueService.js`、`redrawExecutionPlanService.js`、`redrawGenerationService.js`、`redrawBillingService.js`、`redrawCandidateReviewService.js`、`redrawOrchestrator.js` 和队列页面。回归为 `redrawExecutionQueue.test.js`、`redrawGeneration.test.js`、`redrawShotBilling.test.js`、`redrawCandidateReview.test.js` 及真实后端浏览器。先运行事实/原子领取，再生成/审批续行两包，共享路由/页面串行修改。

**G4.0 固定持久化合同（实施前必须对照迁移测试）：**

实际 unit 连接缺口已只读确定：现有 preparation/generation gate、production pack、reference bundle 均按旧 shot 行与原时长绑定，且旧 pack 明确拒绝跨镜对白；禁止复制旧 shot 或伪造 ready 回调来领取 unit。实施顺序细化为 unit 非提交检查（实际 work/source snapshot、完整 unit 对白与所有 parent/reference 资产及范围绑定）→现有 `modelPrice.calculateCharge` 只读报价并把实际金额纳入 quote hash→精确选定配置/凭据 readiness→事务内重核与 claim。不存在 `getVersionReadiness` 可直接复用的导出；源快照和报价底层可复用，但旧 quote 的 input_hash 不含金额。此处明确待补实现，不是把逻辑参考哈希当真实资产或声明动态执行已通过。

2026-09-07 首包只读映射已完成：操作时最大迁移号75，后续实施仍须重新检查。现有 `getExecutionQueue`、`getExecutionPlanReview`、`previewVersionExecutionPlan` 均同步，可在新 immediate 事务中嵌套校验；必须额外核对返回的当前 queue ID 与 run 指定队列一致。公共 queue 不含 review_id，公共 unit.id 是逻辑ID，不能当数字外键。已有 preview fixture 导入会注册其它测试，首包不能把它冒称纯helper；双连接测试可从实际 fixture backup 到唯一临时SQLite，再开两个连接验证真实锁竞争与提交后唯一性，同线程 Promise.all 不算并发证据。当前没有新增 run/attempt 实现或验收，readiness/报价/实际执行仍按下述完整合同补齐。

**G4.0a 最小 unit 事实适配包（已完成本地双审）：** 一个新 `redrawUnitProductionPackService.js` 和正式测试，提供一个纯 `compileUnitProductionPack({owner,expected,queueState,blueprint,localization})`，不新增 DB compiler、loader、独立审批表或另一套 current 系统。`queueState` 来自实际 `getExecutionQueue` 完整结果，expected 精确绑定 review/queue/plan/unit 及 unit hash；重新校验 owner、审核/队列状态、当前计划与单元内容哈希、蓝图/本地化绑定及每段 parent contract。此函数只是后续真实准备的事实适配，不是 ready 或生成完成证据。

输出限生成必需内容：版本化 schema、上述 owner/source/蓝图/本地化/能力绑定、unit 源时间及生成/保留/padding 时长、有序父镜相交段、完整对白及当前目标名字、相关角色名字映射、原逻辑 reference requirements、确定性 production_pack_hash。父镜段保留构图、镜头运动、起始/连续动作/结束、可见角色、文字区域几何与证据及对应译文、声音约束、evidence refs；不全量复制全局故事/场景/道具库，有实际 prompt 消费需要时再定向投影。不得将 requirement hash 当真实资产 SHA。

G4.0a 字段澄清：`parent_contexts.confidence` 必须原样保留对应父镜的视觉不确定性，属于上述“保留事实/证据”的必要内容；不因明列字段未重复写它而丢弃，也不得默认提高/伪造可信度。其余仍限本包生成事实，不扩展全局模型。

G4.0a 局部退出证据：service SHA `9594ebd1c23b21e85e9e1a67fb932c3f2e4b7ab5091ce3c55b2baa9ce6bda735`、test SHA `f1cdbe2cfdfa8206d0b6b02a1ff9cc86f2f165d8a62dbc4cbbbf8e342f971119`；正式43/43含13自有+30导入既有测试，根六套291/291/native0/123源稳定。SPEC r3 PASS、QUALITY r2 APPROVE，原S1—S4及Q1实际反例关闭，历史失败证据不覆盖；同源数字字符串兼容只对齐现有preview，真正不同源仍拒绝。累计记录目标为 `.codex-staging/g4-unit-pack-verification-20260907-r1.json`，须校验所有冻结源/原生日志/双审后生成并独立回读，才交下一作者。整个G4的执行、素材、费用、供应商和质量状态机仍不勾选。

完整对白以当前 plan unit 的 source resolver 时间为准；localization 的父镜投影时间不能覆盖它，译文和说话人关联则必须一致。跨父镜对白只输出一次，部分父镜的 opening/ending 明确标为父镜上下文，不冒充截取点。精确区间 motion/source 文件检查归入既有实际 readiness，不新增每次 split 的人工见证门禁。包不写死永久 executable:false，也不自行发 ready；实际准备、价格/能力/资产 hash 和事务领取仍须后续完整接通。

首批正式 TDD 覆盖跨三个父镜的完整对白、单个长父镜拆分时视觉事实保留、owner/指定 queue/review 绑定、任一内容/hash 漂移、逻辑参考与资产区分、确定性及原 shot 合同不变。新增错误只分 `REDRAW_UNIT_PRODUCTION_PACK_INVALID` 与 `REDRAW_UNIT_PRODUCTION_PACK_STALE`，已有蓝图/本地化验证错误保留，必要时使用安全 reason。旧 `localizeVisualText` 仅做名字/文化词替换，不是完整视觉翻译；后续 unit prompt 须真实适配目标视觉文字，不能删源事实来通过无源语言检查，也不另加人工审批。整个 G4 的退出仍是实际 unit 准备→报价→claim→生成→审核/恢复，而不是这个结构化包。

G4 下一参考适配只读落点：`buildCurrentReferenceBindings` 已验证父shot owner/source、审批coverage、identity/clean字节并给绑定；`identityBindingForAsset` 单独不足以证明实际文件。后续可窄增内部父材料只读导出复用这些私有校验，避免复制验证器。保持每个原logical motion requirement一个真实文件；完整父范围可引用原已审核文件，部分范围只能从其可信私有快照派生，绝不把母本当新动作参考或伪造数字shot ID。只读inspect不隐式登记，显式本地prepare才允许新asset/新unit metadata，不改父审批和immutablequeue。旧motion verifier仅±100ms/正宽高不足以证明unit精确范围；已有processing timing可复用，旧手工导入若缺可信映射应明确待处理，不假造split见证。范围/帧序/时长/SAR/DAR/旋转及前后hash需实际媒体回归；逐像素相等是可选实验验证手段，尚未被采用为新增生产审批或强制无损编码平台。此处仅下一包落点，不是readiness、派生或提交已实现。

**G4.0b 第一落地包：当前 unit 到真实父材料的只读连接。** G4.0a 双审和累计回执关闭后，由全新作者实现 `redrawUnitReferenceService.js` 与正式 `redrawUnitReference.test.js`，必要时新增一个纯测试 helper。入口 `inspectUnitReferenceMaterials(ctx, expected)` 的 expected 只含精确 version/review/queue/plan/unit/unit_hash；owner、源、蓝图、本地化与实际资产均由服务端读取。蓝图按该版本对应 revision 读取，与既有 preview 的语义一致，不因另有新 draft 而引入新的全局 latest 政策。复用实际 getExecutionQueue、getLocalizationReview 和 unit compiler；母本通过现有 source snapshot 核验，绝不作为动作参考返回。父行按 owner/work/version/逻辑 shot_id 唯一映射并逐项核对完整范围，不把 unit ID 强转数字。

只读读取当前已审批 coverage/identity/wardrobe/text-clean/bound-motion 的实际文件与 SHA，参考顺序和数量按原 requirements；同一 logical identity 只输出一次，服装/清理图保留为依赖，不额外塞入供应商 reference。完整父范围标为可复用父材料，部分交集标为 needs_derivation 并保留精确 overlap，本包不生成或登记派生片、不发整个 unit ready。若旧 loadCurrentReferenceBundle 的父对白门禁与已通过 unit compiler 的跨父/画外对白冲突，先用正式反例证明，再仅在 bundle service 增加内部 reference-only reader，复用已有私有验证器；不得修改旧 save/load/projection 语义或拷贝另一套身份验证。实际 source、父材料、版本/计划在异步检查后重核，读取期间漂移拒绝返回成功；不声称获得文件与 DB 的全局原子锁。

正式 TDD 使用真实隔离 SQLite、实际合成 MP4/PNG 与默认 probe。已有 reference-local-case fixture 是可解码合成媒体和测试审批，不是去身份效果或真人审核证据；preview fixture 的源 hash/文件不能直接伪贴到该媒体。先按实际 source SHA 与父时长统一蓝图、音频证据和 capability fixture，再通过真实 preview→save→prepare→get，禁止手拼成功 queue。覆盖完整父引用、部分父待派生、跨父有序引用、owner/缺文件/篡改/审批失效/await 漂移、重复读取无产品表写入、无新文件发布和原 shot 合同回归。必要的内部导出若触及既有功能锁，仅追加本次已授权的本地开发记录与正式反例，原 protectedPaths/requiredTests/evidence 和全部历史保持原义。该包的下一步是显式本地裁取，不是供应商提交或整组 G4 关闭。

父动作审批读取补充：`verifyMotionReference` 只验证绑定/实际MP4，并不重新检查四项原审批。使用已有 `prepareMotionReferenceCandidate` 的只读句柄核验当前 completed import、owner/source/范围、四项确认与实际字节，并保持其 assertCurrentBinding/cleanup 生命周期；选中的 bound-motion 必须是该已验证候选，不回退到旧候选。source snapshot 同样只做源事实核验。此为复用已存在审批，不新增人工检查；`run-redraw-reference-bundle-local-case.createFixture` 已提供实际 completed import 记录，可作为合成媒体测试底座。

入口不得以“已成功保存旧父 reference_bundle”为必要前置，否则画外/跨父对白在旧 save 的 dialogue gate 失败后仍无法进入新unit链。只读使用既有 preparation_snapshot_json.clean_results 中结果ID作为查找线索，全部审批/owner/source/coverage/文件由实际validator重核，不信任snapshot成功标签；已保存bundle的哈希验证后可作兼容查找，但不是新审批。无可用结果线索时明确缺材料，不另造asset resolver。正式正例必须包括当前已审批且bound的父材料存在、旧对白bundle尚不能保存、unit事实有效的场景。

后续显式派生的实现落点（当前尚未实现）：已有 `assertStoredProcessingMaterial` 能重核 processing attachment 与当前审批输入，`verifyProcessingUpload` 能核对实际MP4帧/包及显示比例，优先复用而非再造报告验证器。只有与目标范围存在正长度交集的原已批准帧才参与裁取；起点在帧内保留当时正在显示的帧，首PTS从0开始，末帧显示时长以交集结束为准。实测普通trim会丢首帧；新方法已有三个合成正例，但还须以当前材料、实际处理报告和正式产品测试连接。固定1/12800不能精确表示部分毫秒不是产品不支持的结论；已有处理器用 `lcm(source_denominator,1000)`，未来派生可复用这个整数时间基规则，实际编码/探测前不能声称精确。无可信源到已处理父视频时间映射的旧手工片段不能凭±100ms时长声明可精确拆分，需如实待处理，不增加伪审批或把母本替成动作参考。

G4.0b 局部退出：Q1 通过复用原 candidate owner/scope/latest-record closure 修复，关闭后的 FD/path/stream 失效原义保留；S1 完整候选行与实际材料字节终检保持。最终作者正式118/118、SPEC原探针19/19、QUALITY原owner/cleanup探针10/10、根11套512/512均native0且无skip/cancel。根回执 `.codex-staging/g4-unit-reference-root-20260907-r3.json` SHA `957a2d1604c60978accc059214f8d45a1c7e87936e89c3e5254ad30fea5c0065` 绑定126源；累计校验器仅在最终双审/所有源及证据匹配后写入 `.codex-staging/g4-unit-reference-verification-20260907-r1.json`，独立回读成功才交下一作者。保留所有旧失败及测试观察边界错误，不宣称派生/ready/整个G4或产品完成。

**G4.0c 显式本地派生与登记实施细化（在 G4.0b 双审/根累计关闭后执行）：** 新 `redrawUnitReferenceDerivationService` 的 `prepareUnitReferenceMaterials(ctx,input)` 接受既有精确 unit 六项绑定及 `expected_materials_hash`，不接受调用方文件、帧、报告、模型或审批结论。当前完整父引用保持原样；部分引用全部准备成功后才登记本单元结果，任何缺可信映射/字节/审批/计划漂移拒绝且零新资产登记。保留母本、原父资产/审批及不可变队列；本包没有 HTTP、报价、生成、运行状态机或新的人工审批。

1. 以独立 internal 模块承载既有 unit reader 的窄受控 callback 入口，复用它的实际 current pack、source、parent、candidate 和同步终检；原 `inspectUnitReferenceMaterials` 保持唯一公开导出、原输入/输出/零写入语义。内部 consumer 可读取当前已核验父 FD 和 processing attachment，不能把路径/句柄返回客户端；所有异步收尾之后再同步最终检查与登记，过期 lease 不可读。内部同步 finish 在最后 cleanup await 之后执行，在 immediate 事务内再次复用当前记录/字节断言；事务不得跨 await，不让 consumer 提前宣称登记成功。commit 为发布成功点，其后不再 await 或执行可将本次改报失败的终检。
2. 从已核验父 candidate 的 FD 复制到本次独占私有快照，真实复制 SHA 与父审批字节一致；复用现有路径/FD/独占创建及本次目录清理原则，不把 `withSourceVideoSnapshot` 的母本绑定改成通用任意资产入口。原 processing attachment 用现有 `assertStoredProcessingMaterial` 重核，完整父快照用 `verifyProcessingUpload` 实际探测。报告中的全局 `frame_index` 仅是源关联，父 MP4 选帧必须使用报告数组序号。报告 provenance 和未验证像素/来源声明保留原义。
3. 按实际已绑定 `clip_interval` 与单元源交集生成连续的整数 timeline，使用公共时间刻度、保持首显示帧和末显示时长、原 W/H/SAR/DAR/方向/帧顺序、无音轨。优先窄导出已有 timing/output verifier 核心而不复制第二套验证器；不能把 unit 填成伪 shot processing report。真实编码后逐帧/包复核、末端输出 SHA 绑定。1/12800→1/64000 的单样本路线已有真实实验，不抵扣正式处理父片产品测试；不支持的实际媒体边界明确拒绝。
4. 派生归属以窄新增 `redraw_unit_reference_derivations` 权威表登记，不仅查询客户端可写的通用 assets.metadata。迁移取操作时本地最大号+1；至少保存 owner/work/version/queue/queue-unit、unit/plan/materials/requirement 绑定、父 import/asset/SHA、处理报告/材料 SHA、交集/帧映射/recipe 与输出 probe/SHA/asset ID；可将复合细节放规范 JSON，避免重复列或另建状态机。FK 与同事务业务校验保持当前 owner/queue 一致；以完整派生输入（包含父 import/处理报告及 recipe，不只 materials_hash）的 canonical hash 连同 owner/queue-unit/requirement 形成唯一键，防止不同当前绑定误命中缓存，旧记录不可重贴标。通用资产 metadata 只作描述，不能独立构成有效派生。
5. 本次文件使用唯一目录和独占文件名，不共享以 SHA 命名的可删除落点。临时资源完成全部异步复制/编码/probe/收尾；待登记输出由本调用独占持有，不纳入该临时清理。同步 immediate 事务内重核当前绑定与已验证输出字节，再判重并原子插入本单元全部新资产/登记记录。重复分支同步重核权威记录和原资产，只同步清理本调用未发布输出，不能删除赢家或历史文件；该分支也不得在提交后再 await 清理而把成功变成失败。提交前取消/失败回滚、零新登记；未能清除的本次私有残留如实记录，不扩大为服务器清理。资产是否存在、删除/路径/字节/归属变化均重验，不以单个 metadata hash 或旧成功标签放行。
6. 正式 TDD 必须在同一实际源/owner/队列 fixture 中走真实 `withMotionObscuration→import(processingReport)→bind/prepare`，再做 unit 派生，不给旧手工 motion 伪贴报告。覆盖帧内起点/精确帧界/尾帧/单帧/VFR与非方形像素、跨父顺序、重复/两个连接并发、无映射零登记、通用资产伪造 metadata 不命中权威记录、当前审批及最后 await 漂移、输出换字节、事务失败、清理和旧 inspect/shot 合同。合成素材审批与 FFmpeg 证明不冒称真人去身份/英语质量或整个 G4 通过。唯一新作者完成后仍按 SPEC→QUALITY→根回归/累计回执顺序。

G4.0c 容量反例补充（根独立实验，不代替正式产品 TDD）：同一逐帧嵌套 `if` 表达式在 1/4/25 项下真实 FFmpeg 解析成功，在 100/300 项下 `setpts` 解析失败；900 项在本机尚未启动进程即 `ENAMETOOLONG`。因此不能用少帧 VFR 样本证明普通 25/30fps 五秒单元可用。唯一作者须补实际父处理/队列/派生的常见帧数 RED→GREEN，选择命令长度与解析深度均有界的最小映射实现，同时保留原首末帧/整数 timing/输出逐帧验证；不能把常见帧数静默排除出支持范围。实验原生失败及小规模正控单独留档，不推测精确表达式最大深度。

- 新迁移文件语义名为 `redraw_execution_runs.sql`，数字前缀在实施时以当前最大迁移号加 1 分配并写入当批回执；迁移 75 的表和 immutable triggers 原样保留。`redraw_execution_runs` 包含 `id INTEGER PRIMARY KEY`、owner/work/version/queue/review IDs、plan_hash、status、`pause_requested INTEGER CHECK IN (0,1)`、`revision INTEGER`、created_at/updated_at；`UNIQUE(tenant_id,user_id,queue_id)` 保证重复创建返回同 run，queue/review/version/work 使用 FK。创建只登记，不预留/生成。
- `redraw_execution_unit_attempts` 包含 id、run_id、queue_unit_id、attempt_no、unit_hash、status、claim_token、`readiness_hash`、request_hash、task_id、reservation_id、provider_task_id、output_asset_id/output_sha256、candidate_hash、quality_json、approved_by/approved_at、submit_started_at、created_at/updated_at。run 与 queue_unit 使用 FK；`UNIQUE(run_id,queue_unit_id,attempt_no)`、非空 task/reservation 标识唯一，partial unique index 保证每个 run 最多一个活动 `claimed/submitting/running` attempt。跨表 owner/queue/版本匹配在同一 immediate 事务校验，不能仅信任单列 FK。公开接口不返回凭据/本地路径或私有 claim_token。
- run 状态只有 `ready/running/waiting_review/paused/failed/needs_attention/stale/completed`；attempt 状态只有 `claimed/submitting/running/waiting_review/approved/rejected/failed/needs_attention`。未领取单元仍从不可变队列导出 `pending`，不在其上 UPDATE。首候选无论技术 QA 是否通过都必须 `waiting_review`；后续单元通过既定逐单元质量门禁才可 approved，需人审的证据不得自动批准。失败/拒绝/unknown 禁止领取后继；全部单元批准才 run completed，尚未代表合成或交付完成。
- `claimNextUnit` 在 `db.transaction(...).immediate()` 内校验 owner、当前计划审核、运行 revision、素材/能力 readiness_hash、pause 和所有前序单元放行；插入唯一 attempt 及 claim_token，条件更新 run revision。同一事务中不执行网络或 FFmpeg；提交前异步重核材料后，在第二次 CAS 中记录 request_hash/submit_started_at 和 `submitting`，才可调用最低层供应商。
- 本地默认只允许每单元 attempt_no=1；不因重开页面/服务重启创建 attempt 2。现有计费底层复用，资源显式为 `redraw_execution_unit` + attempt ID，不能冒充 `redraw_shot` 或再次按父镜预留；任务/输出/审核都绑定这个 attempt。新增有限资源类型需真实积分服务隔离回归，原 shot 路径保持不变。
- 恢复 `claimed` 只可续行同一 task/reservation，且必须确认 `submit_started_at` 为空、没有任何外部受理记录；`submitting` 中断且没有可信 provider_task_id 变 `needs_attention`，不自动 POST、退款或重领；有已知 provider_task_id 仅按对应授权轮询同任务。明确失败按照实际受理/账态证据结算，unknown 保留 held。人工修复账态、新尝试或付费重试不属于自动恢复。
- 暂停仅设置 pause_requested，不强杀正在提交的请求；当前回执仍落到同 attempt，之后停止领取。恢复须显式操作并重核 revision/plan/readiness，无新预留的状态读取不等于允许再生成。上游 hash 变化将运行标记 stale，原工件/账态保留。

**G4 HTTP 合同：** `POST /redraw/versions/:id/execution-runs` 只接受 `{expected_plan_hash, expected_queue_id}`，返回同一 run 的摘要，零生成；`GET /redraw/versions/:id/execution-runs/:runId` 只读恢复。`GET .../:runId/readiness` 返回当前 `readiness_hash` 和 `{quote_hash,amount,unit_amount,count}`；复用现有 `modelPrice.calculateCharge` 和稳定快照 hash，计费单位保持积分，缺价格不得发执行票据。现有报价没有 quote_id，不新建报价表或虚构已有票据。`POST .../:runId/advance` 接受 `{expected_revision,expected_plan_hash,expected_quote_hash}`，服务端重新计算包含当前 readiness/金额/次数的 quote_hash，不接受 Key/model/baseUrl/unit JSON；第一次实际领取仍需明确页面开始操作。`POST .../:runId/pause` 接受 `{expected_revision}`。`POST .../:runId/units/:unitId/review` 接受 `{expected_revision,expected_candidate_hash,decision,checks}`，复用真实质量条款，不能将布尔 checks 当机器内容证据。owner 不匹配 404，非法字段 400，旧版本/未就绪/报价漂移 409，内部未知 500 并保留未知状态；重复 advance 返回原 attempt，不新增提交。resume 使用相同 advance 门禁，不能只清状态。报价/余额/策略在真正预留时再次检查，不另造支付平台。

**启动与结算连接补充（独立只读映射，尚未实施/测试）：** `app.js` 的视频恢复在 `redrawResume.finally()` 外立即启动；只有 `resumeRedrawTasks` 的同步前缀早于视频扫描。新 unit 中断保护必须同样在首次 await 前执行，且 `videoService.resumeProcessingVideoGenerations` 本身要按 unit/attempt 分流，不能只靠调用顺序。`taskService.failOrphanedAsyncTasksOnStartup` 先触发 provider reconciliation，后者又先触发 30 分钟 held 退款；当前 `billingReconciliationService.refundExpiredGenerationReservation` 不按 resource_type/submit marker 保护 unknown。所以仅添加 generic orphan 类型白名单不足以保留 unit 的 held：对新 `redraw_execution_unit` 增加有限、明确的超时退款排除，由 attempt 恢复/证据结算负责；旧普通生成的 30 分钟合同和旧 shot 路径保持不变。若接入 generation route，连带检查其明确失败退款分支不可绕过 attempt 权威状态。

旧 shot 的 reservation 只放 task.metadata，video 的 `credit_reservation_id` 为 NULL，因而底层 video completed 不确认预留；明确失败由 generation 事务结算，成功由人工候选批准事务确认。新 unit 必须维持一个明确的 attempt 结算负责人，不能把 reservation 挂到 video 后同时依赖“审核后确认”。需正式反例才窄改的连接文件为 `app.js`、`taskService.js`、`videoService.js`、`billingReconciliationService.js`，以及必要的 `providerReconciliationService.js`；不扩大为全站账态重构。相邻入口是 `taskService.test.js`、`videoRecovery.test.js`、`providerReconciliation.test.js` 和现有 redraw generation/provider-adapter/billing 测试。新增故障矩阵必须包含：源分析 Promise 未完成时的启动顺序；marker 已写且无 ID 的 generic/video 分别直调；时钟推进 31 分钟；已知 ID 查询失败；审核事务后续写失败。全部验证同 attempt/同预留、零重 POST、未知不退款、事务回滚，且旧测试不改成新语义。

- [ ] 不可变 plan/review/queue 保留原样，在专用运行/尝试关联中保存 unit 状态；先用真实 SQLite 写并发领取 RED，断言双击只领取一次、未知不能重新领取、不得将 unit ID 伪装为 shot ID。
- [ ] 复用已有任务、计费与供应商适配，将当前单元范围、完整对白、就绪素材和输出绑定贯穿实际调用；本地只替换最低层供应商，不手写 completed 结果。
- [ ] 首单元成功停在待审；审核 hash 与当前计划相符才放行。拒绝、未知、明确失败均停止后续，先前合格片段保留；换模型或重试另受授权约束。
- [ ] 真实进程/连接重开读取同一 run，验证无多一条生成或预留；上游素材/计划漂移、并发批准、迟到回执和第 N 单元失败有正式反例。双审通过才关闭 G4。

G4 后续只读报价落点补记（源码核对，尚未实现/测试）：`modelPriceService.calculateCharge` 直接读取现有价格与分辨率表，不调用 `ensureSchema`，可复用计算；相邻 `requirePrice` 会调用 schema 修复，不能因名称像读取就用于零写入 readiness。当前计算还接受 `allowedDurations` 并区分已配置 free 的0与缺价异常；新 unit 报价须按已审核能力处理这些现有语义，不经旧 `quoteShotGeneration` 的单镜/5–15秒正金额限制，不把unit伪装成shot。旧 `reserveShotGeneration` 的 operationKey/resource_type 固定为 redraw-shot/redraw_shot，后续新 attempt 仍按上文明确的 `redraw_execution_unit` 身份复用实际账本，不改旧shot合同或线上定价。免费账态的具体接入须先检查现有账本合同并做正式反例，不能仅因报价0就伪造已预留或已扣款。此记录不发执行/费用许可。

G4 普通页面素材连接缺口（只读确认，尚未实施）：现有路由只有 execution-plan/review 与 execution-queue；`reference-preparation-quote/reference-preparations` 仍进入父shot的供应商素材准备，不能拿来冒充零供应商的unit本地裁取。G4.0c仍仅完成后端小包；随后readiness/run连接包必须补齐对应只读检查与显式本地prepare的API/UI，让普通用户不需要内部ID或CLI。继续复用精确version/review/queue/plan/unit/unit_hash和materials_hash绑定、owner与错误分类；GET不隐式登记，显式prepare只做本地派生、零供应商，且不等于开始生成。实现该连接前在本计划固定最小路由及页面动作，不扩大旧父材料付费接口或将其旧shot_ids改作unit_ids。此项属于整个G4退出条件，不能因G4.0c函数测试通过就勾选普通用户执行链。

已登记派生的后继读取也必须与显式prepare分开：原inspect继续如实返回逻辑部分范围的needs_derivation，不能为命中旧资产改变其已冻结DTO；新readiness不能通过再次调用prepare、编码后判重来冒充GET零写入。下一连接包需复用当前输入规范化与权威记录/实际输出复核，提供纯读取已准备结果的窄入口；没有当前输入对应记录时待显式准备，已存在权威记录而其输出/绑定损坏时明确阻断，不插入资产、不生成临时派生视频，不信任客户端回传的旧成功DTO。后者不能误导为再次prepare必能修好：76的唯一输入和不可变记录不允许静默覆盖旧赢家。复用整父和派生后的真实时长分别核对，`original_duration_ms`仍只是原父时长，不当作新五秒资产时长。此是下一包的消费合同，不要求当前G4.0c作者临时扩展接口或另写一套renderer。

**G4.0d 已准备素材只读消费包（仅在G4.0c双审、根完整回归与累计回读后交新作者）：** 在现有derivation service新增服务端 `inspectPreparedUnitReferenceMaterials(ctx, expected)`，接受原unit六项绑定，不接受客户端资产/路径/成功DTO；原inspect和prepare合同不变。内部复用当前材料reader，窄提取现有mapping/recipe/canonical input与已登记输出校验，不能拷贝第二套处理/审批验证器。必要提取限该service及一个内部模块，不做公共通用库、迁移或模型配置变更。

责任默认仅 `backend-node/src/services/redrawUnitReferenceDerivationService.js` 与新 `backend-node/test/redrawPreparedUnitReference.test.js`；复用现有fixture，确有必要才在报告中列明最小内部提取/测试helper变化。根负责本计划和总报告。成功检查DTO中的 `prepared_materials` 为原prepare完整返回对象（包括 `prepared_materials_hash`），不再另造第二种可执行材料格式；未准备状态省略这个对象。

同时收口G4.0c QUALITY的非阻断Minor Q1：duplicate loser目录已实际成功删除、随后赢家终检正确拒绝时，外层二次cleanup误附ENOENT。沿用同一service，允许在原derivation测试文件追加一个正式反例并最小记录“本次目录已成功清理”，不能宽泛吞掉ENOENT或把未知身份目录当作已清理。原QUALITY观察探针保持历史，其native0表示缺陷复现成功而不是已修复；本后继包须另做期望正确行为的RED→GREEN。

- 输出新检查DTO：schema `redraw-unit-prepared-reference-inspection-v1`、当前bindings/materials_hash、status `prepared`或`needs_preparation`。全部引用有效时附与显式prepare一致的prepared材料DTO及hash；任一当前部分引用尚无登记时不发prepared成功hash，并指出缺失requirement_id。旧权威记录/资产/字节损坏、owner/计划/审批漂移等继续使用明确INVALID/STALE等拒绝，不当作成功或隐藏为正常缺材料。
- 完整父与身份只复用当前已审核读取结果；部分父重新计算规范输入并按精确owner/queue_unit/requirement/input_hash查76。从实际存储文件做FFprobe/帧包、geometry/timeline、大小/字节SHA与权威envelope复核；不以JSON metadata或先前返回对象替代实际媒体。现有材料读取的私有只读快照/清理可保留，本包禁止新派生编码、创建持久unit目录、登记资产或任何产品表DML；不是承诺零OS临时文件。
- 异步探测与现有reader清理后同步终核当前父输入、所选完整权威/资产行以及实际输出字节；不把已过期句柄用于读取，也不新造全局文件/DB锁。新检查不调用prepare，不读取供应商Key/default config/default DB，不报价、不提交。
- 正式RED→GREEN基于现有真实fixture/prepare已发布文件：未准备、整父零派生、prepare后跨父有序成功与相同prepared hash、重复/新连接读取零DML/零编码、缺输出/坏SHA/元数据或authority损坏、owner/队列/审批漂移、最终清理await期间赢家替换应拒绝。同时回归原inspect和显式prepare；读取缺记录不得创建unit目录。root独立审查与验证后才接API/readiness，不能将本包称为用户生成链通过。

G4 selected-config 后继约束（独立源码映射，尚未实现）：readiness 必须复核保存的 video config ID/revision/provider/实际protocol/model/capability/evidence/adapter；replace 音频还须核对已选 TTS config/revision/evidence，任何失效均 blocked/stale，不遍历备选。`getVideoConfigById/getConfig` 是精确只读读取但不是完整门禁；默认 `getDefaultVideoConfig` 分支会经 listConfigs 修改 default 标志，`getModelFromConfig` 还可把不匹配的 preferredModel 换为默认模型。新unit链必须以真实失效且有效备选存在的反例锁住“零通用选择/零改选/零写入/零提交”，不改旧通用选择器或线上模型。沿用各现有 provider 实际凭据优先级（例如 Fumin 配置优先、ToAPIs 环境优先），不能统一强改为另一优先级；本地实现和回归仅用合成凭据。凭据非空、精确配置/证据绑定与真实生成是不同证据层级，不因 hasConnectionCredential 返回true就冒称实测，也不凭空添加所有provider都不存在的统一凭据证明门禁。后继公开readiness不得泄露Key、完整settings、endpoint/base_url或内部配置对象；实际有效凭据漂移须在执行前绑定复核，不改变既有WAN3特殊指纹/preview未检查的边界。详见根已读映射 `.codex-staging/g4-readiness-selected-config-map-20260907-r1.md`；真实Key读取、外部实测仍待对应明确授权。

**G4.0e 普通用户单元素材入口（已本地收口，累计4fd0b89…；以下保留批准合同）：** 根实际读取现有接口/页面确认：新的unit队列在 `RedrawExecutionPlanReviewPanel.vue` 的execution-queue区；`RedrawGenerationQueuePanel.vue`仍是旧shot/provider重试摘要，不应把新unit状态塞进其shot字段。当前queue DTO已有 `unit_hash`，review ID来自同响应的current saved_review，既有sequence/context/alive可防止版本切换后旧请求回填。复用这些绑定，不新增队列schema或让用户查内部ID。

后继selected-readiness落点补充（2026-09-07，纯静态合同审查；必须等G4.0e累计关闭才交新作者）：只读服务复用preview内部“单条video evidence和已指定audio evidence→capability”算法，窄导出exact-selected入口；不导出/调用全量planningCapabilities来假装精确读取。原preview投影、候选次序、DTO/hash、无凭据读取及WAN3未检查语义不变。replace摘要可在唯一选中TTS行按原evidence_hash找回provider/model，不用selectTtsConfig或新native证据改选音轨。有效凭据/目标地址沿用真实provider解析，私有摘要与公开状态分离，不新建secret注册表或统一“Key曾实测”门禁；未来claim前仍需重新核对并使提交消费同一有效值。实际TTS使用config Key而非环境兜底，OpenAI兼容分支允许无Authorization，不能擅自全局增加非空Key要求；preview的audio carrier与现有tts执行适配不兼容时明确阻断，不能改类型/改选来通过。TTS纯解析若需提取只限实际分支并回归原接口，具体责任及语义须先核对再实施。当前未新增该service、未查真实配置/凭据、未宣称readiness或执行可用。

- 最小路由：`GET /redraw/versions/:id/execution-queues/:queueId/units/:unitId/reference-materials`，query只接受 `review_id,plan_hash,unit_hash`；`POST` 同一路径，body只接受这三项和 `expected_materials_hash`。三个路径参数与已校验的query/body组合成原六/七项服务输入；非法/多值/额外字段400，owner或不可见version/work/queue404，旧绑定和素材失效409，内部媒体/I/O失败脱敏500。客户端不能选择路径、模型、凭据或注入unit JSON。
- GET只调用G4.0d的实际检查，不隐式prepare；POST只调用本地prepare并返回原prepared DTO。页面POST返回后通过GET复核当前状态，不自动重试POST；网络中断后允许重新GET查状态，不能把“登记结果未确认”当作成功。业务DB仅POST的局部资产/派生登记，仍无供应商调用、报价或开始生成。
- 责任：后端现有routes/redraw.js、routes/index.js和新handler合同测试；前端api/redraw.js、execution-plan页面最小挂接及一个窄unit-materials子组件/状态测试。从已验证的queue.units选择单元，显示序号、源范围、已准备/待准备/失效以及显式“检查素材”“本地准备”动作，不沿用旧shot的retry。通过现有preview/review/queue匹配决定可操作；保存审核、重新登记、切项目/版本、dirty/blocked和卸载时清除本次材料状态，晚到GET/POST不能回填或解禁。
- 不在初次渲染时对全部单元自动并发探测/编码；用户选中的单元才读取，准备必须显式点击并带最近检查的materials_hash。所有props/响应hash校验保留，不显示未验证的“可生成”，不将本地准备描述为付费任务。
- 2026-09-07 SPEC S1已实际复现：父刷新将preview清空后卸载素材child，原POST仍pending，新child却可再次检查/POST。保留同一child跨父load/reset的生命周期，props失效仍清材料/阻断，但在途busy不能被重建清除；不改后端或增加跨浏览器全局锁。正式用真实父/子模板编译挂载覆盖此RED→GREEN，浏览器应在真实POST被挂起时刷新父计划，确认只发一次POST，旧回执不回填，显式GET能恢复；原探针/修前459根测试与浏览器通过证据原样保留，不能抵扣本缺陷修后验收。
- 先handler真实隔离fixture RED→GREEN，再页面状态/实际路由和浏览器前后端链：检查零POST、显式准备一次、本次资产可读、刷新只GET复用、旧hash/owner/额外字段拒绝、A→B→A和慢响应不回填。现有只允许自有loopback的窄guard不是该新HTTP整链现成许可；需核验新测试确实只用自建服务器/隔离DB/合成媒体后再使用。不得启动默认app/默认配置或以mock最终prepared DTO代替实际后端验收。

G4.0e 浏览器范围补充（2026-09-07，本地实施中）：根已读旧整文件E2E及其配置，确认存在默认5679端口、完整router及可选真实source分支，本包不运行旧整文件。批准当前唯一作者新增 `frontweb/e2e/redraw-unit-reference-materials.spec.js`，先报依赖/启动/清理清单后审核：实际derivationFixture与handler、明确合成owner/config/temp DB、同进程自建 `127.0.0.1:0` HTTP，仅挂真实父组件必需的计划审核/队列GET和本包素材GET/POST；Vite用 `configFile:false,envDir:false` 构建真实父/子组件小入口，不启动默认app/dev server/proxy，不读取真实.env。浏览器拒绝所有非自有origin请求。根负责独立staging Playwright配置（无webServer/baseURL、零重试、唯一证据目录）及冻结后独立运行。预置审核/队列明确属于合成fixture，不能冒充空项目全链或人工质量验收。此补充未执行浏览器、未扩大供应商/生产/Git权限。

G4.0e 错误分类最小补充（2026-09-07，根源码复核tool `514ad4`）：源快照 `prepareSnapshot` 的末尾catch将非业务异常统一包装为 `REDRAW_SOURCE_VIDEO_UNAVAILABLE`，丢失系统I/O原因，导致新handler不能满足“内部I/O脱敏500、过期/无效材料409”。追加同一作者责任 `redrawSourceVideoService.js` 及必要的原 `redrawSourceVideo.test.js`：先用新handler真实fixture在该源路径最底FS调用注入EACCES/EIO，记录409而非500的正式RED及零写；仅在包装点保留非枚举cause，不改旧业务code/message或公开DTO，新route只对明确操作性系统I/O分类500。缺文件/损坏/过期继续409，owner先404，未知error不回显path/stack/cause。无通用错误重构、无新供应商/数据库迁移/模型改变，原source HTTP合同须回归；额外功能锁若发现须先单独核对，不弱化原锁。此补充尚待实现/双审，不宣称所有源读取阶段的系统错误均已验。

G4.0e 功能锁落点已只读核对：上述路由/index/API三处现有文件精确影响 `stability.admin-provider-observability`、`stability.proactive-canary-and-public-evidence`、`redraw.coverage-registration-http-route`、`redraw.product-media-http-chain`、`redraw.episode-blueprint-first` 五项。下一唯一作者同时负责 manifest 的这五项本次本地授权历史追加及 `featureLockManifest.test.js` 的对应精确反向还原测试；不让根与作者同时写产品锁。授权依据仍是用户“2026-09-06 规划好剩余6项-工作 全量推进；2026-09-07 继续”，reason只能描述本包本地素材GET/显式prepare/API/UI，不能增加供应商、真实Key、Git/CI、部署或生产权限。保留每项原unlock于unlockHistory，保持其余字段/规则/历史不变；本阶段开始前完整JSON.stringify规范hash为 `086f8c09873419fe5a92cb2fdaa92f27ce57f9a93355e691f1d48ecdff4f120b`（root只读tool `7a4c94`），新增测试应从更新后逐项回退本轮记录并恢复这个整清单hash，再接原有历史回归，不弱化旧断言。G4.0d冻结/回归期间不修改这两份锁文件。

**G4.0f 已选能力的本地执行前复核（已本地收口，累计7d63756…；以下保留批准合同）：** 这是已审核计划到实际执行的必需连接，不新增模型、不重新测试模型可用性。本包只实现服务端精确选择复核及其本地证据；不新增HTTP/运行表/领取/报价/供应商调用。后继run仍须结合当前owner/计划/素材/价格与本结果，不能把本包`ready`解释为可以生成。

- 责任：新增 `backend-node/src/services/redrawSelectedCapabilityReadinessService.js` 和对应 `redrawSelectedCapabilityReadiness.test.js`；允许在 `redrawExecutionPlanPreviewService.js` 窄提取共用的单条能力计算并导出exact-selected元数据复核入口，及其原preview测试；必要时仅在 `ttsService.js` 提取原分支实际使用的纯连接解析，并用新独立合成测试证明旧分支不变。不得调用全量planningCapabilities、默认选择器、listConfigs或提交入口，也不复制第二套evidence/adapter算法。根按现有精确protectedPaths匹配核对这些六个候选源/测试路径均无命中（tool `910700`）；最终责任集合仍须复核，不能泛化为任意文件无锁。
- 输入来自服务端已保存的完整capability，不接收客户端Key、URL或替代配置；验证其canonical capability_hash。仅查询指定video行及replace时指定TTS行，复用原可读evidence与参数交集校验，必须恢复同一capability。缺失、deleted/inactive/paused、revision/provider/protocol/model/evidence/adapter/参数变化均blocked/stale，不因存在有效B而改选。实际协议用现有resolveVideoProtocol核对；仅default_model吻合而原configured model不能实际传递时明确阻断，不能让提交层偷偷换模型。WAN3仍保持当前未检查/阻断合同。
- replace音频只重建保存的TTS evidence，不接受新native证据或另一TTS替代；从同一证据恢复provider/model，最终执行pin必须使用这个model。`service_type=audio`若与现有tts执行合同不兼容则明确blocked，不改服务类型。无对白的not_required和已选择native不得遍历TTS。
- 元数据复核通过后才精确读取所需连接字段；按实际Fumin配置优先、ToAPIs环境优先、飞拓配置值和现有URL构造函数解析。禁止真实配置读取的本地回归使用明确合成Key和环境。TTS沿用实际分支：MiniMax使用config Key；OpenAI兼容允许无Authorization，不新增全局非空Key要求或环境兜底。若需纯解析导出，必须让原调用消费同一解析结果而非复制URL/分支规则；不得改变原模型默认值/voice/请求参数/网络行为。
- 返回显式分开的 `public_readiness` 与服务端 `private_binding`：前者只含schema、选定capability_hash、ready/blocked、安全reason codes、凭据存在性层级和`executable:false`；后者只保存精确config身份及有效连接/凭据的canonical指纹，禁止包含原Key/完整settings或公开URL。失败不发private成功绑定，不透出异常message/path。私有指纹不进入公开DTO；本包不新增secret存储/轮换系统，不声称凭据已实测。后续claim前必须重算指纹、以同一有效配置执行，并另验在途漂移；本包单次检查不证明检查和POST原子。
- 正式TDD：原preview的DTO/hash/顺序/SQL零凭据和WAN3断言不变；内存真实SQLite中A失效且B有效，逐项覆盖video/TTS漂移和非法输入，断言零全量选择、零DML、零调用；ToAPIs实际优先环境值变化使private指纹变化，Fumin已有配置Key时无关环境变化不改变它；有效URL/endpoint变化必须改变绑定，公开对象不含合成secret/地址/settings/私有指纹。TTS空凭据OpenAI兼容不被错误拒绝、未知provider且无base_url被拒绝、audio载体不偷换。用合成artifact reader的测试只证明合同，不冒称可播放证据/真实生成。
- 唯一作者完成并冻结后按SPEC→QUALITY→根回归→累计回读关闭，再直接进入上文run/attempt、只读报价与实际执行连接。此次仍不读真实Key/default DB、不联网/付费/生产/Git写入，不修改线上模型。

G4运行免费报价只读补记（2026-09-07；未实现/测试）：`calculateCharge`显式free返回0，而旧shot报价和实际用户/租户reservation及bonus allocation均要求正金额，不能把0传给旧reserve后伪造成功。该事实不等于必须扩大为全站账本迁移。后继run优先核对更小的显式no-charge分支：仅在当前真实free价格与quote绑定一致时保存在同一attempt，不创建或宣称held/confirmed reservation，缺价仍阻断；unknown仍禁止重新提交，正金额继续由原真实预留/结算负责。具体持久化与事务反例在run包实施前定稿，不由本只读发现擅自放宽账本的amount>0约束。源码锚点为modelPriceService:812、creditLedgerService:300/412/440/487、dailyRechargeBonusService:77与redrawBillingService:162/211；没有读取真实价格或账态。

G4 运行输出参数缺口补记（2026-09-07，根只读源码核对，尚未实现）：当前 plan.capability 只含 resolutions/aspect_ratios 范围，unit 只固定源范围、生成时长及尾部余量；页面也只显示能力范围，没有已确认的具体分辨率/画幅（root tools `e76d4b`、`c8da69`）。因此后继报价/提交不能默取数组第一项，也不能沿用历史480p/9:16样片常量冒充用户选择。执行包应在开始确认页明确选择当前能力允许的具体输出参数，将同一规范参数绑定只读报价与首次claim/run，开始前缺参数保持blocked；首次claim后漂移不得换档继续。对应GET/advance字段与run保存位置在接入包实施前固定，保持无Key/model/baseUrl注入、零自动开始原则。此补记不修改本G4.0f六源或原preview DTO，不产生供应商/付费权限。

**G4.0g 逐单元只读报价最小包（2026-09-07，实施合同）：** 仅新增 `redrawExecutionQuoteService.js` 与 `redrawExecutionQuote.test.js`，不改价格、积分账本、运行表、HTTP或页面。本服务不是生成授权；来源必须是调用方刚复核的服务端saved_review.plan，之后的运行接入仍须核对owner/当前review/素材/selected readiness。

- 唯一入口 `quoteExecutionUnits(ctx, { plan, output_parameters: { resolution, aspect_ratio } })`；ctx必须显式DB。先核对规范plan/capability hash及其绑定、ready计划、非空且ID唯一的顺序units、每unit正安全整数毫秒且为能力支持的整数秒，再定价。具体输出参数必须显式给出且属于能力范围；不取数组首项、不取历史样片默认值，不接受额外unit/model/Key/URL覆盖。
- 在同一只读deferred SQLite事务快照中，复用已导出`canonicalModel`后按同样`COLLATE NOCASE`精确SELECT当前模型的`category, pricing_mode`，并对每个实际unit调用原`calculateCharge`，传真实生成秒数、能力允许秒数和具体resolution。不调用ensureSchema/requirePrice/list，不写表、不访问默认配置。只读BEGIN/SAVEPOINT不是业务写入；两连接WAL回归验证报价过程中价格变化不会混入同一份报价，下次报价可见新值。
- 只接受video类别和明确free/paid模式。原计算器的missing/disabled/resolution-tier拒绝仍保留安全code；free允许每项真实0，paid必须每项正安全整数，总和也必须安全整数。先检查时长再进入原free提前返回分支；不把错误、未知模式、损坏paid0或溢出变成免费。合法free报价不创建reservation，也不伪造held/confirmed。
- 成功DTO为`{schema_version:'redraw-execution-unit-quote-v1',status:'quoted',executable:false,reason_codes:[],plan_hash,capability_hash,output_parameters,pricing_mode,count,units:[{unit_id,ordinal,unit_hash,generated_duration_ms,amount}],amount,quote_hash}`。quote_hash绑定上述除自身外的完整规范成功DTO；unit_hash绑定原unit全部内容，明细保持原plan顺序。旧HTTP草案的单一unit_amount不适用于长短单元不同价，后继连接改用units明细，不虚构均价。
- 拒绝仅输出同schema/status:'blocked'/executable:false/reason_codes；无amount/quote_hash。新增安全码统一以`EXECUTION_QUOTE_`为前缀；原价格安全白名单为MODEL_PRICE_NOT_CONFIGURED/MODEL_DISABLED/MODEL_RESOLUTION_PRICE_REQUIRED，其他价格异常统一PRICE_CHECK_FAILED，不泄露原message、路径或配置。
- 正式TDD使用真实隔离SQLite与实际calculateCharge：变长单元/分辨率档/free与缺价/禁用/非法参数与时长/重复ID/单元顺序及内容/价格漂移/整数溢出/零DB业务写。固定Node、清空环境、唯一OS临时目录、已核验no-network preload，保留RED/GREEN/native退出与源hash；启动器先由根完整审计。作者冻结后独立SPEC、再QUALITY、根回归收口，仅勾选本报价包。

G4.0g本地退出（2026-09-07）：作者正式行为RED为4pass/30fail（非import失败），新34/34、相邻366/366；根独立366/366与功能锁42/42均native0、0skip/cancel、145运行源/启动器引用前后一致。SPEC `227b2e0d6d949e0d00af64abc411c26e8a7cdefae459d6718fd6b5029d39d93e`、QUALITY `066a7f11d9eed44c7ef919bb7db3033dad7d43524b0b137fd6f62354d9e8ac1a`均无发现，审查者各testsExecuted=0，实际核对原生证据、不冒称新重跑。累计 `.codex-staging/g4-unit-quote-verification-20260907-r1.json` SHA `282119b0c77aafe773ceb6693a566f93570190e982b2b27f07792379aec2eafc`；根独立回读378引用0漂移（tool `9fc76e`），仅本包closed，fullDeliveryComplete=false。模型价格服务及父140源未改；真实两连接WAL当次总77、下次free0，报价零DML。未做run/claim/HTTP/UI/供应商/付费/生产/Git写入。原G4.0f的2个退休端口排除仍是历史未覆盖，不被本次报价回归冲销。

G4 后继运行存储只读预检（2026-09-07，root `e4936c`/`70e69e`/`6d7868`，未执行迁移）：当前最大迁移号仍76，`runMigrations(database)`按文件名排序自动发现SQL，无需改迁移注册器；实施时再次确认号位。75的queue/units只能waiting_readiness/pending且有不可变触发器，不应把run状态写回旧表。`getExecutionQueue`在显式ctx.db只读事务内经owner version/work、实时preview、精确保存review和units内容/hash校验；调用方可在同一immediate事务中嵌套它，不能先事务外读取再插run。它只返回当前选中队列，不支持不经校验直接指定历史queue执行。初始run只登记、零claim/任务/预留；具体参数首次claim冻结与免费no-charge证据字段须随新迁移明确落位，不能把quote服务的quoted状态当已有执行记录。迁移模块CLI会读取默认配置，后续测试只使用显式隔离数据库和已审核入口，不裸跑迁移CLI。

G4 claim接入的最后await边界（2026-09-07，root `ad4b40`/`44b4e9`，仅定位）：现有prepared inspector在私有reader的finish内做最后同步当前输入/权威行/输出字节复核，随后只返回公开DTO；返回值本身不是可长期复用的执行凭据。run领取不能在await这个DTO后只信hash插attempt。后继接入须复用这一已存在的finish/assertCurrent边界，在取得immediate事务后重新核对来源、派生输出、selected连接、报价与run CAS，再原子领取；不得拷贝第二套材料验证器或把事务跨越probe/cleanup的await。必要的私有同步消费入口应保持既有GET DTO/零业务写语义不变，由实际claim独立承担写入。此处只是后续源码连接要求，没有执行新领取或改现有reader。

**G4.1 运行/尝试持久化首包（接续G4.0g，本地实施）：** 在上文已批准的run/attempt设计内，下一唯一作者先完成迁移与owner/CAS存储入口，再接后继实际claim，不把只建表称为已可生成。责任为当前最大号+1的`redraw_execution_runs.sql`、新`redrawExecutionRunService.js`和`redrawExecutionRun.test.js`；若历史run读取必须复用queue私有校验器，由作者先给出最小提取方案，经根确认才增加旧queue service/test责任。旧74/75/76和父素材、报价、价格服务原样保留，不运行迁移CLI或写默认数据库。

- 最小入口：`createExecutionRun(ctx, versionId, {expected_plan_hash,expected_queue_id})`、`getExecutionRun(ctx,versionId,runId)`、`requestExecutionRunPause(ctx,versionId,runId,{expected_revision})`。显式owner/db，严格字段，公开输出无claim_token/配置/本地路径，`executable:false`。不新增HTTP/UI、供应商/账本调用，不创建真实attempt/task/reservation；attempt表在此包仅验证持久化约束，实际领取在后继包连接。
- 创建在同一immediate事务重验owner/current review/queue及精确ID/hash，已存在的同owner同queue返回同run，不绕过失效/损坏证据。读取保持零DML，能恢复本owner的旧run及其历史状态；当前计划漂移与既存状态明确区分，不在GET内回写stale、创建新run或宣称可继续。不得复制第二套完整queue/saved-plan验证器。
- 暂停按精确revision CAS，返回新revision；重复旧CAS零写并拒绝。未有在途attempt时可停到paused，有在途记录时只置pause_requested而不杀任务/改变其提交事实；终态、unknown和上游漂移不能被暂停操作洗成可重试ready。无resume/重领/重试或结算逻辑。
- 正式反例覆盖migration重入与约束、跨owner/版本/queue关联、同queue双连接并发创建、事务后续失败全回滚、历史run只读恢复、损坏/漂移拒绝、pause CAS与活动/未知记录保留。真实隔离SQLite与新进程/连接重开，不用最终成功DTO mock替代存储行为；默认配置/Key/供应商/账本必须零触达。新作者先报告确切字段/状态/历史queue复用方式和完整隔离启动器，由根一次性固定后TDD；不再要求用户重复批准同一本地范围。

G4.1历史队列复用补充（根已核对批准，尚未编码）：允许同一作者小范围修改现有`redrawExecutionQueueService.js`及其原测试，新增内部`getExecutionQueueSnapshot(ctx,versionId,queueId)`。只读事务内先owner version，再当前review，按exact queue ID+owner/version选旧队列并复用原publicQueue完整校验器；缺失/跨owner/跨version统一EXECUTION_QUEUE_NOT_FOUND。原get/prepare方法和DTO不变，不接新HTTP。run GET据此返回真实存储status以及独立binding_status current/stale，损坏数据明确EXECUTION_RUN_INVALID，不在GET改表或把unknown变成ready。改动前保留旧queue service/test完整字节基线及SHA到本次唯一审计工件，不能只用父hash替代可读差异。

G4.1字段及执行入口定稿（2026-09-07，根核准作者完整方案）：当前迁移最大号76，新增77前再次核对。run包含owner/work/version/queue/review/plan绑定、原八状态、pause_requested、非负安全整数revision及时间；同owner同queue唯一。output_parameters_json/hash成对NULL或严格`{resolution,aspect_ratio}`与canonical SHA绑定，登记时NULL、ready/revision0且始终公开`executable:false`和`EXECUTION_RUN_STORAGE_ONLY`。attempt保留原八状态与run/queue_unit/unit_hash/claim/readiness/request/task/reservation/output/QA关联，增加quote_hash、quoted_amount和paid/no_charge；本功能无重试，attempt_no固定1，单run至多一个claimed/submitting/running。no_charge必须amount0/reservation NULL；paid必须正安全整数，领取尚未reserve时reservation可NULL。不复制整份逐单元quote至每条attempt，也不修改旧账本；本包不创建实际attempt/任务/冻结记录。

G4.1读写与审计约束补充：公开units仅含ID/ordinal/unit_hash/status及attempt ID/序号/状态/时间，不暴露claim_token/provider/private质量或路径；run/attempt/queue关联及非空参数hash损坏均明确拒绝。GET零DML并单独给出真实status与binding_status。create在immediate事务内校验当前证据、精确CAS、复用或插入，并在返回DTO前再次完整验证，后续失败整体回滚。pause保持原终态/待审/未知/漂移语义；revision已达MAX_SAFE_INTEGER时拒绝且零写，旧CAS零写。正式测试包含两个受同一无网络/默认配置拒绝preload保护的新进程与新DB连接并发、持久化stdout/stderr和真实退出码；子进程完整代码须在首次RED前静态审查，不运行未审查launcher。根已复核launcher SHA `34f3b9eb273d442ac04e20e9853cf684a0b583213e567d6aba4eb657aeea1fcd`及旧queue双文件完整基线；批准开始本地TDD，不新增用户授权关卡。

G4.1末检精确化（根读码后，仍在作者责任内）：create的末次历史run完整校验之外，还必须确认返回binding_status仍current；合法历史stale可由GET读取，不等于create当前CAS仍有效。正式SQLite反例在INSERT之后改变本事务内的当前上游绑定，create须CONFLICT并回滚run和触发写；不得靠仅测坏run字段代替。owner两字段沿作者已批准提案要求非空非空白TEXT。历史snapshot允许在owner version通过后先按exact queue ID+owner/version查找，缺失立即404，再读current review并复用原完整validator；这是同一只读事务内的更早权限拒绝，不改变历史DTO或新增访问范围。

G4.1测试入口可移植性修复（2026-09-07，独立QUALITY发现，原作者继续）：正式run测试不得依赖`.codex-staging`审计文件、固定Windows可执行路径或固定Windows环境。允许新增一个仓库内test/helpers隔离preload，以`process.execPath`和跨平台最小环境启动真实并发子进程；保留默认配置/默认DB/网络拒绝、独占临时目录、真实SQLITE_BUSY、退出码与日志证据，禁止靠skip规避。本地根launcher仍保持原固定Node与审计guard。先加入正式反例并证明旧入口失败，再完成最小修复、联合回归和独立复审；不更改迁移、run业务、queue或旧父源，不将本机通过冒称Linux/Hosted CI实跑。

G4.2领取连接入场准备（只读定位，须G4.1最终双审关闭后实施）：优先在既有run模块复用ownedVersion/ownedRun/readRun；当前saved plan取getExecutionQueue的saved_review.plan，实际数字queue_unit_id来自匹配的权威队列表，不能把逻辑unit ID强转。当前selected能力使用inspectSelectedCapabilityReadiness，报价仍调用quoteExecutionUnits；都在prepared同步finish取得immediate后重新读取。仅对既有prepared inspector的最终同步检查段做私有readCurrent提取，旧GET DTO/零写语义不变；禁止跨await持事务、复制材料验证器或把过期句柄交给claim。

首次参数与确认摘要补齐：readiness输入显式output_parameters `{resolution,aspect_ratio}`，advance在原三项expected字段外允许这一严格双字段对象；首次领取必填，已有冻结值可省略或传完全相同值，不能默选能力数组首项。参数/hash与首attempt、claim_token、revision CAS同事务冻结，任一失败全回滚。原逐单元quote DTO及quote_hash不改；run readiness另外生成绑定run/revision/plan、当前选中unit、当前素材与prepared hash、selected private binding摘要、具体参数及原quote_hash的确认摘要，通过run级quote_hash返回并由advance.expected_quote_hash比较。它不是费用预留或执行授权，私有连接指纹/claim_token不出公开DTO。前序放行读取真实attempt，不以queue pending或父shot审批代替；实际候选/质量批准验证仍在后继审核包，不允许凭手填approved状态自动扩展到供应商执行。接口、重复确认返回同attempt与陈旧CAS拒绝的精确分支由下一唯一作者先给出最小TDD方案，根核对后实施；此段不是已完成claim或HTTP接入。

G4.1最终局部退出（2026-09-07）：r2已关闭正式测试对本机staging/Windows路径的P1；作者98/98及420/420、根独立420/420与42/42均native0，原3项RED及Windows PATH中间失败完整保留。SPEC r2 receipt SHA `1525cdf771e04bbc0f690168cc2d4c04af6c4e4923bbdc66991ae763fe04cdba`，QUALITY r2 receipt SHA `9cbcfc60a3e589a3c3102875a9e6cc6873801db6cba5dff006498ff7c7a85848`，均0发现/0审查者执行。累计`.codex-staging/g4-run-storage-verification-20260907-r2.json`已生成并独立回读684引用0漂移；六责任源及141父源冻结。只关闭create/get/pause存储，不声称claim、任务/预留、HTTP/UI、Linux/Hosted CI或整体交付；旧ttsService全树diff-check非绿事实保留。此后才交全新G4.2作者。

G4.2重复确认定稿：run级确认hash使用明确schema、owner/work/version/run/queue/review、逻辑及数字unit/plan绑定、expected_revision、output_parameters_hash和readiness_hash；readiness_hash本身含原逐单元quote_hash、实际材料/选中连接/前序审批绑定。新attempt.quote_hash保存这一run级确认摘要，不改变旧quoteExecutionUnits输出。精确重放时以owner/run下原attempt的存储readiness_hash与请求revision重算确认摘要，匹配才只回显同attempt `{attempt_id,status,newly_claimed:false}`，零DML/预留/恢复/执行；禁止推算run.revision-1，任意其他旧CAS不能因已有attempt就放行。新领取则要求实际当前revision及全部当前门禁，返回内部newly_claimed:true也不代表供应商已执行。paused/failed/unknown/stale旧事实只可回显，不能借重放重新领取。原GET的executable:false和描述性blockers保持只读原义，新领取独立检查真实证据而非清空旧blockers。本包不接账本/任务/供应商/HTTP/UI，实际审核与恢复后继接入并另做端到端验证。

G4.2同步消费与报价封装定稿：prepared共同私有readCurrent只在全部媒体/清理await结束后使用，不输出reader或文件句柄。只读readiness使用可支持readonly连接/query_only的只读事务，claim才使用immediate写事务；同一最终检查器在同步consumer前后各核验一次，async consumer预拒、thenable在事务内拒绝并回滚。不得让就绪GET强制取得写锁或复制验证器。原`redraw-execution-unit-quote-v1`对象作为`unit_quote`嵌入且其quote_hash原样保留；运行确认使用独立schema的顶层quote_hash，不能在旧schema下替换hash语义。精确扩责仅允许旧run.test的导出名单断言增加两接口，以及新增源码目录claim child helper；formal preload和旧其余测试不改。下一步先静态核准新增测试/child/隔离launcher再执行RED。

G4.2恢复兼容修正（2026-09-07，根与独立架构审查确认，覆盖前文readiness内重复绑定revision的早期描述）：`readiness_hash`只绑定可重新核验的当前语义，包含run/plan/unit、素材、selected、参数、原逐单元报价与前序审核，不包含run.revision。公开DTO仍返回revision，独立运行确认`quote_hash`仍严格包含expected_revision，旧CAS不得提交。原因是claim与pause会递增revision，而attempt没有原claim_revision；把它混入语义hash会阻断重启后的当前材料比较。此最小修正不新增存储/快照，不解除暂停/未知门禁，不改变精确重复确认。正式反例要求仅revision变化时semantic hash不变、confirmation变化、旧确认0写拒绝；后继实际提交与恢复仍未实现。

G4.3只读落点补充（2026-09-07，未实施）：直接`refundExpiredGenerationReservation`与provider的expired/legacy扫描都需识别新unit资源；`failOrphanedAsyncTasksOnStartup`先执行超时对账再过滤任务，所以只增加task白名单不足。正式反例优先复用迁移完整的`providerReconciliation.test.js`与`taskService.test.js`，不让旧route保护掩盖新资源问题。video无provider ID且无旧unknown前缀时会被恢复逻辑标failed；已知ID恢复仅轮询，不能把它说成直接重复POST。`videoGenerationRequestSnapshot.test.js`应新增processing+无ID+无旧前缀的准确反例，检查同attempt/task状态及零POST。新unit仍由attempt审核结算负责，不通过设置video.credit_reservation_id触发底层提前确认；旧普通30分钟退款与旧shot语义保留。

**G4.3 同attempt任务/积分绑定实施合同（G4.2双审退出后）：** 在既有run service内新增server-only `bindClaimedExecutionUnitTask(ctx,versionId,runId,{attempt_id,expected_revision,expected_plan_hash,expected_quote_hash})`。沿用新接口的严格ID/字段合同，不接HTTP/UI，不新增video/provider route/外部请求。当前不接受或写入`request_hash`：该字段留给后继实际供应商请求及提交标记，不能用尚未构造的请求或本地意图替代。保持一个attempt对应一个task、一份paid预留或明确free/no_charge；不能冒充旧shot。

- 复用同文件私有owner/run读取与ready计算；对精确目标claimed attempt做只读计算视图（从待评估attempt列表排除自身，不更改存储），复用现有完整前序/首pending规则并确认返回unit正是目标。其他active/waiting/failed/unknown、pause/stale或任何submit marker/provider ID都不允许新绑定。实际材料检查仍经prepared同步consumer，最后immediate事务重算semantic readiness，必须等于领取时存储值，当前逐单元金额/paid-free模式也须与attempt相同。不得绕过当前selected或复制完整材料验证器。
- 同一immediate事务中，paid复用真实`creditLedger.reserve`，资源及task类型均为`redraw_execution_unit`，资源ID为attempt ID，operation key固定由此派生，模型来自审核计划而非客户端。核对返回预留的owner、resource、model、amount与held状态，不能因底层重复请求只校验资源而忽略金额。free0完全不调用账本或创建假reservation。复用`taskService.createTask`并在同事务补全owner/model/metadata/paid reservation关联，然后CAS绑定attempt与递增run revision；失败回滚全部任务、账户、预留、流水和attempt/run变化。
- task metadata仅保存本地必要绑定和`binding_revision`（本次操作的原expected_revision），不存Key、URL或伪request snapshot。精确重复调用按原绑定revision、plan/quote/attempt及真实task/reservation关联核对后，只回显同一task与实际账态，`newly_bound:false/executable:false`，零媒体、DML、预留、恢复或提交；它不是继续生成许可。新绑定返回`newly_bound:true/executable:false`及当前revision/attempt/task/计费摘要，不公开claim_token/private binding或reservation内部详情。跨进程等待者在锁内再次识别已绑定结果，不能重建task或二次冻结。
- 同包窄改`billingReconciliationService`的直接超时退款与`providerReconciliationService`的legacy自动结算，明确排除`redraw_execution_unit`资源，由后继attempt审核/终态负责结算；保持旧普通生成30分钟合同。`taskService`的generic orphan不得自动失败或结算新unit task，准确识别新类型并保留其不确定事实，不能借此自动恢复或生成。对损坏绑定只可保留待审，不允许以通用清理修复账态。此包不创建video；video恢复与app启动顺序保护仍是后继实际adapter包的必做项，不因本包通过而删去。
- 正式TDD：实际迁移SQLite/账本（合成账户）、真实prepared fixture，paid/free/余额不足/价格或材料漂移、错误金额旧预留、owner/CAS/pause/marker、同attempt重复及两个连接/进程竞争、任务插入后或CAS后触发失败全回滚；31分钟后直接timeout/provider扫描和startup orphan均不改变新unit held/账态，普通旧生成仍如旧。孤立新unit反例不能依赖旧route保护。先核对launcher与测试源码，再RED→GREEN；不要运行默认app或裸npm test。责任为run service/new binding test、task/billingReconciliation/providerReconciliation与必要原测试；只允许旧run导出断言新增本接口，原claim/旧shot/ledger语义不改。完整回执→SPEC→QUALITY→根复核后才接提交标记/adapter。

G4.3已有绑定的错误合同精确化（2026-09-07，根在首轮GREEN后明确补充，不追溯为作者遗漏）：先按存储的有效`binding_revision`核验metadata及owned run/attempt/task/reservation真实关联；存储损坏返回`EXECUTION_RUN_INVALID`，零修复、零写入。存储完整后才比较调用方expected revision/plan/quote，非精确确认返回`EXECUTION_RUN_CONFLICT`。首次绑定遇到旧operation key不匹配仍可沿用既有冲突/账本幂等错误；不改账本、HTTP或外部边界。以独立定向RED先固定精确错误码，再做最小实现与最终回归。

G4.3测试责任补充：批准新增源码内`backend-node/test/helpers/redrawExecutionTaskBindingChild.cjs`，复用不修改原`redrawExecutionChildPreload.cjs`，以`process.execPath`与跨平台最小环境运行真实双进程；先由根静态读取完整测试/child/launcher，再执行。七份旧责任文件已保存全字节baseline。G4.2父149源只有run service/run.test两项属于本包责任，其余147仍保护；其余五份旧责任源须按本次baseline另纳入前后哈希，不冒称父清单此前已覆盖。

G4.3执行入口已核准（2026-09-07）：根完整读取binding test/child、新task/provider反例与新launcher，四产品源仍等于baseline。launcher SHA `e42ea4f0fdd2934d7a6611b9b7a63667a8d9d6a8ade9d2d3afa0a90e13b384eb`，新test SHA `1433e58359e9f2f6c31847cf28c67df628b7fbe8ae2179fcc2049d9287e7e08c`，child SHA `e539ef56167b7a08dd4d500579a28be3a070bc839b3953afc9c141351cc0cc2e`；允许唯一作者先执行red-binding与red-guards，完整终态后按明确失败再实现。真实fixture无membership/bucket，旧legacy helper显式固定reservation创建时间，避免当前日期掩盖31分钟反例；不是修改生产充值/奖励策略。

G4.3功能锁登记补充（2026-09-07）：根功能锁回归42项中41通过，真实`--base HEAD`差异审计以`FEATURE_LOCKED`指出本包task/billingReconciliation/providerReconciliation三源触及`stability.unknown-state-billing-reconciliation`，旧unlock仍为9月4日本地main合入记录。沿用户“规划好剩余6项-工作 全量推进；继续”的本地开发范围，由根只追加这一项本次原子绑定/超时保护记录并将旧unlock完整加入history，保留status/protectedPaths/requiredTests/evidence及其余全部内容；不修改验证器或生产/shared门禁。原生业务回归结束后才改manifest与对应feature test，避免冻结源漂移；新测试反向移除本次记录后必须精确恢复原整份清单canonical SHA。此记录不是新的付费/生产/Git授权。

G4下一连接的只读调查结论（未实施，必须在G4.3双审退出后）：实际`videoClient.callVideoApi`含候选切换与route写入，`callVideoApiForConfigId`亦可能默认模型回退，不能冒充精确已选执行入口。优先复用现有ToAPIs/Fumin/飞拓低层protocol client及已导出的body builder，不改模型目录或其请求参数合同；它们已有可注入fetch、无DB写入和自动poll，但Fumin的参考resolver及上层转存仍可能上传，须与生成提交分开处理。prepared单元只给可信资产ID/SHA，不是现成公网引用，故后继必须完成真实unit pack→owned素材引用/对白prompt→精确客户端投影，不能仅接fake adapter就宣称产品可执行。实际提交的body hash与提交时间必须先持久化成功，再准许唯一POST；已知任务ID只查询，已开始但结果不明禁止重发/自动退款。重复确认本身不应把仍活跃的原调用改成失败；重启/超时后的未知收口另按权威事实处理。本轮没有执行这些网络动作，下一包仍以本地隔离transport替身检验真实客户端路径。

**G4.4a 精确已选客户端的单次请求/查询连接（接续 G4.3，2026-09-07）：** 先消除实际 protocol client 会丢失 ID/原状态、完成无 URL 被归成失败的连接问题，再接 owned 素材与 run 原子提交；不改旧客户端、模型目录、路由器或线上配置。新建 `backend-node/src/services/redrawUnitVideoClient.js` 与 `backend-node/test/redrawUnitVideoClient.test.js`，只提供服务端单次 submit/query 端口。此包不是 HTTP 产品入口，不自行读 DB/配置/Key，不上传、不下载、不轮询循环、不重试、不结算。调用者只能传已精确复核的服务端连接快照、既有协议 opts 与提交前同步回调；这些参数不开放给浏览器。

- 复用现有 Fumin/ToAPIs/飞拓低层 body builder 和 submit client；固定 protocol、有效 Key、URL、model/参数及已解析参考 URL，不调用全局 `callVideoApi`、默认选择器或 resolver 上传回调。ToAPIs 显式 apiKey，Fumin 显式非空 config Key，飞拓沿 config Key；不读环境、不改任何模型名/域名/默认值。body builder 不通过保持零 transport，额外未知控制字段拒绝，不通过自由 opts 偷塞 fetch/resolver 等执行回调。
- 实际客户端 fetch 边界核对最终 method/URL/精确 JSON 字节等于预构建请求，按 UTF-8 实际 body 字节计算 request_hash。必须同步、成功调用 `beforeSubmit({request_hash})` 后才发唯一 POST；回调缺失、拒绝、抛错、返回 Promise/thenable、abort 或请求漂移均零 POST。该回调未来承担 G4.3 attempt/任务/素材/selected/报价/CAS 的原子提交标记，本包测试不伪装已做 DB 原子绑定。每次调用最多一次 transport，禁止重定向和自动重试；正常返回不暴露 Key、body、原始错误或原始 payload。
- 单次 transport 完整、有界读取 HTTP 状态/JSON，保留原始任务 ID/状态/错误冲突，再复用现有 status parser 提取 URL 和 `normalizeVideoProviderResult`。不能机械使用旧 parser 的 state。accepted/running 必须有真实 ID；飞拓只用 jobId/job_id；ToAPIs client_business_id 不是 provider ID。完成无 URL→result_unavailable；完成有可用 URL→completed_candidate，绝不 approved。未知状态、矛盾 ID/状态/错误/结果、解析/读取/网络超时、408/5xx 均 submission_unknown。非 2xx 只有结构化明确拒绝且没有 ID/结果/矛盾成功事实才可 failed_terminal，不按自由 message 文案推断拒绝。
- query 只接受明确已知 provider ID、同一连接，执行一次 GET；缺 ID 零请求，不走 submit 或 beforeSubmit。所有查询 HTTP/读取/网络异常保持 known ID 和未知，不转明确任务失败；返回 ID 与所查 ID 冲突也未知并保留所查 ID。没有 ID 的明确任务终态可使用所查 ID，不能将查询失败退款。复用现有 query URL builder，不取默认配置。结果仍是内部候选观察，不验证 MP4/声音/语言，不生成资产或改账态。
- 本地正式 TDD 只替换最底 fetch，真正运行三低层客户端/实际 body builder/解析器；覆盖精确 Key 优先级、参考和参数不漂移、回调先于 POST、拒绝/异常/thenable 零 POST、重定向关闭、连接/读取错误、超大/无效响应、accepted/完成/失败/矛盾、query 零 POST与 ID 保留。使用唯一 OS-temp、清空环境、现有禁止网络/默认配置/DB preload，责任文件及全部旧协议客户端前后 hashes 不变；根先读 launcher/测试后执行 RED，再实现 GREEN。作者冻结→独立 SPEC→独立 QUALITY→根定向/相邻回归后只关闭此端口包。

G4.4a 兼容补充：三旧 submit client 已把仅含有效任务 ID、缺 status 的无冲突响应视为已受理；新端口保留该正常合同为 accepted，不把“字段未提供”混同于显式陌生/unknown 状态。query 仅有 ID 不足以证明完成。Fumin/飞拓旧 submit 明确支持 direct URL 分支；缺状态但合法 URL 且无错误/失败/ID 冲突时仅保留为 completed_candidate，ToAPIs submit 仍沿原合同要求真实 ID。query 的同类直接结果也仅作候选；这些兼容来自现有解析合同，不是本轮供应商实测。自由 message（如任务创建成功说明）不是结构化 error；不能仅因非空 message 就一律阻断，仍须核对实际错误字段/状态/结果冲突。

后续 G4.4b 仍须一次贯通真实 production pack/完整目标对白/名字/可信素材发布到该端口，在最终 POST 前保存实际 request_hash/submit_started_at，并持久化返回 ID/未知状态，再接单次恢复查询和 QA。不能把 G4.4a 的合成 transport 测试称为素材已发布、实际可生成、真实视频验收或整功能已交付。本轮全部仍本地、零供应商/付费/生产/Git 写入。

2026-09-07 G4.4b入场执行状态：父G4.4a累计SHA `9567706e6ae85734f0f545370f65a0d32c5e101ad467c2e7f29bc6a41dc4c935`已由根独立回读214引用0漂移。最小真实主链RED在审核pack/素材/claim/bind之后仅因dispatch入口缺失而失败，native1；未把接口缺失扩成虚假多项覆盖。根核准6个既有产品责任：Run、Derivation、MaterialsInternal、SelectedReadiness、SourceConditioning、provider-assets handler；另1个既有test fixture仅加审核前hook，避免复制旧夹具。6产品路径均不在当前feature-lock的精确protectedPaths，暂不新增无必要unlock；如需额外旧服务先回根审查。唯一作者现做最小GREEN，测试静止时才写源；后续同包按assets/recovery/协议/账态/并发的窄矩阵TDD，再根回归与独立SPEC→QUALITY，不提前勾选G4。

G4.4b 素材只读定位（尚未实现）：现成 route factory 仅按 asset ID 可读后签名，strict static HMAC 只覆盖路径/expiry，不覆盖实际 bytes；不能替代当前 owner/prepared SHA。`redrawSourceConditioningService` 的 provider-assets 已有内容寻址 MP4、签名/到期及服务端读时 SHA 检查，但限定 `redraw-conditioning/<sha>.mp4`，身份图尚无同样端口。下一包优先小范围复用/扩展该内容绑定发布合同而非新增图床、private-avatar 登记、tunnel 或默认上传器。Fumin 可对当前 prepared consumer 内取得的受限字节快照，事务退出后显式复用 bytes 上传；其他协议须有真实可读的内容绑定 URL，不以 mock publisher 宣称产品已可生成。所有异步发布/上传后仍重入 prepared 同步 consumer，在 marker 事务中复核同一源/素材/配置/价格/CAS；不得跨 await 持 SQLite 事务或让失效 FD 外泄。selected capability 已含 locale/market/audio_mode，完整 unit pack 提供目标对白/名字/单元相对时间，后继 prompt 应使用这些已审核值而非旧 shot prompt 或原始中文对白。

G4.4b 最终 dispatch 边界定位（只读，尚未实施）：复用 derivation service 私有 `readCurrent`（当前201–218行），不复制材料算法或放宽原 synchronous consumer。另加窄 submission scope：所有 probe/cleanup await 完成后，只向 dispatcher 交 DTO 与一次性同步 `consumeCurrent(fn)`；其内部固定 immediate 的 `readCurrent→fn→readCurrent`，beforeSubmit 在此写 marker，事务成功后返回true，紧接真实fetch。不能提供过期 source/candidate FD、裸文件路径或无约束裸 readCurrent；scope 结束撤销门即可，不在POST后重做材料后验而吞掉外部任务ID。provider observation 的持久化以已提交 owner/run/attempt/task/claim/request_hash 为权威，不再要求计划/材料/报价或run revision未变；暂停/计划漂移阻止后继推进，但不得导致已返回ID丢失、标记被清空或自动退款重发。写收据失败也须保留含ID/hash的可恢复事实，而不是普通无ID的“提交失败”。

G4.4b 回归复用约束：主链以 `helpers/redrawUnitReferenceFixture.js` 的默认 unit 0 构造真实隔离 SQLite、身份 PNG、动作 MP4 与审核计划，再复用 task-binding setup 的配置/报价/claim/bind 调用。默认unit 0实际对白为空，必须在蓝图/本地化审核前构造真实多句目标对白及名字证据，再走原有审核链，不能直接篡改已审核计划。不能 `require` 整个旧测试文件，也不能沿 derivation fixture 默认清空角色/对白后声称身份与完整对白已贯通。provider asset handler 必须显式 `cfg:{}`、storageRoot/baseUrl、合成签名与固定时钟；已有 handler 测试只捕获字符串假 MP4 的路径，下一包要读实际发送工件并校验 SHA，图片入口须真实实现。测试以 dispatch、provider-assets、recovery 三个窄文件集中覆盖正常主链、owner/CAS/素材/价格漂移、marker 防重及查询恢复，复用旧能力而不复制整套历史回归；真实能力/审核状态夹具不得冒称供应商或人工验收。

2026-09-07 G4.4b执行更新：上述为历史入场约束，当前已有主链1/1和素材合同12/12的局部GREEN，root已核对原始日志/哈希；后继修改仍须新回归，不能据此关闭G4.4b。结果下载窄复用`providerCanaryArtifactService.materializeVideo`到独占私有临时根，仅在其下使用既有内部目录；不访问实际系统canary根或DB。沿用512MiB有界流、全部DNS地址检查/连接固定/每跳安全资源重定向，结果经真实probe与SHA后才登记owner-scoped待审核工件；不把WebM改扩展名冒充MP4。提交/任务查询仍单次且无重定向，下载失败保留ID与held、不自动重试。底层fetch及DNS替身只在服务端隔离测试注入，必须先静态审查新增入口；不复制第二套网络层、不新增依赖、不扩大6产品责任范围。收据事务失败的保底持久化须先核对既有任务消费者，不以普通result冒充QA通过。旧handler测试仅调整为断言真实发送字节并显式cfg:{}，保留原状态码/HMAC/缓存/MIME反例。

G4.4b结果边界澄清：供应商生成结果不是本地裁出的conditioning段，不能继承后者专用H.264/AAC和100ms限制。结果仍须真实MP4、有效视频/指定尺寸比例/时长，native须实际存在有效音轨；记录实际codec，不擅自转码或拒绝其他可读MP4编码。时长比较沿既有成片合同`max(250ms, expectedDurationMs * 3%)`，不靠调宽测试常量绕过失败；保留时长/完整对白及后继裁剪质量另须审核。replace分支记录已有音轨，替换/移除归后继批准的声音合成，不伪造无声或TTS证据。根静态指出上述误用及迟到query降级风险后，作者正式RED 14/12/2已复现：真实MPEG4+MP3/+200ms误拒、已下载中observation被晚到running覆盖；修后须聚焦回归与双审，不将旧13/13说成这些缺口已通过。

G4.4b独立SPEC r1补修（2026-09-07）：40/40针对性、354/354相邻和43/43功能锁绿色后，独立静态审查发现两项P2，报告SHA `bd9e58ae4cc878719b28313bb20d11f35e5f3c30eb748f141dc4d3deeb76661f`，本包尚未关闭。唯一作者先补正式RED，再只在已授权RunService/SourceConditioning及本包新测试/helper内修复：①marker写入触发器改变当前有效Key或价格时，必须在同一immediate末检发现并整体回滚，0 POST；保留原held且不在POST后拒收已知ID。②真实结果除编码W/H还校验可信SAR/DAR/显示旋转，不符或本包不能解释时保留ID/held、零candidate/零自动重试；不强制方形像素、不转码、不改G5或旧conditioning普通probe返回合同。保留合法MP4 codec及时长容差正向例。先由根读新增测试/媒体命令，再用原隔离launcher新label执行；保留r1快照与报告，修后新冻结重新双审。本次是纠正既定提交与媒体合同，不引入新功能或外部权限。

G4后继只读定位（2026-09-07，G4.4b修复期间，未实施）：旧`redrawCandidateReviewService.loadCandidate`强制owned shot与completed video_generation，`redrawCandidateQualityService`的六验证器输入也为shot/video合同，不能伪造ID复用。单元当前已有同attempt output SHA/candidate hash及waiting_review，后继需在真实unit QA/候选字节绑定上实现显式批准/拒绝；批准时核验原唯一paid reservation或free0，复用`creditLedgerService.confirmForScope`，与attempt/task/run revision同事务，不调用会推进父shot/版本的旧审核外壳。拒绝不等于供应商明确失败退款。`nextReadyState`已有连续前序批准字段进入readiness_hash，但非空quality对象不是完整QA证明，后继应核实真实通过语义、输出字节和confirmed账态。普通HTTP/API/UI仍只有plan/queue/materials及旧shot审核；按上文既定execution-runs/readiness/advance/pause/unit-review接通，不另造审批或计费框架。此为源码映射，不是本轮已完成、真实内容验证或QUALITY结论；G4.4b双审退出前不得开始并行产品修改。

G4后继真实QA缺口补记（独立只读定位，2026-09-07）：默认`app→setupRouter`并未注入`candidateQualityVerifier/Dependencies`六项实现；严格检查会拒绝而非自动通过。可复用实际媒体probe/hash、已有locale/native-audio Worker客户端（仍须unit全文/候选/调用快照适配），但它们不等于精确全文、声线或环境音安全证明。现有源coverage/遮罩验证不检测生成候选的原人物/文字残留与身份关系，subtitle cue验证不读取视频，口型默认检测器亦不存在。`projectNativeAudioQualityEvidence`的exactTargetText/speakerVoiceMatches/ambientAudioSafe是传入布尔量，不是检测结果；禁止靠固定true或测试依赖补成“真实QA”。下一包应明确机器实测证据与需人审条款，缺证据保持待审，接上真实默认调用及普通页面后再谈通过；不能只新增可注入接口就关闭G4或声称任意视频已可自动验收。本记录未运行Worker、没有验证当前模型ready或真实内容。

G4.4b质量末检修复（2026-09-07）：r2的45/45聚焦、根354/354相邻和独立43/43功能锁均通过，SPEC r2 PASS（SHA `038bf0e4929dea70a3f21d3633d2d467060a1d914452bb6493b637ad730d59c1`）；QUALITY r1仍有一项P2（报告SHA `20e512f376bdaae7d235d3983f40e84d9127835851efc1ba5af843f064785dcf`）。task pending→processing的同步trigger仅清空credit_reservation_id时，当前部分marker末检仍可放行POST，后续明确失败无法沿原冻结绑定退款。根已对照写前绑定、marker及后继退款代码确认，交唯一修复作者：先在原dispatch测试补实际trigger RED，再只改RunService的同事务写后必要task/run/attempt与原held账态快照核对；原已返回ID接收、媒体/模型/账本代码不改。历史失败与r2冻结保留，零外部调用；不得用新增可注入接口或未执行反例充当验收。修后重新冻结、SPEC→QUALITY，再根回归与累计回读，完成前不关闭G4.4b。

G4审核续行的实施落点（2026-09-08，仍待G4.4b双审退出）：沿已批准A审核/B不确定时降级A的合同，先连接当前owned unit候选的读取、真实文件技术复核和明确人工批准/拒绝，再接普通HTTP/UI；不把unit ID伪装为shot/video_generation。保留原submission与candidate快照及candidate_hash，审核证据另存于同attempt envelope，不重写原生成事实；审核者/时间由服务端记录，输入checks只能表示人工逐项看听结论，不能作为机器验证结果。缺少内容检测器应如实待人工审核，不固定true；媒体损坏、上游/候选漂移、已知质量失败与账态不匹配仍硬阻断，不因人工勾选覆盖。批准时复核原唯一paid held或free0，与task/attempt/run CAS及既有confirmForScope同事务；重复请求不得重复确认积分。拒绝保留候选/原账态并阻止后继，不冒充供应商明确失败退款。随后加强nextReadyState的前序审核/输出/账态闭合，暂停继续保留显式确认和零重试边界。此是既定审核链的实现顺序，不代表默认六检测器、真实听看、自动内容验收或本包已经实现；未解决本轮QUALITY前不派并行产品作者。

G4普通候选预览补记（2026-09-08，只读）：通用`assets`公开平台路由按`drama_id`鉴权；unit候选由独立redraw owner/run/attempt及资产metadata绑定，未登记旧drama/video_generation。不得为了预览伪造drama关联或关闭通用asset权限。后继普通页面需从owned version/run/attempt入口取得候选摘要及受控预览，实际asset行/metadata/路径/字节须与原candidate快照闭合；不直接暴露服务器路径、供应商原始URL或私有submission/Key字段。此处只记录已经读到的接口区别，尚未实现新预览端口。

G4审核旧合同核定（2026-09-08，只读）：旧HTTP/shot人工审核没有`checks`字段或六项机器内容证据末检，不能把上文“复用质量条款”误写成复用一个不存在的checks验证器。新unit审核应采用已规定的严格输入，并清楚区分人工逐项结论与真实技术检查。A/B实际只在`redraw_projects.execution_mode=safe|auto`；version/blueprint没有独立mode，不确定待审也不改写project模式。首单元仍必须人审；默认尚无完整内容检测器时其余单元同样待人审，不自动批准。原unit生成prompt明确不加captions，因此最终字幕存在性属于G5合成门禁，不能照抄旧shot的“有对白即视频自带字幕”规则阻断所有新候选。人工审核仍要检查意外原文/新增字幕残留；native、replace、静默的检查适用性须从当前已审核pack判定，不由客户端豁免。

G4.4b测试合同补修（2026-09-08）：marker F1已获SPEC/QUALITY确认关闭；根补查旧RunService suite发现exact公开导出清单仍6项、本包实际新增至8项。已真实隔离跑得98/97/1、native1，唯一失败为该集合断言；其余97包含实际新进程SQLite竞争、GET和pause，149引用前后不变。旧RED目录`g4-run-storage-author-20260907-r2-g4-dispatch-export-red-r3-e2d64a83289a4b13946d39ca79dd86e3`，receipt SHA `43dcea40411be4c6053888d0d2e86ba4d1bf9734abcb1fa6dd4f57484de5e73b`。同作者仅将原exact期望加入dispatch/recover两个既定方法，保留其他断言与所有产品字节，再跑原suite；不为纯测试清单变更重跑未包含该test且产品未变化的49/354/43套件，原回执如实保留当时测试hash，新旧差别单列绑定，不伪造旧回执的当前一致性。

G4普通页面接线落点（2026-09-08，只读核定）：沿现有Workspace→SourceStep→LocalizationReviewPanel→ExecutionPlanReviewPanel子树接入；真实执行queue归PlanPanel持有，不能把step3旧GenerationQueuePanel当unit执行器。复用PlanPanel及UnitReferenceMaterialsPanel的sequence/context/同步watch/alive防迟到模板，但run摘要须独立于不可变pending queue DTO。素材准备完成需显式通知运行就绪刷新；上游work刷新本身不是已验证的迟到防护。真实project.execution_mode/policy_version目前未传进该子树，后继接入要使safe→auto→safe也撤销旧票据，不能仅比较最终mode或ID。仍需新增真正HTTP/API/组件连接，本记录不是页面验收结果。

**G4.5候选审核与续行连接包（接续已关闭G4.4b，仅本地）：** 新唯一作者负责owned unit候选读取、实际文件技术检查、明确人工审核、原唯一paid/free账态确认与前序放行；默认只新增unit review service/test，并窄改RunService的前序审核检查和必要的SourceConditioning技术复核提取。旧shot审核、通用assets权限、账本实现及模型不改。复用当前源/审核pack/准备材料同步末检、实际probe/hash和confirmForScope；禁止复制第二套材料验证器或将unit伪装成shot。当前submission/candidate保持原样，审核记录另存envelope，reviewer/time服务端生成，checks明确为人工证据。没有真实检测器时不自动通过；首单元和不确定后继都待人审。审核无生成/新预留，重复批准零重复确认，拒绝保持原账态并停止后继；当全部单元按顺序批准才run completed（不代表成片已合成）。技术/原素材/候选/上下游hash漂移、坏资产及绑定错误必须阻断；最后await后即时事务重核，后续写失败全部回滚。先用当前真实dispatch fixture加默认本地媒体做正式RED，不手填最终approved/candidate伪造端到端；精确责任/输入/人工检查适用条件与隔离入口由作者一次性回报root定稿后执行。HTTP/UI仍为此后的同主线连接，不另起平台或用户审批轮次。

G4.5静态合同已核定（2026-09-08）：具体入口与测试合同见`.codex-staging/g4-unit-review-20260908-r1-static-entry.md`，它是本包执行记录，不另立主计划。另批准MaterialsInternal仅导出现有currentPack，以及旧Claim测试中将手填approved正控迁为真实dispatch→review正控、保留伪approved拒绝负控。人工批准必须所有服务端适用检查passed；拒绝允许诚实not_checked，不强迫编造失败。原生有声、原生静默、replace分别判断适用性；画外对白不强迫可见人物动嘴，replace的最终配音/字幕仍由G5负责。批准只确认原held，拒绝不退款；原账本API对非held原样返回不能当确认成功。根已审完整隔离入口；初始三项真实候选RED均在候选完成后因缺审核服务失败，363引用0漂移，现进入同作者GREEN。当前不是G4.5通过证据。

G4.5真实后继测试的唯一夹具扩展已核准：`redrawExecutionUnitDispatchFixture.setup`新增默认false的`sequential`参数；true时复用底层已有真实secondMotion、durations=[5,7]，并仅将隔离synthetic capability的maxVideoReferences设1，让原planner得到两个完整parent。新正控须明确断言两unit及5000/7000 retained/generated、第二MP4真实时长符合原output_contract；不伪造processing报告，不改产品planner/能力合同。默认setup行为不变，此helper为第5个既有窄改，须保留旧transport回归。此序列仅验证整parent路径，跨parent派生保持原独立测试义务，不据此冒称已覆盖；不是生产能力修改或供应商操作。

G4.5第6个既有窄改已核准（2026-09-08，root `06ad23`）：`redrawExecutionTaskBinding.test.js` 仅将 `synthetic_authoritative_state` 手填审批分支改为必须阻断且零DML；原第二次真实bind的newly_bound、attemptId、revision、安全DTO及waiting_review/failed/needs_attention前序阻断断言，迁入新review测试的实际第一批准→第二claimed链。不改TaskBinding产品实现，不删减其他旧用例。追加边界必须区分拒绝决定与实际内容看听完成性；最后await后只比较原reservation/allocation/关联bucket/该预留流水，不把同租户无关业务的异步活动纳入目标审核CAS。赠送积分正控使用真实membership及实际bind分配，外租户bucket反例先通过真实reserve取得足够held，避免以余额不足掩盖归属问题。以上均为隔离合成账态，不是线上积分或真实质量验收。

后继HTTP测试入口核定：`redrawUnitReferenceRoutes.test.js`复用真实handler factory、显式db/cfg、req.tenant/req.user，以query_only/total_changes及foreign owner和严格body反例验证服务边界；它不经过JWT/会话middleware、不listen，注册检查仅源码断言。因此可复用作隔离handler回归，不能命名为已验证真实HTTP/登录页面。后续仍须补真正鉴权HTTP与页面链；router顶层依赖须继续由已审本地preload隔离，单传cfg不等于所有依赖不会读默认配置。

后继真实HTTP入口已有可复用基线（2026-09-08，只读补图；root核读 `fec435`）：历史`.codex-staging/g4-unit-reference-root-20260907-r1.json`中的HTTP 29/29实际来自`redrawMotionCandidate.test.js`，不是上段direct handler套件。该fixture使用显式内存SQLite、真实用户注册/token/tenant、setupRouter、Express以及仅本进程随机127.0.0.1监听器；既有`.codex-staging/g4-owned-loopback-preload-20260907-r1.cjs`阻断默认配置/DB、所有非自有端口、TLS及重定向。可复用此模式，不新造HTTP平台；新增JSON POST需显式解析，GET拒绝零DML仍放在JWT后、通用tenant初始化前的只读路径。router仍初始化locale registry等全局依赖，不能称为零初始化。此处只确认现成测试入口，未重跑历史29项，也未完成execution-run HTTP或页面验收。

后继单次推进连接合同（2026-09-08，只读4文件补图）：沿`setupRouter(cfg,db,log,options)`→`redrawRoutes(...,{cfg,...redrawOptions,providerAssetSecret})`复用可信owner、storageRoot、canReadArtifact与log。run服务没有advance总入口；薄连接依次调用claim→bind→dispatch，一次仅处理同attempt，三段保留原expected_quote_hash、各自使用正确新revision，冲突不得自动另claim。get/readiness不得夹带recover；recover会查询供应商并可能下载，必须显式写动作。签名配置来自服务端嵌套`providerAssets`，其中nowMs是数值毫秒；runtime精确`{fetchImpl,download?:{fetchImpl?,_dnsLookupForTest?}}`，不能传旧shot的static签名工厂或默认空runtime。结果临时目录须绝对、存在且受控。现有generationContext是旧shot的扁平字段，不能原样冒充unit context；env/temp/runtime的工厂仍待接通。Key、baseURL、path、runtime、env不得由body提供。此为后继本地TDD责任定位，不代表已经实现HTTP/API/UI或实际提交。

后继env来源已核定（2026-09-08，只读3文件补图）：`redrawSelectedCapabilityReadinessService`实际使用`ctx.env ?? process.env`；隔离HTTP harness必须显式给`env:{}`，不能以缺省/null声称零进程环境读取。产品通过server-only options保留现有优先级：Fumin为选中行api_key优先，ToAPIs为TOAPIS_API_KEY优先，飞拓直接用选中行api_key。resolver按config_id/config_updated_at读取既定有效行，不调用默认模型选择器；代码内备用base_url与加载默认配置须区分。readiness/advance/recover必须使用一致的服务端env策略，不从body接收Key/env，不把含有效Key的connection.config写入task/public DTO；本次没有读取任何真实值或改变模型、域名和凭据优先级。

后继HTTP当前消费原则：上述“没有advance”的文字是G4.6实施前定位；等G4.6关闭后，路由必须直接调用其`inspectExecutionRunAdvanceReadiness/resumeExecutionRun/advanceExecutionRun`，不得在handler再复制claim→bind→dispatch而遗漏策略守卫、阶段重放或安全回执。GET只读、写动作显式、提交回执和存储事实两类返回保持诚实。

后继候选播放连接缺口（2026-09-08，独立只读4文件，未执行HTTP）：`/assets/:id`的公开平台owner检查只读drama_id，故新unit候选的NULL drama_id会被404；`/static`只识别旧source/project/generation路径，不核对unit category/metadata，即使偶然200也不是unit绑定证据。旧motion媒体接口按shot/source/import定位，不能把unit冒充shot；redraw asset preview也仅接受关联image。新增最小`GET /api/v1/redraw/versions/:id/execution-runs/:runId/units/:unitId/candidate/media`及`redrawExecutionUnitCandidateMedia.test.js`，按owner/version/run/unit定位并复用G4.5当前候选与实际文件证明，发送头前末检；不接受asset_id/路径或metadata自述来授权，不放开通用resourceOwnership。`canReadArtifact`仅检查文件存在可读，不是owner鉴权。复用旧motion abort/pipeline/cleanup/no-store/nosniff/长度与SHA处理和JWT之后、通用tenant初始化之前的只读middleware落点；真实HTTP RED须含正确owner的MP4字节/hash、无凭据401、外owner/伪绑定拒绝、asset/metadata/原文件漂移输出前拒绝以及成功/拒绝零DB写和零transport。首次实现沿G4.5当前绑定可读条件，不自行把历史stale候选标成当前可审核；历史播放的更宽合同没有本次通过证据。

后继暂停/恢复缺口必须显式补齐（2026-09-08，root只读`84647b`）：现有pause只会置pause_requested=1，nextReadyState明确阻断该标记且当前没有resume方法；不能仅接advance便声称暂停后可继续。已有recover只处理含request_hash/submit_started_at的同attempt，不能代替claim后、提交标记前的进程中断恢复。下一唯一作者在写产品前须给出这两种恢复与HTTP薄连接的精确最小状态方案及正式反例：显式新确认、当前owner/plan/素材/quote/CAS末检、保持原attempt和原预留、未知不重提；禁止GET解暂停、清空未知、重复advance自动换attempt或仅清状态放行。先接已具备的读写接口不等于这些缺口已关闭；本轮QUALITY仍仅审G4.5，不向其追溯新增范围。

G4.5本地最终退出（2026-09-08）：作者192/192、root审核57/57与兼容r2 146/146各native0；SPEC/QUALITY均无发现，全部活动退出。累计`.codex-staging/g4-unit-review-verification-20260908-r1.json`为97458B、SHA `de4b6cbb3a963f453aa44859466fe0ac3195acff192bdda021b644780558cc76`，根独立回读409引用0漂移。根兼容首轮因空PATH找不到Git的146/144/2失败保留；只增加固定Git路径及当前worktree的进程级信任修复本地入口，8责任源和原freeze未变。只关闭unit候选审核/原账态确认/顺序后继证明，不关闭G4整体、策略切换、HTTP/UI、G5或客户交付；fullDeliveryComplete=false。后续文档指针更新不回写旧回执hash。

G4.6恢复责任顺序定稿（2026-09-08，根综合只读审查，不采用“所有claimed都禁止resume”的死端方案）：先在现有RunService补服务端薄推进/恢复端口与正式测试，再接HTTP/UI。实际phase只能由存储判定：idle、claimed且task/reservation均未绑定、claimed且已真实绑定但无submit marker；这三个前提交分支不得和submitted/unknown混用。暂停解除统一为显式新确认且只更新run暂停标记/状态/revision，不在解暂停动作内claim/reserve/dispatch；返回实际新revision，下一次推进另取新确认。即使原attempt为claimed，也可在完整当前门禁通过后解除暂停，不能永久卡死；但不得把needs_attention或已提交任务投影成前提交状态。

恢复preview只能在内部严格计算视图中屏蔽pause并排除精确目标attempt，复用既有bind/dispatch的前序与prepared末检，不真实改表、不放开其他active/unknown、owner/plan/pack/材料/selected/price/策略检查。明确推进原unbound attempt允许一次真实bind与paid reserve；原bound attempt不得新claim/reserve，沿原quote与原task/hold做dispatch；新pending才claim→bind→dispatch。原quote语义/金额、材料或选中能力漂移仍阻断，保留原记录/hold，不自动退款重建。每次公开确认绑定当前revision、原attempt/phase、原quote、当前材料与project mode/policy；私有binding_revision只由服务端读取，不暴露给页面。具体端口/精确字段由下一唯一作者一次性列出，经根核准完整测试/入口后TDD；需要新增的导出清单断言属于必要兼容，旧服务方法默认语义保持。正式反例须包含idle/未绑定/已绑定暂停后恢复、原attempt/hold计数、两个中断位置、旧确认重放、已marker未知零重提及safe→auto→safe撤销旧确认，不以人工SQL终态冒充完整生成链。

G4.6入口字段已核准（2026-09-08）：新增`inspectExecutionRunAdvanceReadiness(ctx,versionId,runId,{output_parameters?})`、`resumeExecutionRun`、`advanceExecutionRun`；两个写输入精确为`expected_revision/expected_plan_hash/expected_quote_hash/expected_confirmation_hash`及可选严格`output_parameters`，不接受attempt/phase/binding_revision/Key/runtime字段。action与phase由实际存储推导，新独立confirmation schema绑定实际revision、原attempt/quote/readiness、参数及project execution_mode/policy_version；原claim/quote schema不改。idle使用本次原readiness.quote_hash，claimed使用原attempt.quote_hash。resume仅写run再返回真实新revision，不发预期未来票据；后续重新inspect明确advance。

G4.6本地退出（2026-09-08）：作者无过滤focused216/216、compat141/141，全新SPEC_PASS、QUALITY_APPROVE，根无过滤advance24/24、compat141/141全部通过，各自native0、415引用运行中稳定，不相加为去重覆盖。累计`.codex-staging/g4-advance-resume-verification-20260908-r1.json`（145339B，SHA `768570735981253587c93d8338065590fbe6fbd7f12d4842fb70867bcd0eed5a`）包含178源/283工件/1父/2文档；独立回读464引用0漂移、1760份历史父源副本核验，全部10轮历史分类和日志保留。advance保留原安全ID/持久化标记且不再回读失败DB，resume仅run、旧确认不推进新单元和原attempt/hold复用均经本地反例/正控验证。只关闭本服务包，不关闭G4、HTTP/UI或完整产品；OS媒体后代未独立盘点、真实内容和CI未验均保留。接下来派全新唯一作者完成既定HTTP和受控媒体连接，再接UI；具体证据见唯一验证记录，不另起交付计划。

G4.7已交全新唯一作者静态入场（2026-09-08）：准确路由路径为`backend-node/src/routes/redraw.js`和`routes/index.js`。拟新增真实JWT/自有随机HTTP的run接口与候选media测试及专用fixture，不以direct handler或旧CLI替代。根核准必要最小扩责：RunService只读发现所属run（现get必须runId），保留历史stale/unknown而非靠localStorage；只有可证明唯一当前绑定才给current_run_id，无当前为null、歧义不任意取末条，并只补Run.test精确导出断言。UnitReview复用private withCandidate作实际probe/prepared及原账态末检，SourceConditioning仅提取持同一FD的open/hash/stat/stream/cleanup，原assert仍同步open→hash→close；不公开relative_path或放开通用asset权限。发送前同步复核原state/reservation/asset/task/FD，先明确最后await顺序和清理，不默认叠加第二次完整probe或第二套业务验证器。

G4.7真实actor夹具扩责：`backend-node/scripts/run-redraw-reference-bundle-local-case.js`在migration后、一切seed前增加可选createActor(db)，新HTTP fixture使用真实register/ensurePersonalTenant/token；actor贯穿`test/helpers/redrawUnitReferenceFixture.js`与`redrawExecutionUnitDispatchFixture.js`，原默认tenant-a/user-a保持。不得事后UPDATE已批准图谱的owner或手填approved/candidate/held来假冒真实登录链。DispatchFixture新增queued早退只能位于真实queue审核后、createExecutionRun前，运行由HTTP真正创建。所有旧文件先存本包完整原字节基线；静态测试/launcher/preload经根核准后才RED→GREEN。旧loopback守卫不覆盖DNS/OS网络沙箱，合成下载必须显式测试DNS；若补DNS拒绝只新建本包preload，不回写旧累计工件。当前尚未运行新HTTP测试、没有产品GREEN或UI成果。

G4.7作者交接（2026-09-08）：实现子代理因usage limit终止，未交付作者完成回执；只读media检查者亦终止，其部分消息不作SPEC/QUALITY通过。root已亲读实际入口、launcher/preload、首批4项测试及三层fixture相对原字节差异，并确认源runtime仍未修改；接手本包唯一作者，保持无竞争写入，不重建worktree。首批入口两项静态问题（不存在的reviewer_user_id列、遗留未声明TestNamePattern）已由原作者在运行前修正；原生TAP/stderr在after哈希前保存。接下来执行隔离无过滤focused RED；独立SPEC/QUALITY仍须未来真实完成，root自查不冒充双审。

G4.7本地进度更新（2026-09-08）：真实run/readiness/pause/resume/advance/recover/candidate/review和受控media已接入；root接口正控11/11、完整HTTP连接及重开/权限边界14/14通过。后继媒体负向回归真实复现缺文件500和发送前撤权仍200；全新独立窄审查又定位局部GET异常脱敏缺口及待实测FD双关风险。按TDD先保存负例，再只修本包HTTP/FD边界；不修改模型、供应商、计费引擎或其他功能。原闭包、失败和父快照全部保留，最终仍须剩余负向矩阵、相邻回归、SPEC/QUALITY与根关闭；窄审不替代终审。G4 UI尚未开始，G2/G3/G5/G6仍按本计划后续顺序，不能以局部HTTP通过关闭全产品。

G4.7作者冻结更新（历史）：上述四个实际缺口已完成RED→最小修复→GREEN；最终HTTP16/16、media7/7、adjacent136/136、contracts43/43四组native0，全新SPEC开始，随后才QUALITY。精确源/入口/原字节基线/4轮回执均由`.codex-staging/g4-run-http-20260908-r1-root-author-freeze.json`关联，SHA `8af9b254320271263be26b3874d43baef14f3818d3029f5b93e43814c20066da`。媒体在途回调门闩的abort和显式stream error都实际通过，保留borrowed-FD+finished等待+唯一cleanup，不基于推测引入另一套关闭责任。

G4.7 SPEC r1最新回执：FAIL / 1 P2，实际材料/pack/source业务失效码遗漏局部4xx映射。报告SHA `bb132ea0dfd28237d5d0a554b246927b3ffbec7de26e1f070ca7ef5642df2051`已根读回，审查者最终activities为空后解除旧冻结。下一步仅root补真实HTTP失效分类（系统I/O仍500）和原书面缺失的HTTP reject/工具启动前文件变化测试，先RED再最小修复；不把所有probe错误变409、不重写验证/计费/模型。保留旧报告和GREEN，修后重新冻结交SPEC复核，通过才QUALITY和根收口。普通页面run接线仍是后继包，不并行写产品；只读UI映射可继续。无真实供应商/付费/生产/Git写入。

G4.7 r3分类修复进度：r2独立SPEC FAIL的5个直接传播码已局部映射409，未知/系统/cleanup仍500。第一次23/20/3中motion/localization为真实RED，blueprint则是测试撞locked immutable trigger，已明确纠正分类；保留原行和触发器，测试改为两次实际SELECT间改单一可变version绑定。最终HTTP23/23、media8/8、contracts43/43各native0，480引用稳定并当前回读0漂移；三个竞态句柄关闭完成断言通过、HTTP GC警告0。新r3冻结SHA `6de93bf7b05dec00b4fcf314fe69f47a64c0dcc0b508ba88a0ed250caf7035c8`已根核36引用0差异，已交原SPEC针对F1增量复核。旧57/136不重跑/不混称本轮。必须SPEC复核、全新QUALITY与root收口后才能释放页面作者；产品不因测试夹具问题扩大修复范围。

G4.8后继页面只读接线复核（未实施）：独立映射确认审核链位于SourceStep→LocalizationReviewPanel→ExecutionPlanReviewPanel→UnitReferenceMaterialsPanel，第3步仍为旧shot队列，不能复用旧batch/shot POST。最小下一包是`frontweb/src/api/redraw.js`新增精确run端口包装、PlanReviewPanel后挂一个窄`RedrawExecutionRunPanel.vue`，不并行重写Workspace/ShotStep。运行发现来自GET collection的`current_run_id`，不是不存在的`/execution-runs/current`；所有写操作单击显式、无自动重试，safe receipt必须原样保留，缺完整run DTO不能当作失败后重提。token由原request interceptor逐次取得，不缓存/复制；受控媒体用带身份的Blob GET和AbortSignal，再生成/撤销object URL，不直接把保护路由设为video src。

页面测试先API字段白名单/原错误对象/单次POST，再真实SFC状态和父子刷新：owner/work/version/plan/review/queue/run/revision/unit/candidate以及真实project mode/policy变动同步递增epoch、alive和每个await后检查；必须覆盖A→B→A、卸载、迟到媒体/错误解析、pending POST时父刷新不释放防重。计划刷新、素材准备完成只读刷新readiness，不能隐式advance/recover/resume。原required_checks逐项人审，不沿用旧B模式自动批准。精确生产责任仍须在G4.7双审根收口后交新唯一作者TDD；当前只是既定主线落点补齐，不计UI已完成或另起审批轮次。

G4.8唯一后继作者静态入口已根全文核读：`.codex-staging/g4-run-ui-20260908-r1-static-entry.md` SHA `a7e54705844593950eddb6b28a4b92962fa85a3abf0857705d9018e65ee0926c`，仍WAIT_ROOT_RELEASE、products/tests_run=0。实际project源在Workspace；为覆盖同tick safe→auto→safe，须源端同步epoch+稳定响应式对象逐层透传，不能仅叶子watch最终safe值或借ProjectOverview展示回退。Run.attempts没有provider_task_id，重载后只能显式按attempt_id“核对原尝试”，由后端决定能否查；不得猜已知ID或自动recover。唯一safe recovery_receipt与run DTO独立保留，失败GET不能覆盖。本包不重写旧shot队列，不产生真实供应商调用。

G4.8 后继媒体接线契约预备（2026-09-08，只读，待生命周期双审后实施）：候选 `required_checks` 是动态字符串数组，每项初始 `not_checked`；即使 auto 策略也不能跳过人审。候选 `candidate_hash` 不等于媒体 `asset.sha256`，候选状态不等于 run 状态。带身份媒体 API 返回解包后的 Blob（无响应头），错误也可能是 JSON Blob，不能当 MP4 创建 URL；摘要比对使用候选 asset SHA。播放与每个 await 绑定请求时 owner/version/run/unit/attempt/candidate hash/revision；失效或卸载停止媒体并撤销 URL。审核只传四键 `expected_revision/expected_candidate_hash/decision/checks`，checks 完整匹配返回键；批准须全部人工 passed，技术 ffprobe passed 不预勾内容项。返回候选 DTO 不含 run status，不能据此自动推进下一单元。上述是既定播放/人审范围的真实端口补充，不是已实现或验收结论。

G4.8 候选页面包入场（2026-09-08）：生命周期收口后已交新独立作者 `g48_candidate_ui`。仅在现 RunPanel 接候选/媒体/审核，新增 `redrawExecutionRunCandidate.test.js` 及单一测试精确入口；不新增 child/helper/import 或并行生命周期框架。复用原 owner/context/epoch 和持久操作槽，仅扩审核动作；审核未知必须按原候选/决定/检查值显式核对，不能换 hash 重提。测试使用真实 SFC 内存 renderer、三端口 stub、Blob/webcrypto 与媒体 host，旧 114/12 原断言/入口不改。先测试及静态运行入口核准，再 RED→最小实现→GREEN→双审；当前只是入场，不计播放/审核或真实浏览器验收完成。

候选页面首轮 RED 已核（2026-09-08）：根全文核准 candidate-r1 entry/run/preload 和 71 项正式测试后，运行得到 71/0/71、native 1；首例是真实 Vue 挂载后缺候选读取按钮，其余为缺 `loadCandidate`，不是加载器失败。原 Vue `b35d1c8c…072ef` 未改，stderr 空、source_unchanged=true、PID 59128 已退出。原始目录 `.codex-staging/g4-run-ui-candidate-20260908-r1-initial-red-4fe575cc004242349fd9b3b274d74262`，receipt SHA `1c7ae35997335df7144db0421863bc4355fbe8d0fa47f44a44aed0bfa3e42f66`，TAP SHA `15f3825b3b5677794d84802b087b25f1a94668c55e1e1d993b621473202dcad7`。现在按已批准范围实现，再跑本组和旧 114/12；尚未 GREEN 或双审，不计实际播放/内容验收。

父链测试入口只读预备完成（未实施）：复用 `redrawUnitReferenceMaterials.test.js:152` 的真实父子 renderer 与生命周期测试的严格 Vue 编译转换。下一精确读集仅增 Workspace/SourceStep/LocalizationReviewPanel/PlanReviewPanel 四个 SFC、`redrawWorkspaceState.js`/`redrawBlueprintReviewState.js` 两个无 import 的真实纯 helper；router/Element Plus/其他重组件及 API 端口注入，不加载 Vite 或默认服务。除 Plan preview 外，SourceStep 187–203 的 loading/error 分支也会卸载下游，必须用实际四层＋已冻结 Run 的测试验证加载中保留同一实例并 blocked，不能只测叶组件。同时验证 Workspace 实际 project 同 tick 策略 ABA 经同一对象/源 epoch 传递、旧确认失效，素材回执只读刷新、不自动生成。本预备没有运行或写产品，不算父页面完成。

2026-09-08 G4.8 当前进展：API 5 GET / 6 POST 有效 RED 27/0/27→GREEN 27/27、双审 PASS；轻量收口 SHA `002a2f2107b80525e6594e6e02e69ff97ef4c9649dadb932e53b19a5164c24b3` 已核 9 引用。RunPanel 首组由真实缺组件 RED 起步，修正加载器后保留全部历史失败；独立审查的 revision 0、字符串 task_id 和单记录刷新死端分别取得 RED→GREEN，最终 12/12 native 0，SPEC / QUALITY 均 PASS。首组收口 `.codex-staging/g4-run-ui-component-group1-verification-20260908-r1.json` SHA `f3d18aa8db10148fcef7f940dc440c4965d6223ce7eb3ba22eb32f38e2cca289` 已核 13 引用，完整原字节基线已保存。组件仍未挂父页面。下一组先新增 `redrawExecutionRunLifecycle.test.js`，依序覆盖持久 pending/unknown 防重、同模块真实 Vue 实例重挂与新模块加载、原 owner 回执显示/保存、真实 owner ABA、显式 pause→新确认 resume→再新确认 advance、只按原 attempt 显式 recover；取得新 RED 后才改产品，不新造状态框架。播放/人审与父页面接线随后，不能关闭 G4.8。G6.HTTP_EMPTY_ARRAY_GET_BODY 仍明确延期 G6，不修改冻结后端；UI 不新增项目策略 fallback，须与 Ready/Candidate 的真实策略匹配，不改旧 mapProject。

G4.6执行入场：首轮真实存储三阶段反例3/0/3、native1已由根读取，均因缺新入口而失败，Child尚未启动，旧源在运行中无漂移。详见唯一验证记录及`three-phases-red-9504b324a4174d6d8a1af197c8c33d82`原始回执。新测试允许用绝对Windows taskkill针对本次spawn PID的/T树，或POSIX本次独立进程组，统一等待实际close；禁止按进程名称或全局清理。最小GREEN之后继续完整批准矩阵与双审，不以三个正控代替全部暂停/恢复、竞争和策略证明。

精确重放须从原attempt/metadata/submission验证原phase/revision，不猜current.revision-1；旧策略确认拒绝，原单元后来approved也不准落到下一单元。并发claim或bind的loser若newly_claimed/newly_bound=false，只回显同事实，不继续后段提交；claimed_bound须取新独立确认才能恢复。固定mode/policy守卫还要进入原prepared最后同步consumer/beforeSubmit，不能只做外层await前检查。批准必要测试扩责：DispatchFixture新增默认仍bound的stage，只在真实create/claim后提前返回；新增源码内AdvanceChild进行真实重开/竞争，不能手填终态。三旧文件（RunService、Run.test精确export、DispatchFixture）和两个新正式测试/child为当前作者范围；完整代码/隔离入口须根静态核准后才执行，HTTP/UI尚未开工。

G4.6旧确认的可证明边界补齐：原idle请求用其expected_revision重算原claim confirmationHash并要求等于实际attempt.quote_hash；原unbound推进使用真实task.metadata.binding_revision；原bound推进使用真实submission.expected_revision。没有对应阶段写入可证明且revision已变时CONFLICT，不猜测或补造receipt。resume遵守只写run，不新增幂等表；重复旧CAS返回CONFLICT且零DML，客户端再GET读取真实解暂停事实，不冒称能证明是该请求所为。即使后续failed/unknown/approved，精确advance重放也只回原attempt事实，不推进新单元。

G4.6薄封装还须保留既有dispatch的安全失败回执：主observation事务和fallback写入都失败时，原返回值中的已知provider_task_id/recovery_receipt及receipt_persisted标志可能是唯一可追查事实。不得只重读旧DB并丢弃该返回值，也不得为重建DTO再读DB失败而吞掉唯一回执；只保留原已脱敏安全字段，私密envelope不公开。根在新wrapper与既有persistObservationOrSafeReceipt的只读对照中定位此风险（`57d237/d7a97f`），作者须先以真实advance提交标记+底层合成accepted ID+精确SQLite写失败取得正式RED，再做最小连接修复；不重POST、不清unknown、不增加供应商调用。当前是待验证的连接风险，不冒称已修复。

#### G5 声音、合成与下载执行包

2026-09-08只读映射明确归并缺口：现有release/composition仍强制每个父shot对应video_generation及旧review指针，且geometry/执行前后重算/完成回写都有同样一一绑定；没有可直接传unit列表的现成入口。后继应从服务端真实unit资产、审核、plan及parent交集装配兼容证据，不能把output_asset_id或candidate_hash分别冒充video_generation_id或字节SHA，也不能只替换video_inputs后绕过原校验。现有FFmpeg只整文件concat加最终全局-t；新链必须按每unit retained区间处理padding再顺序归并，否则中间padding挤占后续源时间。复用输出任务/CAS/导出外壳，新的unit证据语义需与旧shot清单明确区分，不伪造父审核/视频记录；本记录未实施或测试合成。

**责任落点：** 新建 `backend-node/src/services/redrawUnitAssemblyService.js` 与 `redrawUnitAssembly.test.js`，单元审核复用已完成G4.5的 `redrawExecutionUnitReviewService.js`，旧shot路径的 `redrawCandidateReviewService.js` 保持兼容；随后小范围连接 `redrawNativeAudioService.js`、`redrawEpisodeReleaseService.js`、`redrawCompositionService.js`、`redrawExportService.js`，以及 `frontweb/src/components/redraw/RedrawEpisodeReleasePanel.vue`、`RedrawEditStep.vue`、`RedrawExportPanel.vue` 和对应测试。先单元归并，再声音发布/合成/下载两包，复用现有 FFmpeg，不另造整集 CLI。

**G5.2 单元归并首包已启动（2026-09-08，仅本地）：** 全新作者 `g5_unit_assembly` 先补一个真实多单元反例，夹具必须先经产品 dispatch→实际候选媒体→逐单元人工审核，再调用新归并能力；供应商底层和人审结论是明确合成夹具，FFmpeg/FFprobe 与输出文件是真实本地工具。正式入口/测试全文由根预读后才执行；缺模块或加载器错误与产品能力 RED 分开。之后再补负向矩阵、SPEC→QUALITY和根回归。

首轮隔离运行 `g5-unit-assembly-20260908-r1-red-root-first-c71df078b90d421982cb023768f5cf37` 已退出（native 1，1 项失败，无超时，选定输入运行前后未变）。失败发生在测试夹具的动作参考派生：部分父镜参考没有 `redraw_motion_processing` 映射，抛 `REDRAW_UNIT_REFERENCE_DERIVATION_MAPPING_REQUIRED`；尚未到新合成入口，不能计作合成能力的正式 RED。仅修夹具并保留日志，不弱化产品映射门禁、不提前写新合成产品代码。

正式 RED 随后取得：`g5-unit-assembly-20260908-r1-red-root-processing-fixture-623d2cda3c7d40a1bbd08cff1f1e0bc4` 复用已有真实 motion processing/import/bind 夹具，两个单元均经 dispatch、实际媒体读取、人工审核合成结论为 approved，run 为 completed；计划为保留 8/4 秒、生成 10/5 秒、padding 2/1 秒。测试最终只在新 Assembly 入口尚缺失的断言失败（native 1，1 项失败，无跳过/超时，stderr 空，选定输入未变）。receipt SHA `eb1220109648605e63d35e47ef853ef61d78883ccccaa447fb4876a90f23ad5b`，TAP SHA `d4a384bc7a240783c0833909495721e7891713f4b926f5e0ededbafd58484a2a`，进程已退出。允许进入已批准的最小 GREEN 实现；真实供应商、人审内容与最终合成验收均未发生。

最小接口：Review 增加 approved-only `prepareApprovedExecutionUnitMedia`，复用既有 withCandidate/readState/assertStoredReview，返回安全冻结元数据、受保护媒体流、assertCurrentBinding/cleanup，不暴露 raw state/Key/local_path。Assembly 的 `assembleApprovedExecutionUnits(ctx,{version_id,run_id,expected_plan_hash,expected_run_revision})` 只写本次隔离临时目录，0 DML；核对同 owner/run/plan/完整有序批准链，逐单元去 padding 后归并，返回内部 manifest/files/assertCurrentBinding/cleanup，尚不登记资产或冒称 release 完成。manifest 必须分开绑定候选身份 hash、实际字节 SHA、review hash、源/保留/补足/父镜/对白映射和本轮输出 SHA，最终合成后内容仍待审核。

首个实际媒体 GREEN：作者与根独立各 1/1、native 0，无 skip/cancel/todo/timeout、stderr 空、选定来源未变，进程均退出。根目录 `g5-unit-assembly-20260908-r1-green-root-green-main-54bf155b73c743038d7fc574eeba4b7d`，receipt SHA `d4451f71a93935daaa5ffb987da90ae1c36465c7005cda6e8a38decfe268ff85`、TAP SHA `9deacf391b7f7258af5628a5f4e12acda4ed5a8058f0b8b4420686d516b9b7c3`，PID 66416 已退出。实际输出约 12 秒；第 1 秒红画面/440 Hz、第 9 秒蓝画面/880 Hz，证明中间 padding 未挤占后续单元；manifest 实测时长、输出 SHA、父镜/对白映射与零 DML 断言通过。该证据只覆盖合成夹具的首个正例，不证明真实英语、角色或最终声音质量。下一轮测试必须覆盖反相立体声不被 mono 下混抵消、状态/字节漂移拒绝、只清理自建目录、replace/not_required 模式，完成后再独立 SPEC→QUALITY 和固定相邻回归。

避免循环依赖的唯一必要扩展：新增叶子 `redrawMediaRuntimeInternal.js`，只机械抽取 Composition 的 sha256File/defaultCompositionRunner/defaultProbeRunner/validateGeometryProbe/rationalEquals 及所需局部辅助；Composition 与 Assembly 同向引用。旧 shot 清单、hash/schema、账态、输出任务与发布事务不迁移。旧 26 项几何/配音回归必须保持；不得把 runId 假装 exportId 复用旧 workspace，Assembly 使用专属临时工作区。

独立只读抽取审计（2026-09-08）：相对实际前包 Composition SHA `4e74d2d23263bdb7574e2bd0c0fbdf81f03a8939345ddffa472c65b0e8e7a5cc`，原 43 个顶层函数中保留 33 个函数体，规范换行后全部相同；迁移 10 个 leaf 并复制原 codedError，原四项公开入口不变。三个迁移函数仅链式换行或对象排版差异，表达式、字段顺序和 30 秒 probe 超时不变。此为静态等价检查，不能替代随后 Composition 26 项实跑。

音频语义：native 同步保留/裁剪实际原音轨；replace 首包仅输出视频，并标记 approved_dub_required、最终音频与环境音待处理。not_required 只代表无对白要求，不代表无声（Preview:109；Blueprint:339–343 的 ambient_audio 仍为 preserve_or_rebuild）：保留已有候选音轨；全部无轨则视频-only，混合有/无轨仅可对缺轨区间作明确静音占位。逐单元如实记录原轨/占位，最终环境音与无多余对白仍待审，不能据占位或旧人审标记宣称声音质量已通过。字幕/报告/实际下载仍属随后连接，不在本首包假造。

音轨回归进展：真实左右反相 stereo 测试复现 mono 下混将声音抵消（1 秒处两声道 RMS 约 0.018，2 项中 1 fail）；仅改输出统一 stereo 后原样 2/2、native 0。GREEN `g5-unit-assembly-20260908-r1-green-author-stereo-green-8a36080212fa4212a18dc957b605b813` receipt SHA `da107816375de17d9b7819fb7c67e3005d6789cae6f9b0b459b19ac4862006d8`，选定来源未变、PID 56360 已退出。根另跑旧 Composition 26/26（receipt SHA `d455488afcf4d6155a8beddf8ad8fde169d5d587ac2d740216bac6e2581d2f32`），真实非方形像素及 TTS 控制样本通过。独立 SPEC 初审尚未通过：需精确验证并保留原 MP4 音频相对画面的起点偏移（不能独立归零使对白提前），输出 manifest 需记已核验 SAR/DAR；这些是同一同步保音/几何合同的补测，不新建声音引擎。末次输入/输出绑定、模式与清理矩阵仍待最终回执，旧两项 GREEN 不充作完整 G5.2 通过。

后续下载接口只读核对：`redrawExportService.resolveDownloadArtifact` 已包含 owner、完成态、asset/metadata、当前 release 重建、真实路径及文件 SHA 校验；保留该外壳，为 unit schema 明确增加对应绑定分支。普通页面已有鉴权 MP4/SRT/VTT Blob 下载及导出详情转 JSON 的报告保存；后者不是有独立文件 SHA 的不可变报告产物，不能混称。`RedrawEditStep` 当前按 composition ID 或最新完成行选取，连接 unit assembly 时必须指定本次目标导出，防止展示旧成片；不另造整集 CLI 或下载平台。本记录为源码映射，尚未实施或验收该连接。

G5.2 A+B 最终根复测（2026-09-08）：`g5-unit-assembly-20260908-r1-green-root-ab-final-c5cec51cc76243f4931ff76de26edc58` 为 3/3、native 0，receipt SHA `54bcd6c47664733fc2d59d5471bd4817b06363951f47f75a1df61af459c0f71c`，TAP SHA `1d02d2694d5d431e1f8d5bdaa0047f3ba10c7e76dc8f936ae35072227d62aeac`；选定输入不变、无跳过/超时/stderr，PID 57336 已退出。除正例和立体声外，已覆盖冻结快照、异 owner/额外字段/未完成拒绝、自有输出清理、最后异步输入复核期间同长度输出字节变更，以及实际输出 probe 后批准 revision 变化拒绝。最终输出末次 SHA await 后再同步核验输入绑定，打开受保护 FD 时验证实际 SHA。Assembly SHA `f4287e3291e0f17b9383291f7744c1d39ea687bf6fb31ef2cec87bf8465563d1`，测试 SHA `a3727d6df5412267a5b32706eabca3e069474a142fe6e430c6ef346eb4870de3`。

过程纠正：`author-ab-final` 仍 2/3，根诊断 `root-b-cause-90796556bf694984892255908f2cbf4e` 展开真实错误为 `REDRAW_REFERENCE_BUNDLE_MOTION_REFERENCE_STALE`，并非 probe 后批准漂移已经通过；新增通用 `ctx.probeRunner` 被既有动作参考消费者继承。已删除这个新增运行时探针，测试改用现有 `execFile` 的真实 FFprobe 回调且只匹配本次 assembly 输出，未弱化动作参考门禁。所有失败工件保留。A+B 作者已退出；线程名额限制下由根完成这次定位/修正，C+D 改由未参与本包实现的可用代理承接。后者先完成音画起点、SAR/DAR 和 replace/not_required 矩阵，之后整个 G5.2 再做独立 SPEC→QUALITY；当前 3 项绿灯不关闭 G5.2。

后继外层连接定位（只读）：保留 `redraw_exports` 现有 video 类型与 createComposition 的 owner/幂等/活动互斥，以及 runComposition 的 pending→processing CAS、完成资产事务、failed/重启 needs_attention；按显式 unit schema 分派输入和完成逻辑，不执行旧 shot included 更新或伪造旧 review/video ID。普通 release/compose 请求需精确校验 unit/run/计划字段并纳入摘要，继续仅对新建行调度。现有 quality_summary 是输入审核摘要，没有最终成片人工审核接口；后继必须把加工完成与成片审阅状态分开，以 export ID、真实输出 SHA、单元清单 hash 和服务端 reviewer/time 绑定，不把完成标签充作内容通过，审核前仍需受控预览。字幕直接复用 `buildSubtitles`，显式把已核验 pack 的 `target_text` 转成 text、传真实 locale，以单元输出起点加局部对白时间生成绝对时间；保留原长度/速度/重叠约束，不截断台词或伪造音轨对齐。报告、可下载与最终用户验收仍分别记账；这些接口尚未实施。

G5.2 C+D 作者阶段已冻结（2026-09-08）：C 正式 6 项 RED 中旧 3 项通过、新 3 项分别揭示音频提前与清单缺 SAR/DAR；最小修复后 6/6。D 只补模式覆盖，首次完整 9/9、native 0、无 skip/cancel/todo/timeout/来源漂移，PID 52008 已退出。最终目录 `g5-unit-assembly-20260908-r1-green-author-d-mode-coverage-d77d448eb4dd4ff88da326d362271959`，receipt SHA `eea4204ba5a0cd63532209933d5fa784ae4d20a71943a0a5021717e31c642755`，TAP SHA `a079f10a93aaaee6a879a39ece7eebf7548cdc0b4d8ba4bf2772414f81d3492c`，根已回读实际计数及退出证据。真实视频起点 0/1000 ms、音频均延后 500 ms 的两控制样本保持每单元开头静音，输出 12 秒并从 0 开始；实际非方形像素及 manifest 比例一致。replace 只输出视频并标记需批准配音；not_required 全无轨保持视频-only，混合仅缺轨段静音。模式由保存计划前的真实夹具准备，不改已批准计划/hash。当前 Assembly SHA `6cf70ef6599e71fd169b28f19bfcae1270b29852437f18da7cba47dc0092eb4e`，Runtime SHA `0f4b9c966fcd549ce2d66a27512a47ea92f7be65ef0c2a9bf26b330560e27ef7`；不再新增通用 probeRunner。根已开始旧 Composition/运行链回归，独立 SPEC 正在读盘；双审及后继导出未完成，不关闭 G5。


2026-09-08 根补齐实际时间字段定位（只读，未实施 G5）：`redrawExecutionPlanService.js:121–163` 的 unit 没有另一个 retained_ranges 字段，计划保留段是生成文件局部 `[0, retained_duration_ms)`，尾段长度为 `generated_duration_ms - retained_duration_ms`。每个 parent_shots 交集已有 `source_start_ms/source_end_ms` 及 `unit_start_ms/unit_end_ms`，后两者等于源交集减去 unit.source_start_ms；dialogues 也有同样局部映射，不应再次平移。原正式测试第 74–99 行已有两类复用案例：26 秒源的三单元最后 4 秒 padding，以及句中边界退回后首单元 8 秒保留＋2 秒 padding。G5 应逐单元处理这些计划区间，再按源序组合，不能只做成片全局 -t；计划映射不等于实际生成对白落点证明，裁后仍须验证完整对白/音轨与最终字节。未执行新合成或宣称声音通过。

2026-09-08根核对G4.5实际消费口（`fbfcb5/ae1a56`）：`getExecutionUnitCandidate`经真实probe、prepared末检与原账态绑定返回安全候选；同步`assertApprovedExecutionUnit`复用readState/存储review/原字节与确认账态证明，不能当新执行过FFprobe。G5应消费这些同owner/run/unit证明，在合成前后再次核对当时实际字节与计划；不得仅检查approved标签、复制旧shot审核，或把历史technical_qa冒充本轮媒体探测。该映射只修正计划的复用对象，未实现assembly、未测试原生声音或合成。

已只读确认的实质差距：`audioHash` 仅接受 TTS `dialogue_generation` 与 confirmed 资产，`buildCompositionPlan` 仅允许 replace，FFmpeg concat 为 `v=1:a=0`；下载现有类型只有 MP4/SRT/VTT，报告只是 GET 摘要。新增原生分支必须逐层接通，不能只通过生成时音轨检查就关闭 G5。

2026-09-06 独立源码映射进一步限定原生证据：`redraw-native-audio-validation-v1` 的 `artifact_sha256` 是完整 MP4 hash，`validation_hash` 是紧凑验证对象 hash，不是音频文件 hash；Worker 实际检查第一音轨前 15 秒，临时 WAV hash 未进入输出。紧凑对象也未保留 approvedText hash/locale pack/invocation，`detected_locale` 固定 null、`locale_verified` 为 false。因此既有语言证据不能冒称 en-US 地区发音、长父镜全音轨已验，不能给旧对象补当前文字 hash 就宣称验证时已绑定。G5 实施时须从真实已有调用/候选快照找到可核验绑定；没有的明确待重新校验，不伪造原验证事实。多个已审核短单元须保存各自原音验证覆盖与顺序，再形成绑定新父镜实际文件 hash 的组合证据，不能沿用单个单元的 validation hash。

候选 `dependency_hash` 当前不含 draft/native evidence；必须用正式反例证明并精准绑定新增 native 分支，旧 TTS 哈希与 exact-key v1 合同不随意变更。Composition 在入口、pending manifest、执行前后重算和 final manifest 均硬编码 replace；HTTP compose/release/blocker 和剪映 audio asset IDs 投影也是直接消费者，不能只改 FFmpeg。现有 probe/concat 还把 SAR 设为 1，未绑定源 SAR/DAR；G5 需要实际原生/混合音源、子单元归并、显示比例与下载报告的真实本地媒体回归。这些是源码定位，不是新通过证据，不改模型或引入新供应商。

G5 显示比例已取得实际产品反例，尚未修复：隔离 `:memory:`、两段新造 160×288 / SAR81:80 / DAR9:16 视频，经当前 `createComposition→runComposition` 的默认 FFmpeg runner 和默认输出 probe，成片仍 160×288，但变为 SAR1:1 / DAR5:9；服务状态仍 `completed`。探针最后保留 DAR 断言 native 1，产品命令本身 native 0，故不能把合成状态成功当构图验收。根独立再次 ffprobe/hash 核实同一输出。receipt `.codex-staging/g5-composition-geometry-probe-20260906-r1-AZkXT7/receipt.json` SHA `5bc5b8ebaa1a27661b8c110850ae6e6bf386ff7ca35a90b03800f6f18689a705`，输出 SHA `fa3af065b2e87d44bf5e81d897b117ca78bd9c1cc5a9a1ed761af82b2ca2c79e`。服务 SHA `a1f1b18d6c11fdef0d132a7cb7e497a6a2730a1223b5cb31d0ae6e1d3d465cb7` 与正式测试 SHA `b37ebf2f63424ea1b078ad5a2b15fabbd2e98b2f3d81fbf379ec886ac725fd7c` 出入不变。输入 verifier 为真实 FFprobe 注入，批准/TTS 账态为正式测试夹具、替换音轨为正弦音；不冒称真实供应商、原生声音或内容质量验证。

**G5.1a 已有合成比例缺陷的最小修复包（独立于新增原生音轨，待前包收口后实施）：** 只改 composition service 与原正式测试；保留现有 generation artifact verifier，不改共享返回合同或已保存的 request/input/release hash。运行CAS为processing后、已有try内、创建输出目录前，从同一批准video字节额外读取真实W/H、SAR/DAR及显示旋转，前后hash与plan输入及release候选hash核对。几何期望只保留为本次运行局部变量，供FFmpeg及最终probe比较，不加入旧timeline/manifest/hash payload。默认同宽高输入仍需同SAR/DAR/无旋转；未知、矛盾或不兼容的几何明确failed，不能默默改成1:1、裁切或按首段适配。此包只修已承诺的保持比例，不声称旋转/异构素材适配已完成，也不修写历史completed产物。保持几何的适配策略仍属后续G5范围。

- [x] 正式实际RED→GREEN保留160×288/SAR81:80/DAR9:16两段案例，真实输入verifier、FFmpeg与默认输出probe，不继承旧ctx的artifactVerifier mock；旧方形像素TTS/SRT/VTT及三资产完成保持。
- [x] 真实输出被故意生成SAR1:1时，即使W/H及时长一致也必须OUTPUT_INVALID，export failed且无新增成片资产/版本完成；同W/H异SAR、无可信几何及非零旋转分别拒绝，不以缺字段fallback让旧mock过关。
- [x] 用不对称边框/四角图案检查输出代表帧，几何通过与实际无裁边证据分开；旧pending manifest形状/hash计算保持、旧completed原样。增加的门禁在run才拒绝而非create同步拒绝，复用现有failed收口，不改生成账态。SPEC→QUALITY后只关闭该几何缺陷。

2026-09-07 G5.1a 本地退出：最终 service SHA `4e74d2d23263bdb7574e2bd0c0fbdf81f03a8939345ddffa472c65b0e8e7a5cc`、test SHA `8b22d194ce1cacf73d9c66bc163af239deaed5237feea1ec8ec80433f62b870e`。作者/根/QUALITY 各自26/26 native0，重叠不累加；根 r2 真实输出160×288/SAR81:80/DAR9:16/3秒/有音轨，代表帧46,080像素分类与2,652边缘点均匹配，后续蓝帧顺序正确。SPEC 曾实测发现 probe 后换成坏字节仍发布的 P2；最终 hash 直接绑定已验证字节，并在最后输入复核后再次校验，原反例现在 OUTPUT_INVALID、0新资产、native0，SPEC r2 PASS（另5/5）。QUALITY APPROVE（另14/14服务边界），报告 SHA `084c42203e41ffebbbe05b622acb1bbf2618ccce8056582a1e77955aeddcdf2d`，回执 SHA `76095de424b42bf8c32fcb6c833b0c8330824eab8ef73f0cb11888801f2fbc5d`；根亲读报告/日志及源 hash。旧失败保留；不承诺任意外部 OS 写入原子性、任意画面无裁切、真实对白、原生音轨或完整 G5 验收。

- [ ] 父镜含多个子单元的真实媒体 RED，断言合并顺序、源区间和完整对白不丢失、不重复；只消费同项目同运行已通过审核的输出。
- [ ] 在 release/composition/export 增加显式原生音轨证据分支，保留已批准配音分支，不伪造 voice/TTS 资产或扣费。无声/音乐/对白使用各自正确合同。
- [ ] 合成异常后重开仅复用现有片段继续本地编码，不生成新供应商任务；源/输出/SAR/DAR/时间线 hash 校验失败不能发布。
- [ ] 普通页面播放并下载 MP4、字幕、报告；实际读取下载字节，核对发布 hash、音轨、镜头序列、时长、无句中硬裁。双审后关闭 G5。

**G5.3 已审核单元接入现有发布外壳：第一包只读 release（承接 G5.2 双审，不提前做 composition）。** 精确责任仅 `redrawEpisodeReleaseService.js` 与新 `backend-node/test/redrawExecutionUnitRelease.test.js`；原 `redrawEpisodeRelease.test.js` 不改，现有 Subtitle 模块只复用。根已按当前 manifest 的精确 protectedPaths 核对这两路径无命中，不因此扩大其他文件权限。G5.2 四套相邻回归均已终态且完成双审，新测试 24,734 字节、SHA `63cda634b8086209f70d0820f7afdcb6551879c482e5b40856f799e99ce7a78e` 经根全文审读后，仅放行固定本地正式 RED；取得目标失败终态再实施。旧 service/test 原字节保留于 `.codex-staging/g5-unit-release-baseline-61eca7f503ef4068a5a4379eb4aa605d`，不覆盖旧证据。

- 复用 `buildEpisodeRelease`，以精确五键请求 `{schema_version:'redraw-execution-unit-release-v1',version_id,run_id,expected_plan_hash,expected_run_revision}` 进入新分支；含 run 字段却缺/错 schema 必须拒绝，不降级旧 shot 链。旧 v1 输入及校验/规范 hash 算法不变，新 manifest 使用独立精确形状校验。客户端不能传单元清单、候选文件、音轨、字幕、Key 或 assembly manifest。
- 从服务端同 owner、当前完整 approved run 逐项调用 `prepareApprovedExecutionUnitMedia`，核对顺序、连续完整时间、run/queue/plan/review 绑定及候选/审核摘要。读取 release 不调用 assembly，不创建发布文件、任务、资产或业务写入；允许既有核验器内的私有源/动作临时快照，继续按原 finally 清理，不能误称整个依赖链零文件写入或为此绕过核验器。核验受保护输入流与字节 SHA，全部 await 后同步再验源/批准/版本 locale/market 绑定；所有出口 finally 关闭自己取得的句柄，不删除原候选。不得复制第二套候选验证器或伪造旧 video_generation/review ID。
- 字幕复用 `buildSubtitles`，从已核验 pack 取 `target_text`，保留原全文；绝对时间是累计 retained 起点加 unit 局部毫秒。校验唯一 ID、局部越界、持续时间、完整顺序及真实 version locale，不默认 en-US、不削弱既有阅读速度/重叠/长度约束。计划字幕时标不是实际生成对白对齐证据。
- native/not_required 只表示批准输入可进入后续合成；质量摘要必须明确成片仍待人工检查。replace 保留原 mode 并显式 `approved_dub_required`，批准配音尚未接入时 composition readiness 必须 blocked，不冒称最终声音就绪、不伪造 TTS 资产。报告仅安全业务摘要，不含本地路径、请求连接或私人 prompt。
- 正式 TDD 用实际 dispatch→candidate→review fixture，复用已存在的两个合成单元，不导入 test 文件。先证明原函数不接受完整 unit 链，再测稳定重复读取/零 DML/零合成、字幕与语言、owner/CAS/账态/候选字节/版本漂移、非法字段/旧 schema 回归和 replace 阻断。固定隔离入口根审读后运行，作者冻结再 SPEC→QUALITY；本包通过后才接 create/run/export 的 schema 分支，后者继续保留原幂等/任务 CAS/原子资产提交/重启未知状态和最终成片人审，不能把只读 release 完成写成已可下载。

**G5.4 单元合成与四文件产物连接（只读 release 双审后接续，本地）。** 新唯一作者先新增 `backend-node/test/redrawExecutionUnitComposition.test.js`，真实本地 dispatch/候选/人工结论夹具到两单元 FFmpeg 输出；生成与内容人审为显式合成证据，不代表供应商或真实语言已验。产品责任为 `redrawCompositionService.js`、`redrawExportService.js`，以及 Assembly 下述唯一同步消费扩展。原 v1、模型、账本、Run 和路线不借机重写。根全文审读新测试/固定隔离入口后才 RED。

- 严格新创建请求六键 `{schema_version:'redraw-execution-unit-composition-v1',version_id,run_id,expected_plan_hash,expected_run_revision,idempotency_key}`；计划入口前五键。旧 camelCase/v1 原样。含单元字段缺/错 schema 拒绝；客户端不能传清单、字幕、音轨、文件或 release。服务端从当前批准计划取音频模式。
- 复用 `redraw_exports` owner、幂等、版本号、同版本活动互斥。unit run 先以 owner/status CAS 进入 processing，随后输入检查失败明确 failed，避免永留 pending；completed 不重复编码，processing/needs_attention 不自动重跑，显式新幂等键只复用现有片段重新本地编码，不生成供应商任务。
- 真实 Assembly 保留段视频及本次 release 字幕写到唯一 export 工作区；原子登记 MP4/SRT/VTT/白名单 JSON report 四资产和本 export，report 自 SHA 置于外层，不自引用。保留输入 hash、实际音轨/时长/SAR/DAR、单元映射和 final_media_review=pending；不伪造旧 shot included，不把 work/version 标为用户验收完成。失败只清本次未发布工作区，保留所有原候选与历史导出。
- Assembly 当前总断言虽然全同步却声明 async。唯一兼容扩展是共享原检查体的同步内部出口，旧 async 方法继续包装同函数保持拒绝语义；新完成事务使用同步出口，不能不 await Promise 冒充同步拒绝。源 lease 已在旧核验器返回前关闭，故另对原源 asset 身份/路径/真实源字节做一次同步末检；不重复 prepare 全部候选、不复制候选验证算法。末次异步之后的批准/源/候选/四输出漂移与完成 CAS 失败须有真实文件/SQLite 反例并原子回滚。
- Export 可新增明确 unit 受保护读入口，重建精确原 run release，核 owner、四资产/元数据、真实 bytes，返回安全 stream/cleanup 而非裸路径。旧 v1 descriptor 原样；旧 HTTP handler 未桥接时 unit 下载显式受阻，不返回假 ready 链接，也不留下无人关闭的 FD。服务流检查不等于当前 HTTP 已安全消费。
- 首包 native/not_required 用各自正确轨道合同，replace 在批准配音接通前明确阻断，不伪造 TTS；完整 G5 仍须后继批准配音、最终成片人审、严格 HTTP 和普通页面连接、报告/字幕真实下载、同项目恢复及浏览器验收。页面需绑定本次 export 而非最新/首个完成行，字幕开关必须真正加载 track，迟到 Blob/卸载须撤销 URL。旧 release/Composition/Export 与新单元回归和非作者 SPEC→QUALITY 都是退出条件。

**G5.4 本地退出（2026-09-09）：** 非作者 `g5_unit_composition_spec` SPEC PASS，另一非作者 `g5_unit_composition_quality` APPROVE，P1/P2=0；最终根 22/22 包括末次 await 后批准、源、候选、四输出漂移及真实 `RAISE(IGNORE)` 完成 CAS 零写入反例。选定 42 源无漂移，原生进程已退出，0 skip/cancel/todo/timeout/收集错误。r3 13 项与 r4 22 项是不同测试版本，不重复相加；旧 Export/直接路由 19 项不是 HTTP 证据，旧 Run/Candidate 31 项也不能冒称导出 HTTP。历史失败和原候选不改写；四文件服务层可读不等于普通页面已可下载。

**G5.5a 既有四文件产物的真实 HTTP 消费（已本地双审收口，不扩展模型或生产范围）：**

2026-09-09 修复证据更新：29/13/16 首轮回归保留；随后精准诊断 39/14/25、native 1（receipt `e192f24425529858524b577f30af91d488c63f89568b0a87054c906d9aff990c`，TAP `78c4b0dda3e07440ff434940557ceca3f70402169e1ab574c091126abeb9ef5a`），真实 Release builder 对同一输入在 HTTP context 下报 INPUT_DRIFT、补已有 `canReadArtifact` 后原 hash 一致；9 个跨 owner / 错租户缺 membership 反例各有实际 DML +1。仅补 unit context 与内部 schema 分流，四 G5 服务未改；分类包含软删元数据，但业务读取仍拒绝软删记录。新软删反例为同根缺陷补充，不声称另有独立 RED。修复后 40/36/4、native 1（receipt `2687271801ef326a50da67cdb3f040888a6e429e6a8836356d40774456cd7c4b`，TAP `00bbcac25eabb2bac0f30ea45b7c68acde3eeae2bbc1849bb00e26c891c8ce31`）；3 子例失败＋母项：VTT/JSON 合法 UTF-8 charset 被测试字面比较误拒绝、client abort 错把内层 physical stream 的立即 destroy 当公开流合同。先纠正测试观察对象并保留完整媒体/FD 安全断言，再最终 GREEN；不修改 Express 的合法响应或冻结服务来迎合错误断言。

2026-09-09 正式 HTTP RED 已运行一次：同 owner/实际 JWT、默认 router、真实两单元合成后 28 项中 2 pass/26 fail、native 1，耗时 100.228 秒；76 选定输入稳定，原始日志完整，0 skip/cancel/todo/timeout/收集错误，PID 27820 已退出。目录 `g55-unit-export-http-local-20260909-r1-http-root-unit-export-http-red-506f90e1dbb646a59f818776edf7b55a`；receipt `dff85b4a41c80acb6dc7aa90da82dcf0025170b0d86a80d69cd8931155056977`、TAP `ee5d3a0a2f0c7a462de78188c80cfd9d1802d8b59ba148c35928ce4f2bee42eb`。失败已到达 DTO 缺 unit 身份、旧下载 409、成员重建和未接受保护流等实际断言，不能把其中尚未到达的流内故障当独立已复现漏洞。根已放行唯一作者修改两 route 小段；最终 GREEN 前补旧 v1 真 HTTP 对照。为节省重复媒体运行，本包 RED/GREEN 均由根执行，作者据同一原始终态修复/冻结，不冒称重复独立跑同套件。

对应五锁仅追加本次本地授权，旧字段和历史断言完整保留；授权测试 RED 47/6/41 → GREEN 47/47、native 0，非作者 SPEC PASS→QUALITY APPROVE。根收口 `g55-feature-verification-20260909-r1.json` SHA `559c0f33b749b51e9a4cb109457c928d3d54ba458014e10c5214e80904adef27`，17 引用零漂移。该登记不是 HTTP 功能通过；此前引用旧功能清单的 G3 证明保留其当时源码，不再声称旧清单仍与本次追加后的字节相同。

- [x] 唯一产品责任是 `backend-node/src/routes/redraw.js` 的 `listVersionExports/getExport/downloadExport` 及安全 DTO 小段、`backend-node/src/routes/index.js` 的相应 GET 只读权限复核。先只接读取；compose/release POST、前端、已批准配音留原后继顺序，不混入同包。G3 列表及已冻结四个合成服务不改。
- [x] 新增 `backend-node/test/redrawExecutionUnitExportHttp.test.js`。同一个合成 fixture 的 SQLite/owner 加真实 `setupRouter`、`issueToken` 和自建 `127.0.0.1:0`；不得组合不同数据库夹具、注入最终 handler/鉴权结果、导入测试文件或跳过真实 FFmpeg。一次真实两单元合成复用多项读取检查。作者先交测试，根全文审读现有隔离入口的最小派生后正式 RED；正式目标失败后才改产品。
- [x] 只按服务端完整 manifest 的 unit schema 分支调用 `prepareExecutionUnitExportArtifact(ctx, { exportId, kind })`；非法/缺失 unit schema 不降级旧路径。复用现有用户/tokenVersion/tenant/member 同步读权限回查，未授权保持安全 401/404，不包装为 500。旧 v1 读取和 DTO 原样。
- [x] 对同一受保护 stream 先 `const first = await iterator.next()`，复查 abort/权限后才发送成功 headers，再送首块和同一 iterator 的其余字节；不能重新开路径、创建第二条流或遗失首块。合法空 SRT 是 `done: true`、200/Content-Length 0。流失败前 headers 用安全 JSON，headers 后 destroy；沿候选媒体既有 finally，destroy 后 `await finished(stream, { cleanup: true })` 再唯一 cleanup，不能提早关闭正在 read 的借用 FD。
- [x] 安全 DTO 验证原 release/hash 再投影当前 export 的 run/plan/release、真实音频模式和四资产 ID/hash；report URL 指向不可变 report 文件，不把旧业务摘要当下载字节。保留 `final_media_review: pending` 与 `dialogue_alignment: not_verified`，不伪造旧 shot/video_generation ID 或对删减 DTO 声称原 hash。
- [x] 正反例覆盖四文件真实 headers/下载 SHA、合法空字幕、跨 owner/tenant、非法 kind/body、非完成状态、run/review/源/候选/输出漂移、token/member 失效、abort/慢 read 与 FD cleanup；同源旧接口回归、根独立验证、非作者 SPEC→QUALITY 后才关闭本 HTTP 子包。不得写成浏览器或最终听看验收。

**G5.5b 后继最小接线：由产品 API 创建单元合成（须先取得 G5.5a 最终审查回执）：**

- 复用 `POST /redraw/versions/:id/compose`，仅为已批准的 unit service 六键合同加薄桥接。HTTP body 严格为 `schema_version/run_id/expected_plan_hash/expected_run_revision/idempotency_key` 五键，版本只能取已鉴权的 URL 对象，组为服务 `version_id`；unit schema 必须为 `redraw-execution-unit-composition-v1`。出现 unit 标记但缺/错 schema 不回退旧请求；客户端不得覆盖 owner/version/audio mode/units/release/资产或路径。旧二键 `idempotency_key/audio_mode` 请求保持。
- 直接复用 router 已持有的 `canReadArtifact` 到 unit composition context；禁止恒真验证器或另抄 capability 检查。复用实际 `createComposition` 与现有 scheduler，仅 `created === true` 才调度。实际 `runComposition` 保留 pending→processing CAS；同 key 重放及 processing/failed/needs_attention/completed 不重调度、不生成视频；配音缺口继续明确阻断。
- unit 分支精确区分形状 400、不可见身份 404、绑定/批准/配音及幂等冲突 409、未知内部错误安全 500，不整体改变旧 v1 错误语义。unit POST 的权限复核须避免失效 membership 被旧 initializer 恢复；这只限该分支，不更换全局鉴权。
- 真 JWT/隔离 SQLite/默认 router，从已有已批准 unit run 通过真实 HTTP 创建本地合成，不能使用先直接完成合成的 fixture 冒充 POST。native 与 not_required 实际 FFmpeg、202→completed→四文件 GET；验证真实音轨或无声、空 SRT、时长与 SHA，最终人审仍 pending。低层供应商与人审夹具明确标为 synthetic，POST 阶段供应商调用计数不增加。
- TDD 覆盖严格五键、跨 owner/tenant/run、旧 revision/plan、未批准及 replace、同 key 双击/异请求冲突、已有活动任务、未知/失败终态重放不调度，以及 scheduler 失败和合成前绑定漂移；实际失败不发布输出，原候选保留。原 v1 compose 回归后非作者 SPEC→QUALITY。外层 API 透传函数无需改。
- 本包不修改 release/readiness 的另一条创建通路，不同时改页面。下一页面包再接 run/plan/revision、当前 export 精确选择与四文件下载；实际浏览器和真实质量验收保持未完成。执行前仍须补相应本地特性锁授权，不进行 Git/CI/生产/供应商操作。

- [x] G5.5b 本地退出：真实 POST→默认 scheduler→FFmpeg→四文件 GET，完整 76/76 与旧 40/40、19/19；独立 SPEC PASS→QUALITY APPROVE。仅关闭接口子包，页面、真实内容和整个 G5 未完成；当前证据见本文首段。

**G5.5c 页面恢复前的只读提交身份补线（G5.5b 最终双审后执行）：**

2026-09-09 只读映射发现：现有 unit DTO 的 `request_hash` 来自不含幂等键的五键 release 请求；相同 run/plan/revision、不同幂等键的合法导出可具有相同请求 hash。仅按第一条/最新一条或 run 匹配，不能精确结清回包丢失的原提交。采用既有列表/详情增加幂等键摘要；不采用 POST 重放来查询未知，也不新增查询路由、表或另一套任务服务。该补线落实已有“未知状态保留、显式 GET 定向核对”的设计，不代表页面或未知恢复已经完成。

投影固定语义：仅 `export_type='video'` 且 unit 合同合格的记录具有 64 位小写指纹，非法固定 `null`；旧 v1 不新增该字段。指纹在完成状态提前返回前计算，因此 pending/processing/failed/needs_attention/completed 一致。相同 key 跨 owner/version 指纹相同是预期，不可据此跨作用域匹配；同 key 不同 revision/run/plan 则由原 request_hash 区分。测试文件内最小真实 JWT/SQLite/router 查询夹具复用已有 `runMigrationsAndEnsure` 和 auth 方法，参考旧直接路由测试的最小插入列但不 import 测试文件；不需要运行媒体制作，也不得以 synthetic completed 查询行声称真实合成或下载通过。

G5.5c 开工范围复核：本包仅改 `routes/redraw.js`，按现有 `protectedPaths` 精确相等只命中 `redraw.coverage-registration-http-route`、`redraw.product-media-http-chain`、`redraw.episode-blueprint-first` 三项。另两项 admin/provider 锁只保护本包不改的 `index.js`，不得沿用 G5.5b 五项假设扩大登记。独立特性锁作者先测试再追加这三项，本次理由限定只读 DTO 身份字段，另八项及所有历史/规则原样；根负责运行和逆向完整性核对。

- [x] 新作者只负责 `backend-node/src/routes/redraw.js` 的 `executionUnitExportSummary` 只读投影及新 `backend-node/test/redrawExecutionUnitExportIdentityHttp.test.js`；索引、四个合成服务、账态、模型、全局鉴权及旧 v1 DTO 不改。根维护唯一计划/总报告、受控运行入口及必要的本次本地特性锁登记；没有 Git/远程 CI/生产/供应商权限。
- [x] 先用真实 JWT、隔离 SQLite、默认 router 的 GET 列表与详情写 RED。夹具可直接登记待查询的合成记录，必须明确这是 DTO 查询合同测试，不冒充真实合成；原 G5.5b 已有真实 POST→FFmpeg→下载证据继续独立保留。两条相同 request、不同 idempotency key 的记录须得到相同 `request_hash`、不同 `idempotency_key_sha256`；同一记录跨 GET 与各状态须稳定，原始 key 不返回，查询前后 DML/资产/调度计数不增加。
- [x] 最小实现只追加 `idempotency_key_sha256`：验证 stored unit schema、原请求精确五键和各字段类型/边界、请求 version 与 owner-scoped row 版本一致、原 `request_hash` 与规范字节一致，以及 stored key 满足已有非空/不 trim/不含控制字符/最多 200 字符合同；成功时 `crypto.createHash('sha256').update(manifest.idempotency_key, 'utf8').digest('hex')`，不合格时无可用指纹。平面请求仅复用当前五个 primitive 字段的键排序，不新增通用序列化框架；原 `request_hash` 的含义不改变。身份指纹只说明原提交匹配，不说明成片或内容合格。
- [x] RED 至少包含缺/错 key、缺/多/类型错误的 stored request、错误请求 hash/version、同请求不同 key、同 key 跨版本/owner、软删除与失效成员、旧 v1 无新增字段。产品修复后新查询回归和旧导出回归必须真实通过、日志/源码绑定清楚，再 SPEC→另一位 QUALITY。若测试发现既存副作用，先保留失败证据再精准诊断，不削弱门禁或批量修复无关代码。
- [ ] 后继 UI 的持久原意图绑定 owner/work/version/run/plan/revision/key 指纹及请求 hash；仅在同作用域 GET 列表恰好命中一条、再经该 export 的详情核对后解除原提交未知。零条/多条/请求不匹配/读取失败保留未知，不发 POST、不选择其他成片。确定匹配只恢复任务身份和状态；完成文件还须既有四文件读取与 hash 核验。

规范字节细化：验证原值时不得使用会归一化字符串数字、空白或大写 hash 的 `reportInteger/reportHash`；使用原创建合同的严格类型与小写 64 hex。指纹资格还须满足 `Buffer.from(key, 'utf8').toString('utf8') === key`，不将未配对 surrogate 的替换字节误作无损身份；原创建服务规则保持。客户端保留原 revision，并由原意图构造 release-v1 五键，以 `expected_plan_hash,expected_run_revision,run_id,schema_version,version_id` 的字典序 `JSON.stringify` 后算 UTF-8 SHA；不能对含 key 的 composition-v1 HTTP body 算 `request_hash`。仅在已鉴权作用域内使用两个摘要定位原请求，不把摘要当 token 或权限证明。既有导出 GET 仅核对 version/export 的 owner/软删，不证明父 work/project 仍有效或 run 仍可执行；本包软删反例限 export/version，UI 另以现有项目/作品刷新证明上下文，四文件下载保留完整父链校验，不能借身份指纹将这些后继门禁算作通过。

G5.5c 本轮 TDD 回执（2026-09-09，本地最终双审通过）：新增纯 GET 查询合同实际 RED 为 159/11/148、native 1，147 个子例均在身份字段为 undefined 处失败，另一个为母项；无基础设施失败。最小产品只增私有 helper 与 DTO 字段（+22 行/+1,797 字节），剥除后精确恢复操作前 route 字节；当前 route SHA `b908933456c3c83f194bd076e9ad4feae85271c85a4eaf2bba88ffbfd739264d`，新 test `50f8b987fbec11082cfbff2aa77864648086c8bb166e2b20b02c31d4b561cc61`。根完整 GREEN 159/159、旧四文件 HTTP 40/40、旧 Export/直接 Composition 路由 19/19 均 native 0；各 81/79/19 选定输入前后和当前无漂移、无跳过/超时/收集错误、进程退出。回执 SHA 分别 `d17f541ecf64486e8a07b5a0edd133d25d5192bb78b33f3e1012a556f30aee90`、`8a1585993210e3ace0e065fc8cbd4e3ffc11f195f1a58a7db7afae4122041795`、`805de9cbbb22d773ac093ebf974f0565d5e3fc4c28acc79cc8b086e9e4cbde84`。独立 SPEC PASS 后另一位 QUALITY APPROVE，根封口证据 SHA `c1a3e8359a2177dd5da98a4d1f91c9683ac7ea95d2e8e8692b6300025ad731b8`；只关闭只读身份后端子项，后继 UI 仍未完成；三项特性锁登记已 49/49 且独立双审完成，原 48 断言与全清单历史逆向完整保留。上述是查询身份与已有导出技术证据，不证明 UI unknown、父项目上下文、真实语言/角色、浏览器或整产品完成。

**G5.6 页面接线已核实的接口边界（后继实现约束，不记为通过）：** RunPanel 当前没有向上 emit run；实际链为 Workspace→Source→Localization→Plan→Run，且 Source 在进入第四步后卸载。沿当前用户明确选择的 run 做专用最小上下文传递，跨 owner/work/version/policy epoch 立即失效；刷新第四步必须通过既有 GET 重新证明上下文，不能把事件、旧 review 回执或 localStorage 当授权。现有 parent renderer 将 Edit stub 掉且禁止 interval，后继测试须加载真实 Edit/Release 并受控驱动轮询，不能复用旧绿灯冒充覆盖。四文件都使用现有 `redrawAPI.downloadExport(exportId, kind)` 的 Blob 字节，报告使用 `kind='report'`，不再把旧摘要 JSON 重新序列化成假报告文件。最终选定 export、迟到 Blob/卸载回收、字幕 track、声音分支和最终人审沿本 G5 原有未完成退出条件逐项验证。

#### G5.6 首片：所选 unit run 到第四步只读核验

2026-09-09 后继只读准备发现实际入口阻断：Workspace 的步骤按钮、goStep 与刷新 clamp 都依赖旧 `work.current_step`，unit review 完成只更新 run、不推进该字段。不能将测试 work 改成 4 掩盖用户被留在第一步。首片在现有页面增加独立 unit 第四步只读入口，不写服务器 current_step，不放宽旧 shot 第 2/3/4 步生成门禁，不提前启用合成、下载或 TTS。G5.5c 后端已收口；首片现已本地双审收口，实际证据见本节回执与本文首段。

- [x] 新作者责任限七个前端运行时文件：`RedrawExecutionRunPanel.vue`、`RedrawExecutionPlanReviewPanel.vue`、`RedrawLocalizationReviewPanel.vue`、`RedrawSourceStep.vue`、`RedrawWorkspace.vue`、`RedrawEditStep.vue`、`RedrawEpisodeReleasePanel.vue`，以及一个新增真实 Vue renderer 测试。根负责唯一文档、固定隔离入口和实际命中的本次本地授权登记；不改 API、后端、全局 store、模型或播放下载组件。保留已收口 G6 默认租户证明及其原回归。
- [x] RunPanel 增加明确“查看此执行记录的导出准备”操作：复用当前选择与 context/checkedRun/GET ticket，点击后重读这个精确 run；审核 POST 回执不能代替新的 run GET。通过三个中间组件只转发专用选择事件，Workspace 持有选择 intent。Source 因进入第四步卸载不丢弃选择，但不把来源曾验证的状态当第四步授权。
- [x] 使用原 project/work 路由和 `step=4,unit_run,unit_version,unit_plan,unit_revision` query 保存定位提示，不存 Key、不新建 store。重新挂载先由 Workspace GET 项目/作品，然后 unit 面板通过既有 localization→plan review/queue→runs→精确 run detail GET 复核完整 owner/version/queue/review/plan/unit 绑定和原 revision。无 intent、零条、多条、历史/stale、错摘要或读取失败都保持未核验；不选 first/latest、不默默升级 revision。只有重读成功才显示所选 run/修订/真实计划音频模式和缺口，未匹配时不显示“可合成”或成片。
- [x] unit 模式下 Edit/Release 不运行旧 quoteDialogue、首条 loadExports、replace compose 或旧 release/readiness 初始化；intent 失效仍保持 unit 阻断界面，不回退旧流程。owner/work/version、访问或策略 epoch/ABA/卸载同步撤销已核验资格，丢弃迟到响应；所有执行、合成、下载、TTS 端口保持零调用。
- [x] 新 renderer 加载真实 Edit/Release，不沿用旧 Parent 的 Edit stub；独立受控 timer，不改旧 Parent 禁止 interval 的断言。正式 RED 至少覆盖 current_step=1 真实点击非首条 run→Source 卸载→新 GET 后第四步显示、同 URL 刷新只恢复提示、审核后新 revision GET、无 intent/错绑定/迟到/owner-work-version-policy ABA、native/not_required/replace 缺口及执行／合成／下载／TTS 零调用。专门审核交接用例允许通过真实审核按钮调用一次本地受控 review API 替身以改变 revision，不将其记为所有 POST 为零；不发实际 HTTP。根 GREEN、原 Source/Parent/Run/G6 回归、独立 SPEC→不同 QUALITY 后才关闭首片；renderer 不是浏览器验收。

首片只让普通用户进入并重新核验第四步的所选运行。后继切片仍须接真实 unit compose intent、G5.5c 双摘要未知恢复与四文件 Blob/字幕/听看，不将本只读入口或单个 fixture 算作 G5.6/产品完整交付。

G5.6 首片登记回执（2026-09-09）：七 SFC 仅命中 `redraw.episode-blueprint-first` 的三条既有保护路径；单锁追加本次窄授权，其余十锁不改。正式登记 RED 50/6/44 后 GREEN 50/50、native 0，原 49 断言及全清单可逆还原；独立 SPEC PASS → 不同 QUALITY APPROVE。根证据 `.codex-staging/g56-feature-verification-20260909-r1.json` SHA `9e10a23b8fbe091f74fb7f25ed2aee271df61ea5679a26b5215cb9901c4a6112`。这是范围登记而非 UI 完成。新 renderer 前置审查要求补闲置已核验态的同步撤销、严格 GET 身份实参、实际 review/音频语义夹具；尚待真实产品 RED。r1 入口在 Node 启动前因旧 G4 fixture pin 阻断，已对照完成的 G3 收口核定三项合法变化；保留 r1，r2 只更新已证实的固定引用，不修改旧测试或放宽读取权限，不把预检错误计作业务 RED。

首片最终回执（2026-09-09）：前置三项测试补齐后首次真实 RED 88/0/88；入口实现 88/88。独立 SPEC 发现“上传新作品”携带旧 intent 的真实回归，追加唯一按钮反例 RED 89/88/1，只有 Workspace selectWork 精准清除四 query/mode/intent 后 GREEN 89/89；旧 88 原样保留。最终 Workspace 28/28、Parent 56/56、ProjectWorks 19/19，其他五项未触及其实际读取源的回归保留并重新核对；全部 native 0、无跳过/超时/输入漂移、输出完整、进程退出。SPEC PASS→另一位 QUALITY APPROVE；根封口 SHA `1a6f11289dd34714278b92820485e20081047e5b0eecfd019f2e89ec266610ed`，67 唯一引用复算零漂移。最终七源摘要 `ed3e6258a6e53826ae49677f335d0f4eb3f57643da0793bd62bd1b08fdcdf10d`。只关闭本只读入口；以下第二片仍未实施，不把本地 renderer 计作实际浏览器或成片。

#### G5.6 第二片：一次合成提交与原请求只读恢复

延续已批准的页面闭环，不新增模型、API、数据库或任务平台。首片最终双审前仅准备新测试；双审收口后才解锁本片运行时。新作者只负责 `RedrawEpisodeReleasePanel.vue` 的 unit 分支及独立 `redrawUnitCompositionRuntime.test.js`，旧七 SFC 上下文测试与其余产品文件保持冻结。根维护原始源码基线、隔离入口、唯一计划和证据。

- [x] 使用真实 Release renderer 和已有五项 GET 证明当前选择；只有当前 run 完成、全部单元 approved 且规划为 native / not_required 时提供明确的一次合成按钮。replace 明示 approved dub 缺口，零 TTS / compose。按钮可用不等于最终质量通过；后端仍执行完整批准与 CAS 校验。
- [x] 点击先同步上锁，在既有 sessionStorage 的独立 owner/project/work/version 作用域保存原 run/plan/revision 和新幂等键，再发唯一 `composeVersion(versionId, body)`；body 精确为 `schema_version,run_id,expected_plan_hash,expected_run_revision,idempotency_key`，不传模型、价格、audio_mode、version 或额外选项。存储不可用、原意图损坏或已有意图则零 POST；双击、重挂载、失败/未知不自动换 key 或重提。存储只是原意图，不是权限或成功证明；当前上下文失效即清可见证据，保留原意图以便原作用域核对。
- [x] 持久意图的 `request_hash` 以 release-v1 原请求五键 `expected_plan_hash,expected_run_revision,run_id,schema_version,version_id` 的此顺序 JSON UTF-8 字节计算；幂等键摘要单独对原 key UTF-8 计算，不 trim、不用 composition body、不把未配对 surrogate 当合法身份。POST 回包即使有 export_id 也只定位，不记 completed 可下载。
- [x] 明确的“只读核对原合成”按钮：原 owner/work/version 上下文重新有效后，既有列表按 version/schema/video/run/plan/request_hash/key_sha256 精确匹配；恰好一条再 GET 该 export 详情重复核对，已知回执 export_id 也须相同。零条、多条、摘要缺失/错误、读取失败保留未知；不得选首条/最新或补发 POST。pending/processing/completed/failed/needs_attention 分开显示且不自动轮询/重试。完成只表示已恢复技术任务状态，四文件还未核验。
- [x] 正式 RED→GREEN 包含真实点击、精确请求、存储失败、双击、回包丢失、重挂载、同 request 不同 key / 同 key 不同 revision、零/一/多匹配、详情错绑、已知 id 不同、各终态、owner/version/策略 ABA 与迟到响应；记录所有 API double 调用，即使产品捕获异常也不得吞掉未许可动作。保留首片 89 项及实际受影响相邻回归，独立 SPEC→不同 QUALITY 后才关闭本片。全部 HTTP/供应商/付费为零；不把 renderer 记为真实浏览器。

第二片实际 RED（2026-09-09）：根固定入口执行新 renderer 88 项，8 pass / 80 fail、native 1；80 个失败均止于实际合成按钮不存在，是共同入口缺失，不计作 80 类独立缺陷。加载/防护/基础设施无失败，无跳过/超时，输入未变、完整 TAP/stderr、自有进程已退出。原始目录 `.codex-staging/g56-unit-composition-ui-20260909-r1-root-compose-red-0b0e1c46e89d4dc780ac4db6d99db4bf`，receipt SHA `4bad7d55e78d2b6fa9e38b26ff5b764bdf0ad6f6fb262e863829d94b6c3b7f2b`，TAP SHA `aa42d836e90e341711cc53db7d341b7cb2b6bfdd74579aff9e5277110f76b3cc`。只解锁 Release 的本片实现，新 88 与旧 89 测试冻结；尚未 GREEN 或双审，不记第二片完成。

第二片最终回执（2026-09-09）：上段为首次 RED 历史，之后原 88 全文已保留，再补原作用域语义值、同作用域改选 run 与已知 ID 正常重挂载两例，形成 90/90。SPEC 的回执二次保存失败反例真实 RED 92/90/2；仅增加按 scope＋原双摘要隔离的组件内已知 ID 约束后，根最终 92/92（receipt `45a58d834620b7b93352ad7240e4149d46da44dc9482df97f416c9ac25bf93aa`）、原 89/89（`a885ba8986a6b285010db025be22561bc7f01b0ec0587362d813054330aff07c`）均通过。源码 `e6fbea2bec10d10c72000c3b089fb51a3d40f17973cd64808177d0c76718ffc4`，测试 `26b6e9227238a51ae261b2b5458068dbc211edaea550827ab769d2c063a241fd`，七源摘要 `30779d246f22b51c939ee3bf058878f45768e0afdaa4b32ecf37e9f140305223`。SPEC PASS 后独立 QUALITY APPROVE；封口与限制见本文首段。已保存 ID 的跨重挂载有测试；保存失败仅保障当前实例，销毁后不能恢复未落盘 ID，不承诺任意 known-ID 场景均持久化，也不将后端未删除记录幂等保护称为全历史唯一约束。旧 v1 功能函数与基线不变，四文件与实际浏览器仍未验证。

紧接第三片才接 MP4/SRT/VTT/report 四个真实 Blob、逐文件 SHA 与报告身份复核、受控播放器/字幕和 URL 回收；报告必须来自 downloadExport 的原字节，空 SRT 在 not_required 合法。旧 PlayerCompare 的字幕/配音开关仅为本地布尔值，且默认取首条 export、存在迟到 Blob 无代次保护，不能直接用于 unit 分支；继续隔离旧链，后继仅将精确核验后的 MP4/VTT 交给单元播放器并由创建者统一回收，未核验前不挂载 video，保留首片零媒体断言。更后的 approved-dub、普通浏览器、多输入、真实语言/角色与最终人审仍保留未完成，不以本片提交或恢复绿灯替代。

#### G5.6 第三片：精确合成产物的四文件、播放与下载

延续本 G5 已批准的完整页面闭环。第二片双审收口前只允许准备独立测试，不修改其冻结运行时。采用 Release 的 unit 分支内最小受控播放区，不改旧 PlayerCompare/Export 的首条选择或下载行为，不新增组件、API、store 或供应商配置。根维护本节及证据；新测试作者只拥有 `frontweb/test/redrawUnitOutputRuntime.test.js`，不改原提交/上下文测试。

- [x] 仅在原请求已由列表和精确详情核对为 completed 后，显式“核验并加载四文件”；不自动下载、不以 POST 回包或已有 completed 文案直接显示播放器。点击重新 GET 原 export，重核原请求双摘要及已知 ID、completed、当前 owner/project/work/version/run/plan/revision、locale/market/audio_mode 和四种产物的有效 IDs/hashes；不采用详情中的任意下载 URL。
- [x] 使用既有 `downloadExport(exportId, kind)` 顺序读取 mp4/srt/vtt/report 四个 Blob，逐次检查当前请求代次。对实际 `arrayBuffer()` 字节分别计算 SHA；报告以原 UTF-8 JSON 字节读取，不从 DTO 重建。报告 schema/export/version/run/release_hash/input_hash 及 outputs 的三种文件 SHA/bytes 必须与详情和实字节相同；report 自身 hash 对照 DTO，不要求报告自我引用。按真实后端合同核对 media 的 MP4 SHA/bytes、时长/尺寸/音轨声明及音频规划。空 SRT 是合法输出，不将零字节字幕等同于读取失败；VTT 和报告必须可解析，MP4 非空。任一缺失、损坏、非 Blob、GET/hash/解码错误都不发布任何可用产物或自动重试。
- [x] 四文件全部核验后才创建受控 Blob URL 并挂载真实 video controls 与目标 locale 的 VTT subtitles track，显示技术文件已核验、最终人审仍待完成。用实际媒体/track 事件分别显示未加载、可播放、播放/字幕错误；不得将 synthetic loadedmetadata/play 事件、JSON 中音轨标志或模型有声能力当真实听看质量通过。native 与 not_required 清楚区分，replace 仍保留 approved-dub 缺口，不伪造语音。
- [x] 同一已核验产物提供 MP4/SRT/VTT/原报告下载按钮，文件与播放必须绑定相同 export。所有新 URL 由此面板统一持有并在重新核验、owner/work/version/policy/epoch 失效、ABA、卸载时回收；失效先清可见播放器和下载，再丢弃迟到 Blob/hash/媒体事件，不能继续发后续 GET。手动再核验只读取原请求，零 compose/TTS/生成，不改或删除原意图。创建 URL 中途失败须回收已创建部分。
- [x] 真实 Release renderer 的 RED→GREEN 覆盖两个音轨规划、四种文件 hash/读取失败、报告错绑与原字节下载、空 SRT、目标字幕 track、双击和阶段失效/迟到结果/URL 回收；先只用本地真实 Blob 和明确浏览器/API doubles，不声称真实浏览器解码。原第二片合成测试及首片 89 项必须保留，独立 SPEC→不同 QUALITY 后关闭本片。实际 JWT 浏览器、多输入与人审留在 G6，不提前勾选。

第三片实际 RED（2026-09-09）：独立合同预审后，根以固定入口运行 49 项，5 pass / 44 fail、native 1；44 个实际按钮“核验并加载四文件”不存在的共同入口失败，无加载/权限/基础设施失败，无跳过/超时、选定输入未变、日志完整且 PID 69060 已退出。原始目录 `.codex-staging/g56-unit-output-ui-20260909-r1-root-output-red-7ef846e79f434c748de54557e6e4c6e6`；receipt SHA `14ca4a97413823f18eb0f20de2dc83aa9c9f75f08f50faf46bf9fc35ddd302f3`，TAP SHA `aaf4991814a62829e7158db1a0f8bccd0184f648dcf2f9e05c5d2845b8507173`。该次测试 SHA `a73adf4c77a245bde4faf9801df3ac6163950eacc20dc227c31a1283202b9080`。随后补一个合法时长容差与非方形像素正例，当前测试 50 项预期、SHA `2563d6de29fb535eb40dd075323e43ea91c6f1e4f54e5675fc1ff213f89d056b`，不能把 49 项 RED 改称 50 项。仅解锁 Release 第三片实现；旧 92/89 冻结，未 GREEN 或最终双审，不记第三片完成。

第三片首版实际回归与修正（2026-09-09）：50 项实际 40 pass / 10 fail、native 1；目录 `.codex-staging/g56-unit-output-ui-20260909-r1-root-output-green-e905e72c7d2e4d478749cb910d86fcd7`，receipt `ae8689426b82339416caea3490075d1cc6d52a093a1ef59e9923c91cb69b3d31`、TAP `9c04561a84f6e8e2d037599807d7bc3a7d737c69ae5dbcf68fb1a8f170220fd0`。目录/phase 中 Green 只是执行意图，不是通过结论。8 项为真实模板缓存成员事件 wrapper 导致旧节点解引用空状态或污染新代；仅将媒体、track、四个下载事件改为 `v-on` 对象直绑代次闭包。另 2 项经独立只读诊断确认是测试同 tick primitive 父 prop `10→11→10` 被父 render 合批，B 从未送达子组件；改为与旧测试一致的共享 context version ABA，保留全部原撤销断言，并新增两项真正送达顶层 prop B 的可见/迟到报告反例。另补旧下载按钮不能作用于新一代，测试合计 53 项；这不是放宽产品版本失效要求，旧 92/89 完整冻结。

修正后根实际 output 53/53、composition 92/92、context 89/89，全部 native 0、无跳过/超时、输入未变、日志完整、进程已退出。Release SHA `2d8424008b88f58cab6ab243d50eae815f70641a59affe84169158c063f51ce4`，新测试 SHA `36350416ccb2a020e6b2f3e7af9bdd631b0433bf9e9a0b7228779ba0adc29292`；有序七产品 SHA `2f41698f8bf0d527b0a71de86e549daf662da0e3db59962dd9be04f154797b52`。53 项目录 `.codex-staging/g56-unit-output-ui-20260909-r1-root-output-events-green-b8c1cffeb15e4418b4ae653dd46eedb3`，receipt `39192327e47e9cafe1dbde96a17697739d2b7730a2e43a24542855baa77570fb`；92 项目录同前缀 `root-output-compose-regression-8ab0b946e7a74bfa80e68436eda946d4`，receipt `a8f7c531b8777fa0640d084c0d34aa0f6ea91e9eae9dbaea961d7a7ed477ff7f`；89 项目录同前缀 `root-output-context-regression-bc8190ed1fba4b229d4428eefd2afe44`，receipt `e6f9343dcf248664cbc0f0e37c6581bb275a69d6986801e39e15bc9e58eb2d1a`。等待最终 SPEC→不同 QUALITY，不重复未变测试；以上仍是 renderer、合成 Blob 与真实 SHA，未运行普通浏览器解码、真实语言/角色听看或完整交付验收。

第三片规格审查补缺（2026-09-09）：SPEC 拒绝把 UTF-8 与 `WEBVTT` 文件头检查等同于发布前结构可解析。追加 7 个摘要/字节一致但 cue 损坏的真实 renderer 反例，以及实际 serializer 风格数字编号/多行转义文本/CRLF 原字节正例后，正式 RED 为 61/54/7、native 1；目录 `.codex-staging/g56-unit-output-ui-20260909-r1-root-output-vtt-red-15b449c433384ddbab7d8f51310e2d0d`，receipt `f8e9c469b315f8f557481e0a4a77d2524746393814fb8dd9cf684ec3065fda3e`。最小实现只新增 Release 内 `validUnitVtt`，按既有 SubtitleService 输出核验分隔、数字编号/无编号、时间格式与顺序、非空多行正文；保留合法空字幕，不修改 Blob 原字节，不声称通用任意 WebVTT 解析器。根最终 61/61、旧 92/92 和 89/89 全部 native 0、无跳过/超时/漂移、完整日志且进程退出。Release `4383c909885f329f90154a8987f6a9a14ae09ee59a370cc95fdce0794368cc4d`；测试 `11c2b13048abfae1c9f9cbcbbf5fa09e4729560e5e309a38012486ed95184713`；七产品 `b9cd66aa3f7593472994eabbb1c6b9f9b9fb63f2d7ea62c95f0391e5f75114af`。最终目录同前缀 `root-output-vtt-green-20a86159017e4d92b9cb2031b7e8319b`（receipt `e966950f3fa46efcced5ef7583a833a1785e659a817a212578cb97ebf55ada5e`）、`root-output-final-compose-4f36d6b0ad464c318ce6e6d4e41fd99b`（receipt `148e24998b1d1546cf8734ea33207fbbeb1e76938de0c645b8ad219e949bef67`）、`root-output-final-context-0d6d9f9439304b80a53082cd1fd1d158`（receipt `162e88445f108dbb3a4c21900e31c34c897485c3d83d30075b1753c4eee384e6`）。待规格复审与不同质量审查，不以先前 53 项绿灯覆盖这次缺口。

**G5 approved-dub 后继只读映射（尚未形成具体实施规格）。** 现有 production voice 是音色及样音，不是 unit 配音成片清单；旧 `draft_json.dialogue_generation.segments` 的 `completed/confirmed` 只代表生成与原账态，不等同成片人审。unit pack 使用 `blueprint dialogue.id ↔ localization.source_dialogue_id`，旧配音使用 `${shot.id}:${turn_index}`；现有 unit review/release/assembly 没有可信的二者消费映射，不能选同名/首条资产或仅解除 replace 按钮。已批准的后继目标需先明确只读 owner/version/run/plan/对白/全文 hash/角色音色/时间/资产 SHA/原账态/批准来源与失效绑定，再依序 release→composition/export→HTTP/UI；沿用服务端五键 compose 合同，客户端不传资产/路径/音轨，不新建扣费。具体 dub manifest 兼容、独立批准证据及跨镜/环境音策略仍需形成窄规格，不把本次静态映射写成实现或验收。可复用 `approvedCompositionRun(t,'replace')` 及真实隔离 HTTP 夹具；本次零资产读取、TTS、供应商或测试执行。G2 既有语义待确认和 G6 已批小项可独立推进，不擅改支持范围。

2026-09-09 配音绑定设计前复核（仅源码与已存规格，不是新功能已获批准）：

- 视频候选的人审有 `review_hash`、当前用户与 run revision，但 `redrawExecutionUnitReviewService.js` 的 `content_qa.final_audio_review` 对 replace 明确为 `deferred_to_composition`。它不能被复用成配音已批准的证据。`redrawUnitProductionPackService.js` 已绑定 owner、源文件、蓝图、本地化、计划和单元；这些是新配音映射的现成上下文。
- 旧 `redrawDialogueService.js` 产生 segment、`text_hash`、音色快照、音频资产和原 reservation；`redrawEpisodeReleaseService.js` 与 `redrawCompositionService.js` 验证 completed/confirmed、归属、时间和文件，但没有 unit 对白对应的成片音频人审。另有补充对白审批合同明确仅供 voice 样音，禁止用于最终音轨；不得挪用其 `owner_http` 审批。
- 可选方案：A）服务端严格匹配现有同 owner/版本音频，页面显式试听/选择后，用户一次批准本批精确对白—音频清单；匹配不唯一时不猜测。B）完全手工逐句映射再批准，流程明确但操作较多。C）另建 unit 配音生成流水线，成本和实现面更大，不能在当前零供应商范围真实验证。推荐 A，并保留 B 作为有歧义时的人工选择，不另造计费框架；这不是方案批准记录。
- 原生音轨仍是独立路径，不要求其额外制作 TTS。独立配音的批准须绑定全文、角色声线、完整句时间、原音频 SHA 与账态；任何绑定变化须失效。跨镜整句不得剪掉对白或重复播放。环境音沿既有 `preserve_or_rebuild` 合同，不能悄悄用“仅对白”缩减交付，也不能直接混入可能有原语言人声的旧轨。环境声来源与最终成片试听仍须在具体规格中明确；此时不解除 replace 阻断。

第三片最终封口：规格复审 PASS 后，不同质量审查者 APPROVE、P1/P2=0；两位均核对最终 61/92/89 原始终态和源 SHA，未重复运行未变测试。根创建机器证据 `.codex-staging/g56-unit-output-ui-verification-20260909-r1.json`（SHA `715050c87a1870c2cb83cba53790e45d32615efc7cd8406cfee79d9dbb70b7ad`），70 项当前引用复核零漂移，完整保留失败与历史绿灯，五项本地合同关闭。该结论仅限本片；G5 approved-dub、G2 长音轨与 G6 普通浏览器/多输入及整体交付均未关闭。

#### G6 全量验收与移交执行包

**G6 首次登录默认租户入口窄包（2026-09-08，只允许本地 TDD）：** 独立只读映射确认 Login 只存 session；未选择本地 tenant 时，API 不发 `X-Tenant-Id`，服务端正常解析个人租户，但 RunPanel `owner()` 强制本地 tenant 非空，导致合法首次登录不能执行。现有 `GET /redraw/projects/:id` 已按本次请求的实际 tenant/user 鉴权并返回项目 `tenant_id/user_id`；不存在可直接使用的 `/tenants/current`，也不能用列表首项、拼接 ID 或旧 plan binding 代替证明。

- 责任仅 `RedrawExecutionRunPanel.vue` 与一个新 `redrawExecutionRunDefaultTenant.test.js`。缺本地选择且 session/项目上下文合法时，只允许用户显式点原“刷新执行记录”，先读一次现有项目接口；核对返回项目 ID/user/tenant 与当前计划、队列，再允许记录读取及原写门禁。未证明前创建、推进和审核仍禁用。显式租户路径不新增项目 GET；不改全局 auth、API 请求头、store 或五层 props，不写 localStorage。
- 证明绑定当前用户、原始租户选择、项目及访问 epoch；选择取消、账号/项目变化、ABA、卸载与任何失败立即失效，旧响应不得恢复。证明自身入账不能误触发循环读取或被 owner watcher 清掉；旧 pending/unknown、幂等键、只读刷新与单次显式确认原合同保留，失败不自动重试。
- 先真实 Vue 挂载加显式 API doubles 取得 RED，覆盖无选择→显式项目证明→记录/readiness/确认→单次推进、错团队/错用户/迟到/双击/卸载零提交及同用户 token 刷新。原 Source 24/Parent 56 和 Run 生命周期/候选回归保持；测试 doubles 不是实际 HTTP 或首次登录浏览器通过。之后仍须真实隔离登录、空 tenant 选择、无 `X-Tenant-Id` 的默认鉴权浏览器链另验，不提前关闭 G6。
- 根负责固定隔离入口及实际命中的单项功能授权历史；作者不改功能锁或既有冻结夹具。G3 已收口，旧证据保留；本包不接触 G5 作者的后端源或运行入口。

全量后端本地运行的前置隔离核查（尚未实施）：现有package入口虽有 `--test-concurrency=1`，但没有统一测试preload；`loadConfig`先读实际候选YAML再应用DATABASE_PATH等覆盖，不能以环境变量已改就证明未读真实配置。`createApp`还能连接可写DB、迁移及恢复任务。因此在本轮禁止Key/生产数据/外网边界下，不裸跑全套npm test。先落实test-only显式fixture配置、内存/唯一临时DB和外部连接拒绝，覆盖派生测试进程，保留真实loopback、实际迁移/FFmpeg与原测试发现集合；真实配置不可读取时明确失败，不伪造通过。现有逐文件mock只是局部证据，不冒称已有全局隔离。本地该入口修复不改生产配置加载或Hosted CI；全套运行结果仍需另记。

2026-09-08 七个 createApp 测试入口已完成只读逐项映射，尚未执行全套：providerTaskAdminRoutes、redrawAnalysis 及四个 script/storyboard integration 已先写各自合成 YAML 并 chdir，不能误说它们只设 DATABASE_PATH；redrawProviderAdapters 已显式 mock config/DB。风险仍在 require 时固定的候选配置路径、应用启动恢复与后台服务退出。最小后继应保留真正 YAML/迁移/回环语义，在测试入口精确约束自己的配置与存储，并显式停止自己创建的 stopBackgroundServices；不为隔离给生产 createApp 新增通用依赖注入 API。七文件未发现直接子进程调用，但不构成全仓传递依赖或完整安全证明。

审批错误最小合同：当前 `reviewAsset` 在 owner/CAS 后、任何写事务前抛 `REDRAW_CHARACTER_IDENTITY_REQUIRED`，但 review handler 漏配而包装成 500。采用同类“审核前置未就绪”的 **409 + 原业务 code**，这是本轮明确的新专码 HTTP 合同，不声称已有断言。仅映射该精确码；真实隔离 DB/默认 handler 验证缺包、不完整包及 hash 无效均拒绝且 asset/version/work 零写。owner 不匹配仍先 404，旧 CAS 仍 `REDRAW_REVIEW_CONFLICT`，非法 action/缺 CAS 保持 400；有效角色可批准、缺包可拒绝；普通未知异常及未列入白名单的 code 仍 500。最小责任是 review handler、原路由测试和`redrawReferenceArtifactImport.test.js`内原来显式期待500的相邻断言，不改身份判断或通用错误拦截器。

2026-09-07 G6只读准备已核对真实HTTP路径：可复用`redrawRoutes.test.js`的referenceImportRouterFixture、withJsonRouteServer/postJson（实际router/auth/SQLite迁移/临时storage）。tenant中间件首次请求会创建个人租户/成员，必须先显式初始化再拍全库total_changes基线，不能把首次鉴权初始化误认review写入；未知Error与未映射业务码仍500。该定位未运行测试或编辑产品，待G4唯一作者退出及双审后再进入正式RED。

2026-09-08 本小包已并行实施，独立于 G5 合成文件：默认真实 HTTP/SQLite/PNG 的正式 RED 为 14 项中 9 pass/5 fail（四个预期 500→409 业务断言及父聚合），无夹具失败；仅新增精确业务码的一行 handler 分支后，作者与根定向各 14/14，功能锁各 44/44，native 0、选定来源无漂移、无超时/跳过/残留进程。根回执分别为 `g6-review-identity-20260908-r1-review-root-review-final-6a61c29097484b098678e59d6244ac99/receipt.json`（SHA `ca5bfedf69fda03c173108439e1f8791d5b058be4ee4f04554612d4e74ac9c9b`）及 `g6-review-identity-20260908-r1-feature-root-feature-final-4813c5f22862421ab07d94cb448c72b1/receipt.json`（SHA `d1fb867f3be2e8c701d44d0e06416b3aec358a8f18156d0f93d626c1a785bc5d`）。三项功能锁只追加本次授权并可逆还原原清单。独立 SPEC PASS 后 QUALITY APPROVE 已完成，仅该精确错误映射本地收口；定向匹配测试不代表两文件全量、浏览器或 G6 完成。继续保留所有全产品退出条件。

- [x] G6 身份包审批精确错误映射局部完成：2026-09-08 默认真实 HTTP 定向 TDD、根 14/14、功能锁 44/44、非作者 SPEC PASS 后另一非作者 QUALITY APPROVE；当时五源匹配 GREEN 回执。独立审查者分别为 `g48_lifecycle_quality/test_quality` 与 `g5_unit_assembly`，后者未参与 G6 实现；受线程名额限制复用既有代理，不以作者自审代替双审。2026-09-09 当前路由 SHA `b68b301a7cb850bc73862affdb974ca39a6f252001f1f618e78077b001caa284` 已沿原定向 pattern 刷新为 14/14、native 0，receipt `g6-review-identity-20260908-r1-review-root-identity-current-refresh-ea7bf4edfed54516a3b6102c47032320/receipt.json` SHA `ad51bf6871dcb0fb026c4d98312bbbfe983ef04f694069e4978fcc419d2cfe3d`；无跳过、超时或输入漂移，进程退出。只关闭这个错误映射，不扩大为两测试文件全量、浏览器或 G6 完成。
- [x] 本地矩阵串行完整后端、Worker、前端、默认后端浏览器、构建、功能锁及差异审查。2026-09-10 当前未提交工作树：后端 6594/6582 pass/12 skip/0 fail；Worker 127/119 pass/8 skip/0 fail；前端 2471/2471；启动器/媒体矩阵 153/151 pass/2 skip/0 fail；构建 1929 modules；特性锁 ready；CRLF 感知全树 diff-check 通过；隔离 Chromium 完整产品链 1/1。当前没有 approved visual baseline，因此正式视觉验收仍明确未做，浏览器功能绿灯不替代该项。
  - [x] 2026-09-09 当前工作树 public-mode Vite 编译：native 0，299 输入稳定、131 产物，根复核 432 项零漂移；仅关闭本时点编译检查。根收口 SHA `704dc36dfbe765ea2f886e2398b0c66b405112543e2244e9f155a984d8b48106`，既有大 bundle 警告保留；后继源码变化须更新验证，不据此关闭全矩阵。
  - [x] 普通默认登录的入口子项：r5/r6 已通过真实 Login.vue → `/auth/login` → 默认租户解析进入 `/redraw`，实际建项目/上传新合成源片并退出；无假 token/request owner 注入。r6 UI 修复复验与哈希证据见页首。只关闭入口，默认分析至导出的整个浏览器链仍在父项内未完成。
- [ ] 汇总每一条失败/跳过原因及新源码 hashes；取得当前明确 Git 权限后再提交/推送 PR #217，Hosted CI 四项必须绑定最终精确 HEAD，不用旧绿灯。
- [ ] 真实阶段先给出代表性独立输入、支持参数、次数/停止策略和估计费用，取得本轮精确授权后调用现有已验证供应商；不得复用历史有限授权，不改线上模型。
- [ ] 同一批真实项目分别验收目标语言/名字/角色/动作/文字/声音；再复用同批产物做暂停恢复、合成播放下载，不为重录重复生成。
- [ ] 移交本地版本、依赖/Worker 检查、支持矩阵及普通用户操作说明，用户用新的受支持视频完成并接受后才宣称完整交付。部署不在本轮范围。

根验证入口沿用本文任务 3 的完整命令；每个新增包先执行其聚焦入口和实际失败断言，再执行完整回归。计划进度写本文，总证据写 `docs/verification/redraw/mainline-final-delivery.md`，原始运行日志只追加到本地 `.codex-staging`，不覆盖历史证据。

### R2 输入支持合同复核（2026-09-06，只读定位）

本表来自当前源码与既有正式测试的只读映射，本轮没有运行新母本分析或请求供应商。以下是代码接受边界，不是已验证整链支持；不修改线上模型，也不静默缩短原已声明的支持范围。

| 维度 | 当前实际合同 | 尚需验证／补齐 |
|---|---|---|
| 文件入口 | 单个 MP4/MOV；ZIP 最多 20 个非目录条目，逐项校验 MP4/MOV。multipart 压缩包／源文件上限 1 GiB（1,073,741,824 字节）。 | 默认 route 未注入 ZIP 展开总量／单项大小限制；页面只接首个返回作品，其余批量作品可达性待页面验收。不能把扩展名允许当默认 MOV／ZIP 全链已通过。 |
| 时长 | 单文件 12,000–3,600,000 ms；ZIP 每条 12,000–180,000 ms，均含边界。 | 页面缺少这些差异提示；正式回归须走默认限制，不能靠测试覆盖 min/max 证明。 |
| 尺寸 | ffprobe 取整后宽高有限且大于零；没有源最大宽高、像素或比例白名单。 | 目标输出比例不等于母本限制，多尺寸真实输入尚未整链验收。 |
| 源音频 | 有轨提取为 16 kHz／16 bit／mono PCM WAV；整个 WAV 一次送 Worker，上限 64 MiB（67,108,864 字节）。无轨不调用 Worker。 | 1 小时 PCM 数据约 115,200,000 字节，静态推导超过 Worker 上限。视觉 24 秒分窗不解决整轨音频限制；没有现成源音频分窗／ASR 合并入口。 |
| 证据状态 | 无轨与完整 VAD/ASR 明确零语音均可为音频 `silent`，但前者无音轨 hash，后者保留音轨 hash 和 VAD 证据；都不是作品已完成。 | 空识别、推理失败、未知不能当静默。服务保留 `SOURCE_AUDIO_RESULT_UNKNOWN`，上层当前却仅给视觉窗口 unknown 保留 `needs_attention`，音频 unknown 进入 `markFailure`，需正式状态回归。 |

后续只收口三组缺口，不再创建平行计划：

- [x] **先修未知状态连接。** R2d.1 页面双审后，先以真实 orchestrator／隔离 DB 正式 RED 复现源音频 unknown 被当明确失败，修正状态、保留冻结与重复点击零新增请求；不扩大供应商或重试权限。这是发现的状态安全缺口，优先于后续素材新入口；本地退出与限制见下方两文件实施包。
- [ ] **长音轨支持。** 2026-09-07已补正式真实SourceAudio产品RED：同一小时MP4抽取115,200,078字节WAV，唯一底层Worker替身因超过64MiB拒绝，实际产品映射失败，1/0/1、无skip/timeout且120引用不变；详见唯一验收文档的root回执。未修复产品、未运行真实ASR。后续补原1小时承诺所需的有界PCM/ASR及完整绝对时间聚合，不能仅提升常量、截断整句或从视觉分窗推断音频已可用；接缝/说话人/纠错闭环仍待实现与验收。
- [ ] **多输入与页面一致。** MP4/MOV/ZIP、多尺寸、无轨／背景音乐／多人／跨镜输入逐项标明技术边界和实测状态；现有默认产品 25 秒 160×120 MP4、底层 ASR/视觉 fixture 不替代这些组合。补页面限制、ZIP 可达性及展开资源合同的实证，不擅自收窄用户范围。

定位入口：`redrawUploadService.js:70/228/279`、`routes/redraw.js:62/2126`、`RedrawSourceStep.vue:538`、`redrawSourceAudioEvidenceService.js:63/482`、`redrawOrchestrator.js:574/650`、Worker `server.py:18`／`source_evidence.py:167`。本节不勾选整个 R2、任务 1 或 R5；身份页面→未知状态修复→动作素材／长音轨合同→动态执行的依赖次序保持在同一主线。

长音轨直接消费者的后续只读定位：Worker 时间相对本次 WAV，客户端仅秒转毫秒；每个请求重新建 MFCC 聚类且从 `speaker-cluster-1` 编号，不存在跨请求身份映射。转录 SHA 绑定规范 start/end/text 而不含 speaker；请求音频 SHA 绑定单份 WAV，不能冒充全片。现有最终源证据要求完整全片时间、顺序不重叠和最多 4096 段。故“切片＋concat”不满足整句／人物／源绑定要求；后续实施前须明确完整覆盖及窗口绑定、接缝去重保整句、稳定说话人聚类／可核验映射、全成功才发布聚合证据的最小合同。可复用私有源快照／hash 验证／原子登记及已有完整句跨镜分配，不冒称已有音频分窗或接缝算法。上述仍为静态定位，未改变 Worker 或添加新的处理功能。

#### R2 音频 unknown 状态连接：最小实施包

身份上传本地双审与证据退出后开始，不并行改其五个文件。现有产品三项基线 3/3、exit 0 只覆盖正常分析、视觉明确失败和视觉未知；不能替代下面的新反例。全新实现者只负责 `backend-node/src/services/redrawOrchestrator.js` 和 `backend-node/test/redrawWindowedProductAnalysis.test.js`；主代理负责两项触及功能锁的本次本地授权／历史完整性测试与唯一文档。无需修改 Worker、音频服务、数据库结构、路由或供应商合同。

- [x] **真实产品 RED。** 复用现有真实上传视频、FFmpeg 音轨提取、隔离 SQLite、产品 handler 和默认 orchestrator fixture。只在底层 `sourceAudioWorkerClient.analyzeSourceAudio` 验证本次 WAV／hash 后抛 `REDRAW_LOCALE_VERIFIER_TIMEOUT`，由实际音频服务转换为 `SOURCE_AUDIO_RESULT_UNKNOWN`；不直接 stub 上层结果或手写任务终态。计数用实时 getter 而非 fixture 返回时的数字快照。正式断言作品／任务应为 `needs_attention`，当前代码须因实际 `failed` 状态失败，保存日志和真实退出码。
- [x] **最小 GREEN 与防重。** 在原 `startAnalysis` catch 将确切 `SOURCE_AUDIO_RESULT_UNKNOWN` 与已有视觉 unknown 同样映射到 `markNeedsAttention`，不增加自动重试或宽泛捕获全部错误。断言仅一个 Worker 调用、零视觉调用／音频证据／视觉结果／蓝图／视频生成；work/task 绑定同一笔 6 积分本地 reservation 且保持 held，无 confirmed/refunded。再次实际调用同一分析 handler 仍拒绝，task/reservation 的 ID 和数量、Worker/视觉调用数均不变。
- [x] **明确失败不回归。** 补同一底层 Worker 的明确失败分支，验证旧 failed 状态与释放预留合同保持（实际 reservation 状态为 refunded，不存在 released 枚举），不能把所有音频错误都冻结。原三项测试及源音频／源证据相关回归继续通过，不把空识别或 unknown 改成 silent，不写入任何生产积分记录。
- [x] **双审与退出。** 正式 RED→GREEN 后先独立规格、再独立质量；根亲读源码差异、完整实际终态与 hash，功能锁两条授权只追加历史，不弱化规则。保留身份上传 receipt 与旧日志，绑定本批新证据；零 Key／联网／供应商／付费／Git／CI／生产／部署。

本地退出证据：有效 RED-r3 仅音频 unknown 失败，最后 GREEN-r4 5/5；独立规格 PASS（5/5＋feature 33/33）、质量 APPROVE（5/5）。根 routes 154/154、源音频／视觉证据 50 pass＋1 POSIX skip、功能锁与静态均实际 exit 0；原三项回归保留，当前 runtime/test 与独立双审入退 hash 一致。机器回执 `.codex-staging/r2-source-audio-unknown-verification-20260906.json` 绑定当前 87 源、两文档和本批证据，父身份 UI receipt 保留。只完成未知状态安全连接，不代表长音轨、动作素材、执行恢复或完整交付；接续普通动作参考本地入口。

### 任务 2：补通用产品闭环，不运行独立脚本冒充页面完成（本地）

每个子项依次执行“具体失败测试 → 确认预期失败 → 最小实现 → 原测试及相邻回归 → 独立审查”；仅按当轮授权提交，不顺手重构。

- [ ] 动态分析：复用默认 `runBlueprintPipeline()`，修复空语音判定与长母本分段；测试超过 64 段仍保留全部证据、跨镜整句不被夹短丢失、Worker 不可用明确失败而不伪造事实。
- [ ] 事实纠错：在现有蓝图 UI 增加逐句源片定位、文本/时间及镜头纠正、聚类拆分和重映射；原始证据只读，修订使用现有版本/hash/CAS。测试未解角色/画外对白、低可信关键事实和过期编辑被服务端阻断，锁定后才可本地化。
- [ ] 素材准备：从当前母本与审核结果自动制作/登记动作参考，复用媒体安全检查、身份包和准备门禁；补用户可用的图片/动作素材生成、选择、上传及审核。测试无需内部资产 ID，越权素材、引用漂移和不可读工件均不能进入生成。
- [ ] 动态计划：在现有规划逻辑上支持按已验证模型能力拆分任意所需段数，处理长于单次上限的镜头和整句覆盖；不能仅扩大硬编码时长。测试不同输入得到不同计划、无漏镜/重复/越界、无合法对白边界时进入明确纠错而非硬切。
- [ ] 产品运行：现有版本/任务关联动态计划与单元状态，页面发起、排队、首个待审候选暂停、审核后续行、逐单元 QA 与恢复均映射同批工件；复用隔离脚本的安全逻辑，但不得把其样本常量或独立 CLI 入口当产品接口。
- [ ] 安全与状态：浏览器只提交服务端允许字段，不传任意 Key、base URL、未验证模型或文件路径；试验适配器仅本地服务器注入。测试缺 Key 零提交、明确失败才可按批准策略换线、未知全局停止、重复点击/刷新零重复生成、否决/过期审核零后续提交。
- [ ] 原生音轨发布：在既有候选、release、composition、export 增加受控原生音轨证据分支，独立配音仍保留真实资产/账态合同；当前候选音轨、批准对白、原片及保留片段 hash 纳入发布校验，禁止伪造 TTS 扣费或无声冒充有声。
- [ ] 媒体与下载：输出按当前批准计划保留完整构图和时间线，不加速整片、不从句中硬切；记录实际宽高、SAR/DAR、帧率和音视频时长。固定 Fumin480 修复仅作对应档位回归，通用档位从目标合同推导；下载 hash 必须等于本次发布工件 hash。
- [ ] 用户操作闭环：已生成单元由服务自动归并为父镜头候选并进入现有 QA/发布；恢复后继续显示进度、素材、审核和下载。测试不得手工写库、导入最终成片或从其他运行拼工件冒充 UI 发起成功。

**退出条件：** 注入无费用供应商的真实产品链从空项目走到下载；审核、失败、未知及过期证据均不能进入不允许的下一阶段。技术成功、待质量审核、可下载与用户验收分别记账。

### 任务 3：多输入回归、审查与同 HEAD CI（本地优先）

- [x] 建立不同镜头数/时长、单镜超过模型上限、多个输入方向、多人/画外/跨镜对白、无语音/静默、不同已支持语言的确定性矩阵；至少一条 UI 集成走默认动态证据管线，不注入 `activeAnalysisFacts` 或外部完成包。低层分析/生成依赖可模拟，但必须处理本次上传媒体。2026-09-10 补入第三份 160×160、AAC 有轨的真实 FFmpeg 素材；最低层确定性 Worker 替身在真实抽取 WAV 上返回 VAD 零语音，与横屏无轨、竖屏有对白一起经真实登录、默认 HTTP ZIP 上传、音轨/视觉/融合、owner 隔离走通；三文件组合回归 51/51。该结果只证明产品分支与媒体绑定，不证明真实 ASR/VAD 质量。既有动态计划覆盖长镜头、跨镜完整句、引用上限及非常规模型时长；能力/页面矩阵覆盖 en-US、es-ES、ja-JP、ko-KR 等不同支持状态，默认浏览器产品链使用实际上传媒体而非注入最终 Facts。
- [x] 完整预演首个候选待审、拒绝、批准续行、处理中刷新、服务重启、未知结果和第 N 单元失败；核对已提交/未提交状态、防重及账户隔离。合成失败只能复用已有合格原片，不触发重新生成。2026-09-10 新增三父镜头真实派生/准备队列的“首单元成功并人工批准，第二单元明确失败，第三单元不得启动”回归：固定 2 POST、1 下载、2 reservation，失败 reservation 退款一次，第三单元零 attempt，重复 advance 零 POST/零 DML；修复后完整 25/25（541,178 ms）。前端生命周期 216/216，后端 review/recovery 74/74，均 0 fail/skip。
- [x] 运行聚焦测试、后端完整测试、Worker 测试、前端状态测试、真实前后端浏览器链及构建；记录每条命令退出码、通过/失败/跳过。2026-09-10 本轮统计见 G6 矩阵及总报告；所有失败为 0，skip 限于 Windows symlink/AF_UNIX 和条件分支，完整 Chromium 主链实际执行 1/1，并未靠 skip 放行。真实 FFmpeg 合成由媒体矩阵覆盖，正式无裁画面视检因无 approved visual baseline 仍未完成。
- [x] 已收口审批错误呈现：`REDRAW_CHARACTER_IDENTITY_REQUIRED` 精确映射 409/原业务码，owner/CAS、拒绝零写与未知内部异常 500 保持。2026-09-08 原真实 HTTP TDD 和双审已完成；2026-09-09 当前路由再跑原定向用例 14/14、native 0（回执见上方 G6 身份包审批项）。原“当前仍包装成 500”是未同步的历史待办，现据源码和当前动态证据纠正；未重复修改 handler，不代表整个 G6 或浏览器已通过。
- [x] G6.HTTP_EMPTY_ARRAY_GET_BODY（2026-09-09 本地小修收口）：低层 `node:http` 实际 GET 空数组 RED 5/4/1→GREEN 5/5，拒绝前后的 SQLite serialize、total_changes 与 transport 不变；正常无 body、非空非法 body、成员及版本 owner 隔离控制通过。仅 route 单表达式增加数组判断，空对象语义保留（不冒称独立 `{}` 动态覆盖），全局 parser/index/服务/POST/UI/模型未改。相邻 Run/Candidate 31/31，最终 feature 51/51，SPEC PASS→QUALITY APPROVE，原50项及完整历史不弱化；根证明 `g6-empty-array-get-body-verification-20260909-r1.json` SHA `79675d703f607219c1708fe7df061c8e67b943d489eeadabf37c835fb609acb1` / 103引用零漂移。feature 旧入口没有 raw-capture flag，已实读 TAP/空 stderr，不伪造该标志。仅关闭此缺口，不关闭整个 G6 或产品。
- [x] G6.COMPOSE_PERMISSION_DURING_AWAIT（2026-09-09 本地收口）：真实 FD 读取屏障下四类撤权实际 RED 5/1/4；最小同步只读复核位于既有 BEGIN IMMEDIATE 后第一句、replay/INSERT/调度前。token/user 安全返回 401，tenant/member 返回 404，撤权后无新 export/资产/文件/供应商增量；正常完整 HTTP 81/81、unit+旧合成 57/57、最终 feature 52/52，均 native 0，无跳过/超时/漂移。真实 FFmpeg 正例保留；旧 v1、GET、request_hash/幂等不改，三产品与两测试逆还原精确旧 SHA，五锁历史完整。SPEC PASS→独立 QUALITY PASS；根证明及 128 引用见本文顶部。仅关闭此安全缺口，不关闭整个 G6 或产品。

  历史：2026-09-09 实施前独立只读映射（后续测试与修复已见上项）：真实 unit 创建从 route 经 `createUnitComposition` / `buildUnitCompositionPlan` 等待 release 候选文件读取，再在事务中 INSERT；现有 owner/run/media 复核没有重核 `platform_users.status/token_version` 或 tenant/member 状态。优先复用 `redrawExecutionUnitCompositionHttp.test.js` 私有隔离夹具与既有 Export HTTP 精确 FD 读取屏障，在真实计划 await 内撤权、撤权后取快照，再释放原读取；比较新增 export/assets/dispatch/transport 为零，不能把夹具前置 synthetic 调用误报成全局零。保持不撤权控制例；禁止 mock 掉实际 create 服务。若 RED 确认，最小产品方向是在 unit 创建事务 INSERT 前调用本请求同步权限复核，安全映射撤 token/member 错误；不在 INSERT 后才补查、不加通用测试钩子或重写旧 v1。这段仅保留当时的定位与拟议方法，不覆盖上项最终 TDD/双审结论。
- [ ] 审查精确差异和其他会话改动，只提交本任务内容；按当轮授权提交/推送后，要求最终 40 位 HEAD 的四项 Hosted CI 成功。未获远程权限则明确 CI 未验证，不引用基线绿灯。
- [x] 总报告记录支持矩阵、源/蓝图/本地化/素材/计划/输出 hashes、HEAD、测试/CI、未验证项；局部 fallback/SAR 测试通过不能勾选整个通用任务。2026-09-10 已追加“G3 多输入与执行失败矩阵收口”，明确当前基线 HEAD、未提交七文件差异（五个测试／夹具文件与两个文档）、三类真实合成媒体、当前测试终态和仍未运行的同 HEAD Hosted CI／真实供应商质量／用户新视频验收；未把本地 fixture 绿色写成完整交付。

本地命令入口（不是本轮已执行结果；新增用例并入对应入口）：

```powershell
node --test frontweb/scripts/run-redraw-video-model-fallback-live.test.mjs frontweb/scripts/run-redraw-episode-blueprint-live.test.mjs frontweb/scripts/fuminEpisodeExecutionPlan.test.mjs frontweb/scripts/fuminEpisodeMediaPipeline.test.mjs frontweb/scripts/fuminEpisodeProviderAdapter.test.mjs frontweb/scripts/episodeVideoProviderAdapter.test.mjs frontweb/scripts/episodeVideoRouteRegistry.test.mjs
npm --prefix backend-node test
npm --prefix backend-node run audit:feature-lock
node --test frontweb/test/*.test.js frontweb/src/utils/redrawBlueprintReviewState.test.mjs
$env:PYTHONPATH = 'workers/redraw-locale-verifier/src'
$env:PYTHONDONTWRITEBYTECODE = '1'
python -m unittest discover -s workers/redraw-locale-verifier/tests -p 'test_*.py' -v
$env:REDRAW_E2E_FAKE_PROVIDER = '1'
$env:PLAYWRIGHT_REUSE_SERVER = '0'
npm --prefix frontweb run test:e2e:redraw-full-product
npm --prefix frontweb run build
git diff --check
```

执行前确认现有 Python 环境、隔离 DB/目录及端口；执行后恢复环境变量。不得用默认生产配置启动测试，也不得借预演读取供应商状态。

**退出条件：** 多输入本地链与相关回归通过、关键链无跳过、差异审查通过且同 HEAD CI 全绿；这是预生成工程验收，不是通用真实质量或完整交付。

### 任务 4：真实多输入质量验证（另行明确授权）

- [ ] 任务 1—3 达标后，以精确 HEAD、测试输入矩阵、已验证能力、参数、预估费用、每输入和全轮最大提交次数申请新授权；历史单集预算/路线次数不自动适用于新母本，不承诺“任意文件均已实测”。
- [ ] 从普通用户页面新建多个不同母本项目；沿当前审核稿核对人物、动作、叙事、目标对白、口型、画面文字与环境声。首次合格候选审核后才推进，其他角色/镜头独立审核，自动检查不能代替实际听看。
- [ ] 不合格、未知或缺 Key 按固定边界停止；不得以质量失败冒充供应商明确失败切线继续付费。新模型未经目标 Key 真实生成及文件验证，不进入前端或画布目录。

**退出条件：** 支持矩阵内代表性独立输入取得真实技术与内容证据；限制、失败及未测组合如实记录。某一个样本成功不等于通用产品通过。

### 任务 5：同项目恢复、合成与导出验收（真实阶段另行授权）

- [ ] 复用任务 4 同批成功工件，验证暂停/重启/重开恢复，不为录屏或重试展示重复收费；独立多用户隔离验证不得访问其他真实用户数据。
- [ ] 按各母本时间线合成，逐段核对原始结果和保留片段的全部批准对白；检查缺镜、重复、黑帧、断音、字幕、构图、真实显示比例与当前计划时长容差。
- [ ] 页面预览、MP4/字幕/报告下载及刷新恢复均可用，下载 hash 与发布清单一致；本地编码故障只修本地处理，重新付费生成必须新增明确授权。

**退出条件：** 多输入同项目的质量审核、恢复、合成、播放和下载证据闭合；无待审项被标记为已交付。

### 任务 6：通用产品移交与用户验收（独立交付阶段）

- [ ] 移交确切本地版本、启动与依赖/Worker 检查、用户支持范围、纠错/恢复说明和脱敏总报告；用户无需开发工具完成核心流程。
- [ ] 让用户用自己的新视频走通产品并接受结果；未验收时只写“内部验收通过、等待用户验收”。第二个及其他输入的真实质量未验证时，不得用已有样本替代。
- [ ] 分开报告本地候选、同 HEAD CI、真实多输入质量、用户接受；上线不属于本轮完成条件，未部署不冒充生产已可用。

**最终标准：** 通用功能完成、多输入质量及恢复/导出通过、资料齐全、用户接受；不得以交付本集 MP4 取代产品完成。

## 5. 全程固定边界

- 不合并 PR、不部署、不重启生产、不读写生产数据库、不修改 shared/门禁或线上模型、不触碰 AI 音乐、不删除历史候选；部署若将来单独获准，仍先协调同项目其他会话并遵守实时 current 与受保护发布规则。
- 任务 1—3 不读 Key、不请求供应商、不付费；真实阶段仅使用当轮授权的本地凭据与新运行，不借其他会话的授权。缺 Key 零提交；未知结果冻结、不自动退款、不重试生成。
- 蓝图、素材、能力配置或 HEAD 改变，重新绑定受影响证据和授权；审核不能跨文件、跨版本、跨运行放行。新增次数、重新付费、供应商范围扩大或生产动作必须重新授权。
- 同一证据未变化直接复用，不重复下载模型、调查已修复域名、制作历史失败候选；不为通过验收放宽质量门禁、隐藏失败、静默截断或收窄支持范围。
- 固定顺序：**通用合同 → 完整产品纠错与连接 → 多输入本地回归/同 HEAD CI → 另行授权的真实质量 → 恢复/合成/导出 → 产品移交与用户验收**。当前所有主线任务保持未完成，局部代码进展只记局部证据。
# 2026-09-10 执行更新

G2 人工接缝确认现已完成页面读取、完整段选择、持久证据、原任务/原 reservation 独占恢复以及 Native/Fusion/Blueprint 后半程。本阶段不自动裁句、不新增语音模型；语言冲突继续人工阻断。后续顺序：v2 锁定/Facts 精度贯通 → G2 总回归与双审 → 继续剩余交付门禁。
