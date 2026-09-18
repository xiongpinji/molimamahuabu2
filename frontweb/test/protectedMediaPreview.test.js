import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isProtectedStaticMediaUrl,
  loadProtectedMediaPreview,
  peekProtectedMediaPreview,
  clearProtectedMediaPreviewCache,
} from '../src/utils/protectedMediaPreview.js'

test('protected static media is identified without treating public URLs as protected', () => {
  assert.equal(isProtectedStaticMediaUrl('/static/projects/60/images/a.png'), true)
  assert.equal(isProtectedStaticMediaUrl('https://cdn.example.com/a.png'), false)
  assert.equal(isProtectedStaticMediaUrl('data:image/png;base64,abc'), false)
})

test('protected static media preview fetches with the session and tenant headers', async () => {
  let request
  const objectUrl = 'blob:preview-60'
  const preview = await loadProtectedMediaPreview('/static/projects/60/images/a.png', {
    session: { token: 'session-token' },
    tenantId: 'tenant-60',
    fetchImpl: async (url, options) => {
      request = { url, options }
      return {
        ok: true,
        blob: async () => new Blob(['image-bytes'], { type: 'image/png' }),
      }
    },
    urlApi: { createObjectURL: () => objectUrl },
  })
  assert.equal(preview, objectUrl)
  assert.equal(request.url, '/static/projects/60/images/a.png')
  assert.equal(request.options.headers.Authorization, 'Bearer session-token')
  assert.equal(request.options.headers['X-Tenant-Id'], 'tenant-60')
})

test('protected static media preview reuses cache and dedupes in-flight fetches', async () => {
  clearProtectedMediaPreviewCache()
  let fetches = 0
  const fetchImpl = async () => {
    fetches += 1
    await new Promise((resolve) => setTimeout(resolve, 5))
    return {
      ok: true,
      blob: async () => new Blob([`bytes-${fetches}`], { type: 'image/png' }),
    }
  }
  const urlApi = {
    createObjectURL: (blob) => `blob:cached-${blob.size}`,
  }
  const path = '/static/projects/60/images/cache-me.png'
  const [a, b] = await Promise.all([
    loadProtectedMediaPreview(path, { session: { token: 't' }, tenantId: '1', fetchImpl, urlApi }),
    loadProtectedMediaPreview(path, { session: { token: 't' }, tenantId: '1', fetchImpl, urlApi }),
  ])
  assert.equal(a, b)
  assert.equal(fetches, 1)
  assert.equal(peekProtectedMediaPreview(path), a)
  const c = await loadProtectedMediaPreview(path, {
    session: { token: 't' },
    tenantId: '1',
    fetchImpl: async () => { throw new Error('should not fetch again') },
    urlApi,
  })
  assert.equal(c, a)
  clearProtectedMediaPreviewCache()
})
