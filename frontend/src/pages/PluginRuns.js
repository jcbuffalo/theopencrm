// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Plugin runs viewer — `/plugins/:id/runs`.
//
// Designed for the customer who just clicked "Use this template" five minutes
// ago and wants to understand "did my plugin actually do anything?". Every
// label, every empty state, every tooltip is written for that reader — NOT
// for a developer who already knows what `budget_exceeded` means.
//
// Visual style intentionally matches PluginDetail.js: status badges use the
// shared StatusBadge tones, table layout mirrors the runs section on the
// detail page. The new surface is the filter row + expandable rows.

import React, { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate, Link, useLocation } from 'react-router-dom';
import api from '../api';
import Nav from '../components/Nav';
import { Alert, Button, Card, Container, EmptyState, Icon, PageHeader, Select, Skeleton, StatusBadge } from '../components/ui';
import {
  friendlyStatus,
  statusTone,
  formatDuration,
  triggerLabel,
} from '../utils/pluginRunStatus';

// Status pills the user can click. Each pill maps to one of the buckets
// the backend recognises in `?status=`. The labels are plain English —
// "Worked" / "Didn't finish" / "Hit a limit" — and the underlying value
// is what the API actually expects.
const STATUS_PILLS = [
  { key: 'all',             label: 'All' },
  { key: 'success',         label: 'Worked' },
  { key: 'failed',          label: "Didn't finish" },
  { key: 'budget_exceeded', label: 'Hit a limit' },
];

const TIME_WINDOWS = [
  { key: '24h', label: 'Last 24h' },
  { key: '7d',  label: 'Last 7 days' },
  { key: '30d', label: 'Last 30 days' },
];

// pluginRunStatus tones (good / warn / bad / neutral) → StatusBadge tones.
const TONE_MAP = { good: 'success', warn: 'warning', bad: 'error', neutral: 'neutral' };

// Tooltip helper — uses native `title` for now to avoid pulling in a UI lib.
// The runs table is a low-frequency surface; a title tooltip is enough.
function Tip({ children, text }) {
  return <span title={text} className="cursor-help underline decoration-dotted decoration-gray-400">{children}</span>;
}

function RunStatusBadge({ status, friendly }) {
  return <StatusBadge tone={TONE_MAP[statusTone(status)] || 'neutral'} label={friendly || friendlyStatus(status)} />;
}

function PrettyJson({ value, label }) {
  if (value == null) return null;
  let json;
  try {
    json = JSON.stringify(value, null, 2);
  } catch {
    json = String(value);
  }
  return (
    <details className="mt-2 group">
      <summary className="text-[11px] uppercase tracking-wider text-gray-500 font-semibold cursor-pointer hover:text-brand-blue">
        {label}
      </summary>
      <pre className="mt-1 p-2 bg-gray-50 border border-gray-200 rounded text-[11px] font-mono whitespace-pre-wrap overflow-x-auto max-h-64">
        {json}
      </pre>
    </details>
  );
}

const TH = 'px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500 bg-gray-50 border-b border-gray-200 whitespace-nowrap';

