import { describe, expect, it } from 'vitest';
import { NoteWorkspace } from '../src/note-workspace';
import { planSchedule, SCHEDULE_TOOL } from '../src/schedule-adapter';
import type { Tracking, Task, UndoRecord } from '../src/types';
import { config, MemoryVault, now } from './helpers';

class AdapterVault extends MemoryVault {
  aiTasks: Task[] = [];
  getAiTasks(): Task[] { return this.aiTasks; }
  getUndo(): UndoRecord | null { return this.undo; }
  override async saveUndo(record: UndoRecord | null, tracking?: Tracking, aiTasks?: Task[]): Promise<void> {
    await super.saveUndo(record, tracking);
    if (tracking !== undefined) this.tracking = structuredClone(tracking);
    if (aiTasks !== undefined) this.aiTasks = structuredClone(aiTasks);
  }
}

const settings = config({
  outputLocation: 'daily', outputMode: 'day-planner', dailyFolder: 'DailyNotes',
  periods: ['09:00-12:00'], dailyCapacity: 180, cleanDaily: false,
});

const task = (sourceRef: string | null, title = '同名任务') => ({
  id: null, sourceRef, title, minutes: 30, priority: 3, split: true, minMinutes: 15,
  due: null, earliest: null, dailyMinutes: null, estimateBasis: null, rollingMinutes: null,
});

async function read(vault: AdapterVault, workspace: NoteWorkspace, path: string): Promise<any> {
  const discovered = await workspace.execute('discover_notes', { paths: [path] }) as any;
  expect(discovered.ok).toBe(true);
  const result = await workspace.execute('read_note', { documentRef: discovered.value.documents[0].documentRef, mode: 'document' }) as any;
  expect(result.ok).toBe(true);
  return result.value;
}

