// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Switcher-migration format presets (HubSpot / Salesforce standard CSV
// exports) for /api/import.
//
// WHY THIS EXISTS: a prospect leaving HubSpot or Salesforce should be able
// to drop their platform's standard CSV export into the Import Wizard and
// have every column land on the right CRM field with near-zero manual
// mapping. Both platforms export whatever columns the user's view/report
// happens to show, so there is no single fixed header set — instead each
// preset carries a TOLERANT synonym list per field (case-insensitive,
// trimmed, punctuation/spacing-insensitive) that covers the default view
// columns, the "All properties" export names, and the API-name variants
// Salesforce Data Loader emits (StageName, CloseDate, ...).
//
// Three layers:
//   buildMapping(presetId, entity, headers)
//       → { mapping, matchedFields, unmatchedFields, usedHeaders }
//     Pre-fills the same { ourField: csvHeader } mapping object the wizard
//     builds by hand. Explicit user mappings always win over the preset —
//     importRoutes merges `{ ...presetMapping, ...userMapping }`.
//
//   mapStage(presetId, raw, pipeline)
//       → { stage, matched, warning }
//     Resolves a source-platform stage against the org's EFFECTIVE pipeline
//     (utils/dealStages.resolveStageId first — an org whose stages happen to
//     match keeps them verbatim), then falls back to the per-preset default
//     stage map onto the generic slugs (lead/qualified/proposal/negotiation/
//     closed_won/closed_lost), and finally to the pipeline's default stage
//     with a per-row WARNING (never an error — a switcher's first import
//     must not bounce on a custom stage name).
//
//   listPresets() — serializable descriptors for GET /api/import/presets so
//     the wizard can render the platform cards + per-entity export help.
//
// Owner columns map to the `owner_email` mapping key; the actual user lookup
// (by email, org-scoped, unmatched → warning) lives in importRoutes.js.

const { resolveStageId } = require('../utils/dealStages');

// 'Company Domain Name' / 'company_domain_name' / ' COMPANY  DOMAIN NAME ' →
// 'companydomainname'. All header + stage matching goes through this.
function normalizeHeader(h) {
  return String(h == null ? '' : h).toLowerCase().replace(/[^a-z0-9]/g, '');
}

// ---------------------------------------------------------------------------
// Preset definitions
// ---------------------------------------------------------------------------
// entities.<entity>.fields: ourFieldKey → [source header variants].
// Order matters: the FIRST variant that matches a CSV header wins, so put the
// platform's canonical export header first.

