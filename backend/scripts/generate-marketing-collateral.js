// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

/**
 * The Open CRM — marketing collateral generator.
 *
 * Produces a partner-enablement PDF packet for a colleague who may pitch and
 * run the business on top of the product. Three documents:
 *   1. Product Overview   — prospect-facing one-pager
 *   2. Pricing & Features — tier comparison, honest shipped-vs-roadmap
 *   3. Sales & Customer-Success Playbook + FAQ — the enablement piece
 *
 * Content is grounded in PRICING_AND_FEATURES.md (the canonical truth doc) and
 * CLAUDE.md. Honesty rules from PRICING_AND_FEATURES.md are respected: nothing
 * on the roadmap is described as shipped.
 *
 * Run:  node backend/scripts/generate-marketing-collateral.js
 * Out:  marketing/*.pdf
 */
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

const OUT_DIR = path.join(__dirname, '..', '..', 'marketing');

// ---- Design system -------------------------------------------------------
const PAGE = { w: 612, h: 792 };
const MARGIN = 56;
const CONTENT_W = PAGE.w - MARGIN * 2;
const BOTTOM = PAGE.h - MARGIN;

const C = {
  navy: '#0B1F3A',
  ink: '#1F2937',
  accent: '#2563EB',
  accentDark: '#1E40AF',
  sky: '#0EA5E9',
  muted: '#6B7280',
  faint: '#9CA3AF',
  line: '#E5E7EB',
  panel: '#F3F6FC',
  panelEdge: '#DCE6F7',
  green: '#16A34A',
  amber: '#D97706',
  white: '#FFFFFF',
};

const F = {
  reg: 'Helvetica',
  bold: 'Helvetica-Bold',
  ital: 'Helvetica-Oblique',
};

const WEBSITE = 'theopencrm.com';
const APP = 'app.theopencrm.com';
const TODAY = 'June 2026';

// ---- Builder -------------------------------------------------------------
function newDoc() {
  const doc = new PDFDocument({ size: 'letter', margin: 0, bufferPages: true });
  return { doc, y: MARGIN, title: '' };
}

function ensure(ctx, needed) {
  if (ctx.y + needed > BOTTOM) {
    ctx.doc.addPage();
    ctx.y = MARGIN;
  }
}

function gap(ctx, h) {
  ctx.y += h;
}

function rule(ctx, color = C.line, w = 1) {
  ctx.doc
    .moveTo(MARGIN, ctx.y)
    .lineTo(PAGE.w - MARGIN, ctx.y)
    .lineWidth(w)
    .strokeColor(color)
    .stroke();
}

function text(ctx, str, opts = {}) {
  const {
    font = F.reg,
    size = 10.5,
    color = C.ink,
    width = CONTENT_W,
    x = MARGIN,
    lineGap = 3,
    align = 'left',
    indent = 0,
  } = opts;
  const d = ctx.doc;
  d.font(font).fontSize(size).fillColor(color);
  const h = d.heightOfString(str, { width: width - indent, lineGap, align });
  ensure(ctx, h);
  d.text(str, x + indent, ctx.y, { width: width - indent, lineGap, align });
  ctx.y += h;
}

function heading(ctx, str) {
  ensure(ctx, 46);
  gap(ctx, 6);
  ctx.doc
    .rect(MARGIN, ctx.y + 1, 4, 17)
    .fill(C.accent);
  text(ctx, str, { font: F.bold, size: 15, color: C.navy, x: MARGIN + 12, width: CONTENT_W - 12 });
  gap(ctx, 4);
  rule(ctx, C.line, 1);
  gap(ctx, 10);
}

function subheading(ctx, str) {
  ensure(ctx, 24);
  gap(ctx, 4);
  text(ctx, str, { font: F.bold, size: 11.5, color: C.accentDark });
  gap(ctx, 3);
}

function para(ctx, str, opts = {}) {
  text(ctx, str, { size: 10.5, color: C.ink, lineGap: 3.5, ...opts });
  gap(ctx, 7);
}

function bullet(ctx, str, opts = {}) {
  const { label } = opts;
  const d = ctx.doc;
  const bx = MARGIN + 4;
  const tx = MARGIN + 16;
  const tw = CONTENT_W - 16;
  d.font(F.reg).fontSize(10.5);
  let h;
  if (label) {
    // measure label + body inline
    const full = `${label}  ${str}`;
    h = d.heightOfString(full, { width: tw, lineGap: 3 });
  } else {
    h = d.heightOfString(str, { width: tw, lineGap: 3 });
  }
  ensure(ctx, h + 4);
  d.circle(bx + 1.5, ctx.y + 6, 1.8).fill(C.accent);
  if (label) {
    d.font(F.bold).fontSize(10.5).fillColor(C.navy).text(label + '  ', tx, ctx.y, { continued: true });
    d.font(F.reg).fillColor(C.ink).text(str, { width: tw, lineGap: 3 });
  } else {
    d.font(F.reg).fontSize(10.5).fillColor(C.ink).text(str, tx, ctx.y, { width: tw, lineGap: 3 });
  }
  ctx.y += h + 5;
}

