import { calendarDate } from './calendar-format';
import { END, START, parseOutput, renderOutput } from './output';
import { visibleLines } from './parser';
import { addDays, localMinute } from './time';
import type { Block, Diagnostic, Interval, OutputDocument, Settings } from './types';
export function dailyPaths(settings: Settings, today: string): string[] {
  return Array.from({ length: 7 }, (_, i) => `${settings.dailyFolder}/${addDays(today, i)}.md`);
}
interface Section { start: number; end: number }
function section(content: string): Section | undefined {
  const lines = content.split(/\r?\n/), visible = visibleLines(content);
  const headings = visible.filter(l => /^#{1,6}\s+Day planner\s*#*\s*$/i.test(l.text));
  if (headings.length > 1) throw new Error('Duplicate Day planner headings; refusing to write');
  if (!headings.length) return undefined;
  const heading = headings[0], level = /^#+/.exec(heading.text)![0].length;
  const next = visible.find(l => l.line > heading.line && new RegExp(`^#{1,${level}}\\s+`).test(l.text));
  const offsets: number[] = []; let offset = 0;
  for (const line of lines) { offsets.push(offset); offset += line.length + (content.includes('\r\n') ? 2 : 1); }
  return { start: Math.min(offsets[heading.line] ?? content.length, content.length), end: next ? offsets[next.line - 1] : content.length };
}
/** Prepare a managed region only inside the intended heading; retain external bytes. */
export function dailyDocument(content: string | null): OutputDocument {
  let text = content ?? ''; const newline = text.includes('\r\n') ? '\r\n' : '\n';
  let part = section(text);
  if (!part) {
    if (text.includes(START) || text.includes(END)) throw new Error('Managed region is outside the Day planner heading');
    text += (text ? (text.endsWith('\n') ? newline : newline + newline) : '') + `# Day planner${newline}`;
    part = section(text)!;
  }
  const region = text.slice(part.start, part.end);
  if (text.includes(START) || text.includes(END)) {
    if (!region.includes(START) || !region.includes(END)) throw new Error('The managed region must be entirely under the Day planner heading');
    return parseOutput(text);
  }
  const prefix = text.slice(0, part.end);
  return { prefix: prefix + (prefix && !prefix.endsWith('\n') ? newline : ''), suffix: newline + text.slice(part.end), newline, blocks: [] };
}
export function renderDaily(document: OutputDocument, blocks: Block[], mode: Settings['outputMode'], ganttFilter = '🎯'): string {
  // Date lives in the note name and in Gantt fields. A date subheading is unnecessary.
  const rendered = renderOutput({ ...document, prefix: '', suffix: '' }, blocks, mode, ganttFilter)
    .split(document.newline).filter(line => !/^## \d{4}-\d{2}-\d{2}$/.test(line)).join(document.newline);
  return document.prefix + rendered + document.suffix;
}
export function dailyInputs(path: string, content: string | null): { content: string; intervals: Interval[]; errors: Diagnostic[] } {
  const text = content ?? '', part = section(text); const intervals: Interval[] = [], errors: Diagnostic[] = [];
  if (!part) return { content: '', intervals, errors };
  const date = path.split('/').pop()!.slice(0, -3);
  const startLine = text.slice(0, part.start).split('\n').length;
  let managed = false;
  const selected: string[] = [];
  for (const { text: line, line: number } of visibleLines(text.slice(part.start, part.end))) {
    if (line.trim() === START) { managed = true; selected.push(''); continue; }
    if (line.trim() === END) { managed = false; selected.push(''); continue; }
    selected.push(managed ? '' : line);
    if (managed) continue;
    try {
      const time = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[.\]\s+)?(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})(?:\s|$)/.exec(line);
      const calendarStart = calendarDate(line, 'start') ?? calendarDate(line, 'scheduled');
      const calendarEnd = calendarDate(line, 'due');
      let interval: Interval | undefined;
      if (time) interval = { start: localMinute(date, time[1]), end: localMinute(date, time[2]) };
      else if (!/<!--\s*as\s|%%\[as::/.test(line) && calendarStart !== undefined && calendarEnd !== undefined && /(?:\[(?:start|scheduled)::|[🛫⏳])\s*\d{4}-\d{2}-\d{2} \d{2}:\d{2}/u.test(line) && /(?:\[due::|📅)\s*\d{4}-\d{2}-\d{2} \d{2}:\d{2}/u.test(line)) interval = { start: calendarStart, end: calendarEnd };
      if (interval) {
        if (interval.end <= interval.start) throw new Error('A handwritten daily event must end after it starts');
        intervals.push(interval);
      }
    } catch (error) { errors.push({ path, line: startLine + number - 1, message: (error as Error).message }); }
  }
  return { content: '\n'.repeat(startLine - 1) + selected.join('\n'), intervals, errors };
}
