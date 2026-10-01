'use strict';

/**
 * 样片转绘 → 短剧工厂的「完全转绘」本地化：按用户选的目标语言 + 目标国家，把人物名字、人物形象、台词、
 * 场景与道具的文化元素全部换成该国的，再由导入服务建工厂项目。通用于任何已验证文本能力的语言与国家，
 * 不针对某一段样片。
 *
 * 输入是分析结果文件里的 facts_v2（台词只存在 facts_v2 的字幕里，旧的 v1 facts 没有台词文本）。
 * 输出存成一条独立的 redraw_versions 记录（locale/market、name_map、text_map、culture_map），
 * 用 localization_model_snapshot_json.kind 标记，不影响旧流水线的本地化版本。
 *
 * 计费：按已验证的目标语言文本模型价格预扣，成功结算、失败退回；同一作品同一目标只收一次。
 * 模型调用在后台运行，前端轮询；服务重启遗留的任务在下次查询时按超时失败处理并退款。
 */

const creditLedger = require('./creditLedgerService');
const modelPrice = require('./modelPriceService');
const taskService = require('./taskService');
const capabilityService = require('./redrawCapabilityService');
const seriesCast = require('./redrawSeriesCastService');

const KIND = 'factory_localization@1';
// 本地化结果的内容版本：结果里多了必须有的内容就加 1，旧版本不再算"已生成"，用户可以重新生成（重新收费）。
// 2：增加目标国家的剧情梗概（剧集剧本正文）；3：角色称呼按名字首字母大写，场景地点用自然的中文说法；4：剧情梗概必须是简体中文。
const OUTPUT_SCHEMA = 4;
const TASK_TYPE = 'redraw_factory_localization';
const STALE_TASK_MS = 20 * 60 * 1000;
// 文本模型走流式输出：这是「多久没有新输出就算卡住」的时限，不是总时长。
const MODEL_SILENCE_TIMEOUT_MS = 180000;
const HAN = /[一-鿿]/;

// 语言只验证到语种级（没有 market）时，由用户在这些国家里选目标国家。
const COUNTRIES_BY_LANGUAGE = {
  es: ['MX', 'ES', 'AR', 'CO', 'CL', 'PE', 'US'],
  en: ['US', 'GB', 'CA', 'AU', 'PH', 'SG'],
  pt: ['BR', 'PT'],
  fr: ['FR', 'CA'],
  de: ['DE'],
  it: ['IT'],
  ja: ['JP'],
  ko: ['KR'],
  id: ['ID'],
  ms: ['MY', 'SG', 'BN'],
  fil: ['PH'],
  th: ['TH'],
  vi: ['VN'],
  tr: ['TR'],
  ar: ['SA', 'AE', 'EG'],
  ru: ['RU'],
  hi: ['IN'],
};

function codedError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code }, extra);
}

function text(value) {
  return value == null ? '' : String(value).trim();
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function parseJson(value, fallback) {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

// 流式返回偶尔在一段完整的 JSON 之后又接着第二段输出（上游在同一次推送里重发或再生成一次；2026-10-01 英语版
// 总长 9431、报错位置 4716，越南语版 9670 / 5414）。整体解析失败时从开头起逐段取出完整的 JSON 对象（按括号配对，
// 跳过字符串里的括号），用答案内容最多的一段（2026-10-01 印尼语第 2 集补问：第一段只有 318 字，后面 4754 字的
// 第二段才是补全的台词和梗概，只取第一段会把补问结果丢掉，整集失败），之后照常走校验与补问；
// 开头那段本身不完整的，仍按“不是合法 JSON”失败并退款。
function leadingJsonObject(value, from = 0) {
  const start = value.slice(from).search(/\S/) + from;
  if (start < from || value[start] !== '{') return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const char = value[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        try { return { value: JSON.parse(value.slice(start, index + 1)), start, end: index + 1 }; } catch (_) { return null; }
      }
    }
  }
  return null;
}

// 答案内容有多少：各个结果列表的条目数，加上设定句和钩子；不是对象的算 -1。
const ANSWER_LISTS = ['characters', 'scenes', 'props', 'lines', 'screen_texts', 'story', 'culture_terms'];

function answerSize(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return -1;
  return ANSWER_LISTS.reduce((sum, key) => sum + list(value[key]).length, 0)
    + (text(value.setting) ? 1 : 0) + (text(value.episode_hook) ? 1 : 0);
}

// 开头一段之后接着的完整 JSON 对象（中间可以隔着 ``` 之类的围栏）；遇到不完整的一段就停。
function jsonObjects(body) {
  const objects = [];
  let found = leadingJsonObject(body);
  while (found) {
    objects.push(found);
    const next = body.indexOf('{', found.end);
    found = next < 0 ? null : leadingJsonObject(body, next);
  }
  return objects;
}

