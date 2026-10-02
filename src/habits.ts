import { fields, idField, visibleLines } from './parser';
import type { Source } from './parser';
import { addDays, clockMinutes, dayDate, GRID, localMinute } from './time';
import type { Block, Diagnostic, Task } from './types';

export const HABIT_PREFIX = 'habit_';
export const isHabit = (id: string): boolean => id.startsWith(HABIT_PREFIX);
export interface Habit {
  id: string; title: string; path: string; line: number; start: string; end: string;
  days: number[]; priority: number; enabled: boolean; from?: string; until?: string;
}
export const HABIT_TEMPLATE = `# 习惯模板

每行一个习惯。days：0=周日，1=周一，…，6=周六；每天填写 0,1,2,3,4,5,6。
将 enabled=false 改为 enabled=true 后生效。priority 为 1–5，5 最重要。
可选 from=YYYY-MM-DD until=YYYY-MM-DD（含当天）。时间须在同一天、为 15 分钟倍数。
习惯先占用固定时间，再安排其他任务；沿用固定日程和工作块缓冲设置。

- 19:00-19:30 晚上锻炼 <!-- habit id=exercise days=1,3,5 priority=3 enabled=false -->
- 22:00-22:15 睡前阅读 <!-- habit id=reading days=0,1,2,3,4,5,6 priority=2 enabled=false -->
`;
export function parseHabits(sources: Source[]): { habits: Habit[]; errors: Diagnostic[] } {
  const habits: Habit[] = [], errors: Diagnostic[] = [], ids = new Set<string>();
  for (const source of sources) for (const { text, line } of visibleLines(source.content)) {
    if (!/<!--\s*habit(?:\s|-->)/.test(text)) continue;
    try {
      const match = /^- (\d{2}:\d{2})\s*-\s*(\d{2}:\d{2}) (.+?)\s*<!-- habit (.+?) -->\s*$/.exec(text);
      if (!match) throw new Error('习惯格式应为 - HH:mm-HH:mm 标题 <!-- habit id=... days=... -->');
      const f = fields(match[4], ['id', 'days', 'priority', 'enabled', 'from', 'until']);
      const id = idField(f.id);
      if (ids.has(id)) throw new Error(`重复习惯 ID：${id}`);
      const start = clockMinutes(match[1]), end = clockMinutes(match[2], true);
      if (end <= start || start % GRID || end % GRID) throw new Error('习惯时间须同日递增且在 15 分钟网格上');
      if (!f.days || !/^[0-6](?:,[0-6])*$/.test(f.days)) throw new Error('days 需为逗号分隔的 0–6');
      const days = f.days.split(',').map(Number);
      if (new Set(days).size !== days.length) throw new Error('days 不能重复');
      if (f.priority !== undefined && !/^[1-5]$/.test(f.priority)) throw new Error('priority 需为 1–5');
      if (f.enabled !== undefined && !['true', 'false'].includes(f.enabled)) throw new Error('enabled 需为 true 或 false');
      for (const key of ['from', 'until']) if (f[key]) dayDate(f[key]);
      if (f.from && f.until && f.from > f.until) throw new Error('from 不能晚于 until');
      if (/[\[\]<>%]/.test(match[3])) throw new Error('习惯标题需为普通文本');
      ids.add(id);
      habits.push({ id, title: match[3], path: source.path, line, start: match[1], end: match[2], days, priority: Number(f.priority ?? 3), enabled: f.enabled !== 'false', from: f.from, until: f.until });
    } catch (error) { errors.push({ path: source.path, line, message: (error as Error).message }); }
  }
  return { habits, errors };
}
/** Completed occurrences survive template edits; unchecked occurrences are rebuilt. */
export function expandHabits(habits: Habit[], previous: Block[], today: string, count = 7): { tasks: Task[]; blocks: Block[] } {
  const until = addDays(today, count);
  const blocks = previous.filter(b => isHabit(b.taskId) && (b.completed || b.date < today || b.date >= until)).map(b => ({ ...b }));
  const tasks: Task[] = blocks.map(b => ({ id: b.taskId, title: b.title, path: b.path, line: 0, remaining: b.end - b.start, min: b.end - b.start, priority: b.priority ?? 3, split: false, completed: true }));
  const completed = new Set(blocks.map(b => b.taskId));
  for (let i = 0; i < count; i++) {
    const date = addDays(today, i);
    for (const h of habits) {
      if (!h.enabled || !h.days.includes(dayDate(date).getDay()) || (h.from && date < h.from) || (h.until && date > h.until)) continue;
      const taskId = `${HABIT_PREFIX}${h.id}_${date.replace(/-/g, '')}`;
      if (completed.has(taskId)) continue;
      const start = localMinute(date, h.start), end = localMinute(date, h.end), duration = end - start;
      tasks.push({ id: taskId, title: h.title, path: h.path, line: h.line, remaining: duration, min: duration, priority: h.priority, earliest: start, due: end, split: false, completed: false });
      blocks.push({ id: `h_${taskId}`, taskId, date, start, end, title: h.title, priority: h.priority, path: h.path, locked: true, completed: false });
    }
  }
  return { tasks, blocks };
}
