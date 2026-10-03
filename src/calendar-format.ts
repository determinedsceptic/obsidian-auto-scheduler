import { parseBoundary, atDate, dateKey, clock } from './time';
/** Independent reader for the public Tasks/Dataview Markdown schema. */
export function calendarDate(body: string, field: 'due' | 'start' | 'scheduled'): number | undefined {
  const symbol = { due: '📅', start: '🛫', scheduled: '⏳' }[field];
  const inline = [...body.matchAll(new RegExp(`\\[${field}::\\s*([^\\]]+)\\]`, 'gi'))].map(m => m[1].trim());
  const emoji = [...body.matchAll(new RegExp(`${symbol}\\s*(\\d{4}-\\d{2}-\\d{2}(?: \\d{2}:\\d{2})?)`, 'gu'))].map(m => m[1]);
  const values = [...inline, ...emoji];
  if (!values.length) return undefined;
  const parsed = values.map(value => parseBoundary(value.replace(' ', 'T'), field === 'due'));
  if (parsed.some(value => value !== parsed[0])) throw new Error(`${field} conflicting date fields`);
  return parsed[0];
}
export function calendarPriority(body: string): number {
  // Five internal levels: medium and normal share level 3.
  const levels: Record<string, number> = { highest: 5, high: 4, medium: 3, normal: 3, low: 2, lowest: 1 };
  const inline = /\[priority::\s*([^\]]+)\]/i.exec(body);
  if (inline) {
    const value = levels[inline[1].trim().toLowerCase()];
    if (!value) throw new Error('Unknown calendar priority field');
    return value;
  }
  const symbol = /🔺|⏫|🔼|🔽|⏬/u.exec(body)?.[0];
  return symbol ? ({ '🔺': 5, '⏫': 4, '🔼': 3, '🔽': 2, '⏬': 1 }[symbol] ?? 3) : 3;
}
export function normalizeMetadata(text: string, key: 'as' | 'as-block'): string {
  return text.replace(new RegExp(`%%\\[${key}::\\s*([^\\]]+)\\]%%`, 'g'), `<!-- ${key} $1 -->`);
}

/** Date-only deadlines use the following midnight internally. */
export function deadlineLabel(minute: number): string {
  return clock(minute) === '00:00' ? dateKey(atDate(minute - 1)) : `${dateKey(atDate(minute))} ${clock(minute)}`;
}
