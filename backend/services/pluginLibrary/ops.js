// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Curated library — OPS / PRODUCTIVITY entries. See ./index.js for the
// authoring contract.

module.exports = [
  {
    slug: 'overdue-task-escalation',
    name: 'Overdue-task priority escalation',
    category: 'ops',
    icon: '🚨',
    summary:
      'An overdue task that keeps its original priority is easy to keep ignoring. When a task goes overdue, this bumps its priority one level (medium becomes high, high becomes urgent) so aging work climbs the list instead of sinking — the follow-through half of any SLA you set with tasks.',
    tags: ['tasks', 'escalation', 'sla'],
    spec: {
      name: 'overdue-task-escalation',
      summary: 'On task overdue, bump the task priority one level so aging work rises to the top.',
      triggerEvent: 'task.overdue',
      triggerFilter: null,
      actions: [
        { kind: 'set_field', entity: 'task', field: 'priority', value: 'escalated_one_level' },
      ],
      source_code: `// Escalate an overdue task's priority one level.
module.exports = {
  async run({ crm, input }) {
    var rec = (input && (input.task || input.record)) || input || {};
    var taskId = Number(rec.id || (input && (input.taskId || input.task_id)));
    if (!Number.isInteger(taskId) || taskId <= 0) return { skipped: true, reason: 'no_task_id' };
    var task = await crm.getTask(taskId);
    if (!task) return { skipped: true, reason: 'task_not_found' };
    if (task.status !== 'open' && task.status !== 'in_progress') {
      return { skipped: true, reason: 'task_not_open' };
    }
    var ladder = { low: 'medium', medium: 'high', high: 'urgent', urgent: 'urgent' };
    var next = ladder[task.priority] || 'high';
    if (next === task.priority) {
      crm.log('Task ' + task.id + ' is already at ' + task.priority + '; nothing to escalate.');
      return { escalated: false, priority: task.priority };
    }
    await crm.updateTask(task.id, { priority: next });
    crm.log('Escalated overdue task ' + task.id + ' ("' + (task.title || '') + '") from ' + task.priority + ' to ' + next + '.');
    return { escalated: true, from: task.priority, to: next };
  },
};`,
    },
  },
  {
    slug: 'daily-deal-prep-brief',
    name: 'Daily deal-prep brief',
    category: 'ops',
    icon: '☕',
    summary:
      'Every weekday morning, this looks at the tasks due today, pulls up the deals behind them — stage, amount, hot flag — and files one prep-brief task with a per-deal rundown. With AI enabled, the talking-points sheet is drafted right into the task (metered per-org); without it, the task carries a ready-to-run copilot prompt instead. Walk into the day already knowing which conversations matter.',
    tags: ['daily', 'preparation', 'ai'],
    spec: {
      name: 'daily-deal-prep-brief',
      summary: 'Weekday-morning task summarizing the deals behind today\'s due tasks, with an AI prep-sheet brief.',
      triggerEvent: 'schedule.daily',
      triggerFilter: { cron: '0 7 * * 1-5' },
      actions: [
        { kind: 'create_task', title_template: 'Deal prep for {today} ({count} deals)', due_in_days: 0 },
        {
          kind: 'claude_complete',
          prompt_template:
            'Build a prep sheet from this list of deals with tasks due today: {deals}. For each: one line of status and one suggested talking point.',
          store_as: 'prep_sheet',
        },
      ],
      source_code: `// Morning brief: the deals behind today's due tasks.
module.exports = {
  async run({ crm }) {
    var today = new Date().toISOString().slice(0, 10);
    var tasks = await crm.listTasks({ status: 'open' });
    var dueToday = tasks.filter(function (t) { return t.due_date && String(t.due_date).slice(0, 10) <= today; });
    var dealIds = [];
    var taskByDeal = {};
    for (var i = 0; i < dueToday.length; i++) {
      var t = dueToday[i];
      if (!t.deal_id) continue;
      if (dealIds.indexOf(t.deal_id) === -1 && dealIds.length < 8) dealIds.push(t.deal_id);
      if (!taskByDeal[t.deal_id]) taskByDeal[t.deal_id] = t.title;
    }
    if (dealIds.length === 0) {
      crm.log('No deal-linked tasks due today. No prep brief needed.');
      return { deals: 0, tasks_due: dueToday.length };
    }
    var lines = [];
    for (var j = 0; j < dealIds.length; j++) {
      var d = await crm.getDeal(dealIds[j]);
      if (!d) continue;
      lines.push('- ' + (d.title || ('#' + d.id)) + ' [' + d.stage + ', $' + Math.round(Number(d.amount) || 0) + (d.hot_flag ? ', HOT' : '') + '] — today: ' + (taskByDeal[dealIds[j]] || ''));
    }
    // Metered in-run AI: draft the prep sheet now. On { configured:false } or
    // { blocked:true } fall back to embedding the copilot brief in the task.
    var prepSheet = null;
    var ai = await crm.ai.complete({
      prompt: 'Build a prep sheet from this list of deals with tasks due today:\\n' + lines.join('\\n') +
        '\\nFor each deal: one line of status and one suggested talking point for today. Plain text, no preamble.',
      max_tokens: 600,
    });
    if (ai && ai.ok && ai.text) prepSheet = ai.text;
    await crm.createTask({
      title: 'Deal prep for ' + today + ' (' + lines.length + ' deal' + (lines.length === 1 ? '' : 's') + ')',
      description: 'Deals with work due today:\\n' + lines.join('\\n') + '\\n' +
        (prepSheet
          ? 'AI prep sheet:\\n' + prepSheet
          : 'Copilot brief (paste into chat for a talking-points sheet): For each deal above, give one line of status and one suggested talking point for today.'),
      due_date: today,
      priority: 'high',
    });
    crm.log('Prep brief covers ' + lines.length + ' deal(s) from ' + dueToday.length + ' due task(s). AI sheet: ' + (prepSheet ? 'yes' : 'no'));
    return { deals: lines.length, tasks_due: dueToday.length, ai_drafted: !!prepSheet };
  },
};`,
    },
  },
  {
    slug: 'eod-wrapup-summary',
    name: 'End-of-day wrap-up',
    category: 'ops',
    icon: '🌆',
    summary:
      'Close the day with a record instead of a vague feeling. At 6pm on weekdays this gathers what actually moved — tasks completed today and deals touched today — into one wrap-up task. With AI enabled it condenses the day into a three-bullet update right in the task (metered per-org); without it, the task carries the copilot prompt to do the same in chat.',
    tags: ['daily', 'digest', 'ai'],
    spec: {
      name: 'eod-wrapup-summary',
      summary: 'Weekday 6pm task summarizing tasks completed and deals touched today, with an AI brief for a 3-bullet update.',
      triggerEvent: 'schedule.daily',
      triggerFilter: { cron: '0 18 * * 1-5' },
      actions: [
        { kind: 'create_task', title_template: 'End-of-day wrap-up — {today}', due_in_days: 0 },
        {
          kind: 'claude_complete',
          prompt_template:
            'Condense this end-of-day activity into a three-bullet update for the team: {activity}. Plain language, one line per bullet.',
          store_as: 'update',
        },
      ],
      source_code: `// End-of-day wrap-up: tasks completed and deals touched today.
module.exports = {
  async run({ crm }) {
    var today = new Date().toISOString().slice(0, 10);
    function isToday(iso) { return iso && String(iso).slice(0, 10) === today; }
    var completed = (await crm.listTasks({ status: 'completed' })).filter(function (t) { return isToday(t.updated_at); });
    var touched = (await crm.listDeals({})).filter(function (d) { return isToday(d.updated_at) || isToday(d.last_activity_at); });
    if (completed.length === 0 && touched.length === 0) {
      crm.log('Nothing recorded today — skipping the wrap-up task.');
      return { tasks_completed: 0, deals_touched: 0 };
    }
    var taskLines = completed.slice(0, 8).map(function (t) { return '- ' + (t.title || ('task #' + t.id)); });
    var dealLines = touched.slice(0, 8).map(function (d) { return '- ' + (d.title || ('#' + d.id)) + ' [' + d.stage + ']'; });
    var activity = 'Tasks completed today (' + completed.length + '):\\n' + (taskLines.join('\\n') || '- none') + '\\n' +
      'Deals touched today (' + touched.length + '):\\n' + (dealLines.join('\\n') || '- none');
    // Metered in-run AI: condense the day into the three-bullet update now;
    // fall back to the copilot brief when AI is unconfigured or blocked.
    var update = null;
    var ai = await crm.ai.complete({
      prompt: 'Condense this end-of-day CRM activity into a three-bullet update for the team. Plain language, one line per bullet, no preamble.\\n' + activity,
      max_tokens: 300,
    });
    if (ai && ai.ok && ai.text) update = ai.text;
    await crm.createTask({
      title: 'End-of-day wrap-up — ' + today,
      description: activity + '\\n' +
        (update
          ? 'AI three-bullet update:\\n' + update
          : 'Copilot brief (paste into chat): Condense the activity above into a three-bullet end-of-day update for the team.'),
      due_date: today,
      priority: 'low',
    });
    crm.log('EOD wrap-up: ' + completed.length + ' tasks completed, ' + touched.length + ' deals touched. AI update: ' + (update ? 'yes' : 'no'));
    return { tasks_completed: completed.length, deals_touched: touched.length, ai_drafted: !!update };
  },
};`,
    },
  },
  {
    slug: 'new-company-research-pack',
    name: 'New-company research pack',
    category: 'ops',
    icon: '🔍',
    summary:
      'Every new company added to the CRM gets a research task with the five questions worth answering before the first call: company size and market, the likely decision-makers, current vendors or alternatives, recent news or buying triggers, and the sharpest opening offer. With AI enabled, the five questions are tailored to the specific company (metered per-org, drafted from your CRM data — it does not browse the web); without it, you get the proven standard five.',
    tags: ['research', 'new-business', 'ai'],
    spec: {
      name: 'new-company-research-pack',
      summary: 'On company creation, file a research task with a five-question pre-call research pack.',
      triggerEvent: 'company.created',
      triggerFilter: null,
      actions: [
        { kind: 'create_task', title_template: 'Research pack: {company.name}', due_in_days: 2 },
        {
          kind: 'claude_complete',
          prompt_template:
            'Draft five sharp research questions to answer before a first sales call with {company.name} ({company.industry}). Focus on decision-makers, current alternatives, and buying triggers.',
          store_as: 'questions',
        },
      ],
      source_code: `// File a pre-call research pack when a company is added.
module.exports = {
  async run({ crm, input }) {
    var rec = (input && (input.company || input.record)) || input || {};
    var companyId = Number(rec.id || (input && (input.companyId || input.company_id)));
    var company = (Number.isInteger(companyId) && companyId > 0) ? await crm.getCompany(companyId) : null;
    var name = (company && company.name) || rec.name || 'the new company';
    var industry = (company && company.industry) || rec.industry || null;
    var website = (company && company.website) || rec.website || null;
    var known = [];
    if (industry) known.push('Industry on record: ' + industry);
    if (website) known.push('Website on record: ' + website);
    var due = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
    // Metered in-run AI: tailor the five questions to this company. Falls
    // back to the standard five when AI is unconfigured or blocked.
    var questions =
      '1. How big is ' + name + ' — headcount, revenue band, growth trajectory?\\n' +
      '2. Who are the likely decision-makers and what do they care about?\\n' +
      '3. What are they using today for what we sell (vendor, in-house, nothing)?\\n' +
      '4. Any recent news, hires, or funding that create a buying trigger?\\n' +
      '5. Given all that, what is our sharpest opening offer?';
    var aiTailored = false;
    var ai = await crm.ai.complete({
      prompt: 'Draft five sharp research questions to answer before a first sales call with ' + name +
        (industry ? ' (industry: ' + industry + ')' : '') + (website ? ' (website on record: ' + website + ')' : '') +
        '. Focus on decision-makers, current alternatives, and buying triggers. Numbered list, one line each, no preamble.',
      max_tokens: 350,
    });
    if (ai && ai.ok && ai.text) { questions = ai.text; aiTailored = true; }
    await crm.createTask({
      title: 'Research pack: ' + name,
      description: (known.length ? known.join('\\n') + '\\n' : '') +
        'Answer these five before the first call (ask the copilot in chat, or research directly):\\n' +
        questions + '\\n' +
        'Log the answers on the company record when done.',
      due_date: due,
      priority: 'medium',
    });
    crm.log('Research pack filed for ' + name + (aiTailored ? ' (AI-tailored questions)' : ''));
    return { task_created: true, company: name, ai_drafted: aiTailored };
  },
};`,
    },
  },

  // --------------------------------------------------------------------------
  // WAVE 2 (2026-09) — ROUTING & ASSIGNMENT. Trigger filters only MATCH
  // events (they are never passed into the run), so per-entry configuration
  // lives in the clearly-marked CONFIG block at the top of each source — an
  // admin edits it once in the plugin editor after installing.
  // --------------------------------------------------------------------------
  {
    slug: 'round-robin-deal-assigner',
    name: 'Round-robin deal assignment',
    category: 'ops',
    icon: '🔁',
    summary:
      'New deals that all land on whoever created them is how one rep drowns while another waits. This assigns each new deal an owner from your roster, rotating evenly (deal id modulo roster — stateless, no counters to drift). Set the roster once in the CONFIG block at the top of the code; until you do, it rotates through the owners already active on your open deals.',
    tags: ['routing', 'assignment', 'round-robin'],
    requiredConfig: ['owner_roster'],
    spec: {
      name: 'round-robin-deal-assigner',
      summary: 'On deal creation, assign an owner from a configured roster, rotating evenly by deal id.',
      triggerEvent: 'deal.created',
      triggerFilter: null,
      actions: [
        { kind: 'set_field', entity: 'deal', field: 'owner_id', value: 'next_in_rotation' },
      ],
      source_code: `// Assign new deals round-robin across an owner roster.
// ── CONFIG ─────────────────────────────────────────────────────────────────
// Trigger filters only match events — they are not passed to this code — so
// edit these defaults here in the plugin editor.
var OWNER_IDS = []; // user ids to rotate through, e.g. [3, 7, 12].
                    // Left empty, the roster is derived from the owners
                    // already holding open deals in this workspace.
// ───────────────────────────────────────────────────────────────────────────
module.exports = {
  async run({ crm, input }) {
    var t = (input && input.trigger) || input || {};
    var rec = t.deal || t.record || t;
    var dealId = Number(rec.id || t.dealId || t.deal_id);
    if (!Number.isInteger(dealId) || dealId <= 0) return { skipped: true, reason: 'no_deal_id' };
    var deal = await crm.getDeal(dealId);
    if (!deal) return { skipped: true, reason: 'deal_not_found' };
    var roster = OWNER_IDS.filter(function (n) { return Number.isInteger(n) && n > 0; });
    if (roster.length === 0) {
      // Derive a roster from the owners already working open deals.
      var open = await crm.listDeals({ status: 'open' });
      var seen = {};
      for (var i = 0; i < open.length && roster.length < 20; i++) {
        var o = open[i].owner_id;
        if (o != null && !seen[o]) { seen[o] = true; roster.push(Number(o)); }
      }
    }
    if (roster.length === 0) {
      crm.log('No owner roster configured and no deal owners found to derive one. Edit OWNER_IDS in the plugin code.');
      return { skipped: true, reason: 'no_roster' };
    }
    var pick = roster[deal.id % roster.length];
    if (deal.owner_id != null && Number(deal.owner_id) === pick) {
      crm.log('Deal ' + deal.id + ' already belongs to user #' + pick + ' — rotation lands on the same owner.');
      return { skipped: true, reason: 'already_assigned', owner_id: pick };
    }
    await crm.updateDeal(deal.id, { owner_id: pick });
    crm.log('Round-robin assigned deal ' + deal.id + ' ("' + (deal.title || '') + '") to user #' + pick + ' (roster of ' + roster.length + ').');
    return { assigned: true, owner_id: pick, roster_size: roster.length };
  },
};`,
    },
  },
  {
    slug: 'round-robin-lead-assigner',
    name: 'Round-robin lead assignment',
    category: 'ops',
    icon: '🎡',
    summary:
      'Unowned leads age fastest — nobody\'s lead is nobody\'s job. The moment a lead arrives without an owner, this assigns one from your roster, rotating evenly by lead id. Set the roster in the CONFIG block at the top of the code; until you do, it rotates through the owners already working leads. Leads that arrive with an owner are left alone. In workspaces with the leads module off, it quietly does nothing.',
    tags: ['routing', 'leads', 'round-robin'],
    requiredConfig: ['owner_roster'],
    spec: {
      name: 'round-robin-lead-assigner',
      summary: 'On lead capture, assign an owner to unowned leads from a configured roster, rotating evenly by lead id.',
      triggerEvent: 'lead.created',
      triggerFilter: null,
      actions: [
        { kind: 'set_field', entity: 'lead', field: 'owner_user_id', value: 'next_in_rotation' },
      ],
      source_code: `// Assign unowned new leads round-robin across an owner roster.
// ── CONFIG ─────────────────────────────────────────────────────────────────
// Trigger filters only match events — they are not passed to this code — so
// edit these defaults here in the plugin editor.
var OWNER_IDS = []; // user ids to rotate through, e.g. [3, 7, 12].
                    // Left empty, the roster is derived from owners already
                    // holding leads in this workspace.
// ───────────────────────────────────────────────────────────────────────────
module.exports = {
  async run({ crm, input }) {
    var t = (input && input.trigger) || input || {};
    var rec = t.lead || t.record || t;
    var leadId = Number(rec.id || t.leadId || t.lead_id);
    if (!Number.isInteger(leadId) || leadId <= 0) return { skipped: true, reason: 'no_lead_id' };
    // Returns null when the leads module is disabled for this workspace —
    // degrade to a clean no-op either way.
    var lead = await crm.getLead(leadId);
    if (!lead) return { skipped: true, reason: 'lead_unavailable_or_module_disabled' };
    if (lead.owner_user_id != null) {
      crm.log('Lead ' + lead.id + ' already has owner #' + lead.owner_user_id + ' — leaving it alone.');
      return { skipped: true, reason: 'already_owned' };
    }
    var roster = OWNER_IDS.filter(function (n) { return Number.isInteger(n) && n > 0; });
    if (roster.length === 0) {
      var leads = await crm.listLeads({});
      var seen = {};
      for (var i = 0; i < leads.length && roster.length < 20; i++) {
        var o = leads[i].owner_user_id;
        if (o != null && !seen[o]) { seen[o] = true; roster.push(Number(o)); }
      }
    }
    if (roster.length === 0) {
      crm.log('No owner roster configured and no lead owners found to derive one. Edit OWNER_IDS in the plugin code.');
      return { skipped: true, reason: 'no_roster' };
    }
    var pick = roster[lead.id % roster.length];
    await crm.updateLead(lead.id, { owner_user_id: pick });
    crm.log('Round-robin assigned lead ' + lead.id + ' ("' + (lead.name || lead.email || '') + '") to user #' + pick + ' (roster of ' + roster.length + ').');
    return { assigned: true, owner_user_id: pick, roster_size: roster.length };
  },
};`,
    },
  },
  {
    slug: 'territory-assignment-rules',
    name: 'Territory assignment rules',
    category: 'ops',
    icon: '🗺️',
    summary:
      'Route new deals by rule instead of by memory: pipeline (deal type) and amount bands map to owners — enterprise deals to your closer, one board\'s deals to the rep who runs it. Define the rules in the CONFIG block at the top of the code (first match wins); until rules are set, the extension logs a reminder and changes nothing.',
    tags: ['routing', 'territory', 'assignment'],
    requiredConfig: ['territory_rules'],
    spec: {
      name: 'territory-assignment-rules',
      summary: 'On deal creation, assign the owner from configured deal-type / amount-band rules (first match wins).',
      triggerEvent: 'deal.created',
      triggerFilter: null,
      actions: [
        { kind: 'set_field', entity: 'deal', field: 'owner_id', value: 'rule_match' },
      ],
      source_code: `// Assign new deals to owners by deal-type / amount-band rules.
// ── CONFIG ─────────────────────────────────────────────────────────────────
// Trigger filters only match events — they are not passed to this code — so
// define your territory rules here in the plugin editor. First match wins.
// Each rule: { deal_type: 'default'|<pipeline slug>|null (any),
//              min_amount: number|null, max_amount: number|null,
//              owner_id: <user id> }
var RULES = [
  // { deal_type: null, min_amount: 50000, max_amount: null, owner_id: 3 },
  // { deal_type: 'billboards', min_amount: null, max_amount: null, owner_id: 7 },
];
// ───────────────────────────────────────────────────────────────────────────
module.exports = {
  async run({ crm, input }) {
    if (!Array.isArray(RULES) || RULES.length === 0) {
      crm.log('No territory rules configured yet. Edit RULES in the plugin code to start routing.');
      return { skipped: true, reason: 'no_rules_configured' };
    }
    var t = (input && input.trigger) || input || {};
    var rec = t.deal || t.record || t;
    var dealId = Number(rec.id || t.dealId || t.deal_id);
    if (!Number.isInteger(dealId) || dealId <= 0) return { skipped: true, reason: 'no_deal_id' };
    var deal = await crm.getDeal(dealId);
    if (!deal) return { skipped: true, reason: 'deal_not_found' };
    // deal_type comes from the trigger payload (the SDK read surface doesn't
    // include it); manual runs without a payload treat it as 'default'.
    var dealType = String(rec.deal_type || t.deal_type || 'default');
    var amount = Number(deal.amount != null ? deal.amount : rec.amount) || 0;
    var match = null;
    for (var i = 0; i < RULES.length; i++) {
      var r = RULES[i] || {};
      if (!(Number.isInteger(r.owner_id) && r.owner_id > 0)) continue;
      if (r.deal_type != null && String(r.deal_type) !== dealType) continue;
      if (r.min_amount != null && amount < Number(r.min_amount)) continue;
      if (r.max_amount != null && amount > Number(r.max_amount)) continue;
      match = r;
      break;
    }
    if (!match) {
      crm.log('No territory rule matched deal ' + deal.id + ' (type ' + dealType + ', $' + amount + ').');
      return { skipped: true, reason: 'no_rule_matched' };
    }
    if (deal.owner_id != null && Number(deal.owner_id) === match.owner_id) {
      return { skipped: true, reason: 'already_assigned', owner_id: match.owner_id };
    }
    await crm.updateDeal(deal.id, { owner_id: match.owner_id });
    crm.log('Territory rule assigned deal ' + deal.id + ' (type ' + dealType + ', $' + amount + ') to user #' + match.owner_id + '.');
    return { assigned: true, owner_id: match.owner_id };
  },
};`,
    },
  },
];
