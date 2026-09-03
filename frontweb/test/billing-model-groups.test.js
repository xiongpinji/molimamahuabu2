import test from 'node:test'
import assert from 'node:assert/strict'

import {
  filterModelPricesByProviderConfig,
  groupModelPricesByProvider,
} from '../src/utils/billingModelGroups.js'

test('模型计费按中转站分组且同一模型可归入多个中转站', () => {
  const groups = groupModelPricesByProvider([
    {
      model: 'seedance-2.0',
      providers: [
        { config_id: 11, provider: 'newapi', provider_name: 'NewAPI', provider_base_url: 'https://relay-a.example/v1' },
        { config_id: 12, provider: 'newapi', provider_name: 'NewAPI 备用', provider_base_url: 'https://relay-b.example/v1' },
      ],
      provider_costs: [
        { config_id: 11, micros_per_unit: 1000 },
        { config_id: 12, micros_per_unit: 2000 },
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
  assert.deepEqual(groups[0].items[0].providers.map((entry) => entry.config_id), [11])
  assert.deepEqual(groups[0].items[0].provider_costs.map((entry) => entry.config_id), [11])
  assert.deepEqual(groups[1].items[0].providers.map((entry) => entry.config_id), [12])
  assert.deepEqual(groups[1].items[0].provider_costs.map((entry) => entry.config_id), [12])
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

test('从某条模型配置进入计费页时只保留该配置所属模型和成本', () => {
  const items = filterModelPricesByProviderConfig([
    {
      model: 'shared-model',
      providers: [{ config_id: 21 }, { config_id: 22 }],
      provider_costs: [{ config_id: 21 }, { config_id: 22 }],
    },
    {
      model: 'relay-21-only',
      providers: [{ config_id: 21 }],
      provider_costs: [{ config_id: 21 }],
    },
    {
      model: 'relay-22-only',
      providers: [{ config_id: 22 }],
      provider_costs: [{ config_id: 22 }],
    },
    { model: 'unassigned', providers: [] },
  ], 21)

  assert.deepEqual(items.map((item) => item.model), ['shared-model', 'relay-21-only'])
  assert.deepEqual(items[0].providers.map((entry) => entry.config_id), [21])
  assert.deepEqual(items[0].provider_costs.map((entry) => entry.config_id), [21])
})
