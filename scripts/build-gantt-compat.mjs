// Explicit opt-in build for the pinned Gantt Calendar source checkout.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [source, vault] = process.argv.slice(2);
if (!source) throw new Error('Usage: node scripts/build-gantt-compat.mjs <Gantt source checkout> [vault to update]');
const cwd = resolve(source), pin = 'a06130967bd862a642416e10970ca4bf4cfc7e11';
const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
if (git('rev-parse', 'HEAD').trim() !== pin) throw new Error('Unsupported Gantt source revision; use the pinned checkout documented in integrations/gantt-calendar/README.md');
const patch = resolve(root, 'integrations/gantt-calendar/clean-daily.patch');
try { git('apply', '--reverse', '--check', patch); }
catch {
  if (git('status', '--porcelain').trim()) throw new Error('Use a clean source checkout; existing work will not be overwritten.');
  git('apply', '--check', patch); git('apply', patch);
}
const module = readFileSync(resolve(root, 'integrations/gantt-calendar/daily-note-interval.ts'));
const destination = resolve(cwd, 'src/tasks/daily-note-interval.ts');
if (existsSync(destination) && !readFileSync(destination).equals(module)) throw new Error('Existing interval adapter differs; review it before rebuilding.');
writeFileSync(destination, module);
execFileSync('npm', ['run', 'build'], { cwd, stdio: 'inherit' });
execFileSync('npm', ['test', '--', '--runInBand'], { cwd, stdio: 'inherit' });
if (vault) {
  const plugin = resolve(vault, '.obsidian/plugins/gantt-calendar');
  const manifest = JSON.parse(readFileSync(resolve(plugin, 'manifest.json'), 'utf8'));
  if (manifest.id !== 'gantt-calendar' || manifest.version !== '1.6.2') throw new Error('Only the installed Gantt Calendar 1.6.2 is supported by this patch.');
  const backup = resolve(root, 'local-test-vaults/install-backups', `${new Date().toISOString().replace(/[:.]/g, '-')}-gantt-compat`);
  mkdirSync(backup, { recursive: true });
  copyFileSync(resolve(plugin, 'main.js'), resolve(backup, 'main.js'));
  copyFileSync(resolve(cwd, 'main.js'), resolve(plugin, 'main.js'));
  console.log('Updated existing Gantt Calendar bundle. Save open notes and reload Obsidian. Backup:', backup);
}
