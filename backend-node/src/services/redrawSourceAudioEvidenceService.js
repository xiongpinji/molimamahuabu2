const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { isDeepStrictEqual, promisify } = require('node:util');

const realAssetService = require('./assetService');
const { stableStringify } = require('./redrawAnalysisService');
const { getFfmpegPath } = require('../utils/ffmpegPath');

const execFileAsync = promisify(execFile);
const SCHEMA_VERSION = 'redraw-source-audio-evidence-v1';
const INPUT_KEYS = ['sourceAssetId', 'tenantId', 'userId', 'workId'];
const EMPTY_TRANSCRIPT_SHA256 = sha256Text('[]');
const MAX_WORKER_AUDIO_BYTES = 67108864;
const AUDIO_COMMIT_MS = 1500000;
const AUDIO_OVERLAP_MS = 30000;
const SEAM_CANDIDATE_SCHEMA = 'redraw-source-audio-seam-candidate-v1';
const seamCandidates = new WeakMap();
const verifiedAudioContexts = new WeakMap();

async function analyzeSourceAudio(ctx = {}, input = {}) {
  const parsed = parseInput(input);
  const assertCurrent = () => ctx.assertAnalysisTaskCurrent?.(parsed);
  assertCurrent();
  const db = ctx.db;
  if (!db || typeof db.prepare !== 'function') throw codedError('SOURCE_AUDIO_DB_REQUIRED');
  const fsApi = ctx.fs || fs;
  const storageRoot = resolveDirectoryRoot(
    fsApi,
    ctx.storageRoot,
    'SOURCE_AUDIO_STORAGE_ROOT_INVALID',
  );
  const privateAudioRoot = resolvePrivateRoot(
    fsApi,
    ctx.privateAudioRoot || process.env.REDRAW_NATIVE_AUDIO_PRIVATE_TEMP_ROOT,
  );
  if (isInside(storageRoot, privateAudioRoot) || isInside(privateAudioRoot, storageRoot)) {
    throw codedError('SOURCE_AUDIO_PRIVATE_ROOT_INVALID');
  }

  const work = getOwnedWork(db, parsed);
  if (Number(work.source_asset_id) !== parsed.sourceAssetId) {
    throw codedError('SOURCE_AUDIO_SOURCE_ASSET_MISMATCH');
  }
  const assetService = ctx.assetService || realAssetService;
  const lookup = ctx.assetLookup || ((assetId) => assetService.getById(db, assetId));
  let sourceAsset;
  try {
    sourceAsset = await lookup(parsed.sourceAssetId);
  } catch (error) {
    assertCurrent();
    throw error;
  }
  assertCurrent();
  assertSourceAsset(sourceAsset, parsed);
  const sourceFile = resolveSourcePath(fsApi, storageRoot, sourceAsset.local_path);
  const expectedSourceHashes = sourceHashBindings(work, sourceAsset);

  const taskId = safeGeneratedId((ctx.idFactory || crypto.randomUUID)());
  const wavId = safeGeneratedId((ctx.idFactory || crypto.randomUUID)());
  const tempDir = path.join(privateAudioRoot, `source-audio-${taskId}`);
  const sourceSnapshotPath = path.join(tempDir, `source-${taskId}.bin`);
  const wavPath = path.join(tempDir, `${wavId}.wav`);
  try {
    fsApi.mkdirSync(tempDir, { mode: 0o700 });
  } catch {
    throw codedError('SOURCE_AUDIO_PRIVATE_ROOT_INVALID');
  }

  try {
    assertContainedDirectory(fsApi, tempDir, privateAudioRoot, 'SOURCE_AUDIO_PRIVATE_ROOT_INVALID', true);
    const sourceSnapshot = snapshotSourceFile(fsApi, sourceFile, sourceSnapshotPath, tempDir);
    assertSourceHashBindings(expectedSourceHashes, sourceSnapshot.sha256, sourceSnapshot.size);
    const assertSourceCurrent = () => {
      assertCurrent();
      const latestWork = getOwnedWork(db, parsed);
      if (Number(latestWork.source_asset_id) !== parsed.sourceAssetId) {
        throw codedError('SOURCE_AUDIO_SOURCE_ASSET_MISMATCH');
      }
      const latestAsset = assetService.getById(db, parsed.sourceAssetId);
      assertSourceAsset(latestAsset, parsed);
      assertSourceHashBindings(sourceHashBindings(latestWork, latestAsset), sourceSnapshot.sha256, sourceSnapshot.size);
      if (latestAsset.local_path !== sourceAsset.local_path
        || !sameFileStat(sourceFile.stat, resolveSourcePath(fsApi, storageRoot, latestAsset.local_path).stat)) {
        throw codedError('SOURCE_AUDIO_SOURCE_SNAPSHOT_FAILED');
      }
    };
    createPrivateFile(fsApi, wavPath, tempDir);
    let workerEvidence = null;
    let windowEvidence = null;
    let silent = false;
    assertCurrent();
    try {
      await (ctx.execFile || execFileAsync)(ctx.ffmpegPath || getFfmpegPath(), [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-i', sourceSnapshot.path,
        '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le',
        wavPath,
      ], {
        shell: false,
        windowsHide: true,
        timeout: Number(ctx.ffmpegTimeoutMs || 180_000),
        maxBuffer: 1024 * 1024,
      });
    } catch (error) {
      assertCurrent();
      if (isNoAudioStream(error)) silent = true;
      else throw codedError('SOURCE_AUDIO_EXTRACTION_FAILED');
    }
    assertCurrent();

    if (!silent) {
      assertExtractedWav(fsApi, wavPath, privateAudioRoot);
      if (fsApi.statSync(wavPath).size >= MAX_WORKER_AUDIO_BYTES) {
        try {
          windowEvidence = await analyzeLongSourceAudio({ ctx, fsApi, wavPath, privateAudioRoot, tempDir, taskId, wavId, assertCurrent });
        } catch (error) {
          assertCurrent();
          if (error?.code === 'SOURCE_AUDIO_SEAM_REVIEW_REQUIRED') {
            assertSourceCurrent();
            error.diagnostic = {
              ...error.diagnostic,
              work_id: parsed.workId, tenant_id: parsed.tenantId, user_id: parsed.userId,
              source_asset_id: parsed.sourceAssetId, source_video_sha256: sourceSnapshot.sha256,
              source_audio_task_id: taskId,
            };
            seamCandidates.set(error, { diagnostic: structuredClone(error.diagnostic), assertSourceCurrent });
          }
          throw error;
        }
        assertCurrent();
      } else {
        const audioSha256 = await sha256File(fsApi, wavPath);
        assertCurrent();
        workerEvidence = await invokeWorkerOnce(ctx.workerClient, {
          requestId: taskId,
          audioPath: wavPath,
          audioSha256,
          privateAudioRoot,
        }, assertCurrent);
        assertCurrent();
        workerEvidence = normalizeWorkerEvidence(workerEvidence, audioSha256, taskId);
      }
    }

    const evidence = buildEvidence({
      parsed,
      sourceVideoSha256: sourceSnapshot.sha256,
      taskId,
      workerEvidence,
      now: resolveNow(ctx.now),
    });
    const persist = () => persistEvidence({
      assetService, ctx, db, evidence: { ...evidence, ...windowEvidence }, fsApi, storageRoot, taskId, assertCurrent,
    });
    if (windowEvidence || ctx.assertAnalysisTaskCurrent) {
      if (typeof db.transaction !== 'function') throw codedError('SOURCE_AUDIO_DB_REQUIRED');
      let writtenBeforeCommit = false;
      try {
        return db.transaction(() => {
          assertCurrent();
          if (windowEvidence) assertSourceCurrent();
          const result = persist();
          writtenBeforeCommit = true;
          return result;
        }).immediate();
      } catch (error) {
        if (writtenBeforeCommit) {
          const parentDir = path.join(storageRoot, 'redraw-source-audio-evidence');
          cleanupEvidenceOutput(fsApi, storageRoot, parentDir, path.join(parentDir, taskId));
        }
        if (error?.code === 'REDRAW_ANALYSIS_TASK_STALE'
          || String(error?.code || '').startsWith('SOURCE_AUDIO_')) throw error;
        throw codedError('SOURCE_AUDIO_PERSISTENCE_FAILED');
      }
    }
    return persist();
  } catch (error) {
    assertCurrent();
    throw error;
  } finally {
    cleanupPrivateTaskDirectory(fsApi, privateAudioRoot, tempDir);
  }
}

// This only authenticates the current in-process error handoff. Persisted JSON
// needs its own schema, hash, owner/task and source-CAS checks before future review.
function readSourceAudioSeamCandidate(error, binding = {}) {
  const trusted = seamCandidates.get(error);
  if (!trusted || error.code !== 'SOURCE_AUDIO_SEAM_REVIEW_REQUIRED'
    || !isDeepStrictEqual(error.diagnostic, trusted.diagnostic)) return null;
  const candidate = trusted.diagnostic;
  if (candidate.work_id !== binding.workId || candidate.source_asset_id !== binding.sourceAssetId
    || candidate.tenant_id !== binding.tenantId || candidate.user_id !== binding.userId) return null;
  trusted.assertSourceCurrent();
  return structuredClone(candidate);
}

function sourceAudioWindowPlan(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs <= 0
    || !Number.isSafeInteger(durationMs * 16) || durationMs * 32 + 36 > 0xffffffff) {
    throw codedError('SOURCE_AUDIO_EVIDENCE_INVALID');
  }
  const windows = [];
  for (let start = 0; start < durationMs; start += AUDIO_COMMIT_MS) {
    const end = Math.min(start + AUDIO_COMMIT_MS, durationMs);
    const index = windows.length;
    windows.push({
      window_id: `aw${String(index + 1).padStart(6, '0')}`,
      index,
      analysis_range_ms: { start_ms: Math.max(0, start - AUDIO_OVERLAP_MS), end_ms: Math.min(durationMs, end + AUDIO_OVERLAP_MS) },
      commit_range_ms: { start_ms: start, end_ms: end },
    });
  }
  return windows;
}

