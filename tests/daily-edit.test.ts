import { describe, it, expect } from 'vitest';
import { readDailyPlan, previewDailyEdits } from '../src/daily-edit';
import { chat, materializeTasks } from '../src/llm';
import { DEFAULT_LLM } from '../src/types';
import type { Task, Tracking, UndoRecord, LlmSettings } from '../src/types';
import { applyPreview, createPreview, undoLast } from '../src/transaction';
import { config, MemoryVault, now } from './helpers';
class EditVault extends MemoryVault {
  aiTasks: Task[] = [];
  getAiTasks() { return this.aiTasks; }
  override async saveUndo(record: UndoRecord | null, tracking?: Tracking, tasks?: Task[]) {
    await super.saveUndo(record, tracking); if (tasks) this.aiTasks = structuredClone(tasks);
  }
}
const settings = config({ outputLocation: 'daily', cleanDaily: true, outputMode: 'day-planner', dailyCapacity: 120, periods: ['09:00-11:00'] });
const source = 'DailyNotes/2026-10-01.md';
const edits = (ref: string, patch = {}) => [{ ref, targetDate: '2026-10-02', title: null, minutes: null, priority: null, ...patch }];
async function read(v: EditVault, date = '2026-10-01', time = now) { return readDailyPlan(v, settings, v.tracking, v.aiTasks, date, time); }
async function revise(v: EditVault, changes = edits('row_4'), time = now) {
  const snap = await read(v, '2026-10-01', time);
  return previewDailyEdits(v, settings, v.tracking, v.aiTasks, snap, changes, time, 'test');
}
describe('daily plan reading and revision', () => {
  it('exposes only checkbox rows inside Day planner, ignoring fences and other sections', async () => {
    const v = new EditVault(); v.files = { [source]: '# Private\n- [ ] secret\n# Day planner\n- [ ] Review\n```md\n- [ ] example\n```\n- [x] Done\n# Journal\n- [ ] private diary\n' };
    const r = await read(v); expect(r.read.items.map(i => i.title)).toEqual(['Review', 'Done']);
    expect(JSON.stringify(r.read)).not.toMatch(/secret|example|private diary/);
    expect(v.writes).toBe(0);
  });
  it('moves a start-only task, applies the default, edits priority/title and undoes both notes', async () => {
    const v = new EditVault(); v.files = { [source]: '# Private\nkeep\n# Day planner\n- [ ] 10:00 Phone\n- [x] Done\n# Journal\nretain\n' };
    const before = v.files[source];
    const {preview, defaults} = await revise(v, edits('row_4', { title: 'Phone number', priority: 4 }));
    expect(preview.result.errors).toEqual([]); expect(defaults).toEqual(['Phone']);
    expect(preview.result.blocks).toHaveLength(1); expect(preview.result.blocks[0].date).toBe('2026-10-02');
    await applyPreview(v, v, preview, settings, now);
    expect(v.files[source]).toContain('- [x] Done'); expect(v.files[source]).not.toContain('Phone');
    expect(v.files[source]).toContain('# Private\nkeep'); expect(v.files[source]).toContain('# Journal\nretain');
    expect(v.files['DailyNotes/2026-10-02.md']).toContain('09:00 - 09:30 ⏫ Phone number');
    expect(v.files['DailyNotes/2026-10-02.md']).not.toMatch(/as-block|auto-scheduler:|scheduled::/);
    await undoLast(v, v, v.undo); expect(v.files[source]).toBe(before); expect(v.aiTasks).toEqual([]);
  });
  it('preserves long-term task identity and completed effort, never duplicating remaining work', async () => {
    const v = new EditVault(); v.files = {[source]:'# Day planner\n- [ ] 10:00 - 10:15 Break\n'};
    const added = materializeTasks([{title:'Long project',minutes:240,priority:4,split:true,minMinutes:30,earliest:null,due:null}], settings, now, 'original');
    const initialSettings = {...settings, periods:['09:00-12:00'],dailyCapacity:135};
    const p = await createPreview(v, initialSettings, now, {}, false, [], added); await applyPreview(v,v,p,initialSettings,now);
    // Mark the first half done. Revision must keep it and move only the outstanding half.
    v.files[source] = v.files[source].replace('- [ ] 09:00','- [x] 09:00');
    const before = {...v.files}, id = v.aiTasks[0].id;
    const { preview } = await revise(v, edits(id));
    expect(preview.result.errors).toEqual([]);
    expect(preview.aiTasksAfter.map(t => t.id)).toEqual([id]);
    expect(preview.result.blocks.filter(b => !b.completed).reduce((n,b) => n+b.end-b.start,0)).toBe(180);
    expect(preview.result.blocks.filter(b => b.completed)).toHaveLength(1);
    await applyPreview(v,v,preview,settings,now);
    expect(v.files[source]).toContain('- [x]'); expect(v.files[source]).not.toMatch(/- \[ \].*Long project/);
    await undoLast(v,v,v.undo); expect(v.files[source]).toBe(before[source]);
    // Restored tracking must still recognize the completed checkbox.
    expect((await read(v)).read.items.find(i => i.ref === id)?.minutes).toBe(60);
  });
  it('carries yesterday into tomorrow while retaining yesterday completed history', async () => {
    const v = new EditVault(); v.files = {};
    const added = materializeTasks([{title:'Project',minutes:300,priority:4,split:true,minMinutes:30,earliest:null,due:null}],settings,now,'past');
    const p = await createPreview(v,settings,now,{},false,[],added); await applyPreview(v,v,p,settings,now);
    v.files[source] = v.files[source].replace('- [ ]','- [x]');
    const later = new Date('2026-10-02T08:00:00+08:00');
    const snap = await read(v,'2026-10-02',later);
    const {preview} = await previewDailyEdits(v,settings,v.tracking,v.aiTasks,snap,[{ref:v.aiTasks[0].id,targetDate:'2026-10-03',title:null,minutes:null,priority:null}],later,'next');
    expect(preview.result.errors).toEqual([]);
    expect(preview.result.blocks.filter(b => !b.completed).reduce((n,b) => n+b.end-b.start,0)).toBe(180);
  });
  it('rejects completed, protected, invented references and dates outside the horizon', async () => {
    const v = new EditVault(); v.files = {[source]:'# Day planner\n- [x] Done\n- [ ] Meeting [[source]]\n'};
    for (const e of [edits('row_2'),edits('row_3'),edits('invented'),edits('row_3',{targetDate:'2026-11-01'})]) await expect(revise(v,e)).rejects.toThrow();
    await expect(readDailyPlan(v,settings,{},[],'../../private',now)).rejects.toThrow();
    await expect(read(v,'2026-08-01')).rejects.toThrow(); expect(v.writes).toBe(0);
  });
  it('blocks changes since read and since preview, and persists recovery before any write', async () => {
    const v = new EditVault(); v.files = {[source]:'# Private\nkeep\n# Day planner\n- [ ] Review\n'};
    const snap = await read(v); v.files[source] += 'manual edit';
    await expect(previewDailyEdits(v,settings,{},[],snap,edits('row_4'),now,'test')).rejects.toThrow('changed since reading');
    v.files[source] = snap.original!; const {preview} = await revise(v);
    v.files[source] += 'late edit'; await expect(applyPreview(v,v,preview,settings,now)).rejects.toThrow('changed');
    v.files[source] = snap.original!; v.failBackup = true; await expect(applyPreview(v,v,preview,settings,now)).rejects.toThrow('backup failed'); expect(v.writes).toBe(0);
    v.failBackup = false; v.failWrite = true; await expect(applyPreview(v,v,preview,settings,now)).rejects.toThrow('write failed'); expect(v.undo).not.toBeNull();
    await undoLast(v,v,v.undo); expect(v.aiTasks).toEqual([]);
  });
});
function providerReply(protocol: LlmSettings['protocol'], name: string, args: unknown) {
  if (protocol === 'responses') return {status:'completed',output:[{type:'function_call',call_id:'read1',name,arguments:JSON.stringify(args)}]};
  if (protocol === 'anthropic') return {stop_reason:'tool_use',content:[{type:'tool_use',id:'read1',name,input:args}]};
  if (protocol === 'gemini') return {candidates:[{finishReason:'STOP',content:{role:'model',parts:[{thoughtSignature:'preserved',functionCall:{name,args}}]}}]};
  return {choices:[{finish_reason:'tool_calls',message:{role:'assistant',tool_calls:[{id:'read1',type:'function',function:{name,arguments:JSON.stringify(args)}}]}}]};
}
describe('LLM read/edit tool round trip', () => {
  it.each(['responses','chat-completions','anthropic','gemini'] as const)('reads and revises through %s without arbitrary paths', async protocol => {
    let count=0; const dates:string[]=[];
    const reply = await chat({...DEFAULT_LLM,protocol},'test-only',[{role:'user',content:'Move unfinished work to tomorrow'}],settings,now,async (_,__,body) => {
      const data=JSON.parse(body);
      const tools=protocol==='responses'?data.tools:protocol==='anthropic'?data.tools:protocol==='gemini'?data.tools[0].functionDeclarations:data.tools.map((t:any)=>t.function);
      if(count)expect(tools.map((t:any)=>t.name)).toContain('revise_daily_tasks');
      else expect(tools.map((t:any)=>t.name)).not.toContain('revise_daily_tasks');
      count++;
      if(count===1) return {status:200,json:providerReply(protocol,'read_daily_plan',{date:'2026-10-01'})};
      expect(body).toContain('Review'); expect(body).not.toContain('absolute-private-path');
      if(protocol==='responses') expect(data.input.at(-1).call_id).toBe('read1');
      if(protocol==='chat-completions') expect(data.messages.at(-1).tool_call_id).toBe('read1');
      if(protocol==='anthropic') expect(data.messages.at(-1).content[0].tool_use_id).toBe('read1');
      if(protocol==='gemini') expect(data.contents.at(-2).parts[0].thoughtSignature).toBe('preserved');
      return {status:200,json:providerReply(protocol,'revise_daily_tasks',{date:'2026-10-01',edits:edits('row_2')})};
    },1000,async date => {dates.push(date); return {date,items:[{ref:'row_2',title:'Review',completed:false,minutes:30,priority:3,editable:true,kind:'task',defaulted:true}]};});
    expect(count).toBe(2); expect(dates).toEqual(['2026-10-01']); expect(reply.tasks).toEqual([]); expect(reply.revision?.edits[0].ref).toBe('row_2');
  });
  it('requires a prior read and bounds read loops', async () => {
    await expect(chat(DEFAULT_LLM,'test-only',[{role:'user',content:'move'}],settings,now,async()=>({status:200,json:providerReply('responses','revise_daily_tasks',{date:'2026-10-01',edits:edits('row_2')})}),1000,async date=>({date,items:[]}))).rejects.toThrow('Read the source');
    let count=0;
    await expect(chat(DEFAULT_LLM,'test-only',[{role:'user',content:'read'}],settings,now,async()=>{count++;return{status:200,json:providerReply('responses','read_daily_plan',{date:'2026-10-01'})};},1000,async date=>({date,items:[]}))).rejects.toThrow('maximum three reads'); expect(count).toBe(4);
  });
});
describe('revision constraints and recovery', () => {
  it('keeps habitual occurrences and rejects their edit references', async () => {
    const v = new EditVault(); v.files = {'Habits/Routine.md':'# Habits\n- 19:00 - 19:30 Exercise (Every day)\n', [source]:'# Day planner\n- [ ] Review\n'};
    const p = await createPreview(v,settings,now,{},false,[]); await applyPreview(v,v,p,settings,now);
    const r = await read(v); const habit = r.read.items.find(i=>i.kind==='habit')!; expect(habit.editable).toBe(false);
    await expect(previewDailyEdits(v,settings,v.tracking,[],r,edits(habit.ref),now,'test')).rejects.toThrow('ordinary tasks');
    const ordinary = r.read.items.find(i=>i.title==='Review')!;
    const {preview} = await previewDailyEdits(v,settings,v.tracking,[],r,edits(ordinary.ref),now,'test');
    expect(preview.result.errors).toEqual([]); await applyPreview(v,v,preview,settings,now);
    expect(v.files[source]).toContain('Exercise'); expect(v.files[source]).not.toContain('Review');
    expect(v.files['Habits/Routine.md']).toBe('# Habits\n- 19:00 - 19:30 Exercise (Every day)\n');
  });
  it('refuses to silently discard deadlines when postponing an existing AI task', async () => {
    const v = new EditVault(); v.files = {};
    const added = materializeTasks([{title:'Deadline',minutes:60,priority:4,split:true,minMinutes:30,earliest:null,due:'2026-10-01'}],settings,now,'due');
    const p = await createPreview(v,settings,now,{},false,[],added); await applyPreview(v,v,p,settings,now);
    await expect(revise(v,edits(added[0].id))).rejects.toThrow('deadline');
    expect(v.files[source]).toContain('Deadline');
  });
  it('retains unscheduled long work durably when a later date lacks capacity', async () => {
    const v = new EditVault(); v.files = {[source]:'# Private\nkeep\n# Day planner\n- [ ] Review\n'};
    const {preview} = await revise(v,edits('row_4',{minutes:300,targetDate:'2026-10-07'}));
    expect(preview.result.errors).toEqual([]); expect(preview.result.unscheduled[0].remaining).toBe(180);
    await applyPreview(v,v,preview,settings,now); expect(v.aiTasks[0].remaining).toBe(300);
    expect(v.files['DailyNotes/2026-10-07.md']).toContain('Review'); expect(v.files[source]).not.toContain('Review');
  });
  it('can migrate yesterday handwritten rows and restore exact CRLF bytes', async () => {
    const v = new EditVault(); const past = 'DailyNotes/2026-09-30.md';
    v.files = {[past]:'# Private\r\nkeep\r\n# Day planner\r\n- [ ] 10:00 - 11:00 Review\r\n- [x] Done\r\n# Journal\r\nretain\r\n'};
    const r = await read(v,'2026-09-30');
    const {preview} = await previewDailyEdits(v,settings,{},[],r,edits('row_4'),now,'test');
    expect(preview.result.errors).toEqual([]); const before=v.files[past];
    await applyPreview(v,v,preview,settings,now); expect(v.files[past]).not.toContain('Review'); expect(v.files[past]).toContain('# Journal\r\nretain');
    await undoLast(v,v,v.undo); expect(v.files[past]).toBe(before);
  });
});
describe('handwritten calendar compatibility during carry-over', () => {
  it.each(['⏫ ➕ 2026-10-01 📅 2026-10-05','[priority:: high] [due:: 2026-10-05]'])('preserves %s constraints and default duration', async metadata => {
    const v = new EditVault(); v.files = {[source]:`# Private\nkeep\n# Day planner\n- [ ] Review ${metadata}\n`};
    const {preview} = await revise(v);
    expect(preview.result.errors).toEqual([]); expect(preview.aiTasksAfter[0].priority).toBe(4);
    expect(preview.aiTasksAfter[0].due).toBeDefined(); expect(preview.aiTasksAfter[0].title).toBe('Review');
    await applyPreview(v,v,preview,settings,now); expect(v.files[source]).not.toContain('Review');
    expect(v.files['DailyNotes/2026-10-02.md']).toContain('Review');
  });
  it('rejects carry-over beyond a handwritten deadline', async () => {
    const v = new EditVault(); v.files = {[source]:'# Private\nkeep\n# Day planner\n- [ ] Review 📅 2026-10-01\n'};
    await expect(revise(v)).rejects.toThrow('deadline'); expect(v.writes).toBe(0);
  });
});

