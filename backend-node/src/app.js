const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { getDb } = require('./db/index.js');
const { loadConfig } = require('./config/index.js');
const logger = require('./logger.js');
const { setupRouter } = require('./routes/index.js');
const { createStaticOwnershipMiddleware } = require('./middleware/resourceOwnership');
const { mountReleaseEvidenceAssets } = require('./middleware/releaseEvidenceAssets');

function resolveStorageRoot(config, cwd = process.cwd()) {
  const configured = config.storage?.local_path;
  return configured
    ? path.resolve(cwd, configured)
    : path.join(cwd, 'data', 'storage');
}

function startBackgroundServices(options) {
  const providerReconciliation = options.providerReconciliation
    || require('./services/providerReconciliationService');
  const providerCanary = options.providerCanary
    || require('./services/providerCanarySchedulerService');
  const providerPricing = options.providerPricing;
  const env = options.env || process.env;
  providerReconciliation.startProviderReconciliation(options.db, options.log, {
    intervalMs: Number(env.PROVIDER_RECONCILIATION_INTERVAL_MS) || 60_000,
  });
  providerCanary.startProviderCanaryScheduler(options.db, options.log, {
    mode: env.PROVIDER_CANARY_MODE,
    paidEnabled: env.PROVIDER_CANARY_PAID_ENABLED,
    intervalMs: 300_000,
    storageRoot: options.storageRoot,
    healthUrl: options.healthUrl,
  });
  if (providerPricing?.startProviderPricingSync
      && !/^(0|false|no)$/i.test(String(env.PROVIDER_PRICING_SYNC_ENABLED || ''))) {
    providerPricing.startProviderPricingSync(options.db, options.log, {
      intervalMs: Number(env.PROVIDER_PRICING_SYNC_INTERVAL_MS) || 6 * 60 * 60 * 1000,
    });
  }
  return {
    stop() {
      const stopped = {
        scheduler: providerCanary.stopProviderCanaryScheduler(),
        reconciliation: providerReconciliation.stopProviderReconciliation(),
      };
      if (providerPricing?.stopProviderPricingSync) {
        stopped.pricing = providerPricing.stopProviderPricingSync();
      }
      return stopped;
    },
  };
}

function assertFrontendDistReadable(webDist) {
  if (!fs.existsSync(webDist)) return false;

  try {
    fs.accessSync(webDist, fs.constants.R_OK | fs.constants.X_OK);
    fs.accessSync(path.join(webDist, 'index.html'), fs.constants.R_OK);
  } catch (error) {
    throw new Error(
      `Frontend static assets unavailable: ${error.code || 'access_error'} ${webDist}: ${error.message}`,
    );
  }

  return true;
}

function mountFrontend(app, webDist) {
  if (!assertFrontendDistReadable(webDist)) return false;

  app.use('/assets', express.static(path.join(webDist, 'assets')));
  app.use('/assets', (req, res) => {
    res.status(404).type('text/plain').send('Asset Not Found');
  });
  app.use(express.static(webDist, {
    index: false,
    setHeaders(res, filePath) {
      if (path.extname(filePath).toLowerCase() === '.html') {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  }));
  app.get('/favicon.ico', (req, res) => {
    const fav = path.join(webDist, 'favicon.ico');
    if (fs.existsSync(fav)) res.sendFile(fav);
    else res.status(404).end();
  });
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    const indexHtml = path.join(webDist, 'index.html');
    if (!fs.existsSync(indexHtml)) return next();
    res.setHeader('Cache-Control', 'no-cache');
    return res.sendFile(indexHtml);
  });
  return true;
}

function configureTrustedProxy(app) {
  app.set('trust proxy', 'loopback');
  return app;
}

