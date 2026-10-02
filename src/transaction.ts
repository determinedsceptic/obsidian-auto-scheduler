import { cleanDaily, rehydrate } from './tracking';
import { dailyDocument, dailyInputs, dailyPaths, renderDaily } from './daily';
import { parseFixed, parseTasks } from './parser';
import { diffBlocks, emptyManagedFile, parseOutput, renderOutput } from './output';
import { dateKey, epochMinute, validateSettings } from './time';
import { schedule } from './scheduler';
import type { Tracking, FileChange, ScheduleResult, Settings, UndoRecord } from './types';
export interface VaultPort {
  listTasks(folder: string, excluded: string[]): Promise<string[]>;
  read(path: string): Promise<string | null>;
  /** A single-file compare-and-write. Must fail if current content differs. */
  writeChecked(path: string, expected: string | null, next: string): Promise<void>;
}
export interface StatePort { saveUndo(record: UndoRecord | null, tracking?: Tracking): Promise<void>; getTracking?(): Tracking }
export interface Preview {
  settings: Settings; settingsKey: string; timezone: string; today: string;
  snapshot: Record<string, string | null>; result: ScheduleResult;
  tracking: Tracking; nextTracking: Tracking; outputs?: Record<string, string>; output: string | null; diff: ReturnType<typeof diffBlocks>;
}
export const timezone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;
function settingKey(settings: Settings): string { return JSON.stringify(settings); }
async function snapshot(vault: VaultPort, settings: Settings, today: string): Promise<Record<string, string | null>> {
  const targets = settings.outputLocation === 'daily' ? dailyPaths(settings, today) : [settings.outputFile];
  if (targets.includes(settings.fixedFile)) throw new Error('每日输出不能与固定日程文件相同');
  const paths = await vault.listTasks(settings.taskFolder, [settings.fixedFile, ...(settings.outputLocation === 'single' ? targets : [])]);
  const all = [...new Set([...paths, settings.fixedFile, ...targets])].sort();
  const contents = await Promise.all(all.map(async path => [path, await vault.read(path)] as const));
  return Object.fromEntries(contents);
}
function same(a: Record<string, string | null>, b: Record<string, string | null>): boolean {
  const keys = Object.keys(a).sort();
  return JSON.stringify(keys) === JSON.stringify(Object.keys(b).sort()) && keys.every(key => a[key] === b[key]);
}
export async function createPreview(vault: VaultPort, settings: Settings, now = new Date(), tracking: Tracking = {}, formatOnly = false): Promise<Preview> {
  const frozen: Settings = JSON.parse(JSON.stringify(settings)) as Settings;
  const invalid = validateSettings(frozen);
  if (invalid.length) throw new Error(invalid.join('\n'));
  const today = dateKey(now);
  const inputs = await snapshot(vault, frozen, today);
  const targets = frozen.outputLocation === 'daily' ? dailyPaths(frozen, today) : [frozen.outputFile];
  const trackingSnapshot: Tracking = JSON.parse(JSON.stringify(tracking));
  const virtual = { ...inputs };
  const trackingErrors: ScheduleResult['errors'] = [];
  if (frozen.outputLocation === 'daily') for (const path of Object.keys(inputs)) {
    if (!path.startsWith(frozen.dailyFolder + '/')) continue;
    try { virtual[path] = rehydrate(inputs[path], trackingSnapshot[path]); }
    catch (error) { trackingErrors.push({ path, line: 0, message: (error as Error).message }); virtual[path] = ''; }
  }
  const daily = new Map<string, ReturnType<typeof dailyInputs>>();
  const dailyErrors: ScheduleResult['errors'] = [...trackingErrors];
  if (frozen.outputLocation === 'daily') for (const [path, content] of Object.entries(virtual)) {
    if (!path.startsWith(frozen.dailyFolder + '/') || !/\/\d{4}-\d{2}-\d{2}\.md$/.test(path)) continue;
    try { daily.set(path, dailyInputs(path, content)); }
    catch (error) { dailyErrors.push({ path, line: 0, message: (error as Error).message }); }
  }
  const parsed = parseTasks(Object.entries(inputs).filter(([path]) => path !== frozen.fixedFile && (frozen.outputLocation === 'daily' || path !== frozen.outputFile)).map(([path, content]) => ({ path, content: daily.get(path)?.content ?? content ?? '' })));
  parsed.errors.push(...dailyErrors, ...[...daily.values()].flatMap(d => d.errors));
  const fixed = parseFixed({ path: frozen.fixedFile, content: inputs[frozen.fixedFile] ?? '' });
  fixed.intervals.push(...[...daily.values()].flatMap(d => d.intervals));
  const preview: Preview = {
    settings: frozen, settingsKey: settingKey(frozen), timezone: timezone(), today: dateKey(now),
    tracking: trackingSnapshot, nextTracking: { ...trackingSnapshot }, snapshot: inputs, result: { blocks: [], unscheduled: [], days: [], errors: [...parsed.errors, ...fixed.errors] },
    output: null, diff: { added: [], removed: [], retained: [] },
  };
  try {
    const documents = Object.fromEntries(targets.map(path => [path, frozen.outputLocation === 'daily' ? dailyDocument(virtual[path]) : parseOutput(inputs[path])]));
    const oldBlocks = Object.values(documents).flatMap(d => d.blocks);
    if (new Set(oldBlocks.map(b => b.id)).size !== oldBlocks.length) throw new Error('每日笔记中存在重复工作块 ID');
    if (frozen.outputLocation === 'daily') for (const [path, doc] of Object.entries(documents)) {
      if (doc.blocks.some(b => !path.endsWith(`/${b.date}.md`))) throw new Error(`工作块日期与每日笔记不符：${path}`);
    }
    const result: ScheduleResult = formatOnly ? { blocks: oldBlocks, unscheduled: [], days: [], errors: [] } : schedule(parsed.tasks, fixed.intervals, oldBlocks, frozen, now);
    result.errors.unshift(...parsed.errors, ...fixed.errors); preview.result = result;
    if (!result.errors.length) {
      preview.outputs = {};
      for (const [path, document] of Object.entries(documents)) {
        const blocks = frozen.outputLocation === 'daily' ? result.blocks.filter(b => path.endsWith(`/${b.date}.md`)) : result.blocks;
        // Avoid creating empty future notes. Existing notes with blocks still get cleaned.
        if (frozen.outputLocation === 'daily' && !blocks.length && !document.blocks.length) continue;
        const output = frozen.outputLocation === 'daily' ? renderDaily(document, blocks, frozen.outputMode, frozen.ganttFilter) : renderOutput(document, blocks, frozen.outputMode, frozen.ganttFilter);
        parseOutput(output);
        if (frozen.outputLocation === 'daily') {
          const before = cleanDaily(renderDaily(document, document.blocks, frozen.outputMode, frozen.ganttFilter)).record;
          const clean = cleanDaily(output);
          preview.nextTracking[path] = { before, after: frozen.cleanDaily ? clean.record : null };
          preview.outputs[path] = frozen.cleanDaily ? clean.text : output;
        } else preview.outputs[path] = output;
      }
      preview.output = frozen.outputLocation === 'daily' ? Object.entries(preview.outputs).map(([path, output]) => `--- ${path} ---\n${output}`).join('\n') : preview.outputs[frozen.outputFile];
      preview.diff = diffBlocks(oldBlocks, result.blocks);
    }
  } catch (error) { preview.output = null; preview.result.errors.push({ path: frozen.outputFile, line: 0, message: (error as Error).message }); }
  return preview;
}
export async function applyPreview(vault: VaultPort, state: StatePort, preview: Preview, settings: Settings, now = new Date()): Promise<{ changed: boolean; warning?: string }> {
  if (preview.result.errors.length || preview.output === null) throw new Error('预览含错误，不能应用');
  if (preview.settingsKey !== settingKey(settings) || preview.timezone !== timezone() || preview.today !== dateKey(now)) throw new Error('设置、时区或日期已变化，请重新预览');
  if (!same(preview.snapshot, await snapshot(vault, preview.settings, preview.today))) throw new Error('任务、固定日程或输出已变化，请重新预览');
  if (state.getTracking && JSON.stringify(state.getTracking()) !== JSON.stringify(preview.tracking)) throw new Error('工作块跟踪数据已变化，请重新预览');
  const outputs = preview.outputs ?? { [settings.outputFile]: preview.output };
  const entries: FileChange[] = Object.entries(outputs).filter(([path, after]) => preview.snapshot[path] !== after).map(([path, after]) => ({ path, before: preview.snapshot[path], after, trackingBefore: preview.nextTracking[path]?.before, trackingAfter: preview.nextTracking[path]?.after,
    restored: settings.outputLocation === 'daily' && preview.snapshot[path] === null ? (settings.cleanDaily ? '# Day planner\n' : renderDaily(dailyDocument(null), [], settings.outputMode, settings.ganttFilter)) : undefined }));
  if (!entries.length) return { changed: false };
  const added = new Set(preview.diff.added.map(b => b.id));
  if (preview.result.blocks.some(b => added.has(b.id) && !b.locked && !b.completed && b.start < epochMinute(now))) throw new Error('拟新增工作块的开始时间已过，请重新预览');
  const undo: UndoRecord = { ...entries[0], entries, createdAt: now.toISOString() };
  // Backup must be durable before any Markdown mutation. Retain it if a write fails.
  await state.saveUndo(undo, preview.nextTracking);
  for (const entry of entries) await vault.writeChecked(entry.path, entry.before, entry.after);
  try {
    const after = await snapshot(vault, preview.settings, preview.today);
    const expected = { ...preview.snapshot, ...Object.fromEntries(entries.map(e => [e.path, e.after])) };
    if (!same(expected, after)) return { changed: true, warning: '写入期间输入或输出发生变化；请检查结果，可撤销后重新预览' };
  } catch { return { changed: true, warning: '排程已写入，但写后检查失败；请检查结果，撤销备份已保存' }; }
  return { changed: true };
}
export async function undoLast(vault: VaultPort, state: StatePort, record: UndoRecord | null): Promise<void> {
  if (!record) throw new Error('没有可撤销的排程');
  const entries = record.entries ?? [record];
  // Preflight the entire batch. Retry after an interrupted undo can skip restored entries.
  const pending: FileChange[] = [];
  for (const entry of entries) {
    const current = await vault.read(entry.path), restored = entry.before ?? entry.restored ?? emptyManagedFile();
    if (current === entry.before || current === restored) continue;
    if (current !== entry.after) throw new Error('输出已被修改或最近写入未完成，拒绝覆盖；请检查备份');
    pending.push(entry);
  }
  for (const entry of pending) await vault.writeChecked(entry.path, entry.after, entry.before ?? entry.restored ?? emptyManagedFile());
  const tracking = { ...(state.getTracking?.() ?? {}) };
  for (const entry of entries) if (entry.trackingBefore !== undefined) tracking[entry.path] = { before: null, after: entry.trackingBefore };
  await state.saveUndo(null, tracking);
}
