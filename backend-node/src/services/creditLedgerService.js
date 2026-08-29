const { randomUUID } = require('crypto');
const dailyBonus = require('./dailyRechargeBonusService');

function upgradeAdjustmentEventTypes(db) {
  const table = db.prepare(`SELECT sql FROM sqlite_master
    WHERE type = 'table' AND name = 'tenant_credit_adjustments'`).get();
  if (!table || String(table.sql).includes("'recharge'")) return;
  // SQLite 不能直接修改 CHECK 约束，因此在单个事务内重建并保留历史流水。
  db.transaction(() => {
    db.exec(`
      DROP INDEX IF EXISTS idx_credit_adjustments_tenant_created;
      ALTER TABLE tenant_credit_adjustments RENAME TO tenant_credit_adjustments_legacy;
      CREATE TABLE tenant_credit_adjustments (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        actor_user_id TEXT,
        event_type TEXT NOT NULL CHECK (event_type IN ('redeem', 'admin_adjust', 'recharge')),
        amount INTEGER NOT NULL CHECK (amount != 0),
        reason TEXT NOT NULL,
        reference_type TEXT NOT NULL,
        reference_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (tenant_id, reference_type, reference_id)
      );
      INSERT INTO tenant_credit_adjustments
        (id, tenant_id, actor_user_id, event_type, amount, reason,
          reference_type, reference_id, created_at)
        SELECT id, tenant_id, actor_user_id, event_type, amount, reason,
          reference_type, reference_id, created_at
        FROM tenant_credit_adjustments_legacy;
      DROP TABLE tenant_credit_adjustments_legacy;
      CREATE INDEX idx_credit_adjustments_tenant_created
        ON tenant_credit_adjustments(tenant_id, created_at DESC);
    `);
  })();
}

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS credit_accounts (
      user_id TEXT PRIMARY KEY,
      available INTEGER NOT NULL DEFAULT 0 CHECK (available >= 0),
      held INTEGER NOT NULL DEFAULT 0 CHECK (held >= 0),
      spent INTEGER NOT NULL DEFAULT 0 CHECK (spent >= 0),
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS usage_reservations (
      id TEXT PRIMARY KEY,
      operation_key TEXT NOT NULL UNIQUE,
      user_id TEXT NOT NULL,
      model TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      amount INTEGER NOT NULL CHECK (amount > 0),
      status TEXT NOT NULL CHECK (status IN ('held','confirmed','refunded')),
      reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS credit_ledger (
      id TEXT PRIMARY KEY,
      reservation_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      event_type TEXT NOT NULL CHECK (event_type IN ('reserve','confirm','refund')),
      available_delta INTEGER NOT NULL,
      held_delta INTEGER NOT NULL,
      spent_delta INTEGER NOT NULL,
      reason TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (reservation_id, event_type)
    );
    CREATE TABLE IF NOT EXISTS tenant_credit_accounts (
      tenant_id TEXT PRIMARY KEY,
      available INTEGER NOT NULL DEFAULT 0 CHECK (available >= 0),
      held INTEGER NOT NULL DEFAULT 0 CHECK (held >= 0),
      spent INTEGER NOT NULL DEFAULT 0 CHECK (spent >= 0),
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tenant_usage_reservations (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      operation_key TEXT NOT NULL,
      actor_user_id TEXT,
      model TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      amount INTEGER NOT NULL CHECK (amount > 0),
      status TEXT NOT NULL CHECK (status IN ('held','confirmed','refunded')),
      reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (tenant_id, operation_key)
    );
    CREATE TABLE IF NOT EXISTS tenant_credit_ledger (
      id TEXT PRIMARY KEY,
      reservation_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      actor_user_id TEXT,
      event_type TEXT NOT NULL CHECK (event_type IN ('reserve','confirm','refund')),
      available_delta INTEGER NOT NULL,
      held_delta INTEGER NOT NULL,
      spent_delta INTEGER NOT NULL,
      reason TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (reservation_id, event_type)
    );
    CREATE TABLE IF NOT EXISTS tenant_credit_adjustments (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      actor_user_id TEXT,
      event_type TEXT NOT NULL CHECK (event_type IN ('redeem', 'admin_adjust', 'recharge')),
      amount INTEGER NOT NULL CHECK (amount != 0),
      reason TEXT NOT NULL,
      reference_type TEXT NOT NULL,
      reference_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (tenant_id, reference_type, reference_id)
    );
    CREATE INDEX IF NOT EXISTS idx_credit_adjustments_tenant_created
      ON tenant_credit_adjustments(tenant_id, created_at DESC);
  `);
  upgradeAdjustmentEventTypes(db);
  dailyBonus.ensureSchema(db);
}

function getAccount(db, userId) {
  return db.prepare('SELECT user_id, available, held, spent FROM credit_accounts WHERE user_id = ?').get(String(userId)) || null;
}

function setAccountBalance(db, userId, available) {
  const amount = Number(available);
  if (!Number.isSafeInteger(amount) || amount < 0) throw new Error('available 必须是非负整数');
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO credit_accounts (user_id, available, held, spent, updated_at)
    VALUES (?, ?, 0, 0, ?)
    ON CONFLICT(user_id) DO UPDATE SET available = excluded.available, updated_at = excluded.updated_at`)
    .run(String(userId), amount, now);
  return getAccount(db, userId);
}

function getTenantAccount(db, tenantId, nowValue = Date.now()) {
  ensureSchema(db);
  const id = String(tenantId);
  const permanent = db.prepare(`SELECT tenant_id, available, held, spent
    FROM tenant_credit_accounts WHERE tenant_id = ?`).get(id) || null;
  const daily = dailyBonus.getDailyBonusState(db, id, nowValue);
  if (!permanent && !daily.membership) return null;
  return {
    tenant_id: id,
    available: (permanent?.available || 0) + daily.available,
    held: permanent?.held || 0,
    spent: permanent?.spent || 0,
  };
}

function getTenantAccountBreakdown(db, tenantId, nowValue = Date.now()) {
  ensureSchema(db);
  const id = String(tenantId);
  const permanent = db.prepare(`SELECT tenant_id, available, held, spent
    FROM tenant_credit_accounts WHERE tenant_id = ?`).get(id) || null;
  const daily = dailyBonus.getDailyBonusState(db, id, nowValue);
  return {
    tenant_id: id,
    available: (permanent?.available || 0) + daily.available,
    held: permanent?.held || 0,
    spent: permanent?.spent || 0,
    permanent_available: permanent?.available || 0,
    daily_bonus_available: daily.available,
    daily_bonus_expires_at: daily.expiresAt,
    membership_ends_on: daily.membershipEndsOn,
  };
}

function setTenantAccountBalance(db, tenantId, available) {
  ensureSchema(db);
  const amount = Number(available);
  if (!Number.isSafeInteger(amount) || amount < 0) throw new Error('available 必须是非负整数');
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO tenant_credit_accounts (tenant_id, available, held, spent, updated_at)
    VALUES (?, ?, 0, 0, ?)
    ON CONFLICT(tenant_id) DO UPDATE SET available = excluded.available, updated_at = excluded.updated_at`)
    .run(String(tenantId), amount, now);
  return getTenantAccount(db, tenantId);
}

function adjustTenantBalance(db, input) {
  ensureSchema(db);
  const tenantId = String(input.tenantId || '').trim();
  const amount = Number(input.amount);
  const eventType = String(input.eventType || '');
  const reason = String(input.reason || '').trim();
  const referenceType = String(input.referenceType || '').trim();
  const referenceId = String(input.referenceId || '').trim();
  if (!tenantId || !Number.isSafeInteger(amount) || amount === 0) {
    throw new Error('积分调整参数无效');
  }
  if (!['redeem', 'admin_adjust', 'recharge'].includes(eventType)) throw new Error('积分调整类型无效');
  if (!reason || reason.length > 240 || !referenceType || !referenceId) {
    throw new Error('积分调整原因或引用无效');
  }
  return db.transaction(() => {
    const existing = db.prepare(`SELECT * FROM tenant_credit_adjustments
      WHERE tenant_id = ? AND reference_type = ? AND reference_id = ?`)
      .get(tenantId, referenceType, referenceId);
    if (existing) return existing;
    const now = new Date().toISOString();
    db.prepare(`INSERT OR IGNORE INTO tenant_credit_accounts
      (tenant_id, available, held, spent, updated_at) VALUES (?, 0, 0, 0, ?)`)
      .run(tenantId, now);
    const changed = amount > 0
      ? db.prepare(`UPDATE tenant_credit_accounts
        SET available = available + ?, updated_at = ? WHERE tenant_id = ?`)
        .run(amount, now, tenantId)
      : db.prepare(`UPDATE tenant_credit_accounts
        SET available = available - ?, updated_at = ?
        WHERE tenant_id = ? AND available >= ?`)
        .run(Math.abs(amount), now, tenantId, Math.abs(amount));
    if (changed.changes !== 1) {
      const error = new Error('可用积分不足，不能完成扣减');
      error.code = 'INSUFFICIENT_CREDITS';
      throw error;
    }
    const row = {
      id: randomUUID(),
      tenant_id: tenantId,
      actor_user_id: input.actorUserId == null ? null : String(input.actorUserId),
      event_type: eventType,
      amount,
      reason,
      reference_type: referenceType,
      reference_id: referenceId,
      created_at: now,
    };
    db.prepare(`INSERT INTO tenant_credit_adjustments
      (id, tenant_id, actor_user_id, event_type, amount, reason,
        reference_type, reference_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        row.id, row.tenant_id, row.actor_user_id, row.event_type, row.amount,
        row.reason, row.reference_type, row.reference_id, row.created_at,
      );
    return row;
  })();
}

