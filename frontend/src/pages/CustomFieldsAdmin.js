// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Admin page for Claude-authored org customizations (Differentiation Bet #2).
//
// /admin/customizations — owners/admins describe a desired change in plain
// English; Claude returns a structured proposal; the human reviews and
// approves; the backend re-validates and applies in a transaction.
//
// The "human is the gate" loop is the entire point — we never let a Claude
// proposal write to the schema without an explicit click from the admin.

import React, { useEffect, useState } from 'react';
import api from '../api';
import Nav from '../components/Nav';
import DataTable from '../components/DataTable';
import { useAuth } from '../AuthContext';
import { Alert, Button, Card, Container, Input, PageHeader, Select, StatusBadge, Tabs, Textarea } from '../components/ui';

const ENTITIES = [
  { key: 'companies', label: 'Companies' },
  { key: 'contacts',  label: 'Contacts'  },
  { key: 'deals',     label: 'Deals'     },
  { key: 'tasks',     label: 'Tasks'     },
];

// Mirrors backend/schemas/customFields.js VALID_TYPES + NAME_RE.
const FIELD_TYPES = [
  { value: 'text',        label: 'Text' },
  { value: 'number',      label: 'Number' },
  { value: 'date',        label: 'Date' },
  { value: 'select',      label: 'Dropdown (pick one)' },
  { value: 'multiselect', label: 'Multi-select (pick many)' },
  { value: 'boolean',     label: 'Yes / no' },
];
const NAME_RE = /^[a-z][a-z0-9_]{1,59}$/;

const ACTION_TONE = { add_field: 'success', modify_field: 'warning' };

function slugify(label) {
  return String(label || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^[^a-z]+/, '')
    .slice(0, 60);
}

