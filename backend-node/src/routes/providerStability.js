const response = require('../response');
const aiConfigService = require('../services/aiConfigService');
const stability = require('../services/providerRouteStabilityService');
const audit = require('../services/auditEventService');

const PATCH_FIELDS = new Set([
  'logical_model_id',
  'failover_enabled',
  'priority',
  'admin_paused',
  'canary_paused',
]);

function configId(req, res) {
  const id = Number(req.params.configId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    response.badRequest(res, '无效的配置 ID');
    return null;
  }
  return id;
}

function relayHost(baseUrl) {
  try {
    const parsed = new URL(String(baseUrl || ''));
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.hostname : '未识别域名';
  } catch (_) {
    return '未识别域名';
  }
}

function safeConfigSummary(db, config) {
  const storedHealth = db.prepare(`SELECT state, consecutive_failures, open_until,
    last_error_category, updated_at FROM provider_route_health WHERE config_id = ?`)
    .get(config.id) || {
      state: config.is_active ? 'healthy' : 'disabled',
      consecutive_failures: 0,
      open_until: null,
      last_error_category: null,
      updated_at: config.updated_at,
    };
  const health = config.is_active ? storedHealth : { ...storedHealth, state: 'disabled' };
  const lastSwitch = db.prepare(`SELECT MAX(created_at) AS created_at
    FROM provider_stability_events
    WHERE event_type IN ('provider_failover', 'route_switched')
      AND (config_id = ? OR target_config_id = ?)`).get(config.id, config.id);
  return {
    id: config.id,
    name: config.name,
    service_type: config.service_type,
    provider: config.provider,
    relay_host: relayHost(config.base_url),
    upstream_models: config.model,
    default_model: config.default_model,
    logical_model_id: config.logical_model_id,
    failover_enabled: config.failover_enabled,
    priority: config.priority,
    admin_paused: !config.is_active,
    canary_paused: Boolean(config.canary_paused),
    verification_status: config.verification_status,
    verified_at: config.verified_at,
    health,
    last_switch_at: lastSwitch?.created_at || null,
  };
}

function safeEvent(event) {
  const allowedDetails = {};
  for (const key of ['category', 'state', 'generationId']) {
    const value = event.safe_details?.[key];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      allowedDetails[key] = value;
    }
  }
  const legacySeverities = {
    P0: 'critical',
    P1: 'error',
    P2: 'warning',
    P3: 'info',
  };
  const severity = legacySeverities[event.severity]
    || (['critical', 'error', 'warning', 'info'].includes(event.severity)
      ? event.severity
      : 'warning');
  const alertLevels = {
    critical: 'P0',
    error: 'P1',
    warning: 'P2',
    info: 'P3',
  };
  return {
    ...event,
    severity,
    alert_level: alertLevels[severity],
    safe_details: allowedDetails,
  };
}

function safeRouteRequest(db, route) {
  let creditState = null;
  if (route.credit_reservation_id) {
    creditState = db.prepare('SELECT status FROM tenant_usage_reservations WHERE id = ?')
      .get(route.credit_reservation_id)?.status
      || db.prepare('SELECT status FROM usage_reservations WHERE id = ?')
        .get(route.credit_reservation_id)?.status
      || null;
  }
  return {
    id: route.id,
    service_type: route.service_type,
    business_type: route.business_type,
    business_id: route.business_id,
    logical_model_id: route.logical_model_id,
    state: route.state,
    credit_state: creditState,
    final_config_id: route.final_config_id,
    created_at: route.created_at,
    updated_at: route.updated_at,
  };
}

function recordAdminAudit(db, req, eventType, configIdValue, code) {
  audit.record(db, {
    userId: req.user?.id,
    eventType,
    resourceType: 'ai_service_config',
    resourceId: configIdValue,
    outcome: 'success',
    code,
  });
}

