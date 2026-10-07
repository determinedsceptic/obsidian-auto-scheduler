import { describe, expect, it } from 'vitest';
import { createAgentSession } from '../src/plugin-agent';
import { runAgent } from '../src/agent-harness';
import { validUndoRecord } from '../src/undo-record';
import { applyPreview, createPreview, undoLast } from '../src/transaction';
import type { LlmSettings, Task, Tracking, UndoRecord } from '../src/types';
import type { ToolResult } from '../src/agent-types';
import { config, MemoryVault, now } from './helpers';

class DurableVault extends MemoryVault {
  aiTasks: Task[] = [];
  getUndo() { return this.undo; }
  getAiTasks() { return this.aiTasks; }
  override async saveUndo(record: UndoRecord | null, tracking?: Tracking, aiTasks?: Task[]) {
    if (this.failBackup) throw Error('backup failed');
    this.undo = structuredClone(record);
    if (tracking !== undefined) this.tracking = structuredClone(tracking);
    if (aiTasks !== undefined) this.aiTasks = structuredClone(aiTasks);
  }
}
const protocols = ['responses', 'chat-completions', 'anthropic', 'gemini'] as const;
type Call = { name: string; args: unknown };
function calls(protocol: LlmSettings['protocol'], items: Call[], turn: number): unknown {
  const id = (index: number) => `call-${turn}-${index}`;
  if (protocol === 'responses') return { output: items.map((item, index) => ({ type: 'function_call', call_id: id(index), name: item.name, arguments: JSON.stringify(item.args) })) };
  if (protocol === 'chat-completions') return { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: items.map((item, index) => ({ type: 'function', id: id(index), function: { name: item.name, arguments: JSON.stringify(item.args) } })) } }] };
  if (protocol === 'anthropic') return { stop_reason: 'tool_use', content: items.map((item, index) => ({ type: 'tool_use', id: id(index), name: item.name, input: item.args })) };
  return { candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: items.map((item, index) => ({ functionCall: { id: id(index), name: item.name, args: item.args } })) } }] };
}
function final(protocol: LlmSettings['protocol'], text: string) {
  if (protocol === 'responses') return { output: [{ type: 'message', content: [{ type: 'output_text', text }] }] };
  if (protocol === 'chat-completions') return { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: text } }] };
  if (protocol === 'anthropic') return { stop_reason: 'end_turn', content: [{ type: 'text', text }] };
  return { candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ text }] } }] };
}
const scope = { folders: [] as string[], files: [] as string[], dailyFolder: 'DailyNotes' };
async function session(vault: DurableVault, files: string[] = [], skills: string[] = []) {
  return createAgentSession(vault, vault, config(), { ...scope, files }, skills, work => work(), now, () => now);
}

