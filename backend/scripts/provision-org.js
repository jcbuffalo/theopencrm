#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

/**
 * Provision a customer organization end-to-end.
 *
 * Idempotent + transactional. Use --dry-run to print the exact plan without
 * touching the database. Reusable for every future customer; the Northwind
 * onboarding (May 2026) was the first real use.
 *
 * Two modes:
 *   --mode rename-existing  (default)
 *     Renames the admin user's existing personal-workspace org, updates its
 *     profile + branding, and re-affirms them as owner. Cleanest path when
 *     the admin already self-registered and we want to brand their workspace
 *     as the customer org without losing whatever they've already entered.
 *
 *   --mode create-new
 *     Creates a fresh org with the given name (errors if the name is taken)
 *     and moves the admin user into it as owner. Use when the admin's
 *     personal workspace must stay separate (e.g. they were just evaluating).
 *
 * Examples:
 *
 *   # Dry-run for the first real customer (the first hosted customer):
 *   cd backend && node scripts/provision-org.js \
 *     --name "Northwind" \
 *     --profile generic \
 *     --admin-email johnosberg@gmail.com \
 *     --mode rename-existing \
 *     --branding '{"displayName":"Northwind","primaryColor":"#2076CD","labels":{"deal":"Contract"}}' \
 *     --seed-demo \
 *     --dry-run
 *
 *   # Then drop --dry-run to apply.
 *
 * Database connection: uses backend/db.js, which reads the standard env
 * (DB_USER, DB_PASSWORD, DB_NAME, plus INSTANCE_CONNECTION_NAME when going
 * through the Cloud SQL Auth Proxy). Run from inside backend/ so module
 * resolution finds db.js / services/* the same way the server does.
 *
 * Architecture note (2026-06): the actual DB logic now lives in
 * `backend/services/orgProvisioner.js` so the new `POST /api/admin/provision-org`
 * REST endpoint and this CLI share one code path. This file is the thin CLI
 * shell: arg parsing, console reporting, and process exit codes.
 *
 * Exit codes:
 *   0  Success (or dry-run completed cleanly)
 *   1  Admin user not found / not active
 *   2  Validation error (bad flag, bad JSON, etc.)
 *   3  Org-existence collision (mode=create-new but name already in use)
 *   4  Transaction failed and rolled back
 *  99  Unhandled error (stack trace on stderr)
 */

const pool = require('../db');
const { provisionOrg, ProvisionError, VALID_PROFILES, VALID_MODES } = require('../services/orgProvisioner');

// ─── arg parsing ─────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      args[key] = next;
      i++;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function validate(raw) {
  const errs = [];
  if (!raw.name) errs.push('--name is required');
  const profile = raw.profile || 'generic';
  if (!VALID_PROFILES.includes(profile)) {
    errs.push(`--profile must be one of: ${VALID_PROFILES.join(', ')}`);
  }
  if (!raw['admin-email']) errs.push('--admin-email is required');
  const mode = raw.mode || 'rename-existing';
  if (!VALID_MODES.includes(mode)) {
    errs.push(`--mode must be one of: ${VALID_MODES.join(', ')}`);
  }

  let branding = {};
  if (raw.branding) {
    try {
      branding = JSON.parse(raw.branding);
    } catch (e) {
      errs.push(`--branding must be valid JSON: ${e.message}`);
    }
    if (typeof branding !== 'object' || Array.isArray(branding) || branding === null) {
      errs.push('--branding must be a JSON object');
    }
  }

  let featureFlags = {};
  if (raw['feature-flags']) {
    try {
      featureFlags = JSON.parse(raw['feature-flags']);
    } catch (e) {
      errs.push(`--feature-flags must be valid JSON: ${e.message}`);
    }
    if (typeof featureFlags !== 'object' || Array.isArray(featureFlags) || featureFlags === null) {
      errs.push('--feature-flags must be a JSON object');
    }
  }

  if (errs.length) {
    for (const e of errs) console.error(`✗ ${e}`);
    console.error('');
    console.error('See the file header in backend/scripts/provision-org.js for usage examples.');
    process.exit(2);
  }

  // displayName defaults to the org name if the caller didn't supply one.
  // Nav uses orgBranding.displayName as the org-name override; keeping
  // displayName === name unless they explicitly disagree is the boring win.
  if (!branding.displayName) branding.displayName = raw.name;

  return {
    name: String(raw.name),
    profile,
    adminEmail: String(raw['admin-email']),
    mode,
    branding,
    featureFlags,
    seedDemo: !!raw['seed-demo'],
    dryRun: !!raw['dry-run'],
  };
}

