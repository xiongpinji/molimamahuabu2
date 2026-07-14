export function normalizeCreditAccount(account = {}) {
  const value = (field) => Number.isSafeInteger(account[field]) && account[field] >= 0 ? account[field] : 0
  return { available: value('available'), held: value('held'), spent: value('spent') }
}
