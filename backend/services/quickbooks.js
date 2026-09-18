// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// QuickBooks Online integration — OAuth 2.0 + Invoice API.
//
// CONFIG (Cloud Run env vars):
//   QB_CLIENT_ID         — required
//   QB_CLIENT_SECRET     — required
//   QB_ENVIRONMENT       — 'sandbox' or 'production' (default sandbox)
//   QB_REDIRECT_URI      — required, e.g. https://<backend>/api/quickbooks/callback
//
// SCOPE: 'com.intuit.quickbooks.accounting' (full accounting access for the
// realm). We never store the customer's QuickBooks credentials — only the
// OAuth tokens minted by Intuit.
//
// LIABILITY: invoice creation is automated. Operators must review invoice
// templates and accounting categories before enabling. Errors are logged but
// not auto-retried — a human should resolve sync failures.

const crypto = require('crypto');
const pool = require('../db');
const logger = require('./logger');
// Shared AES-256-GCM helper keyed by DRIVE_TOKEN_ENCRYPTION_KEY — CLAUDE.md
// documents that env var as the master key for every in-app-stored integration
// secret (Drive, Gmail, and now QuickBooks). Same encrypt/decrypt contract:
// { ciphertext, iv, tag } Buffers.
const tokenCrypto = require('./driveTokens');

const CLIENT_ID = process.env.QB_CLIENT_ID;
const CLIENT_SECRET = process.env.QB_CLIENT_SECRET;
const ENVIRONMENT = (process.env.QB_ENVIRONMENT || 'sandbox').toLowerCase();
const REDIRECT_URI = process.env.QB_REDIRECT_URI;
const SCOPES = 'com.intuit.quickbooks.accounting';

const ENDPOINTS = {
  authorize: 'https://appcenter.intuit.com/connect/oauth2',
  token:     'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer',
  apiBase:   ENVIRONMENT === 'production'
    ? 'https://quickbooks.api.intuit.com'
    : 'https://sandbox-quickbooks.api.intuit.com',
};

function isConfigured() {
  return !!(CLIENT_ID && CLIENT_SECRET && REDIRECT_URI);
}

function configError() {
  return 'QuickBooks integration not configured. Set QB_CLIENT_ID, QB_CLIENT_SECRET, and QB_REDIRECT_URI.';
}

async function buildAuthUrl({ userId, orgId }) {
  if (!isConfigured()) throw new Error(configError());
  const state = crypto.randomBytes(32).toString('hex');
  await pool.query(
    `INSERT INTO qb_oauth_state (state, user_id, org_id, expires_at)
     VALUES ($1, $2, $3, NOW() + INTERVAL '10 minutes')`,
    [state, userId, orgId]
  );
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    scope: SCOPES,
    redirect_uri: REDIRECT_URI,
    state,
  });
  return `${ENDPOINTS.authorize}?${params}`;
}

async function consumeOAuthState(state) {
  const r = await pool.query(
    `DELETE FROM qb_oauth_state WHERE state = $1 AND expires_at > NOW() RETURNING user_id, org_id`,
    [state]
  );
  return r.rows[0] || null;
}

async function exchangeCodeForTokens(code) {
  if (!isConfigured()) throw new Error(configError());
  const auth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
  });
  const res = await fetch(ENDPOINTS.token, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Accept': 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  if (!res.ok) throw new Error(`Token exchange failed (${res.status}): ${await res.text()}`);
  return res.json();
}

async function refreshAccessToken(refreshToken) {
  if (!isConfigured()) throw new Error(configError());
  const auth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken });
  const res = await fetch(ENDPOINTS.token, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Accept': 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  if (!res.ok) throw new Error(`Refresh failed (${res.status}): ${await res.text()}`);
  return res.json();
}

async function saveConnection({ orgId, userId, realmId, tokens, environment }) {
  // Refuse to persist tokens we can't encrypt. DRIVE_TOKEN_ENCRYPTION_KEY is a
  // required master key in production; if it's somehow absent we fail the
  // connect rather than silently fall back to plaintext (the bug being fixed).
  if (!tokenCrypto.isConfigured()) {
    throw new Error(`Cannot store QuickBooks tokens: ${tokenCrypto.configError()}`);
  }
  const expiresAt = new Date(Date.now() + (tokens.expires_in - 60) * 1000);
  const at = tokenCrypto.encrypt(tokens.access_token);
  const rt = tokenCrypto.encrypt(tokens.refresh_token);
  // Write only ciphertext; explicitly NULL the legacy plaintext columns so an
  // upsert over a pre-encryption row scrubs the plaintext.
  await pool.query(
    `INSERT INTO quickbooks_connections
       (org_id, realm_id,
        access_token_ct, access_token_iv, access_token_tag,
        refresh_token_ct, refresh_token_iv, refresh_token_tag,
        access_token, refresh_token,
        access_token_expires_at, environment, connected_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, NULL, $9, $10, $11)
     ON CONFLICT (org_id) DO UPDATE SET
       realm_id = EXCLUDED.realm_id,
       access_token_ct = EXCLUDED.access_token_ct,
       access_token_iv = EXCLUDED.access_token_iv,
       access_token_tag = EXCLUDED.access_token_tag,
       refresh_token_ct = EXCLUDED.refresh_token_ct,
       refresh_token_iv = EXCLUDED.refresh_token_iv,
       refresh_token_tag = EXCLUDED.refresh_token_tag,
       access_token = NULL,
       refresh_token = NULL,
       access_token_expires_at = EXCLUDED.access_token_expires_at,
       environment = EXCLUDED.environment,
       connected_by = EXCLUDED.connected_by,
       connected_at = NOW(),
       last_sync_status = NULL,
       last_sync_error = NULL`,
    [orgId, realmId, at.ciphertext, at.iv, at.tag, rt.ciphertext, rt.iv, rt.tag, expiresAt, environment || ENVIRONMENT, userId]
  );
}

