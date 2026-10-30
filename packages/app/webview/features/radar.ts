// The desktop app's Radar panel (a tab of the side panel in the IDE layout) and its card in
// Settings > Control. Everything in the report was written from public release notes by a model,
// so every value is escaped and links are only ever https pages the app opens itself.
import type { RadarMatch, RadarStage } from '@orka/core';
import { t, tn } from '@orka/core/src/i18n';
import type { ProviderView, RadarClusterView, RadarItemView, RadarReportView, RadarView } from '../../src/protocol';
import { attr, escapeHtml, icon } from '../core/dom';
import { ago } from '../core/format';

export interface RadarPanelDeps {
  providers: ProviderView[];
  /** The model options of a provider, as the agent pickers build them. */
  modelOptions(provider: ProviderView | undefined, selected: string): string;
}

/** Providers Radar can run on: model APIs only, never an agent CLI or Claude Code. */
export function radarProviders(providers: ProviderView[]): ProviderView[] {
  return providers.filter((p) => !p.agent && p.kind !== 'claude-code');
}

/** The pending count, for the tab, the rail and the session list. */
export function radarBadge(radar: RadarView | undefined): string {
  const n = Number(radar?.pending) || 0;
  return n > 0 ? `<span class="radar-badge" aria-label="${attr(tn('{n} new entry', '{n} new entries', n))}">${n > 99 ? '99+' : n}</span>` : '';
}

export function radarPanelHtml(radar: RadarView, report: RadarReportView | undefined, deps: RadarPanelDeps): string {
  const state = !radar.enabled ? t('Off') : radar.polling ? t('Checking…') : radar.analysis ? t('Analyzing…') : t('On');
  const head = `<div class="panel-head radar-head">
      <strong>Radar</strong><span class="pill${radar.enabled ? ' ok' : ''}"><span class="pill-dot"></span>${escapeHtml(state)}</span><span class="spacer"></span>
      ${
        radar.enabled
          ? `<button class="link" data-action="radar-poll"${radar.polling ? ' disabled' : ''} title="${attr(t('Check the feeds that are due now'))}">${escapeHtml(t('Check now'))}</button>
             <button class="link" data-action="radar-switch" data-on="false">${escapeHtml(t('Turn off'))}</button>`
          : ''
      }
    </div>`;
  const error = radar.error ? `<div class="hint warn radar-error" role="status">${icon('warn')}<span>${escapeHtml(radar.error)}</span></div>` : '';
  const body = radar.enabled ? onHtml(radar, deps) : offHtml(radar);
  return `${head}${error}${body}${report ? reportHtml(report, radar) : ''}`;
}

/** Off: what Radar would do and every host it would contact, and the switch. */
function offHtml(radar: RadarView): string {
  return `<div class="radar-intro">
      <p>${escapeHtml(t('Radar reads the public release notes of other AI coding tools and suggests what Orka could add. It is off: nothing is fetched.'))}</p>
      ${hostsHtml(radar)}
      <p class="footnote">${escapeHtml(
        t("While it is on, it checks these sites once an hour. The requests carry only Orka's name and version, nothing about you or your projects. An analysis runs only when you click Analyze, on your own provider and API key."),
      )}</p>
      <button class="btn primary" data-action="radar-switch" data-on="true">${icon('radar')}${escapeHtml(t('Turn on Radar'))}</button>
    </div>`;
}

function hostsHtml(radar: RadarView): string {
  return `<div class="radar-hosts">
      <span class="field-label">${escapeHtml(t('Sites it contacts while it is on'))}</span>
      <ul>${radar.hosts.map((h) => `<li><code>${escapeHtml(h.host)}</code><span class="muted">${escapeHtml(h.products.join(', '))}</span></li>`).join('')}</ul>
      ${radar.sourceErrors.map((e) => `<div class="hint warn">${icon('warn')}<span>${escapeHtml(e)}</span></div>`).join('')}
    </div>`;
}

