'use strict';

const BUILT_IN_SKILLS = Object.freeze([
  Object.freeze({
    id: 'short-drama-director',
    name: '专业短剧导演',
    version: '1.0.0',
    description: '从原始剧本生成角色、场景、道具和分镜生产包',
    module: 'script_analysis',
    output_schema_version: '1.0',
    is_default: true,
    enabled: true,
    system_prompt: `你是一名专业短剧导演与制片工作流总监。你的任务是把用户原始剧本整理成可直接进入图片、视频和画布制作环节的结构化生产包。

必须遵守：
1. 只输出一个合法 JSON 对象，不输出 Markdown 或解释。
2. 不得修改 source_script 和 locked_facts 中的事实；所有新增、推断或改写必须记录在 ai_changes。
3. 每个镜头必须包含 source_basis，说明它来自原剧本的哪些句子或事实。
4. 不得擅自增加人物关系、关键事件或结局。
5. 图片提示词负责静态画面，视频提示词负责动作、运镜、时长、声音与连续性。
6. 若信息不足，在 review.issues 中提出问题，不要伪造细节。
7. 输出必须符合用户给出的 schema_version 1.0 契约。`,
  }),
]);

function publicSkill(skill) {
  return {
    id: skill.id,
    name: skill.name,
    version: skill.version,
    description: skill.description,
    module: skill.module,
    output_schema_version: skill.output_schema_version,
    is_default: skill.is_default,
  };
}

function listScriptAnalysisSkills() {
  return BUILT_IN_SKILLS
    .filter((skill) => skill.enabled && skill.module === 'script_analysis')
    .map(publicSkill);
}

function resolveScriptAnalysisSkill(skillId) {
  if (!skillId) {
    return BUILT_IN_SKILLS.find(
      (skill) => skill.enabled && skill.module === 'script_analysis' && skill.is_default,
    ) || null;
  }
  return BUILT_IN_SKILLS.find(
    (skill) => skill.enabled && skill.module === 'script_analysis' && skill.id === skillId,
  ) || null;
}

function snapshotScriptAnalysisSkill(skill) {
  return {
    id: skill.id,
    name: skill.name,
    version: skill.version,
    module: skill.module,
    output_schema_version: skill.output_schema_version,
  };
}

module.exports = {
  listScriptAnalysisSkills,
  resolveScriptAnalysisSkill,
  snapshotScriptAnalysisSkill,
};
