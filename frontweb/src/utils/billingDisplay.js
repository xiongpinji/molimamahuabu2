export function normalizeCreditAccount(account = {}) {
  const value = (field) => Number.isSafeInteger(account[field]) && account[field] >= 0 ? account[field] : 0
  return { available: value('available'), held: value('held'), spent: value('spent') }
}

export function formatModelPrice(item = {}) {
  const unit = item.billing_unit === 'second' ? '秒' : '次'
  if (item.credits == null) return `尚未定价（按${unit}），当前禁止生成`
  return `当前 ${item.credits} 积分/${unit}`
}
