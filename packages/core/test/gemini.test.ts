import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { GeminiProvider, toGeminiContents } from '../src/providers/GeminiProvider';
import type { ProviderStreamEvent } from '../src/providers/AIProvider';
import type { ChatMessage, ToolSpec } from '../src/types';

const TOOLS: ToolSpec[] = [
  { name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
];

const CHUNKS = [
  { candidates: [{ content: { role: 'model', parts: [{ text: 'Need the file first.', thought: true }] } }], modelVersion: 'gemini-3.8-flash' },
  { candidates: [{ content: { role: 'model', parts: [{ text: 'Let me read it.' }] } }] },
  {
    candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'read_file', args: { path: 'a.ts' } }, thoughtSignature: 'c2lnbmF0dXJl' }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 120, cachedContentTokenCount: 100, candidatesTokenCount: 9, thoughtsTokenCount: 30 },
  },
];

describe('GeminiProvider (official SDK against a fake server)', () => {
  let server: Server;
  let url: string;
  const requests: Array<{ path: string; headers: Record<string, unknown>; body: any }> = [];

  before(async () => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        requests.push({ path: req.url ?? '', headers: req.headers, body: JSON.parse(raw || '{}') });
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(CHUNKS.map((c) => `data: ${JSON.stringify(c)}\r\n\r\n`).join(''));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => server.close());

  it('streams thoughts, text and function calls and keeps the raw parts for replay', async () => {
    const provider = new GeminiProvider({ apiKey: 'test-key', baseURL: url, thinkingLevel: 'high' });
    const events: ProviderStreamEvent[] = [];
    const res = await provider.chat({ system: 'SYS', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: TOOLS }, (e) => events.push(e));

    const req = requests[0];
    assert.match(req.path, /models\/gemini-3\.8-flash:streamGenerateContent\?alt=sse/);
    assert.equal(req.headers['x-goog-api-key'], 'test-key');
    assert.deepEqual(req.body.systemInstruction.parts[0], { text: 'SYS' });
    assert.equal(req.body.tools[0].functionDeclarations[0].name, 'read_file');
    assert.deepEqual(req.body.tools[0].functionDeclarations[0].parametersJsonSchema.required, ['path']);
    assert.equal(req.body.generationConfig.thinkingConfig.includeThoughts, true);
    assert.equal(req.body.generationConfig.thinkingConfig.thinkingLevel, 'HIGH');

    assert.equal(res.stopReason, 'tool_use');
    assert.deepEqual(res.usage, { inputTokens: 20, outputTokens: 39, cacheReadTokens: 100, cacheWriteTokens: 0 });
    const [reasoning, text, call] = res.message.content;
    assert.deepEqual(reasoning, { type: 'reasoning', text: 'Need the file first.' });
    assert.deepEqual(text, { type: 'text', text: 'Let me read it.' });
    assert.equal(call.type === 'tool_call' && call.name, 'read_file');
    assert.ok(events.some((e) => e.type === 'reasoning_delta') && events.some((e) => e.type === 'text_delta'));

    // Replay: native parts (with the thought signature) go back unchanged; the result is matched by name.
    const history: ChatMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      res.message,
      { role: 'user', content: [{ type: 'tool_result', toolCallId: (call as { id: string }).id, content: 'export const q = 1;' }] },
    ];
    const contents = toGeminiContents(history);
    assert.equal(contents[1].role, 'model');
    assert.equal(contents[1].parts?.[2].thoughtSignature, 'c2lnbmF0dXJl');
    assert.deepEqual(contents[2].parts?.[0].functionResponse, { name: 'read_file', response: { output: 'export const q = 1;' } });
  });

  it('marks function calls carried over from other providers so Gemini accepts them', () => {
    const contents = toGeminiContents([
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      { role: 'assistant', content: [{ type: 'tool_call', id: 'toolu_1', name: 'read_file', input: { path: 'x' } }] },
      { role: 'user', content: [{ type: 'tool_result', toolCallId: 'toolu_1', content: 'boom', isError: true }] },
    ]);
    assert.deepEqual(contents[1].parts?.[0], {
      functionCall: { name: 'read_file', args: { path: 'x' }, id: 'toolu_1' },
      thoughtSignature: 'skip_thought_signature_validator',
    });
    assert.deepEqual(contents[2].parts?.[0].functionResponse, { name: 'read_file', id: 'toolu_1', response: { error: 'boom' } });
  });
});
