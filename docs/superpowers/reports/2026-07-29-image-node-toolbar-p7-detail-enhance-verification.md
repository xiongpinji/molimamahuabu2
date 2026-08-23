# 图片节点工具栏 P7：细节纹理增强验证报告

## 范围与结论

- 本阶段只实现“细节纹理增强”，不包含核验、侵权检测或版权判断。
- 复用 P4 已审计的 Real-ESRGAN NCNN Vulkan Windows 成品引擎和项目已有 Sharp，没有新增运行时依赖或模型权重。
- “高清增强”继续输出 2x / 3x / 4x 新尺寸；“细节纹理增强”固定先做 2x 超分，再回落到源图尺寸并按三档预设锐化。
- 原素材不覆盖；成功结果写入新的派生素材、异步任务和节点处理历史。
- 真实本地引擎、前端、后端、数据库、文件和刷新回读同链已通过；整个图片工具栏仍未完成。

## 来源与许可证边界

- Real-ESRGAN 主项目：<https://github.com/xinntao/Real-ESRGAN>
- Real-ESRGAN 主项目许可证为 BSD-3-Clause：<https://github.com/xinntao/Real-ESRGAN/blob/master/LICENSE>
- Real-ESRGAN-ncnn-vulkan：<https://github.com/xinntao/Real-ESRGAN-ncnn-vulkan>
- Real-ESRGAN-ncnn-vulkan 许可证为 MIT：<https://github.com/xinntao/Real-ESRGAN-ncnn-vulkan/blob/master/LICENSE>
- 使用的 Windows 便携包版本为 `0.2.5.0`，可执行文件、`vcomp140.dll`、模型 `.bin` 和 `.param` 均继续由 P4 固定 SHA-256 探针校验。
- 临时研究包中的 `vcomp140d.dll` 不在运行时审计清单中，也未进入仓库或提交；正式服务器制品必须继续排除该 Debug DLL 并附齐 notices。

## 实现与隔离

- 只有 Real-ESRGAN 能力探针通过时，后端才公布 `detail_enhance.available=true`。
- 能力只公开 `natural`、`balanced`、`strong` 三档预设，并声明 `preservesDimensions=true`。
- 处理链：
  1. 读取并校验源图格式、尺寸和 2x 临时产物像素上限；
  2. 通过无 shell 的 Real-ESRGAN `execFile` 生成 2x PNG；
  3. 校验 2x 产物格式、尺寸、大小和可解码性；
  4. 使用 Sharp Lanczos3 回落到源尺寸并执行受限锐化；
  5. 再次校验最终 PNG 的宽高、大小和可解码性；
  6. 删除中间 2x 文件并创建新的派生资产。
- Real-ESRGAN 与细节增强共享同一个并发门禁，避免两类任务绕过本地 GPU 并发限制。
- 非法预设返回 400；引擎失败、超时或产物异常统一返回脱敏后的图片处理错误。
- 灯光、姿势、角度、全景、联想、对口型等未完成能力仍保持不可用。

## TDD 与自动化证据

红灯阶段：

- 后端能力测试因 `detail_enhance.available=false` 失败。
- 后端执行测试因操作仍返回 `IMAGE_TOOL_OPERATION_UNAVAILABLE` 失败。
- 前端测试因没有三档预设和参数提交失败。

绿灯与正式回归：

- 后端图片工具目标测试：27/27 通过。
- 前端图片工具栏目标测试：11/11 通过。
- 后端全量测试：458/458 通过，19 个套件，0 失败。
- 前端全量测试：331/331 通过，0 失败。
- 前端生产构建：通过；仅保留项目既有的大分块警告。
- 后端官方 npm registry 审计：0 vulnerabilities。
- 前端官方 npm registry 审计：0 vulnerabilities。
- `node --check src/services/imageToolService.js`：通过。
- `git diff --check`：通过，仅有 Git 的 LF/CRLF 工作区提示。

覆盖点包括：

