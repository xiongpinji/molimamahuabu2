const DEFAULT_LIMITS = {
  text: 12,
  image: 8,
  video: 6,
  redraw_video: 3,
};

const states = new Map();

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function getState(scope) {
  if (!states.has(scope)) states.set(scope, { active: 0, queue: [] });
  return states.get(scope);
}

function runWithGenerationLimit(scope, operation, env = process.env) {
  const normalizedScope = String(scope || '').toLowerCase();
  const fallback = DEFAULT_LIMITS[normalizedScope];
  if (!fallback) throw new Error(`Unsupported generation scope: ${scope}`);
  if (typeof operation !== 'function') throw new Error('Generation operation must be a function');

  const configuredLimit = positiveInteger(env[`GENERATION_${normalizedScope.toUpperCase()}_CONCURRENCY`], fallback);
  const limit = normalizedScope === 'redraw_video' ? Math.min(configuredLimit, 8) : configuredLimit;
  const maxQueue = positiveInteger(
    env[`GENERATION_${normalizedScope.toUpperCase()}_MAX_QUEUE_SIZE`] ?? env.GENERATION_MAX_QUEUE_SIZE,
    300,
  );
  const state = getState(normalizedScope);

  return new Promise((resolve, reject) => {
    const execute = () => {
      state.active += 1;
      Promise.resolve()
        .then(operation)
        .then(resolve, reject)
        .finally(() => {
          state.active -= 1;
          state.queue.shift()?.();
        });
    };

    if (state.active < limit) {
      execute();
      return;
    }
    if (state.queue.length >= maxQueue) {
      const error = new Error('生成队列已满，请稍后重试');
      error.code = 'GENERATION_QUEUE_FULL';
      reject(error);
      return;
    }
    state.queue.push(execute);
  });
}

function resetGenerationConcurrencyForTests() {
  states.clear();
}

module.exports = { runWithGenerationLimit, resetGenerationConcurrencyForTests };
