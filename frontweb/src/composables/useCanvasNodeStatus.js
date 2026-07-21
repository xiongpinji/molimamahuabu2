import { reactive } from 'vue'

/** 画布节点操作状态（生图/生视频/生成参考图等） */
export function createCanvasNodeStatusStore() {
  const map = reactive({})
  const clearTimers = new Map()

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
    map[nodeId] = {
      step: payload.step || 'busy',
      message: payload.message || '处理中…',
      detail: payload.detail || '',
      taskId: payload.taskId || payload.task_id || '',
      progress: payload.progress ?? null,
      resultUrl: payload.resultUrl || payload.result_url || '',
      resultType: payload.resultType || payload.result_type || '',
      resultLabel: payload.resultLabel || payload.result_label || '',
      at: Date.now(),
    }
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

  return { map, set, fail, success, clear, get, isBusy }
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
