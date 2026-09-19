// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// WorkspaceBuilder — "Describe how your business sells. I'll build your CRM."
//
// The first-run moment spec 203 is built around. Three screens:
//   compose  → a textarea + starting-template chips
//   review   → the plan the planner returned: pipeline, fields, automations,
//              views, each a checkbox (on by default) with the plain-English
//              summary the apply endpoint will re-validate
//   applying → every checked proposal POSTed, in order, to the ONE existing
//              writer (/ai/actions/apply) with per-item status; then a done
//              state with where to go next.
//
// Nothing is written until "Build my CRM". The plan itself is read-only
// (POST /onboarding/plan makes one AI call and returns validated proposals).
// A member can see the plan but the apply pieces are owner/admin-gated —
// `can_apply` from the server drives the copy, not a client-side guess.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api';
import { useAuth } from '../AuthContext';
import { Alert, Button, Icon, Spinner, Textarea } from './ui';

const PLACEHOLDER =
  'We sell to other businesses. Leads come in from referrals and our website. A rep qualifies them on a call, sends a proposal, and most deals negotiate on price before we win or lose. We track the amount, expected close date, and where the lead came from. If a deal goes quiet for two weeks, the rep should get a nudge.';

const MIN_CHARS = 12;

const KIND_META = {
  pipeline:   { title: 'Pipeline',    hint: 'The stages a deal moves through. Replaces the default board.' },
  field:      { title: 'Fields',      hint: 'Custom fields on deals, companies, or contacts.' },
  automation: { title: 'Automations', hint: 'When X happens, do Y — runs on the automation tick.' },
  view:       { title: 'Saved views', hint: 'Filtered tabs on the deals list, shared with your team.' },
};
const KIND_ORDER = ['pipeline', 'field', 'automation', 'view'];

const PLANNING_LINES = [
  'Reading how you sell…',
  'Sketching your pipeline…',
  'Picking the fields that matter…',
  'Wiring up the follow-ups…',
];

function planErrorMessage(err) {
  const status = err?.response?.status;
  const body = err?.response?.data || {};
  if (status === 402) return { tone: 'warning', title: 'AI needs to be switched on first.', body: 'The builder runs on AI. Start your plan (or paste your own Anthropic key) and come straight back.', action: { to: '/settings#billing', label: 'Open Plan & Billing' } };
  if (status === 429) return { tone: 'warning', title: 'You have hit the AI limit for now.', body: body.error || 'Try again in a bit.' };
  if (status === 503) return { tone: 'warning', title: "AI isn't activated on this deployment.", body: 'Ask your operator to set an Anthropic key. The rest of the CRM works without it.' };
  if (status === 422) return { tone: 'danger', title: "I couldn't turn that into a plan.", body: 'Try again, or add a sentence or two about how a deal moves from first contact to closed.' };
  if (status === 400) return { tone: 'danger', title: 'Tell me a little more.', body: body.error || 'A couple of sentences is plenty.' };
  return { tone: 'danger', title: 'Something went wrong drafting your CRM.', body: body.error || err?.message || 'Please try again.' };
}

function TemplateChip({ t, selected, onClick, disabled }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={selected}
      className={
        'text-left rounded-xl border px-3 py-2 text-sm transition disabled:opacity-50 min-h-[44px] ' +
        (selected
          ? 'border-brand-blue bg-brand-blue/5 text-brand-blue-dark shadow-sm'
          : 'border-gray-200 bg-white text-gray-700 hover:border-brand-blue/60 hover:bg-brand-blue/5')
      }
    >
      <span className="block font-medium leading-tight">{t.name}</span>
      <span className="block text-xs text-gray-500 mt-0.5 leading-snug">{t.tagline}</span>
    </button>
  );
}

