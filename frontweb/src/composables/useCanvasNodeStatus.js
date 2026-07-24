import { reactive } from 'vue'

/** 画布节点操作状态（生图/生视频/生成参考图等） */
export function createCanvasNodeStatusStore() {
  const map = reactive({})
  const clearTimers = new Map()

  function assignIfDefined(target, key, value) {
    if (value !== undefined && value !== null && value !== '') target[key] = value
  }

  function normalizePayload(payload) {
    const upstreamReferenceUrls = Array.isArray(payload.upstreamReferenceUrls || payload.upstream_reference_urls)
      ? [...new Set((payload.upstreamReferenceUrls || payload.upstream_reference_urls)
        .map((url) => String(url || '').trim())
        .filter(Boolean))]
      : []
    const resultReferences = Array.isArray(payload.resultReferences || payload.result_references)
      ? [...new Set((payload.resultReferences || payload.result_references)
        .map((reference) => String(reference || '').trim())
        .filter(Boolean))]
      : []
    const status = {
      step: payload.step || 'busy',
      message: payload.message || '处理中…',
      detail: payload.detail || '',
      taskId: payload.taskId || payload.task_id || '',
      progress: payload.progress ?? null,
      resultUrl: payload.resultUrl || payload.result_url || '',
      resultNodeId: payload.resultNodeId || payload.result_node_id || '',
      resultType: payload.resultType || payload.result_type || '',
      resultLabel: payload.resultLabel || payload.result_label || '',
      resultSummary: payload.resultSummary || payload.result_summary || '',
      savedAssetId: payload.savedAssetId || payload.saved_asset_id || '',
      savedAssetName: payload.savedAssetName || payload.saved_asset_name || '',
      savedAssetUrl: payload.savedAssetUrl || payload.saved_asset_url || '',
      savedAssetLocalPath: payload.savedAssetLocalPath || payload.saved_asset_local_path || '',
      savedAssetDuration: payload.savedAssetDuration ?? payload.saved_asset_duration ?? null,
      promptText: payload.promptText || payload.prompt_text || '',
      errorDetail: payload.errorDetail || payload.error_detail || '',
      nextStep: payload.nextStep || payload.next_step || '',
      nextLabel: payload.nextLabel || payload.next_label || '',
      retryStep: payload.retryStep || payload.retry_step || '',
      retryLabel: payload.retryLabel || payload.retry_label || '',
      actionError: payload.actionError || payload.action_error || '',
      retryAction: payload.retryAction || payload.retry_action || '',
      retryActionLabel: payload.retryActionLabel || payload.retry_action_label || '',
      at: Number.isFinite(Number(payload.at)) ? Number(payload.at) : Date.now(),
    }
    if (upstreamReferenceUrls.length) status.upstreamReferenceUrls = upstreamReferenceUrls
    if (resultReferences.length) status.resultReferences = resultReferences
    assignIfDefined(status, 'workflowId', payload.workflowId || payload.workflow_id)
    assignIfDefined(status, 'runKey', payload.runKey || payload.run_key)
    assignIfDefined(status, 'sourceNodeId', payload.sourceNodeId || payload.source_node_id)
    assignIfDefined(status, 'queueLabel', payload.queueLabel || payload.queue_label)
    assignIfDefined(status, 'storyboardId', payload.storyboardId || payload.storyboard_id)
    assignIfDefined(status, 'dramaId', payload.dramaId || payload.drama_id)
    assignIfDefined(status, 'model', payload.model)
    assignIfDefined(status, 'videoGenerationId', payload.videoGenerationId || payload.video_generation_id)
    assignIfDefined(status, 'requestPayload', payload.requestPayload || payload.request_payload)
    assignIfDefined(status, 'requestAudit', payload.requestAudit || payload.request_audit)
    assignIfDefined(status, 'attachedSlot', payload.attachedSlot || payload.attached_slot)
    assignIfDefined(status, 'attachedToStoryboardId', payload.attachedToStoryboardId || payload.attached_to_storyboard_id)
    assignIfDefined(status, 'libraryAsset', payload.libraryAsset || payload.library_asset)
    assignIfDefined(status, 'stepIndex', payload.stepIndex ?? payload.step_index)
    assignIfDefined(status, 'stepTotal', payload.stepTotal ?? payload.step_total)
    assignIfDefined(status, 'recoverable', payload.recoverable)
    assignIfDefined(status, 'restored', payload.restored)
    assignIfDefined(status, 'stale', payload.stale)
    return status
  }

  function set(nodeId, payload) {
    if (!nodeId) return
    if (clearTimers.has(nodeId)) {
      clearTimeout(clearTimers.get(nodeId))
      clearTimers.delete(nodeId)
    }
    if (!payload) {
      delete map[nodeId]
      return
    }
    map[nodeId] = normalizePayload(payload)
  }

  function fail(nodeId, payload = {}) {
    set(nodeId, {
      ...payload,
      step: 'failed',
      message: payload.message || '节点执行失败',
    })
  }

  function success(nodeId, payload = {}) {
    set(nodeId, {
      ...payload,
      step: 'success',
      message: payload.message || '节点执行完成',
    })
    if (payload.autoClear !== false) {
      clearTimers.set(nodeId, setTimeout(() => {
        delete map[nodeId]
        clearTimers.delete(nodeId)
      }, payload.autoClearMs || 8000))
    }
  }

  function clear(nodeId) {
    if (clearTimers.has(nodeId)) {
      clearTimeout(clearTimers.get(nodeId))
      clearTimers.delete(nodeId)
    }
    if (nodeId) delete map[nodeId]
  }

  function get(nodeId) {
    return nodeId ? map[nodeId] || null : null
  }

  function isBusy(nodeId) {
    const status = get(nodeId)
    return !!status && !['failed', 'success'].includes(status.step)
  }

  function isTerminalStep(step) {
    return ['failed', 'success'].includes(step)
  }

  function snapshot() {
    return Object.fromEntries(Object.entries(map).map(([nodeId, status]) => [nodeId, { ...status }]))
  }

  function restore(snapshotMap = {}, options = {}) {
    const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now()
    const staleMs = Number.isFinite(Number(options.staleMs)) ? Number(options.staleMs) : 30 * 60 * 1000
    for (const timer of clearTimers.values()) clearTimeout(timer)
    clearTimers.clear()
    for (const nodeId of Object.keys(map)) delete map[nodeId]
    for (const [nodeId, status] of Object.entries(snapshotMap || {})) {
      if (!nodeId || !status?.step) continue
      const normalized = normalizePayload({ ...status, restored: true })
      const age = now - normalized.at
      if (!isTerminalStep(normalized.step) && age > staleMs) {
        const retryStep = normalized.retryStep || normalized.step
        map[nodeId] = normalizePayload({
          ...normalized,
          step: 'failed',
          message: '节点任务已中断，可重试',
          errorDetail: normalized.errorDetail || '页面刷新或任务超时导致运行状态中断，请点击重试继续。',
          retryStep,
          retryLabel: normalized.retryLabel || `重试${CANVAS_NODE_STATUS_LABELS[retryStep] || '节点'}`,
          recoverable: true,
          restored: true,
          stale: true,
        })
        continue
      }
      map[nodeId] = normalized
    }
  }

  return { map, set, fail, success, clear, get, isBusy, snapshot, restore }
}

export const CANVAS_NODE_STATUS_LABELS = {
  image: '生图中',
  video: '生视频中',
  audio: '配音中',
  polish: '润色中',
  save: '保存中',
  ref_image: '生成参考图',
  generate_sb: 'AI 生成分镜',
  save_script: '保存剧本',
  extract_chars: '提取角色',
  extract_scenes: '提取场景',
  extract_props: '提取道具',
  extract_all: '一键提取',
  library: '引用素材库',
  workflow: '工作流执行',
  panorama: '生成全景图',
  multi_view: '生成多视图',
  upload: '上传中',
  failed: '执行失败',
  success: '执行完成',
}
