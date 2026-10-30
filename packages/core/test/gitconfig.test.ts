import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { ChangeTracker } from '../src/changes/ChangeTracker';
import { ContextBuilder } from '../src/context/ContextBuilder';
import { NodeHost } from '../src/host/NodeHost';
import { gitConfigRisk, gitDiffTool, gitLogTool, gitStatusTool, parseGitConfig } from '../src/tools/GitTools';
import { runCommandTool } from '../src/tools/TerminalTools';
import type { ToolContext } from '../src/tools/Tool';
import { tempWorkspace } from './helpers';

describe("A repository's own git config", () => {
  let ws: ReturnType<typeof tempWorkspace>;
  let host: NodeHost;
  const ctx = (): ToolContext => ({
    callId: 'c',
    host,
    changes: new ChangeTracker(host),
    signal: new AbortController().signal,
    commandTimeoutMs: 30_000,
    plan: undefined,
    setPlan: () => {},
    onOutput: () => {},
  });

  beforeEach(() => {
    ws = tempWorkspace();
    execFileSync('git', ['init', '-q'], { cwd: ws.root });
    writeFileSync(path.join(ws.root, 'a.txt'), 'hello\n');
    host = new NodeHost({ workspaceRoot: ws.root });
  });
  afterEach(() => ws.cleanup());

  const config = (extra: string) => writeFileSync(path.join(ws.root, '.git', 'config'), `[core]\n\trepositoryformatversion = 0\n${extra}`);
  const git = (args: string[], input?: string) => execFileSync('git', args, { cwd: ws.root, input, encoding: 'utf8' }).trim();
  /** A path as a shell script or git config value can hold it. */
  const slash = (p: string) => p.split(path.sep).join('/');

  it('is fine as git creates it, and with Git LFS or the built-in fsmonitor', async () => {
    assert.deepEqual(await gitConfigRisk(ws.root), []);
    config('\tfsmonitor = true\n[filter "lfs"]\n\tclean = git-lfs clean -- %f\n\tsmudge = git-lfs smudge -- %f\n\tprocess = git-lfs filter-process\n');
    assert.deepEqual(await gitConfigRisk(ws.root), []);
    assert.equal((await gitStatusTool.describe({}, ctx())).risk, 'safe');
  });

  it('marks programs it would run, and then Orka neither runs git status on its own nor lets git commands run without asking', async () => {
    const marker = path.join(ws.root, 'pwned.txt');
    const program = `node -e "require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')"`;
    config(`\tfsmonitor = ${program}\n[filter "x"]\n\tclean = ${program}\n[diff "y"]\n\ttextconv = ${program}\n`);
    writeFileSync(path.join(ws.root, '.gitattributes'), '*.txt filter=x diff=y\n');
    assert.deepEqual((await gitConfigRisk(ws.root)).sort(), ['core.fsmonitor', 'diff.y.textconv', 'filter.x.clean']);

    // Also from a sub-folder: git finds the repository above it.
    mkdirSync(path.join(ws.root, 'sub'));
    assert.equal((await gitConfigRisk(path.join(ws.root, 'sub'))).length, 3);

    const status = await gitStatusTool.describe({}, ctx());
    assert.deepEqual([status.category, status.risk], ['command', 'dangerous']);
    assert.match(status.detail ?? '', /filter\.x\.clean/);
    const command = await runCommandTool.describe({ command: 'git status' }, ctx());
    assert.equal(command.risk, 'dangerous');

    const context = new ContextBuilder(host);
    await context.buildSystemPrompt();
    const turn = await context.buildTurnContext(undefined, 'balanced', []);
    assert.match(turn, /git status: not run automatically/);
    assert.ok(!existsSync(marker), 'nothing from the repository config ran');
  });

  it('is read the way git reads it: a key on the section header line counts', async () => {
    writeFileSync(path.join(ws.root, '.git', 'config'), '[core] repositoryformatversion = 0\n[core] fsmonitor = ./tools/probe.sh\n');
    assert.deepEqual(await gitConfigRisk(ws.root), ['core.fsmonitor']);
    // Also for git spelled so that only the shell sees it.
    for (const command of ['git status', `g''it status`, 'gi$1t status']) assert.equal((await runCommandTool.describe({ command }, ctx())).risk, 'dangerous', command);
    // Git LFS's own filters are fine, a command that only starts like one is not.
    config('[filter "lfs"]\n\tclean = git-lfs clean -- %f && node evil.js\n');
    assert.deepEqual(await gitConfigRisk(ws.root), ['filter.lfs.clean']);
  });

  it("marks gpg programs, which git log and show run to check signatures; Orka's own git log never does", async () => {
    config('[gpg "ssh"]\n\tprogram = ./tools/sign.sh\n');
    assert.deepEqual(await gitConfigRisk(ws.root), ['gpg.ssh.program']);
    assert.equal((await runCommandTool.describe({ command: 'git log --show-signature -1' }, ctx())).risk, 'dangerous');
    // A signed commit with log.showSignature on: git log runs the repository's gpg program.
    const marker = path.join(ws.root, 'gpg-ran.txt');
    const program = path.join(ws.root, 'gpg.sh');
    writeFileSync(program, `#!/bin/sh\necho x > "${slash(marker)}"\n`, { mode: 0o755 });
    config(`[gpg]\n\tprogram = ${slash(program)}\n[log]\n\tshowSignature\n`);
    const tree = git(['hash-object', '-t', 'tree', '-w', '--stdin'], '');
    const signature = 'gpgsig -----BEGIN PGP SIGNATURE-----\n \n iQ==\n -----END PGP SIGNATURE-----';
    const commit = git(['hash-object', '-t', 'commit', '-w', '--stdin'], `tree ${tree}\nauthor t <t@t> 1700000000 +0000\ncommitter t <t@t> 1700000000 +0000\n${signature}\n\nsigned\n`);
    git(['update-ref', 'HEAD', commit]);
    assert.deepEqual((await gitConfigRisk(ws.root)).sort(), ['gpg.program', 'log.showsignature']);
    assert.equal((await gitLogTool.describe({}, ctx())).risk, 'safe');
    assert.match((await gitLogTool.execute({}, ctx())).content, /: signed$/);
    assert.ok(!existsSync(marker), "Orka's own git log did not run it");
    git(['log', '-1']);
    assert.ok(existsSync(marker), 'plain git log does');
  });

  it("marks core.hooksPath, also for Orka's own git status: a post-index-change hook there runs when status writes the index", async () => {
    const marker = path.join(ws.root, 'pwned.txt');
    git(['add', 'a.txt']);
    mkdirSync(path.join(ws.root, 'tools', 'hooks'), { recursive: true });
    writeFileSync(path.join(ws.root, 'tools', 'hooks', 'post-index-change'), `#!/bin/sh\necho x > "${slash(marker)}"\n`, { mode: 0o755 });
    config('\thooksPath = tools/hooks\n');
    const later = new Date(Date.now() + 60_000);
    utimesSync(path.join(ws.root, 'a.txt'), later, later);
    assert.deepEqual(await gitConfigRisk(ws.root), ['core.hookspath']);
    assert.equal((await gitStatusTool.describe({}, ctx())).risk, 'dangerous');
    const context = new ContextBuilder(host);
    await context.buildSystemPrompt();
    assert.match(await context.buildTurnContext(undefined, 'balanced', []), /git status: not run automatically/);
    assert.ok(!existsSync(marker), 'the hook did not run');
    git(['-c', 'core.fsmonitor=false', 'status']);
    assert.ok(existsSync(marker), 'git status as Orka runs it would have');
  });

  it("Orka's own git diff runs no diff driver of a submodule (diff.submodule=diff starts a git of its own there)", async () => {
    const sub = path.join(ws.root, 'sub');
    git(['init', '-q', sub]);
    writeFileSync(path.join(sub, 'a.txt'), 'one\n');
    const inSub = (args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: sub, encoding: 'utf8' }).trim();
    inSub(['add', 'a.txt']);
    inSub(['commit', '-q', '-m', 'one']);
    // A gitlink in the index: a submodule as git diff sees it.
    git(['update-index', '--add', '--cacheinfo', `160000,${inSub(['rev-parse', 'HEAD'])},sub`]);
    const marker = path.join(ws.root, 'textconv-ran.txt');
    const program = path.join(ws.root, 'textconv.sh');
    writeFileSync(program, `#!/bin/sh\necho x > "${slash(marker)}"\ncat "$1"\n`, { mode: 0o755 });
    writeFileSync(path.join(sub, '.git', 'config'), `[core]\n\trepositoryformatversion = 0\n[diff "x"]\n\ttextconv = ${slash(program)}\n`);
    writeFileSync(path.join(sub, '.gitattributes'), '*.txt diff=x\n');
    writeFileSync(path.join(sub, 'a.txt'), 'two\n');
    config('[diff]\n\tsubmodule = diff\n');
    assert.deepEqual(await gitConfigRisk(ws.root), ['diff.x.textconv (in sub)']);
    assert.equal((await gitDiffTool.describe({}, ctx())).risk, 'safe');
    await gitDiffTool.execute({}, ctx());
    assert.ok(!existsSync(marker), "Orka's own git diff did not run it");
    git(['-c', 'core.fsmonitor=false', 'diff', '--no-ext-diff', '--no-textconv']);
    assert.ok(existsSync(marker), 'git diff with only the flags that harden the top repository does');
  });

  it('reads config by hand like git when git is missing', () => {
    const text = [
      '\uFEFForphan = 1',
      '[core] fsmonitor = ./a.sh ; a comment',
      '[diff "Y"]',
      '\ttextconv = "./b.sh" \\',
      '  --flag # comment',
      '[Filter.X]clean=x',
      '[a "b\\"c"]',
      '\tkey',
      '\tquoted = "x # y" tail  ',
    ].join('\r\n');
    assert.deepEqual(parseGitConfig(text), [
      ['core.fsmonitor', './a.sh'],
      ['diff.Y.textconv', './b.sh   --flag'],
      ['filter.x.clean', 'x'],
      ['a.b"c.key', undefined],
      ['a.b"c.quoted', 'x # y tail'],
    ]);
  });

  it('marks a post-index-change hook: git status writes the index and runs it', async () => {
    const marker = path.join(ws.root, 'pwned.txt');
    execFileSync('git', ['add', 'a.txt'], { cwd: ws.root });
    writeFileSync(path.join(ws.root, '.git', 'hooks', 'post-index-change'), `#!/bin/sh\necho x > "${marker.split(path.sep).join('/')}"\n`, { mode: 0o755 });
    // Stat data that no longer matches the index (as in an unpacked archive): status refreshes and writes it.
    const later = new Date(Date.now() + 60_000);
    utimesSync(path.join(ws.root, 'a.txt'), later, later);
    assert.deepEqual(await gitConfigRisk(ws.root), ['hooks/post-index-change']);
    assert.equal((await gitStatusTool.describe({}, ctx())).risk, 'dangerous');
    const context = new ContextBuilder(host);
    await context.buildSystemPrompt();
    assert.match(await context.buildTurnContext(undefined, 'balanced', []), /git status: not run automatically/);
    assert.ok(!existsSync(marker), 'the hook did not run');
  });

  it('a command checks the repository it runs in: a nested one, and submodules git status looks into', async () => {
    const nested = path.join(ws.root, 'vendor', 'lib');
    mkdirSync(nested, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: nested });
    writeFileSync(path.join(nested, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n\tfsmonitor = ./hook.sh\n');
    assert.deepEqual(await gitConfigRisk(ws.root), [], 'not a submodule: git status in the root does not look into it');
    assert.deepEqual(await gitConfigRisk(nested), ['core.fsmonitor']);
    assert.equal((await runCommandTool.describe({ command: 'git status', cwd: 'vendor/lib' }, ctx())).risk, 'dangerous');
    assert.equal((await runCommandTool.describe({ command: 'git status' }, ctx())).risk, 'safe');
    assert.equal((await runCommandTool.describe({ command: 'cd vendor/lib && git status' }, ctx())).risk, 'normal');

    // A submodule (a gitlink in the index; no .gitmodules needed): git status runs `git status` in it.
    execFileSync('git', ['-c', 'core.fsmonitor=false', '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x'], { cwd: nested });
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: nested, encoding: 'utf8' }).trim();
    execFileSync('git', ['update-index', '--add', '--cacheinfo', `160000,${head},vendor/lib`], { cwd: ws.root });
    assert.deepEqual(await gitConfigRisk(ws.root), ['core.fsmonitor (in vendor/lib)']);
    for (const args of [['--index-version', '4'], ['--split-index']]) {
      execFileSync('git', ['update-index', ...args], { cwd: ws.root });
      assert.deepEqual(await gitConfigRisk(ws.root), ['core.fsmonitor (in vendor/lib)'], args.join(' '));
    }
  });

  it('a .git folder git would not accept does not hide the repository above it', async () => {
    config('\tfsmonitor = ./hook.sh\n');
    const sub = path.join(ws.root, 'sub');
    mkdirSync(path.join(sub, '.git'), { recursive: true });
    writeFileSync(path.join(sub, '.git', 'HEAD'), 'not a ref\n');
    assert.deepEqual(await gitConfigRisk(sub), ['core.fsmonitor']);
  });
});
