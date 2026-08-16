# 全帧审核双 venv 本地验证报告

日期：2026-08-16

范围：仅验证本地双 venv 进程隔离实现。未执行真实模型下载、pip install、venv 创建、真实 bootstrap、密钥读取、源片上传、供应商调用、数据库写入、SSH、部署、activate 或 push。

## 验证基线

- 验证命令运行于 `codex/redraw-r12-merge-20260809`，任务 4 后 HEAD 为 `90f8370e`。
- 本报告提交前新增任务 5 本地一致性改动：Python worker 导出 `RUNTIME_KEYS`，Node 获取器测试用本地 Python 探针读取 worker 固定合同。

## 任务提交

- `65fafeff` `feat(转绘): 升级全帧双运行时模型锁`
- `c0e443e` `test(转绘): 补齐双运行时未知字段门禁`
- `a91029c4` `fix(转绘): 拒绝双运行时解释器硬链接`
- `709e4830` `feat(转绘): 拆分全帧双 venv 获取器`
- `5bbc810e` `fix(转绘): 恢复双 venv 发布空目标`
- `3c59fa8c` `fix(转绘): 收紧双 venv 发布恢复失败`
- `fa772b4b` `feat(转绘): 绑定全帧双运行时解释器`
- `d2b21519` `fix(转绘): 拒绝不可验证运行时文件身份`
- `90f8370e` `fix(转绘): 对齐全帧双运行时证据`
- `5a240819` `fix(转绘): 收紧双运行时合同探针环境`

## 本地测试证据

| 检查 | 结果 |
| --- | --- |
| Node 五组联合回归：model-lock、fetcher、coverage、coverage-local、review | `tests 68; pass 65; fail 0; skipped 3` |
| Python worker 全套回归 | `Ran 61 tests; OK; skipped 1` |
| 获取器单组回归，含 Node/Python 合同探针 | `tests 20; pass 20; fail 0; skipped 0` |
| coverage、coverage-local、review 三组回归 | `tests 35; pass 34; fail 0; skipped 1` |
| Node 语法检查 | fetcher、model-lock service、coverage service、fetcher test 均 exit 0 |
| Python 语法检查 | worker、text worker、text subprocess 均 exit 0 |
| diff 检查 | `git diff --check` exit 0 |
| 源码敏感项扫描 | fetcher 与 worker 源码未命中 KMP workaround 或凭据相关模式 |

Windows 环境的跳过项均为符号链接权限限制导致的显式 skip；非 skip 的 junction、identity drift、hard link、hash drift、路径逃逸和脱敏测试均通过。

## 合同证据

- schema 固定为 `redraw-full-frame-model-lock-v2`。
- runtime 名称固定为 `main`、`text`。
- runtime 字段固定为 `python_version`、`interpreter_path`、`pip_freeze_path`、`pip_freeze_sha256`。
- `main` freeze 策略包含且仅接受 `protobuf==4.25.9`，并拒绝 Paddle 文字运行包。
- `text` freeze 策略包含且仅接受 `protobuf==3.20.2`，并拒绝主运行时 native 组件。
- coverage manifest 的 `models.model_lock_sha256` 绑定 v2 canonical hash，并投影 `runtimes` 与四组件证据。
- 获取器失败路径保持原子性：任一 runtime、bootstrap、validate 或 publish 失败不发布部分缓存，不自动重试。
- 错误阶段只使用可信枚举；测试覆盖伪造 stage、底层诊断文本、命令、路径和敏感字段脱敏。

## 边界声明

本地绿灯只证明代码路径、合同、原子性和测试夹具正确，不证明官方模型缓存已存在，不证明四组件真实 smoke 成功，不证明整集审核完成，也不代表可以部署。

下一步如果要进入真实缓存验证，仍需要新的、一次性的明确授权，并且只能执行一次真实官方模型缓存与四组件 smoke；失败不得自动重试。
