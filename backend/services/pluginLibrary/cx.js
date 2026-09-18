// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Curated library — CUSTOMER EXPERIENCE / RETENTION entries. See ./index.js
// for the authoring contract.
//
// Notes on honesty:
//   • Cases are not readable through the plugin SDK, so the case entries work
//     entirely from the case.created trigger payload and encode SLAs as task
//     due dates (the overdue-task machinery then covers breach escalation).
//   • AI entries never call AI from the sandbox (there is no network and no
//     AI SDK surface). Instead they assemble a ready-to-run copilot brief into
//     the created task, so they are fully useful without AI and one-click
//     drafts with it. The declarative claude_complete actions describe the
//     AI half for surfaces that execute specs.

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
      'A personal thank-you inside 48 hours of signing is the cheapest retention tool that exists — and the easiest to forget. When a deal closes won, this creates a high-priority task with the customer\'s details and a ready-to-run copilot brief for a warm, specific thank-you note. Works without AI (the task carries the talking points); with AI enabled, the copilot drafts it in one click.',
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
    await crm.createTask({
      title: 'Send thank-you note: ' + title,
      description: 'A personal thank-you within 48 hours of signing sets the tone for the whole relationship.\\n' +
        (contact && contact.email ? 'Send to: ' + contact.email + '\\n' : '') +
        'Talking points: thank them for their trust, name one specific thing you are excited to deliver, and say who their point of contact is.\\n' +
        'Copilot brief (paste into chat to draft it): ' + brief,
      due_date: due,
      priority: 'high',
      deal_id: deal ? deal.id : null,
      contact_id: contact ? contact.id : null,
    });
    crm.log('Thank-you task created for ' + title);
    return { task_created: true };
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
      'Accounts rarely announce they\'re drifting — they just go quiet. This daily sweep finds companies whose open deals have had no activity in 45+ days and creates a re-engagement task per account (up to six a day), each carrying a copilot brief for a light, non-pushy check-in email. Useful without AI; one-click drafts with it.',
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
    for (var j = 0; j < quietIds.length && created < 6; j++) {
      var companyId = Number(quietIds[j]);
      var company = await crm.getCompany(companyId);
      if (!company) continue;
      var days = Math.floor((Date.now() - lastByCompany[quietIds[j]]) / 86400000);
      var brief = 'Draft a light, friendly re-engagement email to ' + company.name +
        '. We have not spoken in ' + days + ' days. Check in on their priorities — no hard sell. Under 100 words.';
      await crm.createTask({
        title: 'Re-engage ' + company.name + ' (' + days + ' days quiet)',
        description: 'No deal activity with this account in ' + days + ' days.\\n' +
          'Reach out with something useful — a relevant idea, a check-in on their priorities, or a quick win from a similar customer.\\n' +
          'Copilot brief (paste into chat to draft it): ' + brief,
        due_date: due,
        priority: 'medium',
      });
      created++;
    }
    crm.log('Quiet accounts: ' + quietIds.length + '; re-engagement tasks created: ' + created);
    return { quiet_accounts: quietIds.length, tasks_created: created };
  },
};`,
    },
  },
];
