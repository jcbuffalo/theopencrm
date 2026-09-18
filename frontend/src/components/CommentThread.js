// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import api from '../api';
import { useAuth } from '../AuthContext';

// CommentThread — reusable comments-with-@mentions surface (migration 146).
// Drop it on any record view: <CommentThread entityType="deal" entityId={42} />
// Backend: /api/comments (commentRoutes.js) — org-scoped, entity verified
// in-scope server-side, mentions validated in-org.
//
// @mentions: typing "@" in the composer opens an autocomplete over the org's
// members (fetched once from GET /org — empty for personal workspaces, in
// which case the popup simply never has anyone to offer). Picking a member
// inserts "@Their Name" into the text and remembers the id; on submit we send
// the EXPLICIT mentioned_user_ids array (ids whose "@Name" text still appears
// in the body — deleting the text un-mentions them). The server drops
// self-mentions and notifies the rest.
//
// Deliberately renders NO <form> so it can live inside host modals that are
// themselves forms (Cases.js edit modal); every button is type="button".

function relativeTime(ts) {
  if (!ts) return '';
  const diff = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

export default function CommentThread({ entityType, entityId }) {
  const { user } = useAuth();
  const [comments, setComments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [members, setMembers] = useState([]);

  // Composer state
  const [draft, setDraft] = useState('');
  const [posting, setPosting] = useState(false);
  // id → display name of members picked from the autocomplete this draft.
  const [pickedMentions, setPickedMentions] = useState({});
  // @mention autocomplete: null when closed, else { start, query } where
  // start = index of the '@' in the draft.
  const [mention, setMention] = useState(null);
  const textareaRef = useRef(null);

  // Inline edit state
  const [editingId, setEditingId] = useState(null);
  const [editDraft, setEditDraft] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);

  const load = async () => {
    try {
      const r = await api.get(`/comments?entity_type=${entityType}&entity_id=${entityId}`);
      setComments(Array.isArray(r.data) ? r.data : []);
      setError('');
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load comments');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setLoading(true);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityType, entityId]);

  // Org members feed the autocomplete — best-effort, empty for personal
  // workspaces (mirrors the DealPanel owner-picker fetch).
  useEffect(() => {
    api.get('/org')
      .then((r) => setMembers(r.data?.members || []))
      .catch(() => setMembers([]));
  }, []);

  const memberName = (m) => m.name || m.email || `#${m.id}`;

  const mentionMatches = useMemo(() => {
    if (!mention) return [];
    const q = mention.query.toLowerCase();
    return members
      .filter((m) => memberName(m).toLowerCase().includes(q))
      .slice(0, 6);
  }, [mention, members]);

  // Track "@query" at the caret to open/close the autocomplete.
  const onDraftChange = (e) => {
    const value = e.target.value;
    setDraft(value);
    const caret = e.target.selectionStart ?? value.length;
    const upToCaret = value.slice(0, caret);
    const at = upToCaret.lastIndexOf('@');
    if (at >= 0 && (at === 0 || /\s/.test(upToCaret[at - 1]))) {
      const query = upToCaret.slice(at + 1);
      if (!/[\n@]/.test(query) && query.length <= 30) {
        setMention({ start: at, query });
        return;
      }
    }
    setMention(null);
  };

  const pickMention = (m) => {
    const name = memberName(m);
    const caret = textareaRef.current?.selectionStart ?? draft.length;
    const before = draft.slice(0, mention.start);
    const after = draft.slice(caret);
    setDraft(`${before}@${name} ${after}`);
    setPickedMentions((prev) => ({ ...prev, [m.id]: name }));
    setMention(null);
    textareaRef.current?.focus();
  };

  const post = async () => {
    if (!draft.trim() || posting) return;
    setPosting(true);
    setError('');
    try {
      // A picked mention only counts if its "@Name" text survived editing.
      const mentionedIds = Object.entries(pickedMentions)
        .filter(([, name]) => draft.includes(`@${name}`))
        .map(([id]) => Number(id));
      await api.post('/comments', {
        entity_type: entityType,
        entity_id: entityId,
        body: draft.trim(),
        mentioned_user_ids: mentionedIds,
      });
      setDraft('');
      setPickedMentions({});
      setMention(null);
      await load();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to post comment');
    } finally {
      setPosting(false);
    }
  };

  const startEdit = (c) => { setEditingId(c.id); setEditDraft(c.body); };
  const saveEdit = async () => {
    if (!editDraft.trim() || savingEdit) return;
    setSavingEdit(true);
    setError('');
    try {
      await api.put(`/comments/${editingId}`, { body: editDraft.trim() });
      setEditingId(null);
      await load();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to update comment');
    } finally {
      setSavingEdit(false);
    }
  };

  const remove = async (c) => {
    if (!window.confirm('Delete this comment?')) return;
    setError('');
    try {
      await api.delete(`/comments/${c.id}`);
      await load();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to delete comment');
    }
  };

  const isAdmin = ['owner', 'admin'].includes(user?.org_role);
  const canDelete = (c) => Number(c.author_user_id) === Number(user?.id) || isAdmin;
  const isAuthor = (c) => Number(c.author_user_id) === Number(user?.id);

  return (
    <div className="text-xs">
      {error && (
        <div className="mb-2 text-danger-600 bg-danger-50 border border-danger-200 rounded px-2 py-1" role="alert">{error}</div>
      )}

      {loading ? (
        <p className="text-gray-500">Loading comments…</p>
      ) : comments.length === 0 ? (
        <p className="text-gray-500 mb-2">No comments yet — start the thread.</p>
      ) : (
        <ul className="space-y-2 mb-2">
          {comments.map((c) => (
            <li key={c.id} className="border border-gray-200 rounded px-2 py-1.5 bg-white">
              <div className="flex items-baseline justify-between gap-2 flex-wrap">
                <span className="font-semibold text-gray-900">{c.author_name || c.author_email || `User #${c.author_user_id}`}</span>
                <span className="text-[10px] text-gray-400">
                  {relativeTime(c.created_at)}
                  {c.updated_at && c.created_at && new Date(c.updated_at) - new Date(c.created_at) > 60000 ? ' · edited' : ''}
                </span>
              </div>
              {editingId === c.id ? (
                <div className="mt-1">
                  <textarea value={editDraft} onChange={(e) => setEditDraft(e.target.value)} rows={2}
                    className="w-full px-2 py-1 border border-gray-300 rounded text-xs" />
                  <div className="flex justify-end gap-2 mt-1">
                    <button type="button" onClick={() => setEditingId(null)} className="text-gray-500 hover:underline">Cancel</button>
                    <button type="button" onClick={saveEdit} disabled={savingEdit || !editDraft.trim()}
                      className="text-brand-blue hover:underline disabled:opacity-50">
                      {savingEdit ? 'Saving…' : 'Save'}
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <p className="text-gray-700 mt-0.5 whitespace-pre-wrap break-words">{c.body}</p>
                  {(isAuthor(c) || canDelete(c)) && (
                    <div className="flex justify-end gap-2 mt-1">
                      {isAuthor(c) && (
                        <button type="button" onClick={() => startEdit(c)} className="text-gray-400 hover:text-brand-blue">Edit</button>
                      )}
                      {canDelete(c) && (
                        <button type="button" onClick={() => remove(c)} className="text-gray-400 hover:text-danger-600">Delete</button>
                      )}
                    </div>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* Composer — no <form>: the thread can live inside host modals that are
          forms themselves. Cmd/Ctrl+Enter posts. */}
      <div className="relative">
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={onDraftChange}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setMention(null);
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); post(); }
          }}
          rows={2}
          placeholder={members.length > 0 ? 'Add a comment… use @ to mention a teammate' : 'Add a comment…'}
          className="w-full px-2 py-1.5 border border-gray-300 rounded text-xs"
        />
        {mention && mentionMatches.length > 0 && (
          <div className="absolute left-0 bottom-full mb-1 w-64 max-h-40 overflow-y-auto bg-white border border-gray-200 rounded shadow-overlay z-20">
            {mentionMatches.map((m) => (
              <button key={m.id} type="button" onClick={() => pickMention(m)}
                className="block w-full text-left px-3 py-1.5 hover:bg-gray-100 text-xs">
                <span className="font-medium text-gray-900">{m.name || m.email}</span>
                {m.name && m.email && <span className="text-gray-400 ml-2">{m.email}</span>}
              </button>
            ))}
          </div>
        )}
        <div className="flex justify-end mt-1">
          <button type="button" onClick={post} disabled={posting || !draft.trim()}
            className="px-3 py-1 text-xs bg-brand-blue hover:bg-brand-blue-dark text-white rounded disabled:opacity-50">
            {posting ? 'Posting…' : 'Comment'}
          </button>
        </div>
      </div>
    </div>
  );
}
