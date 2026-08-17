# 全帧审核 Paddle wheel 分阶段本地验证报告

日期：2026-08-16

范围：原始实现阶段仅验证 Paddle wheel 分阶段下载、证据读取、本地安装、路径身份防逃逸、错误脱敏、原子清理和 Node 回归。该阶段未执行真实网络、真实 pip、依赖安装、venv 创建、模型 bootstrap、四组件 smoke、密钥读取、供应商调用、数据库写入、SSH、部署或 push。2026-08-17 的干净 PR 重放执行了 Git fetch 和锁文件约束下的 `npm ci`，但仍未执行官方模型下载、真实 pip、venv 创建、模型 bootstrap 或四组件 smoke。

## 验证基线

- 分支：`codex/redraw-r12-merge-20260809`
- 实现验证基线 HEAD：`eae58561`
- 完整实现基线：`eae585616377fafe1b43c8bea63a5c91bcdda2fe`
- 本报告提交只记录本地验证证据；实现基线仍以上述 HEAD 为准，不把报告自身提交当作实现基线。

## 任务提交链

| 提交 | 作用 |
| --- | --- |
| `42c1cbd1` | 拆分 Paddle wheel 下载与本地安装阶段，固定 `download:text:paddlepaddle` 与 `install:text:paddlepaddle` 两个稳定 stage。 |
| `e9d8fa7a` | 修复 Paddle 分阶段回归夹具，使下载目录、安装输入和失败路径可被本地用例稳定复现。 |
| `fcdf3226` | 加固 wheel 证据门禁，要求目录、包名、版本、归属路径和证据读取都匹配固定合同。 |
| `6ba46fe6` | 收紧链接类 skip 门禁，Windows 权限不可用时只允许明确 EPERM 类 skip。 |
| `0ee0ac5a` | 拒绝来自 staging 外部或安装期间产生的 hard link wheel 身份漂移。 |
| `6efd7dbd` | 固化 Paddle download 失败穿过 `runFetchModels` 后的原子清理证据，并固化其他 53 项调用不变。 |
| `eae58561` | 用行为证据固化无 shell 执行，确认特殊字符参数按 argv 字面传递。 |

## 红灯记录

- 任务 1 红灯：3 个 fail，分别覆盖 happy path 无 download 调用、download 失败用例缺少预期 rejection、local install 失败用例缺少预期 rejection。
- 任务 2 扩展红灯：4 个 fail，分别覆盖 junction 替换、初始 realpath 逃逸、安装后 realpath 逃逸、同名内容替换缺少拒绝；hard-link 红灯另有 2 个 fail，分别覆盖下载前外部 hard link 和安装后 hard link 身份漂移。
- invalid matrix 在任务 1 基线天然 pass，只能作为既有覆盖项，不能计入新增红灯。
- 任务 3 新增编排和行为证据为自然 pass 回归，不属于红灯。

## 新鲜本地验证

| 检查 | 目录 | 结果 | 跳过项 |
| --- | --- | --- | --- |
| `node --test --test-concurrency=1 test/redrawFullFrameDetectorProcess.test.js` | `backend-node` | `tests 40; pass 38; fail 0; skipped 2` | 1 个 symlink EPERM；1 个缺少 `REDRAW_AUDITOR_PYTHON` 的 Node/Python 合同探针。 |
| `node --test --test-concurrency=1 test/redrawFullFrameModelLock.test.js test/redrawFullFrameDetectorProcess.test.js test/redrawFullFrameCoverage.test.js test/redrawFullFrameCoverageLocal.test.js test/redrawFullFrameReview.test.js` | `backend-node` | `tests 88; pass 83; fail 0; skipped 5` | 4 个 symlink EPERM；1 个缺少 `REDRAW_AUDITOR_PYTHON` 的 Node/Python 合同探针。 |
| 使用当前 PowerShell 进程 env 临时设置 `REDRAW_AUDITOR_PYTHON` 后重跑 detector | `backend-node` | `tests 40; pass 39; fail 0; skipped 1` | 仅剩 1 个 symlink EPERM；合同探针 skip 消失。 |
| `node --check scripts/fetch-redraw-full-frame-models-local.js` | `backend-node` | exit 0 | 无 |
| `node --check test/redrawFullFrameDetectorProcess.test.js` | `backend-node` | exit 0 | 无 |
| `git diff --check` | repo root | exit 0 | 无 |

临时 Python env 验证中先确认 bundled Python 可用；命令结束后清除 `REDRAW_AUDITOR_PYTHON`，并确认该 env 在当前 PowerShell 进程内不存在。

## 行为证据

