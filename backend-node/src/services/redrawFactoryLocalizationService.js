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

const KIND = 'factory_localization@1';
// 本地化结果的内容版本：结果里多了必须有的内容就加 1，旧版本不再算"已生成"，用户可以重新生成（重新收费）。
// 2：增加目标国家的剧情梗概（剧集剧本正文）；3：角色称呼按名字首字母大写，场景地点用自然的中文说法。
const OUTPUT_SCHEMA = 3;
const TASK_TYPE = 'redraw_factory_localization';
const STALE_TASK_MS = 20 * 60 * 1000;
// 文本模型走流式输出：这是「多久没有新输出就算卡住」的时限，不是总时长。
const MODEL_SILENCE_TIMEOUT_MS = 180000;
const HAN = /[一-鿿]/;

// 语言只验证到语种级（没有 market）时，由用户在这些国家里选目标国家。
const COUNTRIES_BY_LANGUAGE = {
  es: ['MX', 'ES', 'AR', 'CO', 'CL', 'PE', 'US'],
  en: ['US', 'GB', 'CA', 'AU', 'PH'],
  pt: ['BR', 'PT'],
  fr: ['FR', 'CA'],
  de: ['DE'],
  it: ['IT'],
  ja: ['JP'],
  ko: ['KR'],
  id: ['ID'],
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
  };
}

function buildPrompt(target, compact) {
  const system = [
    'Return strict JSON only.',
    `You are fully re-localizing a short drama for ${target.country_en}. The finished drama must look and sound as if it were made in ${target.country_en} for ${target.country_en} viewers.`,
    `Every person becomes a person from ${target.country_en}, every line is spoken in ${target.language_en} as used in ${target.country_en}, and every place and prop belongs to ${target.country_en}.`,
    'Keep the plot, relationships, ages, body builds, emotions, actions and the role clothing plays in the story (for example a shared school uniform) exactly; change names, ethnicity and looks, language, and cultural details.',
    'Return this JSON shape: {"characters":[{"id":"","name":"","role":"","appearance":""}],"scenes":[{"id":"","location":"","time":"","visual":""}],"props":[{"id":"","name":""}],"lines":[{"key":"","text":""}],"screen_texts":[{"key":"","text":""}],"story":[""],"episode_hook":"","setting":""}',
    `characters: exactly one entry for EVERY supplied id, including groups and crowds, never skip one. name is a natural first name common in ${target.country_en} written as locals write it; for unnamed roles (mother, father, an athlete on TV) use a short natural ${target.language_en} role label, and for a group of people use a short plural ${target.language_en} label (for example the equivalent of "classmates"); these labels are used as the character's name, so capitalize them the way a name is written (for example "Mamá", "Compañeros"). appearance describes a person from ${target.country_en}: apparent age, build, skin tone, face, hair, and ${target.country_en}-style clothing that keeps the same story role; write appearance in Simplified Chinese and never mention the old name. role is a short Simplified Chinese description of the person's place in the story using the new names.`,
    `scenes: one entry for every supplied id; move the place to ${target.country_en}: location is a short, natural Simplified Chinese place name that a native Chinese screenwriter would write (for example "中学小卖部门口", "老街区铁门外", "家中餐厅"), never a word-by-word translation of the source wording (not "学校门面入口"), time is the time of day in Simplified Chinese, visual describes ${target.country_en} architecture, signage in ${target.language_en}, street details, lighting and palette in Simplified Chinese; no Chinese characters on signs.`,
    'props: one entry for every supplied id; Simplified Chinese name of the equivalent local object.',
    `lines: one entry for every supplied subtitle key; translate the line into natural spoken ${target.language_en} as used in ${target.country_en}, same meaning, tone and length, replacing any old character names with the new names. screen_texts: same for on-screen text keys.`,
    `story: the supplied story retold as the plot of the ${target.country_en} drama, one Simplified Chinese paragraph per supplied story entry, same events in the same order, using only the new names and the new places; never use any old name (source_name or display_name) and never mention subtitles, captions or on-screen text, tell what the characters say or intend instead. episode_hook: the supplied episode_hook retold the same way in one Simplified Chinese sentence.`,
    `setting: one Simplified Chinese sentence stating the story takes place in ${target.country_en} and all people are from ${target.country_en}.`,
    'Do not add, drop or rename ids or keys.',
  ].join('\n');
  return { system, user: JSON.stringify(compact) };
}

