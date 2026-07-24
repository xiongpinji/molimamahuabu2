# 预发布检查与数据库保护操作手册

以下命令均在 `backend-node` 目录执行。生产环境应先确认当前工作目录、数据库路径和备份目录，再运行命令。

## 1. 生产预检

先按 `PUBLIC_PLATFORM_SETUP.md` 设置环境变量，再执行：

```powershell
npm run preflight:production
```

退出码为 `0` 且报告中的 `ready` 为 `true` 才表示自动检查通过。报告不会输出密钥原文。

当前仓库自带的开发配置会被拒绝，这是预期行为。正式部署配置至少要关闭调试模式和 `insecure_tls`，并把 CORS、素材地址改成非 localhost 的 HTTPS 地址。

## 2. 创建数据库备份

```powershell
$env:DATA_BACKUP_DIR='D:\molimama-backups'
$env:DATA_BACKUP_RETENTION='6'
$env:DATA_BACKUP_MIN_FREE_BYTES='10737418240'
npm run backup:create
```

工具使用 SQLite 在线备份能力创建一致性快照，生成同名 JSON 清单，并立即执行 SHA-256 和 `quick_check` 校验。默认保留最近 6 份，默认要求至少 10 GiB 可用空间。

出现 `DATA_BACKUP_LOW_SPACE`、`ENOSPC` 或 `EIO` 时视为备份失败，应停止操作并处理磁盘问题，不要循环重试。

## 3. 列出备份

```powershell
npm run backup:list
```

每次创建后都要确认列表首项的 `created_at`、`size_bytes`、`sha256` 和 `integrity`。

## 4. 验证指定备份

```powershell
npm run backup:verify -- --backup 'D:\molimama-backups\database-20260724T080000000Z.sqlite'
```

只有 `valid: true` 才可进入恢复演练。

## 5. 恢复演练

```powershell
npm run backup:restore-drill -- `
  --backup 'D:\molimama-backups\database-20260724T080000000Z.sqlite' `
  --target 'D:\molimama-restore-drill\drama_generator.sqlite'
```

恢复演练只允许写入一个不存在的新目标文件。工具不会覆盖任何现有数据库，也不会替换生产数据库。

## 6. 人工检查

自动预检通过后仍需人工完成：

1. 配置 HTTPS、反向代理请求体限制、日志脱敏、限流和告警。
2. 使用隔离测试账号执行一次真实小额生成，对照供应商账单与积分预扣/结算。
3. 验证生成失败、状态未知和人工对账流程。
4. 记录备份存储位置、负责人和恢复演练结果。
