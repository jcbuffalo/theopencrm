// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import api from '../api';

// Public customer portal — /portal/:token. NO AUTH: this renders for an
// external customer contact following a link their vendor shared. It talks
// only to the public, CSRF-exempt, rate-limited endpoints (mirrors
// pages/SurveyResponse.js):
//   GET /api/public/portal/:token/overview   → { company, deals, quotes, invoices }
//   GET /api/public/portal/:token/deals      → [{ id, title, stage, amount, ... }]
//   GET /api/public/portal/:token/documents  → [{ id, filename, doc_type, ... }]
//   GET /api/public/portal/:token/documents/:id/download → 302 signed URL / blob
//   GET /api/public/portal/:token/cases      → this company's portal-submitted cases
//   POST /api/public/portal/:token/cases     → submit a support case (148)
//   POST /api/public/portal/:token/quotes/:id/respond → approve / request changes (149)
//   GET/POST /api/public/portal/:token/messages → the message thread (150)
//   (all public writes share one strict server-side rate limit)
// Every payload is a server-side whitelist — no org internals reach this page,
// and the page renders nothing it isn't given. Unknown/revoked/expired links
// all land on the same "not available" state.

function fmtMoney(n) {
  if (n === null || n === undefined || n === '') return '—';
  return `$${Number(n).toLocaleString()}`;
}

function fmtDate(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString();
}

