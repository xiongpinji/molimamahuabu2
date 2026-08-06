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
  return canReadArtifact(parsed.artifact_id) === true;
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

function summarizeLocaleCapability({ text, subtitles, tts, video }) {
  if (text && subtitles && tts && video) return 'full_output';
  if (text && subtitles && !tts && video) return 'subtitle_only';
  if (text && subtitles && !tts) return 'voice_pending';
  return 'blocking';
}

function listLocaleCapabilities(db, canReadArtifact) {
  const rows = db.prepare(`
    SELECT locale, market, text_evidence_json, subtitles_evidence_json, tts_evidence_json, video_evidence_json
    FROM redraw_locale_capabilities
    WHERE status = 'verified'
      AND deleted_at IS NULL
    ORDER BY locale ASC, market ASC
  `).all();

  return rows.map((row) => {
    const capability = {
      text: validateGenerationEvidence(row.text_evidence_json, canReadArtifact),
      subtitles: validateGenerationEvidence(row.subtitles_evidence_json, canReadArtifact),
      tts: validateGenerationEvidence(row.tts_evidence_json, canReadArtifact),
      video: validateGenerationEvidence(row.video_evidence_json, canReadArtifact),
    };
    return {
      locale: row.locale,
      market: row.market,
      status: summarizeLocaleCapability(capability),
      blocking: Object.entries(capability)
        .filter(([, ok]) => !ok)
        .map(([name]) => name),
    };
  });
}

module.exports = {
  validateGenerationEvidence,
  listPublicStylePresets,
  summarizeLocaleCapability,
  listLocaleCapabilities,
};