// 原片人名（中文名与拼音名），剧情梗概里出现就说明没换干净。
function oldNames(compact) {
  return [...new Set(compact.characters.flatMap((c) => [c.source_name, c.display_name]).map(text).filter((name) => name.length >= 2))];
}

const SUBTITLE_WORDS = /字幕|subtitle|caption/i;

// 本地化剧情梗概的问题：缺失、带原名或提到字幕都要重问。
function storyProblem(compact, parsed) {
  if (!compact.story.length) return false;
  const story = list(parsed?.story).map(text).filter(Boolean);
  if (!story.length) return true;
  const names = oldNames(compact);
  return story.some((line) => SUBTITLE_WORDS.test(line) || names.some((name) => line.includes(name)));
}

// 模型偶尔漏掉个别条目（例如"同学们"这类群体角色没给名字）：只把缺的条目再问一次，不重新收费。
function missingItems(target, compact, parsed) {
  const badHan = (value) => !target.allows_han && HAN.test(value);
  const characters = new Map(list(parsed?.characters).filter((item) => item && text(item.id)).map((item) => [text(item.id), item]));
  const lines = new Map(list(parsed?.lines).filter((item) => item && text(item.key)).map((item) => [text(item.key), text(item.text)]));
  const missingCharacters = compact.characters.filter((character) => {
    const out = characters.get(character.id);
    return !text(out?.name) || badHan(text(out?.name)) || !text(out?.appearance);
  });
  const missingLines = compact.subtitles.filter((line) => !lines.get(line.key) || badHan(lines.get(line.key)));
  const story = storyProblem(compact, parsed);
  return {
    characters: missingCharacters,
    subtitles: missingLines,
    setting: !text(parsed?.setting),
    story,
    count: missingCharacters.length + missingLines.length + (text(parsed?.setting) ? 0 : 1) + (story ? 1 : 0),
  };
}

