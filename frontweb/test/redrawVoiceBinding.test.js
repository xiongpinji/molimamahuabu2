import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

function readSource(path) {
  return readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
}

function sourceBetween(source, start, end) {
  const startIndex = source.indexOf(start)
  assert.notEqual(startIndex, -1, `missing ${start}`)
  const endIndex = source.indexOf(end, startIndex + start.length)
  assert.notEqual(endIndex, -1, `missing ${end}`)
  return source.slice(startIndex, endIndex)
}

const apiSource = readSource('../src/api/redraw.js')
const assetStepSource = readSource('../src/components/redraw/RedrawAssetStep.vue')
const voicePickerSource = readSource('../src/components/redraw/RedrawVoicePicker.vue')

function previewControllerFactory() {
  const source = sourceBetween(
    assetStepSource,
    'function createVoicePreviewController(',
    '\n\nconst props = defineProps',
  )
  return Function(`${source}\nreturn createVoicePreviewController`)()
}

class FakeAudio {
  constructor() {
    this.paused = true
    this._src = ''
    this.srcSetCalls = 0
    this.playCalls = 0
    this.pauseCalls = 0
    this.loadCalls = 0
    this.removedSrc = false
    this.nextPlayError = null
    this.listeners = new Map()
  }

  get src() {
    return this._src
  }

  set src(value) {
    this.srcSetCalls += 1
    this._src = new URL(value, 'https://app.test').href
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener)
  }

  removeEventListener(type, listener) {
    if (this.listeners.get(type) === listener) this.listeners.delete(type)
  }

  play() {
    this.playCalls += 1
    if (this.nextPlayError) {
      const error = this.nextPlayError
      this.nextPlayError = null
      this.paused = true
      return Promise.reject(error)
    }
    this.paused = false
    return Promise.resolve()
  }

  pause() {
    this.pauseCalls += 1
    this.paused = true
  }

  removeAttribute(name) {
    if (name === 'src') {
      this.removedSrc = true
      this._src = ''
    }
  }

  load() {
    this.loadCalls += 1
  }

  fire(type) {
    this.listeners.get(type)?.()
  }
}

test('redraw API 提供版本内生产音色列表和严格白名单绑定请求', () => {
  assert.match(apiSource, /listProductionVoices\(versionId\)/)
  assert.match(apiSource, /redraw\/versions\/\$\{versionId\}\/voices/)
  const assignSource = sourceBetween(apiSource, '  assignVoice(', '\n  listStylePresets(')
  assert.match(assignSource, /redraw\/assets\/\$\{characterAssetId\}\/voice/)
  assert.match(assignSource, /voice_asset_id/)
  assert.match(assignSource, /expected_updated_at/)
  assert.doesNotMatch(assignSource, /\.\.\.body/)
  for (const forbidden of ['provider', 'model', 'evidence', 'audio_path', 'audio_url', 'local_path', 'credits']) {
    assert.doesNotMatch(assignSource, new RegExp(forbidden), forbidden)
  }
})

