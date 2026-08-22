# 全帧审核 PaddleOCR 进程隔离补充设计

日期：2026-08-16

状态：设计已通过，待书面规格审查

范围：仅修复整集全帧人物与文字区域审核的本地运行时冲突；不调用供应商，不读取 Key，不上传源片，不产生付费任务，不写生产数据库，不部署

## 1. 背景与已确认事实

主设计仍为 `redraw-full-frame-coverage-v1`。真实本地兼容性探针已经确认：

- YOLOX/Torch 人物检测、ByteTrack、MediaPipe 人脸检测和 PaddleOCR 文字检测各自能够独立加载；
- YOLOX/Torch 与 PaddleOCR/PaddlePaddle 在同一 Windows 进程内加载时，无论加载顺序如何，都会触发 OpenMP Error #15 并中止进程；
- `KMP_DUPLICATE_LIB_OK=TRUE` 被运行库明确标记为不安全 workaround，不能作为修复；
- 外层 Node.js → Python JSONL 协议、模型锁和全帧证据合同无需改变。

因此，本补充设计只调整 Python 检测器内部的进程边界，不改变用户可见流程、证据 schema 或最终审核门禁。

## 2. 方案选择

### 2.1 已批准方案

使用同一隔离虚拟环境，将 PaddleOCR text detection 放入常驻本地子进程：

- 主 Python worker 只加载 YOLOX、ByteTrack 和 MediaPipe；
- Paddle 子进程只加载 PaddleOCR/PaddlePaddle；
- 主 worker 继续向外层 Node.js 返回原有单帧合并结果；
- 两个 Python 进程共享同一个已锁定模型缓存和 `model-lock.json`，但不共享 native runtime 地址空间。

### 2.2 未采用方案

| 方案 | 不采用原因 |
| --- | --- |
| 调整 import 顺序或延迟加载 | 两种加载顺序均已真实失败，不能解决进程内 native runtime 冲突 |
| 设置 `KMP_DUPLICATE_LIB_OK` | 可能掩盖重复 OpenMP runtime，存在崩溃或错误结果风险 |
| Node.js 同时编排两个完整 worker | 会扩大 Node 服务、runner 和测试改动面，不符合最小修改原则 |
| 为 Paddle 建立第二套虚拟环境 | 会显著增加运行时锁、缓存和许可证证据复杂度，当前没有必要 |

## 3. 组件边界

### 3.1 主 worker

主 worker 保留以下职责：

- 校验 `model-lock.json` 和 4 个模型组件；
- 加载 YOLOX、ByteTrack、MediaPipe；
- 启动、探针和关闭 Paddle 子进程；
- 按原顺序处理人物、人脸、文字和轨迹；
- 校验 Paddle 子进程响应并合并到原有 `sanitize_result`；
- 对外只输出原有脱敏 JSONL 结果。

主 worker 禁止 import `paddle`、`paddleocr` 或其子模块。

### 3.2 Paddle 子进程

Paddle 子进程使用当前虚拟环境的 `sys.executable` 启动同一个受版本控制的 worker 入口，并运行专用内部命令。它只负责：

- 再次校验同一 `model-lock.json`；
- 定位锁定的 PaddleOCR detection 模型目录；
- 仅初始化 `TextDetector`，不初始化 recognition；
- 读取本地帧并返回文字候选多边形与置信度；
- 在 stdin 关闭、收到退出请求、协议错误或父进程关闭时退出。

子进程不得返回 OCR 原文、模型路径、帧路径、异常堆栈或任意额外字段。

## 4. 内部 JSONL 协议

### 4.1 启动成功

Paddle 子进程完成模型加载后，必须先输出且只输出：

```json
{"status":"ok","schema_version":"redraw-full-frame-text-subprocess-v1"}
```

主 worker 在启动超时前没有收到完全匹配的对象时，必须终止子进程并失败。

### 4.2 单帧请求

```json
{
  "request_id": 1,
  "frame_path": "D:/redraw-local/frames/frame-000001.png"
}
```

约束：

- 只允许 `request_id` 和 `frame_path` 两个字段；
- `request_id` 为从 1 开始单调递增的安全整数；
- `frame_path` 仅在本机父子进程之间传递，不写入 stdout 日志、manifest 或报告；
- 一次只允许 1 个在途请求，避免响应乱序。

### 4.3 单帧响应

```json
{
  "request_id": 1,
  "texts": [
    {
      "candidate_id": "text_1",
      "kind": "text_candidate",
      "polygon": [
        {"x": 10.0, "y": 20.0},
        {"x": 40.0, "y": 20.0},
        {"x": 40.0, "y": 35.0}
      ],
      "confidence": 0.99
    }
  ]
}
```

主 worker 必须复用现有文字候选验证规则，并额外校验：

- 响应只能包含 `request_id` 和 `texts`；
- `request_id` 必须与当前请求完全一致；
- `texts` 必须为数组；
- 任意 `text`、`ocr_text`、`recognized_text`、路径或未知字段都必须拒绝；
- 非有限坐标、退化多边形和越界置信度必须拒绝。

## 5. 进程与环境安全

### 5.1 启动

子进程固定使用：

