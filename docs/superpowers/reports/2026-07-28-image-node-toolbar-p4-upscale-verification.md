# 图片节点工具栏 P4 高清增强本地验证与审计报告

日期：2026-07-28
分支：`codex/image-node-tool-suite`
范围：仅 `upscale`（高清增强），不包含核验、侵权检测或版权判断。

## 1. 结论

高清增强已在独立工作树、独立数据库、独立素材目录和独立端口完成真实本地链路验证：

- 前端只提交服务端白名单允许的 `scale=2|3|4`，默认 2 倍；不接收客户端命令、模型路径或任意参数。
- 后端只在固定版本、固定目录布局、固定可执行文件/运行库/模型哈希和真实能力探针全部通过后公布能力。
- 处理器使用官方 Real-ESRGAN NCNN Vulkan Windows 便携包；以固定参数、无 shell 的 `execFile` 生成 PNG 派生素材，原图不覆盖。
- 输入和预计输出均限制为 4000 万像素，最终文件限制为 64 MiB；执行超时 300 秒，产物必须完整解码并满足精确倍率尺寸。
- 任务、派生素材、引擎版本、模型、倍率和节点处理历史完整落库，失败时清理文件并写回固定错误。
- 公开模式额外把素材真实路径绑定到当前项目的可信物理目录；普通跨项目路径别名和 Windows junction 项目根绕过均被回归测试拒绝。
- 核验、侵权检测和版权判断仍未加入生产代码。

该结论只表示 P4 在 Windows 本地开发环境完成。本阶段不推送 PR、不部署服务器，也不声称 Linux 生产服务器已经具备相同运行时。

## 2. 成熟源码与许可证审计

采用的成熟源码/二进制来源：

- Real-ESRGAN 主项目：<https://github.com/xinntao/Real-ESRGAN>
- 官方 v0.2.5.0 Windows 便携包：<https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-windows.zip>
- Real-ESRGAN-ncnn-vulkan：<https://github.com/xinntao/Real-ESRGAN-ncnn-vulkan>
- Tencent ncnn：<https://github.com/Tencent/ncnn>

许可证与声明：

- Real-ESRGAN 主项目为 BSD-3-Clause：<https://github.com/xinntao/Real-ESRGAN/blob/master/LICENSE>
- Real-ESRGAN-ncnn-vulkan 为 MIT：<https://github.com/xinntao/Real-ESRGAN-ncnn-vulkan/blob/master/LICENSE>
- ncnn 主体为 BSD-3-Clause，其许可证文件还列出 zlib、BSD-2-Clause、BSD-3-Clause 等第三方 notices：<https://github.com/Tencent/ncnn/blob/master/LICENSE.txt>
- 官方 Windows 压缩包自身没有随包附带上述许可证/第三方声明文本，因此不能直接原样作为生产分发包。正式制品必须补齐三组许可证和 ncnn 子依赖 notices。

供应链固定值：

- 官方压缩包 SHA-256：`ABC02804E17982A3BE33675E4D471E91EA374E65B70167ABC09E31ACB412802D`
- `realesrgan-ncnn-vulkan.exe`：`07E49F7CBB4EDE01AE4DD4C399D3A7E5846E3D2085C3128EFF881E55CB7B1A0C`
- `vcomp140.dll`：`8F72EF2E483465444B2059FC6744D6CB22CD8D8A27F6FA56BEFD2A42DCD0F78B`
- `realesrgan-x4plus.bin`：`713EE713B0353AFAA27976F0563A64A5043BD70B9BD8936C2E26E25EBCDBCDDF`
- `realesrgan-x4plus.param`：`35330ECECCEA33B6C397A72548E788D5D53BECEE4734C50B7FADA36E89F10A86`

风险与修正：

- 官方 EXE 的 Authenticode 状态为 `NotSigned`。本地阶段以官方 release URL、压缩包哈希和文件哈希共同约束；正式发布仍需显式接受该风险或改用可复现构建。
- 官方压缩包含 `vcomp140d.dll`，但 EXE 实际不依赖 Debug 运行库。微软规定 Debug DLL 仅用于测试机、不可再分发：<https://learn.microsoft.com/en-us/cpp/windows/determining-which-dlls-to-redistribute?view=msvc-170>。
- 产品审计清单和测试制品已移除 `vcomp140d.dll`；生产 Windows 运行时应通过微软签名的 VC Redistributable 提供零售版 `vcomp140.dll`，不得把 Debug DLL 打入制品。
- 本地研究目录仍是官方压缩包的原样解压目录，不属于仓库或拟发布制品；生产打包时必须显式排除 Debug DLL。

