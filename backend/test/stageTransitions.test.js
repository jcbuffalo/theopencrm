// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Stage-transition guard — case-correctness tests.
//
// Regression coverage for the silent no-op bug fixed in this PR: the
// GENERIC graph used to be keyed by uppercase names ('LEAD',
// 'QUALIFIED', …) while every DB-write path stores generic stages in
// lowercase ('lead', 'qualified', …). That made `check('generic',
// deal.stage, …)` always return `unknown_from_stage:lead` and the
// guard a no-op under the default warn-only mode. These tests assert
// the guard now actually says yes/no to canonical lowercase stages.

// describe / test / expect are global (vitest).

const stageTransitions = require('../services/stageTransitions');

describe('stageTransitions.check — generic profile (lowercase)', () => {
  test('happy path: lead → qualified is allowed', () => {
    const r = stageTransitions.check('generic', 'lead', 'qualified');
    expect(r.allowed).toBe(true);
  });

  test('every documented generic transition is allowed', () => {
    const happyPaths = [
      ['lead',        'qualified'],
      ['lead',        'closed_lost'],
      ['qualified',   'proposal'],
      ['qualified',   'closed_lost'],
      ['proposal',    'negotiation'],
      ['proposal',    'closed_won'],
      ['proposal',    'closed_lost'],
      ['negotiation', 'closed_won'],
      ['negotiation', 'closed_lost'],
    ];
    for (const [from, to] of happyPaths) {
      const r = stageTransitions.check('generic', from, to);
      expect(r.allowed, `expected ${from} → ${to} to be allowed`).toBe(true);
    }
  });

  test('lead → negotiation is NOT allowed (must go through qualified/proposal)', () => {
    const r = stageTransitions.check('generic', 'lead', 'negotiation');
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/not_in_graph/);
    expect(r.validNextStages).toEqual(['qualified', 'closed_lost']);
  });

  test('terminal stages have no outbound transitions', () => {
    const won  = stageTransitions.check('generic', 'closed_won',  'lead');
    const lost = stageTransitions.check('generic', 'closed_lost', 'lead');
    expect(won.allowed).toBe(false);
    expect(lost.allowed).toBe(false);
  });

  test('uppercase generic stage names are NOT recognized (would have been the bug)', () => {
    // Sanity check that we didn't accidentally accept both cases — the
    // canonical case is lowercase. Passing uppercase here returns
    // unknown_from_stage, which is the original silent-no-op we just
    // fixed; the only legitimate caller is now Zang.
    const r = stageTransitions.check('generic', 'LEAD', 'QUALIFIED');
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/unknown_from_stage:LEAD/);
  });
});

describe('stageTransitions.check — zang profile (uppercase, unchanged)', () => {
  test('TRIAGE → VENDOR_QUOTING is allowed', () => {
    const r = stageTransitions.check('zang', 'TRIAGE', 'VENDOR_QUOTING');
    expect(r.allowed).toBe(true);
  });

  test('TRIAGE → INVOICED is NOT allowed (skips post-sale stages)', () => {
    const r = stageTransitions.check('zang', 'TRIAGE', 'INVOICED');
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/not_in_graph/);
  });
});

describe('stageTransitions.check — edge cases', () => {
  test('unknown profile short-circuits to allowed', () => {
    const r = stageTransitions.check('no_such_profile', 'lead', 'qualified');
    expect(r.allowed).toBe(true);
    expect(r.reason).toMatch(/unknown_profile/);
  });

  test('same from === to is allowed (idempotent)', () => {
    const r = stageTransitions.check('generic', 'qualified', 'qualified');
    expect(r.allowed).toBe(true);
  });

  test('missing fromStage (initial assignment) is allowed', () => {
    const r = stageTransitions.check('generic', null, 'lead');
    expect(r.allowed).toBe(true);
  });
});
