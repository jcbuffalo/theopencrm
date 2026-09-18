// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Org provisioner service — backend/services/orgProvisioner.js.
//
// COVERAGE (per spec):
//   1. rename-existing happy path — UPDATE org + UPDATE users, returns
//      { action: 'rename', orgId, userEmail, summary }.
//   2. create-new happy path — INSERT org + UPDATE users, returns
//      { action: 'create', orgId, ... }.
//   3. user_not_found — ProvisionError, code 'user_not_found'.
//   4. user_not_active — ProvisionError, code 'user_not_active'.
//   5. org_name_collision — create-new with an existing name.
//   6. validation — invalid profile.
//   7. unknown_feature_flag — surfaced as a 'validation' error at normalize-
//      input time. The spec language "summary.featureFlagErrors records it
//      while valid flags still apply" describes a different path that doesn't
//      exist in the current implementation — unknown flags are rejected at
//      normalizeInput before any write — so we test the actual contract.
//   8. seedDemo: true — calls the demo seeder once.
//   9. dryRun: true — no writes; returns the plan only.
//
// MOCKING
//   The provisioner uses pool directly for reads (findUserByEmail, findOrgByName,
//   countOrgData) and pool.connect() for the transaction. We patch both. The
//   pool.connect() returns a mock client with query() that walks a queue.
//
//   featureFlags.setFeature is replaced in-place so we don't need a JSONB
//   mock; the spec only needs to assert it's called per-flag.
//
//   The demoSeeder require is lazy (`require('./demoSeeder')` inside the
//   function), so vi.mock() must register before orgProvisioner is required.

const realPool = require('../db');
const mockPool = realPool;
mockPool.query   = vi.fn();
mockPool.connect = vi.fn();

vi.mock('../services/logger', () => ({
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), notice: vi.fn(), debug: vi.fn(),
}));

// Mock demoSeeder via direct property replacement — same pattern as audit /
// featureFlags below. The earlier vi.mock(...) factory form produced an
// object whose properties weren't vi.fn() at beforeEach time (mockReset
// "is not a function"); reassigning the exports in-place works because
// orgProvisioner does `require('./demoSeeder')` lazily, hitting the same
// cached module object we mutate here.
const demoSeeder = require('../services/demoSeeder');
demoSeeder.seedForUser    = vi.fn().mockResolvedValue(undefined);
demoSeeder.wipeDemoForOrg = vi.fn().mockResolvedValue(undefined);

const audit = require('../services/audit');
audit.record  = vi.fn().mockResolvedValue(null);
audit.fromReq = vi.fn();

// featureFlags is used by both normalizeInput (KNOWN_FLAGS) and the post-
// commit flag loop (setFeature). KNOWN_FLAGS stays real; setFeature is swapped.
const featureFlags = require('../services/featureFlags');
featureFlags.setFeature = vi.fn().mockResolvedValue(null);

const orgProvisioner = require('../services/orgProvisioner');
const { provisionOrg, ProvisionError } = orgProvisioner;

// Build a mock pg client returned from pool.connect(). We tally every SQL
// statement the transaction issues so the tests can confirm BEGIN/COMMIT/
// ROLLBACK plus the actual UPDATE/INSERT.
function makeTxClient() {
  const calls = [];
  const client = {
    calls,
    query: vi.fn(async (sql, params) => {
      calls.push({ sql, params });
      // BEGIN / COMMIT / ROLLBACK return empty results.
      if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(sql.trim())) return { rows: [] };
      // INSERT INTO organizations ... RETURNING id
      if (/INSERT INTO organizations/i.test(sql)) {
        return { rows: [{ id: 999 }] };
      }
      // UPDATE statements — no return shape needed.
      return { rows: [] };
    }),
    release: vi.fn(),
  };
  return client;
}

