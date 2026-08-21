# 逐模型证据绑定的零中断拆分设计

**日期：** 2026-08-20
**状态：** 已确认设计，待实现计划
**首个适用目标：** 生产配置 16，ToAPIs `seedance-2-fast` / `seedance-2-mini`

## 1. 目标

在不让已公开的任一模型临时消失、不自动触发付费巡检、不削弱真实生成验证门禁的前提下，把一个承载多个上游模型的供应商配置拆为单模型配置，并为每个单模型线路分别绑定：

- 逻辑模型 ID；
- 逐模型真实验证证据；
- 逐模型能力；
- 供应商线路成本及分辨率档位。

拆分完成后，用户在 `shadow` 模式下继续看到并使用原有模型；管理员必须另行逐条授权付费巡检，才可解除该线路的巡检暂停。

## 2. 非目标

- 不修改用户积分价格、积分预占、冻结、退款或 `canvas-credit-callout-v1`。
- 不把历史用户生成结果当作 fresh 主动巡检证据。
- 不自动调用供应商、不自动解除巡检暂停、不启用 `enforce`。
- 不处理缺少逐模型真实证据的多模型配置。Token6688/Gemini 配置 11 在补齐证据前必须保持原状。
- 不改变现有 `--apply` 的保守语义，不允许普通拆分自动继承验证状态。
- 不触碰 AI 音乐、运行资产或其他项目会话的发布内容。

## 3. 方案选择

采用“已有逐模型证据的原子拆分”。只有源配置使用相同连接凭据、每个模型都已保存独立能力与真实证据哈希时，才允许在一个事务中将源配置缩窄并创建已验证的单模型线路。

未采用以下方案：

- **通用隐藏候选线路：** 需要新增候选状态、迁移、内部验证入口和目录隔离，范围明显更大。
- **现有普通拆分：** 非默认模型会先变成停用且未验证，造成用户目录短暂缺失。

## 4. 命令合同

扩展 `backend-node/scripts/split-multi-model-provider-configs.js`，保留现有 dry-run 和 `--apply`，新增独立模式：

```text
--db <sqlite-file>
--config-id <positive-integer>
--apply-evidence-bound
--expected-fingerprint <sha256>
--binding-file <json-file>
```

`--apply-evidence-bound` 必须同时提供期望指纹和绑定文件；不能与 `--apply` 同时出现。缺少任一参数、参数重复或出现未知参数都在打开写事务前失败。

绑定文件格式固定为：

```json
{
  "schema_version": 1,
  "source_config_id": 16,
  "models": [
    {
      "model": "seedance-2-fast",
      "logical_model_id": "seedance-2-fast",
      "evidence_contract": "toapis-video-real-verification-v1",
      "evidence_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "route_cost": {
        "currency": "CNY",
        "cost_unit": "second",
        "micros_per_unit": 280000,
        "resolution_prices": {
          "480p": { "micros_per_unit": 280000 },
          "720p": { "micros_per_unit": 560000 }
        }
      }
    },
    {
      "model": "seedance-2-mini",
      "logical_model_id": "seedance-2-mini",
      "evidence_contract": "toapis-video-real-verification-v1",
      "evidence_sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "route_cost": {
        "currency": "CNY",
        "cost_unit": "second",
        "micros_per_unit": 100000,
        "resolution_prices": {
          "480p": { "micros_per_unit": 100000 },
          "720p": { "micros_per_unit": 200000 }
        }
      }
    }
  ]
}
```

绑定文件禁止包含 Key、Base URL、Endpoint、供应商任务 ID、提示词或用户数据。命令输出只允许包含配置数字 ID、模型名、逻辑模型 ID、稳定指纹和执行状态。

## 5. 资格校验

所有校验必须在写事务前执行一次，并在 `BEGIN IMMEDIATE` 事务内重新执行一次：

1. 源配置存在、未删除、`is_active=1`、`verification_status='verified'`，且确实包含两个或更多不同模型。
2. `source_config_id`、配置参数和绑定文件一致。
3. 实时配置指纹等于 `--expected-fingerprint`。
4. 绑定文件模型集合与源配置模型集合完全相同，不允许缺少、重复或额外模型。
5. 每个源模型在 `verified_capabilities` 中都有独立对象；该对象中的 `evidence_contract` 和 `evidence_sha256` 必须与绑定文件完全一致。
6. 每个逻辑模型在 `model_credit_prices` 中存在启用且为正数的用户积分价格。
7. 每个 `route_cost` 必须通过 `providerRouteCostService` 的正成本、单位、分辨率和安全整数校验；视频能力声明中的每个公开分辨率必须有对应成本档位。
8. 数据库中不存在与目标源连接和目标上游模型重复的未删除单模型配置。不同供应商的同逻辑模型备路由不属于冲突。
9. 源配置尚未被证据绑定拆分；重复执行必须返回安全的已拆分状态或明确失败，不得继续创建克隆。

