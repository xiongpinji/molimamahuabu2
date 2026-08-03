const test = require('node:test');
const assert = require('node:assert/strict');

const { createModelGenerationGuard, isModelGenerationRequest } = require('../src/middleware/modelGenerationGuard');

function call(guard, method, path) {
  const result = { next: false, limited: 0 };
  guard({ method, path }, {}, () => { result.next = true; });
  return result;
}

test('covers GPT, image, and video generation routes', () => {
  const guarded = [
    ['POST', '/generation/story'],
    ['POST', '/characters/8/generate-prompt'],
    ['POST', '/images/episode/3/batch'],
    ['POST', '/videos/image/12'],
    ['POST', '/storyboards/8/polish-prompt'],
    ['POST', '/scenes/8/generate-panorama-image'],
    ['POST', '/image-tools/operations'],
    ['POST', '/dramas/42/director/reference-analysis'],
    ['GET', '/storyboards/episode/3/generate'],
  ];
  for (const [method, path] of guarded) {
    assert.equal(isModelGenerationRequest({ method, path }), true, `${method} ${path}`);
  }
});

test('calls the shared limiter only for model generation routes', () => {
  let limited = 0;
  const guard = createModelGenerationGuard((_req, _res, next) => { limited += 1; next(); });
  assert.equal(call(guard, 'POST', '/generation/characters').next, true);
  assert.equal(call(guard, 'POST', '/dramas').next, true);
  assert.equal(call(guard, 'POST', '/upload/image').next, true);
  assert.equal(limited, 1);
});

test('does not treat unsupported methods or ordinary updates as generation', () => {
  assert.equal(isModelGenerationRequest({ method: 'PUT', path: '/scenes/3/generate-prompt' }), false);
  assert.equal(isModelGenerationRequest({ method: 'POST', path: '/assets' }), false);
});
