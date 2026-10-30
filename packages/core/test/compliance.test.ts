import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { safeEnv } from '../src/acp/AcpClient';
import { AGENT_CLIS, customAgentEntry } from '../src/acp/catalog';
import { AGENT_POLICIES, agentPolicy, NOT_IN_CATALOG } from '../src/acp/policy';
import { TR } from '../src/i18n/tr';

const CORE_ROOT = path.resolve(__dirname, '../..');
/** Where Orka talks to third-party agents. */
const AGENT_SOURCES = [path.join(CORE_ROOT, 'src', 'acp'), path.join(CORE_ROOT, 'src', 'rpc')];

describe('third-party agents: compliance rules', () => {
  it('every catalog entry, and a custom agent, has a policy row', () => {
    for (const entry of [...AGENT_CLIS, customAgentEntry({ name: 'mine', command: 'my-agent' })]) {
      assert.ok(agentPolicy(entry.policy), `${entry.id} has no policy row "${entry.policy}"`);
    }
    assert.deepEqual(
      AGENT_CLIS.map((a) => a.id),
      ['gemini', 'codex', 'copilot', 'cursor'],
    );
  });

  it('leaves out the agents whose terms or licence do not allow it', () => {
    for (const { id } of NOT_IN_CATALOG) assert.ok(!AGENT_CLIS.some((a) => a.id === id || a.bin.includes(id)), `${id} must not be in the catalog`);
    for (const entry of AGENT_CLIS) assert.doesNotMatch(`${entry.id} ${entry.bin} ${entry.label}`, /antigravity|claude/i);
  });

  it('never turns on an agent\'s "approve everything" mode, and starts only what the user installed', () => {
    for (const entry of AGENT_CLIS) {
      assert.doesNotMatch(entry.acpArgs.join(' '), /yolo|bypass|dangerous|skip-permission|auto-?approve|allow-all|--force|-y\b/i, entry.id);
      assert.doesNotMatch(entry.bin, /^(npx|pnpm|bunx|yarn|uvx|pipx)$/i, `${entry.id} must start an installed program, not a download`);
    }
  });

  it('the agent code never touches vendor credential files or downloads agents', () => {
    const files = AGENT_SOURCES.flatMap(walk).filter((f) => f.endsWith('.ts'));
    assert.ok(files.length >= 8, `found ${files.length} files`);
    const forbidden = [/\.credentials\.json/i, /oauth_creds/i, /auth\.json/i, /hosts\.yml/i, /npx\s+(-y|--yes)\b/i, /\.codex[\\/]/i, /\.gemini[\\/]/i, /\.copilot[\\/]/i, /\.cursor[\\/]/i];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const pattern of forbidden) assert.doesNotMatch(source, pattern, `${path.relative(CORE_ROOT, file)} mentions ${pattern}`);
    }
  });

  it('extra environment for an agent never carries credentials', () => {
    const env = safeEnv({ GEMINI_API_KEY: 'k', COPILOT_GITHUB_TOKEN: 't', CURSOR_AUTH_TOKEN: 'a', OPENAI_API_KEY: 'o', AWS_SECRET_ACCESS_KEY: 's', NO_BROWSER: '1' });
    assert.deepEqual(env, { NO_BROWSER: '1' });
  });

  it('policy notes and exclusion reasons are translated, and only listed sign-in methods may be sent', () => {
    for (const policy of AGENT_POLICIES) {
      assert.ok(TR[policy.note], `missing Turkish translation for the ${policy.id} note`);
      if (policy.id !== 'custom') assert.match(policy.termsUrl, /^https:\/\//, `${policy.id} links its terms`);
      assert.ok(policy.allowedAuth.length > 0);
    }
    for (const { reason } of NOT_IN_CATALOG) assert.ok(TR[reason], `missing Turkish translation for: ${reason}`);
    // Sign-in happens in the vendor's own login; Orka sends ACP authenticate only for methods listed here.
    assert.deepEqual(AGENT_POLICIES.filter((p) => p.acpAuthMethods.length).map((p) => [p.id, p.acpAuthMethods]), [['cursor', ['cursor_login']]]);
  });
});

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}
