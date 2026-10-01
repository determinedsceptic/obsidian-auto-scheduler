import { describe, expect, it } from 'vitest';
import { parseFixed, parseTasks } from '../src/parser';
import { localMinute } from '../src/time';
const parse = (content: string) => parseTasks([{ path: 'Tasks/test.md', content }]);
const row = '- [ ] 测试 <!-- as id=a remaining=60 priority=5 -->';
describe('任务解析', () => {
  it('只解析带元数据的任务，保留其他标签和缩进', () => {
    const { tasks, errors } = parse(`普通行\n- [ ] 普通任务\r\n  * [ ] 标题 #tag 📅 2026-10-04 <!-- as id=a remaining=60 priority=5 -->`);
    expect(errors).toEqual([]); expect(tasks).toHaveLength(1); expect(tasks[0]).toMatchObject({ min: 30, split: true, line: 3, title: '标题 #tag 📅 2026-10-04' });
  });
  it('识别完成项及有序列表', () => { expect(parse(row.replace('- [ ]', '1. [x]')).tasks[0].completed).toBe(true); });
  it('忽略缩进围栏，较短及错误围栏不能提前结束', () => {
    const text = ['  ````md', row, '```', row, '~~~', row, '````', row.replace('id=a', 'id=b'), '~~~', row, '~~~'].join('\n');
    expect(parse(text).tasks.map(t => t.id)).toEqual(['b']);
  });
  it.each([
    ['remaining=60', 'remaining=0'], ['remaining=60', 'remaining=35'], ['priority=5', 'priority=6'],
    ['priority=5', 'priority=NaN'], ['priority=5', 'priority=3 priority=4'], ['priority=5', 'priority=3 typo=1'],
    ['priority=5', 'priority=3 due=2026-02-30'], ['priority=5', 'priority=3 due=2026-10-03 earliest=2026-10-04'],
    ['priority=5', 'priority=3 split=maybe'], ['id=a', 'id=../a'], ['remaining=60', 'remaining=60 min=90'],
  ])('拒绝非法字段 %s -> %s', (from, to) => { expect(parse(row.replace(from, to)).errors).toHaveLength(1); });
  it('报告跨文件重复 ID', () => { expect(parseTasks([{ path: 'a.md', content: row }, { path: 'b.md', content: row }]).errors[0].message).toContain('重复 ID'); });
  it('日期截止为次日零点，日期 earliest 为当日零点', () => {
    const t = parse(row.replace('priority=5', 'priority=5 due=2026-10-03 earliest=2026-10-01')).tasks[0];
    expect(t.due).toBe(localMinute('2026-10-04', '00:00')); expect(t.earliest).toBe(localMinute('2026-10-01', '00:00'));
  });
  it('时间截止严格解析，无时区或秒字段', () => { expect(parse(row.replace('priority=5', 'priority=5 due=2026-10-03T12:01Z')).errors).toHaveLength(1); });
});
describe('固定日程', () => {
  it('解析标题、空行、非网格固定日程', () => { const parsed = parseFixed({ path: 'Fixed.md', content: '# 固定\n\n- 2026-10-01 10:07-11:23 会议' }); expect(parsed.errors).toEqual([]); expect(parsed.intervals[0].end - parsed.intervals[0].start).toBe(76); });
  it.each(['- 2026-10-01 12:00-09:00', '- 2026-13-01 09:00-10:00', '未知文本', '- 2026-10-01 25:00-26:00'])('拒绝非法记录 %s', content => { expect(parseFixed({ path: 'fixed', content }).errors).toHaveLength(1); });
});
