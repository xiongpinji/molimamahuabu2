const { createHash } = require('node:crypto');

const creditLedger = require('./creditLedgerService');
const localizationService = require('./localizationService');
const modelPrice = require('./modelPriceService');
const redrawCapability = require('./redrawCapabilityService');
const taskService = require('./taskService');

function codedError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, ...details });
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((result, key) => {
      result[key] = stableValue(value[key]);
      return result;
    }, {});
  }
  return value;
}

function stableHash(value) {
  return createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex');
}

function parseJson(value, fallback = null) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed == null ? fallback : parsed;
  } catch (_) {
    return fallback;
  }
}

function trim(value) {
  return String(value ?? '').trim();
}

function ownerFromInput(input) {
  const tenantId = trim(input.tenantId ?? input.tenant_id);
  const userId = trim(input.userId ?? input.user_id);
  if (!tenantId) throw codedError('REDRAW_LOCALIZATION_TENANT_REQUIRED', '缺少租户');
  if (!userId) throw codedError('REDRAW_LOCALIZATION_USER_REQUIRED', '缺少用户');
  return { tenantId, userId };
}

function normalizeStartInput(input = {}) {
  const owner = ownerFromInput(input);
  const workId = Number(input.workId ?? input.work_id);
  if (!Number.isSafeInteger(workId) || workId <= 0) {
    throw codedError('REDRAW_LOCALIZATION_WORK_REQUIRED', '缺少转绘作品');
  }
  const locale = trim(input.locale);
  if (!locale) throw codedError('REDRAW_LOCALIZATION_LOCALE_REQUIRED', '缺少本地化 locale');
  const idempotencyKey = trim(input.idempotencyKey ?? input.idempotency_key);
  if (!idempotencyKey) {
    throw codedError('REDRAW_LOCALIZATION_IDEMPOTENCY_REQUIRED', '缺少本地化幂等键');
  }
  return {
    ...owner,
    workId,
    locale,
    market: trim(input.market),
    localizationLevel: trim(input.localizationLevel ?? input.localization_level) || 'faithful',
    idempotencyKey,
    quoteHash: trim(input.quoteHash ?? input.quote_hash),
    canReadArtifact: input.canReadArtifact,
  };
}

function getOwnedWork(db, input) {
  const work = db.prepare(`
    SELECT *
    FROM redraw_works
    WHERE id = ? AND tenant_id = ? AND user_id = ?
  `).get(Number(input.workId), String(input.tenantId), String(input.userId));
  if (!work) throw codedError('REDRAW_LOCALIZATION_WORK_NOT_FOUND', '转绘作品不存在');
  return work;
}

function safeAutomationDecision(value, evidenceHash, versionId, currentPolicyVersion) {
  const result = value?.automation_decision ? value : null;
  const decision = result?.automation_decision || value;
  if (!decision || typeof decision !== 'object' || Array.isArray(decision)) return null;
  if (!['advance', 'needs_review', 'blocked'].includes(decision.action)) return null;
  if (!['auto', 'safe'].includes(decision.effective_mode)) return null;
  if (!Array.isArray(decision.reason_codes)) return null;
  if (typeof decision.evidence_hash !== 'string' || decision.evidence_hash !== evidenceHash) return null;
  if (typeof decision.effective_analysis_state !== 'string') return null;
  if (Number(result?.version_id) !== Number(versionId)) return null;
  if (Number(decision.policy_version) !== Number(currentPolicyVersion)) return null;
  return {
    action: decision.action,
    effective_mode: decision.effective_mode,
    reason_codes: [...decision.reason_codes].map(String).sort(),
    policy_version: Number(decision.policy_version),
    evidence_hash: decision.evidence_hash,
    effective_analysis_state: decision.effective_analysis_state,
  };
}

