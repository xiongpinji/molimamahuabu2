'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  listStrategyPresets,
  validatePerformanceTrack,
  compileShotPrompt,
} = require('../src/services/shortDramaProductionDirector');

test('剧本分析公开四种安全创作策略且默认使用融合策略', () => {
  const presets = listStrategyPresets();

  assert.deepEqual(
    presets.map((preset) => preset.id),
    ['male', 'female', 'fusion', 'custom'],
  );
  assert.deepEqual(
    presets.filter((preset) => preset.is_default).map((preset) => preset.id),
    ['fusion'],
  );
  for (const preset of presets) {
    assert.equal(typeof preset.name, 'string');
    assert.equal(typeof preset.description, 'string');
    assert.equal(Object.hasOwn(preset, 'system_prompt'), false);
    assert.equal(Object.hasOwn(preset, 'rules'), false);
    assert.doesNotMatch(JSON.stringify(preset), /[A-Z]:\\|AI编程库|闲鱼|日入/);
  }
});

test('合法表演轨按镜头时长描述可追溯的情绪变化', () => {
  const track = {
    character_ref: 'character:lin-xia',
    initial_state: '压住悲伤，维持平静',
    trigger: '看见失踪三年的哥哥站在门外',
    beats: [
      {
        start_ms: 0,
        end_ms: 1800,
        emotion: '难以置信',
        intensity: 2,
        face: { gaze: '视线定在门外，眨眼停止', lips: '嘴唇轻微张开' },
        breath: '短暂停住呼吸',
      },
      {
        start_ms: 1800,
        end_ms: 4000,
        emotion: '悲伤松动',
        intensity: 4,
        face: { eyelids: '眼眶逐渐湿润', jaw: '下颌由绷紧转为轻颤' },
        body: '肩膀缓慢下沉',
      },
    ],
    final_state: '确认来人后落泪，但没有扑上前',
    constraints: ['不夸张嚎哭', '不突然大幅后退'],
    source_basis: ['林夏打开门，看见失踪三年的哥哥。'],
  };

  assert.equal(validatePerformanceTrack(track, { durationMs: 4000 }), track);
});

test('完整镜头结构确定性编译为可生成的通用视频提示词', () => {
  const result = compileShotPrompt({
    duration: 4,
    performance: {
      tracks: [{
        character_ref: 'character:lin-xia',
        initial_state: '克制平静',
        trigger: '门打开后看见哥哥',
        beats: [{
          start_ms: 0,
          end_ms: 4000,
          emotion: '震惊转为悲伤',
          intensity: 4,
          face: { gaze: '视线锁定门外', lips: '嘴唇微张后轻颤' },
          breath: '先屏息再缓慢呼气',
        }],
        final_state: '眼眶湿润但保持站立',
        constraints: ['不夸张嚎哭'],
        source_basis: ['林夏打开门，看见失踪三年的哥哥。'],
      }],
    },
    prompt_ir: {
      subject_anchors: ['林夏，短发，深色家居服'],
      primary_action: '林夏打开门后停住',
      scene: '雨夜的公寓门厅',
      camera: {
        shot_type: '近景',
        angle: '平视',
        movement: '缓慢推进后停止',
        composition: '门框形成画中框',
      },
      lighting: '室外冷光与室内暖光对照',
      style: '写实电影质感',
      references: [{ slot: '@图片1', role: 'character', required: true }],
      continuity: { start: '右手握住门把手', end: '仍站在门内' },
      negative_constraints: ['身份漂移', '面部闪烁'],
      safety_tags: [],
    },
  }, {
    adapter: 'generic-video',
    model: 'generic-model',
    capabilities: { max_reference_images: 1 },
  });

  assert.equal(result.adapter, 'generic-video@1.0');
  assert.equal(result.model, 'generic-model');
  assert.equal(result.score, 10);
  assert.equal(result.generation_ready, true);
  assert.deepEqual(result.unsupported, []);
  assert.match(result.prompt, /林夏打开门后停住/);
  assert.match(result.prompt, /0-4秒/);
  assert.match(result.prompt, /视线锁定门外/);
  assert.match(result.prompt, /门框形成画中框/);
  assert.match(result.negative_prompt, /身份漂移/);
});

test('Seedance 2 适配器保留参考槽位并报告模型能力边界', () => {
  const shot = {
    duration: 16,
    performance: { tracks: [] },
    prompt_ir: {
      subject_anchors: ['林夏，短发，深色家居服'],
      primary_action: '林夏打开门后停住',
      scene: '雨夜的公寓门厅',
      camera: {
        shot_type: '近景',
        angle: '平视',
        movement: '缓慢推进后停止',
        composition: '门框形成画中框',
      },
      lighting: '室外冷光与室内暖光对照',
      style: '写实电影质感',
      references: [
        { slot: '@图片1', role: 'character', required: true },
        { slot: '@图片2', role: 'start_frame', required: true },
      ],
      continuity: { start: '右手握住门把手', end: '仍站在门内' },
      negative_constraints: ['身份漂移', '面部闪烁'],
      safety_tags: [],
    },
  };

  const result = compileShotPrompt(shot, {
    adapter: 'seedance2',
    model: 'seedance-2.0',
  });

  assert.equal(result.adapter, 'seedance2@2.0');
  assert.match(result.prompt, /@图片1=character/);
  assert.match(result.prompt, /@图片2=start_frame/);
  assert.match(result.unsupported.join('\n'), /时长 16 秒超过 Seedance 2 上限 15 秒/);
  assert.equal(result.generation_ready, false);
});
