import assert from 'node:assert/strict'
import test from 'node:test'

import { buildScriptAnalysisCanvasState } from './scriptAnalysisCanvasImport.js'

const productionPackage = {
  schema_version: '1.0',
  source: {
    locked_facts: ['林岚进入雨林寻找失踪的父亲。'],
  },
  normalized_script: {
    logline: '林岚进入雨林寻找失踪的父亲。',
    genre: '悬疑',
    story_structure: [],
  },
  character_bible: [
    {
      id: 'character:lin-lan',
      name: '林岚',
      visual_prompt: '二十七岁亚洲女性，短发，雨林探险服。',
    },
  ],
  scene_bible: [
    {
      id: 'scene:rainforest',
      name: '雨林深处',
      visual_prompt: '雨后原始森林，冷绿色散射光。',
    },
  ],
  prop_bible: [
    {
      id: 'prop:old-map',
      name: '旧地图',
      visual_prompt: '边缘磨损的手绘雨林地图。',
    },
  ],
  episodes: [
    {
      episode_number: 1,
      title: '入林寻踪',
      scenes: [
        {
          scene_number: 1,
          title: '雨林深处',
          shots: [
            {
              shot_number: 1,
              source_basis: ['character:lin-lan', 'scene:rainforest', 'prop:old-map'],
              image_prompt: '林岚手持旧地图走入雨后的原始森林。',
              video_prompt: '镜头跟随林岚缓慢前行，她低头核对旧地图。',
              dialogue: [{ character: '林岚', text: '入口就在前面。' }],
              continuity: {
                start_state: '林岚站在雨林入口',
                end_state: '林岚走到巨树下',
              },
            },
          ],
        },
      ],
    },
  ],
  continuity_rules: [],
  review: {
    status: 'approved',
    issues: [],
  },
  ai_changes: [],
}

test('审核通过的制作包可追加为画布分镜链路并保留原画布', () => {
  const existingState = {
    version: 1,
    nodes: [
      {
        id: 'existing-node',
        type: 'homeCanvasNode',
        position: { x: 20, y: 30 },
        data: { kind: 'text', title: '已有节点', content: '不要覆盖我' },
      },
    ],
    edges: [],
    viewport: { x: 12, y: 24, zoom: 1.25 },
  }

  const nextState = buildScriptAnalysisCanvasState({
    existingState,
    project: { id: 42, title: '雨林寻踪', active_version: 3 },
    productionPackage,
    approvalStatus: 'approved',
    importId: 'import-a',
  })

  assert.equal(nextState.viewport.zoom, 1.25)
  assert.equal(nextState.nodes[0].id, 'existing-node')
  assert.equal(nextState.nodes[0].data.content, '不要覆盖我')

  const shotNodes = nextState.nodes.filter(
    (node) => node.data?.scriptAnalysis?.sourceType === 'shot',
  )
  assert.deepEqual(shotNodes.map((node) => node.data.kind), ['text', 'image', 'video'])
  assert.equal(shotNodes[1].data.content, productionPackage.episodes[0].scenes[0].shots[0].image_prompt)
  assert.equal(shotNodes[2].data.content, productionPackage.episodes[0].scenes[0].shots[0].video_prompt)

  const shotEdges = nextState.edges.filter((edge) => edge.id.includes(':shot:'))
  assert.deepEqual(
    shotEdges.map((edge) => [edge.source, edge.target]),
    [
      [shotNodes[0].id, shotNodes[1].id],
      [shotNodes[1].id, shotNodes[2].id],
    ],
  )
})

test('未审核通过的制作包不能导入画布', () => {
  assert.throws(() => buildScriptAnalysisCanvasState({
    existingState: null,
    project: { id: 42, title: '雨林寻踪', active_version: 3 },
    productionPackage,
    approvalStatus: 'needs_review',
    importId: 'import-a',
  }), /审核通过/)
})

