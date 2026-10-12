// End-to-end test that runs inside a real VS Code extension host (see run.mjs).
// A fake Claude API server scripts the model's turns; everything else is the real extension:
// activation, webview view, orchestrator, Anthropic SDK streaming, permissions, VSCodeHost file
// writes, command execution and the terminal mirror.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const vscode = require('vscode');

function sse(events) {
  return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

function toolUseTurn(id, name, input) {
  const json = JSON.stringify(input);
  return sse([
    ['message_start', { type: 'message_start', message: { id: `msg_${id}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 50, output_tokens: 1 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: json.slice(0, 10) } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: json.slice(10) } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 20 } }],
    ['message_stop', { type: 'message_stop' }],
  ]);
}

function textTurn(text) {
  return sse([
    ['message_start', { type: 'message_start', message: { id: 'msg_final', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 50, output_tokens: 1 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }],
    ['message_stop', { type: 'message_stop' }],
  ]);
}

const SCRIPT = [
  () => toolUseTurn('toolu_write', 'write_file', { path: 'notes/hello.txt', content: 'Hello from the agent\n' }),
  () => toolUseTurn('toolu_run', 'run_command', { command: 'node -e "console.log(40 + 2)"' }),
  () => textTurn('Created notes/hello.txt and verified node runs.'),
];

exports.run = async function run() {
  const report = [];
  const log = (line) => {
    report.push(line);
    console.log(`[e2e] ${line}`);
  };
  const requests = [];
  const supervisorRequests = [];
  const modelListRequests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      // The daily model-list refresh: report one model this build does not know yet.
      if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
        modelListRequests.push(req.url);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          data: [
            { type: 'model', id: 'claude-opus-6', display_name: 'Claude Opus 6', created_at: '2026-09-01T00:00:00Z' },
            { type: 'model', id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', created_at: '2026-05-01T00:00:00Z' },
          ],
          has_more: false,
          first_id: 'claude-opus-6',
          last_id: 'claude-opus-5-5',
        }));
        return;
      }
      // Anything that is not a Messages request (e.g. a probe of the port) is not part of the script.
      if (req.method !== 'POST' || !req.url.startsWith('/v1/messages')) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      const entry = { method: req.method, url: req.url, headers: req.headers, body: JSON.parse(raw || '{}') };
      // The supervisor shares the provider; answer its reviews separately from the scripted main agent.
      if (/supervisor of an AI coding agent/.test(entry.body.system?.[0]?.text ?? '')) {
        supervisorRequests.push(entry);
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(textTurn('<verdict>ok</verdict>'));
        return;
      }
      requests.push(entry);
      const step = SCRIPT[requests.length - 1];
      if (!step) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'script exhausted' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(step());
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.ANTHROPIC_API_KEY = 'e2e-test-key';

  try {
    const ws = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const ext = vscode.extensions.getExtension('12darko.orka-vscode');
    assert.ok(ext, 'extension is installed in the dev host');
    await ext.activate();
    log(`activated ${ext.id}`);

    const commands = await vscode.commands.getCommands(true);
    for (let i = 0; i < 40 && !modelListRequests.length; i++) await new Promise((r) => setTimeout(r, 250));
    assert.ok(modelListRequests.length >= 1, 'model lists are refreshed from the provider on startup');
    log('model list refreshed from the provider in the background');

    for (const c of ['orka.ask', 'orka.checkForUpdates', 'orka.newTask', 'orka.setApiKey', 'orka.selectMode', 'orka.revertAllChanges', 'orka.showSkills', 'orka.newSkill', 'orka.selectWorkspaceFolder']) {
      assert.ok(commands.includes(c), `command ${c} registered`);
    }
    log('commands registered');

    await vscode.commands.executeCommand('orka.chat.focus');
    log('chat view opened');

    await vscode.commands.executeCommand('orka.ask', 'Create notes/hello.txt with a greeting, then check that node works.');
    log(`agent run finished after ${requests.length} model requests`);

    const file = path.join(ws, 'notes', 'hello.txt');
    if (!fs.existsSync(file)) log(`requests: ${JSON.stringify(requests.map((r) => [r.method, r.url, JSON.stringify(r.body).slice(0, 300)]))}`);
    assert.equal(fs.readFileSync(file, 'utf8'), 'Hello from the agent\n');
    log('notes/hello.txt written by the agent');

    assert.equal(requests.length, 3, 'three model turns');
    const [first, second, third] = requests;
    assert.equal(first.url, '/v1/messages?beta=true');
    assert.equal(first.headers['x-api-key'], 'e2e-test-key');
    assert.equal(first.body.model, 'claude-opus-5-5');
    assert.equal(first.body.tools.length, 24);
    for (const name of ['web_fetch', 'open_browser', 'open_file', 'browser', 'ask_supervisor', 'code_outline', 'start_process', 'process_output', 'stop_process']) assert.ok(first.body.tools.some((t) => t.name === name), `${name} offered`);
    assert.ok(first.body.tools.some((t) => t.name === 'run_subagent'), 'sub-agent tool offered');
    assert.ok(first.body.tools.some((t) => t.name === 'load_skill'), 'skill tool offered');
    assert.match(first.body.system[0].text, /# Delegation/);
    assert.match(first.body.system[0].text, /# Skills[\s\S]*- debugging: [\s\S]*- unity: Unity projects/, 'built-in skills listed');
    assert.ok(first.body.tools.every((t) => t.eager_input_streaming === true));
    assert.match(first.body.system[0].text, /Editor: VS Code/);
    assert.match(first.body.messages[0].content[0].text, /<context>[\s\S]*Permission mode: balanced/);
    log('request shape ok (model, tools, system prompt, editor context)');

    const writeResult = second.body.messages.at(-1).content[0];
    assert.equal(writeResult.type, 'tool_result');
    assert.equal(writeResult.tool_use_id, 'toolu_write');
    assert.match(writeResult.content, /Created notes\/hello\.txt/);
    const runResult = third.body.messages.at(-1).content[0];
    assert.equal(runResult.tool_use_id, 'toolu_run');
    assert.match(runResult.content, /Exit code: 0\s+42/);
    log('tool results returned to the model (write_file, run_command -> 42)');

    // Append-only history across turns.
    assert.deepEqual(third.body.messages.slice(0, second.body.messages.length), second.body.messages);
    assert.equal(third.body.system[0].text, first.body.system[0].text);
    log('history append-only, system prompt frozen');

    // Supervisor (smart checkpoints, the default): no plan, nobody stuck -> only the final review,
    // one stateless call on a compact brief, with no tools.
    assert.equal(supervisorRequests.length, 1, `supervisor reviews: ${supervisorRequests.length}`);
    assert.ok(supervisorRequests.every((r) => !r.body.tools), 'supervisor gets no tools');
    assert.equal(supervisorRequests[0].body.messages.length, 1, 'stateless checkpoint');
    const lastReview = supervisorRequests[0].body.messages[0].content[0].text;
    assert.match(lastReview, /FINAL REVIEW[\s\S]*What the user asked[\s\S]*Create notes\/hello\.txt[\s\S]*\+\+\+ b\/notes\/hello\.txt[\s\S]*\+Hello from the agent[\s\S]*Recent agent activity[\s\S]*run_command/);
    log('supervisor: one final checkpoint from a compact brief (request, diff, activity)');

    // Task history: the finished task was saved to the extension's workspace storage.
    const findIndex = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          const hit = findIndex(full);
          if (hit) return hit;
        } else if (entry.name === 'index.json' && path.basename(dir) === 'tasks') return full;
      }
      return undefined;
    };
    let indexFile;
    for (let i = 0; i < 20 && !indexFile; i++) {
      indexFile = findIndex(process.env.E2E_USER_DATA);
      if (!indexFile) await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(indexFile, 'task history index written');
    const tasks = Object.values(JSON.parse(fs.readFileSync(indexFile, 'utf8')));
    assert.equal(tasks.length, 1);
    assert.match(tasks[0].title, /Create notes\/hello\.txt/);
    const saved = JSON.parse(fs.readFileSync(path.join(path.dirname(indexFile), `${tasks[0].id}.json`), 'utf8'));
    assert.equal(saved.messages.length, third.body.messages.length + 1, 'full conversation saved');
    assert.ok(saved.usageByAgent.some((u) => u.agent === 'supervisor'), 'per-agent usage saved');
    assert.deepEqual(saved.checkpoint, [{ path: 'notes/hello.txt', original: null }], 'unaccepted changes saved with the task');
    assert.ok(saved.skills.includes('unity'), 'offered skills saved');
    log(`task saved to history (${saved.messages.length} messages, ${saved.usageByAgent.length} agent usage rows)`);
    report.push('RESULT: PASS');
  } catch (error) {
    report.push(`RESULT: FAIL ${error && error.stack ? error.stack : error}`);
    throw error;
  } finally {
    server.close();
    if (process.env.E2E_REPORT) fs.writeFileSync(process.env.E2E_REPORT, report.join('\n'));
  }
};
