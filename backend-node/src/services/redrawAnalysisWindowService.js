const { createHash } = require('crypto');
const { normalizeSourceFacts, stableStringify } = require('./redrawAnalysisService');
const { validatePersistedSourceAudioV2 } = require('./redrawSourceAudioEvidenceService');

const MAX_WINDOW_MS = 24_000;
const SHEET_FRAMES = 12;
const NARRATIVE_FIELDS = ['story', 'causal_chain', 'locked_facts', 'reversals'];

function codedError(code, message) {
  return Object.assign(new Error(message), { code });
}

function windowSheets(startMs, endMs) {
  const sheets = [];
  for (const mode of ['full', 'lower_third']) {
    const sampleRate = mode === 'lower_third' ? 2 : 1;
    const pageMs = SHEET_FRAMES * 1000 / sampleRate;
    for (let start = startMs; start < endMs; start += pageMs) {
      const durationMs = Math.min(pageMs, endMs - start);
      sheets.push({ mode, startSeconds: start / 1000, durationSeconds: durationMs / 1000,
        sampleRate, frameCount: Math.max(1, Math.ceil(durationMs * sampleRate / 1000)) });
    }
  }
  return sheets;
}

function planAnalysisWindows(probe, audioEvidence, buildPrompt) {
  const durationMs = probe.duration_ms;
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0) {
    throw codedError('REDRAW_NATIVE_DURATION_MISMATCH', '源片时长必须是正整数毫秒');
  }
  if (audioEvidence?.segments != null && !Array.isArray(audioEvidence.segments)) {
    throw codedError('REDRAW_NATIVE_AUDIO_TIMING_INVALID', '音频 segments 必须是数组');
  }
  const isV2 = audioEvidence?.schema_version === 'redraw-source-audio-evidence-v2';
  if (isV2) {
    const { result_asset_id, evidence_sha256, evidence_ref, evidence_asset, source, ...persisted } = audioEvidence;
    validatePersistedSourceAudioV2(persisted);
  }
  const segments = audioEvidence?.segments || [];
  for (const [index, segment] of segments.entries()) {
    const validTime = isV2 ? Number.isFinite : Number.isSafeInteger;
    if (!validTime(segment?.start_ms) || !validTime(segment?.end_ms)
      || segment.start_ms < 0 || segment.end_ms <= segment.start_ms || segment.end_ms > durationMs) {
      throw codedError('REDRAW_NATIVE_AUDIO_TIMING_INVALID', `音频 segments[${index}] 时间码必须合法且在源片内`);
    }
  }
  const windows = [];
  function preflight(startMs, endMs) {
    const evidence = { ...audioEvidence,
      segments: segments.filter((segment) => segment.start_ms < endMs && segment.end_ms > startMs) };
    let prompt;
    try {
      prompt = buildPrompt({ ...probe, duration_ms: endMs - startMs,
        window_start_ms: startMs, window_end_ms: endMs }, evidence);
    } catch (error) {
      if (error.code !== 'REDRAW_NATIVE_AUDIO_PROMPT_LIMIT' || endMs - startMs <= 1) throw error;
      const middle = startMs + Math.floor((endMs - startMs) / 2);
      preflight(startMs, middle);
      preflight(middle, endMs);
      return;
    }
    windows.push({ start_ms: startMs, end_ms: endMs, prompt, sheets: windowSheets(startMs, endMs) });
  }
  for (let startMs = 0; startMs < durationMs; startMs += MAX_WINDOW_MS) {
    preflight(startMs, Math.min(durationMs, startMs + MAX_WINDOW_MS));
  }
  return windows;
}

function normalizeWithoutHash(facts) {
  const { facts_hash: ignoredHash, ...raw } = facts;
  return normalizeSourceFacts(raw);
}

