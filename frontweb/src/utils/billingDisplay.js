export function normalizeCreditAccount(account = {}) {
  const value = (field) => Number.isSafeInteger(account[field]) && account[field] >= 0 ? account[field] : 0
  return { available: value('available'), held: value('held'), spent: value('spent') }
}

export function formatModelPrice(item = {}) {
  const unit = item.billing_unit === 'second' ? '秒' : '次'
  if (item.credits == null) return `尚未定价（按${unit}），当前禁止生成`
  const tiers = item.resolution_prices || {}
  if (item.category === 'video' && tiers['480p']?.credits && tiers['720p']?.credits) {
    return `480P ${tiers['480p'].credits} 积分/${unit} · 720P ${tiers['720p'].credits} 积分/${unit}`
  }
  return `当前 ${item.credits} 积分/${unit}`
}
