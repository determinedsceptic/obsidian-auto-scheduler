import type { Interval, Settings } from './types';
export const GRID = 15;
export const epochMinute = (date: Date): number => date.getTime() / 60000;
export const atDate = (minute: number): Date => new Date(minute * 60000);
const pad = (n: number): string => String(n).padStart(2, '0');
export function dateKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
export function clock(minute: number): string {
  const d = atDate(minute); return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export function dayDate(key: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) throw new Error(`非法日期：${key}`);
  const [y, m, d] = key.split('-').map(Number);
  if (y < 1900 || y > 9999) throw new Error(`年份超出支持范围：${key}`);
  const result = new Date(y, m - 1, d);
  if (dateKey(result) !== key) throw new Error(`非法日期：${key}`);
  return result;
}
export function addDays(key: string, count: number): string {
  const d = dayDate(key); d.setDate(d.getDate() + count); return dateKey(d);
}
export function clockMinutes(value: string, allowMidnightEnd = false): number {
  if (allowMidnightEnd && value === '24:00') return 1440;
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error(`非法时间：${value}`);
  const [h, m] = value.split(':').map(Number); return h * 60 + m;
}
export function localMinute(key: string, value: string): number {
  const offset = clockMinutes(value, true);
  if (offset === 1440) return epochMinute(dayDate(addDays(key, 1)));
  const d = dayDate(key); d.setHours(Math.floor(offset / 60), offset % 60, 0, 0);
  if (dateKey(d) !== key || clock(epochMinute(d)) !== value) throw new Error(`时间发生跳变：${key} ${value}`);
  return epochMinute(d);
}
export function parseBoundary(value: string, endOfDate = false): number {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return localMinute(value, endOfDate ? '24:00' : '00:00');
  const match = /^(\d{4}-\d{2}-\d{2})T((?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value);
  if (!match) throw new Error(`日期需为 YYYY-MM-DD 或 YYYY-MM-DDTHH:mm：${value}`);
  return localMinute(match[1], match[2]);
}
export const overlap = (a: Interval, b: Interval): boolean => a.start < b.end && b.start < a.end;
export function merge(intervals: Interval[]): Interval[] {
  const result: Interval[] = [];
  for (const item of [...intervals].sort((a, b) => a.start - b.start || a.end - b.end)) {
    if (item.end <= item.start) continue;
    const last = result[result.length - 1];
    if (last && item.start <= last.end) last.end = Math.max(last.end, item.end);
    else result.push({ ...item });
  }
  return result;
}
export function clipped(intervals: Interval[], windows: Interval[]): Interval[] {
  return merge(intervals.flatMap(a => windows.map(b => ({ start: Math.max(a.start, b.start), end: Math.min(a.end, b.end) }))));
}
export const total = (intervals: Interval[]): number => merge(intervals).reduce((sum, i) => sum + i.end - i.start, 0);
export function gaps(window: Interval, occupied: Interval[]): Interval[] {
  let start = window.start; const result: Interval[] = [];
  for (const item of clipped(occupied, [window])) {
    if (item.start > start) result.push({ start, end: item.start });
    start = Math.max(start, item.end);
  }
  if (start < window.end) result.push({ start, end: window.end });
  return result;
}
export function workWindows(key: string, settings: Settings): Interval[] {
  if (!settings.weekdays.includes(dayDate(key).getDay())) return [];
  return settings.periods.map(period => {
    const [start, end] = period.split('-'); return { start: localMinute(key, start), end: localMinute(key, end) };
  });
}
export function safeVaultPath(value: unknown): value is string {
  return typeof value === 'string' && !!value && !/[\r\n\\]/.test(value) && !value.startsWith('/')
    && !value.split('/').some(p => !p || p === '.' || p === '..' || p.startsWith('.'));
}
export function validateSettings(settings: Settings): string[] {
  const errors: string[] = [];
  for (const field of ['taskFolder', 'fixedFile', 'outputFile'] as const) {
    const value = settings[field];
    if (!safeVaultPath(value)) {
      errors.push(`${field} 必须是库内相对路径，不能包含隐藏目录或 ..`);
    }
  }
  if (!settings.fixedFile?.endsWith('.md') || !settings.outputFile?.endsWith('.md')) errors.push('固定日程和输出路径必须以 .md 结尾');
  if (settings.fixedFile === settings.outputFile) errors.push('固定日程和输出文件不能相同');
  if (settings.taskFolder === settings.outputFile || settings.taskFolder === settings.fixedFile) errors.push('任务目录不能是输入/输出文件');
  if (!Array.isArray(settings.weekdays) || !settings.weekdays.length || new Set(settings.weekdays).size !== settings.weekdays.length || settings.weekdays.some(n => !Number.isInteger(n) || n < 0 || n > 6)) errors.push('工作日需为不重复的 0–6（0 为周日）');
  if (!['plain', 'day-planner'].includes(settings.outputMode)) errors.push('未知输出格式');
  for (const field of ['dailyCapacity', 'fixedBuffer', 'blockBuffer'] as const) {
    if (!Number.isInteger(settings[field]) || settings[field] < (field === 'dailyCapacity' ? 15 : 0) || settings[field] > 1440 || settings[field] % GRID) errors.push(`${field} 需为 15 分钟倍数，且在合法范围内`);
  }
  try {
    if (!Array.isArray(settings.periods) || !settings.periods.length) throw new Error('至少设置一个工作时段');
    const periods = settings.periods.map(period => {
      if (typeof period !== 'string' || !/^\d{2}:\d{2}-\d{2}:\d{2}$/.test(period)) throw new Error('工作时段格式为 HH:mm-HH:mm');
      const [a, b] = period.split('-'); const start = clockMinutes(a), end = clockMinutes(b, true);
      if (end <= start || start % GRID || end % GRID) throw new Error('工作时段必须同日、递增，且为 15 分钟网格');
      return { start, end };
    }).sort((a, b) => a.start - b.start);
    if (periods.some((p, i) => i > 0 && overlap(p, periods[i - 1]))) errors.push('工作时段不能重叠');
  } catch (error) { errors.push((error as Error).message); }
  return errors;
}
export function assertStableWeek(startKey: string): void {
  const first = dayDate(startKey).getTimezoneOffset();
  for (let i = 0; i <= 7; i++) {
    const d = dayDate(addDays(startKey, i));
    for (let hour = 0; hour < 24; hour++) {
      const check = new Date(d); check.setHours(hour);
      if (check.getTimezoneOffset() !== first) throw new Error('本周有时区/夏令时跳变，初版不支持该时间范围');
    }
  }
}
