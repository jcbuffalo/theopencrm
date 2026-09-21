// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Notification fan-out for the July-2026 module wave — the seven new
// producers in services/notificationDispatcher.js (migration 144):
// cases, leads, meetings, sequences, playbooks.
//
// What matters (and what's covered per producer):
//   1. The RIGHT recipient gets an in-app row (owner-first, sensible fallback).
//   2. Tenancy: the notification row carries the RECORD's own org_id — never
//      anyone else's — so a row can't leak across orgs.
//   3. Wire channels honour the per-type pref (off → no email/SMS), while the
//      in-app row persists regardless (the bell is the always-on record).
//   4. A helper NEVER throws into its caller — DB failure resolves to a
//      'failed' outcome instead of rejecting.
//   5. Self-notification skips (assigning to yourself is silent).
//
// Mock style mirrors notification-dispatcher.test.js: patch the live pool +
// transport modules instead of vi.mock'ing (CJS interop).

// describe / test / expect / beforeEach / vi are global.

// These suites assert the per-alert (instant) email path. Since spec 204 the
// default delivery mode is a consolidated digest, so pin instant here; the
// digest path has its own suite (test/notificationDigest.test.js).
process.env.DEFAULT_EMAIL_DELIVERY_MODE = 'instant';
const realPool = require('../db');
const mockPool = realPool;
mockPool.query   = vi.fn();
mockPool.connect = vi.fn();

const emailModule = require('../services/email');
const smsModule   = require('../services/sms');
const sendMail = vi.fn().mockResolvedValue({ ok: true, kind: 'console' });
const sendSms  = vi.fn().mockResolvedValue('sent');
emailModule.sendMail = sendMail;
smsModule.sendSms    = sendSms;

vi.mock('../services/logger', () => ({
  info:   vi.fn(),
  warn:   vi.fn(),
  error:  vi.fn(),
  notice: vi.fn(),
  debug:  vi.fn(),
}));

const dispatcher = require('../services/notificationDispatcher');

const ORG_ID = 7;
const OWNER_ID = 9;
const ACTOR_ID = 4;

beforeEach(() => {
  mockPool.query.mockReset();
  sendMail.mockReset();
  sendSms.mockReset();
  sendMail.mockResolvedValue({ ok: true, kind: 'console' });
  sendSms.mockResolvedValue('sent');
});

// The INSERT INTO notifications call (services/notifications.js create()) —
// param order: [org_id, user_id, type, title, body, link, entity_type, entity_id].
function findInAppInsert() {
  return mockPool.query.mock.calls.find(
    ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO notifications')
  );
}

const PREFS_OFF = (category) => ({ [category]: { email: false, sms: false } });

// ---------------------------------------------------------------------------
// notifyCaseAssigned
// ---------------------------------------------------------------------------

describe('notifyCaseAssigned', () => {
  const caseRow = (over = {}) => ({
    id: 31, subject: 'Portal login broken', priority: 'high', status: 'open',
    org_id: ORG_ID, owner_user_id: OWNER_ID, company_name: 'Acme',
    recipient_id: OWNER_ID, notification_preferences: PREFS_OFF('case_assigned'),
    ...over,
  });

  test('persists an in-app row for the owner even with wire channels off (no email/SMS)', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [caseRow()] });          // row load
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 1 }] });          // in-app INSERT
    const out = await dispatcher.notifyCaseAssigned(31, ACTOR_ID);
    expect(out).toEqual({ email: 'skipped', sms: 'skipped' });
    expect(sendMail).not.toHaveBeenCalled();
    expect(sendSms).not.toHaveBeenCalled();
    const insert = findInAppInsert();
    expect(insert).toBeTruthy();
    // Tenancy + recipient: the row carries the CASE's own org and the owner.
    expect(insert[1][0]).toBe(ORG_ID);           // org_id
    expect(insert[1][1]).toBe(OWNER_ID);         // user_id (recipient)
    expect(insert[1][2]).toBe('case_assigned');  // type
    expect(insert[1][3]).toContain('Portal login broken');
  });

  test('sends email when the per-type email pref is ON', async () => {
    const prefs = { case_assigned: { email: true, sms: false } };
    mockPool.query.mockResolvedValueOnce({ rows: [caseRow({ notification_preferences: prefs })] });
    mockPool.query.mockResolvedValueOnce({ rows: [{                        // loadUserForDispatch
      id: OWNER_ID, email: 'owner@acme.test', name: 'Owner',
      notification_email: null, notification_phone: null,
      notification_preferences: prefs,
    }] });
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 2 }] });           // in-app INSERT
    const out = await dispatcher.notifyCaseAssigned(31, ACTOR_ID);
    expect(out.email).toBe('sent');
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail.mock.calls[0][0].to).toBe('owner@acme.test');
    expect(findInAppInsert()).toBeTruthy(); // in-app persists alongside email
  });

  test('skips entirely when the owner is the actor (self-assignment is silent)', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [caseRow()] });
    const out = await dispatcher.notifyCaseAssigned(31, OWNER_ID);
    expect(out).toEqual({ email: 'skipped', sms: 'skipped' });
    expect(findInAppInsert()).toBeUndefined();
  });

  test('resolves to failed (never throws) when the DB errors', async () => {
    mockPool.query.mockRejectedValueOnce(new Error('boom'));
    await expect(dispatcher.notifyCaseAssigned(31, ACTOR_ID)).resolves.toEqual({ email: 'failed', sms: 'failed' });
  });
});

