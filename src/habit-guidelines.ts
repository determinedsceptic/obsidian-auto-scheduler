import type { GuidelineDocument } from './habit-files';
import { visibleLines } from './parser';
import { habitPath, validateHabitDrafts } from './habit-tool';
import type { Settings } from './types';
const heading = /^#{1,6}\s+(?:Habits and guidelines|Habit guidelines|Habits and plans|\u4e60\u60ef\u4e0e\u8ba1\u5212)\s*#*\s*$/i;
export const guidelineTool = { name:'save_habit_guidelines', description:'Save an analyzed habit plan, including confirmed fixed clock times, to the configured template. Split every executable routine step into actions, and every dietary/conditional rule into conditions. Never copy a source paragraph verbatim. Preserve relative anchors, durations, ranges, recurrence and conditions. These entries stay in the template and are never copied into daily schedules. If clock times are missing, list actions in the assistant answer and ask for meal/anchor times; do not claim they are scheduled. Can accompany task carry-over.', strict:true,
  parameters:{type:'object',properties:{habits:{type:'array',items:{type:'object',properties:{title:{type:'string',description:'Specific short habit/file title in the user language, e.g. Lunch walk, Dinner walk, Strength training. Separate unrelated habits into separate items; never Habits or Guidelines.'},actions:{type:'array',items:{type:'string'}},conditions:{type:'array',items:{type:'string'}},schedule:{description:'Executable habits must have confirmed fixed clock times persisted here. Null only for non-time rules or missing anchors; never omit known times. End null applies the configured default duration.',anyOf:[{type:'object',properties:{start:{type:'string'},end:{type:['string','null']},days:{type:'array',items:{type:'integer',enum:[0,1,2,3,4,5,6]}},priority:{type:'integer',enum:[1,2,3,4,5]}},required:['start','end','days','priority'],additionalProperties:false},{type:'null'}]}},required:['title','actions','conditions','schedule'],additionalProperties:false}}},required:['habits'],additionalProperties:false} };
