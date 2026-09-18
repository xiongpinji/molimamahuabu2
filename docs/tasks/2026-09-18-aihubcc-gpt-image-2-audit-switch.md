# AIHubCC 图片节点审计模型切换证据（2026-09-18）

## 结论

- `gpt-image-2-3.5k` 付费探针失败：HTTP 503，`model_not_found`（config id 24，约 952ms）。
- `gpt-image-2` 真实生成成功并落盘可读 PNG，作为当前已审计参考图适配器模型。

## 探针（无密钥）

| 模型 | config_id | HTTP | ok | ms | code |
|---|---|---|---|---|---|
| gpt-image-2-3.5k | 24 | 503 | false | 952 | model_not_found |
| gpt-image-2 | 24 | 200 | true | ~39514 | （生成成功） |

## 可读产物

- 路径：`%TEMP%/aihubcc-smoke/artifacts/gpt-image-2-1789699250497.png`
- bytes：503522
- PNG 魔数：`89 50 4E 47 0D 0A 1A 0A`
- `readablePng`：true

## 代码对齐

- 前后端 `isAudited*Reference*` 模型条件改为 `gpt-image-2`
- 前端目录移除不可用的 `gpt-image-2-3.5k`
- e2e 真实同链默认模型改为 `gpt-image-2`
