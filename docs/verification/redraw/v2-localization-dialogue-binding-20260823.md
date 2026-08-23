# V2 本地化对白绑定交付验证报告

日期：2026-08-23

分支：`codex/redraw-complete-delivery-20260822`

证据父 HEAD：`739a1176`

本文记录的是本轮已完成的本地交付验证。报告提交会产生新的文档 commit，因此正文固定记录提交前的证据父 HEAD；报告自身 commit 以 `git log -1 -- docs/verification/redraw/v2-localization-dialogue-binding-20260823.md` 查询。

## 范围与结论

- 结论：本轮 V2 本地化对白绑定主链路已达到本地交付门槛。
- 范围：本地代码、单元/集成测试、前端构建、Playwright 浏览器回归、Python worker 回归、Task8 三镜本地端到端证据。
- 边界：本轮没有 Hosted CI、生产数据库写入、SSH、部署、供应商调用、付费生成、真实视频生成、候选激活或 push。
- 已知非阻断项：Python 7 个 skip 来自 Windows 权限相关路径；前端构建存在 Vite chunk size warning；3 个既有 `__pycache__` 目录未纳入提交。

## 执行位置

| 类别 | cwd | 说明 |
| --- | --- | --- |
| 仓库级检查 | 仓库根 | git、diff、状态、跨包检查 |
| 后端验证 | `backend-node` | Node 后端测试、生产预检合同、Task8 三镜链路 |
| 前端验证 | `frontweb` | 前端测试、构建、Playwright 回归 |
| Python 验证 | worker 相关包目录 | 本地 locale / full-frame worker 回归 |

## 本轮主要实现合同

- V2 target dialogue binding：生成与门禁使用目标语言对白、目标角色名和逐镜绑定证据，不再把源语言对白误投给目标地区。
- generation 双检与 transaction CAS：生成前后校验当前参考包和状态快照，阻断 stale bundle、状态漂移和事务窗口错配。
- relative timing：reference bundle 内对白时间为镜头相对时间；源文和 localized V2 时间继续保留 episode absolute，并要求落在镜头窗口内。
- clean recovery 与 per-shot dependency：角色变更只影响引用该角色的镜头；无关镜头保持 ready；可复用 clean 结果必须通过当前物理证据复核。
- identity authority：身份、服装、语音、净景和参考包证据统一由当前快照、物理文件、hash 和门禁约束。
- ReviewGate：缺失 V2 参考包、缺项、旧库兼容、approved `needs_attention` 文本净景完成态等路径均有明确 fail-closed 或兼容边界。
- Task8 三镜：覆盖三镜头、两角色、目标地区、对白、身份变更和无真实供应商调用的本地端到端合同。

## Task8 三镜证据

| 检查项 | 结果 |
| --- | --- |
| 镜头状态 | 3 个镜头均到达 `reference_ready` |
| 角色依赖 | `c1` 仅绑定 shot 1 / shot 2；shot 3 不引用 `c1` |
| 供应商 clean 调用 | 初始 7 次；`c1` 变更后仍为 7 次，未重复清洗无关镜头 |
| 目标地区 | `es-ES` / `ES` |
| hash 绑定 | reference bundle hash、source fingerprint、shot character plan hash、clean reuse hash 均纳入证据 |
| gate | reference gate 与 generation gate 双门禁通过 |
| 真实外部动作 | 0 次真实视频、0 次供应商调用、0 次付费 |
| 积分状态 | held 为 0 |

Task8 结论：三镜 fixture 证明本地准备链路能把目标语言对白、目标角色名、逐镜身份引用、净景复用和生成门禁串起来；它不证明真实供应商生成质量。

## 全量验证摘要

| 验证 | cwd | 命令摘要 | 结果 |
| --- | --- | --- | --- |
| 后端全量 | `backend-node` | Node 后端测试合集 | exit 0；3141 total / 3133 pass / 8 skip / 0 fail |
| 前端测试 | `frontweb` | 前端测试合集 | exit 0；894 / 894 pass |
| 前端构建 | `frontweb` | production build | exit 0；存在 Vite chunk size warning |
| Playwright 回归 | `frontweb` | 本地浏览器回归 | exit 0；3 / 3 与 15 / 15 pass |
| feature-lock | 仓库根 | feature lock ready 检查 | exit 0；ready；6 changedPaths；1 changed path set |
| productionPreflight 合同 | `backend-node` | production preflight 测试 | exit 0；11 / 11 pass |
| TEMP preflight | 仓库根 / 临时 DB | TEMP preflight | exit 0；16 / 16 ready |
| locale preflight | worker 相关包 | locale preflight | ready；disabled 路径 fail-closed |
| Python worker | worker 相关包 | Python 测试合集 | exit 0；88 OK / 7 skip |

## 提交摘要

本轮证据父 HEAD 前的主要 commit 包括：

- `af3ab8a3` `feat(转绘): 绑定当前目标对白证据`
- `9b8b1b5e` `fix(转绘): 对齐参考包 V2 下游门禁`
- `32579dff` `fix(转绘): 固化目标对白生成快照`
- `961b3fb2` `fix(转绘): 修复多项净景逐项批准恢复`
- `0ebc23a1` `fix(转绘): 使用镜头相对白时间`
- `80ef4ea9` `fix(转绘): 强化文字净景当前证据门禁`
- `739a1176` `test(转绘): 修复工作台项目创建流程`

完整提交列表以当前分支 git log 为准。

## 清理与状态

- TEMP DB 与本轮本地 venv 临时验证环境已清理。
- 3 个既有 `__pycache__` 目录保留为未跟踪状态，未纳入本次文档提交。
- 报告提交前执行 `git diff --check`、脱敏扫描、绝对路径扫描和仅目标文件 staging 检查。

## 交付边界

本报告只证明本地交付链路通过。它不等同于 Hosted CI 通过，不等同于线上发布完成，也不证明任何真实供应商模型已完成生成。进入下一阶段前，仍需单独授权对应动作，例如 push、Hosted CI、生产候选、生产数据库写入、供应商调用、付费生成或激活。
