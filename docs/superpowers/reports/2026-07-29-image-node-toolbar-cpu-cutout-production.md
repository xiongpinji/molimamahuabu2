# 图片节点 CPU 智能抠图生产封装验证

日期：2026-07-29
范围：`smart_cutout`，不含对口型与核验/侵权检测
结论：实现、本地 CPU 实链和本地生产镜像门禁均通过；等待 PR CI 重放。

## 实现

- rembg 固定为 `2.0.77`，只安装 `cpu` extra。
- 使用轻量 `u2netp`，SHA-256：
  `309C8469258DDA742793DCE0EBEA8E6DD393174F89934733ECC8B14C76F4DDD8`。
- Python 全部 30 个传递依赖固定版本并带哈希，镜像使用
  `pip --require-hashes`。
- 模型在镜像构建时下载并校验 SHA-256，运行时不依赖模型下载。
- 包装脚本固定使用 `/opt/rembg` 虚拟环境，`U2NET_HOME` 固定指向镜像内
  `/opt/rembg-models`；构建阶段会实际执行版本检查。
- 运行时设置 `OMP_NUM_THREADS=1`、全局并发 `1`、单租户并发 `1`。
- 不安装 `onnxruntime-gpu`、CUDA 或 ROCm。FFmpeg 会带入通用
  Mesa/Vulkan 装载库，但运行链不要求专用 GPU。

## 本地验证

- `uv pip install --dry-run --require-hashes --python-platform linux`：通过。
- `pip-audit 2.10.0 --disable-pip --no-deps`：无已知漏洞。
- rembg 2.0.77 CPU 真实执行：
  - 输入：64x64 PNG
  - 输出：64x64 PNG，4 通道，`hasAlpha=true`
  - 下载模型 SHA-256 与后端审计常量完全一致。
- 本地生产镜像真实执行：
  - 镜像摘要：
    `sha256:39796ee6100827d682235ce98383a710cbdb8fb7561bcd4ac9d2f5c0d9d0441a`
  - 大小：598,413,011 字节
  - 健康检查与网页入口：通过
  - 断网输出：32x32 PNG，4 通道，`hasAlpha=true`，1,018 字节
  - 测试密钥日志匹配：0；Python 堆栈匹配：0
- 部署合同与图片工具测试：43/43 通过。

## CI 门禁

生产镜像 CI 新增：

1. 容器内 rembg 版本检查。
2. 容器内模型 SHA-256 检查。
3. 断开容器网络。
4. 离线执行一次真实 CPU 抠图。
5. 使用 Sharp 回读并验证 PNG 透明通道。

## 当前完成判定

- `implemented=true`
- `cpu_local_artifact_verified=true`
- `dependency_hash_verified=true`
- `dependency_vulnerability_audited=true`
- `production_image_built=true`
- `production_image_local_smoke_verified=true`
- `productComplete=false`

图片节点总目标仍需真实 Seedream 供应商同链、PR/CI 与部署门禁。
