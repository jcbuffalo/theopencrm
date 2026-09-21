// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Consolidated notification email (spec 204, migration 173).
//
// Owner dogfood feedback, 2026-09-21: "the email alerts should be
// consolidated so I don't get six meh emails, and a CTA that does the task
// should be in the email so I can get work done from the reminder link."
//
// HOW IT FITS TOGETHER
//   notificationDispatcher.dispatch() is the single place a per-user alert
//   email is sent. It now asks deliveryPref(user) first:
//     'instant' — send right away (as before), with action buttons appended.
//     'batched' — enqueue(); the worker flushes a user's pending rows into
//                 ONE email once the oldest is BATCH_WINDOW_MINUTES old.
//     'daily'   — enqueue(); the worker sends ONE email at the user's hour
//                 (in their timezone) containing the queued events AND the
//                 live My Day queue (tasks due, next steps, quiet accounts,
//                 deals needing attention, renewals) — every row with a
//                 one-click button minted by services/emailActions.js.
//   Default mode is DEFAULT_EMAIL_DELIVERY_MODE (env; 'daily'). Nothing is
//   sent to a user who has every email category switched off, and a digest
//   with nothing in it is not sent at all.
//
// PREFERENCE SHAPE (users.notification_preferences.email_delivery)
//   { mode: 'instant'|'batched'|'daily', hour: 0-23, tz: 'America/New_York' }
//   The Settings page saves the browser's IANA timezone alongside the mode;
//   until it does, DEFAULT_TIMEZONE (env; 'America/New_York') applies.
//
// PUBLIC API
//   deliveryPref(prefs)                       → { mode, hour, tz }
//   enqueue({...})                            → queued row
//   flushUser(userRow, { kind, now })         → { sent, items, reason? }
//   tick({ now })                             → { batched, daily, skipped }
//   buildEmail(user, { queued, live, kind })  → { subject, html, text }  (exported for tests/preview)
//   sweep()                                   → rows deleted

const pool = require('../db');
const email = require('./email');
const emailActions = require('./emailActions');
const { loadMyDay } = require('./myDay');

const PRODUCT_NAME = process.env.PRODUCT_NAME || 'The Open CRM';
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://app.theopencrm.com';
const DEFAULT_MODE = ['instant', 'batched', 'daily'].includes(process.env.DEFAULT_EMAIL_DELIVERY_MODE)
  ? process.env.DEFAULT_EMAIL_DELIVERY_MODE : 'daily';
const DEFAULT_HOUR = 7;
const DEFAULT_TIMEZONE = process.env.DEFAULT_TIMEZONE || 'America/New_York';
const BATCH_WINDOW_MINUTES = Math.max(1, Number(process.env.DIGEST_BATCH_WINDOW_MINUTES) || 15);
const MODES = new Set(['instant', 'batched', 'daily']);
const SECTION_CAP = 8;

// --------------------------------------------------------------------------
// Preferences + time helpers
// --------------------------------------------------------------------------

function validTz(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

function deliveryPref(prefs) {
  const d = prefs && typeof prefs === 'object' && prefs.email_delivery && typeof prefs.email_delivery === 'object'
    ? prefs.email_delivery : {};
  const mode = MODES.has(d.mode) ? d.mode : DEFAULT_MODE;
  const hour = Number.isInteger(d.hour) && d.hour >= 0 && d.hour <= 23 ? d.hour : DEFAULT_HOUR;
  const tz = validTz(d.tz) ? d.tz : DEFAULT_TIMEZONE;
  return { mode, hour, tz };
}

// Does this user want ANY email at all? (every category off = no digest.)
function anyEmailCategoryOn(prefs) {
  if (!prefs || typeof prefs !== 'object') return false;
  return Object.entries(prefs).some(([k, v]) => k !== 'email_delivery' && v && typeof v === 'object' && v.email === true);
}

function localParts(date, tz) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', weekday: 'short',
  });
  const p = {};
  for (const part of f.formatToParts(date)) p[part.type] = part.value;
  return { dateKey: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24, weekday: p.weekday };
}

function fmtDay(d, tz) {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(d));
  } catch { return String(d).slice(0, 10); }
}

