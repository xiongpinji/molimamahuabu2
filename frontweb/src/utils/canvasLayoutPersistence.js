export function createCanvasLayoutPersistence(save) {
  if (typeof save !== 'function') throw new TypeError('save must be a function')

  let revision = 0
  let savedRevision = 0
  let running = null
  let latestLayout
  let latestGroups
  let lastResult = null

  function update({ canvasLayout, workflowGroups } = {}) {
    if (canvasLayout !== undefined) latestLayout = canvasLayout
    if (workflowGroups !== undefined) latestGroups = workflowGroups
    revision += 1
    return flush()
  }

  function flush() {
    if (running) return running
    running = (async () => {
      try {
        while (savedRevision < revision) {
          const sendingRevision = revision
          const result = await save({
            canvasLayout: latestLayout,
            workflowGroups: latestGroups,
            revision: sendingRevision,
          })
          lastResult = result
          savedRevision = sendingRevision
        }
        return lastResult
      } finally {
        running = null
      }
    })()
    return running
  }

  return {
    update,
    flush,
    get dirty() { return savedRevision < revision },
    get revision() { return revision },
    get savedRevision() { return savedRevision },
  }
}
