export function tryAcquireGenerationLock(running, key) {
  if (running.has(key)) return false
  running.add(key)
  return true
}

export function releaseGenerationLock(running, key) {
  running.delete(key)
}
