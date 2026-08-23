# 转绘 V2 目标侧对白绑定设计

## 背景

通用一键转绘的 V2 链路已经把源片事实、本地化结果和逐镜参考准备分开持久化：

- `redraw_versions.source_facts_json` 与 `facts_hash` 保存不可变源片事实；
- `redraw_versions.name_map_json` 保存当前目标语言的角色姓名映射；
- `redraw_shots.source_dialogue_json` 保存源对白；
- `redraw_shots.localized_dialogue_json` 保存当前目标语言对白；
- `redraw_versions.locale` 与 `market` 保存目标语言和市场。

现有参考包实现却仍要求 `source_facts_json.script_sha256` 和
`source_facts_json.name_map_source_sha256`。V2 源事实白名单不生成这两个字段，而且本地化目标姓名和目标对白在源事实冻结之后才产生。生产数据库还通过不可变触发器禁止修改 V2 源事实。因此合法的上传、分析、本地化、角色准备和逐镜净景链路最终必然在保存参考包时失败为
`REDRAW_REFERENCE_BUNDLE_DIALOGUE_REQUIRED`。

这不是测试夹具缺字段，而是目标侧证据被错误放进源事实合同造成的结构性不可达。

## 目标

本设计只修复 V2 目标侧对白绑定，使真实项目可以从当前服务端本地化数据构建逐镜参考包，并使任何目标对白、目标姓名、地区、时间轴或源事实漂移都能在积分冻结和供应商调用前失效。

完成后必须满足：

1. 真实 V2 本地化结果无需伪造源事实字段即可构建参考包；
2. 目标绑定完全由当前 owner、version 和 shot 范围内的服务端数据派生；
3. `source_facts_json` 保持不可变，不迁移、不回填目标侧字段；
4. 旧参考包一律 fail-closed，并要求从当前证据重建；
5. `es-ES/ES`、`en-US/US` 等合法 locale/market 均使用同一合同，不硬编码美国；
6. Task8 的真实三镜 SQLite 与本地媒体链能够越过参考包对白门禁。

## 非目标

本阶段不做以下事情：

- 不修改本地化模型提示词、翻译策略或目标台词文案；
- 不新增可由客户端提交的对白、姓名、locale、market 或哈希字段；
- 不新增数据库表或列；
- 不迁移或补写历史 `source_facts_json`；
- 不自动修复、默认接受或兼容读取旧参考包；
- 不调用真实供应商、不产生付费任务、不部署生产。

## 方案选择

### 方案 A：服务端实时派生目标侧绑定（采用）

参考包服务在构建和重读时，从当前版本与镜头行读取姓名、对白、locale、market、facts hash 和时间轴，规范化后计算绑定哈希。绑定写入现有参考包 JSON 和生成请求快照。

优点：不迁移数据库；数据职责清晰；每次重读都能与当前事实复核；客户端无法伪造。缺点：参考包重读时需要重新计算少量规范 JSON 哈希。

### 方案 B：复用 `localization_model_snapshot_json`

把目标绑定写入本地化模型快照。改动看似较小，但模型运行输入证据与最终业务输出证据混在同一字段，手工本地化、恢复任务和后续模型切换都会增加歧义，因此不采用。

### 方案 C：新增目标绑定数据库列

为版本或镜头新增多个哈希列。查询直观，但需要迁移、旧库兼容、回填、并发写入和更多 setter。本设计没有跨参考包复用这些独立列的需求，因此不采用。

## 数据来源与信任边界

目标侧绑定只能读取以下服务端当前行：

- `redraw_versions.id`；
- `redraw_versions.tenant_id`、`user_id`；
- `redraw_versions.facts_hash`；
- `redraw_versions.locale`、`market`；
- `redraw_versions.name_map_json`；
- `redraw_shots.id`、`shot_id`、`version_id`；
- `redraw_shots.start_ms`、`end_ms`、`duration_ms`；
- `redraw_shots.source_dialogue_json`；
- `redraw_shots.localized_dialogue_json`。

查询必须继续使用当前 `tenant_id + user_id + version_id + shot_id` 所有权范围。保存参考包接口的输入白名单不增加任何字段。客户端提交的 locale、market、姓名映射、对白、路径、URL、hash、审核结论或 provider 信息继续按输入非法拒绝。

`source_facts_json` 只通过已持久化的 `facts_hash` 参与绑定。参考包服务不得从中读取目标姓名、目标对白或目标侧哈希。

## 规范化合同

### locale 与 market

- locale 使用现有 BCP 47 形态检查并保留当前版本值；
- market 必须为两个大写字母；
- 不把任一 locale 或 market 默认为 `en-US/US`；
- 身份包 `target_country` 继续精确等于当前版本 market。

### 角色姓名映射

`name_map_json` 必须是普通对象。键和值均去除首尾空白，空键、空值、重复规范键或非法 JSON 均拒绝。输出对象按键排序后使用项目现有 stable JSON 规则计算：

