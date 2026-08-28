/* ══════════════════════════════════════════════════════════════════════════════
   WALLET — the native surface over the FROZEN wallet backend
   ══════════════════════════════════════════════════════════════════════════════
     node scripts/test-merchant-wallet.js

   The audit established that the backend already exists and must not be rebuilt.
   This asks the only questions that remain: does the SURFACE lie about money?

   Four properties, and every one of them has produced a real defect somewhere in
   this programme already:

     1. an unknown figure is —, never 0 and never a guess
     2. a withdrawal is never described as sent before the server says so
     3. the surface holds no write path to any money document
     4. the entitlement gate reads a real, server-computed answer

   Plus the two facts the surface is built on, asserted against the tree so they
   cannot rot: the payout status vocabulary, and the premium/walletEnabled
   equivalence the client-reachable projection depends on.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0, unproven = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + d + ']' : '')); ok ? pass++ : fail++; };
const un = (l, d) => { console.log('  UNPROVEN  ' + l + (d ? '   [' + d + ']' : '')); unproven++; };
const head = (t) => console.log('\n' + t);

console.log('\nWALLET — NATIVE SURFACE');
console.log('='.repeat(78));

/* ── DOM stub ───────────────────────────────────────────────────────────────
   Same shape as the Flash Sale rig, generalised: it captures any node carrying
   data-wa / data-wav / name / id, so the test can press a real control instead
   of calling an internal function that no button is wired to. */
const listeners = [];
function mkEl (tag) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(), children: [], attrs: {}, style: {},
    _html: '', value: '', id: '', _nodes: [], dataset: {},
    classList: { _s: new Set(), add (c) { this._s.add(c); }, remove (c) { this._s.delete(c); },
                 contains (c) { return this._s.has(c); } },
    setAttribute (k, v) { this.attrs[k] = String(v); },
    getAttribute (k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
    appendChild (c) { this.children.push(c); return c; },
    addEventListener (t, fn) { listeners.push({ el: this, t, fn }); },
    removeEventListener (t, fn) {
      const i = listeners.findIndex((l) => l.el === this && l.t === t && l.fn === fn);
      if (i > -1) listeners.splice(i, 1);
    },
    focus () {},
    get innerHTML () { return this._html; },
    set innerHTML (v) {
      this._html = String(v); this._nodes = [];
      const re = /<(\w+)([^>]*)>/g; let m;
      while ((m = re.exec(this._html))) {
        const a = {}; const ar = /([\w-]+)="([^"]*)"/g; let am;
        while ((am = ar.exec(m[2]))) a[am[1]] = am[2];
        if (a['data-wa'] || a['data-wav'] || a.id || a.name) {
          const n = mkEl(m[1]);
          n.attrs = a;
          n.value = a.value || '';
          n.id = a.id || '';
          n.name = a.name || '';
          n.dataset = { wa: a['data-wa'], wav: a['data-wav'] };
          n.disabled = Object.prototype.hasOwnProperty.call(a, 'disabled') ||
                       / disabled(?=[ >])/.test(m[0]);
          /* SELECTOR-AWARE. A `closest` that returns the node whatever it was
             asked for is worse than none: the view switcher and the action
             buttons are both matched with closest(), so an always-true stub
             made every button press register as a view change and the form
             never rendered. The rig was wrong, not the surface. */
          n.closest = (s) => {
            const am = String(s || '').match(/^\[([\w-]+)\]$/);
            if (am) return Object.prototype.hasOwnProperty.call(n.attrs, am[1]) ? n : null;
            const vm = String(s || '').match(/^\[([\w-]+)="([^"]*)"\]$/);
            if (vm) return n.attrs[vm[1]] === vm[2] ? n : null;
            return null;
          };
          this._nodes.push(n);
        }
      }
      /* `disabled` is a bare attribute, so the value-pair regex above misses it.
         Re-scan the raw tag text for it — a control the surface deliberately
         disabled must READ as disabled here, or the Till/PayBill assertions
         would pass against buttons that are in fact live. */
      const bare = /<(\w+)([^>]*?)\bdisabled\b([^>]*)>/g; let bm;
      while ((bm = bare.exec(this._html))) {
        const a = {}; const ar = /([\w-]+)="([^"]*)"/g; let am;
        const attrText = bm[2] + bm[3];
        while ((am = ar.exec(attrText))) a[am[1]] = am[2];
        const hit = this._nodes.find((n) =>
          (a['data-wa'] && n.attrs['data-wa'] === a['data-wa']) ||
          (a.value && n.attrs.value === a.value && n.attrs.name === a.name));
        if (hit) hit.disabled = true;
      }
    },
    querySelector (sel) {
      let m = sel.match(/\[data-wa="([^"]*)"\]/);
      if (m) return this._nodes.find((n) => n.attrs['data-wa'] === m[1]) || null;
      m = sel.match(/\[data-wav="([^"]*)"\]/);
      if (m) return this._nodes.find((n) => n.attrs['data-wav'] === m[1]) || null;
      m = sel.match(/^#([\w-]+)$/);
      if (m) return this._nodes.find((n) => n.attrs.id === m[1]) || null;
      m = sel.match(/\[name="([^"]*)"\]\[value="([^"]*)"\]/);
      if (m) return this._nodes.find((n) => n.attrs.name === m[1] && n.attrs.value === m[2]) || null;
      return null;
    },
  };
  return el;
}
const doc = {
  _styles: {},
  getElementById (id) { return doc._styles[id] || null; },
  createElement (t) { return mkEl(t); },
  head: { appendChild (el) { if (el.id) doc._styles[el.id] = el; } },
  addEventListener () {}, removeEventListener () {},
};
global.document = doc;
global.window = global;

