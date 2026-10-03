import { expect, it } from 'vitest';
import { resolveEvents } from '../src/event-tool';
import { dailyInputs } from '../src/daily';
import { parseFixed } from '../src/parser';
import { parseHabits } from '../src/habits';
import { chat } from '../src/llm';
import { appendHabits } from '../src/habit-tool';
import { createPreview, applyPreview, undoLast } from '../src/transaction';
import { config, MemoryVault, now } from './helpers';
const event = { title: 'Gym', date: '2026-10-01', start: '19:00', minutes: null };
const settings = config({ outputLocation:'daily', outputMode:'day-planner', cleanDaily:true });
it('uses the configured default only for unspecified duration and rejects crossing midnight', () => {
  expect(resolveEvents([event], {...settings,defaultEventDuration:45},now)[0]).toMatchObject({endTime:'19:45',defaulted:true});
  expect(resolveEvents([{...event,minutes:60}],settings,now)[0]).toMatchObject({endTime:'20:00',defaulted:false});
  expect(() => resolveEvents([{...event,start:'23:45'}],settings,now)).toThrow('same day');
  expect(() => resolveEvents([{...event,start:'07:00'}],settings,now)).toThrow('past');
  expect(() => resolveEvents([{...event,date:'2026-10-09'}],settings,now)).toThrow('seven days');
});
it('reserves start-only handwritten daily, fixed-file and habit times without editing source', () => {
  expect(dailyInputs('DailyNotes/2026-10-01.md','# Day planner\n- [ ] 11:30 Gym',45).intervals[0].end-dailyInputs('DailyNotes/2026-10-01.md','# Day planner\n- [ ] 11:30 Gym',45).intervals[0].start).toBe(45);
  const fixed = parseFixed({path:'Fixed.md',content:'- 2026-10-01 11:30 Gym'},60);
  expect(fixed.errors).toEqual([]);expect(fixed.intervals[0].end-fixed.intervals[0].start).toBe(60);
  expect(parseHabits([{path:'Habits/Template.md',content:'- 19:00 Gym (Mon, Wed)'}],45).habits[0]).toMatchObject({start:'19:00',end:'19:45',days:[1,3]});
});
it('creates an exact evening event with no ordinary tasks, repeats safely and undoes after restart',async()=>{
  const v=new MemoryVault();v.files={};
  const p=await createPreview(v,settings,now,{},false,[],[],{},resolveEvents([event],settings,now));
  expect(p.result.errors).toEqual([]);await applyPreview(v,v,p,settings,now);
  expect(v.files['DailyNotes/2026-10-01.md']).toContain('- [ ] 19:00 - 19:30 Gym');
  expect(v.files['DailyNotes/2026-10-01.md']).not.toMatch(/<!--|as-block|scheduled::/);
  const again=await createPreview(v,settings,now,v.tracking);await applyPreview(v,v,again,settings,now);
  expect(v.files['DailyNotes/2026-10-01.md'].match(/Gym/g)).toHaveLength(1);
  v.undo=JSON.parse(JSON.stringify(v.undo));await undoLast(v,v,v.undo);
  expect(v.files['DailyNotes/2026-10-01.md']).not.toContain('Gym');
});
it('replans flexible work but rejects clashes with handwritten events or habits before writing',async()=>{
  const v=new MemoryVault();
  const resolved=resolveEvents([{...event,start:'09:00'}],settings,now);
  let p=await createPreview(v,settings,now,{},false,[],[],{},resolved);
  expect(p.result.errors).toEqual([]);expect(p.result.blocks.find(b=>b.taskId==='a')?.start).toBe(resolved[0].end);
  v.files['DailyNotes/2026-10-01.md']='# Day planner\n- 09:00 Meeting';
  p=await createPreview(v,settings,now,{},false,[],[],{},resolved);
  await expect(applyPreview(v,v,p,settings,now)).rejects.toThrow('errors');expect(v.writes).toBe(0);
  delete v.files['DailyNotes/2026-10-01.md'];v.files['Habits/Template.md']='- 09:00-09:30 Exercise';
  p=await createPreview(v,settings,now,{},false,[],[],{},resolved);
  expect(p.result.errors.some(e=>e.message.includes('Conflicts'))).toBe(true);expect(v.writes).toBe(0);
});
it.each(['responses','chat-completions','anthropic','gemini'] as const)('supports a nullable duration through %s tools',async protocol=>{
  const call={name:'create_events',arguments:JSON.stringify({events:[event]})};
  const json=protocol==='responses'?{output:[{type:'function_call',...call}]}:protocol==='chat-completions'?{choices:[{finish_reason:'tool_calls',message:{tool_calls:[{type:'function',function:call}]}}]}:protocol==='anthropic'?{stop_reason:'tool_use',content:[{type:'tool_use',name:call.name,input:{events:[event]}}]}:{candidates:[{finishReason:'STOP',content:{parts:[{functionCall:{name:call.name,args:{events:[event]}}}]}}]};
  const reply=await chat({protocol,baseUrl:'https://example.test/v1',model:'fixture'},'test-only',[{role:'user',content:'Gym at 19:00 today'}],settings,now,async(_,__,body)=>{
    expect(body).toContain('create_events');expect(body).toContain('30 minutes');return {status:200,json};
  });expect(reply.events).toEqual([event]);expect(reply.tasks).toEqual([]);
});
it('defaults recurring habit end times in the host and reports the assumption',async()=>{
  const h={title:'Gym',start:'19:00',end:null,days:[1],priority:3};
  const r=await chat({protocol:'responses',baseUrl:'https://example.test/v1',model:'fixture'},'test-only',[{role:'user',content:'Gym every Monday at 19:00'}],{...settings,defaultEventDuration:45},now,async()=>({status:200,json:{output:[{type:'function_call',name:'create_habits',arguments:JSON.stringify({habits:[h]})}]}}));
  expect(r.habits[0].end).toBe('19:45');expect(r.defaultsUsed).toEqual(['Gym']);
});

