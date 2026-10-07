import { describe, expect, it } from 'vitest';
import { NoteWorkspace, NOTE_WORKSPACE_TOOLS } from '../src/note-workspace';
import type { AgentScope, ToolResult } from '../src/agent-types';
import type { Task, Tracking, UndoRecord } from '../src/types';
import { MemoryVault, now } from './helpers';

const scope:AgentScope={folders:['Notes'],files:[],dailyFolder:'Daily'};
const value=<T>(result:ToolResult):T=>{expect(result.ok,result.error).toBe(true);return result.value as T;};
async function discover(workspace:NoteWorkspace,args:unknown){return value<{documents:Array<{path:string;exists:boolean;documentRef:string;versionRef:string}>}>(await workspace.execute('discover_notes',args));}
async function read(workspace:NoteWorkspace,args:unknown){return value<any>(await workspace.execute('read_note',args));}
async function stage(workspace:NoteWorkspace,args:unknown){return value<{changeSetRef:string;summary:string;changes:any[]}>(await workspace.execute('stage_note_changes',args));}

class DurableVault extends MemoryVault {
  aiTasks:Task[]=[]; saveCount=0; failSaveAt?:number; failWriteAt?:number;
  getUndo():UndoRecord|null{return this.undo;}
  getAiTasks():Task[]{return this.aiTasks;}
  override async saveUndo(record:UndoRecord|null,tracking?:Tracking,tasks?:Task[]):Promise<void>{
    this.saveCount++;if(this.failSaveAt===this.saveCount)throw new Error('save failed');
    this.undo=record?structuredClone(record):null;if(tracking!==undefined)this.tracking=structuredClone(tracking);if(tasks!==undefined)this.aiTasks=structuredClone(tasks);
  }
  override async writeChecked(path:string,expected:string|null,next:string):Promise<void>{if(this.failWriteAt===this.writes+1)throw new Error('selected write failed');await super.writeChecked(path,expected,next);}
}

