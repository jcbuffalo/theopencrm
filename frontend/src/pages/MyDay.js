// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api';
import Nav from '../components/Nav';
import { useAuth } from '../AuthContext';
import { getStageConfig } from '../stages';
import { Alert, Button, Card, Container, EmptyState, Icon, PageHeader, Spinner, StatusBadge } from '../components/ui';

// My Day — the personal relationship work-queue at /today.
//
// A focused daily command center answering "what needs me today?" across six
// signals: deal next steps due, my due/overdue tasks, contracts renewing this
// month, at-risk accounts, accounts gone quiet, and open deals losing momentum. It
// complements (never replaces) the Chat front door — Chat is where you talk to
// the CRM; My Day is the scannable queue you work through with coffee.
//
// Data is ONE call to GET /api/my-day (backend/routes/myDayRoutes.js). Every
// section degrades independently on the server — an org without the
// customer-success tables just gets empty renewal/at-risk sections, which
// render here as an encouraging all-caught-up state, never an error.

const PRIORITY_TONE = { high: 'error', medium: 'warning', low: 'neutral' };

function fmtDateShort(ts) {
  if (!ts) return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString();
}

function fmtMoney(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

// Time-of-day greeting — the "warm" in warm work-queue.
function greeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

// One work-queue section: header with count pill, list of row-buttons, and an
// encouraging empty state (never an error — empty means caught up).
function SectionCard({ title, icon, count, tone, emptyMessage, footerLabel, onFooter, children }) {
  const badgeTone = count > 0 ? (tone === 'red' ? 'error' : tone === 'amber' ? 'warning' : 'info') : 'neutral';
  return (
    <Card
      padding="none"
      className="flex flex-col"
      title={<span className="flex items-center gap-2"><Icon name={icon} size={16} className="text-gray-400" />{title}</span>}
      actions={<StatusBadge tone={badgeTone} label={count} size="md" />}
    >
      {count === 0 ? (
        <div className="px-5 py-8 text-center text-sm text-gray-500">{emptyMessage}</div>
      ) : (
        <ul className="divide-y divide-gray-100">{children}</ul>
      )}
      {count > 0 && footerLabel && (
        <button
          type="button"
          onClick={onFooter}
          className="flex items-center gap-1 px-5 py-2.5 text-sm font-medium text-brand-blue hover:bg-info-50 text-left border-t border-gray-100 rounded-b transition"
        >
          {footerLabel}
          <Icon name="arrow-right" size={14} />
        </button>
      )}
    </Card>
  );
}

// `leading` (a checkbox) and `right` (a badge, or a one-tap action button)
// each stop click propagation, so a nested interactive control never fires
// the row's own onClick — the row itself is a div[role=button], not a real
// <button>, precisely so it can safely contain one.
function Row({ onClick, leading, primary, secondary, right }) {
  const clickable = typeof onClick === 'function';
  return (
    <li>
      <div
        role={clickable ? 'button' : undefined}
        tabIndex={clickable ? 0 : undefined}
        onClick={onClick}
        onKeyDown={clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } } : undefined}
        className={`px-5 py-3 hover:bg-gray-50 transition flex items-center gap-3 ${clickable ? 'cursor-pointer' : ''}`}
      >
        {leading && (
          <span className="flex-shrink-0" onClick={(e) => e.stopPropagation()}>{leading}</span>
        )}
        <span className="min-w-0 flex-1 text-left">
          <span className="block text-sm font-medium text-gray-900 truncate">{primary}</span>
          {secondary && <span className="block text-xs text-gray-500 truncate mt-0.5">{secondary}</span>}
        </span>
        {right && <span className="flex-shrink-0" onClick={(e) => e.stopPropagation()}>{right}</span>}
      </div>
    </li>
  );
}

const CAUGHT_UP = "You're all caught up here.";

