import { describe, expect, it } from 'vitest';
import { END, START, blockLine, diffBlocks, parseOutput, renderOutput } from '../src/output';
import { block, interval } from './helpers';
describe('专用Schedule file', () => {
  it.each(['plain', 'day-planner'] as const)('可读回 %s 格式，保留原始保护块', mode => {
    const b = block({ raw: undefined });
    const text = renderOutput(parseOutput(null), [b], mode);
    const parsed = parseOutput(text);
    expect(parsed.blocks[0]).toMatchObject({ id: b.id, taskId: b.taskId, start: b.start, end: b.end, locked: true, path: b.path });
    expect(renderOutput(parsed, parsed.blocks, mode)).toBe(text);
  });
  it.each(['plain', 'day-planner'] as const)('午夜结束用 24:00 可读回：%s', mode => {
    const b = block({ ...interval('23:00', '24:00') });
    const text = renderOutput(parseOutput(null), [b], mode);
    expect(text).toContain('24:00'); expect(parseOutput(text).blocks[0].end).toBe(b.end);
  });
  it('逐字保留管理区外内容和 CRLF', () => {
    const content = `个人前言\r\n${START}\r\n\r\n${END}\r\n尾注没有换行`;
    const output = renderOutput(parseOutput(content), [block()], 'plain');
    expect(output.startsWith('个人前言\r\n')).toBe(true); expect(output.endsWith('\r\n尾注没有换行')).toBe(true); expect(output.replace(/\r\n/g, '')).not.toContain('\n');
  });
  it.each(['普通笔记', `${START}\n${START}\n${END}`, `${END}\n${START}`, `${START}\n不要删除我\n${END}`, `前言 ${START}\n${END}`, `${START}\n${END}后缀`])('拒绝非法管理区 %s', content => { expect(() => parseOutput(content)).toThrow(); });
  it('拒绝重复Block ID', () => { expect(() => parseOutput(`${START}\n${blockLine(block(), 'plain')}\n${blockLine(block(), 'plain')}\n${END}`)).toThrow('Duplicate'); });
  it('不接管非标元数据、跨日倒序时间或错误日期', () => {
    const text = renderOutput(parseOutput(null), [block()], 'plain');
    expect(() => parseOutput(text.replace('locked=true', 'locked=maybe'))).toThrow();
    expect(() => parseOutput(text.replace('09:00-10:00', '23:00-01:00'))).toThrow();
    expect(() => parseOutput(text.replace(/2026-10-01/g, '2026-02-30'))).toThrow();
  });
  it('差异包括时间、锁定、完成状态变化', () => { expect(diffBlocks([block()], [block({ completed: true })])).toMatchObject({ added: [expect.anything()], removed: [expect.anything()], retained: [] }); });
});