function getAnalysisAutomationDecision(db, input = {}) {
  const normalized = {
    ...input,
    ...ownerFromInput(input),
    workId: Number(input.workId ?? input.work_id),
  };
  let work;
  try {
    work = getOwnedWork(db, normalized);
  } catch (error) {
    if (error.code === 'REDRAW_LOCALIZATION_WORK_NOT_FOUND') return null;
    throw error;
  }
  if (!work.task_id) return null;
  if (!work.project_id) return null;
  const sourceVersion = db.prepare(`
    SELECT id, facts_hash
    FROM redraw_versions
    WHERE work_id = ? AND tenant_id = ? AND user_id = ?
      AND locale = 'source'
      AND source_facts_json IS NOT NULL AND TRIM(source_facts_json) != ''
      AND deleted_at IS NULL
    ORDER BY CASE WHEN version = ? THEN 0 ELSE 1 END, version DESC, id DESC
    LIMIT 1
  `).get(normalized.workId, normalized.tenantId, normalized.userId, Number(work.current_version || 0));
  if (!sourceVersion?.facts_hash) return null;
  const project = db.prepare(`
    SELECT policy_version
    FROM redraw_projects
    WHERE id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
    LIMIT 1
  `).get(Number(work.project_id), normalized.tenantId, normalized.userId);
  if (!project) return null;
  const task = db.prepare(`
    SELECT result
    FROM async_tasks
    WHERE id = ? AND type = 'redraw_analysis'
      AND resource_id = ? AND tenant_id = ? AND user_id = ?
      AND deleted_at IS NULL
    LIMIT 1
  `).get(String(work.task_id), String(normalized.workId), normalized.tenantId, normalized.userId);
  const parsed = parseJson(task?.result, null);
  return safeAutomationDecision(parsed, sourceVersion.facts_hash, sourceVersion.id, project.policy_version);
}

function analysisGateQuote(db, input) {
  const decision = getAnalysisAutomationDecision(db, input);
  if (!decision || decision.action !== 'advance') {
    return {
      priced: false,
      code: 'REDRAW_LOCALIZATION_ANALYSIS_NOT_ADVANCED',
      automation_decision: decision,
    };
  }
  return null;
}

function buildLocalizationSnapshot(db, input = {}) {
  const normalized = {
    ...input,
    ...ownerFromInput(input),
    workId: Number(input.workId ?? input.work_id),
    locale: trim(input.locale),
    market: trim(input.market),
    localizationLevel: trim(input.localizationLevel ?? input.localization_level) || 'faithful',
  };
  const work = getOwnedWork(db, normalized);
  const sourceVersion = db.prepare(`
    SELECT *
    FROM redraw_versions
    WHERE work_id = ? AND tenant_id = ? AND user_id = ?
      AND locale = 'source'
      AND source_facts_json IS NOT NULL AND TRIM(source_facts_json) != ''
      AND deleted_at IS NULL
    ORDER BY CASE WHEN version = ? THEN 0 ELSE 1 END, version DESC, id DESC
    LIMIT 1
  `).get(normalized.workId, normalized.tenantId, normalized.userId, Number(work.current_version || 0));
  if (!sourceVersion) {
    throw codedError('REDRAW_LOCALIZATION_SOURCE_REQUIRED', '本地化需要先完成源片事实确认');
  }
  const sourceFacts = parseJson(sourceVersion.source_facts_json, null);
  if (!sourceFacts || typeof sourceFacts !== 'object' || Array.isArray(sourceFacts)) {
    throw codedError('REDRAW_LOCALIZATION_SOURCE_REQUIRED', '源片事实不可读取');
  }
  const localizationInput = localizationService.buildLocalizationInput(sourceFacts, {
    locale: normalized.locale,
    market: normalized.market,
    localizationLevel: normalized.localizationLevel,
    styleSnapshot: parseJson(sourceVersion.style_snapshot_json, {}),
  });
  localizationInput.tenantId = normalized.tenantId;
  localizationInput.userId = normalized.userId;
  localizationInput.workId = normalized.workId;
  return {
    input: localizationInput,
    source_version_id: Number(sourceVersion.id),
    facts_hash: sourceVersion.facts_hash || localizationInput.source_facts_hash,
  };
}

