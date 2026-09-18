// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Usage dashboard — current-month consumption + costs + quotas + projection.
// Calls GET /api/usage which returns the org's tier, seats, effective
// limits, current usage, and a straight-line end-of-month projection.

import React, { useEffect, useState } from 'react';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid,
} from 'recharts';
import api, { orgAiKey } from '../api';
import Nav from '../components/Nav';
import DataTable from '../components/DataTable';
import { useAuth } from '../AuthContext';
import { Alert, Button, Card, Container, Icon, Input, PageHeader, Skeleton, StatusBadge } from '../components/ui';

function fmtCount(n) {
  if (n == null) return '—';
  return Number(n).toLocaleString();
}

function fmtCost(cents) {
  if (cents == null) return '—';
  const dollars = cents / 100;
  if (dollars === 0) return '$0';
  if (dollars < 0.01) return '< $0.01';
  return `$${dollars.toFixed(dollars < 10 ? 2 : 0)}`;
}

// Format a USD number directly (the ai_usage block returns dollars, not cents).
function fmtUsd(usd) {
  if (usd == null) return '—';
  const n = Number(usd);
  if (n === 0) return '$0.00';
  if (n < 0.01) return '< $0.01';
  if (n < 10)   return `$${n.toFixed(2)}`;
  if (n < 1000) return `$${n.toFixed(2)}`;
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function ProgressBar({ used, limit }) {
  if (limit == null) return null; // unlimited tier
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const tone = pct >= 100 ? 'bg-danger-500' : pct >= 80 ? 'bg-warning-500' : 'bg-success-500';
  return (
    <div className="mt-1">
      <div className="h-2 bg-gray-200 rounded overflow-hidden">
        <div className={`h-2 ${tone} transition-all`} style={{ width: `${pct}%` }} />
      </div>
      <div className="flex justify-between text-[11px] text-gray-500 mt-0.5">
        <span>{fmtCount(used)} of {fmtCount(limit)}</span>
        <span>{pct}%</span>
      </div>
    </div>
  );
}

const TIER_TONE = { free: 'neutral', starter: 'info', pro: 'warning', enterprise: 'accent' };

function TierBadge({ tier, label }) {
  return <StatusBadge tone={TIER_TONE[tier] || 'neutral'} label={<span className="uppercase">{label || tier}</span>} />;
}

function MetricRow({ name, count, costCents, lastAt, description, limit, projectedCount, projectedCostCents, projectionTooEarly }) {
  const showProgress = limit != null;
  const isOverQuota = limit != null && count >= limit;
  const projectedOver = limit != null && projectedCount > limit;
  return (
    <div className="py-3 border-b border-gray-100 last:border-0">
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="font-mono text-sm text-gray-900">{name}</div>
          {description && <div className="text-xs text-gray-500 mt-0.5">{description}</div>}
        </div>
        <div className="text-right flex-shrink-0">
          <div className="text-lg font-semibold text-gray-900">{fmtCount(count)}</div>
          <div className="text-xs text-gray-500">{fmtCost(costCents)} cost</div>
        </div>
      </div>
      {showProgress && <ProgressBar used={count} limit={limit} />}
      {(projectedCount > 0 || projectedCostCents > 0) && !projectionTooEarly && (
        <div className="mt-1 text-[11px] text-gray-500 flex items-center gap-2">
          <span className="inline-flex items-center gap-1"><Icon name="trending-up" size={12} className="text-gray-400" />Month-end projection:</span>
          <span className="font-semibold text-gray-700">{fmtCount(projectedCount)}</span>
          <span className="text-gray-400">·</span>
          <span className="font-semibold text-gray-700">{fmtCost(projectedCostCents)}</span>
          {projectedOver && <StatusBadge tone="warning" label="projected over limit" className="ml-1" />}
        </div>
      )}
      {isOverQuota && (
        <Alert tone="danger" className="mt-2 !py-2 !text-xs">
          Quota exceeded — upgrade to continue receiving AI features (or wait for next billing period).
        </Alert>
      )}
      {lastAt && (
        <div className="text-[11px] text-gray-400 mt-1">last activity: {new Date(lastAt).toLocaleString()}</div>
      )}
    </div>
  );
}

function UpgradeCta({ pct, tier, overageAllowed }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const targetTier = tier === 'free' ? 'starter' : 'pro';
  const targetLabel = targetTier === 'pro' ? 'Professional' : 'Starter';

  const upgrade = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await api.post('/billing/checkout', { tier: targetTier });
      if (r.data?.url) {
        window.location.href = r.data.url;
        return;
      }
      throw new Error('No checkout URL returned');
    } catch (err) {
      const code = err.response?.data?.code;
      if (code === 'STRIPE_NOT_CONFIGURED') {
        setError("Billing isn't fully wired on this deployment yet. Contact johncolesassistant@gmail.com to upgrade — we'll process it manually.");
      } else {
        setError(err.response?.data?.error || err.message || 'Failed to start checkout');
      }
      setBusy(false);
    }
  };

  return (
    <Alert
      tone="warning"
      icon="flame"
      title={`You're at ${pct}% of your AI quota this month`}
      action={
        <Button size="sm" onClick={upgrade} loading={busy} loadingLabel="Starting checkout…">
          Upgrade to {targetLabel}
        </Button>
      }
    >
      {overageAllowed
        ? `Overage rate kicks in at 100%. Upgrade to ${targetLabel} for a higher bundled limit.`
        : `At 100%, AI features will pause until next month. Upgrade to keep going.`}
      {error && <div className="mt-2 text-xs font-medium">{error}</div>}
    </Alert>
  );
}

