import type { ToolDefinition, ToolResult } from './agent-types';
import type { NoteWorkspace } from './note-workspace';
import { resolveEvents, validateEvents } from './event-tool';
import type { EventDraft } from './event-tool';
import { materializeTasks, validateDrafts } from './llm';
import type { TaskDraft } from './llm';
import { createPreview, trackingForCommit } from './transaction';
import type { StatePort, VaultPort } from './transaction';
import type { FileChange, Settings, Task, Tracking } from './types';
import { dateKey, epochMinute } from './time';
import { timezone } from './transaction';
import { bindTaskSource, goalSummary, sourceFingerprint } from './task-sources';
import { dailyInputs } from './daily';
import type { FlexibleCalendarRow } from './calendar-priority';

type ScheduleMode = 'add' | 'replan' | 'revise';

interface ScheduleTaskInput extends TaskDraft {
  id: string | null;
  sourceRef: string | null;
  effort: 'known' | 'unknown';
}

interface ScheduleArguments {
  mode: ScheduleMode;
  tasks: ScheduleTaskInput[];
  events: EventDraft[];
  habitRefs: string[];
  flexibleRefs: string[];
  changeSetRef?: string | null;
}

const taskProperties: Record<string, unknown> = {
  id: { type: ['string', 'null'], description: 'Existing AI task ID for replan/revise; null for a new task' },
  sourceRef: { type: ['string', 'null'], description: 'Read block reference for an untimed persistent checkbox outside Day planner. Required for new or previously unbound tasks; null keeps an existing binding.' },
  title: { type: 'string' },
  minutes: { type: ['integer', 'null'], description: 'User-supported total work estimate, or null if total effort is unknown. Unknown effort requires a separately confirmed rollingMinutes session budget; never infer a finish date from that budget.' },
  priority: { type: 'integer', enum: [1, 2, 3, 4, 5] },
  split: { type: 'boolean' },
  minMinutes: { type: 'integer' },
  due: { type: ['string', 'null'] },
  earliest: { type: ['string', 'null'] },
  dailyMinutes: { type: ['integer', 'null'] },
  estimateBasis: { type: ['string', 'null'] },
  rollingMinutes: { type: ['integer', 'null'], description: 'User-confirmed session budget for unknown total effort, not a total work estimate' },
};

const eventProperties: Record<string, unknown> = {
  title: { type: 'string' },
  date: { type: ['string', 'null'] },
  start: { type: 'string' },
  minutes: { type: ['integer', 'null'] },
  beforeMinutes: {type:['integer','null'],description:'Explicit buffer before the actual event, in minutes; null uses the configured buffer'},
  afterMinutes: {type:['integer','null'],description:'Explicit buffer after the actual event, in minutes; null uses the configured buffer'},
};

export const SCHEDULE_TOOL: ToolDefinition = {
  name: 'plan_schedule',
  description: 'Stage a scheduling plan. Exact events and their buffers take precedence over unfinished habits and flexible sessions. Existing habits are retained unless displaced. Use flexibleRefs only for read handwritten calendar rows the user has described as approximate or movable. Hard commitments still conflict. Returns a change set, not a commit.',
  strict: true,
  parameters: {
    type: 'object',
    properties: {
      mode: { type: 'string', enum: ['add', 'replan', 'revise'] },
      tasks: {
        type: 'array', maxItems: 20,
        items: { type: 'object', properties: taskProperties, required: Object.keys(taskProperties), additionalProperties: false },
      },
      events: {
        type: 'array', maxItems: 20,
        items: { type: 'object', properties: eventProperties, required: Object.keys(eventProperties), additionalProperties: false },
      },
      habitRefs: { type: 'array', maxItems: 20, items: { type: 'string' } },
      flexibleRefs: {type:'array',maxItems:20,items:{type:'string'},description:'Read block references for existing unchecked handwritten calendar plans whose times the user declared flexible; empty for none. Completed rows and fixed events cannot be reclassified.'},
      changeSetRef: { type: ['string', 'null'], description: 'Optional staged note change set to compose with this schedule' },
    },
    required: ['mode', 'tasks', 'events', 'habitRefs', 'flexibleRefs', 'changeSetRef'],
    additionalProperties: false,
  },
};