const UI = require(path.join(ROOT, 'sokoni-merchant-wallet.js'));
const SRC = fs.readFileSync(path.join(ROOT, 'sokoni-merchant-wallet.js'), 'utf8');
const SHELL = fs.readFileSync(path.join(ROOT, 'merchant-v2.html'), 'utf8');
const WALLET_FN = fs.readFileSync(path.join(ROOT, 'functions/wallet.js'), 'utf8');
const CATALOG = fs.readFileSync(path.join(ROOT, 'functions/subscription-catalog.js'), 'utf8');
const AUTHORITY = fs.readFileSync(path.join(ROOT, 'functions/subscription-authority.js'), 'utf8');

const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle (n = 12) { for (let i = 0; i < n; i++) await tick(); }

const PREMIUM = { active: true, plan: 'GROWTH', premium: true };
const WALLET = { id: 'uid_A', balance: 4200, pendingPayout: 0, currency: 'KES' };

function mountUI (o = {}) {
  const host = mkEl('div');
  const toasts = [], calls = { topup: [], confirm: [], withdraw: [] };
  const inst = UI.mount(host, {
    scope: { ok: true, shopId: 'shop_A', sellerUid: 'uid_A' },
    shopName: 'Cert Shop',
    entitlement: o.entitlement || (() => Promise.resolve(PREMIUM)),
    readWallet: o.readWallet || (() => Promise.resolve(o.wallet === undefined ? WALLET : o.wallet)),
    readTransactions: o.readTransactions || (() => Promise.resolve(o.tx || [])),
    readPayouts: o.readPayouts || (() => Promise.resolve(o.payouts || [])),
    callTopUp: o.callTopUp || ((p) => { calls.topup.push(p); return Promise.resolve({ data: { txId: 't1', message: 'M-Pesa prompt sent to your phone.' } }); }),
    callConfirmTopUp: o.callConfirmTopUp || ((p) => { calls.confirm.push(p); return Promise.resolve({ data: { status: 'pending' } }); }),
    callWithdraw: o.callWithdraw || ((p) => { calls.withdraw.push(p); return Promise.resolve({ data: { requestId: 'pout_x', status: 'pending', message: 'Submitted — under review. Funds arrive within 24 hours once approved.' } }); }),
    onToast: (m) => toasts.push(m),
  });
  return { host, inst, toasts, calls };
}
function fire (host, type, node) {
  listeners.filter((l) => l.el === host && l.t === type).forEach((l) => l.fn({ target: node }));
}
/* The surface paints its list into a #wa-body child, so the host's own markup
   does not contain it. Reading only host.innerHTML would make every list
   assertion vacuously false — and, worse, every NEGATIVE assertion vacuously
   TRUE. Both halves, always. */
