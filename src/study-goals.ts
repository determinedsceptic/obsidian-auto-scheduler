import { appendTaskRows, taskSection } from './daily';
import { visibleLines } from './parser';
import { displayTitle, prioritySymbol } from './output';
import { deadlineLabel, calendarDate, calendarPriority } from './calendar-format';
import type { Task } from './types';
export function studyGoal(text:string, task:Task):{line:string;completed:boolean}|undefined {
  const section=taskSection(text);if(!section)return undefined;
  const matches=visibleLines(text.slice(section.start,section.end)).map(row=>row.text).filter(line=>/^[-*+] \[[ xX]\] /.test(line)&&displayTitle(line.replace(/^[-*+] \[[ xX]\] /,''))===task.title);
  if(matches.length>1)throw Error('Duplicate study goal; merge the Tasks entries before replanning');
  return matches.length?{line:matches[0],completed:/^[-*+] \[[xX]\]/.test(matches[0])}:undefined;
}
export function ensureStudyGoal(text:string,task:Task,previous?:Task):string {
  const existing=studyGoal(text,previous??task);
  if(existing&&previous&&(calendarDate(existing.line,'due')!==previous.due||calendarPriority(existing.line)!==previous.priority))throw Error('Study goal priority or deadline was edited; reconcile its constraints before replanning');
  const row=`- [${existing?.completed?'x':' '}] ${prioritySymbol(task.priority)} ${task.title}${task.due===undefined?'':` 📅 ${deadlineLabel(task.due)}`}`;
  if(existing){if(existing.completed)return text;return text.replace(existing.line,row);}
  if(previous?.rollingMinutes)throw Error('Study goal was renamed or removed from Tasks; restore it before replanning');
  const output=appendTaskRows(text,[row]);
  if(!studyGoal(output,task))throw Error('A code fence would hide the study goal. Close it before scheduling');
  return output;
}
