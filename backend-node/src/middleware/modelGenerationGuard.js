const MODEL_GENERATION_ROUTES = [
  ['POST', /^\/generation\/(?:characters|story)$/],
  ['POST', /^\/characters\/(?:batch-generate-images|\d+\/(?:generate-image|generate-four-view-image|generate-prompt|extract-from-image|extract-anchors|sd2-certify(?:\/refresh)?|sd2-voice-(?:upload|refresh)))$/],
  ['POST', /^\/props\/\d+\/(?:generate|generate-prompt|extract-from-image)$/],
  ['POST', /^\/extract-description-from-image$/],
  ['POST', /^\/episodes\/\d+\/(?:storyboards|props\/extract|characters\/extract)$/],
  ['POST', /^\/scenes\/(?:generate-image|\d+\/(?:generate-prompt|generate-four-view-image|generate-panorama-image|extract-from-image))$/],
  ['POST', /^\/images(?:$|\/episode\/\d+\/(?:backgrounds\/extract|batch)$|\/scene\/\d+$)/],
  ['POST', /^\/image-tools\/operations$/],
  ['POST', /^\/videos(?:$|\/image\/\d+$|\/episode\/\d+\/batch$)/],
  ['GET', /^\/storyboards\/episode\/\d+\/generate$/],
  ['POST', /^\/storyboards\/(?:batch-infer-params|\d+\/(?:frame-prompt|polish-prompt|universal-segment-polish-stream|classic-video-prompt-polish-stream|universal-segment-prompt-stream|universal-segment-prompt|upscale|regenerate-layout-description|rebuild-video-prompt))$/],
];

function isModelGenerationRequest(req = {}) {
  const method = String(req.method || '').toUpperCase();
  const path = String(req.path || '');
  return MODEL_GENERATION_ROUTES.some(([expectedMethod, pattern]) => method === expectedMethod && pattern.test(path));
}

function createModelGenerationGuard(rateLimit) {
  if (typeof rateLimit !== 'function') throw new Error('generation rate limiter is required');
  return (req, res, next) => {
    if (isModelGenerationRequest(req)) return rateLimit(req, res, next);
    return next();
  };
}

module.exports = { createModelGenerationGuard, isModelGenerationRequest };
