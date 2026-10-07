import {describe,it,expect} from 'vitest';
import {organizeDailyTasks,dayPlannerSection} from '../src/daily';
import {readDailyPlan,previewDailyEdits} from '../src/daily-edit';
import {materializeTasks,validAiTasks} from '../src/llm';
import {createPreview,applyPreview,undoLast} from '../src/transaction';
import type {Task,Tracking,UndoRecord} from '../src/types';
import {planningDetails} from '../src/ai-result';
import {MemoryVault,config,now} from './helpers';
class StudyVault extends MemoryVault {
 aiTasks:Task[]=[];
 getAiTasks(){return this.aiTasks;}
 override async saveUndo(record:UndoRecord|null,tracking?:Tracking,tasks?:Task[]){await super.saveUndo(record,tracking);if(tasks)this.aiTasks=structuredClone(tasks);}
}
const settings=config({outputLocation:'daily',outputMode:'day-planner',cleanDaily:true,balanceLoad:true});
const source='DailyNotes/2026-10-01.md';
const draft={title:'学习《AI Infra》',minutes:180,priority:3,split:true,minMinutes:30,due:null,earliest:null,dailyMinutes:60,rollingMinutes:180,estimateBasis:'先安排三个60分钟学习时段，一周后根据章节进展调整；总耗时未知'};
describe('task layout and rolling learning goals',()=>{
 it('moves untimed standalone tasks into Tasks, preserving deadlines, completion, timed work and private text',()=>{
  const before='# Day planner\n- [ ] ⏫ 申请书 📅 2026-10-20\n- [x] 🔼 长期项目 ✅ 2026-10-01\n- [ ] 10:00 - 11:00 学习\n```md\n- [ ] example\n```\n# Journal\nprivate\n';
  const after=organizeDailyTasks(before),part=dayPlannerSection(after)!;
  expect(after.startsWith('# Tasks\n')).toBe(true);expect(after).toContain('- [ ] ⏫ 申请书 📅 2026-10-20');
  expect(after.slice(part.start,part.end)).not.toContain('申请书');expect(after.slice(part.start,part.end)).toContain('10:00 - 11:00');
  expect(after).toContain('```md\n- [ ] example\n```');expect(after).toContain('# Journal\nprivate\n');
  expect(organizeDailyTasks(after)).toBe(after);
 });
 it('reads Tasks as well as Day planner while keeping journal checkboxes private',async()=>{
  const v=new StudyVault();v.files={[source]:'# Tasks\n- [ ] ⏫ 申请书 📅 2026-10-20\n# Day planner\n- [ ] 10:00 - 11:00 学习\n# Journal\n- [ ] secret\n'};
  const read=await readDailyPlan(v,settings,{},[], '2026-10-01',now);
  expect(read.read.items.map(i=>i.title)).toEqual(['申请书','学习']);expect(read.read.items[0].deadline).toBe('2026-10-20');expect(JSON.stringify(read.read)).not.toContain('secret');
 });
 it('formats untimed notes even without generated blocks and restores exact original on undo',async()=>{
  const v=new StudyVault();const before='# Day planner\n- [ ] 🔼 Long project\n# Journal\nkeep\n';v.files={[source]:before};
  const p=await createPreview(v,settings,now,{},true);expect(p.result.errors).toEqual([]);
  await applyPreview(v,v,p,settings,now);expect(v.files[source]).toContain('# Tasks\n');
  await undoLast(v,v,v.undo);expect(v.files[source]).toBe(before);
 });
 it('preserves the goal after all study sessions complete, replenishes next week, persists identity and undoes',async()=>{
  const v=new StudyVault();v.files={};const tasks=materializeTasks([draft],settings,now,'rolling');
  const p=await createPreview(v,settings,now,{},false,[],tasks);expect(p.result.errors).toEqual([]);
  expect(new Set(p.result.blocks.map(b=>b.date)).size).toBe(3);
  expect(planningDetails(p,new Set([tasks[0].id]),now).join(' ')).toContain('Total effort and finish date remain unknown');
  await applyPreview(v,v,p,settings,now);
  expect(v.files[source]).toContain('# Tasks\n\n- [ ] 🔼 学习《AI Infra》');
  for(const path of Object.keys(v.files))v.files[path]=v.files[path].replace(/^- \[ \] (\d{2}:\d{2} - \d{2}:\d{2})/gm,'- [x] $1');
  const read=await readDailyPlan(v,settings,v.tracking,v.aiTasks,'2026-10-01',now);
  const item=read.read.items.find(i=>i.ref===tasks[0].id)!;
  expect(item.completed).toBe(false);expect(item.editable).toBe(true);expect(item.rollingMinutes).toBe(180);expect(item.totalMinutes).toBeUndefined();
  const before=structuredClone(v.files), nextWeek=new Date('2026-10-08T08:00:00+08:00');
  const restart=structuredClone(v.aiTasks);expect(validAiTasks(restart)).toBe(true);
  const next=await createPreview(v,settings,nextWeek,v.tracking,false,restart);expect(next.result.errors).toEqual([]);
  expect(next.result.blocks.filter(b=>!b.completed).reduce((n,b)=>n+b.end-b.start,0)).toBe(180);
  expect(next.aiTasksAfter.map(t=>t.id)).toEqual([tasks[0].id]);
  await applyPreview(v,v,next,settings,nextWeek);expect(v.files[source]).toContain('- [ ] 🔼 学习《AI Infra》');
  await undoLast(v,v,v.undo);for(const [path,text] of Object.entries(before))expect(v.files[path]).toBe(text);
 });
 it('indexes an old open goal from today without leaking its journal and rejects stale goal edits',async()=>{
  const v=new StudyVault();v.files={};const tasks=materializeTasks([draft],settings,now,'old-goal');
  const first=await createPreview(v,settings,now,{},false,[],tasks);await applyPreview(v,v,first,settings,now);
  v.files[source]+='\n# Journal\nprivate-old-journal\n';
  const future=new Date('2026-11-11T08:00:00+08:00');
  const read=await readDailyPlan(v,settings,v.tracking,v.aiTasks,'2026-11-11',future);
  expect(read.read.items.find(i=>i.ref===tasks[0].id)?.goalDate).toBe('2026-10-01');
  expect(JSON.stringify(read.read)).not.toContain('private-old-journal');
  v.files[source]=v.files[source].replace('- [ ] 🔼 学习《AI Infra》','- [x] 🔼 学习《AI Infra》');
  await expect(previewDailyEdits(v,settings,v.tracking,v.aiTasks,read,[{ref:tasks[0].id,targetDate:'2026-11-11',title:null,minutes:null,priority:null}],future,'stale')).rejects.toThrow('Study goal changed');
 });
 it('only checking the master goal stops future sessions, while duplicate goals fail safely',async()=>{
  const v=new StudyVault();v.files={};const tasks=materializeTasks([draft],settings,now,'goal');
  const first=await createPreview(v,settings,now,{},false,[],tasks);await applyPreview(v,v,first,settings,now);
  v.files[source]=v.files[source].replace('- [ ] 🔼 学习《AI Infra》','- [x] 🔼 学习《AI Infra》');
  const next=await createPreview(v,settings,now,v.tracking,false,v.aiTasks);expect(next.result.errors).toEqual([]);expect(next.result.blocks.filter(b=>!b.completed)).toHaveLength(0);
  v.files[source]=v.files[source].replace('# Tasks\n','# Tasks\n- [ ] 🔼 学习《AI Infra》\n');
  await expect(createPreview(v,settings,now,v.tracking,false,v.aiTasks)).rejects.toThrow('Duplicate study goal');
 });
});

