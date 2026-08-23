'use strict';

const INPUT_KEYS = Object.freeze([
  'version_id',
  'shot_id',
  'video_generation_id',
  'candidate_sha256',
  'dependency_hash',
]);

const VERIFIER_NAMES = Object.freeze([
  'probeMedia',
  'verifyFullFrameCoverage',
  'verifyLocale',
  'verifyNativeAudio',
  'verifySubtitles',
  'verifyLipSync',
]);

async function verifyCandidateQuality(ctx, rawInput, dependencies) {
  const input = strictCandidateInput(rawInput);
  const verifiers = strictVerifiers(dependencies);

  const mediaEvidence = await verifiers.probeMedia(ctx, input);
  const coverageEvidence = await verifiers.verifyFullFrameCoverage(ctx, input);
  const localeEvidence = await verifiers.verifyLocale(ctx, input);
  const audioEvidence = await verifiers.verifyNativeAudio(ctx, input);
  const subtitleEvidence = await verifiers.verifySubtitles(ctx, input);
  const lipSyncEvidence = await verifiers.verifyLipSync(ctx, input);

  assertEvidenceShape(mediaEvidence, coverageEvidence, localeEvidence, audioEvidence, subtitleEvidence, lipSyncEvidence);

  const dialogueMode = audioEvidence.dialogue_mode;
  const languageMatches = localeEvidence.target_language_matches === true
    && (dialogueMode === 'silent' || audioEvidence.language === localeEvidence.language);
  const metrics = {
    media: {
      readable: mediaEvidence.readable,
      duration_matches: mediaEvidence.duration_matches,
      dimensions_match: mediaEvidence.dimensions_match,
      hash_matches: mediaEvidence.candidate_sha256 === input.candidate_sha256,
    },
    dependencies: {
      current: coverageEvidence.dependencies_current,
      hash_matches: coverageEvidence.dependency_hash === input.dependency_hash,
    },
    residuals: {
      original_person_absent: coverageEvidence.original_person_residual === false,
      original_text_absent: coverageEvidence.original_text_residual === false,
    },
    identity: {
      all_bound: coverageEvidence.identity.all_bound,
      stable: coverageEvidence.identity.stable,
      person_count_matches: coverageEvidence.identity.person_count_matches,
      relationships_match: coverageEvidence.identity.relationships_match,
    },
    dialogue: {
      has_audio: audioEvidence.has_audio,
      dialogue_mode: dialogueMode,
      language: audioEvidence.language,
      language_matches: languageMatches,
      exact_target_text: audioEvidence.exact_target_text,
      speaker_voice_matches: audioEvidence.speaker_voice_matches,
      ambient_audio_safe: audioEvidence.ambient_audio_safe,
      evidence_hash: audioEvidence.evidence_hash,
    },
    subtitles: {
      present: subtitleEvidence.present,
      within_shot: subtitleEvidence.within_shot,
    },
    lip_sync: {
      evidence_available: lipSyncEvidence.evidence_available,
      passed: lipSyncEvidence.passed,
    },
  };

  const reasonCodes = qualityReasonCodes(metrics);
  const decision = reasonCodes.includes('lip_sync_evidence_missing')
    ? 'needs_review'
    : reasonCodes.length > 0 ? 'rejected' : 'approved';

  return {
    decision,
    reason_codes: reasonCodes,
    metrics,
  };
}

function strictCandidateInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !sameKeys(value, INPUT_KEYS)
    || !isPositiveInteger(value.version_id)
    || !isPositiveInteger(value.shot_id)
    || !isPositiveInteger(value.video_generation_id)
    || !isSha256(value.candidate_sha256)
    || !isSha256(value.dependency_hash)) {
    throw codedError('REDRAW_CANDIDATE_QUALITY_INPUT_INVALID', '候选质量输入无效');
  }
  return Object.fromEntries(INPUT_KEYS.map((key) => [key, value[key]]));
}

function strictVerifiers(value) {
  if (!value || typeof value !== 'object'
    || VERIFIER_NAMES.some((name) => typeof value[name] !== 'function')) {
    throw codedError('REDRAW_CANDIDATE_QUALITY_VERIFIER_INVALID', '候选质量验证器未完整配置');
  }
  return value;
}

