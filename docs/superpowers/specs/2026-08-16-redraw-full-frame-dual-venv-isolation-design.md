# 全帧审核双 venv 进程隔离补充设计

日期：2026-08-16

状态：设计已批准，待书面规格审查

范围：仅在本地把整集全帧人物/人脸/跟踪与 PaddleOCR 文字审核拆分到两套 Python 虚拟环境；本阶段不下载模型、不安装官方运行时、不读取 Key、不上传源片、不调用供应商、不产生付费任务、不写生产数据库、不部署

## 1. 背景与问题定性

原 `redraw-full-frame-paddle-process-isolation` 设计已经把 PaddleOCR 放入常驻子进程，但主进程和文字子进程仍使用同一个 `.venv`。六次一次性真实缓存尝试均未发布最终缓存；最近一次稳定失败阶段为：

```text
REDRAW_FULL_FRAME_MODEL_UNAVAILABLE stage=bootstrap:load:text:import_paddle
```

本地已缓存包元数据确认：

- `mediapipe==0.10.14` 要求 `protobuf>=4.25.3,<5`；
- Windows `paddlepaddle==2.6.2` 要求 `protobuf>=3.1.0,<=3.20.2`；
- 当前单 venv 固定 `protobuf==4.25.9`，并用 `--no-deps` 安装 PaddlePaddle；
- 当前文字子进程虽然隔离了 native 地址空间，但没有隔离 Python 依赖解析结果。

因此，继续修改同一 venv 的安装顺序或重复真实下载不能解决已确认的版本冲突。正确修复边界是同时隔离进程与虚拟环境。

## 2. 方案选择

### 2.1 已批准方案：双 venv、单一外层协议

- 主运行时 venv：YOLOX、ByteTrack、MediaPipe 和其固定依赖，使用 protobuf 4.x；
- 文字运行时 venv：PaddlePaddle、PaddleOCR detection 和其固定依赖，使用 protobuf 3.20.2；
- Node.js 仍只启动主 worker；
- 主 worker 仍通过现有严格 JSONL 协议管理一个常驻文字子进程；
- 外层 Node.js → Python 协议、全帧候选 schema、人工审核和 finalize 门禁不变。

### 2.2 未采用方案

| 方案 | 不采用原因 |
| --- | --- |
| 在同一 venv 调整安装顺序 | 无法同时满足两个互斥的 protobuf 版本合同 |
| 继续用 `--no-deps` 强压 PaddlePaddle | 包可安装不代表可导入，真实失败已落在 `import_paddle` |
| 设置 `KMP_DUPLICATE_LIB_OK` 或弱化 freeze 门禁 | 会掩盖 native/依赖冲突，不能证明结果正确 |
| Node.js 直接编排两个完整审核 worker | 扩大外层协议和服务改动面，当前没有必要 |

## 3. 固定缓存布局

双 venv 缓存在发布前 staging 和发布后最终目录中使用同一相对布局：

```text
model-lock.json
runtime/
  main/
    .venv/
    pip-freeze.txt
  text/
    .venv/
    pip-freeze.txt
<四个现有组件的模型与许可证证据>
```

约束：

- 两个 venv 都由同一个受控基础 Python 创建，但分别安装和冻结；
- `runtime/main` 不得包含 `paddlepaddle`、`paddleocr` 或 protobuf 3.20.2；
- `runtime/text` 不得包含 `torch`、`torchvision`、`yolox`、`mediapipe` 或 ByteTrack 运行包；
- 两个 freeze 都使用 canonical package name、精确版本和严格白名单；未知包、重复 canonical name、缺包、漂移版本和错误平台包均 fail closed；
- venv、freeze、模型和许可证证据全部完成并通过 smoke 前，不得发布最终缓存。

## 4. 模型锁 v2

### 4.1 顶层合同

新缓存只接受：

```json
{
  "schema_version": "redraw-full-frame-model-lock-v2",
  "runtimes": {
    "main": {},
    "text": {}
  },
  "components": []
}
```

顶层只允许 `schema_version`、`runtimes`、`components`。四组件顺序、官方来源、revision、模型哈希和许可证哈希沿用 v1 严格合同。

