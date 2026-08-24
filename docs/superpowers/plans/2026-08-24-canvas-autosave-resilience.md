# 画布自动保存容灾实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让画布布局保存遇到断网或 `502/503/504` 时自动退避并最终只保存最新快照，同时保证工作流分组失败仍立即回滚、错误消息不堆叠。

**架构：** 将 `canvasLayoutPersistence.js` 扩展为唯一写入协调器，独占 revision、在途请求和重试定时器；Vue 层只组装快照、映射状态并拥有一次性消息。API 层只透传 `silentError`，重试严格限于不含 `workflowGroups` 的布局 PUT，不触碰后端、生成、积分或供应商逻辑。

**技术栈：** Vue 3、Axios、Element Plus、Node.js `node:test`、Playwright、Vite

---

## 文件结构与职责

- 修改 `frontweb/src/utils/canvasLayoutPersistence.js`：实现单在途、单定时器、最新快照、退避、状态通知与销毁合同。
- 修改 `frontweb/test/canvasLayoutPersistence.test.js`：用可控调度器验证重试序列、快照替换、错误分类、工作流隔离与销毁。
- 修改 `frontweb/src/api/drama.js`：给 `saveCanvasLayout` 增加可选 Axios 配置透传。
- 修改 `frontweb/test/requestSilentError.test.js`：锁定 `silentError` 透传且 `401` 行为不被静默。
- 修改 `frontweb/src/views/DramaCanvas.vue`：删除第二条 Promise 队列，映射协调器状态并去重故障/恢复消息。
- 修改 `frontweb/test/standaloneCanvasFreeNodeRuntime.test.js`：锁定组件只有一个协调器、布局可重试、分组不重试和卸载销毁。
- 修改 `frontweb/e2e/project-canvas-ci.spec.js`：用本地路由替身验证一次 `503` 后恢复、最新布局回读及无请求风暴。

## 固定接口

协调器在所有任务中统一使用以下接口，后续步骤不得改名：

```js
createCanvasLayoutPersistence(save, {
  isRetryable = isTransientHttpError,
  retryDelays = [2000, 4000, 8000, 15000],
  savedStateDuration = 2000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  onStateChange = () => {},
} = {})

persistence.update(payload, { allowRetry = false } = {})
persistence.flush()
persistence.dispose()
persistence.state
persistence.dirty
persistence.revision
persistence.savedRevision
```

`payload` 是一次精确写入意图：布局保存只含 `canvasLayout`，分组保存只含 `workflowGroups`。协调器不得把上一次的 `workflowGroups` 合并进后续布局重试。成功结果统一为 `{ status: 'saved', result, revision }`；进入退避统一为 `{ status: 'queued', revision, delay }`。

### 任务 1：用单元测试冻结协调器状态机

**文件：**
- 修改：`frontweb/test/canvasLayoutPersistence.test.js`
- 测试：`frontweb/test/canvasLayoutPersistence.test.js`

- [ ] **步骤 1：加入可控定时器和瞬时错误工厂**

在现有 import 后加入：

```js
function httpError(status) {
  const error = new Error(`HTTP ${status}`)
  error.response = { status }
  return error
}

function createScheduler() {
  const pending = []
  return {
    delays: [],
    setTimer(callback, delay) {
      const token = { callback, delay, cancelled: false }
      this.delays.push(delay)
      pending.push(token)
      return token
    },
    clearTimer(token) { token.cancelled = true },
    async runNext() {
      const token = pending.shift()
      assert.ok(token, 'expected a scheduled retry')
      if (!token.cancelled) await token.callback()
    },
    get activeCount() { return pending.filter((item) => !item.cancelled).length },
  }
}
```

- [ ] **步骤 2：编写首次失败、退避序列和成功复位的失败测试**

加入：

