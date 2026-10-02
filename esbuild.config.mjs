import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { build, context } from 'esbuild';
const options = {
  entryPoints: ['src/main.ts'], bundle: true, external: ['obsidian'],
  format: 'cjs', target: 'es2020', platform: 'browser', outfile: 'main.js',
  plugins: [{ name: 'bundled-skill', setup(build) {
    build.onResolve({ filter: /\.md\?raw$/ }, args => ({ path: resolve(args.resolveDir, args.path.slice(0, -4)), namespace: 'skill' }));
    build.onLoad({ filter: /./, namespace: 'skill' }, async args => ({ contents: await readFile(args.path, 'utf8'), loader: 'text', resolveDir: dirname(args.path) }));
  } }],
  sourcemap: false, logLevel: 'info',
};
if (process.argv.includes('--watch')) await (await context(options)).watch();
else await build(options);
