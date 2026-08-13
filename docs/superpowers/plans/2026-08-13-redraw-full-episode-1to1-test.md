# 整集短剧 1:1 复刻测试实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 `superpowers:subagent-driven-development` 或 `superpowers:executing-plans` 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在不部署线上入口的前提下，对用户指定的 68.733 秒源片完成一套可审计的整集英文/外国虚构成年角色复刻测试，并明确区分本地结构验收与 ToAPIs 真实视觉结果。

**架构：** 先以源片 SHA-256、9 段连续时间轴、角色身份包和逐镜绑定建立不可变测试清单；本地 dry-run 必须跑通上传、资产审核、镜头绑定、失败回写、合并、下载和 FFprobe。真实供应商阶段按镜头提交 `seedance-2-mini`，每个请求独立记录、轮询到终态并验证文件，未知结果禁止自动重试；没有用户对整集多次提交的明确授权时只停在报价/准备阶段。

**技术栈：** Node.js、Playwright、better-sqlite3、FFmpeg/FFprobe、ToAPIs REST API、JSON/MP4/SRT/VTT 证据清单。

---

## 文件职责

- 修改：`frontweb/e2e/fixtures/redraw-latin-american-case.js`——维护源片媒体合同、9 段时间轴、角色和英文映射。
- 修改：`frontweb/test/redrawLatinAmericanCase.test.js`——验证哈希、时长、连续覆盖、成年角色和身份包输入。
- 修改：`frontweb/e2e/redraw-backend-integration.spec.js`——跑本地全链：身份包、逐镜绑定、审核门禁、合并导出和下载校验。
- 复用：`frontweb/scripts/run-redraw-latin-american-case.mjs`——以真实本地 MP4 驱动 9 段本地 dry-run，不读取生产配置。
- 新建（仅在取得整集真实提交授权后）：`frontweb/scripts/run-redraw-full-episode-toapis.mjs`——读取本地 Key 文件，通过临时目录保存每段请求/轮询/产物状态；禁止把 Key、签名 URL 或供应商响应写入 Git。
- 新建（真实阶段完成后）：`docs/superpowers/reports/2026-08-13-redraw-full-episode-1to1-evidence.md`——记录不含密钥的输入哈希、每段任务状态、产物哈希、成本快照和差异结论。

### 任务 1：锁定整集媒体与剧情合同

**文件：**
- 读取：`C:\Users\canqu\Desktop\ac087bcd4cf5f856f85182834794853a.mp4`
- 修改：`frontweb/e2e/fixtures/redraw-latin-american-case.js`
- 测试：`frontweb/test/redrawLatinAmericanCase.test.js`

- [ ] **步骤 1：运行源片探针并记录基线**

运行：

```powershell
ffprobe -v error -show_streams -show_format -of json `
  "C:\Users\canqu\Desktop\ac087bcd4cf5f856f85182834794853a.mp4"
```

预期：SHA-256 为 `24eb1d8ba3ff11e6aa3e547b7ac400f6b177dcf541d1af36354d3e46cc05e9ae`，时长约 68.733 秒，视频 720×1280/30fps，HEVC，音频 AAC/44.1kHz/单声道。

- [ ] **步骤 2：编写失败测试，拒绝不连续或越界的整集分段**

在 `frontweb/test/redrawLatinAmericanCase.test.js` 增加对 9 段 `start_ms/end_ms` 连续覆盖 `[0, 68733]`、无重叠、每段供应商时长落在 4–15 秒的断言；先将一段边界改成空档运行测试，确认出现断言失败。

- [ ] **步骤 3：恢复最小合同实现并运行测试**

运行：

```powershell
node --test frontweb/test/redrawLatinAmericanCase.test.js
```

预期：所有媒体/时间轴/身份包测试通过，且不产生外部请求。

### 任务 2：完成本地整集 dry-run

**文件：**
- 复用：`frontweb/scripts/run-redraw-latin-american-case.mjs`
- 修改：`frontweb/e2e/redraw-backend-integration.spec.js`
- 输出：`C:\tmp\redraw-full-episode-local-20260813\`

- [ ] **步骤 1：运行本地前后端 9 段链**

运行：

```powershell
node frontweb/scripts/run-redraw-latin-american-case.mjs `
  --source "C:\Users\canqu\Desktop\ac087bcd4cf5f856f85182834794853a.mp4" `
  --output-dir "C:\tmp\redraw-full-episode-local-20260813"
