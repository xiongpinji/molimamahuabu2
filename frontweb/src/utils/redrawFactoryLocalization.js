// 完全转绘（目标国家本地化后导入短剧工厂）的前端状态辅助：只做纯函数，页面组件负责请求与轮询。

// 默认选中分析时设定的语言 + 国家；分析只设了语言（没有国家）时选该语言的第一个候选国家。
export function defaultLocalizationTarget(targets, defaultLocale, defaultMarket) {
  const rows = Array.isArray(targets) ? targets : []
  const locale = String(defaultLocale || '').trim()
  const market = String(defaultMarket || '').trim().toUpperCase()
  const exact = rows.find((item) => item.locale === locale && item.market === market)
  if (exact) return exact.key
  const sameLanguage = rows.find((item) => item.locale === locale)
  return sameLanguage?.key || rows[0]?.key || ''
}

export function localizationActionLabel(state) {
  const status = String(state?.status || '')
  if (status === 'ready') return '导入目标国家版本'
  if (status === 'localizing') return '转绘中…'
  if (status === 'failed') return '重新生成并导入'
  return '生成并导入'
}

export function localizationStatusText(state, label = '') {
  const status = String(state?.status || '')
  const target = label || state?.label || '目标国家'
  if (status === 'ready') return `${target}版本已生成，导入不再扣积分。`
  if (status === 'localizing') return `正在生成${target}的名字、形象与台词，通常 1~3 分钟。`
  if (status === 'failed') return `上次生成失败，积分已退回：${state?.error || '未知原因'}`
  if (status === 'none') return `将把人物名字、人物形象、台词、场景和道具全部换成${target}的，再导入短剧工厂。`
  return ''
}

export function localizationBody(targets, key, action, extra = {}) {
  const target = (Array.isArray(targets) ? targets : []).find((item) => item.key === key)
  if (!target) return null
  return { action, localization: { locale: target.locale, market: target.market }, ...extra }
}

// 整部剧：同一转绘项目按同一目标国家导入过的短剧工厂项目，本集可以追加进去作为下一集。
// 默认追加到最近一个还没有本集的项目；都已含本集（例如本集就是第 1 集）时默认新建。
export function defaultSeriesTarget(targets) {
  const rows = Array.isArray(targets) ? targets : []
  return rows.find((item) => item && !item.this_work_episode)?.drama_id || 0
}

// 标题后带项目编号：同一部剧按同一国家导入过多次时标题相同，靠编号区分。
function seriesTitle(item) {
  const title = String(item?.title || '').trim()
  return title ? `《${title}》（#${item?.drama_id}）` : `项目 #${item?.drama_id}`
}

export function seriesTargetLabel(item) {
  if (item?.this_work_episode) return `${seriesTitle(item)}（本集已是第 ${item.this_work_episode} 集）`
  return `追加到${seriesTitle(item)}作为第 ${(Number(item?.episodes) || 0) + 1} 集`
}

// 整部导入：已含第 1 集的同目标工厂项目优先（集数多的在前），没有就新建（返回 0）。
export function seriesImportTarget(plan) {
  const first = (Array.isArray(plan?.episodes) ? plan.episodes : [])[0]
  if (!first) return 0
  const rows = (Array.isArray(plan?.series_targets) ? plan.series_targets : [])
    .filter((item) => item?.work_episodes?.[String(first.work_id)])
    .sort((a, b) => (Number(b.episodes) || 0) - (Number(a.episodes) || 0))
  return Number(rows[0]?.drama_id) || 0
}

function presentEpisodes(plan, targetDramaId) {
  const target = (Array.isArray(plan?.series_targets) ? plan.series_targets : [])
    .find((item) => Number(item?.drama_id) === Number(targetDramaId))
  return target?.work_episodes || {}
}