test('同一审核版本不能重复导入画布', () => {
  const firstState = buildScriptAnalysisCanvasState({
    existingState: null,
    project: { id: 42, title: '雨林寻踪', active_version: 3 },
    productionPackage,
    approvalStatus: 'approved',
    importId: 'import-a',
  })

  assert.throws(() => buildScriptAnalysisCanvasState({
    existingState: firstState,
    project: { id: 42, title: '雨林寻踪', active_version: 3 },
    productionPackage,
    approvalStatus: 'approved',
    importId: 'import-a',
  }), /已经导入/)
})

test('不同审核版本可继续追加且节点 ID 不重复', () => {
  const firstState = buildScriptAnalysisCanvasState({
    existingState: null,
    project: { id: 42, title: '雨林寻踪', active_version: 3 },
    productionPackage,
    approvalStatus: 'approved',
    importId: 'import-a',
  })
  const nextState = buildScriptAnalysisCanvasState({
    existingState: firstState,
    project: { id: 42, title: '雨林寻踪', active_version: 4 },
    productionPackage,
    approvalStatus: 'approved',
    importId: 'import-b',
  })

  assert.ok(nextState.nodes.length > firstState.nodes.length)
  assert.equal(new Set(nextState.nodes.map((node) => node.id)).size, nextState.nodes.length)
})

test('缺少图片或视频提示词的制作包不能导入画布', () => {
  const invalidPackage = JSON.parse(JSON.stringify(productionPackage))
  invalidPackage.episodes[0].scenes[0].shots[0].video_prompt = ''

  assert.throws(() => buildScriptAnalysisCanvasState({
    existingState: null,
    project: { id: 42, title: '雨林寻踪', active_version: 3 },
    productionPackage: invalidPackage,
    approvalStatus: 'approved',
    importId: 'import-a',
  }), /图片或视频提示词/)
})

test('缺少制作包必需数组时不能导入画布', () => {
  const invalidPackage = JSON.parse(JSON.stringify(productionPackage))
  delete invalidPackage.character_bible

  assert.throws(() => buildScriptAnalysisCanvasState({
    existingState: null,
    project: { id: 42, title: '雨林寻踪', active_version: 3 },
    productionPackage: invalidPackage,
    approvalStatus: 'approved',
    importId: 'import-a',
  }), /character_bible/)
})

test('缺少 source.locked_facts 时不能导入画布', () => {
  const invalidPackage = JSON.parse(JSON.stringify(productionPackage))
  delete invalidPackage.source.locked_facts

  assert.throws(() => buildScriptAnalysisCanvasState({
    existingState: null,
    project: { id: 42, title: '雨林寻踪', active_version: 3 },
    productionPackage: invalidPackage,
    approvalStatus: 'approved',
    importId: 'import-a',
  }), /source\.locked_facts/)
})

test('normalized_script.story_structure 不是数组时不能导入画布', () => {
  const invalidPackage = JSON.parse(JSON.stringify(productionPackage))
  invalidPackage.normalized_script.story_structure = {}

  assert.throws(() => buildScriptAnalysisCanvasState({
    existingState: null,
    project: { id: 42, title: '雨林寻踪', active_version: 3 },
    productionPackage: invalidPackage,
    approvalStatus: 'approved',
    importId: 'import-a',
  }), /story_structure/)
})

test('损坏的画布缓存按默认画布恢复后继续追加制作包', () => {
  const nextState = buildScriptAnalysisCanvasState({
    existingState: '{broken',
    project: { id: 42, title: '雨林寻踪', active_version: 3 },
    productionPackage,
    approvalStatus: 'approved',
    importId: 'import-a',
  })

  assert.equal(nextState.nodes[0].id, 'home:welcome')
  assert.equal(nextState.viewport.zoom, 0.75)
  assert.ok(nextState.nodes.some((node) => node.id.startsWith('script-analysis:import-a:')))
})

test('镜头缺少来源依据时不能导入画布', () => {
  const invalidPackage = JSON.parse(JSON.stringify(productionPackage))
  invalidPackage.episodes[0].scenes[0].shots[0].source_basis = []

  assert.throws(() => buildScriptAnalysisCanvasState({
    existingState: null,
    project: { id: 42, title: '雨林寻踪', active_version: 3 },
    productionPackage: invalidPackage,
    approvalStatus: 'approved',
    importId: 'import-a',
  }), /缺少 source_basis/)
})
