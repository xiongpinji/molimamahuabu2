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

// 中文句子补中文句号，英文句子补英文句号。
function joinSentences(...parts) {
  return parts.map(text).filter(Boolean)
    .map((part) => (/[.!?。！？]$/.test(part) ? part : `${part}${/[一-鿿]/.test(part) ? '。' : '.'}`))
    .join(' ');
}

function replaceCharacterIds(value, names) {
  // 模型写进描述里的 "c3" 这类源角色 id 替换为目标名字。
  return text(value).replace(/\bc\d+\b/g, (id) => names.get(id) || id);
}

// 工厂里展示的景别用中文，和工厂自己生成的分镜一致。
const SHOT_SIZE_ZH = {
  'extreme close-up': '大特写',
  'close-up': '特写',
  'medium close-up': '近景',
  medium: '中景',
  'medium wide': '中远景',
  wide: '远景',
  'extreme wide': '大远景',
  insert: '插入镜头',
};

function localizeTerms(value, glossary) {
  // 源事实正文是英文、专有名词保留中文拼音名；用 glossary 把出现的源名替换成本地化名。
  let output = text(value);
  const entries = Object.entries(glossary || {})
    .filter(([source, target]) => text(source) && text(target))
    .sort((left, right) => right[0].length - left[0].length);
  for (const [source, target] of entries) output = output.split(source).join(target);
  return output;
}