```js
test('布局瞬时失败按 2/4/8/15/15 秒退避并在成功后复位', async () => {
  const scheduler = createScheduler()
  const states = []
  let attempts = 0
  const persistence = createCanvasLayoutPersistence(async (payload) => {
    attempts += 1
    if (attempts <= 5) throw httpError(503)
    return { metadata: { canvas_layout: payload.canvasLayout } }
  }, {
    setTimer: scheduler.setTimer.bind(scheduler),
    clearTimer: scheduler.clearTimer.bind(scheduler),
    onStateChange: (event) => states.push(event),
  })

  assert.equal((await persistence.update({ canvasLayout: { x: 1 } }, { allowRetry: true })).status, 'queued')
  for (let index = 0; index < 5; index += 1) await scheduler.runNext()

  assert.deepEqual(scheduler.delays.slice(0, 5), [2000, 4000, 8000, 15000, 15000])
  assert.equal(persistence.dirty, false)
  assert.equal(persistence.state, 'saved')
  assert.equal(states.filter(({ state }) => state === 'retry_wait').length, 5)
  await scheduler.runNext()
  assert.equal(persistence.state, 'idle')

  attempts = 0
  await persistence.update({ canvasLayout: { x: 2 } }, { allowRetry: true })
  assert.equal(scheduler.delays.at(-1), 2000)
  persistence.dispose()
})
```

- [ ] **步骤 3：编写最新快照、单请求、单定时器测试**

加入：

```js
test('退避期间只发送最新布局且任意时刻仅有一个请求和定时器', async () => {
  const scheduler = createScheduler()
  const calls = []
  let attempts = 0
  const persistence = createCanvasLayoutPersistence(async (payload) => {
    calls.push(structuredClone(payload))
    attempts += 1
    if (attempts === 1) throw new Error('offline')
    return { metadata: { canvas_layout: payload.canvasLayout } }
  }, {
    setTimer: scheduler.setTimer.bind(scheduler),
    clearTimer: scheduler.clearTimer.bind(scheduler),
  })

  await persistence.update({ canvasLayout: { x: 1 } }, { allowRetry: true })
  await persistence.update({ canvasLayout: { x: 2 } }, { allowRetry: true })
  await persistence.update({ canvasLayout: { x: 3 } }, { allowRetry: true })
  assert.equal(scheduler.activeCount, 1)
  assert.equal(calls.length, 1)

  await scheduler.runNext()
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[1].canvasLayout, { x: 3 })
  assert.equal(persistence.savedRevision, persistence.revision)
})
```

- [ ] **步骤 4：编写错误分类、分组隔离和销毁测试**

加入：

```js
test('仅无响应和 502/503/504 的布局写入自动重试', async () => {
  for (const status of [502, 503, 504]) {
    const scheduler = createScheduler()
    const persistence = createCanvasLayoutPersistence(async () => { throw httpError(status) }, {
      setTimer: scheduler.setTimer.bind(scheduler),
      clearTimer: scheduler.clearTimer.bind(scheduler),
    })
    assert.equal((await persistence.update({ canvasLayout: { status } }, { allowRetry: true })).status, 'queued')
    assert.equal(scheduler.activeCount, 1)
    persistence.dispose()
  }

  for (const status of [400, 401, 403, 409, 500]) {
    const scheduler = createScheduler()
    const persistence = createCanvasLayoutPersistence(async () => { throw httpError(status) }, {
      setTimer: scheduler.setTimer.bind(scheduler),
      clearTimer: scheduler.clearTimer.bind(scheduler),
    })
    await assert.rejects(
      persistence.update({ canvasLayout: { status } }, { allowRetry: true }),
      new RegExp(String(status)),
    )
    assert.equal(scheduler.activeCount, 0)
  }
})

test('分组失败不重试且不会混入后续布局重试', async () => {
  const scheduler = createScheduler()
  const calls = []
  let attempt = 0
  const persistence = createCanvasLayoutPersistence(async (payload) => {
    calls.push(structuredClone(payload))
    attempt += 1
    if (attempt <= 2) throw httpError(503)
    return { metadata: { canvas_layout: payload.canvasLayout } }
  }, {
    setTimer: scheduler.setTimer.bind(scheduler),
    clearTimer: scheduler.clearTimer.bind(scheduler),
  })

  await assert.rejects(persistence.update({ workflowGroups: [{ id: 'rolled-back' }] }), /503/)
  assert.equal(scheduler.activeCount, 0)
  await persistence.update({ canvasLayout: { x: 9 } }, { allowRetry: true })
  await scheduler.runNext()
  assert.equal(Object.hasOwn(calls.at(-1), 'workflowGroups'), false)
  assert.deepEqual(calls.at(-1).canvasLayout, { x: 9 })
})

test('dispose 清除重试并拒绝后续写入', async () => {
  const scheduler = createScheduler()
  let calls = 0
  const persistence = createCanvasLayoutPersistence(async () => {
    calls += 1
    throw new Error('offline')
  }, {
    setTimer: scheduler.setTimer.bind(scheduler),
    clearTimer: scheduler.clearTimer.bind(scheduler),
  })
  await persistence.update({ canvasLayout: { x: 1 } }, { allowRetry: true })
  persistence.dispose()
  assert.equal(persistence.state, 'disposed')
  assert.equal(scheduler.activeCount, 0)
  await assert.rejects(persistence.update({ canvasLayout: { x: 2 } }, { allowRetry: true }), /disposed/)
  assert.equal(calls, 1)
})
```

