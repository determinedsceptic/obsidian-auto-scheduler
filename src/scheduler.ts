import { addDays, assertStableWeek, atDate, dateKey, epochMinute, gaps, GRID, localMinute, merge, overlap, clipped, total, validateSettings, workWindows } from './time';
import type { Block, Diagnostic, Interval, ScheduleResult, Settings, Task } from './types';
const compareText = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
export function schedule(tasks: Task[], fixed: Interval[], previous: Block[], settings: Settings, now: Date, dayCount = 7): ScheduleResult {
  const errors: Diagnostic[] = validateSettings(settings).map(message => ({ path: 'settings', line: 0, message }));
  const result: ScheduleResult = { blocks: [], unscheduled: [], days: [], errors };
  if (errors.length) return result;
  const today = dateKey(now); const until = addDays(today, dayCount); const nowMinute = epochMinute(now);
  try { assertStableWeek(today); } catch (error) { errors.push({ path: 'timezone', line: 0, message: (error as Error).message }); return result; }
  const inRange = (block: Block): boolean => block.date >= today && block.date < until;
  const protectedBlocks = previous.filter(b => inRange(b) && (b.locked || b.completed));
  const taskMap = new Map(tasks.map(t => [t.id, t]));
  const lockedMinutes = new Map<string, number>();
  const bufferedFixed = merge(fixed.map(i => ({ start: i.start - settings.fixedBuffer, end: i.end + settings.fixedBuffer })));
  for (const block of protectedBlocks) {
    const fail = (message: string): void => { errors.push({ path: settings.outputFile, line: 0, message: `块 ${block.id}：${message}` }); };
    if (!taskMap.has(block.taskId)) fail('引用未知任务 ID');
    if (block.start % GRID || block.end % GRID) fail('锁定块需在 15 分钟网格上');
    if (bufferedFixed.some(i => overlap(block, i))) fail('与固定日程或其缓冲冲突');
    const task = taskMap.get(block.taskId);
    if (task && !task.completed && ((task.earliest !== undefined && block.start < task.earliest) || (task.due !== undefined && block.end > task.due))) fail('违反任务 earliest/due 约束');
    lockedMinutes.set(block.taskId, (lockedMinutes.get(block.taskId) ?? 0) + block.end - block.start);
  }
  for (let i = 0; i < protectedBlocks.length; i++) for (let j = i + 1; j < protectedBlocks.length; j++) {
    const a = protectedBlocks[i], b = protectedBlocks[j];
    if (overlap({ start: a.start, end: a.end + settings.blockBuffer }, { start: b.start, end: b.end + settings.blockBuffer })) errors.push({ path: settings.outputFile, line: 0, message: `锁定块或缓冲冲突：${a.id} / ${b.id}` });
  }
  for (const task of tasks) {
    const minutes = lockedMinutes.get(task.id) ?? 0;
    if (!task.completed && minutes > task.remaining) errors.push({ path: task.path, line: task.line, message: `锁定时间超过剩余用时：${task.id}` });
    if (!task.completed && !task.split && protectedBlocks.filter(b => b.taskId === task.id).length > 1) errors.push({ path: task.path, line: task.line, message: `不可拆分任务不能具有多个锁定块：${task.id}` });
    if (!task.completed && !task.split && minutes > 0 && minutes !== task.remaining) errors.push({ path: task.path, line: task.line, message: `不可拆分任务的锁定块必须覆盖全部剩余时间：${task.id}` });
  }
  if (errors.length) return result;
  result.blocks = [...previous.filter(b => !inRange(b)), ...protectedBlocks];
  const days = Array.from({ length: dayCount }, (_, i) => {
    const date = addDays(today, i); const windows = workWindows(date, settings);
    const occupied = merge([...bufferedFixed, ...protectedBlocks.map(b => ({ start: b.start, end: b.end + settings.blockBuffer }))]);
    return { date, windows, occupied };
  });
  const ordered = tasks.filter(t => !t.completed).sort((a, b) => b.priority - a.priority || (a.due ?? Infinity) - (b.due ?? Infinity) || (a.earliest ?? -Infinity) - (b.earliest ?? -Infinity) || compareText(a.id, b.id));
  for (const task of ordered) {
    let remaining = task.remaining - (lockedMinutes.get(task.id) ?? 0);
    if (!remaining) continue;
    let reason = '可行时间或每日容量不足';
    if (task.due !== undefined && task.due <= nowMinute) reason = '截止已过';
    else if (task.earliest !== undefined && task.earliest >= localMinute(until, '00:00')) reason = '最早开始时间在排程范围外';
    else {
      let largestGap = 0;
      for (const day of days) {
        if (!remaining) break;
        for (const window of day.windows) {
          if (!remaining) break;
          const available: Interval = { start: Math.max(window.start, nowMinute, task.earliest ?? -Infinity), end: Math.min(window.end, task.due ?? Infinity) };
          for (const gap of gaps(available, day.occupied)) {
            if (!remaining) break;
            // Round by local clock, including zones whose UTC offset is not a whole hour.
            const local = atDate(gap.start); const minuteOfDay = local.getHours() * 60 + local.getMinutes() + local.getSeconds() / 60 + local.getMilliseconds() / 60000;
            const start = gap.start + (Math.ceil(minuteOfDay / GRID) * GRID - minuteOfDay);
            const max = Math.floor((gap.end - start) / GRID) * GRID;
            largestGap = Math.max(largestGap, max);
            const lower = task.split ? task.min : remaining;
            let length = Math.min(remaining, max);
            if (!task.split && length !== remaining) continue;
            while (length >= lower) {
              const tail = remaining - length;
              const occupancy = { start, end: start + length + settings.blockBuffer };
              // Reserve a full trailing buffer in the work window; the last buffer may end at its boundary.
              if ((!task.split || !tail || tail >= task.min) && occupancy.end <= gap.end && total(clipped([...day.occupied, occupancy], day.windows)) <= settings.dailyCapacity) break;
              length -= GRID;
            }
            if (length < lower) continue;
            const end = start + length;
            const block: Block = { id: `b_${task.id}_${day.date.replace(/-/g, '')}_${Math.round(start)}_${length}`, taskId: task.id, date: day.date, start, end, title: task.title, path: task.path, locked: false, completed: false };
            result.blocks.push(block); day.occupied = merge([...day.occupied, { start, end: end + settings.blockBuffer }]); remaining -= length;
          }
        }
      }
      if (remaining && !task.split) reason = '缺少满足容量和缓冲约束的连续区间';
      else if (remaining && largestGap < task.min) reason = '可行空隙不足最小工作块长度（含缓冲约束）';
    }
    if (remaining) result.unscheduled.push({ taskId: task.id, title: task.title, remaining, reason });
  }
  result.blocks.sort((a, b) => a.start - b.start || compareText(a.id, b.id));
  result.days = days.map(day => {
    const occupied = total(clipped(day.occupied, day.windows));
    return { date: day.date, occupied, capacity: settings.dailyCapacity, overCapacity: occupied > settings.dailyCapacity };
  });
  return result;
}
