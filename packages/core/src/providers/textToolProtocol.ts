/**
 * Tool calling for models we can only reach as plain text (local CLIs such as Claude Code in
 * print mode). Tools are described in the system prompt; the model writes function_calls blocks
 * and results come back as function_results blocks. This is the XML style Claude models know
 * best, so they follow it far more reliably than an invented format.
 *
 * String parameters are written raw (no JSON escaping), which keeps large file contents intact.
 * The older <tool_call>/<param> spelling is still accepted when parsing.
 */
import type { ChatMessage, ImageBlock, JsonSchema, ToolCallBlock, ToolSpec } from '../types';

/** Opening tag of one call: <invoke name="x"> (or legacy <tool_call name="x">). */
const CALL_OPEN_RE = /<(invoke|tool_call)\s+name\s*=\s*["']([^"']*)["']\s*>/g;
/** Traces of an attempted call; used to notice a call the parser could not read. */
const ATTEMPT_RE = /<\/?(function_calls|invoke|tool_call)\b|<parameter\s+name\s*=/;
/** Wrapper tags that carry no content of their own. */
const WRAPPER_RE = /<\/?function_calls>/g;
/** The model must never write results itself; anything from here on is a hallucination. */
const RESULTS_RE = /<(function_results|function_result|tool_result)\b/;

const CLOSE_TAG: Record<string, string> = { invoke: '</invoke>', tool_call: '</tool_call>' };
const PARAM_CLOSE: Record<string, string> = { invoke: '</parameter>', tool_call: '</param>' };

export function renderToolInstructions(tools: ToolSpec[]): string {
  const docs = tools.map(renderToolDoc).join('\n\n');
  return `# Tool use
You act through tools. To call tools, write a function_calls block:

<function_calls>
<invoke name="TOOL_NAME">
<parameter name="PARAM_NAME">value</parameter>
</invoke>
</function_calls>

Rules:
- String values are written raw: no quotes, no escaping. File contents go in exactly as they should be written, including newlines.
- Numbers, booleans, arrays and objects are written as JSON.
- Leave out optional parameters you don't need.
- One function_calls block may contain several invoke elements; they run in order.
- After the function_calls block, END YOUR MESSAGE. The environment runs the tools and sends you the output in a function_results block in the next message. You do not know the output until then: never write function_results yourself and never guess or invent tool output.
- When you are finished and need no more tools, reply without a function_calls block.

# Available tools
${docs}`;
}

function renderToolDoc(tool: ToolSpec): string {
  const props = tool.inputSchema.properties ?? {};
  const required = new Set(tool.inputSchema.required ?? []);
  const params = Object.entries(props).map(
    ([name, schema]) =>
      `- ${name} (${describeType(schema)}, ${required.has(name) ? 'required' : 'optional'})${schema.description ? `: ${schema.description}` : ''}`,
  );
  return `## ${tool.name}\n${tool.description}\nParameters:\n${params.length ? params.join('\n') : '- (none)'}`;
}

function describeType(schema: JsonSchema): string {
  const type = Array.isArray(schema.type) ? schema.type.join(' | ') : schema.type ?? 'any';
  if (schema.enum) return `${type}, one of ${schema.enum.map((v) => JSON.stringify(v)).join(' / ')}`;
  if (type === 'array' && schema.items) {
    if (schema.items.type === 'object' && schema.items.properties) {
      const fields = Object.entries(schema.items.properties)
        .map(([k, v]) => `${k}: ${describeType(v)}`)
        .join('; ');
      return `JSON array of objects {${fields}}`;
    }
    return `JSON array of ${describeType(schema.items)}`;
  }
  if (type === 'object') return 'JSON object';
  return type;
}

export interface ParsedReply {
  /** Prose the user should see: the reply without call blocks (and without anything invented after them). */
  text: string;
  calls: ToolCallBlock[];
}

