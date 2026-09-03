# 管理员模型计费列表恢复与中转站分组

## 结论

- 只读检查确认生产计费数据没有被删除：当前 `ai_service_configs` 有 24 条未删除配置，`model_credit_prices` 有 34 条价格记录；截图中的管理员摘要同时显示 47 个计费模型。
- 因此本次问题按前端展示层回归处理，不对生产价格表做恢复写入，也不改变模型计费主键。
- `modelPriceService.list()` 已汇总每个配置的 `model` 与 `default_model`，未要求先在模型配置页选中单个模型；本次保留该完整目录行为。

## 变更

- 新增 `frontweb/src/utils/billingModelGroups.js`，按中转站 Base URL（无地址时按 provider）生成稳定分组。
- `frontweb/src/views/BillingAdmin.vue` 改为渲染中转站队列和队列内模型；同一模型绑定多个中转站时在对应队列中展示，但保存仍写入同一条 canonical model 价格记录。
- 保留“未定价”模型和“未关联中转站”队列，确保完整目录仍可直接定价。

## 验证证据

- `node --test frontweb/test/billing-model-groups.test.js frontweb/test/billing-ledger-admin.test.js`：5/5 通过。
- `npm run build`（`frontweb`）：构建通过。
- `node --test test/modelPrice.test.js test/billingRoutes.test.js`（`backend-node`）：31/31 通过；首次运行因本机原生 `better-sqlite3` 绑定缺失，执行 `npm rebuild better-sqlite3` 后重跑通过。
- `node --test`（`backend-node`）针对成本同步、路由成本、模型目录、成本台账、调度器和后台服务的 7 个测试文件：64/64 通过。
- `git diff --check` 使用仓库现有 CRLF 约定复核；未发现代码内容空白错误。

## 发布边界

初始候选只完成代码和验证，未修改生产数据库。2026-09-03 在用户明确“继续上线”后，按实时 `current` 重建并完成受保护激活；生产证据见本文末尾。

2026-09-03 上线前冲突审计：主工作树 `C:\Users\canqu\Documents\茉莉妈妈2\molimama-stage9` 仍有未提交的 NewAPI 视频接入改动，涉及 `backend-node/src/routes/aiConfig.js`、`backend-node/src/services/aiConfigService.js`、`backend-node/src/services/videoClient.js`、`backend-node/src/services/videoService.js`、`backend-node/src/services/videoVoicePolicyService.js` 及前端配置/端到端测试。经文件级核对，本次候选只叠加计费/成本同步白名单，未覆盖上述并行文件；候选从生产实时 `current` 重建后再激活。

## 中转站成本自动同步调查（只读）

- `GET https://newapi.megabyai.cc/v1/models` 只返回模型能力字段，不包含价格。
- `GET https://newapi.megabyai.cc/api/pricing` 可匿名读取模型报价；官方 NewAPI 文档将 `model_price` 定义为美元，并说明该接口同时返回计费类型和模型价格。
- 目标模型的返回值包含 `billing_unit`、`resolution_prices`、`duration_prices` 和 `conditional_prices`。视频报价目前主要是按秒，并可能同时按分辨率、是否带视频参考条件区分。
- 生产配置 29（NewAPI megabyai）同时挂载 5 个模型，当前没有 `provider_route_costs` 成本记录；现有 `provider_route_costs` 只以 `config_id` 为主键，不能表达同一中转站内多个模型的不同成本。
- 因此不能把美元报价直接写入现有人民币微元字段，也不能把一个配置的 5 个模型压成一个成本。后续实现需要按“中转站配置 + 模型”保存原始美元报价，并在明确人民币汇率及手工覆盖规则后再进入成本台账。