function mergeWindowFacts(windows, durationMs) {
  if (!Array.isArray(windows) || !windows.length) {
    throw codedError('REDRAW_NATIVE_TIMELINE_INCOMPLETE', '缺少视觉分析窗口');
  }
  let previousEnd = 0;
  const localFacts = windows.map((window) => {
    if (!Number.isSafeInteger(window.start_ms) || !Number.isSafeInteger(window.end_ms)
      || window.start_ms !== previousEnd || window.end_ms <= window.start_ms) {
      throw codedError('REDRAW_NATIVE_TIMELINE_INCOMPLETE', '视觉分析窗口未连续覆盖源片');
    }
    const facts = normalizeWithoutHash(window.facts);
    if (facts.duration_ms !== window.end_ms - window.start_ms) {
      throw codedError('REDRAW_NATIVE_DURATION_MISMATCH', '视觉窗口时长不一致');
    }
    previousEnd = window.end_ms;
    return facts;
  });
  if (previousEnd !== durationMs) throw codedError('REDRAW_NATIVE_TIMELINE_INCOMPLETE', '视觉窗口未覆盖完整源片');
  if (windows.length === 1) return { facts: localFacts[0], diagnostics: {} };

  const combined = { schema_version: '2.0', duration_ms: durationMs, characters: [], scenes: [], props: [], shots: [],
    story: [], causal_chain: [], locked_facts: [], reversals: [], episode_hook: windows.at(-1).facts.episode_hook };
  const windowIdMaps = [];
  for (const [windowIndex, window] of windows.entries()) {
    const local = localFacts[windowIndex];
    const namespace = `w${String(windowIndex + 1).padStart(6, '0')}`;
    const idMaps = {};
    function rebind(items, kind) {
      const map = new Map(items.map((item, index) => [item.id, `${namespace}-${kind}${String(index + 1).padStart(6, '0')}`]));
      idMaps[kind] = Object.fromEntries(map);
      return map;
    }
    const characters = rebind(local.characters, 'c');
    const scenes = rebind(local.scenes, 's');
    const props = rebind(local.props, 'p');
    const shots = rebind(local.shots, 'sh');
    const regions = rebind(local.shots.flatMap((shot) => shot.text_regions), 't');
    const offsetRange = (range) => ({ start_ms: range.start_ms + window.start_ms, end_ms: range.end_ms + window.start_ms });
    combined.characters.push(...local.characters.map((character) => ({ ...character, id: characters.get(character.id) })));
    combined.scenes.push(...local.scenes.map((scene) => ({ ...scene, id: scenes.get(scene.id), source_ranges: scene.source_ranges.map(offsetRange) })));
    combined.props.push(...local.props.map((prop) => ({ ...prop, id: props.get(prop.id), evidence_ranges: prop.evidence_ranges.map(offsetRange) })));
    for (const [shotIndex, shot] of local.shots.entries()) {
      const artificialBoundary = (windowIndex > 0 && shotIndex === 0)
        || (windowIndex < windows.length - 1 && shotIndex === local.shots.length - 1);
      combined.shots.push({ ...shot, id: shots.get(shot.id), index: combined.shots.length + 1, ...offsetRange(shot),
        visible_character_ids: shot.visible_character_ids.map((id) => characters.get(id)),
        text_regions: shot.text_regions.map((region) => ({ ...region, id: regions.get(region.id) })),
        confidence: { ...shot.confidence, character_mapping: 0,
          shot_boundary: artificialBoundary ? 0 : shot.confidence.shot_boundary } });
    }
    for (const field of NARRATIVE_FIELDS) combined[field].push(...window.facts[field]);
    windowIdMaps.push({ start_ms: window.start_ms, end_ms: window.end_ms, ids: idMaps });
  }
  const facts = normalizeSourceFacts(combined);
  // Keep canonical facts/hash intact; the sidecar preserves the original window evidence order and text.
  const orderedNarratives = Object.fromEntries(NARRATIVE_FIELDS.map((field) => [field, [...combined[field]]]));
  orderedNarratives.episode_hook = combined.episode_hook;
  return { facts, diagnostics: { needs_review: true, cross_window_identity: 'needs_review',
    artificial_window_boundaries: 'needs_review', window_id_maps: windowIdMaps,
    ordered_narratives: orderedNarratives,
    narrative_order_hash: createHash('sha256').update(stableStringify(orderedNarratives)).digest('hex') } };
}

module.exports = { planAnalysisWindows, mergeWindowFacts };
