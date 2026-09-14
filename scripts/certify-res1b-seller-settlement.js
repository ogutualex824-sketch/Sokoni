'use strict';
/* ════════════════════════════════════════════════════════════════════════════════════════════
   RES-1b — SELLER SETTLEMENT INTEGRITY.

   THE INVARIANT
   Changing a browser-controlled delivery fee must not change the seller's settlement.
   Its converse must hold too: a legitimate authoritative change must propagate.

   WHY THIS SUITE IS SMALLER THAN THE FINDING THAT PROMPTED IT
   RES-1b was reported as a live money defect — "a browser number moves the seller's settlement".
   The rules census overturned that. `order-settlement._grossCents` does subtract
   `orders/{id}.deliveryFee` from the seller's gross, and checkout.html did write that field from
   the browser, but the DEPLOYED rules permit a buyer to change only
   ['status','cancelReason','updatedAt','review'] — so the write was refused every time, and
   `.catch(function(){})` swallowed the refusal. The defect was an inference drawn from a producer
   plus a consumer without checking the layer between them.

   So this gate is a cleanup and a regression lock, not a repair:
     · the dead client write is gone, because dead code aimed at a settlement field is a trap
       waiting for somebody to widen an allowlist while fixing something unrelated
     · the success overlay now shows the server-authoritative figure rather than delivery-hub.js's
       browser calculation on a different rate card
     · and the protection that was already there is pinned, so it cannot be lost silently

   THE BOUNDARY IS EVALUATED, NOT READ
   Section 2 does not grep the rules. It fetches the ruleset CURRENTLY DEPLOYED to
   sokoni-aeb26 and submits test cases to the Firebase Rules engine
   (firebaserules.googleapis.com :test), which is the same evaluator that runs in production.
   Reading rules source would prove what someone intended; this proves what the live boundary
   does. It needs network + gcloud credentials, and when they are absent it reports BLOCKED —
   never PASS, because an unevaluated boundary is not a proven one.

   Run:  node scripts/certify-res1b-seller-settlement.js
   ════════════════════════════════════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const FN = path.join(ROOT, 'functions');
const PROJECT = 'sokoni-aeb26';

const WATCHDOG = setTimeout(() => {
  process.stdout.write('\n  \u2716 WATCHDOG — the suite did not finish in 180s. Failing closed.\n');
  process.exit(2);
}, 180000);

let PASS = 0, FAIL = 0, BLOCKED = 0;
const FAILURES = [];
const ok = (id, m) => { PASS++; console.log('  \u2714 ' + id.padEnd(9) + m); return true; };
const bad = (id, m, x) => { FAIL++; FAILURES.push(id + ' — ' + m); console.log('  \u2716 ' + id.padEnd(9) + m + (x ? '\n             ' + String(x).slice(0, 260) : '')); return false; };
const blocked = (id, m) => { BLOCKED++; FAILURES.push(id + ' — BLOCKED: ' + m); console.log('  \u26a0 ' + id.padEnd(9) + 'BLOCKED: ' + m); return false; };
const check = (id, c, m, x) => (c ? ok(id, m) : bad(id, m, x));
const section = (t) => console.log('\n' + t + '\n' + '─'.repeat(Math.max(t.length, 78)));
const strip = (s) => s.replace(/<!--[\s\S]*?-->/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/[^\n]*$/gm, ' ');

/* ── Google API plumbing ───────────────────────────────────────────────────────────────────── */
function accessToken() {
  try {
    return execSync('gcloud auth print-access-token', {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      env: Object.assign({}, process.env, {
        CLOUDSDK_PYTHON: 'C:\\Users\\USER1\\AppData\\Local\\Google\\Cloud SDK\\google-cloud-sdk\\platform\\bundledpython\\python.exe',
      }),
    }).trim();
  } catch (_) { return ''; }
}

function api(method, urlPath, token, body) {
  return new Promise((resolve) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'firebaserules.googleapis.com', path: urlPath, method,
      headers: Object.assign({
        Authorization: 'Bearer ' + token,
        'x-goog-user-project': PROJECT,
      }, payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
    }, (res) => {
      let d = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { d += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (_) {} resolve({ status: res.statusCode, body: j, raw: d }); });
    });
    req.on('error', () => resolve({ status: 0, body: null, raw: 'network error' }));
    if (payload) req.write(payload);
    req.end();
  });
}

