// Does this org have any post-sale reality yet — a company past "prospect"
// (type customer / lifecycle stage moved on) or a won deal? The nav hides the
// empty Customers group until it does (Wave 3 of the 2026-09-18 review).
//
// /auth/me calls this on EVERY request, and the query is a 3-way EXISTS
// including a jsonb_array_elements lateral over pipelines.stage_defs — cheap
// today, but not free. Same posture as featureFlags: a short per-pod
// in-process cache. A `false` answer is cached for 60s (a fresh org's first
// closed-won shows up in the nav within a minute); a `true` answer is cached
// for 10 minutes (it never flips back in practice — you don't un-win a deal
// often enough to matter, and a reload after the TTL fixes it). null (no
// org / query failure) is never cached so a transient error self-heals.
const pool = require('../db');

const FALSE_TTL_MS = 60 * 1000;
const TRUE_TTL_MS = 10 * 60 * 1000;

const cache = new Map(); // orgId → { value, expiresAt }

const HAS_CUSTOMERS_SQL = `SELECT (
   EXISTS (SELECT 1 FROM companies
            WHERE org_id = $1
              AND (type = 'customer' OR COALESCE(lifecycle_stage, 'prospect') <> 'prospect'))
   OR EXISTS (SELECT 1 FROM deals
            WHERE org_id = $1
              AND (stage IN ('CLOSED_WON', 'closed_won', 'CLOSED', 'CLOSED_PAID') OR closed_date IS NOT NULL))
   -- Custom pipelines (migrations 155/156): a deal sitting on any
   -- stage its pipeline marks is_won.
   OR EXISTS (SELECT 1
                FROM deals d
                JOIN pipelines p
                  ON p.org_id = d.org_id
                 AND (p.deal_type = d.deal_type OR (p.is_default = TRUE AND COALESCE(d.deal_type, 'default') = 'default'))
                CROSS JOIN LATERAL jsonb_array_elements(COALESCE(p.stage_defs, '[]'::jsonb)) st
               WHERE d.org_id = $1
                 AND st->>'id' = d.stage
                 AND COALESCE((st->>'is_won')::boolean, FALSE))
 ) AS has_customers`;

async function orgHasCustomers(orgId) {
  if (!orgId) return null;
  const hit = cache.get(orgId);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  try {
    const hc = await pool.query(HAS_CUSTOMERS_SQL, [orgId]);
    const v = hc && hc.rows && hc.rows[0] ? hc.rows[0].has_customers : null;
    if (typeof v !== 'boolean') return null;
    cache.set(orgId, { value: v, expiresAt: Date.now() + (v ? TRUE_TTL_MS : FALSE_TTL_MS) });
    return v;
  } catch {
    return null;
  }
}

// Call after a write that could flip the answer (deal closed-won, company
// converted to customer) so the nav catches up on the next /auth/me instead
// of after the TTL. Best-effort; callers never await anything meaningful.
function invalidate(orgId) {
  if (orgId) cache.delete(orgId);
}

// Test-only escape hatch.
function _clearCache() {
  cache.clear();
}

module.exports = { orgHasCustomers, invalidate, _clearCache, FALSE_TTL_MS, TRUE_TTL_MS };