// 整部导入要处理的集：目标项目里还没有的各集，按集号；needs_localization 表示要新生成（扣积分）。
export function seriesImportSteps(plan, targetDramaId = 0) {
  const present = presentEpisodes(plan, targetDramaId)
  return (Array.isArray(plan?.episodes) ? plan.episodes : [])
    .filter((item) => !present[String(item.work_id)])
    .map((item) => ({
      work_id: item.work_id,
      episode: item.episode,
      analysis_ready: item.analysis_ready !== false,
      needs_localization: ['none', 'failed'].includes(String(item.status || '')),
      credits: Number(item.credits) || 0,
    }))
}

// 整部导入必须按集号逐集锁定和追加：有没分析的集，或要补的集排在项目里已有的集之前，都不能开始。
export function seriesImportBlocker(plan, targetDramaId, steps) {
  const rows = Array.isArray(steps) ? steps : []
  const unanalyzed = rows.find((item) => !item.analysis_ready)
  if (unanalyzed) return `第 ${unanalyzed.episode} 集还没完成样片分析，请先分析这一集再整部导入`
  const present = presentEpisodes(plan, targetDramaId)
  const lastPresent = Math.max(0, ...(Array.isArray(plan?.episodes) ? plan.episodes : [])
    .filter((item) => present[String(item.work_id)]).map((item) => Number(item.episode) || 0))
  const early = rows.find((item) => Number(item.episode) < lastPresent)
  if (early) return `第 ${early.episode} 集排在项目里已有的第 ${lastPresent} 集之前，不能按顺序追加`
  return ''
}

export function seriesImportCredits(steps) {
  return (Array.isArray(steps) ? steps : [])
    .filter((item) => item.needs_localization)
    .reduce((sum, item) => sum + (Number(item.credits) || 0), 0)
}

export function seriesImportSummary(plan, targetDramaId, steps, label = '') {
  const rows = Array.isArray(steps) ? steps : []
  const total = Array.isArray(plan?.episodes) ? plan.episodes.length : 0
  const target = (Array.isArray(plan?.series_targets) ? plan.series_targets : [])
    .find((item) => Number(item?.drama_id) === Number(targetDramaId))
  const where = target ? `追加到${seriesTitle(target)}` : '新建一个短剧工厂项目'
  const fresh = rows.filter((item) => item.needs_localization).length
  return [
    `按集号把第 ${rows.map((item) => item.episode).join('、')} 集转绘为${label || '目标国家'}版本，${where}（全剧共 ${total} 集）。`,
    fresh ? `需新生成 ${fresh} 集，本次预计扣除 ${seriesImportCredits(rows)} 积分；已生成的集导入不扣积分。` : '各集都已生成，导入不扣积分。',
    '处理期间请不要关闭页面；中途关闭后再点一次，会从没完成的那一集继续。',
  ].join('')
}

export function seriesProgressText(step, index, total, phase) {
  const head = `整部导入 ${index + 1}/${total}：第 ${step?.episode} 集`
  if (phase === 'localizing') return `${head}正在转绘，通常 1~3 分钟…`
  if (phase === 'importing') return `${head}正在导入短剧工厂…`
  return head
}

export function seriesLockText(state) {
  const names = Array.isArray(state?.series_lock?.characters) ? state.series_lock.characters.filter(Boolean) : []
  return names.length ? `沿用前几集的角色：${names.join('、')}（名字、形象不变）。` : ''
}

export function importSuccessMessage(result, label = '') {
  if (result?.appended) {
    const reused = Array.isArray(result.reused_character_names) ? result.reused_character_names.filter(Boolean) : []
    const fresh = Array.isArray(result.new_character_names) ? result.new_character_names.filter(Boolean) : []
    const parts = [`已追加为第 ${result.episode_number} 集`]
    if (reused.length) parts.push(`沿用角色 ${reused.join('、')}`)
    if (fresh.length) parts.push(`新角色 ${fresh.join('、')}`)
    return parts.join('，')
  }
  if (result?.created === false) {
    return result?.episode_number ? `本集已是该项目第 ${result.episode_number} 集，打开短剧工厂项目` : '已导入过，打开现有短剧工厂项目'
  }
  return `已按${label || '目标国家'}导入短剧工厂`
}
