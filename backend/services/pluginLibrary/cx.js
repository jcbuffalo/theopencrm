// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Curated library — CUSTOMER EXPERIENCE / RETENTION entries. See ./index.js
// for the authoring contract.
//
// Notes on honesty:
//   • The wave-1 case entries predate the SDK module objects and work
//     entirely from the case.created trigger payload, encoding SLAs as task
//     due dates (the overdue-task machinery then covers breach escalation).
//     Wave-2 entries use the flag-gated listCases / listServiceContracts /
//     updateCase surface — a disabled module returns []/null, so every entry
//     treats empty as "disabled or nothing to do", never as an error.
//   • AI entries call the metered, billing-gated crm.ai.complete (max 2
//     upstream calls per run) and ALWAYS degrade to embedding the copilot
//     brief in the task when AI is unconfigured or blocked — never a throw.

module.exports = [
  // --------------------------------------------------------------------------
  // EXISTING ENTRY — do not modify (moved verbatim from pluginLibrary.js).
  // --------------------------------------------------------------------------
  {
    slug: 'invoiced-survey',
    name: 'Customer survey on INVOICED',
    category: 'cx',
    icon: '⭐',
    summary:
      'When a deal moves to INVOICED, schedule a customer-experience survey email for 14 days later. The email asks for feedback on the order process.',
    tags: ['survey', 'cx', 'post-sale'],
    spec: {
      name: 'invoiced-survey',
      summary: 'Schedule a customer-experience survey 14 days after invoicing.',
      triggerEvent: 'deal.stage_changed',
      triggerFilter: { stage: 'INVOICED' },
      actions: [
        {
          kind: 'create_task',
          title_template: 'Send CX survey to {customer.name} for deal {deal.external_ref}',
          due_in_days: 14,
        },
      ],
    },
  },

  // --------------------------------------------------------------------------
  // NEW ENTRIES
  // --------------------------------------------------------------------------
  {
    slug: 'new-case-triage',
    name: 'New-case triage task',
    category: 'cx',
    icon: '🚑',
    summary:
      'Support cases that sit untriaged are how small problems become churn stories. The moment a case is filed, this creates a triage task carrying the case details, with priority mapped from the case (urgent and high-priority cases are due same-day) and a four-step triage checklist: acknowledge, reproduce, set severity, assign an owner.',
    tags: ['cases', 'support', 'triage'],
    spec: {
      name: 'new-case-triage',
      summary: 'On case creation, create a triage task with priority mapped from the case and a triage checklist.',
      triggerEvent: 'case.created',
      triggerFilter: null,
      actions: [
        { kind: 'create_task', title_template: 'Triage case: {case.subject}', due_in_days: 0 },
      ],
      source_code: `// Create a triage task the moment a support case is filed.
// Cases are not readable via the plugin SDK, so this works entirely from the
// trigger payload.
module.exports = {
  async run({ crm, input }) {
    var c = (input && (input.case || input.record)) || input || {};
    var subject = c.subject || c.title || 'new support case';
    var pr = String(c.priority || c.severity || '').toLowerCase();
    var priority = (pr === 'urgent' || pr === 'critical') ? 'urgent'
      : (pr === 'high') ? 'high'
      : 'medium';
    var sameDay = priority === 'urgent' || priority === 'high';
    var due = new Date(Date.now() + (sameDay ? 0 : 86400000)).toISOString().slice(0, 10);
    var bits = [];
    if (c.priority) bits.push('Case priority: ' + c.priority);
    if (c.company_name || c.company) bits.push('Company: ' + (c.company_name || c.company));
    if (c.contact_name || c.contact) bits.push('Contact: ' + (c.contact_name || c.contact));
    await crm.createTask({
      title: 'Triage case: ' + subject,
      description: (bits.length ? bits.join('\\n') + '\\n' : '') +
        'Triage checklist:\\n' +
        '1. Acknowledge receipt to the customer.\\n' +
        '2. Reproduce or verify the report.\\n' +
        '3. Confirm the severity is set correctly.\\n' +
        '4. Assign an owner and set the next update time.',
      due_date: due,
      priority: priority,
    });
    crm.log('Triage task created for case: ' + subject + ' (priority ' + priority + ')');
    return { task_created: true, priority: priority };
  },
};`,
    },
  },
  {
    slug: 'case-sla-timer',
    name: 'Case first-response SLA timer',
    category: 'cx',
    icon: '⏱️',
    summary:
      'Turn your first-response SLA into something the CRM enforces instead of something everyone remembers to feel bad about. When a case arrives, this creates an SLA task whose due date encodes your response window by priority — urgent same-day, high next-day, everything else two days. Pair it with the overdue-task escalation extension and breaches surface automatically.',
    tags: ['cases', 'sla', 'support'],
    spec: {
      name: 'case-sla-timer',
      summary: 'On case creation, create a first-response SLA task with due date mapped from case priority.',
      triggerEvent: 'case.created',
      triggerFilter: { sla_days: { urgent: 0, high: 1, normal: 2 } },
      actions: [
        { kind: 'create_task', title_template: 'SLA: first response for "{case.subject}"', due_in_days: 0 },
      ],
      source_code: `// Encode the first-response SLA for a new case as a dated task.
// Cases are not readable via the plugin SDK, so this works from the trigger
// payload; breach follow-through comes from the overdue-task machinery.
module.exports = {
  async run({ crm, input }) {
    var c = (input && (input.case || input.record)) || input || {};
    var subject = c.subject || c.title || 'new support case';
    var pr = String(c.priority || c.severity || '').toLowerCase();
    var slaDays = (pr === 'urgent' || pr === 'critical') ? 0 : (pr === 'high') ? 1 : 2;
    var due = new Date(Date.now() + slaDays * 86400000).toISOString().slice(0, 10);
    await crm.createTask({
      title: 'SLA: first response for "' + subject + '"',
      description: 'First-response SLA clock started when this case was filed.\\n' +
        'Respond to the customer and mark this done. If this task goes overdue, the SLA is breached — treat it as an escalation.',
      due_date: due,
      priority: slaDays === 0 ? 'urgent' : 'high',
    });
    crm.log('SLA timer task created for case: ' + subject + ' (due ' + due + ')');
    return { task_created: true, sla_days: slaDays };
  },
};`,
    },
  },
  {
    slug: 'post-close-thank-you',
    name: 'Post-close thank-you note',
    category: 'cx',
    icon: '💌',
    summary:
      'A personal thank-you inside 48 hours of signing is the cheapest retention tool that exists — and the easiest to forget. When a deal closes won, this creates a high-priority task with the customer\'s details. With AI enabled, the warm, specific thank-you note is drafted right into the task, ready to review and send (metered per-org); without AI, the task carries the talking points and a ready-to-run copilot brief instead.',
    tags: ['post-sale', 'ai', 'relationship'],
    spec: {
      name: 'post-close-thank-you',
      summary: 'On closed-won, create a 48-hour thank-you task carrying an AI-ready drafting brief and the contact details.',
      triggerEvent: 'deal.stage_changed',
      triggerFilter: { stage: 'CLOSED_WON' },
      actions: [
        { kind: 'create_task', title_template: 'Send thank-you note: {deal.title}', due_in_days: 1 },
        {
          kind: 'claude_complete',
          prompt_template:
            'Write a short, warm thank-you email to {contact.first_name} about the signed deal "{deal.title}". Two short paragraphs, no salesy language, mention we are excited to get started. Output the email body only.',
          store_as: 'draft',
        },
      ],
      source_code: `// Create a thank-you task (with an AI-ready brief) when a deal closes won.
module.exports = {
  async run({ crm, input }) {
    var rec = (input && (input.deal || input.record)) || input || {};
    var stage = String((input && (input.newStage || input.new_stage)) || rec.stage || '').toUpperCase();
    if (stage !== 'CLOSED_WON') return { skipped: true, reason: 'not_closed_won' };
    var dealId = Number(rec.id || (input && (input.dealId || input.deal_id)));
    var deal = (Number.isInteger(dealId) && dealId > 0) ? await crm.getDeal(dealId) : null;
    var title = (deal && deal.title) || rec.title || 'the deal';
    var contact = (deal && deal.contact_id) ? await crm.getContact(deal.contact_id) : null;
    var name = contact ? (contact.first_name || [contact.first_name, contact.last_name].filter(Boolean).join(' ') || 'the customer') : 'the customer';
    var due = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    var brief = 'Write a short, warm thank-you email to ' + name + ' about the signed deal "' + title +
      '". Two short paragraphs, no salesy language, mention we are excited to get started.';
    // Metered in-run AI: draft the note now so the task is ready to send.
    // Falls back to embedding the copilot brief when AI is unconfigured or
    // billing-blocked.
    var draft = null;
    var ai = await crm.ai.complete({ prompt: brief + ' Output the email body only.', max_tokens: 400 });
    if (ai && ai.ok && ai.text) draft = ai.text;
    await crm.createTask({
      title: 'Send thank-you note: ' + title,
      description: 'A personal thank-you within 48 hours of signing sets the tone for the whole relationship.\\n' +
        (contact && contact.email ? 'Send to: ' + contact.email + '\\n' : '') +
        'Talking points: thank them for their trust, name one specific thing you are excited to deliver, and say who their point of contact is.\\n' +
        (draft
          ? 'AI draft (review before sending):\\n' + draft
          : 'Copilot brief (paste into chat to draft it): ' + brief),
      due_date: due,
      priority: 'high',
      deal_id: deal ? deal.id : null,
      contact_id: contact ? contact.id : null,
    });
    crm.log('Thank-you task created for ' + title + '. AI draft: ' + (draft ? 'yes' : 'no'));
    return { task_created: true, ai_drafted: !!draft };
  },
};`,
    },
  },
  {
    slug: 'renewal-prep-checklist',
    name: 'Renewal-window prep checklist',
    category: 'cx',
    icon: '🔄',
    summary:
      'Renewals are won in the sixty days before the ask, not on the day of it. This daily check watches deals you closed won roughly ten to eleven months ago and, as each enters the renewal window, files a prep task with a four-point checklist — review results delivered, refresh the stakeholder map, draft the renewal proposal, book the check-in — a week out, per account.',
    tags: ['renewals', 'retention', 'checklist'],
    spec: {
      name: 'renewal-prep-checklist',
      summary: 'Daily: closed-won deals 300–335 days old (by close date) each get a renewal-prep checklist task.',
      triggerEvent: 'schedule.daily',
      triggerFilter: { cron: '0 8 * * 1-5', window_start_days: 300, window_end_days: 335 },
      actions: [
        { kind: 'create_task', title_template: 'Renewal prep: {deal.title}', due_in_days: 7 },
      ],
      source_code: `// File a renewal-prep checklist for closed-won deals nearing the 1-year mark.
// Uses the deal expected_close_date as the anniversary reference.
module.exports = {
  async run({ crm, input }) {
    var startDays = (input && Number(input.window_start_days)) || 300;
    var endDays = (input && Number(input.window_end_days)) || 335;
    var won = await crm.listDeals({ stage: 'CLOSED_WON' });
    var now = Date.now();
    var inWindow = won.filter(function (d) {
      var ref = d.expected_close_date || d.updated_at;
      if (!ref) return false;
      var age = Math.floor((now - new Date(ref).getTime()) / 86400000);
      return age >= startDays && age <= endDays;
    });
    var due = new Date(now + 7 * 86400000).toISOString().slice(0, 10);
    var created = 0;
    for (var i = 0; i < inWindow.length && created < 8; i++) {
      var d = inWindow[i];
      await crm.createTask({
        title: 'Renewal prep: ' + (d.title || ('#' + d.id)),
        description: 'This account is entering its renewal window (closed roughly a year ago).\\n' +
          'Prep checklist:\\n' +
          '1. Review what was delivered and the results achieved.\\n' +
          '2. Refresh the stakeholder map — has the buyer changed?\\n' +
          '3. Draft the renewal proposal (pricing, scope changes).\\n' +
          '4. Book the renewal check-in call.',
        due_date: due,
        priority: 'high',
        deal_id: d.id,
        contact_id: d.contact_id || null,
      });
      created++;
    }
    crm.log('Deals in renewal window: ' + inWindow.length + '; prep tasks created: ' + created);
    return { in_window: inWindow.length, tasks_created: created };
  },
};`,
    },
  },
  {
    slug: 'gone-quiet-reengagement',
    name: 'Gone-quiet account re-engagement',
    category: 'cx',
    icon: '🔕',
    summary:
      'Accounts rarely announce they\'re drifting — they just go quiet. This daily sweep finds companies whose open deals have had no activity in 45+ days and creates a re-engagement task per account (up to six a day). With AI enabled, the two quietest accounts get a light, non-pushy check-in email drafted right into the task (metered per-org); the rest — and every account when AI is off — carry a ready-to-run copilot brief.',
    tags: ['retention', 'ai', 're-engagement'],
    spec: {
      name: 'gone-quiet-reengagement',
      summary: 'Daily: companies with 45+ days of deal silence each get a re-engagement task with an AI drafting brief (max 6/day).',
      triggerEvent: 'schedule.daily',
      triggerFilter: { cron: '0 9 * * 1-5', quiet_days: 45 },
      actions: [
        { kind: 'create_task', title_template: 'Re-engage {company.name}', due_in_days: 2 },
        {
          kind: 'claude_complete',
          prompt_template:
            'Draft a light, friendly re-engagement email to {company.name}. We have not spoken in over 45 days. Reference that we want to check in on their priorities — no hard sell. Under 100 words. Output the email body only.',
          store_as: 'draft',
        },
      ],
      source_code: `// Find accounts whose deals have gone quiet and queue re-engagement.
module.exports = {
  async run({ crm, input }) {
    var quietDays = (input && Number(input.quiet_days)) || 45;
    var cutoff = Date.now() - quietDays * 86400000;
    var deals = await crm.listDeals({ status: 'open' });
    var lastByCompany = {};
    for (var i = 0; i < deals.length; i++) {
      var d = deals[i];
      if (!d.company_id) continue;
      var t = new Date(d.last_activity_at || d.updated_at || d.created_at || 0).getTime();
      if (!lastByCompany[d.company_id] || t > lastByCompany[d.company_id]) {
        lastByCompany[d.company_id] = t;
      }
    }
    var quietIds = Object.keys(lastByCompany).filter(function (id) { return lastByCompany[id] < cutoff; });
    var due = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
    var created = 0;
    var drafted = 0;
    // The sandbox allows 2 upstream AI calls per run — spend them on the two
    // quietest accounts and fall back to the copilot brief for the rest.
    var aiLeft = 2;
    for (var j = 0; j < quietIds.length && created < 6; j++) {
      var companyId = Number(quietIds[j]);
      var company = await crm.getCompany(companyId);
      if (!company) continue;
      var days = Math.floor((Date.now() - lastByCompany[quietIds[j]]) / 86400000);
      var brief = 'Draft a light, friendly re-engagement email to ' + company.name +
        '. We have not spoken in ' + days + ' days. Check in on their priorities — no hard sell. Under 100 words.';
      var draft = null;
      if (aiLeft > 0) {
        var ai = await crm.ai.complete({ prompt: brief + ' Output the email body only.', max_tokens: 250 });
        if (ai && ai.ok && ai.text) { draft = ai.text; aiLeft--; drafted++; }
        else aiLeft = 0; // unconfigured/blocked/failed — stop trying this run
      }
      await crm.createTask({
        title: 'Re-engage ' + company.name + ' (' + days + ' days quiet)',
        description: 'No deal activity with this account in ' + days + ' days.\\n' +
          'Reach out with something useful — a relevant idea, a check-in on their priorities, or a quick win from a similar customer.\\n' +
          (draft
            ? 'AI draft (review before sending):\\n' + draft
            : 'Copilot brief (paste into chat to draft it): ' + brief),
        due_date: due,
        priority: 'medium',
      });
      created++;
    }
    crm.log('Quiet accounts: ' + quietIds.length + '; re-engagement tasks created: ' + created + '; AI drafts: ' + drafted);
    return { quiet_accounts: quietIds.length, tasks_created: created, ai_drafted: drafted };
  },
};`,
    },
  },

  // --------------------------------------------------------------------------
  // WAVE 2 (2026-09) — service ops + CS agents on the expanded SDK
  // (listCases / updateCase / listServiceContracts). Every module read is
  // flag-gated per org and returns [] when disabled — these entries treat
  // empty as "disabled or nothing to do".
  // --------------------------------------------------------------------------
  {
    slug: 'case-backlog-digest',
    name: 'Case backlog digest',
    category: 'cx',
    icon: '📥',
    summary:
      'A support backlog you don\'t look at daily is a backlog that gets looked at by customers first. Every day this counts your open cases by priority, names the five oldest with their ages, and calls out how many have already blown past their SLA due time — one digest task, priority-weighted so an urgent backlog files an urgent digest. Quiet queues (or workspaces without the cases module) create nothing.',
    tags: ['cases', 'support', 'digest'],
    spec: {
      name: 'case-backlog-digest',
      summary: 'Daily digest task of open cases by priority and age, with SLA-breached count. Skips when the queue is empty.',
      triggerEvent: 'schedule.daily',
      triggerFilter: { cron: '0 8 * * 1-5' },
      actions: [
        { kind: 'create_task', title_template: 'Case backlog: {count} open — {today}', due_in_days: 0 },
      ],
      source_code: `// Daily open-case backlog digest, by priority and age.
module.exports = {
  async run({ crm }) {
    // Returns [] when the cases module is disabled for this workspace.
    // Belt and braces: re-check status client-side too.
    var cases = (await crm.listCases({ status: 'open' })).filter(function (c) {
      return String(c.status || '') === 'open';
    });
    if (cases.length === 0) {
      crm.log('No open cases (or the cases module is disabled). Nothing to digest.');
      return { open_cases: 0 };
    }
    var now = Date.now();
    var rank = { urgent: 0, high: 1, medium: 2, low: 3 };
    var byPriority = {};
    var breached = 0;
    for (var i = 0; i < cases.length; i++) {
      var c = cases[i];
      var p = String(c.priority || 'medium').toLowerCase();
      byPriority[p] = (byPriority[p] || 0) + 1;
      if (c.sla_due_at && new Date(c.sla_due_at).getTime() < now) breached++;
    }
    var priorityLines = Object.keys(byPriority).sort(function (a, b) {
      return (rank[a] == null ? 9 : rank[a]) - (rank[b] == null ? 9 : rank[b]);
    }).map(function (p) { return '- ' + p + ': ' + byPriority[p]; });
    var oldest = cases.slice().sort(function (a, b) {
      return new Date(a.created_at || 0).getTime() - new Date(b.created_at || 0).getTime();
    }).slice(0, 5).map(function (c) {
      var days = Math.floor((now - new Date(c.created_at || now).getTime()) / 86400000);
      return '- #' + c.id + ' "' + (c.subject || '') + '" [' + (c.priority || 'medium') + '] — open ' + days + ' day(s)';
    });
    var today = new Date().toISOString().slice(0, 10);
    var urgent = (byPriority.urgent || 0) > 0 || breached > 0;
    await crm.createTask({
      title: 'Case backlog: ' + cases.length + ' open' + (breached ? ', ' + breached + ' past SLA' : '') + ' — ' + today,
      description: 'Open cases by priority:\\n' + priorityLines.join('\\n') + '\\n' +
        'Past their SLA due time: ' + breached + '\\n' +
        'Oldest open cases:\\n' + oldest.join('\\n') + '\\n' +
        'Work the breached and urgent ones first; then knock down the oldest.',
      due_date: today,
      priority: urgent ? 'urgent' : 'medium',
    });
    crm.log('Case backlog: ' + cases.length + ' open, ' + breached + ' past SLA.');
    return { open_cases: cases.length, sla_breached: breached };
  },
};`,
    },
  },
  {
    slug: 'ai-case-triage',
    name: 'AI case triage & reply draft',
    category: 'cx',
    icon: '🤖',
    summary:
      'First response is half classification, half composition — and both are automatable enough to draft. When a case is filed, this reads it and makes one metered AI call to classify it (category, suggested severity) and draft a first reply, landing both in a triage task for a human to review and send (AI never replies to the customer itself). Without AI, the task carries the case details and a ready-to-run copilot brief instead.',
    tags: ['cases', 'support', 'ai'],
    spec: {
      name: 'ai-case-triage',
      summary: 'On case creation, one AI call classifies the case and drafts a first reply into a review task. Falls back to a copilot brief.',
      triggerEvent: 'case.created',
      triggerFilter: null,
      actions: [
        { kind: 'create_task', title_template: 'Triage & reply: {case.subject}', due_in_days: 0 },
        {
          kind: 'claude_complete',
          prompt_template:
            'Classify this support case (category + suggested severity, one line each) and draft a short, empathetic first reply. Case: {case.subject} — {case.description}',
          store_as: 'triage',
        },
      ],
      source_code: `// AI-classify a new case and draft the first reply into a review task.
module.exports = {
  async run({ crm, input }) {
    var t = (input && input.trigger) || input || {};
    var c = t.case || t.record || t;
    var caseId = Number(c.id || t.caseId || t.case_id);
    // Pull the full case for its description when readable (returns null if
    // the cases module is disabled — the payload still carries the basics).
    var full = (Number.isInteger(caseId) && caseId > 0) ? await crm.getCase(caseId) : null;
    var subject = (full && full.subject) || c.subject || c.title || 'new support case';
    var descr = (full && full.description) ? String(full.description).slice(0, 2000) : '';
    var priority = String((full && full.priority) || c.priority || 'medium').toLowerCase();
    var brief = 'Classify this support case (category and suggested severity, one line each), then draft a short, empathetic first reply. ' +
      'Case subject: "' + subject + '".' + (descr ? ' Details: ' + descr : '');
    var triage = null;
    var ai = await crm.ai.complete({ prompt: brief + ' Output: two classification lines, then the reply body.', max_tokens: 450 });
    if (ai && ai.ok && ai.text) triage = ai.text;
    var sameDay = priority === 'urgent' || priority === 'critical' || priority === 'high';
    var due = new Date(Date.now() + (sameDay ? 0 : 86400000)).toISOString().slice(0, 10);
    await crm.createTask({
      title: 'Triage & reply: ' + subject,
      description: 'Case priority: ' + priority + '\\n' +
        (triage
          ? 'AI triage + suggested reply (review before sending — nothing was sent to the customer):\\n' + triage
          : 'Copilot brief (paste into chat to classify and draft the reply): ' + brief),
      due_date: due,
      priority: sameDay ? 'urgent' : 'high',
      contact_id: (full && full.contact_id) || null,
    });
    crm.log('AI triage task created for case: ' + subject + '. AI output: ' + (triage ? 'yes' : 'no'));
    return { task_created: true, ai_drafted: !!triage };
  },
};`,
    },
  },
  {
    slug: 'case-sla-escalation',
    name: 'Case SLA escalation',
    category: 'cx',
    icon: '📛',
    summary:
      'An SLA that breaches silently isn\'t an SLA, it\'s a suggestion. Every hour this checks open cases against their SLA due time; breached cases get their priority bumped one level (up to eight per pass — already-urgent cases can\'t climb further, so it converges instead of churning), and one escalation task lists everything currently past due for a manager to work. Workspaces without the cases module see it quietly do nothing.',
    tags: ['cases', 'sla', 'escalation'],
    spec: {
      name: 'case-sla-escalation',
      summary: 'Hourly: open cases past sla_due_at get a one-level priority bump (max 8/pass) plus one manager escalation task.',
      triggerEvent: 'schedule.hourly',
      triggerFilter: null,
      actions: [
        { kind: 'set_field', entity: 'case', field: 'priority', value: 'escalated_one_level' },
        { kind: 'create_task', title_template: 'SLA breaches: {count} case(s) past due', due_in_days: 0 },
      ],
      source_code: `// Escalate open cases that have breached their SLA due time.
module.exports = {
  async run({ crm }) {
    // Returns [] when the cases module is disabled for this workspace.
    var cases = await crm.listCases({ status: 'open' });
    var now = Date.now();
    var breached = cases.filter(function (c) {
      return String(c.status || '') === 'open' && c.sla_due_at && new Date(c.sla_due_at).getTime() < now;
    });
    if (breached.length === 0) {
      crm.log('No open cases past their SLA due time (or the cases module is disabled).');
      return { breached: 0 };
    }
    var ladder = { low: 'medium', medium: 'high', high: 'urgent' };
    var bumped = 0;
    for (var i = 0; i < breached.length && bumped < 8; i++) {
      var c = breached[i];
      var next = ladder[String(c.priority || 'medium').toLowerCase()];
      if (!next) continue; // already urgent — nowhere to climb, don't churn
      await crm.updateCase(c.id, { priority: next });
      bumped++;
    }
    var lines = breached.slice(0, 10).map(function (c) {
      var hrs = Math.floor((now - new Date(c.sla_due_at).getTime()) / 3600000);
      return '- #' + c.id + ' "' + (c.subject || '') + '" [' + (c.priority || 'medium') + '] — ' + hrs + 'h past SLA';
    });
    if (bumped > 0) {
      var today = new Date().toISOString().slice(0, 10);
      await crm.createTask({
        title: 'SLA breaches: ' + breached.length + ' case(s) past due',
        description: 'These open cases are past their SLA due time (priorities bumped one level on ' + bumped + ' of them):\\n' +
          lines.join('\\n') +
          (breached.length > 10 ? '\\n...and ' + (breached.length - 10) + ' more.' : '') +
          '\\nGet a human response onto each one today and reset expectations with the customer honestly.',
        due_date: today,
        priority: 'urgent',
      });
    }
    crm.log('SLA-breached cases: ' + breached.length + '; priorities bumped: ' + bumped + '.');
    return { breached: breached.length, bumped: bumped };
  },
};`,
    },
  },
  {
    slug: 'renewal-pipeline-digest',
    name: 'Renewal pipeline digest',
    category: 'cx',
    icon: '📆',
    summary:
      'Renewals are a pipeline too — they just don\'t get pipeline reviews unless someone builds one. Every Monday this rolls your service contracts up by renewal stage, lists everything ending within 90 days with its value, and calls out the at-risk ones — a single weekly digest that makes the renewal book as visible as the new-business board. Needs the customer-success module; without it, it quietly does nothing.',
    tags: ['renewals', 'contracts', 'digest'],
    spec: {
      name: 'renewal-pipeline-digest',
      summary: 'Weekly (Monday) digest task of service contracts by renewal stage, with 90-day expirations and at-risk contracts called out.',
      triggerEvent: 'schedule.daily',
      triggerFilter: { cron: '0 8 * * 1' },
      actions: [
        { kind: 'create_task', title_template: 'Renewal pipeline — {today}', due_in_days: 0 },
      ],
      source_code: `// Weekly renewal-book digest from service contracts.
module.exports = {
  async run({ crm, input }) {
    var t = (input && input.trigger) || input || {};
    var ref = t.date ? new Date(String(t.date)) : new Date();
    if (ref.getUTCDay() !== 1) {
      crm.log('Not Monday — the weekly renewal digest runs Mondays.');
      return { skipped: true, reason: 'not_monday' };
    }
    // Returns [] when the customer-success module is disabled.
    var contracts = await crm.listServiceContracts({});
    if (contracts.length === 0) {
      crm.log('No service contracts (or the customer-success module is disabled).');
      return { contracts: 0 };
    }
    var byStage = {};
    var endingSoon = [];
    var atRisk = [];
    var now = Date.now();
    var horizon = now + 90 * 86400000;
    for (var i = 0; i < contracts.length; i++) {
      var c = contracts[i];
      var stage = c.renewal_stage || '(no stage)';
      byStage[stage] = (byStage[stage] || 0) + 1;
      if (String(c.renewal_stage || '').toLowerCase() === 'at_risk') atRisk.push(c);
      if (c.end_date) {
        var e = new Date(c.end_date).getTime();
        if (e >= now && e <= horizon) endingSoon.push(c);
      }
    }
    function money(c) {
      var v = c.annual_value != null ? c.annual_value : (c.monthly_amount != null ? Number(c.monthly_amount) * 12 : null);
      return v == null ? '?' : Math.round(Number(v) || 0);
    }
    var stageLines = Object.keys(byStage).map(function (s) { return '- ' + s + ': ' + byStage[s]; });
    endingSoon.sort(function (a, b) { return new Date(a.end_date).getTime() - new Date(b.end_date).getTime(); });
    var soonLines = endingSoon.slice(0, 10).map(function (c) {
      return '- "' + (c.name || ('#' + c.id)) + '" ends ' + String(c.end_date).slice(0, 10) + ' ($' + money(c) + '/yr)';
    });
    var riskLines = atRisk.slice(0, 8).map(function (c) {
      return '- "' + (c.name || ('#' + c.id)) + '" ($' + money(c) + '/yr)' + (c.churn_reason ? ' — ' + c.churn_reason : '');
    });
    var today = new Date().toISOString().slice(0, 10);
    await crm.createTask({
      title: 'Renewal pipeline — ' + today + ' (' + contracts.length + ' contracts, ' + atRisk.length + ' at risk)',
      description: 'Contracts by renewal stage:\\n' + stageLines.join('\\n') + '\\n' +
        'Ending within 90 days (' + endingSoon.length + '):\\n' + (soonLines.join('\\n') || '- none') + '\\n' +
        'At risk (' + atRisk.length + '):\\n' + (riskLines.join('\\n') || '- none') + '\\n' +
        'Treat the at-risk list as this week\\'s calls, not this quarter\\'s.',
      due_date: today,
      priority: atRisk.length > 0 ? 'high' : 'medium',
    });
    crm.log('Renewal digest: ' + contracts.length + ' contracts, ' + endingSoon.length + ' ending in 90d, ' + atRisk.length + ' at risk.');
    return { contracts: contracts.length, ending_90d: endingSoon.length, at_risk: atRisk.length };
  },
};`,
    },
  },
  {
    slug: 'churn-risk-agent',
    name: 'Churn-risk agent',
    category: 'cx',
    icon: '🚩',
    summary:
      'Churn has two tells the CRM can already see: contracts marked at-risk, and accounts whose deal activity stopped weeks ago. Every day this combines both into a red/yellow board — red for at-risk contracts and 60-plus-day silences, yellow for accounts drifting past 30 days — and files one review task. With AI enabled, a save-play for the most exposed red account is drafted right into the task (metered per-org); without it, the task carries the copilot brief.',
    tags: ['churn', 'retention', 'ai'],
    spec: {
      name: 'churn-risk-agent',
      summary: 'Daily red/yellow churn board from at-risk contracts + account silence, with an AI save-play for the top red account.',
      triggerEvent: 'schedule.daily',
      triggerFilter: { cron: '0 9 * * 1-5' },
      actions: [
        { kind: 'create_task', title_template: 'Churn risk board — {counts}', due_in_days: 0 },
        {
          kind: 'claude_complete',
          prompt_template:
            'Draft a three-step save-play for {account}: the opening message, the internal fix to offer, and the executive touch. Under 120 words.',
          store_as: 'save_play',
        },
      ],
      source_code: `// Daily red/yellow churn-risk board with an AI save-play for the top risk.
// ── CONFIG ─────────────────────────────────────────────────────────────────
var RED_QUIET_DAYS = 60;    // account silence that lands on the red list
var YELLOW_QUIET_DAYS = 30; // account silence that lands on the yellow list
// ───────────────────────────────────────────────────────────────────────────
module.exports = {
  async run({ crm }) {
    // Both reads degrade to [] when their modules are disabled.
    var atRisk = (await crm.listServiceContracts({ renewal_stage: 'at_risk' })).filter(function (c) {
      return String(c.renewal_stage || '').toLowerCase() === 'at_risk';
    });
    var deals = await crm.listDeals({ status: 'open' });
    var companies = await crm.listCompanies({});
    var nameById = {};
    for (var i = 0; i < companies.length; i++) nameById[companies[i].id] = companies[i].name;
    var lastByCompany = {};
    var amountByCompany = {};
    for (var j = 0; j < deals.length; j++) {
      var d = deals[j];
      if (!d.company_id) continue;
      var t = new Date(d.last_activity_at || d.updated_at || d.created_at || 0).getTime();
      if (!lastByCompany[d.company_id] || t > lastByCompany[d.company_id]) lastByCompany[d.company_id] = t;
      amountByCompany[d.company_id] = (amountByCompany[d.company_id] || 0) + (Number(d.amount) || 0);
    }
    var now = Date.now();
    var red = [];
    var yellow = [];
    Object.keys(lastByCompany).forEach(function (id) {
      var days = Math.floor((now - lastByCompany[id]) / 86400000);
      var row = { name: nameById[id] || ('company #' + id), days: days, amount: amountByCompany[id] || 0 };
      if (days >= RED_QUIET_DAYS) red.push(row);
      else if (days >= YELLOW_QUIET_DAYS) yellow.push(row);
    });
    red.sort(function (a, b) { return b.amount - a.amount; });
    yellow.sort(function (a, b) { return b.amount - a.amount; });
    if (atRisk.length === 0 && red.length === 0 && yellow.length === 0) {
      crm.log('No at-risk contracts and no quiet accounts. The book looks healthy today.');
      return { red: 0, yellow: 0, at_risk_contracts: 0 };
    }
    var redLines = atRisk.slice(0, 6).map(function (c) {
      return '- RED (contract at risk): "' + (c.name || ('#' + c.id)) + '"' + (c.churn_reason ? ' — ' + c.churn_reason : '');
    }).concat(red.slice(0, 6).map(function (r) {
      return '- RED (silent ' + r.days + 'd): ' + r.name + ' ($' + Math.round(r.amount) + ' open)';
    }));
    var yellowLines = yellow.slice(0, 8).map(function (r) {
      return '- YELLOW (silent ' + r.days + 'd): ' + r.name + ' ($' + Math.round(r.amount) + ' open)';
    });
    // One metered AI call: a save-play for the most exposed red entry.
    var top = atRisk.length > 0 ? (atRisk[0].name || ('contract #' + atRisk[0].id)) : (red.length > 0 ? red[0].name : null);
    var savePlay = null;
    var brief = top
      ? 'Draft a three-step save-play for the account "' + top + '" showing churn-risk signals: the opening message to send, the internal fix to offer, and the executive touch. Under 120 words.'
      : null;
    if (brief) {
      var ai = await crm.ai.complete({ prompt: brief + ' No preamble.', max_tokens: 300 });
      if (ai && ai.ok && ai.text) savePlay = ai.text;
    }
    var today = new Date().toISOString().slice(0, 10);
    await crm.createTask({
      title: 'Churn risk board — ' + (atRisk.length + red.length) + ' red, ' + yellow.length + ' yellow',
      description: 'Red — act this week:\\n' + (redLines.join('\\n') || '- none') + '\\n' +
        'Yellow — schedule a touch:\\n' + (yellowLines.join('\\n') || '- none') + '\\n' +
        (savePlay
          ? 'AI save-play for ' + top + ' (review before using):\\n' + savePlay
          : (brief ? 'Copilot brief (paste into chat for a save-play): ' + brief : '')),
      due_date: today,
      priority: (atRisk.length + red.length) > 0 ? 'high' : 'medium',
    });
    crm.log('Churn board: ' + (atRisk.length + red.length) + ' red (' + atRisk.length + ' contracts), ' + yellow.length + ' yellow. AI save-play: ' + (savePlay ? 'yes' : 'no'));
    return { red: atRisk.length + red.length, yellow: yellow.length, ai_drafted: !!savePlay };
  },
};`,
    },
  },
  {
    slug: 'expansion-signal-agent',
    name: 'Expansion-signal agent',
    category: 'cx',
    icon: '🌱',
    summary:
      'Your cheapest pipeline is the customer who already said yes once and currently has nothing open. Every day this finds companies with closed-won history and zero open deals, ranks them by what they\'ve bought, and files one expansion review task. With AI enabled, an upsell outreach draft for the biggest such account lands right in the task (metered per-org); without it, the task carries the copilot brief to draft it in chat.',
    tags: ['expansion', 'upsell', 'ai'],
    spec: {
      name: 'expansion-signal-agent',
      summary: 'Daily digest of won-history companies with no open pipeline, with an AI outreach draft for the largest.',
      triggerEvent: 'schedule.daily',
      triggerFilter: { cron: '0 9 * * 2' },
      actions: [
        { kind: 'create_task', title_template: 'Expansion candidates ({count})', due_in_days: 2 },
        {
          kind: 'claude_complete',
          prompt_template:
            'Draft a short expansion outreach email to {company}, a customer with ${won} in won business and no open deals. Reference the relationship, propose a check-in about what has changed. Under 100 words.',
          store_as: 'outreach',
        },
      ],
      source_code: `// Surface won-history accounts with no open pipeline as expansion plays.
module.exports = {
  async run({ crm }) {
    // One read covers both sides: split won history from open pipeline by the
    // fields on the rows themselves.
    var deals = await crm.listDeals({});
    var won = deals.filter(function (d) { return String(d.stage || '').toUpperCase() === 'CLOSED_WON'; });
    if (won.length === 0) {
      crm.log('No closed-won history yet — no expansion base to scan.');
      return { candidates: 0 };
    }
    var hasOpen = {};
    for (var i = 0; i < deals.length; i++) {
      if (deals[i].company_id && String(deals[i].status || '') === 'open') hasOpen[deals[i].company_id] = true;
    }
    var wonByCompany = {};
    for (var j = 0; j < won.length; j++) {
      var d = won[j];
      if (!d.company_id || hasOpen[d.company_id]) continue;
      var r = wonByCompany[d.company_id] || (wonByCompany[d.company_id] = { amount: 0, count: 0 });
      r.amount += Number(d.amount) || 0;
      r.count++;
    }
    var ids = Object.keys(wonByCompany);
    if (ids.length === 0) {
      crm.log('Every won-history account already has open pipeline. Nothing to expand today.');
      return { candidates: 0 };
    }
    var companies = await crm.listCompanies({});
    var nameById = {};
    for (var k = 0; k < companies.length; k++) nameById[companies[k].id] = companies[k].name;
    ids.sort(function (a, b) { return wonByCompany[b].amount - wonByCompany[a].amount; });
    var lines = ids.slice(0, 5).map(function (id) {
      var r = wonByCompany[id];
      return '- ' + (nameById[id] || ('company #' + id)) + ': $' + Math.round(r.amount) + ' won across ' + r.count + ' deal(s), no open pipeline';
    });
    // One metered AI call: outreach draft for the biggest candidate.
    var topId = ids[0];
    var topName = nameById[topId] || ('company #' + topId);
    var brief = 'Draft a short expansion outreach email to ' + topName + ', an existing customer with $' +
      Math.round(wonByCompany[topId].amount) + ' in won business and no open deals with us right now. ' +
      'Reference the relationship warmly and propose a check-in about what has changed since. Under 100 words.';
    var draft = null;
    var ai = await crm.ai.complete({ prompt: brief + ' Output the email body only.', max_tokens: 250 });
    if (ai && ai.ok && ai.text) draft = ai.text;
    var due = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
    await crm.createTask({
      title: 'Expansion candidates (' + ids.length + '): won history, no open pipeline',
      description: 'These customers have bought before and have nothing open now:\\n' + lines.join('\\n') +
        (ids.length > 5 ? '\\n...and ' + (ids.length - 5) + ' more.' : '') + '\\n' +
        (draft
          ? 'AI outreach draft for ' + topName + ' (review before sending):\\n' + draft
          : 'Copilot brief (paste into chat to draft the outreach): ' + brief),
      due_date: due,
      priority: 'medium',
    });
    crm.log('Expansion candidates: ' + ids.length + '. AI outreach draft: ' + (draft ? 'yes' : 'no'));
    return { candidates: ids.length, ai_drafted: !!draft };
  },
};`,
    },
  },
  {
    slug: 'relationship-anniversary-touch',
    name: 'Relationship anniversary touch',
    category: 'cx',
    icon: '🎂',
    summary:
      'Zoho made birthday emails a signature feature for a reason: dated personal touches are cheap and remembered. The CRM doesn\'t store birthdays, so this uses the date it CAN see — the anniversary of each contact joining your book. Every day it finds contacts whose add-date anniversary is today or tomorrow (at least ten months in) and files a touch task per contact (up to four). With AI enabled, the first one gets a warm note drafted right in (metered per-org); the rest carry a ready-to-run copilot brief.',
    tags: ['relationship', 'anniversary', 'ai'],
    spec: {
      name: 'relationship-anniversary-touch',
      summary: 'Daily: contacts whose add-date anniversary is today/tomorrow each get a touch task (max 4); AI drafts the first note.',
      triggerEvent: 'schedule.daily',
      triggerFilter: { cron: '0 8 * * *' },
      actions: [
        { kind: 'create_task', title_template: 'Anniversary touch: {contact.name}', due_in_days: 1 },
        {
          kind: 'claude_complete',
          prompt_template:
            'Write a warm two-sentence anniversary note to {contact.name} marking {years} year(s) since we started working together. No sales pitch. Output the note only.',
          store_as: 'note',
        },
      ],
      source_code: `// Touch tasks on the anniversary of each contact joining the book.
module.exports = {
  async run({ crm, input }) {
    var t = (input && input.trigger) || input || {};
    var ref = t.date ? new Date(String(t.date)) : new Date();
    var contacts = await crm.listContacts({});
    var todayMd = ref.toISOString().slice(5, 10);
    var tomorrowMd = new Date(ref.getTime() + 86400000).toISOString().slice(5, 10);
    var now = ref.getTime();
    var hits = contacts.filter(function (c) {
      if (!c.created_at) return false;
      var iso = new Date(c.created_at).toISOString();
      var md = iso.slice(5, 10);
      if (md !== todayMd && md !== tomorrowMd) return false;
      // At least ~10 months old, so brand-new contacts don't get an
      // "anniversary" the day after they were added.
      return (now - new Date(c.created_at).getTime()) > 300 * 86400000;
    });
    if (hits.length === 0) {
      crm.log('No contact anniversaries today or tomorrow.');
      return { anniversaries: 0 };
    }
    var due = new Date(now + 86400000).toISOString().slice(0, 10);
    var created = 0;
    var drafted = 0;
    for (var i = 0; i < hits.length && created < 4; i++) {
      var c = hits[i];
      var name = [c.first_name, c.last_name].filter(Boolean).join(' ') || ('contact #' + c.id);
      var years = Math.max(1, Math.round((now - new Date(c.created_at).getTime()) / (365 * 86400000)));
      var brief = 'Write a warm two-sentence anniversary note to ' + name + ' marking ' + years +
        ' year(s) since we started working together. No sales pitch.';
      var note = null;
      if (drafted === 0) {
        // One metered AI call per run, spent on the first anniversary.
        var ai = await crm.ai.complete({ prompt: brief + ' Output the note only.', max_tokens: 150 });
        if (ai && ai.ok && ai.text) { note = ai.text; drafted++; }
      }
      await crm.createTask({
        title: 'Anniversary touch: ' + name + ' (' + years + ' year' + (years === 1 ? '' : 's') + ')',
        description: 'It is ' + years + ' year(s) since ' + name + ' joined your book' +
          (c.email ? ' (' + c.email + ')' : '') + '. A short personal note lands better than any campaign.\\n' +
          (note
            ? 'AI note (review before sending):\\n' + note
            : 'Copilot brief (paste into chat to draft it): ' + brief),
        due_date: due,
        priority: 'low',
        contact_id: c.id,
      });
      created++;
    }
    crm.log('Contact anniversaries: ' + hits.length + '; touch tasks created: ' + created + '; AI notes: ' + drafted);
    return { anniversaries: hits.length, tasks_created: created, ai_drafted: drafted };
  },
};`,
    },
  },
];
