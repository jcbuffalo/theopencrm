// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import React, { useEffect, useState } from 'react';
import api from '../api';

// CustomFieldsSection — renders inputs for the org's custom-field defs and
// reads/writes them into a `custom_fields` key on the parent form's state.
//
// Drop into any CRUD form like:
//   <CustomFieldsSection
//     entity="companies"
//     values={formData.custom_fields || {}}
//     onChange={(next) => setFormData(prev => ({ ...prev, custom_fields: next }))}
//   />
//
// The component owns its own def-list fetch so callers don't need to thread
// it through. When the org has no defs for the entity, the component renders
// nothing — no empty header, no skeleton — so it's safe to mount on every
// form unconditionally.
//
// Props:
//   - entity:  'companies'|'contacts'|'deals'|'tasks'
//   - values:  the current custom_fields object (parent controls)
//   - onChange: (nextValuesObject) => void
//   - readOnly: optional, dim & disable inputs
export default function CustomFieldsSection({ entity, values = {}, onChange, readOnly = false }) {
  const [defs, setDefs] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.get(`/custom-fields`, { params: { entity } })
      .then(r => { if (!cancelled) setDefs(Array.isArray(r.data) ? r.data : []); })
      .catch(() => { if (!cancelled) setDefs([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [entity]);

  if (loading) return null;
  if (defs.length === 0) return null;

  const setField = (name, val) => {
    onChange({ ...(values || {}), [name]: val });
  };

  return (
    <div className="border-t border-gray-200 pt-4 mt-2">
      <h4 className="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-2">
        Custom fields
        <span className="text-xs text-gray-400 font-normal">(org-specific)</span>
      </h4>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {defs.map(def => (
          <CustomFieldInput
            key={def.id}
            def={def}
            value={values?.[def.name]}
            onChange={(v) => setField(def.name, v)}
            disabled={readOnly}
          />
        ))}
      </div>
    </div>
  );
}

function CustomFieldInput({ def, value, onChange, disabled }) {
  const label = (def.label || def.name) + (def.required ? ' *' : '');
  const common = "w-full px-3 py-2 border border-gray-300 rounded text-sm focus:outline-none focus:border-brand-blue focus:ring-2 focus:ring-brand-blue/20 disabled:bg-gray-50 disabled:text-gray-500";

  if (def.type === 'text') {
    return (
      <div>
        <label className="block text-xs font-medium text-gray-700 mb-1">{label}</label>
        <input type="text" value={value || ''} onChange={(e) => onChange(e.target.value)} disabled={disabled} className={common} />
      </div>
    );
  }
  if (def.type === 'number') {
    return (
      <div>
        <label className="block text-xs font-medium text-gray-700 mb-1">{label}</label>
        <input
          type="number"
          value={value == null ? '' : value}
          onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
          disabled={disabled} className={common}
        />
      </div>
    );
  }
  if (def.type === 'date') {
    return (
      <div>
        <label className="block text-xs font-medium text-gray-700 mb-1">{label}</label>
        <input
          type="date"
          value={(value || '').slice(0, 10)}
          onChange={(e) => onChange(e.target.value || null)}
          disabled={disabled} className={common}
        />
      </div>
    );
  }
  if (def.type === 'boolean') {
    return (
      <div className="flex items-center gap-2 pt-5">
        <input id={`cf-${def.id}`} type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} disabled={disabled} />
        <label htmlFor={`cf-${def.id}`} className="text-sm text-gray-700">{label}</label>
      </div>
    );
  }
  if (def.type === 'select') {
    return (
      <div>
        <label className="block text-xs font-medium text-gray-700 mb-1">{label}</label>
        <select value={value || ''} onChange={(e) => onChange(e.target.value || null)} disabled={disabled} className={common}>
          <option value="">(none)</option>
          {(def.options || []).map(o => <option key={o} value={o}>{o}</option>)}
        </select>
      </div>
    );
  }
  if (def.type === 'multiselect') {
    const arr = Array.isArray(value) ? value : [];
    const toggle = (o) => {
      if (arr.includes(o)) onChange(arr.filter(x => x !== o));
      else onChange([...arr, o]);
    };
    return (
      <div>
        <label className="block text-xs font-medium text-gray-700 mb-1">{label}</label>
        <div className="flex flex-wrap gap-2">
          {(def.options || []).map(o => (
            <button
              key={o}
              type="button"
              onClick={() => !disabled && toggle(o)}
              disabled={disabled}
              className={`px-2 py-1 text-xs rounded border transition ${arr.includes(o) ? 'bg-info-50 border-brand-blue text-brand-blue' : 'bg-white border-gray-300 text-gray-600 hover:bg-gray-50'}`}
            >
              {o}
            </button>
          ))}
        </div>
      </div>
    );
  }
  return <div className="text-xs text-gray-400">Unsupported field type: {def.type}</div>;
}
