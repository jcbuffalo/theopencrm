// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import React, { useEffect, useState, useCallback } from 'react';
import api from '../api';
import Nav from '../components/Nav';
import { Alert, Card, Container, EmptyState, PageHeader, Skeleton, StatusBadge } from '../components/ui';

// Lifecycle Funnel — how the customer base is distributed across the account
// relationship lifecycle (prospect → onboarding → active → at_risk → renewed →
// churned), what revenue is exposed on at-risk accounts, and what's recently
// moved. Visual sibling of Retention.js (same card language), reading
// GET /api/lifecycle-funnel.

// --- Money formatter: compresses to $K / $M past 1k (mirrors Retention.js).
function fmtMoney(n) {
  if (n === null || n === undefined || n === '') return '—';
  const num = Number(n);
  if (!Number.isFinite(num)) return '—';
  if (Math.abs(num) >= 1_000_000) return `$${(num / 1_000_000).toFixed(1)}M`;
  if (Math.abs(num) >= 1_000)     return `$${(num / 1_000).toFixed(0)}K`;
  return `$${num.toLocaleString()}`;
}

// Presentation for each canonical lifecycle stage. Order here is display-only;
// the API already returns stages in canonical order and we render what it sends.
const STAGE_META = {
  prospect:   { label: 'Prospect',   bar: 'bg-gray-400',       tone: 'neutral' },
  onboarding: { label: 'Onboarding', bar: 'bg-brand-blue',     tone: 'info' },
  active:     { label: 'Active',     bar: 'bg-success-500',    tone: 'success' },
  at_risk:    { label: 'At risk',    bar: 'bg-warning-500',    tone: 'warning' },
  renewed:    { label: 'Renewed',    bar: 'bg-purple-500',     tone: 'accent' },
  churned:    { label: 'Churned',    bar: 'bg-danger-500',     tone: 'error' },
};
const meta = (stage) => STAGE_META[stage] || { label: stage, bar: 'bg-gray-400', tone: 'neutral' };

function Stat({ label, value, sub, tone = 'gray' }) {
  const tones = {
    gray: 'text-gray-900',
    emerald: 'text-success-700',
    blue: 'text-brand-blue-dark',
    amber: 'text-warning-700',
    rose: 'text-danger-700',
  };
  return (
    <div className="bg-white rounded border border-gray-200 px-4 py-3 shadow-card">
      <div className="text-xs font-medium text-gray-500">{label}</div>
      <div className={`text-xl font-semibold tracking-tight leading-tight mt-0.5 ${tones[tone] || tones.gray}`}>{value}</div>
      {sub && <div className="text-xs text-gray-400 mt-0.5">{sub}</div>}
    </div>
  );
}

// One horizontal funnel row: stage label · proportional bar · count + % of base.
function FunnelRow({ stage, count, pct, maxCount }) {
  const m = meta(stage);
  // Bar width is proportional to the LARGEST stage so relative size reads at a
  // glance; the % figure is still % of the whole base.
  const width = maxCount > 0 ? Math.max((count / maxCount) * 100, count > 0 ? 2 : 0) : 0;
  return (
    <div className="flex items-center gap-3">
      <div className="w-28 shrink-0 text-sm font-medium text-gray-600">{m.label}</div>
      <div className="flex-1 h-6 rounded-md bg-gray-100 overflow-hidden">
        <div className={`h-full ${m.bar} transition-all`} style={{ width: `${width}%` }} />
      </div>
      <div className="w-24 shrink-0 text-right text-sm text-gray-700">
        <span className="font-semibold">{count}</span>
        <span className="text-gray-400"> · {pct}%</span>
      </div>
    </div>
  );
}

