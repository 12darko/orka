import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { AcpAgentSession, writeInsideWorkspace } from '../src/acp/AcpAgentSession';
import type { AcpClient, AcpSessionHandlers } from '../src/acp/AcpClient';
import { ChangeTracker } from '../src/changes/ChangeTracker';
import { NodeHost } from '../src/host/NodeHost';
import { PermissionManager } from '../src/permissions/PermissionManager';
import { tempWorkspace } from './helpers';

describe("an agent's writes through fs/write_text_file", () => {
  let ws: ReturnType<typeof tempWorkspace>;
  let store: ReturnType<typeof tempWorkspace>;
  beforeEach(() => {
    ws = tempWorkspace();
    store = tempWorkspace();
  });
  afterEach(() => {
    ws.cleanup();
    store.cleanup();
  });

  /** Make a link, or report that this system cannot. */
  const link = (target: string, at: string, type: 'dir' | 'file'): boolean => {
    try {
      symlinkSync(target, at, type === 'dir' && process.platform === 'win32' ? 'junction' : type);
      return true;
    } catch {
      return false;
    }
  };

  it('checks the path after recording the original, right before writing: a folder swapped for a link meanwhile is refused', async (t) => {
    mkdirSync(path.join(ws.root, 'docs'));
    writeFileSync(path.join(ws.root, 'docs', 'n.md'), 'old\n');
    const host = new NodeHost({ workspaceRoot: ws.root, approve: async () => ({ approved: true }) });
    let handlers!: AcpSessionHandlers;
    let answer = '';
    const client = {
      newSession: async (_cwd: string, h: AcpSessionHandlers) => {
        handlers = h;
        return 's1';
      },
      prompt: async () => {
        answer = await handlers.writeTextFile({ sessionId: 's1', path: path.join(ws.root, 'docs', 'n.md'), content: 'payload\n' }).then(
          () => 'written',
          (error: Error) => error.message,
        );
        return 'end_turn';
      },
      forgetSession: () => {},
      close: () => {},
    } as unknown as AcpClient;
    let n = 0;
    const session = new AcpAgentSession(client, {
      host,
      permissions: new PermissionManager('balanced'),
      changes: new ChangeTracker(host),
      emit: () => {},
      setPlan: () => {},
      nextId: (prefix) => `${prefix}${++n}`,
      afterEdit: async () => '',
      secretFile: () => undefined,
      noteSecret: () => {},
      label: 'Fake Agent',
      commandTimeoutMs: 30_000,
    });
    await session.start();
    let swapped = false;
    // While the original is recorded (git runs for a while), the agent's own shell swaps the folder for a link outside the workspace.
    await session.prompt([{ type: 'text', text: 'write' }], new AbortController().signal, {
      recordBefore: async () => {
        renameSync(path.join(ws.root, 'docs'), path.join(ws.root, 'docs-real'));
        swapped = link(store.root, path.join(ws.root, 'docs'), 'dir');
      },
    });
    if (!swapped) return t.skip('links cannot be made here');
    assert.match(answer, /only lets agents use files inside the workspace/);
    assert.equal(existsSync(path.join(store.root, 'n.md')), false);
  });

  it('never writes through a link, also one that appears after the last check', (t) => {
    writeFileSync(path.join(store.root, '.bashrc'), 'mine\n');
    if (!link(store.root, path.join(ws.root, 'docs'), 'dir')) return t.skip('links cannot be made here');
    assert.equal(writeInsideWorkspace(ws.root, path.join(ws.root, 'docs', '.bashrc'), 'payload\n'), false, 'a folder of the path is a link');
    assert.equal(readFileSync(path.join(store.root, '.bashrc'), 'utf8'), 'mine\n');
    // Refused before opening: not even an empty file appears where the link leads.
    assert.equal(writeInsideWorkspace(ws.root, path.join(ws.root, 'docs', 'new.txt'), 'payload\n'), false);
    assert.equal(existsSync(path.join(store.root, 'new.txt')), false);
    if (link(path.join(store.root, '.bashrc'), path.join(ws.root, 'notes.md'), 'file')) {
      assert.equal(writeInsideWorkspace(ws.root, path.join(ws.root, 'notes.md'), 'payload\n'), false, 'the file is a link out of the workspace');
      assert.equal(readFileSync(path.join(store.root, '.bashrc'), 'utf8'), 'mine\n');
      // A link that stays inside the workspace is written through to its target.
      writeFileSync(path.join(ws.root, 'AGENTS.md'), 'rules\n');
      symlinkSync('AGENTS.md', path.join(ws.root, 'GEMINI.md'), 'file');
      assert.equal(writeInsideWorkspace(ws.root, path.join(ws.root, 'GEMINI.md'), 'new rules\n'), true);
      assert.equal(readFileSync(path.join(ws.root, 'AGENTS.md'), 'utf8'), 'new rules\n');
    }
    // A plain file is written whole, also over longer content.
    mkdirSync(path.join(ws.root, 'src'));
    writeFileSync(path.join(ws.root, 'src', 'a.ts'), 'a much longer original\n');
    assert.equal(writeInsideWorkspace(ws.root, path.join(ws.root, 'src', 'a.ts'), 'short\n'), true);
    assert.equal(readFileSync(path.join(ws.root, 'src', 'a.ts'), 'utf8'), 'short\n');
    assert.equal(writeInsideWorkspace(ws.root, path.join(ws.root, 'src', 'new.ts'), 'new\n'), true);
    assert.equal(readFileSync(path.join(ws.root, 'src', 'new.ts'), 'utf8'), 'new\n');
  });
});
