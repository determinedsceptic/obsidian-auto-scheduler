import { GRID, localMinute, parseBoundary } from './time';
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
    if (!match || !allowed.includes(match[1])) throw new Error(`未知或非法字段：${token}`);
    if (match[1] in result) throw new Error(`重复字段：${match[1]}`);
    result[match[1]] = match[2];
  }
  return result;
}
export function idField(value: string | undefined): string {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('ID 需为字母、数字、下划线或短横线');
  return value;
}
function integer(value: string | undefined, name: string): number {
  if (!value || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`${name} 需为整数`);
  return Number(value);
}
export function parseTasks(sources: Source[]): { tasks: Task[]; errors: Diagnostic[] } {
  const tasks: Task[] = [], errors: Diagnostic[] = []; const ids = new Map<string, string>();
  for (const source of sources) for (const { text, line } of visibleLines(source.content)) {
    if (!/<!--\s*as(?:\s|-->)/.test(text)) continue;
    try {
      const match = /^\s*(?:[-*+]|\d+[.)])\s+\[([ xX])\]\s+(.+?)\s*<!--\s*as\s+(.+?)\s*-->\s*$/.exec(text);
      if (!match || (text.match(/<!--\s*as\s/g) || []).length !== 1) throw new Error('任务格式错误：元数据须在复选框列表项末尾，且仅出现一次');
      const f = fields(match[3], ['id', 'remaining', 'priority', 'due', 'earliest', 'split', 'min']);
      const id = idField(f.id), remaining = integer(f.remaining, 'remaining'), priority = integer(f.priority, 'priority');
      const min = integer(f.min ?? '30', 'min');
      if (remaining <= 0 || remaining % GRID || min <= 0 || min % GRID || min > remaining) throw new Error('remaining/min 须为正的 15 分钟倍数，且 min <= remaining');
      if (priority < 1 || priority > 5) throw new Error('priority 范围为 1–5');
      if (f.split !== undefined && !['true', 'false'].includes(f.split)) throw new Error('split 只能为 true 或 false');
      const due = f.due ? parseBoundary(f.due, true) : undefined;
      const earliest = f.earliest ? parseBoundary(f.earliest) : undefined;
      if (due !== undefined && earliest !== undefined && earliest >= due) throw new Error('earliest 必须早于 due');
      if (ids.has(id)) throw new Error(`重复 ID ${id}，已存在于 ${ids.get(id)}`);
      ids.set(id, `${source.path}:${line}`);
      tasks.push({ id, title: match[2], path: source.path, line, remaining, priority, due, earliest, split: f.split !== 'false', min, completed: match[1] !== ' ' });
    } catch (error) { errors.push({ path: source.path, line, message: (error as Error).message }); }
  }
  return { tasks, errors };
}
export function parseFixed(source: Source): { intervals: Interval[]; errors: Diagnostic[] } {
  const intervals: Interval[] = [], errors: Diagnostic[] = [];
  for (const { text, line } of visibleLines(source.content)) {
    if (!text.trim() || /^\s*#/.test(text)) continue;
    try {
      const match = /^\s*[-*+] (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})(?:\s+.*)?$/.exec(text);
      if (!match) throw new Error('固定日程格式：- YYYY-MM-DD HH:mm-HH:mm 标题');
      const start = localMinute(match[1], match[2]), end = localMinute(match[1], match[3]);
      if (end <= start) throw new Error('固定日程结束时间须晚于开始时间');
      intervals.push({ start, end });
    } catch (error) { errors.push({ path: source.path, line, message: (error as Error).message }); }
  }
  return { intervals, errors };
}
