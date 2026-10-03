import {expect,it} from 'vitest';
import {readHabitIndex} from '../src/habit-index';
import {parseHabits} from '../src/habits';
import {chat} from '../src/llm';
import {DEFAULT_LLM} from '../src/types';
import {MemoryVault,config,now} from './helpers';
const settings=config({habitFolder:'Templates/Routines'});
it('indexes every template regardless of filename, including legacy names and relative lists, without unrelated notes',async()=>{
  const v=new MemoryVault();v.files={
    'Templates/Routines/AI-Habits.md':'# Habits\n- 12:40-13:10 Lunch walk (every day)',
    'Templates/Routines/Training.md':'- 19:10-19:40 Strength (Mon, Wed, Fri)',
    'Templates/Routines/Nutrition.md':'## Habit guidelines\n### Schedule actions\n- Walk after dinner\n### Rules / conditions\n- Water only',
    'DailyNotes/2026-10-01.md':'PRIVATE JOURNAL',
  };
  const r=await readHabitIndex(v,settings);
  expect(r.index.files.map(f=>f.path)).toHaveLength(3);
  expect(r.index.files.flatMap(f=>f.habits).map(h=>h.title)).toEqual(['Lunch walk','Strength']);
  expect(r.index.files.find(f=>f.path.endsWith('Nutrition.md'))?.guidelines).toEqual(['ACTION: Walk after dinner','RULE: Water only']);
  expect(JSON.stringify(r)).not.toContain('PRIVATE JOURNAL');expect(v.writes).toBe(0);
});
it('keeps occurrence identity when renaming the old default template',()=>{
  const content='- 12:40-13:10 Lunch walk (every day)';
  expect(parseHabits([{path:'Habits/AI-Habits.md',content}]).habits[0].id).toBe(parseHabits([{path:'Habits/Habits.md',content}]).habits[0].id);
});
it('reports an invalid template by path rather than silently omitting it',async()=>{
  const v=new MemoryVault();v.files={'Templates/Routines/Training.md':'- 19:00-18:00 Invalid'};
  await expect(readHabitIndex(v,settings)).rejects.toThrow('Templates/Routines/Training.md');
});
function response(protocol:string,name:string,args:unknown){
  return protocol==='responses'?{status:'completed',output:[{type:'function_call',name,call_id:'call',arguments:JSON.stringify(args)}]}
    :protocol==='anthropic'?{stop_reason:'tool_use',content:[{type:'tool_use',id:'call',name,input:args}]}
    :protocol==='gemini'?{candidates:[{finishReason:'STOP',content:{parts:[{functionCall:{name,args}}]}}]}
    :{choices:[{finish_reason:'tool_calls',message:{tool_calls:[{id:'call',type:'function',function:{name,arguments:JSON.stringify(args)}}]}}]};
}
it.each(['responses','chat-completions','anthropic','gemini'] as const)('reads then applies existing habits with %s without creating duplicates',async protocol=>{
  let round=0,reads=0;
  const index={files:[{path:'Templates/Routines/Training.md',habits:[{title:'Strength',start:'19:10',end:'19:40',days:[1,3,5],priority:3,enabled:true}],guidelines:[]}]};
  const reply=await chat({...DEFAULT_LLM,protocol},'fixture',[{role:'user',content:'Add my existing habits to the schedule'}],settings,now,async(_url,_headers,body)=>{
    expect(body).toContain('read_habits');expect(body).toContain('schedule_existing_habits');
    if(round++)expect(body).toContain('Templates/Routines/Training.md');
    return {status:200,json:response(protocol,round===1?'read_habits':'schedule_existing_habits',{})};
  },1000,undefined,async()=>{reads++;return index;});
  expect(reads).toBe(1);expect(reply.scheduleExistingHabits).toBe(true);expect(reply.habits).toEqual([]);
});
it('refuses scheduling without a fresh habit read',async()=>{
  await expect(chat(DEFAULT_LLM,'fixture',[{role:'user',content:'Apply habits'}],settings,now,async()=>({status:200,json:response('responses','schedule_existing_habits',{})}),1000,undefined,async()=>({files:[]}))).rejects.toThrow('Read existing habits');
});
it('recovers relative routines through the index after losing chat history and creates confirmed times',async()=>{
  let round=0;
  const index={files:[{path:'Templates/Routines/Habits.md',habits:[],guidelines:['ACTION: Walk for 30 minutes after lunch and dinner','ACTION: Strength after dinner walk Mon/Wed/Fri']}]};
  const habits=[{title:'Lunch walk',start:'12:40',end:'13:10',days:[0,1,2,3,4,5,6],priority:3},{title:'Dinner walk',start:'18:40',end:'19:10',days:[0,1,2,3,4,5,6],priority:3},{title:'Strength',start:'19:10',end:null,days:[1,3,5],priority:3}];
  const reply=await chat(DEFAULT_LLM,'fixture',[{role:'user',content:'Lunch ends 12:30, dinner ends 18:30, rest 10 minutes. Add habits.'}],settings,now,async(_u,_h,body)=>{
    if(round++)expect(body).toContain('Walk for 30 minutes');
    return {status:200,json:response('responses',round===1?'read_habits':'create_habits',round===1?{}:{habits})};
  },1000,undefined,async()=>index);
  expect(reply.habits.map(h=>h.start)).toEqual(['12:40','18:40','19:10']);expect(reply.defaultsUsed).toEqual(['Strength']);
});
