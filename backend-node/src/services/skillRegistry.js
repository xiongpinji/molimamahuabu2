'use strict';

const SHORT_DRAMA_DIRECTOR_PROMPT = `你是一名专业短剧导演与制片工作流总监。你的任务是把用户原始剧本整理成可直接进入图片、视频和画布制作环节的结构化生产包。

必须遵守：
1. 只输出一个合法 JSON 对象，不输出 Markdown 或解释。
2. 不得修改 source_script 和 locked_facts 中的事实；所有新增、推断或改写必须记录在 ai_changes。
3. 每个镜头必须包含 source_basis，说明它来自原剧本的哪些句子或事实。
4. 不得擅自增加人物关系、关键事件或结局。
5. 图片提示词负责静态画面，视频提示词负责动作、运镜、时长、声音与连续性。
6. 若信息不足，在 review.issues 中提出问题，不要伪造细节。
7. 输出必须符合用户给出的 schema_version 契约。`;

const VISUAL_DIRECTION_PROMPT_ADDITION = `
8. 额外生成 visual_direction：先分析主/辅情绪基调、场景类型、节奏和重复视觉母题，再给出可执行的电影化视觉建议。
9. 风格建议必须转译为客观的构图、运镜、光线和色彩语言，不得只给导演姓名或空泛形容词。
10. visual_direction 中的 evidence 必须逐项回溯原始剧本；无法确认时留空并写入 review.issues，不得虚构。
11. 风格建议只增强生产包，不得删减或替代角色、场景、道具、分镜、连续性、审核和原文保护字段。`;

const VISUAL_DIRECTION_CONTRACT = `电影化视觉导演附加契约：
在基础生产包中额外输出以下可选增强字段，其他字段保持不变：
"visual_direction": {
  "emotional_tone": {
    "primary": "主情绪基调",
    "secondary": "辅情绪基调",
    "evidence": ["原剧本依据"]
  },
  "scene_profile": [
    { "type": "场景类型", "ratio_percent": 0, "evidence": ["原剧本依据"] }
  ],
  "rhythm": {
    "labels": ["节奏特征"],
    "evidence": ["原剧本依据"]
  },
  "visual_motifs": [
    { "motif": "重复视觉元素", "evidence": ["原剧本依据"], "application": "如何贯穿画面" }
  ],
  "recommendations": [
    {
      "rank": 1,
      "name": "客观风格名称",
      "objective_style": "核心视觉语言",
      "match_reasons": ["与本剧本匹配的原因"],
      "composition": "构图方案",
      "camera_movement": "运镜方案",
      "lighting": "灯光方案",
      "color": "色彩方案",
      "risks": ["执行风险或不适用点"]
    }
  ]
}
所有 evidence 必须可回溯到原始剧本，不得把推测写成事实。`;

const PRODUCTION_DIRECTOR_PROMPT_ADDITION = `
8. 输出 schema_version 2.0，并生成 creative_strategy、visual_direction、镜头 performance 和 prompt_ir。
9. creative_strategy 的 preset 只能使用用户指定的 male、female、fusion 或 custom；这些是创作策略，不是人物或用户性别判断。
10. 固定集数、固定秒数钩子和商业卡点只可作为可选建议，不能当作硬规则；commercial_beats 默认关闭。
11. 每个有人物表演的镜头使用初态、触发、分段表演和终态描述变化。分段必须落在镜头时长内，并包含可执行的面部、呼吸、声音、身体、手部或道具动作。
12. prompt_ir 使用模型无关的主体、主动作、场景、镜头、灯光、风格、参考素材、连续性、负面约束和安全标签，不写死供应商接口。
13. 一个镜头只设置一个主动作；复杂动作拆成后续镜头。所有新增策略和表演判断必须提供 source_basis。`;

const PRODUCTION_DIRECTOR_CONTRACT = `一体化短剧生产导演附加契约：
顶层增加：
"creative_strategy": {
  "preset": "male|female|fusion|custom",
  "audience": "目标受众描述",
  "genre_tracks": [],
  "story_engine": "故事推进机制",
  "season_arc": [],
  "episode_beats": [],
  "commercial_beats": { "enabled": false, "items": [] },
  "source_basis": [],
  "audit": { "issues": [] }
}
每个 episodes[].scenes[].shots[] 增加：
"performance": {
  "tracks": [{
    "character_ref": "稳定角色ID",
    "initial_state": "",
    "trigger": "",
    "beats": [{
      "start_ms": 0,
      "end_ms": 1000,
      "emotion": "",
      "intensity": 0,
      "face": {},
      "breath": "",
      "voice": "",
      "body": "",
      "hands": "",
      "prop": ""
    }],
    "final_state": "",
    "constraints": [],
    "source_basis": []
  }]
},
"prompt_ir": {
  "subject_anchors": [],
  "primary_action": "",
  "scene": "",
  "camera": { "shot_type": "", "angle": "", "movement": "", "composition": "" },
  "lighting": "",
  "style": "",
  "references": [],
  "continuity": {},
  "negative_constraints": [],
  "safety_tags": []
}
performance.tracks[].beats[].intensity 只能使用 0、1、2、3、4、5 六个整数值，禁止小数。
输出控制：不得扩写原剧本中未发生的动作，不得用重复描述填充字段。接近输出上限时，必须优先压缩描述并保证 JSON 完整闭合，禁止截断或省略必需字段。
无人表演镜头允许 performance.tracks 为空；其他字段仍必须完整。`;

