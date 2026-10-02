import { describe, expect, it } from 'vitest';
import { applyPreview, createPreview, undoLast } from '../src/transaction';
import { END, START, emptyManagedFile, parseOutput } from '../src/output';
import { config, MemoryVault, now } from './helpers';
describe('预览、应用、撤销', () => {
  it('预览只读，应用与预览一致且不改源任务', async () => {
    const vault = new MemoryVault(); const source = vault.files['Tasks/A.md'];
    const preview = await createPreview(vault, config(), now);
    expect(vault.writes).toBe(0); expect(preview.result.errors).toEqual([]);
    await applyPreview(vault, vault, preview, config(), now);
    expect(vault.files['Scheduler/Schedule.md']).toBe(preview.output); expect(vault.files['Tasks/A.md']).toBe(source);
  });
  it('重复预览/应用不重复写，也不覆盖撤销记录', async () => {
    const vault = new MemoryVault();
    await applyPreview(vault, vault, await createPreview(vault, config(), now), config(), now);
    const backup = vault.undo;
    const preview = await createPreview(vault, config(), now);
    expect(preview.diff.added).toEqual([]); expect(preview.diff.removed).toEqual([]);
    expect(await applyPreview(vault, vault, preview, config(), now)).toEqual({ changed: false });
    expect(vault.writes).toBe(1); expect(vault.undo).toEqual(backup);
  });
  it.each(['修改任务', '增加任务文件', '删除任务文件', '修改固定日程', '输出被其他操作创建'])('快照失效拒绝：%s', async mode => {
    const vault = new MemoryVault(); const preview = await createPreview(vault, config(), now);
    if (mode === '修改任务') vault.files['Tasks/A.md'] += '\n';
    if (mode === '增加任务文件') vault.files['Tasks/B.md'] = '普通新笔记';
    if (mode === '删除任务文件') delete vault.files['Tasks/A.md'];
    if (mode === '修改固定日程') vault.files['Scheduler/Fixed.md'] = '- 2026-10-01 09:00-10:00 会议';
    if (mode === '输出被其他操作创建') vault.files['Scheduler/Schedule.md'] = emptyManagedFile();
    await expect(applyPreview(vault, vault, preview, config(), now)).rejects.toThrow('changed'); expect(vault.writes).toBe(0);
  });
  it('设置变化和预览过期拒绝应用', async () => {
    const vault = new MemoryVault(); const preview = await createPreview(vault, config(), now);
    await expect(applyPreview(vault, vault, preview, config({ dailyCapacity: 60 }), now)).rejects.toThrow('Settings');
    await expect(applyPreview(vault, vault, preview, config(), new Date('2026-10-02T08:00:00+08:00'))).rejects.toThrow('date');
    await expect(applyPreview(vault, vault, preview, config(), new Date('2026-10-01T09:01:00+08:00'))).rejects.toThrow('start time');
  });
  it('拒绝有非法任务元数据的预览', async () => {
    const vault = new MemoryVault(); vault.files['Tasks/A.md'] += '\n- [ ] 非法 <!-- as id=b remaining=5 priority=3 -->';
    const preview = await createPreview(vault, config(), now); expect(preview.result.errors.length).toBeGreaterThan(0);
    await expect(applyPreview(vault, vault, preview, config(), now)).rejects.toThrow('errors'); expect(vault.writes).toBe(0);
  });
  it('普通同名笔记不会被接管', async () => {
    const vault = new MemoryVault(); vault.files['Scheduler/Schedule.md'] = '用户笔记';
    const preview = await createPreview(vault, config(), now); expect(preview.output).toBeNull(); expect(vault.files['Scheduler/Schedule.md']).toBe('用户笔记');
  });
  it('备份保存失败时禁止写入', async () => {
    const vault = new MemoryVault(); vault.failBackup = true;
    await expect(applyPreview(vault, vault, await createPreview(vault, config(), now), config(), now)).rejects.toThrow('backup'); expect(vault.writes).toBe(0);
  });
  it('写失败时保留恢复记录', async () => {
    const vault = new MemoryVault(); vault.failWrite = true;
    await expect(applyPreview(vault, vault, await createPreview(vault, config(), now), config(), now)).rejects.toThrow('write failed'); expect(vault.undo).not.toBeNull();
  });
  it('写回前的输出并发变化由原子检查拒绝，不能覆盖', async () => {
    const vault = new MemoryVault(); vault.files['Scheduler/Schedule.md'] = emptyManagedFile();
    const preview = await createPreview(vault, config(), now);
    vault.beforeWrite = () => { vault.files['Scheduler/Schedule.md'] += '\n用户新增内容'; };
    await expect(applyPreview(vault, vault, preview, config(), now)).rejects.toThrow('conflict'); expect(vault.files['Scheduler/Schedule.md']).toContain('用户新增内容');
  });
  it('跨文件并发窗口写后检测并提示', async () => {
    const vault = new MemoryVault(); const preview = await createPreview(vault, config(), now);
    vault.afterWrite = () => { vault.files['Tasks/A.md'] += '\n'; };
    expect((await applyPreview(vault, vault, preview, config(), now)).warning).toContain('while writing');
  });
  it('重启后加载备份可撤销已有输出，恢复字节内容', async () => {
    const vault = new MemoryVault(); const original = `前言\r\n${START}\r\n\r\n${END}\r\n后记`;
    vault.files['Scheduler/Schedule.md'] = original;
    await applyPreview(vault, vault, await createPreview(vault, config(), now), config(), now);
    const record = JSON.parse(JSON.stringify(vault.undo));
    await undoLast(vault, vault, record); expect(vault.files['Scheduler/Schedule.md']).toBe(original); expect(vault.undo).toBeNull();
  });
  it('新建输出的撤销保留空管理文件，不删除', async () => {
    const vault = new MemoryVault(); await applyPreview(vault, vault, await createPreview(vault, config(), now), config(), now);
    await undoLast(vault, vault, vault.undo); expect(parseOutput(vault.files['Scheduler/Schedule.md']).blocks).toEqual([]);
  });
  it('撤销拒绝覆盖用户或 Day Planner 后续修改', async () => {
    const vault = new MemoryVault(); await applyPreview(vault, vault, await createPreview(vault, config(), now), config(), now);
    vault.files['Scheduler/Schedule.md'] += '\n手动修改';
    await expect(undoLast(vault, vault, vault.undo)).rejects.toThrow('refusing to overwrite'); expect(vault.undo).not.toBeNull();
  });
  it('保护管理区外文字并排除输出自导入', async () => {
    const vault = new MemoryVault(); const settings = config({ outputFile: 'Tasks/Schedule.md', outputMode: 'day-planner' });
    vault.files['Tasks/Schedule.md'] = `前言\n${START}\n\n${END}\n尾注`;
    const preview = await createPreview(vault, settings, now); expect(preview.result.errors).toEqual([]);
    await applyPreview(vault, vault, preview, settings, now); expect(vault.files['Tasks/Schedule.md'].startsWith('前言\n')).toBe(true); expect(vault.files['Tasks/Schedule.md'].endsWith('\n尾注')).toBe(true);
    expect((await createPreview(vault, settings, now)).result.errors).toEqual([]);
  });
});
