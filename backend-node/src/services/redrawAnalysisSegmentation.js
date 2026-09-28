'use strict';

/**
 * 样片分段分析的规划（纯函数）。
 *
 * 推理模型一次分析整集样片会生成上万 token，常超过 9 分钟；按约 20 秒一段分别分析再拼接，
 * 每段输出小、可控。段数只由样片时长决定，报价、预扣和实际切段用同一个数，保证按段计费一致。
 */

const SINGLE_PASS_MAX_MS = 25_000;
const SEGMENT_TARGET_MS = 20_000;
const MAX_SOURCE_MS = 5 * 60_000;
const CUT_SNAP_WINDOW_MS = 3_000;
const MIN_SEGMENT_MS = 8_000;

function segmentCountForDuration(durationMs) {
  const duration = Number(durationMs);
  if (!Number.isFinite(duration) || duration <= 0) return 1;
  if (duration <= SINGLE_PASS_MAX_MS) return 1;
  return Math.ceil(duration / SEGMENT_TARGET_MS);
}

function assertSourceDurationAllowed(durationMs) {
  if (Number(durationMs) > MAX_SOURCE_MS) {
    throw Object.assign(
      new Error(`样片超过 ${MAX_SOURCE_MS / 60_000} 分钟，请剪短后再分析`),
      { code: 'REDRAW_SOURCE_TOO_LONG' },
    );
  }
}

/**
 * 均分出 count 段，再把每个内部边界吸附到 ±3 秒内最近的镜头切换点，避免把一个镜头劈成两半。
 * 吸附后每段仍不短于 8 秒；段数固定不变。
 * @param {number} durationMs
 * @param {number} count
 * @param {number[]} cutPointsMs 镜头切换时间点（毫秒）
 * @returns {Array<{start_ms:number,end_ms:number}>}
 */
function planSegments(durationMs, count, cutPointsMs = []) {
  const duration = Math.round(Number(durationMs));
  const total = Math.max(1, Math.floor(Number(count) || 1));
  if (total === 1) return [{ start_ms: 0, end_ms: duration }];
  const cuts = [...new Set((cutPointsMs || []).map((ms) => Math.round(Number(ms))))]
    .filter((ms) => Number.isFinite(ms) && ms > 0 && ms < duration)
    .sort((a, b) => a - b);
  const boundaries = [0];
  for (let index = 1; index < total; index += 1) {
    const ideal = Math.round((duration * index) / total);
    const previous = boundaries[boundaries.length - 1];
    const remainingSegments = total - index;
    const latest = duration - remainingSegments * MIN_SEGMENT_MS;
    let best = null;
    for (const cut of cuts) {
      if (Math.abs(cut - ideal) > CUT_SNAP_WINDOW_MS) continue;
      if (cut - previous < MIN_SEGMENT_MS || cut > latest) continue;
      if (best == null || Math.abs(cut - ideal) < Math.abs(best - ideal)) best = cut;
    }
    boundaries.push(best ?? Math.min(Math.max(ideal, previous + MIN_SEGMENT_MS), latest));
  }
  boundaries.push(duration);
  return boundaries.slice(0, -1).map((start, index) => ({ start_ms: start, end_ms: boundaries[index + 1] }));
}

module.exports = {
  MAX_SOURCE_MS,
  SEGMENT_TARGET_MS,
  SINGLE_PASS_MAX_MS,
  assertSourceDurationAllowed,
  planSegments,
  segmentCountForDuration,
};
