# 转绘静默镜头声音合同：本地联合验收证据

- 日期：2026-08-15
- 实际 worktree：`redraw-r12-merge-20260809`
- 分支：`codex/redraw-r12-merge-20260809`
- 代码验收基线：`36676498e25f6561f75bb4c0c853ef000b00e536`

## 1. 本阶段边界

本阶段只联合验收静默镜头声音合同的本地代码、测试、真实本地 FFmpeg 媒体处理、前端回归和构建，不修改历史证据，不重跑用户源片，不进入供应商或生产链。

本次未读取 Key，未上传，未联网，未调用供应商，未计费，未部署，未 SSH，未写生产数据库，未 push。报告不包含本机绝对路径、凭据值、临时公网 URL 或真实金额。

本次验收不证明真实环境音或动作音已生成，不证明英文对白、口型、人物替换、文字去除或任何供应商结果通过。下一阶段仍是全帧可见人物与文字区域审核。

## 2. 代码基线与任务提交

验收前执行：

```powershell
git status --short --branch
git rev-parse HEAD
git log -6 --oneline
git diff --name-only
git diff --cached --name-only
```

结果：分支正确，`HEAD` 精确等于代码验收基线 `36676498e25f6561f75bb4c0c853ef000b00e536`；tracked 和 index 均无改动。任务开始前已有的 `.superpowers/`、`frontweb/output/` 以及三个 `workers/redraw-locale-verifier/.../__pycache__/` 目录保持未跟踪，未删除、未暂存。

本阶段任务提交及用途：

| 提交 | 用途 |
| --- | --- |
| `191f15b0` | 为参考包服务加入静默镜头声音合同 |
| `6280a87b` | 让本地整集 runner 放行合同合法的静默镜头 |
| `e99ad536` | 固化整集第 3、8 镜静默事实与非人声提示词 |
| `36676498` | 收紧服务投影的静默提示词，只允许非人声环境音和动作音 |

报告提交不作为自身验收基线；本报告只记录上述代码基线，避免自引用报告提交。

## 3. 同一轮后端联合验收

在 `backend-node` 下执行：

```powershell
$env:REQUIRE_LOCAL_FFMPEG='1'
try {
  node --test --test-concurrency=1 test/redrawReferenceBundle.test.js test/redrawRoutes.test.js test/redrawGeneration.test.js test/redrawFullEpisodeReferenceLocal.test.js
} finally {
  Remove-Item Env:REQUIRE_LOCAL_FFMPEG -ErrorAction SilentlyContinue
}
```

实际结果：

| tests | pass | fail | cancelled | skipped | todo | duration |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 232 | 231 | 0 | 0 | 1 | 0 | 58,870.3981 ms |

命令 exit 0，结束后确认 `REQUIRE_LOCAL_FFMPEG` 不再存在。真实 FullEpisode FFmpeg 用例没有 skip；在 `REQUIRE_LOCAL_FFMPEG=1` 下，FFmpeg/FFprobe 缺失会直接使本轮失败。本轮唯一 skip 是既有 Windows 符号链接测试 `verifyVideoArtifact 使用 realpath 阻止指向根外的 symlink 但允许根内 symlink`，原始理由为 `symlink unavailable: EPERM: operation not permitted`。

真实 FFmpeg 测试使用测试代码在系统临时目录中生成的本地合成媒体，验证九镜连续切片、运动参考无音轨、代表帧、SHA-256、FFprobe 元数据以及 staging 清理和最终目录原子写入。它不是对用户源片生成的新成片，也没有构造或提交供应商请求。

## 4. 同一轮前端测试与构建

从 worktree 根执行：

```powershell
node --test frontweb/test/redrawLatinAmericanCase.test.js frontweb/test/redrawShots.test.js frontweb/test/redrawAssets.test.js frontweb/test/redrawFoundation.test.js
```

实际结果：

| tests | pass | fail | cancelled | skipped | todo | duration |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 54 | 54 | 0 | 0 | 0 | 0 | 237.8078 ms |

随后执行：

```powershell
npm --prefix frontweb run build
```

实际结果：exit 0；Vite 6.4.3 转换 1,896 modules；`built in 23.50s`。构建仍报告既有的 500 kB chunk-size warning，但没有构建错误。`frontweb/output/` 保持未跟踪，不纳入提交。

## 5. 语法、diff 与机械扫描

对以下六个文件逐一执行 `node --check`，全部 exit 0：

```powershell
node --check backend-node/src/services/redrawReferenceBundleService.js
node --check backend-node/scripts/run-redraw-full-episode-reference-local.js
node --check frontweb/e2e/fixtures/redraw-latin-american-case.js
node --check backend-node/test/redrawReferenceBundle.test.js
node --check backend-node/test/redrawFullEpisodeReferenceLocal.test.js
node --check frontweb/test/redrawLatinAmericanCase.test.js
```

