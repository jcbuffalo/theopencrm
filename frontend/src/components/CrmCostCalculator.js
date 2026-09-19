// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// CRM cost calculator (spec 203, Phase 3). Client-side only — no backend.
//
// The point is that the saving is something the visitor COMPUTES from their
// own numbers, not something we assert. So the inputs are theirs (seats,
// which competitor tier they are on, what they pay someone to implement and
// administer it) and the formula is visible: seats x list price x 12, plus
// implementation, plus admin hours x 52 x rate. Our side is seats x $15 or
// $39 x 12 and $0 implementation. AI usage is NOT in either column and the
// footnote says so — it is metered per use, or $0 with your own Anthropic
// key, and pretending otherwise would be the kind of claim this page exists
// to avoid.
//
// computeCrmCost is exported separately and unit-tested (CrmCostCalculator.test.jsx).

import React, { useMemo, useState } from 'react';
import { COMPETITORS, OPEN_CRM_TIERS, PRICES_VERIFIED, getCompetitorTier } from '../marketing/competitorPrices';

const WEEKS_PER_YEAR = 52;

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Pure math. All money in whole dollars per YEAR.
 *
 * @param {object} input
 * @param {number} input.seats
 * @param {number} input.currentPerSeat        competitor $/seat/month (0 for spreadsheet / custom)
 * @param {number} [input.currentOnboardingFee] one-time fee amortised into year one (HubSpot Pro/Ent)
 * @param {number} input.implementationPerYear  consultants / partner / developer $ per year
 * @param {number} input.adminHoursPerWeek
 * @param {number} input.adminHourlyRate
 * @param {'starter'|'pro'} input.openCrmTier
 */
export function computeCrmCost(input = {}) {
  const seats = Math.max(0, Math.floor(num(input.seats)));
  const currentPerSeat = num(input.currentPerSeat);
  const onboarding = num(input.currentOnboardingFee);
  const implementation = num(input.implementationPerYear);
  const adminHours = num(input.adminHoursPerWeek);
  const adminRate = num(input.adminHourlyRate);
  const tier = OPEN_CRM_TIERS[input.openCrmTier] || OPEN_CRM_TIERS.starter;

  const currentSeats = seats * currentPerSeat * 12;
  const adminTime = adminHours * WEEKS_PER_YEAR * adminRate;
  const currentTotal = currentSeats + onboarding + implementation + adminTime;

  const openSeats = seats * tier.perSeat * 12;
  const openTotal = openSeats; // $0 implementation, $0 onboarding; admin time is the user's call

  const savings = currentTotal - openTotal;
  const savingsPct = currentTotal > 0 ? Math.round((savings / currentTotal) * 100) : 0;

  return {
    seats,
    tier: tier.key,
    current: {
      seats: Math.round(currentSeats),
      onboarding: Math.round(onboarding),
      implementation: Math.round(implementation),
      adminTime: Math.round(adminTime),
      total: Math.round(currentTotal),
    },
    openCrm: {
      seats: Math.round(openSeats),
      implementation: 0,
      total: Math.round(openTotal),
    },
    savings: Math.round(savings),
    savingsPct,
  };
}

const fmt = (n) => `$${Math.round(n).toLocaleString('en-US')}`;

function Field({ label, children, hint }) {
  return (
    <label className="block">
      <span className="block text-sm font-medium text-gray-800 mb-1">{label}</span>
      {children}
      {hint && <span className="block text-xs text-gray-500 mt-1">{hint}</span>}
    </label>
  );
}

const inputCls =
  'w-full min-h-[44px] px-3 py-2 border border-gray-300 rounded-lg text-base focus:outline-none focus:ring-2 focus:ring-brand-blue focus:border-brand-blue bg-white';

/**
 * @param {object} props
 * @param {string} [props.defaultCompetitor]  key in COMPETITORS
 */
