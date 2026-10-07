import { validAiTasks } from './llm';
import { validTracking } from './tracking';
import { safeVaultPath } from './time';
import type { FileChange, UndoRecord } from './types';

export function validUndoRecord(value: unknown): value is UndoRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as UndoRecord;
  const validEntry = (entry: FileChange): boolean => !!entry && typeof entry === 'object'
    && safeVaultPath(entry.path) && entry.path.endsWith('.md')
    && (entry.before === null || typeof entry.before === 'string') && typeof entry.after === 'string'
    && (entry.restored === undefined || typeof entry.restored === 'string');
  const entries = record.entries ?? [record];
  return typeof record.createdAt === 'string' && Number.isFinite(Date.parse(record.createdAt))
    && Array.isArray(entries) && entries.every(validEntry)
    && new Set(entries.map(entry => entry.path)).size === entries.length
    && (entries.length > 0 || record.aiTasksBefore !== undefined || record.trackingBeforeState !== undefined)
    && (record.operationId === undefined || (typeof record.operationId === 'string' && record.operationId.length > 0))
    && (record.status === undefined || ['committed', 'partial', 'failed'].includes(record.status))
    && (record.writtenPaths === undefined || (Array.isArray(record.writtenPaths)
      && record.writtenPaths.every(path => entries.some(entry => entry.path === path))
      && new Set(record.writtenPaths).size === record.writtenPaths.length))
    && (record.aiTasksBefore === undefined || validAiTasks(record.aiTasksBefore))
    && (record.aiTasksAfter === undefined || validAiTasks(record.aiTasksAfter))
    && (record.trackingBeforeState === undefined || validTracking(record.trackingBeforeState))
    && (record.trackingAfterState === undefined || validTracking(record.trackingAfterState));
}
