// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// DriveFolderPicker — modal to pick a Google Drive folder to link to a deal.
//
// Two ways to choose:
//   1. Search by name (debounced 300ms) — hits GET /api/drive/folders/search?q=
//      and lists up to 25 matches. Each row shows the folder name + optional
//      parent path / owner email if the backend returns them.
//   2. "Paste folder URL instead" fallback — extracts the folder ID from any
//      drive.google.com/drive/folders/<id>?<...> URL. Useful when search
//      doesn't find the folder (deep nesting, shared drive, etc.).
//
// On confirm, calls onConfirm({ drive_folder_id, folder_name, folder_url })
// and closes. The parent component owns the link/sync side-effects.
//
// Props
//   open      : boolean
//   onClose   : () => void
//   onConfirm : (folder: { drive_folder_id, folder_name, folder_url }) => void

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { drive } from '../api';

// Pulls a folder ID out of any drive.google.com/drive/folders/<id> URL.
// Accepts trailing query params (?usp=...) and fragments. Returns null when
// the input doesn't look like a Drive folder URL.
function extractFolderIdFromUrl(input) {
  if (!input) return null;
  const trimmed = String(input).trim();
  // Bare ID — rough heuristic: drive folder IDs are typically 28-44 chars of
  // base64-url alphabet. Accept anything 20+ chars in that set.
  if (/^[A-Za-z0-9_-]{20,}$/.test(trimmed)) return trimmed;
  // URL form.
  const m = trimmed.match(
    /drive\.google\.com\/(?:drive\/)?folders\/([A-Za-z0-9_-]+)/i
  );
  return m ? m[1] : null;
}

function buildFolderUrl(folderId) {
  return `https://drive.google.com/drive/folders/${folderId}`;
}