// ---------------------------------------------------------------------------
// notifyCaseStatusChanged
// ---------------------------------------------------------------------------

describe('notifyCaseStatusChanged', () => {
  test('notifies the owner (creator fallback resolved in SQL) in-app with the transition', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{
      id: 31, subject: 'Portal login broken', status: 'resolved', org_id: ORG_ID,
      company_name: 'Acme', recipient_id: OWNER_ID,
      notification_preferences: PREFS_OFF('case_status_changed'),
    }] });
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 3 }] });
    const out = await dispatcher.notifyCaseStatusChanged(31, ACTOR_ID, 'open');
    expect(out).toEqual({ email: 'skipped', sms: 'skipped' });
    const insert = findInAppInsert();
    expect(insert[1][1]).toBe(OWNER_ID);
    expect(insert[1][2]).toBe('case_status_changed');
    expect(insert[1][4]).toContain('open → resolved'); // body carries the transition
  });

  test('never throws into the caller on failure', async () => {
    mockPool.query.mockRejectedValueOnce(new Error('down'));
    await expect(dispatcher.notifyCaseStatusChanged(31, ACTOR_ID, 'open')).resolves.toEqual({ email: 'failed', sms: 'failed' });
  });
});

// ---------------------------------------------------------------------------
// notifyLeadCaptured / notifyLeadAssigned
// ---------------------------------------------------------------------------

describe('notifyLeadCaptured', () => {
  test('persists in-app for the lead\'s owner with the lead\'s own org (no cross-tenant leak)', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{
      id: 55, name: 'Jane Doe', company_name: 'Widgets', source: 'web form',
      org_id: ORG_ID, recipient_id: OWNER_ID,
      notification_preferences: PREFS_OFF('lead_captured'),
    }] });
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 4 }] });
    const out = await dispatcher.notifyLeadCaptured(55);
    expect(out).toEqual({ email: 'skipped', sms: 'skipped' });
    const insert = findInAppInsert();
    expect(insert[1][0]).toBe(ORG_ID);   // the LEAD row's org, not a caller's
    expect(insert[1][1]).toBe(OWNER_ID);
    expect(insert[1][2]).toBe('lead_captured');
    expect(sendMail).not.toHaveBeenCalled();
  });

  test('skips cleanly when the lead has no resolvable recipient', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 55, recipient_id: null, org_id: ORG_ID }] });
    const out = await dispatcher.notifyLeadCaptured(55);
    expect(out).toEqual({ email: 'skipped', sms: 'skipped' });
    expect(findInAppInsert()).toBeUndefined();
  });

  test('never throws on DB failure', async () => {
    mockPool.query.mockRejectedValueOnce(new Error('boom'));
    await expect(dispatcher.notifyLeadCaptured(55)).resolves.toEqual({ email: 'failed', sms: 'failed' });
  });
});

describe('notifyLeadAssigned', () => {
  test('notifies the new owner in-app; per-type pref off keeps wire channels silent', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{
      id: 56, name: 'Sam Roe', company_name: null, org_id: ORG_ID,
      owner_user_id: OWNER_ID, recipient_id: OWNER_ID,
      notification_preferences: PREFS_OFF('lead_assigned'),
    }] });
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 5 }] });
    await dispatcher.notifyLeadAssigned(56, ACTOR_ID);
    const insert = findInAppInsert();
    expect(insert[1][1]).toBe(OWNER_ID);
    expect(insert[1][2]).toBe('lead_assigned');
    expect(sendMail).not.toHaveBeenCalled();
    expect(sendSms).not.toHaveBeenCalled();
  });

  test('self-assignment is silent', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{
      id: 56, name: 'Sam Roe', org_id: ORG_ID, owner_user_id: ACTOR_ID,
      recipient_id: ACTOR_ID, notification_preferences: {},
    }] });
    const out = await dispatcher.notifyLeadAssigned(56, ACTOR_ID);
    expect(out).toEqual({ email: 'skipped', sms: 'skipped' });
    expect(findInAppInsert()).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// notifyMeetingScheduled
// ---------------------------------------------------------------------------

