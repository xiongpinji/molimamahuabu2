import { isIndeterminateGenerationError } from './generationRetryGuard.js'

export function decidePipelineRetry(errorMessage, attempt, maxAttempts) {
  if (isIndeterminateGenerationError(errorMessage)) {
    return { retry: false, pause: true }
  }
  return { retry: attempt < maxAttempts - 1, pause: false }
}

export function shouldStopBatchOnGenerationResult(resultOrError) {
  if (!resultOrError) return false
  if (isIndeterminateGenerationError(resultOrError)) return true
  if (isIndeterminateGenerationError(resultOrError.error)) return true
  return isIndeterminateGenerationError(resultOrError.message)
}

export async function runConcurrentItems(items, concurrency, fn, options = {}) {
  let index = 0
  let anyPaused = false

  async function worker() {
    while (!anyPaused && index < items.length) {
      const i = index++
      const item = items[i]
      options.onStart?.(item, i)
      try {
        const result = await fn(item, i)
        if (result && typeof result === 'object' && result.paused) {
          anyPaused = true
          return
        }
      } finally {
        options.onFinish?.(item, i)
      }
    }
  }

  const workerCount = Math.min(Math.max(1, Number(concurrency) || 1), items.length)
  await Promise.allSettled(Array.from({ length: workerCount }, () => worker()))
  return { paused: anyPaused }
}

export async function submitPreparedGenerationUnlessStopped({ isStopped, prepare, submit }) {
  if (isStopped()) return { stopped: true }
  const prepared = await prepare()
  if (isStopped()) return { stopped: true }
  return { stopped: false, result: await submit(prepared) }
}
