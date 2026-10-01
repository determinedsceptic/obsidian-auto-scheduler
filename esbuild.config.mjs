import { build, context } from 'esbuild';
const options = {
  entryPoints: ['src/main.ts'], bundle: true, external: ['obsidian'],
  format: 'cjs', target: 'es2020', platform: 'browser', outfile: 'main.js',
  sourcemap: false, logLevel: 'info',
};
if (process.argv.includes('--watch')) await (await context(options)).watch();
else await build(options);
