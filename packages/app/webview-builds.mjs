// esbuild options for the chat UI, shared by every package that ships it.
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** @returns {import('esbuild').BuildOptions[]} */
export function webviewBuilds(outdir, { production = false } = {}) {
  return [
    {
      entryPoints: [path.join(here, 'webview/main.ts')],
      // The logo is inlined into the bundle (the UI's CSP allows data: images only).
      loader: { '.svg': 'text' },
      outfile: path.join(outdir, 'webview.js'),
      bundle: true,
      platform: 'browser',
      format: 'iife',
      target: 'es2022',
      sourcemap: !production,
      minify: production,
    },
    {
      entryPoints: [path.join(here, 'webview/styles.css')],
      outfile: path.join(outdir, 'webview.css'),
      bundle: true,
      minify: production,
    },
  ];
}
