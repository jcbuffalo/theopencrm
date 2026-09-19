// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// EmailComposerModal — one-off send from a Contact or Deal surface.
//
// Scope: plain text body, optional template prefill, two merge fields only.
// No rich-text editor, no attachments, no CC/BCC — by design (see
// COMPETITIVE_REVIEW.md parity gap #1 and the explicit "well but not a
// giant bloated freeware" directive). Future iterations can layer those on.
//
// Props
//   open        : boolean — controls visibility
//   onClose     : () => void
//   onSent      : (sendResponse) => void — fired after a successful send
//   contact?    : { id, first_name, last_name, email } — locks the To: field
//   deal?       : { id, title } — used for {{deal.title}} resolution and tracking
//   defaultTo?  : string — when neither contact nor deal carries an email
//   initialSubject? / initialBody? : string — prefill for the Subject/Body
//                 fields (AI-drafted follow-ups, "Open in composer" from a
//                 chat draft). Applied each time the modal opens; the user
//                 can still edit or pick a template over the top.
//
// The "To:" field is read-only when a contact with an email was passed in
// (the usual surface) and editable otherwise (ad-hoc compose, deal w/o
// linked contact).

import React, { useEffect, useRef, useState } from 'react';
import api from '../api';
import { Alert, Button, Icon, Input, Modal, Select, Textarea } from './ui';

