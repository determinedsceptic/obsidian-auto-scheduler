// Exercises the pinned upstream parser and serializer; no upstream code is vendored.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
process.env.TZ = 'Asia/Shanghai';
const root = path.resolve(process.argv[2] ?? '../obsidian-gantt-calendar');
const commit = 'a06130967bd862a642416e10970ca4bf4cfc7e11';
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), commit);
assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(), '');
async function library(exports) {
  const result = await build({ stdin: { contents: exports, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, platform: 'node', format: 'cjs', external: ['obsidian'], logLevel: 'silent' });
  const module = { exports: {} };
  vm.runInNewContext(result.outputFiles[0].text, { module, exports: module.exports, Date, console,
    require: name => { assert.equal(name, 'obsidian'); return { getLanguage: () => 'en' }; } });
  return module.exports;
}
const upstream = await library(`export { parseSingleTaskLine } from ${JSON.stringify(path.join(root, 'src/tasks/taskParser/main.ts'))}; export { serializeTask } from ${JSON.stringify(path.join(root, 'src/tasks/taskSerializer.ts'))};`);
const ours = await library('export { blockLine, parseOutput, START, END } from "./src/output.ts"; export { parseTasks } from "./src/parser.ts";');
const start = new Date('2026-10-01T09:00:00+08:00').getTime() / 60000;
const block = { id: 'b_test', taskId: 'test', title: '阅读 ⏫ 📅 2026-10-03 %%[guid:: source-only]%%', path: 'Tasks/Test.md', date: '2026-10-01', start, end: start + 60, locked: true, completed: false };
const line = ours.blockLine(block, 'gantt', '🎯');
const parsed = upstream.parseSingleTaskLine(line, 'DailyNotes/2026-10-01.md', '2026-10-01', 1, ['tasks', 'dataview'], '🎯 ');
assert(parsed, 'Default upstream filter did not recognize the block');
assert.equal(parsed.format, 'dataview');
assert.equal(parsed.startDate.getTime() / 60000, block.start);
assert.equal(parsed.scheduledDate.getTime() / 60000, block.start);
assert.equal(parsed.dueDate.getTime() / 60000, block.end);
assert.equal(parsed.datePrecision.dueDate, 'time');
assert(!parsed.metadataFields.some(field => field.key === 'guid'), 'Source synchronization GUID leaked into block');
const host = { plugins: { getPlugin: () => ({ settings: { globalTaskFilter: '🎯 ' } }) } };
// Upstream serializer returns checkbox content; its writer preserves/adds the list marker.
const serialized = '- ' + upstream.serializeTask(host, parsed, {}, 'dataview');
const roundtrip = ours.parseOutput(`${ours.START}\n${serialized}\n${ours.END}`).blocks[0];
assert.equal(roundtrip.id, block.id); assert.equal(roundtrip.locked, true); assert.equal(roundtrip.end, block.end);
const source = '- [ ] 🎯 源任务 %%[as:: id=source remaining=60]%% [priority:: high] [due:: 2026-10-02 11:00]';
const sourceTask = upstream.parseSingleTaskLine(source, 'Tasks/Test.md', 'Test', 1, ['tasks', 'dataview'], '🎯');
const sourceSerialized = '- ' + upstream.serializeTask(host, sourceTask, {}, 'dataview');
const sourceRoundtrip = ours.parseTasks([{ path: 'Tasks/Test.md', content: sourceSerialized }]);
assert.equal(sourceRoundtrip.errors.length, 0); assert.equal(sourceRoundtrip.tasks[0].priority, 4);
console.log(JSON.stringify({ commit, line, serialized, checks: ['default global filter', 'Dataview detection', 'minute precision', 'start/scheduled/due times', 'metadata and locked roundtrip', 'source metadata roundtrip', 'no source GUID duplication'], status: 'passed', scope: 'real upstream parser/serializer, simulated Obsidian host; UI rendering unverified' }, null, 2));