export default function MyDay() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const showAccounts = getStageConfig(user?.org_profile).showAccountManagement;
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // In-flight ids so a double-tap can't double-fire, mirroring Contacts.js's
  // touchingIds pattern for "Mark touched".
  const [completingIds, setCompletingIds] = useState(new Set());
  const [touchingAccountIds, setTouchingAccountIds] = useState(new Set());
  const [completingStepIds, setCompletingStepIds] = useState(new Set());

  const loadMyDay = () => api.get('/my-day')
    .then((r) => { setData(r.data); setError(''); })
    .catch((err) => setError(err.response?.data?.error || 'Failed to load your day'))
    .finally(() => setLoading(false));

  useEffect(() => { loadMyDay(); }, []);

  // Inline complete — same PUT /tasks/:id { status: 'done' } call as
  // pages/Tasks.js's toggleStatus, with optimistic removal from the queue
  // (a task that's done no longer needs today's attention).
  const completeTask = async (task) => {
    setCompletingIds((s) => new Set(s).add(task.id));
    setData((d) => (d ? {
      ...d,
      tasksDue: d.tasksDue.filter((t) => t.id !== task.id),
      counts: { ...d.counts, tasksDue: d.counts.tasksDue - 1, total: d.counts.total - 1 },
    } : d));
    try {
      await api.put(`/tasks/${task.id}`, { status: 'done' });
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to complete task');
      loadMyDay(); // restore accurate state on failure
    } finally {
      setCompletingIds((s) => { const n = new Set(s); n.delete(task.id); return n; });
    }
  };

  // "Done" on a next step clears it (PUT /deals/:id with explicit nulls —
  // the route's next_step columns use present-key semantics, so null really
  // clears). Optimistic removal; the deal drawer is where you'd set the next
  // one.
  const completeNextStep = async (deal) => {
    setCompletingStepIds((s) => new Set(s).add(deal.id));
    setData((d) => (d ? {
      ...d,
      nextSteps: d.nextSteps.filter((x) => x.id !== deal.id),
      counts: { ...d.counts, nextSteps: (d.counts.nextSteps || 1) - 1, total: d.counts.total - 1 },
    } : d));
    try {
      await api.put(`/deals/${deal.id}`, { next_step: null, next_step_date: null });
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to clear next step');
      loadMyDay();
    } finally {
      setCompletingStepIds((s) => { const n = new Set(s); n.delete(deal.id); return n; });
    }
  };

  // One-tap "log a touch" for a gone-quiet account. NOTE: there is no
  // POST /companies/:id/touch endpoint yet (only contacts have a
  // last_touch_at column to stamp — see contactRoutes.js :302's
  // POST /contacts/:id/touch, and myDayRoutes.js's quietAccounts, which
  // derives an account's last touch dynamically from its deals'/contacts'
  // activities rather than a stored column). This call is wired for when
  // that backend route ships; today it surfaces a normal error banner
  // instead of doing nothing.
  const logAccountTouch = async (account) => {
    setTouchingAccountIds((s) => new Set(s).add(account.id));
    try {
      await api.post(`/companies/${account.id}/touch`);
      setData((d) => (d ? {
        ...d,
        quietAccounts: d.quietAccounts.filter((a) => a.id !== account.id),
        counts: { ...d.counts, quietAccounts: d.counts.quietAccounts - 1, total: d.counts.total - 1 },
      } : d));
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to log touch');
    } finally {
      setTouchingAccountIds((s) => { const n = new Set(s); n.delete(account.id); return n; });
    }
  };

  // Account rows deep-link into Account 360 when the profile runs the
  // account-management motion; otherwise fall back to a Companies search so
  // generic-profile orgs still get a useful click-through.
  const goAccount = (a) => {
    if (showAccounts) navigate(`/accounts/${a.id}`);
    else navigate(`/companies?search=${encodeURIComponent(a.name || '')}`);
  };

  const counts = data?.counts;
  const todayLabel = new Date().toLocaleDateString(undefined, {
    weekday: 'long', month: 'long', day: 'numeric',
  });
  const firstName = (user?.name || '').split(' ')[0];

  return (
    <div className="min-h-screen bg-gray-50">
      <Nav active="today" />
      <Container size="wide">
        <PageHeader
          title={`${greeting()}${firstName ? `, ${firstName}` : ''}`}
          subtitle={`${todayLabel} · ${counts && counts.total > 0
            ? `${counts.total} thing${counts.total === 1 ? '' : 's'} could use your attention today.`
            : 'Here’s everything that needs you today.'}`}
        />

        <div className="space-y-6">
          {error && <Alert tone="danger" onDismiss={() => setError('')}>{error}</Alert>}

          {loading ? (
            <Spinner size="lg" label="Pulling your day together…" />
          ) : data && (
            counts?.total === 0 ? (
              <Card padding="none">
                <EmptyState
                  icon="sun"
                  title="Nothing needs you right now"
                  message="No due tasks, no renewals closing in, no accounts drifting. A great day to get ahead — log a touch, or ask Chat what to do next."
                  action={<Button icon="chat" onClick={() => navigate('/chat')}>Open Chat</Button>}
                />
              </Card>
            ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {/* Next steps — the rep's own commitments (deals.next_step /
                  next_step_date, migration 172) due today or overdue, most
                  overdue first. Leads the queue: a promise you made beats a
                  task the system inferred. Absent against a pre-172 backend. */}
              {Array.isArray(data.nextSteps) && (
                <div className="lg:col-span-2">
                  <SectionCard
                    title="Next steps due"
                    icon="arrow-right"
                    count={data.nextSteps.length}
                    tone="red"
                    emptyMessage="No next steps due. Set one on a deal and it'll show up here on the day."
                    footerLabel="All deals"
                    onFooter={() => navigate('/deals')}
                  >
                    {data.nextSteps.map((d) => (
                      <Row
                        key={`ns-${d.id}`}
                        onClick={() => navigate(`/deals?dealId=${d.id}`)}
                        primary={d.next_step}
                        secondary={[d.title, d.company_name || d.contact_name, fmtMoney(d.amount)].filter(Boolean).join(' · ') || null}
                        right={
                          <span className="flex items-center gap-2">
                            <span className={`text-xs whitespace-nowrap ${d.overdue_days > 0 ? 'text-danger-600 font-semibold' : 'text-gray-500'}`}>
                              {d.overdue_days > 0 ? `${d.overdue_days}d overdue` : 'due today'}
                            </span>
                            <Button
                              variant="secondary"
                              size="sm"
                              icon="check"
                              onClick={() => completeNextStep(d)}
                              loading={completingStepIds.has(d.id)}
                              loadingLabel="Saving…"
                            >
                              Done
                            </Button>
                          </span>
                        }
                      />
                    ))}
                  </SectionCard>
                </div>
              )}

              {/* Tasks due — the queue's anchor, so it leads. */}
              <SectionCard
                title="Tasks due"
                icon="check-circle"
                count={data.tasksDue.length}
                tone="red"
                emptyMessage={CAUGHT_UP}
                footerLabel="All tasks"
                onFooter={() => navigate('/tasks')}
              >
                {data.tasksDue.map((t) => (
                  <Row
                    key={`t-${t.id}`}
                    leading={
                      <input
                        type="checkbox"
                        checked={false}
                        disabled={completingIds.has(t.id)}
                        onChange={() => completeTask(t)}
                        aria-label={`Mark "${t.title}" complete`}
                        className="h-4 w-4 rounded border-gray-300 text-brand-blue focus:ring-brand-blue cursor-pointer disabled:opacity-50"
                      />
                    }
                    onClick={() => navigate('/tasks')}
                    primary={t.title}
                    secondary={t.deal_title || t.contact_name || null}
                    right={
                      <span className="flex items-center gap-2">
                        {t.priority && (
                          <StatusBadge tone={PRIORITY_TONE[t.priority] || 'neutral'} label={t.priority} className="capitalize" />
                        )}
                        <span className={`text-xs ${t.overdue_days > 0 ? 'text-danger-600 font-semibold' : 'text-gray-500'}`}>
                          {t.overdue_days > 0 ? `${t.overdue_days}d overdue` : 'due today'}
                        </span>
                      </span>
                    }
                  />
                ))}
              </SectionCard>

              {/* Renewals inside 30 days. */}
              <SectionCard
                title="Renewals this month"
                icon="refresh"
                count={data.renewals.length}
                tone="amber"
                emptyMessage={CAUGHT_UP}
                footerLabel="All contracts"
                onFooter={() => navigate('/service-contracts')}
              >
                {data.renewals.map((r) => (
                  <Row
                    key={`r-${r.id}`}
                    onClick={() => navigate('/service-contracts')}
                    primary={r.name}
                    secondary={r.customer_name || null}
                    right={
                      <span className="text-xs text-warning-700 font-semibold whitespace-nowrap">
                        {fmtDateShort(r.end_date)}
                        {r.days_to_end != null && <span className="text-gray-400 font-normal"> · {r.days_to_end}d</span>}
                      </span>
                    }
                  />
                ))}
              </SectionCard>

              {/* At-risk accounts. */}
              <SectionCard
                title="At-risk accounts"
                icon="alert"
                count={data.atRiskAccounts.length}
                tone="red"
                emptyMessage={CAUGHT_UP}
                footerLabel={showAccounts ? 'All accounts' : 'All companies'}
                onFooter={() => navigate(showAccounts ? '/accounts' : '/companies')}
              >
                {data.atRiskAccounts.map((a) => (
                  <Row
                    key={`ar-${a.id}`}
                    onClick={() => goAccount(a)}
                    primary={a.name}
                    secondary={a.industry || null}
                    right={<StatusBadge tone="error" label="At risk" />}
                  />
                ))}
              </SectionCard>

              {/* Gone quiet. */}
              <SectionCard
                title="Gone quiet"
                icon="clock"
                count={data.quietAccounts.length}
                tone="amber"
                emptyMessage={CAUGHT_UP}
                footerLabel={showAccounts ? 'All accounts' : 'All companies'}
                onFooter={() => navigate(showAccounts ? '/accounts' : '/companies')}
              >
                {data.quietAccounts.map((a) => (
                  <Row
                    key={`q-${a.id}`}
                    onClick={() => goAccount(a)}
                    primary={a.name}
                    secondary={a.industry || null}
                    right={
                      <span className="flex items-center gap-2">
                        <span className="text-xs text-warning-700 whitespace-nowrap">
                          {a.days_since_last_touch == null
                            ? 'no touch yet'
                            : `${a.days_since_last_touch}d quiet`}
                        </span>
                        <Button
                          variant="secondary"
                          size="sm"
                          icon="check"
                          onClick={() => logAccountTouch(a)}
                          loading={touchingAccountIds.has(a.id)}
                          loadingLabel="Logging…"
                        >
                          Log a touch
                        </Button>
                      </span>
                    }
                  />
                ))}
              </SectionCard>

              {/* Deals needing attention — full width on large screens. */}
              <div className="lg:col-span-2">
                <SectionCard
                  title="Deals needing attention"
                  icon="trending-up"
                  count={data.dealsNeedingAttention.length}
                  tone="blue"
                  emptyMessage={CAUGHT_UP}
                  footerLabel="All deals"
                  onFooter={() => navigate('/deals')}
                >
                  {data.dealsNeedingAttention.map((d) => (
                    <Row
                      key={`d-${d.id}`}
                      onClick={() => navigate(`/deals?dealId=${d.id}`)}
                      primary={d.title}
                      secondary={[
                        d.customer_name || d.company_name,
                        fmtMoney(d.amount),
                      ].filter(Boolean).join(' · ') || null}
                      right={
                        <span className="flex items-center gap-2 text-xs whitespace-nowrap">
                          {d.past_close_date && <StatusBadge tone="error" label="Past close date" />}
                          <span className="text-gray-500">
                            {d.days_since_last_activity == null
                              ? 'no activity yet'
                              : `${d.days_since_last_activity}d since activity`}
                          </span>
                        </span>
                      }
                    />
                  ))}
                </SectionCard>
              </div>
            </div>
            )
          )}
        </div>
      </Container>
    </div>
  );
}
