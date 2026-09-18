// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Unit tests for the PURE account-health scoring function (CS-2).
//
// scoreAccount(signals) takes no DB and no clock — it's a deterministic
// function of its inputs — so these tests don't mock anything. We cover the
// three bands (green/yellow/red), the band thresholds, the clamp, and the
// shape of the returned breakdown.
//
// describe / test / expect are global (vitest.config.js sets globals: true).

const { scoreAccount, bandFor, GREEN_MIN, YELLOW_MIN } = require('../services/accountHealth');

describe('accountHealth.scoreAccount', () => {
  test('GREEN: a healthy, recently-touched account stays at/near 100', () => {
    const r = scoreAccount({
      daysSinceLastTouch: 3,
      openBlockingIssues: 0,
      openRedIssues: 0,
      daysToNextRenewal: 200,
      atRiskOpenDeals: 0,
      openDeals: 2,
      emailsSent30d: 4,
      emailsOpened30d: 3,
    });
    expect(r.score).toBe(100);
    expect(r.band).toBe('green');
    expect(Array.isArray(r.signals)).toBe(true);
    // every recorded penalty is 0 for a healthy account
    expect(r.signals.every((s) => s.points === 0)).toBe(true);
  });

  test('GREEN: a mild single penalty (slightly stale) still bands green', () => {
    // 31 days stale => −10 => 90, well above GREEN_MIN (70)
    const r = scoreAccount({ daysSinceLastTouch: 31 });
    expect(r.score).toBe(90);
    expect(r.band).toBe('green');
    const recency = r.signals.find((s) => s.key === 'recency');
    expect(recency.points).toBe(-10);
  });

  test('YELLOW: stacked moderate signals land in the 40–69 range', () => {
    // recency >60 (−20) + one red issue (−10) + renewal <90 (−5) = 100−35 = 65
    const r = scoreAccount({
      daysSinceLastTouch: 75,
      openRedIssues: 1,
      daysToNextRenewal: 80,
    });
    expect(r.score).toBe(65);
    expect(r.band).toBe('yellow');
  });

  test('YELLOW: score exactly at the lower boundary (40) bands yellow', () => {
    // recency >90 (−30) + 2 blocking issues capped (−30) = 40
    const r = scoreAccount({ daysSinceLastTouch: 120, openBlockingIssues: 2 });
    expect(r.score).toBe(40);
    expect(r.band).toBe('yellow');
  });

  test('RED: never-touched account with blocking + red issues drops below 40', () => {
    const r = scoreAccount({
      daysSinceLastTouch: null,        // −30 (never)
      openBlockingIssues: 1,           // −15
      openRedIssues: 2,                // −20
      daysToNextRenewal: 10,           // −15
      atRiskOpenDeals: 1,              // −12
      emailsSent30d: 5,
      emailsOpened30d: 0,              // −10
    });
    expect(r.band).toBe('red');
    expect(r.score).toBeLessThan(YELLOW_MIN);
    // breakdown surfaces the "never touched" penalty explicitly
    const recency = r.signals.find((s) => s.key === 'recency');
    expect(recency.points).toBe(-30);
  });

  test('RED: score is clamped to 0, never negative', () => {
    const r = scoreAccount({
      daysSinceLastTouch: 365,
      openBlockingIssues: 10,
      openRedIssues: 10,
      daysToNextRenewal: 1,
      atRiskOpenDeals: 10,
      emailsSent30d: 9,
      emailsOpened30d: 0,
    });
    expect(r.score).toBe(0);
    expect(r.band).toBe('red');
  });

  test('handles an empty signals bag gracefully (treats as never-touched)', () => {
    const r = scoreAccount({});
    // only the recency "never" penalty applies => 70 => green boundary
    expect(r.score).toBe(70);
    expect(r.band).toBe('green');
  });

  test('bandFor honors the documented thresholds', () => {
    expect(bandFor(GREEN_MIN)).toBe('green');
    expect(bandFor(GREEN_MIN - 1)).toBe('yellow');
    expect(bandFor(YELLOW_MIN)).toBe('yellow');
    expect(bandFor(YELLOW_MIN - 1)).toBe('red');
  });
});
