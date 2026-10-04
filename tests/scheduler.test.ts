import { describe, expect, it } from 'vitest';
import { schedule } from '../src/scheduler';
import { addDays, clipped, clock, dateKey, gaps, localMinute, merge, overlap, total, validateSettings, workWindows } from '../src/time';
import { block, config, interval, now, task } from './helpers';
import type { Task } from '../src/types';
describe('区间与设置', () => {
  it('合并相交和相邻区间并计算唯一容量', () => { expect(total(merge([interval('09:00', '10:00'), interval('09:30', '10:30'), interval('10:30', '11:00')]))).toBe(120); });
  it('半开区间相邻无冲突，求补集不跨边界', () => { expect(overlap(interval('09:00', '10:00'), interval('10:00', '11:00'))).toBe(false); expect(gaps(interval('09:00', '12:00'), [interval('08:00', '10:00'), interval('11:00', '13:00')])).toEqual([interval('10:00', '11:00')]); });
  it.each([
    { taskFolder: '../secret' }, { outputFile: '/file.md' }, { outputFile: '.obsidian/config.md' }, { outputFile: 'Scheduler/Fixed.md' },
    { weekdays: [1, 1] }, { weekdays: [] }, { periods: ['09:00-08:00'] }, { periods: ['09:00-11:00', '10:00-12:00'] },
    { blockBuffer: 5 }, { dailyCapacity: NaN }, { periods: ['09:01-12:00'] },
  ])('拒绝非法设置 %j', patch => { expect(validateSettings(config(patch))).not.toEqual([]); });
});
describe('确定性排程', () => {
  it('小样本一天：按优先级并用 ID 打破平局', () => {
    const result = schedule([task({ id: 'z' }), task({ id: 'b', priority: 5 }), task({ id: 'a' })], [], [], config(), now, 1);
    expect(result.errors).toEqual([]); expect(result.blocks.map(b => b.taskId)).toEqual(['b', 'a', 'z']); expect(result.unscheduled).toEqual([]);
  });
  it('同优先级按截止、最早开始排序', () => {
    const tasks = [task({ id: 'a', due: localMinute('2026-10-02', '12:00') }), task({ id: 'z', due: localMinute('2026-10-01', '12:00') })];
    expect(schedule(tasks, [], [], config(), now, 1).blocks[0].taskId).toBe('z');
  });
  it('固定事件两侧缓冲与重叠事件只算并集', () => {
    const result = schedule([task({ remaining: 120 })], [interval('10:00', '10:30'), interval('10:15', '10:45')], [], config({ fixedBuffer: 15 }), now, 1);
    expect(result.blocks.map(b => [clock(b.start), clock(b.end)])).toEqual([['09:00', '09:45'], ['11:00', '11:45']]);
    expect(result.unscheduled[0].remaining).toBe(30); expect(result.days[0].occupied).toBe(165);
  });
  it('今天不排过去时段，秒向上取网格', () => {
    const result = schedule([task()], [], [], config(), new Date('2026-10-01T09:01:17+08:00'), 1);
    expect(clock(result.blocks[0].start)).toBe('09:15');
  });
  it('每日容量包含缓冲，已超额日不新增', () => {
    const result = schedule([task()], [interval('09:00', '11:00')], [], config({ dailyCapacity: 90 }), now, 1);
    expect(result.blocks).toEqual([]); expect(result.days[0]).toMatchObject({ occupied: 120, overCapacity: true });
  });
  it('不跨午休，容量包含每块末尾缓冲', () => {
    const result = schedule([task({ remaining: 180 })], [], [], config({ periods: ['09:00-10:30', '14:00-16:00'], dailyCapacity: 180, blockBuffer: 15 }), now, 1);
    expect(result.blocks.map(b => [clock(b.start), clock(b.end)])).toEqual([['09:00', '10:15'], ['14:00', '15:15']]);
    expect(result.unscheduled[0].remaining).toBe(30); expect(result.days[0].occupied).toBe(180);
  });
  it('不产生小于 min 的拆分尾块', () => {
    const result = schedule([task({ remaining: 75, min: 30 })], [interval('10:00', '11:00')], [], config(), now, 1);
    expect(result.blocks.map(b => b.end - b.start)).toEqual([45, 30]); expect(result.unscheduled).toEqual([]);
  });
  it('不Splittable任务不得部分安排', () => {
    const result = schedule([task({ remaining: 120, split: false })], [interval('10:00', '11:00')], [], config(), now, 1);
    expect(result.blocks).toEqual([]); expect(result.unscheduled[0]).toMatchObject({ remaining: 120, reason: expect.stringContaining('continuous') });
  });
  it('保留锁定块并扣除本周剩余量', () => {
    const locked = block(); const result = schedule([task({ remaining: 120 })], [], [locked], config(), now, 1);
    expect(result.blocks[0]).toEqual(locked); expect(result.blocks.reduce((n, b) => n + b.end - b.start, 0)).toBe(120);
  });
  it('已完成任务的锁定块仍占用，历史块不扣本周量', () => {
    const historical = block({ id: 'history', date: '2026-09-30', ...interval('09:00', '10:00', '2026-09-30') });
    const result = schedule([task({ completed: true }), task({ id: 'b' })], [], [block(), historical], config(), now, 1);
    expect(result.blocks).toHaveLength(3); expect(clock(result.blocks.find(b => b.taskId === 'b')!.start)).toBe('10:00');
  });
  it('勾选工作块按锁定块保护', () => { const b = block({ locked: false, completed: true }); expect(schedule([task()], [], [b], config(), now, 1).blocks).toEqual([b]); });
  it.each([
    ['与固定日程冲突', () => schedule([task()], [interval('09:30', '10:00')], [block()], config(), now, 1)],
    ['超过剩余量', () => schedule([task({ remaining: 30 })], [], [block()], config(), now, 1)],
    ['未知 ID', () => schedule([task()], [], [block({ taskId: 'missing' })], config(), now, 1)],
    ['锁定块彼此冲突', () => schedule([task({ remaining: 120 })], [], [block(), block({ id: 'other' })], config(), now, 1)],
    ['锁定块缓冲冲突', () => schedule([task({ remaining: 120 })], [], [block(), block({ id: 'other', ...interval('10:00', '11:00') })], config({ blockBuffer: 15 }), now, 1)],
  ])('阻止应用：%s', (_, run) => { expect(run().errors.length).toBeGreaterThan(0); });
  it('不Splittable任务不能通过多个锁定块拆分', () => {
    const result = schedule([task({ split: false })], [], [block({ ...interval('09:00', '09:30') }), block({ id: 'part2', ...interval('10:00', '10:30') })], config(), now, 1);
    expect(result.errors.some(e => e.message.includes('multiple locked blocks'))).toBe(true);
  });
  it('受 earliest/due 限制，过期与范围外分别解释', () => {
    const result = schedule([task({ id: 'expired', due: localMinute('2026-09-30', '12:00') }), task({ id: 'future', earliest: localMinute('2026-10-10', '09:00') }), task({ id: 'bound', earliest: localMinute('2026-10-01', '09:20'), due: localMinute('2026-10-01', '10:30') })], [], [], config(), now, 1);
    expect(result.unscheduled.map(t => t.reason)).toEqual(['Deadline has passed', 'Earliest start is outside the scheduling range']);
    expect(result.blocks.map(b => [clock(b.start), clock(b.end)])).toEqual([['09:30', '10:30']]);
  });
  it('跨月日期递增，不使用固定 UTC 日长', () => { expect(addDays('2026-10-31', 1)).toBe('2026-11-01'); });
  it('多组一周合成样本满足时长守恒、无冲突、容量、网格和可重复性', () => {
    for (let seed = 1; seed <= 20; seed++) {
      let state = seed; const random = () => { state = (state * 1664525 + 1013904223) >>> 0; return state; };
      const tasks: Task[] = Array.from({ length: 30 }, (_, i) => task({ id: `t${i}`, remaining: (2 + random() % 12) * 15, priority: 1 + random() % 5, split: random() % 4 !== 0 }));
      const settings = config({ weekdays: [1, 2, 3, 4, 5], periods: ['09:00-12:00', '14:00-18:00'], dailyCapacity: 360, fixedBuffer: 15, blockBuffer: 15 });
      const fixed = [interval('10:07', '11:03', '2026-10-02'), interval('14:00', '15:00', '2026-10-05')];
      const result = schedule(tasks, fixed, [], settings, now);
      expect(result).toEqual(schedule(tasks, fixed, [], settings, now)); expect(result.errors).toEqual([]);
      for (const t of tasks) {
        const blocks = result.blocks.filter(b => b.taskId === t.id);
        expect(blocks.reduce((n, b) => n + b.end - b.start, 0) + (result.unscheduled.find(u => u.taskId === t.id)?.remaining ?? 0)).toBe(t.remaining);
        if (!t.split) expect(blocks.length).toBeLessThanOrEqual(1);
        for (const b of blocks) { expect(b.end - b.start).toBeGreaterThanOrEqual(t.min); expect(b.start % 15).toBe(0); expect(b.end % 15).toBe(0); expect(workWindows(b.date, settings).some(w => b.start >= w.start && b.end + settings.blockBuffer <= w.end)).toBe(true); expect(fixed.every(f => !overlap(b, { start: f.start - 15, end: f.end + 15 }))).toBe(true); }
      }
      for (let i = 1; i < result.blocks.length; i++) expect(result.blocks[i - 1].end + settings.blockBuffer).toBeLessThanOrEqual(result.blocks[i].start);
      expect(result.days.every(d => d.occupied <= d.capacity)).toBe(true);
    }
  });
});