function ManagePlanLink() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const open = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await api.post('/billing/portal');
      if (r.data?.url) {
        window.location.href = r.data.url;
        return;
      }
    } catch (err) {
      const code = err.response?.data?.code;
      if (code === 'STRIPE_NOT_CONFIGURED' || code === 'NO_STRIPE_CUSTOMER') {
        setError(err.response.data.error);
      } else {
        setError(err.response?.data?.error || err.message || 'Failed to open portal');
      }
      setBusy(false);
    }
  };

  return (
    <Card padding="sm">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="text-sm text-gray-700">Manage your subscription, payment method, and invoices.</div>
        <Button variant="secondary" size="sm" onClick={open} loading={busy} loadingLabel="Opening…" iconRight="external">
          Manage plan
        </Button>
      </div>
      {error && <div className="w-full text-xs text-warning-700 mt-2">{error}</div>}
    </Card>
  );
}

// =============================================================================
// Claude AI token usage — per-call ledger surfaced from ai_usage_events.
//
// Renders four headline cards (tokens in/out, raw cost, charged cost,
// projected month-end), a per-day BarChart of charged USD, a per-endpoint
// breakdown table, and a per-user breakdown for org admins. Hidden when
// no AI activity has been recorded yet so the section doesn't show as an
// empty shell.
// =============================================================================
function HeadlineCard({ label, value, sub, tone = 'gray' }) {
  const toneClass = {
    gray:    'border-gray-200 bg-white',
    emerald: 'border-success-200 bg-success-50',
    amber:   'border-warning-200 bg-warning-50',
    blue:    'border-info-200 bg-info-50',
  }[tone] || 'border-gray-200 bg-white';
  return (
    <div className={`border ${toneClass} rounded shadow-card p-3 flex-1 min-w-[140px]`}>
      <div className="text-[11px] uppercase font-semibold text-gray-500 tracking-wider">{label}</div>
      <div className="text-xl font-semibold tracking-tight text-gray-900 mt-1">{value}</div>
      {sub && <div className="text-[11px] text-gray-500 mt-0.5">{sub}</div>}
    </div>
  );
}

const ENDPOINT_COLUMNS = [
  { key: 'endpoint', label: 'Endpoint', render: (r) => <span className="font-mono">{r.endpoint}</span> },
  { key: 'calls', label: 'Calls', align: 'right', render: (r) => r.calls.toLocaleString() },
  { key: 'input_tokens', label: 'Input tok', align: 'right', render: (r) => r.input_tokens.toLocaleString() },
  { key: 'output_tokens', label: 'Output tok', align: 'right', render: (r) => r.output_tokens.toLocaleString() },
  { key: 'cost_usd', label: 'Raw cost', align: 'right', render: (r) => fmtUsd(r.cost_usd) },
  {
    key: 'charged_usd', label: 'Charged', align: 'right',
    render: (r) => (
      r.byo_key_calls > 0 && r.byo_key_calls === r.calls ? (
        <span className="text-gray-500 italic" title="Made with your org's own Anthropic key; Anthropic bills you directly.">
          Your key — not billed by us
        </span>
      ) : (
        <span className="font-semibold text-success-700">{fmtUsd(r.charged_usd)}</span>
      )
    ),
  },
];

