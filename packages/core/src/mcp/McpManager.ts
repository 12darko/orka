import { t } from '../i18n';
import type { Tool } from '../tools/Tool';
import { ToolError } from '../tools/Tool';
import type { JsonSchema } from '../types';
import { McpClient, type McpServerConfig, type McpState, type McpToolInfo } from './McpClient';

export interface McpServerStatus {
  name: string;
  state: McpState;
  tools: number;
  error?: string;
  disabled?: boolean;
}

/** Tool names must fit every provider (letters, digits, _ and -, at most 64 characters). */
export function mcpToolName(server: string, tool: string): string {
  const clean = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '_');
  return `mcp__${clean(server)}__${clean(tool)}`.slice(0, 64);
}

/**
 * Keeps one client per configured MCP server alive across tasks, restarts a server when its
 * configuration changes, and exposes all their tools as agent tools.
 */
export class McpManager {
  private readonly clients = new Map<string, { client: McpClient; key: string }>();
  private configs: Record<string, McpServerConfig> = {};

  constructor(private readonly onChange: () => void = () => {}) {}

  /** Apply the current configuration: removed or changed servers are stopped (started again on demand). */
  sync(configs: Record<string, McpServerConfig>): void {
    this.configs = configs;
    for (const [name, entry] of this.clients) {
      const config = configs[name];
      if (!config || config.disabled || JSON.stringify(config) !== entry.key) {
        entry.client.close();
        this.clients.delete(name);
      }
    }
    this.onChange();
  }

  /** Start every enabled server (in parallel) and return their tools. Servers that fail are skipped. */
  async tools(): Promise<Tool[]> {
    const names = Object.keys(this.configs).filter((n) => !this.configs[n].disabled);
    await Promise.all(names.map((name) => this.client(name).start().catch(() => undefined)));
    this.onChange();
    const tools: Tool[] = [];
    const used = new Set<string>();
    for (const name of names) {
      const client = this.clients.get(name)?.client;
      if (client?.state !== 'ready') continue;
      for (const info of client.tools) {
        const toolName = mcpToolName(name, info.name);
        if (used.has(toolName)) continue;
        used.add(toolName);
        tools.push(this.wrap(name, toolName, info));
      }
    }
    return tools;
  }

  status(): McpServerStatus[] {
    return Object.entries(this.configs).map(([name, config]) => {
      const client = this.clients.get(name)?.client;
      return {
        name,
        state: config.disabled ? 'idle' : (client?.state ?? 'idle'),
        tools: client?.state === 'ready' ? client.tools.length : 0,
        error: client?.error,
        disabled: config.disabled,
      };
    });
  }

  /** Stop everything; servers start again on the next task. */
  restart(): void {
    for (const { client } of this.clients.values()) client.close();
    this.clients.clear();
    this.onChange();
  }

  dispose(): void {
    for (const { client } of this.clients.values()) client.close();
    this.clients.clear();
  }

  private client(name: string): McpClient {
    const existing = this.clients.get(name);
    if (existing && existing.client.state !== 'error' && existing.client.state !== 'closed') return existing.client;
    existing?.client.close();
    const config = this.configs[name];
    const client = new McpClient(name, config);
    this.clients.set(name, { client, key: JSON.stringify(config) });
    return client;
  }

  private wrap(server: string, toolName: string, info: McpToolInfo): Tool<Record<string, unknown>> {
    const readOnly = info.annotations?.readOnlyHint === true;
    const destructive = info.annotations?.destructiveHint === true && !readOnly;
    const schema: JsonSchema = info.inputSchema && typeof info.inputSchema === 'object' ? { type: 'object', ...info.inputSchema } : { type: 'object', properties: {} };
    return {
      name: toolName,
      readOnly,
      description: `[MCP server "${server}"] ${info.description?.trim() || info.annotations?.title || info.name}`,
      inputSchema: schema,
      describe: (input) => ({
        // MCP tools act outside the workspace (an editor, a database, ...): treat them like commands
        // unless the server marks them read-only.
        category: readOnly ? 'read' : 'command',
        risk: readOnly ? 'safe' : destructive ? 'dangerous' : 'normal',
        title: t('MCP {server}: {tool}', { server, tool: info.annotations?.title || info.name }),
        detail: `${server} / ${info.name}\n${JSON.stringify(input, null, 2).slice(0, 2000)}`,
      }),
      execute: async (input, ctx) => {
        const client = this.clients.get(server)?.client;
        if (!client) throw new ToolError(`The MCP server "${server}" is not running any more.`);
        try {
          return await client.callTool(info.name, input, ctx.signal, Math.max(ctx.commandTimeoutMs, 60_000));
        } catch (error) {
          if (ctx.signal.aborted) throw error;
          throw new ToolError(`MCP server "${server}" failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
    };
  }
}
