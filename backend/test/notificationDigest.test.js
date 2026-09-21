// Consolidated notification email (spec 204, migration 173).
process.env.DEFAULT_EMAIL_DELIVERY_MODE = 'daily';
process.env.DEFAULT_TIMEZONE = 'America/New_York';

const realPool = require('../db');
const mockPool = realPool;
mockPool.query = vi.fn();
mockPool.connect = vi.fn();

const emailModule = require('../services/email');
const sendMail = vi.fn().mockResolvedValue({ ok: true, kind: 'console' });
emailModule.sendMail = sendMail;

vi.mock('../services/logger', () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), notice: vi.fn(), debug: vi.fn() }));

const digest = require('../services/notificationDigest');
const dispatcher = require('../services/notificationDispatcher');

// mint stub: deterministic urls, no DB.
const fakeMint = vi.fn(async ({ action, entityId }) => ({ token: 'x', url: `https://app.test/act/${action}/${entityId}` }));

beforeEach(() => {
  mockPool.query.mockReset();
  sendMail.mockReset();
  sendMail.mockResolvedValue({ ok: true, kind: 'console' });
  fakeMint.mockClear();
});

describe('deliveryPref', () => {
  test('defaults to daily at 07:00 in DEFAULT_TIMEZONE; honours a valid pref; rejects junk', () => {
    expect(digest.deliveryPref({})).toEqual({ mode: 'daily', hour: 7, tz: 'America/New_York' });
    expect(digest.deliveryPref(null)).toEqual({ mode: 'daily', hour: 7, tz: 'America/New_York' });
    expect(digest.deliveryPref({ email_delivery: { mode: 'batched', hour: 18, tz: 'Europe/Berlin' } }))
      .toEqual({ mode: 'batched', hour: 18, tz: 'Europe/Berlin' });
    expect(digest.deliveryPref({ email_delivery: { mode: 'weekly', hour: 99, tz: 'Mars/Olympus' } }))
      .toEqual({ mode: 'daily', hour: 7, tz: 'America/New_York' });
  });

  test('anyEmailCategoryOn ignores the email_delivery key itself', () => {
    expect(digest.anyEmailCategoryOn({ email_delivery: { mode: 'daily' } })).toBe(false);
    expect(digest.anyEmailCategoryOn({ email_delivery: { mode: 'daily' }, task_overdue: { email: true } })).toBe(true);
    expect(digest.anyEmailCategoryOn({ task_overdue: { email: false }, mention: { sms: true } })).toBe(false);
  });

  test('localParts resolves hour + date key in the user timezone', () => {
    // 2026-09-21T11:30Z = 07:30 in New York (EDT), 13:30 in Berlin.
    const t = new Date('2026-09-21T11:30:00Z');
    expect(digest.localParts(t, 'America/New_York')).toMatchObject({ hour: 7, dateKey: '2026-09-21' });
    expect(digest.localParts(t, 'Europe/Berlin')).toMatchObject({ hour: 13, dateKey: '2026-09-21' });
    expect(digest.localParts(new Date('2026-09-21T03:30:00Z'), 'America/New_York')).toMatchObject({ hour: 23, dateKey: '2026-09-20' });
  });
});

