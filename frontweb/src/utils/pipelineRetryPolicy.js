import { isIndeterminateGenerationError } from './generationRetryGuard.js'

export function decidePipelineRetry(errorMessage, attempt, maxAttempts) {
  if (isIndeterminateGenerationError(errorMessage)) {
    return { retry: false, pause: true }
  }
  return { retry: attempt < maxAttempts - 1, pause: false }
}
