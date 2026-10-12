import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { ClaudeProvider, toClaudeMessages } from '../src/providers/ClaudeProvider';
import { OpenAIProvider, toOpenAIMessages } from '../src/providers/OpenAIProvider';
import type { ProviderStreamEvent } from '../src/providers/AIProvider';
import type { ChatMessage, ToolSpec } from '../src/types';

const TOOLS: ToolSpec[] = [
  {
    name: 'read_file',
    description: 'Read a file',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
];

function sse(events: Array<[string | null, unknown]>): string {
  return events.map(([name, data]) => `${name ? `event: ${name}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`).join('');
}

/** Minimal fake API server: records requests, replies with a canned SSE stream. */
function fakeServer(reply: (body: any) => string): Promise<{ server: Server; url: string; requests: Array<{ headers: IncomingMessage['headers']; body: any }> }> {
  const requests: Array<{ headers: IncomingMessage['headers']; body: any }> = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      requests.push({ headers: req.headers, body });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(reply(body));
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests })),
  );
}

const CLAUDE_STREAM = sse([
  ['message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 80, cache_creation_input_tokens: 0 } } }],
  ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Need to read the file.' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig123' } }],
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Reading it now.' } }],
  ['content_block_stop', { type: 'content_block_stop', index: 1 }],
  ['content_block_start', { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: {} } }],
  ['content_block_delta', { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"path": "src/' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: 'a.ts"}' } }],
  ['content_block_stop', { type: 'content_block_stop', index: 2 }],
  ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 42 } }],
  ['message_stop', { type: 'message_stop' }],
]);

describe('ClaudeProvider (via the official SDK against a fake server)', () => {
  let fake: Awaited<ReturnType<typeof fakeServer>>;
  before(async () => (fake = await fakeServer(() => CLAUDE_STREAM)));
  after(() => fake.server.close());

  it('sends the expected request and normalizes the streamed response', async () => {
    const provider = new ClaudeProvider({ apiKey: 'test-key', baseURL: fake.url, effort: 'high' });
    const events: ProviderStreamEvent[] = [];
    const res = await provider.chat(
      { system: 'SYSTEM', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: TOOLS },
      (e) => events.push(e),
    );

    const { body, headers } = fake.requests[0];
    assert.equal(body.model, 'claude-opus-5-5');
    assert.equal(body.max_tokens, 64000);
    assert.equal(body.stream, true);
    assert.deepEqual(body.thinking, { type: 'adaptive', display: 'summarized' });
    assert.deepEqual(body.output_config, { effort: 'high' });
    assert.deepEqual(body.cache_control, { type: 'ephemeral' });
    assert.equal(body.fallbacks, 'default');
    assert.match(String(headers['anthropic-beta']), /server-side-fallback-2026-07-01/);
    assert.equal(body.tools[0].eager_input_streaming, true);
    assert.equal(body.tools[0].input_schema.required[0], 'path');
    assert.deepEqual(body.system, [{ type: 'text', text: 'SYSTEM' }]);

    assert.equal(res.stopReason, 'tool_use');
    assert.equal(res.usage.outputTokens, 42);
    assert.equal(res.usage.cacheReadTokens, 80);
    assert.deepEqual(res.message.content, [
      { type: 'reasoning', text: 'Need to read the file.' },
      { type: 'text', text: 'Reading it now.' },
      { type: 'tool_call', id: 'toolu_1', name: 'read_file', input: { path: 'src/a.ts' } },
    ]);
    assert.ok(events.some((e) => e.type === 'reasoning_delta'));
    assert.ok(events.some((e) => e.type === 'text_delta' && e.text === 'Reading it now.'));
    assert.ok(events.some((e) => e.type === 'tool_call_start' && e.name === 'read_file'));

    // Replaying the turn sends the native blocks (with the thinking signature) back unchanged.
    const replay = toClaudeMessages([res.message]);
    const thinking = (replay[0].content as any[])[0];
    assert.equal(thinking.type, 'thinking');
    assert.equal(thinking.signature, 'sig123');
  });

  it('omits fallbacks for models that do not support them', async () => {
    const provider = new ClaudeProvider({ apiKey: 'k', baseURL: fake.url, model: 'claude-haiku-4-5' });
    await provider.chat({ system: 's', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }], tools: TOOLS }, () => {});
    const { body } = fake.requests[fake.requests.length - 1];
    assert.equal(body.fallbacks, undefined);
    assert.equal(body.thinking, undefined, 'haiku 4.5 does not take adaptive thinking');
  });
});

const OPENAI_STREAM = sse([
  [null, { id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'gpt-6-astra', choices: [{ index: 0, delta: { role: 'assistant', content: 'Let me look.' }, finish_reason: null }] }],
  [null, { id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'gpt-6-astra', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'read_file', arguments: '{"pa' } }] }, finish_reason: null }] }],
  [null, { id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'gpt-6-astra', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"b.ts"}' } }] }, finish_reason: null }] }],
  [null, { id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'gpt-6-astra', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }],
  [null, { id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'gpt-6-astra', choices: [], usage: { prompt_tokens: 50, completion_tokens: 7, total_tokens: 57, prompt_tokens_details: { cached_tokens: 20 } } }],
  [null, '[DONE]'],
]);

describe('OpenAIProvider (via the official SDK against a fake server)', () => {
  let fake: Awaited<ReturnType<typeof fakeServer>>;
  before(async () => (fake = await fakeServer(() => OPENAI_STREAM)));
  after(() => fake.server.close());

  it('streams text and tool calls into the neutral format', async () => {
    const provider = new OpenAIProvider({ apiKey: 'test-key', baseURL: fake.url });
    const res = await provider.chat(
      { system: 'SYSTEM', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: TOOLS },
      () => {},
    );
    const { body } = fake.requests[0];
    assert.equal(body.model, 'gpt-6-astra');
    assert.equal(body.stream, true);
    assert.deepEqual(body.stream_options, { include_usage: true });
    assert.equal(body.tools[0].type, 'function');
    assert.equal(body.tools[0].function.name, 'read_file');
    assert.deepEqual(body.messages[0], { role: 'system', content: 'SYSTEM' });

    assert.equal(res.stopReason, 'tool_use');
    assert.deepEqual(res.message.content, [
      { type: 'text', text: 'Let me look.' },
      { type: 'tool_call', id: 'call_a', name: 'read_file', input: { path: 'b.ts' } },
    ]);
    assert.deepEqual(res.usage, { inputTokens: 50, outputTokens: 7, cacheReadTokens: 20, cacheWriteTokens: 0 });
  });
});

describe('message conversion', () => {
  const history: ChatMessage[] = [
    { role: 'user', content: [{ type: 'text', text: 'fix it' }] },
    {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'hidden' },
        { type: 'text', text: 'Looking.' },
        { type: 'tool_call', id: 'call_1', name: 'read_file', input: { path: 'a' } },
      ],
    },
    { role: 'user', content: [{ type: 'tool_result', toolCallId: 'call_1', content: 'data' }, { type: 'text', text: 'also this' }] },
  ];

  it('OpenAI: tool messages come right after the assistant turn, reasoning is dropped', () => {
    const out = toOpenAIMessages('S', history) as any[];
    assert.deepEqual(out.map((m) => m.role), ['system', 'user', 'assistant', 'tool', 'user']);
    assert.equal(out[2].content, 'Looking.');
    assert.equal(out[2].tool_calls[0].function.arguments, '{"path":"a"}');
    assert.equal(out[3].tool_call_id, 'call_1');
  });

  it('Claude: neutral turns from another provider become tool_use / tool_result blocks', () => {
    const out = toClaudeMessages(history) as any[];
    assert.deepEqual(out[1].content.map((b: any) => b.type), ['text', 'tool_use']);
    assert.deepEqual(out[2].content.map((b: any) => b.type), ['tool_result', 'text']);
    assert.equal(out[2].content[0].tool_use_id, 'call_1');
  });
});
