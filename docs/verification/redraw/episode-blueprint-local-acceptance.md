# 母本蓝图优先一键转绘本地验收

日期：2026-09-04

状态：`passed_with_documented_uncertainty`

产品源码与回归修复 HEAD：`39c626cd9d4cfee824acf22f672c3b84f90eed15`

最终功能锁与全量验证 HEAD：`727eb869543f679c87bb4d9f6c25cea2495f6421`

## 结论

用户提供的完整母本已在本地隔离环境实际完成“媒体证据 → 母本蓝图 → 人工锁定投影 → `US / en-US` 本地化 → 逐镜生产包”的全链验收。产物由当前产品服务生成并重新读取验证，不使用固定 Mateo 九镜 fixture，不调用视频供应商。

本次通过代表“母本反推与一键转绘主链本地开发完成”。真实视频生成、逐镜成片质量、整集合成和最终成片验收仍属于后续独立授权阶段，不能由本次零供应商验收替代。

## 输入与提取方式

- 文件名：`ac087bcd4cf5f856f85182834794853a.mp4`
- 文件大小：5,467,058 字节
- SHA-256：`24eb1d8ba3ff11e6aa3e547b7ac400f6b177dcf541d1af36354d3e46cc05e9ae`
- 媒体：68,733 ms，720 × 1280，30 fps，HEVC；AAC 单声道，44.1 kHz
- 视频证据：`ffprobe` 媒体探测、`ffmpeg` 场景切分、逐镜接触表人工复核、RapidOCR
- 音频证据：本机既有 `faster-whisper` small/base 双模型离线转写交叉复核；两路均识别为中文，语言概率高于 99.8%
- 网络与下载：0；本轮只使用已存在的本地运行时和模型缓存

## 隔离产物

相对工作树目录：

```text
.codex-staging/episode-blueprint-local-acceptance-20260903-bd91aef1
```

`SHA256SUMS` 已独立重算并全部匹配：

| 产物 | SHA-256 |
| --- | --- |
| `source-media.json` | `0136bab8b847359fc39f7f584660bbf3bbb65fa8f1cd246450b6cb617afd694f` |
| `audio-evidence.json` | `2726b3738eb09721a93a959f61704033dec530cfdcaf51a71e2d6f9bc078ee95` |
| `visual-evidence.json` | `e23ff6d6e212b5001e20abbd2e822d3f5bc04020d5ef3d5c2300d3b06ce59e00` |
| `episode-blueprint-v1.json` | `7fd5149c68f27e404d623051df97c2081c37de9cfc56981739288709adc1fc77` |
| `episode-localization-en-US-v1.json` | `11f427c58caed143e256274207509992dd02a262a098b5ec2b6969bd52da9de6` |
| `shot-production-packs.json` | `e70638f9eb7ce3c6477cd7ed928cfcb27312deb8373ff566218d3f06466e3ade` |
| `acceptance-report.json` | `78c0a3826d6e49f81ecf651aacaee9d3dd22960073a96deee9e137edaa25cfab` |

`SHA256SUMS` 文件自身 SHA-256：`1cc1c9628f903b85ebc61d4e50a524f734fe1274c53a52c203defa6d186bcf84`。

合同哈希：

- `blueprint_hash`：`f62842d9fbdb006d84b8b7b63ff05c09e7e74850a5d0a86ab5fa01bc607aae8d`
- `localization_hash`：`2a0d8d1103cb8c922c29c07bbd4341f1d1cb0c131bf94c4b176a90d11f58abfd`

## 验收断言

- 24 个真实剪辑镜头连续覆盖 `0..68733 ms`，无缺口、无重叠。
- 15 段可听对白均保留中文原文、起止时间、声音聚类和证据引用；未从画面猜测对白。
- 4 个原始说话人聚类进入音频证据，并在锁定蓝图中映射为具体角色或稳定的画外角色；不能可靠绑定人脸的声音不强行关联人脸轨迹。
- 8 个角色的 `en-US` 名称全剧唯一；人物姓名、对白和画面文字由本地化版本统一维护。
- 15 段目标对白逐句绑定源对白；18 个可靠画面文字区域完成本地化。
- 24 个生产包与 24 个镜头一一对应，并同时绑定 `blueprint_hash`、`localization_hash` 和各自 `production_pack_hash`。
- 生产包自由文本无中文残留，真实运行入口不包含固定 Mateo/九镜捷径。
- `provider_submit_count=0`，没有上传、生成或付费请求。
- 7 个公开 JSON 已扫描，不含本机绝对用户路径、URL、API Key、secret 或 token 字段。

## 执行命令与结果

