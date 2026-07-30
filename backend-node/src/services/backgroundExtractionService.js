// 与 Go ImageGenerationService.ExtractBackgroundsForEpisode + processBackgroundExtraction 对齐
const taskService = require('./taskService');
const aiClient = require('./aiClient');
const promptI18n = require('./promptI18n');
const sceneService = require('./sceneService');
const creditLedger = require('./creditLedgerService');
const modelPrice = require('./modelPriceService');
const auditEvent = require('./auditEventService');
const textGenerationBilling = require('./text-generation-billing-service');
const { safeParseAIJSON, extractFirstArray } = require('../utils/safeJson');

function resolveBillingModel(db, requestedModel) {
  const mapped = aiClient.getConfigFromModelMap(db, 'scene_extraction');
  const config = mapped?.config
    || (requestedModel
      ? aiClient.getConfigForModel(db, 'text', requestedModel)
      : aiClient.getDefaultConfig(db, 'text'));
  if (!config) throw new Error('未配置场景提取文本模型');
  return modelPrice.canonicalModel(
    aiClient.getModelFromConfig(config, mapped?.modelOverride || requestedModel),
  );
}

function settleBackgroundCredit(db, log, reservationId, outcome, message = '') {
  if (!reservationId) return null;
  try {
    const settled = creditLedger.settleGeneration(db, reservationId, outcome, message);
    auditEvent.record(db, {
      userId: settled?.actor_user_id || settled?.user_id,
      tenantId: settled?.tenant_id,
      eventType: outcome === 'completed'
        ? 'generation.background_extraction.completed'
        : 'generation.background_extraction.failed',
      resourceType: 'text',
      resourceId: settled?.resource_id,
      outcome: outcome === 'completed' ? 'success' : 'failed',
      code: outcome === 'failed' ? 'BACKGROUND_EXTRACTION_FAILED' : null,
    });
    return settled;
  } catch (error) {
    log?.error?.('场景提取积分结算失败，保留原预扣状态', {
      reservation_id: reservationId,
      error: error.message,
    });
    return null;
  }
}

function normalizeLanguage(language) {
  const lang = (language || '').toString().trim().toLowerCase();
  return lang === 'zh' || lang === 'en' ? lang : '';
}

function hasChinese(text) {
  return /[\u4e00-\u9fff]/.test(text || '');
}

function withLanguage(cfg, language) {
  if (!language) return cfg;
  return {
    ...cfg,
    app: { ...(cfg?.app || {}), language },
  };
}

async function translatePromptToChinese(db, log, model, prompt) {
  const userPrompt =
    '请将以下场景图像提示词翻译为中文，保留风格词或比例（如 realistic、16:9）原样，直接返回翻译后的中文提示词，不要解释：\n' +
    prompt;
  const text = await aiClient.generateText(db, log, 'text', userPrompt, '', {
    scene_key: 'scene_extraction',
    model: model || undefined,
    temperature: 0.2,
    max_tokens: 400,
  });
  return (text || '').toString().trim();
}

async function extractBackgroundsFromScript(db, cfg, log, scriptContent, dramaId, model, style) {
  if (!scriptContent || !scriptContent.trim()) return [];
  const systemPrompt = promptI18n.getSceneExtractionPrompt(cfg, style);
  const prompt = (promptI18n.getLanguage(cfg) === 'en' ? '[Script Content]\n' : '【剧本内容】\n') + scriptContent;
  const text = await aiClient.generateText(db, log, 'text', prompt, systemPrompt, { scene_key: 'scene_extraction', model: model || undefined, temperature: 0.7 });
  let list = [];
  try {
    const parsed = safeParseAIJSON(text, log);
    list = extractFirstArray(parsed) || [];
  } catch (_) {
    list = [];
  }
  return list.map((b) => ({
    location: b.location || '',
    time: b.time || '',
    prompt: b.prompt || '',
    atmosphere: b.atmosphere,
  }));
}

