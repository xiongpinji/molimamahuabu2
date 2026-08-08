/**
 * TTS 语音合成服务
 * 支持多种 TTS 接口：minimax、edge-tts（本地）、通用 HTTP
 */
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const MELOTTS_LANGUAGE_VOICE_IDS = new Set(['ZH', 'EN-US', 'EN-BR', 'JP', 'KR']);

const MPEG1_BITRATES = {
  3: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
};
const MPEG2_BITRATES = {
  3: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  1: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const MPEG_SAMPLE_RATES = {
  0: [11025, 12000, 8000],
  2: [22050, 24000, 16000],
  3: [44100, 48000, 32000],
};

function getMpegFrameLength(buffer, offset) {
  if (offset < 0 || offset + 4 > buffer.length) return 0;
  if (buffer[offset] !== 0xff || (buffer[offset + 1] & 0xe0) !== 0xe0) return 0;

  const version = (buffer[offset + 1] >> 3) & 0x03;
  const layer = (buffer[offset + 1] >> 1) & 0x03;
  const bitrateIndex = (buffer[offset + 2] >> 4) & 0x0f;
  const sampleRateIndex = (buffer[offset + 2] >> 2) & 0x03;
  const padding = (buffer[offset + 2] >> 1) & 0x01;
  if (version === 0x01 || layer === 0x00 || bitrateIndex === 0 || bitrateIndex === 0x0f || sampleRateIndex === 0x03) {
    return 0;
  }

  const bitrate = (version === 0x03 ? MPEG1_BITRATES : MPEG2_BITRATES)[layer][bitrateIndex];
  const sampleRate = MPEG_SAMPLE_RATES[version][sampleRateIndex];
  if (layer === 0x03) return Math.floor((12 * bitrate * 1000) / sampleRate + padding) * 4;
  const coefficient = layer === 0x01 && version !== 0x03 ? 72 : 144;
  return Math.floor((coefficient * bitrate * 1000) / sampleRate) + padding;
}

function id3AudioOffset(buffer) {
  if (buffer[0] !== 0x49 || buffer[1] !== 0x44 || buffer[2] !== 0x33) return 0;
  if (buffer.length < 10 || buffer[3] < 2 || buffer[3] > 4) return -1;
  const sizeBytes = buffer.subarray(6, 10);
  if ([...sizeBytes].some((byte) => (byte & 0x80) !== 0)) return -1;
  const tagSize = (sizeBytes[0] << 21) | (sizeBytes[1] << 14) | (sizeBytes[2] << 7) | sizeBytes[3];
  const footerSize = buffer[3] === 4 && (buffer[5] & 0x10) !== 0 ? 10 : 0;
  const offset = 10 + tagSize + footerSize;
  return offset <= buffer.length ? offset : -1;
}

function isProbableMp3(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return false;
  let offset = id3AudioOffset(buffer);
  if (offset < 0) return false;

  const frameLength = getMpegFrameLength(buffer, offset);
  return Boolean(frameLength && offset + frameLength <= buffer.length);
}

/**
 * 使用 MiniMax T2A v2 合成语音
 */
async function synthesizeWithMinimax(text, voiceId, apiKey, baseUrl, model, options = {}) {
  const normalizedBaseUrl = String(baseUrl || 'https://api.minimaxi.com/v1').replace(/\/+$/, '');
  const url = normalizedBaseUrl.endsWith('/t2a_v2')
    ? normalizedBaseUrl
    : `${normalizedBaseUrl}/t2a_v2`;
  const pronunciationTones = Array.isArray(options.pronunciationTones)
    ? options.pronunciationTones.filter(Boolean)
    : [];
  const body = JSON.stringify({
    model: model || 'speech-2.8-hd',
    text,
    stream: false,
    output_format: 'hex',
    voice_setting: {
      voice_id: voiceId || 'female-shaonv',
      speed: options.speed ?? 1,
      vol: options.volume ?? 1,
      pitch: options.pitch ?? 0,
      ...(options.emotion ? { emotion: options.emotion } : {}),
    },
    ...(pronunciationTones.length ? { pronunciation_dict: { tone: pronunciationTones } } : {}),
    audio_setting: {
      sample_rate: 32000,
      bitrate: 128000,
      format: 'mp3',
      channel: 1,
    },
  });
  return new Promise((resolve, reject) => {
    const reqOpts = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const urlObj = new URL(url);
    const client = urlObj.protocol === 'https:' ? https : http;
    const req = client.request(urlObj, reqOpts, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`MiniMax TTS HTTP ${res.statusCode}: ${Buffer.concat(chunks).toString()}`));
          return;
        }
        const data = JSON.parse(Buffer.concat(chunks).toString());
        if (data.base_resp?.status_code !== 0) {
          reject(new Error(`MiniMax TTS error: ${data.base_resp?.status_msg || 'unknown'}`));
          return;
        }
        const audioHex = data.data?.audio;
        if (!audioHex) { reject(new Error('MiniMax TTS 未返回音频')); return; }
        resolve(Buffer.from(audioHex, 'hex'));
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * 使用 OpenAI TTS API 合成语音（兼容所有 OpenAI 格式的代理）
 * POST {base_url}/audio/speech  body: { model, input, voice, response_format, speed }
 */
async function synthesizeWithOpenai(text, voice, apiKey, baseUrl, model, speed) {
  const url = (baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '') + '/audio/speech';
  const body = JSON.stringify({
    model: model || 'tts-1',
    input: text,
    voice: voice || 'alloy',
    response_format: 'mp3',
    speed: speed || 1.0,
  });
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    const reqOpts = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}),
      },
    };
    const req = mod.request(reqOpts, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`OpenAI TTS HTTP ${res.statusCode}: ${buf.toString('utf-8').slice(0, 500)}`));
          return;
        }
        resolve(buf);
      });
    });
    const timer = setTimeout(() => { req.destroy(); reject(new Error('OpenAI TTS 请求超时')); }, 120000);
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    req.on('close', () => clearTimeout(timer));
    req.write(body);
    req.end();
  });
}

