// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { serviceContracts } from '../api';
import Nav from '../components/Nav';
import { Alert, Container, PageHeader, Spinner, StatusBadge } from '../components/ui';

// Customer Success — Renewals pipeline board (CS-3).
//
// A board of service contracts grouped by renewal_stage, fed by two endpoints:
//   • GET /api/service-contracts/renewals → rollup counts + summed annual_value
//     per stage (and a next-90-day forecast).
//   • GET /api/service-contracts → the individual contract rows, which we bucket
//     into the same stages so each column lists its contracts.
// The at_risk column is highlighted; a header strip shows total annual value.

const STAGES = [
  { key: 'upcoming', label: 'Upcoming',  accent: 'border-t-gray-300'     },
  { key: 'at_risk',  label: 'At risk',   accent: 'border-t-danger-400'   },
  { key: 'renewed',  label: 'Renewed',   accent: 'border-t-success-400'  },
  { key: 'churned',  label: 'Churned',   accent: 'border-t-gray-400'     },
];

function fmtMoney(n) {
  if (n === null || n === undefined || n === '') return '—';
  return `$${Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function fmtDateShort(ts) {
  if (!ts) return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString();
}

function stageOf(contract) {
  const s = contract.renewal_stage || 'upcoming';
  return STAGES.some((x) => x.key === s) ? s : 'upcoming';
}

export default function Renewals() {
  const navigate = useNavigate();
  const [rollup, setRollup] = useState(null);
  const [contracts, setContracts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    setLoading(true);
    Promise.all([serviceContracts.renewals(), serviceContracts.list()])
      .then(([r, list]) => {
        if (!active) return;
        setRollup(r);
        setContracts(Array.isArray(list) ? list : []);
        setError('');
      })
      .catch((err) => {
        if (active) setError(err.response?.data?.error || 'Failed to load renewals');
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const byStage = STAGES.reduce((acc, s) => { acc[s.key] = []; return acc; }, {});
  for (const c of contracts) byStage[stageOf(c)].push(c);

  const totalAnnual = rollup?.total_annual_value ?? 0;
  const totalCount = rollup?.total_count ?? 0;
  const forecast = rollup?.forecast_90d;

  return (
    <div className="min-h-screen bg-gray-50">
      <Nav active="renewals" />
      <Container size="wide">
        <PageHeader
          title="Renewals"
          subtitle="Service-contract renewal pipeline by stage. At-risk renewals are highlighted."
        />

        <div className="space-y-6">
          {error && <Alert tone="danger" onDismiss={() => setError('')}>{error}</Alert>}

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <SummaryCard label="Total annual value" value={fmtMoney(totalAnnual)} />
            <SummaryCard label="Contracts" value={totalCount} />
            {forecast && (
              <SummaryCard
                label="Due in 90 days"
                value={fmtMoney(forecast.total_annual_value)}
                sub={`${forecast.total_count} contract${forecast.total_count === 1 ? '' : 's'}`}
              />
            )}
          </div>

          {loading ? (
            <Spinner size="lg" label="Loading renewals…" />
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
              {STAGES.map((stage) => {
                const items = byStage[stage.key];
                const stats = rollup?.stages?.[stage.key] || { count: 0, annual_value: 0 };
                const isAtRisk = stage.key === 'at_risk';
                return (
                  <div
                    key={stage.key}
                    className={`rounded border border-t-4 ${stage.accent} ${isAtRisk ? 'bg-danger-50/40 border-danger-200' : 'bg-white border-gray-200'} shadow-card flex flex-col`}
                  >
                    <div className="px-4 py-3 border-b border-gray-100">
                      <div className="flex items-center justify-between">
                        <h3 className={`text-sm font-semibold ${isAtRisk ? 'text-danger-700' : 'text-gray-900'}`}>{stage.label}</h3>
                        <StatusBadge tone={isAtRisk && stats.count > 0 ? 'error' : 'neutral'} label={stats.count} />
                      </div>
                      <div className="text-xs text-gray-500 mt-1">{fmtMoney(stats.annual_value)} / yr</div>
                    </div>

                    <div className="p-3 space-y-2 flex-1 min-h-[120px]">
                      {items.length === 0 ? (
                        <div className="text-xs text-gray-400 text-center py-6">No contracts</div>
                      ) : (
                        items.map((c) => {
                          const days = c.days_to_end !== null && c.days_to_end !== undefined ? Number(c.days_to_end) : null;
                          const dueSoon = days !== null && days <= (c.renewal_notice_days || 30);
                          return (
                            <button
                              key={c.id}
                              onClick={() => c.customer_id && navigate(`/accounts/${c.customer_id}`)}
                              className={`w-full text-left rounded border p-3 transition ${c.customer_id ? 'hover:border-brand-blue hover:shadow-sm cursor-pointer' : 'cursor-default'} ${isAtRisk ? 'bg-white border-danger-200' : 'bg-white border-gray-200'}`}
                            >
                              <div className="font-medium text-sm text-gray-900 break-words">{c.name}</div>
                              <div className="text-xs text-gray-500 mt-0.5 break-words">{c.customer_name || 'No customer'}</div>
                              <div className="flex items-center justify-between mt-2">
                                <span className="text-xs font-medium text-gray-700">{fmtMoney(c.annual_value)} / yr</span>
                                {days !== null && (
                                  <span className={`text-xs ${dueSoon ? 'text-danger-600 font-semibold' : 'text-gray-400'}`}>
                                    {days < 0 ? `${Math.abs(days)}d overdue` : `${days}d left`}
                                  </span>
                                )}
                              </div>
                              {c.end_date && (
                                <div className="text-[11px] text-gray-400 mt-1">Ends {fmtDateShort(c.end_date)}</div>
                              )}
                              {stage.key === 'churned' && c.churn_reason && (
                                <div className="text-[11px] text-gray-500 mt-1 italic break-words">{c.churn_reason}</div>
                              )}
                            </button>
                          );
                        })
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </Container>
    </div>
  );
}

function SummaryCard({ label, value, sub }) {
  return (
    <div className="bg-white rounded border border-gray-200 px-4 py-3 shadow-card">
      <div className="text-xs font-medium text-gray-500">{label}</div>
      <div className="text-xl font-semibold tracking-tight text-gray-900 leading-tight mt-0.5">{value}</div>
      {sub && <div className="text-xs text-gray-400">{sub}</div>}
    </div>
  );
}
