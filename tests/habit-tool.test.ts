import { describe, expect, it } from 'vitest';
import { appendHabits, habitInstructions, habitPath, validateHabitDrafts } from '../src/habit-tool';
import { chat } from '../src/llm';
import { DEFAULT_LLM } from '../src/types';
import { applyPreview, createPreview, undoLast } from '../src/transaction';
import { config, MemoryVault, now } from './helpers';
const draft = { title: '饭后慢走', start: '19:00', end: '19:30', days: [0,1,2,3,4,5,6], priority: 3 };
const settings = config({ habitFolder: 'Templates/Habits', outputLocation: 'daily', outputMode: 'day-planner', cleanDaily: true });
const messages = [{ role: 'user' as const, content: '每天19点饭后慢走半小时' }];
describe('habit skill and model tools', () => {
  it('使用当前设置中的路径，生成普通模板行', () => {
    expect(habitPath(settings)).toBe('Templates/Habits/AI-Habits.md');
    expect(habitInstructions(settings)).toContain('Templates/Habits/AI-Habits.md');
    expect(habitInstructions(settings)).toContain('first ask for an exact start time');
    const text = appendHabits(null, [draft]); expect(text).toContain('19:00-19:30 🔼 饭后慢走'); expect(text).not.toContain('<!--');
    expect(() => appendHabits(text, [draft])).toThrow('Duplicate habit');
  });
  it.each([
    { ...draft, path: '../secret.md' }, { ...draft, title: '<!-- bad -->' }, { ...draft, title: 'bad\n# test' },
    { ...draft, start: '19:01' }, { ...draft, end: '18:00' }, { ...draft, days: [7] }, { ...draft, days: [1,1] },
    { ...draft, days: [] }, { ...draft, priority: 6 }, { ...draft, title: '活动（周八）' },
  ])('拒绝非法参数 %j', h => expect(() => validateHabitDrafts({ habits: [h] })).toThrow());
  it('拒绝吞掉新增行的未关闭代码块', () => expect(() => appendHabits('# 标题\n```markdown\n', [draft])).toThrow('code fence'));
  it.each(['responses','chat-completions','anthropic','gemini'] as const)('协议 %s 注册和解析习惯调用', async protocol => {
    const args = { habits: [draft] };
    const reply = await chat({ ...DEFAULT_LLM, protocol }, 'fixture', messages, settings, now, async (_, __, body) => {
      const data = JSON.parse(body); expect(body).toContain('create_habits'); expect(body).toContain('Templates/Habits/AI-Habits.md');
      const json = protocol === 'responses' ? { output: [{ type: 'function_call', name: 'create_habits', arguments: JSON.stringify(args) }] }
        : protocol === 'chat-completions' ? { choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ type: 'function', function: { name: 'create_habits', arguments: JSON.stringify(args) } }] } }] }
        : protocol === 'anthropic' ? { stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'create_habits', input: args }] }
        : { candidates: [{ finishReason: 'STOP', content: { parts: [{ functionCall: { name: 'create_habits', args } }] } }] };
      return { status: 200, json };
    }); expect(reply.habits).toEqual([draft]); expect(reply.tasks).toEqual([]);
  });
});
describe('habit creation transaction harness', () => {
  const path = habitPath(settings);
  async function preview(v: MemoryVault) {
    return createPreview(v, settings, now, v.tracking, false, [], [], { [path]: appendHabits(await v.read(path), [draft]) });
  }
  it('只读校验，再备份并同时写模板和七日日计划；重启撤销恢复全部', async () => {
    const v = new MemoryVault(); v.files = {}; const p = await preview(v);
    expect(p.result.errors).toEqual([]); expect(v.writes).toBe(0); expect(p.result.blocks).toHaveLength(7);
    await applyPreview(v, v, p, settings, now); expect(v.undo?.entries).toHaveLength(8);
    expect(v.files[path]).toContain('饭后慢走');
    const repeat = await createPreview(v, settings, now, v.tracking); expect(repeat.diff.added).toEqual([]);
    v.undo = JSON.parse(JSON.stringify(v.undo)); v.tracking = JSON.parse(JSON.stringify(v.tracking));
    await undoLast(v, v, v.undo); expect(v.files[path]).toBe('');
    expect(v.files['DailyNotes/2026-10-01.md']).toBe('# Day planner\n');
  });
  it('冲突时模板和日期文件都不写入', async () => {
    const v = new MemoryVault(); v.files['Scheduler/Fixed.md'] = '- 2026-10-01 19:00-19:30 会议';
    const p = await preview(v); expect(p.result.errors.some(e => e.message.toLowerCase().includes('conflict'))).toBe(true);
    await expect(applyPreview(v, v, p, settings, now)).rejects.toThrow('errors'); expect(v.files[path]).toBeUndefined(); expect(v.writes).toBe(0);
  });
  it('模板被并发创建或修改时不覆盖', async () => {
    const v = new MemoryVault(); const p = await preview(v); v.files[path] = '# 用户Edit';
    await expect(applyPreview(v, v, p, settings, now)).rejects.toThrow('changed'); expect(v.files[path]).toBe('# 用户Edit'); expect(v.writes).toBe(0);
  });
  it('限制模板写入路径到配置目录', async () => {
    await expect(createPreview(new MemoryVault(), settings, now, {}, false, [], [], { 'Other/Habits.md': appendHabits(null, [draft]) })).rejects.toThrow('only write');
  });
  it('中途写失败仍可恢复模板及已写日期文件', async () => {
    const v = new MemoryVault(); v.files = {}; const p = await preview(v);
    v.afterWrite = () => { v.failWrite = true; };
    await expect(applyPreview(v, v, p, settings, now)).rejects.toThrow('write failed'); expect(v.undo).not.toBeNull(); expect(v.files[path]).toContain('饭后慢走');
    v.failWrite = false; v.afterWrite = undefined; await undoLast(v, v, v.undo); expect(v.files[path]).toBe('');
  });
});