/** On: when it last looked, what failed, what is waiting, the model and the analysis. */
function onHtml(radar: RadarView, deps: RadarPanelDeps): string {
  const checked = radar.polling ? t('Checking the feeds…') : radar.lastPollAt ? t('Last checked {when}.', { when: ago(radar.lastPollAt) }) : t('Not checked yet.');
  const failed = radar.sources.filter((s) => s.lastError);
  const errors = failed.length
    ? `<ul class="radar-source-errors">${failed
        .map((s) => `<li>${icon('warn')}<span><strong>${escapeHtml(s.product)}</strong> <span class="muted">(${escapeHtml(s.host)})</span>: ${escapeHtml(s.lastError ?? '')}</span></li>`)
        .join('')}</ul>`
    : '';
  const run = radar.analysis;
  const waiting =
    radar.pending > 0 ? tn('{n} new entry is waiting for an analysis.', '{n} new entries are waiting for an analysis.', radar.pending) : t('Nothing new is waiting.');
  const progress = run
    ? `<div class="radar-progress" role="status">
        <div class="row-line"><span class="spinner small"></span><span class="grow">${escapeHtml(stageLabel(run.stage))}${run.total ? ` ${Number(run.done) || 0}/${Number(run.total) || 0}` : ''}</span>
          <button class="btn small" data-action="radar-stop">${icon('stop')}${escapeHtml(t('Stop'))}</button></div>
        <div class="row-line"><span class="progress wide"><span data-width="${run.total ? Math.round((100 * run.done) / run.total) : 0}"></span></span>
          <span class="calls muted small">${escapeHtml(t('{n} of {max} calls', { n: Number(run.calls) || 0, max: Number(run.maxCalls) || 0 }))}</span></div>
      </div>`
    : '';
  const quarantined = radar.quarantined
    ? `<div class="hint warn">${icon('warn')}<span>${escapeHtml(
        tn('{n} entry could not be read by the model.', '{n} entries could not be read by the model.', radar.quarantined),
      )}</span><button class="link" data-action="radar-retry">${escapeHtml(t('Retry'))}</button></div>`
    : '';
  return `<p class="radar-checked muted small">${escapeHtml(checked)}</p>
    ${errors}
    <div class="card radar-queue">
      <div class="card-head"><strong>${escapeHtml(waiting)}</strong></div>
      ${modelPicker(radar, deps)}
      ${radar.modelProblem ? `<div class="hint warn">${icon('info')}<span>${escapeHtml(radar.modelProblem)}</span></div>` : ''}
      ${progress}
      ${
        run
          ? ''
          : `<button class="btn primary" data-action="radar-analyze"${radar.pending > 0 && radar.model ? '' : ' disabled'}>${escapeHtml(t('Analyze'))}</button>`
      }
      ${quarantined}
      <label class="check"><input type="checkbox" data-setting="radar.autoAnalyze"${radar.autoAnalyze ? ' checked' : ''}><span>${escapeHtml(t('Analyze right after a check finds something'))}<br><span class="muted">${escapeHtml(
        t('Uses your provider and tokens, at most {n} model calls a run.', { n: Number(radar.maxCalls) || 0 }),
      )}</span></span></label>
    </div>`;
}

/** Radar's own provider and model ('' = the main agent's provider, when that is a model API). */
function modelPicker(radar: RadarView, deps: RadarPanelDeps): string {
  const providers = radarProviders(deps.providers);
  const current = radar.choice.provider || radar.model?.provider || '';
  const provider = providers.find((p) => p.kind === current);
  const auto = radar.choice.provider === '' && radar.model ? t('Same as main ({provider})', { provider: provider?.label ?? radar.model.provider }) : t('Choose a provider…');
  const options = [
    `<option value=""${radar.choice.provider === '' ? ' selected' : ''}>${escapeHtml(auto)}</option>`,
    ...providers.map(
      (p) => `<option value="${attr(p.kind)}"${p.kind === radar.choice.provider ? ' selected' : ''}>${escapeHtml(p.label)}${p.ready ? '' : ` – ${escapeHtml(t('no key'))}`}</option>`,
    ),
  ].join('');
  const model = radar.model?.model ?? radar.choice.model;
  return `<div class="field"><span class="field-label">${escapeHtml(t('Analyze with'))}</span>
      <div class="pickers">
        <select data-radar="provider" aria-label="${attr(t('Provider'))}"${radar.analysis ? ' disabled' : ''}>${options}</select>
        <select data-radar="model" aria-label="${attr(t('Model'))}"${!provider || radar.analysis ? ' disabled' : ''}>${deps.modelOptions(provider, model)}</select>
      </div></div>`;
}