function quoteLocalization(db, input = {}) {
  const snapshot = buildLocalizationSnapshot(db, input);
  const blocked = analysisGateQuote(db, input);
  if (blocked) return blocked;
  const capability = redrawCapability.resolveVerifiedLocaleCapability(db, {
    locale: trim(input.locale),
    market: trim(input.market),
    capability: 'text',
    canReadArtifact: input.canReadArtifact,
  });
  if (!capability) {
    return { priced: false, code: 'REDRAW_LOCALIZATION_CAPABILITY_UNVERIFIED' };
  }
  let credits;
  try {
    credits = modelPrice.requirePrice(db, capability.model);
  } catch (error) {
    if (error.code === 'MODEL_PRICE_NOT_CONFIGURED') {
      return { priced: false, code: 'pricing_unconfigured' };
    }
    throw error;
  }
  const fullSnapshot = {
    ...snapshot,
    capability: {
      provider: capability.provider,
      model: capability.model,
      evidence: capability.evidence,
    },
  };
  return {
    priced: true,
    credits,
    model: capability.model,
    input_hash: stableHash(fullSnapshot.input),
    quote_hash: stableHash({ snapshot: fullSnapshot, credits }),
    snapshot: fullSnapshot,
  };
}

function tableExists(db, table) {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
}

function projectState(db, input) {
  return db.prepare(`
    SELECT w.id AS work_id, w.project_id, w.status AS work_status, w.current_step,
           p.execution_mode, p.policy_version, p.automation_policy_json
    FROM redraw_works w
    LEFT JOIN redraw_projects p
      ON p.id = w.project_id AND p.tenant_id = w.tenant_id AND p.user_id = w.user_id
    WHERE w.id = ? AND w.tenant_id = ? AND w.user_id = ?
    LIMIT 1
  `).get(Number(input.workId), String(input.tenantId), String(input.userId));
}

function localizationDecision(db, input, normalized) {
  if (input.source_facts?.schema_version !== '2.0') return null;
  const state = projectState(db, input);
  const policy = parseJson(state?.automation_policy_json, {});
  const thresholds = policy?.localization_thresholds;
  const reasonCodes = [];
  let action = 'advance';
  if (String(state?.execution_mode || 'auto') !== 'auto') {
    action = 'needs_review';
    reasonCodes.push('safe_mode_requires_review');
  } else if (!thresholds || typeof thresholds !== 'object' || Array.isArray(thresholds)) {
    action = 'needs_review';
    reasonCodes.push('localization_thresholds_missing');
  } else {
    for (const key of ['names', 'dialogue_semantics', 'dialogue_timing', 'culture', 'screen_text']) {
      const threshold = Number(thresholds[key]);
      const confidence = Number(normalized.confidence?.[key]);
      if (!Number.isFinite(threshold) || !Number.isFinite(confidence) || confidence < threshold) {
        action = 'needs_review';
        reasonCodes.push('localization_confidence_below_threshold');
        break;
      }
    }
  }
  return {
    action,
    effective_mode: action === 'advance' ? 'auto' : 'safe',
    reason_codes: reasonCodes,
    policy_version: Number(state?.policy_version || 0),
    evidence_hash: normalized.facts_hash,
  };
}

function recordLocalizationEvent(db, input, decision, toState) {
  if (!tableExists(db, 'redraw_workflow_events')) return;
  const state = projectState(db, input);
  db.prepare(`
    INSERT INTO redraw_workflow_events
      (tenant_id, user_id, project_id, resource_type, resource_id,
       from_state, to_state, reason_code, evidence_hash, metadata_json, created_at)
    VALUES (?, ?, ?, 'redraw_work', ?, ?, ?, 'localization_completed', ?, ?, ?)
  `).run(
    String(input.tenantId),
    String(input.userId),
    Number(state?.project_id || 0),
    String(input.workId),
    String(state?.work_status || ''),
    toState,
    decision.evidence_hash,
    JSON.stringify({ localization_decision: decision }),
    new Date().toISOString(),
  );
}

