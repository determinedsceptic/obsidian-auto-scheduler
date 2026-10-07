import { parseBoundary } from './time';
import { deadlineLabel } from './calendar-format';
import { START, END, parseOutput, prioritySymbol } from './output';
import type { DailyTracking, Tracking, TrackingPair } from './types';
import { reconcileEventMetadata, validEventRecords } from './event-tracking';
import { dayPlannerSection } from './daily';
import type { ExternalChanges } from './agent-types';
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
function restore(text: string, record: DailyTracking): {text:string;record:DailyTracking} | undefined {
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
  return {text:text.slice(0, match.index) + annotated + text.slice(match.index! + match[0].length),record:{visible:match[0],annotated}};
}

/** Metadata is a hint for unchanged rows, never ownership of the daily note. */
export function reconcileDailyTracking(text:string|null,pair?:TrackingPair):{text:string|null;pair?:TrackingPair} {
  if(text===null||!pair)return {text};
  const events=reconcileEventMetadata(text,pair.eventRecords??[]);
  let restoredText=events.text,after:DailyTracking|null=null;
  if(!text.includes(START))try{
    const section=dayPlannerSection(restoredText);
    if(section)for(const record of [pair.after,pair.before]){
      if(!record)continue;
      const restored=restore(restoredText.slice(section.start,section.end),record);
      if(restored){
        restoredText=restoredText.slice(0,section.start)+restored.text+restoredText.slice(section.end);
        after=restored.record;break;
      }
    }
  }catch{ /* Current Markdown wins over malformed or obsolete metadata. */ }
  return {text:restoredText,...(after||events.eventRecords.length?{pair:{before:null,after,...(events.eventRecords.length?{eventRecords:events.eventRecords}:{})}}:{})};
}

export function rehydrate(text:string|null,pair?:TrackingPair,_path?:string):string|null {
  return reconcileDailyTracking(text,pair).text;
}

/** Drop obsolete hints in the same staged transaction as the requested edit. */
export function prepareTrackingChanges(changes:ExternalChanges,current:Tracking):ExternalChanges {
  const proposed=changes.state?.tracking??current,next=structuredClone(proposed);
  for(const entry of changes.entries){
    if(!next[entry.path])continue;
    const reconciled=reconcileDailyTracking(entry.after,next[entry.path]).pair;
    if(reconciled)next[entry.path]=reconciled;else delete next[entry.path];
  }
  return JSON.stringify(next)===JSON.stringify(proposed)?changes:{...changes,state:{...changes.state,tracking:next}};
}
export function validTracking(value: unknown): value is Tracking {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = (v: unknown): boolean => v === null || (!!v && typeof v === 'object' && typeof (v as DailyTracking).visible === 'string' && typeof (v as DailyTracking).annotated === 'string');
  return Object.values(value).every(v => !!v && typeof v === 'object' && record((v as TrackingPair).before) && record((v as TrackingPair).after)
    && ((v as TrackingPair).eventRecords===undefined||validEventRecords((v as TrackingPair).eventRecords)));
}