- [ ] **步骤 5：运行测试确认红灯**

运行：

```powershell
cd frontweb
node --test test/canvasLayoutPersistence.test.js
```

预期：新增测试 FAIL；首个错误指出 `createCanvasLayoutPersistence` 尚不接受重试选项或没有 `dispose/state`。

- [ ] **步骤 6：Commit 红测**

```powershell
git add frontweb/test/canvasLayoutPersistence.test.js
git commit -m "test(画布): 冻结自动保存重试合同"
```

### 任务 2：实现唯一保存协调器

**文件：**
- 修改：`frontweb/src/utils/canvasLayoutPersistence.js`
- 测试：`frontweb/test/canvasLayoutPersistence.test.js`

- [ ] **步骤 1：用固定状态和退避函数替换现有协调器**

将文件实现为以下职责等价代码；保留命名和返回合同：

```js
import { isTransientHttpError } from './httpError.js'

const DEFAULT_RETRY_DELAYS = [2000, 4000, 8000, 15000]
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key)

export function createCanvasLayoutPersistence(save, options = {}) {
  if (typeof save !== 'function') throw new TypeError('save must be a function')
  const isRetryable = options.isRetryable || isTransientHttpError
  const retryDelays = options.retryDelays || DEFAULT_RETRY_DELAYS
  const savedStateDuration = options.savedStateDuration ?? 2000
  const setTimer = options.setTimer || globalThis.setTimeout
  const clearTimer = options.clearTimer || globalThis.clearTimeout
  const onStateChange = options.onStateChange || (() => {})

  let revision = 0
  let savedRevision = 0
  let latestPayload = {}
  let latestAllowRetry = false
  let running = null
  let retryTimer = null
  let idleTimer = null
  let scheduledDelay = 0
  let retryAttempt = 0
  let lastResult = null
  let state = 'idle'

  const transition = (nextState, details = {}) => {
    state = nextState
    onStateChange({ state: nextState, revision, savedRevision, ...details })
  }
  const retryDelay = () => retryDelays[Math.min(retryAttempt, retryDelays.length - 1)]

  const cancelIdleTimer = () => {
    if (idleTimer) clearTimer(idleTimer)
    idleTimer = null
  }

  function update(payload = {}, { allowRetry = false } = {}) {
    if (state === 'disposed') return Promise.reject(new Error('canvas layout persistence is disposed'))
    cancelIdleTimer()
    latestPayload = {
      ...(hasOwn(payload, 'canvasLayout') ? { canvasLayout: payload.canvasLayout } : {}),
      ...(hasOwn(payload, 'workflowGroups') ? { workflowGroups: payload.workflowGroups } : {}),
    }
    latestAllowRetry = Boolean(allowRetry) && !hasOwn(latestPayload, 'workflowGroups')
    revision += 1
    if (retryTimer) return Promise.resolve({ status: 'queued', revision, delay: scheduledDelay })
    return flush()
  }

  function scheduleRetry(error) {
    const delay = retryDelay()
    scheduledDelay = delay
    retryAttempt += 1
    transition('retry_wait', { error, delay })
    retryTimer = setTimer(async () => {
      retryTimer = null
      scheduledDelay = 0
      try { await flush() } catch { /* state event owns reporting */ }
    }, delay)
    return { status: 'queued', revision, delay }
  }

  function flush() {
    if (state === 'disposed') return Promise.reject(new Error('canvas layout persistence is disposed'))
    if (retryTimer) return Promise.resolve({ status: 'queued', revision, delay: scheduledDelay })
    if (running) return running
    running = (async () => {
      while (savedRevision < revision) {
        const sendingRevision = revision
        const sendingPayload = structuredClone(latestPayload)
        const sendingAllowsRetry = latestAllowRetry
        transition('saving', { sendingRevision })
        try {
          lastResult = await save({ ...sendingPayload, revision: sendingRevision })
        } catch (error) {
          if (sendingAllowsRetry && isRetryable(error) && state !== 'disposed') return scheduleRetry(error)
          transition('error', { error, sendingRevision })
          throw error
        }
        savedRevision = sendingRevision
        retryAttempt = 0
      }
      transition('saved')
      idleTimer = setTimer(() => {
        idleTimer = null
        if (state === 'saved' && savedRevision === revision) transition('idle')
      }, savedStateDuration)
      return { status: 'saved', result: lastResult, revision: savedRevision }
    })().finally(() => { running = null })
    return running
  }

  function dispose() {
    if (retryTimer) clearTimer(retryTimer)
    cancelIdleTimer()
    retryTimer = null
    scheduledDelay = 0
    transition('disposed')
  }

  return {
    update,
    flush,
    dispose,
    get state() { return state },
    get dirty() { return savedRevision < revision },
    get revision() { return revision },
    get savedRevision() { return savedRevision },
  }
}
```

