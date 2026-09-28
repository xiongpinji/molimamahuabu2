'use strict';

/**
 * 分段分析结果拼接（纯函数）：把每段从 0 开始的事实合成一集的事实。
 *
 * - 角色按名字合并（后面的段在提示词里拿到了前面的角色名单，同一人会沿用同名），场景按地点+时间、道具按名称合并；
 * - 所有 id 重新编号，镜头时间码加上段起点；每段首尾镜头对齐到段边界，保证整集时间轴无缝；
 * - 字幕区域与台词条目 id 加段号前缀，保证全集唯一。
 */

function list(value) {
  return Array.isArray(value) ? value : [];
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function key(value) {
  return text(value).toLowerCase().replace(/\s+/g, ' ');
}

function remapIdsInText(value, idMap) {
  return text(value).replace(/\bc\d+\b/g, (id) => idMap.get(id) || id);
}

function uniqueStrings(values) {
  const seen = new Set();
  const out = [];
  for (const value of values.map(text).filter(Boolean)) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function offsetRanges(ranges, offset, segmentEnd) {
  return list(ranges)
    .map((range) => ({
      start_ms: Math.min(segmentEnd, Math.round(Number(range?.start_ms) + offset)),
      end_ms: Math.min(segmentEnd, Math.round(Number(range?.end_ms) + offset)),
    }))
    .filter((range) => Number.isFinite(range.start_ms) && range.end_ms > range.start_ms);
}

/**
 * @param {Array<{start_ms:number,end_ms:number,facts:object}>} segments 已校验的各段事实（段内时间从 0 开始）
 * @param {number} durationMs 整集时长
 */
function mergeSegmentFacts(segments, durationMs) {
  const characters = [];
  const characterByName = new Map();
  const scenes = [];
  const sceneByKey = new Map();
  const props = [];
  const propByKey = new Map();
  const shots = [];
  const story = [];
  const causalChain = [];
  const lockedFacts = [];
  const reversals = [];
  let episodeHook = '';

  segments.forEach((segment, segmentIndex) => {
    const prefix = `seg${segmentIndex + 1}`;
    const offset = Number(segment.start_ms);
    const segmentEnd = Number(segment.end_ms);
    const facts = segment.facts || {};

    const characterMap = new Map();
    for (const character of list(facts.characters)) {
      const name = text(character?.source_name) || text(character?.display_name);
      const nameKey = key(name) || `${prefix}:${character?.id}`;
      let target = characterByName.get(nameKey);
      if (!target) {
        target = {
          id: `c${characters.length + 1}`,
          source_name: text(character?.source_name) || name,
          display_name: text(character?.display_name) || name,
          relationship: text(character?.relationship),
          relationships: [],
        };
        characters.push(target);
        characterByName.set(nameKey, target);
      }
      if (!target.appearance && text(character?.appearance)) target.appearance = text(character.appearance);
      if (!target.relationship && text(character?.relationship)) target.relationship = text(character.relationship);
      characterMap.set(String(character?.id), target.id);
    }
    for (const character of list(facts.characters)) {
      const target = characters.find((item) => item.id === characterMap.get(String(character?.id)));
      target.relationships = uniqueStrings([
        ...target.relationships,
        ...list(character?.relationships).map((item) => remapIdsInText(item, characterMap)),
      ]);
    }

    const sceneMap = new Map();
    for (const scene of list(facts.scenes)) {
      const sceneKey = `${key(scene?.location)}|${key(scene?.time)}`;
      let target = sceneByKey.get(sceneKey);
      if (!target) {
        target = { id: `s${scenes.length + 1}`, location: text(scene?.location), time: text(scene?.time), source_ranges: [] };
        scenes.push(target);
        sceneByKey.set(sceneKey, target);
      }
      if (!target.visual && text(scene?.visual)) target.visual = text(scene.visual);
      target.source_ranges.push(...offsetRanges(scene?.source_ranges, offset, segmentEnd));
      sceneMap.set(String(scene?.id), target.id);
    }

    for (const prop of list(facts.props)) {
      const propKey = key(prop?.name) || `${prefix}:${prop?.id}`;
      let target = propByKey.get(propKey);
      if (!target) {
        target = { id: `p${props.length + 1}`, name: text(prop?.name), evidence_ranges: [] };
        props.push(target);
        propByKey.set(propKey, target);
      }
      target.evidence_ranges.push(...offsetRanges(prop?.evidence_ranges, offset, segmentEnd));
    }

    const segmentShots = [...list(facts.shots)].sort((a, b) => Number(a?.start_ms) - Number(b?.start_ms));
    segmentShots.forEach((shot, shotIndex) => {
      const isFirst = shotIndex === 0;
      const isLast = shotIndex === segmentShots.length - 1;
      const start = isFirst ? offset : Math.round(Number(shot.start_ms) + offset);
      const end = isLast ? segmentEnd : Math.min(segmentEnd, Math.round(Number(shot.end_ms) + offset));
      shots.push({
        ...shot,
        id: `shot-${shots.length + 1}`,
        index: shots.length + 1,
        start_ms: start,
        end_ms: end,
        visible_character_ids: list(shot.visible_character_ids)
          .map((id) => characterMap.get(String(id)))
          .filter(Boolean),
        dialogue: list(shot.dialogue).map((turn, turnIndex) => ({
          ...turn,
          id: `${prefix}-${text(turn?.id) || `t${turnIndex + 1}`}`,
          speaker_id: characterMap.get(String(turn?.speaker_id)) || turn?.speaker_id,
          start_ms: Math.min(end, Math.max(start, Math.round(Number(turn?.start_ms) + offset))),
          end_ms: Math.min(end, Math.max(start, Math.round(Number(turn?.end_ms) + offset))),
        })).filter((turn) => turn.end_ms > turn.start_ms),
        text_regions: list(shot.text_regions).map((region, regionIndex) => {
          const mapped = { ...region, id: `${prefix}-${text(region?.id) || `txt${regionIndex + 1}`}` };
          if (region?.speaker_id != null) {
            const speaker = characterMap.get(String(region.speaker_id));
            if (speaker) mapped.speaker_id = speaker;
            else delete mapped.speaker_id;
          }
          return mapped;
        }),
      });
    });

    story.push(...list(facts.story));
    causalChain.push(...list(facts.causal_chain));
    lockedFacts.push(...list(facts.locked_facts).map((item) => remapIdsInText(item, characterMap)));
    reversals.push(...list(facts.reversals));
    if (text(facts.episode_hook)) episodeHook = text(facts.episode_hook);
  });

  const lastShot = shots[shots.length - 1];
  if (lastShot) lastShot.end_ms = Math.round(Number(durationMs));

  return {
    schema_version: '2.0',
    duration_ms: Math.round(Number(durationMs)),
    story: uniqueStrings(story),
    characters,
    scenes,
    props,
    shots,
    causal_chain: uniqueStrings(causalChain),
    locked_facts: uniqueStrings(lockedFacts),
    reversals: uniqueStrings(reversals),
    episode_hook: episodeHook,
  };
}

/** 供后续段提示词使用的已知角色名单。 */
function knownCastFrom(facts) {
  return list(facts?.characters)
    .map((character) => ({
      name: text(character?.source_name) || text(character?.display_name),
      appearance: text(character?.appearance).slice(0, 200),
    }))
    .filter((character) => character.name);
}

module.exports = {
  knownCastFrom,
  mergeSegmentFacts,
};
