import { cleanDaily, rehydrate } from './tracking';
import { dailyDocument, dailyInputs, dailyPaths, renderDaily } from './daily';
import { parseFixed, parseTasks } from './parser';
import { diffBlocks, emptyManagedFile, parseOutput, renderOutput } from './output';
import { dateKey, epochMinute, safeVaultPath, validateSettings, overlap } from './time';
import { resolveEvents } from './event-tool';
import type { ResolvedEvent } from './event-tool';
import { expandHabits, isHabit, parseHabits } from './habits';
import { schedule } from './scheduler';
import type { Task, Tracking, FileChange, ScheduleResult, Settings, UndoRecord } from './types';
export interface VaultPort {
  listTasks(folder: string, excluded: string[]): Promise<string[]>;
  read(path: string): Promise<string | null>;
  /** A single-file compare-and-write. Must fail if current content differs. */
  writeChecked(path: string, expected: string | null, next: string): Promise<void>;
}
export interface StatePort { saveUndo(record: UndoRecord | null, tracking?: Tracking, aiTasks?: Task[]): Promise<void>; getTracking?(): Tracking; getAiTasks?(): Task[] }
export interface Preview {
  eventStarts?: number[];
  sourcePaths: string[]; historyPaths: string[]; aiTasksBefore: Task[]; aiTasksAfter: Task[]; settings: Settings; settingsKey: string; timezone: string; today: string;
  snapshot: Record<string, string | null>; result: ScheduleResult;
  tracking: Tracking; nextTracking: Tracking; outputs?: Record<string, string>; output: string | null; diff: ReturnType<typeof diffBlocks>;
}
export const timezone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;
function settingKey(settings: Settings): string { return JSON.stringify(settings); }
async function snapshot(vault: VaultPort, settings: Settings, today: string, historyPaths: string[] = [], sourcePaths: string[] = []): Promise<Record<string, string | null>> {
  const targets = settings.outputLocation === 'daily' ? dailyPaths(settings, today) : [settings.outputFile];
  if (targets.includes(settings.fixedFile)) throw new Error('Daily output cannot be the fixed-events file');
  const paths = await vault.listTasks(settings.taskFolder, [settings.fixedFile, ...(settings.outputLocation === 'single' ? targets : [])]);
  const habitPaths = await vault.listTasks(settings.habitFolder, []);
  const all = [...new Set([...paths, ...habitPaths, settings.fixedFile, ...targets, ...historyPaths, ...sourcePaths])].sort();
  const contents = await Promise.all(all.map(async path => [path, await vault.read(path)] as const));
  return Object.fromEntries(contents);
}
function same(a: Record<string, string | null>, b: Record<string, string | null>): boolean {
  const keys = Object.keys(a).sort();
  return JSON.stringify(keys) === JSON.stringify(Object.keys(b).sort()) && keys.every(key => a[key] === b[key]);
}
export async function createPreview(vault: VaultPort, settings: Settings, now = new Date(), tracking: Tracking = {}, formatOnly = false, aiTasks: Task[] = [], addedTasks: Task[] = [], habitUpdates: Record<string, string> = {}, events: ResolvedEvent[] = [], revision?: { dailyUpdates: Record<string, string>; aiTasksAfter: Task[] }): Promise<Preview> {
  const frozen: Settings = JSON.parse(JSON.stringify(settings)) as Settings;
  const invalid = validateSettings(frozen);
  if (invalid.length) throw new Error(invalid.join('\n'));
  const today = dateKey(now);
  if (events.length && (formatOnly || frozen.outputLocation !== 'daily')) throw new Error('Fixed events require daily-note output');
  if (events.length) events = resolveEvents(events.map(e => ({ title: e.title, date: e.date, start: e.startTime, minutes: e.end - e.start })), frozen, now);
  const eventRows: Record<string, string[]> = {};
  for (const e of events) (eventRows[`${frozen.dailyFolder}/${e.date}.md`] ??= []).push(`- [ ] ${e.startTime} - ${e.endTime} ${e.title}`);
  const historyPaths = aiTasks.length && frozen.outputLocation === 'daily' ? Object.keys(tracking).filter(p => safeVaultPath(p) && p.startsWith(frozen.dailyFolder + '/') && /\/\d{4}-\d{2}-\d{2}\.md$/.test(p) && p.slice(-13, -3) < today) : [];
  const dailyUpdates = revision?.dailyUpdates ?? {};
  const sourcePaths = [...Object.keys(habitUpdates), ...Object.keys(dailyUpdates)];
  if (formatOnly && sourcePaths.length) throw new Error('Format cleanup cannot change habits');
  if (Object.keys(habitUpdates).some(p => !safeVaultPath(p) || !p.startsWith(frozen.habitFolder + '/') || !p.endsWith('.md'))) throw new Error('The habits tool can only write inside the configured habits folder');
  if (Object.keys(dailyUpdates).some(p => !safeVaultPath(p) || !p.startsWith(frozen.dailyFolder + '/') || !/^\d{4}-\d{2}-\d{2}\.md$/.test(p.slice(frozen.dailyFolder.length + 1)))) throw new Error('Daily editing can only write configured dated notes');
  if (revision && (formatOnly || frozen.outputLocation !== 'daily')) throw new Error('Daily editing requires daily-note output');
  const inputs = await snapshot(vault, frozen, today, historyPaths, sourcePaths);
  const targets = frozen.outputLocation === 'daily' ? dailyPaths(frozen, today) : [frozen.outputFile];
  const trackingSnapshot: Tracking = JSON.parse(JSON.stringify(tracking));
  const virtual = { ...inputs };
  const trackingErrors: ScheduleResult['errors'] = [];
  if (frozen.outputLocation === 'daily') for (const path of Object.keys(inputs)) {
    if (!path.startsWith(frozen.dailyFolder + '/')) continue;
    try { virtual[path] = rehydrate(inputs[path], trackingSnapshot[path]); }
    catch (error) { trackingErrors.push({ path, line: 0, message: (error as Error).message }); virtual[path] = ''; }
  }
  const originals = { ...virtual };
  Object.assign(virtual, dailyUpdates);
  if (events.length) {
    const busy = parseFixed({ path: frozen.fixedFile, content: inputs[frozen.fixedFile] ?? '' }, frozen.defaultEventDuration).intervals;
    for (const path of targets) busy.push(...dailyInputs(path, virtual[path], frozen.defaultEventDuration).intervals);
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      if ([...busy, ...events.slice(0, i)].some(b => overlap(e, { start: b.start - frozen.fixedBuffer, end: b.end + frozen.fixedBuffer }))) trackingErrors.push({ path: `${frozen.dailyFolder}/${e.date}.md`, line: 0, message: `Fixed event ${e.title} conflicts with an existing event or its buffer` });
    }
    for (const [path, rows] of Object.entries(eventRows)) {
      const document = dailyDocument(virtual[path]);
      document.prefix += rows.join(document.newline) + document.newline;
      virtual[path] = renderDaily(document, document.blocks, frozen.outputMode, frozen.ganttFilter);
      const staged = dailyInputs(path, virtual[path], frozen.defaultEventDuration).intervals;
      if (events.filter(e => path.endsWith(`/${e.date}.md`)).some(e => !staged.some(b => b.start === e.start && b.end === e.end))) trackingErrors.push({ path, line: 0, message: 'A code fence would hide new events. Close it before scheduling.' });
    }
  }
  const daily = new Map<string, ReturnType<typeof dailyInputs>>();
  const dailyErrors: ScheduleResult['errors'] = [...trackingErrors];
  if (frozen.outputLocation === 'daily') for (const [path, content] of Object.entries(virtual)) {
    if (!path.startsWith(frozen.dailyFolder + '/') || !/\/\d{4}-\d{2}-\d{2}\.md$/.test(path)) continue;
    try { daily.set(path, dailyInputs(path, content, frozen.defaultEventDuration)); }
    catch (error) { dailyErrors.push({ path, line: 0, message: (error as Error).message }); }
  }
  const parsed = parseTasks(Object.entries(inputs).filter(([path]) => !path.startsWith(frozen.habitFolder + '/') && path !== frozen.fixedFile && (frozen.outputLocation === 'daily' || path !== frozen.outputFile)).map(([path, content]) => ({ path, content: daily.get(path)?.content ?? content ?? '' })));
  const allAiTasks: Task[] = JSON.parse(JSON.stringify([...(revision?.aiTasksAfter ?? aiTasks), ...addedTasks]));
  if (new Set([...parsed.tasks, ...allAiTasks].map(t => t.id)).size !== parsed.tasks.length + allAiTasks.length) throw new Error('Duplicate task IDs');
  const historyCompleted = new Map<string, number>();
  for (const path of historyPaths) {
    try { for (const b of dailyDocument(virtual[path]).blocks) if (b.completed) historyCompleted.set(b.taskId, (historyCompleted.get(b.taskId) ?? 0) + b.end - b.start); }
    catch (error) { dailyErrors.push({ path, line: 0, message: (error as Error).message }); }
  }
  parsed.tasks.push(...allAiTasks.map(t => {
    const done = historyCompleted.get(t.id) ?? 0;
    if (done > t.remaining) dailyErrors.push({ path: t.path, line: 0, message: `Completed AI time exceeds task duration: ${t.id}` });
    const remaining = Math.max(0, t.remaining - done);
    return { ...t, remaining, min: Math.min(t.min, remaining), completed: t.completed || remaining === 0 };
  }));
  if (parsed.tasks.some(t => isHabit(t.id))) parsed.errors.push({ path: frozen.taskFolder, line: 0, message: 'habit_ is a reserved ID prefix for habit occurrences' });
  const habits = parseHabits(Object.entries({ ...inputs, ...habitUpdates }).filter(([path]) => path.startsWith(frozen.habitFolder + '/')).map(([path, content]) => ({ path, content: content ?? '' })), frozen.defaultEventDuration);
  parsed.errors.push(...habits.errors, ...dailyErrors, ...[...daily.values()].flatMap(d => d.errors));
  const fixed = parseFixed({ path: frozen.fixedFile, content: inputs[frozen.fixedFile] ?? '' }, frozen.defaultEventDuration);
  fixed.intervals.push(...[...daily.values()].flatMap(d => d.intervals));
  const preview: Preview = {
    eventStarts: events.map(e => e.start),
    sourcePaths, historyPaths, aiTasksBefore: JSON.parse(JSON.stringify(aiTasks)), aiTasksAfter: allAiTasks, settings: frozen, settingsKey: settingKey(frozen), timezone: timezone(), today: dateKey(now),
    tracking: trackingSnapshot, nextTracking: { ...trackingSnapshot }, snapshot: inputs, result: { blocks: [], unscheduled: [], days: [], errors: [...parsed.errors, ...fixed.errors] },
    output: null, diff: { added: [], removed: [], retained: [] },
  };
  try {
    const documents = Object.fromEntries([...new Set([...targets, ...Object.keys(dailyUpdates)])].map(path => [path, frozen.outputLocation === 'daily' ? dailyDocument(virtual[path]) : parseOutput(inputs[path])]));
    const oldBlocks = Object.values(documents).flatMap(d => d.blocks);
    if (new Set(oldBlocks.map(b => b.id)).size !== oldBlocks.length) throw new Error('Duplicate block IDs in daily notes');
    if (frozen.outputLocation === 'daily') for (const [path, doc] of Object.entries(documents)) {
      if (doc.blocks.some(b => !path.endsWith(`/${b.date}.md`))) throw new Error(`Block date does not match the daily note: ${path}`);
    }
    const expanded = expandHabits(habits.habits, oldBlocks, today);
    if (!formatOnly) parsed.tasks.push(...expanded.tasks);
    const result: ScheduleResult = formatOnly ? { blocks: oldBlocks, unscheduled: [], days: [], errors: [] } : schedule(parsed.tasks, fixed.intervals, [...oldBlocks.filter(b => !isHabit(b.taskId)), ...expanded.blocks], frozen, now);
    result.errors.unshift(...parsed.errors, ...fixed.errors); preview.result = result;
    if (!result.errors.length) {
      const plainSourceIds = new Set([...allAiTasks.map(t => t.id), ...oldBlocks.filter(b => isHabit(b.taskId)).map(b => b.taskId), ...expanded.tasks.map(t => t.id)]);
      preview.outputs = { ...habitUpdates };
      for (const [path, document] of Object.entries(documents)) {
        const blocks = frozen.outputLocation === 'daily' ? result.blocks.filter(b => path.endsWith(`/${b.date}.md`)) : result.blocks;
        // Avoid creating empty future notes. Existing notes with blocks still get cleaned.
        if (frozen.outputLocation === 'daily' && !blocks.length && !document.blocks.length && !eventRows[path] && !(path in dailyUpdates)) continue;
        const output = frozen.outputLocation === 'daily' ? renderDaily(document, blocks, frozen.outputMode, frozen.ganttFilter) : renderOutput(document, blocks, frozen.outputMode, frozen.ganttFilter);
        parseOutput(output);
        if (frozen.outputLocation === 'daily') {
          const originalDoc = dailyDocument(originals[path]);
          const before = cleanDaily(renderDaily(originalDoc, originalDoc.blocks, frozen.outputMode, frozen.ganttFilter), plainSourceIds, new Map(), false).record;
          const clean = cleanDaily(output, plainSourceIds, new Map(parsed.tasks.map(t => [t.id, t.priority])));
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
  if (preview.result.errors.length || preview.output === null) throw new Error('Preview contains errors and cannot be applied');
  if (preview.settingsKey !== settingKey(settings) || preview.timezone !== timezone() || preview.today !== dateKey(now)) throw new Error('Settings, time zone, or date changed. Preview again.');
  if (!same(preview.snapshot, await snapshot(vault, preview.settings, preview.today, preview.historyPaths, preview.sourcePaths))) throw new Error('Tasks, habits template, fixed events, or output changed. Preview again.');
  if (state.getTracking && JSON.stringify(state.getTracking()) !== JSON.stringify(preview.tracking)) throw new Error('Tracking data changed. Preview again.');
  if (state.getAiTasks && JSON.stringify(state.getAiTasks()) !== JSON.stringify(preview.aiTasksBefore)) throw new Error('AI tasks changed. Preview again.');
  const outputs = preview.outputs ?? { [settings.outputFile]: preview.output };
  const entries: FileChange[] = Object.entries(outputs).filter(([path, after]) => preview.snapshot[path] !== after).map(([path, after]) => ({ path, before: preview.snapshot[path], after, trackingBefore: preview.nextTracking[path]?.before, trackingAfter: preview.nextTracking[path]?.after,
    restored: preview.sourcePaths.includes(path) && preview.snapshot[path] === null ? '' : settings.outputLocation === 'daily' && preview.snapshot[path] === null ? (settings.cleanDaily ? '# Day planner\n' : renderDaily(dailyDocument(null), [], settings.outputMode, settings.ganttFilter)) : undefined }));
  if (!entries.length) {
    if (JSON.stringify(preview.aiTasksBefore) !== JSON.stringify(preview.aiTasksAfter)) throw new Error('No blocks can be written this week. Adjust capacity or working hours and replan.');
    return { changed: false };
  }
  if (preview.eventStarts?.some(start => start < epochMinute(now))) throw new Error('The start time of a new event has passed. Send your request again.');
  const added = new Set(preview.diff.added.map(b => b.id));
  if (preview.result.blocks.some(b => added.has(b.id) && !b.locked && !b.completed && b.start < epochMinute(now))) throw new Error('The start time of a new block has passed. Preview again.');
  const undo: UndoRecord = { ...entries[0], entries, createdAt: now.toISOString(), aiTasksBefore: preview.aiTasksBefore, aiTasksAfter: preview.aiTasksAfter };
  // Backup must be durable before any Markdown mutation. Retain it if a write fails.
  await state.saveUndo(undo, preview.nextTracking, preview.aiTasksAfter);
  for (const entry of entries) await vault.writeChecked(entry.path, entry.before, entry.after);
  try {
    const after = await snapshot(vault, preview.settings, preview.today, preview.historyPaths, preview.sourcePaths);
    const expected = { ...preview.snapshot, ...Object.fromEntries(entries.map(e => [e.path, e.after])) };
    if (!same(expected, after)) return { changed: true, warning: 'Inputs or outputs changed while writing. Inspect the results; you can undo and preview again.' };
  } catch { return { changed: true, warning: 'Schedule saved, but verification failed. Inspect the results; an undo backup is saved.' }; }
  return { changed: true };
}
export async function undoLast(vault: VaultPort, state: StatePort, record: UndoRecord | null): Promise<void> {
  if (!record) throw new Error('No schedule to undo');
  if (record.aiTasksAfter && state.getAiTasks && JSON.stringify(record.aiTasksAfter) !== JSON.stringify(state.getAiTasks())) throw new Error('AI tasks changed; refusing to overwrite during undo');
  const entries = record.entries ?? [record];
  // Preflight the entire batch. Retry after an interrupted undo can skip restored entries.
  const pending: FileChange[] = [];
  for (const entry of entries) {
    const current = await vault.read(entry.path), restored = entry.before ?? entry.restored ?? emptyManagedFile();
    if (current === entry.before || current === restored) continue;
    if (current !== entry.after) throw new Error('Output was modified or the last write did not finish; refusing to overwrite. Inspect the backup.');
    pending.push(entry);
  }
  for (const entry of pending) await vault.writeChecked(entry.path, entry.after, entry.before ?? entry.restored ?? emptyManagedFile());
  const tracking = { ...(state.getTracking?.() ?? {}) };
  for (const entry of entries) if (entry.trackingBefore !== undefined) tracking[entry.path] = { before: null, after: entry.trackingBefore };
  await state.saveUndo(null, tracking, record.aiTasksBefore);
}
