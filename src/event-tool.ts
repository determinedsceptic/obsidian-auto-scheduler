import { clockMinutes, endAfter, localMinute, addDays, dateKey, epochMinute } from './time';
import { DEFAULT_SETTINGS } from './types';
import type { Settings, Interval } from './types';
export interface EventDraft { title: string; date: string | null; start: string; minutes: number | null }
export interface ResolvedEvent extends Interval { title: string; date: string; startTime: string; endTime: string; defaulted: boolean; dateDefaulted: boolean }
export const eventTool = {
  name: 'create_events', description: 'Record one-off events at the exact user-specified start time. Use null minutes if no duration or end time was supplied; the host applies its configured default.', strict: true,
  parameters: { type: 'object', properties: { events: { type: 'array', items: { type: 'object', properties: {
    title: { type: 'string' }, date: { type: ['string', 'null'], description: 'Local YYYY-MM-DD; null if unspecified, for the next occurrence of the start time' }, start: { type: 'string', description: 'User-specified HH:mm, on a 15-minute grid' },
    minutes: { type: ['integer', 'null'], description: 'Explicit duration in minutes, a multiple of 15; null if unspecified' },
  }, required: ['title', 'date', 'start', 'minutes'], additionalProperties: false } } }, required: ['events'], additionalProperties: false },
};
export function validateEvents(value: unknown): EventDraft[] {
  const args = value as { events?: unknown };
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(k => k !== 'events') || !Array.isArray(args.events) || !args.events.length || args.events.length > 20) throw new Error('Create 1–20 fixed events per request');
  return args.events.map(input => {
    const e = input as EventDraft;
    if (!e || typeof e !== 'object' || Array.isArray(e) || Object.keys(e).length !== 4 || Object.keys(e).some(k => !['title','date','start','minutes'].includes(k))) throw new Error('Invalid event fields');
    if (typeof e.title !== 'string' || !e.title.trim() || e.title.length > 200 || /[\r\n\x00-\x1f<>\[\]%]/.test(e.title)) throw new Error('Event titles must be plain single-line text');
    if ((e.date !== null && (typeof e.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(e.date))) || typeof e.start !== 'string') throw new Error('Invalid event date or start time');
    if (e.date !== null) localMinute(e.date,e.start);
    if (clockMinutes(e.start) % 15) throw new Error('Event start must use the 15-minute grid');
    if (e.minutes !== null && (!Number.isInteger(e.minutes) || e.minutes < 15 || e.minutes > 1440 || e.minutes % 15)) throw new Error('Event duration must be a positive multiple of 15 minutes');
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
    return { title:e.title,date,startTime:e.start,endTime,start,end,defaulted:e.minutes === null,dateDefaulted:e.date === null };
  });
}
