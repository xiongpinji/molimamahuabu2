/**
 * 应用版本检测路由
 * 提供客户端版本检查 + 强制更新能力
 *
 * 端点：
 *   GET /api/v1/app/version         - 获取当前版本信息
 *   GET /api/v1/app/version/check   - 检查是否有新版本（基于客户端当前版本）
 */
const express = require('express');
const router = express.Router();

function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

function getVersionInfo() {
  return {
    version: process.env.APP_VERSION || '1.0.0',
    buildTime: process.env.APP_BUILD_TIME || new Date().toISOString(),
    releaseNotes: process.env.APP_RELEASE_NOTES || '',
    forceUpdate: String(process.env.APP_FORCE_UPDATE || 'false').toLowerCase() === 'true'
  };
}

router.get('/version', (req, res) => {
  const info = getVersionInfo();
  res.json({
    success: true,
    data: info,
    timestamp: new Date().toISOString()
  });
});

router.get('/version/check', (req, res) => {
  const current = String(req.query.current || '0.0.0');
  const latest = getVersionInfo();
  const hasUpdate = compareVersions(latest.version, current) > 0;
  res.json({
    success: true,
    data: {
      hasUpdate,
      currentVersion: current,
      latestVersion: latest.version,
      buildTime: latest.buildTime,
      releaseNotes: latest.releaseNotes,
      forceUpdate: hasUpdate && latest.forceUpdate
    },
    timestamp: new Date().toISOString()
  });
});

module.exports = router;