describe('real generic plugin agent integration', () => {
  for (const protocol of protocols) for (const heading of ['# Tasks', '## 待办', '## Research', '### 自定义清单']) {
    it(`${protocol}: copies ${heading} to seven following dates, preserves source and calendar, then undoes`, async () => {
      const vault = new DurableVault();
      const dates = Array.from({ length: 8 }, (_, index) => `2026-10-${String(index + 1).padStart(2, '0')}`);
      const original = `---\r\nkind: daily\r\n---\r\n${heading}\r\n- [ ] 原任务 📅 2026-10-20\r\n  - 子项\r\n\r\n# Day planner\r\n- [ ] 10:00 - 11:00 固定会议\r\n# 日记\r\n保留文字\r\n`;
      vault.files = Object.fromEntries(dates.slice(0, 7).map((date, index) => [`DailyNotes/${date}.md`, index ? `${heading}\n- [ ] 已有条目\n\n# Day planner\n- [ ] 10:00 - 11:00 原日程\n# 日记\n保留目标文字\n` : original]));
      const before = structuredClone(vault.files);
      const agent = await session(vault);
      const observed: { name: string; result: ToolResult }[] = [];
      const execute = agent.runtime.execute;
      agent.runtime.execute = async (name, args) => {
        const result = await execute(name, args); observed.push({ name, result });
        expect(result.ok, JSON.stringify(result)).toBe(true); return result;
      };
      let turn = 0;
      let notes: any[] = [];
      const result = await runAgent({ protocol, baseUrl: 'https://fixture.test/v1', model: 'fixture', requiresKey: false }, '', [{ role: 'user', content: '复制今天清单到之后七天' }], agent.instructions, agent.runtime, async (_url, _headers, body) => {
        turn++;
        let next: Call[];
        if (turn === 1) next = [{ name: 'discover_notes', args: { dates } }];
        else if (turn === 2) {
          const documents = (observed.at(-1)!.result.value as any).documents;
          next = documents.map((doc: any) => ({ name: 'read_note', args: { documentRef: doc.documentRef, mode: 'document' } }));
        } else if (turn === 3) {
          notes = observed.filter(item => item.name === 'read_note').map(item => item.result.value);
          next = [{ name: 'read_note', args: { documentRef: notes[0].documentRef, mode: 'section', ref: notes[0].sections.find((section: any) => section.title === heading.replace(/^#+ /, '')).sectionRef } }];
        } else if (turn === 4) {
          const source = observed.at(-1)!.result.value as any;
          const content = source.content.slice(source.content.indexOf('\n') + 1);
          next = [{ name: 'stage_note_changes', args: { summary: '复制七天，保留源清单', changes: notes.slice(1).map(note => {
            const section = note.sections.find((section: any) => section.title === heading.replace(/^#+ /, ''));
            return { operation: 'insert', targetRef: section?.sectionRef ?? note.documentRef, position: 'end', content: section ? content : source.content };
          }) } }];
        } else if (turn === 5) next = [{ name: 'commit_changes', args: { changeSetRef: (observed.at(-1)!.result.value as any).changeSetRef } }];
        else {
          expect(body).toContain('committed');
          expect(body).toContain('undoAvailable');
          return { status: 200, json: final(protocol, '已复制，原清单保留。') };
        }
        return { status: 200, json: calls(protocol, next, turn) };
      });
      expect(result.error).toBeUndefined();
      expect(result.receipts[0].changedFiles).toHaveLength(7);
      expect(vault.files['DailyNotes/2026-10-01.md']).toBe(original);
      for (const date of dates.slice(1)) {
        const content = vault.files[`DailyNotes/${date}.md`];
        expect(content).toContain('- [ ] 原任务 📅 2026-10-20');
        expect(content).toContain('  - 子项');
        if (date !== dates.at(-1)) expect(content).toContain('# Day planner\n- [ ] 10:00 - 11:00 原日程\n# 日记\n保留目标文字\n');
      }
      expect(vault.aiTasks).toEqual([]);
      expect(observed.some(item => item.name === 'plan_schedule')).toBe(false);
      expect(validUndoRecord(vault.undo)).toBe(true);
      const restarted = await session(vault);
      const undone = await restarted.runtime.execute('undo_operation', { operationId: vault.undo!.operationId });
      expect(undone.ok).toBe(true);
      for (const [path, content] of Object.entries(before)) expect(vault.files[path]).toBe(content);
      expect(vault.files['DailyNotes/2026-10-08.md']).toBe('');
      expect(vault.undo).toBeNull();
      expect((await restarted.runtime.execute('undo_operation', { operationId: undone.receipt!.operationId })).ok).toBe(false);
    });
  }

  it('reloads configured skills each send and exposes a usable legacy operation ID', async () => {
    const vault = new DurableVault();
    vault.files = { 'Rules/Editing.md': 'Use the existing heading.', 'DailyNotes/2026-10-01.md': 'after' };
    vault.undo = { path: 'DailyNotes/2026-10-01.md', before: 'before', after: 'after', createdAt: now.toISOString() };
    const first = await session(vault, [], ['Rules/Editing.md']);
    vault.files['Rules/Editing.md'] = 'Use my new editing rule.';
    const second = await session(vault, [], ['Rules/Editing.md']);
    expect(first.instructions).toContain('Use the existing heading.');
    expect(second.instructions).toContain('Use my new editing rule.');
    expect(second.skillVersions).not.toEqual(first.skillVersions);
    const operationId = /"operationId":"([^"]+)"/.exec(second.instructions)![1];
    expect(operationId).toMatch(/^legacy_/);
    expect((await second.runtime.execute('undo_operation', { operationId })).ok).toBe(true);
  });

  it('enforces current-note scope and blocks generic calendar edits without changing ordinary paragraphs', async () => {
    const vault = new DurableVault();
    vault.files = { 'Research/Open.md': '# 内容\n保留\n# Day planner\n- [ ] 10:00 - 11:00 原日程\n', 'Private/Other.md': 'not authorized' };
    const agent = await session(vault, ['Research/Open.md']);
    expect((await agent.runtime.execute('discover_notes', { paths: ['Private/Other.md'] })).ok).toBe(false);
    expect((await agent.runtime.execute('discover_notes', { paths: ['.obsidian/plugins/auto-scheduler/data.md'] })).ok).toBe(false);
    const found = await agent.runtime.execute('discover_notes', { paths: ['Research/Open.md'] });
    const doc = (await agent.runtime.execute('read_note', { documentRef: (found.value as any).documents[0].documentRef, mode: 'document' })).value as any;
    const blocked = await agent.runtime.execute('stage_note_changes', { changes: [{ operation: 'replace', targetRef: doc.sections[1].sectionRef, content: '# Day planner\n- [ ] 12:00 - 13:00 新日程\n' }] });
    expect(blocked.ok).toBe(false);
    const staged = await agent.runtime.execute('stage_note_changes', { changes: [{ operation: 'insert', targetRef: doc.sections[0].sectionRef, position: 'end', content: '新增普通文字\n' }] });
    expect(staged.ok).toBe(true);
    expect((await agent.runtime.execute('commit_changes', { changeSetRef: (staged.value as any).changeSetRef })).ok).toBe(true);
    expect(vault.files['Research/Open.md']).toContain('新增普通文字\n# Day planner\n- [ ] 10:00 - 11:00 原日程');
    expect(vault.aiTasks).toEqual([]);
  });

  it('keeps legacy preview commits locked during generic partial recovery', async () => {
    const vault = new DurableVault();
    const preview = await createPreview(vault, config(), now);
    vault.undo = { path: 'Tasks/A.md', before: null, after: vault.files['Tasks/A.md'], status: 'partial', createdAt: now.toISOString() };
    await expect(applyPreview(vault, vault, preview, config(), now)).rejects.toThrow('partial write');
    expect(vault.writes).toBe(0);
  });

  it('combines creation of a new custom note with an event in one commit and undo', async () => {
    const vault = new DurableVault(); vault.files = {};
    const agent = await session(vault);
    const discovered = await agent.runtime.execute('discover_notes', { dates: ['2026-10-01'] });
    const documentRef = (discovered.value as any).documents[0].documentRef;
    const staged = await agent.runtime.execute('stage_note_changes', { changes: [{ operation: 'insert', targetRef: documentRef, position: 'end', content: '## 我的内容\n保留清单\n' }] });
    const planned = await agent.runtime.execute('plan_schedule', { mode: 'add', changeSetRef: (staged.value as any).changeSetRef, tasks: [], habitRefs: [], events: [{ title: '会议', date: '2026-10-01', start: '11:00', minutes: 30 }] });
    expect(planned.ok, JSON.stringify(planned)).toBe(true);
    expect(vault.writes).toBe(0);
    const committed = await agent.runtime.execute('commit_changes', { changeSetRef: (planned.value as any).changeSetRef });
    expect(committed.receipt?.changedFiles).toEqual(['DailyNotes/2026-10-01.md']);
    expect(vault.files['DailyNotes/2026-10-01.md']).toContain('## 我的内容\n保留清单');
    expect(vault.files['DailyNotes/2026-10-01.md']).toContain('11:00 - 11:30 会议');
    expect((await agent.runtime.execute('undo_operation', { operationId: committed.receipt!.operationId })).ok).toBe(true);
    expect(vault.files['DailyNotes/2026-10-01.md']).toBe('');
  });

  it.each(['x', 'X'])('does not schedule checked %s source items or implicitly import folder tasks', async checked => {
    const vault = new DurableVault();
    vault.files = { 'Research/Open.md': `## 任意标题\n- [${checked}] 已完成\n  - 子项\n- [ ] 下一项\n`, 'Tasks/Unselected.md': '- [ ] 不应排程 <!-- as id=other remaining=30 priority=3 -->' };
    const agent = await session(vault, ['Research/Open.md']);
    const found = await agent.runtime.execute('discover_notes', { paths: ['Research/Open.md'] });
    const doc = (await agent.runtime.execute('read_note', { documentRef: (found.value as any).documents[0].documentRef, mode: 'document' })).value as any;
    expect(doc.blocks).toHaveLength(2);
    const planned = await agent.runtime.execute('plan_schedule', { mode: 'add', changeSetRef: null, habitRefs: [], events: [], tasks: [{ id: null, sourceRef: doc.blocks[0].blockRef, title: '已完成', minutes: 30, priority: 3, split: true, minMinutes: 15, due: null, earliest: null, dailyMinutes: null, estimateBasis: null, rollingMinutes: null }] });
    expect(planned.ok).toBe(false);
    expect(planned.error).toContain('new scheduled task needs an open source');
    expect(vault.aiTasks).toEqual([]);
    expect(vault.writes).toBe(0);
    expect(vault.files['Research/Open.md']).toContain(`- [${checked}] 已完成`);
  });

  it('retains temporal validation when composing multiple scheduling stages', async () => {
    const vault = new DurableVault(); vault.files = {};
    let current = now;
    const agent = await createAgentSession(vault, vault, config(), scope, [], work => work(), now, () => current);
    const first = await agent.runtime.execute('plan_schedule', { mode: 'add', changeSetRef: null, tasks: [], habitRefs: [], events: [{ title: '会议', date: '2026-10-01', start: '11:00', minutes: 30 }] });
    expect(first.ok).toBe(true);
    const second = await agent.runtime.execute('plan_schedule', { mode: 'replan', changeSetRef: (first.value as any).changeSetRef, tasks: [], habitRefs: [], events: [] });
    expect(second.ok, JSON.stringify(second)).toBe(true);
    current = new Date('2026-10-01T11:01:00+08:00');
    const committed = await agent.runtime.execute('commit_changes', { changeSetRef: (second.value as any).changeSetRef });
    expect(committed.ok).toBe(false);
    expect(committed.error).toContain('start time');
    expect(vault.writes).toBe(0);
    expect(vault.undo).toBeNull();
  });

  it('retains recovery when the host writes a file before reporting a failure', async () => {
    class LateFailureVault extends DurableVault {
      failAfterWrite = true;
      override async writeChecked(path: string, before: string | null, after: string) {
        await super.writeChecked(path, before, after);
        if (this.failAfterWrite) throw Error('write failed after mutation');
      }
    }
    const vault = new LateFailureVault(); vault.files = { 'Research/Open.md': 'before' };
    const agent = await session(vault, ['Research/Open.md']);
    const found = await agent.runtime.execute('discover_notes', { paths: ['Research/Open.md'] });
    const documentRef = (found.value as any).documents[0].documentRef;
    await agent.runtime.execute('read_note', { documentRef, mode: 'document' });
    const staged = await agent.runtime.execute('stage_note_changes', { changes: [{ operation: 'replace', targetRef: documentRef, content: 'after' }] });
    const committed = await agent.runtime.execute('commit_changes', { changeSetRef: (staged.value as any).changeSetRef });
    expect(committed.receipt).toMatchObject({ status: 'partial', changedFiles: ['Research/Open.md'], undoAvailable: true });
    expect(vault.undo?.status).toBe('partial');
    vault.failAfterWrite = false;
    const restarted = await session(vault, ['Research/Open.md']);
    expect((await restarted.runtime.execute('undo_operation', { operationId: committed.receipt!.operationId })).ok).toBe(true);
    expect(vault.files['Research/Open.md']).toBe('before');
  });

  it('validates persisted state-only journals and both state versions during local undo', async () => {
    const vault = new DurableVault();
    const record = { entries: [], createdAt: now.toISOString(), operationId: 'operation_state', status: 'committed', writtenPaths: [], trackingBeforeState: {}, trackingAfterState: {}, aiTasksBefore: [], aiTasksAfter: [] } as unknown as UndoRecord;
    expect(validUndoRecord(record)).toBe(true);
    expect(validUndoRecord({ ...record, trackingAfterState: { invalid: 'oops' } })).toBe(false);
    expect(validUndoRecord({ ...record, writtenPaths: ['Unrecorded.md'] })).toBe(false);
    expect(validUndoRecord({ ...record, status: 'invented' })).toBe(false);
    vault.undo = record;
    vault.tracking = { 'DailyNotes/2026-10-01.md': { before: null, after: null } };
    await expect(undoLast(vault, vault, vault.undo)).rejects.toThrow('Tracking changed');
    expect(vault.undo).toEqual(record);
  });
});