function callout(ctx, opts) {
  const { title, body, lines, tint = C.panel, edge = C.panelEdge, accent = C.accent } = opts;
  const d = ctx.doc;
  const padX = 14;
  const innerW = CONTENT_W - padX * 2 - 4;
  // measure
  d.font(F.bold).fontSize(11);
  let h = 12;
  if (title) h += d.heightOfString(title, { width: innerW }) + 6;
  d.font(F.reg).fontSize(10);
  const items = lines || (body ? [body] : []);
  for (const it of items) {
    h += d.heightOfString(typeof it === 'string' ? it : it.t, { width: innerW, lineGap: 3 }) + 5;
  }
  h += 8;
  ensure(ctx, h + 8);
  const top = ctx.y;
  d.roundedRect(MARGIN, top, CONTENT_W, h, 6).fillAndStroke(tint, edge);
  d.rect(MARGIN, top, 4, h).fill(accent);
  let yy = top + 12;
  if (title) {
    d.font(F.bold).fontSize(11).fillColor(C.navy).text(title, MARGIN + padX, yy, { width: innerW });
    yy += d.heightOfString(title, { width: innerW }) + 6;
  }
  for (const it of items) {
    const s = typeof it === 'string' ? it : it.t;
    const col = typeof it === 'string' ? C.ink : it.c || C.ink;
    d.font(F.reg).fontSize(10).fillColor(col).text(s, MARGIN + padX, yy, { width: innerW, lineGap: 3 });
    yy += d.heightOfString(s, { width: innerW, lineGap: 3 }) + 5;
  }
  ctx.y = top + h + 10;
}

/**
 * Simple wrapping table.
 * cols: [{ w, header, font?, align? }]
 * rows: [[cell, cell, ...]] where cell is string or { t, font, color, align }
 */
function table(ctx, cols, rows, opts = {}) {
  const d = ctx.doc;
  const padX = 7;
  const padY = 6;
  const totalW = cols.reduce((a, c) => a + c.w, 0);
  const x0 = MARGIN + (CONTENT_W - totalW) / 2;

  const drawHeader = () => {
    const hh = 22;
    ensure(ctx, hh + 2);
    d.rect(x0, ctx.y, totalW, hh).fill(C.navy);
    let cx = x0;
    for (const c of cols) {
      d.font(F.bold).fontSize(9).fillColor(C.white).text(
        c.header,
        cx + padX,
        ctx.y + 6.5,
        { width: c.w - padX * 2, align: c.align || 'left' }
      );
      cx += c.w;
    }
    ctx.y += hh;
  };

  drawHeader();
  let stripe = false;
  for (const row of rows) {
    // measure row height
    let rowH = 0;
    cols.forEach((c, i) => {
      const cell = row[i];
      const s = typeof cell === 'string' ? cell : cell ? cell.t : '';
      const fnt = (cell && cell.font) || F.reg;
      d.font(fnt).fontSize(9);
      const hh = d.heightOfString(s || '', { width: c.w - padX * 2, lineGap: 2 });
      if (hh > rowH) rowH = hh;
    });
    rowH += padY * 2;
    if (ctx.y + rowH > BOTTOM) {
      ctx.doc.addPage();
      ctx.y = MARGIN;
      drawHeader();
      stripe = false;
    }
    if (stripe) d.rect(x0, ctx.y, totalW, rowH).fill('#F8FAFC');
    let cx = x0;
    cols.forEach((c, i) => {
      const cell = row[i];
      const s = typeof cell === 'string' ? cell : cell ? cell.t : '';
      const fnt = (cell && cell.font) || F.reg;
      const col = (cell && cell.color) || C.ink;
      const al = (cell && cell.align) || c.align || 'left';
      d.font(fnt).fontSize(9).fillColor(col).text(s || '', cx + padX, ctx.y + padY, {
        width: c.w - padX * 2,
        align: al,
        lineGap: 2,
      });
      cx += c.w;
    });
    // row border
    d.moveTo(x0, ctx.y + rowH).lineTo(x0 + totalW, ctx.y + rowH).lineWidth(0.5).strokeColor(C.line).stroke();
    ctx.y += rowH;
    stripe = !stripe;
  }
  // outer border
  gap(ctx, 4);
}