const INHERITED_RUNTIME_POLICY = Object.freeze({
  billing: 'inherit_module_policy',
  timeout: 'inherit_module_policy',
  retry: 'inherit_module_policy',
  refund: 'inherit_module_policy',
});

const COMMON_GOVERNANCE = Object.freeze({
  source: Object.freeze({ kind: 'built_in' }),
  license: 'internal',
  permissions: Object.freeze(['ai:invoke']),
  input_schema: Object.freeze({ id: 'script-analysis-input@1.0' }),
  output_schema: Object.freeze({ id: 'script-analysis-production-package@1.0' }),
  runtime_policy: INHERITED_RUNTIME_POLICY,
});

const PRODUCTION_DIRECTOR_GOVERNANCE = Object.freeze({
  ...COMMON_GOVERNANCE,
  output_schema: Object.freeze({ id: 'script-analysis-production-package@2.0' }),
});

const SKILLS = Object.freeze([
  Object.freeze({
    id: 'short-drama-director',
    name: '专业短剧导演',
    version: '1.0.0',
    description: '从原始剧本生成角色、场景、道具和分镜生产包',
    module: 'script_analysis',
    module_capabilities: Object.freeze({ script_analysis: 'execute' }),
    output_schema_version: '1.0',
    is_default: false,
    enabled: true,
    system_prompt: SHORT_DRAMA_DIRECTOR_PROMPT,
    ...COMMON_GOVERNANCE,
  }),
  Object.freeze({
    id: 'cinematic-visual-director',
    name: '电影化视觉导演',
    version: '1.0.0',
    description: '在现有生产包上增加情绪、节奏、视觉母题和客观风格建议',
    module: 'script_analysis',
    module_capabilities: Object.freeze({
      script_analysis: 'execute',
      canvas: 'consume',
      factory: 'preview',
    }),
    output_schema_version: '1.0',
    is_default: false,
    enabled: true,
    require_visual_direction: true,
    system_prompt: `${SHORT_DRAMA_DIRECTOR_PROMPT}${VISUAL_DIRECTION_PROMPT_ADDITION}`,
    user_prompt_addendum: VISUAL_DIRECTION_CONTRACT,
    ...COMMON_GOVERNANCE,
  }),
  Object.freeze({
    id: 'short-drama-production-director',
    name: '短剧一体化生产导演',
    version: '2.0.0',
    description: '整合创作策略、导演故事板、表演轨和模型提示词结构',
    module: 'script_analysis',
    module_capabilities: Object.freeze({
      script_analysis: 'execute',
      canvas: 'consume',
    }),
    output_schema_version: '2.0',
    is_default: true,
    enabled: true,
    require_production_direction: true,
    default_strategy_preset: 'fusion',
    system_prompt: `${SHORT_DRAMA_DIRECTOR_PROMPT}${VISUAL_DIRECTION_PROMPT_ADDITION}${PRODUCTION_DIRECTOR_PROMPT_ADDITION}`,
    user_prompt_addendum: `${VISUAL_DIRECTION_CONTRACT}\n\n${PRODUCTION_DIRECTOR_CONTRACT}`,
    ...PRODUCTION_DIRECTOR_GOVERNANCE,
  }),
]);

function getSkillDefinition(skillId) {
  return SKILLS.find((skill) => skill.enabled && skill.id === skillId) || null;
}

function publicRegistrySkill(skill) {
  return {
    id: skill.id,
    name: skill.name,
    version: skill.version,
    description: skill.description,
    module: skill.module,
    module_capabilities: skill.module_capabilities,
    output_schema_version: skill.output_schema_version,
    is_default: skill.is_default,
    source: skill.source,
    license: skill.license,
    permissions: skill.permissions,
    input_schema: skill.input_schema,
    output_schema: skill.output_schema,
    runtime_policy: skill.runtime_policy,
  };
}

function listSkillsForModule(module, capability) {
  return SKILLS
    .filter((skill) => (
      skill.enabled
      && skill.listed !== false
      && skill.module_capabilities[module] === capability
    ))
    .map(publicRegistrySkill);
}

function resolveSkillForModule(skillId, module, capability) {
  if (!skillId) {
    return SKILLS.find((skill) => (
      skill.enabled
      && skill.module_capabilities[module] === capability
      && skill.is_default
    )) || null;
  }
  const skill = getSkillDefinition(skillId);
  return skill?.module_capabilities[module] === capability ? skill : null;
}

function snapshotSkill(skill, module) {
  return {
    id: skill.id,
    name: skill.name,
    version: skill.version,
    module,
    output_schema_version: skill.output_schema_version,
  };
}

module.exports = {
  getSkillDefinition,
  listSkillsForModule,
  resolveSkillForModule,
  snapshotSkill,
};
