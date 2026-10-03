#!/usr/bin/env node
/* TECH HUB SLICE 4F (hosting) — the web side of service leads & quotes (sokoni-leads.js + wiring).
 * Server authority: functions/service-leads.js (feat/tech-taxonomy-on-13f74f3 @ 906bd2f, test-service-leads 12/0).
 *   node scripts/test-service-leads-web.js
 * vm + minimal stubs (no jsdom in this repo); the real browser run is NOT done here (memory floor). */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 240) + ']')); ok ? pass++ : fail++; };
console.log('\nService leads — web (Tech Hub slice 4F)\n');

function load(src, signedIn) {
  const calls = [];
  let href = '';
  const els = {};
  const body = { appendChild: (n) => { els.modal = n; }, };
  const doc = {
    body, getElementById: (id) => (id === 'skLeadModal' ? els.modal || null : null),
    createElement: () => { const n = { style: {}, setAttribute() {}, addEventListener(t, f) { this['on' + t] = f; }, parentNode: body, _q: {} };
      Object.defineProperty(n, 'innerHTML', { set(v) { this._html = v; }, get() { return this._html; } });
      n.querySelector = (sel) => (n._q[sel] = n._q[sel] || { value: '', textContent: '', disabled: false, addEventListener(t, f) { this['on' + t] = f; } });
      return n; },
  };
  body.removeChild = () => { els.modal = null; };
  const win = {
    document: doc, alert: () => {}, prompt: () => 'q',
    location: { pathname: '/tech-hub.html', search: '', set href(v) { href = v; }, get href() { return href; } },
    firebase: { auth: () => ({ currentUser: signedIn ? { uid: 'cust' } : null }),
      functions: () => ({ httpsCallable: () => (data) => { calls.push(data); return Promise.resolve({ data: data.op === 'leadCreate' ? { leadId: 'L9' } : { leads: [] } }); } }) },
  };
  const ctx = { window: win, document: doc, console, setTimeout, Promise, encodeURIComponent };
  ctx.globalThis = ctx; win.window = win;
  vm.createContext(ctx); vm.runInContext(src, ctx);
  return { api: win.SokoniLeads, calls, href: () => href, els };
}
const SRC = read('sokoni-leads.js');

