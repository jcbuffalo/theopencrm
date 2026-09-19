// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// New-module capability topics (chatCapabilities) + the lead.create /
// case.create confirm-first specs (chatActions) — unit tests.
//
// The capability registry is what grounds how_do_i / list_modules: if a topic
// is missing or its gating flag drifts from services/featureFlags.js, the
// copilot starts inventing features again. These tests pin:
//   • every July-2026-wave module has a registry entry with a real route and
//     the same gating flag the /api mount uses (backend/index.js)
//   • lookup() resolves representative user phrasings to the right topic
//   • lead.create / case.create validate correctly and applyAction builds an
//     org-stamped INSERT (the write itself only ever runs from
//     POST /api/ai/actions/apply)

// describe / test / expect / vi are vitest globals.

const realPool = require('../db');
realPool.query = vi.fn();
realPool.connect = vi.fn();

const { CAPABILITIES, lookup } = require('../services/chatCapabilities');
const chatActions = require('../services/chatActions');
const featureFlags = require('../services/featureFlags');

const byTopic = Object.fromEntries(CAPABILITIES.map((c) => [c.topic, c]));

describe('new-module capability topics', () => {
  // topic -> [where, gating]. gating must match the requireFeature(...) mount
  // in backend/index.js (null = ungated core surface).
  const EXPECTED = {
    leads:            ['/leads',                'leads_enabled'],
    support_cases:    ['/cases',                'customer_success_enabled'],
    meetings_calendar:['/calendar',             null],
    segments:         ['/segments',             'customer_success_enabled'],
    email_sequences:  ['/sequences',            'campaigns_enabled'],
    surveys:          ['/surveys',              'customer_success_enabled'],
    playbooks:        ['/playbooks',            'customer_success_enabled'],
    winback:          ['/winback',              'customer_success_enabled'],
    notifications:    ['/notifications',        null],
    record_ownership: [null,                    null],
    tier_limits:      ['/settings#billing',     null], // the plan picker — caps are live, upgrade lifts them
    customer_portal:  ['/admin/feature-flags',  'portal_enabled'],
  };

  test('every new topic exists with the right route and gating flag', () => {
    for (const [topic, [where, gating]] of Object.entries(EXPECTED)) {
      const cap = byTopic[topic];
      expect(cap, `missing capability topic "${topic}"`).toBeDefined();
      expect(cap.where).toBe(where);
      expect(cap.gating).toBe(gating);
      expect(['live', 'config', 'roadmap', 'unsupported']).toContain(cap.status);
      expect(cap.summary.length).toBeGreaterThan(20);
      expect(cap.how.length).toBeGreaterThan(20);
      expect(cap.keywords.length).toBeGreaterThan(2);
    }
  });

  test('every non-null gating flag is a real registered flag', () => {
    const known = new Set((featureFlags.KNOWN_FLAGS || []).map((f) => f.name));
    for (const topic of Object.keys(EXPECTED)) {
      const g = byTopic[topic].gating;
      if (g !== null) expect(known.has(g), `"${g}" on ${topic} is not in KNOWN_FLAGS`).toBe(true);
    }
  });

  test('lookup() resolves representative user questions to the new topics', () => {
    const cases = [
      ['how do I capture leads from my website?',        'leads'],
      ['can I open a support ticket for a customer?',    'support_cases'],
      ['what upcoming meetings do I have on the calendar?', 'meetings_calendar'],
      ['can I run a bulk action on a segment?',          'segments'],
      ['how do I set up a drip campaign?',               'email_sequences'],
      ['do you support NPS surveys?',                    'surveys'],
      ['is there an onboarding checklist playbook?',     'playbooks'],
      ['how do I win back churned customers?',           'winback'],
      ['where is the notification center?',              'notifications'],
      ['can I filter to my records / who owns this?',    'record_ownership'],
      ['is there a plan limit or record limit?',         'tier_limits'],
      ['can I share a customer portal link?',            'customer_portal'],
    ];
    for (const [question, topic] of cases) {
      const hit = lookup(question);
      expect(hit, `no capability matched: "${question}"`).not.toBeNull();
      expect(hit.topic, `"${question}" resolved to ${hit && hit.topic}`).toBe(topic);
    }
  });

  test('pre-existing topics still win their own phrasings (no keyword shadowing)', () => {
    expect(lookup('can I import emails from my inbox?').topic).toBe('external_email_import');
    expect(lookup('how do I set up quickbooks?').topic).toBe('quickbooks');
    expect(lookup('can I bulk import contacts from a spreadsheet?').topic).toBe('csv_import');
  });
});

