import { calendarDate, calendarPriority, normalizeMetadata } from './calendar-format';
import { fields, idField } from './parser';
import { clock, dateKey, atDate, localMinute } from './time';
import type { Block, OutputDocument, Settings } from './types';
export const START = '<!-- auto-scheduler:start -->';
export const END = '<!-- auto-scheduler:end -->';
const count = (text: string, token: string): number => text.split(token).length - 1;
export function parseOutput(content: string | null): OutputDocument {
  if (content === null) return { prefix: '# Auto Scheduler\n\n', suffix: '\n', newline: '\n', blocks: [] };
  if (count(content, START) !== 1 || count(content, END) !== 1) throw new Error('Output requires one unique pair of managed-region markers; refusing to overwrite an ordinary note');
  const start = content.indexOf(START), end = content.indexOf(END);
  if (end < start || (start > 0 && content[start - 1] !== '\n') || /[^\r\n]/.test(content.slice(start + START.length, content.indexOf('\n', start) < 0 ? content.length : content.indexOf('\n', start))) || (end > 0 && content[end - 1] !== '\n')) throw new Error('Managed-region markers must be on separate lines and in order');
  const afterEnd = content.slice(end + END.length);
  if (afterEnd && !afterEnd.startsWith('\n') && !afterEnd.startsWith('\r\n')) throw new Error('The end marker must be on a separate line');
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const blocks: Block[] = []; const ids = new Set<string>();
  const region = content.slice(start + START.length, end);
  for (const raw of region.split(/\r?\n/)) {
    let normalized = normalizeMetadata(raw, 'as-block');
    const fullStart = calendarDate(normalized, 'start'), fullEnd = calendarDate(normalized, 'due');
    if (fullStart !== undefined || fullEnd !== undefined) {
      if (fullStart === undefined || fullEnd === undefined || fullEnd <= fullStart) throw new Error('Gantt blocks require valid start/due times');
      const scheduledTime = calendarDate(normalized, 'scheduled');
      if (scheduledTime !== fullStart) throw new Error('Gantt scheduled does not match start');
      const metadata = /<!-- as-block .+? -->/.exec(normalized)?.[0];
      if (metadata) normalized = normalized.replace(metadata, '').trim() + ' ' + metadata;
      normalized = normalized.replace(/\[(?:start|due)::[^\]]+\]/gi, '').replace(/\[scheduled::[^\]]+\]/i, `[scheduled:: ${dateKey(atDate(fullStart))}]`).replace(/ +/g, ' ');
    }
    if (!raw.trim()) continue;
    if (/^## \d{4}-\d{2}-\d{2}$/.test(raw)) { localMinute(raw.slice(3), '00:00'); continue; }
    const match = /^- (?:\[([ xX])\] (?:[^\r\n]*? )?)?(?:(\d{4}-\d{2}-\d{2}) )?(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2}) (.+?)\s*<!-- as-block (.+?) -->$/.exec(normalized);
    if (!match) throw new Error(`Unrecognized content in managed region: ${raw}`);
    const f = fields(match[6], ['id', 'task', 'locked']);
    const id = idField(f.id), taskId = idField(f.task);
    if (!['true', 'false'].includes(f.locked)) throw new Error(`Block ${id} has an invalid locked field`);
    if (ids.has(id)) throw new Error(`Duplicate block ID: ${id}`);
    ids.add(id);
    const scheduled = [...match[5].matchAll(/\[scheduled:: (\d{4}-\d{2}-\d{2})\]/g)];
    const date = match[2] ?? scheduled[0]?.[1];
    if (!date || (match[1] !== undefined && (scheduled.length !== 1 || match[2] !== undefined)) || (match[1] === undefined && scheduled.length > 0)) throw new Error(`Block ${id} has inconsistent dates or format`);
    const startTime = localMinute(date, match[3]), endTime = localMinute(date, match[4]);
    if (endTime <= startTime || dateKey(atDate(startTime)) !== date) throw new Error(`Block ${id} must end after it starts`);
    if (fullStart !== undefined && (startTime !== fullStart || endTime !== fullEnd)) throw new Error('Gantt clock range does not match its date fields');
    const links = [...match[5].matchAll(/\[\[([^\[\]]+)\]\]/g)];
    const path = links[links.length - 1]?.[1] ?? '';
    if (!path) throw new Error(`Block ${id} is missing its source-note link`);
    blocks.push({ id, taskId, date, start: startTime, end: endTime, title: match[5], priority: calendarPriority(match[5]), path: path.endsWith('.md') ? path : `${path}.md`, locked: f.locked === 'true', completed: match[1] !== undefined && match[1] !== ' ', raw });
  }
  return { prefix: content.slice(0, start), suffix: afterEnd, newline, blocks };
}
/** Strip scheduling display fields only; the source Markdown is never changed. */
export function displayTitle(title: string): string {
  return title.replace(/^工作块：\s*/, '').replace(/<!--.*?-->/g, '')
    .replace(/%%.*?%%/g, '')
    .replace(/[🔺⏫🔼🔽⏬]/gu, '')
    .replace(/🔁.*$/gu, '')
    .replace(/[\[(](?:priority|created|completion|cancelled|repeat|scheduled|due|start)\s*::\s*[^\])]*[\])]/g, '')
    .replace(/[➕⏳📅🛫✅❌]\s*\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?/gu, '')
    .replace(/\[scheduled\s*::/g, '')
    .replace(/[\r\n]/g, ' ').trim();
}
export function endClock(block: Block): string {
  return clock(block.end) === '00:00' && dateKey(atDate(block.end)) > block.date ? '24:00' : clock(block.end);
}
export function blockLine(block: Block, mode: Settings['outputMode'], ganttFilter = '🎯'): string {
  if (block.raw) return block.raw;
  const link = block.path.replace(/\.md$/, '');
  if (/[\[\]|\r\n]/.test(link)) throw new Error(`Source-note path cannot safely be represented as a wikilink: ${block.path}`);
  const priority = block.priority ?? 3;
  const priorityDisplay = mode === 'gantt' ? `[priority:: ${({ 1: 'lowest', 2: 'low', 3: 'normal', 4: 'high', 5: 'highest' } as Record<number, string>)[priority]}]` : prioritySymbol(priority);
  const body = `${priorityDisplay} ${displayTitle(block.title)} [[${link}]]`;
  const metadata = `<!-- as-block id=${block.id} task=${block.taskId} locked=${block.locked} -->`;
  const checkbox=block.completed?'x':' ';
  if (mode === 'gantt') {
    const stamp = (minute: number): string => `${dateKey(atDate(minute))} ${clock(minute)}`;
    return `- [${checkbox}] ${ganttFilter ? ganttFilter.trim() + ' ' : ''}${clock(block.start)} - ${endClock(block)} ${body} %%[as-block:: id=${block.id} task=${block.taskId} locked=${block.locked}]%% [start:: ${stamp(block.start)}] [scheduled:: ${stamp(block.start)}] [due:: ${stamp(block.end)}]`;
  }
  return mode === 'day-planner'
    ? `- [${checkbox}] ${clock(block.start)} - ${endClock(block)} ${body} [scheduled:: ${block.date}] ${metadata}`
    : `- ${block.date} ${clock(block.start)}-${endClock(block)} ${body} ${metadata}`;
}
export function renderOutput(document: OutputDocument, blocks: Block[], mode: Settings['outputMode'], ganttFilter = '🎯'): string {
  const lines = [START]; let previous = '';
  for (const block of [...blocks].sort((a, b) => a.start - b.start || (b.priority ?? 3) - (a.priority ?? 3) || a.id.localeCompare(b.id))) {
    if (block.date !== previous) { lines.push('', `## ${block.date}`); previous = block.date; }
    lines.push(blockLine(block, mode, ganttFilter));
  }
  lines.push('', END);
  return document.prefix + lines.join(document.newline) + document.suffix;
}
export function prioritySymbol(priority: number): string { return ({ 1: '⏬', 2: '🔽', 3: '🔼', 4: '⏫', 5: '🔺' } as Record<number, string>)[priority] ?? '🔼'; }
export function emptyManagedFile(): string { return `${START}\n\n${END}\n`; }
export function diffBlocks(before: Block[], after: Block[]): { added: Block[]; removed: Block[]; retained: Block[] } {
  const key = (b: Block): string => JSON.stringify([b.id, b.start, b.end, b.locked, b.completed]);
  const previous = new Set(before.map(key)), next = new Set(after.map(key));
  return { added: after.filter(b => !previous.has(key(b))), removed: before.filter(b => !next.has(key(b))), retained: after.filter(b => previous.has(key(b))) };
}
