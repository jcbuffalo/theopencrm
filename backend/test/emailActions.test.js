// One-click actions from notification emails (spec 204, migration 173).
// Pool is patched in place (see auth.test.js); every query is routed by a
// regex on the SQL so the assertions are about WHAT was written, not the
// call order.
const realPool = require('../db');
const mockPool = realPool;
mockPool.query = vi.fn();
mockPool.connect = vi.fn();

const emailActions = require('../services/emailActions');

// A tiny in-memory token store so mint → apply round-trips.
function tokenStore(rowFields = {}) {
  const rows = [];
  mockPool.query.mockImplementation(async (sql, params) => {
    const s = String(sql);
    if (/INSERT INTO email_action_tokens/i.test(s)) {
      rows.push({
        id: rows.length + 1, org_id: params[0], user_id: params[1], token_hash: params[2], action: params[3],
        entity_type: params[4], entity_id: params[5], params: JSON.parse(params[6]),
        expires_at: new Date(Date.now() + params[7]), used_at: null, user_status: 'active', ...rowFields,
      });
      return { rows: [] };
    }
    if (/FROM email_action_tokens t/i.test(s)) {
      const hit = rows.find((r) => r.token_hash === params[0]);
      return { rows: hit ? [hit] : [] };
    }
    if (/UPDATE email_action_tokens SET used_at = NOW\(\)/i.test(s)) {
      const hit = rows.find((r) => r.id === params[0] && !r.used_at);
      if (hit) { hit.used_at = new Date(); return { rows: [{ id: hit.id }] }; }
      return { rows: [] };
    }
    if (/UPDATE email_action_tokens SET used_at = NULL/i.test(s)) {
      const hit = rows.find((r) => r.id === params[0]);
      if (hit) hit.used_at = null;
      return { rows: [] };
    }
    return store.handler ? store.handler(s, params) : { rows: [] };
  });
  const store = { rows, handler: null };
  return store;
}

beforeEach(() => { mockPool.query.mockReset(); });

describe('emailActions.mint', () => {
  test('stores only the sha256 of a 64-hex token, scoped to org+user, with a 7-day expiry and an /act/ url', async () => {
    const store = tokenStore();
    const { token, url } = await emailActions.mint({ orgId: 5, userId: 9, action: 'task.complete', entityId: 12 });
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(url).toBe(`${emailActions.PUBLIC_BASE_URL}/act/${token}`);
    expect(store.rows[0].token_hash).toBe(emailActions._hash(token));
    expect(store.rows[0].token_hash).not.toBe(token);
    expect(store.rows[0]).toMatchObject({ org_id: 5, user_id: 9, action: 'task.complete', entity_type: 'task', entity_id: 12 });
    expect(store.rows[0].expires_at.getTime() - Date.now()).toBeGreaterThan(6.9 * 24 * 3600 * 1000);
  });

  test('refuses unknown actions', async () => {
    await expect(emailActions.mint({ userId: 1, action: 'user.delete', entityId: 1 })).rejects.toThrow(/unknown action/);
  });
});

