// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Org provisioning service.
//
// Single source of truth for "stand up a new customer org and link an admin
// user as its owner." Used by:
//
//   1. backend/scripts/provision-org.js   — CLI (Cloud SQL proxy + Node)
//   2. POST /api/admin/provision-org      — super-admin REST endpoint (browser)
//
// Both surfaces share the same code path so a fix lands in one place. The CLI
// stays a thin arg-parser + reporter; the REST endpoint stays a thin auth +
// JSON-response wrapper. All actual DB work lives here.
//
// Two modes:
//   - 'rename-existing' — repurposes the admin user's existing personal-
//     workspace org as the customer org. Keeps whatever they've already
//     entered (deals, contacts, etc.) and re-brands the wrapper. Cleanest
//     path when the admin self-registered first.
//   - 'create-new'      — creates a fresh org with the given name and links
//     the admin user into it as owner. Use when the admin's personal
//     workspace must remain separate.
//
// dryRun: true performs every read (so the caller sees the exact plan and any
// validation failures), but performs ZERO writes. The audit row still fires —
// with dryRun: true in meta — so a forensic reader can spot "someone modeled
// this before they did it."

const pool = require('../db');
const audit = require('./audit');
const featureFlags = require('./featureFlags');

const VALID_PROFILES = ['generic', 'zang', 'jcp'];
const VALID_MODES = ['rename-existing', 'create-new'];

// Sentinel error class so the caller (CLI or HTTP) can map structured errors
// to its native idiom (exit codes / HTTP status codes) without parsing strings.
class ProvisionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ProvisionError';
    this.code = code; // 'validation' | 'user_not_found' | 'user_not_active' | 'no_existing_org' | 'org_name_collision' | 'unknown_feature_flag' | 'tx_failed'
    this.details = details;
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

async function findUserByEmail(client, email) {
  const r = await client.query(
    'SELECT id, email, name, status, org_id, org_role FROM users WHERE LOWER(email) = LOWER($1)',
    [email]
  );
  return r.rows[0] || null;
}

async function findOrgByName(client, name) {
  const r = await client.query(
    'SELECT id, name FROM organizations WHERE name = $1 LIMIT 1',
    [name]
  );
  return r.rows[0] || null;
}

// Counts in the admin user's existing workspace so the caller can warn the
// operator before a rename ("your existing 7 deals will move under the new
// name"). Pure read; never blocks.
async function countOrgData(client, orgId) {
  const r = await client.query(
    `SELECT
       (SELECT COUNT(*) FROM deals      WHERE org_id = $1)::int AS deals,
       (SELECT COUNT(*) FROM companies  WHERE org_id = $1)::int AS companies,
       (SELECT COUNT(*) FROM contacts   WHERE org_id = $1)::int AS contacts`,
    [orgId]
  );
  return r.rows[0] || { deals: 0, companies: 0, contacts: 0 };
}

function normalizeInput(raw) {
  const errs = [];
  const name = raw.name && String(raw.name).trim();
  if (!name) errs.push('name is required');

  const profile = raw.profile || 'generic';
  if (!VALID_PROFILES.includes(profile)) {
    errs.push(`profile must be one of: ${VALID_PROFILES.join(', ')}`);
  }

  const adminEmail = raw.adminEmail && String(raw.adminEmail).trim();
  if (!adminEmail) errs.push('adminEmail is required');

  const mode = raw.mode || 'rename-existing';
  if (!VALID_MODES.includes(mode)) {
    errs.push(`mode must be one of: ${VALID_MODES.join(', ')}`);
  }

  let branding = raw.branding;
  if (branding == null) branding = {};
  if (typeof branding !== 'object' || Array.isArray(branding)) {
    errs.push('branding must be a JSON object');
    branding = {};
  }

  // Default displayName to org name unless the caller explicitly disagrees.
  if (name && !branding.displayName) branding.displayName = name;

  let featureFlagsObj = raw.featureFlags;
  if (featureFlagsObj == null) featureFlagsObj = {};
  if (typeof featureFlagsObj !== 'object' || Array.isArray(featureFlagsObj)) {
    errs.push('featureFlags must be a JSON object');
    featureFlagsObj = {};
  }

  // Validate every requested flag against the KNOWN_FLAGS registry. Silent
  // swallow would let typos like `plugin_enabled` create the row without
  // actually unlocking the surface — surface the typo as a 400 instead.
  const knownNames = new Set(featureFlags.KNOWN_FLAGS.map((f) => f.name));
  const unknown = Object.keys(featureFlagsObj).filter((k) => !knownNames.has(k));
  if (unknown.length) {
    errs.push(`unknown feature flag(s): ${unknown.join(', ')}`);
  }

  if (errs.length) {
    throw new ProvisionError('validation', errs.join('; '), { errors: errs });
  }

  return {
    name,
    profile,
    adminEmail,
    mode,
    branding,
    featureFlags: featureFlagsObj,
    seedDemo: !!raw.seedDemo,
    dryRun: !!raw.dryRun,
    actorUserId: raw.actorUserId || null,
  };
}

// ─── public entrypoint ───────────────────────────────────────────────────────

/**
 * Provision an organization. Returns:
 *   {
 *     ok: true,
 *     action: 'rename' | 'create',
 *     orgId: number,
 *     userEmail: string,
 *     summary: {
 *       name, profile, mode, branding, featureFlagsSet: string[],
 *       seedDemo, dryRun,
 *       existingDataCounts?: { deals, companies, contacts },
 *       demoSeedResult?: { ... } | { error: string },
 *     }
 *   }
 *
 * Throws ProvisionError for validation / business-rule failures. Lets unknown
 * DB errors bubble.
 */
