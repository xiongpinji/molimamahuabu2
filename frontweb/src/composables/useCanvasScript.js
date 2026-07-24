import { ref } from 'vue'
import { ElMessage } from 'element-plus'
import { dramaAPI } from '@/api/drama'
import { generationAPI } from '@/api/generation'
import { propAPI } from '@/api/props'
import { taskAPI } from '@/api/task'
import { getDramaGenerationOptions } from '@/utils/canvasWorkflow'
import { CANVAS_NODE_STATUS_LABELS } from '@/composables/useCanvasNodeStatus'

async function pollTask(taskId, onTick, maxAttempts = 450, interval = 2000) {
  if (!taskId) return { status: 'completed' }
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, interval))
    onTick?.()
    try {
      const t = await taskAPI.get(taskId)
      if (t.status === 'completed') return { status: 'completed', result: t.result }
      if (t.status === 'failed') {
        return { status: 'failed', error: t.error?.message || t.error || '任务失败' }
      }
    } catch (e) {
      if (i === maxAttempts - 1) return { status: 'failed', error: e.message || '轮询失败' }
    }
  }
  return { status: 'timeout', error: '任务超时' }
}

export function scriptNodeId(episodeId) {
  return `script:${episodeId}`
}

function buildEpisodesPayload(drama, episodeId, patch) {
  return (drama?.episodes || []).map((ep, i) => {
    const base = {
      episode_number: ep.episode_number ?? i + 1,
      title: ep.title || `第${ep.episode_number ?? i + 1}集`,
      script_content: ep.script_content || '',
      description: ep.description ?? null,
      duration: ep.duration ?? 0,
    }
    if (Number(ep.id) === Number(episodeId)) {
      return { ...base, ...patch }
    }
    return base
  })
}

function episodeScriptContent(drama, episodeId) {
  const ep = (drama?.episodes || []).find((item) => Number(item?.id) === Number(episodeId))
  return ep?.script_content || ''
}

function firstExtractResultNodeId(drama, step) {
  if (step === 'extract_chars') return drama?.characters?.[0]?.id ? `char:${drama.characters[0].id}` : ''
  if (step === 'extract_scenes') return drama?.scenes?.[0]?.id ? `scene:${drama.scenes[0].id}` : ''
  if (step === 'extract_props') return drama?.props?.[0]?.id ? `prop:${drama.props[0].id}` : ''
  if (step !== 'extract_all') return ''
  return firstExtractResultNodeId(drama, 'extract_chars')
    || firstExtractResultNodeId(drama, 'extract_scenes')
    || firstExtractResultNodeId(drama, 'extract_props')
}

function entityIdSet(items = []) {
  return new Set((items || []).map((item) => Number(item?.id)).filter(Number.isFinite))
}

function extractEntitySnapshot(drama) {
  return {
    characters: entityIdSet(drama?.characters),
    scenes: entityIdSet(drama?.scenes),
    props: entityIdSet(drama?.props),
  }
}

function entityExtractConfig(afterDrama, before, step) {
  return {
    extract_chars: { items: afterDrama?.characters || [], beforeIds: before?.characters, prefix: 'char', label: '角色' },
    extract_scenes: { items: afterDrama?.scenes || [], beforeIds: before?.scenes, prefix: 'scene', label: '场景' },
    extract_props: { items: afterDrama?.props || [], beforeIds: before?.props, prefix: 'prop', label: '道具' },
  }[step]
}

function entityDisplayName(item, label) {
  return item?.name || item?.title || item?.description || `${label}${item?.id || ''}`
}

function newExtractEntities(before, afterDrama, step) {
  const steps = step === 'extract_all' ? ['extract_chars', 'extract_scenes', 'extract_props'] : [step]
  return steps.flatMap((itemStep) => {
    const config = entityExtractConfig(afterDrama, before, itemStep)
    if (!config) return []
    return config.items
      .filter((item) => !config.beforeIds?.has(Number(item?.id)))
      .map((item) => ({
        id: item.id,
        nodeId: item?.id ? `${config.prefix}:${item.id}` : '',
        label: config.label,
        name: entityDisplayName(item, config.label),
      }))
      .filter((item) => item.id)
  })
}

function firstNewEntityNodeId(before, afterDrama, step) {
  const added = newExtractEntities(before, afterDrama, step).find((item) => item.nodeId)
  return added?.nodeId || ''
}

