# 图片节点工具栏总工程执行门禁

日期：2026-07-29

## 范围

- 完成本轮所有非核验、非对口型图片节点工具。
- 核验、侵权检测、版权判断和对口型继续搁置。
- 目标环境为无 GPU 的线上轻量服务器。
- PR 已创建并完成四项 CI 审核；本报告不代表已部署线上。

## 已实现能力

| 能力组 | 操作 | 处理链 |
| --- | --- | --- |
| 确定性编辑 | 裁剪、压缩、镜像、旋转、宫格裁剪、图片调整、LUT | Sharp 派生资产 |
| CPU 抠图 | 智能抠图、框选抠图 | rembg 2.0.77 + u2netp，CPU 单并发 |
| 远程增强 | 高清增强、细节纹理增强 | AIHubCC `gpt-image-2-3.5k` 参考图链 |
| 远程编辑 | 扩图、标记修图、电影级光影校正 | AIHubCC `gpt-image-2-3.5k` 参考图链 |
| 生成与推演 | 720 全景、全景场景、画面/角度联想、角色三视图、叙事九宫格、前后画面推演 | AIHubCC `gpt-image-2-3.5k` 参考图链 |
| 导演预演 | 生成导演台、灯光、姿势、角度 | 真实 3D 导演台状态与资产链 |
| 通用动作 | 替换、下载、全屏、历史、标记色、失败重试 | 画布状态与资产持久化链 |

所有图片处理结果生成新资产，不覆盖源资产；任务、操作参数、引擎、
版本和来源资产写入后端记录。失败保留旧图并写回可重试状态。

## 当前提交验证

