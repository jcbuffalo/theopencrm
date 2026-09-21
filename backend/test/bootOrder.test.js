// Cloud Run's startup probe on synccrm-backend is a TCP check, so the port
// opening IS "ready" as far as the router is concerned. index.js must
// therefore finish migrations (and the platform-template seed) BEFORE
// app.listen — the 2026-09-19 "relation workspace_templates does not exist"
// blip came from running them inside the listen callback. A real boot needs
// Postgres, so this pins the ordering structurally.
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

describe('index.js boot order', () => {
  test('migrations run before app.listen inside prepareThenListen', () => {
    const start = src.indexOf('async function prepareThenListen()');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('async function onListening()', start));
    const migrateAt = body.indexOf('await runMigrationsOnStartup()');
    const seedAt = body.indexOf('seedPlatformTemplates()');
    const listenAt = body.indexOf('app.listen(PORT');
    expect(migrateAt).toBeGreaterThan(-1);
    expect(seedAt).toBeGreaterThan(migrateAt);
    expect(listenAt).toBeGreaterThan(seedAt);
  });

  test('app.listen is only ever called from prepareThenListen, and only when run directly', () => {
    expect(src.match(/app\.listen\(/g)).toHaveLength(1);
    expect(src).toMatch(/if \(require\.main === module\) \{\s*prepareThenListen\(\)/);
  });

  test('importing index.js does not open a port', async () => {
    process.env.NODE_ENV = 'test';
    const app = require('../index.js');
    // supertest binds its own ephemeral port; if index.js had listened on PORT
    // we would see EADDRINUSE across parallel workers. Just exercise the
    // readiness route to prove the app object is usable un-listened.
    const request = require('supertest');
    const res = await request(app).get('/health/ready');
    // Not production → bootPhase stays 'starting' because prepareThenListen
    // never ran (require.main is the test runner).
    expect([200, 503]).toContain(res.status);
    expect(res.body.status).toBeDefined();
  });
});
