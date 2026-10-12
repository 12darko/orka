import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { ChangeTracker } from '../src/changes/ChangeTracker';
import { NodeHost } from '../src/host/NodeHost';
import { codeOutlineTool, outlineText } from '../src/tools/OutlineTools';
import { processOutputTool, startProcessTool, stopProcessTool } from '../src/tools/ProcessTools';
import type { ToolContext } from '../src/tools/Tool';
import { tempWorkspace } from './helpers';

const CS = `using UnityEngine;

namespace Game.Net
{
    [RequireComponent(typeof(NetworkObject))]
    public sealed class LobbyManager : NetworkBehaviour
    {
        public const int MaxPlayers = 4;

        public override void Spawned()
        {
            if (Ready.Count > 0) return;
        }

        private bool IsReady(PlayerRef player) => Ready.Get(player);

        public async Task<bool> JoinAsync(string code, int retries = 3)
        {
            foreach (var p in players) { }
            return true;
        }
    }

    public enum LobbyState { Waiting, Ready }
}
`;

const TS = `export interface Cart { items: Item[] }
export class CartService {
  private total = 0;
  add(item: Item): void {
    this.total += item.price;
  }
}
export async function checkout(cart: Cart, coupon?: string) {
  return 1;
}
export const applyCoupon = (cart: Cart) => cart;
`;

describe('code_outline', () => {
  it('lists declarations with line numbers for C# and TypeScript', () => {
    const cs = outlineText('LobbyManager.cs', CS)!;
    assert.deepEqual(
      cs.map((l) => l.trim().replace(/\s+/g, ' ')),
      ['6 class LobbyManager', '10 Spawned()', '15 IsReady(PlayerRef player)', '17 JoinAsync(string code, int retries = 3)', '24 enum LobbyState'],
    );
    const ts = outlineText('cart.ts', TS)!.map((l) => l.trim().replace(/\s+/g, ' '));
    assert.deepEqual(ts, ['1 interface Cart', '2 class CartService', '4 add(item: Item)', '8 function checkout(cart: Cart, coupon?: string)', '11 const applyCoupon = () =>']);
    assert.equal(outlineText('notes.md', '# hi'), undefined);
  });

  describe('as a tool', () => {
    let ws: ReturnType<typeof tempWorkspace>;
    beforeEach(() => (ws = tempWorkspace()));
    afterEach(() => ws.cleanup());

    it('outlines a whole folder, skipping ignored directories', async () => {
      mkdirSync(path.join(ws.root, 'Assets', 'Scripts'), { recursive: true });
      mkdirSync(path.join(ws.root, 'Library'), { recursive: true });
      writeFileSync(path.join(ws.root, 'Assets', 'Scripts', 'LobbyManager.cs'), CS);
      writeFileSync(path.join(ws.root, 'Library', 'Generated.cs'), 'public class Generated {}');
      const host = new NodeHost({ workspaceRoot: ws.root });
      const ctx: ToolContext = { callId: 'c', host, changes: new ChangeTracker(host), signal: new AbortController().signal, commandTimeoutMs: 10_000, plan: undefined, setPlan: () => {}, onOutput: () => {} };
      const result = await codeOutlineTool.execute({ path: '.' }, ctx);
      assert.match(result.content, /^Assets\/Scripts\/LobbyManager\.cs\n\s+6\s+class LobbyManager/);
      assert.doesNotMatch(result.content, /Generated/);
    });
  });
});

describe('background processes', () => {
  let ws: ReturnType<typeof tempWorkspace>;
  let host: NodeHost;
  beforeEach(() => {
    ws = tempWorkspace();
    host = new NodeHost({ workspaceRoot: ws.root });
  });
  afterEach(() => {
    host.stopAllProcesses();
    ws.cleanup();
  });
  const ctx = (): ToolContext => ({ callId: 'c', host, changes: new ChangeTracker(host), signal: new AbortController().signal, commandTimeoutMs: 10_000, plan: undefined, setPlan: () => {}, onOutput: () => {} });

  it('starts a server, waits until it is ready, reads its output and stops it', async () => {
    writeFileSync(path.join(ws.root, 'server.js'), "setTimeout(() => console.log('ready on http://localhost:5173'), 300); setInterval(() => console.log('tick'), 200);");
    const started = await startProcessTool.execute({ command: 'node server.js', name: 'dev', wait_for: 'ready on', wait_seconds: 60 }, ctx());
    assert.match(started.content, /^"dev" is running \(pid \d+, \d+s\) - it printed the ready pattern\.\nOutput so far:\n[\s\S]*ready on http:\/\/localhost:5173/);
    assert.ok(!started.isError);
    await assert.rejects(startProcessTool.execute({ command: 'node server.js', name: 'dev' }, ctx()), /already running/);
    const list = await processOutputTool.execute({}, ctx());
    assert.match(list.content, /- "dev" is running .*: node server\.js/);
    const output = await processOutputTool.execute({ name: 'dev', lines: 3 }, ctx());
    assert.match(output.content, /tick/);
    const stopped = await stopProcessTool.execute({ name: 'dev' }, ctx());
    assert.equal(stopped.content, 'Stopped "dev".');
    assert.equal(host.processes.size, 0);
  });

  it('reports a process that exits right away as an error', async () => {
    const result = await startProcessTool.execute({ command: 'node -e "process.exit(2)"', name: 'bad', wait_seconds: 10 }, ctx());
    assert.equal(result.isError, true);
    assert.match(result.content, /"bad" exited with code 2 - it stopped\./);
  });

  it('starting a background process is never auto-approved as read-only', async () => {
    const action = await startProcessTool.describe({ command: 'ls' }, ctx());
    assert.deepEqual([action.category, action.risk], ['command', 'normal']);
  });
});
