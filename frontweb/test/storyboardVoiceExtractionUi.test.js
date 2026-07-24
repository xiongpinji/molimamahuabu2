import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const source = readFileSync(fileURLToPath(new URL('../src/views/FilmCreate.vue', import.meta.url)), 'utf8')

test('分镜音色提取明确混合音轨边界并要求试听确认', () => {
  assert.match(source, /title="按剧本对白顺序和静音切点提取，非声纹\/说话人分离；背景音乐或环境音可能残留，请试听确认"/)
  assert.match(source, /不是真实说话人分离/)
  assert.match(source, /重叠对白、背景音乐或环境音可能残留/)
  assert.match(source, /无法可靠切分时系统会阻止写入/)
  assert.match(source, /该结果非说话人分离，请试听确认/)
  assert.match(source, /storyboardsAPI\.extractVoice\(sb\.id, \{ video_id: video\.id, character_id: characterId \}\)/)
})