function fmtMoney(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '';
  return v >= 1000 ? `$${Math.round(v).toLocaleString('en-US')}` : `$${v.toLocaleString('en-US')}`;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// --------------------------------------------------------------------------
// Queue
// --------------------------------------------------------------------------

async function enqueue({ orgId = null, userId, category, subject, text = null, html = null, link = null, entityType = null, entityId = null, actions = [] }) {
  const r = await pool.query(
    `INSERT INTO notification_email_queue (org_id, user_id, category, subject, text, html, link, entity_type, entity_id, actions)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
    [orgId || null, userId, category, subject || category, text, html, link, entityType, entityId, JSON.stringify(Array.isArray(actions) ? actions : [])]
  );
  return r.rows[0];
}

// --------------------------------------------------------------------------
// Rendering
// --------------------------------------------------------------------------

const BTN_PRIMARY = 'display:inline-block;padding:8px 14px;border-radius:6px;background:#2563eb;color:#ffffff;text-decoration:none;font-weight:600;font-size:13px;margin:0 6px 6px 0';
const BTN_SECONDARY = 'display:inline-block;padding:8px 14px;border-radius:6px;background:#ffffff;color:#1f2937;border:1px solid #d1d5db;text-decoration:none;font-weight:600;font-size:13px;margin:0 6px 6px 0';
const LINK = 'color:#2563eb;text-decoration:none;font-size:13px';

function button(label, url, primary) {
  return `<a href="${esc(url)}" style="${primary ? BTN_PRIMARY : BTN_SECONDARY}">${esc(label)}</a>`;
}

function row({ title, meta, buttons }) {
  return `<tr><td style="padding:12px 0;border-bottom:1px solid #f3f4f6">
    <div style="font-size:15px;font-weight:600;color:#111827;line-height:1.35">${title}</div>
    ${meta ? `<div style="font-size:13px;color:#6b7280;margin-top:2px">${meta}</div>` : ''}
    ${buttons && buttons.length ? `<div style="margin-top:8px">${buttons.join('')}</div>` : ''}
  </td></tr>`;
}

function sectionHtml(heading, rows, more) {
  if (!rows.length) return '';
  return `<tr><td style="padding:22px 0 0 0">
    <div style="font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#6b7280;padding-bottom:4px;border-bottom:2px solid #e5e7eb">${esc(heading)}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows.join('')}</table>
    ${more > 0 ? `<div style="font-size:13px;color:#6b7280;padding-top:8px">+${more} more in <a href="${esc(PUBLIC_BASE_URL)}/today" style="${LINK}">My Day</a></div>` : ''}
  </td></tr>`;
}

function shell({ title, intro, body, footer }) {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f3f4f6">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:24px 12px">
<tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;padding:28px 28px 20px 28px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827">
  <tr><td style="font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#2563eb">${esc(PRODUCT_NAME)}</td></tr>
  <tr><td style="font-size:22px;font-weight:700;padding-top:6px;color:#111827">${title}</td></tr>
  ${intro ? `<tr><td style="font-size:14px;color:#4b5563;padding-top:6px;line-height:1.5">${intro}</td></tr>` : ''}
  ${body}
  <tr><td style="padding-top:24px;font-size:12px;color:#9ca3af;line-height:1.5;border-top:1px solid #f3f4f6;margin-top:16px">${footer}</td></tr>
</table>
</td></tr></table></body></html>`;
}

// Build the queued-events and live sections with minted action links.
// `mint` is injected so tests can stub token creation.
async function buildEmail(user, { queued = [], live = null, kind = 'daily', now = new Date(), mint = emailActions.mint } = {}) {
  const pref = deliveryPref(user.notification_preferences);
  const base = { orgId: user.org_id || null, userId: user.id };
  const act = async (action, entityId, params) => (await mint({ ...base, action, entityId, params })).url;
  const open = (path) => `${PUBLIC_BASE_URL}${path}`;

  const sections = [];
  const textLines = [];
  let itemCount = 0;

  // ---- Live queue (daily only) ------------------------------------------
  if (live) {
    const tasks = live.tasksDue || [];
    const trs = [];
    for (const t of tasks.slice(0, SECTION_CAP)) {
      const meta = [
        t.overdue_days > 0 ? `${t.overdue_days} day${t.overdue_days === 1 ? '' : 's'} overdue` : 'Due today',
        t.deal_title ? `Deal: ${t.deal_title}` : null,
        t.contact_name ? t.contact_name : null,
      ].filter(Boolean).map(esc).join(' · ');
      trs.push(row({
        title: esc(t.title || `Task #${t.id}`),
        meta,
        buttons: [
          button('Mark done', await act('task.complete', t.id), true),
          button('Snooze a day', await act('task.snooze', t.id, { days: 1 })),
          `<a href="${esc(open(`/tasks?taskId=${t.id}`))}" style="${LINK}">Open</a>`,
        ],
      }));
      textLines.push(`- Task: ${t.title || `#${t.id}`}${t.overdue_days > 0 ? ` (${t.overdue_days}d overdue)` : ' (due today)'}`);
    }
    itemCount += tasks.length;
    sections.push(sectionHtml(`Tasks due (${tasks.length})`, trs, tasks.length - trs.length));

    const steps = live.nextSteps || [];
    const srs = [];
    for (const d of steps.slice(0, SECTION_CAP)) {
      srs.push(row({
        title: `${esc(d.next_step)}`,
        meta: [d.title, d.company_name, d.amount ? fmtMoney(d.amount) : null, d.overdue_days > 0 ? `${d.overdue_days}d overdue` : 'due today'].filter(Boolean).map(esc).join(' · '),
        buttons: [
          button('Step done', await act('deal.next_step.complete', d.id), true),
          button('Snooze a day', await act('deal.next_step.snooze', d.id, { days: 1 })),
          `<a href="${esc(open(`/deals?dealId=${d.id}`))}" style="${LINK}">Open deal</a>`,
        ],
      }));
      textLines.push(`- Next step: ${d.next_step} (${d.title})`);
    }
    itemCount += steps.length;
    sections.push(sectionHtml(`Next steps due (${steps.length})`, srs, steps.length - srs.length));

    const quiet = live.quietAccounts || [];
    const qrs = [];
    for (const a of quiet.slice(0, SECTION_CAP)) {
      qrs.push(row({
        title: esc(a.name),
        meta: esc(a.days_since_last_touch == null ? 'Never touched' : `${a.days_since_last_touch} days since last touch`),
        buttons: [
          button('Log a touch', await act('company.touch', a.id), true),
          `<a href="${esc(open(`/accounts/${a.id}`))}" style="${LINK}">Open account</a>`,
        ],
      }));
      textLines.push(`- Quiet account: ${a.name}`);
    }
    itemCount += quiet.length;
    sections.push(sectionHtml(`Accounts gone quiet (${quiet.length})`, qrs, quiet.length - qrs.length));

    const deals = live.dealsNeedingAttention || [];
    const drs = [];
    for (const d of deals.slice(0, SECTION_CAP)) {
      drs.push(row({
        title: esc(d.title),
        meta: [d.company_name || d.customer_name, d.amount ? fmtMoney(d.amount) : null,
          d.past_close_date ? `past expected close (${fmtDay(d.expected_close_date, pref.tz)})` : null,
          d.days_since_last_activity == null ? 'no activity logged' : `${d.days_since_last_activity}d since last activity`,
        ].filter(Boolean).map(esc).join(' · '),
        buttons: [`<a href="${esc(open(`/deals?dealId=${d.id}`))}" style="${LINK}">Open deal</a>`],
      }));
      textLines.push(`- Deal needs attention: ${d.title}`);
    }
    itemCount += deals.length;
    sections.push(sectionHtml(`Deals needing attention (${deals.length})`, drs, deals.length - drs.length));

    const ren = live.renewals || [];
    const rrs = [];
    for (const c of ren.slice(0, SECTION_CAP)) {
      rrs.push(row({
        title: esc(c.name || c.customer_name || `Contract #${c.id}`),
        meta: [c.customer_name, c.days_to_end != null ? `renews in ${c.days_to_end} day${Number(c.days_to_end) === 1 ? '' : 's'}` : null, c.monthly_amount ? `${fmtMoney(c.monthly_amount)}/mo` : null].filter(Boolean).map(esc).join(' · '),
        buttons: [`<a href="${esc(open('/renewals'))}" style="${LINK}">Open renewals</a>`],
      }));
      textLines.push(`- Renewal: ${c.name || c.customer_name}`);
    }
    itemCount += ren.length;
    sections.push(sectionHtml(`Renewals in the next 30 days (${ren.length})`, rrs, ren.length - rrs.length));
  }

  // ---- Queued events -----------------------------------------------------
  if (queued.length) {
    const byCat = new Map();
    for (const q of queued) {
      if (!byCat.has(q.category)) byCat.set(q.category, []);
      byCat.get(q.category).push(q);
    }
    const ers = [];
    for (const [cat, items] of byCat) {
      for (const q of items) {
        const acts = Array.isArray(q.actions) ? q.actions : [];
        const buttons = [];
        for (const a of acts) {
          if (!emailActions.isKnownAction(a.action) || !a.entity_id) continue;
          buttons.push(button(a.label || emailActions.ACTIONS[a.action].label, await act(a.action, a.entity_id, a.params || {}), buttons.length === 0));
        }
        if (q.link) buttons.push(`<a href="${esc(q.link.startsWith('http') ? q.link : open(q.link))}" style="${LINK}">Open</a>`);
        ers.push(row({
          title: esc(q.subject),
          meta: `${esc(CATEGORY_LABELS[cat] || cat.replace(/_/g, ' '))} · ${esc(fmtDay(q.created_at, pref.tz))}`,
          buttons,
        }));
        textLines.push(`- ${q.subject}${q.link ? ` — ${q.link.startsWith('http') ? q.link : open(q.link)}` : ''}`);
      }
    }
    itemCount += queued.length;
    sections.push(sectionHtml(kind === 'daily' ? `Since your last digest (${queued.length})` : `Updates (${queued.length})`, ers, 0));
  }

  const lp = localParts(now, pref.tz);
  const dayLabel = fmtDay(now, pref.tz);
  let title;
  let subject;
  if (kind === 'daily') {
    const bits = [];
    if (live) {
      if (live.tasksDue?.length) bits.push(`${live.tasksDue.length} task${live.tasksDue.length === 1 ? '' : 's'}`);
      if (live.nextSteps?.length) bits.push(`${live.nextSteps.length} next step${live.nextSteps.length === 1 ? '' : 's'}`);
      if (live.quietAccounts?.length) bits.push(`${live.quietAccounts.length} quiet account${live.quietAccounts.length === 1 ? '' : 's'}`);
      if (live.dealsNeedingAttention?.length) bits.push(`${live.dealsNeedingAttention.length} deal${live.dealsNeedingAttention.length === 1 ? '' : 's'} to look at`);
    }
    if (queued.length) bits.push(`${queued.length} update${queued.length === 1 ? '' : 's'}`);
    title = `Your day, ${esc(dayLabel)}`;
    subject = `Your day, ${dayLabel}${bits.length ? ` — ${bits.join(', ')}` : ''}`;
  } else if (queued.length === 1) {
    title = esc(queued[0].subject);
    subject = queued[0].subject;
  } else {
    title = `${queued.length} updates`;
    subject = `${queued.length} updates from ${PRODUCT_NAME}`;
  }

  const firstName = (user.name || '').trim().split(/\s+/)[0] || null;
  const intro = kind === 'daily'
    ? `${firstName ? `${esc(firstName)}, here` : 'Here'}'s everything that needs you. Each button does the thing right away — no sign-in — and single-use links expire in 7 days.`
    : `The buttons act right away, no sign-in. Single-use links expire in 7 days.`;

  const footer = kind === 'daily'
    ? `You get this once a day at ${String(pref.hour).padStart(2, '0')}:00 (${esc(pref.tz)}). Switch to instant or every 15 minutes in <a href="${esc(open('/settings#notifications'))}" style="${LINK}">Settings → Notifications</a>. · <a href="${esc(open('/today'))}" style="${LINK}">Open My Day</a>`
    : `Grouped every ${BATCH_WINDOW_MINUTES} minutes. Change to instant or a daily digest in <a href="${esc(open('/settings#notifications'))}" style="${LINK}">Settings → Notifications</a>.`;

  const html = shell({ title, intro, body: sections.join(''), footer });
  const text = [
    subject, '',
    ...textLines, '',
    `Open My Day: ${open('/today')}`,
    `Delivery settings: ${open('/settings#notifications')}`,
  ].join('\n');

  return { subject, html, text, itemCount, localDateKey: lp.dateKey };
}

const CATEGORY_LABELS = {
  task_assigned: 'Task assigned', task_overdue: 'Overdue task', deal_activity: 'Deal activity',
  weekly_summary: 'Weekly summary', case_assigned: 'Case assigned', case_status_changed: 'Case status',
  lead_captured: 'New lead', lead_assigned: 'Lead assigned', meeting_scheduled: 'Meeting',
  sequence_completed: 'Sequence done', playbook_tasks_created: 'Playbook', mention: 'Mention',
  portal_case_submitted: 'Portal case', portal_quote_response: 'Quote response',
  portal_message_received: 'Portal message', portal_document_uploaded: 'Portal upload',
};

// For 'instant' delivery: the same one-click buttons, appended to a single
// alert email's html/text. Returns { html, text } fragments ('' when there
// is nothing to add).
async function renderInstantActions(user, { actions = [], link = null, mint = emailActions.mint } = {}) {
  const base = { orgId: user.org_id || null, userId: user.id };
  const buttons = [];
  const lines = [];
  for (const a of actions) {
    if (!a || !emailActions.isKnownAction(a.action) || !a.entity_id) continue;
    const { url } = await mint({ ...base, action: a.action, entityId: a.entity_id, params: a.params || {} });
    const label = a.label || emailActions.ACTIONS[a.action].label;
    buttons.push(button(label, url, buttons.length === 0));
    lines.push(`${label}: ${url}`);
  }
  if (link) {
    const url = link.startsWith('http') ? link : `${PUBLIC_BASE_URL}${link}`;
    buttons.push(`<a href="${esc(url)}" style="${LINK}">Open in ${esc(PRODUCT_NAME)}</a>`);
    lines.push(`Open: ${url}`);
  }
  if (!buttons.length) return { html: '', text: '' };
  return {
    html: `<div style="margin-top:14px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">${buttons.join('')}<div style="font-size:11px;color:#9ca3af;margin-top:6px">Buttons act right away, no sign-in. Single-use, expire in 7 days.</div></div>`,
    text: `\n\n${lines.join('\n')}\n(Links act right away; single-use, expire in 7 days.)`,
  };
}

// --------------------------------------------------------------------------
// Flushing
// --------------------------------------------------------------------------

function toAddress(user) {
  return (user.notification_email && user.notification_email.trim()) || user.email || null;
}

async function loadUser(userId) {
  const r = await pool.query(
    `SELECT id, email, name, org_id, status, notification_email, notification_preferences, digest_last_sent_at
       FROM users WHERE id = $1`,
    [userId]
  );
  return r.rows[0] || null;
}

// Send one consolidated email to `user`. kind: 'daily' (queued + live) or
// 'batched' (queued only). Claims the queue rows atomically (digest_id) so
// two pods can't both send them; releases the claim if the send fails.
async function flushUser(user, { kind = 'daily', now = new Date(), force = false } = {}) {
  const to = toAddress(user);
  if (!to) return { sent: false, reason: 'no_address' };
  if (!force && !anyEmailCategoryOn(user.notification_preferences)) return { sent: false, reason: 'email_off' };

  const digestId = `${kind}:${user.id}:${now.getTime()}`;
  const claimed = await pool.query(
    `UPDATE notification_email_queue SET digest_id = $1
      WHERE user_id = $2 AND flushed_at IS NULL AND digest_id IS NULL
      RETURNING *`,
    [digestId, user.id]
  );
  const queued = claimed.rows.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

  let live = null;
  if (kind === 'daily') {
    const sf = user.org_id ? 'org_id' : 'user_id';
    const sv = user.org_id || user.id;
    try { live = await loadMyDay({ sf, sv, userId: user.id }); } catch (err) { console.warn('digest_live_load_failed', err && err.message); live = null; }
  }

  const built = await buildEmail(user, { queued, live, kind, now });
  if (built.itemCount === 0) {
    // Nothing to say — release the (empty) claim and stay quiet.
    return { sent: false, reason: 'empty', items: 0 };
  }

  try {
    await email.sendMail({
      to,
      subject: built.subject,
      html: built.html,
      text: built.text,
    });
  } catch (err) {
    await pool.query('UPDATE notification_email_queue SET digest_id = NULL WHERE digest_id = $1', [digestId]);
    throw err;
  }
  await pool.query('UPDATE notification_email_queue SET flushed_at = NOW() WHERE digest_id = $1', [digestId]);
  return { sent: true, items: built.itemCount, queued: queued.length, subject: built.subject, digestId };
}

// One scheduler pass. Batched users flush once their oldest pending row is
// BATCH_WINDOW_MINUTES old (instant users with leftovers flush at once —
// they switched modes mid-flight). Daily users flush at their local hour,
// once per local day, claimed via digest_last_sent_at so parallel pods
// can't double-send.
async function tick({ now = new Date() } = {}) {
  const out = { batched: 0, daily: 0, skipped: 0, errors: 0 };

  // ---- batched / leftover ---------------------------------------------
  const pend = await pool.query(
    `SELECT q.user_id, MIN(q.created_at) AS oldest
       FROM notification_email_queue q
      WHERE q.flushed_at IS NULL AND q.digest_id IS NULL
      GROUP BY q.user_id`
  );
  for (const p of pend.rows) {
    try {
      const user = await loadUser(p.user_id);
      if (!user || user.status !== 'active') { out.skipped += 1; continue; }
      const pref = deliveryPref(user.notification_preferences);
      if (pref.mode === 'daily') continue; // handled below at the user's hour
      const ageMin = (now.getTime() - new Date(p.oldest).getTime()) / 60000;
      if (pref.mode === 'batched' && ageMin < BATCH_WINDOW_MINUTES) { out.skipped += 1; continue; }
      const r = await flushUser(user, { kind: 'batched', now });
      if (r.sent) out.batched += 1; else out.skipped += 1;
    } catch (err) {
      out.errors += 1;
      console.warn('digest_batched_flush_failed', { userId: p.user_id, error: err && err.message });
    }
  }

  // ---- daily ------------------------------------------------------------
  const users = await pool.query(
    `SELECT id, email, name, org_id, status, notification_email, notification_preferences, digest_last_sent_at
       FROM users
      WHERE status = 'active'
        AND COALESCE(notification_preferences->'email_delivery'->>'mode', $1) = 'daily'`,
    [DEFAULT_MODE]
  );
  for (const user of users.rows) {
    try {
      const pref = deliveryPref(user.notification_preferences);
      const lp = localParts(now, pref.tz);
      if (lp.hour !== pref.hour) continue;
      const lastKey = user.digest_last_sent_at ? localParts(new Date(user.digest_last_sent_at), pref.tz).dateKey : null;
      if (lastKey === lp.dateKey) continue;
      // Claim the day for this user before composing anything.
      const claim = await pool.query(
        `UPDATE users SET digest_last_sent_at = $2
          WHERE id = $1 AND digest_last_sent_at IS NOT DISTINCT FROM $3
          RETURNING id`,
        [user.id, now, user.digest_last_sent_at]
      );
      if (claim.rows.length === 0) continue;
      const r = await flushUser(user, { kind: 'daily', now });
      if (r.sent) out.daily += 1; else out.skipped += 1;
    } catch (err) {
      out.errors += 1;
      console.warn('digest_daily_flush_failed', { userId: user.id, error: err && err.message });
    }
  }
  return out;
}

// Retention: flushed queue rows older than 30 days, plus spent action tokens.
async function sweep() {
  const q = await pool.query(`DELETE FROM notification_email_queue WHERE flushed_at IS NOT NULL AND flushed_at < NOW() - INTERVAL '30 days'`);
  const t = await emailActions.sweep();
  return { queue: q.rowCount || 0, tokens: t };
}

module.exports = {
  deliveryPref, anyEmailCategoryOn, localParts, enqueue, buildEmail, renderInstantActions, flushUser, tick, sweep, loadUser,
  DEFAULT_MODE, DEFAULT_HOUR, DEFAULT_TIMEZONE, BATCH_WINDOW_MINUTES, MODES, CATEGORY_LABELS,
};
