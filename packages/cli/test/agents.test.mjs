// Agent mode in the CLI: an agent CLI over ACP as the main agent. The core's fake ACP agent
// (packages/core/test/fixtures/fake-acp.mjs) is added as a custom agent in a temporary ORKA_HOME;
// the built dist/orka.js runs in a child process, with no terminal (piped input).
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { after, afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ORKA = path.join(HERE, '..', 'dist', 'orka.js');
const FAKE = path.resolve(HERE, '../../core/test/fixtures/fake-acp.mjs');
const HAS_GIT = spawnSync('git', ['--version'], { windowsHide: true }).status === 0;
/**
 * An empty folder as PATH: no agent CLI (and no git) can be found. Node's own folder is not enough,
 * since global npm programs and git often sit next to node. Orka and the fake agent start by
 * process.execPath, so they need nothing on PATH.
 */
const BARE_PATH = mkdtempSync(path.join(tmpdir(), 'orka-agents-path-'));
after(() => rmSync(BARE_PATH, { recursive: true, force: true }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('orka CLI agent mode', { skip: !existsSync(ORKA) && 'build the CLI first (npm run build -w orka-agent)' }, () => {
  let home;
  let work;
  let log;
  const fakeAgent = () => ({ name: 'Fake agent', command: process.execPath, args: [FAKE] });
  const writeConfig = (config) => writeFileSync(path.join(home, 'config.json'), JSON.stringify(config));
  // Free-form log lines of the fake agent.
  const logged = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'orka-agents-home-'));
    work = mkdtempSync(path.join(tmpdir(), 'orka-agents-work-'));
    // In ORKA_HOME, outside the workspace, so the snapshots never see it.
    log = path.join(home, 'acp-log.jsonl');
    writeFileSync(path.join(work, 'a.txt'), 'a0\n');
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  });

  /** Run the CLI with piped (non-terminal) stdin; `turns` is the fake agent's script. */
  function orka(args, { env = {}, turns = [] } = {}) {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [ORKA, '--lang', 'en', ...args], {
        env: { ...process.env, ORKA_HOME: home, ORKA_NO_CLIPBOARD: '1', NO_COLOR: '1', FAKE_ACP_SCRIPT: JSON.stringify(turns), FAKE_ACP_LOG: log, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c) => (stdout += c));
      child.stderr.on('data', (c) => (stderr += c));
      child.stdin.end();
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
  }

  it('orka agents lists the catalog and the config\'s custom agents, with status, policy, install command and what is turned on', async () => {
    writeConfig({
      agentClis: {
        enabled: ['custom:fake-agent', 42],
        paths: { codex: path.join(work, 'missing', 'codex-acp') },
        custom: [
          fakeAgent(),
          { name: 'No command' },
          { name: 'Fake agent', command: 'another-program' },
          { name: 'x'.repeat(45), command: 'too-long' },
        ],
      },
    });
    const { code, stdout, stderr } = await orka(['agents'], { env: { PATH: BARE_PATH, Path: BARE_PATH } });
    assert.equal(code, 0, stderr);
    assert.match(stdout, /^gemini +Gemini CLI · Google {2}· {2}not installed$/m);
    assert.match(stdout, /Orka never uses Gemini CLI's sign-in itself/, 'the policy note is shown');
    assert.match(stdout, /Install: npm install -g @google\/gemini-cli {2}· {2}Sign in: run "gemini" in a terminal/);
    assert.match(stdout, /Terms: https:\/\/geminicli\.com\//);
    assert.match(stdout, /^codex +Codex \(codex-acp\) · OpenAI {2}· {2}not installed$/m, 'a path that does not exist is not installed');
    assert.match(stdout, /^copilot +GitHub Copilot CLI · GitHub · public preview/m);
    assert.match(stdout, /^custom:fake-agent Fake agent · your own ACP agent {2}· {2}installed {2}· {2}turned on$/m);
    assert.ok(stdout.includes(`Runs: ${/\s/.test(process.execPath) ? `"${process.execPath}"` : process.execPath} ${FAKE}`), 'the exact command line is shown');
    assert.match(stdout, /Not in the catalog\n {2}antigravity .*\n {2}claude-agent-acp /);
    // What is wrong in the config is said, and the rest still works.
    assert.match(stdout, /! Skipped an entry of "agentClis\.custom": it needs a "name" and a "command"/);
    assert.match(stdout, /! Skipped the custom agent "Fake agent": another one already has the id custom:fake-agent\./);
    // A long name gives an id cut to 40 characters, as the apps' settings accept it.
    assert.match(stdout, /^custom:x{40} x{45} · your own ACP agent {2}· {2}not installed$/m);
    assert.equal(stdout.match(/^custom:/gm).length, 2);

    const one = await orka(['--lang', 'tr', 'agents', 'agent:custom:fake-agent'], { env: { PATH: BARE_PATH, Path: BARE_PATH } });
    assert.equal(one.code, 0, one.stderr);
    assert.match(one.stdout, /^custom:fake-agent Fake agent · kendi ACP agent'ınız {2}· {2}kurulu {2}· {2}açık$/m, 'one agent, in Turkish');
    assert.doesNotMatch(one.stdout, /^gemini /m);

    const unknown = await orka(['agents', 'antigravity']);
    assert.equal(unknown.code, 1);
    assert.match(unknown.stderr, /Unknown agent "antigravity"\. Known: gemini, codex, copilot, cursor, custom:fake-agent, custom:x{40}\./);
  });

  it('refuses an unknown agent, an agent in any other role, and a model for an agent; says what is missing', async () => {
    writeConfig({ agentClis: { custom: [fakeAgent()] } });
    for (const id of ['nope', 'antigravity', 'custom:Fake_Agent', 'custom:other', '']) {
      const { code, stderr } = await orka(['--provider', `agent:${id}`, '-p', 'hi', '-C', work]);
      assert.equal(code, 2, id);
      assert.match(stderr, new RegExp(`Unknown agent "${id}"\\. Known: gemini, codex, copilot, cursor, custom:fake-agent\\. Add your own ACP agent under "agentClis\\.custom"`), id);
    }
    const supervisor = await orka(['--provider', 'claude', '--supervisor', 'agent:gemini', '-p', 'hi', '-C', work], { env: { ANTHROPIC_API_KEY: 'test-key' } });
    assert.equal(supervisor.code, 2);
    assert.match(supervisor.stderr, /Supervisor: agent:gemini is an agent CLI: it can only be the main agent, not the Supervisor/);
    const model = await orka(['--provider', 'agent:custom:fake-agent', '-m', 'some-model', '-p', 'hi', '-C', work]);
    assert.equal(model.code, 2);
    assert.match(model.stderr, /Fake agent uses the model set in its own settings; Orka does not choose one for it\./);

    const missing = await orka(['--provider', 'agent:gemini', '-p', 'hi', '-C', work], { env: { PATH: BARE_PATH, Path: BARE_PATH } });
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /Gemini CLI is not installed\. Install it with: npm install -g @google\/gemini-cli\nIf it is installed somewhere else, set its path in "agentClis\.paths"/);

    writeConfig({ agentClis: { paths: { gemini: path.join(work, 'nowhere', 'gemini') }, custom: [{ name: 'Gone', command: path.join(work, 'gone.exe') }] }, trackCommandChanges: false });
    const wrongPath = await orka(['--provider', 'agent:gemini', '-p', 'hi', '-C', work]);
    assert.equal(wrongPath.code, 2);
    assert.match(wrongPath.stderr, /Gemini CLI was not found at ".*nowhere.gemini"\.\nFix or remove its entry in "agentClis\.paths"/);
    const gone = await orka(['--provider', 'agent:custom:gone', '-p', 'hi', '-C', work]);
    assert.match(gone.stderr, /Gone was not found at ".*gone\.exe"\.\nCheck its "command" in "agentClis\.custom"/);

    writeConfig({ agentClis: { custom: [fakeAgent()] }, trackCommandChanges: false });
    const noSnapshots = await orka(['--provider', 'agent:custom:fake-agent', '-p', 'hi', '-C', work]);
    assert.equal(noSnapshots.code, 2);
    assert.match(noSnapshots.stderr, /Fake agent needs command snapshots, so every file it changes can be reviewed and reverted: remove "trackCommandChanges": false/);
    assert.equal(logged().length, 0, 'the agent never started');
  });

  it('runs the agent as the main agent: its answer on stdout, its own writes listed, approvals declined without a terminal, stopped on exit', { skip: !HAS_GIT && 'git is not installed' }, async () => {
    // Not in "enabled": chosen on the command line, any known agent may run.
    writeConfig({ agentClis: { custom: [fakeAgent()] } });
    const turns = [
      [
        { chunk: 'Looking around. ' },
        { permission: { id: 'p1', title: 'Run npm test', kind: 'execute', rawInput: { command: 'npm test' } } },
        { writeFile: { path: path.join(work, 'asked.txt'), content: 'needs approval\n' } },
        { directWrite: { path: 'own.txt', content: 'written by the agent itself\n' } },
        { chunk: 'Done.' },
      ],
    ];
    const { code, stdout, stderr } = await orka(['--provider', 'agent:custom:fake-agent', '--no-supervisor', '--mode', 'ask', '-C', work, '-p', 'make two files'], { turns });
    assert.equal(code, 0, stderr);
    assert.match(stdout, /^Looking around\. *\nDone\.\n$/, 'stdout is only the answer (a new line after each tool call)');
    assert.match(stderr, /Needs approval, declined \(no terminal to ask\): Create asked\.txt/);
    assert.equal(existsSync(path.join(work, 'asked.txt')), false, 'the declined write did not happen');
    assert.equal(readFileSync(path.join(work, 'own.txt'), 'utf8'), 'written by the agent itself\n');
    assert.match(stderr, /1 file\(s\) changed \+1 -0 {2}· {2}token use not reported {2}· {2}Fake agent/, 'the snapshot found the file the agent wrote itself');

    const events = logged();
    assert.match(events.find((e) => e.event === 'prompt').text, /make two files/);
    assert.deepEqual(events.find((e) => e.event === 'permission_answer').outcome, { outcome: 'selected', optionId: 'no' }, "the agent's own permission request was declined");
    assert.ok(events.find((e) => e.event === 'write_answer').error, 'the agent was told its write was declined');
    const [taskDir] = readdirSync(path.join(home, 'tasks'));
    assert.ok(readdirSync(path.join(home, 'tasks', taskDir)).some((f) => f.endsWith('.json')), 'the task is saved');
    // One agent process for the session, stopped when Orka exits.
    const pids = [...new Set(events.map((e) => e.pid))];
    assert.equal(pids.length, 1);
    for (let i = 0; i < 100 && alive(pids[0]); i++) await sleep(50);
    assert.equal(alive(pids[0]), false, 'the agent process is gone');
  });

  it('a "provider" from the config must be turned on in agentClis.enabled; then it runs, and says when there is no Supervisor', { skip: !HAS_GIT && 'git is not installed' }, async () => {
    writeConfig({ provider: 'agent:custom:fake-agent', agentClis: { custom: [fakeAgent()] } });
    const off = await orka(['-p', 'hi', '-C', work]);
    assert.equal(off.code, 2);
    assert.match(off.stderr, /Fake agent is not turned on: add "custom:fake-agent" to "agentClis\.enabled" in .*config\.json, or choose it with --provider agent:custom:fake-agent\./);

    writeConfig({ provider: 'agent:custom:fake-agent', agentClis: { enabled: ['custom:fake-agent'], custom: [fakeAgent()] } });
    const on = await orka(['-p', 'hi', '-C', work], { turns: [[{ chunk: 'Hi from the agent.' }]] });
    assert.equal(on.code, 0, on.stderr);
    assert.equal(on.stdout.trim(), 'Hi from the agent.');
    assert.match(on.stderr, /No Supervisor in this session: next to an agent CLI it needs a model provider of its own/);
  });
});
