import { blockLine, parseOutput, START, END } from '../src/output';
import { block } from './helpers';
import { expect, it } from 'vitest';
import { parseHabits, HABIT_TEMPLATE } from '../src/habits';
it('parses English recurrence names without changing Chinese compatibility', () => {
  const source = { path: 'Habits/Routine.md', content: '- 19:00-19:30 Evening walk (MON, Wednesday, fri)\n- 07:00-07:15 Morning routine (weekdays)\n- 20:00-20:30 Rest (weekends)\n- 22:00-22:15 阅读（每天）' };
  const result = parseHabits([source]);
  expect(result.errors).toEqual([]);
  expect(result.habits.map(h => h.days)).toEqual([[1,3,5],[1,2,3,4,5],[0,6],[0,1,2,3,4,5,6]]);
  expect(result.habits.map(h => h.title)).toEqual(['Evening walk','Morning routine','Rest','阅读']);
});
it('does not activate the English template examples', () => {
  expect(parseHabits([{path:'Habits/Routine.md',content:HABIT_TEMPLATE}])).toEqual({ habits: [], errors: [] });
});

it('uses only Dataview priority syntax for Gantt blocks', () => {
  const line = blockLine(block({priority:4, title:'Prepare report ⏫ 📅 2026-10-03'}), 'gantt');
  expect(line).toContain('[priority:: high]');
  expect(line).not.toMatch(/[🔺⏫🔼🔽⏬📅]/u);
  expect(parseOutput(`${START}\n${line}\n${END}`).blocks[0].priority).toBe(4);
});
