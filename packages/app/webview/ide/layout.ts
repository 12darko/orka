// Two layouts for one chat UI. "panel": a single column (VS Code's side bar, the desktop app's
// classic window). "ide": the desktop app's window with the sessions on the left, the conversation
// in the middle and the task's plan and changes on the right. The desktop page sets it on <html>.

export type Layout = 'panel' | 'ide';

export const layout: Layout = document.documentElement.dataset.layout === 'ide' ? 'ide' : 'panel';

/** The page's structure; every part keeps its id in both layouts. */
export function appSkeleton(): string {
  const agents = '<section class="panel agents-panel" id="agents-panel" hidden></section>';
  const plan = '<section class="panel" id="plan-panel" hidden></section>';
  const changes = '<section class="panel" id="changes-panel" hidden></section>';
  const views = `
    <section class="panel usage-panel" id="usage-panel" hidden></section>
    <section class="settings" id="settings-view" hidden></section>
    <section class="settings history" id="history-view" hidden></section>`;
  if (layout === 'panel') {
    return `<header class="topbar" id="topbar"></header>${agents}${plan}${changes}
    <main class="transcript" id="transcript"></main>${views}
    <footer class="composer" id="composer">
      <div class="suggest" id="suggest" role="listbox" hidden></div>
      <div class="chips" id="chips" hidden></div>
      <textarea id="input" rows="3"></textarea>
      <div class="composer-row">
        <button class="meta" id="meta" data-action="toggle-usage"></button>
        <button class="btn primary" id="send"></button>
      </div>
    </footer>`;
  }
  // The message box holds its own controls (attach, permission mode, model, send); the agents
  // panel opens above it, and on a new session it sits in the middle with suggestions below.
  return `
    <aside class="sidebar" id="sidebar"></aside>
    <div class="main-col" id="main-col">
      <header class="topbar" id="topbar"></header>
      <main class="transcript" id="transcript"></main>${views}
      <footer class="composer" id="composer">
        <button class="to-bottom" id="to-bottom" data-action="to-bottom" hidden></button>
        <div class="suggest" id="suggest" role="listbox" hidden></div>
        ${agents}
        <div class="composer-menu" id="composer-menu" role="menu" hidden></div>
        <div class="chips" id="chips" hidden></div>
        <textarea id="input" rows="2"></textarea>
        <div class="composer-row">
          <button class="icon-btn composer-add" data-action="composer-menu" aria-haspopup="menu"></button>
          <span class="composer-mode" id="composer-mode"></span>
          <span class="spacer"></span>
          <span class="composer-agent" id="composer-agent"></span>
          <button class="meta" id="meta" data-action="toggle-usage" hidden></button>
          <button class="btn primary" id="send"></button>
        </div>
        <input type="file" id="image-input" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden>
      </footer>
      <div class="starters" id="starters" hidden></div>
    </div>
    <aside class="aside" id="aside" hidden>${plan}${changes}</aside>`;
}
