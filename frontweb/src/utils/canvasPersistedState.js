export {
  DEFAULT_CANVAS_PREFERENCES,
  normalizeCanvasPreferences,
} from './canvasSettings.js'

const HISTORY_LIMIT = 100
const HISTORY_FIELDS = [
  'key',
  'nodeId',
  'resultNodeId',
  'resultType',
  'resultLabel',
  'resultSummary',
  'promptText',
  'storyboardId',
  'model',
  'taskId',
  'videoGenerationId',
  'resultUrl',
  'savedAssetId',
  'savedAssetName',
  'savedAssetUrl',
  'savedAssetLocalPath',
  'retryStep',
  'errorDetail',
  'actionError',
  'attachedSlot',
]

function normalizeHistoryItem(item) {
  if (!item || !['success', 'failed'].includes(item.tone)) return null
  const at = Number(item.at)
  if (!Number.isFinite(at)) return null
  const normalized = {
    tone: item.tone,
    at,
    message: String(item.message || ''),
    statusIds: Array.isArray(item.statusIds) ? item.statusIds.map(String) : [],
    resultReferences: Array.isArray(item.resultReferences) ? item.resultReferences : [],
    requestPayload: item.requestPayload ?? null,
    requestAudit: item.requestAudit ?? null,
    savedAssetDuration: item.savedAssetDuration ?? null,
    persisted: true,
  }
  for (const field of HISTORY_FIELDS) {
    if (item[field] !== undefined && item[field] !== null) normalized[field] = item[field]
  }
  normalized.key = String(normalized.key || `${normalized.nodeId || 'node'}:${at}:${item.tone}`)
  return normalized
}

export function normalizeGenerationHistory(value, limit = HISTORY_LIMIT) {
  const deduped = new Map()
  for (const raw of Array.isArray(value) ? value : []) {
    const item = normalizeHistoryItem(raw)
    if (!item) continue
    const identity = item.taskId
      ? `task:${item.taskId}`
      : `${item.key}:${item.at}:${item.tone}`
    if (!deduped.has(identity)) deduped.set(identity, item)
  }
  return [...deduped.values()]
    .sort((a, b) => b.at - a.at)
    .slice(0, Math.max(0, Number(limit) || HISTORY_LIMIT))
}

export function mergeGenerationHistory(history, terminalItems, limit = HISTORY_LIMIT) {
  return normalizeGenerationHistory([
    ...(Array.isArray(terminalItems) ? terminalItems : []),
    ...(Array.isArray(history) ? history : []),
  ], limit)
}
