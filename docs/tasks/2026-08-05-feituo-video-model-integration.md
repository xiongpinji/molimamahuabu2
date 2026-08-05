# 飞拓视频模型接入任务（2026-08-05）

## 目标与边界

- 仅接入已完成真实生成验证的两个视频模型：MiniMax H3-2k 与 Seedance 2.0 Fast 480p 超分 1080p。
- 使用独立 `feituo_open` 协议，不复用接口不兼容的现有供应商协议。
- 不在代码、文档、提交记录或日志中保存 API Key。
- 未完成真实生成、结果文件读取与积分定价审计前，不向生产用户开放模型。

## 文档合同

- API 基址：`https://feituokuajing.com`
- 鉴权：`Authorization: Bearer <API_KEY>`
- 创建任务：`POST /api/open/v1/video/generate`
- 查询任务：`GET /api/open/v1/video/status?jobId=<jobId>&_=<timestamp>`
- `submitted` 为非终态，必须继续查询同一个 `jobId`，不得自动重新提交。
- 成功结果优先使用公开的 `remoteVideoUrl`，其次使用 `videoUrl`。

### 已验证模型

| 展示名 | 模型 ID | 时长 | 比例 | 素材上限 | 供应商价格 |
| --- | --- | --- | --- | --- | --- |
| MiniMax H3-2k | `sdas-lm-hailuo-h3-2k` | 4–15 秒 | 1:1、16:9、9:16、3:4、4:3、21:9 | 图片 9、视频 0、音频 3 | ¥0.18/秒 |
| Seedance 2.0 Fast 480p 超分 1080p | `sdas-my-seedance-2.0-fast-upscaled-1080p` | 4–15 秒 | 21:9、16:9、4:3、1:1、3:4、9:16 | 图片 4、视频 3、音频 1 | ¥2.80/次 |

## 真实生成证据

测试提示词为无人物、无文字的未来城市镜头，比例 `16:9`，时长 4 秒。以下证据不含密钥。

### Seedance 2.0 Fast 480p 超分 1080p

- `jobId`: `cmsg6chrw1nawcldfjoa9lvr9`
- 供应商任务号：`task_ty8pXGdT2IpLicYK7rp783CfbibwMGAP`
- 终态：`success`
- 扣费：¥2.80
- 结果主机：`files.sudashuiapi.com`
- 结果路径：`/proxy/outputs/my/task_1785939645064_pifrkr1x_video_generation.mp4`
- 读取校验：HTTP 200，`video/mp4`，2,059,719 字节，MP4 `ftyp` 文件头通过。

### MiniMax H3-2k

- `jobId`: `cmsg6ch471naocldf9bm9q0p7`
- 供应商任务号：`task_j05rChwaEFBWpbYsuKmniyCBRMEwe9ZR`
- 终态：`success`
- 扣费：¥0.72（4 秒 × ¥0.18/秒）
- 结果主机：`files.sudashuiapi.com`
- 结果路径：`/proxy/outputs/lg/ae17931a-db80-4d03-a4e4-9cd8ac792e4e.mp4`
- 读取校验：HTTP 200，`video/mp4`，2,920,651 字节，MP4 `ftyp` 文件头通过。

账户余额由 ¥10.00 变为 ¥6.48，与两次生成合计 ¥3.52 一致。测试任务中断后仅查询原任务，未重新提交。

## 验收标准

1. 单元测试覆盖模型约束、创建请求、非终态、成功终态、失败终态和生产入口路由。
2. `submitted` 不被误判为成功；创建连接中断返回“结果未知”，不得隐式重提。
3. 成功终态优先返回 `remoteVideoUrl`。
4. 本地定向测试、完整后端测试与前端构建通过。
5. 生产候选从实时 `/opt/moli-drama/current` 克隆，只应用本任务改动并保留既有供应商适配。
6. 生产入库前明确两种模型的积分计价，候选通过共享发布门禁后才可启用。

## 积分定价

- MiniMax H3-2k：60 积分/秒。
- Seedance 2.0 Fast 480p 超分 1080p：860 积分/条，不随生成时长相乘。
- Fast 的供应商成本按次记录（¥2.80/次），避免成本账本随时长重复放大。

## 当前状态

- [x] 阅读飞拓 API 文档
- [x] 两个模型真实生成成功
- [x] 两个结果文件可读取且为有效 MP4
- [x] 协议单元测试（先红后绿）
- [x] `feituo_open` 协议实现
- [x] 本地完整验证（后端 655/655，前端计费测试 6/6，生产构建通过）
- [x] 积分定价审计
- [x] 生产候选、共享门禁、入库与部署复核

## 短剧工厂适配补充（2026-08-05）

### 生产故障证据

- 短剧工厂视频记录 `197` 使用 `sdas-lm-hailuo-h3-2k`，飞拓创建接口返回：参考图片 `@image1` 无法访问（HTTP 401）。
- 失败引用为 `https://molimama.vip/static/...`；未登录读取该地址确实返回 HTTP 401，而对应文件存在于 `/opt/moli-drama/shared/storage`。
- 根因是 `feituo_open` 路由直接提交短剧工厂的受保护参考图 URL，未复用现有视频链路的公网图床转存能力。
- H3 未被短剧工厂识别为多图全能模型；Fast 仅因模型名包含 Seedance 被识别，未显式执行最多 4 张图片的供应商约束。

### 本次边界与验收

1. 两个飞拓模型提交前，将本地或受保护 `/static` 参考图转存为供应商可读取的公网 URL；同一图片只转存一次。
2. H3 与 Fast 均可进入短剧工厂全能模式；H3 最多 9 张参考图，Fast 最多 4 张参考图。
3. 其他视频模型的全能模式判定和参考图数量保持不变。
4. 先用失败测试复现，再完成定向测试、完整后端测试和前端生产构建。
