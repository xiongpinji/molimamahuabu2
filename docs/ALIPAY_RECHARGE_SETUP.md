# 支付宝自主充值配置

本功能提供一个支付宝支付通道、固定 `1 元 = 100 积分` 的自定义充值，以及管理员配置的限时套餐。套餐售价可设为 `0.01` 至 `50000.00` 元，到账积分为正整数，并必须配置 HTTPS 广告图片；订单会保存下单时的套餐名称、金额和积分快照。

## 商户侧准备

1. 在[支付宝开放平台](https://open.alipay.com/module/webApp)创建网页/移动应用，并为应用开通网页支付产品。
2. 按平台指引生成应用私钥、配置应用公钥，取得支付宝公钥。
3. 确认应用 `appId` 与实际收款账号的 `sellerId`。回调域名必须是公网可访问的 HTTPS 地址。

项目使用支付宝官方 Node.js SDK 的 `alipay.trade.page.pay` 接口和异步通知验签能力。SDK 配置与示例见[支付宝官方 SDK 仓库](https://github.com/alipay/alipay-sdk-nodejs-all)。

## 服务端环境变量

```text
ALIPAY_APP_ID=应用ID
ALIPAY_SELLER_ID=收款支付宝账号对应的sellerId
ALIPAY_PRIVATE_KEY_PATH=D:\secure\alipay-app-private-key.pem
ALIPAY_PUBLIC_KEY_PATH=D:\secure\alipay-public-key.pem
ALIPAY_KEY_TYPE=PKCS8
ALIPAY_NOTIFY_URL=https://你的域名/api/v1/billing/recharge/alipay/notify
ALIPAY_RETURN_URL=https://你的域名/tenant-console?section=recharge
```

也可以用 `ALIPAY_PRIVATE_KEY` 和 `ALIPAY_PUBLIC_KEY` 直接注入密钥内容；生产环境优先使用仅服务账号可读的密钥文件。不要把私钥、公钥或商户凭据提交到 Git、写入前端变量或输出到日志。

可选项：

```text
ALIPAY_GATEWAY=https://openapi.alipay.com/gateway.do
```

生产环境默认使用上述正式网关。只有在支付宝沙箱联调时才覆盖为沙箱网关，并使用配套沙箱应用和账号，正式与沙箱密钥不能混用。

## 上线前核对

1. 执行数据库迁移，确认 `48_alipay_recharge.sql` 已应用。
2. 重启后端，登录用户端并确认 `/api/v1/billing/recharge/alipay/config` 返回 `configured: true`。
3. 在管理员后台创建一个低金额、短有效期测试套餐，检查广告图片仅使用可信 HTTPS 地址。
4. 使用测试账号完成一笔小额真实支付，确认支付宝异步通知返回纯文本 `success`，订单只变为一次 `paid`，工作区积分只增加一次。
5. 分别重放同一通知和发送错误金额通知，确认不会重复加积分或错误加积分。

支付宝异步通知是唯一的到账依据；浏览器支付完成后的同步跳转只用于返回充值页面，不会直接增加积分。
