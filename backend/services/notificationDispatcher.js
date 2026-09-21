// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Per-user notification dispatcher. Owns the policy ("does this user want
// this category on this channel?") and the routing ("send via the right
// transport with the right contact handle"). The transport adapters
// (email.js, sms.js) own the wire-protocol details.
//
// PUBLIC API:
//   dispatch(userId, category, payload)              — low-level fan-out
//   notifyTaskAssigned(taskId)
//   notifyTaskOverdue(taskId)
//   notifyDealActivity(dealId, activityId)
//   notifyWeeklySummary(userId)
//
// Each notify*() loads the relevant DB row(s), formats a placeholder subject
// and body, then defers to dispatch(). When NO channel is enabled for the
// caller's preferences on that category, the notify*() is a no-op that
// console.info-logs a single line and returns early — this lets future
// call-site authors invoke us unconditionally and trust us to honour user
// prefs.
//
// WIRED CALL SITES (see README at bottom for the full plan):
//   notifyTaskAssigned  — taskRoutes.js POST / and PUT /:id (assignee change)
//   notifyDealActivity  — dealRoutes.js PATCH /:id/stage (deal reaches a
//                         closed outcome) and the user-rule 'notify' action
//   notifyTaskOverdue   — overdueTaskWorker + user-rule 'notify' on task_overdue
//   notifyCaseAssigned / notifyCaseStatusChanged — caseRoutes.js POST / PUT
//   notifyLeadCaptured  — leadFormRoutes.js public submit
//   notifyLeadAssigned  — leadRoutes.js POST / and PUT /:id (owner set/changed)
//   notifyMeetingScheduled — meetingRoutes.js POST /
//   notifySequenceCompleted — services/sequences.js (final step sent)
//   notifyPlaybookTasksCreated — companyRoutes.js PATCH /:id/lifecycle-stage
// All call sites are fire-and-forget with a swallowed .catch() so a
// notification failure never breaks the originating user action.

const pool   = require('../db');
const email  = require('./email');
const sms    = require('./sms');
const logger = require('./logger');
const inApp  = require('./notifications');
// Consolidated delivery (spec 204): unless the user chose 'instant', the
// email channel lands in notification_email_queue and the digest worker
// sends ONE email (batched every 15 min, or daily at the user's hour with
// the live My Day queue). Instant sends get the same one-click buttons.
const digest = require('./notificationDigest');

const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://app.theopencrm.com';

// Source-of-truth list of categories the dispatcher understands. Keep in
// sync with migrations 066/144, schemas/me.js, and the frontend's
// NOTIFICATION_CATEGORIES table (frontend/src/pages/Settings.js).
const KNOWN_CATEGORIES = [
  'task_assigned', 'task_overdue', 'deal_activity', 'weekly_summary',
  // July-2026 module wave (migration 144). All four wire channels default
  // OFF for these — in-app (the bell) is the always-on record.
  'case_assigned', 'case_status_changed',
  'lead_captured', 'lead_assigned',
  'meeting_scheduled', 'sequence_completed', 'playbook_tasks_created',
  // Record comments (migration 146). Wire channels default OFF like the rest
  // of the module wave — in-app (the bell, always-on) is the primary surface.
  'mention',
  // Customer-portal case submission (migration 148) — an external customer
  // filed a support request through their portal link.
  'portal_case_submitted',
  // Customer-portal quote response (migration 149) — an external customer
  // approved or requested changes on a quote through their portal link.
  'portal_quote_response',
  // Customer-portal message (migration 150) — an external customer wrote in
  // their portal thread.
  'portal_message_received',
  // Customer-portal document upload (migration 151) — an external customer
  // sent a file through their portal link.
  'portal_document_uploaded',
];

// --------------------------------------------------------------------------
// Internal helpers
// --------------------------------------------------------------------------

async function loadUserForDispatch(userId) {
  const r = await pool.query(
    `SELECT id, email, name, org_id, notification_email, notification_phone, notification_preferences
       FROM users
      WHERE id = $1`,
    [userId]
  );
  return r.rows[0] || null;
}

function pickEffectiveEmail(user) {
  // notification_email takes priority; fall back to login email.
  return (user.notification_email && user.notification_email.trim()) || user.email || null;
}

function pickEffectivePhone(user) {
  return (user.notification_phone && user.notification_phone.trim()) || null;
}

function isCategoryChannelEnabled(prefs, category, channel) {
  if (!prefs || typeof prefs !== 'object') return false;
  const cat = prefs[category];
  if (!cat || typeof cat !== 'object') return false;
  return cat[channel] === true;
}

// --------------------------------------------------------------------------
// Core dispatch
// --------------------------------------------------------------------------

/**
 * Send a notification to a single user on whichever channels they have
 * enabled for `category`. Returns an outcome map so the caller can audit.
 *
 * @param {number|string} userId
 * @param {string} category — one of KNOWN_CATEGORIES
 * @param {object} payload  — { subject, html?, text?, sms?, link?, entityType?, entityId?, actions? }
 *   actions: [{ action: 'task.complete', entity_id: 12, label?, params? }] — one-click
 *   buttons (services/emailActions.js) rendered into the email (instant) or the digest.
 * @returns {Promise<{email:'sent'|'queued'|'skipped'|'failed', sms:'sent'|'skipped'|'failed'}>}
 */
async function dispatch(userId, category, payload) {
  if (!KNOWN_CATEGORIES.includes(category)) {
    console.warn(`[notify] dispatch called with unknown category="${category}"; skipping all channels`);
    return { email: 'skipped', sms: 'skipped' };
  }

  const user = await loadUserForDispatch(userId);
  if (!user) {
    console.warn(`[notify] dispatch: user ${userId} not found; skipping`);
    return { email: 'skipped', sms: 'skipped' };
  }

  const prefs = user.notification_preferences || {};
  const wantEmail = isCategoryChannelEnabled(prefs, category, 'email');
  const wantSms   = isCategoryChannelEnabled(prefs, category, 'sms');

  const result = { email: 'skipped', sms: 'skipped' };

  // ---- Email ---------------------------------------------------------------
  if (wantEmail) {
    const toEmail = pickEffectiveEmail(user);
    if (!toEmail) {
      result.email = 'skipped';
    } else if (digest.deliveryPref(prefs).mode !== 'instant') {
      // Consolidated delivery: park it; the digest worker sends one email.
      try {
        await digest.enqueue({
          orgId: user.org_id || null,
          userId: user.id,
          category,
          subject: payload.subject || `[The Open CRM] ${category}`,
          text: payload.text || null,
          html: payload.html || null,
          link: payload.link || null,
          entityType: payload.entityType || null,
          entityId: payload.entityId || null,
          actions: payload.actions || [],
        });
        result.email = 'queued';
      } catch (err) {
        logger.warn?.('notify_dispatch_enqueue_failed', { userId, category, error: err.message });
        result.email = 'failed';
      }
    } else {
      try {
        let html = payload.html || null;
        let text = payload.text || payload.subject || category;
        try {
          const extra = await digest.renderInstantActions(user, { actions: payload.actions || [], link: payload.link || null });
          if (extra.html) html = `${html || `<p>${payload.subject || ''}</p>`}${extra.html}`;
          if (extra.text) text = `${text}${extra.text}`;
        } catch (err) {
          logger.warn?.('notify_dispatch_actions_failed', { userId, category, error: err.message });
        }
        await email.sendMail({
          to: toEmail,
          subject: payload.subject || `[The Open CRM] ${category}`,
          html,
          text,
        });
        result.email = 'sent';
      } catch (err) {
        logger.warn?.('notify_dispatch_email_failed', { userId, category, error: err.message });
        result.email = 'failed';
      }
    }
  }

  // ---- SMS ----------------------------------------------------------------
  if (wantSms) {
    const toPhone = pickEffectivePhone(user);
    if (!toPhone) {
      // User toggled SMS on but never set a phone (or it was cleared).
      result.sms = 'skipped';
    } else {
      // sms.sendSms catches its own errors and returns a status string.
      result.sms = await sms.sendSms(toPhone, payload.sms || payload.text || payload.subject || category);
    }
  }

  return result;
}

