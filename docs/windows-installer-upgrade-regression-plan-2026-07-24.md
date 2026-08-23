# Windows 安装与升级回归计划（2026-07-24）

## 目标

在不触碰主工作区未提交改动的前提下，把 Windows 桌面包的安装、覆盖安装、卸载和用户数据保留变成可重复执行的 CI 与发布前双层交付门禁。

## 已确认事实与取舍

- `1451b3b` 将可见品牌更新为“茉莉妈妈短剧制作平台”，同时把 `appId` 从 `com.localminidrama.desktop` 改为 `cn.molimama.shortdrama`。
- electron-builder 的 NSIS 安装身份默认由 `appId` 生成；已投入使用后修改 `appId` 会破坏既有安装的静默升级。
- 因此保留新的产品名、图标、文件名和版权信息，但恢复旧 `appId`。技术安装身份对用户不可见，兼容旧安装优先于内部标识改名。
- 用户数据继续固定在 `%APPDATA%\localminidrama-desktop`，卸载不得删除该目录。
- CI 不依赖可能过期的历史安装包，固定执行当前包安装、重复覆盖和卸载；发布前验证可通过 `-BaselineInstallerPath` 加入指定历史版本。

## 验收标准

1. 契约测试锁定旧 `appId`、新可见品牌以及 `deleteAppDataOnUninstall: false`。
2. Windows CI 构建 NSIS 安装包后执行当前包的真实静默安装、重复覆盖和卸载。
3. 安装后存在品牌主程序和卸载器，主程序文件说明、产品名与品牌一致。
4. 默认以同一安装包再次静默安装；传入旧版基线安装器时，先安装旧版再覆盖为当前品牌版本。两种路径都要求品牌主程序完整、用户数据验证哨兵不丢失。
5. 卸载后主程序和卸载器消失，但 `%APPDATA%\localminidrama-desktop` 下的验证哨兵仍存在。
6. 验证中途失败时仍优先调用卸载器；脚本只清理自己创建的临时安装目录和验证哨兵，不删除既有用户数据。
7. 本地契约测试、完整后端测试、前端测试、前端构建、桌面打包与真实安装回归全部通过。

## 修改边界

- `desktop/package.json`
- `desktop/scripts/validate-windows-installer.ps1`
- `.github/workflows/windows-desktop-build.yml`
- `backend-node/test/desktopReleaseWorkflow.test.js`
- 本计划及对应验证记录

不修改业务生成链路、画布、计费、素材库和用户数据库结构。

## 执行状态

- 契约测试、PowerShell 语法检查、同包覆盖安装、旧版到新版覆盖升级、卸载后数据保留和失败路径清理均已通过。
- 后端 391 项、前端 288 项测试通过，前端生产构建和 Windows 桌面打包通过。
- 详细证据见 `windows-installer-upgrade-regression-validation-2026-07-24.md`。