```powershell
# 功能锁和增量发布范围
Set-Location backend-node
node --test test/featureLockManifest.test.js test/incrementalReleaseScope.test.js
# 66 passed, 0 failed

# Worker 全量；使用项目隔离 Python，并禁止用户 site 和模型联网
Set-Location workers/redraw-locale-verifier
$env:PYTHONPATH='src'
$env:PYTHONNOUSERSITE='1'
$env:PYTHONUTF8='1'
$env:HF_HUB_OFFLINE='1'
python -m unittest discover -s tests -p 'test_*.py' -v
# 122 tests run：114 passed, 8 existing environment-conditional skips

# 本地母本验收程序和合同测试
Set-Location .codex-staging/episode-blueprint-local-acceptance-20260903-bd91aef1
node --test run-local-acceptance.test.mjs
node run-local-acceptance.mjs
# 4 passed；24 shots / 15 dialogues / 24 packs / 0 provider submits

# 前端纯函数和通用整集启动器
Set-Location frontweb
npm run test:unit:redraw-episode-blueprint-live
node --test src/utils/redrawBlueprintReviewState.test.mjs
# 39 passed, 2 Windows symlink-permission conditional skips

# 前端目标 E2E
npx playwright test e2e/redraw-workspace.spec.js e2e/redraw-backend-integration.spec.js e2e/redraw-full-product.spec.js --workers=1
# 30 passed, 1 explicit fake-provider scenario skipped

$env:REDRAW_E2E_FAKE_PROVIDER='1'
npx playwright test e2e/redraw-full-product.spec.js --workers=1
# 1 passed；public_requests=0 / real_provider_requests=0

# 生产构建
npm run build
# PASS

# 后端全量
Set-Location backend-node
npm test
# 最终精确结果见下方“回归收口”
```

## 回归收口

第一次隔离后端全量执行得到 3,939 项：3,928 通过、10 个既有条件跳过、1 个失败。唯一失败是 Worker 发布合同的期望清单未包含本任务新增且已进入发布范围的 `source_evidence.py`；产品逻辑测试没有失败。

按最小范围把该路径加入精确合同断言后，聚焦发布合同 13/13 通过。随后又完成两类必要收口：整集启动器不再把原始媒体字节写入公开证据，并拒绝越界、非规范、ADS、盘符相对路径和符号链接产物；锁定蓝图会在同一事务中创建源分镜，并对已污染默认行冲突回滚。对应整集启动器组合测试 28/28 通过（另有 2 项 Windows 权限条件跳过），审核状态测试 11/11 通过；工作流聚焦测试 22/22、相关后端测试 108/108 通过。

在最终功能锁 HEAD `727eb869543f679c87bb4d9f6c25cea2495f6421` 的独立干净工作树中，后端串行全量测试完整输出终态：3,943 项，3,933 通过、10 项既有条件跳过、0 失败、0 取消，耗时 1,735,876 ms。stdout 为 46,415,011 字节，SHA-256 `977685f3b5f1d0009fa057c59b4ba772820ee3f7813f305b984709763dc235f6`；stderr 为 0 字节。独立终态解析门禁退出码为 0。

完整 Playwright 首轮发现的 3 项失败也均定位为旧测试夹具落后于既有产品合同：字符串目标对白、旧 `10–15 秒` 文案、旧配音报价/中文项目 locale。仅同步夹具为结构化对白、`5–15 秒`、`en-US` 和 `{status, priced, total_credits, quote_hash}` 后，完整回归为 30/30 通过，显式 fake-provider 整集场景另为 1/1 通过；未修改产品实现。

## 明确保留的审核不确定项

- 单独观察视频帧不能证明声音、口播语言或画外音，相关结论只来自音轨证据。
- 早期群像中陆飞宇与其他同学的部分人脸对应仍有歧义。
- 说话人聚类 2、3 保留为稳定的画外同学身份，不强行绑定人脸轨迹。
- 镜头 4、8 的低置信度反应人物保留为稳定未解决角色记录。
- 店铺招牌和电脑屏幕小字不可可靠辨认，未写入锁定文字事实；仅保留可靠字幕和大标题。

这些项目已进入审核报告，没有由模型补写，不阻断蓝图与生产包的结构性本地验收；进入真实付费生成前可由人工继续修订并产生新哈希。

## 安全边界

- 生产数据库写入：0
- 供应商请求：0
- 付费请求：0
- 部署、重启、生产切换：0
- 模型目录、模型信息或线上配置修改：0
- 验收产物仅在本地 `.codex-staging`；未纳入产品发布范围
- 文档不记录密钥、完整供应商请求或生产数据
