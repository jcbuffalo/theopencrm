// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Branded PDF for the GENERIC light-CPQ sales quote (sales_quotes /
// sales_quote_items). Separate from services/pdfQuote.js, which renders the
// bespoke Zang customer quote — this one has a product-catalog line table plus
// a subtotal / discount / tax / total summary block.
//
// Streams a binary PDF to the supplied writable stream (typically res). Same
// pdfkit conventions + brand palette as pdfQuote.js so the two look like one
// product.

const PDFDocument = require('pdfkit');

const BRAND = {
  primary: '#1d4ed8',     // blue-700
  primaryDark: '#1e3a8a', // blue-900
  border: '#e5e7eb',      // gray-200
  textMuted: '#6b7280',   // gray-500
  text: '#111827',        // gray-900
  rowAlt: '#f9fafb',      // gray-50
};

function fmtMoney(n, currency = 'USD') {
  if (n === null || n === undefined || n === '') return '—';
  const num = Number(n);
  const sym = currency === 'USD' ? '$' : '';
  return `${sym}${num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${sym ? '' : ' ' + currency}`;
}

function fmtDate(d) {
  if (!d) return '—';
  const dt = typeof d === 'string' ? new Date(d) : d;
  return dt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

function header(doc, { quote, orgName, brand }) {
  const top = doc.y;
  doc.fillColor(brand.primary).rect(0, top, doc.page.width, 6).fill();
  doc.moveDown(0.5);

  doc.fillColor(brand.text).font('Helvetica-Bold').fontSize(22).text(orgName || 'The Open CRM', 50, top + 22);
  doc.fillColor(brand.textMuted).font('Helvetica').fontSize(9).text('Sales Quote', 50, doc.y + 2);

  doc.font('Helvetica-Bold').fontSize(11).fillColor(brand.text)
    .text(`Quote #${quote.id}`, doc.page.width - 200, top + 22, { width: 150, align: 'right' });
  doc.font('Helvetica').fontSize(9).fillColor(brand.textMuted)
    .text(`Status: ${quote.status || 'draft'}`, doc.page.width - 200, doc.y + 2, { width: 150, align: 'right' })
    .text(`Issued: ${fmtDate(new Date())}`, doc.page.width - 200, doc.y + 1, { width: 150, align: 'right' });

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
  doc.fillColor(brand.primaryDark).font('Helvetica-Bold').fontSize(14).text(quote.title || 'Sales Quote');
  if (quote.deal_title) {
    doc.fillColor(brand.textMuted).font('Helvetica').fontSize(9).text(`Reference: ${quote.deal_title}`);
  }
  doc.moveDown(0.7);
}

function lineItemsTable(doc, { quote, items, brand }) {
  const currency = quote.currency || 'USD';
  const startX = 50;
  const usableWidth = doc.page.width - 100;
  const cols = [
    { key: 'name',     label: 'Item',      width: usableWidth * 0.44, align: 'left' },
    { key: 'qty',      label: 'Qty',       width: usableWidth * 0.10, align: 'right' },
    { key: 'unit',     label: 'Unit',      width: usableWidth * 0.16, align: 'right' },
    { key: 'disc',     label: 'Disc %',    width: usableWidth * 0.10, align: 'right' },
    { key: 'total',    label: 'Line Total',width: usableWidth * 0.20, align: 'right' },
  ];

  // header row
  let x = startX;
  doc.fillColor(brand.primaryDark).rect(startX, doc.y, usableWidth, 22).fill();
  doc.fillColor('white').font('Helvetica-Bold').fontSize(9);
  for (const col of cols) {
    doc.text(col.label, x + 6, doc.y + 7, { width: col.width - 12, align: col.align });
    x += col.width;
  }
  doc.y += 22;

  // body rows
  doc.font('Helvetica').fontSize(10).fillColor(brand.text);
  let alt = false;
  for (const li of items || []) {
    const rowHeight = Math.max(20, doc.heightOfString(li.name || '', { width: cols[0].width - 12 }) + 8);
    if (alt) doc.fillColor(brand.rowAlt).rect(startX, doc.y, usableWidth, rowHeight).fill();
    alt = !alt;

    x = startX;
    const top = doc.y + 5;
    doc.fillColor(brand.text);
    doc.text(li.name || '', x + 6, top, { width: cols[0].width - 12, align: cols[0].align });
    x += cols[0].width;
    doc.text(String(li.quantity ?? 1), x + 6, top, { width: cols[1].width - 12, align: cols[1].align });
    x += cols[1].width;
    doc.text(fmtMoney(li.unit_price, currency), x + 6, top, { width: cols[2].width - 12, align: cols[2].align });
    x += cols[2].width;
    doc.text(Number(li.discount_pct) ? `${Number(li.discount_pct)}%` : '—', x + 6, top, { width: cols[3].width - 12, align: cols[3].align });
    x += cols[3].width;
    doc.font('Helvetica-Bold').text(fmtMoney(li.line_total, currency), x + 6, top, { width: cols[4].width - 12, align: cols[4].align });
    doc.font('Helvetica');

    doc.y = top + rowHeight - 5;
    if (doc.y > doc.page.height - 160) { doc.addPage(); }
  }

  doc.fillColor(brand.border).rect(startX, doc.y, usableWidth, 1).fill();
  doc.y += 10;

  // summary block (right-aligned)
  const labelW = usableWidth * 0.66;
  const valW = usableWidth * 0.34;
  const rows = [
    ['Subtotal', fmtMoney(quote.subtotal, currency)],
    ...(Number(quote.discount) ? [['Discount', `− ${fmtMoney(quote.discount, currency)}`]] : []),
    ...(Number(quote.tax) ? [[`Tax${Number(quote.tax_rate) ? ` (${Number(quote.tax_rate)}%)` : ''}`, fmtMoney(quote.tax, currency)]] : []),
  ];
  doc.font('Helvetica').fontSize(10).fillColor(brand.text);
  for (const [label, val] of rows) {
    doc.text(label, startX, doc.y, { width: labelW - 6, align: 'right' });
    doc.text(val, startX + labelW, doc.y - doc.currentLineHeight(), { width: valW - 6, align: 'right' });
    doc.moveDown(0.3);
  }
  doc.moveDown(0.2);
  doc.fillColor(brand.border).rect(startX + labelW * 0.4, doc.y, usableWidth - labelW * 0.4, 1).fill();
  doc.y += 6;
  doc.font('Helvetica-Bold').fontSize(12).fillColor(brand.text)
    .text('Total', startX, doc.y, { width: labelW - 6, align: 'right' });
  doc.fontSize(14).fillColor(brand.primary)
    .text(fmtMoney(quote.total, currency), startX + labelW, doc.y - 15, { width: valW - 6, align: 'right' });
  doc.fillColor(brand.text).fontSize(10);
  doc.moveDown(2);
}

function notesBlock(doc, { quote, brand }) {
  if (!quote.notes) return;
  doc.fillColor(brand.textMuted).font('Helvetica-Bold').fontSize(8).text('NOTES', 50);
  doc.fillColor(brand.text).font('Helvetica').fontSize(9).text(quote.notes, 50, doc.y + 2, { width: doc.page.width - 100 });
  doc.moveDown(1);
}

function footer(doc, { orgName, brand }) {
  const y = doc.page.height - 60;
  doc.fillColor(brand.border).rect(50, y, doc.page.width - 100, 1).fill();
  doc.fillColor(brand.textMuted).font('Helvetica').fontSize(7)
    .text(
      'This quote is generated from data entered by the issuing organization. The software author makes no warranty as to its accuracy or completeness; recipients should independently verify pricing and specifications before acting upon them.',
      50, y + 6,
      { width: doc.page.width - 100, align: 'center' }
    );
  doc.fillColor(brand.textMuted).font('Helvetica').fontSize(8)
    .text(`${orgName || 'The Open CRM'} · Generated by The Open CRM`, 50, y + 30, {
      width: doc.page.width - 100, align: 'center',
    });
}

/**
 * Render a generic sales-quote PDF to the given writable stream.
 * `quote` includes header fields + line_items[].
 */
function renderSalesQuotePdf({ quote, customer, orgName }, stream) {
  const doc = new PDFDocument({ size: 'LETTER', margin: 50, bufferPages: true });
  doc.pipe(stream);

  header(doc, { quote, orgName, brand: BRAND });
  customerBlock(doc, { quote, customer, brand: BRAND });
  titleBlock(doc, { quote, brand: BRAND });
  lineItemsTable(doc, { quote, items: quote.line_items || [], brand: BRAND });
  notesBlock(doc, { quote, brand: BRAND });

  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    footer(doc, { orgName, brand: BRAND });
  }

  doc.end();
}

module.exports = { renderSalesQuotePdf };
