import { describe, expect, it } from 'vitest';
import { chat, materializeTasks } from '../src/llm';
import { applyPreview, createPreview, undoLast } from '../src/transaction';
import type { LlmSettings, Task, Tracking, UndoRecord } from '../src/types';
import { config, MemoryVault, now } from './helpers';
const settings=config({outputLocation:'daily',outputMode:'day-planner',cleanDaily:true});
class AiVault extends MemoryVault {
  aiTasks:Task[]=[];
  getAiTasks(){return this.aiTasks;}
  override async saveUndo(record:UndoRecord|null,tracking?:Tracking,tasks?:Task[]){await super.saveUndo(record,tracking);if(tasks)this.aiTasks=structuredClone(tasks);}
}
const undo={name:'undo_last_schedule',arguments:'{}',id:'undo-1'};
const configs:LlmSettings[]=['responses','chat-completions','anthropic','gemini'].map(protocol=>({protocol:protocol as LlmSettings['protocol'],baseUrl:'https://provider.test/v1',model:'test-model'}));
function response(protocol:LlmSettings['protocol']) {
  if(protocol==='responses')return {output:[{type:'function_call',...undo}]};
  if(protocol==='anthropic')return {stop_reason:'tool_use',content:[{type:'tool_use',id:undo.id,name:undo.name,input:{}}]};
  if(protocol==='gemini')return {candidates:[{finishReason:'STOP',content:{parts:[{functionCall:{name:undo.name,args:{}}}]}}]};
  return {choices:[{finish_reason:'tool_calls',message:{tool_calls:[{type:'function',id:undo.id,function:undo}]}}]};
}
describe('chat undo',()=>{
  it.each(configs)('advertises and validates undo for $protocol without inventing a successful write',async llm=>{
    const reply=await chat(llm,'test-only',[{role:'user',content:'撤销刚才的排程'}],settings,now,async(_,__,body)=>{
      const data=JSON.parse(body);
      const tools=data.tools[0]?.functionDeclarations??data.tools;
      expect(tools.map((t:any)=>t.function?.name??t.name)).toContain('undo_last_schedule');
      return {status:200,json:response(llm.protocol)};
    });
    expect(reply.undoLastSchedule).toBe(true);expect(reply.text).toBe('');expect(reply.tasks).toEqual([]);
  });
  it.each(['{"path":"DailyNotes/other.md"}','[]','null','invalid'])('rejects invalid undo arguments %s',async arguments_=>{
    await expect(chat(configs[0],'test-only',[{role:'user',content:'undo'}],settings,now,async()=>({status:200,json:{output:[{type:'function_call',...undo,arguments:arguments_}]}}))).rejects.toThrow('Invalid undo arguments');
  });
  it('rejects undo combined with creation or other mutations',async()=>{
    await expect(chat(configs[0],'test-only',[{role:'user',content:'undo'}],settings,now,async()=>({status:200,json:{output:[{type:'function_call',...undo},{type:'function_call',name:'create_plan',arguments:'{}'}]}}))).rejects.toThrow('separately');
  });
  it('restores task state and original notes after restart, and refuses later note edits',async()=>{
    const v=new AiVault();const path='DailyNotes/2026-10-01.md',original='# Journal\nKeep this\n';v.files={[path]:original};
    const tasks=materializeTasks([{title:'Report',minutes:60,priority:3,split:true,minMinutes:30,due:null,earliest:null}],settings,now,'undo');
    const p=await createPreview(v,settings,now,{},false,[],tasks);await applyPreview(v,v,p,settings,now);
    const saved=structuredClone(v.files),persistedTasks=structuredClone(v.aiTasks), restarted=new AiVault();restarted.files=structuredClone(v.files);restarted.aiTasks=structuredClone(v.aiTasks);restarted.tracking=structuredClone(v.tracking);restarted.undo=structuredClone(v.undo);
    restarted.files[path]+='Manual edit\n';
    await expect(undoLast(restarted,restarted,restarted.undo)).rejects.toThrow('refusing to overwrite');
    expect(restarted.aiTasks).toEqual(persistedTasks);expect(restarted.undo).not.toBeNull();expect(restarted.writes).toBe(0);
    restarted.files=saved;await undoLast(restarted,restarted,restarted.undo);
    expect(restarted.files[path]).toBe(original);expect(restarted.aiTasks).toEqual([]);expect(restarted.undo).toBeNull();
    await expect(undoLast(restarted,restarted,restarted.undo)).rejects.toThrow('No schedule to undo');
  });
});
