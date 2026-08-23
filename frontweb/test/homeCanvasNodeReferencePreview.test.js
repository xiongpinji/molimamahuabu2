import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const source = fs.readFileSync(new URL('../src/components/dramaCanvas/HomeCanvasNode.vue', import.meta.url), 'utf8')

test('HomeCanvasNode resolves protected connected media before rendering reference thumbnails', () => {
  assert.match(source, /loadProtectedMediaPreview/)
  assert.match(source, /watch\(\[inputReferences, referenceCandidates\], refreshReferencePreviews/)
  assert.match(source, /:src="referencePreviewUrl\(reference\)"/)
  assert.match(source, /:src="referencePreviewUrl\(candidate\)"/)
})
