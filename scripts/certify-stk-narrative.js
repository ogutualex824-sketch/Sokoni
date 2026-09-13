'use strict';
/* ════════════════════════════════════════════════════════════════════════════════════════════
   THE M-PESA PROMPT NAMES THE SHOP — certification.

   WHAT CAN AND CANNOT BE DONE, stated once so it is not re-litigated:
   the PIN dialog on the buyer's handset is Safaricom's SIM-toolkit screen. It cannot be styled,
   branded, re-laid-out or replaced by SOKONI or by anyone else. The ONE thing we control is the
   `narrative` string in the STK request. It used to carry our own payment reference —
   `SOKONI: SKN-1757…` — which is the "random code" a buyer sees and which tells them nothing about
   who is receiving their money. That string is what this gate fixes.

   WHAT IS PROVEN HERE
   The real `initiateSTKPush` handler is executed with the gateway and Firestore replaced, and the
   ACTUAL payload it would send is captured and read. Not "the module exists" — the bytes on the
   wire.

   WHAT IS NOT PROVEN HERE, AND CANNOT BE
   Whether IntaSend forwards `narrative` into what Safaricom finally renders. That needs one real
   push to a real handset. This suite proves SOKONI sends the right string; it cannot prove the
   carrier displays it. Said plainly rather than implied away.

   Run:  node scripts/certify-stk-narrative.js
   ════════════════════════════════════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const FN = path.join(ROOT, 'functions');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'sokoni-stk-cert';
/* The handler refuses before the gateway if the secret is unset; supply a local value so the
   PAYLOAD-BUILDING path is reached. No real key, and the gateway is intercepted regardless. */
process.env.INTASEND_PRIVATE_KEY = process.env.INTASEND_PRIVATE_KEY || 'cert-local-not-a-real-key';

const WATCHDOG = setTimeout(() => {
  process.stdout.write('\n  ✖ WATCHDOG — the suite did not finish in 120s. Failing closed.\n');
  process.exit(2);
}, 120000);

let PASS = 0, FAIL = 0, BLOCKED = 0;
const FAILURES = [];
const ok = (id, m) => { PASS++; console.log('  ✔ ' + id.padEnd(7) + m); return true; };
const bad = (id, m, x) => { FAIL++; FAILURES.push(id + ' — ' + m); console.log('  ✖ ' + id.padEnd(7) + m + (x ? '\n            ' + String(x).slice(0, 240) : '')); return false; };
const blocked = (id, m) => { BLOCKED++; FAILURES.push(id + ' — BLOCKED: ' + m); console.log('  ⚠ ' + id.padEnd(7) + 'BLOCKED: ' + m); return false; };
const check = (id, c, m, x) => (c ? ok(id, m) : bad(id, m, x));
const section = (t) => console.log('\n' + t + '\n' + '─'.repeat(Math.max(t.length, 78)));
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/[^\n]*$/gm, ' ');

async function quiet(fn) {
  const so = process.stdout.write.bind(process.stdout), se = process.stderr.write.bind(process.stderr);
  process.stdout.write = () => true; process.stderr.write = () => true;
  try { return await fn(); } finally { process.stdout.write = so; process.stderr.write = se; }
}

/* ── Store ─────────────────────────────────────────────────────────────────────────────────── */
function makeStore() {
  const data = new Map();
  const key = (c, d) => c + '/' + d;
  const snapOf = (c, d) => { const v = data.get(key(c, d)); return { id: d, exists: v !== undefined, data: () => (v === undefined ? undefined : Object.assign({}, v)) }; };
  const collection = (c) => ({
    doc: (d) => ({
      id: String(d),
      get: async () => snapOf(c, d),
      set: async (o) => data.set(key(c, d), Object.assign({}, o)),
      create: async (o) => { if (data.has(key(c, d))) { const e = new Error('EXISTS'); e.code = 6; throw e; } data.set(key(c, d), Object.assign({}, o)); },
      update: async (o) => data.set(key(c, d), Object.assign({}, data.get(key(c, d)) || {}, o)),
      delete: async () => data.delete(key(c, d)),
    }),
    where: function (_f, _op, val) {
      const self = { where: () => self, limit: () => self, orderBy: () => self,
        get: async () => {
          const ids = Array.isArray(val) ? val : [val];
          const docs = ids.filter((i) => data.has(key(c, i))).map((i) => snapOf(c, i));
          return { empty: !docs.length, size: docs.length, docs, forEach: (f) => docs.forEach(f) };
        } };
      return self;
    },
  });
  return { collection, _put: (c, d, o) => data.set(key(c, d), Object.assign({}, o)), _del: (c, d) => data.delete(key(c, d)) };
}
const STORE = makeStore();
let LAST_ERR = null;

