# 转绘整集静默镜头声音合同设计

## 背景与问题

真实整集本地参考包已经确认第 3、8 镜没有源对白，对应英文本地化结果也是 `turns=[]`。这两个镜头当前仍被 `silent_dialogue_contract_unsupported` 阻断，原因是参考包服务只接受至少一条英文对白，并且生成投影固定要求“生成同步英文语音”。

无对白不等于无声音。本设计把静默镜头定义为“没有对白、旁白、画外音或可理解人声，但允许生成符合画面的环境音和动作音”。目标是消除虚假的对白必填门禁，同时防止模型自行编造英文台词。

## 已确认决策

采用“服务端从源对白和本地化对白共同派生模式”的方案，不新增客户端开关或数据库列：

- 源对白与英文对白同时为空时，派生为 `silent`；
- 源对白与英文对白同时非空时，派生为 `spoken`；
- 只有一侧为空时拒绝，避免漏译、错译或客户端伪报静默；
- `silent` 仍使用 `generateAudio=true`，但只允许非人声环境音和动作音；
- 不用 `[silence]`、`(silence)` 或 `no dialogue` 等占位台词表示静默。

没有采用新增 `dialogue_mode` 数据库字段的方案。该方案审核意图更显式，但需要数据库迁移、写接口和前端表单，且仍需核对源对白事实，不能替代服务端派生。也不采用伪造静默对白条目的方案，因为供应商可能把占位文本读成语音，并污染对白哈希和说话人合同。

## 本阶段边界

本阶段只修改本地静默对白合同、生成白名单投影、本地整集 runner、测试和脱敏证据文档：

- 不读取任何供应商 Key；
- 不调用 Fumin、ToAPIs 或其他付费供应商；
- 不上传源片或参考资产；
- 不访问 `/opt/moli-drama`，不部署、不写生产数据库；
- 不恢复线上一键转绘入口；
- 不把本地合同通过宣称为英文音频、环境音、口型或整集成片已通过。

本阶段不处理全帧可见人物盘点、身份包批准、文字区域批准、文字净景或运动参考批准。这些门禁保持原样，静默合同完成后再进入下一阶段。

## 对白模式合同

参考包中的 `dialogue` 增加两个服务端字段：

```json
{
  "kind": "silent",
  "speech_required": false,
  "localized_script_version_id": 1001,
  "target_locale": "en-US",
  "script_sha256": "64位小写hex",
  "character_name_map_sha256": "64位小写hex",
  "turns": []
}
```

有声对白镜头使用：

```json
{
  "kind": "spoken",
  "speech_required": true,
  "localized_script_version_id": 1001,
  "target_locale": "en-US",
  "script_sha256": "64位小写hex",
  "character_name_map_sha256": "64位小写hex",
  "turns": [
    {
      "speaker_id": "character-001",
      "localized_text": "Come with me.",
      "start_ms": 0,
      "end_ms": 2400
    }
  ]
}
```

`kind` 和 `speech_required` 只能由服务端生成，不能加入保存参考包接口的输入白名单。它们参与规范 JSON 和参考包哈希计算。

## 服务端验证规则

参考包服务读取同一镜头的 `source_dialogue_json` 与 `localized_dialogue_json`，先确认两者都是数组，再按以下状态机处理：

| 源对白 | 英文对白 | 结果 |
| --- | --- | --- |
| 空数组 | 空数组 | `kind='silent'`、`speech_required=false` |
| 非空数组 | 非空数组 | `kind='spoken'`、`speech_required=true`，继续执行现有说话人、英文文本和时间范围校验 |
| 空数组 | 非空数组 | `REDRAW_REFERENCE_BUNDLE_DIALOGUE_REQUIRED` |
| 非空数组 | 空数组 | `REDRAW_REFERENCE_BUNDLE_DIALOGUE_REQUIRED` |
| 非数组或 JSON 非法 | 任意 | `REDRAW_REFERENCE_BUNDLE_DIALOGUE_REQUIRED` |

两种模式都继续要求：

- 版本目标语言为 `en-US`，市场为 `US`；
- `script_sha256` 是 64 位小写十六进制值；
- 角色英文名映射与 `name_map_source_sha256` 一致；
- 角色英文名映射不含中文；
- 当前参考包重建结果与已存快照一致，否则旧参考包失效。

`spoken` 模式沿用当前逐条规则：说话人必须有当前身份绑定和英文名，台词非空、不含中文，时间范围为镜头内有效整数区间。精确等于静默占位词的英文文本也视为非法，至少覆盖 `silence`、`[silence]`、`(silence)`、`silent`、`no dialogue` 和 `[no dialogue]`。

