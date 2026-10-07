import { dailyInputs, dayPlannerSection } from './daily';
import { parseEventMetadata } from './event-tool';
import { END, START } from './output';
import { visibleLines } from './parser';
import { parseBoundary } from './time';
import type { DailyTracking } from './types';

const EVENT_COMMENT = /<!--\s*as-event\b[^\r\n]*?-->/;
const EVENT_MARKER = /<!--\s*as-event\b/;
const CHECKBOX = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\]\s+)/;
const COMPLETION = /[ \t]+✅[ \t]+(\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2})?)$/u;

function completion(line: string): { line: string; marker: string } {
  const match = COMPLETION.exec(line);
  if (!match) return { line, marker: '' };
  parseBoundary(match[1].replace(' ', 'T'));
  return { line: line.slice(0, match.index), marker: line.slice(match.index) };
}

function anchor(line: string): string {
  const withoutCompletion = completion(line).line;
  return withoutCompletion.replace(CHECKBOX, '$1 $3');
}

/** Remove one validated event comment and only the whitespace separating it. */
function clearEventComment(line: string): string {
  const match = EVENT_COMMENT.exec(line);
  if (!match) throw new Error('Missing event buffer metadata');
  let commentStart = match.index;
  if (commentStart > 0 && line[commentStart - 1] === '\\') commentStart--;
  let start = commentStart;
  while (start > 0 && /[ \t]/.test(line[start - 1])) start--;
  let end = match.index + match[0].length;
  while (end < line.length && /[ \t]/.test(line[end])) end++;
  const separator = start > 0 && end < line.length ? ' ' : '';
  return line.slice(0, start) + separator + line.slice(end);
}

function eventAnnotation(line: string): string {
  const match = EVENT_COMMENT.exec(line);
  if (!match) throw new Error('Missing event buffer metadata');
  return (match.index > 0 && line[match.index - 1] === '\\' ? '\\' : '') + match[0];
}

function diagnosticError(path: string, errors: ReturnType<typeof dailyInputs>['errors']): Error {
  return new Error(errors.map(error => `${error.path || path}:${error.line}: ${error.message}`).join('\n'));
}

/**
 * Hide scheduler-owned event buffer metadata while retaining an exact row
 * record for later scheduling. Fenced examples and the managed block region
 * are excluded by dailyInputs.
 */
export function cleanEventMetadata(path: string, annotatedText: string, defaultDuration = 30): { text: string; eventRecords: DailyTracking[] } {
  const parsed = dailyInputs(path, annotatedText, defaultDuration);
  const eventErrors = parsed.errors.filter(error => {
    const line = annotatedText.split(/\r?\n/)[error.line - 1] ?? '';
    return EVENT_MARKER.test(line);
  });
  if (eventErrors.length) throw diagnosticError(path, eventErrors);

  const changes: Array<{ start: number; end: number; visible: string; annotated: string }> = [];
  for (const row of parsed.rows) {
    if (row.beforeMinutes === undefined) continue;
    const annotated = annotatedText.slice(row.sourceStart, row.sourceStart + row.raw.length);
    if (annotated !== row.raw) throw new Error(`${path}:${row.line}: Event row source changed while cleaning metadata`);
    const visible = clearEventComment(annotated);
    changes.push({ start: row.sourceStart, end: row.sourceStart + annotated.length, visible, annotated });
  }

  let text = annotatedText;
  for (const change of [...changes].sort((a, b) => b.start - a.start)) {
    text = text.slice(0, change.start) + change.visible + text.slice(change.end);
  }
  const eventRecords = changes.map(({ visible, annotated }) => ({ visible, annotated }));
  if (!validEventRecords(eventRecords)) throw new Error(`${path}: Event rows do not have unique, valid tracking anchors`);
  return { text, eventRecords };
}

function withCurrentStatus(annotated: string, current: string): string {
  const currentCheckbox = CHECKBOX.exec(current)?.[2];
  const currentCompletion = completion(current).marker;
  if (currentCompletion && currentCheckbox === ' ') throw new Error('An unchecked event row cannot have a completion date');
  let restored = currentCheckbox ? annotated.replace(CHECKBOX, `$1${currentCheckbox}$3`) : annotated;
  const comment = EVENT_COMMENT.exec(restored);
  if (!comment) throw new Error('Missing event buffer metadata');

  // A completion marker restored previously sits immediately before metadata.
  const rawPrefix = restored.slice(0, comment.index);
  const trimmedPrefix = rawPrefix.replace(/[ \t]+$/, '');
  const priorCompletion = completion(trimmedPrefix);
  const prefix = priorCompletion.marker ? priorCompletion.line.replace(/[ \t]+$/, '') + ' ' : rawPrefix;
  restored = prefix + restored.slice(comment.index);
  const terminalCompletion = completion(restored);
  if (terminalCompletion.marker) restored = terminalCompletion.line;
  if (currentCompletion) {
    const refreshed = EVENT_COMMENT.exec(restored)!;
    restored = restored.slice(0, refreshed.index).replace(/[ \t]+$/, '')
      + currentCompletion + ' ' + restored.slice(refreshed.index);
  }
  return restored;
}

