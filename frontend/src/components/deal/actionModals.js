// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Write surfaces behind the hero CTAs: log an activity (calls keep their
// dedicated /calls/log endpoint), add a task, send an SMS, and the AI-assist
// output panel. All use the shared Modal primitive.

import React, { useEffect, useState } from 'react';
import api from '../../api';
import { Alert, Button, Icon, Input, Modal, Select, Textarea } from '../ui';
import { PhoneLink } from './shared';

const ACTIVITY_TYPES = ['call', 'email', 'meeting', 'note', 'demo', 'other'];

// "First Last" for a contact-only surface (the contact drawer reuses these
// modals with no deal in scope).
function recordName(contact) {
  if (!contact) return '';
  return `${contact.first_name || ''} ${contact.last_name || ''}`.trim();
}

function nowLocal() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// -- Log activity. type='call' writes through POST /calls/log (direction /
// duration / outcome / notes map onto activity columns); every other type
// is a plain POST /activities row. `deal` is optional: the contact drawer
// logs against the contact alone (deal_id null).
export function LogActivityModal({ open, deal, contact, onClose, onLogged }) {
  const [form, setForm] = useState({
    type: 'call', title: '', description: '', activity_date: nowLocal(),
    duration_minutes: '', outcome: 'connected', direction: 'outbound',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  useEffect(() => {
    if (open) {
      setForm({ type: 'call', title: '', description: '', activity_date: nowLocal(), duration_minutes: '', outcome: 'connected', direction: 'outbound' });
      setError('');
    }
  }, [open]);

  const isCall = form.type === 'call';

  const submit = async (e) => {
    e.preventDefault();
    if (!isCall && !form.title.trim()) { setError('Give the activity a title.'); return; }
    setSaving(true);
    setError('');
    try {
      if (isCall) {
        await api.post('/calls/log', {
          deal_id: deal?.id || null,
          contact_id: contact?.id || null,
          direction: form.direction,
          duration_minutes: form.duration_minutes ? Number(form.duration_minutes) : null,
          outcome: form.outcome || null,
          notes: form.description || null,
        });
      } else {
        await api.post('/activities', {
          type: form.type,
          title: form.title.trim(),
          description: form.description || null,
          activity_date: form.activity_date,
          duration_minutes: form.duration_minutes ? Number(form.duration_minutes) : null,
          outcome: form.outcome && form.type !== 'note' ? form.outcome : null,
          contact_id: contact?.id || null,
          deal_id: deal?.id || null,
        });
      }
      onLogged?.();
      onClose();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to log activity');
    } finally {
      setSaving(false);
    }
  };

  const phone = contact?.phone || deal?.poc_phone;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Log activity"
      description={`Recorded on the timeline for ${deal?.title || recordName(contact) || 'this record'}.`}
      footer={(
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" form="log-activity-form" loading={saving} loadingLabel="Logging…">Log activity</Button>
        </>
      )}
    >
      <form id="log-activity-form" onSubmit={submit} className="space-y-3">
        {error && <Alert tone="danger">{error}</Alert>}
        <Select label="Type" value={form.type} onChange={(e) => set({ type: e.target.value })}
          options={ACTIVITY_TYPES.map((t) => ({ value: t, label: t.charAt(0).toUpperCase() + t.slice(1) }))} />
        {isCall ? (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Select label="Direction" value={form.direction} onChange={(e) => set({ direction: e.target.value })}>
              <option value="outbound">Outbound</option>
              <option value="inbound">Inbound</option>
            </Select>
            <Input type="number" min="0" label="Minutes" value={form.duration_minutes} onChange={(e) => set({ duration_minutes: e.target.value })} />
            <Select label="Outcome" value={form.outcome} onChange={(e) => set({ outcome: e.target.value })}>
              <option value="connected">Connected</option>
              <option value="voicemail">Voicemail</option>
              <option value="no_answer">No answer</option>
              <option value="busy">Busy</option>
            </Select>
          </div>
        ) : (
          <>
            <Input label="Title" required value={form.title} onChange={(e) => set({ title: e.target.value })} />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Input type="datetime-local" label="When" value={form.activity_date} onChange={(e) => set({ activity_date: e.target.value })} required />
              <Input type="number" min="0" label="Minutes" value={form.duration_minutes} onChange={(e) => set({ duration_minutes: e.target.value })} />
            </div>
          </>
        )}
        <Textarea label={isCall ? 'Notes (what was discussed)' : 'Notes'} rows={3} value={form.description}
          onChange={(e) => set({ description: e.target.value })} />
        {isCall && phone && (
          <p className="text-xs text-gray-500">Call <PhoneLink number={phone} /></p>
        )}
      </form>
    </Modal>
  );
}

// -- Add task linked to this deal → POST /tasks.
export function AddTaskModal({ open, deal, contact, onClose, onCreated }) {
  const [form, setForm] = useState({ title: '', due_date: '', priority: 'medium', description: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  useEffect(() => {
    if (open) { setForm({ title: '', due_date: '', priority: 'medium', description: '' }); setError(''); }
  }, [open]);

  const submit = async (e) => {
    e.preventDefault();
    if (!form.title.trim()) return;
    setSaving(true);
    setError('');
    try {
      await api.post('/tasks', {
        title: form.title.trim(),
        description: form.description || null,
        due_date: form.due_date || null,
        priority: form.priority,
        status: 'open',
        deal_id: deal?.id || null,
        contact_id: contact?.id || null,
      });
      onCreated?.();
      onClose();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to create task');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add task"
      description={`Linked to ${deal?.title || recordName(contact) || 'this record'}.`}
      footer={(
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" form="add-task-form" loading={saving} loadingLabel="Saving…">Add task</Button>
        </>
      )}
    >
      <form id="add-task-form" onSubmit={submit} className="space-y-3">
        {error && <Alert tone="danger">{error}</Alert>}
        <Input label="Title" required autoFocus value={form.title} onChange={(e) => set({ title: e.target.value })} />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Input type="date" label="Due" value={form.due_date} onChange={(e) => set({ due_date: e.target.value })} />
          <Select label="Priority" value={form.priority} onChange={(e) => set({ priority: e.target.value })}
            options={[{ value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }]} />
        </div>
        <Textarea label="Details" rows={2} value={form.description} onChange={(e) => set({ description: e.target.value })} />
      </form>
    </Modal>
  );
}

// -- Send SMS. Shows delivery state and a graceful "SMS not configured"
// banner when the backend returns 503 {configured:false} (mirrors
// services/sms.js). The destination defaults to the contact's phone / deal
// POC phone but stays editable.
export function SmsModal({ open, deal, contact, onClose, onSent }) {
  const [toNumber, setToNumber] = useState('');
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState(null); // { status } on send | { configured:false } when off
  const [error, setError] = useState('');

  useEffect(() => {
    if (open) {
      setToNumber(contact?.phone || deal?.poc_phone || '');
      setBody('');
      setResult(null);
      setError('');
    }
  }, [open, contact?.phone, deal?.poc_phone]);

  const send = async (e) => {
    e.preventDefault();
    setSending(true); setError(''); setResult(null);
    try {
      const r = await api.post('/sms', {
        deal_id: deal.id,
        contact_id: contact?.id || null,
        to_number: toNumber || undefined,
        body,
      });
      setResult(r.data);
      onSent?.();
    } catch (err) {
      if (err.response?.status === 503 && err.response?.data?.configured === false) {
        setResult({ configured: false, message: err.response.data.error });
      } else {
        setError(err.response?.data?.error || 'Failed to send SMS');
      }
    } finally {
      setSending(false);
    }
  };

  const done = !!result;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Send SMS"
      description="Texts send from your Twilio number; the message is logged to this deal's timeline."
      footer={done ? (
        <Button onClick={onClose}>Close</Button>
      ) : (
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" form="send-sms-form" disabled={!body.trim()} loading={sending} loadingLabel="Sending…">Send SMS</Button>
        </>
      )}
    >
      {result?.configured === false ? (
        <Alert tone="warning">
          {result.message || 'SMS is not configured. Add your Twilio credentials on the backend to enable sending.'}
        </Alert>
      ) : result ? (
        <Alert tone={result.status === 'sent' ? 'success' : 'warning'}>
          {result.status === 'sent' ? 'Message sent.' : `Message ${result.status}. It was recorded on the timeline.`}
        </Alert>
      ) : (
        <form id="send-sms-form" onSubmit={send} className="space-y-3">
          {error && <Alert tone="danger">{error}</Alert>}
          <Input type="tel" label="To (phone)" required value={toNumber} onChange={(e) => setToNumber(e.target.value)} placeholder="+15555550123" />
          <Textarea label="Message" required value={body} onChange={(e) => setBody(e.target.value)} rows={4} maxLength={1600}
            placeholder="Type your text message…" hint={`${body.length}/1600`} />
        </form>
      )}
    </Modal>
  );
}

// -- AI assist output. `request` is { kind: 'summarize' | 'draft', n } from
// the hero's AI menu; a new n re-runs. Drafts show a recipient/steer row
// first. Renders nothing until asked.
export function AiAssistPanel({ deal, request, onDismiss, onOpenComposer }) {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [output, setOutput] = useState('');
  const [mode, setMode] = useState(null);
  const [recipient, setRecipient] = useState('customer');
  const [customNote, setCustomNote] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!request || status) return;
    api.get('/ai/status').then((r) => setStatus(r.data)).catch(() => {});
  }, [request, status]);

  const run = async (kind) => {
    setBusy(true); setMode(kind); setOutput(''); setCopied(false);
    try {
      const path = kind === 'summarize' ? `/ai/summarize-deal/${deal.id}` : `/ai/draft-followup/${deal.id}`;
      const body = kind === 'draft' ? { recipient, customNote } : {};
      // AI calls can outrun the 10s axios default; give them the same 60s
      // headroom Chat.js uses so slower model responses don't get killed.
      const r = await api.post(path, body, { timeout: 60000 });
      if (r.data.configured === false) {
        setOutput(`AI not configured. ${r.data.message || 'Set ANTHROPIC_API_KEY on the backend.'}`);
      } else if (r.data.ok === false) {
        setOutput(`AI error: ${r.data.error || 'unknown'}`);
      } else {
        setOutput(r.data.text || '(empty)');
      }
    } catch (err) {
      setOutput(`Error: ${err.response?.data?.error || err.message}`);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!request) return;
    if (request.kind === 'summarize') run('summarize');
    else { setMode('draft'); setOutput(''); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request?.n, request?.kind]);

  if (!request) return null;

  return (
    <div className="space-y-2 rounded border border-gray-200 bg-gray-50 p-3" aria-live="polite">
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-gray-500">
          <Icon name="sparkles" size={14} className="text-brand-blue" />
          {mode === 'draft' ? 'Draft follow-up' : 'Deal summary'}
        </span>
        <button type="button" onClick={onDismiss} aria-label="Dismiss AI output"
          className="rounded-md p-1 text-gray-400 hover:bg-gray-200 hover:text-gray-700">
          <Icon name="x" size={14} />
        </button>
      </div>
      {status && !status.configured && (
        <Alert tone="warning" className="py-2 text-xs">AI key not configured — requests return a helpful error instead.</Alert>
      )}
      {mode === 'draft' && (
        <div className="flex flex-wrap gap-2">
          <Select size="sm" aria-label="Recipient" value={recipient} onChange={(e) => setRecipient(e.target.value)} wrapperClassName="w-32">
            <option value="customer">To customer</option>
            <option value="vendor">To vendor</option>
          </Select>
          <Input size="sm" placeholder="Optional steer (e.g. 'mention the warranty')" aria-label="Steer"
            value={customNote} onChange={(e) => setCustomNote(e.target.value)} wrapperClassName="min-w-[10rem] flex-1" />
          <Button size="sm" onClick={() => run('draft')} loading={busy} loadingLabel="Drafting…">Draft</Button>
        </div>
      )}
      {busy && mode === 'summarize' && <p className="text-xs text-gray-500">Summarizing…</p>}
      {output && (
        <div className="space-y-1.5">
          <div className="whitespace-pre-wrap rounded border border-gray-200 bg-white p-3 text-sm text-gray-800">
            {output}
          </div>
          <div className="flex justify-end gap-2">
            {mode === 'draft' && onOpenComposer && (
              <Button
                size="sm"
                variant="secondary"
                icon="mail"
                title="Opens the email composer with this draft filled in"
                onClick={() => onOpenComposer(output)}
              >
                Open in composer
              </Button>
            )}
            <Button size="sm" variant="ghost" icon="copy"
              onClick={() => { navigator.clipboard?.writeText(output); setCopied(true); }}>
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