describe('dispatcher → queue', () => {
  test('a task_overdue email for a daily-mode user is QUEUED with its actions, not sent', async () => {
    let inserted = null;
    mockPool.query.mockImplementation(async (sql, params) => {
      const s = String(sql);
      if (/FROM tasks t/i.test(s)) {
        return { rows: [{ id: 12, title: 'Call Dana', due_date: '2026-09-20', user_id: 9, assigned_to: 9, org_id: 5,
          recipient_id: 9, notification_preferences: { task_overdue: { email: true, sms: false } } }] };
      }
      if (/SELECT id, email, name, org_id, notification_email/i.test(s)) {
        return { rows: [{ id: 9, email: 'me@x.test', name: 'Me', org_id: 5, notification_email: null, notification_phone: null,
          notification_preferences: { task_overdue: { email: true, sms: false } } }] };
      }
      if (/INSERT INTO notification_email_queue/i.test(s)) { inserted = params; return { rows: [{ id: 1 }] }; }
      return { rows: [] };
    });
    const out = await dispatcher.notifyTaskOverdue(12);
    expect(out.email).toBe('queued');
    expect(sendMail).not.toHaveBeenCalled();
    expect(inserted[0]).toBe(5); // org_id
    expect(inserted[1]).toBe(9); // user_id
    expect(inserted[2]).toBe('task_overdue');
    expect(inserted[3]).toMatch(/Overdue task: Call Dana/);
    expect(inserted[6]).toBe('/tasks?taskId=12');
    const actions = JSON.parse(inserted[9]);
    expect(actions.map((a) => a.action)).toEqual(['task.complete', 'task.snooze']);
    expect(actions[0].entity_id).toBe(12);
  });

  test('an instant-mode user still gets the email right away, with the buttons appended', async () => {
    mockPool.query.mockImplementation(async (sql) => {
      const s = String(sql);
      if (/FROM tasks t/i.test(s)) {
        return { rows: [{ id: 12, title: 'Call Dana', due_date: null, user_id: 9, assigned_to: 9, org_id: 5,
          recipient_id: 9, notification_preferences: { task_overdue: { email: true }, email_delivery: { mode: 'instant' } } }] };
      }
      if (/SELECT id, email, name, org_id, notification_email/i.test(s)) {
        return { rows: [{ id: 9, email: 'me@x.test', name: 'Me', org_id: 5, notification_email: null, notification_phone: null,
          notification_preferences: { task_overdue: { email: true }, email_delivery: { mode: 'instant' } } }] };
      }
      if (/INSERT INTO email_action_tokens/i.test(s)) return { rows: [] };
      return { rows: [] };
    });
    const out = await dispatcher.notifyTaskOverdue(12);
    expect(out.email).toBe('sent');
    const mail = sendMail.mock.calls[0][0];
    expect(mail.html).toMatch(/Mark done/);
    expect(mail.html).toMatch(/Snooze a day/);
    expect(mail.html).toMatch(/\/act\/[0-9a-f]{64}/);
    expect(mail.text).toMatch(/Mark done: https:\/\/.*\/act\/[0-9a-f]{64}/);
    // Buttons never leak into SMS.
    expect(mail.subject).toBe('Overdue task: Call Dana');
  });
});