执行 `git diff --check`，无输出，exit 0。

实现文件机械扫描使用：

```powershell
Select-String -LiteralPath backend-node/scripts/run-redraw-full-episode-reference-local.js -SimpleMatch 'silent_dialogue_contract_unsupported'
Select-String -LiteralPath backend-node/src/services/redrawReferenceBundleService.js -SimpleMatch 'Dialogue mode: silent.'
Select-String -LiteralPath backend-node/src/services/redrawReferenceBundleService.js -SimpleMatch 'non-speech ambience and action sound effects'
rg -n -i "sk-[A-Za-z0-9_-]{8,}|bearer[[:space:]]+[A-Za-z0-9._-]{8,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{20,}" -- backend-node/src/services/redrawReferenceBundleService.js backend-node/scripts/run-redraw-full-episode-reference-local.js frontweb/e2e/fixtures/redraw-latin-american-case.js
```

实际结果：runner 中旧 blocker literal 命中 0 次；服务中 `Dialogue mode: silent.` 命中 1 次；`non-speech ambience and action sound effects` 命中 1 次；常见真实凭据值签名命中 0 次。实现中的 `keys`、`authorization` 等概念词只出现在安全拒绝文案或禁止字段规则中，没有凭据值。

测试中的否定断言仍可引用旧 blocker 名称，用于证明输出不再包含它；该测试文字不属于 runner 实现残留。

## 6. 服务合同验收结论

`redrawReferenceBundleService` 当前合同为：

1. 有声镜头规范化为 `kind=spoken`、`speech_required=true`，并保留逐条英文对白 timing；投影提示词保留 `English dialogue timing` 和批准的美式英语同步语音要求。
2. 静默镜头要求源对白列与本地化对白列同时为空，规范化为 `kind=silent`、`speech_required=false`、`turns=[]`。
3. 有声与静默两种合法合同投影均保持 `generateAudio=true`。
4. 静默提示词只允许场景适配的非人声环境音和动作音，并明确禁止 spoken dialogue、voiceover、narration、chanting 和 intelligible vocalization；不会附带英文对白 timing。
5. 源对白列与本地化对白列空值不一致、任一列为非法 JSON 或非数组时均 fail closed，且不写参考包。
6. spoken turns 中的六种伪装静默 token `silence`、`[silence]`、`(silence)`、`silent`、`no dialogue`、`[no dialogue]` 在 trim、大小写和空白归一化后均拒绝。
7. 已保存旧包即使重算哈希，只要缺少 `kind` 或 `speech_required`，重读和投影仍 fail closed，且不自动升级数据库。

## 7. Runner 合同验收结论

本地整集 runner 当前合同为：

1. `shot-3` 和 `shot-8` 不再产生 `silent_dialogue_contract_unsupported`，也不会把合法静默错误归为英文对白缺失。
2. 两镜在人物轨迹、身份包、文字净景或运动参考等其他门禁仍为 pending 时保持 blocked。
3. 只有本地夹具把全部非对白门禁批准后，合法静默镜头才变为 `reference_bundle_ready=true`。
4. 三类不一致分别稳定产生 `dialogue_speech_contract_mismatch`、`silent_dialogue_has_turns`、`spoken_dialogue_missing`。
5. 六种伪装静默 token 稳定产生 `dialogue_silence_token_forbidden`。
6. `speech_required` 缺失、非布尔或 dialogue 含未知字段时，case manifest fail closed。

## 8. 九镜事实夹具

夹具机械统计为七镜 `spoken`、两镜 `silent`，静默镜头仅 `shot-3` 与 `shot-8`：

- `shot-3`：保留 Mateo 离开学校的自行车、后向跟拍构图与行进方向；声音只允许自然街道环境和自行车运动音效，并禁止人声对白、旁白与可辨识发声。
- `shot-8`：保留 Mateo 在房间使用电脑研究并作出决定、屏幕插入和特写；声音只允许安静房间环境、键盘、鼠标和电脑交互音效，并禁止人声对白、旁白与可辨识发声。

## 9. 历史证据与后续边界

历史 `full-episode-reference-20260815-run1` 及旧报告没有被改写。旧 manifest 仍是当时合同、当时运行状态的历史证据；本次新增的静默合同和本地合成媒体测试不能追溯性改变旧 manifest，也不能将旧运行升级为静默声音或供应商生成通过。

因此，本阶段结论仅为本地静默镜头声音合同、runner 门禁、事实夹具、测试和构建通过。进入任何真实用户源片复跑、供应商调用、计费、网络、部署或生产操作前，必须另行授权并重新形成当轮证据；当前下一阶段仍是全帧可见人物与文字区域审核。
