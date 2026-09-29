# 线上线下隐患治理落地记录（2026-09-18）

## 阶段 A（用户安全）

- 角色/场景/道具库公开平台归属：`libraryOwnership.js` + 三库路由 + 跨租户回归测试
- 全局 settings/prompts/scene-model-map 写操作加 `requireAdmin`
- `resourceOwnership`：库路径归属 + 未登记写前缀默认拒绝 + skip 白名单

## 阶段 B（稳定/资金）

- 孤儿任务：**无供应商任务号** → 系统直接失败并退款（不依赖人工对账）
- **有供应商任务号** → 保持 processing，交由恢复/轮询；超时由对账服务自动退款（约 10 分钟）
- `/static` 归属查询覆盖 `assets.local_path`（经 dramas）
- 文案去掉「等待管理员核对」，改为系统超时自动退回提示

## 阶段 C（开发卫生）

- [`docs/DEV_HYGIENE.md`](../DEV_HYGIENE.md)：禁止百度双向同步工作区
- 登录失败 toast 合同测试

## 阶段 D（发布门禁）

- `install-protected-release-guard.sh` 只安装 hardened `release-guard/activate-protected-release.sh`
- 新增 `deploy/rotate-reviewed-source-group.sh`（打印 LF SHA，禁止直接覆盖 shared）

## 阶段 E（可维护）

- `secretBox` + `aiConfigService` 写路径加密（有 `AI_CONFIG_MASTER_KEY` 时）；预检在 `AI_CONFIG_ENCRYPT_AT_REST=1|true` 时强制主密钥（`isTrue` 同时认字符串 `1`）
- `platformCapabilityService` 收敛 PUBLIC_PLATFORM 读取
- redraw catalog（风格/语区）拆到 `routes/redraw/catalog.js`

## 生产注意

1. 启用 Key 加密前：在 `production.env` 设置长随机 `AI_CONFIG_MASTER_KEY`，再设 `AI_CONFIG_ENCRYPT_AT_REST=1`
2. 本批改动需受保护发布；勿混入本地免证据补丁
3. 工程目录保持移出双向同步盘
