import { isHabit } from './habits';
import { reserveEvent } from './event-tool';
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
  // A habit's locked flag preserves its preferred display time; it does not make
  // an unchecked occurrence a hard commitment. Completed history and locked
  // non-habit blocks remain protected.
  const taskMap = new Map(tasks.map(t => [t.id, t]));
  const protectedBlocks = previous.filter(b => inRange(b) && (b.completed || (b.locked && !isHabit(b.taskId))));
  const preferredFlexible = previous.filter(b => inRange(b) && !b.completed && (isHabit(b.taskId) || (!b.locked && taskMap.get(b.taskId)?.sourceDetached)))
    .sort((a, b) => (b.priority ?? 3) - (a.priority ?? 3) || a.start - b.start || compareText(a.id, b.id));
  const lockedMinutes = new Map<string, number>();
  const bufferedFixed = merge(fixed.map(i => reserveEvent(i, settings.fixedBuffer)));
  const blockReservation = (block: Block): Interval => isHabit(block.taskId)
    ? { start: block.start, end: block.end }
    : { start: block.start, end: block.end + settings.blockBuffer };
  for (const block of protectedBlocks) {
    const fail = (message: string): void => { errors.push({ path: settings.outputFile, line: 0, message: `Block ${block.id}: ${message}` }); };
    if (!taskMap.has(block.taskId)) fail('References an unknown task ID');
    if (!isHabit(block.taskId) && (block.start % GRID || block.end % GRID)) fail('Locked blocks must use the 15-minute grid');
    if (bufferedFixed.some(i => overlap(blockReservation(block), i))) fail('Conflicts with a fixed event or its buffer');
    const task = taskMap.get(block.taskId);
    if (task && !task.sourceDetached && !task.completed && !block.completed && ((task.earliest !== undefined && block.start < task.earliest) || (task.due !== undefined && block.end > task.due))) fail('Violates the task earliest/due constraints');
    lockedMinutes.set(block.taskId, (lockedMinutes.get(block.taskId) ?? 0) + block.end - block.start);
  }
  for (let i = 0; i < protectedBlocks.length; i++) for (let j = i + 1; j < protectedBlocks.length; j++) {
    const a = protectedBlocks[i], b = protectedBlocks[j];
    if (overlap(blockReservation(a), blockReservation(b))) errors.push({ path: settings.outputFile, line: 0, message: `Locked block or buffer conflict: ${a.id} / ${b.id}` });
  }
  for (const task of tasks) {
    if(task.sourceDetached)continue;
    if(task.dailyMinutes!==undefined&&(!Number.isInteger(task.dailyMinutes)||task.dailyMinutes<task.min||task.dailyMinutes%GRID||!task.split))errors.push({path:task.path,line:task.line,message:'Invalid per-task daily effort limit'});
    const minutes = lockedMinutes.get(task.id) ?? 0;
    if (!task.completed && minutes > task.remaining) errors.push({ path: task.path, line: task.line, message: `Locked time exceeds remaining duration: ${task.id}` });
    if (!task.completed && !task.split && protectedBlocks.filter(b => b.taskId === task.id).length > 1) errors.push({ path: task.path, line: task.line, message: `An unsplittable task cannot have multiple locked blocks: ${task.id}` });
    if (!task.completed && !task.split && minutes > 0 && minutes !== task.remaining) errors.push({ path: task.path, line: task.line, message: `A locked block for an unsplittable task must cover all remaining time: ${task.id}` });
  }
  if (errors.length) return result;
  result.blocks = [...previous.filter(b => !inRange(b)), ...protectedBlocks];
  const hardBlockReservations = protectedBlocks.map(blockReservation);
  const acceptedFlexibleReservations: Interval[] = [];
  for (const block of preferredFlexible) {
    let reason: string | undefined;
    const reservation=blockReservation(block),label=isHabit(block.taskId)?'Preferred habit time':'Existing session with an edited source';
    if (!taskMap.has(block.taskId)) {
      errors.push({ path: settings.outputFile, line: 0, message: `Block ${block.id}: References an unknown task ID` });
      continue;
    }
    if (bufferedFixed.some(interval => overlap(reservation, interval))) reason = `${label} overlaps a fixed commitment or its reserved buffer`;
    else if (hardBlockReservations.some(interval => overlap(reservation, interval))) reason = `${label} overlaps a completed or locked block`;
    else if (acceptedFlexibleReservations.some(interval => overlap(reservation, interval))) reason = `${label} overlaps another preferred occurrence selected first by priority and stable order`;
    if (reason) {
      result.unscheduled.push({ taskId: block.taskId, title: block.title, remaining: block.end - block.start, reason });
      continue;
    }
    result.blocks.push(block);
    acceptedFlexibleReservations.push(reservation);
  }
  if (errors.length) return result;
  const days = Array.from({ length: dayCount }, (_, i) => {
    const date = addDays(today, i); const windows = workWindows(date, settings);
    const occupied = merge([...bufferedFixed, ...hardBlockReservations, ...acceptedFlexibleReservations]);
    return { date, windows, occupied };
  });
  // Habit occurrences are either kept at their declared time above or omitted.
  // Ordinary allocation must not invent replacement times for them.
  const ordered = tasks.filter(t => !t.completed && !t.sourceDetached && !isHabit(t.id)).sort((a, b) => b.priority - a.priority || (a.due ?? Infinity) - (b.due ?? Infinity) || (a.earliest ?? -Infinity) - (b.earliest ?? -Infinity) || compareText(a.id, b.id));
  for (const task of ordered) {
    let remaining = task.remaining - (lockedMinutes.get(task.id) ?? 0);
    if (!remaining) continue;
    let reason = 'Insufficient available time or daily capacity';
    if (task.due !== undefined && task.due <= nowMinute) reason = 'Deadline has passed';
    else if (task.earliest !== undefined && task.earliest >= localMinute(until, '00:00')) reason = 'Earliest start is outside the scheduling range';
    else {
      let largestGap = 0;
      if(settings.balanceLoad){
        // Choose one feasible session at a time, then recompute all seven days.
        // Include existing commitments and buffers; dates break equal-load ties.
        while(remaining){
          let best:{day:typeof days[number];start:number;length:number;load:number}|undefined;
          for(const day of days){
            const used=result.blocks.filter(b=>b.taskId===task.id&&b.date===day.date).reduce((n,b)=>n+b.end-b.start,0);
            const budget=(task.dailyMinutes??Infinity)-used;
            for(const window of day.windows){
              const available={start:Math.max(window.start,nowMinute,task.earliest??-Infinity),end:Math.min(window.end,task.due??Infinity)};
              for(const gap of gaps(available,day.occupied)){
                const local=atDate(gap.start);const minute=local.getHours()*60+local.getMinutes()+local.getSeconds()/60+local.getMilliseconds()/60000;
                const start=gap.start+Math.ceil(minute/GRID)*GRID-minute;
                const max=Math.floor((gap.end-start)/GRID)*GRID;largestGap=Math.max(largestGap,max);
                const lower=task.split?task.min:remaining;
                let length=Math.min(remaining,max,budget,task.split?Math.max(60,task.min):remaining);
                for(;length>=lower;length-=GRID){
                  const tail=remaining-length;const occupancy={start,end:start+length+settings.blockBuffer};
                  const load=total(clipped([...day.occupied,occupancy],day.windows));
                  if((!task.split||!tail||tail>=task.min)&&occupancy.end<=gap.end&&load<=settings.dailyCapacity){
                    if((task.split||length===remaining)&&(!best||load<best.load||(load===best.load&&start<best.start)))best={day,start,length,load};
                    break;
                  }
                }
              }
            }
          }
          if(!best)break;
          const {day,start,length}=best,end=start+length;
          result.blocks.push({id:`b_${task.id}_${day.date.replace(/-/g,'')}_${Math.round(start)}_${length}`,taskId:task.id,date:day.date,start,end,title:task.title,priority:task.priority,path:task.path,locked:false,completed:false});
          day.occupied=merge([...day.occupied,{start,end:end+settings.blockBuffer}]);remaining-=length;
        }
      }else {
      for (const day of days) {
        if (!remaining) break;
        let dayBudget=(task.dailyMinutes??Infinity)-previous.filter(b=>b.taskId===task.id&&b.date===day.date&&(b.completed||b.locked)).reduce((n,b)=>n+b.end-b.start,0);
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
            let length = Math.min(remaining, max, dayBudget);
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
            const block: Block = { id: `b_${task.id}_${day.date.replace(/-/g, '')}_${Math.round(start)}_${length}`, taskId: task.id, date: day.date, start, end, title: task.title, priority: task.priority, path: task.path, locked: false, completed: false };
            result.blocks.push(block); day.occupied = merge([...day.occupied, { start, end: end + settings.blockBuffer }]); remaining -= length; dayBudget -= length;
          }
        }
      }
      }
      if (remaining && !task.split) reason = 'No continuous interval satisfies capacity and buffers';
      else if (remaining && largestGap < task.min) reason = 'Available gaps are shorter than the minimum block including buffers';
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
