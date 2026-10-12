// End-to-end tests of the built CLI (dist/orka.js): a fake Claude API server scripts the model's
// turns; everything else is real - argument parsing, providers, the orchestrator, file writes,
// commands, approvals and task history (in a temporary ORKA_HOME).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import * as http from 'node:http';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ORKA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'orka.js');

function sse(events) {
  return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

const start = (id) => ['message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 50, output_tokens: 1 } } }];

function toolUse(id, name, input) {
  return sse([
    start(`msg_${id}`),
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 20 } }],
    ['message_stop', { type: 'message_stop' }],
  ]);
}

function reply(text) {
  return sse([
    start('msg_text'),
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }],
    ['message_stop', { type: 'message_stop' }],
  ]);
}

/** Text of every tool_result in a request's last user message. */
function lastToolResults(body) {
  const last = body.messages[body.messages.length - 1];
  return (Array.isArray(last.content) ? last.content : [])
    .filter((b) => b.type === 'tool_result')
    .map((b) => (typeof b.content === 'string' ? b.content : b.content.map((c) => c.text ?? '').join('')));
}

describe('orka CLI', { skip: !existsSync(ORKA) && 'build the CLI first (npm run build -w orka-agent)' }, () => {
  let server;
  let baseURL;
  let script = [];
  let requests = [];
  let failures = [];
  let home;
  let work;

  before(async () => {
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        // A custom OpenAI-compatible endpoint (e.g. a local model server).
        if (req.method === 'POST' && req.url.startsWith('/compat/v1/chat/completions')) {
          const body = JSON.parse(raw);
          requests.push({ openai: true, ...body });
          const chunk = (choices, extra = {}) => `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 0, model: body.model, choices, ...extra })}\n\n`;
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.end(
            chunk([{ index: 0, delta: { role: 'assistant', content: 'Hello from the local model.' }, finish_reason: null }]) +
              chunk([{ index: 0, delta: {}, finish_reason: 'stop' }]) +
              chunk([], { usage: { prompt_tokens: 30, completion_tokens: 6, total_tokens: 36 } }) +
              'data: [DONE]\n\n',
          );
          return;
        }
        if (req.method !== 'POST' || !req.url.startsWith('/v1/messages')) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end('{}');
          return;
        }
        const body = JSON.parse(raw);
        requests.push(body);
        const next = script.shift();
        let turn;
        try {
          turn = next ? next(body) : reply('(script ended)');
        } catch (error) {
          // A failed check inside a turn ends the run instead of leaving the CLI waiting.
          failures.push(error);
          turn = reply(`(check failed: ${error.message})`);
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(turn);
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseURL = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server.close());
  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'orka-home-'));
    work = mkdtempSync(path.join(tmpdir(), 'orka-work-'));
    requests = [];
    script = [];
    failures = [];
  });
  afterEach(() => {
    if (failures.length) throw failures[0];
  });

  /** Run the CLI with piped (non-terminal) stdin against the fake server. */
  function orka(args, stdin = '') {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [ORKA, '--lang', 'en', '--provider', 'claude', '--model', 'claude-opus-5-5', '--no-supervisor', '-C', work, ...args], {
        env: { ...process.env, ORKA_HOME: home, ORKA_NO_CLIPBOARD: '1', ANTHROPIC_BASE_URL: baseURL, ANTHROPIC_API_KEY: 'test-key-for-fake-server', NO_COLOR: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c) => (stdout += c));
      child.stderr.on('data', (c) => (stderr += c));
      child.stdin.end(stdin);
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
  }

  it('answers one request with --print: writes a file, runs a command, prints the reply on stdout', async () => {
    script = [
      () => toolUse('toolu_w', 'write_file', { path: 'notes/hello.txt', content: 'Hello from Orka\n' }),
      () => toolUse('toolu_r', 'run_command', { command: 'node -e "console.log(40 + 2)"' }),
      (body) => {
        assert.match(lastToolResults(body)[0], /42/, 'the command really ran');
        return reply('Created notes/hello.txt and checked node.');
      },
    ];
    const { code, stdout, stderr } = await orka(['-p', '--yes', 'create a hello note']);
    assert.equal(code, 0, stderr);
    assert.equal(stdout.trim(), 'Created notes/hello.txt and checked node.', 'stdout is only the answer');
    assert.match(stderr, /● .*notes\/hello\.txt/, 'progress goes to stderr');
    assert.match(stderr, /1 file\(s\) changed \+1 -0/);
    assert.equal(readFileSync(path.join(work, 'notes', 'hello.txt'), 'utf8'), 'Hello from Orka\n');
    assert.equal(requests[0].model, 'claude-opus-5-5');
    assert.ok(requests[0].tools.some((t) => t.name === 'browser'), 'the full tool set is offered');
    assert.match(JSON.stringify(requests[0].system), /Orka/);
    const [taskDir] = readdirSync(path.join(home, 'tasks'));
    assert.ok(readdirSync(path.join(home, 'tasks', taskDir)).some((f) => f.endsWith('.json')), 'the task is saved');
  });

  it('never approves silently without a terminal: the edit is declined and the model is told why', async () => {
    script = [
      () => toolUse('toolu_w', 'write_file', { path: 'blocked.txt', content: 'x' }),
      (body) => {
        assert.match(lastToolResults(body)[0], /not available to approve/);
        return reply('I could not write the file without approval.');
      },
    ];
    const { code, stdout, stderr } = await orka(['-p', '--mode', 'ask', 'write blocked.txt']);
    assert.equal(code, 0, stderr);
    assert.match(stderr, /Needs approval, declined \(no terminal to ask\): .*blocked\.txt/);
    assert.equal(existsSync(path.join(work, 'blocked.txt')), false);
    assert.match(stdout, /without approval/);
  });

  it('attaches @files and continues the last task with -c', async () => {
    writeFileSync(path.join(work, 'spec.md'), '# Spec\nThe answer is 42.\n');
    script = [(body) => {
      assert.match(JSON.stringify(body.messages[0]), /The answer is 42/, 'the @file content is sent');
      return reply('The spec says 42.');
    }];
    const first = await orka(['-p', 'what does @spec.md say?']);
    assert.equal(first.code, 0, first.stderr);

    script = [(body) => {
      assert.ok(body.messages.length >= 3, 'the earlier conversation is included');
      assert.match(JSON.stringify(body.messages), /The spec says 42/);
      return reply('Still 42.');
    }];
    const second = await orka(['-p', '-c', 'and now?']);
    assert.equal(second.code, 0, second.stderr);
    assert.equal(second.stdout.trim(), 'Still 42.');
  });

  it('reads requests line by line from piped input', async () => {
    script = [() => reply('one'), () => reply('two')];
    const { code, stdout, stderr } = await orka([], 'first\nsecond\n');
    assert.equal(code, 0, stderr);
    assert.match(stdout, /one[\s\S]*two/);
    assert.equal(requests.length, 2);
  });

  it('/freebuff explains how to install it, and never starts it without a terminal to hand over', async () => {
    const run = (PATH) =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, [ORKA, '--lang', 'en', '--provider', 'claude', '--no-supervisor', '-C', work], {
          env: { ...process.env, PATH, Path: PATH, ORKA_HOME: home, ANTHROPIC_BASE_URL: baseURL, ANTHROPIC_API_KEY: 'test-key-for-fake-server', NO_COLOR: '1' },
        });
        let stdout = '';
        child.stdout.on('data', (c) => (stdout += c));
        child.stdin.end('/freebuff fix the coupon\n');
        child.on('close', (code) => resolve({ code, stdout }));
      });
    const missing = await run(path.dirname(process.execPath));
    assert.equal(missing.code, 0);
    assert.match(missing.stdout, /Freebuff is not installed\. Install it with: npm install -g freebuff/);

    const bin = mkdtempSync(path.join(tmpdir(), 'orka-bin-'));
    const marker = path.join(work, 'ran.txt');
    if (process.platform === 'win32') writeFileSync(path.join(bin, 'freebuff.cmd'), `@echo off\r\necho ran> "${marker}"\r\n`);
    else writeFileSync(path.join(bin, 'freebuff'), `#!/bin/sh\necho ran > "${marker}"\n`, { mode: 0o755 });
    const piped = await run(`${bin}${path.delimiter}${path.dirname(process.execPath)}`);
    assert.match(piped.stdout, /Freebuff needs an interactive terminal\./);
    assert.equal(existsSync(marker), false, 'not started without a terminal');
    assert.equal(requests.length, 0, 'the command is not sent to the model');
    rmSync(bin, { recursive: true, force: true });
  });

  it('reports usage errors and missing keys clearly', async () => {
    const bad = await orka(['--mode', 'wild']);
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /--mode must be one of: ask, balanced, autonomous/);
    const noKey = await new Promise((resolve) => {
      const child = spawn(process.execPath, [ORKA, '--lang', 'en', '--provider', 'openai', '-p', 'hi', '-C', work], {
        env: { ...process.env, ORKA_HOME: home, OPENAI_API_KEY: '' },
      });
      let stderr = '';
      child.stderr.on('data', (c) => (stderr += c));
      child.on('close', (code) => resolve({ code, stderr }));
    });
    assert.equal(noKey.code, 2);
    assert.match(noKey.stderr, /OpenAI API needs an API key: set OPENAI_API_KEY/);
    // Claude Code runs on the user's own login, so it is off until the config turns it on.
    const claudeCodeOff = await new Promise((resolve) => {
      const child = spawn(process.execPath, [ORKA, '--lang', 'en', '--provider', 'claude-code', '-p', 'hi', '-C', work], { env: { ...process.env, ORKA_HOME: home } });
      let stderr = '';
      child.stderr.on('data', (c) => (stderr += c));
      child.on('close', (code) => resolve({ code, stderr }));
    });
    assert.equal(claudeCodeOff.code, 2);
    assert.match(claudeCodeOff.stderr, /Claude Code is turned off\. .*"claudeCode": \{ "enabled": true \}/);
  });

  it('uses a custom OpenAI-compatible endpoint from the config, with its key from the named variable', async () => {
    writeFileSync(path.join(home, 'config.json'), JSON.stringify({ custom: [{ id: 'local', label: 'Local LLM', baseURL: `${baseURL}/compat/v1`, model: 'qwen3-coder', apiKeyEnv: 'LOCAL_LLM_KEY' }] }));
    const run = (env) =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, [ORKA, '--lang', 'en', '--provider', 'local', '--no-supervisor', '-C', work, '-p', 'hi'], { env: { ...process.env, ORKA_HOME: home, NO_COLOR: '1', ...env } });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (c) => (stdout += c));
        child.stderr.on('data', (c) => (stderr += c));
        child.stdin?.end();
        child.on('close', (code) => resolve({ code, stdout, stderr }));
      });
    const missing = await run({ LOCAL_LLM_KEY: '' });
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /Local LLM needs an API key: set LOCAL_LLM_KEY/);
    const { code, stdout, stderr } = await run({ LOCAL_LLM_KEY: 'test-key-for-fake-server' });
    assert.equal(code, 0, stderr);
    assert.equal(stdout.trim(), 'Hello from the local model.');
    assert.equal(requests.at(-1).model, 'qwen3-coder');
  });
});