```

预期：9/9 镜头 `completed`；角色身份包 `ready=true`；逐镜角色绑定通过 generation gate；合并 MP4、SRT、VTT 可读；held reservations=0、active tasks=0。

- [ ] **步骤 2：独立校验合并产物**

运行：

```powershell
ffmpeg -v error -i "C:\tmp\redraw-full-episode-local-20260813\ac087bcd-latam-local-fixture.mp4" -f null -
ffprobe -v error -show_streams -show_format -of json `
  "C:\tmp\redraw-full-episode-local-20260813\ac087bcd-latam-local-fixture.mp4"
```

预期：FFmpeg exit 0；时长在源片合同容差内；视频/音频流存在；manifest 中明确标注 `provider_mode=local_fixture`，不得把本地色块视频当作视觉演员替换证据。

### 任务 3：真实 ToAPIs 多段提交前门禁

**文件：**
- 新建（授权后）：`frontweb/scripts/run-redraw-full-episode-toapis.mjs`
- 临时状态：`C:\tmp\toapis-full-episode-20260813\`

- [ ] **步骤 1：只读检查账户余额、模型和最终报价**

只允许 GET 余额/模型和 Dashboard 报价，不发送 generation POST。记录 `remain_credits`、当前账户报价、预计请求数（9 次）和总预算；公开价格页仅作参考，最终以账户报价为准。

- [ ] **步骤 2：生成逐段提交清单，不含 Key**

每段清单必须包含：源段哈希、`start_ms/end_ms`、目标英文 prompt、角色/图像资产 ID、视频参考资产 ID、`model=seedance-2-mini`、时长、分辨率、client business ID、预估成本。

- [ ] **步骤 3：停止并取得整集明确授权**

在 9 次 generation POST 前向用户确认：总预算、是否允许 9 次提交、是否接受失败段不自动重试。没有该确认，只保留本地清单和报价，不调用供应商。

### 任务 4：执行真实整集生成并验收

**文件：**
- 新建：`frontweb/scripts/run-redraw-full-episode-toapis.mjs`
- 新建：`docs/superpowers/reports/2026-08-13-redraw-full-episode-1to1-evidence.md`

- [ ] **步骤 1：逐段上传/注册虚拟人素材并等待 active**

每段只提交一次素材注册；状态不是 `active` 时停止该段，不继续 generation。所有响应保存到临时目录并脱敏。

- [ ] **步骤 2：逐段发送一次 generation POST 并轮询终态**

请求使用 `video_with_roles` 绑定对应源段，`image_with_roles` 绑定虚构成年角色；`completed` 后下载并记录 SHA-256、FFprobe、可解码性和音频流。HTTP 超时或未知结果标记 `submission_unknown`，不得重试。

- [ ] **步骤 3：本地合并与逐段/整集验收**

验证：镜头顺序、总时长、音频存在、字幕语言、角色一致性、动作连续性、背景/灯光差异、输出尺寸和水印；生成对照 contact sheet 和最终报告。

- [ ] **步骤 4：完成后清理临时目录中的密钥/签名 URL**

保留脱敏 JSON、哈希、媒体元数据和最终 MP4；删除含 Key 或可复用签名 URL 的临时文件，不删除用户原始源片和现有候选。

## 完成前自检

- [ ] 本地 9 段结构链与真实供应商 9 段视觉链分开报告。
- [ ] 任何模型“成功”均有可读取文件、哈希、尺寸、音频和任务终态证据。
- [ ] 未把 UI、mock、fixture 或历史候选当作真实整集 1:1 证据。
- [ ] 未部署、未写生产数据库、未 activate、未 push。
- [ ] 报告明确写出“通过项、未通过项、未验证项”和实际成本。
