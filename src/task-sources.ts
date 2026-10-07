import { dayPlannerSection } from './daily';
import { parseMarkdownStructure } from './markdown-structure';
import type { ExternalChanges } from './agent-types';
import type { ResolvedNoteReference } from './note-workspace';
import type { StatePort, VaultPort } from './transaction';
import type { Task } from './types';

interface SourceBlock { start:number; text:string; fingerprint:string; status:NonNullable<Task['sourceStatus']> }
export function sourceFingerprint(text:string):string {
  return text.replace(/\r\n|\r/g,'\n').replace(/\n$/,'').replace(/^( {0,3}(?:[-+*]|\d+[.)])[ \t]+\[)[ xX-](\])/,'$1 $2');
}
function sourceStatus(text:string):NonNullable<Task['sourceStatus']> {
  const mark=/^ {0,3}(?:[-+*]|\d+[.)])[ \t]+\[([ xX-])\]/.exec(text)?.[1];
  return mark==='-'?'cancelled':mark?.toLowerCase()==='x'?'completed':'open';
}
function outsideCalendar(note:string):SourceBlock[] {
  const calendar=dayPlannerSection(note);
  return parseMarkdownStructure(note).blocks.filter(block=>!calendar||block.start<calendar.start||block.start>=calendar.end)
    .map(block=>{const text=note.slice(block.start,block.end);return {start:block.start,text,fingerprint:sourceFingerprint(text),status:sourceStatus(text)};});
}
function isUntimedTask(text:string):boolean {
  const match=/^ {0,3}(?:[-+*]|\d+[.)])[ \t]+\[[ xX-]\][ \t]+([^\r\n]+)/.exec(text);
  return !!match&&!/^\d{1,2}:\d{2}(?:\s|\s*[-–—])/.test(match[1]);
}
function taskBlocks(note:string):SourceBlock[] { return outsideCalendar(note).filter(block=>isUntimedTask(block.text)); }

/** Bind to a visible goal, never to a calendar session or to inferred heading names. */
export function bindTaskSource(source:ResolvedNoteReference,changeSetRef?:string|null):Pick<Task,'path'|'line'|'sourceText'|'sourceOccurrence'|'sourceCount'|'sourceStatus'|'completed'|'sourceRetired'|'sourceDetached'> {
  if(source.kind!=='block')throw Error('Task sourceRef must select a block returned by read_note');
  if(source.changeSetRef&&source.changeSetRef!==changeSetRef)throw Error('A staged task source must be composed with its exact changeSetRef');
  if(source.text.length>20_000)throw Error('Task source block exceeds the saved-source size budget');
  const blocks=taskBlocks(source.documentText),fingerprint=sourceFingerprint(source.text);
  const matches=blocks.filter(block=>block.fingerprint===fingerprint),occurrence=matches.findIndex(block=>block.start===source.start);
  if(occurrence<0)throw Error('A task requires an untimed checkbox source outside Day planner. Read or stage its persistent source before scheduling.');
  const status=matches[occurrence].status;
  return {path:source.path,line:0,sourceText:source.text,sourceOccurrence:occurrence,sourceCount:matches.length,sourceStatus:status,completed:status!=='open',sourceRetired:false,sourceDetached:false};
}

function matchSource(task:Task,note:string):SourceBlock|undefined {
  const matches=outsideCalendar(note).filter(block=>block.fingerprint===sourceFingerprint(task.sourceText!));
  if(task.sourceOccurrence!==undefined&&task.sourceCount!==undefined){
    if(matches.length!==task.sourceCount)return undefined;
    return matches[task.sourceOccurrence];
  }
  return matches.length===1?matches[0]:undefined;
}
function updateSource(task:Task,source:SourceBlock,path=task.path,count=task.sourceCount,occurrence=task.sourceOccurrence):Task {
  return {...task,path,sourceText:source.text,sourceStatus:source.status,completed:source.status!=='open',sourceDetached:false,
    ...(count!==undefined?{sourceCount:count,sourceOccurrence:occurrence}:{}),...(source.status!=='open'?{needsReview:false}:{})};
}

/** Explicit note edits are authoritative; obsolete source bindings never lock a note. */
export function prepareEditableTaskChanges(changes:ExternalChanges,state:StatePort):ExternalChanges {
  const proposed=changes.state?.aiTasks??state.getAiTasks?.()??[],entries=new Map(changes.entries.map(entry=>[entry.path,entry]));
  const updated=proposed.map(task=>{
    if(!task.sourceText||!entries.has(task.path))return task;
    const entry=entries.get(task.path)!;
    try{
      const found=matchSource(task,entry.after);
      if(found)return updateSource(task,found);
      const fingerprint=sourceFingerprint(task.sourceText);
      const prior=matchSource(task,entry.before??'');
      const moved=changes.entries.flatMap(candidate=>{
        const before=taskBlocks(candidate.before??'').filter(block=>block.fingerprint===fingerprint);
        const after=taskBlocks(candidate.after).filter(block=>block.fingerprint===fingerprint);
        return before.length===0&&after.length===1?[{path:candidate.path,block:after[0]}]:[];
      });
      if(prior&&!taskBlocks(entry.after).some(block=>block.fingerprint===fingerprint)&&moved.length===1)return updateSource(task,moved[0].block,moved[0].path,1,0);
      const status=prior?.status??task.sourceStatus??(task.completed?'completed':'open');
      if(status!=='open')return {...task,sourceStatus:status,completed:true,needsReview:false,sourceRetired:true,sourceDetached:false,sourceText:undefined,sourceOccurrence:undefined,sourceCount:undefined};
    }catch{ /* Ambiguous or edited structures detach; their bytes remain editable. */ }
    return {...task,sourceText:undefined,sourceOccurrence:undefined,sourceCount:undefined,sourceRetired:false,sourceDetached:true,sourceStatus:'open' as const,completed:false,needsReview:true};
  });
  return JSON.stringify(updated)===JSON.stringify(proposed)?changes:{...changes,state:{...changes.state,aiTasks:updated}};
}