function finalizeLocalization(db, taskId, reservationId, input, materialized, normalized, decision) {
  return db.transaction(() => {
    let toState = 'asset_review';
    if (decision?.action === 'needs_review') {
      toState = 'needs_review';
      db.prepare(`
        UPDATE redraw_versions
        SET status = 'needs_review', updated_at = ?
        WHERE id = ?
      `).run(new Date().toISOString(), Number(materialized.id));
      db.prepare(`
        UPDATE redraw_works
        SET current_step = 1, status = 'needs_review', updated_at = ?
        WHERE id = ? AND tenant_id = ? AND user_id = ?
      `).run(new Date().toISOString(), Number(input.workId), String(input.tenantId), String(input.userId));
    }
    if (decision) recordLocalizationEvent(db, input, decision, toState);
    markCompleted(db, taskId, reservationId, {
      status: 'completed',
      work_id: Number(input.workId),
      version_id: materialized.id,
      facts_hash: normalized.facts_hash,
      ...(decision ? { localization_decision: decision } : {}),
    });
  }).immediate();
}

function findExistingDraft(db, input) {
  return db.prepare(`
    SELECT *
    FROM redraw_versions
    WHERE work_id = ? AND tenant_id = ? AND user_id = ?
      AND localization_idempotency_key = ? AND deleted_at IS NULL
    ORDER BY id ASC
    LIMIT 1
  `).get(input.workId, input.tenantId, input.userId, input.idempotencyKey);
}

function getExistingStart(db, input) {
  const draft = findExistingDraft(db, input);
  if (!draft) return null;
  const snapshot = parseJson(draft.localization_model_snapshot_json, {});
  const storedInput = snapshot?.input || null;
  const requestComparable = {
    locale: input.locale,
    market: input.market,
    localization_level: input.localizationLevel,
  };
  const storedComparable = storedInput ? {
    locale: trim(storedInput.locale),
    market: trim(storedInput.market),
    localization_level: trim(storedInput.localization_level) || 'faithful',
  } : null;
  const rebuiltInput = storedInput ? null : buildLocalizationSnapshot(db, input).input;
  const inputHash = storedInput ? stableHash(storedInput) : stableHash(rebuiltInput);
  const comparable = storedComparable || {
    locale: trim(rebuiltInput.locale),
    market: trim(rebuiltInput.market),
    localization_level: trim(rebuiltInput.localization_level) || 'faithful',
  };
  if (
    draft.localization_input_hash !== inputHash
    || stableHash(comparable) !== stableHash(requestComparable)
  ) {
    throw codedError('REDRAW_LOCALIZATION_IDEMPOTENCY_CONFLICT', '相同本地化幂等键对应的输入已变化');
  }
  const task = draft.localization_task_id ? taskService.getTask(db, draft.localization_task_id) : null;
  return {
    task_id: draft.localization_task_id,
    reservation_id: draft.localization_credit_reservation_id,
    draft_version_id: Number(draft.id),
    task,
    reservation: draft.localization_credit_reservation_id
      ? creditLedger.getReservation(db, draft.localization_credit_reservation_id)
      : null,
    completion: null,
  };
}