it('turns a legacy half-hour book row into a paced whole-book plan starting in today’s remaining gap',async()=>{
  const v=new EditVault();v.files={[source]:'# Day planner\n- [ ] 10:30 - 11:00 🔼 《AI Infra》\n'};
  const time=new Date('2026-10-01T11:20:00+08:00');
  const s=config({outputLocation:'daily',outputMode:'day-planner',cleanDaily:true,periods:['09:00-12:00','14:00-18:00'],dailyCapacity:360});
  const snap=await readDailyPlan(v,s,{},[], '2026-10-01',time);
  expect(snap.read.availability?.remainingPeriods).toEqual(['11:20-12:00','14:00-18:00']);
  const {preview}=await previewDailyEdits(v,s,{},[],snap,[{ref:'row_2',targetDate:'2026-10-01',title:null,minutes:600,priority:null,estimateBasis:'暂按300页、每小时30页：10小时',dailyMinutes:60}],time,'book');
  expect(preview.result.errors).toEqual([]);
  const blocks=preview.result.blocks;expect(blocks[0].date).toBe('2026-10-01');
  expect(blocks[0].start).toBeGreaterThanOrEqual(time.getTime()/60000);
  for(const date of new Set(blocks.map(b=>b.date)))expect(blocks.filter(b=>b.date===date).reduce((n,b)=>n+b.end-b.start,0)).toBeLessThanOrEqual(60);
  expect(new Set(blocks.map(b=>b.date)).size).toBe(7);
  expect(preview.result.unscheduled[0].remaining).toBe(180);
  await applyPreview(v,v,preview,s,time);
  expect(v.aiTasks[0].remaining).toBe(600);expect(v.aiTasks[0].dailyMinutes).toBe(60);
  const reread=await readDailyPlan(v,s,v.tracking,v.aiTasks,'2026-10-02',time);
  expect(reread.read.items[0].totalMinutes).toBe(600);expect(reread.read.items[0].minutes).toBe(60);
  expect(reread.read.items[0].remainingMinutes).toBe(600);
});

