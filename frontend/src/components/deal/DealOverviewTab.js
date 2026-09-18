// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARNING.

// Overview tab: "what does this deal look like right now?" — key fields (with
// the full edit form), an at-a-glance strip for the sub-workflows, and the
// collapsed deal-state sections (line items, order details, end user,
// buy-back, comments). Only Details is open by default.

import React from 'react';
import { downloadBlob } from '../../api';
import CommentThread from '../CommentThread';
import CustomFieldsSection from '../CustomFieldsSection';
import { Button, Skeleton } from '../ui';
import DealEditForm from './DealEditForm';
import DealLineItemsPanel from './DealLineItemsPanel';
import { BuyBackPanel, EndUserPanel } from './dealStatePanels';
import { FactList, fmtDate, fmtMoney, LinkButton, Section } from './shared';
import { useDealSummary } from './useDealData';
import { IssuesPanel } from './workflowPanels';

// -- At-a-glance cards: count + most-urgent / most-recent row per
// sub-workflow. Tapping a card jumps to the matching Workflow section.
function OverviewSummary({ dealId, showAdvanced, flag, onJump }) {
  const { data, loading } = useDealSummary(dealId, { advanced: showAdvanced, flag });

  if (loading) return <Skeleton lines={2} barClassName="h-14" className="grid grid-cols-2 gap-2 space-y-0" />;

  const Card = ({ id, label, count, tone, line, dim }) => (
    <button
      type="button"
      onClick={() => onJump?.(id)}
      className={`rounded border px-3 py-2 text-left transition hover:shadow-card focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-blue ${tone || 'border-gray-200 bg-white'}`}
    >
      <div className="flex items-baseline justify-between">
        <span className="text-xs uppercase tracking-wider text-gray-500">{label}</span>
        <span className={`text-lg font-semibold ${dim ? 'text-gray-400' : 'text-gray-900'}`}>{count}</span>
      </div>
      <div className="mt-0.5 truncate text-xs text-gray-600">{line || '—'}</div>
    </button>
  );

  const issueTone = data.issues.red > 0 || data.issues.blocking > 0
    ? 'border-danger-300 bg-danger-50'
    : data.issues.open > 0 ? 'border-warning-300 bg-warning-50' : 'border-gray-200 bg-white';
  const issueLine = data.issues.blocking > 0
    ? `${data.issues.blocking} blocking · ${data.issues.open} open`
    : data.issues.red > 0
      ? `${data.issues.red} red · ${data.issues.open} open`
      : data.issues.open > 0
        ? `${data.issues.open} open` + (data.issues.latest ? ` · ${data.issues.latest.title}` : '')
        : 'All clear';
  const submittalLine = data.submittals.pending > 0
    ? `${data.submittals.pending} pending`
    : data.submittals.latest ? `latest ${data.submittals.latest.status?.replace('_', ' ')}` : 'No submittals';
  const coLine = data.changeOrders.pending > 0
    ? `${data.changeOrders.pending} pending`
    : data.changeOrders.latest ? `CO #${data.changeOrders.latest.number} ${data.changeOrders.latest.status}` : 'None';
  const vqLine = data.vendorQuotes.selected
    ? `Selected: ${data.vendorQuotes.selected.vendor_name}`
    : data.vendorQuotes.received > 0
      ? `${data.vendorQuotes.received} received`
      : data.vendorQuotes.count > 0 ? `${data.vendorQuotes.count} pending` : 'No RFQs sent';
  const quoteLine = data.quotes.latest
    ? `Latest: ${data.quotes.latest.status} · ${fmtMoney(data.quotes.latest.total_amount)}`
    : 'No customer quotes';
  const docLine = data.documents.latest
    ? `${data.documents.latest.doc_type || 'doc'}: ${data.documents.latest.filename}`
    : 'No documents';

  return (
    <div className="grid grid-cols-2 gap-2">
      <Card id="issues" label="Issues" count={data.issues.open} line={issueLine} tone={issueTone} dim={data.issues.open === 0} />
      {flag('quotes_enabled') && (
        <Card id="quotes" label="Quotes" count={data.quotes.count} line={quoteLine} dim={data.quotes.count === 0} />
      )}
      {showAdvanced && flag('vendor_quotes_enabled') && (
        <Card id="vendor-quotes" label="Vendor RFQs" count={data.vendorQuotes.count} line={vqLine}
          tone={data.vendorQuotes.selected ? 'border-success-300 bg-success-50' : undefined}
          dim={data.vendorQuotes.count === 0} />
      )}
      {showAdvanced && flag('submittals_enabled') && (
        <Card id="submittals" label="Submittals" count={data.submittals.count} line={submittalLine}
          tone={data.submittals.pending > 0 ? 'border-warning-300 bg-warning-50' : undefined}
          dim={data.submittals.count === 0} />
      )}
      {showAdvanced && flag('change_orders_enabled') && (
        <Card id="change-orders" label="Change orders" count={data.changeOrders.count} line={coLine}
          tone={data.changeOrders.pending > 0 ? 'border-warning-300 bg-warning-50' : undefined}
          dim={data.changeOrders.count === 0} />
      )}
      {flag('documents_enabled') && (
        <Card id="documents" label="Documents" count={data.documents.count} line={docLine} dim={data.documents.count === 0} />
      )}
    </div>
  );
}

