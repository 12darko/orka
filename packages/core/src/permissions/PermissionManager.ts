/**
 * Decides whether an action runs automatically, needs the user's approval, or is refused.
 * The decision is a function of the permission mode, per-category user overrides, the risk of
 * the concrete action, and "always allow" grants given during the session.
 */

export type PermissionMode = 'ask' | 'balanced' | 'autonomous';

/**
 * read: no side effects. plan: proposing/changing the plan. git: history/remote-changing git.
 * network: requests to the internet (reading web pages, opening external sites).
 */
export type PermissionCategory = 'read' | 'plan' | 'edit' | 'delete' | 'command' | 'git' | 'network';

export type RiskLevel = 'safe' | 'normal' | 'dangerous';

export type Decision = 'allow' | 'ask' | 'deny';

export type SimpleOverride = 'mode' | 'auto' | 'ask';
export type TerminalOverride = 'mode' | 'auto' | 'askDangerous' | 'ask';

export interface PermissionOverrides {
  fileEdit?: SimpleOverride;
  terminal?: TerminalOverride;
  git?: SimpleOverride;
  delete?: SimpleOverride;
  network?: SimpleOverride;
}

export interface PermissionQuery {
  category: PermissionCategory;
  risk: RiskLevel;
}

type Policy = 'auto' | 'ask' | 'askDangerous';

const MODE_POLICIES: Record<PermissionMode, Record<Exclude<PermissionCategory, 'read'>, Policy>> = {
  ask: { plan: 'ask', edit: 'ask', delete: 'ask', command: 'ask', git: 'ask', network: 'ask' },
  balanced: { plan: 'auto', edit: 'auto', delete: 'ask', command: 'askDangerous', git: 'ask', network: 'auto' },
  // Deletes are snapshotted by the change tracker, so they stay revertable in autonomous mode.
  autonomous: { plan: 'auto', edit: 'auto', delete: 'auto', command: 'askDangerous', git: 'askDangerous', network: 'auto' },
};

export class PermissionManager {
  private sessionGrants = new Set<string>();

  constructor(
    private mode: PermissionMode = 'balanced',
    private overrides: PermissionOverrides = {},
  ) {}

  getMode(): PermissionMode {
    return this.mode;
  }

  setMode(mode: PermissionMode): void {
    this.mode = mode;
  }

  setOverrides(overrides: PermissionOverrides): void {
    this.overrides = overrides;
  }

  /** Remember an "always allow" answer for this kind of action until the session is reset. */
  grantForSession(query: PermissionQuery): void {
    this.sessionGrants.add(grantKey(query));
  }

  resetSession(): void {
    this.sessionGrants.clear();
  }

  decide(query: PermissionQuery): Decision {
    if (query.category === 'read') return 'allow';
    // Safe (read-only) commands never need approval, whatever the mode.
    if (query.category === 'command' && query.risk === 'safe') return 'allow';

    const policy = this.policyFor(query.category);
    const needsAsk = policy === 'ask' || (policy === 'askDangerous' && query.risk === 'dangerous');
    if (!needsAsk) return 'allow';
    if (this.sessionGrants.has(grantKey(query))) return 'allow';
    return 'ask';
  }

  private policyFor(category: Exclude<PermissionCategory, 'read'>): Policy {
    const modePolicy = MODE_POLICIES[this.mode][category];
    const override = this.overrideFor(category);
    if (!override || override === 'mode') return modePolicy;
    return override;
  }

  private overrideFor(category: Exclude<PermissionCategory, 'read'>): Policy | 'mode' | undefined {
    switch (category) {
      case 'edit':
        return this.overrides.fileEdit;
      case 'delete':
        return this.overrides.delete;
      case 'git':
        return this.overrides.git;
      case 'command':
        return this.overrides.terminal;
      case 'network':
        return this.overrides.network;
      default:
        return undefined;
    }
  }
}

function grantKey(query: PermissionQuery): string {
  // A grant for normal commands must not silently cover dangerous ones.
  return query.category === 'command' || query.category === 'git' ? `${query.category}:${query.risk}` : query.category;
}
