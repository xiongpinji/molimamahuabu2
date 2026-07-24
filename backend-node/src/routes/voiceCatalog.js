const response = require('../response');
const voiceCatalogService = require('../services/builtinVoiceCatalogService');

function routes(db, cfg, log) {
  return {
    preview: (req, res) => {
      try {
        const entry = voiceCatalogService.getBuiltinVoice(req.params.id, cfg);
        if (!entry) return response.notFound(res, '内置音色不存在');
        if (!entry.file) return response.notFound(res, '该内置音色尚未生成本地参考音频');
        return res.sendFile(entry.file.absPath, (err) => {
          if (err && !res.headersSent) {
            log.error('voice catalog preview', { error: err.message });
            response.internalError(res, '音色试听失败');
          }
        });
      } catch (err) {
        log.error('voice catalog preview', { error: err.message });
        return response.internalError(res, '音色试听失败');
      }
    },
    list: (req, res) => {
      try {
        const keyword = req.query?.keyword || '';
        const items = [
          ...voiceCatalogService.listBuiltinVoices(cfg, { keyword }),
          ...voiceCatalogService.listProjectVoiceAssets(db, req.query?.drama_id, { keyword }),
        ];
        response.success(res, { items });
      } catch (err) {
        log.error('voice catalog list', { error: err.message });
        response.internalError(res, '音色目录读取失败');
      }
    },
    bind: (req, res) => {
      try {
        const result = voiceCatalogService.bindBuiltinVoice({
          db,
          cfg,
          characterId: req.params.id,
          voiceId: req.body?.voice_id || req.body?.catalog_id,
        });
        if (result.ok) return response.success(res, { message: '内置音色已绑定', seedance2_voice_asset: result.asset });
        if (result.code === 'CHARACTER_NOT_FOUND' || result.code === 'BUILTIN_VOICE_NOT_FOUND' || result.code === 'VOICE_ASSET_NOT_FOUND') {
          return response.notFound(res, result.error);
        }
        return response.badRequest(res, result.error);
      } catch (err) {
        log.error('voice catalog bind', { error: err.message });
        response.internalError(res, '内置音色绑定失败');
      }
    },
  };
}

module.exports = routes;
