// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// CalendarPanel — per-deal meeting list + "Schedule meeting" action.
//
// Mounted inside the DealPanel Comms tab, alongside the Gmail/Drive intel
// panels. Self-contained and self-hiding, mirroring GmailIntelPanel:
//
//   - Hidden entirely (renders null) when calendar_enabled is off for the org
//     (backend 404/403 on the event-list probe) — so the Section that wraps it
//     shows nothing rather than an error.
//   - When Calendar OAuth isn't configured at the platform level (503) or the
//     org hasn't connected a calendar, we render a short "connect in Settings"
//     hint instead of the schedule form.
//   - Otherwise: a chronological list of the deal's meetings (synced + created)
//     and a small "Schedule meeting" form that POSTs to the create endpoint.
//
// Props
//   dealId          : number — required.
//   defaultAttendee : string — optional; pre-fills the attendees field (the
//                     deal's primary contact / POC email).

import React, { useCallback, useEffect, useState } from 'react';
import { dealCalendar } from '../api';

function fmtDateTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString();
}

// datetime-local wants "YYYY-MM-DDTHH:mm" in LOCAL time. Build one an hour from
// now, rounded to the next half hour, as a sensible default start.
function defaultStartLocal() {
  const d = new Date(Date.now() + 60 * 60 * 1000);
  d.setMinutes(d.getMinutes() > 30 ? 60 : 30, 0, 0);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function CalendarPanel({ dealId, defaultAttendee, onHidden }) {
  const [hidden, setHidden] = useState(false);        // feature off → render nothing
  const [loading, setLoading] = useState(true);
  const [notConnected, setNotConnected] = useState(false);
  const [notConfigured, setNotConfigured] = useState(false);
  const [events, setEvents] = useState([]);
  const [error, setError] = useState('');

  // Schedule form
  const [formOpen, setFormOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [startAt, setStartAt] = useState(defaultStartLocal());
  const [durationMin, setDurationMin] = useState(30);
  const [attendees, setAttendees] = useState(defaultAttendee || '');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setError('');
    try {
      const data = await dealCalendar.list(dealId);
      setEvents(data?.events || []);
      setNotConfigured(false);
    } catch (err) {
      const status = err?.response?.status;
      // Feature disabled for the org — hide the whole panel.
      if (status === 404 || status === 403) { setHidden(true); return; }
      if (status === 503) { setNotConfigured(true); return; }
      setError(err?.response?.data?.error || 'Failed to load meetings.');
    } finally {
      setLoading(false);
    }
  }, [dealId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (hidden) onHidden?.(); }, [hidden, onHidden]);

  const handleSchedule = async (e) => {
    e.preventDefault();
    setError('');
    if (!title.trim()) { setError('Give the meeting a title.'); return; }
    const start = new Date(startAt);
    if (Number.isNaN(start.getTime())) { setError('Pick a valid start time.'); return; }
    const end = new Date(start.getTime() + Number(durationMin || 30) * 60 * 1000);
    const attendeeList = attendees
      .split(/[,\s;]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    setSaving(true);
    try {
      await dealCalendar.create(dealId, {
        title: title.trim(),
        start_at: start.toISOString(),
        end_at: end.toISOString(),
        attendees: attendeeList,
      });
      setFormOpen(false);
      setTitle('');
      await load();
    } catch (err) {
      const status = err?.response?.status;
      if (status === 503) { setNotConfigured(true); }
      else if (status === 409) { setNotConnected(true); setError('Connect a Google Calendar in Settings first.'); }
      else setError(err?.response?.data?.error || 'Could not create the meeting.');
    } finally {
      setSaving(false);
    }
  };

  if (hidden) return null;

  if (loading) {
    return <p className="text-xs text-gray-500">Loading meetings…</p>;
  }

  if (notConfigured) {
    return (
      <p className="text-xs text-gray-500">
        Google Calendar isn’t connected yet. Connect it under{' '}
        <span className="font-medium">Settings → Calendar</span> to schedule
        meetings from a deal and see them on the timeline.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {/* Meeting list */}
      {events.length === 0 ? (
        <p className="text-xs text-gray-500">No meetings for this deal yet.</p>
      ) : (
        <ul className="space-y-2">
          {events.map((ev) => (
            <li key={ev.id} className="border border-gray-200 rounded p-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-gray-900 break-words">{ev.title || '(untitled meeting)'}</span>
                {ev.source === 'created' ? (
                  <span className="text-[10px] uppercase tracking-wide text-indigo-600 font-semibold flex-shrink-0">scheduled</span>
                ) : null}
              </div>
              <div className="text-xs text-gray-500 mt-0.5">
                {fmtDateTime(ev.start_at)}
                {Array.isArray(ev.attendees) && ev.attendees.length ? ` · ${ev.attendees.length} attendee${ev.attendees.length === 1 ? '' : 's'}` : ''}
                {ev.meeting_link ? (
                  <>
                    {' · '}
                    <a href={ev.meeting_link} target="_blank" rel="noopener noreferrer" className="text-brand-blue hover:underline">join</a>
                  </>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* Schedule action */}
      {formOpen ? (
        <form onSubmit={handleSchedule} className="border border-gray-200 rounded p-3 space-y-2 bg-gray-50">
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Meeting title"
            className="w-full text-sm border border-gray-300 rounded px-2 py-1.5"
          />
          <div className="flex flex-wrap gap-2">
            <label className="text-xs text-gray-600 flex flex-col gap-0.5">
              Start
              <input
                type="datetime-local"
                value={startAt}
                onChange={(e) => setStartAt(e.target.value)}
                className="text-sm border border-gray-300 rounded px-2 py-1"
              />
            </label>
            <label className="text-xs text-gray-600 flex flex-col gap-0.5">
              Duration
              <select
                value={durationMin}
                onChange={(e) => setDurationMin(Number(e.target.value))}
                className="text-sm border border-gray-300 rounded px-2 py-1"
              >
                <option value={15}>15 min</option>
                <option value={30}>30 min</option>
                <option value={45}>45 min</option>
                <option value={60}>1 hour</option>
              </select>
            </label>
          </div>
          <input
            type="text"
            value={attendees}
            onChange={(e) => setAttendees(e.target.value)}
            placeholder="Attendee emails (comma-separated)"
            className="w-full text-sm border border-gray-300 rounded px-2 py-1.5"
          />
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={saving}
              className="text-xs px-3 py-1.5 bg-brand-blue hover:bg-brand-blue-dark text-white rounded font-medium disabled:opacity-50"
            >
              {saving ? 'Scheduling…' : 'Schedule'}
            </button>
            <button
              type="button"
              onClick={() => setFormOpen(false)}
              disabled={saving}
              className="text-xs px-3 py-1.5 border border-gray-300 text-gray-700 rounded disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => setFormOpen(true)}
          className="text-xs px-2 py-1 bg-brand-blue hover:bg-brand-blue-dark text-white rounded font-medium"
        >
          Schedule meeting
        </button>
      )}

      {error ? <p className="text-xs text-danger-600">{error}</p> : null}
    </div>
  );
}