function StatusDot({ status }) {
  if (status === 'applying') return <Spinner size="sm" className="text-brand-blue" />;
  if (status === 'done') return <span className="inline-flex w-5 h-5 rounded-full bg-success-600 text-white items-center justify-center"><Icon name="check" size={12} /></span>;
  if (status === 'failed') return <span className="inline-flex w-5 h-5 rounded-full bg-danger-600 text-white items-center justify-center"><Icon name="x" size={12} /></span>;
  return <span className="inline-block w-5 h-5 rounded-full border border-gray-300" aria-hidden="true" />;
}

// initialTemplate: { kind: 'static', id } preselects a starting description;
// { kind: 'saved', id } switches the builder into saved-template mode — the
// plan comes from POST /workspace-templates/:id/plan (deterministic, no AI)
// and there is nothing to type. `/setup?template=<static id>` and
// `/setup?template=wt:<id>` map onto these (pages/Setup.js).
export default function WorkspaceBuilder({ onDone, className = '', initialTemplate = null }) {
  const { refreshPipeline, orgRole, user } = useAuth();
  const [templates, setTemplates] = useState([]);
  const [savedTemplates, setSavedTemplates] = useState([]);
  const [templateId, setTemplateId] = useState(initialTemplate?.kind === 'static' ? initialTemplate.id : null);
  const [savedId, setSavedId] = useState(initialTemplate?.kind === 'saved' ? Number(initialTemplate.id) : null);
  const [description, setDescription] = useState('');
  const [phase, setPhase] = useState('compose'); // compose | planning | review | applying | done
  const [plan, setPlan] = useState(null);
  const [planTemplate, setPlanTemplate] = useState(null);
  const [canApply, setCanApply] = useState(true);
  const [checked, setChecked] = useState({});
  const [error, setError] = useState(null);
  const [results, setResults] = useState({}); // idx → { status, error?, open_path?, open_label? }
  const [lineIdx, setLineIdx] = useState(0);
  const cancelledRef = useRef(false);

  useEffect(() => {
    let alive = true;
    api.get('/onboarding/templates')
      .then((r) => { if (alive) setTemplates(r.data?.templates || []); })
      .catch(() => { /* chips are a convenience; the textarea still works */ });
    api.get('/workspace-templates', { params: { scope: 'all' } })
      .then((r) => { if (alive) setSavedTemplates(r.data?.templates || []); })
      .catch(() => { /* saved templates are optional */ });
    return () => { alive = false; };
  }, []);

  const savedSelected = useMemo(() => savedTemplates.find((t) => t.id === savedId) || null, [savedTemplates, savedId]);

  useEffect(() => {
    if (phase !== 'planning') return undefined;
    setLineIdx(0);
    const t = setInterval(() => setLineIdx((i) => (i + 1) % PLANNING_LINES.length), 1800);
    return () => clearInterval(t);
  }, [phase]);

  const trimmed = description.trim();
  const canDraft = phase === 'compose' && (savedId || templateId || trimmed.length >= MIN_CHARS);

  const draft = useCallback(async () => {
    setError(null);
    setPhase('planning');
    try {
      const r = savedId
        ? await api.post(`/workspace-templates/${savedId}/plan`, {})
        : await api.post('/onboarding/plan', {
          description: trimmed || undefined,
          template_id: templateId || undefined,
        });
      const p = r.data?.plan || { proposals: [], skipped: [], notes: [] };
      setPlan(p);
      setPlanTemplate(r.data?.template || null);
      setCanApply(r.data?.can_apply !== false);
      const init = {};
      p.proposals.forEach((_, i) => { init[i] = true; });
      setChecked(init);
      setResults({});
      setPhase('review');
    } catch (err) {
      if (savedId && err?.response?.status === 404) {
        setError({ tone: 'danger', title: "That template isn't available.", body: 'It may have been deleted or made private. Pick another, or describe your business instead.' });
        setSavedId(null);
      } else {
        setError(planErrorMessage(err));
      }
      setPhase('compose');
    }
  }, [trimmed, templateId, savedId]);

  const selectedCount = useMemo(() => Object.values(checked).filter(Boolean).length, [checked]);

  const build = useCallback(async () => {
    if (!plan) return;
    cancelledRef.current = false;
    setPhase('applying');
    const order = plan.proposals.map((p, i) => ({ p, i })).filter(({ i }) => checked[i]);
    const next = {};
    order.forEach(({ i }) => { next[i] = { status: 'pending' }; });
    setResults({ ...next });
    let pipelineApplied = false;
    for (const { p, i } of order) {
      if (cancelledRef.current) break;
      next[i] = { status: 'applying' };
      setResults({ ...next });
      try {
        const r = await api.post('/ai/actions/apply', { proposal: p.proposal });
        const applied = r.data?.applied || r.data || {};
        next[i] = { status: 'done', open_path: applied.open_path || r.data?.open_path, open_label: applied.open_label || r.data?.open_label };
        if (p.kind === 'pipeline') pipelineApplied = true;
      } catch (err) {
        const body = err?.response?.data || {};
        next[i] = {
          status: 'failed',
          error: body.detail || (Array.isArray(body.validation_errors) ? body.validation_errors.join('; ') : null) || body.error || 'Could not apply.',
        };
      }
      setResults({ ...next });
    }
    if (pipelineApplied && typeof refreshPipeline === 'function') {
      try { await refreshPipeline(); } catch { /* the board refetches on mount anyway */ }
    }
    setPhase('done');
    if (typeof onDone === 'function') {
      const built = Object.values(next).filter((r) => r.status === 'done').length;
      onDone({ built, failed: Object.values(next).filter((r) => r.status === 'failed').length });
    }
  }, [plan, checked, refreshPipeline, onDone]);

  const startOver = () => {
    cancelledRef.current = true;
    setPhase('compose');
    setPlan(null);
    setPlanTemplate(null);
    setSavedId(null);
    setResults({});
    setError(null);
  };

  const grouped = useMemo(() => {
    if (!plan) return [];
    return KIND_ORDER
      .map((kind) => ({ kind, items: plan.proposals.map((p, i) => ({ p, i })).filter(({ p }) => p.kind === kind) }))
      .filter((g) => g.items.length > 0);
  }, [plan]);

  const isAdmin = orgRole === 'owner' || orgRole === 'admin' || user?.org_role === 'owner' || user?.org_role === 'admin';

  // ---------------------------------------------------------------- compose
  if (phase === 'compose' || phase === 'planning') {
    const planning = phase === 'planning';
    return (
      <div className={`bg-white border border-gray-200 rounded-xl shadow-sm p-4 sm:p-5 ${className}`} data-testid="workspace-builder">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 inline-flex w-8 h-8 rounded-full bg-brand-blue/10 text-brand-blue items-center justify-center flex-shrink-0">
            <Icon name="sparkles" size={16} />
          </span>
          <div className="min-w-0">
            <h2 className="text-base sm:text-lg font-semibold text-gray-900">How does your business sell?</h2>
            <p className="text-xs sm:text-sm text-gray-500 mt-0.5">
              A few plain sentences — who buys, how a deal moves, what you track, when someone should get a nudge. I'll turn it into your pipeline, fields, and follow-ups. Nothing changes until you approve it.
            </p>
          </div>
        </div>

        {error && (
          <Alert
            tone={error.tone}
            title={error.title}
            className="mt-3"
            onDismiss={() => setError(null)}
            action={error.action ? <Link to={error.action.to} className="text-xs font-medium text-brand-blue hover:underline whitespace-nowrap">{error.action.label}</Link> : undefined}
          >
            {error.body}
          </Alert>
        )}

        {savedId ? (
          <div className="mt-4 rounded-xl border border-brand-blue/40 bg-brand-blue/5 p-4" data-testid="saved-template-mode">
            <div className="text-[11px] uppercase tracking-wide text-brand-blue-dark mb-1">Starting from a saved template</div>
            {savedSelected ? (
              <>
                <div className="text-sm font-semibold text-gray-900">{savedSelected.name}</div>
                {savedSelected.tagline && <div className="text-xs text-gray-600 mt-0.5">{savedSelected.tagline}</div>}
                {savedSelected.stages?.length > 0 && <div className="text-xs text-gray-700 mt-2 break-words"><span className="text-gray-400">Stages · </span>{savedSelected.stages.join(' → ')}</div>}
              </>
            ) : (
              <div className="text-sm text-gray-700">Template #{savedId}</div>
            )}
            <p className="text-xs text-gray-500 mt-2">No AI needed for this one — the plan is the template, checked against your workspace. You can untick pieces before building, and reshape anything afterwards in chat.</p>
            <button type="button" className="mt-2 text-xs font-medium text-brand-blue hover:underline" onClick={() => setSavedId(null)} disabled={planning}>Describe my business instead</button>
          </div>
        ) : (
          <>
            {savedTemplates.length > 0 && (
              <div className="mt-4">
                <div className="flex items-baseline justify-between gap-2 mb-1.5">
                  <div className="text-[11px] uppercase tracking-wide text-gray-400">Start from a saved template</div>
                  <Link to="/templates" className="text-[11px] text-brand-blue hover:underline">All templates</Link>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2" data-testid="saved-template-chips">
                  {savedTemplates.slice(0, 6).map((t) => (
                    <TemplateChip
                      key={`wt-${t.id}`}
                      t={{ name: t.name, tagline: t.tagline || (t.stages?.length ? t.stages.slice(0, 4).join(' → ') + (t.stages.length > 4 ? ' → …' : '') : 'Saved workspace setup') }}
                      selected={false}
                      disabled={planning}
                      onClick={() => { setSavedId(t.id); setTemplateId(null); }}
                    />
                  ))}
                </div>
              </div>
            )}

            {templates.length > 0 && (
              <div className="mt-4">
                <div className="text-[11px] uppercase tracking-wide text-gray-400 mb-1.5">Or start from a business like yours</div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2" data-testid="template-chips">
                  {templates.map((t) => (
                    <TemplateChip
                      key={t.id}
                      t={t}
                      selected={templateId === t.id}
                      disabled={planning}
                      onClick={() => setTemplateId(templateId === t.id ? null : t.id)}
                    />
                  ))}
                </div>
              </div>
            )}

            <div className="mt-4">
              <Textarea
                label={templateId ? 'Anything to add or change? (optional)' : 'In your own words'}
                rows={templateId ? 3 : 5}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={templateId ? 'e.g. We also sell through resellers, and every deal needs a site address.' : PLACEHOLDER}
                disabled={planning}
                maxLength={4000}
                data-testid="builder-description"
              />
            </div>
          </>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button onClick={draft} disabled={!canDraft || planning} loading={planning} icon="sparkles" size="lg">
            {planning ? (savedId ? 'Checking against your workspace…' : PLANNING_LINES[lineIdx]) : savedId ? 'Show me the plan' : 'Draft my CRM'}
          </Button>
          {!savedId && !templateId && trimmed.length > 0 && trimmed.length < MIN_CHARS && (
            <span className="text-xs text-gray-400">A little more — at least a sentence.</span>
          )}
          {!isAdmin && (
            <span className="text-xs text-gray-500">You can draft a plan; an owner or admin applies it.</span>
          )}
        </div>
      </div>
    );
  }

  // ------------------------------------------------------------ review/apply
  const applying = phase === 'applying';
  const done = phase === 'done';
  const builtCount = Object.values(results).filter((r) => r.status === 'done').length;
  const failedCount = Object.values(results).filter((r) => r.status === 'failed').length;
  const nothingToBuild = !plan || plan.proposals.length === 0;

  return (
    <div className={`bg-white border border-gray-200 rounded-xl shadow-sm p-4 sm:p-5 ${className}`} data-testid="workspace-builder">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 inline-flex w-8 h-8 rounded-full bg-brand-blue/10 text-brand-blue items-center justify-center flex-shrink-0">
          <Icon name={done ? 'check' : 'sparkles'} size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-base sm:text-lg font-semibold text-gray-900">
            {done
              ? (failedCount === 0 ? 'Your CRM is set up.' : `Built ${builtCount} of ${builtCount + failedCount}.`)
              : nothingToBuild ? (planTemplate ? 'Nothing new to add from this template.' : 'I need a little more.')
                : planTemplate ? `From "${planTemplate.name}"` : "Here's what I'd set up."}
          </h2>
          <p className="text-sm text-gray-600 mt-1" data-testid="plan-narrative">{plan?.narrative}</p>
        </div>
      </div>

      {plan?.notes?.length > 0 && !done && (
        <Alert tone="info" className="mt-3">
          <ul className="list-disc pl-4 space-y-0.5">{plan.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
        </Alert>
      )}

      {!canApply && !nothingToBuild && !done && (
        <Alert tone="warning" title="Only an owner or admin can apply this" className="mt-3">
          Ask them to open <span className="font-medium">Setup</span> and describe the same process — or have them make you an admin.
        </Alert>
      )}

      {!nothingToBuild && (
        <div className="mt-4 space-y-4" data-testid="plan-groups">
          {grouped.map(({ kind, items }) => (
            <section key={kind}>
              <div className="flex items-baseline justify-between gap-2 mb-1.5">
                <h3 className="text-sm font-semibold text-gray-900">{KIND_META[kind].title}</h3>
                <span className="text-[11px] text-gray-400">{KIND_META[kind].hint}</span>
              </div>
              <ul className="divide-y divide-gray-100 border border-gray-100 rounded-lg">
                {items.map(({ p, i }) => {
                  const r = results[i];
                  return (
                    <li key={i} className="flex items-start gap-3 px-3 py-2.5">
                      {applying || done ? (
                        <span className="mt-0.5 flex-shrink-0"><StatusDot status={r?.status || (checked[i] ? 'pending' : 'skipped')} /></span>
                      ) : (
                        <input
                          type="checkbox"
                          className="mt-1 h-4 w-4 rounded border-gray-300 text-brand-blue focus:ring-brand-blue"
                          checked={!!checked[i]}
                          onChange={(e) => setChecked((c) => ({ ...c, [i]: e.target.checked }))}
                          aria-label={`Include: ${p.label}`}
                          data-testid={`proposal-check-${i}`}
                        />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="text-sm text-gray-900">{p.summary}</div>
                        {p.detail && <div className="text-xs text-gray-500 mt-0.5 break-words">{p.detail}</div>}
                        {p.why && !p.detail && <div className="text-xs text-gray-500 mt-0.5">{p.why}</div>}
                        {r?.status === 'failed' && <div className="text-xs text-danger-700 mt-1">{r.error}</div>}
                        {r?.status === 'done' && r.open_path && (
                          <Link to={r.open_path} className="text-xs font-medium text-brand-blue hover:underline">{r.open_label || 'Open'}</Link>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}

      {plan?.skipped?.length > 0 && !done && (
        <details className="mt-3 text-xs text-gray-500">
          <summary className="cursor-pointer select-none">{plan.skipped.length} thing{plan.skipped.length === 1 ? '' : 's'} I left out</summary>
          <ul className="mt-1.5 list-disc pl-4 space-y-0.5">
            {plan.skipped.map((s, i) => <li key={i}><span className="text-gray-700">{s.label}</span> — {s.reason}</li>)}
          </ul>
        </details>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {!done && !nothingToBuild && (
          <Button onClick={build} disabled={applying || !canApply || selectedCount === 0} loading={applying} icon="check" size="lg" data-testid="build-button">
            {applying ? 'Building…' : `Build my CRM${selectedCount ? ` (${selectedCount})` : ''}`}
          </Button>
        )}
        {done && (
          <>
            <Button as={Link} to="/deals" icon="arrow-right" size="lg">Open your deal board</Button>
            <Button as={Link} to="/import" variant="secondary">Import contacts</Button>
            <Button as={Link} to="/chat" variant="secondary">Ask the copilot</Button>
          </>
        )}
        {!applying && (
          <Button variant="ghost" onClick={startOver}>{done ? 'Describe it differently' : 'Start over'}</Button>
        )}
      </div>
    </div>
  );
}
