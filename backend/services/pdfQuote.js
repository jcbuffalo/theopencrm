// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Branded customer-quote PDF generation using pdfkit.
// Streams a binary PDF to the supplied writable stream (typically res).

const PDFDocument = require('pdfkit');

const BRAND = {
  primary: '#1d4ed8',     // blue-700
  primaryDark: '#1e3a8a', // blue-900
  border: '#e5e7eb',      // gray-200
  textMuted: '#6b7280',   // gray-500
  text: '#111827',        // gray-900
  rowAlt: '#f9fafb',      // gray-50
};

function fmtMoney(n) {
  if (n === null || n === undefined || n === '') return '—';
  const num = Number(n);
  return `$${num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtDate(d) {
  if (!d) return '—';
  const dt = typeof d === 'string' ? new Date(d) : d;
  return dt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

function lineTotal(li) {
  const qty = Number(li.quantity || 1);
  const unit = Number(li.unit_price || 0);
  const markup = Number(li.markup_pct || 0) / 100;
  return qty * unit * (1 + markup);
}

function header(doc, { quote, orgName, brand }) {
  const top = doc.y;

  doc.fillColor(brand.primary).rect(0, top, doc.page.width, 6).fill();
  doc.moveDown(0.5);

  doc.fillColor(brand.text).font('Helvetica-Bold').fontSize(22).text(orgName || 'ZANG Flow', 50, top + 22);
  doc.fillColor(brand.textMuted).font('Helvetica').fontSize(9)
    .text('Customer Quote', 50, doc.y + 2);

  doc.font('Helvetica-Bold').fontSize(11).fillColor(brand.text)
    .text(`Quote #${quote.id}`, doc.page.width - 200, top + 22, { width: 150, align: 'right' });
  doc.font('Helvetica').fontSize(9).fillColor(brand.textMuted)
    .text(`Revision ${quote.current_revision || 1}`, doc.page.width - 200, doc.y + 2, { width: 150, align: 'right' })
    .text(`Issued: ${fmtDate(new Date())}`, doc.page.width - 200, doc.y + 1, { width: 150, align: 'right' });
  if (quote.valid_until) {
    doc.text(`Valid until: ${fmtDate(quote.valid_until)}`, doc.page.width - 200, doc.y + 1, { width: 150, align: 'right' });
  }

  doc.y = top + 90;
  doc.fillColor(brand.border).rect(50, doc.y, doc.page.width - 100, 1).fill();
  doc.moveDown(1);
}

function customerBlock(doc, { quote, customer, brand }) {
  doc.fillColor(brand.textMuted).font('Helvetica-Bold').fontSize(8).text('PREPARED FOR', 50);
  doc.fillColor(brand.text).font('Helvetica-Bold').fontSize(13).text(customer?.name || quote.customer_name || '—', 50);
  doc.font('Helvetica').fontSize(10).fillColor(brand.text);
  if (customer?.location) doc.text(customer.location);
  if (customer?.website)  doc.text(customer.website);
  if (customer?.phone)    doc.text(customer.phone);
  doc.moveDown(0.7);
}

function titleBlock(doc, { quote, brand }) {
  doc.fillColor(brand.primaryDark).font('Helvetica-Bold').fontSize(14).text(quote.title || 'Quote');
  if (quote.deal_title) {
    doc.fillColor(brand.textMuted).font('Helvetica').fontSize(9).text(`Reference: ${quote.deal_title}`);
  }
  doc.moveDown(0.7);
}

