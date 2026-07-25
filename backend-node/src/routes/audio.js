const response = require('../response');
const { randomUUID } = require('crypto');
const path = require('path');
const auditEvent = require('../services/auditEventService');
const creditLedger = require('../services/creditLedgerService');
const modelPrice = require('../services/modelPriceService');
const storageLayout = require('../services/storageLayout');

function routes(db, log, cfg, options = {}) {
  function getStoragePath() {
    const loadConfig = require('../config').loadConfig;
    const c = (cfg && cfg.storage) ? cfg : loadConfig();
    return path.isAbsolute(c.storage?.local_path)
      ? c.storage.local_path
      : path.join(process.cwd(), c.storage?.local_path || './data/storage');
  }

  return {
    /** 为单条分镜生成 TTS：对白 → audio_local_path；旁白 → narration_audio_local_path（body.tts_kind === 'narration'） */
    extract: async (req, res) => {
      const { drama_id, storyboard_id, text, tts_kind, tts_model } = req.body || {};
      if (!text && !storyboard_id) return response.badRequest(res, '请提供 storyboard_id 或 text');
      const dramaId = Number(drama_id);
      if (options.billingEnabled && (!Number.isInteger(dramaId) || dramaId <= 0)) {
        return response.badRequest(res, 'drama_id 必须是正整数');
      }
      if (options.billingEnabled) {
        const owner = req.tenant?.id
          ? db.prepare(`SELECT id FROM dramas
            WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`).get(dramaId, req.tenant.id)
          : db.prepare(`SELECT id FROM dramas
            WHERE id = ? AND user_id = ? AND deleted_at IS NULL`).get(dramaId, req.user?.id);
        if (!owner) return response.notFound(res, '资源不存在');
      }
      const kind = String(tts_kind || 'dialogue').toLowerCase() === 'narration' ? 'narration' : 'dialogue';
      let ttsText = text;
      if (kind === 'narration') {
        if ((!ttsText || !String(ttsText).trim()) && storyboard_id) {
          const row = db.prepare('SELECT narration FROM storyboards WHERE id = ? AND deleted_at IS NULL').get(Number(storyboard_id));
          ttsText = row?.narration;
        }
        if (!ttsText || !String(ttsText).trim()) {
          return response.badRequest(res, '分镜解说旁白为空，无法合成语音');
        }
      } else {
        if ((!ttsText || !String(ttsText).trim()) && storyboard_id) {
          const row = db.prepare('SELECT dialogue FROM storyboards WHERE id = ? AND deleted_at IS NULL').get(Number(storyboard_id));
          ttsText = row?.dialogue;
        }
        if (!ttsText || !String(ttsText).trim()) {
          return response.badRequest(res, '分镜对白为空，无法合成语音');
        }
      }
      let reservation = null;
      let selectedModel = null;
      try {
        const ttsService = require('../services/ttsService');
        const { selectTtsConfig } = require('../services/ttsConfigSelectionService');
        const selectedConfig = selectTtsConfig(db, tts_model);
        selectedModel = modelPrice.canonicalModel(selectedConfig.default_model);
        if (options.billingEnabled) {
          const amount = modelPrice.requirePrice(db, selectedModel);
          reservation = creditLedger.reserve(db, {
            tenantId: req.tenant?.id,
            actorUserId: req.user?.id,
            userId: req.user?.id,
            operationKey: `audio:${dramaId}:${randomUUID()}`,
            model: selectedModel,
            resourceType: 'audio',
            resourceId: String(dramaId),
            amount,
          });
          auditEvent.record(db, {
            userId: req.user?.id,
            tenantId: req.tenant?.id,
            eventType: 'generation.audio.created',
            resourceType: 'audio',
            resourceId: String(dramaId),
            outcome: 'success',
            code: 'CREATED',
          });
        }
        const result = await ttsService.synthesize(db, log, {
          text: ttsText,
          storyboard_id: storyboard_id || null,
          storage_base: getStoragePath(),
          storage_subdir: dramaId
            ? path.posix.join(storageLayout.getProjectStorageSubdir(db, dramaId), 'audio')
            : 'audio',
          config: selectedConfig,
        });
        if (reservation) {
          creditLedger.settleGeneration(db, reservation.id, 'completed');
          auditEvent.record(db, {
            userId: req.user?.id,
            tenantId: req.tenant?.id,
            eventType: 'generation.audio.completed',
            resourceType: 'audio',
            resourceId: String(dramaId),
            outcome: 'success',
          });
        }
        if (storyboard_id && result.local_path) {
          const now = new Date().toISOString();
          try {
            if (kind === 'narration') {
              db.prepare('UPDATE storyboards SET narration_audio_local_path = ?, audio_model = ?, updated_at = ? WHERE id = ?').run(
                result.local_path, selectedModel, now, Number(storyboard_id)
              );
            } else {
              db.prepare('UPDATE storyboards SET audio_local_path = ?, audio_model = ?, updated_at = ? WHERE id = ?').run(
                result.local_path, selectedModel, now, Number(storyboard_id)
              );
            }
          } catch (_) {}
        }
        response.success(res, {
          local_path: result.local_path,
          url: result.local_path ? '/static/' + result.local_path : '',
          tts_kind: kind,
          model: selectedModel,
        });
      } catch (err) {
        if (reservation) {
          try {
            creditLedger.settleGeneration(db, reservation.id, 'failed', err.message);
            auditEvent.record(db, {
              userId: req.user?.id,
              tenantId: req.tenant?.id,
              eventType: 'generation.audio.failed',
              resourceType: 'audio',
              resourceId: String(dramaId),
              outcome: 'failed',
              code: err.code || 'GENERATION_FAILED',
            });
          } catch (billingError) {
            log.error('audio extract billing settle', {
              reservation_id: reservation.id,
              error: billingError.message,
            });
          }
        }
        log.error('audio extract', { error: err.message });
        if (err.code === 'TTS_MODEL_NOT_CONFIGURED') {
          return response.error(res, 400, err.code, err.message);
        }
        if (['MODEL_PRICE_NOT_CONFIGURED', 'MODEL_DISABLED'].includes(err.code)) {
          return response.error(res, 503, err.code, err.message);
        }
        if (err.code === 'INSUFFICIENT_CREDITS') {
          return response.error(res, 402, err.code, '积分不足，请兑换积分后重试');
        }
        response.internalError(res, err.message);
      }
    },

    /** 批量为多条分镜生成 TTS */
    extractBatch: async (req, res) => {
      const { storyboard_ids } = req.body || {};
      if (!Array.isArray(storyboard_ids) || storyboard_ids.length === 0) {
        return response.badRequest(res, 'storyboard_ids 不能为空');
      }
      const results = [];
      const storagePath = getStoragePath();
      for (const sbId of storyboard_ids) {
        const row = db.prepare('SELECT id, dialogue FROM storyboards WHERE id = ? AND deleted_at IS NULL').get(Number(sbId));
        if (!row || !row.dialogue?.trim()) {
          results.push({ storyboard_id: sbId, error: '对白为空' });
          continue;
        }
        try {
          const ttsService = require('../services/ttsService');
          const result = await ttsService.synthesize(db, log, {
            text: row.dialogue,
            storyboard_id: row.id,
            storage_base: storagePath,
          });
          if (result.local_path) {
            const now = new Date().toISOString();
            try {
              db.prepare('UPDATE storyboards SET audio_local_path = ?, updated_at = ? WHERE id = ?').run(
                result.local_path, now, row.id
              );
            } catch (_) {}
          }
          results.push({ storyboard_id: sbId, local_path: result.local_path });
        } catch (err) {
          results.push({ storyboard_id: sbId, error: err.message });
        }
      }
      response.success(res, results);
    },
  };
}

module.exports = routes;
