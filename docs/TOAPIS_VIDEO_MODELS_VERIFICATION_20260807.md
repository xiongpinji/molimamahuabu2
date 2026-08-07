# ToAPIs 视频模型真实验证记录（2026-08-07）

## 当前结论

状态：`partial`，禁止写入用户模型目录或生产 `ai_service_configs`。

已完成三个文生视频组合的供应商终态、下载和本地媒体校验：

- `seedance-2-mini` + 480P；
- `seedance-2-fast` + 480P；
- `seedance-2-fast` + 720P。

尚未完成：Mini 720P、两模型首尾帧、两模型全能参考、同步音频开关、本站长期资产落库、实际账户扣费复核和全站产品链。现有证据不得推断这些能力已通过。

## 脱敏证据

| 模型 | 请求档位 | 供应商任务号 | 终态 | 本地实际媒体 | 字节数 | SHA-256 |
|---|---:|---|---|---|---:|---|
| `seedance-2-mini` | 480P | `tsk_vid_01KZDR3CKHX2MSH8PWSKMP9ZAX` | `completed` | H.264 864×496，4.041667 秒；AAC 4.096 秒 | 1,553,201 | `5BB3ACA3858469497B5249D02ECCA2F8837E8289DBD10A13DE3B075CC3B7A9D7` |
| `seedance-2-fast` | 480P | `tsk_vid_01KZDR68GFAMT1GWV1WY5S2V0Q` | `completed` | H.264 864×496，5.041667 秒；AAC 5.088 秒 | 1,075,536 | `4A679B5B28CA435E84844C769CDF6382DDE0A94773CBB35E4E0C30E27F69FC24` |
| `seedance-2-fast` | 720P | `tsk_vid_01KZDR47Q3RAQ0M4YB0H6DV0PQ` | `completed` | H.264 1280×720，5.041667 秒；AAC 5.088 秒 | 2,737,935 | `858DA5AF7A5056FA0C059C318BF6F582D6FEBDE3D8BD848D1E94858984F5BDB5` |

三个结果均为 MP4，供应商状态响应含 `result.type=video`、`result.data[0].format=mp4`。结果 URL 是 24 小时临时候选地址，本记录不把其长期可读性视为已证明。

## 证据边界

- 未记录、未输出、未提交 API Key；
- 供应商响应没有返回请求分辨率、实际时长或费用字段，因此分辨率与时长以请求记录和下载后的 ffprobe 结果交叉核对；
- 480P 返回 864×496，而不是把名称机械解释为高度必须等于 480；该尺寸只作为供应商 480P 档位实测结果记录；
- 三个任务的音频流不能证明“同步音频开关”合同，因为当前证据没有完整保存创建请求体中的 `generate_audio` 值；
- 任务 `completed` 和可下载 MP4 仍不等于平台接入完成，尚需本站资产、计费、退款、回填和前端实操闭环。

## 剩余开放门禁

1. Mini 720P 完成真实生成、下载和 ffprobe；
2. 两模型各完成一次 480P 首尾帧；
3. 两模型各完成一次 480P 图片 + 视频 + 音频全能参考；
4. 若开放同步音频，保存明确 `generate_audio` 请求快照并校验输出音轨；
5. 保存本站长期资产并验证登录态外供应商可读的参考素材地址；
6. 复核真实账户扣费和人民币成本；
7. 全站目录、计费、退款、回填和浏览器实操通过；
8. 合并图片候选后通过共享发布门禁和生产验收。

## 自动验证与防重复扣费合同

本分支新增两个只从受保护环境读取凭据的工具：

- `npm run verify:toapis-video`：真实生成、恢复已有任务、下载、ffprobe、SHA-256、本站长期资产公网读取、供应商余额差额和人民币成本证据；
- `npm run audit:toapis-video`：静态检查 8 个真实组合、两档价格、严格目录门禁、协议分发、参考模式互斥、同步音频证据、Key 泄漏和 `canvas-credit-callout-v1`。

验证脚本固定要求以下 8 个组合，缺少任意一个都不会把配置标为 `verified`：

1. `fast-t2v-480`；
2. `fast-t2v-720`；
3. `mini-t2v-480`；
4. `mini-t2v-720`；
5. `fast-first-last-480`；
6. `mini-first-last-480`；
7. `fast-omni-480`；
8. `mini-omni-480`。

其中两个 480P 文生视频组合明确提交 `generate_audio=true` 并要求 ffprobe 检出音轨；其余组合明确提交 `false`，用于同时锁定布尔值不会因默认值而丢失。首尾帧组合只传 `first_frame`/`last_frame`，全能参考组合只传 `reference_image`/`reference_video`/`reference_audio`，禁止混发。

真实运行前必须由服务器受保护环境提供：