function inspectLongPcmWav(fsApi, file) {
  let descriptor;
  try {
    descriptor = fsApi.openSync(file, 'r');
    const stat = fsApi.fstatSync(descriptor);
    const read = (position, length) => {
      const buffer = Buffer.alloc(length);
      if (fsApi.readSync(descriptor, buffer, 0, length, position) !== length) throw Error('incomplete header');
      return buffer;
    };
    if (!stat.isFile() || stat.size < 44 || stat.size > 0xffffffff + 8) throw Error('invalid size');
    const header = read(0, 12);
    if (header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE'
      || header.readUInt32LE(4) + 8 !== stat.size) throw Error('invalid RIFF');
    let format = false, data = null, offset = 12;
    while (offset + 8 <= stat.size) {
      const chunk = read(offset, 8), length = chunk.readUInt32LE(4);
      if (offset + 8 + length > stat.size) throw Error('invalid chunk');
      const kind = chunk.toString('ascii', 0, 4);
      if (kind === 'fmt ') {
        if (format || length < 16) throw Error('invalid format');
        const value = read(offset + 8, 16);
        if (value.readUInt16LE(0) !== 1 || value.readUInt16LE(2) !== 1
          || value.readUInt32LE(4) !== 16000 || value.readUInt32LE(8) !== 32000
          || value.readUInt16LE(12) !== 2 || value.readUInt16LE(14) !== 16) throw Error('invalid PCM');
        format = true;
      }
      if (kind === 'data') {
        if (data || length <= 0 || length % 2) throw Error('invalid samples');
        data = { offset: offset + 8, length };
      }
      offset += 8 + length + (length % 2);
    }
    if (!format || !data || offset !== stat.size
      || !sameFileStat(stat, fsApi.fstatSync(descriptor))) throw Error('invalid WAV');
    return { ...data, durationMs: data.length / 32, stat };
  } catch {
    throw codedError('SOURCE_AUDIO_EVIDENCE_INVALID');
  } finally {
    closeQuietly(fsApi, descriptor);
  }
}

function copyPcmWindow(fsApi, sourcePath, sourcePcm, targetPath, range) {
  let sourceDescriptor, targetDescriptor;
  try {
    const length = (range.end_ms - range.start_ms) * 32;
    const start = sourcePcm.offset + range.start_ms * 32;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || length <= 0
      || length % 2 || length + 44 >= MAX_WORKER_AUDIO_BYTES
      || start < sourcePcm.offset || start + length > sourcePcm.offset + sourcePcm.length) throw Error('invalid window');
    sourceDescriptor = fsApi.openSync(sourcePath, 'r');
    if (!sameFileStat(sourcePcm.stat, fsApi.fstatSync(sourceDescriptor))) throw Error('changed source');
    targetDescriptor = fsApi.openSync(targetPath, 'r+');
    const header = Buffer.alloc(44);
    header.write('RIFF', 0); header.writeUInt32LE(length + 36, 4); header.write('WAVEfmt ', 8);
    header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
    header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28);
    header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
    header.write('data', 36); header.writeUInt32LE(length, 40);
    writeAll(fsApi, targetDescriptor, header, header.length);
    const buffer = Buffer.alloc(64 * 1024);
    for (let offset = 0; offset < length;) {
      const wanted = Math.min(buffer.length, length - offset);
      const count = fsApi.readSync(sourceDescriptor, buffer, 0, wanted, start + offset);
      if (count !== wanted) throw Error('incomplete samples');
      writeAll(fsApi, targetDescriptor, buffer, count);
      offset += count;
    }
    if (typeof fsApi.fsyncSync === 'function') fsApi.fsyncSync(targetDescriptor);
    if (fsApi.fstatSync(targetDescriptor).size !== length + 44
      || !sameFileStat(sourcePcm.stat, fsApi.fstatSync(sourceDescriptor))) throw Error('changed WAV');
  } catch {
    throw codedError('SOURCE_AUDIO_EVIDENCE_INVALID');
  } finally {
    closeQuietly(fsApi, sourceDescriptor); closeQuietly(fsApi, targetDescriptor);
  }
}

async function analyzeLongSourceAudio({ ctx, fsApi, wavPath, privateAudioRoot, tempDir, taskId, wavId, assertCurrent }) {
  const pcm = inspectLongPcmWav(fsApi, wavPath);
  const audioSha256 = await sha256File(fsApi, wavPath);
  assertCurrent();
  const windows = [];
  for (const plan of sourceAudioWindowPlan(pcm.durationMs)) {
    assertCurrent();
    const audioPath = path.join(tempDir, `${wavId}-${plan.window_id}.wav`);
    createPrivateFile(fsApi, audioPath, tempDir);
    copyPcmWindow(fsApi, wavPath, pcm, audioPath, plan.analysis_range_ms);
    const actual = inspectLongPcmWav(fsApi, audioPath);
    if (actual.stat.size >= MAX_WORKER_AUDIO_BYTES
      || actual.durationMs !== plan.analysis_range_ms.end_ms - plan.analysis_range_ms.start_ms) {
      throw codedError('SOURCE_AUDIO_EVIDENCE_INVALID');
    }
    const windowSha256 = await sha256File(fsApi, audioPath);
    assertCurrent();
    const requestId = `${taskId}-${plan.window_id}`;
    const workerEvidence = await invokeWorkerOnce(ctx.workerClient, {
      requestId, audioPath, audioSha256: windowSha256, privateAudioRoot, preserveSourceEvidence: true,
    }, assertCurrent);
    assertCurrent();
    const window = { ...plan, request_id: requestId, audio_sha256: windowSha256, workerEvidence };
    validatedSourceAudioWindow(window);
    if (!sameFileStat(actual.stat, fsApi.statSync(audioPath))
      || await sha256File(fsApi, audioPath) !== windowSha256) throw codedError('SOURCE_AUDIO_EVIDENCE_INVALID');
    assertCurrent();
    windows.push(window);
  }
  if (!sameFileStat(pcm.stat, fsApi.statSync(wavPath)) || await sha256File(fsApi, wavPath) !== audioSha256) {
    throw codedError('SOURCE_AUDIO_EVIDENCE_INVALID');
  }
  assertCurrent();
  return aggregateSourceAudioWindows({ audioDurationMs: pcm.durationMs, audioSha256, windows });
}

function validatedSourceAudioWindow(window) {
  const value = window.workerEvidence, raw = value?.rawSourceEvidence;
  const invalid = () => { throw codedError('SOURCE_AUDIO_EVIDENCE_INVALID'); };
  if (!value || !raw || typeof raw !== 'object' || Array.isArray(raw) || containsAbsolutePath(raw)
    || value.requestId !== window.request_id || value.audioSha256 !== window.audio_sha256
    || !isSha256(window.audio_sha256) || !isSha256(value.transcriptSha256)
    || raw.audio_sha256 !== value.audioSha256 || raw.transcript_sha256 !== value.transcriptSha256
    || raw.source_language !== value.sourceLanguage || raw.language_probability !== value.languageProbability
    || !Array.isArray(value.segments) || !Array.isArray(raw.segments)
    || raw.segments.length !== value.segments.length || raw.segments.length > 4096) invalid();
  const silent = Object.hasOwn(raw, 'no_speech_evidence');
  const rawKeys = ['audio_sha256', 'transcript_sha256', 'source_language', 'language_probability', 'segments',
    ...(silent ? ['no_speech_evidence'] : [])].sort();
  if (!sameKeys(raw, rawKeys)) invalid();
  const duration = window.analysis_range_ms.end_ms - window.analysis_range_ms.start_ms;
  if (silent) {
    const vad = raw.no_speech_evidence;
    if (!vad || typeof vad !== 'object' || Array.isArray(vad)
      || !sameKeys(vad, ['audio_duration_ms', 'method', 'speech_duration_ms'])
      || vad.method !== 'faster-whisper-vad'
      || !Number.isSafeInteger(vad.audio_duration_ms) || vad.audio_duration_ms <= 0
      || Math.abs(vad.audio_duration_ms - duration) > 0.5 || vad.speech_duration_ms !== 0
      || raw.source_language !== null || raw.language_probability !== null
      || raw.transcript_sha256 !== EMPTY_TRANSCRIPT_SHA256 || raw.segments.length
      || !value.noSpeechEvidence || !sameKeys(value.noSpeechEvidence, ['audio_duration_ms', 'method', 'speech_duration_ms'])
      || Object.keys(vad).some(key => value.noSpeechEvidence[key] !== vad[key])) invalid();
  } else if (Object.hasOwn(value, 'noSpeechEvidence') || !raw.segments.length
    || !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(String(raw.source_language || ''))
    || !isProbability(raw.language_probability)) invalid();
  let previousEnd = 0;
  const segments = raw.segments.map((segment, index) => {
    const normal = value.segments[index];
    if (!segment || !sameKeys(segment, ['end', 'speaker_cluster_id', 'start', 'text'])
      || !Number.isFinite(segment.start) || !Number.isFinite(segment.end)
      || segment.start < previousEnd || segment.end <= segment.start || segment.end * 1000 > duration
      || !validText(segment.text) || !/^speaker-cluster-[1-9][0-9]*$/.test(String(segment.speaker_cluster_id || ''))
      || !normal || normal.startMs !== Math.round(segment.start * 1000) || normal.endMs !== Math.round(segment.end * 1000)
      || normal.text !== segment.text.trim() || normal.speakerClusterId !== segment.speaker_cluster_id) invalid();
    previousEnd = segment.end;
    const relative = { start_ms: segment.start * 1000, end_ms: segment.end * 1000 };
    return {
      start_ms: window.analysis_range_ms.start_ms + relative.start_ms,
      end_ms: window.analysis_range_ms.start_ms + relative.end_ms,
      source_text: segment.text,
      binding: {
        window_id: window.window_id, worker_request_id: window.request_id, worker_segment_index: index,
        worker_relative_range_ms: relative,
        absolute_range_ms: {
          start_ms: window.analysis_range_ms.start_ms + relative.start_ms,
          end_ms: window.analysis_range_ms.start_ms + relative.end_ms,
        },
        window_audio_sha256: window.audio_sha256, window_transcript_sha256: raw.transcript_sha256,
        raw_worker_speaker_cluster_id: segment.speaker_cluster_id, worker_source_text: segment.text,
      },
      physical_index: window.index,
    };
  });
  return {
    evidence: {
      window_id: window.window_id, index: window.index,
      analysis_range_ms: { ...window.analysis_range_ms }, commit_range_ms: { ...window.commit_range_ms },
      request_id: window.request_id, audio_sha256: window.audio_sha256, transcript_sha256: raw.transcript_sha256,
      worker_status: 'completed', segment_count: raw.segments.length, raw_source_evidence: structuredClone(raw),
    },
    segments, silent,
  };
}

