// Emulates `claude -p --input-format stream-json --output-format stream-json` for tests.
// FAKE_CC_SCRIPT: JSON array of reply texts (one per user message, "__ERROR__:msg" for an error result).
// FAKE_CC_LOG: file that receives one JSON line per received user message.
import { appendFileSync } from 'node:fs';

const replies = JSON.parse(process.env.FAKE_CC_SCRIPT || '[]');
const log = process.env.FAKE_CC_LOG;
const argv = process.argv.slice(2);
let turn = 0;
let buffer = '';

const out = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) handle(JSON.parse(line));
  }
});

function handle(message) {
  const text = message.message.content;
  if (log) appendFileSync(log, `${JSON.stringify({ pid: process.pid, turn, text, argv })}\n`);
  const reply = replies[turn++] ?? 'no more scripted replies';
  out({ type: 'system', subtype: 'init', model: 'claude-fake-1', tools: [] });
  if (reply.startsWith('__ERROR__:')) {
    const error = reply.slice('__ERROR__:'.length);
    out({ type: 'assistant', message: { content: [{ type: 'text', text: error }] } });
    out({ type: 'result', subtype: 'success', is_error: true, result: error, usage: {} });
    return;
  }
  out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'pondering' } } });
  // Stream in small uneven chunks so tags get split across deltas.
  for (let i = 0; i < reply.length; i += 7) {
    out({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: reply.slice(i, i + 7) } } });
  }
  out({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'pondering' }] } });
  out({ type: 'assistant', message: { content: [{ type: 'text', text: reply }] } });
  out({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: reply,
    stop_reason: 'end_turn',
    usage: { input_tokens: 11, output_tokens: 7, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 },
  });
}
