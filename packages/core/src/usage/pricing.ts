import type { Usage } from '../types';

/** USD per million tokens. Cache writes are the 5-minute rate. */
export interface Price {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/**
 * User-defined prices, keyed "<provider>/<model pattern>" where the pattern may use * wildcards,
 * e.g. {"openai/gpt-6-*": {"input": 3, "output": 12}, "custom:openrouter/*": {...}}. They take
 * precedence over the built-in table, and are the only source of costs for non-Claude providers.
 */
export type PriceTable = Record<string, Price>;

/**
 * Anthropic first-party list prices (Claude API). Other providers are shown without a cost
 * estimate unless the user adds prices; Claude Code runs on the user's subscription.
 */
const CLAUDE_PRICES: Array<[RegExp, Required<Price>]> = [
  [/^claude-(fable|mythos)-5-1/, { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 }],
  [/^claude-(fable|mythos)-5/, { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 }],
  [/^claude-opus-5-5/, { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 }],
  [/^claude-opus-(5|4-[678])/, { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }],
  [/^claude-sonnet-5-5/, { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }],
  [/^claude-sonnet-5/, { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }],
  [/^claude-sonnet-4-6/, { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }],
  [/^claude-haiku-4-5/, { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }],
];

export type CostEstimate = { kind: 'usd'; usd: number } | { kind: 'subscription' } | { kind: 'unknown' };

export function estimateCost(provider: string, model: string, usage: Usage, custom?: PriceTable): CostEstimate {
  const own = custom ? customPrice(custom, provider, model) : undefined;
  if (own) return { kind: 'usd', usd: cost(usage, own) };
  if (provider === 'claude-code') return { kind: 'subscription' };
  if (provider !== 'claude') return { kind: 'unknown' };
  const price = CLAUDE_PRICES.find(([re]) => re.test(model))?.[1];
  return price ? { kind: 'usd', usd: cost(usage, price) } : { kind: 'unknown' };
}

function cost(usage: Usage, price: Price): number {
  // Without explicit cache prices, cached tokens cost like input tokens.
  const cacheRead = price.cacheRead ?? price.input;
  const cacheWrite = price.cacheWrite ?? price.input;
  return (usage.inputTokens * price.input + usage.outputTokens * price.output + usage.cacheReadTokens * cacheRead + usage.cacheWriteTokens * cacheWrite) / 1_000_000;
}

/** Most specific matching entry: exact model first, then the longest pattern. */
function customPrice(table: PriceTable, provider: string, model: string): Price | undefined {
  let best: { price: Price; score: number } | undefined;
  for (const [key, price] of Object.entries(table)) {
    if (!isPrice(price)) continue;
    const slash = key.indexOf('/');
    if (slash <= 0) continue;
    const keyProvider = key.slice(0, slash);
    const pattern = key.slice(slash + 1);
    if (!wildcard(keyProvider).test(provider) || !wildcard(pattern).test(model)) continue;
    const score = (pattern.includes('*') ? 0 : 10_000) + (keyProvider.includes('*') ? 0 : 1_000) + pattern.replace(/\*/g, '').length;
    if (!best || score > best.score) best = { price, score };
  }
  return best?.price;
}

export function isPrice(value: unknown): value is Price {
  if (!value || typeof value !== 'object') return false;
  const p = value as Record<string, unknown>;
  const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  return num(p.input) && num(p.output) && (p.cacheRead === undefined || num(p.cacheRead)) && (p.cacheWrite === undefined || num(p.cacheWrite));
}

function wildcard(pattern: string): RegExp {
  return new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i');
}
