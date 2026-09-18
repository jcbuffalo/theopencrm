// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Curated library — REPORTING / DIGEST entries. See ./index.js for the
// authoring contract. Digests land as a single task (the in-app inbox every
// org has) rather than claiming email delivery the sandbox cannot perform;
// AI entries embed a ready-to-run copilot brief so they work without AI and
// get one-click narratives with it.

module.exports = [
  // --------------------------------------------------------------------------
  // EXISTING ENTRY — do not modify (moved verbatim from pluginLibrary.js).
  // --------------------------------------------------------------------------
  {
    slug: 'stalled-deal-digest',
    name: 'Daily stalled-deal digest',
    category: 'reporting',
    icon: '📊',
    summary:
      'Every weekday at 9am, find deals with no activity in 30+ days and email a summary to the sales lead. Each deal includes its current stage, customer, and last touch.',
    tags: ['digest', 'email', 'cadence'],
    spec: {
      name: 'stalled-deal-digest',
      summary: 'Daily 9am digest of deals with no activity in 30+ days. Emailed to the sales lead.',
      triggerEvent: 'schedule.daily',
      triggerFilter: { cron: '0 9 * * 1-5' },
      actions: [
        {
          kind: 'send_email',
          to: '__SALES_LEAD_EMAIL__',
          subject_template: 'Stalled deals ({count}) — {today}',
          body_template:
            'These deals have had no activity in 30+ days:\n\n{deals_list}\n\nReview at https://app.theopencrm.com/deals',
        },
      ],
    },
    requiredConfig: ['sales_lead_email'],
  },

  // --------------------------------------------------------------------------
  // NEW ENTRIES
  // --------------------------------------------------------------------------
  {
    slug: 'monday-pipeline-brief',
    name: 'Monday pipeline brief',
    category: 'reporting',
    icon: '🌅',
    summary:
      'Start the week knowing exactly where the pipeline stands. Every Monday morning this computes your open pipeline by stage, the probability-weighted total, deals expected to close in the next 14 days, and your three biggest open deals — then files it as a single brief task, complete with a copilot prompt that turns the numbers into a team-ready narrative in one click.',
    tags: ['digest', 'pipeline', 'ai'],
    spec: {
      name: 'monday-pipeline-brief',
      summary: 'Monday-morning task with pipeline by stage, weighted total, next-14-day closers, top deals, and an AI narrative brief.',
      triggerEvent: 'schedule.daily',
      triggerFilter: { cron: '0 8 * * 1' },
      actions: [
        { kind: 'create_task', title_template: 'Monday pipeline brief — {today}', due_in_days: 0 },
        {
          kind: 'claude_complete',
          prompt_template:
            'Turn these pipeline numbers into a five-sentence Monday briefing for the sales team. Lead with the weighted total, call out what closes this fortnight, and end with the single most important focus. Numbers: {stats}',
          store_as: 'narrative',
        },
      ],
      source_code: `// Assemble the Monday-morning pipeline brief as a single task.
module.exports = {
  async run({ crm }) {
    var deals = await crm.listDeals({ status: 'open' });
    var byStage = {};
    var total = 0;
    var weighted = 0;
    var soon = [];
    var now = Date.now();
    var horizon = now + 14 * 86400000;
    for (var i = 0; i < deals.length; i++) {
      var d = deals[i];
      var amount = Number(d.amount) || 0;
      var stage = d.stage || '(no stage)';
      if (!byStage[stage]) byStage[stage] = { count: 0, amount: 0 };
      byStage[stage].count++;
      byStage[stage].amount += amount;
      total += amount;
      var p = d.probability == null ? 0.5 : Number(d.probability);
      if (p > 1) p = p / 100;
      if (!(p >= 0 && p <= 1)) p = 0.5;
      weighted += amount * p;
      if (d.expected_close_date) {
        var t = new Date(d.expected_close_date).getTime();
        if (t >= now - 86400000 && t <= horizon) soon.push(d);
      }
    }
    var stageLines = Object.keys(byStage).map(function (s) {
      return '- ' + s + ': ' + byStage[s].count + ' deal(s), $' + Math.round(byStage[s].amount);
    });
    var top = deals.slice().sort(function (a, b) { return (Number(b.amount) || 0) - (Number(a.amount) || 0); })
      .slice(0, 3).map(function (d) { return '- ' + (d.title || ('#' + d.id)) + ': $' + Math.round(Number(d.amount) || 0) + ' [' + d.stage + ']'; });
    var soonLines = soon.slice(0, 5).map(function (d) {
      return '- ' + (d.title || ('#' + d.id)) + ' ($' + Math.round(Number(d.amount) || 0) + ') expected ' + String(d.expected_close_date).slice(0, 10);
    });
    var today = new Date().toISOString().slice(0, 10);
    var stats = 'Open deals: ' + deals.length + '. Total: $' + Math.round(total) + '. Weighted: $' + Math.round(weighted) +
      '. Closing in 14 days: ' + soon.length + '.';
    await crm.createTask({
      title: 'Monday pipeline brief — ' + today,
      description: stats + '\\n' +
        'By stage:\\n' + (stageLines.join('\\n') || '- (empty pipeline)') + '\\n' +
        'Expected to close in the next 14 days:\\n' + (soonLines.join('\\n') || '- none') + '\\n' +
        'Biggest open deals:\\n' + (top.join('\\n') || '- none') + '\\n' +
        'Copilot brief (paste into chat for a team-ready narrative): Turn these pipeline numbers into a five-sentence Monday briefing. ' + stats,
      due_date: today,
      priority: 'medium',
    });
    crm.log(stats);
    return { open: deals.length, total: Math.round(total), weighted: Math.round(weighted), closing_14d: soon.length };
  },
};`,
    },
  },
  {
    slug: 'new-business-daily-digest',
    name: 'Daily new-business digest',
    category: 'reporting',
    icon: '🆕',
    summary:
      'One glance at everything new since yesterday: deals, contacts, and companies created in the last 24 hours, rolled into a single end-of-day digest task with names and deal amounts. Quiet days create nothing — you only hear about it when there is actually news.',
    tags: ['digest', 'daily', 'new-business'],
    spec: {
      name: 'new-business-daily-digest',
      summary: 'End-of-day digest task of deals, contacts, and companies created in the last 24 hours; skips quiet days.',
      triggerEvent: 'schedule.daily',
      triggerFilter: { cron: '0 17 * * 1-5' },
      actions: [
        { kind: 'create_task', title_template: 'New business today: {counts}', due_in_days: 0 },
      ],
      source_code: `// Digest of records created in the last 24 hours. Skips quiet days.
module.exports = {
  async run({ crm }) {
    var cutoff = Date.now() - 86400000;
    function fresh(rows) {
      return rows.filter(function (r) { return r.created_at && new Date(r.created_at).getTime() >= cutoff; });
    }
    var deals = fresh(await crm.listDeals({}));
    var contacts = fresh(await crm.listContacts({}));
    var companies = fresh(await crm.listCompanies({}));
    if (deals.length === 0 && contacts.length === 0 && companies.length === 0) {
      crm.log('No new deals, contacts, or companies in the last 24 hours.');
      return { new_deals: 0, new_contacts: 0, new_companies: 0 };
    }
    var dealLines = deals.slice(0, 5).map(function (d) {
      return '- ' + (d.title || ('#' + d.id)) + (d.amount ? ' ($' + Math.round(Number(d.amount)) + ')' : '');
    });
    var contactLines = contacts.slice(0, 5).map(function (c) {
      return '- ' + ([c.first_name, c.last_name].filter(Boolean).join(' ') || ('contact #' + c.id));
    });
    var companyLines = companies.slice(0, 5).map(function (c) { return '- ' + (c.name || ('company #' + c.id)); });
    var today = new Date().toISOString().slice(0, 10);
    await crm.createTask({
      title: 'New business today: ' + deals.length + ' deal(s), ' + contacts.length + ' contact(s), ' + companies.length + ' compan' + (companies.length === 1 ? 'y' : 'ies'),
      description: 'Created in the last 24 hours:\\n' +
        'Deals (' + deals.length + '):\\n' + (dealLines.join('\\n') || '- none') + '\\n' +
        'Contacts (' + contacts.length + '):\\n' + (contactLines.join('\\n') || '- none') + '\\n' +
        'Companies (' + companies.length + '):\\n' + (companyLines.join('\\n') || '- none'),
      due_date: today,
      priority: 'low',
    });
    crm.log('New in 24h: ' + deals.length + ' deals, ' + contacts.length + ' contacts, ' + companies.length + ' companies.');
    return { new_deals: deals.length, new_contacts: contacts.length, new_companies: companies.length };
  },
};`,
    },
  },
  {
    slug: 'month-end-win-recap',
    name: 'Month-end closed-won recap',
    category: 'reporting',
    icon: '🏆',
    summary:
      'On the first of each month, this tallies last month\'s closed-won deals — count, total value, and the top five wins — into a recap task, with a copilot brief that turns it into a celebratory summary you can drop straight into your team channel or investor update. Months with zero wins log quietly instead of creating an empty recap.',
    tags: ['digest', 'wins', 'ai'],
    spec: {
      name: 'month-end-win-recap',
      summary: 'First-of-month recap task of the prior month\'s closed-won deals, with an AI brief for a shareable narrative.',
      triggerEvent: 'schedule.daily',
      triggerFilter: { cron: '0 9 1 * *' },
      actions: [
        { kind: 'create_task', title_template: 'Closed-won recap — {month}', due_in_days: 0 },
        {
          kind: 'claude_complete',
          prompt_template:
            'Write a short, upbeat monthly wins recap for the team from these numbers: {stats}. Three sentences, name the biggest win, end with momentum for next month.',
          store_as: 'narrative',
        },
      ],
      source_code: `// Recap the prior calendar month's closed-won deals into one task.
module.exports = {
  async run({ crm }) {
    var now = new Date();
    var monthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime();
    var monthEnd = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    var won = await crm.listDeals({ stage: 'CLOSED_WON' });
    // expected_close_date is the closest thing to a close date the SDK
    // exposes; fall back to updated_at (the stage move touched the row).
    var wins = won.filter(function (d) {
      var ref = d.expected_close_date || d.updated_at;
      if (!ref) return false;
      var t = new Date(ref).getTime();
      return t >= monthStart && t < monthEnd;
    });
    if (wins.length === 0) {
      crm.log('No closed-won deals last month. Skipping recap task.');
      return { wins: 0 };
    }
    var total = 0;
    for (var i = 0; i < wins.length; i++) total += Number(wins[i].amount) || 0;
    var top = wins.slice().sort(function (a, b) { return (Number(b.amount) || 0) - (Number(a.amount) || 0); })
      .slice(0, 5).map(function (d) { return '- ' + (d.title || ('#' + d.id)) + ': $' + Math.round(Number(d.amount) || 0); });
    var monthName = new Date(monthStart).toISOString().slice(0, 7);
    var stats = wins.length + ' deal(s) closed won in ' + monthName + ' for $' + Math.round(total) + ' total.';
    var today = new Date().toISOString().slice(0, 10);
    await crm.createTask({
      title: 'Closed-won recap — ' + monthName,
      description: stats + '\\nTop wins:\\n' + top.join('\\n') + '\\n' +
        'Copilot brief (paste into chat for a shareable recap): Write a short, upbeat monthly wins recap from these numbers. ' + stats,
      due_date: today,
      priority: 'low',
    });
    crm.log(stats);
    return { wins: wins.length, total: Math.round(total) };
  },
};`,
    },
  },
  {
    slug: 'task-load-balance',
    name: 'Task-load balance report',
    category: 'reporting',
    icon: '🧮',
    summary:
      'See who is drowning and who has headroom before it shows up in missed follow-ups. Every Monday this counts open tasks per assignee — with overdue counts called out — and files a single balance report task, flagging the heaviest and lightest loads so reassignment is a two-minute decision instead of a quarterly surprise.',
    tags: ['digest', 'tasks', 'workload'],
    spec: {
      name: 'task-load-balance',
      summary: 'Weekly digest task of open-task counts (and overdue counts) per assignee, flagging heaviest and lightest.',
      triggerEvent: 'schedule.daily',
      triggerFilter: { cron: '0 8 * * 1' },
      actions: [
        { kind: 'create_task', title_template: 'Task-load balance report — {today}', due_in_days: 0 },
      ],
      source_code: `// Weekly open-task workload report by assignee.
module.exports = {
  async run({ crm }) {
    var tasks = await crm.listTasks({ status: 'open' });
    if (tasks.length === 0) {
      crm.log('No open tasks — nothing to balance.');
      return { open_tasks: 0 };
    }
    var today = new Date().toISOString().slice(0, 10);
    var byAssignee = {};
    for (var i = 0; i < tasks.length; i++) {
      var t = tasks[i];
      var key = t.assigned_to == null ? 'unassigned' : ('user #' + t.assigned_to);
      if (!byAssignee[key]) byAssignee[key] = { open: 0, overdue: 0 };
      byAssignee[key].open++;
      if (t.due_date && String(t.due_date).slice(0, 10) < today) byAssignee[key].overdue++;
    }
    var keys = Object.keys(byAssignee);
    keys.sort(function (a, b) { return byAssignee[b].open - byAssignee[a].open; });
    var lines = keys.map(function (k) {
      var v = byAssignee[k];
      return '- ' + k + ': ' + v.open + ' open' + (v.overdue ? ' (' + v.overdue + ' overdue)' : '');
    });
    var heaviest = keys[0];
    var lightest = keys[keys.length - 1];
    await crm.createTask({
      title: 'Task-load balance report — ' + today,
      description: 'Open tasks by assignee:\\n' + lines.join('\\n') + '\\n' +
        (keys.length > 1
          ? 'Heaviest load: ' + heaviest + '. Lightest: ' + lightest + '. Consider rebalancing before the overdue column grows.'
          : 'Only one bucket — nothing to rebalance.'),
      due_date: today,
      priority: 'low',
    });
    crm.log('Task load across ' + keys.length + ' assignee bucket(s); ' + tasks.length + ' open tasks.');
    return { open_tasks: tasks.length, assignees: keys.length };
  },
};`,
    },
  },
];
