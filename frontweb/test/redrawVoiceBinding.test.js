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
const stateSource = readSource('../src/utils/redrawAssetState.js')

test('redraw API 仍保留音色列表/绑定能力供 TTS_ENABLED 临时恢复', () => {
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

test('资产步骤默认隐藏独立 TTS 音色入口，改为原生语音提示', () => {
  assert.match(stateSource, /NATIVE_VIDEO_AUDIO_NOTICE/)
  assert.match(stateSource, /已停用独立 TTS/)
  assert.doesNotMatch(stateSource, /key:\s*'voice'/)
  assert.match(assetStepSource, /NATIVE_VIDEO_AUDIO_NOTICE/)
  assert.match(assetStepSource, /native-audio-notice/)
  assert.doesNotMatch(assetStepSource, /RedrawVoicePicker/)
  assert.doesNotMatch(assetStepSource, /listProductionVoices/)
  assert.doesNotMatch(assetStepSource, /assignVoice\(/)
})

test('音色选择器组件保留严格白名单绑定合同以供临时恢复', () => {
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
