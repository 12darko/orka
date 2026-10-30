/**
 * The part of the Agent Client Protocol (https://agentclientprotocol.com, protocol version 1)
 * that Orka uses as a client, written from the public spec and schema. Fields Orka does not read
 * are left out; agents may send more.
 */

export const ACP_PROTOCOL_VERSION = 1;

/** ACP error codes (JSON-RPC errors in the -32000 range). */
export const ACP_AUTH_REQUIRED = -32000;
export const ACP_RESOURCE_NOT_FOUND = -32002;

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data: string; uri?: string }
  | { type: 'resource_link'; uri: string; name: string; title?: string }
  | { type: 'resource'; resource: { uri: string; text?: string; mimeType?: string } };

export interface ClientCapabilities {
  fs: { readTextFile: boolean; writeTextFile: boolean };
  terminal: boolean;
}

export interface InitializeParams {
  protocolVersion: number;
  clientCapabilities: ClientCapabilities;
  clientInfo: { name: string; title?: string; version: string };
}

export interface AuthMethod {
  id: string;
  name: string;
  description?: string | null;
  /** "agent" (default): the agent signs in by itself. "terminal": the client must run it in a terminal. */
  type?: string;
}

export interface InitializeResult {
  protocolVersion: number;
  agentCapabilities?: {
    loadSession?: boolean;
    promptCapabilities?: { image?: boolean; audio?: boolean; embeddedContext?: boolean };
  };
  agentInfo?: { name: string; title?: string; version: string };
  authMethods?: AuthMethod[];
}

export type StopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled';

export type ToolKind = 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'switch_mode' | 'other';

export type ToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export type ToolCallContent =
  | { type: 'content'; content: ContentBlock }
  | { type: 'diff'; path: string; oldText?: string | null; newText: string }
  | { type: 'terminal'; terminalId: string };

export interface ToolCallLocation {
  /** Absolute path. */
  path: string;
  line?: number | null;
}

/** A tool_call, a tool_call_update and the toolCall of a permission request share these fields. */
export interface ToolCallFields {
  toolCallId: string;
  title?: string | null;
  kind?: ToolKind | null;
  status?: ToolCallStatus | null;
  content?: ToolCallContent[] | null;
  locations?: ToolCallLocation[] | null;
  rawInput?: unknown;
  rawOutput?: unknown;
}

export interface PlanEntry {
  content: string;
  priority?: 'high' | 'medium' | 'low';
  status: 'pending' | 'in_progress' | 'completed';
}

/** The `update` of a session/update notification; kinds Orka does not show are ignored. */
export type SessionUpdate =
  | { sessionUpdate: 'agent_message_chunk'; content: ContentBlock }
  | { sessionUpdate: 'agent_thought_chunk'; content: ContentBlock }
  | ({ sessionUpdate: 'tool_call' } & ToolCallFields)
  | ({ sessionUpdate: 'tool_call_update' } & ToolCallFields)
  | { sessionUpdate: 'plan'; entries: PlanEntry[] }
  | { sessionUpdate: 'user_message_chunk' | 'available_commands_update' | 'current_mode_update' | 'usage_update'; [field: string]: unknown };

export type PermissionOptionKind = 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: PermissionOptionKind;
}

export interface RequestPermissionParams {
  sessionId: string;
  toolCall: ToolCallFields;
  options: PermissionOption[];
}

export type PermissionOutcome = { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' };

export interface ReadTextFileParams {
  sessionId: string;
  path: string;
  /** 1-based first line. */
  line?: number | null;
  limit?: number | null;
}

export interface WriteTextFileParams {
  sessionId: string;
  path: string;
  content: string;
}

export interface CreateTerminalParams {
  sessionId: string;
  command: string;
  args?: string[];
  env?: Array<{ name: string; value: string }>;
  cwd?: string | null;
  outputByteLimit?: number | null;
}

export interface TerminalParams {
  sessionId: string;
  terminalId: string;
}

export interface TerminalExitStatus {
  exitCode: number | null;
  signal: string | null;
}

export interface TerminalOutputResult {
  output: string;
  truncated: boolean;
  exitStatus?: TerminalExitStatus | null;
}