2026-09-02 对 [中转站报价接口](https://newapi.megabyai.cc/api/pricing) 做只读复核，按默认 USD/CNY=7.2 换算（条件价取最高档作为成本上限）：

| 模型 | 中转站美元报价 | 换算后的人民币成本 |
| --- | --- | --- |
| `alibaba/wan-3.0` | 480p 0.15、720p 0.30、1080p 0.67 / 秒 | 1.080000、2.160000、4.824000 元 / 秒 |
| `seedance-2.0-fast` | 480p 0.20、720p 0.40 / 秒 | 1.440000、2.880000 元 / 秒 |
| `seedance-2.0` | 480p 0.16、720p 0.30、1080p 1.05、4K 1.50 / 秒 | 1.152000、2.160000、7.560000、10.800000 元 / 秒 |
| `seedance-2.0-mini` | 480p 0.05、720p 0.11 / 秒 | 0.360000、0.792000 元 / 秒 |
| `seedance-2.5` | 480p 0.26/0.17、720p 0.58/0.37、1080p 1.02/0.65（无/有视频参考）/ 秒 | 每档取上限：1.872000、4.176000、7.344000 元 / 秒 |
| `minimax_h3_image_audio_to_video_v2` | 768p 0.03、1080p 0.15 / 秒 | 0.216000、1.080000 元 / 秒 |

## 自动成本同步实现

- 新增 `provider_route_model_costs`，主键为 `config_id + model`，保存人民币微元成本、完整中转站美元报价快照、报价接口、抓取时间、指纹、换算汇率和成本来源。
- NewAPI 同步只读取配置地址的 `/api/pricing`，必要时使用该线路自身的 API Key 获取用户可见的报价分组；日志和响应不会输出密钥。
- 有分辨率/引用条件的价格按每个分辨率取最高档作为台账成本，避免利润被低估；倍率计费（`quota_type=0`）不臆算，不写入成本。
- 新增管理员同步接口 `POST /billing/admin/provider-pricing/sync`，并在后台启动时首次同步、之后默认每 6 小时同步一次。同步仅插入或更新 `relay_auto`，不会覆盖 `manual` 成本；已有配置级手工线路成本优先于自动模型成本。
- 经营台账设置新增 USD/CNY 汇率（默认 7.2，可由管理员修改）；生成成本台账在有配置内模型成本时按 `config_id + model` 计价。

## 2026-09-03 受保护上线证据

- r1 候选因把较新分支的整份 `routes/index.js` 覆盖进线上旧 release，启动缺少 `redrawLocalVoiceRegistrationService`；共享激活器检测到启动失败后自动回滚，未改变 `current`。该候选和审计均保留。
- r2 候选 `/opt/moli-drama/releases/billing-admin-model-groups-20260903-b41-r2` 从实时 `/opt/moli-drama/releases/newapi-video-20260902-f11b2ebb-r1` 克隆，仅叠加本任务 15 个运行文件，并在候选目录内构建前端。
- 共享 verify-only 通过 `canvas-credit-callout-v1`、`canvas-reference-numbered-mentions-v1` 和外部模型证据校验；随后唯一共享激活器记录 `activation_success`。
- 激活审计：`/opt/moli-drama/shared/release-audit/protected-release-20260902T232332Z-3281854.audit`；数据库备份：`/root/data/disk/moli-drama-backups/database-release-guard-20260902T232332Z-3281854.sqlite`，`quick_check=ok`，切换前活动任务 `async_tasks/image_generations/video_generations=0`。
- 线上验收：`readlink -f /opt/moli-drama/current` 指向 r2；`moli-drama` 为 active；内网 `/health` 和 `https://molimama.vip/health` 返回 200/`status=ok`；AI 音乐 `server.js` 与 `worker.js` 进程保持不变。
- 首次启动同步已写入 5 条 `relay_auto` 模型成本，来源均为 `https://newapi.megabyai.cc/api/pricing`，抓取时间 `2026-09-02T23:26:06.534Z`，汇率 7.2：`minimax_h3_image_audio_to_video_v2` 1.080000 元/秒、`seedance-2.0` 10.800000 元/秒、`seedance-2.0-fast` 2.880000 元/秒、`seedance-2.0-mini` 0.792000 元/秒、`seedance-2.5` 7.344000 元/秒。`alibaba/wan-3.0` 未通过真实生成验证，因此未写入已开放模型成本目录。

## 2026-09-03 用户复验失败后的二次修复

用户复验确认两个前端问题仍存在：直接进入运营计费不可靠；从模型配置的“设置定价”进入时会混入其他中转站的模型。

根因与修复：

- `BillingAdmin.loadAll()` 原来用一个 `Promise.all` 同时读取模型、账号、工作区、流水和台账。任意辅助接口失败都会阻断模型价格赋值。现改为先独立读取模型价格，再以 `Promise.allSettled` 读取辅助数据；辅助接口失败时模型计费仍可显示，并给出部分数据不可用提示。
- 模型配置入口原来只传 `model`，没有传当前配置标识；同名模型可属于多个中转站，因此无法限定线路。现改为传 `config_id`，计费页按该配置精确过滤。
- 首版分组把同一个模型对象原样放进多个队列，导致队列内仍携带其他中转站的 `providers` 和 `provider_costs`。现为每个队列生成仅含该中转站关联与成本的浅副本，不再串组。

本地回归证据：

- 先增加失败用例，旧实现 4/4 失败；修复后计费导航、分组、RBAC 和兑换后台相关测试 29/29 通过。
- `npm run build` 通过，生成 `BillingAdmin-2tvwVf7i.js` 和 `AiConfig-BWYcO3wx.js`。
- Playwright 构建产物验收：直接访问 `/billing-admin` 可见模型计费面板和两个独立中转站队列；模拟账号辅助接口 500 时，模型数仍为 3 且队列继续显示。
- Playwright 从模型配置 21 点击“设置定价”后进入 `/billing-admin?tab=models&config_id=21`，只显示中转站 A 的 2 个模型，未出现中转站 B。
- 前端全量 Node 测试仅有 1 个与本次无关的既存失败：`aiConfigProviderPresets.test.js` 仍断言飞拓预设不得包含 `seedance-2.5`，而当前基线早已包含该模型；本任务未改动供应商预设。

上述二次修复已随后制作 r3 候选并完成受保护上线，证据如下。

### r3 二次修复上线证据

- Git 源提交：`221bd022be0df77132fad2fd0989952ad895f4c4`。候选 `/opt/moli-drama/releases/billing-admin-model-groups-20260903-b41-r3` 从操作时线上 r2 克隆，只覆盖 `AIConfigContent.vue`、`billingModelGroups.js` 和 `BillingAdmin.vue` 3 个目标源文件；构建前源码差异也严格限定为这 3 个文件。
- 第一次 verify-only 因 Windows 归档使 3 个源文件成为 `0666` 而被共享门禁拒绝；仅把候选中的这 3 个文件恢复为线上同名文件的 `0644`，未绕过或修改门禁。第二次 verify-only 明确返回 `protected_release_verified`。
- 正式激活审计：`/opt/moli-drama/shared/release-audit/protected-release-20260903T021008Z-85289.audit`，记录 r2 到 r3 的 `activation_success`。数据库备份：`/root/data/disk/moli-drama-backups/database-release-guard-20260903T021008Z-85289.sqlite`，SHA-256 为 `977f50633e8b027949d9f2fd2cbdf2b6cb1f564d96db4f73a4af638167d29b49`，`quick_check=ok`；切换前后活动任务均为 0，服务停机窗口 230 ms。
- 线上独立验收：`current` 指向 r3，`moli-drama` 为 active，内网 `/health` 返回 `status=ok`，`/billing-admin` 返回 200，部署后日志未发现 `uncaught/unhandled/fatal/error`。
- 公网拉取的 `BillingAdmin-DCJPa1Mb.js` 和 `AiConfig-Dck_SE59.js` 与 r3 服务器文件 SHA-256 完全一致；构建产物中已确认包含按 `config_id` 限定中转站、独立加载模型计费和辅助运营接口失败提示。
- AI 音乐隔离保持：`/opt/moli-mama/server/server.js` PID 1592199、`worker.js` PID 1592245 未变化。
- 生产端需要管理员登录态才能查看完整计费数据，因此自动线上验收覆盖到页面、资源和服务层；带登录态的交互行为已在同一构建产物的 Playwright 验收中覆盖，仍需管理员刷新页面做最终用户验收。

## 2026-09-03 管理员登录态逐项复验

- 接管用户当前管理员浏览器标签后，问题页真实地址为 `/billing-admin?tab=models&model=seedance-2.0-mini`，没有 `config_id`；这是部署前已打开的 AI 配置页继续执行旧内存代码所产生的旧地址。
- 在同一管理员会话重新加载 `/ai-config` 后点击 NewAPI 配置 29 的“设置定价”，真实跳转地址为 `/billing-admin?tab=models&config_id=29`。页面出现限定中转站提示，只显示 NewAPI 的 5 个模型；USMercari、Fumin 和未关联队列均未出现，证明 r3 的配置分组隔离本身生效。
- 逐一读取 NewAPI 5 个模型的表单后发现新的独立缺陷：每个卡片底部均正确显示 `relay_auto` 自动同步成本，但所有分辨率的“API 成本”输入框仍是 `0.000000`。
- 生产只读备份确认 `provider_route_model_costs` 已保存每个模型的真实分档成本。根因位于前端数据转换：`normalizePrice()` 只用 `model_credit_prices` 的模型级成本初始化表单，没有将当前分组已筛选出的 `provider_costs.resolution_prices` 作为空成本的回填来源。
- 修复目标：不覆盖已存在的模型手工成本；当模型成本为空且当前分组只有一个明确线路成本时，把该线路的自动/手工成本回填到对应可编辑档位，并保留来源展示和配置隔离。
- 修复后定向回归：运营计费导航、经营台账、分组隔离、成本回填、图片/视频分辨率合同共 `24/24` 通过；生产前端构建成功。
- 前端全量 Node 测试为 `1011/1012` 通过；唯一失败仍是既有的“飞拓预设不应包含 seedance-2.5”静态断言，与本次计费文件和测试无交集，本次未越界修改。

### r4 登录态上线验收与新增阻断

- r4 候选 `/opt/moli-drama/releases/billing-admin-provider-cost-fill-20260903-b41-r4` 从操作时 r3 克隆，只覆盖 `billingModelGroups.js` 与 `BillingAdmin.vue`。共享 verify-only 通过，正式审计 `protected-release-20260903T025313Z-1052062.audit` 记录 `activation_success`；数据库备份 `quick_check=ok`，切换前后活动生成任务均为 0，停机窗口 220ms。
- 管理员登录态从配置 29 进入后，NewAPI 队列严格为 1 组 5 模型；5 个模型的 480P/720P/1080P 可用档位均按数据库中的 `relay_auto` 成本正确回填，未保存或改动用户售价。
- 继续检查运营计费直达页时，页面统计区加载但模型区为 0 组 0 卡；浏览器错误为 `Cannot read properties of undefined (reading 'credits')`。根因是 Wan3 的展示函数要求 1080P，但 `emptyResolutionPrices()` 只预建 480P/720P，直达全量列表渲染到 Wan3 时中断。
- r5 修复目标：为 Wan3 的初始表单结构显式创建 1080P 档位，并增加直达页回归合同；修复后必须重新执行受保护发布与完整管理员验收，r4 不作为最终交付版本。
- r5 本地验证：计费导航、分组、成本、图片/视频分档合同 `25/25` 通过，生产构建成功；全量 Node 测试 `1012/1013` 通过，唯一失败仍为未改动的飞拓预设静态断言。

### r5 直达页验收与中转站归队修复

- r5 候选 `/opt/moli-drama/releases/billing-admin-direct-page-20260903-b41-r5` 从操作时 r4 克隆，只覆盖 `BillingAdmin.vue`；共享审计 `protected-release-20260903T032611Z-2016033.audit` 记录 `activation_success`，数据库备份 `quick_check=ok`，活动生成任务为 0，停机窗口 210ms。
- 管理员直达 `/billing-admin?tab=models` 已恢复为 15 个队列、48 张按线路展开的模型卡，Wan3 1080P 初始化异常消失。
- 逐队列核对发现 Fumin、USMercari、Token6688 的根路径与 `/v1` 路径仍被拆成两个队列。按用户“同属一个中转站的模型在一个队列”要求，中转站身份应按协议、域名和端口归一，而不是把 API 兼容路径当作不同中转站。
- 增加同域名根路径/`v1` 归队的红灯回归，确认旧逻辑产生 2 组；修改后计费相关合同 `26/26` 通过，前端构建成功。配置页携带 `config_id` 的专属入口仍按配置精确过滤，不受全局归队规则影响。

### r6 最终生产验收

- 最终候选 `/opt/moli-drama/releases/billing-admin-relay-origin-groups-20260903-b41-r6` 从操作时 r5 克隆，只覆盖 `billingModelGroups.js`；共享 verify-only 通过，审计 `/opt/moli-drama/shared/release-audit/protected-release-20260903T034537Z-2976578.audit` 记录 `activation_success`。
- 数据库备份 `/root/data/disk/moli-drama-backups/database-release-guard-20260903T034537Z-2976578.sqlite` 为 `quick_check=ok`；切换前后活动生成任务均为 0，停机窗口 230ms；当前服务健康且错误级日志为空，AI 音乐 PID 1592199/1592245 未变化。
- 管理员干净直达地址 `/billing-admin?tab=models` 实际显示 12 个中转站队列、48 张线路模型卡，页面新错误为 0；Fumin 合并为 6 个模型、USMercari 合并为 5 个、Token6688 合并为 4 个，不同域名保持独立。
- 从 AI 配置逐一点击“设置定价”复验：NewAPI #29 为 5；USMercari #15/#17 为 3/2；Fumin #20/#21/#25 为 1/2/1；ToAPIs #16/#27/#28 均为 1。每次都只有一个当前配置队列，没有混入同域名的其他配置。
- NewAPI 五模型成本输入框最终值：Mini 480P/720P 为 0.360000/0.792000 元每秒；Fast 为 1.440000/2.880000；Seedance 2.0 为 1.152000/2.160000/7.560000；Seedance 2.5 为 1.872000/4.176000/7.344000；MiniMax H3 1080P 为 1.080000。全程未点击保存、未改用户售价、未触发生成或付费。

#### 2026-09-03 六模型计费与首页匹配二次修复候选

- 纠正早期把中转站人民币显示价再次乘汇率的旧结论；实时状态为人民币显示，六模型已开放档位成本分别是 Fast 480P ¥0.20/秒、Seedance 2.0 480P ¥0.16/秒、Mini 480P ¥0.05/秒、Seedance 2.5 480P ¥0.26/秒、MiniMax 768P ¥0.03/秒、Wan 480P ¥0.15/秒。
- 运营计费成本摘要不再显示该中转站所有报价中的最大值，而只显示当前模型实际向用户开放的分辨率档位；MiniMax 新增 768P 表单合同。
- 配置 29 的六个模型价格采用单一事务写入；同名模型使用配置限定 ID，保证管理员分组、用户计费、供应商提交和最终成本结算都指向同一中转站。
- 本节是本地修复候选记录；在新的受保护激活与管理员登录态验收完成前，不替代上方 r6 的生产事实。
- 2026-09-03 上线前只读日志暴露 `alibaba/wan-3.0` 的 4 秒请求被平台通用 5 秒下限拒绝；已通过先红后绿回归同时修正任务入口和计费计算，未发起新的中转站生成。
- 生产数据库副本发现 NewAPI Fast/Mini 的限定计费身份与活动目录身份不一致，目录只有 4 个模型；新增“同名历史配置停用后仍保持 `cfg-29::` 身份”回归，修复后副本目录为 6/6。
- r3 `/opt/moli-drama/releases/newapi-six-model-20260903-db3e475d-r3` 已通过 Linux 构建、前端 `30/30`、后端 `118/118`、积分卡片审计、生产数据库双副本 6/6 目录断言和精确增量范围门禁。
- 共享 verify-only 因 ToAPIs 私人形象证据约 92.9 小时、超过 24 小时上限而拒绝；该证据刷新需要 Fast/Mini 各一次 480P、4 秒真实付费生成，上一轮总成本 ¥1.118995，门禁硬上限为合计 ¥1.70。未获明确付费授权前，r3 不激活、不写生产数据库、不做浏览器上线验收。
