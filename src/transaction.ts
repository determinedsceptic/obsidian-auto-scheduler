import { ensureStudyGoal, studyGoal } from './study-goals';
import { cleanDaily, rehydrate, reconcileDailyTracking } from './tracking';
import { dailyDocument, dailyInputs, dailyPaths, renderDaily, organizeDailyTasks, dayPlannerSection, isFlexibleDailyRow } from './daily';
import { parseFixed, parseTasks } from './parser';
import { parseMarkdownStructure } from './markdown-structure';
import { diffBlocks, emptyManagedFile, parseOutput, renderOutput } from './output';
import { addDays, dateKey, epochMinute, safeVaultPath, validateSettings, overlap } from './time';
import { resolveEvents, reserveEvent, eventRow } from './event-tool';
import { prepareCalendarPriority } from './calendar-priority';
import { cleanEventMetadata } from './event-tracking';
import type { FlexibleCalendarRow } from './calendar-priority';
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
export interface StatePort { saveUndo(record: UndoRecord | null, tracking?: Tracking, aiTasks?: Task[]): Promise<void>; getTracking?(): Tracking; getAiTasks?(): Task[]; getUndo?():UndoRecord|null }
export interface Preview {
  explicitSources?: boolean;
  eventStarts?: number[];
  sourcePaths: string[]; historyPaths: string[]; aiTasksBefore: Task[]; aiTasksAfter: Task[]; settings: Settings; settingsKey: string; timezone: string; today: string;
  snapshot: Record<string, string | null>; result: ScheduleResult;
  tracking: Tracking; nextTracking: Tracking; outputs?: Record<string, string>; output: string | null; diff: ReturnType<typeof diffBlocks>;
}
export const timezone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;
function settingKey(settings: Settings): string { return JSON.stringify(settings); }
async function snapshot(vault: VaultPort, settings: Settings, today: string, historyPaths: string[] = [], sourcePaths: string[] = [], explicitSources = false): Promise<Record<string, string | null>> {
  const targets = settings.outputLocation === 'daily' ? dailyPaths(settings, today) : [settings.outputFile];
  if (targets.includes(settings.fixedFile)) throw new Error('Daily output cannot be the fixed-events file');
  const paths = explicitSources ? [] : await vault.listTasks(settings.taskFolder, [settings.fixedFile, ...(settings.outputLocation === 'single' ? targets : [])]);
  const habitPaths = explicitSources ? [] : await vault.listTasks(settings.habitFolder, []);
  const all = [...new Set([...paths, ...habitPaths, settings.fixedFile, ...targets, ...historyPaths, ...sourcePaths])].sort();
  const contents = await Promise.all(all.map(async path => [path, await vault.read(path)] as const));
  return Object.fromEntries(contents);
}
function same(a: Record<string, string | null>, b: Record<string, string | null>): boolean {
  const keys = Object.keys(a).sort();
  return JSON.stringify(keys) === JSON.stringify(Object.keys(b).sort()) && keys.every(key => a[key] === b[key]);
}
function normalizeSourceBlock(text:string):string {
  const normalized=text.replace(/\r\n|\r/g,'\n').replace(/\n+$/,'')+'\n';
  return normalized.replace(/^(\s{0,3}(?:[-*+]|\d+[.)])\s+)\[[ xX-]\]/,'$1[ ]');
}
function sourceBlockStatus(text:string):NonNullable<Task['sourceStatus']> {
  const status=/^\s{0,3}(?:[-*+]|\d+[.)])\s+\[([ xX-])\]/.exec(text)?.[1];
  return status==='-'?'cancelled':status==='x'||status==='X'?'completed':'open';
}
function datedPath(path:string,settings:Settings):boolean {
  return safeVaultPath(path)&&path.startsWith(settings.dailyFolder+'/')&&/^\d{4}-\d{2}-\d{2}\.md$/.test(path.slice(settings.dailyFolder.length+1));
}
export async function createPreview(vault: VaultPort, settings: Settings, now = new Date(), tracking: Tracking = {}, formatOnly = false, aiTasks: Task[] = [], addedTasks: Task[] = [], habitUpdates: Record<string, string> = {}, events: ResolvedEvent[] = [], revision?: { dailyUpdates: Record<string, string>; aiTasksAfter: Task[] }, options: {preserveLayout?:boolean;habitSources?:Record<string,string>;explicitSources?:boolean;flexibleRows?:FlexibleCalendarRow[]} = {}): Promise<Preview> {
  const frozen: Settings = JSON.parse(JSON.stringify(settings)) as Settings;
  const invalid = validateSettings(frozen);
  if (invalid.length) throw new Error(invalid.join('\n'));
  const today = dateKey(now);
  if (events.length && (formatOnly || frozen.outputLocation !== 'daily')) throw new Error('Fixed events require daily-note output');
  if (events.length) events = resolveEvents(events.map(e => ({ title: e.title, date: e.date, start: e.startTime, minutes: e.end - e.start, beforeMinutes:e.beforeMinutes,afterMinutes:e.afterMinutes })), frozen, now);
  const eventRows: Record<string, string[]> = {};
  for (const e of events) (eventRows[`${frozen.dailyFolder}/${e.date}.md`] ??= []).push(eventRow(e));
  const taskState:Task[]=JSON.parse(JSON.stringify([...(revision?.aiTasksAfter??aiTasks),...addedTasks]));
  const historyPaths = frozen.outputLocation === 'daily' ? [...new Set([
    ...Object.keys(tracking).filter(p=>datedPath(p,frozen)&&p.slice(-13,-3)<today),
    ...taskState.flatMap(task=>task.sessionPaths??[]).filter(path=>datedPath(path,frozen)&&path.slice(-13,-3)<today),
  ])] : [];
  const dailyUpdates = revision?.dailyUpdates ?? {};
  const goalPaths = !options.preserveLayout&&!formatOnly&&frozen.outputLocation==='daily' ? [...(revision?.aiTasksAfter??aiTasks),...addedTasks].filter(t=>!t.sourceRetired&&!t.sourceDetached).map(t=>t.path) : [];
  if(goalPaths.some(p=>!safeVaultPath(p)||!p.startsWith(frozen.dailyFolder+'/')||!/^\d{4}-\d{2}-\d{2}\.md$/.test(p.slice(frozen.dailyFolder.length+1))))throw Error('Study goals require a dated note inside the configured daily folder');
  // Declared templates identify existing plain habits; this does not authorize
  // adding unselected template occurrences through the explicit-source adapter.
  const classificationPaths=options.explicitSources&&!formatOnly&&frozen.outputLocation==='daily'?await vault.listTasks(frozen.habitFolder,[]):[];
  const sourcePaths = [...new Set([...Object.keys(habitUpdates), ...Object.keys(dailyUpdates),...goalPaths,...(options.preserveLayout?[...(revision?.aiTasksAfter??aiTasks),...addedTasks].map(t=>t.path):[]),...Object.keys(options.habitSources??{}),...classificationPaths])];
  if (formatOnly && sourcePaths.length) throw new Error('Format cleanup cannot change habits');
  if (Object.keys(habitUpdates).some(p => !safeVaultPath(p) || !p.startsWith(frozen.habitFolder + '/') || !p.endsWith('.md'))) throw new Error('The habits tool can only write inside the configured habits folder');
  if (Object.keys(dailyUpdates).some(p => !safeVaultPath(p) || !p.startsWith(frozen.dailyFolder + '/') || !/^\d{4}-\d{2}-\d{2}\.md$/.test(p.slice(frozen.dailyFolder.length + 1)))) throw new Error('Daily editing can only write configured dated notes');
  if (revision && (formatOnly || frozen.outputLocation !== 'daily')) throw new Error('Daily editing requires daily-note output');
  const inputs = await snapshot(vault, frozen, today, historyPaths, sourcePaths, options.explicitSources);
  const targets = frozen.outputLocation === 'daily' ? dailyPaths(frozen, today) : [frozen.outputFile];
  const trackingSnapshot: Tracking = JSON.parse(JSON.stringify(tracking));
  const reconciledTracking:Tracking=structuredClone(trackingSnapshot);
  const virtual = { ...inputs };
  const trackingErrors: ScheduleResult['errors'] = [];
  if (frozen.outputLocation === 'daily') for (const path of Object.keys(inputs)) {
    if (!path.startsWith(frozen.dailyFolder + '/')) continue;
    try {
      const reconciled=reconcileDailyTracking(inputs[path],trackingSnapshot[path]);
      virtual[path]=reconciled.text;
      if(reconciled.pair)reconciledTracking[path]=reconciled.pair;else delete reconciledTracking[path];
    }
    catch (error) { trackingErrors.push({ path, line: 0, message: (error as Error).message }); virtual[path] = ''; }
  }
  const originals = { ...virtual };
  Object.assign(virtual, dailyUpdates);
  const habits = parseHabits(Object.entries({ ...inputs, ...habitUpdates, ...options.habitSources }).filter(([path]) => (!options.explicitSources && path.startsWith(frozen.habitFolder + '/')) || path in (options.habitSources??{})).map(([path, content]) => ({ path, content: content ?? '' })), frozen.defaultEventDuration);
  const knownHabits=parseHabits(Object.entries({...inputs,...habitUpdates,...Object.fromEntries(Object.entries(options.habitSources??{}).filter(([path])=>!path.startsWith(frozen.habitFolder+'/')))}).filter(([path])=>path.startsWith(frozen.habitFolder+'/')||path in (options.habitSources??{})).map(([path,content])=>({path,content:content??''})),frozen.defaultEventDuration);
  const invalidHabitPaths=new Set(knownHabits.errors.map(error=>error.path));
  const calendarPriority=!formatOnly&&frozen.outputLocation==='daily'?prepareCalendarPriority(virtual,targets,knownHabits.habits.filter(habit=>!invalidHabitPaths.has(habit.path)),today,
    [...parseFixed({path:frozen.fixedFile,content:inputs[frozen.fixedFile]??''},frozen.defaultEventDuration).intervals,...events],frozen,options.flexibleRows):{adopted:{},notes:[]};
  if (events.length) {
    const busy = parseFixed({ path: frozen.fixedFile, content: inputs[frozen.fixedFile] ?? '' }, frozen.defaultEventDuration).intervals;
    for (const path of targets) busy.push(...dailyInputs(path, virtual[path], frozen.defaultEventDuration).rows.filter(row=>!isFlexibleDailyRow(row)));
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      if ([...busy, ...events.slice(0, i)].some(b => overlap(reserveEvent(e,frozen.fixedBuffer), reserveEvent(b,frozen.fixedBuffer)))) trackingErrors.push({ path: `${frozen.dailyFolder}/${e.date}.md`, line: 0, message: `Fixed event ${e.title} conflicts with another fixed commitment or its reserved buffer` });
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
  const parsed = parseTasks(Object.entries(inputs).filter(([path]) => !options.explicitSources && !path.startsWith(frozen.habitFolder + '/') && path !== frozen.fixedFile && (frozen.outputLocation === 'daily' || path !== frozen.outputFile)).map(([path, content]) => ({ path, content: daily.get(path)?.content ?? content ?? '' })));
  const allAiTasks: Task[] = taskState;
  const activeLegacyTasks=allAiTasks.filter(t=>!t.sourceRetired&&!t.sourceDetached);
  if (!options.preserveLayout && frozen.outputLocation === 'daily' && new Set(activeLegacyTasks.map(t => JSON.stringify([t.path,t.title]))).size !== activeLegacyTasks.length) throw new Error('Duplicate task titles in the same Tasks note; use distinct titles');
  if (new Set([...parsed.tasks, ...allAiTasks].map(t => t.id)).size !== parsed.tasks.length + allAiTasks.length) throw new Error('Duplicate task IDs');
  const observed=new Map<string,Array<{path:string;block:ReturnType<typeof dailyDocument>['blocks'][number]}>>();
  if(frozen.outputLocation==='daily')for(const [path,content] of Object.entries(virtual)){
    if(!datedPath(path,frozen))continue;
    try{for(const block of dailyDocument(content).blocks)(observed.get(block.taskId)??(observed.set(block.taskId,[]),observed.get(block.taskId)!)).push({path,block});}
    catch(error){dailyErrors.push({path,line:0,message:(error as Error).message});}
  }
  for(const [taskId,items] of observed){
    const ids=items.map(item=>item.block.id);
    if(new Set(ids).size!==ids.length)dailyErrors.push({path:frozen.outputFile,line:0,message:`Duplicate observed session block ID for ${taskId}`});
  }
  const reviewIds=new Set<string>();
  parsed.tasks.push(...allAiTasks.map(t => {
    const sessions={...(t.completedSessions??{})};
    for(const {block} of observed.get(t.id)??[]){if(block.completed)sessions[block.id]=block.end-block.start;else delete sessions[block.id];}
    const completedMinutes=Object.values(sessions).reduce((sum,minutes)=>sum+minutes,0);
    const currentCompleted=(observed.get(t.id)??[]).filter(({block})=>block.completed&&block.date>=today&&block.date<addDays(today,7)).reduce((sum,{block})=>sum+block.end-block.start,0);
    if(t.sourceDetached){Object.assign(t,{completedSessions:sessions,completedMinutes,needsReview:true});return {...t};}
    let sourceStatus=t.sourceStatus??(t.completed?'completed':'open');
    if(t.sourceRetired){
      /* A retired source is a tombstone. Its path remains provenance only. */
    }else if(t.sourceText){
      const source=inputs[t.path]??'', fingerprint=normalizeSourceBlock(t.sourceText),calendar=dayPlannerSection(source);
      const matches=parseMarkdownStructure(source).blocks.filter(block=>!calendar||block.start<calendar.start||block.start>=calendar.end).map(block=>source.slice(block.start,block.end)).filter(text=>normalizeSourceBlock(text)===fingerprint);
      const retiredWithoutSource=!matches.length&&t.completed&&(t.sourceStatus==='completed'||t.sourceStatus==='cancelled');
      if(retiredWithoutSource){/* Preserve terminal history after an explicit source deletion. */}
      else if(t.sourceOccurrence!==undefined&&t.sourceCount!==undefined){
        if(matches.length!==t.sourceCount||!matches[t.sourceOccurrence])dailyErrors.push({path:t.path,line:0,message:'Task source multiplicity changed; read its current reference and rebind the schedule'});
        else sourceStatus=sourceBlockStatus(matches[t.sourceOccurrence]);
      }else{
        const statuses=matches.map(sourceBlockStatus);
        if(!statuses.length||new Set(statuses).size!==1)dailyErrors.push({path:t.path,line:0,message:'Task source changed or is ambiguous; read its current reference and rebind the schedule'});
        else sourceStatus=statuses[0];
      }
    }else if(!options.preserveLayout||studyGoal(inputs[t.path]??'',t))sourceStatus=studyGoal(virtual[t.path]??'',t)?.completed?'completed':'open';
    const unknown=t.effort==='unknown'||t.rollingMinutes!==undefined;
    const terminal=sourceStatus==='completed'||sourceStatus==='cancelled';
    const anchored=!!t.sourceText;
    const needsReview=anchored&&!unknown&&!terminal&&completedMinutes>=t.remaining;
    if(needsReview)reviewIds.add(t.id);
    Object.assign(t,{completed:terminal||(anchored?false:t.completed||(!unknown&&completedMinutes>=t.remaining)),completedSessions:sessions,completedMinutes,needsReview});
    if(anchored||t.sourceStatus!==undefined)t.sourceStatus=sourceStatus;
    const remaining=unknown?Math.max(currentCompleted,t.rollingMinutes??t.remaining):Math.max(currentCompleted,t.remaining-completedMinutes+currentCompleted);
    return {...t,remaining};
  }));
  if (parsed.tasks.some(t => isHabit(t.id))) parsed.errors.push({ path: frozen.taskFolder, line: 0, message: 'habit_ is a reserved ID prefix for habit occurrences' });
  parsed.errors.push(...habits.errors, ...dailyErrors, ...[...daily.values()].flatMap(d => d.errors));
  const fixed = parseFixed({ path: frozen.fixedFile, content: inputs[frozen.fixedFile] ?? '' }, frozen.defaultEventDuration);
  fixed.intervals.push(...[...daily.values()].flatMap(d => d.rows.map(row=>({start:row.start,end:row.end,
    ...(isFlexibleDailyRow(row)?{beforeMinutes:0,afterMinutes:0}:row.beforeMinutes!==undefined?{beforeMinutes:row.beforeMinutes,afterMinutes:row.afterMinutes}:{})}))));
  const preview: Preview = {
    explicitSources: options.explicitSources,
    eventStarts: events.map(e => e.start),
    sourcePaths, historyPaths, aiTasksBefore: JSON.parse(JSON.stringify(aiTasks)), aiTasksAfter: allAiTasks, settings: frozen, settingsKey: settingKey(frozen), timezone: timezone(), today: dateKey(now),
    tracking: trackingSnapshot, nextTracking: reconciledTracking, snapshot: inputs, result: { blocks: [], unscheduled: [], days: [], errors: [...parsed.errors, ...fixed.errors] },
    output: null, diff: { added: [], removed: [], retained: [] },
  };
  try {
    const documents = Object.fromEntries([...new Set([...targets, ...Object.keys(dailyUpdates)])].map(path => [path, frozen.outputLocation === 'daily' ? dailyDocument(virtual[path]) : parseOutput(inputs[path])]));
    for(const [path,blocks] of Object.entries(calendarPriority.adopted))documents[path].blocks.push(...blocks);
    const oldBlocks = Object.values(documents).flatMap(d => d.blocks);
    if (new Set(oldBlocks.map(b => b.id)).size !== oldBlocks.length) throw new Error('Duplicate block IDs in daily notes');
    if (frozen.outputLocation === 'daily') for (const [path, doc] of Object.entries(documents)) {
      if (doc.blocks.some(b => !path.endsWith(`/${b.date}.md`))) throw new Error(`Block date does not match the daily note: ${path}`);
    }
    const expanded = expandHabits(habits.habits, oldBlocks, today);
    if(options.explicitSources&&!formatOnly){
      const selected=(block:typeof oldBlocks[number])=>habits.habits.some(habit=>block.taskId===`habit_${habit.id}_${block.date.replace(/-/g,'')}`);
      const present=new Set(expanded.tasks.map(task=>task.id));
      // An event-only request retains existing habits, including plain rows
      // recovered from declared templates. Explicit template edits still rebuild.
      for(const block of oldBlocks.filter(block=>isHabit(block.taskId)&&!block.completed&&!selected(block)&&!present.has(block.taskId))){
        const duration=block.end-block.start;
        expanded.blocks.push(block);
        expanded.tasks.push({id:block.taskId,title:block.title,path:block.path,line:0,remaining:duration,min:duration,priority:block.priority??3,earliest:block.start,due:block.end,split:false,completed:false});
        present.add(block.taskId);
      }
    }
    if (!formatOnly) parsed.tasks.push(...expanded.tasks);
    const result: ScheduleResult = formatOnly ? { blocks: oldBlocks, unscheduled: [], days: [], errors: [] } : schedule(parsed.tasks, fixed.intervals, [...oldBlocks.filter(b => !isHabit(b.taskId)), ...expanded.blocks], frozen, now);
    if(calendarPriority.notes.length)(result.notes??=[]).push(...calendarPriority.notes);
    for(const task of allAiTasks){
      const paths=new Set(task.sessionPaths??[]);
      for(const block of result.blocks.filter(block=>block.taskId===task.id))paths.add(frozen.outputLocation==='daily'?`${frozen.dailyFolder}/${block.date}.md`:frozen.outputFile);
      task.sessionPaths=[...paths].sort();
      if(task.sourceDetached){
        (result.notes??=[]).push(`${task.title}: its source was edited; existing sessions may remain, but no new time is allocated until explicitly rebound`);
        continue;
      }
      if(reviewIds.has(task.id)&&!result.unscheduled.some(item=>item.taskId===task.id))result.unscheduled.push({taskId:task.id,title:task.title,remaining:0,reason:'Estimated effort is exhausted while the source goal remains open; review or revise the estimate'});
      if((task.effort==='unknown'||task.rollingMinutes!==undefined)&&task.sourceStatus==='open'){
        (result.notes??=[]).push(`${task.title}: total effort is unknown; scheduled sessions represent only the current rolling budget`);
      }
    }
    result.errors.unshift(...parsed.errors, ...fixed.errors); preview.result = result;
    if (!result.errors.length) {
      const plainSourceIds = new Set([...allAiTasks.map(t => t.id), ...oldBlocks.filter(b => isHabit(b.taskId)).map(b => b.taskId), ...expanded.tasks.map(t => t.id)]);
      preview.outputs = { ...habitUpdates };
      for (const [path, document] of Object.entries(documents)) {
        const blocks = frozen.outputLocation === 'daily' ? result.blocks.filter(b => path.endsWith(`/${b.date}.md`)) : result.blocks;
        // Avoid creating empty future notes. Existing notes with blocks still get cleaned.
        const hasEventMetadata=frozen.cleanDaily&&daily.get(path)?.rows.some(row=>row.beforeMinutes!==undefined);
        if (frozen.outputLocation === 'daily' && !blocks.length && !document.blocks.length && !eventRows[path] && !hasEventMetadata && !(path in dailyUpdates) && (options.preserveLayout || organizeDailyTasks(virtual[path]??'',frozen.defaultEventDuration)===(virtual[path]??''))) continue;
        const output = frozen.outputLocation === 'daily' ? renderDaily(document, blocks, frozen.outputMode, frozen.ganttFilter) : renderOutput(document, blocks, frozen.outputMode, frozen.ganttFilter);
        parseOutput(output);
        if (frozen.outputLocation === 'daily') {
          const originalDoc = dailyDocument(originals[path]);
          let before = cleanDaily(renderDaily(originalDoc, originalDoc.blocks, frozen.outputMode, frozen.ganttFilter), plainSourceIds, new Map(), false).record;
          // Keep the exact previous display (including deadlines added by newer
          // renderers) and restore only current completion checkboxes for undo.
          if (before && inputs[path] !== null && !inputs[path]!.includes('<!-- auto-scheduler:start -->')) {
            for (const record of [trackingSnapshot[path]?.after, trackingSnapshot[path]?.before]) {
              if (!record) continue;
              try {
                if (rehydrate(inputs[path], { before:null, after:record,eventRecords:trackingSnapshot[path]?.eventRecords }) !== originals[path]) continue;
                let index=0; const checks=originalDoc.blocks.map(b=>b.completed ? 'x' : ' ');
                before = { visible:record.visible.replace(/^- \[[ xX]\]/gm,()=>`- [${checks[index++] ?? ' '}]`), annotated:before.annotated }; break;
              } catch { /* Try the other recovery record. */ }
            }
          }
          const eventClean=cleanEventMetadata(path,output,frozen.defaultEventDuration);
          const clean = cleanDaily(eventClean.text, plainSourceIds, new Map(parsed.tasks.map(t => [t.id, t.priority])), true, new Map(parsed.tasks.filter(t => t.due !== undefined && !isHabit(t.id)).map(t => [t.id, t.due!])));
          preview.nextTracking[path] = { before, after: frozen.cleanDaily ? clean.record : null,
            ...(frozen.cleanDaily&&eventClean.eventRecords.length?{eventRecords:eventClean.eventRecords}:{}) };
          preview.outputs[path] = options.preserveLayout ? (frozen.cleanDaily ? clean.text : output) : organizeDailyTasks(frozen.cleanDaily ? clean.text : output,frozen.defaultEventDuration);
        } else preview.outputs[path] = output;
      }
      if(!options.preserveLayout&&!formatOnly&&frozen.outputLocation==='daily')for(const task of allAiTasks){
        if(task.sourceRetired||task.sourceDetached)continue;
        const text=organizeDailyTasks(preview.outputs![task.path]??inputs[task.path]??'# Day planner\n',frozen.defaultEventDuration);
        preview.outputs![task.path]=ensureStudyGoal(text,task,aiTasks.find(t=>t.id===task.id));
      }
      preview.output = frozen.outputLocation === 'daily' ? Object.entries(preview.outputs).map(([path, output]) => `--- ${path} ---\n${output}`).join('\n') : preview.outputs[frozen.outputFile];
      preview.diff = diffBlocks(oldBlocks, result.blocks);
    }
  } catch (error) { preview.output = null; preview.result.errors.push({ path: frozen.outputFile, line: 0, message: (error as Error).message }); }
  return preview;
}
/** Undo owns the old display; an empty committed span must not retain it. */
export function trackingForCommit(preview:Preview):Tracking {
  const next:Tracking=structuredClone(preview.nextTracking);
  for(const path of Object.keys(preview.outputs??{}))if(next[path]&&!next[path].after)next[path]={...next[path],before:null,after:null};
  return next;
}
export async function applyPreview(vault: VaultPort, state: StatePort, preview: Preview, settings: Settings, now = new Date()): Promise<{ changed: boolean; warning?: string }> {
  if(state.getUndo?.()?.status==='partial')throw new Error('A partial write must be undone before another commit');
  if (preview.result.errors.length || preview.output === null) throw new Error('Preview contains errors and cannot be applied');
  if (preview.settingsKey !== settingKey(settings) || preview.timezone !== timezone() || preview.today !== dateKey(now)) throw new Error('Settings, time zone, or date changed. Preview again.');
  if (!same(preview.snapshot, await snapshot(vault, preview.settings, preview.today, preview.historyPaths, preview.sourcePaths, preview.explicitSources))) throw new Error('Tasks, habits template, fixed events, or output changed. Preview again.');
  if (state.getTracking && JSON.stringify(state.getTracking()) !== JSON.stringify(preview.tracking)) throw new Error('Tracking data changed. Preview again.');
  if (state.getAiTasks && JSON.stringify(state.getAiTasks()) !== JSON.stringify(preview.aiTasksBefore)) throw new Error('AI tasks changed. Preview again.');
  const outputs = preview.outputs ?? { [settings.outputFile]: preview.output };
  const nextTracking=trackingForCommit(preview);
  const entries: FileChange[] = Object.entries(outputs).filter(([path, after]) => preview.snapshot[path] !== after).map(([path, after]) => ({ path, before: preview.snapshot[path], after, trackingBefore: preview.nextTracking[path]?.before, trackingAfter: preview.nextTracking[path]?.after,
    restored: preview.sourcePaths.includes(path) && preview.snapshot[path] === null ? '' : settings.outputLocation === 'daily' && preview.snapshot[path] === null ? (settings.cleanDaily ? '# Day planner\n' : renderDaily(dailyDocument(null), [], settings.outputMode, settings.ganttFilter)) : undefined }));
  if (!entries.length) {
    if (JSON.stringify(preview.aiTasksBefore) !== JSON.stringify(preview.aiTasksAfter)||JSON.stringify(preview.tracking)!==JSON.stringify(nextTracking)) {
      const undo={entries:[],createdAt:now.toISOString(),aiTasksBefore:preview.aiTasksBefore,aiTasksAfter:preview.aiTasksAfter,
        trackingBeforeState:preview.tracking,trackingAfterState:nextTracking} as unknown as UndoRecord;
      await state.saveUndo(undo,nextTracking,preview.aiTasksAfter);
      return {changed:true};
    }
    return { changed: false };
  }
  if (preview.eventStarts?.some(start => start < epochMinute(now))) throw new Error('The start time of a new event has passed. Send your request again.');
  const added = new Set(preview.diff.added.map(b => b.id));
  if (preview.result.blocks.some(b => added.has(b.id) && !b.locked && !b.completed && b.start < epochMinute(now))) throw new Error('The start time of a new block has passed. Preview again.');
  const undo: UndoRecord = { ...entries[0], entries, createdAt: now.toISOString(), aiTasksBefore: preview.aiTasksBefore, aiTasksAfter: preview.aiTasksAfter,
    trackingBeforeState:preview.tracking,trackingAfterState:nextTracking };
  // Backup must be durable before any Markdown mutation. Retain it if a write fails.
  await state.saveUndo(undo, nextTracking, preview.aiTasksAfter);
  for (const entry of entries) await vault.writeChecked(entry.path, entry.before, entry.after);
  try {
    const after = await snapshot(vault, preview.settings, preview.today, preview.historyPaths, preview.sourcePaths, preview.explicitSources);
    const expected = { ...preview.snapshot, ...Object.fromEntries(entries.map(e => [e.path, e.after])) };
    if (!same(expected, after)) return { changed: true, warning: 'Inputs or outputs changed while writing. Inspect the results; you can undo and preview again.' };
  } catch { return { changed: true, warning: 'Schedule saved, but verification failed. Inspect the results; an undo backup is saved.' }; }
  return { changed: true };
}
export async function undoLast(vault: VaultPort, state: StatePort, record: UndoRecord | null): Promise<void> {
  if (!record) throw new Error('No schedule to undo');
  if (record.aiTasksAfter && state.getAiTasks && JSON.stringify(record.aiTasksAfter) !== JSON.stringify(state.getAiTasks())) throw new Error('AI tasks changed; refusing to overwrite during undo');
  if (record.trackingAfterState && state.getTracking && JSON.stringify(record.trackingAfterState) !== JSON.stringify(state.getTracking())) throw new Error('Tracking changed; refusing to overwrite during undo');
  const entries = record.entries ?? [record];
  // Preflight the entire batch. Retry after an interrupted undo can skip restored entries.
  const pending: FileChange[] = [];
  for (const entry of entries) {
    const current = await vault.read(entry.path), restored = entry.before ?? entry.restored ?? emptyManagedFile();
    if (current === entry.before || current === restored) continue;
    if (current !== entry.after) throw new Error('Output was modified or the last write did not finish; refusing to overwrite. Inspect the backup.');
    pending.push(entry);
  }
  // Keep the recovery lock durable until both note restoration and state save finish.
  await state.saveUndo({ ...record, status: 'partial' }, state.getTracking?.(), state.getAiTasks?.());
  for (const entry of pending) await vault.writeChecked(entry.path, entry.after, entry.before ?? entry.restored ?? emptyManagedFile());
  const tracking = record.trackingBeforeState ? structuredClone(record.trackingBeforeState) : { ...(state.getTracking?.() ?? {}) };
  for (const entry of entries) if (!record.trackingBeforeState && entry.trackingBefore !== undefined) tracking[entry.path] = { before: null, after: entry.trackingBefore };
  await state.saveUndo(null, tracking, record.aiTasksBefore);
}
