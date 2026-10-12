import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { webviewBuilds } from '../app/webview-builds.mjs';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

// Built-in skills ship inside the extension (dist/skills), read at runtime.
rmSync('dist/skills', { recursive: true, force: true });
mkdirSync('dist/skills', { recursive: true });
cpSync('../core/skills', 'dist/skills', { recursive: true });

/** @type {esbuild.BuildOptions[]} */
const builds = [
  {
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['vscode'],
    sourcemap: !production,
    minify: production,
  },
  // The chat UI is shared with the desktop app (packages/app).
  ...webviewBuilds('dist', { production }),
];

if (watch) {
  for (const options of builds) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
  }
  console.log('[esbuild] watching...');
} else {
  await Promise.all(builds.map((options) => esbuild.build(options)));
  console.log('[esbuild] build complete');
}
