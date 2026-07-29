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

### 7.1 单机隔离预热

轻量服务器使用 SQLite，禁止让灰度实例和生产实例共享
`molimama_data`。先用独立 Compose 项目启动同一不可变镜像；项目名会创建
独立网络和独立数据卷，且不启动 Caddy、不接收公网流量：

```bash
docker compose -p molimama-canary --env-file .env.production -f compose.production.yml pull app
docker compose -p molimama-canary --env-file .env.production -f compose.production.yml up -d --no-deps app
docker compose -p molimama-canary --env-file .env.production -f compose.production.yml ps
docker compose -p molimama-canary --env-file .env.production -f compose.production.yml exec -T app \
  node -e "fetch('http://127.0.0.1:5679/health').then(async r=>{const b=await r.json();if(!r.ok||b.status!=='ok')process.exit(1)})"
docker compose -p molimama-canary --env-file .env.production -f compose.production.yml exec -T app \
  /opt/rembg/bin/rembg-cpu --version
```

版本必须为 `2.0.77`。预热失败时只停止隔离实例，不改生产实例：
该运行链只使用 CPU，不要求服务器 GPU，也不安装 CUDA、ROCm 或
`onnxruntime-gpu`。镜像中的通用 Mesa/Vulkan 库来自 FFmpeg 的 Debian
传递依赖，不应据此配置 GPU 驱动或放宽设备权限。

```bash
docker compose -p molimama-canary --env-file .env.production -f compose.production.yml down
```

不要添加 `-v`，避免把删除卷变成发布流程的常规动作。预热项目不得挂载生产
数据库、生产素材目录或 `molimama_data`。

### 7.2 提升为生产版本

确认第 6 节备份及 `backup:list` 正常后更新：

```bash
docker compose --env-file .env.production -f compose.production.yml pull app
docker compose --env-file .env.production -f compose.production.yml up -d --no-deps app
docker compose --env-file .env.production -f compose.production.yml ps
curl --fail "https://${APP_DOMAIN}/health"
```

更新前先把 `.env.production` 的 `APP_IMAGE` 改为目标提交对应的
`ghcr.io/xiongpinji/molimamahuabu2:sha-<commit-sha>`。提升后使用隔离测试账号
执行图片节点确定性编辑和一笔最低成本远程图片任务，核对任务完成、派生资产、
源资产未覆盖、失败回写、刷新恢复和积分结算；期间不开放新用户流量。

### 7.3 回滚

回滚应用时，把 `APP_IMAGE` 改回上一已验证的不可变标签，重新 `pull app` 后
重建应用容器并再次检查 `/health`。数据库恢复必须按
`docs/PREPRODUCTION_OPERATIONS.md` 先完成备份验证和恢复演练，部署命令不会
自动覆盖数据库。若本次发布没有数据库迁移，不应为了应用回滚而覆盖当前数据库。

## 8. 边界

- `molimama_data`、`caddy_data` 和 `caddy_config` 卷不得随普通更新删除。
- 禁止执行 `docker compose down -v`，它会删除持久数据。
- 现阶段禁止把 `app` 扩展到多个副本；如需水平扩展，应先迁移到独立数据库和对象存储。
