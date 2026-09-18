// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Demo data seeder. Generates a realistic dataset for the requesting user's
// org so demos / sales pitches don't start with empty charts.
//
// Two profiles:
//   - 'zang'    — manufacturer's-rep workflow with vendor RFQs, submittals,
//                 change orders, service contracts. Stage IDs match Exhibit A.
//   - 'generic' — vanilla CRM with simpler stages.
//
// The seeder is idempotent in the sense that calling it twice will create more
// data, not duplicate. Operators wanting a clean re-seed can call wipe() first.
//
// LIABILITY: For demonstration only. Operators must wipe demo data before any
// production use.

const pool = require('../db');
const logger = require('./logger');

const COMPANIES_ZANG_CUSTOMERS = [
  { name: 'Westvale Power & Light',   industry: 'Utility',          phone: '+1 716-555-0142', location: 'Buffalo, NY' },
  { name: 'Empire Data Centers',      industry: 'Data Center',      phone: '+1 716-555-0188', location: 'Albany, NY' },
  { name: 'Northern Steel Mills',     industry: 'Manufacturing',    phone: '+1 716-555-0211', location: 'Pittsburgh, PA' },
  { name: 'Coastal Health System',    industry: 'Healthcare',       phone: '+1 716-555-0240', location: 'Charleston, SC' },
  { name: 'Riverside Logistics',      industry: 'Logistics',        phone: '+1 716-555-0273', location: 'Columbus, OH' },
  { name: 'Cornerstone Industrial',   industry: 'Industrial',       phone: '+1 716-555-0301', location: 'Cleveland, OH' },
  { name: 'Highland Co-op',           industry: 'Utility',          phone: '+1 716-555-0334', location: 'Syracuse, NY' },
  { name: 'Ironwood Manufacturing',   industry: 'Manufacturing',    phone: '+1 716-555-0367', location: 'Erie, PA' },
];

const COMPANIES_ZANG_VENDORS = [
  { name: 'Eaton Power Quality',      industry: 'Power Equipment',  phone: '+1 800-555-0010', location: 'Cleveland, OH' },
  { name: 'APC by Schneider',         industry: 'Power Equipment',  phone: '+1 800-555-0020', location: 'St. Louis, MO' },
  { name: 'Vertiv',                   industry: 'Critical Infra',   phone: '+1 800-555-0030', location: 'Westerville, OH' },
  { name: 'Generac Industrial',       industry: 'Power Generation', phone: '+1 800-555-0040', location: 'Waukesha, WI' },
  { name: 'Steve Hill Services',      industry: 'Field Service',    phone: '+1 716-555-0050', location: 'Buffalo, NY' },
];

const COMPANIES_GENERIC = [
  { name: 'Acme Corp',           industry: 'Technology',     phone: '+1 555-555-0101', location: 'San Francisco, CA' },
  { name: 'Globex Inc',          industry: 'Manufacturing',  phone: '+1 555-555-0102', location: 'Chicago, IL' },
  { name: 'Initech',             industry: 'Software',       phone: '+1 555-555-0103', location: 'Austin, TX' },
  { name: 'Soylent Industries',  industry: 'Food & Beverage',phone: '+1 555-555-0104', location: 'Brooklyn, NY' },
  { name: 'Hooli',               industry: 'Technology',     phone: '+1 555-555-0105', location: 'Palo Alto, CA' },
  { name: 'Pied Piper',          industry: 'Software',       phone: '+1 555-555-0106', location: 'Palo Alto, CA' },
  { name: 'Stark Industries',    industry: 'Defense',        phone: '+1 555-555-0107', location: 'New York, NY' },
  { name: 'Wayne Enterprises',   industry: 'Conglomerate',   phone: '+1 555-555-0108', location: 'Gotham, NJ' },
];