/* ── Load, with the gateway intercepted so nothing leaves the machine ───────────────────────── */
let admin, idx, MI, SENT = [];
try {
  admin = require(require.resolve('firebase-admin', { paths: [FN] }));
  const real = admin.firestore;
  const stub = function () { return STORE; };
  Object.getOwnPropertyNames(real).forEach((k) => { if (!['length', 'name', 'prototype'].includes(k)) { try { stub[k] = real[k]; } catch (_) {} } });
  Object.defineProperty(admin, 'firestore', { value: stub, configurable: true, writable: true });
  if (admin.firestore() !== STORE) throw new Error('the Firestore stub did not take effect');

  /* The STK call goes out over node:https. Intercept `request` and capture the body instead of
     letting it reach IntaSend — a certification that pushed real prompts would be a defect. */
  const https = require('https');
  const realRequest = https.request;
  https.request = function (opts, cb) {
    const chunks = [];
    const res = {
      statusCode: 200, headers: {},
      on(ev, fn) {
        if (ev === 'data') fn(Buffer.from(JSON.stringify({ id: 'stub-checkout-id', invoice: { invoice_id: 'stub' } })));
        if (ev === 'end') fn();
        return res;
      },
      setEncoding() { return res; },
    };
    const req = {
      on() { return req; },
      write(b) { chunks.push(String(b)); return true; },
      end() { SENT.push(chunks.join('')); if (cb) cb(res); return req; },
      destroy() {}, setTimeout() { return req; },
    };
    return req;
  };
  https.request.__real = realRequest;

  MI = require(path.join(FN, 'shared', 'merchant-identity.js'));
  idx = require(path.join(FN, 'index.js'));
} catch (e) {
  console.log('\n  ✖ SETUP — ' + (e && e.message));
  console.log((e && e.stack || '').split('\n').slice(0, 6).join('\n'));
  clearTimeout(WATCHDOG); process.exit(2);
}

const BUYER = 'buyer-stk', SELLER = 'seller-stk', PRODUCT = 'prod-stk';
const REQ = (data) => ({ data, auth: { uid: BUYER, token: { uid: BUYER } }, rawRequest: { headers: {}, ip: '127.0.0.1' }, acceptsStreaming: false });
/* The line may open with the BMP mark, so 'leads' means 'leads the content'. */
const leads = (narrative, shop) => String(narrative || '').replace(/^✔\s*/, '').indexOf(shop) === 0;
const idOf = (n) => ({ v: 1, resolved: true, name: n, sellerUid: 'u', authority: 'shops/u.name', reason: null });

function seed(shopName) {
  STORE._put('products', PRODUCT, { name: 'Item', price: 100, sellerUid: SELLER, stock: 5 });
  if (shopName === null) STORE._del('shops', SELLER);
  else STORE._put('shops', SELLER, { name: shopName });
}

async function push(overrides) {
  SENT = [];
  const payload = Object.assign({
    phone: '254712345678', amount: 250, ref: 'SKN-' + Date.now(),
    meta: { category: 'product', serviceDesc: 'SOKONI Order', items: [{ productId: PRODUCT, qty: 1 }],
      sellerUid: 'ATTACKER-CLAIMED-UID', sellerName: 'TOTALLY DIFFERENT SHOP' },
  }, overrides || {});
  let _err = null;
  try { await quiet(() => idx.initiateSTKPush.run(REQ(payload))); } catch (e) { _err = e; }
  if (!SENT.length && _err) LAST_ERR = (_err.message || String(_err));
  const body = SENT.length ? JSON.parse(SENT[SENT.length - 1]) : null;
  return body;
}

