import test from 'node:test'
import assert from 'node:assert/strict'

import { buildMaterialLibraryQuery } from '../src/utils/materialLibraryQuery.js'

test('global material library queries use global scope without a drama filter', () => {
  assert.deepEqual(buildMaterialLibraryQuery('global', 42, 1, 20, '森林'), {
    page: 1,
    page_size: 20,
    keyword: '森林',
    global: 1,
  })
})

test('local material library queries keep the current drama scope', () => {
  assert.deepEqual(buildMaterialLibraryQuery('library', 42, 2, 10, ''), {
    page: 2,
    page_size: 10,
    keyword: undefined,
    drama_id: 42,
  })
})
