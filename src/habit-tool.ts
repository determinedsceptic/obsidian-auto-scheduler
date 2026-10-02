import skill from '../skills/habits/SKILL.md?raw';
import { parseHabits } from './habits';
import { prioritySymbol } from './output';
import { safeVaultPath } from './time';
import type { Settings } from './types';
export interface HabitDraft { title: string; start: string; end: string; days: number[]; priority: number }
const properties = {
  title: { type: 'string', description: '用户明确要求的习惯名称，单行普通文本' },
  start: { type: 'string', description: '用户指定的本地 HH:mm 开始时间，15 分钟网格' },
  end: { type: 'string', description: '同日 HH:mm 结束时间，可为 24:00' },
  days: { type: 'array', items: { type: 'integer', enum: [0, 1, 2, 3, 4, 5, 6] }, description: '星期，0周日；每天0–6' },
  priority: { type: 'integer', enum: [1, 2, 3, 4, 5] },
};
export const habitTool = { name: 'create_habits', description: '记录用户明确要求的固定时间周期习惯到宿主指定模板，并立即生成未来七天计划。缺少时间或周期先询问。', strict: true,
  parameters: { type: 'object', properties: { habits: { type: 'array', items: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false } } }, required: ['habits'], additionalProperties: false } };
export function habitPath(settings: Settings): string {
  if (!safeVaultPath(settings.habitFolder)) throw new Error('习惯目录无效');
  return `${settings.habitFolder}/AI-Habits.md`;
}
export function habitInstructions(settings: Settings): string {
  return `${skill}\n本次习惯目录：${JSON.stringify(settings.habitFolder)}；写入模板：${JSON.stringify(habitPath(settings))}；日计划：${JSON.stringify(settings.dailyFolder + '/YYYY-MM-DD.md')}。`;
}
export function validateHabitDrafts(value: unknown): HabitDraft[] {
  const args = value as { habits?: unknown };
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(k => k !== 'habits') || !Array.isArray(args.habits) || !args.habits.length || args.habits.length > 20) throw new Error('一次需创建 1–20 个习惯');
  return args.habits.map(input => {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 5 || Object.keys(input).some(k => !(k in properties))) throw new Error('习惯字段无效');
    const h = input as HabitDraft;
    if (typeof h.title !== 'string' || !h.title.trim() || h.title.length > 200 || /[\r\n\x00-\x1f<>\[\]%（）()🔺⏫🔼🔽⏬]/u.test(h.title)) throw new Error('习惯标题需为单行普通文本');
    if (typeof h.start !== 'string' || typeof h.end !== 'string' || !Array.isArray(h.days) || !h.days.length || h.days.some(d => !Number.isInteger(d) || d < 0 || d > 6) || new Set(h.days).size !== h.days.length || !Number.isInteger(h.priority) || h.priority < 1 || h.priority > 5) throw new Error('习惯时间、星期或重要性无效');
    const parsed = parseHabits([{ path: 'Habits/AI-Habits.md', content: habitLine(h) }]);
    if (parsed.errors.length) throw new Error(parsed.errors[0].message);
    return { title: h.title.trim(), start: h.start, end: h.end, days: [...h.days].sort((a, b) => a - b), priority: h.priority };
  });
}
export function habitLine(h: HabitDraft): string {
  const names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  return `- ${h.start}-${h.end} ${prioritySymbol(h.priority)} ${h.title.trim()}（${h.days.map(d => names[d]).join('、')}）`;
}
export function appendHabits(before: string | null, drafts: HabitDraft[]): string {
  const checked = validateHabitDrafts({ habits: drafts });
  const text = before ?? '# AI 习惯\n';
  const result = text + (text.endsWith('\n') ? '\n' : '\n\n') + checked.map(habitLine).join('\n') + '\n';
  const parsed = parseHabits([{ path: 'Habits/AI-Habits.md', content: result }]);
  if (parsed.errors.length) throw new Error(parsed.errors.map(e => e.message).join('\n'));
  if (parsed.habits.length !== parseHabits([{ path: 'Habits/AI-Habits.md', content: text }]).habits.length + checked.length) throw new Error('习惯模板末尾有未关闭的代码块，请修正模板');
  return result;
}
