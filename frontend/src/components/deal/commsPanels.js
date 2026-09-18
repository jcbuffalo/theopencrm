// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Read surfaces for the Activity tab: the merged communication timeline,
// tasks linked to the deal, and emails sent from the in-CRM composer.

import React, { useEffect, useState } from 'react';
import api from '../../api';
import { Icon, Skeleton, StatusBadge } from '../ui';
import { ActionError, fmtDate, LinkButton, useAsyncAction } from './shared';

const KIND_ICON = {
  meeting: 'users',
  call: 'phone',
  email: 'mail',
  sms: 'chat',
  note: 'edit',
  demo: 'star',
};

// -- Communication timeline: merges activities + meeting_logs into one
// chronological list. SMS (activity type='sms') and logged calls
// (type='call') flow through here for free — they're plain activity rows.
// refreshKey lets the parent re-pull after a send / call-log.
export function CommunicationTimeline({ dealId, refreshKey }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    Promise.all([
      api.get(`/activities?deal_id=${dealId}&limit=50`).catch(() => ({ data: [] })),
      api.get(`/webhooks/meetings?related_type=deal&related_id=${dealId}&limit=50`).catch(() => ({ data: { meetings: [] } })),
    ]).then(([acts, meets]) => {
      if (!alive) return;
      const activityRows = (Array.isArray(acts.data) ? acts.data : []).map((a) => ({
        kind: 'activity',
        id: `a-${a.id}`,
        ts: a.activity_date,
        title: a.title,
        type: a.type,
        meta: [a.duration_minutes ? `${a.duration_minutes}m` : null, a.outcome].filter(Boolean).join(' · '),
        body: a.description,
      }));
      const meetingRows = (meets.data?.meetings || []).map((m) => ({
        kind: 'meeting',
        id: `m-${m.id}`,
        ts: m.occurred_at || m.created_at,
        title: m.title || 'Meeting',
        type: m.source,
        meta: [m.duration_minutes ? `${m.duration_minutes}m` : null, m.participants].filter(Boolean).join(' · '),
        body: m.summary,
        recordingUrl: m.recording_url,
      }));
      setItems([...activityRows, ...meetingRows].sort((a, b) => new Date(b.ts) - new Date(a.ts)));
    }).finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [dealId, refreshKey]);

  if (loading) return <Skeleton lines={3} />;
  if (items.length === 0) return <p className="text-xs text-gray-500">No communication logged yet.</p>;

  return (
    <ol className="relative space-y-3 text-xs">
      <div className="absolute bottom-0 left-2.5 top-0 w-px bg-gray-200" aria-hidden="true" />
      {items.map((item) => {
        const icon = item.kind === 'meeting' ? KIND_ICON.meeting : (KIND_ICON[item.type] || 'clock');
        return (
          <li key={item.id} className="relative pl-8">
            <span className={`absolute left-0 top-0 flex h-5 w-5 items-center justify-center rounded-full ring-2 ring-white ${item.kind === 'meeting' ? 'bg-purple-100 text-purple-700' : 'bg-info-100 text-brand-blue'}`}>
              <Icon name={icon} size={12} />
            </span>
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="font-semibold text-gray-900">{item.title}</span>
              <span className="text-[10px] uppercase text-gray-500">{item.type}</span>
              <span className="text-gray-400">{item.ts ? new Date(item.ts).toLocaleString() : ''}</span>
            </div>
            {item.meta && <p className="mt-0.5 text-gray-600">{item.meta}</p>}
            {item.body && <p className="mt-0.5 whitespace-pre-wrap text-gray-700">{item.body}</p>}
            {item.recordingUrl && (
              <a href={item.recordingUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-brand-blue hover:underline">
                Recording <Icon name="external" size={12} />
              </a>
            )}
          </li>
        );
      })}
    </ol>
  );
}

const TASK_TONE = { open: 'info', in_progress: 'warning', done: 'success' };
const PRIORITY_TONE = { low: 'neutral', medium: 'warning', high: 'error' };

