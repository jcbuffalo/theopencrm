// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import React, { useCallback, useEffect, useState } from 'react';
import api from '../api';
import Nav from '../components/Nav';
import { Alert, Button, Card, Container, EmptyState, Input, Modal, PageHeader, Select, Skeleton, StatusBadge } from '../components/ui';

// NPS/CSAT Surveys (CS-7) — create/manage surveys, mint copyable response
// links, and read results. Talks to /api/surveys (gated by
// customer_success_enabled; the page renders the gate state on 403).
//
// Nothing on this page auto-sends. "Generate links" mints pending response
// tokens you copy and share yourself; each link records exactly one response
// at the public /s/:token page.

const KIND_META = {
  nps:  { label: 'NPS',  hint: '0–10 · how likely to recommend' },
  csat: { label: 'CSAT', hint: '1–5 · how satisfied' },
};

function npsTone(nps) {
  if (nps == null) return 'text-gray-400';
  if (nps >= 30) return 'text-success-700';
  if (nps >= 0) return 'text-brand-blue';
  return 'text-danger-700';
}

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="secondary"
      size="sm"
      icon={copied ? 'check' : 'copy'}
      className="flex-shrink-0"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch { /* clipboard unavailable — the link is still visible to select */ }
      }}
    >
      {copied ? 'Copied' : 'Copy'}
    </Button>
  );
}

