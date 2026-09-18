import { unref } from 'vue'
import { decideCanvasRemoteSync, readCanvasRevision } from '@/utils/canvasRemoteSync'
import { useIntervalPoll } from '@/composables/useIntervalPoll'

/**
 * 轮询远端 canvas_state_revision，在本端空闲时自动对齐。
 *
 * @param {object} options
 * @param {() => number|string|null|undefined} options.getDramaId
 * @param {() => number} options.getLocalRevision
 * @param {() => boolean} options.isLocalDirty
 * @param {() => boolean} [options.isSaving]
 * @param {() => boolean} [options.isEnabled]
 * @param {(dramaId: number|string) => Promise<{ canvas_state_revision?: number }|null|undefined>} options.fetchRemoteRevision
 * @param {() => Promise<void>|void} options.applyRemote
 * @param {(remoteRevision: number) => Promise<boolean>|boolean} [options.confirmDiscardLocal]
 * @param {number} [options.intervalMs]
 * @param {() => boolean} [options.isDocumentVisible]
 */
export function useCanvasRemoteSync({
  getDramaId,
  getLocalRevision,
  isLocalDirty,
  isSaving = () => false,
  isEnabled = () => true,
  fetchRemoteRevision,
  applyRemote,
  confirmDiscardLocal = async () => false,
  intervalMs = 3000,
  isDocumentVisible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
} = {}) {
  let syncInFlight = false
  let promptOpen = false
  let acknowledgedRemoteRevision = -1

  const poll = useIntervalPoll(async () => {
    if (!isEnabled() || !isDocumentVisible()) return
    const dramaId = getDramaId()
    if (dramaId == null || dramaId === '') return

    let remotePayload
    try {
      remotePayload = await fetchRemoteRevision(dramaId)
    } catch (_) {
      return
    }

    const decision = decideCanvasRemoteSync({
      localRevision: getLocalRevision(),
      remoteRevision: remotePayload?.canvas_state_revision,
      localDirty: Boolean(isLocalDirty()),
      saving: Boolean(isSaving()),
      syncInFlight,
      promptOpen,
      acknowledgedRemoteRevision,
    })

    if (decision.action === 'noop' || decision.action === 'skip') return

    if (decision.action === 'apply') {
      syncInFlight = true
      try {
        await applyRemote()
        acknowledgedRemoteRevision = decision.remoteRevision
      } finally {
        syncInFlight = false
      }
      return
    }

    if (decision.action === 'prompt') {
      promptOpen = true
      try {
        const accepted = await confirmDiscardLocal(decision.remoteRevision)
        acknowledgedRemoteRevision = decision.remoteRevision
        if (!accepted) return
        syncInFlight = true
        try {
          await applyRemote()
        } finally {
          syncInFlight = false
        }
      } finally {
        promptOpen = false
      }
    }
  }, intervalMs)

  function start() {
    poll.start()
  }

  function stop() {
    poll.stop()
  }

  function resetAck() {
    acknowledgedRemoteRevision = -1
  }

  return {
    start,
    stop,
    tick: poll.tick,
    isActive: poll.isActive,
    resetAck,
    readCanvasRevision,
  }
}

/** 便于在非 Vue 场景复用 visible 判断 */
export function resolveCanvasRemoteSyncEnabled(value) {
  return Boolean(unref(value))
}
