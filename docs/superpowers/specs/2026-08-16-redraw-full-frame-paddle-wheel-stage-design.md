# 全帧审核 PaddlePaddle 下载与安装分阶段设计

日期：2026-08-16

状态：设计已确认，待书面规格审查

范围：只在本地把文字运行时的 `paddlepaddle==2.6.2` 从混合的 pip install 拆成受控 wheel 下载和本地安装两阶段。本阶段不联网、不执行 pip、不创建真实 venv、不运行模型 bootstrap 或四组件 smoke、不读取 Key、不上传源片、不调用供应商、不部署。

## 1. 背景与证据边界

修复 `REDRAW_AUDITOR_PYTHON` 前门禁后，新的单次真实双 venv 验证自然失败在：

```text
REDRAW_FULL_FRAME_MODEL_UNAVAILABLE stage=install:text:paddlepaddle
```

终态不存在最终缓存、main/text venv、`model-lock.json` 或随机 staging，证明原子清理合同有效。当前安装命令同时承担网络下载和本地安装；稳定阶段只能定位到整个 pip install，无法区分下载与安装边界。

本地审计 Python 为 3.12.13，官方包元数据存在 PaddlePaddle 2.6.2 对应的 CPython 3.12 Windows x86-64 wheel。因此本设计不调整 Python 或 PaddlePaddle 版本，也不根据未保留的底层 stderr 猜测根因。

## 2. 方案选择

### 2.1 已确认方案：仅拆分 PaddlePaddle

只对 `runtime=text`、canonical package `paddlepaddle`、精确 requirement `paddlepaddle==2.6.2` 使用两阶段流程：

1. text venv 的 pip 把唯一兼容 wheel 下载到 staging 内受控目录；
2. Node 校验下载目录和 wheel 证据；
3. text venv 的 pip 使用 `--no-index --no-deps` 从相对 wheel 路径安装；
4. 安装后再次复核 wheel 身份并删除内部临时 wheel 目录；
5. 任一步失败沿用整个随机 staging 清理和禁止发布合同。

其他主运行时和文字运行时依赖保持现有安装流程，避免扩大本次改动。

### 2.2 未采用方案

| 方案 | 不采用原因 |
| --- | --- |
| 全部依赖改为统一 wheelhouse | 部分固定包可能只有源码分发或需要构建依赖，会扩大依赖解析与供应链改动 |
| 解析 pip 原始 stderr 推断错误类别 | stderr 属于不受信任输入，可能含 URL、绝对路径、代理或伪造关键词 |
| 保存完整 pip 日志供人工查看 | 违反现有脱敏合同，并增加本机路径和网络信息泄露面 |
| 直接再次真实执行 | 当前授权已消耗，且混合阶段无法提供更细证据 |

## 3. 固定命令合同

### 3.1 下载

下载命令只允许由 text venv 解释器执行，参数固定为：

```text
-m pip --isolated download
--disable-pip-version-check
--no-input
--index-url https://pypi.org/simple
--no-deps
--only-binary=:all:
--dest runtime/text/.wheel-stage/paddlepaddle
paddlepaddle==2.6.2
```

约束：

- `cwd` 固定为本次随机 staging；
- 子进程环境继续使用现有安全白名单和 `PYTHONUTF8=1`；
- 禁止 extra index、find-links、代理透传、shell 和自由参数；
- 下载目录必须在 staging 内由获取器创建，执行前必须不存在；
- 本地测试只能注入 fake runner，不得实际执行该命令。

### 3.2 本地安装

下载证据通过后，安装命令固定为：

```text
-m pip --isolated install
--disable-pip-version-check
--no-input
--no-index
--no-deps
runtime/text/.wheel-stage/paddlepaddle/WHEEL_BASENAME
```

安装阶段不得再使用 `--index-url`、extra index 或 find-links；最后一个参数必须是获取器刚刚验证的 staging 内相对 wheel 路径。

## 4. Wheel 证据门禁

下载完成后必须同时满足：

- 目录中恰好一个条目；
- 条目是普通文件且不是符号链接、连接点或目录；
- 文件名 canonical package 为 `paddlepaddle`、版本为 `2.6.2`、扩展名为 `.whl`；
- 文件名不含路径分隔符、空段、`.` 或 `..`；
- lexical path 与 realpath 均位于受控下载目录；
- 安装前记录普通文件身份；安装后重新执行 lstat、realpath 和身份复核；
- 任一目录漂移、额外文件、非 wheel、路径逃逸或身份变化都 fail closed；
- wheel 目录只属于本次随机 staging，成功安装并复核后删除；删除失败阻止缓存发布。

