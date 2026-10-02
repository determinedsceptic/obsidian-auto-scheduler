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
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) throw new Error(`Invalid date: ${key}`);
  const [y, m, d] = key.split('-').map(Number);
  if (y < 1900 || y > 9999) throw new Error(`Year out of supported range: ${key}`);
  const result = new Date(y, m - 1, d);
  if (dateKey(result) !== key) throw new Error(`Invalid date: ${key}`);
  return result;
}
export function addDays(key: string, count: number): string {
  const d = dayDate(key); d.setDate(d.getDate() + count); return dateKey(d);
}
export function clockMinutes(value: string, allowMidnightEnd = false): number {
  if (allowMidnightEnd && value === '24:00') return 1440;
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error(`Invalid time: ${value}`);
  const [h, m] = value.split(':').map(Number); return h * 60 + m;
}
export function localMinute(key: string, value: string): number {
  const offset = clockMinutes(value, true);
  if (offset === 1440) return epochMinute(dayDate(addDays(key, 1)));
  const d = dayDate(key); d.setHours(Math.floor(offset / 60), offset % 60, 0, 0);
  if (dateKey(d) !== key || clock(epochMinute(d)) !== value) throw new Error(`Local time jumps at: ${key} ${value}`);
  return epochMinute(d);
}
export function parseBoundary(value: string, endOfDate = false): number {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return localMinute(value, endOfDate ? '24:00' : '00:00');
  const match = /^(\d{4}-\d{2}-\d{2})T((?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value);
  if (!match) throw new Error(`Use YYYY-MM-DD or YYYY-MM-DDTHH:mm: ${value}`);
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
  for (const field of ['taskFolder', 'habitFolder', 'fixedFile', 'outputFile'] as const) {
    const value = settings[field];
    if (!safeVaultPath(value)) {
      errors.push(`${field} must be a vault-relative path without hidden folders or ..`);
    }
  }
  if ([settings.taskFolder, settings.dailyFolder].some(folder => folder === settings.habitFolder || folder?.startsWith(settings.habitFolder + '/')) || [settings.fixedFile, settings.outputFile].some(path => path === settings.habitFolder || path?.startsWith(settings.habitFolder + '/'))) errors.push('The habits folder cannot contain the task folder, daily folder, or fixed/output files');
  if (!settings.fixedFile?.endsWith('.md') || !settings.outputFile?.endsWith('.md')) errors.push('Fixed-event and output paths must end in .md');
  if (settings.fixedFile === settings.outputFile) errors.push('Fixed-event and output files cannot be the same');
  if (settings.taskFolder === settings.outputFile || settings.taskFolder === settings.fixedFile) errors.push('The task folder cannot be an input/output file');
  if (!Array.isArray(settings.weekdays) || !settings.weekdays.length || new Set(settings.weekdays).size !== settings.weekdays.length || settings.weekdays.some(n => !Number.isInteger(n) || n < 0 || n > 6)) errors.push('Working days must be distinct values 0–6 (0 is Sunday)');
  if (!['plain', 'day-planner', 'gantt'].includes(settings.outputMode)) errors.push('Unknown output format');
  if (!['single', 'daily'].includes(settings.outputLocation)) errors.push('Unknown output location');
  if (typeof settings.ganttFilter !== 'string' || settings.ganttFilter.length > 100 || /[\r\n<>\[\]%]/.test(settings.ganttFilter)) errors.push('Gantt prefix must be plain text on one line');
  if (!safeVaultPath(settings.dailyFolder)) errors.push('dailyFolder must be a safe vault-relative folder');
  if (settings.outputLocation === 'daily' && settings.outputMode === 'plain') errors.push('Daily notes require Day Planner or Gantt format');
  for (const field of ['dailyCapacity', 'fixedBuffer', 'blockBuffer'] as const) {
    if (!Number.isInteger(settings[field]) || settings[field] < (field === 'dailyCapacity' ? 15 : 0) || settings[field] > 1440 || settings[field] % GRID) errors.push(`${field} must be a multiple of 15 minutes within the allowed range`);
  }
  try {
    if (!Array.isArray(settings.periods) || !settings.periods.length) throw new Error('Set at least one working period');
    const periods = settings.periods.map(period => {
      if (typeof period !== 'string' || !/^\d{2}:\d{2}-\d{2}:\d{2}$/.test(period)) throw new Error('Working-period format is HH:mm-HH:mm');
      const [a, b] = period.split('-'); const start = clockMinutes(a), end = clockMinutes(b, true);
      if (end <= start || start % GRID || end % GRID) throw new Error('Working periods must increase within one day on the 15-minute grid');
      return { start, end };
    }).sort((a, b) => a.start - b.start);
    if (periods.some((p, i) => i > 0 && overlap(p, periods[i - 1]))) errors.push('Working periods cannot overlap');
  } catch (error) { errors.push((error as Error).message); }
  return errors;
}
export function assertStableWeek(startKey: string): void {
  const first = dayDate(startKey).getTimezoneOffset();
  for (let i = 0; i <= 7; i++) {
    const d = dayDate(addDays(startKey, i));
    for (let hour = 0; hour < 24; hour++) {
      const check = new Date(d); check.setHours(hour);
      if (check.getTimezoneOffset() !== first) throw new Error('This week has a time-zone or DST transition, which is not supported yet');
    }
  }
}