describe('notifyMeetingScheduled', () => {
  test('notifies the linked deal owner in-app', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{
      id: 12, title: 'Kickoff', starts_at: '2026-07-20T15:00:00Z', location: null,
      org_id: ORG_ID, deal_title: 'Big Deal', company_name: 'Acme',
      recipient_id: OWNER_ID, notification_preferences: PREFS_OFF('meeting_scheduled'),
    }] });
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 6 }] });
    const out = await dispatcher.notifyMeetingScheduled(12, ACTOR_ID);
    expect(out).toEqual({ email: 'skipped', sms: 'skipped' });
    const insert = findInAppInsert();
    expect(insert[1][0]).toBe(ORG_ID);
    expect(insert[1][1]).toBe(OWNER_ID);
    expect(insert[1][2]).toBe('meeting_scheduled');
  });

  test('no linked stakeholder → notifies no one (by design)', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 12, title: 'Solo', org_id: ORG_ID, recipient_id: null }] });
    const out = await dispatcher.notifyMeetingScheduled(12, ACTOR_ID);
    expect(out).toEqual({ email: 'skipped', sms: 'skipped' });
    expect(findInAppInsert()).toBeUndefined();
  });

  test('scheduler === stakeholder is silent', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 12, title: 'Mine', org_id: ORG_ID, recipient_id: ACTOR_ID }] });
    const out = await dispatcher.notifyMeetingScheduled(12, ACTOR_ID);
    expect(out).toEqual({ email: 'skipped', sms: 'skipped' });
    expect(findInAppInsert()).toBeUndefined();
  });

  test('never throws on DB failure', async () => {
    mockPool.query.mockRejectedValueOnce(new Error('boom'));
    await expect(dispatcher.notifyMeetingScheduled(12, ACTOR_ID)).resolves.toEqual({ email: 'failed', sms: 'failed' });
  });
});

// ---------------------------------------------------------------------------
// notifySequenceCompleted
// ---------------------------------------------------------------------------

describe('notifySequenceCompleted', () => {
  test('notifies the sequence creator in-app when a contact finishes', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{
      id: 77, org_id: ORG_ID, contact_id: 3, sequence_id: 5, sequence_name: 'Onboarding drip',
      first_name: 'Jane', last_name: 'Doe',
      recipient_id: OWNER_ID, notification_preferences: PREFS_OFF('sequence_completed'),
    }] });
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 7 }] });
    const out = await dispatcher.notifySequenceCompleted(77);
    expect(out).toEqual({ email: 'skipped', sms: 'skipped' });
    const insert = findInAppInsert();
    expect(insert[1][0]).toBe(ORG_ID);
    expect(insert[1][1]).toBe(OWNER_ID);
    expect(insert[1][2]).toBe('sequence_completed');
    expect(insert[1][3]).toContain('Onboarding drip');
    expect(insert[1][4]).toContain('Jane Doe');
  });

  test('never throws on DB failure', async () => {
    mockPool.query.mockRejectedValueOnce(new Error('boom'));
    await expect(dispatcher.notifySequenceCompleted(77)).resolves.toEqual({ email: 'failed', sms: 'failed' });
  });
});

// ---------------------------------------------------------------------------
// notifyPlaybookTasksCreated
// ---------------------------------------------------------------------------

describe('notifyPlaybookTasksCreated', () => {
  test('notifies the company owner (SQL-side fallback to the actor) with the task count', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{
      id: 8, name: 'Onboarding checklist', org_id: ORG_ID, company_name: 'Acme',
      recipient_id: OWNER_ID, notification_preferences: PREFS_OFF('playbook_tasks_created'),
    }] });
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 8 }] });
    const out = await dispatcher.notifyPlaybookTasksCreated({
      playbookId: 8, companyId: 99, tasksCreated: 3, actorUserId: ACTOR_ID,
    });
    expect(out).toEqual({ email: 'skipped', sms: 'skipped' });
    const insert = findInAppInsert();
    expect(insert[1][0]).toBe(ORG_ID);
    expect(insert[1][1]).toBe(OWNER_ID);
    expect(insert[1][2]).toBe('playbook_tasks_created');
    expect(insert[1][3]).toContain('3 tasks');
    expect(sendMail).not.toHaveBeenCalled();
  });

  test('never throws on DB failure', async () => {
    mockPool.query.mockRejectedValueOnce(new Error('boom'));
    await expect(
      dispatcher.notifyPlaybookTasksCreated({ playbookId: 8, companyId: 99, tasksCreated: 3, actorUserId: ACTOR_ID })
    ).resolves.toEqual({ email: 'failed', sms: 'failed' });
  });
});

// ---------------------------------------------------------------------------
// Category registry — dispatch() rejects unknown categories, so every new
// producer type MUST be registered or its wire channels silently vanish.
// ---------------------------------------------------------------------------

describe('KNOWN_CATEGORIES', () => {
  test('includes all seven module-wave categories', () => {
    for (const cat of [
      'case_assigned', 'case_status_changed', 'lead_captured', 'lead_assigned',
      'meeting_scheduled', 'sequence_completed', 'playbook_tasks_created',
    ]) {
      expect(dispatcher.KNOWN_CATEGORIES).toContain(cat);
    }
  });
});
