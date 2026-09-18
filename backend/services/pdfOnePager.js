// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Record one-pager PDF (CMN_REQUIREMENTS.md §1.7) — an org-branded, strictly
// single-page "spec sheet" for a deal, company, or contact. CMN uses these as
// media-kit site sheets; generic orgs get property sheets, candidate
// profiles, product specs.
//
// Same pdfkit conventions and neutral palette as pdfPurchaseOrder.js /
// pdfSalesQuote.js so all our PDFs read as one product — but this one honors
// the org's branding blob (organizations.branding, migration 055): the
// displayName replaces the org name, primaryColor drives the accent bar and
// highlights, and the logo (fetched by the route, passed here as a buffer)
// sits in the header.
//
// The template (one_pager_templates.config, migration 161 — or the built-in
// default per entity) decides which fields render, in what order, with what
// labels, plus the optional photo strip and footer line. Values that are
// empty are skipped entirely — no orphan labels on a customer-facing sheet.
//
// Everything is measured against a fixed single-page budget: the field grid
// yields space to the photo strip and notes block, and whatever doesn't fit
// is dropped rather than spilling onto page 2.

const PDFDocument = require('pdfkit');
const pool = require('../db');
const storage = require('./storage');

// Neutral fallbacks — primary/primaryDark are overridden per-org when the
// branding blob carries a primaryColor.
const BASE = {
  primary: '#1d4ed8',     // blue-700
  border: '#e5e7eb',      // gray-200
  textMuted: '#6b7280',   // gray-500
  textSoft: '#9ca3af',    // gray-400
  text: '#111827',        // gray-900
  panel: '#f9fafb',       // gray-50
};

// ---------------------------------------------------------------------------
// Standard field registries — one per entity. `source` names the column (or
// joined alias) on the fetched record; `type` drives formatting.
// ---------------------------------------------------------------------------

const STANDARD_FIELDS = {
  deal: {
    stage:               { label: 'Stage',            source: 'stage',               type: 'enum' },
    deal_type:           { label: 'Pipeline',         source: 'deal_type',           type: 'enum' },
    amount:              { label: 'Amount',           source: 'amount',              type: 'currency' },
    closed_amount:       { label: 'Closed amount',    source: 'closed_amount',       type: 'currency' },
    expected_close_date: { label: 'Expected close',   source: 'expected_close_date', type: 'date' },
    closed_date:         { label: 'Closed',           source: 'closed_date',         type: 'date' },
    company:             { label: 'Company',          source: 'company_name',        type: 'text' },
    customer:            { label: 'Customer',         source: 'customer_name',       type: 'text' },
    vendor:              { label: 'Vendor',           source: 'vendor_name',         type: 'text' },
    contact:             { label: 'Contact',          source: 'contact_name',        type: 'text' },
    external_ref:        { label: 'Reference #',      source: 'external_ref',        type: 'text' },
    po_number:           { label: 'PO #',             source: 'po_number',           type: 'text' },
    vertical:            { label: 'Vertical',         source: 'vertical',            type: 'text' },
    phase:               { label: 'Phase',            source: 'phase',               type: 'enum' },
    target_ship_date:    { label: 'Target ship',      source: 'target_ship_date',    type: 'date' },
    actual_ship_date:    { label: 'Shipped',          source: 'actual_ship_date',    type: 'date' },
    ship_to:             { label: 'Ship to',          source: 'ship_to',             type: 'text' },
    description:         { label: 'Description',      source: 'description',         type: 'text' },
    tags:                { label: 'Tags',             source: 'tags',                type: 'tags' },
    created_at:          { label: 'Created',          source: 'created_at',          type: 'date' },
  },
  company: {
    industry:        { label: 'Industry',        source: 'industry',        type: 'text' },
    type:            { label: 'Type',            source: 'type',            type: 'enum' },
    status:          { label: 'Status',          source: 'status',          type: 'enum' },
    lifecycle_stage: { label: 'Lifecycle stage', source: 'lifecycle_stage', type: 'enum' },
    location:        { label: 'Location',        source: 'location',        type: 'text' },
    website:         { label: 'Website',         source: 'website',         type: 'text' },
    phone:           { label: 'Phone',           source: 'phone',           type: 'text' },
    employee_count:  { label: 'Employees',       source: 'employee_count',  type: 'number' },
    annual_revenue:  { label: 'Annual revenue',  source: 'annual_revenue',  type: 'currency' },
    source:          { label: 'Source',          source: 'source',          type: 'text' },
    created_at:      { label: 'Customer since',  source: 'created_at',      type: 'date' },
  },
  contact: {
    job_title:     { label: 'Title',        source: 'job_title',     type: 'text' },
    email:         { label: 'Email',        source: 'email',         type: 'text' },
    phone:         { label: 'Phone',        source: 'phone',         type: 'text' },
    company:       { label: 'Company',      source: 'company_name',  type: 'text' },
    status:        { label: 'Status',       source: 'status',        type: 'enum' },
    contact_role:  { label: 'Role',         source: 'contact_role',  type: 'enum' },
    tags:          { label: 'Tags',         source: 'tags',          type: 'tags' },
    last_touch_at: { label: 'Last touch',   source: 'last_touch_at', type: 'date' },
    created_at:    { label: 'Added',        source: 'created_at',    type: 'date' },
  },
};