describe('explicit schedule adapter', () => {
  it('stages duplicate-title tasks from arbitrary headings without editing the source or creating Tasks', async () => {
    const vault = new AdapterVault();
    const source = '# 自定义研究区\n- [ ] 同名任务\n\n## 任意标题\n- [ ] 同名任务';
    vault.files = { 'Research/Ideas.md': source, 'DailyNotes/2026-10-01.md': '# 日记\n保留原文' };
    const workspace = new NoteWorkspace(vault, vault, { folders: ['Research'], files: [], dailyFolder: 'DailyNotes' }, { now: () => now });
    const note = await read(vault, workspace, 'Research/Ideas.md');

    const legacySettings = config({ cleanDaily: false });
    const planned = await planSchedule(workspace, vault, vault, legacySettings, {
      mode: 'add', tasks: [task(note.blocks[0].blockRef), task(note.blocks[1].blockRef)], events: [], habitRefs: [],
    }, now, () => now) as any;

    expect(SCHEDULE_TOOL.name).toBe('plan_schedule');
    expect(planned.ok, JSON.stringify(planned)).toBe(true);
    expect(legacySettings.outputLocation).toBe('single');
    expect(legacySettings.outputMode).toBe('plain');
    expect(planned.value.blocks).toHaveLength(2);
    expect(planned.value.changes.map((change: any) => change.path)).toEqual(['DailyNotes/2026-10-01.md']);
    expect(planned.value.changes[0].after).not.toContain('# Tasks');
    expect(vault.files['Research/Ideas.md']).toBe(source);
    expect(vault.writes).toBe(0);

    const committed = await workspace.execute('commit_changes', { changeSetRef: planned.value.changeSetRef });
    expect(committed.ok).toBe(true);
    expect(committed.receipt?.status).toBe('committed');
    expect(vault.files['Research/Ideas.md']).toBe(source);
    expect(vault.files['DailyNotes/2026-10-01.md']).toContain('# Day planner');
    expect(vault.files['DailyNotes/2026-10-01.md']).not.toContain('# Tasks');
    expect(vault.aiTasks.map(item => item.path)).toEqual(['Research/Ideas.md', 'Research/Ideas.md']);
    expect(new Set(vault.aiTasks.map(item => item.id)).size).toBe(2);
    expect(vault.aiTasks.every(item => item.line === 0 && item.sourceText?.includes('- [ ] 同名任务'))).toBe(true);
  });

  it('uses explicit event and arbitrary habit references while writing only Day planner notes', async () => {
    const vault = new AdapterVault();
    const source = '# 可复用作息\n- 10:00-10:30 拉伸 (every day)';
    vault.files = {
      'Research/Routines.md': source,
      'Tasks/Hidden.md': '- [ ] 隐式任务 <!-- as id=hidden remaining=30 priority=3 -->',
      'Habits/Hidden.md': '- 09:00-09:30 隐式习惯 (every day)',
    };
    const workspace = new NoteWorkspace(vault, vault, { folders: ['Research'], files: [], dailyFolder: 'DailyNotes' }, { now: () => now });
    const note = await read(vault, workspace, 'Research/Routines.md');

    const planned = await planSchedule(workspace, vault, vault, settings, {
      mode: 'replan', tasks: [],
      events: [{ title: '明确会议', date: '2026-10-01', start: '11:00', minutes: 30 }],
      habitRefs: [note.blocks[0].blockRef],
    }, now, () => now) as any;

    expect(planned.ok).toBe(true);
    expect(planned.value.blocks.some((block: any) => block.title === '拉伸' && block.locked)).toBe(true);
    expect(planned.value.blocks.some((block: any) => ['隐式任务', '隐式习惯'].includes(block.title))).toBe(false);
    expect(planned.value.changes.every((change: any) => change.path.startsWith('DailyNotes/'))).toBe(true);
    expect(planned.value.changes.find((change: any) => change.path === 'DailyNotes/2026-10-01.md').after).toContain('明确会议');
    expect(vault.files['Research/Routines.md']).toBe(source);

    const committed = await workspace.execute('commit_changes', { changeSetRef: planned.value.changeSetRef });
    expect(committed.ok).toBe(true);
    expect(vault.files['Research/Routines.md']).toBe(source);
    expect(vault.files['DailyNotes/2026-10-01.md']).toContain('明确会议');
    expect(vault.files['DailyNotes/2026-10-01.md']).toContain('拉伸');
  });

  it('carries scheduler snapshots into the staged conflict check', async () => {
    const vault = new AdapterVault();
    vault.files = { 'Research/Ideas.md': '# 队列\n- [ ] 读取论文' };
    const workspace = new NoteWorkspace(vault, vault, { folders: ['Research'], files: [], dailyFolder: 'DailyNotes' }, { now: () => now });
    const note = await read(vault, workspace, 'Research/Ideas.md');
    const planned = await planSchedule(workspace, vault, vault, settings, {
      mode: 'add', tasks: [task(note.blocks[0].blockRef, '读取论文')], events: [], habitRefs: [],
    }, now, () => now) as any;
    expect(planned.ok).toBe(true);

    vault.files['Scheduler/Fixed.md'] = '- 2026-10-01 09:00-10:00 新日程';
    const committed = await workspace.execute('commit_changes', { changeSetRef: planned.value.changeSetRef });
    expect(committed.ok).toBe(false);
    expect(committed.receipt?.status).toBe('conflict');
    expect(committed.error).toContain('Scheduler/Fixed.md');
    expect(vault.writes).toBe(0);
    expect(vault.aiTasks).toEqual([]);
  });

  it('stages and commits an unscheduled source task as a durable state-only change', async () => {
    const vault = new AdapterVault();
    vault.files = { 'Research/Ideas.md': '# 队列\n- [ ] 大块工作' };
    const workspace = new NoteWorkspace(vault, vault, { folders: ['Research'], files: [], dailyFolder: 'DailyNotes' }, { now: () => now });
    const note = await read(vault, workspace, 'Research/Ideas.md');
    const constrained = config({ periods: ['09:00-09:15'], dailyCapacity: 15, cleanDaily: false });
    const planned = await planSchedule(workspace, vault, vault, constrained, {
      mode: 'add', tasks: [{ ...task(note.blocks[0].blockRef, '大块工作'), minMinutes: 30 }], events: [], habitRefs: [],
    }, now, () => now) as any;

    expect(planned.ok, JSON.stringify(planned)).toBe(true);
    expect(planned.value.blocks).toEqual([]);
    expect(planned.value.unscheduled).toHaveLength(1);
    expect(planned.value.changes).toEqual([]);
    const committed = await workspace.execute('commit_changes', { changeSetRef: planned.value.changeSetRef });
    expect(committed.ok).toBe(true);
    expect(committed.receipt?.status).toBe('committed');
    expect(committed.receipt?.changedFiles).toEqual([]);
    expect(vault.writes).toBe(0);
    expect(vault.aiTasks).toHaveLength(1);

    const undone = await workspace.execute('undo_operation', { operationId: committed.receipt?.operationId });
    expect(undone.ok).toBe(true);
    expect(vault.aiTasks).toEqual([]);
  });

  it('stages an identical replan and commits it as a no-op', async () => {
    const vault = new AdapterVault();
    vault.files = { 'Research/Ideas.md': '# 队列\n- [ ] 稳定任务' };
    const workspace = new NoteWorkspace(vault, vault, { folders: ['Research'], files: [], dailyFolder: 'DailyNotes' }, { now: () => now });
    const note = await read(vault, workspace, 'Research/Ideas.md');
    const first = await planSchedule(workspace, vault, vault, settings, {
      mode: 'add', tasks: [task(note.blocks[0].blockRef, '稳定任务')], events: [], habitRefs: [],
    }, now, () => now) as any;
    const firstCommit = await workspace.execute('commit_changes', { changeSetRef: first.value.changeSetRef });
    expect(firstCommit.ok).toBe(true);
    const writes = vault.writes;

    const existing = vault.aiTasks[0];
    const repeated = await planSchedule(workspace, vault, vault, settings, {
      mode: 'replan', tasks: [{ ...task(null, existing.title), id: existing.id }], events: [], habitRefs: [],
    }, now, () => now) as any;
    expect(repeated.ok, JSON.stringify(repeated)).toBe(true);
    expect(repeated.value.changes).toEqual([]);
    const committed = await workspace.execute('commit_changes', { changeSetRef: repeated.value.changeSetRef });
    expect(committed.ok).toBe(true);
    expect(committed.receipt?.status).toBe('noop');
    expect(vault.writes).toBe(writes);
  });

  it('rejects commit when a newly scheduled task block has passed', async () => {
    const vault = new AdapterVault();
    vault.files = { 'Research/Ideas.md': '# 队列\n- [ ] 即将开始' };
    const workspace = new NoteWorkspace(vault, vault, { folders: ['Research'], files: [], dailyFolder: 'DailyNotes' }, { now: () => now });
    const note = await read(vault, workspace, 'Research/Ideas.md');
    let current = now;
    const planned = await planSchedule(workspace, vault, vault, settings, {
      mode: 'add', tasks: [task(note.blocks[0].blockRef, '即将开始')], events: [], habitRefs: [],
    }, now, () => current) as any;
    expect(planned.ok).toBe(true);

    current = new Date('2026-10-01T09:01:00+08:00');
    const committed = await workspace.execute('commit_changes', { changeSetRef: planned.value.changeSetRef });
    expect(committed.ok).toBe(false);
    expect(committed.error).toContain('new block has passed');
    expect(vault.writes).toBe(0);
    expect(vault.aiTasks).toEqual([]);
  });

  it('rejects commit when an explicit event start has passed', async () => {
    const vault = new AdapterVault();
    vault.files = {};
    const workspace = new NoteWorkspace(vault, vault, { folders: [], files: [], dailyFolder: 'DailyNotes' }, { now: () => now });
    let current = now;
    const planned = await planSchedule(workspace, vault, vault, settings, {
      mode: 'replan', tasks: [], events: [{ title: '过期会议', date: '2026-10-01', start: '11:00', minutes: 30 }], habitRefs: [],
    }, now, () => current) as any;
    expect(planned.ok).toBe(true);

    current = new Date('2026-10-01T11:01:00+08:00');
    const committed = await workspace.execute('commit_changes', { changeSetRef: planned.value.changeSetRef });
    expect(committed.ok).toBe(false);
    expect(committed.error).toContain('new event has passed');
    expect(vault.writes).toBe(0);
  });

  it('commits a generic heading edit and event as one operation and undoes both', async () => {
    const vault = new AdapterVault();
    const original = '# 自定义记录\n保留内容';
    vault.files = { 'DailyNotes/2026-10-01.md': original };
    const workspace = new NoteWorkspace(vault, vault, { folders: [], files: [], dailyFolder: 'DailyNotes' }, { now: () => now });
    const note = await read(vault, workspace, 'DailyNotes/2026-10-01.md');
    const edited = await workspace.execute('stage_note_changes', {
      changes: [{ operation: 'insert', targetRef: note.sections[0].sectionRef, position: 'append', content: '- [ ] 新增记录' }],
      summary: 'Add an item under the custom heading',
    }) as any;
    expect(edited.ok).toBe(true);

    const planned = await planSchedule(workspace, vault, vault, settings, {
      mode: 'replan', tasks: [], events: [{ title: '组合会议', date: '2026-10-01', start: '11:00', minutes: 30 }], habitRefs: [],
      changeSetRef: edited.value.changeSetRef,
    }, now, () => now) as any;
    expect(planned.ok, JSON.stringify(planned)).toBe(true);
    expect(planned.value.changes).toHaveLength(1);
    expect(planned.value.changes[0].after).toContain('# 自定义记录');
    expect(planned.value.changes[0].after).toContain('- [ ] 新增记录');
    expect(planned.value.changes[0].after).toContain('组合会议');
    expect(vault.files['DailyNotes/2026-10-01.md']).toBe(original);

    const committed = await workspace.execute('commit_changes', { changeSetRef: planned.value.changeSetRef });
    expect(committed.ok).toBe(true);
    expect(committed.receipt?.changedFiles).toEqual(['DailyNotes/2026-10-01.md']);
    expect(vault.files['DailyNotes/2026-10-01.md']).toContain('- [ ] 新增记录');
    expect(vault.files['DailyNotes/2026-10-01.md']).toContain('组合会议');

    const undone = await workspace.execute('undo_operation', { operationId: committed.receipt?.operationId });
    expect(undone.ok).toBe(true);
    expect(vault.files['DailyNotes/2026-10-01.md']).toBe(original);
  });

  it('rejects composition when a staged edit changed a referenced source block', async () => {
    const vault = new AdapterVault();
    vault.files = { 'Research/Ideas.md': '# 队列\n- [ ] 原任务' };
    const workspace = new NoteWorkspace(vault, vault, { folders: ['Research'], files: [], dailyFolder: 'DailyNotes' }, { now: () => now });
    const note = await read(vault, workspace, 'Research/Ideas.md');
    const edited = await workspace.execute('stage_note_changes', {
      changes: [{ operation: 'replace', targetRef: note.blocks[0].blockRef, content: '- [ ] 已改名任务' }],
      summary: 'Rename source',
    }) as any;

    const planned = await planSchedule(workspace, vault, vault, settings, {
      mode: 'add', tasks: [task(note.blocks[0].blockRef, '原任务')], events: [], habitRefs: [], changeSetRef: edited.value.changeSetRef,
    }, now, () => now);
    expect(planned.ok).toBe(false);
    expect(planned.error).toContain('changed the referenced source block');
    expect(vault.writes).toBe(0);
  });
});