```powershell
$env:TOAPIS_API_KEY = '<由受保护 secret 注入>'
$env:TOAPIS_VERIFY_DEDICATED_TOKEN = '1' # 仅用于本轮验证、无其他业务并发
$env:TOAPIS_VERIFY_OUTPUT_DIR = '/opt/moli-drama/shared/verification-state/toapis-video-v1'
$env:TOAPIS_VERIFY_PUBLIC_ARTIFACT_DIR = '/opt/moli-drama/shared/release-evidence/external-models-v1/public/toapis'
$env:TOAPIS_VERIFY_PUBLIC_ASSET_BASE_URL = 'https://molimama.vip/verification-assets/toapis'
$env:TOAPIS_VERIFY_FIRST_FRAME_URL = 'https://molimama.vip/<首帧测试资产>'
$env:TOAPIS_VERIFY_LAST_FRAME_URL = 'https://molimama.vip/<尾帧测试资产>'
$env:TOAPIS_VERIFY_REFERENCE_IMAGE_URL = 'https://molimama.vip/<参考图测试资产>'
$env:TOAPIS_VERIFY_REFERENCE_VIDEO_URL = 'https://molimama.vip/<参考视频测试资产>'
$env:TOAPIS_VERIFY_REFERENCE_AUDIO_URL = 'https://molimama.vip/<参考音频测试资产>'
$env:TOAPIS_USD_CNY_RATE = '<本轮留档汇率>'
$env:TOAPIS_EXPECTED_COST_YUAN_JSON = '<每个用例的预计人民币成本 JSON>'
$env:TOAPIS_VERIFIED_PRICING_JSON = '<四个模型分辨率档位的成本与扣分复核 JSON>'
npm run verify:toapis-video
```

`TOAPIS_VERIFY_OUTPUT_DIR` 保存锁、恢复状态、账单快照和最终证据 JSON，不得通过 Web 暴露；只有独立的 `TOAPIS_VERIFY_PUBLIC_ARTIFACT_DIR` 中的 MP4 成品允许由 `/verification-assets/toapis/` 匿名读取。两个目录必须完全分离，避免后续原子轮换公开证据时删除防重复扣费状态，也避免状态和账单文件被公开。验证工具拒绝相同或互相包含的目录，也拒绝其他域名或公开路径。

脚本先以原子 `wx` 文件锁独占整轮验证，再在每次付费 POST 前把该组合写成 `submitting`。第二个进程无法并发进入；异常退出后遗留的锁也不会自动抢占，必须人工核对供应商任务后处理。如果连接中断、HTTP 408/5xx、进程退出或响应无法确认是否受理，下一次运行只会停止并要求人工补入供应商 `task_id`，绝不会自动再次 POST。已取得 `task_id` 的组合只轮询原任务；已下载组合会重新校验本地文件哈希、ffprobe 与公网可读性，不会重复生成。`ffprobe` 子进程只继承运行所需的系统路径与临时目录变量，不继承供应商 Key 或 Authorization。

费用复核分两步：首次完成后保存余额前后快照和实际差额，但保持 `reviewed=false`；管理员核对四档人民币成本和用户扣分后，再设置 `TOAPIS_VERIFY_CONFIRM_COST=1` 重跑。即使首次运行误设该变量，只要本轮发生过一次 POST，确认就不会生效。只有 8 个组合在运行开始前已全部完成且本轮提交数为零，脚本才会写入统一 `review_run_id`、`completed_before_run=8` 和空 `submitted_case_ids`。第二轮会无 POST 地重新读取全部 8 个本地文件，复验 ffprobe、公网文件与 SHA-256，而不是只相信状态 JSON。每条余额快照必须带采集时间，区间按时间排序后不得重叠，并且上一条 `after` 的累计余额/积分必须精确衔接下一条 `before`，防止一对累计快照被复制给多个任务。

四档价格必须精确等于设计基线与同模型同分辨率实测最高成本中的较高值（Fast 480P/720P 基线均为 ¥0.584/秒，Mini 480P 为 ¥0.3358/秒，Mini 720P 为 ¥0.6789/秒）；积分必须严格等于 `ceil(成本 × 875)`，任意低报或虚高都拒绝。证据 JSON 会移除 Key、Authorization 和完整请求头。

发布审计逐项绑定用例 ID、模型、模式、请求分辨率、请求时长、角色数组、同步音频布尔值、ffprobe 实际尺寸/时长、唯一供应商任务、唯一本站成品、SHA-256、余额前后差额、人民币换算和费用复核状态。复制同一任务或成品、伪造 720P 尺寸、缺少参考角色、篡改请求参数或账单差额都不能升级配置为 `verified`。

当前尚未执行上述完整矩阵，因此本文件顶部状态仍为 `partial`；新增脚本和测试不构成真实供应商或生产验收证据。