function aggregateSourceAudioWindows({ audioDurationMs, audioSha256, windows } = {}) {
  const plan = sourceAudioWindowPlan(audioDurationMs);
  const invalid = () => { throw codedError('SOURCE_AUDIO_EVIDENCE_INVALID'); };
  if (!isSha256(audioSha256) || !Array.isArray(windows) || windows.length !== plan.length) invalid();
  const requestIds = new Set();
  const completed = windows.map((window, index) => {
    const expected = plan[index];
    if (!window || window.window_id !== expected.window_id || window.index !== index
      || !validOwnerPart(window.request_id) || requestIds.has(window.request_id)) invalid();
    for (const key of ['analysis_range_ms', 'commit_range_ms']) {
      if (!window[key] || !sameKeys(window[key], ['end_ms', 'start_ms'])
        || window[key].start_ms !== expected[key].start_ms || window[key].end_ms !== expected[key].end_ms) invalid();
    }
    requestIds.add(window.request_id);
    return validatedSourceAudioWindow(window);
  });
  const diagnosticWindows = completed.map(window => window.evidence);
  const review = (reason) => {
    const error = codedError('SOURCE_AUDIO_SEAM_REVIEW_REQUIRED');
    error.diagnostic = {
      schema_version: SEAM_CANDIDATE_SCHEMA, status: 'needs_review', audio_duration_ms: audioDurationMs,
      audio_sha256: audioSha256, reason, windows: structuredClone(diagnosticWindows),
    };
    throw error;
  };
  const spoken = completed.filter(window => !window.silent);
  if (new Set(spoken.map(window => window.evidence.raw_source_evidence.source_language)).size > 1) review('language_conflict');
  const owner = segment => {
    const midpoint = (segment.start_ms + segment.end_ms) / 2;
    return plan.find(window => midpoint >= window.commit_range_ms.start_ms && midpoint < window.commit_range_ms.end_ms)?.window_id;
  };
  const all = completed.flatMap(window => window.segments);
  for (const segment of all) {
    segment.owner = owner(segment);
    if (!segment.owner || segment.start_ms < 0 || segment.end_ms > audioDurationMs) invalid();
  }
  const parents = new Map(all.map(segment => [segment, segment]));
  const representative = segment => {
    let current = segment;
    while (parents.get(current) !== current) current = parents.get(current);
    return current;
  };
  const overlaps = (left, right) => left.start_ms < right.end_ms && right.start_ms < left.end_ms;
  const seamChecks = [];
  for (let index = 0; index + 1 < completed.length; index += 1) {
    const intersection = { start_ms: plan[index + 1].analysis_range_ms.start_ms, end_ms: plan[index].analysis_range_ms.end_ms };
    const left = completed[index].segments.filter(segment => overlaps(segment, intersection));
    const right = completed[index + 1].segments.filter(segment => overlaps(segment, intersection));
    for (const [side, other] of [[left, right], [right, left]]) {
      for (const segment of side) {
        const candidates = other.filter(candidate => overlaps(segment, candidate));
        if (candidates.length !== 1 || candidates[0].source_text.trim() !== segment.source_text.trim()
          || candidates[0].owner !== segment.owner
          || side.filter(candidate => overlaps(candidate, candidates[0])).length !== 1) review('seam_conflict');
        parents.set(representative(candidates[0]), representative(segment));
      }
    }
    seamChecks.push({ seam_ms: plan[index].commit_range_ms.end_ms,
      left_window_id: plan[index].window_id, right_window_id: plan[index + 1].window_id, status: 'passed' });
  }
  const groups = new Map();
  for (const segment of all) {
    const key = representative(segment);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(segment);
  }
  if (groups.size > 4096) invalid();
  const segments = [...groups.values()].map(group => {
    group.sort((left, right) => left.physical_index - right.physical_index
      || left.binding.worker_segment_index - right.binding.worker_segment_index);
    const selected = group[0];
    if (group.some(segment => segment.owner !== selected.owner)) review('seam_conflict');
    return {
      id: `${selected.binding.window_id}-segment-${String(selected.binding.worker_segment_index + 1).padStart(6, '0')}`,
      evidence_ref: `${selected.binding.worker_request_id}#segment-${selected.binding.worker_segment_index}`,
      start_ms: selected.start_ms, end_ms: selected.end_ms, source_text: selected.source_text,
      speaker_cluster_id: `${selected.binding.window_id}-${selected.binding.raw_worker_speaker_cluster_id}`,
      speaker_cluster_scope: 'window', speaker_link_status: 'unknown', commit_window_id: selected.owner,
      selected_source_binding_index: 0,
      source_bindings: group.map((segment, index) => ({ ...segment.binding,
        role: index === 0 ? 'selected_source' : 'deduplicated_overlap' })),
    };
  }).sort((left, right) => left.start_ms - right.start_ms || left.end_ms - right.end_ms || left.id.localeCompare(right.id));
  for (let index = 1; index < segments.length; index += 1) {
    if (segments[index].start_ms < segments[index - 1].end_ms) review('segment_overlap');
  }
  return {
    schema_version: 'redraw-source-audio-evidence-v2', audio_sha256: audioSha256, audio_duration_ms: audioDurationMs,
    audio_format: { codec: 'pcm_s16le', sample_rate_hz: 16000, channels: 1, bit_depth: 16 },
    window_policy: { worker_max_audio_bytes: MAX_WORKER_AUDIO_BYTES, target_commit_ms: AUDIO_COMMIT_MS,
      overlap_ms: AUDIO_OVERLAP_MS, seam_rule: 'full_utterance_single_owner_or_reject' },
    coverage: { expected_duration_ms: audioDurationMs,
      committed_ranges: plan.map(window => ({ window_id: window.window_id, ...window.commit_range_ms })),
      gap_ms: 0, full_coverage: true, seam_checks: seamChecks },
    speaker_cluster_policy: { scope: 'window', cross_window_identity: 'unknown' },
    windows: diagnosticWindows, segments,
    transcript_sha256: sha256Text(JSON.stringify(segments.map(segment => ({
      end_ms: segment.end_ms, source_text: segment.source_text, start_ms: segment.start_ms,
    })))),
    dialogue_mode: spoken.length ? 'spoken' : 'silent',
    source_language: spoken.length ? spoken[0].evidence.raw_source_evidence.source_language : null,
    language_probability: spoken.length ? Math.min(...spoken.map(window => window.evidence.raw_source_evidence.language_probability)) : null,
  };
}

function resolveSourceAudioSeamDecision(candidate, input) {
  const invalid = (code = 'SOURCE_AUDIO_SEAM_DECISION_INVALID') => { throw codedError(code); };
  try { assertSourceAudioJson(candidate); assertSourceAudioJson(input); } catch { invalid(); }
  if (!candidate || Array.isArray(candidate)
    || !sameKeys(candidate, ['audio_duration_ms', 'audio_sha256', 'reason', 'schema_version', 'status', 'windows'])
    || candidate.schema_version !== SEAM_CANDIDATE_SCHEMA || candidate.status !== 'needs_review'
    || !['seam_conflict', 'segment_overlap', 'language_conflict'].includes(candidate.reason)
    || !Number.isSafeInteger(candidate.audio_duration_ms) || candidate.audio_duration_ms <= 0
    || !isSha256(candidate.audio_sha256) || !Array.isArray(candidate.windows)
    || !input || Array.isArray(input) || !sameKeys(input, ['candidate_sha256', 'decisions'])
    || !isSha256(input.candidate_sha256) || !Array.isArray(input.decisions)) invalid();
  if (candidate.reason === 'language_conflict') invalid('SOURCE_AUDIO_SEAM_LANGUAGE_CONFLICT');

  const plan = sourceAudioWindowPlan(candidate.audio_duration_ms);
  if (candidate.windows.length !== plan.length) invalid();
  let completed;
  try {
    completed = persistedSourceAudioWindows(candidate.windows).map((window, index) => {
      const expected = plan[index];
      if (window.window_id !== expected.window_id || window.index !== expected.index
        || !isDeepStrictEqual(window.analysis_range_ms, expected.analysis_range_ms)
        || !isDeepStrictEqual(window.commit_range_ms, expected.commit_range_ms)) invalid();
      return validatedSourceAudioWindow(window);
    });
  } catch (error) {
    if (error.code === 'SOURCE_AUDIO_SEAM_DECISION_INVALID') throw error;
    invalid();
  }
  const spoken = completed.filter(window => !window.silent);
  if (new Set(spoken.map(window => window.evidence.raw_source_evidence.source_language)).size > 1) {
    invalid('SOURCE_AUDIO_SEAM_LANGUAGE_CONFLICT');
  }
  const overlaps = (left, right) => left.start_ms < right.end_ms && right.start_ms < left.end_ms;
  const conflicts = [];
  for (let index = 0; index + 1 < completed.length; index += 1) {
    const intersection = { start_ms: plan[index + 1].analysis_range_ms.start_ms,
      end_ms: plan[index].analysis_range_ms.end_ms };
    const left = completed[index].segments.filter(segment => overlaps(segment, intersection));
    const right = completed[index + 1].segments.filter(segment => overlaps(segment, intersection));
    const clean = left.every(segment => {
      const matches = right.filter(value => overlaps(segment, value));
      return matches.length === 1 && matches[0].source_text.trim() === segment.source_text.trim()
        && left.filter(value => overlaps(value, matches[0])).length === 1;
    }) && right.every(segment => {
      const matches = left.filter(value => overlaps(segment, value));
      return matches.length === 1 && matches[0].source_text.trim() === segment.source_text.trim()
        && right.filter(value => overlaps(value, matches[0])).length === 1;
    });
    if (!clean) conflicts.push({ index, intersection, left, right });
  }
  if (!conflicts.length || input.decisions.length !== conflicts.length) invalid();
  const decisionBySeam = new Map();
  for (const decision of input.decisions) {
    if (!decision || Array.isArray(decision)
      || !sameKeys(decision, ['left_window_id', 'right_window_id', 'seam_ms', 'selected_window_id'])
      || !Number.isSafeInteger(decision.seam_ms) || decisionBySeam.has(decision.seam_ms)) invalid();
    const conflict = conflicts.find(value => plan[value.index].commit_range_ms.end_ms === decision.seam_ms);
    if (!conflict || decision.left_window_id !== plan[conflict.index].window_id
      || decision.right_window_id !== plan[conflict.index + 1].window_id
      || ![decision.left_window_id, decision.right_window_id].includes(decision.selected_window_id)) invalid();
    decisionBySeam.set(decision.seam_ms, structuredClone(decision));
  }

  const rejected = new Set();
  const rejectedSourceBindings = [];
  for (const conflict of conflicts) {
    const seam = plan[conflict.index].commit_range_ms.end_ms;
    const decision = decisionBySeam.get(seam);
    if (!decision) invalid();
    const rejectedSegments = decision.selected_window_id === decision.left_window_id ? conflict.right : conflict.left;
    for (const segment of rejectedSegments) {
      const key = `${segment.binding.window_id}:${segment.binding.worker_segment_index}`;
      rejected.add(key);
      rejectedSourceBindings.push({ window_id: segment.binding.window_id,
        worker_request_id: segment.binding.worker_request_id,
        worker_segment_index: segment.binding.worker_segment_index });
    }
  }
  const retained = completed.flatMap(window => window.segments).filter(segment => (
    !rejected.has(`${segment.binding.window_id}:${segment.binding.worker_segment_index}`)
  )).sort((left, right) => left.start_ms - right.start_ms || left.end_ms - right.end_ms);
  for (let index = 1; index < retained.length; index += 1) {
    if (retained[index].start_ms < retained[index - 1].end_ms) invalid();
  }
  const commitOwner = segment => {
    const midpoint = (segment.start_ms + segment.end_ms) / 2;
    return plan.find(window => midpoint >= window.commit_range_ms.start_ms
      && midpoint < window.commit_range_ms.end_ms)?.window_id;
  };
  if (retained.some(segment => !commitOwner(segment))) invalid();
  const segments = retained.map(segment => ({
    id: `${segment.binding.window_id}-segment-${String(segment.binding.worker_segment_index + 1).padStart(6, '0')}`,
    evidence_ref: `${segment.binding.worker_request_id}#segment-${segment.binding.worker_segment_index}`,
    start_ms: segment.start_ms, end_ms: segment.end_ms, source_text: segment.source_text,
    speaker_cluster_id: `${segment.binding.window_id}-${segment.binding.raw_worker_speaker_cluster_id}`,
    speaker_cluster_scope: 'window', speaker_link_status: 'unknown',
    commit_window_id: commitOwner(segment), selected_source_binding_index: 0,
    source_bindings: [{ ...segment.binding, role: 'selected_source' }],
  }));
  const decisions = input.decisions.map(value => structuredClone(value));
  return {
    schema_version: 'redraw-source-audio-evidence-v2', audio_sha256: candidate.audio_sha256,
    audio_duration_ms: candidate.audio_duration_ms,
    audio_format: { codec: 'pcm_s16le', sample_rate_hz: 16000, channels: 1, bit_depth: 16 },
    window_policy: { worker_max_audio_bytes: MAX_WORKER_AUDIO_BYTES, target_commit_ms: AUDIO_COMMIT_MS,
      overlap_ms: AUDIO_OVERLAP_MS, seam_rule: 'full_utterance_manual_source_selection' },
    coverage: { expected_duration_ms: candidate.audio_duration_ms,
      committed_ranges: plan.map(window => ({ window_id: window.window_id, ...window.commit_range_ms })),
      gap_ms: 0, full_coverage: true,
      seam_checks: plan.slice(0, -1).map((window, index) => ({ seam_ms: window.commit_range_ms.end_ms,
        left_window_id: window.window_id, right_window_id: plan[index + 1].window_id,
        status: decisionBySeam.has(window.commit_range_ms.end_ms) ? 'manual_resolved' : 'passed' })) },
    speaker_cluster_policy: { scope: 'window', cross_window_identity: 'unknown' },
    windows: structuredClone(candidate.windows), segments,
    transcript_sha256: sha256Text(JSON.stringify(segments.map(segment => ({ end_ms: segment.end_ms,
      source_text: segment.source_text, start_ms: segment.start_ms })))),
    dialogue_mode: spoken.length ? 'spoken' : 'silent',
    source_language: spoken.length ? spoken[0].evidence.raw_source_evidence.source_language : null,
    language_probability: spoken.length ? Math.min(...spoken.map(window => (
      window.evidence.raw_source_evidence.language_probability))) : null,
    manual_seam_review: { schema_version: 'redraw-source-audio-seam-decision-v1',
      candidate_sha256: input.candidate_sha256, candidate_reason: candidate.reason, decisions,
      rejected_source_bindings: rejectedSourceBindings },
  };
}

