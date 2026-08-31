export function normalizeCreditAccount(account = {}) {
  const value = (field) => Number.isSafeInteger(account[field]) && account[field] >= 0 ? account[field] : 0
  const date = (field) => {
    const raw = typeof account[field] === 'string' ? account[field].trim() : ''
    return raw && Number.isFinite(new Date(raw).getTime()) ? raw : null
  }
  return {
    available: value('available'),
    held: value('held'),
    spent: value('spent'),
    permanentAvailable: value('permanent_available'),
    dailyBonusAvailable: value('daily_bonus_available'),
    dailyBonusExpiresAt: date('daily_bonus_expires_at'),
    membershipEndsOn: date('membership_ends_on'),
  }
}

export function formatModelPrice(item = {}) {
  const unit = item.billing_unit === 'second' ? '秒' : '次'
  if (item.credits == null) return `尚未定价（按${unit}），当前禁止生成`
  const tiers = item.resolution_prices || {}
  if (item.category === 'video' && tiers['480p']?.credits && tiers['720p']?.credits) {
    return [
      `480P ${tiers['480p'].credits} 积分/${unit}`,
      `720P ${tiers['720p'].credits} 积分/${unit}`,
      ...(tiers['1080p']?.credits ? [`1080P ${tiers['1080p'].credits} 积分/${unit}`] : []),
    ].join(' · ')
  }
  return `当前 ${item.credits} 积分/${unit}`
}
