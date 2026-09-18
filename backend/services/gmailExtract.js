// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Gmail message → plaintext extraction.
//
// Input: a single Gmail message object (users.threads.get(format=full)
// returns a thread.messages[] array; each entry is what we receive here).
// Output: { status, plaintext, attachmentNames[] }.
//
// MIME WALK STRATEGY:
//   Gmail message payloads are a tree of parts. The leaf bodies are
//   base64url-encoded. We:
//
//     1. Walk the tree depth-first, collecting every leaf part.
//     2. PREFER a text/plain leaf if any exists. Gmail multipart/
//        alternative messages always include both text/plain and
//        text/html; the text/plain part is the cleanest source.
//     3. Fall back to text/html → html-to-text conversion if no plain
//        body exists (some senders ship HTML-only).
//     4. Concatenate all matching parts of the chosen type (rare but
//        possible — some clients split long bodies).
//     5. Attachments (filename != '' and disposition != inline) are
//        recorded by NAME ONLY — we do not download their bytes. See
//        migration 093 for the rationale (storage cost + CASA scope
//        creep).
//
// QUOTED-HISTORY STRIPPING:
//   Email bodies routinely carry the entire conversation history quoted
//   underneath each reply. For summarization we want JUST the new content
//   in each message. Two heuristics:
//
//     a. The Gmail-standard "On Fri, Jun 13 2025, alice@example.com wrote:"
//        boundary. We cut everything from that line forward.
//     b. Lines beginning with '>' (RFC 3676 / 5322 quote style). We strip
//        them line-by-line.
//
//   These are intentionally simple — there's a long tail of formats
//   (Outlook's "From: ... Sent: ..." block, the dotted "-----Original
//   Message-----" separator) that we don't catch here. That's fine for
//   the foundation; the follow-up summarization PR can extend the
//   heuristics or hand the raw body to Claude and let the LLM filter.
//
// EXTRACT CONTRACT:
//   { status: 'done',    plaintext: string,  attachmentNames: string[], error: null }
//   { status: 'skipped', plaintext: null,    attachmentNames: [],       error: 'reason' }
//   { status: 'failed',  plaintext: null,    attachmentNames: [],       error: 'message' }

const logger = require('./logger');

// Lazy-loaded html-to-text. Mirrors driveExtract.js. We DO need this dep
// for HTML-only messages; without it we fall back to a crude tag-strip.
let _htmlToText;
function htmlToTextLib() {
  if (_htmlToText !== undefined) return _htmlToText;
  try { _htmlToText = require('html-to-text'); } catch { _htmlToText = null; }
  return _htmlToText;
}

function done(plaintext, attachmentNames) {
  return {
    status: 'done',
    plaintext: String(plaintext || '').trim(),
    attachmentNames: attachmentNames || [],
    error: null,
  };
}
function skipped(reason) {
  return { status: 'skipped', plaintext: null, attachmentNames: [], error: reason };
}
function failed(message) {
  return { status: 'failed', plaintext: null, attachmentNames: [], error: message };
}

/**
 * Base64URL-decode a Gmail body.data string. Gmail uses URL-safe base64
 * without padding; Node's Buffer.from(..., 'base64') accepts both as
 * long as we normalize - → + and _ → /.
 */
function decodeBody(b64url) {
  if (!b64url || typeof b64url !== 'string') return '';
  const normalized = b64url.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(normalized, 'base64').toString('utf8');
}

/**
 * Depth-first walk of payload.parts[]. Yields every leaf part — i.e.
 * every part whose `parts` array is empty or absent. Multipart container
 * parts (multipart/alternative, multipart/mixed) are descended into but
 * not themselves yielded.
 */
function* walkParts(part) {
  if (!part) return;
  const children = part.parts;
  if (Array.isArray(children) && children.length > 0) {
    for (const c of children) yield* walkParts(c);
    return;
  }
  yield part;
}

/**
 * Decide if a part is an attachment (has a filename, not inline). We
 * collect the filename for record-keeping but never download the bytes.
 */
