// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { accounts as accountsApi, pulse as pulseApi, LIFECYCLE_STAGES } from '../api';
import Nav from '../components/Nav';
import DataTable from '../components/DataTable';
import {
  Alert, Button, Card, Container, Icon, Input, Modal, PageHeader, Select, StatusBadge, Textarea,
} from '../components/ui';

// The Accounts home — the relationship-management command center.
//
// A list of the org's accounts (companies with type='customer') that turns the
// CRM from an acquisition pipeline into a full-lifecycle relationship tool. Each
// row shows the account's lifecycle stage (editable inline), health band (latest
// rules-based snapshot), days since last touch (flagged "gone quiet" past ~30d),
// and next renewal. A top strip surfaces two at-a-glance cadence rollups — gone
// quiet and renewing soon — so nothing slips.
//
// Data comes from a single call to GET /api/accounts (see
// backend/routes/accountRoutes.js), which does the health-band / last-touch /
// next-renewal joins in one N+1-free query. Clicking an account opens the
// existing Account 360.

const LIFECYCLE_META = {
  prospect:   { label: 'Prospect',   cls: 'bg-gray-100 text-gray-700'        },
  onboarding: { label: 'Onboarding', cls: 'bg-info-100 text-info-700'        },
  active:     { label: 'Active',     cls: 'bg-success-100 text-success-700'  },
  at_risk:    { label: 'At risk',    cls: 'bg-danger-100 text-danger-700'    },
  renewed:    { label: 'Renewed',    cls: 'bg-success-100 text-success-800'  },
  churned:    { label: 'Churned',    cls: 'bg-gray-200 text-gray-600'        },
};

// Health + relationship-pulse bands share one visual language. The backend
// derives pulse bands from the stored 0–10 score: 9–10 promoter/green,
// 7–8 passive/amber, 0–6 detractor/red.
const BAND_TONE = { green: 'success', yellow: 'warning', amber: 'warning', red: 'error' };

function fmtDateShort(ts) {
  if (!ts) return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString();
}

function HealthCell({ band, score }) {
  if (!band) return <span className="text-gray-400 text-xs">— no data</span>;
  return (
    <StatusBadge
      tone={BAND_TONE[band] || 'neutral'}
      label={<><span className="capitalize">{band}</span>{score != null && <span className="opacity-70">{score}</span>}</>}
    />
  );
}

// Latest pulse (NPS/CSAT) pill + the inline "Pulse" recorder trigger.
function PulseCell({ score, band, recordedAt, onRecord }) {
  return (
    <span className="inline-flex items-center gap-2">
      {score == null ? (
        <span className="text-gray-400 text-xs">—</span>
      ) : (
        <StatusBadge
          tone={BAND_TONE[band] || 'neutral'}
          label={score}
          title={recordedAt ? `Recorded ${fmtDateShort(recordedAt)}` : undefined}
        />
      )}
      <button
        type="button"
        onClick={onRecord}
        className="inline-flex items-center gap-0.5 text-xs text-brand-blue hover:underline whitespace-nowrap"
        title="Record a satisfaction pulse"
      >
        <Icon name="plus" size={12} /> Pulse
      </button>
    </span>
  );
}

// Lightweight modal to record a 0–10 pulse + optional comment for one account.
function PulseModal({ account, onClose, onSaved }) {
  const [score, setScore] = useState(null);
  const [comment, setComment] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const save = async () => {
    if (score == null) { setError('Pick a score first.'); return; }
    setSaving(true);
    setError('');
    try {
      const created = await pulseApi.record({ company_id: account.id, score, comment: comment.trim() || undefined });
      onSaved(account.id, created);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to record pulse');
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Record a pulse"
      description={<>How likely is <span className="font-medium text-gray-700">{account.name}</span> to recommend you? (0 = not at all, 10 = extremely)</>}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={save} disabled={score == null} loading={saving} loadingLabel="Saving…">Save pulse</Button>
        </>
      }
    >
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Pulse score">
        {Array.from({ length: 11 }, (_, n) => (
          <button
            key={n}
            type="button"
            onClick={() => setScore(n)}
            aria-pressed={score === n}
            className={`w-9 h-9 rounded-md text-sm font-semibold border transition ${
              score === n
                ? n >= 9 ? 'bg-success-600 border-success-600 text-white'
                  : n >= 7 ? 'bg-warning-500 border-warning-500 text-white'
                  : 'bg-danger-600 border-danger-600 text-white'
                : 'bg-white border-gray-300 text-gray-700 hover:border-gray-400'
            }`}
          >
            {n}
          </button>
        ))}
      </div>
      <div className="flex justify-between text-[11px] text-gray-400 mt-1 px-0.5">
        <span>Detractor (0–6)</span><span>Passive (7–8)</span><span>Promoter (9–10)</span>
      </div>

      <Textarea
        label="Comment"
        wrapperClassName="mt-4"
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        placeholder="Optional — what did they say?"
        rows={3}
      />

      {error && <Alert tone="danger" className="mt-3">{error}</Alert>}
    </Modal>
  );
}

