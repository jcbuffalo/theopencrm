// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Contact & Company deduplication + merge.
//
// Merging folds a "loser" record into a "winner" record: every child row that
// referenced the loser is reassigned to the winner, non-null loser fields
// backfill blank winner fields, and the loser row is hard-deleted. The whole
// operation runs in a single transaction on a dedicated pool client so a
// failure part-way through never orphans a child FK.
//
// The FK maps below are the AUTHORITATIVE list of every column that points at
// contacts(id) / companies(id) in the schema (verified against every
// migration in backend/migrations that declares `REFERENCES contacts|companies`).
// A missed entry would orphan data, so keep these in lock-step with the schema:
// any new migration that adds a contact/company FK MUST add a row here.
//
// company_roles carries a UNIQUE(company_id, role) constraint, so a naive
// reassign could throw 23505 when both winner and loser hold the same role.
// We de-collide those rows first (see the company_roles handling below).

// -------- FK maps: { table, column } for every child pointer --------

// Columns that reference contacts(id).
const CONTACT_FKS = [
  { table: 'deals',              column: 'contact_id' },
  { table: 'deals',              column: 'end_user_contact_id' },
  { table: 'activities',         column: 'contact_id' },
  { table: 'tasks',              column: 'contact_id' },
  { table: 'appreciation_queue', column: 'contact_id' },
  { table: 'addresses',          column: 'contact_id' },
  { table: 'email_sends',        column: 'to_contact_id' },
  { table: 'email_unsubscribes', column: 'contact_id' },
];

// Columns that reference companies(id).
const COMPANY_FKS = [
  { table: 'contacts',                  column: 'company_id' },
  { table: 'deals',                     column: 'company_id' },
  { table: 'deals',                     column: 'customer_id' },
  { table: 'deals',                     column: 'vendor_id' },
  { table: 'deals',                     column: 'end_user_company_id' },
  { table: 'quotes',                    column: 'customer_id' },
  { table: 'vendor_quotes',             column: 'vendor_id' },
  { table: 'appreciation_queue',        column: 'customer_id' },
  { table: 'service_contracts',         column: 'customer_id' },
  { table: 'addresses',                 column: 'company_id' },
  { table: 'rfqs',                      column: 'customer_id' },
  { table: 'rfqs',                      column: 'vendor_id' },
  { table: 'purchase_orders',           column: 'vendor_id' },
  { table: 'invoices',                  column: 'customer_id' },
  { table: 'account_health_snapshots',  column: 'company_id' },
  // company_roles handled separately — UNIQUE(company_id, role) needs de-collision.
];

// Fields copied from loser -> winner when the winner's value is NULL. Purely
// additive: we never overwrite a value the winner already has.
const CONTACT_BACKFILL = ['email', 'phone', 'company_id', 'job_title', 'notes'];
const COMPANY_BACKFILL = ['type', 'industry', 'website', 'phone', 'location', 'employee_count', 'annual_revenue', 'notes'];

// Reassign one FK column loser -> winner. Returns rows-affected.
async function reassignFk(client, { table, column }, winnerId, loserId) {
  const r = await client.query(
    `UPDATE ${table} SET ${column} = $1 WHERE ${column} = $2`,
    [winnerId, loserId]
  );
  return r.rowCount || 0;
}

// Backfill null winner fields from the loser. Single UPDATE using COALESCE so
// only currently-null winner columns take the loser's value.
async function backfillWinner(client, table, fields, winnerId, loserId) {
  const sets = fields.map((f) => `${f} = COALESCE(w.${f}, l.${f})`).join(', ');
  await client.query(
    `UPDATE ${table} w SET ${sets}, updated_at = CURRENT_TIMESTAMP
       FROM ${table} l
      WHERE w.id = $1 AND l.id = $2`,
    [winnerId, loserId]
  );
}

/**
 * Merge one contact (loser) into another (winner) inside a single transaction.
 * Caller MUST have already verified both ids are in-scope for the org.
 * @returns {{ reassigned: Object, backfilled: boolean }}
 */
async function mergeContacts(client, winnerId, loserId) {
  const reassigned = {};
  for (const fk of CONTACT_FKS) {
    reassigned[`${fk.table}.${fk.column}`] = await reassignFk(client, fk, winnerId, loserId);
  }
  await backfillWinner(client, 'contacts', CONTACT_BACKFILL, winnerId, loserId);
  await client.query(`DELETE FROM contacts WHERE id = $1`, [loserId]);
  return { reassigned, backfilled: true };
}

/**
 * Merge one company (loser) into another (winner) inside a single transaction.
 * Caller MUST have already verified both ids are in-scope for the org.
 * @returns {{ reassigned: Object, backfilled: boolean }}
 */
async function mergeCompanies(client, winnerId, loserId) {
  const reassigned = {};
  for (const fk of COMPANY_FKS) {
    reassigned[`${fk.table}.${fk.column}`] = await reassignFk(client, fk, winnerId, loserId);
  }

  // company_roles: drop loser rows whose (company_id, role) would collide with
  // the winner's existing roles, then reassign the survivors. Avoids a 23505
  // on the UNIQUE(company_id, role) constraint.
  await client.query(
    `DELETE FROM company_roles
      WHERE company_id = $2
        AND role IN (SELECT role FROM company_roles WHERE company_id = $1)`,
    [winnerId, loserId]
  );
  const rolesR = await client.query(
    `UPDATE company_roles SET company_id = $1 WHERE company_id = $2`,
    [winnerId, loserId]
  );
  reassigned['company_roles.company_id'] = rolesR.rowCount || 0;

  await backfillWinner(client, 'companies', COMPANY_BACKFILL, winnerId, loserId);
  await client.query(`DELETE FROM companies WHERE id = $1`, [loserId]);
  return { reassigned, backfilled: true };
}

module.exports = {
  CONTACT_FKS,
  COMPANY_FKS,
  CONTACT_BACKFILL,
  COMPANY_BACKFILL,
  mergeContacts,
  mergeCompanies,
};
