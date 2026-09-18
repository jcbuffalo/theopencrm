// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ResponsiveContainer, BarChart, Bar, LineChart, Line, PieChart, Pie, Cell,
  XAxis, YAxis, Tooltip, CartesianGrid, Legend,
} from 'recharts';
import api from '../api';
import Nav from '../components/Nav';
import DataTable from '../components/DataTable';
import { Alert, Button, Card, Container, Icon, Input, PageHeader, Select, Skeleton } from '../components/ui';

// Custom report builder — pick entity → filters → group-by → metric → chart,
// run a live preview, and save/load named report definitions. All allowlist
// choices come from GET /api/reports/schema so the UI never drifts from the
// safe server-side engine (services/reportBuilder.js).

const TEMPORAL = new Set(['timestamp', 'date']);
const NUMERIC = new Set(['numeric', 'int']);
const PIE_COLORS = ['#2076CD', '#059669', '#f59e0b', '#ef4444', '#8b5cf6', '#0ea5e9', '#ec4899', '#14b8a6', '#a3a3a3', '#f97316'];

// Operators that make sense per logical column type. Kept in-sync-by-intent
// with the engine's FILTER_OPS allowlist; the server re-validates regardless.
function opsForType(type) {
  const base = [
    { id: 'eq', label: 'is' },
    { id: 'ne', label: 'is not' },
    { id: 'is_null', label: 'is empty' },
    { id: 'not_null', label: 'is not empty' },
  ];
  if (NUMERIC.has(type) || TEMPORAL.has(type)) {
    return [
      { id: 'eq', label: '=' }, { id: 'ne', label: '≠' },
      { id: 'gt', label: '>' }, { id: 'gte', label: '≥' },
      { id: 'lt', label: '<' }, { id: 'lte', label: '≤' },
      { id: 'is_null', label: 'is empty' }, { id: 'not_null', label: 'is not empty' },
    ];
  }
  if (type === 'text') {
    return [...base, { id: 'in', label: 'is any of' }, { id: 'contains', label: 'contains' }];
  }
  return base;
}

const NO_VALUE_OPS = new Set(['is_null', 'not_null']);