/** Scheduling must conserve every still-bound source; explicit note edits may detach it. */
export async function prepareTaskChanges(changes:ExternalChanges,phase:'stage'|'commit',vault:VaultPort,state:StatePort):Promise<ExternalChanges> {
  const before=state.getAiTasks?.()??[],oldById=new Map(before.map(task=>[task.id,task]));
  const proposed=changes.state?.aiTasks??before,entries=new Map(changes.entries.map(entry=>[entry.path,entry]));
  const dependencies={...changes.dependencies};
  const document=async(path:string):Promise<string>=>{
    const entry=entries.get(path);if(entry)return entry.after;
    if(Object.prototype.hasOwnProperty.call(dependencies,path))return dependencies[path]??'';
    const text=await vault.read(path);dependencies[path]=text;return text??'';
  };
  const updated:Task[]=[];
  for(const task of proposed){
    const old=oldById.get(task.id);
    if(!task.sourceText){
      if(!old)throw Error('New schedule tasks require a visible persistent source');
      updated.push(task);continue;
    }
    const rebound=!old||old.path!==task.path||old.sourceText!==task.sourceText||old.sourceOccurrence!==task.sourceOccurrence||old.sourceCount!==task.sourceCount;
    const changedIdentity=old?.sourceText&&(old.path!==task.path||sourceFingerprint(old.sourceText)!==sourceFingerprint(task.sourceText)||
      (old.sourceOccurrence!==undefined&&old.sourceOccurrence!==task.sourceOccurrence));
    if(changedIdentity){
      const original=matchSource(old,await document(old.path));
      if(original?.status==='open')throw Error('The existing open task source still exists. Stage its rename or move before rebinding; another source must not inherit this task history.');
    }
    if(!rebound&&!entries.has(task.path)){updated.push(task);continue;}
    const text=await document(task.path),found=matchSource(task,text);
    if(found){updated.push(updateSource(task,found));continue;}
    if(!rebound){
      const moved=changes.entries.filter(entry=>!outsideCalendar(entry.before??'').some(block=>block.fingerprint===sourceFingerprint(task.sourceText!)))
        .flatMap(entry=>outsideCalendar(entry.after).filter(block=>block.fingerprint===sourceFingerprint(task.sourceText!)).map(block=>({entry,block})));
      if(moved.length===1){updated.push(updateSource(task,moved[0].block,moved[0].entry.path,1,0));continue;}
      const previous=entries.get(task.path)?.before;
      const previousStatus=previous?matchSource(task,previous)?.status:task.sourceStatus;
      if(previousStatus==='completed'||previousStatus==='cancelled'){updated.push({...task,sourceStatus:previousStatus,completed:true,needsReview:false,sourceRetired:true,sourceText:undefined,sourceOccurrence:undefined,sourceCount:undefined});continue;}
    }
    if(phase==='stage'&&old&&!rebound){updated.push(task);continue;}
    throw Error(`Persistent task source is missing or ambiguous: ${task.title}. Keep it outside Day planner; read the edited source and use bind_task_source to rebind it before committing.`);
  }
  for(const old of before)if(old.sourceText&&!old.completed&&!proposed.some(task=>task.id===old.id))throw Error(`An open task cannot be removed from schedule state: ${old.title}`);
  const bindings=new Map<string,Task>();
  for(const task of updated){
    if(!task.sourceText)continue;
    const key=JSON.stringify([task.path,sourceFingerprint(task.sourceText),task.sourceOccurrence??null]);
    const other=bindings.get(key);
    if(other){
      const unchanged=(candidate:Task)=>{const original=oldById.get(candidate.id);return original&&original.path===candidate.path&&original.sourceText===candidate.sourceText&&original.sourceOccurrence===candidate.sourceOccurrence;};
      // Legacy ambiguous bindings can be read and repaired. A new/rebound pair
      // must never share the same occurrence.
      if(!unchanged(task)||!unchanged(other))throw Error('A source is already bound to another task. Keep separate source occurrences or use the existing task ID.');
    }
    bindings.set(key,task);
  }
  const changed=JSON.stringify(updated)!==JSON.stringify(proposed);
  return {...changes,dependencies,...(changes.state||changed?{state:{...changes.state,...(changes.state?.aiTasks||changed?{aiTasks:updated}:{})}}:{})};
}

export function goalSummary(task:Task):Record<string,unknown> {
  const unknown=task.effort==='unknown'||!!task.rollingMinutes;
  return {id:task.id,title:task.title,sourcePath:task.path,sourceBound:!!task.sourceText,sourceRetired:task.sourceRetired??false,sourceDetached:task.sourceDetached??false,sourceStatus:task.sourceStatus??(task.completed?'completed':'open'),effort:unknown?'unknown':'known',
    totalMinutes:unknown?null:task.remaining,completedMinutes:task.completedMinutes??0,remainingEstimateMinutes:unknown?null:Math.max(0,task.remaining-(task.completedMinutes??0)),
    sessionBudgetMinutes:unknown?task.rollingMinutes??task.remaining:null,dailyMinutes:task.dailyMinutes??null,priority:task.priority,estimateBasis:task.estimateBasis??null,
    status:task.sourceStatus==='cancelled'?'cancelled':task.completed?'completed':task.needsReview?'needs-review':'active'};
}