describe('emailActions.apply', () => {
  test('task.complete: org-scoped UPDATE to done, single-use, second click is 410', async () => {
    const store = tokenStore();
    const writes = [];
    store.handler = (s, params) => {
      if (/SELECT status FROM tasks/i.test(s)) { writes.push(['select', params]); return { rows: [{ status: 'open' }] }; }
      if (/UPDATE tasks SET status = 'done'/i.test(s)) { writes.push(['update', params]); return { rows: [{ id: params[0], title: 'Call Dana', status: 'done', recurrence_rule: null }] }; }
      return { rows: [] };
    };
    const { token } = await emailActions.mint({ orgId: 5, userId: 9, action: 'task.complete', entityId: 12 });

    const first = await emailActions.apply(token);
    expect(first.ok).toBe(true);
    expect(first.message).toMatch(/Call Dana.*marked done/);
    // Scope came from the token row, not from any request input.
    expect(writes.find((w) => w[0] === 'update')[1]).toEqual([12, 5]);
    expect(String(mockPool.query.mock.calls.find((c) => /UPDATE tasks SET status/.test(String(c[0])))[0])).toMatch(/org_id = \$2/);

    const second = await emailActions.apply(token);
    expect(second.ok).toBe(false);
    expect(second.status).toBe(410);
    expect(second.used).toBe(true);
  });

  test('org-less user scopes on user_id', async () => {
    const store = tokenStore();
    let scopeSql = null;
    store.handler = (s, params) => {
      if (/SELECT status FROM tasks/i.test(s)) return { rows: [{ status: 'open' }] };
      if (/UPDATE tasks SET status = 'done'/i.test(s)) { scopeSql = [s, params]; return { rows: [{ id: 3, title: 'x' }] }; }
      return { rows: [] };
    };
    const { token } = await emailActions.mint({ orgId: null, userId: 9, action: 'task.complete', entityId: 3 });
    await emailActions.apply(token);
    expect(scopeSql[0]).toMatch(/user_id = \$2/);
    expect(scopeSql[1]).toEqual([3, 9]);
  });

  test('task.snooze pushes an overdue due_date to tomorrow (GREATEST of today/due) and clamps days to 1..30', async () => {
    const store = tokenStore();
    let params = null;
    store.handler = (s, p) => {
      if (/UPDATE tasks/i.test(s) && /due_date/.test(s)) { params = p; return { rows: [{ id: 12, title: 'T', due_date: '2026-09-22' }] }; }
      return { rows: [] };
    };
    const { token } = await emailActions.mint({ orgId: 5, userId: 9, action: 'task.snooze', entityId: 12, params: { days: 99 } });
    const out = await emailActions.apply(token);
    expect(out.ok).toBe(true);
    expect(params).toEqual([12, 5, 30]);
    const sql = String(mockPool.query.mock.calls.find((c) => /UPDATE tasks/.test(String(c[0])) && /due_date/.test(String(c[0])))[0]);
    expect(sql).toMatch(/GREATEST\(COALESCE\(due_date::date, CURRENT_DATE\), CURRENT_DATE\)/);
    expect(sql).toMatch(/status <> 'done'/);
  });

  test('deal.next_step.complete clears both columns; company.touch stamps last_touch_at', async () => {
    const store = tokenStore();
    const seen = [];
    store.handler = (s, p) => {
      seen.push(s);
      if (/UPDATE deals SET next_step = NULL, next_step_date = NULL/i.test(s)) return { rows: [{ id: 7, title: 'Acme roof' }] };
      if (/UPDATE companies SET last_touch_at = NOW\(\)/i.test(s)) return { rows: [{ id: 4, name: 'Acme' }] };
      return { rows: [] };
    };
    const a = await emailActions.mint({ orgId: 5, userId: 9, action: 'deal.next_step.complete', entityId: 7 });
    const b = await emailActions.mint({ orgId: 5, userId: 9, action: 'company.touch', entityId: 4 });
    expect((await emailActions.apply(a.token)).message).toMatch(/Acme roof/);
    expect((await emailActions.apply(b.token)).message).toMatch(/Logged a touch on Acme/);
    expect(seen.some((s) => /UPDATE deals SET next_step = NULL/.test(s) && /org_id = \$2/.test(s))).toBe(true);
    expect(seen.some((s) => /UPDATE companies SET last_touch_at/.test(s) && /org_id = \$2/.test(s))).toBe(true);
  });

  test('expired, unknown, malformed and inactive-user tokens are rejected without touching data', async () => {
    const store = tokenStore();
    let touched = false;
    store.handler = (s) => { if (/UPDATE (tasks|deals|companies)/i.test(s)) touched = true; return { rows: [] }; };
    expect((await emailActions.apply('not-a-token')).status).toBe(404);
    expect((await emailActions.apply('f'.repeat(64))).status).toBe(404);
    const { token } = await emailActions.mint({ orgId: 5, userId: 9, action: 'task.complete', entityId: 1, ttlMs: -1000 });
    const exp = await emailActions.apply(token);
    expect(exp.status).toBe(410);
    expect(exp.expired).toBe(true);
    store.rows.length = 0;
    const inactive = tokenStore({ user_status: 'suspended' });
    inactive.handler = store.handler;
    const t2 = await emailActions.mint({ orgId: 5, userId: 9, action: 'task.complete', entityId: 1 });
    expect((await emailActions.apply(t2.token)).status).toBe(403);
    expect(touched).toBe(false);
  });

  test('a missing target (404 from the handler) consumes the token; an unexpected error gives it back', async () => {
    const store = tokenStore();
    store.handler = (s) => {
      if (/SELECT status FROM tasks/i.test(s)) return { rows: [] }; // gone
      return { rows: [] };
    };
    const { token } = await emailActions.mint({ orgId: 5, userId: 9, action: 'task.complete', entityId: 1 });
    const out = await emailActions.apply(token);
    expect(out.status).toBe(404);
    expect(store.rows[0].used_at).not.toBeNull();

    store.rows.length = 0;
    store.handler = (s) => { if (/SELECT status FROM tasks/i.test(s)) throw new Error('connection reset'); return { rows: [] }; };
    const { token: t2 } = await emailActions.mint({ orgId: 5, userId: 9, action: 'task.complete', entityId: 1 });
    const out2 = await emailActions.apply(t2);
    expect(out2.status).toBe(500);
    expect(store.rows[0].used_at).toBeNull(); // retryable from the same email
  });

  test('describe never mutates', async () => {
    const store = tokenStore();
    const { token } = await emailActions.mint({ orgId: 5, userId: 9, action: 'task.snooze', entityId: 12 });
    const d = await emailActions.describe(token);
    expect(d).toMatchObject({ ok: true, action: 'task.snooze', label: 'Snooze a day', entity_type: 'task', entity_id: 12 });
    expect(store.rows[0].used_at).toBeNull();
  });
});
