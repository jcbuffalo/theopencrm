// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Regenerate backend/data/platformWorkspaceTemplates.json — the starter
// gallery (spec 203 Phase 2) — by running the first-run planner's draft step
// once per static template in services/onboardingTemplates.js. Org-less: the
// context is the generic default pipeline with no custom fields, so the output
// is portable. Review the diff before committing; the file is seeded at boot
// by services/workspaceTemplates.seedPlatformTemplates (idempotent upsert).
//
//   ANTHROPIC_API_KEY=... node scripts/generate-platform-templates.js [slug ...]
//
// Never logs the key. Exits non-zero if any template failed so CI-ish runs
// don't silently ship a partial gallery.

const fs = require('fs');
const path = require('path');

process.env.NODE_ENV = process.env.NODE_ENV || 'development';

const pipelines = require('../services/pipelines');
const planner = require('../services/onboardingPlanner');
const wt = require('../services/workspaceTemplates');
const staticTemplates = require('../services/onboardingTemplates');

const OUT = path.join(__dirname, '..', 'data', 'platformWorkspaceTemplates.json');

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY is required in the environment.');
    process.exit(2);
  }
  const only = process.argv.slice(2);
  const stages = pipelines.defaultStagesFor('generic');
  const ctx = {
    current: { profile: 'generic', name: 'Pipeline', stages, is_custom: false },
    existingFields: [],
    automationEnabled: true,
  };

  let existing = [];
  try { existing = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch { /* first run */ }
  const bySlug = new Map(existing.map((t) => [t.slug, t]));

  const failed = [];
  for (const t of staticTemplates.TEMPLATES) {
    if (only.length && !only.includes(t.id)) continue;
    process.stdout.write(`drafting ${t.id}… `);
    const drafted = await planner.draftRaw({ orgId: null, userId: null, description: t.description, ctx });
    if (!drafted.ok) { console.log(`FAILED (${drafted.code}: ${drafted.error})`); failed.push(t.id); continue; }
    const v = wt.validateConfig(drafted.raw);
    if (!v.ok) { console.log(`INVALID (${v.errors.join('; ')})`); failed.push(t.id); continue; }
    const c = v.config;
    console.log(`ok — ${c.pipeline ? c.pipeline.stages.length : 0} stages, ${c.fields.length} fields, ${c.automations.length} automations, ${c.views.length} views`);
    bySlug.set(t.id, {
      slug: t.id,
      name: t.name,
      tagline: t.tagline,
      vertical: t.id,
      description: t.description,
      config: c,
    });
  }

  const ordered = staticTemplates.TEMPLATES.map((t) => bySlug.get(t.id)).filter(Boolean);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(ordered, null, 2) + '\n');
  console.log(`wrote ${ordered.length} templates → ${path.relative(process.cwd(), OUT)}`);
  if (failed.length) { console.error(`failed: ${failed.join(', ')}`); process.exit(1); }
}

main().then(() => process.exit(0)).catch((err) => { console.error(err.message || err); process.exit(1); });