const FIRST_NAMES = ['Alex', 'Morgan', 'Jordan', 'Taylor', 'Sam', 'Riley', 'Casey', 'Drew', 'Cameron', 'Harper', 'Quinn', 'Avery', 'Reese', 'Sage'];
const LAST_NAMES  = ['Chen', 'Patel', 'Kowalski', 'Okafor', 'Reyes', 'Schwartz', 'Nakamura', 'O\'Brien', 'Singh', 'Müller', 'García', 'Costa', 'Thompson'];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function daysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString(); }
function daysAhead(n) { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); }

const ZANG_STAGES_PRE = ['TRIAGE', 'VENDOR_QUOTING', 'CUSTOMER_QUOTING', 'FOLLOW_UP', 'NO_FOLLOW_UP', 'COLD', 'LOST'];
const ZANG_STAGES_POST = ['NOT_PROCESSED', 'ORDACK', 'VAP', 'CAP', 'MONITOR', 'COORDINATE', 'WHSE', 'TBI', 'INVOICED', 'CLOSED_PAID'];
const ZANG_STAGES_SHIP = ['SERVICE', 'CLOSEOUTS', 'CUSTOMER_EXPERIENCE'];
// Lowercase to match the canonical generic stage IDs declared in
// utils/dealStages.js VALID_STAGES (the API validator) and the DB column
// default in migrations/011_create_deals.sql. Zang stays uppercase per
// Exhibit A.
const GENERIC_STAGES = ['lead', 'qualified', 'proposal', 'negotiation', 'closed_won', 'closed_lost'];

// Zang deals live in power-infrastructure verticals/products. Generic gets its
// own neutral SaaS/services values so a software deal never shows up tagged
// product = "Switchgear", vertical = "Utility", office = "Buffalo".
const VERTICALS = ['Utility', 'Data Center', 'Healthcare', 'Manufacturing', 'Logistics'];
const PRODUCTS = ['UPS System', 'Generator', 'PDU', 'Switchgear', 'Transformer', 'Battery System'];
const ZANG_OFFICES = ['HQ', 'Buffalo', 'Pittsburgh', 'Cleveland'];
const GENERIC_VERTICALS = ['Technology', 'Professional Services', 'Healthcare', 'Retail', 'Financial Services', 'Manufacturing'];
const GENERIC_PRODUCTS = ['Platform License', 'Pro Plan', 'Enterprise Plan', 'Onboarding Package', 'Support Tier', 'Add-on Module'];
const GENERIC_OFFICES = ['HQ', 'New York', 'Austin', 'Remote', 'London'];
const DEAL_CLASSES = ['A', 'B', 'C'];
const DEAL_SIZES = ['Small (<$10K)', 'Medium ($10K–$100K)', 'Large (>$100K)'];

