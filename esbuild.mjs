import * as esbuild from 'esbuild';
const options = { entryPoints: ['src/extension.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node20', outfile: 'dist/extension.js', external: ['vscode'], sourcemap: true, minify: false };
if (process.argv.includes('--watch')) { const context = await esbuild.context(options); await context.watch(); }
else await esbuild.build(options);
