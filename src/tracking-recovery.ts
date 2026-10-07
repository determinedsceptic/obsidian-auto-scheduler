import { dayPlannerSection } from './daily';
import { START, END } from './output';
import { rehydrate } from './tracking';
import { parseBoundary, safeVaultPath } from './time';
import type { Settings, Tracking } from './types';

/** Explicitly release ownership; normal rehydration continues to reject edits. */
export function releaseEditedTracking(path: string, text: string, tracking: Tracking, settings: Settings): Tracking {
  if (settings.outputLocation !== 'daily' || !settings.cleanDaily || !safeVaultPath(path)
    || !path.startsWith(settings.dailyFolder + '/') || !/^\d{4}-\d{2}-\d{2}\.md$/.test(path.slice(settings.dailyFolder.length + 1))) {
    throw Error('Open a dated note in the configured daily folder with clean daily output enabled');
  }
  parseBoundary(path.slice(-13, -3));
  if (!dayPlannerSection(text) || text.includes(START) || text.includes(END)) throw Error('Recovery requires one plain Day planner section without managed markers');
  const pair = tracking[path];
  if (!pair?.after && !pair?.before&&!pair?.eventRecords?.length) throw Error('This note has no generated schedule tracking to recover');
  let conflict = false;
  try { rehydrate(text, pair); } catch { conflict = true; }
  if (!conflict) throw Error('The tracked schedule still matches; recovery is unnecessary');
  const next = structuredClone(tracking);
  delete next[path];
  return next;
}
