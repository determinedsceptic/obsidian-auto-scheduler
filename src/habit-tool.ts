import skill from '../skills/habits/SKILL.md?raw';
import { parseHabits } from './habits';
import { prioritySymbol } from './output';
import { safeVaultPath, endAfter } from './time';
import type { Settings } from './types';
export interface HabitDraft { title: string; start: string; end: string; days: number[]; priority: number }
const properties = {
  title: { type: 'string', description: 'Habit name explicitly requested by the user; plain text on one line' },
  start: { type: 'string', description: 'User-specified local start time in HH:mm, on a 15-minute grid' },
  end: { type: ['string', 'null'], description: 'Null if duration is unspecified; otherwise same-day end time in HH:mm; 24:00 is allowed' },
  days: { type: 'array', items: { type: 'integer', enum: [0, 1, 2, 3, 4, 5, 6] }, description: 'Weekdays: 0 is Sunday; every day means 0–6' },
  priority: { type: 'integer', enum: [1, 2, 3, 4, 5] },
};
export const habitTool = { name: 'create_habits', description: 'Save an explicitly requested fixed-time recurring habit to the host-controlled template and schedule the next seven days. Ask for missing start time or recurrence first; use null end if duration is unspecified.', strict: true,
  parameters: { type: 'object', properties: { habits: { type: 'array', items: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false } } }, required: ['habits'], additionalProperties: false } };
export function habitPath(settings: Settings): string {
  if (!safeVaultPath(settings.habitFolder)) throw new Error('Invalid habits folder');
  return `${settings.habitFolder}/AI-Habits.md`;
}
export function habitInstructions(settings: Settings): string {
  return `${skill}\nHabits folder: ${JSON.stringify(settings.habitFolder)}; template destination: ${JSON.stringify(habitPath(settings))}; daily notes: ${JSON.stringify(settings.dailyFolder + '/YYYY-MM-DD.md')}。`;
}
export function validateHabitDrafts(value: unknown, defaultDuration = 30): HabitDraft[] {
  const args = value as { habits?: unknown };
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(k => k !== 'habits') || !Array.isArray(args.habits) || !args.habits.length || args.habits.length > 20) throw new Error('Create 1–20 habits per request');
  return args.habits.map(input => {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 5 || Object.keys(input).some(k => !(k in properties))) throw new Error('Invalid habit fields');
    const original = input as HabitDraft;
    const h = { ...original, end: original.end === null ? endAfter(original.start, defaultDuration) : original.end };
    if (typeof h.title !== 'string' || !h.title.trim() || h.title.length > 200 || /[\r\n\x00-\x1f<>\[\]%（）()🔺⏫🔼🔽⏬]/u.test(h.title)) throw new Error('Habit titles must be plain text on one line');
    if (typeof h.start !== 'string' || typeof h.end !== 'string' || !Array.isArray(h.days) || !h.days.length || h.days.some(d => !Number.isInteger(d) || d < 0 || d > 6) || new Set(h.days).size !== h.days.length || !Number.isInteger(h.priority) || h.priority < 1 || h.priority > 5) throw new Error('Invalid habit time, weekdays, or priority');
    const parsed = parseHabits([{ path: 'Habits/AI-Habits.md', content: habitLine(h) }]);
    if (parsed.errors.length) throw new Error(parsed.errors[0].message);
    return { title: h.title.trim(), start: h.start, end: h.end, days: [...h.days].sort((a, b) => a - b), priority: h.priority };
  });
}
export function habitLine(h: HabitDraft): string {
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return `- ${h.start}-${h.end} ${prioritySymbol(h.priority)} ${h.title.trim()} (${h.days.map(d => names[d]).join(', ')})`;
}
export function appendHabits(before: string | null, drafts: HabitDraft[], defaultDuration = 30): string {
  const checked = validateHabitDrafts({ habits: drafts });
  const text = before ?? '# AI habits\n';
  const result = text + (text.endsWith('\n') ? '\n' : '\n\n') + checked.map(habitLine).join('\n') + '\n';
  const parsed = parseHabits([{ path: 'Habits/AI-Habits.md', content: result }], defaultDuration);
  if (parsed.errors.length) throw new Error(parsed.errors.map(e => e.message).join('\n'));
  if (parsed.habits.length !== parseHabits([{ path: 'Habits/AI-Habits.md', content: text }], defaultDuration).habits.length + checked.length) throw new Error('An unclosed code fence at the end of the habits template would hide new habits. Close it first.');
  return result;
}
