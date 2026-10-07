import { clockMinutes, endAfter, localMinute, addDays, dateKey, epochMinute } from './time';
import { DEFAULT_SETTINGS } from './types';
import type { Settings, Interval } from './types';
export interface EventDraft { title: string; date: string | null; start: string; minutes: number | null; beforeMinutes?: number | null; afterMinutes?: number | null }
export interface EventBuffers { beforeMinutes: number; afterMinutes: number }
export interface ResolvedEvent extends Interval { title: string; date: string; startTime: string; endTime: string; beforeMinutes: number; afterMinutes: number; defaulted: boolean; dateDefaulted: boolean }
export const eventTool = {
  name: 'create_events', description: 'Record one-off events at the exact user-specified start time. Use null minutes if no duration or end time was supplied; the host applies its configured default. Keep the actual event times and use beforeMinutes/afterMinutes for requested preparation, travel, or recovery time; null uses the configured event buffer.', strict: true,
  parameters: { type: 'object', properties: { events: { type: 'array', items: { type: 'object', properties: {
    title: { type: 'string' }, date: { type: ['string', 'null'], description: 'Local YYYY-MM-DD; null if unspecified, for the next occurrence of the start time' }, start: { type: 'string', description: 'User-specified HH:mm, on a 15-minute grid' },
    minutes: { type: ['integer', 'null'], description: 'Explicit duration in minutes, a multiple of 15; null if unspecified' },
    beforeMinutes: { type: ['integer', 'null'], description: 'Requested time to reserve before the event, 0–1440 in multiples of 15; null if unspecified' },
    afterMinutes: { type: ['integer', 'null'], description: 'Requested time to reserve after the event, 0–1440 in multiples of 15; null if unspecified' },
  }, required: ['title', 'date', 'start', 'minutes', 'beforeMinutes', 'afterMinutes'], additionalProperties: false } } }, required: ['events'], additionalProperties: false },
};
function validBuffer(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 1440 || value % 15) throw new Error(`${field} must be 0–1440 minutes in multiples of 15`);
  return value;
}
/** Expand the occupied interval without changing the actual event times. */
export function reserveEvent(interval: Interval, defaultBuffer: number): Interval {
  const before = validBuffer(interval.beforeMinutes ?? defaultBuffer, 'beforeMinutes');
  const after = validBuffer(interval.afterMinutes ?? defaultBuffer, 'afterMinutes');
  return { start: interval.start - before, end: interval.end + after };
}
/** Resolved values persist even if the global buffer changes after a restart. */
export function renderEventMetadata(buffers: EventBuffers): string {
  const before = validBuffer(buffers.beforeMinutes, 'beforeMinutes');
  const after = validBuffer(buffers.afterMinutes, 'afterMinutes');
  return `<!-- as-event before=${before} after=${after} -->`;
}
/** Missing metadata retains legacy fallback; malformed metadata must stop scheduling. */
export function parseEventMetadata(row: string): EventBuffers | null {
  const markers = row.match(/<!--\s*as-event/g) ?? [];
  if (!markers.length) return null;
  const comments = row.match(/<!--\s*as-event\b[^\r\n]*?-->/g) ?? [];
  if (markers.length !== 1 || comments.length !== 1) throw new Error('Invalid event buffer metadata: use one <!-- as-event before=N after=N --> comment');
  const match = /^<!--\s*as-event\s+(.+?)\s*-->$/.exec(comments[0]);
  if (!match) throw new Error('Invalid event buffer metadata');
  const values: Partial<EventBuffers> = {};
  for (const token of match[1].trim().split(/\s+/)) {
    const field = /^(before|after)=(\d+)$/.exec(token);
    if (!field) throw new Error(`Invalid event buffer metadata field: ${token}`);
    const key = field[1] === 'before' ? 'beforeMinutes' : 'afterMinutes';
    if (values[key] !== undefined) throw new Error(`Duplicate event buffer metadata field: ${field[1]}`);
    values[key] = validBuffer(Number(field[2]), key);
  }
  if (values.beforeMinutes === undefined || values.afterMinutes === undefined) throw new Error('Event buffer metadata requires before and after values');
  return { beforeMinutes: values.beforeMinutes, afterMinutes: values.afterMinutes };
}
export function eventRow(event: ResolvedEvent): string {
  return `- [ ] ${event.startTime} - ${event.endTime} ${event.title} ${renderEventMetadata(event)}`;
}
export function validateEvents(value: unknown): EventDraft[] {
  const args = value as { events?: unknown };
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(k => k !== 'events') || !Array.isArray(args.events) || !args.events.length || args.events.length > 20) throw new Error('Create 1–20 fixed events per request');
  return args.events.map(input => {
    const e = input as EventDraft;
    if (!e || typeof e !== 'object' || Array.isArray(e) || ['title','date','start','minutes'].some(k => !Object.prototype.hasOwnProperty.call(e, k)) || Object.keys(e).some(k => !['title','date','start','minutes','beforeMinutes','afterMinutes'].includes(k))) throw new Error('Invalid event fields');
    if (typeof e.title !== 'string' || !e.title.trim() || e.title.length > 200 || /[\r\n\x00-\x1f<>\[\]%]/.test(e.title)) throw new Error('Event titles must be plain single-line text');
    if ((e.date !== null && (typeof e.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(e.date))) || typeof e.start !== 'string') throw new Error('Invalid event date or start time');
    if (e.date !== null) localMinute(e.date,e.start);
    if (clockMinutes(e.start) % 15) throw new Error('Event start must use the 15-minute grid');
    if (e.minutes !== null && (!Number.isInteger(e.minutes) || e.minutes < 15 || e.minutes > 1440 || e.minutes % 15)) throw new Error('Event duration must be a positive multiple of 15 minutes');
    for (const field of ['beforeMinutes', 'afterMinutes'] as const) if (e[field] !== undefined && e[field] !== null) validBuffer(e[field], field);
    return { ...e, title:e.title.trim() };
  });
}
export function resolveEvents(events: EventDraft[], settings: Settings, now: Date): ResolvedEvent[] {
  return validateEvents({ events }).map(e => {
    const today = dateKey(now);
    const date = e.date ?? (localMinute(today, e.start) < epochMinute(now) ? addDays(today, 1) : today);
    const minutes = e.minutes ?? settings.defaultEventDuration ?? DEFAULT_SETTINGS.defaultEventDuration;
    const endTime = endAfter(e.start,minutes), start = localMinute(date,e.start), end = localMinute(date,endTime);
    if (date < today || date >= addDays(today,7) || start < epochMinute(now)) throw new Error('Fixed events must start in the next seven days and cannot be in the past');
    return { title:e.title,date,startTime:e.start,endTime,start,end,beforeMinutes:validBuffer(e.beforeMinutes ?? settings.fixedBuffer, 'beforeMinutes'),afterMinutes:validBuffer(e.afterMinutes ?? settings.fixedBuffer, 'afterMinutes'),defaulted:e.minutes === null,dateDefaulted:e.date === null };
  });
}