/**
 * 合成 TTS 并保存到本地文件
 * @returns {{ local_path: string, audio_url: string }}
 */
async function synthesize(db, log, {
  text,
  storyboard_id,
  config,
  storage_base,
  storage_subdir,
  voice_id,
  speed,
  volume,
  pitch,
  emotion,
  pronunciation_tones,
}) {
  if (!text || !text.trim()) throw new Error('text 不能为空');
  const aiConfigService = require('./aiConfigService');
  const ttsConfig = config || (() => {
    const configs = aiConfigService.listConfigs(db, 'tts');
    const active = configs.filter((c) => c.is_active);
    return active.find((c) => c.is_default) || active[0];
  })();
  if (!ttsConfig) throw new Error('未配置 TTS 模型，请在「AI 配置」中添加 service_type=tts 的配置');

  const provider = (ttsConfig.provider || '').toLowerCase();
  let ttsSettings = {};
  try { ttsSettings = JSON.parse(ttsConfig.settings || '{}'); } catch (_) {}
  // 画布旧节点可能保存了 MeloTTS 的语言代码；MiniMax 不接受这类 voice_id。
  const requestedVoiceId = String(voice_id || '').trim();
  const configuredVoiceId = String(ttsConfig.voice_id || ttsSettings.voice_id || '').trim();
  const voiceId = provider === 'minimax' && MELOTTS_LANGUAGE_VOICE_IDS.has(requestedVoiceId.toUpperCase())
    ? configuredVoiceId
    : requestedVoiceId || configuredVoiceId;
  const { resolveTtsModel } = require('./ttsConfigSelectionService');
  const ttsModel = resolveTtsModel(ttsConfig);
  const finalSpeed = speed ?? ttsSettings.speed ?? 1;
  const finalVolume = volume ?? ttsSettings.volume ?? 1;
  const finalPitch = pitch ?? ttsSettings.pitch ?? 0;
  const finalEmotion = emotion || ttsSettings.emotion || '';
  const finalPronunciationTones = pronunciation_tones || ttsSettings.pronunciation_tones || [];
  let audioBuffer;

  if (provider === 'minimax') {
    audioBuffer = await synthesizeWithMinimax(
      text,
      voiceId || 'female-shaonv',
      ttsConfig.api_key,
      ttsConfig.base_url,
      ttsModel,
      {
        speed: finalSpeed,
        volume: finalVolume,
        pitch: finalPitch,
        emotion: finalEmotion,
        pronunciationTones: finalPronunciationTones,
      }
    );
  } else if (provider === 'openai' || ttsConfig.base_url) {
    audioBuffer = await synthesizeWithOpenai(
      text,
      voiceId || 'alloy',
      ttsConfig.api_key,
      ttsConfig.base_url,
      ttsModel,
      finalSpeed
    );
  } else {
    throw new Error(`不支持的 TTS provider: ${provider}，目前支持 openai、minimax`);
  }

  if (!isProbableMp3(audioBuffer)) {
    throw new Error('TTS 未返回有效 MP3 音频');
  }

  // 保存到本地
  const relativeAudioDir = String(storage_subdir || 'audio').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const audioDir = path.join(storage_base, relativeAudioDir);
  if (!fs.existsSync(audioDir)) fs.mkdirSync(audioDir, { recursive: true });
  const filename = `tts_sb${storyboard_id || 'x'}_${randomUUID().slice(0, 8)}.mp3`;
  const filePath = path.join(audioDir, filename);
  fs.writeFileSync(filePath, audioBuffer);
  const localPath = `${relativeAudioDir}/${filename}`;
  log.info('[TTS] 合成完成', { storyboard_id, local_path: localPath, provider });
  try { const cs = require('./cloudService'); cs.reportUsage('tts', ttsModel || '', '', 0); } catch (_) {}
  return { local_path: localPath };
}

module.exports = { synthesize, isProbableMp3 };