function parseModelJson(raw, onTrailing) {
  if (typeof raw !== 'string') return raw;
  const body = raw.replace(/^```(?:json)?\s*|\s*```$/g, '');
  try {
    return JSON.parse(body);
  } catch (error) {
    const objects = jsonObjects(body);
    if (!objects.length) throw codedError('REDRAW_FACTORY_LOCALIZATION_INVALID', `本地化结果不是合法 JSON：${error.message}`);
    // 内容一样多时取长的一段，再一样就取前面的。
    const used = objects.reduce((best, item) => {
      const size = answerSize(item.value);
      const bestSize = answerSize(best.value);
      if (size !== bestSize) return size > bestSize ? item : best;
      return item.end - item.start > best.end - best.start ? item : best;
    });
    const first = objects[0];
    const trailing = body.slice(first.end).trim();
    if (typeof onTrailing === 'function') {
      onTrailing({
        json_length: first.end,
        trailing_length: trailing.length,
        trailing_is_json: /^(?:```|\{)/.test(trailing),
        objects: objects.length,
        used: objects.indexOf(used) + 1,
        used_length: used.end - used.start,
      });
    }
    return used.value;
  }
}

function displayName(code, type, lang) {
  try {
    return new Intl.DisplayNames([lang], { type }).of(code) || code;
  } catch (_) {
    return code;
  }
}

function baseLanguage(locale) {
  return text(locale).split(/[-_]/)[0].toLowerCase();
}

function describeTarget(locale, market) {
  const lang = baseLanguage(locale);
  return {
    locale: text(locale),
    market: text(market).toUpperCase(),
    key: `${text(locale)}-${text(market).toUpperCase()}`,
    label: `${displayName(lang, 'language', 'zh-CN')}（${displayName(text(market).toUpperCase(), 'region', 'zh-CN')}）`,
    language_en: displayName(lang, 'language', 'en'),
    country_en: displayName(text(market).toUpperCase(), 'region', 'en'),
    allows_han: ['zh', 'ja'].includes(lang),
  };
}

// 可选目标：已验证文本能力的语言；该语言已验证到国家的直接用那个国家，只到语种级的给出候选国家。
function listTargets(db, canReadArtifact) {
  const targets = [];
  for (const capability of capabilityService.listLocaleCapabilities(db, canReadArtifact)) {
    const verified = capabilityService.resolveVerifiedLocaleCapability(db, {
      locale: capability.locale, market: capability.market, capability: 'text', canReadArtifact,
    });
    if (!verified) continue;
    const markets = capability.market
      ? [capability.market]
      : (COUNTRIES_BY_LANGUAGE[baseLanguage(capability.locale)] || []);
    for (const market of markets) {
      targets.push({ ...describeTarget(capability.locale, market), capability_market: capability.market });
    }
  }
  return targets;
}

function resolveTarget(db, canReadArtifact, locale, market) {
  const wanted = `${text(locale)}-${text(market).toUpperCase()}`;
  const target = listTargets(db, canReadArtifact).find((item) => item.key === wanted);
  if (!target) throw codedError('REDRAW_FACTORY_LOCALIZATION_TARGET_UNSUPPORTED', '所选语言或国家还没有通过验证，暂不能转绘');
  return target;
}

function quote(db, canReadArtifact, target) {
  const capability = capabilityService.resolveVerifiedLocaleCapability(db, {
    locale: target.locale, market: target.capability_market, capability: 'text', canReadArtifact,
  });
  if (!capability) throw codedError('REDRAW_FACTORY_LOCALIZATION_TARGET_UNSUPPORTED', '所选语言还没有通过文本能力验证');
  return { model: capability.model, credits: modelPrice.requirePrice(db, capability.model) };
}

function readyVersion(db, owner, work, sourceVersion, target) {
  return db.prepare(`
    SELECT * FROM redraw_versions
    WHERE work_id = ? AND tenant_id = ? AND user_id = ? AND locale = ? AND market = ?
      AND facts_hash = ? AND status = 'asset_review' AND deleted_at IS NULL
      AND localization_model_snapshot_json LIKE ? AND localization_model_snapshot_json LIKE ?
    ORDER BY id DESC LIMIT 1
  `).get(work.id, owner.tenantId, owner.userId, target.locale, target.market, sourceVersion.facts_hash,
    `%"${KIND}"%`, `%"schema":${OUTPUT_SCHEMA}%`);
}

function latestTask(db, owner, work, target) {
  return db.prepare(`
    SELECT * FROM async_tasks
    WHERE type = ? AND resource_id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
      AND metadata LIKE ?
    ORDER BY created_at DESC LIMIT 1
  `).get(TASK_TYPE, String(work.id), owner.tenantId, owner.userId, `%"target":"${target.key}"%`);
}

function failTask(db, task, message) {
  taskService.updateTaskError(db, task.id, message);
  const reservation = task.credit_reservation_id ? creditLedger.getReservation(db, task.credit_reservation_id) : null;
  if (reservation?.status === 'held') creditLedger.refund(db, task.credit_reservation_id, message);
}

// 服务重启会丢掉进程内的后台任务：超时仍在处理中的任务按失败处理并退款，用户可以重新发起。
function settleStaleTask(db, task) {
  if (!task || !['pending', 'processing'].includes(task.status)) return task;
  if (Date.now() - Date.parse(task.updated_at || task.created_at) < STALE_TASK_MS) return task;
  failTask(db, task, '转绘本地化任务中断（服务重启或超时），已退款，请重新发起');
  return db.prepare('SELECT * FROM async_tasks WHERE id = ?').get(task.id);
}

function operationKey(db, tenantId, work, sourceVersion, target) {
  const base = `redraw_factory_localization:${work.id}:${sourceVersion.facts_hash.slice(0, 16)}:${target.key}`;
  for (let attempt = 1; attempt <= 1000; attempt += 1) {
    const key = attempt === 1 ? base : `${base}:attempt:${attempt}`;
    const existing = db.prepare('SELECT status FROM tenant_usage_reservations WHERE tenant_id = ? AND operation_key = ?')
      .get(String(tenantId), key);
    if (!existing || existing.status === 'held') return key;
  }
  throw codedError('REDRAW_FACTORY_LOCALIZATION_ATTEMPTS_EXHAUSTED', '转绘本地化重试次数过多');
}

function compactFacts(facts) {
  const subtitles = [];
  const screenTexts = [];
  for (const shot of list(facts.shots)) {
    for (const region of list(shot?.text_regions)) {
      const source = text(region?.source_text);
      if (!source) continue;
      const key = `${text(shot.id)}:${text(region.id)}`;
      if (!text(region.kind) || region.kind === 'subtitle') {
        subtitles.push({ key, speaker_id: text(region.speaker_id) || null, text: source });
      } else {
        screenTexts.push({ key, text: source });
      }
    }
  }
  return {
    characters: list(facts.characters).map((c) => ({
      id: text(c?.id),
      source_name: text(c?.source_name) || text(c?.display_name),
      // 分析给的拼音名（如 "Lu Feiyu"），剧情梗概里常用它指代人物，也要换掉。
      ...(text(c?.display_name) && text(c?.display_name) !== text(c?.source_name) ? { display_name: text(c.display_name) } : {}),
      relationship: text(c?.relationship),
      appearance: text(c?.appearance),
    })),
    scenes: list(facts.scenes).map((s) => ({ id: text(s?.id), location: text(s?.location), time: text(s?.time), visual: text(s?.visual) })),
    props: list(facts.props).map((p) => ({ id: text(p?.id), name: text(p?.name) })),
    story: list(facts.story).map(text).filter(Boolean),
    episode_hook: text(facts.episode_hook),
    subtitles,
    screen_texts: screenTexts,
    shot_texts: shotTexts(facts),
  };
}

const MAX_SHOT_TEXTS = 40;
const MAX_SHOT_TEXT_CHARS = 80;

// 镜头构图与动作的原文（去重、截短）：只给模型找出要换成目标国家说法的文化词，不翻译它们。
function shotTexts(facts) {
  const seen = new Set();
  const lines = [];
  for (const shot of list(facts.shots)) {
    for (const value of [shot?.composition, shot?.continuous_action]) {
      const line = text(value).slice(0, MAX_SHOT_TEXT_CHARS);
      if (!line || seen.has(line)) continue;
      seen.add(line);
      lines.push(line);
      if (lines.length >= MAX_SHOT_TEXTS) return lines;
    }
  }
  return lines;
}

function defaultStorageRoot() {
  const raw = require('../config').loadConfig()?.storage?.local_path || './data/storage';
  return require('path').isAbsolute(raw) ? raw : require('path').join(process.cwd(), raw);
}

// 前几集可作锁定来源的完全转绘版本：与当前分析版本对应、同一目标、已完成；不限结果版本号（锁定只用名字、形象和设定）。
function seriesVersion(db, owner, work, sourceVersion, target) {
  return db.prepare(`
    SELECT * FROM redraw_versions
    WHERE work_id = ? AND tenant_id = ? AND user_id = ? AND locale = ? AND market = ?
      AND facts_hash = ? AND status = 'asset_review' AND deleted_at IS NULL
      AND localization_model_snapshot_json LIKE ?
    ORDER BY id DESC LIMIT 1
  `).get(work.id, owner.tenantId, owner.userId, target.locale, target.market, sourceVersion.facts_hash, `%"${KIND}"%`);
}

const MAX_WORLD_STORY_EPISODES = 5;
const MAX_WORLD_STORY_CHARS = 600;
const MAX_WORLD_PLACES = 30;
// 文化词对照（原片的门派、机构、称谓、货币等 → 目标国家的说法），导入时替换镜头描述与提示词里的原词。
const MAX_CULTURE_TERMS = 30;

function emptySeriesLock() {
  return { byName: new Map(), episodes: [], names: [], world: { setting: '', story: [], places: [], terms: {} } };
}

/**
 * 整部剧：同一转绘项目里前几集已完成的同目标完全转绘版本，把每个角色（按原名）的本地化名字、形象、身份锁定下来。
 * 本集遇到同一个人就沿用，不让模型重新起名、重画形象。读不到的前几集跳过，不影响本集。
 * 同时收集前几集用过的全部新名字（names），本集的新角色不能再用，否则工厂里会被当成同一个人、音色也会串。
 * 世界设定（world）：第 1 集的设定句、前几集的本地化剧情梗概和已出现的地点，本集沿用同一个世界、同名地点。
 * @returns {{ byName: Map<string, {name, appearance, role}>, episodes: number[], names: string[],
 *   world: { setting: string, story: string[], places: Array<{location, time, visual}> } }}
 */
function seriesLocalizationLock(db, owner, work, target, { storageRoot, log } = {}) {
  const lock = emptySeriesLock();
  if (!work?.project_id) return lock;
  const { loadRedrawSource } = require('./redrawFactoryImportService');
  const root = storageRoot || defaultStorageRoot();
  const names = new Set();
  const places = new Set();
  for (const workId of seriesCast.earlierWorks(db, work)) {
    try {
      // 只认前几集当前分析结果对应的转绘版本；重新分析过的集，旧版本的角色编号已对不上。
      const source = loadRedrawSource(db, owner, workId, root);
      const version = seriesVersion(db, owner, source.work, source.sourceVersion, target);
      if (!version) continue;
      const nameMap = parseJson(version.name_map_json, {});
      const culture = parseJson(version.culture_map_json, {}) || {};
      const cultureCharacters = culture.characters || {};
      let used = false;
      for (const character of list(source.sourceFacts.characters)) {
        const id = text(character?.id);
        const locked = { name: text(nameMap[id]), appearance: text(cultureCharacters[id]?.appearance), role: text(cultureCharacters[id]?.role) };
        if (!locked.name) continue;
        names.add(locked.name);
        for (const key of [character.source_name, character.display_name].map(text).filter(Boolean)) {
          if (!lock.byName.has(key)) { lock.byName.set(key, locked); used = true; }
        }
      }
      if (used) lock.episodes.push(workId);
      // 设定以最早一集为准；梗概按集保留；地点按"地点 + 时间"去重。
      if (!lock.world.setting && text(culture.setting)) lock.world.setting = text(culture.setting);
      const story = list(culture.story).map(text).filter(Boolean).join('');
      if (story) lock.world.story.push(story.slice(0, MAX_WORLD_STORY_CHARS));
      for (const scene of Object.values(culture.scenes || {})) {
        const location = text(scene?.location);
        const key = `${location}|${text(scene?.time)}`;
        if (!location || places.has(key) || lock.world.places.length >= MAX_WORLD_PLACES) continue;
        places.add(key);
        lock.world.places.push({ location, time: text(scene?.time), visual: text(scene?.visual).slice(0, 160) });
      }
      // 文化词对照以先出现的一集为准，后面的集沿用同一说法。
      for (const [source, targetTerm] of Object.entries(parseJson(version.glossary_json, {}) || {})) {
        if (!text(source) || !text(targetTerm) || lock.world.terms[text(source)]) continue;
        if (Object.keys(lock.world.terms).length >= MAX_CULTURE_TERMS) break;
        lock.world.terms[text(source)] = text(targetTerm);
      }
    } catch (error) {
      log?.info?.('[整部剧] 前一集的转绘结果读不到，跳过锁定', { work_id: workId, code: error?.code || null });
    }
  }
  lock.names = [...names];
  lock.world.story = lock.world.story.slice(-MAX_WORLD_STORY_EPISODES);
  return lock;
}

// 读取锁定失败（例如配置或文件异常）不能挡住本集转绘：记日志，按单集转绘处理。
function safeSeriesLock(db, owner, work, target, options = {}) {
  try {
    return seriesLocalizationLock(db, owner, work, target, options);
  } catch (error) {
    options.log?.warn?.('[整部剧] 读取前几集转绘结果失败，本集按单集转绘', { work_id: work?.id, code: error?.code || null, message: error?.message });
    return emptySeriesLock();
  }
}

// 整部剧：设定句直接用第 1 集的，保证每个镜头提示词里的"故事发生在……"各集一致。
function applySeriesWorld(parsed, world) {
  const setting = text(world?.setting);
  return setting ? { ...(parsed || {}), setting } : parsed;
}

// 场景和道具要用简体中文写：引号外出现的外文单词（拉丁字母，含越南语等带声调的字母；泰文、假名、韩文等非汉字文字），
// 只允许是角色名字（本集新名字、沿用的名字、前几集用过的名字）。引号里的是招牌、标语等画面文字，可以是目标语言。
// 单个字母（T恤、U盘）不算。统一按 NFC 比较，同一个带声调的名字不会因为编码形式不同被当成外文。
const QUOTED_TEXT = /“[^”]*”|"[^"]*"|「[^」]*」|『[^』]*』|‘[^’]*’/g;
const FOREIGN_WORD = /(?:(?!\p{Script=Han})[\p{L}\p{M}]){2,}/gu;
const NAME_WORD_SEPARATOR = /[\s'’\-·・]+/;

// 名字按空格、连字符、间隔号拆成词；汉字与假名混写的名字（ゆき子）再把其中的非汉字部分也算作名字。
function knownNameWords(parsed, series = {}) {
  const names = [
    ...list(parsed?.characters).map((character) => text(character?.name)),
    ...Object.values(series.locked || {}).map((value) => text(value?.name)),
    ...list(series.taken).map(text),
  ].map((name) => name.normalize('NFC'));
  return new Set(names.flatMap((name) => [...name.split(NAME_WORD_SEPARATOR), ...(name.match(FOREIGN_WORD) || [])])
    .map((word) => word.toLowerCase()).filter(Boolean));
}

function foreignWords(value, known) {
  const outside = text(value).normalize('NFC').replace(QUOTED_TEXT, ' ');
  return (outside.match(FOREIGN_WORD) || []).filter((word) => !known.has(word.toLowerCase()));
}

// 梗概里允许出现的人名：本集角色的新名字、沿用的锁定名字和前几集用过的名字。
function storyNameList(parsed, series = {}) {
  return [
    ...list(parsed?.characters).map((character) => text(character?.name)),
    ...Object.values(series.locked || {}).map((value) => text(value?.name)),
    ...list(series.taken).map(text),
  ].filter(Boolean);
}

// 梗概同样用简体中文写：引号外的拉丁字母单词只能是角色名字。模型另起了剧中没有的名字（例如补问时没对上新名字）也算。
function storyForeignWords(parsed, series = {}) {
  const known = knownNameWords(parsed, series);
  return [...new Set(list(parsed?.story).flatMap((line) => foreignWords(line, known)))];
}

// 补问梗概时告诉模型每个角色已经定好的新名字，否则模型会另起一套名字，梗概和角色对不上。
function storyCharacterNames(parsed) {
  return list(parsed?.characters).filter((item) => item && text(item.id) && text(item.name))
    .map((item) => ({ id: text(item.id), name: text(item.name) }));
}

function foreignTextItems(compact, parsed, series) {
  const known = knownNameWords(parsed, series);
  const byId = (items) => new Map(list(items).filter((item) => item && text(item.id)).map((item) => [text(item.id), item]));
  const scenes = byId(parsed?.scenes);
  const props = byId(parsed?.props);
  return {
    scenes: compact.scenes.filter((scene) => {
      const out = scenes.get(scene.id);
      return Boolean(out) && [out.location, out.time, out.visual].some((value) => foreignWords(value, known).length);
    }),
    props: compact.props.filter((prop) => {
      const out = props.get(prop.id);
      return Boolean(out) && foreignWords(out.name, known).length > 0;
    }),
  };
}

// 场景、道具里夹了英文或剧中没有的人名：并入"要补问"的条目，一起再问一次（不重新收费）。
function withForeignText(missing, compact, parsed, series) {
  const foreign = foreignTextItems(compact, parsed, series);
  const count = foreign.scenes.length + foreign.props.length;
  if (!count) return missing;
  const names = list(parsed?.characters).filter((item) => item && text(item.id) && text(item.name))
    .map((item) => ({ id: text(item.id), name: text(item.name) }));
  return {
    ...missing,
    scenes: foreign.scenes,
    props: foreign.props,
    character_names: names,
    count: missing.count + count,
  };
}

function normalizedName(value) {
  return text(value).toLowerCase().replace(/[\s　]+/g, '');
}

// 整部剧：不在锁定名单里的角色是新的人，名字不能和前几集的任何人相同。
function nameConflicts(compact, names, { locked = {}, taken = [] } = {}) {
  const used = new Set(list(taken).map(normalizedName).filter(Boolean));
  if (!used.size) return [];
  return compact.characters
    .filter((character) => !locked[character.id])
    .map((character) => ({ id: character.id, name: text(names[character.id]) }))
    .filter((item) => item.name && used.has(normalizedName(item.name)));
}

// 重名的新角色并入"要补问"的条目，一起再问一次（不重新收费）。
function withNameConflicts(missing, target, compact, parsed, series) {
  const taken = list(series?.taken).map(text).filter(Boolean);
  if (!taken.length) return missing;
  const names = Object.fromEntries(list(parsed?.characters).filter((item) => item && text(item.id))
    .map((item) => [text(item.id), capitalizeName(text(item.name), target.locale)]));
  const listed = new Set(missing.characters.map((character) => character.id));
  const extra = nameConflicts(compact, names, series)
    .map((item) => compact.characters.find((character) => character.id === item.id))
    .filter((character) => character && !listed.has(character.id));
  return {
    ...missing,
    characters: [...missing.characters, ...extra],
    count: missing.count + extra.length,
    names_in_use: taken,
    renamed_ids: nameConflicts(compact, names, series).map((item) => item.id),
  };
}

/** 本集角色里能在前几集找到的，给出锁定的名字、形象、身份（按本集角色 id）。 */
function lockedCharacters(compact, lock) {
  const locked = {};
  for (const character of compact.characters) {
    const hit = [character.source_name, character.display_name].map(text).filter(Boolean).map((key) => lock.byName.get(key)).find(Boolean);
    if (hit) locked[character.id] = hit;
  }
  return locked;
}

// 名字前后不能紧挨拉丁字母（避免把 Ana 换进 Anabel）；中文紧挨名字不影响。
const NAME_EDGE = 'A-Za-zÀ-ÖØ-öø-ɏ';

function renameAll(value, renames) {
  if (typeof value !== 'string' || !renames.size) return value;
  const names = [...renames.keys()].sort((a, b) => b.length - a.length)
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(`(?<![${NAME_EDGE}])(${names.join('|')})(?![${NAME_EDGE}])`, 'g');
  // 一次替换全部名字，两个角色被模型互换了名字也不会连锁换错。
  return value.replace(pattern, (match) => renames.get(match) || match);
}

// 台词、屏幕文字、梗概和钩子里的旧名字换成新名字。
function renameTextFields(parsed, renames) {
  if (!renames.size) return parsed;
  const out = { ...parsed };
  const renameTexts = (items) => list(items).map((item) => (item && typeof item.text === 'string' ? { ...item, text: renameAll(item.text, renames) } : item));
  if (Array.isArray(out.lines)) out.lines = renameTexts(out.lines);
  if (Array.isArray(out.screen_texts)) out.screen_texts = renameTexts(out.screen_texts);
  if (Array.isArray(out.story)) out.story = out.story.map((line) => renameAll(line, renames));
  if (typeof out.episode_hook === 'string') out.episode_hook = renameAll(out.episode_hook, renames);
  return out;
}

// 锁定的角色直接用前几集的结果覆盖模型输出，保证整部剧同一个人名字、形象不变；
// 模型给他起了别的名字时，台词、屏幕文字、梗概和钩子里的那个名字也一并换回锁定的名字。
function applyLockedCharacters(parsed, locked) {
  if (!Object.keys(locked).length) return parsed;
  const byId = new Map(list(parsed?.characters).filter((item) => item && text(item.id)).map((item) => [text(item.id), item]));
  const renames = new Map();
  for (const [id, value] of Object.entries(locked)) {
    const previous = text(byId.get(id)?.name);
    if (previous && previous !== value.name) renames.set(previous, value.name);
    byId.set(id, { ...(byId.get(id) || {}), id, name: value.name, appearance: value.appearance || byId.get(id)?.appearance, role: value.role || byId.get(id)?.role });
  }
  return renameTextFields({ ...(parsed || {}), characters: [...byId.values()] }, renames);
}

// 因和前几集重名而补问改了名的新角色：第一次回答里的台词、梗概还用着旧名字，一并换成新名字。
// 旧名字恰好也是本集锁定角色的名字时分不清指的是谁，不换。
function renameConflictedCharacters(before, after, ids, locked) {
  const lockedNames = new Set(Object.values(locked).map((value) => value.name));
  const oldNames = new Map(list(before?.characters).filter((item) => item && text(item.id)).map((item) => [text(item.id), text(item.name)]));
  const renames = new Map();
  for (const item of list(after?.characters)) {
    const id = text(item?.id);
    const previous = oldNames.get(id);
    const next = text(item?.name);
    if (ids.includes(id) && previous && next && previous !== next && !lockedNames.has(previous)) renames.set(previous, next);
  }
  return renameTextFields(after, renames);
}

function buildPrompt(target, compact, locked = {}, taken = [], world = {}) {
  const system = [
    'Return strict JSON only.',
    `You are fully re-localizing a short drama for ${target.country_en}. The finished drama must look and sound as if it were made in ${target.country_en} for ${target.country_en} viewers.`,
    `Every person becomes a person from ${target.country_en}, every line is spoken in ${target.language_en} as used in ${target.country_en}, and every place and prop belongs to ${target.country_en}.`,
    'Keep the plot, relationships, ages, body builds, emotions, actions and the role clothing plays in the story (for example a shared school uniform) exactly; change names, ethnicity and looks, language, and cultural details.',
    'Return this JSON shape: {"characters":[{"id":"","name":"","role":"","appearance":""}],"scenes":[{"id":"","location":"","time":"","visual":""}],"props":[{"id":"","name":""}],"lines":[{"key":"","text":""}],"screen_texts":[{"key":"","text":""}],"story":[""],"episode_hook":"","setting":"","culture_terms":[{"source":"","target":""}],"pinyin_terms":[""],"name_terms":[{"source":"","pinyin":"","transliteration":""}]}',
    `characters: exactly one entry for EVERY supplied id, including groups and crowds, never skip one. name is a natural first name common in ${target.country_en} written as locals write it; for unnamed roles (mother, father, an athlete on TV) use a short natural ${target.language_en} role label, and for a group of people use a short plural ${target.language_en} label (for example the equivalent of "classmates"); these labels are used as the character's name, so capitalize them the way a name is written (for example "Mamá", "Compañeros"). appearance describes a person from ${target.country_en}: apparent age, build, skin tone, face, hair, and ${target.country_en}-style clothing that keeps the same story role; write appearance in Simplified Chinese and never mention the old name. role is a short Simplified Chinese description of the person's place in the story using the new names.`,
    `scenes: one entry for every supplied id; move the place to ${target.country_en}: location is a short, natural Simplified Chinese place name that a native Chinese screenwriter would write (for example "中学小卖部门口", "老街区铁门外", "家中餐厅"), never a word-by-word translation of the source wording (not "学校门面入口"), time is the time of day in Simplified Chinese, visual describes ${target.country_en} architecture, signage in ${target.language_en}, street details, lighting and palette in Simplified Chinese; no Chinese characters on signs.`,
    'props: one entry for every supplied id; Simplified Chinese name of the equivalent local object.',
    'In scenes and props, refer to people only by their new names from characters (or locked_characters), and put any sign or on-screen wording inside quotation marks; everything else is Simplified Chinese.',
    `lines: one entry for every supplied subtitle key; translate the line into natural spoken ${target.language_en} as used in ${target.country_en}, same meaning, tone and length, replacing any old character names with the new names. A Chinese surname or given name inside a form of address (for example 李长老, 王师兄, 小美) names a person: use that character's new name (or a natural ${target.country_en} form of address built from it), or a natural ${target.country_en} name for someone who is not one of the characters; never keep a Chinese personal name, neither in Hanyu Pinyin nor transliterated into ${target.language_en} (for example not "Elder Li"). Names of sects, schools, organizations, places, titles and techniques from the source become the names of this ${target.country_en} version (or plain ${target.language_en} words) in lines too; never write them in Hanyu Pinyin (for example not "Qingyun Academy"). screen_texts: same for on-screen text keys.`,
    'pinyin_terms: the Hanyu Pinyin without tone marks of every proper noun (sect, school, organization, place, title or technique) that appears in the supplied Chinese texts, both joined and with spaces between syllables (for example "Qingyun", "Qing Yun"); no character names; [] when there are none. This list is only used to check lines.',
    `name_terms: every Chinese personal name, surname or nickname in the supplied subtitles, including those inside forms of address (for example 李 in 李长老, 王 in 王师兄, 小美): source is the Chinese characters exactly as they appear, pinyin is the Hanyu Pinyin without tone marks written like a name (for example "Li", "Xiaomei"), transliteration is how the name would usually be spelled in ${target.language_en} if it were transliterated instead of replaced (for example Thai "หลี่", Vietnamese "Lý"; the same as pinyin when ${target.language_en} has no own spelling); [] when there are none. This list is only used to check lines.`,
    `story: the supplied story retold as the plot of the ${target.country_en} drama, written in Simplified Chinese (not in ${target.language_en}; only the new names keep their own spelling), one paragraph per supplied story entry, same events in the same order, using only the new names and the new places; never use any old name (source_name or display_name) and never mention subtitles, captions or on-screen text, tell what the characters say or intend instead. episode_hook: the supplied episode_hook retold the same way in one Simplified Chinese sentence.`,
    `setting: one Simplified Chinese sentence stating the story takes place in ${target.country_en} and all people are from ${target.country_en}.`,
    `culture_terms: words or short phrases in the supplied Chinese texts (story, scenes, props, character relationships, shot_texts) that belong to the source culture and must change for the ${target.country_en} version (sects and schools, ranks and titles, institutions, currencies, foods, festivals, typical kinds of places), each with the natural Simplified Chinese wording that fits the ${target.country_en} version and matches the scenes you return, for example {"source":"宗门","target":"修院"}. At most 20 entries; every source must appear verbatim in the supplied texts and have at least two Chinese characters; never list character names; leave out words that need no change. shot_texts are given only for finding culture_terms: do not translate or return them.`,
    'Do not add, drop or rename ids or keys.',
  ];
  const lockedList = Object.entries(locked).map(([id, value]) => ({ id, ...value }));
  const namesInUse = list(taken).map(text).filter(Boolean);
  if (lockedList.length) {
    system.push('locked_characters appeared in earlier episodes of the same series: return each of them with exactly the given name, appearance and role, and use these names in lines, screen_texts, story and episode_hook.');
  }
  if (namesInUse.length) {
    system.push('names_in_use are the names of people in earlier episodes of the same series: every character that is not in locked_characters is a different person and must get a name that is not in names_in_use.');
  }
  const seriesSetting = text(world.setting);
  const previousStory = list(world.story).map(text).filter(Boolean);
  const knownPlaces = list(world.places).filter((place) => text(place?.location));
  if (seriesSetting || previousStory.length || knownPlaces.length) {
    system.push('This episode continues a series: series_setting and previous_story describe the world and the plot of earlier episodes. Keep this episode in the same world, with the same institutions, organizations, families and recurring places, and never move it to a different kind of place.');
  }
  if (seriesSetting) system.push('Return exactly series_setting as setting.');
  if (knownPlaces.length) {
    system.push('known_places are places already shown in earlier episodes: when a scene of this episode happens in one of them, return exactly the same location and time and a matching visual.');
  }
  const knownTerms = Object.entries(world.terms || {}).filter(([source, value]) => text(source) && text(value))
    .map(([source, value]) => ({ source: text(source), target: text(value) }));
  if (knownTerms.length) {
    system.push('known_terms are culture_terms already chosen in earlier episodes: use the same target wording for the same source in scenes, props, story and your culture_terms.');
  }
  const series = {
    ...(lockedList.length ? { locked_characters: lockedList } : {}),
    ...(namesInUse.length ? { names_in_use: namesInUse } : {}),
    ...(seriesSetting ? { series_setting: seriesSetting } : {}),
    ...(previousStory.length ? { previous_story: previousStory } : {}),
    ...(knownPlaces.length ? { known_places: knownPlaces } : {}),
    ...(knownTerms.length ? { known_terms: knownTerms } : {}),
  };
  return { system: system.join('\n'), user: JSON.stringify({ ...compact, ...series }) };
}

// 原片人名（中文名与拼音名），剧情梗概里出现就说明没换干净。
function oldNames(compact) {
  return [...new Set(compact.characters.flatMap((c) => [c.source_name, c.display_name]).map(text).filter((name) => name.length >= 2))];
}

const SUBTITLE_WORDS = /字幕|subtitle|caption/i;
const HAN_GLOBAL = /[一-鿿]/g;
const NON_HAN_LETTER_GLOBAL = /(?!\p{Script=Han})\p{L}/gu;

// 汉字和其它文字的字母（拉丁、泰文、假名、韩文……）各有多少：先去掉允许夹带的人名（长的先去），人名再多也不算外文。
function scriptCounts(value, names = []) {
  let rest = text(value).normalize('NFC');
  for (const name of [...new Set(list(names).map((item) => text(item).normalize('NFC')).filter(Boolean))].sort((a, b) => b.length - a.length)) {
    rest = rest.split(name).join(' ');
  }
  return {
    han: (rest.match(HAN_GLOBAL) || []).length,
    letters: (rest.match(NON_HAN_LETTER_GLOBAL) || []).length,
  };
}

// 梗概和简介在工厂里和形象、地点描述放在一起，统一用简体中文；夹带目标语言人名不算，汉字要占多数。
function isMostlyChinese(value, names = []) {
  const { han, letters } = scriptCounts(value, names);
  return han > 0 && han >= letters;
}

// 本地化剧情梗概的问题：缺失、不是中文、带原名、带剧中没有的人名或提到字幕都要重问。
function storyProblem(compact, parsed, series = {}) {
  if (!compact.story.length) return false;
  const story = list(parsed?.story).map(text).filter(Boolean);
  if (!story.length) return true;
  const names = oldNames(compact);
  return !isMostlyChinese(story.join(''), storyNameList(parsed, series))
    || storyForeignWords(parsed, series).length > 0
    || story.some((line) => SUBTITLE_WORDS.test(line) || names.some((name) => line.includes(name)));
}

// 台词里不能留原片专有名词的汉语拼音（门派、学院、地名、称号……；2026-10-01 马来语版 "Akademi Qingyun"）。
// 模型在 pinyin_terms 里报出原片专有名词的拼音，台词里整词出现（不分大小写，音节间空格、连字符可有可无）就补问这几句。
// 少于 5 个字母的不查（免得误伤目标语言的普通词），和新角色名相同的不算。
const PINYIN_TERM = /^[A-Za-z]+(?:[\s'-][A-Za-z]+)*$/;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function pinyinLines(compact, parsed) {
  const names = new Set(list(parsed?.characters).map((item) => text(item?.name).toLowerCase()).filter(Boolean));
  const patterns = [...new Set(list(parsed?.pinyin_terms).map(text))]
    .filter((term) => PINYIN_TERM.test(term) && term.replace(/[^A-Za-z]/g, '').length >= 5 && !names.has(term.toLowerCase()))
    .map((term) => ({
      term,
      pattern: new RegExp(`(?<!\\p{L})${term.split(/[\s'-]+/).map(escapeRegExp).join("[\\s'-]?")}(?!\\p{L})`, 'iu'),
    }));
  if (!patterns.length) return { keys: [], terms: [] };
  const lines = new Map(list(parsed?.lines).filter((item) => item && text(item.key)).map((item) => [text(item.key), text(item.text).normalize('NFC')]));
  const keys = [];
  const terms = new Set();
  for (const line of list(compact.subtitles)) {
    const value = lines.get(line.key);
    const found = value ? patterns.filter(({ pattern }) => pattern.test(value)) : [];
    if (!found.length) continue;
    keys.push(line.key);
    for (const { term } of found) terms.add(term);
  }
  return { keys, terms: [...terms] };
}

// 台词里也不能留原片人名的任何写法（2026-10-01 泰语版第 2 集"李长老这是下死手了"译成 ผู้อาวุโสหลี่：姓"李"被音译成泰文，
// 拼音检查查不到）。模型在 name_terms 里报出原片台词里的中文人名、姓氏（含"李长老""王师兄"这类称呼里的姓）和它的拼音、
// 目标语言音译；只查原文这一句里确实有这个名字的台词。拉丁字母的写法按整词命中，而且要首字母大写（拼音 Yang、He 和
// 印尼语 yang、英语 he 同形，小写的普通词不算）；泰文、假名等没有词间空格的文字按子串命中；允许汉字的目标语言（日语）
// 原来的汉字也算。和本剧角色名字（本集新名字、沿用的名字、前几集用过的名字）里的词相同、或是名字一部分的写法不算。
const LATIN_NAME_FORM = /^[\p{Script=Latin}\p{M}]+(?:[\s'’-][\p{Script=Latin}\p{M}]+)*$/u;
const UPPER_START = /^\p{Lu}/u;

function nameFormMatcher(form) {
  if (!LATIN_NAME_FORM.test(form)) return (value) => value.includes(form);
  const pattern = new RegExp(`(?<![\\p{L}\\p{M}])${form.split(/[\s'’-]+/).map(escapeRegExp).join("[\\s'’-]?")}(?![\\p{L}\\p{M}])`, 'giu');
  return (value) => [...value.matchAll(pattern)].some((match) => UPPER_START.test(match[0]));
}

function nameTermLines(target, compact, parsed, series = {}) {
  const names = storyNameList(parsed, series).map((name) => name.normalize('NFC'));
  const nameWords = knownNameWords(parsed, series);
  const terms = [];
  for (const item of list(parsed?.name_terms)) {
    const source = text(item?.source);
    if (!HAN.test(source)) continue;
    const forms = [...new Set([text(item?.pinyin), text(item?.transliteration), ...(target.allows_han ? [source] : [])]
      .map((form) => form.normalize('NFC')).filter(Boolean))]
      .filter((form) => HAN.test(form) || (form.match(/\p{L}/gu) || []).length >= 2)
      .filter((form) => (LATIN_NAME_FORM.test(form)
        ? !form.split(/[\s'’-]+/).every((word) => nameWords.has(word.toLowerCase()))
        : !names.some((name) => name.includes(form))))
      .map((form) => ({ form, matches: nameFormMatcher(form) }));
    if (forms.length) terms.push({ source, forms });
  }
  if (!terms.length) return { keys: [], terms: [] };
  const lines = new Map(list(parsed?.lines).filter((item) => item && text(item.key)).map((item) => [text(item.key), text(item.text).normalize('NFC')]));
  const keys = [];
  const kept = new Map();
  for (const line of list(compact.subtitles)) {
    const value = lines.get(line.key);
    if (!value) continue;
    const hits = terms.filter((term) => text(line.text).includes(term.source))
      .flatMap((term) => term.forms.filter(({ matches }) => matches(value)).map(({ form }) => [term.source, form]));
    if (!hits.length) continue;
    keys.push(line.key);
    for (const [source, form] of hits) kept.set(source, [...new Set([...(kept.get(source) || []), form])]);
  }
  return { keys, terms: [...kept].map(([source, forms]) => ({ source, kept: forms })) };
}

// 模型偶尔漏掉个别条目（例如"同学们"这类群体角色没给名字）：只把缺的条目再问一次，不重新收费。
function missingItems(target, compact, parsed, series = {}) {
  const badHan = (value) => !target.allows_han && HAN.test(value);
  const characters = new Map(list(parsed?.characters).filter((item) => item && text(item.id)).map((item) => [text(item.id), item]));
  const lines = new Map(list(parsed?.lines).filter((item) => item && text(item.key)).map((item) => [text(item.key), text(item.text)]));
  const missingCharacters = compact.characters.filter((character) => {
    const out = characters.get(character.id);
    return !text(out?.name) || badHan(text(out?.name)) || !text(out?.appearance);
  });
  const pinyin = pinyinLines(compact, parsed);
  const kept = nameTermLines(target, compact, parsed, series);
  const missingLines = compact.subtitles.filter((line) => !lines.get(line.key) || badHan(lines.get(line.key))
    || pinyin.keys.includes(line.key) || kept.keys.includes(line.key));
  const story = storyProblem(compact, parsed, series);
  return {
    characters: missingCharacters,
    subtitles: missingLines,
    setting: !text(parsed?.setting),
    story,
    ...(story ? { story_names: storyCharacterNames(parsed) } : {}),
    ...(pinyin.keys.length ? { pinyin_lines: pinyin.keys, pinyin_terms: pinyin.terms } : {}),
    ...(kept.keys.length ? { name_lines: kept.keys, name_terms: kept.terms, line_names: storyCharacterNames(parsed) } : {}),
    count: missingCharacters.length + missingLines.length + (text(parsed?.setting) ? 0 : 1) + (story ? 1 : 0),
  };
}

function buildRepairPrompt(target, compact, missing) {
  const world = missing.world || {};
  const base = buildPrompt(target, compact, {}, missing.names_in_use || [], world);
  const foreign = list(missing.scenes).length + list(missing.props).length;
  const characterNames = list(missing.character_names).length ? missing.character_names
    : (list(missing.story_names).length ? missing.story_names : list(missing.line_names));
  return {
    system: `${base.system}\nYour previous answer left out or broke the items below. Return the same JSON shape containing only these items, completed.${foreign
      ? '\nThe scenes and props below contained English words or names of people who are not characters: rewrite their location, time, visual and name in Simplified Chinese, refer to people only by the names in character_names, and keep sign wording inside quotation marks.'
      : ''}${missing.story && characterNames.length
      ? '\nRetell the story in Simplified Chinese and refer to every person only by the name given for their id in character_names (all_characters lists the same ids with the original names); never invent other names.'
      : ''}${list(missing.pinyin_lines).length
      ? `\nThe lines for some subtitles below kept the Hanyu Pinyin of source names (pinyin_terms): translate them again in natural spoken ${target.language_en} as used in ${target.country_en} and use the names of this ${target.country_en} version instead, never the pinyin.`
      : ''}${list(missing.name_lines).length
      ? `\nThe lines for some subtitles below kept Chinese personal names (name_terms lists each source name with the spellings found in your lines): translate them again in natural spoken ${target.language_en} as used in ${target.country_en} and refer to each person by the new name given for their id in character_names (all_characters lists the same ids with the original names and relationships), or by a natural ${target.country_en} name or form of address for someone who is not one of the characters; never a Chinese name in any form.`
      : ''}`,
    user: JSON.stringify({
      characters: missing.characters,
      subtitles: missing.subtitles,
      need_setting: missing.setting,
      ...(list(missing.names_in_use).length ? { names_in_use: missing.names_in_use } : {}),
      ...(list(missing.scenes).length ? { scenes: missing.scenes } : {}),
      ...(list(missing.props).length ? { props: missing.props } : {}),
      ...(characterNames.length ? { character_names: characterNames } : {}),
      ...(list(missing.pinyin_terms).length ? { pinyin_terms: missing.pinyin_terms } : {}),
      ...(list(missing.name_terms).length ? { name_terms: missing.name_terms } : {}),
      // 认出"李长老"指的是谁要看原名和身份；要重写梗概时下面会一起给。
      ...(list(missing.name_lines).length && !missing.story ? { all_characters: compact.characters } : {}),
      ...(text(world.setting) ? { series_setting: text(world.setting) } : {}),
      ...(list(world.story).length ? { previous_story: list(world.story) } : {}),
      ...(list(world.places).length ? { known_places: list(world.places) } : {}),
      // 重写梗概需要知道原名与新名字的对应，所以把全部角色和原梗概一起给。
      ...(missing.story ? {
        need_story: true,
        all_characters: compact.characters,
        story: compact.story,
        episode_hook: compact.episode_hook,
      } : {}),
    }),
  };
}

function mergeOutputs(first, repair) {
  const merged = { ...(first || {}) };
  const byId = (items, key) => new Map(list(items).filter((item) => item && text(item[key])).map((item) => [text(item[key]), item]));
  const characters = byId(first?.characters, 'id');
  for (const item of list(repair?.characters)) if (item && text(item.id)) characters.set(text(item.id), item);
  const lines = byId(first?.lines, 'key');
  for (const item of list(repair?.lines)) if (item && text(item.key)) lines.set(text(item.key), item);
  const scenes = byId(first?.scenes, 'id');
  for (const item of list(repair?.scenes)) if (item && text(item.id)) scenes.set(text(item.id), { ...(scenes.get(text(item.id)) || {}), ...item });
  const props = byId(first?.props, 'id');
  for (const item of list(repair?.props)) if (item && text(item.id)) props.set(text(item.id), { ...(props.get(text(item.id)) || {}), ...item });
  merged.characters = [...characters.values()];
  merged.lines = [...lines.values()];
  merged.scenes = [...scenes.values()];
  merged.props = [...props.values()];
  if (!text(merged.setting) && text(repair?.setting)) merged.setting = repair.setting;
  if (list(repair?.story).map(text).some(Boolean)) {
    merged.story = repair.story;
    if (text(repair?.episode_hook)) merged.episode_hook = repair.episode_hook;
  }
  return merged;
}

// 称呼（mamá、compañeros）当作角色名用，首字母按目标语言大写；没有大小写的文字（中文、日文）不变。
function capitalizeName(name, locale) {
  const first = name.charAt(0);
  let upper = first;
  try { upper = first.toLocaleUpperCase(locale || undefined); } catch (_) { upper = first.toUpperCase(); }
  return upper === first ? name : `${upper}${name.slice(1)}`;
}

const NON_HAN_LETTER = /(?!\p{Script=Han})\p{L}/u;

/**
 * 文化词对照：前几集已定的说法优先（known），再收本集模型给的。原词必须在原文里出现、至少两个汉字、不是人名，
 * 新说法必须是简体中文（不含拉丁、泰文、假名等其它文字的字母）；不合格的条目直接丢弃，不补问。
 * @returns {Record<string,string>} 原词 → 目标国家的说法
 */
function cultureTerms(compact, parsed, known = {}) {
  const corpus = [
    ...list(compact.story), compact.episode_hook,
    ...list(compact.scenes).flatMap((scene) => [scene.location, scene.time, scene.visual]),
    ...list(compact.props).map((prop) => prop.name),
    ...list(compact.characters).map((character) => character.relationship),
    ...list(compact.shot_texts),
  ].map(text).filter(Boolean).join('\n');
  const names = list(compact.characters).flatMap((character) => [character.source_name, character.display_name]).map(text).filter(Boolean);
  const terms = {};
  for (const [source, value] of Object.entries(known || {})) {
    if (text(source) && text(value) && Object.keys(terms).length < MAX_CULTURE_TERMS) terms[text(source)] = text(value);
  }
  for (const item of list(parsed?.culture_terms)) {
    if (Object.keys(terms).length >= MAX_CULTURE_TERMS) break;
    const source = text(item?.source);
    const value = text(item?.target);
    if (!source || !value || source === value || terms[source]) continue;
    if ((source.match(HAN_GLOBAL) || []).length < 2 || !HAN.test(value) || NON_HAN_LETTER.test(value)) continue;
    if (!corpus.includes(source)) continue;
    if (names.some((name) => name.includes(source) || source.includes(name))) continue;
    terms[source] = value;
  }
  return terms;
}

function validateOutput(target, compact, parsed, series = {}) {
  const byId = (items) => new Map(list(items).filter((item) => item && text(item.id)).map((item) => [text(item.id), item]));
  const byKey = (items) => new Map(list(items).filter((item) => item && text(item.key)).map((item) => [text(item.key), text(item.text)]));
  const characters = byId(parsed?.characters);
  const scenes = byId(parsed?.scenes);
  const props = byId(parsed?.props);
  const lines = byKey(parsed?.lines);
  const screens = byKey(parsed?.screen_texts);
  const badHan = (value) => !target.allows_han && HAN.test(value);

  const nameMap = {};
  const cultureCharacters = {};
  for (const character of compact.characters) {
    const out = characters.get(character.id);
    const name = capitalizeName(text(out?.name), target.locale);
    const appearance = text(out?.appearance);
    if (!name || badHan(name)) throw codedError('REDRAW_FACTORY_LOCALIZATION_INVALID', `角色 ${character.id} 缺少目标语言名字`);
    if (!appearance) throw codedError('REDRAW_FACTORY_LOCALIZATION_INVALID', `角色 ${character.id} 缺少目标国家形象`);
    nameMap[character.id] = name;
    cultureCharacters[character.id] = { appearance, ...(text(out?.role) ? { role: text(out.role) } : {}) };
  }
  const conflict = nameConflicts(compact, nameMap, series)[0];
  if (conflict) {
    throw codedError('REDRAW_FACTORY_LOCALIZATION_INVALID', `角色 ${conflict.id} 的名字「${conflict.name}」已被本剧前几集的其他角色使用`);
  }
  const textMap = {};
  for (const line of compact.subtitles) {
    const translated = lines.get(line.key);
    if (!translated || badHan(translated)) throw codedError('REDRAW_FACTORY_LOCALIZATION_INVALID', `台词 ${line.key} 没有译成目标语言`);
    textMap[line.key] = translated;
  }
  for (const screen of compact.screen_texts) {
    const translated = screens.get(screen.key);
    if (translated && !badHan(translated)) textMap[screen.key] = translated;
  }
  const cultureScenes = {};
  for (const scene of compact.scenes) {
    const out = scenes.get(scene.id);
    if (text(out?.location) || text(out?.visual) || text(out?.time)) {
      cultureScenes[scene.id] = { location: text(out?.location) || null, time: text(out?.time) || null, visual: text(out?.visual) || null };
    }
  }
  const cultureProps = {};
  for (const prop of compact.props) {
    const name = text(props.get(prop.id)?.name);
    if (name) cultureProps[prop.id] = { name };
  }
  const setting = text(parsed?.setting);
  if (!setting) throw codedError('REDRAW_FACTORY_LOCALIZATION_INVALID', '缺少目标国家设定');
  const story = list(parsed?.story).map(text).filter(Boolean);
  if (compact.story.length && !story.length) throw codedError('REDRAW_FACTORY_LOCALIZATION_INVALID', '缺少目标国家的剧情梗概');
  const allowedNames = [...Object.values(nameMap), ...storyNameList({}, series)];
  if (story.length && !isMostlyChinese(story.join(''), allowedNames)) {
    // 日志里留下计数和开头一小段，便于判断是整段写成了外文还是夹带了太多外文。
    throw codedError('REDRAW_FACTORY_LOCALIZATION_INVALID', '剧情梗概没有用简体中文写', {
      detail: { ...scriptCounts(story.join(''), allowedNames), sample: story.join('').slice(0, 120) },
    });
  }
  const leaked = oldNames(compact).find((name) => story.some((line) => line.includes(name)));
  if (leaked) throw codedError('REDRAW_FACTORY_LOCALIZATION_INVALID', `剧情梗概里还有原片人名「${leaked}」`);
  const episodeHook = isMostlyChinese(parsed?.episode_hook, allowedNames) ? text(parsed.episode_hook) : '';
  return {
    nameMap,
    textMap,
    cultureMap: {
      kind: KIND,
      target: target.key,
      setting,
      characters: cultureCharacters,
      scenes: cultureScenes,
      props: cultureProps,
      story,
      ...(episodeHook && !oldNames(compact).some((name) => episodeHook.includes(name)) ? { episode_hook: episodeHook } : {}),
    },
    glossary: cultureTerms(compact, parsed, series.terms),
  };
}

function insertVersion(db, owner, work, sourceVersion, target, model, output, taskId, reservationId) {
  const now = new Date().toISOString();
  const next = Number(db.prepare('SELECT MAX(version) AS v FROM redraw_versions WHERE work_id = ?').get(work.id)?.v || 0) + 1;
  const result = db.prepare(`
    INSERT INTO redraw_versions (work_id, tenant_id, user_id, version, locale, market, localization_level,
      name_map_json, text_map_json, glossary_json, culture_map_json, localization_model_snapshot_json,
      localization_task_id, localization_credit_reservation_id, facts_hash, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'full', ?, ?, ?, ?, ?, ?, ?, ?, 'asset_review', ?, ?)
  `).run(
    work.id, owner.tenantId, owner.userId, next, target.locale, target.market,
    JSON.stringify(output.nameMap), JSON.stringify(output.textMap), JSON.stringify(output.glossary || {}), JSON.stringify(output.cultureMap),
    JSON.stringify({
      kind: KIND, schema: OUTPUT_SCHEMA, model, target: target.key, source_version_id: Number(sourceVersion.id),
      ...(output.seriesLock?.locked_character_ids?.length ? { series_lock: output.seriesLock } : {}),
    }),
    taskId, reservationId, sourceVersion.facts_hash, now, now,
  );
  return Number(result.lastInsertRowid);
}

async function runLocalization(db, log, ctx, deps) {
  const { owner, work, sourceVersion, sourceFacts, target, model, taskId, reservationId } = ctx;
  const lock = ctx.seriesLock || emptySeriesLock();
  const task = { id: taskId, credit_reservation_id: reservationId };
  try {
    taskService.updateTaskStatus(db, taskId, 'processing', 30, '正在生成目标国家的名字、形象与台词');
    const compact = compactFacts(sourceFacts);
    const generateText = deps.generateText || require('./aiClient').generateText;
    const ask = async (prompt) => {
      const raw = await generateText(db, log, 'text', prompt.user, prompt.system, {
        model, json_mode: true, temperature: 0.4, min_max_tokens: 12000, silence_timeout_ms: MODEL_SILENCE_TIMEOUT_MS,
      });
      return parseModelJson(raw, (info) => log?.warn?.('redraw factory localization output had trailing content after the JSON', {
        task_id: taskId, ...info,
      }));
    };
    const locked = lockedCharacters(compact, lock);
    const world = lock.world || {};
    const series = { locked, taken: list(lock.names), terms: world.terms || {} };
    let parsed = applySeriesWorld(applyLockedCharacters(await ask(buildPrompt(target, compact, locked, series.taken, world)), locked), world);
    const missing = withForeignText(
      withNameConflicts(missingItems(target, compact, parsed, series), target, compact, parsed, series), compact, parsed, series,
    );
    if (missing.count) {
      log?.warn?.('redraw factory localization repairing missing items', {
        task_id: taskId, characters: missing.characters.map((c) => c.id), lines: missing.subtitles.length, setting: missing.setting,
        scenes: list(missing.scenes).map((scene) => scene.id), props: list(missing.props).map((prop) => prop.id),
        ...(list(missing.pinyin_terms).length ? { pinyin_terms: missing.pinyin_terms } : {}),
        ...(list(missing.name_terms).length ? { name_terms: missing.name_terms } : {}),
      });
      taskService.updateTaskStatus(db, taskId, 'processing', 70, '正在补全遗漏的名字、形象或台词');
      const merged = mergeOutputs(parsed, await ask(buildRepairPrompt(target, compact, { ...missing, world })));
      parsed = applySeriesWorld(applyLockedCharacters(renameConflictedCharacters(parsed, merged, list(missing.renamed_ids), locked), locked), world);
      const leftover = foreignTextItems(compact, parsed, series);
      const storyWords = storyForeignWords(parsed, series);
      const pinyinLeft = pinyinLines(compact, parsed);
      const namesLeft = nameTermLines(target, compact, parsed, series);
      if (leftover.scenes.length || leftover.props.length || storyWords.length || pinyinLeft.keys.length || namesLeft.keys.length) {
        log?.warn?.('redraw factory localization still has foreign text after repair', {
          task_id: taskId, scenes: leftover.scenes.map((scene) => scene.id), props: leftover.props.map((prop) => prop.id),
          story_words: storyWords.slice(0, 10), pinyin_lines: pinyinLeft.keys, pinyin_terms: pinyinLeft.terms,
          name_lines: namesLeft.keys, name_terms: namesLeft.terms,
        });
      }
    }
    const output = validateOutput(target, compact, parsed, series);
    output.seriesLock = {
      episodes: lock.episodes,
      locked_character_ids: Object.keys(locked),
      world: { setting: Boolean(text(world.setting)), story_episodes: list(world.story).length, places: list(world.places).length },
    };
    const versionId = db.transaction(() => {
      const id = insertVersion(db, owner, work, sourceVersion, target, model, output, taskId, reservationId);
      taskService.updateTaskResult(db, taskId, { version_id: id, target: target.key });
      creditLedger.settleGeneration(db, reservationId, 'completed');
      return id;
    })();
    log?.info?.('redraw factory localization completed', {
      task_id: taskId, work_id: work.id, target: target.key, version_id: versionId,
      pinyin_terms: list(parsed?.pinyin_terms).map(text).filter(Boolean).slice(0, 10),
      name_terms: list(parsed?.name_terms).map((item) => text(item?.source)).filter(Boolean).slice(0, 10),
    });
    return versionId;
  } catch (error) {
    log?.warn?.('redraw factory localization failed', {
      task_id: taskId, work_id: work.id, message: error.message, ...(error.detail ? { detail: error.detail } : {}),
    });
    failTask(db, task, error.message || '转绘本地化失败');
    return null;
  }
}

// 整部剧：本版本沿用了前几集哪些角色（名字），没有沿用时不返回。
function seriesLockSummary(version) {
  const lock = parseJson(version?.localization_model_snapshot_json, {})?.series_lock;
  const ids = list(lock?.locked_character_ids).map(text).filter(Boolean);
  if (!ids.length) return {};
  const names = parseJson(version.name_map_json, {});
  return { series_lock: { characters: ids.map((id) => text(names[id])).filter(Boolean) } };
}

/**
 * 查询状态或发起一次完全转绘本地化。
 * @returns {{status:'ready'|'localizing'|'failed'|'none', credits, target, version_id?, task_id?, error?}}
 */
function localizationStatus(db, { owner, work, sourceVersion, target, canReadArtifact }) {
  const priced = quote(db, canReadArtifact, target);
  const base = { target: target.key, label: target.label, credits: priced.credits };
  const ready = readyVersion(db, owner, work, sourceVersion, target);
  if (ready) return { ...base, status: 'ready', version_id: Number(ready.id), ...seriesLockSummary(ready) };
  const task = settleStaleTask(db, latestTask(db, owner, work, target));
  if (task && ['pending', 'processing'].includes(task.status)) return { ...base, status: 'localizing', task_id: task.id };
  if (task && task.status === 'failed') return { ...base, status: 'failed', task_id: task.id, error: task.error || task.message || null };
  return { ...base, status: 'none' };
}

function startLocalization(db, log, { owner, work, sourceVersion, sourceFacts, target, expectedCredits, canReadArtifact }, deps = {}) {
  const current = localizationStatus(db, { owner, work, sourceVersion, target, canReadArtifact });
  if (current.status === 'ready' || current.status === 'localizing') return current;
  if (Number(expectedCredits) !== Number(current.credits)) {
    throw codedError('REDRAW_FACTORY_LOCALIZATION_QUOTE_CHANGED', '转绘本地化报价已变化，请重新确认', { quote: current.credits });
  }
  const { model } = quote(db, canReadArtifact, target);
  // 整部剧：前几集同目标的转绘结果锁定本集老角色的名字、形象、身份。先于预扣积分读取，读不到就按单集处理。
  const seriesLock = deps.seriesLock || safeSeriesLock(db, owner, work, target, { storageRoot: deps.storageRoot, log });
  const created = db.transaction(() => {
    creditLedger.ensureSchema(db);
    const reservation = creditLedger.reserve(db, {
      userId: owner.userId,
      tenantId: owner.tenantId,
      actorUserId: owner.userId,
      operationKey: operationKey(db, owner.tenantId, work, sourceVersion, target),
      amount: current.credits,
      model,
      resourceType: 'redraw_factory_localization',
      resourceId: work.id,
    });
    const task = taskService.createTask(db, log, TASK_TYPE, work.id);
    const now = new Date().toISOString();
    // createTask 会把数字 id 存成 "1.0"，这里和分析任务一样改写成字符串，查询才能按作品找到任务。
    db.prepare(`UPDATE async_tasks SET tenant_id = ?, user_id = ?, resource_id = ?, model = ?, credit_reservation_id = ?,
      status = 'processing', progress = 10, message = ?, metadata = ?, updated_at = ? WHERE id = ?`)
      .run(owner.tenantId, owner.userId, String(work.id), model, reservation.id, '转绘本地化已开始',
        JSON.stringify({ target: target.key, locale: target.locale, market: target.market }), now, task.id);
    return { taskId: task.id, reservationId: reservation.id };
  })();
  const ctx = { owner, work, sourceVersion, sourceFacts, target, model, seriesLock, ...created };
  const schedule = deps.schedule || ((job) => new Promise((resolve) => setImmediate(() => resolve(job()))));
  const completion = schedule(() => runLocalization(db, log, ctx, deps));
  taskService.trackInFlightTask(created.taskId, completion);
  return { target: target.key, label: target.label, credits: current.credits, status: 'localizing', task_id: created.taskId, completion };
}

/**
 * 整部导入的计划（只读，不扣费）：同一转绘项目（同一部剧）按集号排好的各集，每集在所选目标国家下的转绘状态和价格。
 * 还没分析完、读不到分析结果的集标出原因，前端据此提示先分析。credits_needed 是还要新生成的各集价格之和。
 */
function seriesPlan(db, { owner, work, target, canReadArtifact, storageRoot }) {
  const { loadRedrawSource } = require('./redrawFactoryImportService');
  const root = storageRoot || defaultStorageRoot();
  const episodes = seriesCast.projectWorks(db, work).map((row, index) => {
    const base = { work_id: Number(row.id), episode: index + 1, title: text(row.title) || null };
    try {
      const source = loadRedrawSource(db, owner, row.id, root);
      const status = localizationStatus(db, { owner, work: source.work, sourceVersion: source.sourceVersion, target, canReadArtifact });
      return {
        ...base, analysis_ready: true, status: status.status, credits: status.credits,
        ...(status.error ? { error: status.error } : {}),
      };
    } catch (error) {
      return { ...base, analysis_ready: false, status: 'unavailable', credits: null, error: error.message || '还没完成样片分析' };
    }
  });
  const creditsNeeded = episodes
    .filter((item) => item.analysis_ready && ['none', 'failed'].includes(item.status))
    .reduce((sum, item) => sum + (Number(item.credits) || 0), 0);
  return { episodes, credits_needed: creditsNeeded };
}

module.exports = {
  KIND,
  seriesLocalizationLock,
  lockedCharacters,
  applyLockedCharacters,
  nameConflicts,
  COUNTRIES_BY_LANGUAGE,
  listTargets,
  resolveTarget,
  localizationStatus,
  startLocalization,
  seriesPlan,
  buildPrompt,
  compactFacts,
  validateOutput,
  describeTarget,
  parseModelJson,
  pinyinLines,
  nameTermLines,
};
