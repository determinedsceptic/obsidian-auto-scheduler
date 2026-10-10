import { readFile } from 'node:fs/promises';
import { resolve, dirname, relative } from 'node:path';
import { build, context } from 'esbuild';
const options = {
  entryPoints: ['src/main.ts'], bundle: true, external: ['obsidian'],
  format: 'cjs', target: 'es2020', platform: 'browser', outfile: 'main.js',
  // Keep the bundled parser's license with the single-file Obsidian distribution.
  banner: { js: `/*\nBundled Marked license:\n${await readFile('node_modules/marked/LICENSE', 'utf8')}\n*/` },
  plugins: [{ name: 'bundled-skill', setup(build) {
    build.onResolve({ filter: /\.md\?raw$/ }, args => { const fullPath = resolve(args.resolveDir, args.path.slice(0, -4)); return { path: relative(process.cwd(), fullPath).replaceAll('\\', '/'), namespace: 'skill', pluginData: { fullPath } }; });
    build.onLoad({ filter: /./, namespace: 'skill' }, async args => ({ contents: await readFile(args.pluginData.fullPath, 'utf8'), loader: 'text', resolveDir: dirname(args.pluginData.fullPath) }));
  } }],
  sourcemap: false, logLevel: 'info',
};
if (process.argv.includes('--watch')) await (await context(options)).watch();
else await build(options);