// --------------------------------------------------------------------------
// Category-specific helpers — they each load the row, format placeholder
// text, then defer to dispatch(). These exist so future-me can call
// notifyTaskAssigned(taskId) from the task-creation route without having
// to know anything about channels or templates.
// --------------------------------------------------------------------------

// Persist an in-app Notification Center row (migration 128) alongside the
// email/SMS fan-out. STRICTLY best-effort: any failure is logged and
// swallowed so a persistence problem can never break the originating
// dispatch (or the user action behind it). Unlike email/SMS, the in-app
// channel has no per-category opt-out — the bell is the always-on record,
// which is why each notify*() persists even when both wire channels are
// disabled for the category.
async function persistInApp({ orgId, userId, type, title, body, link, entityType, entityId }) {
  try {
    await inApp.create({
      orgScope: orgId ? ['org_id', orgId] : ['user_id', userId],
      userId,
      type,
      title,
      body,
      link,
      entityType,
      entityId,
    });
  } catch (err) {
    logger.warn?.('notify_inapp_persist_failed', { userId, type, error: err.message });
  }
}

function categoryFullyDisabled(prefs, category) {
  if (!prefs || typeof prefs !== 'object') return true;
  const cat = prefs[category];
  if (!cat || typeof cat !== 'object') return true;
  return !cat.email && !cat.sms;
}

async function notifyTaskAssigned(taskId) {
  try {
    const r = await pool.query(
      `SELECT t.id, t.title, t.description, t.due_date, t.user_id, t.assigned_to,
              t.contact_id, t.deal_id, t.org_id,
              u.id AS recipient_id, u.notification_preferences
         FROM tasks t
         LEFT JOIN users u ON u.id = COALESCE(t.assigned_to, t.user_id)
        WHERE t.id = $1`,
      [taskId]
    );
    const task = r.rows[0];
    if (!task || !task.recipient_id) {
      console.info(`[notify] notifyTaskAssigned: task ${taskId} or recipient not found`);
      return { email: 'skipped', sms: 'skipped' };
    }

    const subject = `New task: ${task.title || `Task #${task.id}`}`;
    const text = [
      `A new task has been assigned to you in The Open CRM.`,
      ``,
      `Title: ${task.title || '(untitled)'}`,
      task.due_date ? `Due:   ${new Date(task.due_date).toLocaleString()}` : null,
      task.description ? `\nDescription:\n${task.description}` : null,
      ``,
      `Open it in the app: https://app.theopencrm.com/tasks`,
    ].filter(Boolean).join('\n');
    const smsText = `New task assigned: "${task.title || `#${task.id}`}"${task.due_date ? `, due ${new Date(task.due_date).toLocaleDateString()}` : ''}. Open The Open CRM.`;
    const html = `<p>A new task has been assigned to you in The Open CRM.</p>
                  <p><b>Title:</b> ${escapeHtml(task.title || '(untitled)')}</p>
                  ${task.due_date ? `<p><b>Due:</b> ${escapeHtml(new Date(task.due_date).toLocaleString())}</p>` : ''}
                  ${task.description ? `<p><b>Description:</b><br>${escapeHtml(task.description)}</p>` : ''}
                  <p><a href="https://app.theopencrm.com/tasks">Open in The Open CRM</a></p>`;

    // Wire channels honour per-category prefs; the in-app row below persists
    // either way (the bell is the always-on record).
    let outcome = { email: 'skipped', sms: 'skipped' };
    if (categoryFullyDisabled(task.notification_preferences, 'task_assigned')) {
      console.info(`[notify] notifyTaskAssigned: user ${task.recipient_id} has task_assigned fully disabled`);
    } else {
      outcome = await dispatch(task.recipient_id, 'task_assigned', {
        subject, text, html, sms: smsText,
        link: `/tasks?taskId=${task.id}`, entityType: 'task', entityId: task.id,
        actions: [
          { action: 'task.complete', entity_id: task.id, label: 'Mark done' },
          { action: 'task.snooze', entity_id: task.id, label: 'Snooze a day', params: { days: 1 } },
        ],
      });
    }

    await persistInApp({
      orgId: task.org_id || null,
      userId: task.recipient_id,
      type: 'task_assigned',
      title: subject,
      body: text,
      link: '/tasks',
      entityType: 'task',
      entityId: task.id,
    });

    return outcome;
  } catch (err) {
    logger.warn?.('notify_task_assigned_failed', { taskId, error: err.message });
    return { email: 'failed', sms: 'failed' };
  }
}

