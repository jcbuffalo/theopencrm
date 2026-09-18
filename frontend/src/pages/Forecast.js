// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import React, { useEffect, useState, useCallback } from 'react';
import {
  ResponsiveContainer, ComposedChart, Bar, Line,
  XAxis, YAxis, Tooltip, CartesianGrid, Legend,
} from 'recharts';
import api from '../api';
import Nav from '../components/Nav';
import { Alert, Card, Container, EmptyState, PageHeader, Skeleton } from '../components/ui';

// --- Money formatter: compresses to $K / $M past 1k (mirrors Reports.js).
function fmtMoney(n) {
  if (n === null || n === undefined || n === '') return '—';
  const num = Number(n);
  if (!Number.isFinite(num)) return '—';
  if (Math.abs(num) >= 1_000_000) return `$${(num / 1_000_000).toFixed(1)}M`;
  if (Math.abs(num) >= 1_000)     return `$${(num / 1_000).toFixed(0)}K`;
  return `$${num.toLocaleString()}`;
}

// --- Month label: "2026-07" → "Jul '26".
function fmtMonth(key) {
  if (!key || !/^\d{4}-\d{2}$/.test(key)) return key;
  const [y, m] = key.split('-').map(Number);
  const name = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m - 1];
  return `${name} '${String(y).slice(2)}`;
}

function Stat({ label, value, sub, tone = 'gray' }) {
  const tones = {
    gray: 'text-gray-900',
    emerald: 'text-success-700',
    blue: 'text-brand-blue-dark',
    amber: 'text-warning-700',
  };
  return (
    <div className="bg-white rounded border border-gray-200 px-4 py-3 shadow-card">
      <div className="text-xs font-medium text-gray-500">{label}</div>
      <div className={`text-xl font-semibold tracking-tight leading-tight mt-0.5 ${tones[tone] || tones.gray}`}>{value}</div>
      {sub && <div className="text-xs text-gray-400 mt-0.5">{sub}</div>}
    </div>
  );
}

// --- Quota attainment bar ---------------------------------------------------
function QuotaCard({ quota }) {
  if (!quota) return null;
  const pct = quota.attainment_pct ?? 0;
  const projPct = quota.projected_pct ?? 0;
  const attainedTone = pct >= 100 ? 'bg-success-500' : pct >= 60 ? 'bg-brand-blue' : 'bg-warning-500';
  const periodLabel = { month: 'This month', quarter: 'This quarter', year: 'This year' }[quota.period_type] || 'Current period';
  return (
    <Card
      title="Quota attainment"
      subtitle={`${periodLabel} · target ${fmtMoney(quota.target_amount)}`}
    >
      <div className="flex items-baseline gap-2">
        <span className="text-2xl font-semibold tracking-tight text-gray-900">{pct != null ? `${pct}%` : '—'}</span>
        <span className="text-sm text-gray-500">{fmtMoney(quota.attained_amount)} closed-won</span>
      </div>
      <div className="relative mt-2 h-3 w-full rounded-full bg-gray-100 overflow-hidden">
        {/* projected (lighter) behind attained */}
        <div className="absolute inset-y-0 left-0 bg-info-100" style={{ width: `${Math.min(projPct, 100)}%` }} />
        <div className={`absolute inset-y-0 left-0 ${attainedTone}`} style={{ width: `${Math.min(pct, 100)}%` }} />
      </div>
      <div className="mt-1 text-xs text-gray-400">
        Projected {fmtMoney(quota.projected_amount)} ({projPct != null ? `${projPct}%` : '—'}) incl. weighted open pipeline
      </div>
    </Card>
  );
}

export default function Forecast() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get('/forecast');
      setData(res.data);
    } catch (e) {
      const status = e?.response?.status;
      if (status === 403) setError('Reporting isn’t enabled for this workspace. An admin can turn it on under Feature Flags.');
      else setError('Could not load the forecast. Please try again.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const chartData = (data?.by_period || []).map((p) => ({
    ...p,
    label: fmtMonth(p.period),
  }));

  return (
    <div className="min-h-screen bg-gray-50">
      <Nav active="reports" />
      <Container>
        <PageHeader
          title="Sales forecast"
          subtitle="Weighted pipeline, projected close by month, and quota attainment."
          secondaryActions={[{ label: 'Refresh', icon: 'refresh', inline: true, onClick: load }]}
        />

        <div className="space-y-6">
          {loading && (
            <div role="status" aria-label="Computing forecast" className="space-y-6">
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="bg-white rounded border border-gray-200 px-4 py-3 shadow-card">
                    <Skeleton lines={2} />
                  </div>
                ))}
              </div>
              <Card><Skeleton lines={5} /></Card>
            </div>
          )}

          {!loading && error && <Alert tone="warning">{error}</Alert>}

          {!loading && !error && data && (
            <>
              {/* Headline stats */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <Stat
                  label="Weighted pipeline"
                  value={fmtMoney(data.weighted_pipeline)}
                  sub="Σ open amount × win probability"
                  tone="blue"
                />
                <Stat
                  label="Open pipeline"
                  value={fmtMoney(data.open_amount)}
                  sub={`${data.open_count} open deal${data.open_count === 1 ? '' : 's'}`}
                />
                <Stat
                  label="Closed won"
                  value={fmtMoney(data.won_amount_total)}
                  sub={`${data.won_count_total} won deal${data.won_count_total === 1 ? '' : 's'}`}
                  tone="emerald"
                />
                <Stat
                  label="Unscheduled open"
                  value={fmtMoney(data.unscheduled_open_amount)}
                  sub="Open deals with no close date"
                  tone="amber"
                />
              </div>

              <QuotaCard quota={data.quota} />

              {/* Projected close by month */}
              <Card title="Projected close by month">
                {chartData.length === 0 ? (
                  <EmptyState
                    icon="trending-up"
                    title="Nothing to forecast yet"
                    message="Add expected close dates and amounts to your open deals, and your weighted pipeline lights up right here."
                  />
                ) : (
                  <ResponsiveContainer width="100%" height={320}>
                    <ComposedChart data={chartData} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#eee" />
                      <XAxis dataKey="label" tick={{ fontSize: 12 }} />
                      <YAxis tick={{ fontSize: 12 }} tickFormatter={fmtMoney} width={56} />
                      <Tooltip formatter={(v) => fmtMoney(v)} />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      <Bar dataKey="committed" name="Committed" stackId="a" fill="#10b981" radius={[0, 0, 0, 0]} />
                      <Bar dataKey="best_case" name="Best case" fill="#bfdbfe" radius={[3, 3, 0, 0]} />
                      <Line dataKey="weighted" name="Weighted" stroke="#2076CD" strokeWidth={2} dot={{ r: 3 }} />
                    </ComposedChart>
                  </ResponsiveContainer>
                )}
                <p className="text-xs text-gray-400 mt-3">
                  <span className="font-medium text-success-600">Committed</span> = closed-won ·{' '}
                  <span className="font-medium text-info-400">Best case</span> = all open deals at full value ·{' '}
                  <span className="font-medium text-brand-blue">Weighted</span> = open deals × win probability.
                </p>
              </Card>
            </>
          )}
        </div>
      </Container>
    </div>
  );
}
