import { calendarDate, calendarPriority, normalizeMetadata } from './calendar-format';
import { GRID, localMinute, parseBoundary, endAfter } from './time';
import type { Diagnostic, Interval, Task } from './types';
export interface Source { path: string; content: string }
/** Ignore fenced examples, including fences nested under list indentation. */
export function visibleLines(content: string): { text: string; line: number }[] {
  let fence: { char: string; size: number } | undefined;
  return content.split(/\r?\n/).map((text, i) => {
    const match = /^\s*(`{3,}|~{3,})(.*)$/.exec(text);
    if (match) {
      if (!fence) fence = { char: match[1][0], size: match[1].length };
      else if (match[1][0] === fence.char && match[1].length >= fence.size && !match[2].trim()) fence = undefined;
      return { text: '', line: i + 1 };
    }
    return { text: fence ? '' : text, line: i + 1 };
  });
}
export function fields(body: string, allowed: string[]): Record<string, string> {
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const token of body.trim().split(/\s+/)) {
    const match = /^([a-z]+)=([^\s=]+)$/.exec(token);
    if (!match || !allowed.includes(match[1])) throw new Error(`Unknown or invalid field: ${token}`);
    if (match[1] in result) throw new Error(`Duplicate field: ${match[1]}`);
    result[match[1]] = match[2];
  }
  return result;
}
export function idField(value: string | undefined): string {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('IDs must use letters, digits, underscores, or hyphens');
  return value;
}
function integer(value: string | undefined, name: string): number {
  if (!value || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`${name} must be an integer`);
  return Number(value);
}
export function parseTasks(sources: Source[]): { tasks: Task[]; errors: Diagnostic[] } {
  const tasks: Task[] = [], errors: Diagnostic[] = []; const ids = new Map<string, string>();
  for (const source of sources) for (const { text: original, line } of visibleLines(source.content)) {
    let text = normalizeMetadata(original, 'as');
    if (original.includes('%%[as::')) {
      const metadata = /<!-- as .+? -->/.exec(text)?.[0];
      if (metadata) text = text.replace(metadata, '').trimEnd() + ' ' + metadata;
    }
    if (!/<!--\s*as(?:\s|-->)/.test(text)) continue;
    try {
      const match = /^\s*(?:[-*+]|\d+[.)])\s+\[([ xX/!?n-])\]\s+(.+?)\s*<!--\s*as\s+(.+?)\s*-->\s*$/.exec(text);
      if (!match || (text.match(/<!--\s*as\s/g) || []).length !== 1) throw new Error('Invalid task format: metadata must appear once at the end of a checkbox list item');
      const f = fields(match[3], ['id', 'remaining', 'priority', 'due', 'earliest', 'split', 'min']);
      const id = idField(f.id), remaining = integer(f.remaining, 'remaining'), priority = f.priority ? integer(f.priority, 'priority') : calendarPriority(match[2]);
      const min = integer(f.min ?? '30', 'min');
      if (remaining <= 0 || remaining % GRID || min <= 0 || min % GRID || min > remaining) throw new Error('remaining/min must be positive multiples of 15, and min <= remaining');
      if (priority < 1 || priority > 5) throw new Error('priority must be 1–5');
      if (f.split !== undefined && !['true', 'false'].includes(f.split)) throw new Error('split must be true or false');
      const due = f.due ? parseBoundary(f.due, true) : calendarDate(match[2], 'due');
      const earliest = f.earliest ? parseBoundary(f.earliest) : calendarDate(match[2], 'start') ?? calendarDate(match[2], 'scheduled');
      if (due !== undefined && earliest !== undefined && earliest >= due) throw new Error('earliest must be before due');
      if (ids.has(id)) throw new Error(`Duplicate ID ${id}, already found in ${ids.get(id)}`);
      ids.set(id, `${source.path}:${line}`);
      tasks.push({ id, title: match[2], path: source.path, line, remaining, priority, due, earliest, split: f.split !== 'false', min, completed: ['x', 'X', '-'].includes(match[1]) });
    } catch (error) { errors.push({ path: source.path, line, message: (error as Error).message }); }
  }
  return { tasks, errors };
}
export function parseFixed(source: Source, defaultDuration = 30): { intervals: Interval[]; errors: Diagnostic[] } {
  const intervals: Interval[] = [], errors: Diagnostic[] = [];
  for (const { text, line } of visibleLines(source.content)) {
    if (!text.trim() || /^\s*#/.test(text)) continue;
    try {
      const match = /^\s*[-*+] (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})(?:\s*-\s*(\d{2}:\d{2}))?(?:\s+[^-\s].*)?$/.exec(text);
      if (!match) throw new Error('Fixed-event format: - YYYY-MM-DD HH:mm[-HH:mm] Title');
      const start = localMinute(match[1], match[2]), end = localMinute(match[1], match[3] ?? endAfter(match[2], defaultDuration));
      if (end <= start) throw new Error('Fixed events must end after they start');
      intervals.push({ start, end });
    } catch (error) { errors.push({ path: source.path, line, message: (error as Error).message }); }
  }
  return { intervals, errors };
}
