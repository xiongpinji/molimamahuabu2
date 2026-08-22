# 生产环境隐藏一键转绘导航入口实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 生产构建不渲染主导航中的“一键转绘”链接，同时本地开发继续显示该入口，且 `/redraw` 路由和后端 API 保持不变。

**架构：** 新增一个只根据 `isProduction` 返回布尔值的纯函数，由 `PlatformPrimaryNav.vue` 使用 Vite 的 `import.meta.env.PROD` 调用。Node 单测验证环境合同，Playwright 分别验证生产预览隐藏入口和现有开发环境入口/工作台路径保持可用。

**技术栈：** Vue 3、Vite 6、Node.js `node:test`、Playwright 1.61、PowerShell。

---

## 文件结构

- 创建：`frontweb/src/utils/redrawEntryVisibility.js`——唯一职责是计算一键转绘导航入口是否可见。
- 修改：`frontweb/src/components/PlatformPrimaryNav.vue`——根据可见性结果条件渲染现有链接。
- 创建：`frontweb/test/redrawEntryVisibility.test.js`——验证纯函数合同和导航接线。
- 创建：`frontweb/e2e/redraw-production-entry.spec.js`——验证生产预览的桌面/移动导航隐藏，同时确认直达路由仍保留。

### 任务 1：先用测试锁定生产隐藏、开发可见合同

**文件：**
- 创建：`frontweb/test/redrawEntryVisibility.test.js`
- 创建：`frontweb/e2e/redraw-production-entry.spec.js`

- [ ] **步骤 1：编写失败的 Node 合同测试**

创建 `frontweb/test/redrawEntryVisibility.test.js`：

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { shouldShowRedrawEntry } from '../src/utils/redrawEntryVisibility.js'

const navSource = readFileSync(
  new URL('../src/components/PlatformPrimaryNav.vue', import.meta.url),
  'utf8',
)

test('生产环境隐藏一键转绘导航入口', () => {
  assert.equal(shouldShowRedrawEntry({ isProduction: true }), false)
})

test('开发和测试环境保留一键转绘导航入口', () => {
  assert.equal(shouldShowRedrawEntry({ isProduction: false }), true)
})

test('主导航仅对一键转绘链接应用生产可见性判断', () => {
  assert.match(navSource, /import \{ shouldShowRedrawEntry \} from '@\/utils\/redrawEntryVisibility'/)
  assert.match(navSource, /const redrawEntryVisible = shouldShowRedrawEntry\(\{\s*isProduction: import\.meta\.env\.PROD,?\s*\}\)/)
  assert.match(navSource, /<RouterLink\s+v-if="redrawEntryVisible"\s+to="\/redraw"/)
  assert.match(navSource, /<RouterLink\s+to="\/factory"/)
})
```

- [ ] **步骤 2：运行 Node 测试并确认正确失败**

运行：

```powershell
cd frontweb
node --test test/redrawEntryVisibility.test.js
```

预期：FAIL，错误为找不到 `src/utils/redrawEntryVisibility.js`；失败原因是可见性实现尚不存在，而不是测试语法错误。

- [ ] **步骤 3：编写生产预览浏览器合同**

创建 `frontweb/e2e/redraw-production-entry.spec.js`：

```js
import { test, expect } from '@playwright/test'

test.skip(
  process.env.REDRAW_PRODUCTION_PREVIEW !== '1',
  '该合同只对已经构建的生产预览运行',
)

async function installSessionAndApiFixtures(page) {
  await page.addInitScript(() => {
    window.localStorage.setItem('moli_mama_session', JSON.stringify({
      token: 'redraw-entry-preview-token',
      user: {
        id: 'redraw-entry-preview-user',
        email: 'redraw-entry-preview@example.test',
        role: 'admin',
      },
    }))
  })

  await page.route('**/api/v1/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: [] }),
    })
  })
}