function TouchCell({ days, goneQuiet }) {
  if (days == null) {
    return <span className="text-xs text-danger-600 font-medium">No touch yet</span>;
  }
  const label = days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
  return (
    <span className={`text-xs ${goneQuiet ? 'text-danger-600 font-semibold' : 'text-gray-600'}`}>
      {label}
      {goneQuiet && <span className="ml-1 text-[10px] uppercase tracking-wide">· quiet</span>}
    </span>
  );
}

function RenewalCell({ date, days }) {
  const d = fmtDateShort(date);
  if (!d) return <span className="text-gray-400 text-xs">—</span>;
  const soon = days != null && days <= 30;
  return (
    <span className={`text-xs ${soon ? 'text-warning-700 font-semibold' : 'text-gray-600'}`}>
      {d}
      {days != null && <span className="text-gray-400"> · {days}d</span>}
    </span>
  );
}

// Small metric card for the cadence strip. Shows the tightest (30d) bucket big,
// with the 60/90 buckets as context underneath.
function CadenceCard({ label, tone, buckets, hint }) {
  const toneCls = tone === 'red'
    ? 'border-danger-200 bg-danger-50/50'
    : 'border-warning-200 bg-warning-50/50';
  const numCls = tone === 'red' ? 'text-danger-700' : 'text-warning-700';
  return (
    <div className={`rounded border ${toneCls} px-4 py-3 flex-1 min-w-[180px]`}>
      <div className="text-xs font-medium text-gray-500">{label}</div>
      <div className="flex items-baseline gap-2 mt-1">
        <span className={`text-2xl font-semibold tracking-tight ${numCls}`}>{buckets.d30}</span>
        <span className="text-xs text-gray-500">in 30d</span>
      </div>
      <div className="text-xs text-gray-500 mt-1">
        {buckets.d60} in 60d · {buckets.d90} in 90d
      </div>
      {hint && <div className="text-[11px] text-gray-400 mt-1">{hint}</div>}
    </div>
  );
}

