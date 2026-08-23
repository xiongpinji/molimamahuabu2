const crypto = require('crypto');

function ensureSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS rate_limit_buckets (
    bucket_key TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    count INTEGER NOT NULL,
    window_started_at INTEGER NOT NULL,
    updated_at TEXT NOT NULL
  )`);
}

function createRateLimitMiddleware(db, options = {}) {
  if (!options.enabled) return (_req, _res, next) => next();
  const limit = Number(options.limit);
  const windowMs = Number(options.windowMs);
  if (!Number.isSafeInteger(limit) || limit <= 0 || !Number.isSafeInteger(windowMs) || windowMs <= 0) {
    throw new Error('限流参数必须是正整数');
  }
  ensureSchema(db);
  const scope = String(options.scope || 'default');
  const now = options.now || Date.now;

  return (req, res, next) => {
    const identity = req.user?.id ? `user:${req.user.id}` : `ip:${req.ip || 'unknown'}`;
    const bucketKey = crypto.createHash('sha256').update(`${scope}:${identity}`).digest('hex');
    const timestamp = now();
    const result = db.transaction(() => {
      const row = db.prepare('SELECT count, window_started_at FROM rate_limit_buckets WHERE bucket_key = ?').get(bucketKey);
      if (!row || timestamp - row.window_started_at >= windowMs) {
        db.prepare(`INSERT INTO rate_limit_buckets (bucket_key, scope, count, window_started_at, updated_at)
          VALUES (?, ?, 1, ?, ?)
          ON CONFLICT(bucket_key) DO UPDATE SET count = 1, window_started_at = excluded.window_started_at, updated_at = excluded.updated_at`)
          .run(bucketKey, scope, timestamp, new Date(timestamp).toISOString());
        return { allowed: true };
      }
      if (row.count >= limit) {
        return { allowed: false, retryAfter: Math.max(1, Math.ceil((row.window_started_at + windowMs - timestamp) / 1000)) };
      }
      db.prepare('UPDATE rate_limit_buckets SET count = count + 1, updated_at = ? WHERE bucket_key = ?')
        .run(new Date(timestamp).toISOString(), bucketKey);
      return { allowed: true };
    })();
    if (result.allowed) return next();
    res.set('Retry-After', result.retryAfter);
    return res.status(429).json({
      success: false,
      error: { code: 'RATE_LIMITED', message: '请求过于频繁，请稍后重试' },
      timestamp: new Date(timestamp).toISOString(),
    });
  };
}

module.exports = { ensureSchema, createRateLimitMiddleware };
