// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Marketing verticals <-> onboarding templates parity (spec 203, Phase 3).
//
// frontend/src/marketing/verticals.js is an ES module the backend cannot
// require(), so it is read as TEXT and the `id: '...'` literals are pulled
// out. The set must equal TEMPLATES.map(t => t.id): a template with no
// landing page (or a page for a template that no longer exists) fails here.
//
// describe / test / expect are vitest globals.

const fs = require('fs');
const path = require('path');
const { TEMPLATES } = require('../services/onboardingTemplates');

const VERTICALS_PATH = path.join(__dirname, '..', '..', 'frontend', 'src', 'marketing', 'verticals.js');

function readVerticalIds() {
  const src = fs.readFileSync(VERTICALS_PATH, 'utf8');
  // Only the top-level entries declare `id:`; the file has no nested objects
  // with an id key, and the regex anchors on the line start to stay that way.
  const ids = [];
  const re = /^\s{4}id:\s*'([a-z0-9_]+)'\s*,\s*$/gm;
  let m;
  while ((m = re.exec(src)) !== null) ids.push(m[1]);
  return ids;
}

function readVerticalSlugs() {
  const src = fs.readFileSync(VERTICALS_PATH, 'utf8');
  const slugs = [];
  const re = /^\s{4}slug:\s*'([a-z0-9-]+)'\s*,\s*$/gm;
  let m;
  while ((m = re.exec(src)) !== null) slugs.push(m[1]);
  return slugs;
}

describe('marketing verticals mirror onboarding templates', () => {
  test('the vertical id set equals the template id set', () => {
    const verticalIds = readVerticalIds();
    const templateIds = TEMPLATES.map((t) => t.id);
    expect(verticalIds.length).toBeGreaterThan(0);
    expect(new Set(verticalIds).size).toBe(verticalIds.length); // no duplicate pages
    expect([...verticalIds].sort()).toEqual([...templateIds].sort());
  });

  test('every vertical has a unique hyphenated slug (the /crm-for/:slug URL)', () => {
    const slugs = readVerticalSlugs();
    const ids = readVerticalIds();
    expect(slugs.length).toBe(ids.length);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const s of slugs) expect(s).not.toMatch(/_/);
  });

  test('server.js PUBLIC_META and sitemap.xml carry every vertical URL', () => {
    const slugs = readVerticalSlugs();
    const serverSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'server.js'), 'utf8');
    const sitemap = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'public', 'sitemap.xml'), 'utf8');
    for (const s of slugs) {
      expect(serverSrc).toContain(`'/crm-for/${s}':`);
      expect(sitemap).toContain(`https://app.theopencrm.com/crm-for/${s}</loc>`);
    }
    for (const p of ['/hubspot-alternative', '/salesforce-alternative', '/pipedrive-alternative', '/zoho-alternative', '/spreadsheet-crm', '/custom-crm-alternative']) {
      expect(serverSrc).toContain(`'${p}':`);
      expect(sitemap).toContain(`https://app.theopencrm.com${p}</loc>`);
    }
  });
});
