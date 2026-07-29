const test = require('node:test');
const assert = require('node:assert/strict');

const aiClient = require('../src/services/aiClient');

test('responses payload extracts output text from both supported shapes', () => {
  assert.equal(aiClient.extractTextResponseContent({ output_text: 'direct' }), 'direct');
  assert.equal(aiClient.extractTextResponseContent({
    output: [{ content: [{ type: 'output_text', text: 'nested' }] }],
  }), 'nested');
});

test('responses request uses input and max_output_tokens', () => {
  assert.deepEqual(aiClient.buildResponsesBody({
    model: 'gpt-5.6-sol',
    prompt: 'hello',
    systemPrompt: 'system',
    maxTokens: 32,
  }), {
    model: 'gpt-5.6-sol',
    input: 'hello',
    instructions: 'system',
    max_output_tokens: 32,
  });
});