// Cover page (full-bleed navy band)
function cover(ctx, opts) {
  const { kicker, title, subtitle, blurb } = opts;
  const d = ctx.doc;
  const bandH = 300;
  d.rect(0, 0, PAGE.w, bandH).fill(C.navy);
  d.rect(0, bandH, PAGE.w, 6).fill(C.accent);
  // logo mark
  d.circle(MARGIN + 10, 70, 11).fill(C.accent);
  d.circle(MARGIN + 10, 70, 5).fill(C.white);
  d.font(F.bold).fontSize(13).fillColor(C.white).text('THE OPEN CRM', MARGIN + 30, 63);

  d.font(F.bold).fontSize(11).fillColor(C.sky).text((kicker || '').toUpperCase(), MARGIN, 150, {
    characterSpacing: 1.5,
    width: CONTENT_W,
  });
  d.font(F.bold).fontSize(30).fillColor(C.white).text(title, MARGIN, 174, { width: CONTENT_W, lineGap: 2 });
  if (subtitle) {
    d.font(F.reg).fontSize(13).fillColor('#C7D6EE').text(subtitle, MARGIN, 250, { width: CONTENT_W, lineGap: 3 });
  }

  ctx.y = bandH + 40;
  if (blurb) {
    para(ctx, blurb, { size: 11.5, color: C.ink, lineGap: 4 });
    gap(ctx, 6);
  }
}

function metaStrip(ctx, items) {
  // small labeled meta chips
  gap(ctx, 6);
  const d = ctx.doc;
  let yy = ctx.y;
  for (const it of items) {
    d.font(F.bold).fontSize(9).fillColor(C.muted).text(it.k.toUpperCase(), MARGIN, yy, { characterSpacing: 1 });
    d.font(F.reg).fontSize(10.5).fillColor(C.ink).text(it.v, MARGIN + 110, yy, { width: CONTENT_W - 110 });
    yy += 18;
  }
  ctx.y = yy + 4;
}

function finalize(ctx, footerLabel) {
  const d = ctx.doc;
  const range = d.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    d.switchToPage(i);
    const isCover = i === range.start;
    if (!isCover) {
      // running header
      d.font(F.bold).fontSize(8).fillColor(C.faint).text('THE OPEN CRM', MARGIN, 30, { characterSpacing: 1 });
      d.font(F.reg).fontSize(8).fillColor(C.faint).text(footerLabel, MARGIN, 30, {
        width: CONTENT_W,
        align: 'right',
      });
      d.moveTo(MARGIN, 44).lineTo(PAGE.w - MARGIN, 44).lineWidth(0.5).strokeColor(C.line).stroke();
    }
    // footer
    d.moveTo(MARGIN, PAGE.h - 40).lineTo(PAGE.w - MARGIN, PAGE.h - 40).lineWidth(0.5).strokeColor(C.line).stroke();
    d.font(F.reg).fontSize(8).fillColor(C.faint).text(
      `${WEBSITE}  ·  Confidential — partner enablement  ·  ${TODAY}`,
      MARGIN,
      PAGE.h - 33,
      { width: CONTENT_W }
    );
    d.font(F.reg).fontSize(8).fillColor(C.faint).text(`${i - range.start + 1} / ${range.count}`, MARGIN, PAGE.h - 33, {
      width: CONTENT_W,
      align: 'right',
    });
  }
}

function save(ctx, filename) {
  return new Promise((resolve, reject) => {
    const p = path.join(OUT_DIR, filename);
    const stream = fs.createWriteStream(p);
    ctx.doc.pipe(stream);
    stream.on('finish', () => resolve(p));
    stream.on('error', reject);
    ctx.doc.end();
  });
}

