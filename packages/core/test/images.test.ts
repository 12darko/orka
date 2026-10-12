import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { NodeHost } from '../src/host/NodeHost';
import { Orchestrator } from '../src/orchestrator/Orchestrator';
import { PermissionManager } from '../src/permissions/PermissionManager';
import { ClaudeCodeProvider } from '../src/providers/ClaudeCodeProvider';
import { toClaudeMessages } from '../src/providers/ClaudeProvider';
import { toGeminiContents } from '../src/providers/GeminiProvider';
import { toOpenAIMessages } from '../src/providers/OpenAIProvider';
import type { ChatMessage } from '../src/types';
import { applyEvent, emptySession } from '../src/ui/transcript';
import { ScriptedProvider, tempWorkspace, text } from './helpers';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const withImage: ChatMessage[] = [
  {
    role: 'user',
    content: [
      { type: 'text', text: 'What is wrong in this screenshot?' },
      { type: 'image', mediaType: 'image/png', data: PNG },
    ],
  },
];

describe('images', () => {
  it('every API provider sends attached images in its own format', () => {
    const claude = toClaudeMessages(withImage)[0].content as unknown as Array<Record<string, unknown>>;
    assert.deepEqual(claude[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } });

    const openai = toOpenAIMessages("SYS", withImage)[1] as unknown as { role: string; content: Array<Record<string, unknown>> };
    assert.deepEqual(openai.content, [
      { type: 'text', text: 'What is wrong in this screenshot?' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } },
    ]);

    const gemini = toGeminiContents(withImage)[0].parts!;
    assert.deepEqual(gemini[1], { inlineData: { mimeType: 'image/png', data: PNG } });
  });

  describe('with the agent', () => {
    let ws: ReturnType<typeof tempWorkspace>;
    beforeEach(() => (ws = tempWorkspace()));
    afterEach(() => ws.cleanup());

    it('a request carries its images to the model; the chat shows their thumbnails', async () => {
      const main = new ScriptedProvider([
        (req) => {
          const blocks = req.messages[0].content;
          assert.equal(blocks[0].type, 'text');
          assert.deepEqual(blocks[1], { type: 'image', mediaType: 'image/png', data: PNG });
          return [text('The button is cut off.')];
        },
      ]);
      const orchestrator = new Orchestrator({
        host: new NodeHost({ workspaceRoot: ws.root }),
        getProvider: () => main,
        permissions: new PermissionManager('balanced'),
        getSettings: () => ({ maxIterations: 5, autoVerify: false, commandTimeoutMs: 10_000 }),
      });
      const session = emptySession();
      orchestrator.on((e) => applyEvent(session, e));
      await orchestrator.run('What is wrong here?', undefined, [], {
        images: [{ name: 'shot.png', mediaType: 'image/png', data: PNG, thumb: 'data:image/jpeg;base64,AAAA' }],
      });
      const user = session.items.find((i) => i.kind === 'user');
      assert.deepEqual(user && user.kind === 'user' ? user.images : undefined, [{ name: 'shot.png', thumb: 'data:image/jpeg;base64,AAAA' }]);
    });

    it('Claude Code receives text and image blocks in one stream-json message', async () => {
      const log = path.join(ws.root, 'cli.jsonl');
      process.env.FAKE_CC_SCRIPT = JSON.stringify(['I see a cut-off button.']);
      process.env.FAKE_CC_LOG = log;
      const provider = new ClaudeCodeProvider({
        executable: process.execPath,
        executableArgs: [path.resolve(__dirname, '../../test/fixtures/fake-claude.mjs')],
      });
      try {
        const response = await provider.chat({ system: 'SYS', messages: withImage, tools: [] }, () => {});
        assert.equal(response.stopReason, 'end_turn');
        assert.ok(existsSync(log));
        const sent = JSON.parse(readFileSync(log, 'utf8').trim().split('\n')[0]).text;
        assert.ok(Array.isArray(sent), 'content is a block array');
        assert.match(sent[0].text, /What is wrong in this screenshot\?\n\n\[image attached\]/);
        assert.deepEqual(sent[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } });
      } finally {
        provider.dispose();
      }
    });
  });
});
