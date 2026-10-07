/** Times are integer minutes since the Unix epoch; all displayed dates are local. */
export interface Interval { start: number; end: number; beforeMinutes?: number; afterMinutes?: number }
export interface Diagnostic { path: string; line: number; message: string }
export interface Task {
  id: string; title: string; path: string; line: number; remaining: number;
  priority: number; due?: number; earliest?: number; split: boolean; min: number; completed: boolean; dailyMinutes?: number; estimateBasis?: string; rollingMinutes?: number; sourceText?:string;
  /** Optional migration-safe fields used by source-linked tasks. */
  effort?:'known'|'unknown'; sourceOccurrence?:number; sourceCount?:number; sourceStatus?:'open'|'completed'|'cancelled'; sourceRetired?:boolean;
  sessionPaths?:string[]; completedSessions?:Record<string,number>; completedMinutes?:number; needsReview?:boolean;
}
export interface Block extends Interval {
  priority?: number;
  id: string; taskId: string; date: string; title: string; path: string;
  locked: boolean; completed: boolean; raw?: string;
}
export interface Settings {
  taskFolder: string; habitFolder: string; fixedFile: string; outputFile: string; weekdays: number[];
  periods: string[]; defaultEventDuration: number; dailyCapacity: number; fixedBuffer: number; blockBuffer: number;
  outputMode: 'plain' | 'day-planner' | 'gantt';
  outputLocation: 'single' | 'daily'; dailyFolder: string; ganttFilter: string; cleanDaily: boolean; balanceLoad?: boolean;
}
export const DEFAULT_SETTINGS: Settings = {
  taskFolder: 'Tasks', habitFolder: 'Habits', fixedFile: 'Scheduler/Fixed.md', outputFile: 'Scheduler/Schedule.md',
  weekdays: [1, 2, 3, 4, 5], defaultEventDuration: 30, periods: ['09:00-12:00', '14:00-18:00'],
  dailyCapacity: 360, fixedBuffer: 15, blockBuffer: 15, outputMode: 'plain', outputLocation: 'single', dailyFolder: 'DailyNotes', ganttFilter: '🎯', cleanDaily: true,
};
export interface Unscheduled { taskId: string; title: string; remaining: number; reason: string }
export interface DaySummary { date: string; occupied: number; capacity: number; overCapacity: boolean }
export interface ScheduleResult {
  blocks: Block[]; unscheduled: Unscheduled[]; days: DaySummary[]; errors: Diagnostic[]; notes?:string[];
}
export interface OutputDocument { prefix: string; suffix: string; newline: string; blocks: Block[] }
export interface DailyTracking { visible: string; annotated: string }
export interface TrackingPair { before: DailyTracking | null; after: DailyTracking | null; eventRecords?:DailyTracking[] }
export type Tracking = Record<string, TrackingPair>;
export interface FileChange { trackingBefore?: DailyTracking | null; trackingAfter?: DailyTracking | null; path: string; before: string | null; after: string; restored?: string }
export interface UndoRecord extends FileChange { entries?: FileChange[]; createdAt: string; operationId?:string; status?:'committed'|'partial'|'failed'; writtenPaths?:string[]; trackingBeforeState?:Tracking; trackingAfterState?:Tracking; aiTasksBefore?: Task[]; aiTasksAfter?: Task[] }
export interface AgentSettings { noteFolders:string[]; skillFiles:string[]; maxSteps:number; maxContextChars:number; timeoutMs:number }
export const DEFAULT_AGENT_SETTINGS:AgentSettings={noteFolders:[],skillFiles:[],maxSteps:32,maxContextChars:120000,timeoutMs:180000};
export interface PluginState { settings: Settings; undo: UndoRecord | null; tracking: Tracking; aiTasks: Task[]; llm: LlmSettings; byok?: ByokSettings; agent?:AgentSettings }

export interface LlmSettings { protocol: 'responses' | 'chat-completions' | 'anthropic' | 'gemini'; baseUrl: string; model: string; requiresKey?: boolean }
export const DEFAULT_LLM: LlmSettings = { protocol: 'responses', baseUrl: 'https://api.openai.com/v1', model: 'gpt-6-luna' };

export interface ProviderConfig { id: string; name: string; protocol: LlmSettings['protocol']; baseUrl: string; requiresKey: boolean; models: string[] }
export interface ByokSettings { namespace: string; providers: ProviderConfig[]; activeProviderId: string; activeModel: string }
