import test from 'node:test'
import assert from 'node:assert/strict'
import {
  decideCanvasRemoteSync,
  isCanvasSyncBlockedByLocalActivity,
  readCanvasRevision,
} from '../src/utils/canvasRemoteSync.js'

test('readCanvasRevision 只接受非负整数', () => {
  assert.equal(readCanvasRevision(0), 0)
  assert.equal(readCanvasRevision(3), 3)
  assert.equal(readCanvasRevision('4'), 4)
  assert.equal(readCanvasRevision(-1), null)
  assert.equal(readCanvasRevision('x'), null)
  assert.equal(readCanvasRevision(undefined), null)
})

test('远端不高于本地时 noop', () => {
  assert.deepEqual(
    decideCanvasRemoteSync({ localRevision: 5, remoteRevision: 5 }),
    { action: 'noop' },
  )
  assert.deepEqual(
    decideCanvasRemoteSync({ localRevision: 5, remoteRevision: 4 }),
    { action: 'noop' },
  )
})

test('本地空闲且远端更新时自动 apply', () => {
  assert.deepEqual(
    decideCanvasRemoteSync({ localRevision: 2, remoteRevision: 5, localDirty: false }),
    { action: 'apply', remoteRevision: 5 },
  )
})

test('本地有未保存改动时改为 prompt，且同一远端 revision 不重复提示', () => {
  assert.deepEqual(
    decideCanvasRemoteSync({
      localRevision: 2,
      remoteRevision: 5,
      localDirty: true,
    }),
    { action: 'prompt', remoteRevision: 5 },
  )
  assert.deepEqual(
    decideCanvasRemoteSync({
      localRevision: 2,
      remoteRevision: 5,
      localDirty: true,
      acknowledgedRemoteRevision: 5,
    }),
    { action: 'skip' },
  )
})

test('拖拽/生成等本端活动视为阻塞自动覆盖', () => {
  assert.equal(
    isCanvasSyncBlockedByLocalActivity({ interacting: true }),
    true,
  )
  assert.equal(
    isCanvasSyncBlockedByLocalActivity({ generating: true }),
    true,
  )
  assert.equal(
    isCanvasSyncBlockedByLocalActivity({ dirty: false, interacting: false, generating: false }),
    false,
  )
  assert.deepEqual(
    decideCanvasRemoteSync({
      localRevision: 1,
      remoteRevision: 2,
      localDirty: isCanvasSyncBlockedByLocalActivity({ interacting: true }),
    }),
    { action: 'prompt', remoteRevision: 2 },
  )
})