function isAttachment(part) {
  if (!part) return false;
  if (part.filename && part.filename.length > 0) return true;
  // Some clients ship attachments with no filename but a Content-
  // Disposition: attachment header — defensive secondary check.
  const headers = part.headers || [];
  for (const h of headers) {
    if (String(h.name || '').toLowerCase() === 'content-disposition' &&
        /attachment/i.test(String(h.value || ''))) {
      return true;
    }
  }
  return false;
}

/**
 * Strip quoted history from a plaintext body. See module header for the
 * heuristic.
 */
function stripQuotedHistory(text) {
  if (!text) return '';
  const lines = String(text).split(/\r?\n/);
  const out = [];
  // Regex matching the Gmail "On <date>, <addr> wrote:" introducer. We
  // tolerate line wraps (Gmail wraps long lines at ~78 chars by default
  // and the "wrote:" can land on a continuation line) by also matching
  // the un-wrapped form "On ... wrote:" across a window.
  //
  // Conservative pattern: requires the line to start with "On " and
  // contain "wrote:" — common enough to catch ~95% of Gmail / Outlook /
  // Apple Mail boundaries without false positives on body prose. The
  // wider patterns ("On Mon, ...") are also handled here; we don't try
  // to detect the "-----Original Message-----" Outlook divider in this
  // foundation pass.
  const introRe = /^On .*wrote:\s*$/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (introRe.test(line)) break;            // cut from here forward
    if (/^>\s?/.test(line)) continue;          // strip quoted lines
    out.push(line);
  }
  // Collapse 3+ blank lines to 2 (cosmetic — keeps the snippet readable
  // without altering semantics).
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Extract plaintext from one Gmail message payload.
 *
 * @param {object} message — a single entry from thread.messages[]
 *   (the shape users.threads.get(format='full') returns inside .data).
 * @returns {{status, plaintext, attachmentNames, error}}
 */
function extractMessage(message) {
  if (!message || typeof message !== 'object') return failed('no_message');
  const payload = message.payload;
  if (!payload) return failed('no_payload');

  let textPlainBuf = '';
  let textHtmlBuf  = '';
  const attachmentNames = [];

  try {
    for (const part of walkParts(payload)) {
      if (isAttachment(part)) {
        if (part.filename) attachmentNames.push(part.filename);
        continue;
      }
      const mime = String(part.mimeType || '').toLowerCase();
      const data = part.body?.data;
      if (!data) continue;
      // Body data only — attachment bodies are referenced via attachmentId
      // and we don't fetch those here.
      if (mime === 'text/plain') {
        textPlainBuf += (textPlainBuf ? '\n' : '') + decodeBody(data);
      } else if (mime === 'text/html') {
        textHtmlBuf  += (textHtmlBuf ? '\n' : '') + decodeBody(data);
      }
      // Other mime types at the leaf are ignored — they're either
      // attachments (handled above) or container indicators we don't
      // recognize. Logging would be noise.
    }

    // Single-part messages put the body on payload itself, not on a
    // child part. Handle that too.
    if (!textPlainBuf && !textHtmlBuf && payload.body?.data) {
      const mime = String(payload.mimeType || '').toLowerCase();
      if (mime === 'text/plain') {
        textPlainBuf = decodeBody(payload.body.data);
      } else if (mime === 'text/html') {
        textHtmlBuf = decodeBody(payload.body.data);
      }
    }

    let raw;
    if (textPlainBuf) {
      raw = textPlainBuf;
    } else if (textHtmlBuf) {
      const lib = htmlToTextLib();
      if (lib) {
        raw = lib.convert(textHtmlBuf, { wordwrap: false });
      } else {
        // Crude fallback — keeps the pipeline working without html-to-text.
        raw = textHtmlBuf.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
      }
    } else {
      // No body bodies at all (rare — bare attachment-only message).
      return done('', attachmentNames);
    }

    const cleaned = stripQuotedHistory(raw);
    return done(cleaned, attachmentNames);
  } catch (err) {
    logger.warn('gmail_extract_failed', { error: err.message });
    return failed(err.message || 'extract_error');
  }
}

module.exports = {
  extractMessage,
  // Exposed for tests:
  decodeBody,
  stripQuotedHistory,
  walkParts,
  isAttachment,
};