- download stage：`download:text:paddlepaddle` 只负责固定 `paddlepaddle==2.6.2` wheel 下载到内部临时 wheel 目录；下载失败返回稳定 stage，错误不携带底层诊断文本。
- install stage：`install:text:paddlepaddle` 使用经验证的本地相对 wheel 路径、no-index 和 no-deps 方式安装；安装失败返回稳定 stage，错误不携带底层诊断文本。
- 路径与身份：证据读取要求 wheel 目录位于 staging 内部固定相对位置，拒绝 symlink、junction、realpath 逃逸、下载后 realpath 逃逸、同名内容替换和 hard link 身份漂移。
- 原子清理：失败路径不留下最终输出目录、模型锁或随机 staging；成功路径不保留内部 wheel 目录。
- 其他 53 specs：target helper 测试以精确计数、顺序和 requirement 断言固化非目标调用不变，非 Paddle wheel 分阶段目标未引入额外 fail。
- shell 行为：`runProcess` 使用 `spawn` 的 argv 合同，`shell:false`；含 shell 特殊字符的探针参数按字面进入 argv，没有触发 shell 展开或额外命令执行。

## 脱敏证据

- 失败错误只暴露稳定错误码或可信 stage，不暴露本地路径、缓存位置、worker 文件名、wheel 文件名、底层 stderr、鉴权头、访问凭据、代理配置或外部地址。
- `runCli` 覆盖 install、bootstrap 和 unknown args 的脱敏输出；Paddle download 和 local wheel install 单独覆盖稳定 stage。
- `detectFrames` 覆盖子进程协议失败、EPIPE、超大 stdout/stderr 和非法 frame 输入的脱敏错误。

## 真实执行边界

本报告只代表本地静态检查和本地测试通过。它不代表官方缓存下载成功，不代表依赖安装成功，不代表 venv 可创建，不代表模型 bootstrap 成功，不代表 person、tracker、face、text 四组件真实 smoke 可用，不代表可部署。

原始实现验证没有执行真实网络、真实 pip、安装依赖、venv、模型 bootstrap、四组件 smoke、密钥读取、供应商请求、数据库操作、SSH、部署或 push。2026-08-17 干净 PR 重放仅为同步源码和安装锁定的 Node 测试依赖联网；没有对模型源或供应商发起请求，没有读取密钥，没有创建 main/text venv，没有执行 Python 包安装、模型 bootstrap、四组件 smoke、数据库操作、SSH 或部署。

## 干净 PR 重放验证（2026-08-17）

- 基线：最新 `origin/main`，HEAD `71829a250790b5addcc8ab22dc824132e2e32796`。
- 分支：`codex/redraw-paddle-wheel-clean-pr-20260817`。
- 迁移方式：从最终已审查实现机械投影最小闭包；规范化换行后与来源文件逐一比对，`normalized_mismatches=0`。未迁移来源分支的其他业务提交。
- 基线全量：`tests 878; pass 875; fail 2; skipped 1`。两项既有失败为 `canvasReferenceSequenceContract.test.js` 的 mention token 拒绝门禁，以及 `releaseArchiveGuard.test.js` 的数据盘停止阈值门禁。
- Paddle Node 定向：`tests 53; pass 49; fail 0; skipped 4`。跳过均为 Windows symlink 权限或未显式提供审核 Python 的合同探针。
- 显式指定 bundled Python 后 detector：`tests 40; pass 39; fail 0; skipped 1`；Node/Python v2 合同探针通过，仅剩 Windows symlink EPERM 跳过。
- Python worker：`Ran 61; OK; skipped 1`。普通沙箱首次运行因 hard-link 权限产生 `PermissionError`，在正常 Windows 文件权限下新鲜复跑通过；没有执行网络、安装或模型下载。
- 语法与格式：相关 Node 文件 `node --check` 全部 exit 0，7 个 Python 文件 `py_compile` exit 0，`git diff --check` exit 0。
- 迁移后全量两次均为 `tests 931; pass 923; fail 3; skipped 5`。除上述两项基线失败外，`providerRouteImageIntegration.test.js` 的备用图片落盘用例只在全量高负载中失败；该文件单独复跑 `14/14`，全文件集仅匹配该用例 `169/169`，前半套回归为 `tests 572; pass 570; fail 1; skipped 1`（唯一失败是既有 mention token 门禁），与两组 Paddle 测试联合为 `tests 67; pass 63; fail 0; skipped 4`。新增文件未修改图片路由、图片服务或该测试，因此本报告把它记录为现有负载敏感测试隔离警告，不把它描述为本功能通过的全量绿灯。

结论：Paddle wheel 功能定向合同全部通过，迁移未引入可稳定复现的业务回归；仓库全量仍不是绿灯，合并审查必须同时看到两项确定的基线失败和一项负载敏感图片用例警告。本地证据不等于官方缓存、双 venv、真实四组件 smoke 或部署验收。