// ========================================================================
// DOC 1 — Product Overview (prospect-facing one-pager)
// ========================================================================
async function buildOverview() {
  const ctx = newDoc();
  cover(ctx, {
    kicker: 'Product Overview',
    title: 'The CRM that opens\nwith a conversation.',
    subtitle: 'A multi-tenant, white-label sales CRM with an AI copilot built in — from a simple 6-stage pipeline to a 29-stage manufacturer’s-rep lifecycle, on one codebase.',
    blurb:
      'The Open CRM is a cloud CRM for teams that want their pipeline, quoting, and follow-up in one place — without paying enterprise prices or wrestling enterprise complexity. Sign in and the front door is a chat box: ask “what should I do today?” and get one curated, real action grounded in your live pipeline.',
  });

  heading(ctx, 'Who it’s for');
  bullet(ctx, 'Small and mid-size sales teams that have outgrown spreadsheets and want pipeline, contacts, activities, and tasks in one clean tool.', { label: 'Growing sales teams.' });
  bullet(ctx, 'Reps and agencies running a real quoting lifecycle — vendor RFQs, multi-vendor comparisons, submittals, change orders, and issue tracking out of the box.', { label: 'Manufacturer’s reps & distributors.' });
  bullet(ctx, 'Operators who want their own branded CRM for a niche: per-org display name, logo, color, and custom terminology, with modules toggled on per customer.', { label: 'White-label / vertical operators.' });
  gap(ctx, 4);

  heading(ctx, 'What you get out of the box');
  bullet(ctx, 'Companies, contacts, deals, activities, and tasks on a drag-and-drop Kanban pipeline.', { label: 'Core CRM.' });
  bullet(ctx, 'A conversational copilot at the front door — “who’s gone dark?”, “draft a check-in,” “what’s overdue?” — grounded in your real data and scoped to your org.', { label: 'Chat-First AI.' });
  bullet(ctx, 'Claude-powered deal summaries and follow-up email drafts, with per-org usage metering and quotas.', { label: 'AI assists.' });
  bullet(ctx, 'Customer quotes with revisions and branded PDFs, plus document storage.', { label: 'Quoting.' });
  bullet(ctx, 'Vendor RFQ + multi-vendor quote comparison, submittals, change orders, and red/yellow/green issue tracking (advanced profile).', { label: 'Vendor workflow.' });
  bullet(ctx, 'Dashboards, hit-rate and pipeline metrics, per-salesman and per-vendor reports.', { label: 'Reporting.' });
  bullet(ctx, 'Append-only audit log, self-service GDPR/CCPA export and deletion, role-based team access.', { label: 'Trust & compliance.' });

  heading(ctx, 'Why teams choose it');
  callout(ctx, {
    title: 'Three reasons it wins',
    lines: [
      'Conversational front door. Most CRMs make you hunt through menus. Here you ask a question and get an action — lower training cost, faster adoption.',
      'One codebase, many shapes. A vanilla 6-stage pipeline and a 29-stage manufacturer’s-rep lifecycle run side by side, switched by an org profile — no forks, no rebuild.',
      'Honest pricing. Roughly 50%+ less per seat than HubSpot Sales Hub Pro, with modules you turn on only when you need them.',
    ],
  });

  heading(ctx, 'Plans at a glance');
  table(
    ctx,
    [
      { w: 110, header: 'Plan' },
      { w: 120, header: 'Price', align: 'left' },
      { w: 270, header: 'Best for' },
    ],
    [
      [{ t: 'Free', font: F.bold }, '$0 · 1 user', 'Trying the real CRM core, single seat.'],
      [{ t: 'Starter', font: F.bold }, '$15 / seat / mo', 'Small teams + quotes, documents, more AI.'],
      [{ t: 'Professional', font: F.bold }, '$39 / seat / mo', 'Vendor RFQ workflow, reports, AI plugin drafts.'],
      [{ t: 'Enterprise', font: F.bold }, 'Custom', 'Negotiated capacity + white-label at scale.'],
    ]
  );
  gap(ctx, 6);
  para(ctx, `Try it at ${APP}  ·  Learn more at ${WEBSITE}`, { font: F.bold, size: 10.5, color: C.accentDark });

  finalize(ctx, 'Product Overview');
  return save(ctx, 'The-Open-CRM_Product-Overview.pdf');
}

