/**
 * TTS 语音合成服务
 * 支持多种 TTS 接口：minimax、edge-tts（本地）、通用 HTTP
 */
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const DEFAULT_TTS_REQUEST_TIMEOUT_MS = 120000;
const DEFAULT_TTS_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const HARD_TTS_MAX_RESPONSE_BYTES = 128 * 1024 * 1024;

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

function minimaxProviderTaskId(data, headers = {}) {
  return String(
    data?.trace_id || data?.data?.trace_id
      || headers['trace-id'] || headers['x-trace-id'] || '',
  ).trim() || null;
}

function openaiProviderTaskId(headers = {}) {
  return String(
    headers['x-request-id'] || headers['request-id']
      || headers['trace-id'] || headers['x-trace-id'] || '',
  ).trim() || null;
}

function unknownProviderError(message, cause, providerTaskId = null) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = 'PROVIDER_STATUS_UNKNOWN';
  error.status = 'unknown';
  error.unknown = true;
  error.provider_task_id = providerTaskId || null;
  return error;
}

function resolveMaxResponseBytes(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TTS_MAX_RESPONSE_BYTES;
  return Math.min(Math.floor(parsed), HARD_TTS_MAX_RESPONSE_BYTES);
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
  const maxResponseBytes = resolveMaxResponseBytes(options.maxResponseBytes);
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
    let settled = false;
    let responseProviderTaskId = null;
    let response = null;
    let timeoutTimer = null;
    const resolveOnce = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      resolve(value);
    };
    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      reject(error);
    };
    const rejectUnknown = (message, cause, providerTaskId = responseProviderTaskId) => {
      rejectOnce(unknownProviderError(message, cause, providerTaskId));
    };
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
      response = res;
      responseProviderTaskId = minimaxProviderTaskId(null, res.headers);
      const chunks = [];
      let responseBytes = 0;
      const declaredBytes = Number(res.headers['content-length']);
      if (Number.isFinite(declaredBytes) && declaredBytes > maxResponseBytes) {
        rejectUnknown(`MiniMax TTS 响应超过 ${maxResponseBytes} 字节上限，供应商状态未知`);
        res.destroy();
        req.destroy();
        return;
      }
      res.on('data', (chunk) => {
        if (settled) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        responseBytes += buffer.length;
        if (responseBytes > maxResponseBytes) {
          rejectUnknown(`MiniMax TTS 响应超过 ${maxResponseBytes} 字节上限，供应商状态未知`);
          res.destroy();
          req.destroy();
          return;
        }
        chunks.push(buffer);
      });
      res.on('aborted', () => {
        rejectUnknown('MiniMax TTS 响应读取中断');
      });
      res.on('error', (error) => {
        rejectUnknown('MiniMax TTS 响应读取中断', error);
      });
      res.on('close', () => {
        if (!res.complete) rejectUnknown('MiniMax TTS 响应读取中断');
      });
      res.on('end', () => {
        if (settled) return;
        const responseText = Buffer.concat(chunks).toString();
        if (Number(res.statusCode) >= 500) {
          rejectUnknown(`MiniMax TTS HTTP ${res.statusCode}，供应商状态未知`);
          return;
        }
        if (res.statusCode !== 200) {
          rejectOnce(new Error(`MiniMax TTS HTTP ${res.statusCode}: ${responseText.slice(0, 500)}`));
          return;
        }
        let data;
        try {
          data = JSON.parse(responseText);
        } catch (error) {
          rejectUnknown('MiniMax TTS 200 响应不是完整 JSON，供应商状态未知', error);
          return;
        }
        const providerTaskId = minimaxProviderTaskId(data, res.headers);
        const rawStatusCode = data.base_resp?.status_code;
        const statusCode = Number(rawStatusCode);
        if (rawStatusCode === undefined || rawStatusCode === null || rawStatusCode === '' || !Number.isFinite(statusCode)) {
          rejectUnknown('MiniMax TTS 200 响应缺少明确业务状态码，供应商状态未知', null, providerTaskId);
          return;
        }
        if (statusCode !== 0) {
          rejectOnce(new Error(`MiniMax TTS error: ${data.base_resp?.status_msg || 'unknown'}`));
          return;
        }
        const audioHex = data.data?.audio;
        if (typeof audioHex !== 'string' || !audioHex) {
          rejectUnknown('MiniMax TTS 2xx 成功响应缺少音频，供应商状态未知', null, providerTaskId);
          return;
        }
        if (audioHex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(audioHex)) {
          rejectUnknown('MiniMax TTS 2xx 成功响应包含非法音频编码，供应商状态未知', null, providerTaskId);
          return;
        }
        const audio = Buffer.from(audioHex, 'hex');
        if (!isProbableMp3(audio)) {
          rejectUnknown('MiniMax TTS 2xx 成功响应的音频不可用，供应商状态未知', null, providerTaskId);
          return;
        }
        const durationMs = Number(data.extra_info?.audio_length ?? data.data?.extra_info?.audio_length);
        const responseVoiceId = String(data.data?.voice_id || '').trim();
        resolveOnce({
          audio,
          providerTaskId,
          providerStatus: data.data?.status ?? 'completed',
          voiceId: responseVoiceId || voiceId,
          voiceIdSource: responseVoiceId ? 'provider_response' : 'provider_request',
          duration: Number.isFinite(durationMs) && durationMs > 0 ? durationMs / 1000 : null,
          durationSource: Number.isFinite(durationMs) && durationMs > 0
            ? 'provider_extra_info_audio_length'
            : null,
        });
      });
    });
    const timeoutMs = Number.isFinite(Number(options.timeoutMs)) && Number(options.timeoutMs) > 0
      ? Number(options.timeoutMs)
      : DEFAULT_TTS_REQUEST_TIMEOUT_MS;
    timeoutTimer = setTimeout(() => {
      rejectUnknown(`MiniMax TTS 请求/响应超时（${timeoutMs}ms），供应商状态未知`);
      response?.destroy();
      req.destroy();
    }, timeoutMs);
    timeoutTimer.unref?.();
    req.on('error', (error) => {
      rejectUnknown('MiniMax TTS POST 网络错误，供应商状态未知', error);
    });
    try {
      req.write(body);
      req.end();
    } catch (error) {
      rejectUnknown('MiniMax TTS POST 网络错误，供应商状态未知', error);
      req.destroy();
    }
  });
}