describe('buildEmail', () => {
  const user = { id: 9, org_id: 5, name: 'John Coles', email: 'j@x.test', notification_preferences: {} };
  const now = new Date('2026-09-21T11:30:00Z'); // Mon 07:30 New York

  test('daily: live sections + queued events, every row has a one-click button, subject counts things', async () => {
    const live = {
      tasksDue: [{ id: 12, title: 'Call Dana', overdue_days: 2, deal_title: 'Acme roof' }, { id: 13, title: 'Send quote', overdue_days: 0 }],
      nextSteps: [{ id: 7, title: 'Acme roof', next_step: 'Send revised quote', company_name: 'Acme', amount: 12000, overdue_days: 1 }],
      quietAccounts: [{ id: 4, name: 'Beta Co', days_since_last_touch: 41 }],
      dealsNeedingAttention: [{ id: 8, title: 'Gamma HVAC', company_name: 'Gamma', past_close_date: true, expected_close_date: '2026-09-01', days_since_last_activity: 20 }],
      renewals: [],
    };
    const queued = [{ id: 1, category: 'mention', subject: 'Sam mentioned you in a comment', link: '/deals?dealId=8', actions: [], created_at: now }];
    const out = await digest.buildEmail(user, { queued, live, kind: 'daily', now, mint: fakeMint });

    expect(out.subject).toBe('Your day, Mon, Sep 21 — 2 tasks, 1 next step, 1 quiet account, 1 deal to look at, 1 update');
    expect(out.itemCount).toBe(6);
    expect(out.html).toMatch(/John, here's everything that needs you/);
    expect(out.html).toMatch(/Tasks due \(2\)/);
    expect(out.html).toMatch(/2 days overdue · Deal: Acme roof/);
    expect(out.html).toMatch(/https:\/\/app\.test\/act\/task\.complete\/12/);
    expect(out.html).toMatch(/https:\/\/app\.test\/act\/task\.snooze\/13/);
    expect(out.html).toMatch(/https:\/\/app\.test\/act\/deal\.next_step\.complete\/7/);
    expect(out.html).toMatch(/\$12,000/);
    expect(out.html).toMatch(/https:\/\/app\.test\/act\/company\.touch\/4/);
    expect(out.html).toMatch(/41 days since last touch/);
    expect(out.html).toMatch(/Gamma HVAC/);
    expect(out.html).toMatch(/Since your last digest \(1\)/);
    expect(out.html).toMatch(/Sam mentioned you in a comment/);
    expect(out.html).toMatch(/once a day at 07:00 \(America\/New_York\)/);
    expect(out.html).toMatch(/settings#notifications/);
    // Plain-text alternative carries the same items.
    expect(out.text).toMatch(/- Task: Call Dana \(2d overdue\)/);
    expect(out.text).toMatch(/- Next step: Send revised quote \(Acme roof\)/);
    expect(out.text).toMatch(/Open My Day: /);
    // 2 tasks x 2 + 1 step x 2 + 1 touch = 7 minted links
    expect(fakeMint).toHaveBeenCalledTimes(7);
    expect(fakeMint.mock.calls.every((c) => c[0].orgId === 5 && c[0].userId === 9)).toBe(true);
  });

  test('escapes user content in titles', async () => {
    const live = { tasksDue: [{ id: 1, title: '<script>alert(1)</script> & co', overdue_days: 0 }], nextSteps: [], quietAccounts: [], dealsNeedingAttention: [], renewals: [] };
    const out = await digest.buildEmail(user, { queued: [], live, kind: 'daily', now, mint: fakeMint });
    expect(out.html).not.toMatch(/<script>/);
    expect(out.html).toMatch(/&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; co/);
  });

  test('batched: one item uses its own subject; several say "N updates"; caps a long section with "+N more"', async () => {
    const one = await digest.buildEmail(user, { queued: [{ id: 1, category: 'task_assigned', subject: 'New task: Call Dana', link: '/tasks?taskId=1', actions: [{ action: 'task.complete', entity_id: 1 }], created_at: now }], kind: 'batched', now, mint: fakeMint });
    expect(one.subject).toBe('New task: Call Dana');
    expect(one.html).toMatch(/https:\/\/app\.test\/act\/task\.complete\/1/);
    expect(one.html).toMatch(/Grouped every 15 minutes/);

    const many = await digest.buildEmail(user, { queued: [1, 2, 3].map((i) => ({ id: i, category: 'mention', subject: `Mention ${i}`, actions: [], created_at: now })), kind: 'batched', now, mint: fakeMint });
    expect(many.subject).toBe('3 updates from The Open CRM');

    const live = { tasksDue: Array.from({ length: 12 }, (_, i) => ({ id: i + 1, title: `T${i + 1}`, overdue_days: 0 })), nextSteps: [], quietAccounts: [], dealsNeedingAttention: [], renewals: [] };
    const capped = await digest.buildEmail(user, { queued: [], live, kind: 'daily', now, mint: fakeMint });
    expect(capped.html).toMatch(/Tasks due \(12\)/);
    expect(capped.html).toMatch(/\+4 more in/);
  });

  test('nothing to say → itemCount 0', async () => {
    const out = await digest.buildEmail(user, { queued: [], live: { tasksDue: [], nextSteps: [], quietAccounts: [], dealsNeedingAttention: [], renewals: [] }, kind: 'daily', now, mint: fakeMint });
    expect(out.itemCount).toBe(0);
  });
});

describe('flushUser + tick', () => {
  const baseUser = { id: 9, email: 'j@x.test', name: 'John', org_id: 5, status: 'active', notification_email: null,
    notification_preferences: { task_overdue: { email: true } }, digest_last_sent_at: null };

  function wire({ queued = [], daily = [], liveTasks = [] } = {}) {
    const calls = [];
    mockPool.query.mockImplementation(async (sql, params) => {
      const s = String(sql);
      calls.push([s, params]);
      if (/UPDATE notification_email_queue SET digest_id = \$1/i.test(s)) return { rows: queued.map((q) => ({ ...q, user_id: params[1] })) };
      if (/UPDATE notification_email_queue SET flushed_at/i.test(s)) return { rows: [] };
      if (/INSERT INTO email_action_tokens/i.test(s)) return { rows: [] };
      if (/SELECT q.user_id, MIN\(q.created_at\)/i.test(s)) return { rows: [] };
      if (/COALESCE\(notification_preferences->'email_delivery'->>'mode'/i.test(s)) return { rows: daily };
      if (/UPDATE users SET digest_last_sent_at/i.test(s)) return { rows: [{ id: params[0] }] };
      if (/FROM tasks t/i.test(s)) return { rows: liveTasks };
      if (/SELECT id, email, name, org_id, status, notification_email/i.test(s)) return { rows: [baseUser] };
      return { rows: [] };
    });
    return calls;
  }

  test('flushUser(daily) claims queue rows, loads the live queue, sends ONE email and marks rows flushed', async () => {
    const calls = wire({ queued: [{ id: 1, category: 'mention', subject: 'Hi', actions: [], created_at: new Date() }], liveTasks: [{ id: 12, title: 'Call Dana', due_date: '2026-09-20' }] });
    const out = await digest.flushUser(baseUser, { kind: 'daily', now: new Date('2026-09-21T11:30:00Z') });
    expect(out.sent).toBe(true);
    expect(out.queued).toBe(1);
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail.mock.calls[0][0].to).toBe('j@x.test');
    expect(sendMail.mock.calls[0][0].subject).toMatch(/^Your day, Mon, Sep 21 — 1 task, 1 update$/);
    expect(calls.some(([s]) => /UPDATE notification_email_queue SET flushed_at = NOW\(\) WHERE digest_id/.test(s))).toBe(true);
  });

  test('flushUser skips a user with every email category off (unless forced) and sends nothing when empty', async () => {
    wire();
    expect(await digest.flushUser({ ...baseUser, notification_preferences: {} }, { kind: 'daily' })).toMatchObject({ sent: false, reason: 'email_off' });
    expect(await digest.flushUser(baseUser, { kind: 'daily' })).toMatchObject({ sent: false, reason: 'empty' });
    expect(sendMail).not.toHaveBeenCalled();
  });

  test('a failed send releases the claim so the next tick retries', async () => {
    const calls = wire({ queued: [{ id: 1, category: 'mention', subject: 'Hi', actions: [], created_at: new Date() }] });
    sendMail.mockRejectedValueOnce(new Error('smtp down'));
    await expect(digest.flushUser(baseUser, { kind: 'batched' })).rejects.toThrow(/smtp down/);
    expect(calls.some(([s]) => /SET digest_id = NULL WHERE digest_id = \$1/.test(s))).toBe(true);
    expect(calls.some(([s]) => /SET flushed_at = NOW\(\)/.test(s))).toBe(false);
  });

  test('tick sends the daily digest only at the user hour, once per local day, via a compare-and-set claim', async () => {
    const dailyUser = { ...baseUser, notification_preferences: { task_overdue: { email: true }, email_delivery: { mode: 'daily', hour: 7, tz: 'America/New_York' } } };
    // 06:30 NY → not yet
    let calls = wire({ daily: [dailyUser], liveTasks: [{ id: 12, title: 'T', due_date: '2026-09-20' }] });
    let out = await digest.tick({ now: new Date('2026-09-21T10:30:00Z') });
    expect(out.daily).toBe(0);
    expect(sendMail).not.toHaveBeenCalled();
    // 07:30 NY → send + claim
    calls = wire({ daily: [dailyUser], liveTasks: [{ id: 12, title: 'T', due_date: '2026-09-20' }] });
    out = await digest.tick({ now: new Date('2026-09-21T11:30:00Z') });
    expect(out.daily).toBe(1);
    const claim = calls.find(([s]) => /UPDATE users SET digest_last_sent_at/.test(s));
    expect(claim[0]).toMatch(/digest_last_sent_at IS NOT DISTINCT FROM \$3/);
    expect(claim[1][2]).toBeNull();
    // Later the same local day, already stamped → nothing
    sendMail.mockClear();
    wire({ daily: [{ ...dailyUser, digest_last_sent_at: new Date('2026-09-21T11:30:00Z') }], liveTasks: [{ id: 12, title: 'T' }] });
    out = await digest.tick({ now: new Date('2026-09-21T11:55:00Z') });
    expect(out.daily).toBe(0);
    expect(sendMail).not.toHaveBeenCalled();
  });

  test('tick flushes batched users only once the oldest pending row is 15 min old', async () => {
    const batchedUser = { ...baseUser, notification_preferences: { task_overdue: { email: true }, email_delivery: { mode: 'batched' } } };
    const now = new Date('2026-09-21T11:30:00Z');
    mockPool.query.mockImplementation(async (sql, params) => {
      const s = String(sql);
      if (/SELECT q.user_id, MIN\(q.created_at\)/i.test(s)) return { rows: [{ user_id: 9, oldest: new Date(now.getTime() - 5 * 60000) }] };
      if (/SELECT id, email, name, org_id, status, notification_email/i.test(s)) return { rows: [batchedUser] };
      if (/COALESCE\(notification_preferences->'email_delivery'->>'mode'/i.test(s)) return { rows: [] };
      if (/UPDATE notification_email_queue SET digest_id = \$1/i.test(s)) return { rows: [{ id: 1, category: 'mention', subject: 'Hi', actions: [], created_at: now, user_id: 9 }] };
      return { rows: [] };
    });
    let out = await digest.tick({ now });
    expect(out.batched).toBe(0);
    expect(out.skipped).toBe(1);
    mockPool.query.mockImplementation(async (sql, params) => {
      const s = String(sql);
      if (/SELECT q.user_id, MIN\(q.created_at\)/i.test(s)) return { rows: [{ user_id: 9, oldest: new Date(now.getTime() - 16 * 60000) }] };
      if (/SELECT id, email, name, org_id, status, notification_email/i.test(s)) return { rows: [batchedUser] };
      if (/COALESCE\(notification_preferences->'email_delivery'->>'mode'/i.test(s)) return { rows: [] };
      if (/UPDATE notification_email_queue SET digest_id = \$1/i.test(s)) return { rows: [{ id: 1, category: 'mention', subject: 'Hi', actions: [], created_at: now, user_id: 9 }] };
      return { rows: [] };
    });
    out = await digest.tick({ now });
    expect(out.batched).toBe(1);
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail.mock.calls[0][0].subject).toBe('Hi');
  });
});
