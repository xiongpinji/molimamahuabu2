const RELOAD_MARKER = 'moli:vite-preload-reload-at'
const RELOAD_COOLDOWN_MS = 30_000

export function installPreloadErrorRecovery(
  browser,
  { now = Date.now, cooldownMs = RELOAD_COOLDOWN_MS } = {},
) {
  if (!browser?.addEventListener) return () => {}

  const onPreloadError = (event) => {
    const timestamp = Number(now())
    let lastReload
    try {
      lastReload = Number(browser.sessionStorage.getItem(RELOAD_MARKER)) || 0
      if (lastReload > 0 && timestamp - lastReload < cooldownMs) return
      browser.sessionStorage.setItem(RELOAD_MARKER, String(timestamp))
    } catch {
      return
    }

    event?.preventDefault?.()
    browser.location?.reload?.()
  }

  browser.addEventListener('vite:preloadError', onPreloadError)
  return () => browser.removeEventListener?.('vite:preloadError', onPreloadError)
}