function RunRow({ run, pluginId, expanded, onToggle, onApplied }) {
  const when = run.started_at ? new Date(run.started_at) : null;
  // Friendly relative-ish timestamp. Native Intl is fine for the precision we
  // need (the rows are sorted desc anyway).
  const whenText = when
    ? when.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
    : '—';
  const trigger = triggerLabel(run.trigger_kind, run.trigger_source);
  // Confirm-first proposals captured on this run. Triggered (event/schedule)
  // runs land here with NO other UI — this row is where an owner/admin
  // reviews and applies them. Autonomous runs arrive already applied.
  const proposals = Array.isArray(run.proposed_actions) ? run.proposed_actions : [];
  const pendingApply = proposals.length > 0 && !run.applied_at;
  const [applying, setApplying] = useState(false);
  const [applyErr, setApplyErr] = useState('');

  const doApply = async (e) => {
    e.stopPropagation();
    setApplyErr('');
    setApplying(true);
    try {
      await api.post(`/plugins/${pluginId}/apply`, { runId: run.id });
      if (onApplied) await onApplied();
    } catch (err) {
      setApplyErr(err.response?.data?.error || err.message || 'Apply failed');
    } finally {
      setApplying(false);
    }
  };

  return (
    <>
      <tr
        id={`run-${run.id}`}
        className="border-b border-gray-100 hover:bg-gray-50 cursor-pointer transition-colors"
        onClick={onToggle}
        aria-expanded={expanded}
      >
        <td className="px-4 py-3 text-sm text-gray-700 whitespace-nowrap">{whenText}</td>
        <td className="px-4 py-3">
          <span className="inline-flex items-center gap-1.5 flex-wrap">
            <RunStatusBadge status={run.status} friendly={run.friendly_status} />
            {pendingApply && <StatusBadge tone="warning" label={`${proposals.length} change${proposals.length === 1 ? '' : 's'} to apply`} />}
            {proposals.length > 0 && run.applied_at && (
              <StatusBadge tone="success" label={run.run_mode === 'autonomous' ? 'Applied automatically' : 'Applied'} />
            )}
          </span>
        </td>
        <td className="px-4 py-3 text-sm text-gray-700">{trigger}</td>
        <td className="px-4 py-3 text-sm text-gray-700 whitespace-nowrap">{formatDuration(run.cpu_ms)}</td>
        <td className="px-4 py-3 text-sm text-gray-700 whitespace-nowrap text-right">{run.db_queries ?? 0}</td>
        <td className="px-4 py-3 text-gray-400 text-right"><Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={14} /></td>
      </tr>
      {expanded && (
        <tr className="bg-gray-50 border-b border-gray-200">
          <td colSpan={6} className="px-4 py-3">
            <div className="text-xs text-gray-600 space-y-2">
              {proposals.length > 0 && (
                <div className={`rounded border p-2 ${pendingApply ? 'bg-warning-50 border-warning-200' : 'bg-success-50 border-success-200'}`} onClick={(e) => e.stopPropagation()}>
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <div className="text-sm font-semibold text-gray-800">
                      {pendingApply
                        ? `This run wants to make ${proposals.length} change${proposals.length === 1 ? '' : 's'} — nothing is written until you apply them.`
                        : run.run_mode === 'autonomous'
                          ? `This run applied ${proposals.length} change${proposals.length === 1 ? '' : 's'} automatically (autonomous mode).`
                          : `${proposals.length} change${proposals.length === 1 ? '' : 's'} — applied.`}
                    </div>
                    {pendingApply && (
                      <Button size="sm" onClick={doApply} loading={applying} loadingLabel="Applying…">
                        Apply {proposals.length} change{proposals.length === 1 ? '' : 's'}
                      </Button>
                    )}
                  </div>
                  <ul className="mt-1.5 space-y-0.5">
                    {proposals.map((a, i) => (
                      <li key={i} className="text-[11px] font-mono text-gray-700">
                        {a.summary || `${a.op} ${a.entity}`}
                      </li>
                    ))}
                  </ul>
                  {applyErr && <div className="mt-1.5 text-[11px] text-danger-600">{applyErr}</div>}
                </div>
              )}
              {run.result_summary && (
                <div>
                  <div className="text-[11px] uppercase tracking-wider text-gray-500 font-semibold mb-1">Result summary</div>
                  <div className="text-sm text-gray-800">{run.result_summary}</div>
                </div>
              )}
              {run.error_message && (
                <div className="bg-danger-50 border border-danger-200 rounded p-2">
                  <div className="text-[11px] uppercase tracking-wider text-danger-700 font-semibold mb-1">Error</div>
                  <div className="text-sm text-danger-800 whitespace-pre-wrap">{run.error_message}</div>
                  <Link
                    to={`/chat`}
                    state={{ seed: `What does this error mean? "${(run.error_message || '').slice(0, 200)}"` }}
                    className="inline-block mt-1 text-[11px] text-brand-blue hover:underline"
                  >
                    What does this mean?
                  </Link>
                </div>
              )}
              <div>
                <div className="text-[11px] uppercase tracking-wider text-gray-500 font-semibold mb-1">Run log</div>
                {Array.isArray(run.log_lines) && run.log_lines.length > 0 ? (
                  <pre className="p-2 bg-white border border-gray-200 rounded text-[11px] font-mono whitespace-pre-wrap overflow-x-auto max-h-72">
                    {run.log_lines.join('\n')}
                  </pre>
                ) : (
                  <div className="text-sm text-gray-500 italic">No log lines for this run. The plugin didn't call <code className="bg-white px-1 rounded border border-gray-200">crm.log()</code>.</div>
                )}
              </div>
              <PrettyJson label="Input payload" value={run.input_payload} />
              <PrettyJson label="Output payload" value={run.output_payload} />
              <div className="text-[11px] text-gray-400 pt-1">
                Run id: {run.id} · Plugin id: {run.plugin_id}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

export default function PluginRuns() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [pluginName, setPluginName] = useState('');
  const [runs, setRuns] = useState(null);
  const [error, setError] = useState('');
  const [featureDisabled, setFeatureDisabled] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [statusKey, setStatusKey] = useState('all');
  const [sinceKey, setSinceKey] = useState('24h');
  const [expanded, setExpanded] = useState(() => new Set());
  // Bumped after an Apply so the table refetches and the row's pending badge
  // flips to "Applied" without a manual refresh.
  const [reloadTick, setReloadTick] = useState(0);

  // Auto-expand the #run-<id> fragment so a "View run" chip from chat lands
  // the user directly on the relevant row. We parse on every mount + every
  // hash change.
  useEffect(() => {
    const hash = location.hash || '';
    const m = hash.match(/^#run-(\d+)/);
    if (m) {
      const runId = Number(m[1]);
      if (Number.isInteger(runId)) {
        setExpanded(prev => new Set(prev).add(runId));
        // Scroll the row into view after the next paint so the table has
        // had time to render the rows.
        setTimeout(() => {
          const el = document.getElementById(`run-${runId}`);
          if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }, 100);
      }
    }
  }, [location.hash, runs]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setError('');
      setNotFound(false);
      try {
        const params = new URLSearchParams();
        if (statusKey) params.set('status', statusKey);
        if (sinceKey)  params.set('since', sinceKey);
        const r = await api.get(`/plugins/${id}/runs?${params.toString()}`);
        if (cancelled) return;
        setRuns(r.data.data || []);
        if (r.data.plugin?.name) setPluginName(r.data.plugin.name);
      } catch (err) {
        if (cancelled) return;
        if (err.response?.status === 403 && err.response.data?.code === 'FEATURE_DISABLED') {
          setFeatureDisabled(true);
        } else if (err.response?.status === 404) {
          setNotFound(true);
        } else {
          setError(err.response?.data?.error || err.message || 'Failed to load runs');
        }
      }
    })();
    return () => { cancelled = true; };
  }, [id, statusKey, sinceKey, reloadTick]);

  const toggleExpanded = (runId) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(runId)) next.delete(runId);
      else next.add(runId);
      return next;
    });
  };

  const headline = useMemo(() => {
    const windowLabel = TIME_WINDOWS.find(w => w.key === sinceKey)?.label.toLowerCase() || 'last 24h';
    return pluginName
      ? `${pluginName} — ${windowLabel}`
      : `Plugin runs — ${windowLabel}`;
  }, [pluginName, sinceKey]);

  if (featureDisabled) {
    return (
      <div className="min-h-screen bg-gray-50">
        <Nav active="plugins" />
        <Container size="narrow">
          <Alert tone="warning" icon="lock" title="Plugins are not enabled for your organization">
            Ask your admin to flip <code className="bg-warning-100 px-1 rounded">plugins_enabled</code> at /admin/feature-flags.
          </Alert>
        </Container>
      </div>
    );
  }

  if (notFound) {
    return (
      <div className="min-h-screen bg-gray-50">
        <Nav active="plugins" />
        <Container size="narrow">
          <Card padding="none">
            <EmptyState
              icon="search"
              title="We couldn't find that plugin"
              message="It may have been deleted, or it belongs to a different workspace."
              action={<Button onClick={() => navigate('/plugins')}>Back to plugins</Button>}
            />
          </Card>
        </Container>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <Nav active="plugins" />
      <Container>
        <PageHeader
          breadcrumb={[{ label: 'Plugins', to: '/plugins' }, { label: 'Plugin', to: `/plugins/${id}` }, { label: 'Runs' }]}
          title={headline}
          subtitle="Each row is one time your plugin ran. Click a row to see what happened."
          primaryAction={<Button as={Link} to={`/plugins/${id}`} variant="secondary" icon="edit">Edit plugin</Button>}
          secondaryActions={[{ label: 'All plugins', icon: 'arrow-left', inline: true, as: Link, to: '/plugins' }]}
        />

        <div className="space-y-6">
          {/* Filter row — status pills + time window dropdown. */}
          <Card padding="sm">
            <div className="flex items-center gap-3 flex-wrap">
              <div className="flex gap-1.5 flex-wrap" role="group" aria-label="Filter by outcome">
                {STATUS_PILLS.map(p => (
                  <Button
                    key={p.key}
                    size="sm"
                    variant={statusKey === p.key ? 'primary' : 'secondary'}
                    aria-pressed={statusKey === p.key}
                    onClick={() => setStatusKey(p.key)}
                  >
                    {p.label}
                  </Button>
                ))}
              </div>
              <div className="flex-1" />
              <Select
                size="sm"
                wrapperClassName="w-40"
                aria-label="Time window"
                value={sinceKey}
                onChange={e => setSinceKey(e.target.value)}
                options={TIME_WINDOWS.map(w => ({ value: w.key, label: w.label }))}
              />
            </div>
          </Card>

          {error && <Alert tone="danger" onDismiss={() => setError('')}>{error}</Alert>}

          {/* Runs table or empty state. */}
          {runs == null ? (
            <Card><Skeleton lines={5} /></Card>
          ) : runs.length === 0 ? (
            <Card padding="none">
              <EmptyState
                icon="sparkles"
                title="No runs yet"
                message={
                  <>
                    Trigger this plugin from the chat at <code className="bg-gray-100 px-1 rounded">/chat</code> with
                    {' "'}run my {pluginName || 'plugin'}{'"'},
                    or visit the plugin page to set up automatic triggers.
                  </>
                }
                action={<Button icon="chat" onClick={() => navigate('/chat')}>Go to chat</Button>}
              />
            </Card>
          ) : (
            <Card padding="none" className="overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm min-w-[640px]">
                  <thead>
                    <tr>
                      <th className={TH}>When</th>
                      <th className={TH}>Status</th>
                      <th className={TH}>Triggered by</th>
                      <th className={TH}>
                        <Tip text="How long this took to run, in milliseconds.">Took</Tip>
                      </th>
                      <th className={`${TH} text-right`}>
                        <Tip text="How many times this plugin asked the database for data. There's a safety cap of 50 per run.">DB queries</Tip>
                      </th>
                      <th className={TH}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {runs.map(r => (
                      <RunRow
                        key={r.id}
                        run={r}
                        pluginId={id}
                        expanded={expanded.has(r.id)}
                        onToggle={() => toggleExpanded(r.id)}
                        onApplied={() => setReloadTick(t => t + 1)}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          <div className="text-xs text-gray-500 space-y-1">
            <p>
              <strong>What's a "limit"?</strong> Plugins have safety caps — at most 50 database queries per run,
              128 MB of memory, and 5 seconds of wall-clock time. When a run hits one of those caps, the plugin
              usually needs to be made more focused — read fewer records, or filter sooner.
            </p>
            <p>
              Need help reading a run? Open <Link to="/chat" className="text-brand-blue hover:underline">the chat</Link> and ask
              "what does run #N mean for plugin {pluginName || id}?".
            </p>
          </div>
        </div>
      </Container>
    </div>
  );
}
