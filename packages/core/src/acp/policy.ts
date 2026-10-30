/**
 * The terms each vendor's agent is used under. Orka only drives the agent the user installed and
 * signed in to themselves, through the ACP mode the vendor documents for editors and other
 * clients. Rules for every agent, enforced in code:
 * - Orka never reads, stores or passes on the agent's sign-in (OAuth or subscription tokens, the
 *   vendor's credential files) and never sets credential environment variables for it (safeEnv).
 * - Orka starts only the unmodified program found on PATH or at the path the user set; it never
 *   downloads one (install commands are shown to the user, never run by Orka).
 * - Signing in happens in the vendor's own login command or app. Orka sends ACP `authenticate`
 *   only when the user asks, and only with a method listed in `acpAuthMethods` below.
 * - Orka never turns on an agent's "approve everything" mode; it answers each permission request
 *   once, with its own rules.
 */
export type AuthKind = 'vendor_login' | 'api_key' | 'cloud';

export interface AgentPolicy {
  id: string;
  vendor: string;
  /** How the user may sign in to the agent for use with Orka (always in the vendor's own flow). */
  allowedAuth: readonly AuthKind[];
  /** ACP authenticate method ids Orka may send when the user asks to sign in from Orka; [] = never. */
  acpAuthMethods: readonly string[];
  termsUrl: string;
  /** Shown with the agent (English key; the UI translates it with t()). */
  note: string;
  /** The vendor marks its ACP support as a preview. */
  preview?: boolean;
}

export const AGENT_POLICIES: readonly AgentPolicy[] = [
  {
    id: 'google',
    vendor: 'Google',
    allowedAuth: ['vendor_login', 'api_key', 'cloud'],
    acpAuthMethods: [],
    termsUrl: 'https://geminicli.com/docs/resources/tos-privacy/',
    note: "Runs your installed Gemini CLI in its ACP mode. Orka never uses Gemini CLI's sign-in itself: Google's terms forbid other software from using it. Google moved unpaid and Google One accounts from Gemini CLI to Antigravity.",
  },
  {
    id: 'openai',
    vendor: 'OpenAI',
    allowedAuth: ['vendor_login', 'api_key'],
    acpAuthMethods: [],
    termsUrl: 'https://openai.com/policies/terms-of-use/',
    // Design review: a ChatGPT sign-in through a paid edition of Orka would need OpenAI's approval (not verified).
    note: 'Runs the codex-acp adapter (Apache-2.0) you installed. Sign in with Codex itself, with a ChatGPT plan or an API key.',
  },
  {
    id: 'github',
    vendor: 'GitHub',
    allowedAuth: ['vendor_login', 'api_key'],
    acpAuthMethods: [],
    termsUrl: 'https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features',
    note: 'Runs your installed GitHub Copilot CLI as an ACP server. GitHub documents this mode for other clients; it is a public preview and may change.',
    preview: true,
  },
  {
    id: 'cursor',
    vendor: 'Cursor',
    allowedAuth: ['vendor_login', 'api_key'],
    acpAuthMethods: ['cursor_login'],
    termsUrl: 'https://cursor.com/terms-of-service',
    note: 'Runs your installed Cursor CLI ("agent acp"), which Cursor documents for custom clients.',
  },
  {
    id: 'custom',
    vendor: '',
    allowedAuth: ['vendor_login', 'api_key', 'cloud'],
    acpAuthMethods: [],
    termsUrl: '',
    note: "An ACP agent you added yourself. Orka runs exactly the command you entered; make sure your use follows that agent's terms.",
  },
];

/**
 * Agents Orka deliberately leaves out of its catalog, and why. A user can still add one as a
 * custom ACP agent on their own responsibility.
 */
export const NOT_IN_CATALOG: ReadonlyArray<{ id: string; reason: string }> = [
  {
    id: 'antigravity',
    reason: "Google's terms do not allow using Antigravity through third-party software on consumer plans.",
  },
  {
    id: 'claude-agent-acp',
    reason: "The Claude ACP adapter's licence is unclear. Claude stays available through the Claude API provider and the opt-in Claude Code provider.",
  },
];

export function agentPolicy(id: string): AgentPolicy | undefined {
  return AGENT_POLICIES.find((p) => p.id === id);
}
