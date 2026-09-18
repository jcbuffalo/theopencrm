// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import React, { useState, useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import Nav from '../components/Nav';
import api from '../api';
import { Alert, Button, Card, Container, Icon, PageHeader, Select, Spinner } from '../components/ui';

const ENTITY_FIELDS = {
  contacts: [
    { key: 'first_name',   label: 'First Name',     required: true  },
    { key: 'last_name',    label: 'Last Name',       required: true  },
    { key: 'email',        label: 'Email',           required: false },
    { key: 'phone',        label: 'Phone',           required: false },
    { key: 'job_title',    label: 'Job Title',       required: false },
    { key: 'company_name', label: 'Company Name',    required: false },
    { key: 'owner_email',  label: 'Owner (email)',   required: false },
    { key: 'notes',        label: 'Notes',           required: false },
    { key: 'status',       label: 'Status',          required: false },
  ],
  companies: [
    { key: 'name',           label: 'Company Name',   required: true  },
    { key: 'industry',       label: 'Industry',       required: false },
    { key: 'website',        label: 'Website',        required: false },
    { key: 'location',       label: 'Location',       required: false },
    { key: 'employee_count', label: 'Employee Count', required: false },
    { key: 'annual_revenue', label: 'Annual Revenue', required: false },
    { key: 'notes',          label: 'Notes',          required: false },
  ],
  deals: [
    { key: 'title',               label: 'Deal Title',    required: true  },
    { key: 'company_name',        label: 'Company Name',  required: false },
    { key: 'stage',               label: 'Stage',         required: false },
    { key: 'deal_type',           label: 'Pipeline / Deal Type', required: false },
    { key: 'amount',              label: 'Value / Amount', required: false },
    { key: 'expected_close_date', label: 'Expected Close', required: false },
    { key: 'owner_email',         label: 'Owner (email)', required: false },
    { key: 'notes',               label: 'Notes',         required: false },
  ],
};

// Synonym table for fields exported by HubSpot, Salesforce, Pipedrive, and
// generic spreadsheets. Keys match our internal CRM fields; values are the
// corresponding header strings other systems use. Used by autoDetect to
// pre-fill the column mapping so the user doesn't have to do it manually.
// (When a platform preset is picked, the server's preset — fetched from
// GET /api/import/presets — takes precedence; this stays the generic net.)
const FIELD_SYNONYMS = {
  contacts: {
    first_name:   ['First Name', 'first', 'fname', 'given name', 'givenname'],
    last_name:    ['Last Name', 'last', 'lname', 'surname', 'family name'],
    email:        ['Email', 'Email Address', 'work email', 'primary email', 'email1'],
    phone:        ['Phone Number', 'Phone', 'mobile', 'mobile phone', 'work phone', 'phone1'],
    job_title:    ['Job Title', 'Title', 'position', 'role'],
    company_name: ['Associated Company', 'Company name', 'Company', 'organisation', 'organization', 'account'],
    owner_email:  ['Owner Email', 'Contact Owner Email'],
    notes:        ['Notes', 'Description', 'comments'],
    status:       ['Lifecycle Stage', 'Lead Status', 'status', 'stage'],
  },
  companies: {
    name:           ['Company name', 'Account Name', 'Name', 'organisation', 'organization'],
    industry:       ['Industry', 'sector', 'vertical'],
    website:        ['Website URL', 'Website', 'domain', 'url'],
    location:       ['Address', 'City', 'address1', 'street'],
    employee_count: ['Number of Employees', 'Employees', 'headcount', 'employee count'],
    annual_revenue: ['Annual Revenue', 'Revenue', 'turnover'],
    notes:          ['Notes', 'Description'],
  },
  deals: {
    title:               ['Deal Name', 'Deal', 'Opportunity Name', 'Opportunity', 'Name', 'title'],
    company_name:        ['Company', 'Company name', 'Account Name', 'Associated Company', 'organisation', 'organization', 'account'],
    stage:               ['Deal Stage', 'Stage', 'Pipeline Stage', 'status'],
    deal_type:           ['Deal Type', 'Record Type'],
    amount:              ['Amount', 'Value', 'Deal Value', 'Deal Amount', 'Total'],
    expected_close_date: ['Close Date', 'Expected Close Date', 'Expected Close', 'Closing Date'],
    owner_email:         ['Owner Email', 'Deal Owner Email', 'Opportunity Owner Email'],
    notes:               ['Notes', 'Description', 'comments'],
  },
};

