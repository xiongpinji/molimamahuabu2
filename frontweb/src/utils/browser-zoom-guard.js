const wheelListenerOptions = { capture: true, passive: false }

export function preventModifiedWheelPageZoom(event) {
  if (!event.ctrlKey && !event.metaKey) return
  event.preventDefault()
}

export function installBrowserWheelZoomGuard(target = window) {
  target.addEventListener('wheel', preventModifiedWheelPageZoom, wheelListenerOptions)
  return () => target.removeEventListener('wheel', preventModifiedWheelPageZoom, true)
}
