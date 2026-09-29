'use strict';

/**
 * 整部剧转绘：同一个转绘项目里的各作品按上传顺序就是第 1、2、3…集。
 * 分析第 N 集前，把前几集已分析出的角色（原名 + 外貌摘要）交给模型，
 * 让同一个人在各集里用同一个原名，导入工厂时才能对上同一个角色。
 *
 * 只读：读取前几集分析结果文件里的 facts_v2；任何一集读不到就跳过，不影响本集分析。
 */

const { loadRedrawSource } = require('./redrawFactoryImportService');
const { knownCastFrom } = require('./redrawSegmentFactsMerge');

const MAX_SERIES_CAST = 30;

function text(value) {
  return value == null ? '' : String(value).trim();
}

/** 按名字去重合并多份已知角色名单，先出现的优先（前几集的写法为准）。 */
function mergeKnownCast(...lists) {
  const seen = new Set();
  const merged = [];
  for (const list of lists) {
    for (const character of Array.isArray(list) ? list : []) {
      const name = text(character?.name);
      if (!name || seen.has(name)) continue;
      seen.add(name);
      merged.push({ name, appearance: text(character.appearance) });
    }
  }
  return merged;
}

/** 同一转绘项目里，本作品之前上传的作品（按上传时间，其次按 id）。 */
function earlierWorks(db, work) {
  return db.prepare(`
    SELECT id FROM redraw_works
    WHERE project_id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL AND id != ?
      AND (created_at < ? OR (created_at = ? AND id < ?))
    ORDER BY created_at ASC, id ASC
  `).all(work.project_id, work.tenant_id, work.user_id, work.id, work.created_at, work.created_at, work.id)
    .map((row) => Number(row.id));
}

/**
 * @returns {{ cast: Array<{name, appearance}>, episodes: number[] }} episodes 是提供了角色的前几集作品 id
 */
function seriesKnownCast(db, work, storageRoot, { log } = {}) {
  const owner = { tenantId: text(work.tenant_id), userId: text(work.user_id) };
  const lists = [];
  const episodes = [];
  for (const workId of earlierWorks(db, work)) {
    try {
      const source = loadRedrawSource(db, owner, workId, storageRoot);
      const cast = knownCastFrom(source.sourceFacts);
      if (cast.length) {
        lists.push(cast);
        episodes.push(workId);
      }
    } catch (error) {
      log?.info?.('[整部剧] 前一集还没有可用的分析结果，跳过', { work_id: workId, code: error?.code || null });
    }
  }
  return { cast: mergeKnownCast(...lists).slice(0, MAX_SERIES_CAST), episodes };
}

module.exports = {
  MAX_SERIES_CAST,
  earlierWorks,
  mergeKnownCast,
  seriesKnownCast,
};
