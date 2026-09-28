'use strict';

/**
 * 样片分析第二段：在第一段已拆好的镜头、角色、场景上补充导入短剧工厂需要的外观信息。
 *
 * 第一段（拆镜、时间轴、字幕、名字）输出很长；把外貌、场景视觉、景别、字幕说话人也塞进同一次
 * 调用会让推理模型输出翻倍、超时或被截断。第二段只回填这些提示字段，输出很小。
 * 第二段是尽力而为：失败时返回原事实，不影响已付费的第一段结果。
 */

const SHOT_SIZES = new Set([
  'extreme close-up', 'close-up', 'medium close-up', 'medium', 'medium wide', 'wide', 'extreme wide', 'insert',
]);
const ENRICHMENT_MAX_TOKENS = 6000;

function text(value, max) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, max);
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function compactFacts(facts) {
  return {
    characters: list(facts.characters).map((character) => ({
      id: character?.id,
      name: character?.source_name || character?.display_name || '',
      relationship: character?.relationship || '',
    })),
    scenes: list(facts.scenes).map((scene) => ({ id: scene?.id, location: scene?.location, time: scene?.time })),
    shots: list(facts.shots).map((shot) => ({
      id: shot?.id,
      start_ms: shot?.start_ms,
      end_ms: shot?.end_ms,
      visible_character_ids: list(shot?.visible_character_ids),
      composition: text(shot?.composition, 160),
    })),
    subtitles: list(facts.shots).flatMap((shot) => list(shot?.text_regions)
      .filter((region) => region?.kind === 'subtitle' && text(region?.source_text, 300))
      .map((region) => ({ shot_id: shot.id, region_id: region.id, text: text(region.source_text, 300) }))),
  };
}

function buildEnrichmentPrompt(facts) {
  return [
    'You are adding recreation details to an existing short-drama analysis. The images are the same chronological contact sheets of the source video.',
    'Return ONLY JSON of this shape: {"characters":[{"id":"","appearance":""}],"scenes":[{"id":"","visual":""}],"shots":[{"id":"","shot_size":""}],"subtitle_speakers":[{"shot_id":"","region_id":"","speaker_id":""}]}',
    'Use only the ids listed in the existing analysis. Do not add, remove, rename or re-time anything.',
    'appearance: apparent age range, build, hair, and the outfit worn in this clip (colors, garments, accessories). Visual traits only; no names, personality, camera wording, or background.',
    'visual: set dressing, architecture, key furniture, lighting, and color palette of the empty location, without people.',
    'Write appearance and visual in Simplified Chinese, and never mention character ids such as c1 inside them.',
    `shot_size: one of ${[...SHOT_SIZES].join(', ')}.`,
    'subtitle_speakers: only for subtitle lines whose speaker is clear from who is on screen and reacting; omit narration and lines you are unsure about.',
    'Existing analysis:',
    JSON.stringify(compactFacts(facts)),
  ].join('\n');
}

function byId(items) {
  const map = new Map();
  for (const item of list(items)) {
    if (item && typeof item === 'object' && item.id != null) map.set(String(item.id), item);
  }
  return map;
}

// 只回填已知 id 的提示字段；未知 id、非法景别、不是已知角色的说话人一律忽略。
function applyEnrichment(facts, enrichment) {
  const merged = cloneJson(facts);
  const characters = byId(enrichment?.characters);
  const scenes = byId(enrichment?.scenes);
  const shots = byId(enrichment?.shots);
  const characterIds = new Set(list(merged.characters).map((character) => String(character?.id)));
  const speakers = new Map(list(enrichment?.subtitle_speakers)
    .filter((item) => item && characterIds.has(String(item.speaker_id)))
    .map((item) => [`${item.shot_id}:${item.region_id}`, String(item.speaker_id)]));
  for (const character of list(merged.characters)) {
    const appearance = text(characters.get(String(character?.id))?.appearance, 400);
    if (appearance) character.appearance = appearance;
  }
  for (const scene of list(merged.scenes)) {
    const visual = text(scenes.get(String(scene?.id))?.visual, 500);
    if (visual) scene.visual = visual;
  }
  for (const shot of list(merged.shots)) {
    const size = text(shots.get(String(shot?.id))?.shot_size, 40).toLowerCase();
    if (SHOT_SIZES.has(size)) shot.shot_size = size;
    for (const region of list(shot?.text_regions)) {
      const speaker = speakers.get(`${shot.id}:${region?.id}`);
      if (region?.kind === 'subtitle' && speaker) region.speaker_id = speaker;
    }
  }
  return merged;
}

/**
 * @param {object} ctx { visionDetailed, parseJsonObject, imageSources, options, source, log }
 * @param {object} facts 第一段解析出的 source_facts
 * @returns {Promise<{ facts: object, enrichment: object }>}
 */
async function enrichSourceFacts(ctx, facts) {
  try {
    const vision = await ctx.visionDetailed({
      userPrompt: buildEnrichmentPrompt(facts),
      systemPrompt: 'Return strict JSON only.',
      imageSources: ctx.imageSources,
      options: { ...ctx.options, max_tokens: ENRICHMENT_MAX_TOKENS },
      source: ctx.source,
    });
    const parsed = ctx.parseJsonObject(vision?.text);
    return {
      facts: applyEnrichment(facts, parsed),
      enrichment: {
        status: 'completed',
        provider_task_id: vision?.provider_task_id ? String(vision.provider_task_id) : null,
        usage: vision?.usage || null,
      },
    };
  } catch (error) {
    ctx.log?.warn?.('redraw source enrichment failed; keeping first-pass facts', {
      code: error?.code || null,
      message: String(error?.message || '').slice(0, 200),
    });
    return {
      facts,
      enrichment: { status: 'failed', error_code: error?.code || 'ENRICHMENT_FAILED' },
    };
  }
}

module.exports = {
  applyEnrichment,
  buildEnrichmentPrompt,
  enrichSourceFacts,
};