实现时若 Node 当前版本对 `structuredClone` 已有支持，禁止引入新依赖。

- [ ] **步骤 2：运行协调器测试确认绿灯**

运行：

```powershell
cd frontweb
node --test test/canvasLayoutPersistence.test.js
```

预期：全部 PASS；无真实等待、无网络请求。

- [ ] **步骤 3：运行 HTTP 错误分类回归**

运行：

```powershell
cd frontweb
node --test test/httpError.test.js test/requestSilentError.test.js
```

预期：全部 PASS，`401` 和非瞬时错误语义未改变。

- [ ] **步骤 4：Commit 最小协调器实现**

```powershell
git add frontweb/src/utils/canvasLayoutPersistence.js
git commit -m "feat(画布): 增加自动保存退避协调器"
```

### 任务 3：透传静默配置并接入 Vue 状态机

**文件：**
- 修改：`frontweb/src/api/drama.js:32-38`
- 修改：`frontweb/src/views/DramaCanvas.vue:37-39,843-848,7556-7629,7861-7933,8257-8270`
- 修改：`frontweb/test/requestSilentError.test.js`
- 修改：`frontweb/test/standaloneCanvasFreeNodeRuntime.test.js:219-225`

- [ ] **步骤 1：先写 API 与组件源码合同红测**

在 `requestSilentError.test.js` 加入 `drama.js` 源码读取并添加：

```js
test('画布布局保存透传 silentError 且不削弱 401 跳转', () => {
  assert.match(dramaApiSource, /saveCanvasLayout\(id, canvasLayout, workflowGroups, baseUpdatedAt, config = \{\}\)/)
  assert.match(dramaApiSource, /request\.put\(`\/dramas\/\$\{id\}\/canvas-layout`, body, config\)/)
  assert.match(requestSource, /const unauthorized = Number\(error\.response\?\.status\) === 401/)
  assert.match(requestSource, /if \(!unauthorized && !error\.config\?\.silentError\) ElMessage\.error\(msg\)/)
})
```

将 `standaloneCanvasFreeNodeRuntime.test.js` 中旧队列断言替换为：