interface VisibleRow { start: number; end: number; text: string }

function eventRows(text: string): VisibleRow[] {
  const part = dayPlannerSection(text);
  if (!part) return [];
  const section = text.slice(part.start, part.end);
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const sourceLines = section.split(/\r?\n/);
  const offsets: number[] = [];
  let offset = part.start;
  for (const line of sourceLines) { offsets.push(offset); offset += line.length + newline.length; }
  const rows: VisibleRow[] = [];
  let managed = false;
  for (const row of visibleLines(section)) {
    if (row.text.trim() === START) { managed = true; continue; }
    if (row.text.trim() === END) { managed = false; continue; }
    if (managed || !row.text) continue;
    const start = offsets[row.line - 1];
    rows.push({ start, end: start + row.text.length, text: row.text });
  }
  return rows;
}

/** Restore hidden metadata only where a tracked visible row remains unique. */
export function restoreEventMetadata(text: string, eventRecords: DailyTracking[]): string {
  if (!validEventRecords(eventRecords)) throw new Error('Invalid event tracking records');
  if (!eventRecords.length) return text;

  const rows = eventRows(text);
  const replacements: Array<{ start: number; end: number; text: string }> = [];
  const claimed = new Set<number>();
  for (const record of eventRecords) {
    const expected = anchor(record.visible);
    const candidates: Array<{ row: VisibleRow; annotated: boolean }> = [];
    for (const row of rows) {
      let visible = row.text;
      let annotated = false;
      if (EVENT_MARKER.test(row.text)) {
        parseEventMetadata(row.text);
        visible = clearEventComment(row.text);
        annotated = true;
      }
      if (anchor(visible) === expected) candidates.push({ row, annotated });
    }
    if (candidates.length !== 1) throw new Error('Tracked event row was edited or is not unique; refusing to guess where its buffer metadata belongs');
    const candidate = candidates[0];
    if (claimed.has(candidate.row.start)) throw new Error('Event tracking records resolve to the same visible row');
    claimed.add(candidate.row.start);
    const restored = withCurrentStatus(record.annotated, candidate.row.text);
    if (candidate.annotated) {
      if (eventAnnotation(candidate.row.text) !== eventAnnotation(record.annotated)) throw new Error('Tracked event buffer metadata changed; refusing to overwrite it');
      continue;
    }
    replacements.push({ start: candidate.row.start, end: candidate.row.end, text: restored });
  }

  let restored = text;
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
    restored = restored.slice(0, replacement.start) + replacement.text + restored.slice(replacement.end);
  }
  return restored;
}

/** Strict persisted-state validator for the optional TrackingPair sidecar. */
export function validEventRecords(value: unknown): value is DailyTracking[] {
  if (!Array.isArray(value)) return false;
  try {
    const anchors = new Set<string>();
    for (const item of value) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
      if (Object.keys(item).sort().join(',') !== 'annotated,visible') return false;
      const record = item as DailyTracking;
      if (typeof record.visible !== 'string' || typeof record.annotated !== 'string'
        || /[\r\n\0]/.test(record.visible) || /[\r\n\0]/.test(record.annotated)) return false;
      if (!/^\s*(?:[-*+]|\d+[.)])\s+\[[ xX]\]\s+\d{2}:\d{2}\s*-\s*\d{2}:\d{2}(?:\s|$)/.test(record.visible)) return false;
      if (completion(record.visible).marker && CHECKBOX.exec(record.visible)?.[2] === ' ') return false;
      if (!parseEventMetadata(record.annotated)) return false;
      if (record.visible !== clearEventComment(record.annotated) || EVENT_MARKER.test(record.visible)) return false;
      const key = anchor(record.visible);
      if (anchors.has(key)) return false;
      anchors.add(key);
    }
    return true;
  } catch {
    return false;
  }
}
