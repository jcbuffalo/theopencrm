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
];
