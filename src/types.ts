/** Times are integer minutes since the Unix epoch; all displayed dates are local. */
export interface Interval { start: number; end: number }
export interface Diagnostic { path: string; line: number; message: string }
export interface Task {
  id: string; title: string; path: string; line: number; remaining: number;
  priority: number; due?: number; earliest?: number; split: boolean; min: number; completed: boolean;
}
export interface Block extends Interval {
  id: string; taskId: string; date: string; title: string; path: string;
  locked: boolean; completed: boolean; raw?: string;
}
export interface Settings {
  taskFolder: string; fixedFile: string; outputFile: string; weekdays: number[];
  periods: string[]; dailyCapacity: number; fixedBuffer: number; blockBuffer: number;
  outputMode: 'plain' | 'day-planner' | 'gantt';
  outputLocation: 'single' | 'daily'; dailyFolder: string; ganttFilter: string; cleanDaily: boolean;
}
export const DEFAULT_SETTINGS: Settings = {
  taskFolder: 'Tasks', fixedFile: 'Scheduler/Fixed.md', outputFile: 'Scheduler/Schedule.md',
  weekdays: [1, 2, 3, 4, 5], periods: ['09:00-12:00', '14:00-18:00'],
  dailyCapacity: 360, fixedBuffer: 15, blockBuffer: 15, outputMode: 'plain', outputLocation: 'single', dailyFolder: 'DailyNotes', ganttFilter: '🎯', cleanDaily: true,
};
export interface Unscheduled { taskId: string; title: string; remaining: number; reason: string }
export interface DaySummary { date: string; occupied: number; capacity: number; overCapacity: boolean }
export interface ScheduleResult {
  blocks: Block[]; unscheduled: Unscheduled[]; days: DaySummary[]; errors: Diagnostic[];
}
export interface OutputDocument { prefix: string; suffix: string; newline: string; blocks: Block[] }
export interface DailyTracking { visible: string; annotated: string }
export interface TrackingPair { before: DailyTracking | null; after: DailyTracking | null }
export type Tracking = Record<string, TrackingPair>;
export interface FileChange { trackingBefore?: DailyTracking | null; trackingAfter?: DailyTracking | null; path: string; before: string | null; after: string; restored?: string }
export interface UndoRecord extends FileChange { entries?: FileChange[]; createdAt: string }
export interface PluginState { settings: Settings; undo: UndoRecord | null; tracking: Tracking }
