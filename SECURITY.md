# 安全政策 / Security Policy

## 支持的版本 / Supported Versions

我们只对最新发布版本提供安全修复。  
Security fixes are only provided for the latest release.

| 版本 / Version | 支持状态 / Support |
|---------------|-------------------|
| 最新版 / Latest | ✅ 支持 / Supported |
| 旧版本 / Older  | ❌ 不支持 / Not supported |

## 报告漏洞 / Reporting a Vulnerability

**请勿通过公开 Issue 报告安全漏洞。**  
**Please do NOT report security vulnerabilities via public Issues.**

### 联系方式 / Contact

如果你发现了安全漏洞，请通过以下方式私下联系我们：  
If you discover a security vulnerability, please contact us privately:

- **GitHub Security Advisory**：点击仓库页面的 [Security](../../security/advisories/new) 标签 → Report a vulnerability

### 响应流程 / Response Process

1. 收到报告后我们会在 **3 个工作日**内确认收到
2. 评估漏洞严重程度，制定修复计划
3. 修复完成后发布新版本，在 Changelog 中说明（不披露细节）
4. 感谢报告者（如果你愿意，会在 Changelog 中致谢）

### 安全边界 / Security Scope

本项目同时支持本地运行与**网页端生产部署**。网页端模式会在服务器端处理账号、项目、素材、生成任务、积分记录及第三方模型请求，因此部署方负责：

- 只通过 HTTPS 对外提供服务，并限制服务器、防火墙和 SSH 权限。
- 将 JWT 密钥、管理员令牌和第三方模型 API 密钥保存在服务器受限环境文件或密钥管理服务中，不得写入前端、镜像或公开日志。
- 保护 SQLite 数据库、素材目录与备份；上线前验证备份，普通更新不得删除持久卷。
- 关闭调试模式、公开注册和不安全 TLS，及时更新依赖及经过验证的容器镜像。
- 明确第三方模型供应商会接收生成所需的提示词和参考素材，并依据其隐私政策处理数据。

漏洞报告范围包括网页鉴权与多租户隔离、积分计费绕过、密钥泄露、任意文件访问、上传与媒体处理、服务端请求伪造、依赖和容器供应链，以及本地运行模式的文件访问和第三方 API 请求。

The project supports both local use and **production web deployment**. In web mode, the server processes accounts, projects, media, generation jobs, credit records, and outbound model-provider requests. Operators must enforce HTTPS and least privilege, keep secrets out of client bundles and images, protect and back up persistent data, disable unsafe production settings, and disclose relevant third-party data processing.
