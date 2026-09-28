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
