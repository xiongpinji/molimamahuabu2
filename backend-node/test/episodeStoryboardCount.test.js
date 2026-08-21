const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  storyboardCountMatchesTarget,
  buildStoryboardCountCorrectionPrompt,
} = require('../src/services/episodeStoryboardService');

describe('storyboard count enforcement', () => {
  it('rejects an AI result whose count differs from the user target', () => {
    assert.equal(storyboardCountMatchesTarget([{ shot_number: 1 }, { shot_number: 2 }], 2), true);
    assert.equal(storyboardCountMatchesTarget(new Array(8).fill({}), 4), false);
  });

  it('builds a correction request that requires the exact target count', () => {
    const prompt = buildStoryboardCountCorrectionPrompt(
      [{ shot_number: 1, title: '开场' }, { shot_number: 2, title: '转折' }],
      1
    );
    assert.match(prompt, /恰好 1 个分镜/);
    assert.match(prompt, /不得增加或遗漏剧情/);
    assert.match(prompt, /"title":"开场"/);
  });
});
