# 画布图片预览空格拖动实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在画布图片全屏预览放大超过 100% 后，支持按住空格并用鼠标左键拖动图片，同时不移动底层画布。

**架构：** 先把已在生产使用但尚未进入 `origin/main` 的滚轮缩放提交作为明确基线，再在 `HomeCanvasNode.vue` 内增加最小的预览位移和 Pointer Events 状态。用现有 Node 源码合同测试覆盖事件与清理，用 Playwright 覆盖真实键盘、滚轮、拖动和底层画布不动的交互链路。

**技术栈：** Vue 3 Composition API、Pointer Events、Vue Flow、Node Test Runner、Playwright、Vite

---

## 文件结构

- 修改：`frontweb/src/components/dramaCanvas/HomeCanvasNode.vue`——图片预览缩放、空格状态、位移、指针捕获和视觉反馈。
- 修改：`frontweb/test/canvasStabilityStage3.test.js`——空格拖动比例门禁、事件绑定和生命周期清理的源码合同。
- 修改：`frontweb/e2e/home-canvas.spec.js`——真实浏览器中的 100% 禁止拖动、放大后拖动、释放停止和底层画布不动。
- 保留：`docs/tasks/2026-08-08-h3-catalog-image-preview-zoom.md`——从既有缩放提交带入的历史任务说明，不在本任务改写。

### 任务 1：对齐现有图片滚轮缩放基线

**文件：**
- 修改（既有提交）：`frontweb/src/components/dramaCanvas/HomeCanvasNode.vue`
- 修改（既有提交）：`frontweb/test/canvasStabilityStage3.test.js`
- 创建（既有提交）：`docs/tasks/2026-08-08-h3-catalog-image-preview-zoom.md`

- [ ] **步骤 1：确认工作树干净且当前分支正确**

运行：

```powershell
git status --short --branch
git branch --show-current
```

预期：分支为 `codex/canvas-image-space-pan-20260809`，除本计划文档提交外没有未提交改动。

- [ ] **步骤 2：引入已验证的滚轮缩放提交**

运行：

```powershell
git cherry-pick 7af5ad7e
```

预期：生成 `fix: 支持画布图片预览滚轮缩放` 提交，只带入上述三个文件的既有变更。

- [ ] **步骤 3：验证缩放基线测试**

运行：

```powershell
Set-Location frontweb
node --test test/canvasStabilityStage3.test.js
```

预期：6 个测试通过、0 个失败；新增用例确认图片预览绑定 `@wheel`、只响应 `Ctrl/⌘`、缩放范围为 25%–500%，关闭时重置为 100%。

### 任务 2：先写空格拖动失败测试

**文件：**
- 修改：`frontweb/test/canvasStabilityStage3.test.js`
- 修改：`frontweb/e2e/home-canvas.spec.js`

- [ ] **步骤 1：增加源码合同失败测试**

在 `frontweb/test/canvasStabilityStage3.test.js` 的图片预览测试后加入：

```js
test('图片预览仅在放大后支持空格拖动并完整清理事件', () => {
  assert.match(nodeSource, /const mediaPreviewCanPan = computed/)
  assert.match(nodeSource, /mediaPreviewScale\.value > 1/)
  assert.match(nodeSource, /@pointerdown\.stop="onMediaPreviewPointerDown"/)
  assert.match(nodeSource, /@pointermove\.stop="onMediaPreviewPointerMove"/)
  assert.match(nodeSource, /setPointerCapture\?\.\(event\.pointerId\)/)
  assert.match(nodeSource, /if \(mediaPreviewScale\.value <= 1\) resetMediaPreviewPan\(\)/)
  assert.match(nodeSource, /window\.addEventListener\('keyup', onMediaPreviewKeyup\)/)
  assert.match(nodeSource, /window\.removeEventListener\('keyup', onMediaPreviewKeyup\)/)
  assert.match(nodeSource, /window\.addEventListener\('blur', onMediaPreviewBlur\)/)
  assert.match(nodeSource, /window\.removeEventListener\('blur', onMediaPreviewBlur\)/)
})
```

- [ ] **步骤 2：运行源码合同并确认红灯**

运行：

```powershell
node --test test/canvasStabilityStage3.test.js
```

预期：FAIL，首个失败信息匹配 `const mediaPreviewCanPan = computed` 不存在；既有测试仍通过。

- [ ] **步骤 3：增加真实浏览器失败测试**

在 `frontweb/e2e/home-canvas.spec.js` 的“生成结果数组中的图片可被 @ 引用并支持双击全屏预览”用例后加入：

