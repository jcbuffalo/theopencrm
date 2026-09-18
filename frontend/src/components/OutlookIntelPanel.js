// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// OutlookIntelPanel — per-deal Outlook / Microsoft 365 mail + calendar lanes.
//
// Mounted inside the DealPanel Comms tab alongside the Gmail/Drive/Calendar
// panels. Read-only surface over the deal-matched rows msgraphSyncWorker
// lands (outlook_messages / outlook_calendar_events, migration 140):
//
//   - Hidden entirely (renders null) when neither Outlook flag is on for the
//     org — backend 403 FEATURE_DISABLED on the probe. Same self-hide
//     pattern as CalendarPanel.
//   - Flags on but no M365 connection → "connect Microsoft 365" hint.
//   - Connected → the deal's Outlook messages (subject, preview, sender,
//     date, open-in-Outlook link) and calendar events. Either lane can be
//     empty; each lane only appears when its own flag is on (the backend
//     omits the other).
//
// Props
//   dealId : number — required.

import React, { useEffect, useState } from 'react';
import { dealOutlookIntel } from '../api';

function fmtDate(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString();
}

function fmtDateTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

export default function OutlookIntelPanel({ dealId, onHidden }) {
  const [hidden, setHidden] = useState(false); // feature off → render nothing
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    dealOutlookIntel.get(dealId)
      .then((d) => { if (active) setData(d); })
      .catch(() => { if (active) setHidden(true); }) // 403 flag-off / any error → hide
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [dealId]);

  useEffect(() => { if (hidden) onHidden?.(); }, [hidden, onHidden]);

  if (hidden) return null;
  if (loading) return <div className="text-xs text-gray-400 py-2">Loading Outlook activity…</div>;
  if (!data) return null;

  if (!data.connected) {
    return (
      <div className="text-xs text-gray-500 bg-gray-50 border border-gray-100 rounded px-3 py-3">
        Microsoft 365 isn't connected yet. An admin can connect it under
        {' '}<span className="font-medium">Settings → Integrations</span> to see
        Outlook email and meetings matched to this deal.
      </div>
    );
  }

  const messages = data.messages || [];
  const events = data.events || [];

  if (messages.length === 0 && events.length === 0) {
    return (
      <div className="text-xs text-gray-500 bg-gray-50 border border-gray-100 rounded px-3 py-3">
        No Outlook activity matched to this deal yet. Mail and meetings are
        matched automatically by participant email on each sync.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {messages.length > 0 && (
        <div>
          <div className="text-[11px] uppercase tracking-wider font-semibold text-gray-400 mb-2">
            Email ({messages.length})
          </div>
          <div className="space-y-2">
            {messages.map((m) => (
              <div key={m.id} className="border border-gray-200 rounded px-3 py-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="text-sm font-medium text-gray-900 break-words min-w-0">
                    {m.subject || '(no subject)'}
                  </div>
                  {m.web_link && (
                    <a
                      href={m.web_link}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[11px] text-brand-blue hover:underline flex-shrink-0"
                    >
                      Open in Outlook
                    </a>
                  )}
                </div>
                {m.body_preview && (
                  <div className="text-xs text-gray-600 mt-0.5 line-clamp-2">{m.body_preview}</div>
                )}
                <div className="text-[11px] text-gray-400 mt-1">
                  {m.from_addr}{m.received_at && <> · {fmtDate(m.received_at)}</>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {events.length > 0 && (
        <div>
          <div className="text-[11px] uppercase tracking-wider font-semibold text-gray-400 mb-2">
            Meetings ({events.length})
          </div>
          <div className="space-y-2">
            {events.map((ev) => (
              <div key={ev.id} className="border border-gray-200 rounded px-3 py-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="text-sm font-medium text-gray-900 break-words min-w-0">
                    {ev.title || '(untitled meeting)'}
                    {ev.status === 'cancelled' && (
                      <span className="ml-2 text-[10px] px-1.5 py-0.5 bg-danger-50 text-danger-600 border border-danger-200 rounded font-semibold">
                        cancelled
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {ev.meeting_link && (
                      <a
                        href={ev.meeting_link}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[11px] text-brand-blue hover:underline"
                      >
                        Join
                      </a>
                    )}
                    {ev.web_link && (
                      <a
                        href={ev.web_link}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[11px] text-brand-blue hover:underline"
                      >
                        Open
                      </a>
                    )}
                  </div>
                </div>
                <div className="text-[11px] text-gray-400 mt-1">
                  {fmtDateTime(ev.start_at)}
                  {ev.organizer_email && <> · {ev.organizer_email}</>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