function stageLabel(stage: RadarStage): string {
  switch (stage) {
    case 'summarize':
      return t('Summarizing');
    case 'map':
      return t('Comparing with Orka');
    case 'cluster':
      return t('Grouping similar features');
    case 'compare':
      return t('Comparing approaches');
    default:
      return t('Deciding');
  }
}

// ------------------------------------------------------------------ the report

function reportHtml(report: RadarReportView, radar: RadarView): string {
  const stats = report.stats;
  const stopped = stats.stopped
    ? `<div class="hint warn">${icon('info')}<span>${escapeHtml(
        tn('The last analysis stopped early; {n} entry is left for the next one.', 'The last analysis stopped early; {n} entries are left for the next one.', Number(stats.left) || 0),
      )}</span></div>`
    : '';
  const clusters = report.clusters.length
    ? report.clusters.map((c) => clusterHtml(c, radar)).join('')
    : `<p class="muted small">${escapeHtml(t('Nothing to compare yet: the last analysis found no notable new features.'))}</p>`;
  const others = report.others.length
    ? `<details class="radar-others" data-open-key="others"><summary>${escapeHtml(tn('{n} other change', '{n} other changes', report.others.length))}</summary><ul class="radar-items">${report.others.map(itemHtml).join('')}</ul></details>`
    : '';
  return `<div class="radar-report">
      <div class="radar-report-head"><strong>${escapeHtml(t('Report'))}</strong><span class="muted small">${escapeHtml(
        t('updated {when} · {provider} · {n} calls', { when: ago(report.generatedAt), provider: `${report.provider.id} / ${report.provider.model}`, n: Number(stats.calls) || 0 }),
      )}</span></div>
      <p class="footnote">${escapeHtml(t('Written by a model from public release notes only; it can be wrong.'))}</p>
      ${stopped}
      ${report.needsHuman ? `<p class="footnote">${escapeHtml(tn('{n} part needs a human look.', '{n} parts need a human look.', report.needsHuman))}</p>` : ''}
      ${clusters}
      ${others}
    </div>`;
}

function verdictLabel(cluster: RadarClusterView): string {
  switch (cluster.decision?.decision) {
    case 'gap':
      return t('What Orka lacks');
    case 'already_have':
      return t('Already in Orka');
    case 'not_for_orka':
      return t('Not for Orka');
    default:
      return t('Not decided yet');
  }
}

function clusterHtml(cluster: RadarClusterView, radar: RadarView): string {
  const d = cluster.decision;
  const verdict = d?.decision ?? 'open';
  const facts = d && d.decision === 'gap' ? `<span class="radar-chip">${escapeHtml(d.priority)}</span><span class="radar-chip" title="${attr(t('Size'))}">${escapeHtml(d.effort)}</span>` : '';
  const proposal = d?.proposal
    ? `<details class="radar-proposal" data-open-key="proposal:${attr(cluster.key)}"><summary>${escapeHtml(t('Proposal'))}: ${escapeHtml(d.proposal.title)}</summary>
        <p>${escapeHtml(d.proposal.problem)}</p>
        <ol>${d.proposal.acceptanceCriteria.map((c) => `<li>${escapeHtml(c)}</li>`).join('')}</ol>
      </details>`
    : '';
  const comparison = cluster.comparison
    ? `<details class="radar-comparison" data-open-key="comparison:${attr(cluster.key)}"><summary>${escapeHtml(t('How they compare ({confidence} confidence)', { confidence: confidenceLabel(cluster.comparison.confidence) }))}</summary>
        <ul>${cluster.comparison.approaches.map((a) => `<li><strong>${escapeHtml(a.vendor)}:</strong> ${escapeHtml(a.approach)}</li>`).join('')}</ul>
        <p>${escapeHtml(cluster.comparison.assessment)}</p>
      </details>`
    : '';
  const start = cluster.canStart
    ? `<button class="btn small" data-action="radar-start" data-cluster="${attr(cluster.key)}" title="${attr(t('A new session with this proposal in the message box; nothing is sent'))}"${
        radar.analysis ? ' disabled' : ''
      }>${icon('plus')}${escapeHtml(t('Start a session'))}</button>`
    : '';
  return `<article class="radar-cluster" data-verdict="${attr(verdict)}">
      <div class="radar-cluster-head"><strong>${escapeHtml(cluster.title)}</strong><span class="spacer"></span>${facts}</div>
      <div class="radar-meta muted small">${escapeHtml(cluster.vendors.join(', '))}${cluster.tags.length ? ` · ${escapeHtml(cluster.tags.join(', '))}` : ''}</div>
      <div class="radar-verdict" data-verdict="${attr(verdict)}">${escapeHtml(verdictLabel(cluster))}${
        d && d.decision === 'gap' ? ` · ${escapeHtml(t('priority {priority}, size {size}', { priority: d.priority, size: d.effort }))}` : ''
      }${d && !d.fitsPrinciples ? ` · ${escapeHtml(t("may not fit Orka's rules as it is"))}` : ''}</div>
      ${d?.rationale ? `<p class="radar-rationale">${escapeHtml(d.rationale)}</p>` : d?.decidedBy === 'inventory' ? `<p class="radar-rationale muted">${escapeHtml(t('Decided from the feature inventory.'))}</p>` : ''}
      <ul class="radar-items">${cluster.items.map(itemHtml).join('')}</ul>
      ${proposal}
      ${comparison}
      ${start ? `<div class="radar-actions">${start}</div>` : ''}
    </article>`;
}

