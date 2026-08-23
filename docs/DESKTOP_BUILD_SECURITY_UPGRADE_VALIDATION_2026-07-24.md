# 桌面构建链安全升级验证记录（2026-07-24）

## 结论

本阶段通过。桌面完整依赖树的官方 npm 审计从 14 个漏洞降为 0，Electron 43 原生依赖重建、后端与前端全量测试、Windows unpacked/NSIS/portable 打包及 unpacked 客户端启动均已验证成功。

本结论只覆盖桌面构建链安全升级，不代表整个平台已满足公开收费发布的全部条件。

## 变更范围

- `electron`：`28.3.3` → `43.2.0`
- `electron-builder`：`24.13.3` → `26.15.3`
- `better-sqlite3`：`11.6.0` → `13.0.1`
- 桌面 CI 从仅审计生产依赖改为审计完整依赖树，并在 low 及以上漏洞时失败。
- NSIS 与 portable 使用不同产物名称，避免互相覆盖。

## 测试驱动证据

1. 新增策略断言后，旧配置按预期失败：
   - 桌面 CI 仍带 `--omit=dev`。
   - Electron 仍为 28。
   - `better-sqlite3` 仍为 11。
   - portable 没有独立产物名称。
2. 最小实现完成后，策略测试 5/5 通过。
3. 首次 Electron 43 原生重建真实失败，错误来自 `better-sqlite3@11.6.0` 使用不兼容的新旧 V8 接口；升级至 N-API 版本后重建成功。
4. 首次正式打包真实发现 NSIS 与 portable 同名覆盖；区分目标名称后重新打包成功。

## 最终验证

| 验证项 | 结果 |
| --- | --- |
| `npm --prefix desktop audit --audit-level=low` | 0 vulnerabilities |
| 桌面全新安装与 postinstall | 通过 |
| `electron-builder install-app-deps` | `better-sqlite3` x64 重建通过 |
| Electron 实际版本 | 43.2.0 |
| electron-builder 实际版本 | 26.15.3 |
| better-sqlite3 实际版本 | 13.0.1 |
| 后端 Node 测试 | 386/386 通过 |
| 前端 Node 测试 | 288/288 通过 |
| 前端 Vite 生产构建 | 通过，1772 modules transformed |
| Windows unpacked 打包 | 通过 |
| Windows NSIS 打包 | 通过 |
| Windows portable 打包 | 通过 |
| unpacked 客户端启动 | 通过 |

## Windows 产物

- `LocalMiniDrama 1.2.8 Setup.exe`
  - 大小：228,600,010 bytes
  - SHA-256：`ABF9F0FE88D32C7ECF7BD5EF5A1BC16FBEE1814AF96CF7152CE3884CA1E707E9`
- `LocalMiniDrama 1.2.8 Portable.exe`
  - 大小：228,370,219 bytes
  - SHA-256：`DE7E020F36A92EF34E99E440F43C08BFE1F2A4AC42992D50748A9A945409D109`

生成物位于本地忽略目录 `desktop/release/`，不提交到 Git。

## 启动证据

从新生成的 `desktop/release/win-unpacked/本地短剧助手.exe` 启动，日志新增：

```text
main.js loaded packaged=true
app.whenReady
startBackend ok port=5679
createWindow loadURL http://127.0.0.1:5679
window ready-to-show
```

验收后只终止了本次临时工作树可执行文件对应的进程。

## 已知但未扩大处理的问题

- Vite 仍提示部分 chunk 大于 500 kB；这是既存前端性能问题，不属于本阶段依赖安全范围。
- `.npmrc` 中的 `better_sqlite3_binary_host_mirror` 被当前 npm 标记为未来版本将不再支持；本次安装和重建不依赖该镜像配置。
- Windows 当前使用默认 Electron 图标，且未形成公开收费发行所需的正式代码签名证据。下一阶段应单独完成品牌化安装包、签名策略和 PR 级 Windows 打包门禁，之后才能据此扩大公开发布结论。