// ========================================================================
// DOC 2 — Pricing & Features (honest: shipped vs roadmap)
// ========================================================================
async function buildPricing() {
  const ctx = newDoc();
  cover(ctx, {
    kicker: 'Pricing & Features',
    title: 'What’s included,\nand what’s honest.',
    subtitle: 'Four tiers, modular features, and a clear line between what ships today and what’s on the roadmap.',
    blurb:
      'We price per seat and turn modules on per org, so a customer pays for what they use. This sheet is the side you can quote from on a call — every “shipped” item is exercisable in the live app today.',
  });

  heading(ctx, 'Tiers');
  table(
    ctx,
    [
      { w: 100, header: 'Tier' },
      { w: 110, header: 'Per user/mo' },
      { w: 290, header: 'What’s real' },
    ],
    [
      [{ t: 'Free', font: F.bold }, '$0 (1 user)', 'Real CRM core. Limited AI. Single seat.'],
      [{ t: 'Starter', font: F.bold }, '$15 / seat', 'Free + Quotes, Documents, Team, more AI.'],
      [{ t: 'Professional', font: F.bold }, '$39 / seat', 'Starter + Vendor RFQ workflow, Reports, AI plugin drafts + library, QuickBooks scaffold.'],
      [{ t: 'Enterprise', font: F.bold }, 'Custom', 'Negotiated capacity + white-label; pay-as-you-build.'],
    ]
  );
  gap(ctx, 4);

  heading(ctx, 'Feature matrix');
  para(ctx, 'A check means included and shipped at that tier. “Adv.” marks features in the advanced manufacturer’s-rep profile.', { size: 9.5, color: C.muted });
  const yes = { t: '✓', align: 'center', color: C.green, font: F.bold };
  const no = { t: '—', align: 'center', color: C.faint };
  const featCols = [
    { w: 250, header: 'Capability' },
    { w: 58, header: 'Free', align: 'center' },
    { w: 62, header: 'Starter', align: 'center' },
    { w: 50, header: 'Pro', align: 'center' },
    { w: 70, header: 'Enterprise', align: 'center' },
  ];
  table(ctx, featCols, [
    ['Companies, contacts, deals, activities, tasks', yes, yes, yes, yes],
    ['Drag-and-drop Kanban pipeline', yes, yes, yes, yes],
    ['Chat-First AI copilot (multi-turn, tool-grounded)', { t: '20/day', align: 'center', color: C.muted }, { t: '200/day', align: 'center', color: C.muted }, { t: '200/day', align: 'center', color: C.muted }, { t: 'Neg.', align: 'center', color: C.muted }],
    ['AI deal summaries + follow-up drafts', yes, yes, yes, yes],
    ['Per-org AI usage metering + quotas', yes, yes, yes, yes],
    ['Customer quotes + revisions + branded PDF', no, yes, yes, yes],
    ['Document storage', no, yes, yes, yes],
    ['Vendor RFQ + multi-vendor comparison (Adv.)', no, no, yes, yes],
    ['Submittals, change orders, issue tracking (Adv.)', no, no, yes, yes],
    ['Reports: per-salesman, per-vendor, time-series', no, no, yes, yes],
    ['AI plugin drafts + curated library', no, no, yes, yes],
    ['White-label per-org branding', no, no, yes, yes],
    ['Team invites + role-based access', no, yes, yes, yes],
    ['Per-org feature flags (module toggles)', no, yes, yes, yes],
    ['Append-only audit log', yes, yes, yes, yes],
    ['GDPR/CCPA self-service export + deletion', yes, yes, yes, yes],
    ['REST API access', no, yes, yes, yes],
    ['Multi-tenant workspace', { t: '1 user', align: 'center', color: C.muted }, { t: '≤10', align: 'center', color: C.muted }, { t: '≤50', align: 'center', color: C.muted }, { t: '∞', align: 'center', color: C.muted }],
  ]);
  gap(ctx, 2);

  heading(ctx, 'Straight talk: live vs. coming');
  callout(ctx, {
    title: 'Live today — quote freely',
    tint: '#F0FAF3',
    edge: '#CDEBD6',
    accent: C.green,
    lines: [
      'Chat-First copilot, pipeline, contacts, quotes, vendor workflow, reports, white-label branding, per-org feature flags, audit log, and GDPR self-service all run in the live deployment now.',
      'AI deal summaries and follow-up drafts are shipped and metered per org.',
    ],
  });
  callout(ctx, {
    title: 'Config-dependent — set up per customer',
    tint: '#FFF8EC',
    edge: '#F3E2BE',
    accent: C.amber,
    lines: [
      'Email (Gmail/SendGrid), QuickBooks, Teams/Zoom webhooks, and Stripe billing are wired but need per-customer keys/activation. Upgrades are processed manually until Stripe keys are live on a deployment.',
      '2FA/TOTP is scaffolded; wiring is in progress.',
    ],
  });
  callout(ctx, {
    title: 'Roadmap — do NOT sell as shipped',
    tint: '#FBF1F1',
    edge: '#EBD0D0',
    accent: '#B91C1C',
    lines: [
      'Live plugin execution (sandboxed runtime), AI campaigns, plugin marketplace publishing, on-premise deployment, and SOC 2 / ISO 27001 are roadmap. Plugin specs persist as drafts today; live execution is next.',
    ],
  });

  finalize(ctx, 'Pricing & Features');
  return save(ctx, 'The-Open-CRM_Pricing-and-Features.pdf');
}