async function notifyTaskOverdue(taskId) {
  try {
    const r = await pool.query(
      `SELECT t.id, t.title, t.due_date, t.user_id, t.assigned_to, t.org_id,
              u.id AS recipient_id, u.notification_preferences
         FROM tasks t
         LEFT JOIN users u ON u.id = COALESCE(t.assigned_to, t.user_id)
        WHERE t.id = $1`,
      [taskId]
    );
    const task = r.rows[0];
    if (!task || !task.recipient_id) {
      console.info(`[notify] notifyTaskOverdue: task ${taskId} or recipient not found`);
      return { email: 'skipped', sms: 'skipped' };
    }

    const subject = `Overdue task: ${task.title || `Task #${task.id}`}`;
    const text = `Task "${task.title || `#${task.id}`}" is past its due date${task.due_date ? ` (${new Date(task.due_date).toLocaleString()})` : ''}.\n\nOpen it in the app: https://app.theopencrm.com/tasks`;
    const smsText = `Overdue: "${task.title || `#${task.id}`}". The Open CRM.`;
    const html = `<p>Task <b>${escapeHtml(task.title || `#${task.id}`)}</b> is past its due date${task.due_date ? ` (${escapeHtml(new Date(task.due_date).toLocaleString())})` : ''}.</p>
                  <p><a href="https://app.theopencrm.com/tasks">Open in The Open CRM</a></p>`;

    let outcome = { email: 'skipped', sms: 'skipped' };
    if (categoryFullyDisabled(task.notification_preferences, 'task_overdue')) {
      console.info(`[notify] notifyTaskOverdue: user ${task.recipient_id} has task_overdue fully disabled`);
    } else {
      outcome = await dispatch(task.recipient_id, 'task_overdue', {
        subject, text, html, sms: smsText,
        link: `/tasks?taskId=${task.id}`, entityType: 'task', entityId: task.id,
        actions: [
          { action: 'task.complete', entity_id: task.id, label: 'Mark done' },
          { action: 'task.snooze', entity_id: task.id, label: 'Snooze a day', params: { days: 1 } },
        ],
      });
    }

    await persistInApp({
      orgId: task.org_id || null,
      userId: task.recipient_id,
      type: 'task_overdue',
      title: subject,
      body: text,
      link: '/tasks',
      entityType: 'task',
      entityId: task.id,
    });

    return outcome;
  } catch (err) {
    logger.warn?.('notify_task_overdue_failed', { taskId, error: err.message });
    return { email: 'failed', sms: 'failed' };
  }
}

async function notifyDealActivity(dealId, activityId) {
  try {
    const r = await pool.query(
      `SELECT d.id AS deal_id, d.title AS deal_title, d.user_id AS owner_id, d.org_id,
              a.id AS activity_id, a.type AS activity_type, a.subject AS activity_subject, a.notes AS activity_notes,
              u.id AS recipient_id, u.notification_preferences
         FROM deals d
         LEFT JOIN activities a ON a.id = $2
         LEFT JOIN users u ON u.id = d.user_id
        WHERE d.id = $1`,
      [dealId, activityId]
    );
    const row = r.rows[0];
    if (!row || !row.recipient_id) {
      console.info(`[notify] notifyDealActivity: deal ${dealId} or owner not found`);
      return { email: 'skipped', sms: 'skipped' };
    }

    const subject = `New activity on deal: ${row.deal_title || `Deal #${row.deal_id}`}`;
    const text = [
      `There's new activity on a deal you own.`,
      ``,
      `Deal: ${row.deal_title || `#${row.deal_id}`}`,
      row.activity_type ? `Activity type: ${row.activity_type}` : null,
      row.activity_subject ? `Subject: ${row.activity_subject}` : null,
      row.activity_notes ? `\nNotes:\n${row.activity_notes}` : null,
      ``,
      `Open the deal: https://app.theopencrm.com/deals/${row.deal_id}`,
    ].filter(Boolean).join('\n');
    const smsText = `New activity on deal "${row.deal_title || `#${row.deal_id}`}"${row.activity_type ? ` (${row.activity_type})` : ''}.`;
    const html = `<p>There's new activity on a deal you own.</p>
                  <p><b>Deal:</b> ${escapeHtml(row.deal_title || `#${row.deal_id}`)}</p>
                  ${row.activity_type ? `<p><b>Type:</b> ${escapeHtml(row.activity_type)}</p>` : ''}
                  ${row.activity_subject ? `<p><b>Subject:</b> ${escapeHtml(row.activity_subject)}</p>` : ''}
                  ${row.activity_notes ? `<p><b>Notes:</b><br>${escapeHtml(row.activity_notes)}</p>` : ''}
                  <p><a href="https://app.theopencrm.com/deals/${row.deal_id}">Open in The Open CRM</a></p>`;

    let outcome = { email: 'skipped', sms: 'skipped' };
    if (categoryFullyDisabled(row.notification_preferences, 'deal_activity')) {
      console.info(`[notify] notifyDealActivity: user ${row.recipient_id} has deal_activity fully disabled`);
    } else {
      outcome = await dispatch(row.recipient_id, 'deal_activity', { subject, text, html, sms: smsText, link: `/deals?dealId=${row.deal_id}`, entityType: 'deal', entityId: row.deal_id });
    }

    await persistInApp({
      orgId: row.org_id || null,
      userId: row.recipient_id,
      type: 'deal_activity',
      title: subject,
      // In-app deep link mirrors the GlobalSearch click-through (the Deals
      // page has no /deals/:id route — it's a search-driven Kanban).
      link: row.deal_title ? `/deals?search=${encodeURIComponent(row.deal_title)}` : '/deals',
      body: text,
      entityType: 'deal',
      entityId: row.deal_id,
    });

    return outcome;
  } catch (err) {
    logger.warn?.('notify_deal_activity_failed', { dealId, activityId, error: err.message });
    return { email: 'failed', sms: 'failed' };
  }
}

async function notifyWeeklySummary(userId) {
  try {
    const r = await pool.query(
      `SELECT id, name, org_id, notification_preferences FROM users WHERE id = $1`,
      [userId]
    );
    const user = r.rows[0];
    if (!user) {
      console.info(`[notify] notifyWeeklySummary: user ${userId} not found`);
      return { email: 'skipped', sms: 'skipped' };
    }

    const subject = `Your weekly summary — The Open CRM`;
    const text = [
      `Hi ${user.name || 'there'},`,
      ``,
      `Here's your weekly summary. (Placeholder text — a real digest of`,
      `last week's wins, losses, and what's on deck will replace this`,
      `once the AI summarizer ships.)`,
      ``,
      `Open the dashboard: https://app.theopencrm.com/`,
    ].join('\n');
    const smsText = `Your weekly summary is ready — open The Open CRM dashboard.`;
    const html = `<p>Hi ${escapeHtml(user.name || 'there')},</p>
                  <p>Here's your weekly summary. <em>(Placeholder text — a real digest of last week's wins, losses, and what's on deck will replace this once the AI summarizer ships.)</em></p>
                  <p><a href="https://app.theopencrm.com/">Open the dashboard</a></p>`;

    let outcome = { email: 'skipped', sms: 'skipped' };
    if (categoryFullyDisabled(user.notification_preferences, 'weekly_summary')) {
      console.info(`[notify] notifyWeeklySummary: user ${userId} has weekly_summary fully disabled`);
    } else {
      outcome = await dispatch(userId, 'weekly_summary', { subject, text, html, sms: smsText });
    }

    await persistInApp({
      orgId: user.org_id || null,
      userId: user.id,
      type: 'weekly_summary',
      title: subject,
      body: text,
      link: '/dashboard',
      entityType: null,
      entityId: null,
    });

    return outcome;
  } catch (err) {
    logger.warn?.('notify_weekly_summary_failed', { userId, error: err.message });
    return { email: 'failed', sms: 'failed' };
  }
}

