import * as esbuild from 'esbuild';
import { chmodSync, cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs';

const production = process.argv.includes('--production');
const { version } = JSON.parse(readFileSync('package.json', 'utf8'));

// Built-in skills ship next to the bundle (dist/skills), read at runtime.
rmSync('dist', { recursive: true, force: true });
mkdirSync('dist/skills', { recursive: true });
cpSync('../core/skills', 'dist/skills', { recursive: true });

// One file with everything in it (@orka/core and the provider SDKs): the published package needs
// no runtime dependencies.
await esbuild.build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/orka.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  banner: { js: '#!/usr/bin/env node' },
  define: { ORKA_VERSION: JSON.stringify(version) },
  sourcemap: !production,
  minify: production,
});
chmodSync('dist/orka.js', 0o755);
console.log('[esbuild] dist/orka.js');
