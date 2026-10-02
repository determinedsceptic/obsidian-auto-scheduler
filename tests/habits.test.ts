import { describe, expect, it } from 'vitest';
import { HABIT_TEMPLATE, expandHabits, parseHabits } from '../src/habits';
import { applyPreview, createPreview, undoLast } from '../src/transaction';
import { block, config, interval, MemoryVault, now } from './helpers';
const row = (fields = 'id=exercise days=0,1,2,3,4,5,6 priority=5', time = '09:00-09:30') => `- ${time} 锻炼 <!-- habit ${fields} -->`;
const parse = (content: string) => parseHabits([{ path: 'Habits/Template.md', content }]);
const settings = config({ outputLocation: 'daily', outputMode: 'day-planner', cleanDaily: true });
const preview = (v: MemoryVault) => createPreview(v, settings, now, v.tracking);
describe('周期习惯模板', () => {
  it('单文件模式中的历史未完成实例不被删除或再次排程', () => {
    const old = block({ taskId: 'habit_old_20260930', date: '2026-09-30', completed: false });
    const expanded = expandHabits([], [old], '2026-10-01');
    expect(expanded.blocks).toEqual([old]); expect(expanded.tasks[0].completed).toBe(true);
  });
  it('无注释模板支持默认每天、星期说明和重要性', () => {
    const p = parse('- 19:00-19:30 ⏫ 锻炼（周一、周三、周五）\n- 22:00-22:15 阅读');
    expect(p.errors).toEqual([]); expect(p.habits[0]).toMatchObject({ title: '锻炼', days: [1, 3, 5], priority: 4 });
    expect(p.habits[1].days).toHaveLength(7);
    expect(parse('- 19:00-19:30 锻炼（周八）').errors).toHaveLength(1);
    expect(parse('- 19:00-19:30 锻炼（周末）').habits[0].days).toEqual([0, 6]);
    expect(p.habits[0].id).toBe(parse('- 20:00-20:30 锻炼（每天）').habits[0].id);
  });
  it('默认模板停用，代码块示例忽略', () => {
    const p = parse(HABIT_TEMPLATE + '\n```\n' + row() + '\n```');
    expect(p.errors).toEqual([]); expect(expandHabits(p.habits, [], '2026-10-01').blocks).toEqual([]);
  });
  it('按当地星期及含首尾的生效日期展开，包括周末', () => {
    const p = parse(row('id=exercise days=0,4,6 from=2026-10-01 until=2026-10-04'));
    expect(p.errors).toEqual([]);
    const expanded = expandHabits(p.habits, [], '2026-10-01');
    expect(expanded.blocks.map(b => b.date)).toEqual(['2026-10-01', '2026-10-03', '2026-10-04']);
    expect(expanded.blocks[0]).toMatchObject(interval('09:00', '09:30'));
    expect(new Set(expanded.tasks.map(t => t.id)).size).toBe(3);
  });
  it.each([
    row('id=x days=7'), row('id=x days=1,1'), row('id=x days=1 priority=6'),
    row('id=x days=1 enabled=yes'), row('id=x days=1 from=2026-02-30'),
    row('id=x days=1 from=2026-10-03 until=2026-10-01'), row('id=x days=1 unknown=1'),
    row('id=x days=1', '09:01-09:30'), row('id=x days=1', '23:00-01:00'),
    row() + '\n' + row(), row().replace('锻炼', '[[链接]]'),
  ])('非法模板报错：%s', content => expect(parse(content).errors.length).toBeGreaterThan(0));
  it('无普通任务也创建每天计划，纯列表无标记，并重复生成不重复写', async () => {
    const v = new MemoryVault(); v.files = { 'Habits/Template.md': row() };
    const p = await preview(v); expect(p.result.errors).toEqual([]); expect(p.result.blocks).toHaveLength(7);
    await applyPreview(v, v, p, settings, now);
    expect(v.files['DailyNotes/2026-10-01.md']).toContain('- [ ] 09:00 - 09:30 🔺 锻炼');
    expect(v.files['DailyNotes/2026-10-01.md']).not.toMatch(/as-block|auto-scheduler|scheduled::|\[\[Habits/);
    expect(await applyPreview(v, v, await preview(v), settings, now)).toEqual({ changed: false });
    expect(v.files['Habits/Template.md']).toBe(row());
  });
  it('先占位再排普通任务，并计入工作窗口容量', async () => {
    const v = new MemoryVault(); v.files['Habits/Template.md'] = row();
    const p = await preview(v); expect(p.result.errors).toEqual([]);
    expect(p.result.blocks.find(b => b.taskId === 'a')?.start).toBe(interval('09:30', '10:30').start);
    expect(p.result.days[0].occupied).toBe(90);
  });
  it('非Working days和晚间也记录，不扣除工作窗口之外的容量', async () => {
    const v = new MemoryVault(); v.files = { 'Habits/Template.md': row(undefined, '19:00-19:30') };
    const p = await createPreview(v, { ...settings, weekdays: [1] }, now);
    expect(p.result.errors).toEqual([]); expect(p.result.blocks).toHaveLength(7);
    expect(p.result.days.every(d => d.occupied === 0)).toBe(true);
  });
  it('固定日程或习惯缓冲冲突阻止整批写入', async () => {
    const v = new MemoryVault(); v.files['Habits/Template.md'] = row();
    v.files['Scheduler/Fixed.md'] = '- 2026-10-01 09:15-10:00 会议';
    let p = await preview(v); expect(p.result.errors.some(e => e.message.toLowerCase().includes('conflict'))).toBe(true);
    await expect(applyPreview(v, v, p, settings, now)).rejects.toThrow('errors'); expect(v.writes).toBe(0);
    delete v.files['Scheduler/Fixed.md']; v.files['Habits/Template.md'] += '\n' + row('id=other days=4', '09:30-10:00');
    p = await createPreview(v, { ...settings, blockBuffer: 15 }, now);
    expect(p.result.errors.some(e => e.message.toLowerCase().includes('conflict'))).toBe(true);
  });
  it.each(['修改', '新增', '删除'])('模板%s使预览过期', async mode => {
    const v = new MemoryVault(); v.files['Habits/Template.md'] = row(); const p = await preview(v);
    if (mode === '修改') v.files['Habits/Template.md'] += '\n';
    if (mode === '新增') v.files['Habits/Other.md'] = '# 新模板';
    if (mode === '删除') delete v.files['Habits/Template.md'];
    await expect(applyPreview(v, v, p, settings, now)).rejects.toThrow('habits template'); expect(v.writes).toBe(0);
  });
  it('重启后已完成实例保留，其他日期随模板改时，撤销不改模板', async () => {
    const v = new MemoryVault(); v.files = { 'Habits/Template.md': row() };
    await applyPreview(v, v, await preview(v), settings, now);
    v.files['DailyNotes/2026-10-01.md'] = v.files['DailyNotes/2026-10-01.md'].replace('[ ]', '[x]');
    v.tracking = JSON.parse(JSON.stringify(v.tracking));
    v.files['Habits/Template.md'] = row(undefined, '10:00-10:30');
    const before = v.files['DailyNotes/2026-10-02.md'];
    let p = await preview(v); expect(p.result.errors).toEqual([]);
    expect(p.result.blocks.filter(b => b.date === '2026-10-01')).toHaveLength(1);
    expect(p.result.blocks.find(b => b.date === '2026-10-01')).toMatchObject({ completed: true, ...interval('09:00', '09:30') });
    await applyPreview(v, v, p, settings, now);
    expect(v.files['DailyNotes/2026-10-02.md']).toContain('10:00 - 10:30');
    await undoLast(v, v, v.undo);
    expect(v.files['DailyNotes/2026-10-02.md']).toBe(before);
    expect(v.files['Habits/Template.md']).toBe(row(undefined, '10:00-10:30'));
    delete v.files['Habits/Template.md']; p = await preview(v);
    expect(p.result.errors).toEqual([]); expect(p.result.blocks).toHaveLength(1); expect(p.result.blocks[0].completed).toBe(true);
  });
  it('保留习惯实例 ID 命名空间，防止普通任务碰撞', async () => {
    const v = new MemoryVault(); v.files['Tasks/A.md'] = '- [ ] 伪实例 <!-- as id=habit_exercise_20261001 remaining=30 -->';
    expect((await preview(v)).result.errors.some(e => e.message.includes('reserved'))).toBe(true);
  });
});
