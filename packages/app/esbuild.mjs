// Builds the chat UI into dist/ for the browser preview (npm run preview). The VS Code extension
// and the desktop app bundle the same sources into their own dist folders.
import * as esbuild from 'esbuild';
import { webviewBuilds } from './webview-builds.mjs';

await Promise.all(webviewBuilds('dist', { production: process.argv.includes('--production') }).map((options) => esbuild.build(options)));
console.log('[esbuild] webview built');
