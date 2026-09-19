// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Find-or-create by NAME for the two records a deal hangs off: the company
// and the primary contact. One implementation shared by
//   • the chat copilot's deal.create apply (routes/aiRoutes.js), and
//   • POST /api/deals with `company_name` / `contact_name` / `contact_email`
//     (the "one motion" deal form — Wave 3 of the 2026-09-18 review),
// so the two paths can't drift. Lead conversion (services/leads.js) predates
// this and keeps its own upsert with lead-specific notes.
//
// Every call runs on the CALLER's client inside the caller's transaction and
// is org-scoped through the [sf, sv] pair — no ids are ever accepted from the
// outside, so there is nothing to ownership-check.

// Company: case-insensitive name match within the org, else INSERT.
// Returns { id, created } or null when no name was given.
async function findOrCreateCompany(client, { sf, sv, userId, orgId }, name) {
  const clean = typeof name === 'string' ? name.trim() : '';
  if (!clean) return null;
  const existing = await client.query(
    `SELECT id FROM companies WHERE ${sf} = $1 AND LOWER(name) = LOWER($2) LIMIT 1`,
    [sv, clean]
  );
  if (existing.rows.length > 0) return { id: existing.rows[0].id, created: false };
  const created = await client.query(
    `INSERT INTO companies (user_id, org_id, name) VALUES ($1, $2, $3) RETURNING id`,
    [userId, orgId || null, clean]
  );
  return { id: created.rows[0].id, created: true };
}

// Contact: matched by email first (when given), else created from the name
// (first token → first_name, rest → last_name) linked to `companyId`.
// Returns { id, created } or null when neither a name nor an email was given.
async function findOrCreateContact(client, { sf, sv, userId, orgId }, { name, email, companyId = null }) {
  const cleanName = typeof name === 'string' ? name.trim() : '';
  const cleanEmail = typeof email === 'string' ? email.trim() : '';
  if (!cleanName && !cleanEmail) return null;
  if (cleanEmail) {
    const existing = await client.query(
      `SELECT id FROM contacts WHERE ${sf} = $1 AND LOWER(email) = LOWER($2) LIMIT 1`,
      [sv, cleanEmail]
    );
    if (existing.rows.length > 0) return { id: existing.rows[0].id, created: false };
  }
  const parts = (cleanName || cleanEmail).split(/\s+/).filter(Boolean);
  const firstName = parts[0] || 'Unknown';
  const lastName = parts.slice(1).join(' ') || '—';
  const created = await client.query(
    `INSERT INTO contacts (user_id, org_id, first_name, last_name, email, company_id, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'prospect') RETURNING id`,
    [userId, orgId || null, firstName, lastName, cleanEmail || null, companyId]
  );
  return { id: created.rows[0].id, created: true };
}

module.exports = { findOrCreateCompany, findOrCreateContact };