任一条件不满足时数据库零变化，stderr 只输出固定错误码，不回显绑定文件内容、证据原文或连接字段。

## 6. 原子写入

通过二次校验后，在同一个 SQLite `IMMEDIATE` 事务中完成：

1. 以源配置的 `default_model` 作为保留在原 ID 上的模型。
2. 原配置的 `model` 缩窄为单元素数组，`default_model` 保持不变。
3. 原配置只保留默认模型对应的 `verified_capabilities`；`logical_model_id` 使用该模型绑定值。
4. 其他模型各创建一个克隆。克隆继承同一连接凭据和协议，但强制 `is_default=0`，`model` 为单元素数组，`default_model` 为当前模型。
5. 克隆只保存当前模型的能力对象。仅因资格校验已经证明“相同连接凭据 + 精确模型 + 精确真实证据哈希”，克隆才允许继承 `verification_status='verified'`、验证时间和管理端证据摘要。
6. 原配置和所有克隆均保持 `is_active=1`，分别写入绑定的 `logical_model_id`。
7. 原配置和所有克隆统一写 `canary_paused=1`，防止调度器因成本齐备而自动付费。
8. 使用 `providerRouteCostService.setRouteCost` 为每个最终 `config_id` 写独立线路成本和档位；该操作产生各自成本指纹，并按既有合同失效旧巡检证据。
9. 写一条脱敏管理员审计记录：动作固定为 `provider.config.evidence_bound_split`，执行主体固定为内部 `system/cli`；详情仅包含源配置 ID、最终配置 ID、模型名和操作类型。

任何插入、成本写入、证据失效或审计失败都使整个事务回滚。

## 7. 运行时与公开目录语义

- 生产继续为 `PROVIDER_CANARY_MODE=shadow`。
- `canary_paused=1` 只阻止主动巡检调度，不停用用户业务线路；公开路由仍以 `is_active + verified + logical_model_id` 选择候选。
- FAST 和 MINI 拆分后各有独立逻辑模型、独立线路成本和独立能力，不再共享一个 `config_id`。
- 新线路没有 fresh 主动巡检证据，因此管理端显示 would-be-hidden；`shadow` 下仍服务，`enforce` 下会被隐藏。此设计不授权启用 `enforce`。
- 后续付费巡检必须逐线路、逐次获得预算授权。管理员只解除当前获批线路的 `canary_paused`；任何结果未知立即停止且不重试。

## 8. TDD 验收

### 8.1 正向合同

- ToAPIs 风格的双模型 fixture 能在一个事务中拆为两个启用、已验证、巡检暂停的单模型配置。
- 原配置保留 FAST，克隆承载 MINI；两者逐模型能力无串线。
- 两条线路分别返回正确成本、720p 档位、成本指纹和逻辑模型 ID。
- 拆分前后的 `shadow` 公共模型集合完全一致。
- `selectVerifiedCandidates` 对 FAST/MINI 分别只选择对应单模型配置。
- 调度器看到两条线路均为 `canary_paused`，实际执行器调用次数为 0。

### 8.2 失败与回滚

- 配置 11 风格的空逐模型能力/证据必须被拒绝。
- 模型集合缺失、额外、重复或默认模型不在集合中时拒绝。
- 指纹过期、证据合同不一致、证据哈希不一致时拒绝。
- 用户积分价格缺失/停用/为零时拒绝。
- 线路成本缺失、为零、单位非法、档位缺失或溢出时拒绝。
- 目标单模型配置冲突时拒绝。
- 克隆插入、线路成本、证据失效或管理员审计任一失败时，源配置、克隆、成本和审计全部回滚。
- 重复执行不创建额外克隆。

### 8.3 保密与回归

- stdout/stderr、异常消息和审计摘要不出现 Key、Base URL、Endpoint、证据原文或绑定文件原文。
- 现有 dry-run/`--apply` 全部回归通过，普通拆分仍创建停用、未验证克隆。
- 主动巡检 inventory、scheduler、executor、public gate、canvas catalog、管理员成本接口和功能锁回归通过。

## 9. 发布边界

本设计和后续本地实现不构成生产写授权。生产执行仍需：

1. 重新 SSH 读取实时 `/opt/moli-drama/current`；
2. 审计其他会话冲突；
3. 从实时 current 构建增量候选；
4. 备份共享 SQLite、取得部署锁并固定配置指纹；
5. 使用受保护发布门禁，不整体覆盖，不触碰 AI 音乐；
6. 单独获得生产数据库拆分授权；
7. 单独获得每一次付费巡检及成本硬上限授权；
8. readiness 达到 100% 且再次获批前保持 `shadow`。
