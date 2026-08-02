import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyVisualDirectionGuidance,
  findVisualDirectionDirectorEntry,
} from './visualDirectionDirectorBridge.js'

const visualDirection = {
  emotional_tone: { primary: '压迫', secondary: '希望', evidence: ['原文依据'] },
  scene_profile: [],
  rhythm: { labels: ['缓慢'], evidence: ['原文依据'] },
  visual_motifs: [],
  recommendations: [{ rank: 1, name: '克制跟随', objective_style: '低速跟随与冷色侧光' }],
}

function visualNode(id, selected = false) {
  return {
    id,
    selected,
    data: {
      title: `方案 ${id}`,
      scriptAnalysis: {
        projectId: 42,
        version: 3,
        sourceType: 'visual_direction',
        sourceId: 'visual-direction',
        skillId: 'cinematic-visual-director',
        skillVersion: '1.0.0',
      },
      visualDirection,
      skillSnapshot: { id: 'cinematic-visual-director', version: '1.0.0' },
    },
  }
}

test('优先读取用户选中的视觉方案节点，否则读取最后追加的方案', () => {
  const first = visualNode('visual-1')
  const second = visualNode('visual-2')
  const selected = visualNode('visual-selected', true)
  const ordinary = { id: 'text', selected: true, data: { scriptAnalysis: { sourceType: 'shot' } } }

  assert.equal(findVisualDirectionDirectorEntry([first, second]).sourceNodeId, 'visual-2')
  assert.equal(findVisualDirectionDirectorEntry([first, ordinary, selected]).sourceNodeId, 'visual-selected')
  assert.equal(findVisualDirectionDirectorEntry([ordinary]), null)
})

test('确认应用只写入导演台扩展并保留原机位人物灯光数据', () => {
  const timeline = {
    version: 4,
    revision: 7,
    shots: [{ id: 'shot-1', cameraId: 'camera-1' }],
    objects: [{ id: 'role-1', transform: { position: [1, 0, 2] } }],
    environment: { ambientIntensity: 1, directionalIntensity: 2 },
    extensions: { existing: { keep: true } },
  }
  const before = JSON.parse(JSON.stringify(timeline))
  const entry = findVisualDirectionDirectorEntry([visualNode('visual-1')])
  const next = applyVisualDirectionGuidance(timeline, entry, '2026-08-02T12:00:00.000Z')

  assert.deepEqual(timeline, before)
  assert.deepEqual(next.shots, before.shots)
  assert.deepEqual(next.objects, before.objects)
  assert.deepEqual(next.environment, before.environment)
  assert.deepEqual(next.extensions.existing, { keep: true })
  assert.equal(next.extensions.visualDirectionGuidance.sourceNodeId, 'visual-1')
  assert.equal(next.extensions.visualDirectionGuidance.appliedAt, '2026-08-02T12:00:00.000Z')
  assert.deepEqual(next.extensions.visualDirectionGuidance.visualDirection, visualDirection)
})