- 当前虚拟环境的 `sys.executable`；
- 当前受版本控制的 worker 文件；
- 固定内部命令和 `--model-lock` 参数；
- `shell=false` 和隐藏窗口；
- 独立 stdin/stdout/stderr 管道。

不得接受用户提供的可执行文件、脚本、命令、额外参数或环境变量。

### 5.2 环境白名单

子进程只继承存在的以下系统变量：

- `PATH`
- `SystemRoot`
- `WINDIR`
- `TEMP`
- `TMP`

并固定：

- `PYTHONUTF8=1`
- `PYTHONIOENCODING=utf-8`

必须剔除 Key、Authorization、供应商配置、代理变量、`PYTHONPATH`、`PYTHONHOME`、`KMP_DUPLICATE_LIB_OK` 以及其他未列出的变量。

### 5.3 生命周期

- 主 worker 每次运行只启动 1 个常驻 Paddle 子进程；
- bootstrap 和正常 run 均必须执行真实子进程探针；
- 主 worker 在 `finally` 中关闭子进程 stdin，并在短等待后终止仍未退出的子进程；
- 子进程 stderr 必须持续排空但不得原样转发；
- stderr、stdout 和单行响应均设字节上限；
- 父进程意外退出后，子进程必须因管道 EOF 自行退出；
- 不允许每帧重新启动 Paddle，也不允许失败后自动重启或重试。

## 6. 超时与失败合同

以下任一情况都统一抛出 `REDRAW_FULL_FRAME_MODEL_UNAVAILABLE`，不得返回部分结果：

- 子进程启动、模型加载或启动握手超时；
- 单帧响应超时；
- stdin 写入失败、EPIPE、子进程非零退出或提前退出；
- stdout/stderr 超过上限；
- 非 UTF-8、非法 JSON、空行、多行响应或未知 schema；
- `request_id` 不匹配；
- 响应含 OCR 原文、路径或未知字段；
- 主 worker 关闭时无法安全终止子进程。

错误消息、日志和上层响应不得包含源片路径、抽帧路径、模型缓存路径、底层异常、Key 或 Authorization。

## 7. Bootstrap 与真实 smoke

模型获取器保持现有原子发布流程。bootstrap 必须在最终缓存发布前完成：

1. 主进程真实加载 YOLOX、ByteTrack 和 MediaPipe；
2. 主进程启动 Paddle 子进程；
3. Paddle 子进程真实加载 PaddleOCR detection 模型并完成固定握手；
4. 对仓库生成的本地无敏感内容探针图执行 1 次文字 detection；
5. 主进程校验响应 schema 后关闭子进程；
6. 任一步失败都删除 staging，不能发布最终模型缓存。

该 smoke 不能 skip，也不能使用 fake detector 代替真实模型。

## 8. 测试要求

### 8.1 Python 单元测试

至少覆盖：

- 主 worker 默认路径不调用 Paddle 工厂；
- 子进程命令、参数和环境白名单固定；
- Key、Authorization、代理、`PYTHONPATH` 和 `KMP_DUPLICATE_LIB_OK` 不继承；
- 启动握手成功和启动超时；
- 单帧正常响应、`request_id` 不匹配、非法 JSON、额外 OCR 字段、路径字段和未知字段；
- EPIPE、提前退出、stderr/stdout 超限和单帧超时；
- `finally` 关闭、超时终止和 EOF 退出；
- bootstrap 真实调用主进程探针与 Paddle 子进程探针；
- 现有 fake detector 协议测试保持通过。

### 8.2 Node.js 回归

外层 `detectFrames` API 和结果 schema 不变。现有 Node.js 测试必须保持通过，并补充一项真实 bootstrap 失败只能返回脱敏稳定错误码的回归。

### 8.3 真实本地验收

在仓库外缓存中使用锁定依赖和 4 个真实官方模型执行：

- 主 worker 与 Paddle 子进程 bootstrap 成功；
- 单帧 person、face、text 和 tracker smoke 全部真实运行；
- 不设置 `KMP_DUPLICATE_LIB_OK`；
- 不继承 Key、Authorization 或供应商环境；
- 随后才允许继续原计划的真实源片 analyze、人工审核和 finalize。

## 9. 非目标

本补充设计不包括：

- 更换人物、人脸、文字或跟踪模型；
- OCR 文字识别、翻译或字幕重绘；
- 新增供应商接口、付费调用或模型上传；
- 修改全帧 coverage、review decisions 或 reviewed manifest schema；
- 部署、生产数据库写入或线上入口变更；
- 用不安全环境变量、降低门禁、自动重试或备用模型掩盖失败。

## 10. 完成标准

只有同时满足以下条件，才能恢复任务 6 的真实整集全帧审核：

- 设计对应实现和测试全部通过；
- 主 worker 进程中不加载 PaddleOCR/PaddlePaddle；
- Paddle 子进程环境和协议通过对抗测试；
- 4 个真实模型 bootstrap 与单帧 smoke 成功且不可 skip；
- OpenMP Error #15 不再出现；
- `KMP_DUPLICATE_LIB_OK` 在源码、测试运行环境和真实命令中均不存在；
- 代码审查 Critical/Important 为 0；
- 未调用供应商、未付费、未部署。
