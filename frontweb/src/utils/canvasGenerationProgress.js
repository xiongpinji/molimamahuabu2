export function normalizeGenerationProgress(value) {
  if (value === null || value === undefined || value === '') return null
  const progress = Number(value)
  if (!Number.isFinite(progress)) return null
  return Math.min(100, Math.max(0, Math.round(progress)))
}

export function calculateBatchGenerationProgress(completedCount, totalCount, currentProgress) {
  const normalizedCurrent = normalizeGenerationProgress(currentProgress)
  if (normalizedCurrent === null) return null
  const total = Math.max(1, Number(totalCount) || 1)
  const completed = Math.min(total, Math.max(0, Number(completedCount) || 0))
  return normalizeGenerationProgress(((completed + (normalizedCurrent / 100)) / total) * 100)
}
