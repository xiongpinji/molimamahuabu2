import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  descriptionTextFor,
  readableText,
} from '../src/utils/scriptAnalysisDescription.js'

const viewSource = readFileSync(
  new URL('../src/views/ScriptAnalysis.vue', import.meta.url),
  'utf8',
)

test('旧分析包的人物场景道具和分镜字段可转换为可读描述', () => {
  assert.equal(descriptionTextFor('character', {
    visual_design: { appearance: '短发', clothing: '深色外套' },
    performance_direction: '克制地观察对方',
  }), '短发；深色外套；克制地观察对方')

  assert.equal(descriptionTextFor('scene', {
    environment: '雨水打湿站台',
    story_function: '母女和解发生地',
  }), '雨水打湿站台；母女和解发生地')

  assert.equal(descriptionTextFor('prop', {
    required_visual_features: ['边缘磨损', '火漆开裂'],
    story_function: '触发和解',
  }), '边缘磨损；火漆开裂；触发和解')

  assert.equal(descriptionTextFor('shot', {
    image_prompt: '母女隔着车窗对视',
    video_prompt: '镜头缓慢推进',
  }), '母女隔着车窗对视；镜头缓慢推进')
})

test('对象和数组描述不会显示为 object Object', () => {
  const text = readableText({
    appearance: ['短发', '深色外套'],
    lighting: '冷色站台灯',
  })

  assert.equal(text, '短发；深色外套；冷色站台灯')
  assert.doesNotMatch(text, /\[object Object\]/)
})

test('剧本分析页面为四类生产对象统一使用描述兼容层', () => {
  for (const type of ['character', 'scene', 'prop', 'shot']) {
    assert.match(viewSource, new RegExp(`descriptionTextFor\\('${type}',`))
  }
})
