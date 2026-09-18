// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Structured JSON logger for Cloud Logging.
//
// Cloud Run automatically ingests stdout/stderr into Cloud Logging. By emitting
// structured JSON, logs become queryable by field (severity, requestId, userId,
// etc.) without parsing free-text. We deliberately avoid heavy logging libs to
// keep the runtime footprint low; this is a thin wrapper that any future
// logger (winston, pino) can replace without touching call sites.
//
// LIABILITY: This module emits operational logs only. It is the operator's
// responsibility to ensure that logs do not contain personally-identifiable
// information beyond what is necessary for support, and to set retention
// appropriate to applicable regulations. See the project LICENSE for the
// complete liability disclaimer.

const SEVERITIES = {
  DEBUG: 'DEBUG',
  INFO: 'INFO',
  NOTICE: 'NOTICE',
  WARN: 'WARNING',
  ERROR: 'ERROR',
  CRITICAL: 'CRITICAL',
};

const SENSITIVE_KEYS = new Set([
  'password', 'token', 'authorization', 'cookie', 'secret', 'apikey', 'api_key',
  'access_token', 'refresh_token', 'jwt', 'privatekey', 'private_key', 'gcs_object_path',
  'content', 'gmail_app_password', 'sendgrid_api_key',
]);

function redact(obj, depth = 0) {
  if (depth > 5) return '[depth-limit]';
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.slice(0, 20).map(v => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SENSITIVE_KEYS.has(k.toLowerCase())) {
      out[k] = '[redacted]';
    } else if (v instanceof Error) {
      out[k] = { message: v.message, stack: v.stack, name: v.name };
    } else {
      out[k] = redact(v, depth + 1);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// GCP Error Reporting integration.
//
// Error Reporting auto-ingests Cloud Logging entries that either (a) carry a
// parseable stack trace in `message` at severity >= ERROR, or (b) declare the
// ReportedErrorEvent @type (which makes even stack-less errors group). We do
// both for ERROR/CRITICAL: append the first Error's stack found in the fields
// to `message`, stamp the @type, and attach serviceContext so the Error
// Reporting console attributes the group to the right service. Callers can
// override serviceContext per-entry (the /api/client-errors receiver uses
// { service: 'synccrm-frontend' } so browser crashes group separately).
// ---------------------------------------------------------------------------
const REPORTED_ERROR_EVENT_TYPE =
  'type.googleapis.com/google.devtools.clouderrorreporting.v1beta1.ReportedErrorEvent';
const DEFAULT_SERVICE_CONTEXT = {
  service: process.env.LOG_SERVICE_NAME || 'synccrm-backend',
};

// Best-effort: find a stack trace in the fields we were handed. Checks the
// conventional keys first (error / err), then any own value that looks like
// an Error or carries a string `.stack`.
function findStack(fields) {
  if (!fields || typeof fields !== 'object') return null;
  const candidates = [fields.error, fields.err, ...Object.values(fields)];
  for (const v of candidates) {
    if (!v) continue;
    if (v instanceof Error && typeof v.stack === 'string') return v.stack;
    if (typeof v === 'object' && typeof v.stack === 'string') return v.stack;
  }
  return null;
}

function emit(severity, message, fields = {}) {
  const entry = {
    severity,
    message,
    timestamp: new Date().toISOString(),
    ...redact(fields),
  };
  if (severity === SEVERITIES.ERROR || severity === SEVERITIES.CRITICAL) {
    // Fields may carry an explicit serviceContext (redact passes it through);
    // otherwise stamp this service's own.
    entry['@type'] = REPORTED_ERROR_EVENT_TYPE;
    if (!entry.serviceContext || typeof entry.serviceContext !== 'object') {
      entry.serviceContext = DEFAULT_SERVICE_CONTEXT;
    }
    // A stack in `message` is what makes Error Reporting group by code
    // location rather than by message string. `stack` may also already be a
    // pre-composed string field (client-error reports build one).
    const stack = findStack(fields)
      || (typeof fields.stack === 'string' ? fields.stack : null);
    if (stack && !String(entry.message).includes(stack)) {
      entry.message = `${message}\n${stack}`;
    }
  }
  // Cloud Run aggregates stdout — single line per record.
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(entry));
}

function bind(baseFields = {}) {
  return {
    debug:    (msg, f) => emit(SEVERITIES.DEBUG,    msg, { ...baseFields, ...f }),
    info:     (msg, f) => emit(SEVERITIES.INFO,     msg, { ...baseFields, ...f }),
    notice:   (msg, f) => emit(SEVERITIES.NOTICE,   msg, { ...baseFields, ...f }),
    warn:     (msg, f) => emit(SEVERITIES.WARN,     msg, { ...baseFields, ...f }),
    error:    (msg, f) => emit(SEVERITIES.ERROR,    msg, { ...baseFields, ...f }),
    critical: (msg, f) => emit(SEVERITIES.CRITICAL, msg, { ...baseFields, ...f }),
    child:    (extra)  => bind({ ...baseFields, ...extra }),
  };
}

module.exports = bind();
module.exports.bind = bind;
