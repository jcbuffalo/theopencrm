// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Intent-driven "what should I do next" hints — Exhibit A §4.1d.
// Keyed by stage, with optional dependent conditions on deal/vendor-quote state.
// Returns the suggested action label + an optional CTA path or click handler hint.

const ZANG_STEPS = {
  TRIAGE:           { label: 'Send vendor RFQ',         hint: 'Open the deal → Vendor Quotes → + Add vendor RFQ' },
  VENDOR_QUOTING:   { label: 'Follow up with vendors',  hint: 'Re-send RFQ to vendors who haven\'t responded' },
  CUSTOMER_QUOTING: { label: 'Generate branded quote',  hint: 'Open the deal → Quotes → Download PDF' },
  FOLLOW_UP:        { label: 'Follow up with customer', hint: 'Schedule a call or send the follow-up email' },
  NO_FOLLOW_UP:     { label: 'Document why',            hint: 'Add a note explaining why this is no follow-up' },
  COLD:             { label: 'Schedule re-engagement',  hint: 'Move to FOLLOW_UP if you reach the customer' },
  LOST:             { label: 'Capture lost reason',     hint: 'Set a lost_reason for win/loss analysis' },
  NOT_PROCESSED:    { label: 'Process the order',       hint: 'Generate vendor PO and send' },
  ORDACK:           { label: 'Chase vendor ack',        hint: 'Vendor needs to acknowledge the PO' },
  VAP:              { label: 'Chase vendor drawings',   hint: 'Vendor owes approval drawings' },
  CAP:              { label: 'Chase customer approval', hint: 'Customer needs to approve drawings' },
  RELACK:           { label: 'Chase release ack',       hint: 'Vendor needs to confirm release' },
  MONITOR:          { label: 'Status update',           hint: 'Update the customer; log a note' },
  COORDINATE:       { label: 'Confirm ship-to / POC',   hint: 'Verify ship-to address and point of contact' },
  WHSE:             { label: 'Schedule outbound',       hint: 'Coordinate carrier and POC' },
  TBI:              { label: 'Trigger invoice',         hint: 'Move to INVOICED to fire the invoice automation' },
  COMM_WATCH:       { label: 'Watch commission',        hint: 'Track commission receipt' },
  INVOICED:         { label: 'Send customer survey',    hint: 'Survey is auto-queued; check Admin → Automation' },
  CLOSED_PAID:      { label: 'Close out documents',     hint: 'Collect closeout docs from vendor → Documents' },
  CLOSED:           { label: 'Move to post-shipment',   hint: 'No billable work; flag for warranty / service' },
  CANCELLED:        { label: 'Document cancel reason',  hint: 'Add a note for retro analysis' },
  SERVICE:          { label: 'Track service contract',  hint: 'Open Service Contracts to manage renewals' },
  CLOSEOUTS:        { label: 'Send closeout pack',      hint: 'Email the customer the BOLs / packing list / docs' },
  CUSTOMER_EXPERIENCE: { label: 'Send appreciation',    hint: 'Mark for the customer-appreciation queue' },
  WARRANTY:         { label: 'Confirm warranty terms',  hint: 'Document the warranty start and end dates' },
  MARKETING:        { label: 'Add to mailing list',     hint: 'Tag for marketing / case study' },
  END_USER:         { label: 'Track end-user info',     hint: 'Capture the actual end-user company / contact' },
};

// Generic-profile stage IDs are lowercase to match backend VALID_STAGES
// (backend/utils/dealStages.js) and what's stored in deals.stage for
// non-Zang orgs. See stages.js for the same reasoning.
const GENERIC_STEPS = {
  lead:        { label: 'Qualify the lead',          hint: 'Schedule a discovery call' },
  qualified:   { label: 'Send proposal',             hint: 'Generate a quote and send it' },
  proposal:    { label: 'Follow up on proposal',     hint: 'Schedule a follow-up call' },
  negotiation: { label: 'Close the deal',            hint: 'Address blockers; send agreement' },
  closed_won:  { label: 'Onboard the customer',      hint: 'Move to onboarding workflow' },
  closed_lost: { label: 'Capture lost reason',       hint: 'Document why for future analysis' },
};

// jcp stage IDs are uppercase (CLOSED_WON/CLOSED_LOST terminal IDs kept for
// reports/funnel parity — see stages.js), so they never matched the lowercase
// GENERIC_STEPS keys and jcp deals showed no next-step hint at all.
const JCP_STEPS = {
  LEAD:        { label: 'Open the conversation',   hint: 'Reach out and book a first chat' },
  INTRO:       { label: 'Scope the project',       hint: 'Dig into fit + what they actually need' },
  SCOPING:     { label: 'Send the pitch',          hint: 'Write up scope + terms and send it' },
  PITCH:       { label: 'Follow up on the pitch',  hint: 'Chase a decision; answer objections' },
  ENGAGED:     { label: 'Kick off the work',       hint: 'Confirm start; get whatever you need to begin' },
  CLOSED_WON:  { label: 'Deliver / go live',       hint: 'Land the project and capture the win' },
  CLOSED_LOST: { label: 'Capture why',             hint: 'Note why it parked for future reference' },
};

export function getNextStep(deal, profile = 'generic') {
  const map = profile === 'zang' ? ZANG_STEPS
    : profile === 'jcp' ? JCP_STEPS
    : GENERIC_STEPS;
  return map[deal?.stage] || null;
}
