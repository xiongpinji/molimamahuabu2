const REDRAW_OUTPUT_CAPABILITIES = ['text', 'subtitles', 'character_image', 'clean_plate_image', 'tts', 'video', 'native_dialogue_audio'];
const NATIVE_DIALOGUE_AUDIO_CONTRACT = 'redraw-native-dialogue-audio-v1';

function parseJson(value, fallback = {}) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || value.trim() === '') return fallback;
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}

function validateGenerationEvidence(evidence, canReadArtifact) {
  const parsed = parseJson(evidence);
  if (!parsed.provider || !parsed.model || !parsed.task_id) return false;
  if (parsed.terminal_status !== 'completed') return false;
  if (parsed.artifact_id === undefined || parsed.artifact_id === null || parsed.artifact_id === '') return false;
  if (typeof canReadArtifact !== 'function') return false;
  try {
    return canReadArtifact(parsed.artifact_id) === true;
  } catch (_) {
    return false;
  }
}

function isSha256(value) {
  return /^[0-9a-f]{64}$/.test(String(value || ''));
}

function sameText(left, right) {
  return String(left || '').trim() === String(right || '').trim();
}

function carrierConfigId(evidence) {
  return Number(evidence.config_id ?? evidence.ai_service_config_id);
}

function nativeReviewPassed(review) {
  if (!review || typeof review !== 'object' || Array.isArray(review)) return false;
  if (review.status !== 'passed') return false;
  for (const key of ['speaker_order', 'lip_sync', 'extra_dialogue']) {
    if (review[key] !== 'passed') return false;
  }
  return true;
}

function validateNativeDialogueAudioEvidence(evidence, canReadArtifact, row, entry) {
  const parsed = parseJson(evidence);
  const verification = parsed.locale_verification;
  if (parsed.contract !== NATIVE_DIALOGUE_AUDIO_CONTRACT) return false;
  if (!sameText(parsed.provider, row?.provider)) return false;
  if (!sameText(parsed.protocol, row?.api_protocol)) return false;
  if (!sameText(parsed.model, row?.default_model || row?.model)) return false;
  if (carrierConfigId(parsed) !== Number(row?.id)) return false;
  if (!sameText(parsed.config_updated_at, row?.updated_at)) return false;
  if (!parsed.provider_task_id) return false;
  if (parsed.terminal_status !== 'completed') return false;
  if (parsed.artifact_id === undefined || parsed.artifact_id === null || parsed.artifact_id === '') return false;
  if (!isSha256(parsed.artifact_sha256)) return false;
  if (parsed.media?.video_stream !== true || parsed.media?.audio_stream !== true) return false;
  if (!verification || typeof verification !== 'object') return false;
  if (verification.language_verified !== true || verification.locale_verified !== false) return false;
  if (!sameText(verification.language, entry?.language || entry?.target_language || entry?.locale)) return false;
  if (!nativeReviewPassed(parsed.human_review)) return false;
  if (typeof canReadArtifact !== 'function') return false;
  try {
    return canReadArtifact(parsed.artifact_id) === true;
  } catch (_) {
    return false;
  }
}

function listPublicStylePresets(db, canReadArtifact) {
  const rows = db.prepare(`
    SELECT *
    FROM redraw_style_presets
    WHERE status = 'verified'
      AND deleted_at IS NULL
    ORDER BY category ASC, sort_order ASC, version ASC
  `).all();

  return rows.filter((row) => validateGenerationEvidence(row.verification_evidence_json, canReadArtifact));
}

function summarizeLocaleCapability({ text, subtitles, character_image, clean_plate_image, tts, video, native_dialogue_audio }) {
  const hasAudio = Boolean(tts || native_dialogue_audio);
  if (text && subtitles && character_image && clean_plate_image && hasAudio && video) return 'full_output';
  if (text && subtitles && hasAudio && video && (!character_image || !clean_plate_image)) return 'asset_pending';
  if (text && subtitles && !hasAudio && video) return 'subtitle_only';
  if (text && subtitles && !hasAudio) return 'voice_pending';
  return 'blocking';
}

function tableExists(db, table) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
}

function collectLocaleEntries(settings) {
  const parsed = parseJson(settings);
  const entries = parsed.redraw_locale_capabilities || parsed.redrawLocaleCapabilities || [];
  if (!Array.isArray(entries)) return [];
  return entries.filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry));
}

function evidenceForCapability(entry, capability) {
  if (entry.evidence && typeof entry.evidence === 'object') return entry.evidence[capability];
  return entry[`${capability}_evidence_json`] || entry[`${capability}_evidence`];
}