function fmtNumber(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return '—';
  if (Math.abs(num) >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
  if (Math.abs(num) >= 1_000) return `${(num / 1_000).toFixed(1)}K`;
  return num.toLocaleString();
}

function fmtGroupKey(k) {
  if (k === null || k === undefined || k === '') return '(none)';
  if (k === true) return 'true';
  if (k === false) return 'false';
  // date_trunc::date comes back as an ISO string / Date — keep the date part.
  if (typeof k === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(k)) return k.slice(0, 10);
  return String(k);
}

// Segmented toggle (granularity / chart type) — a row of small pressed buttons.
function Segmented({ options, value, onChange, label }) {
  return (
    <div role="group" aria-label={label} className="flex gap-1 bg-gray-100 rounded-md p-1">
      {options.map((o) => (
        <button
          key={o}
          type="button"
          onClick={() => onChange(o)}
          aria-pressed={value === o}
          className={`flex-1 px-2 py-1 text-xs font-medium rounded capitalize transition ${value === o ? 'bg-brand-blue text-white' : 'text-gray-600 hover:bg-white'}`}
        >
          {o}
        </button>
      ))}
    </div>
  );
}

export default function ReportBuilder() {
  const navigate = useNavigate();
  const [schema, setSchema] = useState(null);
  const [schemaError, setSchemaError] = useState('');

  const [entity, setEntity] = useState('deals');
  const [filters, setFilters] = useState([]);
  const [groupBy, setGroupBy] = useState('');
  const [granularity, setGranularity] = useState('month');
  const [metric, setMetric] = useState('count');
  const [chartType, setChartType] = useState('bar');

  const [rows, setRows] = useState(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState('');

  const [name, setName] = useState('');
  const [saved, setSaved] = useState([]);
  const [saveMsg, setSaveMsg] = useState('');

  // --- Load allowlist metadata + saved reports on mount.
  useEffect(() => {
    api.get('/reports/schema')
      .then(r => setSchema(r.data))
      .catch(err => setSchemaError(err.response?.data?.error || 'Failed to load report schema'));
    refreshSaved();
  }, []);

  function refreshSaved() {
    api.get('/reports/saved').then(r => setSaved(r.data || [])).catch(() => {});
  }

  const ent = schema?.entities?.[entity];
  const columns = ent?.columns || {};

  // Metric options: count + sum/avg over each numeric metric field.
  const metricOptions = useMemo(() => {
    const opts = [{ value: 'count', label: 'Count of records' }];
    for (const f of (ent?.metric_fields || [])) {
      opts.push({ value: `sum:${f}`, label: `Sum of ${f}` });
      opts.push({ value: `avg:${f}`, label: `Average ${f}` });
    }
    return opts;
  }, [ent]);

  const groupIsTemporal = groupBy && TEMPORAL.has(columns[groupBy]);

  // --- Reset dependent selections when the entity changes.
  function changeEntity(next) {
    setEntity(next);
    setFilters([]);
    setGroupBy('');
    setMetric('count');
    setRows(null);
    setRunError('');
  }

  function addFilter() {
    const first = (ent?.filterable || [])[0];
    if (!first) return;
    setFilters(f => [...f, { field: first, op: 'eq', value: '' }]);
  }
  function updateFilter(i, patch) {
    setFilters(f => f.map((row, idx) => (idx === i ? { ...row, ...patch } : row)));
  }
  function removeFilter(i) {
    setFilters(f => f.filter((_, idx) => idx !== i));
  }

  // --- Assemble the config object the API expects.
  function buildConfig() {
    const cfg = {
      entity,
      metric,
      chart_type: chartType,
      group_by: groupBy || null,
      group_by_granularity: granularity,
      filters: filters.map(f => {
        const out = { field: f.field, op: f.op };
        if (!NO_VALUE_OPS.has(f.op)) {
          out.value = f.op === 'in'
            ? String(f.value).split(',').map(s => s.trim()).filter(Boolean)
            : coerceValue(f.field, f.value);
        }
        return out;
      }),
    };
    return cfg;
  }

  function coerceValue(field, raw) {
    const type = columns[field];
    if (type === 'bool') return raw === 'true' || raw === true;
    if (NUMERIC.has(type)) { const n = Number(raw); return Number.isFinite(n) ? n : raw; }
    return raw;
  }

  async function run() {
    setRunning(true);
    setRunError('');
    try {
      const r = await api.post('/reports/run', buildConfig());
      setRows(r.data.rows || []);
    } catch (err) {
      const data = err.response?.data;
      const detail = data?.fields?.map(f => `${f.path}: ${f.message}`).join('; ');
      setRunError(detail || data?.error || 'Failed to run report');
      setRows(null);
    } finally {
      setRunning(false);
    }
  }

  async function save() {
    setSaveMsg('');
    if (!name.trim()) { setSaveMsg('Enter a name first.'); return; }
    try {
      await api.post('/reports/saved', { name: name.trim(), config: buildConfig() });
      setSaveMsg('Saved.');
      setName('');
      refreshSaved();
    } catch (err) {
      setSaveMsg(err.response?.data?.error || 'Failed to save.');
    }
  }

  function load(r) {
    const c = r.config || {};
    setEntity(c.entity || 'deals');
    setFilters(Array.isArray(c.filters) ? c.filters.map(f => ({
      field: f.field, op: f.op,
      value: Array.isArray(f.value) ? f.value.join(', ') : (f.value ?? ''),
    })) : []);
    setGroupBy(c.group_by || '');
    setGranularity(c.group_by_granularity || 'month');
    setMetric(c.metric || 'count');
    setChartType(c.chart_type || 'bar');
    setRows(null);
    setRunError('');
  }

  async function del(id) {
    try { await api.delete(`/reports/saved/${id}`); refreshSaved(); } catch { /* noop */ }
  }

  // --- Chart data shape recharts wants.
  const chartData = useMemo(
    () => (rows || []).map(r => ({ name: fmtGroupKey(r.group_key), value: Number(r.value) })),
    [rows]
  );
  const isScalar = rows && rows.length === 1 && (rows[0].group_key === null || !groupBy);

  return (
    <div className="min-h-screen bg-gray-50">
      <Nav active="reports" />
      <Container size="wide">
        <PageHeader
          title="Custom report builder"
          subtitle="Pick an entity, filter it, group it, choose a metric, and chart it."
          breadcrumb={[{ label: 'Reports', to: '/reports' }, { label: 'Report builder' }]}
          secondaryActions={[{ label: 'Back to reports', icon: 'arrow-left', inline: true, onClick: () => navigate('/reports') }]}
        />

        <div className="space-y-6">
          {schemaError && <Alert tone="danger" onDismiss={() => setSchemaError('')}>{schemaError}</Alert>}

          {!schema ? (
            <div role="status" aria-label="Loading report schema" className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <Card><Skeleton lines={8} /></Card>
              <Card className="lg:col-span-2"><Skeleton lines={8} /></Card>
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              {/* ---------------- Builder controls ---------------- */}
              <div className="lg:col-span-1 space-y-4">
                <Card title="Report" padding="md" bodyClassName="space-y-4">
                  <Select label="Entity" value={entity} onChange={e => changeEntity(e.target.value)}>
                    {Object.entries(schema.entities).map(([id, e]) => (
                      <option key={id} value={id}>{e.label}</option>
                    ))}
                  </Select>

                  <div>
                    <Select label="Group by" value={groupBy} onChange={e => setGroupBy(e.target.value)}>
                      <option value="">(no grouping — single total)</option>
                      {(ent?.groupable || []).map(c => <option key={c} value={c}>{c}</option>)}
                    </Select>
                    {groupIsTemporal && (
                      <div className="mt-2">
                        <div className="block text-xs font-medium text-gray-500 mb-1">Bin dates by</div>
                        <Segmented
                          label="Bin dates by"
                          options={schema.granularities || ['day', 'week', 'month']}
                          value={granularity}
                          onChange={setGranularity}
                        />
                      </div>
                    )}
                  </div>

                  <Select label="Metric" value={metric} onChange={e => setMetric(e.target.value)} options={metricOptions} />

                  <div>
                    <div className="block text-sm font-medium text-gray-700 mb-1">Chart</div>
                    <Segmented
                      label="Chart type"
                      options={schema.chart_types || ['bar', 'line', 'pie', 'table']}
                      value={chartType}
                      onChange={setChartType}
                    />
                  </div>
                </Card>

                {/* Filters */}
                <Card
                  title="Filters"
                  actions={<Button size="sm" variant="ghost" icon="plus" onClick={addFilter}>Add filter</Button>}
                >
                  {filters.length === 0 && <p className="text-xs text-gray-400">No filters — all records.</p>}
                  <div className="space-y-2">
                    {filters.map((f, i) => {
                      const type = columns[f.field];
                      const ops = opsForType(type);
                      const needsValue = !NO_VALUE_OPS.has(f.op);
                      return (
                        <div key={i} className="border border-gray-200 rounded p-2 space-y-1.5">
                          <div className="flex gap-1.5 items-center">
                            <Select
                              size="sm"
                              wrapperClassName="flex-1"
                              aria-label="Filter field"
                              value={f.field}
                              onChange={e => updateFilter(i, { field: e.target.value, op: 'eq' })}
                            >
                              {(ent?.filterable || []).map(c => <option key={c} value={c}>{c}</option>)}
                            </Select>
                            <button
                              type="button"
                              onClick={() => removeFilter(i)}
                              className="rounded-md p-1 text-gray-400 hover:text-danger-600 hover:bg-gray-100"
                              aria-label="Remove filter"
                            >
                              <Icon name="x" size={14} />
                            </button>
                          </div>
                          <div className="flex gap-1.5">
                            <Select
                              size="sm"
                              wrapperClassName="w-32 flex-shrink-0"
                              aria-label="Operator"
                              value={f.op}
                              onChange={e => updateFilter(i, { op: e.target.value })}
                            >
                              {ops.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
                            </Select>
                            {needsValue && (
                              type === 'bool' ? (
                                <Select
                                  size="sm"
                                  wrapperClassName="flex-1"
                                  aria-label="Value"
                                  value={String(f.value)}
                                  onChange={e => updateFilter(i, { value: e.target.value })}
                                >
                                  <option value="true">true</option>
                                  <option value="false">false</option>
                                </Select>
                              ) : (
                                <Input
                                  size="sm"
                                  wrapperClassName="flex-1"
                                  aria-label="Value"
                                  type={NUMERIC.has(type) ? 'number' : (TEMPORAL.has(type) ? 'date' : 'text')}
                                  value={f.value}
                                  placeholder={f.op === 'in' ? 'a, b, c' : ''}
                                  onChange={e => updateFilter(i, { value: e.target.value })}
                                />
                              )
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </Card>

                <Button fullWidth onClick={run} loading={running} loadingLabel="Running…">
                  Run report
                </Button>
              </div>

              {/* ---------------- Preview + save ---------------- */}
              <div className="lg:col-span-2 space-y-4">
                <Card title="Preview" className="min-h-[320px]" padding={chartType === 'table' && rows && rows.length > 0 && !isScalar ? 'none' : 'md'}>
                  {runError && <Alert tone="danger" className="mb-3" onDismiss={() => setRunError('')}>{runError}</Alert>}
                  {!rows ? (
                    <p className="text-sm text-gray-500 py-16 text-center">Pick an entity, group-by, and metric, then hit Run — your chart renders here.</p>
                  ) : rows.length === 0 ? (
                    <p className="text-sm text-gray-500 py-16 text-center">No rows matched. Loosen a filter or try a different metric, and your report will fill in.</p>
                  ) : isScalar ? (
                    <div className="py-16 text-center">
                      <p className="text-5xl font-semibold tracking-tight text-brand-blue">{fmtNumber(rows[0].value)}</p>
                      <p className="text-xs text-gray-500 uppercase tracking-wider mt-2">{metric === 'count' ? 'Records' : metric}</p>
                    </div>
                  ) : chartType === 'table' ? (
                    <DataTable
                      flush
                      density="compact"
                      rowKey={(r) => r.name}
                      columns={[
                        { key: 'name', label: groupBy || 'Group' },
                        { key: 'value', label: metric, align: 'right', render: (r) => fmtNumber(r.value) },
                      ]}
                      data={chartData}
                    />
                  ) : (
                    <ResponsiveContainer width="100%" height={340}>
                      {chartType === 'line' ? (
                        <LineChart data={chartData} margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
                          <XAxis dataKey="name" tick={{ fontSize: 10, fill: '#6b7280' }} />
                          <YAxis tick={{ fontSize: 10, fill: '#6b7280' }} tickFormatter={fmtNumber} width={44} />
                          <Tooltip formatter={v => fmtNumber(v)} contentStyle={{ fontSize: 12 }} />
                          <Line type="monotone" dataKey="value" stroke="#2076CD" strokeWidth={2} dot={{ r: 2 }} />
                        </LineChart>
                      ) : chartType === 'pie' ? (
                        <PieChart>
                          <Tooltip formatter={v => fmtNumber(v)} contentStyle={{ fontSize: 12 }} />
                          <Legend wrapperStyle={{ fontSize: 11 }} />
                          <Pie data={chartData} dataKey="value" nameKey="name" outerRadius={120} label={p => p.name}>
                            {chartData.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                          </Pie>
                        </PieChart>
                      ) : (
                        <BarChart data={chartData} margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
                          <XAxis dataKey="name" tick={{ fontSize: 10, fill: '#6b7280' }} />
                          <YAxis tick={{ fontSize: 10, fill: '#6b7280' }} tickFormatter={fmtNumber} width={44} />
                          <Tooltip formatter={v => fmtNumber(v)} contentStyle={{ fontSize: 12 }} />
                          <Bar dataKey="value" fill="#2076CD" radius={[4, 4, 0, 0]} />
                        </BarChart>
                      )}
                    </ResponsiveContainer>
                  )}
                </Card>

                {/* Save */}
                <Card title="Save this report">
                  <form
                    className="flex items-start gap-2"
                    onSubmit={(e) => { e.preventDefault(); save(); }}
                  >
                    <Input
                      wrapperClassName="flex-1"
                      aria-label="Report name"
                      value={name}
                      onChange={e => setName(e.target.value)}
                      maxLength={120}
                      placeholder="Name this report to save it"
                    />
                    <Button type="submit" variant="secondary">Save</Button>
                  </form>
                  {saveMsg && (
                    <p className={`text-xs mt-2 ${saveMsg === 'Saved.' ? 'text-success-700' : 'text-gray-500'}`} role="status">{saveMsg}</p>
                  )}
                </Card>

                {/* Saved reports */}
                <Card title="Saved reports" padding={saved.length === 0 ? 'md' : 'none'}>
                  {saved.length === 0 ? (
                    <p className="text-xs text-gray-400">No saved reports yet.</p>
                  ) : (
                    <ul className="divide-y divide-gray-100">
                      {saved.map(r => (
                        <li key={r.id} className="flex items-center justify-between px-5 py-3">
                          <div>
                            <p className="text-sm font-medium text-gray-900">{r.name}</p>
                            <p className="text-xs text-gray-500">{r.entity}</p>
                          </div>
                          <div className="flex items-center gap-3">
                            <button type="button" onClick={() => load(r)} className="text-sm font-medium text-brand-blue hover:underline">Load</button>
                            <button type="button" onClick={() => del(r.id)} className="text-sm font-medium text-danger-600 hover:underline">Delete</button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
              </div>
            </div>
          )}
        </div>
      </Container>
    </div>
  );
}