export const BIND_TASK_SOURCE_TOOL:ToolDefinition={
  name:'bind_task_source',description:'Rebind an existing task to a read untimed checkbox source after editing or moving it. Compose staged source edits with their exact changeSetRef. Keeps task ID, effort estimate and session history; does not allocate time.',strict:true,
  parameters:{type:'object',properties:{taskId:{type:'string'},sourceRef:{type:'string'},changeSetRef:{type:['string','null']},title:{type:['string','null'],description:'Optional updated task title; null keeps its existing title'}},required:['taskId','sourceRef','changeSetRef','title'],additionalProperties:false},
};

export async function rebindTaskSource(workspace:NoteWorkspace,state:StatePort,value:unknown):Promise<ToolResult>{
  try{
    const args=object(value,'Invalid source binding arguments');
    if(Object.keys(args).some(key=>!['taskId','sourceRef','changeSetRef','title'].includes(key))||typeof args.taskId!=='string'||typeof args.sourceRef!=='string')throw Error('Source binding requires taskId and sourceRef');
    if(args.changeSetRef!==null&&args.changeSetRef!==undefined&&(typeof args.changeSetRef!=='string'||!args.changeSetRef))throw Error('changeSetRef must be a staged reference or null');
    if(args.title!==null&&args.title!==undefined&&(typeof args.title!=='string'||!args.title.trim()||args.title.length>200||/[\r\n]/.test(args.title)))throw Error('Invalid updated task title');
    const prior=args.changeSetRef?workspace.getStagedChanges(args.changeSetRef as string):undefined;
    const tasks=copyTasks(prior?.state?.aiTasks??state.getAiTasks?.()??[]),index=tasks.findIndex(task=>task.id===args.taskId);
    if(index<0)throw Error('Unknown task ID');
    const source=taskSource(workspace,args.sourceRef,new Map((prior?.entries??[]).map(entry=>[entry.path,entry])),args.changeSetRef as string|null|undefined);
    tasks[index]={...tasks[index],...source,...(typeof args.title==='string'?{title:args.title.trim()}:{}),needsReview:source.completed||tasks[index].sourceDetached?false:tasks[index].needsReview};
    const staged=await workspace.stageExternalChanges({entries:prior?.entries??[],dependencies:{...(prior?.dependencies??{}),...workspace.getReadDependencies()},state:{...prior?.state,aiTasks:tasks},summary:prior?`${prior.summary}; Rebind task source`:'Rebind task source',validate:prior?.validate});
    return {ok:true,value:{...staged,goal:goalSummary(tasks[index])}};
  }catch(error){return {ok:false,error:(error as Error).message};}
}

