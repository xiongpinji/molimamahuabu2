'use strict';

const KIND_BY_SERVICE = Object.freeze({
  image: 'image',
  storyboard_image: 'image',
  video: 'video',
});

function parseModels(value) {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  if (value == null || value === '') return [];
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parseModels(parsed);
    } catch (_) {}
    return value.split(',').map((item) => item.trim()).filter(Boolean);
  }
  return [String(value).trim()].filter(Boolean);
}

function orderedModels(config) {
  const values = [String(config.default_model || '').trim(), ...parseModels(config.model)].filter(Boolean);
  const seen = new Set();
  return values.filter((model) => {
    const key = model.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function listEntries(configs = []) {
  const candidates = configs.flatMap((config) => {
    const kind = KIND_BY_SERVICE[String(config.service_type || '').toLowerCase()];
    if (!kind) return [];
    return orderedModels(config).map((upstreamModel) => ({ config, kind, upstreamModel }));
  });
  const counts = new Map();
  for (const item of candidates) {
    const key = `${item.kind}:${item.upstreamModel.toLowerCase()}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return candidates.map((item) => {
    const key = `${item.kind}:${item.upstreamModel.toLowerCase()}`;
    const duplicated = counts.get(key) > 1;
    const model = duplicated
      ? `cfg-${item.config.id}::${item.upstreamModel}`
      : item.upstreamModel;
    return { ...item, model, duplicated };
  });
}

function parseQualifiedSelection(value) {
  const match = String(value || '').trim().match(/^cfg-(\d+)::(.+)$/);
  if (!match) return null;
  return { configId: Number(match[1]), upstreamModel: match[2] };
}

function resolveQualifiedConfig(configs, value) {
  const selection = parseQualifiedSelection(value);
  if (!selection) return null;
  const config = configs.find((item) => Number(item.id) === selection.configId);
  if (!config) return null;
  const upstreamModel = orderedModels(config)
    .find((model) => model.toLowerCase() === selection.upstreamModel.toLowerCase());
  if (!upstreamModel) return null;
  return {
    ...config,
    canvas_selected_model: upstreamModel,
    canvas_selection_model: String(value).trim(),
  };
}

module.exports = {
  KIND_BY_SERVICE,
  parseModels,
  orderedModels,
  listEntries,
  parseQualifiedSelection,
  resolveQualifiedConfig,
};