describe('lead.create / case.create confirm-first specs', () => {
  test('lead.create validates: name required, converted not proposable', () => {
    const ok = chatActions.validateAction({
      entity: 'lead', op: 'create',
      fields: { name: 'Jane Doe', company_name: 'Acme', source: 'referral', status: 'working' },
    });
    expect(ok.ok).toBe(true);
    expect(ok.action.summary).toMatch(/Jane Doe/);

    const noName = chatActions.validateAction({ entity: 'lead', op: 'create', fields: { email: 'x@y.z' } });
    expect(noName.ok).toBe(false);
    expect(noName.errors.some((e) => /name/.test(e))).toBe(true);

    // 'converted' is terminal and owned by the convert endpoint — never
    // proposable from chat.
    const converted = chatActions.validateAction({
      entity: 'lead', op: 'create', fields: { name: 'Sly', status: 'converted' },
    });
    expect(converted.ok).toBe(false);
    expect(converted.errors.some((e) => /status/.test(e))).toBe(true);
  });

  test('case.create validates: subject required, priority enum, company/contact refs', () => {
    const ok = chatActions.validateAction({
      entity: 'case', op: 'create',
      fields: { subject: 'Portal down', priority: 'urgent', company_id: 11, contact_id: 21 },
    });
    expect(ok.ok).toBe(true);
    // Referenced ids get ownership-checked against these tables at propose AND
    // apply time.
    const refs = chatActions.referencedIds(ok.action);
    expect(refs).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'company_id', table: 'companies', id: 11 }),
      expect.objectContaining({ field: 'contact_id', table: 'contacts', id: 21 }),
    ]));

    const badPriority = chatActions.validateAction({
      entity: 'case', op: 'create', fields: { subject: 'x', priority: 'apocalyptic' },
    });
    expect(badPriority.ok).toBe(false);

    const noSubject = chatActions.validateAction({ entity: 'case', op: 'create', fields: { priority: 'low' } });
    expect(noSubject.ok).toBe(false);
  });

  test('specs carry the module flag both gates (propose + apply) enforce', () => {
    expect(chatActions.SPECS['lead.create'].flag).toBe('leads_enabled');
    expect(chatActions.SPECS['case.create'].flag).toBe('customer_success_enabled');
  });

  test('applyAction builds an org-stamped INSERT for lead.create', async () => {
    const client = {
      calls: [],
      query: vi.fn(function (sql, params) {
        this.calls.push([sql, params]);
        return Promise.resolve({ rows: [{ id: 77 }] });
      }),
    };
    const v = chatActions.validateAction({
      entity: 'lead', op: 'create', fields: { name: 'Jane Doe', source: 'referral' },
    });
    expect(v.ok).toBe(true);
    const row = await chatActions.applyAction(client, v.action, {
      sf: 'org_id', sv: 7, userId: 4242, orgId: 7,
    });
    expect(row).toEqual({ id: 77 });
    const [sql, params] = client.calls[0];
    expect(sql).toMatch(/INSERT INTO leads/i);
    // Tenant stamp comes first, straight from the server-side scope.
    expect(sql).toMatch(/\(user_id, org_id/);
    expect(params[0]).toBe(4242);
    expect(params[1]).toBe(7);
    expect(params).toContain('Jane Doe');
  });
});
