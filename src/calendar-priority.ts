import { calendarTitle, dailyDocument, dailyInputs, isFlexibleDailyRow } from './daily';
import { expandHabits, isHabit } from './habits';
import type { Habit } from './habits';
import { overlap } from './time';
import { reserveEvent } from './event-tool';
import { endClock } from './output';
import { calendarDate } from './calendar-format';
import { atDate, dateKey } from './time';
import type { Block, Interval, Settings } from './types';

export interface FlexibleCalendarRow extends Interval { path:string; raw:string }

/** Recover declared provenance, never infer certainty from an activity's title. */
export function prepareCalendarPriority(
  virtual:Record<string,string|null>, targets:string[], habits:Habit[], today:string,
  fixed:Interval[], settings:Settings, references:FlexibleCalendarRow[] = [],
):{adopted:Record<string,Block[]>;notes:string[]} {
  const adopted:Record<string,Block[]>={}, notes:string[]=[];
  if(new Set(references.map(ref=>JSON.stringify([ref.path,ref.start,ref.end,ref.raw]))).size!==references.length)throw Error('A flexible calendar row cannot be referenced twice');
  for(const path of new Set(references.map(ref=>ref.path))){
    if(!targets.includes(path))throw Error('Flexible calendar references must be in the current scheduling horizon');
    const rows=dailyInputs(path,virtual[path],settings.defaultEventDuration).rows;
    const edits:Array<{start:number;end:number;text:string}>=[];
    for(const ref of references.filter(ref=>ref.path===path)){
      const matches=rows.filter(row=>row.raw===ref.raw&&row.start===ref.start&&row.end===ref.end);
      if(matches.length!==1)throw Error('The flexible calendar row changed or is ambiguous; read it again');
      const row=matches[0];
      if(!row.checkbox||row.completed||!row.standalone||!row.body||row.reminder===null||row.beforeMinutes!==undefined)throw Error('Only a standalone unchecked clock plan without additional timed calendar fields can be declared flexible');
      if(!row.flexible)edits.push({start:row.sourceStart,end:row.sourceEnd,text:row.raw+' <!-- as-flexible -->'+(virtual[path]!.slice(row.sourceStart,row.sourceEnd).endsWith('\n')?(virtual[path]!.includes('\r\n')?'\r\n':'\n'):'')});
    }
    for(const edit of edits.sort((a,b)=>b.start-a.start))virtual[path]=virtual[path]!.slice(0,edit.start)+edit.text+virtual[path]!.slice(edit.end);
  }
  const occurrences=expandHabits(habits,[],today).blocks;
  const existing=targets.flatMap(path=>dailyDocument(virtual[path]).blocks);
  const existingIds=new Set(existing.map(block=>block.taskId));
  const matches:Array<{path:string;row:ReturnType<typeof dailyInputs>['rows'][number];block:Block}>=[];
  const rowsByPath=new Map(targets.map(path=>[path,dailyInputs(path,virtual[path],settings.defaultEventDuration).rows]));
  for(const [path,rows] of rowsByPath)for(const row of rows){
    if(!row.checkbox||!row.standalone||row.reminder===null||row.beforeMinutes!==undefined||row.flexible||! /^- \[[ xX]\] /.test(row.raw)||/<!--\s*(?:as|as-block)\s|%%\[(?:as|as-block)::/.test(row.raw))continue;
    const candidates=occurrences.filter(block=>row.start===block.start&&row.end===block.end&&row.title===calendarTitle(block.title));
    if(candidates.length===1&&!existingIds.has(candidates[0].taskId)){
      const block={...candidates[0],completed:row.completed},link=block.path.replace(/\.md$/,'');
      if(/[\[\]|\r\n]/.test(link))continue;
      // Extra work constraints are not declared habit provenance. Contradictory
      // occurrence dates must not be hidden during clean rendering.
      if(calendarDate(row.raw,'start')!==undefined||calendarDate(row.raw,'due')!==undefined)continue;
      const occurrenceDate=calendarDate(row.raw,'scheduled');
      if(occurrenceDate!==undefined&&dateKey(atDate(occurrenceDate))!==block.date)continue;
      const scheduled=[...row.raw.matchAll(/\[scheduled::\s*(\d{4}-\d{2}-\d{2})\]/g)];
      const anyScheduled=[...row.raw.matchAll(/\[scheduled::[^\]]+\]/gi)];
      const emojiScheduled=[...row.raw.matchAll(/⏳\s*\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?/gu)];
      if(anyScheduled.length+emojiScheduled.length>1||anyScheduled.length!==scheduled.length||(scheduled.length===1&&(scheduled[0][1]!==block.date||scheduled[0][0]!==`[scheduled:: ${block.date}]`)))continue;
      // Preserve the original checkbox, title, comments and completion date.
      // Only add the host's provenance needed for tracking and later plans.
      const raw=row.raw.replace(/^(- \[[ xX]\] \d{2}:\d{2})(?!\s*-\s*\d{2}:\d{2})(\s+)/,`$1 - ${endClock(block)}$2`);
      block.raw=`${raw} [[${link}]]${scheduled.length?'':` [scheduled:: ${block.date}]`} <!-- as-block id=${block.id} task=${block.taskId} locked=${block.locked} -->`;
      matches.push({path,row,block});
    }
  }
  // Duplicate visible occurrences have no unique provenance; leave them hard.
  const counts=new Map<string,number>();for(const match of matches)counts.set(match.block.taskId,(counts.get(match.block.taskId)??0)+1);
  const unique=matches.filter(match=>counts.get(match.block.taskId)===1);
  const adoptedRows=new Set(unique.map(match=>match.row));
  const hard=[...fixed,...[...rowsByPath.values()].flat().filter(row=>!adoptedRows.has(row)&&!isFlexibleDailyRow(row)),
    ...existing.filter(block=>block.completed||(block.locked&&!isHabit(block.taskId))).map(block=>({start:block.start,end:block.end,beforeMinutes:0,afterMinutes:settings.blockBuffer})),
    ...unique.filter(match=>match.block.completed).map(match=>({start:match.block.start,end:match.block.end,beforeMinutes:0,afterMinutes:settings.blockBuffer}))];
  const reserved=hard.map(interval=>reserveEvent(interval,settings.fixedBuffer));
  for(const [path,rows] of rowsByPath){
    const edits:Array<{start:number;end:number;text:string}>=[];
    for(const match of unique.filter(match=>match.path===path)){
      (adopted[path]??=[]).push(match.block);
      edits.push({start:match.row.sourceStart,end:match.row.sourceEnd,text:''});
    }
    for(const row of rows){
      if(!isFlexibleDailyRow(row)||row.reminder===null||!reserved.some(interval=>overlap(row,interval)))continue;
      const newline=virtual[path]!.slice(row.sourceStart,row.sourceEnd).endsWith('\n')?(virtual[path]!.includes('\r\n')?'\r\n':'\n'):'';
      // Release only the time reservation. Keep the original activity visible.
      edits.push({start:row.sourceStart,end:row.sourceEnd,text:row.reminder+newline});
      notes.push(`${path}: released the flexible time reservation for ${row.title}; its unchecked reminder remains`);
    }
    for(const edit of edits.sort((a,b)=>b.start-a.start))virtual[path]=virtual[path]!.slice(0,edit.start)+edit.text+virtual[path]!.slice(edit.end);
  }
  return {adopted,notes};
}
