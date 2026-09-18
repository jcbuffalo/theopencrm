// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  ResponsiveContainer, BarChart, Bar, Cell,
  XAxis, YAxis, Tooltip, CartesianGrid,
} from 'recharts';
import api, { winback as winbackApi } from '../api';
import Nav from '../components/Nav';
import DataTable from '../components/DataTable';
import {
  Alert, Button, Card, Container, EmptyState, Input, Modal, PageHeader,
  Select, Skeleton, StatusBadge, Tabs,
} from '../components/ui';

// Retention & Expansion — ONE page, two tabs:
//   • Overview  — recurring revenue, NRR/GRR, MRR movement, renewals, pulse/NPS
//                 (GET /api/retention + /pulse/summary + /surveys/summary)
//   • Win-back  — the churned-account re-engagement board that used to live at
//                 /winback (GET /api/winback + /summary, POST /winback/:id/reengage)
// /winback still works: Winback.js renders <Retention initialTab="winback" />.
// `?tab=winback` on /retention preselects the tab too.

const TAB_ITEMS = [
  { id: 'overview', label: 'Overview' },
  { id: 'winback', label: 'Win-back' },
];

// --- Money formatter: compresses to $K / $M past 1k (mirrors Forecast.js).
function fmtMoney(n) {
  if (n === null || n === undefined || n === '') return '—';
  const num = Number(n);
  if (!Number.isFinite(num)) return '—';
  if (Math.abs(num) >= 1_000_000) return `$${(num / 1_000_000).toFixed(1)}M`;
  if (Math.abs(num) >= 1_000)     return `$${(num / 1_000).toFixed(0)}K`;
  return `$${num.toLocaleString()}`;
}

// --- Percent formatter: a ratio (1.08) → "108%". null → "—".
function fmtPct(ratio) {
  if (ratio === null || ratio === undefined) return '—';
  const num = Number(ratio);
  if (!Number.isFinite(num)) return '—';
  return `${Math.round(num * 100)}%`;
}

function fmtDateShort(ts) {
  if (!ts) return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString();
}

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

// --- NRR/GRR gauge: a labeled ratio with a 100%-anchored bar. NRR above 100%
//     is expansion (green); below is net contraction (amber).
function RetentionGauge({ label, ratio, hint }) {
  const pct = ratio == null ? null : Math.round(ratio * 100);
  const tone = pct == null ? 'bg-gray-300' : pct >= 100 ? 'bg-success-500' : pct >= 90 ? 'bg-brand-blue' : 'bg-warning-500';
  // Scale the bar so 100% sits at ~66% width, leaving headroom to show >100%.
  const width = pct == null ? 0 : Math.min((pct / 150) * 100, 100);
  return (
    <Card
      title={label}
      actions={<span className="text-2xl font-semibold tracking-tight text-gray-900">{fmtPct(ratio)}</span>}
    >
      <div className="relative h-3 w-full rounded-full bg-gray-100 overflow-hidden">
        <div className={`absolute inset-y-0 left-0 ${tone}`} style={{ width: `${width}%` }} />
        {/* 100% reference marker */}
        <div className="absolute inset-y-0" style={{ left: '66.6%' }}>
          <div className="w-px h-full bg-gray-400" />
        </div>
      </div>
      <div className="mt-1 text-xs text-gray-400">{hint}</div>
    </Card>
  );
}

// Promoter / passive / detractor bar + legend shared by the two NPS cards.
function NpsBreakdown({ promoters, passives, detractors, denominator, trailing, note }) {
  const seg = (n) => (denominator > 0 ? `${(n / denominator) * 100}%` : '0%');
  return (
    <>
      <div className="h-3 w-full rounded-full bg-gray-100 overflow-hidden flex">
        <div className="bg-success-500 h-full" style={{ width: seg(promoters) }} />
        <div className="bg-warning-400 h-full" style={{ width: seg(passives) }} />
        <div className="bg-danger-500 h-full" style={{ width: seg(detractors) }} />
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500">
        <span><span className="font-medium text-success-600">{promoters}</span> promoter{promoters === 1 ? '' : 's'}</span>
        <span><span className="font-medium text-warning-600">{passives}</span> passive{passives === 1 ? '' : 's'}</span>
        <span><span className="font-medium text-danger-600">{detractors}</span> detractor{detractors === 1 ? '' : 's'}</span>
        <span className="text-gray-400">{trailing}</span>
      </div>
      <div className="mt-1 text-xs text-gray-400">{note}</div>
    </>
  );
}

