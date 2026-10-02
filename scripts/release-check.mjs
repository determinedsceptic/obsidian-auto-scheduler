import { readFile, readdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const manifest = await json('manifest.json'), pkg = await json('package.json'), lock = await json('package-lock.json'), versions = await json('versions.json');
assert(/^[a-z0-9-]+$/.test(manifest.id) && !manifest.id.includes('obsidian'));
assert(/^\d+\.\d+\.\d+$/.test(manifest.version));
assert.equal(manifest.version, pkg.version); assert.equal(manifest.version, lock.version); assert.equal(manifest.version, lock.packages[''].version);
assert.equal(versions[manifest.version], manifest.minAppVersion); assert.equal(pkg.license, 'MIT');
assert.equal(manifest.isDesktopOnly, true);
assert(manifest.description.length <= 250 && manifest.description.endsWith('.') && !/[\u4e00-\u9fff]/.test(manifest.description));
assert((await readFile('LICENSE','utf8')).startsWith('MIT License'));
const source = await readFile('main.js','utf8');
assert(source.includes('create_habits') && source.includes('create_tasks'));
assert(source.includes('Reply in the user') && source.includes('use English by default'));
assert(!/require\(["'](?:node:|fs["']|electron["'])/.test(source));
assert(!source.includes('/Users/') && !source.includes('/home/'));
const readme = await readFile('README.md','utf8');
for (const link of readme.matchAll(/\]\(([^)]+)\)/g)) if (!/^(?:https?:|#)/.test(link[1])) {
  await readFile(link[1].split('#')[0]);
}
const checksums = {};
for (const file of ['main.js','manifest.json','styles.css']) checksums[file] = createHash('sha256').update(await readFile(file)).digest('hex');
for (const file of await readdir('src')) if (file.endsWith('.ts') && !['habits.ts','output.ts','tracking.ts'].includes(file)) {
  assert(!/[\u4e00-\u9fff]/.test(await readFile('src/'+file,'utf8')), `Non-English runtime text: ${file}`);
}
console.log(JSON.stringify({ version: manifest.version, id: manifest.id, checksums, status: 'release checks passed' },null,2));
