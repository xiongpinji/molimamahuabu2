'use strict';

/**
 * 样片转绘 → 短剧工厂生产包适配器（纯函数，无 IO）。
 *
 * 输入：视频理解反推出的 source_facts（schema 2.0）、可选的本地化映射（name_map/text_map/glossary/culture_map）、
 * 分析时的风格设置（free_style / aspect_ratio）。
 * 输出：scriptAnalysisFactoryImportService.writeFactoryPackage 可直接写库的生产包：
 * characters / scenes / props / episodes[0].scenes[].shots[]。
 *
 * 缺失的视觉描述与分镜提示词先用确定性模板从镜头事实拼出，不调用模型；
 * 工厂一键流程会复用这些字段并只补生成缺失的图片与视频。
 */

function text(value) {
  return value == null ? '' : String(value).trim();
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function overlaps(ranges, shot) {
  return list(ranges).some((range) => Number(range?.start_ms) < Number(shot.end_ms)
    && Number(range?.end_ms) > Number(shot.start_ms));
}

function overlapMs(ranges, shot) {
  return list(ranges).reduce((total, range) => {
    const start = Math.max(Number(range?.start_ms), Number(shot.start_ms));
    const end = Math.min(Number(range?.end_ms), Number(shot.end_ms));
    return total + Math.max(0, end - start);
  }, 0);
}

function joinSentences(...parts) {
  return parts.map(text).filter(Boolean)
    .map((part) => (/[.!?。！？]$/.test(part) ? part : `${part}.`))
    .join(' ');
}

function replaceCharacterIds(value, names) {
  // 关系描述里的 "c3" 这类源角色 id 替换为目标名字。
  return text(value).replace(/\bc\d+\b/g, (id) => names.get(id) || id);
}

function localizeTerms(value, glossary) {
  // 源事实正文是英文、专有名词保留中文拼音名；用 glossary 把出现的源名替换成本地化名。
  let output = text(value);
  const entries = Object.entries(glossary || {})
    .filter(([source, target]) => text(source) && text(target))
    .sort((left, right) => right[0].length - left[0].length);
  for (const [source, target] of entries) output = output.split(source).join(target);
  return output;
}

function characterNameMap(facts, localization) {
  const nameMap = localization?.name_map || {};
  const names = new Map();
  for (const character of list(facts.characters)) {
    const id = text(character?.id);
    if (!id) continue;
    names.set(id, text(nameMap[id]) || text(character.display_name) || text(character.source_name) || id);
  }
  return names;
}

function nameGlossary(facts, names) {
  // display_name（如 "Lin Jiang"）与 source_name（如 "林江"）都替换为目标名。
  const glossary = {};
  for (const character of list(facts.characters)) {
    const target = names.get(text(character?.id));
    if (!target) continue;
    for (const source of [character.display_name, character.source_name]) {
      if (text(source) && text(source) !== target) glossary[text(source)] = target;
    }
  }
  return glossary;
}

function mapCharacters(facts, names, glossary, characterImages = {}) {
  return list(facts.characters).map((character) => {
    const id = text(character.id);
    const shotsWithCharacter = list(facts.shots)
      .filter((shot) => list(shot.visible_character_ids).includes(id))
      .map((shot) => text(shot.composition));
    // 外貌与服装只零散出现在镜头构图里，取首个提到该角色的构图句作为外观种子。
    const appearanceSeed = shotsWithCharacter.find(Boolean) || '';
    const image = characterImages[id] || {};
    return {
      character_id: id,
      name: names.get(id),
      role: localizeTerms(character.relationship, glossary) || null,
      description: localizeTerms(
        replaceCharacterIds([character.relationship, ...list(character.relationships)].filter(Boolean).join('; '), names),
        glossary,
      ) || null,
      appearance: localizeTerms(appearanceSeed, glossary) || null,
      ...(text(image.image_url) ? { image_url: text(image.image_url) } : {}),
      ...(text(image.local_path) ? { local_path: text(image.local_path) } : {}),
    };
  });
}

function mapScenes(facts, style) {
  return list(facts.scenes).map((scene) => ({
    scene_id: text(scene.id),
    location: text(scene.location) || text(scene.id),
    time: text(scene.time),
    prompt: joinSentences(
      style.positive,
      `${text(scene.location)}${text(scene.time) ? `, ${text(scene.time)}` : ''}, empty establishing shot, no people.`,
    ),
  }));
}

function mapProps(facts, style) {
  return list(facts.props).map((prop) => ({
    prop_id: text(prop.id),
    name: text(prop.name) || text(prop.id),
    type: null,
    description: text(prop.name),
    prompt: joinSentences(style.positive, `${text(prop.name)}, isolated product shot on a plain background.`),
  }));
}

function primarySceneId(facts, shot) {
  let best = null;
  let bestMs = 0;
  for (const scene of list(facts.scenes)) {
    const ms = overlapMs(scene.source_ranges, shot);
    if (ms > bestMs) {
      best = text(scene.id);
      bestMs = ms;
    }
  }
  return best;
}

function shotDialogue(shot, localization) {
  // 反推阶段没有转写证据时，台词只存在于硬字幕 text_regions；本地化后用 text_map 的目标语字幕。
  const textMap = localization?.text_map || {};
  return list(shot.text_regions)
    .filter((region) => ['subtitle', 'title', 'screen_text'].includes(text(region?.kind)) || !region?.kind)
    .map((region) => text(textMap[`${text(shot.id)}:${text(region.id)}`]) || text(region.source_text))
    .filter(Boolean)
    .join('\n');
}

function mapShot(facts, shot, { names, glossary, localization, style, propIds }) {
  const characterNames = list(shot.visible_character_ids).map((id) => names.get(text(id))).filter(Boolean);
  const description = localizeTerms(shot.composition, glossary);
  const action = localizeTerms(
    joinSentences(shot.opening_state, shot.continuous_action, shot.ending_state),
    glossary,
  );
  const movement = localizeTerms(shot.camera_movement, glossary);
  const durationSeconds = Math.max(1, Math.round((Number(shot.end_ms) - Number(shot.start_ms)) / 1000));
  const props = list(facts.props)
    .filter((prop) => propIds.has(text(prop.id)) && overlaps(prop.evidence_ranges, shot))
    .map((prop) => text(prop.id));
  return {
    shot_number: Number(shot.index) || undefined,
    title: `Shot ${Number(shot.index) || text(shot.id)}`,
    description,
    duration: durationSeconds,
    dialogue: shotDialogue(shot, localization),
    action,
    movement,
    characters: list(shot.visible_character_ids).map(text).filter(Boolean),
    props,
    image_prompt: joinSentences(style.positive, description, characterNames.length ? `Characters: ${characterNames.join(', ')}.` : ''),
    video_prompt: joinSentences(style.positive, description, action, movement ? `Camera: ${movement}` : ''),
    continuity: {
      source_shot_id: text(shot.id),
      start_ms: Number(shot.start_ms),
      end_ms: Number(shot.end_ms),
      opening_state: localizeTerms(shot.opening_state, glossary),
      ending_state: localizeTerms(shot.ending_state, glossary),
    },
  };
}

function groupShotsByScene(facts, mapped) {
  // 连续且主场景相同的镜头合并为同一场；只用 scene_id 引用，不设 scene_number，避免引用键串场。
  const groups = [];
  for (const { shot, sceneId } of mapped) {
    const last = groups[groups.length - 1];
    if (last && last.scene_id === sceneId) {
      last.shots.push(shot);
      continue;
    }
    const scene = list(facts.scenes).find((item) => text(item.id) === sceneId);
    groups.push({
      scene_id: sceneId || `shot-group-${groups.length + 1}`,
      location: text(scene?.location) || undefined,
      time: text(scene?.time) || undefined,
      shots: [shot],
    });
  }
  return groups;
}

// 道具只保留「关键」的，满足其一即可（其余只留在镜头描述里，不单独出图付费）：
// 1) 推动剧情：道具中心名词（或 "used for X" 的用途名词）出现在因果链、反转或钩子里；
// 2) 跨镜连续：至少出现在 6 个镜头（校服、书包、自行车这类全集必须一致的物件）。
// 只比中心名词，避免 "computer monitor/keyboard/mouse" 因修饰词全部命中；剧情文本保留大小写
// 并只匹配小写词，避免 "World Cup" 这类专有名词误命中 cups。
const KEY_PROP_MIN_RECURRING_SHOTS = 6;
const PROP_COLLECTIVE_NOUNS = new Set(['set', 'sets', 'row', 'rows', 'pair', 'pairs', 'stack', 'pile']);

function lastNoun(phrase) {
  const words = text(phrase).split(/[^a-z]+/).filter(Boolean);
  while (words.length > 1 && PROP_COLLECTIVE_NOUNS.has(words[words.length - 1])) words.pop();
  const noun = words.pop() || '';
  return noun.length >= 3 && !PROP_COLLECTIVE_NOUNS.has(noun) ? noun : '';
}

function propHeadNouns(prop) {
  const name = text(prop?.name).toLowerCase().replace(/'s\b/g, '');
  const purpose = /\bused (?:for|to) ([a-z -]+)/.exec(name);
  const body = name.split(/\s+(?:on|with|used|held|in|at)\s+/)[0]
    .replace(/^(?:[a-z-]+\s+)*?(?:row|set|pair|stack|pile)s?\s+of\s+/, '');
  const nouns = body.split(/\s+(?:or|and)\s+|,/).map(lastNoun);
  if (purpose) nouns.push(lastNoun(purpose[1]));
  return [...new Set(nouns.filter(Boolean))];
}

function isKeyProp(prop, facts) {
  const shotCount = list(facts.shots).filter((shot) => overlaps(prop?.evidence_ranges, shot)).length;
  if (shotCount === 0) return false;
  if (shotCount >= KEY_PROP_MIN_RECURRING_SHOTS) return true;
  const story = [...list(facts.causal_chain), ...list(facts.reversals), text(facts.episode_hook)]
    .map((item) => (typeof item === 'string' ? item : text(item?.text)))
    .join(' ');
  return propHeadNouns(prop).some((noun) => new RegExp(`\\b${noun.replace(/s$/, '')}s?\\b`).test(story));
}

function buildRedrawFactoryPackage({
  sourceFacts,
  localization = null,
  analysisSettings = {},
  title = '',
  characterImages = {},
  propIds = null,
} = {}) {
  const facts = sourceFacts || {};
  if (facts.schema_version !== '2.0' || !Array.isArray(facts.shots) || facts.shots.length === 0) {
    throw Object.assign(new Error('样片分析结果缺少可导入的镜头'), { code: 'REDRAW_FACTORY_FACTS_INVALID' });
  }
  const style = {
    positive: text(analysisSettings?.free_style?.positive),
    negative: text(analysisSettings?.free_style?.negative),
  };
  const names = characterNameMap(facts, localization);
  const glossary = {
    ...(localization?.glossary || {}),
    ...nameGlossary(facts, names),
  };
  const selectedPropIds = new Set(propIds
    ? [...propIds].map(text)
    : list(facts.props).filter((prop) => isKeyProp(prop, facts)).map((prop) => text(prop.id)));
  const mappedShots = [...facts.shots]
    .sort((left, right) => Number(left.start_ms) - Number(right.start_ms))
    .map((shot) => ({
      sceneId: primarySceneId(facts, shot),
      shot: mapShot(facts, shot, { names, glossary, localization, style, propIds: selectedPropIds }),
    }));
  const characters = mapCharacters(facts, names, glossary, characterImages)
    .map((character) => (style.negative ? { ...character, negative_prompt: style.negative } : character));
  const story = list(facts.story).map((line) => localizeTerms(line, glossary)).filter(Boolean);
  return {
    source: { title, locked_facts: list(facts.locked_facts).map((line) => localizeTerms(line, glossary)) },
    normalized_script: {
      logline: story[0] || '',
      summary: story.join(' '),
      target_duration_seconds: Math.round(Number(facts.duration_ms || 0) / 1000),
    },
    characters,
    scenes: mapScenes(facts, style),
    props: mapProps(facts, style).filter((prop) => selectedPropIds.has(prop.prop_id)),
    episodes: [{
      episode_number: 1,
      title: title || 'Episode 1',
      description: localizeTerms(facts.episode_hook, glossary) || null,
      scenes: groupShotsByScene(facts, mappedShots),
    }],
    continuity_rules: [...list(facts.causal_chain), ...list(facts.reversals)].map((line) => localizeTerms(line, glossary)),
  };
}

module.exports = {
  buildRedrawFactoryPackage,
  isKeyProp,
};
