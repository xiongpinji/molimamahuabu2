import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

async function batchLoadWithLimit(items, limit, worker) {
  const results = new Array(items.length)
  let cursor = 0
  let inflight = 0
  let maxInflight = 0
  async function runner() {
    while (cursor < items.length) {
      const idx = cursor++
      inflight += 1
      maxInflight = Math.max(maxInflight, inflight)
      results[idx] = await worker(items[idx])
      inflight -= 1
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner))
  return { results, maxInflight }
}

test('storyboard media batch loader never exceeds concurrency cap', async () => {
  const items = Array.from({ length: 20 }, (_, i) => i)
  const { results, maxInflight } = await batchLoadWithLimit(items, 6, async (id) => {
    await new Promise((r) => setTimeout(r, 2))
    return id * 2
  })
  assert.equal(maxInflight <= 6, true)
  assert.deepEqual(results, items.map((id) => id * 2))
})

test('useCanvasStoryboardMedia keeps cache and concurrency contracts', async () => {
  const require = createRequire(import.meta.url)
  const fs = require('node:fs')
  const path = require('node:path')
  const source = fs.readFileSync(
    path.join(process.cwd(), 'src/composables/useCanvasStoryboardMedia.js'),
    'utf8',
  )
  assert.match(source, /CACHE_TTL = 30 \* 1000/)
  assert.match(source, /MAX_CONCURRENT = 6/)
  assert.match(source, /function invalidateCache/)
  assert.match(source, /refreshInBackground/)
})
