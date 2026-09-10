function globalSegments(window) {
  const offset = Number(window?.analysis_range_ms?.start_ms || 0)
  return (window?.raw_source_evidence?.segments || []).map((segment, index) => ({
    index,
    start_ms: offset + Number(segment.start) * 1000,
    end_ms: offset + Number(segment.end) * 1000,
    text: String(segment.text || '').trim(),
  }))
}

function overlaps(left, right) {
  return left.start_ms < right.end_ms && right.start_ms < left.end_ms
}

export function sourceAudioSeamDecisionPoints(review) {
  if (review?.status !== 'needs_review' || review?.reason === 'language_conflict') return []
  const windows = Array.isArray(review?.windows) ? review.windows : []
  const points = []
  for (let index = 0; index + 1 < windows.length; index += 1) {
    const leftWindow = windows[index]
    const rightWindow = windows[index + 1]
    const intersection = {
      start_ms: Number(rightWindow.analysis_range_ms.start_ms),
      end_ms: Number(leftWindow.analysis_range_ms.end_ms),
    }
    const left = globalSegments(leftWindow).filter(segment => overlaps(segment, intersection))
    const right = globalSegments(rightWindow).filter(segment => overlaps(segment, intersection))
    const clean = left.every(segment => {
      const matches = right.filter(value => overlaps(segment, value))
      return matches.length === 1 && matches[0].text === segment.text
        && left.filter(value => overlaps(value, matches[0])).length === 1
    }) && right.every(segment => {
      const matches = left.filter(value => overlaps(segment, value))
      return matches.length === 1 && matches[0].text === segment.text
        && right.filter(value => overlaps(value, matches[0])).length === 1
    })
    if (!clean) points.push({
      seam_ms: Number(leftWindow.commit_range_ms.end_ms),
      left_window_id: leftWindow.window_id,
      right_window_id: rightWindow.window_id,
      left_text: left.map(segment => segment.text).join(' '),
      right_text: right.map(segment => segment.text).join(' '),
    })
  }
  return points
}

export function buildSourceAudioSeamDecisionPayload(review, selections) {
  const points = sourceAudioSeamDecisionPoints(review)
  if (!points.length || points.some(point => ![point.left_window_id, point.right_window_id]
    .includes(selections?.[point.seam_ms]))) throw new Error('请为每个冲突接缝选择一侧完整原文')
  return {
    analysis_task_id: review.analysis_task_id,
    candidate_sha256: review.candidate_sha256,
    expected_work_updated_at: review.expected_work_updated_at,
    expected_task_updated_at: review.expected_task_updated_at,
    decisions: points.map(point => ({
      seam_ms: point.seam_ms,
      left_window_id: point.left_window_id,
      right_window_id: point.right_window_id,
      selected_window_id: selections[point.seam_ms],
    })),
  }
}
