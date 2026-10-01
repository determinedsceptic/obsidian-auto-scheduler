import { describe, expect, it } from 'vitest';
import { blockLine, parseOutput, renderOutput } from '../src/output';
import { parseTasks } from '../src/parser';
import { block } from './helpers';
describe('Day Planner 0.35.1 公共格式契约', () => {
  it('复选框、时间范围、scheduled 日期在任意文件中可索引', () => {
    const line = blockLine(block({ locked: false }), 'day-planner');
    expect(line).toMatch(/^- \[ \] 09:00 - 10:00 /);
    expect(line).toContain('[scheduled:: 2026-10-01]');
    expect(line).toContain('<!-- as-block');
    // The scheduler must never import its own exported work blocks as source tasks.
    expect(parseTasks([{ path: 'Tasks/Output.md', content: line }]).tasks).toEqual([]);
  });
  it('日期来自工作块，不沿用源任务 scheduled 或 due', () => {
    const line = blockLine(block({ title: '分析 #tag [scheduled:: 2026-09-29] (due:: 2026-10-09) 📅 2026-10-09 ⏳ 2026-09-29' }), 'day-planner');
    expect(line.match(/scheduled::/g)).toHaveLength(1);
    expect(line).not.toContain('2026-09-29'); expect(line).not.toContain('2026-10-09'); expect(line).toContain('#tag');
  });
  it('Day Planner 拖动后的时刻和注释可读回，保留新时间', () => {
    const text = renderOutput(parseOutput(null), [block()], 'day-planner').replace('09:00 - 10:00', '10:15 - 11:15');
    const parsed = parseOutput(text); expect(parsed.blocks[0].end - parsed.blocks[0].start).toBe(60);
    expect(renderOutput(parsed, parsed.blocks, 'day-planner')).toBe(text);
  });
  it('勾选会保留完成状态，不同步到源任务', () => {
    const text = renderOutput(parseOutput(null), [block({ locked: false })], 'day-planner').replace('[ ]', '[x]');
    expect(parseOutput(text).blocks[0]).toMatchObject({ locked: false, completed: true });
  });
  it('普通格式不生成复选框', () => { expect(blockLine(block(), 'plain')).not.toContain('[ ]'); });
});