```text
character_name_map_sha256 = sha256(stableJson(canonical_name_map))
```

映射中的目标姓名不得含中文；有声对白中的每个 `speaker_id` 必须存在于当前姓名映射并具有当前身份绑定。

### 源对白

`source_dialogue_json` 必须是数组。静默数组保持 `[]`。非空条目规范为当前服务端可识别的稳定字段：

```json
{
  "id": "可选稳定 turn id",
  "speaker_id": "稳定源角色 id",
  "source_text": "源对白文本",
  "start_ms": 0,
  "end_ms": 1200
}
```

`source_text` 从既有 `source_text` 或兼容字段 `text` 读取；规范结果不保留其他未知字段。条目按 `start_ms`、`end_ms`、`speaker_id`、`id` 排序后计算：

```text
source_dialogue_sha256 = sha256(stableJson(canonical_source_dialogue))
```

非法 JSON、非数组、空说话人、空文本或越出当前镜头的时间范围均按对白门禁失败。静默镜头不创建占位台词。

### 目标对白

沿用现有有声/静默状态机：

| 源对白 | 目标对白 | 结果 |
| --- | --- | --- |
| 空数组 | 空数组 | `kind='silent'`、`speech_required=false` |
| 非空数组 | 非空数组 | `kind='spoken'`、`speech_required=true` |
| 空数组 | 非空数组 | 拒绝 |
| 非空数组 | 空数组 | 拒绝 |

有声目标条目继续严格规范为：

```json
{
  "speaker_id": "稳定源角色 id",
  "localized_text": "目标语言对白",
  "start_ms": 0,
  "end_ms": 1200
}
```

条目按 `start_ms`、`end_ms`、`speaker_id` 排序。空文本、静默占位词、中文残留、未绑定说话人、非法时间范围或非法 JSON 均拒绝。

```text
script_sha256 = sha256(stableJson(canonical_localized_dialogue))
```

`script_sha256` 从本设计开始明确表示当前镜头目标对白的规范哈希，不再表示源事实中的不透明测试值。

## 总绑定

服务端构造以下规范对象：

```json
{
  "contract": "redraw-localization-binding-v1",
  "version_id": 5001,
  "facts_hash": "64位小写hex",
  "target": {
    "locale": "es-ES",
    "market": "ES"
  },
  "shot": {
    "id": 6001,
    "shot_id": "shot-1",
    "start_ms": 0,
    "end_ms": 4000,
    "duration_ms": 4000
  },
  "source_dialogue_sha256": "64位小写hex",
  "script_sha256": "64位小写hex",
  "character_name_map_sha256": "64位小写hex"
}
```

然后计算：

```text
localization_binding_sha256 = sha256(stableJson(binding))
```

`facts_hash`、所有组成哈希和总绑定必须为 64 位小写十六进制。任一组成字段变化，都必须形成新的总绑定。

## 参考包 V2

参考包 schema 升级为：

```text
redraw-reference-bundle-v2
```

`dialogue` 投影至少包含：

```json
{
  "localized_script_version_id": 5001,
  "target_locale": "es-ES",
  "target_market": "ES",
  "kind": "spoken",
  "speech_required": true,
  "turns": [],
  "source_dialogue_sha256": "64位小写hex",
  "script_sha256": "64位小写hex",
  "character_name_map_sha256": "64位小写hex",
  "localization_binding_sha256": "64位小写hex"
}
```

静默镜头必须为 `kind='silent'`、`speech_required=false`、`turns=[]`，但仍产生源对白、目标对白、姓名映射和总绑定哈希。画面中的人物仍受身份与覆盖门禁约束。

参考包规范哈希继续覆盖完整 V2 bundle。因此 dialogue 任一字段变化都会使 `reference_bundle_hash` 变化。

## 保存、重读与生成投影

### 保存

1. 在同一 owner/version/shot 范围查询当前版本和镜头；
2. 验证当前 CAS `expected_updated_at`；
3. 规范化并验证姓名、源对白和目标对白；
4. 计算四个哈希和总绑定；
5. 继续验证人物、身份、服装、文字净景和运动参考；
6. 只在全部门禁通过后保存 V2 参考包与 bundle hash。

任一步失败均不得部分更新参考包。

### 重读

`loadCurrentReferenceBundle` 必须从当前数据库行重新计算目标侧绑定，并与已存 V2 bundle 逐项比较。以下任一情况均 fail-closed：

- schema 不是 `redraw-reference-bundle-v2`；
- V2 必需字段缺失；
- 当前组成哈希或总绑定与已存值不同；
- bundle hash 与规范 V2 bundle 不符；
- 当前 owner/version/shot、身份、净景或运动证据失效。

旧 V1 包不得自动升级、默认补字段或继续投影；读取结果使用现有 `REDRAW_REFERENCE_BUNDLE_NOT_FOUND` 边界，要求重新准备和保存。

### 生成请求快照

`referenceBundleSnapshot` 继续保留现有字段，并加入：

