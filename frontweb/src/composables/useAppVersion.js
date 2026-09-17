/**
 * useAppVersion — 应用版本检测 composable（模块级单例，多处调用共享同一状态）
 *
 * 工作流程：
 *   1. localStorage 中存储用户已确认的版本号
 *   2. 首次访问：静默获取最新版本并记录（不弹窗）
 *   3. 后续访问：调用 /api/v1/app/version/check?current=<已存版本>
 *   4. 如果服务器版本 > 已存版本 → 弹窗提示更新
 *   5. 用户点击「立即更新」→ 清除缓存 + 强制刷新页面
 *   6. 用户点击「稍后再说」→ 记录新版本，下次再对比
 */
import { ref } from 'vue';
import axios from 'axios';

const STORAGE_KEY = 'molimama_app_version';
const POLL_INTERVAL = 5 * 60 * 1000; // 5 分钟

const currentVersion = ref(
  (typeof localStorage !== 'undefined' && localStorage.getItem(STORAGE_KEY)) || '0.0.0'
);
const latestVersion = ref(currentVersion.value);
const hasUpdate = ref(false);
const releaseNotes = ref('');
const forceUpdate = ref(false);
const showUpdateDialog = ref(false);
let timer = null;
let started = false;

async function fetchLatestVersion() {
  try {
    const { data } = await axios.get('/api/v1/app/version');
    return data?.data || data;
  } catch (err) {
    console.warn('[AppVersion] fetch version failed:', err.message);
    return null;
  }
}

async function checkUpdate() {
  try {
    const { data } = await axios.get('/api/v1/app/version/check', {
      params: { current: currentVersion.value }
    });
    const payload = data?.data || data;
    latestVersion.value = payload.latestVersion;
    releaseNotes.value = payload.releaseNotes || '';
    forceUpdate.value = !!payload.forceUpdate;
    if (payload.hasUpdate) {
      hasUpdate.value = true;
      showUpdateDialog.value = true;
    }
  } catch (err) {
    console.warn('[AppVersion] check failed:', err.message);
  }
}

function recordVersion(version) {
  try {
    localStorage.setItem(STORAGE_KEY, String(version));
  } catch (_) {}
  currentVersion.value = version;
}

function applyUpdate() {
  recordVersion(latestVersion.value);
  if ('caches' in window) {
    caches.keys().then((names) => {
      names.forEach((name) => caches.delete(name));
    });
  }
  location.reload();
}

function dismissUpdate() {
  showUpdateDialog.value = false;
  recordVersion(latestVersion.value);
}

async function init() {
  if (started) return;
  started = true;
  const stored = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
  if (!stored) {
    const latest = await fetchLatestVersion();
    if (latest?.version) recordVersion(latest.version);
  } else {
    await checkUpdate();
  }
  timer = setInterval(checkUpdate, POLL_INTERVAL);
}

function cleanup() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  started = false;
}

export function useAppVersion() {
  return {
    currentVersion,
    latestVersion,
    hasUpdate,
    releaseNotes,
    forceUpdate,
    showUpdateDialog,
    applyUpdate,
    dismissUpdate,
    init,
    cleanup,
  };
}
