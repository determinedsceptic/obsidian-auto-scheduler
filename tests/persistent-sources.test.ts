import { describe, expect, it } from 'vitest';
import { createAgentSession } from '../src/plugin-agent';
import { validAiTasks } from '../src/llm';
import type { Task, Tracking, UndoRecord } from '../src/types';
import { config, MemoryVault, now } from './helpers';

class SourceVault extends MemoryVault {
  aiTasks:Task[]=[];
  getAiTasks(){return this.aiTasks;}
  getUndo(){return this.undo;}
  override async saveUndo(record:UndoRecord|null,tracking?:Tracking,tasks?:Task[]){
    await super.saveUndo(record,tracking);
    if(tracking!==undefined)this.tracking=structuredClone(tracking);
    if(tasks!==undefined)this.aiTasks=structuredClone(tasks);
  }
}
async function session(vault:SourceVault,paths=['Research/Goals.md']){
  return createAgentSession(vault,vault,config({cleanDaily:false}),{files:paths,folders:[],dailyFolder:'DailyNotes'},[],work=>work(),now,()=>now);
}
async function read(agent:Awaited<ReturnType<typeof session>>,path='Research/Goals.md',changeSetRef?:string){
  const found=await agent.runtime.execute('discover_notes',{paths:[path]});expect(found.ok).toBe(true);
  const doc=await agent.runtime.execute('read_note',{documentRef:(found.value as any).documents[0].documentRef,mode:'document',changeSetRef:changeSetRef??null});
  expect(doc.ok,JSON.stringify(doc)).toBe(true);return doc.value as any;
}
const draft=(sourceRef:string|null)=>({id:null,sourceRef,title:'长期研究',minutes:null,priority:3,split:true,minMinutes:15,due:null,earliest:null,dailyMinutes:30,estimateBasis:null,rollingMinutes:30});
async function plan(agent:Awaited<ReturnType<typeof session>>,tasks:unknown[],changeSetRef:string|null=null){
  return agent.runtime.execute('plan_schedule',{mode:'add',tasks,events:[],habitRefs:[],changeSetRef});
}
async function commit(agent:Awaited<ReturnType<typeof session>>,result:any){
  expect(result.ok,JSON.stringify(result)).toBe(true);
  const committed=await agent.runtime.execute('commit_changes',{changeSetRef:result.value.changeSetRef});
  expect(committed.ok,JSON.stringify(committed)).toBe(true);return committed;
}

