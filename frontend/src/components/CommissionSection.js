// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import api from '../api';

// Commission & Goals — the "Commission" tab on /reports.
//
// Two halves:
//   1. The report — per-rep closed-won, rate, commission, goal/attainment for
//      an inclusive [from, to] window (own period picker: commission periods
//      rarely match the analytics window at the top of the page, so this tab
//      keeps its own). Partner plans (migration 159a) add a per-partner
//      statement section: closed-won deals attributed to each partner
//      (source_filter match, or a direct company link) with fee = rate × value.
//   2. The plans editor — rate (and optional goal) per rep, plus an org-wide
//      default row (rep = "Everyone"), plus partner plans (fee to a company,
//      with an optional lead-source/channel filter). Backed by
//      /api/commission/plans.
//
// Styling mirrors Reports.js (StatCard-ish cards, gray-bordered tables).

function fmtMoney(n) {
  if (n === null || n === undefined || n === '') return '—';
  const num = Number(n);
  if (!Number.isFinite(num)) return '—';
  if (Math.abs(num) >= 1_000_000) return `$${(num / 1_000_000).toFixed(1)}M`;
  if (Math.abs(num) >= 1_000)     return `$${(num / 1_000).toFixed(1)}K`;
  return `$${num.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function todayISO() { return new Date().toISOString().slice(0, 10); }
function jan1ISO()  { return `${todayISO().slice(0, 4)}-01-01`; }

// Quick-pick ranges for the commission window.
function rangeFor(id) {
  const now = new Date();
  const y = now.getUTCFullYear(), m = now.getUTCMonth();
  const iso = (d) => d.toISOString().slice(0, 10);
  if (id === 'month')   return { from: iso(new Date(Date.UTC(y, m, 1))), to: todayISO() };
  if (id === 'quarter') return { from: iso(new Date(Date.UTC(y, Math.floor(m / 3) * 3, 1))), to: todayISO() };
  if (id === 'last_month') {
    return { from: iso(new Date(Date.UTC(y, m - 1, 1))), to: iso(new Date(Date.UTC(y, m, 0))) };
  }
  return { from: jan1ISO(), to: todayISO() }; // ytd
}

const QUICK_PERIODS = [
  { id: 'month',      label: 'This month' },
  { id: 'last_month', label: 'Last month' },
  { id: 'quarter',    label: 'This quarter' },
  { id: 'ytd',        label: 'Year to date' },
];

function AttainmentBar({ pct }) {
  if (pct === null || pct === undefined) return <span className="text-gray-400">—</span>;
  const tone = pct >= 100 ? 'bg-success-500' : pct >= 60 ? 'bg-brand-blue' : 'bg-warning-500';
  return (
    <div className="flex items-center gap-2 justify-end">
      <div className="w-20 h-2 rounded-full bg-gray-100 overflow-hidden shrink-0">
        <div className={`h-full ${tone}`} style={{ width: `${Math.min(pct, 100)}%` }} />
      </div>
      <span className={`text-xs font-medium ${pct >= 100 ? 'text-success-700' : 'text-gray-700'}`}>{pct}%</span>
    </div>
  );
}

export default function CommissionSection() {
  const [quick, setQuick] = useState('ytd');
  const [from, setFrom] = useState(jan1ISO());
  const [to, setTo] = useState(todayISO());
  const [report, setReport] = useState(null);
  const [plans, setPlans] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saveError, setSaveError] = useState('');

  // New-plan form state.
  const [newKind, setNewKind] = useState('rep');  // 'rep' | 'partner'
  const [newRep, setNewRep] = useState('');       // '' = org default
  const [newPartner, setNewPartner] = useState(''); // company id (partner plans)
  const [newSourceFilter, setNewSourceFilter] = useState('');
  const [newRate, setNewRate] = useState('');
  const [newGoal, setNewGoal] = useState('');
  const [newFrom, setNewFrom] = useState(jan1ISO());
  const [saving, setSaving] = useState(false);

  // Company options for partner plans — fetched lazily the first time the
  // form switches to "Partner", so the rep-only path never loads them.
  const [companies, setCompanies] = useState(null); // null = not fetched yet
  useEffect(() => {
    if (newKind !== 'partner' || companies !== null) return;
    api.get('/companies')
      .then((r) => setCompanies(Array.isArray(r.data) ? r.data : []))
      .catch(() => setCompanies([]));
  }, [newKind, companies]);

  const load = useCallback(async (f, t) => {
    setLoading(true);
    setError('');
    try {
      const [r, p] = await Promise.all([
        api.get(`/commission?from=${f}&to=${t}`),
        api.get('/commission/plans'),
      ]);
      setReport(r.data);
      setPlans(p.data || []);
    } catch (e) {
      const status = e?.response?.status;
      if (status === 403) setError('Reporting isn’t enabled for this workspace. An admin can turn it on under Feature Flags.');
      else setError(e?.response?.data?.error || 'Could not load the commission report.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(from, to); }, [from, to, load]);

  const pickQuick = (id) => {
    setQuick(id);
    const r = rangeFor(id);
    setFrom(r.from);
    setTo(r.to);
  };

  // Rep options for the plan form — the report already carries the team.
  const repOptions = useMemo(() => {
    const seen = new Map();
    for (const r of report?.reps || []) {
      if (r.rep_user_id != null) seen.set(r.rep_user_id, r.name || r.email || `User #${r.rep_user_id}`);
    }
    for (const p of plans) {
      if (p.owner_id != null && !seen.has(p.owner_id)) {
        seen.set(p.owner_id, p.owner_name || p.owner_email || `User #${p.owner_id}`);
      }
    }
    return [...seen.entries()].sort((a, b) => String(a[1]).localeCompare(String(b[1])));
  }, [report, plans]);

  const addPlan = async (e) => {
    e.preventDefault();
    if (newRate === '' || Number.isNaN(Number(newRate))) return;
    if (newKind === 'partner' && newPartner === '') {
      setSaveError('Pick the partner company this fee is paid to.');
      return;
    }
    setSaving(true);
    setSaveError('');
    try {
      const payload = newKind === 'partner'
        ? {
            kind: 'partner',
            partner_company_id: Number(newPartner),
            source_filter: newSourceFilter.trim() || null,
            rate_pct: Number(newRate),
            effective_from: newFrom,
          }
        : {
            owner_id: newRep === '' ? null : Number(newRep),
            rate_pct: Number(newRate),
            goal_amount: newGoal === '' ? null : Number(newGoal),
            effective_from: newFrom,
          };
      await api.post('/commission/plans', payload);
      setNewRate('');
      setNewGoal('');
      setNewSourceFilter('');
      await load(from, to);
    } catch (err) {
      setSaveError(err?.response?.data?.error || 'Could not save the plan.');
    } finally {
      setSaving(false);
    }
  };

  const deletePlan = async (id) => {
    setSaveError('');
    try {
      await api.delete(`/commission/plans/${id}`);
      await load(from, to);
    } catch (err) {
      setSaveError(err?.response?.data?.error || 'Could not delete the plan.');
    }
  };

  const totals = report?.totals || { won_count: 0, won_value: 0, commission: 0 };

  return (
    <div className="space-y-6">
      {/* Period picker — commission has its own window. */}
      <div className="bg-white border border-gray-200 rounded p-4 shadow-sm">
        <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
          <div>
            <p className="text-[11px] uppercase font-semibold text-gray-500 tracking-wide">Commission period</p>
            <p className="text-xs text-gray-500 mt-0.5">Closed-won deals with a close date inside this window.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex flex-wrap gap-1 bg-gray-100 rounded p-1">
              {QUICK_PERIODS.map(p => (
                <button key={p.id} onClick={() => pickQuick(p.id)}
                  className={`px-3 py-1.5 text-xs font-medium rounded transition ${quick === p.id
                    ? 'bg-brand-blue text-white shadow-sm'
                    : 'text-gray-600 hover:bg-white'}`}>
                  {p.label}
                </button>
              ))}
            </div>
            <label className="flex items-center gap-1 text-xs">
              <span className="font-semibold text-gray-600">From</span>
              <input type="date" value={from} max={to || undefined}
                onChange={e => { setQuick(''); setFrom(e.target.value); }}
                className="px-2 py-1 border border-gray-300 rounded font-mono" />
            </label>
            <label className="flex items-center gap-1 text-xs">
              <span className="font-semibold text-gray-600">To</span>
              <input type="date" value={to} min={from || undefined}
                onChange={e => { setQuick(''); setTo(e.target.value); }}
                className="px-2 py-1 border border-gray-300 rounded font-mono" />
            </label>
          </div>
        </div>
      </div>

      {error && <div className="bg-warning-50 border border-warning-200 text-warning-800 rounded p-4 text-sm">{error}</div>}

      {loading ? (
        <div className="text-sm text-gray-500 py-16 text-center">Computing commission…</div>
      ) : !error && report && (
        <>
          {/* Totals strip */}
          <div className="grid grid-cols-3 gap-3">
            <div className="bg-white rounded shadow-sm border border-gray-200 p-4">
              <p className="text-xs text-gray-500 uppercase font-medium">Closed-Won</p>
              <p className="text-2xl font-bold mt-1 text-success-600">{fmtMoney(totals.won_value)}</p>
              <p className="text-xs text-gray-500 mt-1">{totals.won_count} deal{totals.won_count === 1 ? '' : 's'} in period</p>
            </div>
            <div className="bg-white rounded shadow-sm border border-gray-200 p-4">
              <p className="text-xs text-gray-500 uppercase font-medium">Total Commission</p>
              <p className="text-2xl font-bold mt-1 text-brand-blue">{fmtMoney(totals.commission)}</p>
              <p className="text-xs text-gray-500 mt-1">Per-deal rate at each deal's close date</p>
            </div>
            <div className="bg-white rounded shadow-sm border border-gray-200 p-4">
              <p className="text-xs text-gray-500 uppercase font-medium">Effective Rate</p>
              <p className="text-2xl font-bold mt-1 text-gray-900">
                {totals.won_value > 0 ? `${((totals.commission / totals.won_value) * 100).toFixed(2)}%` : '—'}
              </p>
              <p className="text-xs text-gray-500 mt-1">Blended across reps and plans</p>
            </div>
          </div>

          {/* Per-rep table */}
          <section>
            <div className="flex items-baseline justify-between mb-2">
              <h3 className="text-sm font-semibold text-gray-700 uppercase">Per-Rep Commission</h3>
              <p className="text-xs text-gray-500">Rate shown = plan in effect at period end; payouts honor mid-period changes</p>
            </div>
            {(report.reps || []).length === 0 ? (
              <p className="text-sm text-gray-500 bg-white border border-gray-200 rounded p-6 text-center">
                No closed-won deals (or commission plans) in this period yet.
              </p>
            ) : (
              <div className="bg-white rounded border border-gray-200 overflow-x-auto">
                <table className="w-full text-sm min-w-[680px]">
                  <thead className="bg-gray-50 border-b border-gray-200">
                    <tr>
                      <th className="text-left px-3 py-2 font-medium whitespace-nowrap">Rep</th>
                      <th className="text-right px-3 py-2 font-medium whitespace-nowrap">Won #</th>
                      <th className="text-right px-3 py-2 font-medium whitespace-nowrap">Closed-Won ($)</th>
                      <th className="text-right px-3 py-2 font-medium whitespace-nowrap">Rate</th>
                      <th className="text-right px-3 py-2 font-medium whitespace-nowrap">Commission</th>
                      <th className="text-right px-3 py-2 font-medium whitespace-nowrap">Goal</th>
                      <th className="text-right px-3 py-2 font-medium whitespace-nowrap">Attainment</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(report.reps || []).map(r => (
                      <tr key={r.rep_user_id ?? 'unassigned'} className="border-b border-gray-100">
                        <td className="px-3 py-2 font-medium text-gray-900">
                          {r.name || r.email || (r.rep_user_id != null ? `User #${r.rep_user_id}` : 'Unassigned')}
                        </td>
                        <td className="px-3 py-2 text-right">{r.won_count}</td>
                        <td className="px-3 py-2 text-right text-success-700 font-semibold">{fmtMoney(r.won_value)}</td>
                        <td className="px-3 py-2 text-right">{Number(r.rate_pct).toFixed(2)}%</td>
                        <td className="px-3 py-2 text-right font-semibold text-brand-blue">{fmtMoney(r.commission)}</td>
                        <td className="px-3 py-2 text-right">{r.goal_amount != null ? fmtMoney(r.goal_amount) : '—'}</td>
                        <td className="px-3 py-2 text-right"><AttainmentBar pct={r.attainment_pct} /></td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot className="bg-gray-50 border-t border-gray-200">
                    <tr className="font-semibold">
                      <td className="px-3 py-2">Total</td>
                      <td className="px-3 py-2 text-right">{totals.won_count}</td>
                      <td className="px-3 py-2 text-right text-success-700">{fmtMoney(totals.won_value)}</td>
                      <td className="px-3 py-2" />
                      <td className="px-3 py-2 text-right text-brand-blue">{fmtMoney(totals.commission)}</td>
                      <td className="px-3 py-2" colSpan={2} />
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </section>

          {/* Partner statements (migration 159a) — only rendered once a
              partner plan exists, so rep-only workspaces see nothing new. */}
          {(report.partners || []).length > 0 && (
            <section>
              <div className="flex items-baseline justify-between mb-2">
                <h3 className="text-sm font-semibold text-gray-700 uppercase">Partner Statements</h3>
                <p className="text-xs text-gray-500">Closed-won deals attributed to each partner in this window · fee = rate × deal value</p>
              </div>
              <div className="space-y-2">
                {report.partners.map(p => (
                  <details key={p.partner_company_id} className="bg-white rounded border border-gray-200">
                    <summary className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 cursor-pointer select-none text-sm">
                      <span className="font-medium text-gray-900">{p.partner_name || `Company #${p.partner_company_id}`}</span>
                      {p.source_filter && (
                        <span className="text-xs text-gray-500 bg-gray-100 rounded px-1.5 py-0.5 font-mono">source: {p.source_filter}</span>
                      )}
                      <span className="ml-auto flex items-center gap-4 text-xs text-gray-600">
                        <span>{p.deal_count} deal{p.deal_count === 1 ? '' : 's'}</span>
                        <span className="text-success-700 font-semibold">{fmtMoney(p.attributed_value)}</span>
                        <span>{Number(p.rate_pct).toFixed(2)}%</span>
                        <span className="text-brand-blue font-semibold">{fmtMoney(p.fee)} fee</span>
                      </span>
                    </summary>
                    {p.deal_count === 0 ? (
                      <p className="px-3 pb-3 text-xs text-gray-500">No attributed closed-won deals in this window.</p>
                    ) : (
                      <div className="border-t border-gray-100 overflow-x-auto">
                        <table className="w-full text-xs min-w-[480px]">
                          <thead className="bg-gray-50 border-b border-gray-200">
                            <tr>
                              <th className="text-left px-3 py-1.5 font-medium">Deal</th>
                              <th className="text-right px-3 py-1.5 font-medium">Closed</th>
                              <th className="text-right px-3 py-1.5 font-medium">Value</th>
                              <th className="text-right px-3 py-1.5 font-medium">Rate</th>
                              <th className="text-right px-3 py-1.5 font-medium">Fee</th>
                            </tr>
                          </thead>
                          <tbody>
                            {p.deals.map(d => (
                              <tr key={d.id} className="border-b border-gray-100">
                                <td className="px-3 py-1.5 text-gray-900">{d.title || `Deal #${d.id}`}</td>
                                <td className="px-3 py-1.5 text-right font-mono">{d.close_date ? String(d.close_date).slice(0, 10) : '—'}</td>
                                <td className="px-3 py-1.5 text-right">{fmtMoney(d.value)}</td>
                                <td className="px-3 py-1.5 text-right">{Number(d.rate_pct).toFixed(2)}%</td>
                                <td className="px-3 py-1.5 text-right font-semibold text-brand-blue">{fmtMoney(d.fee)}</td>
                              </tr>
                            ))}
                          </tbody>
                          <tfoot className="bg-gray-50 border-t border-gray-200">
                            <tr className="font-semibold">
                              <td className="px-3 py-1.5" colSpan={2}>Total</td>
                              <td className="px-3 py-1.5 text-right">{fmtMoney(p.attributed_value)}</td>
                              <td className="px-3 py-1.5" />
                              <td className="px-3 py-1.5 text-right text-brand-blue">{fmtMoney(p.fee)}</td>
                            </tr>
                          </tfoot>
                        </table>
                      </div>
                    )}
                  </details>
                ))}
              </div>
            </section>
          )}

          {/* Plans editor */}
          <section>
            <div className="flex items-baseline justify-between mb-2">
              <h3 className="text-sm font-semibold text-gray-700 uppercase">Commission Plans</h3>
              <p className="text-xs text-gray-500">Rep-specific plans win; "Everyone (org default)" covers the rest. Partner plans pay a company a fee on attributed deals. Newer effective dates supersede older ones.</p>
            </div>

            <div className="bg-white rounded border border-gray-200">
              {/* Add form */}
              <form onSubmit={addPlan} className="flex flex-wrap items-end gap-3 p-3 border-b border-gray-100 text-xs">
                <label className="flex flex-col gap-1">
                  <span className="font-semibold text-gray-600 uppercase tracking-wide">Plan type</span>
                  <select value={newKind} onChange={e => setNewKind(e.target.value)}
                    className="px-2 py-1.5 border border-gray-300 rounded">
                    <option value="rep">Rep</option>
                    <option value="partner">Partner</option>
                  </select>
                </label>
                {newKind === 'partner' ? (
                  <>
                    <label className="flex flex-col gap-1">
                      <span className="font-semibold text-gray-600 uppercase tracking-wide">Partner company</span>
                      <select value={newPartner} onChange={e => setNewPartner(e.target.value)} required
                        className="px-2 py-1.5 border border-gray-300 rounded min-w-[160px]">
                        <option value="">{companies === null ? 'Loading…' : 'Pick a company…'}</option>
                        {(companies || []).map(c => (
                          <option key={c.id} value={c.id}>{c.name}</option>
                        ))}
                      </select>
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="font-semibold text-gray-600 uppercase tracking-wide">Source filter (optional)</span>
                      <input type="text" maxLength={80} value={newSourceFilter}
                        onChange={e => setNewSourceFilter(e.target.value)} placeholder="e.g. dealer-assoc"
                        title="Matched against the deal's channel_source / lead_source / source custom field. Leave blank to attribute deals linked to the partner company directly."
                        className="px-2 py-1.5 border border-gray-300 rounded w-36 font-mono" />
                    </label>
                  </>
                ) : (
                  <label className="flex flex-col gap-1">
                    <span className="font-semibold text-gray-600 uppercase tracking-wide">Rep</span>
                    <select value={newRep} onChange={e => setNewRep(e.target.value)}
                      className="px-2 py-1.5 border border-gray-300 rounded min-w-[160px]">
                      <option value="">Everyone (org default)</option>
                      {repOptions.map(([id, label]) => (
                        <option key={id} value={id}>{label}</option>
                      ))}
                    </select>
                  </label>
                )}
                <label className="flex flex-col gap-1">
                  <span className="font-semibold text-gray-600 uppercase tracking-wide">Rate %</span>
                  <input type="number" step="0.01" min="0" max="100" required value={newRate}
                    onChange={e => setNewRate(e.target.value)} placeholder="5.00"
                    className="px-2 py-1.5 border border-gray-300 rounded w-24 font-mono" />
                </label>
                {newKind === 'rep' && (
                  <label className="flex flex-col gap-1">
                    <span className="font-semibold text-gray-600 uppercase tracking-wide">Goal $ (optional)</span>
                    <input type="number" step="0.01" min="0" value={newGoal}
                      onChange={e => setNewGoal(e.target.value)} placeholder="—"
                      className="px-2 py-1.5 border border-gray-300 rounded w-32 font-mono" />
                  </label>
                )}
                <label className="flex flex-col gap-1">
                  <span className="font-semibold text-gray-600 uppercase tracking-wide">Effective from</span>
                  <input type="date" required value={newFrom} onChange={e => setNewFrom(e.target.value)}
                    className="px-2 py-1.5 border border-gray-300 rounded font-mono" />
                </label>
                <button type="submit" disabled={saving || newRate === '' || (newKind === 'partner' && newPartner === '')}
                  className="px-3 py-2 text-xs font-medium rounded bg-brand-blue text-white hover:opacity-90 disabled:opacity-50 transition">
                  {saving ? 'Saving…' : '+ Add plan'}
                </button>
              </form>

              {saveError && <p className="px-3 py-2 text-xs text-danger-700 bg-danger-50 border-b border-danger-100">{saveError}</p>}

              {plans.length === 0 ? (
                <p className="text-sm text-gray-500 p-6 text-center">
                  No plans yet. Add an org default (e.g. 5%) to start paying commission on every closed-won deal.
                </p>
              ) : (
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b border-gray-200">
                    <tr>
                      <th className="text-left px-3 py-2 font-medium">Applies to</th>
                      <th className="text-right px-3 py-2 font-medium">Rate</th>
                      <th className="text-right px-3 py-2 font-medium">Goal</th>
                      <th className="text-right px-3 py-2 font-medium">Effective from</th>
                      <th className="text-right px-3 py-2 font-medium" />
                    </tr>
                  </thead>
                  <tbody>
                    {plans.map(p => (
                      <tr key={p.id} className="border-b border-gray-100">
                        <td className="px-3 py-2 font-medium text-gray-900">
                          {p.kind === 'partner' ? (
                            <span>
                              {p.partner_company_name || `Company #${p.partner_company_id}`}
                              <span className="ml-1.5 text-[10px] uppercase font-semibold text-brand-blue bg-brand-blue/10 rounded px-1 py-0.5">Partner</span>
                              {p.source_filter && (
                                <span className="ml-1.5 text-xs text-gray-400 font-mono">source: {p.source_filter}</span>
                              )}
                            </span>
                          ) : p.owner_id == null
                            ? <span className="text-gray-600">Everyone <span className="text-xs text-gray-400">(org default)</span></span>
                            : (p.owner_name || p.owner_email || `User #${p.owner_id}`)}
                        </td>
                        <td className="px-3 py-2 text-right font-mono">{Number(p.rate_pct).toFixed(2)}%</td>
                        <td className="px-3 py-2 text-right">{p.goal_amount != null ? fmtMoney(p.goal_amount) : '—'}</td>
                        <td className="px-3 py-2 text-right font-mono text-xs">{String(p.effective_from).slice(0, 10)}</td>
                        <td className="px-3 py-2 text-right">
                          <button onClick={() => deletePlan(p.id)}
                            className="text-xs text-danger-600 hover:text-danger-800 hover:underline">
                            Delete
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