`silent` 模式必须保持 `turns=[]`，没有说话人绑定要求，但画面中可见人物仍受人脸轨迹和身份包门禁约束。不能因无对白而跳过人物审核。

## 生成白名单投影

投影对象继续使用 `generateAudio=true`。该字段表示允许模型生成音轨，不表示必须生成人声。

### 有声对白镜头

提示词保留英文对白时间轴，并明确生成同步英文语音：

```text
Dialogue mode: spoken.
Generate synchronized US English speech audio for the approved dialogue timing only.
```

### 静默镜头

提示词不输出空的 `English dialogue timing` 标题，也不输出任何伪造台词。它必须包含等价于以下内容的稳定英文约束：

```text
Dialogue mode: silent.
Do not generate spoken dialogue, voiceover, narration, chanting, or intelligible vocalization.
Generate only scene-appropriate non-speech ambience and action sound effects.
```

静默提示词仍保留目标语言、角色身份、剧情、动作、镜头、构图、节奏和可见文字覆盖要求。提示词及完整投影不得包含中文、源片路径、公网源片 URL、Key、Authorization 或内部存储信息。

`referenceBundleSnapshot` 增加：

```json
{
  "dialogue_kind": "silent",
  "speech_required": false
}
```

现有脚本哈希和角色名映射哈希继续保留。调用方只能使用服务端投影结果，不能自行覆盖 `dialogue_kind`、`speech_required`、提示词或 `generateAudio`。

## 本地整集 runner

本地整集案例继续固定第 3、8 镜为：

```json
{
  "kind": "silent",
  "speech_required": false,
  "target_locale": "en-US",
  "turns": []
}
```

runner 的规则调整为：

- `silent` 只接受空 `turns`，并且 `speech_required` 必须为 `false`；
- `spoken` 必须至少有一条有效英文 turn，并且 `speech_required` 必须为 `true`；
- 模式与 turns 不一致时形成稳定 blocker，不得 ready；
- 合法静默镜头不再产生 `silent_dialogue_contract_unsupported`；
- 静默镜头只有在人物轨迹、身份、文字、净景和运动参考等其他门禁全部批准后才能 `reference_bundle_ready=true`。

runner 生成的运动参考仍然无音轨。这里的 `generateAudio=true` 只属于后续供应商生成投影，不把源中文音轨或本地运动参考音轨带入请求。

## 兼容与失效策略

数据库结构和 `schema_version='redraw-reference-bundle-v1'` 保持不变。由于 `kind` 与 `speech_required` 进入规范哈希，缺少这两个字段的旧参考包在重读时必须失效，并要求从当前资产与审核状态重新构建。

不得为兼容旧数据而默认把缺字段解释成 `spoken`，也不得回退返回旧原始对象。这个选择会使旧参考包需要重建，但能避免旧提示词继续强制静默镜头生成人声。

## 测试与验收

### 参考包服务红灯

- 源对白与英文对白均为空时可以保存、重读和投影 `silent` 参考包；
- 静默投影为 `generateAudio=true`，包含非人声音频约束，不含英文对白时间轴或同步语音指令；
- 源空/英文非空、源非空/英文空、非法 JSON 或非数组均失败；
- `silent` 携带 turn、`spoken` 不含 turn、占位台词均失败；
- 静默镜头中的可见人物仍必须通过身份和覆盖门禁；
- 旧参考包缺少模式字段或相关哈希漂移时重读和投影失败；
- 所有失败保持数据库不变，错误序列化不泄露路径或凭据。

### 本地整集 runner 红灯

- 第 3、8 镜不再含 `silent_dialogue_contract_unsupported`；
- 两镜输出 `kind='silent'`、`speech_required=false`、`turns=[]`；
- 其他门禁未批准时两镜仍为 blocked；
- 将两镜其他门禁全部批准后可以 ready；
- silent/spoken 与 `speech_required`、turns 组合不一致时 fail closed；
- 九镜时间线、媒体哈希、无音轨运动参考、代表帧及原子输出合同不回归。

### 联合回归

至少运行参考包服务、参考包路由、生成门禁、本地整集 runner、前端整集事实合同和前端构建。通过自动化测试只证明本地合同成立；没有真实供应商终态、可播放结果和声音人工复核时，不得宣称环境音、动作音或英文对白已经生成成功。

## 下一阶段

本设计实现并完成本地证据更新后，主任务进入“全帧可见人物与文字区域审核”阶段：逐镜盘点所有可辨认人物和文字区域，补齐身份包、文字净景及人工审核状态。只有九镜参考包全部 ready 后，才能另行准备一次真实付费整集验证；该调用仍需新的明确授权。