export default function DealOverviewTab({
  deal,
  cfg,
  flag,
  companies,
  customers,
  vendors,
  members,
  editing,
  setEditing,
  lineItemCount,
  setLineItemCount,
  refreshDeal,
  onSaved,
  onDelete,
  onChanged,
  onJump,
  workflowVisible,
  openSignals,
}) {
  const dealId = deal.id;
  const showOrderDetails = cfg.showOrderDetails && deal.phase !== 'pre_sale';
  const showBuyBack = cfg.showAdvancedPanels
    && (deal.phase === 'post_ship' || ['CLOSED_PAID', 'CLOSED', 'INVOICED'].includes(deal.stage));

  const owner = (() => {
    if (!deal.owner_user_id) return '—';
    const m = members.find((x) => Number(x.id) === Number(deal.owner_user_id));
    return m ? (m.name || m.email) : `User #${deal.owner_user_id}`;
  })();

  const poPdf = () => {
    const filename = `po-${(deal.po_number || `deal-${deal.id}`).toString().replace(/[^a-zA-Z0-9._-]/g, '_')}.pdf`;
    downloadBlob(`/deals/${dealId}/po-pdf`, filename).catch(() => alert('Failed to generate PO PDF'));
  };

  return (
    <div>
      <Section
        title="Details"
        defaultOpen
        action={!editing && <LinkButton onClick={() => setEditing(true)}>Edit</LinkButton>}
      >
        {editing ? (
          <DealEditForm
            deal={deal}
            cfg={cfg}
            customers={customers}
            vendors={vendors}
            members={members}
            lineItemCount={lineItemCount}
            showOrderDetails={showOrderDetails}
            onSaved={onSaved}
            onCancel={() => setEditing(false)}
            onDelete={onDelete}
          />
        ) : (
          <div className="space-y-3">
            <FactList items={[
              ['Customer', deal.customer_id ? customers.find((c) => c.id === deal.customer_id)?.name || '—' : '—'],
              ['Vendor', deal.vendor_id ? vendors.find((c) => c.id === deal.vendor_id)?.name || '—' : '—'],
              ['Vertical', deal.vertical || '—'],
              ['Owner', owner],
              ['Amount', <>{fmtMoney(deal.amount)}{lineItemCount > 0 && <span className="ml-1 text-xs text-gray-400">(from line items)</span>}</>, 'font-medium'],
              ['Expected close', fmtDate(deal.expected_close_date)],
              cfg.showAdvancedPanels && ['Phase', deal.phase ? String(deal.phase).replace(/_/g, ' ') : '—'],
            ]} />
            {deal.notes && <p className="whitespace-pre-wrap text-sm text-gray-700">{deal.notes}</p>}
            <CustomFieldsSection entity="deals" values={deal.custom_fields || {}} onChange={() => {}} readOnly />
          </div>
        )}
      </Section>

      <div className="border-b border-gray-100 py-3">
        <div className="mb-2 text-xs uppercase tracking-wider text-gray-500">At a glance</div>
        <OverviewSummary dealId={dealId} showAdvanced={cfg.showAdvancedPanels} flag={flag} onJump={onJump} />
      </div>

      {/* Line items (migration 145) — products/quantities that sum to the
          deal amount. Lives on Overview because it IS the amount. */}
      <Section title="Line items" summary="Products and quantities that make up the amount" count={lineItemCount || undefined}>
        <DealLineItemsPanel dealId={dealId} onCountChange={setLineItemCount} onRollup={refreshDeal} />
      </Section>

      {showOrderDetails && (
        <Section
          title="Order details"
          summary={deal.po_number ? `PO ${deal.po_number}` : 'PO #, ship-to, POC and release status'}
          action={<Button size="sm" variant="ghost" icon="download" onClick={poPdf}>PO PDF</Button>}
        >
          <FactList items={[
            ['PO #', deal.po_number || '—'],
            ['Ship to', deal.ship_to || '—', 'whitespace-pre-wrap'],
            ['POC', [deal.poc_name, deal.poc_email, deal.poc_phone].filter(Boolean).join(' · ') || '—'],
            ['Target ship', fmtDate(deal.target_ship_date)],
            ['Release', (deal.release_status || 'released').toUpperCase(),
              deal.release_status === 'held' ? 'font-medium text-danger-600' : 'font-medium text-success-700'],
            deal.hold_reason && ['Hold reason', deal.hold_reason],
          ]} />
          <p className="mt-2 text-xs text-gray-500">Edit these fields under Details → Edit.</p>
        </Section>
      )}

      {/* End User and Buy-back stay here because they are deal-state, not
          workflow records. */}
      {cfg.showAdvancedPanels && (
        <Section title="End user" summary="Who actually uses the product">
          <EndUserPanel deal={deal} companies={companies} contacts={[]} onChange={onChanged} />
        </Section>
      )}

      {showBuyBack && (
        <Section title="Buy-back" summary={`Status: ${deal.buy_back_status || 'none'}`}>
          <BuyBackPanel deal={deal} onChange={onChanged} />
        </Section>
      )}

      {/* When the Workflow tab has nothing else to show, Issues live here so
          a lightweight org never loses them. */}
      {!workflowVisible && (
        <Section id="deal-section-issues" title="Issues" summary="Blockers and follow-ups on this deal" openSignal={openSignals?.issues || 0}>
          <IssuesPanel dealId={dealId} />
        </Section>
      )}

      {/* Team comments with @mentions (migration 146) — the internal
          conversation about the deal, distinct from customer-facing comms. */}
      <Section title="Comments" summary="Internal notes with @mentions for teammates">
        <CommentThread entityType="deal" entityId={dealId} />
      </Section>
    </div>
  );
}
