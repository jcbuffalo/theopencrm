// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Contact / company data enrichment — a PLUGGABLE, inert-until-configured
// provider following the same graceful-degradation shape as services/email.js.
//
// Configuration (all read lazily from env so tests can flip them per-case):
//   ENRICHMENT_API_KEY       — the provider credential. isConfigured() is true
//                              exactly when this is set. Absent → every call
//                              returns { configured:false, message } and NEVER
//                              throws, so the UI ships before a key arrives.
//   ENRICHMENT_PROVIDER_URL  — the HTTP endpoint the provider serves. The call
//                              issues GET <url>?type=<contact|company>&key=<key>
//                              with `Authorization: Bearer <ENRICHMENT_API_KEY>`.
//   ENRICHMENT_PROVIDER      — a label recorded on the cache row (default 'http').
//
// Normalization: the raw provider payload is mapped onto a STABLE shape so the
// route/UI never depend on a given vendor's field names:
//   contact → { title, company, linkedin, location }
//   company → { industry, employee_count, website, description }
//
// Caching: results are cached in enrichment_cache (migration 118) keyed by the
// normalized email (contact) / domain (company). A cache hit short-circuits the
// provider entirely — no HTTP call, no request credit spent.

const pool = require('../db');

function apiKey() { return process.env.ENRICHMENT_API_KEY || ''; }
function providerUrl() { return process.env.ENRICHMENT_PROVIDER_URL || ''; }
function providerName() { return process.env.ENRICHMENT_PROVIDER || 'http'; }

// Configured the instant a key is present (per spec). The provider call itself
// still guards on a missing URL and degrades to "no data" rather than throwing.
function isConfigured() {
  return Boolean(apiKey());
}

const NOT_CONFIGURED_MESSAGE =
  'Enrichment is not configured. Set ENRICHMENT_API_KEY (and ENRICHMENT_PROVIDER_URL) to enable contact and company enrichment.';

function notConfigured() {
  return { configured: false, cached: false, message: NOT_CONFIGURED_MESSAGE, fields: {} };
}

// ---- normalization --------------------------------------------------------

function firstDefined(...vals) {
  for (const v of vals) {
    if (v !== null && v !== undefined && v !== '') return v;
  }
  return null;
}

function normalizeContact(raw) {
  const r = raw || {};
  return {
    title:    firstDefined(r.title, r.job_title, r.jobTitle, r.position, r.role),
    company:  firstDefined(r.company, r.organization, r.company_name, r.employer),
    linkedin: firstDefined(r.linkedin, r.linkedin_url, r.linkedinUrl, r.linkedin_handle),
    location: firstDefined(r.location, r.city, r.geo, r.region),
  };
}

function normalizeCompany(raw) {
  const r = raw || {};
  return {
    industry:       firstDefined(r.industry, r.category, r.sector),
    employee_count: firstDefined(r.employee_count, r.employeeCount, r.employees, r.headcount, r.size),
    website:        firstDefined(r.website, r.domain, r.url, r.homepage),
    description:    firstDefined(r.description, r.summary, r.bio, r.about),
  };
}

// ---- key normalization ----------------------------------------------------

function normEmail(email) {
  return (email || '').trim().toLowerCase();
}

// Strip scheme, leading www., and any path — mirrors the company-duplicate
// domain normalization in routes/companyRoutes.js so keys line up.
function normDomain(input) {
  return (input || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0]
    .split('?')[0];
}

// ---- cache ----------------------------------------------------------------

async function readCache({ orgId, entityType, key }) {
  const r = await pool.query(
    `SELECT data, provider, fetched_at FROM enrichment_cache
      WHERE org_id IS NOT DISTINCT FROM $1 AND entity_type = $2 AND key = $3
      ORDER BY fetched_at DESC LIMIT 1`,
    [orgId || null, entityType, key]
  );
  return r.rows[0] || null;
}

async function writeCache({ orgId, entityType, key, provider, data }) {
  await pool.query(
    `INSERT INTO enrichment_cache (org_id, entity_type, key, provider, data)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [orgId || null, entityType, key, provider, JSON.stringify(data || {})]
  );
}

// ---- provider -------------------------------------------------------------

// Returns the raw provider payload object, or null on any failure/absence. Never
// throws — enrichment is a best-effort enhancement, not a critical path.
async function callProvider({ type, key }) {
  const url = providerUrl();
  if (!url) return null;
  const target = `${url}${url.includes('?') ? '&' : '?'}type=${encodeURIComponent(type)}&key=${encodeURIComponent(key)}`;
  try {
    const resp = await fetch(target, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey()}`, Accept: 'application/json' },
    });
    if (!resp || !resp.ok) return null;
    const body = await resp.json();
    // Some providers wrap the record under a `data`/`result` envelope.
    if (body && typeof body === 'object') {
      return body.data || body.result || body;
    }
    return null;
  } catch {
    return null;
  }
}

// ---- public API -----------------------------------------------------------

async function enrichContact({ email, orgId } = {}) {
  if (!isConfigured()) return notConfigured();
  const key = normEmail(email);
  if (!key) {
    return { configured: true, cached: false, message: 'No email on file to enrich.', fields: {} };
  }

  const hit = await readCache({ orgId, entityType: 'contact', key }).catch(() => null);
  if (hit) {
    return { configured: true, cached: true, provider: hit.provider, fields: normalizeContact(hit.data) };
  }

  const raw = await callProvider({ type: 'contact', key });
  if (!raw) {
    return { configured: true, cached: false, message: 'No enrichment data found for this contact.', fields: {} };
  }
  const provider = providerName();
  await writeCache({ orgId, entityType: 'contact', key, provider, data: raw }).catch(() => {});
  return { configured: true, cached: false, provider, fields: normalizeContact(raw) };
}

async function enrichCompany({ domain, orgId } = {}) {
  if (!isConfigured()) return notConfigured();
  const key = normDomain(domain);
  if (!key) {
    return { configured: true, cached: false, message: 'No website/domain on file to enrich.', fields: {} };
  }

  const hit = await readCache({ orgId, entityType: 'company', key }).catch(() => null);
  if (hit) {
    return { configured: true, cached: true, provider: hit.provider, fields: normalizeCompany(hit.data) };
  }

  const raw = await callProvider({ type: 'company', key });
  if (!raw) {
    return { configured: true, cached: false, message: 'No enrichment data found for this company.', fields: {} };
  }
  const provider = providerName();
  await writeCache({ orgId, entityType: 'company', key, provider, data: raw }).catch(() => {});
  return { configured: true, cached: false, provider, fields: normalizeCompany(raw) };
}

module.exports = {
  isConfigured,
  enrichContact,
  enrichCompany,
  // exported for tests / reuse
  normalizeContact,
  normalizeCompany,
  normEmail,
  normDomain,
};