```js
test('图片预览只在放大后允许空格拖动且不移动底层画布', async ({ page }) => {
  await loadHomeCanvasState(page, generatedMentionHomeCanvasState)

  const imageNode = page.locator('.vue-flow__node[data-id="e2e:image-reference"]')
  await imageNode.locator('.node-media').dblclick()

  const dialog = page.getByRole('dialog', { name: '图片全屏预览' })
  const previewImage = dialog.locator('img')
  const canvasViewport = page.locator('.vue-flow__viewport')
  await expect(dialog).toBeVisible()

  const dragFromCenter = async (deltaX, deltaY) => {
    const box = await previewImage.boundingBox()
    if (!box) throw new Error('图片预览未生成可拖动区域')
    const centerX = box.x + box.width / 2
    const centerY = box.y + box.height / 2
    await page.mouse.move(centerX, centerY)
    await page.mouse.down()
    await page.mouse.move(centerX + deltaX, centerY + deltaY, { steps: 4 })
  }

  const initialImageStyle = await previewImage.getAttribute('style')
  await page.keyboard.down('Space')
  await dragFromCenter(60, 35)
  await page.mouse.up()
  await page.keyboard.up('Space')
  await expect(previewImage).toHaveAttribute('style', initialImageStyle || '')

  const canvasStyleBeforePan = await canvasViewport.getAttribute('style')
  const previewBox = await previewImage.boundingBox()
  if (!previewBox) throw new Error('图片预览未生成缩放区域')
  await page.mouse.move(previewBox.x + previewBox.width / 2, previewBox.y + previewBox.height / 2)
  await page.keyboard.down('Control')
  await page.mouse.wheel(0, -100)
  await page.keyboard.up('Control')
  await expect.poll(() => previewImage.getAttribute('style')).toContain('scale(1.15)')

  await page.keyboard.down('Space')
  await dragFromCenter(80, 45)
  const draggedStyle = await previewImage.getAttribute('style')
  expect(draggedStyle).toContain('translate(80px, 45px)')

  await page.keyboard.up('Space')
  const boxAfterRelease = await previewImage.boundingBox()
  if (!boxAfterRelease) throw new Error('图片预览在释放空格后消失')
  await page.mouse.move(boxAfterRelease.x + boxAfterRelease.width / 2 + 40, boxAfterRelease.y + boxAfterRelease.height / 2 + 20)
  await expect(previewImage).toHaveAttribute('style', draggedStyle || '')
  await page.mouse.up()

  await expect(canvasViewport).toHaveAttribute('style', canvasStyleBeforePan || '')
})
```

- [ ] **步骤 4：运行浏览器用例并确认红灯**

运行：

```powershell
$env:PLAYWRIGHT_REUSE_SERVER='0'
npx playwright test e2e/home-canvas.spec.js -g "图片预览只在放大后"
```

预期：FAIL；缩放达到 `1.15` 后，图片样式仍没有 `translate(80px, 45px)`。

### 任务 3：实现最小空格拖动交互

**文件：**
- 修改：`frontweb/src/components/dramaCanvas/HomeCanvasNode.vue`
- 测试：`frontweb/test/canvasStabilityStage3.test.js`
- 测试：`frontweb/e2e/home-canvas.spec.js`

- [ ] **步骤 1：扩展预览模板**

将图片预览容器和图片元素调整为：

```vue
<div
  v-if="mediaPreviewUrl"
  class="image-lightbox nodrag nopan"
  role="dialog"
  aria-modal="true"
  :aria-label="mediaPreviewKind === 'image' ? '图片全屏预览' : '视频全屏预览'"
  :class="{ 'is-pan-ready': mediaPreviewCanPan, 'is-panning': mediaPreviewDragging }"
  @click.self="closeMediaPreview"
  @wheel="onMediaPreviewWheel"
>
  <button
    type="button"
    :aria-label="mediaPreviewKind === 'image' ? '关闭图片预览' : '关闭视频预览'"
    title="关闭"
    @click="closeMediaPreview"
  >×</button>
  <span v-if="mediaPreviewKind === 'image'" class="lightbox-zoom-hint">
    Ctrl/⌘ + 滚轮缩放 · 放大后按住空格 + 左键拖动 · {{ Math.round(mediaPreviewScale * 100) }}%
  </span>
  <img
    v-if="mediaPreviewKind === 'image'"
    :src="mediaPreviewUrl"
    :alt="data.title || '图片预览'"
    draggable="false"
    :style="{ transform: `translate(${mediaPreviewPan.x}px, ${mediaPreviewPan.y}px) scale(${mediaPreviewScale})` }"
    @pointerdown.stop="onMediaPreviewPointerDown"
    @pointermove.stop="onMediaPreviewPointerMove"
    @pointerup.stop="onMediaPreviewPointerUp"
    @pointercancel.stop="onMediaPreviewPointerUp"
  />
  <video v-else :src="mediaPreviewUrl" controls autoplay playsinline />
</div>
```

