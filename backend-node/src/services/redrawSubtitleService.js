const DEFAULT_LOCALE = 'en-US';
const MAX_CODE_POINTS_PER_SECOND = 20;
const MAX_LINE_CODE_POINTS = 42;
const MAX_LINES = 2;
const RTL_LOCALE_PREFIXES = ['ar', 'he', 'fa', 'ur'];

function codePointLength(value) {
  return Array.from(String(value || '')).length;
}

function directionForLocale(locale) {
  const normalized = String(locale || DEFAULT_LOCALE).toLowerCase();
  return RTL_LOCALE_PREFIXES.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}-`))
    ? 'rtl'
    : 'ltr';
}

function escapeSubtitleText(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatTimestamp(ms, separator) {
  const totalMs = Number(ms);
  const hours = Math.floor(totalMs / 3600000);
  const minutes = Math.floor((totalMs % 3600000) / 60000);
  const seconds = Math.floor((totalMs % 60000) / 1000);
  const millis = totalMs % 1000;
  return [
    String(hours).padStart(2, '0'),
    String(minutes).padStart(2, '0'),
    String(seconds).padStart(2, '0'),
  ].join(':') + separator + String(millis).padStart(3, '0');
}

function effectiveLimits(options = {}) {
  return {
    maxCharsPerSecond: Math.min(
      Number(options.maxCharsPerSecond) || MAX_CODE_POINTS_PER_SECOND,
      MAX_CODE_POINTS_PER_SECOND,
    ),
    maxLineCodePoints: Math.min(
      Number(options.maxLineCodePoints) || MAX_LINE_CODE_POINTS,
      MAX_LINE_CODE_POINTS,
    ),
    maxLines: Math.min(Number(options.maxLines) || MAX_LINES, MAX_LINES),
  };
}

function normalizeCue(segment, index) {
  const text = String(segment?.text ?? segment?.localized_text ?? segment?.subtitle_text ?? '');
  return {
    segment_id: String(segment?.segment_id ?? segment?.id ?? index),
    start_ms: Number(segment?.start_ms),
    end_ms: Number(segment?.end_ms),
    text,
    source_index: index,
  };
}

function stableSortCues(cues) {
  return [...cues].sort((a, b) => (
    a.start_ms - b.start_ms
    || a.end_ms - b.end_ms
    || a.segment_id.localeCompare(b.segment_id)
    || a.text.localeCompare(b.text)
  ));
}

function wrapLineByWords(line, maxLineCodePoints, maxLines) {
  const words = String(line).trim().split(/\s+/).filter(Boolean);
  if (words.length <= 1) return [String(line).trim()];

  const lines = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (codePointLength(candidate) <= maxLineCodePoints) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    current = word;
  }
  if (current) lines.push(current);
  return lines.length <= maxLines ? lines : [String(line).trim()];
}

function layoutCueText(text, limits) {
  const explicitLines = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const lines = [];

  for (const line of explicitLines) {
    if (codePointLength(line) <= limits.maxLineCodePoints) {
      lines.push(line);
    } else {
      lines.push(...wrapLineByWords(line, limits.maxLineCodePoints, limits.maxLines - lines.length));
    }
  }

  return lines;
}

function validateSubtitles(inputCues, options = {}) {
  const locale = String(options.locale || DEFAULT_LOCALE);
  const direction = directionForLocale(locale);
  const limits = effectiveLimits(options);
  const cues = stableSortCues((Array.isArray(inputCues) ? inputCues : []).map(normalizeCue))
    .map((cue) => ({ ...cue, lines: layoutCueText(cue.text, limits) }));
  const errors = [];

  for (const cue of cues) {
    const text = cue.text.trim();
    if (!text) {
      errors.push({ segment_id: cue.segment_id, reason: 'subtitle_text_empty' });
    }

    if (!Number.isInteger(cue.start_ms) || !Number.isInteger(cue.end_ms) || cue.start_ms < 0 || cue.end_ms <= cue.start_ms) {
      errors.push({ segment_id: cue.segment_id, reason: 'subtitle_time_invalid' });
    }

    if (text && Number.isInteger(cue.start_ms) && Number.isInteger(cue.end_ms) && cue.end_ms > cue.start_ms) {
      const durationSeconds = (cue.end_ms - cue.start_ms) / 1000;
      const cps = codePointLength(text.replace(/\s+/g, '')) / durationSeconds;
      if (cps > limits.maxCharsPerSecond) {
        errors.push({ segment_id: cue.segment_id, reason: 'subtitle_reading_speed_exceeded' });
      }
    }

    if (cue.lines.length > limits.maxLines || cue.lines.some((line) => codePointLength(line) > limits.maxLineCodePoints)) {
      errors.push({ segment_id: cue.segment_id, reason: 'subtitle_line_length_exceeded' });
    }
  }

  for (let index = 1; index < cues.length; index += 1) {
    const previous = cues[index - 1];
    const current = cues[index];
    if (Number.isInteger(previous.end_ms) && Number.isInteger(current.start_ms) && current.start_ms < previous.end_ms) {
      errors.push({ segment_id: current.segment_id, previous_segment_id: previous.segment_id, reason: 'subtitle_overlap' });
    }
  }

  return {
    status: errors.length > 0 ? 'needs_rewrite' : 'ready',
    locale,
    direction,
    cues: cues.map(({ source_index, ...cue }) => cue),
    errors,
  };
}

function serializeCueText(cue) {
  const lines = Array.isArray(cue.lines) && cue.lines.length > 0
    ? cue.lines
    : String(cue.text).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  return lines.map(escapeSubtitleText).join('\n');
}

function serializeSrt(cues) {
  return (Array.isArray(cues) ? cues : []).map((cue, index) => [
    String(index + 1),
    `${formatTimestamp(cue.start_ms, ',')} --> ${formatTimestamp(cue.end_ms, ',')}`,
    serializeCueText(cue),
    '',
  ].join('\n')).join('\n');
}

function serializeVtt(cues) {
  const body = (Array.isArray(cues) ? cues : []).map((cue, index) => [
    String(index + 1),
    `${formatTimestamp(cue.start_ms, '.')} --> ${formatTimestamp(cue.end_ms, '.')}`,
    serializeCueText(cue),
    '',
  ].join('\n')).join('\n');
  return `WEBVTT\n\n${body}`;
}

function buildSubtitles(segments, options = {}) {
  const validation = validateSubtitles(segments, options);
  if (validation.status !== 'ready') {
    return { ...validation, srt: null, vtt: null };
  }
  return {
    ...validation,
    srt: serializeSrt(validation.cues),
    vtt: serializeVtt(validation.cues),
  };
}

module.exports = {
  buildSubtitles,
  validateSubtitles,
  serializeSrt,
  serializeVtt,
};
