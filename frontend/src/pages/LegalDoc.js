// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Generic legal-document renderer. Fetches /api/legal/:doc and renders the
// markdown body. Backed by the legal templates in /legal/*.md.

import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import api from '../api';

// Tiny markdown renderer — handles headers, paragraphs, bold, italic, lists,
// inline code, links, blockquotes, and code blocks. Sufficient for the legal
// templates without pulling in a 100KB markdown library.
function renderMarkdown(md) {
  if (!md) return null;
  const lines = md.split('\n');
  const blocks = [];
  let inCode = false, codeLang = '', codeBuf = [];
  let inList = false, listItems = [];
  let para = [];

  const flushPara = () => {
    if (para.length) {
      blocks.push({ type: 'p', text: para.join(' ') });
      para = [];
    }
  };
  const flushList = () => {
    if (listItems.length) {
      blocks.push({ type: 'ul', items: listItems });
      listItems = [];
      inList = false;
    }
  };

  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('```')) {
      flushPara(); flushList();
      if (inCode) { blocks.push({ type: 'code', lang: codeLang, body: codeBuf.join('\n') }); codeBuf = []; codeLang = ''; inCode = false; }
      else { inCode = true; codeLang = line.slice(3).trim(); }
      continue;
    }
    if (inCode) { codeBuf.push(line); continue; }

    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { flushPara(); flushList(); blocks.push({ type: 'h', level: h[1].length, text: h[2] }); continue; }

    if (line.startsWith('> ')) { flushPara(); flushList(); blocks.push({ type: 'blockquote', text: line.slice(2) }); continue; }
    if (/^[-*]\s+/.test(line))  { flushPara(); inList = true; listItems.push(line.replace(/^[-*]\s+/, '')); continue; }
    if (/^\d+\.\s+/.test(line)) { flushPara(); inList = true; listItems.push(line.replace(/^\d+\.\s+/, '')); continue; }

    if (line.trim() === '') { flushPara(); flushList(); continue; }
    if (line.startsWith('---')) { flushPara(); flushList(); blocks.push({ type: 'hr' }); continue; }
    para.push(line);
  }
  flushPara(); flushList();
  if (inCode && codeBuf.length) blocks.push({ type: 'code', lang: codeLang, body: codeBuf.join('\n') });

  // Inline formatting: bold, italic, inline code, links.
  const inline = (text) => {
    // Escape HTML first so we can safely render with dangerouslySetInnerHTML
    let s = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    s = s.replace(/`([^`]+)`/g, '<code class="bg-gray-100 px-1 rounded text-sm">$1</code>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    // inline-block + py-1 align-middle: keeps the link in the text flow but
    // bumps the touch area on phones (the legal body has many inline
    // cross-refs to /privacy, /terms, etc. that otherwise render at 16px
    // line-height — below the audit's 32px tap-target floor).
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a class="text-brand-blue-darker underline inline-block py-1 align-middle" href="$2">$1</a>');
    return s;
  };

  return blocks.map((b, i) => {
    if (b.type === 'h') {
      const sizes = { 1: 'text-3xl font-bold mt-4 mb-3', 2: 'text-2xl font-bold mt-6 mb-3', 3: 'text-xl font-semibold mt-5 mb-2', 4: 'text-lg font-semibold mt-4 mb-2', 5: 'text-base font-semibold mt-3 mb-2', 6: 'text-sm font-semibold mt-3 mb-2' };
      return <div key={i} className={sizes[b.level] + ' text-gray-900'} dangerouslySetInnerHTML={{ __html: inline(b.text) }} />;
    }
    if (b.type === 'p')          return <p key={i} className="text-gray-700 leading-relaxed mb-3" dangerouslySetInnerHTML={{ __html: inline(b.text) }} />;
    if (b.type === 'ul')         return <ul key={i} className="list-disc pl-6 text-gray-700 mb-3 space-y-1">{b.items.map((it, j) => <li key={j} dangerouslySetInnerHTML={{ __html: inline(it) }} />)}</ul>;
    if (b.type === 'blockquote') return <blockquote key={i} className="border-l-4 border-gray-300 pl-4 text-gray-600 italic my-3" dangerouslySetInnerHTML={{ __html: inline(b.text) }} />;
    if (b.type === 'code')       return <pre key={i} className="bg-gray-100 border border-gray-200 rounded p-3 text-xs overflow-x-auto my-3"><code>{b.body}</code></pre>;
    if (b.type === 'hr')         return <hr key={i} className="my-6 border-gray-200" />;
    return null;
  });
}

export default function LegalDoc() {
  const { doc } = useParams();
  const [markdown, setMarkdown] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    setError('');
    api.get(`/legal/${doc}?format=json`)
      .then(r => setMarkdown(r.data.markdown || ''))
      .catch(err => setError(err.response?.data?.error || err.message || 'Failed to load'))
      .finally(() => setLoading(false));
  }, [doc]);

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-3xl mx-auto px-4 py-10">
        <a href="/" className="text-sm text-brand-blue hover:underline inline-flex items-center min-h-[32px] px-1">← Back</a>
        {loading ? (
          <p className="mt-6 text-gray-500">Loading…</p>
        ) : error ? (
          <div className="mt-6 bg-red-50 text-red-700 p-4 rounded">{error}</div>
        ) : (
          <article className="mt-4 bg-white rounded-lg shadow-sm border border-gray-200 p-6 sm:p-8">
            {renderMarkdown(markdown)}
          </article>
        )}
      </div>
    </div>
  );
}
