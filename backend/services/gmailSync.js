// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Gmail integration — per-thread sync orchestrator.
//
// One entry point: `sync({ orgId, dealId, threadLinkId })`. Steps:
//
//   1. Load the thread-link row + verify it matches (orgId, dealId).
//   2. Mark the link as in_progress.
//   3. Fetch the full thread payload via gmail.fetchThread.
//   4. For each message in the thread:
//        - extract plaintext + attachment names via gmailExtract
//        - upsert into email_thread_messages keyed on (gmail_message_id,
//          org_id) so re-running is idempotent.
//   5. Stamp deal_email_threads.last_sync_* + message_count +
//      last_message_at with the outcome.
//
// Returns { synced, skipped, errors }. The route caller is responsible
// for emitting GMAIL_THREAD_SYNCED / GMAIL_THREAD_SYNC_FAILED audit
// events from this return value.
//
// IDEMPOTENT: re-running with no thread changes still re-upserts every
// row (cheap — body_hash short-circuits would buy little since Gmail
// messages are immutable by id, so a second sync of the same message
// produces the same body_text and the same hash). Net effect: rows are
// touched but their data is unchanged.

const crypto = require('crypto');
const pool   = require('../db');
const logger = require('./logger');
const gmail  = require('./gmail');
const gmailExtract = require('./gmailExtract');

