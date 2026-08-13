import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const source = fs.readFileSync(new URL('../src/components/AIConfigContent.vue', import.meta.url), 'utf8')

test('AI config exposes fumin aliases without reusing existing provider model ids', () => {
  assert.match(source, /id: 'fumin', name: 'fumin Seedance 2\.0'/)
  assert.match(source, /'fumin-seedance-2\.0-fast', 'fumin-seedance-2\.0-mini'/)
  assert.match(source, /fumin: 'fumin_video'/)
  assert.match(source, /p === 'fumin' \|\| p === 'fumin_video'/)
  assert.match(source, /\/api\/v3\/contents\/generations\/tasks\/\{taskId\}/)
})
