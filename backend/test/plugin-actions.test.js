// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Confirm-first plugin apply layer — validateProposal + applyProposal unit tests.
//
// The plugin analogue of chatActions.test.js. validateProposal is pure (no DB);
// applyProposal takes an open pg client, so we pass a mock and assert the SQL it
// builds is org-scoped and only ever touches allowlisted columns. We null out
// the real pool (pluginActions -> pluginSdk -> ../db) so nothing reaches a DB.

// describe / test / expect / vi are vitest globals.

const realPool = require('../db');
realPool.query = vi.fn();
realPool.connect = vi.fn();

const pluginActions = require('../services/pluginActions');

function mockClient(returnRow = { id: 99 }) {
  return {
    calls: [],
    query: vi.fn(function (sql, params) {
      this.calls.push([sql, params]);
      return Promise.resolve({ rows: returnRow ? [returnRow] : [] });
    }),
  };
}

const SCOPE = { orgId: 7, userId: 4242 };

describe('validateProposal', () => {
  test('drops fields outside the plugin update allowlist, keeps allowlisted ones', () => {
    const v = pluginActions.validateProposal({
      entity: 'deal', op: 'update', table: 'deals', target_id: 5,
      fields: { stage: 'QUALIFIED', probability: 40, bogus: 'x', org_id: 999 },
    });
    expect(v.ok).toBe(true);
    // stage + probability are in pluginSdk UPDATE_ALLOWLISTS.deals; bogus/org_id are not.
    expect(Object.keys(v.action.fields).sort()).toEqual(['probability', 'stage']);
    expect(v.action.fields.org_id).toBeUndefined();
  });

  test('rejects an update whose fields are ALL disallowed', () => {
    const v = pluginActions.validateProposal({
      entity: 'deal', op: 'update', target_id: 5, fields: { bogus: 'x', org_id: 1 },
    });
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/No allowed fields|allowlist|Allowed for/i);
  });

  test('requires a positive integer target_id on update', () => {
    const v = pluginActions.validateProposal({
      entity: 'deal', op: 'update', fields: { stage: 'QUALIFIED' },
    });
    expect(v.ok).toBe(false);
    expect(v.errors.some(e => /target_id/.test(e))).toBe(true);
  });

  test('rejects an entity/table mismatch (tampered proposal)', () => {
    const v = pluginActions.validateProposal({
      entity: 'deal', op: 'update', table: 'tasks', target_id: 5, fields: { stage: 'X' },
    });
    expect(v.ok).toBe(false);
    expect(v.errors.some(e => /mismatch/i.test(e))).toBe(true);
  });

  test('rejects an unknown entity', () => {
    const v = pluginActions.validateProposal({ entity: 'users', op: 'update', target_id: 1, fields: { role: 'admin' } });
    expect(v.ok).toBe(false);
    expect(v.errors.some(e => /unknown or unsupported entity/i.test(e))).toBe(true);
  });

  test('create is only supported for tasks', () => {
    const deal = pluginActions.validateProposal({ entity: 'deal', op: 'create', fields: { title: 'x' } });
    expect(deal.ok).toBe(false);

    const task = pluginActions.validateProposal({ entity: 'task', op: 'create', fields: { title: 'Call Beta', priority: 'high' } });
    expect(task.ok).toBe(true);
    expect(task.action).toMatchObject({ entity: 'task', op: 'create', table: 'tasks' });
    expect(task.action.fields.title).toBe('Call Beta');
  });

  test('task create requires a title', () => {
    const v = pluginActions.validateProposal({ entity: 'task', op: 'create', fields: {} });
    expect(v.ok).toBe(false);
    expect(v.errors.some(e => /title is required/i.test(e))).toBe(true);
  });

  test('rejects an unsupported op', () => {
    const v = pluginActions.validateProposal({ entity: 'deal', op: 'delete', target_id: 1, fields: {} });
    expect(v.ok).toBe(false);
    expect(v.errors.some(e => /unsupported op/i.test(e))).toBe(true);
  });
});

describe('referencedIds', () => {
  test('collects task contact_id / deal_id refs', () => {
    const v = pluginActions.validateProposal({
      entity: 'task', op: 'create', fields: { title: 'x', deal_id: 12, contact_id: 8 },
    });
    const refs = pluginActions.referencedIds(v.action);
    expect(refs).toEqual([
      { field: 'contact_id', table: 'contacts', id: 8 },
      { field: 'deal_id', table: 'deals', id: 12 },
    ]);
  });

  test('no refs for a plain deal update', () => {
    const v = pluginActions.validateProposal({ entity: 'deal', op: 'update', target_id: 5, fields: { stage: 'X' } });
    expect(pluginActions.referencedIds(v.action)).toEqual([]);
  });
});

describe('applyProposal SQL is org-scoped and allowlist-only', () => {
  test('UPDATE binds target + org scope and never sets a non-allowlisted column', async () => {
    const v = pluginActions.validateProposal({
      entity: 'deal', op: 'update', target_id: 5, fields: { stage: 'QUALIFIED', amount: 2000, bogus: 'x' },
    });
    const client = mockClient({ id: 5, stage: 'QUALIFIED' });
    await pluginActions.applyProposal(client, v.action, SCOPE);

    const [sql, params] = client.calls[0];
    expect(sql).toMatch(/UPDATE deals SET/);
    // Org-scoped WHERE — a cross-org id can never be written.
    expect(sql).toMatch(/WHERE id = \$\d+ AND org_id = \$\d+/);
    expect(params).toContain(5);   // target_id
    expect(params).toContain(7);   // orgId scope
    expect(sql).toMatch(/stage = \$/);
    expect(sql).toMatch(/amount = \$/);
    expect(sql).not.toMatch(/bogus/);
    expect(sql).not.toMatch(/org_id = \$\d+,/); // org_id is scope, never a SET target
  });

  test('INSERT task binds org_id + user_id from scope, not the payload', async () => {
    const v = pluginActions.validateProposal({
      entity: 'task', op: 'create', fields: { title: 'Call Beta', priority: 'high', deal_id: 3 },
    });
    const client = mockClient({ id: 77, title: 'Call Beta' });
    await pluginActions.applyProposal(client, v.action, SCOPE);

    const [sql, params] = client.calls[0];
    expect(sql).toMatch(/INSERT INTO tasks/);
    expect(params[0]).toBe(7);    // orgId (scope)
    expect(params[1]).toBe(4242); // userId (scope)
    expect(params).toContain('Call Beta');
    expect(params).toContain(3);  // deal_id
  });

  test('returns null when the org-scoped UPDATE matches nothing (cross-org / deleted)', async () => {
    const v = pluginActions.validateProposal({ entity: 'deal', op: 'update', target_id: 999, fields: { stage: 'X' } });
    const client = mockClient(null); // no row returned
    const row = await pluginActions.applyProposal(client, v.action, SCOPE);
    expect(row).toBeNull();
  });
});
