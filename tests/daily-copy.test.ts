import { it, expect } from 'vitest';
import { copyDailyTasks, validateDailyCopy } from '../src/daily-copy';
import { readDailyPlan } from '../src/daily-edit';
import { chat, materializeTasks } from '../src/llm';
import { applyPreview, createPreview, undoLast } from '../src/transaction';
import { addDays } from '../src/time';
import { config, MemoryVault, now } from './helpers';
const settings=config({outputLocation:'daily',outputMode:'day-planner',cleanDaily:true});
const source='DailyNotes/2026-10-01.md';
const dates=Array.from({length:7},(_,i)=>addDays('2026-10-01',i+1));
const original='---\ntags: daily\n---\n# Tasks\n- [ ] ⏫ Report 📅 2026-10-20\n- [ ] Read\n- [x] Finished\n# Day planner\n- [ ] 10:00 - 10:30 Meeting\n# Journal\n- [ ] private\n';
async function setup(){const v=new MemoryVault();v.files={[source]:original};const read=await readDailyPlan(v,settings,{},[],'2026-10-01',now);return {v,read,args:{date:'2026-10-01',targetDates:dates,refs:read.read.taskRefs!}};}
it('copies source Tasks to all seven following dates without moving, allocating or changing private sections; undo restores',async()=>{
 const {v,read,args}=await setup();
 const destination='DailyNotes/2026-10-02.md',before='---\ntags: other\n---\n# Tasks\n- [ ] Existing\n# Day planner\n- [ ] 11:00 - 11:30 Break\n# Journal\nKeep\n';v.files[destination]=before;
 const result=await copyDailyTasks(v,v,settings,{},[],read,args,now);
 expect(result.dates).toEqual(dates);expect(result.count).toBe(2);expect(v.files[source]).toBe(original);
 for(const date of dates){const text=v.files[`DailyNotes/${date}.md`];expect(text).toContain('# Tasks');expect(text).toContain('- [ ] ⏫ Report 📅 2026-10-20');expect(text).toContain('- [ ] Read');expect(text).not.toContain('Finished');expect(text).not.toContain('Meeting');expect(text).not.toContain('private');}
 expect(v.files[destination]).toContain('# Day planner\n- [ ] 11:00 - 11:30 Break\n# Journal\nKeep\n');expect(v.files[destination].startsWith('---\ntags: other\n---')).toBe(true);
 await undoLast(v,v,v.undo);expect(v.files[source]).toBe(original);expect(v.files[destination]).toBe(before);for(const date of dates.slice(1))expect(v.files[`DailyNotes/${date}.md`]).toBe('');
});
it('retains identical rows without duplicating them on retry, and keeps the last useful undo',async()=>{
 const {v,read,args}=await setup();await copyDailyTasks(v,v,settings,{},[],read,args,now);const saved=structuredClone(v.files),undo=structuredClone(v.undo),writes=v.writes;
 const result=await copyDailyTasks(v,v,settings,{},[],read,args,now);expect(result.changed).toBe(false);expect(v.files).toEqual(saved);expect(v.writes).toBe(writes);expect(v.undo).toEqual(undo);
});
it('refuses stale source, invented references, completed rows, time blocks and targets outside the copy horizon',async()=>{
 for(const change of ['stale','unknown','completed','clock','today','far']){
  const {v,read,args}=await setup();
  if(change==='stale')v.files[source]+='Changed\n';
  if(change==='unknown')args.refs=['unknown'];
  if(change==='completed')args.refs=[read.read.items.find(i=>i.title==='Finished')!.ref];
  if(change==='clock')args.refs=[read.read.items.find(i=>i.title==='Meeting')!.ref];
  if(change==='today')args.targetDates=['2026-10-01'];
  if(change==='far')args.targetDates=['2026-10-09'];
  await expect(copyDailyTasks(v,v,settings,{},[],read,args,now)).rejects.toThrow();expect(v.writes).toBe(0);
 }
});
it('uses the stored AI master identity while copying its literal row, never the generated time block',async()=>{
 const v=new MemoryVault();v.files={};const tasks=materializeTasks([{title:'Report',minutes:60,priority:4,split:true,minMinutes:30,due:null,earliest:null}],settings,now,'master');
 const p=await createPreview(v,settings,now,{},false,[],tasks);await applyPreview(v,v,p,settings,now);
 const sourceBefore=v.files[source],read=await readDailyPlan(v,settings,v.tracking,tasks,'2026-10-01',now);
 expect(read.read.taskRefs).toEqual([tasks[0].id]);
 await copyDailyTasks(v,v,settings,v.tracking,tasks,read,{date:'2026-10-01',targetDates:dates,refs:read.read.taskRefs!},now);
 expect(v.files[source]).toBe(sourceBefore);expect(v.files['DailyNotes/2026-10-08.md']).toBe('# Tasks\n\n- [ ] ⏫ Report\n\n');
});
it('refuses hidden target rows and persists recovery before partial writes',async()=>{
 const {v,read,args}=await setup();v.files['DailyNotes/2026-10-02.md']='# Tasks\n```md\n';
 await expect(copyDailyTasks(v,v,settings,{},[],read,args,now)).rejects.toThrow('code fence');expect(v.writes).toBe(0);
 delete v.files['DailyNotes/2026-10-02.md'];v.failWrite=true;
 await expect(copyDailyTasks(v,v,settings,{},[],read,args,now)).rejects.toThrow('write failed');expect(v.undo?.entries).toHaveLength(7);expect(v.files[source]).toBe(original);
 v.failWrite=false;await undoLast(v,v,v.undo);expect(v.files[source]).toBe(original);
});
it('preserves CRLF and excludes fenced, nested and source-managed task rows',async()=>{
 const {v}=await setup();v.files[source]='# Tasks\r\n- [ ] Plain\r\n- [ ] Nested\r\n  description\r\n- [ ] Managed <!-- as id=x remaining=30 -->\r\n```md\r\n- [ ] example\r\n```\r\n# Journal\r\nprivate\r\n';
 const read=await readDailyPlan(v,settings,{},[],'2026-10-01',now);expect(Object.values(read.taskRows!)).toEqual(['- [ ] Plain']);
 v.files['DailyNotes/2026-10-02.md']='# Tasks\r\n# Journal\r\nkeep\r\n';
 await copyDailyTasks(v,v,settings,{},[],read,{date:'2026-10-01',targetDates:['2026-10-02'],refs:read.read.taskRefs!},now);
 expect(v.files['DailyNotes/2026-10-02.md']).toBe('# Tasks\r\n- [ ] Plain\r\n# Journal\r\nkeep\r\n');
});
it('rejects malformed copy arguments',()=>{for(const args of [null,[],{}, {date:'2026-10-01',targetDates:['2026-10-02','2026-10-02'],refs:['a']}])expect(()=>validateDailyCopy(args)).toThrow();});
it('reads then calls the copy tool through DeepSeek-compatible Chat Completions',async()=>{
 const {read,args}=await setup();let calls=0;
 const reply=await chat({protocol:'chat-completions',baseUrl:'https://api.deepseek.com',model:'fixture'},'test-only',[{role:'user',content:'把今天的tasks复制之后7天中'}],settings,now,async(_,__,body)=>{
  const request=JSON.parse(body);calls++;
  if(calls===2){expect(request.tools.map((t:any)=>t.function.name)).toContain('copy_daily_tasks');expect(request.messages.at(-1).content).toContain('taskRefs');}
  const call=calls===1?{name:'read_daily_plan',arguments:JSON.stringify({date:'2026-10-01'})}:{name:'copy_daily_tasks',arguments:JSON.stringify(args)};
  return {status:200,json:{choices:[{finish_reason:'tool_calls',message:{tool_calls:[{id:String(calls),type:'function',function:call}]}}]}};
 },1000,async()=>read.read);
 expect(reply.copyTasks).toEqual(args);expect(reply.revision).toBeUndefined();expect(reply.tasks).toEqual([]);
});
it('blocks a model that routes a copy request to move/replan before any host mutation',async()=>{
 await expect(chat({protocol:'responses',baseUrl:'https://provider.test',model:'fixture'},'test-only',[{role:'user',content:'把今天的tasks复制之后7天中'}],settings,now,async()=>({status:200,json:{output:[{type:'function_call',name:'revise_daily_tasks',arguments:'{}'}]}}))).rejects.toThrow('no tasks were moved or scheduled');
});
