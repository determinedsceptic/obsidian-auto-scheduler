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
  const lines = ['已写入每日笔记：'];
  for (const block of blocks) lines.push(`• ${block.date} ${clock(block.start)}–${endClock(block)}：${block.title}（重要性 ${block.priority ?? 3}/5）`);
  const pending = preview.result.unscheduled.filter(t => created.has(t.taskId));
  if (pending.length) {
    lines.push('', '尚未安排（任务已保存，可稍后重排）：');
    for (const task of pending) lines.push(`• ${task.title}：剩余 ${task.remaining} 分钟，${task.reason}`);
  }
  if (preview.diff.removed.length) lines.push('', `已有排程同时重新安排，替换了 ${preview.diff.removed.length} 个工作块。`);
  if (preview.snapshot[preview.settings.fixedFile] === null) lines.push('', '固定日程文件不存在，本次按无固定日程安排。');
  if (warning) lines.push('', `请检查写入结果：${warning}`);
  lines.push('', '需要恢复时，运行“撤销最近一次排程”。');
  return { text: lines.join('\n'), notes };
}