// ─── exit-code mapping ───────────────────────────────────────────────────────
//
// Preserves the original byte-identical exit codes documented in the header.

function exitCodeForProvisionError(code) {
  switch (code) {
    case 'validation':           return 2;
    case 'user_not_found':       return 1;
    case 'user_not_active':      return 1;
    case 'no_existing_org':      return 1;
    case 'org_name_collision':   return 3;
    case 'unknown_feature_flag': return 2;
    case 'tx_failed':            return 4;
    default:                     return 99;
  }
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = validate(parseArgs(process.argv.slice(2)));

  console.log('━━━ Provision Org ━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  Org name:      ${args.name}`);
  console.log(`  Profile:       ${args.profile}`);
  console.log(`  Admin email:   ${args.adminEmail}`);
  console.log(`  Mode:          ${args.mode}`);
  console.log(`  Branding:      ${JSON.stringify(args.branding)}`);
  console.log(`  Feature flags: ${JSON.stringify(args.featureFlags)}`);
  console.log(`  Seed demo:     ${args.seedDemo ? 'yes' : 'no'}`);
  console.log(`  Dry-run:       ${args.dryRun ? 'YES (no writes)' : 'no — will write'}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  let result;
  try {
    result = await provisionOrg({
      name: args.name,
      profile: args.profile,
      adminEmail: args.adminEmail,
      mode: args.mode,
      branding: args.branding,
      featureFlags: args.featureFlags,
      seedDemo: args.seedDemo,
      dryRun: args.dryRun,
      actorUserId: null, // CLI runs as the operator; no in-app user context
    });
  } catch (err) {
    if (err instanceof ProvisionError) {
      console.error(`✗ ${err.message}`);
      await pool.end().catch(() => {});
      process.exit(exitCodeForProvisionError(err.code));
    }
    throw err;
  }

  // Report the same line-for-line shape the original script printed so any
  // downstream log scrapers / runbook expectations keep working.
  console.log(`✓ Found admin user: email=${result.userEmail}`);
  if (result.summary.existingDataCounts) {
    const c = result.summary.existingDataCounts;
    console.log(`✓ Existing org id=${result.orgId ?? '(new)'} — deals=${c.deals} companies=${c.companies} contacts=${c.contacts}`);
    if (c.deals + c.companies + c.contacts > 0) {
      console.log('  ⚠ NOTE: existing org has data. Rename/branding preserves it; --seed-demo (if set) adds more on top of what exists.');
    }
  }

  console.log('');
  console.log(`Plan: ${result.action} org "${args.name}" (profile=${args.profile}) and link ${result.userEmail} as owner.`);
  console.log('');

  if (args.dryRun) {
    console.log('[--dry-run] No writes performed. Re-run without --dry-run to apply.');
    await pool.end().catch(() => {});
    process.exit(0);
  }

  if (result.action === 'create') {
    console.log(`✓ Created org id=${result.orgId}`);
  } else {
    console.log(`✓ Updated org id=${result.orgId}: name="${args.name}", profile="${args.profile}", branding merged`);
  }
  console.log(`✓ Linked ${result.userEmail} as org_role='owner' on org ${result.orgId}`);

  if (result.summary.featureFlagsSet?.length) {
    console.log(`✓ Feature flags set: ${result.summary.featureFlagsSet.join(', ')}`);
  }
  if (result.summary.featureFlagErrors?.length) {
    for (const e of result.summary.featureFlagErrors) {
      console.warn(`⚠ Feature flag "${e.name}" failed: ${e.error}`);
    }
  }

  if (result.summary.demoSeedResult) {
    if (result.summary.demoSeedResult.error) {
      console.warn(`⚠ Demo seed failed (provision still applied): ${result.summary.demoSeedResult.error}`);
    } else {
      console.log(`✓ Demo data seeded for profile=${args.profile}`);
    }
  }

  console.log('✓ Audit log entry recorded');
  console.log('');
  console.log('━━━ DONE ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`✓ ${result.userEmail} can now sign in to org "${args.name}" (id=${result.orgId}).`);
  console.log('  Verify branding:  https://app.theopencrm.com/admin/branding');
  console.log('  Verify pipeline:  https://app.theopencrm.com/deals');
  console.log('  Wipe demo later:  POST /api/demo/wipe   (admin-only, only removes [demo]-tagged rows)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  await pool.end().catch(() => {});
  process.exit(0);
}

main().catch(async (err) => {
  console.error('✗ Unhandled error:', err);
  await pool.end().catch(() => {});
  process.exit(99);
});
