// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Drive Intel — writeback service tests.
//
// Covers the three things that matter:
//   1. Allowlist validator rejects every non-whitelisted field name
//      (amount / user_id / org_id / custom_fields.* / ai_* etc.) and
//      accepts the three approved fields.
//   2. applySuggestion's stale-data check returns a 409 STALE_DATA path
//      when the live deal value diverges from the snapshot.
//   3. undoWriteback refuses past the 7-day window with UNDO_WINDOW_EXPIRED.
//
// We avoid hitting real Claude by overwriting services/ai's exports
// in-place — same pattern as test/intelSummary.test.js.

// describe / test / expect / beforeEach / vi are global (vitest).

const realPool = require('../db');
const mockPool = realPool;
mockPool.query   = vi.fn();
mockPool.connect = vi.fn();

vi.mock('../services/logger', () => ({
  info:   vi.fn(),
  warn:   vi.fn(),
  error:  vi.fn(),
  notice: vi.fn(),
  debug:  vi.fn(),
}));

const ai = require('../services/ai');
ai.isConfigured = vi.fn(() => true);
ai.callClaude   = vi.fn();

const intelWriteback = require('../services/intelWriteback');

beforeEach(() => {
  mockPool.query.mockReset();
  mockPool.connect.mockReset();
  ai.callClaude.mockReset();
});

// ---------------------------------------------------------------------------
// 1. ALLOWLIST — isFieldAllowed + validateProposed
// ---------------------------------------------------------------------------

describe('intelWriteback.isFieldAllowed', () => {
  test('accepts the three whitelisted fields', () => {
    expect(intelWriteback.isFieldAllowed('stage')).toBe(true);
    expect(intelWriteback.isFieldAllowed('notes')).toBe(true);
    expect(intelWriteback.isFieldAllowed('expected_close_date')).toBe(true);
  });

  test('rejects every blocklisted column', () => {
    expect(intelWriteback.isFieldAllowed('amount')).toBe(false);
    expect(intelWriteback.isFieldAllowed('owner_user_id')).toBe(false);
    expect(intelWriteback.isFieldAllowed('user_id')).toBe(false);
    expect(intelWriteback.isFieldAllowed('org_id')).toBe(false);
    expect(intelWriteback.isFieldAllowed('customer_id')).toBe(false);
  });

  test('rejects ai_* columns (regex blocklist)', () => {
    expect(intelWriteback.isFieldAllowed('ai_win_probability')).toBe(false);
    expect(intelWriteback.isFieldAllowed('ai_summary')).toBe(false);
    expect(intelWriteback.isFieldAllowed('AI_anything')).toBe(false);
  });

  test('rejects custom_fields.* paths', () => {
    expect(intelWriteback.isFieldAllowed('custom_fields')).toBe(false);
    expect(intelWriteback.isFieldAllowed('custom_fields.foo')).toBe(false);
    expect(intelWriteback.isFieldAllowed('custom_fields.deeply.nested')).toBe(false);
  });

  test('rejects arbitrary off-allowlist names', () => {
    expect(intelWriteback.isFieldAllowed('title')).toBe(false);
    expect(intelWriteback.isFieldAllowed('po_number')).toBe(false);
    expect(intelWriteback.isFieldAllowed('')).toBe(false);
    expect(intelWriteback.isFieldAllowed(null)).toBe(false);
    expect(intelWriteback.isFieldAllowed(undefined)).toBe(false);
    expect(intelWriteback.isFieldAllowed(42)).toBe(false);
  });
});