// --- Results panel: stats + score distribution + comments -------------------
function Results({ surveyId }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.get(`/surveys/${surveyId}`)
      .then((r) => setData(r.data))
      .catch(() => setError('Could not load results.'));
  }, [surveyId]);

  if (error) return <Alert tone="danger" className="mt-4">{error}</Alert>;
  if (!data) return <div className="border-t border-gray-100 pt-4 mt-4" role="status" aria-label="Loading results"><Skeleton lines={4} /></div>;

  const { stats, distribution, responses, pending_count: pending } = data;
  const maxCount = Math.max(1, ...distribution.map((d) => d.count));
  const withComments = responses.filter((r) => r.comment);

  return (
    <div className="border-t border-gray-100 pt-4 mt-4 space-y-4">
      <div className="flex flex-wrap gap-x-6 gap-y-2 items-baseline">
        <div>
          <span className={`text-3xl font-semibold tracking-tight ${npsTone(stats.nps)}`}>{stats.nps == null ? '—' : stats.nps}</span>
          <span className="text-xs text-gray-500 ml-1.5">{data.survey.kind === 'nps' ? 'NPS' : 'NPS-style score'}</span>
        </div>
        <div className="text-xs text-gray-500">
          <span className="font-medium text-gray-700">{stats.responded}</span> of {stats.sent} responded
          {stats.response_rate != null && <> ({Math.round(stats.response_rate * 100)}%)</>}
          {pending > 0 && <> · {pending} link{pending === 1 ? '' : 's'} pending</>}
        </div>
        <div className="text-xs text-gray-500">
          <span className="font-medium text-success-600">{stats.promoters}</span> promoters ·{' '}
          <span className="font-medium text-warning-600">{stats.passives}</span> passives ·{' '}
          <span className="font-medium text-danger-600">{stats.detractors}</span> detractors
          {stats.avg_score != null && <> · avg {stats.avg_score}</>}
        </div>
      </div>

      {/* Score distribution on the survey's own scale */}
      <div>
        <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Score distribution</div>
        <div className="flex items-end gap-1 h-20">
          {distribution.map((d) => (
            <div key={d.score} className="flex-1 flex flex-col items-center justify-end h-full" title={`${d.count} response${d.count === 1 ? '' : 's'} scored ${d.score}`}>
              <div
                className="w-full rounded-t bg-brand-blue/70 min-h-[2px]"
                style={{ height: `${(d.count / maxCount) * 100}%`, opacity: d.count === 0 ? 0.15 : 1 }}
              />
              <div className="text-[10px] text-gray-400 mt-1">{d.score}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Comments */}
      <div>
        <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
          Comments {withComments.length > 0 && `(${withComments.length})`}
        </div>
        {withComments.length === 0 ? (
          <div className="text-sm text-gray-400">No comments yet.</div>
        ) : (
          <ul className="space-y-2 max-h-64 overflow-y-auto pr-1">
            {withComments.map((r) => (
              <li key={r.id} className="bg-gray-50 border border-gray-100 rounded px-3 py-2">
                <div className="text-sm text-gray-700 whitespace-pre-wrap break-words">{r.comment}</div>
                <div className="text-[11px] text-gray-400 mt-1">
                  Scored {r.score}{r.contact_name ? ` · ${r.contact_name}` : ''}
                  {r.responded_at ? ` · ${new Date(r.responded_at).toLocaleDateString()}` : ''}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// --- Link generator: mint N anonymous links, list them with copy buttons ----
function LinkGenerator({ surveyId, onMinted }) {
  const [count, setCount] = useState(3);
  const [links, setLinks] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const mint = async () => {
    setBusy(true); setError(null);
    try {
      const res = await api.post(`/surveys/${surveyId}/links`, { count: Number(count) || 1 });
      setLinks((prev) => [...(res.data.created || []), ...prev]);
      if (onMinted) onMinted();
    } catch (e) {
      setError(e.response?.data?.error || 'Could not generate links.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border-t border-gray-100 pt-4 mt-4">
      <div className="flex items-center gap-2 flex-wrap">
        <Input
          type="number" min="1" max="100" value={count} size="sm"
          onChange={(e) => setCount(e.target.value)}
          wrapperClassName="w-20"
          aria-label="Number of links"
        />
        <Button size="sm" onClick={mint} loading={busy} loadingLabel="Generating…" icon="external">
          Generate response links
        </Button>
        <span className="text-xs text-gray-400">Each link records one response. Nothing is sent automatically — you share these yourself.</span>
      </div>
      {error && <Alert tone="danger" className="mt-2" onDismiss={() => setError(null)}>{error}</Alert>}
      {links.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {links.map((l) => {
            const url = `${window.location.origin}${l.path}`;
            return (
              <li key={l.token} className="flex items-center gap-2">
                <code className="text-xs text-gray-600 bg-gray-50 border border-gray-100 rounded-md px-2 py-1.5 truncate flex-1">{url}</code>
                <CopyButton text={url} />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export default function Surveys() {
  const [surveys, setSurveys] = useState(null);
  const [error, setError] = useState(null);
  const [expanded, setExpanded] = useState({});   // id → 'results' | 'links' | undefined
  // Create form
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [kind, setKind] = useState('nps');
  const [question, setQuestion] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState(null);

  const load = useCallback(async () => {
    try {
      const res = await api.get('/surveys');
      setSurveys(res.data);
      setError(null);
    } catch (e) {
      if (e.response?.status === 403) setError('Customer Success isn’t enabled for this workspace. An admin can turn it on under Feature Flags.');
      else setError('Could not load surveys. Please try again.');
      setSurveys([]);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const closeCreate = () => { setShowCreate(false); setCreateError(null); };

  const create = async (e) => {
    e.preventDefault();
    if (!name.trim()) { setCreateError('Give the survey a name.'); return; }
    setCreating(true); setCreateError(null);
    try {
      await api.post('/surveys', { name: name.trim(), kind, question: question.trim() || undefined });
      setName(''); setQuestion(''); setKind('nps'); setShowCreate(false);
      load();
    } catch (err) {
      setCreateError(err.response?.data?.error || 'Could not create the survey.');
    } finally {
      setCreating(false);
    }
  };

  const toggleActive = async (s) => {
    try {
      await api.put(`/surveys/${s.id}`, { is_active: !s.is_active });
      load();
    } catch { /* transient — the list refresh will reconcile */ }
  };

  const remove = async (s) => {
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Delete "${s.name}" and all of its responses? This can't be undone.`)) return;
    try {
      await api.delete(`/surveys/${s.id}`);
      load();
    } catch { /* transient */ }
  };

  const toggle = (id, panel) =>
    setExpanded((prev) => ({ ...prev, [id]: prev[id] === panel ? undefined : panel }));

  return (
    <div className="min-h-screen bg-gray-50">
      <Nav active="surveys" />
      <Container>
        <PageHeader
          title="Surveys"
          subtitle="NPS and CSAT surveys — mint response links, share them yourself, watch the results roll in."
          primaryAction={{ label: 'New survey', onClick: () => setShowCreate(true) }}
        />

        <div className="space-y-6">
          {error && <Alert tone="warning" icon="lock">{error}</Alert>}

          {surveys == null && !error && (
            <Card><Skeleton lines={5} /></Card>
          )}

          {surveys != null && surveys.length === 0 && !error && (
            <Card padding="none">
              <EmptyState
                icon="star"
                title="No surveys yet"
                message="Create an NPS or CSAT survey, generate a few response links, and share them with your customers — results land here and on each account's 360."
                action={<Button icon="plus" onClick={() => setShowCreate(true)}>New survey</Button>}
              />
            </Card>
          )}

          {(surveys || []).map((s) => (
            <Card key={s.id} className={s.is_active ? '' : 'opacity-70'}>
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h2 className="text-base font-semibold text-gray-900 truncate">{s.name}</h2>
                    <StatusBadge tone="info" label={(KIND_META[s.kind] || KIND_META.nps).label} />
                    {!s.is_active && <StatusBadge tone="neutral" label="Inactive" />}
                  </div>
                  <p className="text-sm text-gray-500 mt-0.5 truncate">{s.question}</p>
                  <p className="text-xs text-gray-400 mt-1">
                    {s.responded_count} of {s.sent_count} link{s.sent_count === 1 ? '' : 's'} answered
                  </p>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0 flex-wrap">
                  <Button variant={expanded[s.id] === 'results' ? 'primary' : 'secondary'} size="sm" aria-pressed={expanded[s.id] === 'results'} onClick={() => toggle(s.id, 'results')}>
                    {expanded[s.id] === 'results' ? 'Hide results' : 'Results'}
                  </Button>
                  <Button variant={expanded[s.id] === 'links' ? 'primary' : 'secondary'} size="sm" aria-pressed={expanded[s.id] === 'links'} onClick={() => toggle(s.id, 'links')}>
                    {expanded[s.id] === 'links' ? 'Hide links' : 'Get links'}
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => toggleActive(s)}>
                    {s.is_active ? 'Deactivate' : 'Activate'}
                  </Button>
                  <Button variant="ghost" size="sm" icon="trash" className="text-danger-600 hover:bg-danger-50" onClick={() => remove(s)}>
                    Delete
                  </Button>
                </div>
              </div>

              {expanded[s.id] === 'results' && <Results surveyId={s.id} />}
              {expanded[s.id] === 'links' && <LinkGenerator surveyId={s.id} onMinted={load} />}
            </Card>
          ))}
        </div>
      </Container>

      <Modal
        open={showCreate}
        onClose={closeCreate}
        title="New survey"
        description="Nothing is sent automatically — you generate links and share them yourself."
        footer={
          <>
            <Button variant="secondary" onClick={closeCreate}>Cancel</Button>
            <Button type="submit" form="survey-form" loading={creating} loadingLabel="Creating…">Create survey</Button>
          </>
        }
      >
        <form id="survey-form" onSubmit={create} className="space-y-4">
          {createError && <Alert tone="danger" onDismiss={() => setCreateError(null)}>{createError}</Alert>}
          <div className="grid sm:grid-cols-2 gap-3">
            <Input
              label="Name"
              required
              value={name} onChange={(e) => setName(e.target.value)}
              placeholder="Q3 relationship check"
              autoFocus
            />
            <Select label="Type" value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="nps">NPS — {KIND_META.nps.hint}</option>
              <option value="csat">CSAT — {KIND_META.csat.hint}</option>
            </Select>
          </div>
          <Input
            label="Question"
            hint="Optional — a sensible default is used."
            value={question} onChange={(e) => setQuestion(e.target.value)}
            placeholder={kind === 'nps' ? 'How likely are you to recommend us to a friend or colleague?' : 'How satisfied are you with your recent experience?'}
          />
        </form>
      </Modal>
    </div>
  );
}
