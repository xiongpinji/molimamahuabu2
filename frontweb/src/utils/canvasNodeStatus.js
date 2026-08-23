export function isCanvasNodeBusyStatus(status) {
  return Boolean(status && !['failed', 'success'].includes(status.step))
}