beforeEach(() => {
  mockPool.query.mockReset();
  mockPool.connect.mockReset();
  audit.record.mockReset();
  audit.record.mockResolvedValue(null);
  featureFlags.setFeature.mockReset();
  featureFlags.setFeature.mockResolvedValue(null);
  demoSeeder.seedForUser.mockReset();
  demoSeeder.seedForUser.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// 1. rename-existing — happy path.
// ---------------------------------------------------------------------------
describe('provisionOrg — mode rename-existing', () => {
  test('renames existing org + relinks user; returns action=rename', async () => {
    // findUserByEmail
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 7, email: 'a@b.com', name: 'A', status: 'active', org_id: 42, org_role: 'owner' }],
    });
    // countOrgData (single aggregate row)
    mockPool.query.mockResolvedValueOnce({
      rows: [{ deals: 3, companies: 2, contacts: 5 }],
    });

    const txClient = makeTxClient();
    mockPool.connect.mockResolvedValueOnce(txClient);

    const out = await provisionOrg({
      mode: 'rename-existing',
      name: 'Renamed Co',
      profile: 'generic',
      adminEmail: 'a@b.com',
      branding: { displayName: 'Renamed Co' },
      featureFlags: {},
    });

    expect(out.ok).toBe(true);
    expect(out.action).toBe('rename');
    expect(out.orgId).toBe(42);
    expect(out.userEmail).toBe('a@b.com');
    expect(out.summary.mode).toBe('rename-existing');
    expect(out.summary.existingDataCounts).toEqual({ deals: 3, companies: 2, contacts: 5 });

    // Transaction shape: BEGIN, UPDATE organizations, UPDATE users, COMMIT.
    const sqls = txClient.calls.map(c => c.sql.trim().split(/\s+/).slice(0, 3).join(' '));
    expect(sqls[0]).toMatch(/^BEGIN/);
    expect(txClient.calls.some(c => /UPDATE organizations/i.test(c.sql))).toBe(true);
    expect(txClient.calls.some(c => /UPDATE users/i.test(c.sql))).toBe(true);
    expect(sqls[sqls.length - 1]).toMatch(/^COMMIT/);

    // Audit row fired with the ORG_PROVISIONED event.
    expect(audit.record).toHaveBeenCalled();
    expect(audit.record.mock.calls[0][0].event).toBe(audit.EVENTS.ORG_PROVISIONED);
  });
});

// ---------------------------------------------------------------------------
// 2. create-new — happy path.
// ---------------------------------------------------------------------------
describe('provisionOrg — mode create-new', () => {
  test('creates new org and links user as owner; returns action=create', async () => {
    // findUserByEmail — user with no existing org (clean create)
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 7, email: 'a@b.com', name: 'A', status: 'active', org_id: null, org_role: null }],
    });
    // findOrgByName — no collision
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const txClient = makeTxClient();
    mockPool.connect.mockResolvedValueOnce(txClient);

    const out = await provisionOrg({
      mode: 'create-new',
      name: 'Fresh Co',
      profile: 'generic',
      adminEmail: 'a@b.com',
    });

    expect(out.ok).toBe(true);
    expect(out.action).toBe('create');
    expect(out.orgId).toBe(999); // RETURNING id from makeTxClient INSERT mock
    expect(txClient.calls.some(c => /INSERT INTO organizations/i.test(c.sql))).toBe(true);
    expect(txClient.calls.some(c => /UPDATE users/i.test(c.sql))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. user_not_found.
// ---------------------------------------------------------------------------
describe('provisionOrg — user not found', () => {
  test('throws ProvisionError code=user_not_found', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] }); // findUserByEmail → empty
    await expect(provisionOrg({
      mode: 'rename-existing',
      name: 'X',
      profile: 'generic',
      adminEmail: 'nobody@nowhere.com',
    })).rejects.toMatchObject({
      name: 'ProvisionError',
      code: 'user_not_found',
    });
  });
});

// ---------------------------------------------------------------------------
// 4. user_not_active.
// ---------------------------------------------------------------------------
describe('provisionOrg — user not active', () => {
  test('throws ProvisionError code=user_not_active when status != active', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 7, email: 'a@b.com', name: 'A', status: 'pending', org_id: null, org_role: null }],
    });
    await expect(provisionOrg({
      mode: 'create-new',
      name: 'X',
      profile: 'generic',
      adminEmail: 'a@b.com',
    })).rejects.toMatchObject({
      name: 'ProvisionError',
      code: 'user_not_active',
    });
  });
});

// ---------------------------------------------------------------------------
// 5. org_name_collision (create-new path only).
// ---------------------------------------------------------------------------
describe('provisionOrg — name collision', () => {
  test('create-new + existing org name → ProvisionError code=org_name_collision', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 7, email: 'a@b.com', name: 'A', status: 'active', org_id: null, org_role: null }],
    });
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 11, name: 'Already Here' }],
    });
    await expect(provisionOrg({
      mode: 'create-new',
      name: 'Already Here',
      profile: 'generic',
      adminEmail: 'a@b.com',
    })).rejects.toMatchObject({
      name: 'ProvisionError',
      code: 'org_name_collision',
    });
  });
});

// ---------------------------------------------------------------------------
// 6. validation — invalid profile.
// ---------------------------------------------------------------------------
describe('provisionOrg — validation', () => {
  test('invalid profile → ProvisionError code=validation', async () => {
    await expect(provisionOrg({
      mode: 'rename-existing',
      name: 'X',
      profile: 'no-such-vertical',
      adminEmail: 'a@b.com',
    })).rejects.toMatchObject({
      name: 'ProvisionError',
      code: 'validation',
    });
  });
});