async function wipeDemoForOrg(orgId) {
  // Delete ONLY demo records — anything carrying the [demo] tag in notes /
  // description / summary. Real records the customer created are never touched,
  // so a customer can seed a demo, explore, then clear it and be left with a
  // pristine, genuinely-empty workspace of their own.
  // Survey invitations aren't seeded directly, but the automation worker may
  // mint one for a demo deal — scope the delete to demo deals so real survey
  // invitations are never removed.
  await pool.query(
    `DELETE FROM survey_invitations WHERE org_id = $1 AND deal_id IN (
       SELECT id FROM deals WHERE org_id = $1 AND notes LIKE '%[demo]%')`,
    [orgId]
  );
  await pool.query(`DELETE FROM service_contracts WHERE org_id = $1 AND notes LIKE '%[demo]%'`, [orgId]);
  await pool.query(`DELETE FROM submittals WHERE org_id = $1 AND notes LIKE '%[demo]%'`, [orgId]);
  await pool.query(`DELETE FROM change_orders WHERE org_id = $1 AND description LIKE '%[demo]%'`, [orgId]);
  await pool.query(`DELETE FROM vendor_quotes WHERE org_id = $1 AND notes LIKE '%[demo]%'`, [orgId]);
  await pool.query(`DELETE FROM quote_line_items WHERE quote_id IN (SELECT id FROM quotes WHERE org_id = $1 AND notes LIKE '%[demo]%')`, [orgId]);
  await pool.query(`DELETE FROM quote_revisions WHERE quote_id IN (SELECT id FROM quotes WHERE org_id = $1 AND notes LIKE '%[demo]%')`, [orgId]);
  await pool.query(`DELETE FROM quotes WHERE org_id = $1 AND notes LIKE '%[demo]%'`, [orgId]);
  await pool.query(`DELETE FROM issues WHERE org_id = $1 AND description LIKE '%[demo]%'`, [orgId]);
  await pool.query(`DELETE FROM activities WHERE org_id = $1 AND description LIKE '%[demo]%'`, [orgId]);
  await pool.query(`DELETE FROM tasks WHERE org_id = $1 AND description LIKE '%[demo]%'`, [orgId]);
  await pool.query(`DELETE FROM deals WHERE org_id = $1 AND notes LIKE '%[demo]%'`, [orgId]);
  await pool.query(`DELETE FROM contacts WHERE org_id = $1 AND notes LIKE '%[demo]%'`, [orgId]);
  await pool.query(`DELETE FROM companies WHERE org_id = $1 AND notes LIKE '%[demo]%'`, [orgId]);
  await pool.query(`DELETE FROM meeting_logs WHERE org_id = $1 AND summary LIKE '%[demo]%'`, [orgId]);
}