// -- Tasks linked to this deal. Read + "mark done"; full editing on /tasks.
export function DealTasksList({ dealId, refreshKey }) {
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const { run, error } = useAsyncAction();

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api.get(`/tasks?deal_id=${dealId}`)
      .then((r) => { if (alive) setTasks(Array.isArray(r.data) ? r.data : []); })
      .catch(() => { if (alive) setTasks([]); })
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [dealId, refreshKey, tick]);

  const markDone = async (id) => {
    if (await run(() => api.put(`/tasks/${id}`, { status: 'done' }))) setTick((t) => t + 1);
  };

  if (loading) return <Skeleton lines={2} />;
  return (
    <div>
      <ActionError error={error} className="mb-2" />
      {tasks.length === 0 ? (
        <p className="text-xs text-gray-500">No tasks linked to this deal.</p>
      ) : (
        <ul className="space-y-1.5 text-xs">
          {tasks.map((t) => (
            <li key={t.id} className="flex items-center justify-between gap-2 rounded border border-gray-200 px-2 py-1.5">
              <div className="min-w-0 flex-1">
                <div className={`truncate font-medium ${t.status === 'done' ? 'text-gray-400 line-through' : 'text-gray-900'}`}>{t.title}</div>
                <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-gray-500">
                  {t.due_date && <span>Due {fmtDate(t.due_date)}</span>}
                  {t.priority && <StatusBadge tone={PRIORITY_TONE[t.priority] || 'neutral'} label={t.priority} />}
                  <StatusBadge tone={TASK_TONE[t.status] || 'neutral'} label={String(t.status || 'open').replace('_', ' ')} />
                </div>
              </div>
              {t.status !== 'done' && <LinkButton tone="success" onClick={() => markDone(t.id)}>Mark done</LinkButton>}
            </li>
          ))}
        </ul>
      )}
      <a href="/tasks" className="mt-2 inline-block text-xs font-medium text-brand-blue hover:underline">Open Tasks</a>
    </div>
  );
}

// -- Sent emails (from the in-CRM composer). Renders sent + opened state so
// reps can see at a glance which of their recent sends got opened.
export function EmailsTimeline({ dealId, refreshKey }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api.get(`/emails/sends?deal_id=${dealId}`)
      .then((r) => { if (alive) setItems(Array.isArray(r.data) ? r.data : []); })
      .catch(() => { if (alive) setItems([]); })
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [dealId, refreshKey]);

  if (loading) return <Skeleton lines={2} />;
  if (items.length === 0) return <p className="text-xs text-gray-500">No emails sent from the CRM yet.</p>;

  // Tracking disclosure — see /api/emails/track/:id.gif. The Opened/Sent
  // badges are derived ONLY from the open-pixel; we deliberately don't
  // track clicks, replies, or bounces.
  const trackingNote = "We only track when emails are opened (via a 1×1 image pixel). Clicks, replies, and bounces aren't recorded.";

  return (
    <>
      <p className="mb-1.5 flex items-center gap-1 text-[11px] text-gray-400" title={trackingNote}>
        <Icon name="info" size={12} />
        Tracking: only <em>opens</em> are recorded. Clicks, replies, and bounces aren't tracked.
      </p>
      <ul className="space-y-2 text-xs">
        {items.map((e) => (
          <li key={e.id} className="rounded border border-gray-200 px-2 py-1.5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="min-w-0 truncate font-semibold text-gray-900">{e.subject || '(no subject)'}</span>
              {e.opened_at ? (
                <StatusBadge tone="success" label={`Opened ${new Date(e.opened_at).toLocaleDateString()}`} title={trackingNote} />
              ) : (
                <StatusBadge tone="neutral" label="Sent" title={trackingNote} />
              )}
            </div>
            <div className="mt-0.5 text-[11px] text-gray-500">
              To {e.to_email} · {new Date(e.sent_at).toLocaleString()}
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}