test('redraw API 通过现有鉴权请求链获取版本内音色预览 blob', () => {
  const previewSource = sourceBetween(apiSource, '  getVoicePreview(', '\n  assignVoice(')
  assert.match(previewSource, /request\.get\(/)
  assert.match(previewSource, /redraw\/versions\/\$\{versionId\}\/voices\/\$\{voiceAssetId\}\/preview/)
  assert.match(previewSource, /responseType:\s*'blob'/)
  assert.doesNotMatch(previewSource, /token|authorization|x-tenant-id/i)
})

test('voice tab 使用角色列表和服务端已验证音色，绑定成功后刷新资产与状态', () => {
  assert.match(assetStepSource, /:characters="characterAssets"/)
  assert.match(assetStepSource, /:voices="productionVoices"/)
  assert.match(assetStepSource, /redrawAPI\.listProductionVoices\(versionId\)/)
  const selectVoiceSource = sourceBetween(assetStepSource, 'async function selectVoice(', '\n\nonMounted(')
  assert.match(selectVoiceSource, /redrawAPI\.assignVoice\(characterAssetId/)
  assert.match(selectVoiceSource, /voice_asset_id:\s*voiceAssetId/)
  assert.match(selectVoiceSource, /expected_updated_at:\s*expectedUpdatedAt/)
  assert.match(selectVoiceSource, /await refresh\(\)/)
  for (const forbidden of ['provider', 'model', 'evidence', 'audio_path', 'audio_url', 'local_path', 'credits']) {
    assert.doesNotMatch(selectVoiceSource, new RegExp(forbidden), forbidden)
  }
})

test('音色选择器提供目标角色、已验证音色、绑定按钮和持久化已绑定状态', () => {
  assert.match(voicePickerSource, /目标角色/)
  assert.match(voicePickerSource, /已验证音色/)
  assert.match(voicePickerSource, /绑定音色/)
  assert.match(voicePickerSource, /已绑定/)
  assert.match(voicePickerSource, /characters:\s*\{\s*type:\s*Array/)
  assert.match(voicePickerSource, /voices:\s*\{\s*type:\s*Array/)
  assert.match(voicePickerSource, /defineEmits\(\['assign',\s*'preview',\s*'preview-stop'\]\)/)
  assert.match(voicePickerSource, /character_asset_id/)
  assert.match(voicePickerSource, /voice_asset_id/)
  assert.match(voicePickerSource, /expected_updated_at/)
  assert.doesNotMatch(voicePickerSource, /seedance2_voice_asset/)
})

test('切换目标角色会先停止旧音色预览再重置选择', () => {
  const watcher = sourceBetween(voicePickerSource, 'watch([selectedCharacter', '\n</script>')
  assert.match(watcher, /previousCharacter/)
  assert.match(watcher, /String\(nextCharacter\?\.id\).*String\(previousCharacter\?\.id\)/s)
  const stopIndex = watcher.indexOf("emit('preview-stop')")
  const resetIndex = watcher.indexOf('selectedVoiceId.value =')
  assert.ok(stopIndex >= 0)
  assert.ok(resetIndex >= 0)
  assert.ok(stopIndex < resetIndex)
})

test('试听事件由资产步骤接收，选择器只在播放确认后显示暂停态', () => {
  assert.match(assetStepSource, /@preview="previewVoice"/)
  assert.match(assetStepSource, /:previewing-voice-id="previewingVoiceId"/)
  assert.match(voicePickerSource, /previewingVoiceId:\s*\{\s*type:\s*\[String, Number\]/)
  assert.match(voicePickerSource, /isPreviewing\s*\?\s*'暂停'\s*:\s*'试听'/)
  assert.doesNotMatch(voicePickerSource, /<audio\b/)
})

test('试听控制器先鉴权获取 blob，暂停恢复复用并在切换音色时释放旧 URL', async () => {
  const createVoicePreviewController = previewControllerFactory()
  const player = new FakeAudio()
  const states = []
  const fetchedVoiceIds = []
  const revokedUrls = []
  const controller = createVoicePreviewController({
    createAudio: () => player,
    fetchPreview: async (voice) => {
      fetchedVoiceIds.push(voice.id)
      return { voiceId: voice.id }
    },
    createObjectURL: (blob) => `blob:voice-${blob.voiceId}`,
    revokeObjectURL: (url) => revokedUrls.push(url),
    onPlayingChange: (voiceId) => states.push(voiceId),
  })

  assert.equal(await controller.toggle({ id: 11, preview_url: '/voice-a.mp3' }), true)
  assert.equal(player.src, 'blob:voice-11')
  assert.equal(player.playCalls, 1)
  assert.deepEqual(fetchedVoiceIds, [11])
  assert.equal(states.at(-1), 11)

  assert.equal(await controller.toggle({ id: 11, preview_url: '/voice-a.mp3' }), false)
  assert.equal(player.paused, true)
  assert.deepEqual(revokedUrls, [])
  assert.equal(states.at(-1), null)

  assert.equal(await controller.toggle({ id: 11, preview_url: '/voice-a.mp3' }), true)
  assert.equal(player.playCalls, 2)
  assert.equal(player.srcSetCalls, 1)
  assert.deepEqual(fetchedVoiceIds, [11])
  assert.equal(states.at(-1), 11)

  assert.equal(await controller.toggle({ id: 12, preview_url: '/voice-b.mp3' }), true)
  assert.equal(player.src, 'blob:voice-12')
  assert.equal(player.paused, false)
  assert.deepEqual(fetchedVoiceIds, [11, 12])
  assert.deepEqual(revokedUrls, ['blob:voice-11'])
  assert.deepEqual(states.slice(-2), [null, 12])
  assert.match(assetStepSource, /fetchPreview:\s*\(voice\)\s*=>\s*redrawAPI\.getVoicePreview/)
})

test('音色预览鉴权或下载失败时不会调用 Audio.play', async () => {
  const createVoicePreviewController = previewControllerFactory()
  const player = new FakeAudio()
  const states = []
  const errors = []
  let objectUrlCalls = 0
  const controller = createVoicePreviewController({
    createAudio: () => player,
    fetchPreview: async () => {
      const error = new Error('音色预览请求未授权')
      error.response = { status: 401 }
      throw error
    },
    createObjectURL: () => {
      objectUrlCalls += 1
      return 'blob:should-not-exist'
    },
    revokeObjectURL: () => {},
    onPlayingChange: (voiceId) => states.push(voiceId),
    onError: (error) => errors.push(error),
  })

  assert.equal(await controller.toggle({ id: 20, preview_url: '/protected.mp3' }), false)
  assert.equal(player.playCalls, 0)
  assert.equal(objectUrlCalls, 0)
  assert.equal(states.includes(20), false)
  assert.equal(states.at(-1), null)
  assert.equal(errors.length, 1)
})

test('play 拒绝、ended 与卸载都会释放 object URL、状态和音频资源', async () => {
  const createVoicePreviewController = previewControllerFactory()
  const player = new FakeAudio()
  const states = []
  const errors = []
  const revokedUrls = []
  const controller = createVoicePreviewController({
    createAudio: () => player,
    fetchPreview: async (voice) => ({ voiceId: voice.id }),
    createObjectURL: (blob) => `blob:voice-${blob.voiceId}`,
    revokeObjectURL: (url) => revokedUrls.push(url),
    onPlayingChange: (voiceId) => states.push(voiceId),
    onError: (error) => errors.push(error),
  })

  player.nextPlayError = new Error('autoplay denied')
  assert.equal(await controller.toggle({ id: 21, preview_url: '/denied.mp3' }), false)
  assert.equal(states.includes(21), false)
  assert.equal(states.at(-1), null)
  assert.equal(errors.length, 1)
  assert.deepEqual(revokedUrls, ['blob:voice-21'])

  assert.equal(await controller.toggle({ id: 22, preview_url: '/voice-c.mp3' }), true)
  player.fire('ended')
  assert.equal(states.at(-1), null)
  assert.deepEqual(revokedUrls, ['blob:voice-21', 'blob:voice-22'])

  assert.equal(await controller.toggle({ id: 23, preview_url: '/voice-d.mp3' }), true)

  controller.dispose()
  assert.equal(player.paused, true)
  assert.equal(player.listeners.has('ended'), false)
  assert.equal(player.removedSrc, true)
  assert.ok(player.loadCalls >= 1)
  assert.deepEqual(revokedUrls, ['blob:voice-21', 'blob:voice-22', 'blob:voice-23'])
  const callsBeforeDisposedToggle = player.playCalls
  assert.equal(await controller.toggle({ id: 24, preview_url: '/voice-e.mp3' }), false)
  assert.equal(player.playCalls, callsBeforeDisposedToggle)
  assert.match(assetStepSource, /onUnmounted\(\(\)\s*=>\s*\{[\s\S]*previewController\.dispose\(\)/)
})
