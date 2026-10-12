import type { ChangeTracker } from '../changes/ChangeTracker';
import type { ApprovalRequest, Host } from '../host/Host';
import type { PermissionCategory, RiskLevel } from '../permissions/PermissionManager';
import type { Plan } from '../planning/Plan';
import type { ImageBlock, JsonSchema, ToolSpec } from '../types';

export interface ToolContext {
  /** Id of the tool call being executed. */
  callId: string;
  host: Host;
  changes: ChangeTracker;
  signal: AbortSignal;
  commandTimeoutMs: number;
  /** Current plan (read) and a setter used by update_plan. */
  plan: Plan | undefined;
  setPlan(plan: Plan): void;
  /** Stream partial output (terminal commands) to the UI. */
  onOutput(chunk: string): void;
}

export interface ToolAction {
  category: PermissionCategory;
  risk: RiskLevel;
  /** Short label for the UI, e.g. "Edit src/app.ts". */
  title: string;
  /** Longer detail shown on approval cards (command line, reason for risk...). */
  detail?: string;
  preview?: ApprovalRequest['preview'];
}

export interface ToolResult {
  content: string;
  isError?: boolean;
  /** Images for the model (e.g. a screenshot). */
  images?: ImageBlock[];
  /** A small preview image (data URL) for the chat view. */
  thumb?: string;
}

export interface Tool<Input = any> {
  name: string;
  /** Changes nothing (MCP tools marked read-only); read-only sub-agents may use it. */
  readOnly?: boolean;
  description: string;
  inputSchema: JsonSchema;
  /** Describe the concrete action (and its risk) before it runs - drives permissions and UI. */
  describe(input: Input, ctx: ToolContext): Promise<ToolAction> | ToolAction;
  execute(input: Input, ctx: ToolContext): Promise<ToolResult>;
}

export class ToolError extends Error {}

export function toSpec(tool: Tool): ToolSpec {
  return { name: tool.name, description: tool.description, inputSchema: tool.inputSchema };
}

/**
 * Minimal JSON-schema check for tool inputs. Streamed tool inputs are not validated by the
 * API, so every input is checked here before a tool runs.
 */
export function validateInput(schema: JsonSchema, value: unknown, at = 'input'): string | undefined {
  const types = schema.type ? (Array.isArray(schema.type) ? schema.type : [schema.type]) : [];
  if (types.length && !types.some((t) => matchesType(t, value))) {
    return `${at} must be of type ${types.join(' | ')}`;
  }
  if (schema.enum && !schema.enum.includes(value)) {
    return `${at} must be one of ${schema.enum.map((v) => JSON.stringify(v)).join(', ')}`;
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) return `${at} must be >= ${schema.minimum}`;
    if (schema.maximum !== undefined && value > schema.maximum) return `${at} must be <= ${schema.maximum}`;
  }
  if (value && typeof value === 'object' && !Array.isArray(value) && schema.properties) {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (obj[key] === undefined || obj[key] === null) return `${at}.${key} is required`;
    }
    for (const [key, sub] of Object.entries(schema.properties)) {
      if (obj[key] === undefined || obj[key] === null) continue;
      const error = validateInput(sub, obj[key], `${at}.${key}`);
      if (error) return error;
    }
    if (schema.additionalProperties === false) {
      const extra = Object.keys(obj).find((k) => !(k in schema.properties!));
      if (extra) return `${at}.${extra} is not allowed`;
    }
  }
  if (Array.isArray(value) && schema.items) {
    for (let i = 0; i < value.length; i++) {
      const error = validateInput(schema.items, value[i], `${at}[${i}]`);
      if (error) return error;
    }
  }
  return undefined;
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return !!value && typeof value === 'object' && !Array.isArray(value);
    case 'null':
      return value === null;
    default:
      return true;
  }
}

/** Keep the head and tail of long output so errors at the end (build logs) stay visible. */
export function truncateMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.4);
  const tail = maxChars - head;
  const omitted = text.length - head - tail;
  return `${text.slice(0, head)}\n\n... [${omitted} characters omitted] ...\n\n${text.slice(text.length - tail)}`;
}
