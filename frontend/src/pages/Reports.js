// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import React, { useEffect, useState } from 'react';
import {
  ResponsiveContainer, LineChart, Line, AreaChart, Area,
  XAxis, YAxis, Tooltip, CartesianGrid,
} from 'recharts';
import api from '../api';
import Nav from '../components/Nav';
import DataTable from '../components/DataTable';
import CommissionSection from '../components/CommissionSection';
import { Alert, Button, Card, Container, Input, PageHeader, Spinner, Tabs } from '../components/ui';

// --- Money formatter: compresses to $K / $M past 1k.
function fmtMoney(n) {
  if (!n && n !== 0) return '—';
  const num = Number(n);
  if (Math.abs(num) >= 1_000_000) return `$${(num / 1_000_000).toFixed(1)}M`;
  if (Math.abs(num) >= 1_000)     return `$${(num / 1_000).toFixed(0)}K`;
  return `$${num.toLocaleString()}`;
}

// --- DeltaBadge: ↑ green / ↓ red / — gray, formatted per metric type.
//   - format=count → absolute delta (whole numbers)
//   - format=currency → absolute delta in $K/$M
//   - format=days → +/- N day(s)
//   - format=percent-points → +/- N pp (for hit rate — pp reads better than %-of-%)
//   - format=percent → relative percent change (everything else)
function DeltaBadge({ value, prev, format = 'percent', label = 'vs prior period' }) {
  // Hide when prev is null/undefined (e.g. window=all) or when both sides are 0.
  if (prev === null || prev === undefined) return null;
  const curr = Number(value);
  const base = Number(prev);
  if (!Number.isFinite(curr) || !Number.isFinite(base)) return null;
  const diff = curr - base;
  if (diff === 0 && curr === 0) {
    return <span className="inline-flex items-center gap-1 text-[10px] text-gray-400 mt-0.5">—  {label}</span>;
  }
  const up = diff > 0;
  const flat = diff === 0;
  // Arrow color: emerald for up, red for down, gray for flat. For "days to
  // close", up is *worse* — invert. Caller passes invert via format='days'.
  const goodUp = format !== 'days';
  const tone = flat ? 'text-gray-500' :
               (up === goodUp ? 'text-success-700 bg-success-50' : 'text-danger-700 bg-danger-50');
  let body = '';
  if (format === 'currency')             body = `${up ? '+' : '−'}${fmtMoney(Math.abs(diff)).replace('$', '$')}`;
  else if (format === 'percent-points')  body = `${up ? '+' : ''}${diff} pp`;
  else if (format === 'days')            body = `${up ? '+' : ''}${diff}d`;
  else if (format === 'count')           body = `${up ? '+' : ''}${diff}`;
  else /* percent */ {
    if (base === 0) body = up ? 'new' : '—';
    else            body = `${up ? '↑' : '↓'}${Math.abs(Math.round((diff / base) * 100))}%`;
  }
  const arrow = flat ? '—' : (up ? '↑' : '↓');
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] font-medium mt-1 px-1.5 py-0.5 rounded-md ${tone}`}>
      <span aria-hidden>{arrow}</span>
      <span>{body}</span>
      <span className="text-gray-400 font-normal">{label}</span>
    </span>
  );
}

// --- Bucket date formatter — keeps axis labels short. Granularity comes from
// the API so we can pick MM-DD for daily, MMM-DD for weekly, MMM-YY for monthly.
function fmtBucket(iso, granularity) {
  if (!iso) return '';
  const d = new Date(`${iso}T00:00:00Z`);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  if (granularity === 'month') return `${months[d.getUTCMonth()]} ${String(d.getUTCFullYear()).slice(-2)}`;
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

// --- Empty-state placeholder shown in place of any chart when series is empty
// or all-zero. Keeps the page layout stable across windows with no data.
function ChartEmpty({ height = 220, message = 'Not enough data for this period' }) {
  return (
    <div
      className="flex items-center justify-center bg-gray-50 border border-dashed border-gray-200 rounded text-xs text-gray-500"
      style={{ height }}
    >
      {message}
    </div>
  );
}

// Stat tile. Standalone tiles carry the card shadow; pass `nested` when the
// tile sits inside a Card so it reads as a sub-surface, not a card-in-card.
function StatCard({ label, value, sub, color = 'gray', footer = null, nested = false }) {
  const colors = {
    gray:   'text-gray-900',
    green:  'text-success-600',
    blue:   'text-brand-blue',
    red:    'text-danger-600',
    yellow: 'text-warning-600',
    purple: 'text-purple-600',
  };
  return (
    <div className={`rounded border border-gray-200 p-4 ${nested ? 'bg-gray-50' : 'bg-white shadow-card'}`}>
      <p className="text-xs font-medium text-gray-500">{label}</p>
      <p className={`text-2xl font-semibold tracking-tight mt-1 ${colors[color]}`}>{value}</p>
      {sub && <p className="text-xs text-gray-500 mt-1">{sub}</p>}
      {footer && <div className="mt-1">{footer}</div>}
    </div>
  );
}

// Chart sub-panel inside a Card — a titled, bordered box (no shadow).
function ChartBox({ title, children }) {
  return (
    <div className="rounded border border-gray-200 p-3">
      <p className="text-sm font-medium text-gray-700 mb-2">{title}</p>
      {children}
    </div>
  );
}

function TableEmpty({ children }) {
  return <p className="text-sm text-gray-500 px-5 py-8 text-center">{children}</p>;
}

// --- Period selector: the single source of truth at the top of the page.
// Backend accepts {7d, month, quarter, ytd, all, custom}. For `custom`, also
// pass from=YYYY-MM-DD&to=YYYY-MM-DD.
const PERIODS = [
  { id: '7d',      label: 'Last 7 days',  hint: 'Recent activity' },
  { id: 'month',   label: 'This month',   hint: 'Calendar month to date' },
  { id: 'quarter', label: 'This quarter', hint: 'Calendar quarter to date' },
  { id: 'ytd',     label: 'Year to date', hint: 'Default — current calendar year' },
  { id: 'all',     label: 'All time',     hint: 'Lifetime totals' },
  { id: 'custom',  label: 'Custom…',      hint: 'Pick a start and end date' },
];

function todayISO()        { return new Date().toISOString().slice(0, 10); }
function firstOfMonthISO() { const d = new Date(); d.setDate(1); return d.toISOString().slice(0, 10); }

// --- Label shown next to each delta badge. For known windows we use a fixed
// phrasing; for custom we explicitly say "vs prior N days" because the user
// picked the range and that's the most concrete reference point.
function deltaLabel(period, dateFrom, dateTo) {
  if (period === '7d')      return 'vs prior 7d';
  if (period === 'month')   return 'vs prior month';
  if (period === 'quarter') return 'vs prior quarter';
  if (period === 'ytd')     return 'vs prior YTD';
  if (period === 'custom' && dateFrom && dateTo) {
    const f = new Date(`${dateFrom}T00:00:00Z`);
    const t = new Date(`${dateTo}T00:00:00Z`);
    const days = Math.round((t - f) / 86400000) + 1;
    return `vs prior ${days} day${days === 1 ? '' : 's'}`;
  }
  return 'vs prior period';
}

function PeriodSelector({ value, onChange, dateFrom, dateTo, onDateFromChange, onDateToChange }) {
  const customInvalid = value === 'custom' && (!dateFrom || !dateTo || dateFrom > dateTo);
  const current = PERIODS.find(p => p.id === value);
  return (
    <Card
      title={current?.label || 'Year to date'}
      subtitle={current?.hint}
      padding={value === 'custom' ? 'sm' : 'none'}
      actions={
        <div className="flex flex-wrap gap-1 bg-gray-100 rounded-md p-1" role="group" aria-label="Report period">
          {PERIODS.map(p => (
            <button
              key={p.id}
              type="button"
              onClick={() => onChange(p.id)}
              aria-pressed={value === p.id}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition ${value === p.id
                ? 'bg-white text-brand-blue shadow-sm'
                : 'text-gray-600 hover:text-gray-900'}`}
            >
              {p.label}
            </button>
          ))}
        </div>
      }
    >
      {value === 'custom' && (
        <div className="flex flex-wrap items-end gap-3">
          <Input
            type="date" label="From" size="sm" value={dateFrom} max={dateTo || undefined}
            onChange={e => onDateFromChange(e.target.value)}
            wrapperClassName="w-44"
          />
          <Input
            type="date" label="To" size="sm" value={dateTo} min={dateFrom || undefined} max={todayISO()}
            onChange={e => onDateToChange(e.target.value)}
            wrapperClassName="w-44"
          />
          {customInvalid && (
            <Alert tone="warning" className="py-1.5">
              {(!dateFrom || !dateTo) ? 'Pick both dates to load report' : 'From must be on or before To'}
            </Alert>
          )}
        </div>
      )}
    </Card>
  );
}