// ========================================================================
// DOC 3 — Sales & Customer-Success Playbook + FAQ (the enablement piece)
// ========================================================================
async function buildPlaybook() {
  const ctx = newDoc();
  cover(ctx, {
    kicker: 'Partner Enablement',
    title: 'Sales & Customer-\nSuccess Playbook',
    subtitle: 'How to position The Open CRM, where it fits across the sales and account-management lifecycle, and answers to the questions buyers ask most.',
    blurb:
      'This is the working document for pitching and running the business on the product. It gives you the talk track, a stage-by-stage map of where the CRM earns its keep, a five-minute demo path, and a buyer FAQ. Everything here is grounded in what ships today.',
  });

  metaStrip(ctx, [
    { k: 'Audience', v: 'Partner who may pitch and operate the product' },
    { k: 'Use', v: 'Pre-call prep, demo script, objection handling' },
    { k: 'Source of truth', v: 'PRICING_AND_FEATURES.md (verify before quoting numbers)' },
  ]);

  // --- Positioning ---
  heading(ctx, 'The one-line pitch');
  callout(ctx, {
    title: null,
    accent: C.accent,
    lines: [
      { t: '“The Open CRM is a white-label sales CRM with an AI copilot at the front door — it runs everything from a simple pipeline to a full manufacturer’s-rep quoting lifecycle, for roughly half the per-seat cost of HubSpot.”', c: C.navy },
    ],
  });
  para(ctx, 'Lead with the buyer’s shape. There are three:');
  bullet(ctx, 'Pipeline, contacts, follow-up in one place; the copilot tells them what to do each day. Pitch simplicity and adoption.', { label: 'Growing sales team →' });
  bullet(ctx, 'RFQ → vendor quotes → customer quote → PO → submittal → shipment → invoice, all tracked. Pitch the 29-stage lifecycle and issue tracking.', { label: 'Manufacturer’s rep →' });
  bullet(ctx, 'Their brand, their terminology, their modules. Pitch white-label per-org branding and feature flags.', { label: 'Vertical operator →' });

  // --- Where it fits in the sales process ---
  heading(ctx, 'Where it fits in the SALES process');
  para(ctx, 'Map each stage of the deal to the feature that carries it. This is how you answer “what would I actually use it for?”');
  table(
    ctx,
    [
      { w: 120, header: 'Sales stage' },
      { w: 200, header: 'What the rep does' },
      { w: 160, header: 'What the CRM provides' },
    ],
    [
      [{ t: 'Prospect', font: F.bold }, 'Capture companies and contacts; log first touches.', 'Companies/contacts CRUD, activity log, CSV import.'],
      [{ t: 'Qualify', font: F.bold }, 'Move deals onto the pipeline; decide who’s worth time.', 'Kanban pipeline, hot-deal flag, AI deal summary.'],
      [{ t: 'Quote', font: F.bold }, 'Price it; for reps, gather vendor quotes and compare.', 'Customer quotes + branded PDF; vendor RFQ + multi-vendor comparison (Adv.).'],
      [{ t: 'Negotiate', font: F.bold }, 'Handle revisions, change orders, and open issues.', 'Quote revisions, change orders, red/yellow/green issues (Adv.).'],
      [{ t: 'Follow up', font: F.bold }, 'Keep deals warm; chase the ones going quiet.', 'Chat copilot (“who’s gone dark?”), AI follow-up drafts, tasks.'],
      [{ t: 'Close', font: F.bold }, 'Win/lose the deal; record the outcome.', 'Stage transition to Closed-Won/Lost; dashboard hit-rate.'],
      [{ t: 'Report', font: F.bold }, 'See what’s working across reps and vendors.', 'Dashboard, per-salesman + per-vendor reports, time-series.'],
    ]
  );
  callout(ctx, {
    title: 'The daily habit that drives stickiness',
    accent: C.sky,
    tint: '#EEF7FC',
    edge: '#CDE6F2',
    lines: [
      'Coach every user to open the app and ask “what should I do today?” The copilot answers from their real pipeline — overdue tasks, hot deals, deals gone dark. A CRM people open daily is a CRM that renews.',
    ],
  });

  // --- Where it fits in customer management ---
  heading(ctx, 'Where it fits in CUSTOMER MANAGEMENT');
  para(ctx, 'The deal doesn’t end at Closed-Won. Here’s how the same tool carries the account afterward — useful both for your customers’ post-sale work and for how you run YOUR book of CRM customers.');
  bullet(ctx, 'Keep every account as a company with its contacts, activity history, and documents in one record — the institutional memory survives staff turnover.', { label: 'Single account record.' });
  bullet(ctx, 'For rep workflows, post-sale stages (submittal → shipment → invoice) and issue tracking keep delivery visible after the sale closes.', { label: 'Post-sale lifecycle.' });
  bullet(ctx, 'Tasks with due dates plus copilot nudges surface accounts that have gone quiet, so renewals and check-ins don’t slip.', { label: 'Proactive retention.' });
  bullet(ctx, 'Self-service chat Debug mode lets a customer ask “why didn’t my email send?” and read their own audit log — fewer support tickets for you to field.', { label: 'Lower support load.' });
  bullet(ctx, 'Append-only audit log, GDPR/CCPA export and deletion, and role-based access make account data defensible in a procurement or compliance review.', { label: 'Trust at renewal.' });

  // --- Talk track ---
  heading(ctx, 'Talk track — what to say (and not say)');
  callout(ctx, {
    title: 'Claim freely (it’s live)',
    accent: C.green,
    tint: '#F0FAF3',
    edge: '#CDEBD6',
    lines: [
      'Chat-First front door grounded in real pipeline · multi-tenant SaaS on Google Cloud · pipeline + contacts + quotes out of the box · AI summaries and follow-up drafts · per-org feature flags · tamper-resistant audit log · GDPR/CCPA self-service · white-label branding · ~50%+ less per seat than HubSpot Sales Hub Pro.',
    ],
  });
  callout(ctx, {
    title: 'Surface these caveats up front (don’t get caught)',
    accent: C.amber,
    tint: '#FFF8EC',
    edge: '#F3E2BE',
    lines: [
      'Plugin runtime is in build-out — drafts persist and the library installs, but live execution is coming next.',
      'Stripe billing is wired but awaiting key activation; upgrades are processed manually today.',
      'QuickBooks / Teams / Zoom need per-customer wiring. We’re pre-pen-test and pre-SOC-2 (pen test scheduled at customer #5).',
    ],
  });
  callout(ctx, {
    title: 'Do NOT claim until it ships',
    accent: '#B91C1C',
    tint: '#FBF1F1',
    edge: '#EBD0D0',
    lines: [
      'Live plugin execution / live AI automations · AI campaigns · plugin marketplace · on-premise deployment · SOC 2 / ISO 27001 / PCI · “pen-tested by [vendor]” · chat that remembers past sessions or learns from past emails · voice input.',
    ],
  });

  // --- Demo path ---
  heading(ctx, 'Five-minute demo path');
  bullet(ctx, 'Sign in → you land on the chat front door. Type “what should I do today?” Show the curated action.', { label: '1.' });
  bullet(ctx, 'Open the Kanban; drag a deal between stages. Flip a deal hot and ask the copilot “what hot deals do I have?”', { label: '2.' });
  bullet(ctx, 'Open a deal → generate an AI summary, then “draft a check-in email.”', { label: '3.' });
  bullet(ctx, 'For a rep audience: switch to the advanced profile, show vendor RFQ → multi-vendor comparison → a red/blocking issue.', { label: '4.' });
  bullet(ctx, 'Finish on the dashboard — hit rate, pipeline value — then show /admin/branding to prove white-label.', { label: '5.' });

  // --- FAQ ---
  heading(ctx, 'Buyer FAQ');
  const faq = [
    ['Where does this fit — is it a sales tool or a customer-management tool?',
      'Both, on one record. It runs the deal from prospect to close (pipeline, quoting, follow-up) and then carries the account afterward (history, documents, post-sale stages, tasks, retention nudges). You don’t hand off between systems.'],
    ['How is it different from HubSpot or Salesforce?',
      'Three things: the front door is a conversation, not a menu (lower training cost); one codebase flexes from a simple pipeline to a 29-stage rep lifecycle without a custom build; and it’s roughly half the per-seat cost of HubSpot Sales Hub Pro with modules you switch on per org.'],
    ['What does it cost?',
      'Free for one seat, $15/seat Starter, $39/seat Professional, custom Enterprise. Verify current numbers against the canonical pricing doc before quoting — they’re kept in sync with the live billing config.'],
    ['Do we need the AI to be useful?',
      'No. The CRM core works fully without AI. When an AI key is configured you get the copilot, deal summaries, and follow-up drafts; when it isn’t, those surfaces show a clear “AI isn’t activated” banner instead of breaking.'],
    ['Is our data safe and private?',
      'Every record is hard-scoped to your organization at the query layer — cross-org access is structurally prevented. There’s an append-only audit log (tamper-resistant at the database level), JWT auth with bcrypt, rate limiting, and self-service GDPR/CCPA export and deletion. Note we’re pre-SOC-2 and pre-pen-test today; both are on the roadmap.'],
    ['Can we use our own branding?',
      'Yes — per-org display name, logo, primary color, and custom terminology, set in admin. Modules can be toggled on or off per organization with feature flags.'],
    ['What about integrations — email, accounting, video?',
      'Email (Gmail/SendGrid), QuickBooks Online, and Teams/Zoom webhooks are built and need per-customer keys to switch on. A REST API is available on paid tiers. Be honest that these are config steps, not instant.'],
    ['Can we get our existing data in?',
      'Yes — CSV import for companies, contacts, and deals via the import wizard.'],
    ['Can it automate tasks for us?',
      'Today: trigger-based automation rules (stale-deal alerts, expiring quotes, renewal reminders) and AI-generated plugin drafts you can save and install from a curated library. Live plugin execution is the next build — don’t promise it as running yet.'],
    ['How do we get started / can we self-serve sign-up?',
      'Early access runs through an access-request approval gate — prospects request access and we approve same-day. Say “request access; we approve same-day during early access,” not “sign in this afternoon.”'],
  ];
  for (const [q, a] of faq) {
    ensure(ctx, 40);
    subheading(ctx, q);
    para(ctx, a, { size: 10 });
  }

  heading(ctx, 'Before any pricing call');
  bullet(ctx, 'Re-read the canonical pricing & features doc — quote numbers from it, not memory.');
  bullet(ctx, 'Confirm which features are live on the specific deployment you’re demoing.');
  bullet(ctx, 'Lead with the buyer’s shape; surface caveats before they’re asked; never claim a roadmap item as shipped.');

  finalize(ctx, 'Sales & Customer-Success Playbook');
  return save(ctx, 'The-Open-CRM_Sales-and-Customer-Success-Playbook.pdf');
}

