import { parseFixed, parseTasks } from './parser';
import { diffBlocks, emptyManagedFile, parseOutput, renderOutput } from './output';
import { dateKey, epochMinute, validateSettings } from './time';
import { schedule } from './scheduler';
import type { ScheduleResult, Settings, UndoRecord } from './types';
export interface VaultPort {
  listTasks(folder: string, excluded: string[]): Promise<string[]>;
  read(path: string): Promise<string | null>;
  /** A single-file compare-and-write. Must fail if current content differs. */
  writeChecked(path: string, expected: string | null, next: string): Promise<void>;
}
export interface StatePort { saveUndo(record: UndoRecord | null): Promise<void> }
export interface Preview {
  settings: Settings; settingsKey: string; timezone: string; today: string;
  snapshot: Record<string, string | null>; result: ScheduleResult;
  output: string | null; diff: ReturnType<typeof diffBlocks>;
}
export const timezone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;
function settingKey(settings: Settings): string { return JSON.stringify(settings); }
async function snapshot(vault: VaultPort, settings: Settings): Promise<Record<string, string | null>> {
  const paths = await vault.listTasks(settings.taskFolder, [settings.fixedFile, settings.outputFile]);
  const all = [...new Set([...paths, settings.fixedFile, settings.outputFile])].sort();
  const contents = await Promise.all(all.map(async path => [path, await vault.read(path)] as const));
  return Object.fromEntries(contents);
}
function same(a: Record<string, string | null>, b: Record<string, string | null>): boolean {
  const keys = Object.keys(a).sort();
  return JSON.stringify(keys) === JSON.stringify(Object.keys(b).sort()) && keys.every(key => a[key] === b[key]);
}
export async function createPreview(vault: VaultPort, settings: Settings, now = new Date()): Promise<Preview> {
  const frozen: Settings = JSON.parse(JSON.stringify(settings)) as Settings;
  const invalid = validateSettings(frozen);
  if (invalid.length) throw new Error(invalid.join('\n'));
  const inputs = await snapshot(vault, frozen);
  const parsed = parseTasks(Object.entries(inputs).filter(([path]) => path !== frozen.fixedFile && path !== frozen.outputFile).map(([path, content]) => ({ path, content: content ?? '' })));
  const fixed = parseFixed({ path: frozen.fixedFile, content: inputs[frozen.fixedFile] ?? '' });
  const preview: Preview = {
    settings: frozen, settingsKey: settingKey(frozen), timezone: timezone(), today: dateKey(now),
    snapshot: inputs, result: { blocks: [], unscheduled: [], days: [], errors: [...parsed.errors, ...fixed.errors] },
    output: null, diff: { added: [], removed: [], retained: [] },
  };
  try {
    const document = parseOutput(inputs[frozen.outputFile]);
    const result = schedule(parsed.tasks, fixed.intervals, document.blocks, frozen, now);
    result.errors.unshift(...parsed.errors, ...fixed.errors); preview.result = result;
    if (!result.errors.length) {
      preview.output = renderOutput(document, result.blocks, frozen.outputMode);
      // Read back the actual output before allowing writes.
      parseOutput(preview.output);
      preview.diff = diffBlocks(document.blocks, result.blocks);
    }
  } catch (error) { preview.output = null; preview.result.errors.push({ path: frozen.outputFile, line: 0, message: (error as Error).message }); }
  return preview;
}
export async function applyPreview(vault: VaultPort, state: StatePort, preview: Preview, settings: Settings, now = new Date()): Promise<{ changed: boolean; warning?: string }> {
  if (preview.result.errors.length || preview.output === null) throw new Error('预览含错误，不能应用');
  if (preview.settingsKey !== settingKey(settings) || preview.timezone !== timezone() || preview.today !== dateKey(now)) throw new Error('设置、时区或日期已变化，请重新预览');
  if (!same(preview.snapshot, await snapshot(vault, preview.settings))) throw new Error('任务、固定日程或输出已变化，请重新预览');
  const old = preview.snapshot[settings.outputFile];
  if (old === preview.output) return { changed: false };
  const added = new Set(preview.diff.added.map(b => b.id));
  if (preview.result.blocks.some(b => added.has(b.id) && !b.locked && !b.completed && b.start < epochMinute(now))) throw new Error('拟新增工作块的开始时间已过，请重新预览');
  const undo: UndoRecord = { path: settings.outputFile, before: old, after: preview.output, createdAt: now.toISOString() };
  // Backup must be durable before any Markdown mutation. Retain it if a write fails.
  await state.saveUndo(undo);
  await vault.writeChecked(undo.path, undo.before, undo.after);
  try {
    const after = await snapshot(vault, preview.settings);
    const expected = { ...preview.snapshot, [undo.path]: undo.after };
    if (!same(expected, after)) return { changed: true, warning: '写入期间输入或输出发生变化；请检查结果，可撤销后重新预览' };
  } catch { return { changed: true, warning: '排程已写入，但写后检查失败；请检查结果，撤销备份已保存' }; }
  return { changed: true };
}
export async function undoLast(vault: VaultPort, state: StatePort, record: UndoRecord | null): Promise<void> {
  if (!record) throw new Error('没有可撤销的排程');
  if (await vault.read(record.path) !== record.after) throw new Error('输出已被修改或最近写入未完成，拒绝覆盖；请检查备份');
  await vault.writeChecked(record.path, record.after, record.before ?? emptyManagedFile());
  await state.saveUndo(null);
}
