# 后端高危依赖升级验收（2026-07-24）

## 结论

本阶段通过。两个高危直接依赖已定向升级，官方生产依赖审计为 0 漏洞，ZIP 导入与 Sharp 图片处理契约保持正常，未修改生产业务代码。

## 版本与运行时

| 项目 | 升级前 | 升级后 |
|---|---:|---:|
| `adm-zip` | `0.5.16` | `0.6.0` |
| `sharp` | `0.34.5` | `0.35.3` |
| Node.js 最低版本声明 | `>=18` | `>=20.9.0` |

- `adm-zip@0.6.0`：MIT。
- `sharp@0.35.3`：Apache-2.0。
- 验收环境：Node.js `v24.17.0`。
- 收紧 Node.js 下限是必要兼容性调整：`sharp@0.35.3` 官方运行时要求为 `>=20.9.0`。

## TDD 与兼容性证据

升级前先运行 `backend-node/test/dependencySecurityUpgrade.test.js`：

- 安全版本下限测试按预期失败：
  - `adm-zip 当前版本为 0.5.16`
  - `sharp 当前版本为 0.34.5`
- ZIP 解析与 Sharp 元数据/缩放行为测试通过，建立旧版行为基线。

升级后：

```text
node --test test/dependencySecurityUpgrade.test.js test/gridSplitSmoke.test.js
tests 6
pass 6
fail 0
```

覆盖：

- 项目 ZIP 的 `project.json` 与媒体文件解析。
- Sharp 元数据读取、Lanczos 缩放和 PNG 输出。
- 现有宫格裁切生产链路。
- 安全版本下限与 Node.js 运行时下限。

## 全量验证

| 验证项 | 结果 |
|---|---|
| 后端全量 Node 测试 | `381/381` 通过 |
| 前端全量 Node 测试 | `288/288` 通过 |
| 前端生产构建 | 通过，Vite `built in 24.12s` |
| 后端官方生产依赖审计 | `found 0 vulnerabilities` |
| 前端官方生产依赖审计 | `found 0 vulnerabilities` |
| 独立临时目录 `npm ci` | 成功安装 172 个包 |
| 独立安装依赖树 | `adm-zip@0.6.0`、`sharp@0.35.3` |
| 独立安装官方审计 | `found 0 vulnerabilities` |

官方审计命令：

```bash
npm audit --omit=dev --registry=https://registry.npmjs.org
```

## 差异审计

- 直接依赖只升级 `adm-zip` 与 `sharp`。
- 锁文件中的其他版本变化均来自 Sharp 的必要传递依赖与平台二进制包。
- 安装与运行文档已统一为 Node.js `>=20.9.0`。
- 未修改图片、视频、模型、计费或数据库生产代码。
- `git diff --check` 通过。

## 非阻断说明

- 运行中的演示后端已加载 Sharp/SQLite 原生模块，原工作树内执行 `npm ci` 会因 Windows 文件锁返回 `EPERM`。没有停止演示服务；改在独立临时目录完成干净安装验证并在验证后删除临时目录。
- Vite 仍提示部分产物超过 500 kB；构建成功，该既有体积告警不属于本次依赖安全升级范围。
- npm 提示传递依赖 `lodash.get@4.4.2` 已弃用，但官方安全审计为 0 漏洞；本阶段未扩大到无关依赖升级。
