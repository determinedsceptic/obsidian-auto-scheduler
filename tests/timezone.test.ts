import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';
function check(key: string, tz: string): string {
  return execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `import {assertStableWeek,addDays} from './src/time.ts'; try { assertStableWeek('${key}'); console.log(addDays('${key}',7)); } catch(e) { console.log(e.message); }`], { encoding: 'utf8', env: { ...process.env, TZ: tz } }).trim();
}
it('春季与秋季夏令时跳变周拒绝排程', () => {
  expect(check('2026-03-03', 'America/New_York')).toContain('跳变');
  expect(check('2026-10-27', 'America/New_York')).toContain('跳变');
});
it('上海及非跳变纽约周可使用本地日期', () => {
  expect(check('2026-10-01', 'Asia/Shanghai')).toBe('2026-10-08');
  expect(check('2026-10-01', 'America/New_York')).toBe('2026-10-08');
});
