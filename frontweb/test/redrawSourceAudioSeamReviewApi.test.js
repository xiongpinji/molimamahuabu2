import { readFileSync } from 'node:fs'
import test from 'node:test'
import assert from 'node:assert/strict'

test('source-audio seam API separates read, immutable decision, and same-task resume', () => {
  const source = readFileSync(new URL('../src/api/redraw.js', import.meta.url), 'utf8')
  assert.match(source, /getSourceAudioSeamReview\(workId, options = \{\}\)[\s\S]*?request\.get\(`\/redraw\/works\/\$\{workId\}\/source-audio-seam-review`/)
  assert.match(source, /recordSourceAudioSeamDecision\(workId, body\)[\s\S]*?request\.post\(`\/redraw\/works\/\$\{workId\}\/source-audio-seam-review`, body/)
  assert.match(source, /resumeSourceAudioSeamAnalysis\(workId, body\)[\s\S]*?request\.post\(`\/redraw\/works\/\$\{workId\}\/source-audio-seam-resume`, body/)
})
