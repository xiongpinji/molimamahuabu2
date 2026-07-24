import test from 'node:test'
import assert from 'node:assert/strict'

import { buildStoryboardContinuityPrompt, canChainStoryboardFrames } from '../src/utils/videoContinuity.js'

test('同一场景的相邻分镜允许自动尾帧衔接', () => {
  assert.equal(
    canChainStoryboardFrames(
      { scene_id: 54, location: '巨树下的林地空处' },
      { scene_id: 54, location: '巨树下的林地空处' },
    ),
    true,
  )
})

test('不同场景不自动复用上一镜尾帧', () => {
  assert.equal(
    canChainStoryboardFrames(
      { scene_id: 55, location: '密林小道' },
      { scene_id: 54, location: '巨树下的林地空处' },
    ),
    false,
  )
})

test('视频提示词包含上一镜状态与下一镜导向', () => {
  const prompt = buildStoryboardContinuityPrompt({
    prompt: '小岚抬头看向白狐',
    current: { id: 2 },
    previous: { title: '白狐现身', result: '白狐停在树根旁与小岚对视' },
    next: { title: '密林追踪', action: '小岚跟随白狐穿过溪流' },
  })
  assert.match(prompt, /上一镜「白狐现身」/)
  assert.match(prompt, /白狐停在树根旁与小岚对视/)
  assert.match(prompt, /下一镜「密林追踪」/)
  assert.match(prompt, /小岚跟随白狐穿过溪流/)
})

test('连续性补充不突破 iCreat 中文提示词预算', () => {
  const prompt = buildStoryboardContinuityPrompt({
    prompt: '场景：' + '雨林镜头'.repeat(110),
    current: { id: 2 },
    previous: { result: '上一镜状态'.repeat(30) },
    next: { action: '下一镜动作'.repeat(30) },
  })
  assert.ok((prompt.match(/[\u3400-\u9fff]/g) || []).length <= 480)
})
