import { deadlineLabel } from './calendar-format';
import type { Preview } from './transaction';
import { clock, dateKey, workWindows } from './time';
import { endClock } from './output';

export interface ScheduledNote { date: string; path: string }
export interface AiScheduleReply { text: string; notes: ScheduledNote[] }

/** Explain project pace and why an unconstrained task could not start today. */
export function planningDetails(preview:Preview,ids:Set<string>,now=new Date()):string[]{
  const lines:string[]=[];
  for(const task of preview.aiTasksAfter.filter(t=>ids.has(t.id))){
    if(task.rollingMinutes)lines.push(`${task.title}: rolling seven-day study budget ${task.rollingMinutes} min, up to ${task.dailyMinutes} min/day. Total effort and finish date remain unknown. Completing sessions does not finish the Tasks goal; review progress and replan to continue.`);
    else if(task.estimateBasis)lines.push(`${task.title}: estimated total ${task.remaining} min; ${task.estimateBasis}${task.dailyMinutes?`; up to ${task.dailyMinutes} min/day (about ${Math.ceil(task.remaining/task.dailyMinutes)} study days before accounting for completed work)`:''}.`);
  }
  const today=dateKey(now);
  if(preview.result.blocks.some(b=>ids.has(b.taskId)&&!b.completed)&&!preview.result.blocks.some(b=>ids.has(b.taskId)&&!b.completed&&b.date===today)&&preview.aiTasksAfter.some(t=>ids.has(t.id)&&(t.earliest===undefined||t.earliest<(new Date(`${today}T23:59:59`).getTime()/60000)))){
    const windows=workWindows(today,preview.settings);
    lines.push(!windows.length?'No session today: today is outside the configured working days.':windows.every(w=>w.end<=now.getTime()/60000)?'No session today: the configured working hours have ended.':preview.settings.balanceLoad?'Seven-day load balancing assigned later feasible slots after comparing today’s remaining gaps, existing commitments and task constraints.':'No feasible session remains today within the working hours, existing commitments, capacity, minimum block and buffer constraints.');
  }
  return lines;
}

/** Describe committed host output, never a model's proposed dates or times. */
export function describeAiSchedule(preview: Preview, warning?: string): AiScheduleReply {
  const previous = new Set(preview.aiTasksBefore.map(t => t.id));
  const created = new Set(preview.aiTasksAfter.filter(t => !previous.has(t.id)).map(t => t.id));
  const blocks = preview.result.blocks.filter(b => created.has(b.taskId)).sort((a, b) => a.start - b.start || a.taskId.localeCompare(b.taskId));
  const notes: ScheduledNote[] = [...new Set(blocks.map(b => b.date))].map(date => ({ date, path: `${preview.settings.dailyFolder}/${date}.md` }));
  const lines = [...planningDetails(preview,created), 'Saved to daily notes:'];
  for (const block of blocks) lines.push(`• ${block.date} ${clock(block.start)}–${endClock(block)}: ${block.title} (priority ${block.priority ?? 3}/5)${preview.aiTasksAfter.find(t=>t.id===block.taskId)?.due === undefined ? '' : `; deadline ${deadlineLabel(preview.aiTasksAfter.find(t=>t.id===block.taskId)!.due!)}`}`);
  const pending = preview.result.unscheduled.filter(t => created.has(t.taskId));
  if (pending.length) {
    lines.push('', 'Not yet scheduled (saved for a later replan):');
    for (const task of pending) lines.push(`• ${task.title}: remaining ${task.remaining} min, ${task.reason}`);
  }
  if (preview.diff.removed.length) lines.push('', `Existing work was replanned, replacing ${preview.diff.removed.length} time blocks.`);
  if (preview.snapshot[preview.settings.fixedFile] === null) lines.push('', 'No fixed-events file was found; scheduling used no events from that file.');
  if (warning) lines.push('', `Review the saved schedule: ${warning}`);
  lines.push('', 'To restore the previous schedule, run Undo last schedule.');
  return { text: lines.join('\n'), notes };
}
