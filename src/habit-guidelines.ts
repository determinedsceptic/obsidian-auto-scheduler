import { visibleLines } from './parser';
import { habitPath } from './habit-tool';
import type { Settings } from './types';
const heading = /^#{1,6}\s+(?:Habits and guidelines|Habit guidelines|Habits and plans|\u4e60\u60ef\u4e0e\u8ba1\u5212)\s*#*\s*$/i;
export const guidelineTool = { name:'save_habit_guidelines', description:'Save an analyzed habit plan to the configured template. Split every executable routine step into actions, and every dietary/conditional rule into conditions. Never copy a source paragraph verbatim. Preserve relative anchors, durations, ranges, recurrence and conditions. These entries stay in the template and are never copied into daily schedules. If clock times are missing, list actions in the assistant answer and ask for meal/anchor times; do not claim they are scheduled. Can accompany task carry-over.', strict:true,
  parameters:{type:'object',properties:{actions:{type:'array',items:{type:'string',description:'One concise actionable activity or sequence, with recurrence and relative anchor preserved'}},conditions:{type:'array',items:{type:'string',description:'One dietary limit or conditional rule, not a time block'}}},required:['actions','conditions'],additionalProperties:false} };
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
  const checked=validateGuidelines({rules}), text=before??'# AI habits\n';
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