async function getConnection(orgId) {
  const r = await pool.query(`SELECT * FROM quickbooks_connections WHERE org_id = $1`, [orgId]);
  return r.rows[0] || null;
}

/**
 * Decrypt a connection row's stored tokens. Returns { accessToken, refreshToken }.
 * Falls back to the legacy plaintext columns for rows written before encryption
 * landed (those get re-encrypted on the next saveConnection). Decryption of a
 * tampered/wrong-key ciphertext throws — callers surface that as "reconnect".
 */
function decryptTokens(conn) {
  const accessToken = conn.access_token_ct
    ? tokenCrypto.decrypt({ ciphertext: conn.access_token_ct, iv: conn.access_token_iv, tag: conn.access_token_tag })
    : conn.access_token;
  const refreshToken = conn.refresh_token_ct
    ? tokenCrypto.decrypt({ ciphertext: conn.refresh_token_ct, iv: conn.refresh_token_iv, tag: conn.refresh_token_tag })
    : conn.refresh_token;
  return { accessToken, refreshToken };
}

async function ensureFreshToken(orgId) {
  const conn = await getConnection(orgId);
  if (!conn) return null;
  if (new Date(conn.access_token_expires_at).getTime() > Date.now() + 30_000) {
    const { accessToken } = decryptTokens(conn);
    return { ...conn, access_token: accessToken };
  }
  const { refreshToken } = decryptTokens(conn);
  const fresh = await refreshAccessToken(refreshToken);
  await saveConnection({
    orgId, userId: conn.connected_by, realmId: conn.realm_id, tokens: fresh, environment: conn.environment,
  });
  const updated = await getConnection(orgId);
  const { accessToken } = decryptTokens(updated);
  return { ...updated, access_token: accessToken };
}

async function disconnect(orgId) {
  await pool.query(`DELETE FROM quickbooks_connections WHERE org_id = $1`, [orgId]);
}

async function callApi(orgId, method, path, body) {
  const conn = await ensureFreshToken(orgId);
  if (!conn) throw new Error('QuickBooks not connected for this org');
  const url = `${ENDPOINTS.apiBase}/v3/company/${conn.realm_id}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      'Authorization': `Bearer ${conn.access_token}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`QB API ${method} ${path} → ${res.status}`);
    err.payload = json;
    throw err;
  }
  return json;
}

/**
 * Create an invoice in QuickBooks for a given deal. Stores the resulting
 * Invoice.Id on the deal so we don't double-fire.
 *
 * Note: this minimal implementation creates a draft invoice with a single line
 * referencing a generic Service item. Production deployments will likely want
 * to map line items to real QB Items/Services and to a customer record. For
 * MVP, the operator runs this once, sees the invoice, then fills in the
 * mapping logic that fits their accounting setup.
 */
async function createInvoiceForDeal(deal) {
  if (!deal.qb_invoice_id) {
    const lineAmount = Number(deal.amount || 0) || 0;
    if (lineAmount <= 0) {
      throw new Error('Cannot create invoice — deal has no amount');
    }
    // Find or create a Customer record on the QB side (best-effort: looked up
    // by display name; falls back to creating one).
    const customerName = deal.customer_name || deal.poc_name || `Customer ${deal.customer_id || ''}`.trim();
    const safeName = customerName.replace(/'/g, '\\\'');
    const findRes = await callApi(deal.org_id, 'GET', `/query?query=${encodeURIComponent(`select Id from Customer where DisplayName = '${safeName}'`)}`);
    let qbCustomerId = findRes?.QueryResponse?.Customer?.[0]?.Id;
    if (!qbCustomerId) {
      const created = await callApi(deal.org_id, 'POST', '/customer', { DisplayName: customerName });
      qbCustomerId = created?.Customer?.Id;
    }
    if (!qbCustomerId) throw new Error('Could not find or create QB customer');

    const invoiceBody = {
      CustomerRef: { value: String(qbCustomerId) },
      Line: [{
        DetailType: 'SalesItemLineDetail',
        Amount: lineAmount,
        Description: deal.title,
        SalesItemLineDetail: {
          // Product/service id 1 is QB's default in sandbox companies; operators
          // should replace with their real item id.
          ItemRef: { value: '1' },
        },
      }],
      // Optional reference fields for traceability back to the CRM
      DocNumber: deal.po_number ? String(deal.po_number).slice(0, 21) : undefined,
      PrivateNote: `Created automatically by The Open CRM. Deal #${deal.id}.`,
    };
    const inv = await callApi(deal.org_id, 'POST', '/invoice', invoiceBody);
    const invoiceId = inv?.Invoice?.Id;
    if (!invoiceId) throw new Error('QB returned no invoice id');

    await pool.query(
      `UPDATE deals SET qb_invoice_id = $1, qb_invoiced_at = NOW(), updated_at = NOW() WHERE id = $2`,
      [String(invoiceId), deal.id]
    );
    await pool.query(
      `UPDATE quickbooks_connections SET last_sync_at = NOW(), last_sync_status = 'invoice_created', last_sync_error = NULL WHERE org_id = $1`,
      [deal.org_id]
    );
    return { invoiceId, customerId: qbCustomerId, amount: lineAmount };
  }
  return { invoiceId: deal.qb_invoice_id, alreadyExisted: true };
}

module.exports = {
  isConfigured,
  configError,
  buildAuthUrl,
  consumeOAuthState,
  exchangeCodeForTokens,
  saveConnection,
  getConnection,
  decryptTokens,
  disconnect,
  createInvoiceForDeal,
  refreshAccessToken,
  ENVIRONMENT,
};