```js
assert.doesNotMatch(canvasSource, /canvasPersistQueue/)
assert.match(canvasSource, /saveCanvasLayout\([\s\S]*\{ silentError: true \}\)/)
assert.match(canvasSource, /layoutPersistence\.update\([\s\S]*\{ allowRetry: layoutOnly && groupsPayload === undefined \}/)
assert.match(canvasSource, /layoutPersistence\.dispose\(\)/)
assert.match(canvasSource, /layoutSaveState\.value = event\.state/)
assert.match(canvasSource, /event\.state === 'retry_wait'/)
assert.match(canvasSource, /网络暂时不可用，画布将在后台自动重试保存/)
assert.match(canvasSource, /画布已恢复并保存/)
assert.match(canvasSource, /\['saving', 'retry_wait'\]\.includes\(layoutSaveState\.value\)/)
```

- [ ] **步骤 2：运行合同测试确认红灯**

运行：

```powershell
cd frontweb
node --test test/requestSilentError.test.js test/standaloneCanvasFreeNodeRuntime.test.js
```

预期：FAIL，指出 API 没有 `config` 参数、组件仍含 `canvasPersistQueue` 且没有 `retry_wait`。

- [ ] **步骤 3：给 API 增加精确配置透传**

将 `saveCanvasLayout` 改为：

```js
saveCanvasLayout(id, canvasLayout, workflowGroups, baseUpdatedAt, config = {}) {
  const body = {}
  if (canvasLayout != null) body.canvas_layout = canvasLayout
  if (workflowGroups !== undefined) body.workflow_groups = workflowGroups
  if (baseUpdatedAt) body.base_updated_at = baseUpdatedAt
  return request.put(`/dramas/${id}/canvas-layout`, body, config)
},
```

- [ ] **步骤 4：在 Vue 中建立唯一消息所有者和忙碌状态**

在 `layoutSaveState` 附近加入并使用：

```js
const layoutSaveState = ref('idle')
const layoutDirty = ref(false)
const layoutSaveBusy = computed(() => ['saving', 'retry_wait'].includes(layoutSaveState.value))
let layoutOutageOpen = false
let layoutErrorRevision = 0

function onLayoutPersistenceState(event) {
  layoutSaveState.value = event.state
  layoutDirty.value = event.savedRevision < event.revision
  if (event.state === 'retry_wait' && !layoutOutageOpen) {
    layoutOutageOpen = true
    ElMessage.warning('网络暂时不可用，画布将在后台自动重试保存')
  }
  if (event.state === 'saved') {
    if (layoutOutageOpen) ElMessage.success('画布已恢复并保存')
    layoutOutageOpen = false
  }
  if (event.state === 'error' && layoutErrorRevision !== event.revision) {
    layoutErrorRevision = event.revision
    ElMessage.error(event.error?.message || '保存失败')
  }
}

const layoutPersistence = createCanvasLayoutPersistence(
  ({ canvasLayout, workflowGroups }) => dramaAPI.saveCanvasLayout(
    dramaId.value,
    canvasLayout,
    workflowGroups,
    drama.value?.updated_at,
    { silentError: true },
  ),
  { onStateChange: onLayoutPersistenceState },
)
```

模板增加：

```vue
<span v-if="layoutSaveState === 'saving'" class="layout-status saving">保存中…</span>
<span v-else-if="layoutSaveState === 'retry_wait'" class="layout-status retry-wait">连接中断，等待重试…</span>
<span v-else-if="layoutSaveState === 'saved'" class="layout-status saved">已保存</span>
<span v-else-if="layoutSaveState === 'error'" class="layout-status error">保存失败</span>
```

把所有工作流按钮和入口的 `layoutSaveState === 'saving'` 判断改为 `layoutSaveBusy`，禁止显式分组写入插入退避队列。

- [ ] **步骤 5：删除第二条队列并按精确写入意图调用协调器**

删除 `canvasPersistQueue` 和 `persistCanvasStateNow` 包装队列，把 `persistCanvasState` 保留为唯一入口。调用核心改为：

```js
const outcome = await layoutPersistence.update({
  ...(layoutPayload !== null ? { canvasLayout: layoutPayload } : {}),
  ...(groupsPayload !== undefined ? { workflowGroups: groupsPayload } : {}),
}, {
  allowRetry: layoutOnly && groupsPayload === undefined,
})

if (outcome.status === 'queued') return true
const updated = outcome.result
```

