# Windows 正式签名发布交付验证

日期：2026-07-24

## 交付结果

- 标签与桌面包版本继续强制一致。
- 缺少 Windows 签名密钥时继续在构建前失败。
- 新增 `desktop/scripts/verify-signed-release.ps1`：
  - 严格只接受当前产品名和版本对应的安装包、便携版，拒绝额外 EXE。
  - 二进制 `FileVersion` 必须与 `desktop/package.json` 版本一致。
  - 强制 Authenticode 状态为 `Valid`。
  - 强制存在签名证书与可信时间戳证书。
  - 生成并复核 `SHA256SUMS.txt`。
  - 生成不包含密钥的 `release-verification.json`。
- 正式标签工作流在发布前执行签名版安装、覆盖安装、卸载和用户数据保留回归。
- 正式标签工作流只创建草稿 GitHub Release。

## 验证记录

| 检查 | 结果 |
| --- | --- |
| PowerShell 语法解析 | 通过 |
| 发布契约测试 | 6/6 通过 |
| 后端全量测试 | 392/392 通过 |
| 前端全量单元测试 | 288/288 通过 |
| 前端生产构建 | 通过 |
| Windows 未签名验证包构建 | 通过 |
| 未签名真实产物门禁 | 按预期拒绝，状态 `NotSigned` |
| 缺失发布目录失败验证 | 按预期非零退出 |
| `git diff --check` | 通过 |

后端全量测试首次运行时，隔离工作树尚未安装 `backend-node` 依赖，出现 `express`、`jsonwebtoken` 和 `better-sqlite3` 缺失。执行 `npm ci` 后使用相同命令重跑，392 项全部通过，因此该次失败归类为验证环境缺依赖，不是代码回归。

## 官方依据

- electron-builder 要求通过 CI 密钥注入 `WIN_CSC_LINK` 和 `WIN_CSC_KEY_PASSWORD`，并建议启用 `forceCodeSigning`，防止缺少签名身份时静默产出未签名包。
- electron-builder Windows 签名默认提供 RFC 3161 时间戳服务；本项目进一步把时间戳证书存在性设为发布硬门禁。
- GitHub 二进制产物证明需要 `id-token: write`、`contents: read` 或更高权限、`attestations: write`，并使用 `actions/attest@v4`。

## 当前外部阻塞

截至本次验证，GitHub 仓库没有配置 `WIN_CSC_LINK` 和 `WIN_CSC_KEY_PASSWORD`，也没有既有 GitHub Release。因此：

- 代码和发布门禁可交付。
- 不能把未签名包描述为正式包。
- 不能执行首个真实签名标签发布。

管理员配置两个仓库密钥后，推送与 `desktop/package.json` 版本一致的新标签即可触发真实签名构建；工作流通过后只生成草稿 Release，仍需管理员复核签名报告、校验和与安装回归结果后公开发布。
