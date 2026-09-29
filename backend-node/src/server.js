require('./config/dotenv.js').loadDotenv();
const { loadConfig } = require('./config/index.js');

const preConfig = loadConfig();
const tlsFlag = preConfig.server?.insecure_tls ?? preConfig.server?.INSECURE_TLS;
const insecureTlsOn =
  tlsFlag === true ||
  tlsFlag === 1 ||
  tlsFlag === '1' ||
  String(tlsFlag).toLowerCase() === 'true';
if (insecureTlsOn) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  console.warn('[config] server.insecure_tls 已启用：全局跳过 TLS 证书校验，仅用于测试');
}

const { createApp } = require('./app.js');
const { closeDb, getDb } = require('./db/index.js');
const taskService = require('./services/taskService');
const logger = require('./logger.js');
const redrawVoiceAutoBind = require('./services/redrawVoiceAutoBindService');

const { app, config } = createApp();
const port = Number(process.env.PORT) || config.server?.port || 5679;
const host = config.server?.host || '0.0.0.0';

const server = app.listen(port, host, () => {
  logger.info('Server starting', { port, host });
  logger.info('Frontend:  http://localhost:' + port);
  logger.info('API:       http://localhost:' + port + '/api/v1');
  logger.info('Health:    http://localhost:' + port + '/health');
  logger.info('Server is ready!');
});
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
server.requestTimeout = 600_000;
server.maxConnections = Number(process.env.SERVER_MAX_CONNECTIONS) || 1_024;

// 样片转绘项目：定音镜头生成后自动提取并沿用角色音色；REDRAW_VOICE_AUTO_BIND_INTERVAL_MS=0 关闭。
const voiceAutoBindInterval = process.env.REDRAW_VOICE_AUTO_BIND_INTERVAL_MS;
redrawVoiceAutoBind.startRedrawVoiceAutoBind(getDb(config.database), logger, {
  intervalMs: voiceAutoBindInterval == null || voiceAutoBindInterval === ''
    ? redrawVoiceAutoBind.DEFAULT_INTERVAL_MS
    : Number(voiceAutoBindInterval),
  cfg: config,
});

let shutdownStarted = false;

async function shutdown() {
  if (shutdownStarted) return;
  shutdownStarted = true;
  logger.info('Shutting down server...');
  const serverClosed = new Promise((resolve) => server.close(resolve));
  const graceMs = Number(process.env.IN_FLIGHT_TASK_SHUTDOWN_GRACE_MS) || 60_000;
  const inFlightCount = taskService.getInFlightTaskCount();
  if (inFlightCount) {
    logger.info('Waiting for in-flight tasks before shutdown', { count: inFlightCount, grace_ms: graceMs });
  }
  const forceExitTimer = setTimeout(() => process.exit(1), graceMs + 5000);
  const drained = await taskService.waitForInFlightTasks(graceMs);
  if (!drained) {
    logger.warn('In-flight task shutdown grace period expired', {
      remaining: taskService.getInFlightTaskCount(),
      grace_ms: graceMs,
    });
  }
  await serverClosed;
  redrawVoiceAutoBind.stopRedrawVoiceAutoBind();
  clearTimeout(forceExitTimer);
  closeDb();
  logger.info('Server exited');
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
