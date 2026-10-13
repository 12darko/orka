import * as esbuild from 'esbuild';
import { chmodSync, cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { writeThirdPartyNotices } from '../../scripts/third-party-notices.mjs';

const production = process.argv.includes('--production');
const { version } = JSON.parse(readFileSync('package.json', 'utf8'));

// Built-in skills ship next to the bundle (dist/skills), read at runtime.
rmSync('dist', { recursive: true, force: true });
mkdirSync('dist/skills', { recursive: true });
cpSync('../core/skills', 'dist/skills', { recursive: true });

// One file with everything in it (@orka/core and the provider SDKs): the published package needs
// no runtime dependencies. Their licenses go in dist/THIRD_PARTY_NOTICES.txt.
const result = await esbuild.build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/orka.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  banner: { js: '#!/usr/bin/env node' },
  define: { ORKA_VERSION: JSON.stringify(version) },
  sourcemap: !production,
  minify: production,
  metafile: true,
});
chmodSync('dist/orka.js', 0o755);
writeThirdPartyNotices('dist/THIRD_PARTY_NOTICES.txt', 'the Orka CLI', [result.metafile]);
console.log('[esbuild] dist/orka.js');