```json
{
  "schema_version": "redraw-reference-bundle-v2",
  "dialogue_kind": "spoken",
  "speech_required": true,
  "source_dialogue_sha256": "64位小写hex",
  "dialogue_script_sha256": "64位小写hex",
  "character_name_map_sha256": "64位小写hex",
  "localization_binding_sha256": "64位小写hex"
}
```

生成服务的请求复用比较必须核对以上全部字段。旧 generation 缺任一 V2 字段时不得复用，也不得因为幂等键相同而绕过。

生成 prompt 只能使用已经进入绑定的规范 `turns`、locale、market 和姓名映射。不得重新读取客户端输入或回退到源中文对白。

## 错误与副作用

沿用稳定错误边界：

- 当前姓名、对白、locale、market、facts hash 或时间轴非法：`REDRAW_REFERENCE_BUNDLE_DIALOGUE_REQUIRED`；
- 当前保存 CAS 漂移：`REDRAW_REFERENCE_BUNDLE_CONFLICT`；
- 旧 V1、缺失或已过期参考包重读：`REDRAW_REFERENCE_BUNDLE_NOT_FOUND`；
- 安全生成投影无法形成：`REDRAW_REFERENCE_BUNDLE_PROJECTION_FAILED`。

错误响应只返回稳定 code 与通用文案，不返回数据库内容、绝对路径、URL、Key、Authorization、底层错误或原始 cause。

所有失败必须发生在以下副作用之前：

- 参考包状态写入；
- generation 或 provider attempt 创建；
- 积分预占、确认或扣减；
- 调度器提交；
- 供应商网络调用。

付费生成进入事务前和事务内的两次参考包门禁都必须重算当前 V2 绑定，防止对白或姓名在预检后漂移。

## 兼容策略

采用明确的 fail-closed 重建策略：

- 不迁移旧 bundle JSON；
- 不写回旧 `source_facts_json`；
- 不从旧 `script_sha256` 推断新目标对白哈希；
- 不把缺失 V2 字段解释为默认值；
- 不复用旧 generation request snapshot；
- 旧版本如需继续生成，必须重新运行参考准备并保存 V2 包。

该选择会使历史 V1 包需要重建，但避免把没有真实目标对白绑定的旧证据继续用于付费生成。

## 测试设计

实现必须按测试驱动顺序完成。

### 参考包服务

先建立以下红灯：

1. 真实 V2 source facts 不含两个旧测试字段，但当前 `name_map_json` 与 `localized_dialogue_json` 完整时可构建 V2 包；
2. `script_sha256` 等于当前规范目标对白哈希，而不是源事实字段；
3. `es-ES/ES` 身份、姓名和对白可以形成当前绑定；
4. 静默源/目标对白形成合法 V2 静默绑定；
5. 姓名、目标对白、源对白、locale、market、facts hash、shot id 或时间轴任一漂移都会拒绝旧包；
6. 非 owner、跨版本或跨镜头数据不能进入绑定；
7. 旧 V1 包、缺字段包和伪造哈希包全部 fail-closed；
8. 对外结果不含源事实 JSON、源中文对白、路径、URL 或凭据。

### 本地化真实链

使用正式 V2 episode facts 和 `localizationService` 物化目标版本，不手工更新不可变源事实。随后直接调用正式参考包服务，证明目标姓名和逐镜目标对白可以到达 V2 参考包。

### 生成与计费门禁

覆盖：

- V2 请求快照保存四个对白绑定字段；
- 同一快照可按现有幂等规则复用；
- 任一绑定字段漂移后旧 generation 不复用；
- 事务前或事务内漂移时 reservation、provider attempt、video generation 和 schedule 均为 0；
- 错误保持脱敏。

### Task8 三镜 E2E

恢复已暂停的三个测试/fixture 文件，删除任何伪造 source facts 目标字段的尝试。真实链必须完成：

```text
上传本地媒体
→ V2 分析事实
→ es-ES/ES 本地化
→ 两角色身份/服装/声音准备
→ 三镜人物与文字净景
→ 运动参考
→ 逐镜 V2 参考包保存与重读
→ 生成前门禁
```

三镜中有声与静默镜头都必须通过；所有媒体仍为本地 fixture，供应商调用和积分消耗保持 0。

## 验收标准

书面实现完成后，至少需要以下同次新鲜证据：

- 参考包、静默对白、本地化、生成快照和计费门禁相关 Node 测试全部通过；
- Task8 精准三镜 Playwright 用例通过；
- 后端全量 0 fail；
- 前端受影响测试与生产 build 通过；
- `node --check`、`git diff --check` 和特性锁审计通过；
- 工作树只保留明确暂停或预存的非提交现场；
- 供应商调用 0、付费 0、部署 0、生产数据库写入 0。

只有上述门禁完成，Task8 才能从“对白绑定结构性阻塞”升级为“本地三镜参考准备链已通过”。这仍不等于真实供应商整集生成或正式客户交付；后者需要独立付费授权、结果文件验收和整集导出验收。