function resolveVerifiedLocaleCapability(db, input = {}) {
  const capabilityName = String(input.capability || '').trim();
  const locale = String(input.locale || '').trim();
  const market = String(input.market || '').trim();
  const canReadArtifact = input.canReadArtifact;

  if (!REDRAW_OUTPUT_CAPABILITIES.includes(capabilityName)) return null;
  if (!locale) return null;
  if (typeof canReadArtifact !== 'function') return null;
  if (!tableExists(db, 'ai_service_configs')) return null;

  const rows = db.prepare(`
    SELECT *
    FROM ai_service_configs
    WHERE COALESCE(is_active, 1) = 1
      AND deleted_at IS NULL
    ORDER BY is_default DESC, priority DESC, id ASC
  `).all();

  for (const row of rows) {
    for (const entry of collectLocaleEntries(row.settings)) {
      if (entry.status !== 'verified') continue;
      if (String(entry.locale || '').trim() !== locale) continue;
      if (String(entry.market || '').trim() !== market) continue;

      const evidence = parseJson(evidenceForCapability(entry, capabilityName));
      const valid = capabilityName === 'native_dialogue_audio'
        ? validateNativeDialogueAudioEvidence(evidence, canReadArtifact, row, entry)
        : validateGenerationEvidence(evidence, canReadArtifact);
      if (!valid) continue;
      return {
        provider: String(evidence.provider),
        model: String(evidence.model),
        evidence,
        ...(['tts', 'native_dialogue_audio'].includes(capabilityName) ? {
          carrier_config_id: Number(row.id),
          carrier_service_type: String(row.service_type || ''),
          carrier_provider: String(row.provider || ''),
          carrier_updated_at: String(row.updated_at || ''),
        } : {}),
        ...(capabilityName === 'native_dialogue_audio' ? {
          protocol: String(evidence.protocol || row.api_protocol || ''),
        } : {}),
      };
    }
  }

  return null;
}

function listLocaleCapabilities(db, canReadArtifact) {
  if (!tableExists(db, 'ai_service_configs')) return [];

  const rows = db.prepare(`
    SELECT *
    FROM ai_service_configs
    WHERE COALESCE(is_active, 1) = 1
      AND deleted_at IS NULL
  `).all();
  const byLocale = new Map();

  for (const row of rows) {
    for (const entry of collectLocaleEntries(row.settings)) {
      if (entry.status !== 'verified') continue;
      const locale = String(entry.locale || '').trim();
      const market = String(entry.market || '').trim();
      if (!locale) continue;
      const key = `${locale}\u0000${market}`;
      const capability = byLocale.get(key) || {
        locale,
        market,
        language: String(entry.language || entry.target_language || locale).trim() || locale,
        region_status: market ? 'verified' : 'unverified',
        locale_verified: Boolean(market),
        text: false,
        subtitles: false,
        character_image: false,
        clean_plate_image: false,
        tts: false,
        video: false,
        native_dialogue_audio: false,
      };
      for (const name of REDRAW_OUTPUT_CAPABILITIES) {
        const valid = name === 'native_dialogue_audio'
          ? validateNativeDialogueAudioEvidence(evidenceForCapability(entry, name), canReadArtifact, row, entry)
          : validateGenerationEvidence(evidenceForCapability(entry, name), canReadArtifact);
        capability[name] = capability[name] || valid;
      }
      byLocale.set(key, capability);
    }
  }

  return [...byLocale.values()]
    .sort((left, right) => `${left.locale}\u0000${left.market}`.localeCompare(`${right.locale}\u0000${right.market}`))
    .map((capability) => {
    const audioMode = capability.native_dialogue_audio ? 'native' : capability.tts ? 'replace' : null;
    const blocking = ['text', 'subtitles', 'character_image', 'clean_plate_image', 'video']
      .filter((name) => !capability[name]);
    if (!capability.tts && !capability.native_dialogue_audio) {
      blocking.push('tts', 'native_dialogue_audio');
    }
    return {
      locale: capability.locale,
      market: capability.market,
      language: capability.language,
      region_status: capability.region_status,
      audio_mode: audioMode,
      native_dialogue_audio: capability.native_dialogue_audio,
      locale_verified: capability.locale_verified,
      status: summarizeLocaleCapability(capability),
      blocking,
    };
  });
}

module.exports = {
  REDRAW_OUTPUT_CAPABILITIES,
  validateGenerationEvidence,
  validateNativeDialogueAudioEvidence,
  listPublicStylePresets,
  summarizeLocaleCapability,
  resolveVerifiedLocaleCapability,
  listLocaleCapabilities,
};
