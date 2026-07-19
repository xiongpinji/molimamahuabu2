/**
 * 为不支持参考音频克隆的视频模型生成稳定的角色声音提示。
 *
 * 这不是音色克隆：文字只能约束音高、音质、语速等可观察特征。
 * 角色 ID + voice_style 决定锚点，使同一角色跨分镜得到同一套描述。
 */

function parseJson(raw, fallback = null) {
  if (raw == null || raw === '') return fallback;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(String(raw)); } catch (_) { return fallback; }
}

function parseRefs(raw) {
  const value = parseJson(raw, raw);
  const list = Array.isArray(value) ? value : value == null || value === '' ? [] : [value];
  const seen = new Set();
  return list.map((item) => {
    const object = item && typeof item === 'object' ? item : null;
    const id = Number(object ? object.id : item);
    const name = String(object?.name || object?.character_name || (typeof item === 'string' && !/^\d+$/.test(item) ? item : '')).trim();
    const key = Number.isInteger(id) && id > 0 ? `id:${id}` : name ? `name:${name}` : '';
    if (!key || seen.has(key)) return null;
    seen.add(key);
    return { id: Number.isInteger(id) && id > 0 ? id : null, name };
  }).filter(Boolean);
}

function normalizeName(name) {
  return String(name || '').trim().toLowerCase().replace(/[\s　]+/g, '');
}

function hashNumber(value) {
  let hash = 2166136261;
  for (const char of String(value || '')) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

const PITCHES = ['medium-low pitch', 'mid-range pitch', 'medium-high pitch'];
const TIMBRES = ['warm clear timbre', 'soft breathy timbre', 'bright focused timbre', 'deep textured timbre'];
const PACES = ['measured pace', 'natural conversational pace', 'slightly brisk pace'];

function generatedVoiceStyle(row) {
  const key = row.id || row.name || 'character';
  const hash = hashNumber(key);
  return `${PITCHES[hash % PITCHES.length]}, ${TIMBRES[(hash >>> 3) % TIMBRES.length]}, ${PACES[(hash >>> 6) % PACES.length]}, clear diction`;
}

function resolveCharacters(db, dramaId, storyboardId) {
  if (!db || !Number.isInteger(Number(dramaId)) || Number(dramaId) <= 0) return [];
  let storyboard;
  try {
    storyboard = db.prepare('SELECT characters, dialogue, voice_snapshot FROM storyboards WHERE id = ? AND deleted_at IS NULL')
      .get(Number(storyboardId));
  } catch (_) { return []; }
  if (!storyboard) return [];

  const snapshotRows = parseJson(storyboard.voice_snapshot, {})?.characters;
  // 快照只保存已有参考音色的角色；文字回退必须仍覆盖分镜中的全部对白角色。
  const storyboardRefs = parseRefs(storyboard.characters);
  const refs = storyboardRefs.length
    ? storyboardRefs
    : parseRefs(snapshotRows);
  let rows = [];
  try {
    rows = db.prepare(
      'SELECT id, name, role, voice_style FROM characters WHERE drama_id = ? AND deleted_at IS NULL ORDER BY id ASC'
    ).all(Number(dramaId));
  } catch (_) { return []; }
  const byId = new Map(rows.map((row) => [Number(row.id), row]));
  const byName = new Map(rows.map((row) => [normalizeName(row.name), row]));
  const out = [];
  const seen = new Set();
  for (const ref of refs) {
    const row = (ref.id && byId.get(ref.id)) || (ref.name && byName.get(normalizeName(ref.name)));
    if (!row || seen.has(Number(row.id))) continue;
    seen.add(Number(row.id));
    out.push(row);
  }
  // AI 生成的旧分镜可能未保存 characters，但对白仍带“角色名：对白”。
  if (!out.length && storyboard.dialogue) {
    for (const row of rows) {
      if (String(storyboard.dialogue).includes(`${row.name}：`) || String(storyboard.dialogue).includes(`${row.name}:`)) {
        out.push(row);
      }
    }
  }
  return out.slice(0, 6);
}

function isSilentModel(protocol, model) {
  const p = String(protocol || '').toLowerCase();
  const m = String(model || '').toLowerCase();
  return p === 'veo2' || /veo[-_ ]?2(?:\.|-|$)/i.test(m);
}

function supportsPromptAudio(protocol, model) {
  return !isSilentModel(protocol, model);
}

/** 返回追加后的提示词；无对白、静音模型或无角色时保持原文。 */
function appendVoiceAnchors({ db, dramaId, storyboardId, prompt, protocol, model }) {
  const base = String(prompt || '').trim();
  if (!base || !supportsPromptAudio(protocol, model) || !/[：:]|"|“|「|『/.test(base)) return base;
  try {
    const row = db.prepare('SELECT dialogue FROM storyboards WHERE id = ? AND deleted_at IS NULL').get(Number(storyboardId));
    if (!String(row?.dialogue || '').trim()) return base;
  } catch (_) {
    return base;
  }
  const characters = resolveCharacters(db, dramaId, storyboardId);
  if (!characters.length) return base;
  const lines = characters.map((row) => {
    const explicit = String(row.voice_style || '').trim();
    const style = explicit || generatedVoiceStyle(row);
    return `- ${row.name}: ${style}. Keep this voice distinct and consistent across shots.`;
  });
  const block = [
    'VOICE CONTINUITY (text guidance only; do not imitate a named person):',
    ...lines,
    'Dialogue must be spoken by the named character. Keep dialogue, ambience, and music separated; do not merge character voices.',
  ].join('\n');
  // Veo 3 documents a 1,024-token prompt limit; reserve most of the budget for
  // the actual shot description and keep this fallback block compact.
  const maxPromptChars = 3800;
  const baseText = base.slice(0, maxPromptChars);
  const room = Math.max(0, maxPromptChars - baseText.length - 2);
  return room > 0 ? `${baseText}\n\n${block.slice(0, room)}` : baseText;
}

module.exports = {
  appendVoiceAnchors,
  generatedVoiceStyle,
  isSilentModel,
  parseRefs,
  resolveCharacters,
  supportsPromptAudio,
};
