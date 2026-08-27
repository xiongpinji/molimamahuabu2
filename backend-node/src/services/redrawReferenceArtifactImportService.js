const INPUT_INVALID_CODE = 'REDRAW_REFERENCE_ARTIFACT_INPUT_INVALID';

function inputInvalidError() {
  return Object.assign(new Error('参考素材导入参数无效'), { code: INPUT_INVALID_CODE });
}

async function importCharacterReferenceArtifact() {
  throw inputInvalidError();
}

async function importMotionReferenceArtifact() {
  throw inputInvalidError();
}

async function bindReadyMotionReference() {
  throw inputInvalidError();
}

module.exports = {
  importCharacterReferenceArtifact,
  importMotionReferenceArtifact,
  bindReadyMotionReference,
};
