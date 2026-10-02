import { describe, expect, it } from 'vitest';
import { parseTasks } from '../src/parser';
import { dailyDocument, dailyInputs, renderDaily } from '../src/daily';
import { blockLine, END, parseOutput, START } from '../src/output';
import { applyPreview, createPreview, undoLast } from '../src/transaction';
import { block, config, interval, MemoryVault, now } from './helpers';
const dailySettings = () => config({ outputLocation: 'daily', outputMode: 'gantt' });
describe('Gantt Calendar / 每日笔记', () => {
  it.each([
    ['⏫ 📅 2026-10-02 11:00 🛫 2026-10-01 10:00', 4],
    ['[priority:: highest] [due:: 2026-10-02 11:00] [start:: 2026-10-01 10:00]', 5],
  ])('读取源任务日期时间 %s', (calendar, priority) => {
    const parsed = parseTasks([{ path: 'Tasks/A.md', content: `- [/] 工作 ${calendar} %%[as:: id=a remaining=60]%%` }]);
    expect(parsed.errors).toEqual([]); expect(parsed.tasks[0]).toMatchObject({ priority, completed: false, earliest: interval('10:00', '11:00').start, due: interval('10:00', '11:00', '2026-10-02').end });
  });
  it('上游重排结构化元数据后仍能读取，显式字段优先', () => {
    const parsed = parseTasks([{ path: 'Tasks/A.md', content: '- [ ] 工作 %%[as:: id=a remaining=60 priority=2 due=2026-10-03]%% [priority:: high] [due:: 2026-10-02]' }]);
    expect(parsed.errors).toEqual([]); expect(parsed.tasks[0].priority).toBe(2);
  });
  it('Cancel任务不参与排程；普通任务不猜测估时', () => {
    expect(parseTasks([{ path: 'A.md', content: '- [-] 已Cancel <!-- as id=a remaining=60 -->\n- [ ] 普通任务 📅 2026-10-02' }]).tasks).toMatchObject([{ completed: true }]);
  });
  it.each([['09:00', '10:00'], ['23:00', '24:00']])('Gantt 时间和隐藏元数据可往返 %s-%s', (start, end) => {
    const b = block({ ...interval(start, end) });
    const text = renderDaily(dailyDocument(null), [b], 'gantt');
    expect(parseOutput(text).blocks[0]).toMatchObject({ id: b.id, start: b.start, end: b.end, locked: true });
    expect(text).toContain('%%[as-block::');
    expect(text).not.toContain('## 2026');
  });
  it('清除源任务的 emoji 和同步标识，输出采用单一 Dataview 格式', () => {
    const line = blockLine(block({ title: '任务 ⏫ 📅 2026-10-03 11:00 %%[guid:: source-only]%%' }), 'gantt');
    expect(line).not.toContain('⏫'); expect(line).not.toContain('📅'); expect(line).not.toContain('source-only');
    expect(line).toContain('- [ ] 🎯 09:00');
  });
  it('拒绝时钟与 Gantt 字段不一致，保留上游重排字段', () => {
    const line = blockLine(block(), 'gantt');
    expect(() => parseOutput(`${START}\n${line.replace('[due:: 2026-10-01 10:00]', '[due:: 2026-10-01 11:00]')}\n${END}`)).toThrow('does not match');
    const reordered = line.replace(/ (%%.+?%%)/, '') + ' ' + /%%.+?%%/.exec(line)![0];
    expect(parseOutput(`${START}\n${reordered}\n${END}`).blocks).toHaveLength(1);
  });
  it('逐字保留每日手写任务、其他章节和 CRLF', () => {
    const original = '# 记录\r\n文字\r\n# Day planner\r\n- [ ] 自己的任务\r\n# 晚间\r\n原文';
    const rendered = renderDaily(dailyDocument(original), [block()], 'gantt');
    expect(rendered.startsWith('# 记录\r\n文字\r\n# Day planner\r\n- [ ] 自己的任务\r\n')).toBe(true);
    expect(rendered.endsWith('\r\n# 晚间\r\n原文')).toBe(true);
    expect(renderDaily(dailyDocument(rendered), parseOutput(rendered).blocks, 'gantt')).toBe(rendered);
  });
  it.each(['# Day planner\n# Day planner\n', `# 其他\n${START}\n${END}`, `# Day planner\n# 其他\n${START}\n${END}`])('拒绝歧义或错位 %s', text => {
    expect(() => dailyDocument(text)).toThrow();
  });
  it('代码块标题不参与匹配；没有标题时追加', () => {
    const original = '```md\n# Day planner\n```\n正文';
    expect(renderDaily(dailyDocument(original), [], 'gantt')).toContain('正文\n\n# Day planner\n');
  });
  it('手写 Day Planner 与 Gantt 时间计入占用，源任务截止不计作占用', () => {
    const input = dailyInputs('DailyNotes/2026-10-01.md', '# Day planner\n- [ ] 09:00 - 10:00 会议\n- [ ] 外出 🛫 2026-10-01 10:00 📅 2026-10-01 11:00\n- [ ] 任务 [start:: 2026-10-01 11:00] [due:: 2026-10-01 12:00] <!-- as id=a remaining=60 -->');
    expect(input.errors).toEqual([]); expect(input.intervals).toEqual([interval('09:00', '10:00'), interval('10:00', '11:00')]);
  });
  it('读取本周每日任务并避开手写占用，重复应用不改变源内容', async () => {
    const vault = new MemoryVault(), settings = dailySettings();
    vault.files['DailyNotes/2026-10-01.md'] = '# Day planner\n- [ ] 09:00 - 10:00 会议\n- [ ] 紧急 ⏫ <!-- as id=d remaining=60 -->\n# 日记\n保留';
    const preview = await createPreview(vault, settings, now);
    expect(preview.result.errors).toEqual([]); expect(preview.result.blocks[0]).toMatchObject({ taskId: 'd', start: interval('10:00', '11:00').start });
    await applyPreview(vault, vault, preview, settings, now);
    const second = await createPreview(vault, settings, now);
    expect(second.result.errors).toEqual([]); expect(await applyPreview(vault, vault, second, settings, now)).toEqual({ changed: false });
    expect(vault.files['DailyNotes/2026-10-01.md']).toContain('# 日记\n保留');
  });
  it('快照包含未新建的每日文件，预览后改动拒绝', async () => {
    const vault = new MemoryVault(), settings = dailySettings();
    const preview = await createPreview(vault, settings, now);
    vault.files['DailyNotes/2026-10-04.md'] = '新笔记';
    await expect(applyPreview(vault, vault, preview, settings, now)).rejects.toThrow('changed');
  });
  it('七日备份先保存，部分写入失败可撤销并恢复已有笔记', async () => {
    const vault = new MemoryVault(), settings = dailySettings();
    vault.files['Tasks/A.md'] = '- [ ] 工作 <!-- as id=a remaining=360 priority=3 -->';
    const original = '# Day planner\n我的笔记\n'; vault.files['DailyNotes/2026-10-01.md'] = original;
    const preview = await createPreview(vault, settings, now);
    vault.afterWrite = () => { vault.failWrite = true; };
    await expect(applyPreview(vault, vault, preview, settings, now)).rejects.toThrow('write failed');
    expect(vault.undo?.entries).toHaveLength(2); expect(vault.writes).toBe(1);
    vault.afterWrite = undefined; vault.failWrite = false;
    await undoLast(vault, vault, vault.undo);
    expect(vault.files['DailyNotes/2026-10-01.md']).toBe(original); expect(vault.files['DailyNotes/2026-10-02.md']).toBeUndefined();
  });
  it('撤销预检全部文件，任一被手改则不恢复其他文件', async () => {
    const vault = new MemoryVault(), settings = dailySettings();
    vault.files['Tasks/A.md'] = '- [ ] 工作 <!-- as id=a remaining=360 priority=3 -->';
    await applyPreview(vault, vault, await createPreview(vault, settings, now), settings, now);
    const first = vault.files['DailyNotes/2026-10-01.md']; vault.files['DailyNotes/2026-10-02.md'] += '\n手改';
    await expect(undoLast(vault, vault, vault.undo)).rejects.toThrow('refusing to overwrite'); expect(vault.files['DailyNotes/2026-10-01.md']).toBe(first);
  });
  it('新增每日文件撤销保留空管理区，可再次排程', async () => {
    const vault = new MemoryVault(), settings = dailySettings();
    await applyPreview(vault, vault, await createPreview(vault, settings, now), settings, now);
    await undoLast(vault, vault, vault.undo);
    expect(vault.files['DailyNotes/2026-10-01.md']).toContain('# Day planner');
    expect(parseOutput(vault.files['DailyNotes/2026-10-01.md']).blocks).toEqual([]);
    expect((await createPreview(vault, settings, now)).result.errors).toEqual([]);
  });
});

