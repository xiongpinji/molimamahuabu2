import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

function readView(name) {
  return readFileSync(fileURLToPath(new URL(`../src/views/${name}`, import.meta.url)), 'utf8')
}

const filmListSource = readView('FilmList.vue')

test('项目列表只把带项目 ID 的完整画布作为主要画布入口', () => {
  assert.doesNotMatch(filmListSource, /show-home-canvas="true"/)
  assert.doesNotMatch(filmListSource, /goHomeCanvas/)
  assert.match(filmListSource, /@click\.stop="openCanvas\(d\.id\)"/)
  assert.match(filmListSource, /router\.push\('\/film\/' \+ id \+ '\/canvas'\)/)
})

test('普通页面的全局头部不再把独立自由画布作为主要入口', () => {
  for (const view of ['DramaDetail.vue', 'FilmCreate.vue', 'FreeCreate.vue', 'MediaLibrary.vue', 'AiConfig.vue', 'BillingAdmin.vue']) {
    assert.doesNotMatch(readView(view), /show-home-canvas="true"/, view)
  }
})
