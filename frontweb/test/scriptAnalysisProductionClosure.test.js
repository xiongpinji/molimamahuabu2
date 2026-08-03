import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  buildFactoryGenerationPreflight,
  buildScriptAnalysisProvenance,
} from '../src/utils/scriptAnalysisProductionClosure.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const filmCreateSource = fs.readFileSync(
  path.join(__dirname, '../src/views/FilmCreate.vue'),
  'utf8',
)

function importedDrama() {
  return {
    id: 45,
    title: '验收-剧本分析-20260801',
    metadata: JSON.stringify({
      project_type: 'factory',
      script_analysis_import: {
        schema_version: 'script-analysis-factory-import@1.1',
        source_project_id: 12,
        source_project_title: '母亲的来信',
        source_version: 3,
        approval_status: 'approved',
        imported_at: '2026-08-01T08:00:00.000Z',
        locked_facts: ['母亲已经离世', '女儿最终抵达车站'],
        package_snapshot: {
          source: { source_script: '母亲留下一封信，女儿赶往车站。' },
        },
      },
    }),
  }
}

function readyEpisode() {
  return {
    id: 28,
    script_content: '母亲留下一封信，女儿赶往车站。',
    characters: [
      { id: 54, name: '女儿', image_url: '' },
      { id: 55, name: '母亲', image_url: '/assets/mother.png' },
    ],
    scenes: [{ id: 61, name: '厨房', image_url: '' }],
    props: [{ id: 40, name: '一封信', image_url: '' }],
    storyboards: [{
      id: 53,
      title: '发现来信',
      scene_id: 61,
      characters: [{ id: 54 }],
      props: [{ id: 40 }],
      duration: 5,
      image_prompt: '女儿在厨房发现一封信。',
      video_prompt: '镜头缓慢推近女儿手中的信。',
    }],
  }
}

test('剧本分析导入项目展示来源版本、审核状态和只读来源差异', () => {
  const drama = importedDrama()
  const provenance = buildScriptAnalysisProvenance(drama, readyEpisode())

  assert.deepEqual(provenance, {
    projectId: 12,
    projectTitle: '母亲的来信',
    version: 3,
    approvalStatus: 'approved',
    importedAt: '2026-08-01T08:00:00.000Z',
    lockedFacts: ['母亲已经离世', '女儿最终抵达车站'],
    sourceScript: '母亲留下一封信，女儿赶往车站。',
    currentScript: '母亲留下一封信，女儿赶往车站。',
    changed: false,
  })

  const edited = buildScriptAnalysisProvenance(drama, {
    ...readyEpisode(),
    script_content: '女儿读完来信后立刻赶往车站。',
  })
  assert.equal(edited.changed, true)
  assert.equal(buildScriptAnalysisProvenance({ metadata: {} }, readyEpisode()), null)
})

test('生成前检查只报告缺失参考图，不阻断已经完整的文本关系', () => {
  const episode = readyEpisode()
  const snapshot = structuredClone(episode)
  const result = buildFactoryGenerationPreflight({
    drama: importedDrama(),
    currentEpisode: episode,
    videoModel: 'video-model-a',
    aspectRatio: '16:9',
    videoClipDuration: 5,
  })

  assert.equal(result.ready, true)
  assert.deepEqual(result.checks.map(({ key, ok }) => ({ key, ok })), [
    { key: 'video-model', ok: true },
    { key: 'aspect-ratio', ok: true },
    { key: 'storyboards', ok: true },
    { key: 'prompts', ok: true },
    { key: 'relations', ok: true },
    { key: 'duration', ok: true },
  ])
  assert.deepEqual(result.missingReferenceAssets.map((item) => item.name), ['女儿', '厨房', '一封信'])
  assert.equal(result.warning, '3 个参考素材尚无图片，可稍后补充，不阻断文本生产。')
  assert.deepEqual(episode, snapshot)
})

test('模型、提示词、人物场景关系或时长缺失时生成前检查不通过', () => {
  const episode = readyEpisode()
  episode.storyboards[0] = {
    ...episode.storyboards[0],
    scene_id: null,
    characters: [],
    duration: 0,
    image_prompt: '',
    video_prompt: '',
  }

  const result = buildFactoryGenerationPreflight({
    drama: importedDrama(),
    currentEpisode: episode,
    videoModel: '',
    aspectRatio: '',
    videoClipDuration: 0,
  })

  assert.equal(result.ready, false)
  assert.deepEqual(
    result.checks.filter((item) => !item.ok).map((item) => item.key),
    ['video-model', 'aspect-ratio', 'prompts', 'relations', 'duration'],
  )
})

test('短剧工厂页面接入来源追溯和无扣费生成前检查', () => {
  assert.match(filmCreateSource, /buildScriptAnalysisProvenance/)
  assert.match(filmCreateSource, /buildFactoryGenerationPreflight/)
  assert.match(filmCreateSource, /来源：剧本分析/)
  assert.match(filmCreateSource, /scriptAnalysisProvenance\.importedAt/)
  assert.match(filmCreateSource, /当前为可编辑副本，来源剧本保持只读/)
  assert.match(filmCreateSource, /生成前检查（不扣积分）/)
  assert.match(filmCreateSource, /这里只检查，不会自动生成图片或视频/)
})