describe('ordinary task master rows',()=>{
 it('writes ordinary tasks in Tasks, reads one identity, revises the master and restores both on undo',async()=>{
  const v=new StudyVault();const original='---\ntags: [daily]\n---\n# Journal\n- [ ] Report\n';v.files={[source]:original};
  const tasks=materializeTasks([{...draft,title:'Report',rollingMinutes:null,dailyMinutes:null,estimateBasis:null,minutes:120}],settings,now,'ordinary');
  const p=await createPreview(v,settings,now,{},false,[],tasks);await applyPreview(v,v,p,settings,now);
  expect(v.files[source].startsWith('---\ntags: [daily]\n---\n# Tasks')).toBe(true);
  expect(v.files[source]).toContain('- [ ] 🔼 Report');
  const before=structuredClone(v.files),read=await readDailyPlan(v,settings,v.tracking,v.aiTasks,'2026-10-01',now);
  expect(read.read.items.filter(i=>i.ref===tasks[0].id)).toHaveLength(1);expect(read.read.items).toHaveLength(1);
  expect(read.read.items[0].totalMinutes).toBe(120);expect(read.read.items[0].defaulted).toBe(false);
  const {preview}=await previewDailyEdits(v,settings,v.tracking,v.aiTasks,read,[{ref:tasks[0].id,title:'Final report',minutes:null,priority:4,targetDate:'2026-10-02'}],now,'revise');
  expect(preview.result.errors).toEqual([]);await applyPreview(v,v,preview,settings,now);
  expect(v.files[source]).toContain('- [ ] ⏫ Final report');expect(v.files[source]).toContain('# Journal\n- [ ] Report');
  expect(v.aiTasks.map(t=>t.id)).toEqual([tasks[0].id]);
  await undoLast(v,v,v.undo);for(const [path,text] of Object.entries(before))expect(v.files[path]).toBe(text);
 });
 it('checking an ordinary master stops sessions and retains the old source in today’s index',async()=>{
  const v=new StudyVault();v.files={};const tasks=materializeTasks([{...draft,title:'Report',rollingMinutes:null,minutes:120}],settings,now,'master');
  const p=await createPreview(v,settings,now,{},false,[],tasks);await applyPreview(v,v,p,settings,now);
  v.files[source]=v.files[source].replace('- [ ] 🔼 Report','- [x] 🔼 Report');
  const next=await createPreview(v,settings,now,v.tracking,false,v.aiTasks);expect(next.result.errors).toEqual([]);expect(next.result.blocks.filter(b=>!b.completed)).toEqual([]);
  const future=new Date('2026-10-08T08:00:00+08:00'),read=await readDailyPlan(v,settings,v.tracking,v.aiTasks,'2026-10-08',future);
  expect(read.read.items.find(i=>i.ref===tasks[0].id)).toMatchObject({completed:true,editable:false,goalDate:'2026-10-01'});
 });
 it('migrates legacy ordinary tasks without a master row exactly once and keeps history out of the current week',async()=>{
  const v=new StudyVault();v.files={};const tasks=materializeTasks([{...draft,title:'Legacy',rollingMinutes:null,minutes:120}],settings,now,'legacy');
  const p=await createPreview(v,settings,now,{},false,[],tasks);await applyPreview(v,v,p,settings,now);
  v.files[source]=v.files[source].replace('# Tasks\n\n- [ ] 🔼 Legacy\n\n','');
  const before=v.files[source],next=await createPreview(v,settings,now,v.tracking,false,v.aiTasks);expect(next.result.errors).toEqual([]);await applyPreview(v,v,next,settings,now);
  expect(v.files[source].match(/^- \[ \] 🔼 Legacy$/gm)).toHaveLength(1);
  const repeat=await createPreview(v,settings,now,v.tracking,false,v.aiTasks);expect(repeat.outputs![source]).toBe(v.files[source]);
  await undoLast(v,v,v.undo);expect(v.files[source]).toBe(before);
 });
 it('rejects duplicate identities and does not overwrite a handwritten task with the same title',async()=>{
  const v=new StudyVault();v.files={[source]:'# Tasks\n- [ ] 🔼 Report 📅 2026-10-20\n# Day planner\n'};
  const tasks=materializeTasks([{...draft,title:'Report',rollingMinutes:null}],settings,now,'duplicate');
  const p=await createPreview(v,settings,now,{},false,[],tasks);expect(p.result.errors.map(e=>e.message).join()).toContain('already exists');
  await expect(applyPreview(v,v,p,settings,now)).rejects.toThrow('contains errors');expect(v.writes).toBe(0);
  await expect(createPreview(v,settings,now,{},false,[],[tasks[0],{...tasks[0],id:'different-id'}])).rejects.toThrow('Duplicate task titles');
 });
});
