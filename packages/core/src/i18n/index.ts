import { TR } from './tr';

/**
 * UI localization shared by the core, the VS Code extension and the webview. Messages are keyed
 * by their English text, so untranslated strings simply show in English. Only user-facing text
 * is localized; prompts and tool results sent to models stay in English.
 *
 * Calls pass single-quoted string literals so a test can check every key has a translation;
 * the few dynamic keys (risk reasons, model notes) are listed in the dictionary by hand.
 */
export type Locale = 'en' | 'tr';

export const LOCALES: Array<{ id: Locale; label: string }> = [
  { id: 'en', label: 'English' },
  { id: 'tr', label: 'Türkçe' },
];

const DICTIONARIES: Record<Exclude<Locale, 'en'>, Record<string, string>> = { tr: TR };

let current: Locale = 'en';

/** Pick a supported locale from a BCP 47 tag ("tr-TR" -> "tr"); anything unknown is English. */
export function normalizeLocale(tag: string | undefined): Locale {
  const base = (tag ?? '').toLowerCase().split(/[-_]/)[0];
  return base === 'tr' ? 'tr' : 'en';
}

export function setLocale(tag: string | undefined): void {
  current = normalizeLocale(tag);
}

export function getLocale(): Locale {
  return current;
}

/** Translate `text` and fill {placeholders}. */
export function t(text: string, params?: Record<string, string | number>): string {
  const template = current === 'en' ? text : (DICTIONARIES[current][text] ?? text);
  return params ? template.replace(/\{(\w+)\}/g, (match, key: string) => (key in params ? String(params[key]) : match)) : template;
}

/** Singular/plural pick (English needs it; the translation decides for itself), then t(). */
export function tn(one: string, other: string, n: number, params: Record<string, string | number> = {}): string {
  return t(n === 1 ? one : other, { n, ...params });
}

/** Keys of a locale's dictionary (for tests). */
export function dictionaryKeys(locale: Exclude<Locale, 'en'>): string[] {
  return Object.keys(DICTIONARIES[locale]);
}
