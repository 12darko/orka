import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { ChangeTracker } from '../src/changes/ChangeTracker';
import { ContextBuilder } from '../src/context/ContextBuilder';
import { NodeHost } from '../src/host/NodeHost';
import { gitConfigRisk, gitStatusTool } from '../src/tools/GitTools';
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
});