function lineItemsTable(doc, { items, brand }) {
  const startX = 50;
  const usableWidth = doc.page.width - 100;
  const cols = [
    { key: 'description', label: 'Description', width: usableWidth * 0.46, align: 'left' },
    { key: 'qty',         label: 'Qty',         width: usableWidth * 0.08, align: 'right' },
    { key: 'unit',        label: 'Unit Price',  width: usableWidth * 0.16, align: 'right' },
    { key: 'markup',      label: 'Markup',      width: usableWidth * 0.10, align: 'right' },
    { key: 'total',       label: 'Total',       width: usableWidth * 0.20, align: 'right' },
  ];

  // header
  let x = startX;
  doc.fillColor(brand.primaryDark).rect(startX, doc.y, usableWidth, 22).fill();
  doc.fillColor('white').font('Helvetica-Bold').fontSize(9);
  for (const col of cols) {
    doc.text(col.label, x + 6, doc.y + 7, { width: col.width - 12, align: col.align });
    x += col.width;
  }
  doc.y += 22;

  // rows
  doc.font('Helvetica').fontSize(10).fillColor(brand.text);
  let alt = false;
  let runningTotal = 0;
  for (const li of items || []) {
    const total = lineTotal(li);
    runningTotal += total;
    const rowHeight = Math.max(20, doc.heightOfString(li.description || '', { width: cols[0].width - 12 }) + 8);

    if (alt) doc.fillColor(brand.rowAlt).rect(startX, doc.y, usableWidth, rowHeight).fill();
    alt = !alt;

    x = startX;
    doc.fillColor(brand.text);
    const top = doc.y + 5;
    doc.text(li.description || '', x + 6, top, { width: cols[0].width - 12, align: cols[0].align });
    if (li.vendor_name) {
      doc.fillColor(brand.textMuted).fontSize(8).text(`via ${li.vendor_name}`, x + 6, doc.y + 1, { width: cols[0].width - 12 });
      doc.fillColor(brand.text).fontSize(10);
    }
    x += cols[0].width;
    doc.text(String(li.quantity || 1), x + 6, top, { width: cols[1].width - 12, align: cols[1].align });
    x += cols[1].width;
    doc.text(fmtMoney(li.unit_price), x + 6, top, { width: cols[2].width - 12, align: cols[2].align });
    x += cols[2].width;
    doc.text(li.markup_pct ? `${li.markup_pct}%` : '—', x + 6, top, { width: cols[3].width - 12, align: cols[3].align });
    x += cols[3].width;
    doc.font('Helvetica-Bold').text(fmtMoney(total), x + 6, top, { width: cols[4].width - 12, align: cols[4].align });
    doc.font('Helvetica');

    doc.y = top + rowHeight - 5;
    if (doc.y > doc.page.height - 130) { doc.addPage(); }
  }

  // total
  doc.fillColor(brand.border).rect(startX, doc.y, usableWidth, 1).fill();
  doc.y += 8;

  const totalToShow = runningTotal || Number(items?.[0]?.total_override || 0);
  doc.fillColor(brand.text).font('Helvetica-Bold').fontSize(12);
  doc.text('Total', startX + cols[0].width + cols[1].width + cols[2].width + cols[3].width + 6, doc.y, {
    width: cols[4].width - 12, align: 'right',
  });
  doc.fontSize(14).fillColor(brand.primary);
  doc.text(fmtMoney(totalToShow), startX, doc.y - 16, {
    width: usableWidth - 12, align: 'right',
  });
  doc.fillColor(brand.text).fontSize(10);
  doc.moveDown(2);
}

function notesBlock(doc, { quote, brand }) {
  if (!quote.notes) return;
  doc.fillColor(brand.textMuted).font('Helvetica-Bold').fontSize(8).text('NOTES', 50);
  doc.fillColor(brand.text).font('Helvetica').fontSize(9).text(quote.notes, 50, doc.y + 2, { width: doc.page.width - 100 });
  doc.moveDown(1);
}

function termsBlock(doc, { brand }) {
  doc.fillColor(brand.textMuted).font('Helvetica-Bold').fontSize(8).text('TERMS', 50);
  const terms = [
    'This quote is valid for the period specified above and supersedes any prior quotation.',
    'Pricing is subject to vendor confirmation if quote is not converted to PO within 30 days.',
    'Payment terms: NET 30 unless otherwise agreed in writing.',
    'Lead times reflect vendor estimates and may be adjusted at order acknowledgement.',
  ];
  doc.fillColor(brand.text).font('Helvetica').fontSize(8.5);
  for (const t of terms) {
    doc.text(`• ${t}`, 50, doc.y + 2, { width: doc.page.width - 100 });
  }
  doc.moveDown(1);
}

function footer(doc, { orgName, brand }) {
  const y = doc.page.height - 60;
  doc.fillColor(brand.border).rect(50, y, doc.page.width - 100, 1).fill();
  doc.fillColor(brand.textMuted).font('Helvetica').fontSize(7)
    .text(
      'This quote is generated from data entered by the issuing organization. The software author makes no warranty as to its accuracy or completeness; recipients should independently verify pricing, lead times, and specifications before acting upon them.',
      50, y + 6,
      { width: doc.page.width - 100, align: 'center' }
    );
  doc.fillColor(brand.textMuted).font('Helvetica').fontSize(8)
    .text(`${orgName || 'ZANG Flow'} · Generated by ZANG Flow`, 50, y + 30, {
      width: doc.page.width - 100, align: 'center',
    });
}

/**
 * Render a quote PDF to the given writable stream.
 * `quote` includes top-level fields plus optional `line_items` and `revisions`.
 */
function renderQuotePdf({ quote, customer, orgName }, stream) {
  const doc = new PDFDocument({ size: 'LETTER', margin: 50, bufferPages: true });
  doc.pipe(stream);

  header(doc, { quote, orgName, brand: BRAND });
  customerBlock(doc, { quote, customer, brand: BRAND });
  titleBlock(doc, { quote, brand: BRAND });
  lineItemsTable(doc, { items: quote.line_items || [], brand: BRAND });
  notesBlock(doc, { quote, brand: BRAND });
  termsBlock(doc, { brand: BRAND });

  // footer on every page
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    footer(doc, { orgName, brand: BRAND });
  }

  doc.end();
}

module.exports = { renderQuotePdf };
