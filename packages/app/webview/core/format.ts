import { t } from '@orka/core/src/i18n';

export function fmt(value: number): string {
  // Token counts come from providers and go into HTML: only ever print a number.
  const n = Number(value) || 0;
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return t('just now');
  if (s < 3600) return t('{n} min ago', { n: Math.floor(s / 60) });
  if (s < 86400) return t('{n} h ago', { n: Math.floor(s / 3600) });
  return t('{n} d ago', { n: Math.floor(s / 86400) });
}

/**
 * Bar widths: the UI's Content Security Policy blocks inline style attributes, so bars carry their
 * width in data-width and get it through the CSSOM after rendering.
 */
export function applyWidths(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>('[data-width]').forEach((bar) => {
    const pct = Math.min(100, Math.max(0, Number(bar.dataset.width) || 0));
    bar.style.width = `${pct}%`;
  });
}
