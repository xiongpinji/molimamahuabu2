# Windows 正式发行闭环验证（2026-07-24）

## 结论

Windows 品牌资源、PR 未签名构建门禁和正式签名发布门禁已经实现并通过本机回归。代码仓库现在可以持续生成可验证的 Windows 包；对外正式发布仍必须先配置真实代码签名证书机密。

## 自动化验证

| 验证项 | 结果 |
|---|---|
| `node --test backend-node/test/*.test.js` | 390 / 390 通过 |
| `node --test frontweb/test/*.test.js` | 288 / 288 通过 |
| `node --test backend-node/test/desktopReleaseWorkflow.test.js` | 4 / 4 通过 |
| `npm run build`（frontweb） | 通过，1772 个模块 |
| 两个 GitHub Actions YAML 解析 | 通过 |
| backend 生产依赖审计（npm 官方端点） | 0 漏洞 |
| frontweb 生产依赖审计（npm 官方端点） | 0 漏洞 |
| desktop 完整依赖审计（npm 官方端点） | 0 漏洞 |

说明：本机默认镜像 `npmmirror` 不实现 npm audit 接口，首次请求返回 404；随后显式使用 `https://registry.npmjs.org` 重新审计并全部通过。

## 品牌资源验证

- 品牌源 PNG 与 `desktop/build/icon.png` 的 SHA-256 均为：
  `AFA81252ED79966B2D439C472987D1153D0082E4DE7DB279F54FB0C8886CC7BB`
- `icon.ico` 包含 16、24、32、48、64、128、256 共 7 个尺寸。
- 从打包后 EXE 提取的关联图标已人工检查，确认为母女品牌图像。

## 真实 Windows 打包

执行：

```powershell
$env:CSC_IDENTITY_AUTO_DISCOVERY='false'
npm run dist -- --publish never
```

生成：

| 产物 | 字节 | SHA-256 | 本机签名状态 |
|---|---:|---|---|
| `茉莉妈妈短剧制作平台 1.2.8 Setup.exe` | 229132205 | `a56e51a37c96ac5676d24afce3b2ccb19309133a60f4118c805fd630e50a415a` | `NotSigned` |
| `茉莉妈妈短剧制作平台 1.2.8 Portable.exe` | 228636327 | `8554a6d7ba914240b78adba788c5876beca602c2442df61f3375530285829c16` | `NotSigned` |

未压缩 EXE 资源：

| 字段 | 值 |
|---|---|
| ProductName | 茉莉妈妈短剧制作平台 |
| FileDescription | 茉莉妈妈短剧制作平台 |
| CompanyName | 茉莉妈妈 |
| LegalCopyright | Copyright © 2026 茉莉妈妈 |
| InternalName | 茉莉妈妈短剧制作平台 |
| FileVersion | 1.2.8 |

本机没有代码签名证书，因此 `NotSigned` 是预期结果，不可作为正式发布包。使用正确的
`--config.win.forceCodeSigning=true` 参数再次构建时，electron-builder 明确以
`App is not signed and "forceCodeSigning" is set to true` 失败，证明正式发布门禁有效。

## 启动验证

启动 `desktop/release/win-unpacked/茉莉妈妈短剧制作平台.exe` 后，启动日志确认：

- `main.js loaded packaged=true`
- `startBackend ok port=5679`
- `createWindow loadURL http://127.0.0.1:5679`
- `window ready-to-show`

验证完成后已终止本次测试进程，无残留该工作树的 Electron 进程。

## 远端工作流边界

- `windows-desktop-build.yml`：PR、main 和手动触发；明确关闭签名自动发现，上传未签名验证包和 `SHA256SUMS.txt`，不具备发布权限。
- `release.yml`：仅 `vX.X.X` 标签触发；标签必须与桌面包版本完全一致；缺少 `WIN_CSC_LINK` 或 `WIN_CSC_KEY_PASSWORD` 时立即失败；构建时强制签名，逐个校验 Authenticode，生成 SHA-256 校验文件，创建 GitHub 产物证明和草稿 Release。

## 剩余外部条件

代码侧闭环已完成。正式对外发布前仍需由项目所有者购买或提供可信 Windows 代码签名证书，并在 GitHub 仓库配置：

- `WIN_CSC_LINK`
- `WIN_CSC_KEY_PASSWORD`

配置后应创建测试标签，等待远端签名构建，再下载产物复核签名主体和证书链。
