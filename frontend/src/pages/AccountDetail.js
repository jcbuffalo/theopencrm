// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import React, { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { accounts, portal, downloadBlob } from '../api';
import Nav from '../components/Nav';
import CommentThread from '../components/CommentThread';
import { useAuth } from '../AuthContext';
import {
  Alert, Button, Card, Container, EmptyState, PageHeader, Skeleton, StatusBadge, Textarea,
} from '../components/ui';

// Customer Success — Account 360 detail (CS-1 / CS-2).
//
// Header card (owner, health badge, open-item counts, last touch) over a
// unified chronological timeline merged from activities / tasks / deals /
// issues / Gmail thread summaries. Data comes from a single call to
// GET /api/accounts/:id/360 (see backend/routes/accountRoutes.js).
//
// Health: the 360 header doesn't always carry a rules-based band yet (it's
// snapshotted daily by the accountHealthWorker). We read whatever the header
// exposes — `health_band` / `health_score`, or a `health` sub-object — and
// degrade gracefully to a neutral "No data" chip when absent.

function fmtDate(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString();
}

function fmtDateShort(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString();
}

function relativeFromNow(ts) {
  if (!ts) return null;
  const then = new Date(ts).getTime();
  if (Number.isNaN(then)) return null;
  const days = Math.floor((Date.now() - then) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}

// Pull a band/score out of the header regardless of which shape the backend
// settled on (top-level fields or a nested `health` object).
function readHealth(header) {
  if (!header) return { band: null, score: null };
  const band = header.health_band || header.health?.band || null;
  const score = header.health_score ?? header.health?.score ?? null;
  return { band, score };
}

const BAND_TONE = { green: 'success', yellow: 'warning', red: 'error' };

function HealthBadge({ band, score }) {
  if (!band) return <StatusBadge size="md" tone="neutral" label="Health: no data" />;
  return (
    <StatusBadge
      size="md"
      tone={BAND_TONE[band] || 'neutral'}
      label={<><span className="capitalize">{band}</span>{score != null && <span className="opacity-70">· {score}</span>}</>}
    />
  );
}

const TYPE_META = {
  activity:      { label: 'Activity',      dot: 'bg-info-400'    },
  task:          { label: 'Task',          dot: 'bg-warning-400' },
  deal:          { label: 'Deal',          dot: 'bg-violet-400'  },
  issue:         { label: 'Issue',         dot: 'bg-danger-400'  },
  case:          { label: 'Case',          dot: 'bg-rose-400'    },
  gmail_summary: { label: 'Email summary', dot: 'bg-cyan-400'    },
  email:         { label: 'Email',         dot: 'bg-teal-400'    },
  meeting:       { label: 'Meeting',       dot: 'bg-indigo-400'  },
};

function fmtMoney(n) {
  if (n === null || n === undefined || n === '') return null;
  return `$${Number(n).toLocaleString()}`;
}

// Render a compact per-entry meta line (varies by timeline entry type).
function TimelineMeta({ entry }) {
  const m = entry.meta || {};
  const bits = [];
  if (entry.type === 'activity') {
    if (m.activity_type) bits.push(m.activity_type);
    if (m.outcome) bits.push(m.outcome);
  } else if (entry.type === 'task') {
    if (m.status) bits.push(m.status);
    if (m.priority) bits.push(`${m.priority} priority`);
    if (m.due_date) bits.push(`due ${fmtDateShort(m.due_date)}`);
  } else if (entry.type === 'deal') {
    if (m.stage) bits.push(m.stage);
    if (m.phase) bits.push(m.phase);
    const amt = fmtMoney(m.amount);
    if (amt) bits.push(amt);
  } else if (entry.type === 'issue') {
    if (m.category) bits.push(m.category);
    if (m.urgency) bits.push(`${m.urgency} urgency`);
    if (m.status) bits.push(m.status);
  } else if (entry.type === 'case') {
    if (m.priority) bits.push(`${m.priority} priority`);
    if (m.status) bits.push(m.status);
    if (m.sla_due_at && !m.resolved_at) bits.push(`SLA ${fmtDateShort(m.sla_due_at)}`);
  } else if (entry.type === 'gmail_summary') {
    if (m.next_step) bits.push(`next: ${m.next_step}`);
  } else if (entry.type === 'email') {
    if (m.from) bits.push(`from ${m.from}`);
  } else if (entry.type === 'meeting') {
    if (m.start_at) bits.push(fmtDate(m.start_at));
    if (Array.isArray(m.attendees) && m.attendees.length) bits.push(`${m.attendees.length} attendee${m.attendees.length === 1 ? '' : 's'}`);
    if (m.source === 'created') bits.push('scheduled from CRM');
    if (m.status && m.status !== 'confirmed') bits.push(m.status);
  }
  if (bits.length === 0 && !(entry.type === 'meeting' && (entry.meta || {}).meeting_link)) return null;
  const meetingLink = entry.type === 'meeting' ? (entry.meta || {}).meeting_link : null;
  return (
    <div className="text-xs text-gray-500 mt-0.5">
      {bits.join(' · ')}
      {meetingLink ? (
        <>
          {bits.length ? ' · ' : ''}
          <a href={meetingLink} target="_blank" rel="noopener noreferrer" className="text-brand-blue hover:underline">
            join
          </a>
        </>
      ) : null}
    </div>
  );
}

export default function AccountDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    setLoading(true);
    accounts.get360(id)
      .then((d) => { if (active) { setData(d); setError(''); } })
      .catch((err) => {
        if (active) setError(err.response?.data?.error || 'Failed to load account');
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [id]);

  const header = data?.header;
  const company = header?.company;
  const timeline = data?.timeline || [];
  const accountCases = data?.cases || [];
  const { band, score } = readHealth(header);

  return (
    <div className="min-h-screen bg-gray-50">
      <Nav active="accounts" />
      <Container>
        <PageHeader
          breadcrumb={[{ label: 'Companies', to: '/companies' }, { label: company?.name || 'Account' }]}
          title={loading ? 'Account' : (company?.name || 'Account')}
          subtitle={company && (
            <span className="flex flex-wrap gap-x-3 gap-y-1">
              {company.industry && <span>{company.industry}</span>}
              {company.location && <span>{company.location}</span>}
              {company.website && (
                <a href={company.website} target="_blank" rel="noopener noreferrer" className="text-brand-blue hover:underline truncate max-w-[220px]">
                  {company.website}
                </a>
              )}
            </span>
          )}
          actions={company ? <HealthBadge band={band} score={score} /> : null}
          secondaryActions={[
            ...(company ? [{
              label: 'One-pager PDF',
              icon: 'download',
              inline: true,
              onClick: () => {
                const filename = `${(company.name || `company-${id}`).toString().replace(/[^a-zA-Z0-9._-]/g, '_')}-one-pager.pdf`;
                downloadBlob(`/companies/${company.id || id}/one-pager.pdf`, filename)
                  .catch(() => setError('Failed to generate one-pager PDF'));
              },
            }] : []),
            { label: 'Back to companies', icon: 'arrow-left', inline: true, onClick: () => navigate('/companies') },
          ]}
        />

        <div className="space-y-6">
          {error && <Alert tone="danger" onDismiss={() => setError('')}>{error}</Alert>}

          {loading ? (
            <div role="status" aria-label="Loading account" className="space-y-6">
              <Card><Skeleton lines={4} /></Card>
              <Card><Skeleton lines={6} /></Card>
            </div>
          ) : !company ? (
            !error && (
              <Card>
                <EmptyState icon="building" title="Account not found" message="This account may have been deleted or merged." />
              </Card>
            )
          ) : (
            <>
              {/* Header card — rollup metrics */}
              <Card>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <Stat label="Open deals" value={header.open_deal_count ?? 0} />
                  <Stat label="Open tasks" value={header.open_task_count ?? 0} />
                  <Stat label="Open issues" value={header.open_issue_count ?? 0} accent={(header.open_issue_count ?? 0) > 0 ? 'red' : null} />
                  <Stat
                    label="Last touch"
                    value={relativeFromNow(header.last_touch) || '—'}
                    sub={header.last_touch ? fmtDateShort(header.last_touch) : null}
                  />
                </div>

                {company.owner_id != null && (
                  <div className="mt-4 text-xs text-gray-500">
                    Owner: <span className="font-medium text-gray-700">#{company.owner_id}</span>
                  </div>
                )}
              </Card>

              {/* Portal access (migration 141) — shown only when the org's
                  portal_enabled flag is on (the panel self-hides on the gate's
                  403). Mint/copy/revoke shareable read-only portal links. */}
              <PortalAccessPanel companyId={id} />

              {/* Portal messages (migration 150) — the running thread with the
                  customer through their portal link. Member-level (not admin-
                  gated); self-hides when the portal module is off. */}
              <PortalMessagesPanel companyId={id} />

              {/* Support cases (CS-5) — delivered open-first by the 360 payload. */}
              {accountCases.length > 0 && (
                <Card
                  padding="none"
                  title={
                    <span className="inline-flex items-center gap-2">
                      Support cases
                      {(header.open_case_count ?? 0) > 0 && <StatusBadge tone="error" label={`${header.open_case_count} open`} />}
                    </span>
                  }
                  actions={<Button size="sm" variant="ghost" iconRight="arrow-right" onClick={() => navigate('/cases')}>All cases</Button>}
                >
                  <div className="divide-y divide-gray-100">
                    {accountCases.slice(0, 8).map((c) => {
                      const isOpen = !['resolved', 'closed'].includes(c.status);
                      const slaBreached = isOpen && c.sla_due_at && new Date(c.sla_due_at).getTime() < Date.now();
                      return (
                        <div key={c.id} className="px-5 py-3 flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="text-sm font-medium text-gray-900 break-words">{c.subject}</div>
                            <div className="text-xs text-gray-500 mt-0.5">
                              {c.priority} priority · opened {fmtDateShort(c.created_at)}
                              {c.sla_due_at && isOpen && <> · SLA {fmtDateShort(c.sla_due_at)}</>}
                              {c.resolved_at && <> · resolved {fmtDateShort(c.resolved_at)}</>}
                            </div>
                          </div>
                          <div className="flex items-center gap-2 flex-shrink-0">
                            {slaBreached && <StatusBadge tone="error" label="SLA breached" />}
                            <StatusBadge tone={isOpen ? 'success' : 'neutral'} label={<span className="capitalize">{c.status}</span>} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </Card>
              )}

              {/* Team comments with @mentions (migration 146) — internal notes
                  on the account; mentioned teammates get a bell notification. */}
              <Card title="Comments">
                <CommentThread entityType="company" entityId={Number(id)} />
              </Card>

              {/* Timeline */}
              <section>
                <h2 className="text-base font-semibold text-gray-900 mb-3">Activity timeline</h2>
                {timeline.length === 0 ? (
                  <Card>
                    <EmptyState icon="clock" title="No activity yet" message="No activity recorded for this account yet." />
                  </Card>
                ) : (
                  <ol className="relative border-l border-gray-200 ml-2">
                    {timeline.map((entry) => {
                      const meta = TYPE_META[entry.type] || { label: entry.type, dot: 'bg-gray-400' };
                      return (
                        <li key={`${entry.type}-${entry.id}`} className="mb-5 ml-5">
                          <span className={`absolute -left-[6px] mt-1.5 h-3 w-3 rounded-full ring-4 ring-gray-50 ${meta.dot}`}></span>
                          <div className="bg-white border border-gray-200 rounded p-3 shadow-card">
                            <div className="flex items-center justify-between gap-3">
                              <span className="text-[10px] uppercase tracking-wider font-semibold text-gray-400">{meta.label}</span>
                              <span className="text-xs text-gray-400 whitespace-nowrap">{fmtDate(entry.timestamp)}</span>
                            </div>
                            <div className="text-sm font-medium text-gray-900 mt-1 break-words">{entry.title || '(untitled)'}</div>
                            <TimelineMeta entry={entry} />
                            {entry.detail && (
                              <p className="text-sm text-gray-600 mt-1.5 whitespace-pre-wrap break-words line-clamp-4">{entry.detail}</p>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ol>
                )}
              </section>
            </>
          )}
        </div>
      </Container>
    </div>
  );
}

// Portal messages (migration 150) — the thread with the customer via their
// portal link. Member-level: everyone in the org can read + reply (the
// backend gates only token MANAGEMENT to admins). Renders nothing until the
// list call succeeds, so orgs with the portal module off (403
// FEATURE_DISABLED at the mount) never see it.
function PortalMessagesPanel({ companyId }) {
  const [messages, setMessages] = useState(null); // null = hidden
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    portal.listMessages(companyId)
      .then((rows) => setMessages(rows))
      .catch(() => setMessages(null)); // flag off / any error → panel hidden
  }, [companyId]);

  useEffect(() => { load(); }, [load]);

  if (messages === null) return null;

  const send = async (e) => {
    e.preventDefault();
    if (!draft.trim() || sending) return;
    setSending(true); setError('');
    try {
      const row = await portal.sendMessage(companyId, draft);
      setMessages((prev) => [...(prev || []), row]);
      setDraft('');
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to send message');
    } finally {
      setSending(false);
    }
  };

  return (
    <Card
      title="Portal messages"
      subtitle="The running conversation with this customer through their portal link. They see your replies the next time they open it."
    >
      {messages.length === 0 ? (
        <div className="text-sm text-gray-500 bg-gray-50 border border-gray-100 rounded px-4 py-4 text-center mb-3">
          No messages yet.
        </div>
      ) : (
        <div className="space-y-3 max-h-80 overflow-y-auto mb-3 pr-1">
          {messages.map((m) => (
            <div key={m.id} className={`flex ${m.author_type === 'team' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[85%] rounded-2xl px-3.5 py-2 text-sm ${m.author_type === 'team'
                ? 'bg-brand-blue text-white rounded-br-sm'
                : 'bg-gray-100 text-gray-900 rounded-bl-sm'}`}>
                <div className={`text-[11px] font-semibold mb-0.5 ${m.author_type === 'team' ? 'text-white/80' : 'text-gray-500'}`}>
                  {m.author_type === 'team' ? (m.author_name || 'Team') : 'Customer'}
                </div>
                <div className="whitespace-pre-wrap break-words">{m.body}</div>
                <div className={`text-[10px] mt-1 ${m.author_type === 'team' ? 'text-white/70' : 'text-gray-400'}`}>
                  {m.created_at ? new Date(m.created_at).toLocaleString() : ''}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {error && <Alert tone="danger" className="mb-3" onDismiss={() => setError('')}>{error}</Alert>}

      <form onSubmit={send} className="flex items-end gap-2">
        <Textarea
          wrapperClassName="flex-1"
          aria-label="Reply to the customer"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          maxLength={3000}
          rows={2}
          placeholder="Reply to the customer…"
          className="resize-none"
        />
        <Button type="submit" disabled={!draft.trim()} loading={sending} loadingLabel="Sending…">
          Send
        </Button>
      </form>
    </Card>
  );
}

// Portal access (Customer Portal, migration 141). Owner/admin only — the
// backend token routes 403 for non-admin org members, and we mirror that gate
// on org_role here so non-admins never see the panel (or fire the doomed list
// call) at all. Beyond the role gate, the panel renders nothing until the
// gated list call succeeds — a 403 (FEATURE_DISABLED, flag default OFF) or
// any other failure keeps the whole panel hidden, so orgs without the module
// never see it. Links are /portal/:token on THIS frontend origin; the token
// is the only credential in the URL.
function PortalAccessPanel({ companyId }) {
  const { user } = useAuth();
  // Mirrors backend isOrgAdmin (portalRoutes.js): org members need
  // owner/admin; org-less personal workspaces can't mint anyway, so hide.
  const canManage = !!user?.org_id && ['owner', 'admin'].includes(user?.org_role);

  const [tokens, setTokens] = useState(null); // null = hidden (flag off / not loaded)
  const [minting, setMinting] = useState(false);
  const [copiedId, setCopiedId] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    if (!canManage) return; // non-admins: never call, never render
    portal.listTokens(companyId)
      .then((rows) => setTokens(rows))
      .catch(() => setTokens(null)); // 403 flag-off / role gate (or any error) → panel stays hidden
  }, [companyId, canManage]);

  useEffect(() => { load(); }, [load]);

  if (!canManage || tokens === null) return null;

  const portalLink = (t) => `${window.location.origin}/portal/${t.token}`;

  const mint = async () => {
    setMinting(true); setError('');
    try {
      await portal.mintToken({ company_id: Number(companyId) });
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to create portal link');
    } finally {
      setMinting(false);
    }
  };

  const revoke = async (id) => {
    setError('');
    try {
      await portal.revokeToken(id);
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to revoke portal link');
    }
  };

  const copy = async (t) => {
    try {
      await navigator.clipboard.writeText(portalLink(t));
      setCopiedId(t.id);
      setTimeout(() => setCopiedId(null), 1500);
    } catch {
      // Clipboard unavailable (http, permissions) — leave the link visible to select manually.
    }
  };

  const active = tokens.filter((t) => t.is_active);
  const revoked = tokens.filter((t) => !t.is_active);

  return (
    <Card
      title="Portal access"
      subtitle="Share a link that lets this customer see their deals, quotes, and documents — and message your team, respond to quotes, and file support requests. Anyone with the link can use it — revoke it to cut access."
      actions={
        <Button size="sm" icon="plus" onClick={mint} loading={minting} loadingLabel="Creating…">
          New portal link
        </Button>
      }
    >
      {error && <Alert tone="danger" className="mb-3" onDismiss={() => setError('')}>{error}</Alert>}

      {active.length === 0 && revoked.length === 0 ? (
        <div className="text-sm text-gray-500 bg-gray-50 border border-gray-100 rounded px-4 py-4 text-center">
          No portal links yet.
        </div>
      ) : (
        <div className="divide-y divide-gray-100 border border-gray-200 rounded">
          {active.map((t) => (
            <div key={t.id} className="px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-mono text-gray-700 truncate">{portalLink(t)}</div>
                <div className="text-xs text-gray-400 mt-0.5">
                  {t.label && <>{t.label} · </>}
                  created {fmtDateShort(t.created_at)}
                  {t.expires_at && <> · expires {fmtDateShort(t.expires_at)}</>}
                  {' · '}
                  {t.last_accessed_at ? `last viewed ${fmtDateShort(t.last_accessed_at)}` : 'never viewed'}
                </div>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <Button size="sm" variant="secondary" icon={copiedId === t.id ? 'check' : 'copy'} onClick={() => copy(t)}>
                  {copiedId === t.id ? 'Copied!' : 'Copy link'}
                </Button>
                <Button size="sm" variant="secondary" className="text-danger-600 border-danger-200 hover:bg-danger-50" onClick={() => revoke(t.id)}>
                  Revoke
                </Button>
              </div>
            </div>
          ))}
          {revoked.map((t) => (
            <div key={t.id} className="px-4 py-2.5 flex items-center justify-between gap-3 bg-gray-50">
              <div className="text-xs text-gray-400 truncate">
                {t.label || 'Portal link'} · created {fmtDateShort(t.created_at)}
              </div>
              <StatusBadge tone="neutral" label="Revoked" className="flex-shrink-0" />
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function Stat({ label, value, sub, accent }) {
  const valueCls = accent === 'red' ? 'text-danger-600' : 'text-gray-900';
  return (
    <div className="bg-gray-50 rounded border border-gray-100 px-3 py-3">
      <div className="text-xs font-medium text-gray-500">{label}</div>
      <div className={`text-xl font-semibold tracking-tight mt-0.5 ${valueCls}`}>{value}</div>
      {sub && <div className="text-xs text-gray-400 mt-0.5">{sub}</div>}
    </div>
  );
}
