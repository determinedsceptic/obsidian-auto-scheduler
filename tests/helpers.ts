import { DEFAULT_SETTINGS } from '../src/types';
import type { Block, Settings, Task, UndoRecord } from '../src/types';
import { localMinute } from '../src/time';
import type { StatePort, VaultPort } from '../src/transaction';
export const now = new Date('2026-10-01T08:00:00+08:00');
export const config = (patch: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, weekdays: [0, 1, 2, 3, 4, 5, 6], periods: ['09:00-12:00'], dailyCapacity: 180, fixedBuffer: 0, blockBuffer: 0, ...patch });
export const task = (patch: Partial<Task> = {}): Task => ({ id: 'a', title: '分析', path: 'Tasks/A.md', line: 1, remaining: 60, priority: 3, split: true, min: 30, completed: false, ...patch });
export const interval = (start: string, end: string, date = '2026-10-01') => ({ start: localMinute(date, start), end: localMinute(date, end) });
export const block = (patch: Partial<Block> = {}): Block => ({ id: 'old', taskId: 'a', title: '分析', path: 'Tasks/A.md', date: '2026-10-01', ...interval('09:00', '10:00'), locked: true, completed: false, ...patch });
export class MemoryVault implements VaultPort, StatePort {
  files: Record<string, string> = { 'Tasks/A.md': '- [ ] 分析 <!-- as id=a remaining=60 priority=3 -->' };
  undo: UndoRecord | null = null;
  writes = 0;
  failBackup = false;
  failWrite = false;
  beforeWrite?: () => void;
  afterWrite?: () => void;
  async listTasks(folder: string, excluded: string[]): Promise<string[]> { return Object.keys(this.files).filter(p => p.startsWith(`${folder}/`) && p.endsWith('.md') && !excluded.includes(p)).sort(); }
  async read(path: string): Promise<string | null> { return this.files[path] ?? null; }
  async saveUndo(record: UndoRecord | null): Promise<void> { if (this.failBackup) throw new Error('backup failed'); this.undo = record ? JSON.parse(JSON.stringify(record)) as UndoRecord : null; }
  async writeChecked(path: string, expected: string | null, next: string): Promise<void> {
    this.beforeWrite?.();
    if (this.failWrite) throw new Error('write failed');
    if ((this.files[path] ?? null) !== expected) throw new Error('write conflict');
    this.files[path] = next; this.writes++; this.afterWrite?.();
  }
}
