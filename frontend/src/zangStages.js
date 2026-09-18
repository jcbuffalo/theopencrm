// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Zang Flow stages from contract Exhibit A — page 16-17
// Each stage belongs to one phase: pre_sale, post_sale, post_ship

export const PRE_SALE_STAGES = [
  { id: 'TRIAGE',           label: 'Triage',           desc: 'Qualifying the opportunity' },
  { id: 'VENDOR_QUOTING',   label: 'Vendor Quoting',   desc: 'Waiting for vendor quote' },
  { id: 'CUSTOMER_QUOTING', label: 'Customer Quoting', desc: 'Building branded quote' },
  { id: 'FOLLOW_UP',        label: 'Follow Up',        desc: 'Awaiting customer PO' },
  { id: 'NO_FOLLOW_UP',     label: 'No Follow-Up',     desc: 'Outside follow-up criteria' },
  { id: 'NO_QUOTE',         label: 'No Quote',         desc: 'Outside Zang scope' },
  { id: 'COLD',             label: 'Cold',             desc: 'Customer went dark' },
  { id: 'LOST',             label: 'Lost',             desc: 'Awarded elsewhere' },
];

export const POST_SALE_STAGES = [
  { id: 'NOT_PROCESSED',  label: 'Not Processed',  desc: 'PO received, not yet processed' },
  { id: 'PROCESSED',      label: 'Processed',      desc: 'No vendor PO needed' },
  { id: 'ORDACK',         label: 'Order Ack',      desc: 'Awaiting vendor acknowledgement' },
  { id: 'VAP',            label: 'Vendor Approval', desc: 'Waiting on vendor drawings' },
  { id: 'CAP',            label: 'Customer Approval', desc: 'Waiting on customer approval' },
  { id: 'RELACK',         label: 'Release Ack',    desc: 'Vendor to ack release' },
  { id: 'MONITOR',        label: 'Monitor',        desc: 'Watching order status' },
  { id: 'COORDINATE',     label: 'Coordinate',     desc: 'Ship within 30 days' },
  { id: 'WHSE',           label: 'Warehouse',      desc: 'In warehouse' },
  { id: 'TBI',            label: 'To Be Invoiced', desc: 'Awaiting invoice trigger' },
  { id: 'COMM_WATCH',     label: 'Commission Watch', desc: 'Awaiting commission' },
  { id: 'INVOICED',       label: 'Invoiced',       desc: 'Customer billed' },
  { id: 'CLOSED_PAID',    label: 'Closed (Paid)',  desc: 'Customer has paid' },
  { id: 'CLOSED',         label: 'Closed',         desc: 'No billable, completed' },
  { id: 'CANCELLED',      label: 'Cancelled',      desc: 'Order was cancelled' },
];

export const POST_SHIP_STAGES = [
  { id: 'SERVICE',             label: 'Service',             desc: 'Service contract' },
  { id: 'CLOSEOUTS',           label: 'Closeouts',           desc: 'Vendor closeout docs' },
  { id: 'CUSTOMER_EXPERIENCE', label: 'Customer Experience', desc: 'Surveys, gifts' },
  { id: 'WARRANTY',            label: 'Warranty',            desc: 'Warranty transfers' },
  { id: 'MARKETING',           label: 'Marketing',           desc: 'Mailing, photos' },
  { id: 'END_USER',            label: 'End User',            desc: 'Spare parts, services' },
];

export const PHASES = [
  { id: 'pre_sale',  label: 'Pre-Sale',     stages: PRE_SALE_STAGES },
  { id: 'post_sale', label: 'Post-Sale',    stages: POST_SALE_STAGES },
  { id: 'post_ship', label: 'Post-Shipment', stages: POST_SHIP_STAGES },
];

// Canonical total stage count — exported so marketing copy (Landing.js) and
// public docs reference one source. If you add/remove a stage above, this
// updates automatically and the Landing page won't drift.
export const TOTAL_STAGE_COUNT =
  PRE_SALE_STAGES.length + POST_SALE_STAGES.length + POST_SHIP_STAGES.length;

const COLORS = {
  TRIAGE:           { bg: 'bg-slate-50',  header: 'bg-slate-100',  border: 'border-slate-200'  },
  VENDOR_QUOTING:   { bg: 'bg-blue-50',   header: 'bg-blue-100',   border: 'border-blue-200'   },
  CUSTOMER_QUOTING: { bg: 'bg-cyan-50',   header: 'bg-cyan-100',   border: 'border-cyan-200'   },
  FOLLOW_UP:        { bg: 'bg-yellow-50', header: 'bg-yellow-100', border: 'border-yellow-200' },
  NO_FOLLOW_UP:     { bg: 'bg-stone-50',  header: 'bg-stone-100',  border: 'border-stone-200'  },
  NO_QUOTE:         { bg: 'bg-stone-50',  header: 'bg-stone-100',  border: 'border-stone-200'  },
  COLD:             { bg: 'bg-stone-50',  header: 'bg-stone-100',  border: 'border-stone-200'  },
  LOST:             { bg: 'bg-red-50',    header: 'bg-red-100',    border: 'border-red-200'    },
  CANCELLED:        { bg: 'bg-red-50',    header: 'bg-red-100',    border: 'border-red-200'    },
  NOT_PROCESSED:    { bg: 'bg-orange-50', header: 'bg-orange-100', border: 'border-orange-200' },
  PROCESSED:        { bg: 'bg-orange-50', header: 'bg-orange-100', border: 'border-orange-200' },
  ORDACK:           { bg: 'bg-yellow-50', header: 'bg-yellow-100', border: 'border-yellow-200' },
  VAP:              { bg: 'bg-yellow-50', header: 'bg-yellow-100', border: 'border-yellow-200' },
  CAP:              { bg: 'bg-yellow-50', header: 'bg-yellow-100', border: 'border-yellow-200' },
  RELACK:           { bg: 'bg-yellow-50', header: 'bg-yellow-100', border: 'border-yellow-200' },
  MONITOR:          { bg: 'bg-blue-50',   header: 'bg-blue-100',   border: 'border-blue-200'   },
  COORDINATE:       { bg: 'bg-blue-50',   header: 'bg-blue-100',   border: 'border-blue-200'   },
  WHSE:             { bg: 'bg-purple-50', header: 'bg-purple-100', border: 'border-purple-200' },
  TBI:              { bg: 'bg-emerald-50',header: 'bg-emerald-100',border: 'border-emerald-200'},
  COMM_WATCH:       { bg: 'bg-emerald-50',header: 'bg-emerald-100',border: 'border-emerald-200'},
  INVOICED:         { bg: 'bg-green-50',  header: 'bg-green-100',  border: 'border-green-200'  },
  CLOSED_PAID:      { bg: 'bg-green-50',  header: 'bg-green-100',  border: 'border-green-200'  },
  CLOSED:           { bg: 'bg-green-50',  header: 'bg-green-100',  border: 'border-green-200'  },
};

export function stageColors(id) {
  return COLORS[id] || { bg: 'bg-gray-50', header: 'bg-gray-100', border: 'border-gray-200' };
}

export const STAGE_LABEL = {};
[...PRE_SALE_STAGES, ...POST_SALE_STAGES, ...POST_SHIP_STAGES].forEach(s => { STAGE_LABEL[s.id] = s.label; });

export function urgencyColor(u) {
  if (u === 'red') return 'bg-red-100 text-red-700 border-red-300';
  if (u === 'yellow') return 'bg-yellow-100 text-yellow-800 border-yellow-300';
  return 'bg-green-100 text-green-700 border-green-300';
}