export default function LifecycleFunnel() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get('/lifecycle-funnel');
      setData(res.data);
    } catch (e) {
      const status = e?.response?.status;
      if (status === 403) setError('Customer Success isn’t enabled for this workspace. An admin can turn it on under Feature Flags.');
      else setError('Could not load lifecycle analytics. Please try again.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const dist = data?.distribution;
  const atRisk = data?.atRisk;
  const movement = data?.movement;

  const stages = dist?.stages || [];
  const maxCount = stages.reduce((m, s) => Math.max(m, s.count || 0), 0);
  const movedStages = (movement?.stages || []).filter((s) => (s.count || 0) > 0);
  const nothingYet = data && (dist?.total || 0) === 0;

  return (
    <div className="min-h-screen bg-gray-50">
      <Nav active="lifecycle-funnel" />
      <Container>
        <PageHeader
          title="Lifecycle funnel"
          subtitle="Where every account sits in the relationship lifecycle — and how much revenue is exposed where it wobbles."
          secondaryActions={[{ label: 'Refresh', icon: 'refresh', inline: true, onClick: load }]}
        />

        <div className="space-y-6">
          {loading && (
            <div role="status" aria-label="Mapping the lifecycle" className="space-y-6">
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="bg-white rounded border border-gray-200 px-4 py-3 shadow-card">
                    <Skeleton lines={2} />
                  </div>
                ))}
              </div>
              <Card><Skeleton lines={6} /></Card>
            </div>
          )}

          {!loading && error && <Alert tone="warning">{error}</Alert>}

          {!loading && !error && data && nothingYet && (
            <Card>
              <EmptyState
                icon="users"
                title="No accounts to map yet"
                message="Add a few companies and set their lifecycle stage from the Accounts page — your funnel from first prospect to loyal renewal will take shape right here."
              />
            </Card>
          )}

          {!loading && !error && data && !nothingYet && (
            <>
              {/* Headline base stats */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <Stat
                  label="Total accounts"
                  value={dist?.total ?? '—'}
                  sub={dist?.unclassified ? `${dist.unclassified} without a lifecycle stage` : 'All lifecycle stages'}
                  tone="blue"
                />
                <Stat
                  label="Active"
                  value={stages.find((s) => s.stage === 'active')?.count ?? 0}
                  sub="Healthy, live relationships"
                  tone="emerald"
                />
                <Stat
                  label="At risk"
                  value={atRisk?.company_count ?? 0}
                  sub="Accounts flagged at_risk"
                  tone="amber"
                />
                <Stat
                  label="Churned"
                  value={stages.find((s) => s.stage === 'churned')?.count ?? 0}
                  sub="Relationships lost"
                  tone="rose"
                />
              </div>

              {/* The funnel itself */}
              <Card title="Accounts by lifecycle stage">
                <div className="space-y-2.5">
                  {stages.map((s) => (
                    <FunnelRow key={s.stage} stage={s.stage} count={s.count || 0} pct={s.pct || 0} maxCount={maxCount} />
                  ))}
                </div>
                {(dist?.unclassified || 0) > 0 && (
                  <p className="text-xs text-gray-400 mt-3 border-t border-gray-100 pt-3">
                    {dist.unclassified} account{dist.unclassified === 1 ? '' : 's'} have no lifecycle stage set — they count toward the base but aren’t shown in a bar. Set a stage from the Accounts page.
                  </p>
                )}
              </Card>

              {/* At-risk exposure callout */}
              <Card
                title="At-risk exposure"
                subtitle={`${atRisk?.company_count || 0} account${atRisk?.company_count === 1 ? '' : 's'} flagged at_risk`}
                className="border-warning-200 bg-warning-50"
              >
                {(atRisk?.company_count || 0) === 0 ? (
                  <p className="text-sm text-warning-800">No accounts are flagged at risk right now — nothing on fire.</p>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                    <div>
                      <div className="text-xs font-medium text-warning-700">MRR at risk</div>
                      <div className="text-2xl font-semibold tracking-tight text-warning-900 mt-0.5">{fmtMoney(atRisk?.mrr_at_risk)}</div>
                      <div className="text-xs text-warning-700 mt-0.5">
                        {fmtMoney(atRisk?.arr_at_risk)} annualized · {atRisk?.active_contract_count || 0} active contract{atRisk?.active_contract_count === 1 ? '' : 's'}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs font-medium text-warning-700">Open pipeline exposed</div>
                      <div className="text-2xl font-semibold tracking-tight text-warning-900 mt-0.5">{fmtMoney(atRisk?.open_deal_value)}</div>
                      <div className="text-xs text-warning-700 mt-0.5">{atRisk?.open_deal_count || 0} open deal{atRisk?.open_deal_count === 1 ? '' : 's'} on at-risk accounts</div>
                    </div>
                    <div className="sm:border-l sm:border-warning-200 sm:pl-4 flex items-center">
                      <p className="text-xs text-warning-800">
                        Recurring revenue + open deals attached to accounts flagged <span className="font-semibold">at_risk</span>. Work these first — this is the revenue a save call protects.
                      </p>
                    </div>
                  </div>
                )}
              </Card>

              {/* Recent movement — honestly labeled as activity, not transitions */}
              <Card
                title="Recent activity by stage"
                actions={<StatusBadge tone="neutral" label={`last ${movement?.window_days || 30} days`} />}
              >
                {movedStages.length === 0 ? (
                  <div className="text-sm text-gray-500 py-8 text-center">No accounts were updated in the last {movement?.window_days || 30} days.</div>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {movedStages.map((s) => (
                      <StatusBadge
                        key={s.stage}
                        size="md"
                        tone={meta(s.stage).tone}
                        label={`${meta(s.stage).label}: ${s.count}`}
                      />
                    ))}
                  </div>
                )}
                <p className="text-xs text-gray-400 mt-3 border-t border-gray-100 pt-3">
                  {movement?.note || 'Recently-updated accounts grouped by their current stage — not true stage-to-stage transitions (no lifecycle change history is recorded yet).'}
                </p>
              </Card>
            </>
          )}
        </div>
      </Container>
    </div>
  );
}