/**
 * 使用 OpenAI TTS API 合成语音（兼容所有 OpenAI 格式的代理）
 * POST {base_url}/audio/speech  body: { model, input, voice, response_format, speed }
 */
async function synthesizeWithOpenai(text, voice, apiKey, baseUrl, model, speed, options = {}) {
  const url = (baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '') + '/audio/speech';
  const body = JSON.stringify({
    model: model || 'tts-1',
    input: text,
    voice: voice || 'alloy',
    response_format: 'mp3',
    speed: speed || 1.0,
  });
  const maxResponseBytes = resolveMaxResponseBytes(options.maxResponseBytes);
  return new Promise((resolve, reject) => {
    let settled = false;
    let responseProviderTaskId = null;
    let response = null;
    let timeoutTimer = null;
    const resolveOnce = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      resolve(value);
    };
    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      reject(error);
    };
    const rejectUnknown = (message, cause, providerTaskId = responseProviderTaskId) => {
      rejectOnce(unknownProviderError(message, cause, providerTaskId));
    };
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
      response = res;
      responseProviderTaskId = openaiProviderTaskId(res.headers);
      const chunks = [];
      let responseBytes = 0;
      const declaredBytes = Number(res.headers['content-length']);
      if (Number.isFinite(declaredBytes) && declaredBytes > maxResponseBytes) {
        rejectUnknown(`OpenAI TTS 响应超过 ${maxResponseBytes} 字节上限，供应商状态未知`);
        res.destroy();
        req.destroy();
        return;
      }
      res.on('data', (chunk) => {
        if (settled) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        responseBytes += buffer.length;
        if (responseBytes > maxResponseBytes) {
          rejectUnknown(`OpenAI TTS 响应超过 ${maxResponseBytes} 字节上限，供应商状态未知`);
          res.destroy();
          req.destroy();
          return;
        }
        chunks.push(buffer);
      });
      res.on('aborted', () => {
        rejectUnknown('OpenAI TTS 响应读取中断');
      });
      res.on('error', (error) => {
        rejectUnknown('OpenAI TTS 响应读取中断', error);
      });
      res.on('close', () => {
        if (!res.complete) rejectUnknown('OpenAI TTS 响应读取中断');
      });
      res.on('end', () => {
        if (settled) return;
        const buf = Buffer.concat(chunks);
        if (Number(res.statusCode) >= 500) {
          rejectUnknown(`OpenAI TTS HTTP ${res.statusCode}，供应商状态未知`);
          return;
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          rejectOnce(new Error(`OpenAI TTS HTTP ${res.statusCode}: ${buf.toString('utf-8').slice(0, 500)}`));
          return;
        }
        if (!isProbableMp3(buf)) {
          rejectUnknown('OpenAI TTS 2xx 成功响应的音频不可用，供应商状态未知');
          return;
        }
        resolveOnce({
          audio: buf,
          providerTaskId: responseProviderTaskId,
          providerStatus: 'completed',
          voiceId: voice || 'alloy',
          voiceIdSource: 'provider_request',
          duration: null,
          durationSource: null,
        });
      });
    });
    const timeoutMs = Number.isFinite(Number(options.timeoutMs)) && Number(options.timeoutMs) > 0
      ? Number(options.timeoutMs)
      : DEFAULT_TTS_REQUEST_TIMEOUT_MS;
    timeoutTimer = setTimeout(() => {
      rejectUnknown(`OpenAI TTS 请求/响应超时（${timeoutMs}ms），供应商状态未知`);
      response?.destroy();
      req.destroy();
    }, timeoutMs);
    timeoutTimer.unref?.();
    req.on('error', (error) => {
      rejectUnknown('OpenAI TTS POST 网络错误，供应商状态未知', error);
    });
    try {
      req.write(body);
      req.end();
    } catch (error) {
      rejectUnknown('OpenAI TTS POST 网络错误，供应商状态未知', error);
      req.destroy();
    }
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
  timeout_ms,
  max_response_bytes,
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
  // 外部传入的 voice_id / speed 优先（海外化场景），否则取配置值
  const voiceId = voice_id || ttsConfig.voice_id || ttsSettings.voice_id || '';
  const { resolveTtsModel } = require('./ttsConfigSelectionService');
  const ttsModel = resolveTtsModel(ttsConfig);
  const finalSpeed = speed ?? ttsSettings.speed ?? 1;
  const finalVolume = volume ?? ttsSettings.volume ?? 1;
  const finalPitch = pitch ?? ttsSettings.pitch ?? 0;
  const finalEmotion = emotion || ttsSettings.emotion || '';
  const finalPronunciationTones = pronunciation_tones || ttsSettings.pronunciation_tones || [];
  const configuredTimeoutMs = timeout_ms ?? ttsSettings.timeout_ms ?? ttsSettings.request_timeout_ms;
  const configuredMaxResponseBytes = max_response_bytes
    ?? ttsSettings.max_response_bytes
    ?? ttsSettings.response_max_bytes;
  let audioBuffer;
  let providerResult = null;

  if (provider === 'minimax') {
    providerResult = await synthesizeWithMinimax(
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
        timeoutMs: configuredTimeoutMs,
        maxResponseBytes: configuredMaxResponseBytes,
      }
    );
    audioBuffer = providerResult.audio;
  } else if (provider === 'openai' || ttsConfig.base_url) {
    providerResult = await synthesizeWithOpenai(
      text,
      voiceId || 'alloy',
      ttsConfig.api_key,
      ttsConfig.base_url,
      ttsModel,
      finalSpeed,
      {
        timeoutMs: configuredTimeoutMs,
        maxResponseBytes: configuredMaxResponseBytes,
      }
    );
    audioBuffer = providerResult.audio;
  } else {
    throw new Error(`不支持的 TTS provider: ${provider}，目前支持 openai、minimax`);
  }

  let localPath;
  try {
    if (!isProbableMp3(audioBuffer)) throw new Error('TTS 未返回有效 MP3 音频');

    // 保存到本地
    const relativeAudioDir = String(storage_subdir || 'audio').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    const audioDir = path.join(storage_base, relativeAudioDir);
    if (!fs.existsSync(audioDir)) fs.mkdirSync(audioDir, { recursive: true });
    const filename = `tts_sb${storyboard_id || 'x'}_${randomUUID().slice(0, 8)}.mp3`;
    const filePath = path.join(audioDir, filename);
    fs.writeFileSync(filePath, audioBuffer);
    localPath = `${relativeAudioDir}/${filename}`;
    log.info('[TTS] 合成完成', { storyboard_id, local_path: localPath, provider });
  } catch (error) {
    const unknown = unknownProviderError(
      'TTS 供应商已完成，但本地音频持久化状态未知',
      error,
      providerResult?.providerTaskId,
    );
    unknown.provider_completed = true;
    throw unknown;
  }
  try { const cs = require('./cloudService'); cs.reportUsage('tts', ttsModel || '', '', 0); } catch (_) {}
  if (providerResult) {
    const metadata = {
      provider,
      model: ttsModel,
      provider_task_id: providerResult.providerTaskId,
      provider_status: providerResult.providerStatus,
      voice_id: providerResult.voiceId,
      voice_id_source: providerResult.voiceIdSource,
      duration: providerResult.duration,
      duration_source: providerResult.durationSource,
      language_verified: false,
      detected_locale: null,
    };
    return {
      local_path: localPath,
      status: 'completed',
      provider_task_id: providerResult.providerTaskId,
      invocation_id: providerResult.providerTaskId,
      voice_id: providerResult.voiceId,
      duration: providerResult.duration,
      provider,
      model: ttsModel,
      language_verified: false,
      detected_locale: null,
      metadata,
    };
  }
  return { local_path: localPath };
}

module.exports = { synthesize, isProbableMp3 };