const npsToneCls = (nps) =>
  nps == null ? 'text-gray-400' : nps >= 30 ? 'text-success-700' : nps >= 0 ? 'text-brand-blue-dark' : 'text-danger-700';

// --- Relationship Pulse (NPS) rollup card. Latest pulse per account →
//     promoter/passive/detractor breakdown + the org NPS number. Degrades to a
//     friendly "no pulse data yet" state when nothing's been recorded.
function PulseCard({ pulse }) {
  const total = pulse?.total_accounts || 0;
  const nps = pulse?.nps;
  return (
    <Card
      title="Relationship pulse (NPS)"
      actions={<span className={`text-2xl font-semibold tracking-tight ${npsToneCls(nps)}`}>{nps == null ? '—' : nps}</span>}
    >
      {total === 0 ? (
        <p className="text-sm text-gray-500">
          No pulse data yet — record a satisfaction pulse from the Accounts page and your NPS will show up here.
        </p>
      ) : (
        <NpsBreakdown
          promoters={pulse.promoters}
          passives={pulse.passives}
          detractors={pulse.detractors}
          denominator={total}
          trailing={`· latest pulse per account, ${total} account${total === 1 ? '' : 's'} surveyed`}
          note="NPS = %promoters − %detractors (9–10 / 7–8 / 0–6 on the 0–10 scale)."
        />
      )}
    </Card>
  );
}

// --- Survey NPS rollup card (CS-7). Same banding math as PulseCard (via the
//     backend's shared relationshipPulse normalization) but sourced from
//     completed NPS/CSAT survey responses. Degrades to a friendly empty state.
function SurveyCard({ summary }) {
  const overall = summary?.overall;
  const responded = overall?.responded || 0;
  const nps = overall?.nps;
  return (
    <Card
      title="Survey NPS"
      actions={<span className={`text-2xl font-semibold tracking-tight ${npsToneCls(nps)}`}>{nps == null ? '—' : nps}</span>}
    >
      {responded === 0 ? (
        <p className="text-sm text-gray-500">
          No survey responses yet — create an NPS or CSAT survey on the Surveys page, share the response links, and the rollup will show up here.
        </p>
      ) : (
        <NpsBreakdown
          promoters={overall.promoters}
          passives={overall.passives}
          detractors={overall.detractors}
          denominator={responded}
          trailing={`· ${responded} of ${overall.sent} link${overall.sent === 1 ? '' : 's'} answered${overall.response_rate != null ? ` (${Math.round(overall.response_rate * 100)}%)` : ''}`}
          note="Same bands as Relationship Pulse — CSAT responses are normalized onto the 0–10 scale."
        />
      )}
    </Card>
  );
}

function OverviewSkeleton() {
  return (
    <div role="status" aria-label="Computing retention" className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="bg-white rounded border border-gray-200 px-4 py-3 shadow-card">
            <Skeleton lines={2} />
          </div>
        ))}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card><Skeleton lines={3} /></Card>
        <Card><Skeleton lines={3} /></Card>
      </div>
      <Card><Skeleton lines={6} /></Card>
    </div>
  );
}