function createApp() {
  const config = loadConfig();
  const db = getDb(config.database);
  const { runMigrationsAndEnsure } = require('./db/migrate.js');
  runMigrationsAndEnsure(db);

  // 厂商锁定模式：在迁移完成后同步 vendor_lock 配置
  const { applyVendorLock } = require('./services/aiConfigService');
  applyVendorLock(db, logger, config);
  const log = logger;

  const storageRoot = resolveStorageRoot(config);

  const redrawOrchestrator = require('./services/redrawOrchestrator');
  const redrawResume = redrawOrchestrator.resumeRedrawTasks(
    db,
    log,
    redrawOrchestrator.createStartupResumeOptions(db, log, { storageRoot })
  ).catch((error) => {
    log.error('Resume redraw analysis tasks failed', { error: error.message });
  });

  const taskService = require('./services/taskService');
  redrawResume
    .finally(() => {
      try {
        require('./services/redrawLocalizationOrchestrator').reconcileOrphanedTasks(db, log);
      } catch (error) {
        log.error('Startup redraw localization reconcile failed', { error: error.message });
      }
      try {
        require('./services/redrawAssetBatchService').reconcileOrphanedBatches(db, log);
      } catch (error) {
        log.error('Startup redraw asset batch reconcile failed', { error: error.message });
      }
      try {
        require('./services/redrawDialogueOrchestrator').reconcileOrphanedDialogueTasks(db, log);
      } catch (error) {
        log.error('Startup redraw dialogue reconcile failed', { error: error.message });
      }
      try {
        require('./services/redrawCompositionService').recoverInterruptedCompositions(db);
      } catch (error) {
        log.error('Startup redraw composition recover failed', { error: error.message });
      }
      taskService.failOrphanedAsyncTasksOnStartup(db, log);
    })
    .catch((error) => {
      log.error('Startup orphan cleanup failed', { error: error.message });
    });

  const { resumeProcessingVideoGenerations } = require('./services/videoService');
  resumeProcessingVideoGenerations(db, log);

  const healthHost = ['0.0.0.0', '::'].includes(String(config.server.host || ''))
    ? '127.0.0.1'
    : String(config.server.host || '127.0.0.1');
  const healthUrlHost = healthHost.includes(':') ? `[${healthHost}]` : healthHost;
  const backgroundServices = startBackgroundServices({
    db,
    log,
    storageRoot,
    healthUrl: `http://${healthUrlHost}:${config.server.port}/health`,
    providerPricing: require('./services/providerPricingSyncSchedulerService'),
  });

  const app = configureTrustedProxy(express());
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));

  app.use(
    cors({
      origin: config.server.cors_origins && config.server.cors_origins.length
        ? config.server.cors_origins
        : '*',
    })
  );

  if (/^(1|true|yes)$/i.test(String(process.env.HTTP_REQUEST_LOGGING || ''))) {
    app.use((req, res, next) => {
      log.info(req.method, req.path);
      next();
    });
  }

  // 仅公开 root-owned 的模型验证成品；用户素材仍受 /static 租户鉴权保护。
  mountReleaseEvidenceAssets(app);

  // 静态资源目录：统一转为绝对路径（打包 exe 下相对路径可能解析异常）
  try {
    if (!fs.existsSync(storageRoot)) fs.mkdirSync(storageRoot, { recursive: true });
    const publicPlatformEnabled = /^(1|true|yes)$/i.test(String(process.env.PUBLIC_PLATFORM_MODE || ''));
    app.use('/static', createStaticOwnershipMiddleware({
      db,
      enabled: publicPlatformEnabled,
      secret: process.env.PLATFORM_JWT_SECRET,
      storageRoot,
    }), express.static(storageRoot));
  } catch (e) {
    console.warn('Static storage mount skipped:', e.message);
  }

  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      app: config.app.name,
      version: config.app.version,
    });
  });

  app.use('/api/v1', setupRouter(config, db, log));

  // 前端静态资源（sxy：web/dist）；Electron 打包时可设 WEB_DIST_PATH
  const webDist = process.env.WEB_DIST_PATH || path.join(process.cwd(), '..', 'frontweb', 'dist');
  console.log('webDist', webDist);
  if (!mountFrontend(app, webDist)) {
    app.get('/', (req, res) => {
      res.send(
        '<!DOCTYPE html><html><head><meta charset="utf-8"><title>LocalMiniDrama</title></head><body>' +
          '<h1>LocalMiniDrama API</h1><p>后端已启动。请先构建前端：</p>' +
          '<pre>cd web &amp;&amp; pnpm install &amp;&amp; pnpm build</pre>' +
          '<p>然后将 <code>web/dist</code> 放到与 backend-node 同级的 <code>web/dist</code>，或访问 <a href="/health">/health</a> 检查接口。</p></body></html>'
      );
    });
  }

  app.use((req, res) => {
    if (req.path.startsWith('/api')) {
      return res.status(404).json({ error: 'API endpoint not found' });
    }
    res.status(404).send('Not Found');
  });

  app.use((err, req, res, next) => {
    const isInvalidJsonBody = err?.status === 400 && err?.type === 'entity.parse.failed';
    if (isInvalidJsonBody) {
      log.errorw('Invalid JSON body', { code: 'INVALID_JSON_BODY', path: req.path });
      if (!res.headersSent) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_JSON_BODY', message: '请求体必须是有效的 JSON 对象' },
          timestamp: new Date().toISOString(),
        });
      }
      return;
    }
    log.errorw('Unhandled error', { error: err.message, path: req.path });
    if (!res.headersSent) {
      const isFileTooLarge = err.code === 'LIMIT_FILE_SIZE' || (err.message && err.message.includes('File too large'));
      const status = isFileTooLarge ? 413 : 500;
      const message = isFileTooLarge ? '图片大小不能超过 16MB，请压缩后重试' : (err.message || '服务器错误');
      res.status(status).json({ success: false, error: { code: isFileTooLarge ? 'FILE_TOO_LARGE' : 'INTERNAL_ERROR', message }, timestamp: new Date().toISOString() });
    }
  });

  return {
    app,
    config,
    db,
    stopBackgroundServices: () => backgroundServices.stop(),
  };
}

module.exports = {
  configureTrustedProxy,
  createApp,
  mountFrontend,
  resolveStorageRoot,
  startBackgroundServices,
};
