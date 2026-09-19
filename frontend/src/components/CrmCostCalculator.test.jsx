// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Unit tests for the cost calculator's pure math (spec 203, Phase 3), plus
// the price-table invariants the comparison pages lean on.

import { describe, it, expect } from 'vitest';
import { computeCrmCost } from './CrmCostCalculator';
import { COMPETITORS, OPEN_CRM_TIERS, PRICES_VERIFIED, getCompetitorTier } from '../marketing/competitorPrices';

describe('computeCrmCost', () => {
  it('sums seats x price x 12 + onboarding + implementation + admin time', () => {
    const r = computeCrmCost({
      seats: 10,
      currentPerSeat: 100, // HubSpot Professional
      currentOnboardingFee: 1500,
      implementationPerYear: 5000,
      adminHoursPerWeek: 2,
      adminHourlyRate: 50,
      openCrmTier: 'starter',
    });
    expect(r.current.seats).toBe(12000);
    expect(r.current.onboarding).toBe(1500);
    expect(r.current.implementation).toBe(5000);
    expect(r.current.adminTime).toBe(2 * 52 * 50);
    expect(r.current.total).toBe(12000 + 1500 + 5000 + 5200);
    expect(r.openCrm.seats).toBe(10 * 15 * 12);
    expect(r.openCrm.implementation).toBe(0);
    expect(r.openCrm.total).toBe(1800);
    expect(r.savings).toBe(23700 - 1800);
    expect(r.savingsPct).toBe(Math.round(((23700 - 1800) / 23700) * 100));
  });

  it('uses the Pro price when asked and never a $12 seat', () => {
    const r = computeCrmCost({ seats: 4, currentPerSeat: 0, openCrmTier: 'pro' });
    expect(r.openCrm.total).toBe(4 * 39 * 12);
    expect(OPEN_CRM_TIERS.starter.perSeat).toBe(15);
    expect(OPEN_CRM_TIERS.pro.perSeat).toBe(39);
    expect(Object.values(OPEN_CRM_TIERS).some((t) => t.perSeat === 12)).toBe(false);
  });

  it('reports a negative saving honestly when the current setup is cheaper', () => {
    // Zoho Standard at $14 vs our $15 Starter, nothing else.
    const r = computeCrmCost({ seats: 5, currentPerSeat: 14, openCrmTier: 'starter' });
    expect(r.current.total).toBe(5 * 14 * 12);
    expect(r.openCrm.total).toBe(5 * 15 * 12);
    expect(r.savings).toBe(-60);
    expect(r.savingsPct).toBeLessThan(0);
  });

  it('treats garbage input as zero and floors fractional seats', () => {
    const r = computeCrmCost({ seats: '7.9', currentPerSeat: 'abc', implementationPerYear: -500, adminHoursPerWeek: null, openCrmTier: 'nope' });
    expect(r.seats).toBe(7);
    expect(r.tier).toBe('starter');
    expect(r.current.total).toBe(0);
    expect(r.openCrm.total).toBe(7 * 15 * 12);
    expect(r.savingsPct).toBe(0);
  });

  it('with no input returns all zeros rather than NaN', () => {
    const r = computeCrmCost();
    expect(r.current.total).toBe(0);
    expect(r.openCrm.total).toBe(0);
    expect(r.savings).toBe(0);
    expect(Number.isNaN(r.savingsPct)).toBe(false);
  });
});

describe('competitor price table', () => {
  it('carries a verification date and a default tier for every competitor', () => {
    expect(PRICES_VERIFIED).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    for (const c of Object.values(COMPETITORS)) {
      expect(c.tiers.length).toBeGreaterThan(0);
      expect(getCompetitorTier(c.key)).toBeTruthy();
      expect(getCompetitorTier(c.key).key).toBe(c.defaultTier);
      for (const t of c.tiers) expect(typeof t.perSeat).toBe('number');
    }
  });

  it('matches the prices verified 2026-09-19 (change both when re-verifying)', () => {
    const price = (c, t) => getCompetitorTier(c, t).perSeat;
    expect(price('hubspot', 'starter')).toBe(15);
    expect(price('hubspot', 'professional')).toBe(100);
    expect(price('hubspot', 'enterprise')).toBe(150);
    expect(price('salesforce', 'starter')).toBe(25);
    expect(price('salesforce', 'pro')).toBe(100);
    expect(price('salesforce', 'enterprise')).toBe(175);
    expect(price('salesforce', 'unlimited')).toBe(350);
    expect(price('pipedrive', 'essential')).toBe(14);
    expect(price('pipedrive', 'professional')).toBe(59);
    expect(price('zoho', 'standard')).toBe(14);
    expect(price('zoho', 'enterprise')).toBe(40);
    expect(price('spreadsheet')).toBe(0);
    expect(price('custom')).toBe(0);
  });
});
