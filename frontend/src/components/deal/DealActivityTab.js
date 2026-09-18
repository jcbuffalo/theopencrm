// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Activity tab: "what's the conversation history?" — the merged timeline,
// tasks, sent emails, and the Drive / Gmail / Outlook / Calendar intel
// panels. Every section but the timeline is collapsed (and lazily mounted)
// with a one-line summary; intel panels also self-hide when their module
// is off at the API (onHidden) and are skipped outright when the org flag
// says so.

import React from 'react';
import CalendarPanel from '../CalendarPanel';
import GmailIntelPanel from '../GmailIntelPanel';
import IntelSummaryPanel from '../IntelSummaryPanel';
import OutlookIntelPanel from '../OutlookIntelPanel';
import { Button } from '../ui';
import { CommunicationTimeline, DealTasksList, EmailsTimeline } from './commsPanels';
import { PhoneLink, Section } from './shared';

export default function DealActivityTab({
  deal,
  flag,
  primaryContact,
  commsRefreshKey,
  emailsRefreshKey,
  tasksRefreshKey,
  hiddenIntel,
  hideIntel,
  onEmail,
  onSms,
}) {
  const dealId = deal.id;
  const email = primaryContact?.email || deal.poc_email || '';
  const phone = primaryContact?.phone || deal.poc_phone || '';

  return (
    <div>
      {/* Contact actions. The composer pre-fills the primary contact (or the
          deal POC); both modals let the user enter an address manually. */}
      <div className="flex flex-wrap items-center gap-2 border-b border-gray-100 py-3">
        <Button size="sm" variant="secondary" icon="mail" onClick={onEmail}>Email</Button>
        <Button size="sm" variant="secondary" icon="chat" onClick={onSms}>Text</Button>
        <span className="min-w-0 flex-1 truncate text-xs text-gray-500">
          {email ? email : 'No contact email on file'}
          {phone && <> · <PhoneLink number={phone} /></>}
        </span>
      </div>

      <Section title="Timeline" defaultOpen summary="Calls, emails, texts and meetings logged on this deal">
        <CommunicationTimeline dealId={dealId} refreshKey={commsRefreshKey} />
      </Section>

      <Section title="Tasks" summary="Tasks linked to this deal">
        <DealTasksList dealId={dealId} refreshKey={tasksRefreshKey} />
      </Section>

      <Section title="Sent emails" summary="Emails sent from the CRM, with open tracking">
        <EmailsTimeline dealId={dealId} refreshKey={emailsRefreshKey} />
      </Section>

      {/* Drive Intel — auto-summary of the deal's Drive folder
          (Differentiation Bet #4, DRIVE_INTEL_SPEC.md). */}
      {flag('drive_intel_enabled') && !hiddenIntel.drive && (
        <Section title="Drive folder intel" summary="AI summary of the linked Google Drive folder">
          <IntelSummaryPanel dealId={dealId} onHidden={() => hideIntel('drive')} />
        </Section>
      )}

      {flag('gmail_intel_enabled') && !hiddenIntel.gmail && (
        <Section title="Gmail thread intel" summary="AI summary of the linked Gmail thread">
          <GmailIntelPanel dealId={dealId} onHidden={() => hideIntel('gmail')} />
        </Section>
      )}

      {(flag('outlook_mail_enabled') || flag('outlook_calendar_enabled')) && !hiddenIntel.outlook && (
        <Section title="Outlook activity" summary="Mail and meetings matched from Microsoft 365">
          <OutlookIntelPanel dealId={dealId} onHidden={() => hideIntel('outlook')} />
        </Section>
      )}

      {flag('calendar_enabled') && !hiddenIntel.calendar && (
        <Section title="Meetings" summary="Google Calendar events for this deal">
          <CalendarPanel
            dealId={dealId}
            defaultAttendee={primaryContact?.email || deal.poc_email || ''}
            onHidden={() => hideIntel('calendar')}
          />
        </Section>
      )}
    </div>
  );
}
