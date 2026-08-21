const { safeParseAIJSON } = require('../utils/safeJson');

const SYSTEM_PROMPT = `你是影视预演导演。请从参考图中识别可见人物、主要道具和建议机位，并把画面转换为可编辑的三维站位数据。
只输出一个 JSON 对象，不要 Markdown，不要解释。结构必须是：
{"summary":"简述","people":[{"name":"人物名","body_type":"male|female|child|muscular|slim","color":"#RRGGBB","position":[x,y,z],"rotation_degrees":[x,y,z],"scale":1}],"props":[{"name":"道具名","shape":"box|sphere","color":"#RRGGBB","position":[x,y,z],"rotation_degrees":[x,y,z],"scale":[x,y,z]}],"cameras":[{"name":"机位名","position":[x,y,z],"target":[x,y,z],"fov":50,"roll":0}]}
坐标单位为米，地面为 y=0；人物脚底位于 y=0；人物面向镜头时旋转为 [0,0,0]。最多 12 人、20 个主要道具、8 个有明显构图差异的机位。不要输出灯光、文字标签或无法从画面合理推断的细枝末节。`;

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, number(value)));
}

function vector(value, fallback, limits) {
  const input = Array.isArray(value) ? value : [];
  return fallback.map((item, index) => clamp(input[index] ?? item, limits[index][0], limits[index][1]));
}

function rotation(value) {
  return vector(value, [0, 0, 0], [[-360, 360], [-360, 360], [-360, 360]])
    .map((degrees) => degrees * Math.PI / 180);
}

function scale(value) {
  const input = Array.isArray(value) ? value : [value, value, value];
  return vector(input, [1, 1, 1], [[0.05, 20], [0.05, 20], [0.05, 20]]);
}

function color(value, fallback) {
  const normalized = String(value || '').trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(normalized) ? normalized : fallback;
}

function name(value, fallback) {
  return String(value || fallback).trim().slice(0, 40) || fallback;
}

function normalizeDirectorReference(raw) {
  const parsed = typeof raw === 'string' ? safeParseAIJSON(raw, {}) : raw;
  const source = parsed?.scene && typeof parsed.scene === 'object' ? parsed.scene : parsed;
  const people = (Array.isArray(source?.people) ? source.people : []).slice(0, 12).map((entry, index) => {
    const bodyType = String(entry?.body_type || entry?.bodyType || 'male').toLowerCase();
    return {
      name: name(entry?.name, `人物${index + 1}`),
      bodyType: ['male', 'female', 'child', 'muscular', 'slim'].includes(bodyType) ? bodyType : 'male',
      color: color(entry?.color, '#4f8ef7'),
      position: vector(entry?.position, [0, 0, 0], [[-50, 50], [0, 50], [-50, 50]]),
      rotation: rotation(entry?.rotation_degrees || entry?.rotation),
      scale: scale(entry?.scale),
    };
  });
  const props = (Array.isArray(source?.props) ? source.props : []).slice(0, 20).map((entry, index) => ({
    name: name(entry?.name, `道具${index + 1}`),
    type: ['box', 'sphere'].includes(String(entry?.shape || entry?.type).toLowerCase())
      ? String(entry?.shape || entry?.type).toLowerCase()
      : 'box',
    color: color(entry?.color, '#9ca3af'),
    position: vector(entry?.position, [0, 0.5, 0], [[-50, 50], [0, 50], [-50, 50]]),
    rotation: rotation(entry?.rotation_degrees || entry?.rotation),
    scale: scale(entry?.scale),
  }));
  const cameras = (Array.isArray(source?.cameras) ? source.cameras : []).slice(0, 8).map((entry, index) => ({
    name: name(entry?.name, `机位${index + 1}`),
    position: vector(entry?.position, [0, 1.6, 4.8], [[-100, 100], [0.05, 100], [-100, 100]]),
    target: vector(entry?.target || entry?.look_at, [0, 1, 0], [[-50, 50], [0, 50], [-50, 50]]),
    fov: clamp(entry?.fov ?? 50, 20, 100),
    roll: clamp(entry?.roll ?? 0, -180, 180),
  }));
  if (!people.length && !props.length && !cameras.length) throw new Error('未识别到可用的站位元素');
  return { summary: String(source?.summary || '').trim().slice(0, 300), people, props, cameras };
}

function createDirectorReferenceService({ generateTextWithVision = null } = {}) {
  return {
    async analyzeDirectorReference(db, log, imageUrl, model) {
      const source = String(imageUrl || '').trim();
      if (!/^(https?:|data:image\/(?:png|jpeg|webp);base64,)/i.test(source)) {
        throw new Error('参考图必须是 HTTP 地址或 PNG/JPEG/WebP data URL');
      }
      const visionGenerator = generateTextWithVision || require('./aiClient').generateTextWithVision;
      const raw = await visionGenerator(
        db,
        log,
        'text',
        '分析这张参考图并生成可编辑的导演台站位、主要道具和建议机位。',
        SYSTEM_PROMPT,
        { imageUrl: source },
        { model: model || undefined, temperature: 0.1, max_tokens: 4000 },
      );
      return normalizeDirectorReference(raw);
    },
  };
}

const defaultService = createDirectorReferenceService();

module.exports = {
  SYSTEM_PROMPT,
  createDirectorReferenceService,
  normalizeDirectorReference,
  analyzeDirectorReference: defaultService.analyzeDirectorReference,
};
