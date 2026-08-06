# 一键转绘阶段 2 到阶段 3 同链修复计划

> 目的：修复源片分析、本地化版本、资产审核和分镜生成之间的真实数据断点。该计划不配置生产模型、不发起付费生成、不部署生产。

## 已确认问题

1. 源片分析会创建 `redraw_versions.version=1` 和源分镜，但 `redraw_works.current_version` 仍为 `0`，作品详情无法回读分析产物。
2. `createLocalizationVersion` 只创建版本记录，不为新版本物化分镜与角色、场景、物品资产草稿。
3. 没有分镜的版本会被审核门禁当成没有缺失引用，从而错误开放第三步。
4. 资产生成入口需要已有 `redraw_assets.id`，但真实本地化流程没有创建首个资产草稿。
5. 阶段 2 报告仍为 `blocked`，没有当前转绘版本绑定的已审批资产链，也没有已验证视频模型证据；因此本计划完成后仍不能自动声称“完整出片”。

## 成功标准

- 分析成功后，作品的 `current_version` 指向已写入的源事实版本，刷新可回读源分镜。
- 创建目标语言版本时，在同一事务内创建目标版本、目标分镜和角色/场景/物品资产草稿，并最后更新 `current_version`。
- 目标分镜保留源时间码、事实字段和源对白；本地化对白只写入 `localized_dialogue_json`，不覆盖源事实。
- 分镜引用只指向同租户、同用户、同版本的数值 `redraw_assets.id`；不存在跨版本或客户端伪造引用。
- 首次生成复用该资产的草稿版本；重试才追加新版本，避免 UI 出现一个永远不可用的孤儿草稿卡片。
- 零分镜、零必要资产或存在未审批引用时，单镜和批量生成门禁都必须 fail closed；不创建供应商任务和积分 reservation。
- 定向测试、完整后端测试、前端相关测试、构建、Chromium E2E 和 `git diff --check` 全部通过。

## 当前执行状态

| 任务 | 状态 | 证据 |
| --- | --- | --- |
| 任务 1：源事实版本指针 | 已完成 | `a69bd5c4`；事实写入、指针更新和冲突回滚同事务 |
| 任务 2：本地化版本物化 | 已完成 | `a69bd5c4`；目标版本、分镜和资产草稿原子物化 |
| 任务 2A：真实本地化编排入口 | 阻塞 | 前端未调用 `createVersion`，尚无真实目标语言任务和账单闭环 |
| 任务 2B：真实资产报价与供应商接入 | 阻塞 | 路由现仅支持依赖注入，应用总路由尚未提供 `assetQuoteProvider/assetGenerationProvider` |
| 任务 3：草稿认领与重试 | 已完成 | `02018249`；首次草稿认领、并发和零冻结 fail closed |
| 任务 4：审核门禁 | 已完成 | `02018249`；只接受同版本 `redraw_assets.id`，零分镜 fail closed |
| 任务 5：同链结构回归 | 已完成但真实门禁未解除 | 完整后端 `865 pass / 0 fail / 1 skip`；真实模型与当前版本绑定仍缺失 |

## 任务 1：修复源事实版本指针

**文件：**

- 修改 `backend-node/src/services/redrawOrchestrator.js`
- 修改 `backend-node/test/redrawAnalysis.test.js`

先添加失败测试：首次写入事实后 `current_version=1`；重复回读不新增版本/分镜；事实哈希冲突不改变当前指针。实现时把版本、分镜、作品指针和步骤状态放在现有事务内更新。

## 任务 2：原子物化本地化版本

**文件：**

- 修改 `backend-node/src/services/localizationService.js`
- 修改 `backend-node/test/redrawLocalization.test.js`

先添加失败测试，再让 `createLocalizationVersion` 在同一事务内：

