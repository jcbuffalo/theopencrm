// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Curated library — SALES entries. See ./index.js for the authoring contract.
//
// Every NEW entry ships runnable `source_code` (module.exports = { run })
// that uses ONLY the allowlisted crm.* SDK surface and respects the run
// budgets (50 queries, 10 createTask, 5s wall clock). Writes execute in the
// platform's confirm-first preview mode — the customer Applies them.

module.exports = [
  // --------------------------------------------------------------------------
  // EXISTING ENTRIES — do not modify (moved verbatim from pluginLibrary.js).
  // --------------------------------------------------------------------------
  {
    slug: 'follow-up-on-quote-sent',
    name: 'Follow up 7 days after quote sent',
    category: 'sales',
    icon: '📧',
    summary:
      'When a customer quote is sent, schedule a follow-up task in 7 days. If the deal still has no PO by then, generate a polite follow-up email draft for the salesperson to review.',
    tags: ['follow-up', 'quotes', 'tasks'],
    spec: {
      name: 'follow-up-on-quote-sent',
      summary: 'Schedule a 7-day follow-up task when a customer quote is sent. Generate a draft email at trigger time.',
      triggerEvent: 'quote.sent',
      triggerFilter: null,
      actions: [
        {
          kind: 'create_task',
          title_template: 'Follow up on quote {quote.public_id} — {customer.name}',
          due_in_days: 7,
        },
        {
          kind: 'claude_complete',
          prompt_template:
            'Draft a brief, professional follow-up email to {customer.name} about quote {quote.public_id} sent 7 days ago. Keep it under 120 words. Output the email body only.',
          store_as: 'draft',
        },
      ],
    },
  },
  {
    slug: 'mark-hot-large-deal',
    name: 'Auto-mark large deals as hot',
    category: 'sales',
    icon: '🔥',
    summary:
      'When a deal\'s amount crosses $50,000 and it is still in a pre-sale stage, mark hot_flag = true so it shows up in the priority filter.',
    tags: ['filtering', 'priority'],
    spec: {
      name: 'mark-hot-large-deal',
      summary: 'Mark deals over $50K as hot when in pre-sale stages.',
      triggerEvent: 'deal.created',
      triggerFilter: { amount_gte: 50000, phase: 'pre_sale' },
      actions: [
        {
          kind: 'set_field',
          entity: 'deal',
          field: 'hot_flag',
          value: true,
        },
      ],
    },
  },

  // --------------------------------------------------------------------------
  // NEW ENTRIES
  // --------------------------------------------------------------------------
  {
    slug: 'stale-negotiation-nudge',
    name: 'Nudge stalled late-stage deals',
    category: 'sales',
    icon: '⏳',
    summary:
      'Deals that reach proposal or negotiation and then go quiet are the ones you lose by accident. Every day this checks your late-stage pipeline for deals with no activity in 10+ days and creates a nudge task on each one — hot deals get flagged urgent — so re-engaging the buyer becomes an explicit to-do instead of a memory test.',
    tags: ['follow-up', 'pipeline', 'staleness'],
    spec: {
      name: 'stale-negotiation-nudge',
      summary: 'Daily check for late-stage deals with 10+ days of silence; creates a re-engagement task per stalled deal (max 8/day).',
      triggerEvent: 'schedule.daily',
      triggerFilter: { stale_days: 10, stages: ['PROPOSAL', 'NEGOTIATION', 'PITCH', 'ENGAGED'] },
      actions: [
        { kind: 'create_task', title_template: 'Nudge stalled deal: {deal.title}', due_in_days: 1 },
      ],
      source_code: `// Nudge late-stage deals that have gone quiet.
module.exports = {
  async run({ crm, input }) {
    var staleDays = (input && Number(input.stale_days)) || 10;
    var stages = ['PROPOSAL', 'NEGOTIATION', 'PITCH', 'ENGAGED'];
    var cutoff = Date.now() - staleDays * 86400000;
    var deals = await crm.listDeals({ status: 'open' });
    var stale = deals.filter(function (d) {
      if (stages.indexOf(String(d.stage || '').toUpperCase()) === -1) return false;
      var last = d.last_activity_at || d.updated_at || d.created_at;
      return !last || new Date(last).getTime() < cutoff;
    });
    var due = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    var created = 0;
    for (var i = 0; i < stale.length && created < 8; i++) {
      var d = stale[i];
      await crm.createTask({
        title: 'Nudge stalled deal: ' + (d.title || ('#' + d.id)),
        description: 'No recorded activity in ' + staleDays + '+ days while in ' + d.stage +
          '. Re-engage the buyer: confirm the decision timeline, restate the value, and get the next meeting on the calendar.',
        due_date: due,
        priority: d.hot_flag ? 'urgent' : 'high',
        deal_id: d.id,
        contact_id: d.contact_id || null,
      });
      created++;
    }
    crm.log('Stalled late-stage deals: ' + stale.length + '; nudge tasks created: ' + created);
    return { stalled: stale.length, tasks_created: created };
  },
};`,
    },
  },
  {
    slug: 'win-loss-note-prompt',
    name: 'Win/loss debrief prompt on close',
    category: 'sales',
    icon: '📝',
    summary:
      'The best forecasting input you have is an honest note written the day a deal closes. Whenever a deal moves to closed-won or closed-lost, this creates a short debrief task — what won or lost it, who really decided, which alternative was in play — due within two days, while the details are still fresh.',
    tags: ['win-loss', 'process', 'coaching'],
    spec: {
      name: 'win-loss-note-prompt',
      summary: 'On close (won or lost), create a 2-day debrief task with four structured win/loss questions.',
      triggerEvent: 'deal.stage_changed',
      triggerFilter: { stages: ['CLOSED_WON', 'CLOSED_LOST'] },
      actions: [
        { kind: 'create_task', title_template: 'Log win/loss notes: {deal.title}', due_in_days: 2 },
      ],
      source_code: `// Prompt for a structured win/loss debrief when a deal closes.
module.exports = {
  async run({ crm, input }) {
    var rec = (input && (input.deal || input.record)) || input || {};
    var stage = String((input && (input.newStage || input.new_stage)) || rec.stage || '').toUpperCase();
    if (stage !== 'CLOSED_WON' && stage !== 'CLOSED_LOST') {
      return { skipped: true, reason: 'not_a_close_transition' };
    }
    var dealId = Number(rec.id || (input && (input.dealId || input.deal_id)));
    var deal = (Number.isInteger(dealId) && dealId > 0) ? await crm.getDeal(dealId) : null;
    var title = (deal && deal.title) || rec.title || ('deal #' + (dealId || '?'));
    var won = stage === 'CLOSED_WON';
    var due = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
    await crm.createTask({
      title: (won ? 'Log win notes: ' : 'Log loss notes: ') + title,
      description: 'Capture the debrief while it is fresh.\\n' +
        '1. What actually ' + (won ? 'won' : 'lost') + ' this deal?\\n' +
        '2. Who was the real decision-maker?\\n' +
        '3. Which competitor or alternative was in play?\\n' +
        '4. What should we repeat (or avoid) next time?\\n' +
        'Add the answers to the deal notes so future pipeline reviews can learn from them.',
      due_date: due,
      priority: 'medium',
      deal_id: deal ? deal.id : null,
    });
    crm.log('Win/loss debrief task created for ' + title);
    return { task_created: true, won: won };
  },
};`,
    },
  },
  {
    slug: 'big-deal-alert',
    name: 'Big-deal hot flag + owner task',
    category: 'sales',
    icon: '💰',
    summary:
      'When a deal worth $25,000 or more lands in the pipeline, this flags it hot and creates an urgent review task due the next day — pick the exec sponsor, sanity-check the amount and close date, and decide the pursuit plan. Big deals get big-deal treatment from day one, automatically.',
    tags: ['priority', 'alerts', 'new-deals'],
    spec: {
      name: 'big-deal-alert',
      summary: 'On deal creation at $25K+, set hot_flag and create an urgent next-day review task.',
      triggerEvent: 'deal.created',
      triggerFilter: { amount_gte: 25000 },
      actions: [
        { kind: 'set_field', entity: 'deal', field: 'hot_flag', value: true },
        { kind: 'create_task', title_template: 'Big deal landed: {deal.title}', due_in_days: 1 },
      ],
      source_code: `// Flag big new deals hot and create an urgent review task.
module.exports = {
  async run({ crm, input }) {
    var rec = (input && (input.deal || input.record)) || input || {};
    var threshold = (input && Number(input.amount_gte)) || 25000;
    var dealId = Number(rec.id || (input && (input.dealId || input.deal_id)));
    if (!Number.isInteger(dealId) || dealId <= 0) return { skipped: true, reason: 'no_deal_id' };
    var deal = await crm.getDeal(dealId);
    if (!deal) return { skipped: true, reason: 'deal_not_found' };
    var amount = Number(deal.amount) || 0;
    if (amount < threshold) return { skipped: true, reason: 'below_threshold', amount: amount };
    if (!deal.hot_flag) {
      await crm.updateDeal(deal.id, { hot_flag: true });
    }
    var due = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    await crm.createTask({
      title: 'Big deal landed: ' + (deal.title || ('#' + deal.id)) + ' ($' + Math.round(amount) + ')',
      description: 'This deal cleared the $' + threshold + ' big-deal bar.\\n' +
        '- Assign an executive sponsor.\\n' +
        '- Sanity-check the amount, stage, and expected close date.\\n' +
        '- Agree the pursuit plan and next customer touch.',
      due_date: due,
      priority: 'urgent',
      deal_id: deal.id,
      contact_id: deal.contact_id || null,
    });
    crm.log('Big-deal alert for deal ' + deal.id + ' ($' + amount + ')');
    return { flagged: true, amount: amount };
  },
};`,
    },
  },
  {
    slug: 'duplicate-deal-detector',
    name: 'Duplicate-deal detector',
    category: 'sales',
    icon: '👯',
    summary:
      'Two reps working the same opportunity under different deal cards is how forecasts double-count and customers get contradictory quotes. This daily sweep normalizes open-deal titles, matches them within the same company, and files one digest task listing every suspected duplicate pair so you can merge or close them out.',
    tags: ['hygiene', 'pipeline', 'digest'],
    spec: {
      name: 'duplicate-deal-detector',
      summary: 'Daily sweep of open deals for same-title-same-company pairs; files one digest task of suspected duplicates.',
      triggerEvent: 'schedule.daily',
      triggerFilter: { cron: '0 8 * * 1-5' },
      actions: [
        { kind: 'create_task', title_template: 'Review suspected duplicate deals ({count})', due_in_days: 0 },
      ],
      source_code: `// Detect open deals that look like duplicates of each other.
module.exports = {
  async run({ crm }) {
    var deals = await crm.listDeals({ status: 'open' });
    var seen = {};
    var pairs = [];
    for (var i = 0; i < deals.length; i++) {
      var d = deals[i];
      var norm = String(d.title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      if (!norm) continue;
      var key = norm + '|' + (d.company_id || d.contact_id || '');
      if (seen[key]) {
        pairs.push({ a: seen[key], b: d });
      } else {
        seen[key] = d;
      }
    }
    if (pairs.length === 0) {
      crm.log('No suspected duplicate deals among ' + deals.length + ' open deals.');
      return { duplicates: 0 };
    }
    var lines = pairs.slice(0, 10).map(function (p) {
      return '- #' + p.a.id + ' and #' + p.b.id + ': "' + (p.a.title || '') + '"';
    });
    var today = new Date().toISOString().slice(0, 10);
    await crm.createTask({
      title: 'Review suspected duplicate deals (' + pairs.length + ' pair' + (pairs.length === 1 ? '' : 's') + ')',
      description: 'These open deals share a normalized title within the same company and may be duplicates:\\n' +
        lines.join('\\n') +
        (pairs.length > 10 ? '\\n...and ' + (pairs.length - 10) + ' more pair(s).' : '') +
        '\\nMerge or close the extras so the forecast counts each opportunity once.',
      due_date: today,
      priority: 'medium',
    });
    crm.log('Suspected duplicate pairs: ' + pairs.length);
    return { duplicates: pairs.length };
  },
};`,
    },
  },
  {
    slug: 'next-step-enforcer',
    name: 'Every open deal has a next step',
    category: 'sales',
    icon: '👉',
    summary:
      'The single best pipeline-hygiene rule: no open deal without an open task. Each day this cross-references your open deals against open tasks and creates a "set a next step" to-do on every deal that has none — hot deals first — so nothing sits in the pipeline with no plan attached.',
    tags: ['process', 'pipeline', 'tasks'],
    spec: {
      name: 'next-step-enforcer',
      summary: 'Daily: find open deals with no open task and create a next-step to-do on each (max 8/day).',
      triggerEvent: 'schedule.daily',
      triggerFilter: { cron: '0 8 * * 1-5' },
      actions: [
        { kind: 'create_task', title_template: 'Set a next step for: {deal.title}', due_in_days: 1 },
      ],
      source_code: `// Ensure every open deal carries an open next-step task.
module.exports = {
  async run({ crm }) {
    var deals = await crm.listDeals({ status: 'open' });
    var tasks = await crm.listTasks({ status: 'open' });
    var hasTask = {};
    for (var i = 0; i < tasks.length; i++) {
      if (tasks[i].deal_id) hasTask[tasks[i].deal_id] = true;
    }
    var missing = deals.filter(function (d) { return !hasTask[d.id]; });
    // Hot deals first so the cap spends itself on what matters.
    missing.sort(function (a, b) { return (b.hot_flag ? 1 : 0) - (a.hot_flag ? 1 : 0); });
    var due = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    var created = 0;
    for (var j = 0; j < missing.length && created < 8; j++) {
      var d = missing[j];
      await crm.createTask({
        title: 'Set a next step for: ' + (d.title || ('#' + d.id)),
        description: 'This open deal has no open task. Decide the next concrete step (call, meeting, proposal revision) and log it — a deal without a next step is a deal drifting toward closed-lost.',
        due_date: due,
        priority: d.hot_flag ? 'high' : 'medium',
        deal_id: d.id,
        contact_id: d.contact_id || null,
      });
      created++;
    }
    crm.log('Open deals with no next step: ' + missing.length + '; tasks created: ' + created);
    return { deals_without_next_step: missing.length, tasks_created: created };
  },
};`,
    },
  },
  {
    slug: 'lead-response-sla',
    name: 'Lead response SLA (4 hours)',
    category: 'sales',
    icon: '⚡',
    summary:
      'Speed-to-lead is the highest-leverage number in inbound sales — response inside the first hours multiplies conversion. The moment a new lead arrives, this creates an urgent same-day task with the lead\'s details and a 4-hour first-contact target, so every inquiry gets a fast, accountable response.',
    tags: ['leads', 'sla', 'speed-to-lead'],
    spec: {
      name: 'lead-response-sla',
      summary: 'On lead capture, create an urgent same-day first-contact task carrying the lead details (4h SLA).',
      triggerEvent: 'lead.created',
      triggerFilter: null,
      actions: [
        { kind: 'create_task', title_template: 'Respond to new lead: {lead.name} (SLA 4h)', due_in_days: 0 },
      ],
      source_code: `// Create an urgent first-contact task the moment a lead arrives.
// Leads are not readable via the plugin SDK, so this works entirely from the
// trigger payload — every field it mentions comes from the event input.
module.exports = {
  async run({ crm, input }) {
    var lead = (input && (input.lead || input.record)) || input || {};
    var name = lead.name ||
      [lead.first_name, lead.last_name].filter(Boolean).join(' ') ||
      lead.email || 'new lead';
    var bits = [];
    if (lead.email)   bits.push('Email: ' + lead.email);
    if (lead.phone)   bits.push('Phone: ' + lead.phone);
    if (lead.company) bits.push('Company: ' + lead.company);
    if (lead.source)  bits.push('Source: ' + lead.source);
    var today = new Date().toISOString().slice(0, 10);
    await crm.createTask({
      title: 'Respond to new lead: ' + name + ' (SLA 4h)',
      description: 'Speed-to-lead wins deals — make first contact within 4 hours.\\n' +
        (bits.length ? bits.join('\\n') + '\\n' : '') +
        'Log the outcome on the lead when done.',
      due_date: today,
      priority: 'urgent',
    });
    crm.log('Lead-response SLA task created for ' + name);
    return { task_created: true, lead_name: name };
  },
};`,
    },
  },
  {
    slug: 'pipeline-coverage-check',
    name: 'Weighted pipeline coverage check',
    category: 'sales',
    icon: '⚖️',
    summary:
      'Set a weighted-pipeline target and let the CRM watch it for you. Every day this computes probability-weighted open pipeline; whenever it drops below your target it files an alert task showing the gap, total open value, and your five biggest deals — the natural place to start making up the shortfall. With no target set, it simply logs the numbers each day.',
    tags: ['forecast', 'coverage', 'alerts'],
    spec: {
      name: 'pipeline-coverage-check',
      summary: 'Daily weighted-pipeline computation; alert task when coverage falls below the configured target.',
      triggerEvent: 'schedule.daily',
      triggerFilter: { cron: '0 8 * * 1-5', target_weighted_amount: 0 },
      actions: [
        { kind: 'create_task', title_template: 'Pipeline below target: {gap} short', due_in_days: 0 },
      ],
      source_code: `// Compute probability-weighted open pipeline; alert when below target.
// Note: with no memory across runs, this checks LEVEL vs. a target rather
// than run-over-run drift. Set target_weighted_amount in the trigger config.
module.exports = {
  async run({ crm, input }) {
    var target = (input && Number(input.target_weighted_amount)) || 0;
    var deals = await crm.listDeals({ status: 'open' });
    var total = 0;
    var weighted = 0;
    for (var i = 0; i < deals.length; i++) {
      var d = deals[i];
      var amount = Number(d.amount) || 0;
      var p = d.probability == null ? 0.5 : Number(d.probability);
      if (p > 1) p = p / 100;
      if (!(p >= 0 && p <= 1)) p = 0.5;
      total += amount;
      weighted += amount * p;
    }
    weighted = Math.round(weighted);
    crm.log('Open pipeline: $' + Math.round(total) + '; weighted: $' + weighted + '; target: $' + target);
    if (!(target > 0) || weighted >= target) {
      return { open_amount: Math.round(total), weighted: weighted, target: target, below_target: false };
    }
    var top = deals.slice().sort(function (a, b) { return (Number(b.amount) || 0) - (Number(a.amount) || 0); }).slice(0, 5);
    var lines = top.map(function (d) {
      return '- ' + (d.title || ('#' + d.id)) + ' ($' + Math.round(Number(d.amount) || 0) + ', ' + d.stage + ')';
    });
    var today = new Date().toISOString().slice(0, 10);
    await crm.createTask({
      title: 'Pipeline below target: $' + (target - weighted) + ' short',
      description: 'Weighted open pipeline is $' + weighted + ' against a target of $' + target + '.\\n' +
        'Total unweighted open pipeline: $' + Math.round(total) + ' across ' + deals.length + ' deal(s).\\n' +
        'Biggest open deals to advance:\\n' + lines.join('\\n') + '\\n' +
        'Options: advance late-stage deals, revive stalled ones, or add new top-of-funnel.',
      due_date: today,
      priority: 'high',
    });
    return { open_amount: Math.round(total), weighted: weighted, target: target, below_target: true };
  },
};`,
    },
  },
];
