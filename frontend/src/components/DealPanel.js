// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Deal drawer — the thin composer. Hero (title / company / stage / value /
// next step / CTAs) on top, three tabs below: Overview · Workflow
// (profile-aware) · Activity. Everything under the hero + Overview is lazy
// and collapsed by default. The pieces live in ./deal/*:
//
//   DealHero          hero + inline title + stage picker + CTA row
//   DealOverviewTab   details / edit form / at-a-glance / line items / state
//   DealWorkflowTab   issues · quotes · RFQs · submittals · COs · delivery · docs
//   DealActivityTab   timeline · tasks · sent emails · Drive/Gmail/Outlook/Calendar
//   actionModals      log activity · add task · SMS · AI assist
//   useDealData       the deal-level fetches
//
// Public API is unchanged: <DealPanel dealId companies onClose onChanged />.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api, { downloadBlob } from '../api';
import { useAuth } from '../AuthContext';
import { takeComposeDraft } from '../composePrefill';
import { getStageConfig } from '../stages';
import EmailComposerModal from './EmailComposerModal';
import { Alert, Button, Drawer, Skeleton, Tabs } from './ui';
import DealHero, { HeroSubtitle, InlineTitle } from './deal/DealHero';
import DealOverviewTab from './deal/DealOverviewTab';
import DealWorkflowTab, { isWorkflowVisible } from './deal/DealWorkflowTab';
import DealActivityTab from './deal/DealActivityTab';
import { AddTaskModal, AiAssistPanel, LogActivityModal, SmsModal } from './deal/actionModals';
import {
  flagOn, useDeal, useHiddenIntel, useOrgMembers, usePrimaryContact,
} from './deal/useDealData';

// Split an AI-drafted email into { subject, body }. Drafts frequently open
// with a "Subject: …" line; when they do, it becomes the subject and is
// dropped from the body. Otherwise `fallbackSubject` is used.
export function splitDraft(text, fallbackSubject = '') {
  const raw = String(text || '').replace(/\r\n/g, '\n');
  const m = raw.match(/^\s*subject:\s*(.+)\n+/i);
  if (m) return { subject: m[1].trim(), body: raw.slice(m[0].length).trim() };
  return { subject: fallbackSubject, body: raw.trim() };
}

