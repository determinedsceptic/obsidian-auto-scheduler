import { calendarDate, normalizeMetadata } from './calendar-format';
import { fields, idField } from './parser';
import { clock, dateKey, atDate, localMinute } from './time';
import type { Block, OutputDocument, Settings } from './types';
export const START = '<!-- auto-scheduler:start -->';
export const END = '<!-- auto-scheduler:end -->';
const count = (text: string, token: string): number => text.split(token).length - 1;
export function parseOutput(content: string | null): OutputDocument {
  if (content === null) return { prefix: '# Auto Scheduler\n\n', suffix: '\n', newline: '\n', blocks: [] };
  if (count(content, START) !== 1 || count(content, END) !== 1) throw new Error('输出文件必须含唯一的管理区起止标记；拒绝接管或覆盖普通文件');
  const start = content.indexOf(START), end = content.indexOf(END);
  if (end < start || (start > 0 && content[start - 1] !== '\n') || /[^\r\n]/.test(content.slice(start + START.length, content.indexOf('\n', start) < 0 ? content.length : content.indexOf('\n', start))) || (end > 0 && content[end - 1] !== '\n')) throw new Error('管理区标记必须独占一行并按顺序出现');
  const afterEnd = content.slice(end + END.length);
  if (afterEnd && !afterEnd.startsWith('\n') && !afterEnd.startsWith('\r\n')) throw new Error('管理区结束标记必须独占一行');
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const blocks: Block[] = []; const ids = new Set<string>();
  const region = content.slice(start + START.length, end);
  for (const raw of region.split(/\r?\n/)) {
    let normalized = normalizeMetadata(raw, 'as-block');
    const fullStart = calendarDate(normalized, 'start'), fullEnd = calendarDate(normalized, 'due');
    if (fullStart !== undefined || fullEnd !== undefined) {
      if (fullStart === undefined || fullEnd === undefined || fullEnd <= fullStart) throw new Error('Gantt 工作块须有有效的 start/due 时间');
      const scheduledTime = calendarDate(normalized, 'scheduled');
      if (scheduledTime !== fullStart) throw new Error('Gantt scheduled 与 start 不一致');
      const metadata = /<!-- as-block .+? -->/.exec(normalized)?.[0];
      if (metadata) normalized = normalized.replace(metadata, '').trim() + ' ' + metadata;
      normalized = normalized.replace(/\[(?:start|due)::[^\]]+\]/gi, '').replace(/\[scheduled::[^\]]+\]/i, `[scheduled:: ${dateKey(atDate(fullStart))}]`).replace(/ +/g, ' ');
    }
    if (!raw.trim()) continue;
    if (/^## \d{4}-\d{2}-\d{2}$/.test(raw)) { localMinute(raw.slice(3), '00:00'); continue; }
    const match = /^- (?:\[([ xX])\] (?:[^\r\n]*? )?)?(?:(\d{4}-\d{2}-\d{2}) )?(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2}) (.+?)\s*<!-- as-block (.+?) -->$/.exec(normalized);
    if (!match) throw new Error(`管理区含不可识别内容：${raw}`);
    const f = fields(match[6], ['id', 'task', 'locked']);
    const id = idField(f.id), taskId = idField(f.task);
    if (!['true', 'false'].includes(f.locked)) throw new Error(`块 ${id} locked 字段非法`);
    if (ids.has(id)) throw new Error(`重复工作块 ID：${id}`);
    ids.add(id);
    const scheduled = [...match[5].matchAll(/\[scheduled:: (\d{4}-\d{2}-\d{2})\]/g)];
    const date = match[2] ?? scheduled[0]?.[1];
    if (!date || (match[1] !== undefined && (scheduled.length !== 1 || match[2] !== undefined)) || (match[1] === undefined && scheduled.length > 0)) throw new Error(`块 ${id} 日期/格式不一致`);
    const startTime = localMinute(date, match[3]), endTime = localMinute(date, match[4]);
    if (endTime <= startTime || dateKey(atDate(startTime)) !== date) throw new Error(`块 ${id} 结束时间须晚于开始时间`);
    if (fullStart !== undefined && (startTime !== fullStart || endTime !== fullEnd)) throw new Error('Gantt 时钟范围与日期时间不一致');
    const links = [...match[5].matchAll(/\[\[([^\[\]]+)\]\]/g)];
    const path = links[links.length - 1]?.[1] ?? '';
    if (!path) throw new Error(`块 ${id} 缺少源笔记链接`);
    blocks.push({ id, taskId, date, start: startTime, end: endTime, title: match[5], path: path.endsWith('.md') ? path : `${path}.md`, locked: f.locked === 'true', completed: match[1] !== undefined && match[1] !== ' ', raw });
  }
  return { prefix: content.slice(0, start), suffix: afterEnd, newline, blocks };
}
/** Strip scheduling display fields only; the source Markdown is never changed. */
export function displayTitle(title: string): string {
  return title.replace(/<!--.*?-->/g, '')
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
  if (/[\[\]|\r\n]/.test(link)) throw new Error(`源笔记路径不能安全表示为 wikilink：${block.path}`);
  const body = `工作块：${displayTitle(block.title)} [[${link}]]`;
  const metadata = `<!-- as-block id=${block.id} task=${block.taskId} locked=${block.locked} -->`;
  if (mode === 'gantt') {
    const stamp = (minute: number): string => `${dateKey(atDate(minute))} ${clock(minute)}`;
    return `- [ ] ${ganttFilter ? ganttFilter.trim() + ' ' : ''}${clock(block.start)} - ${endClock(block)} ${body} %%[as-block:: id=${block.id} task=${block.taskId} locked=${block.locked}]%% [start:: ${stamp(block.start)}] [scheduled:: ${stamp(block.start)}] [due:: ${stamp(block.end)}]`;
  }
  return mode === 'day-planner'
    ? `- [ ] ${clock(block.start)} - ${endClock(block)} ${body} [scheduled:: ${block.date}] ${metadata}`
    : `- ${block.date} ${clock(block.start)}-${endClock(block)} ${body} ${metadata}`;
}
export function renderOutput(document: OutputDocument, blocks: Block[], mode: Settings['outputMode'], ganttFilter = '🎯'): string {
  const lines = [START]; let previous = '';
  for (const block of [...blocks].sort((a, b) => a.start - b.start || a.id.localeCompare(b.id))) {
    if (block.date !== previous) { lines.push('', `## ${block.date}`); previous = block.date; }
    lines.push(blockLine(block, mode, ganttFilter));
  }
  lines.push('', END);
  return document.prefix + lines.join(document.newline) + document.suffix;
}
export function emptyManagedFile(): string { return `${START}\n\n${END}\n`; }
export function diffBlocks(before: Block[], after: Block[]): { added: Block[]; removed: Block[]; retained: Block[] } {
  const key = (b: Block): string => JSON.stringify([b.id, b.start, b.end, b.locked, b.completed]);
  const previous = new Set(before.map(key)), next = new Set(after.map(key));
  return { added: after.filter(b => !previous.has(key(b))), removed: before.filter(b => !next.has(key(b))), retained: after.filter(b => previous.has(key(b))) };
}
