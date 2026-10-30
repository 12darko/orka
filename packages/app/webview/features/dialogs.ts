// Questions the desktop app asks inside the UI (VS Code shows its own dialogs instead).
import { t } from '@orka/core/src/i18n';
import type { DialogView } from '../../src/protocol';
import { post } from '../core/bridge';
import { attr, escapeHtml, icon } from '../core/dom';

const dialogs = new Map<string, DialogView>();
const dialogLayer = document.createElement('div');
dialogLayer.className = 'dialogs';
document.body.appendChild(dialogLayer);

export function showDialog(id: string, dialog: DialogView): void {
  dialogs.set(id, dialog);
  renderDialogs();
  // A plain notice without choices goes away on its own.
  if (dialog.kind === 'message' && !dialog.modal && !dialog.actions.length) setTimeout(() => answerDialog(id, undefined), 6000);
}

export function answerDialog(id: string, value: string | number | undefined): void {
  if (!dialogs.delete(id)) return;
  post({ type: 'dialogResult', id, value });
  renderDialogs();
}

/** The app closed a question itself (e.g. it was answered elsewhere). */
export function closeDialog(id: string): void {
  if (dialogs.delete(id)) renderDialogs();
}

/** A modal question is open: keyboard shortcuts of the page stay out of its way. */
export function modalOpen(): boolean {
  return !!topModal();
}

function topModal(): string | undefined {
  return [...dialogs].reverse().find(([, d]) => d.kind !== 'message' || d.modal)?.[0];
}

function renderDialogs(): void {
  const toasts = [...dialogs].filter(([, d]) => d.kind === 'message' && !d.modal).slice(-3);
  const modal = topModal();
  dialogLayer.innerHTML = `${toasts.length ? `<div class="toasts">${toasts.map(([id, d]) => dialogHtml(id, d)).join('')}</div>` : ''}${
    modal ? `<div class="modal-backdrop">${dialogHtml(modal, dialogs.get(modal)!)}</div>` : ''
  }`;
  const focus = dialogLayer.querySelector<HTMLElement>('.modal-backdrop .dialog-input, .modal-backdrop .dialog-filter, .modal-backdrop .btn.primary, .modal-backdrop .btn');
  focus?.focus();
  if (focus instanceof HTMLInputElement) focus.select();
}

function dialogHtml(id: string, d: DialogView): string {
  const ref = `data-dialog="${attr(id)}"`;
  const cancel = (label: string, cls = 'btn') => `<button class="${cls}" type="button" data-action="dialog-cancel" ${ref}>${escapeHtml(label)}</button>`;
  const title = (text?: string) => (text ? `<strong class="dialog-title">${escapeHtml(text)}</strong>` : '');
  switch (d.kind) {
    case 'message': {
      const actions = d.actions
        .map((a, i) => `<button class="btn${i === 0 ? ' primary' : ''}" type="button" data-action="dialog-action" ${ref} data-value="${attr(a)}">${escapeHtml(a)}</button>`)
        .join('');
      const close = d.modal
        ? cancel(d.actions.length ? t('Cancel') : t('OK'), d.actions.length ? 'btn' : 'btn primary')
        : `<button class="icon-btn" type="button" data-action="dialog-cancel" ${ref} aria-label="${attr(t('Close'))}" title="${attr(t('Close'))}">${icon('x')}</button>`;
      return `<div class="dialog ${d.modal ? 'modal' : 'toast'} ${attr(d.level)}" role="${d.modal ? 'alertdialog' : 'status'}" ${ref}>
        <div class="dialog-body">${icon(d.level === 'info' ? 'info' : 'warn')}<span>${escapeHtml(d.text)}${d.detail ? `<br><span class="muted">${escapeHtml(d.detail)}</span>` : ''}</span></div>
        <div class="dialog-actions">${actions}${close}</div></div>`;
    }
    case 'input':
      return `<form class="dialog modal" role="dialog" ${ref} data-dialog-form>
        ${title(d.title)}${d.prompt ? `<span class="muted">${escapeHtml(d.prompt)}</span>` : ''}
        <input class="dialog-input" type="${d.password ? 'password' : 'text'}" value="${attr(d.value ?? '')}" placeholder="${attr(d.placeholder ?? '')}" autocomplete="off" spellcheck="false" aria-label="${attr(d.title ?? d.prompt ?? '')}">
        ${d.error ? `<span class="dialog-error" role="alert">${escapeHtml(d.error)}</span>` : ''}
        <div class="dialog-actions"><button class="btn primary" type="submit">${escapeHtml(t('OK'))}</button>${cancel(t('Cancel'))}</div>
      </form>`;
    case 'pick':
      return `<div class="dialog modal pick" role="dialog" ${ref}>
        ${title(d.title)}
        <input class="dialog-filter" type="text" placeholder="${attr(t('Filter…'))}" aria-label="${attr(t('Filter…'))}" ${ref}>
        <div class="pick-list">${d.items
          .map((item, i) =>
            item.separator
              ? item.label
                ? `<div class="pick-sep">${escapeHtml(item.label)}</div>`
                : '<hr>'
              : `<button class="pick-item${item.picked ? ' picked' : ''}" type="button" data-action="dialog-pick" ${ref} data-index="${i}" data-filter="${attr(`${item.label} ${item.description ?? ''}`.toLowerCase())}">
                <span class="pick-label">${escapeHtml(item.label)}</span>${item.description ? `<span class="muted">${escapeHtml(item.description)}</span>` : ''}${
                  item.detail ? `<span class="muted small">${escapeHtml(item.detail)}</span>` : ''
                }</button>`,
          )
          .join('')}</div>
        <div class="dialog-actions">${cancel(t('Cancel'))}</div>
      </div>`;
    case 'diff':
      return `<div class="dialog modal diff" role="dialog" ${ref}>
        ${title(d.title)}
        <pre class="diff-view">${d.diff
          .split('\n')
          .map((line) => {
            const cls = line.startsWith('+++') || line.startsWith('---') ? 'file' : line.startsWith('@@') ? 'hunk' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : '';
            return `<span class="${cls}">${escapeHtml(line)}</span>`;
          })
          .join('\n')}</pre>
        <div class="dialog-actions">${cancel(t('Close'), 'btn primary')}</div>
      </div>`;
  }
}

document.addEventListener('submit', (e) => {
  const form = (e.target as HTMLElement).closest<HTMLElement>('[data-dialog-form]');
  if (!form) return;
  e.preventDefault();
  answerDialog(form.dataset.dialog!, form.querySelector<HTMLInputElement>('.dialog-input')?.value ?? '');
});

document.addEventListener('input', (e) => {
  const target = e.target as HTMLElement;
  if (!(target instanceof HTMLInputElement) || !target.classList.contains('dialog-filter')) return;
  const query = target.value.trim().toLowerCase();
  target
    .closest('.dialog')
    ?.querySelectorAll<HTMLElement>('.pick-item')
    .forEach((item) => (item.hidden = !!query && !(item.dataset.filter ?? '').includes(query)));
});

document.addEventListener('keydown', (e) => {
  const modal = topModal();
  if (!modal) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    answerDialog(modal, undefined);
  } else if (e.key === 'Enter' && (e.target as HTMLElement).classList.contains('dialog-filter')) {
    // Enter in a pick list's filter takes the first visible item.
    e.preventDefault();
    const first = dialogLayer.querySelector<HTMLElement>('.pick-item:not([hidden])');
    if (first) answerDialog(modal, Number(first.dataset.index));
  }
});