describe('intelWriteback.validateProposed', () => {
  // Use a profile of 'no_such_profile' so the stage-transition guard
  // short-circuits to allowed:true regardless of from/to — we want this
  // suite to focus on the writeback validator's own logic, not on the
  // transition graph (the transition graph has its own focused test below).
  const ctx = { profile: 'no_such_profile', currentStage: 'TRIAGE', now: Date.parse('2026-06-15') };

  test('stage: accepts a value in VALID_STAGES under a permissive profile', () => {
    const v = intelWriteback.validateProposed('stage', 'qualified', ctx);
    expect(v.ok).toBe(true);
    expect(v.value).toBe('qualified');
  });

  test('stage: enforces transition graph when profile is known', () => {
    // Generic stages are lowercase in VALID_STAGES + the stageTransitions
    // GENERIC graph — see backend/utils/dealStages.js and the
    // intentional case-split with Zang (uppercase) in
    // backend/services/stageTransitions.js.
    const strictCtx = { profile: 'generic', currentStage: 'lead' };
    const ok = intelWriteback.validateProposed('stage', 'qualified', strictCtx);
    expect(ok.ok).toBe(true);
    // lead → SERVICE is not a legal generic transition (SERVICE is a Zang
    // post-ship stage that's in VALID_STAGES but not in the generic graph).
    const bad = intelWriteback.validateProposed('stage', 'SERVICE', strictCtx);
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/stage_transition_invalid/);
  });

  test('stage: rejects an unknown stage value', () => {
    const v = intelWriteback.validateProposed('stage', 'NOT_A_REAL_STAGE', ctx);
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/stage_not_in_valid_set/);
  });

  test('stage: rejects non-string values', () => {
    expect(intelWriteback.validateProposed('stage', null, ctx).ok).toBe(false);
    expect(intelWriteback.validateProposed('stage', 42, ctx).ok).toBe(false);
  });

  test('notes: accepts non-empty string and caps length at 4000', () => {
    const ok = intelWriteback.validateProposed('notes', 'Customer responded warmly', ctx);
    expect(ok.ok).toBe(true);
    expect(ok.value).toBe('Customer responded warmly');

    const huge = 'x'.repeat(10000);
    const clipped = intelWriteback.validateProposed('notes', huge, ctx);
    expect(clipped.ok).toBe(true);
    expect(clipped.value.length).toBe(4000);
  });

  test('notes: rejects empty / whitespace-only', () => {
    expect(intelWriteback.validateProposed('notes', '', ctx).ok).toBe(false);
    expect(intelWriteback.validateProposed('notes', '   ', ctx).ok).toBe(false);
    expect(intelWriteback.validateProposed('notes', null, ctx).ok).toBe(false);
  });

  test('expected_close_date: accepts ISO date within window', () => {
    const v = intelWriteback.validateProposed('expected_close_date', '2026-08-01', ctx);
    expect(v.ok).toBe(true);
  });

  test('expected_close_date: rejects dates outside the today-30d..today+5y window', () => {
    // 60 days in the past — outside the -30d floor.
    const past = intelWriteback.validateProposed('expected_close_date', '2026-04-01', ctx);
    expect(past.ok).toBe(false);
    expect(past.error).toMatch(/out_of_window/);
    // 7 years out — past the +5y ceiling.
    const farFuture = intelWriteback.validateProposed('expected_close_date', '2033-06-15', ctx);
    expect(farFuture.ok).toBe(false);
  });

  test('expected_close_date: rejects non-ISO formats', () => {
    expect(intelWriteback.validateProposed('expected_close_date', '08/01/2026', ctx).ok).toBe(false);
    expect(intelWriteback.validateProposed('expected_close_date', 'soon', ctx).ok).toBe(false);
  });

  test('rejects off-allowlist field even with a valid value shape', () => {
    expect(intelWriteback.validateProposed('amount', 100, ctx).ok).toBe(false);
    expect(intelWriteback.validateProposed('owner_user_id', 1, ctx).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. STALE-DATA 409 PATH — applySuggestion
// ---------------------------------------------------------------------------

describe('intelWriteback.applySuggestion — stale-data path', () => {
  test('throws STALE_DATA / 409 when live deal value diverges from snapshot', async () => {
    // Mock pool.connect() → a fake client that we drive deterministically.
    const queries = [];
    const fakeClient = {
      query: vi.fn(async (sql, params) => {
        queries.push({ sql, params });
        // Walk the script the apply function follows:
        //   1) BEGIN
        //   2) SELECT … FROM deal_intel_suggestions … FOR UPDATE
        //   3) SELECT … FROM deals … FOR UPDATE
        //   4) UPDATE deal_intel_suggestions SET status='stale' …
        //   5) COMMIT
        if (/^\s*BEGIN/i.test(sql))  return {};
        if (/FROM deal_intel_suggestions/i.test(sql) && /FOR UPDATE/i.test(sql)) {
          return {
            rows: [{
              id: 7, org_id: 1, deal_id: 10, summary_id: 99,
              field: 'stage',
              current_value: 'lead',         // snapshot
              proposed_value: 'qualified',
              confidence: 0.8, reason: 'because',
              status: 'pending',
            }],
          };
        }
        if (/FROM deals d/i.test(sql) && /FOR UPDATE/i.test(sql)) {
          return {
            rows: [{
              id: 10, stage: 'qualified',     // live value DIFFERS from snapshot
              notes: null, expected_close_date: null,
              profile: 'generic',
            }],
          };
        }
        if (/UPDATE deal_intel_suggestions/i.test(sql)) return { rows: [] };
        if (/^\s*COMMIT/i.test(sql)) return {};
        if (/^\s*ROLLBACK/i.test(sql)) return {};
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    mockPool.connect.mockResolvedValue(fakeClient);

    await expect(
      intelWriteback.applySuggestion({
        orgId: 1, dealId: 10, suggestionId: 7, userId: 3,
      })
    ).rejects.toMatchObject({ code: 'STALE_DATA', statusCode: 409 });

    // Verify the stale-status flip happened.
    const flipped = queries.find(q =>
      /UPDATE deal_intel_suggestions/i.test(q.sql) && /'stale'/i.test(q.sql)
    );
    expect(flipped).toBeTruthy();
  });

  test('happy path: applies a stage change and inserts a writeback row', async () => {
    const fakeClient = {
      query: vi.fn(async (sql) => {
        if (/^\s*BEGIN/i.test(sql))  return {};
        if (/FROM deal_intel_suggestions/i.test(sql) && /FOR UPDATE/i.test(sql)) {
          return {
            rows: [{
              id: 7, org_id: 1, deal_id: 10, summary_id: 99,
              field: 'stage',
              current_value: '"lead"',    // serialized JSONB
              proposed_value: '"qualified"',
              confidence: 0.8,
              status: 'pending',
            }],
          };
        }
        if (/FROM deals d/i.test(sql) && /FOR UPDATE/i.test(sql)) {
          return {
            rows: [{
              id: 10, stage: 'lead', notes: null,
              expected_close_date: null, profile: 'generic',
            }],
          };
        }
        if (/UPDATE deals/i.test(sql))                  return { rows: [{ id: 10 }] };
        if (/INSERT INTO deal_intel_writebacks/i.test(sql)) {
          return { rows: [{ id: 42, deal_id: 10, suggestion_id: 7, field: 'stage',
                            prior_value: '"lead"', new_value: '"qualified"',
                            applied_at: new Date(), applied_by_user_id: 3 }] };
        }
        if (/UPDATE deal_intel_suggestions/i.test(sql)) return { rows: [] };
        if (/^\s*COMMIT/i.test(sql))                    return {};
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    mockPool.connect.mockResolvedValue(fakeClient);

    const out = await intelWriteback.applySuggestion({
      orgId: 1, dealId: 10, suggestionId: 7, userId: 3,
    });
    expect(out.writeback.id).toBe(42);
    expect(out.writeback.field).toBe('stage');
  });
});

// ---------------------------------------------------------------------------
// 3. 7-DAY UNDO WINDOW — undoWriteback
// ---------------------------------------------------------------------------

describe('intelWriteback.undoWriteback — 7-day window', () => {
  test('UNDO_WINDOW_DAYS constant is 7', () => {
    expect(intelWriteback.UNDO_WINDOW_DAYS).toBe(7);
  });

  test('rejects with UNDO_WINDOW_EXPIRED when writeback is older than 7 days', async () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    const fakeClient = {
      query: vi.fn(async (sql) => {
        if (/^\s*BEGIN/i.test(sql)) return {};
        if (/FROM deal_intel_writebacks/i.test(sql) && /FOR UPDATE/i.test(sql)) {
          return {
            rows: [{
              id: 42, org_id: 1, deal_id: 10, suggestion_id: 7,
              field: 'stage',
              prior_value: '"lead"', new_value: '"qualified"',
              applied_at: eightDaysAgo, applied_by_user_id: 3,
              undone_at: null,
            }],
          };
        }
        if (/^\s*ROLLBACK/i.test(sql)) return {};
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    mockPool.connect.mockResolvedValue(fakeClient);

    await expect(
      intelWriteback.undoWriteback({ orgId: 1, dealId: 10, wbId: 42, userId: 3 })
    ).rejects.toMatchObject({ code: 'UNDO_WINDOW_EXPIRED', statusCode: 409 });
  });

  test('rejects with ALREADY_UNDONE when undone_at is set', async () => {
    const fakeClient = {
      query: vi.fn(async (sql) => {
        if (/^\s*BEGIN/i.test(sql)) return {};
        if (/FROM deal_intel_writebacks/i.test(sql) && /FOR UPDATE/i.test(sql)) {
          return {
            rows: [{
              id: 42, org_id: 1, deal_id: 10, suggestion_id: 7,
              field: 'stage',
              prior_value: '"lead"', new_value: '"qualified"',
              applied_at: new Date(), applied_by_user_id: 3,
              undone_at: new Date(),
            }],
          };
        }
        if (/^\s*ROLLBACK/i.test(sql)) return {};
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    mockPool.connect.mockResolvedValue(fakeClient);

    await expect(
      intelWriteback.undoWriteback({ orgId: 1, dealId: 10, wbId: 42 })
    ).rejects.toMatchObject({ code: 'ALREADY_UNDONE', statusCode: 409 });
  });

  test('happy path: restores prior_value and flips undone_at', async () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    let restoredStage = null;
    const fakeClient = {
      query: vi.fn(async (sql, params) => {
        if (/^\s*BEGIN/i.test(sql)) return {};
        if (/FROM deal_intel_writebacks/i.test(sql) && /FOR UPDATE/i.test(sql)) {
          return {
            rows: [{
              id: 42, org_id: 1, deal_id: 10, suggestion_id: 7,
              field: 'stage',
              prior_value: 'lead', new_value: 'qualified',
              applied_at: oneHourAgo, applied_by_user_id: 3,
              undone_at: null,
            }],
          };
        }
        if (/UPDATE deals SET stage/i.test(sql)) {
          restoredStage = params[0];
          return { rows: [] };
        }
        if (/UPDATE deal_intel_writebacks/i.test(sql)) {
          return {
            rows: [{
              id: 42, org_id: 1, deal_id: 10, suggestion_id: 7,
              field: 'stage', prior_value: 'lead', new_value: 'qualified',
              applied_at: oneHourAgo, applied_by_user_id: 3,
              undone_at: new Date(), undone_by_user_id: 5,
            }],
          };
        }
        if (/^\s*COMMIT/i.test(sql)) return {};
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    mockPool.connect.mockResolvedValue(fakeClient);

    const out = await intelWriteback.undoWriteback({ orgId: 1, dealId: 10, wbId: 42, userId: 5 });
    expect(out.writeback.undone_at).toBeTruthy();
    expect(restoredStage).toBe('lead');
  });
});

// ---------------------------------------------------------------------------
// 4. parseModelReply — defensive parsing (shape-consistent with intelSummary)
// ---------------------------------------------------------------------------

describe('intelWriteback.parseModelReply', () => {
  test('parses a clean JSON reply with suggestions', () => {
    const out = intelWriteback.parseModelReply(JSON.stringify({
      suggestions: [
        { field: 'stage', proposed_value: 'qualified', confidence: 0.7, reason: 'because' },
      ],
    }));
    expect(out.ok).toBe(true);
    expect(out.parsed.suggestions).toHaveLength(1);
  });

  test('strips ```json code fences', () => {
    const out = intelWriteback.parseModelReply('```json\n{"suggestions":[]}\n```');
    expect(out.ok).toBe(true);
  });

  test('returns ok=false on empty / malformed input', () => {
    expect(intelWriteback.parseModelReply('').ok).toBe(false);
    expect(intelWriteback.parseModelReply('no json here').ok).toBe(false);
    expect(intelWriteback.parseModelReply('{not valid').ok).toBe(false);
  });

  test('rejects when suggestions is not an array', () => {
    const out = intelWriteback.parseModelReply(JSON.stringify({ suggestions: 'nope' }));
    expect(out.ok).toBe(false);
  });
});