function listTenantAdjustments(db, tenantId, limitValue = 100) {
  ensureSchema(db);
  const limit = Math.min(Math.max(Number.parseInt(limitValue, 10) || 100, 1), 500);
  return db.prepare(`SELECT *
    FROM (
      SELECT id, tenant_id, actor_user_id, event_type, amount,
        reason, reference_type, reference_id, created_at,
        NULL AS model, NULL AS resource_type, NULL AS resource_id
      FROM tenant_credit_adjustments
      WHERE tenant_id = ?
      UNION ALL
      SELECT ledger.id, ledger.tenant_id, ledger.actor_user_id, ledger.event_type,
        -ledger.spent_delta AS amount,
        COALESCE(ledger.reason, reservation.reason, 'generation_completed') AS reason,
        'usage_reservation' AS reference_type,
        ledger.reservation_id AS reference_id,
        ledger.created_at,
        reservation.model,
        reservation.resource_type,
        reservation.resource_id
      FROM tenant_credit_ledger AS ledger
      JOIN tenant_usage_reservations AS reservation
        ON reservation.id = ledger.reservation_id
      WHERE ledger.tenant_id = ? AND ledger.event_type = 'confirm'
    )
    ORDER BY created_at DESC
    LIMIT ?`).all(String(tenantId), String(tenantId), limit);
}