export default function CrmCostCalculator({ defaultCompetitor = 'hubspot' }) {
  const [competitorKey, setCompetitorKey] = useState(COMPETITORS[defaultCompetitor] ? defaultCompetitor : 'hubspot');
  const [tierKey, setTierKey] = useState(COMPETITORS[competitorKey].defaultTier);
  const [seats, setSeats] = useState(10);
  const [implementation, setImplementation] = useState(competitorKey === 'salesforce' ? 15000 : competitorKey === 'custom' ? 40000 : 0);
  const [adminHours, setAdminHours] = useState(competitorKey === 'spreadsheet' ? 5 : 3);
  const [adminRate, setAdminRate] = useState(60);
  const [openTier, setOpenTier] = useState('starter');

  const competitor = COMPETITORS[competitorKey];
  const tier = getCompetitorTier(competitorKey, tierKey);

  const result = useMemo(
    () =>
      computeCrmCost({
        seats,
        currentPerSeat: tier ? tier.perSeat : 0,
        currentOnboardingFee: tier && tier.onboardingFee ? tier.onboardingFee : 0,
        implementationPerYear: implementation,
        adminHoursPerWeek: adminHours,
        adminHourlyRate: adminRate,
        openCrmTier: openTier,
      }),
    [seats, tier, implementation, adminHours, adminRate, openTier]
  );

  const onCompetitorChange = (key) => {
    setCompetitorKey(key);
    setTierKey(COMPETITORS[key].defaultTier);
  };

  const positive = result.savings >= 0;

  return (
    <div className="bg-white border border-gray-200 rounded-2xl shadow-sm p-5 sm:p-8" data-testid="crm-cost-calculator">
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-8">
        <div className="lg:col-span-3 grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Seats">
            <input type="number" min="1" step="1" inputMode="numeric" value={seats} onChange={(e) => setSeats(num(e.target.value, 1))} className={inputCls} aria-label="Seats" />
          </Field>
          <Field label="Current CRM">
            <select value={competitorKey} onChange={(e) => onCompetitorChange(e.target.value)} className={inputCls} aria-label="Current CRM">
              {Object.values(COMPETITORS).map((c) => (
                <option key={c.key} value={c.key}>{c.name}</option>
              ))}
            </select>
          </Field>
          <Field label="Tier" hint={tier && tier.onboardingFee ? `Includes the required ${fmt(tier.onboardingFee)} onboarding fee in year one.` : competitor.note}>
            <select value={tier ? tier.key : ''} onChange={(e) => setTierKey(e.target.value)} className={inputCls} aria-label="Tier" disabled={competitor.tiers.length === 1}>
              {competitor.tiers.map((t) => (
                <option key={t.key} value={t.key}>{t.label} ({t.perSeat === 0 ? '$0' : `$${t.perSeat}/seat/mo`})</option>
              ))}
            </select>
          </Field>
          <Field label="Implementation, consultants or developers ($ per year)">
            <input type="number" min="0" step="500" inputMode="numeric" value={implementation} onChange={(e) => setImplementation(num(e.target.value))} className={inputCls} aria-label="Implementation cost per year" />
          </Field>
          <Field label="Admin hours per week" hint="Time someone spends configuring, cleaning, or nursing the current tool.">
            <input type="number" min="0" step="0.5" inputMode="decimal" value={adminHours} onChange={(e) => setAdminHours(num(e.target.value))} className={inputCls} aria-label="Admin hours per week" />
          </Field>
          <Field label="Their hourly cost ($)">
            <input type="number" min="0" step="5" inputMode="numeric" value={adminRate} onChange={(e) => setAdminRate(num(e.target.value))} className={inputCls} aria-label="Admin hourly rate" />
          </Field>
          <Field label="Open CRM plan">
            <select value={openTier} onChange={(e) => setOpenTier(e.target.value)} className={inputCls} aria-label="Open CRM plan">
              {Object.values(OPEN_CRM_TIERS).map((t) => (
                <option key={t.key} value={t.key}>{t.label} (${t.perSeat}/seat/mo)</option>
              ))}
            </select>
          </Field>
        </div>

        <div className="lg:col-span-2">
          <div className="rounded-xl bg-gray-50 border border-gray-200 p-5 h-full flex flex-col">
            <div className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-3">Per year, {result.seats} seat{result.seats === 1 ? '' : 's'}</div>
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between gap-4">
                <dt className="text-gray-700">{competitor.name}, seats</dt>
                <dd className="font-medium text-gray-900">{fmt(result.current.seats)}</dd>
              </div>
              {result.current.onboarding > 0 && (
                <div className="flex justify-between gap-4">
                  <dt className="text-gray-700">Onboarding fee (year one)</dt>
                  <dd className="font-medium text-gray-900">{fmt(result.current.onboarding)}</dd>
                </div>
              )}
              <div className="flex justify-between gap-4">
                <dt className="text-gray-700">Implementation</dt>
                <dd className="font-medium text-gray-900">{fmt(result.current.implementation)}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-gray-700">Admin time</dt>
                <dd className="font-medium text-gray-900">{fmt(result.current.adminTime)}</dd>
              </div>
              <div className="flex justify-between gap-4 border-t border-gray-300 pt-2">
                <dt className="font-semibold text-gray-900">Current, all-in</dt>
                <dd className="font-semibold text-gray-900" data-testid="calc-current-total">{fmt(result.current.total)}</dd>
              </div>
              <div className="flex justify-between gap-4 pt-3">
                <dt className="text-gray-700">The Open CRM {OPEN_CRM_TIERS[result.tier].label}, seats</dt>
                <dd className="font-medium text-gray-900">{fmt(result.openCrm.seats)}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-gray-700">Implementation</dt>
                <dd className="font-medium text-gray-900">$0</dd>
              </div>
              <div className="flex justify-between gap-4 border-t border-gray-300 pt-2">
                <dt className="font-semibold text-gray-900">The Open CRM, all-in</dt>
                <dd className="font-semibold text-gray-900" data-testid="calc-open-total">{fmt(result.openCrm.total)}</dd>
              </div>
            </dl>
            <div className={`mt-5 rounded-lg p-4 ${positive ? 'bg-green-50 border border-green-200' : 'bg-amber-50 border border-amber-200'}`}>
              <div className="text-xs font-semibold uppercase tracking-wider text-gray-600">{positive ? 'Estimated saving' : 'Estimated extra cost'}</div>
              <div className={`text-3xl font-bold ${positive ? 'text-green-800' : 'text-amber-800'}`} data-testid="calc-savings">
                {fmt(Math.abs(result.savings))}
                <span className="text-base font-medium ml-2">{positive ? `${result.savingsPct}% less` : 'more'} per year</span>
              </div>
              {!positive && (
                <p className="text-xs text-amber-900 mt-2">At these numbers your current setup is cheaper. Self-hosting is $0 a seat if you want to try that column instead.</p>
              )}
            </div>
          </div>
        </div>
      </div>

      <p className="text-xs text-gray-500 mt-5 leading-relaxed">
        Competitor figures are published list prices per seat per month on annual billing, verified {PRICES_VERIFIED}; your contract may differ.
        The Open CRM figures are the live hosted prices (${OPEN_CRM_TIERS.starter.perSeat} Starter, ${OPEN_CRM_TIERS.pro.perSeat} Pro per seat per month); self-hosting is $0.
        AI usage is not included in either column: on the hosted service it is metered per use on top of the seat, or $0 markup with your own Anthropic key. Admin time is your estimate and is not added to our column; you will still spend some.
      </p>
    </div>
  );
}