| 门禁 | 结果 |
| --- | --- |
| 前端完整测试 | 426 / 426 通过 |
| 后端完整测试 | 536 / 536 通过 |
| 前端生产构建 | 通过 |
| 合并后生产依赖审计 | 本地缓存库前后端均为 0 个漏洞；PR `Production dependency gate` 通过 |
| CPU 抠图 Python 依赖审计 | 0 个已知漏洞 |
| 生产依赖许可证门禁 | 304 个包通过，缺失元数据必须有固定版本与来源覆盖 |
| 图片节点发布边界门禁 | 283 个生产文件通过密钥、禁区与对口型隔离扫描 |
| 图片工具、AIHubCC 与下载安全目标测试 | 47 / 47 通过 |
| rembg CPU 本地产物 | PNG、4 通道、透明通道有效 |
| 生产镜像本地门禁 | 构建、健康、网页、版本、模型哈希、断网 CPU 抠图、透明通道均通过 |
| 真实浏览器 + 临时后端回归 | 6 / 6 通过 |
| 图片工具栏本地专用同链回归 | 1 / 1 通过 |
| AIHubCC 真实付费同链门禁 | 13 / 13 个远程操作通过 |
| 本地画布浏览器门禁 | CI 单 worker：30 通过、1 个付费门禁按预期跳过、0 失败 |
| 禁区扫描 | 生产源码无核验、侵权或版权检测入口 |
| 密钥扫描 | 未发现疑似硬编码密钥或私钥 |
| `git diff --check` | 通过 |
| PR 审核 | [#57](https://github.com/xiongpinji/molimamahuabu2/pull/57) 可合并 |
| PR CI | 后端回归、画布浏览器回归、生产镜像、生产依赖四项均通过 |

浏览器回归覆盖图片节点真实生成、入库、刷新恢复、节点配置和连线持久化，
以及导演台状态、CC0 资产、MP4 工件下载。新增的图片工具栏专用同链回归
直接执行裁剪和镜像，核对任务、派生资产、源资产不变、画布持久化、刷新恢复、
损坏输入失败写回、错误脱敏、保留旧图和恢复输入后的重试成功。各图片工具的
产物约束和租户边界继续由后端目标测试覆盖。

许可证和发布边界不再只依赖人工报告：

- `npm --prefix backend-node run audit:licenses` 扫描前后端锁文件中的生产依赖；
  未知许可证、非商用许可证、AGPL/GPL/SSPL/BUSL 或过期覆盖记录会直接失败。
- 锁文件缺少许可证字段的 `busboy@1.6.0`、`streamsearch@1.1.0` 和
  `@types/three@0.163.10003` 以固定版本和上游许可证地址显式覆盖。
- `npm --prefix backend-node run audit:image-node-release` 扫描生产源码和部署文件
  中的高置信硬编码密钥、图片节点核验禁区，并确认对口型只保留显式不可用声明。
- 两项命令均已进入 `.github/workflows/dependency-security.yml`。
- `docs/WEB_PRODUCTION_DEPLOYMENT.md` 已补齐单机隔离预热：灰度实例使用独立
  Compose 项目、网络和数据卷，不接公网且不得共享生产 SQLite；提升后再用
  隔离账号完成小额同链冒烟，应用回滚默认不覆盖数据库。

## 无 GPU 部署约束

- 生产镜像内置 rembg 2.0.77 CPU 运行时和固定哈希 u2netp。
- rembg 使用镜像内固定 Python 虚拟环境，`U2NET_HOME` 指向内置模型目录，
  断网执行不会下载依赖或模型。
- `OMP_NUM_THREADS=1`，全局和单租户并发均为 1。
- 不要求 GPU，且不包含 CUDA、ROCm 或 `onnxruntime-gpu`。FFmpeg 的 Debian
  传递依赖含通用 Mesa/Vulkan 装载库，不代表启用或依赖专用 GPU 运行时。
- AIHubCC `gpt-image-2-3.5k` 能力走远程服务，不占用服务器 GPU。
- 对口型没有进入镜像、运行路由或发布门禁。

本地生产镜像 `molimama-image-node-toolbar:local` 已构建为不可变摘要
`sha256:ac99bddae4ed05d74e9a28fa4b389d9444e744e792e9d80edfcc4937092d436b`。
隔离容器健康、网页入口、rembg 版本和模型哈希均
通过；断开容器网络后生成 32×32 四通道透明 PNG。容器日志未
发现测试密钥值、Python 堆栈或模型下载错误，测试容器已删除。

## AIHubCC 真实同链证据

真实供应商门禁已固化为：

```powershell
$env:RUN_REAL_AIHUBCC_IMAGE_NODE_CHAIN='1'
$env:AIHUBCC_BASE_URL='https://aihubcc.cc/v1'
$env:AIHUBCC_IMAGE_MODEL='gpt-image-2-3.5k'
$env:AIHUBCC_API_KEY='<仅注入当前进程，不写入仓库>'
npm --prefix frontweb run test:e2e:image-node-real
```

门禁会自动申请隔离浏览器端口并禁止复用已有本地服务；只有显式付费确认、
严格固定的 `https://aihubcc.cc/v1`、已审计的 `gpt-image-2-3.5k` 和非空密钥
同时存在才运行。缺少确认时退出码为 2，验证输出不包含密钥；失败诊断会再次
替换当前密钥和 Bearer 值。真实门禁临时数据库与产物可通过
`IMAGE_NODE_E2E_TEMP_ROOT` 放在隔离磁盘，且关闭 Playwright trace，避免高分辨率
产物挤占系统盘。

2026-07-29 当前真实门禁结果为 13 / 13 个远程操作通过：

- 高清增强、细节纹理增强、扩图、标记修图、电影级光影校正。
- 720 全景、全景场景、画面联想、角度联想、角色三视图、叙事九宫格。
- 前一画面推演、后一画面推演。

每项均从真实浏览器触发，后端使用 `gpt-image-2-3.5k` 提交 AIHubCC 异步任务，
下载供应商图片并生成经 MIME、格式、尺寸、文件存在性校验的派生资产，写回任务、
画布节点和历史记录，刷新后结果仍存在。失败路径另由本地同链门禁验证：损坏输入
会写回失败状态、保留旧图，修复输入后可重试成功。

本轮同时修复两项真实运行缺陷：

- 图片工具路由不再缓存服务启动时的供应商配置；运行时保存 AIHubCC 配置后，
  能力查询和新任务会立即读取当前配置。
- 供应商产物下载器兼容 Node 新版 DNS `lookup({ all: true })` 契约，同时保留
  HTTPS、DNS 私网拒绝、重定向复查、内容类型和 64 MiB 流式上限。
- 合并主线后补齐 Linux 与 Windows 的绝对路径语义差异：存储根内绝对参考图
  可安全编码为 data URL，应用 `/static/` 路径保持正确解析，存储根外绝对路径
  和软链接越界仍被拒绝。

## 发布状态

本地工程门禁和 PR 四项 CI 已通过，线上部署尚未执行：

- `real_provider_verified=true`
- `production_image_built=true`
- `production_image_local_smoke_verified=true`
- `local_product_complete=true`（本轮约定范围内；核验与对口型不在范围）
- `real_browser_verified=true`
- `backend_readback=true`
- `artifact_verified=true`
- `failure_writeback=true`
- `pr_created=true`
- `ci_verified=true`
- `production_deployed=false`

下一步按生产手册执行不可变镜像发布、数据库备份、独立数据卷预热、生产提升、
线上同链冒烟与回滚验证；任一备份或预热门禁失败即停止发布。
