# 公开收费平台启用清单

当前版本默认仍按本地模式运行。未完成以下清单前，不得开放公网收费服务。

## 后端环境变量

```text
PUBLIC_PLATFORM_MODE=true
PLATFORM_JWT_SECRET=<至少 32 字节的独立随机密钥>
PLATFORM_ADMIN_TOKEN=<至少 32 字符的独立随机令牌>
PLATFORM_BOOTSTRAP_ADMIN_EMAIL=<首个管理员的已验证邮箱>
PLATFORM_REGISTRATION_ENABLED=false
```

- `PLATFORM_JWT_SECRET` 用于签发用户登录令牌，不能与管理员令牌或模型 API 密钥复用。
- `PLATFORM_ADMIN_TOKEN` 通过 `X-Platform-Admin-Token` 请求头传递；用户 JWT 始终使用 `Authorization: Bearer ...`，两者不能混用。
- `PLATFORM_BOOTSTRAP_ADMIN_EMAIL` 锁定首管理员身份。仅凭邮箱不会自动提权；对应账号登录后还必须携带 `X-Platform-Admin-Token` 调用 `POST /api/v1/auth/bootstrap-admin`。该接口只在数据库从未存在任何 `admin` 账号时成功一次，并返回提升后的新 JWT；管理员即使被停用也不会重新开放引导。
- 默认关闭公开注册。正式开放前还需要验证码、邮件验证、注册限流和用户协议确认。

## 支付宝充值变量

```text
ALIPAY_APP_ID=<支付宝应用 ID>
ALIPAY_SELLER_ID=<收款商户 sellerId>
ALIPAY_PRIVATE_KEY=<应用私钥，或改用 ALIPAY_PRIVATE_KEY_PATH>
ALIPAY_PUBLIC_KEY=<支付宝公钥，或改用 ALIPAY_PUBLIC_KEY_PATH>
ALIPAY_KEY_TYPE=PKCS8
ALIPAY_NOTIFY_URL=https://你的域名/api/v1/billing/recharge/alipay/notify
ALIPAY_RETURN_URL=https://你的域名/tenant-console?section=recharge
```

缺少任一必要项时，充值入口保持停用且不会创建支付订单。密钥只允许注入后端环境或仅服务账号可读的文件；完整商户准备、小额验收和回调检查见 [`docs/ALIPAY_RECHARGE_SETUP.md`](docs/ALIPAY_RECHARGE_SETUP.md)。

## 前端构建变量

```text
VITE_PUBLIC_PLATFORM_MODE=true
```

启用后，匿名用户会被送到登录页；登录令牌保存在浏览器本地存储。管理员令牌只保存在当前标签页会话，并且只发送到 AI 配置和模型定价接口。

## 上线前人工确认

1. 通过 `/billing-admin` 为 `GPT-5.5`、`gpt-image-2`、`seedance 2.0` 分别设置正整数积分价格；未定价模型会禁止生成。
2. 设置 `PLATFORM_BOOTSTRAP_ADMIN_EMAIL`，临时开放注册或预先创建对应账号。该账号登录后，用 Bearer JWT 和 `X-Platform-Admin-Token` 调用 `POST /api/v1/auth/bootstrap-admin`，保存返回的新 JWT并立即关闭公开注册；再创建普通测试用户。
3. 按支付宝配置文档完成应用、电脑网站支付、密钥和 HTTPS 回调设置；用低金额套餐完成一次小额真实充值，确认异步通知验签、订单状态和积分只入账一次。
4. 在隔离测试账户中执行一次真实小额生成，核对供应商账单、预扣、成功确认、明确失败退款和状态未知冻结。
5. 配置 HTTPS、反向代理请求体上限、数据库与素材备份、日志脱敏、限流及告警。
6. 按 [`docs/PREPRODUCTION_OPERATIONS.md`](docs/PREPRODUCTION_OPERATIONS.md) 执行生产预检、数据库备份和只读恢复演练；自动预检的 `ready` 必须为 `true`。

## 当前禁止事项

- 不允许在未确认模型价格时上线。
- 不允许把管理员令牌写入前端构建产物或源码。
- 不允许状态未知时自动退款或引导用户立即重新生成。
- 不允许把本地测试通过等同于支付系统已经可上线。

## 生成防滥用与用户审计

- 仅在 `PUBLIC_PLATFORM_MODE=true` 时启用：注册和登录按来源地址的哈希值限为每 15 分钟 10 次；认证后的模型生成请求按用户限为每分钟 20 次。
- 统一守卫覆盖 GPT 剧本和角色生成、图片生成、Seedance 视频生成及分镜提示词处理；`/images`、`/videos` 不再重复计数。
- 登录用户可调用 `GET /api/v1/billing/audit-events?limit=50` 查看自己的结构化生成审计事件；接口不会返回其他用户事件，也不会返回提示词、模型密钥、邮箱、密码或原始 IP。
- 限流只降低突发滥用，不等于所有旧生成入口均已接入积分账本。公开收费发布前，必须确认每个可产生供应商费用的入口均走原子预扣/结算流程，或在公开模式下明确禁用。
