# CPU 智能抠图第三方组件审计

生产镜像只启用 CPU 推理，不包含 CUDA、ROCm 或 GPU 运行库。

| 组件 | 固定版本/产物 | 来源 | 许可证 | 用途 |
| --- | --- | --- | --- | --- |
| rembg | 2.0.77 | https://github.com/danielgatis/rembg | MIT | 调用 ONNX Runtime 完成背景移除 |
| U2-Net `u2netp` | SHA-256 `309C8469258DDA742793DCE0EBEA8E6DD393174F89934733ECC8B14C76F4DDD8` | https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx | Apache-2.0（上游 U2-Net） | 轻量显著目标分割模型 |

Python 依赖由 `requirements.in` 解析为带完整哈希的
`requirements.lock`，镜像构建使用 `pip --require-hashes`。模型在构建时
下载并校验固定 SHA-256；运行时不下载或替换模型。

运行边界：

- `OMP_NUM_THREADS=1`
- 全局并发 `1`
- 单租户并发 `1`
- Node 服务继续执行输入尺寸、输出格式、透明通道、文件大小、超时和路径边界校验