module.exports = function providerStabilityRoutes(db, log, options = {}) {
  return {
    listRoutes(req, res) {
      const configs = aiConfigService.listConfigs(db)
        .map((config) => safeConfigSummary(db, config));
      const requests = stability.listAdminRoutes(db, {
        state: req.query.state,
        logicalModelId: req.query.logical_model_id,
      }).map((route) => safeRouteRequest(db, route));
      response.success(res, { configs, requests });
    },

    listEvents(req, res) {
      response.success(res, stability.listAdminEvents(db, {
        eventType: req.query.event_type,
        logicalModelId: req.query.logical_model_id,
      }).map(safeEvent));
    },

    getCanarySummary(_req, res) {
      response.success(res, stability.getCanaryAdminSummary(db));
    },

    listCanaryRuns(req, res) {
      const allowedQueryFields = new Set(['state', 'logical_model_id', 'limit', 'before']);
      if (Object.keys(req.query || {}).some((key) => !allowedQueryFields.has(key))) {
        return response.badRequest(res, '巡检运行筛选条件无效');
      }
      try {
        response.success(res, stability.listCanaryRuns(db, {
          state: req.query.state,
          logicalModelId: req.query.logical_model_id,
          limit: req.query.limit,
          before: req.query.before,
        }));
      } catch (error) {
        if (error?.code === 'PROVIDER_CANARY_LIST_INVALID') {
          return response.badRequest(res, '巡检运行筛选条件无效');
        }
        throw error;
      }
    },

    async reconcileCanaryRun(req, res) {
      const body = req.body || {};
      if (Object.keys(body).length > 0) {
        return response.badRequest(res, '对账不接受客户端状态、产物或其他字段');
      }
      try {
        const result = await stability.reconcileCanaryRun(db, log, req.params.runId, {
          actorId: req.user?.id,
          storageRoot: options.storageRoot,
        });
        return response.success(res, result);
      } catch (error) {
        if (error?.code === 'PROVIDER_CANARY_RUN_INVALID') {
          return response.badRequest(res, '巡检运行 ID 无效');
        }
        if (error?.code === 'PROVIDER_CANARY_RUN_NOT_FOUND') {
          return response.notFound(res, '巡检运行不存在');
        }
        if (error?.code === 'PROVIDER_CANARY_RUN_NOT_RECONCILABLE') {
          return response.error(res, 409, error.code, '该巡检运行当前不可对账');
        }
        log.error('provider canary reconciliation failed', {
          run_id: req.params.runId,
          code: error?.code || 'UNKNOWN',
        });
        return response.internalError(res, '巡检对账失败');
      }
    },

    updateRoute(req, res) {
      const id = configId(req, res);
      if (id == null) return;
      const body = req.body || {};
      const keys = Object.keys(body);
      if (!keys.length || keys.some((key) => !PATCH_FIELDS.has(key))) {
        return response.badRequest(res, '只允许修改逻辑模型、容灾开关、优先级、管理员暂停和巡检暂停状态');
      }
      const changes = {};
      if (Object.prototype.hasOwnProperty.call(body, 'logical_model_id')) {
        if (body.logical_model_id != null
          && (typeof body.logical_model_id !== 'string' || body.logical_model_id.trim().length > 200)) {
          return response.badRequest(res, '逻辑模型无效');
        }
        changes.logical_model_id = body.logical_model_id == null ? null : body.logical_model_id.trim();
      }
      if (Object.prototype.hasOwnProperty.call(body, 'failover_enabled')) {
        if (typeof body.failover_enabled !== 'boolean') return response.badRequest(res, '容灾开关无效');
        changes.failover_enabled = body.failover_enabled;
      }
      if (Object.prototype.hasOwnProperty.call(body, 'priority')) {
        if (!Number.isSafeInteger(body.priority) || Math.abs(body.priority) > 100000) {
          return response.badRequest(res, '优先级无效');
        }
        changes.priority = body.priority;
      }
      if (Object.prototype.hasOwnProperty.call(body, 'admin_paused')) {
        if (typeof body.admin_paused !== 'boolean') return response.badRequest(res, '管理员暂停状态无效');
        changes.is_active = !body.admin_paused;
      }
      if (Object.prototype.hasOwnProperty.call(body, 'canary_paused')) {
        if (typeof body.canary_paused !== 'boolean') return response.badRequest(res, '巡检暂停状态无效');
        changes.canary_paused = body.canary_paused;
      }
      try {
        const updated = db.transaction(() => {
          const result = aiConfigService.updateConfig(db, log, id, changes);
          if (!result) return null;
          recordAdminAudit(db, req, 'provider.route.updated', id);
          return result;
        }).immediate();
        if (!updated) return response.notFound(res, '配置不存在');
        return response.success(res, safeConfigSummary(db, updated));
      } catch (error) {
        log.error('provider route update failed', {
          config_id: id,
          code: error?.code || 'UNKNOWN',
        });
        return response.internalError(res, '更新线路失败');
      }
    },

    resetHealth(req, res) {
      const id = configId(req, res);
      if (id == null) return;
      if (!aiConfigService.getConfig(db, id)) return response.notFound(res, '配置不存在');
      const result = stability.resetHealth(db, id, req.user?.id || 'admin');
      recordAdminAudit(db, req, 'provider.health.reset', id);
      response.success(res, result);
    },

    verifyFromGeneration(req, res) {
      const id = configId(req, res);
      if (id == null) return;
      const body = req.body || {};
      if (Object.keys(body).some((key) => key !== 'generation_id')) {
        return response.badRequest(res, '只接受生成记录 ID，不能由客户端直接标记已验证');
      }
      const generationId = Number(body.generation_id);
      if (!Number.isSafeInteger(generationId) || generationId <= 0) {
        return response.badRequest(res, '生成记录 ID 无效');
      }
      const config = aiConfigService.getConfig(db, id);
      if (!config) return response.notFound(res, '配置不存在');
      try {
        const verified = stability.verifyConfigFromGenerationEvidence(db, {
          configId: id,
          serviceType: config.service_type,
          generationId,
        });
        recordAdminAudit(db, req, 'provider.config.verified', id, `generation:${generationId}`);
        db.prepare(`INSERT INTO provider_stability_events
          (severity, event_type, logical_model_id, config_id, safe_details, created_at)
          VALUES ('info', 'config_verified', ?, ?, ?, ?)`)
          .run(config.logical_model_id, id, JSON.stringify({ generationId }), new Date().toISOString());
        response.success(res, safeConfigSummary(db, verified));
      } catch (error) {
        if (error?.code === 'VERIFICATION_ARTIFACT_UNREADABLE') {
          return response.badRequest(res, '生成记录未成功或产物不可读，不能标记已验证');
        }
        log.error('provider stability verification failed', { config_id: id, error: error.message });
        response.internalError(res, '验证失败');
      }
    },
  };
};