## 3. 配置与执行边界

可选环境变量：

- `IMAGE_TOOL_REALESRGAN_PATH`
- `IMAGE_TOOL_REALESRGAN_VERSION`
- `IMAGE_TOOL_REALESRGAN_MODEL`
- `IMAGE_TOOL_REALESRGAN_PACKAGE_ROOT`
- `IMAGE_TOOL_REALESRGAN_MODEL_DIR`
- `IMAGE_TOOL_REALESRGAN_MAX_CONCURRENCY`
- `IMAGE_TOOL_REALESRGAN_MAX_TENANT_CONCURRENCY`

能力启用条件：

1. 命令、包根目录和模型目录都必须是绝对路径且真实存在。
2. 命令真实路径必须直接位于审计包根目录；模型目录真实路径必须等于包内 `models`。
3. 引擎版本必须为 `0.2.5.0`。
4. EXE、零售运行库和模型文件 SHA-256 必须与审计清单完全一致。
5. `-h` 输出必须匹配 Real-ESRGAN NCNN 的真实使用说明。
6. 任一条件失败时 `upscale.available=false`，前端“高清”不可执行。

执行限制：

- 固定参数：`-i`、`-o`、`-n realesrgan-x4plus`、`-s 2|3|4`、`-m <audited-model-dir>`、`-f png`。
- `execFile` 无 shell；客户端不能注入额外命令或路径。
- 输入仅支持 PNG、JPEG、WebP。
- 输入及预计输出上限 4000 万像素，输出文件上限 64 MiB。
- 处理超时 300 秒，标准输出缓冲上限 2 MiB。
- 产物必须由 Sharp 完整解码，格式为 PNG，宽高必须等于输入尺寸乘倍率。
- 默认全局并发和单租户并发均为 1，令牌覆盖输入解码、目录准备、模型执行、产物校验和落库。

当前并发器只在单个 Node.js 进程内生效。生产多进程或多副本必须增加共享 GPU semaphore，或明确以单实例方式部署。

## 4. 项目路径隔离修正

独立标准审计复现了两类跨项目物理文件攻击：

1. 攻击租户为自己的 asset 行填写另一个项目在全局 storageRoot 内的 `local_path`。
2. Windows 下把攻击者项目根目录做成指向受害项目目录的 junction。

修正后，公开模式在创建任何任务前执行：

- 通过 `storageLayout.getProjectStorageSubdir` 计算 asset 所属 drama 的可信项目根。
- storageRoot、项目根和源文件全部使用真实路径。
- 项目根真实路径必须与计算出的项目根路径完全一致，拒绝项目根 junction 重定向。
- 源文件真实路径必须同时位于 storageRoot 和当前项目根内。
- 创建派生目录后再次校验项目根身份，并确认派生目录真实路径位于当前项目根内。

回归结果：

- 普通跨项目 `local_path` 别名：HTTP 400，0 个任务，0 个派生文件。
- 项目根 junction 指向受害项目：HTTP 400，0 个任务，受害项目无 `derived`。
- 合法当前项目路径：HTTP 201，派生文件只写入当前项目。
- 本地非公开模式仍按 canonical storageRoot 工作，原有图片工具链不受此限制。

系统共享或 `library/...` 素材仍引用库内物理路径时，公开模式图片工具会安全地拒绝处理。该行为不影响素材展示和复用本身，但在实现“复用时复制到目标项目目录”前，不得声称所有来源图片都支持工具栏。不能通过放宽路径门禁解决该兼容性问题。

文件系统真实路径检查不能单独消除全部 TOCTOU 竞态。生产服务账号需通过 ACL 独占项目存储目录，禁止其他进程创建或替换 junction/symlink。

## 5. 自动化验证

测试先复现并锁定：

- 无模型时能力不可用。
- 错误版本、缺失零售运行库、损坏模型、迁出包根的相同 EXE 均被拒绝。
- 2x/3x/4x 参数白名单、尺寸上限、文件上限、超时和错误清洗。
- 成功生成真实倍率 PNG、派生素材、任务结果和审计元数据。
- 跨项目物理路径别名攻击。
- Windows junction 项目根重定向攻击。
- 合法项目路径兼容。
- 审计清单不得出现 `vcomp140d.dll`。