const DEFAULT_FIELD_ORDER = {
  deal:    ['stage', 'amount', 'expected_close_date', 'company', 'customer', 'contact', 'external_ref', 'vertical', 'tags'],
  company: ['industry', 'type', 'location', 'website', 'phone', 'employee_count', 'annual_revenue', 'status', 'lifecycle_stage'],
  contact: ['job_title', 'email', 'phone', 'company', 'status', 'contact_role', 'tags', 'last_touch_at'],
};

// Maps the singular entity of a one-pager to the plural entity key used by
// org_field_definitions (migration 070).
const FIELD_DEF_ENTITY = { deal: 'deals', company: 'companies', contact: 'contacts' };

function getDefaultTemplate(entity) {
  return {
    id: null,
    name: 'Standard one-pager',
    entity,
    config: {
      fields: (DEFAULT_FIELD_ORDER[entity] || []).map((key) => ({ key })),
      include_photos: true,
      photo_count: 2,
      include_notes: true,
      footer_text: null,
    },
  };
}

// Coerce a template config (possibly user-authored JSONB) into a safe,
// fully-populated shape.
function normalizeTemplateConfig(entity, config) {
  const cfg = (config && typeof config === 'object') ? config : {};
  const rawFields = Array.isArray(cfg.fields) && cfg.fields.length > 0
    ? cfg.fields
    : (DEFAULT_FIELD_ORDER[entity] || []).map((key) => ({ key }));
  const fields = rawFields
    .map((f) => (typeof f === 'string' ? { key: f } : f))
    .filter((f) => f && typeof f.key === 'string' && f.key.trim() !== '')
    .map((f) => ({ key: f.key.trim(), label: typeof f.label === 'string' && f.label.trim() !== '' ? f.label.trim() : null }));
  const photoCount = Number(cfg.photo_count);
  return {
    fields,
    include_photos: cfg.include_photos !== false,
    photo_count: Number.isFinite(photoCount) ? Math.max(1, Math.min(4, Math.trunc(photoCount))) : 2,
    include_notes: cfg.include_notes !== false,
    footer_text: typeof cfg.footer_text === 'string' && cfg.footer_text.trim() !== '' ? cfg.footer_text.trim() : null,
  };
}

// ---------------------------------------------------------------------------
// Value formatting
// ---------------------------------------------------------------------------