// Minimal RFC-shape email check — exactly enough to catch obvious typos
// like missing `@` before we let the user click Send. Backend re-validates.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function EmailComposerModal({
  open, onClose, onSent, contact, deal, defaultTo, initialSubject, initialBody,
}) {
  // Resolve initial To: address. Priority: explicit defaultTo > contact.email.
  const initialTo = defaultTo || contact?.email || '';
  const toIsLocked = Boolean(contact?.email) && !defaultTo;

  const [to, setTo] = useState(initialTo);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [templates, setTemplates] = useState([]);
  // Recently-used templates (last 3 used), separate fetch so we don't have
  // to sort the full list client-side. Backend returns up to 5 ordered by
  // last_used_at DESC NULLS LAST; we slice to 3 in the picker.
  const [recentTemplates, setRecentTemplates] = useState([]);
  const [templateId, setTemplateId] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  // Ref so the Cmd/Ctrl+Enter handler and the guarded close can read the
  // in-flight state without prop-drilling.
  const sendingRef = useRef(false);
  useEffect(() => { sendingRef.current = sending; }, [sending]);

  // Refresh inputs when the surface that opened the modal changes — important
  // for the contacts list where the same modal instance gets re-used per row.
  useEffect(() => {
    if (!open) return;
    setTo(defaultTo || contact?.email || '');
    setSubject(initialSubject || '');
    setBody(initialBody || '');
    setTemplateId('');
    setError('');
    setResult(null);
  }, [open, contact?.id, deal?.id, defaultTo, contact?.email, initialSubject, initialBody]);

  // Load templates lazily — only when the modal opens. Two fetches in
  // parallel: the full alphabetical list and the recently-used top-5.
  // Old backends without ?recently_used=true just return the full list,
  // which we'd then dedupe in the picker — but the picker simply renders
  // both arrays so a stale-backend fallback shows duplicates, which is
  // a cosmetic issue, not a functional one.
  useEffect(() => {
    if (!open) return;
    api.get('/emails/templates')
      .then(r => setTemplates(r.data || []))
      .catch(() => setTemplates([]));
    api.get('/emails/templates?recently_used=true')
      .then(r => setRecentTemplates(Array.isArray(r.data) ? r.data : []))
      .catch(() => setRecentTemplates([]));
  }, [open]);

  // Keyboard: Cmd/Ctrl+Enter submits. Bound at document level so the
  // textarea — which would otherwise swallow Enter — still triggers send
  // when the user holds the modifier. (Escape is handled by <Modal>, routed
  // through the guarded close below so a mid-send Esc is ignored.)
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        handleSend();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // handleSend closes over state; we re-bind whenever those change so the
    // shortcut uses the current values, not a stale snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, to, subject, body, templateId, contact?.id, deal?.id, onClose]);

  const applyTemplate = (id) => {
    setTemplateId(id);
    if (!id) return;
    const t = templates.find(x => String(x.id) === String(id));
    if (t) {
      setSubject(t.subject || '');
      setBody(t.body || '');
    }
  };

  const handleSend = async (e) => {
    e?.preventDefault?.();
    if (sendingRef.current) return; // belt-and-suspenders against double-fire
    setError('');
    if (!to || !subject || !body) {
      setError('To, subject, and body are required.');
      return;
    }
    if (!EMAIL_RE.test(to.trim())) {
      setError('Please enter a valid email address.');
      return;
    }
    setSending(true);
    try {
      const r = await api.post('/emails/send', {
        to_email: to,
        to_contact_id: contact?.id || null,
        to_deal_id: deal?.id || null,
        subject,
        body,
        template_id: templateId ? Number(templateId) : null,
      });
      setResult(r.data);
      onSent?.(r.data);
    } catch (err) {
      if (err.response?.data?.code === 'UNSUBSCRIBED') {
        setError('This recipient has unsubscribed from your messages.');
      } else {
        setError(err.response?.data?.error || 'Failed to send.');
      }
    } finally {
      setSending(false);
    }
  };

  if (!open) return null;

  // Esc / backdrop / × all route here — ignored while a send is in flight.
  const guardedClose = () => { if (!sendingRef.current) onClose?.(); };

  const description = [
    contact ? `To contact: ${contact.first_name || ''} ${contact.last_name || ''}`.trim() : null,
    deal ? `Deal: ${deal.title}` : null,
  ].filter(Boolean).join(' · ') || undefined;

  const footer = result ? (
    <Button onClick={onClose}>Close</Button>
  ) : (
    <div className="flex w-full items-center justify-between gap-3">
      <span className="hidden text-[10px] text-gray-400 sm:inline">
        <kbd className="rounded border border-gray-200 px-1">Esc</kbd> close ·{' '}
        <kbd className="rounded border border-gray-200 px-1">⌘/Ctrl+Enter</kbd> send
      </span>
      <div className="ml-auto flex gap-2">
        <Button variant="secondary" onClick={onClose} disabled={sending}>Cancel</Button>
        <Button type="submit" form="email-composer-form" loading={sending} loadingLabel="Sending…">Send</Button>
      </div>
    </div>
  );

  return (
    <Modal
      open={open}
      onClose={guardedClose}
      title="Compose email"
      description={description}
      size="lg"
      footer={footer}
    >
      {result ? (
        // Post-send confirmation — surfaces the transport so users know
        // whether their email actually went out or was console-logged
        // because SMTP isn't configured. Mirrors the SendRfqModal pattern.
        <div className="space-y-3">
          <Alert tone={result.delivery_error ? 'danger' : result.transport === 'console' ? 'warning' : 'success'}>
            {result.delivery_error
              ? `Delivery failed: ${result.delivery_error}`
              : result.transport === 'console'
              ? 'Recorded — but email service is not configured, so no real message was delivered. Set GMAIL_USER + GMAIL_APP_PASSWORD or SENDGRID_API_KEY on the backend to enable real send.'
              : `Sent via ${result.transport}.`}
          </Alert>
          <div className="text-xs text-gray-500">Send ID: <code>{result.send_id}</code></div>
        </div>
      ) : (
        <form id="email-composer-form" onSubmit={handleSend} className="space-y-3">
          {error && <Alert tone="danger" onDismiss={() => setError('')}>{error}</Alert>}

          <Input
            label="To"
            type="email"
            required
            value={to}
            onChange={(e) => setTo(e.target.value)}
            readOnly={toIsLocked}
            className={toIsLocked ? 'bg-gray-50 text-gray-600' : ''}
            placeholder="recipient@example.com"
          />

          {templates.length > 0 && (
            <Select
              label="Template"
              value={templateId}
              onChange={(e) => applyTemplate(e.target.value)}
            >
              <option value="">— None (compose from scratch) —</option>
              {recentTemplates.length > 0 && (
                <optgroup label="Recently used">
                  {recentTemplates.slice(0, 3).map(t => (
                    <option key={`recent-${t.id}`} value={t.id}>{t.name}</option>
                  ))}
                </optgroup>
              )}
              <optgroup label="All templates">
                {templates.map(t => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </optgroup>
            </Select>
          )}

          <Input
            label="Subject"
            type="text"
            required
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="What's this about?"
          />

          <div>
            <Textarea
              label="Body"
              required
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={12}
              className="font-mono"
              placeholder={`Hi {{contact.name}},\n\nFollowing up on {{deal.title}}…\n\n— Your name`}
            />
            <p className="mt-1 text-[11px] text-gray-500">
              Available merge fields: <code>{'{{contact.name}}'}</code>, <code>{'{{deal.title}}'}</code>.
              Basic markdown: <code>**bold**</code>, <code>*italic*</code>, <code>`code`</code>.
              An unsubscribe link is appended automatically.
            </p>
            <p
              className="mt-1 inline-flex items-start gap-1 text-[11px] text-gray-400"
              // Hover text repeats the inline copy for screen readers + at-a-glance
              // skimmers; keeps the disclosure subtle while still visible.
              title="We only track when emails are opened (via a 1×1 image pixel). Clicks, replies, and bounces aren't recorded."
            >
              <Icon name="info" size={12} className="mt-0.5 flex-shrink-0" />
              <span>Tracking: we only record <em>opens</em> (1×1 pixel). Clicks, replies, and bounces aren't tracked.</span>
            </p>
          </div>
        </form>
      )}
    </Modal>
  );
}
