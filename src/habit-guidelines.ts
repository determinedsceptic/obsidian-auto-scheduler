import { visibleLines } from './parser';
import { habitPath } from './habit-tool';
import type { Settings } from './types';
const heading = /^#{1,6}\s+(?:Habits and guidelines|Habit guidelines|Habits and plans|\u4e60\u60ef\u4e0e\u8ba1\u5212)\s*#*\s*$/i;
export const guidelineTool = { name:'save_habit_guidelines', description:'Save an analyzed habit plan to the configured template. Split every executable routine step into actions, and every dietary/conditional rule into conditions. Never copy a source paragraph verbatim. Preserve relative anchors, durations, ranges, recurrence and conditions. These entries stay in the template and are never copied into daily schedules. If clock times are missing, list actions in the assistant answer and ask for meal/anchor times; do not claim they are scheduled. Can accompany task carry-over.', strict:true,
  parameters:{type:'object',properties:{actions:{type:'array',items:{type:'string',description:'One concise actionable activity or sequence, with recurrence and relative anchor preserved'}},conditions:{type:'array',items:{type:'string',description:'One dietary limit or conditional rule, not a time block'}}},required:['actions','conditions'],additionalProperties:false} };
export function validateGuidelinePlan(value: unknown): string[] {
  const args=value as {actions:string[]; conditions:string[]};
  if(!args || typeof args!=='object' || Array.isArray(args) || Object.keys(args).sort().join(',')!=='actions,conditions' || !Array.isArray(args.actions) || !Array.isArray(args.conditions) || args.actions.length+args.conditions.length<1 || args.actions.length+args.conditions.length>20) throw new Error('Save 1–20 habit actions or conditions');
  const actions=validateGuidelines({rules:args.actions}); const conditions=validateGuidelines({rules:args.conditions});
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
  return habitContext(text).split(/\r?\n/).filter(l=>/^> /.test(l)).map(l=>l.slice(2).trim()).filter(Boolean);
}
export function appendGuidelines(before: string | null, rules: string[]): string {
  const checked=validateGuidelines({rules}), text=before??'# AI habits\n', existing=readGuidelines(text);
  const additions=checked.filter(r=>!existing.includes(r)); if(!additions.length) return text;
  const newline=text.includes('\r\n')?'\r\n':'\n';
  // Append within a dedicated section. Reject an existing differently shaped section.
  const rows=visibleLines(text), h=rows.find(r=>heading.test(r.text));
  if(h) {
    const lines=text.split(/\r?\n/), level=/^#+/.exec(h.text)![0].length;
    const next=rows.find(r=>r.line>h.line && new RegExp(`^#{1,${level}}\\s+`).test(r.text));
    lines.splice(next?next.line-1:lines.length,0,...additions.map(r=>`> ${r}`));
    const result=lines.join(newline); if(!additions.every(r=>readGuidelines(result).includes(r))) throw new Error('A code fence would hide new guidelines');return result;
  }
  const result=text+(text.endsWith('\n')?newline:newline+newline)+`## Habit guidelines${newline}`+additions.map(r=>`> ${r}`).join(newline)+newline;
  if(!additions.every(r=>readGuidelines(result).includes(r))) throw new Error('A code fence would hide new guidelines');return result;
}
export const guidelinePath = (settings: Settings): string => habitPath(settings);