function titleCase(s) {
  return String(s)
    .replace(/[_-]+/g, ' ')
    .replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

function fmtMoney(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return null;
  const decimals = Number.isInteger(num) ? 0 : 2;
  return `$${num.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
}

function fmtDate(d) {
  // Date-only strings (DATE columns serialized as '2026-03-05') must format
  // in UTC — local parsing shifts them a day west of Greenwich.
  if (typeof d === 'string') {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:$|T00:00:00(?:\.000)?Z?$)/.exec(d.trim());
    if (m) {
      const dt = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
      return dt.toLocaleDateString('en-US', { timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric' });
    }
  }
  const dt = typeof d === 'string' || typeof d === 'number' ? new Date(d) : d;
  if (!(dt instanceof Date) || Number.isNaN(dt.getTime())) return null;
  return dt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

function isEmpty(v) {
  return v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);
}

function formatValue(value, type) {
  if (isEmpty(value)) return null;
  switch (type) {
    case 'currency': return fmtMoney(value);
    case 'date':     return fmtDate(value);
    case 'number': {
      const num = Number(value);
      return Number.isFinite(num) ? num.toLocaleString('en-US') : String(value);
    }
    case 'boolean':  return (value === true || value === 'true') ? 'Yes' : 'No';
    case 'enum':     return titleCase(value);
    case 'tags':
    case 'multiselect':
      return (Array.isArray(value) ? value : [value]).map(String).join(' · ');
    default:         return String(value);
  }
}

// org_field_definitions.type → our formatter type
const CUSTOM_TYPE_MAP = {
  text: 'text', number: 'number', date: 'date',
  select: 'text', multiselect: 'multiselect', boolean: 'boolean',
};

/**
 * Resolve the template's ordered field list against the record into
 * [{ label, value }] rows. Standard keys hit the entity registry; anything
 * else is looked up in record.custom_fields, with the label taken from the
 * org's field definitions (org_field_definitions) when available.
 * Empty values are dropped — never render an orphan label.
 */
function resolveFieldRows({ entity, record, fields, fieldDefs = [] }) {
  const registry = STANDARD_FIELDS[entity] || {};
  const custom = (record && record.custom_fields && typeof record.custom_fields === 'object') ? record.custom_fields : {};
  const defByName = new Map((fieldDefs || []).map((d) => [d.name, d]));
  const rows = [];
  for (const f of fields || []) {
    const std = registry[f.key];
    if (std) {
      const value = formatValue(record ? record[std.source] : null, std.type);
      if (value !== null) rows.push({ label: f.label || std.label, value });
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(custom, f.key)) {
      const def = defByName.get(f.key);
      const type = CUSTOM_TYPE_MAP[def?.type] || 'text';
      const value = formatValue(custom[f.key], type);
      if (value !== null) rows.push({ label: f.label || def?.label || titleCase(f.key), value });
    }
    // Unknown key with no custom value: skip silently. Templates survive
    // field deletions without breaking the sheet.
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Photos — first N image documents attached to the record. Bytes come from
// the DB blob when present, else GCS via the storage service. Any failure
// (storage unconfigured, missing object, bad credentials) skips that photo
// silently — a media kit without photos is still a valid sheet.
// ---------------------------------------------------------------------------

const IMAGE_MIMES = new Set(['image/jpeg', 'image/jpg', 'image/png']);

async function loadPhotos({ entity, recordId, scopeField, scopeValue, limit = 2 }) {
  if (!limit || limit < 1) return [];
  let rows;
  try {
    const r = await pool.query(
      `SELECT id, filename, mime_type, content, gcs_object_path
         FROM documents
        WHERE related_type = $1 AND related_id = $2 AND ${scopeField} = $3
          AND LOWER(COALESCE(mime_type, '')) IN ('image/jpeg', 'image/jpg', 'image/png')
        ORDER BY created_at ASC, id ASC
        LIMIT $4`,
      [entity, recordId, scopeValue, limit]
    );
    rows = r.rows;
  } catch (err) {
    console.warn('one-pager photo query failed (continuing without photos):', err.message);
    return [];
  }
  const photos = [];
  for (const doc of rows) {
    try {
      let buffer = null;
      if (doc.content && doc.content.length > 0) {
        buffer = doc.content;
      } else if (doc.gcs_object_path) {
        buffer = await storage.downloadBuffer(doc.gcs_object_path);
      }
      if (buffer && buffer.length > 0) photos.push({ buffer, filename: doc.filename });
    } catch (err) {
      console.warn(`one-pager photo fetch failed for document ${doc.id} (skipping):`, err.message);
    }
  }
  return photos;
}

// ---------------------------------------------------------------------------
// Branding
// ---------------------------------------------------------------------------

function clampChannel(v) { return Math.max(0, Math.min(255, Math.round(v))); }

function shadeHex(hex, factor) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const r = clampChannel(((n >> 16) & 0xff) * factor);
  const g = clampChannel(((n >> 8) & 0xff) * factor);
  const b = clampChannel((n & 0xff) * factor);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

function buildPalette(branding) {
  const primary = shadeHex(branding?.primaryColor, 1) || BASE.primary;
  return {
    ...BASE,
    primary,
    primaryDark: shadeHex(primary, 0.72) || primary,
  };
}

const ENTITY_TAGLINE = { deal: 'Deal one-pager', company: 'Company one-pager', contact: 'Contact one-pager' };

function recordTitle(entity, record) {
  if (entity === 'contact') {
    return [record.first_name, record.last_name].filter(Boolean).join(' ') || 'Contact';
  }
  if (entity === 'company') return record.name || 'Company';
  return record.title || 'Deal';
}

function recordSubtitle(entity, record) {
  if (entity === 'deal') {
    return [record.customer_name || record.company_name, record.contact_name].filter(Boolean).join(' · ') || null;
  }
  if (entity === 'company') {
    return [record.industry, record.location].filter(Boolean).join(' · ') || null;
  }
  return [record.job_title, record.company_name].filter(Boolean).join(' · ') || null;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const PAGE = { margin: 50 };

function drawHeader(doc, { orgName, tagline, logo, brand }) {
  const W = doc.page.width;
  // Brand accent bar across the very top.
  doc.rect(0, 0, W, 6).fill(brand.primary);

  const top = 28;
  let logoDrawn = false;
  if (logo && logo.buffer) {
    try {
      doc.image(logo.buffer, W - PAGE.margin - 120, top, { fit: [120, 44], align: 'right' });
      logoDrawn = true;
    } catch (_) { /* corrupt/unsupported logo image — skip */ }
  }

  doc.fillColor(brand.text).font('Helvetica-Bold').fontSize(16)
    .text(orgName || 'The Open CRM', PAGE.margin, top, { width: W - PAGE.margin * 2 - (logoDrawn ? 140 : 0) });
  doc.fillColor(brand.textMuted).font('Helvetica').fontSize(8.5)
    .text(tagline.toUpperCase(), PAGE.margin, doc.y + 2, { characterSpacing: 1 });

  const bottom = Math.max(doc.y, top + (logoDrawn ? 48 : 0)) + 12;
  doc.moveTo(PAGE.margin, bottom).lineTo(W - PAGE.margin, bottom)
    .lineWidth(0.75).strokeColor(brand.border).stroke();
  doc.y = bottom + 16;
}

function drawTitle(doc, { title, subtitle, brand }) {
  const W = doc.page.width;
  doc.fillColor(brand.text).font('Helvetica-Bold').fontSize(23)
    .text(title, PAGE.margin, doc.y, { width: W - PAGE.margin * 2 });
  if (subtitle) {
    doc.fillColor(brand.textMuted).font('Helvetica').fontSize(10.5)
      .text(subtitle, PAGE.margin, doc.y + 3, { width: W - PAGE.margin * 2 });
  }
  // Short brand-color underline — a quiet accent, not a full-width rule.
  const y = doc.y + 10;
  doc.rect(PAGE.margin, y, 56, 3).fill(brand.primary);
  doc.y = y + 20;
}

/**
 * Two-column field grid. Labels are small-caps muted; values 10.5pt. Each
 * grid row's height is the max of its two cells; a hairline divider closes
 * every row. Rows that would cross `maxY` are dropped (single-page contract).
 * Returns the number of rows rendered.
 */
function drawFieldGrid(doc, { rows, brand, maxY }) {
  if (!rows.length) return 0;
  const W = doc.page.width;
  const gutter = 28;
  const colW = (W - PAGE.margin * 2 - gutter) / 2;
  const xs = [PAGE.margin, PAGE.margin + colW + gutter];
  const labelSize = 7.5;
  const valueSize = 10.5;
  const cellPadY = 11;

  let drawn = 0;
  for (let i = 0; i < rows.length; i += 2) {
    const pair = [rows[i], rows[i + 1]].filter(Boolean);
    // Measure the tallest cell in this grid row.
    let cellH = 0;
    for (const cell of pair) {
      doc.font('Helvetica').fontSize(valueSize);
      const vh = doc.heightOfString(cell.value, { width: colW });
      cellH = Math.max(cellH, 11 + Math.min(vh, valueSize * 1.2 * 3)); // label line + ≤3 value lines
    }
    const rowH = cellH + cellPadY * 2;
    if (doc.y + rowH > maxY) break;

    const topY = doc.y;
    pair.forEach((cell, idx) => {
      const x = xs[idx];
      doc.fillColor(brand.textSoft).font('Helvetica-Bold').fontSize(labelSize)
        .text(cell.label.toUpperCase(), x, topY + cellPadY, { width: colW, characterSpacing: 0.8, lineBreak: false });
      doc.fillColor(brand.text).font('Helvetica').fontSize(valueSize)
        .text(cell.value, x, topY + cellPadY + 12, { width: colW, height: valueSize * 1.2 * 3, ellipsis: true });
    });

    const lineY = topY + rowH;
    doc.moveTo(PAGE.margin, lineY).lineTo(W - PAGE.margin, lineY)
      .lineWidth(0.5).strokeColor(brand.border).stroke();
    doc.y = lineY;
    drawn += pair.length;
  }
  doc.y += 14;
  return drawn;
}

function drawPhotoStrip(doc, { photos, brand, maxY }) {
  if (!photos.length) return;
  const W = doc.page.width;
  const gutter = 10;
  const stripH = photos.length > 2 ? 120 : 150;
  if (doc.y + stripH > maxY) return; // no room — drop rather than spill
  const cellW = (W - PAGE.margin * 2 - gutter * (photos.length - 1)) / photos.length;
  const topY = doc.y;
  photos.forEach((photo, idx) => {
    const x = PAGE.margin + idx * (cellW + gutter);
    doc.save();
    doc.rect(x, topY, cellW, stripH).fill(brand.panel);
    doc.restore();
    try {
      doc.image(photo.buffer, x + 4, topY + 4, { fit: [cellW - 8, stripH - 8], align: 'center', valign: 'center' });
    } catch (_) { /* undecodable image — leave the quiet panel */ }
    doc.rect(x, topY, cellW, stripH).lineWidth(0.75).strokeColor(brand.border).stroke();
  });
  doc.y = topY + stripH + 16;
}

function drawNotes(doc, { notes, brand, maxY }) {
  if (!notes) return;
  const W = doc.page.width;
  const available = maxY - doc.y - 18;
  if (available < 30) return;
  doc.fillColor(brand.textSoft).font('Helvetica-Bold').fontSize(7.5)
    .text('NOTES', PAGE.margin, doc.y, { characterSpacing: 0.8 });
  doc.fillColor(brand.text).font('Helvetica').fontSize(9.5)
    .text(String(notes), PAGE.margin, doc.y + 4, {
      width: W - PAGE.margin * 2,
      height: available,
      ellipsis: true,
    });
}

function drawFooter(doc, { orgName, footerText, brand }) {
  const W = doc.page.width;
  const y = doc.page.height - 64;
  doc.moveTo(PAGE.margin, y).lineTo(W - PAGE.margin, y)
    .lineWidth(0.75).strokeColor(brand.border).stroke();
  let ty = y + 8;
  if (footerText) {
    doc.fillColor(brand.text).font('Helvetica-Oblique').fontSize(8.5)
      .text(footerText, PAGE.margin, ty, { width: W - PAGE.margin * 2, align: 'center', height: 22, ellipsis: true });
    ty = doc.y + 3;
  }
  doc.fillColor(brand.textMuted).font('Helvetica').fontSize(7.5)
    .text(
      `${orgName || 'The Open CRM'} · ${fmtDate(new Date())} · Generated by The Open CRM`,
      PAGE.margin, ty,
      { width: W - PAGE.margin * 2, align: 'center' }
    );
}

/**
 * Render a one-pager PDF to the given writable stream.
 *
 * @param {object} opts
 * @param {'deal'|'company'|'contact'} opts.entity
 * @param {object} opts.record     — org-scoped record incl. joined names + custom_fields
 * @param {object} [opts.template] — one_pager_templates row (or getDefaultTemplate())
 * @param {Array}  [opts.fieldDefs]— org_field_definitions rows for the entity
 * @param {object} [opts.branding] — organizations.branding blob
 * @param {string} [opts.orgName]  — organizations.name fallback
 * @param {Array}  [opts.photos]   — [{ buffer }] image buffers (JPEG/PNG)
 * @param {object} [opts.logo]     — { buffer } logo image bytes, or null
 */
function renderOnePagerPdf({ entity, record, template, fieldDefs, branding, orgName, photos = [], logo = null }, stream) {
  const tpl = template || getDefaultTemplate(entity);
  const config = normalizeTemplateConfig(entity, tpl.config);
  const brand = buildPalette(branding);
  const displayName = branding?.displayName || orgName || null;

  // Shallow bottom margin: the footer is drawn at a fixed y near the page
  // edge, and pdfkit auto-appends a page if text crosses the bottom margin —
  // which would break the single-page contract.
  const doc = new PDFDocument({
    size: 'LETTER',
    margins: { top: PAGE.margin, left: PAGE.margin, right: PAGE.margin, bottom: 18 },
  });
  doc.pipe(stream);

  drawHeader(doc, { orgName: displayName, tagline: ENTITY_TAGLINE[entity] || 'One-pager', logo, brand });
  drawTitle(doc, { title: recordTitle(entity, record), subtitle: recordSubtitle(entity, record), brand });

  const footerTop = doc.page.height - 74;
  const usablePhotos = config.include_photos ? photos.slice(0, config.photo_count) : [];
  const notes = config.include_notes && !isEmpty(record.notes) ? record.notes : null;

  // Budget the page bottom-up: footer is fixed; photos + notes reserve space
  // ahead of the grid so a field-heavy template can't push them off the page.
  const photoReserve = usablePhotos.length ? (usablePhotos.length > 2 ? 136 : 166) : 0;
  const notesReserve = notes ? 64 : 0;
  const gridMaxY = footerTop - photoReserve - notesReserve;

  const rows = resolveFieldRows({ entity, record, fields: config.fields, fieldDefs });
  drawFieldGrid(doc, { rows, brand, maxY: gridMaxY });
  drawPhotoStrip(doc, { photos: usablePhotos, brand, maxY: footerTop - notesReserve });
  drawNotes(doc, { notes, brand, maxY: footerTop });
  drawFooter(doc, { orgName: displayName, footerText: config.footer_text, brand });

  doc.end();
}

module.exports = {
  STANDARD_FIELDS,
  DEFAULT_FIELD_ORDER,
  FIELD_DEF_ENTITY,
  getDefaultTemplate,
  normalizeTemplateConfig,
  resolveFieldRows,
  formatValue,
  loadPhotos,
  buildPalette,
  renderOnePagerPdf,
};
