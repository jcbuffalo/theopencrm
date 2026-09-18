// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import React, { useEffect, useState, useRef } from 'react';
import api, { downloadBlob } from '../api';

const DOC_TYPES = ['rfq', 'vendor_quote', 'customer_quote', 'po', 'drawing', 'submittal', 'bol', 'packing_list', 'closeout', 'other'];

export default function DocumentList({ relatedType, relatedId }) {
  const [docs, setDocs] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [docType, setDocType] = useState('other');
  const [error, setError] = useState('');
  const fileRef = useRef(null);

  const load = async () => {
    try {
      const r = await api.get(`/documents?related_type=${relatedType}&related_id=${relatedId}`);
      setDocs(r.data);
      setError('');
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load documents.');
    }
  };

  useEffect(() => { load(); }, [relatedType, relatedId]);

  const handleFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setError('');
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('related_type', relatedType);
      fd.append('related_id', relatedId);
      fd.append('doc_type', docType);
      await api.post('/documents', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Upload failed. Check the file size and try again.');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const remove = async (id) => {
    if (!window.confirm('Delete this document?')) return;
    try {
      await api.delete(`/documents/${id}`);
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to delete document.');
    }
  };

  const apiBase = (process.env.REACT_APP_API_URL || 'http://localhost:5001/api').replace(/\/$/, '');
  const downloadHref = (id) => `${apiBase}/documents/${id}/download`;

  return (
    <div>
      {error && (
        <div className="mb-2 text-xs text-danger-600 bg-danger-50 border border-danger-200 rounded px-2 py-1" role="alert">{error}</div>
      )}
      {docs.length === 0 ? (
        <p className="text-xs text-gray-500 mb-2">No documents.</p>
      ) : (
        <ul className="space-y-1.5 mb-3">
          {docs.map(d => (
            <li key={d.id} className="flex items-center justify-between text-xs border border-gray-200 rounded px-2 py-1.5">
              <div className="flex items-center gap-2 flex-1 min-w-0">
                <span className="text-[10px] px-1.5 py-0.5 bg-gray-100 text-gray-600 rounded uppercase font-semibold flex-shrink-0">{d.doc_type || 'other'}</span>
                <span className="truncate text-gray-900">{d.filename}</span>
                {d.source === 'portal' && (
                  <span className="text-[10px] px-1.5 py-0.5 bg-warning-50 text-warning-700 border border-warning-200 rounded font-semibold flex-shrink-0">
                    via portal
                  </span>
                )}
                {d.size && <span className="text-gray-400 flex-shrink-0">{(d.size / 1024).toFixed(0)}KB</span>}
              </div>
              <div className="flex gap-2 flex-shrink-0">
                <a
                  href={downloadHref(d.id)}
                  onClick={(e) => {
                    e.preventDefault();
                    downloadBlob(`/documents/${d.id}/download`, d.filename)
                      .catch(() => alert('Failed to download document'));
                  }}
                  className="text-brand-blue hover:underline text-[11px]"
                >Download</a>
                <button onClick={() => remove(d.id)} className="text-danger-600 hover:underline text-[11px]">×</button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2 items-center">
        <select value={docType} onChange={(e) => setDocType(e.target.value)}
          className="px-2 py-1 border border-gray-300 rounded text-xs">
          {DOC_TYPES.map(t => <option key={t} value={t}>{t.replace('_', ' ')}</option>)}
        </select>
        <input ref={fileRef} type="file" onChange={handleFile} disabled={uploading}
          className="text-xs flex-1" />
        {uploading && <span className="text-xs text-gray-500">Uploading…</span>}
      </div>
    </div>
  );
}