function getReservation(db, id) {
  ensureSchema(db);
  return db.prepare('SELECT * FROM usage_reservations WHERE id = ?').get(String(id))
    || db.prepare('SELECT * FROM tenant_usage_reservations WHERE id = ?').get(String(id))
    || null;
}

function normalizeReservationScope(scope = {}) {
  const tenantId = scope.tenantId == null ? '' : String(scope.tenantId).trim();
  const userId = scope.userId == null ? '' : String(scope.userId).trim();
  if (Boolean(tenantId) === Boolean(userId)) throw new Error('额度预扣作用域不明确');
  return tenantId ? { tenantId } : { userId };
}

function getReservationForScope(db, id, scope) {
  ensureSchema(db);
  const normalized = normalizeReservationScope(scope);
  if (normalized.tenantId) {
    return db.prepare(`SELECT * FROM tenant_usage_reservations
      WHERE id = ? AND tenant_id = ?`).get(String(id), normalized.tenantId) || null;
  }
  return db.prepare(`SELECT * FROM usage_reservations
    WHERE id = ? AND user_id = ?`).get(String(id), normalized.userId) || null;
}

function validateReservationInput(input) {
  const amount = Number(input.amount);
  const accountId = input.tenantId || input.userId;
  if (!accountId || !input.operationKey || !input.model || !input.resourceType || input.resourceId == null) {
    throw new Error('预扣参数不完整');
  }
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('amount 必须是正整数');
  return amount;
}

function assertMatchingReservation(existing, input) {
  const sameScope = existing.tenant_id
    ? existing.tenant_id === String(input.tenantId)
    : existing.user_id === String(input.userId);
  const sameRequest = sameScope
    && existing.model === String(input.model)
    && existing.resource_type === String(input.resourceType)
    && existing.resource_id === String(input.resourceId);
  if (sameRequest) return existing;
  const error = new Error('同一积分预扣请求不能修改账户、模型或资源');
  error.code = 'CREDIT_RESERVATION_IDEMPOTENCY_CONFLICT';
  throw error;
}

