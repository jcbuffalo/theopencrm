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

  // --------------------------------------------------------------------------
  // WAVE 2 (2026-09) — market-gap batch. Trigger filters only MATCH events
  // (they are never passed into the run: triggered runs receive
  // input.trigger = { event, ...payload }), so per-entry configuration lives
  // in the CONFIG block at the top of each source.
  // --------------------------------------------------------------------------
  {
    slug: 'stage-entry-playbook-pack',
    name: 'Stage-entry playbook pack',
    category: 'sales',
    icon: '📋',
    summary:
      'The moment a deal enters a stage, the work for that stage should already be on someone\'s list. This creates a per-stage task checklist whenever a deal changes stage — qualification questions on entry to Qualified, proposal steps on entry to Proposal, closing steps on entry to Negotiation. The default playbooks fit the standard pipeline; edit the CONFIG block at the top of the code to match your stages and your process.',
    tags: ['playbook', 'process', 'stages'],
    spec: {
      name: 'stage-entry-playbook-pack',
      summary: 'On stage change, create the configured task checklist for the entered stage (defaults for QUALIFIED / PROPOSAL / NEGOTIATION).',
      triggerEvent: 'deal.stage_changed',
      triggerFilter: null,
      actions: [
        { kind: 'create_task', title_template: 'Playbook step for {deal.title} (stage entry)', due_in_days: 1 },
      ],
      source_code: `// Create a per-stage task checklist when a deal enters a stage.
// ── CONFIG ─────────────────────────────────────────────────────────────────
// Trigger filters only match events — they are not passed to this code — so
// edit the playbooks here in the plugin editor. Keys are stage names
// (UPPERCASE, matching your pipeline); values are the checklist steps. Each
// step becomes one task, due on consecutive days. Max 8 steps per stage.
var PLAYBOOKS = {
  QUALIFIED: [
    'Confirm budget, authority, need, and timeline',
    'Map the decision process and who signs',
    'Book the discovery-to-proposal handoff meeting',
  ],
  PROPOSAL: [
    'Draft and internally review the proposal',
    'Send the proposal and confirm receipt',
    'Book the proposal walkthrough call',
  ],
  NEGOTIATION: [
    'Confirm the negotiation counterparties and their asks',
    'Get internal sign-off on pricing floor and terms',
    'Agree the close plan and signature date with the buyer',
  ],
};
// ───────────────────────────────────────────────────────────────────────────
module.exports = {
  async run({ crm, input }) {
    var t = (input && input.trigger) || input || {};
    var rec = t.deal || t.record || t;
    var stage = String(t.stage || t.newStage || t.new_stage || rec.stage || '').toUpperCase();
    if (!stage) return { skipped: true, reason: 'no_stage' };
    var steps = PLAYBOOKS[stage];
    if (!Array.isArray(steps) || steps.length === 0) {
      crm.log('No playbook configured for stage ' + stage + ' — nothing to do.');
      return { skipped: true, reason: 'no_playbook_for_stage', stage: stage };
    }
    var dealId = Number(rec.id || t.id || t.dealId || t.deal_id);
    var deal = (Number.isInteger(dealId) && dealId > 0) ? await crm.getDeal(dealId) : null;
    var title = (deal && deal.title) || rec.title || t.title || ('deal #' + (dealId || '?'));
    var created = 0;
    for (var i = 0; i < steps.length && created < 8; i++) {
      var due = new Date(Date.now() + (i + 1) * 86400000).toISOString().slice(0, 10);
      await crm.createTask({
        title: String(steps[i]).slice(0, 400) + ' — ' + title,
        description: 'Playbook step ' + (i + 1) + ' of ' + Math.min(steps.length, 8) +
          ' for stage ' + stage + '. Created automatically when the deal entered the stage.',
        due_date: due,
        priority: (deal && deal.hot_flag) ? 'high' : 'medium',
        deal_id: deal ? deal.id : null,
        contact_id: (deal && deal.contact_id) || null,
      });
      created++;
    }
    crm.log('Stage-entry playbook for ' + stage + ': ' + created + ' task(s) on ' + title);
    return { stage: stage, tasks_created: created };
  },
};`,
    },
  },
  {
    slug: 'overdue-close-date-alert',
    name: 'Overdue close-date alert',
    category: 'sales',
    icon: '📅',
    summary:
      'A close date in the past is a forecast lying to you. Every day this finds open deals whose expected close date has already gone by and creates an update task on each — hot deals first, up to eight a day — so the owner either moves the date honestly, closes the deal, or admits it\'s lost. Your pipeline report stays something you can defend.',
    tags: ['close-date', 'forecast', 'hygiene'],
    spec: {
      name: 'overdue-close-date-alert',
      summary: 'Daily: open deals with a past expected close date each get an update-the-date task (max 8/day, hot first).',
      triggerEvent: 'schedule.daily',
      triggerFilter: { cron: '0 8 * * 1-5' },
      actions: [
        { kind: 'create_task', title_template: 'Close date passed: {deal.title}', due_in_days: 1 },
      ],
      source_code: `// Flag open deals whose expected close date is already in the past.
module.exports = {
  async run({ crm }) {
    var today = new Date().toISOString().slice(0, 10);
    var deals = await crm.listDeals({ status: 'open' });
    var overdue = deals.filter(function (d) {
      return d.expected_close_date && String(d.expected_close_date).slice(0, 10) < today;
    });
    if (overdue.length === 0) {
      crm.log('No open deals with a past close date. Forecast dates are clean.');
      return { overdue: 0 };
    }
    overdue.sort(function (a, b) { return (b.hot_flag ? 1 : 0) - (a.hot_flag ? 1 : 0); });
    var due = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    var created = 0;
    for (var i = 0; i < overdue.length && created < 8; i++) {
      var d = overdue[i];
      var was = String(d.expected_close_date).slice(0, 10);
      var days = Math.max(1, Math.floor((Date.now() - new Date(was).getTime()) / 86400000));
      await crm.createTask({
        title: 'Close date passed: ' + (d.title || ('#' + d.id)),
        description: 'Expected close was ' + was + ' — ' + days + ' day(s) ago — and the deal is still open in ' + d.stage + '.\\n' +
          'Pick one: set a real new close date, move the deal forward, or close it out honestly. A stale date poisons the whole forecast.',
        due_date: due,
        priority: d.hot_flag ? 'urgent' : 'high',
        deal_id: d.id,
        contact_id: d.contact_id || null,
      });
      created++;
    }
    crm.log('Deals past their close date: ' + overdue.length + '; update tasks created: ' + created);
    return { overdue: overdue.length, tasks_created: created };
  },
};`,
    },
  },
  {
    slug: 'slipping-deal-watch',
    name: 'Slipping close-date watch',
    category: 'sales',
    icon: '📉',
    summary:
      'One pushed close date is scheduling; a pattern of them is a deal quietly dying. Whenever a deal\'s expected close date is moved later, this creates a task showing the old date, the new date, and how many days it slipped — two-week-plus slips are flagged high priority — so every slip gets a stated reason instead of disappearing into the edit history.',
    tags: ['close-date', 'slippage', 'alerts'],
    spec: {
      name: 'slipping-deal-watch',
      summary: 'On a deal edit that pushes expected_close_date later, create a task showing old vs new date and the slip size.',
      triggerEvent: 'deal.updated',
      triggerFilter: null,
      actions: [
        { kind: 'create_task', title_template: 'Close date slipped: {deal.title}', due_in_days: 1 },
      ],
      source_code: `// Watch deal edits for a close date pushed LATER and surface the slip.
// deal.updated delivers changed:[fields] and prev:{field: oldValue} in the
// trigger payload — this entry works entirely from that diff.
module.exports = {
  async run({ crm, input }) {
    var t = (input && input.trigger) || input || {};
    var changed = Array.isArray(t.changed) ? t.changed : [];
    if (changed.indexOf('expected_close_date') === -1) {
      return { skipped: true, reason: 'close_date_not_changed' };
    }
    var prev = (t.prev && typeof t.prev === 'object') ? t.prev : {};
    var oldRaw = prev.expected_close_date;
    var newRaw = t.expected_close_date;
    var oldT = oldRaw ? Date.parse(String(oldRaw).slice(0, 10)) : NaN;
    var newT = newRaw ? Date.parse(String(newRaw).slice(0, 10)) : NaN;
    if (!(oldT > 0) || !(newT > 0)) return { skipped: true, reason: 'unparseable_dates' };
    if (newT <= oldT) {
      crm.log('Close date moved earlier or unchanged — that is good news, no task needed.');
      return { skipped: true, reason: 'not_a_slip' };
    }
    var slipDays = Math.round((newT - oldT) / 86400000);
    var oldDate = String(oldRaw).slice(0, 10);
    var newDate = String(newRaw).slice(0, 10);
    var title = t.title || ('deal #' + (t.id || '?'));
    var dealId = Number(t.id);
    var due = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    await crm.createTask({
      title: 'Close date slipped: ' + title + ' (+' + slipDays + ' days)',
      description: 'Expected close moved from ' + oldDate + ' to ' + newDate + ' — a ' + slipDays + '-day slip.\\n' +
        'Log WHY it moved on the deal: buyer-side delay, scope change, or wishful thinking. ' +
        'Repeated slips on the same deal are the classic sign it needs a different plan (or an honest closed-lost).',
      due_date: due,
      priority: slipDays >= 14 ? 'high' : 'medium',
      deal_id: (Number.isInteger(dealId) && dealId > 0) ? dealId : null,
    });
    crm.log('Slip task created for ' + title + ': ' + oldDate + ' -> ' + newDate + ' (+' + slipDays + 'd)');
    return { slipped_days: slipDays, task_created: true };
  },
};`,
    },
  },
  {
    slug: 'won-deal-onboarding-pack',
    name: 'Won-deal onboarding pack',
    category: 'sales',
    icon: '🚀',
    summary:
      'The riskiest moment of a customer relationship is the week after the signature, when sales exhales and nobody owns the handoff. When a deal closes won, this files the onboarding pack: an internal handoff task for tomorrow, a kickoff call task with the customer, and a 30-day check-in. With AI enabled, a kickoff-call brief is drafted right into the kickoff task (metered per-org); without it, the task carries a ready-to-run copilot brief.',
    tags: ['post-sale', 'onboarding', 'ai'],
    spec: {
      name: 'won-deal-onboarding-pack',
      summary: 'On closed-won: internal handoff task (+1d), kickoff call task (+3d) with an AI kickoff brief, 30-day check-in task.',
      triggerEvent: 'deal.stage_changed',
      triggerFilter: { stage: 'CLOSED_WON' },
      actions: [
        { kind: 'create_task', title_template: 'Internal handoff: {deal.title}', due_in_days: 1 },
        { kind: 'create_task', title_template: 'Kickoff call: {deal.title}', due_in_days: 3 },
        { kind: 'create_task', title_template: '30-day check-in: {deal.title}', due_in_days: 30 },
        {
          kind: 'claude_complete',
          prompt_template:
            'Draft a kickoff-call brief for the newly signed deal "{deal.title}": agenda, the three things to confirm in week one, and the success measure to agree on. Under 150 words.',
          store_as: 'kickoff_brief',
        },
      ],
      source_code: `// File the post-signature onboarding pack when a deal closes won.
module.exports = {
  async run({ crm, input }) {
    var t = (input && input.trigger) || input || {};
    var rec = t.deal || t.record || t;
    var stage = String(t.stage || t.newStage || t.new_stage || rec.stage || '').toUpperCase();
    if (stage !== 'CLOSED_WON') return { skipped: true, reason: 'not_closed_won' };
    var dealId = Number(rec.id || t.id || t.dealId || t.deal_id);
    var deal = (Number.isInteger(dealId) && dealId > 0) ? await crm.getDeal(dealId) : null;
    var title = (deal && deal.title) || rec.title || t.title || 'the new deal';
    var contactId = (deal && deal.contact_id) || null;
    function dueIn(days) { return new Date(Date.now() + days * 86400000).toISOString().slice(0, 10); }
    // 1. Internal handoff — tomorrow.
    await crm.createTask({
      title: 'Internal handoff: ' + title,
      description: 'Hand the account from sales to delivery/success while everything is fresh:\\n' +
        '1. Who owns this account from today?\\n' +
        '2. What exactly was sold (scope, price, promises made)?\\n' +
        '3. Any red flags or special requests from the sales cycle?\\n' +
        'Write the answers on the deal so the kickoff call starts informed.',
      due_date: dueIn(1),
      priority: 'high',
      deal_id: deal ? deal.id : null,
      contact_id: contactId,
    });
    // 2. Kickoff call — with an AI-drafted brief when AI is on.
    var brief = 'Draft a kickoff-call brief for the newly signed deal "' + title +
      '": a short agenda, the three things to confirm in week one, and the success measure to agree on. Under 150 words.';
    var draft = null;
    var ai = await crm.ai.complete({ prompt: brief + ' No preamble.', max_tokens: 350 });
    if (ai && ai.ok && ai.text) draft = ai.text;
    await crm.createTask({
      title: 'Kickoff call: ' + title,
      description: 'Book and run the customer kickoff within the first week.\\n' +
        (draft
          ? 'AI kickoff brief (review before the call):\\n' + draft
          : 'Copilot brief (paste into chat to draft it): ' + brief),
      due_date: dueIn(3),
      priority: 'high',
      deal_id: deal ? deal.id : null,
      contact_id: contactId,
    });
    // 3. 30-day check-in.
    await crm.createTask({
      title: '30-day check-in: ' + title,
      description: 'One month in: is the customer getting what they bought?\\n' +
        'Check delivery against the kickoff commitments, ask what is missing, and log the account health honestly.',
      due_date: dueIn(30),
      priority: 'medium',
      deal_id: deal ? deal.id : null,
      contact_id: contactId,
    });
    crm.log('Onboarding pack (3 tasks) filed for ' + title + '. AI kickoff brief: ' + (draft ? 'yes' : 'no'));
    return { tasks_created: 3, ai_drafted: !!draft };
  },
};`,
    },
  },
  {
    slug: 'discount-approval-review',
    name: 'Discount review on big price drops',
    category: 'sales',
    icon: '🏷️',
    summary:
      'When a deal\'s amount is cut by more than your threshold (default 15%), this files an urgent review task showing the old amount, the new amount, and the size of the discount, so a manager sees every significant price concession the day it happens. Honest scope: this is a review task after the edit, not a blocking approval — the CRM doesn\'t hold the change hostage. Set your threshold in the CONFIG block.',
    tags: ['pricing', 'discounts', 'review'],
    spec: {
      name: 'discount-approval-review',
      summary: 'On a deal edit that cuts amount by ≥ the configured percent, create an urgent manager review task (review, not blocking).',
      triggerEvent: 'deal.updated',
      triggerFilter: null,
      actions: [
        { kind: 'create_task', title_template: 'Review discount on {deal.title}', due_in_days: 0 },
      ],
      source_code: `// Surface big deal-amount cuts for management review.
// ── CONFIG ─────────────────────────────────────────────────────────────────
// Trigger filters only match events — they are not passed to this code — so
// edit the threshold here in the plugin editor.
var DISCOUNT_PCT = 15;   // review when the amount drops by at least this %
var MIN_PREV_AMOUNT = 1000; // ignore cuts on deals smaller than this
// ───────────────────────────────────────────────────────────────────────────
module.exports = {
  async run({ crm, input }) {
    var t = (input && input.trigger) || input || {};
    var changed = Array.isArray(t.changed) ? t.changed : [];
    if (changed.indexOf('amount') === -1) return { skipped: true, reason: 'amount_not_changed' };
    var prev = (t.prev && typeof t.prev === 'object') ? t.prev : {};
    var oldAmount = Number(prev.amount) || 0;
    var newAmount = Number(t.amount) || 0;
    if (oldAmount < MIN_PREV_AMOUNT) return { skipped: true, reason: 'below_min_amount' };
    if (newAmount >= oldAmount) return { skipped: true, reason: 'not_a_cut' };
    var pct = Math.round(((oldAmount - newAmount) / oldAmount) * 100);
    if (pct < DISCOUNT_PCT) {
      crm.log('Amount cut of ' + pct + '% is under the ' + DISCOUNT_PCT + '% review threshold.');
      return { skipped: true, reason: 'under_threshold', pct: pct };
    }
    var title = t.title || ('deal #' + (t.id || '?'));
    var dealId = Number(t.id);
    var today = new Date().toISOString().slice(0, 10);
    await crm.createTask({
      title: 'Review discount on ' + title + ' (-' + pct + '%)',
      description: 'Deal amount was cut from $' + Math.round(oldAmount) + ' to $' + Math.round(newAmount) +
        ' — a ' + pct + '% discount (review threshold: ' + DISCOUNT_PCT + '%).\\n' +
        'This is a post-edit review, not a blocking approval: the change is already live.\\n' +
        'Confirm the discount was justified and authorized, and log what was received in return (term length, case study, faster signature).',
      due_date: today,
      priority: 'urgent',
      deal_id: (Number.isInteger(dealId) && dealId > 0) ? dealId : null,
    });
    crm.log('Discount review task filed for ' + title + ': $' + Math.round(oldAmount) + ' -> $' + Math.round(newAmount) + ' (-' + pct + '%)');
    return { pct: pct, task_created: true };
  },
};`,
    },
  },
  {
    slug: 'stage-velocity-stamper',
    name: 'Stage-entry timestamps',
    category: 'sales',
    icon: '⏲️',
    summary:
      'You can\'t improve stage velocity you never measured. Whenever a deal changes stage, this stamps the entry as a dated log entry on the deal\'s timeline — an already-completed task recording which stage was entered, from where, and when — so "how long do deals sit in Proposal?" becomes an answerable question. It creates no open to-dos; the stamps are records, not work.',
    tags: ['velocity', 'stages', 'analytics'],
    spec: {
      name: 'stage-velocity-stamper',
      summary: 'On every stage change, record a dated, already-completed log task on the deal (stage entered, previous stage, date).',
      triggerEvent: 'deal.stage_changed',
      triggerFilter: null,
      actions: [
        { kind: 'create_task', title_template: 'Stage log: {deal.title} entered {stage}', due_in_days: 0 },
      ],
      source_code: `// Stamp stage entries as completed log tasks on the deal timeline.
// The SDK has no custom-field write surface, so the durable, queryable place
// to record a stage-entry date is a completed task linked to the deal.
module.exports = {
  async run({ crm, input }) {
    var t = (input && input.trigger) || input || {};
    var rec = t.deal || t.record || t;
    var stage = String(t.stage || t.newStage || t.new_stage || rec.stage || '').toUpperCase();
    if (!stage) return { skipped: true, reason: 'no_stage' };
    var prevStage = String(t.prev_stage || t.previousStage || t.previous_stage || '').toUpperCase();
    var dealId = Number(rec.id || t.id || t.dealId || t.deal_id);
    var title = rec.title || t.title || ('deal #' + (dealId || '?'));
    var today = new Date().toISOString().slice(0, 10);
    await crm.createTask({
      title: 'Stage log: ' + title + ' entered ' + stage + ' (' + today + ')',
      description: 'Automatic stage-velocity stamp.\\n' +
        'Entered: ' + stage + (prevStage ? '\\nFrom: ' + prevStage : '') + '\\nOn: ' + today + '\\n' +
        'These completed log tasks make time-in-stage auditable from the deal timeline.',
      due_date: today,
      status: 'completed',
      priority: 'low',
      deal_id: (Number.isInteger(dealId) && dealId > 0) ? dealId : null,
    });
    crm.log('Stage-entry stamp: ' + title + ' -> ' + stage + (prevStage ? ' (from ' + prevStage + ')' : ''));
    return { stamped: true, stage: stage };
  },
};`,
    },
  },
  {
    slug: 'activity-chain-next-step',
    name: 'Activity chain: next step on completion',
    category: 'sales',
    icon: '⛓️',
    summary:
      'The Pipedrive habit worth stealing: finishing a deal task should immediately raise the next one, so a deal never sits with zero planned activity. When a deal-linked task is completed, this creates the follow-on task a few days out (configurable in the CONFIG block). Chain-created tasks are marked so completing one doesn\'t spawn an infinite chain of chains.',
    tags: ['tasks', 'cadence', 'process'],
    spec: {
      name: 'activity-chain-next-step',
      summary: 'On completion of a deal-linked task, create the configured follow-on task (loop-guarded by title prefix).',
      triggerEvent: 'task.completed',
      triggerFilter: null,
      actions: [
        { kind: 'create_task', title_template: 'Next step: after "{task.title}"', due_in_days: 3 },
      ],
      source_code: `// Keep a next step on the deal: completing a deal task raises the follow-on.
// ── CONFIG ─────────────────────────────────────────────────────────────────
// Trigger filters only match events — they are not passed to this code — so
// edit the cadence here in the plugin editor.
var NEXT_STEP_DAYS = 3;              // due this many days after completion
var CHAIN_PREFIX = 'Next step:';     // marks chain-created tasks (loop guard)
// ───────────────────────────────────────────────────────────────────────────
module.exports = {
  async run({ crm, input }) {
    var t = (input && input.trigger) || input || {};
    var rec = t.task || t.record || t;
    var taskTitle = String(rec.title || t.title || '');
    var dealId = Number(rec.deal_id != null ? rec.deal_id : t.deal_id);
    if (!(Number.isInteger(dealId) && dealId > 0)) {
      return { skipped: true, reason: 'not_deal_linked' };
    }
    // Loop guard: completing a chain-created task must not chain again.
    if (taskTitle.indexOf(CHAIN_PREFIX) === 0) {
      crm.log('Completed task is itself a chain step — not chaining again.');
      return { skipped: true, reason: 'chain_task_completed' };
    }
    var deal = await crm.getDeal(dealId);
    if (!deal || String(deal.status || '') !== 'open') {
      return { skipped: true, reason: 'deal_not_open' };
    }
    var due = new Date(Date.now() + NEXT_STEP_DAYS * 86400000).toISOString().slice(0, 10);
    await crm.createTask({
      title: CHAIN_PREFIX + ' after "' + taskTitle.slice(0, 200) + '" — ' + (deal.title || ('#' + deal.id)),
      description: 'The previous task on this deal was just completed. Decide and do the next concrete move ' +
        '(call, meeting, proposal revision, internal step) so the deal keeps a live next step. ' +
        'Rename this task to what the step actually is.',
      due_date: due,
      priority: deal.hot_flag ? 'high' : 'medium',
      deal_id: deal.id,
      contact_id: deal.contact_id || (rec.contact_id != null ? Number(rec.contact_id) || null : null),
    });
    crm.log('Chained next step on deal ' + deal.id + ' after completion of "' + taskTitle + '"');
    return { chained: true, deal_id: deal.id };
  },
};`,
    },
  },
  {
    slug: 'owner-change-handoff',
    name: 'Owner-change handoff brief',
    category: 'sales',
    icon: '🤝',
    summary:
      'Reassigned deals lose momentum in the gap between owners — the new owner doesn\'t know what\'s open, promised, or overdue. When a deal\'s owner changes, this creates a same-week handoff task for the new owner summarizing the deal\'s stage, amount, close date, and every open task on it, with the previous owner named so questions have an address.',
    tags: ['handoff', 'ownership', 'process'],
    spec: {
      name: 'owner-change-handoff',
      summary: 'On a deal owner change, create a handoff task summarizing stage, amount, close date, and the open tasks on the deal.',
      triggerEvent: 'deal.updated',
      triggerFilter: null,
      actions: [
        { kind: 'create_task', title_template: 'Handoff brief: {deal.title}', due_in_days: 2 },
      ],
      source_code: `// Brief the new owner when a deal changes hands.
module.exports = {
  async run({ crm, input }) {
    var t = (input && input.trigger) || input || {};
    var changed = Array.isArray(t.changed) ? t.changed : [];
    if (changed.indexOf('owner_id') === -1) return { skipped: true, reason: 'owner_not_changed' };
    var prev = (t.prev && typeof t.prev === 'object') ? t.prev : {};
    var fromOwner = prev.owner_id != null ? ('user #' + prev.owner_id) : 'unassigned';
    var toOwner = t.owner_id != null ? ('user #' + t.owner_id) : 'unassigned';
    var dealId = Number(t.id);
    var deal = (Number.isInteger(dealId) && dealId > 0) ? await crm.getDeal(dealId) : null;
    var title = (deal && deal.title) || t.title || ('deal #' + (dealId || '?'));
    var openTasks = deal ? await crm.listTasks({ deal_id: deal.id, status: 'open' }) : [];
    var taskLines = openTasks.slice(0, 8).map(function (x) {
      return '- ' + (x.title || ('task #' + x.id)) + (x.due_date ? ' (due ' + String(x.due_date).slice(0, 10) + ')' : '');
    });
    var facts = [];
    if (deal) {
      facts.push('Stage: ' + deal.stage);
      if (deal.amount != null) facts.push('Amount: $' + Math.round(Number(deal.amount) || 0));
      if (deal.expected_close_date) facts.push('Expected close: ' + String(deal.expected_close_date).slice(0, 10));
    }
    var due = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
    await crm.createTask({
      title: 'Handoff brief: ' + title + ' (' + fromOwner + ' -> ' + toOwner + ')',
      description: 'This deal changed owner (' + fromOwner + ' -> ' + toOwner + ').\\n' +
        (facts.length ? facts.join('\\n') + '\\n' : '') +
        'Open tasks on the deal (' + openTasks.length + '):\\n' + (taskLines.join('\\n') || '- none') + '\\n' +
        'New owner: read the deal history, confirm the next step with the customer, and ask ' + fromOwner + ' about anything unwritten.',
      due_date: due,
      priority: 'high',
      deal_id: deal ? deal.id : null,
    });
    crm.log('Handoff brief filed for ' + title + ': ' + fromOwner + ' -> ' + toOwner + ' (' + openTasks.length + ' open tasks)');
    return { task_created: true, open_tasks: openTasks.length };
  },
};`,
    },
  },
  {
    slug: 'quote-expiry-chaser',
    name: 'Quote-expiry chaser',
    category: 'sales',
    icon: '⌛',
    summary:
      'A quote that expires unanswered is a deal you paid to price and then forgot to win. Every day this scans sent quotes whose validity ends within seven days and creates a chase task per quote (up to five a day). With AI enabled, the soonest-to-expire quote gets a polite nudge email drafted right into its task (metered per-org); the rest — and everything when AI is off — carry a ready-to-run copilot brief. Workspaces without the quotes module simply see it do nothing.',
    tags: ['quotes', 'follow-up', 'ai'],
    spec: {
      name: 'quote-expiry-chaser',
      summary: 'Daily: sent quotes expiring within 7 days each get a chase task (max 5/day); AI drafts the nudge for the soonest expiry.',
      triggerEvent: 'schedule.daily',
      triggerFilter: { cron: '0 8 * * 1-5' },
      actions: [
        { kind: 'create_task', title_template: 'Chase quote before expiry: {quote.title}', due_in_days: 0 },
        {
          kind: 'claude_complete',
          prompt_template:
            'Draft a short, polite nudge email about quote "{quote.title}" which expires on {quote.valid_until}. Offer to answer questions or extend if they need more time. Under 100 words. Output the email body only.',
          store_as: 'nudge',
        },
      ],
      source_code: `// Chase sent quotes that are about to expire.
module.exports = {
  async run({ crm }) {
    // Returns [] when the quotes module is disabled for this workspace.
    var quotes = await crm.listQuotes({ status: 'sent' });
    var now = Date.now();
    var horizon = now + 7 * 86400000;
    var expiring = quotes.filter(function (q) {
      if (String(q.status || '') !== 'sent' || !q.valid_until) return false;
      var t = Date.parse(String(q.valid_until).slice(0, 10));
      return t > 0 && t >= now - 86400000 && t <= horizon;
    });
    if (expiring.length === 0) {
      crm.log('No sent quotes expiring in the next 7 days (or the quotes module is disabled).');
      return { expiring: 0 };
    }
    expiring.sort(function (a, b) { return Date.parse(a.valid_until) - Date.parse(b.valid_until); });
    var today = new Date().toISOString().slice(0, 10);
    var created = 0;
    var drafted = 0;
    for (var i = 0; i < expiring.length && created < 5; i++) {
      var q = expiring[i];
      var expires = String(q.valid_until).slice(0, 10);
      var brief = 'Draft a short, polite nudge email about quote "' + (q.title || ('#' + q.id)) +
        '" which expires on ' + expires + '. Offer to answer questions or extend if they need more time. Under 100 words.';
      var draft = null;
      if (i === 0) {
        // One metered AI call per run, spent on the soonest expiry.
        var ai = await crm.ai.complete({ prompt: brief + ' Output the email body only.', max_tokens: 250 });
        if (ai && ai.ok && ai.text) { draft = ai.text; drafted++; }
      }
      await crm.createTask({
        title: 'Chase quote before expiry: ' + (q.title || ('#' + q.id)) + ' (expires ' + expires + ')',
        description: 'Quote' + (q.total_amount != null ? ' worth $' + Math.round(Number(q.total_amount) || 0) : '') +
          ' was sent and expires ' + expires + '.\\n' +
          'Nudge the customer today — a quote that lapses silently usually means a competitor did not let theirs.\\n' +
          (draft
            ? 'AI draft (review before sending):\\n' + draft
            : 'Copilot brief (paste into chat to draft it): ' + brief),
        due_date: today,
        priority: 'high',
        deal_id: q.deal_id || null,
      });
      created++;
    }
    crm.log('Quotes expiring within 7 days: ' + expiring.length + '; chase tasks created: ' + created + '; AI drafts: ' + drafted);
    return { expiring: expiring.length, tasks_created: created, ai_drafted: drafted };
  },
};`,
    },
  },
  {
    slug: 'quote-follow-up-cadence',
    name: 'Quote follow-up cadence (3/7/14 days)',
    category: 'sales',
    icon: '🗓️',
    summary:
      'Most quotes die of silence, not rejection. The moment a quote goes out, this schedules the full follow-up cadence: a day-3 check that it landed and questions are answered, a day-7 walkthrough call, and a day-14 decision push before the quote goes stale. Three tasks, filed while you\'re still thinking about the deal, each linked back to it.',
    tags: ['quotes', 'cadence', 'follow-up'],
    spec: {
      name: 'quote-follow-up-cadence',
      summary: 'On quote sent, create the 3/7/14-day follow-up task cadence, each task linked to the quote\'s deal.',
      triggerEvent: 'quote.sent',
      triggerFilter: null,
      actions: [
        { kind: 'create_task', title_template: 'Day-3 check-in on quote {quote.title}', due_in_days: 3 },
        { kind: 'create_task', title_template: 'Day-7 walkthrough call on quote {quote.title}', due_in_days: 7 },
        { kind: 'create_task', title_template: 'Day-14 decision push on quote {quote.title}', due_in_days: 14 },
      ],
      source_code: `// Schedule the 3/7/14-day follow-up cadence when a quote is sent.
module.exports = {
  async run({ crm, input }) {
    var t = (input && input.trigger) || input || {};
    var q = t.quote || t.record || t;
    var label = q.title || q.public_id || (q.id ? ('quote #' + q.id) : 'the quote');
    var dealId = Number(q.deal_id != null ? q.deal_id : t.deal_id);
    var link = (Number.isInteger(dealId) && dealId > 0) ? dealId : null;
    function dueIn(days) { return new Date(Date.now() + days * 86400000).toISOString().slice(0, 10); }
    await crm.createTask({
      title: 'Day-3 check-in: ' + label,
      description: 'Confirm the quote landed with the right person and ask what questions they have. Short and helpful — not a chase yet.',
      due_date: dueIn(3), priority: 'medium', deal_id: link,
    });
    await crm.createTask({
      title: 'Day-7 walkthrough: ' + label,
      description: 'Offer a 20-minute call to walk through the quote line by line. Most objections die when someone explains the numbers in person.',
      due_date: dueIn(7), priority: 'medium', deal_id: link,
    });
    await crm.createTask({
      title: 'Day-14 decision push: ' + label,
      description: 'Two weeks out — ask directly where the decision stands and what is blocking it. If the quote has a validity date, mention it honestly.',
      due_date: dueIn(14), priority: 'high', deal_id: link,
    });
    crm.log('Quote follow-up cadence (day 3/7/14) scheduled for ' + label);
    return { tasks_created: 3 };
  },
};`,
    },
  },
];
