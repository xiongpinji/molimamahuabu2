#!/usr/bin/env node
'use strict';

/**
 * Prod paid canary: seedance-2-fast + generate_audio=true.
 * Sample informs aspect/duration/dialogue; real-person frame NOT used as reference.
 * Never prints api_key. Indeterminate create → retain state, no auto-resubmit.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('node:crypto');
const { spawnSync } = require('child_process');

const ROOT = '/opt/moli-drama/current/backend-node';
process.chdir(ROOT);

const Database = require(`${ROOT}/node_modules/better-sqlite3`);
const {
  callToapisVideoApi,
  fetchToapisTask,
  normalizeToapisBaseUrl,
} = require(`${ROOT}/src/services/toapisVideoClient`);

const CONFIG_ID = Number(process.env.SMOKE_CONFIG_ID || 16);
const MODEL = String(process.env.SMOKE_MODEL || 'seedance-2-fast');
const OUT_DIR = '/tmp/moli-native-dialogue-canary';
const SAMPLE_5S = path.join(OUT_DIR, 'sample-5s.mp4');
const STATE_PATH = path.join(OUT_DIR, 'canary-state.json');
const EVIDENCE_PATH = path.join(OUT_DIR, 'canary-evidence.json');
const CONFIRM = 'RUN_NATIVE_DIALOGUE_CANARY';
const DB_CANDIDATES = [
  '/opt/moli-drama/shared/data/drama_generator.db',
  `${ROOT}/data/drama_generator.db`,
];

const PROMPT = [
  '竖屏短剧近景，虚构成年男性角色站在城市街道，校服外套，表情疑惑，',
  '用中文清晰说出对白：<不是哥们你谁啊>，口型自然，环境声真实，无字幕文字烧录。',
].join('');

const LOG = {
  info: (...args) => console.error('[info]', ...args),
  warn: (...args) => console.error('[warn]', ...args),
  error: (...args) => console.error('[error]', ...args),
};

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function probeMedia(filePath) {
  const result = spawnSync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration,size:stream=codec_type,codec_name,width,height',
    '-of', 'json',
    filePath,
  ], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`ffprobe failed: ${result.stderr || result.error}`);
  return JSON.parse(result.stdout);
}

function resolveDbPath() {
  for (const candidate of DB_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error('drama_generator.db not found');
}

function loadApiConfig(db, id) {
  const row = db.prepare(`
    SELECT id, provider, base_url, api_key, default_model, model, is_active, verification_status
    FROM ai_service_configs
    WHERE id = ? AND deleted_at IS NULL
  `).get(id);
  if (!row) throw new Error(`config ${id} not found`);
  if (!row.is_active) throw new Error(`config ${id} inactive`);
  if (!String(row.api_key || '').trim()) throw new Error(`config ${id} missing api_key`);
  return row;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  if (String(process.env.CANARY_CONFIRM || '') !== CONFIRM) {
    throw new Error(`refusing paid submit without CANARY_CONFIRM=${CONFIRM}`);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  if (!fs.existsSync(SAMPLE_5S)) throw new Error(`missing trimmed sample: ${SAMPLE_5S}`);

  const sampleSha = sha256File(SAMPLE_5S);
  const sampleProbe = probeMedia(SAMPLE_5S);

  const db = new Database(resolveDbPath(), { readonly: true, fileMustExist: true });
  const row = loadApiConfig(db, CONFIG_ID);
  const apiKey = String(row.api_key).trim();
  // Production client currently contracts official entry as https://toapis.cn
  // (local tree may still mention xyz; canary follows the live deployed client).
  const clientConfig = {
    id: row.id,
    provider: 'toapis',
    base_url: 'https://toapis.cn',
    api_key: apiKey,
  };
  normalizeToapisBaseUrl(clientConfig.base_url);

  let state = fs.existsSync(STATE_PATH)
    ? JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'))
    : null;

  if (state?.provider_task_id && state.status !== 'completed') {
    console.log(JSON.stringify({
      mode: 'resume',
      provider_task_id: state.provider_task_id,
      note: 'state exists; poll only, no resubmit',
    }));
  }

  if (!state?.provider_task_id) {
    const startedAt = new Date().toISOString();
    const submit = await callToapisVideoApi(clientConfig, LOG, {
      model: MODEL,
      prompt: PROMPT,
      resolution: '480p',
      duration: 5,
      aspect_ratio: '9:16',
      generate_audio: true,
      client_business_id: `moli-native-sample-canary-${Date.now()}`,
    }, { apiKey });

    if (submit?.error) {
      const evidence = {
        contract: 'redraw-native-dialogue-canary-v1',
        status: 'submit_failed',
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        config_id: CONFIG_ID,
        model: MODEL,
        generate_audio: true,
        sample: {
          path_basename: 'sample-5s.mp4',
          sha256: sampleSha,
          probe: sampleProbe,
          dialogue_source: '不是哥们你谁啊',
          note: '样片仅作画幅/时长/对白合同；未上传真人参考',
        },
        error: String(submit.error).slice(0, 300),
        route_meta: submit.route_meta || null,
      };
      fs.writeFileSync(EVIDENCE_PATH, JSON.stringify(evidence, null, 2));
      throw new Error(submit.error);
    }

    const taskId = submit?.task_id;
    if (!taskId) {
      throw new Error('no task id after submit (indeterminate); refuse retry');
    }
    state = {
      provider_task_id: String(taskId),
      started_at: startedAt,
      config_id: CONFIG_ID,
      model: MODEL,
      sample_sha256: sampleSha,
      status: 'submitted',
    };
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
    console.log(JSON.stringify({ submitted: true, provider_task_id: state.provider_task_id }));
  }

  const deadline = Date.now() + 12 * 60 * 1000;
  while (Date.now() < deadline) {
    const parsed = await fetchToapisTask(clientConfig, state.provider_task_id, { apiKey });
    const status = parsed?.state || 'processing';
    console.log(JSON.stringify({
      poll: true,
      provider_task_id: state.provider_task_id,
      state: status,
      progress: parsed?.progress ?? null,
    }));
    if (status === 'completed' && parsed.videoUrl) {
      const artifactPath = path.join(OUT_DIR, 'canary-output.mp4');
      const res = await fetch(parsed.videoUrl);
      if (!res.ok) throw new Error(`download failed ${res.status}`);
      fs.writeFileSync(artifactPath, Buffer.from(await res.arrayBuffer()));
      const artifactProbe = probeMedia(artifactPath);
      const streams = Array.isArray(artifactProbe.streams) ? artifactProbe.streams : [];
      const hasVideo = streams.some((s) => s.codec_type === 'video');
      const audioStream = streams.find((s) => s.codec_type === 'audio');
      const evidence = {
        contract: 'redraw-native-dialogue-canary-v1',
        status: 'completed',
        started_at: state.started_at,
        finished_at: new Date().toISOString(),
        config_id: CONFIG_ID,
        model: MODEL,
        provider_task_id: state.provider_task_id,
        generate_audio: true,
        aspect_ratio: '9:16',
        resolution: '480p',
        duration_s: 5,
        transport: {
          base_url: 'https://toapis.cn',
          note: 'live deployed normalizeToapisBaseUrl requires toapis.cn',
        },
        sample: {
          path_basename: 'sample-5s.mp4',
          sha256: sampleSha,
          probe: sampleProbe,
          dialogue_source: '不是哥们你谁啊',
          note: '样片裁剪 5s 作合同参考；未上传真人参考图/视频',
        },
        artifact: {
          path_basename: 'canary-output.mp4',
          sha256: sha256File(artifactPath),
          probe: artifactProbe,
          has_video: hasVideo,
          has_audio: Boolean(audioStream),
          audio_codec: audioStream?.codec_name || null,
        },
        verdict: {
          ok: hasVideo && Boolean(audioStream),
          reason: hasVideo && audioStream
            ? 'native_audio_track_present'
            : 'missing_video_or_audio',
        },
      };
      state.status = 'completed';
      fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
      fs.writeFileSync(EVIDENCE_PATH, JSON.stringify(evidence, null, 2));
      console.log(JSON.stringify({
        ok: evidence.verdict.ok,
        provider_task_id: state.provider_task_id,
        artifact_sha256: evidence.artifact.sha256,
        audio_codec: evidence.artifact.audio_codec,
        evidence_path: EVIDENCE_PATH,
      }, null, 2));
      return;
    }
    if (status === 'failed') {
      const evidence = {
        contract: 'redraw-native-dialogue-canary-v1',
        status: 'failed',
        provider_task_id: state.provider_task_id,
        error: String(parsed.error || 'provider failed').slice(0, 300),
        sample_sha256: sampleSha,
      };
      state.status = 'failed';
      fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
      fs.writeFileSync(EVIDENCE_PATH, JSON.stringify(evidence, null, 2));
      throw new Error(evidence.error);
    }
    await sleep(8000);
  }
  throw new Error('canary poll timeout; state retained for resume (no resubmit)');
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: String(error.message || error).slice(0, 400),
  }, null, 2));
  process.exitCode = 1;
});
