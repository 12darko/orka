// The CLI's interactive side, driven through streams that behave like a terminal: the REPL,
// approvals (with a diff), /diff and /undo, Ctrl+C, and handing a task to Freebuff and back.
// The built dist/orka.js runs in this process against a fake Claude API.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as http from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { after, before, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ORKA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'orka.js');
const HANG = Symbol('hang');

const sse = (events) => events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('');
const start = (id) => ['message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 50, output_tokens: 1 } } }];
const toolUse = (id, name, input) =>
  sse([
    start(`msg_${id}`),
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 20 } }],
    ['message_stop', { type: 'message_stop' }],
  ]);
const reply = (text) =>
  sse([
    start('msg_text'),
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }],
    ['message_stop', { type: 'message_stop' }],
  ]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const plain = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '');

/** Streams that act as a terminal (isTTY, raw mode), with everything written to them captured. */
function terminal() {
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.isRaw = false;
  stdin.setRawMode = (mode) => {
    stdin.isRaw = mode;
    return stdin;
  };
  let text = '';
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  stdout.on('data', (c) => (text += c));
  stderr.on('data', (c) => (text += c));
  return {
    io: { stdin, stdout, stderr },
    output: () => plain(text),
    type: (s) => stdin.write(s),
    /** Wait until the output contains `pattern` at least `count` times. */
    async waitFor(pattern, count = 1, timeout = 20_000) {
      const end = Date.now() + timeout;
      const matches = () => (typeof pattern === 'string' ? plain(text).split(pattern).length - 1 : (plain(text).match(new RegExp(pattern.source, 'g')) ?? []).length);
      while (matches() < count) {
        if (Date.now() > end) throw new Error(`timed out waiting for ${pattern}\n--- output ---\n${plain(text)}`);
        await sleep(40);
      }
    },
  };
}

describe('orka CLI in a terminal', { skip: !existsSync(ORKA) && 'build the CLI first (npm run build -w orka-agent)' }, () => {
  let server;
  let script = [];
  let requests = [];
  let main;
  let work;
  const home = mkdtempSync(path.join(tmpdir(), 'orka-tty-home-'));

  before(async () => {
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        if (req.method !== 'POST' || !req.url.startsWith('/v1/messages')) {
          res.writeHead(404, { 'content-type': 'application/json' }).end('{}');
          return;
        }
        requests.push(JSON.parse(raw));
        const next = script.shift();
        const turn = next ? next() : reply('(script ended)');
        if (turn === HANG) return; // a slow model: answers only when the client gives up
        res.writeHead(200, { 'content-type': 'text/event-stream' }).end(turn);
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    Object.assign(process.env, {
      ORKA_HOME: home,
      ORKA_NO_CLIPBOARD: '1',
      NO_COLOR: '1',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
      ANTHROPIC_API_KEY: 'test-key-for-fake-server',
    });
    main = createRequire(import.meta.url)(ORKA).main;
  });
  after(() => {
    server.closeAllConnections?.();
    server.close();
    rmSync(home, { recursive: true, force: true });
  });
  beforeEach(() => {
    work = mkdtempSync(path.join(tmpdir(), 'orka-tty-work-'));
    script = [];
    requests = [];
  });

  const run = (term, ...extra) => main(['--lang', 'en', '--provider', 'claude', '--model', 'claude-opus-5-5', '--no-supervisor', '-C', work, ...extra], term.io);

  it('asks before an edit (with a diff), then /diff and /undo work on the result', async () => {
    const term = terminal();
    const done = run(term, '--mode', 'ask');
    await term.waitFor('/help for commands');
    script = [() => toolUse('toolu_w', 'write_file', { path: 'note.txt', content: 'hello from the agent\n' }), () => reply('The note is written.')];
    term.type('write a note\r');
    await term.waitFor('y yes · a always · n no · d diff');
    term.type('d\r');
    await term.waitFor('+hello from the agent');
    await term.waitFor('y yes · a always · n no · d diff', 2);
    term.type('y\r');
    await term.waitFor('The note is written.');
    await term.waitFor(/1 file\(s\) changed \+1 -0/);
    assert.equal(readFileSync(path.join(work, 'note.txt'), 'utf8'), 'hello from the agent\n');

    term.type('/diff\r');
    await term.waitFor('+hello from the agent', 2);
    term.type('/undo\r');
    await term.waitFor('Revert 1 changed file(s)? (y/n)');
    term.type('y\r');
    await term.waitFor('Reverted: note.txt');
    assert.equal(existsSync(path.join(work, 'note.txt')), false);
    term.type('/exit\r');
    assert.equal(await done, 0);
  });

  it('Ctrl+C stops a running request, and declines an open approval', async () => {
    const term = terminal();
    const done = run(term, '--mode', 'ask');
    await term.waitFor('/help for commands');
    script = [() => HANG];
    term.type('think for a long time\r');
    while (requests.length < 1) await sleep(40);
    term.type('\x03');
    await term.waitFor('Stopped.');

    script = [() => toolUse('toolu_w', 'write_file', { path: 'x.txt', content: 'x' })];
    term.type('write x\r');
    await term.waitFor('y yes · a always · n no · d diff');
    term.type('\x03');
    await term.waitFor('Stopped.', 2);
    assert.equal(existsSync(path.join(work, 'x.txt')), false, 'nothing written');
    term.type('/exit\r');
    assert.equal(await done, 0);
  });

  it('/freebuff hands the terminal to Freebuff and picks up what it changed', async () => {
    const bin = mkdtempSync(path.join(tmpdir(), 'orka-tty-bin-'));
    // A stand-in for Freebuff: it writes a file in the folder it was started in, then quits.
    if (process.platform === 'win32') writeFileSync(path.join(bin, 'freebuff.cmd'), '@echo off\r\necho made by freebuff> fb.txt\r\n');
    else writeFileSync(path.join(bin, 'freebuff'), '#!/bin/sh\necho made by freebuff > fb.txt\n', { mode: 0o755 });
    const savedPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${savedPath}`;
    try {
      const term = terminal();
      const done = run(term);
      await term.waitFor('/help for commands');
      term.type('/freebuff make the coupon case-insensitive\r');
      await term.waitFor('Task summary (paste it into Freebuff):');
      await term.waitFor('make the coupon case-insensitive', 2);
      await term.waitFor('Freebuff changed 1 file(s):');
      await term.waitFor('A fb.txt');
      assert.equal(term.io.stdin.isRaw, true, 'raw mode is back for Orka');
      term.type('/diff\r');
      await term.waitFor('+made by freebuff');
      term.type('/exit\r');
      assert.equal(await done, 0);
      assert.equal(requests.length, 0, 'no model call was needed');
    } finally {
      process.env.PATH = savedPath;
      rmSync(bin, { recursive: true, force: true });
    }
  });
});