const USER_COLUMNS = [
  {
    key: 'user_email', label: 'User',
    render: (r) => r.user_email || <span className="italic text-gray-500">(deleted user #{r.user_id ?? '?'})</span>,
  },
  { key: 'calls', label: 'Calls', align: 'right', render: (r) => r.calls.toLocaleString() },
  { key: 'tokens', label: 'Tokens (in/out)', align: 'right', render: (r) => `${r.input_tokens.toLocaleString()} / ${r.output_tokens.toLocaleString()}` },
  { key: 'charged_usd', label: 'Charged', align: 'right', render: (r) => <span className="font-semibold text-success-700">{fmtUsd(r.charged_usd)}</span> },
];

function AiUsageSection({ aiUsage, isAdmin, aiEnabled }) {
  if (!aiUsage) return null;
  const hasActivity = (aiUsage.total_calls || 0) > 0;
  // The upcharge multiplier comes from the backend (CLAUDE_UPCHARGE_MULTIPLIER,
  // default 2×) so this copy can't drift from what the ledger actually charges.
  const multiplier = aiUsage.upcharge_multiplier || 2.0;
  // Calls made under the org's own Anthropic key (migration 153). When every
  // call in the period was on the org's key there is nothing to charge.
  const byoCalls = aiUsage.byo_key_calls || 0;
  const usingOwnKey = hasActivity && byoCalls === (aiUsage.total_calls || 0);
  // aiEnabled === false means the backend reports ANTHROPIC_API_KEY isn't
  // set. We surface that as the empty-state caption so the operator sees
  // a concrete "configure this" hint instead of staring at a "0 calls" panel.
  const aiUnavailable = aiEnabled === false;

  return (
    <Card
      title="Claude AI token usage"
      subtitle={
        <>
          Per-call ledger of Anthropic SDK calls.{' '}
          {usingOwnKey
            ? 'Your org uses its own Anthropic key — these calls are not billed by us.'
            : `Pay-as-you-go: Anthropic's token price × ${multiplier} — a typical chat turn is a few cents.`}
        </>
      }
      actions={
        <span className="text-[11px] text-gray-500 whitespace-nowrap">
          {aiUsage.total_calls?.toLocaleString() || 0} Claude calls in this period
        </span>
      }
    >
      {!hasActivity ? (
        aiUnavailable ? (
          <Alert tone="warning" title="No AI usage yet — Claude isn't configured on this deployment.">
            <span className="text-xs">
              Once an operator sets <code className="bg-warning-100 px-1 py-0.5 rounded font-mono">ANTHROPIC_API_KEY</code> on the backend,
              calls will appear here within minutes.
            </span>
          </Alert>
        ) : (
          <div className="text-sm text-gray-500 italic py-4">
            No AI usage yet — once activated, calls will appear here within minutes.
            Use the copilot at <code>/chat</code> or click an AI button on a deal to generate activity.
          </div>
        )
      ) : (
        <>
          {/* Headline cards */}
          <div className="flex flex-wrap gap-3 mb-4">
            <HeadlineCard
              label="Total tokens"
              value={`${(aiUsage.total_input_tokens || 0).toLocaleString()} in / ${(aiUsage.total_output_tokens || 0).toLocaleString()} out`}
              sub={aiUsage.total_cache_read_tokens > 0 ? `${aiUsage.total_cache_read_tokens.toLocaleString()} cache-read` : null}
              tone="blue"
            />
            <HeadlineCard
              label="Raw cost (Anthropic)"
              value={fmtUsd(aiUsage.total_cost_usd)}
              sub="What we pay Anthropic"
              tone="gray"
            />
            <HeadlineCard
              label={usingOwnKey ? 'Charged by us' : `Charged cost (${multiplier}× upcharge)`}
              value={fmtUsd(aiUsage.total_charged_usd)}
              sub={
                usingOwnKey
                  ? 'Your key — not billed by us'
                  : byoCalls > 0
                  ? `${byoCalls.toLocaleString()} of ${(aiUsage.total_calls || 0).toLocaleString()} calls on your own key ($0)`
                  : 'Your share + margin'
              }
              tone="emerald"
            />
            <HeadlineCard
              label="Projected month-end"
              value={
                aiUsage.projection_too_early
                  ? '—'
                  : aiUsage.projected_charged_usd != null
                  ? fmtUsd(aiUsage.projected_charged_usd)
                  : '—'
              }
              sub={
                aiUsage.projection_too_early
                  ? 'after 24h of activity'
                  : aiUsage.projected_charged_usd != null
                  ? 'straight-line forecast'
                  : 'current month only'
              }
              tone="amber"
            />
          </div>

          {/* Per-day bar chart */}
          {aiUsage.by_day && aiUsage.by_day.length > 0 && (
            <div className="mb-4">
              <div className="text-xs uppercase font-semibold text-gray-500 tracking-wider mb-2">Charged cost per day</div>
              <ResponsiveContainer width="100%" height={180}>
                <BarChart data={aiUsage.by_day} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                  <XAxis dataKey="day" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} tickFormatter={v => `$${Number(v).toFixed(2)}`} />
                  <Tooltip
                    formatter={(v, n) => [fmtUsd(v), n === 'charged_usd' ? 'Charged' : n]}
                    labelStyle={{ fontSize: 12 }}
                    contentStyle={{ fontSize: 12 }}
                  />
                  <Bar dataKey="charged_usd" fill="#10b981" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Per-endpoint breakdown */}
          {aiUsage.by_endpoint && aiUsage.by_endpoint.length > 0 && (
            <div className="mb-4">
              <div className="text-xs uppercase font-semibold text-gray-500 tracking-wider mb-2">By endpoint</div>
              <DataTable columns={ENDPOINT_COLUMNS} data={aiUsage.by_endpoint} rowKey="endpoint" density="compact" stickyHeader={false} />
            </div>
          )}

          {/* Per-user breakdown — only for admins */}
          {isAdmin && aiUsage.by_user && aiUsage.by_user.length > 0 && (
            <div className="mb-2">
              <div className="text-xs uppercase font-semibold text-gray-500 tracking-wider mb-2">By user (admin view)</div>
              <DataTable
                columns={USER_COLUMNS}
                data={aiUsage.by_user}
                rowKey={(r) => `${r.user_id ?? 'null'}-${r.user_email ?? ''}`}
                density="compact"
                stickyHeader={false}
              />
            </div>
          )}

          <p className="text-[11px] text-gray-500 mt-3 leading-relaxed">
            {usingOwnKey ? (
              <>Raw cost is shown for visibility only — Anthropic bills your organization directly for these calls at their list rates.</>
            ) : (
              <>
                <strong>Pay-as-you-go:</strong> Anthropic's token price × {multiplier}. The multiplier covers pass-through pricing plus our margin;
                a typical chat turn is a few cents. Prefer to pay Anthropic directly? Add your own key below and the multiplier goes away.
              </>
            )}
          </p>
        </>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Bring-your-own Anthropic key (migration 153).
//
// Owners/admins paste a key; the backend probes Anthropic once, encrypts it,
// and from then on every AI call for the org goes out under that key at
// Anthropic's rates with no platform upcharge. Members only see a one-line
// note. The key itself is never returned by the API — only its last 4.
// ---------------------------------------------------------------------------
export function ByoKeyCard({ isAdmin }) {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      setStatus(await orgAiKey.get());
      setError('');
    } catch (err) {
      // 400 ORG_REQUIRED (personal workspace) or any other failure: hide the card
      // rather than shout — there's nothing the user can do from here.
      setStatus(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const save = async (e) => {
    e.preventDefault();
    if (!key.trim()) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const next = await orgAiKey.set(key.trim());
      setStatus(next);
      setKey('');
      setNotice(next.last_validated_at
        ? 'Saved and validated with Anthropic. AI calls now use your key.'
        : 'Saved. We could not confirm it with Anthropic just now — see the note below.');
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Could not save the key');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!window.confirm('Remove your Anthropic key? AI calls will go back to pay-as-you-go on our key.')) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const next = await orgAiKey.clear();
      setStatus(next);
      setNotice('Key removed. AI calls are back on pay-as-you-go.');
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Could not remove the key');
    } finally {
      setBusy(false);
    }
  };

  if (loading) return null;
  if (!status) return null;

  const configured = !!status.configured;

  if (!isAdmin) {
    return (
      <Card padding="sm" className="text-xs text-gray-600">
        {configured
          ? <>This organization uses <strong>its own Anthropic key</strong> (…{status.last4}) — AI usage is billed by Anthropic directly, not by us. An org owner or admin manages it here.</>
          : <>AI is billed <strong>pay-as-you-go</strong> on this organization. An org owner or admin can switch to your own Anthropic key here.</>}
      </Card>
    );
  }

  return (
    <Card
      title="Use your own Anthropic key"
      subtitle="Paste a key from your Anthropic account and every AI call in this workspace runs on it. Anthropic bills you directly at their rates — no platform markup from us. Your CRM data goes to Anthropic exactly as it does today; the only thing that changes is who pays for the tokens. You can remove the key any time and go back to pay-as-you-go."
      actions={configured ? <StatusBadge tone="success" label="Active" /> : null}
      data-testid="byo-key-card"
    >
      {configured && (
        <div className="flex items-center justify-between flex-wrap gap-2 bg-gray-50 border border-gray-200 rounded-md px-3 py-2 mb-3 text-xs">
          <div className="text-gray-700">
            Key ending in <code className="font-mono bg-white border border-gray-200 px-1 rounded">…{status.last4}</code>
            {status.last_validated_at ? (
              <span className="ml-2 text-success-700">validated {'✓'}</span>
            ) : status.last_error ? (
              <span className="ml-2 text-warning-700" title={status.last_error}>not yet validated — {status.last_error}</span>
            ) : null}
          </div>
          <button
            type="button"
            onClick={remove}
            disabled={busy}
            className="text-danger-600 hover:text-danger-700 font-medium disabled:opacity-50"
          >
            Remove
          </button>
        </div>
      )}

      <form onSubmit={save} className="flex flex-wrap items-center gap-2">
        <Input
          type="password"
          size="sm"
          autoComplete="off"
          spellCheck={false}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder={configured ? 'Paste a new key to rotate (sk-ant-…)' : 'sk-ant-…'}
          aria-label="Anthropic API key"
          className="font-mono"
          wrapperClassName="flex-1 min-w-[16rem]"
        />
        <Button type="submit" size="sm" disabled={!key.trim()} loading={busy} loadingLabel="Checking…">
          {configured ? 'Replace key' : 'Save key'}
        </Button>
      </form>

      {error && <div className="mt-2 text-xs text-danger-600" role="alert">{error}</div>}
      {notice && !error && <div className="mt-2 text-xs text-success-700" role="status">{notice}</div>}

      <p className="mt-3 text-[11px] text-gray-500">
        We store the key encrypted and never show it again — only the last 4 characters. Get a key at console.anthropic.com.
      </p>
    </Card>
  );
}

export default function Usage() {
  const { user, aiEnabled } = useAuth();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [period, setPeriod] = useState('');

  const load = async (p = '') => {
    setLoading(true);
    setError('');
    try {
      const r = await api.get(p ? `/usage?period=${p}` : '/usage');
      setData(r.data);
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to load usage');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(period); /* eslint-disable-next-line */ }, [period]);

  const metrics = data?.metrics || {};
  const catalog = data?.metrics_catalog || {};
  const projection = data?.projection?.projection || {};
  const projectionTooEarly = data?.projection?.tooEarly;
  const orderedMetrics = ['ai_requests', 'ai_input_tokens', 'ai_output_tokens', 'plugin_runs', 'plugin_run_ms', 'emails_sent', 'documents_uploaded_bytes'];

  const totalCostCents = Object.values(metrics).reduce((s, m) => s + (m.estimatedCostCents || 0), 0);
  const totalProjectedCents = Object.values(projection).reduce((s, m) => s + (m.projectedCostCents || 0), 0);

  // Per-metric limit lookup. Only ai_requests and plugin_runs have explicit
  // per-org limits today; other metrics are "informational" and show no bar.
  const limitFor = (metric) => {
    if (metric === 'ai_requests') return data?.effectiveLimits?.ai_requests;
    if (metric === 'plugin_runs') return data?.effectiveLimits?.plugin_runs;
    return null;
  };

  // Are we approaching the AI quota? Used to surface an upgrade CTA at top.
  const aiUsed = metrics.ai_requests?.count || 0;
  const aiLimit = data?.effectiveLimits?.ai_requests;
  const aiPct = aiLimit ? Math.round((aiUsed / aiLimit) * 100) : 0;
  const showUpgradeCta = aiLimit != null && aiPct >= 80 && data?.tier !== 'enterprise';

  return (
    <div className="min-h-screen bg-gray-50">
      <Nav active="usage" />
      <Container>
        <PageHeader
          title="Usage"
          subtitle="Current consumption + platform-side cost estimates for this organization."
          actions={
            <Input
              size="sm"
              leadingIcon="calendar"
              type="text"
              aria-label="Billing period"
              placeholder={data?.period || 'YYYY-MM'}
              value={period}
              onChange={e => setPeriod(e.target.value)}
              wrapperClassName="w-40"
            />
          }
        />

        <div className="space-y-6">
          {loading ? (
            <Card role="status" aria-label="Loading usage"><Skeleton lines={6} /></Card>
          ) : error ? (
            <Alert tone="danger" onDismiss={() => setError('')}>{error}</Alert>
          ) : (
            <>
              {/* Tier + period + cost header */}
              <Card>
                <div className="flex items-start justify-between gap-4 flex-wrap">
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xs uppercase font-semibold text-gray-500 tracking-wider">Plan</span>
                      <TierBadge tier={data?.tier} label={data?.tierLabel} />
                      <span className="text-xs text-gray-500">{data?.seats || 1} {data?.seats === 1 ? 'seat' : 'seats'}</span>
                    </div>
                    <div className="text-xs text-gray-500">Period: <span className="font-semibold text-gray-900">{data?.period}</span></div>
                  </div>
                  <div className="text-right">
                    <div className="text-xs uppercase font-semibold text-gray-500 tracking-wider">Cost so far</div>
                    <div className="text-2xl font-semibold tracking-tight text-gray-900 mt-1">{fmtCost(totalCostCents)}</div>
                    {!projectionTooEarly && totalProjectedCents > 0 && (
                      <div className="text-xs text-gray-500 mt-0.5">
                        projected end-of-month: <span className="font-semibold text-gray-900">{fmtCost(totalProjectedCents)}</span>
                      </div>
                    )}
                  </div>
                </div>
                <p className="text-xs text-gray-500 mt-3">
                  Costs above are <em>platform-side</em> (what we pay for compute + AI inference + storage on your org's behalf).
                  Your subscription invoice may differ based on your tier's bundled allowance + overage rates.
                </p>
              </Card>

              {/* Upgrade CTA — only when actually relevant */}
              {showUpgradeCta && (
                <UpgradeCta pct={aiPct} tier={data?.tier} overageAllowed={data?.overageAllowed} />
              )}
              {data?.tier !== 'free' && data?.tier !== 'enterprise' && (
                <ManagePlanLink />
              )}

              {/* Metrics list */}
              <Card title="Metrics this period" bodyClassName="!pt-1">
                {orderedMetrics.map(m => (
                  <MetricRow
                    key={m}
                    name={m}
                    count={metrics[m]?.count || 0}
                    costCents={metrics[m]?.estimatedCostCents || 0}
                    lastAt={metrics[m]?.lastAt}
                    description={catalog[m]?.description}
                    limit={limitFor(m)}
                    projectedCount={projection[m]?.projectedCount || 0}
                    projectedCostCents={projection[m]?.projectedCostCents || 0}
                    projectionTooEarly={projectionTooEarly}
                  />
                ))}
              </Card>

              {/* Claude AI per-call ledger — new in migration 080. */}
              <AiUsageSection
                aiUsage={data?.ai_usage}
                isAdmin={user?.org_role === 'owner' || user?.org_role === 'admin'}
                aiEnabled={aiEnabled}
              />

              {/* Bring-your-own Anthropic key (migration 153). */}
              <ByoKeyCard isAdmin={user?.org_role === 'owner' || user?.org_role === 'admin'} />

              {projectionTooEarly && (
                <p className="text-xs text-gray-500 italic">
                  End-of-month projections appear after 24 hours of activity in the current period.
                </p>
              )}

              <p className="text-xs text-gray-500">
                Signed in as <code>{user?.email}</code>. Counters update on every AI call + plugin invocation with a ≤30s cache.
                {data?.overageAllowed && data?.overageRates && (
                  <span> Overage rates on your plan: ${(data.overageRates.ai_request_cents/100).toFixed(2)} per AI request · ${(data.overageRates.plugin_run_cents/100).toFixed(3)} per plugin run.</span>
                )}
              </p>
            </>
          )}
        </div>
      </Container>
    </div>
  );
}
