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

// 反推描述会写「硬字幕留在画面下方」这类样片特征；转绘视频用原生音频、不烧字幕，
// 这些分句会让视频模型照着画出字幕，按分句去掉。
const SUBTITLE_MENTION = /\bsubtitles?\b|\bcaptions?\b|字幕/i;

function stripSubtitleMentions(value) {
  const parts = text(value).split(/([,;.!?，；。！？]\s*)/);
  const kept = [];
  for (let index = 0; index < parts.length; index += 2) {
    const clause = parts[index];
    const delimiter = parts[index + 1] || '';
    if (!SUBTITLE_MENTION.test(clause)) {
      kept.push(clause + delimiter);
    } else if (/[.!?。！？]/.test(delimiter) && kept.length) {
      // 去掉的是句末分句：把句号挪给前一个分句。
      kept[kept.length - 1] = kept[kept.length - 1].replace(/[,;，；]\s*$/, delimiter);
    }
  }
  return kept.join('').replace(/[,;，；]\s*$/, '').trim();
}

function displayName(code, type) {
  try {
    return new Intl.DisplayNames(['zh-CN'], { type }).of(code) || code;
  } catch (_) {
    return code;
  }
}

// 台词的目标语言与口音，例如「西班牙语，墨西哥口音」；没有本地化时为空（沿用原片语言）。
function spokenLanguageOf(localization) {
  const locale = text(localization?.locale);
  if (!locale || locale === 'source') return '';
  const [language, region] = locale.split(/[-_]/);
  const market = (text(localization?.market) || text(region)).toUpperCase();
  const languageName = displayName(language.toLowerCase(), 'language');
  return market ? `${languageName}，${displayName(market, 'region')}口音` : languageName;
}

function dialogueDirection(spoken, spokenLanguage) {
  if (!spoken.length) return '';
  const lines = spoken.map((line) => line.text).join(' ');
  return spokenLanguage ? `台词全部用${spokenLanguage}说出：${lines}` : `台词：${lines}`;
}

const NO_SUBTITLES = '画面中不要出现字幕。';

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
    story: list(culture.story).map(text).filter(Boolean),
    episodeHook: text(culture.episode_hook),
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
      // 整部剧里认人的键：原名（没有原名用显示名）。各集按它对上工厂里的同一个角色。
      series_key: text(character.source_name) || text(character.display_name) || id,
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

// 道具生图只要物品本身：去掉"某角色手中的 / 环绕某角色的"这类归属修饰，否则生图模型会把拿道具的人一起画出来。
// 道具名称（含归属）仍用于分镜关联和描述，只有生图提示词改用去掉归属的物品短语。
// 本地化模型有时把角色名写成中文音译（Martina 写成"马蒂娜"），按名字匹配不到；开头"……手持的 / ……腰间佩带的 /
// 环绕……的"这类持有、位置短语不看名字一律去掉。引号里的文字不算，没有持有、位置词的修饰（覆盖石台的……）保留。
const HOLDER_CLAUSE = /^[^的，,、“”"「」]{0,12}?(?:手持|手中|手里|手上|掌中|掌心|指间|怀中|怀里|口中|嘴里|所持|持有|握着|拿着|举着|捧着|抱着|提着|夹着|背着|背上|腰间|腰上|身上|身边|身旁|身侧|身后|身前|胸前|头上|头顶|戴着|挂着|佩带|佩戴|环绕|围绕|周围|周身)[^的，,、“”"「」]{0,8}?的/;
function propObjectPhrase(name, characterNames = []) {
  let value = text(name);
  const people = [...new Set(characterNames.map(text).filter(Boolean))].sort((a, b) => b.length - a.length);
  for (const person of people) {
    for (let index = value.indexOf(person); index >= 0; index = value.indexOf(person)) {
      const de = value.indexOf('的', index + person.length);
      value = de >= 0 && de - (index + person.length) <= 8
        ? value.slice(de + 1)
        : value.slice(0, index) + value.slice(index + person.length);
    }
  }
  value = value.replace(/^[\s的，,、]+/, '').trim();
  const withoutHolder = value.replace(HOLDER_CLAUSE, '').trim();
  if (withoutHolder) value = withoutHolder;
  // 持有词后面不带「的」（红衣女子所持长剑 → 所持长剑）时也去掉，否则道具图提示词成了「所持长剑」。
  // 不含「手持」：「手持式对讲机」「手持风扇」里它是物品的一部分。
  const withoutVerb = value.replace(/^(?:所持|手中|手里|持有)/, '').trim();
  if (withoutVerb.length >= 2) value = withoutVerb;
  return value || text(name);
}

