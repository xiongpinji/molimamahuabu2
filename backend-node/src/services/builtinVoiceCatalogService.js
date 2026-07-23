const fs = require('fs');
const path = require('path');
const storageLayout = require('./storageLayout');
const assetService = require('./assetService');

const CATALOG = [
  {
    id: 'melotts-zh',
    engine: 'melotts',
    voice_id: 'ZH',
    language: 'zh-CN',
    label: '中文音色',
    description: '中文及中英混合旁白/角色音色',
  },
  {
    id: 'melotts-en-us',
    engine: 'melotts',
    voice_id: 'EN-US',
    language: 'en-US',
    label: '英语（美国）',
    description: '美式英语角色音色',
  },
  {
    id: 'melotts-en-br',
    engine: 'melotts',
    voice_id: 'EN-BR',
    language: 'en-BR',
    label: '英语（巴西）',
    description: 'MeloTTS EN-BR 音色',
  },
  {
    id: 'melotts-jp',
    engine: 'melotts',
    voice_id: 'JP',
    language: 'ja-JP',
    label: '日语',
    description: '日语角色音色',
  },
  {
    id: 'melotts-kr',
    engine: 'melotts',
    voice_id: 'KR',
    language: 'ko-KR',
    label: '韩语',
    description: '韩语角色音色',
  },
];

const LICENSE = {
  name: 'MIT',
  url: 'https://github.com/myshell-ai/MeloTTS/blob/main/LICENSE',
  source_url: 'https://github.com/myshell-ai/MeloTTS',
};

function storageRoot(cfg = {}) {
  const configured = cfg?.storage?.local_path || process.env.STORAGE_LOCAL_PATH;
  if (!configured) return path.join(process.cwd(), 'data', 'storage');
  return path.isAbsolute(configured) ? configured : path.join(process.cwd(), configured);
}

function voiceRoot(cfg = {}) {
  const configured = cfg?.tts?.melotts?.voice_dir || process.env.MELOTTS_VOICE_DIR;
  if (configured) return path.isAbsolute(configured) ? configured : path.join(process.cwd(), configured);
  return path.join(storageRoot(cfg), storageLayout.LIBRARY, 'voices', 'melotts');
}

function safeVoiceFile(entry, cfg = {}) {
  const root = voiceRoot(cfg);
  for (const ext of ['.wav', '.mp3', '.m4a', '.ogg']) {
    const candidate = path.join(root, `${entry.id}${ext}`);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return { absPath: candidate, ext };
  }
  return null;
}

function listBuiltinVoices(cfg = {}) {
  return CATALOG.map((entry) => {
    const file = safeVoiceFile(entry, cfg);
    return {
      ...entry,
      license: LICENSE.name,
      license_url: LICENSE.url,
      source_url: LICENSE.source_url,
      available: Boolean(file),
      can_bind: Boolean(file),
      preview_url: file ? `/api/v1/voice-catalog/${entry.id}/preview` : null,
      setup_hint: file ? null : '请运行 backend-node/scripts/generate-melotts-voice-samples.py 生成本地参考音频',
    };
  });
}

function getBuiltinVoice(id, cfg = {}) {
  const entry = CATALOG.find((item) => item.id === String(id));
  if (!entry) return null;
  const file = safeVoiceFile(entry, cfg);
  return {
    ...entry,
    license: LICENSE.name,
    license_url: LICENSE.url,
    source_url: LICENSE.source_url,
    file,
    preview_url: file ? `/api/v1/voice-catalog/${entry.id}/preview` : null,
  };
}

function listProjectVoiceAssets(db, dramaId) {
  const id = Number(dramaId);
  if (!Number.isInteger(id) || id <= 0) return [];
  return assetService.list(db, { drama_id: id, type: 'audio', category: 'voice', page: 1, page_size: 100 }).items
    .map((asset) => {
      const metadata = asset.metadata || {};
      const voiceAsset = metadata.voice_asset || {};
      return {
        id: `asset-${asset.id}`,
        asset_id: asset.id,
        engine: 'audio-library',
        voice_id: `asset-${asset.id}`,
        language: '项目音色',
        label: asset.name || `${metadata.character_name || '角色'} · 提取音色`,
        description: `来源：${metadata.character_name || '角色'}，分镜 ${metadata.storyboard_id || '-'}；可复用于本项目角色`,
        license: '项目素材',
        license_url: null,
        source_url: null,
        available: Boolean(asset.url || asset.local_path),
        can_bind: Boolean(asset.url || asset.local_path),
        preview_url: asset.url || (asset.local_path ? `/static/${String(asset.local_path).replace(/^\//, '')}` : null),
        url: asset.url || '',
        local_path: asset.local_path || '',
        audio_url: asset.url || '',
        voice_url: asset.url || '',
        voice_local_path: asset.local_path || '',
        source: 'extracted_voice_asset',
        duration: asset.duration ?? voiceAsset.duration ?? null,
        metadata,
      };
    });
}

function bindBuiltinVoice({ db, cfg = {}, characterId, voiceId }) {
  const rawVoiceId = String(voiceId || '');
  if (rawVoiceId.startsWith('asset-')) {
    return assetService.bindVoiceAsset({
      db,
      cfg,
      characterId,
      assetId: rawVoiceId.slice('asset-'.length),
    });
  }
  const id = Number(characterId);
  const character = db.prepare(
    'SELECT id, drama_id FROM characters WHERE id = ? AND deleted_at IS NULL'
  ).get(id);
  if (!character) return { ok: false, code: 'CHARACTER_NOT_FOUND', error: '角色不存在' };

  const entry = getBuiltinVoice(voiceId, cfg);
  if (!entry) return { ok: false, code: 'BUILTIN_VOICE_NOT_FOUND', error: '内置音色不存在' };
  if (!entry.file) {
    return { ok: false, code: 'BUILTIN_VOICE_NOT_READY', error: '该内置音色尚未生成本地参考音频，请先配置 MeloTTS 生成器' };
  }

  const projectSubdir = storageLayout.getProjectStorageSubdir(db, character.drama_id);
  const relDir = `${projectSubdir}/characters/voice`;
  const absDir = path.join(storageRoot(cfg), relDir);
  fs.mkdirSync(absDir, { recursive: true });
  const ext = entry.file.ext;
  const safeName = `char_${id}_voice_${entry.id}${ext}`;
  const absPath = path.join(absDir, safeName);
  fs.copyFileSync(entry.file.absPath, absPath);
  const now = new Date().toISOString();
  const asset = {
    status: 'active',
    url: `/static/${relDir}/${safeName}`,
    local_path: `${relDir}/${safeName}`,
    certified_at: now,
    duration: null,
    format: ext.slice(1),
    source: 'builtin_melotts',
    engine: entry.engine,
    voice_id: entry.voice_id,
    catalog_id: entry.id,
    license: entry.license,
    license_url: entry.license_url,
    source_url: entry.source_url,
  };
  db.prepare('UPDATE characters SET seedance2_voice_asset = ?, updated_at = ? WHERE id = ?').run(
    JSON.stringify(asset), now, id
  );
  return { ok: true, asset };
}

module.exports = {
  CATALOG,
  LICENSE,
  storageRoot,
  voiceRoot,
  listBuiltinVoices,
  getBuiltinVoice,
  listProjectVoiceAssets,
  bindBuiltinVoice,
};