成功时沿用现有 metadata、`updated_at`、episodes、characters、scenes、props 的精确合并逻辑；删除组件成功分支对 `layoutSaveState`/`savedHintTimer` 的写入，也删除组件 `catch` 中重复的 `layoutSaveState` 和 `ElMessage.error` 写入。状态（包括 2 秒后从 `saved` 回到 `idle`）只由协调器推进；非瞬时错误由 `onLayoutPersistenceState` 提示一次，调用方仍收到 `false` 并执行现有分组回滚。

- [ ] **步骤 6：卸载时销毁协调器**

删除仅服务于布局已保存提示的 `savedHintTimer` 变量及清理；在 `onBeforeUnmount` 的其他本地定时器清理后加入：

```js
layoutPersistence.dispose()
```

不得在销毁后再次调用 `persistCanvasState`，不得为标签页关闭新增网络请求。

- [ ] **步骤 7：运行合同和协调器测试确认绿灯**

运行：

```powershell
cd frontweb
node --test test/canvasLayoutPersistence.test.js test/requestSilentError.test.js test/standaloneCanvasFreeNodeRuntime.test.js
```

预期：全部 PASS；源码中不再出现 `canvasPersistQueue`。

- [ ] **步骤 8：Commit API 与组件接入**

```powershell
git add frontweb/src/api/drama.js frontweb/src/views/DramaCanvas.vue frontweb/test/requestSilentError.test.js frontweb/test/standaloneCanvasFreeNodeRuntime.test.js
git commit -m "fix(画布): 接入单写入容灾与消息去重"
```

### 任务 4：加入零付费浏览器恢复回归

**文件：**
- 修改：`frontweb/e2e/project-canvas-ci.spec.js:43-219`（路由状态）
- 修改：`frontweb/e2e/project-canvas-ci.spec.js:285-350`（持久化测试附近）

- [ ] **步骤 1：给现有本地路由替身增加可控故障状态**

文件级状态加入：

```js
let canvasSaveFailuresRemaining = 0
let canvasSaveRequests = []
```

`beforeEach` 重置为 `0` 和 `[]`。在 canvas-layout 路由顶部加入：

```js
const payload = request.postDataJSON() || {}
canvasSaveRequests.push(structuredClone(payload))
if (canvasSaveFailuresRemaining > 0) {
  canvasSaveFailuresRemaining -= 1
  await route.fulfill({
    status: 503,
    contentType: 'application/json',
    body: JSON.stringify({ success: false, message: 'temporary canvas outage' }),
  })
  return
}
```

随后保留现有成功写入逻辑，避免另建第二套路由。

- [ ] **步骤 2：编写一次故障、最新布局恢复和消息去重浏览器测试**

加入：

```js
test('项目画布在一次 503 后只提示一次并自动保存最新拖拽位置', async ({ page }) => {
  await page.goto('/film/3/canvas')

  const node = page.locator('.vue-flow__node[data-id="sb:1001"]')
  const pane = page.locator('.vue-flow__pane')
  await expect(node).toBeVisible()
  canvasSaveRequests = []
  canvasSaveFailuresRemaining = 1
  await node.dragTo(pane, {
    sourcePosition: { x: 18, y: 18 },
    targetPosition: { x: 900, y: 520 },
  })
  await expect(page.getByText('连接中断，等待重试…', { exact: true })).toBeVisible()
  await expect(page.locator('.el-message__content').filter({
    hasText: '网络暂时不可用，画布将在后台自动重试保存',
  })).toHaveCount(1)

  await node.dragTo(pane, {
    sourcePosition: { x: 18, y: 18 },
    targetPosition: { x: 1120, y: 680 },
  })
  await expect.poll(() => canvasSaveRequests.length, { timeout: 5000 }).toBe(2)
  await expect.poll(() => savedCanvasLayout?.nodes?.['sb:1001']).toEqual(expect.objectContaining({
    x: expect.any(Number),
    y: expect.any(Number),
  }))
  expect(canvasSaveRequests[1].canvas_layout.nodes['sb:1001']).toEqual(savedCanvasLayout.nodes['sb:1001'])
  await expect(page.locator('.el-message__content').filter({ hasText: '画布已恢复并保存' })).toHaveCount(1)

  await page.reload()
  await expect(page.locator('.vue-flow__node[data-id="sb:1001"]')).toBeVisible()
  expect(canvasSaveRequests.length).toBe(2)
})
```