// 项目画风里描写人物的短句（真人演员、肤色、服装……）不放进道具图，只保留画风与光影。
const PERSON_STYLE_WORDS = /真人|演员|人物|人像|角色|肤色|服装|发型|妆容|表情|actor|actress|person|people|portrait|skin|costume/i;
function propStylePositive(positive) {
  return text(positive).replace(/真人写实/g, '写实')
    .split(/[，,。.;；]+/)
    .map((part) => part.trim())
    .filter((part) => part && !PERSON_STYLE_WORDS.test(part))
    .join('，');
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
      prompt: joinSentences(
        propStylePositive(style.positive),
        `${propObjectPhrase(name, [...names.values()])}，作为单独物品放在纯色无缝背景上`,
        '画面中只有这件物品，没有任何人物、手或身体部位，没有文字',
      ),
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

// 字幕没标说话人时，只用原文完全相同的画面内对白条目补（画外音条目已在分析时丢弃）。
// 不能因为"镜头里只有一个人说话"就把其它字幕都归给他：同镜头的画外台词（例如别人喊他的名字）会被错归，
// 定音镜头就会混进别人的声音。对不上的字幕不标说话人，该镜头也不会当定音镜头。
function regionSpeakerId(shot, region) {
  if (text(region?.speaker_id)) return text(region.speaker_id);
  const same = list(shot.dialogue).find((turn) => text(turn?.speaker_id)
    && text(turn.source_text) && text(turn.source_text) === text(region?.source_text));
  return same ? text(same.speaker_id) : '';
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
    const speakerId = regionSpeakerId(shot, region);
    const speaker = names?.get(speakerId);
    if (!kind || kind === 'subtitle') {
      subtitles.push({ source, speakerId: speaker ? speakerId : '', text: speaker ? `${speaker}：${target}` : target });
    }
    else screenText.push(target);
  }
  return { subtitles, screenText };
}

// 本镜所有台词都标了说话人、且只有同一个画面里的角色在说话：这个镜头能单独提取他的音色。
function soloSpeakerId(spoken, shot) {
  if (!spoken.length || spoken.some((line) => !line.speakerId)) return '';
  const speakers = [...new Set(spoken.map((line) => line.speakerId))];
  const visible = new Set(list(shot.visible_character_ids).map(text));
  return speakers.length === 1 && visible.has(speakers[0]) ? speakers[0] : '';
}

function dropCarriedSubtitles(subtitles, previousLastSource) {
  // 同一句字幕跨过剪辑点时会在相邻两个镜头里各出现一次，只在前一个镜头里保留。
  let start = 0;
  while (start < subtitles.length && previousLastSource && subtitles[start].source === previousLastSource) start += 1;
  return subtitles.slice(start);
}

function mapShot(facts, shot, {
  names, glossary, localization, style, propIds, previousLastSubtitle, setting = '', spokenLanguage = '', groupLooks = new Map(),
}) {
  const characterNames = list(shot.visible_character_ids).map((id) => names.get(text(id))).filter(Boolean);
  const { subtitles, screenText } = shotTextRegions(shot, localization, names);
  const spoken = dropCarriedSubtitles(subtitles, previousLastSubtitle);
  // 群演不建角色、没有角色图，外形只能写进出现的镜头，否则视频模型会随便画（#98 第 3、9、22 镜白衣弟子没出来或变成黑衣人）。
  const crowd = [...new Set(list(shot.visible_character_ids).map(text))]
    .filter((id) => groupLooks.has(id))
    .map((id) => `${names.get(id) || id}：${groupLooks.get(id)}`);
  const description = joinSentences(
    localizeText(stripSubtitleMentions(shot.composition), names, glossary),
    crowd.length ? `群演外形：${crowd.join('；')}` : '',
    screenText.length ? `画面文字：「${screenText.join('」/「')}」` : '',
  );
  const action = localizeText(
    joinSentences(...[shot.opening_state, shot.continuous_action, shot.ending_state].map(stripSubtitleMentions)),
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
    solo_speaker_id: soloSpeakerId(spoken, shot),
    last_subtitle_source: subtitles.length ? subtitles[subtitles.length - 1].source : '',
    action,
    movement,
    shot_type: SHOT_SIZE_ZH[text(shot.shot_size)] || text(shot.shot_size) || null,
    characters: list(shot.visible_character_ids).map(text).filter(Boolean),
    props,
    image_prompt: joinSentences(style.positive, setting, description, characterNames.length ? `角色：${characterNames.join('、')}` : '', NO_SUBTITLES),
    // 视频接口只收分镜的视频提示词，台词要写进来模型才会用原生音频说出。
    video_prompt: joinSentences(
      style.positive,
      setting,
      description,
      action,
      movement ? `运镜：${movement}` : '',
      dialogueDirection(spoken, spokenLanguage),
      NO_SUBTITLES,
    ),
    continuity: {
      source_shot_id: text(shot.id),
      start_ms: Number(shot.start_ms),
      end_ms: Number(shot.end_ms),
      opening_state: localizeText(stripSubtitleMentions(shot.opening_state), names, glossary),
      ending_state: localizeText(stripSubtitleMentions(shot.ending_state), names, glossary),
    },
  };
}

