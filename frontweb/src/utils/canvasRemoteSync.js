/**
 * 多端画布对齐决策：远端 revision 更高时，空闲端自动拉取，本地有未保存改动则提示。
 */
export function readCanvasRevision(value) {
  const revision = Number(value)
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : null
}

/** 本端是否处于不可自动覆盖的交互/保存态（用户实测门禁合同） */
export function isCanvasSyncBlockedByLocalActivity({
  dirty = false,
  savePending = false,
  saving = false,
  interacting = false,
  generating = false,
} = {}) {
  return Boolean(dirty || savePending || saving || interacting || generating)
}

export function decideCanvasRemoteSync({
  localRevision,
  remoteRevision,
  localDirty = false,
  saving = false,
  syncInFlight = false,
  promptOpen = false,
  acknowledgedRemoteRevision = -1,
} = {}) {
  if (syncInFlight || saving || promptOpen) return { action: 'skip' }

  const local = readCanvasRevision(localRevision)
  const remote = readCanvasRevision(remoteRevision)
  if (local == null || remote == null) return { action: 'skip' }
  if (remote <= local) return { action: 'noop' }

  if (localDirty) {
    if (acknowledgedRemoteRevision >= remote) return { action: 'skip' }
    return { action: 'prompt', remoteRevision: remote }
  }

  return { action: 'apply', remoteRevision: remote }
}
