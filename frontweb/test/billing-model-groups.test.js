import test from 'node:test'
import assert from 'node:assert/strict'

import { groupModelPricesByProvider } from '../src/utils/billingModelGroups.js'

test('模型计费按中转站分组且同一模型可归入多个中转站', () => {
  const groups = groupModelPricesByProvider([
    {
      model: 'seedance-2.0',
      providers: [
        { provider: 'newapi', provider_name: 'NewAPI', provider_base_url: 'https://relay-a.example/v1' },
        { provider: 'newapi', provider_name: 'NewAPI 备用', provider_base_url: 'https://relay-b.example/v1' },
      ],
    },
    {
      model: 'wan-3.0',
      providers: [{ provider: 'newapi', provider_name: 'NewAPI', provider_base_url: 'https://relay-a.example/v1' }],
    },
    {
      model: 'local-model',
      providers: [],
    },
  ])

  assert.deepEqual(groups.map((group) => group.key), [
    'url:https://relay-a.example/v1',
    'url:https://relay-b.example/v1',
    'unassigned',
  ])
  assert.deepEqual(groups[0].items.map((item) => item.model), ['seedance-2.0', 'wan-3.0'])
  assert.deepEqual(groups[1].items.map((item) => item.model), ['seedance-2.0'])
  assert.equal(groups[2].label, '未关联中转站')
})

test('同一个中转站的大小写和尾部斜杠差异不会拆成两个队列', () => {
  const groups = groupModelPricesByProvider([
    { model: 'a', providers: [{ provider: 'newapi', provider_name: 'Relay', provider_base_url: 'HTTPS://relay.example/v1/' }] },
    { model: 'b', providers: [{ provider: 'newapi', provider_name: 'Relay', provider_base_url: 'https://relay.example/v1' }] },
  ])

  assert.equal(groups.length, 1)
  assert.deepEqual(groups[0].items.map((item) => item.model), ['a', 'b'])
})
