import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const requestSource = readFileSync(fileURLToPath(new URL('../src/utils/request.js', import.meta.url)), 'utf8')
const assetsApiSource = readFileSync(fileURLToPath(new URL('../src/api/assets.js', import.meta.url)), 'utf8')
const charactersApiSource = readFileSync(fileURLToPath(new URL('../src/api/characters.js', import.meta.url)), 'utf8')
const useCharactersSource = readFileSync(fileURLToPath(new URL('../src/composables/filmCreate/useCharacters.js', import.meta.url)), 'utf8')

test('请求层支持静默错误，供素材库多来源探测避免全局错误弹窗', () => {
  assert.match(requestSource, /if \(!unauthorized && !error\.config\?\.silentError\) ElMessage\.error\(msg\)/)
})

test('未登录响应不作为普通错误重复弹窗', () => {
  assert.match(requestSource, /const unauthorized = Number\(error\.response\?\.status\) === 401/)
  assert.match(requestSource, /if \(!unauthorized && !error\.config\?\.silentError\) ElMessage\.error\(msg\)/)
})

test('素材和音色 API 列表方法可透传请求配置', () => {
  assert.match(assetsApiSource, /list\(params, config = \{\}\)/)
  assert.match(assetsApiSource, /request\.get\('\/assets', \{ \.\.\.config, params: params \|\| \{\} \}\)/)
  assert.match(charactersApiSource, /listVoiceCatalog\(params, config = \{\}\)/)
  assert.match(charactersApiSource, /const requestConfig = \{ silentError: true, \.\.\.config, params: params \|\| \{\} \}/)
  assert.match(charactersApiSource, /request\.get\('\/voice-catalog', requestConfig\)/)
  assert.match(charactersApiSource, /bindVoiceCatalog\(characterId, voiceId, config = \{\}\)/)
  assert.match(charactersApiSource, /request\.post\(`\/characters\/\$\{characterId\}\/sd2-voice-catalog`, \{ voice_id: voiceId \}, config\)/)
})

test('音色目录 404 时静默降级读取项目已提取音色素材', () => {
  assert.match(charactersApiSource, /if \(status !== 404\) throw e/)
  assert.match(charactersApiSource, /request\.get\('\/assets', \{[\s\S]*silentError: true[\s\S]*type: 'audio'[\s\S]*category: 'voice'/)
  assert.match(charactersApiSource, /normalizeVoiceAssetCatalog\(items\)/)
  assert.match(charactersApiSource, /source: 'extracted_voice_asset'/)
  assert.match(charactersApiSource, /voice_local_path: asset\.local_path \|\| ''/)
  assert.match(charactersApiSource, /audio_url: asset\.url \|\| ''/)
  assert.match(charactersApiSource, /const isExtractedVoice = metadata\.source === 'storyboard_voice_extraction'/)
  assert.match(charactersApiSource, /quality_status: voiceAsset\.quality_status \|\| \(isExtractedVoice \? 'requires_preview_confirmation' : null\)/)
  assert.match(charactersApiSource, /quality_notice: qualityNotice/)
  assert.match(charactersApiSource, /不是真实说话人分离/)
})

test('音色目录和旧素材接口均 404 时返回空列表而不是触发全局错误', () => {
  assert.match(charactersApiSource, /catch \(fallbackError\) \{/)
  assert.match(charactersApiSource, /if \(fallbackError\?\.response\?\.status !== 404\) throw fallbackError/)
  assert.match(charactersApiSource, /items: \[\]/)
  assert.match(charactersApiSource, /unavailable: true/)
  assert.match(charactersApiSource, /音色库接口暂不可用，请确认后端已更新并重启/)
})

test('角色页打开音色库时显式静默探测并降级提示', () => {
  assert.match(useCharactersSource, /characterAPI\.listVoiceCatalog\(\{ drama_id: dramaId\.value \}, \{ silentError: true \}\)/)
  assert.match(useCharactersSource, /if \(res\?\.unavailable\) ElMessage\.warning\(res\.message \|\| '音色库接口暂不可用'\)/)
})

test('角色页绑定音色时静默处理 404 并给出后端更新提示', () => {
  assert.match(useCharactersSource, /characterAPI\.bindVoiceCatalog\(char\.id, item\.id, \{ silentError: true \}\)/)
  assert.match(useCharactersSource, /const status = e\?\.response\?\.status/)
  assert.match(useCharactersSource, /status === 404 \? '音色绑定接口暂不可用，请确认后端已更新并重启'/)
})