// ---------------------------------------------------------------------------
// July-2026 module-wave producers — cases, leads, meetings, sequences,
// playbooks. Same contract as the four originals: load the row(s) + the
// recipient's prefs in one query, format placeholder copy, honour wire-
// channel prefs via dispatch(), and ALWAYS persist the in-app row (the bell
// is the always-on record; there is no per-type in-app opt-out). Every
// helper is fully try/catch-wrapped so a notification failure can never
// propagate into the originating request — call sites still add their own
// .catch() belt-and-braces, mirroring taskRoutes.
//
// Recipient rule (owner-first): notify the record's owner_user_id when set,
// else the closest sensible fallback (creator / linked-record owner / the
// acting user for system-spawned work). Recipients are read off the row the
// tenant wrote, so a notification can never cross orgs. Helpers that take an
// actorUserId skip self-notification.
// ---------------------------------------------------------------------------

// Shared tail for the module-wave helpers: wire channels honour per-category
// prefs; the in-app row persists either way.
async function fanOut({ recipientId, prefs, orgId, category, subject, text, html, sms, link, entityType, entityId }) {
  let outcome = { email: 'skipped', sms: 'skipped' };
  if (categoryFullyDisabled(prefs, category)) {
    console.info(`[notify] ${category}: user ${recipientId} has ${category} fully disabled on wire channels`);
  } else {
    outcome = await dispatch(recipientId, category, { subject, text, html, sms, link, entityType, entityId });
  }
  await persistInApp({
    orgId: orgId || null,
    userId: recipientId,
    type: category,
    title: subject,
    body: text,
    link,
    entityType,
    entityId,
  });
  return outcome;
}

const SKIPPED = { email: 'skipped', sms: 'skipped' };

