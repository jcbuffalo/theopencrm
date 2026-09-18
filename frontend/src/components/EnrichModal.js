// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import React, { useEffect, useState } from 'react';
import api from '../api';
import { Alert, Button, Modal, Spinner } from './ui';

// Human labels for the stable enrichment field shape the backend returns.
const FIELD_LABELS = {
  title: 'Title',
  company: 'Company',
  linkedin: 'LinkedIn',
  location: 'Location',
  industry: 'Industry',
  employee_count: 'Employees',
  website: 'Website',
  description: 'Description',
};

function labelFor(key) {
  return FIELD_LABELS[key] || key.replace(/_/g, ' ');
}

// Shared enrichment proposal modal for the Contacts + Companies lists.
//
// Flow: on open it POSTs /{entity}/{id}/enrich to fetch a PROPOSAL (never a
// write). Three terminal states:
//   • configured:false  → graceful "enrichment not configured" panel
//   • 403 FEATURE_DISABLED → "not enabled for this org" panel
//   • configured:true   → a checklist of returned fields the user can accept
//                         and Apply into the record's custom_fields.
export default function EnrichModal({ open, entity, record, recordLabel, onClose, onApplied }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notConfigured, setNotConfigured] = useState(false);
  const [message, setMessage] = useState('');
  const [fields, setFields] = useState({});
  const [selected, setSelected] = useState({});
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState(false);

  useEffect(() => {
    if (!open || !record) return undefined;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError('');
      setNotConfigured(false);
      setMessage('');
      setFields({});
      setSelected({});
      setApplied(false);
      try {
        const res = await api.post(`/${entity}/${record.id}/enrich`);
        if (cancelled) return;
        if (res.data.configured === false) {
          setNotConfigured(true);
          setMessage(res.data.message || 'Enrichment is not configured.');
        } else {
          const f = res.data.fields || {};
          setFields(f);
          setMessage(res.data.message || '');
          const sel = {};
          Object.entries(f).forEach(([k, v]) => {
            if (v !== null && v !== undefined && v !== '') sel[k] = true;
          });
          setSelected(sel);
        }
      } catch (err) {
        if (cancelled) return;
        if (err.response?.status === 403) {
          setNotConfigured(true);
          setMessage('Enrichment is not enabled for this organization. Ask an admin to turn on the enrichment module.');
        } else {
          setError(err.response?.data?.error || 'Failed to enrich');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open, entity, record]);

  if (!open) return null;

  const nonEmpty = Object.entries(fields).filter(
    ([, v]) => v !== null && v !== undefined && v !== ''
  );
  const anySelected = nonEmpty.some(([k]) => selected[k]);

  const toggle = (k) => setSelected((prev) => ({ ...prev, [k]: !prev[k] }));

  const apply = async () => {
    const toApply = {};
    nonEmpty.forEach(([k, v]) => { if (selected[k]) toApply[k] = v; });
    if (Object.keys(toApply).length === 0) return;
    setApplying(true);
    setError('');
    try {
      await api.post(`/${entity}/${record.id}/enrich/apply`, { fields: toApply });
      setApplied(true);
      if (onApplied) onApplied();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to apply');
    } finally {
      setApplying(false);
    }
  };

  const canApply = !loading && !notConfigured && !error && nonEmpty.length > 0 && !applied;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Enrich${recordLabel ? `: ${recordLabel}` : ''}`}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {applied ? 'Done' : 'Cancel'}
          </Button>
          {canApply && (
            <Button variant="primary" onClick={apply} disabled={!anySelected} loading={applying} loadingLabel="Applying…">
              Apply selected
            </Button>
          )}
        </>
      }
    >
      {loading && <Spinner label="Looking up enrichment data…" className="py-4" />}

      {!loading && error && <Alert tone="danger">{error}</Alert>}

      {!loading && notConfigured && (
        <Alert tone="warning" icon="lock" title="Enrichment not configured">{message}</Alert>
      )}

      {!loading && !notConfigured && !error && (
        <div className="space-y-3">
          {applied && <Alert tone="success">Enrichment applied to this record.</Alert>}

          {nonEmpty.length === 0 ? (
            <p className="text-sm text-gray-600 py-2">
              {message || 'No enrichment fields were returned.'}
            </p>
          ) : (
            <>
              <p className="text-xs text-gray-500">
                Review the proposed fields and apply the ones you want. Accepted values are
                stored on the record and never overwrite your existing fields.
              </p>
              <ul className="space-y-2">
                {nonEmpty.map(([k, v]) => (
                  <li key={k} className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      id={`enrich-${k}`}
                      checked={!!selected[k]}
                      onChange={() => toggle(k)}
                      disabled={applied}
                      className="mt-1 h-4 w-4 rounded border-gray-300 text-brand-blue focus:ring-brand-blue"
                    />
                    <label htmlFor={`enrich-${k}`} className="text-sm">
                      <span className="font-medium text-gray-700">{labelFor(k)}: </span>
                      <span className="text-gray-900 break-words">{String(v)}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}
