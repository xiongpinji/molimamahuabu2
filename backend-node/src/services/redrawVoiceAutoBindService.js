'use strict';

/**
 * 样片转绘项目的"首次对白音色自动沿用"。
 *
 * 只处理转绘导入时开启了 voice_auto_bind 的工厂项目，不影响短剧工厂自己的项目。
 * 定时扫描：某个说话角色还没有音色时，找他单独说话、已生成完的分镜视频（按镜头顺序取第一个），
 * 用工厂现成的"提取音色"从视频里截出他的声音并绑定到角色，再刷新本项目分镜的音色快照；
 * 之后生成的含该角色的镜头会自动带上这段声音（Seedance 2.0 类模型）。
 *
 * 安全约束：只从"本镜全部台词都标了同一个说话人、且他在画面里"的镜头提取，
 * 多人对白、没标说话人的镜头一律跳过，避免把别人的声音绑错。提取在本机用 ffmpeg 完成，不产生费用。
 */

const voiceExtraction = require('./storyboardVoiceExtractionService');
const voiceLock = require('./storyboardVoiceLockService');

const DEFAULT_INTERVAL_MS = 30_000;
// 只看最近完成的视频，老项目不反复扫描。
const LOOKBACK_MS = 3 * 24 * 60 * 60 * 1000;

function text(value) {
  return value == null ? '' : String(value).trim();
}

function parseJson(raw, fallback) {
  if (raw == null || raw === '') return fallback;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(String(raw)); } catch (_) { return fallback; }
}

function hasActiveVoice(row) {
  const asset = parseJson(row.seedance2_voice_asset, null);
  return String(asset?.status || '').toLowerCase() === 'active' && Boolean(text(asset?.url));
}

function autoBindDramaIds(db, now) {
  const since = new Date(now - LOOKBACK_MS).toISOString();
  return db.prepare(`
    SELECT DISTINCT d.id
    FROM dramas d
    JOIN video_generations v ON v.drama_id = d.id
    WHERE d.deleted_at IS NULL AND v.deleted_at IS NULL AND v.status = 'completed'
      AND COALESCE(v.completed_at, v.updated_at) >= ?
      AND json_extract(d.metadata, '$.voice_auto_bind') = 1
  `).all(since).map((row) => Number(row.id));
}

/**
 * 本项目里还没有音色、且已有可提取镜头的角色，每个角色给出按镜头顺序排好的候选（分镜 + 最新完成视频）。
 */
function findCandidates(db, dramaId) {
  const characters = db.prepare('SELECT id, name, seedance2_voice_asset FROM characters WHERE drama_id = ? AND deleted_at IS NULL')
    .all(dramaId);
  const waiting = new Map(characters.filter((row) => !hasActiveVoice(row)).map((row) => [Number(row.id), row]));
  if (!waiting.size) return [];
  const names = characters.map((row) => text(row.name)).filter(Boolean);
  const byName = new Map(characters.map((row) => [text(row.name), Number(row.id)]));
  const storyboards = db.prepare(`
    SELECT s.id, s.storyboard_number, s.dialogue, s.characters
    FROM storyboards s JOIN episodes e ON e.id = s.episode_id
    WHERE e.drama_id = ? AND s.deleted_at IS NULL AND e.deleted_at IS NULL
    ORDER BY e.episode_number ASC, s.storyboard_number ASC, s.id ASC
  `).all(dramaId);
  const latestVideo = db.prepare(`
    SELECT id FROM video_generations
    WHERE storyboard_id = ? AND drama_id = ? AND status = 'completed' AND deleted_at IS NULL
    ORDER BY id DESC LIMIT 1
  `);
  const candidates = new Map();
  for (const storyboard of storyboards) {
    const lines = text(storyboard.dialogue).split(/\n+/).map(text).filter(Boolean);
    if (!lines.length) continue;
    const entries = voiceExtraction.parseDialogueSpeakerEntries(storyboard.dialogue, names);
    // 每一行都要有说话人，且全是同一个人。
    if (entries.length < lines.length) continue;
    const speakers = [...new Set(entries.map((entry) => byName.get(text(entry.speaker))).filter(Boolean))];
    if (speakers.length !== 1 || entries.some((entry) => !byName.has(text(entry.speaker)))) continue;
    const characterId = speakers[0];
    if (!waiting.has(characterId)) continue;
    const visible = voiceExtraction.parseStoryboardCharacterIds(storyboard.characters);
    if (!visible.includes(characterId)) continue;
    const video = latestVideo.get(Number(storyboard.id), dramaId);
    if (!video) continue;
    if (!candidates.has(characterId)) candidates.set(characterId, []);
    candidates.get(characterId).push({ storyboardId: Number(storyboard.id), videoId: Number(video.id) });
  }
  return [...candidates.entries()].map(([characterId, shots]) => ({ characterId, name: waiting.get(characterId).name, shots }));
}