it('revises an existing project estimate without losing its ID, deadline or completed sessions',async()=>{
  const v=new EditVault();v.files={};
  const draft={title:'Read book',minutes:240,priority:3,split:true,minMinutes:30,earliest:null,due:'2026-10-07'};
  const added=materializeTasks([draft],settings,now,'bookexisting');
  const initial=await createPreview(v,settings,now,{},false,[],added);await applyPreview(v,v,initial,settings,now);
  v.files[source]=v.files[source].replace('- [ ] 09:00','- [x] 09:00');
  const snapshot=await readDailyPlan(v,settings,v.tracking,v.aiTasks,'2026-10-02',now);
  const {preview}=await previewDailyEdits(v,settings,v.tracking,v.aiTasks,snapshot,[{ref:added[0].id,targetDate:'2026-10-01',title:null,minutes:600,priority:null,estimateBasis:'10-hour provisional total',dailyMinutes:60}],now,'expanded');
  expect(preview.result.errors).toEqual([]);expect(preview.aiTasksAfter[0].id).toBe(added[0].id);
  expect(preview.aiTasksAfter[0].due).toBe(added[0].due);expect(preview.result.blocks.some(b=>b.completed)).toBe(true);
  expect(preview.aiTasksAfter[0].remaining).toBe(600);
});