/** Extract tool calls from a complete reply. */
export function parseToolCalls(reply: string, tools: ToolSpec[], makeId: () => string): ParsedReply {
  const schemas = new Map(tools.map((t) => [t.name, t.inputSchema]));
  const results = RESULTS_RE.exec(reply);
  const source = results ? reply.slice(0, results.index) : reply;
  const calls: ToolCallBlock[] = [];
  let text = '';
  let cursor = 0;
  CALL_OPEN_RE.lastIndex = 0;
  for (let open = CALL_OPEN_RE.exec(source); open; open = CALL_OPEN_RE.exec(source)) {
    if (open.index < cursor) continue;
    // Prose after the first call is usually the model narrating an imagined result; keep only prose before it.
    if (!calls.length) text += source.slice(cursor, open.index);
    const kind = open[1];
    const bodyStart = open.index + open[0].length;
    const close = findCallClose(source, bodyStart, kind);
    const body = source.slice(bodyStart, close === -1 ? source.length : close);
    calls.push({ type: 'tool_call', id: makeId(), name: open[2].trim(), input: parseParams(body, kind, schemas.get(open[2].trim())) });
    cursor = close === -1 ? source.length : close + CLOSE_TAG[kind].length;
    CALL_OPEN_RE.lastIndex = cursor;
  }
  if (!calls.length) text += source.slice(cursor);
  return { text: tidy(text), calls };
}

/**
 * The reply looks like it tried to call a tool, but no call could be parsed (e.g. a missing
 * closing tag or a made-up format). Returns the offset where the attempt starts, or -1.
 */
export function findUnparsedCallAttempt(reply: string, parsed: ParsedReply): number {
  if (parsed.calls.length) return -1;
  const results = RESULTS_RE.exec(reply);
  const source = results ? reply.slice(0, results.index) : reply;
  const match = ATTEMPT_RE.exec(source);
  return match ? match.index : -1;
}

/** Sent to the model when its call could not be parsed; its next reply replaces the broken one. */
export function repairRequest(): string {
  return `[Environment] Your last message tried to call a tool, but the call could not be read, so nothing was executed. Write the tool call again using exactly this format, and nothing after it:

<function_calls>
<invoke name="TOOL_NAME">
<parameter name="PARAM_NAME">value</parameter>
</invoke>
</function_calls>

Every <invoke> needs its closing </invoke>, every <parameter> its closing </parameter>. If you did not mean to call a tool, repeat your answer without any of these tags.`;
}

