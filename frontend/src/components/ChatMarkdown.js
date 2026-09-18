// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// ChatMarkdown — a small, safe markdown renderer for copilot replies.
//
// Builds React elements directly (never dangerouslySetInnerHTML), so nothing
// the model emits can become live HTML. Covers what Claude actually writes:
//   headers (#..######), paragraphs, bulleted + numbered lists (one level of
//   nesting by indent), **bold**, *italic*, `inline code`, ``` fenced code,
//   [links](url) (http/https/mailto/relative only; external links open in a
//   new tab with rel=noopener), simple pipe tables, > blockquotes, --- rules.
// Deliberately not CommonMark-complete — no raw HTML, no images, no
// footnotes. Anything unrecognised renders as plain text.

import React from 'react';
import { Link } from 'react-router-dom';

const SAFE_HREF = /^(https?:\/\/|mailto:|\/(?!\/)|#)/i;

function safeHref(url) {
  return SAFE_HREF.test(url) ? url : null;
}

// One combined regex; alternation order matters (bold before italic so the
// `**` opener isn't consumed as an italic `*`). Underscore italics are NOT
// supported on purpose — snake_case identifiers (deal_id) are far more
// common in CRM replies than _emphasis_.
const INLINE_RE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\s][^*\n]*\*)|(\[[^\]\n]+\]\([^)\s]+\))/g;

export function renderInline(text, keyPrefix = 'i') {
  if (!text) return null;
  const out = [];
  let last = 0;
  let n = 0;
  const re = new RegExp(INLINE_RE.source, 'g');
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const key = `${keyPrefix}-${n++}`;
    if (m[1]) {
      out.push(
        <code key={key} className="px-1 py-0.5 rounded bg-gray-200/70 text-[0.9em] font-mono text-gray-800">
          {tok.slice(1, -1)}
        </code>
      );
    } else if (m[2]) {
      out.push(<strong key={key}>{renderInline(tok.slice(2, -2), key)}</strong>);
    } else if (m[3]) {
      out.push(<em key={key}>{renderInline(tok.slice(1, -1), key)}</em>);
    } else if (m[4]) {
      const mm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(tok);
      const label = mm ? mm[1] : tok;
      const href = mm ? safeHref(mm[2]) : null;
      if (!href) {
        out.push(label);
      } else if (href.startsWith('/')) {
        out.push(
          <Link key={key} to={href} className="text-brand-blue underline decoration-brand-blue/40 hover:decoration-brand-blue">
            {renderInline(label, key)}
          </Link>
        );
      } else {
        out.push(
          <a
            key={key}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-brand-blue underline decoration-brand-blue/40 hover:decoration-brand-blue"
          >
            {renderInline(label, key)}
          </a>
        );
      }
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const LIST_RE = /^(\s*)(?:([-*•])|(\d{1,3})[.)])\s+(.*)$/;
const HR_RE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCE_OPEN_RE = /^\s*```\s*([\w+-]+)?\s*$/;
const FENCE_CLOSE_RE = /^\s*```\s*$/;
const TABLE_ROW_RE = /^\s*\|.*\|?\s*$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const QUOTE_RE = /^\s*>\s?/;

function listMatch(line) {
  const m = LIST_RE.exec(line);
  if (!m) return null;
  return { indent: m[1].length, ordered: !!m[3], text: m[4] };
}

function startsBlock(line) {
  return (
    FENCE_OPEN_RE.test(line) || HEADING_RE.test(line) || HR_RE.test(line) ||
    QUOTE_RE.test(line) || !!listMatch(line) || TABLE_ROW_RE.test(line)
  );
}

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').trim());
}

// Turn a flat run of list lines into a (one-level-or-more) tree by indent.
function buildList(items, start, indent) {
  const node = { ordered: items[start].ordered, children: [] };
  let i = start;
  while (i < items.length && items[i].indent >= indent) {
    if (items[i].indent === indent) {
      node.children.push({ text: items[i].text, sub: null });
      i += 1;
    } else {
      const [sub, next] = buildList(items, i, items[i].indent);
      const last = node.children[node.children.length - 1];
      if (last) last.sub = sub;
      else node.children.push({ text: '', sub });
      i = next;
    }
  }
  return [node, i];
}

