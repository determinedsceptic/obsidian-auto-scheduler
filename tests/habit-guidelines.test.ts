import { describe, expect, it } from 'vitest';
import { appendGuidelines, readGuidelines, habitContext, validateGuidelines, validateGuidelinePlan } from '../src/habit-guidelines';
import { readDailyPlan, previewDailyEdits } from '../src/daily-edit';
import { chat, materializeTasks } from '../src/llm';
import { applyPreview, createPreview, undoLast } from '../src/transaction';
import { DEFAULT_LLM } from '../src/types';
import type { Task, Tracking, UndoRecord } from '../src/types';
import { config, MemoryVault, now } from './helpers';
class Vault extends MemoryVault {
  aiTasks: Task[]=[];
  getAiTasks(){return this.aiTasks;}
  override async saveUndo(record:UndoRecord|null,tracking?:Tracking,tasks?:Task[]){await super.saveUndo(record,tracking);if(tasks)this.aiTasks=structuredClone(tasks);}
}
const settings=config({outputLocation:'daily',cleanDaily:true,outputMode:'day-planner'});
const path='DailyNotes/2026-10-01.md';
const rules=['规律吃三餐；午饭和晚饭后休息 10–20 分钟，再快走 30 分钟；每周一、三、五在晚饭快走后做力量训练。','正餐外默认不吃零食、不喝含糖或有热量的饮料；白水和无糖茶不限。','训练前后若明显饥饿，可以计划内补充牛奶、无糖酸奶、鸡蛋或少量坚果，不必硬饿。'];
describe('deadline visibility and stable carry-over',()=>{
  it('retains a deadline-only handwritten task in provider reads, clean Markdown and repeat edits/undo',async()=>{
    const v=new Vault();v.files={[path]:'# Day planner\n- [ ] Short task 📅 2026-10-05\n'};
    const read=await readDailyPlan(v,settings,{},[],'2026-10-01',now);
    expect(read.read.items[0].deadline).toBe('2026-10-05');expect(read.read.items[0].defaulted).toBe(true);
    const edit=[{ref:'row_2',targetDate:'2026-10-02',title:null,minutes:null,priority:null}];
    const {preview}=await previewDailyEdits(v,settings,{},[],read,edit,now,'first');await applyPreview(v,v,preview,settings,now);
    const target='DailyNotes/2026-10-02.md';expect(v.files[target]).toContain('Short task 📅 2026-10-05');expect(v.files[target]).not.toMatch(/auto-scheduler:|as-block|scheduled::/);
    const next=await readDailyPlan(v,settings,v.tracking,v.aiTasks,'2026-10-02',now);expect(next.read.items[0].deadline).toBe('2026-10-05');
    const original=v.files[target];const {preview:again}=await previewDailyEdits(v,settings,v.tracking,v.aiTasks,next,[{...edit[0],ref:next.read.items[0].ref,targetDate:'2026-10-03'}],now,'second');
    await applyPreview(v,v,again,settings,now);await undoLast(v,v,v.undo);expect(v.files[target]).toBe(original);
    expect((await readDailyPlan(v,settings,v.tracking,v.aiTasks,'2026-10-02',now)).read.items[0].deadline).toBe('2026-10-05');
  });
  it('displays an explicit deadline time without showing the scheduled block end as the deadline',async()=>{
    const v=new Vault();v.files={};const tasks=materializeTasks([{title:'Timed deadline',minutes:30,priority:3,split:true,minMinutes:30,due:'2026-10-05T16:30',earliest:null}],settings,now,'time');
    const p=await createPreview(v,{...settings,outputMode:'gantt'},now,{},false,[],tasks);await applyPreview(v,v,p,{...settings,outputMode:'gantt'},now);
    expect(v.files[path]).toContain('📅 2026-10-05 16:30');expect(v.files[path]).not.toContain('[due::');
  });
});
describe('natural-language habit guidelines',()=>{
  it('reads the recognized habit section and keeps unrelated journal prose local',async()=>{
    const v=new Vault();v.files={[path]:`# 习惯与计划\n> **${rules[0]}**\n- ${rules[1]}\n- ${rules[2]}\n# Day planner\n- [ ] Review\n# Journal\nPrivate journal\n`};
    const r=await readDailyPlan(v,settings,{},[],'2026-10-01',now);expect(r.read.habitContext).toContain(rules[0]);expect(JSON.stringify(r.read)).not.toContain('Private journal');expect(r.read.items).toHaveLength(1);
    expect(habitContext('```md\n# 习惯与计划\n> hidden\n```')).toBe('');
  });
  it('stores/de-duplicates action items once without copying them into daily notes or inventing time blocks',async()=>{
    const v=new Vault();v.files={};const template=appendGuidelines(null,rules);expect(readGuidelines(template)).toEqual(rules);expect(appendGuidelines(template,rules)).toBe(template);
    const p=await createPreview(v,settings,now,{},false,[],[],{'Habits/Habits.md':template});expect(p.result.errors).toEqual([]);expect(p.result.blocks).toEqual([]);
    await applyPreview(v,v,p,settings,now);expect(Object.keys(v.files).filter(p=>p.startsWith('DailyNotes/'))).toHaveLength(0);
    for(const [p,text] of Object.entries(v.files).filter(([p])=>p.startsWith('DailyNotes/'))) {expect(text).not.toContain(rules[0]);expect(text).not.toMatch(/as-block|auto-scheduler:/);}
    await undoLast(v,v,v.undo);expect(v.files['Habits/Habits.md']).toBe('');
  });
  it('preserves an existing habit section and applies source revision plus guideline saving in one undo',async()=>{
    const v=new Vault();const original=`# Habits and guidelines\n> Existing original\n# Day planner\n- [ ] Review 📅 2026-10-05\n`;
    v.files={[path]:original};const r=await readDailyPlan(v,settings,{},[],'2026-10-01',now);
    const tagged=[`ACTION: ${rules[0]}`,...rules.slice(1).map(x=>`RULE: ${x}`)];
    const {preview}=await previewDailyEdits(v,settings,{},[],r,[{ref:r.read.items[0].ref,targetDate:'2026-10-02',title:null,minutes:null,priority:null}],now,'combo',tagged);
    expect(preview.result.errors).toEqual([]);await applyPreview(v,v,preview,settings,now);
    expect(v.files[path]).toContain('> Existing original');expect(v.files['DailyNotes/2026-10-02.md']).not.toContain(rules[0]);expect(v.files['Habits/Habits.md']).toContain(`- ${rules[0]}`);
    await undoLast(v,v,v.undo);expect(v.files[path]).toBe(original);expect(v.aiTasks).toEqual([]);expect(v.files['Habits/Habits.md']).toBe('');
  });
  it('refuses hidden rules, injected multiline headings and oversized input',()=>{
    expect(()=>appendGuidelines('```md\nunclosed\n',rules)).toThrow('hide');
    for(const r of ['rule\n# private','<!-- injected -->','x'.repeat(1001)])expect(()=>validateGuidelines({rules:[r]})).toThrow();
  });
  it.each(['responses','chat-completions','anthropic','gemini'] as const)('dispatches guideline saving via %s',async protocol=>{
    const args={actions:[rules[0]],conditions:rules.slice(1)};const json=protocol==='responses'?{status:'completed',output:[{type:'function_call',name:'save_habit_guidelines',arguments:JSON.stringify(args)}]}:protocol==='anthropic'?{stop_reason:'tool_use',content:[{type:'tool_use',name:'save_habit_guidelines',input:args}]}:protocol==='gemini'?{candidates:[{finishReason:'STOP',content:{parts:[{functionCall:{name:'save_habit_guidelines',args}}]}}]}:{choices:[{finish_reason:'tool_calls',message:{tool_calls:[{type:'function',function:{name:'save_habit_guidelines',arguments:JSON.stringify(args)}}]}}]};
    const reply=await chat({...DEFAULT_LLM,protocol},'fixture',[{role:'user',content:rules.join('\n')}],settings,now,async()=>({status:200,json}));
    expect(reply.guidelines).toEqual([`ACTION: ${rules[0]}`,...rules.slice(1).map(r=>`RULE: ${r}`)]);expect(reply.tasks).toEqual([]);expect(reply.habits).toEqual([]);
  });
});
it.each(['responses','chat-completions','anthropic','gemini'] as const)('combines task carry-over and habit inheritance in one %s action',async protocol=>{
  let round=0;
  const response=(name:string,args:unknown)=>protocol==='responses'?{status:'completed',output:[{type:'function_call',name,call_id:'read',arguments:JSON.stringify(args)}]}:protocol==='anthropic'?{stop_reason:'tool_use',content:[{type:'tool_use',id:'read',name,input:args}]}:protocol==='gemini'?{candidates:[{finishReason:'STOP',content:{role:'model',parts:[{functionCall:{name,args}}]}}]}:{choices:[{finish_reason:'tool_calls',message:{role:'assistant',tool_calls:[{id:'read',type:'function',function:{name,arguments:JSON.stringify(args)}}]}}]};
  const reply=await chat({...DEFAULT_LLM,protocol},'fixture',[{role:'user',content:'Inherit the whole plan, including habits'}],settings,now,async()=>({status:200,json:round++===0?response('read_daily_plan',{date:'2026-10-01'}):response('revise_daily_tasks',{date:'2026-10-01',guidelines:[`ACTION: ${rules[0]}`,...rules.slice(1).map(r=>`RULE: ${r}`)],edits:[{ref:'row_2',targetDate:'2026-10-02',title:null,minutes:null,priority:null}]})}),1000,async date=>({date,items:[{ref:'row_2',title:'Short task',completed:false,minutes:30,priority:3,editable:true,kind:'task',defaulted:true,deadline:'2026-10-05'}],habitContext:rules.join('\n')}));
  expect(reply.revision?.edits[0].ref).toBe('row_2');expect(reply.guidelines).toEqual([`ACTION: ${rules[0]}`,...rules.slice(1).map(r=>`RULE: ${r}`)]);expect(reply.tasks).toEqual([]);
});

