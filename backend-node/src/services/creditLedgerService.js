const { randomUUID } = require('crypto');

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

function getTenantAccount(db, tenantId) {
  ensureSchema(db);
  return db.prepare(`SELECT tenant_id, available, held, spent
    FROM tenant_credit_accounts WHERE tenant_id = ?`).get(String(tenantId)) || null;
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

function validateReservationInput(input) {
  const amount = Number(input.amount);
  const accountId = input.tenantId || input.userId;
  if (!accountId || !input.operationKey || !input.model || !input.resourceType || input.resourceId == null) {
    throw new Error('预扣参数不完整');
  }
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('amount 必须是正整数');
  return amount;
}

function reserve(db, input) {
  ensureSchema(db);
  const amount = validateReservationInput(input);
  if (input.tenantId) return reserveTenant(db, input, amount);
  return db.transaction(() => {
    const existing = db.prepare('SELECT * FROM usage_reservations WHERE operation_key = ?').get(String(input.operationKey));
    if (existing) return existing;
    return createUserReservation(db, input, amount);
  })();
}

function reserveTenant(db, input, amount) {
  return db.transaction(() => {
    const tenantId = String(input.tenantId);
    const operationKey = String(input.operationKey);
    const existing = db.prepare(`SELECT * FROM tenant_usage_reservations
      WHERE tenant_id = ? AND operation_key = ?`).get(tenantId, operationKey);
    if (existing) return existing;
    return createTenantReservation(db, input, amount);
  })();
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
  const now = new Date().toISOString();
  const changed = db.prepare(`UPDATE tenant_credit_accounts
    SET available = available - ?, held = held + ?, updated_at = ?
    WHERE tenant_id = ? AND available >= ?`)
    .run(amount, amount, now, tenantId, amount);
  if (changed.changes !== 1) {
    const error = new Error('额度不足');
    error.code = 'INSUFFICIENT_CREDITS';
    throw error;
  }
  const id = randomUUID();
  const actorUserId = input.actorUserId || input.userId || null;
  db.prepare(`INSERT INTO tenant_usage_reservations
    (id, tenant_id, operation_key, actor_user_id, model, resource_type, resource_id, amount, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'held', ?, ?)`)
    .run(id, tenantId, String(input.operationKey), actorUserId == null ? null : String(actorUserId),
      String(input.model), String(input.resourceType), String(input.resourceId), amount, now, now);
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
    if (existing) return { reservation: existing, created: false };
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

function settle(db, reservationId, target, reason) {
  return db.transaction(() => {
    const row = getReservation(db, reservationId);
    if (!row) throw new Error('额度预扣记录不存在');
    if (row.status !== 'held') return row;
    if (row.tenant_id) return settleTenant(db, row, target, reason);
    return settleUser(db, row, target, reason);
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
  return getReservation(db, row.id);
}

function settleTenant(db, row, target, reason) {
  const now = new Date().toISOString();
  const changed = target === 'confirmed'
    ? db.prepare(`UPDATE tenant_credit_accounts
      SET held = held - ?, spent = spent + ?, updated_at = ?
      WHERE tenant_id = ? AND held >= ?`).run(row.amount, row.amount, now, row.tenant_id, row.amount)
    : db.prepare(`UPDATE tenant_credit_accounts
      SET held = held - ?, available = available + ?, updated_at = ?
      WHERE tenant_id = ? AND held >= ?`).run(row.amount, row.amount, now, row.tenant_id, row.amount);
  if (changed.changes !== 1) throw new Error('租户额度账户状态不一致');
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
      target === 'confirmed' ? 0 : row.amount,
      -row.amount,
      target === 'confirmed' ? row.amount : 0,
      reason || null,
      now,
    );
  return getReservation(db, row.id);
}

function confirm(db, reservationId) {
  return settle(db, reservationId, 'confirmed', 'generation_completed');
}

function refund(db, reservationId, reason) {
  return settle(db, reservationId, 'refunded', reason || 'generation_failed');
}

function settleGeneration(db, reservationId, outcome, message = '') {
  if (!reservationId) return null;
  if (outcome === 'completed') return confirm(db, reservationId);
  if (outcome !== 'failed') throw new Error('不支持的生成结算状态');

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
  adjustTenantBalance,
  listTenantAdjustments,
  getReservation,
  claim,
  reserve,
  confirm,
  refund,
  settleGeneration,
};
