import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parseTasks, parseFixed } from '../src/parser';
import { parseOutput, renderOutput } from '../src/output';
import { schedule } from '../src/scheduler';
import { DEFAULT_SETTINGS } from '../src/types';
import { overlap, workWindows } from '../src/time';
import type { Task } from '../src/types';

const now = new Date('2026-10-01T08:00:00+08:00');
const source = await readFile('demo-vault/Tasks/Project.md', 'utf8');
const fixedText = await readFile('demo-vault/Scheduler/Fixed.md', 'utf8');
const parsed = parseTasks([{ path: 'Tasks/Project.md', content: source }]);
const fixed = parseFixed({ path: 'Scheduler/Fixed.md', content: fixedText });
assert.equal(parsed.errors.length + fixed.errors.length, 0);
// Small sample before the complete week.
const small = schedule(parsed.tasks.slice(0, 3), fixed.intervals, [], DEFAULT_SETTINGS, now, 1);
assert.equal(small.errors.length, 0);
const result = schedule(parsed.tasks, fixed.intervals, [], DEFAULT_SETTINGS, now);
assert.equal(result.errors.length, 0);
for (const task of parsed.tasks.filter(t => !t.completed)) {
  assert.equal(result.blocks.filter(b => b.taskId === task.id).reduce((sum, b) => sum + b.end - b.start, 0) + (result.unscheduled.find(u => u.taskId === task.id)?.remaining ?? 0), task.remaining);
}
for (const block of result.blocks) {
  assert(workWindows(block.date, DEFAULT_SETTINGS).some(w => w.start <= block.start && block.end + DEFAULT_SETTINGS.blockBuffer <= w.end));
  assert(fixed.intervals.every(f => !overlap(block, { start: f.start - DEFAULT_SETTINGS.fixedBuffer, end: f.end + DEFAULT_SETTINGS.fixedBuffer })));
}
assert(result.days.every(d => d.occupied <= d.capacity));
const large: Task[] = Array.from({ length: 1000 }, (_, i) => ({ ...parsed.tasks[0], id: `perf_${i}`, remaining: 60, priority: 1 + i % 5 }));
const start = performance.now();
const benchmark = schedule(large, fixed.intervals, [], DEFAULT_SETTINGS, now);
const elapsed = performance.now() - start;
assert.equal(benchmark.errors.length, 0);
assert(elapsed < 5000, `1000 tasks exceeded 5s: ${elapsed}`);
const codeDirty = !!execFileSync('git', ['status', '--porcelain', '--', 'src', 'tests', 'scripts', 'package.json', 'package-lock.json', 'tsconfig.json', 'esbuild.config.mjs', 'manifest.json', 'styles.css'], { encoding: 'utf8' }).trim();
const directory = 'local-test-vaults/demo-validation'; await mkdir(directory, { recursive: true });
for (const mode of ['plain', 'day-planner'] as const) {
  const output = renderOutput(parseOutput(null), result.blocks, mode);
  assert.equal(parseOutput(output).blocks.length, result.blocks.length);
  await writeFile(`${directory}/demo-${mode}.md`, output);
}
const record = {
  author: 'Codex', date: '2026-10-01', codeCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  codeDirty, fixtureChecksums: { tasks: createHash('sha256').update(source).digest('hex'), fixed: createHash('sha256').update(fixedText).digest('hex') },
  node: process.version, timezone: process.env.TZ, now: now.toISOString(), seed: null,
  inputs: ['demo-vault/Tasks/Project.md', 'demo-vault/Scheduler/Fixed.md'], dataVersion: 'Git fixtures', environment: 'package-lock.json',
  command: 'npm run demo', configuration: DEFAULT_SETTINGS, smallSample: { blocks: small.blocks.length, unscheduled: small.unscheduled },
  week: { blocks: result.blocks.length, unscheduled: result.unscheduled, days: result.days },
  performance: { tasks: large.length, milliseconds: Number(elapsed.toFixed(2)), blocks: benchmark.blocks.length },
  output: ['local-test-vaults/demo-validation/demo-plain.md', 'local-test-vaults/demo-validation/demo-day-planner.md'],
};
await writeFile(`${directory}/demo-result.json`, JSON.stringify(record, null, 2) + '\n');
console.log(JSON.stringify({ smallBlocks: small.blocks.length, weekBlocks: result.blocks.length, unscheduled: result.unscheduled, benchmarkMs: record.performance.milliseconds }, null, 2));