function buildRepairPrompt(target, compact, missing) {
  const base = buildPrompt(target, compact);
  return {
    system: `${base.system}\nYour previous answer left out or broke the items below. Return the same JSON shape containing only these items, completed.`,
    user: JSON.stringify({
      characters: missing.characters,
      subtitles: missing.subtitles,
      need_setting: missing.setting,
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
  merged.characters = [...characters.values()];
  merged.lines = [...lines.values()];
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

function validateOutput(target, compact, parsed) {
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
  const leaked = oldNames(compact).find((name) => story.some((line) => line.includes(name)));
  if (leaked) throw codedError('REDRAW_FACTORY_LOCALIZATION_INVALID', `剧情梗概里还有原片人名「${leaked}」`);
  const episodeHook = text(parsed?.episode_hook);
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
  };
}

function insertVersion(db, owner, work, sourceVersion, target, model, output, taskId, reservationId) {
  const now = new Date().toISOString();
  const next = Number(db.prepare('SELECT MAX(version) AS v FROM redraw_versions WHERE work_id = ?').get(work.id)?.v || 0) + 1;
  const result = db.prepare(`
    INSERT INTO redraw_versions (work_id, tenant_id, user_id, version, locale, market, localization_level,
      name_map_json, text_map_json, glossary_json, culture_map_json, localization_model_snapshot_json,
      localization_task_id, localization_credit_reservation_id, facts_hash, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'full', ?, ?, '{}', ?, ?, ?, ?, ?, 'asset_review', ?, ?)
  `).run(
    work.id, owner.tenantId, owner.userId, next, target.locale, target.market,
    JSON.stringify(output.nameMap), JSON.stringify(output.textMap), JSON.stringify(output.cultureMap),
    JSON.stringify({ kind: KIND, schema: OUTPUT_SCHEMA, model, target: target.key, source_version_id: Number(sourceVersion.id) }),
    taskId, reservationId, sourceVersion.facts_hash, now, now,
  );
  return Number(result.lastInsertRowid);
}

async function runLocalization(db, log, ctx, deps) {
  const { owner, work, sourceVersion, sourceFacts, target, model, taskId, reservationId } = ctx;
  const task = { id: taskId, credit_reservation_id: reservationId };
  try {
    taskService.updateTaskStatus(db, taskId, 'processing', 30, '正在生成目标国家的名字、形象与台词');
    const compact = compactFacts(sourceFacts);
    const generateText = deps.generateText || require('./aiClient').generateText;
    const ask = async (prompt) => {
      const raw = await generateText(db, log, 'text', prompt.user, prompt.system, {
        model, json_mode: true, temperature: 0.4, min_max_tokens: 12000, silence_timeout_ms: MODEL_SILENCE_TIMEOUT_MS,
      });
      try {
        return typeof raw === 'string' ? JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, '')) : raw;
      } catch (error) {
        throw codedError('REDRAW_FACTORY_LOCALIZATION_INVALID', `本地化结果不是合法 JSON：${error.message}`);
      }
    };
    let parsed = await ask(buildPrompt(target, compact));
    const missing = missingItems(target, compact, parsed);
    if (missing.count) {
      log?.warn?.('redraw factory localization repairing missing items', {
        task_id: taskId, characters: missing.characters.map((c) => c.id), lines: missing.subtitles.length, setting: missing.setting,
      });
      taskService.updateTaskStatus(db, taskId, 'processing', 70, '正在补全遗漏的名字、形象或台词');
      parsed = mergeOutputs(parsed, await ask(buildRepairPrompt(target, compact, missing)));
    }
    const output = validateOutput(target, compact, parsed);
    const versionId = db.transaction(() => {
      const id = insertVersion(db, owner, work, sourceVersion, target, model, output, taskId, reservationId);
      taskService.updateTaskResult(db, taskId, { version_id: id, target: target.key });
      creditLedger.settleGeneration(db, reservationId, 'completed');
      return id;
    })();
    log?.info?.('redraw factory localization completed', { task_id: taskId, work_id: work.id, target: target.key, version_id: versionId });
    return versionId;
  } catch (error) {
    log?.warn?.('redraw factory localization failed', { task_id: taskId, work_id: work.id, message: error.message });
    failTask(db, task, error.message || '转绘本地化失败');
    return null;
  }
}

/**
 * 查询状态或发起一次完全转绘本地化。
 * @returns {{status:'ready'|'localizing'|'failed'|'none', credits, target, version_id?, task_id?, error?}}
 */
function localizationStatus(db, { owner, work, sourceVersion, target, canReadArtifact }) {
  const priced = quote(db, canReadArtifact, target);
  const base = { target: target.key, label: target.label, credits: priced.credits };
  const ready = readyVersion(db, owner, work, sourceVersion, target);
  if (ready) return { ...base, status: 'ready', version_id: Number(ready.id) };
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
  const ctx = { owner, work, sourceVersion, sourceFacts, target, model, ...created };
  const schedule = deps.schedule || ((job) => new Promise((resolve) => setImmediate(() => resolve(job()))));
  const completion = schedule(() => runLocalization(db, log, ctx, deps));
  taskService.trackInFlightTask(created.taskId, completion);
  return { target: target.key, label: target.label, credits: current.credits, status: 'localizing', task_id: created.taskId, completion };
}

module.exports = {
  KIND,
  COUNTRIES_BY_LANGUAGE,
  listTargets,
  resolveTarget,
  localizationStatus,
  startLocalization,
  buildPrompt,
  compactFacts,
  validateOutput,
  describeTarget,
};