- [ ] **步骤 2：增加预览状态和比例门禁**

在现有 `mediaPreviewScale` 状态附近加入：

```js
const mediaPreviewPan = reactive({ x: 0, y: 0 })
const mediaPreviewSpacePressed = ref(false)
const mediaPreviewDragging = ref(false)
const mediaPreviewCanPan = computed(() => (
  mediaPreviewKind.value === 'image'
  && mediaPreviewScale.value > 1
  && mediaPreviewSpacePressed.value
))
let mediaPreviewDragStart = null
let mediaPreviewPointerId = null
```

- [ ] **步骤 3：实现拖动、停止和复位函数**

在 `closeMediaPreview` 和 `onMediaPreviewWheel` 附近实现：

```js
function stopMediaPreviewDrag() {
  mediaPreviewDragging.value = false
  mediaPreviewDragStart = null
  mediaPreviewPointerId = null
}

function resetMediaPreviewPan() {
  mediaPreviewPan.x = 0
  mediaPreviewPan.y = 0
  stopMediaPreviewDrag()
}

function resetMediaPreviewInteraction() {
  resetMediaPreviewPan()
  mediaPreviewSpacePressed.value = false
}

function onMediaPreviewPointerDown(event) {
  if (event.button !== 0 || !mediaPreviewCanPan.value) return
  event.preventDefault()
  event.currentTarget.setPointerCapture?.(event.pointerId)
  mediaPreviewDragging.value = true
  mediaPreviewPointerId = event.pointerId
  mediaPreviewDragStart = {
    clientX: event.clientX,
    clientY: event.clientY,
    x: mediaPreviewPan.x,
    y: mediaPreviewPan.y,
  }
}

function onMediaPreviewPointerMove(event) {
  if (!mediaPreviewDragging.value || mediaPreviewPointerId !== event.pointerId || !mediaPreviewDragStart) return
  event.preventDefault()
  mediaPreviewPan.x = mediaPreviewDragStart.x + event.clientX - mediaPreviewDragStart.clientX
  mediaPreviewPan.y = mediaPreviewDragStart.y + event.clientY - mediaPreviewDragStart.clientY
}

function onMediaPreviewPointerUp(event) {
  if (mediaPreviewPointerId != null && event.pointerId !== mediaPreviewPointerId) return
  stopMediaPreviewDrag()
}

function onMediaPreviewKeyup(event) {
  if (event.code !== 'Space') return
  mediaPreviewSpacePressed.value = false
  stopMediaPreviewDrag()
}

function onMediaPreviewBlur() {
  mediaPreviewSpacePressed.value = false
  stopMediaPreviewDrag()
}
```

- [ ] **步骤 4：接入打开、关闭、滚轮和键盘生命周期**

对现有函数做以下精确调整：

```js
function openMediaPreview(url, kind = 'image') {
  if (mediaOpenTimer) {
    window.clearTimeout(mediaOpenTimer)
    mediaOpenTimer = null
  }
  if (!url) return
  openEditor()
  mediaPreviewScale.value = 1
  resetMediaPreviewInteraction()
  mediaPreviewUrl.value = String(url)
  mediaPreviewKind.value = kind
}

function closeMediaPreview() {
  mediaPreviewUrl.value = ''
  mediaPreviewScale.value = 1
  resetMediaPreviewInteraction()
  mediaPreviewKind.value = 'image'
}

function onMediaPreviewWheel(event) {
  if (mediaPreviewKind.value !== 'image') return
  if (!event.ctrlKey && !event.metaKey) return
  event.preventDefault()
  event.stopPropagation()
  const delta = event.deltaY < 0 ? 0.15 : -0.15
  mediaPreviewScale.value = Math.min(5, Math.max(0.25,
    Number((mediaPreviewScale.value + delta).toFixed(2))))
  if (mediaPreviewScale.value <= 1) resetMediaPreviewPan()
}

function onEditorKeydown(event) {
  if (mediaPreviewUrl.value && mediaPreviewKind.value === 'image' && event.code === 'Space') {
    event.preventDefault()
    mediaPreviewSpacePressed.value = true
    return
  }
  if (event.key !== 'Escape') return
  if (mediaOpenTimer) {
    window.clearTimeout(mediaOpenTimer)
    mediaOpenTimer = null
    event.preventDefault()
  }
  if (mediaPreviewUrl.value) {
    event.preventDefault()
    closeMediaPreview()
    return
  }
  if (!isSelected.value || editorHidden.value) return
  event.preventDefault()
  if (editorFullscreen.value) editorFullscreen.value = false
  else closeEditor()
}
```