该测试只能路由本地 `/api/v1/**` 替身；若 Network 出现图片、视频、文本生成 POST，测试必须失败。

- [ ] **步骤 3：运行新增浏览器测试确认通过**

运行：

```powershell
cd frontweb
npx playwright test e2e/project-canvas-ci.spec.js --grep "一次 503 后"
```

预期：`1 passed`；PUT 次数严格为 2，失败通知与恢复通知各 1 条。

- [ ] **步骤 4：运行完整项目画布回归**

运行：

```powershell
cd frontweb
npx playwright test e2e/project-canvas-ci.spec.js
```

预期：该文件全部 PASS；现有节点拖拽、连线、工作流回读不回归。

- [ ] **步骤 5：Commit 浏览器证据**

```powershell
git add frontweb/e2e/project-canvas-ci.spec.js
git commit -m "test(画布): 覆盖自动保存故障恢复"
```

### 任务 5：全量业务门禁与独立 PR 准备

**文件：**
- 不新增实现文件
- 审核：本计划列出的 7 个业务文件

- [ ] **步骤 1：运行所有相关 Node 回归**

```powershell
cd frontweb
node --test test/canvasLayoutPersistence.test.js test/httpError.test.js test/requestSilentError.test.js test/standaloneCanvasFreeNodeRuntime.test.js
```

预期：全部 PASS，无跳过、无未处理拒绝。

- [ ] **步骤 2：构建前端**

```powershell
cd frontweb
npm run build
```

预期：exit code 0，Vite 构建成功；不得修改后端或生产配置。

- [ ] **步骤 3：运行画布零付费浏览器回归**

```powershell
cd frontweb
npm run test:e2e:canvas
```

预期：全部 PASS；所有 API 均为测试替身或本地集成，不提交供应商生成。

- [ ] **步骤 4：审计精准范围与保护合同**

```powershell
git diff origin/main --name-only
git diff --check origin/main
rg -n "canvas-credit-callout-v1|本次预计扣除|积分待管理员配置" frontweb/src backend-node/src
```

预期：diff 只包含本计划文件；`git diff --check` 无输出；积分卡片保护文字仍存在。

- [ ] **步骤 5：提交验收记录**

在计划末尾追加实际执行命令、通过数量、构建结果与零付费声明，然后提交：

```powershell
git add docs/superpowers/plans/2026-08-24-canvas-autosave-resilience.md
git commit -m "docs(画布): 记录自动保存容灾验收"
```

预期：本地分支 clean，尚未 push、未创建生产候选、未部署。

## 规格覆盖检查

| 规格要求 | 实现任务 |
| --- | --- |
| 单写入、最新 revision、单请求/单定时器 | 任务 1、2 |
| 2/4/8/15/15 秒退避与成功复位 | 任务 1、2 |
| 仅无响应和 502/503/504 自动重试 | 任务 1、2 |
| 工作流分组失败回滚且不后台重放 | 任务 1、3 |
| silentError 只去除全局弹窗、401 保留 | 任务 3 |
| 一次故障/恢复消息及顶部状态 | 任务 3、4 |
| 卸载清理，不在关闭后保存 | 任务 1、3 |
| 刷新回读、无并发 PUT、无请求风暴 | 任务 4 |
| 不触碰生成、积分、供应商和后端合同 | 任务 4、5 |

## 执行边界

完成任务 1-5 只表示业务分支具备创建独立 PR 的证据。推送、PR、合入、生产候选制作与激活均需分别取得明确授权；生产候选必须从操作时实时 `/opt/moli-drama/current` 克隆并通过共享受保护门禁。