async function main() {
  console.log('\n════════════════════════════════════════════════════════════════════════════════');
  console.log('  THE M-PESA PROMPT NAMES THE SHOP');
  console.log('  The PIN dialog is Safaricom\'s and cannot be branded. The narrative is ours.');
  console.log('════════════════════════════════════════════════════════════════════════════════');

  section('0  HARNESS');
  check('H0-1', typeof idx.initiateSTKPush.run === 'function', 'the REAL initiateSTKPush handler is invocable');
  seed('KASS SHOP');
  const probe = await push();
  if (!probe) { blocked('H0-2', 'the gateway interceptor captured no payload — handler refused first: ' + LAST_ERR); return finish(); }
  ok('H0-2', 'the outgoing STK payload is captured, not sent (nothing leaves this machine)');
  check('H0-3', probe.method === 'M-PESA' && probe.currency === 'KES', 'it is a real STK payload (method + currency present)');

  section('1  WHAT THE BUYER READS');
  check('N1-1', typeof probe.narrative === 'string' && probe.narrative.length > 0, 'a narrative is sent');
  ok('N1-0', 'the string actually on the wire: "' + probe.narrative + '"');
  check('N1-2', !/SKN-|^SOKONI: /.test(probe.narrative),
    'it is NOT the payment reference any more — the "random code" is gone');
  check('N1-3', leads(probe.narrative, 'KASS SHOP'), 'the SHOP NAME leads the content');
  check('N1-4', /Powered by SOKONI/.test(probe.narrative), 'it says Powered by SOKONI');
  check('N1-5', /Bravilex/i.test(probe.narrative), 'it carries the Bravilex identity');
  check('N1-6', probe.api_ref && /SKN-/.test(probe.api_ref),
    'the reference still travels in api_ref — reconciliation is unaffected by the narrative change');

  section('2  THE NAME IS THE SERVER\'S, NOT THE BROWSER\'S');
  check('S2-1', probe.narrative.indexOf('TOTALLY DIFFERENT SHOP') === -1,
    'the shop name the CLIENT claimed in meta.sellerName is ignored');
  {
    /* The client named a different seller too. The server resolved through
       products/{id}.sellerUid, so the claim changed nothing. */
    seed('KASS SHOP');
    const forged = await push({ meta: { category: 'product', items: [{ productId: PRODUCT }],
      sellerUid: 'ATTACKER', sellerName: 'ATTACKER SHOP', serviceDesc: 'x' } });
    check('S2-2', !!forged && leads(forged.narrative, 'KASS SHOP') && !/ATTACKER/.test(forged.narrative),
      'a forged meta.sellerUid + meta.sellerName cannot rename the prompt');
  }
  {
    STORE._put('products', PRODUCT, { name: 'Item', price: 100, sellerUid: 'OTHER-SELLER', stock: 5 });
    STORE._put('shops', 'OTHER-SELLER', { name: 'THE REAL OWNER' });
    const moved = await push();
    check('S2-3', !!moved && /THE REAL OWNER/.test(moved.narrative),
      'change who OWNS the product and the prompt follows — it reads products/{id}.sellerUid');
    seed('KASS SHOP');
  }

  section('3  FAIL CLOSED — never name a shop we cannot prove');
  {
    seed(null);
    const noShop = await push();
    check('F3-1', !!noShop && !/KASS|undefined|null|SELLER|seller-stk/.test(noShop.narrative),
      'no shop document → no merchant claim: "' + (noShop && noShop.narrative) + '"');
    check('F3-2', !!noShop && /SOKONI/.test(noShop.narrative) && /Bravilex/i.test(noShop.narrative),
      '…the buyer still sees the platform and its owner');
  }
  {
    STORE._put('shops', SELLER, { name: '   ' });
    const blank = await push();
    check('F3-3', !!blank && leads(blank.narrative, 'SOKONI'), 'a blank shop name is not a name');
    seed('KASS SHOP');
  }
  {
    const noItems = await push({ meta: { category: 'product', serviceDesc: 'x' } });
    check('F3-4', !!noItems && !/KASS/.test(noItems.narrative),
      'no items to resolve from → no merchant claim, and the push still goes out');
  }
  check('F3-5', MI.narrativeFor({ resolved: false }) === 'SOKONI · a product of Bravilex',
    'the unresolved string names nobody it cannot prove');

  section('4  TWO CHANNELS, ONE AUTHORITY');
  {
    const on = MI.narrativeFor(idOf('KASS SHOP'), { channel: 'online' });
    const till = MI.narrativeFor(idOf('KASS SHOP'), { channel: 'till' });
    ok('C4-0', 'online : "' + on + '"');
    ok('C4-1', 'till   : "' + till + '"');
    check('C4-2', on !== till && /Till/.test(till), 'the till format is distinct and says Till');
    check('C4-3', /Powered by SOKONI/.test(on) && /Powered by SOKONI/.test(till), 'both carry the platform');
    check('C4-4', /Bravilex/i.test(on) && /Bravilex/i.test(till), 'both carry Bravilex');
    check('C4-5', leads(till, 'KASS SHOP') && leads(on, 'KASS SHOP'), 'both lead with the shop');
  }

  section('5  IT DEGRADES ON OUR TERMS, NOT THE GATEWAY\'S');
  {
    const long = 'MAMA NJERI FRESH GROCERIES HOUSEHOLD SUPPLIES AND GENERAL STORE';
    const n = MI.narrativeFor(idOf(long));
    check('D5-1', n.length <= MI.MAX_NARRATIVE, 'a long shop name still fits the budget (' + n.length + ' ≤ ' + MI.MAX_NARRATIVE + ')');
    check('D5-2', leads(n, long), '…and the SHOP NAME survives — the part that answers "am I paying the right person?"');
    const huge = 'X'.repeat(200);
    const hn = MI.narrativeFor(idOf(huge));
    check('D5-3', hn.length <= MI.MAX_NARRATIVE && leads(hn, 'X'),
      'a shop name longer than the whole budget keeps the name and drops our branding');
    check('D5-4', MI.narrativeFor(idOf('A B')).indexOf('a product of Bravilex') > -1,
      'a short name gets the FULL identity line');
  }

  section('6  THE ASK — a buyer approving money is ASKED, for a stated figure');
  /* An earlier revision of this suite asserted the OPPOSITE: that the narrative must not repeat
     the amount, because Safaricom renders it already. That was my reasoning, and SOKONI decided
     against it — a buyer should read a courteous sentence naming what they are approving, not a
     bare merchant string. The assertion is reversed here rather than quietly dropped, so the
     change of contract is visible in the record. */
  check('A6-1', /Please approve a payment of KES/.test(probe.narrative),
    'the narrative asks politely and names the figure: "Please approve a payment of KES …"');
  check('A6-2', probe.narrative.indexOf('250') > -1, '…and the figure is THIS payment\'s amount');
  check('A6-3', probe.amount === 250, '…while the authoritative amount still travels in the field Safaricom reads');
  {
    const other = await push({ amount: 4566, ref: 'SKN-' + Date.now() });
    check('A6-4', !!other && /Please approve a payment of KES 4,566/.test(other.narrative),
      'change the amount and the sentence follows it — "' + (other && other.narrative || '') + '"');
  }

  section('6b  ONE CHANNEL FOR POS AND TILL');
  {
    const t = MI.narrativeFor(idOf('KASS SHOP'), { channel: 'till', amountKES: 4566 });
    for (const c of ['pos', 'smartpos', 'terminal', 'TILL', 'Pos']) {
      check('C6-' + c, MI.narrativeFor(idOf('KASS SHOP'), { channel: c, amountKES: 4566 }) === t,
        '"' + c + '" resolves to the till wording — the two rails cannot drift apart');
    }
    check('C6-online', MI.narrativeFor(idOf('KASS SHOP'), { channel: 'online', amountKES: 4566 }) !== t,
      'online is still distinct (no "Till"), from the same ladder');
    const o = MI.narrativeFor(idOf('KASS SHOP'), { channel: 'online', amountKES: 4566 });
    check('C6-ask', /Please approve a payment of KES 4,566/.test(o) && /Please approve a payment of KES 4,566/.test(t),
      'ONLINE, TILL and POS all carry the same courteous ask');
    ok('C6-0', 'online : "' + o + '"');
    ok('C6-1', 'till   : "' + t + '"');
  }

  section('6c  IT CANNOT GARBLE A PAYMENT PROMPT');
  {
    /* The SIM toolkit draws BMP characters; 🛍️ 💰 📲 live above U+FFFF and arrive as boxes or
       corrupt the line. A garbled PAYMENT prompt is the moment a buyer decides not to trust the
       transaction, so astral code points are stripped wherever they came from. */
    check('E6-1', MI.sanitiseForHandset('KASS 🛍️💰📲 SHOP') === 'KASS SHOP',
      'astral emoji are stripped, along with the variation selectors they leave behind');
    check('E6-2', MI.narrativeFor(idOf('KASS 🛍️ SHOP'), { amountKES: 250 }).indexOf('\u{1F6CD}') === -1,
      'a shop that put an emoji in its own name cannot put one on the handset');
    check('E6-3', MI.narrativeFor(idOf('KASS SHOP'), { amountKES: 250 }).indexOf(MI.MARK) === 0,
      'the mark that IS used (' + MI.MARK + ', U+2714) is BMP and leads the line');
    check('E6-4', MI.MARK.codePointAt(0) <= 0xFFFF, '…and is provably inside the plane the handset can draw');
    check('E6-5', MI.sanitiseForHandset('a b\nc   d') === 'a b c d', 'control characters and runs of space are normalised');
    for (const n of [1, 4566, 99000, 150000]) {
      const s = MI.narrativeFor(idOf('MAMA NJERI FRESH GROCERIES AND GENERAL STORE'), { channel: 'till', amountKES: n });
      check('E6-len-' + n, s.length <= MI.MAX_NARRATIVE && /Please approve a payment of/.test(s),
        'KES ' + n + ' with a long shop name still fits (' + s.length + ') AND keeps the ask');
    }
  }

  section('7  SOURCE — one authority, no second opinion');
  const IDX = strip(fs.readFileSync(path.join(FN, 'index.js'), 'utf8'));
  check('R7-1', /narrative:\s*_merchantIdentity\.narrativeFor\(/.test(IDX), 'the payload takes its narrative from the shared authority');
  check('R7-2', !/narrative:\s*[`'"]SOKONI: /.test(IDX), 'the old ref-based narrative is gone from the source');
  /* The IDENTITY may never come from the client. The CHANNEL may: `meta.category` says whether
     this is a till sale or an online order, which selects wording and nothing else — a buyer who
     forged it would change "Till" to no "Till" and gain nothing. Narrowed to the claim that
     actually matters rather than dropped, and the amount is the server's own `amountKES`. */
  check('R7-3', !/resolveMerchantIdentity\([^)]*meta\.|narrativeFor\([^)]*meta\.sellerName/.test(IDX),
    'no path feeds client metadata into the IDENTITY');
  check('R7-4', /channelOf\(\(meta && meta\.category\)/.test(IDX) && /amountKES:\s*amountKES/.test(IDX),
    'the channel comes from the payment category and the amount from the server-validated figure');

  section('8  SABOTAGE');
  sab('X8-1', 'restoring the ref-based narrative',
    IDX.replace(/narrative:\s*_merchantIdentity\.narrativeFor\([^)]*\)/, 'narrative: `SOKONI: ${ref}`'),
    (s) => /narrative:\s*[`'"]SOKONI: /.test(s) && !/narrative:\s*_merchantIdentity/.test(s));
  sab('X8-2', 'letting the resolver fall back to a uid',
    strip(fs.readFileSync(path.join(FN, 'shared', 'merchant-identity.js'), 'utf8'))
      .replace('return unresolved(\'shop_has_no_name\');', 'return { resolved: true, name: sellerUid };'),
    (s) => /name:\s*sellerUid/.test(s));
  {
    const orig = MI.narrativeFor;
    MI.narrativeFor = () => 'SOKONI: SKN-DECOY';
    const out = await push();
    MI.narrativeFor = orig;
    check('X8-3', !!out && out.narrative === 'SOKONI: SKN-DECOY',
      'neutralising narrativeFor changes the string actually sent — the handler really calls it, it is not decoration');
  }
  {
    const after = await push();
    check('X8-R', !!after && leads(after.narrative, 'KASS SHOP'), 'POST-SABOTAGE — restored and correct again');
  }

  section('9  THE IN-APP STK PANEL — built long ago, and never reached');
  {
    const CO = fs.readFileSync(path.join(ROOT, 'checkout.html'), 'utf8');
    const COS = strip(CO);
    /* The panel's copy lives in markup, so it is read from the RAW file; the wiring is read
       from the stripped file, because the comment explaining the wiring names the very
       identifiers being searched for. */
    check('P9-1', /id="stkSteps"/.test(CO) && /id="stkStep1"/.test(CO) && /id="stkStep3"/.test(CO),
      'the three-step panel markup is present');
    check('P9-2', /📤 Sending STK Push/.test(CO) && /📱 Check Your Phone/.test(CO)
      && /Enter your M-PESA PIN when prompted/.test(CO),
      'it carries the emoji-forward copy that was built: "📤 Sending STK Push" → "📱 Check Your Phone"');
    check('P9-3', /\.stk-steps\{[^}]*display:\s*none/.test(CO),
      'it is display:none until something reveals it — which is why an unwired path shows nothing');

    /* THE DEFECT: only sendStkPush() ever revealed it. _placeOrderCore is the path the Pay
       button actually runs. */
    const core = (() => {
      const a = COS.indexOf('async function _placeOrderCore');
      if (a < 0) return null;
      const b = COS.indexOf('\nfunction ', a + 10);
      return b > a ? COS.slice(a, b) : COS.slice(a);
    })();
    if (core === null) { blocked('P9-4', 'could not isolate _placeOrderCore'); }
    else {
      check('P9-4', /_stkPanel\s*\(\s*1\b/.test(core) && /_stkPanel\s*\(\s*2\b/.test(core),
        'the LIVE checkout path now reveals and advances the panel (this is what was missing)');
      check('P9-5', /_stkPanel\s*\(\s*2\b[^)]*\)[\s\S]{0,200}enter your PIN on your phone/.test(core),
        'step 2 — "Check your phone" — fires exactly when the prompt has been sent');
      check('P9-8', /_stkPanel\s*\(\s*2\s*,\s*_authTotal\s*\)/.test(core),
        '…and it is handed the server-confirmed total, so the panel names the figure being approved');
    }
    check('P9-6', /function _stkPanel\s*\([\s\S]{0,1200}activateStkStep/.test(COS),
      'it drives the SAME activateStkStep the old path uses — not a second step engine that would drift');
    check('P9-7', /function _stkPanel\s*\([\s\S]{0,1200}catch/.test(COS),
      'and it is swallowed on failure — a decorative panel must never interrupt a payment');
    check('P9-9', /Please approve a payment of[\s\S]{0,120}enter your M-PESA PIN/.test(COS),
      'the panel asks in the same words the handset does — "Please approve a payment of KES …"');
    check('P9-10', /🔐|📲/.test(COS),
      'and it carries the emoji the handset cannot draw, on the surface that can');

    sab('P9-S1', 'unwiring the live path from the panel',
      core ? core.replace(/_stkPanel\s*\([^)]*\)/g, 'void 0') : '',
      (s) => !/_stkPanel\s*\(/.test(s));
    /* `activateStkStep` appears TWICE inside _stkPanel — the typeof guard and the call — so a
       single-occurrence replace leaves the second one inside the detector's window and the
       sabotage reads as undetected. Replace every occurrence, which is what "it stopped using
       the shared engine" actually means. */
    sab('P9-S2', 'giving it a second step engine instead of the shared one',
      COS.replace(/activateStkStep/g, 'myOwnStepEngine'),
      (s) => !/function _stkPanel\s*\([\s\S]{0,400}activateStkStep/.test(s));
  }

  section('10  NOT PROVEN HERE');
  console.log('  ○ U9-1   Whether IntaSend forwards `narrative` into what Safaricom finally renders is');
  console.log('           UNPROVEN and cannot be proven from a test harness. It needs ONE real push to a');
  console.log('           real handset. This suite proves SOKONI sends the right string, not that the');
  console.log('           carrier displays it.');
  console.log('  ○ U9-2   The Till/SPOS STK SENDER does not exist on this branch — `functions/shared/');
  console.log('           stk-gateway.js` and the pos-qr.js wiring are on slice/realtime-control-plane.');
  console.log('           The till FORMAT is built and certified above; it has no live caller here yet.');

  return finish();
}

function sab(id, what, mutated, detector) {
  let f; try { f = detector(mutated) === true; } catch (e) { return bad(id, what + ' — detector CRASHED', e.message); }
  return f ? ok(id, 'SABOTAGE ' + what + ' → detected') : bad(id, 'SABOTAGE ' + what + ' → NOT detected');
}

function finish() {
  section('SUMMARY');
  console.log('  passed  : ' + PASS + '\n  failed  : ' + FAIL + '\n  blocked : ' + BLOCKED);
  if (FAILURES.length) { console.log('\n  FAILURES:'); FAILURES.forEach((f) => console.log('   • ' + f)); }
  const green = FAIL === 0 && BLOCKED === 0;
  console.log('\n  ' + (green ? '✅ STK NARRATIVE: GREEN' : '❌ NOT GREEN') + '  (handset proof still outstanding — see section 9)');
  console.log('  Certification only. Nothing here deploys anything, and no prompt was sent.\n');
  clearTimeout(WATCHDOG);
  process.exit(green ? 0 : 1);
}

main().catch((e) => {
  console.log('\n  ✖ SUITE CRASHED — a crash is not a pass.\n    ' + (e && e.stack ? e.stack.split('\n').slice(0, 6).join('\n    ') : e));
  clearTimeout(WATCHDOG); process.exit(2);
});
