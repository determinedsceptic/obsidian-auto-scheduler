import { mkdir, copyFile } from 'node:fs/promises';
const directory = 'dist/auto-scheduler';
await mkdir(directory, { recursive: true });
for (const file of ['main.js', 'manifest.json', 'styles.css', 'README.md', 'LICENSE']) await copyFile(file, `${directory}/${file}`);
console.log(`Local plugin files: ${directory}`);