在生命周期中加入并对称移除事件：

```js
onMounted(() => {
  window.addEventListener('keydown', onEditorKeydown)
  window.addEventListener('keyup', onMediaPreviewKeyup)
  window.addEventListener('blur', onMediaPreviewBlur)
  window.addEventListener('resize', updateEditorPosition)
  if (isSelected.value) nextTick(startEditorPositionTracking)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onEditorKeydown)
  window.removeEventListener('keyup', onMediaPreviewKeyup)
  window.removeEventListener('blur', onMediaPreviewBlur)
  window.removeEventListener('resize', updateEditorPosition)
  stopEditorPositionTracking()
  resetMediaPreviewInteraction()
  if (draftSaveTimer) window.clearTimeout(draftSaveTimer)
  if (mediaOpenTimer) window.clearTimeout(mediaOpenTimer)
})
```

- [ ] **步骤 5：增加抓手视觉反馈**

在图片预览样式中加入：

```css
.image-lightbox > img { transform-origin: center; transition: transform 100ms ease-out; }
.image-lightbox.is-pan-ready > img { cursor: grab; }
.image-lightbox.is-panning > img { cursor: grabbing; transition: none; }
```

- [ ] **步骤 6：运行源码合同确认绿灯**

运行：

```powershell
node --test test/canvasStabilityStage3.test.js
```

预期：7 个测试通过、0 个失败。

- [ ] **步骤 7：运行定向浏览器用例确认绿灯**

运行：

```powershell
$env:PLAYWRIGHT_REUSE_SERVER='0'
npx playwright test e2e/home-canvas.spec.js -g "图片预览只在放大后"
```

预期：1 个测试通过、0 个失败；图片位移变为 `translate(80px, 45px)`，底层 `.vue-flow__viewport` 样式保持不变。

- [ ] **步骤 8：提交测试和实现**

运行：

```powershell
git add frontweb/src/components/dramaCanvas/HomeCanvasNode.vue frontweb/test/canvasStabilityStage3.test.js frontweb/e2e/home-canvas.spec.js
git diff --cached --check
git commit -m "fix: 支持画布图片空格拖动"
```

预期：提交成功，且只包含上述三个文件。

### 任务 4：回归验证和变更审计

**文件：**
- 验证：`frontweb/src/components/dramaCanvas/HomeCanvasNode.vue`
- 验证：`frontweb/test/canvasStabilityStage3.test.js`
- 验证：`frontweb/e2e/home-canvas.spec.js`

- [ ] **步骤 1：运行完整画布稳定性测试**

运行：

```powershell
Set-Location frontweb
node --test test/canvasStabilityStage3.test.js test/standaloneCanvasFreeNodeRuntime.test.js test/imageNodeToolbar.test.js
```

预期：全部测试通过、0 个失败。

- [ ] **步骤 2：运行相关图片预览浏览器回归**

运行：

```powershell
$env:PLAYWRIGHT_REUSE_SERVER='0'
npx playwright test e2e/home-canvas.spec.js -g "图片.*预览"
```

预期：空格拖动用例和既有双击全屏预览用例全部通过。

- [ ] **步骤 3：运行前端生产构建**

运行：

```powershell
npm run build
```

预期：Vite 构建退出码为 0，不出现编译错误。

- [ ] **步骤 4：审计精确变更范围**

运行：

```powershell
Set-Location ..
git status --short --branch
git diff --check origin/main...HEAD
git diff --stat origin/main...HEAD
git log --oneline origin/main..HEAD
```

预期：工作树干净；提交链只包含设计、计划、既有缩放和空格拖动；没有后端、数据库、支付、视频或部署文件变更。

- [ ] **步骤 5：检查与其他画布会话的合并冲突**

运行：

```powershell
git fetch origin main
$mergeBase = git merge-base HEAD origin/main
git merge-tree $mergeBase HEAD origin/main
```

预期：`HomeCanvasNode.vue`、测试文件无冲突标记。若远端已经包含同类功能，停止合并并先做语义对比，不覆盖新实现。

## 完成边界

- 本计划结束于本地实现、测试、构建和冲突审计。
- 推送、创建 PR、合并和生产部署均需要用户后续明确授权。
- 生产部署前必须重新读取实时 `/opt/moli-drama/current`，从最新线上 release 构建候选，并通过共享受保护发布门禁。