it('checks today first for paced projects, continues across days and keeps overflow unscheduled',()=>{
  const s=config({periods:['09:00-12:00','14:00-18:00'],dailyCapacity:360});
  const current=new Date('2026-10-01T16:10:00+08:00');
  const result=schedule([task({remaining:600,dailyMinutes:60})],[],[],s,current);
  expect(result.errors).toEqual([]);expect(result.blocks[0].date).toBe('2026-10-01');
  expect(result.blocks[0].start).toBeGreaterThanOrEqual(current.getTime()/60000);
  expect(new Set(result.blocks.map(b=>b.date)).size).toBe(7);expect(result.unscheduled[0].remaining).toBe(180);
});
it('counts completed sessions against the project daily pace while preserving an explicit later start',()=>{
  const s=config({periods:['09:00-18:00'],dailyCapacity:360});
  const result=schedule([task({remaining:180,dailyMinutes:60})],[],[block({completed:true})],s,now);
  expect(result.errors).toEqual([]);
  expect(result.blocks.filter(b=>b.date==='2026-10-01'&&!b.completed)).toHaveLength(0);
  const later=schedule([task({remaining:180,dailyMinutes:60,earliest:interval('09:00','10:00','2026-10-02').start})],[],[],s,now);
  expect(later.blocks[0].date).toBe('2026-10-02');
});