function extractResultMeta(before, afterDrama, step) {
  const added = newExtractEntities(before, afterDrama, step)
  if (!added.length) return {}
  const names = added.slice(0, 4).map((item) => `${item.label}:${item.name}`)
  return {
    resultSummary: `新增 ${added.length} 个实体：${names.join('、')}${added.length > 4 ? ' 等' : ''}`,
    resultReferences: added.map((item) => `@${item.label}(${item.name}#${item.id})`),
  }
}

/** 画布：剧本编辑 + 从剧本提取角色/场景/道具 */
export function useCanvasScript(deps) {
  const { drama, dramaId, refreshCanvas, nodeStatus } = deps
  const scriptBusy = ref(false)

  function setScriptBusy(episodeId, step, message) {
    nodeStatus?.set(scriptNodeId(episodeId), { step, message })
  }

  function clearScriptBusy(episodeId) {
    nodeStatus?.clear(scriptNodeId(episodeId))
  }

  function keepOrClearScriptStatus(episodeId) {
    const current = nodeStatus?.get?.(scriptNodeId(episodeId))
    if (!['failed', 'success'].includes(current?.step)) clearScriptBusy(episodeId)
  }

  function failScriptStatus(episodeId, step, error) {
    const message = error?.message || '脚本任务失败'
    nodeStatus?.fail(scriptNodeId(episodeId), {
      message,
      errorDetail: message,
      retryStep: step,
      retryLabel: `重试${CANVAS_NODE_STATUS_LABELS[step] || '脚本任务'}`,
      recoverable: true,
    })
  }

  function successScriptStatus(episodeId, step, message, scriptContent = '', resultNodeId = '', resultMeta = {}) {
    nodeStatus?.success(scriptNodeId(episodeId), {
      message,
      resultType: 'text',
      resultLabel: message,
      resultNodeId: resultNodeId || firstExtractResultNodeId(drama.value, step),
      resultSummary: resultMeta.resultSummary || '',
      resultReferences: resultMeta.resultReferences || [],
      promptText: scriptContent || '',
      retryStep: step,
      retryLabel: `重试${CANVAS_NODE_STATUS_LABELS[step] || '脚本任务'}`,
      autoClear: false,
    })
  }

  async function runExtractTask(taskId, label) {
    if (!taskId) {
      await refreshCanvas(true)
      return
    }
    const polled = await pollTask(taskId, () => refreshCanvas(true))
    if (polled.status !== 'completed') {
      throw new Error(polled.error || `${label}失败`)
    }
    await refreshCanvas(true)
  }

  async function saveScript(episodeId, { scriptContent, title }) {
    const did = dramaId.value
    const d = drama.value
    if (!did || !d || !episodeId) throw new Error('缺少项目或集数')

    scriptBusy.value = true
    setScriptBusy(episodeId, 'save_script', CANVAS_NODE_STATUS_LABELS.save_script)
    try {
      const payload = buildEpisodesPayload(d, episodeId, {
        script_content: (scriptContent || '').trim(),
        title: (title || '').trim() || undefined,
      })
      await dramaAPI.saveEpisodes(did, payload)
      await refreshCanvas(true)
      successScriptStatus(episodeId, 'save_script', '剧本已保存', scriptContent)
      ElMessage.success('剧本已保存')
    } catch (e) {
      failScriptStatus(episodeId, 'save_script', e)
      throw e
    } finally {
      scriptBusy.value = false
      keepOrClearScriptStatus(episodeId)
    }
  }

  async function _extractCharacters(episodeId, scriptContent) {
    const did = dramaId.value
    const outline = (scriptContent || '').trim() || undefined
    const res = await generationAPI.generateCharacters(did, {
      episode_id: episodeId,
      outline,
    })
    await runExtractTask(res?.task_id, '提取角色')
  }

  async function _extractScenes(episodeId) {
    const style = getDramaGenerationOptions(drama.value).style || undefined
    const res = await dramaAPI.extractBackgrounds(episodeId, {
      model: undefined,
      style,
      language: 'zh',
    })
    await runExtractTask(res?.task_id, '提取场景')
  }

  async function _extractProps(episodeId) {
    const res = await propAPI.extractFromScript(episodeId)
    await runExtractTask(res?.task_id, '提取道具')
  }

  async function extractCharacters(episodeId, scriptContent) {
    if (!dramaId.value || !episodeId) throw new Error('请先选择集数')
    scriptBusy.value = true
    setScriptBusy(episodeId, 'extract_chars', CANVAS_NODE_STATUS_LABELS.extract_chars)
    try {
      const before = extractEntitySnapshot(drama.value)
      await _extractCharacters(episodeId, scriptContent)
      const resultMeta = extractResultMeta(before, drama.value, 'extract_chars')
      successScriptStatus(episodeId, 'extract_chars', '角色提取完成', scriptContent, firstNewEntityNodeId(before, drama.value, 'extract_chars'), resultMeta)
      ElMessage.success('角色提取完成')
    } catch (e) {
      failScriptStatus(episodeId, 'extract_chars', e)
      throw e
    } finally {
      scriptBusy.value = false
      keepOrClearScriptStatus(episodeId)
    }
  }

  async function extractScenes(episodeId) {
    if (!episodeId) throw new Error('请先选择集数')
    scriptBusy.value = true
    setScriptBusy(episodeId, 'extract_scenes', CANVAS_NODE_STATUS_LABELS.extract_scenes)
    try {
      const before = extractEntitySnapshot(drama.value)
      await _extractScenes(episodeId)
      const resultMeta = extractResultMeta(before, drama.value, 'extract_scenes')
      successScriptStatus(episodeId, 'extract_scenes', '场景提取完成', episodeScriptContent(drama.value, episodeId), firstNewEntityNodeId(before, drama.value, 'extract_scenes'), resultMeta)
      ElMessage.success('场景提取完成')
    } catch (e) {
      failScriptStatus(episodeId, 'extract_scenes', e)
      throw e
    } finally {
      scriptBusy.value = false
      keepOrClearScriptStatus(episodeId)
    }
  }

  async function extractProps(episodeId) {
    if (!episodeId) throw new Error('请先选择集数')
    scriptBusy.value = true
    setScriptBusy(episodeId, 'extract_props', CANVAS_NODE_STATUS_LABELS.extract_props)
    try {
      const before = extractEntitySnapshot(drama.value)
      await _extractProps(episodeId)
      const resultMeta = extractResultMeta(before, drama.value, 'extract_props')
      successScriptStatus(episodeId, 'extract_props', '道具提取完成', episodeScriptContent(drama.value, episodeId), firstNewEntityNodeId(before, drama.value, 'extract_props'), resultMeta)
      ElMessage.success('道具提取完成')
    } catch (e) {
      failScriptStatus(episodeId, 'extract_props', e)
      throw e
    } finally {
      scriptBusy.value = false
      keepOrClearScriptStatus(episodeId)
    }
  }

  async function extractAll(episodeId, scriptContent) {
    if (!episodeId) throw new Error('请先选择集数')
    const content = (scriptContent || '').trim()
    if (!content) throw new Error('请先填写剧本内容')

    scriptBusy.value = true
    let didWork = false
    const before = extractEntitySnapshot(drama.value)
    try {
      if ((drama.value?.characters || []).length === 0) {
        setScriptBusy(episodeId, 'extract_chars', '1/3 提取角色…')
        await _extractCharacters(episodeId, content)
        didWork = true
      }
      if ((drama.value?.scenes || []).length === 0) {
        setScriptBusy(episodeId, 'extract_scenes', '2/3 提取场景…')
        await _extractScenes(episodeId)
        didWork = true
      }
      if ((drama.value?.props || []).length === 0) {
        setScriptBusy(episodeId, 'extract_props', '3/3 提取道具…')
        await _extractProps(episodeId)
        didWork = true
      }

      if (!didWork) {
        successScriptStatus(episodeId, 'extract_all', '角色、场景、道具均已存在', content)
        ElMessage.info('角色、场景、道具均已存在，无需重复提取')
      } else {
        const resultMeta = extractResultMeta(before, drama.value, 'extract_all')
        successScriptStatus(episodeId, 'extract_all', '一键提取完成', content, firstNewEntityNodeId(before, drama.value, 'extract_all'), resultMeta)
        ElMessage.success(
          `提取完成：${(drama.value?.characters || []).length} 角色 · ${(drama.value?.scenes || []).length} 场景 · ${(drama.value?.props || []).length} 道具`
        )
      }
    } catch (e) {
      failScriptStatus(episodeId, 'extract_all', e)
      ElMessage.error(e?.message || '提取失败')
      throw e
    } finally {
      scriptBusy.value = false
      keepOrClearScriptStatus(episodeId)
    }
  }

  return {
    scriptBusy,
    saveScript,
    extractCharacters,
    extractScenes,
    extractProps,
    extractAll,
  }
}