const PRESETS = {
  hubspot: {
    id: 'hubspot',
    label: 'HubSpot',
    blurb: 'Standard HubSpot record exports (Contacts, Companies, Deals)',
    help: {
      companies: 'In HubSpot: CRM → Companies → select all → Export → CSV. Choose "All properties" so Industry, City, and Number of Employees come along.',
      contacts: 'In HubSpot: CRM → Contacts → select all → Export → CSV. Choose "All properties" so Phone Number, Job Title, and Lifecycle Stage come along.',
      deals: 'In HubSpot: CRM → Deals → select all → Export → CSV. Include Deal Name, Deal Stage, Amount, Close Date, and Associated Company.',
    },
    entities: {
      companies: {
        fields: {
          name: ['Name', 'Company name', 'Company'],
          website: ['Company Domain Name', 'Website URL', 'Website', 'Domain'],
          industry: ['Industry'],
          location: ['City', 'State/Region', 'Country/Region'],
          employee_count: ['Number of Employees', 'Employees'],
          annual_revenue: ['Annual Revenue', 'Total Revenue'],
          notes: ['Description', 'About Us'],
        },
      },
      contacts: {
        fields: {
          first_name: ['First Name'],
          last_name: ['Last Name'],
          email: ['Email', 'Email Address'],
          phone: ['Phone Number', 'Mobile Phone Number'],
          job_title: ['Job Title'],
          company_name: ['Associated Company', 'Primary Associated Company', 'Company Name', 'Company'],
          owner_email: ['Contact Owner Email', 'HubSpot Owner Email', 'Owner Email', 'Contact owner'],
          status: ['Lifecycle Stage', 'Lead Status'],
          notes: ['Notes', 'Message'],
        },
      },
      deals: {
        fields: {
          title: ['Deal Name'],
          stage: ['Deal Stage'],
          amount: ['Amount', 'Amount in company currency'],
          expected_close_date: ['Close Date'],
          company_name: ['Associated Company', 'Primary Associated Company', 'Associated Company (Primary)', 'Company Name'],
          owner_email: ['Deal Owner Email', 'HubSpot Owner Email', 'Owner Email', 'Deal owner'],
          notes: ['Deal Description', 'Description'],
          // NOTE: HubSpot's "Pipeline" column is deliberately NOT mapped to
          // deal_type — HubSpot pipeline names ("Sales Pipeline") almost
          // never match an org's deal-type slugs, and a bad slug is a hard
          // row error. Multi-pipeline switchers import one pipeline at a
          // time (see docs/MIGRATING_FROM_HUBSPOT_SALESFORCE.md).
        },
      },
    },
    // HubSpot default sales-pipeline stages. Keys are normalizeHeader() of
    // BOTH the internal value (appointmentscheduled) and the display label
    // ("Appointment Scheduled") — they normalize to the same string, which
    // is exactly why the keys look like the internal names.
    stageMap: {
      appointmentscheduled: 'lead',
      qualifiedtobuy: 'qualified',
      presentationscheduled: 'proposal',
      decisionmakerboughtin: 'negotiation',
      contractsent: 'negotiation',
      closedwon: 'closed_won',
      closedlost: 'closed_lost',
    },
  },

  salesforce: {
    id: 'salesforce',
    label: 'Salesforce',
    blurb: 'Salesforce report exports or Data Loader CSVs (Accounts, Contacts, Opportunities)',
    help: {
      companies: 'In Salesforce: Reports → New Report → Accounts → add Account Name, Website, Phone, Industry, Billing City → Export → Comma Delimited .csv. (Data Loader exports work too.)',
      contacts: 'In Salesforce: Reports → New Report → Contacts & Accounts → add First Name, Last Name, Email, Title, Account Name → Export → Comma Delimited .csv.',
      deals: 'In Salesforce: Reports → New Report → Opportunities → add Opportunity Name, Stage, Amount, Close Date, Account Name, Opportunity Owner → Export → Comma Delimited .csv.',
    },
    entities: {
      companies: {
        fields: {
          name: ['Account Name', 'Name'],
          website: ['Website'],
          industry: ['Industry'],
          location: ['Billing City', 'Billing State/Province', 'Billing Address', 'BillingCity'],
          employee_count: ['Employees', 'NumberOfEmployees', 'Number of Employees'],
          annual_revenue: ['Annual Revenue', 'AnnualRevenue'],
          notes: ['Description', 'Account Description'],
        },
      },
      contacts: {
        fields: {
          first_name: ['First Name', 'FirstName'],
          last_name: ['Last Name', 'LastName'],
          email: ['Email'],
          phone: ['Phone', 'Business Phone', 'Mobile', 'MobilePhone'],
          job_title: ['Title'],
          company_name: ['Account Name', 'Account', 'Company'],
          owner_email: ['Contact Owner Email', 'Owner Email', 'Contact Owner'],
          status: ['Lead Status', 'Contact Status'],
          notes: ['Description', 'Contact Description'],
        },
      },
      deals: {
        fields: {
          title: ['Opportunity Name', 'Name'],
          stage: ['Stage', 'StageName'],
          amount: ['Amount'],
          expected_close_date: ['Close Date', 'CloseDate'],
          company_name: ['Account Name', 'Account', 'AccountName'],
          owner_email: ['Opportunity Owner Email', 'Owner Email', 'Opportunity Owner', 'Owner'],
          notes: ['Description', 'Next Step'],
          // Salesforce "Type" (Existing/New Business) ≠ our deal_type slugs;
          // deliberately unmapped for the same reason as HubSpot Pipeline.
        },
      },
    },
    // Salesforce default Opportunity stages (unchanged for years): both the
    // "Id. Decision Makers" report label and the spelled-out variant appear.
    stageMap: {
      prospecting: 'lead',
      qualification: 'qualified',
      needsanalysis: 'qualified',
      valueproposition: 'proposal',
      iddecisionmakers: 'negotiation',
      identifydecisionmakers: 'negotiation',
      perceptionanalysis: 'negotiation',
      proposalpricequote: 'proposal',
      negotiationreview: 'negotiation',
      closedwon: 'closed_won',
      closedlost: 'closed_lost',
    },
  },
};