async function processBackgroundExtraction(
  db,
  cfg,
  log,
  taskID,
  episodeId,
  model,
  style,
  language,
  billingReservationId,
  options = {},
) {
  taskService.updateTaskStatus(db, taskID, 'processing', 0, '正在提取场景信息...');
  const episode = db.prepare('SELECT id, drama_id, script_content FROM episodes WHERE id = ? AND deleted_at IS NULL').get(Number(episodeId));
  if (!episode) {
    taskService.updateTaskError(db, taskID, '剧集信息不存在');
    settleBackgroundCredit(db, log, billingReservationId, 'failed', '剧集信息不存在');
    return;
  }
  const scriptContent = episode.script_content;
  if (!scriptContent || !String(scriptContent).trim()) {
    taskService.updateTaskError(db, taskID, '剧本内容为空');
    settleBackgroundCredit(db, log, billingReservationId, 'failed', '剧本内容为空');
    return;
  }

  // 合并风格：显式 style 参数优先（一般为前端传来的英文 prompt）；否则用剧集 metadata 中的完整提示词
  let effectiveCfg = cfg;
  try {
    const dramaRow = db.prepare('SELECT style, metadata FROM dramas WHERE id = ? AND deleted_at IS NULL').get(episode.drama_id);
    const { mergeCfgStyleWithDrama } = require('../utils/dramaStyleMerge');
    const paramStyle = (style && String(style).trim()) || '';
    let next = { ...cfg, style: { ...(cfg?.style || {}) } };
    if (dramaRow?.metadata) {
      const meta = typeof dramaRow.metadata === 'string' ? JSON.parse(dramaRow.metadata) : dramaRow.metadata;
      if (meta?.aspect_ratio) next.style.default_image_ratio = meta.aspect_ratio;
    }
    if (paramStyle) {
      next.style = {
        ...next.style,
        default_style_zh: paramStyle,
        default_style_en: paramStyle,
        default_style: paramStyle,
      };
      effectiveCfg = next;
    } else {
      effectiveCfg = mergeCfgStyleWithDrama(next, dramaRow);
    }
    style = paramStyle || effectiveCfg?.style?.default_style_en || effectiveCfg?.style?.default_style || style;
  } catch (_) {}

  const requestedLanguage = normalizeLanguage(language);
  const configuredLanguage = normalizeLanguage(promptI18n.getLanguage(effectiveCfg));
  let effectiveLanguage = requestedLanguage || configuredLanguage;
  if (!requestedLanguage && effectiveLanguage === 'en' && hasChinese(scriptContent)) {
    effectiveLanguage = 'zh';
  }
  const cfgForPrompt = withLanguage(effectiveCfg, effectiveLanguage);
  let backgroundsInfo;
  try {
    backgroundsInfo = await extractBackgroundsFromScript(
      db,
      cfgForPrompt,  // 已包含 effectiveCfg + language
      log,
      String(scriptContent),
      episode.drama_id,
      model,
      style  // 作为 prompt 追加（extractBackgroundsFromScript 内部会用到）
    );
  } catch (err) {
    log.error('Background extraction AI failed', { error: err.message, task_id: taskID });
    const message = 'AI提取场景失败: ' + err.message;
    taskService.updateTaskError(db, taskID, message);
    settleBackgroundCredit(db, log, billingReservationId, 'failed', message);
    return;
  }
  if (!Array.isArray(backgroundsInfo) || backgroundsInfo.length === 0) {
    const message = 'AI 未提取到场景，请检查剧本内容后重试';
    taskService.updateTaskError(db, taskID, message);
    settleBackgroundCredit(db, log, billingReservationId, 'failed', message);
    return;
  }
  if (effectiveLanguage === 'zh') {
    const translated = await Promise.all(
      (backgroundsInfo || []).map(async (bg, index) => {
        const original = (bg.prompt || '').toString().trim();
        if (!original || hasChinese(original)) return bg;
        let translationBilling = null;
        try {
          translationBilling = textGenerationBilling.begin(db, {
            enabled: Boolean(options.billingEnabled),
            tenantId: options.tenantId,
            userId: options.userId,
            requestedModel: model,
            sceneKey: 'scene_extraction',
            resourceType: 'background_translation',
            resourceId: `${taskID}:${index}`,
            operation: 'background_prompt_translation',
          });
          const translatedPrompt = await translatePromptToChinese(db, log, translationBilling.model, original);
          if (!translatedPrompt) throw new Error('场景提示词翻译结果为空');
          textGenerationBilling.settle(db, log, translationBilling, 'completed');
          return { ...bg, prompt: translatedPrompt };
        } catch (err) {
          textGenerationBilling.settle(db, log, translationBilling, 'failed', err.message);
          log.warn('Background prompt translate failed', { error: err.message, task_id: taskID });
          return bg;
        }
      })
    );
    backgroundsInfo = translated;
  }
  sceneService.deleteScenesByEpisodeId(db, log, episodeId);
  const scenes = [];
  for (const bg of backgroundsInfo) {
    const scene = sceneService.createSceneForEpisode(db, log, episode.drama_id, episodeId, {
      location: bg.location,
      time: bg.time,
      prompt: bg.prompt,
    });
    if (scene) {
      scenes.push(scene);
      // polished_prompt 是完整四视图图片提示词，提取后始终为空，需要异步预生成
      if (effectiveCfg && !options.billingEnabled) {
        const capturedStyle = style;
        setImmediate(() => {
          sceneService.generateScenePromptOnly(db, log, effectiveCfg, scene.id, model, capturedStyle).catch((err) => {
            log.warn('[提取场景] 预生成polished_prompt失败', { scene_id: scene.id, error: err.message });
          });
        });
      }
    }
  }
  taskService.updateTaskResult(db, taskID, {
    scenes,
    count: scenes.length,
    episode_id: episodeId,
    drama_id: episode.drama_id,
  });
  settleBackgroundCredit(db, log, billingReservationId, 'completed');
  log.info('Background extraction completed', { task_id: taskID, episode_id: episodeId, count: scenes.length });
}