function assertEvidenceShape(media, coverage, locale, audio, subtitles, lipSync) {
  const validMedia = isBoolean(media?.readable)
    && isBoolean(media?.duration_matches)
    && isBoolean(media?.dimensions_match)
    && isSha256(media?.candidate_sha256);
  const validIdentity = isBoolean(coverage?.identity?.all_bound)
    && isBoolean(coverage?.identity?.stable)
    && isBoolean(coverage?.identity?.person_count_matches)
    && isBoolean(coverage?.identity?.relationships_match);
  const validCoverage = isSha256(coverage?.dependency_hash)
    && isBoolean(coverage?.dependencies_current)
    && isBoolean(coverage?.original_person_residual)
    && isBoolean(coverage?.original_text_residual)
    && validIdentity;
  const validLocale = (typeof locale?.language === 'string' || locale?.language === null)
    && isBoolean(locale?.target_language_matches);
  const validAudio = isBoolean(audio?.has_audio)
    && ['dialogue', 'silent'].includes(audio?.dialogue_mode)
    && (typeof audio?.language === 'string' || audio?.language === null)
    && (isBoolean(audio?.exact_target_text) || audio?.exact_target_text === null)
    && isBoolean(audio?.speaker_voice_matches)
    && isBoolean(audio?.ambient_audio_safe)
    && isSha256(audio?.evidence_hash);
  const validSubtitles = isBoolean(subtitles?.present) && isBoolean(subtitles?.within_shot);
  const validLipSync = isBoolean(lipSync?.evidence_available) && isBoolean(lipSync?.passed);
  if (!validMedia || !validCoverage || !validLocale || !validAudio || !validSubtitles || !validLipSync) {
    throw codedError('REDRAW_CANDIDATE_QUALITY_EVIDENCE_INVALID', '候选质量证据无效');
  }
}

function qualityReasonCodes(metrics) {
  const reasons = [];
  if (!metrics.media.readable) reasons.push('media_unreadable');
  if (!metrics.media.duration_matches) reasons.push('media_duration_mismatch');
  if (!metrics.media.dimensions_match) reasons.push('media_dimensions_mismatch');
  if (!metrics.media.hash_matches) reasons.push('candidate_hash_mismatch');
  if (!metrics.dependencies.current || !metrics.dependencies.hash_matches) reasons.push('dependency_hash_stale');
  if (!metrics.residuals.original_person_absent) reasons.push('original_person_residual');
  if (!metrics.residuals.original_text_absent) reasons.push('original_text_residual');
  if (!metrics.identity.all_bound) reasons.push('identity_not_all_bound');
  if (!metrics.identity.stable) reasons.push('identity_drift');
  if (!metrics.identity.person_count_matches) reasons.push('person_count_mismatch');
  if (!metrics.identity.relationships_match) reasons.push('relationship_mismatch');

  if (!metrics.dialogue.ambient_audio_safe) reasons.push('ambient_audio_unsafe');
  if (metrics.dialogue.dialogue_mode === 'dialogue') {
    if (!metrics.dialogue.has_audio) reasons.push('audio_track_missing');
    if (!metrics.dialogue.language_matches) reasons.push('target_language_mismatch');
    if (metrics.dialogue.exact_target_text !== true) reasons.push('target_dialogue_mismatch');
    if (!metrics.dialogue.speaker_voice_matches) reasons.push('speaker_voice_mismatch');
    if (!metrics.subtitles.present) reasons.push('subtitle_missing');
    if (!metrics.subtitles.within_shot) reasons.push('subtitle_out_of_bounds');
  } else {
    if (metrics.dialogue.exact_target_text !== null) reasons.push('silent_shot_dialogue_detected');
    if (metrics.subtitles.present && !metrics.subtitles.within_shot) reasons.push('subtitle_out_of_bounds');
  }
  if (!metrics.lip_sync.evidence_available) reasons.push('lip_sync_evidence_missing');
  else if (!metrics.lip_sync.passed) reasons.push('lip_sync_failed');
  return reasons;
}

function sameKeys(value, expected) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isSha256(value) {
  return /^[0-9a-f]{64}$/.test(String(value || ''));
}

function isBoolean(value) {
  return typeof value === 'boolean';
}

function codedError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

module.exports = {
  verifyCandidateQuality,
};