it('renders grouped bullet lists, migrates legacy quotes, deduplicates and preserves surrounding notes and fenced examples',()=>{
  const tagged=['ACTION: Walk after lunch','RULE: Water only'];
  const before='# AI habits\n- 12:40-13:10 Walk (every day)\n\n## Habit guidelines\n> ACTION: Walk after lunch\n> RULE: Water only\nPersonal explanation\n```md\n> keep example\n```\n## Other\nKeep me\n';
  const result=appendGuidelines(before,tagged);
  expect(result).toContain('### Schedule actions\n- Walk after lunch');
  expect(result).toContain('### Rules / conditions\n- Water only');
  expect(result).not.toContain('> ACTION:');expect(result).not.toContain('> RULE:');
  expect(result).toContain('Personal explanation');expect(result).toContain('```md\n> keep example\n```');
  expect(result).toContain('## Other\nKeep me');expect(result).toContain('- 12:40-13:10 Walk (every day)');
  expect(readGuidelines(result)).toEqual(tagged);expect(appendGuidelines(result,tagged)).toBe(result);
});
it('accepts action-only or condition-only lists',()=>{
  expect(validateGuidelinePlan({actions:['Walk'],conditions:[]})).toEqual(['ACTION: Walk']);
  expect(validateGuidelinePlan({actions:[],conditions:['Water']})).toEqual(['RULE: Water']);
});