for (const viewport of [
  { name: '桌面端', width: 1440, height: 900 },
  { name: '移动端', width: 390, height: 844 },
]) {
  test(`${viewport.name}生产导航隐藏入口但保留直达路由`, async ({ page }) => {
    await installSessionAndApiFixtures(page)
    await page.setViewportSize({ width: viewport.width, height: viewport.height })

    await page.goto('/')
    await expect(page.getByRole('link', { name: '一键转绘' })).toHaveCount(0)

    await page.goto('/redraw')
    await expect(page.getByRole('heading', { name: '一键转绘项目' })).toBeVisible()
  })
}
```

- [ ] **步骤 4：用改动前的生产构建确认浏览器合同失败**

先运行：

```powershell
npm run build
$nodePath = (Get-Command node.exe).Source
$previewProcess = Start-Process -FilePath $nodePath -ArgumentList @('node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', '4178') -WorkingDirectory (Get-Location) -WindowStyle Hidden -PassThru
```

运行以下完整检查；最多等待 30 秒，且只停止上一步创建的进程：

```powershell
$previewReady = $false
try {
  for ($attempt = 0; $attempt -lt 60; $attempt++) {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:4178/' -TimeoutSec 2
      if ($response.StatusCode -eq 200) {
        $previewReady = $true
        break
      }
    } catch {}
    Start-Sleep -Milliseconds 500
  }
  if (-not $previewReady) { throw '生产预览在 30 秒内未就绪' }

  $env:PLAYWRIGHT_BASE_URL = 'http://127.0.0.1:4178'
  $env:PLAYWRIGHT_REUSE_SERVER = '1'
  $env:REDRAW_PRODUCTION_PREVIEW = '1'
  npx playwright test e2e/redraw-production-entry.spec.js
  if ($LASTEXITCODE -eq 0) { throw '改动前生产预览合同意外通过，红灯无效' }
} finally {
  Remove-Item Env:PLAYWRIGHT_BASE_URL -ErrorAction SilentlyContinue
  Remove-Item Env:PLAYWRIGHT_REUSE_SERVER -ErrorAction SilentlyContinue
  Remove-Item Env:REDRAW_PRODUCTION_PREVIEW -ErrorAction SilentlyContinue
  if (Get-Process -Id $previewProcess.Id -ErrorAction SilentlyContinue) {
    Stop-Process -Id $previewProcess.Id -Force
  }
}
```

预期：2 个用例均 FAIL，失败点为“一键转绘”链接数量实际为 `1`；这证明测试能捕获当前线上对应行为。

### 任务 2：最小实现生产隐藏逻辑

**文件：**
- 创建：`frontweb/src/utils/redrawEntryVisibility.js`
- 修改：`frontweb/src/components/PlatformPrimaryNav.vue:26-34,50-56`
- 测试：`frontweb/test/redrawEntryVisibility.test.js`

- [ ] **步骤 1：实现纯可见性函数**

创建 `frontweb/src/utils/redrawEntryVisibility.js`：

```js
export function shouldShowRedrawEntry({ isProduction } = {}) {
  return isProduction !== true
}
```

该函数仅表达已经批准的二元合同，不增加运行时配置、数据库开关或通用功能开关框架。

- [ ] **步骤 2：只给现有一键转绘链接增加条件渲染**

在 `frontweb/src/components/PlatformPrimaryNav.vue` 的一键转绘 `RouterLink` 上添加：

```vue
<RouterLink
  v-if="redrawEntryVisible"
  to="/redraw"
  class="platform-primary-nav__link"
  :class="{ 'is-active': redrawActive }"
  :aria-current="redrawActive ? 'page' : undefined"
>
  一键转绘
</RouterLink>
```

在 `<script setup>` 中加入：

```js
import { shouldShowRedrawEntry } from '@/utils/redrawEntryVisibility'

