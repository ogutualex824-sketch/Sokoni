#!/usr/bin/env node
/* merchant-v2 PROVIDER money (Payments / Receipts / Plan) — sokoni-merchant-provider-money.js in a VM with a DOM stub and
 * recorded server calls (no browser — memory floor) + the REAL route registry.
 * Proves: every figure is the server's (providerLedger), an unreadable figure is "—" never 0; withdrawal is DISABLED (the
 * canonical wallet path is frozen) and no payout op is ever called; receipts are the canonical records for role:'provider';
 * a plan is bought only through createPaymentIntent {planId, billingCycle:'monthly'} when editable, never unlocked by the
 * page; the routes are provider-only and gated on module:earnings / module:subscription.
 *   node scripts/test-merchant-provider-money.js            SABOTAGE=1 → every mutation must turn its named row FAIL */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), cp = require('child_process'), os = require('os');
const ROOT = path.join(__dirname, '..');

if (process.env.SABOTAGE) {
  const M = [
    ['Y1', 'sokoni-merchant-provider-money.js', "  const kesW = (k) => (k == null ? '—' :", "  const kesW = (k) => (k == null ? 'KES 0' :"],
    ['Y2', 'sokoni-merchant-provider-money.js', 'disabled aria-disabled="true">Withdraw — coming soon', 'data-withdraw>Withdraw'],
    ['Y3', 'sokoni-merchant-provider-money.js', "call('myTransactionReceipts', Object.assign({ role: 'provider', limit: 25 }", "call('myTransactionReceipts', Object.assign({ limit: 25 }"],
    ['Y4b', 'sokoni-merchant-provider-money.js', "(paid && !isCur ? (canEdit() ?", '(paid && !isCur ? (true ?'],
    ['Y5', 'sokoni-merchant-routes.js', "    { key:'provbusiness', label:'Business', requires:'module:earnings',", "    { key:'provbusiness', label:'Business',"],
  ];
  let caught = 0;
  for (const [row, file, a, b] of M) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pmy-'));
    ['sokoni-merchant-provider-money.js', 'sokoni-merchant-routes.js'].forEach((f) => fs.copyFileSync(path.join(ROOT, f), path.join(d, f)));
    const t = path.join(d, file), s = fs.readFileSync(t, 'utf8').replace(/\r\n/g, '\n');
    if (s.split(a).length !== 2) { console.log('  BROKEN ' + row + ' anchor'); continue; }
    fs.writeFileSync(t, s.replace(a, () => b));
    let out = ''; try { out = cp.execFileSync(process.execPath, [__filename], { env: Object.assign({}, process.env, { SABOTAGE: '', WEB_DIR: d }), encoding: 'utf8' }); } catch (e) { out = String(e.stdout || ''); }
    const hit = new RegExp('FAIL ' + row + ' ').test(out);
    console.log('  ' + (hit ? 'CAUGHT' : 'MISSED') + ' ' + row); if (hit) caught++;
    fs.rmSync(d, { recursive: true, force: true });
  }
  console.log('\nSABOTAGE: ' + caught + '/' + M.length + ' caught');
  process.exit(caught === M.length ? 0 : 1);
}

const DIR = process.env.WEB_DIR || ROOT;
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 300) + ']')); ok ? pass++ : fail++; };
console.log('\nmerchant-v2 › provider Payments / Receipts / Plan\n');
function el() { return { innerHTML: '', listeners: {}, addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }, removeEventListener() {}, querySelector: () => null, insertAdjacentHTML(_, h) { this.innerHTML += h; } }; }
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
function harness(answers) {
  const calls = [], G = { Promise, Object, String, Number, Math, JSON, Array, Date };
  G.window = G; vm.runInContext(fs.readFileSync(path.join(DIR, 'sokoni-merchant-provider-money.js'), 'utf8'), vm.createContext(G));
  const call = async (name, data) => { calls.push(Object.assign({ fn: name }, data)); const a = answers[name]; if (a instanceof Error) throw a; return typeof a === 'function' ? a(data) : (a || {}); };
  return { calls, mount: (view, editable) => { const host = el(); G.SokoniMerchantProviderMoney.mount(host, { view, call, editable: () => editable !== false }); return host; } };
}
const LEDGER = { availableKES: 4500, pending: { count: 1, amountCents: 900000, bookings: [{ bookingId: 'b1', service: 'Logo <b>sprint</b>', amountCents: 900000, status: 'paid_held' }] },
  totals: { grossCents: 1000000, platformFeeCents: 100000, providerNetCents: 900000, refundedCents: 0, deductionsCents: 0, releasedCents: 450000, window: { scanned: 200, truncated: true } },
  entries: [{ id: 'w1', type: 'credit', amountKES: 4500, status: 'completed', description: 'Booking settled', bookingId: 'b0', createdAt: 1759480000000 }],
  payouts: [], payoutEligibility: { minimumKES: 100, availableKES: 4500, eligible: true, requestPath: 'requestSellerPayout' }, reasons: [] };

