# Fumin r4 零费用派生验收结果

## 结论

- 结果：通过。
- 源状态：`fumin-full-episode-ready-20260825-r4`。
- 目标状态：`fumin-full-episode-ready-20260825-r5-resume`。
- 目标当前状态：前 6 镜均为 `completed_verified`，下一镜在本地顺序合同中只能是第 7 镜。
- 本阶段只执行本地文件派生、离线媒体复验和人工画面审核；未读取 Key，未访问 Fumin，未上传素材，未提交生成任务，未部署，未写生产数据库。

## 不可变源证据

| 项目 | SHA-256 |
| --- | --- |
| r4 `private-manifest.json` | `81cb83879271235739fdc3e9239ff569bf8faf0f860117c72cd4df68b1d8cd4d` |
| r4 第 6 镜视频 | `578519fa9be3ea5067176087cabeacee5413649d46ee7ffd941156a8b3ed4ac7` |

派生和本地 review 完成后重新计算上述两个哈希，结果与派生前完全一致。源目录未被修改。

## 第 6 镜离线复验

| 项目 | 结果 |
| --- | --- |
| 视频 SHA-256 | `578519fa9be3ea5067176087cabeacee5413649d46ee7ffd941156a8b3ed4ac7` |
| 文件大小 | 2,366,776 bytes |
| 尺寸 | 496×864 |
| 时长 | 8.096 秒 |
| 视频编码 | H.264 |
| 音轨 | AAC、双声道、存在 |
| ASR 语言 | `en`，概率 1 |
| ASR 文本 | `College kids home wash your hands and eat in this life` |
| 英文逐句合同 | 通过；所有格撇号与 ASR 连写归一化后为同一句对白 |
| 人工画面审核 | 通过 |

人工画面结论：Mateo、Elena 与固定身份包的脸型、发型和服装一致；Rafael 在前半段侧后方入镜且外观一致。暖色家庭餐桌场景连贯，未见明显人物畸变、角色漂移、品牌或可读异常文字。

原 r4 第 6 镜失败状态和错误码保留在 `revalidation` 审计字段中；目标状态先进入 `awaiting_human_review`，人工审核通过后才变更为 `completed_verified`。

## 目标状态审计

| 项目 | 数量/状态 |
| --- | --- |
| 任务 | 6；第 1–6 镜全部 `completed_verified` |
| 提交锁 | 6 |
| 镜头视频 | 6 |
| 联系表 | 6 |
| 公开逐镜证据 | 6 |
| 第 7–9 镜任务/锁/视频 | 0 |
| `references.identities` | 空对象 |
| 运行时秘密文件 | 只含 `schema_version`，不含 URL、Token 或 Authorization |
| review 后目标 manifest SHA-256 | `b696806a878f95d378c282ada99cab799b47a29c0bdd3e8a1b80bfbf1c1e773b` |

第 7 镜顺序门禁已由回归测试验证；第 8 镜会被 `FUMIN_FULL_EPISODE_SHOT_OUT_OF_ORDER` 拒绝。真正继续付费前仍必须在新授权范围内获取五分钟内的同账户余额证据，本阶段没有查询供应商余额。

## 外部动作与费用边界

| 动作 | 本阶段新增数量 |
| --- | ---: |
| 外部供应商请求 | 0 |
| 素材上传 | 0 |
| 生成 POST | 0 |
| 新供应商任务 | 0 |
| 可归因新增扣费 | 0 美元 |

“可归因新增扣费 0 美元”来自本阶段未发生供应商请求或生成提交；本阶段没有用供应商账单查询冒充实时计费验收。

## 回归证据

- 前端 Fumin 六组测试：45/45 通过，失败 0。
- 后端 Fumin 客户端测试：4/4 通过，失败 0。
- `fuminFullEpisodeDerivedState.mjs` 与 `run-redraw-fumin-full-episode-live.mjs` 语法检查退出码均为 0。
- `git diff --check` 退出码为 0；仅输出工作树既有 LF/CRLF 转换警告。

## 硬停点

该结果只证明 r5 已具备从第 7 镜继续的本地条件，不授权读取 Key、刷新供应商余额、上传素材或提交第 7–9 镜。后续真实付费阶段仍需新的明确授权，并继续遵守每镜一次、严格顺序、失败或结果未知立即停止、整集累计 25 美元上限、不合并、不部署、不写生产数据库。