- 未通过固定哈希审计时能力保持不可用。
- 能力通过时只公布三档预设和保持尺寸语义。
- 成功结果尺寸等于源图，metadata 记录模型、固定 2x 取样、预设和引擎版本。
- 原素材字节保持不变。
- 中间 2x 文件成功和失败后均不残留。
- 非法预设拒绝。
- Real-ESRGAN 原始失败信息不进入前端或失败任务。

## 真实浏览器与产物证据

隔离环境：

- 工作树：`C:\Users\canqu\Documents\茉莉妈妈2\wt-image-node-toolbar`
- 数据与素材：`C:\Users\canqu\AppData\Local\Temp\molimama-image-tools-e2e-20260728`
- 后端：`127.0.0.1:3033`
- 前端：`127.0.0.1:5699`
- Real-ESRGAN 研究包：`C:\Users\canqu\AppData\Local\Temp\molimama-real-esrgan-ncnn-v0250-20260728\package`
- 独立画布：`/canvas/2`
- 源节点：`free:image:1785261445656`

浏览器操作：

1. 新开本地验收标签页，没有切换或关闭用户已打开的参考站标签页。
2. 选中图片节点，打开“设定”菜单。
3. 确认“细节纹理增强”可用；灯光、全景、角色三视图、九宫格、前后推演等仍显示“未接通”。
4. 对话框默认选择“标准”，并明确提示“2x 超分取样后回落到原尺寸”。
5. 点击“应用并生成新素材”，真实 Real-ESRGAN 本地任务完成。
6. 刷新页面，新素材仍出现在素材库；处理历史首项仍为“细节纹理增强 / 已完成”。

后端与文件回读：

- 任务：`b0612090-1229-4ae1-a0c2-0e94f103b573`
  - `type=image_tool_detail_enhance`
  - `status=completed`
  - `progress=100`
  - `error=null`
- 源素材：`asset_id=18`
  - `width=2880`
  - `height=1620`
  - `file_size=67634`
  - SHA-256：`9B82D84B008527EE1FD32D5DAF9E107EA27A0F5A2892E94C35CB28BA1228DD64`
  - 文件仍存在且未覆盖
- 派生素材：`asset_id=19`
  - `operation=detail_enhance`
  - `engine=realesrgan-ncnn-vulkan+sharp`
  - `engineVersion=0.2.5.0+sharp-0.35.3`
  - `preset=balanced`
  - `scale=2`
  - `preserveDimensions=true`
  - `width=2880`
  - `height=1620`
  - `mime_type=image/png`
  - `file_size=297056`
  - SHA-256：`23AA67430E751CF72A5A398E3CB65F043A43AB094C5890731E4672C23EA3AEAC`
- 源图与结果图的平均通道绝对差为 `4.0746`，变化通道占 `99.9435%`，证明产物不是原文件复制或仅改名。
- 派生目录没有残留 `detail-enhance-upscale` 中间文件。

## 验收标记

```text
implemented=true
real_engine_verified=true
real_browser_verified=true
backend_readback=true
artifact_verified=true
failure_writeback=true
productComplete=false
```

## 未解除的发布阻断

- 标记修图、灯光与电影级光影、全景、姿势、角度、联想、三视图、九宫格、前后帧推演和对口型仍未完成。
- Linux 线上服务器需要选择并重新审计对应平台的 Real-ESRGAN 运行时；当前固定哈希只覆盖 Windows `0.2.5.0` 研究包。
- 正式服务器制品必须排除未审计的 Debug DLL，并补齐 Real-ESRGAN、Real-ESRGAN-ncnn-vulkan、ncnn 及全部子依赖 notices。
- 全功能总审计完成前，不推送、不创建 PR、不部署。

## 本地验证环境清理

- 已关闭本地 `127.0.0.1` 验证标签页，参考站标签页 `id=15` 保留且未操作。
- 已停止端口 `3033` 与 `5699` 的本地验证进程，并确认两个端口均不再监听。
- 已删除本轮两个临时 PowerShell 启动脚本；它们不进入版本控制。
