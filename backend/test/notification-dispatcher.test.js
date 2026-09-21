// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Smoke tests for services/notificationDispatcher.js.
//
// The dispatcher's value is in correctly fanning out (or NOT fanning out)
// based on per-user prefs + handle availability. We mock both transports
// (email + sms) so we observe only intent, not real delivery.

// describe / test / expect / beforeEach / vi are global.

// See auth.test.js — patch the live pool instance instead of vi.mock'ing.
// These suites assert the per-alert (instant) email path. Since spec 204 the
// default delivery mode is a consolidated digest, so pin instant here; the
// digest path has its own suite (test/notificationDigest.test.js).
process.env.DEFAULT_EMAIL_DELIVERY_MODE = 'instant';
const realPool = require('../db');
const mockPool = realPool;
mockPool.query   = vi.fn();
mockPool.connect = vi.fn();

// Same trick as the db pool — patch the live module's exports rather than
// fighting vitest's CJS mock interop. notificationDispatcher does
// `const email = require('./email')` etc., so a mutation on the real
// exports propagates.
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

beforeEach(() => {
  mockPool.query.mockReset();
  sendMail.mockReset();
  sendSms.mockReset();
  sendMail.mockResolvedValue({ ok: true, kind: 'console' });
  sendSms.mockResolvedValue('sent');
});

describe('notifyTaskAssigned', () => {
  test('no-ops when the user has both channels disabled for the category', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{
        id: 1, title: 'T', description: null, due_date: null, user_id: 1, assigned_to: 1,
        contact_id: null, deal_id: null,
        recipient_id: 1, notification_preferences: { task_assigned: { email: false, sms: false } },
      }],
    });
    const out = await dispatcher.notifyTaskAssigned(1);
    expect(out.email).toBe('skipped');
    expect(out.sms).toBe('skipped');
    expect(sendMail).not.toHaveBeenCalled();
    expect(sendSms).not.toHaveBeenCalled();
  });

  test('sends email when email channel is enabled', async () => {
    // The task-loading query (with the user join):
    mockPool.query.mockResolvedValueOnce({
      rows: [{
        id: 1, title: 'Test task', description: null, due_date: null, user_id: 1, assigned_to: 1,
        contact_id: null, deal_id: null,
        recipient_id: 1, notification_preferences: { task_assigned: { email: true, sms: false } },
      }],
    });
    // The dispatcher's loadUserForDispatch query (looks up the user row).
    mockPool.query.mockResolvedValueOnce({
      rows: [{
        id: 1, email: 'a@b.com', name: 'Alice',
        notification_email: null, notification_phone: null,
        notification_preferences: { task_assigned: { email: true, sms: false } },
      }],
    });
    const out = await dispatcher.notifyTaskAssigned(1);
    expect(out.email).toBe('sent');
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail.mock.calls[0][0]).toMatchObject({
      to: 'a@b.com',
      subject: expect.stringContaining('Test task'),
    });
    expect(sendSms).not.toHaveBeenCalled();
  });

  test('SMS gracefully skips when phone is null even though SMS is enabled', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{
        id: 1, title: 'Test', description: null, due_date: null, user_id: 1, assigned_to: 1,
        contact_id: null, deal_id: null,
        recipient_id: 1, notification_preferences: { task_assigned: { email: false, sms: true } },
      }],
    });
    mockPool.query.mockResolvedValueOnce({
      rows: [{
        id: 1, email: 'a@b.com', name: 'Alice',
        notification_email: null, notification_phone: null, // no phone
        notification_preferences: { task_assigned: { email: false, sms: true } },
      }],
    });
    const out = await dispatcher.notifyTaskAssigned(1);
    expect(out.email).toBe('skipped'); // email channel off
    expect(out.sms).toBe('skipped');   // no phone → graceful skip
    expect(sendSms).not.toHaveBeenCalled();
  });
});

describe('dispatch', () => {
  test('skips unknown category', async () => {
    const out = await dispatcher.dispatch(1, 'not-a-category', { subject: 'x', text: 'y' });
    expect(out.email).toBe('skipped');
    expect(out.sms).toBe('skipped');
  });

  test('skips when user not found', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    const out = await dispatcher.dispatch(9999, 'task_assigned', { subject: 'x', text: 'y' });
    expect(out.email).toBe('skipped');
    expect(out.sms).toBe('skipped');
  });
});
