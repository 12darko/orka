// A fake ACP agent for tests. FAKE_ACP_SCRIPT is a JSON array of turns, one per session/prompt
// (counted across sessions); each turn is a list of steps:
//   {chunk: "text"} {thought: "text"} {plan: [{content, status}]}
//   {toolCall: {id, title, kind, status, locations, rawInput, content}} {toolCallUpdate: {id, status, text}}
//   {permission: {id, title, kind, rawInput, locations, diff: {path, oldText, newText}}}
//   {readFile: {path, line, limit}} {writeFile: {path, content}} {directWrite: {path, content}}
//   {terminal: {command, args, cwd}} {hang: true} {stop: "end_turn" | "refusal" | ...}
// Every message and answer is logged as a JSON line to FAKE_ACP_LOG. FAKE_ACP_NEEDS_LOGIN=1 makes
// session/new fail with "auth required"; FAKE_ACP_IMAGES=1 advertises image prompts;
// FAKE_ACP_HANG=initialize (or session/new) never answers that request, like a stuck agent.
import { appendFileSync, writeFileSync, mkdirSync } from 'node:fs';
import * as path from 'node:path';

const script = JSON.parse(process.env.FAKE_ACP_SCRIPT || '[]');
const logFile = process.env.FAKE_ACP_LOG;
const log = (entry) => logFile && appendFileSync(logFile, `${JSON.stringify({ pid: process.pid, ...entry })}\n`);
const send = (message, eol = '\n') => process.stdout.write(`${JSON.stringify(message)}${eol}`);

process.stdout.write('fake-acp starting (a log line that is not JSON)\n');

let buffer = '';
let nextId = 1;
let turnIndex = 0;
let sessions = 0;
const pending = new Map();
const cwds = new Map();
/** The running prompt per session: its cancel hook. */
const running = new Map();

process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) handle(JSON.parse(line));
  }
});

function request(method, params) {
  const id = `agent-${nextId++}`;
  send({ jsonrpc: '2.0', id, method, params });
  return new Promise((resolve) => pending.set(id, resolve));
}

function update(sessionId, update) {
  send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } });
}

async function handle(message) {
  if (message.method === undefined) {
    // An answer to one of our requests.
    const resolve = pending.get(message.id);
    pending.delete(message.id);
    resolve?.(message.error ? { error: message.error } : { result: message.result });
    return;
  }
  log({ event: message.method, params: message.method === 'session/prompt' ? undefined : message.params });
  if (process.env.FAKE_ACP_HANG === message.method) return;
  switch (message.method) {
    case 'initialize':
      // CRLF on purpose: the client must cope with it.
      send(
        {
          jsonrpc: '2.0',
          id: message.id,
          result: {
            protocolVersion: 1,
            agentCapabilities: { loadSession: false, promptCapabilities: { image: process.env.FAKE_ACP_IMAGES === '1' } },
            agentInfo: { name: 'fake-acp', version: '1.0.0' },
            authMethods: [{ id: 'fake-login', name: 'Fake login' }],
          },
        },
        '\r\n',
      );
      return;
    case 'session/new': {
      if (process.env.FAKE_ACP_NEEDS_LOGIN === '1') {
        send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'Authentication required' } });
        return;
      }
      const sessionId = `sess-${++sessions}`;
      cwds.set(sessionId, message.params.cwd);
      send({ jsonrpc: '2.0', id: message.id, result: { sessionId } });
      // Updates outside a prompt (commands) must not confuse the client.
      update(sessionId, { sessionUpdate: 'available_commands_update', availableCommands: [] });
      return;
    }
    case 'authenticate':
      send({ jsonrpc: '2.0', id: message.id, result: {} });
      return;
    case 'session/cancel':
      running.get(message.params.sessionId)?.();
      return;
    case 'session/prompt': {
      const { sessionId, prompt } = message.params;
      log({ event: 'prompt', sessionId, text: prompt.filter((b) => b.type === 'text').map((b) => b.text).join('\n'), images: prompt.filter((b) => b.type === 'image').length });
      const turn = script[turnIndex++] ?? [{ chunk: '(no script)' }];
      const stopReason = await runTurn(sessionId, turn);
      log({ event: 'prompt_done', sessionId, stopReason });
      send({ jsonrpc: '2.0', id: message.id, result: { stopReason } });
      return;
    }
    default:
      if (message.id !== undefined) send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'not supported' } });
  }
}

async function runTurn(sessionId, steps) {
  let cancelled = false;
  let wake;
  running.set(sessionId, () => {
    cancelled = true;
    wake?.();
  });
  try {
    for (const step of steps) {
      if (cancelled) return 'cancelled';
      if (step.chunk !== undefined) update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: step.chunk } });
      else if (step.thought !== undefined) update(sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: step.thought } });
      else if (step.plan) update(sessionId, { sessionUpdate: 'plan', entries: step.plan.map((e) => ({ priority: 'medium', status: 'pending', ...e })) });
      else if (step.toolCall) {
        const { id, ...rest } = step.toolCall;
        update(sessionId, { sessionUpdate: 'tool_call', toolCallId: id, status: 'pending', ...rest });
      } else if (step.toolCallUpdate) {
        const { id, text, ...rest } = step.toolCallUpdate;
        update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: id, ...rest, ...(text ? { content: [{ type: 'content', content: { type: 'text', text } }] } : {}) });
      } else if (step.permission) {
        const { id, diff, ...rest } = step.permission;
        const answer = await request('session/request_permission', {
          sessionId,
          toolCall: { toolCallId: id, ...rest, ...(diff ? { content: [{ type: 'diff', ...diff }] } : {}) },
          options: [
            { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
            { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
            { optionId: 'no', name: 'Reject', kind: 'reject_once' },
            { optionId: 'never', name: 'Never', kind: 'reject_always' },
          ],
        });
        log({ event: 'permission_answer', id, outcome: answer.result?.outcome });
      } else if (step.readFile) {
        const answer = await request('fs/read_text_file', { sessionId, ...step.readFile });
        log({ event: 'read_answer', path: step.readFile.path, ...answer });
      } else if (step.writeFile) {
        const answer = await request('fs/write_text_file', { sessionId, ...step.writeFile });
        log({ event: 'write_answer', path: step.writeFile.path, ...answer });
      } else if (step.directWrite) {
        // The agent's own tool: Orka does not see this write happen.
        const target = path.resolve(cwds.get(sessionId), step.directWrite.path);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, step.directWrite.content);
      } else if (step.terminal) {
        const created = await request('terminal/create', { sessionId, ...step.terminal });
        if (created.error) {
          log({ event: 'terminal_answer', error: created.error });
          continue;
        }
        const terminalId = created.result.terminalId;
        const exit = await request('terminal/wait_for_exit', { sessionId, terminalId });
        const output = await request('terminal/output', { sessionId, terminalId });
        await request('terminal/release', { sessionId, terminalId });
        log({ event: 'terminal_answer', exit: exit.result, output: output.result });
      } else if (step.hang) {
        await new Promise((resolve) => (wake = resolve));
        // { hang: true, afterCancel: "text" }: a slow agent still says something after the cancel.
        if (step.afterCancel !== undefined) update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: step.afterCancel } });
      } else if (step.stop) {
        return step.stop;
      }
    }
    return cancelled ? 'cancelled' : 'end_turn';
  } finally {
    running.delete(sessionId);
  }
}
