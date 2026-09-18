// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Super-admin AI Pay-as-you-go billing console.
//
// Lists every org's AI billing state (status, MTD usage in $, threshold bar)
// and exposes the four super-admin actions documented in routes/billingRoutes.js:
//
//   POST /api/billing/ai/comp         — flip status='comped' (no Stripe, free use)
//   POST /api/billing/ai/start-trial  — flip status='trial' with N-day expiry
//   POST /api/billing/ai/halt         — flip status='halted' (with reason)
//   POST /api/billing/ai/resume       — restore from halted
//
// Backend gate: super-admin only. Non-super-admins land on the access-denied
// banner (the page renders before calling the list endpoint, so we surface a
// clean state instead of a flash of "loading…" → 403).

import React, { useEffect, useState, useCallback } from 'react';
import api from '../api';
import Nav from '../components/Nav';
import { useAuth } from '../AuthContext';
import { Alert, Button, Card, Container, PageHeader, Skeleton, StatusBadge } from '../components/ui';

// Maps the billing-status domain values to the shared StatusBadge tones.
// purple-for-trial collapses to "info" (brand-blue) — the shared palette
// doesn't carry purple, and visually a trial is just an in-progress state.
const STATUS_TONE = {
  active:       { tone: 'success', label: 'Active' },
  comped:       { tone: 'info',    label: 'Comped' },
  trial:        { tone: 'info',    label: 'Trial' },
  past_due:     { tone: 'warning', label: 'Past due' },
  halted:       { tone: 'error',   label: 'Halted' },
  unconfigured: { tone: 'neutral', label: 'Unconfigured' },
};

const TH = 'px-4 py-3 bg-gray-50 border-b border-gray-200 text-left text-xs font-semibold uppercase tracking-wider text-gray-500 whitespace-nowrap';

function BillingStatusBadge({ status }) {
  const s = STATUS_TONE[status] || STATUS_TONE.unconfigured;
  return <StatusBadge tone={s.tone} label={s.label} />;
}

function ThresholdBar({ pct }) {
  const clamped = Math.max(0, Math.min(100, Number(pct) || 0));
  const color = clamped >= 100 ? 'bg-danger-500' : clamped >= 75 ? 'bg-warning-500' : 'bg-success-500';
  return (
    <div className="w-full bg-gray-200 rounded-full h-2 overflow-hidden">
      <div className={`h-2 ${color}`} style={{ width: `${clamped}%` }} />
    </div>
  );
}