function assertSourceAudioJson(value, depth = 0) {
  if (depth > 64) throw codedError('SOURCE_AUDIO_EVIDENCE_INVALID');
  if (value === null || typeof value === 'string' || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))) return;
  if (!value || typeof value !== 'object'
    || Object.getPrototypeOf(value) !== (Array.isArray(value) ? Array.prototype : Object.prototype)) {
    throw codedError('SOURCE_AUDIO_EVIDENCE_INVALID');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors).filter(key => !(Array.isArray(value) && key === 'length'));
  if (Array.isArray(value) && (keys.length !== value.length
    || keys.some((key, index) => key !== String(index)))) throw codedError('SOURCE_AUDIO_EVIDENCE_INVALID');
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (typeof key !== 'string' || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw codedError('SOURCE_AUDIO_EVIDENCE_INVALID');
    }
    assertSourceAudioJson(descriptor.value, depth + 1);
  }
}

function persistedSourceAudioWindows(windows) {
  return windows.map(window => {
    const raw = window.raw_source_evidence;
    return { window_id: window.window_id, index: window.index,
      analysis_range_ms: window.analysis_range_ms, commit_range_ms: window.commit_range_ms,
      request_id: window.request_id, audio_sha256: window.audio_sha256,
      workerEvidence: { requestId: window.request_id, audioSha256: window.audio_sha256,
        transcriptSha256: window.transcript_sha256, sourceLanguage: raw.source_language,
        languageProbability: raw.language_probability,
        segments: raw.segments.map(segment => ({ startMs: Math.round(segment.start * 1000),
          endMs: Math.round(segment.end * 1000), text: segment.text.trim(),
          speakerClusterId: segment.speaker_cluster_id })),
        ...(Object.hasOwn(raw, 'no_speech_evidence') ? { noSpeechEvidence: raw.no_speech_evidence } : {}),
        rawSourceEvidence: raw } };
  });
}

function validatePersistedSourceAudioV2(evidence) {
  let validationStage = 'shape';
  try {
    assertSourceAudioJson(evidence);
    const hasEvidenceSha = Object.hasOwn(evidence, 'evidence_sha256');
    const hasResultAsset = Object.hasOwn(evidence, 'result_asset_id');
    if (hasEvidenceSha !== hasResultAsset || (hasEvidenceSha
      && (!isSha256(evidence.evidence_sha256) || !isPositiveInteger(evidence.result_asset_id)))) {
      throw codedError('SOURCE_AUDIO_EVIDENCE_INVALID');
    }
    const { evidence_sha256: evidenceSha256, result_asset_id: resultAssetId, ...core } = evidence;
    if (core.schema_version !== 'redraw-source-audio-evidence-v2'
      || !Number.isSafeInteger(core.work_id) || core.work_id <= 0
      || !Number.isSafeInteger(core.source_asset_id) || core.source_asset_id <= 0
      || !validOwnerPart(core.task_id) || !validOwnerPart(core.tenant_id) || !validOwnerPart(core.user_id)
      || !isSha256(core.source_video_sha256) || typeof core.created_at !== 'string'
      || !Number.isFinite(Date.parse(core.created_at)) || !Array.isArray(core.windows)) {
      throw codedError('SOURCE_AUDIO_EVIDENCE_INVALID');
    }
    validationStage = 'derive';
    const derived = core.manual_seam_review
      ? resolveSourceAudioSeamDecision({ schema_version: SEAM_CANDIDATE_SCHEMA, status: 'needs_review',
        audio_duration_ms: core.audio_duration_ms, audio_sha256: core.audio_sha256,
        reason: core.manual_seam_review.candidate_reason, windows: core.windows }, {
        candidate_sha256: core.manual_seam_review.candidate_sha256,
        decisions: core.manual_seam_review.decisions,
      })
      : aggregateSourceAudioWindows({ audioDurationMs: core.audio_duration_ms,
        audioSha256: core.audio_sha256, windows: persistedSourceAudioWindows(core.windows) });
    validationStage = 'compare';
    const expectedCore = { ...derived, task_id: core.task_id, work_id: core.work_id,
      tenant_id: core.tenant_id, user_id: core.user_id, source_asset_id: core.source_asset_id,
      source_video_sha256: core.source_video_sha256, created_at: core.created_at };
    const expected = hasEvidenceSha ? { ...expectedCore, evidence_sha256: evidenceSha256,
      result_asset_id: Number(resultAssetId) } : expectedCore;
    const actualCanonical = stableStringify(evidence);
    const expectedCanonical = stableStringify(expected);
    if (actualCanonical !== expectedCanonical) {
      throw codedError('SOURCE_AUDIO_EVIDENCE_INVALID');
    }
    return expected;
  } catch (cause) {
    const error = codedError('SOURCE_AUDIO_EVIDENCE_INVALID');
    error.validation_stage = validationStage;
    error.validation_cause = cause?.code || cause?.message || 'unknown';
    throw error;
  }
}

function validatePersistedSourceAudioSeamCandidate(candidate) {
  try {
    assertSourceAudioJson(candidate);
    if (candidate.schema_version !== SEAM_CANDIDATE_SCHEMA || candidate.status !== 'needs_review'
      || !Number.isSafeInteger(candidate.work_id) || candidate.work_id <= 0
      || !Number.isSafeInteger(candidate.source_asset_id) || candidate.source_asset_id <= 0
      || !validOwnerPart(candidate.tenant_id) || !validOwnerPart(candidate.user_id)
      || !validOwnerPart(candidate.source_audio_task_id) || !validOwnerPart(candidate.analysis_task_id)
      || candidate.source_audio_task_id === candidate.analysis_task_id
      || !isSha256(candidate.source_video_sha256) || !isSha256(candidate.candidate_sha256)
      || !Array.isArray(candidate.windows)) throw codedError('SOURCE_AUDIO_EVIDENCE_INVALID');
    let diagnostic;
    try {
      aggregateSourceAudioWindows({ audioDurationMs: candidate.audio_duration_ms, audioSha256: candidate.audio_sha256,
        windows: persistedSourceAudioWindows(candidate.windows) });
    } catch (error) {
      if (error.code !== 'SOURCE_AUDIO_SEAM_REVIEW_REQUIRED') throw error;
      diagnostic = error.diagnostic;
    }
    if (!diagnostic) throw codedError('SOURCE_AUDIO_EVIDENCE_INVALID');
    const expected = { ...diagnostic, work_id: candidate.work_id, tenant_id: candidate.tenant_id,
      user_id: candidate.user_id, source_asset_id: candidate.source_asset_id,
      source_video_sha256: candidate.source_video_sha256, source_audio_task_id: candidate.source_audio_task_id,
      analysis_task_id: candidate.analysis_task_id };
    expected.candidate_sha256 = sha256Text(stableStringify(expected));
    if (!isDeepStrictEqual(candidate, expected)) throw codedError('SOURCE_AUDIO_EVIDENCE_INVALID');
    return expected;
  } catch {
    throw codedError('SOURCE_AUDIO_EVIDENCE_INVALID');
  }
}

function sourceAudioSeamReviewSnapshot(db, input, missingCode) {
  const work = db.prepare(`SELECT * FROM redraw_works
    WHERE id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL`)
    .get(input.workId, input.tenantId, input.userId);
  if (!work) throw codedError(missingCode);
  const task = work.task_id ? db.prepare(`SELECT * FROM async_tasks
    WHERE id = ? AND type = 'redraw_analysis' AND resource_id = ?
      AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL`)
    .get(work.task_id, String(work.id), input.tenantId, input.userId) : null;
  const asset = work.source_asset_id ? db.prepare('SELECT * FROM assets WHERE id = ?').get(work.source_asset_id) : null;
  const reservation = work.credit_reservation_id
    ? db.prepare(`SELECT * FROM tenant_usage_reservations WHERE id = ?
      AND tenant_id = ? AND actor_user_id = ? AND resource_type = 'redraw_analysis' AND resource_id = ?`)
      .get(work.credit_reservation_id, input.tenantId, input.userId, String(work.id)) : null;
  return { work, task, asset, reservation };
}