async function seedForUser({ userId, orgId, profile = 'generic' }) {
  if (!userId || !orgId) throw new Error('userId and orgId required');
  logger.info('demo_seed_started', { userId, orgId, profile });

  // Idempotent: clear any existing demo data first so re-seeding REPLACES rather
  // than DUPLICATES. This bounds the footprint to exactly one demo set no matter
  // how many times seed is called — no runaway rows, no runaway cost.
  await wipeDemoForOrg(orgId);

  const isZang = profile === 'zang';
  const customerSeeds = isZang ? COMPANIES_ZANG_CUSTOMERS : COMPANIES_GENERIC;
  const vendorSeeds   = isZang ? COMPANIES_ZANG_VENDORS : [];

  // ---- Companies ----
  const companies = [];
  for (const c of [...customerSeeds, ...vendorSeeds]) {
    const isVendor = vendorSeeds.includes(c);
    const r = await pool.query(
      `INSERT INTO companies (user_id, org_id, name, type, industry, phone, location, status, notes, first_deal_at, last_deal_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', '[demo]', $8, $9) RETURNING id, name, type`,
      [userId, orgId, c.name, isVendor ? 'vendor' : 'customer', c.industry, c.phone, c.location,
       daysAgo(rand(60, 400)), daysAgo(rand(0, 30))]
    );
    companies.push(r.rows[0]);
  }
  const customers = companies.filter(c => c.type === 'customer');
  const vendors = companies.filter(c => c.type === 'vendor');

  // ---- Contacts ----
  // Email uniqueness: contacts has UNIQUE(user_id, email). FIRST_NAMES ×
  // LAST_NAMES is a small-enough pool that random picks collide (birthday
  // paradox) within a single seed run, and re-seeding without wiping is
  // *always* a collision. We tag every demo email with a per-run nonce
  // (base36 timestamp + loop index) so neither failure mode happens.
  const seedRunId = Date.now().toString(36);
  const contacts = [];
  for (let i = 0; i < customers.length * 2; i++) {
    const co = pick(customers);
    const fn = pick(FIRST_NAMES); const ln = pick(LAST_NAMES);
    const email = `${fn.toLowerCase()}.${ln.toLowerCase()}.${seedRunId}.${i}@example.com`;
    const r = await pool.query(
      `INSERT INTO contacts (user_id, org_id, company_id, first_name, last_name, email, phone, job_title, status, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', '[demo]')
       ON CONFLICT (user_id, email) DO UPDATE SET notes = EXCLUDED.notes
       RETURNING id, first_name, last_name`,
      [userId, orgId, co.id, fn, ln, email,
       `+1 555-555-${String(rand(1000, 9999))}`,
       pick(['CFO', 'COO', 'Operations Manager', 'Procurement Lead', 'Plant Manager', 'IT Director'])]
    );
    contacts.push({ ...r.rows[0], company_id: co.id });
  }

  // ---- Deals ----
  const dealTitles = isZang ? [
    'Switchgear retrofit — main MV bus',
    'Backup UPS for primary data hall',
    'Generator replacement, 2MW unit',
    'PDU rollout phase 2',
    '3MVA transformer for substation',
    'Battery refresh — control room',
    'Annual switchgear maintenance',
    'Service contract renewal — UPS fleet',
    'Emergency generator install',
    'Distribution panel upgrade',
    'Critical loads UPS expansion',
    'Hospital backup power retrofit',
    'Mill substation modernization',
    'Cold storage genset',
    'Logistics hub power study',
  ] : [
    'Acme — annual platform license',
    'Globex — pilot to full rollout',
    'Initech — TPS report integration',
    'Soylent — supplier portal',
    'Hooli — Q3 expansion',
    'Pied Piper — compression upgrade',
    'Stark — defense compliance bundle',
    'Wayne — multi-region deployment',
    'Acme — security add-on',
    'Globex — services renewal',
    'Initech — manager seat increase',
    'Soylent — international tier',
  ];

  const allStagesForProfile = isZang
    ? [...ZANG_STAGES_PRE, ...ZANG_STAGES_POST, ...ZANG_STAGES_SHIP]
    : GENERIC_STAGES;

  const deals = [];
  for (let i = 0; i < dealTitles.length; i++) {
    const stage = pick(allStagesForProfile);
    const phase = isZang
      ? (ZANG_STAGES_PRE.includes(stage) ? 'pre_sale' : ZANG_STAGES_POST.includes(stage) ? 'post_sale' : 'post_ship')
      : 'pipeline';
    const customer = pick(customers);
    const vendor = vendors.length > 0 ? pick(vendors) : null;
    const amount = rand(5000, 250000);
    // Zang win/loss stages stay uppercase per Exhibit A; generic ones
    // are lowercase per VALID_STAGES (see utils/dealStages.js).
    const isWonStage = stage === 'closed_won' || stage === 'CLOSED_PAID' || stage === 'INVOICED';
    const isLostStage = stage === 'closed_lost' || stage === 'LOST';
    const closedDate = (isWonStage || isLostStage) ? daysAgo(rand(1, 60)) : null;
    const createdDate = daysAgo(rand(60, 200));

    const r = await pool.query(
      `INSERT INTO deals (user_id, org_id, salesman_id, customer_id, company_id, vendor_id,
                          title, description, amount, stage, phase, vertical, product, deal_class, deal_size,
                          office_location, hot_flag, expected_close_date, closed_date,
                          notes, created_at, updated_at, last_activity_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, '[demo] generated for pitch', $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, '[demo]', $19, $19, $19)
       RETURNING id, title, customer_id, vendor_id, stage, phase, amount`,
      [userId, orgId, userId, customer.id, customer.id, vendor?.id || null,
       dealTitles[i], amount, stage, phase,
       pick(isZang ? VERTICALS : GENERIC_VERTICALS),
       pick(isZang ? PRODUCTS : GENERIC_PRODUCTS),
       pick(DEAL_CLASSES), pick(DEAL_SIZES),
       pick(isZang ? ZANG_OFFICES : GENERIC_OFFICES),
       Math.random() < 0.2, daysAhead(rand(7, 90)), closedDate, createdDate]
    );
    deals.push(r.rows[0]);
  }

  // ---- Vendor quotes (Zang only) ----
  if (isZang) {
    for (const d of deals) {
      if (d.phase !== 'pre_sale' || vendors.length === 0) continue;
      // Each pre-sale deal has 2-4 vendor RFQs out, with one selected if quoted.
      const vendorCount = rand(2, Math.min(4, vendors.length));
      const used = new Set();
      let selected = false;
      for (let i = 0; i < vendorCount; i++) {
        let v;
        do { v = pick(vendors); } while (used.has(v.id));
        used.add(v.id);
        const status = pick(['requested', 'received', 'received', 'declined']);
        const amount = status === 'received' ? rand(3000, 200000) : null;
        const isSelected = !selected && status === 'received' && Math.random() < 0.5;
        if (isSelected) selected = true;
        await pool.query(
          `INSERT INTO vendor_quotes (user_id, org_id, deal_id, vendor_id, status, rfq_sent_at, quote_received_at, amount, lead_time_days, is_selected, notes)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, '[demo]')`,
          [userId, orgId, d.id, v.id, status, daysAgo(rand(5, 45)),
           status === 'received' ? daysAgo(rand(1, 20)) : null,
           amount, rand(14, 84), isSelected]
        );
      }
    }
  }

  // ---- Quotes with line items ----
  const quoteCount = isZang ? 6 : 4;
  for (let i = 0; i < quoteCount; i++) {
    const d = pick(deals.filter(x => x.phase !== 'post_ship'));
    if (!d) break;
    const total = Number(d.amount) || rand(10000, 100000);
    const q = await pool.query(
      `INSERT INTO quotes (user_id, org_id, deal_id, customer_id, title, status, total_amount, valid_until, current_revision, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, '[demo]') RETURNING id`,
      [userId, orgId, d.id, d.customer_id,
       `Quote — ${d.title}`,
       pick(['draft', 'sent', 'revised', 'accepted']),
       total, daysAhead(rand(15, 60)),
       rand(1, 3)]
    );
    const qid = q.rows[0].id;
    // Line items
    const itemCount = rand(2, 5);
    for (let j = 0; j < itemCount; j++) {
      const qty = rand(1, 5);
      const unit = Math.round(total / itemCount / qty);
      await pool.query(
        `INSERT INTO quote_line_items (quote_id, vendor_id, description, quantity, unit_price, markup_pct, position)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [qid, isZang && vendors.length > 0 ? pick(vendors).id : null,
         pick(['Equipment package', 'Installation labor', 'Site survey', 'Commissioning', 'Spare parts kit', 'Extended warranty']),
         qty, unit, rand(10, 25), j]
      );
    }
    // Initial revision row
    await pool.query(
      `INSERT INTO quote_revisions (quote_id, revision_number, total_amount, notes, created_by)
       VALUES ($1, 1, $2, 'Initial revision [demo]', $3)`,
      [qid, total, userId]
    );
  }

  // ---- Submittals + change orders (Zang post-sale only) ----
  if (isZang) {
    const postSaleDeals = deals.filter(d => d.phase === 'post_sale');
    for (const d of postSaleDeals.slice(0, 4)) {
      const versions = rand(1, 3);
      for (let v = 1; v <= versions; v++) {
        const status = v === versions ? pick(['pending_vendor', 'pending_customer', 'approved']) : 'approved';
        await pool.query(
          `INSERT INTO submittals (user_id, org_id, deal_id, version, type, status, notes, approved_at)
           VALUES ($1, $2, $3, $4, 'drawing', $5, '[demo] submittal version', $6)`,
          [userId, orgId, d.id, v, status, status === 'approved' ? daysAgo(rand(1, 20)) : null]
        );
      }
      if (Math.random() < 0.5) {
        await pool.query(
          `INSERT INTO change_orders (user_id, org_id, deal_id, number, description, amount_delta, status, approved_at)
           VALUES ($1, $2, $3, 1, '[demo] Scope addition: extended commissioning scope', $4, 'approved', $5)`,
          [userId, orgId, d.id, rand(2000, 15000), daysAgo(rand(1, 30))]
        );
      }
    }
  }

  // ---- Issues ----
  const issueTitles = isZang ? [
    'Vendor quote 30 days old — no response',
    'Submittal stuck in customer approval > 14 days',
    'Lead time slipped 3 weeks',
    'Wrong serial numbers on packing list',
    'Customer disputing change order amount',
    'Carrier delay — needs reroute',
    'PO not yet acknowledged by vendor',
  ] : [
    'Customer expansion blocked on legal review',
    'Pricing approval needed from finance',
    'Demo follow-up overdue',
    'Champion left the company',
    'Stuck on procurement',
  ];
  for (let i = 0; i < issueTitles.length; i++) {
    const d = pick(deals);
    const urgency = pick(['red', 'red', 'yellow', 'yellow', 'green']);
    await pool.query(
      `INSERT INTO issues (user_id, org_id, related_type, related_id, title, description, category, urgency, status, blocks_workflow, financial_impact)
       VALUES ($1, $2, 'deal', $3, $4, '[demo] generated', $5, $6, $7, $8, $9)`,
      [userId, orgId, d.id, issueTitles[i],
       pick(['logistics', 'technical', 'financial']),
       urgency,
       pick(['open', 'open', 'in_progress', 'resolved']),
       urgency === 'red' && Math.random() < 0.4,
       isZang ? pick(['zang', 'customer', 'vendor', 'zang_customer']) : null]
    );
  }

  // ---- Activities ----
  const activityTypes = ['call', 'email', 'meeting', 'note', 'demo'];
  for (let i = 0; i < 25; i++) {
    const d = pick(deals);
    const type = pick(activityTypes);
    await pool.query(
      `INSERT INTO activities (user_id, org_id, contact_id, deal_id, type, title, description, activity_date, duration_minutes, outcome)
       VALUES ($1, $2, $3, $4, $5, $6, '[demo] generated activity', $7, $8, $9)`,
      [userId, orgId,
       contacts.length > 0 ? pick(contacts).id : null,
       d.id, type,
       `${type === 'call' ? 'Discovery call' : type === 'email' ? 'Follow-up email' : type === 'meeting' ? 'Onsite meeting' : type === 'demo' ? 'Product demo' : 'Internal note'} — ${d.title.slice(0, 30)}`,
       daysAgo(rand(0, 60)),
       type === 'call' ? rand(10, 45) : type === 'meeting' ? rand(30, 90) : null,
       pick(['Followed up', 'Awaiting response', 'Voicemail left', 'Positive', 'Needs follow-up', null])]
    );
  }

  // ---- Tasks ----
  for (let i = 0; i < 8; i++) {
    const d = pick(deals);
    const isOpen = Math.random() < 0.7;
    const isOverdue = isOpen && Math.random() < 0.3;
    await pool.query(
      `INSERT INTO tasks (user_id, org_id, contact_id, deal_id, title, description, due_date, status, priority)
       VALUES ($1, $2, $3, $4, $5, '[demo] generated task', $6, $7, $8)`,
      [userId, orgId,
       contacts.length > 0 ? pick(contacts).id : null,
       d.id,
       pick(isZang
         ? ['Send proposal', 'Confirm pricing', 'Get PO signed', 'Follow up on quote', 'Vendor check-in', 'Chase submittal approval', 'Customer site visit']
         : ['Send proposal', 'Schedule a kickoff call', 'Confirm pricing', 'Follow up on quote', 'Book a renewal call', 'Check in with the champion', 'Share a case study', 'Schedule a QBR']),
       isOpen ? (isOverdue ? daysAgo(rand(1, 14)).slice(0, 10) : daysAhead(rand(1, 21))) : daysAgo(rand(1, 14)).slice(0, 10),
       isOpen ? 'open' : 'done',
       pick(['low', 'medium', 'medium', 'high'])]
    );
  }

  // ---- Service contracts / renewals — the ongoing-relationship layer ----
  // Seeded for BOTH profiles so the generic demo tells a recurring-revenue +
  // renewals story, not just a new-business pipeline. Two are deliberately
  // renewing SOON so the Renewals rollup (and the health worker's "upcoming
  // renewal" signal) have something real to surface.
  {
    const contractNames = isZang
      ? ['UPS service', 'Annual maintenance', 'Battery monitoring', 'Generator service']
      : ['Annual subscription', 'Pro plan (annual)', 'Premium support', 'Success retainer'];
    const contractTypes = isZang
      ? ['service', 'maintenance', 'support']
      : ['subscription', 'support', 'retainer'];
    for (let i = 0; i < 5; i++) {
      const co = pick(customers);
      const startDate = daysAgo(rand(120, 400));
      const daysToRenewal = i < 2 ? rand(7, 45) : rand(90, 365); // first two renew soon
      const endDate = new Date(); endDate.setDate(endDate.getDate() + daysToRenewal);
      await pool.query(
        `INSERT INTO service_contracts (user_id, org_id, customer_id, name, contract_type, start_date, end_date, renewal_notice_days, status, monthly_amount, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 30, 'active', $8, '[demo] recurring contract')`,
        [userId, orgId, co.id,
         `${co.name} — ${pick(contractNames)}`,
         pick(contractTypes),
         startDate.slice(0, 10),
         endDate.toISOString().slice(0, 10),
         rand(500, 5000)]
      );
    }
  }

  // ---- Meeting logs (simulated Teams / Zoom transcripts) ----
  for (let i = 0; i < 6; i++) {
    const d = pick(deals);
    await pool.query(
      `INSERT INTO meeting_logs (user_id, org_id, related_type, related_id, source, external_id, title, participants, occurred_at, duration_minutes, summary)
       VALUES ($1, $2, 'deal', $3, $4, $5, $6, $7, $8, $9, $10)`,
      [userId, orgId, d.id,
       pick(['teams', 'zoom']),
       `demo-${Math.random().toString(36).slice(2, 10)}`,
       `${pick(['Discovery', 'Pricing review', 'Site walkthrough', 'Status update', 'Closeout review'])} — ${d.title.slice(0, 30)}`,
       'sales@yourcompany.com, customer.poc@example.com',
       daysAgo(rand(1, 90)),
       rand(15, 60),
       `[demo] Discussed scope and next steps. Customer agreed to proceed pending pricing confirmation.`]
    );
  }

  const summary = {
    companies: companies.length,
    customers: customers.length,
    vendors: vendors.length,
    contacts: contacts.length,
    deals: deals.length,
    profile,
  };
  logger.info('demo_seed_completed', { userId, orgId, ...summary });
  return summary;
}

// Lightweight check the frontend polls to decide whether to show the "you're
// viewing demo data" banner. Counts only [demo]-tagged rows, so it flips back
// to false the moment the customer clears the demo.
async function demoStatusForOrg(orgId) {
  const r = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM companies WHERE org_id = $1 AND notes LIKE '%[demo]%') AS companies,
       (SELECT COUNT(*) FROM deals     WHERE org_id = $1 AND notes LIKE '%[demo]%') AS deals,
       (SELECT COUNT(*) FROM contacts  WHERE org_id = $1 AND notes LIKE '%[demo]%') AS contacts`,
    [orgId]
  );
  const row = r.rows[0] || {};
  const counts = {
    companies: Number(row.companies || 0),
    deals: Number(row.deals || 0),
    contacts: Number(row.contacts || 0),
  };
  return { hasDemo: counts.companies > 0 || counts.deals > 0 || counts.contacts > 0, counts };
}

module.exports = { seedForUser, wipeDemoForOrg, demoStatusForOrg };
