import { deadlineLabel } from './calendar-format';
import type { Preview } from './transaction';
import { clock } from './time';
import { endClock } from './output';

export interface ScheduledNote { date: string; path: string }
export interface AiScheduleReply { text: string; notes: ScheduledNote[] }

/** Describe committed host output, never a model's proposed dates or times. */
export function describeAiSchedule(preview: Preview, warning?: string): AiScheduleReply {
  const previous = new Set(preview.aiTasksBefore.map(t => t.id));
  const created = new Set(preview.aiTasksAfter.filter(t => !previous.has(t.id)).map(t => t.id));
  const blocks = preview.result.blocks.filter(b => created.has(b.taskId)).sort((a, b) => a.start - b.start || a.taskId.localeCompare(b.taskId));
  const notes: ScheduledNote[] = [...new Set(blocks.map(b => b.date))].map(date => ({ date, path: `${preview.settings.dailyFolder}/${date}.md` }));
  const lines = ['Saved to daily notes:'];
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