不把 wheel 路径、文件名、下载 URL、大小或底层错误写入 stdout、stderr、模型锁或验收报告。

## 5. 稳定阶段与脱敏

新增唯一下载阶段：

```text
download:text:paddlepaddle
```

行为边界：

- 下载命令启动失败、超时、非零退出、输出超限或 wheel 证据不合格，统一返回 `download:text:paddlepaddle`；
- 下载成功后本地安装失败、安装期间 wheel 漂移或内部 wheel 目录清理失败，返回现有 `install:text:paddlepaddle`；
- raw Error 即使伪造合法阶段也不能覆盖当前可信阶段；
- 对外错误不附带 cause、context、stdout、stderr、命令、URL、wheel 路径、缓存路径、Key、Authorization 或代理信息；
- 不增加重试、fallback、备用索引或版本漂移。

`normalizeStage` 只接受固定组合 `download:text:paddlepaddle`，不开放任意 runtime/package 形成新的可信阶段。

## 6. 编排与原子性

`installRuntime()` 遍历现有不可变 text package specs。只有命中精确 PaddlePaddle spec 时调用受控两阶段 helper；其他 spec 保持原调用顺序和参数。

数据流固定为：

```text
create text venv
  -> install earlier text specs
  -> download PaddlePaddle wheel
  -> validate wheel evidence
  -> install validated local wheel
  -> revalidate and remove wheel stage
  -> continue remaining text specs
  -> freeze
  -> python version
  -> write runtime lock
```

失败时仍只递归删除本次随机 staging；不得递归删除用户目标，不得保留或发布部分 main/text runtime，不得生成最终模型锁。

## 7. TDD 与验证合同

先修改 `backend-node/test/redrawFullFrameDetectorProcess.test.js` 并取得红灯，再修改 `backend-node/scripts/fetch-redraw-full-frame-models-local.js`。

至少覆盖：

1. PaddlePaddle 先 download、证据通过后再 local install；
2. download 与 install 都使用 text venv、固定 cwd、安全环境和数组 argv；
3. download 使用固定 PyPI simple，install 使用 `--no-index` 且不含任何网络索引；
4. 其他 53 个 main/text 固定依赖调用顺序和参数保持不变；
5. download 非零失败稳定为 `download:text:paddlepaddle`；
6. local install 非零失败稳定为 `install:text:paddlepaddle`；
7. 空目录、额外文件、非 wheel、错误包名/版本、目录、symlink/junction、realpath 或身份漂移全部拒绝；
8. raw 错误伪造阶段及敏感内容不能泄露或改变可信阶段；
9. 失败无最终目录、无模型锁、无 staging 残留；
10. 测试只使用临时目录和 fake runner，不联网、不运行 pip、不创建真实 venv。

验证命令：

```powershell
Set-Location backend-node
node --test --test-concurrency=1 test/redrawFullFrameDetectorProcess.test.js
node --test --test-concurrency=1 test/redrawFullFrameModelLock.test.js test/redrawFullFrameDetectorProcess.test.js test/redrawFullFrameCoverage.test.js test/redrawFullFrameCoverageLocal.test.js test/redrawFullFrameReview.test.js
node --check scripts/fetch-redraw-full-frame-models-local.js
node --check test/redrawFullFrameDetectorProcess.test.js
git diff --check
```

Windows 无法创建符号链接或连接点时，只允许既有显式 EPERM skip；新增核心下载/安装阶段测试不得 skip。

## 8. 完成和后续真实执行边界

本地阶段完成必须满足：

- 红灯原因是缺少 PaddlePaddle 两阶段行为；
- 目标和联合测试 0 fail；
- 静态、差异、脱敏与两阶段审查通过；
- tracked clean，只保留任务前既有未跟踪目录；
- 没有网络、pip、真实 venv、模型 bootstrap、四组件 smoke、Key、供应商、数据库、SSH、部署或 push。

完成本设计不代表 PaddlePaddle 安装成功或四组件可用。任何新的真实 fetch 仍需用户另行给出一次且仅一次授权；失败仍不得自动重试。
