import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'
import { createServer } from 'vite'

test('道具和场景生图只有 completed 才提示成功，timeout 保持失败状态', async (t) => {
  const vite = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    logLevel: 'silent',
    server: { middlewareMode: true },
  })
  t.after(() => vite.close())

  const { useProps } = await vite.ssrLoadModule('/src/composables/filmCreate/useProps.js')
  const { useScenes } = await vite.ssrLoadModule('/src/composables/filmCreate/useScenes.js')
  const { propAPI } = await vite.ssrLoadModule('/src/api/props.js')
  const { sceneAPI } = await vite.ssrLoadModule('/src/api/scenes.js')
  const { ElMessage } = await vite.ssrLoadModule('element-plus')
  const { useGenerationTaskStore, GEN_RESOURCE } = await vite.ssrLoadModule(
    '/src/stores/generationTaskStore.js'
  )
  const originalPropGenerate = propAPI.generateImage
  const originalSceneGenerate = sceneAPI.generateImage
  const originalSuccess = ElMessage.success
  const originalError = ElMessage.error
  propAPI.generateImage = async () => ({ task_id: 'prop-task' })
  sceneAPI.generateImage = async () => ({ image_generation: { task_id: 'scene-task' } })
  ElMessage.success = () => {}
  ElMessage.error = () => {}
  t.after(() => {
    propAPI.generateImage = originalPropGenerate
    sceneAPI.generateImage = originalSceneGenerate
    ElMessage.success = originalSuccess
    ElMessage.error = originalError
  })

  setActivePinia(createPinia())
  const prop = { id: 8, name: '旧式手机' }
  const scene = { id: 9, location: '雨夜街道' }
  const store = {
    drama: { title: '测试剧', props: [prop], scenes: [scene] },
    currentEpisode: { episode_number: 1, props: [prop], scenes: [scene] },
  }
  const shared = {
    store,
    dramaId: ref(1),
    currentEpisodeId: ref(2),
    getSelectedStyle: () => 'realistic',
    loadDrama: async () => {},
    pollTask: async () => ({ status: 'timeout', error: '任务等待超时，请刷新后重试' }),
    pollUntilResourceHasImage: async () => {},
    hasAssetImage: () => false,
  }
  const props = useProps(shared)
  const scenes = useScenes({
    ...shared,
    scriptLanguage: ref('zh'),
    dramaAPI: {},
  })

  await props.onGeneratePropImage(prop)
  await scenes.onGenerateSceneImage(scene)

  assert.equal(prop.errorMsg, '任务等待超时，请刷新后重试')
  assert.equal(scene.errorMsg, '任务等待超时，请刷新后重试')
  const taskStore = useGenerationTaskStore()
  const propState = taskStore.tasks.get(`1:2:${GEN_RESOURCE.PROP_IMAGE}:8`)
  const sceneState = taskStore.tasks.get(`1:2:${GEN_RESOURCE.SCENE_IMAGE}:9`)
  assert.equal(propState.status, 'failed')
  assert.equal(sceneState.status, 'failed')
})