最终结果：

- 图片工具后端目标测试：21/21 通过。
- 后端全量测试：452/452 通过。
- 图片节点前端目标测试：16/16 通过。
- 前端全量测试：327/327 通过。
- 前端生产构建：成功；仓库既有大分块体积提示仍存在，本批次未扩大范围处理。
- 后端官方 npm registry 审计：0 个漏洞。
- 前端官方 npm registry 审计：0 个漏洞。
- `git diff --check`：通过，仅有 Git 的 LF/CRLF 工作区提示。
- 生产代码中的核验、侵权、版权检测功能扫描：无匹配。

## 6. 真实浏览器与产物证据

本地隔离环境：

- 工作树：`C:\Users\canqu\Documents\茉莉妈妈2\wt-image-node-toolbar`
- 数据与素材：`C:\Users\canqu\AppData\Local\Temp\molimama-image-tools-e2e-20260728`
- 后端端口：`5699`
- Real-ESRGAN 研究包：`C:\Users\canqu\AppData\Local\Temp\molimama-real-esrgan-ncnn-v0250-20260728\package`

最终安全修正后的真实浏览器链：

1. 打开独立画布项目“图片节点智能抠图隔离验收”，选中图片节点。
2. “高清”由后端能力探针启用；“720全景”和“灯光”仍保持禁用。
3. 对话框显示 2x 默认倍率和“已审计的本地 Real-ESRGAN”说明。
4. 点击“应用并生成新素材”，浏览器提示处理完成。
5. 处理历史首项显示“高清增强 / 已完成”。
6. 刷新浏览器后，高清增强成功历史、节点素材 ID 和任务 ID 保持不变。
7. 浏览器控制台无 error 或 warning。
8. 验收后关闭本地标签页和服务，端口 `3033`、`5699` 均未继续监听。

最终任务与产物：

- 任务 ID：`acab7eb2-add9-4920-b15b-dadf2af25f25`
- 任务类型：`image_tool_upscale`
- 状态：`completed`
- 进度：`100`
- 错误：`null`
- 源素材 ID：`9`
- 派生素材 ID：`16`
- 输出：PNG，`1280x840`，4 通道
- 文件大小：`409934` 字节
- SHA-256：`21EE5BCCCB6A189A5DB8118910B627F8EF72DD9FC4750123A7DABC24F684DBA1`
- 引擎：`realesrgan-ncnn-vulkan`
- 引擎版本：`0.2.5.0`
- 模型：`realesrgan-x4plus`
- 倍率：`2`
- 刷新后节点：`savedAssetId=16`、`imageToolStatus=success`，历史首项任务 ID 与后端一致。

在增加“EXE 必须位于审计包根”约束后，还执行了独立真实引擎小图复验：`32x24 -> 64x48`，任务 `66a13841-c7b0-4e7c-bc94-c4880a483453`，产物 SHA-256 为 `D15C72644F26F368B610CEC9B330C19EE3903D5CAE26627B6D3E8279B9508570`。

## 7. 未完成范围与发布门槛

以下非核验功能仍不可用，不纳入本报告的完成结论：

- 标记修图
- 画质/细节增强
- 生成导演台
- 姿势
- 角度
- 扩图
- 画面联想
- 灯光三维调节

生产发布仍需：

- 为生产服务器选择并审计匹配操作系统的正式 Real-ESRGAN 运行时；当前固定哈希只覆盖 Windows v0.2.5.0。
- 生成不含 Debug DLL 的正式制品，补齐 Real-ESRGAN、Real-ESRGAN-ncnn-vulkan、ncnn 与全部子依赖许可证/notices。
- Windows 部署通过微软签名的 VC Redistributable 提供零售运行库。
- 多实例增加共享 GPU 并发锁，或明确单实例部署。
- 通过服务账号 ACL 保护项目存储目录。
- 为 system_shared/library 素材实现 copy-on-reuse 后再宣称全部图片来源兼容工具栏。
- 全部非核验功能完成后统一执行本地审计、候选发布环境复验、PR 审查和部署。

当前 `productComplete=false`。P4 本地阶段完成，PR 与服务器同步继续保持阻断。

核验、侵权检测和版权判断保持排除，待其他功能全部完成后再另行设计和评审。
