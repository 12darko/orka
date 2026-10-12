/**
 * Known models per provider, grouped by family, so pickers can offer exact versions
 * ("Opus 5.5", "GPT-6 Sol", "Gemini 3.8 Flash") instead of bare ids. Providers can also report
 * their own list at runtime (Load list); anything else can be typed in.
 */
export interface ModelInfo {
  id: string;
  /** Human-readable version, e.g. "Opus 5.5". */
  label: string;
  /** Family used for grouping, e.g. "Claude Opus". */
  family: string;
  /** Short hint shown next to the label. */
  note?: string;
}

const CLAUDE_VERSIONS: ModelInfo[] = [
  { id: 'claude-fable-5-1', label: 'Fable 5.1', family: 'Claude Fable', note: 'most capable' },
  { id: 'claude-fable-5', label: 'Fable 5', family: 'Claude Fable' },
  { id: 'claude-opus-5-5', label: 'Opus 5.5', family: 'Claude Opus', note: 'recommended' },
  { id: 'claude-opus-5', label: 'Opus 5', family: 'Claude Opus' },
  { id: 'claude-opus-4-8', label: 'Opus 4.8', family: 'Claude Opus' },
  { id: 'claude-opus-4-7', label: 'Opus 4.7', family: 'Claude Opus' },
  { id: 'claude-opus-4-6', label: 'Opus 4.6', family: 'Claude Opus' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', family: 'Claude Sonnet', note: 'fast' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5', family: 'Claude Sonnet' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', family: 'Claude Sonnet' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5', family: 'Claude Haiku', note: 'fastest' },
];

export const MODEL_CATALOG: Record<string, ModelInfo[]> = {
  claude: CLAUDE_VERSIONS,
  // Aliases always resolve to what the installed CLI supports; exact versions may need a newer CLI.
  'claude-code': [
    { id: 'default', label: 'CLI default', family: 'Latest (aliases)', note: 'whatever Claude Code uses' },
    { id: 'opus', label: 'Opus (latest)', family: 'Latest (aliases)', note: 'recommended' },
    { id: 'sonnet', label: 'Sonnet (latest)', family: 'Latest (aliases)', note: 'fast' },
    { id: 'haiku', label: 'Haiku (latest)', family: 'Latest (aliases)', note: 'fastest' },
    { id: 'fable', label: 'Fable (latest)', family: 'Latest (aliases)' },
    ...CLAUDE_VERSIONS.map(({ note: _note, ...m }) => ({ ...m, note: 'needs a recent CLI' })),
  ],
  openai: [
    { id: 'gpt-6-astra', label: 'GPT-6 Astra', family: 'GPT-6', note: 'most capable' },
    { id: 'gpt-6-sol', label: 'GPT-6 Sol', family: 'GPT-6', note: 'faster' },
    { id: 'gpt-6-luna', label: 'GPT-6 Luna', family: 'GPT-6', note: 'cheapest' },
    { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', family: 'GPT-5.6' },
    { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', family: 'GPT-5.6' },
    { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', family: 'GPT-5.6' },
  ],
  gemini: [
    { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro (preview)', family: 'Gemini Pro' },
    { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', family: 'Gemini Flash', note: 'recommended for agents' },
    { id: 'gemini-3.7-flash', label: 'Gemini 3.7 Flash', family: 'Gemini Flash' },
    { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash', family: 'Gemini Flash' },
    { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', family: 'Gemini Flash' },
    { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite', family: 'Gemini Flash-Lite' },
    { id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash-Lite', family: 'Gemini Flash-Lite' },
  ],
};

/**
 * Catalog entry for a model id. Ids we do not know yet (a model released after this build, found
 * through the provider's own model list) get a family and version label from their name, so
 * "claude-opus-6" lands under "Claude Opus" as "Opus 6" by itself.
 */
export function describeModel(provider: string, id: string, fallbackFamily = 'Other models'): ModelInfo {
  return MODEL_CATALOG[provider]?.find((m) => m.id === id) ?? inferModel(id) ?? { id, label: id, family: fallbackFamily };
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Family and label from a model id's naming scheme, or undefined when it follows none we know. */
export function inferModel(id: string): ModelInfo | undefined {
  const claude = /^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2}))?(?:-(\d{8}))?$/.exec(id);
  if (claude) {
    const [, name, major, minor, date] = claude;
    return { id, label: `${cap(name)} ${major}${minor ? `.${minor}` : ''}${date ? ` (${date})` : ''}`, family: `Claude ${cap(name)}` };
  }
  const gpt = /^gpt-(\d+(?:\.\d+)?)(?:-([a-z]+))?(?:-(.+))?$/.exec(id);
  if (gpt) {
    const [, version, name, rest] = gpt;
    return { id, label: `GPT-${version}${name ? ` ${cap(name)}` : ''}${rest ? ` ${rest}` : ''}`, family: `GPT-${version}` };
  }
  const gemini = /^gemini-(\d+(?:\.\d+)?)-(flash-lite|flash|pro)(-preview)?(?:-(.+))?$/.exec(id);
  if (gemini) {
    const [, version, kind, preview, rest] = gemini;
    const kindLabel = kind.split('-').map(cap).join('-');
    return { id, label: `Gemini ${version} ${kindLabel}${preview ? ' (preview)' : ''}${rest ? ` ${rest}` : ''}`, family: `Gemini ${kindLabel}` };
  }
  return undefined;
}

/** Model ids from a provider's list that are not chat models (embeddings, audio, images, ...). */
export function isChatModelId(id: string): boolean {
  return !/embed|tts|whisper|dall-e|image|audio|realtime|moderation|transcribe|search|davinci|babbage|computer-use/i.test(id);
}