function html (host) {
  const b = host.querySelector('#wa-body');
  return host.innerHTML + (b ? b.innerHTML : '');
}
function view (host, k) {
  const n = host.querySelector('[data-wav="' + k + '"]');
  if (!n) throw new Error('no view ' + k);
  fire(host, 'click', n);
  return n;
}
function press (host, wa) {
  const n = host.querySelector('[data-wa="' + wa + '"]');
  if (!n) throw new Error('no control data-wa="' + wa + '"');
  fire(host, 'click', n);
  return n;
}
function type (host, id, v) {
  const n = host.querySelector('#' + id);
  if (!n) throw new Error('no field #' + id);
  n.value = String(v);
  listeners.filter((l) => l.el === n && l.t === 'input').forEach((l) => l.fn({ target: n }));
}

/* Top-level await is not available in CommonJS, and every DOM assertion below has
   to wait for a mount to settle. One async main, and a catch that FAILS the run —
   a harness that throws must never look like a suite that passed. */
(async function main () {

head('1 - the two facts the surface is built on');

/* If the catalogue and the projection ever disagree, the Wallet unlocks (or
   locks) for the wrong merchants. The surface cannot read `walletEnabled` — the
   client-reachable callable returns `premium` instead — so the equivalence is
   load-bearing and is asserted here rather than assumed. */
const tiers = {};
{
  const re = /id:\s*'(FREE|STARTER|GROWTH|ENTERPRISE)'[\s\S]{0,400}?walletEnabled:\s*(true|false)/g;
  let m; while ((m = re.exec(CATALOG))) tiers[m[1]] = m[2] === 'true';
}
ck('the catalogue declares walletEnabled for all four tiers', Object.keys(tiers).length === 4,
   JSON.stringify(tiers));
ck('premium is defined server-side as active && plan !== FREE',
   /premium:\s*active && ent\.plan !== 'FREE'/.test(AUTHORITY));
ck('so premium === walletEnabled for EVERY tier — the gate is faithful',
   Object.keys(tiers).every((t) => tiers[t] === (t !== 'FREE')),
   'a future plan setting one without the other fails HERE, not in production');
ck('NC and the equivalence is not vacuous — FREE really differs from the rest',
   tiers.FREE === false && tiers.STARTER === true);
ck('the callable the client reaches does NOT return features',
   !/features:\s*ent\.features/.test(AUTHORITY.slice(AUTHORITY.indexOf('exports.getMerchantEntitlements'))),
   'which is exactly why the surface gates on premium');

/* The status vocabulary. A status the server writes but the surface does not
   know would fall to a default, and the default must never be "completed". */
const SERVER_STATUSES = [...new Set(
  (WALLET_FN.match(/status: *'[a-z_]+'/g) || []).map((s) => s.split("'")[1])
)].concat(['scheduled', 'approval_failed']).filter((s) => s !== 'completed');
const MAP = UI._internal.PAYOUT_STATE;
const unknownStatuses = SERVER_STATUSES.filter((s) => !MAP[s]);
ck('every payout status wallet.js writes is in the surface map',
   unknownStatuses.length === 0,
   unknownStatuses.length ? 'MISSING: ' + unknownStatuses.join(', ') : SERVER_STATUSES.length + ' statuses');
ck('an UNRECOGNISED status falls to pending, never to completed',
   UI._internal.payoutState('some_new_state_2027') === 'pending');
ck('"approved" is PENDING, because auto-B2C is off and nothing has been sent',
   UI._internal.payoutState('approved') === 'pending');
ck('...and the server agrees: approved is labelled manual disbursement',
   /auto-B2C off/.test(WALLET_FN));
ck('"reversed" is its own state, not folded into completed',
   UI._internal.payoutState('reversed') === 'reversed');
ck('only paid and settled_manually are completed',
   UI._internal.payoutState('paid') === 'completed' &&
   UI._internal.payoutState('settled_manually') === 'completed' &&
   UI._internal.payoutState('processing') !== 'completed');

head('2 - an unknown figure is never a number');
ck('money(null) is null, not 0', UI._internal.money(null) === null);
ck('money(undefined) is null', UI._internal.money(undefined) === null);
ck('money("") is null — Number("") is 0 and isFinite("") is true',
   UI._internal.money('') === null);
ck('NC money(0) IS "KES 0" — a real zero is not hidden',
   UI._internal.money(0) === 'KES 0',
   'the defect is an UNKNOWN shown as 0, not a genuine zero');
ck('money(4200) formats', /4,200/.test(UI._internal.money(4200) || ''));

head('3 - the balance card, against a wallet that cannot be read');
{
  const { host } = mountUI({ readWallet: () => Promise.reject(Object.assign(new Error('x'), { code: 'permission-denied' })) });
  await settle();
  ck('an unreadable balance renders —', /wa-bal">—</.test(host.innerHTML));
  ck('...and says so with the code, rather than showing 0',
     /permission-denied/.test(host.innerHTML) && !/KES 0/.test(host.innerHTML));
  ck('...and offers no Withdraw against an unknown balance',
     (host.querySelector('[data-wa="withdraw"]') || {}).disabled === true);
}
{
  const { host } = mountUI({ wallet: null });
  await settle();
  ck('a wallet that does not exist yet is stated, not shown as zero',
     /has not been opened yet/.test(host.innerHTML) && !/KES 0/.test(host.innerHTML));
}
{
  const { host } = mountUI();
  await settle();
  ck('NC a readable balance IS shown', /4,200/.test(host.innerHTML),
     'so the — assertions above are not passing because nothing renders');
  ck('and it is labelled available, excluding money in flight',
     /Available balance/.test(host.innerHTML));
}
{
  const { host } = mountUI({ wallet: { balance: 900, pendingPayout: 1500 } });
  await settle();
  ck('a reserved withdrawal is shown separately from the balance',
     /1,500/.test(host.innerHTML) && /reserved/.test(host.innerHTML));
  ck('...and is NOT added to the available figure',
     /wa-bal[^>]*>[\s\S]{0,40}900/.test(host.innerHTML) && !/2,400/.test(host.innerHTML));
}

head('4 - a withdrawal is never described as sent');
{
  const { host, calls, toasts } = mountUI({ payouts: [] });
  await settle();
  press(host, 'withdraw');
  type(host, 'wa-amt', '500');
  type(host, 'wa-phone', '0712345678');
  press(host, 'do-withdraw');
  await settle();

  ck('requestSellerPayout was called exactly once', calls.withdraw.length === 1);
  const p = calls.withdraw[0] || {};
  ck('...with method mpesa', p.method === 'mpesa');
  ck('...with an idempotency key', !!p.idempotencyKey, String(p.idempotencyKey || ''));
  ck('...and an integer amount', Number.isInteger(p.amount) && p.amount === 500);
  ck('the SERVER sentence is what the merchant reads',
     /Submitted — under review/.test(host.innerHTML) ||
     toasts.some((t) => /Submitted — under review/.test(t)),
     (toasts[0] || '').slice(0, 60));
  const said = (html(host) + ' ' + toasts.join(' '));
  ck('nothing on screen claims the money was sent or paid',
     !/\b(sent to|has been sent|money sent|paid out|withdrawn successfully)\b/i.test(said));
}
{
  /* The one wording that would be a real defect: an approved payout described as
     money that has arrived. */
  const { host } = mountUI({ payouts: [
    { id: 'p1', amount: 800, status: 'approved', accountNumber: '254712345678', method: 'mpesa', createdAt: new Date() },
  ] });
  await settle();
  view(host, 'withdrawals');
  ck('an APPROVED withdrawal is badged Pending',
     /Pending<\/span>/.test(html(host)) && !/Completed<\/span>/.test(html(host)));
  ck('...and worded as awaiting manual disbursement',
     /awaiting manual disbursement/i.test(html(host)));
}
{
  const { host } = mountUI({ payouts: [
    { id: 'p1', amount: 800, status: 'paid', accountNumber: '254712345678', method: 'mpesa', createdAt: new Date() },
  ] });
  await settle();
  view(host, 'withdrawals');
  ck('NC a PAID withdrawal IS badged Completed', /Completed<\/span>/.test(html(host)),
     'so the Pending assertion above is a real distinction');
}

head('5 - the idempotency key survives the failure it exists for');
{
  let seen = [];
  const { host } = mountUI({
    callWithdraw: (p) => { seen.push(p.idempotencyKey); return Promise.reject(new Error('deadline-exceeded')); },
  });
  await settle();
  press(host, 'withdraw');
  type(host, 'wa-amt', '500'); type(host, 'wa-phone', '0712345678');
  press(host, 'do-withdraw'); await settle();
  press(host, 'do-withdraw'); await settle();
  ck('a retry after a lost response reuses the SAME key',
     seen.length === 2 && seen[0] && seen[0] === seen[1],
     seen.join(' vs '));
  ck('...so the server returns the existing withdrawal instead of a second one',
     /idempotencyKey/.test(WALLET_FN) && /deduplicated/.test(WALLET_FN));
}
{
  const { host, calls } = mountUI();
  await settle();
  press(host, 'withdraw');
  type(host, 'wa-amt', '500'); type(host, 'wa-phone', '0712345678');
  press(host, 'do-withdraw'); await settle();
  press(host, 'withdraw');
  type(host, 'wa-amt', '600'); type(host, 'wa-phone', '0712345678');
  press(host, 'do-withdraw'); await settle();
  ck('but a NEW withdrawal gets a NEW key',
     calls.withdraw.length === 2 && calls.withdraw[0].idempotencyKey !== calls.withdraw[1].idempotencyKey);
}

head('6 - Till and PayBill are refused, not faked');
{
  const { host, calls } = mountUI();
  await settle();
  press(host, 'withdraw');
  const till = host.querySelector('[name="wa-dest"][value="till"]');
  const paybill = host.querySelector('[name="wa-dest"][value="paybill"]');
  ck('a Till option is DRAWN, so the gap is visible rather than hidden', !!till);
  ck('...and disabled', !!till && till.disabled === true);
  ck('a PayBill option is drawn and disabled', !!paybill && paybill.disabled === true);
  ck('each says WHY, in the merchant\'s language',
     /cannot be sent correctly today/.test(host.innerHTML) &&
     /business number and an account reference/.test(host.innerHTML));

  /* The defect this guards: a till number submitted through the phone field.
     requestSellerPayout validates `mpesa` accounts as phone numbers, so it would
     either refuse or — worse — accept a till that happens to look like one. */
  /* fire() already wraps its argument as the event TARGET. Passing {target:…}
     produced e.target.target and the handler saw no name at all, so the
     destination silently stayed on mpesa and the submission went through —
     which read exactly like a missing guard. Rig, not surface. */
  fire(host, 'change', { name: 'wa-dest', value: 'till' });
  type(host, 'wa-amt', '500'); type(host, 'wa-phone', '832000');
  press(host, 'do-withdraw'); await settle();
  ck('forcing a till destination submits NOTHING', calls.withdraw.length === 0);
  ck('...and says only mobile is available', /Only withdrawals to an M-Pesa mobile/.test(host.innerHTML));
  ck('the server would not have accepted it anyway',
     /validMethods = \['mpesa', 'bank'\]/.test(WALLET_FN) &&
     /valid Kenyan phone number/.test(WALLET_FN));
}

head('7 - the surface holds no path to change money');
ck('the module never writes a wallet document',
   !/setDoc|updateDoc|addDoc|runTransaction|deleteDoc/.test(SRC));
ck('it is handed no write adapter at all',
   !/writeProduct|writeMirror|putImage/.test(SRC));
{
  /* Locate the wallet ctx by its OWN extent rather than by the entry that
     happens to follow it. The original sliced to `sell:`, which sits BEFORE
     wallet in the live registry — yielding an empty string and failing three
     assertions against nothing at all. Same assertions, order-independent. */
  const _wStart = SHELL.indexOf("wallet:     { global: 'SokoniMerchantWallet'");
  const _wEnd = SHELL.indexOf('onToast: toast }; } },', _wStart);
  const ctxBlock = _wStart < 0 || _wEnd < 0 ? '' : SHELL.slice(_wStart, _wEnd + 22);
  ck('the shell hands it exactly three callables', (ctxBlock.match(/_callable\(/g) || []).length === 3,
     (ctxBlock.match(/_callable\('(\w+)'\)/g) || []).join(' '));
  ck('...and none of them is spendFromWallet', !/spendFromWallet/.test(ctxBlock),
     'it only debits, against an arbitrary orderId — a money-destroying button');
  ck('...and no db adapter is handed over', !/db:\s*_mdb/.test(ctxBlock),
     'wallets is allow update: if isAdmin() — CF only');
}
ck('the module never touches localStorage',
   !/localStorage|sessionStorage/.test(SRC), 'no client-side financial authority');
ck('and it computes no balance — the only arithmetic is display formatting',
   !/balance\s*[-+]\s*|\+\s*amount|balance\s*=\s*[^=]/.test(SRC.replace(/Number\(S\.wallet\.balance \|\| 0\)/g, '')),
   'comparisons for the minimum are allowed; mutation is not');

head('8 - the top-up never credits locally');
{
  const { host, calls } = mountUI();
  await settle();
  press(host, 'topup');
  type(host, 'wa-amt', '500'); type(host, 'wa-phone', '0712345678');
  press(host, 'do-topup'); await settle();
  ck('initiateWalletTopUp was called', calls.topup.length === 1);
  ck('the server sentence is shown', /prompt sent/i.test(host.innerHTML));
  ck('the balance shown is still the SERVER balance, not balance + top-up',
     !/4,700/.test(host.innerHTML), 'nothing was added client-side');
  ck('and the surface asks the SERVER whether it completed',
     /callConfirmTopUp/.test(SRC) && /status === 'completed'/.test(SRC));
}
{
  /* A poll that fails says nothing about the payment. Announcing a failure would
     be inventing an outcome just as much as announcing success. */
  ck('a failed confirmation poll announces nothing',
     /A failed poll says nothing about the payment/.test(SRC));
}

head('9 - the entitlement gate');
{
  const { host } = mountUI({ entitlement: () => Promise.resolve(null) });
  await settle();
  ck('UNKNOWN plan shows a neutral checking state', /Checking your plan/.test(host.innerHTML));
  ck('...with no balance and no actions',
     !/data-wa="withdraw"/.test(host.innerHTML) && !/data-wa="topup"/.test(host.innerHTML));
  ck('...and is not treated as "free"', !/paid plan/.test(host.innerHTML));
}
{
  const { host } = mountUI({ entitlement: () => Promise.resolve({ active: true, plan: 'FREE', premium: false }) });
  await settle();
  ck('a FREE plan is told the Wallet is paid, without a fake balance',
     /paid plan/.test(host.innerHTML) && !/KES/.test(host.innerHTML));
}
{
  const { host } = mountUI({ entitlement: () => Promise.reject(new Error('offline')) });
  await settle();
  ck('an entitlement ERROR is unknown, not free', /Checking your plan/.test(host.innerHTML));
}

head('10 - it is STATICALLY loaded, and it is wired');
/* SHIPPED ARCHITECTURE: every module global arrives from a static <script>.
   The source lineage had a MODULE_SCRIPTS lazy registry; this lineage does not,
   and importing one as a side effect of adding a Wallet would have been a
   redesign. The cost is recorded rather than hidden: the module downloads for
   every merchant, not only those who open the Wallet — which is exactly how
   every other module on this shell already behaves. */
ck('the module is loaded by a static script tag',
   /<script[^>]+src="sokoni-merchant-wallet\.js"/.test(SHELL),
   'this shell has no lazy loader; a global that is never fetched is a dead surface');
ck('the shell declares the module global', /wallet:\s*\{ global: 'SokoniMerchantWallet'/.test(SHELL));
ck('the script tag sits with the other module tags, before the registry names it',
   SHELL.indexOf('src="sokoni-merchant-wallet.js"') > -1 &&
   SHELL.indexOf('src="sokoni-merchant-wallet.js"') <
     SHELL.indexOf("wallet:     { global: 'SokoniMerchantWallet'"),
   'renderModule reads window[def.global] synchronously — a tag after it would race');
ck('Payments offers a Wallet view alongside its payments ledger',
   /\{ k: 'ledger', label: 'Payments in' \}, \{ k: 'wallet', label: 'Wallet' \}/.test(SHELL) &&
   /data-payview="/.test(SHELL));
ck('...and the ledger is still reachable, not replaced',
   /function renderPaymentsLedger/.test(SHELL) && /sellerPayments/.test(SHELL));
ck('leaving the Wallet destroys it, so its polling stops',
   /_mounted\.wallet[\s\S]{0,220}destroy/.test(SHELL));
/* The source guarded against a merchant navigating away DURING an async module
   fetch. Here renderModule is synchronous, so that window does not exist — and
   the suite proves the property rather than trusting the claim. If module
   loading ever becomes async, this fails and the guard must come back WITH it. */
{
  const rm = SHELL.slice(SHELL.indexOf('function renderModule ('));
  let d = 0, end = 0;
  for (let i = rm.indexOf('{'); i < rm.length; i++) {
    if (rm[i] === '{') d++; else if (rm[i] === '}') { d--; if (d === 0) { end = i; break; } }
  }
  const body = rm.slice(0, end + 1);
  ck('CONTROL the renderModule body was isolated', body.length > 200 && body.length < 4000,
     body.length + ' chars');
  ck('renderModule is SYNCHRONOUS, so no abandonment window exists',
     !/\.then\(|await |new Promise|setTimeout|import\(/.test(body),
     'the source lineage needed an abandonment guard only because its loader was async');
  ck('...and the Wallet is therefore mounted without a route argument',
     /renderModule\('wallet', hostEl\)/.test(SHELL),
     'passing an argument this signature ignores would imply a guard that is not there');
}

head('10b - PROVENANCE: the lazy-loader assumption is retired, not forgotten');
/* Kept deliberately. Until this commit the three assertions above expected a
   MODULE_SCRIPTS registry and an async load. They were left FAILING rather than
   deleted, so the divergence stayed visible. Now they are replaced — and this
   control records WHY, and fires if the loader ever returns without the guard. */
ck('no MODULE_SCRIPTS lazy registry exists on this lineage',
   !/MODULE_SCRIPTS/.test(SHELL),
   'if this fails, a lazy loader was reintroduced — restore the abandonment guard with it');
ck('no module is fetched at mount time',
   !/_loadModuleScripts/.test(SHELL),
   'the shipped design resolves every global before mount');

head('11 - the shell reads are owner-scoped in the QUERY');
ck('walletTransactions is filtered by uid server-side',
   /collection: 'walletTransactions', where: \[\['uid', '==', u\]\]/.test(SHELL));
ck('payoutRequests is filtered by sellerUid server-side',
   /collection: 'payoutRequests', where: \[\['sellerUid', '==', u\]\]/.test(SHELL));
ck('the wallet document is addressed by the signed-in uid',
   /doc\(window\.firebaseDB, 'wallets', u\)/.test(SHELL));
{
  const rules = fs.existsSync(path.join(ROOT, 'firestore.rules.deployed'))
    ? fs.readFileSync(path.join(ROOT, 'firestore.rules.deployed'), 'utf8') : null;
  if (!rules) un('the SERVED ruleset authorises those three reads', 'firestore.rules.deployed not fetched');
  else {
    ck('the served ruleset authorises wallets to its owner',
       /match \/wallets\/\{uid\}[\s\S]{0,200}request\.auth\.uid == uid/.test(rules));
    ck('...walletTransactions to the uid on the document',
       /match \/walletTransactions[\s\S]{0,200}resource\.data\.uid == request\.auth\.uid/.test(rules));
    ck('...payoutRequests to the sellerUid on the document',
       /match \/payoutRequests[\s\S]{0,200}resource\.data\.sellerUid == request\.auth\.uid/.test(rules));
    ck('...and walletTransactions is write-denied to every client',
       /match \/walletTransactions[\s\S]{0,260}allow write: if false/.test(rules));
  }
}

console.log('\n' + '='.repeat(78));
console.log('  ' + pass + ' passed, ' + fail + ' failed' + (unproven ? ', ' + unproven + ' unproven' : ''));
console.log('='.repeat(78) + '\n');
process.exit(fail ? 1 : 0);

})().catch(function (e) {
  console.error('\n  HARNESS ERROR: ' + ((e && e.stack) || e) + '\n');
  process.exit(1);
});