export default function Accounts() {
  const navigate = useNavigate();
  const [accounts, setAccounts] = useState([]);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [stageFilter, setStageFilter] = useState('');
  const [search, setSearch] = useState('');
  // Ids currently mid-save on their lifecycle stage — disables that <select>.
  const [savingIds, setSavingIds] = useState(new Set());
  // Account currently targeted by the "Pulse" recorder modal (null = closed).
  const [pulseTarget, setPulseTarget] = useState(null);

  const load = () => {
    setLoading(true);
    accountsApi.list()
      .then((d) => {
        setAccounts(Array.isArray(d.accounts) ? d.accounts : []);
        setSummary(d.summary || null);
        setError('');
      })
      .catch((err) => setError(err.response?.data?.error || 'Failed to load accounts'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const onChangeStage = async (account, next) => {
    if (next === account.lifecycle_stage) return;
    const prev = account.lifecycle_stage;
    // Optimistic update; roll back on failure.
    setAccounts((rows) => rows.map((r) => (r.id === account.id ? { ...r, lifecycle_stage: next } : r)));
    setSavingIds((s) => new Set(s).add(account.id));
    try {
      await accountsApi.setLifecycleStage(account.id, next);
    } catch (err) {
      setAccounts((rows) => rows.map((r) => (r.id === account.id ? { ...r, lifecycle_stage: prev } : r)));
      setError(err.response?.data?.error || 'Failed to update lifecycle stage');
    } finally {
      setSavingIds((s) => { const n = new Set(s); n.delete(account.id); return n; });
    }
  };

  // A pulse was recorded: refresh just that row from the created record (the
  // backend returns the stored score + derived band), then close the modal.
  const onPulseSaved = (companyId, created) => {
    setAccounts((rows) => rows.map((r) => (
      r.id === companyId
        ? { ...r, pulse_score: created.score, pulse_kind: created.kind, pulse_band: created.band, pulse_recorded_at: created.created_at }
        : r
    )));
    setPulseTarget(null);
  };

  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    return accounts.filter((a) => {
      if (stageFilter && (a.lifecycle_stage || 'active') !== stageFilter) return false;
      if (s && !(a.name || '').toLowerCase().includes(s)) return false;
      return true;
    });
  }, [accounts, stageFilter, search]);

  const columns = [
    {
      key: 'name', label: 'Account',
      render: (a) => (
        <>
          <button
            type="button"
            onClick={() => navigate(`/accounts/${a.id}`)}
            className="text-brand-blue hover:underline font-medium text-left"
          >
            {a.name}
          </button>
          {a.industry && <div className="text-xs text-gray-400 font-normal">{a.industry}</div>}
        </>
      ),
    },
    {
      key: 'lifecycle_stage', label: 'Lifecycle',
      // Inline stage editor — a pill-styled native select so the row stays
      // one line tall; the Select primitive's frame would read as a form.
      render: (a) => (
        <select
          value={a.lifecycle_stage || 'active'}
          disabled={savingIds.has(a.id)}
          onChange={(e) => onChangeStage(a, e.target.value)}
          aria-label={`Lifecycle stage for ${a.name}`}
          className={`text-xs font-medium rounded-full px-2.5 py-1 border-0 cursor-pointer focus:ring-2 focus:ring-brand-blue ${LIFECYCLE_META[a.lifecycle_stage || 'active']?.cls || 'bg-gray-100 text-gray-700'} ${savingIds.has(a.id) ? 'opacity-50' : ''}`}
        >
          {LIFECYCLE_STAGES.map((s) => (
            <option key={s} value={s}>{LIFECYCLE_META[s]?.label || s}</option>
          ))}
        </select>
      ),
    },
    { key: 'health_band', label: 'Health', render: (a) => <HealthCell band={a.health_band} score={a.health_score} /> },
    {
      key: 'pulse_score', label: 'Pulse',
      render: (a) => (
        <PulseCell score={a.pulse_score} band={a.pulse_band} recordedAt={a.pulse_recorded_at} onRecord={() => setPulseTarget(a)} />
      ),
    },
    { key: 'days_since_last_touch', label: 'Last touch', render: (a) => <TouchCell days={a.days_since_last_touch} goneQuiet={a.gone_quiet} /> },
    { key: 'next_renewal_date', label: 'Next renewal', render: (a) => <RenewalCell date={a.next_renewal_date} days={a.days_to_next_renewal} /> },
  ];

  return (
    <div className="min-h-screen bg-gray-50">
      <Nav active="accounts" />
      <Container size="wide">
        <PageHeader
          title="Accounts"
          subtitle="Every company you're building a relationship with — health, cadence, and renewals in one place."
        />

        <div className="space-y-6">
          {error && <Alert tone="danger" onDismiss={() => setError('')}>{error}</Alert>}

          {/* Cadence rollup strip */}
          {summary && (
            <div className="flex flex-wrap gap-3">
              <CadenceCard
                label="Gone quiet"
                tone="red"
                buckets={summary.gone_quiet}
                hint="No activity logged recently"
              />
              <CadenceCard
                label="Renewing soon"
                tone="amber"
                buckets={summary.renewing_soon}
                hint="Active contracts coming up"
              />
              <div className="rounded border border-gray-200 bg-white shadow-card px-4 py-3 flex-1 min-w-[140px]">
                <div className="text-xs font-medium text-gray-500">Accounts</div>
                <div className="text-2xl font-semibold tracking-tight text-gray-900 mt-1">{summary.total}</div>
                <div className="text-[11px] text-gray-400 mt-1">Customers you manage</div>
              </div>
            </div>
          )}

          {/* Filters */}
          <Card padding="sm">
            <div className="flex flex-wrap gap-2">
              <Input
                leadingIcon="search"
                placeholder="Search accounts…"
                aria-label="Search accounts"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                wrapperClassName="flex-1 min-w-[200px]"
              />
              <Select
                value={stageFilter}
                onChange={(e) => setStageFilter(e.target.value)}
                aria-label="Filter accounts by lifecycle stage"
                wrapperClassName="w-48"
              >
                <option value="">Any lifecycle stage</option>
                {LIFECYCLE_STAGES.map((s) => (
                  <option key={s} value={s}>{LIFECYCLE_META[s]?.label || s}</option>
                ))}
              </Select>
            </div>
          </Card>

          <DataTable
            columns={columns}
            data={filtered}
            loading={loading}
            emptyState={{
              icon: 'users',
              title: accounts.length === 0 ? 'Your accounts live here' : 'No accounts match your filters',
              message: accounts.length === 0
                ? "Every company you're building a relationship with shows up here — with health, last touch, and renewals at a glance. Mark a company as a customer to start managing the relationship."
                : 'Try clearing the search box or choosing a different lifecycle stage.',
              action: accounts.length === 0 ? (
                <Button variant="primary" iconRight="arrow-right" onClick={() => navigate('/companies')}>
                  Go to Companies
                </Button>
              ) : null,
            }}
          />
        </div>

        {pulseTarget && (
          <PulseModal
            account={pulseTarget}
            onClose={() => setPulseTarget(null)}
            onSaved={onPulseSaved}
          />
        )}
      </Container>
    </div>
  );
}