function validateSourceAudioSeamReviewSnapshot(snapshot, input) {
  const { work, task, asset, reservation } = snapshot;
  if (work.status !== 'needs_attention' || !task || task.deleted_at != null
    || task.type !== 'redraw_analysis' || task.status !== 'needs_attention'
    || task.id !== work.task_id || task.resource_id !== String(work.id)
    || task.tenant_id !== input.tenantId || task.user_id !== input.userId
    || task.completed_at || task.provider_task_id
    || task.credit_reservation_id !== work.credit_reservation_id) throw codedError('SOURCE_AUDIO_SEAM_REVIEW_STALE');
  if (work.credit_reservation_id != null && (!validOwnerPart(work.credit_reservation_id) || !reservation
    || reservation.tenant_id !== input.tenantId || reservation.actor_user_id !== input.userId
    || reservation.resource_type !== 'redraw_analysis' || reservation.resource_id !== String(work.id)
    || reservation.model !== task.model || reservation.status !== 'held')) throw codedError('SOURCE_AUDIO_SEAM_REVIEW_STALE');
  const result = JSON.parse(task.result);
  if (!result || Array.isArray(result) || !sameKeys(result, ['source_audio_seam_review', 'status'])
    || result.status !== 'needs_review') throw codedError('SOURCE_AUDIO_SEAM_REVIEW_STALE');
  const candidate = validatePersistedSourceAudioSeamCandidate(result.source_audio_seam_review);
  if (candidate.work_id !== Number(work.id) || candidate.analysis_task_id !== task.id
    || candidate.tenant_id !== input.tenantId || candidate.user_id !== input.userId
    || candidate.source_asset_id !== Number(work.source_asset_id)
    || !asset || asset.deleted_at != null) throw codedError('SOURCE_AUDIO_SEAM_REVIEW_STALE');
  assertSourceAsset(asset, { ...input, sourceAssetId: candidate.source_asset_id });
  return candidate;
}

function validateSourceAudioSeamResumeSnapshot(snapshot, input) {
  const { work, task, asset, reservation } = snapshot;
  if (work.status !== 'needs_attention' || !task || task.deleted_at != null
    || task.type !== 'redraw_analysis' || task.status !== 'needs_attention'
    || task.id !== work.task_id || task.resource_id !== String(work.id)
    || task.tenant_id !== input.tenantId || task.user_id !== input.userId
    || task.completed_at || task.provider_task_id || task.credit_reservation_id !== work.credit_reservation_id
    || (work.credit_reservation_id != null && (!reservation || reservation.status !== 'held'))) {
    throw codedError('SOURCE_AUDIO_SEAM_REVIEW_STALE');
  }
  const result = JSON.parse(task.result);
  if (!result || Array.isArray(result) || !sameKeys(result, ['source_audio_evidence', 'status'])
    || result.status !== 'resume_pending') throw codedError('SOURCE_AUDIO_SEAM_REVIEW_STALE');
  const evidence = validatePersistedSourceAudioV2(result.source_audio_evidence);
  if (evidence.work_id !== Number(work.id) || evidence.tenant_id !== input.tenantId
    || evidence.user_id !== input.userId || evidence.source_asset_id !== Number(work.source_asset_id)
    || !asset || asset.deleted_at != null) throw codedError('SOURCE_AUDIO_SEAM_REVIEW_STALE');
  assertSourceAsset(asset, { ...input, sourceAssetId: evidence.source_asset_id });
  return evidence;
}

