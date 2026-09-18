// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Tests for the sequence worker's Gmail daily send cap: when the active email
// transport is Gmail and >= GMAIL_DAILY_SEND_CAP (default 400) sends have been
// recorded in email_sends today, the tick skips gracefully instead of blowing
// through Gmail's ~500/day account limit. SendGrid is never capped, and a
// failed count fails OPEN (mail keeps flowing).

const realPool = require('../db');
const mockPool = realPool;
mockPool.query = vi.fn();

const email = require('../services/email');
const workerLease = require('../services/workerLease');
const sequences = require('../services/sequences');
const sequenceWorker = require('../services/sequenceWorker');

beforeEach(() => {
  mockPool.query.mockReset();
  vi.restoreAllMocks();
  vi.spyOn(email, 'isConfigured').mockReturnValue(true);
  vi.spyOn(workerLease, 'claim').mockResolvedValue(true);
  vi.spyOn(workerLease, 'release').mockResolvedValue(undefined);
  vi.spyOn(sequences, 'processDueEnrollments').mockResolvedValue({ sent: 2, failed: 0 });
});

test('gmail transport at/over the cap: skips with gmail_daily_cap, sends nothing', async () => {
  vi.spyOn(email, 'transportKind').mockReturnValue('gmail');
  mockPool.query.mockResolvedValueOnce({ rows: [{ n: 450 }] }); // today's count

  const result = await sequenceWorker.tick();

  expect(result.skipped).toBe('gmail_daily_cap');
  expect(result.sentToday).toBe(450);
  expect(result.cap).toBe(400);
  expect(sequences.processDueEnrollments).not.toHaveBeenCalled();
  expect(workerLease.claim).not.toHaveBeenCalled(); // no lease burned on a no-op
});

test('gmail transport under the cap: proceeds normally', async () => {
  vi.spyOn(email, 'transportKind').mockReturnValue('gmail');
  mockPool.query.mockResolvedValueOnce({ rows: [{ n: 12 }] });

  const result = await sequenceWorker.tick();

  expect(result).toEqual({ sent: 2, failed: 0 });
  expect(sequences.processDueEnrollments).toHaveBeenCalledTimes(1);
});

test('sendgrid transport: cap never consulted, no count query fired', async () => {
  vi.spyOn(email, 'transportKind').mockReturnValue('sendgrid');

  const result = await sequenceWorker.tick();

  expect(result).toEqual({ sent: 2, failed: 0 });
  expect(mockPool.query).not.toHaveBeenCalled();
});

test('count query failure fails OPEN: sends proceed', async () => {
  vi.spyOn(email, 'transportKind').mockReturnValue('gmail');
  mockPool.query.mockRejectedValueOnce(new Error('db hiccup'));

  const result = await sequenceWorker.tick();

  expect(result).toEqual({ sent: 2, failed: 0 });
  expect(sequences.processDueEnrollments).toHaveBeenCalledTimes(1);
});

test('GMAIL_DAILY_SEND_CAP env override is honored', async () => {
  vi.spyOn(email, 'transportKind').mockReturnValue('gmail');
  process.env.GMAIL_DAILY_SEND_CAP = '10';
  try {
    mockPool.query.mockResolvedValueOnce({ rows: [{ n: 10 }] });
    const result = await sequenceWorker.tick();
    expect(result.skipped).toBe('gmail_daily_cap');
    expect(result.cap).toBe(10);
  } finally {
    delete process.env.GMAIL_DAILY_SEND_CAP;
  }
});

test('no transport at all still short-circuits before the cap logic', async () => {
  email.isConfigured.mockReturnValue(false);
  const result = await sequenceWorker.tick();
  expect(result.skipped).toBe('email_not_configured');
  expect(mockPool.query).not.toHaveBeenCalled();
});
