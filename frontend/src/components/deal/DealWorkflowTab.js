// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Workflow tab: every sub-record list, in priority order. Profile-aware —
// advanced-panel profiles (zang) get the RFQ → vendor quote → customer quote
// → submittal → change order → delivery → documents chain; lighter profiles
// see only the modules their org has on. Issues are first because they're
// the most likely to be urgent. Each section carries an id so Overview cards
// can jump to it.

import React from 'react';
import DocumentList from '../DocumentList';
import { Section } from './shared';
import { VendorQuotesPanel } from './vendorQuotes';
import {
  ChangeOrdersPanel, DeliveryChecklist, IssuesPanel, QuotesQuickList, SubmittalsPanel,
} from './workflowPanels';

// The tab only earns a slot when it would show more than Issues. Generic
// orgs with quotes + documents switched off keep Issues on the Overview tab.
export function isWorkflowVisible(cfg, flag) {
  return !!cfg.showAdvancedPanels || flag('quotes_enabled') || flag('documents_enabled');
}

export default function DealWorkflowTab({ deal, cfg, flag, vendors, onChanged, openSignals = {} }) {
  const dealId = deal.id;
  const advanced = cfg.showAdvancedPanels;
  const postSale = deal.phase === 'post_sale' || deal.phase === 'post_ship';
  const sig = (id) => openSignals[id] || 0;

  return (
    <div>
      <Section id="deal-section-issues" title="Issues" defaultOpen summary="Blockers and follow-ups on this deal" openSignal={sig('issues')}>
        <IssuesPanel dealId={dealId} />
      </Section>

      {flag('quotes_enabled') && (
        <Section id="deal-section-quotes" title="Customer quotes" summary="Quotes sent to the customer" openSignal={sig('quotes')}>
          <QuotesQuickList dealId={dealId} />
        </Section>
      )}

      {advanced && flag('vendor_quotes_enabled') && (
        <Section id="deal-section-vendor-quotes" title="Vendor RFQs" summary="Requests for quote sent to vendors" openSignal={sig('vendor-quotes')}>
          <VendorQuotesPanel dealId={dealId} vendors={vendors} onChange={onChanged} />
        </Section>
      )}

      {advanced && postSale && flag('submittals_enabled') && (
        <Section id="deal-section-submittals" title="Submittals" summary="Drawings, specs and samples awaiting approval" openSignal={sig('submittals')}>
          <SubmittalsPanel dealId={dealId} />
        </Section>
      )}

      {advanced && postSale && flag('change_orders_enabled') && (
        <Section id="deal-section-change-orders" title="Change orders" summary="Scope and amount changes after the PO" openSignal={sig('change-orders')}>
          <ChangeOrdersPanel dealId={dealId} />
        </Section>
      )}

      {cfg.showOrderDetails && deal.phase !== 'pre_sale' && (
        <Section id="deal-section-delivery" title="Delivery checklist" summary="Shipping, carrier and closeout steps" openSignal={sig('delivery')}>
          <DeliveryChecklist deal={deal} onSave={onChanged} />
        </Section>
      )}

      {flag('documents_enabled') && (
        <Section id="deal-section-documents" title="Documents" summary="Files attached to this deal" openSignal={sig('documents')}>
          <DocumentList relatedType="deal" relatedId={dealId} />
        </Section>
      )}
    </div>
  );
}