function sha256(text) {
  return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

/**
 * Headers helper — Gmail returns payload.headers as [{ name, value }].
 * Return a lowercased map for easy lookup.
 */
function headersOf(message) {
  const out = {};
  for (const h of (message?.payload?.headers || [])) {
    out[String(h.name || '').toLowerCase()] = h.value || '';
  }
  return out;
}

/**
 * Parse a comma-separated header value into trimmed addresses. Tolerates
 * empty / undefined input.
 */
function parseAddrList(raw) {
  if (!raw) return [];
  return String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Run a sync against a single linked thread.
 */
async function sync({ orgId, dealId, threadLinkId }) {
  if (!orgId || !dealId || !threadLinkId) {
    throw new Error('sync requires { orgId, dealId, threadLinkId }');
  }

  // 1. Load + verify the link row.
  const linkRes = await pool.query(
    `SELECT id, org_id, deal_id, gmail_thread_id
       FROM deal_email_threads
      WHERE id = $1 AND org_id = $2 AND deal_id = $3`,
    [threadLinkId, orgId, dealId]
  );
  if (linkRes.rows.length === 0) {
    const err = new Error('Thread link not found for this deal/org');
    err.code = 'THREAD_LINK_NOT_FOUND';
    throw err;
  }
  const link = linkRes.rows[0];

  // 2. Mark in_progress.
  await pool.query(
    `UPDATE deal_email_threads
        SET last_sync_status = 'in_progress',
            last_sync_error  = NULL,
            updated_at       = NOW()
      WHERE id = $1`,
    [threadLinkId]
  );

  let synced = 0;
  let skipped = 0;
  const errors = [];

  try {
    // 3. Fetch the thread.
    const thread = await gmail.fetchThread(orgId, link.gmail_thread_id);
    const messages = thread.messages || [];

    // 4. Extract + upsert each message.
    let latestInternalDate = null;
    for (const m of messages) {
      try {
        const result = gmailExtract.extractMessage(m);
        const h = headersOf(m);
        const internalDate = m.internalDate ? new Date(Number(m.internalDate)) : null;
        if (internalDate && (!latestInternalDate || internalDate > latestInternalDate)) {
          latestInternalDate = internalDate;
        }
        const fromAddr = h.from || null;
        const toAddrs = [...parseAddrList(h.to), ...parseAddrList(h.cc)];
        const subject = h.subject || null;
        const snippet = m.snippet || null;

        if (result.status === 'done') {
          await upsertMessage({
            orgId, threadLinkId, gmailMessageId: m.id,
            internalDate, fromAddr, toAddrs, subject, snippet,
            bodyText: result.plaintext,
            bodyHash: sha256(result.plaintext),
            attachmentNames: result.attachmentNames,
            status: 'done', error: null,
          });
          synced++;
        } else if (result.status === 'skipped') {
          await upsertMessage({
            orgId, threadLinkId, gmailMessageId: m.id,
            internalDate, fromAddr, toAddrs, subject, snippet,
            bodyText: null, bodyHash: null,
            attachmentNames: result.attachmentNames || [],
            status: 'skipped', error: result.error,
          });
          skipped++;
        } else {
          await upsertMessage({
            orgId, threadLinkId, gmailMessageId: m.id,
            internalDate, fromAddr, toAddrs, subject, snippet,
            bodyText: null, bodyHash: null,
            attachmentNames: result.attachmentNames || [],
            status: 'failed', error: result.error,
          });
          errors.push({ gmail_message_id: m.id, error: result.error });
        }
      } catch (err) {
        logger.warn('gmail_sync_message_failed', {
          orgId, threadLinkId, gmail_message_id: m?.id,
          error: err.message,
        });
        errors.push({ gmail_message_id: m?.id, error: err.message });
      }
    }

    // 5. Stamp last_sync_* + message_count + last_message_at.
    await pool.query(
      `UPDATE deal_email_threads
          SET last_sync_at     = NOW(),
              last_sync_status = $2,
              last_sync_error  = $3,
              message_count    = $4,
              last_message_at  = COALESCE($5::timestamptz, last_message_at),
              updated_at       = NOW()
        WHERE id = $1`,
      [
        threadLinkId,
        errors.length > 0 ? 'failed' : 'ok',
        errors.length > 0 ? `${errors.length} message(s) failed` : null,
        messages.length,
        latestInternalDate ? latestInternalDate.toISOString() : null,
      ]
    );

    logger.info('gmail_sync_complete', {
      orgId, threadLinkId,
      messages: messages.length,
      synced, skipped, errors: errors.length,
    });
    return { synced, skipped, errors, messages_total: messages.length };
  } catch (err) {
    await pool.query(
      `UPDATE deal_email_threads
          SET last_sync_at     = NOW(),
              last_sync_status = 'failed',
              last_sync_error  = $2,
              updated_at       = NOW()
        WHERE id = $1`,
      [threadLinkId, err.message || 'sync_failed']
    ).catch(() => {});
    throw err;
  }
}

/**
 * Upsert one email_thread_messages row keyed on (gmail_message_id, org_id).
 */
async function upsertMessage({
  orgId, threadLinkId, gmailMessageId,
  internalDate, fromAddr, toAddrs, subject, snippet,
  bodyText, bodyHash, attachmentNames,
  status, error,
}) {
  await pool.query(
    `INSERT INTO email_thread_messages
       (org_id, thread_link_id, gmail_message_id, internal_date,
        from_addr, to_addrs, subject, snippet, body_text, body_hash,
        attachment_names, extraction_status, extraction_error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (gmail_message_id, org_id) DO UPDATE
       SET thread_link_id    = EXCLUDED.thread_link_id,
           internal_date     = EXCLUDED.internal_date,
           from_addr         = EXCLUDED.from_addr,
           to_addrs          = EXCLUDED.to_addrs,
           subject           = EXCLUDED.subject,
           snippet           = EXCLUDED.snippet,
           body_text         = EXCLUDED.body_text,
           body_hash         = EXCLUDED.body_hash,
           attachment_names  = EXCLUDED.attachment_names,
           extraction_status = EXCLUDED.extraction_status,
           extraction_error  = EXCLUDED.extraction_error,
           updated_at        = NOW()`,
    [
      orgId,
      threadLinkId,
      gmailMessageId,
      internalDate ? internalDate.toISOString() : null,
      fromAddr,
      toAddrs || [],
      subject,
      snippet,
      bodyText,
      bodyHash,
      attachmentNames || [],
      status,
      error,
    ]
  );
}

// ============================================================================
// ORG-WIDE INBOUND SYNC (auto-discovery)
//
// `sync()` above syncs ONE already-linked thread. The functions below add the
// two-way-email capability: an org-wide PULL that fetches recent Gmail threads,
// MATCHES each to a deal by a participant email address, auto-creates the
// deal_email_threads link, and syncs its messages — so inbound replies land on
// the deal/account timeline without a rep manually linking every thread.
//
// GRACEFUL DEGRADATION: syncOrg never throws for "Gmail isn't set up". It
// returns { configured:false } when the OAuth client is unset and
// { connected:false } when the org has no active connection — mirroring
// services/email.js / services/ai.js.
//
// QUOTA: each run does one threads.list + one metadata.get per hit (via
// gmail.searchThreads), then one full threads.get per MATCHED thread (via
// sync()). Bounded by DEFAULT_MAX_THREADS. Non-matched threads cost only the
// metadata fetch. The timestamp cursor (migration 107) keeps each run to
// messages newer than the last sync.
// ============================================================================

const DEFAULT_LOOKBACK_DAYS = 30;   // first-ever sync window when no cursor yet
const DEFAULT_MAX_THREADS   = 50;   // gmail.searchThreads caps at 50 anyway

/**
 * Extract a bare, lowercased email address from a raw header value such as
 * `"Jane Doe" <jane@example.com>`, `jane@example.com`, or `Jane <JANE@x.com>`.
 * Returns null when no address is present. Pure — exported for tests.
 */
function extractEmailAddr(raw) {
  if (!raw) return null;
  const s = String(raw);
  const angle = s.match(/<([^>]+)>/);
  const candidate = angle ? angle[1] : s;
  const m = candidate.match(/[^\s<>,;:"']+@[^\s<>,;:"']+\.[^\s<>,;:"']+/);
  return m ? m[0].trim().toLowerCase() : null;
}

/**
 * Build a Map(email → dealId) from rows shaped { deal_id, email, updated_at }.
 * Rows MUST arrive ordered by updated_at DESC so that when the same email is
 * associated with multiple deals, the MOST RECENTLY updated deal wins (first
 * write wins). Pure — exported for tests.
 */
function buildEmailIndex(rows) {
  const idx = new Map();
  for (const r of rows || []) {
    const email = extractEmailAddr(r.email);
    if (!email) continue;
    if (!idx.has(email)) idx.set(email, r.deal_id);
  }
  return idx;
}

/**
 * Given a thread's participant header strings and an email→deal index, return
 * the dealId of the first participant that matches, else null. Pure — exported
 * for tests.
 */
function matchThreadToDeal(participants, emailIndex) {
  for (const p of participants || []) {
    const email = extractEmailAddr(p);
    if (email && emailIndex.has(email)) return emailIndex.get(email);
  }
  return null;
}

/**
 * Translate the per-connection cursor into a Gmail search query. We use
 * `after:<epoch-seconds>` — Gmail accepts a Unix timestamp there. A 60s
 * overlap on the cursor avoids missing a message that landed mid-run.
 * Pure — exported for tests.
 */
function buildSyncQuery(lastSyncAt, lookbackDays = DEFAULT_LOOKBACK_DAYS) {
  let afterEpoch;
  if (lastSyncAt) {
    afterEpoch = Math.floor(new Date(lastSyncAt).getTime() / 1000) - 60;
  } else {
    afterEpoch = Math.floor((Date.now() - lookbackDays * 86400 * 1000) / 1000);
  }
  if (!Number.isFinite(afterEpoch) || afterEpoch < 0) afterEpoch = 0;
  return `after:${afterEpoch}`;
}

/**
 * Load every (deal_id, email) association for an org so we can match inbound
 * threads to deals. Three sources, unioned:
 *   1. the deal's direct primary contact  (deals.contact_id → contacts.email)
 *   2. the deal's POC email                (deals.poc_email)
 *   3. any contact at the deal's customer/company (contacts.company_id)
 * Ordered updated_at DESC so buildEmailIndex resolves email→deal collisions to
 * the freshest deal. Org-scoped on every table (no cross-tenant reach).
 */
async function loadDealEmailIndex(orgId) {
  const r = await pool.query(
    `SELECT deal_id, email, updated_at FROM (
        SELECT d.id AS deal_id, LOWER(c.email) AS email, d.updated_at
          FROM deals d
          JOIN contacts c ON c.id = d.contact_id
         WHERE d.org_id = $1 AND c.email IS NOT NULL AND c.email <> ''
       UNION ALL
        SELECT d.id AS deal_id, LOWER(d.poc_email) AS email, d.updated_at
          FROM deals d
         WHERE d.org_id = $1 AND d.poc_email IS NOT NULL AND d.poc_email <> ''
       UNION ALL
        SELECT d.id AS deal_id, LOWER(c.email) AS email, d.updated_at
          FROM deals d
          JOIN contacts c ON c.company_id = COALESCE(d.customer_id, d.company_id)
         WHERE d.org_id = $1
           AND COALESCE(d.customer_id, d.company_id) IS NOT NULL
           AND c.org_id = $1
           AND c.email IS NOT NULL AND c.email <> ''
     ) assoc
     ORDER BY updated_at DESC NULLS LAST`,
    [orgId]
  );
  return r.rows;
}

/**
 * Upsert the deal↔thread link for an auto-discovered thread and return its id.
 * ON CONFLICT keeps a pre-existing link_source (so a thread a user linked
 * manually is not silently relabeled 'auto_sync').
 */
async function upsertThreadLink({ orgId, dealId, stub }) {
  const ins = await pool.query(
    `INSERT INTO deal_email_threads
       (org_id, deal_id, gmail_thread_id, subject, participants,
        last_message_at, message_count, link_source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'auto_sync')
     ON CONFLICT (deal_id, gmail_thread_id) DO UPDATE
       SET subject         = EXCLUDED.subject,
           participants    = EXCLUDED.participants,
           last_message_at = EXCLUDED.last_message_at,
           message_count   = EXCLUDED.message_count,
           updated_at      = NOW()
     RETURNING id`,
    [
      orgId,
      dealId,
      stub.gmail_thread_id,
      String(stub.subject || '(no subject)').slice(0, 1000),
      stub.participants || [],
      stub.last_message_at || null,
      stub.message_count || 0,
    ]
  );
  return ins.rows[0].id;
}

/**
 * Run an org-wide inbound sync: discover recent threads, match them to deals by
 * participant email, link + sync the matches.
 *
 * @param {object} opts
 * @param {number} opts.orgId          — required
 * @param {number} [opts.lookbackDays] — window for the first sync (no cursor yet)
 * @param {number} [opts.maxThreads]   — cap on threads scanned per run
 * @returns {Promise<object>} a summary; shape depends on configured/connected state.
 */
async function syncOrg({ orgId, lookbackDays, maxThreads } = {}) {
  if (!orgId) throw new Error('syncOrg requires { orgId }');

  // Graceful degradation: OAuth client not configured at the platform level.
  if (!(await gmail.isConfigured())) {
    return { configured: false, connected: false, reason: 'gmail_not_configured' };
  }

  // Org has no active connection → nothing to do (soft, not an error).
  let conn;
  try {
    conn = await gmail.loadConnection(orgId);
  } catch (err) {
    if (err.code === 'GMAIL_NOT_CONNECTED' || err.code === 'GMAIL_CONNECTION_INACTIVE') {
      return { configured: true, connected: false, reason: err.code };
    }
    throw err;
  }

  await pool.query(
    `UPDATE org_gmail_connections
        SET inbound_sync_status = 'in_progress',
            inbound_sync_error  = NULL,
            updated_at          = NOW()
      WHERE org_id = $1`,
    [orgId]
  );

  try {
    const emailIndex = buildEmailIndex(await loadDealEmailIndex(orgId));

    let threadsScanned = 0;
    let threadsMatched = 0;
    let messagesSynced = 0;
    const threads = [];

    // No deals carry an email → nothing could match. Skip the Gmail fetch
    // entirely (saves quota) but still advance the cursor below.
    if (emailIndex.size > 0) {
      const cap = Number(maxThreads) > 0 ? Number(maxThreads) : DEFAULT_MAX_THREADS;
      const q = buildSyncQuery(conn.last_inbound_sync_at, lookbackDays);
      const stubs = await gmail.searchThreads(orgId, q, cap);
      threadsScanned = stubs.length;

      for (const stub of stubs) {
        const dealId = matchThreadToDeal(stub.participants, emailIndex);
        if (!dealId) continue;
        threadsMatched++;
        try {
          const threadLinkId = await upsertThreadLink({ orgId, dealId, stub });
          const result = await sync({ orgId, dealId, threadLinkId });
          messagesSynced += result.synced;
          threads.push({
            deal_id: dealId,
            thread_link_id: threadLinkId,
            gmail_thread_id: stub.gmail_thread_id,
            synced: result.synced,
          });
        } catch (err) {
          logger.warn('gmail_sync_org_thread_failed', {
            orgId, gmail_thread_id: stub.gmail_thread_id, error: err.message,
          });
        }
      }
    }

    // Advance the cursor to NOW() and stamp bookkeeping.
    await pool.query(
      `UPDATE org_gmail_connections
          SET last_inbound_sync_at      = NOW(),
              inbound_sync_status       = 'ok',
              inbound_sync_error        = NULL,
              last_inbound_synced_count = $2,
              updated_at                = NOW()
        WHERE org_id = $1`,
      [orgId, messagesSynced]
    );

    logger.info('gmail_sync_org_complete', {
      orgId, threadsScanned, threadsMatched, messagesSynced,
    });
    return {
      configured: true,
      connected: true,
      threads_scanned: threadsScanned,
      threads_matched: threadsMatched,
      messages_synced: messagesSynced,
      threads,
    };
  } catch (err) {
    await pool.query(
      `UPDATE org_gmail_connections
          SET inbound_sync_status = 'failed',
              inbound_sync_error  = $2,
              updated_at          = NOW()
        WHERE org_id = $1`,
      [orgId, err.message || 'sync_failed']
    ).catch(() => {});
    throw err;
  }
}

module.exports = {
  sync,
  syncOrg,
  sha256,
  // Exposed for tests:
  headersOf,
  parseAddrList,
  extractEmailAddr,
  buildEmailIndex,
  matchThreadToDeal,
  buildSyncQuery,
  loadDealEmailIndex,
  upsertThreadLink,
};