const PRESET_IDS = Object.keys(PRESETS);

function isPreset(id) {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(PRESETS, id);
}

/**
 * Pre-fill a { ourField: csvHeader } mapping from a preset. Matching is
 * tolerant: headers and variants are compared after normalizeHeader (case,
 * whitespace, punctuation all ignored). Returns:
 *   mapping          the wizard-shaped mapping object
 *   matchedFields    our field keys that found a column
 *   unmatchedFields  preset field keys with no matching column
 *   usedHeaders      the CSV headers the mapping consumed
 */
function buildMapping(presetId, entity, headers) {
  const preset = PRESETS[presetId];
  const def = preset && preset.entities[entity];
  if (!def) return { mapping: {}, matchedFields: [], unmatchedFields: [], usedHeaders: [] };

  const headerByNorm = new Map();
  for (const h of Array.isArray(headers) ? headers : []) {
    const n = normalizeHeader(h);
    if (n && !headerByNorm.has(n)) headerByNorm.set(n, h);
  }

  const mapping = {};
  const matchedFields = [];
  const unmatchedFields = [];
  const usedHeaders = [];
  const claimed = new Set(); // a CSV column feeds at most one field

  for (const [field, variants] of Object.entries(def.fields)) {
    let hit = null;
    for (const v of variants) {
      const h = headerByNorm.get(normalizeHeader(v));
      if (h !== undefined && !claimed.has(h)) { hit = h; break; }
    }
    if (hit !== null) {
      mapping[field] = hit;
      matchedFields.push(field);
      usedHeaders.push(hit);
      claimed.add(hit);
    } else {
      unmatchedFields.push(field);
    }
  }
  return { mapping, matchedFields, unmatchedFields, usedHeaders };
}

/**
 * Resolve a source-platform stage value against the org's effective pipeline.
 *   1. resolveStageId(raw, pipeline)   — exact / case-insensitive id or label
 *   2. preset stage map → generic slug → resolveStageId again
 *   3. pipeline default stage + a warning string (never an error)
 * Returns { stage, matched, warning } — stage is always usable.
 */
function mapStage(presetId, raw, pipeline) {
  const str = String(raw == null ? '' : raw).trim();
  const fallback = pipeline && pipeline.default_stage
    ? pipeline.default_stage
    : (pipeline && pipeline.stages && pipeline.stages[0] && pipeline.stages[0].id) || null;

  if (!str) return { stage: fallback, matched: false, warning: null };

  const direct = resolveStageId(str, pipeline);
  if (direct) return { stage: direct, matched: true, warning: null };

  const preset = PRESETS[presetId];
  const generic = preset && preset.stageMap[normalizeHeader(str)];
  if (generic) {
    const resolved = resolveStageId(generic, pipeline);
    if (resolved) return { stage: resolved, matched: true, warning: null };
  }

  return {
    stage: fallback,
    matched: false,
    warning: `Stage "${str}" has no equivalent on your pipeline — placed in "${fallback}"`,
  };
}

/** Serializable descriptors for GET /api/import/presets. */
function listPresets() {
  return PRESET_IDS.map((id) => {
    const p = PRESETS[id];
    return {
      id: p.id,
      label: p.label,
      blurb: p.blurb,
      help: p.help,
      entities: Object.fromEntries(
        Object.entries(p.entities).map(([entity, def]) => [entity, { fields: def.fields }])
      ),
      stage_map: p.stageMap,
    };
  });
}

module.exports = { PRESETS, PRESET_IDS, isPreset, normalizeHeader, buildMapping, mapStage, listPresets };