### 4.2 运行时合同

`runtimes.main` 与 `runtimes.text` 都只能包含：

```json
{
  "python_version": "Python 3.x.y",
  "interpreter_path": "runtime/<name>/.venv/Scripts/python.exe",
  "pip_freeze_path": "runtime/<name>/pip-freeze.txt",
  "pip_freeze_sha256": "<64 位小写 sha256>"
}
```

非 Windows 平台的解释器尾部为 `.venv/bin/python`。所有路径必须为规范化相对路径，禁止绝对路径、盘符路径、空段、`.`、`..`、符号链接/连接点逃逸和 realpath 漂移。解释器必须是缓存根内的普通可执行文件；freeze 必须是缓存根内普通文件，读取时使用与现有模型证据一致的打开前后身份复核。

模型锁的 canonical SHA-256 必须绑定：

- v2 schema；
- 两个运行时的 Python 版本；
- 两个解释器相对路径；
- 两个 freeze 相对路径与内容哈希；
- 四个组件及许可证证据。

### 4.3 v1 兼容边界

没有成功发布过可用的 v1 官方缓存，因此新 fetch、主 worker bootstrap、正常 run 和文字 worker 一律拒绝 v1，不能在运行时猜测或自动迁移。历史测试夹具按 v2 机械迁移；历史报告只读保留，不改写旧证据。

## 5. 运行时依赖边界

依赖清单在 Node.js 获取器中拆为两个不可变精确数组，并由测试验证 canonical package 集、安装顺序、`--no-deps` 白名单和平台条件。

### 5.1 主运行时

主运行时只承担：

- YOLOX person detection；
- ByteTrack；
- MediaPipe face detection；
- OpenCV/NumPy/Torch 及这些组件的固定直接与传递依赖；
- `protobuf==4.25.9`。

### 5.2 文字运行时

文字运行时只承担：

- PaddlePaddle 2.6.2；
- PaddleOCR 2.8.1 的 detection 路径；
- detection 顶层 import 所需的固定直接与传递依赖；
- `protobuf==3.20.2`；
- 不初始化 recognition，不返回 OCR 原文。

两个集合可以在各自 venv 中拥有相同版本的通用纯 Python/图像包；是否同名不构成冲突。门禁判断的是每个 venv 自身是否精确匹配其策略，不对两个集合做错误的全局去重。

## 6. 构建与启动数据流

### 6.1 本地 fetch 构建顺序

未来获得单独真实下载授权后，获取器固定执行：

1. 在同父目录随机 staging 中获取四个官方模型和许可证证据；
2. 创建 `runtime/main/.venv`；
3. 安装、freeze 并校验主运行时；
4. 创建 `runtime/text/.venv`；
5. 安装、freeze 并校验文字运行时；
6. 原子写入两个 `pip-freeze.txt`；
7. 原子写入 v2 `model-lock.json`；
8. 用主解释器启动主 worker bootstrap；
9. 主 worker 从 v2 锁中解析并复核文字解释器，再启动文字子进程；
10. 四组件真实 smoke 全部成功后复验 v2 锁；
11. 目标仍不存在或仍为空时，同盘原子 rename 发布。

任一步失败只清理本次随机 staging，不删除用户目标、不覆盖旧缓存、不自动重试、不 fallback。

### 6.2 正常运行

- Node 服务继续只接收主 Python、worker 文件和 `model-lock.json`；
- 主 worker 校验 v2 锁后，只用 `runtimes.main.interpreter_path` 所在进程加载 person/tracker/face；
- `_default_text_process_factory` 不再使用 `sys.executable`，而使用已验证的 `runtimes.text.interpreter_path`；
- 文字子进程再次校验同一 v2 锁，只绑定 `text_detector` 和文字运行时；
- 文字子进程的固定脚本、参数、环境白名单、单 in-flight、超时、输出上限和关闭合同沿用已通过的 v1 进程隔离设计。

## 7. 失败阶段与脱敏

新增或替换的安全阶段只允许固定枚举：

