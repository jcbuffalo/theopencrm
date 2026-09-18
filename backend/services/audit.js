// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Append-only audit log for security-sensitive events.
//
// Writes to the `audit_log` table. Failures here are NEVER allowed to break the
// originating request — they're logged via the structured logger and discarded.
// If you need stronger guarantees (e.g. sealed/tamper-evident logging), this is
// the seam to extend.

const pool = require('../db');
const logger = require('./logger');

const EVENTS = {
  AUTH_LOGIN_SUCCESS:  'auth.login.success',
  AUTH_LOGIN_FAIL:     'auth.login.fail',
  AUTH_REGISTER:       'auth.register',
  AUTH_GOOGLE_SIGNIN:  'auth.google_signin',
  AUTH_LOGOUT:         'auth.logout',
  PASSWORD_CHANGE:     'auth.password_change',
  // Two-factor challenge events. CHALLENGE fires when a user with 2FA enabled
  // gets the tempToken back from /auth/login (or /auth/google-signin). SUCCESS
  // / FAIL fire from /auth/2fa/verify based on TOTP outcome. Separate from
  // 2fa.enabled (the enrollment-side event) so dashboards can distinguish
  // "user set it up" from "user used it at login time".
  LOGIN_2FA_CHALLENGE: 'auth.login.2fa_challenge',
  LOGIN_2FA_SUCCESS:   'auth.login.2fa_success',
  LOGIN_2FA_FAIL:      'auth.login.2fa_fail',
  ORG_INVITE_SENT:     'org.invite.sent',
  ORG_INVITE_ACCEPTED: 'org.invite.accepted',
  ORG_MEMBER_REMOVED:  'org.member.removed',
  RECORD_DELETED:      'record.deleted',
  // Data enrichment (services/enrichment.js). RECORD_ENRICHED fires on every
  // POST /:id/enrich proposal fetch — including the graceful not-configured
  // path — with meta carrying { configured, cached }. RECORD_ENRICHMENT_APPLIED
  // fires when a human accepts fields into the record's custom_fields JSONB;
  // meta carries the applied key list. targetType is 'contact' | 'company'.
  RECORD_ENRICHED:            'record.enriched',
  RECORD_ENRICHMENT_APPLIED:  'record.enrichment_applied',
  DOCUMENT_DOWNLOAD:   'document.download',
  RFQ_SENT:            'vendor_rfq.sent',
  QUOTE_PDF_GENERATED: 'quote.pdf.generated',
  // Generic light-CPQ catalog + quote builder (routes/productRoutes.js +
  // routes/salesQuoteRoutes.js). Separate from the bespoke Zang quote events
  // above. Meta shapes:
  //   PRODUCT_CREATED           — { name, sku }
  //   SALES_QUOTE_CREATED       — { item_count, total }
  //   SALES_QUOTE_PDF_GENERATED — {} (targetId identifies the quote)
  PRODUCT_CREATED:            'product.created',
  SALES_QUOTE_CREATED:       'sales_quote.created',
  SALES_QUOTE_PDF_GENERATED: 'sales_quote.pdf.generated',
  // Self-service profile + notification surface (see routes/meRoutes.js). The
  // string values MUST stay byte-identical to the literals that have been
  // written to audit_log historically so old queries keep matching new rows.
  PROFILE_UPDATED:                  'me.profile.updated',
  NOTIFICATION_PREFERENCES_UPDATED: 'me.notification_preferences.updated',
  // Bulk operations + saved views — added with migration 068. One audit row
  // per bulk call (not per affected record) so audit-log volume stays bounded
  // even on 1000-row bulk patches. The meta payload carries the full id list
  // and the patch object so the action is fully reconstructible.
  BULK_UPDATE:         'bulk.update',
  BULK_DELETE:         'bulk.delete',
  SAVED_VIEW_CREATED:  'saved_view.created',
  // Custom report builder — a named report definition was persisted
  // (routes/reportBuilderRoutes.js). Meta carries name + entity.
  SAVED_REPORT_CREATED: 'saved_report.created',
  // Sales-forecasting quota targets (routes/forecastRoutes.js). Meta carries
  // period_type + period_start + target_amount.
  SALES_QUOTA_CREATED: 'sales_quota.created',
  SALES_QUOTA_DELETED: 'sales_quota.deleted',
  // Commission plans (routes/commissionRoutes.js). Meta carries owner_id +
  // rate_pct + goal_amount + effective_from.
  COMMISSION_PLAN_CREATED: 'commission_plan.created',
  COMMISSION_PLAN_UPDATED: 'commission_plan.updated',
  COMMISSION_PLAN_DELETED: 'commission_plan.deleted',
  // One-off email dispatch via the in-CRM composer (routes/emailRoutes.js).
  // Recorded on every /api/emails/send call, including the graceful-fallback
  // "transport not configured" path — the meta payload carries the transport
  // kind so a forensic reader can tell real-sends from console-only rows.
  EMAIL_SENT:          'email.sent',
  // Template preview / "render only" — no send, no email_sends row. Recorded
  // so the audit log shows authors poking at templates against real merge
  // data. Meta carries template_id and the to_email used for resolution.
  EMAIL_TEMPLATE_PREVIEW: 'email.template.preview',
  // Conversational search via /api/ai/search. One row per call, with the
  // raw query + Claude-derived resource + final filter JSON in meta. Lets us
  // audit "did the model send the user to the wrong page" later, and gives
  // us a usage signal for the differentiation-bet feature.
  CONVERSATIONAL_SEARCH: 'ai.conversational_search',
  // Claude-authored org customization applied (Differentiation Bet #2). Meta
  // carries the full proposal { actions: [...] } plus the verbatim natural-
  // language request so a reviewer can reconstruct intent. Critical for
  // forensics if a customization later turns out to be wrong.
  CUSTOMIZATION_APPLIED: 'customization.applied',
  // Sandboxed plugin invocation — recorded on every run, success or fail,
  // including rejections. The `meta` payload carries runId, status,
  // triggerSource, cpu_ms, db_queries — enough to reconstruct what the
  // plugin did without copying its potentially-PII output_payload.
  PLUGIN_RUN:          'plugin.run',
  // Customer cloned a curated library template into their workspace as a
  // draft plugin (POST /api/plugins/from-template). Meta carries
  //   { template_slug, plugin_id, name }
  // so a forensic reader can reconstruct which template seeded which row.
  // The created plugin is ALWAYS status='draft' — see services/pluginLibrary.js
  // for the curated specs.
  PLUGIN_CLONED_FROM_TEMPLATE: 'plugin.cloned_from_template',
  // A confirm-first plugin proposal was APPLIED by a human (POST
  // /api/plugins/:id/apply). One row per applied write. Meta carries
  //   { runId, plugin_id, op }
  // with targetType/targetId on the row identifying the record written. This
  // is the plugin analogue of AI_ACTION_APPLIED — the plugin sandbox never
  // writes directly; this event marks the human-approved write.
  PLUGIN_ACTION_APPLIED: 'plugin.action_applied',
  // An org owner/admin changed a plugin's run mode (migration 167 —
  // 'preview' confirm-first vs 'autonomous' auto-apply). Meta carries
  //   { old, new } plus how it was changed (route | install | chat)
  // so a forensic reader can reconstruct exactly when a plugin was granted
  // (or stripped of) the right to apply its own writes.
  PLUGIN_RUN_MODE_CHANGED: 'plugin.run_mode_changed',
  // Chat-First copilot turn (POST /api/ai/chat). One row per user message
  // submitted. Meta carries session_id, the user's message text, the
  // assistant reply, and the array of tool calls Claude made — full
  // reconstruction without leaking customer PII into a separate analytics
  // pipeline. Critical for "did the copilot send the user somewhere wrong"
  // forensics.
  CHAT_MESSAGE:        'ai.chat_message',
  // Self-service debug-mode tool invocation. Fires once per Claude-issued
  // tool call inside the chat copilot when the user has the debug surface
  // engaged (recent_audit_events, inspect_plugin_run, email_send_history,
  // etc.). Meta carries { tool, args, scope } — scope is either 'org'
  // (every customer tool, hard-scoped to req.orgId) or 'super_admin'
  // (cross-tenant tools gated on req.adminRole === 'super_admin'). This
  // is what lets us spot patterns like "every Acme user asks 'why didn't
  // my plugin run'" and decide what to build next.
  DEBUG_TOOL_INVOKED:  'ai.debug_tool_invoked',
  // Communications surface (migration 121). SMS_SENT fires on every /api/sms
  // send, including the graceful "would-have-sent" path — meta carries the
  // send status + raw adapter outcome so a forensic reader can tell a real
  // Twilio send from a skipped one. CALL_LOGGED fires on every /api/calls/log
  // "log a call" action (which writes an activities(type='call') row).
  SMS_SENT:            'sms.sent',
  CALL_LOGGED:         'call.logged',
  // Per-Claude-call token-usage recorded into ai_usage_events (migration
  // 080). Fire-and-forget alongside the ledger insert in
  // services/aiMetering.recordUsage. Meta carries endpoint + model +
  // input/output/cache token counts + raw and upcharged cost in
  // micro-dollars. Lets a forensic reader reconstruct billing without
  // joining the ledger table directly.
  AI_USAGE_RECORDED:   'ai.usage_recorded',
  // First sighting (per process restart) of a Claude model id that doesn't
  // appear in services/aiMetering.MODEL_PRICING_PER_M_TOKENS. Fired alongside
  // a console.warn the very first time the unknown id is metered. Pricing
  // falls back to Sonnet rates — see comment in aiMetering.js. Acts as an
  // early-warning so we update the price table when a new Anthropic model
  // gets rolled out via ANTHROPIC_MODEL on the deployment.
  AI_UNKNOWN_MODEL_FALLBACK: 'ai.unknown_model_fallback',
  // Drive Intel (Differentiation Bet #4, see DRIVE_INTEL_SPEC.md). Meta shapes:
  //   DRIVE_CONNECTED       — { google_user_email, scopes }            (auth callback)
  //   DRIVE_DISCONNECTED    — { revoke_outcome }                       (DELETE /connection)
  //   DRIVE_FOLDER_LINKED   — { deal_id, drive_folder_id, folder_name } (POST link)
  //   DRIVE_FOLDER_UNLINKED — { deal_id, drive_folder_id }              (DELETE link)
  //   DRIVE_SYNCED          — { deal_id, folder_link_id, synced, skipped, errors, removed }
  //   DRIVE_SYNC_FAILED     — { deal_id, folder_link_id, error }
  //   DRIVE_INTEL_GENERATED — { deal_id, folder_link_id, files_analyzed, tokens_input, tokens_output }
  DRIVE_CONNECTED:       'drive.connected',
  DRIVE_DISCONNECTED:    'drive.disconnected',
  DRIVE_FOLDER_LINKED:   'drive.folder_linked',
  DRIVE_FOLDER_UNLINKED: 'drive.folder_unlinked',
  DRIVE_SYNCED:          'drive.synced',
  DRIVE_SYNC_FAILED:     'drive.sync_failed',
  DRIVE_INTEL_GENERATED: 'drive.intel_generated',
  // Drive Intel — write-back-to-CRM (Phase 2; migration 090). Suggestions
  // are proposed against an allowlist of writeable deal fields (stage,
  // notes, expected_close_date); customers Apply/Reject per row. Apply'd
  // writes are auditable + undoable for 7 days.
  //   DEAL_INTEL_SUGGESTED — { deal_id, summary_id, suggestion_count, fields: [...] }
  //     Fired once per services/intelWriteback.proposeUpdates() call, regardless
  //     of how many suggestion rows were inserted. `fields` is the array of
  //     allowlisted field names actually proposed.
  //   DEAL_INTEL_APPLIED   — { deal_id, suggestion_id, writeback_id, field,
  //                            prior_value, new_value }
  //     Fired once per successful applySuggestion() call. prior_value /
  //     new_value are the JSON-shaped scalars (string / date / etc.) that
  //     went onto the deal — same shape the writebacks row stores.
  //   DEAL_INTEL_UNDONE    — { deal_id, writeback_id, field, restored_value }
  //     Fired once per successful undoWriteback() call. restored_value is
  //     what we set the field back to (i.e. the writeback row's prior_value).
  DEAL_INTEL_SUGGESTED: 'deal.intel.suggested',
  DEAL_INTEL_APPLIED:   'deal.intel.applied',
  DEAL_INTEL_UNDONE:    'deal.intel.undone',
  // Platform Integrations (PLATFORM_INTEGRATIONS_SPEC.md). Fires when a
  // super-admin saves/clears credentials for a platform-level integration
  // (Drive in Phase 1; Gmail / Stripe / Teams / Zoom later). Meta shapes:
  //   PLATFORM_INTEGRATION_UPDATED — { integration, has_secret, config_keys }
  //   PLATFORM_INTEGRATION_CLEARED — { integration }
  // The secret VALUE is never written to the audit log — only whether one
  // was provided, plus the set of config keys touched. config_keys is the
  // shape of the JSONB payload, not the values, so an attacker who reads
  // the audit log can't recover client IDs / redirect URIs either.
  PLATFORM_INTEGRATION_UPDATED: 'platform_integration.updated',
  PLATFORM_INTEGRATION_CLEARED: 'platform_integration.cleared',
  // Bring-your-own Anthropic key per org (migration 154, services/orgAiKeys.js).
  // Fired from routes/orgAiKeyRoutes.js. Meta shapes:
  //   ORG_AI_KEY_SET     — { provider, key_last4, validated, last_error }
  //   ORG_AI_KEY_CLEARED — { provider }
  // The key VALUE is never written — only its last 4 characters.
  ORG_AI_KEY_SET:     'org.ai_key.set',
  ORG_AI_KEY_CLEARED: 'org.ai_key.cleared',
  // Org provisioning via backend/scripts/provision-org.js (CLI) or
  // POST /api/admin/provision-org (super-admin REST). Meta carries
  //   { action: 'rename'|'create', name, profile, branding, adminEmail,
  //     featureFlagsSet: [...], seedDemo, actorUserId, dryRun }
  // Dry-runs fire this event too (with dryRun: true) so a forensic reader
  // can see "someone modeled this before doing it." The endpoint is
  // super-admin only; the CLI runs as the operator (actorUserId: null).
  ORG_PROVISIONED: 'org.provisioned',
  // Gmail integration foundation (mirror of Drive events; summarization
  // event lands with the follow-up PR). Meta shapes:
  //   GMAIL_CONNECTED          — { google_user_email, scopes }                           (auth callback)
  //   GMAIL_DISCONNECTED       — { revoked }                                             (DELETE /connection)
  //   GMAIL_THREAD_LINKED      — { deal_id, gmail_thread_id, subject }                   (POST link)
  //   GMAIL_THREAD_UNLINKED    — { deal_id, gmail_thread_id }                            (DELETE link)
  //   GMAIL_THREAD_SYNCED      — { deal_id, thread_link_id, messages_synced, messages_skipped, errors }
  //   GMAIL_THREAD_SYNC_FAILED — { deal_id, thread_link_id, error }
  // The plaintext body of any individual message is NEVER written to the
  // audit log — only counts + ids. A forensic reader who can see the
  // audit log already has DB access and can read email_thread_messages
  // directly; we don't want a second copy duplicated here.
  GMAIL_CONNECTED:          'gmail.connected',
  GMAIL_DISCONNECTED:       'gmail.disconnected',
  GMAIL_THREAD_LINKED:      'gmail.thread_linked',
  GMAIL_THREAD_UNLINKED:    'gmail.thread_unlinked',
  GMAIL_THREAD_SYNCED:      'gmail.thread_synced',
  GMAIL_THREAD_SYNC_FAILED: 'gmail.thread_sync_failed',
  // Org-wide inbound sync (migration 107 + services/gmailSync.syncOrg). Fires
  // once per POST /api/gmail/sync and once per worker tick per org. Meta shapes:
  //   GMAIL_ORG_SYNCED      — { threads_scanned, threads_matched, messages_synced }
  //   GMAIL_ORG_SYNC_FAILED — { error }
  // As with the per-thread events, message bodies are NEVER written here.
  GMAIL_ORG_SYNCED:         'gmail.org_synced',
  GMAIL_ORG_SYNC_FAILED:    'gmail.org_sync_failed',
  // Gmail Intel — Phase 2 (migration 094). Fires once per successful
  // services/gmailSummary.generate() call. Meta shape:
  //   GMAIL_INTEL_GENERATED — { deal_id, thread_link_id, messages_analyzed,
  //                             tokens_input, tokens_output }
  // The plaintext body of any individual message is NEVER written to the
  // audit log — only counts + ids. A forensic reader who can see the audit
  // log already has DB access and can read email_thread_messages directly;
  // we don't want a second copy duplicated here.
  GMAIL_INTEL_GENERATED:    'gmail.intel_generated',
  // Per-org AI model + effort change via /api/admin/ai-model. Fired once per
  // successful PATCH. Meta shape:
  //   { before: { model, effort }, after: { model, effort }, fields: ['model'|'effort', ...] }
  // The fallback chain means a NULL row column resolves to env / default;
  // before/after snapshot what the resolver returned both sides of the write,
  // so a forensic reader can see the effective change even if only one column
  // was touched.
  SETTINGS_AI_MODEL_CHANGED: 'settings.ai_model.changed',

  // AI pay-as-you-go billing (Stripe product prod_Uj9hvCriplpPrA, env
  // STRIPE_PRICE_AI_USAGE). Fires from routes/billingRoutes.js and the
  // webhook handler, plus services/aiThresholdWorker.js. Meta shapes:
  //   BILLING_AI_CHECKOUT_STARTED — { sessionId }
  //   BILLING_AI_ACTIVATED        — { subscriptionId, priceId }
  //   BILLING_AI_PAST_DUE         — { subscriptionId }
  //   BILLING_AI_CANCELLED        — { subscriptionId }
  //   BILLING_AI_HALTED           — { reason, prior_status }
  //   BILLING_AI_RESUMED          — { restored_status }
  //   BILLING_AI_COMPED           — { target_org_id }
  //   BILLING_AI_TRIAL_STARTED    — { target_org_id, days, trial_ends_at }
  //   BILLING_AI_THRESHOLD_WARNED — { mtd_usage_usd, threshold_usd, period }
  // No customer PII or Stripe secrets are written to meta.
  BILLING_AI_CHECKOUT_STARTED: 'billing.ai_checkout_started',
  BILLING_AI_ACTIVATED:        'billing.ai_activated',
  BILLING_AI_PAST_DUE:         'billing.ai_past_due',
  BILLING_AI_CANCELLED:        'billing.ai_cancelled',
  BILLING_AI_HALTED:           'billing.ai_halted',
  BILLING_AI_RESUMED:          'billing.ai_resumed',
  BILLING_AI_COMPED:           'billing.ai_comped',
  BILLING_AI_TRIAL_STARTED:    'billing.ai_trial_started',
  BILLING_AI_THRESHOLD_WARNED: 'billing.ai_threshold_warned',

  // Chat copilot write-actions (Spec 200 — confirm-first action tools). The
  // copilot's propose_* tools never write; they validate + ownership-check and
  // return a proposal, firing AI_ACTION_PROPOSED. The lone writer is
  // POST /api/ai/actions/apply, which re-validates and (on success) fires
  // AI_ACTION_APPLIED. Meta shapes:
  //   AI_ACTION_PROPOSED — { op, fields: [...allowlisted field names...] }
  //   AI_ACTION_APPLIED  — { op, fields: [...] }  (targetType/targetId on the row)
  // No raw field VALUES are written to meta — only the op + the set of field
  // names touched, mirroring the platform-integration / bulk-update convention.
  AI_ACTION_PROPOSED:  'ai.action_proposed',
  AI_ACTION_APPLIED:   'ai.action_applied',

  // Developer platform (migrations 108/109). API-key lifecycle + outbound
  // webhook management. The key VALUE is never written to meta — only the
  // non-secret key_prefix + name. The webhook signing secret is never logged.
  API_KEY_CREATED:  'api_key.created',
  API_KEY_REVOKED:  'api_key.revoked',
  WEBHOOK_CREATED:  'outbound_webhook.created',
  WEBHOOK_DELETED:  'outbound_webhook.deleted',

  // Record deduplication — an org admin folded a duplicate ("loser") record
  // into a surviving ("winner"), reassigning every child FK and hard-deleting
  // the loser, inside the reassign/delete transaction. Meta shapes:
  //   CONTACT_MERGED / COMPANY_MERGED — { winner_id, loser_id, reassigned: { 'table.col': n } }
  CONTACT_MERGED:      'contact.merged',
  COMPANY_MERGED:      'company.merged',

  // Google Calendar integration (migration 115). Mirror of the Drive/Gmail
  // connection + sync events. Meta shapes:
  //   CALENDAR_CONNECTED       — { google_user_email, scopes }                  (auth callback)
  //   CALENDAR_DISCONNECTED    — { revoked }                                    (DELETE /connection)
  //   CALENDAR_EVENT_CREATED   — { deal_id, google_event_id, attendee_count }   (POST /deals/:id/calendar-event)
  //   CALENDAR_ORG_SYNCED      — { events_scanned, events_matched }             (POST /calendar/sync + worker tick)
  //   CALENDAR_ORG_SYNC_FAILED — { error }
  // Attendee email addresses + event descriptions are NEVER written to the
  // audit log — only counts + ids. A forensic reader with audit-log access
  // already has DB access and can read calendar_events directly.
  CALENDAR_CONNECTED:       'calendar.connected',
  CALENDAR_DISCONNECTED:    'calendar.disconnected',
  CALENDAR_EVENT_CREATED:   'calendar.event_created',
  CALENDAR_ORG_SYNCED:      'calendar.org_synced',
  CALENDAR_ORG_SYNC_FAILED: 'calendar.org_sync_failed',

  // Microsoft (Outlook / Microsoft 365) integration (migration 140). Mirror
  // of the Gmail/Calendar connection + sync events — ONE connection powers
  // both the mail and calendar surfaces, so there is a single connect/
  // disconnect pair plus per-surface sync events. Meta shapes:
  //   MSGRAPH_CONNECTED            — { ms_user_email, scopes }               (auth callback)
  //   MSGRAPH_DISCONNECTED         — { revoked }                             (DELETE /connection)
  //   MSGRAPH_MAIL_SYNCED          — { messages_scanned, messages_matched }  (POST /msgraph/mail/sync + worker tick)
  //   MSGRAPH_MAIL_SYNC_FAILED     — { error }
  //   MSGRAPH_CALENDAR_SYNCED      — { events_scanned, events_matched }      (POST /msgraph/calendar/sync + worker tick)
  //   MSGRAPH_CALENDAR_SYNC_FAILED — { error }
  // Message previews, attendee addresses, and event descriptions are NEVER
  // written to the audit log — only counts + ids, same policy as Gmail/
  // Calendar above.
  MSGRAPH_CONNECTED:            'msgraph.connected',
  MSGRAPH_DISCONNECTED:         'msgraph.disconnected',
  MSGRAPH_MAIL_SYNCED:          'msgraph.mail_synced',
  MSGRAPH_MAIL_SYNC_FAILED:     'msgraph.mail_sync_failed',
  MSGRAPH_CALENDAR_SYNCED:      'msgraph.calendar_synced',
  MSGRAPH_CALENDAR_SYNC_FAILED: 'msgraph.calendar_sync_failed',
};

async function record({ event, actorUserId = null, orgId = null, targetType = null, targetId = null, ip = null, userAgent = null, requestId = null, meta = null, success = true }) {
  try {
    await pool.query(
      `INSERT INTO audit_log (event, actor_user_id, org_id, target_type, target_id, ip, user_agent, request_id, meta, success)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [event, actorUserId, orgId, targetType, targetId, ip, userAgent, requestId, meta ? JSON.stringify(meta) : null, success]
    );
  } catch (err) {
    logger.warn('audit_log_write_failed', { event, error: err.message });
  }
}

function fromReq(req, fields = {}) {
  return record({
    actorUserId: req.userId || null,
    orgId: req.orgId || null,
    ip: req.ip,
    userAgent: req.headers?.['user-agent'] || null,
    requestId: req.requestId || null,
    ...fields,
  });
}

module.exports = { record, fromReq, EVENTS };
