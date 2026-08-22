# Windows v1.2.9 签名发布与回滚手册

日期：2026-07-25

## 发布前条件

1. `main` 已包含 v1.2.9 发布准备 PR，工作区干净。
2. GitHub 仓库机密已配置：
   - `WIN_CSC_LINK`：受密码保护的代码签名证书文件或其 Base64 内容。
   - `WIN_CSC_KEY_PASSWORD`：证书密码。
3. 证书可用于 Windows Authenticode 代码签名，且未过期。
4. GitHub Actions 的 `Backend Node Tests`、`Dependency Security` 和 `Windows Desktop Build` 最近一次主分支检查通过，正式发布契约已在本地通过。

任何一个条件不满足时，不创建标签。

## 标签前本地检查

从最新 `main` 执行：

```powershell
git fetch origin main --tags
git switch main
git pull --ff-only origin main
node --test backend-node/test/desktopReleaseWorkflow.test.js
node --test backend-node/test/*.test.js
node --test frontweb/test/*.test.js
npm --prefix frontweb run build
git status --short
```

检查结果必须满足：

- 三端包与 lock 文件根版本均为 `1.2.9`。
- 全部测试和构建通过。
- `git status --short` 无输出。
- 远程不存在 `v1.2.9` 标签或同名 Release。

## 创建发布标签

仅在两个签名机密均已确认存在后执行：

```powershell
git tag -a v1.2.9 -m "release: 茉莉妈妈短剧制作平台 v1.2.9"
git push origin v1.2.9
```

标签会触发 `.github/workflows/release.yml`。该工作流必须依次通过：

1. 标签与 `desktop/package.json` 版本一致。
2. 两个签名机密非空。
3. 正式发布契约测试。
4. Windows 安装包与便携版构建。
5. Authenticode 签名、签名证书、时间戳证书和文件版本校验。
6. 安装、覆盖安装、重复覆盖、卸载和用户数据保留回归。
7. SHA-256 校验和与 GitHub 产物证明。
8. 创建草稿 GitHub Release。

## 草稿 Release 复核

管理员公开发布前逐项确认：

- 草稿标签为 `v1.2.9`。
- 只包含当前版本的安装包、便携版、`SHA256SUMS.txt` 和 `release-verification.json`。
- `release-verification.json` 中两个 EXE 的签名状态均为 `Valid`，存在签名者和时间戳信息。
- 本地重新计算的 SHA-256 与 `SHA256SUMS.txt` 一致。
- 安装包可启动，既有用户数据仍可读取。
- Release Notes 与 `CHANGELOG.md` 的 v1.2.9 范围一致。

复核完成后由管理员手动公开 Release。

## 失败与回滚

### 工作流在创建草稿前失败

- 不公开任何产物。
- 保留失败运行日志，修复后发布新补丁版本；不要用未签名本地包替代正式包。
- 如果标签尚未对外使用且确认必须撤销，由管理员删除远程与本地标签；否则保留标签并改发下一补丁版本。

### 草稿复核失败

- 保持草稿状态，不向用户分发。
- 删除草稿中的不合格附件，修复后使用下一补丁版本重新走完整工作流。

### 已公开版本出现问题

- 立即将 Release 标记为预发布或下线下载入口，并停止推广。
- 不覆盖同版本二进制；修复后提升补丁版本。
- 若涉及数据兼容，先备份 `%APPDATA%\localminidrama-desktop`，再执行恢复演练。

## 当前状态

截至 2026-07-25，GitHub 仓库尚未配置 `WIN_CSC_LINK` 和 `WIN_CSC_KEY_PASSWORD`，因此本手册已就绪，但 `v1.2.9` 标签不得创建。