async function provisionOrg(rawInput) {
  const input = normalizeInput(rawInput);

  // 1. Find the admin user (pool read — no transaction needed for the lookups
  //    or the dry-run path).
  const user = await findUserByEmail(pool, input.adminEmail);
  if (!user) {
    throw new ProvisionError(
      'user_not_found',
      `No user found with email ${input.adminEmail}. Has the admin registered + been approved at /admin/access-requests?`
    );
  }
  if (user.status !== 'active') {
    throw new ProvisionError(
      'user_not_active',
      `User ${user.email} is not active (status=${user.status}). Approve them in /admin/access-requests first.`,
      { status: user.status }
    );
  }

  // 2. Plan the org change.
  let action;
  let targetOrgId;
  let existingDataCounts = null;

  if (input.mode === 'rename-existing') {
    if (!user.org_id) {
      throw new ProvisionError(
        'no_existing_org',
        'User has no existing org and mode=rename-existing was specified. Use mode=create-new.'
      );
    }
    targetOrgId = user.org_id;
    existingDataCounts = await countOrgData(pool, targetOrgId);
    action = 'rename';
  } else {
    const dupe = await findOrgByName(pool, input.name);
    if (dupe) {
      throw new ProvisionError(
        'org_name_collision',
        `Org "${input.name}" already exists (id=${dupe.id}). Use mode=rename-existing or pick a different name.`,
        { existingOrgId: dupe.id }
      );
    }
    action = 'create';
  }

  // 3. Build the result skeleton that's identical for dry-run and real-run.
  const featureFlagsSet = Object.keys(input.featureFlags);
  const summary = {
    name: input.name,
    profile: input.profile,
    mode: input.mode,
    branding: input.branding,
    featureFlagsSet,
    seedDemo: input.seedDemo,
    dryRun: input.dryRun,
  };
  if (existingDataCounts) summary.existingDataCounts = existingDataCounts;

  // 4. Audit BEFORE any writes — including dry-runs. Best-effort: a failed
  //    audit write must not block the provision (matching audit.js contract).
  await audit.record({
    event: audit.EVENTS.ORG_PROVISIONED,
    actorUserId: input.actorUserId,
    orgId: action === 'rename' ? targetOrgId : null,
    targetType: 'organization',
    targetId: action === 'rename' ? String(targetOrgId) : null,
    meta: {
      action,
      name: input.name,
      profile: input.profile,
      branding: input.branding,
      adminEmail: input.adminEmail,
      featureFlagsSet,
      seedDemo: input.seedDemo,
      actorUserId: input.actorUserId,
      dryRun: input.dryRun,
    },
  });

  if (input.dryRun) {
    return {
      ok: true,
      action,
      orgId: action === 'rename' ? targetOrgId : null,
      userEmail: user.email,
      summary,
    };
  }

  // 5. Apply in a transaction. Org create/update + user link must succeed
  //    together. Feature flags are applied AFTER commit (separate UPDATEs in
  //    featureFlags.setFeature; idempotent, safe to retry) so a flag failure
  //    can't roll back a successful provision.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const brandingJson = JSON.stringify(input.branding);

    if (action === 'create') {
      const ins = await client.query(
        `INSERT INTO organizations (name, owner_user_id, profile, branding)
         VALUES ($1, $2, $3, $4::jsonb)
         RETURNING id`,
        [input.name, user.id, input.profile, brandingJson]
      );
      targetOrgId = ins.rows[0].id;
    } else {
      // JSONB `||` merges top-level keys — partial branding updates (e.g.
      // just a logoUrl) won't clobber the existing displayName.
      await client.query(
        `UPDATE organizations
            SET name = $1,
                profile = $2,
                branding = COALESCE(branding, '{}'::jsonb) || $3::jsonb,
                updated_at = NOW()
          WHERE id = $4`,
        [input.name, input.profile, brandingJson, targetOrgId]
      );
    }

    await client.query(
      `UPDATE users SET org_id = $1, org_role = 'owner', updated_at = NOW() WHERE id = $2`,
      [targetOrgId, user.id]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw new ProvisionError(
      'tx_failed',
      `Provision transaction failed and rolled back: ${err.message}`,
      { cause: err.message }
    );
  } finally {
    client.release();
  }

  summary.orgId = targetOrgId;

  // 6. Apply each requested feature flag. Per-flag try so one bad flag doesn't
  //    skip the others; bubble any errors back as a structured warning.
  const flagErrors = [];
  for (const [name, value] of Object.entries(input.featureFlags)) {
    try {
      await featureFlags.setFeature(targetOrgId, name, Boolean(value));
    } catch (e) {
      flagErrors.push({ name, error: e.message });
    }
  }
  if (flagErrors.length) summary.featureFlagErrors = flagErrors;

  // 7. Optional demo seed. Best-effort: failure does NOT roll back the
  //    provision — the org is already there and can be re-seeded later via
  //    POST /api/admin/demo/seed.
  if (input.seedDemo) {
    try {
      const { seedForUser } = require('./demoSeeder');
      const seedResult = await seedForUser({
        userId: user.id,
        orgId: targetOrgId,
        profile: input.profile,
      });
      summary.demoSeedResult = seedResult;
    } catch (e) {
      summary.demoSeedResult = { error: e.message };
    }
  }

  return {
    ok: true,
    action,
    orgId: targetOrgId,
    userEmail: user.email,
    summary,
  };
}

module.exports = {
  provisionOrg,
  ProvisionError,
  VALID_PROFILES,
  VALID_MODES,
};