export default function AdminAiBilling() {
  const { user } = useAuth();
  const isSuperAdmin = user?.role === 'super_admin' || user?.is_super_admin;
  const [orgs, setOrgs] = useState(null);
  const [configured, setConfigured] = useState(false);
  const [err, setErr] = useState(null);
  const [overThresholdOnly, setOverThresholdOnly] = useState(false);
  const [busy, setBusy] = useState({}); // { [orgId]: true while a row action is in flight }

  const load = useCallback(async () => {
    setErr(null);
    try {
      const r = await api.get('/billing/ai/admin/list');
      setOrgs(r.data.orgs || []);
      setConfigured(!!r.data.configured);
    } catch (e) {
      setErr(e.response?.data?.error || e.message || 'Failed to load');
    }
  }, []);

  useEffect(() => { if (isSuperAdmin) load(); }, [isSuperAdmin, load]);

  const act = async (orgId, action, body = {}) => {
    setBusy((b) => ({ ...b, [orgId]: true }));
    try {
      // halt/resume target the CALLER'S org by default. For super-admin acting
      // on someone else's org we use comp / start-trial which take org_id in
      // the body. halt/resume of another org isn't reachable today — that's a
      // deliberate scope cut; super-admin can comp an org out of trouble or
      // the org's own admin can halt themselves.
      await api.post(`/billing/ai/${action}`, body);
      await load();
    } catch (e) {
      // Surface a single-line error inline so the operator sees it without
      // blowing away their place in the table.
      setErr(`${action}: ${e.response?.data?.error || e.message}`);
    } finally {
      setBusy((b) => { const c = { ...b }; delete c[orgId]; return c; });
    }
  };

  const comp = (orgId) => {
    if (!window.confirm('Mark this org as comped (free AI, no Stripe)?')) return;
    return act(orgId, 'comp', { org_id: orgId });
  };
  const startTrial = (orgId) => {
    const daysStr = window.prompt('Trial length in days?', '14');
    const days = Number(daysStr);
    if (!Number.isFinite(days) || days < 1) return;
    return act(orgId, 'start-trial', { org_id: orgId, days });
  };

  if (!isSuperAdmin) {
    return (
      <div className="min-h-screen bg-gray-50">
        <Nav active="admin" />
        <Container size="narrow">
          <Card className="text-center">
            <h1 className="text-2xl font-semibold tracking-tight text-gray-900 mb-2">Access denied</h1>
            <p className="text-gray-600">AI Billing is a super-admin tool. Your account doesn't have that role.</p>
          </Card>
        </Container>
      </div>
    );
  }

  const rows = (orgs || []).filter((o) =>
    !overThresholdOnly || Number(o.threshold_pct || 0) >= 100
  );

  return (
    <div className="min-h-screen bg-gray-50">
      <Nav active="admin" />
      <Container size="wide">
        <PageHeader
          title="AI Pay-as-you-go Billing"
          subtitle="Per-org status, month-to-date usage, and admin controls."
          primaryAction={{ label: 'Refresh', icon: 'refresh', variant: 'secondary', onClick: load }}
          actions={
            <label className="inline-flex items-center gap-2 text-sm text-gray-700 min-h-[40px] px-1">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-gray-300 text-brand-blue focus:ring-brand-blue"
                checked={overThresholdOnly}
                onChange={(e) => setOverThresholdOnly(e.target.checked)}
              />
              Over threshold only
            </label>
          }
        />

        <div className="space-y-6">
          {!configured && (
            <Alert tone="warning" title="Stripe usage price not configured">
              STRIPE_PRICE_AI_USAGE not set — checkout will 503
            </Alert>
          )}

          {err && <Alert tone="danger" onDismiss={() => setErr(null)}>{err}</Alert>}

          {/* Hand-rolled table (not DataTable): the existing spec queries rows
              by exact text, and DataTable renders a second card-mode copy of
              every row below md, which would double-match. */}
          <Card padding="none">
            {orgs === null ? (
              <div className="p-5"><Skeleton lines={5} /></div>
            ) : rows.length === 0 ? (
              <div className="p-8 text-center text-sm text-gray-500">No orgs to show.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead>
                    <tr>
                      <th className={TH}>Org</th>
                      <th className={TH}>Status</th>
                      <th className={TH}>MTD usage</th>
                      <th className={TH}>Threshold</th>
                      <th className={`${TH} text-right`}>Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {rows.map((o) => (
                      <tr key={o.id} className="hover:bg-gray-50 transition-colors">
                        <td className="px-4 py-3 align-top">
                          <div className="font-medium text-gray-900">{o.name || `Org ${o.id}`}</div>
                          <div className="text-xs text-gray-500">id={o.id}</div>
                        </td>
                        <td className="px-4 py-3 align-top">
                          <BillingStatusBadge status={o.status} />
                          {o.halted_reason && (
                            <div className="text-xs text-gray-500 mt-1">reason: {o.halted_reason}</div>
                          )}
                          {o.trial_ends_at && o.status === 'trial' && (
                            <div className="text-xs text-gray-500 mt-1">
                              trial until {new Date(o.trial_ends_at).toLocaleDateString()}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3 align-top text-gray-700">
                          <div className="font-semibold">${Number(o.mtd_usage_usd || 0).toFixed(2)}</div>
                          <div className="text-xs text-gray-500">
                            {o.mtd_calls || 0} calls · {(o.mtd_tokens || 0).toLocaleString()} tokens
                          </div>
                        </td>
                        <td className="px-4 py-3 align-top min-w-[160px]">
                          <div className="text-xs text-gray-600 mb-1">
                            ${Number(o.threshold_usd || 50).toFixed(2)}/mo · {o.threshold_pct || 0}%
                          </div>
                          <ThresholdBar pct={o.threshold_pct || 0} />
                        </td>
                        <td className="px-4 py-3 align-top text-right whitespace-nowrap">
                          <div className="inline-flex items-center justify-end gap-1">
                            {o.status !== 'comped' && (
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={busy[o.id]}
                                onClick={() => comp(o.id)}
                                title="Mark as comped (free, no Stripe)"
                                className="text-brand-blue hover:bg-info-50"
                              >
                                Comp
                              </Button>
                            )}
                            {o.status !== 'trial' && o.status !== 'active' && (
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={busy[o.id]}
                                onClick={() => startTrial(o.id)}
                                title="Start a time-limited trial"
                                className="text-purple-700 hover:bg-purple-50"
                              >
                                Trial
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <p className="text-xs text-gray-500">
            Halt / resume actions live on the org's own admin surface (per-org admin signs in and uses
            their settings). This page covers cross-org super-admin actions (comp / trial). Threshold
            warnings fire hourly via services/aiThresholdWorker.js — warn-only, never auto-halt.
          </p>
        </div>
      </Container>
    </div>
  );
}
