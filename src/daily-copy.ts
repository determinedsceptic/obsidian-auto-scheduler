import { appendTaskRows, taskSection } from './daily';
import { visibleLines } from './parser';
import { addDays, dateKey, localMinute, safeVaultPath } from './time';
import type { DailySnapshot } from './daily-edit';
import type { Settings, Task, Tracking, FileChange, UndoRecord } from './types';
import type { VaultPort, StatePort } from './transaction';

export interface DailyCopy { date:string; targetDates:string[]; refs:string[] }
export const copyDailyTool = { name:'copy_daily_tasks', description:'Copy selected unfinished checkbox rows from the Tasks section of a previously read daily note into Tasks on each target date. Keep the source unchanged. Do not allocate time blocks, move tasks, copy Day planner sessions, or replan. For the next seven days use tomorrow through today + 7.', strict:true,
 parameters:{type:'object',additionalProperties:false,properties:{date:{type:'string'},targetDates:{type:'array',items:{type:'string'},minItems:1,maxItems:7},refs:{type:'array',items:{type:'string'},minItems:1,maxItems:100}},required:['date','targetDates','refs']} };
export function validateDailyCopy(value:unknown):DailyCopy {
 const args=value as DailyCopy;
 if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).sort().join(',')!=='date,refs,targetDates'||typeof args.date!=='string')throw Error('Invalid task copy arguments');
 localMinute(args.date,'00:00');
 for(const [items,max] of [[args.targetDates,7],[args.refs,100]] as const)if(!Array.isArray(items)||!items.length||items.length>max||items.some(x=>typeof x!=='string')||new Set(items).size!==items.length)throw Error('Invalid task copy dates or references');
 for(const date of args.targetDates)localMinute(date,'00:00');
 return args;
}
/** Copy literal task rows in one durable undo transaction, without invoking the scheduler. */
export async function copyDailyTasks(vault:VaultPort,state:StatePort,settings:Settings,tracking:Tracking,aiTasks:Task[],read:DailySnapshot,request:DailyCopy,now:Date):Promise<{dates:string[];count:number;changed:boolean}> {
 const args=validateDailyCopy(request),today=dateKey(now);
 if(args.date!==read.read.date||read.path!==`${settings.dailyFolder}/${args.date}.md`)throw Error('Read the source daily note before copying its Tasks');
 if(JSON.stringify(read.aiTasks)!==JSON.stringify(aiTasks)||JSON.stringify(read.tracking)!==JSON.stringify(tracking))throw Error('Task state changed since reading. Read again.');
 if(args.targetDates.some(date=>date<=today||date>addDays(today,7)||date===args.date))throw Error('Copy targets must be tomorrow through the following seven days');
 const rows=args.refs.map(ref=>{const row=read.taskRows?.[ref];if(!row||!/^[-*+] \[ \] /.test(row))throw Error('Only read, unfinished standalone Tasks rows can be copied');return row;});
 const snapshot:Record<string,string|null>={[read.path]:read.original};const entries:FileChange[]=[];
 for(const date of args.targetDates){
  const path=`${settings.dailyFolder}/${date}.md`;if(!safeVaultPath(path))throw Error('Invalid daily-note path');
  const before=await vault.read(path);snapshot[path]=before;
  const text=before??'',part=taskSection(text);
  const existing=new Set(part?visibleLines(text.slice(part.start,part.end)).map(l=>l.text):[]);
  const additions=rows.filter((row,i)=>!existing.has(row)&&rows.indexOf(row)===i);
  const after=appendTaskRows(text,additions);
  if(after!==text){
   const section=taskSection(after)!;
   const visible=new Set(visibleLines(after.slice(section.start,section.end)).map(l=>l.text));
   if(additions.some(row=>!visible.has(row)))throw Error('A code fence would hide copied tasks. Close it before copying.');
   entries.push({path,before,after,restored:'',trackingBefore:tracking[path]?.after??null,trackingAfter:tracking[path]?.after??null});
  }
 }
 for(const [path,before] of Object.entries(snapshot))if(await vault.read(path)!==before)throw Error('Source or destination changed. Read again before copying.');
 if(state.getAiTasks&&JSON.stringify(state.getAiTasks())!==JSON.stringify(aiTasks)||state.getTracking&&JSON.stringify(state.getTracking())!==JSON.stringify(tracking))throw Error('Task state changed before copying');
 if(!entries.length)return {dates:args.targetDates,count:rows.length,changed:false};
 const undo:UndoRecord={...entries[0],entries,createdAt:now.toISOString(),aiTasksBefore:structuredClone(aiTasks),aiTasksAfter:structuredClone(aiTasks)};
 await state.saveUndo(undo,tracking,aiTasks);
 // Recheck the source after saving the backup; later target changes fail compare-and-write.
 if(await vault.read(read.path)!==read.original)throw Error('Source changed before copying; no task rows were written');
 for(const entry of entries)await vault.writeChecked(entry.path,entry.before,entry.after);
 return {dates:args.targetDates,count:rows.length,changed:true};
}
