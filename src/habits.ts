import { calendarPriority } from './calendar-format';
import { fields, idField, visibleLines } from './parser';
import type { Source } from './parser';
import { addDays, clockMinutes, dayDate, GRID, localMinute, endAfter } from './time';
import type { Block, Diagnostic, Task } from './types';

export const HABIT_PREFIX = 'habit_';
export const isHabit = (id: string): boolean => id.startsWith(HABIT_PREFIX);
export interface Habit {
  id: string; title: string; path: string; line: number; start: string; end: string;
  days: number[]; priority: number; enabled: boolean; from?: string; until?: string;
}
export const HABIT_TEMPLATE = `# Habits

Add time-based list items outside code fences to enable habits. Without a recurrence suffix, a habit repeats every day.
Use (every day), (weekdays), (weekends), or a list such as (Mon, Wed, Fri).
Priority symbols: 🔺 highest, ⏫ high, 🔼 normal, 🔽 low, ⏬ lowest. Omit for normal priority.
Times must be within one day on a 15-minute grid. Habits reserve time before ordinary tasks.
Start-only rows use the configured Default duration (30 minutes initially).

Examples below are inactive. Copy a line outside this code fence to enable it:

\`\`\`markdown
- 19:00-19:30 Evening walk (Mon, Wed, Fri)
- 22:00-22:15 🔽 Read a book (every day)
\`\`\`
`;
const weekdays: Record<string, number[]> = {
  'every day': [0, 1, 2, 3, 4, 5, 6], 'daily': [0, 1, 2, 3, 4, 5, 6], 'weekdays': [1, 2, 3, 4, 5], 'weekends': [0, 6],
  'sun': [0], 'mon': [1], 'tue': [2], 'wed': [3], 'thu': [4], 'fri': [5], 'sat': [6],
  'sunday': [0], 'monday': [1], 'tuesday': [2], 'wednesday': [3], 'thursday': [4], 'friday': [5], 'saturday': [6],
  '每天': [0, 1, 2, 3, 4, 5, 6], '工作日': [1, 2, 3, 4, 5], '周末': [0, 6],
  '周日': [0], '周天': [0], '周一': [1], '周二': [2], '周三': [3], '周四': [4], '周五': [5], '周六': [6],
};
/** Stable without showing technical IDs in a user's template. */
function plainId(path: string, title: string): string {
  const value = path + '\n' + title;
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  return `template_${(hash >>> 0).toString(16)}`;
}
export function parseHabits(sources: Source[], defaultDuration = 30): { habits: Habit[]; errors: Diagnostic[] } {
  const habits: Habit[] = [], errors: Diagnostic[] = [], ids = new Set<string>();
  for (const source of sources) for (const { text, line } of visibleLines(source.content)) {
    const legacy = /<!--\s*habit(?:\s|-->)/.test(text);
    if (!legacy && !/^- (?:\[[ xX]\] )?\d{2}:/.test(text)) continue;
    try {
      let match: string[] | null = /^- (\d{2}:\d{2})\s*-\s*(\d{2}:\d{2}) (.+?)\s*<!-- habit (.+?) -->\s*$/.exec(text);
      let f: Record<string, string>;
      if (legacy) {
        if (!match) throw new Error('Invalid legacy habit template format');
        f = fields(match[4], ['id', 'days', 'priority', 'enabled', 'from', 'until']);
      } else {
        let plain: string[] | null = /^- (?:\[([ xX])\] )?(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2}) (.+?)\s*$/.exec(text);
        if (!plain) {
          const single = /^- (?:\[([ xX])\] )?(\d{2}:\d{2}) (?!-)(.+?)\s*$/.exec(text);
          if (single) plain = [single[0], single[1], single[2], endAfter(single[2], defaultDuration), single[3]];
        }
        if (!plain) throw new Error('Use - HH:mm[-HH:mm] Title (weekdays)');
        let title = plain[4].trim();
        const repeat = /[（(]([^（）()]+)[）)]$/.exec(title);
        let days = weekdays['every day'];
        if (repeat) {
          days = repeat[1].split(/[、,，]/).flatMap(day => {
            if (!weekdays[day.trim().toLowerCase()]) throw new Error(`Unknown recurrence: ${day}`);
            return weekdays[day.trim().toLowerCase()];
          });
          title = title.slice(0, repeat.index).trim();
        }
        const priority = calendarPriority(title);
        title = title.replace(/[🔺⏫🔼🔽⏬]/gu, '').trim();
        if (!title) throw new Error('Habit title cannot be empty');
        f = { id: plainId(source.path, title), days: [...new Set(days)].join(','), priority: String(priority), enabled: plain[1] && plain[1] !== ' ' ? 'false' : 'true' };
        match = [plain[0], plain[2], plain[3], title];
      }
      const id = idField(f.id);
      if (ids.has(id)) throw new Error(`Duplicate habit ID: ${id}`);
      const start = clockMinutes(match[1]), end = clockMinutes(match[2], true);
      if (end <= start || start % GRID || end % GRID) throw new Error('Habit times must increase within one day on a 15-minute grid');
      if (!f.days || !/^[0-6](?:,[0-6])*$/.test(f.days)) throw new Error('days must be comma-separated values 0–6');
      const days = f.days.split(',').map(Number);
      if (new Set(days).size !== days.length) throw new Error('days cannot contain duplicates');
      if (f.priority !== undefined && !/^[1-5]$/.test(f.priority)) throw new Error('priority must be 1–5');
      if (f.enabled !== undefined && !['true', 'false'].includes(f.enabled)) throw new Error('enabled must be true or false');
      for (const key of ['from', 'until']) if (f[key]) dayDate(f[key]);
      if (f.from && f.until && f.from > f.until) throw new Error('from cannot be after until');
      if (/[\[\]<>%]/.test(match[3])) throw new Error('Habit titles must be plain text');
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
