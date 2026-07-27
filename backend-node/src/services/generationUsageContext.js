const { AsyncLocalStorage } = require('async_hooks');

const storage = new AsyncLocalStorage();

function activate(billing) {
  if (billing) storage.enterWith(billing);
}

function capture(rawUsage) {
  const billing = storage.getStore();
  if (!billing || !rawUsage) return;
  const inputTokens = Math.max(0, Math.trunc(Number(
    rawUsage.input_tokens ?? rawUsage.prompt_tokens,
  ) || 0));
  const outputTokens = Math.max(0, Math.trunc(Number(
    rawUsage.output_tokens ?? rawUsage.completion_tokens,
  ) || 0));
  const reasoningTokens = Math.max(0, Math.trunc(Number(
    rawUsage.output_tokens_details?.reasoning_tokens
      ?? rawUsage.completion_tokens_details?.reasoning_tokens,
  ) || 0));
  billing.usage = {
    inputTokens,
    outputTokens,
    reasoningTokens,
    source: 'provider',
  };
}

function clear(billing) {
  if (storage.getStore() === billing) storage.enterWith(null);
}

module.exports = {
  activate,
  capture,
  clear,
};
