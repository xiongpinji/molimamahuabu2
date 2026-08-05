import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const source = fs.readFileSync(path.join(__dirname, '../src/components/AIConfigContent.vue'), 'utf8')

test('USMercari 视频预设包含三个已真实生成验证的模型', () => {
  assert.match(source, /id:\s*'usmercari'[\s\S]*models:\s*\['MiniMax H3',\s*'seedance-2\.0-fast',\s*'seedance-2\.0-mini'\]/)
})

test('USMercari 预设写入异步提交和批量轮询协议', () => {
  assert.match(source, /usmercari:\s*'usmercari_media'/)
  assert.match(source, /p === 'usmercari'[\s\S]*return 'https:\/\/ai\.usmercari\.com'/)
  assert.match(source, /form\.value\.api_protocol = 'usmercari_media'/)
  assert.match(source, /form\.value\.endpoint = '\/cpa-file\/submit\/video'/)
  assert.match(source, /form\.value\.query_endpoint = '\/cpa-file\/fetch'/)
  assert.match(source, /submitPath = endpoint \|\| '\/cpa-file\/submit\/video'[\s\S]*queryPath = '\/cpa-file\/fetch'/)
})
