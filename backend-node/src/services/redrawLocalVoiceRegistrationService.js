function registerLocalProductionVoice() {
  const error = new Error('REDRAW_LOCAL_TTS_NOT_READY');
  error.code = 'REDRAW_LOCAL_TTS_NOT_READY';
  throw error;
}

module.exports = {
  registerLocalProductionVoice,
};
