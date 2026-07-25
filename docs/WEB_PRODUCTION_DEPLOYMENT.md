# 网页端生产部署手册

本手册用于单台 Linux 云服务器的 Docker Compose 部署。该拓扑只运行一个应用实例，以保证现有 SQLite 数据一致性。

## 1. 服务器前置条件

- 64 位 Linux，已安装 Docker Engine 与 Docker Compose。
- 建议至少 4 核 CPU、8 GiB 内存，并为生成素材预留足够磁盘。
- 域名 A/AAAA 记录已指向服务器。
- 防火墙只向公网开放 TCP 80 和 443；SSH 仅向可信来源开放。

## 2. 准备配置

在仓库根目录执行：

```bash
cp .env.production.example .env.production
chmod 600 .env.production
```

编辑 `.env.production`：

- `APP_DOMAIN` 只填写域名，不带协议和路径。
- `APP_IMAGE` 使用通过 `Web Production Image` 工作流验证并发布的不可变 `sha-<commit-sha>` 标签，不使用 `latest`。
- `PLATFORM_JWT_SECRET` 与 `PLATFORM_ADMIN_TOKEN` 分别生成至少 32 字符的随机值，且不得相同。
- `PLATFORM_BOOTSTRAP_ADMIN_EMAIL` 填写首管理员邮箱。
- 首次启动保持 `PLATFORM_REGISTRATION_ENABLED=false`。

检查最终 Compose 配置时不要把输出保存到公开日志：

```bash
docker compose --env-file .env.production -f compose.production.yml config --quiet
```

如果 GHCR 包保持私有，先使用仅含 `read:packages` 权限的部署令牌执行 `docker login ghcr.io`；不要在服务器命令历史或仓库文件中保存令牌。公开镜像无需登录。

## 3. 拉取已验证镜像并启动

```bash
docker compose --env-file .env.production -f compose.production.yml pull app
docker compose --env-file .env.production -f compose.production.yml up -d
docker compose --env-file .env.production -f compose.production.yml ps
curl --fail "https://${APP_DOMAIN}/health"
```

Caddy 会自动申请和续期 HTTPS 证书。证书申请要求域名已正确解析，且 80、443 端口可从公网访问。

## 4. 首管理员引导

首次数据库没有用户。仅在创建首管理员期间：

1. 把 `.env.production` 的 `PLATFORM_REGISTRATION_ENABLED` 改为 `true`。
2. 重建应用容器，使用 `PLATFORM_BOOTSTRAP_ADMIN_EMAIL` 对应邮箱注册并登录。
3. 携带登录 Bearer JWT 和 `X-Platform-Admin-Token` 调用 `POST /api/v1/auth/bootstrap-admin`。
4. 确认获得管理员角色后，立即把公开注册改回 `false` 并重建应用容器。

管理员令牌不得写入浏览器持久存储、前端构建变量或共享脚本。

## 5. 上线前预检

先在管理后台配置所有支持模型的正整数积分价格，再执行：

```bash
docker compose --env-file .env.production -f compose.production.yml exec app npm run preflight:production
```

只有退出码为 0 且输出 `ready: true` 才可开放业务流量。随后使用隔离测试账号完成一次真实小额生成，核对供应商账单、积分预扣、成功结算和失败退款。

## 6. 数据备份

发布前创建备份，并紧接着列出备份：

```bash
docker compose --env-file .env.production -f compose.production.yml exec app npm run backup:create
docker compose --env-file .env.production -f compose.production.yml exec app npm run backup:list
```

出现 `DATA_BACKUP_LOW_SPACE`、`ENOSPC`、`EIO` 或最新备份状态异常时必须停止发布，不得循环重试。

## 7. 更新与回滚

更新：

```bash
docker compose --env-file .env.production -f compose.production.yml pull app
docker compose --env-file .env.production -f compose.production.yml up -d --no-deps app
docker compose --env-file .env.production -f compose.production.yml ps
```

更新前先把 `.env.production` 的 `APP_IMAGE` 改为目标提交对应的 `ghcr.io/xiongpinji/molimamahuabu2:sha-<commit-sha>`。回滚应用时，把它改回上一已验证的不可变标签，重新 `pull app` 后重建应用容器。数据库恢复必须按 `docs/PREPRODUCTION_OPERATIONS.md` 先完成备份验证和恢复演练，部署命令不会自动覆盖数据库。

## 8. 边界

- `molimama_data`、`caddy_data` 和 `caddy_config` 卷不得随普通更新删除。
- 禁止执行 `docker compose down -v`，它会删除持久数据。
- 现阶段禁止把 `app` 扩展到多个副本；如需水平扩展，应先迁移到独立数据库和对象存储。