function reserve(db, input) {
  ensureSchema(db);
  const amount = validateReservationInput(input);
  if (input.tenantId) return reserveTenant(db, input, amount);
  return db.transaction(() => {
    const existing = db.prepare('SELECT * FROM usage_reservations WHERE operation_key = ?').get(String(input.operationKey));
    if (existing) return assertMatchingReservation(existing, input);
    return createUserReservation(db, input, amount);
  })();
}

function reserveTenant(db, input, amount) {
  return db.transaction(() => {
    const tenantId = String(input.tenantId);
    const operationKey = String(input.operationKey);
    const existing = db.prepare(`SELECT * FROM tenant_usage_reservations
      WHERE tenant_id = ? AND operation_key = ?`).get(tenantId, operationKey);
    if (existing) return assertMatchingReservation(existing, input);
    return createTenantReservation(db, input, amount);
  }).immediate();
}

function createUserReservation(db, input, amount) {
  const now = new Date().toISOString();
  const changed = db.prepare(`UPDATE credit_accounts
    SET available = available - ?, held = held + ?, updated_at = ?
    WHERE user_id = ? AND available >= ?`)
    .run(amount, amount, now, String(input.userId), amount);
  if (changed.changes !== 1) {
    const error = new Error('额度不足');
    error.code = 'INSUFFICIENT_CREDITS';
    throw error;
  }
  const id = randomUUID();
  db.prepare(`INSERT INTO usage_reservations
    (id, operation_key, user_id, model, resource_type, resource_id, amount, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'held', ?, ?)`)
    .run(id, String(input.operationKey), String(input.userId), String(input.model), String(input.resourceType), String(input.resourceId), amount, now, now);
  db.prepare(`INSERT INTO credit_ledger
    (id, reservation_id, user_id, event_type, available_delta, held_delta, spent_delta, created_at)
    VALUES (?, ?, ?, 'reserve', ?, ?, 0, ?)`)
    .run(randomUUID(), id, String(input.userId), -amount, amount, now);
  return getReservation(db, id);
}

