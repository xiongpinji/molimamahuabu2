# AGENTS.md

## Cursor Cloud specific instructions

### Project Overview

LocalMiniDrama (本地短剧助手) — an AI-powered local short drama creation tool. Single product, three sub-projects sharing one repo (no monorepo tooling).

### Services

| Service | Directory | Port | Start Command |
|---------|-----------|------|---------------|
| Backend (Express + SQLite) | `backend-node/` | 5679 | `npm run dev` |
| Frontend (Vite + Vue 3) | `frontweb/` | 3013 | `npm run dev` |

Frontend proxies `/api` and `/static` to backend via Vite config.

### Running Tests

```bash
# Backend tests (Node.js built-in test runner)
cd backend-node && node --test test/*.test.js

# Frontend tests (ESM, Node.js built-in test runner)
cd frontweb && node --test test/*.test.js
```

No ESLint or other lint tool is configured in this codebase.

### Building

```bash
cd frontweb && npm run build
```

### Key Development Notes

- Pure JavaScript (no TypeScript) throughout.
- Backend uses `node --watch` for hot reloading in dev mode (`npm run dev`).
- Database is SQLite (embedded via `better-sqlite3`), auto-created in `backend-node/data/`.
- Migrations run automatically on backend startup (`ensureColumns()`); explicit `npm run migrate` only needed for first-time setup or after adding new migration SQL files.
- Config file at `backend-node/configs/config.yaml` already exists in the repo — no need to copy from example.
- AI content generation requires external API keys (configured via the app's "AI 配置" page), but the app fully functions without them for development/testing purposes.
- The backend also serves the built frontend from `frontweb/dist/` at port 5679 when the dist folder exists; during development, use the Vite dev server at port 3013 instead.

### Protected production release contract

- 画布积分卡片受保护合同 `canvas-credit-callout-v1` 不得删除、弱化或改回旧的 `billing-note` 灰字样式。
- 制作 `/opt/moli-drama` 候选版本时必须从实时 `current` 克隆，只覆盖本任务审计过的文件，并执行 `npm --prefix backend-node run audit:canvas-credit-contract -- --require-build`。
- 共享门禁不存在时，只允许在明确审查候选后执行一次 `sudo env PROTECTED_RELEASE_GUARD_BOOTSTRAP=1 bash deploy/install-protected-release-guard.sh CANDIDATE`。安装完成后，任何候选 release 都不得替换共享验证器或激活脚本；门禁升级必须作为独立安全变更人工审查。
- 切换生产版本必须调用共享的 `/opt/moli-drama/shared/release-guard/activate-protected-release.sh CANDIDATE EXPECTED_CURRENT`；禁止直接替换 `/opt/moli-drama/current`。
- 共享门禁拒绝候选时不得绕过、删除或改写门禁；应从最新线上版本重建候选并保留受保护合同。

### External generation model onboarding

- 供应商模型列表和只读连接测试不能作为模型可用性证明。把新模型写入前端供应商预设或生产 `ai_service_configs.model/default_model` 前，必须使用目标 Key 完成一次真实生成，等待成功终态并验证结果文件可读取，同时在任务文档中记录不含密钥的证据。
- 未通过真实生成、生成失败或结果文件不可读的模型不得出现在前端或画布模型目录；通用客户端适配能力可以保留，待重新实测成功后再开放。