function localizeText(value, names, glossary) {
  return localizeTerms(replaceCharacterIds(value, names), glossary);
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

// 围观群众、路人这类群体不是可复用的角色：不单独建角色、不出角色图，只留在镜头描述里。
const GROUP_CHARACTER_EN = /^(?:a\s+)?(?:group|crowd|cluster)\b|\b(?:onlookers|bystanders|passers-?by|extras|crowd)\b/i;
const GROUP_CHARACTER_ZH = /围观|群众|路人|众人|人群/;

function isGroupCharacter(character) {
  return [character?.source_name, character?.display_name].some((value) => GROUP_CHARACTER_ZH.test(text(value)))
    || /\b(?:group|crowd)\b/i.test(text(character?.display_name))
    || [character?.display_name, character?.relationship].some((value) => GROUP_CHARACTER_EN.test(text(value)));
}

// 构图句以景别开头（"Tight frontal close-up of X in ..."），去掉景别与背景，只留人物外观。
const SHOT_FRAMING_PREFIX = /^(?:[a-z-]+\s+){0,4}?(?:close-?up|shot|view|two-shot|insert|framing)\s+of\s+/i;

function appearanceFromComposition(composition, character) {
  const body = text(composition).replace(SHOT_FRAMING_PREFIX, '');
  if (body === text(composition)) return '';
  // 只接受「角色名 + 穿着/服装」的句子，例如 "Lin Jiang in a blue school jacket"；
  // "Lin Jiang reaching into his clothing" 这类动作描述不是外貌。
  const namePrefix = [character.display_name, character.source_name].map(text).find((name) => name && body.startsWith(name));
  if (!namePrefix || !/^\s+(?:in|wearing|dressed in)\s+/i.test(body.slice(namePrefix.length))) return '';
  return body.split(/[;,]\s+(?:with|while|as|against|and a|behind)\b|;\s*/i)[0].replace(/[.\s]+$/, '');
}

// 完全转绘版本的文化映射：目标国家的人物形象、场景、道具与一句国家设定；没有就是空对象。
function cultureOf(localization) {
  const culture = localization?.culture_map && typeof localization.culture_map === 'object' ? localization.culture_map : {};
  return {
    characters: culture.characters && typeof culture.characters === 'object' ? culture.characters : {},
    scenes: culture.scenes && typeof culture.scenes === 'object' ? culture.scenes : {},
    props: culture.props && typeof culture.props === 'object' ? culture.props : {},
    setting: text(culture.setting),
  };
}

function mapCharacters(facts, names, glossary, characterImages = {}, culture = cultureOf(null)) {
  const groupIds = new Set(list(facts.characters).filter(isGroupCharacter).map((character) => text(character.id)));
  return list(facts.characters).filter((character) => !isGroupCharacter(character)).map((character) => {
    const id = text(character.id);
    // 外貌只取该角色单独出镜（群演不计）的构图：多人镜头的构图描述的是整个画面，拿来当外貌会串到别人身上。
    // 完全转绘时用目标国家的人物形象。
    const localizedAppearance = text(culture.characters[id]?.appearance);
    const localizedRole = text(culture.characters[id]?.role);
    const appearanceSeed = localizedAppearance || text(character.appearance) || list(facts.shots)
      .filter((shot) => {
        const people = list(shot.visible_character_ids).map(text).filter((visible) => !groupIds.has(visible));
        return people.length === 1 && people[0] === id;
      })
      .map((shot) => appearanceFromComposition(shot.composition, character))
      .find(Boolean) || '';
    const image = characterImages[id] || {};
    return {
      character_id: id,
      name: names.get(id),
      role: (localizedRole ? replaceCharacterIds(localizedRole, names) : localizeText(character.relationship, names, glossary)) || null,
      description: (localizedRole
        ? replaceCharacterIds(localizedRole, names)
        : localizeText([character.relationship, ...list(character.relationships)].filter(Boolean).join('; '), names, glossary)) || null,
      // 完全转绘的形象已是目标国家描述，只替换角色编号，不再按原名词表替换（避免把「父亲」这类普通词换成名字）。
      appearance: (localizedAppearance ? replaceCharacterIds(localizedAppearance, names) : localizeText(appearanceSeed, names, glossary)) || null,
      ...(text(image.image_url) ? { image_url: text(image.image_url) } : {}),
      ...(text(image.local_path) ? { local_path: text(image.local_path) } : {}),
    };
  });
}

function mapScenes(facts, style, glossary, names, culture = cultureOf(null)) {
  return list(facts.scenes).map((scene) => {
    const localized = culture.scenes[text(scene.id)] || {};
    const location = text(localized.location) ? replaceCharacterIds(localized.location, names) : localizeText(scene.location, names, glossary);
    const time = text(localized.time) ? replaceCharacterIds(localized.time, names) : localizeText(scene.time, names, glossary);
    return {
      scene_id: text(scene.id),
      location: location || text(scene.id),
      time,
      prompt: joinSentences(
        style.positive,
        culture.setting,
        `${location}${time ? `，${time}` : ''}`,
        text(localized.visual) ? replaceCharacterIds(localized.visual, names) : localizeText(scene.visual, names, glossary),
        '空镜，画面中没有人物。',
      ),
    };
  });
}

function mapProps(facts, style, glossary, names, culture = cultureOf(null)) {
  return list(facts.props).map((prop) => {
    const localizedName = text(culture.props[text(prop.id)]?.name);
    const name = localizedName ? replaceCharacterIds(localizedName, names) : localizeText(prop.name, names, glossary);
    return {
      prop_id: text(prop.id),
      name: name || text(prop.id),
      type: null,
      description: name,
      prompt: joinSentences(style.positive, `${name}，纯色背景上的单独物品。`),
    };
  });
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

function shotTextRegions(shot, localization, names) {
  // 反推阶段没有转写证据时，台词只存在于硬字幕；本地化后用 text_map 的目标语字幕。
  // 只有字幕是台词。屏幕文字（电视、网页、招牌）是画面内容，放进台词会被原生音频念出来。
  const textMap = localization?.text_map || {};
  const subtitles = [];
  const screenText = [];
  for (const region of list(shot.text_regions)) {
    const source = text(region?.source_text);
    const target = text(textMap[`${text(shot.id)}:${text(region?.id)}`]) || source;
    if (!target) continue;
    const kind = text(region?.kind);
    const speaker = names?.get(text(region?.speaker_id));
    if (!kind || kind === 'subtitle') subtitles.push({ source, text: speaker ? `${speaker}：${target}` : target });
    else screenText.push(target);
  }
  return { subtitles, screenText };
}

function dropCarriedSubtitles(subtitles, previousLastSource) {
  // 同一句字幕跨过剪辑点时会在相邻两个镜头里各出现一次，只在前一个镜头里保留。
  let start = 0;
  while (start < subtitles.length && previousLastSource && subtitles[start].source === previousLastSource) start += 1;
  return subtitles.slice(start);
}

function mapShot(facts, shot, { names, glossary, localization, style, propIds, previousLastSubtitle, setting = '' }) {
  const characterNames = list(shot.visible_character_ids).map((id) => names.get(text(id))).filter(Boolean);
  const { subtitles, screenText } = shotTextRegions(shot, localization, names);
  const spoken = dropCarriedSubtitles(subtitles, previousLastSubtitle);
  const description = joinSentences(
    localizeText(shot.composition, names, glossary),
    screenText.length ? `画面文字：「${screenText.join('」/「')}」` : '',
  );
  const action = localizeText(
    joinSentences(shot.opening_state, shot.continuous_action, shot.ending_state),
    names,
    glossary,
  );
  const movement = localizeText(shot.camera_movement, names, glossary);
  const durationSeconds = Math.max(1, Math.round((Number(shot.end_ms) - Number(shot.start_ms)) / 1000));
  const props = list(facts.props)
    .filter((prop) => propIds.has(text(prop.id)) && overlaps(prop.evidence_ranges, shot))
    .map((prop) => text(prop.id));
  return {
    shot_number: Number(shot.index) || undefined,
    title: `镜头 ${Number(shot.index) || text(shot.id)}`,
    description,
    duration: durationSeconds,
    dialogue: spoken.map((line) => line.text).join('\n'),
    last_subtitle_source: subtitles.length ? subtitles[subtitles.length - 1].source : '',
    action,
    movement,
    shot_type: SHOT_SIZE_ZH[text(shot.shot_size)] || text(shot.shot_size) || null,
    characters: list(shot.visible_character_ids).map(text).filter(Boolean),
    props,
    image_prompt: joinSentences(style.positive, setting, description, characterNames.length ? `角色：${characterNames.join('、')}` : ''),
    video_prompt: joinSentences(style.positive, setting, description, action, movement ? `运镜：${movement}` : ''),
    continuity: {
      source_shot_id: text(shot.id),
      start_ms: Number(shot.start_ms),
      end_ms: Number(shot.end_ms),
      opening_state: localizeText(shot.opening_state, names, glossary),
      ending_state: localizeText(shot.ending_state, names, glossary),
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

// 服装跟着角色走，家具和建筑是场景的一部分，屏幕画面是镜头内容：都不单独出道具图。
const NON_PROP_NOUNS = new Set([
  'jacket', 'jackets', 'shirt', 'shirts', 'uniform', 'uniforms', 'tracksuit', 'tracksuits', 'clothes', 'clothing',
  'coat', 'coats', 'dress', 'dresses', 'pants', 'trousers', 'skirt', 'skirts', 'shoes', 'hat', 'hats',
  'desk', 'desks', 'chair', 'chairs', 'table', 'tables', 'bed', 'beds', 'sofa', 'wardrobe', 'cabinet', 'shelf', 'shelves',
  'gate', 'gates', 'fence', 'fences', 'wall', 'walls', 'door', 'doors', 'window', 'windows', 'building', 'buildings',
  'broadcast', 'broadcasts', 'caption', 'captions', 'footage', 'headline', 'headlines', 'page', 'webpage',
]);

// 中文道具名：取「的」之后的核心词；以家具、陈设、服装、屏幕内容结尾的不单独出道具图。
const CJK_TEXT = /[\u4e00-\u9fff]/;
const CJK_NON_PROP_SUFFIX = /(桌|椅|凳|床|柜|架|画|海报|照片|饰物|装饰|墙|门|窗|衣|服|外套|裤|裙|鞋|帽|网页|画面|字幕)$/;

function cjkPropCore(name) {
  const parts = text(name).split('的');
  return parts[parts.length - 1].trim();
}

// 核心词里每个候选名词取末尾两字和倒数第二、三字，用来在剧情描述里找提及（如「电视机」→「电视」）。
function cjkPropHeads(name) {
  return cjkPropCore(name)
    .split(/[或和与、及]/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 2)
    .flatMap((part) => [part.slice(-2), part.length >= 3 ? part.slice(-3, -1) : ''])
    .filter(Boolean);
}

function isKeyProp(prop, facts) {
  if (CJK_TEXT.test(text(prop?.name))) {
    if (CJK_NON_PROP_SUFFIX.test(cjkPropCore(prop.name))) return false;
    const cjkShotCount = list(facts.shots).filter((shot) => overlaps(prop?.evidence_ranges, shot)).length;
    if (cjkShotCount === 0) return false;
    if (cjkShotCount >= KEY_PROP_MIN_RECURRING_SHOTS) return true;
    const cjkStory = [...list(facts.causal_chain), ...list(facts.reversals), text(facts.episode_hook)]
      .map((item) => (typeof item === 'string' ? item : text(item?.text)))
      .join(' ');
    return cjkPropHeads(prop.name).some((head) => cjkStory.includes(head));
  }
  const nouns = propHeadNouns(prop);
  if (nouns.length && nouns.every((noun) => NON_PROP_NOUNS.has(noun))) return false;
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
  const culture = cultureOf(localization);
  const glossary = {
    ...(localization?.glossary || {}),
    ...nameGlossary(facts, names),
  };
  // 同一道具在不同段里名字略有差别（「林江的黑色双肩包」「黑色双肩包」），按核心词只保留一个。
  const seenPropCores = new Set();
  const selectedPropIds = new Set(propIds
    ? [...propIds].map(text)
    : list(facts.props).filter((prop) => isKeyProp(prop, facts)).filter((prop) => {
      const core = CJK_TEXT.test(text(prop.name)) ? cjkPropCore(prop.name) : text(prop.id);
      if (seenPropCores.has(core)) return false;
      seenPropCores.add(core);
      return true;
    }).map((prop) => text(prop.id)));
  let previousLastSubtitle = '';
  const mappedShots = [...facts.shots]
    .sort((left, right) => Number(left.start_ms) - Number(right.start_ms))
    .map((shot) => {
      const { last_subtitle_source: lastSubtitle, ...mapped } = mapShot(facts, shot, {
        names, glossary, localization, style, propIds: selectedPropIds, previousLastSubtitle, setting: culture.setting,
      });
      previousLastSubtitle = lastSubtitle;
      return { sceneId: primarySceneId(facts, shot), shot: mapped };
    });
  const characters = mapCharacters(facts, names, glossary, characterImages, culture)
    .map((character) => (style.negative ? { ...character, negative_prompt: style.negative } : character));
  const story = list(facts.story).map((line) => localizeText(line, names, glossary)).filter(Boolean);
  return {
    source: { title, locked_facts: list(facts.locked_facts).map((line) => localizeText(line, names, glossary)) },
    normalized_script: {
      logline: story[0] || '',
      summary: story.join(' '),
      target_duration_seconds: Math.round(Number(facts.duration_ms || 0) / 1000),
    },
    characters,
    scenes: mapScenes(facts, style, glossary, names, culture),
    props: mapProps(facts, style, glossary, names, culture).filter((prop) => selectedPropIds.has(prop.prop_id)),
    episodes: [{
      episode_number: 1,
      title: title || '第 1 集',
      description: localizeText(facts.episode_hook, names, glossary) || null,
      scenes: groupShotsByScene(facts, mappedShots),
    }],
    continuity_rules: [...list(facts.causal_chain), ...list(facts.reversals)].map((line) => localizeText(line, names, glossary)),
  };
}

module.exports = {
  buildRedrawFactoryPackage,
  isKeyProp,
};
