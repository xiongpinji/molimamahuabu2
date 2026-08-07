# js-yaml 安全门禁修复

## 背景

PR #137 的 `Production dependency gate` 在执行
`npm --prefix backend-node audit --omit=dev --audit-level=high` 时失败。
当前 `backend-node/package-lock.json` 锁定 `js-yaml@4.3.0`，命中
GHSA-5p4m-2wfm-xmqj / CVE-2026-59870 高危拒绝服务告警；上游已提供
`4.3.1` 修复版本。

## 范围

- 仅更新 `backend-node/package-lock.json` 中 `js-yaml` 的锁定版本至 `4.3.1`。
- 保持 `backend-node/package.json` 的现有兼容范围 `^4.3.0` 不变。
- 本文档记录复现、验证和交付证据。
- 不修改业务代码、支付代码、生产发布门禁或部署配置。

## 验收标准

1. 基线可复现：修复前生产依赖审计因该高危告警非零退出。
2. `npm ci` 后 `npm ls js-yaml --omit=dev` 解析为 `js-yaml@4.3.1`。
3. `npm audit --omit=dev --audit-level=high` 零退出。
4. 后端全量测试零失败。
5. `git diff --check` 通过，依赖变更仅限锁文件。
6. 通过独立安全 PR 交付；未经用户再次确认，不合并、不部署、不触发真实支付。

## 验证记录

### 修复前

- `npm ci --no-fund --no-audit --registry=https://registry.npmjs.org`：通过，安装 173 个包。
- `npm ls js-yaml --omit=dev`：解析为 `js-yaml@4.3.0`。
- `npm audit --omit=dev --audit-level=high --registry=https://registry.npmjs.org`：退出码 1，报告 1 个高危漏洞，命中 GHSA-5p4m-2wfm-xmqj / CVE-2026-59870。

### 修复后

- 锁文件差异仅将 `js-yaml` 的 `version`、`resolved`、`integrity` 从 `4.3.0` 更新为 `4.3.1`。
- `npm ci --no-fund --no-audit --registry=https://registry.npmjs.org`：通过，安装 173 个包。
- `npm ls js-yaml --omit=dev`：解析为 `js-yaml@4.3.1`。
- `npm audit --omit=dev --audit-level=high --registry=https://registry.npmjs.org`：退出码 0，`found 0 vulnerabilities`。
- `npm test`：673 个测试全部通过，0 失败、0 跳过，退出码 0。