/* W1 customer card actions follow the server state, never ahead of it (a function, so the sabotage re-runs THIS row) */
function w1Condition(src) {
  const { api } = load(src, true);
  const acts = (st, q) => (api._internal.mineCard({ id: 'a', status: st, message: 'm', quote: q || null }).match(/data-lead-act="([a-z]+)"/g) || []).map((x) => x.split('"')[1]).sort().join();
  const q = { version: 1, amountCents: 150000, durationMins: 60, validUntil: Date.now() + 1e8 };
  return acts('quote_sent', q) === 'accept,clarify,close,decline,msg' && acts('quote_accepted', q) === 'book,close,msg' && acts('created') === 'close,msg' && acts('converted', q) === 'msg';
}
{
  const { api } = load(SRC, true);
  const acts = (st, q) => (api._internal.mineCard({ id: 'a', status: st, message: 'm', quote: q || null }).match(/data-lead-act="([a-z]+)"/g) || []).map((x) => x.split('"')[1]).sort().join();
  const q = { version: 1, amountCents: 150000, durationMins: 60, validUntil: Date.now() + 1e8 };
  ck('W1', acts('quote_sent', q) === 'accept,clarify,close,decline,msg' && acts('quote_accepted', q) === 'book,close,msg' && acts('created') === 'close,msg' && acts('converted', q) === 'msg',
    'customer actions per state: accept/clarify/decline only on a sent quote; Book only after acceptance; nothing after booking', { sent: acts('quote_sent', q), acc: acts('quote_accepted', q), conv: acts('converted', q) });
  const card = api._internal.mineCard({ id: 'a', status: 'quote_sent', message: '<img src=x onerror=1>', quote: Object.assign({}, q, { description: '<script>x</script>' }) });
  ck('W1b', !/<img|<script>/.test(card) && /KES 1,500/.test(card), 'customer text and quote text are escaped; the amount shown is the server amount', card.slice(0, 160));
}
/* W2 provider card actions */
{
  const { api } = load(SRC, true);
  const acts = (st) => (api._internal.provCard({ id: 'a', status: st, message: 'm' }).match(/data-plead-act="([a-z]+)"/g) || []).map((x) => x.split('"')[1]).sort().join();
  ck('W2', acts('created') === 'decline,msg,quote' && acts('quote_sent') === 'msg,quote' && acts('quote_accepted') === 'msg' && acts('declined') === 'msg',
    'provider actions per state: quote / decline while open, re-quote only before acceptance, nothing after', { created: acts('created'), sent: acts('quote_sent'), acc: acts('quote_accepted') });
}
/* W3 ask(): login first; the request goes to the server and nothing claims success before it answers */
(async () => {
  {
    const t = load(SRC, false);
    t.api.ask({ providerId: 'p1', providerName: 'Fix Ltd' });
    ck('W3a', /^login\.html\?next=/.test(t.href()) && t.calls.length === 0, 'a signed-out visitor is sent to sign in; nothing is sent', t.href());
  }
  {
    const t = load(SRC, true);
    t.api.ask({ providerId: 'p1', providerName: 'Fix Ltd' });
    const m = t.els.modal;
    m._q['#skLeadMsg'] = { value: 'My screen is cracked please help' };
    const before = t.href();
    m.querySelector('#skLeadSend').onclick.call(m.querySelector('#skLeadSend'));
    const mid = t.href();
    await new Promise((r) => setTimeout(r, 10));
    ck('W3b', t.calls.length === 1 && t.calls[0].op === 'leadCreate' && t.calls[0].providerId === 'p1' && !('price' in t.calls[0]) && before === '' && mid === ''
      && t.href() === 'messages.html?tx=service_lead&txId=L9',
      'the request is a leadCreate call (no price); only AFTER the server answers does it open the lead conversation', { calls: t.calls, href: t.href() });
  }

  /* W4 wiring */
  const bs = read('sokoni-book-service.js'), mh = read('messages.html'), ib = read('sokoni-inbox.js'), dir = read('sokoni-tech-directory.js'),
    pd = read('provider-dashboard.html'), sr = read('service-requests.html'), pp = read('provider-profile.html');
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
  ck('W4a', bs.includes('if (_ctx.leadId) return create();') && bs.includes('leadId: _ctx.leadId || undefined'), 'booking an accepted quote skips options and sends only the leadId (price applied server-side)');
  ck('W4b', mh.includes("['service_booking','service_lead','order']") && ib.includes("'service_lead'") && dir.includes('G.SokoniLeads.ask({ providerId: p.uid'),
    'a lead conversation opens in messages; a directory "Message" asks the provider (creates the lead)');
  ck('W4c', /data-hc-module="leads" hidden/.test(pd) && pd.includes('id="panel-leads"') && pd.includes('SokoniLeads.mountProvider(') && pd.includes('src="sokoni-leads.js"'),
    'provider-dashboard: Leads & quotes is hidden until the server makes `leads` AVAILABLE');
  ck('W4d', sr.includes('src="sw-register.js"') && sr.includes('SokoniLeads.mountMine(') && sr.includes('data-require-auth="true"'),
    'service-requests.html self-updates (sw-register), requires sign-in and lists the customer\'s leads');
  ck('W4e', !/wa\.me|bookNow\(/.test(strip(pp)) && pp.includes('SokoniLeads.ask(') && pp.includes('src="sokoni-leads.js"'),
    'the storefront asks through a lead; no WhatsApp hand-off and no retired pay-now fallback');
  ck('W4f', ['phone-repair.html', 'electrical.html', 'tech-hub.html', 'providers.html'].every((f) => read(f).includes('src="sokoni-leads.js"')),
    'every Tech listing page loads the lead module');

  /* sabotage: Book offered before acceptance */
  {
    const bad = SRC.replace("if (l.status === 'quote_accepted') acts.push(['book'", "if (l.status === 'quote_sent' || l.status === 'quote_accepted') acts.push(['book'");
    /* counted only if the W1 row's own condition flips: true on the real source, false on the sabotaged one */
    const red = bad !== SRC && w1Condition(SRC) === true && w1Condition(bad) === false;
    console.log('\n  [sabotage] ' + (red ? 'CAUGHT' : 'MISSED') + '  Book offered on an unaccepted quote → row W1 fails');
    if (!red) fail++;
  }
  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  console.log('NOT proven here: a real browser run (memory floor) and a live lead → quote → booking → IntaSend payment.');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH (no verdict): ' + (e && e.stack || e)); process.exit(2); });
