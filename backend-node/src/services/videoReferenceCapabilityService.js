'use strict';

const TYPE_LABELS = { image: '图片', audio: '音频', video: '视频' };

function parseSettings(settings) {
  try {
    return typeof settings === 'string' ? JSON.parse(settings) : (settings || {});
  } catch (_) {
    return {};
  }
}

function knownCapabilities(config = {}, model = '') {
  const normalizedModel = String(config.canvas_selected_model || model || config.default_model || '').trim().toLowerCase();
  const protocol = String(config.api_protocol || '').trim().toLowerCase();
  const provider = String(config.provider || '').trim().toLowerCase();
  if (protocol === 'token6688' || provider === 'token6688' || provider === 'tokengo') {
    return {
      referenceTypes: ['image', 'video', 'audio'],
      maxImageReferences: 9,
      maxVideoReferences: 3,
      maxAudioReferences: 9,
      aspectRatios: ['9:16', '16:9', '21:9', '1:1', '4:3', '3:4'],
      resolutions: ['720p'],
      durations: [15],
      quantities: [1],
      supportsFirstFrame: true,
      supportsLastFrame: true,
      supportsAudio: true,
    };
  }
  if (normalizedModel === 'lingjing-video-v1') {
    return { referenceTypes: ['image'], maxImageReferences: 12, maxAudioReferences: 0, maxVideoReferences: 0 };
  }
  if (normalizedModel === 'video-v1' || protocol === 'djpsd_openapi' || provider === 'djpsd_openapi') {
    return { referenceTypes: ['image'], maxImageReferences: 10, maxAudioReferences: 0, maxVideoReferences: 0 };
  }
  if (/seedance[-_ ]?2/i.test(normalizedModel)) {
    return { referenceTypes: ['image', 'audio'], maxImageReferences: 9, maxAudioReferences: 1, maxVideoReferences: 0 };
  }
  if (normalizedModel === 'veo-clean') {
    return { referenceTypes: ['video'], maxImageReferences: 0, maxAudioReferences: 0, maxVideoReferences: 1 };
  }
  return { referenceTypes: ['image'], maxImageReferences: 3, maxAudioReferences: 0, maxVideoReferences: 0 };
}

function normalizeLimit(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
}

function resolve(config = {}, model = '') {
  const inferred = knownCapabilities(config, model);
  const explicit = parseSettings(config.settings)?.canvas_capabilities;
  const declared = explicit && typeof explicit === 'object' && !Array.isArray(explicit) ? explicit : {};
  const declaredTypes = Array.isArray(declared.referenceTypes)
    ? declared.referenceTypes.map((item) => String(item).toLowerCase()).filter((item) => TYPE_LABELS[item])
    : inferred.referenceTypes;
  const referenceTypes = [...new Set(declaredTypes)];
  const maxImageReferences = normalizeLimit(
    declared.maxImageReferences ?? declared.maxReferences,
    inferred.maxImageReferences,
  );
  const capabilities = {
    ...inferred,
    ...declared,
    referenceTypes,
    maxImageReferences,
    maxAudioReferences: normalizeLimit(declared.maxAudioReferences, inferred.maxAudioReferences),
    maxVideoReferences: normalizeLimit(declared.maxVideoReferences, inferred.maxVideoReferences),
  };
  capabilities.maxReferences = capabilities.maxImageReferences;
  return capabilities;
}

function uniqueUrls(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean))];
}

function validateAndNormalize({ model, capabilities, referenceImageUrls, referenceAudioUrls, referenceVideoUrls }) {
  const values = {
    image: uniqueUrls(referenceImageUrls),
    audio: uniqueUrls(referenceAudioUrls),
    video: uniqueUrls(referenceVideoUrls),
  };
  for (const type of Object.keys(values)) {
    if (values[type].length && !capabilities.referenceTypes.includes(type)) {
      const error = new Error(`${model || '当前视频模型'} 当前不支持${TYPE_LABELS[type]}参考`);
      error.code = 'UNSUPPORTED_VIDEO_REFERENCE';
      throw error;
    }
    const limit = capabilities[`max${type[0].toUpperCase()}${type.slice(1)}References`];
    if (values[type].length > limit) {
      const error = new Error(`${model || '当前视频模型'} 最多支持 ${limit} 个${TYPE_LABELS[type]}参考`);
      error.code = 'VIDEO_REFERENCE_LIMIT_EXCEEDED';
      throw error;
    }
  }
  return {
    referenceImageUrls: values.image,
    referenceAudioUrls: values.audio,
    referenceVideoUrls: values.video,
  };
}

module.exports = { knownCapabilities, resolve, validateAndNormalize };