it('refuses events whose start passed during preview, before saving or writing',async()=>{
  const v=new MemoryVault();v.files={};
  const p=await createPreview(v,settings,now,{},false,[],[],{},resolveEvents([{...event,start:'09:00'}],settings,now));
  await expect(applyPreview(v,v,p,settings,new Date('2026-10-01T09:01:00+08:00'))).rejects.toThrow('new event has passed');
  expect(v.writes).toBe(0);expect(v.undo).toBeNull();
});

it('rejects new event overlaps and buffers, and changed source snapshots before writes',async()=>{
  const v=new MemoryVault();v.files={};
  const buffered={...settings,fixedBuffer:15};
  let p=await createPreview(v,buffered,now,{},false,[],[],{},resolveEvents([event,{...event,title:'Second',start:'19:30'}],buffered,now));
  expect(p.result.errors.some(e=>e.message.includes('buffer'))).toBe(true);expect(v.writes).toBe(0);
  p=await createPreview(v,settings,now,{},false,[],[],{},resolveEvents([event],settings,now));
  v.files['DailyNotes/2026-10-01.md']='# Day planner\n- 19:00 Existing appointment';
  await expect(applyPreview(v,v,p,settings,now)).rejects.toThrow('changed');expect(v.writes).toBe(0);
});
it('preserves a valid late start-only habit when appending with a 15-minute default',()=>{
  const text=appendHabits('- 23:45 Read (every day)\n',[{title:'Walk',start:'19:00',end:'19:30',days:[1],priority:3}],15);
  const parsed=parseHabits([{path:'Habits/Habits.md',content:text}],15);
  expect(parsed.errors).toEqual([]);expect(parsed.habits[0].end).toBe('24:00');expect(parsed.habits).toHaveLength(2);
});

it('refuses an unclosed daily code fence that would hide the new event',async()=>{
  const v=new MemoryVault();v.files={'DailyNotes/2026-10-01.md':'# Day planner\n```markdown\n'};
  const p=await createPreview(v,settings,now,{},false,[],[],{},resolveEvents([event],settings,now));
  expect(p.result.errors.some(e=>e.message.includes('hide new events'))).toBe(true);
  await expect(applyPreview(v,v,p,settings,now)).rejects.toThrow('errors');expect(v.writes).toBe(0);
});

it('defaults an unspecified event date to the next occurrence and reports it',()=>{
  expect(resolveEvents([{...event,date:null}],settings,now)[0]).toMatchObject({date:'2026-10-01',dateDefaulted:true});
  expect(resolveEvents([{...event,date:null,start:'07:00'}],settings,now)[0]).toMatchObject({date:'2026-10-02',dateDefaulted:true});
});
