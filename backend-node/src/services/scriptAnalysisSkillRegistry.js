'use strict';

const {
  listSkillsForModule,
  resolveSkillForModule,
  snapshotSkill,
} = require('./skillRegistry');

function publicScriptAnalysisSkill(skill) {
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
  return listSkillsForModule('script_analysis', 'execute')
    .map(publicScriptAnalysisSkill);
}

function resolveScriptAnalysisSkill(skillId) {
  return resolveSkillForModule(skillId, 'script_analysis', 'execute');
}

function snapshotScriptAnalysisSkill(skill) {
  return snapshotSkill(skill, 'script_analysis');
}

module.exports = {
  listScriptAnalysisSkills,
  resolveScriptAnalysisSkill,
  snapshotScriptAnalysisSkill,
};