export function parseBlocks(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  const isBlank = (l) => !l || !l.trim();
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) { i += 1; continue; }

    const fence = FENCE_OPEN_RE.exec(line);
    if (fence) {
      const code = [];
      i += 1;
      while (i < lines.length && !FENCE_CLOSE_RE.test(lines[i])) code.push(lines[i++]);
      i += 1; // closing fence (or EOF)
      blocks.push({ type: 'code', lang: fence[1] || '', code: code.join('\n') });
      continue;
    }
    const h = HEADING_RE.exec(line);
    if (h) { blocks.push({ type: 'h', level: h[1].length, text: h[2] }); i += 1; continue; }
    if (HR_RE.test(line)) { blocks.push({ type: 'hr' }); i += 1; continue; }

    if (TABLE_ROW_RE.test(line) && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1])) {
      const header = splitRow(line);
      const rows = [];
      i += 2;
      while (i < lines.length && TABLE_ROW_RE.test(lines[i])) rows.push(splitRow(lines[i++]));
      blocks.push({ type: 'table', header, rows });
      continue;
    }
    if (QUOTE_RE.test(line)) {
      const q = [];
      while (i < lines.length && QUOTE_RE.test(lines[i])) q.push(lines[i++].replace(QUOTE_RE, ''));
      blocks.push({ type: 'quote', lines: q });
      continue;
    }
    if (listMatch(line)) {
      const items = [];
      while (i < lines.length) {
        const m = listMatch(lines[i]);
        if (m) { items.push(m); i += 1; continue; }
        // Continuation line (indented text under an item) folds into it.
        if (!isBlank(lines[i]) && /^\s{2,}/.test(lines[i]) && items.length) {
          items[items.length - 1].text += ' ' + lines[i].trim();
          i += 1;
          continue;
        }
        break;
      }
      const lists = [];
      let j = 0;
      while (j < items.length) {
        const [node, next] = buildList(items, j, items[j].indent);
        lists.push(node);
        j = next;
      }
      for (const l of lists) blocks.push({ type: 'list', ...l });
      continue;
    }

    const p = [line];
    i += 1;
    while (i < lines.length && !isBlank(lines[i]) && !startsBlock(lines[i])) p.push(lines[i++]);
    blocks.push({ type: 'p', lines: p });
  }
  return blocks;
}

const HEADING_CLASS = {
  1: 'text-lg font-semibold text-gray-900 mt-3 mb-1',
  2: 'text-base font-semibold text-gray-900 mt-3 mb-1',
  3: 'text-sm font-semibold text-gray-900 mt-2 mb-0.5',
};

function renderListNode(node, key) {
  const Tag = node.ordered ? 'ol' : 'ul';
  const cls = node.ordered ? 'list-decimal pl-5 my-1 space-y-0.5' : 'list-disc pl-5 my-1 space-y-0.5';
  return (
    <Tag key={key} className={cls}>
      {node.children.map((c, idx) => (
        <li key={idx}>
          {renderInline(c.text, `${key}-${idx}`)}
          {c.sub ? renderListNode(c.sub, `${key}-${idx}-s`) : null}
        </li>
      ))}
    </Tag>
  );
}

export function renderMarkdown(text) {
  if (!text) return null;
  return parseBlocks(text).map((b, i) => {
    const key = `b${i}`;
    switch (b.type) {
      case 'h': {
        const Tag = `h${Math.min(b.level + 2, 6)}`; // h1 -> h3 visually; the page owns h1/h2
        return <Tag key={key} className={HEADING_CLASS[Math.min(b.level, 3)]}>{renderInline(b.text, key)}</Tag>;
      }
      case 'hr':
        return <hr key={key} className="my-2 border-gray-200" />;
      case 'code':
        return (
          <pre key={key} className="my-2 overflow-x-auto rounded-lg bg-gray-900 text-gray-100 text-xs p-3 leading-relaxed">
            <code data-lang={b.lang || undefined}>{b.code}</code>
          </pre>
        );
      case 'quote':
        return (
          <blockquote key={key} className="my-2 border-l-2 border-gray-300 pl-3 text-gray-600">
            {b.lines.map((ln, j) => (
              <React.Fragment key={j}>
                {renderInline(ln, `${key}-${j}`)}
                {j < b.lines.length - 1 ? <br /> : null}
              </React.Fragment>
            ))}
          </blockquote>
        );
      case 'list':
        return renderListNode(b, key);
      case 'table':
        return (
          <div key={key} className="my-2 overflow-x-auto">
            <table className="min-w-full text-xs sm:text-sm border-collapse">
              <thead>
                <tr>
                  {b.header.map((c, j) => (
                    <th key={j} className="text-left font-semibold text-gray-700 border-b border-gray-300 px-2 py-1">
                      {renderInline(c, `${key}-h${j}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.rows.map((r, ri) => (
                  <tr key={ri} className="border-b border-gray-200 last:border-0">
                    {b.header.map((_, ci) => (
                      <td key={ci} className="px-2 py-1 align-top text-gray-800">
                        {renderInline(r[ci] || '', `${key}-r${ri}c${ci}`)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      case 'p':
      default:
        return (
          <p key={key} className="my-1 leading-relaxed">
            {b.lines.map((ln, j) => (
              <React.Fragment key={j}>
                {renderInline(ln, `${key}-${j}`)}
                {j < b.lines.length - 1 ? <br /> : null}
              </React.Fragment>
            ))}
          </p>
        );
    }
  });
}

export default function ChatMarkdown({ text }) {
  return <>{renderMarkdown(text)}</>;
}
