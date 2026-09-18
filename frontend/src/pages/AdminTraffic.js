// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Super-admin → Traffic. First-party pageview analytics over the page_views
// table (migration 165): views/day, top route patterns, top external
// referrer hosts, authenticated vs anonymous split.
//
// WHAT IT DELIBERATELY CANNOT SHOW (and says so in the UI): unique visitors.
// There is no visitor id, cookie, or fingerprint anywhere in the pipeline —
// SUBPROCESSORS.md markets "no third-party analytics" and the privacy policy
// promises first-party aggregate-only, so the honest unit is PAGE LOADS.
//
// Chart conventions mirror Reports.js (brand-blue #2076CD areas, #f3f4f6
// grid, #6b7280 ticks). The split chart's second hue (#D97706 amber) was
// validated against #2076CD for CVD separation + contrast (dataviz palette
// validator: all checks pass).

import React, { useCallback, useEffect, useState } from 'react';
import {
  ResponsiveContainer, AreaChart, Area, BarChart, Bar,
  XAxis, YAxis, Tooltip, CartesianGrid,
} from 'recharts';
import api from '../api';
import Nav from '../components/Nav';
import { useAuth } from '../AuthContext';
import { Alert, Button, Card, Container, PageHeader, Spinner } from '../components/ui';

const COLOR_AUTH = '#2076CD'; // brand blue — authenticated
const COLOR_ANON = '#D97706'; // amber — anonymous (CVD-safe vs the blue)

function fmtDay(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso).slice(5, 10);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

// Fill missing days with zeros so the x-axis is continuous even on quiet days.
function fillDays(rows, days) {
  const byDay = new Map(rows.map((r) => [String(r.day).slice(0, 10), r]));
  const out = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
    const key = d.toISOString().slice(0, 10);
    const row = byDay.get(key);
    out.push({
      day: key,
      label: fmtDay(key),
      views: row?.views || 0,
      authenticated: row?.authenticated || 0,
      anonymous: row?.anonymous || 0,
    });
  }
  return out;
}

function LegendChip({ color, label }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-gray-600">
      <span className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: color }} />
      {label}
    </span>
  );
}

// Ranked list with proportional bars — clearer than a chart for top-N tables.
function RankedBars({ rows, labelKey, max }) {
  if (!rows.length) {
    return <p className="text-sm text-gray-500 py-4">No data in this window yet.</p>;
  }
  return (
    <div className="space-y-2">
      {rows.map((r) => (
        <div key={r[labelKey]} className="flex items-center gap-3">
          <div className="w-52 sm:w-64 shrink-0 truncate text-sm text-gray-700 font-mono" title={r[labelKey]}>
            {r[labelKey]}
          </div>
          <div className="flex-1 h-4 bg-gray-100 rounded overflow-hidden">
            <div
              className="h-full rounded"
              style={{ width: `${Math.max(2, Math.round((r.views / max) * 100))}%`, backgroundColor: COLOR_AUTH }}
            />
          </div>
          <div className="w-14 shrink-0 text-right text-sm text-gray-900 tabular-nums">
            {r.views.toLocaleString()}
          </div>
        </div>
      ))}
    </div>
  );
}

function StatTile({ label, value, hint }) {
  return (
    <div className="bg-white rounded border border-gray-200 shadow-card p-5">
      <div className="text-sm text-gray-500">{label}</div>
      <div className="text-3xl font-semibold tracking-tight text-gray-900 mt-1 tabular-nums">{value}</div>
      {hint && <div className="mt-2 text-xs text-gray-500">{hint}</div>}
    </div>
  );
}

const WINDOWS = [7, 30, 90];

