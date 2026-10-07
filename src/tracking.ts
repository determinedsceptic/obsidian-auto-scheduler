import { parseBoundary } from './time';
import { deadlineLabel } from './calendar-format';
import { START, END, parseOutput, prioritySymbol } from './output';
import type { DailyTracking, Tracking, TrackingPair } from './types';
import { restoreEventMetadata, validEventRecords } from './event-tracking';
const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Record only the generated span, so outside edits and original bytes survive. */
export function cleanDaily(text: string, aiIds: Set<string> = new Set(), priorities: Map<string, number> = new Map(), format = true, deadlines: Map<string, number> = new Map()): { text: string; record: DailyTracking | null } {
  const parsed = parseOutput(text), newline = parsed.newline;
  const annotated = text.slice(text.indexOf(START), text.indexOf(END) + END.length);
  const lines = parsed.blocks.map(b => {
    let line = (b.raw ?? '').replace(/<!-- as-block .+? -->/g, '')
      .replace(/%%\[as-block::[^\]]+\]%%/g, '').replace(/\[(?:start|scheduled|due)::[^\]]+\]/gi, '').replace(aiIds.has(b.taskId) ? / \[\[[^\]]+\]\]/g : /$^/, '');
    if (format) line = line.replace(/[🛫⏳📅]\s*\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?/gu, '');
    const completed=format?/✅\s*\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?/u.exec(line)?.[0]:undefined;
    if(format)line=line.replace(/\s+✅\s*\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?/gu,'');
    const deadline = deadlines.get(b.taskId);
    const suffix = format && deadline !== undefined ? ` 📅 ${deadlineLabel(deadline)}` : '';
    return (format ? line.replace(/(\d{2}:\d{2}\s*-\s*\d{2}:\d{2}\s+)(?:工作块：\s*)?(?:[🔺⏫🔼🔽⏬]\s*)?/u, `$1${prioritySymbol(priorities.get(b.taskId) ?? b.priority ?? 3)} `) : line).trimEnd() + suffix + (completed?` ${completed}`:'');
  });
  const visible = lines.join(newline);
  return { text: parsed.prefix + visible + parsed.suffix,
    record: visible ? { visible, annotated } : null };
}
function restore(text: string, record: DailyTracking): string | undefined {
  // Permit checkbox changes and the standard Tasks completion-date marker only.
  const newline = record.visible.includes('\r\n') ? '\r\n' : '\n';
  const completion = /\s+✅\s*\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?$/u;
  const pattern = record.visible.split(/\r?\n/).map(line => /^- \[[ xX]\]/.test(line)
    ? '- \\[([ xX])\\]' + escape(line.slice(5).replace(completion,'')) + '(?: (✅\\s*\\d{4}-\\d{2}-\\d{2}(?: \\d{2}:\\d{2})?))?'
    : escape(line)).join(escape(newline));
  const matches = [...text.matchAll(new RegExp(`(?:^|(?<=\\n))${pattern}(?=\\r?\\n|$)`, 'g'))];
  if (matches.length !== 1) return undefined;
  const match = matches[0]; let checkbox = 1, invalid=false;
  const annotated = record.annotated.replace(/^- \[[ xX]\] (.*)$/gm,(_,body:string)=>{
    const checked=match[checkbox++]??' ', completed=match[checkbox++];
    if(completed){
      if(checked===' ')invalid=true;
      try{parseBoundary(completed.replace(/^✅\s*/, '').replace(' ','T'));}catch{invalid=true;}
    }
    const cleaned=body.replace(/\s+✅\s*\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?/gu,'');
    return `- [${checked}] ${completed?cleaned.replace(/(\s+(?:<!-- as-block|%%\[as-block::))/,` ${completed}$1`):cleaned}`;
  });
  if(invalid)return undefined;
  return text.slice(0, match.index) + annotated + text.slice(match.index! + match[0].length);
}
export function rehydrate(text: string | null, pair?: TrackingPair, path?: string): string | null {
  if (text === null) return text;
  if (!pair) return text;
  text=restoreEventMetadata(text,pair.eventRecords??[]);
  if (text.includes(START)) return text;
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
  throw new Error((path ? `${path}: ` : '') + 'Generated blocks were edited or the tracked region is not unique; refusing to overwrite. Undo or open this note and run Recover edited daily schedule tracking to preserve manual edits, then send again.');
}
export function validTracking(value: unknown): value is Tracking {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = (v: unknown): boolean => v === null || (!!v && typeof v === 'object' && typeof (v as DailyTracking).visible === 'string' && typeof (v as DailyTracking).annotated === 'string');
  return Object.values(value).every(v => !!v && typeof v === 'object' && record((v as TrackingPair).before) && record((v as TrackingPair).after)
    && ((v as TrackingPair).eventRecords===undefined||validEventRecords((v as TrackingPair).eventRecords)));
}