function refreshDramaSnapshots(db, dramaId) {
  const ids = db.prepare(`
    SELECT s.id FROM storyboards s JOIN episodes e ON e.id = s.episode_id
    WHERE e.drama_id = ? AND s.deleted_at IS NULL AND e.deleted_at IS NULL
  `).all(dramaId).map((row) => Number(row.id));
  for (const id of ids) voiceLock.refreshStoryboardVoiceSnapshot(db, id);
  return ids.length;
}

/**
 * 跑一轮。attempted 记录已经试过（成功或失败）的"视频:角色"，同一段视频不反复提取。
 * @returns {Array<{drama_id, character_id, storyboard_id, video_id, ok, code?}>}
 */
async function runOnce(db, log, { cfg, attempted = new Set(), now = Date.now(), extract = voiceExtraction.extractStoryboardVoice } = {}) {
  const results = [];
  for (const dramaId of autoBindDramaIds(db, now)) {
    let bound = false;
    for (const candidate of findCandidates(db, dramaId)) {
      const next = candidate.shots.find((shot) => !attempted.has(`${shot.videoId}:${candidate.characterId}`));
      if (!next) continue;
      attempted.add(`${next.videoId}:${candidate.characterId}`);
      const result = await extract({
        db, cfg, log, storyboardId: next.storyboardId, videoId: next.videoId, characterId: candidate.characterId,
      });
      const row = {
        drama_id: dramaId, character_id: candidate.characterId, storyboard_id: next.storyboardId, video_id: next.videoId, ok: Boolean(result?.ok),
      };
      if (result?.ok) {
        bound = true;
        log?.info?.('[转绘音色] 已从首次单独对白镜头提取并绑定角色音色', { ...row, name: candidate.name });
      } else {
        row.code = result?.code || 'VOICE_EXTRACTION_FAILED';
        log?.warn?.('[转绘音色] 本镜提取失败，改用该角色下一个单独对白镜头', { ...row, error: result?.error });
      }
      results.push(row);
    }
    if (bound) refreshDramaSnapshots(db, dramaId);
  }
  return results;
}

let timer = null;
let running = false;
const attemptedAcrossTicks = new Set();

function startRedrawVoiceAutoBind(db, log, { intervalMs = DEFAULT_INTERVAL_MS, cfg } = {}) {
  if (timer || !(Number(intervalMs) > 0)) return false;
  timer = setInterval(() => {
    if (running) return;
    running = true;
    runOnce(db, log, { cfg, attempted: attemptedAcrossTicks })
      .catch((error) => log?.error?.('[转绘音色] 自动沿用扫描失败', { error: error.message }))
      .finally(() => { running = false; });
  }, Number(intervalMs));
  if (typeof timer.unref === 'function') timer.unref();
  return true;
}

function stopRedrawVoiceAutoBind() {
  if (!timer) return false;
  clearInterval(timer);
  timer = null;
  return true;
}

module.exports = {
  DEFAULT_INTERVAL_MS,
  findCandidates,
  runOnce,
  startRedrawVoiceAutoBind,
  stopRedrawVoiceAutoBind,
};