function insertTask(db, log, input, quote, draftId, reservationId) {
  const task = taskService.createTask(db, log, 'redraw_localization', String(input.workId));
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE async_tasks
    SET tenant_id = ?, user_id = ?, model = ?, credit_reservation_id = ?,
        status = 'pending', progress = 0, message = ?, updated_at = ?
    WHERE id = ?
  `).run(
    input.tenantId,
    input.userId,
    quote.model,
    reservationId,
    '本地化任务已创建',
    now,
    task.id,
  );
  db.prepare(`
    UPDATE redraw_versions
    SET localization_task_id = ?, localization_credit_reservation_id = ?,
        localization_input_hash = ?, localization_model_snapshot_json = ?, updated_at = ?
    WHERE id = ? AND tenant_id = ? AND user_id = ?
  `).run(
    task.id,
    reservationId,
    quote.input_hash,
    JSON.stringify(quote.snapshot),
    now,
    draftId,
    input.tenantId,
    input.userId,
  );
  return taskService.getTask(db, task.id);
}

function createStartRecords(db, log, input, quote) {
  return db.transaction(() => {
    const draft = localizationService.createLocalizationDraft(db, {
      tenantId: input.tenantId,
      userId: input.userId,
    }, input.workId, {
      locale: input.locale,
      market: input.market,
      localizationLevel: input.localizationLevel,
      inputHash: quote.input_hash,
      idempotencyKey: input.idempotencyKey,
      modelSnapshot: quote.snapshot,
    });
    const reservation = creditLedger.reserve(db, {
      tenantId: input.tenantId,
      userId: input.userId,
      actorUserId: input.userId,
      operationKey: [
        'redraw-localization',
        input.tenantId,
        input.userId,
        input.workId,
        quote.input_hash,
        input.idempotencyKey,
      ].join(':'),
      amount: quote.credits,
      model: quote.model,
      resourceType: 'redraw_localization',
      resourceId: String(input.workId),
    });
    const task = insertTask(db, log, input, quote, Number(draft.id), reservation.id);
    return {
      task_id: task.id,
      reservation_id: reservation.id,
      draft_version_id: Number(draft.id),
      quote,
    };
  }).immediate();
}

function setProcessing(db, taskId) {
  db.prepare(`
    UPDATE async_tasks
    SET status = 'processing', progress = 10, message = ?, updated_at = ?
    WHERE id = ? AND status IN ('pending', 'processing')
  `).run('正在执行本地化', new Date().toISOString(), taskId);
}

function setProviderTaskId(db, taskId, providerTaskId) {
  if (!trim(providerTaskId)) return;
  db.prepare('UPDATE async_tasks SET provider_task_id = ?, updated_at = ? WHERE id = ?')
    .run(trim(providerTaskId), new Date().toISOString(), taskId);
}

function setNeedsAttention(db, taskId, message) {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE async_tasks
    SET status = 'needs_attention', progress = CASE WHEN COALESCE(progress, 0) > 90 THEN progress ELSE 90 END,
        message = ?, error = ?, completed_at = NULL, updated_at = ?
    WHERE id = ?
  `).run(message || '本地化供应商状态未知，请人工确认', message || '本地化供应商状态未知，请人工确认', now, taskId);
}

function markFailed(db, taskId, reservationId, message) {
  taskService.updateTaskError(db, taskId, message || '本地化失败');
  creditLedger.settleGeneration(db, reservationId, 'failed', message || '本地化失败');
}

function markCompleted(db, taskId, reservationId, result) {
  taskService.updateTaskResult(db, taskId, result);
  creditLedger.settleGeneration(db, reservationId, 'completed');
}

function isUnknownError(error) {
  const code = String(error?.code || '').toUpperCase();
  return error?.unknown === true
    || code.includes('UNKNOWN')
    || code === 'PROVIDER_TIMEOUT_UNKNOWN';
}

function providerTaskIdFrom(value) {
  return trim(value?.provider_task_id || value?.task_id || value?.providerTaskId || value?.taskId);
}

function runLocalizationJob(db, records, deps) {
  return (async () => {
    const { task_id: taskId, reservation_id: reservationId, draft_version_id: draftVersionId, quote } = records;
    try {
      setProcessing(db, taskId);
      if (typeof deps.provider !== 'function') {
        throw codedError('REDRAW_LOCALIZATION_PROVIDER_REQUIRED', '缺少本地化供应商');
      }
      let providerResult;
      try {
        providerResult = await deps.provider({
          taskId,
          model: quote.model,
          locale: quote.snapshot.input.locale,
          market: quote.snapshot.input.market,
          input: quote.snapshot.input,
        });
      } catch (error) {
        setProviderTaskId(db, taskId, providerTaskIdFrom(error));
        if (isUnknownError(error)) {
          setNeedsAttention(db, taskId, error.message);
        } else {
          markFailed(db, taskId, reservationId, error.message);
        }
        throw error;
      }
      setProviderTaskId(db, taskId, providerTaskIdFrom(providerResult));
      if (!providerResult || !Object.prototype.hasOwnProperty.call(providerResult, 'result')) {
        throw codedError('REDRAW_LOCALIZATION_EMPTY_RESULT', '本地化供应商返回结果为空');
      }
      const normalized = localizationService.normalizeLocalizationResult(
        providerResult.result,
        quote.snapshot.input.source_facts,
      );
      const materialized = localizationService.materializeLocalizationDraft(db, {
        tenantId: quote.snapshot.input.tenantId || records.tenantId,
        userId: quote.snapshot.input.userId || records.userId,
      }, draftVersionId, {
        workId: Number(quote.snapshot.input.workId || records.workId),
        locale: quote.snapshot.input.locale,
        market: quote.snapshot.input.market,
        localizationLevel: quote.snapshot.input.localization_level,
        sourceFacts: quote.snapshot.input.source_facts,
        sourceFactsHash: normalized.facts_hash,
        glossary: normalized.glossary,
        nameMap: normalized.name_map,
        cultureMap: normalized.culture_map,
        dialogue: normalized.dialogue,
        styleSnapshot: quote.snapshot.input.style_snapshot,
        modelSnapshot: quote.snapshot,
      });
      const decisionInput = {
        tenantId: quote.snapshot.input.tenantId || records.tenantId,
        userId: quote.snapshot.input.userId || records.userId,
        workId: Number(quote.snapshot.input.workId || records.workId),
        source_facts: quote.snapshot.input.source_facts,
      };
      const decision = localizationDecision(db, decisionInput, normalized);
      finalizeLocalization(db, taskId, reservationId, decisionInput, materialized, normalized, decision);
      return { status: 'completed', version_id: materialized.id };
    } catch (error) {
      const task = taskService.getTask(db, taskId);
      if (!['failed', 'needs_attention', 'completed'].includes(task?.status)) {
        markFailed(db, taskId, reservationId, error.message);
      }
      throw error;
    }
  })();
}

