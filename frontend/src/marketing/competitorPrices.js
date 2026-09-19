// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Competitor LIST prices used by the comparison pages and the cost calculator.
//
// Every number here is a published per-seat, per-month list price on ANNUAL
// billing, verified by web search on PRICES_VERIFIED. They are also registered
// in PRICING_AND_FEATURES.md (marketing-claim source registry) — change both
// in the same commit. Re-verify quarterly; vendors move these without notice
// (Salesforce bumped Enterprise/Unlimited mid-2026, for example).
//
// Our own prices come from backend/services/stripe.js ($15 Starter / $39 Pro)
// and are deliberately NOT derived from any competitor's.

export const PRICES_VERIFIED = '2026-09-19';

// Open CRM hosted tiers, $/seat/month. Self-host and the hosted free tier are
// $0 and are not "tiers" the calculator multiplies by seats.
export const OPEN_CRM_TIERS = {
  starter: { key: 'starter', label: 'Starter', perSeat: 15 },
  pro: { key: 'pro', label: 'Pro', perSeat: 39 },
};

export const COMPETITORS = {
  hubspot: {
    key: 'hubspot',
    name: 'HubSpot Sales Hub',
    tiers: [
      { key: 'starter', label: 'Starter', perSeat: 15, note: '$20 on monthly billing' },
      { key: 'professional', label: 'Professional', perSeat: 100, onboardingFee: 1500 },
      { key: 'enterprise', label: 'Enterprise', perSeat: 150, onboardingFee: 3500 },
    ],
    defaultTier: 'professional',
    note: 'Professional and Enterprise carry a required one-time onboarding fee. Marketing Hub is priced by contact count on top.',
  },
  salesforce: {
    key: 'salesforce',
    name: 'Salesforce Sales Cloud',
    tiers: [
      { key: 'starter', label: 'Starter Suite', perSeat: 25 },
      { key: 'pro', label: 'Pro Suite', perSeat: 100 },
      { key: 'enterprise', label: 'Enterprise', perSeat: 175 },
      { key: 'unlimited', label: 'Unlimited', perSeat: 350 },
    ],
    defaultTier: 'enterprise',
    note: 'Pro and above are annual-contract only. Implementation is almost always a separate partner engagement.',
  },
  pipedrive: {
    key: 'pipedrive',
    name: 'Pipedrive',
    tiers: [
      { key: 'essential', label: 'Essential', perSeat: 14 },
      { key: 'advanced', label: 'Advanced', perSeat: 29 },
      { key: 'professional', label: 'Professional', perSeat: 59 },
      { key: 'power', label: 'Power', perSeat: 69 },
      { key: 'enterprise', label: 'Enterprise', perSeat: 99 },
    ],
    defaultTier: 'professional',
    note: 'Add-ons (LeadBooster, Smart Docs, Campaigns, Projects) are priced separately.',
  },
  zoho: {
    key: 'zoho',
    name: 'Zoho CRM',
    tiers: [
      { key: 'standard', label: 'Standard', perSeat: 14 },
      { key: 'professional', label: 'Professional', perSeat: 23 },
      { key: 'enterprise', label: 'Enterprise', perSeat: 40 },
      { key: 'ultimate', label: 'Ultimate', perSeat: 52 },
    ],
    defaultTier: 'enterprise',
    note: 'Free for up to 3 users. Roughly 20-30% more on monthly billing.',
  },
  spreadsheet: {
    key: 'spreadsheet',
    name: 'Spreadsheet',
    tiers: [{ key: 'sheet', label: 'Google Sheets / Excel', perSeat: 0 }],
    defaultTier: 'sheet',
    note: 'The seat cost is $0. The real cost is the hours someone spends keeping it alive.',
  },
  custom: {
    key: 'custom',
    name: 'Custom-built CRM',
    tiers: [{ key: 'custom', label: 'Your own build', perSeat: 0 }],
    defaultTier: 'custom',
    note: 'No seat price. The cost is the developer time to build it and the developer time to change it.',
  },
};

export function getCompetitorTier(competitorKey, tierKey) {
  const c = COMPETITORS[competitorKey];
  if (!c) return null;
  return c.tiers.find((t) => t.key === (tierKey || c.defaultTier)) || c.tiers[0];
}
