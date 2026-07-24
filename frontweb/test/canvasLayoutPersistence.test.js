import test from 'node:test'
import assert from 'node:assert/strict'
import { createCanvasLayoutPersistence } from '../src/utils/canvasLayoutPersistence.js'

test('唯一保存协调器将交错布局和导演状态合并到后续快照', async () => {
  const calls = []
  let releaseFirst
  const gate = new Promise((resolve) => { releaseFirst = resolve })
  const persistence = createCanvasLayoutPersistence(async (payload) => {
    calls.push(structuredClone(payload))
    if (calls.length === 1) await gate
    return payload
  })

  const first = persistence.update({ canvasLayout: { nodes: { a: { x: 1, y: 2 } } } })
  persistence.update({
    canvasLayout: { nodes: { a: { x: 1, y: 2 } }, director_timeline: { version: 2 } },
    workflowGroups: [{ id: 'g1' }],
  })
  releaseFirst()
  await first
  await persistence.flush()

  assert.equal(calls.length, 2)
  assert.deepEqual(calls[1].canvasLayout.director_timeline, { version: 2 })
  assert.deepEqual(calls[1].workflowGroups, [{ id: 'g1' }])
  assert.equal(persistence.dirty, false)
})

test('保存失败保持 dirty 并允许 flush 重试', async () => {
  let attempts = 0
  const persistence = createCanvasLayoutPersistence(async (payload) => {
    attempts += 1
    if (attempts === 1) throw new Error('offline')
    return payload
  })
  await assert.rejects(persistence.update({ canvasLayout: { version: 1 } }), /offline/)
  assert.equal(persistence.dirty, true)
  await persistence.flush()
  assert.equal(attempts, 2)
  assert.equal(persistence.dirty, false)
})
