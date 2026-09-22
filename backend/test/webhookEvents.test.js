// Spec 206 part 3 — outbound webhook event catalogue. Structural parity:
// every event the API accepts on a subscription is (a) offered in the
// Developer settings UI and (b) actually dispatched from at least one route.
const fs = require('fs');
const path = require('path');

const ROUTES = path.join(__dirname, '..', 'routes');
const FE = path.join(__dirname, '..', '..', 'frontend', 'src', 'pages', 'DeveloperSettings.js');

function knownEvents() {
  const src = fs.readFileSync(path.join(ROUTES, 'outboundWebhookRoutes.js'), 'utf8');
  const m = /const KNOWN_EVENTS = \[([\s\S]*?)\];/.exec(src);
  return [...m[1].matchAll(/'([a-z_.]+)'/g)].map((x) => x[1]);
}

describe('outbound webhook events', () => {
  const events = knownEvents();

  test('the catalogue covers the CRM lifecycle a CLI needs to react to', () => {
    expect(events).toEqual(expect.arrayContaining([
      'deal.created', 'deal.updated', 'deal.stage_changed',
      'contact.created', 'company.created', 'activity.logged',
      'task.completed', 'lead.captured', 'ping',
    ]));
  });

  test('every non-ping event is dispatched from a route', () => {
    const files = fs.readdirSync(ROUTES).filter((f) => f.endsWith('.js'));
    const src = files.map((f) => fs.readFileSync(path.join(ROUTES, f), 'utf8')).join('\n');
    for (const ev of events.filter((e) => e !== 'ping')) {
      expect(src, ev).toMatch(new RegExp(`dispatch\\([^)]*'${ev.replace('.', '\\.')}'`));
    }
  });

  test('the Developer settings UI offers exactly the non-ping events', () => {
    const fe = fs.readFileSync(FE, 'utf8');
    const m = /const WEBHOOK_EVENTS = \[([\s\S]*?)\];/.exec(fe);
    const ui = [...m[1].matchAll(/'([a-z_.]+)'/g)].map((x) => x[1]).sort();
    expect(ui).toEqual(events.filter((e) => e !== 'ping').sort());
  });
});