function matchLabel(match: RadarMatch | undefined): string {
  switch (match) {
    case 'have':
      return t('Orka has it');
    case 'partial':
      return t('Orka has part of it');
    case 'gap':
      return t('Orka lacks it');
    case 'not_for_orka':
      return t('Not for Orka');
    default:
      return t('not compared');
  }
}

function itemHtml(item: RadarItemView): string {
  const name = `${item.product}: ${item.title}`;
  // Opened by the app after it checks the link again; only https pages are ever shown as links.
  const title = item.url?.startsWith('https://')
    ? `<button class="link radar-link" data-action="radar-link" data-url="${attr(item.url)}" title="${attr(item.url)}">${escapeHtml(name)}</button>`
    : `<span class="radar-item-title">${escapeHtml(name)}</span>`;
  return `<li class="radar-item">
      <span class="radar-match" data-match="${attr(item.match ?? 'none')}">${escapeHtml(matchLabel(item.match))}</span>
      ${title}
      <span class="radar-summary">${escapeHtml(item.summary)}</span>
    </li>`;
}

function confidenceLabel(confidence: string): string {
  return confidence === 'high' ? t('high') : confidence === 'medium' ? t('medium') : t('low');
}

// ------------------------------------------------------------------ Settings > Control

/** The same switches as the panel; the hosts are named before Radar is turned on. */
export function radarSettingsCard(radar: RadarView, panel: boolean): string {
  const hosts = radar.hosts.map((h) => h.host).join(', ');
  return `<div class="card">
      <div class="card-head"><strong>Radar</strong><span class="muted">${escapeHtml(t('release notes of other AI coding tools'))}</span></div>
      <label class="check"><input type="checkbox" data-setting="radar.enabled"${radar.enabled ? ' checked' : ''}><span>${escapeHtml(t('Watch for new features'))}<br><span class="muted">${escapeHtml(
        t('Checks these sites once an hour while it is on: {hosts}. Nothing is fetched while it is off.', { hosts }),
      )}</span></span></label>
      <label class="check"><input type="checkbox" data-setting="radar.autoAnalyze"${radar.autoAnalyze ? ' checked' : ''}${radar.enabled ? '' : ' disabled'}><span>${escapeHtml(
        t('Analyze right after a check finds something'),
      )}<br><span class="muted">${escapeHtml(t('Uses your provider and tokens, at most {n} model calls a run.', { n: Number(radar.maxCalls) || 0 }))}</span></span></label>
      ${
        panel
          ? `<button class="link radar-open" data-action="open-radar">${escapeHtml(t('Open the Radar panel'))}</button>`
          : `<p class="footnote">${escapeHtml(t('The Radar panel with the report is in the "Sessions and panels" layout (Appearance > Layout).'))}</p>`
      }
    </div>`;
}