function object(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function validateArguments(value: unknown, defaultDuration: number): ScheduleArguments {
  const args = object(value, 'Invalid schedule arguments');
  const expected = ['mode', 'tasks', 'events', 'habitRefs', 'flexibleRefs', 'changeSetRef'];
  const required = ['mode', 'tasks', 'events', 'habitRefs'];
  if (Object.keys(args).some(key => !expected.includes(key)) || required.some(key => !(key in args))) throw new Error('Invalid schedule argument fields');
  if (!['add', 'replan', 'revise'].includes(String(args.mode))) throw new Error('Schedule mode must be add, replan, or revise');
  if (!Array.isArray(args.tasks) || args.tasks.length > 20) throw new Error('Schedule tasks must be an array of at most 20 items');
  if (!Array.isArray(args.events) || args.events.length > 20) throw new Error('Schedule events must be an array of at most 20 items');
  if (!Array.isArray(args.habitRefs) || args.habitRefs.length > 20 || args.habitRefs.some(ref => typeof ref !== 'string' || !ref)) throw new Error('Habit references must be non-empty reference strings');
  if (new Set(args.habitRefs).size !== args.habitRefs.length) throw new Error('Habit references cannot contain duplicates');
  const flexibleRefs=args.flexibleRefs??[];
  if(!Array.isArray(flexibleRefs)||flexibleRefs.length>20||flexibleRefs.some(ref=>typeof ref!=='string'||!ref)||new Set(flexibleRefs).size!==flexibleRefs.length)throw Error('Flexible references must be unique non-empty reference strings');
  if (args.changeSetRef !== undefined && args.changeSetRef !== null && (typeof args.changeSetRef !== 'string' || !args.changeSetRef)) throw new Error('changeSetRef must be a non-empty staged change reference or null');

  const rawTasks = args.tasks.map((value, index) => {
    const raw = object(value, `Invalid schedule task at index ${index}`);
    const fields = ['id', 'sourceRef', ...Object.keys(taskProperties).filter(key => !['id', 'sourceRef'].includes(key))];
    if (Object.keys(raw).some(key => !fields.includes(key)) || fields.some(key => !(key in raw))) throw new Error('Invalid schedule task fields');
    if (raw.id !== null && (typeof raw.id !== 'string' || !/^ai_[A-Za-z0-9_-]+$/.test(raw.id))) throw new Error('Task ID must be an existing AI task ID or null');
    if (raw.sourceRef !== null && (typeof raw.sourceRef !== 'string' || !raw.sourceRef)) throw new Error('Task sourceRef must be a non-empty read reference or null');
    return raw;
  });
  if (new Set(rawTasks.flatMap(task => task.id === null ? [] : [task.id])).size !== rawTasks.filter(task => task.id !== null).length) throw new Error('Task IDs cannot be repeated');
  const normalized = rawTasks.map(({ id: _id, sourceRef: _sourceRef, ...task }) => {
    if(task.minutes===null){
      if(task.rollingMinutes===null||task.dailyMinutes===null)throw Error('Unknown total effort needs a user-confirmed session budget and pace. Preserve the source and ask for that budget; do not substitute a default total duration.');
      return {...task,minutes:task.rollingMinutes};
    }
    if(task.rollingMinutes!==null)throw Error('A rolling session budget requires minutes:null because total effort is unknown');
    return task;
  });
  const checked = normalized.length ? validateDrafts({ tasks: normalized }, defaultDuration) : [];
  const tasks = checked.map((task, index):ScheduleTaskInput => ({ ...task, id: rawTasks[index].id as string | null, sourceRef: rawTasks[index].sourceRef as string | null, effort:rawTasks[index].minutes===null?'unknown':'known' }));
  const events = args.events.length ? validateEvents({ events: args.events }) : [];
  return { mode: args.mode as ScheduleMode, tasks, events, habitRefs: args.habitRefs as string[], flexibleRefs:flexibleRefs as string[], changeSetRef: args.changeSetRef as string | null | undefined };
}

function copyTasks(tasks: Task[]): Task[] {
  return JSON.parse(JSON.stringify(tasks)) as Task[];
}

function uniqueBatchId(existing: Task[], now: Date): string {
  const stem = `schedule_${now.getTime().toString(36)}`;
  let suffix = 0;
  while (existing.some(task => task.id.startsWith(`ai_${stem}${suffix ? `_${suffix}` : ''}_`))) suffix++;
  return `${stem}${suffix ? `_${suffix}` : ''}`;
}

function assertSourceSurvives(source: { path: string; text: string }, staged: Map<string, FileChange>): void {
  const edit = staged.get(source.path);
  if (edit && !edit.after.includes(source.text)) throw new Error(`A staged edit changed the referenced source block: ${source.path}`);
}

function taskSource(workspace: NoteWorkspace, ref: string, staged: Map<string, FileChange>,changeSetRef?:string|null):ReturnType<typeof bindTaskSource> {
  const source = workspace.resolveReference(ref);
  assertSourceSurvives(source, staged);
  return bindTaskSource(source,changeSetRef);
}

function overlayVault(vault: VaultPort, entries: FileChange[]): VaultPort {
  const overlay = new Map(entries.map(entry => [entry.path, entry.after]));
  return {
    listTasks: async (folder, excluded) => {
      const paths = new Set(await vault.listTasks(folder, excluded));
      for (const path of overlay.keys()) if (path.startsWith(`${folder}/`) && path.endsWith('.md') && !excluded.includes(path)) paths.add(path);
      return [...paths].sort();
    },
    read: async path => overlay.has(path) ? overlay.get(path)! : vault.read(path),
    writeChecked: async () => { throw new Error('Schedule preview cannot write through its overlay'); },
  };
}

function combinedEntries(staged: FileChange[], scheduled: FileChange[]): FileChange[] {
  const result = new Map(staged.map(entry => [entry.path, { ...entry }]));
  for (const entry of scheduled) {
    const earlier = result.get(entry.path);
    result.set(entry.path, earlier ? { ...entry, before: earlier.before, restored: earlier.restored } : entry);
  }
  return [...result.values()].filter(entry => entry.before !== entry.after);
}

function previewEntries(outputs: Record<string, string> | undefined, snapshot: Record<string, string | null>, nextTracking: Tracking): FileChange[] {
  return Object.entries(outputs ?? {}).filter(([path, after]) => snapshot[path] !== after).map(([path, after]) => ({
    path,
    before: snapshot[path] ?? null,
    after,
    ...(snapshot[path]===null?{restored:''}:{}),
    trackingBefore: nextTracking[path]?.before,
    trackingAfter: nextTracking?.[path]?.after,
  }));
}

/** Build and stage a schedule. File and state mutations happen only through a later commit_changes call. */
export async function planSchedule(workspace: NoteWorkspace, vault: VaultPort, state: StatePort, settings: Settings, value: unknown, now: Date, clock: () => Date = () => new Date()): Promise<ToolResult> {
  try {
    // The generic adapter owns only Day planner output. Keep the user's persisted
    // legacy renderer settings untouched for legacy entry points.
    const adapterSettings: Settings = { ...settings, outputLocation: 'daily', outputMode: 'day-planner' };
    const args = validateArguments(value, adapterSettings.defaultEventDuration);
    const prior = args.changeSetRef ? workspace.getStagedChanges(args.changeSetRef) : undefined;
    const priorEntries = prior?.entries ?? [];
    const stagedByPath = new Map(priorEntries.map(entry => [entry.path, entry]));
    const previewVault = overlayVault(vault, priorEntries);
    const before = copyTasks(prior?.state?.aiTasks ?? state.getAiTasks?.() ?? []);
    const beforeTracking = prior?.state?.tracking ?? state.getTracking?.() ?? {};
    const byId = new Map(before.map(task => [task.id, task]));
    const batchId = uniqueBatchId(before, now);
    const newDrafts: TaskDraft[] = [];
    const newInputs: ScheduleTaskInput[] = [];
    const replacements = new Map<string, Task>();

    for (const input of args.tasks) {
      if (args.mode === 'add' && input.id !== null) throw new Error('Add mode accepts only new tasks with null IDs');
      if (args.mode === 'revise' && input.id === null) throw new Error('Revise mode requires an existing task ID for every task');
      if (input.id !== null) {
        const previous = byId.get(input.id);
        if (!previous) throw new Error(`Unknown AI task ID: ${input.id}`);
        if(!previous.sourceText&&input.sourceRef===null)throw Error('This legacy task has no persistent source. Read or stage its untimed source and bind it before scheduling.');
        if (args.mode === 'replan') {
          if (input.sourceRef !== null) {
            const source = taskSource(workspace, input.sourceRef, stagedByPath,args.changeSetRef);
            replacements.set(input.id, { ...previous, ...source });
          }
          continue;
        }
        const { id: _id, sourceRef, effort, ...draft } = input;
        const revised = materializeTasks([draft], adapterSettings, now, `${batchId}_revision`)[0];
        const updated={...previous,...revised,id:input.id,path:previous.path,sourceText:previous.sourceText,sourceOccurrence:previous.sourceOccurrence,sourceCount:previous.sourceCount,sourceStatus:previous.sourceStatus,completed:previous.completed,effort,
          sessionPaths:previous.sessionPaths??[],completedSessions:previous.completedSessions??{},completedMinutes:previous.completedMinutes??0};
        if (sourceRef !== null) {
          const source = taskSource(workspace, sourceRef, stagedByPath,args.changeSetRef);
          replacements.set(input.id, { ...updated,...source });
        } else replacements.set(input.id, updated);
      } else {
        if(input.sourceRef===null)throw Error('New tasks require a persistent untimed checkbox source outside Day planner. Stage and read the source before scheduling.');
        const { id: _id, sourceRef: _sourceRef, effort:_effort, ...draft } = input;
        newDrafts.push(draft);
        newInputs.push(input);
      }
    }

    const created = newDrafts.length ? materializeTasks(newDrafts, adapterSettings, now, batchId) : [];
    for (let index = 0; index < created.length; index++) {
      const sourceRef = newInputs[index].sourceRef;
      const source = taskSource(workspace, sourceRef!, stagedByPath,args.changeSetRef);
      if(source.sourceStatus!=='open')throw Error('A new scheduled task needs an open source. Completed or cancelled sources can only synchronize an existing task.');
      created[index] = { ...created[index],...source,effort:newInputs[index].effort };
    }

    const aiTasksAfter = before.map(task => replacements.get(task.id) ?? task).concat(created);
    const unbound=aiTasksAfter.find(task=>!task.completed&&!task.sourceText&&!task.sourceDetached);
    if(unbound)throw Error(`Task has no persistent source: ${unbound.title}. Read or stage its source and use bind_task_source before replanning.`);
    const bindings=aiTasksAfter.filter(task=>task.sourceText).map(task=>JSON.stringify([task.path,sourceFingerprint(task.sourceText!),task.sourceOccurrence??null]));
    if(new Set(bindings).size!==bindings.length)throw Error('A source is already bound to a task. Replan or revise that task ID instead of creating a duplicate.');
    const habitSources: Record<string, string> = {};
    for (const ref of args.habitRefs) {
      const source = workspace.resolveReference(ref);
      assertSourceSurvives(source, stagedByPath);
      habitSources[source.path] = habitSources[source.path] === undefined ? source.text : `${habitSources[source.path]}\n${source.text}`;
    }

    const events = args.events.length ? resolveEvents(args.events, adapterSettings, now) : [];
    const flexibleRows:FlexibleCalendarRow[]=args.flexibleRefs.map(ref=>{
      const source=workspace.resolveReference(ref);
      assertSourceSurvives(source,stagedByPath);
      if(source.kind!=='block'||(source.changeSetRef&&source.changeSetRef!==args.changeSetRef))throw Error('Read the flexible calendar block from the applicable saved or staged note');
      const row=dailyInputs(source.path,source.documentText,adapterSettings.defaultEventDuration).rows.find(row=>row.sourceStart===source.start&&row.sourceEnd===source.end);
      if(!row||!row.standalone||!row.checkbox||row.completed||!row.body||row.reminder===null||row.beforeMinutes!==undefined)throw Error('A flexible reference must select one unchecked handwritten clock plan, without extra timed calendar fields, not a fixed event or completed record');
      return {path:source.path,raw:row.raw,start:row.start,end:row.end};
    });
    const preview = await createPreview(previewVault, adapterSettings, now, beforeTracking, false, before, [], {}, events,
      { dailyUpdates: {}, aiTasksAfter }, { preserveLayout: true, explicitSources: true, flexibleRows, ...(Object.keys(habitSources).length ? { habitSources } : {}) });
    if (preview.result.errors.length || preview.output === null) {
      return {
        ok: false,
        error: 'Schedule preview contains errors',
        value: { errors: preview.result.errors, blocks: preview.result.blocks, unscheduled: preview.result.unscheduled, days: preview.result.days, notes:preview.result.notes??[] },
      };
    }

    const readDependencies = workspace.getReadDependencies();
    const originalSnapshot = Object.fromEntries(Object.entries(preview.snapshot).map(([path, content]) => [path, stagedByPath.has(path) ? stagedByPath.get(path)!.before : content]));
    const staleRead = Object.keys(readDependencies).find(path => path in preview.snapshot && readDependencies[path] !== originalSnapshot[path]);
    if (staleRead) return { ok: false, error: `Read reference changed before scheduling: ${staleRead}` };

    const scheduledEntries = previewEntries(preview.outputs, preview.snapshot, preview.nextTracking);
    const entries = combinedEntries(priorEntries, scheduledEntries);
    const committedTracking=trackingForCommit(preview);
    const scheduleSummary = `Proposed ${preview.result.blocks.length} scheduled block${preview.result.blocks.length === 1 ? '' : 's'} and ${events.length} exact event${events.length === 1 ? '' : 's'}`;

    const staged = await workspace.stageExternalChanges({
      entries,
      dependencies: { ...originalSnapshot, ...(prior?.dependencies ?? {}), ...readDependencies },
      state: { tracking: committedTracking, aiTasks: preview.aiTasksAfter },
      summary: prior ? `${prior.summary}; ${scheduleSummary}` : scheduleSummary,
      validate: async () => {
        await prior?.validate?.();
        const current = clock();
        if (preview.timezone !== timezone() || preview.today !== dateKey(current)) throw new Error('Schedule date or time zone changed. Plan again.');
        const minute = epochMinute(current);
        if (preview.eventStarts?.some(start => start < minute)) throw new Error('The start time of a new event has passed. Plan again.');
        const added = new Set(preview.diff.added.map(block => block.id));
        if (preview.result.blocks.some(block => added.has(block.id) && !block.locked && !block.completed && block.start < minute)) throw new Error('The start time of a new block has passed. Plan again.');
      },
    });
    return {
      ok: true,
      value: {
        ...staged,
        events,
        blocks: preview.result.blocks,
        unscheduled: preview.result.unscheduled,
        days: preview.result.days,
        goals: preview.aiTasksAfter.map(goalSummary),
        notes: preview.result.notes??[],
      },
    };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}