function tidy(text: string): string {
  return text.replace(WRAPPER_RE, '').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * The closing tag that ends a call. It counts only when nothing but whitespace separates it from
 * the last parameter close (or from the opening tag), so the same text inside a raw parameter
 * value does not end the call early.
 */
function findCallClose(source: string, from: number, kind: string): number {
  const closeTag = CLOSE_TAG[kind];
  const paramClose = PARAM_CLOSE[kind];
  for (let index = source.indexOf(closeTag, from); index !== -1; index = source.indexOf(closeTag, index + 1)) {
    const before = source.slice(from, index).trimEnd();
    if (before === '' || before.endsWith(paramClose)) return index;
  }
  return -1;
}

/** Sequential scan: a value ends at the first parameter close followed by another parameter or the end. */
function parseParams(body: string, kind: string, schema: JsonSchema | undefined): Record<string, unknown> {
  const tag = kind === 'invoke' ? 'parameter' : 'param';
  const opener = new RegExp(`\\s*<${tag}\\s+name\\s*=\\s*["']([^"']+)["']\\s*>`, 'y');
  const closer = new RegExp(`</${tag}>(?=\\s*(?:<${tag}\\s+name\\s*=\\s*["'][^"']+["']\\s*>|$))`, 'g');
  const input: Record<string, unknown> = {};
  let pos = 0;
  for (;;) {
    opener.lastIndex = pos;
    const open = opener.exec(body);
    if (!open) break;
    const valueStart = opener.lastIndex;
    closer.lastIndex = valueStart;
    const close = closer.exec(body);
    const end = close ? close.index : body.length;
    const name = open[1].trim();
    input[name] = coerce(stripOneNewline(body.slice(valueStart, end)), schema?.properties?.[name]);
    if (!close) break;
    pos = end + tag.length + 3;
  }
  return input;
}

function stripOneNewline(value: string): string {
  let out = value;
  if (out.startsWith('\r\n')) out = out.slice(2);
  else if (out.startsWith('\n')) out = out.slice(1);
  if (out.endsWith('\r\n')) out = out.slice(0, -2);
  else if (out.endsWith('\n')) out = out.slice(0, -1);
  return out;
}

function coerce(raw: string, schema: JsonSchema | undefined): unknown {
  const types = schema?.type ? (Array.isArray(schema.type) ? schema.type : [schema.type]) : [];
  if (!types.length || types.includes('string')) return raw;
  const trimmed = raw.trim();
  if (types.includes('boolean') && /^(true|false)$/i.test(trimmed)) return trimmed.toLowerCase() === 'true';
  if ((types.includes('integer') || types.includes('number')) && /^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  try {
    return JSON.parse(trimmed);
  } catch {
    return raw; // schema validation reports the type error to the model
  }
}

const STREAM_MARKERS = ['<function_calls>', '</function_calls>', '<invoke', '<tool_call', '<function_result', '<tool_result'];

/**
 * Streaming filter: forwards prose and hides call blocks while they stream, so the UI shows only
 * what the parser will keep. Handles tags split across chunks.
 */
export class ToolCallStreamFilter {
  private buffer = '';
  /** Kind of the call currently streaming ("invoke" / "tool_call"), if any. */
  private inCall?: string;
  private callTail = '';
  private sawCall = false;
  private done = false;

  constructor(
    private readonly onText: (text: string) => void,
    private readonly onCallStart: (name: string) => void,
  ) {}

  push(chunk: string): void {
    if (this.done) return;
    this.buffer += chunk;
    for (;;) {
      if (this.inCall) {
        const close = this.structuralClose(this.inCall);
        if (close === -1) {
          const keepFrom = Math.max(0, this.buffer.length - CLOSE_TAG[this.inCall].length);
          this.callTail = (this.callTail + this.buffer.slice(0, keepFrom)).slice(-64);
          this.buffer = this.buffer.slice(keepFrom);
          return;
        }
        this.buffer = this.buffer.slice(close + CLOSE_TAG[this.inCall].length);
        this.inCall = undefined;
        this.callTail = '';
        continue;
      }
      const marker = this.nextMarker();
      if (!marker) {
        const keep = partialMarkerLength(this.buffer);
        this.emit(this.buffer.slice(0, this.buffer.length - keep));
        this.buffer = this.buffer.slice(this.buffer.length - keep);
        return;
      }
      this.emit(this.buffer.slice(0, marker.index));
      const rest = this.buffer.slice(marker.index);
      if (marker.tag === '<function_result' || marker.tag === '<tool_result') {
        this.done = true; // invented results: hide everything that follows
        this.buffer = '';
        return;
      }
      if (marker.tag === '<function_calls>' || marker.tag === '</function_calls>') {
        if (marker.tag === '<function_calls>') this.sawCall = true;
        this.buffer = rest.slice(marker.tag.length);
        continue;
      }
      const open = /^<(invoke|tool_call)\s+name\s*=\s*["']([^"']*)["']\s*>/.exec(rest);
      if (!open) {
        if (!rest.includes('>')) {
          this.buffer = rest; // header still streaming
          return;
        }
        this.emit(rest.slice(0, 1)); // a lookalike, not a call: show it
        this.buffer = rest.slice(1);
        continue;
      }
      this.onCallStart(open[2]);
      this.sawCall = true;
      this.inCall = open[1];
      this.buffer = rest.slice(open[0].length);
    }
  }

  flush(): void {
    if (!this.inCall && !this.done) this.emit(this.buffer);
    this.buffer = '';
  }

  private emit(text: string): void {
    // Prose after the first call is dropped by the parser, so don't show it while streaming either.
    if (text && !this.sawCall) this.onText(text);
  }

  private nextMarker(): { index: number; tag: string } | undefined {
    let best: { index: number; tag: string } | undefined;
    for (const tag of STREAM_MARKERS) {
      const index = this.buffer.indexOf(tag);
      if (index !== -1 && (!best || index < best.index)) best = { index, tag };
    }
    return best;
  }

  private structuralClose(kind: string): number {
    const closeTag = CLOSE_TAG[kind];
    for (let from = 0; ; ) {
      const close = this.buffer.indexOf(closeTag, from);
      if (close === -1) return -1;
      const before = (this.callTail + this.buffer.slice(0, close)).trimEnd();
      if (before === '' || before.endsWith(PARAM_CLOSE[kind])) return close;
      from = close + 1;
    }
  }
}

/** Length of a trailing fragment that could be the start of a marker. */
function partialMarkerLength(text: string): number {
  let longest = 0;
  for (const tag of STREAM_MARKERS) {
    for (let len = Math.min(tag.length - 1, text.length); len > longest; len--) {
      if (tag.startsWith(text.slice(text.length - len))) {
        longest = len;
        break;
      }
    }
  }
  return longest;
}

/** Render a user turn (tool results and/or text) for a text-only model. */
export function renderUserTurn(message: Extract<ChatMessage, { role: 'user' }>, toolNames: Map<string, string>): string {
  const results: string[] = [];
  const texts: string[] = [];
  for (const block of message.content) {
    if (block.type === 'tool_result') {
      const name = toolNames.get(block.toolCallId) ?? 'tool';
      const tag = block.isError ? 'error' : 'stdout';
      const attached = block.images?.length ? `\n[${block.images.length} image(s) attached below]` : '';
      results.push(`<result>\n<tool_name>${name}</tool_name>\n<${tag}>\n${block.content}${attached}\n</${tag}>\n</result>`);
    } else if (block.type === 'image') {
      // The image itself travels as a separate content block (see userImages).
      texts.push('[image attached]');
    } else if (block.text) {
      texts.push(block.text);
    }
  }
  const parts = results.length ? [`<function_results>\n${results.join('\n')}\n</function_results>`, ...texts] : texts;
  return parts.join('\n\n') || '(empty message)';
}

/** Images of user turns, to send next to their text. */
export function userImages(messages: readonly ChatMessage[]): ImageBlock[] {
  return messages.flatMap((m) =>
    m.role === 'user' ? m.content.flatMap((b) => (b.type === 'image' ? [b] : b.type === 'tool_result' ? (b.images ?? []) : [])) : [],
  );
}

/** Render an assistant turn back into protocol form (used when replaying a whole transcript). */
export function renderAssistantTurn(message: Extract<ChatMessage, { role: 'assistant' }>): string {
  const prose = message.content
    .filter((b) => b.type === 'text' && b.text)
    .map((b) => (b as { text: string }).text)
    .join('\n\n');
  const invokes = message.content
    .filter((b): b is ToolCallBlock => b.type === 'tool_call')
    .map((b) => {
      const params = Object.entries(b.input)
        .map(([k, v]) => `<parameter name="${k}">${typeof v === 'string' ? v : JSON.stringify(v)}</parameter>`)
        .join('\n');
      return `<invoke name="${b.name}">\n${params}\n</invoke>`;
    });
  const calls = invokes.length ? `<function_calls>\n${invokes.join('\n')}\n</function_calls>` : '';
  return [prose, calls].filter(Boolean).join('\n\n') || '(no content)';
}

export function toolNameIndex(messages: readonly ChatMessage[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    for (const b of m.content) if (b.type === 'tool_call') names.set(b.id, b.name);
  }
  return names;
}

/**
 * A whole conversation as one prompt, for starting a fresh text-only session mid-task (e.g. after
 * switching provider). The last user turn is the message to answer.
 */
export function renderTranscript(messages: readonly ChatMessage[]): string {
  const names = toolNameIndex(messages);
  if (messages.length === 1 && messages[0].role === 'user') return renderUserTurn(messages[0], names);
  const history = messages.slice(0, -1).map((m) =>
    m.role === 'user' ? `<user_turn>\n${renderUserTurn(m, names)}\n</user_turn>` : `<assistant_turn>\n${renderAssistantTurn(m)}\n</assistant_turn>`,
  );
  const last = messages[messages.length - 1];
  const current = last.role === 'user' ? renderUserTurn(last, names) : renderAssistantTurn(last);
  return `The conversation so far (your earlier turns are marked assistant_turn):\n\n${history.join('\n\n')}\n\nContinue from here. Latest message:\n\n${current}`;
}