describe('每日事务恢复边界', () => {
  it('撤销途中失败后重试跳过已恢复的文件', async () => {
    const vault = new MemoryVault(), settings = dailySettings();
    vault.files['Tasks/A.md'] = '- [ ] 工作 <!-- as id=a remaining=360 priority=3 -->';
    await applyPreview(vault, vault, await createPreview(vault, settings, now), settings, now);
    vault.afterWrite = () => { vault.failWrite = true; };
    await expect(undoLast(vault, vault, vault.undo)).rejects.toThrow('write failed');
    expect(vault.undo).not.toBeNull();
    vault.afterWrite = undefined; vault.failWrite = false;
    await undoLast(vault, vault, vault.undo);
    expect(vault.undo).toBeNull();
    expect(parseOutput(vault.files['DailyNotes/2026-10-01.md']).blocks).toHaveLength(0);
    expect(parseOutput(vault.files['DailyNotes/2026-10-02.md']).blocks).toHaveLength(0);
  });
  it('Tasks folder就是每日目录时不重复导入，只读取 Day planner 源任务', async () => {
    const vault = new MemoryVault(), settings = config({ taskFolder: 'DailyNotes', outputLocation: 'daily', outputMode: 'gantt' });
    vault.files = {
      'DailyNotes/2026-09-30.md': '# Day planner\n- [ ] 历史未完成 %%[as:: id=history remaining=60]%%',
      'DailyNotes/2026-10-01.md': '# 日记\n- [ ] 忽略 <!-- as id=ignored remaining=60 -->\n# Day planner\n- [ ] 当前 %%[as:: id=current remaining=60]%%',
    };
    const preview = await createPreview(vault, settings, now);
    expect(preview.result.errors).toEqual([]);
    expect(preview.result.blocks.map(b => b.taskId).sort()).toEqual(['current', 'history']);
  });
  it('拒绝非法手写范围和工作块日期错位', async () => {
    const vault = new MemoryVault(), settings = dailySettings();
    vault.files['DailyNotes/2026-10-01.md'] = '# Day planner\n- [ ] 10:00 - 09:00 错误';
    expect((await createPreview(vault, settings, now)).result.errors).not.toHaveLength(0);
    vault.files['DailyNotes/2026-10-01.md'] = renderDaily(dailyDocument(null), [block({ date: '2026-10-02', ...interval('09:00', '10:00', '2026-10-02') })], 'gantt');
    expect((await createPreview(vault, settings, now)).result.errors[0].message).toContain('date');
  });
});