const redrawEntryVisible = shouldShowRedrawEntry({
  isProduction: import.meta.env.PROD,
})
```

不要修改 `redrawActive`、其他导航项、路由文件或转绘 API。

- [ ] **步骤 3：运行 Node 合同测试确认通过**

运行：

```powershell
node --test test/redrawEntryVisibility.test.js
```

预期：3/3 PASS，0 FAIL。

- [ ] **步骤 4：运行现有静态入口合同防止误删路由**

运行：

```powershell
node --test test/redrawFoundation.test.js test/filmListCanvasEntry.test.js
```

预期：全部 PASS；现有测试仍能在源码中找到 `/redraw` 路由、链接和工作台合同。

- [ ] **步骤 5：提交最小实现与测试**

```powershell
git add -- frontweb/src/utils/redrawEntryVisibility.js frontweb/src/components/PlatformPrimaryNav.vue frontweb/test/redrawEntryVisibility.test.js frontweb/e2e/redraw-production-entry.spec.js
git commit -m "fix: 生产环境隐藏一键转绘入口"
```

### 任务 3：验证生产隐藏和本地开发可见

**文件：**
- 验证：`frontweb/e2e/redraw-production-entry.spec.js`
- 回归：`frontweb/e2e/redraw-workspace.spec.js`

- [ ] **步骤 1：运行全部转绘前端 Node 回归**

运行：

```powershell
node --test test/redraw*.test.js
```

预期：0 FAIL；测试总数应比实现前增加 3。

- [ ] **步骤 2：重新生成生产构建**

运行：

```powershell
npm run build
```

预期：exit 0，`dist/` 成功生成，无 Vite 构建错误。

- [ ] **步骤 3：在生产预览运行桌面和移动隐藏合同**

启动专用预览进程：

```powershell
$nodePath = (Get-Command node.exe).Source
$previewProcess = Start-Process -FilePath $nodePath -ArgumentList @('node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', '4178') -WorkingDirectory (Get-Location) -WindowStyle Hidden -PassThru
```

运行以下完整验证；最多等待 30 秒，且只停止上一步创建的进程：

```powershell
$previewReady = $false
try {
  for ($attempt = 0; $attempt -lt 60; $attempt++) {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:4178/' -TimeoutSec 2
      if ($response.StatusCode -eq 200) {
        $previewReady = $true
        break
      }
    } catch {}
    Start-Sleep -Milliseconds 500
  }
  if (-not $previewReady) { throw '生产预览在 30 秒内未就绪' }

  $env:PLAYWRIGHT_BASE_URL = 'http://127.0.0.1:4178'
  $env:PLAYWRIGHT_REUSE_SERVER = '1'
  $env:REDRAW_PRODUCTION_PREVIEW = '1'
  npx playwright test e2e/redraw-production-entry.spec.js
  if ($LASTEXITCODE -ne 0) { throw '生产预览入口隐藏合同失败' }
} finally {
  Remove-Item Env:PLAYWRIGHT_BASE_URL -ErrorAction SilentlyContinue
  Remove-Item Env:PLAYWRIGHT_REUSE_SERVER -ErrorAction SilentlyContinue
  Remove-Item Env:REDRAW_PRODUCTION_PREVIEW -ErrorAction SilentlyContinue
  if (Get-Process -Id $previewProcess.Id -ErrorAction SilentlyContinue) {
    Stop-Process -Id $previewProcess.Id -Force
  }
}
```

预期：2/2 PASS；桌面和移动导航都没有入口，直接打开 `/redraw` 仍可见项目页。

- [ ] **步骤 4：使用开发服务器运行现有转绘浏览器回归**

运行：

```powershell
$env:PLAYWRIGHT_REUSE_SERVER = '0'
npx playwright test e2e/redraw-workspace.spec.js
Remove-Item Env:PLAYWRIGHT_REUSE_SERVER
```

预期：现有全部用例 PASS；其中桌面入口流程仍能从首页点击“一键转绘”，证明本地开发没有被隐藏。该套件拦截 `/api/v1/**`，因此只属于浏览器 fixture 回归，不宣称真实后端或供应商端到端。

- [ ] **步骤 5：检查精确改动和干净工作树**

运行：

```powershell
git diff --check HEAD~1..HEAD
git show --stat --oneline HEAD
git status --short --branch
```

预期：`git diff --check` exit 0；提交只包含本计划列出的四个实现/测试文件；工作树干净。

## 完成与部署边界

本计划完成只证明本地代码、生产构建预览和 fixture 浏览器合同通过。不得据此声称线上已经隐藏，也不得创建或切换生产候选。

如用户后续明确批准部署，必须重新读取实时 `/opt/moli-drama/current`，确认其他会话、`deploy.lock` 和生产操作状态，从实时 release 克隆候选，仅叠加本次已审计文件并重新构建，最后通过共享受保护发布门禁执行 CAS 切换。