async function getSourceAudioSeamReview(ctx = {}, input = {}) {
  try {
    assertSourceAudioJson(input);
    if (!input || Array.isArray(input) || !sameKeys(input, ['workId'])
      || !(typeof input.workId === 'number' || (typeof input.workId === 'string' && /^[1-9][0-9]*$/.test(input.workId)))
      || !isPositiveInteger(input.workId) || !ctx?.db || typeof ctx.db.prepare !== 'function'
      || !validOwnerPart(ctx.tenantId) || !validOwnerPart(ctx.userId)
      || typeof ctx.storageRoot !== 'string' || !path.isAbsolute(ctx.storageRoot)) {
      throw codedError('SOURCE_AUDIO_SEAM_REVIEW_INPUT_INVALID');
    }
  } catch {
    throw codedError('SOURCE_AUDIO_SEAM_REVIEW_INPUT_INVALID');
  }
  const db = ctx.db, fsApi = ctx.fs || fs;
  const parsed = { workId: Number(input.workId), tenantId: ctx.tenantId, userId: ctx.userId };
  // Database failures remain internal errors; only invalid persisted content and
  // source-file failures become the non-disclosing stale business error.
  const snapshot = sourceAudioSeamReviewSnapshot(db, parsed, 'SOURCE_AUDIO_SEAM_REVIEW_NOT_FOUND');
  let candidate, resumeEvidence, sourceFile, bindings;
  try {
    let taskResult;
    try { taskResult = JSON.parse(snapshot.task?.result || 'null'); } catch { taskResult = null; }
    if (taskResult?.status === 'resume_pending') resumeEvidence = validateSourceAudioSeamResumeSnapshot(snapshot, parsed);
    else candidate = validateSourceAudioSeamReviewSnapshot(snapshot, parsed);
    bindings = sourceHashBindings(snapshot.work, snapshot.asset);
    const storageRoot = resolveDirectoryRoot(fsApi, ctx.storageRoot, 'SOURCE_AUDIO_STORAGE_ROOT_INVALID');
    sourceFile = resolveSourcePath(fsApi, storageRoot, snapshot.asset.local_path);
  } catch {
    throw codedError('SOURCE_AUDIO_SEAM_REVIEW_STALE');
  }
  let descriptor;
  try {
    try {
      descriptor = fsApi.openSync(sourceFile.path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const openedStat = fsApi.fstatSync(descriptor);
      assertOpenedSource(fsApi, sourceFile, descriptor, openedStat);
      const hash = crypto.createHash('sha256');
      for await (const chunk of fsApi.createReadStream(sourceFile.path, { fd: descriptor, autoClose: false })) hash.update(chunk);
      assertOpenedSource(fsApi, sourceFile, descriptor, openedStat);
      const sourceSha256 = hash.digest('hex');
      if (sourceSha256 !== (candidate || resumeEvidence).source_video_sha256) throw codedError('SOURCE_AUDIO_SEAM_REVIEW_STALE');
      assertSourceHashBindings(bindings, sourceSha256, openedStat.size);
    } catch {
      throw codedError('SOURCE_AUDIO_SEAM_REVIEW_STALE');
    }
    const current = sourceAudioSeamReviewSnapshot(db, parsed, 'SOURCE_AUDIO_SEAM_REVIEW_STALE');
    if (!isDeepStrictEqual(snapshot, current)) throw codedError('SOURCE_AUDIO_SEAM_REVIEW_STALE');
    if (resumeEvidence) return { schema_version: 'redraw-source-audio-seam-review-v1', status: 'resume_pending',
      work_id: resumeEvidence.work_id, analysis_task_id: snapshot.task.id, source_asset_id: resumeEvidence.source_asset_id,
      source_fingerprint: resumeEvidence.source_video_sha256, expected_work_updated_at: snapshot.work.updated_at,
      expected_task_updated_at: snapshot.task.updated_at,
      candidate_sha256: resumeEvidence.manual_seam_review.candidate_sha256,
      reason: resumeEvidence.manual_seam_review.candidate_reason,
      decisions: resumeEvidence.manual_seam_review.decisions };
    return { schema_version: 'redraw-source-audio-seam-review-v1', status: 'needs_review',
      work_id: candidate.work_id, analysis_task_id: candidate.analysis_task_id, source_asset_id: candidate.source_asset_id,
      source_fingerprint: candidate.source_video_sha256, expected_work_updated_at: snapshot.work.updated_at,
      expected_task_updated_at: snapshot.task.updated_at, candidate_sha256: candidate.candidate_sha256,
      reason: candidate.reason, audio_duration_ms: candidate.audio_duration_ms, audio_sha256: candidate.audio_sha256,
      windows: candidate.windows };
  } finally {
    closeQuietly(fsApi, descriptor);
  }
}

async function recordSourceAudioSeamDecision(ctx = {}, input = {}) {
  const invalid = (code = 'SOURCE_AUDIO_SEAM_DECISION_INPUT_INVALID') => { throw codedError(code); };
  try { assertSourceAudioJson(input); } catch { invalid(); }
  if (!input || Array.isArray(input)
    || !sameKeys(input, ['analysisTaskId', 'candidateSha256', 'decisions', 'expectedTaskUpdatedAt',
      'expectedWorkUpdatedAt', 'workId'])
    || !isPositiveInteger(input.workId) || !validOwnerPart(input.analysisTaskId)
    || !isSha256(input.candidateSha256) || !Array.isArray(input.decisions)
    || typeof input.expectedWorkUpdatedAt !== 'string' || !Number.isFinite(Date.parse(input.expectedWorkUpdatedAt))
    || typeof input.expectedTaskUpdatedAt !== 'string' || !Number.isFinite(Date.parse(input.expectedTaskUpdatedAt))
    || !ctx?.db || typeof ctx.db.prepare !== 'function' || typeof ctx.db.transaction !== 'function'
    || !validOwnerPart(ctx.tenantId) || !validOwnerPart(ctx.userId)
    || typeof ctx.storageRoot !== 'string' || !path.isAbsolute(ctx.storageRoot)) invalid();

  const db = ctx.db;
  const parsed = { workId: Number(input.workId), tenantId: ctx.tenantId, userId: ctx.userId };
  const existing = sourceAudioSeamReviewSnapshot(db, parsed, 'SOURCE_AUDIO_SEAM_DECISION_STALE');
  let existingResult;
  try { existingResult = JSON.parse(existing.task?.result || 'null'); } catch { existingResult = null; }
  if (existingResult?.status === 'resume_pending') {
    const evidence = existingResult.source_audio_evidence;
    const review = evidence?.manual_seam_review;
    if (!evidence || !review || existing.work.status !== 'needs_attention'
      || existing.task.status !== 'needs_attention' || existing.task.completed_at || existing.task.provider_task_id
      || existing.work.task_id !== input.analysisTaskId || existing.task.id !== input.analysisTaskId
      || existing.task.credit_reservation_id !== existing.work.credit_reservation_id
      || evidence.work_id !== Number(input.workId) || evidence.tenant_id !== ctx.tenantId
      || evidence.user_id !== ctx.userId || review.candidate_sha256 !== input.candidateSha256
      || !isDeepStrictEqual(review.decisions, input.decisions)
      || (existing.work.credit_reservation_id != null && (!existing.reservation
        || existing.reservation.status !== 'held'))) invalid('SOURCE_AUDIO_SEAM_DECISION_STALE');
    const fsApi = ctx.fs || fs;
    let descriptor;
    try {
      assertSourceAsset(existing.asset, { ...parsed, sourceAssetId: Number(evidence.source_asset_id) });
      const bindings = sourceHashBindings(existing.work, existing.asset);
      const root = resolveDirectoryRoot(fsApi, ctx.storageRoot, 'SOURCE_AUDIO_STORAGE_ROOT_INVALID');
      const sourceFile = resolveSourcePath(fsApi, root, existing.asset.local_path);
      descriptor = fsApi.openSync(sourceFile.path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const openedStat = fsApi.fstatSync(descriptor);
      assertOpenedSource(fsApi, sourceFile, descriptor, openedStat);
      const hash = crypto.createHash('sha256');
      for await (const chunk of fsApi.createReadStream(sourceFile.path, { fd: descriptor, autoClose: false })) hash.update(chunk);
      assertOpenedSource(fsApi, sourceFile, descriptor, openedStat);
      const sourceSha256 = hash.digest('hex');
      if (sourceSha256 !== evidence.source_video_sha256) invalid('SOURCE_AUDIO_SEAM_DECISION_STALE');
      assertSourceHashBindings(bindings, sourceSha256, openedStat.size);
      const current = sourceAudioSeamReviewSnapshot(db, parsed, 'SOURCE_AUDIO_SEAM_DECISION_STALE');
      if (!isDeepStrictEqual(existing, current)) invalid('SOURCE_AUDIO_SEAM_DECISION_STALE');
    } catch (error) {
      if (error.code === 'SOURCE_AUDIO_SEAM_DECISION_STALE') throw error;
      invalid('SOURCE_AUDIO_SEAM_DECISION_STALE');
    } finally {
      closeQuietly(fsApi, descriptor);
    }
    return { schema_version: 'redraw-source-audio-seam-resume-v1', status: 'resume_pending',
      work_id: Number(existing.work.id), analysis_task_id: existing.task.id,
      candidate_sha256: review.candidate_sha256, expected_work_updated_at: existing.work.updated_at,
      expected_task_updated_at: existing.task.updated_at };
  }

  const read = await getSourceAudioSeamReview(ctx, { workId: Number(input.workId) });
  if (read.analysis_task_id !== input.analysisTaskId || read.candidate_sha256 !== input.candidateSha256
    || read.expected_work_updated_at !== input.expectedWorkUpdatedAt
    || read.expected_task_updated_at !== input.expectedTaskUpdatedAt) invalid('SOURCE_AUDIO_SEAM_DECISION_STALE');
  const now = resolveNow(ctx.now);
  const fsApi = ctx.fs || fs;
  const evidenceParentDir = path.join(ctx.storageRoot, 'redraw-source-audio-evidence');
  let evidenceOutputDir;
  let evidenceWritten = false;
  try {
    return db.transaction(() => {
      const snapshot = sourceAudioSeamReviewSnapshot(db, parsed, 'SOURCE_AUDIO_SEAM_DECISION_STALE');
      const candidate = validateSourceAudioSeamReviewSnapshot(snapshot, parsed);
      if (candidate.analysis_task_id !== input.analysisTaskId
        || candidate.candidate_sha256 !== input.candidateSha256
        || snapshot.work.updated_at !== input.expectedWorkUpdatedAt
        || snapshot.task.updated_at !== input.expectedTaskUpdatedAt) invalid('SOURCE_AUDIO_SEAM_DECISION_STALE');
      const diagnostic = { schema_version: candidate.schema_version, status: candidate.status,
        audio_duration_ms: candidate.audio_duration_ms, audio_sha256: candidate.audio_sha256,
        reason: candidate.reason, windows: candidate.windows };
      const resolved = resolveSourceAudioSeamDecision(diagnostic, {
        candidate_sha256: candidate.candidate_sha256, decisions: input.decisions,
      });
      const evidence = { ...resolved, task_id: candidate.source_audio_task_id,
        work_id: candidate.work_id, tenant_id: candidate.tenant_id, user_id: candidate.user_id,
        source_asset_id: candidate.source_asset_id, source_video_sha256: candidate.source_video_sha256,
        created_at: now };
      evidenceOutputDir = path.join(evidenceParentDir, candidate.source_audio_task_id);
      const persistedEvidence = persistEvidence({
        assetService: ctx.assetService || realAssetService, ctx, db, evidence, fsApi,
        storageRoot: ctx.storageRoot, taskId: candidate.source_audio_task_id,
        assertCurrent: () => {
          const current = sourceAudioSeamReviewSnapshot(db, parsed, 'SOURCE_AUDIO_SEAM_DECISION_STALE');
          if (!isDeepStrictEqual(snapshot, current)) invalid('SOURCE_AUDIO_SEAM_DECISION_STALE');
        },
      });
      evidenceWritten = true;
      const taskUpdate = db.prepare(`UPDATE async_tasks
        SET result = ?, message = ?, updated_at = ?
        WHERE id = ? AND tenant_id = ? AND user_id = ? AND type = 'redraw_analysis'
          AND status = 'needs_attention' AND completed_at IS NULL AND provider_task_id IS NULL
          AND updated_at = ? AND credit_reservation_id IS ? AND deleted_at IS NULL`)
        .run(JSON.stringify({ status: 'resume_pending', source_audio_evidence: persistedEvidence }),
          '源音频接缝已人工确认，等待继续原分析任务', now, snapshot.task.id,
          ctx.tenantId, ctx.userId, input.expectedTaskUpdatedAt, snapshot.task.credit_reservation_id);
      const workUpdate = db.prepare(`UPDATE redraw_works
        SET error_msg = NULL, updated_at = ?
        WHERE id = ? AND tenant_id = ? AND user_id = ? AND status = 'needs_attention'
          AND task_id = ? AND updated_at = ? AND credit_reservation_id IS ? AND deleted_at IS NULL`)
        .run(now, snapshot.work.id, ctx.tenantId, ctx.userId, snapshot.task.id,
          input.expectedWorkUpdatedAt, snapshot.work.credit_reservation_id);
      if (taskUpdate.changes !== 1 || workUpdate.changes !== 1) invalid('SOURCE_AUDIO_SEAM_DECISION_STALE');
      return { schema_version: 'redraw-source-audio-seam-resume-v1', status: 'resume_pending',
        work_id: Number(snapshot.work.id), analysis_task_id: snapshot.task.id,
        candidate_sha256: candidate.candidate_sha256, expected_work_updated_at: now,
        expected_task_updated_at: now };
    }).immediate();
  } catch (error) {
    if (evidenceWritten && evidenceOutputDir) {
      cleanupEvidenceOutput(fsApi, ctx.storageRoot, evidenceParentDir, evidenceOutputDir);
    }
    if (String(error?.code || '').startsWith('SOURCE_AUDIO_SEAM_')) throw error;
    throw codedError('SOURCE_AUDIO_SEAM_DECISION_PERSISTENCE_FAILED');
  }
}

// Only server code loading verified assets can mint this non-serializable capability.
// Its private snapshot cannot be replaced by mutating the public Map or its entries.
function createVerifiedSourceAudioContext(entries) {
  const context = new Map(entries);
  const snapshot = new Map([...context].map(([ref, entry]) => [ref, structuredClone(entry)]));
  const freeze = value => {
    if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  };
  for (const entry of snapshot.values()) {
    validatePersistedSourceAudioV2(entry.evidence);
    freeze(entry);
  }
  verifiedAudioContexts.set(context, snapshot);
  return context;
}

function readVerifiedSourceAudioContext(context, ref) {
  return verifiedAudioContexts.get(context)?.get(ref);
}

function parseInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || !sameKeys(input, INPUT_KEYS)
    || !isPositiveInteger(input.workId)
    || !isPositiveInteger(input.sourceAssetId)
    || !validOwnerPart(input.tenantId)
    || !validOwnerPart(input.userId)) {
    throw codedError('SOURCE_AUDIO_INPUT_INVALID');
  }
  return {
    workId: Number(input.workId),
    sourceAssetId: Number(input.sourceAssetId),
    tenantId: input.tenantId.trim(),
    userId: input.userId.trim(),
  };
}

function getOwnedWork(db, input) {
  const work = db.prepare(`
    SELECT id, tenant_id, user_id, source_asset_id, source_fingerprint
    FROM redraw_works
    WHERE id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
  `).get(input.workId, input.tenantId, input.userId);
  if (!work) throw codedError('SOURCE_AUDIO_WORK_NOT_FOUND');
  return work;
}

function assertSourceAsset(asset, input) {
  const metadata = parseMetadata(asset?.metadata);
  if (!asset
    || Number(asset.id) !== input.sourceAssetId
    || asset.type !== 'video'
    || asset.category !== 'redraw_source'
    || metadata.tenant_id !== input.tenantId
    || metadata.user_id !== input.userId) {
    throw codedError('SOURCE_AUDIO_SOURCE_ASSET_INVALID');
  }
}

function sourceHashBindings(work, sourceAsset) {
  const metadata = parseMetadata(sourceAsset.metadata);
  return {
    work: normalizeOptionalSha256(
      work.source_fingerprint,
      'SOURCE_AUDIO_SOURCE_FINGERPRINT_INVALID',
    ),
    asset: [
      sourceAsset.sha256,
      sourceAsset.source_fingerprint,
      metadata.sha256,
      metadata.source_fingerprint,
    ].map((value) => normalizeOptionalSha256(value, 'SOURCE_AUDIO_SOURCE_ASSET_HASH_INVALID'))
      .filter(Boolean),
    assetSize: normalizeOptionalFileSize(sourceAsset.file_size),
  };
}

function normalizeOptionalSha256(value, code) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (!/^[0-9a-f]{64}$/i.test(text)) throw codedError(code);
  return text.toLowerCase();
}

function normalizeOptionalFileSize(value) {
  if (value == null || value === '') return null;
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw codedError('SOURCE_AUDIO_SOURCE_ASSET_SIZE_INVALID');
  }
  return size;
}

function assertSourceHashBindings(bindings, snapshotSha256, snapshotSize) {
  if (bindings.work && bindings.work !== snapshotSha256) {
    throw codedError('SOURCE_AUDIO_SOURCE_FINGERPRINT_INVALID');
  }
  if (bindings.asset.some((value) => value !== snapshotSha256)) {
    throw codedError('SOURCE_AUDIO_SOURCE_ASSET_HASH_INVALID');
  }
  if (bindings.assetSize != null && bindings.assetSize !== snapshotSize) {
    throw codedError('SOURCE_AUDIO_SOURCE_ASSET_SIZE_INVALID');
  }
}

function resolveDirectoryRoot(fsApi, value, code) {
  try {
    if (typeof value !== 'string' || !value.trim() || !path.isAbsolute(value)) throw new Error(code);
    const resolved = path.resolve(value);
    return assertDirectoryAtPath(fsApi, resolved, code);
  } catch {
    throw codedError(code);
  }
}

function resolvePrivateRoot(fsApi, value) {
  const code = 'SOURCE_AUDIO_PRIVATE_ROOT_INVALID';
  try {
    if (typeof value !== 'string' || !value.trim() || !path.isAbsolute(value)) throw new Error(code);
    const resolved = path.resolve(value);
    fsApi.mkdirSync(resolved, { recursive: true, mode: 0o700 });
    const real = assertDirectoryAtPath(fsApi, resolved, code);
    assertPrivateOwnership(fsApi.statSync(real), code, 0o022);
    return real;
  } catch {
    throw codedError(code);
  }
}