function extractBackgroundsForEpisode(db, cfg, log, episodeId, model, style, language, options = {}) {
  const episode = db.prepare('SELECT id, drama_id, script_content FROM episodes WHERE id = ? AND deleted_at IS NULL').get(Number(episodeId));
  if (!episode) throw new Error('episode not found');
  if (!episode.script_content || !String(episode.script_content).trim()) {
    throw new Error('episode has no script content');
  }
  // 读取项目的 aspect_ratio，覆盖全局 cfg 中的 default_image_ratio，使 promptI18n 生成正确比例的提示词
  let runCfg = cfg;
  if (episode.drama_id) {
    try {
      const dramaRow = db.prepare('SELECT metadata FROM dramas WHERE id = ? AND deleted_at IS NULL').get(episode.drama_id);
      if (dramaRow && dramaRow.metadata) {
        const meta = typeof dramaRow.metadata === 'string' ? JSON.parse(dramaRow.metadata) : dramaRow.metadata;
        if (meta && meta.aspect_ratio) {
          runCfg = { ...cfg, style: { ...(cfg?.style || {}), default_image_ratio: meta.aspect_ratio } };
        }
      }
    } catch (_) {}
  }
  const billingEnabled = Boolean(options.billingEnabled);
  const userId = options.userId ? String(options.userId) : '';
  const tenantId = options.tenantId ? String(options.tenantId) : '';
  if (billingEnabled && !userId) {
    throw Object.assign(new Error('公开计费模式缺少用户身份'), { code: 'UNAUTHORIZED' });
  }
  const ownerClause = billingEnabled ? (tenantId ? ' AND tenant_id = ?' : ' AND user_id = ?') : '';
  const existing = db.prepare(
    `SELECT id FROM async_tasks
     WHERE resource_id = ? AND type = 'background_extraction'
       AND status IN ('pending', 'processing') AND deleted_at IS NULL
       ${ownerClause}
     ORDER BY created_at DESC LIMIT 1`
  ).get(...(billingEnabled ? [String(episodeId), tenantId || userId] : [String(episodeId)]));
  if (existing) {
    log.info('Background extraction already running', { task_id: existing.id, episode_id: episodeId });
    return existing.id;
  }

  const task = taskService.createTask(db, log, 'background_extraction', String(episodeId));
  let billingReservationId = null;
  let billingModel = model;
  if (billingEnabled) {
    try {
      billingModel = resolveBillingModel(db, model);
      const amount = modelPrice.requirePrice(db, billingModel);
      const reservation = creditLedger.reserve(db, {
        tenantId,
        actorUserId: userId,
        userId,
        operationKey: `background_extraction:${task.id}`,
        model: billingModel,
        resourceType: 'text',
        resourceId: task.id,
        amount,
      });
      billingReservationId = reservation.id;
      db.prepare(`UPDATE async_tasks
        SET tenant_id = ?, user_id = ?, model = ?, credit_reservation_id = ? WHERE id = ?`)
        .run(tenantId || null, userId, billingModel, reservation.id, task.id);
      auditEvent.record(db, {
        userId,
        tenantId,
        eventType: 'generation.background_extraction.created',
        resourceType: 'text',
        resourceId: task.id,
        outcome: 'success',
        code: 'CREATED',
      });
    } catch (error) {
      taskService.updateTaskError(db, task.id, error.message || '积分预扣失败');
      throw error;
    }
  }
  setImmediate(() => {
    processBackgroundExtraction(
      db,
      runCfg,
      log,
      task.id,
      episodeId,
      billingModel,
      style,
      language,
      billingReservationId,
      options,
    ).catch((err) => {
      log.error('processBackgroundExtraction fatal', { error: err.message, task_id: task.id });
      settleBackgroundCredit(db, log, billingReservationId, 'failed', err.message);
      taskService.updateTaskError(db, task.id, err.message || '场景提取失败');
    });
  });
  return task.id;
}

module.exports = {
  extractBackgroundsForEpisode,
};