/* One order-update request, as the live evaluator sees it. */
function orderUpdate(uid, before, after, tokenClaims) {
  return {
    request: {
      auth: { uid, token: Object.assign({ email_verified: true }, tokenClaims || {}) },
      method: 'update',
      path: '/databases/(default)/documents/orders/ORDER1',
      time: '2026-09-14T00:00:00Z',
      resource: { data: after },
    },
    resource: { data: before },
  };
}

const BASE = Object.freeze({
  uid: 'buyer1', buyerUid: 'buyer1', sellerUid: 'seller1', assignedDriverUid: 'rider1',
  status: 'paid', orderTotal: 1000, total: 1000, deliveryFee: 100,
});
const withFields = (o) => Object.assign({}, BASE, o);

async function main() {
  console.log('\n════════════════════════════════════════════════════════════════════════════════');
  console.log('  RES-1b — SELLER SETTLEMENT INTEGRITY');
  console.log('  A browser delivery fee must not move the seller\'s gross. Proven at the LIVE boundary.');
  console.log('════════════════════════════════════════════════════════════════════════════════');

  /* ── 1. The consumer, and the converse ───────────────────────────────────────────────────── */
  section('1  THE CONSUMER — what the seller is actually paid on');
  const OS = require(path.join(FN, 'order-settlement.js'));
  check('C1-1', typeof OS._grossCents === 'function', 'order-settlement exposes the gross calculation under test');
  {
    const g = (fee) => OS._grossCents({ orderTotal: 1000, deliveryFee: fee });
    check('C1-2', g(100) === 90000, 'gross = (total − deliveryFee) × 100 → KES 1000 − 100 = 90000 cents');
    check('C1-3', g(0) === 100000, 'no delivery → the seller keeps the whole total');
    /* THE CONVERSE the gate requires: a legitimate authoritative change MUST propagate. */
    check('C1-4', g(250) - g(100) === -15000,
      'a LEGITIMATE delivery-fee change propagates: +KES 150 fee → −15000 cents of seller gross');
    check('C1-5', g(5000) === 0 && OS._grossCents({ orderTotal: 10, deliveryFee: 99 }) === 0,
      'gross floors at zero — a fee larger than the total never produces a negative settlement');
  }

  /* ── 2. The boundary, EVALUATED ──────────────────────────────────────────────────────────── */
  section('2  THE DEPLOYED RULES BOUNDARY — evaluated by the live engine, not read');
  const token = accessToken();
  if (!token) {
    blocked('B2', 'no gcloud access token — the live boundary could not be evaluated. '
      + 'An unevaluated boundary is not a proven one, so this is BLOCKED, not passed.');
  } else {
    const rel = await api('GET', '/v1/projects/' + PROJECT + '/releases/cloud.firestore', token);
    const rulesetName = rel.body && rel.body.rulesetName;
    if (!rulesetName) {
      blocked('B2', 'could not read the deployed ruleset name: ' + String(rel.raw).slice(0, 160));
    } else {
      ok('B2-0', 'deployed ruleset: ' + rulesetName.split('/').pop()
        + '  (updated ' + (rel.body.updateTime || '?') + ')');
      const rs = await api('GET', '/v1/' + rulesetName, token);
      const files = (rs.body && rs.body.source && rs.body.source.files) || [];
      const source = files.map((f) => f.content).join('\n');
      if (!source) {
        blocked('B2', 'deployed ruleset source came back empty');
      } else {
        ok('B2-1', 'fetched the LIVE source (' + source.length + ' bytes) — not firestore.rules from this worktree');

        /* Every case names a persona and a mutation. The forbidden ones must DENY; the control
           must ALLOW, or the rule would be refusing everybody and proving nothing. */
        const cases = [
          ['D-buyer', 'DENY', 'buyer1', 'a BUYER raising deliveryFee',
            withFields({ deliveryFee: 999 })],
          ['D-buyerLow', 'DENY', 'buyer1', 'a BUYER lowering deliveryFee (inflates seller gross)',
            withFields({ deliveryFee: 0 })],
          ['D-seller', 'DENY', 'seller1', 'the SELLER raising their own deliveryFee',
            withFields({ deliveryFee: 999 })],
          ['D-rider', 'DENY', 'rider1', 'the assigned RIDER changing deliveryFee',
            withFields({ deliveryFee: 999 })],
          ['D-smuggle', 'DENY', 'buyer1', 'a BUYER smuggling deliveryFee alongside an ALLOWED key',
            withFields({ status: 'cancelled', cancelReason: 'x', updatedAt: 1, deliveryFee: 999 })],
          ['D-total', 'DENY', 'buyer1', 'a BUYER changing orderTotal instead',
            withFields({ orderTotal: 1 })],
        ];
        const controls = [
          ['A-cancel', 'ALLOW', 'buyer1', 'CONTROL — a BUYER cancelling with only permitted keys',
            withFields({ status: 'cancelled', cancelReason: 'x', updatedAt: 1 })],
          ['A-seller', 'ALLOW', 'seller1', 'CONTROL — the SELLER setting a permitted status note',
            withFields({ status: 'processing', sellerNote: 'packing', updatedAt: 1 })],
        ];

        const all = cases.concat(controls);
        const suite = {
          source: { files: [{ name: 'firestore.rules', content: source }] },
          testSuite: { testCases: all.map(([, exp, uid, , after]) => orderUpdate(uid, BASE, after) && Object.assign({ expectation: exp }, orderUpdate(uid, BASE, after))) },
        };
        const res = await api('POST', '/v1/projects/' + PROJECT + ':test', token, suite);
        const results = (res.body && res.body.testResults) || [];
        if (results.length !== all.length) {
          blocked('B2-2', 'the evaluator returned ' + results.length + ' results for ' + all.length
            + ' cases: ' + String(res.raw).slice(0, 200));
        } else {
          ok('B2-2', 'the live engine evaluated all ' + all.length + ' cases');
          all.forEach(([id, exp, , what], i) => {
            const state = results[i].state;
            check(id, state === 'SUCCESS',
              what + ' \u2192 ' + exp + (state === 'SUCCESS' ? '' : '  (engine said the opposite: ' + state + ')'));
          });

          /* THE HARNESS MUST BE ABLE TO FAIL. Invert one expectation and require the engine to
             disagree — otherwise every SUCCESS above could mean "the evaluator rubber-stamps". */
          const inverted = {
            source: suite.source,
            testSuite: { testCases: [Object.assign({ expectation: 'ALLOW' }, orderUpdate('buyer1', BASE, withFields({ deliveryFee: 999 })))] },
          };
          const ires = await api('POST', '/v1/projects/' + PROJECT + ':test', token, inverted);
          const istate = ((ires.body && ires.body.testResults) || [{}])[0].state;
          check('B2-CTL', istate === 'FAILURE',
            'CONTROL — asserting that the same forbidden write is ALLOWED makes the engine report FAILURE '
            + '(' + istate + '), so SUCCESS above is a real verdict');
        }
      }
    }
  }

  /* ── 3. The dead writer is gone ──────────────────────────────────────────────────────────── */
  section('3  THE DEAD CLIENT WRITER — removed, not repaired');
  const CO_RAW = fs.readFileSync(path.join(ROOT, 'checkout.html'), 'utf8');
  const CO = strip(CO_RAW);
  const clientOrderWrites = (s) => [...s.matchAll(/updateDoc\s*\([^;]{0,400}?["']orders["'][^;]{0,300}?\)/gs)].map((m) => m[0]);
  check('W3-1', clientOrderWrites(CO).length === 0,
    'checkout.html performs NO client updateDoc on orders/{id}', JSON.stringify(clientOrderWrites(CO)).slice(0, 200));
  check('W3-2', !/deliveryFee:\s*result\.deliveryFee/.test(CO),
    'the browser no longer assigns orders.deliveryFee from delivery-hub.js');
  check('W3-3', /updateDoc\s*\([^;]{0,400}?["']orders["']/s.test('m.updateDoc(m.doc(db,"orders",id),{deliveryFee:1})'),
    'CONTROL — the client-write detector fires when such a write IS present');

  /* ── 4. The overlay shows the authoritative figure ───────────────────────────────────────── */
  section('4  THE SUCCESS OVERLAY — the fee shown is the fee charged');
  check('O4-1', /df\.textContent\s*=\s*['"]Delivery fee: KES ['"]\s*\+\s*Number\(deliveryFee\)/.test(CO),
    'the overlay renders the page\'s server-quoted deliveryFee');
  check('O4-2', !/Number\(result\.deliveryFee/.test(CO),
    'it no longer renders delivery-hub.js\'s browser figure');
  check('O4-3', /_deliveryQuoteId\s*&&\s*Number\(deliveryFee\)\s*>\s*0/.test(CO),
    'it is shown only when a server quote backs it');
  check('O4-4', /else\s*\{\s*df\.textContent\s*=\s*['"]['"]\s*;?\s*\}/.test(CO),
    '…and otherwise shows NOTHING — an unknown money figure rendered as 0 would be a defect');
  {
    /* Gate C's guarantee that this variable has authoritative provenance must still hold, or the
       overlay is honest about the wrong number. */
    const rhs = [...CO.matchAll(/(^|[^\w.$])deliveryFee\s*=\s*([^;\n]+)/g)].map((m) => m[2].trim());
    check('O4-5', rhs.length > 0 && rhs.every((r) => /^0$/.test(r) || /^quote\.customerChargeKES$/.test(r)),
      'every assignment to deliveryFee is still 0 or the server quote — ' + JSON.stringify(rhs));
  }

  /* ── 5. Sabotage ─────────────────────────────────────────────────────────────────────────── */
  section('5  SABOTAGE — per guard');
  /* Anchor on LIVE CODE, not on a comment: `CO` is stripped, so a comment anchor would silently
     match nothing and the sabotage would "pass" by never having been applied. */
  sab('X5-1', 'restoring the client write to orders.deliveryFee',
    CO.replace(/const di\s*=\s*document\.getElementById\('successDeliveryInfo'\);/,
      'm.updateDoc(m.doc(window.firebaseDB,"orders",orderId),{ deliveryFee: result.deliveryFee });\n'
      + "      const di  = document.getElementById('successDeliveryInfo');"),
    (s) => clientOrderWrites(s).length > 0);
  sab('X5-2', 'pointing the overlay back at the browser figure',
    CO.replace(/Number\(deliveryFee\)\.toLocaleString\(\)/, 'Number(result.deliveryFee||0).toLocaleString()'),
    (s) => /Number\(result\.deliveryFee/.test(s));
  sab('X5-3', 'showing 0 instead of nothing when no quote backs the fee',
    CO.replace(/else\s*\{\s*df\.textContent\s*=\s*['"]['"]\s*;?\s*\}/, "else { df.textContent = 'Delivery fee: KES 0'; }"),
    (s) => !/else\s*\{\s*df\.textContent\s*=\s*['"]['"]\s*;?\s*\}/.test(s));
  sab('X5-4', 'letting the page compute its own delivery fee again',
    CO.replace('deliveryFee = quote.customerChargeKES;', 'deliveryFee = Math.round(80 + zone.distanceKm * 15);'),
    (s) => [...s.matchAll(/(^|[^\w.$])deliveryFee\s*=\s*([^;\n]+)/g)]
      .map((m) => m[2].trim()).some((r) => !/^0$/.test(r) && !/^quote\.customerChargeKES$/.test(r)));

  return finish();
}

function sab(id, what, mutated, detector) {
  let f;
  try { f = detector(mutated) === true; } catch (e) { return bad(id, what + ' — detector CRASHED', e.message); }
  return f ? ok(id, 'SABOTAGE ' + what + ' \u2192 detected')
           : bad(id, 'SABOTAGE ' + what + ' \u2192 NOT detected');
}

function finish() {
  section('SUMMARY');
  console.log('  passed  : ' + PASS + '\n  failed  : ' + FAIL + '\n  blocked : ' + BLOCKED);
  if (FAILURES.length) { console.log('\n  FAILURES:'); FAILURES.forEach((f) => console.log('   • ' + f)); }
  const green = FAIL === 0 && BLOCKED === 0;
  console.log('\n  ' + (green ? '\u2705 RES-1b: GREEN' : '\u274c RES-1b: NOT GREEN')
    + '  (blocked counts as not-green — an unevaluated boundary is not a proven one)');
  console.log('  Certification only. Nothing here deploys or writes anything.\n');
  clearTimeout(WATCHDOG);
  process.exit(green ? 0 : 1);
}

main().catch((e) => {
  console.log('\n  \u2716 SUITE CRASHED — a crash is not a pass.\n    '
    + (e && e.stack ? e.stack.split('\n').slice(0, 5).join('\n    ') : e));
  clearTimeout(WATCHDOG); process.exit(2);
});
