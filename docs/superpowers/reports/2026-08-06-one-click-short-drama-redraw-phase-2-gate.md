# 一键转绘阶段 2 真实生成审计门禁记录

日期：2026-08-06
分支：`codex/short-drama-redraw-design`
提交：`d3eaee1`
范围：阶段 2 任务 1-7 的本地实现和自动化验收；未执行生产部署。

## 已验证

- 后端阶段 2 联合回归：`43/43` 通过，覆盖本地化资产、音色门禁、审核门禁和路由。
- 前端阶段 2 合同测试：`14/14` 通过，覆盖资产类型、审核状态、报价和门禁纯函数。
- Playwright：`frontweb/e2e/redraw-workspace.spec.js` `4/4` 通过，覆盖第二步逐项批准、门禁开放、退回后重新关闭，以及 390px 移动端无横向溢出。
- 前端生产构建：`npm run build` 通过，仅保留既有大 chunk 警告。
- `git diff HEAD^..HEAD --check` 通过，工作树干净。

## 已发现的隔离真实图片证据

- `artifacts/fafa-ai-phase2-real-review/950ae46381/image-review-wSEeqG/review.json` 记录了一次隔离 AIHubCC `gpt-image-2-3.5k` 成功任务：`run_id=3869808f-8240-4ef7-9fd9-b5636a64ccd4`、`task_id=4a4f51d9-d783-41c0-bbe2-f0185183cd63`、`route_id=config:1`、`database_readback=true`、`deployed=false`。
- 结果文件 `storage/creation-templates/ctr_cafe7c53.jpg` 为 345003 bytes，SHA-256 为 `32370613588F765D4344FB2F20094147A5E21CE3F6DB1D23E5640A32FBFA186D`，已实际读取确认，为商品多视图图像。
- 该证据只能作为通用图片供应商能力和物品多视图候选证据；没有转绘版本/资产 ID、角色/场景/去人净景语义绑定或 TTS 产物，因此不能单独解除任务 8 门禁。

## 真实模型门禁

状态：`blocked`

当前仍没有转绘角色三视图、本地化场景、去人净景、本地化物品和目标语言样音的完整同链证据，也没有 TTS 音频产物。已有通用图片证据不含转绘版本/资产 ID 绑定。浏览器用例使用路由 fixture，只证明 UI/API 合同和审核门禁状态转换，不证明供应商能力、真实生成或积分链路。

在获得目标 Key 和明确授权的测试素材后，必须分别完成角色三视图、本地化场景、去人净景、本地化物品和目标语言样音的真实生成，等待成功终态并验证结果文件可读取；记录不含密钥的配置 ID、模型、任务 ID、终态、资产 ID、分辨率/时长。任何失败或产物不可读均保持 `blocked`，不得把模型写入生产目录。
