const express = require('express');
const response = require('../response');
const dramaRoutes = require('./drama');
const taskRoutes = require('./task');
const settingsRoutes = require('./settings');
const aiConfigRoutes = require('./aiConfig');
const propRoutes = require('./prop');
const stubRoutes = require('./stub');
const characterLibraryRoutes = require('./characterLibrary');
const sceneLibraryRoutes = require('./sceneLibrary');
const propLibraryRoutes = require('./propLibrary');
const characterRoutes = require('./characters');
const uploadModule = require('./upload');
const sceneRoutes = require('./scenes');
const storyboardRoutes = require('./storyboards');
const tailFrameLinkRoutes = require('./storyboards_tail_link');
const imageRoutes = require('./images');
const videoRoutes = require('./videos');
const videoMergeRoutes = require('./videoMerges');
const assetRoutes = require('./assets');
const imageToolRoutes = require('./imageTools');
const audioRoutes = require('./audio');
const canvasTextRoutes = require('./canvas-text');
const voiceCatalogRoutes = require('./voiceCatalog');
const scriptAnalysisRoutes = require('./scriptAnalysis');
const promptOverridesRoutes = require('./promptOverrides');
const directorExportRoutes = require('./directorExport');
const directorReferenceRoutes = require('./directorReference');
const sceneModelMapRoutes = require('./sceneModelMap');
const authRoutes = require('./auth');
const billingRoutes = require('./billing');
const tenantRoutes = require('./tenants');
const platformAccountRoutes = require('./platformAccounts');
const { createEmailService } = require('../services/emailService');
const { createRateLimitMiddleware } = require('../middleware/rateLimit');
const { createModelGenerationGuard } = require('../middleware/modelGenerationGuard');
const { PERMISSIONS, createPlatformPermissionMiddleware } = require('../middleware/platformRbac');
const textGenerationBilling = require('../services/text-generation-billing-service');

