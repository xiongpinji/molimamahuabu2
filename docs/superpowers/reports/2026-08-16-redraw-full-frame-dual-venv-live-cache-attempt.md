# 全帧审核双 venv 真实缓存单次验收报告

日期：2026-08-16

## 授权与边界

本次获得一次且仅一次真实官方模型缓存与四组件 smoke 授权，允许联网获取官方组件、创建本地 `main`/`text` 两个 venv 并安装固定依赖。失败不得自动重试，不部署、不 SSH、不写数据库、不读取 Key、不调用生成供应商。

执行代码基线：`73cdad08`。

## 唯一执行结果

- 执行次数：`1`；
- 进程退出码：`1`；
- 耗时：`29.945` 秒；
- 稳定失败阶段：`create_venv:main`；
- 结果 JSON：`0`；
- 最终缓存：不存在；
- `model-lock.json`：不存在；
- 随机 staging：`0`；
- 四组件真实 smoke：未开始，因此未完成。

获取器固定顺序先获取四个官方组件，再进入 `create_venv:main`。本次已进入该阶段，但没有启动 `python -m venv`。

## 根因证据

- 获取器的 `runtimePython()` 要求父进程显式提供 `REDRAW_AUDITOR_PYTHON`；
- 本次提升权限执行 harness 未传入该变量；
- 受控 bundled Python 文件存在，但不会被获取器隐式猜测或回退使用；
- 因此 `createVenv()` 在启动 Python 子进程前 fail closed，并只输出稳定阶段；
- 该缺口属于真实执行前门禁遗漏，不是 Paddle、protobuf、OpenMP 或四组件模型加载失败。

## 原子性与脱敏复核

- 最终缓存、锁文件和 staging 均不存在；
- 原工作树 tracked 文件保持干净；
- 诊断证据已保留，但本报告不记录其本机路径；
- 输出扫描未命中 OpenMP Error #15、KMP workaround、凭据、Authorization、URL、源片路径或缓存绝对路径；
- 诊断标准错误仅包含稳定错误码与 `create_venv:main` 阶段。

## 结论与后续门禁

本次唯一真实执行失败且已停止，没有重试或 fallback。不能宣称官方模型缓存成功、双 venv 创建成功、依赖安装成功或四组件 smoke 成功。

再次真实执行之前，应先在纯本地 TDD 范围修复两项前门禁：

1. 真实 harness 必须显式传入已验证的 bundled Python；
2. 获取器必须在任何官方组件联网获取前验证 `REDRAW_AUDITOR_PYTHON`，避免同类配置错误先消耗网络获取。

完成本地修复与审查仍不构成新的真实执行授权。