const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

function autoDetect(headers, entityType) {
  const mapping = {};
  const synonyms = FIELD_SYNONYMS[entityType] || {};

  for (const field of ENTITY_FIELDS[entityType]) {
    // Build the full candidate list: field key, label, and any synonyms.
    const candidates = new Set([
      norm(field.key),
      norm(field.label),
      ...((synonyms[field.key] || []).map(norm)),
    ]);
    for (const h of headers) {
      if (candidates.has(norm(h))) {
        mapping[field.key] = h;
        break;
      }
    }
  }
  return mapping;
}

// Mirror of the server-side importPresets.buildMapping: tolerant match of the
// preset descriptor's per-field header variants against the CSV headers.
function applyPresetMapping(presetDescriptor, entityType, headers) {
  const def = presetDescriptor?.entities?.[entityType];
  if (!def) return { mapping: {}, matched: [], unmatched: [] };
  const headerByNorm = new Map();
  for (const h of headers) {
    const n = norm(h);
    if (n && !headerByNorm.has(n)) headerByNorm.set(n, h);
  }
  const mapping = {};
  const matched = [];
  const unmatched = [];
  const claimed = new Set();
  for (const [field, variants] of Object.entries(def.fields)) {
    let hit = null;
    for (const v of variants) {
      const h = headerByNorm.get(norm(v));
      if (h !== undefined && !claimed.has(h)) { hit = h; break; }
    }
    if (hit !== null) { mapping[field] = hit; matched.push(field); claimed.add(hit); }
    else unmatched.push(field);
  }
  return { mapping, matched, unmatched };
}

const STEP_LABELS = ['Source', 'Choose & upload', 'Map columns', 'Preview', 'Import'];

const SOURCES = [
  { id: 'generic',    label: 'Generic CSV', icon: 'upload',   blurb: 'Any spreadsheet or CSV export' },
  { id: 'hubspot',    label: 'HubSpot',     icon: 'flame',    blurb: 'Standard HubSpot record exports' },
  { id: 'salesforce', label: 'Salesforce',  icon: 'sparkles', blurb: 'Report exports or Data Loader CSVs' },
];

// Static fallback when GET /api/import/presets hasn't loaded (or failed) —
// the columns still auto-map via FIELD_SYNONYMS, only the platform-specific
// help copy comes from here.
const FALLBACK_HELP = {
  hubspot: {
    contacts: 'In HubSpot: CRM → Contacts → select all → Actions → Export → CSV ("All properties" recommended).',
    companies: 'In HubSpot: CRM → Companies → select all → Actions → Export → CSV ("All properties" recommended).',
    deals: 'In HubSpot: CRM → Deals → select all → Actions → Export → CSV.',
  },
  salesforce: {
    contacts: 'In Salesforce: Reports → New Report → Contacts & Accounts → add your columns → Export → Comma Delimited .csv.',
    companies: 'In Salesforce: Reports → New Report → Accounts → add your columns → Export → Comma Delimited .csv.',
    deals: 'In Salesforce: Reports → New Report → Opportunities → add your columns → Export → Comma Delimited .csv.',
  },
};

const ENTITY_META = {
  contacts:  { icon: 'user',      blurb: 'Names, emails, phones, job titles' },
  companies: { icon: 'building',  blurb: 'Company names, industries, websites' },
  deals:     { icon: 'briefcase', blurb: 'Titles, stages, values, close dates' },
};

