// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Data hooks for the deal drawer. Every network call the drawer makes at the
// deal level lives here; the sub-record panels (quotes, RFQs, line items…)
// own their own list fetches because they're mounted lazily.

import { useCallback, useEffect, useState } from 'react';
import api from '../../api';
import { useAuth } from '../../AuthContext';

// Per-org module flags from /auth/me. A null map (older sessions, personal
// workspaces) means "everything on"; only an explicit `false` hides a panel.
export function flagOn(orgFeatures, name) {
  if (!orgFeatures || typeof orgFeatures !== 'object') return true;
  if (!Object.prototype.hasOwnProperty.call(orgFeatures, name)) return true;
  return orgFeatures[name] !== false;
}

export function useFeatureFlag() {
  const { orgFeatures } = useAuth();
  return useCallback((name) => flagOn(orgFeatures, name), [orgFeatures]);
}

// GET /deals/:id + the partial-update / refresh helpers the hero uses.
export function useDeal(dealId, onChanged) {
  const [deal, setDeal] = useState(null);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    let alive = true;
    setLoadError('');
    api.get(`/deals/${dealId}`)
      .then((r) => { if (alive) setDeal(r.data); })
      .catch((err) => {
        if (alive) setLoadError(err.response?.data?.error || 'Couldn\'t load this deal.');
      });
    return () => { alive = false; };
  }, [dealId]);

  // Re-pull the deal after a server-side derivation (line items re-derive
  // deals.amount inside the same transaction) so the hero refreshes.
  const refreshDeal = useCallback(async () => {
    try {
      const r = await api.get(`/deals/${dealId}`);
      setDeal(r.data);
    } catch { /* best-effort — the list view still refreshes via onChanged */ }
    onChanged?.();
  }, [dealId, onChanged]);

  // Partial PUT (stage / title from the hero). The backend COALESCEs every
  // column, so a one-field body is safe. Rejects propagate to the caller.
  const patchDeal = useCallback(async (patch) => {
    const r = await api.put(`/deals/${dealId}`, patch);
    setDeal(r.data);
    onChanged?.();
    return r.data;
  }, [dealId, onChanged]);

  return { deal, setDeal, loadError, refreshDeal, patchDeal };
}

// Record ownership (migration 135): org members feed the owner picker.
// Personal workspaces (or a failed fetch) get an empty list.
export function useOrgMembers() {
  const [members, setMembers] = useState([]);
  useEffect(() => {
    api.get('/org')
      .then((r) => setMembers(r.data?.members || []))
      .catch(() => setMembers([]));
  }, []);
  return members;
}

// Resolve the deal's primary contact — needed for the composer's "To:", the
// SMS default number and the calendar default attendee.
export function usePrimaryContact(contactId) {
  const [contact, setContact] = useState(null);
  useEffect(() => {
    if (!contactId) { setContact(null); return undefined; }
    let alive = true;
    api.get(`/contacts/${contactId}`)
      .then((r) => { if (alive) setContact(r.data); })
      .catch(() => { if (alive) setContact(null); });
    return () => { alive = false; };
  }, [contactId]);
  return contact;
}

const EMPTY_SUMMARY = {
  quotes: { count: 0, latest: null },
  submittals: { count: 0, latest: null, pending: 0 },
  changeOrders: { count: 0, latest: null, pending: 0 },
  issues: { count: 0, open: 0, red: 0, blocking: 0, latest: null },
  vendorQuotes: { count: 0, selected: null, received: 0 },
  documents: { count: 0, latest: null },
};

// "At a glance" counts for the sub-workflows attached to a deal. Modules
// whose flag is off are skipped (no 403 round-trip) and read as empty.
export function useDealSummary(dealId, { advanced, flag }) {
  const [data, setData] = useState(EMPTY_SUMMARY);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    const maybe = (on, url) => (on ? api.get(url).catch(() => ({ data: [] })) : Promise.resolve({ data: [] }));
    Promise.all([
      maybe(flag('quotes_enabled'), `/quotes?deal_id=${dealId}`),
      maybe(advanced && flag('submittals_enabled'), `/submittals?deal_id=${dealId}`),
      maybe(advanced && flag('change_orders_enabled'), `/change-orders?deal_id=${dealId}`),
      maybe(true, `/issues?related_type=deal&related_id=${dealId}`),
      maybe(advanced && flag('vendor_quotes_enabled'), `/vendor-quotes?deal_id=${dealId}`),
      maybe(flag('documents_enabled'), `/documents?related_type=deal&related_id=${dealId}`),
    ]).then(([q, s, co, iss, vq, docs]) => {
      if (!alive) return;
      const quotes = Array.isArray(q.data) ? q.data : [];
      const issues = Array.isArray(iss.data) ? iss.data : [];
      const submittals = Array.isArray(s.data) ? s.data : [];
      const changeOrders = Array.isArray(co.data) ? co.data : [];
      const vendorQuotes = Array.isArray(vq.data) ? vq.data : [];
      const documents = Array.isArray(docs.data) ? docs.data : [];
      const URGENCY_RANK = { red: 3, yellow: 2, green: 1 };
      const openIssues = issues.filter((i) => i.status !== 'resolved');
      const mostUrgentIssue = openIssues
        .slice()
        .sort((a, b) => (URGENCY_RANK[b.urgency] || 0) - (URGENCY_RANK[a.urgency] || 0))[0]
        || issues[0] || null;
      setData({
        quotes: { count: quotes.length, latest: quotes[0] || null },
        submittals: {
          count: submittals.length,
          latest: submittals[0] || null,
          pending: submittals.filter((x) => x.status?.startsWith('pending')).length,
        },
        changeOrders: {
          count: changeOrders.length,
          latest: changeOrders[0] || null,
          pending: changeOrders.filter((x) => x.status === 'pending').length,
        },
        issues: {
          count: issues.length,
          open: openIssues.length,
          red: openIssues.filter((i) => i.urgency === 'red').length,
          blocking: openIssues.filter((i) => i.blocks_workflow).length,
          latest: mostUrgentIssue,
        },
        vendorQuotes: {
          count: vendorQuotes.length,
          selected: vendorQuotes.find((v) => v.is_selected) || null,
          received: vendorQuotes.filter((v) => v.status === 'received').length,
        },
        documents: { count: documents.length, latest: documents[0] || null },
      });
    }).finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [dealId, advanced, flag]);

  return { data, loading };
}

// Which intel panels have self-hidden (feature flag off at the API) — we
// drop their whole Section so no empty accordion header shows.
export function useHiddenIntel() {
  const [hiddenIntel, setHiddenIntel] = useState({});
  const hideIntel = useCallback((key) => {
    setHiddenIntel((prev) => (prev[key] ? prev : { ...prev, [key]: true }));
  }, []);
  return { hiddenIntel, hideIntel };
}
