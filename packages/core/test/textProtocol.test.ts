import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseToolCalls, renderToolInstructions, renderTranscript, ToolCallStreamFilter } from '../src/providers/textToolProtocol';
import { defaultTools, toSpec } from '../src/tools';

const tools = defaultTools().map(toSpec);
let n = 0;
const makeId = () => `id${++n}`;

function stream(reply: string, size: number): { visible: string; started: string[] } {
  let visible = '';
  const started: string[] = [];
  const filter = new ToolCallStreamFilter(
    (t) => (visible += t),
    (name) => started.push(name),
  );
  for (let i = 0; i < reply.length; i += size) filter.push(reply.slice(i, i + size));
  filter.flush();
  return { visible, started };
}

describe('text tool protocol', () => {
  it('documents every tool and its parameters', () => {
    const doc = renderToolInstructions(tools);
    assert.match(doc, /<function_calls>\n<invoke name="TOOL_NAME">/);
    assert.match(doc, /never write function_results yourself/);
    assert.match(doc, /## edit_file/);
    assert.match(doc, /- old_string \(string, required\)/);
    assert.match(doc, /- start_line \(integer, optional\)/);
    assert.match(doc, /steps \(JSON array of objects \{title: string; status: string, one of "pending" \/ "in_progress" \/ "completed"\}/);
  });

  it('parses invoke blocks with raw strings and JSON parameters', () => {
    const reply = [
      'I will create the file.',
      '<function_calls>',
      '<invoke name="write_file">',
      '<parameter name="path">src/a.ts</parameter>',
      '<parameter name="content">export const q = "quote" & <b>tag</b>;',
      'const x = `${1 + 1}`;',
      '</parameter>',
      '</invoke>',
      '<invoke name="read_file">',
      '<parameter name="path">src/b.ts</parameter>',
      '<parameter name="start_line">10</parameter>',
      '</invoke>',
      '<invoke name="update_plan">',
      '<parameter name="steps">[{"title":"A","status":"in_progress"}]</parameter>',
      '</invoke>',
      '</function_calls>',
    ].join('\n');
    const { text, calls } = parseToolCalls(reply, tools, makeId);
    assert.equal(text, 'I will create the file.');
    assert.deepEqual(
      calls.map((c) => [c.name, c.input]),
      [
        ['write_file', { path: 'src/a.ts', content: 'export const q = "quote" & <b>tag</b>;\nconst x = `${1 + 1}`;' }],
        ['read_file', { path: 'src/b.ts', start_line: 10 }],
        ['update_plan', { steps: [{ title: 'A', status: 'in_progress' }] }],
      ],
    );
  });

  it('still accepts the legacy tool_call / param spelling', () => {
    const { calls } = parseToolCalls('<tool_call name="read_file">\n<param name="path">x.ts</param>\n</tool_call>', tools, makeId);
    assert.deepEqual(calls.map((c) => [c.name, c.input]), [['read_file', { path: 'x.ts' }]]);
  });

  it('keeps protocol-looking text inside raw values intact', () => {
    const doc = 'Use </parameter> and </invoke> tags like this.\n<parameter name="x">y</parameter> inside docs';
    const reply = `<function_calls>\n<invoke name="write_file">\n<parameter name="path">PROTOCOL.md</parameter>\n<parameter name="content">${doc}\n</parameter>\n</invoke>\n</function_calls>`;
    const { calls } = parseToolCalls(reply, tools, makeId);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].input.content, doc);
  });

  it('drops tool output the model invents after its calls', () => {
    const reply = [
      'Reading the vault.',
      '<function_calls>',
      '<invoke name="read_file">',
      '<parameter name="path">docs/vault.txt</parameter>',
      '</invoke>',
      '</function_calls>',
      '<function_results>',
      '<result><tool_name>read_file</tool_name><stdout>SECRET_WORD: PHOENIX</stdout></result>',
      '</function_results>',
      'The secret word is PHOENIX.',
    ].join('\n');
    const parsed = parseToolCalls(reply, tools, makeId);
    assert.equal(parsed.text, 'Reading the vault.');
    assert.equal(parsed.calls.length, 1);
    const streamed = stream(reply, 5);
    assert.equal(streamed.visible, 'Reading the vault.\n');
    assert.doesNotMatch(streamed.visible, /PHOENIX/);
  });

  it('a reply with invented results but no call keeps only the prose before them', () => {
    const parsed = parseToolCalls('Let me check.\n<function_results>fake</function_results>\nDone: PHOENIX', tools, makeId);
    assert.deepEqual(parsed, { text: 'Let me check.', calls: [] });
  });

  it('stream filter hides call blocks even when tags are split across chunks', () => {
    const reply = 'Reading now.\n<function_calls>\n<invoke name="read_file">\n<parameter name="path">a.ts</parameter>\n</invoke>\n</function_calls>';
    for (const size of [1, 3, 7]) {
      const { visible, started } = stream(reply, size);
      assert.equal(visible, 'Reading now.\n');
      assert.deepEqual(started, ['read_file']);
    }
    assert.equal(stream('Plain answer with a < sign and <b>bold</b>.', 4).visible, 'Plain answer with a < sign and <b>bold</b>.');
  });

  it('renders a transcript that round-trips tool calls and results', () => {
    const transcript = renderTranscript([
      { role: 'user', content: [{ type: 'text', text: 'fix it' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Looking' }, { type: 'tool_call', id: 'c1', name: 'read_file', input: { path: 'a.ts', start_line: 2 } }] },
      { role: 'user', content: [{ type: 'tool_result', toolCallId: 'c1', content: '1| code', isError: false }] },
    ]);
    assert.match(
      transcript,
      /<assistant_turn>\nLooking\n\n<function_calls>\n<invoke name="read_file">\n<parameter name="path">a\.ts<\/parameter>\n<parameter name="start_line">2<\/parameter>\n<\/invoke>\n<\/function_calls>\n<\/assistant_turn>/,
    );
    assert.match(transcript, /Latest message:\n\n<function_results>\n<result>\n<tool_name>read_file<\/tool_name>\n<stdout>\n1\| code\n<\/stdout>\n<\/result>\n<\/function_results>$/);
  });
});
