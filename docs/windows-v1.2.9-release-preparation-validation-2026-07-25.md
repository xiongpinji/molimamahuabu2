# Windows v1.2.9 发布准备验证记录

日期：2026-07-25
分支：`codex/v1.2.9-release-prep`

## 验证结论

v1.2.9 的版本一致性、测试、构建、依赖安全和 Windows 安装回归均已通过。当前仅缺真实 Authenticode 证书配置，因此本阶段不创建标签或正式 Release。

## 自动化验证

| 验证项 | 命令 | 结果 |
| --- | --- | --- |
| 发布契约 | `node --test backend-node/test/desktopReleaseWorkflow.test.js` | 7/7 通过 |
| 后端全量测试 | `node --test test/*.test.js` | 393/393 通过 |
| 前端全量测试 | `node --test test/*.test.js` | 288/288 通过 |
| 前端生产构建 | `npm run build` | 通过 |
| 后端生产依赖审计 | `npm audit --omit=dev --audit-level=high` | 0 个漏洞 |
| 前端生产依赖审计 | `npm audit --omit=dev --audit-level=high` | 0 个漏洞 |
| 桌面端依赖审计 | `npm audit --audit-level=low` | 0 个漏洞 |
| Windows 未签名验证构建 | `npm run dist -- --publish never`，并设置 `CSC_IDENTITY_AUTO_DISCOVERY=false` | 通过，生成 Setup 与 Portable 两个验证产物 |
| Windows 安装回归 | `validate-windows-installer.ps1` | 通过 |
| 正式签名门禁反向验证 | `verify-signed-release.ps1` | 按预期拒绝 `NotSigned` 产物 |

## Windows 安装回归结果

- 产品名：`茉莉妈妈短剧制作平台`
- 文件版本：`1.2.9`
- 覆盖安装保留用户数据：通过
- 卸载移除应用：通过
- 卸载保留用户数据：通过

## 未签名验证产物

这些文件只用于本地安装链路验证，不得上传为正式 Release：

| 文件 | 大小（字节） | Authenticode | SHA-256 |
| --- | ---: | --- | --- |
| `茉莉妈妈短剧制作平台 1.2.9 Portable.exe` | 228636321 | `NotSigned` | `99610EB650D6A23A155A76D4DFA49ECD7D52AA71A6B1E646DB2931FC414D3034` |
| `茉莉妈妈短剧制作平台 1.2.9 Setup.exe` | 229132226 | `NotSigned` | `419696F729A5E0D7B360470E77ECF20B857408ED60865CBF935E61EE55B1EFA4` |

## 远程发布条件核验

- GitHub Actions secrets 中不存在 `WIN_CSC_LINK`。
- GitHub Actions secrets 中不存在 `WIN_CSC_KEY_PASSWORD`。
- 仓库当前没有 GitHub Release。
- 远程当前不存在 `v1.2.9` 标签。

结论：发布准备代码可以合并；在证书 secrets 配置完成前，不得推送 `v1.2.9` 标签。

## 非阻塞提示

- 前端构建仍报告既有的 Rollup 大分块提示，但构建成功。
- npm 输出既有镜像配置弃用提示，但安装、审计和构建均成功。