function defaultSchedule(job) {
  return new Promise((resolve, reject) => {
    setImmediate(() => {
      Promise.resolve()
        .then(job)
        .then(resolve, reject);
    });
  });
}

function normalizeScheduled(value) {
  if (value && typeof value.then === 'function') return value;
  return Promise.resolve(value);
}

function startLocalization(db, log, input = {}, deps = {}) {
  const normalized = normalizeStartInput(input);
  const existing = getExistingStart(db, normalized);
  if (existing) return existing;

  const quote = quoteLocalization(db, normalized);
  if (!quote.priced) throw codedError(quote.code, '本地化模型暂不可报价', { quote });
  if (normalized.quoteHash !== quote.quote_hash) {
    throw codedError('REDRAW_LOCALIZATION_QUOTE_CHANGED', '本地化报价已变化，请重新确认', { quote });
  }

  const created = createStartRecords(db, log, normalized, quote);
  const records = {
    ...created,
    tenantId: normalized.tenantId,
    userId: normalized.userId,
    workId: normalized.workId,
  };
  const schedule = typeof deps.schedule === 'function' ? deps.schedule : defaultSchedule;
  let completion;
  const job = () => runLocalizationJob(db, records, deps);
  try {
    completion = normalizeScheduled(schedule(job));
  } catch (error) {
    completion = Promise.reject(error);
  }
  const tracked = taskService.trackInFlightTask(created.task_id, completion);
  return {
    task_id: created.task_id,
    reservation_id: created.reservation_id,
    draft_version_id: created.draft_version_id,
    completion: tracked,
  };
}

function reconcileOrphanedTasks(db, log) {
  let rows;
  try {
    rows = db.prepare(`
      SELECT *
      FROM async_tasks
      WHERE type = 'redraw_localization'
        AND status IN ('pending', 'processing')
        AND deleted_at IS NULL
    `).all();
  } catch (error) {
    if (/no such (table|column)/i.test(String(error.message || ''))) return { needs_attention: 0, failed: 0 };
    throw error;
  }

  let needsAttention = 0;
  let failed = 0;
  for (const row of rows) {
    if (trim(row.provider_task_id)) {
      setNeedsAttention(db, row.id, '服务重启后本地化供应商任务状态未知，请人工确认');
      needsAttention += 1;
      log?.warn?.('redraw localization orphan needs attention', { task_id: row.id });
    } else {
      markFailed(db, row.id, row.credit_reservation_id, '服务重启后本地化任务未派发，已退款');
      failed += 1;
      log?.warn?.('redraw localization orphan failed before dispatch', { task_id: row.id });
    }
  }
  return { needs_attention: needsAttention, failed };
}

module.exports = {
  stableValue,
  stableHash,
  buildLocalizationSnapshot,
  getAnalysisAutomationDecision,
  quoteLocalization,
  startLocalization,
  reconcileOrphanedTasks,
};
