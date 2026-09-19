// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// The starter gallery file (backend/data/platformWorkspaceTemplates.json) is
// reviewed code. Pin what makes it safe to seed blindly at boot: every entry
// validates, slugs match the 12 static "describe" templates one-to-one, each
// pipeline has a won + lost stage and reasonable size, automations reference
// real stages, and the boot seeder upserts by slug with org_id NULL.

// describe / test / expect / vi are vitest globals.

const realPool = require('../db');
const mockPool = realPool;
mockPool.query = vi.fn();

const wt = require('../services/workspaceTemplates');
const staticTemplates = require('../services/onboardingTemplates');
const chatActions = require('../services/chatActions');
const planner = require('../services/onboardingPlanner');

const entries = wt.loadPlatformFile();

describe('platformWorkspaceTemplates.json', () => {
  test('one entry per static template, same slugs', () => {
    expect(entries.map((e) => e.slug).sort()).toEqual(staticTemplates.TEMPLATES.map((t) => t.id).sort());
    for (const e of entries) {
      const s = staticTemplates.getTemplate(e.slug);
      expect(e.name, e.slug).toBe(s.name);
      expect(e.vertical, e.slug).toBe(e.slug);
      expect(typeof e.description === 'string' && e.description.length > 40, e.slug).toBe(true);
    }
  });

  test.each(entries.map((e) => [e.slug, e]))('%s validates and is a sensible starter', (slug, e) => {
    const v = wt.validateConfig(e.config);
    expect(v.ok, `${slug}: ${v.errors.join('; ')}`).toBe(true);
    const stages = v.config.pipeline.stages;
    expect(stages.length).toBeGreaterThanOrEqual(5);
    expect(stages.length).toBeLessThanOrEqual(9);
    expect(stages.filter((s) => s.is_won).length).toBe(1);
    expect(stages.filter((s) => s.is_lost).length).toBeGreaterThanOrEqual(1);
    // Won/lost last; ids unique and slugged.
    const lastTwo = stages.slice(-2);
    expect(lastTwo.some((s) => s.is_won) && lastTwo.some((s) => s.is_lost)).toBe(true);
    expect(new Set(stages.map((s) => s.id)).size).toBe(stages.length);
    expect(v.config.fields.length).toBeGreaterThanOrEqual(2);
    expect(v.config.fields.length).toBeLessThanOrEqual(6);
    expect(v.config.automations.length).toBeGreaterThanOrEqual(1);
    expect(v.config.views.length).toBeGreaterThanOrEqual(1);
    // Every field has a why (the card shows it) and no reserved-column clash.
    for (const f of v.config.fields) {
      expect(typeof f.why === 'string' && f.why.length > 3, `${slug}.${f.name}`).toBe(true);
      expect(chatActions.validateAction({ entity: 'custom_field', op: 'create', fields: { entity: f.entity, name: f.name, type: f.type, ...(f.options ? { options: f.options } : {}) } }).ok, `${slug}.${f.name}`).toBe(true);
    }
  });

  test('cloning any starter into a fresh generic org yields apply-clean proposals for every piece', async () => {
    // Fresh org context: generic default pipeline, no fields, automation on.
    const pipelines = require('../services/pipelines');
    const ctx = {
      current: { profile: 'generic', name: 'Pipeline', stages: pipelines.defaultStagesFor('generic'), is_custom: false },
      existingFields: [],
      automationEnabled: true,
    };
    mockPool.query.mockResolvedValue({ rows: [] }); // dealCountsByStage → no deals
    for (const e of entries) {
      const plan = await planner.assemblePlan({ orgId: 1, raw: e.config, ctx });
      const expected = 1 + e.config.fields.length + e.config.automations.length + e.config.views.length;
      expect(plan.proposals.length, `${e.slug}: skipped ${JSON.stringify(plan.skipped)}`).toBe(expected);
      for (const p of plan.proposals) expect(chatActions.validateAction(p.proposal).ok, `${e.slug} ${p.label}`).toBe(true);
    }
  });
});

describe('seedPlatformTemplates', () => {
  test('upserts every entry as a public platform row (org_id NULL) keyed by slug; never throws', async () => {
    mockPool.query.mockReset();
    mockPool.query.mockResolvedValue({ rows: [] });
    const log = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const out = await wt.seedPlatformTemplates({ log });
    expect(out.seeded).toBe(entries.length);
    expect(out.failed).toEqual([]);
    expect(mockPool.query).toHaveBeenCalledTimes(entries.length);
    const [sql, params] = mockPool.query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO workspace_templates \(org_id, created_by, slug/);
    expect(sql).toMatch(/VALUES \(NULL, NULL, \$1/);
    expect(sql).toMatch(/ON CONFLICT \(\(COALESCE\(org_id, 0\)\), slug\) DO UPDATE/);
    expect(params[0]).toBe(entries[0].slug);
    expect(JSON.parse(params[5]).pipeline.stages[0].id).toBeTruthy();
    expect(log.log).toHaveBeenCalledWith(expect.stringMatching(/seeded \(12\)/));
  });

  test('a DB error on one row is reported, not thrown', async () => {
    mockPool.query.mockReset();
    mockPool.query.mockRejectedValueOnce(new Error('boom')).mockResolvedValue({ rows: [] });
    const log = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const out = await wt.seedPlatformTemplates({ log });
    expect(out.seeded).toBe(entries.length - 1);
    expect(out.failed).toEqual([{ slug: entries[0].slug, error: 'boom' }]);
    expect(log.warn).toHaveBeenCalled();
  });
});
