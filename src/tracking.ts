import { dateKey, atDate, clock } from './time';
import { deadlineLabel } from './calendar-format';
import { START, END, parseOutput, prioritySymbol } from './output';
import type { DailyTracking, Tracking, TrackingPair } from './types';
const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Record only the generated span, so outside edits and original bytes survive. */
export function cleanDaily(text: string, aiIds: Set<string> = new Set(), priorities: Map<string, number> = new Map(), format = true, deadlines: Map<string, number> = new Map()): { text: string; record: DailyTracking | null } {
  const parsed = parseOutput(text), newline = parsed.newline;
  const annotated = text.slice(text.indexOf(START), text.indexOf(END) + END.length);
  const lines = parsed.blocks.map(b => {
    const line = (b.raw ?? '').replace(/<!-- as-block .+? -->/g, '')
      .replace(/%%\[as-block::[^\]]+\]%%/g, '').replace(/\[(?:start|scheduled|due)::[^\]]+\]/gi, '').replace(aiIds.has(b.taskId) ? / \[\[[^\]]+\]\]/g : /$^/, '');
    const deadline = deadlines.get(b.taskId);
    const suffix = format ? `${deadline !== undefined ? ` 📅 ${deadlineLabel(deadline)}` : ''} 🛫 ${dateKey(atDate(b.start))} ${clock(b.start)} ⏳ ${dateKey(atDate(b.end))} ${clock(b.end)}` : '';
    return (format ? line.replace(/(\d{2}:\d{2}\s*-\s*\d{2}:\d{2}\s+)(?:工作块：\s*)?(?:[🔺⏫🔼🔽⏬]\s*)?/u, `$1${prioritySymbol(priorities.get(b.taskId) ?? b.priority ?? 3)} `) : line).trimEnd() + suffix;
  });
  const visible = lines.join(newline);
  return { text: parsed.prefix + visible + parsed.suffix,
    record: visible ? { visible, annotated } : null };
}
function restore(text: string, record: DailyTracking): string | undefined {
  // A completed checkbox is the only permitted mutation of a generated row.
  const newline = record.visible.includes('\r\n') ? '\r\n' : '\n';
  const pattern = record.visible.split(/\r?\n/).map(line => /^- \[[ xX]\]/.test(line) ? '- \\[([ xX])\\]' + escape(line.slice(5)) : escape(line)).join(escape(newline));
  const matches = [...text.matchAll(new RegExp(`(?:^|(?<=\\n))${pattern}(?=\\r?\\n|$)`, 'g'))];
  if (matches.length !== 1) return undefined;
  const match = matches[0]; let checkbox = 1;
  const annotated = record.annotated.replace(/^- \[[ xX]\]/gm, () => `- [${match[checkbox++] ?? ' '}]`);
  return text.slice(0, match.index) + annotated + text.slice(match.index! + match[0].length);
}
export function rehydrate(text: string | null, pair?: TrackingPair): string | null {
  if (text === null || text.includes(START)) return text;
  if (!pair) return text;
  for (const record of [pair.after, pair.before]) {
    if (!record) continue;
    const restored = restore(text, record);
    if (restored !== undefined) return restored;
  }
  if (!pair.after || !pair.before) {
    // A partially applied new note or a successfully emptied region needs no owner.
    const protectedRecord = pair.after ?? pair.before;
    if (!protectedRecord || !/^\s*- \[[ xX]\].*\d{2}:\d{2}\s*-\s*\d{2}:\d{2}/m.test(text)) return text;
  }
  throw new Error('Generated blocks were edited or the tracked region is not unique; refusing to overwrite. Undo or restore the region and preview again.');
}
export function validTracking(value: unknown): value is Tracking {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = (v: unknown): boolean => v === null || (!!v && typeof v === 'object' && typeof (v as DailyTracking).visible === 'string' && typeof (v as DailyTracking).annotated === 'string');
  return Object.values(value).every(v => !!v && typeof v === 'object' && record((v as TrackingPair).before) && record((v as TrackingPair).after));
}
