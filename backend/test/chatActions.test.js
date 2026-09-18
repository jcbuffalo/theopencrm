// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Spec 200 — chatActions validator + applyAction unit tests.
//
// validateAction is pure (no DB). applyAction takes an open pg client; we pass
// a mock so we can assert the exact SQL it builds is org-scoped and only ever
// touches allowlisted columns. We still null out the real pool's query/connect
// (chatActions pulls in featureFlags which requires ../db) so nothing reaches a
// real database.

// describe / test / expect / vi are vitest globals.

const realPool = require('../db');
realPool.query = vi.fn();
realPool.connect = vi.fn();

const chatActions = require('../services/chatActions');

// A mock pg client whose query() records calls and returns a single row.
function mockClient(returnRow = { id: 99 }) {
  return {
    calls: [],
    query: vi.fn(function (sql, params) {
      this.calls.push([sql, params]);
      return Promise.resolve({ rows: returnRow ? [returnRow] : [] });
    }),
  };
}

const SCOPE = { sf: 'org_id', sv: 7, userId: 4242, orgId: 7 };

describe('validateAction', () => {
  test('drops unknown / non-allowlisted fields and keeps allowlisted ones', () => {
    const v = chatActions.validateAction({
      entity: 'deal', op: 'update', target_id: 5,
      fields: { stage: 'NEGOTIATION', bogus: 'x', user_id: 1 },
    });
    expect(v.ok).toBe(false); // unknown fields raise an error (not silently dropped)
    expect(v.errors.some((e) => /bogus/.test(e))).toBe(true);
    expect(v.errors.some((e) => /user_id/.test(e))).toBe(true);
  });

  test('keeps only allowlisted fields when the rest are valid', () => {
    const v = chatActions.validateAction({
      entity: 'deal', op: 'update', target_id: 5,
      fields: { stage: 'NEGOTIATION', amount: 1000 },
    });
    expect(v.ok).toBe(true);
    expect(Object.keys(v.action.fields).sort()).toEqual(['amount', 'stage']);
  });

  test('enforces required fields', () => {
    const v = chatActions.validateAction({ entity: 'task', op: 'create', fields: {} });
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => /title.*required/.test(e))).toBe(true);
  });

  test('rejects bad enum values', () => {
    const v = chatActions.validateAction({
      entity: 'activity', op: 'create', fields: { type: 'carrier-pigeon' },
    });
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => /type.*invalid value/.test(e))).toBe(true);
  });

  test('update requires a target_id and at least one field', () => {
    const noTarget = chatActions.validateAction({ entity: 'contact', op: 'update', fields: { first_name: 'A' } });
    expect(noTarget.ok).toBe(false);
    expect(noTarget.errors.some((e) => /target_id/.test(e))).toBe(true);

    const noFields = chatActions.validateAction({ entity: 'contact', op: 'update', target_id: 3, fields: {} });
    expect(noFields.ok).toBe(false);
    expect(noFields.errors.some((e) => /at least one field/.test(e))).toBe(true);
  });

  test('feature_flag.set rejects an unknown / non-toggleable flag', () => {
    const unknown = chatActions.validateAction({
      entity: 'feature_flag', op: 'set', fields: { flag: 'not_a_real_flag', enabled: true },
    });
    expect(unknown.ok).toBe(false);

    // phase2_entities is a 'platform' flag — deliberately excluded from the
    // toggleable set — so it must be rejected too.
    const platform = chatActions.validateAction({
      entity: 'feature_flag', op: 'set', fields: { flag: 'phase2_entities', enabled: true },
    });
    expect(platform.ok).toBe(false);

    // reports_enabled is a 'module' flag — allowed.
    const ok = chatActions.validateAction({
      entity: 'feature_flag', op: 'set', fields: { flag: 'reports_enabled', enabled: true },
    });
    expect(ok.ok).toBe(true);
  });

  test('produces a human summary', () => {
    const v = chatActions.validateAction({
      entity: 'deal', op: 'update', target_id: 5, fields: { stage: 'NEGOTIATION' },
    });
    expect(typeof v.action.summary).toBe('string');
    expect(v.action.summary.length).toBeGreaterThan(0);
  });
});

describe('referencedIds', () => {
  test('collects only the *_id refs actually present', () => {
    const v = chatActions.validateAction({
      entity: 'task', op: 'create', fields: { title: 'Call Beta', deal_id: 12 },
    });
    const refs = chatActions.referencedIds(v.action);
    expect(refs).toEqual([{ field: 'deal_id', table: 'deals', id: 12 }]);
  });
});

describe('applyAction SQL is org-scoped and allowlist-only', () => {
  test('UPDATE binds target + scope and never sets a non-allowlisted column', async () => {
    const v = chatActions.validateAction({
      entity: 'deal', op: 'update', target_id: 5, fields: { stage: 'NEGOTIATION', amount: 2000 },
    });
    const client = mockClient({ id: 5, stage: 'NEGOTIATION' });
    await chatActions.applyAction(client, v.action, SCOPE);

    const [sql, params] = client.calls[0];
    expect(sql).toMatch(/UPDATE deals SET/);
    // Org-scoped WHERE: id = $N AND org_id = $M
    expect(sql).toMatch(/WHERE id = \$\d+ AND org_id = \$\d+/);
    // The target id and the scope value are both bound.
    expect(params).toContain(5);   // target_id
    expect(params).toContain(7);   // scope value (sv)
    // Only allowlisted columns are set — no user_id / bogus columns.
    expect(sql).toMatch(/stage = \$/);
    expect(sql).toMatch(/amount = \$/);
    expect(sql).not.toMatch(/user_id\s*=/);
    expect(sql).not.toMatch(/bogus/);
  });

  test('INSERT (create) binds user_id + org_id and lists only allowlisted columns', async () => {
    const v = chatActions.validateAction({
      entity: 'task', op: 'create', fields: { title: 'Call Beta', priority: 'high' },
    });
    const client = mockClient({ id: 77, title: 'Call Beta' });
    await chatActions.applyAction(client, v.action, SCOPE);

    const [sql, params] = client.calls[0];
    expect(sql).toMatch(/INSERT INTO tasks/);
    expect(sql).toMatch(/user_id/);
    expect(sql).toMatch(/org_id/);
    expect(sql).toMatch(/title/);
    expect(sql).toMatch(/priority/);
    expect(params).toContain(4242); // userId
    expect(params).toContain(7);    // orgId
    expect(params).toContain('Call Beta');
    expect(sql).not.toMatch(/bogus/);
  });

  test('deal update with append_note concatenates onto notes (does not overwrite)', async () => {
    const v = chatActions.validateAction({
      entity: 'deal', op: 'update', target_id: 5, fields: { append_note: 'Left a voicemail' },
    });
    const client = mockClient({ id: 5 });
    await chatActions.applyAction(client, v.action, SCOPE);

    const [sql, params] = client.calls[0];
    expect(sql).toMatch(/notes = COALESCE\(notes/);
    expect(sql).toMatch(/WHERE id = \$\d+ AND org_id = \$\d+/);
    expect(params).toContain('Left a voicemail');
    expect(params).toContain(5);
    expect(params).toContain(7);
  });
});
