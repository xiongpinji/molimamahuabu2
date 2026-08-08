const REDRAW_OUTPUT_CAPABILITIES = ['text', 'subtitles', 'character_image', 'clean_plate_image', 'tts', 'video'];

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

function summarizeLocaleCapability({ text, subtitles, character_image, clean_plate_image, tts, video }) {
  if (text && subtitles && character_image && clean_plate_image && tts && video) return 'full_output';
  if (text && subtitles && tts && video && (!character_image || !clean_plate_image)) return 'asset_pending';
  if (text && subtitles && !tts && video) return 'subtitle_only';
  if (text && subtitles && !tts) return 'voice_pending';
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
    SELECT settings
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
      if (!validateGenerationEvidence(evidence, canReadArtifact)) continue;
      return {
        provider: String(evidence.provider),
        model: String(evidence.model),
        evidence,
      };
    }
  }

  return null;
}

function listLocaleCapabilities(db, canReadArtifact) {
  if (!tableExists(db, 'ai_service_configs')) return [];

  const rows = db.prepare(`
    SELECT settings
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
        text: false,
        subtitles: false,
        character_image: false,
        clean_plate_image: false,
        tts: false,
        video: false,
      };
      for (const name of REDRAW_OUTPUT_CAPABILITIES) {
        capability[name] = capability[name] || validateGenerationEvidence(evidenceForCapability(entry, name), canReadArtifact);
      }
      byLocale.set(key, capability);
    }
  }

  return [...byLocale.values()]
    .sort((left, right) => `${left.locale}\u0000${left.market}`.localeCompare(`${right.locale}\u0000${right.market}`))
    .map((capability) => {
    return {
      locale: capability.locale,
      market: capability.market,
      status: summarizeLocaleCapability(capability),
      blocking: REDRAW_OUTPUT_CAPABILITIES
        .filter((name) => !capability[name]),
    };
  });
}

module.exports = {
  REDRAW_OUTPUT_CAPABILITIES,
  validateGenerationEvidence,
  listPublicStylePresets,
  summarizeLocaleCapability,
  resolveVerifiedLocaleCapability,
  listLocaleCapabilities,
};