(async () => {
  let h = harness({ providerLedger: LEDGER }); let host = h.mount('payments'); await flush();
  const p = host.innerHTML;
  ck('Y0', /KES 4,500/.test(p) && /KES 9,000/.test(p) && /KES 1,000/.test(p) && /last 200 receipts/.test(p) && /Logo &lt;b&gt;sprint/.test(p) && /Booking settled/.test(p) && h.calls.length === 1 && h.calls[0].fn === 'providerLedger',
    'payments: available / pending (held) / commission / net from ONE server read (providerLedger), escaped; truncation stated', p.slice(0, 300));
  h = harness({ providerLedger: Object.assign({}, LEDGER, { availableKES: null, totals: null, reasons: ['wallet_unreadable', 'receipts_unreadable'] }) }); host = h.mount('payments'); await flush();
  ck('Y1', /<b>—<\/b><small>Available/.test(host.innerHTML) && /<b>—<\/b><small>Gross/.test(host.innerHTML) && !/KES 0/.test(host.innerHTML) && /wallet_unreadable/.test(host.innerHTML),
    'an unreadable figure renders "—" (neutral) with the reason — never KES 0', host.innerHTML.slice(0, 300));
  ck('Y2', /disabled aria-disabled="true">Withdraw — coming soon/.test(p) && !/data-withdraw/.test(p) && !h.calls.some((c) => /payout/i.test(c.fn) || /requestSellerPayout|providerRequestPayout/.test(c.fn)),
    'withdrawal is DISABLED while the canonical wallet path is frozen; no payout op is ever called from this page');

  h = harness({ myTransactionReceipts: { receipts: [{ receiptNo: 'SKR-0001', kind: 'service_booking', subtype: 'work_milestone', paidCents: 2000000, platformFeeCents: 200000, providerNetCents: 1800000, status: 'paid', method: null, issuedAt: 1759480000000, links: { bookingId: 'wm_P1_m1_1', workProjectId: 'P1' } }] } });
  host = h.mount('receipts'); await flush();
  const rc = h.calls[0];
  ck('Y3', rc.fn === 'myTransactionReceipts' && rc.role === 'provider' && /SKR-0001/.test(host.innerHTML) && /work_milestone/.test(host.innerHTML) && /—/.test(host.innerHTML) && /KES 18,000/.test(host.innerHTML) && /project P1/.test(host.innerHTML),
    'receipts: the canonical records for role:provider — number, kind/subtype, method ("—" when IntaSend reported none), commission, net, project link', { rc, html: host.innerHTML.slice(0, 200) });

  const PLANS = { plans: [{ id: 'marketing_free', hubType: 'marketing', name: 'Free', price: { monthly: 0 }, features: { services_limit: 3 } }, { id: 'marketing_professional', hubType: 'marketing', name: 'Professional', price: { monthly: 149900 }, features: { services_limit: 20, quotations: true } }, { id: 'other_x', hubType: 'food', name: 'Food', price: { monthly: 1 } }] };
  h = harness({ subGetPlans: PLANS, subGetStatus: { subscriptions: {} }, createPaymentIntent: { ref: 'R1' } }); host = h.mount('plan'); await flush();
  const ph = host.innerHTML;
  const buyBtn = { dataset: { buy: 'marketing_professional' }, closest() { return this; }, disabled: false };
  for (const f of host.listeners.click || []) await f({ target: buyBtn });
  const form = { matches: (s) => s === '[data-buy-form]', dataset: { plan: 'marketing_professional' }, elements: { phone: { value: '0712 345 678' } }, querySelector: () => ({ textContent: '', className: '', disabled: false }) };
  for (const f of host.listeners.submit || []) await f({ target: form, preventDefault() {} });
  await flush();
  const pi = h.calls.find((c) => c.fn === 'createPaymentIntent');
  ck('Y4', /KES 1,499/.test(ph) && /current/.test(ph) && !/Food/.test(ph) && /data-buy="marketing_professional"/.test(ph) && !/data-buy="marketing_free"/.test(ph)
    && pi && pi.planId === 'marketing_professional' && pi.billingCycle === 'monthly' && pi.phone === '0712345678' && !('amount' in pi) && !('purpose' in pi),
    'plan: marketing catalogue (cents) + current (Free when no paid sub); upgrade = createPaymentIntent {planId, monthly, phone} — no amount, no client unlock', { pi });
  h = harness({ subGetPlans: PLANS, subGetStatus: { subscriptions: {} } }); host = h.mount('plan', false); await flush();
  for (const f of host.listeners.click || []) await f({ target: buyBtn });
  for (const f of host.listeners.submit || []) await f({ target: form, preventDefault() {} });
  ck('Y4b', !/data-buy=/.test(host.innerHTML) && /Read-only/.test(host.innerHTML) && !h.calls.some((c) => c.fn === 'createPaymentIntent'), 'P0-F read-only: no upgrade control and a forged click/submit starts no payment');

  const G2 = { window: null }; G2.window = G2; vm.runInContext(fs.readFileSync(path.join(DIR, 'sokoni-merchant-routes.js'), 'utf8'), vm.createContext(G2));
  const R = G2.SokoniMerchantRoutes;
  ck('Y5', R.validate().length === 0 && R.mountRefusal('prov-payments', 'provider', () => false) === 'requires:module:earnings' && R.mountRefusal('prov-receipts', 'provider', (c) => c === 'module:earnings') === null
    && R.mountRefusal('prov-plan', 'provider', (c) => c === 'module:earnings') === 'requires:module:subscription' && /^session:/.test(String(R.mountRefusal('prov-payments', 'merchant', () => true))),
    'routes: provider-only, Payments/Receipts gated on module:earnings, Plan on module:subscription; a merchant session never mounts them');
  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); console.log('\nRESULT: ' + pass + ' passed, ' + (fail + 1) + ' failed'); process.exit(1); });
