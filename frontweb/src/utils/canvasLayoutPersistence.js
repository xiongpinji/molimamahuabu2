import { isTransientHttpError } from './httpError.js'

const DISPOSED_ERROR = 'canvas layout persistence disposed'

function snapshotPayload(payload) {
  return JSON.parse(JSON.stringify(payload ?? {}))
}

function savedResult(result, revision) {
  const fields = result !== null && typeof result === 'object' ? result : {}
  return { ...fields, status: 'saved', result, revision }
}

export function createCanvasLayoutPersistence(save, {
  isRetryable = isTransientHttpError,
  retryDelays = [2000, 4000, 8000, 15000],
  savedStateDuration = 2000,
  setTimer = globalThis.setTimeout,
  clearTimer = globalThis.clearTimeout,
  onStateChange = () => {},
} = {}) {
  if (typeof save !== 'function') throw new TypeError('save must be a function')

  let state = 'idle'
  let revision = 0
  let savedRevision = 0
  let running = null
  let latest = null
  let lastResult = null
  let retryAttempt = 0
  let timer = null
  let timerKind = null
  let scheduledDelay = null

  function transition(nextState, details = {}) {
    if (state === nextState) return
    state = nextState
    onStateChange({ state, revision, savedRevision, ...details })
  }

  function cancelTimer(kind) {
    if (timer === null || (kind && timerKind !== kind)) return
    clearTimer(timer)
    timer = null
    timerKind = null
    scheduledDelay = null
  }

  function queuedResult() {
    return {
      status: 'queued',
      revision,
      delay: scheduledDelay,
      attempt: retryAttempt,
    }
  }

  function scheduleIdle() {
    if (state === 'disposed') return
    cancelTimer()
    timerKind = 'idle'
    timer = setTimer(() => {
      timer = null
      timerKind = null
      if (state === 'saved' && savedRevision === revision) transition('idle')
    }, savedStateDuration)
  }

  function scheduleRetry(error, sendingRevision) {
    const delay = retryDelays[Math.min(retryAttempt, retryDelays.length - 1)]
    retryAttempt += 1
    cancelTimer()
    scheduledDelay = delay
    transition('retry_wait', { error, delay, attempt: retryAttempt, sendingRevision })
    timerKind = 'retry'
    timer = setTimer(() => {
      timer = null
      timerKind = null
      scheduledDelay = null
      return flush().catch(() => {})
    }, delay)
    return queuedResult()
  }

  function update(payload = {}, { allowRetry = false } = {}) {
    if (state === 'disposed') return Promise.reject(new Error(DISPOSED_ERROR))
    const hasWorkflowGroups = Object.hasOwn(payload ?? {}, 'workflowGroups')
    if (state === 'retry_wait' && timerKind === 'retry' && hasWorkflowGroups) {
      return Promise.reject(new Error('workflowGroups cannot be updated while layout retry is pending'))
    }
    cancelTimer('idle')

    let snapshot
    try {
      snapshot = snapshotPayload(payload)
    } catch (error) {
      return Promise.reject(error)
    }

    revision += 1
    latest = {
      payload: snapshot,
      revision,
      allowRetry: Boolean(allowRetry),
      hasWorkflowGroups,
    }

    if (state === 'retry_wait' && timerKind === 'retry') {
      return Promise.resolve(queuedResult())
    }
    return flush()
  }

  function flush() {
    if (state === 'disposed') return Promise.reject(new Error(DISPOSED_ERROR))
    if (running) return running
    if (state === 'retry_wait' && timerKind === 'retry') {
      return Promise.resolve(queuedResult())
    }
    if (savedRevision >= revision) {
      return Promise.resolve(savedResult(lastResult, savedRevision))
    }

    const run = (async () => {
      while (savedRevision < revision) {
        const sending = latest
        const sendingRevision = sending.revision
        transition('saving', { sendingRevision })

        try {
          const result = await save({ ...sending.payload, revision: sendingRevision })
          if (state === 'disposed') {
            return { status: 'disposed', revision: sendingRevision }
          }
          lastResult = result
          savedRevision = sendingRevision
          retryAttempt = 0
        } catch (error) {
          if (state === 'disposed') throw error
          const latestAllowsRetry = latest.allowRetry && !latest.hasWorkflowGroups
          if (
            sending.allowRetry
            && !sending.hasWorkflowGroups
            && latestAllowsRetry
            && isRetryable(error)
          ) {
            return scheduleRetry(error, sendingRevision)
          }
          transition('error', { error, sendingRevision })
          throw error
        }
      }

      transition('saved', { result: lastResult })
      scheduleIdle()
      return savedResult(lastResult, savedRevision)
    })()

    running = run
    run.then(
      () => { if (running === run) running = null },
      () => { if (running === run) running = null },
    )
    return run
  }

  function dispose() {
    if (state === 'disposed') return
    cancelTimer()
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