function assertDirectoryAtPath(fsApi, value, code) {
  const resolved = path.resolve(value);
  const inputStat = fsApi.lstatSync(resolved);
  const real = fsApi.realpathSync.native(resolved);
  const stat = fsApi.statSync(real);
  if (inputStat.isSymbolicLink() || !stat.isDirectory() || !samePath(resolved, real)) {
    throw codedError(code);
  }
  return real;
}

function assertContainedDirectory(fsApi, value, parent, code, privateAccess) {
  const parentReal = assertDirectoryAtPath(fsApi, parent, code);
  const real = assertDirectoryAtPath(fsApi, value, code);
  if (!isStrictlyInside(parentReal, real)) throw codedError(code);
  if (privateAccess) assertPrivateOwnership(fsApi.statSync(real), code, 0o022);
  return real;
}

function assertContainedFile(fsApi, value, parent, code, privateAccess) {
  const parentReal = assertDirectoryAtPath(fsApi, parent, code);
  const resolved = path.resolve(value);
  const inputStat = fsApi.lstatSync(resolved);
  const real = fsApi.realpathSync.native(resolved);
  const stat = fsApi.statSync(real);
  if (inputStat.isSymbolicLink()
    || !stat.isFile()
    || !samePath(resolved, real)
    || !isStrictlyInside(parentReal, real)) {
    throw codedError(code);
  }
  if (privateAccess) assertPrivateOwnership(stat, code, 0o077);
  return real;
}

function assertPrivateOwnership(stat, code, forbiddenMode) {
  if (typeof process.getuid !== 'function') return;
  if (stat.uid !== process.getuid() || (stat.mode & forbiddenMode) !== 0) {
    throw codedError(code);
  }
}

function createPrivateFile(fsApi, filePath, privateTaskDir) {
  let descriptor;
  try {
    descriptor = fsApi.openSync(filePath, 'wx', 0o600);
  } catch {
    throw codedError('SOURCE_AUDIO_PRIVATE_ROOT_INVALID');
  } finally {
    if (descriptor !== undefined) fsApi.closeSync(descriptor);
  }
  assertContainedFile(fsApi, filePath, privateTaskDir, 'SOURCE_AUDIO_PRIVATE_ROOT_INVALID', true);
}

function snapshotSourceFile(fsApi, sourceFile, snapshotPath, privateTaskDir) {
  let sourceDescriptor;
  let snapshotDescriptor;
  let sourceBefore;
  let copiedBytes = 0;
  const hash = crypto.createHash('sha256');
  try {
    sourceDescriptor = fsApi.openSync(sourceFile.path, 'r');
    sourceBefore = fsApi.fstatSync(sourceDescriptor);
    assertOpenedSource(fsApi, sourceFile, sourceDescriptor, sourceBefore);
    snapshotDescriptor = fsApi.openSync(snapshotPath, 'wx', 0o600);
    const buffer = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      const readBytes = fsApi.readSync(sourceDescriptor, buffer, 0, buffer.length, null);
      if (readBytes === 0) break;
      hash.update(buffer.subarray(0, readBytes));
      writeAll(fsApi, snapshotDescriptor, buffer, readBytes);
      copiedBytes += readBytes;
    }
    if (typeof fsApi.fsyncSync === 'function') fsApi.fsyncSync(snapshotDescriptor);
    const sourceAfter = fsApi.fstatSync(sourceDescriptor);
    if (!sameFileStat(sourceBefore, sourceAfter) || copiedBytes !== sourceBefore.size) {
      throw new Error('source changed while copying');
    }
    assertOpenedSource(fsApi, sourceFile, sourceDescriptor, sourceAfter);
    fsApi.closeSync(snapshotDescriptor);
    snapshotDescriptor = undefined;
    fsApi.closeSync(sourceDescriptor);
    sourceDescriptor = undefined;
    const snapshotReal = assertContainedFile(
      fsApi,
      snapshotPath,
      privateTaskDir,
      'SOURCE_AUDIO_SOURCE_SNAPSHOT_FAILED',
      true,
    );
    if (fsApi.statSync(snapshotReal).size !== copiedBytes) {
      throw new Error('snapshot size changed');
    }
    return { path: snapshotReal, sha256: hash.digest('hex'), size: copiedBytes };
  } catch {
    throw codedError('SOURCE_AUDIO_SOURCE_SNAPSHOT_FAILED');
  } finally {
    closeQuietly(fsApi, snapshotDescriptor);
    closeQuietly(fsApi, sourceDescriptor);
  }
}

function assertOpenedSource(fsApi, sourceFile, descriptor, handleStat) {
  const inputStat = fsApi.lstatSync(sourceFile.path);
  const real = fsApi.realpathSync.native(sourceFile.path);
  const pathStat = fsApi.statSync(real);
  const descriptorStat = fsApi.fstatSync(descriptor);
  if (inputStat.isSymbolicLink()
    || !handleStat.isFile()
    || !descriptorStat.isFile()
    || !pathStat.isFile()
    || !samePath(real, sourceFile.path)
    || !isStrictlyInside(sourceFile.storageRoot, real)
    || !sameFileStat(sourceFile.stat, pathStat)
    || !sameFileStat(handleStat, descriptorStat)
    || !sameFileStat(pathStat, descriptorStat)) {
    throw new Error('source binding changed');
  }
}

function writeAll(fsApi, descriptor, buffer, byteLength) {
  let offset = 0;
  while (offset < byteLength) {
    const written = fsApi.writeSync(descriptor, buffer, offset, byteLength - offset, null);
    if (!Number.isSafeInteger(written) || written <= 0) throw new Error('snapshot write failed');
    offset += written;
  }
}