export default function DriveFolderPicker({ open, onClose, onConfirm }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null); // result row

  // Fallback "paste URL" panel
  const [showUrlFallback, setShowUrlFallback] = useState(false);
  const [pastedUrl, setPastedUrl] = useState('');
  const [pastedName, setPastedName] = useState('');
  const [urlError, setUrlError] = useState('');

  const debounceRef = useRef(null);

  // Reset on open/close so re-opening the picker doesn't leak the prior
  // search state into a different deal.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setResults([]);
    setError('');
    setSelected(null);
    setShowUrlFallback(false);
    setPastedUrl('');
    setPastedName('');
    setUrlError('');
  }, [open]);

  // Esc closes the modal (matches EmailComposerModal convention).
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose?.();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Debounced search — fires 300ms after the last keystroke. Empty query
  // clears the list instead of firing a no-op request.
  useEffect(() => {
    if (!open) return undefined;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const q = query.trim();
    if (!q) {
      setResults([]);
      setError('');
      setLoading(false);
      return undefined;
    }
    setLoading(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const data = await drive.searchFolders(q);
        // Accept either a plain array or a { folders: [...] } envelope.
        const list = Array.isArray(data) ? data : data?.folders || [];
        setResults(list);
        setError('');
      } catch (err) {
        const status = err?.response?.status;
        const code = err?.response?.data?.error || '';
        if (status === 503 && /not configured|not enabled/i.test(code)) {
          setError(
            'Drive integration is not enabled on this deployment.'
          );
        } else if (status === 401) {
          setError(
            'No active Google Drive connection. Connect Drive in Settings first.'
          );
        } else {
          setError(
            err?.response?.data?.error || 'Folder search failed. Try again.'
          );
        }
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, open]);

  const pastedIdPreview = useMemo(
    () => extractFolderIdFromUrl(pastedUrl),
    [pastedUrl]
  );

  const handleConfirmSearch = () => {
    if (!selected) return;
    const id = selected.id || selected.drive_folder_id;
    if (!id) return;
    onConfirm?.({
      drive_folder_id: id,
      folder_name: selected.name || 'Untitled folder',
      folder_url: selected.webViewLink || buildFolderUrl(id),
    });
    onClose?.();
  };

  const handleConfirmPasted = () => {
    setUrlError('');
    const id = extractFolderIdFromUrl(pastedUrl);
    if (!id) {
      setUrlError(
        "That doesn't look like a Drive folder URL. Expected a link like https://drive.google.com/drive/folders/…"
      );
      return;
    }
    const name = pastedName.trim() || 'Pasted folder';
    onConfirm?.({
      drive_folder_id: id,
      folder_name: name,
      folder_url: buildFolderUrl(id),
    });
    onClose?.();
  };

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="drive-folder-picker-title"
      className="fixed inset-0 bg-black bg-opacity-30 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4"
      onClick={() => onClose?.()}
    >
      <div
        className="bg-white rounded-t-xl sm:rounded-xl shadow-xl w-full sm:max-w-lg p-4 sm:p-6 max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-3">
          <div className="min-w-0">
            <h3
              id="drive-folder-picker-title"
              className="text-lg font-semibold text-gray-900"
            >
              Pick a Drive folder
            </h3>
            <p className="text-xs text-gray-500 mt-0.5">
              Choose the folder this deal's documents live in. We'll read
              its contents and summarize them on demand.
            </p>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-700 text-2xl leading-none min-h-[32px] min-w-[32px] flex items-center justify-center"
          >
            ×
          </button>
        </div>

        {!showUrlFallback ? (
          <>
            <div>
              <label
                htmlFor="drive-folder-search"
                className="block text-xs font-medium text-gray-700 mb-1"
              >
                Search by folder name
              </label>
              <input
                id="drive-folder-search"
                type="text"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setSelected(null);
                }}
                autoFocus
                placeholder="e.g. Acme Q3 deal"
                className="w-full px-3 py-2 min-h-[44px] border border-gray-300 rounded-lg text-sm"
              />
            </div>

            <div className="mt-3 flex-1 overflow-y-auto -mx-1 px-1">
              {loading ? (
                <div className="flex items-center gap-2 text-sm text-gray-500 py-4">
                  <span
                    className="inline-block w-4 h-4 border-2 border-gray-300 border-t-brand-blue rounded-full animate-spin"
                    aria-hidden="true"
                  />
                  <span>Searching…</span>
                </div>
              ) : error ? (
                <div className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded text-sm">
                  {error}
                </div>
              ) : query.trim() && results.length === 0 ? (
                <div className="text-sm text-gray-500 py-4">
                  No folders matched "{query.trim()}". Try a different name,
                  or paste the folder URL below.
                </div>
              ) : results.length === 0 ? (
                <div className="text-sm text-gray-500 py-4">
                  Start typing to search your Drive folders.
                </div>
              ) : (
                <ul className="divide-y divide-gray-100 border border-gray-200 rounded-lg">
                  {results.map((f) => {
                    const id = f.id || f.drive_folder_id;
                    const isSel =
                      selected && (selected.id || selected.drive_folder_id) === id;
                    return (
                      <li key={id}>
                        <button
                          type="button"
                          onClick={() => setSelected(f)}
                          className={`w-full text-left px-3 py-2 min-h-[44px] flex flex-col gap-0.5 text-sm ${
                            isSel
                              ? 'bg-blue-50 text-brand-blue'
                              : 'hover:bg-gray-50 text-gray-800'
                          }`}
                        >
                          <span className="font-medium break-words">
                            {f.name || 'Untitled folder'}
                          </span>
                          {f.owner_email || f.ownerEmail ? (
                            <span className="text-[11px] text-gray-500 break-words">
                              Owner: {f.owner_email || f.ownerEmail}
                            </span>
                          ) : null}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            <div className="mt-3 flex items-center justify-between gap-2 flex-wrap">
              <button
                type="button"
                onClick={() => setShowUrlFallback(true)}
                className="text-sm text-brand-blue underline min-h-[32px]"
              >
                Paste folder URL instead
              </button>
              <div className="flex gap-2 ml-auto">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-4 py-2 min-h-[44px] border border-gray-300 text-gray-700 rounded-lg text-sm"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleConfirmSearch}
                  disabled={!selected}
                  className="px-4 py-2 min-h-[44px] bg-brand-blue hover:bg-brand-blue-dark text-white rounded-lg text-sm font-medium disabled:opacity-50"
                >
                  Link folder
                </button>
              </div>
            </div>
          </>
        ) : (
          // Paste-URL fallback panel.
          <>
            <div className="space-y-3 flex-1 overflow-y-auto">
              <div>
                <label
                  htmlFor="drive-folder-url"
                  className="block text-xs font-medium text-gray-700 mb-1"
                >
                  Drive folder URL
                </label>
                <input
                  id="drive-folder-url"
                  type="text"
                  value={pastedUrl}
                  onChange={(e) => {
                    setPastedUrl(e.target.value);
                    setUrlError('');
                  }}
                  autoFocus
                  placeholder="https://drive.google.com/drive/folders/…"
                  className="w-full px-3 py-2 min-h-[44px] border border-gray-300 rounded-lg text-sm"
                />
                {pastedIdPreview ? (
                  <p className="text-[11px] text-gray-500 mt-1 break-all">
                    Detected folder ID:{' '}
                    <code className="text-xs">{pastedIdPreview}</code>
                  </p>
                ) : null}
              </div>
              <div>
                <label
                  htmlFor="drive-folder-name"
                  className="block text-xs font-medium text-gray-700 mb-1"
                >
                  Folder label (optional)
                </label>
                <input
                  id="drive-folder-name"
                  type="text"
                  value={pastedName}
                  onChange={(e) => setPastedName(e.target.value)}
                  placeholder="What should we call this folder?"
                  className="w-full px-3 py-2 min-h-[44px] border border-gray-300 rounded-lg text-sm"
                />
                <p className="text-[11px] text-gray-500 mt-1">
                  We'll replace this with the real folder name on the next
                  sync.
                </p>
              </div>
              {urlError ? (
                <div className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded text-sm">
                  {urlError}
                </div>
              ) : null}
            </div>
            <div className="mt-3 flex items-center justify-between gap-2 flex-wrap">
              <button
                type="button"
                onClick={() => {
                  setShowUrlFallback(false);
                  setUrlError('');
                }}
                className="text-sm text-brand-blue underline min-h-[32px]"
              >
                ← Back to search
              </button>
              <div className="flex gap-2 ml-auto">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-4 py-2 min-h-[44px] border border-gray-300 text-gray-700 rounded-lg text-sm"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleConfirmPasted}
                  disabled={!pastedIdPreview}
                  className="px-4 py-2 min-h-[44px] bg-brand-blue hover:bg-brand-blue-dark text-white rounded-lg text-sm font-medium disabled:opacity-50"
                >
                  Link folder
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
