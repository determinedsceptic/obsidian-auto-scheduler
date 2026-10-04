import { describe, expect, it } from 'vitest';
import { dailyNoteInterval, completeDailyRow } from '../integrations/gantt-calendar/daily-note-interval';
const path = 'DailyNotes/2026-10-04.md';
describe('Clean daily calendar intervals', () => {
  it('uses the file date and clocks independently of deadline and completion', () => {
    const row = '- [x] 12:40 - 13:10 🔼 Walk 📅 2026-10-20 ✅ 2026-10-04';
    expect(dailyNoteInterval(path, ['# Day planner', row], 1)).toEqual({start:'2026-10-04 12:40',end:'2026-10-04 13:10'});
    expect(completeDailyRow(row, false)).toBe('- [ ] 12:40 - 13:10 🔼 Walk 📅 2026-10-20');
    expect(completeDailyRow(completeDailyRow(row, false), true, '2026-10-04')).toBe(row);
  });
  it('defaults a start-only appointment to 30 minutes and rolls midnight', () => {
    expect(dailyNoteInterval(path, ['# Day planner', '- [ ] 23:30 Call'], 1)).toEqual({start:'2026-10-04 23:30',end:'2026-10-05 00:00'});
  });
  it.each(['- [ ] 25:00 - 26:00 Invalid','- [ ] 10:60 - 11:30 Invalid','- [ ] 11:00 - 10:00 Invalid','- [ ] 23:45 Call'])('rejects invalid interval %s', row => {
    expect(dailyNoteInterval(path, ['# Day planner', row], 1)).toBeNull();
  });
  it('ignores fences, other sections and non-date files', () => {
    const row = '- [ ] 09:00 - 10:00 Task';
    expect(dailyNoteInterval('Habits/Walk.md', ['# Day planner', row], 1)).toBeNull();
    expect(dailyNoteInterval('DailyNotes/2026-02-30.md', ['# Day planner', row], 1)).toBeNull();
    expect(dailyNoteInterval(path, ['# Day planner','```md',row,'```'],2)).toBeNull();
    expect(dailyNoteInterval(path, ['# Day planner','# Notes',row],2)).toBeNull();
    expect(dailyNoteInterval(path, ['```md','# Day planner','```',row],3)).toBeNull();
    expect(dailyNoteInterval(path, ['# Day planner','## Afternoon',row],2)).not.toBeNull();
  });
});