function StepIndicator({ current }) {
  return (
    <ol className="flex items-center gap-0 mb-8" aria-label="Import steps">
      {STEP_LABELS.map((label, i) => (
        <React.Fragment key={i}>
          <li className="flex flex-col items-center" aria-current={i === current ? 'step' : undefined}>
            <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold transition ${i < current ? 'bg-success-500 text-white' : i === current ? 'bg-brand-blue text-white' : 'bg-gray-200 text-gray-500'}`}>
              {i < current ? <Icon name="check" size={16} /> : i + 1}
            </div>
            <span className={`text-xs mt-1 whitespace-nowrap ${i === current ? 'text-brand-blue font-semibold' : 'text-gray-500'}`}>{label}</span>
          </li>
          {i < STEP_LABELS.length - 1 && (
            <div className={`flex-1 h-0.5 mx-1 mb-5 transition ${i < current ? 'bg-success-400' : 'bg-gray-200'}`} aria-hidden="true" />
          )}
        </React.Fragment>
      ))}
    </ol>
  );
}

export default function ImportWizard() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const fileRef = useRef(null);

  const [step, setStep] = useState(0);
  const [source, setSource] = useState('generic');
  const [presets, setPresets] = useState(null); // descriptors from GET /import/presets
  const [entityType, setEntityType] = useState(
    ['companies', 'deals'].includes(searchParams.get('type')) ? searchParams.get('type') : 'contacts'
  );
  const [file, setFile] = useState(null);
  const [parsed, setParsed] = useState(null); // { headers, rows, preview, totalRows }
  const [mapping, setMapping] = useState({});
  const [autoMatched, setAutoMatched] = useState([]);   // field keys the auto-detect filled
  const [presetMisses, setPresetMisses] = useState([]); // preset fields with no CSV column
  const [uploading, setUploading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [dragOver, setDragOver] = useState(false);

  useEffect(() => {
    let alive = true;
    api.get('/import/presets')
      .then(res => { if (alive) setPresets(res.data.presets || []); })
      .catch(() => { if (alive) setPresets([]); });
    return () => { alive = false; };
  }, []);

  const fields = ENTITY_FIELDS[entityType];
  const presetDescriptor = source !== 'generic' ? (presets || []).find(p => p.id === source) : null;
  const sourceMeta = SOURCES.find(s => s.id === source);
  const exportHelp = source !== 'generic'
    ? (presetDescriptor?.help?.[entityType] || FALLBACK_HELP[source]?.[entityType])
    : null;

  const handleFile = async (f) => {
    if (!f) return;
    setFile(f);
    setError('');
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', f);
      const res = await api.post('/import/parse', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      const data = res.data;
      setParsed(data);
      // Generic auto-detect first; the platform preset's mapping wins where
      // it matched, generic synonyms fill any gaps.
      let auto = autoDetect(data.headers, entityType);
      let misses = [];
      if (presetDescriptor) {
        const pm = applyPresetMapping(presetDescriptor, entityType, data.headers);
        auto = { ...auto, ...pm.mapping };
        misses = pm.unmatched.filter(k => !auto[k]);
      }
      setMapping(auto);
      setAutoMatched(Object.keys(auto).filter(k => auto[k]));
      setPresetMisses(misses);
      setStep(2);
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to parse CSV');
    } finally {
      setUploading(false);
    }
  };

  const handleDrop = e => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files[0];
    if (f) handleFile(f);
  };

  const mappedPreview = () => {
    if (!parsed) return [];
    return parsed.preview.map(row => {
      const out = {};
      for (const field of fields) {
        out[field.key] = mapping[field.key] ? row[mapping[field.key]] || '' : '';
      }
      return out;
    });
  };

  const executeImport = async () => {
    setImporting(true);
    setError('');
    try {
      const res = await api.post(`/import/${entityType}`, {
        rows: parsed.rows,
        mapping,
        ...(source !== 'generic' ? { preset: source } : {}),
      });
      setResult(res.data);
      setStep(4);
    } catch (e) {
      setError(e.response?.data?.error || 'Import failed');
    } finally {
      setImporting(false);
    }
  };

  const reset = () => {
    setStep(0);
    setFile(null);
    setParsed(null);
    setMapping({});
    setAutoMatched([]);
    setPresetMisses([]);
    setResult(null);
    setError('');
  };

  const unusedHeaders = parsed
    ? parsed.headers.filter(h => !Object.values(mapping).includes(h))
    : [];

  const requiredMapped = fields.filter(f => f.required).every(f => mapping[f.key]);
  const entityLabel = entityType.charAt(0).toUpperCase() + entityType.slice(1);

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <Nav active="import" />

      <Container size="narrow" className="flex-1">
        <PageHeader
          title="Import CSV"
          subtitle="Bulk import contacts, companies, or deals from a spreadsheet — or migrate straight from HubSpot or Salesforce."
        />

        <div className="space-y-6">
          <StepIndicator current={step} />

          {error && <Alert tone="danger" onDismiss={() => setError('')}>{error}</Alert>}

          {/* Step 0: Source */}
          {step === 0 && (
            <>
              <Card title="Where is this data coming from?">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  {SOURCES.map(s => (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => setSource(s.id)}
                      aria-pressed={source === s.id}
                      className={`p-4 rounded border-2 text-left transition ${source === s.id ? 'border-brand-blue bg-info-50' : 'border-gray-200 bg-white hover:border-gray-300'}`}
                    >
                      <span className={`inline-flex h-9 w-9 items-center justify-center rounded-full mb-2 ${source === s.id ? 'bg-brand-blue text-white' : 'bg-gray-100 text-gray-500'}`}>
                        <Icon name={s.icon} size={18} />
                      </span>
                      <div className="font-semibold text-gray-900">{s.label}</div>
                      <div className="text-xs text-gray-500 mt-0.5">{s.blurb}</div>
                    </button>
                  ))}
                </div>
              </Card>

              {source !== 'generic' && (
                <Alert tone="info" title={`Migrating from ${sourceMeta.label}`}>
                  <p>
                    Export each object from {sourceMeta.label} as a CSV and import them here <strong>in this order:
                    Companies → Contacts → Deals</strong> — that way contacts and deals connect to their companies by name automatically.
                  </p>
                  <p className="mt-2">
                    We recognize {sourceMeta.label}'s standard export columns (and its default pipeline stage names) out of the box,
                    so the column mapping is pre-filled — you just review it. Owners are matched by <strong>email address</strong>;
                    rows with an unrecognized owner or stage still import, with a note.
                  </p>
                </Alert>
              )}
              {source === 'generic' && (
                <Alert tone="info">
                  Any CSV works. We'll auto-detect common column names (including HubSpot and Salesforce exports) —
                  and you can map every column by hand in step 3.
                </Alert>
              )}

              <div className="flex justify-end">
                <Button iconRight="arrow-right" icon={null} onClick={() => setStep(1)}>Continue</Button>
              </div>
            </>
          )}

          {/* Step 1: Choose entity + Upload */}
          {step === 1 && (
            <>
              <Card title="What are you importing?">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  {['contacts', 'companies', 'deals'].map(type => (
                    <button
                      key={type}
                      type="button"
                      onClick={() => setEntityType(type)}
                      aria-pressed={entityType === type}
                      className={`p-4 rounded border-2 text-left transition ${entityType === type ? 'border-brand-blue bg-info-50' : 'border-gray-200 bg-white hover:border-gray-300'}`}
                    >
                      <span className={`inline-flex h-9 w-9 items-center justify-center rounded-full mb-2 ${entityType === type ? 'bg-brand-blue text-white' : 'bg-gray-100 text-gray-500'}`}>
                        <Icon name={ENTITY_META[type].icon} size={18} />
                      </span>
                      <div className="font-semibold text-gray-900 capitalize">{type}</div>
                      <div className="text-xs text-gray-500 mt-0.5">{ENTITY_META[type].blurb}</div>
                    </button>
                  ))}
                </div>
                {exportHelp && (
                  <div className="mt-3 rounded border border-info-200 bg-info-50 px-4 py-3">
                    <p className="text-xs text-gray-700"><strong>How to export:</strong> {exportHelp}</p>
                  </div>
                )}
              </Card>

              <Card title="Upload your CSV file">
                <div
                  onDragOver={e => { e.preventDefault(); setDragOver(true); }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={handleDrop}
                  onClick={() => fileRef.current?.click()}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileRef.current?.click(); } }}
                  role="button"
                  tabIndex={0}
                  className={`border-2 border-dashed rounded p-10 text-center cursor-pointer transition ${dragOver ? 'border-brand-blue bg-info-50' : 'border-gray-300 bg-white hover:border-gray-400 hover:bg-gray-50'}`}
                >
                  <input
                    ref={fileRef}
                    type="file"
                    accept=".csv,text/csv"
                    className="hidden"
                    onChange={e => handleFile(e.target.files[0])}
                  />
                  {uploading ? (
                    <Spinner size="lg" label="Parsing CSV…" className="py-0" />
                  ) : (
                    <>
                      <span className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-gray-100 text-gray-500 mb-3">
                        <Icon name="upload" size={22} />
                      </span>
                      <p className="font-semibold text-gray-700">Drop your CSV here or click to browse</p>
                      <p className="text-xs text-gray-400 mt-1">Max 10MB · UTF-8 or Excel CSV</p>
                    </>
                  )}
                </div>

                <div className="mt-4 rounded border border-gray-200 bg-gray-50 px-4 py-3">
                  <p className="text-xs font-semibold text-gray-700 mb-1">Expected columns for {entityType}:</p>
                  <p className="text-xs text-gray-600">
                    {fields.map(f => `${f.label}${f.required ? '*' : ''}`).join(' · ')}
                  </p>
                  <p className="text-xs text-gray-500 mt-1">* Required · You can map any column name in the next step</p>
                </div>
              </Card>

              <div className="flex justify-between">
                <Button variant="ghost" icon="arrow-left" onClick={() => setStep(0)}>Back</Button>
              </div>
            </>
          )}

          {/* Step 2: Map Columns */}
          {step === 2 && parsed && (
            <>
              <Alert tone="success" title={file?.name}>
                {parsed.totalRows} rows detected · {parsed.headers.length} columns
                {source !== 'generic' && ` · ${autoMatched.length} auto-matched from your ${sourceMeta.label} export`}
              </Alert>

              <Card title="Match your CSV columns to CRM fields" padding="none">
                {fields.map((field, i) => (
                  <div key={field.key} className={`flex flex-col sm:flex-row sm:items-center px-5 py-3 gap-2 sm:gap-4 ${i > 0 ? 'border-t border-gray-100' : ''}`}>
                    <div className="sm:w-44 flex-shrink-0">
                      <span className="text-sm font-medium text-gray-800">{field.label}</span>
                      {field.required && <span className="text-danger-600 text-xs ml-1" aria-label="required">*</span>}
                      {mapping[field.key] && autoMatched.includes(field.key) && (
                        <span className="ml-2 inline-flex items-center gap-0.5 text-[10px] font-semibold uppercase tracking-wide text-success-700 bg-success-50 border border-success-200 rounded px-1 py-0.5">
                          <Icon name="check" size={10} /> Auto
                        </span>
                      )}
                      {!mapping[field.key] && presetMisses.includes(field.key) && (
                        <span className="ml-2 inline-flex items-center text-[10px] font-semibold uppercase tracking-wide text-warning-700 bg-warning-50 border border-warning-200 rounded px-1 py-0.5">
                          Not in CSV
                        </span>
                      )}
                    </div>
                    <Icon name="arrow-right" size={14} className="hidden sm:block text-gray-300 flex-shrink-0" />
                    <Select
                      size="sm"
                      wrapperClassName="flex-1"
                      aria-label={`Map ${field.label}`}
                      value={mapping[field.key] || ''}
                      onChange={e => setMapping(m => ({ ...m, [field.key]: e.target.value || undefined }))}
                    >
                      <option value="">— Skip this field —</option>
                      {parsed.headers.map(h => (
                        <option key={h} value={h}>{h}</option>
                      ))}
                    </Select>
                    {mapping[field.key] && (
                      <span className="text-xs text-gray-400 sm:w-24 truncate flex-shrink-0">
                        e.g. {parsed.preview[0]?.[mapping[field.key]] || '—'}
                      </span>
                    )}
                  </div>
                ))}
              </Card>

              {unusedHeaders.length > 0 && (
                <p className="text-xs text-gray-500">
                  Columns not being imported: {unusedHeaders.slice(0, 12).join(' · ')}{unusedHeaders.length > 12 ? ` · +${unusedHeaders.length - 12} more` : ''}
                </p>
              )}

              {!requiredMapped && (
                <p className="text-xs text-danger-600">Please map all required fields (*) to continue.</p>
              )}

              <div className="flex justify-between">
                <Button variant="ghost" icon="arrow-left" onClick={() => setStep(1)}>Back</Button>
                <Button iconRight="arrow-right" icon={null} onClick={() => setStep(3)} disabled={!requiredMapped}>
                  Preview
                </Button>
              </div>
            </>
          )}

          {/* Step 3: Preview */}
          {step === 3 && parsed && (
            <>
              <Card
                title={`Preview — first ${Math.min(5, parsed.totalRows)} of ${parsed.totalRows} rows`}
                padding="none"
              >
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="bg-gray-50">
                        {fields.filter(f => mapping[f.key]).map(f => (
                          <th key={f.key} className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wider text-gray-500 whitespace-nowrap border-b border-gray-200">
                            {f.label}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {mappedPreview().map((row, i) => (
                        <tr key={i}>
                          {fields.filter(f => mapping[f.key]).map(f => (
                            <td key={f.key} className="px-3 py-2 text-gray-700 max-w-32 truncate">
                              {row[f.key] || <span className="text-gray-300 italic">empty</span>}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>

              {source !== 'generic' && entityType === 'deals' && mapping.stage && (
                <Alert tone="info">
                  {sourceMeta.label}'s default stage names will be translated onto your pipeline automatically
                  (e.g. {source === 'hubspot' ? '"Appointment Scheduled" → your first stage, "Closed Won" → your won stage' : '"Prospecting" → your first stage, "Closed Won" → your won stage'}).
                  Custom stages we don't recognize land in your pipeline's first stage — you'll see a note for each.
                </Alert>
              )}

              <Alert tone="info">
                Ready to import <strong>{parsed.totalRows} {entityType}</strong>. Rows missing required fields will be skipped.
              </Alert>

              <div className="flex justify-between">
                <Button variant="ghost" icon="arrow-left" onClick={() => setStep(2)}>Back</Button>
                <Button icon="upload" onClick={executeImport} loading={importing} loadingLabel="Importing…">
                  Import {parsed.totalRows} {entityType}
                </Button>
              </div>
            </>
          )}

          {/* Step 4: Results */}
          {step === 4 && result && (
            <Card>
              <div className="text-center">
                <div className="w-16 h-16 rounded-full bg-success-100 text-success-600 flex items-center justify-center mx-auto mb-4">
                  <Icon name="check" size={32} />
                </div>
                <h2 className="text-xl font-semibold tracking-tight text-gray-900 mb-1">Import complete</h2>
                <p className="text-gray-500 mb-6">Your data has been added to the CRM</p>

                <div className="grid grid-cols-2 gap-4 mb-6 max-w-xs mx-auto">
                  <div className="bg-success-50 border border-success-200 rounded p-4">
                    <p className="text-3xl font-semibold tracking-tight text-success-600">{result.created}</p>
                    <p className="text-xs text-success-700 mt-0.5">Created</p>
                  </div>
                  <div className="bg-gray-50 border border-gray-200 rounded p-4">
                    <p className="text-3xl font-semibold tracking-tight text-gray-500">{result.skipped}</p>
                    <p className="text-xs text-gray-600 mt-0.5">Skipped</p>
                  </div>
                </div>

                {result.warnings?.length > 0 && (
                  <div className="text-left bg-warning-50 border border-warning-200 rounded p-4 mb-6 max-h-40 overflow-y-auto">
                    <p className="text-xs font-semibold text-warning-700 mb-2">Imported with notes:</p>
                    {result.warnings.map((w, i) => (
                      <p key={i} className="text-xs text-warning-700">Row {w.row}: {w.reason}</p>
                    ))}
                  </div>
                )}

                {result.errors?.length > 0 && (
                  <div className="text-left bg-danger-50 border border-danger-200 rounded p-4 mb-6 max-h-40 overflow-y-auto">
                    <p className="text-xs font-semibold text-danger-700 mb-2">Skipped rows:</p>
                    {result.errors.map((e, i) => (
                      <p key={i} className="text-xs text-danger-600">Row {e.row}: {e.reason}</p>
                    ))}
                  </div>
                )}

                <div className="flex justify-center gap-3">
                  <Button variant="secondary" onClick={reset}>Import more</Button>
                  <Button iconRight="arrow-right" onClick={() => navigate(`/${entityType}`)}>
                    View {entityLabel}
                  </Button>
                </div>
              </div>
            </Card>
          )}
        </div>
      </Container>
    </div>
  );
}
