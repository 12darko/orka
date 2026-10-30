// The app imports the core's TypeScript sources: each test is bundled with esbuild first, then
// node --test runs the bundles.
import * as esbuild from 'esbuild';
import { spawnSync } from 'node:child_process';
import { readdirSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, '..', 'dist', 'test');
rmSync(out, { recursive: true, force: true });
const tests = readdirSync(here).filter((f) => f.endsWith('.test.ts'));
await esbuild.build({
  entryPoints: tests.map((f) => path.join(here, f)),
  outdir: out,
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: 'inline',
  loader: { '.svg': 'text' },
  logLevel: 'warning',
});
const run = spawnSync(process.execPath, ['--test', ...tests.map((f) => path.join(out, f.replace(/\.ts$/, '.cjs')))], { stdio: 'inherit' });
process.exit(run.status ?? 1);
