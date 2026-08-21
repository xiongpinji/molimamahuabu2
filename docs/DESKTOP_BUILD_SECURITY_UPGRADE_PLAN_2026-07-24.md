# 桌面构建链安全升级计划（2026-07-24）

## 目标

清除 `desktop` 完整依赖树中的已知漏洞，并把完整桌面依赖审计纳入持续集成，同时保持现有桌面业务功能和打包产物不变。

## 当前基线

- 官方 npm 完整审计：14 个漏洞（1 low、1 moderate、11 high、1 critical）。
- `electron@28` 存在直接高危漏洞。
- 其余构建链漏洞由 `electron-builder@24` 及其传递依赖引入，包括 `tar`、`tmp`、`glob`、`minimatch`、`lodash`、`@xmldom/xmldom` 和 `ajv`。
- 现有 CI 只执行 `desktop audit --omit=dev --audit-level=high`，没有覆盖桌面开发/打包依赖。

## 最小改动决策

先升级两个直接开发依赖；真实原生模块重建暴露兼容问题后，再升级唯一必须联动的原生依赖，并刷新桌面锁文件：

- `electron`：`^28.0.0` → `^43.2.0`
- `electron-builder`：`^24.9.1` → `^26.15.3`
- `better-sqlite3`：`^11.6.0` → `^13.0.1`

同时将桌面 CI 审计改为完整依赖树，并从 low 级别开始失败。后端和前端继续保持生产依赖高危门禁，避免扩大本阶段范围。

## 风险与权衡

Electron 28 到 43 是必要的大版本升级，因为官方审计给出的安全修复版本已超出现有主版本。主要风险是 Electron 主进程 API、原生模块 ABI 和 Windows 打包行为变化。通过以下真实验证降低风险，不在本阶段顺带重构业务代码：

首次重建证明 `better-sqlite3@11.6.0` 使用的旧 V8 接口无法在 Electron 43 下编译。`better-sqlite3@13` 已切换到 N-API，使预编译二进制可跨 Node.js 和 Electron 版本使用，因此将它作为必要兼容升级；其现有数据库调用继续通过后端全量测试验证。

1. 先增加策略测试，证明旧依赖和旧门禁不满足目标。
2. 重新安装依赖并执行 `electron-builder install-app-deps`，验证 `better-sqlite3`、`sharp` 等原生模块。
3. 运行后端、前端和策略测试，以及前端生产构建。
4. 生成 Windows unpacked、NSIS 和 portable 产物。
5. 启动新生成的 unpacked 可执行文件，验证启动日志并只终止本次启动的进程。

首次正式打包还发现 NSIS 与 portable 共用同一个 `artifactName`，后生成的文件会覆盖先生成的文件。为保证两种产物真实共存，为两个 target 设置各自的 `Setup` 和 `Portable` 文件名。

## 验收标准

- `npm --prefix desktop audit --audit-level=low` 返回 0 个漏洞。
- CI 的桌面审计覆盖完整依赖树，后端和前端原门禁不变。
- 桌面依赖全新安装及原生模块重建成功。
- 后端和前端全量 Node 测试通过，前端生产构建通过。
- Windows unpacked、NSIS、portable 产物生成成功。
- 新生成的 unpacked 客户端可启动，并产生新的启动日志。
- 只提交本计划涉及的依赖、锁文件、CI、测试和验证文档。

## 非目标

- 不修改短剧生成、画布、模型、素材库、计费或管理后台业务逻辑。
- 不调整产品品牌、安装目录、应用 ID 或用户数据目录。
- 不引入新的依赖抽象或兼容层，除非真实验证暴露出必须修复的问题。