export default function DealPanel({ dealId, companies, onClose, onChanged, initialAction = null }) {
  const { user, orgFeatures } = useAuth();
  const navigate = useNavigate();
  const flag = useCallback((name) => flagOn(orgFeatures, name), [orgFeatures]);

  const { deal, setDeal, loadError, refreshDeal, patchDeal } = useDeal(dealId, onChanged);
  // Stage config for the DEAL's pipeline (spec 201): a typed deal renders its
  // own type's stages; 'default' (and every pre-156 deal) is unchanged.
  const cfg = getStageConfig(user?.org_profile || 'generic', { dealType: deal?.deal_type || 'default' });
  const members = useOrgMembers();
  const primaryContact = usePrimaryContact(deal?.contact_id);
  const { hiddenIntel, hideIntel } = useHiddenIntel();

  const [tab, setTab] = useState('overview'); // overview | workflow | activity
  const [editing, setEditing] = useState(false);
  // Deal line items (migration 145): while lines exist the server derives
  // deals.amount from them, so the manual Amount input locks with a hint.
  const [lineItemCount, setLineItemCount] = useState(0);
  const [emailOpen, setEmailOpen] = useState(false);
  // Composer prefill from an AI draft ({ subject, body } or null). Cleared
  // when the composer closes so the next plain "Email" opens blank.
  const [emailPrefill, setEmailPrefill] = useState(null);
  const [smsOpen, setSmsOpen] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [taskOpen, setTaskOpen] = useState(false);
  const [aiRequest, setAiRequest] = useState(null);
  // Bump keys re-pull the Activity-tab lists after a send / log / create.
  const [emailsRefreshKey, setEmailsRefreshKey] = useState(0);
  const [commsRefreshKey, setCommsRefreshKey] = useState(0);
  const [tasksRefreshKey, setTasksRefreshKey] = useState(0);
  // Per-section counters that force a collapsed section open (jump links).
  const [openSignals, setOpenSignals] = useState({});

  const customers = useMemo(() => (companies || []).filter((c) => c.type === 'customer' || !c.type), [companies]);
  const vendors = useMemo(() => (companies || []).filter((c) => c.type === 'vendor'), [companies]);
  const workflowVisible = isWorkflowVisible(cfg, flag);

  // Chat-first deep link (?compose=1) → open the composer once the deal is
  // in. A chat `draft_email` chip stashes its drafted text out-of-band
  // (composePrefill.js); take it here so the composer opens prefilled.
  useEffect(() => {
    if (!deal || initialAction !== 'compose-email') return;
    const draft = takeComposeDraft(deal.id);
    if (draft) setEmailPrefill(splitDraft(draft, `Re: ${deal.title || 'our conversation'}`));
    setEmailOpen(true);
  }, [deal, initialAction]);

  // Jump from an Overview summary card to the matching section: switch tab,
  // force the section open, then scroll once it has mounted.
  const jumpTo = (sectionId) => {
    if (workflowVisible) setTab('workflow');
    setOpenSignals((s) => ({ ...s, [sectionId]: (s[sectionId] || 0) + 1 }));
    setTimeout(() => {
      document.getElementById(`deal-section-${sectionId}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 50);
  };

  const remove = async () => {
    if (!window.confirm('Delete this deal? This cannot be undone.')) return;
    await api.delete(`/deals/${dealId}`);
    onChanged?.();
    onClose();
  };

  // "Open in composer" from the AI-drafted follow-up (actionModals.js
  // AiAssistPanel): the draft lands in the composer's Subject/Body fields
  // via EmailComposerModal's initialSubject/initialBody props. A leading
  // "Subject: …" line in the draft becomes the subject; otherwise the deal
  // title does.
  const openDraftInComposer = (text) => {
    setAiRequest(null);
    setEmailPrefill(splitDraft(text, `Re: ${deal?.title || 'our conversation'}`));
    setEmailOpen(true);
  };

  const closeEmail = () => { setEmailOpen(false); setEmailPrefill(null); };

  // Chat-from-record: hand the copilot this deal (pages/Chat.js pre-sends one
  // grounded opening message when the conversation is empty).
  const askCopilot = () => navigate(`/chat?seed=deal&deal_id=${dealId}`);

  const poPdf = () => {
    const filename = `po-${(deal.po_number || `deal-${deal.id}`).toString().replace(/[^a-zA-Z0-9._-]/g, '_')}.pdf`;
    downloadBlob(`/deals/${dealId}/po-pdf`, filename).catch(() => alert('Failed to generate PO PDF'));
  };

  const onePagerPdf = () => {
    const filename = `${(deal.title || `deal-${deal.id}`).toString().replace(/[^a-zA-Z0-9._-]/g, '_')}-one-pager.pdf`;
    downloadBlob(`/deals/${dealId}/one-pager.pdf`, filename).catch(() => alert('Failed to generate one-pager PDF'));
  };

  if (!deal) {
    return (
      <Drawer open onClose={onClose} size="lg" title={loadError ? 'Deal' : 'Loading deal'}>
        {loadError ? (
          <Alert
            tone="danger"
            title="Couldn't load this deal"
            action={<Button size="sm" variant="secondary" onClick={onClose}>Close</Button>}
          >
            {loadError}
          </Alert>
        ) : (
          <div className="space-y-6">
            <Skeleton lines={3} />
            <Skeleton lines={4} barClassName="h-3" />
          </div>
        )}
      </Drawer>
    );
  }

  const showOrderDetails = cfg.showOrderDetails && deal.phase !== 'pre_sale';
  const overflowItems = [
    { label: 'Edit details', icon: 'edit', onClick: () => { setTab('overview'); setEditing(true); } },
    { label: 'Send email', icon: 'mail', onClick: () => setEmailOpen(true) },
    { label: 'Send text', icon: 'chat', onClick: () => setSmsOpen(true) },
    { label: 'One-pager PDF', icon: 'download', onClick: onePagerPdf },
    ...(showOrderDetails ? [{ label: 'Download PO PDF', icon: 'download', onClick: poPdf }] : []),
    { type: 'divider' },
    { label: 'Delete deal', icon: 'trash', danger: true, onClick: remove },
  ];

  const tabs = [
    { id: 'overview', label: 'Overview', panelId: 'deal-tab-overview' },
    ...(workflowVisible ? [{ id: 'workflow', label: 'Workflow', panelId: 'deal-tab-workflow' }] : []),
    { id: 'activity', label: 'Activity', panelId: 'deal-tab-activity' },
  ];
  const activeTab = tabs.some((t) => t.id === tab) ? tab : 'overview';

  return (
    <>
      <Drawer
        open
        onClose={onClose}
        size="lg"
        title={<InlineTitle value={deal.title} onSave={(title) => patchDeal({ title })} />}
        description={(
          <HeroSubtitle
            customerName={deal.customer_id ? customers.find((c) => c.id === deal.customer_id)?.name : null}
            vendorName={cfg.showAdvancedPanels && deal.vendor_id ? vendors.find((c) => c.id === deal.vendor_id)?.name : null}
            contact={primaryContact}
          />
        )}
        bodyClassName="pt-4"
      >
        <DealHero
          deal={deal}
          cfg={cfg}
          members={members}
          lineItemCount={lineItemCount}
          aiEnabled={flag('ai_features_enabled')}
          onStageChange={(stage) => patchDeal({ stage })}
          onNextStepChange={(patch) => patchDeal(patch)}
          onLogActivity={() => setLogOpen(true)}
          onAddTask={() => setTaskOpen(true)}
          onEmail={() => setEmailOpen(true)}
          hasEmailTarget={!!primaryContact?.email}
          onAi={(kind) => setAiRequest((r) => ({ kind, n: (r?.n || 0) + 1 }))}
          onAskCopilot={askCopilot}
          overflowItems={overflowItems}
        />

        {aiRequest && (
          <div className="mt-4">
            <AiAssistPanel deal={deal} request={aiRequest} onDismiss={() => setAiRequest(null)} onOpenComposer={openDraftInComposer} />
          </div>
        )}

        <Tabs
          items={tabs}
          value={activeTab}
          onChange={setTab}
          size="sm"
          aria-label="Deal sections"
          className="sticky top-0 z-10 -mx-6 mt-4 bg-white px-6"
        />

        <div id={`deal-tab-${activeTab}`} role="tabpanel" className="pt-1">
          {activeTab === 'overview' && (
            <DealOverviewTab
              deal={deal}
              cfg={cfg}
              flag={flag}
              companies={companies}
              customers={customers}
              vendors={vendors}
              members={members}
              editing={editing}
              setEditing={setEditing}
              lineItemCount={lineItemCount}
              setLineItemCount={setLineItemCount}
              refreshDeal={refreshDeal}
              onSaved={(next) => { setDeal(next); setEditing(false); onChanged?.(); }}
              onDelete={remove}
              onChanged={onChanged}
              onJump={jumpTo}
              workflowVisible={workflowVisible}
              openSignals={openSignals}
            />
          )}
          {activeTab === 'workflow' && (
            <DealWorkflowTab deal={deal} cfg={cfg} flag={flag} vendors={vendors} onChanged={onChanged} openSignals={openSignals} />
          )}
          {activeTab === 'activity' && (
            <DealActivityTab
              deal={deal}
              flag={flag}
              primaryContact={primaryContact}
              commsRefreshKey={commsRefreshKey}
              emailsRefreshKey={emailsRefreshKey}
              tasksRefreshKey={tasksRefreshKey}
              hiddenIntel={hiddenIntel}
              hideIntel={hideIntel}
              onEmail={() => setEmailOpen(true)}
              onSms={() => setSmsOpen(true)}
            />
          )}
        </div>
      </Drawer>

      <LogActivityModal
        open={logOpen}
        deal={deal}
        contact={primaryContact}
        onClose={() => setLogOpen(false)}
        onLogged={() => setCommsRefreshKey((k) => k + 1)}
      />
      <AddTaskModal
        open={taskOpen}
        deal={deal}
        contact={primaryContact}
        onClose={() => setTaskOpen(false)}
        onCreated={() => setTasksRefreshKey((k) => k + 1)}
      />
      <SmsModal
        open={smsOpen}
        deal={deal}
        contact={primaryContact}
        onClose={() => setSmsOpen(false)}
        onSent={() => setCommsRefreshKey((k) => k + 1)}
      />
      <EmailComposerModal
        open={emailOpen}
        onClose={closeEmail}
        onSent={() => {
          closeEmail();
          setEmailsRefreshKey((k) => k + 1);
        }}
        contact={primaryContact}
        deal={{ id: deal.id, title: deal.title }}
        initialSubject={emailPrefill?.subject}
        initialBody={emailPrefill?.body}
        // Fall back to the deal POC email when there's no linked contact —
        // common for post-sale phases where ship-to POC isn't a CRM contact.
        defaultTo={primaryContact?.email ? undefined : (deal.poc_email || '')}
      />
    </>
  );
}