describe('generic Markdown workspace',()=>{
  it('publishes fixed generic schemas and class methods',()=>{
    expect(NOTE_WORKSPACE_TOOLS.map(tool=>tool.name)).toEqual(['discover_notes','read_note','stage_note_changes','commit_changes','undo_operation']);
    const commit=NOTE_WORKSPACE_TOOLS.find(tool=>tool.name==='commit_changes')!;
    expect(commit.parameters).toMatchObject({type:'object',additionalProperties:false,required:['changeSetRef']});
    const workspace=new NoteWorkspace(new DurableVault(),new DurableVault(),scope);
    expect(typeof workspace.stageExternalChanges).toBe('function');expect(typeof workspace.getStagedChanges).toBe('function');expect(typeof workspace.resolveReference).toBe('function');expect(typeof workspace.getReadDependencies).toBe('function');
  });

  it('copies a custom section to seven dated notes without changing the source or inventing Tasks',async()=>{
    const vault=new DurableVault();const original='# 自定义计划\n- [ ] Alpha\n- [ ] Beta\n# Journal\nprivate\n';vault.files={'Notes/Source.md':original};
    const workspace=new NoteWorkspace(vault,vault,scope,{now:()=>now});
    const source=(await discover(workspace,{paths:['Notes/Source.md']})).documents[0];
    const outline=await read(workspace,{documentRef:source.documentRef});expect(outline.sections.map((item:any)=>item.title)).toEqual(['自定义计划','Journal']);expect(outline.sections[0].content).toBeUndefined();
    const section=await read(workspace,{documentRef:source.documentRef,mode:'section',ref:outline.sections[0].sectionRef});
    const dates=Array.from({length:7},(_,index)=>`2026-10-${String(index+2).padStart(2,'0')}`),targets=(await discover(workspace,{dates})).documents;
    const staged=await stage(workspace,{summary:'copy custom section',changes:targets.map(target=>({operation:'insert',targetRef:target.documentRef,position:'end',content:section.content}))});
    const result=await workspace.execute('commit_changes',{changeSetRef:staged.changeSetRef});expect(result.receipt?.status).toBe('committed');expect(result.receipt?.changedFiles).toHaveLength(7);
    expect(vault.files['Notes/Source.md']).toBe(original);for(const date of dates){expect(vault.files[`Daily/${date}.md`]).toBe('# 自定义计划\n- [ ] Alpha\n- [ ] Beta\n');expect(vault.files[`Daily/${date}.md`]).not.toContain('Tasks');}
  });

  it('preserves frontmatter, CRLF, nested and duplicate headings, and ignores headings in fences',async()=>{
    const vault=new DurableVault();const original='---\r\ntitle: "# metadata"\r\n---\r\n# Same\r\nparagraph\r\n## Child\r\n```md\r\n# hidden\r\n```\r\n# Same\r\nlast\r\n';vault.files={'Notes/A.md':original};
    const workspace=new NoteWorkspace(vault,vault,scope,{now:()=>now}),doc=(await discover(workspace,{paths:['Notes/A.md']})).documents[0];
    const outline=await read(workspace,{documentRef:doc.documentRef});expect(outline.sections.map((item:any)=>[item.level,item.title])).toEqual([[1,'Same'],[2,'Child'],[1,'Same']]);expect(outline.frontmatter).toBe('---\r\ntitle: "# metadata"\r\n---\r\n');
    const first=await read(workspace,{documentRef:doc.documentRef,mode:'section',ref:outline.sections[0].sectionRef});expect(first.blocks.map((item:any)=>item.content)).toContain('```md\r\n# hidden\r\n```\r\n');
    const paragraph=first.blocks.find((item:any)=>item.content==='paragraph\r\n');const staged=await stage(workspace,{changes:[{operation:'replace',targetRef:paragraph.blockRef,content:'changed\nline'}]});
    await workspace.execute('commit_changes',{changeSetRef:staged.changeSetRef});expect(vault.files['Notes/A.md']).toBe(original.replace('paragraph\r\n','changed\r\nline'));expect(vault.files['Notes/A.md'].replace(/\r\n/g,'')).not.toContain('\n');
  });

  it('returns one block per top-level list item while retaining indented children',async()=>{
    const vault=new DurableVault();vault.files={'Notes/List.md':'# Work\n- [ ] A\n- [ ] B\n  detail\n  - child\n- [ ] C\n'};const workspace=new NoteWorkspace(vault,vault,scope),doc=(await discover(workspace,{paths:['Notes/List.md']})).documents[0];
    const readDoc=await read(workspace,{documentRef:doc.documentRef,mode:'document'});expect(readDoc.blocks.map((block:any)=>block.content)).toEqual(['- [ ] A\n','- [ ] B\n  detail\n  - child\n','- [ ] C\n']);
    expect(workspace.resolveReference(readDoc.blocks[0].blockRef).text).toBe('- [ ] A\n');expect(workspace.resolveReference(readDoc.blocks[1].blockRef).text).toContain('  - child');
  });

  it('reads newly inserted staged checkboxes with exact origin and virtual document text',async()=>{
    const vault=new DurableVault();vault.files={};const workspace=new NoteWorkspace(vault,vault,scope),doc=(await discover(workspace,{paths:['Notes/New.md']})).documents[0];
    const staged=await stage(workspace,{changes:[{operation:'insert',targetRef:doc.documentRef,position:'end',content:'# Inbox\n- [ ] staged source\n'}]});
    const stagedDoc=await read(workspace,{documentRef:doc.documentRef,mode:'document',changeSetRef:staged.changeSetRef});
    expect(stagedDoc).toMatchObject({exists:true,changeSetRef:staged.changeSetRef,content:'# Inbox\n- [ ] staged source\n'});expect(stagedDoc.blocks).toHaveLength(1);
    expect(workspace.resolveReference(stagedDoc.blocks[0].blockRef)).toMatchObject({path:'Notes/New.md',before:null,documentText:'# Inbox\n- [ ] staged source\n',text:'- [ ] staged source\n',changeSetRef:staged.changeSetRef});
    expect(workspace.getReadDependencies()).toMatchObject({'Notes/New.md':null});expect(vault.files['Notes/New.md']).toBeUndefined();
  });

  it('refuses stale staged reads and generic edits against staged references',async()=>{
    const vault=new DurableVault();vault.files={'Notes/A.md':'# Inbox\n'};const workspace=new NoteWorkspace(vault,vault,scope),doc=(await discover(workspace,{paths:['Notes/A.md']})).documents[0];await read(workspace,{documentRef:doc.documentRef,mode:'document'});
    const staged=await stage(workspace,{changes:[{operation:'insert',targetRef:doc.documentRef,position:'end',content:'- [ ] staged\n'}]});const stagedDoc=await read(workspace,{documentRef:doc.documentRef,mode:'document',changeSetRef:staged.changeSetRef});
    const restage=await workspace.execute('stage_note_changes',{changes:[{operation:'replace',targetRef:stagedDoc.blocks[0].blockRef,content:'- [ ] twice'}]});expect(restage.ok).toBe(false);expect(restage.error).toContain('commit and re-read');
    vault.files['Notes/A.md']='# changed\n';const stale=await workspace.execute('read_note',{documentRef:doc.documentRef,mode:'document',changeSetRef:staged.changeSetRef});expect(stale.ok).toBe(false);expect(stale.error).toContain('Staged dependency changed');

    const stateVault=new DurableVault();stateVault.files={'Notes/B.md':'old'};const stateWorkspace=new NoteWorkspace(stateVault,stateVault,scope),stateDoc=(await discover(stateWorkspace,{paths:['Notes/B.md']})).documents[0];await read(stateWorkspace,{documentRef:stateDoc.documentRef,mode:'document'});const stateStage=await stage(stateWorkspace,{changes:[{operation:'replace',targetRef:stateDoc.documentRef,content:'new'}]});
    stateVault.tracking={'Daily/2026-10-01.md':{before:null,after:{visible:'later',annotated:'later'}}};const staleState=await stateWorkspace.execute('read_note',{documentRef:stateDoc.documentRef,mode:'document',changeSetRef:stateStage.changeSetRef});expect(staleState.ok).toBe(false);expect(staleState.error).toContain('state changed');
  });

  it.each([
    {operations:[{operation:'replace',content:'NEW\n'},{operation:'insert',position:'before',content:'PRE'}]},
    {operations:[{operation:'insert',position:'before',content:'PRE'},{operation:'replace',content:'NEW\n'}]},
    {operations:[{operation:'delete'},{operation:'insert',position:'before',content:'PRE'}]},
  ])('orders a boundary insertion after applying the range edit regardless of argument order',async({operations})=>{
    const vault=new DurableVault();vault.files={'Notes/A.md':'old\n'};const workspace=new NoteWorkspace(vault,vault,scope),doc=(await discover(workspace,{paths:['Notes/A.md']})).documents[0],readDoc=await read(workspace,{documentRef:doc.documentRef,mode:'document'}),targetRef=readDoc.blocks[0].blockRef;
    const staged=await stage(workspace,{changes:operations.map(operation=>({...operation,targetRef}))});await workspace.execute('commit_changes',{changeSetRef:staged.changeSetRef});expect(vault.files['Notes/A.md']).toBe(operations.some(operation=>operation.operation==='replace')?'PRE\nNEW\n':'PRE\n');
  });

  it('binds all read source and target versions and rejects stale dependencies',async()=>{
    for(const stale of ['source','target']){
      const vault=new DurableVault();vault.files={'Notes/Source.md':'source','Notes/Target.md':'target'};const workspace=new NoteWorkspace(vault,vault,scope,{now:()=>now});
      const docs=(await discover(workspace,{paths:['Notes/Source.md','Notes/Target.md']})).documents;const source=docs.find(doc=>doc.path.endsWith('Source.md'))!,target=docs.find(doc=>doc.path.endsWith('Target.md'))!;
      await read(workspace,{documentRef:source.documentRef,mode:'document'});await read(workspace,{documentRef:target.documentRef,mode:'document'});
      const staged=await stage(workspace,{changes:[{operation:'insert',targetRef:target.documentRef,position:'end',content:'new'}]});vault.files[`Notes/${stale==='source'?'Source':'Target'}.md`]+='!';
      const result=await workspace.execute('commit_changes',{changeSetRef:staged.changeSetRef});expect(result.ok).toBe(false);expect(result.receipt?.status).toBe('conflict');expect(vault.writes).toBe(0);
    }
  });

  it('saves a durable backup before writes and returns a receipt when backup saving fails',async()=>{
    const vault=new DurableVault();vault.files={'Notes/A.md':'old'};vault.failSaveAt=1;const workspace=new NoteWorkspace(vault,vault,scope,{now:()=>now}),doc=(await discover(workspace,{paths:['Notes/A.md']})).documents[0];await read(workspace,{documentRef:doc.documentRef,mode:'document'});
    const staged=await stage(workspace,{changes:[{operation:'replace',targetRef:doc.documentRef,content:'new'}]}),result=await workspace.execute('commit_changes',{changeSetRef:staged.changeSetRef});
    expect(result.ok).toBe(false);expect(result.receipt).toMatchObject({status:'failed',changedFiles:[],undoAvailable:false});expect(vault.files['Notes/A.md']).toBe('old');expect(vault.writes).toBe(0);
  });

  it('reports actual partial writes, blocks later commits, and completes restart undo',async()=>{
    const vault=new DurableVault();vault.files={};vault.failWriteAt=2;const workspace=new NoteWorkspace(vault,vault,scope,{now:()=>now}),targets=(await discover(workspace,{dates:['2026-10-02','2026-10-03','2026-10-04']})).documents;
    const staged=await stage(workspace,{changes:targets.map((target,index)=>({operation:'insert',targetRef:target.documentRef,position:'end',content:`copy ${index}`}))}),result=await workspace.execute('commit_changes',{changeSetRef:staged.changeSetRef});
    expect(result.ok).toBe(false);expect(result.receipt).toMatchObject({status:'partial',changedFiles:['Daily/2026-10-02.md'],undoAvailable:true});expect(vault.undo?.writtenPaths).toEqual(['Daily/2026-10-02.md']);
    const blocked=await workspace.execute('commit_changes',{changeSetRef:staged.changeSetRef});expect(blocked.error).toContain('must be undone');
    vault.failWriteAt=undefined;const restarted=new NoteWorkspace(vault,vault,scope,{now:()=>now}),undone=await restarted.execute('undo_operation',{operationId:vault.undo!.operationId});expect(undone.ok).toBe(true);expect(vault.files['Daily/2026-10-02.md']).toBe('');expect(vault.undo).toBeNull();
  });

  it('durably resumes an interrupted undo after restart and blocks other commits until retry succeeds',async()=>{
    const vault=new DurableVault();vault.files={};const workspace=new NoteWorkspace(vault,vault,scope,{now:()=>now}),targets=(await discover(workspace,{dates:['2026-10-02','2026-10-03','2026-10-04']})).documents,staged=await stage(workspace,{changes:targets.map((target,index)=>({operation:'insert',targetRef:target.documentRef,position:'end',content:`copy ${index}`}))}),committed=await workspace.execute('commit_changes',{changeSetRef:staged.changeSetRef});
    vault.failWriteAt=vault.writes+2;const interrupted=await workspace.execute('undo_operation',{operationId:committed.receipt!.operationId});expect(interrupted.receipt).toMatchObject({status:'partial',changedFiles:['Daily/2026-10-02.md'],undoAvailable:true});expect(vault.undo?.status).toBe('partial');
    vault.failWriteAt=undefined;const restarted=new NoteWorkspace(vault,vault,scope,{now:()=>now}),other=(await discover(restarted,{paths:['Notes/Other.md']})).documents[0],otherStage=await stage(restarted,{changes:[{operation:'insert',targetRef:other.documentRef,position:'end',content:'blocked'}]}),blocked=await restarted.execute('commit_changes',{changeSetRef:otherStage.changeSetRef});expect(blocked.ok).toBe(false);expect(blocked.error).toContain('must be undone');expect(vault.files['Notes/Other.md']).toBeUndefined();
    const retried=await restarted.execute('undo_operation',{operationId:committed.receipt!.operationId});expect(retried.ok).toBe(true);for(const date of ['2026-10-02','2026-10-03','2026-10-04'])expect(vault.files[`Daily/${date}.md`]).toBe('');expect(vault.undo).toBeNull();
  });

  it('returns a partial receipt and keeps recovery when the final backup update fails',async()=>{
    const vault=new DurableVault();vault.files={'Notes/A.md':'old'};vault.failSaveAt=3;const workspace=new NoteWorkspace(vault,vault,scope,{now:()=>now}),doc=(await discover(workspace,{paths:['Notes/A.md']})).documents[0];await read(workspace,{documentRef:doc.documentRef,mode:'document'});
    const staged=await stage(workspace,{changes:[{operation:'replace',targetRef:doc.documentRef,content:'new'}]}),result=await workspace.execute('commit_changes',{changeSetRef:staged.changeSetRef});expect(result.receipt).toMatchObject({status:'partial',changedFiles:['Notes/A.md'],undoAvailable:true});expect(vault.undo).not.toBeNull();
  });

  it('enforces file, folder, dated-note, hidden-path, and undo scopes',async()=>{
    const vault=new DurableVault();vault.files={'Exact.md':'x','Notes/Inside.md':'y','.obsidian/private.md':'z','Daily/not-a-date.md':'n'};const narrow:AgentScope={files:['Exact.md'],folders:['Notes'],dailyFolder:'Daily'},workspace=new NoteWorkspace(vault,vault,narrow);
    expect((await workspace.execute('discover_notes',{paths:['Notes/Inside.md']})).ok).toBe(true);expect((await workspace.execute('discover_notes',{paths:['Exact.md']})).ok).toBe(true);
    for(const path of ['Other/X.md','.obsidian/private.md','Notes/.hidden.md','Daily/not-a-date.md'])expect((await workspace.execute('discover_notes',{paths:[path]})).ok).toBe(false);
    vault.undo={path:'Other/X.md',before:'a',after:'b',createdAt:'2026-10-01T00:00:00.000Z'};const restarted=new NoteWorkspace(vault,vault,narrow),undo=await restarted.execute('undo_operation',{operationId:'legacy_20261001T000000000Z'});expect(undo.ok).toBe(false);expect(undo.error).toContain('outside');
  });

  it('runs managed-area validation only for ordinary staging and keeps trusted external dependencies private',async()=>{
    const vault=new DurableVault();vault.files={'Notes/A.md':'old','Scheduler/Input.md':'dependency'};const checked:string[]=[];const workspace=new NoteWorkspace(vault,vault,scope,{now:()=>now,validateEdit:(path)=>{checked.push(path);throw new Error('managed area');}}),doc=(await discover(workspace,{paths:['Notes/A.md']})).documents[0];await read(workspace,{documentRef:doc.documentRef,mode:'document'});
    const ordinary=await workspace.execute('stage_note_changes',{changes:[{operation:'replace',targetRef:doc.documentRef,content:'ordinary'}]});expect(ordinary.ok).toBe(false);expect(checked).toEqual(['Notes/A.md']);
    const external=await workspace.stageExternalChanges({entries:[{path:'Notes/A.md',before:'old',after:'trusted'}],dependencies:{'Scheduler/Input.md':'dependency'},summary:'schedule'});expect(external).not.toHaveProperty('dependencies');expect(external).not.toHaveProperty('state');expect(checked).toHaveLength(1);
    const committed=await workspace.execute('commit_changes',{changeSetRef:external.changeSetRef});expect(committed.ok).toBe(true);expect(vault.files['Notes/A.md']).toBe('trusted');
  });

  it('runs preparation at stage and again at commit without mutating files or state on rejection',async()=>{
    const stageVault=new DurableVault();stageVault.files={'Notes/A.md':'old'};const stagePhases:string[]=[];const rejectedStage=new NoteWorkspace(stageVault,stageVault,scope,{prepareChanges:(_changes,phase)=>{stagePhases.push(phase);throw new Error('protected at stage');}}),stageDoc=(await discover(rejectedStage,{paths:['Notes/A.md']})).documents[0];await read(rejectedStage,{documentRef:stageDoc.documentRef,mode:'document'});
    const stageResult=await rejectedStage.execute('stage_note_changes',{changes:[{operation:'replace',targetRef:stageDoc.documentRef,content:'new'}]});expect(stageResult.ok).toBe(false);expect(stageResult.error).toContain('protected at stage');expect(stagePhases).toEqual(['stage']);expect(stageVault.files['Notes/A.md']).toBe('old');expect(stageVault.saveCount).toBe(0);

    const commitVault=new DurableVault();commitVault.files={'Notes/A.md':'old'};commitVault.aiTasks=[{id:'kept',title:'kept',path:'Notes/A.md',line:1,remaining:30,priority:3,split:true,min:30,completed:false}];const commitPhases:string[]=[];
    const rejectedCommit=new NoteWorkspace(commitVault,commitVault,scope,{prepareChanges:(changes,phase)=>{commitPhases.push(phase);if(phase==='commit')throw new Error('registered source would be orphaned');return changes;}}),commitDoc=(await discover(rejectedCommit,{paths:['Notes/A.md']})).documents[0];await read(rejectedCommit,{documentRef:commitDoc.documentRef,mode:'document'});const commitStage=await stage(rejectedCommit,{changes:[{operation:'replace',targetRef:commitDoc.documentRef,content:'new'}]});const tasksBefore=structuredClone(commitVault.aiTasks);
    const commitResult=await rejectedCommit.execute('commit_changes',{changeSetRef:commitStage.changeSetRef});expect(commitResult.ok).toBe(false);expect(commitResult.receipt).toMatchObject({status:'conflict',changedFiles:[],stateChanges:[],undoAvailable:false});expect(commitResult.error).toContain('registered source would be orphaned');expect(commitPhases).toEqual(['stage','commit']);expect(commitVault.files['Notes/A.md']).toBe('old');expect(commitVault.aiTasks).toEqual(tasksBefore);expect(commitVault.saveCount).toBe(0);expect(commitVault.writes).toBe(0);

    const externalVault=new DurableVault();externalVault.files={'Notes/A.md':'old'};const externalPhases:string[]=[];let validated=0;const externalWorkspace=new NoteWorkspace(externalVault,externalVault,scope,{prepareChanges:(changes,phase)=>{externalPhases.push(phase);return changes;}});const external=await externalWorkspace.stageExternalChanges({entries:[{path:'Notes/A.md',before:'old',after:'new'}],dependencies:{},summary:'external',validate:()=>{validated++;}});const externalCommit=await externalWorkspace.execute('commit_changes',{changeSetRef:external.changeSetRef});expect(externalCommit.ok).toBe(true);expect(externalPhases).toEqual(['stage','commit']);expect(validated).toBe(1);expect(externalVault.files['Notes/A.md']).toBe('new');
  });

  it('keeps the original state snapshot and checks dependencies added by preparation',async()=>{
    const vault=new DurableVault();vault.files={'Notes/A.md':'old','Notes/Guard.md':'guard'};const phases:string[]=[];const workspace=new NoteWorkspace(vault,vault,scope,{prepareChanges:(changes,phase)=>{phases.push(phase);return {...changes,dependencies:{...changes.dependencies,'Notes/Guard.md':'guard'},state:{...changes.state,aiTasks:[...(changes.state?.aiTasks??[])]}};}}),doc=(await discover(workspace,{paths:['Notes/A.md']})).documents[0];await read(workspace,{documentRef:doc.documentRef,mode:'document'});
    const staged=await stage(workspace,{changes:[{operation:'replace',targetRef:doc.documentRef,content:'new'}]});vault.files['Notes/Guard.md']='changed';const dependencyConflict=await workspace.execute('commit_changes',{changeSetRef:staged.changeSetRef});expect(dependencyConflict.receipt?.status).toBe('conflict');expect(dependencyConflict.error).toContain('Guard.md changed');expect(vault.files['Notes/A.md']).toBe('old');expect(phases).toEqual(['stage','commit']);

    const stateVault=new DurableVault();stateVault.files={'Notes/B.md':'old'};const stateWorkspace=new NoteWorkspace(stateVault,stateVault,scope,{prepareChanges:(changes)=>({...changes,state:{...changes.state,aiTasks:[...(changes.state?.aiTasks??[])]}})}),stateDoc=(await discover(stateWorkspace,{paths:['Notes/B.md']})).documents[0];await read(stateWorkspace,{documentRef:stateDoc.documentRef,mode:'document'});const stateStage=await stage(stateWorkspace,{changes:[{operation:'replace',targetRef:stateDoc.documentRef,content:'new'}]});stateVault.aiTasks=[{id:'later',title:'later',path:'Notes/B.md',line:1,remaining:30,priority:3,split:true,min:30,completed:false}];
    const stateConflict=await stateWorkspace.execute('commit_changes',{changeSetRef:stateStage.changeSetRef});expect(stateConflict.receipt?.status).toBe('conflict');expect(stateConflict.error).toContain('plugin state changed after staging');expect(stateVault.files['Notes/B.md']).toBe('old');expect(stateVault.aiTasks[0].id).toBe('later');
  });

  it('runs trusted pre-commit validation and makes post-write dependency drift recoverable',async()=>{
    const rejectedVault=new DurableVault();rejectedVault.files={'Notes/A.md':'old'};const rejected=new NoteWorkspace(rejectedVault,rejectedVault,scope,{now:()=>now});const invalid=await rejected.stageExternalChanges({entries:[{path:'Notes/A.md',before:'old',after:'new'}],dependencies:{},summary:'late schedule',validate:()=>{throw new Error('date changed');}}),failed=await rejected.execute('commit_changes',{changeSetRef:invalid.changeSetRef});expect(failed.receipt).toMatchObject({status:'conflict',changedFiles:[],undoAvailable:false});expect(rejectedVault.saveCount).toBe(0);expect(rejectedVault.writes).toBe(0);
    const vault=new DurableVault();vault.files={'Notes/A.md':'old','Notes/Source.md':'source'};vault.afterWrite=()=>{delete vault.files['Notes/Source.md'];};const workspace=new NoteWorkspace(vault,vault,scope,{now:()=>now});const linked:Task={id:'linked',title:'linked',path:'Notes/Source.md',line:1,remaining:30,priority:3,split:true,min:30,completed:false,sourceText:'source'};const staged=await workspace.stageExternalChanges({entries:[{path:'Notes/A.md',before:'old',after:'new'}],dependencies:{'Notes/Source.md':'source'},state:{aiTasks:[linked]},summary:'write'});
    const result=await workspace.execute('commit_changes',{changeSetRef:staged.changeSetRef});expect(result.ok).toBe(false);expect(result.error).toContain('dependency changed');expect(result.receipt).toMatchObject({status:'partial',changedFiles:['Notes/A.md'],stateChanges:['aiTasks'],undoAvailable:true});expect(vault.files['Notes/A.md']).toBe('new');expect(vault.files['Notes/Source.md']).toBeUndefined();expect(vault.aiTasks).toEqual([linked]);expect(vault.undo).toMatchObject({status:'partial',writtenPaths:['Notes/A.md']});
    const blocked=await workspace.execute('commit_changes',{changeSetRef:staged.changeSetRef});expect(blocked.ok).toBe(false);expect(blocked.error).toContain('must be undone');
    const undone=await workspace.execute('undo_operation',{operationId:result.receipt!.operationId});expect(undone.ok).toBe(true);expect(vault.files['Notes/A.md']).toBe('old');expect(vault.files['Notes/Source.md']).toBeUndefined();expect(vault.aiTasks).toEqual([]);expect(vault.undo).toBeNull();
  });

  it('treats a post-write dependency read failure as a partial operation',async()=>{
    class ReadFailureVault extends DurableVault { failDependencyRead=false;override async read(path:string):Promise<string|null>{if(this.failDependencyRead&&path==='Notes/Source.md')throw new Error('read unavailable');return super.read(path);}override async writeChecked(path:string,expected:string|null,next:string):Promise<void>{await super.writeChecked(path,expected,next);this.failDependencyRead=true;} }
    const vault=new ReadFailureVault();vault.files={'Notes/A.md':'old','Notes/Source.md':'source'};const workspace=new NoteWorkspace(vault,vault,scope,{now:()=>now}),staged=await workspace.stageExternalChanges({entries:[{path:'Notes/A.md',before:'old',after:'new'}],dependencies:{'Notes/Source.md':'source'},summary:'write'});
    const result=await workspace.execute('commit_changes',{changeSetRef:staged.changeSetRef});expect(result.ok).toBe(false);expect(result.error).toContain('Post-write dependency verification failed');expect(result.receipt).toMatchObject({status:'partial',changedFiles:['Notes/A.md'],undoAvailable:true});expect(vault.undo?.status).toBe('partial');
  });

  it('checks state versions captured at staging',async()=>{
    const vault=new DurableVault();vault.files={'Notes/A.md':'old'};const workspace=new NoteWorkspace(vault,vault,scope,{now:()=>now}),doc=(await discover(workspace,{paths:['Notes/A.md']})).documents[0];await read(workspace,{documentRef:doc.documentRef,mode:'document'});
    const staged=await stage(workspace,{changes:[{operation:'replace',targetRef:doc.documentRef,content:'new'}]});vault.tracking={'Daily/2026-10-01.md':{before:null,after:{visible:'x',annotated:'x'}}};
    const result=await workspace.execute('commit_changes',{changeSetRef:staged.changeSetRef});expect(result.receipt?.status).toBe('conflict');expect(vault.files['Notes/A.md']).toBe('old');
  });

  it('returns isolated host-only staged changes for one composed commit and rejects stale or partial stages',async()=>{
    const vault=new DurableVault();vault.files={'Notes/A.md':'old'};const workspace=new NoteWorkspace(vault,vault,scope),doc=(await discover(workspace,{paths:['Notes/A.md']})).documents[0];await read(workspace,{documentRef:doc.documentRef,mode:'document'});const staged=await stage(workspace,{summary:'generic edit',changes:[{operation:'replace',targetRef:doc.documentRef,content:'edited'}]});
    const snapshot=workspace.getStagedChanges(staged.changeSetRef);expect(snapshot).toEqual({entries:[{path:'Notes/A.md',before:'old',after:'edited'}],dependencies:{'Notes/A.md':'old'},summary:'generic edit'});expect(snapshot).not.toHaveProperty('validate');snapshot.entries[0].after='mutated';expect(workspace.getStagedChanges(staged.changeSetRef).entries[0].after).toBe('edited');expect(()=>workspace.getStagedChanges('unknown')).toThrow('Unknown');
    vault.tracking={'Daily/2026-10-01.md':{before:null,after:{visible:'x',annotated:'x'}}};expect(()=>workspace.getStagedChanges(staged.changeSetRef)).toThrow('state changed');vault.tracking={};
    vault.undo={path:'Notes/A.md',before:'old',after:'edited',entries:[{path:'Notes/A.md',before:'old',after:'edited'}],createdAt:now.toISOString(),operationId:'partial',status:'partial'};expect(()=>workspace.getStagedChanges(staged.changeSetRef)).toThrow('partial');
  });

  it('stores effective unchanged state snapshots so later state edits block undo',async()=>{
    const vault=new DurableVault();vault.files={'Notes/A.md':'old'};const workspace=new NoteWorkspace(vault,vault,scope,{now:()=>now}),doc=(await discover(workspace,{paths:['Notes/A.md']})).documents[0];await read(workspace,{documentRef:doc.documentRef,mode:'document'});
    const staged=await stage(workspace,{changes:[{operation:'replace',targetRef:doc.documentRef,content:'new'}]});const committed=await workspace.execute('commit_changes',{changeSetRef:staged.changeSetRef});vault.aiTasks=[{id:'later',title:'later',path:'Notes/A.md',line:1,remaining:30,priority:3,split:true,min:30,completed:false}];
    const undo=await workspace.execute('undo_operation',{operationId:committed.receipt!.operationId});expect(undo.ok).toBe(false);expect(undo.error).toContain('AI tasks changed');expect(vault.files['Notes/A.md']).toBe('new');
  });

  it('rejects undo after an unrelated tracking edit',async()=>{
    const vault=new DurableVault();vault.files={'Notes/A.md':'old'};const workspace=new NoteWorkspace(vault,vault,scope,{now:()=>now}),doc=(await discover(workspace,{paths:['Notes/A.md']})).documents[0];await read(workspace,{documentRef:doc.documentRef,mode:'document'});const staged=await stage(workspace,{changes:[{operation:'replace',targetRef:doc.documentRef,content:'new'}]}),committed=await workspace.execute('commit_changes',{changeSetRef:staged.changeSetRef});vault.tracking={'Daily/2026-10-01.md':{before:null,after:{visible:'manual',annotated:'manual'}}};
    const undo=await workspace.execute('undo_operation',{operationId:committed.receipt!.operationId});expect(undo.ok).toBe(false);expect(undo.error).toContain('Tracking changed');expect(vault.files['Notes/A.md']).toBe('new');
  });

  it('durably commits and undoes a zero-file state-only transaction',async()=>{
    const vault=new DurableVault();vault.files={'Notes/Source.md':'- [ ] linked task'};const workspace=new NoteWorkspace(vault,vault,scope,{now:()=>now});
    const next:Task={id:'ai_new',title:'linked task',path:'Notes/Source.md',line:1,remaining:60,priority:3,split:true,min:30,completed:false,sourceText:'- [ ] linked task'};
    const staged=await workspace.stageExternalChanges({entries:[],dependencies:{'Notes/Source.md':'- [ ] linked task'},state:{aiTasks:[next]},summary:'record unscheduled linked task'});
    expect(staged.changes).toEqual([]);const committed=await workspace.execute('commit_changes',{changeSetRef:staged.changeSetRef});
    expect(committed.receipt).toMatchObject({status:'committed',changedFiles:[],stateChanges:['aiTasks'],undoAvailable:true});expect(vault.writes).toBe(0);expect(vault.aiTasks).toEqual([next]);expect(vault.undo?.entries).toEqual([]);
    const restarted=new NoteWorkspace(vault,vault,scope,{now:()=>now}),undone=await restarted.execute('undo_operation',{operationId:vault.undo!.operationId});expect(undone.receipt).toMatchObject({status:'committed',changedFiles:[],stateChanges:['aiTasks']});expect(vault.aiTasks).toEqual([]);expect(vault.undo).toBeNull();
  });

  it('treats an identical zero-file state update as noop and preserves the previous undo journal',async()=>{
    const vault=new DurableVault();const current:Task={id:'ai_old',title:'same',path:'Notes/A.md',line:1,remaining:30,priority:3,split:true,min:30,completed:false};vault.aiTasks=[current];vault.undo={path:'Notes/A.md',before:'old',after:'new',createdAt:'2026-10-01T00:00:00.000Z',operationId:'previous',status:'committed'};const previous=structuredClone(vault.undo);
    const workspace=new NoteWorkspace(vault,vault,scope,{now:()=>now}),staged=await workspace.stageExternalChanges({entries:[],dependencies:{},state:{aiTasks:[current]},summary:'identical replan'}),result=await workspace.execute('commit_changes',{changeSetRef:staged.changeSetRef});
    expect(result.receipt).toMatchObject({status:'noop',changedFiles:[],stateChanges:[],undoAvailable:false});expect(vault.undo).toEqual(previous);expect(vault.saveCount).toBe(0);expect(vault.writes).toBe(0);
  });
});