async function notifyCaseAssigned(caseId, actorUserId = null) {
  try {
    const r = await pool.query(
      `SELECT cs.id, cs.subject, cs.priority, cs.status, cs.org_id, cs.owner_user_id,
              co.name AS company_name,
              u.id AS recipient_id, u.notification_preferences
         FROM cases cs
         LEFT JOIN companies co ON co.id = cs.company_id
         LEFT JOIN users u ON u.id = cs.owner_user_id
        WHERE cs.id = $1`,
      [caseId]
    );
    const row = r.rows[0];
    if (!row || !row.recipient_id) {
      console.info(`[notify] notifyCaseAssigned: case ${caseId} or owner not found`);
      return SKIPPED;
    }
    if (actorUserId != null && Number(row.recipient_id) === Number(actorUserId)) return SKIPPED;

    const subject = `Case assigned to you: ${row.subject || `#${row.id}`}`;
    const text = [
      `A support case has been assigned to you in The Open CRM.`,
      ``,
      `Case: ${row.subject || `#${row.id}`}`,
      row.company_name ? `Company: ${row.company_name}` : null,
      row.priority ? `Priority: ${row.priority}` : null,
      ``,
      `Open it in the app: https://app.theopencrm.com/cases`,
    ].filter(Boolean).join('\n');

    return await fanOut({
      recipientId: row.recipient_id,
      prefs: row.notification_preferences,
      orgId: row.org_id,
      category: 'case_assigned',
      subject,
      text,
      html: `<p>A support case has been assigned to you in The Open CRM.</p>
             <p><b>Case:</b> ${escapeHtml(row.subject || `#${row.id}`)}</p>
             ${row.company_name ? `<p><b>Company:</b> ${escapeHtml(row.company_name)}</p>` : ''}
             ${row.priority ? `<p><b>Priority:</b> ${escapeHtml(row.priority)}</p>` : ''}
             <p><a href="https://app.theopencrm.com/cases">Open in The Open CRM</a></p>`,
      sms: `Case assigned: "${row.subject || `#${row.id}`}"${row.priority ? ` (${row.priority})` : ''}. The Open CRM.`,
      link: '/cases',
      entityType: 'case',
      entityId: row.id,
    });
  } catch (err) {
    logger.warn?.('notify_case_assigned_failed', { caseId, error: err.message });
    return { email: 'failed', sms: 'failed' };
  }
}

async function notifyCaseStatusChanged(caseId, actorUserId = null, previousStatus = null) {
  try {
    const r = await pool.query(
      `SELECT cs.id, cs.subject, cs.status, cs.org_id,
              co.name AS company_name,
              u.id AS recipient_id, u.notification_preferences
         FROM cases cs
         LEFT JOIN companies co ON co.id = cs.company_id
         LEFT JOIN users u ON u.id = COALESCE(cs.owner_user_id, cs.user_id)
        WHERE cs.id = $1`,
      [caseId]
    );
    const row = r.rows[0];
    if (!row || !row.recipient_id) {
      console.info(`[notify] notifyCaseStatusChanged: case ${caseId} or recipient not found`);
      return SKIPPED;
    }
    if (actorUserId != null && Number(row.recipient_id) === Number(actorUserId)) return SKIPPED;

    const transition = previousStatus ? `${previousStatus} → ${row.status}` : row.status;
    const subject = `Case ${row.status}: ${row.subject || `#${row.id}`}`;
    const text = [
      `A case you're responsible for changed status (${transition}).`,
      ``,
      `Case: ${row.subject || `#${row.id}`}`,
      row.company_name ? `Company: ${row.company_name}` : null,
      ``,
      `Open it in the app: https://app.theopencrm.com/cases`,
    ].filter(Boolean).join('\n');

    return await fanOut({
      recipientId: row.recipient_id,
      prefs: row.notification_preferences,
      orgId: row.org_id,
      category: 'case_status_changed',
      subject,
      text,
      html: `<p>A case you're responsible for changed status (${escapeHtml(transition)}).</p>
             <p><b>Case:</b> ${escapeHtml(row.subject || `#${row.id}`)}</p>
             ${row.company_name ? `<p><b>Company:</b> ${escapeHtml(row.company_name)}</p>` : ''}
             <p><a href="https://app.theopencrm.com/cases">Open in The Open CRM</a></p>`,
      sms: `Case "${row.subject || `#${row.id}`}" is now ${row.status}. The Open CRM.`,
      link: '/cases',
      entityType: 'case',
      entityId: row.id,
    });
  } catch (err) {
    logger.warn?.('notify_case_status_changed_failed', { caseId, error: err.message });
    return { email: 'failed', sms: 'failed' };
  }
}

async function notifyLeadCaptured(leadId) {
  try {
    const r = await pool.query(
      `SELECT l.id, l.name, l.company_name, l.source, l.org_id,
              u.id AS recipient_id, u.notification_preferences
         FROM leads l
         LEFT JOIN users u ON u.id = COALESCE(l.owner_user_id, l.user_id)
        WHERE l.id = $1`,
      [leadId]
    );
    const row = r.rows[0];
    if (!row || !row.recipient_id) {
      console.info(`[notify] notifyLeadCaptured: lead ${leadId} or recipient not found`);
      return SKIPPED;
    }

    const subject = `New lead captured: ${row.name || `#${row.id}`}`;
    const text = [
      `A new lead just came in${row.source ? ` via ${row.source}` : ''}.`,
      ``,
      `Lead: ${row.name || `#${row.id}`}`,
      row.company_name ? `Company: ${row.company_name}` : null,
      ``,
      `Open it in the app: https://app.theopencrm.com/leads`,
    ].filter(Boolean).join('\n');

    return await fanOut({
      recipientId: row.recipient_id,
      prefs: row.notification_preferences,
      orgId: row.org_id,
      category: 'lead_captured',
      subject,
      text,
      html: `<p>A new lead just came in${row.source ? ` via ${escapeHtml(row.source)}` : ''}.</p>
             <p><b>Lead:</b> ${escapeHtml(row.name || `#${row.id}`)}</p>
             ${row.company_name ? `<p><b>Company:</b> ${escapeHtml(row.company_name)}</p>` : ''}
             <p><a href="https://app.theopencrm.com/leads">Open in The Open CRM</a></p>`,
      sms: `New lead: "${row.name || `#${row.id}`}". The Open CRM.`,
      link: '/leads',
      entityType: 'lead',
      entityId: row.id,
    });
  } catch (err) {
    logger.warn?.('notify_lead_captured_failed', { leadId, error: err.message });
    return { email: 'failed', sms: 'failed' };
  }
}

async function notifyLeadAssigned(leadId, actorUserId = null) {
  try {
    const r = await pool.query(
      `SELECT l.id, l.name, l.company_name, l.org_id, l.owner_user_id,
              u.id AS recipient_id, u.notification_preferences
         FROM leads l
         LEFT JOIN users u ON u.id = l.owner_user_id
        WHERE l.id = $1`,
      [leadId]
    );
    const row = r.rows[0];
    if (!row || !row.recipient_id) {
      console.info(`[notify] notifyLeadAssigned: lead ${leadId} or owner not found`);
      return SKIPPED;
    }
    if (actorUserId != null && Number(row.recipient_id) === Number(actorUserId)) return SKIPPED;

    const subject = `Lead assigned to you: ${row.name || `#${row.id}`}`;
    const text = [
      `A lead has been assigned to you in The Open CRM.`,
      ``,
      `Lead: ${row.name || `#${row.id}`}`,
      row.company_name ? `Company: ${row.company_name}` : null,
      ``,
      `Open it in the app: https://app.theopencrm.com/leads`,
    ].filter(Boolean).join('\n');

    return await fanOut({
      recipientId: row.recipient_id,
      prefs: row.notification_preferences,
      orgId: row.org_id,
      category: 'lead_assigned',
      subject,
      text,
      html: `<p>A lead has been assigned to you in The Open CRM.</p>
             <p><b>Lead:</b> ${escapeHtml(row.name || `#${row.id}`)}</p>
             ${row.company_name ? `<p><b>Company:</b> ${escapeHtml(row.company_name)}</p>` : ''}
             <p><a href="https://app.theopencrm.com/leads">Open in The Open CRM</a></p>`,
      sms: `Lead assigned: "${row.name || `#${row.id}`}". The Open CRM.`,
      link: '/leads',
      entityType: 'lead',
      entityId: row.id,
    });
  } catch (err) {
    logger.warn?.('notify_lead_assigned_failed', { leadId, error: err.message });
    return { email: 'failed', sms: 'failed' };
  }
}

// Recipient: the linked deal's owner (owner_user_id, else the deal's
// creator), else the linked company's owner. A meeting with no linked
// stakeholder — or one whose stakeholder is the scheduler — notifies no one.
async function notifyMeetingScheduled(meetingId, actorUserId = null) {
  try {
    const r = await pool.query(
      `SELECT m.id, m.title, m.starts_at, m.location, m.org_id,
              d.title AS deal_title, co.name AS company_name,
              u.id AS recipient_id, u.notification_preferences
         FROM meetings m
         LEFT JOIN deals d ON d.id = m.deal_id
         LEFT JOIN companies co ON co.id = m.company_id
         LEFT JOIN users u ON u.id = COALESCE(d.owner_user_id, d.user_id, co.owner_user_id)
        WHERE m.id = $1`,
      [meetingId]
    );
    const row = r.rows[0];
    if (!row || !row.recipient_id) return SKIPPED; // no linked stakeholder — by design
    if (actorUserId != null && Number(row.recipient_id) === Number(actorUserId)) return SKIPPED;

    const when = row.starts_at ? new Date(row.starts_at).toLocaleString() : null;
    const subject = `Meeting scheduled: ${row.title || `#${row.id}`}`;
    const text = [
      `A meeting was scheduled on a record you own.`,
      ``,
      `Meeting: ${row.title || `#${row.id}`}`,
      when ? `When: ${when}` : null,
      row.deal_title ? `Deal: ${row.deal_title}` : null,
      row.company_name ? `Company: ${row.company_name}` : null,
      ``,
      `Open the calendar: https://app.theopencrm.com/calendar`,
    ].filter(Boolean).join('\n');

    return await fanOut({
      recipientId: row.recipient_id,
      prefs: row.notification_preferences,
      orgId: row.org_id,
      category: 'meeting_scheduled',
      subject,
      text,
      html: `<p>A meeting was scheduled on a record you own.</p>
             <p><b>Meeting:</b> ${escapeHtml(row.title || `#${row.id}`)}</p>
             ${when ? `<p><b>When:</b> ${escapeHtml(when)}</p>` : ''}
             ${row.deal_title ? `<p><b>Deal:</b> ${escapeHtml(row.deal_title)}</p>` : ''}
             ${row.company_name ? `<p><b>Company:</b> ${escapeHtml(row.company_name)}</p>` : ''}
             <p><a href="https://app.theopencrm.com/calendar">Open the calendar</a></p>`,
      sms: `Meeting scheduled: "${row.title || `#${row.id}`}"${when ? `, ${when}` : ''}. The Open CRM.`,
      link: '/calendar',
      entityType: 'meeting',
      entityId: row.id,
    });
  } catch (err) {
    logger.warn?.('notify_meeting_scheduled_failed', { meetingId, error: err.message });
    return { email: 'failed', sms: 'failed' };
  }
}

// Recipient: the sequence's creator, else the enrolling user. Called from
// services/sequences.js when an enrollment sends its final step.
async function notifySequenceCompleted(enrollmentId) {
  try {
    const r = await pool.query(
      `SELECT e.id, e.org_id, e.contact_id, s.id AS sequence_id, s.name AS sequence_name,
              c.first_name, c.last_name,
              u.id AS recipient_id, u.notification_preferences
         FROM sequence_enrollments e
         JOIN sequences s ON s.id = e.sequence_id
         LEFT JOIN contacts c ON c.id = e.contact_id
         LEFT JOIN users u ON u.id = COALESCE(s.created_by, e.user_id)
        WHERE e.id = $1`,
      [enrollmentId]
    );
    const row = r.rows[0];
    if (!row || !row.recipient_id) {
      console.info(`[notify] notifySequenceCompleted: enrollment ${enrollmentId} or recipient not found`);
      return SKIPPED;
    }

    const contactName = `${row.first_name || ''} ${row.last_name || ''}`.trim() || 'A contact';
    const subject = `Sequence completed: ${row.sequence_name || `#${row.sequence_id}`}`;
    const text = [
      `${contactName} just finished the "${row.sequence_name || `#${row.sequence_id}`}" email sequence.`,
      ``,
      `They received every step — a good moment for a personal follow-up.`,
      ``,
      `Open sequences: https://app.theopencrm.com/sequences`,
    ].join('\n');

    return await fanOut({
      recipientId: row.recipient_id,
      prefs: row.notification_preferences,
      orgId: row.org_id,
      category: 'sequence_completed',
      subject,
      text,
      html: `<p><b>${escapeHtml(contactName)}</b> just finished the "${escapeHtml(row.sequence_name || `#${row.sequence_id}`)}" email sequence.</p>
             <p>They received every step — a good moment for a personal follow-up.</p>
             <p><a href="https://app.theopencrm.com/sequences">Open sequences</a></p>`,
      sms: `${contactName} finished sequence "${row.sequence_name || `#${row.sequence_id}`}". The Open CRM.`,
      link: '/sequences',
      entityType: 'sequence',
      entityId: row.sequence_id,
    });
  } catch (err) {
    logger.warn?.('notify_sequence_completed_failed', { enrollmentId, error: err.message });
    return { email: 'failed', sms: 'failed' };
  }
}

// Recipient: the company's owner_user_id when set, else the acting user (the
// spawned tasks land on their plate) — actorUserId is the FALLBACK here, not
// a self-notification skip: playbook task creation is system-generated, so
// telling the actor "N tasks were created for you" is the point.
async function notifyPlaybookTasksCreated({ playbookId, companyId, tasksCreated, actorUserId }) {
  try {
    const r = await pool.query(
      `SELECT p.id, p.name, p.org_id,
              co.name AS company_name,
              u.id AS recipient_id, u.notification_preferences
         FROM playbooks p
         LEFT JOIN companies co ON co.id = $2
         LEFT JOIN users u ON u.id = COALESCE(co.owner_user_id, $3::int)
        WHERE p.id = $1`,
      [playbookId, companyId || null, actorUserId || null]
    );
    const row = r.rows[0];
    if (!row || !row.recipient_id) {
      console.info(`[notify] notifyPlaybookTasksCreated: playbook ${playbookId} or recipient not found`);
      return SKIPPED;
    }

    const count = Number(tasksCreated) || 0;
    const subject = `Playbook "${row.name || `#${row.id}`}" created ${count} task${count === 1 ? '' : 's'}`;
    const text = [
      `The "${row.name || `#${row.id}`}" playbook just fired${row.company_name ? ` for ${row.company_name}` : ''}.`,
      ``,
      `${count} task${count === 1 ? ' was' : 's were'} added to the checklist.`,
      ``,
      `Open tasks: https://app.theopencrm.com/tasks`,
    ].join('\n');

    return await fanOut({
      recipientId: row.recipient_id,
      prefs: row.notification_preferences,
      orgId: row.org_id,
      category: 'playbook_tasks_created',
      subject,
      text,
      html: `<p>The "${escapeHtml(row.name || `#${row.id}`)}" playbook just fired${row.company_name ? ` for <b>${escapeHtml(row.company_name)}</b>` : ''}.</p>
             <p>${count} task${count === 1 ? ' was' : 's were'} added to the checklist.</p>
             <p><a href="https://app.theopencrm.com/tasks">Open tasks</a></p>`,
      sms: `Playbook "${row.name || `#${row.id}`}" created ${count} task${count === 1 ? '' : 's'}. The Open CRM.`,
      link: '/tasks',
      entityType: 'playbook',
      entityId: row.id,
    });
  } catch (err) {
    logger.warn?.('notify_playbook_tasks_created_failed', { playbookId, error: err.message });
    return { email: 'failed', sms: 'failed' };
  }
}

// Where an in-app mention notification should deep-link, per commented
// entity type (record_comments.entity_type, migration 146).
const MENTION_LINKS = {
  deal: '/deals',
  company: '/companies',
  contact: '/contacts',
  case: '/cases',
  lead: '/leads',
};

// Someone @mentioned `mentionedUserId` in a comment. Recipient rule: exactly
// the mentioned user — the CALLER (commentRoutes.js) validates the mention is
// in-org and drops self-mentions before invoking us; we belt-and-braces the
// self-skip anyway. Same contract as the other helpers: load rows + prefs in
// one query, honour wire-channel prefs via dispatch(), ALWAYS persist the
// in-app row (the bell is the always-on record — "mention" in-app defaults on).
async function notifyMention(commentId, mentionedUserId, authorId) {
  try {
    if (authorId != null && Number(mentionedUserId) === Number(authorId)) return SKIPPED;
    const r = await pool.query(
      `SELECT c.id, c.entity_type, c.entity_id, c.body, c.org_id,
              a.name AS author_name, a.email AS author_email,
              u.id AS recipient_id, u.notification_preferences
         FROM record_comments c
         LEFT JOIN users a ON a.id = $3
         LEFT JOIN users u ON u.id = $2
        WHERE c.id = $1`,
      [commentId, mentionedUserId, authorId],
    );
    const row = r.rows[0];
    if (!row || !row.recipient_id) {
      console.info(`[notify] notifyMention: comment ${commentId} or recipient ${mentionedUserId} not found`);
      return SKIPPED;
    }

    const author = row.author_name || row.author_email || 'A teammate';
    const snippet = String(row.body || '').slice(0, 200);
    const link = MENTION_LINKS[row.entity_type] || '/dashboard';
    const subject = `${author} mentioned you in a comment`;
    const text = [
      `${author} mentioned you in a comment on a ${row.entity_type}.`,
      ``,
      snippet,
      ``,
      `Open it in the app: https://app.theopencrm.com${link}`,
    ].join('\n');

    return await fanOut({
      recipientId: row.recipient_id,
      prefs: row.notification_preferences,
      orgId: row.org_id,
      category: 'mention',
      subject,
      text,
      html: `<p><b>${escapeHtml(author)}</b> mentioned you in a comment on a ${escapeHtml(row.entity_type)}.</p>
             <blockquote>${escapeHtml(snippet)}</blockquote>
             <p><a href="https://app.theopencrm.com${link}">Open in The Open CRM</a></p>`,
      sms: `${author} mentioned you in a comment. The Open CRM.`,
      link,
      entityType: row.entity_type,
      entityId: row.entity_id,
    });
  } catch (err) {
    logger.warn?.('notify_mention_failed', { commentId, mentionedUserId, error: err.message });
    return { email: 'failed', sms: 'failed' };
  }
}

// Tiny HTML-escape so we don't accidentally render user-supplied task titles
// or deal names as HTML. Sufficient for the placeholder templates here; a
// real templating layer would replace this with a vetted library.
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Recipient (owner-first, same rule as playbooks): the company's
// owner_user_id when set, else the case row's tenant-attribution user — for
// portal cases that is portal_tokens.user_id, i.e. the admin who minted the
// link. There is no actor to skip: the submitter is an external customer.
async function notifyPortalCaseSubmitted(caseId) {
  try {
    const r = await pool.query(
      `SELECT cs.id, cs.subject, cs.priority, cs.org_id,
              co.name AS company_name,
              u.id AS recipient_id, u.notification_preferences
         FROM cases cs
         LEFT JOIN companies co ON co.id = cs.company_id
         LEFT JOIN users u ON u.id = COALESCE(co.owner_user_id, cs.user_id)
        WHERE cs.id = $1`,
      [caseId]
    );
    const row = r.rows[0];
    if (!row || !row.recipient_id) {
      console.info(`[notify] notifyPortalCaseSubmitted: case ${caseId} or recipient not found`);
      return SKIPPED;
    }

    const subject = `Portal support request${row.company_name ? ` from ${row.company_name}` : ''}: ${row.subject || `#${row.id}`}`;
    const text = [
      `A customer just filed a support request through their portal link.`,
      ``,
      `Case: ${row.subject || `#${row.id}`}`,
      row.company_name ? `Company: ${row.company_name}` : null,
      row.priority && row.priority !== 'normal' ? `Priority: ${row.priority}` : null,
      ``,
      `Open it in the app: https://app.theopencrm.com/cases`,
    ].filter(Boolean).join('\n');

    return await fanOut({
      recipientId: row.recipient_id,
      prefs: row.notification_preferences,
      orgId: row.org_id,
      category: 'portal_case_submitted',
      subject,
      text,
      html: `<p>A customer just filed a support request through their portal link.</p>
             <p><b>Case:</b> ${escapeHtml(row.subject || `#${row.id}`)}</p>
             ${row.company_name ? `<p><b>Company:</b> ${escapeHtml(row.company_name)}</p>` : ''}
             ${row.priority && row.priority !== 'normal' ? `<p><b>Priority:</b> ${escapeHtml(row.priority)}</p>` : ''}
             <p><a href="https://app.theopencrm.com/cases">Open in The Open CRM</a></p>`,
      sms: `Portal support request${row.company_name ? ` from ${row.company_name}` : ''}: "${row.subject || `#${row.id}`}". The Open CRM.`,
      link: '/cases',
      entityType: 'case',
      entityId: row.id,
    });
  } catch (err) {
    logger.warn?.('notify_portal_case_submitted_failed', { caseId, error: err.message });
    return { email: 'failed', sms: 'failed' };
  }
}

// Recipient (owner-first): the quote's deal owner, else the customer
// company's owner, else the quote creator. The submitter is an external
// customer — there is no actor to skip.
async function notifyPortalQuoteResponse(quoteId) {
  try {
    const r = await pool.query(
      `SELECT q.id, q.title, q.org_id, q.portal_response, q.portal_response_note,
              co.name AS company_name,
              u.id AS recipient_id, u.notification_preferences
         FROM quotes q
         LEFT JOIN companies co ON co.id = q.customer_id
         LEFT JOIN deals d ON d.id = q.deal_id
         LEFT JOIN users u ON u.id = COALESCE(d.owner_user_id, co.owner_user_id, q.user_id)
        WHERE q.id = $1`,
      [quoteId]
    );
    const row = r.rows[0];
    if (!row || !row.recipient_id) {
      console.info(`[notify] notifyPortalQuoteResponse: quote ${quoteId} or recipient not found`);
      return SKIPPED;
    }

    const verb = row.portal_response === 'approved' ? 'APPROVED' : 'requested changes on';
    const subject = `Customer ${verb} quote${row.company_name ? ` (${row.company_name})` : ''}: ${row.title || `#${row.id}`}`;
    const text = [
      `A customer just ${verb === 'APPROVED' ? 'approved' : 'requested changes on'} a quote through their portal link.`,
      ``,
      `Quote: ${row.title || `#${row.id}`}`,
      row.company_name ? `Company: ${row.company_name}` : null,
      row.portal_response_note ? `Note: ${row.portal_response_note}` : null,
      ``,
      `Open it in the app: https://app.theopencrm.com/quotes`,
    ].filter(Boolean).join('\n');

    return await fanOut({
      recipientId: row.recipient_id,
      prefs: row.notification_preferences,
      orgId: row.org_id,
      category: 'portal_quote_response',
      subject,
      text,
      html: `<p>A customer just ${verb === 'APPROVED' ? 'approved' : 'requested changes on'} a quote through their portal link.</p>
             <p><b>Quote:</b> ${escapeHtml(row.title || `#${row.id}`)}</p>
             ${row.company_name ? `<p><b>Company:</b> ${escapeHtml(row.company_name)}</p>` : ''}
             ${row.portal_response_note ? `<p><b>Note:</b> ${escapeHtml(row.portal_response_note)}</p>` : ''}
             <p><a href="https://app.theopencrm.com/quotes">Open in The Open CRM</a></p>`,
      sms: `Customer ${verb === 'APPROVED' ? 'approved' : 'requested changes on'} quote "${row.title || `#${row.id}`}". The Open CRM.`,
      link: '/quotes',
      entityType: 'quote',
      entityId: row.id,
    });
  } catch (err) {
    logger.warn?.('notify_portal_quote_response_failed', { quoteId, error: err.message });
    return { email: 'failed', sms: 'failed' };
  }
}

// Recipient (owner-first, same rule as portal cases): the company's
// owner_user_id when set, else the message row's tenant-attribution user
// (the admin who minted the link). The sender is an external customer.
async function notifyPortalMessageReceived(messageId) {
  try {
    const r = await pool.query(
      `SELECT pm.id, pm.body, pm.org_id, pm.company_id,
              co.name AS company_name,
              u.id AS recipient_id, u.notification_preferences
         FROM portal_messages pm
         LEFT JOIN companies co ON co.id = pm.company_id
         LEFT JOIN users u ON u.id = COALESCE(co.owner_user_id, pm.user_id)
        WHERE pm.id = $1`,
      [messageId]
    );
    const row = r.rows[0];
    if (!row || !row.recipient_id) {
      console.info(`[notify] notifyPortalMessageReceived: message ${messageId} or recipient not found`);
      return SKIPPED;
    }

    const preview = (row.body || '').slice(0, 140);
    const subject = `Portal message${row.company_name ? ` from ${row.company_name}` : ''}`;
    const text = [
      `A customer just wrote in their portal thread.`,
      ``,
      row.company_name ? `Company: ${row.company_name}` : null,
      `Message: ${preview}${(row.body || '').length > 140 ? '…' : ''}`,
      ``,
      `Reply from the account page: https://app.theopencrm.com/accounts/${row.company_id}`,
    ].filter(Boolean).join('\n');

    return await fanOut({
      recipientId: row.recipient_id,
      prefs: row.notification_preferences,
      orgId: row.org_id,
      category: 'portal_message_received',
      subject,
      text,
      html: `<p>A customer just wrote in their portal thread.</p>
             ${row.company_name ? `<p><b>Company:</b> ${escapeHtml(row.company_name)}</p>` : ''}
             <p><b>Message:</b> ${escapeHtml(preview)}${(row.body || '').length > 140 ? '…' : ''}</p>
             <p><a href="https://app.theopencrm.com/accounts/${row.company_id}">Reply in The Open CRM</a></p>`,
      sms: `Portal message${row.company_name ? ` from ${row.company_name}` : ''}: "${preview.slice(0, 80)}". The Open CRM.`,
      link: `/accounts/${row.company_id}`,
      entityType: 'company',
      entityId: row.company_id,
    });
  } catch (err) {
    logger.warn?.('notify_portal_message_received_failed', { messageId, error: err.message });
    return { email: 'failed', sms: 'failed' };
  }
}

// Recipient (owner-first, same rule as the other portal producers): the
// company's owner_user_id when set, else the row's tenant-attribution user.
async function notifyPortalDocumentUploaded(documentId) {
  try {
    const r = await pool.query(
      `SELECT d.id, d.filename, d.org_id, d.related_id AS company_id,
              co.name AS company_name,
              u.id AS recipient_id, u.notification_preferences
         FROM documents d
         LEFT JOIN companies co ON co.id = d.related_id AND d.related_type = 'company'
         LEFT JOIN users u ON u.id = COALESCE(co.owner_user_id, d.user_id)
        WHERE d.id = $1`,
      [documentId]
    );
    const row = r.rows[0];
    if (!row || !row.recipient_id) {
      console.info(`[notify] notifyPortalDocumentUploaded: document ${documentId} or recipient not found`);
      return SKIPPED;
    }

    const subject = `Portal upload${row.company_name ? ` from ${row.company_name}` : ''}: ${row.filename || `#${row.id}`}`;
    const text = [
      `A customer just uploaded a file through their portal link.`,
      ``,
      `File: ${row.filename || `#${row.id}`}`,
      row.company_name ? `Company: ${row.company_name}` : null,
      ``,
      row.company_id ? `Review it on the account page: https://app.theopencrm.com/accounts/${row.company_id}` : null,
    ].filter(Boolean).join('\n');

    return await fanOut({
      recipientId: row.recipient_id,
      prefs: row.notification_preferences,
      orgId: row.org_id,
      category: 'portal_document_uploaded',
      subject,
      text,
      html: `<p>A customer just uploaded a file through their portal link.</p>
             <p><b>File:</b> ${escapeHtml(row.filename || `#${row.id}`)}</p>
             ${row.company_name ? `<p><b>Company:</b> ${escapeHtml(row.company_name)}</p>` : ''}
             ${row.company_id ? `<p><a href="https://app.theopencrm.com/accounts/${row.company_id}">Review in The Open CRM</a></p>` : ''}`,
      sms: `Portal upload${row.company_name ? ` from ${row.company_name}` : ''}: "${row.filename || `#${row.id}`}". The Open CRM.`,
      link: row.company_id ? `/accounts/${row.company_id}` : '/companies',
      entityType: 'document',
      entityId: row.id,
    });
  } catch (err) {
    logger.warn?.('notify_portal_document_uploaded_failed', { documentId, error: err.message });
    return { email: 'failed', sms: 'failed' };
  }
}

module.exports = {
  dispatch,
  notifyTaskAssigned,
  notifyTaskOverdue,
  notifyDealActivity,
  notifyWeeklySummary,
  notifyCaseAssigned,
  notifyCaseStatusChanged,
  notifyPortalCaseSubmitted,
  notifyPortalQuoteResponse,
  notifyPortalMessageReceived,
  notifyPortalDocumentUploaded,
  notifyLeadCaptured,
  notifyLeadAssigned,
  notifyMeetingScheduled,
  notifySequenceCompleted,
  notifyPlaybookTasksCreated,
  notifyMention,
  KNOWN_CATEGORIES,
};

// --------------------------------------------------------------------------
// FUTURE WIRE-UP — call sites planned but not yet implemented.
//
//   notifyTaskAssigned(taskId):
//     - POST /api/tasks (backend/routes/taskRoutes.js) after INSERT, when
//       assigned_to != req.userId.
//     - PUT  /api/tasks/:id when assigned_to changes to a non-null value.
//
//   notifyTaskOverdue(taskId):
//     - A new cron worker (planned: backend/services/overdueTaskWorker.js)
//       modelled on accountDeletionWorker.js, ticking hourly, that finds
//       tasks where due_date < now() AND status NOT IN ('done','cancelled')
//       AND last_overdue_notified_at IS NULL OR older than 24h. Update
//       last_overdue_notified_at after each call.
//
//   notifyDealActivity(dealId, activityId):
//     - POST /api/activities (backend/routes/activityRoutes.js) after INSERT
//       when deal_id is non-null and the activity's user_id != deal.user_id
//       (i.e. someone else logged activity on my deal).
//     - PUT  /api/deals/:id when stage changes — synthesize a system activity
//       row first, then call notifyDealActivity.
//
//   notifyWeeklySummary(userId):
//     - A weekly cron (planned: backend/services/weeklySummaryWorker.js)
//       running Mondays ~08:00 in the user's timezone (or server TZ for v1).
//       For each active user, call notifyWeeklySummary(user.id).
//
// All call sites should be fire-and-forget with a .catch(()=>{}) so
// notification failures never break the originating user action.
// --------------------------------------------------------------------------
