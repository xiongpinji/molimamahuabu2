# 线路映射告警与系统盘处理记录（2026-08-19）

## 范围与约束

- 生产继续保持 `PROVIDER_CANARY_MODE=shadow`，不启用 `enforce`。
- 本次不进行付费生成、不修改模型价格或能力事实、不触碰 AI 音乐。
- 发布候选必须从实时 `/opt/moli-drama/current` 构建，只覆盖本次变更文件。

## `route_mapping_incomplete` 根因

生产只读清单共有 21 条线路，其中 17 条启用，2 条满足现有付费巡检前置条件。其余线路存在真实阻断，包括缺少逻辑模型、用户价格未启用、内部成本非正数、能力声明缺失或没有安全的巡检运行映射。

调度器原先把整份清单的全局映射检查结果应用到每一条启用线路：只要任意线路有阻断，全部启用线路都会被写成 `route_mapping_incomplete`。因此 17 条同类告警包含全局“连坐”造成的误报，不代表 17 个运行适配器同时失效。

修复后，映射检查按脱敏 `route_ref` 归属到单条线路；未出现在检查报告中的线路仍安全失败。全局检查结果保留用于汇总，其他数据库、存储、积分、对账和供应商只读探针语义不变。

### TDD 证据

- 红灯：同一轮检查中，一条完整线路与一条缺少逻辑模型的线路都被判定为 `route_mapping_incomplete`。
- 绿灯：完整线路为 `healthy`，只有缺配置线路为 `failed / route_mapping_incomplete`。
- 定向回归：`providerCanaryScheduler.test.js` 与 `providerCanaryInventory.test.js` 共 52 项通过、0 失败。

### 仍需后续处理的真实阻断

- `lingjing_open`、`djpsd_openapi` 等没有已证明安全的巡检提交映射，不能仅为消除告警而伪造适配器。
- TTS 尚不在主动巡检执行器覆盖范围内。
- 部分旧线路缺少 `logical_model_id`、正内部成本、已启用用户价格或能力事实。
- 单个 ToAPIs 配置承载多个上游模型，不能在没有明确拆分方案时猜测绑定关系。

在这些事实补齐并验证前，`enforce` 必须保持关闭。

## 真实阻断分类闭环

上一阶段解决了跨线路“连坐”，但单条线路仍把全部准备度阻断压缩成
`route_mapping_incomplete`，管理员无法区分应补逻辑模型、价格、成本、能力还是运行映射。
本阶段保持清单既有阻断顺序，零成本检查直接记录该线路首个可执行阻断；只有清单缺失
线路等无法归因的异常继续使用通用类别。

生产只读分类的 17 条启用线路为：

- 13 条首要阻断为 `missing_logical_model_id`；其中包含多个上游模型共用一个配置的旧线路，
  不能自动填充一个逻辑模型而把 FAST、MINI 或不同图片模型错误合并。
- 2 条文本线路首要阻断为 `cost_not_positive`，且没有能力声明；成本事实必须由管理员提供，
  本次不得猜测。
- 1 条 Fumin 图片线路准备度完整且供应商只读检查健康。
- 1 条 Token6688 图片线路准备度完整，但旧的只读目标 `/models` 返回重定向；同 Key 对
  `/v1/models` 的单次禁止重定向 GET 返回 200，因此只修正该线路的只读查询目标，不改
  生成地址、模型、价格、能力或 Key。

### 精确分类 TDD 证据

- 红灯：缺少逻辑模型的单条线路实际得到 `route_mapping_incomplete`，预期
  `missing_logical_model_id`。
- 绿灯：该线路记录首个清单阻断，完整线路仍为 `healthy`。
- 定向回归：`providerCanaryScheduler.test.js` 与 `providerCanaryInventory.test.js` 共 52 项通过、
  0 失败。
- 同批完整后端回归：1193 项中 1188 项通过、0 失败、5 项按既有条件跳过；功能锁、
  增量发布范围和本阶段定向回归共 67 项通过、0 失败。

未对 13 条旧线路批量补 `logical_model_id`，也未重新启用已停用价格。原因是配置级
`logical_model_id` 会改变 shadow 生成路由，而部分配置同时承载多个上游模型；在拆分与真实
生成证据完成前自动写值会制造错误路由，而不是修复告警。

### 生产 shadow 回读

- 从实时 `platform-stability-shadow-route-map-20260819-5794441d-r1` 克隆候选，只覆盖调度器
  实现和对应回归测试两个文件；共享门禁验证模式与正式激活均通过。
- 已激活 `platform-stability-shadow-route-category-20260819-6e50c7d2-r1`；门禁审计为
  `protected-release-20260819T135312Z-4180357.audit`，发布前数据库备份位于新数据盘。
- Token6688 配置 26 另做一致性备份后，以 compare-and-set 事务把空的只读查询目标改为
  `/v1/models`；生成验证状态与既有验证时间未变化，并写入一条管理员审计事件。
- 2026-08-19T14:00:49.316Z 的同批零成本 shadow 回读覆盖全部 17 条启用线路：2 条
  `healthy`、13 条 `missing_logical_model_id`、2 条 `cost_not_positive`；
  `route_mapping_incomplete` 为 0。
- `provider_canary_runs` 为 0，预占和实际成本均为 0；数据库 `quick_check=ok`，三类生成任务
  均为 0。服务本机健康和公开首页均返回 200，重启计数 0，启动后致命日志 0；AI 音乐两个
  进程 PID 保持 206874、206895，未被触碰。

## 系统盘安全清理

清理前根分区使用率为 96%，可用约 8.49 GB。只读核对确认当前版本、显式回滚版本、运行进程工作目录、部署锁、数据库/资产目录和 AI 音乐进程均已排除。

完成的可恢复或可重建清理：

1. 将废弃基准目录的日志、元数据、样本和源码归档到数据盘，归档 SHA-256：`127ae0610b8dea132badebdc62d3af887073fb2f3056a02d89b49a577c1203da`；随后删除其虚拟环境、模型缓存和包缓存。
2. 清理已核实可重建的 uv、pip、npm、apt 缓存，并把 systemd journal 收缩到 512 MB。
3. 在部署锁内删除 42 个早于 2026-08-10、且不被任何当前/回滚/进程/链接引用的旧 release。候选清单 SHA-256：`ce6853d0daa27ada71f6833abfcc1462385938e942a7c45175762fff3228b46d`；清理报告 SHA-256：`ca447853785c4b5969334ab8ae3ff52fa6beaee99a6ed38f33f6e744a98c311d`。

证据保存在数据盘 `/root/data/disk/moli-drama/cleanup-archives/task15-20260819/`。清理后根分区使用率为 73%，可用 `50,892,132,352` 字节。检查时主服务 PID、重启次数、健康接口、当前版本和 AI 音乐 PID 均保持不变。