- `create_venv:main`
- `create_venv:text`
- `install:main:<canonical-package>`
- `install:text:<canonical-package>`
- `freeze:main`
- `freeze:text`
- `python_version:main`
- `python_version:text`
- `write_runtime_lock:main`
- `write_runtime_lock:text`
- `write_model_lock`
- 现有 `bootstrap:*`、`validate`、`publish`

包名必须来自对应固定 direct spec，不能接受底层错误伪造的阶段。对外仍只有稳定错误码和可信阶段；不得附带 cause、context、stderr、命令、解释器路径、缓存路径、URL、Key、Authorization 或代理信息。

真实执行 harness 必须直接调用 Node 脚本或使用 `npm --silent`，避免 npm banner 回显 `--output-dir`。验收日志只做布尔扫描，不回显敏感原文；任何缓存绝对路径命中都判失败。

## 8. 原子性与并发边界

- 双 venv 仍属于一个不可分割缓存候选；不允许只发布其中一个；
- 两个 freeze 和 v2 锁写入均使用临时文件 + rename；
- 发布前重新检查目标目录状态；
- 不递归删除用户指定目标；
- 不修改现有 `current`、生产模型目录或任何数据库；
- 本阶段只使用 fake runner、fixture freeze、临时目录和仓库内测试，不执行 pip install、venv 创建、网络 fetch 或真实 bootstrap。

## 9. 测试合同

### 9.1 Node.js

至少覆盖：

- 两个 venv 的固定创建顺序和相对位置；
- 主/文字依赖策略、protobuf 版本和互斥包；
- 每个安装命令只使用自己的解释器和安全环境；
- 两个 freeze 分别精确通过，未知/重复/漂移/跨环境包拒绝；
- v2 两运行时字段、freeze 文件哈希、解释器相对路径和 canonical hash；
- v1、未知字段、路径逃逸、符号链接/连接点、hash 漂移、解释器缺失/非普通文件拒绝；
- 任一中途失败无最终目录、无 model-lock、无 staging 残留；
- CLI 只输出稳定错误码和可信阶段；
- 测试不得调用网络、pip、真实 venv 或官方模型。

### 9.2 Python

至少覆盖：

- v2 精确字段、两个运行时和四组件校验；
- 主 worker 不 import Paddle/PaddleOCR；
- 默认文字工厂使用锁内已验证的文字解释器，不使用 `sys.executable`；
- 文字解释器绝对路径、`..`、不存在、目录、symlink/junction 逃逸和读时漂移拒绝；
- 主解释器与文字解释器不能相同文件；
- 文字 worker 只绑定 text runtime/text detector；
- 现有握手、帧请求、超时、关闭、safe-stage 和敏感输出回归保持通过。

### 9.3 联合回归

- 相关 Node 五组测试保持 0 fail；
- Python worker 全套保持 0 fail；
- Node/Python v2 schema、运行时名称、相对路径字段和 safe-stage 枚举必须有一致性测试；
- `node --check`、`py_compile`、`git diff --check` 全部通过；
- 规格审查和代码质量审查的 Critical/Important/Medium 均为 0。

## 10. 本阶段非目标

本阶段明确不执行：

- 任何真实模型下载、pip 安装、venv 创建或四组件真实 smoke；
- 读取 Key、上传源片、调用 Fumin/ToAPIs 或其他供应商；
- 修改全帧候选、review decisions、finalize、前端画布或业务 API；
- 部署、SSH、生产数据库写入、发布候选、activate 或 push；
- 自动迁移旧缓存、自动重试、备用模型或弱化门禁。

## 11. 完成与后续授权关卡

本地实现阶段完成必须同时满足：

- v2 双运行时模型锁、双 venv 获取器编排和 Python 解释器选择全部实现；
- 单元、联合和静态检查全部通过；
- 规格审查与代码质量审查无未解决问题；
- 工作树除任务前既有未跟踪目录外无脏改；
- 没有发生网络下载、安装、Key 读取、供应商调用或部署。

完成上述本地关卡仍不代表模型可用。只有用户另行明确授权“一次真实官方模型缓存与四组件 smoke”后，才允许执行一次真实 fetch；成功终态、最终缓存、双 freeze、v2 锁和四组件 smoke 都被独立验证后，才能恢复原整集全帧审核任务。
