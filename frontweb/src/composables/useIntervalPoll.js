/**
 * 通用间隔轮询 composable，避免各页面重复 setInterval 逻辑。
 */
export function useIntervalPoll(task, intervalMs = 3000) {
  let timer = null
  let running = false

  async function tick() {
    if (running) return
    running = true
    try {
      await task()
    } finally {
      running = false
    }
  }

  function start() {
    stop()
    timer = window.setInterval(tick, intervalMs)
    tick()
  }

  function stop() {
    if (!timer) return
    window.clearInterval(timer)
    timer = null
  }

  function isActive() {
    return timer != null
  }

  return { start, stop, isActive, tick }
}
