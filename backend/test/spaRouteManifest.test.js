// The frontend shell server (frontend/server.js) returns a real 404 for paths
// the SPA does not route, using frontend/routeManifest.cjs. These tests keep
// that manifest honest against src/App.js so a new <Route> can never ship as
// a 404, and exercise the server's status/meta behaviour when a build exists.
const fs = require('fs');
const path = require('path');

const FRONTEND = path.join(__dirname, '..', '..', 'frontend');
const { KNOWN_ROUTES, isKnownRoute } = require(path.join(FRONTEND, 'routeManifest.cjs'));

describe('frontend/routeManifest.cjs', () => {
  test('every <Route path> in src/App.js is a known route', () => {
    const src = fs.readFileSync(path.join(FRONTEND, 'src', 'App.js'), 'utf8');
    const paths = [...src.matchAll(/path="([^"]+)"/g)].map((m) => m[1]).filter((p) => p !== '*');
    expect(paths.length).toBeGreaterThan(50);
    const missing = paths.filter((p) => {
      // Instantiate params so the pattern itself is matchable.
      const sample = p.replace(/:[a-zA-Z_]+/g, 'x').replace(/\/\*$/, '/anything/deep');
      return !isKnownRoute(sample);
    });
    expect(missing).toEqual([]);
  });

  test('every PUBLIC_META key in server.js is a known route', () => {
    const src = fs.readFileSync(path.join(FRONTEND, 'server.js'), 'utf8');
    const block = src.slice(src.indexOf('const PUBLIC_META = {'), src.indexOf('};', src.indexOf('const PUBLIC_META = {')));
    const keys = [...block.matchAll(/^\s+'(\/[^']*)':/gm)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThan(5);
    expect(keys.filter((k) => !isKnownRoute(k))).toEqual([]);
  });

  test('no manifest entry is dead (each one appears in App.js)', () => {
    const src = fs.readFileSync(path.join(FRONTEND, 'src', 'App.js'), 'utf8');
    const appPaths = new Set([...src.matchAll(/path="([^"]+)"/g)].map((m) => m[1]));
    expect(KNOWN_ROUTES.filter((r) => !appPaths.has(r))).toEqual([]);
  });

  test('matching semantics: params, wildcards, trailing slash, query string', () => {
    expect(isKnownRoute('/')).toBe(true);
    expect(isKnownRoute('/deals')).toBe(true);
    expect(isKnownRoute('/deals/')).toBe(true);
    expect(isKnownRoute('/deals?dealId=4')).toBe(true);
    expect(isKnownRoute('/contacts/123')).toBe(true);
    expect(isKnownRoute('/contacts/123/extra')).toBe(false);
    expect(isKnownRoute('/admin/anything/at/all')).toBe(true);
    expect(isKnownRoute('/crm-for/construction')).toBe(true);
    expect(isKnownRoute('/definitely-not-a-page')).toBe(false);
    expect(isKnownRoute('/wp-admin.php')).toBe(false);
    expect(isKnownRoute('/deals.json')).toBe(false);
  });
});

const buildIndex = path.join(FRONTEND, 'build', 'index.html');
const describeIfBuilt = fs.existsSync(buildIndex) ? describe : describe.skip;

describeIfBuilt('frontend/server.js soft-404 fix (needs a local build/)', () => {
  const request = require('supertest');
  // frontend/package.json is "type": "module", so server.js (CommonJS — the
  // Docker image has no such package.json) can't be required by its .js name
  // from here. Copy it to a .cjs sibling for the test so __dirname, ./build
  // and ./routeManifest.cjs all resolve exactly as they do in the container.
  const tmp = path.join(FRONTEND, '.server-under-test.cjs');
  let app;
  beforeAll(() => {
    // The frontend only installs express/compression inside the Docker
    // image, so let the copy resolve them from the backend's node_modules.
    const prelude = `module.paths.push(${JSON.stringify(path.join(__dirname, '..', 'node_modules'))});\n`;
    fs.writeFileSync(tmp, prelude + fs.readFileSync(path.join(FRONTEND, 'server.js'), 'utf8'));
    app = require(tmp);
  });
  afterAll(() => { try { fs.unlinkSync(tmp); } catch { /* already gone */ } });

  test('a known route is 200 with the shell', async () => {
    const res = await request(app).get('/deals');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/<div id="root">/);
    expect(res.text).not.toMatch(/noindex/);
  });

  test('an unknown route is a real 404, still the shell, noindexed, no canonical', async () => {
    const res = await request(app).get('/definitely-not-a-page');
    expect(res.status).toBe(404);
    expect(res.text).toMatch(/<div id="root">/);
    expect(res.text).toMatch(/<meta name="robots" content="noindex, nofollow">/);
    expect(res.text).not.toMatch(/rel="canonical"/);
    expect(res.text).toMatch(/<title>Page not found/);
  });

  test('a missing static asset is a 404, not an HTML document with a 200', async () => {
    const res = await request(app).get('/assets/nope-12345.js');
    expect(res.status).toBe(404);
  });
});
