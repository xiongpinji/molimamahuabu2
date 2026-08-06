export const CUSTOM_RECHARGE_RATIO = 100
export const QUICK_RECHARGE_AMOUNTS = [10, 30, 50, 100, 300, 500]

export function legacyRechargeRedirect(to) {
  if (to?.name !== 'tenant-console' || to?.query?.section !== 'recharge') return null
  const { section: _section, ...query } = to.query
  return { name: 'recharge-center', query, hash: to.hash }
}

function amountToCents(amount) {
  const match = String(amount ?? '').trim().match(/^(\d{1,5})(?:\.(\d{1,2}))?$/)
  if (!match) return null

  const cents = (BigInt(match[1]) * 100n) + BigInt((match[2] || '').padEnd(2, '0'))
  return cents <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(cents) : null
}

export function creditsForCustomAmount(amount) {
  const cents = amountToCents(amount)
  return cents === null ? 0 : Math.round((cents * CUSTOM_RECHARGE_RATIO) / 100)
}

export function validCustomAmount(amount, min, max) {
  const cents = amountToCents(amount)
  const minCents = amountToCents(min)
  const maxCents = amountToCents(max)
  return cents !== null && minCents !== null && maxCents !== null
    && cents >= minCents && cents <= maxCents
}

export function packageCreditMetrics(item) {
  const rawAmountCents = Number(item?.amount_cents)
  const rawCredits = Number(item?.credits)
  const amountCents = Number.isFinite(rawAmountCents) ? Math.max(rawAmountCents, 0) : 0
  const credits = Number.isFinite(rawCredits) ? Math.max(rawCredits, 0) : 0
  const amountYuan = amountCents / 100
  const baseCredits = Math.round((amountCents * CUSTOM_RECHARGE_RATIO) / 100)

  return {
    amountYuan,
    baseCredits,
    bonusCredits: Math.max(credits - baseCredits, 0),
    creditsPerYuan: amountYuan > 0 ? Number((credits / amountYuan).toFixed(2)) : 0,
  }
}

export function normalizeAccentColor(value) {
  const color = String(value || '').trim().toLowerCase()
  return /^#[0-9a-f]{6}$/.test(color) ? color : '#ff7139'
}