function sameFileStat(left, right) {
  return Boolean(left)
    && Boolean(right)
    && left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function closeQuietly(fsApi, descriptor) {
  if (descriptor === undefined) return;
  try {
    fsApi.closeSync(descriptor);
  } catch {
    // Preserve the stable snapshot failure while the task directory cleanup runs.
  }
}

function createContainedDirectory(fsApi, directory, parent, allowExisting) {
  const code = 'SOURCE_AUDIO_EVIDENCE_PATH_INVALID';
  try {
    assertDirectoryAtPath(fsApi, parent, code);
    try {
      fsApi.mkdirSync(directory, { mode: 0o700 });
    } catch (error) {
      if (!allowExisting || error?.code !== 'EEXIST') throw error;
    }
    return assertContainedDirectory(fsApi, directory, parent, code, false);
  } catch {
    throw codedError(code);
  }
}

function assertEvidenceDirectoryChain(fsApi, storageRoot, parentDir, outputDir) {
  const code = 'SOURCE_AUDIO_EVIDENCE_PATH_INVALID';
  assertDirectoryAtPath(fsApi, storageRoot, code);
  assertContainedDirectory(fsApi, parentDir, storageRoot, code, false);
  assertContainedDirectory(fsApi, outputDir, parentDir, code, false);
}

function cleanupPrivateTaskDirectory(fsApi, privateAudioRoot, tempDir) {
  if (!fsApi.existsSync(tempDir)) return;
  try {
    assertDirectoryAtPath(fsApi, privateAudioRoot, 'SOURCE_AUDIO_PRIVATE_CLEANUP_FAILED');
    assertContainedDirectory(
      fsApi,
      tempDir,
      privateAudioRoot,
      'SOURCE_AUDIO_PRIVATE_CLEANUP_FAILED',
      false,
    );
    fsApi.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {
    throw codedError('SOURCE_AUDIO_PRIVATE_CLEANUP_FAILED');
  }
}

function cleanupContainedFile(fsApi, parent, filePath) {
  if (!fsApi.existsSync(filePath)) return;
  try {
    assertContainedFile(fsApi, filePath, parent, 'SOURCE_AUDIO_EVIDENCE_PATH_INVALID', false);
    fsApi.rmSync(filePath, { force: true });
  } catch {
    // Refuse to follow or remove a path whose containment cannot be proven.
  }
}

function cleanupEvidenceOutput(fsApi, storageRoot, parentDir, outputDir) {
  if (!fsApi.existsSync(outputDir)) return;
  try {
    assertDirectoryAtPath(fsApi, storageRoot, 'SOURCE_AUDIO_EVIDENCE_PATH_INVALID');
    assertContainedDirectory(
      fsApi,
      parentDir,
      storageRoot,
      'SOURCE_AUDIO_EVIDENCE_PATH_INVALID',
      false,
    );
    assertContainedDirectory(
      fsApi,
      outputDir,
      parentDir,
      'SOURCE_AUDIO_EVIDENCE_PATH_INVALID',
      false,
    );
    fsApi.rmSync(outputDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {
    // Fail closed instead of recursively deleting through an untrusted path.
  }
}

function resolveSourcePath(fsApi, storageRoot, localPath) {
  try {
    const raw = String(localPath || '');
    if (!raw || path.isAbsolute(raw)) throw new Error('relative source path required');
    const candidate = path.resolve(storageRoot, path.normalize(raw));
    const relative = path.relative(storageRoot, candidate);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('source path escaped');
    const inputStat = fsApi.lstatSync(candidate);
    const real = fsApi.realpathSync.native(candidate);
    const stat = fsApi.statSync(real);
    if (inputStat.isSymbolicLink()
      || !stat.isFile()
      || !samePath(candidate, real)
      || !isStrictlyInside(storageRoot, real)) {
      throw new Error('source path escaped');
    }
    fsApi.accessSync(real, fs.constants.R_OK);
    return { path: real, stat, storageRoot };
  } catch {
    throw codedError('SOURCE_AUDIO_SOURCE_PATH_INVALID');
  }
}

function assertExtractedWav(fsApi, wavPath, privateAudioRoot) {
  try {
    const real = assertContainedFile(
      fsApi,
      wavPath,
      privateAudioRoot,
      'SOURCE_AUDIO_EXTRACTION_FAILED',
      true,
    );
    if (fsApi.statSync(real).size <= 0 || path.extname(real).toLowerCase() !== '.wav') {
      throw new Error('invalid WAV');
    }
  } catch {
    throw codedError('SOURCE_AUDIO_EXTRACTION_FAILED');
  }
}

async function invokeWorkerOnce(workerClient, request, assertCurrent) {
  if (!workerClient || typeof workerClient.analyzeSourceAudio !== 'function') {
    throw codedError('SOURCE_AUDIO_WORKER_UNAVAILABLE');
  }
  try {
    assertCurrent();
    const result = await workerClient.analyzeSourceAudio(request);
    assertCurrent();
    return result;
  } catch (error) {
    assertCurrent();
    if (error?.code === 'REDRAW_ANALYSIS_TASK_STALE') throw error;
    const code = String(error?.code || '');
    if (request.preserveSourceEvidence === true && code === 'SOURCE_AUDIO_EVIDENCE_INVALID') {
      throw codedError('SOURCE_AUDIO_EVIDENCE_INVALID');
    }
    if (code === 'SOURCE_AUDIO_RESULT_UNKNOWN'
      || /(?:TIMEOUT|CONNECTION|CLOSED|ABORTED|RESPONSE_(?:TOO_LARGE|INVALID_JSON))/.test(code)) {
      throw codedError('SOURCE_AUDIO_RESULT_UNKNOWN');
    }
    throw codedError('SOURCE_AUDIO_ANALYSIS_FAILED');
  }
}

function normalizeWorkerEvidence(value, audioSha256, requestId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || containsAbsolutePath(value)
    || value.requestId !== requestId
    || value.audioSha256 !== audioSha256
    || !isSha256(value.transcriptSha256)
    || !Array.isArray(value.segments)
    || value.segments.length > 4096) {
    throw codedError('SOURCE_AUDIO_EVIDENCE_INVALID');
  }
  if (Object.hasOwn(value, 'noSpeechEvidence')) {
    const vad = value.noSpeechEvidence;
    if (!sameKeys(value, [
      'audioSha256', 'languageProbability', 'noSpeechEvidence', 'requestId',
      'segments', 'sourceLanguage', 'transcriptSha256',
    ])
      || !vad || typeof vad !== 'object' || Array.isArray(vad)
      || !sameKeys(vad, ['audio_duration_ms', 'method', 'speech_duration_ms'])
      || vad.method !== 'faster-whisper-vad'
      || !Number.isSafeInteger(vad.audio_duration_ms) || vad.audio_duration_ms <= 0
      || vad.speech_duration_ms !== 0
      || value.sourceLanguage !== null || value.languageProbability !== null
      || value.transcriptSha256 !== EMPTY_TRANSCRIPT_SHA256
      || value.segments.length !== 0) {
      throw codedError('SOURCE_AUDIO_EVIDENCE_INVALID');
    }
    return {
      source_language: null,
      language_probability: null,
      audio_sha256: value.audioSha256,
      transcript_sha256: value.transcriptSha256,
      segments: [],
      no_speech_evidence: { ...vad },
    };
  }
  if (!validOwnerPart(value.sourceLanguage) || !isProbability(value.languageProbability)
    || value.segments.length === 0) {
    throw codedError('SOURCE_AUDIO_EVIDENCE_INVALID');
  }
  let previousEnd = 0;
  const segments = value.segments.map((segment) => {
    if (!segment || typeof segment !== 'object' || Array.isArray(segment)
      || !Number.isSafeInteger(segment.startMs)
      || !Number.isSafeInteger(segment.endMs)
      || segment.startMs < previousEnd
      || segment.endMs <= segment.startMs
      || !validText(segment.text)
      || !/^speaker-cluster-[1-9][0-9]*$/.test(String(segment.speakerClusterId || ''))) {
      throw codedError('SOURCE_AUDIO_EVIDENCE_INVALID');
    }
    previousEnd = segment.endMs;
    return {
      start_ms: segment.startMs,
      end_ms: segment.endMs,
      source_text: segment.text.trim(),
      speaker_cluster_id: segment.speakerClusterId,
    };
  });
  return {
    source_language: value.sourceLanguage,
    language_probability: value.languageProbability,
    audio_sha256: value.audioSha256,
    transcript_sha256: value.transcriptSha256,
    segments,
  };
}

function buildEvidence({ parsed, sourceVideoSha256, taskId, workerEvidence, now }) {
  return {
    schema_version: SCHEMA_VERSION,
    task_id: taskId,
    work_id: parsed.workId,
    tenant_id: parsed.tenantId,
    user_id: parsed.userId,
    source_asset_id: parsed.sourceAssetId,
    source_video_sha256: sourceVideoSha256,
    audio_sha256: workerEvidence?.audio_sha256 || null,
    transcript_sha256: workerEvidence?.transcript_sha256 || EMPTY_TRANSCRIPT_SHA256,
    source_language: workerEvidence?.source_language || null,
    language_probability: workerEvidence?.language_probability ?? null,
    dialogue_mode: workerEvidence && !workerEvidence.no_speech_evidence ? 'spoken' : 'silent',
    segments: workerEvidence?.segments || [],
    ...(workerEvidence?.no_speech_evidence
      ? { no_speech_evidence: workerEvidence.no_speech_evidence } : {}),
    created_at: now,
  };
}

function persistEvidence({ assetService, ctx, db, evidence, fsApi, storageRoot, taskId, assertCurrent }) {
  const parentDir = path.join(storageRoot, 'redraw-source-audio-evidence');
  const outputDir = path.join(parentDir, taskId);
  const outputPath = path.join(outputDir, 'audio-evidence.json');
  try {
    createContainedDirectory(fsApi, parentDir, storageRoot, true);
    createContainedDirectory(fsApi, outputDir, parentDir, false);
    atomicWriteJson({
      fsApi,
      storageRoot,
      parentDir,
      outputDir,
      outputPath,
      payload: evidence,
      rawId: (ctx.idFactory || crypto.randomUUID)(),
    });
    const evidenceSha256 = sha256Bytes(fsApi.readFileSync(outputPath));
    const stat = fsApi.statSync(outputPath);
    assertCurrent();
    const asset = assetService.create(db, ctx.log || {}, {
      name: `母本音频证据 ${evidence.work_id}`,
      type: 'json',
      category: 'redraw_source_audio_evidence',
      local_path: path.relative(storageRoot, outputPath).replace(/\\/g, '/'),
      file_size: stat.size,
      mime_type: 'application/json',
      metadata: {
        schema_version: evidence.schema_version,
        tenant_id: evidence.tenant_id,
        user_id: evidence.user_id,
        work_id: evidence.work_id,
        source_asset_id: evidence.source_asset_id,
        source_video_sha256: evidence.source_video_sha256,
        audio_sha256: evidence.audio_sha256,
        transcript_sha256: evidence.transcript_sha256,
        evidence_sha256: evidenceSha256,
      },
    });
    if (!asset || !isPositiveInteger(asset.id)) throw codedError('SOURCE_AUDIO_ASSET_REGISTRATION_FAILED');
    return {
      ...evidence,
      evidence_sha256: evidenceSha256,
      result_asset_id: Number(asset.id),
    };
  } catch (error) {
    cleanupEvidenceOutput(fsApi, storageRoot, parentDir, outputDir);
    if (error?.code === 'REDRAW_ANALYSIS_TASK_STALE') throw error;
    if (error?.code === 'SOURCE_AUDIO_ASSET_REGISTRATION_FAILED') throw error;
    if (error?.code === 'SOURCE_AUDIO_EVIDENCE_PATH_INVALID') throw error;
    throw codedError('SOURCE_AUDIO_PERSISTENCE_FAILED');
  }
}

function atomicWriteJson({
  fsApi,
  storageRoot,
  parentDir,
  outputDir,
  outputPath,
  payload,
  rawId,
}) {
  const tempId = safeGeneratedId(rawId);
  const tempPath = path.join(path.dirname(outputPath), `.audio-evidence-${tempId}.tmp`);
  try {
    assertEvidenceDirectoryChain(fsApi, storageRoot, parentDir, outputDir);
    fsApi.writeFileSync(tempPath, JSON.stringify(payload, null, 2), {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    assertContainedFile(fsApi, tempPath, outputDir, 'SOURCE_AUDIO_EVIDENCE_PATH_INVALID', false);
    assertEvidenceDirectoryChain(fsApi, storageRoot, parentDir, outputDir);
    fsApi.renameSync(tempPath, outputPath);
    assertEvidenceDirectoryChain(fsApi, storageRoot, parentDir, outputDir);
    assertContainedFile(fsApi, outputPath, outputDir, 'SOURCE_AUDIO_EVIDENCE_PATH_INVALID', false);
  } finally {
    cleanupContainedFile(fsApi, outputDir, tempPath);
  }
}

function parseMetadata(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || ''));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isNoAudioStream(error) {
  if (error?.code === 'SOURCE_AUDIO_NO_AUDIO_STREAM') return true;
  const diagnostic = `${error?.stderr || ''}\n${error?.message || ''}`;
  return /(?:does not contain any stream|matches no streams|no audio stream|audio stream.*not found)/i.test(diagnostic);
}

function resolveNow(clock) {
  const value = typeof clock === 'function' ? clock() : new Date().toISOString();
  const text = value instanceof Date ? value.toISOString() : String(value || '');
  if (!text || !Number.isFinite(Date.parse(text))) throw codedError('SOURCE_AUDIO_CLOCK_INVALID');
  return text;
}

function safeGeneratedId(value) {
  const raw = String(value || '');
  if (!/^[a-zA-Z0-9-]{6,128}$/.test(raw)) throw codedError('SOURCE_AUDIO_ID_INVALID');
  return raw;
}

function sameKeys(value, expected) {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function isPositiveInteger(value) {
  return Number.isSafeInteger(Number(value)) && Number(value) > 0;
}

function validOwnerPart(value) {
  return typeof value === 'string' && Boolean(value.trim()) && value.length <= 128 && !value.includes('\0');
}

function validText(value) {
  return typeof value === 'string' && Boolean(value.trim()) && value.length <= 16_384;
}

function isProbability(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isSha256(value) {
  return /^[0-9a-f]{64}$/.test(String(value || ''));
}

function isInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isStrictlyInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function samePath(left, right) {
  const normalizedLeft = path.normalize(path.resolve(left));
  const normalizedRight = path.normalize(path.resolve(right));
  if (process.platform === 'win32') {
    return normalizedLeft.toLowerCase() === normalizedRight.toLowerCase();
  }
  return normalizedLeft === normalizedRight;
}

function containsAbsolutePath(value) {
  if (typeof value === 'string') {
    return path.win32.isAbsolute(value)
      || path.posix.isAbsolute(value)
      || /file:\/\//i.test(value)
      || /(?:^|\s)[a-z]:[\\/]/i.test(value)
      || /\\\\[^\\]+\\[^\\]+/.test(value);
  }
  if (Array.isArray(value)) return value.some(containsAbsolutePath);
  if (value && typeof value === 'object') return Object.values(value).some(containsAbsolutePath);
  return false;
}

async function sha256File(fsApi, filePath) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fsApi.createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

function sha256Bytes(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256Text(value) {
  return sha256Bytes(Buffer.from(String(value), 'utf8'));
}

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

module.exports = {
  SCHEMA_VERSION,
  analyzeSourceAudio,
  aggregateSourceAudioWindows,
  resolveSourceAudioSeamDecision,
  validatePersistedSourceAudioV2,
  validatePersistedSourceAudioSeamCandidate,
  getSourceAudioSeamReview,
  recordSourceAudioSeamDecision,
  createVerifiedSourceAudioContext,
  readVerifiedSourceAudioContext,
  readSourceAudioSeamCandidate,
};
