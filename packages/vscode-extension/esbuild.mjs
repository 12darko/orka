import * as esbuild from 'esbuild';
import { copyFileSync, cpSync, mkdirSync, rmSync } from 'node:fs';
import { writeThirdPartyNotices } from '../../scripts/third-party-notices.mjs';
import { webviewBuilds } from '../app/webview-builds.mjs';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

// Built-in skills ship inside the extension (dist/skills), read at runtime.
rmSync('dist/skills', { recursive: true, force: true });
mkdirSync('dist/skills', { recursive: true });
cpSync('../core/skills', 'dist/skills', { recursive: true });
// The extension's Changelog tab reads CHANGELOG.md next to package.json (a copy, not in git).
copyFileSync('../../CHANGELOG.md', 'CHANGELOG.md');

/** @type {esbuild.BuildOptions[]} */
const builds = [
  {
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    bundle: true,
    platform: 'node',
    format: 'cjs',
    // VS Code 1.101 (engines.vscode) runs extensions on Node 22.
    target: 'node22',
    external: ['vscode'],
    sourcemap: !production,
    minify: production,
    metafile: true,
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
  const results = await Promise.all(builds.map((options) => esbuild.build(options)));
  writeThirdPartyNotices(
    'dist/THIRD_PARTY_NOTICES.txt',
    'the Orka extension for VS Code',
    results.map((result) => result.metafile),
  );
  console.log('[esbuild] build complete');
}
