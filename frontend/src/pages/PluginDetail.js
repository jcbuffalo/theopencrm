// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Plugin detail page — Overview / Code / Runs.
// Closes the plugin UX loop without pulling in Monaco. The code editor is a
// textarea with a monospace font and pre-wrap; sufficient for the pitch and
// good enough for the kinds of small JS files plugins will be.

import React, { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import api from '../api';
import Nav from '../components/Nav';
import { Alert, Button, Card, Container, Modal, PageHeader, Skeleton, StatusBadge, Tabs, Textarea } from '../components/ui';

const STATUS_TONE = {
  draft:     'neutral',
  active:    'success',
  suspended: 'warning',
  errored:   'error',
};

const RUN_TONE = {
  success:                   'success',
  ok:                        'success',
  running:                   'info',
  error:                     'error',
  timeout:                   'warning',
  memory_exceeded:           'warning',
  killed:                    'warning',
  quota_exceeded:            'warning',
  // Red tones for the runtime-hardening rejections: these mean the plugin
  // was actively abusive (too many queries) or the org's concurrency
  // budget was saturated — both worth more visual urgency than the soft
  // amber of a timeout.
  db_query_limit_exceeded:   'error',
  concurrency_limit_exceeded:'error',
  rejected:                  'neutral',
};

function RunStatusBadge({ status }) {
  return <StatusBadge tone={RUN_TONE[status] || 'neutral'} label={status || 'unknown'} className="uppercase" />;
}

// Render one proposed write as a before → after diff card. This is the
// confirm-first review surface: the plugin PROPOSED these changes during a
// preview run; nothing is written until the user clicks Apply.
function ProposedChange({ action }) {
  const isCreate = action.op === 'create';
  const before = action.before || {};
  const fields = action.fields || {};
  return (
    <div className="border border-gray-200 rounded bg-white p-2.5">
      <div className="text-xs font-semibold text-gray-800">
        {action.summary || `${action.op} ${action.entity}`}
      </div>
      <div className="mt-1.5 space-y-0.5">
        {Object.keys(fields).map((k) => (
          <div key={k} className="text-[11px] font-mono flex flex-wrap items-center gap-1">
            <span className="text-gray-500">{k}:</span>
            {!isCreate && (
              <>
                <span className="text-danger-600 line-through break-all">{formatVal(before[k])}</span>
                <span className="text-gray-400">→</span>
              </>
            )}
            <span className="text-success-700 break-all">{formatVal(fields[k])}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function formatVal(v) {
  if (v === null || v === undefined) return '∅';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

const MONO = 'font-mono text-xs';

/**
 * Modal that collects an optional JSON `input` payload and posts to
 * /api/plugins/:id/run (CONFIRM-FIRST preview). The run executes live in the
 * sandbox but any write the plugin attempts is returned as a PROPOSAL, not
 * committed. If there are proposals, the user reviews the diff and clicks
 * "Apply" (POST /:id/apply) to commit them.
 */
function RunModal({ pluginId, onClose, onComplete }) {
  const [inputText, setInputText] = useState('{}');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [err, setErr] = useState('');
  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState(null);
  const [applyErr, setApplyErr] = useState('');

  const proposals = Array.isArray(result?.proposed_actions) ? result.proposed_actions : [];
  const applied = !!applyResult;

  const doRun = async () => {
    setErr('');
    setResult(null);
    setApplyResult(null);
    setApplyErr('');
    let input = null;
    if (inputText.trim()) {
      try { input = JSON.parse(inputText); }
      catch (e) { setErr('Input is not valid JSON: ' + e.message); return; }
    }
    setBusy(true);
    try {
      const r = await api.post(`/plugins/${pluginId}/run`, { input });
      setResult(r.data.result);
      if (onComplete) onComplete();
    } catch (e) {
      const data = e.response?.data;
      if (data?.result) {
        setResult(data.result);
        if (onComplete) onComplete();
      } else {
        setErr(data?.error || e.message || 'Run failed');
      }
    } finally {
      setBusy(false);
    }
  };

  const doApply = async () => {
    if (!result?.runId) return;
    setApplyErr('');
    setApplying(true);
    try {
      const r = await api.post(`/plugins/${pluginId}/apply`, { runId: result.runId });
      setApplyResult(r.data.result);
      if (onComplete) onComplete();
    } catch (e) {
      setApplyErr(e.response?.data?.error || e.message || 'Apply failed');
    } finally {
      setApplying(false);
    }
  };

  const ok = result?.status === 'success';

  return (
    <Modal
      open
      onClose={onClose}
      title="Run plugin"
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy || applying}>Close</Button>
          <Button onClick={doRun} disabled={applying} loading={busy} loadingLabel="Running…">
            {result ? 'Preview again' : 'Preview run'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Textarea
          label="Input (JSON, optional)"
          value={inputText}
          onChange={e => setInputText(e.target.value)}
          rows={6}
          className={MONO}
          spellCheck={false}
          placeholder='{ "dealId": 123 }'
          hint={
            <>
              The plugin's code reads this via <code>input</code> (e.g. <code>input.dealId</code>).
              Runs are a <strong>preview</strong>: any change the plugin makes is staged for your approval, not written yet.
            </>
          }
        />
        {err && <Alert tone="danger" onDismiss={() => setErr('')}>{err}</Alert>}
        {result && (
          <Alert tone={ok ? 'success' : 'warning'} icon={false}>
            <div className="font-semibold flex items-center gap-2 flex-wrap">
              <RunStatusBadge status={result.status} />
              <span>Run #{result.runId} · {result.cpu_ms}ms · {result.db_queries} db queries</span>
            </div>
            {result.error && (
              <div className="mt-2 text-xs"><strong>Error:</strong> {result.error}</div>
            )}
            {Array.isArray(result.logs) && result.logs.length > 0 && (
              <div className="mt-2">
                <div className="text-xs font-semibold mb-1">Logs:</div>
                <pre className="text-[11px] bg-white/60 border border-current/20 rounded p-2 max-h-40 overflow-auto whitespace-pre-wrap break-words">{result.logs.join('\n')}</pre>
              </div>
            )}
            {result.output !== null && result.output !== undefined && (
              <div className="mt-2">
                <div className="text-xs font-semibold mb-1">Output:</div>
                <pre className="text-[11px] bg-white/60 border border-current/20 rounded p-2 max-h-60 overflow-auto whitespace-pre-wrap break-words">{JSON.stringify(result.output, null, 2)}</pre>
              </div>
            )}
          </Alert>
        )}

        {/* Confirm-first review: proposed writes, awaiting Apply. */}
        {result && result.status === 'success' && (
          proposals.length === 0 ? (
            <div className="rounded p-2.5 text-xs border border-gray-200 bg-gray-50 text-gray-600">
              This run proposed no changes to your data (read-only).
            </div>
          ) : (
            <div className="rounded border border-info-200 bg-info-50 p-3">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="text-sm font-semibold text-info-900">
                  {proposals.length} proposed change{proposals.length === 1 ? '' : 's'} — not written yet
                </div>
                {!applied && (
                  <Button size="sm" onClick={doApply} loading={applying} loadingLabel="Applying…">
                    Apply {proposals.length} change{proposals.length === 1 ? '' : 's'}
                  </Button>
                )}
              </div>
              <div className="mt-2 space-y-1.5">
                {proposals.map((a, i) => <ProposedChange key={i} action={a} />)}
              </div>
              {applyErr && <Alert tone="danger" className="mt-2">{applyErr}</Alert>}
              {applied && (
                <Alert tone="success" className="mt-2">
                  Applied {applyResult.applied_count} of {applyResult.total} change{applyResult.total === 1 ? '' : 's'}.
                  {applyResult.applied_count < applyResult.total && ' Some records could not be written (they may have changed since the preview).'}
                </Alert>
              )}
            </div>
          )
        )}
      </div>
    </Modal>
  );
}

export default function PluginDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [plugin, setPlugin] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('overview');
  const [editing, setEditing] = useState(false);
  const [draftSpec, setDraftSpec] = useState('');
  const [draftCode, setDraftCode] = useState('');
  const [saving, setSaving] = useState(false);
  const [runResult, setRunResult] = useState(null);
  const [showRunModal, setShowRunModal] = useState(false);
  const [runs, setRuns] = useState(null);
  const [runsLoading, setRunsLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const r = await api.get(`/plugins/${id}`);
      setPlugin(r.data.data);
      setDraftSpec(JSON.stringify(r.data.data.spec_json || {}, null, 2));
      setDraftCode(r.data.data.source_code || '');
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to load plugin');
    } finally {
      setLoading(false);
    }
  };

  // Fetch up to 50 most recent runs from the dedicated endpoint. Used by
  // the Runs tab; lazy-loaded so we don't pay for it on the Overview tab.
  const loadRuns = async () => {
    setRunsLoading(true);
    try {
      const r = await api.get(`/plugins/${id}/runs?limit=50`);
      setRuns(r.data.data || []);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load runs');
    } finally {
      setRunsLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [id]);

  // Lazy-load the runs list when the user opens the Runs tab.
  useEffect(() => {
    if (tab === 'runs' && runs === null && !runsLoading) {
      loadRuns();
    }
    // eslint-disable-next-line
  }, [tab]);

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      let parsed = null;
      try { parsed = JSON.parse(draftSpec); }
      catch { throw new Error('Spec JSON is not valid. Fix the syntax and try again.'); }
      await api.put(`/plugins/${id}`, {
        spec_json: parsed,
        source_code: draftCode || null,
      });
      setEditing(false);
      await load();
    } catch (err) {
      setError(err.message || err.response?.data?.error || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const setStatus = async (next) => {
    try {
      await api.put(`/plugins/${id}`, { status: next });
      await load();
    } catch (err) {
      setError(err.response?.data?.error || 'Status change failed');
    }
  };

  const remove = async () => {
    if (!window.confirm('Delete this plugin? This cannot be undone.')) return;
    try {
      await api.delete(`/plugins/${id}`);
      navigate('/plugins');
    } catch (err) {
      setError(err.response?.data?.error || 'Delete failed');
    }
  };

  const testRun = async () => {
    setRunResult(null);
    try {
      const r = await api.post(`/plugins/${id}/test-run`);
      setRunResult(r.data.result);
      // refresh the runs tab if it's open
      if (tab === 'runs') await loadRuns();
    } catch (err) {
      setRunResult({ ok: false, reason: 'request_failed', error: err.response?.data?.error || err.message });
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50">
        <Nav active="plugins" />
        <Container>
          <Skeleton lines={1} className="h-8 w-64 mb-6" />
          <Card><Skeleton lines={6} /></Card>
        </Container>
      </div>
    );
  }

  if (!plugin) {
    return (
      <div className="min-h-screen bg-gray-50">
        <Nav active="plugins" />
        <Container>
          <Alert tone="danger">{error || 'Plugin not found.'}</Alert>
          <Link to="/plugins" className="text-sm text-brand-blue hover:underline mt-4 inline-block">← Back to plugins</Link>
        </Container>
      </div>
    );
  }

  const runsCount = runs?.length ?? plugin.recent_runs?.length;

  // Status transitions live in the overflow menu; "Run" is the one primary CTA.
  const statusActions = [];
  if (plugin.status === 'draft') statusActions.push({ label: 'Activate', icon: 'check-circle', onClick: () => setStatus('active') });
  if (plugin.status === 'active') statusActions.push({ label: 'Suspend', icon: 'lock', onClick: () => setStatus('suspended') });
  if (plugin.status === 'suspended') statusActions.push({ label: 'Re-activate', icon: 'check-circle', onClick: () => setStatus('active') });

  return (
    <div className="min-h-screen bg-gray-50">
      <Nav active="plugins" />
      <Container>
        <PageHeader
          breadcrumb={[{ label: 'Plugins', to: '/plugins' }, { label: plugin.name }]}
          title={
            <span className="inline-flex items-center gap-2 flex-wrap">
              {plugin.name}
              <StatusBadge tone={STATUS_TONE[plugin.status] || 'neutral'} label={plugin.status} size="md" className="capitalize" />
              <span className="text-xs font-normal text-gray-500">{plugin.source_kind}</span>
            </span>
          }
          subtitle={plugin.description}
          primaryAction={{ label: 'Run', icon: 'sparkles', onClick: () => setShowRunModal(true) }}
          secondaryActions={[
            { label: 'Test run', icon: 'refresh', inline: true, onClick: testRun },
            ...statusActions,
            { type: 'divider' },
            { label: 'Delete', icon: 'trash', danger: true, onClick: remove },
          ]}
        />

        <div className="space-y-6">
          {error && <Alert tone="danger" onDismiss={() => setError('')}>{error}</Alert>}

          {runResult && (
            <Alert
              tone={runResult.ok ? 'success' : 'warning'}
              title={`Test run: ${runResult.ok ? 'ok' : runResult.reason || runResult.status || 'failed'}`}
              onDismiss={() => setRunResult(null)}
            >
              {Array.isArray(runResult.proposed_actions) && runResult.proposed_actions.length > 0 && (
                <p className="text-xs">
                  Proposed {runResult.proposed_actions.length} change{runResult.proposed_actions.length === 1 ? '' : 's'} (not written).
                  Use the <strong>Run</strong> button to review the diff and Apply.
                </p>
              )}
              {runResult.error && <p className="text-xs">{runResult.error}</p>}
              {runResult.runId && <p className="text-[11px] opacity-70">Recorded as run #{runResult.runId} (visible in the Runs tab).</p>}
            </Alert>
          )}

          <Tabs
            aria-label="Plugin sections"
            items={[
              { id: 'overview', label: 'Overview' },
              { id: 'code', label: 'Code' },
              { id: 'runs', label: 'Runs', count: runsCount || undefined },
            ]}
            value={tab}
            onChange={setTab}
          />

          {/* Overview */}
          {tab === 'overview' && (
            <Card>
              <div className="space-y-4">
                <Field label="Trigger" value={plugin.trigger_event ? <code className="bg-gray-100 px-1.5 py-0.5 rounded text-sm">{plugin.trigger_event}</code> : <span className="text-gray-400">none (manual only)</span>} />
                {plugin.trigger_filter_json && (
                  <Field label="Trigger filter" value={
                    <pre className="text-xs bg-gray-50 border border-gray-200 rounded p-2 overflow-x-auto">{JSON.stringify(plugin.trigger_filter_json, null, 2)}</pre>
                  } />
                )}
                <Field label="Spec JSON" value={
                  <pre className="text-xs bg-gray-50 border border-gray-200 rounded p-3 overflow-x-auto whitespace-pre-wrap break-words">{JSON.stringify(plugin.spec_json || {}, null, 2)}</pre>
                } />
                <Field label="Created" value={<span className="text-sm text-gray-700">{new Date(plugin.created_at).toLocaleString()} · v{plugin.entity_version || 1}</span>} />
                <Field label="Public ID" value={<code className="text-xs bg-gray-50 px-1.5 py-0.5 rounded">{plugin.public_id}</code>} />
              </div>
            </Card>
          )}

          {/* Code */}
          {tab === 'code' && (
            <Card
              title="Plugin source"
              subtitle="Edit the spec JSON and/or hand-written JS. Both persist; the runtime uses whichever your plugin author chose to provide."
              actions={
                !editing ? (
                  <Button size="sm" icon="edit" onClick={() => setEditing(true)}>Edit</Button>
                ) : (
                  <>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => { setEditing(false); setDraftSpec(JSON.stringify(plugin.spec_json || {}, null, 2)); setDraftCode(plugin.source_code || ''); }}
                      disabled={saving}
                    >
                      Cancel
                    </Button>
                    <Button size="sm" onClick={save} loading={saving} loadingLabel="Saving…">Save</Button>
                  </>
                )
              }
            >
              <div className="space-y-5">
                <Textarea
                  label="Spec JSON"
                  value={draftSpec}
                  onChange={e => setDraftSpec(e.target.value)}
                  readOnly={!editing}
                  rows={12}
                  className={`${MONO} ${editing ? '' : 'bg-gray-50'}`}
                  spellCheck={false}
                />
                <Textarea
                  label="Source code (optional)"
                  value={draftCode}
                  onChange={e => setDraftCode(e.target.value)}
                  readOnly={!editing}
                  rows={14}
                  placeholder={editing ? '// module.exports = { on: {...}, async run({ deal, crm, logger }) { /* ... */ } };' : '(none — this plugin runs from spec only)'}
                  className={`${MONO} ${editing ? '' : 'bg-gray-50'}`}
                  spellCheck={false}
                />
                <Alert tone="info" title="How runs work">
                  Plugins execute live in an isolated sandbox (128&nbsp;MB, 5s CPU, 50 DB queries/run, org-scoped reads/writes). Runs are <strong>confirm-first</strong> — any change your plugin makes to deals, contacts, companies, or tasks is captured as a <em>proposal</em> and shown as a diff. Nothing is written until you click <strong>Apply</strong>.
                </Alert>
              </div>
            </Card>
          )}

          {/* Runs */}
          {tab === 'runs' && (
            <Card
              padding="none"
              title="Recent runs"
              subtitle="Up to 50 most recent runs of this plugin."
              actions={
                <Button size="sm" variant="ghost" icon="refresh" onClick={loadRuns} loading={runsLoading} loadingLabel="Refreshing…">Refresh</Button>
              }
            >
              {runsLoading && runs === null ? (
                <div className="p-5"><Skeleton lines={4} /></div>
              ) : (!runs || runs.length === 0) ? (
                <div className="p-8 text-center text-sm text-gray-500">No runs yet. Use the "Run" button above.</div>
              ) : (
                <div className="divide-y divide-gray-100">
                  {runs.map(r => <RunRow key={r.id} run={r} pluginId={id} onApplied={loadRuns} />)}
                </div>
              )}
            </Card>
          )}
        </div>
      </Container>
      {showRunModal && (
        <RunModal
          pluginId={id}
          onClose={() => setShowRunModal(false)}
          onComplete={() => {
            // After a successful run, refresh the runs list if the user
            // has it open so they see the new row without manual refresh.
            if (tab === 'runs') loadRuns();
          }}
        />
      )}
    </div>
  );
}

// Expandable run row — shows the run summary inline and lets the user click
// to see the captured input / output / logs JSON. We expand inline rather
// than navigating to a separate page because each run is small and the user
// is typically iterating quickly.
function RunRow({ run, pluginId, onApplied }) {
  const [expanded, setExpanded] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyErr, setApplyErr] = useState('');
  const elapsed = run.ended_at && run.started_at
    ? new Date(run.ended_at).getTime() - new Date(run.started_at).getTime()
    : null;
  const proposals = Array.isArray(run.proposed_actions) ? run.proposed_actions : [];
  const pending = proposals.length > 0 && !run.applied_at;

  const doApply = async (e) => {
    e.stopPropagation();
    setApplyErr('');
    setApplying(true);
    try {
      await api.post(`/plugins/${pluginId}/apply`, { runId: run.id });
      if (onApplied) await onApplied();
    } catch (err) {
      setApplyErr(err.response?.data?.error || err.message || 'Apply failed');
      setApplying(false);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between gap-3 flex-wrap p-3 hover:bg-gray-50 transition-colors">
        <button
          type="button"
          onClick={() => setExpanded(v => !v)}
          aria-expanded={expanded}
          className="text-left flex items-center gap-3 flex-1 min-w-0"
        >
          <RunStatusBadge status={run.status} />
          <div className="min-w-0">
            <div className="text-xs text-gray-700">
              {new Date(run.started_at).toLocaleString()}
              <span className="text-gray-400 ml-2">{run.trigger_source || run.trigger_kind || ''}</span>
            </div>
            {run.error_message && <div className="text-xs text-danger-600 mt-0.5 break-words">{run.error_message}</div>}
          </div>
        </button>
        <div className="flex items-center gap-2 flex-shrink-0">
          {pending && (
            <Button size="sm" onClick={doApply} loading={applying} loadingLabel="Applying…">
              Apply {proposals.length}
            </Button>
          )}
          {proposals.length > 0 && run.applied_at && (
            <StatusBadge tone="success" label="Applied" />
          )}
          <div className="text-[11px] text-gray-500">
            {(run.cpu_ms > 0 || elapsed) && <span>{run.cpu_ms || elapsed}ms · </span>}
            {run.db_queries > 0 && <span>{run.db_queries} db · </span>}
            <span>run #{run.id}</span>
          </div>
        </div>
      </div>
      {applyErr && <div className="px-3 pb-2 text-xs text-danger-600">{applyErr}</div>}
      {expanded && (
        <div className="px-3 pb-3 bg-gray-50 border-t border-gray-100 space-y-2">
          {proposals.length > 0 && (
            <div>
              <div className="text-[11px] uppercase tracking-wider text-gray-500 font-semibold mt-2 mb-1">
                Proposed changes {run.applied_at ? '(applied)' : '(not written)'}
              </div>
              <div className="space-y-1.5">
                {proposals.map((a, i) => <ProposedChange key={i} action={a} />)}
              </div>
            </div>
          )}
          {run.input_payload && (
            <div>
              <div className="text-[11px] uppercase tracking-wider text-gray-500 font-semibold mt-2 mb-1">Input</div>
              <pre className="text-[11px] bg-white border border-gray-200 rounded p-2 max-h-48 overflow-auto whitespace-pre-wrap break-words">{JSON.stringify(run.input_payload, null, 2)}</pre>
            </div>
          )}
          {run.output_payload && (
            <div>
              <div className="text-[11px] uppercase tracking-wider text-gray-500 font-semibold mb-1">Output</div>
              <pre className="text-[11px] bg-white border border-gray-200 rounded p-2 max-h-48 overflow-auto whitespace-pre-wrap break-words">{JSON.stringify(run.output_payload, null, 2)}</pre>
            </div>
          )}
          {Array.isArray(run.log_lines) && run.log_lines.length > 0 && (
            <div>
              <div className="text-[11px] uppercase tracking-wider text-gray-500 font-semibold mb-1">Logs</div>
              <pre className="text-[11px] bg-white border border-gray-200 rounded p-2 max-h-48 overflow-auto whitespace-pre-wrap break-words">{run.log_lines.join('\n')}</pre>
            </div>
          )}
          {!run.input_payload && !run.output_payload && (!run.log_lines || run.log_lines.length === 0) && proposals.length === 0 && (
            <div className="text-xs text-gray-500 py-2">No input / output / logs captured.</div>
          )}
        </div>
      )}
    </div>
  );
}

function Field({ label, value }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wider text-gray-500 font-semibold mb-1">{label}</div>
      <div>{value}</div>
    </div>
  );
}