// ========================================================================
// DOC 4 — Objection-Handling Cheat Sheet
// ========================================================================
function objectionItem(ctx, { q, reframe, say }) {
  ensure(ctx, 70);
  gap(ctx, 2);
  text(ctx, '“' + q + '”', { font: F.bold, size: 11, color: C.navy });
  gap(ctx, 4);
  text(ctx, reframe, { size: 10, color: C.ink, lineGap: 3 });
  gap(ctx, 4);
  callout(ctx, { accent: C.accent, lines: [{ t: 'Say: “' + say + '”', c: C.navy }] });
  gap(ctx, 2);
}

async function buildObjections() {
  const ctx = newDoc();
  cover(ctx, {
    kicker: 'Partner Enablement',
    title: 'Objection-Handling\nCheat Sheet',
    subtitle: 'The ten things buyers push back on, with a reframe and a line you can say out loud — all grounded in what ships today.',
    blurb:
      'Keep this open during calls. Each objection has a reframe (how to think about it) and a “Say:” line you can use almost verbatim. Never answer an objection by claiming a roadmap feature is shipped — the honest answer wins the deal and keeps the relationship.',
  });

  heading(ctx, 'Ten objections, answered');

  objectionItem(ctx, {
    q: 'You’re small / new — will you even be around in two years?',
    reframe: 'Don’t over-claim scale. Sell the upside of small: direct access, fast changes, honest roadmap, and a forkable codebase so they’re never locked in.',
    say: 'We’re early, and that’s the advantage — you get direct access and features shipped on your timeline, not a roadmap vote. And the data is yours: full export anytime, no lock-in.',
  });
  objectionItem(ctx, {
    q: 'We already use HubSpot / Salesforce.',
    reframe: 'Don’t attack the incumbent’s features; attack cost and complexity. Lead with the conversational front door and the half-price-per-seat math.',
    say: 'Most teams use a fraction of what they pay HubSpot for. We’re roughly half the per-seat cost, and instead of training people on menus, they just ask the app what to do today.',
  });
  objectionItem(ctx, {
    q: 'Switching is too painful — we’d lose our data and momentum.',
    reframe: 'Shrink the perceived effort. CSV import covers the big three objects; the pipeline is familiar on day one.',
    say: 'You bring companies, contacts, and deals over by CSV in the import wizard, and the Kanban works the way your team already thinks. We can run a pilot org alongside what you have.',
  });
  objectionItem(ctx, {
    q: 'Is our data secure? Do you have SOC 2?',
    reframe: 'Be precise and honest. Lead with what’s real (org isolation, audit log, GDPR self-service); state plainly that SOC 2 and pen-test are roadmap.',
    say: 'Every record is hard-scoped to your org at the query layer, there’s a tamper-resistant audit log, and your users can export or delete their own data. We’re pre-SOC-2 and pre-pen-test today — both are on the roadmap, pen test at customer #5 — and I won’t pretend otherwise.',
  });
  objectionItem(ctx, {
    q: 'The price seems too low — what’s the catch?',
    reframe: 'Reframe low price as a structural choice, not a fire sale. Modular feature flags mean they pay for what they use.',
    say: 'No catch — we run lean on Google Cloud and turn modules on per org, so you’re not subsidizing features you don’t use. The core CRM is genuinely complete at these prices.',
  });
  objectionItem(ctx, {
    q: 'We don’t need AI / we don’t trust AI with our data.',
    reframe: 'AI is additive, not required. The CRM is fully usable with AI off, and AI is scoped to their org and metered.',
    say: 'The CRM works completely without AI — if you never turn it on, you still get the full pipeline and quoting. When you do, it’s scoped to your org only, metered, and you see exactly what it’s used for.',
  });
  objectionItem(ctx, {
    q: 'You mentioned plugins / automations — is that actually working?',
    reframe: 'Draw the line cleanly. Drafts and the library are live; live execution is the next build. Honesty here protects every other claim.',
    say: 'Today you can generate automation specs in plain English and install from a curated library — those persist as drafts. Live execution is the next thing we’re shipping, so I won’t sell it as running yet.',
  });
  objectionItem(ctx, {
    q: 'Do you integrate with QuickBooks / Teams / Zoom / our email?',
    reframe: 'They’re built but need per-customer wiring. Frame as a short setup step, not a missing feature.',
    say: 'Yes — those are built in. They need your keys wired up once during onboarding rather than working instantly, and there’s a REST API on paid tiers if you want to connect something custom.',
  });
  objectionItem(ctx, {
    q: 'What if we outgrow it?',
    reframe: 'Show the headroom: vanilla pipeline → 29-stage rep lifecycle → white-label, all on one platform, plus Enterprise negotiation.',
    say: 'The same platform runs from a simple pipeline up to a 29-stage manufacturer’s-rep lifecycle and full white-label branding. You scale by turning modules on, not by migrating again.',
  });
  objectionItem(ctx, {
    q: 'Who supports us if something breaks?',
    reframe: 'Turn thin support into a feature: in-app self-service diagnostics plus direct founder/partner access.',
    say: 'Two layers: your team can ask the app in plain English “why didn’t my email send?” and read their own audit trail, and for anything past that you have a direct line to us, not a ticket queue.',
  });

  finalize(ctx, 'Objection-Handling Cheat Sheet');
  return save(ctx, 'The-Open-CRM_Objection-Handling-Cheat-Sheet.pdf');
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const out = [];
  out.push(await buildOverview());
  out.push(await buildPricing());
  out.push(await buildPlaybook());
  out.push(await buildObjections());
  console.log('Generated:');
  out.forEach((p) => console.log('  ' + p));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
