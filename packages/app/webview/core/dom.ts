// HTML helpers shared by every part of the chat UI: escaping, icons and markdown.
import { marked } from 'marked';

marked.use({
  gfm: true,
  breaks: false,
  renderer: {
    // Never render raw HTML coming from the model.
    html: (token: { text: string }) => escapeHtml(token.text),
  },
});

export function renderMarkdown(text: string): string {
  try {
    return marked.parse(text, { async: false }) as string;
  } catch {
    return `<p>${escapeHtml(text)}</p>`;
  }
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export const attr = escapeHtml;

const ICON: Record<string, string> = {
  read: '<path d="M4 2.5h5.5L12 5v8.5H4z"/><path d="M9.5 2.5V5H12"/>',
  search: '<circle cx="7" cy="7" r="4"/><path d="M10 10l3.5 3.5"/>',
  edit: '<path d="M3 13l.6-2.6L10.8 3.2l2 2-7.2 7.2z"/><path d="M9.6 4.4l2 2"/>',
  delete: '<path d="M3.5 4.5h9M6.5 4.5V3h3v1.5M5 4.5l.6 9h4.8l.6-9"/>',
  command: '<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M4.5 6.5l2 1.5-2 1.5M8 10h3"/>',
  git: '<circle cx="5" cy="4" r="1.5"/><circle cx="5" cy="12" r="1.5"/><circle cx="11" cy="6" r="1.5"/><path d="M5 5.5v5M11 7.5c0 2-2 2.5-5.5 3.5"/>',
  plan: '<path d="M6.5 4.5h7M6.5 8h7M6.5 11.5h7"/><path d="M2.5 4.5l1 1 1.5-2M2.5 8h2M2.5 11.5h2"/>',
  agent: '<circle cx="8" cy="4" r="1.8"/><circle cx="3.5" cy="12" r="1.8"/><circle cx="12.5" cy="12" r="1.8"/><path d="M8 5.8v2.4M8 8.2l-3.6 2.4M8 8.2l3.6 2.4"/>',
  eye: '<path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>',
  check: '<path d="M3.5 8.5l3 3 6-7"/>',
  x: '<path d="M4 4l8 8M12 4l-8 8"/>',
  ban: '<circle cx="8" cy="8" r="5.5"/><path d="M4.2 11.8l7.6-7.6"/>',
  dash: '<path d="M4 8h8"/>',
  warn: '<path d="M8 2.5l6 11H2z"/><path d="M8 7v3M8 11.8v.2"/>',
  info: '<circle cx="8" cy="8" r="5.5"/><path d="M8 7.5v3.5M8 5v.2"/>',
  shield: '<path d="M8 2l5 2v4c0 3-2.2 5.2-5 6-2.8-.8-5-3-5-6V4z"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
  stop: '<rect x="4" y="4" width="8" height="8" rx="1"/>',
  send: '<path d="M2.5 8L13.5 3l-3.5 10.5-2-4.5z"/><path d="M8 9l5.5-6"/>',
  undo: '<path d="M5 6.5H10a3 3 0 010 6H7"/><path d="M7.5 4L5 6.5 7.5 9"/>',
  arrow: '<path d="M2 8h9M8 4l4 4-4 4"/>',
  arrowUp: '<path d="M8 13V3.5M4 7.5l4-4 4 4"/>',
  arrowDown: '<path d="M8 3v9.5M4 8.5l4 4 4-4"/>',
  more: '<circle cx="3.5" cy="8" r=".9"/><circle cx="8" cy="8" r=".9"/><circle cx="12.5" cy="8" r=".9"/>',
  folderPlus: '<path d="M2 4.5V12a1 1 0 001 1h10a1 1 0 001-1V6a1 1 0 00-1-1H8L6.5 3.5H3a1 1 0 00-1 1z"/><path d="M8 7v4M6 9h4"/>',
  copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5V4a1.5 1.5 0 00-1.5-1.5H4A1.5 1.5 0 002.5 4v5A1.5 1.5 0 004 10.5h1.5"/>',
  back: '<path d="M10 3L5 8l5 5"/>',
  key: '<circle cx="5.5" cy="10.5" r="3"/><path d="M7.7 8.3L13 3M11 5l1.5 1.5"/>',
  gear: '<circle cx="8" cy="8" r="2"/><path d="M8 2v2M8 12v2M2 8h2M12 8h2M3.8 3.8l1.4 1.4M10.8 10.8l1.4 1.4M3.8 12.2l1.4-1.4M10.8 5.2l1.4-1.4"/>',
  chevron: '<path d="M4.5 6.5L8 10l3.5-3.5"/>',
  history: '<path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9"/><path d="M2.5 2.5v2.2h2.2"/><path d="M8 5v3.2l2.2 1.4"/>',
  skill: '<path d="M2.5 3.5h4A1.5 1.5 0 018 5v8a1.5 1.5 0 00-1.5-1.5h-4z"/><path d="M13.5 3.5h-4A1.5 1.5 0 008 5v8a1.5 1.5 0 011.5-1.5h4z"/>',
  folder: '<path d="M2 4.5V12a1 1 0 001 1h10a1 1 0 001-1V6a1 1 0 00-1-1H8L6.5 3.5H3a1 1 0 00-1 1z"/>',
  refresh: '<path d="M13 8a5 5 0 11-1.5-3.6"/><path d="M13 2.5v2.5h-2.5"/>',
  plug: '<path d="M6 2.5v3M10 2.5v3M4.5 5.5h7v2.5a3.5 3.5 0 01-7 0z"/><path d="M8 11.5v2"/>',
  image: '<rect x="2.5" y="3" width="11" height="10" rx="1.5"/><circle cx="6" cy="6.5" r="1.2"/><path d="M3 12l3.5-3.5 2.5 2.5 2-2 2.5 2.5"/>',
  handoff: '<path d="M9.5 2.5h4v4M13.5 2.5L7.5 8.5"/><path d="M12 9.5v3.5a.5.5 0 01-.5.5h-8a.5.5 0 01-.5-.5v-8a.5.5 0 01.5-.5H7"/>',
  globe: '<circle cx="8" cy="8" r="5.5"/><path d="M2.5 8h11M8 2.5c1.6 1.6 2.3 3.4 2.3 5.5S9.6 11.9 8 13.5M8 2.5C6.4 4.1 5.7 5.9 5.7 8s.7 3.9 2.3 5.5"/>',
  sidebar: '<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M6.2 3v10"/>',
  aside: '<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M9.8 3v10"/>',
  sun: '<circle cx="8" cy="8" r="2.6"/><path d="M8 1.8v1.4M8 12.8v1.4M1.8 8h1.4M12.8 8h1.4M3.6 3.6l1 1M11.4 11.4l1 1M3.6 12.4l1-1M11.4 4.6l1-1"/>',
  moon: '<path d="M13 9.6A5.5 5.5 0 016.4 3a5.5 5.5 0 106.6 6.6z"/>',
  monitor: '<rect x="2" y="3" width="12" height="8" rx="1.2"/><path d="M6 13.5h4M8 11v2.5"/>',
};

export function icon(name: string, cls = ''): string {
  return `<svg class="icon ${cls}" viewBox="0 0 16 16" aria-hidden="true">${ICON[name] ?? ''}</svg>`;
}
