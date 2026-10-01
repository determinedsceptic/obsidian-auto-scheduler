import { spawnSync } from 'node:child_process';
const commands = { test: ['node_modules/vitest/vitest.mjs', 'run'], demo: ['--import', 'tsx', 'scripts/demo.ts'] };
const args = commands[process.argv[2]];
if (!args) throw new Error('Expected test or demo');
const result = spawnSync(process.execPath, [...args, ...process.argv.slice(3)], { stdio: 'inherit', env: { ...process.env, TZ: 'Asia/Shanghai' } });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
