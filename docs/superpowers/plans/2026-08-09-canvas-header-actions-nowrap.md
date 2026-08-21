# 画布顶部操作区单行布局实现计划

> **面向 AI 代理的工作者：** 在当前独立 worktree 内按 TDD 顺序执行，步骤使用复选框跟踪。

**目标：** 让 `/canvas` 顶部导入、新建、充值和兑换入口保持单行，并避开右上角积分卡。

**架构：** 只调整共享 `PlatformHeader` 的响应式布局合同，不改变组件结构或路由。测试通过读取真实 Vue 单文件组件约束关键 CSS，浏览器验收覆盖桌面与窄屏。

**技术栈：** Vue 3、Element Plus、CSS Flexbox、Node.js `node:test`、Vite

---

### 任务 1：建立布局回归测试

**文件：**
- 修改：`frontweb/test/filmListCanvasEntry.test.js`

- [ ] 添加测试，断言操作区使用 `flex-wrap: nowrap`、公共账户卡避让使用 `clamp()`，并存在中等宽度文字收缩规则。
- [ ] 运行 `node --test test/filmListCanvasEntry.test.js`，确认因当前 `wrap` 与固定 `340px` 而失败。

### 任务 2：实现最小响应式修复

**文件：**
- 修改：`frontweb/src/components/PlatformHeader.vue`

- [ ] 将操作区改为不可换行和不可收缩。
- [ ] 将账户卡避让改为 `clamp(0px, calc(1040px - 50vw), 240px)`。
- [ ] 在 `max-width: 1280px` 隐藏通用按钮文字并固定为图标按钮。
- [ ] 运行目标测试，确认通过。

### 任务 3：回归与视觉验收

**文件：**
- 不新增生产文件。

- [ ] 运行 `node --test test/*.test.js`。
- [ ] 运行 `npm run build`。
- [ ] 使用该 worktree 的独立 Vite 端口检查桌面与窄屏布局。
- [ ] 审核 `git diff`，确认只包含设计记录、测试与必要 CSS。
