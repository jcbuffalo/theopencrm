// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Tests for the browser crash-report receiver (POST /api/client-errors) and
// the CSP-violation receiver (POST /api/client-errors/csp).
//
// Strategy mirrors passwordReset.test.js: mount the router on a bare Express
// app with the real clientErrorLimiter in front (so the rate-limit test is
// real), spy on the logger, and drive with supertest. Each test uses its own
// X-Forwarded-For IP so limiter state never bleeds between tests.

const express = require('express');
const request = require('supertest');

const logger = require('../services/logger');
const { clientErrorLimiter } = require('../middleware/rateLimits');
const clientErrorRoutes = require('../routes/clientErrorRoutes');

function buildApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/client-errors', clientErrorLimiter, clientErrorRoutes);
  // Terminal error handler so a body-parse failure yields its 4xx, not a crash.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    res.status(err.statusCode || err.status || 500).json({ success: false });
  });
  return app;
}

let ipCounter = 0;
function nextIp() {
  ipCounter += 1;
  return `10.77.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`;
}

let errorSpy;
let warnSpy;
beforeEach(() => {
  errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
  warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  errorSpy.mockRestore();
  warnSpy.mockRestore();
});

describe('POST /api/client-errors', () => {
  test('valid report → 204 and logged at ERROR with frontend serviceContext', async () => {
    const res = await request(buildApp())
      .post('/api/client-errors')
      .set('X-Forwarded-For', nextIp())
      .send({
        message: 'TypeError: x is undefined',
        stack: 'TypeError: x is undefined\n    at Chat.js:12:3',
        componentStack: '\n    in Chat\n    in App',
        path: '/chat',
        ua: 'test-agent',
      });

    expect(res.status).toBe(204);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [msg, fields] = errorSpy.mock.calls[0];
    expect(msg).toContain('TypeError: x is undefined');
    expect(fields.serviceContext).toEqual({ service: 'synccrm-frontend' });
    expect(fields.stack).toContain('at Chat.js:12:3');
    expect(fields.clientPath).toBe('/chat');
  });

  test('garbage bodies never 500 (missing fields, wrong types, non-object)', async () => {
    const app = buildApp();
    const bodies = [
      {},
      { message: 12345, stack: { a: 1 }, path: null },
      [1, 2, 3],
      { message: 'x'.repeat(100000) }, // absurdly long — must be truncated, not rejected
    ];
    for (const body of bodies) {
      const res = await request(app)
        .post('/api/client-errors')
        .set('X-Forwarded-For', nextIp())
        .send(body);
      expect(res.status).toBeLessThan(500);
    }
    // Malformed JSON: body-parser 4xx, never a 5xx.
    const res = await request(app)
      .post('/api/client-errors')
      .set('X-Forwarded-For', nextIp())
      .set('Content-Type', 'application/json')
      .send('{not json');
    expect(res.status).toBeLessThan(500);
  });

  test('truncates stack + componentStack to 4KB', async () => {
    await request(buildApp())
      .post('/api/client-errors')
      .set('X-Forwarded-For', nextIp())
      .send({ message: 'boom', stack: 's'.repeat(10000), componentStack: 'c'.repeat(10000) });
    const [, fields] = errorSpy.mock.calls[0];
    expect(fields.stack.length).toBe(4096);
    expect(fields.componentStack.length).toBe(4096);
  });

  test('rate limit: 11th report from one IP → 429; reports from another IP still land', async () => {
    const app = buildApp();
    const ip = nextIp();
    for (let i = 0; i < 10; i++) {
      const r = await request(app)
        .post('/api/client-errors')
        .set('X-Forwarded-For', ip)
        .send({ message: `crash ${i}` });
      expect(r.status).toBe(204);
    }
    const blocked = await request(app)
      .post('/api/client-errors')
      .set('X-Forwarded-For', ip)
      .send({ message: 'crash 11' });
    expect(blocked.status).toBe(429);

    const other = await request(app)
      .post('/api/client-errors')
      .set('X-Forwarded-For', nextIp())
      .send({ message: 'other ip' });
    expect(other.status).toBe(204);
  });
});

describe('POST /api/client-errors/csp', () => {
  test('csp-report content type → 204 and logged at WARN as csp_violation', async () => {
    const res = await request(buildApp())
      .post('/api/client-errors/csp')
      .set('X-Forwarded-For', nextIp())
      .set('Content-Type', 'application/csp-report')
      .send(JSON.stringify({
        'csp-report': {
          'violated-directive': 'img-src',
          'blocked-uri': 'http://evil.example/x.png',
          'document-uri': 'https://app.theopencrm.com/deals',
        },
      }));

    expect(res.status).toBe(204);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [msg, fields] = warnSpy.mock.calls[0];
    expect(msg).toBe('csp_violation');
    expect(fields.violatedDirective).toBe('img-src');
    expect(fields.blockedUri).toBe('http://evil.example/x.png');
  });

  test('unparseable CSP report body → still 204, never 500', async () => {
    const res = await request(buildApp())
      .post('/api/client-errors/csp')
      .set('X-Forwarded-For', nextIp())
      .set('Content-Type', 'application/csp-report')
      .send('%%%not-json%%%');
    expect(res.status).toBe(204);
  });
});

describe('logger Error Reporting shape', () => {
  test('ERROR entries carry @type + serviceContext and append the stack to message', () => {
    const lines = [];
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation((l) => lines.push(l));
    try {
      const err = new Error('kaboom');
      errorSpy.mockRestore(); // use the REAL logger.error for this test
      logger.error('unhandled_error', { error: err, path: '/api/x' });
      const entry = JSON.parse(lines[lines.length - 1]);
      expect(entry.severity).toBe('ERROR');
      expect(entry['@type']).toBe('type.googleapis.com/google.devtools.clouderrorreporting.v1beta1.ReportedErrorEvent');
      expect(entry.serviceContext).toEqual({ service: 'synccrm-backend' });
      expect(entry.message).toContain('unhandled_error');
      expect(entry.message).toContain('Error: kaboom'); // stack appended
      expect(entry.message).toContain('at '); // stack frames present
      // re-establish spy so afterEach mockRestore doesn't throw
      errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    } finally {
      consoleSpy.mockRestore();
    }
  });

  test('an explicit serviceContext in the fields wins (frontend reports)', () => {
    const lines = [];
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation((l) => lines.push(l));
    try {
      errorSpy.mockRestore();
      logger.error('client_error: boom', {
        serviceContext: { service: 'synccrm-frontend' },
        stack: 'TypeError: boom\n    at Chat.js:1:1',
      });
      const entry = JSON.parse(lines[lines.length - 1]);
      expect(entry.serviceContext).toEqual({ service: 'synccrm-frontend' });
      expect(entry.message).toContain('at Chat.js:1:1');
      errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    } finally {
      consoleSpy.mockRestore();
    }
  });
});