function createTenantReservation(db, input, amount) {
  const tenantId = String(input.tenantId);
  const now = new Date(input.now ?? Date.now()).toISOString();
  db.prepare(`INSERT OR IGNORE INTO tenant_credit_accounts
    (tenant_id, available, held, spent, updated_at) VALUES (?, 0, 0, 0, ?)`)
    .run(tenantId, now);
  const daily = dailyBonus.getDailyBonusState(db, tenantId, input.now ?? Date.now());
  const bonusAmount = Math.min(amount, daily.available);
  const permanentAmount = amount - bonusAmount;
  const changed = db.prepare(`UPDATE tenant_credit_accounts
    SET available = available - ?, held = held + ?, updated_at = ?
    WHERE tenant_id = ? AND available >= ?`)
    .run(permanentAmount, amount, now, tenantId, permanentAmount);
  if (changed.changes !== 1) {
    const error = new Error('额度不足');
    error.code = 'INSUFFICIENT_CREDITS';
    throw error;
  }
  if (bonusAmount > 0) {
    const bonusChanged = db.prepare(`UPDATE tenant_daily_bonus_buckets
      SET available = available - ?, held = held + ?, updated_at = ?
      WHERE id = ? AND available >= ?`)
      .run(bonusAmount, bonusAmount, now, daily.bucketId, bonusAmount);
    if (bonusChanged.changes !== 1) throw new Error('每日赠送积分状态不一致');
  }
  const id = randomUUID();
  const actorUserId = input.actorUserId || input.userId || null;
  db.prepare(`INSERT INTO tenant_usage_reservations
    (id, tenant_id, operation_key, actor_user_id, model, resource_type, resource_id, amount, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'held', ?, ?)`)
    .run(id, tenantId, String(input.operationKey), actorUserId == null ? null : String(actorUserId),
      String(input.model), String(input.resourceType), String(input.resourceId), amount, now, now);
  db.prepare(`INSERT INTO tenant_usage_reservation_allocations
    (reservation_id, tenant_id, bonus_bucket_id, bonus_amount, permanent_amount, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run(id, tenantId, daily.bucketId, bonusAmount, permanentAmount, now);
  db.prepare(`INSERT INTO tenant_credit_ledger
    (id, reservation_id, tenant_id, actor_user_id, event_type, available_delta, held_delta, spent_delta, created_at)
    VALUES (?, ?, ?, ?, 'reserve', ?, ?, 0, ?)`)
    .run(randomUUID(), id, tenantId, actorUserId == null ? null : String(actorUserId), -amount, amount, now);
  return getReservation(db, id);
}

function claim(db, input) {
  ensureSchema(db);
  const amount = validateReservationInput(input);
  return db.transaction(() => {
    const existing = input.tenantId
      ? db.prepare(`SELECT * FROM tenant_usage_reservations
        WHERE tenant_id = ? AND operation_key = ?`).get(String(input.tenantId), String(input.operationKey))
      : db.prepare('SELECT * FROM usage_reservations WHERE operation_key = ?').get(String(input.operationKey));
    if (existing) {
      return { reservation: assertMatchingReservation(existing, input, amount), created: false };
    }
    let reservation = input.tenantId
      ? createTenantReservation(db, input, amount)
      : createUserReservation(db, input, amount);
    if (typeof input.onCreated === 'function') {
      try {
        input.onCreated(reservation);
      } catch (error) {
        reservation = reservation.tenant_id
          ? settleTenant(db, reservation, 'refunded', error?.code || 'claim_failed')
          : settleUser(db, reservation, 'refunded', error?.code || 'claim_failed');
        return { reservation, created: true, error };
      }
    }
    return { reservation, created: true };
  }).immediate();
}

function settle(db, reservationId, target, reason, nowValue = Date.now()) {
  return db.transaction(() => {
    const row = getReservation(db, reservationId);
    if (!row) throw new Error('额度预扣记录不存在');
    if (row.status !== 'held') return row;
    if (row.tenant_id) return settleTenant(db, row, target, reason, nowValue);
    return settleUser(db, row, target, reason);
  })();
}

function settleForScope(db, reservationId, scope, target, reason) {
  const normalized = normalizeReservationScope(scope);
  return db.transaction(() => {
    const row = getReservationForScope(db, reservationId, normalized);
    if (!row) throw new Error('额度预扣记录不存在');
    if (row.status !== 'held') return row;
    return normalized.tenantId
      ? settleTenant(db, row, target, reason)
      : settleUser(db, row, target, reason);
  })();
}

function settleUser(db, row, target, reason) {
  const now = new Date().toISOString();
  if (target === 'confirmed') {
    db.prepare(`UPDATE credit_accounts SET held = held - ?, spent = spent + ?, updated_at = ? WHERE user_id = ? AND held >= ?`)
      .run(row.amount, row.amount, now, row.user_id, row.amount);
  } else {
    db.prepare(`UPDATE credit_accounts SET held = held - ?, available = available + ?, updated_at = ? WHERE user_id = ? AND held >= ?`)
      .run(row.amount, row.amount, now, row.user_id, row.amount);
  }
  db.prepare('UPDATE usage_reservations SET status = ?, reason = ?, updated_at = ? WHERE id = ? AND status = ?')
    .run(target, reason || null, now, row.id, 'held');
  db.prepare(`INSERT OR IGNORE INTO credit_ledger
    (id, reservation_id, user_id, event_type, available_delta, held_delta, spent_delta, reason, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      randomUUID(), row.id, row.user_id, target === 'confirmed' ? 'confirm' : 'refund',
      target === 'confirmed' ? 0 : row.amount,
      -row.amount,
      target === 'confirmed' ? row.amount : 0,
      reason || null,
      now
    );
  return getReservationForScope(db, row.id, { userId: row.user_id });
}

function settleTenant(db, row, target, reason, nowValue = Date.now()) {
  const now = new Date(nowValue).toISOString();
  const allocation = db.prepare(`SELECT * FROM tenant_usage_reservation_allocations
    WHERE reservation_id = ?`).get(row.id) || {
    bonus_bucket_id: null,
    bonus_amount: 0,
    permanent_amount: row.amount,
  };
  const changed = target === 'confirmed'
    ? db.prepare(`UPDATE tenant_credit_accounts
      SET held = held - ?, spent = spent + ?, updated_at = ?
      WHERE tenant_id = ? AND held >= ?`).run(row.amount, row.amount, now, row.tenant_id, row.amount)
    : db.prepare(`UPDATE tenant_credit_accounts
      SET held = held - ?, available = available + ?, updated_at = ?
      WHERE tenant_id = ? AND held >= ?`).run(
      row.amount, allocation.permanent_amount, now, row.tenant_id, row.amount,
    );
  if (changed.changes !== 1) throw new Error('租户额度账户状态不一致');
  let refundedBonusAmount = 0;
  if (allocation.bonus_amount > 0) {
    const bucket = db.prepare('SELECT * FROM tenant_daily_bonus_buckets WHERE id = ?')
      .get(allocation.bonus_bucket_id);
    if (!bucket || bucket.held < allocation.bonus_amount) {
      throw new Error('每日赠送积分冻结状态不一致');
    }
    if (target === 'confirmed') {
      db.prepare(`UPDATE tenant_daily_bonus_buckets
        SET held = held - ?, spent = spent + ?, updated_at = ? WHERE id = ?`)
        .run(allocation.bonus_amount, allocation.bonus_amount, now, bucket.id);
    } else if (bucket.benefit_date === dailyBonus.shanghaiBusinessDate(nowValue)) {
      db.prepare(`UPDATE tenant_daily_bonus_buckets
        SET held = held - ?, available = available + ?, updated_at = ? WHERE id = ?`)
        .run(allocation.bonus_amount, allocation.bonus_amount, now, bucket.id);
      refundedBonusAmount = allocation.bonus_amount;
    } else {
      db.prepare(`UPDATE tenant_daily_bonus_buckets
        SET held = held - ?, expired = expired + ?, updated_at = ? WHERE id = ?`)
        .run(allocation.bonus_amount, allocation.bonus_amount, now, bucket.id);
    }
  }
  db.prepare(`UPDATE tenant_usage_reservations
    SET status = ?, reason = ?, updated_at = ? WHERE id = ? AND status = 'held'`)
    .run(target, reason || null, now, row.id);
  db.prepare(`INSERT OR IGNORE INTO tenant_credit_ledger
    (id, reservation_id, tenant_id, actor_user_id, event_type,
      available_delta, held_delta, spent_delta, reason, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      randomUUID(), row.id, row.tenant_id, row.actor_user_id,
      target === 'confirmed' ? 'confirm' : 'refund',
      target === 'confirmed' ? 0 : allocation.permanent_amount + refundedBonusAmount,
      -row.amount,
      target === 'confirmed' ? row.amount : 0,
      reason || null,
      now,
    );
  return getReservationForScope(db, row.id, { tenantId: row.tenant_id });
}

function confirm(db, reservationId, nowValue = Date.now()) {
  return settle(db, reservationId, 'confirmed', 'generation_completed', nowValue);
}

function refund(db, reservationId, reason, nowValue = Date.now()) {
  return settle(db, reservationId, 'refunded', reason || 'generation_failed', nowValue);
}

function confirmForScope(db, reservationId, scope) {
  return settleForScope(db, reservationId, scope, 'confirmed', 'generation_completed');
}

function refundForScope(db, reservationId, scope, reason) {
  return settleForScope(db, reservationId, scope, 'refunded', reason || 'generation_failed');
}

function settleGeneration(db, reservationId, outcome, message = '', failure = {}) {
  if (!reservationId) return null;
  if (outcome === 'completed') return confirm(db, reservationId);
  if (outcome !== 'failed') throw new Error('不支持的生成结算状态');

  const failureDisposition = failure && typeof failure === 'object'
    ? String(failure.failureDisposition || '').trim()
    : '';
  if (failureDisposition === 'hold') return getReservation(db, reservationId);
  if (failureDisposition === 'refund') {
    return refund(db, reservationId, message || 'generation_failed');
  }
  if (failureDisposition) throw new Error('不支持的生成失败结算方式');

  const uncertaintyMarkers = ['结果未知', '状态未知', '最终状态未知', '供应商任务仍可能处理中'];
  if (uncertaintyMarkers.some((marker) => String(message).includes(marker))) {
    return getReservation(db, reservationId);
  }
  return refund(db, reservationId, message || 'generation_failed');
}

module.exports = {
  ensureSchema,
  setAccountBalance,
  getAccount,
  setTenantAccountBalance,
  getTenantAccount,
  getTenantAccountBreakdown,
  adjustTenantBalance,
  listTenantAdjustments,
  getReservation,
  getReservationForScope,
  claim,
  reserve,
  confirm,
  refund,
  confirmForScope,
  refundForScope,
  settleGeneration,
};