describe('persistent goals in the real plugin runtime',()=>{
  it('rejects unbound tasks, calendar sources, and implicit total duration defaults',async()=>{
    const vault=new SourceVault();vault.files={'Research/Goals.md':'## My projects\n- [ ] 长期研究\n# Day planner\n- [ ] 10:00 - 10:30 长期研究\n'};
    const agent=await session(vault),note=await read(agent);
    expect((await plan(agent,[draft(null)])).ok).toBe(false);
    const calendar=await plan(agent,[draft(note.blocks[1].blockRef)]);
    expect(calendar.ok).toBe(false);expect(calendar.error).toContain('outside Day planner');
    const noBudget=await plan(agent,[{...draft(note.blocks[0].blockRef),dailyMinutes:null,rollingMinutes:null}]);
    expect(noBudget.ok).toBe(false);expect(noBudget.error).toContain('do not substitute a default');
    expect(vault.writes).toBe(0);expect(vault.aiTasks).toEqual([]);
  });

  it('creates an unknown-effort source and one session atomically, keeps the goal open, and undoes both',async()=>{
    const vault=new SourceVault();vault.files={};const agent=await session(vault);
    const note=await read(agent);
    const staged=await agent.runtime.execute('stage_note_changes',{changes:[{operation:'insert',targetRef:note.documentRef,position:'end',content:'### 我的研究\n- [ ] 长期研究\n  - 总工作量尚未确定\n'}]});
    expect(staged.ok).toBe(true);const ref=(staged.value as any).changeSetRef;
    const overlay=await read(agent,'Research/Goals.md',ref);
    const planned=await plan(agent,[draft(overlay.blocks[0].blockRef)],ref);
    expect((planned.value as any).goals[0]).toMatchObject({totalMinutes:null,sessionBudgetMinutes:30,status:'active'});
    expect((planned.value as any).blocks).toHaveLength(1);
    expect(vault.writes).toBe(0);
    const committed=await commit(agent,planned);
    expect(vault.files['Research/Goals.md']).toBe('### 我的研究\n- [ ] 长期研究\n  - 总工作量尚未确定\n');
    expect(vault.files['DailyNotes/2026-10-01.md']).toContain('# Day planner');
    expect(vault.files['Research/Goals.md']).not.toContain('# Tasks');
    expect(vault.aiTasks[0]).toMatchObject({effort:'unknown',completed:false,sourceStatus:'open',sourceCount:1,sourceOccurrence:0});
    expect(validAiTasks(vault.aiTasks)).toBe(true);
    const restarted=await session(vault);
    const undo=await restarted.runtime.execute('undo_operation',{operationId:committed.receipt!.operationId});
    expect(undo.ok).toBe(true);expect(vault.aiTasks).toEqual([]);
    expect(vault.files['Research/Goals.md']).toBe('');expect(vault.files['DailyNotes/2026-10-01.md']).toBe('');
  });

  it('rejects a source deletion in a later generic edit, including after restart',async()=>{
    const vault=new SourceVault();const source='## 待办\n- [ ] 长期研究\n';vault.files={'Research/Goals.md':source};
    let agent=await session(vault),note=await read(agent);await commit(agent,await plan(agent,[draft(note.blocks[0].blockRef)]));
    const writes=vault.writes;agent=await session(vault);note=await read(agent);
    const deletion=await agent.runtime.execute('stage_note_changes',{changes:[{operation:'delete',targetRef:note.blocks[0].blockRef}]});
    expect(deletion.ok).toBe(false);expect(deletion.error).toContain('Pending task sources');
    expect(vault.files['Research/Goals.md']).toBe(source);expect(vault.writes).toBe(writes);
  });

  it('cannot swap an existing source for an unrelated checkbox without explicit rebinding',async()=>{
    const vault=new SourceVault();vault.files={'Research/Goals.md':'## Research\n- [ ] 长期研究\n'};
    const agent=await session(vault);let note=await read(agent);await commit(agent,await plan(agent,[draft(note.blocks[0].blockRef)]));
    const saved=structuredClone(vault.aiTasks),writes=vault.writes;note=await read(agent);
    const rename=await agent.runtime.execute('stage_note_changes',{changes:[{operation:'replace',targetRef:note.blocks[0].blockRef,content:'- [ ] 研究新表述\n'}]});
    expect(rename.ok).toBe(true);
    const blocked=await agent.runtime.execute('commit_changes',{changeSetRef:(rename.value as any).changeSetRef});
    expect(blocked.ok).toBe(false);expect(blocked.error).toContain('bind_task_source');
    expect(vault.writes).toBe(writes);expect(vault.aiTasks).toEqual(saved);
    const stagedRef=(rename.value as any).changeSetRef,overlay=await read(agent,'Research/Goals.md',stagedRef);
    const rebound=await agent.runtime.execute('bind_task_source',{taskId:saved[0].id,sourceRef:overlay.blocks[0].blockRef,changeSetRef:stagedRef,title:'研究新表述'});
    await commit(agent,rebound);
    expect(vault.aiTasks[0].id).toBe(saved[0].id);expect(vault.aiTasks[0].rollingMinutes).toBe(30);
    expect(vault.aiTasks[0].sessionPaths).toEqual(saved[0].sessionPaths);
    expect(vault.files['Research/Goals.md']).toContain('- [ ] 研究新表述');
  });

  it('copies/moves persistent sources without using a fixed heading',async()=>{
    const vault=new SourceVault();vault.files={'Research/Goals.md':'## 科学问题\n- [ ] 长期研究\n','Research/Next.md':'### Next\n'};
    const agent=await session(vault,['Research/Goals.md','Research/Next.md']);let source=await read(agent);
    await commit(agent,await plan(agent,[draft(source.blocks[0].blockRef)]));const id=vault.aiTasks[0].id;
    source=await read(agent);const target=await read(agent,'Research/Next.md');
    const moved=await agent.runtime.execute('stage_note_changes',{changes:[{operation:'delete',targetRef:source.blocks[0].blockRef},{operation:'insert',targetRef:target.documentRef,position:'end',content:source.blocks[0].content}]});
    await commit(agent,moved);expect(vault.aiTasks[0].path).toBe('Research/Next.md');expect(vault.aiTasks[0].id).toBe(id);
    expect(vault.files['Research/Goals.md']).toBe('## 科学问题\n');expect(vault.files['Research/Next.md']).toContain('- [ ] 长期研究');
  });

  it('tracks two identical sources independently and only accepts explicit goal completion',async()=>{
    const vault=new SourceVault();vault.files={'Research/Goals.md':'## My queue\n- [ ] 长期研究\n- [ ] 长期研究\n'};
    const agent=await session(vault);let note=await read(agent);
    await commit(agent,await plan(agent,[draft(note.blocks[0].blockRef),draft(note.blocks[1].blockRef)]));
    expect(vault.aiTasks.map(task=>task.sourceOccurrence)).toEqual([0,1]);
    note=await read(agent);
    await commit(agent,await agent.runtime.execute('stage_note_changes',{changes:[{operation:'replace',targetRef:note.blocks[1].blockRef,content:'- [x] 长期研究\n'}]}));
    expect(vault.aiTasks.map(task=>task.completed)).toEqual([false,true]);
    await read(agent);
    const again=await agent.runtime.execute('plan_schedule',{mode:'replan',tasks:[],events:[],habitRefs:[],changeSetRef:null});
    expect(again.ok,JSON.stringify(again)).toBe(true);
    expect((again.value as any).goals.map((task:any)=>task.status)).toEqual(['active','completed']);
  });

  it('does not invent a finish date when a session is checked, and known estimates exhaust without completing the goal',async()=>{
    for(const unknown of [true,false]){
      const vault=new SourceVault();vault.files={'Research/Goals.md':'## My queue\n- [ ] 长期研究\n'};
      const agent=await session(vault),note=await read(agent);
      await commit(agent,await plan(agent,[{...draft(note.blocks[0].blockRef),minutes:unknown?null:30,rollingMinutes:unknown?30:null}]));
      vault.files['DailyNotes/2026-10-01.md']=vault.files['DailyNotes/2026-10-01.md'].replace('- [ ] 09:00','- [x] 09:00');
      const replan=await agent.runtime.execute('plan_schedule',{mode:'replan',tasks:[],events:[],habitRefs:[],changeSetRef:null});
      expect(replan.ok,JSON.stringify(replan)).toBe(true);await commit(agent,replan);
      expect(vault.files['Research/Goals.md']).toContain('- [ ] 长期研究');
      expect(vault.aiTasks[0]).toMatchObject({completed:false,sourceStatus:'open',completedMinutes:30,needsReview:!unknown});
      const goal=(replan.value as any).goals[0];expect(goal.totalMinutes).toBe(unknown?null:30);
      if(!unknown)expect((replan.value as any).unscheduled[0].reason).toContain('source goal remains open');
    }
  });

  it('requires a legacy calendar-only task to be bound before future scheduling',async()=>{
    const vault=new SourceVault();vault.files={'Research/Goals.md':'## Goal\n- [ ] 长期研究\n'};
    vault.aiTasks=[{id:'ai_legacy_1',path:'DailyNotes/2026-10-01.md',line:0,title:'长期研究',remaining:30,min:15,split:true,priority:3,completed:false}];
    const agent=await session(vault),note=await read(agent);
    const failed=await agent.runtime.execute('plan_schedule',{mode:'replan',tasks:[],events:[],habitRefs:[],changeSetRef:null});
    expect(failed.ok).toBe(false);expect(failed.error).toContain('persistent source');
    const bound=await agent.runtime.execute('bind_task_source',{taskId:'ai_legacy_1',sourceRef:note.blocks[0].blockRef,changeSetRef:null,title:null});
    await commit(agent,bound);expect(vault.aiTasks[0].path).toBe('Research/Goals.md');
    expect((await agent.runtime.execute('plan_schedule',{mode:'replan',tasks:[],events:[],habitRefs:[],changeSetRef:null})).ok).toBe(true);
  });

  it('rejects rebinding a second goal onto a source already used by another goal',async()=>{
    const vault=new SourceVault();vault.files={'Research/Goals.md':'## Queue\n- [ ] First\n- [ ] Second\n'};
    const agent=await session(vault);let note=await read(agent);
    await commit(agent,await plan(agent,[{...draft(note.blocks[0].blockRef),title:'First'},{...draft(note.blocks[1].blockRef),title:'Second'}]));
    note=await read(agent);await commit(agent,await agent.runtime.execute('stage_note_changes',{changes:[{operation:'replace',targetRef:note.blocks[1].blockRef,content:'- [-] Second\n'}]}));
    note=await read(agent);const before=structuredClone(vault.aiTasks);
    const rebound=await agent.runtime.execute('bind_task_source',{taskId:before[1].id,sourceRef:note.blocks[0].blockRef,changeSetRef:null,title:null});
    expect(rebound.ok).toBe(false);expect(rebound.error).toContain('already bound');expect(vault.aiTasks).toEqual(before);
  });

  it('retires deleted terminal sources so identical later tasks have independent identity/history',async()=>{
    const vault=new SourceVault();vault.files={'Research/Goals.md':'## Goal\n- [ ] 长期研究\n'};
    const agent=await session(vault);let note=await read(agent);
    await commit(agent,await plan(agent,[draft(note.blocks[0].blockRef)]));const oldId=vault.aiTasks[0].id;
    note=await read(agent);await commit(agent,await agent.runtime.execute('stage_note_changes',{changes:[{operation:'replace',targetRef:note.blocks[0].blockRef,content:'- [-] 长期研究\n'}]}));
    note=await read(agent);await commit(agent,await agent.runtime.execute('stage_note_changes',{changes:[{operation:'delete',targetRef:note.blocks[0].blockRef}]}));
    expect(vault.aiTasks[0]).toMatchObject({completed:true,sourceStatus:'cancelled',sourceRetired:true});expect(vault.aiTasks[0].sourceText).toBeUndefined();
    note=await read(agent);await commit(agent,await agent.runtime.execute('stage_note_changes',{changes:[{operation:'insert',targetRef:note.documentRef,position:'end',content:'- [ ] 长期研究\n'}]}));
    note=await read(agent);await commit(agent,await plan(agent,[draft(note.blocks[0].blockRef)]));
    expect(vault.aiTasks).toHaveLength(2);expect(vault.aiTasks[0].id).toBe(oldId);expect(vault.aiTasks[1].id).not.toBe(oldId);
    expect(vault.aiTasks.map(task=>task.completed)).toEqual([true,false]);expect(validAiTasks(vault.aiTasks)).toBe(true);
  });

  it('refuses to transfer progress to an unrelated unused source while the original stays open',async()=>{
    const vault=new SourceVault();vault.files={'Research/Goals.md':'## Queue\n- [ ] 长期研究\n- [ ] Unrelated goal\n'};
    const agent=await session(vault);let note=await read(agent);
    await commit(agent,await plan(agent,[draft(note.blocks[0].blockRef)]));const before=structuredClone(vault.aiTasks);note=await read(agent);
    const rebound=await agent.runtime.execute('bind_task_source',{taskId:before[0].id,sourceRef:note.blocks[1].blockRef,changeSetRef:null,title:null});
    expect(rebound.ok).toBe(false);expect(rebound.error).toContain('source still exists');expect(vault.aiTasks).toEqual(before);
  });
});