export default function AdminTraffic() {
  const { user } = useAuth();
  const isSuperAdmin = user?.is_admin === true && user?.admin_role === 'super_admin';

  const [days, setDays] = useState(30);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async (windowDays) => {
    setLoading(true);
    setError('');
    try {
      const r = await api.get(`/admin/traffic?days=${windowDays}`);
      setData(r.data?.data || null);
    } catch (err) {
      setError(err?.response?.data?.error || err?.response?.data?.message || err?.message || 'Failed to load traffic.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isSuperAdmin) load(days);
  }, [isSuperAdmin, days, load]);

  if (!isSuperAdmin) {
    return (
      <div className="min-h-screen bg-gray-50">
        <Nav active="admin" />
        <Container size="narrow">
          <Alert tone="danger" icon="lock" title={<h1 className="font-semibold">Access denied</h1>}>
            Traffic analytics can only be viewed by a super-admin.
          </Alert>
        </Container>
      </div>
    );
  }

  const series = data ? fillDays(data.by_day || [], data.days || days) : [];
  const totals = data?.totals || { views: 0, authenticated: 0, anonymous: 0 };
  const topPaths = data?.top_paths || [];
  const topReferrers = data?.top_referrers || [];
  const maxPath = Math.max(1, ...topPaths.map((r) => r.views));
  const maxRef = Math.max(1, ...topReferrers.map((r) => r.views));
  const authPct = totals.views > 0 ? Math.round((totals.authenticated / totals.views) * 100) : 0;

  return (
    <div className="min-h-screen bg-gray-50">
      <Nav active="admin" />
      <Container>
        <PageHeader
          title="Traffic"
          subtitle="First-party page-load analytics — measured by our own beacon, no third-party analytics, no cookies, no visitor IDs."
          actions={
            <div className="flex items-center gap-1">
              {WINDOWS.map((w) => (
                <Button
                  key={w}
                  size="sm"
                  variant={days === w ? 'primary' : 'secondary'}
                  onClick={() => setDays(w)}
                >
                  {w}d
                </Button>
              ))}
            </div>
          }
        />

        <Alert tone="info" className="mb-6">
          These are <strong>page loads, not unique visitors</strong>. There is no visitor ID,
          cookie, or fingerprint in this pipeline — uniques are deliberately uncountable.
          Paths are normalized (record IDs and tokens masked) and referrers reduced to a
          hostname before anything is stored. Rows are purged after 180 days.
        </Alert>

        {loading ? (
          <Spinner size="lg" label="Loading traffic…" />
        ) : error ? (
          <Alert tone="danger" action={<Button size="sm" variant="secondary" onClick={() => load(days)}>Retry</Button>}>
            {error}
          </Alert>
        ) : (
          <div className="space-y-6">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <StatTile label={`Page loads (${days}d)`} value={totals.views.toLocaleString()} />
              <StatTile
                label="Signed-in loads"
                value={totals.authenticated.toLocaleString()}
                hint={totals.views > 0 ? `${authPct}% of all loads` : undefined}
              />
              <StatTile
                label="Anonymous loads"
                value={totals.anonymous.toLocaleString()}
                hint="Marketing, login, portal and form pages"
              />
            </div>

            <Card
              title="Page loads per day"
              actions={<LegendChip color={COLOR_AUTH} label="All loads" />}
            >
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={series} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
                    <XAxis dataKey="label" tick={{ fontSize: 10, fill: '#6b7280' }} minTickGap={16} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 10, fill: '#6b7280' }} width={34} />
                    <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e5e7eb' }} />
                    <Area type="monotone" dataKey="views" name="Page loads"
                          stroke={COLOR_AUTH} fill={`${COLOR_AUTH}22`} strokeWidth={2} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </Card>

            <Card
              title="Signed-in vs anonymous"
              actions={
                <div className="flex items-center gap-3">
                  <LegendChip color={COLOR_AUTH} label="Signed in" />
                  <LegendChip color={COLOR_ANON} label="Anonymous" />
                </div>
              }
            >
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={series} margin={{ top: 4, right: 8, left: 0, bottom: 4 }} barCategoryGap="25%">
                    <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
                    <XAxis dataKey="label" tick={{ fontSize: 10, fill: '#6b7280' }} minTickGap={16} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 10, fill: '#6b7280' }} width={34} />
                    <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e5e7eb' }} cursor={{ fill: '#f3f4f6' }} />
                    <Bar dataKey="authenticated" name="Signed in" stackId="a" fill={COLOR_AUTH} stroke="#ffffff" strokeWidth={1} />
                    <Bar dataKey="anonymous" name="Anonymous" stackId="a" fill={COLOR_ANON} stroke="#ffffff" strokeWidth={1} radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Card>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <Card title="Top pages" subtitle="Normalized route patterns — record IDs and tokens are masked before storage.">
                <RankedBars rows={topPaths} labelKey="path" max={maxPath} />
              </Card>
              <Card title="Top referrers" subtitle="External hostnames only, first page of a visit. Direct traffic and internal navigation carry no referrer.">
                <RankedBars rows={topReferrers} labelKey="referrer_host" max={maxRef} />
              </Card>
            </div>
          </div>
        )}
      </Container>
    </div>
  );
}
