import { describe, expect, it } from 'vitest';
import { createPreview, applyPreview, undoLast } from '../src/transaction';
import { cleanDaily, rehydrate } from '../src/tracking';
import { dailyDocument, renderDaily } from '../src/daily';
import { block, config, MemoryVault, now } from './helpers';
const settings = () => config({ outputLocation: 'daily', outputMode: 'day-planner', cleanDaily: true });
const preview = (v: MemoryVault) => createPreview(v, settings(), now, v.tracking);
describe('Clean daily lists与插件跟踪', () => {
  it('迁移旧前缀与重要性时保持完成状态、时间，撤销后旧跟踪仍有效', async () => {
    const vault = new MemoryVault();
    vault.files['Tasks/A.md'] = vault.files['Tasks/A.md'].replace('priority=3', 'priority=5');
    const annotated = renderDaily(dailyDocument(null), [block({ locked: false })], 'day-planner')
      .replace('🔼 分析', '工作块：分析').replace('- [ ]', '- [x]');
    const original = cleanDaily(annotated, new Set(), new Map(), false);
    vault.files['DailyNotes/2026-10-01.md'] = original.text;
    vault.tracking['DailyNotes/2026-10-01.md'] = { before: null, after: original.record };
    const p = await createPreview(vault, settings(), now, vault.tracking, true);
    expect(p.result.errors).toEqual([]);
    await applyPreview(vault, vault, p, settings(), now);
    expect(vault.files['DailyNotes/2026-10-01.md']).toContain('- [x] 09:00 - 10:00 🔺 分析');
    expect(vault.files['DailyNotes/2026-10-01.md']).not.toContain('工作块：');
    expect((await preview(vault)).result.errors).toEqual([]);
    await undoLast(vault, vault, vault.undo);
    expect(vault.files['DailyNotes/2026-10-01.md']).toBe(original.text);
    expect((await preview(vault)).result.errors).toEqual([]);
  });
  it('无前缀的生成任务被手动改名时仍拒绝覆盖', async () => {
    const vault = new MemoryVault(); await applyPreview(vault, vault, await preview(vault), settings(), now);
    vault.files['DailyNotes/2026-10-01.md'] = vault.files['DailyNotes/2026-10-01.md'].replace('分析', '手动改名');
    expect((await preview(vault)).result.errors[0].message).toContain('refusing to overwrite');
  });
  it('输出无管理注释、日期和工作块元数据，保留来源链接', async () => {
    const vault = new MemoryVault(), p = await preview(vault);
    expect(p.output).not.toContain('<!--'); expect(p.output).not.toContain('scheduled::'); expect(p.output).not.toContain('as-block');
    await applyPreview(vault, vault, p, settings(), now);
    expect(vault.files['DailyNotes/2026-10-01.md']).toContain('# Day planner\n- [ ] 09:00 - 10:00');
    expect(vault.files['DailyNotes/2026-10-01.md']).toContain('[[Tasks/A]]');
    expect(vault.tracking['DailyNotes/2026-10-01.md'].after?.annotated).toContain('as-block');
  });
  it('重启加载插件数据后重复应用不重复导入，不写 Markdown', async () => {
    const vault = new MemoryVault(); await applyPreview(vault, vault, await preview(vault), settings(), now);
    vault.tracking = JSON.parse(JSON.stringify(vault.tracking));
    const p = await preview(vault); expect(p.result.errors).toEqual([]); expect(p.diff.added).toEqual([]);
    expect(await applyPreview(vault, vault, p, settings(), now)).toEqual({ changed: false }); expect(vault.writes).toBe(1);
  });
  it('完成勾选保留，管理区域外备注可Edit并保留', async () => {
    const vault = new MemoryVault(); await applyPreview(vault, vault, await preview(vault), settings(), now);
    vault.files['DailyNotes/2026-10-01.md'] = vault.files['DailyNotes/2026-10-01.md'].replace('- [ ]', '- [x]') + '\n# 日记\n保留备注\n';
    const p = await preview(vault); expect(p.result.errors).toEqual([]); expect(p.result.blocks[0].completed).toBe(true);
    expect(p.output).toContain('- [x]'); expect(p.output).toContain('# 日记\n保留备注');
  });
  it('无法核对时间修改或重复区域时拒绝覆盖', async () => {
    const vault = new MemoryVault(); await applyPreview(vault, vault, await preview(vault), settings(), now);
    vault.files['DailyNotes/2026-10-01.md'] = vault.files['DailyNotes/2026-10-01.md'].replace('09:00', '10:00');
    const p = await preview(vault); expect(p.result.errors[0].message).toContain('refusing to overwrite');
    await expect(applyPreview(vault, vault, p, settings(), now)).rejects.toThrow('errors');
  });
  it('旧 HTML 输出迁移时保留原字节备注，备份仍可撤销', async () => {
    const vault = new MemoryVault(); const old = renderDaily(dailyDocument('# Day planner\n# 日记\n备注'), [block({ id: 'a_block', locked: false })], 'day-planner');
    vault.files['DailyNotes/2026-10-01.md'] = old;
    const p = await preview(vault); expect(p.result.errors).toEqual([]);
    await applyPreview(vault, vault, p, settings(), now); expect(vault.files['DailyNotes/2026-10-01.md']).not.toContain('<!--');
    await undoLast(vault, vault, vault.undo); expect(vault.files['DailyNotes/2026-10-01.md']).toBe(old);
  });
  it('备份失败不写文件；部分批量失败可恢复跟踪和文件', async () => {
    const vault = new MemoryVault(); vault.files['Tasks/A.md'] = '- [ ] 工作 <!-- as id=a remaining=360 priority=3 -->';
    vault.failBackup = true; await expect(applyPreview(vault, vault, await preview(vault), settings(), now)).rejects.toThrow('backup'); expect(vault.writes).toBe(0);
    vault.failBackup = false; vault.afterWrite = () => { vault.failWrite = true; };
    await expect(applyPreview(vault, vault, await preview(vault), settings(), now)).rejects.toThrow('write failed');
    vault.failWrite = false; vault.afterWrite = undefined;
    expect((await preview(vault)).result.errors).toEqual([]);
    await undoLast(vault, vault, vault.undo);
    expect(vault.files['DailyNotes/2026-10-01.md']).toBe('# Day planner\n');
    expect((await preview(vault)).result.errors).toEqual([]);
  });
  it('撤销已有纯列表写入时恢复旧跟踪，重试后无重复', async () => {
    const vault = new MemoryVault(); await applyPreview(vault, vault, await preview(vault), settings(), now);
    const first = vault.files['DailyNotes/2026-10-01.md'];
    vault.files['Tasks/A.md'] = vault.files['Tasks/A.md'].replace('remaining=60', 'remaining=120');
    await applyPreview(vault, vault, await preview(vault), settings(), now);
    await undoLast(vault, vault, vault.undo); expect(vault.files['DailyNotes/2026-10-01.md']).toBe(first);
    expect((await preview(vault)).result.errors).toEqual([]);
  });
  it('格式清理保留已过去的时间，不重新排程', async () => {
    const vault = new MemoryVault();
    vault.files['DailyNotes/2026-10-01.md'] = renderDaily(dailyDocument(null), [block({ locked: false })], 'day-planner');
    const late = new Date('2026-10-01T20:00:00+08:00');
    const p = await createPreview(vault, settings(), late, vault.tracking, true);
    expect(p.result.errors).toEqual([]); expect(p.diff.added).toHaveLength(0); expect(p.output).toContain('09:00 - 10:00');
    await applyPreview(vault, vault, p, settings(), late);
    expect(vault.files['DailyNotes/2026-10-01.md']).toContain('09:00 - 10:00');
    expect(vault.files['DailyNotes/2026-10-01.md']).not.toContain('<!--');
  });
  it('丢失跟踪数据后旧普通行作为手写占用，不自动接管', () => {
    const clean = cleanDaily(renderDaily(dailyDocument(null), [block()], 'day-planner'));
    expect(rehydrate(clean.text)).toBe(clean.text);
    expect(rehydrate(clean.text, { before: null, after: clean.record })).toContain('as-block');
  });
});

it('keeps a concise clock range without calendar endpoints and round-trips completion',()=>{
  const text=renderDaily(dailyDocument(null),[block({locked:false})],'day-planner');
  const output=cleanDaily(text,new Set(),new Map(),true,new Map());
  expect(output.text).not.toMatch(/[🛫⏳]/u);
  expect(output.text).toContain('09:00 - 10:00');
  expect(output.text).not.toContain('📅');
  expect(rehydrate(output.text.replace('- [ ]','- [x]'),{before:null,after:output.record})).toContain('- [x]');
});


it('does not display the scheduling end constraint of a habit as a deadline',async()=>{
  const vault=new MemoryVault();vault.files={'Habits/Walk.md':'# Walk\n- 12:40-13:10 🔼 Lunch walk (Sun, Mon, Tue, Wed, Thu, Fri, Sat)\n'};
  const p=await preview(vault);expect(p.result.errors).toEqual([]);
  await applyPreview(vault,vault,p,settings(),now);
  const note=vault.files['DailyNotes/2026-10-01.md'];
  expect(note).toContain('- [ ] 12:40 - 13:10 🔼 Lunch walk');
  expect(note).not.toMatch(/[📅🛫⏳]/u);
});