const SALESMAN_COLUMNS = [
  { key: 'name', label: 'Salesman', render: sm => sm.name || sm.email },
  { key: 'open_pipeline', label: 'Open', align: 'right' },
  { key: 'hot', label: 'Hot', align: 'right' },
  { key: 'won_count', label: 'Won', align: 'right', render: sm => <span className="text-success-700 font-semibold">{sm.won_count}</span> },
  { key: 'lost_count', label: 'Lost', align: 'right', render: sm => <span className="text-danger-700">{sm.lost_count}</span> },
  { key: 'hit_rate', label: 'Hit rate', align: 'right', render: sm => (sm.hit_rate !== null ? `${sm.hit_rate}%` : '—') },
  { key: 'pipeline_value', label: 'Pipeline', align: 'right', render: sm => fmtMoney(sm.pipeline_value) },
  { key: 'ytd_won_value', label: 'YTD won', align: 'right', render: sm => fmtMoney(sm.ytd_won_value) },
  { key: 'eoy_projected_won', label: 'EOY proj.', align: 'right', render: sm => <span className="font-medium text-brand-blue">{fmtMoney(sm.eoy_projected_won)}</span> },
];

// --- Sales tab: per-salesman performance is the headline because that's
// what the user opens /reports for ~most of the time. Hit rate / funnel
// strip sits below as supporting context.
function SalesTab({ data, deltaLabel }) {
  const s = data.sales || {};
  const prev = data.prev || null; // null for window=all
  const series = data.series || [];
  const granularity = data.granularity || 'day';
  // Group "top customers per salesman" — keeps top 5 per row.
  const topCustomersBySalesman = {};
  for (const r of (data.top_customers_per_salesman || [])) {
    if (!topCustomersBySalesman[r.salesman_name]) topCustomersBySalesman[r.salesman_name] = [];
    if (topCustomersBySalesman[r.salesman_name].length < 5) topCustomersBySalesman[r.salesman_name].push(r);
  }

  // Series shape recharts wants: a stable key + label. Compute hit rate per
  // bucket on the FE to avoid an extra round-trip on the API.
  const chartData = series.map(r => ({
    bucket: fmtBucket(r.bucket_start, granularity),
    won_count: r.won_count,
    won_value: r.won_value,
    lost_count: r.lost_count,
    hit_rate: (r.won_count + r.lost_count) > 0
      ? Math.round((r.won_count / (r.won_count + r.lost_count)) * 100)
      : null,
    pipeline_value_snapshot: r.pipeline_value_snapshot,
  }));
  const hasWonSeries = chartData.some(d => d.won_count > 0 || d.won_value > 0);
  const hasHitRateSeries = chartData.some(d => d.hit_rate !== null);

  return (
    <div className="space-y-6">
      {/* Hero strip — three big numbers the salesman / VP-Sales actually cares about. */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Won" value={s.won || 0} color="green"
          footer={prev && <DeltaBadge value={s.won || 0} prev={prev.won} format="percent" label={deltaLabel} />} />
        <StatCard label="Lost" value={s.lost || 0} color="red"
          footer={prev && <DeltaBadge value={s.lost || 0} prev={prev.lost} format="percent" label={deltaLabel} />} />
        <StatCard label="Hit rate"
          value={s.hit_rate !== null && s.hit_rate !== undefined ? `${s.hit_rate}%` : '—'}
          color={s.hit_rate >= 50 ? 'green' : 'yellow'}
          footer={prev && s.hit_rate !== null && prev.hit_rate !== null && (
            <DeltaBadge value={s.hit_rate} prev={prev.hit_rate} format="percent-points" label={deltaLabel} />
          )} />
        <StatCard label="Avg days to close" value={s.avg_days_to_close || '—'} sub="From creation to won"
          footer={prev && prev.avg_days_to_close > 0 && s.avg_days_to_close > 0 && (
            <DeltaBadge value={s.avg_days_to_close} prev={prev.avg_days_to_close} format="days" label={deltaLabel} />
          )} />
      </div>

      {/* Chart strip — wins + hit rate trajectory. brand-blue line for the
          primary "won over time" signal; emerald accent for hit rate so the
          eye associates it with the green "Won" StatCard above. */}
      <Card title="Trend" subtitle={`Bucketed by ${granularity}`}>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <ChartBox title="Won over time">
            {hasWonSeries ? (
              <ResponsiveContainer width="100%" height={220}>
                <AreaChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
                  <XAxis dataKey="bucket" tick={{ fontSize: 10, fill: '#6b7280' }} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 10, fill: '#6b7280' }} width={28} />
                  <Tooltip
                    contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e5e7eb' }}
                    formatter={(v, name) => name === 'won_value' ? fmtMoney(v) : v}
                  />
                  <Area type="monotone" dataKey="won_count" name="Won (count)"
                        stroke="#2076CD" fill="#2076CD22" strokeWidth={2} />
                </AreaChart>
              </ResponsiveContainer>
            ) : <ChartEmpty />}
          </ChartBox>
          <ChartBox title="Hit rate over time">
            {hasHitRateSeries ? (
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
                  <XAxis dataKey="bucket" tick={{ fontSize: 10, fill: '#6b7280' }} />
                  <YAxis domain={[0, 100]} tick={{ fontSize: 10, fill: '#6b7280' }} width={28}
                         tickFormatter={v => `${v}%`} />
                  <Tooltip
                    contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e5e7eb' }}
                    formatter={v => v === null ? '—' : `${v}%`}
                  />
                  <Line type="monotone" dataKey="hit_rate" name="Hit rate"
                        stroke="#059669" strokeWidth={2} dot={{ r: 2 }}
                        connectNulls />
                </LineChart>
              </ResponsiveContainer>
            ) : <ChartEmpty message="No closed deals in this period" />}
          </ChartBox>
        </div>
      </Card>

      {/* Per-salesman leaderboard — the primary table. */}
      <Card
        title="Per-salesman performance"
        subtitle="EOY projection = run-rate of YTD won extrapolated to year-end"
        padding="none"
      >
        {(data.salesmen || []).length === 0 ? (
          <TableEmpty>No salesman activity yet.</TableEmpty>
        ) : (
          <DataTable flush columns={SALESMAN_COLUMNS} data={data.salesmen} minWidth={760} />
        )}
      </Card>

      {/* Top customers per salesman — collapsed reference info. */}
      {Object.keys(topCustomersBySalesman).length > 0 && (
        <details className="bg-white border border-gray-200 rounded shadow-card">
          <summary className="cursor-pointer px-5 py-4 text-base font-semibold text-gray-900 hover:bg-gray-50 rounded">
            Top customers per salesman ({Object.keys(topCustomersBySalesman).length})
          </summary>
          <div className="px-5 pb-5 grid grid-cols-1 md:grid-cols-2 gap-3">
            {Object.entries(topCustomersBySalesman).map(([salesman, custs]) => (
              <div key={salesman} className="bg-gray-50 rounded border border-gray-200 p-3">
                <p className="font-semibold text-sm text-gray-900 mb-2">{salesman}</p>
                <ol className="space-y-1 text-xs">
                  {custs.map(c => (
                    <li key={c.customer_id} className="flex justify-between">
                      <span className="text-gray-700">{c.customer_name || 'Unknown'}</span>
                      <span className="text-gray-500">{c.deal_count} deal · {fmtMoney(c.value)}</span>
                    </li>
                  ))}
                </ol>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

const STAGE_COLUMNS = [
  { key: 'phase', label: 'Phase', render: r => <span className="text-gray-500 capitalize">{String(r.phase || '').replace(/_/g, ' ')}</span> },
  { key: 'stage', label: 'Stage', render: r => <span className="font-mono text-xs">{r.stage}</span> },
  { key: 'count', label: 'Count', align: 'right' },
  { key: 'value', label: 'Value', align: 'right', render: r => fmtMoney(r.value) },
];

// --- Pipeline tab: funnel breakdown + per-stage live counts + customer
// freshness numbers. Answers "where is the work concentrated and is the
// top of the funnel healthy?"
function PipelineTab({ data }) {
  const s = data.sales || {};
  const customers = data.customers || {};
  const series = data.series || [];
  const granularity = data.granularity || 'day';

  // Pipeline-value chart: use the running snapshot when we have it; fall back
  // to won_value per bucket if every snapshot row is 0 (e.g. no pre_sale deals
  // existed before the window).
  const pipelineHasSnapshot = series.some(r => Number(r.pipeline_value_snapshot) > 0);
  const chartData = series.map(r => ({
    bucket: fmtBucket(r.bucket_start, granularity),
    pipeline: pipelineHasSnapshot ? Number(r.pipeline_value_snapshot) : Number(r.won_value),
  }));
  const hasPipelineSeries = chartData.some(d => d.pipeline > 0);

  return (
    <div className="space-y-6">
      {/* Pipeline value over time — answers "is my pipeline growing or
          shrinking week-over-week?" Uses the running snapshot of open
          pre_sale value at each bucket boundary, with a won-value fallback. */}
      <Card
        title={pipelineHasSnapshot ? 'Pipeline value over time' : 'Won value over time'}
        subtitle={`Bucketed by ${granularity}`}
      >
        {hasPipelineSeries ? (
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
              <XAxis dataKey="bucket" tick={{ fontSize: 10, fill: '#6b7280' }} />
              <YAxis tick={{ fontSize: 10, fill: '#6b7280' }} width={48} tickFormatter={fmtMoney} />
              <Tooltip
                contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e5e7eb' }}
                formatter={v => fmtMoney(v)}
              />
              <Area type="monotone" dataKey="pipeline" name={pipelineHasSnapshot ? 'Pipeline' : 'Won'}
                    stroke="#2076CD" fill="#2076CD22" strokeWidth={2} />
            </AreaChart>
          </ResponsiveContainer>
        ) : <ChartEmpty />}
      </Card>

      {/* Funnel breakdown — five-step strip mirrors the Zang Exhibit-A funnel. */}
      <Card title="Pre-sale funnel" subtitle="Live counts across pre-sale stages">
        <div className="grid grid-cols-5 gap-2">
          {[
            ['Triage', s.triage],
            ['Quoting', s.quoting],
            ['Follow up', s.follow_up],
            ['No follow up', s.no_follow_up],
            ['Cold', s.cold],
          ].map(([label, val]) => (
            <div key={label} className="text-center">
              <p className="text-2xl font-semibold tracking-tight text-gray-900">{val || 0}</p>
              <p className="text-xs text-gray-500">{label}</p>
            </div>
          ))}
        </div>
      </Card>

      {/* Customer freshness — at-risk dormant accounts ranked red. */}
      <Card title="Customer freshness" subtitle="New = first deal in the period · dormant = no recent deal activity">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard nested label="New (this year)" value={customers.new_this_year || 0} color="green" />
          <StatCard nested label="New (90d)" value={customers.new_90d || 0} color="blue" />
          <StatCard nested label="Dormant (180d)" value={customers.dormant_180d || 0} color="yellow" />
          <StatCard nested label="Dormant (1y)" value={customers.dormant_1y || 0} color="red" />
        </div>
      </Card>

      {/* Per-stage live counts — full breakdown, useful for ops debugging. */}
      <Card title="Per-stage live counts" subtitle="Company-wide snapshot, all phases" padding="none">
        {(data.per_stage || []).length === 0 ? (
          <TableEmpty>No deal data.</TableEmpty>
        ) : (
          <DataTable flush density="compact" columns={STAGE_COLUMNS} data={data.per_stage} rowKey={r => `${r.phase}-${r.stage}`} />
        )}
      </Card>

      {/* Issues breakdown — operations health. Collapsed by default because
          most users only care about it during an incident review. */}
      <IssuesPanel issues={data.issues || {}} />
    </div>
  );
}

const VENDOR_COLUMNS = [
  { key: 'name', label: 'Vendor' },
  { key: 'quoted_total', label: 'Quoted', align: 'right', render: v => fmtMoney(v.quoted_total) },
  { key: 'won_total', label: 'Won', align: 'right', render: v => <span className="text-success-700 font-semibold">{fmtMoney(v.won_total)}</span> },
  { key: 'deals_quoted', label: 'Quoted #', align: 'right' },
  { key: 'deals_won', label: 'Won #', align: 'right' },
  { key: 'vendor_hit_rate', label: 'Hit rate', align: 'right', render: v => (v.vendor_hit_rate !== null ? `${v.vendor_hit_rate}%` : '—') },
  { key: 'avg_lead_time_days', label: 'Avg lead', align: 'right', render: v => `${Number(v.avg_lead_time_days).toFixed(0)}d` },
];

// --- Vendors tab: per-vendor leaderboard. Answers "which vendors are
// pulling their weight?"
function VendorsTab({ data }) {
  return (
    <div className="space-y-6">
      <Card
        title="Vendor leaderboard"
        subtitle="Quoted, won, hit rate, average lead time — sorted by won-value"
        padding="none"
      >
        {(data.vendors || []).length === 0 ? (
          <TableEmpty>No vendor activity yet.</TableEmpty>
        ) : (
          <DataTable flush columns={VENDOR_COLUMNS} data={data.vendors} minWidth={640} />
        )}
      </Card>
    </div>
  );
}

const ISSUE_CATEGORY_COLUMNS = [
  { key: 'category', label: 'Category', render: c => c.category || '(none)' },
  { key: 'open_count', label: 'Open', align: 'right' },
  { key: 'total', label: 'Total', align: 'right' },
  { key: 'avg_resolution_hours', label: 'Avg hrs', align: 'right', render: c => Number(c.avg_resolution_hours).toFixed(1) },
];
const ISSUE_SALESMAN_COLUMNS = [
  { key: 'name', label: 'Salesman', render: p => p.name || p.email },
  { key: 'open_count', label: 'Open', align: 'right' },
  { key: 'total', label: 'Total', align: 'right' },
];
const ISSUE_IMPACT_COLUMNS = [
  { key: 'financial_impact', label: 'Impact' },
  { key: 'count', label: 'Count', align: 'right' },
];

function IssueBox({ title, rows, columns, rowKey, emptyText }) {
  return (
    <div className="rounded border border-gray-200 overflow-hidden">
      <p className="text-sm font-medium text-gray-700 px-3 py-2 bg-gray-50 border-b border-gray-200">{title}</p>
      {rows.length === 0 ? (
        <p className="text-xs text-gray-500 p-4">{emptyText}</p>
      ) : (
        <DataTable flush density="compact" stickyHeader={false} columns={columns} data={rows} rowKey={rowKey} />
      )}
    </div>
  );
}

// --- Issues breakdown — three sub-tables in a horizontal grid. Kept compact
// inside a <details> disclosure so it doesn't dominate the Pipeline tab.
function IssuesPanel({ issues }) {
  return (
    <details className="bg-white border border-gray-200 rounded shadow-card">
      <summary className="cursor-pointer px-5 py-4 text-base font-semibold text-gray-900 hover:bg-gray-50 rounded">
        Issues — by category, salesman, financial impact
      </summary>
      <div className="px-5 pb-5 grid grid-cols-1 md:grid-cols-3 gap-3">
        <IssueBox title="By category" rows={issues.by_category || []} columns={ISSUE_CATEGORY_COLUMNS} rowKey="category" emptyText="No issues." />
        <IssueBox title="By salesman" rows={issues.per_salesman || []} columns={ISSUE_SALESMAN_COLUMNS} rowKey="id" emptyText="No issues." />
        <IssueBox title="By financial impact" rows={issues.by_financial_impact || []} columns={ISSUE_IMPACT_COLUMNS} rowKey="financial_impact" emptyText="No financial-impact tags set." />
      </div>
    </details>
  );
}

const TABS = [
  { id: 'sales',      label: 'Sales',      hint: 'Per-salesman performance, hit rate, EOY projection' },
  { id: 'pipeline',   label: 'Pipeline',   hint: 'Funnel, stage counts, customer freshness, issues' },
  { id: 'vendors',    label: 'Vendors',    hint: 'Per-vendor leaderboard, lead time' },
  { id: 'commission', label: 'Commission', hint: 'Per-rep commission on closed-won deals, rates, goals' },
];

export default function Reports() {
  const [period, setPeriod] = useState('ytd');
  const [dateFrom, setDateFrom] = useState(firstOfMonthISO());
  const [dateTo,   setDateTo]   = useState(todayISO());
  const [tab, setTab] = useState('sales'); // sales | pipeline | vendors | commission
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    // Custom window needs both dates valid before we hit the API — otherwise
    // hold off and let the user finish picking.
    if (period === 'custom' && (!dateFrom || !dateTo || dateFrom > dateTo)) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const qsParams = period === 'custom'
      ? `window=custom&from=${dateFrom}&to=${dateTo}`
      : `window=${period}`;
    api.get(`/metrics/reports?${qsParams}`)
      .then(r => { setData(r.data); setError(''); })
      .catch(err => setError(err.response?.data?.error || 'Failed to load reports'))
      .finally(() => setLoading(false));
  }, [period, dateFrom, dateTo]);

  return (
    <div className="min-h-screen bg-gray-50">
      <Nav active="reports" />
      <Container size="wide">
        <PageHeader
          title="Reports"
          subtitle="Sales, pipeline, and vendor analytics — one period at a time."
          primaryAction={<Button as="a" href="/reports/builder" icon="plus">Custom report builder</Button>}
        />

        <div className="space-y-6">
          {/* Hero period selector — single source of truth at the top. */}
          <PeriodSelector
            value={period} onChange={setPeriod}
            dateFrom={dateFrom} dateTo={dateTo}
            onDateFromChange={setDateFrom} onDateToChange={setDateTo}
          />

          {/* Tab strip — Sales is default because that's the most common landing intent. */}
          <div>
            <Tabs aria-label="Report sections" items={TABS} value={tab} onChange={setTab} />
            <p className="px-1 pt-2 text-xs text-gray-500">{TABS.find(t => t.id === tab)?.hint}</p>
          </div>

          {error && <Alert tone="danger" onDismiss={() => setError('')}>{error}</Alert>}

          {/* Commission has its own period picker + data fetch — render it
              independently of the /metrics/reports load state. */}
          {tab === 'commission' ? (
            <CommissionSection />
          ) : loading ? (
            <Spinner size="lg" label="Loading report…" />
          ) : !data ? null : (
            <>
              {tab === 'sales'    && <SalesTab data={data} deltaLabel={deltaLabel(period, dateFrom, dateTo)} />}
              {tab === 'pipeline' && <PipelineTab data={data} />}
              {tab === 'vendors'  && <VendorsTab data={data} />}
            </>
          )}
        </div>
      </Container>
    </div>
  );
}
