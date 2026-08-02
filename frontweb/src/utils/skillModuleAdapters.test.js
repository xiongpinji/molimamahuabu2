import test from 'node:test'
import assert from 'node:assert/strict'

import { buildFactorySkillImportPreview } from './skillModuleAdapters.js'

function createPackage() {
  return {
    normalized_script: {
      title: '灯塔之夜',
      logline: '母女在停电之夜重新理解彼此。',
      genre: '家庭剧情',
    },
    character_bible: [{ id: 'character-1', name: '林夏' }],
    scene_bible: [{ id: 'scene-1', name: '旧客厅' }],
    prop_bible: [{ id: 'prop-1', name: '煤油灯' }],
    episodes: [{
      id: 'episode-1',
      title: '第一集',
      scenes: [{
        id: 'episode-scene-1',
        shots: [{
          id: 'shot-1',
          image_prompt: '暖色煤油灯照亮母女的脸',
          video_prompt: '摄影机缓慢推进，母亲抬起头',
        }],
      }],
    }],
    visual_direction: {
      emotional_tone: { primary: '克制温暖', evidence: ['停电后点亮煤油灯'] },
      recommendations: [{ rank: 1, name: '低照度家庭戏' }],
    },
  }
}

test('短剧工厂适配器只构建获批生产包的只读预览', () => {
  const productionPackage = createPackage()
  const original = structuredClone(productionPackage)
  const preview = buildFactorySkillImportPreview({
    project: {
      id: 18,
      title: '灯塔之夜项目',
      locked_facts: ['母女关系不能改', '故事发生在停电夜'],
    },
    productionPackage,
    skillSnapshot: {
      id: 'cinematic-visual-director',
      name: '电影化视觉导演',
      version: '1.0.0',
      module: 'script_analysis',
      output_schema_version: '1.0',
    },
    approvalStatus: 'approved',
    activeVersion: 3,
  })

  assert.equal(preview.schema_version, 'factory-skill-import-preview@1.0')
  assert.equal(preview.mode, 'preview')
  assert.deepEqual(preview.source, {
    module: 'script_analysis',
    project_id: 18,
    project_title: '灯塔之夜项目',
    version: 3,
    approval_status: 'approved',
  })
  assert.deepEqual(preview.story, {
    title: '灯塔之夜',
    logline: '母女在停电之夜重新理解彼此。',
    genre: '家庭剧情',
  })
  assert.deepEqual(preview.counts, {
    characters: 1,
    scenes: 1,
    props: 1,
    episodes: 1,
    shots: 1,
  })
  assert.deepEqual(preview.locked_facts, ['母女关系不能改', '故事发生在停电夜'])
  assert.equal(preview.production_context.episodes[0].scenes[0].shots[0].image_prompt, '暖色煤油灯照亮母女的脸')
  assert.equal(preview.production_context.episodes[0].scenes[0].shots[0].video_prompt, '摄影机缓慢推进，母亲抬起头')
  assert.notEqual(preview.production_context.episodes, productionPackage.episodes)
  assert.deepEqual(productionPackage, original)
})

test('短剧工厂适配器拒绝未获批版本', () => {
  assert.throws(() => buildFactorySkillImportPreview({
    project: { id: 18, locked_facts: [] },
    productionPackage: createPackage(),
    skillSnapshot: null,
    approvalStatus: 'draft',
    activeVersion: 1,
  }), /审核通过/)
})

test('项目未单独返回锁定事实时保留生产包来源事实', () => {
  const productionPackage = {
    ...createPackage(),
    source: { locked_facts: ['结局不能改变'] },
  }
  const preview = buildFactorySkillImportPreview({
    project: { id: 18, locked_facts: [] },
    productionPackage,
    skillSnapshot: null,
    approvalStatus: 'approved',
    activeVersion: 1,
  })

  assert.deepEqual(preview.locked_facts, ['结局不能改变'])
})