// ---------------------------------------------------------------------------
// 7. unknown feature flag — surfaces as validation error.
//
// The spec language "summary.featureFlagErrors records it; provision still
// succeeds for valid flags" describes a tolerant code path. The current
// implementation rejects at normalizeInput before any write (the comment at
// services/orgProvisioner.js line 113-119 is explicit about this — a typo'd
// flag would silently create the row without unlocking the surface, which is
// worse than a 400). We test the actual contract: an unknown flag fails the
// whole call with a 'validation' error.
// ---------------------------------------------------------------------------
describe('provisionOrg — unknown feature flag', () => {
  test('unknown flag name → ProvisionError code=validation', async () => {
    await expect(provisionOrg({
      mode: 'rename-existing',
      name: 'X',
      profile: 'generic',
      adminEmail: 'a@b.com',
      featureFlags: { not_a_real_flag: true },
    })).rejects.toMatchObject({
      name: 'ProvisionError',
      code: 'validation',
    });
    // featureFlags.setFeature must NOT be called when input fails validation.
    expect(featureFlags.setFeature).not.toHaveBeenCalled();
  });

  test('valid flag passes normalization and triggers setFeature post-commit', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 7, email: 'a@b.com', name: 'A', status: 'active', org_id: 42, org_role: 'owner' }],
    });
    mockPool.query.mockResolvedValueOnce({ rows: [{ deals: 0, companies: 0, contacts: 0 }] });
    mockPool.connect.mockResolvedValueOnce(makeTxClient());

    const out = await provisionOrg({
      mode: 'rename-existing',
      name: 'X',
      profile: 'generic',
      adminEmail: 'a@b.com',
      featureFlags: { ai_billing_required: true },
    });
    expect(out.ok).toBe(true);
    expect(featureFlags.setFeature).toHaveBeenCalledWith(42, 'ai_billing_required', true);
  });
});

// ---------------------------------------------------------------------------
// 8. seedDemo: true — seeder invoked.
// ---------------------------------------------------------------------------
describe('provisionOrg — seedDemo', () => {
  test('seedDemo: true → demoSeeder.seedForUser called once', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 7, email: 'a@b.com', name: 'A', status: 'active', org_id: 42, org_role: 'owner' }],
    });
    mockPool.query.mockResolvedValueOnce({ rows: [{ deals: 0, companies: 0, contacts: 0 }] });
    mockPool.connect.mockResolvedValueOnce(makeTxClient());
    demoSeeder.seedForUser.mockResolvedValueOnce({ deals: 5, companies: 3 });

    const out = await provisionOrg({
      mode: 'rename-existing',
      name: 'X',
      profile: 'generic',
      adminEmail: 'a@b.com',
      seedDemo: true,
    });
    expect(out.ok).toBe(true);
    expect(demoSeeder.seedForUser).toHaveBeenCalledTimes(1);
    expect(demoSeeder.seedForUser).toHaveBeenCalledWith({
      userId: 7,
      orgId: 42,
      profile: 'generic',
    });
    expect(out.summary.demoSeedResult).toEqual({ deals: 5, companies: 3 });
  });
});

// ---------------------------------------------------------------------------
// 9. dryRun: true — no writes; plan returned, audit row still fires.
// ---------------------------------------------------------------------------
describe('provisionOrg — dryRun', () => {
  test('dryRun: true → no pool.connect, summary.dryRun=true, audit fires', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 7, email: 'a@b.com', name: 'A', status: 'active', org_id: 42, org_role: 'owner' }],
    });
    mockPool.query.mockResolvedValueOnce({ rows: [{ deals: 0, companies: 0, contacts: 0 }] });

    const out = await provisionOrg({
      mode: 'rename-existing',
      name: 'X',
      profile: 'generic',
      adminEmail: 'a@b.com',
      dryRun: true,
    });

    expect(out.ok).toBe(true);
    expect(out.summary.dryRun).toBe(true);
    // No transaction → pool.connect never called.
    expect(mockPool.connect).not.toHaveBeenCalled();
    // featureFlags.setFeature is post-commit — not called on dry-run.
    expect(featureFlags.setFeature).not.toHaveBeenCalled();
    // Demo seeder is post-commit too.
    expect(demoSeeder.seedForUser).not.toHaveBeenCalled();
    // Audit row still fires (with dryRun: true in meta).
    expect(audit.record).toHaveBeenCalled();
    expect(audit.record.mock.calls[0][0].meta.dryRun).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 10. ProvisionError export — sanity check the sentinel class is wired.
// ---------------------------------------------------------------------------
describe('ProvisionError', () => {
  test('is a constructable Error subclass with code + details', () => {
    const e = new ProvisionError('xyz', 'boom', { extra: 1 });
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('ProvisionError');
    expect(e.code).toBe('xyz');
    expect(e.details).toEqual({ extra: 1 });
  });
});