// =============================================================================
// Overview tab
// =============================================================================
function RetentionOverview({ refreshKey }) {
  const [data, setData] = useState(null);
  const [pulse, setPulse] = useState(null);
  const [surveySummary, setSurveySummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get('/retention');
      setData(res.data);
    } catch (e) {
      const status = e?.response?.status;
      if (status === 403) setError('Customer Success isn’t enabled for this workspace. An admin can turn it on under Feature Flags.');
      else setError('Could not load retention analytics. Please try again.');
    } finally {
      setLoading(false);
    }
    // Pulse rollup is a best-effort side panel: a failure here (or zero
    // pulses) must never error out the retention page.
    try {
      const pres = await api.get('/pulse/summary');
      setPulse(pres.data);
    } catch {
      setPulse(null);
    }
    // Survey rollup (CS-7) — same best-effort contract as the pulse card.
    try {
      const sres = await api.get('/surveys/summary');
      setSurveySummary(sres.data);
    } catch {
      setSurveySummary(null);
    }
  }, []);

  useEffect(() => { load(); }, [load, refreshKey]);

  const rec = data?.recurring;
  const retn = data?.retention;
  const ren = data?.renewals;
  const exp = data?.expansion;
  const churn = data?.churn;

  // Upcoming-renewal value across the three horizons for a small bar chart.
  const upcoming = ren?.upcoming;
  const renewalChart = upcoming ? [
    { label: 'Next 30d', value: upcoming.d30?.value || 0, count: upcoming.d30?.count || 0 },
    { label: 'Next 60d', value: upcoming.d60?.value || 0, count: upcoming.d60?.count || 0 },
    { label: 'Next 90d', value: upcoming.d90?.value || 0, count: upcoming.d90?.count || 0 },
  ] : [];

  // MRR movement waterfall-ish bars (starting → expansion / contraction / churn).
  const movement = retn ? [
    { label: 'Starting',    value: retn.starting_mrr || 0,     fill: '#94a3b8' },
    { label: 'Expansion',   value: retn.expansion_mrr || 0,    fill: '#10b981' },
    { label: 'Contraction', value: -(retn.contraction_mrr || 0), fill: '#f59e0b' },
    { label: 'Churn',       value: -(retn.churned_mrr || 0),   fill: '#ef4444' },
    { label: 'Current',     value: retn.current_cohort_mrr || 0, fill: '#2076CD' },
  ] : [];

  const nothingYet = data
    && (rec?.active_contract_count || 0) === 0
    && (rec?.mrr || 0) === 0
    && (exp?.deal_count || 0) === 0;

  const months = Math.round((retn?.window_days || 365) / 30);

  if (loading) return <OverviewSkeleton />;
  if (error) return <Alert tone="warning">{error}</Alert>;
  if (!data) return null;

  return (
    <>
      {nothingYet && (
        <Card>
          <EmptyState
            icon="trending-up"
            title="No recurring revenue to report yet"
            message="Add service contracts with a monthly amount and a start/end date, and win a few repeat deals — your MRR, renewal rate, and net revenue retention will light up right here."
          />
        </Card>
      )}

      {!nothingYet && (
        <>
          {/* Headline recurring-revenue stats */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <Stat label="MRR" value={fmtMoney(rec?.mrr)} sub="Monthly recurring revenue" tone="blue" />
            <Stat
              label="ARR"
              value={fmtMoney(rec?.arr)}
              sub={`${rec?.active_contract_count || 0} active contract${rec?.active_contract_count === 1 ? '' : 's'}`}
              tone="emerald"
            />
            <Stat
              label="Renewal rate"
              value={fmtPct(ren?.rate?.rate)}
              sub={`${ren?.rate?.renewed || 0} renewed · ${ren?.rate?.churned || 0} churned (trailing ${Math.round((ren?.rate?.window_days || 365) / 30)}mo)`}
            />
            <Stat
              label="Churned (ARR lost)"
              value={fmtMoney(churn?.lost_arr)}
              sub={`${churn?.contract_count || 0} contract${churn?.contract_count === 1 ? '' : 's'} not renewed`}
              tone="rose"
            />
          </div>

          {/* NRR / GRR gauges */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <RetentionGauge
              label="Net revenue retention (NRR)"
              ratio={retn?.nrr}
              hint={`Σ current MRR ÷ Σ starting MRR for the ${months}-month cohort (incl. expansion). Marker = 100%.`}
            />
            <RetentionGauge
              label="Gross revenue retention (GRR)"
              ratio={retn?.grr}
              hint="Same cohort, upside capped at each customer's starting MRR (no expansion counted). Marker = 100%."
            />
          </div>

          {/* MRR movement */}
          <Card title={`Cohort MRR movement (trailing ${months} months)`}>
            {movement.every((m) => m.value === 0) ? (
              <div className="text-sm text-gray-500 py-8 text-center">Not enough contract history yet to show MRR movement.</div>
            ) : (
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={movement} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#eee" />
                  <XAxis dataKey="label" tick={{ fontSize: 12 }} />
                  <YAxis tick={{ fontSize: 12 }} tickFormatter={fmtMoney} width={56} />
                  <Tooltip formatter={(v) => fmtMoney(Math.abs(v))} />
                  <Bar dataKey="value" radius={[3, 3, 0, 0]}>
                    {movement.map((m, i) => <Cell key={i} fill={m.fill} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
            <p className="text-xs text-gray-400 mt-3">
              Cohort = customers with an active contract {months} months ago.{' '}
              <span className="font-medium text-success-600">Expansion</span> and{' '}
              <span className="font-medium text-warning-600">contraction</span> /{' '}
              <span className="font-medium text-danger-600">churn</span> move starting MRR to current MRR.
            </p>
          </Card>

          {/* Upcoming renewals + expansion */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <Card className="lg:col-span-2" title="Upcoming renewal value (annualized)">
              {renewalChart.every((r) => r.value === 0) ? (
                <div className="text-sm text-gray-500 py-8 text-center">No active contracts are coming up for renewal in the next 90 days.</div>
              ) : (
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={renewalChart} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#eee" />
                    <XAxis dataKey="label" tick={{ fontSize: 12 }} />
                    <YAxis tick={{ fontSize: 12 }} tickFormatter={fmtMoney} width={56} />
                    <Tooltip formatter={(v, n, p) => [`${fmtMoney(v)} · ${p?.payload?.count || 0} contract(s)`, 'Value']} />
                    <Bar dataKey="value" name="Value" fill="#6366f1" radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </Card>
            <Card bodyClassName="flex flex-col justify-center h-full">
              <div className="text-xs font-medium text-gray-500">Expansion (trailing {Math.round((exp?.window_days || 365) / 30)}mo)</div>
              <div className="text-3xl font-semibold tracking-tight text-success-700 mt-1">{fmtMoney(exp?.amount)}</div>
              <div className="text-xs text-gray-400 mt-1">
                {exp?.deal_count || 0} repeat-sale deal{exp?.deal_count === 1 ? '' : 's'} to {exp?.customer_count || 0} existing customer{exp?.customer_count === 1 ? '' : 's'}
              </div>
              <p className="text-xs text-gray-400 mt-3 border-t border-gray-100 pt-3">
                A won deal counts as expansion when the customer already had a contract or a prior won deal before it closed.
              </p>
            </Card>
          </div>
        </>
      )}

      {/* Relationship Pulse + Survey NPS rollups — rendered whether or not
          there's contract data yet (an org can survey accounts before it
          has MRR to report). */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <PulseCard pulse={pulse} />
        <SurveyCard summary={surveySummary} />
      </div>
    </>
  );
}

// =============================================================================
// Win-back tab — churned-account re-engagement (formerly pages/Winback.js).
//
// Accounts marked churned (with WHEN + WHY, migration 127) queue up here,
// newest churn first, and a single "Start win-back" action creates the
// outreach task (optionally moving the account back to prospect/onboarding).
// Data comes from GET /api/winback + /api/winback/summary (see
// backend/routes/winbackRoutes.js); the write is POST /api/winback/:id/reengage
// — org owner/admin only, so members see the server's 403 message if they try.
// =============================================================================

// Labels for the backend CHURN_REASONS allowlist (schemas/companies.js).
const REASON_LABELS = {
  price: 'Price',
  product_fit: 'Product fit',
  competitor: 'Lost to competitor',
  lost_champion: 'Lost champion',
  went_out_of_business: 'Out of business',
  no_budget: 'No budget',
  poor_engagement: 'Poor engagement',
  other: 'Other',
};

// Where a re-engaged account may land — mirrors REENGAGE_STAGES server-side.
const MOVE_OPTIONS = [
  { value: '', label: 'Leave as churned (task only)' },
  { value: 'prospect', label: 'Move back to Prospect' },
  { value: 'onboarding', label: 'Move back to Onboarding' },
];

function DaysSinceCell({ days }) {
  if (days == null) return <span className="text-gray-400 text-xs">—</span>;
  // Recent churn is the hottest win-back window — flag the fresh ones.
  const fresh = days <= 30;
  const label = days <= 0 ? 'today' : days === 1 ? '1 day' : `${days} days`;
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-gray-600">
      <span className={fresh ? 'text-warning-700 font-semibold' : ''}>{label}</span>
      {fresh && <StatusBadge tone="warning" label="Fresh" />}
    </span>
  );
}

function ReasonBadge({ reason }) {
  if (!reason) return <span className="text-gray-400 text-xs">Not captured</span>;
  return <StatusBadge tone="neutral" label={REASON_LABELS[reason] || reason} />;
}

// Confirm dialog for the win-back write: shows what will happen (a task is
// created) and lets the user pick the optional lifecycle move.
function ConfirmWinback({ company, busy, onConfirm, onCancel }) {
  const [moveToStage, setMoveToStage] = useState('');
  return (
    <Modal
      open
      onClose={busy ? undefined : onCancel}
      size="sm"
      title={`Start win-back for ${company.name}?`}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button onClick={() => onConfirm(moveToStage || null)} loading={busy} loadingLabel="Starting…">
            Start win-back
          </Button>
        </>
      }
    >
      <p className="text-sm text-gray-500">
        This creates a high-priority <span className="font-medium text-gray-700">"Win-back outreach"</span> task
        due in 3 days{company.churned_reason ? <> (churn reason: {REASON_LABELS[company.churned_reason] || company.churned_reason})</> : null}.
      </p>
      <Select
        label="Lifecycle stage"
        wrapperClassName="mt-4"
        value={moveToStage}
        onChange={(e) => setMoveToStage(e.target.value)}
        options={MOVE_OPTIONS}
      />
    </Modal>
  );
}

function WinbackBoard({ refreshKey }) {
  const navigate = useNavigate();
  const [companies, setCompanies] = useState([]);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [search, setSearch] = useState('');
  const [confirming, setConfirming] = useState(null); // company awaiting confirm
  const [busy, setBusy] = useState(false);

  const load = () => {
    setLoading(true);
    Promise.all([winbackApi.list(), winbackApi.summary().catch(() => null)])
      .then(([list, sum]) => {
        setCompanies(Array.isArray(list.companies) ? list.companies : []);
        setSummary(sum?.summary || null);
        setError('');
      })
      .catch((err) => setError(err.response?.data?.error || 'Failed to load churned accounts'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [refreshKey]);

  const onConfirmWinback = async (moveToStage) => {
    if (!confirming) return;
    setBusy(true);
    try {
      const out = await winbackApi.reengage(confirming.id, moveToStage ? { moveToStage } : {});
      setNotice(
        moveToStage
          ? `Win-back started for ${confirming.name} — outreach task created, account moved to ${moveToStage}.`
          : `Win-back started for ${confirming.name} — outreach task created.`
      );
      setError('');
      setConfirming(null);
      // A moved account leaves the churned list; reload keeps board + summary honest.
      load();
      return out;
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to start win-back');
      setConfirming(null);
    } finally {
      setBusy(false);
    }
  };

  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    if (!s) return companies;
    return companies.filter((c) => (c.name || '').toLowerCase().includes(s));
  }, [companies, search]);

  const columns = [
    {
      key: 'name',
      label: 'Account',
      render: (c) => (
        <>
          <button
            type="button"
            onClick={() => navigate(`/accounts/${c.id}`)}
            className="text-brand-blue hover:underline font-medium text-left"
          >
            {c.name}
          </button>
          {c.industry && <div className="text-xs text-gray-400">{c.industry}</div>}
        </>
      ),
    },
    { key: 'churned_at', label: 'Churned', render: (c) => fmtDateShort(c.churned_at) || <span className="text-gray-400">Unknown</span> },
    { key: 'days_since_churn', label: 'Days since churn', render: (c) => <DaysSinceCell days={c.days_since_churn} /> },
    { key: 'churned_reason', label: 'Reason', render: (c) => <ReasonBadge reason={c.churned_reason} /> },
  ];

  const emptyState = companies.length === 0
    ? {
        icon: 'check-circle',
        title: 'No churned accounts — nice work',
        message: 'When an account is marked churned it lands here with the when and why, ready for a win-back motion. Right now the board is empty — keep it that way.',
        action: <Button size="sm" onClick={() => navigate('/accounts')}>Go to Accounts</Button>,
      }
    : {
        icon: 'search',
        title: 'No churned accounts match your search',
        message: 'Try clearing the search box.',
      };

  return (
    <>
      {error && <Alert tone="danger" onDismiss={() => setError('')}>{error}</Alert>}
      {notice && <Alert tone="success" onDismiss={() => setNotice('')}>{notice}</Alert>}

      {/* Stats strip */}
      {summary && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <Stat label="Churned accounts" value={summary.churned_total} sub="On the win-back board" />
          <Stat label="Churned in 90d" value={summary.churned_90d} sub="Freshest re-engagement window" tone="amber" />
        </div>
      )}

      <Card padding="sm">
        <Input
          leadingIcon="search"
          placeholder="Search churned accounts..."
          aria-label="Search churned accounts"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </Card>

      <DataTable
        columns={columns}
        data={filtered}
        loading={loading}
        rowActions={[{ label: 'Start win-back', onClick: (c) => setConfirming(c) }]}
        emptyState={emptyState}
      />

      {confirming && (
        <ConfirmWinback
          company={confirming}
          busy={busy}
          onConfirm={onConfirmWinback}
          onCancel={() => setConfirming(null)}
        />
      )}
    </>
  );
}

// =============================================================================
// Page shell
// =============================================================================
export default function Retention({ initialTab } = {}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const fromQuery = searchParams.get('tab');
  const startTab = TAB_ITEMS.some((t) => t.id === initialTab) ? initialTab
    : TAB_ITEMS.some((t) => t.id === fromQuery) ? fromQuery
    : 'overview';
  const [tab, setTab] = useState(startTab);
  const [refreshKey, setRefreshKey] = useState(0);

  const onTabChange = (id) => {
    setTab(id);
    // Keep the URL shareable on /retention; the /winback route sets the
    // tab via props and doesn't need the query param.
    if (!initialTab) {
      const next = new URLSearchParams(searchParams);
      if (id === 'overview') next.delete('tab'); else next.set('tab', id);
      setSearchParams(next, { replace: true });
    }
  };

  const isWinback = tab === 'winback';

  return (
    <div className="min-h-screen bg-gray-50">
      <Nav active={isWinback ? 'winback' : 'retention'} />
      <Container>
        <PageHeader
          title="Retention & expansion"
          subtitle={isWinback
            ? 'Churned accounts, newest first — with why they left and one click to restart the relationship.'
            : 'Recurring revenue, renewals, net revenue retention, and churn — the whole customer relationship, not just new business.'}
          secondaryActions={[{ label: 'Refresh', icon: 'refresh', inline: true, onClick: () => setRefreshKey((k) => k + 1) }]}
        />

        <div className="space-y-6">
          <Tabs items={TAB_ITEMS} value={tab} onChange={onTabChange} aria-label="Retention views" />
          {isWinback ? <WinbackBoard refreshKey={refreshKey} /> : <RetentionOverview refreshKey={refreshKey} />}
        </div>
      </Container>
    </div>
  );
}