export function validateGuidelineDocuments(value:unknown, defaultDuration=30):GuidelineDocument[]{
  const args=value as {habits?:{title:string;actions:string[];conditions:string[];schedule?:{start:string;end:string|null;days:number[];priority:number}|null}[]};
  if(!args||typeof args!=='object'||Array.isArray(args))throw Error('Invalid habit documents');
  // Read older provider/tool fixtures during upgrade; new schemas always supply specific titles.
  if(!('habits' in args))return validateGuidelinePlan(value).map(rule=>({title:rule.replace(/^(ACTION|RULE): /,'').split(/[。；;]/)[0].trim(),rules:[rule]}));
  if(Object.keys(args).join(',')!=='habits'||!Array.isArray(args.habits)||!args.habits.length||args.habits.length>20)throw Error('Save 1–20 named habit documents');
  return args.habits.map(h=>{
    if(!h||typeof h!=='object'||Array.isArray(h)||!['actions,conditions,title','actions,conditions,schedule,title'].includes(Object.keys(h).sort().join(','))||typeof h.title!=='string'||!h.title.trim()||h.title.length>200||/[\r\n\x00-\x1f<>]/.test(h.title))throw Error('Use a specific single-line habit title');
    const schedule=h.schedule===undefined?undefined:h.schedule===null?null:validateHabitDrafts({habits:[{title:h.title.trim(),...h.schedule}]},defaultDuration)[0];
    return {title:h.title.trim(),rules:validateGuidelinePlan({actions:h.actions,conditions:h.conditions}),...(schedule===undefined?{}:{schedule}),...(h.schedule?.end===null?{defaulted:true}:{})};
  });
}
export function validateGuidelinePlan(value: unknown): string[] {
  const args=value as {actions:string[]; conditions:string[]};
  if(!args || typeof args!=='object' || Array.isArray(args) || Object.keys(args).sort().join(',')!=='actions,conditions' || !Array.isArray(args.actions) || !Array.isArray(args.conditions) || args.actions.length+args.conditions.length<1 || args.actions.length+args.conditions.length>20) throw new Error('Save 1–20 habit actions or conditions');
  const actions=args.actions.length ? validateGuidelines({rules:args.actions}) : []; const conditions=args.conditions.length ? validateGuidelines({rules:args.conditions}) : [];
  return [...actions.map(item=>`ACTION: ${item}`),...conditions.map(item=>`RULE: ${item}`)];
}
export function validateGuidelines(value: unknown): string[] {
  const args=value as {rules:string[]};
  if(!args || typeof args!=='object' || Array.isArray(args) || Object.keys(args).join(',')!=='rules' || !Array.isArray(args.rules) || !args.rules.length || args.rules.length>20) throw new Error('Save 1–20 habit guidelines');
  return [...new Set(args.rules.map(r=>{if(typeof r!=='string' || !r.trim() || r.length>1000 || /[\r\n\x00-\x1f<>`]|<!--|%%/.test(r)) throw new Error('Habit items must be single-line plain text');return r.trim();}))];
}
/** Read only the named habits section, never the surrounding journal. */
export function habitContext(text: string): string {
  const rows=visibleLines(text), headings=rows.filter(r=>heading.test(r.text));
  if(headings.length>1) throw new Error('Duplicate habit guideline headings');
  if(!headings.length) return '';
  const h=headings[0], level=/^#+/.exec(h.text)![0].length;
  const next=rows.find(r=>r.line>h.line && new RegExp(`^#{1,${level}}\\s+`).test(r.text));
  const result=rows.filter(r=>r.line>h.line && (!next || r.line<next.line)).map(r=>r.text).join('\n').trim();
  if(result.length>6000) throw new Error('Habit guidelines section is too large');
  return result;
}
export function readGuidelines(text: string): string[] {
  let category = '';
  return habitContext(text).split(/\r?\n/).flatMap(line => {
    if (/^#{1,6}\s+Schedule actions\s*$/i.test(line)) { category='ACTION: '; return []; }
    if (/^#{1,6}\s+Rules \/ conditions\s*$/i.test(line)) { category='RULE: '; return []; }
    if (/^#{1,6}\s/.test(line)) { category=''; return []; }
    const item=/^(?:> |[-*] )(.*)$/.exec(line)?.[1].trim();
    if (!item) return [];
    return [/^(ACTION|RULE): /.test(item) ? item : category+item];
  });
}
export function appendGuidelines(before: string | null, rules: string[]): string {
  const checked=validateGuidelines({rules}), text=before??'# Habits\n';
  const items=[...new Set([...readGuidelines(text),...checked])];
  const newline=text.includes('\r\n')?'\r\n':'\n';
  const rows=visibleLines(text), h=rows.find(r=>heading.test(r.text));
  const level=h ? /^#+/.exec(h.text)![0].length : 2;
  const subheading='#'.repeat(Math.min(level+1,6));
  const actions=items.filter(r=>r.startsWith('ACTION: ')).map(r=>r.slice(8));
  const conditions=items.filter(r=>r.startsWith('RULE: ')).map(r=>r.slice(6));
  const other=items.filter(r=>!r.startsWith('ACTION: ')&&!r.startsWith('RULE: '));
  const list=[...other.map(r=>`- ${r}`),
    ...(actions.length ? [`${subheading} Schedule actions`,...actions.map(r=>`- ${r}`)] : []),
    ...(conditions.length ? [`${subheading} Rules / conditions`,...conditions.map(r=>`- ${r}`)] : [])];
  let result:string;
  if(h) {
    if(level===6 && (actions.length||conditions.length)) throw new Error('Habit guidelines heading must allow subheadings (levels 1–5)');
    const lines=text.split(/\r?\n/);
    const next=rows.find(r=>r.line>h.line && new RegExp(`^#{1,${level}}\\s+`).test(r.text));
    const end=next ? next.line-1 : lines.length;
    // Preserve unrelated prose and fenced examples while converting only recognized list/quote rows.
    const managed=new Set(rows.filter(r=>r.line>h.line && r.line<=end && (/^(?:> |[-*] )/.test(r.text)||/^#{1,6}\s+(?:Schedule actions|Rules \/ conditions)\s*$/i.test(r.text))).map(r=>r.line-1));
    const retained=lines.slice(h.line,end).filter((_,i)=>!managed.has(h.line+i));
    while(retained.length && !retained[retained.length-1].trim()) retained.pop();
    lines.splice(h.line,end-h.line,...retained,...list,'');
    result=lines.join(newline);
  } else {
    result=text+(text.endsWith('\n')?newline:newline+newline)+`## Habit guidelines${newline}`+list.join(newline)+newline;
  }
  if(!items.every(r=>readGuidelines(result).includes(r))) throw new Error('A code fence would hide new guidelines');
  return result;
}
export const guidelinePath = (settings: Settings): string => habitPath(settings);