function setupRouter(cfg, db, log) {
  const r = express.Router();
  const publicPlatformEnabled = /^(1|true|yes)$/i.test(String(process.env.PUBLIC_PLATFORM_MODE || ''));
  const drama = dramaRoutes(db, cfg, log, { billingEnabled: publicPlatformEnabled });
  const task = taskRoutes(db, log);
  const settings = settingsRoutes(db, cfg, log);
  const aiConfig = aiConfigRoutes(db, log, cfg);
  const stub = stubRoutes(db, cfg, log);
  const sceneModelMap = sceneModelMapRoutes(db, log);
  const prop = propRoutes(db, log, cfg, { billingEnabled: publicPlatformEnabled });
  const { createAdminAuthMiddleware } = require('../middleware/adminAuth');
  const requireAdmin = createAdminAuthMiddleware({
    enabled: publicPlatformEnabled,
    token: process.env.PLATFORM_ADMIN_TOKEN,
  });
  const requireBootstrapAdminToken = createAdminAuthMiddleware({
    enabled: publicPlatformEnabled,
    token: process.env.PLATFORM_ADMIN_TOKEN,
    requireRole: false,
  });
  const registrationEnabled = /^(1|true|yes)$/i.test(
    String(process.env.PLATFORM_REGISTRATION_ENABLED || ''),
  );
  const emailVerificationEnabled = publicPlatformEnabled
    && !/^(0|false|no)$/i.test(String(process.env.PLATFORM_EMAIL_VERIFICATION_ENABLED || 'true'));
  const auth = authRoutes(db, {
    registrationEnabled,
    emailVerificationEnabled,
    jwtSecret: process.env.PLATFORM_JWT_SECRET,
    verificationSecret: process.env.PLATFORM_VERIFICATION_SECRET || process.env.PLATFORM_JWT_SECRET,
    secureCookies: publicPlatformEnabled
      && !/^(0|false|no)$/i.test(String(process.env.PLATFORM_SECURE_COOKIES || 'true')),
    mailer: createEmailService(process.env),
    bootstrapAdminEmail: publicPlatformEnabled
      ? process.env.PLATFORM_BOOTSTRAP_ADMIN_EMAIL
      : undefined,
  });
  const billing = billingRoutes(db, log);
  const tenants = tenantRoutes(db, log);
  const platformAccounts = platformAccountRoutes(db, log);
  const requirePlatformPermission = (permission) => createPlatformPermissionMiddleware(
    permission,
    { enabled: publicPlatformEnabled },
  );
  const requireBillingManager = requirePlatformPermission(PERMISSIONS.BILLING_MANAGE);
  const requireRedeemCodeManager = requirePlatformPermission(PERMISSIONS.REDEEM_CODES_MANAGE);
  const authRateLimit = createRateLimitMiddleware(db, {
    enabled: publicPlatformEnabled,
    scope: 'auth',
    limit: 10,
    windowMs: 15 * 60 * 1000,
  });
  const generationRateLimit = createRateLimitMiddleware(db, {
    enabled: publicPlatformEnabled,
    scope: 'generation',
    limit: 20,
    windowMs: 60 * 1000,
  });
  const modelGenerationGuard = createModelGenerationGuard(generationRateLimit);
  const { createUserAuthMiddleware } = require('../middleware/userAuth');
  const { createResourceOwnershipMiddleware } = require('../middleware/resourceOwnership');
  const { createTenantContextMiddleware } = require('../middleware/tenantContext');
  const requireUser = createUserAuthMiddleware({
    enabled: publicPlatformEnabled,
    secret: process.env.PLATFORM_JWT_SECRET,
    db,
  });
  const voiceCatalog = voiceCatalogRoutes(db, cfg, log);

  r.post('/auth/register/code', authRateLimit, auth.requestRegistrationCode);
  r.post('/auth/register', authRateLimit, auth.register);
  r.post('/auth/login', authRateLimit, auth.login);
  r.post('/auth/logout', auth.logout);
  r.post('/auth/password/code', authRateLimit, auth.requestPasswordResetCode);
  r.post('/auth/password/reset', authRateLimit, auth.resetPassword);
  // 试听只暴露已生成的固定目录音频，不依赖项目静态资源权限，也不接受任意路径。
  r.get('/voice-catalog/:id/preview', voiceCatalog.preview);
  r.use(requireUser);
  // 租户列表必须能在浏览器残留了已删除/无权租户 ID 时用于恢复，因此不依赖当前租户上下文。
  r.post('/auth/bootstrap-admin', requireBootstrapAdminToken, auth.bootstrapAdmin);
  r.post('/auth/password/change', authRateLimit, auth.changePassword);
  r.get('/auth/me', auth.me);
  r.get('/tenants', tenants.list);
  r.post('/tenants', tenants.create);
  r.get('/tenants/:tenantId/members', tenants.listMembers);
  r.post('/tenants/:tenantId/members', tenants.addMember);
  r.patch('/tenants/:tenantId/members/:userId/role', tenants.changeMemberRole);
  r.delete('/tenants/:tenantId/members/:userId', tenants.removeMember);
  r.get('/platform-admin/users', requirePlatformPermission(PERMISSIONS.USERS_READ), platformAccounts.listUsers);
  r.patch('/platform-admin/users/:userId/role', requirePlatformPermission(PERMISSIONS.USERS_ROLE), platformAccounts.changeRole);
  r.patch('/platform-admin/users/:userId/status', requirePlatformPermission(PERMISSIONS.USERS_STATUS), platformAccounts.changeStatus);
  r.post('/platform-admin/users/:userId/force-logout', requirePlatformPermission(PERMISSIONS.USERS_FORCE_LOGOUT), platformAccounts.forceLogout);
  // 平台管理接口不依赖当前租户，避免管理员因浏览器残留了无效租户 ID 而无法进入后台。
  r.get('/billing/admin/users', requireAdmin, requireBillingManager, requirePlatformPermission(PERMISSIONS.USERS_READ), billing.listAdminUsers);
  r.put('/billing/admin/users/:userId', requireAdmin, requireBillingManager, requirePlatformPermission(PERMISSIONS.USERS_ROLE), billing.updateAdminUser);
  r.get('/billing/admin/tenants', requireAdmin, requireBillingManager, billing.listAdminTenants);
  r.post('/billing/admin/tenants/:tenantId/credits', requireAdmin, requireBillingManager, billing.adjustAdminTenantCredits);
  r.get('/billing/admin/credit-transactions', requireAdmin, requireBillingManager, billing.listAdminCreditTransactions);
  r.get('/billing/admin/ledger/settings', requireAdmin, requireBillingManager, billing.getLedgerSettings);
  r.put('/billing/admin/ledger/settings', requireAdmin, requireBillingManager, billing.updateLedgerSettings);
  r.get('/billing/admin/ledger/report', requireAdmin, requireBillingManager, billing.getLedgerReport);
  r.get('/billing/admin/reconciliation/anomalies', requireAdmin, requireBillingManager, billing.listReconciliationAnomalies);
  r.get('/billing/admin/reconciliation/history', requireAdmin, requireBillingManager, billing.listReconciliationHistory);
  r.post('/billing/admin/reconciliation/:reservationId/refund', requireAdmin, requireBillingManager, billing.refundReconciliationReservation);
  r.get('/billing/admin/redeem-codes', requireRedeemCodeManager, billing.listAdminRedeemCodes);
  r.post('/billing/admin/redeem-codes', requireRedeemCodeManager, billing.createAdminRedeemCode);
  r.post('/billing/admin/redeem-codes/batch', requireRedeemCodeManager, billing.createAdminRedeemCodes);
  r.get('/billing/admin/redeem-codes/:codeId/usages', requireRedeemCodeManager, billing.listAdminRedeemCodeUsages);
  r.put('/billing/admin/redeem-codes/:codeId', requireRedeemCodeManager, billing.updateAdminRedeemCode);
  r.get('/billing/admin/plans', requireAdmin, requireBillingManager, billing.listAdminPlans);
  r.put('/billing/plans/:planId', requireAdmin, requireBillingManager, billing.upsertPlan);
  r.get('/billing/prices', requireAdmin, requireBillingManager, billing.listPrices);
  r.put('/billing/prices/:model', requireAdmin, requireBillingManager, billing.updatePrice);
  r.use(createTenantContextMiddleware({ db, enabled: publicPlatformEnabled }));
  // 公开平台只允许访问当前用户拥有的工程及其派生资源；本地单用户模式保持原有行为。
  r.use(createResourceOwnershipMiddleware({ db, enabled: publicPlatformEnabled }));
  r.use(modelGenerationGuard);
  r.get('/billing/account', billing.getAccount);
  r.get('/billing/catalog', billing.listPublicCatalog);
  r.get('/billing/audit-events', billing.listAuditEvents);
  r.post('/billing/redeem', billing.redeemCredits);
  r.get('/billing/credit-transactions', billing.listCreditTransactions);
  r.get('/billing/plans', billing.listPlans);
  r.get('/billing/subscription', billing.getSubscription);
  r.get('/billing/orders', billing.listOrders);
  r.post('/billing/orders', billing.createOrder);
  r.delete('/billing/orders/:orderId', billing.cancelOrder);
  r.get('/video-models', aiConfig.listPublicVideoModels);
  r.get('/image-models', aiConfig.listPublicImageModels);
  r.get('/canvas/model-catalog', (req, res) => {
    const catalog = require('../services/canvasModelCatalogService').list(db);
    response.success(res, catalog);
  });
  r.get('/audio-models', aiConfig.listPublicAudioModels);
  
  const uploadService = require('../services/uploadService');
  const charLibrary = characterLibraryRoutes(db, cfg, log);
  const sceneLibrary = sceneLibraryRoutes(db, cfg, log);
  const propLibrary = propLibraryRoutes(db, cfg, log);
  const characters = characterRoutes(db, cfg, log, uploadService, { billingEnabled: publicPlatformEnabled });
  const uploadHandlers = uploadModule.routes(cfg, log, db, { publicPlatformEnabled });
  const scenes = sceneRoutes(db, log, cfg, { billingEnabled: publicPlatformEnabled });
  const storyboards = storyboardRoutes(db, log, { billingEnabled: publicPlatformEnabled });
  const tailFrameLink = tailFrameLinkRoutes(db, cfg, log);
  const images = imageRoutes(db, cfg, log, { billingEnabled: publicPlatformEnabled });
  const videos = videoRoutes(db, log, { billingEnabled: publicPlatformEnabled });
  const videoMerges = videoMergeRoutes(db, log);
  const assets = assetRoutes(db, log, { publicPlatformEnabled });
  const imageTools = imageToolRoutes(db, log, {
    publicPlatformEnabled,
    cfg,
    backgroundOperations: true,
  });
  const audio = audioRoutes(db, log, cfg, { billingEnabled: publicPlatformEnabled });
  const canvasText = canvasTextRoutes(db, log, { billingEnabled: publicPlatformEnabled });
  const promptOverrides = promptOverridesRoutes.routes(db, log);
  const directorExport = directorExportRoutes(db, cfg, log);
  const directorReference = directorReferenceRoutes(db, log, { billingEnabled: publicPlatformEnabled });
  const scriptAnalysis = scriptAnalysisRoutes(db, log);
  r.get('/voice-catalog', voiceCatalog.list);

  // ---------- script analysis ----------
  r.get('/script-analysis/skills', scriptAnalysis.skills);
  r.get('/script-analysis/projects', scriptAnalysis.list);
  r.post('/script-analysis/projects', scriptAnalysis.create);
  r.get('/script-analysis/projects/:id', scriptAnalysis.get);
  r.get('/script-analysis/projects/:id/versions', scriptAnalysis.versions);
  r.put('/script-analysis/projects/:id', scriptAnalysis.update);
  r.post('/script-analysis/projects/:id/revisions', scriptAnalysis.revise);
  r.post('/script-analysis/projects/:id/review', scriptAnalysis.review);
  r.post('/script-analysis/projects/:id/run', scriptAnalysis.run);
  r.post('/script-analysis/projects/:id/import-to-factory', scriptAnalysis.importToFactory);

  // ---------- dramas ----------
  r.get('/dramas', drama.listDramas);
  r.post('/dramas', drama.createDrama);
  r.get('/project-folders', drama.listProjectFolders);
  r.post('/project-folders', drama.createProjectFolder);
  r.put('/project-folders/:folderId', drama.renameProjectFolder);
  r.delete('/project-folders/:folderId', drama.deleteProjectFolder);
  r.get('/dramas/stats', drama.getDramaStats);
  // 导出/导入（放在 :id 路由前，避免被 :id 捕获）
  r.get('/dramas/:id/export', drama.exportDrama);
  r.post('/dramas/:id/duplicate', drama.duplicateDrama);
  const multer = require('multer');
  const importUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 * 1024 } });
  r.post('/dramas/import', importUpload.single('file'), drama.importDrama);
  r.post('/dramas/import-novel', importUpload.single('file'), async (req, res) => {
    try {
      const novelImportService = require('../services/novelImportService');
      let text = '';
      if (req.file && req.file.buffer) {
        text = req.file.buffer.toString('utf8');
      } else if (req.body && req.body.text) {
        text = req.body.text;
      }
      if (!text.trim()) return response.badRequest(res, '请上传小说文本文件或提供 text 参数');
      const title = req.body?.title || '';
      const maxChapters = Number(req.body?.max_chapters) || 20;
      const aiSummarize = req.body?.ai_summarize === 'true' || req.body?.ai_summarize === true;
      const result = await novelImportService.importNovel(db, log, {
        text,
        title,
        maxChapters,
        aiSummarize,
        model: req.body?.model,
        billingEnabled: publicPlatformEnabled,
        tenantId: req.tenant?.id,
        userId: req.user?.id,
      });
      response.success(res, result);
    } catch (err) {
      log.error('dramas import-novel', { error: err.message });
      if (textGenerationBilling.respondError(response, res, err)) return;
      response.internalError(res, err.message);
    }
  });
  r.post('/dramas/:id/director/export', directorExport.upload, directorExport.create);
  r.post('/dramas/:id/director/reference-analysis', directorReference.analyze);
  r.get('/dramas/examples', drama.listExamples);
  r.post('/dramas/import-example', drama.importExample);
  r.put('/dramas/:id/outline', drama.saveOutline);
  r.get('/dramas/:id/characters', drama.getCharacters);
  r.put('/dramas/:id/characters', drama.saveCharacters);
  r.put('/dramas/:id/episodes', drama.saveEpisodes);
  r.put('/dramas/:id/progress', drama.saveProgress);
  r.put('/dramas/:id/canvas-layout', drama.saveCanvasLayout);
  r.get('/dramas/:id/props', drama.listProps);
  r.get('/dramas/:id', drama.getDrama);
  r.put('/dramas/:id', drama.updateDrama);
  r.delete('/dramas/:id', drama.deleteDrama);

  // ---------- ai-configs ----------
  r.use('/ai-configs', requireBillingManager);
  r.get('/ai-configs', aiConfig.list);
  r.post('/ai-configs', aiConfig.create);
  r.post('/ai-configs/test', aiConfig.testConnection);
  r.post('/ai-configs/jimeng2-list-assets', aiConfig.listJimeng2MaterialAssets);
  r.post('/ai-configs/model-ark-asset', aiConfig.modelArkAsset);
  r.get('/ai-configs/vendor-lock', aiConfig.vendorLock);  // 必须在 /:id 之前
  r.put('/ai-configs/bulk-update-key', aiConfig.bulkUpdateKey);  // 必须在 /:id 之前
  r.get('/ai-configs/:id', aiConfig.get);
  r.put('/ai-configs/:id', aiConfig.update);
  r.delete('/ai-configs/:id', aiConfig.delete);

  // ---------- generation (角色生成：AI + 入库 + 任务结果) ----------
  r.post('/generation/characters', (req, res) => {
    const characterGenerationService = require('../services/characterGenerationService');
    try {
      const body = req.body || {};
      if (!body.drama_id) {
        return response.badRequest(res, 'drama_id 必填');
      }
      const taskId = characterGenerationService.generateCharacters(db, cfg, log, body, {
        billingEnabled: publicPlatformEnabled,
        tenantId: req.tenant?.id,
        userId: req.user?.id,
      });
      response.success(res, { task_id: taskId, status: 'pending' });
    } catch (err) {
      log.error('generation/characters', { error: err.message });
      if (textGenerationBilling.respondError(response, res, err)) return;
      response.internalError(res, err.message || '创建任务失败');
    }
  });

  // 故事生成：带 drama_id 时异步生成并入库；否则同步返回 episodes（兼容旧调用）
  r.post('/generation/story', async (req, res) => {
    const storyGenerationService = require('../services/storyGenerationService');
    try {
      const body = req.body || {};
      if (body.drama_id) {
        const taskId = storyGenerationService.startStoryGeneration(db, log, body, {
          billingEnabled: publicPlatformEnabled,
          userId: req.user?.id,
          tenantId: req.tenant?.id,
        });
        return response.success(res, { task_id: taskId, status: 'pending' });
      }
      const result = await storyGenerationService.generateStory(db, log, publicPlatformEnabled
        ? { ...body, billingEnabled: true, userId: req.user?.id, tenantId: req.tenant?.id }
        : body);
      response.success(res, result);
    } catch (err) {
      log.error('generation/story', { error: err.message });
      if (['MODEL_PRICE_NOT_CONFIGURED', 'MODEL_DISABLED'].includes(err.code)) {
        return response.error(res, 503, err.code, err.message);
      }
      if (err.code === 'INSUFFICIENT_CREDITS') return response.error(res, 402, err.code, '积分不足，请充值后重试');
      if (err.code === 'UNSUPPORTED_BILLING_MODEL') return response.badRequest(res, err.message);
      if (err.message && (err.message.includes('未配置') || err.message.includes('必填') || err.message.includes('不存在'))) {
        return response.badRequest(res, err.message);
      }
      response.internalError(res, err.message || '故事生成失败');
    }
  });

  // ---------- character-library ----------
  r.get('/character-library', charLibrary.list);
  r.post('/character-library', charLibrary.create);
  r.get('/character-library/:id', charLibrary.get);
  r.put('/character-library/:id', charLibrary.update);
  r.delete('/character-library/:id', charLibrary.delete);

  // ---------- scene-library ----------
  r.get('/scene-library', sceneLibrary.list);
  r.post('/scene-library', sceneLibrary.create);
  r.get('/scene-library/:id', sceneLibrary.get);
  r.put('/scene-library/:id', sceneLibrary.update);
  r.delete('/scene-library/:id', sceneLibrary.delete);

  // ---------- prop-library ----------
  r.get('/prop-library', propLibrary.list);
  r.post('/prop-library', propLibrary.create);
  r.get('/prop-library/:id', propLibrary.get);
  r.put('/prop-library/:id', propLibrary.update);
  r.delete('/prop-library/:id', propLibrary.delete);

  // ---------- characters ----------
  r.get('/characters/:id', characters.getOne);
  r.put('/characters/:id', characters.update);
  r.delete('/characters/:id', characters.delete);
  r.post('/characters/batch-generate-images', characters.batchGenerateImages);
  r.post('/characters/:id/generate-image', characters.generateImage);
  r.post('/characters/:id/generate-four-view-image', characters.generateFourViewImage);
  r.post('/characters/:id/generate-prompt', characters.generatePrompt);
  r.post('/characters/:id/upload-image', uploadModule.multerSingle, characters.uploadImage);
  r.put('/characters/:id/image', characters.putImage);
  r.put('/characters/:id/image-from-library', characters.imageFromLibrary);
  r.post('/characters/:id/add-to-library', characters.addToLibrary);
  r.post('/characters/:id/add-to-material-library', characters.addToMaterialLibrary);
  r.post('/characters/:id/sd2-certify', characters.sd2Certify);
  r.post('/characters/:id/sd2-certify/refresh', characters.sd2CertifyRefresh);
  r.post('/characters/:id/sd2-voice-upload', uploadModule.multerAudioSingle, characters.sd2VoiceUpload);
  r.post('/characters/:id/sd2-voice-refresh', characters.sd2VoiceRefresh);
  r.post('/characters/:id/sd2-voice-catalog', voiceCatalog.bind);
  r.post('/characters/:id/extract-from-image', characters.extractFromImage);
  r.post('/characters/:id/extract-anchors', characters.extractAnchors);

  // ---------- props ----------
  r.get('/props/:id', prop.getPropById);
  r.post('/props', prop.createProp);
  r.put('/props/:id', prop.updateProp);
  r.delete('/props/:id', prop.deleteProp);
  r.post('/props/:id/generate', prop.generateImage);
  r.post('/props/:id/generate-prompt', prop.generatePropPrompt);
  r.post('/props/:id/add-to-library', prop.addToLibrary);
  r.post('/props/:id/add-to-material-library', prop.addToMaterialLibrary);
  r.post('/props/:id/extract-from-image', prop.extractPropFromImage);

  // ---------- vision: 从图片提取描述（不依赖已有实体 ID）----------
  r.post('/extract-description-from-image', async (req, res) => {
    const { image_url, entity_type, entity_name, model } = req.body || {};
    if (!image_url) return response.badRequest(res, '缺少 image_url');
    if (!['character', 'scene', 'prop'].includes(entity_type)) return response.badRequest(res, 'entity_type 需为 character/scene/prop');
    let billing = null;
    try {
      billing = textGenerationBilling.begin(db, {
        enabled: publicPlatformEnabled,
        tenantId: req.tenant?.id,
        userId: req.user?.id,
        requestedModel: model || undefined,
        resourceType: 'vision_description',
        resourceId: `${entity_type}:${entity_name || 'unnamed'}`,
        operation: 'vision_description',
      });
      const { extractDescriptionFromImage } = require('../services/aiClient');
      const out = await extractDescriptionFromImage(
        db, log, entity_type, image_url, entity_name, billing.model,
      );
      if (!out.ok) {
        textGenerationBilling.settle(db, log, billing, 'failed', out.error);
        return response.badRequest(res, out.error);
      }
      textGenerationBilling.settle(db, log, billing, 'completed');
      response.success(res, { description: out.description });
    } catch (err) {
      log.error('extract-description-from-image', { error: err.message });
      textGenerationBilling.settle(db, log, billing, 'failed', err.message);
      if (textGenerationBilling.respondError(response, res, err)) return;
      response.internalError(res, err.message);
    }
  });

  // ---------- upload ----------
  r.post('/upload/image', uploadModule.multerSingle, uploadHandlers.uploadImage);
  r.post('/upload/model', uploadHandlers.multerModelSingle, uploadHandlers.uploadModel);
  r.post('/upload/media', uploadHandlers.multerMediaSingle, uploadHandlers.uploadMedia);

  // ---------- episodes ----------
  // 注意：drama.generateStoryboard 已处理所有逻辑（包括参数解析），这里统一使用 drama 模块的实现
  // 之前可能有部分路由指向了 storyboards.episodeStoryboardsGenerate，这可能导致参数解析不一致
  r.post('/episodes/:episode_id/storyboards', drama.generateStoryboard);
  r.post('/episodes/:episode_id/props/extract', prop.extractProps);
  r.post('/episodes/:episode_id/characters/extract', stub.episodeCharactersExtract);
  r.get('/episodes/:episode_id/storyboards', storyboards.episodeStoryboardsGet);
  r.post('/episodes/:episode_id/finalize', drama.finalizeEpisode);
  r.get('/episodes/:episode_id/download', drama.downloadEpisodeVideo);

  // ---------- tasks ----------
  r.get('/tasks/:task_id', task.getTaskStatus);
  r.post('/tasks/:task_id/cancel', task.cancelTaskStatus);
  r.get('/tasks', task.getResourceTasks);

  // ---------- scenes ----------
  r.get('/scenes/:scene_id', scenes.getOne);
  r.post('/scenes/:scene_id/generate-prompt', scenes.generatePrompt);
  r.put('/scenes/:scene_id', scenes.update);
  r.put('/scenes/:scene_id/prompt', scenes.updatePrompt);
  r.delete('/scenes/:scene_id', scenes.delete);
  r.post('/scenes/generate-image', scenes.generateImage);
  r.post('/scenes', scenes.create);
  r.post('/scenes/:scene_id/generate-four-view-image', scenes.generateFourViewImage);
  r.post('/scenes/:scene_id/generate-panorama-image', scenes.generatePanoramaImage);
  r.post('/scenes/:scene_id/add-to-library', scenes.addToLibrary);
  r.post('/scenes/:scene_id/add-to-material-library', scenes.addToMaterialLibrary);
  r.post('/scenes/:scene_id/extract-from-image', scenes.extractFromImage);

  // ---------- images ----------
  r.get('/images', images.list);
  r.get('/images/episode/:episode_id/backgrounds', images.episodeBackgrounds);
  r.post('/images', images.create);
  r.post('/images/episode/:episode_id/backgrounds/extract', images.episodeBackgroundsExtract);
  r.post('/images/episode/:episode_id/batch', images.episodeBatch);
  r.post('/images/scene/:scene_id', images.scene);
  r.post('/images/upload', images.upload);
  r.get('/images/:id', images.get);
  r.delete('/images/:id', images.delete);

  // ---------- videos ----------
  r.get('/videos', videos.list);
  r.post('/videos/image/:image_gen_id', videos.fromImage);
  r.post('/videos', videos.create);
  r.post('/videos/attach', videos.attach);
  r.post('/videos/extract-boundary-frames', videos.extractBoundaryFrames);
  r.post('/videos/episode/:episode_id/batch', videos.episodeBatch);
  r.get('/videos/:id', videos.get);
  r.delete('/videos/:id', videos.delete);

  // ---------- video-merges ----------
  r.get('/video-merges', videoMerges.list);
  r.post('/video-merges', videoMerges.create);
  r.get('/video-merges/:merge_id', videoMerges.get);
  r.delete('/video-merges/:merge_id', videoMerges.delete);

  // ---------- assets ----------
  r.get('/assets', assets.list);
  r.post('/assets', assets.create);
  r.post('/assets/import/image/:image_gen_id', assets.importImage);
  r.post('/assets/import/video/:video_gen_id', assets.importVideo);
  r.get('/assets/:id', assets.get);
  r.put('/assets/:id', assets.update);
  r.delete('/assets/:id', assets.delete);
  r.get('/image-tools/capabilities', imageTools.capabilities);
  r.post('/image-tools/operations', imageTools.createOperation);
  r.get('/image-tools/operations/:taskId', imageTools.getOperation);

  // ---------- storyboards ----------
  r.get('/storyboards/episode/:episode_id/generate', storyboards.episodeStoryboardsGenerate);
  r.post('/storyboards', storyboards.create);
  r.post('/storyboards/:id/insert-before', storyboards.insertBefore);
  r.get('/storyboards/:id', storyboards.getOne);
  r.put('/storyboards/:id', storyboards.update);
  r.delete('/storyboards/:id', storyboards.delete);
  r.post('/storyboards/:id/props', prop.associateProps);
  r.post('/storyboards/:id/frame-prompt', storyboards.framePrompt);
  r.get('/storyboards/:id/frame-prompts', storyboards.framePromptsGet);
  r.put('/storyboards/:id/frame-prompts/:frame_type', storyboards.framePromptSave);
  r.post('/storyboards/:id/link-tail-frame', tailFrameLink.linkTailFrame);
  r.post('/storyboards/:id/polish-prompt', storyboards.polishPrompt);
  r.post('/storyboards/:id/universal-segment-polish-stream', storyboards.polishUniversalSegmentStream);
  r.post('/storyboards/:id/classic-video-prompt-polish-stream', storyboards.polishClassicVideoPromptStream);
  r.post('/storyboards/:id/universal-segment-prompt-stream', storyboards.generateUniversalSegmentStream);
  r.post('/storyboards/:id/universal-segment-prompt', storyboards.generateUniversalSegmentPrompt);
  r.post('/storyboards/batch-infer-params', storyboards.batchInferParams);
  r.post('/storyboards/:id/upscale', storyboards.upscale);
  r.post('/storyboards/:id/extract-voice', storyboards.extractVoice);
  r.post('/storyboards/:id/regenerate-layout-description', storyboards.regenerateLayoutDescription);
  r.post('/storyboards/:id/rebuild-video-prompt', storyboards.rebuildVideoPrompt);
  r.post('/storyboards/:id/split-by-audio', storyboards.splitByAudio);

  // ---------- audio ----------
  r.post('/audio/extract', audio.extract);
  r.post('/audio/extract/batch', audio.extractBatch);
  r.post('/canvas/text/generate', canvasText.generate);

  // ---------- settings ----------
  r.get('/settings/language', settings.getLanguage);
  r.put('/settings/language', settings.updateLanguage);
  r.get('/settings/generation', settings.getGenerationSettings);
  r.put('/settings/generation', settings.updateGenerationSettings);

  // ---------- prompt overrides ----------
  r.get('/settings/prompts', promptOverrides.list);
  r.put('/settings/prompts/:key', promptOverrides.update);
  r.delete('/settings/prompts/:key', promptOverrides.reset);

  // ---------- scene model map ----------
  r.get('/scene-model-map', sceneModelMap.list);
  r.post('/scene-model-map', sceneModelMap.create);
  r.get('/scene-model-map/:key', sceneModelMap.get);
  r.put('/scene-model-map/:key', sceneModelMap.update);
  r.delete('/scene-model-map/:key', sceneModelMap.delete);

  // 启动时将已有的覆盖加载到 promptI18n 内存缓存
  try {
    const promptI18n = require('../services/promptI18n');
    const promptOverridesService = require('../services/promptOverridesService');
    const saved = promptOverridesService.listOverrides(db);
    promptI18n.loadOverridesIntoCache(saved);
  } catch (e) {
    console.warn('Failed to load prompt overrides:', e.message);
  }

  return r;
}

module.exports = { setupRouter };
