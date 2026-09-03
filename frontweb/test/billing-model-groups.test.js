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
    'url:https://relay-a.example',
    'url:https://relay-b.example',
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

test('同一中转站域名的根路径和 v1 路径归入一个队列', () => {
  const groups = groupModelPricesByProvider([
    { model: 'image-model', providers: [{ provider: 'relay', provider_name: '图片线路', provider_base_url: 'https://relay.example/v1' }] },
    { model: 'video-model', providers: [{ provider: 'relay', provider_name: '视频线路', provider_base_url: 'https://relay.example' }] },
  ])

  assert.equal(groups.length, 1)
  assert.equal(groups[0].key, 'url:https://relay.example')
  assert.deepEqual(groups[0].items.map((item) => item.model), ['image-model', 'video-model'])
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

test('中转站分组用线路分档成本回填空白表单且不覆盖已填写成本', () => {
  const [group] = groupModelPricesByProvider([{
    model: 'cfg-29::seedance-2.0-mini',
    category: 'video',
    providers: [{
      config_id: 29,
      provider: 'newapi',
      provider_name: 'NewAPI',
      provider_base_url: 'https://relay.example',
    }],
    provider_costs: [{
      config_id: 29,
      cost_unit: 'second',
      micros_per_unit: 792000,
      resolution_prices: {
        '480p': { micros_per_unit: 360000 },
        '720p': { micros_per_unit: 792000 },
        '1080p': { micros_per_unit: 1080000 },
      },
    }],
    cost_yuan_per_unit: 0,
    resolution_prices: {
      '480p': { credits: 1, cost_yuan_per_second: 0.4 },
      '720p': { credits: 1, cost_yuan_per_second: 0 },
    },
  }])

  const [item] = group.items
  assert.equal(item.cost_yuan_per_unit, 0.792)
  assert.equal(item.resolution_prices['480p'].cost_yuan_per_second, 0.4)
  assert.equal(item.resolution_prices['720p'].cost_yuan_per_second, 0.792)
  assert.deepEqual(item.resolution_prices['1080p'], {
    credits: 1,
    cost_yuan_per_second: 1.08,
  })
})
