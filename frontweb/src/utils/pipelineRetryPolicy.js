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
