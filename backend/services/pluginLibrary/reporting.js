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
      'Start the week knowing exactly where the pipeline stands. Every Monday morning this computes your open pipeline by stage, the probability-weighted total, deals expected to close in the next 14 days, and your three biggest open deals — then files it as a single brief task. With AI enabled, the team-ready narrative is written right into the task (metered per-org); without it, the task carries a copilot prompt that does the same in chat.',
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
    // Metered in-run AI: write the team-ready narrative now; fall back to
    // embedding the copilot prompt when AI is unconfigured or blocked.
    var narrative = null;
    var ai = await crm.ai.complete({
      prompt: 'Turn these pipeline numbers into a five-sentence Monday briefing for the sales team. ' +
        'Lead with the weighted total, call out what closes this fortnight, and end with the single most important focus. No preamble.\\n' +
        'Numbers: ' + stats + '\\nBy stage:\\n' + (stageLines.join('\\n') || '- (empty pipeline)') +
        '\\nClosing in 14 days:\\n' + (soonLines.join('\\n') || '- none') +
        '\\nBiggest open deals:\\n' + (top.join('\\n') || '- none'),
      max_tokens: 400,
    });
    if (ai && ai.ok && ai.text) narrative = ai.text;
    await crm.createTask({
      title: 'Monday pipeline brief — ' + today,
      description: stats + '\\n' +
        'By stage:\\n' + (stageLines.join('\\n') || '- (empty pipeline)') + '\\n' +
        'Expected to close in the next 14 days:\\n' + (soonLines.join('\\n') || '- none') + '\\n' +
        'Biggest open deals:\\n' + (top.join('\\n') || '- none') + '\\n' +
        (narrative
          ? 'AI briefing:\\n' + narrative
          : 'Copilot brief (paste into chat for a team-ready narrative): Turn these pipeline numbers into a five-sentence Monday briefing. ' + stats),
      due_date: today,
      priority: 'medium',
    });
    crm.log(stats + ' AI briefing: ' + (narrative ? 'yes' : 'no'));
    return { open: deals.length, total: Math.round(total), weighted: Math.round(weighted), closing_14d: soon.length, ai_drafted: !!narrative };
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
      'On the first of each month, this tallies last month\'s closed-won deals — count, total value, and the top five wins — into a recap task. With AI enabled, the celebratory summary is written right into the task, ready to drop into your team channel or investor update (metered per-org); without it, the task carries the copilot brief to draft it in chat. Months with zero wins log quietly instead of creating an empty recap.',
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
    // Metered in-run AI: write the shareable recap now; fall back to the
    // copilot prompt when AI is unconfigured or blocked.
    var recap = null;
    var ai = await crm.ai.complete({
      prompt: 'Write a short, upbeat monthly wins recap for the team from these numbers. ' +
        'Three sentences, name the biggest win, end with momentum for next month. No preamble.\\n' +
        stats + '\\nTop wins:\\n' + top.join('\\n'),
      max_tokens: 300,
    });
    if (ai && ai.ok && ai.text) recap = ai.text;
    await crm.createTask({
      title: 'Closed-won recap — ' + monthName,
      description: stats + '\\nTop wins:\\n' + top.join('\\n') + '\\n' +
        (recap
          ? 'AI recap (ready to share):\\n' + recap
          : 'Copilot brief (paste into chat for a shareable recap): Write a short, upbeat monthly wins recap from these numbers. ' + stats),
      due_date: today,
      priority: 'low',
    });
    crm.log(stats + ' AI recap: ' + (recap ? 'yes' : 'no'));
    return { wins: wins.length, total: Math.round(total), ai_drafted: !!recap };
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

  // --------------------------------------------------------------------------
  // WAVE 2 (2026-09) — AI scoring & pattern analysis. Heuristic math runs
  // in-sandbox; crm.ai.complete (metered, max 2/run — these use 1) adds the
  // qualitative layer and every entry degrades to a copilot brief without it.
  // --------------------------------------------------------------------------
  {
    slug: 'ai-deal-scorer',
    name: 'AI deal risk scores',
    category: 'reporting',
    icon: '🎯',
    summary:
      'Every CRM sells deal scoring; most of what makes a deal risky is arithmetic you already have. This scores each open deal daily on staleness, an overdue or missing close date, missing amount or contact, and late-stage drift, then files one review task with the ten riskiest and why each scored what it did. With AI enabled, one metered call adds a qualitative read on the top three; without it, the task carries the copilot brief. (Scores live in the task — the SDK has no custom-field write surface.)',
    tags: ['scoring', 'risk', 'ai'],
    spec: {
      name: 'ai-deal-scorer',
      summary: 'Daily heuristic risk score (0–100) across open deals; one review task with the top 10 and an AI read on the top 3.',
      triggerEvent: 'schedule.daily',
      triggerFilter: { cron: '0 8 * * 1-5' },
      actions: [
        { kind: 'create_task', title_template: 'Deal risk review — {today}', due_in_days: 0 },
        {
          kind: 'claude_complete',
          prompt_template:
            'Give a two-sentence risk read on each of these three deals (numbers provided): {top3}. Be blunt about which one is most likely to die.',
          store_as: 'risk_read',
        },
      ],
      source_code: `// Score open deals for risk and file one review task with the worst.
module.exports = {
  async run({ crm }) {
    var deals = await crm.listDeals({ status: 'open' });
    if (deals.length === 0) {
      crm.log('No open deals to score.');
      return { scored: 0 };
    }
    var now = Date.now();
    var today = new Date().toISOString().slice(0, 10);
    var LATE = { PROPOSAL: true, NEGOTIATION: true, PITCH: true, ENGAGED: true };
    var scored = deals.map(function (d) {
      var score = 0;
      var why = [];
      var last = new Date(d.last_activity_at || d.updated_at || d.created_at || 0).getTime();
      var quiet = last ? Math.floor((now - last) / 86400000) : 999;
      if (quiet >= 30) { score += 40; why.push(quiet + 'd silent'); }
      else if (quiet >= 14) { score += 25; why.push(quiet + 'd silent'); }
      else if (quiet >= 7) { score += 10; why.push(quiet + 'd silent'); }
      if (!d.expected_close_date) { score += 15; why.push('no close date'); }
      else if (String(d.expected_close_date).slice(0, 10) < today) { score += 25; why.push('close date passed'); }
      if (!d.amount) { score += 10; why.push('no amount'); }
      if (!d.contact_id) { score += 10; why.push('no contact'); }
      if (LATE[String(d.stage || '').toUpperCase()] && quiet >= 14) { score += 15; why.push('late-stage drift'); }
      return { d: d, score: Math.min(100, score), why: why };
    });
    scored.sort(function (a, b) { return b.score - a.score; });
    var top = scored.slice(0, 10);
    var lines = top.map(function (s) {
      return '- [' + s.score + '/100] ' + (s.d.title || ('#' + s.d.id)) + ' (' + s.d.stage +
        (s.d.amount ? ', $' + Math.round(Number(s.d.amount)) : '') + ')' +
        (s.why.length ? ' — ' + s.why.join(', ') : '');
    });
    var top3 = scored.slice(0, 3).map(function (s) {
      return (s.d.title || ('#' + s.d.id)) + ' [' + s.score + '/100: ' + s.why.join(', ') + ']';
    }).join('; ');
    var brief = 'Give a two-sentence risk read on each of these three deals: ' + top3 +
      '. Be blunt about which one is most likely to die and what would save it.';
    var read = null;
    var ai = await crm.ai.complete({ prompt: brief + ' No preamble.', max_tokens: 350 });
    if (ai && ai.ok && ai.text) read = ai.text;
    await crm.createTask({
      title: 'Deal risk review — ' + today,
      description: 'Riskiest open deals (heuristic 0-100: silence, close-date trouble, missing fields, late-stage drift):\\n' +
        lines.join('\\n') + '\\n' +
        (read
          ? 'AI risk read on the top 3:\\n' + read
          : 'Copilot brief (paste into chat for a qualitative read): ' + brief),
      due_date: today,
      priority: top.length && top[0].score >= 60 ? 'high' : 'medium',
    });
    crm.log('Scored ' + deals.length + ' open deals; top risk ' + (top.length ? top[0].score : 0) + '/100. AI read: ' + (read ? 'yes' : 'no'));
    return { scored: deals.length, top_score: top.length ? top[0].score : 0, ai_drafted: !!read };
  },
};`,
    },
  },
  {
    slug: 'next-best-action-feed',
    name: 'Next-best-action feed',
    category: 'reporting',
    icon: '🧭',
    summary:
      'The agent-platform pitch, without the per-seat SKU: every morning this picks the five open deals most in need of attention — silent too long, close date slipping past, late stage with no momentum — and files one feed task. With AI enabled, one metered call writes a specific next action for each of the five; without it, each deal gets the heuristic reason it made the list plus a copilot brief for the narrative.',
    tags: ['daily', 'actions', 'ai'],
    spec: {
      name: 'next-best-action-feed',
      summary: 'Daily task listing the 5 most at-risk open deals with an AI-written next action for each (single metered call).',
      triggerEvent: 'schedule.daily',
      triggerFilter: { cron: '0 8 * * 1-5' },
      actions: [
        { kind: 'create_task', title_template: 'Next best actions — {today}', due_in_days: 0 },
        {
          kind: 'claude_complete',
          prompt_template:
            'For each of these five deals, write ONE specific next action (call, send, book, escalate — a verb and a target). Deals: {deals}',
          store_as: 'actions',
        },
      ],
      source_code: `// Pick the five deals most in need of attention and feed next actions.
module.exports = {
  async run({ crm }) {
    var deals = await crm.listDeals({ status: 'open' });
    if (deals.length === 0) {
      crm.log('No open deals — no actions to feed.');
      return { picked: 0 };
    }
    var now = Date.now();
    var today = new Date().toISOString().slice(0, 10);
    var ranked = deals.map(function (d) {
      var last = new Date(d.last_activity_at || d.updated_at || d.created_at || 0).getTime();
      var quiet = last ? Math.floor((now - last) / 86400000) : 999;
      var urgency = quiet;
      if (d.expected_close_date && String(d.expected_close_date).slice(0, 10) < today) urgency += 20;
      if (d.hot_flag) urgency += 10;
      return { d: d, quiet: quiet, urgency: urgency };
    }).sort(function (a, b) { return b.urgency - a.urgency; }).slice(0, 5);
    var dealLines = ranked.map(function (r) {
      return '- ' + (r.d.title || ('#' + r.d.id)) + ' (' + r.d.stage +
        (r.d.amount ? ', $' + Math.round(Number(r.d.amount)) : '') + ', ' + r.quiet + 'd since activity' +
        (r.d.expected_close_date && String(r.d.expected_close_date).slice(0, 10) < today ? ', close date passed' : '') + ')';
    });
    var brief = 'For each of these five deals, write ONE specific next action — a verb and a target ' +
      '(call X, send Y, book Z, escalate to W). One line per deal, same order.\\nDeals:\\n' + dealLines.join('\\n');
    var actions = null;
    var ai = await crm.ai.complete({ prompt: brief + '\\nNo preamble.', max_tokens: 350 });
    if (ai && ai.ok && ai.text) actions = ai.text;
    await crm.createTask({
      title: 'Next best actions — ' + today,
      description: 'The five open deals most in need of attention today:\\n' + dealLines.join('\\n') + '\\n' +
        (actions
          ? 'AI next actions (one per deal):\\n' + actions
          : 'Copilot brief (paste into chat for one action per deal): ' + 'For each of these five deals, write one specific next action.'),
      due_date: today,
      priority: 'high',
    });
    crm.log('Next-best-action feed: 5 of ' + deals.length + ' open deals. AI actions: ' + (actions ? 'yes' : 'no'));
    return { picked: ranked.length, ai_drafted: !!actions };
  },
};`,
    },
  },
  {
    slug: 'win-loss-pattern-memo',
    name: 'Monthly win/loss pattern memo',
    category: 'reporting',
    icon: '🔬',
    summary:
      'Individual loss notes are anecdotes; a month of them is a pattern. On the first of each month this gathers the prior month\'s closed deals — win rate, values won and lost, the biggest of each — and files a memo task. With AI enabled, one metered call turns the numbers into a short what-changed-and-why memo; without it, the task carries the stats and a copilot brief. Months with no closed deals log quietly and skip.',
    tags: ['win-loss', 'monthly', 'ai'],
    spec: {
      name: 'win-loss-pattern-memo',
      summary: 'First-of-month memo task on last month\'s wins and losses (win rate, values, biggest of each) with an AI pattern memo.',
      triggerEvent: 'schedule.daily',
      triggerFilter: { cron: '0 9 1 * *' },
      actions: [
        { kind: 'create_task', title_template: 'Win/loss memo — {month}', due_in_days: 1 },
        {
          kind: 'claude_complete',
          prompt_template:
            'Write a short win/loss pattern memo from these numbers: {stats}. Three paragraphs max: what won, what lost, what to change this month.',
          store_as: 'memo',
        },
      ],
      source_code: `// First-of-month win/loss pattern memo over the prior month's closes.
module.exports = {
  async run({ crm, input }) {
    var t = (input && input.trigger) || input || {};
    var ref = t.date ? new Date(String(t.date)) : new Date();
    if (ref.getUTCDate() !== 1) {
      crm.log('Not the first of the month — the win/loss memo runs monthly.');
      return { skipped: true, reason: 'not_first_of_month' };
    }
    var monthStart = Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() - 1, 1);
    var monthEnd = Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), 1);
    function inMonth(d) {
      var refDate = d.expected_close_date || d.updated_at;
      if (!refDate) return false;
      var x = new Date(refDate).getTime();
      return x >= monthStart && x < monthEnd;
    }
    function stageIs(name) {
      return function (d) { return String(d.stage || '').toUpperCase() === name && inMonth(d); };
    }
    var won = (await crm.listDeals({ stage: 'CLOSED_WON' })).filter(stageIs('CLOSED_WON'));
    var lost = (await crm.listDeals({ stage: 'CLOSED_LOST' })).filter(stageIs('CLOSED_LOST'));
    if (won.length === 0 && lost.length === 0) {
      crm.log('No deals closed last month. Skipping the memo.');
      return { wins: 0, losses: 0 };
    }
    function sum(rows) { var s = 0; for (var i = 0; i < rows.length; i++) s += Number(rows[i].amount) || 0; return s; }
    function biggest(rows) {
      var b = null;
      for (var i = 0; i < rows.length; i++) if (!b || (Number(rows[i].amount) || 0) > (Number(b.amount) || 0)) b = rows[i];
      return b;
    }
    var winRate = Math.round((won.length / (won.length + lost.length)) * 100);
    var monthName = new Date(monthStart).toISOString().slice(0, 7);
    var bw = biggest(won);
    var bl = biggest(lost);
    var stats = monthName + ': ' + won.length + ' won ($' + Math.round(sum(won)) + '), ' +
      lost.length + ' lost ($' + Math.round(sum(lost)) + '), win rate ' + winRate + '%.' +
      (bw ? ' Biggest win: "' + (bw.title || ('#' + bw.id)) + '" ($' + Math.round(Number(bw.amount) || 0) + ').' : '') +
      (bl ? ' Biggest loss: "' + (bl.title || ('#' + bl.id)) + '" ($' + Math.round(Number(bl.amount) || 0) + ').' : '');
    var brief = 'Write a short win/loss pattern memo from these numbers: ' + stats +
      ' Three paragraphs max: what won, what lost, what to change this month.';
    var memo = null;
    var ai = await crm.ai.complete({ prompt: brief + ' No preamble.', max_tokens: 450 });
    if (ai && ai.ok && ai.text) memo = ai.text;
    var due = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    await crm.createTask({
      title: 'Win/loss memo — ' + monthName + ' (' + winRate + '% win rate)',
      description: stats + '\\n' +
        (memo
          ? 'AI pattern memo (review, then share with the team):\\n' + memo
          : 'Copilot brief (paste into chat to write the memo): ' + brief),
      due_date: due,
      priority: 'medium',
    });
    crm.log(stats + ' AI memo: ' + (memo ? 'yes' : 'no'));
    return { wins: won.length, losses: lost.length, win_rate: winRate, ai_drafted: !!memo };
  },
};`,
    },
  },
];
