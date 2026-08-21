# USMercari 图片模型真实验证证据（2026-08-07）

## 结论

原始“两个模型均开放三档”的门禁未通过；产品随后确认缩小开放范围：`gpt-image-2-2-4k` 只开放 1K/2K，`nano-banana-2` 开放 1K/2K/4K。GPT 4K 继续禁止进入用户目录和生产能力快照。

- `nano-banana-2`：1K、2K、4K 文生图和 1K 公网参考图生成均通过。
- `gpt-image-2-2-4k`：1K、2K 文生图和 1K 公网参考图生成通过；4K 文生图连续两次收到供应商 HTTP 400，最终错误为 `PROVIDER_INVALID_REQUEST`。
- 供应商文档只明确声明 Nano Banana / Gemini 系模型支持 `resolution=4K`，未声明 GPT 系支持该字段。
- 参考图使用文档推荐的 `POST /v1/images/generations` + `image_url` 公网 URL 合同通过。上传 media id 后调用 `/v1/images/edits` 的尝试被上游 400 拒绝，因此不作为已验证能力。

按照项目外部模型硬门禁，“7 个成功 + 1 个失败”不能视为原三档整组通过。产品已明确缩小为经过验证的档位集合，因此后续实现只允许 GPT 1K/2K 与 Nano 1K/2K/4K；任何目录、定价或请求若重新出现 GPT 4K 都应由门禁拒绝。

## 环境与安全边界

- Base URL：`https://chat-ai.mercarimx.com`
- 认证：从现有受保护线上配置只读取得，仅注入当前进程环境变量；未写入源码、证据、命令行参数或日志。
- 输出验证：每个成功结果均经匿名下载，要求 HTTP 2xx、`image/*` MIME、非空文件和 Sharp 可解析；随后校验长边所属档位并记录 SHA-256。
- 参考素材：使用公开的合成测试图，不使用用户素材。
- 不确定提交：适配器禁止自动重试；本次失败均为明确 HTTP 400，不属于结果未知。
- 本次未修改生产数据库、生产配置或线上发布目录。

## 成功结果

| 标记 | 实际尺寸 | MIME | 字节数 | SHA-256 | provider credits |
|---|---:|---|---:|---|---:|
| `gpt-image-2-2-4k\|text-to-image\|1k\|verified` | 1024×1024 | image/jpeg | 108369 | `39750e7c1d3748fea44f9c2840f16f574d4985de416239180b914852debfd851` | 8 |
| `gpt-image-2-2-4k\|text-to-image\|2k\|verified` | 2048×2048 | image/jpeg | 370720 | `ae1665bad7c508388f3e72c6433fa8d96dc5f9e38ad345cb5fec7f6d199e8aee` | 30 |
| `gpt-image-2-2-4k\|image-to-image\|1k\|verified` | 1024×1024 | image/jpeg | 69970 | `d7384547fbf7dfd639f94592044521473b1603b011527f577ec74aff4feffb17` | 8 |
| `nano-banana-2\|text-to-image\|1k\|verified` | 1024×1024 | image/jpeg | 339984 | `8cffcf7494fca2c90ab20ae50a4480fc522b8c53c231297eaf718274786343bc` | 80 |
| `nano-banana-2\|text-to-image\|2k\|verified` | 2048×2048 | image/jpeg | 1133879 | `cf9cdcf45aadd49e9dbf058941687ce75239619e06cf43aa55d22bf4f50c9d50` | 80 |
| `nano-banana-2\|text-to-image\|4k\|verified` | 4096×4096 | image/jpeg | 1723788 | `54139f38c9e68e283cfe8832a99f9d9beed2549b13542daddea4859e6d8640df` | 80 |
| `nano-banana-2\|image-to-image\|1k\|verified` | 1024×1024 | image/jpeg | 178405 | `9d7a1628b5f8e7599144bfa4c3aac6d845b97543993864b63768362e65f1f1ff` | 80 |

`provider credits` 是供应商响应原字段，不等同于人民币成本。人民币成本仍按用户确认的 1K ¥0.08、2K ¥0.10、4K ¥0.12；由于开放门禁失败，本次没有写入计价表。

## 失败结果

| 标记 | 次数 | HTTP | 脱敏错误 | 门禁处理 |
|---|---:|---:|---|---|
| `gpt-image-2-2-4k\|text-to-image\|4k\|failed` | 2 | 400 | `generation failed: PROVIDER_FAILURE: PROVIDER_INVALID_REQUEST` | 停止重试；禁止开放 GPT 4K；整组开放门禁失败 |

第二次仅重放该单一失败用例，用于取得第一次被旧错误解析器折叠掉的结构化错误。已成功的 1K、2K 用例没有重复调用。

## 本地协议验证

```text
node --test test/usmercariImageClient.test.js test/usmercariImageVerification.test.js
tests 12; pass 12; fail 0
```

协议测试只证明请求构造、显式路由、错误脱敏、付费提交不自动重试和选择性真实验证工具；它不能替代上面的真实供应商结果。

## 可复验命令（不含 Key）

```powershell
$env:USMERCARI_IMAGE_API_KEY = '<从受保护配置注入>'
$env:USMERCARI_VERIFY_CASES = 'gpt-image-2-2-4k|text-to-image|4k'
npm run verify:usmercari-image
```

脚本拒绝命令行明文 Key。若供应商修复 GPT 4K，只复验该失败标记；通过并完成下载、尺寸和哈希检查后，才能重新开启任务 4 及后续用户入口工作。
