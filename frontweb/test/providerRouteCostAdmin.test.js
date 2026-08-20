import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8')

test('管理员稳定性 API 提供独立线路成本读写且不复用用户积分价格接口', () => {
  const api = read('src/api/providerStability.js')
  assert.match(api, /getRouteCost\(configId\)[\s\S]*routes\/\$\{configId\}\/cost/)
  assert.match(api, /updateRouteCost\(configId, body\)[\s\S]*request\.put\(`\/admin\/provider-stability\/routes\/\$\{configId\}\/cost`/)
  assert.doesNotMatch(api, /billing\/prices/)
})

test('管理面板分区展示供应商线路成本并支持分辨率档位', () => {
  const panel = read('src/components/ProviderStabilityPanel.vue')
  assert.match(panel, /供应商线路成本/)
  assert.match(panel, /用户积分价格与供应商实际成本相互独立/)
  assert.match(panel, /costForm\.cost_unit/)
  assert.match(panel, /costForm\.resolution_prices/)
  assert.match(panel, /yuanToMicros/)
  assert.match(panel, /microsToYuan/)
  assert.match(panel, /providerStabilityAPI\.updateRouteCost/)
})
