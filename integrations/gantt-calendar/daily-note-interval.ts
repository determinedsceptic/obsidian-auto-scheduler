/** Clean Day Planner intervals. Dates come from the note name, never the deadline. */
export function dailyNoteInterval(path: string, lines: string[], lineNumber: number): { start: string; end: string } | null {
  const date = /(?:^|\/)(\d{4}-\d{2}-\d{2})\.md$/.exec(path)?.[1];
  if (!date || lineNumber < 0 || lineNumber >= lines.length) return null;
  const [year, month, day] = date.split('-').map(Number);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.toISOString().slice(0, 10) !== date) return null;
  let active = false;
  let fence: { char: string; length: number } | null = null;
  for (let i = 0; i <= lineNumber; i++) {
    const text = lines[i].replace(/\r$/, '');
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(text)?.[1];
    if (marker) {
      if (!fence) fence = { char: marker[0], length: marker.length };
      else if (marker[0] === fence.char && marker.length >= fence.length) fence = null;
      if (i === lineNumber) return null;
      continue;
    }
    if (fence) { if (i === lineNumber) return null; continue; }
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(text);
    if (heading?.[1].length === 1) active = heading[2].trim().toLowerCase() === 'day planner';
  }
  if (!active) return null;
  const row = /^\s*[-*+]\s+\[.\]\s+(\d{1,2}:\d{2})(?:\s*[-–—]\s*(\d{1,2}:\d{2}))?\s+\S/.exec(lines[lineNumber]);
  if (!row) return null;
  const minutes = (clock: string): number => {
    const [h, m] = clock.split(':').map(Number);
    return m < 60 && (h < 24 || h === 24 && m === 0) ? h * 60 + m : NaN;
  };
  const start = minutes(row[1]), end = row[2] ? minutes(row[2]) : start + 30;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= 1440 || end <= start || end > 1440) return null;
  const stamp = (value: number): string => {
    const dayDate = new Date(check);
    if (value === 1440) { dayDate.setUTCDate(dayDate.getUTCDate() + 1); value = 0; }
    return `${dayDate.toISOString().slice(0, 10)} ${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
  };
  return { start: stamp(start), end: stamp(end) };
}

/** Completion changes must preserve clocks, priority, real deadline and exact title. */
export function completeDailyRow(line: string, completed: boolean, completionDate?: string): string {
  if (!/^\s*[-*+]\s+\[.\]\s+\d{1,2}:\d{2}/.test(line)) throw new Error('Invalid daily task');
  let next = line.replace(/\[.\]/, completed ? '[x]' : '[ ]').replace(/\s+✅\s+\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?\s*$/, '');
  if (completed && completionDate) next += ` ✅ ${completionDate}`;
  return next;
}
