import * as esbuild from 'esbuild';
import { chmodSync, copyFileSync, cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { webviewBuilds } from '../app/webview-builds.mjs';

const production = process.argv.includes('--production');
const { version } = JSON.parse(readFileSync('package.json', 'utf8'));

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist/skills', { recursive: true });
// Built-in skills and the window's theme ship next to the app.
cpSync('../core/skills', 'dist/skills', { recursive: true });
copyFileSync('theme.css', 'dist/theme.css');
copyFileSync('../vscode-extension/media/orka-128.png', 'dist/icon.png');

await Promise.all([
  esbuild.build({
    entryPoints: ['src/main.ts'],
    outfile: 'dist/orka-desktop.js',
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    banner: { js: '#!/usr/bin/env node' },
    define: {
      ORKA_VERSION: JSON.stringify(version),
      // ws (in the Gemini SDK) tries its optional native add-ons, which are never installed; the
      // single executable (scripts/build-exe.mjs) warns about every require() it cannot serve.
      'process.env.WS_NO_BUFFER_UTIL': '"1"',
      'process.env.WS_NO_UTF_8_VALIDATE': '"1"',
    },
    sourcemap: !production,
    minify: production,
  }),
  // The chat UI is the same one the VS Code extension shows (packages/app).
  ...webviewBuilds('dist', { production }).map((options) => esbuild.build(options)),
]);
chmodSync('dist/orka-desktop.js', 0o755);
console.log('[esbuild] dist/orka-desktop.js');