function fmtSize(bytes) {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Human-friendly stage chip — portal viewers shouldn't need to parse
// SCREAMING_SNAKE pipeline internals.
function stageLabel(stage) {
  if (!stage) return '—';
  return String(stage).replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

const STATUS_CHIP = 'inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold border capitalize';

export default function CustomerPortal() {
  const { token } = useParams();
  const [overview, setOverview] = useState(null);
  const [deals, setDeals] = useState([]);
  const [documents, setDocuments] = useState([]);
  const [cases, setCases] = useState([]);
  const [messages, setMessages] = useState([]);
  const [missing, setMissing] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    const t = encodeURIComponent(token);
    Promise.all([
      api.get(`/public/portal/${t}/overview`),
      api.get(`/public/portal/${t}/deals`).catch(() => ({ data: [] })),
      api.get(`/public/portal/${t}/documents`).catch(() => ({ data: [] })),
      api.get(`/public/portal/${t}/cases`).catch(() => ({ data: [] })),
      api.get(`/public/portal/${t}/messages`).catch(() => ({ data: [] })),
    ])
      .then(([o, d, docs, cs, msgs]) => {
        if (!active) return;
        setOverview(o.data);
        setDeals(Array.isArray(d.data) ? d.data : []);
        setDocuments(Array.isArray(docs.data) ? docs.data : []);
        setCases(Array.isArray(cs.data) ? cs.data : []);
        setMessages(Array.isArray(msgs.data) ? msgs.data : []);
      })
      .catch(() => { if (active) setMissing(true); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [token]);

  // Downloads: the endpoint 302s to a short-lived signed URL, so a plain
  // navigation (new tab) is the right transport — no auth headers involved.
  const downloadUrl = (docId) =>
    `${api.defaults.baseURL}/public/portal/${encodeURIComponent(token)}/documents/${docId}/download`;

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-brand-blue" />
      </div>
    );
  }

  if (missing || !overview) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
        <div className="w-full max-w-md bg-white border border-gray-200 rounded-2xl shadow-sm p-8 text-center">
          <div className="text-4xl mb-3" aria-hidden="true">🔒</div>
          <h1 className="text-lg font-semibold text-gray-900 mb-1">This portal link isn't available</h1>
          <p className="text-sm text-gray-600">
            The link may have expired or been turned off. Please contact your account
            representative for a fresh one.
          </p>
        </div>
      </div>
    );
  }

  const company = overview.company || {};
  const quotes = overview.quotes || [];
  const invoices = overview.invoices || [];

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 py-5 flex items-center justify-between">
          <div>
            <div className="text-[11px] uppercase tracking-wider font-semibold text-gray-400">Customer portal</div>
            <h1 className="text-xl font-bold text-gray-900">{company.name || 'Your account'}</h1>
          </div>
          <span className={`${STATUS_CHIP} bg-green-50 text-green-700 border-green-200`}>Shared account view</span>
        </div>
      </header>

      <main id="main-content" className="max-w-4xl mx-auto px-4 sm:px-6 py-8 space-y-8">
        {/* Account overview */}
        <section className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
          <h2 className="text-sm font-semibold text-gray-900 mb-4">Account overview</h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Stat label="Open deals" value={overview.deals?.open ?? 0} />
            <Stat label="Total deals" value={overview.deals?.total ?? 0} />
            <Stat label="Quotes" value={quotes.length} />
            <Stat label="Documents" value={documents.length} />
          </div>
          <div className="mt-4 text-sm text-gray-500 flex flex-wrap gap-x-4 gap-y-1">
            {company.industry && <span>{company.industry}</span>}
            {company.location && <span>{company.location}</span>}
            {company.website && (
              <a href={company.website} target="_blank" rel="noopener noreferrer" className="text-brand-blue hover:underline">
                {company.website}
              </a>
            )}
          </div>
        </section>

        {/* Deals */}
        <section>
          <h2 className="text-sm font-semibold text-gray-900 mb-3">Deals</h2>
          {deals.length === 0 ? (
            <Empty>No deals to show yet.</Empty>
          ) : (
            <div className="bg-white border border-gray-200 rounded-lg divide-y divide-gray-100">
              {deals.map((d) => (
                <div key={d.id} className="px-4 py-3 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-gray-900 break-words">{d.title}</div>
                    <div className="text-xs text-gray-500 mt-0.5">
                      {d.expected_close_date && <>expected close {fmtDate(d.expected_close_date)} · </>}
                      opened {fmtDate(d.created_at)}
                    </div>
                  </div>
                  <div className="flex items-center gap-3 flex-shrink-0">
                    <span className="text-sm font-semibold text-gray-700">{fmtMoney(d.amount)}</span>
                    <span className={`${STATUS_CHIP} bg-blue-50 text-blue-700 border-blue-200`}>{stageLabel(d.stage)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Quotes — only rendered when the vendor uses the quotes module.
            Portal v3: each quote can be approved / sent back with a note. */}
        {quotes.length > 0 && (
          <section>
            <h2 className="text-sm font-semibold text-gray-900 mb-3">Quotes</h2>
            <div className="bg-white border border-gray-200 rounded-lg divide-y divide-gray-100">
              {quotes.map((q) => (
                <PortalQuoteRow key={q.id} token={token} quote={q} />
              ))}
            </div>
          </section>
        )}

        {/* Invoices — only rendered when present */}
        {invoices.length > 0 && (
          <section>
            <h2 className="text-sm font-semibold text-gray-900 mb-3">Invoices</h2>
            <div className="bg-white border border-gray-200 rounded-lg divide-y divide-gray-100">
              {invoices.map((inv, i) => (
                <div key={inv.invoice_number || i} className="px-4 py-3 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-gray-900">{inv.invoice_number || 'Invoice'}</div>
                    <div className="text-xs text-gray-500 mt-0.5">
                      {inv.due_date && <>due {fmtDate(inv.due_date)} · </>}
                      {inv.paid_at ? <>paid {fmtDate(inv.paid_at)}</> : <>issued {fmtDate(inv.created_at)}</>}
                    </div>
                  </div>
                  <div className="flex items-center gap-3 flex-shrink-0">
                    <span className="text-sm font-semibold text-gray-700">{fmtMoney(inv.total_amount)}</span>
                    <span className={`${STATUS_CHIP} ${inv.status === 'paid' ? 'bg-green-50 text-green-700 border-green-200' : 'bg-amber-50 text-amber-700 border-amber-200'}`}>
                      {inv.status}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Documents — downloads + portal v5 uploads */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-gray-900">Documents</h2>
            <UploadButton token={token} onUploaded={(d) => setDocuments((prev) => [d, ...prev])} />
          </div>
          {documents.length === 0 ? (
            <Empty>No documents yet. Your team's shared files — and anything you upload — appear here.</Empty>
          ) : (
            <div className="bg-white border border-gray-200 rounded-lg divide-y divide-gray-100">
              {documents.map((doc) => (
                <div key={doc.id} className="px-4 py-3 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-gray-900 break-words">{doc.filename}</div>
                    <div className="text-xs text-gray-500 mt-0.5">
                      {doc.doc_type && <span className="capitalize">{doc.doc_type} · </span>}
                      {fmtSize(doc.size)}{doc.size != null && ' · '}{fmtDate(doc.created_at)}
                    </div>
                  </div>
                  <a
                    href={downloadUrl(doc.id)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex-shrink-0 text-sm font-medium text-brand-blue hover:text-brand-blue-dark hover:underline"
                  >
                    Download
                  </a>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Support — file a case, track its status */}
        <SupportSection token={token} cases={cases} onSubmitted={(c) => setCases((prev) => [c, ...prev])} />

        {/* Messages — the running thread with the account team (portal v4) */}
        <MessagesSection token={token} messages={messages} onSent={(m) => setMessages((prev) => [...prev, m])} />

        <footer className="text-center text-xs text-gray-400 pb-6 space-y-2">
          <p>This is a view of {company.name ? `the ${company.name} account` : 'your account'}, shared with you by your account team.</p>
          <p className="text-[11px]">
            Powered by <a href="https://app.theopencrm.com" target="_blank" rel="noreferrer" className="text-gray-500 hover:text-gray-700 underline">The Open CRM</a> →
          </p>
        </footer>
      </main>
    </div>
  );
}

// One quote row with the portal-v3 respond flow: Approve is one click;
// "Request changes" opens an inline note box. The response is recorded
// server-side in dedicated columns and the account team is notified — the
// quote's own status only changes when the team acts on it.
function PortalQuoteRow({ token, quote }) {
  const [response, setResponse] = useState(quote.portal_response || null);
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const respond = async (action, withNote) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await api.post(
        `/public/portal/${encodeURIComponent(token)}/quotes/${quote.id}/respond`,
        { action, note: withNote || undefined }
      );
      setResponse(action);
      setAsking(false);
      setNote('');
    } catch (err) {
      const status = err?.response?.status;
      if (status === 429) setError('Too many submissions — please try again in a few minutes.');
      else setError(err?.response?.data?.error || 'Something went wrong — please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium text-gray-900 break-words">{quote.title}</div>
          <div className="text-xs text-gray-500 mt-0.5">
            {quote.valid_until && <>valid until {fmtDate(quote.valid_until)} · </>}
            issued {fmtDate(quote.created_at)}
          </div>
        </div>
        <div className="flex items-center gap-3 flex-shrink-0">
          <span className="text-sm font-semibold text-gray-700">{fmtMoney(quote.total_amount)}</span>
          <span className={`${STATUS_CHIP} bg-violet-50 text-violet-700 border-violet-200`}>{quote.status}</span>
        </div>
      </div>

      {response ? (
        <div className="mt-2">
          <span className={`${STATUS_CHIP} ${response === 'approved'
            ? 'bg-green-50 text-green-700 border-green-200'
            : 'bg-amber-50 text-amber-700 border-amber-200'}`}>
            {response === 'approved' ? '✓ You approved this quote' : 'You requested changes'}
          </span>
        </div>
      ) : (
        <div className="mt-2">
          {asking ? (
            <div className="space-y-2">
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={2000}
                rows={2}
                placeholder="What should change? (optional)"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-blue/40"
              />
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => respond('changes_requested', note)}
                  className="text-xs font-medium text-white bg-amber-600 hover:bg-amber-700 disabled:opacity-50 rounded-lg px-3 py-1.5"
                >
                  {busy ? 'Sending…' : 'Send change request'}
                </button>
                <button
                  type="button"
                  onClick={() => { setAsking(false); setError(''); }}
                  className="text-xs font-medium text-gray-600 hover:text-gray-900 px-2 py-1.5"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => respond('approved')}
                className="text-xs font-medium text-white bg-green-600 hover:bg-green-700 disabled:opacity-50 rounded-lg px-3 py-1.5"
              >
                {busy ? 'Sending…' : 'Approve quote'}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setAsking(true)}
                className="text-xs font-medium text-gray-700 border border-gray-300 hover:bg-gray-50 disabled:opacity-50 rounded-lg px-3 py-1.5"
              >
                Request changes
              </button>
            </div>
          )}
          {error && <div className="text-xs text-red-600 mt-1">{error}</div>}
        </div>
      )}
    </div>
  );
}

const CASE_STATUS_CHIP = {
  open: 'bg-blue-50 text-blue-700 border-blue-200',
  pending: 'bg-amber-50 text-amber-700 border-amber-200',
  resolved: 'bg-green-50 text-green-700 border-green-200',
  closed: 'bg-gray-100 text-gray-600 border-gray-200',
};

function SupportSection({ token, cases, onSubmitted }) {
  const [open, setOpen] = useState(false);
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [priority, setPriority] = useState('normal');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [thanks, setThanks] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!subject.trim() || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      const res = await api.post(`/public/portal/${encodeURIComponent(token)}/cases`, {
        subject, message, priority,
      });
      // Echo the new case into the list optimistically — the server returns
      // only { case_id }; status/priority are known-fixed at submit time.
      onSubmitted({
        id: res.data.case_id,
        subject: subject.trim(),
        status: 'open',
        priority,
        created_at: new Date().toISOString(),
      });
      setSubject(''); setMessage(''); setPriority('normal');
      setOpen(false); setThanks(true);
    } catch (err) {
      const status = err?.response?.status;
      if (status === 429) setError('Too many submissions — please try again in a few minutes.');
      else setError(err?.response?.data?.error || 'Something went wrong — please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-gray-900">Support</h2>
        {!open && (
          <button
            type="button"
            onClick={() => { setOpen(true); setThanks(false); }}
            className="text-sm font-medium text-white bg-brand-blue hover:bg-brand-blue-dark rounded-lg px-3 py-1.5"
          >
            New support request
          </button>
        )}
      </div>

      {thanks && (
        <div className="mb-3 bg-green-50 border border-green-200 text-green-800 text-sm rounded-lg px-4 py-3">
          Thanks — your request is in. Your account team has been notified and
          you can track its status below.
        </div>
      )}

      {open && (
        <form onSubmit={submit} className="bg-white border border-gray-200 rounded-lg p-4 mb-3 space-y-3">
          <div>
            <label htmlFor="portal-case-subject" className="block text-xs font-semibold text-gray-600 mb-1">
              What do you need help with?
            </label>
            <input
              id="portal-case-subject"
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              maxLength={200}
              required
              placeholder="Brief summary — e.g. “Question about our latest invoice”"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-blue/40"
            />
          </div>
          <div>
            <label htmlFor="portal-case-message" className="block text-xs font-semibold text-gray-600 mb-1">
              Details <span className="font-normal text-gray-400">(optional)</span>
            </label>
            <textarea
              id="portal-case-message"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              maxLength={5000}
              rows={4}
              placeholder="Anything that helps us help you faster."
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-blue/40"
            />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <label htmlFor="portal-case-priority" className="text-xs font-semibold text-gray-600">Priority</label>
              <select
                id="portal-case-priority"
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
                className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm"
              >
                <option value="low">Low</option>
                <option value="normal">Normal</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </select>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => { setOpen(false); setError(''); }}
                className="text-sm font-medium text-gray-600 hover:text-gray-900 px-3 py-1.5"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={submitting || !subject.trim()}
                className="text-sm font-medium text-white bg-brand-blue hover:bg-brand-blue-dark disabled:opacity-50 rounded-lg px-4 py-1.5"
              >
                {submitting ? 'Sending…' : 'Send request'}
              </button>
            </div>
          </div>
          {error && <div className="text-sm text-red-600">{error}</div>}
        </form>
      )}

      {cases.length === 0 ? (
        !open && !thanks && <Empty>No support requests yet. Need a hand? Open one any time.</Empty>
      ) : (
        <div className="bg-white border border-gray-200 rounded-lg divide-y divide-gray-100">
          {cases.map((c) => (
            <div key={c.id} className="px-4 py-3 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-medium text-gray-900 break-words">{c.subject}</div>
                <div className="text-xs text-gray-500 mt-0.5">
                  opened {fmtDate(c.created_at)}
                  {c.priority && c.priority !== 'normal' && <> · <span className="capitalize">{c.priority}</span> priority</>}
                </div>
              </div>
              <span className={`${STATUS_CHIP} flex-shrink-0 ${CASE_STATUS_CHIP[c.status] || CASE_STATUS_CHIP.open}`}>
                {c.status}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// Portal v5 (migration 151): send a file to the account team. The server
// enforces the real rules (10MB, type allowlist, per-company quota); the
// accept attribute is just a convenience filter.
const UPLOAD_ACCEPT = '.pdf,.png,.jpg,.jpeg,.gif,.webp,.txt,.csv,.doc,.docx,.xls,.xlsx,.ppt,.pptx';

function UploadButton({ token, onUploaded }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const pick = (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = ''; // allow re-selecting the same file
    if (!file || busy) return;
    setBusy(true);
    setError('');
    const form = new FormData();
    form.append('file', file);
    api.post(`/public/portal/${encodeURIComponent(token)}/documents`, form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })
      .then((res) => onUploaded(res.data))
      .catch((err) => {
        const status = err?.response?.status;
        if (status === 429) setError('Too many uploads — please try again in a few minutes.');
        else setError(err?.response?.data?.error || 'Upload failed — please try again.');
      })
      .finally(() => setBusy(false));
  };

  return (
    <div className="text-right">
      <label className={`inline-block text-sm font-medium text-white rounded-lg px-3 py-1.5 cursor-pointer ${busy ? 'bg-gray-400' : 'bg-brand-blue hover:bg-brand-blue-dark'}`}>
        {busy ? 'Uploading…' : 'Upload a file'}
        <input type="file" accept={UPLOAD_ACCEPT} className="hidden" onChange={pick} disabled={busy} />
      </label>
      {error && <div className="text-xs text-red-600 mt-1">{error}</div>}
    </div>
  );
}

function fmtDateTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}

// The running message thread with the account team (portal v4, migration
// 150). Customer bubbles right, team bubbles left with the member's name.
function MessagesSection({ token, messages, onSent }) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');

  const send = async (e) => {
    e.preventDefault();
    if (!draft.trim() || sending) return;
    setSending(true);
    setError('');
    try {
      const res = await api.post(`/public/portal/${encodeURIComponent(token)}/messages`, { body: draft });
      onSent(res.data);
      setDraft('');
    } catch (err) {
      const status = err?.response?.status;
      if (status === 429) setError('Too many messages — please try again in a few minutes.');
      else setError(err?.response?.data?.error || 'Something went wrong — please try again.');
    } finally {
      setSending(false);
    }
  };

  return (
    <section>
      <h2 className="text-sm font-semibold text-gray-900 mb-3">Messages</h2>
      <div className="bg-white border border-gray-200 rounded-lg">
        {messages.length === 0 ? (
          <div className="p-6 text-center text-sm text-gray-500">
            No messages yet — say hello to your account team below.
          </div>
        ) : (
          <div className="p-4 space-y-3 max-h-96 overflow-y-auto">
            {messages.map((m) => (
              <div key={m.id} className={`flex ${m.author_type === 'customer' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[85%] rounded-2xl px-3.5 py-2 text-sm ${m.author_type === 'customer'
                  ? 'bg-brand-blue text-white rounded-br-sm'
                  : 'bg-gray-100 text-gray-900 rounded-bl-sm'}`}>
                  {m.author_type === 'team' && (
                    <div className="text-[11px] font-semibold text-gray-500 mb-0.5">{m.author_name || 'Account team'}</div>
                  )}
                  <div className="whitespace-pre-wrap break-words">{m.body}</div>
                  <div className={`text-[10px] mt-1 ${m.author_type === 'customer' ? 'text-white/70' : 'text-gray-400'}`}>
                    {fmtDateTime(m.created_at)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
        <form onSubmit={send} className="border-t border-gray-200 p-3 flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={3000}
            rows={2}
            placeholder="Write a message to your account team…"
            className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-blue/40 resize-none"
          />
          <button
            type="submit"
            disabled={sending || !draft.trim()}
            className="text-sm font-medium text-white bg-brand-blue hover:bg-brand-blue-dark disabled:opacity-50 rounded-lg px-4 py-2"
          >
            {sending ? 'Sending…' : 'Send'}
          </button>
        </form>
        {error && <div className="px-3 pb-3 text-sm text-red-600">{error}</div>}
      </div>
    </section>
  );
}

function Stat({ label, value }) {
  return (
    <div className="bg-gray-50 rounded-lg border border-gray-100 px-3 py-3">
      <div className="text-xs uppercase tracking-wider text-gray-500 font-semibold">{label}</div>
      <div className="text-xl font-bold mt-1 text-gray-900">{value}</div>
    </div>
  );
}

function Empty({ children }) {
  return (
    <div className="bg-white border border-gray-200 rounded-lg p-8 text-center text-sm text-gray-500">
      {children}
    </div>
  );
}