function groupShotsByScene(mapped, scenes) {
  // 连续且主场景相同的镜头合并为同一场；只用 scene_id 引用，不设 scene_number，避免引用键串场。
  // 地点与时间取已本地化的场景（完全转绘时是目标国家的地点），分镜上显示的地点才和场景一致。
  const groups = [];
  for (const { shot, sceneId } of mapped) {
    const last = groups[groups.length - 1];
    if (last && last.scene_id === sceneId) {
      last.shots.push(shot);
      continue;
    }
    const scene = scenes.find((item) => item.scene_id === sceneId);
    groups.push({
      scene_id: sceneId || `shot-group-${groups.length + 1}`,
      // 场景没有地点时 mapScenes 会用编号兜底，分镜上不显示编号。
      location: (scene && scene.location !== scene.scene_id ? text(scene.location) : '') || undefined,
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

// 剑气、飞刃、光芒、法阵这类画面特效不是道具：出道具图后会被当成实物参考
// （#98 第 18 镜样片里漫天细小飞刃，成片变成一把巨剑；#98 道具表里有「橙红色环形剑阵能量」「覆盖石台的橙红色网格穹顶」）。
// 中文名按「的」之后的核心词结尾判断，「火焰纹长剑」「能量饮料」这类以实物结尾的仍是道具。
const EFFECT_PROP_ZH = /(?:剑气|刀气|剑芒|刀芒|剑影|刀光|剑光|剑雨|刀雨|飞刃|万剑|千刃|刀山|阵|阵法|阵纹|光芒|光束|光柱|光圈|光环|光罩|光晕|光幕|光效|光球|光波|光影|灵光|特效|幻境|幻象|幻影|残影|虚影|结界|穹顶|气浪|气流|气场|气劲|灵力|真气|内力|能量|火焰|烈焰|火光|雷电|闪电|雷光|烟雾|雾气|漩涡|冲击波|护盾|屏障|速度线|集中线)$/;
// 成群、悬空的东西也是画面效果（#98「环绕Sari的多柄悬空长剑」），不是某个人手里的那一件实物。
const EFFECT_PROP_SWARM_ZH = /多柄|数柄|无数|漫天|成群|悬空|漂浮/;
const EFFECT_PROP_EN = /\b(?:sword (?:energy|qi|light|rain)|light beams?|beams? of light|aura|glow|energy (?:wave|ball|blast|shield)|lightning|illusion|magic (?:circle|formation|array)|(?:spell|qi|energy) effects?|force field|barrier|shock ?wave|speed lines|visual effects?)$/i;

function isVisualEffectProp(prop) {
  const name = text(prop?.name);
  if (!CJK_TEXT.test(name)) return EFFECT_PROP_EN.test(name.replace(/[.\s]+$/, ''));
  const core = cjkPropCore(name);
  return EFFECT_PROP_ZH.test(core) || EFFECT_PROP_SWARM_ZH.test(core);
}

// 同一件实物的不同叫法合成一个道具。分析按段做、同一把剑发光与否，会被写成好几个道具
// （2026-10-04 作品 9 / 工厂 #107：红衣女子所持长剑、红衣女子手中的长剑、橙红光长剑、橙红光芒长剑；#98 里 Sari 的剑也有 4 个），
// 每个都出道具图，同一把剑在各镜头就长得不一样。持有人相同、物品短语末两字（核心名词）相同的合成一个；
// 没写持有人的，只有全剧只有一个人拿这种东西时才并过去，有两个以上的人拿就不并。保留出现镜头最多的叫法，时间段取并集。
function unionRanges(ranges) {
  const sorted = list(ranges)
    .map((range) => ({ start_ms: Number(range?.start_ms), end_ms: Number(range?.end_ms) }))
    .filter((range) => Number.isFinite(range.start_ms) && range.end_ms > range.start_ms)
    .sort((a, b) => a.start_ms - b.start_ms);
  const merged = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.start_ms <= last.end_ms) last.end_ms = Math.max(last.end_ms, range.end_ms);
    else merged.push({ ...range });
  }
  return merged;
}

function mergeSameObjectProps(facts, people) {
  const props = list(facts.props);
  const identities = new Map();
  for (const prop of props) {
    const id = text(prop?.id);
    const name = text(prop?.name);
    if (!id || !CJK_TEXT.test(name) || isVisualEffectProp(prop)) continue;
    const object = propObjectPhrase(name, people);
    if (object.length < 2) continue;
    identities.set(id, { holder: people.find((person) => name.includes(person)) || '', head: object.slice(-2), object });
  }
  const groups = new Map();
  const add = (key, id) => groups.set(key, [...(groups.get(key) || []), id]);
  for (const [id, identity] of identities) if (identity.holder) add(JSON.stringify([identity.holder, identity.head]), id);
  for (const [id, identity] of identities) {
    if (identity.holder) continue;
    const owners = [...groups.keys()].filter((key) => JSON.parse(key)[1] === identity.head && JSON.parse(key)[0]);
    if (owners.length === 1) add(owners[0], id);
    else if (owners.length === 0) add(JSON.stringify(['', identity.head]), id);
  }
  const byId = new Map(props.map((prop) => [text(prop?.id), prop]));
  const shotCount = (prop) => list(facts.shots).filter((shot) => overlaps(prop?.evidence_ranges, shot)).length;
  const canonicalOf = new Map();
  const mergedById = new Map();
  for (const ids of groups.values()) {
    if (ids.length < 2) continue;
    const members = ids.map((id) => byId.get(id));
    const canonical = [...members].sort((a, b) => shotCount(b) - shotCount(a)
      || identities.get(text(a.id)).object.length - identities.get(text(b.id)).object.length
      || props.indexOf(a) - props.indexOf(b))[0];
    for (const member of members) canonicalOf.set(text(member.id), text(canonical.id));
    mergedById.set(text(canonical.id), {
      ...canonical,
      evidence_ranges: unionRanges(members.flatMap((member) => list(member.evidence_ranges))),
    });
  }
  return {
    facts: canonicalOf.size
      ? {
        ...facts,
        props: props
          .filter((prop) => !canonicalOf.has(text(prop?.id)) || canonicalOf.get(text(prop.id)) === text(prop.id))
          .map((prop) => mergedById.get(text(prop?.id)) || prop),
      }
      : facts,
    canonicalOf,
  };
}

function isKeyProp(prop, facts) {
  if (isVisualEffectProp(prop)) return false;
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

// 群演外形：完全转绘用目标国家的形象，否则用分析出的外形（按原名词表换名字）。
function crowdLooks(facts, names, glossary, culture) {
  const looks = new Map();
  for (const character of list(facts.characters).filter(isGroupCharacter)) {
    const id = text(character.id);
    const localized = text(culture.characters[id]?.appearance);
    const look = localized ? replaceCharacterIds(localized, names) : localizeText(character.appearance, names, glossary);
    if (look) looks.set(id, look);
  }
  return looks;
}

// 按硬切拆出的镜头常不足 1 秒；每个都单独出一段视频（模型最短 4 秒）会让整集变长、费用变高。
// 同一场景里相邻的极短镜头并成一个分镜（不超过 6 秒），视频提示词按画面顺序写清每次硬切。
const BEAT_MIN_MS = 2500;
const BEAT_MAX_MS = 6000;
const QUICK_SHOT_MS = 1500;

function sourceMs(shot) {
  return Number(shot.continuity.end_ms) - Number(shot.continuity.start_ms);
}

function combineQuickCuts(parts, number, { style, setting, spokenLanguage }) {
  const first = parts[0];
  const last = parts[parts.length - 1];
  const startMs = Number(first.continuity.start_ms);
  const endMs = Number(last.continuity.end_ms);
  const lines = parts.flatMap((part) => text(part.dialogue).split('\n').map(text).filter(Boolean));
  const speakers = parts.filter((part) => text(part.dialogue)).map((part) => part.solo_speaker_id);
  const numbered = (field) => parts.map((part, index) => (text(part[field]) ? `画面${index + 1}：${text(part[field])}` : '')).filter(Boolean);
  return {
    shot_number: number,
    title: `镜头 ${number}`,
    description: numbered('description').join(' '),
    duration: Math.max(1, Math.round((endMs - startMs) / 1000)),
    dialogue: lines.join('\n'),
    solo_speaker_id: speakers.length && speakers.every((id) => id && id === speakers[0]) ? speakers[0] : '',
    action: numbered('action').join(' '),
    movement: numbered('movement').join('；'),
    shot_type: first.shot_type,
    characters: [...new Set(parts.flatMap((part) => part.characters))],
    props: [...new Set(parts.flatMap((part) => part.props))],
    // 分镜图是第一帧，只画第一个画面。
    image_prompt: first.image_prompt,
    video_prompt: joinSentences(
      style.positive,
      setting,
      `本镜头由 ${parts.length} 个画面组成，画面之间硬切`,
      ...parts.map((part, index) => `画面${index + 1}（约 ${(sourceMs(part) / 1000).toFixed(1)} 秒）：${joinSentences(
        part.description, part.action, part.movement ? `运镜：${part.movement}` : '',
      )}`),
      dialogueDirection(lines.map((line) => ({ text: line })), spokenLanguage),
      NO_SUBTITLES,
    ),
    continuity: {
      source_shot_id: first.continuity.source_shot_id,
      source_shot_ids: parts.map((part) => part.continuity.source_shot_id),
      start_ms: startMs,
      end_ms: endMs,
      opening_state: first.continuity.opening_state,
      ending_state: last.continuity.ending_state,
    },
  };
}

function groupQuickCuts(items, context) {
  const beats = [];
  for (const item of items) {
    const last = beats[beats.length - 1];
    const lastMs = last ? Number(item.shot.continuity.start_ms) - Number(last.parts[0].continuity.start_ms) : 0;
    const ms = sourceMs(item.shot);
    if (last && last.sceneId === item.sceneId && lastMs + ms <= BEAT_MAX_MS && (lastMs < BEAT_MIN_MS || ms < QUICK_SHOT_MS)) {
      last.parts.push(item.shot);
    } else {
      beats.push({ sceneId: item.sceneId, parts: [item.shot] });
    }
  }
  return beats.map((beat, index) => ({
    sceneId: beat.sceneId,
    shot: beat.parts.length === 1
      ? { ...beat.parts[0], shot_number: index + 1, title: `镜头 ${index + 1}` }
      : combineQuickCuts(beat.parts, index + 1, context),
  }));
}

function buildRedrawFactoryPackage({
  sourceFacts,
  localization = null,
  analysisSettings = {},
  title = '',
  characterImages = {},
  propIds = null,
  voicedCharacterIds = [],
} = {}) {
  const inputFacts = sourceFacts || {};
  if (inputFacts.schema_version !== '2.0' || !Array.isArray(inputFacts.shots) || inputFacts.shots.length === 0) {
    throw Object.assign(new Error('样片分析结果缺少可导入的镜头'), { code: 'REDRAW_FACTORY_FACTS_INVALID' });
  }
  const style = {
    positive: text(analysisSettings?.free_style?.positive),
    negative: text(analysisSettings?.free_style?.negative),
  };
  const names = characterNameMap(inputFacts, localization);
  // 道具名里认持有人：原名、显示名、本地化名字都算，长的先匹配。
  const people = [...new Set([
    ...list(inputFacts.characters).flatMap((character) => [character?.source_name, character?.display_name]),
    ...names.values(),
  ].map(text).filter(Boolean))].sort((a, b) => b.length - a.length);
  const { facts, canonicalOf } = mergeSameObjectProps(inputFacts, people);
  const culture = cultureOf(localization);
  const glossary = {
    ...(localization?.glossary || {}),
    ...nameGlossary(facts, names),
  };
  // 同一道具在不同段里名字略有差别（「林江的黑色双肩包」「黑色双肩包」）已由 mergeSameObjectProps 合成一个；
  // 不再按「的」后核心词去重，那样会把不同人的同类物品（两个人各自的长剑）删掉一个。
  const selectedPropIds = new Set(propIds
    ? [...propIds].map((id) => canonicalOf.get(text(id)) || text(id))
    : list(facts.props).filter((prop) => isKeyProp(prop, facts)).map((prop) => text(prop.id)));
  let previousLastSubtitle = '';
  const spokenLanguage = spokenLanguageOf(localization);
  const groupLooks = crowdLooks(facts, names, glossary, culture);
  const mappedShots = [...facts.shots]
    .sort((left, right) => Number(left.start_ms) - Number(right.start_ms))
    .map((shot) => {
      const { last_subtitle_source: lastSubtitle, ...mapped } = mapShot(facts, shot, {
        names, glossary, localization, style, propIds: selectedPropIds, previousLastSubtitle, setting: culture.setting, spokenLanguage, groupLooks,
      });
      previousLastSubtitle = lastSubtitle;
      return { sceneId: primarySceneId(facts, shot), shot: mapped };
    });
  // 按硬切拆镜的分析（facts_v2.shot_detection，R92 起）才并极短镜头；之前的分析照旧一镜一个分镜。
  const episodeShots = facts.shot_detection
    ? groupQuickCuts(mappedShots, { style, setting: culture.setting, spokenLanguage })
    : mappedShots;
  const characters = mapCharacters(facts, names, glossary, characterImages, culture)
    .map((character) => (style.negative ? { ...character, negative_prompt: style.negative } : character));
  const voiceCasting = markVoiceCastingShots(episodeShots.map((item) => item.shot), characters, voicedCharacterIds);
  const scenes = mapScenes(facts, style, glossary, names, culture);
  // 完全转绘的剧情梗概已是目标国家版本（新名字、新地点），只解析角色编号；否则用原梗概按名词表替换名字。
  const story = culture.story.length
    ? culture.story.map((line) => replaceCharacterIds(line, names))
    : list(facts.story).map((line) => localizeText(line, names, glossary)).filter(Boolean);
  return {
    source: { title, locked_facts: list(facts.locked_facts).map((line) => localizeText(line, names, glossary)) },
    normalized_script: {
      logline: story[0] || '',
      summary: story.join(' '),
      target_duration_seconds: Math.round(Number(facts.duration_ms || 0) / 1000),
    },
    characters,
    scenes,
    props: mapProps(facts, style, glossary, names, culture).filter((prop) => selectedPropIds.has(prop.prop_id)),
    episodes: [{
      episode_number: 1,
      title: title || '第 1 集',
      description: (culture.episodeHook
        ? replaceCharacterIds(culture.episodeHook, names)
        : localizeText(facts.episode_hook, names, glossary)) || null,
      scenes: groupShotsByScene(episodeShots, scenes),
    }],
    continuity_rules: [...list(facts.causal_chain), ...list(facts.reversals)].map((line) => localizeText(line, names, glossary)),
    voice_casting: voiceCasting,
  };
}

// 定音镜头：每个说话角色第一次单独说话的镜头。先生成这些镜头，后台会从中提取该角色的音色，
// 之后他再出场的镜头自动带上同一段声音。标题里写明，方便在工厂里先挑出来生成。
function markVoiceCastingShots(shots, characters, voicedCharacterIds = []) {
  const byId = new Map(characters.map((character) => [character.character_id, character.name]));
  const casting = [];
  // 整部剧追加的集：已经有音色的老角色不再定音。
  const cast = new Set([...voicedCharacterIds].map(text));
  for (const shot of shots) {
    const id = shot.solo_speaker_id;
    if (!id || cast.has(id) || !byId.has(id)) continue;
    cast.add(id);
    shot.title = `${shot.title} · ${byId.get(id)} 定音`;
    casting.push({ character_id: id, name: byId.get(id), shot_number: shot.shot_number });
  }
  return casting;
}

module.exports = {
  buildRedrawFactoryPackage,
  isKeyProp,
  isVisualEffectProp,
  propObjectPhrase,
  propStylePositive,
};