1. 追加目标语言版本；
2. 以源事实稳定 ID 创建角色、场景、物品草稿资产；
3. 克隆源分镜的时间码、开场、连续动作、镜尾和源对白；
4. 将本地化对白按 `shot_id` 写入目标分镜；
5. 用目标版本资产 ID 写入结构化引用；
6. 所有写入成功后才更新 `current_version`。

任一步失败应整体回滚，不留下空版本或部分资产。

## 任务 2A：补齐真实本地化编排入口

**已确认断点：** 当前前端只调用源片分析接口，从未调用 `createVersion`；分析完成后直接进入资产审核会读到 `locale=source` 的源版本。禁止把源语言对白、空名称映射或客户端拼装结果冒充目标语言版本。

在实现前先补充独立设计，明确：

- 用户点击“开始分析”时是否一次确认并预扣源片分析与文本本地化两项费用，还是在分析后进行第二次明确确认；
- 文本本地化必须选择通过真实生成证据的 `text_localization` 能力，不能回退到默认或硬编码模型；
- 供应商结果必须经过 `normalizeLocalizationResult`、事实哈希校验和目标语言对白时长质检，成功后才能调用 `createLocalizationVersion`；
- 异步任务、reservation、供应商任务 ID、重启恢复和失败释放必须与源片分析同等级可审计；
- 前端只有在目标版本创建成功后才能进入资产审核，失败或未知状态停留在第一步并显示真实原因。

该入口接通并通过真实文本生成前，即使本计划的结构物化测试通过，产品仍保持 `blocked`。

## 任务 2B：接入真实资产报价和生成供应商

**已确认断点：** `redrawRoutes` 支持注入 `assetQuoteProvider` 和 `assetGenerationProvider`，但应用总路由当前只传入 `{ cfg }`。因此生产形态下资产报价恒为未配置、资产生成能力不可用，测试 provider 不能作为真实接入证据。

实现前必须：

- 从已通过真实生成和可读产物验证的图片/TTS 能力中按资产 kind、locale、market 解析服务端模型；
- 使用服务端模型和价格生成 GET 报价，POST 时重新报价并生成不可变计费快照；
- 客户端不得提交模型、积分、reservation 或供应商任务 ID；
- 把图片、三视图、去人净景和目标语言 TTS 适配到现有供应商服务，保留供应商 task ID、重启恢复、失败退款和产物可读验证；
- 去人净景必须继续通过尺寸、遮罩变化和非遮罩相似度门禁；
- 未完成同链真实生成前不得把模型加入转绘目录，也不得开放第三步。

## 任务 3：首个资产草稿与重试版本语义

**文件：**

- 修改 `backend-node/src/services/redrawAssetService.js`
- 修改 `backend-node/test/redrawAssets.test.js`

首次生成应原子认领尚未提交的同来源草稿并转为 `processing`；明确失败或已生成后再次生成才追加下一版本。并发认领只能有一个赢家，不能重复冻结积分或重复提交供应商任务。

## 任务 4：审核门禁 fail closed

**文件：**

- 修改 `backend-node/src/services/redrawReviewService.js`
- 修改 `backend-node/test/redrawReviewGate.test.js`
- 视接口合同需要修改 `backend-node/test/redrawRoutes.test.js`

增加结构化阻塞原因：`shots_missing`、`required_assets_missing`、`asset_not_approved`。零分镜或本地化资产尚未生成/审批时均不得进入第三步；审核状态变化后重新计算并更新作品步骤。

## 任务 5：同链回归与真实门禁判定

建立一个不调用外部供应商的集成测试：源片分析完成 → 创建本地化版本 → 回读分镜/资产 → 审核门禁阻塞 → 资产变为可读且逐项批准 → 门禁开放 → 生成入口读取同一版本快照。

完成本地回归后，再检查是否存在目标语言、风格、TTS 和视频模型的真实成功终态及可读产物。只有全部证据存在且绑定到当前转绘版本，才能进入付费的阶段 3 Task 7；否则保持 `blocked` 并记录缺失项。