export default function CustomFieldsAdmin() {
  const { aiEnabled } = useAuth();
  const [entity, setEntity]       = useState('companies');
  const [defs, setDefs]           = useState([]);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState('');
  // The "propose customization" flow is the only AI-dependent thing on this
  // page — the existing-fields table and delete still work without Claude.
  // When unconfigured we keep the rest of the page usable and just disable
  // the Propose button.
  const aiUnavailable = aiEnabled === false;

  // AI proposal state machine.
  //   request    — the plaintext prompt the admin typed
  //   proposing  — true while POST /propose-customization is in flight
  //   proposal   — last successful response from /propose-customization
  //   applyError — backend-side validation failure on /apply
  const [request, setRequest]   = useState('');
  const [proposing, setProposing] = useState(false);
  const [proposal, setProposal] = useState(null);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState('');

  // Manual "Add field" form — works with no AI at all (unconfigured key or
  // unbilled org). Posts straight to POST /api/custom-fields, the same route
  // the AI apply path ends up calling. Shape mirrors schemas/customFields.js.
  const [manual, setManual] = useState({ label: '', name: '', type: 'text', options: '', required: false });
  const [manualBusy, setManualBusy] = useState(false);
  const [manualError, setManualError] = useState('');
  const [manualOk, setManualOk] = useState('');
  const [nameTouched, setNameTouched] = useState(false);

  useEffect(() => { loadDefs(); }, [entity]);

  const loadDefs = async () => {
    setLoading(true); setError('');
    try {
      const r = await api.get('/custom-fields', { params: { entity } });
      setDefs(Array.isArray(r.data) ? r.data : []);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load custom fields');
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (id) => {
    if (!window.confirm('Delete this field? Existing data in this field stays in the database (orphaned) but the UI will stop showing it.')) return;
    try {
      await api.delete(`/custom-fields/${id}`);
      loadDefs();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to delete field');
    }
  };

  const handlePropose = async () => {
    if (!request.trim()) return;
    setProposing(true); setProposal(null); setApplyError('');
    try {
      const r = await api.post('/ai/propose-customization', { entity, request: request.trim() });
      setProposal(r.data);
    } catch (err) {
      setApplyError(err.response?.data?.error || 'Proposal failed');
    } finally {
      setProposing(false);
    }
  };

  const handleApprove = async () => {
    if (!proposal?.proposal?.actions?.length) return;
    setApplying(true); setApplyError('');
    try {
      await api.post('/ai/apply-customization', {
        actions: proposal.proposal.actions,
        request: proposal.request,
      });
      setProposal(null);
      setRequest('');
      loadDefs();
    } catch (err) {
      setApplyError(err.response?.data?.error || 'Apply failed');
    } finally {
      setApplying(false);
    }
  };

  // Derive a snake_case key from the label until the user edits the key
  // themselves (e.g. "Commission tier" → commission_tier).
  const setManualLabel = (label) => {
    setManual(m => ({
      ...m,
      label,
      name: nameTouched ? m.name : slugify(label),
    }));
  };
  const setManualName = (name) => {
    setNameTouched(true);
    setManual(m => ({ ...m, name: name.toLowerCase().replace(/[^a-z0-9_]/g, '_') }));
  };
  const needsOptions = manual.type === 'select' || manual.type === 'multiselect';

  const handleManualAdd = async (e) => {
    e.preventDefault();
    setManualError(''); setManualOk('');
    const name = manual.name.trim();
    const label = manual.label.trim();
    if (!label) { setManualError('Give the field a label.'); return; }
    if (!NAME_RE.test(name)) {
      setManualError('Key must be lowercase snake_case, start with a letter, 2-60 characters (e.g. commission_tier).');
      return;
    }
    const options = needsOptions
      ? manual.options.split(/\r?\n|,/).map(s => s.trim()).filter(Boolean)
      : [];
    if (needsOptions && options.length === 0) { setManualError('Add at least one option (one per line).'); return; }
    setManualBusy(true);
    try {
      await api.post('/custom-fields', {
        entity,
        name,
        label,
        type: manual.type,
        options,
        required: !!manual.required,
      });
      setManualOk(`Added "${label}" to ${entity}.`);
      setManual({ label: '', name: '', type: 'text', options: '', required: false });
      setNameTouched(false);
      loadDefs();
    } catch (err) {
      setManualError(err.response?.data?.error || 'Failed to add field');
    } finally {
      setManualBusy(false);
    }
  };

  const entityLabel = ENTITIES.find(e => e.key === entity)?.label || entity;

  const columns = [
    { key: 'name', label: 'Name', render: (d) => <span className="font-mono text-xs">{d.name}</span> },
    { key: 'label', label: 'Label' },
    { key: 'type', label: 'Type' },
    {
      key: 'options',
      label: 'Options',
      className: 'text-xs text-gray-500',
      render: (d) => (Array.isArray(d.options) && d.options.length > 0 ? d.options.join(', ') : '—'),
    },
    { key: 'required', label: 'Required', render: (d) => (d.required ? 'yes' : 'no') },
  ];

  return (
    <div className="min-h-screen bg-gray-50">
      <Nav active="admin" />
      <Container>
        <PageHeader
          title="Custom fields"
          subtitle="Add the fields your business actually tracks. Fill in the form, or describe the change in plain English and let Claude propose it for you to approve. Changes apply ONLY to your organization — they never alter the shared schema."
        />

        <div className="space-y-6">
          <Tabs
            aria-label="Entity"
            items={ENTITIES.map(e => ({ id: e.key, label: e.label }))}
            value={entity}
            onChange={(key) => { setEntity(key); setProposal(null); setRequest(''); setApplyError(''); }}
          />

          {/* Manual add form — no AI required */}
          <Card
            as="form"
            onSubmit={handleManualAdd}
            title={`Add a field to ${entityLabel}`}
            actions={<span className="text-xs text-gray-500">No AI needed</span>}
          >
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              <Input
                label="Label"
                value={manual.label}
                onChange={e => setManualLabel(e.target.value)}
                maxLength={120}
                placeholder="e.g. Commission tier"
              />
              <Input
                label="Key"
                value={manual.name}
                onChange={e => setManualName(e.target.value)}
                maxLength={60}
                placeholder="commission_tier"
                className="font-mono"
              />
              <Select
                label="Type"
                value={manual.type}
                onChange={e => setManual(m => ({ ...m, type: e.target.value }))}
                options={FIELD_TYPES}
              />
              <label className="flex items-end gap-2 pb-2.5">
                <input
                  type="checkbox"
                  checked={manual.required}
                  onChange={e => setManual(m => ({ ...m, required: e.target.checked }))}
                  className="h-4 w-4 rounded border-gray-300 text-brand-blue focus:ring-brand-blue"
                />
                <span className="text-sm text-gray-700">Required</span>
              </label>
            </div>
            {needsOptions && (
              <Textarea
                wrapperClassName="mt-3"
                label="Options (one per line)"
                value={manual.options}
                onChange={e => setManual(m => ({ ...m, options: e.target.value }))}
                rows={3}
                placeholder={'T1\nT2\nT3'}
              />
            )}
            <div className="flex items-center justify-between gap-4 mt-4">
              <div className="text-xs">
                {manualError && <span className="text-danger-600">{manualError}</span>}
                {manualOk && <span className="text-success-700">{manualOk}</span>}
                {!manualError && !manualOk && <span className="text-gray-500">The key is how the field is stored and referenced in reports and the API.</span>}
              </div>
              <Button type="submit" loading={manualBusy} loadingLabel="Adding…">Add field</Button>
            </div>
          </Card>

          {aiUnavailable && (
            <Alert tone="warning" title="AI proposal is unavailable — Claude isn't configured on this deployment.">
              The form above and the existing-fields table below work without it. To re-enable the Claude-authored proposal flow,
              ask your operator to set <code className="bg-warning-100 px-1 py-0.5 rounded font-mono">ANTHROPIC_API_KEY</code> on the backend.
            </Alert>
          )}

          {/* AI prompt box */}
          <Card className={aiUnavailable ? 'opacity-60' : ''}>
            <Textarea
              label="Or describe the change you want and let Claude propose it"
              value={request}
              onChange={(e) => setRequest(e.target.value)}
              disabled={aiUnavailable}
              placeholder={`e.g. "Add a commission tier field on ${entity} with three options: T1, T2, T3."`}
              rows={3}
            />
            <div className="flex justify-between items-center gap-4 mt-3">
              <p className="text-xs text-gray-500">
                Claude will reply with a proposal you can approve, edit, or reject. Nothing is applied until you click Approve.
              </p>
              <Button
                icon="sparkles"
                onClick={handlePropose}
                disabled={aiUnavailable || !request.trim()}
                loading={proposing}
                loadingLabel="Asking Claude…"
              >
                {aiUnavailable ? 'AI not configured' : 'Propose change'}
              </Button>
            </div>
            {applyError && <Alert tone="danger" className="mt-3" onDismiss={() => setApplyError('')}>{applyError}</Alert>}
          </Card>

          {/* Proposal review card */}
          {proposal && (
            <Card
              className="border-warning-300"
              title="Claude's proposal"
              subtitle="Review carefully before applying."
              actions={
                <>
                  <Button variant="secondary" size="sm" onClick={() => setProposal(null)}>Reject</Button>
                  <Button
                    size="sm"
                    icon="check"
                    onClick={handleApprove}
                    disabled={(proposal.proposal?.actions?.length || 0) === 0}
                    loading={applying}
                    loadingLabel="Applying…"
                  >
                    Approve &amp; apply
                  </Button>
                </>
              }
            >
              <div className="space-y-3">
                {proposal.proposal?.rejectedReason && (
                  <Alert tone="warning">Claude declined to propose changes: {proposal.proposal.rejectedReason}</Alert>
                )}

                {proposal.validationErrors?.length > 0 && (
                  <Alert tone="danger" title="The following parts of the proposal were rejected by server-side validation:">
                    <ul className="list-disc ml-4 text-xs">
                      {proposal.validationErrors.map((e, i) => <li key={i}>{e}</li>)}
                    </ul>
                  </Alert>
                )}

                {(proposal.proposal?.actions || []).length === 0 ? (
                  <div className="text-sm text-gray-500 italic">No applicable actions in this proposal.</div>
                ) : (
                  <ul className="space-y-2">
                    {proposal.proposal.actions.map((a, i) => (
                      <li key={i} className="border border-gray-200 rounded p-3 bg-gray-50">
                        <div className="flex items-center gap-2 mb-1">
                          <StatusBadge tone={ACTION_TONE[a.kind] || 'error'} label={<span className="uppercase">{a.kind}</span>} />
                          <code className="text-sm font-semibold text-gray-900">{a.entity}.{a.name}</code>
                        </div>
                        <div className="text-xs text-gray-600 space-y-0.5">
                          {a.label && <div><span className="font-medium">label:</span> {a.label}</div>}
                          {a.type && <div><span className="font-medium">type:</span> {a.type}</div>}
                          {Array.isArray(a.options) && a.options.length > 0 && (
                            <div><span className="font-medium">options:</span> {a.options.join(', ')}</div>
                          )}
                          {a.required != null && <div><span className="font-medium">required:</span> {String(a.required)}</div>}
                          {a.rationale && <div className="italic text-gray-500 mt-1">"{a.rationale}"</div>}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </Card>
          )}

          {/* Existing fields table */}
          <Card title={`Existing custom fields on ${entity}`} padding="none">
            {error && <Alert tone="danger" className="m-4" onDismiss={() => setError('')}>{error}</Alert>}
            <DataTable
              flush
              columns={columns}
              data={defs}
              loading={loading}
              onDelete={handleDelete}
              emptyState={{ icon: 'settings', title: 'No custom fields yet', message: 'Use the form above to add one.' }}
            />
          </Card>
        </div>
      </Container>
    </div>
  );
}
