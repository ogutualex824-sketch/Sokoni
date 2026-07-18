#!/usr/bin/env node
/**
 * certify-payment.js — PRODUCTION PAYMENT CERTIFICATION TRACE
 *
 * READ-ONLY. Issues GET only. Never writes, updates or deletes anything.
 *
 * Given the api_ref of one real production payment, this reconciles every artifact the
 * transaction should have produced, across all six certification stages, and reports
 * PASS / FAIL / UNVERIFIED per stage with the evidence it actually read.
 *
 *   node scripts/certify-payment.js <paymentRef>
 *   node scripts/certify-payment.js <paymentRef> --json      # machine-readable
 *
 * Governing rule: production readiness is demonstrated by successful end-to-end
 * operation, not by successful deployment. Nothing here infers. Every line reports a
 * document that was read, or says it could not read one.
 *
 * ── The endpoint discriminator ────────────────────────────────────────────────
 * Two IntaSend handlers exist and only one runs the business flow:
 *
 *   intasendWebhook  -> updates payments/{ref}, writes commissionLedger/{ref}.
 *                       Sets `webhookReceivedAt` on the payment document.
 *   webhookIntasend  -> appends to webhookPayments and nothing else. No order,
 *                       no ledger, no settlement. Returns 200 either way.
 *
 * Which one IntaSend calls is a dashboard setting, invisible to this repo. But
 * `webhookReceivedAt` is written ONLY by intasendWebhook, so its presence after a real
 * payment proves the correct endpoint is configured — and its absence alongside a
 * webhookPayments row proves the wrong one is. Stage 1 reports this explicitly.
 *
 * Auth: same approach as scripts/audit-payment-integrity.js — mint a short-lived token
 * from the already-authenticated Firebase CLI and read over the Firestore REST API.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');

const PROJECT = process.env.GCLOUD_PROJECT || 'sokoni-aeb26';
const REF = process.argv.find((a) => !a.startsWith('-') && a !== process.argv[0] && a !== process.argv[1]);
const JSON_OUT = process.argv.includes('--json');

if (!REF) {
  console.error('\n  usage: node scripts/certify-payment.js <paymentRef> [--json]\n');
  console.error('  <paymentRef> is the api_ref used at checkout — the payments/ document id.\n');
  process.exit(2);
}

/* ── Auth (see scripts/audit-payment-integrity.js for the full rationale) ── */
const CLI_CLIENT_ID = '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com';
const CLI_CLIENT_SECRET = 'j9iVZfS8kkCEFUPaAeJV0sAi';

function cliRefreshToken() {
  const f = path.join(os.homedir(), '.config', 'configstore', 'firebase-tools.json');
  if (!fs.existsSync(f)) return null;
  try { return (JSON.parse(fs.readFileSync(f, 'utf8')).tokens || {}).refresh_token || null; }
  catch (e) { return null; }
}

function accessToken(refresh) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({
      client_id: CLI_CLIENT_ID, client_secret: CLI_CLIENT_SECRET,
      refresh_token: refresh, grant_type: 'refresh_token',
    }).toString();
    const req = https.request({
      hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let d = ''; res.on('data', (c) => d += c);
      res.on('end', () => {
        try {
          const o = JSON.parse(d);
          o.access_token ? resolve(o.access_token) : reject(new Error('token mint failed: ' + d.slice(0, 200)));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject); req.write(body); req.end();
  });
}

/* ── READ-ONLY Firestore REST ── */
function getDoc(token, docPath) {
  return new Promise((resolve) => {
    https.get({
      hostname: 'firestore.googleapis.com',
      path: `/v1/projects/${PROJECT}/databases/(default)/documents/${docPath}`,
      headers: { Authorization: 'Bearer ' + token },
    }, (res) => {
      let d = ''; res.on('data', (c) => d += c);
      res.on('end', () => {
        if (res.statusCode === 404) return resolve(null);
        if (res.statusCode !== 200) return resolve({ __err: `HTTP ${res.statusCode}: ${d.slice(0, 160)}` });
        try { resolve(JSON.parse(d)); } catch (e) { resolve({ __err: e.message }); }
      });
    }).on('error', (e) => resolve({ __err: e.message }));
  });
}

function runQuery(token, collection, field, op, value) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: collection }],
        where: { fieldFilter: { field: { fieldPath: field }, op, value: { stringValue: value } } },
        limit: 25,
      },
    });
    const req = https.request({
      hostname: 'firestore.googleapis.com',
      path: `/v1/projects/${PROJECT}/databases/(default)/documents:runQuery`,
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token, 'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let d = ''; res.on('data', (c) => d += c);
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve({ __err: `HTTP ${res.statusCode}: ${d.slice(0, 160)}` });
        try {
          const rows = JSON.parse(d).filter((r) => r.document).map((r) => r.document);
          resolve(rows);
        } catch (e) { resolve({ __err: e.message }); }
      });
    });
    req.on('error', (e) => resolve({ __err: e.message }));
    req.write(body); req.end();
  });
}

/* Firestore REST values -> plain JS */
function val(v) {
  if (!v || typeof v !== 'object') return v;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('nullValue' in v) return null;
  if ('mapValue' in v) return flat(v.mapValue.fields || {});
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(val);
  return v;
}
const flat = (f) => Object.fromEntries(Object.entries(f || {}).map(([k, v]) => [k, val(v)]));

/* ── Reporting ── */
const stages = [];
let cur = null;
const stage = (n, title) => { cur = { n, title, checks: [], verdict: 'PASS' }; stages.push(cur); };
const rec = (state, msg, detail) => {
  cur.checks.push({ state, msg, detail });
  if (state === 'FAIL') cur.verdict = 'FAIL';
  else if (state === 'UNVERIFIED' && cur.verdict === 'PASS') cur.verdict = 'UNVERIFIED';
};
const PASS = (m, d) => rec('PASS', m, d);
const FAIL = (m, d) => rec('FAIL', m, d);
const UNV = (m, d) => rec('UNVERIFIED', m, d);

(async () => {
  const refresh = cliRefreshToken();
  if (!refresh) {
    console.error('\n  No Firebase CLI credentials found. Run: npx firebase-tools login\n');
    process.exit(2);
  }
  const token = await accessToken(refresh);

  /* ══ STAGE 1 — COLLECTION ══ */
  stage(1, 'COLLECTION — customer payment reached the platform');
  const payRaw = await getDoc(token, `payments/${encodeURIComponent(REF)}`);
  let pay = null;
  if (!payRaw) {
    FAIL(`payments/${REF} does not exist`, 'No payment record. Either the ref is wrong, or checkout never created it.');
  } else if (payRaw.__err) {
    UNV('could not read payments/' + REF, payRaw.__err);
  } else {
    pay = flat(payRaw.fields);
    PASS('payment document exists', `payments/${REF}`);

    (pay.status === 'COMPLETE' ? PASS : FAIL)(`status = ${pay.status}`,
      pay.status === 'COMPLETE' ? null : 'Expected COMPLETE. Payment did not confirm.');

    if (pay.confirmedAmount != null) PASS(`confirmed amount = ${pay.confirmedAmount}`);
    else FAIL('confirmedAmount missing', 'The webhook never wrote the provider-confirmed amount.');

    /* THE ENDPOINT DISCRIMINATOR — only intasendWebhook writes this field. */
    if (pay.webhookReceivedAt) {
      PASS('webhookReceivedAt present -> intasendWebhook fired',
        'Correct endpoint is configured in the IntaSend dashboard.');
    } else {
      FAIL('webhookReceivedAt MISSING -> intasendWebhook did NOT fire',
        'The IntaSend dashboard is very likely pointing at /webhookIntasend, which records a ' +
        'webhookPayments row and creates NO order, NO ledger entry and NO settlement. ' +
        'Repoint it at /intasendWebhook and re-run this trace.');
    }
    if (pay.intasendState) PASS(`provider state = ${pay.intasendState}`);
  }

  /* Cross-check: did the WRONG endpoint receive it instead? */
  const wrong = await runQuery(token, 'webhookPayments', 'reference', 'EQUAL', REF);
  if (Array.isArray(wrong) && wrong.length) {
    FAIL(`${wrong.length} row(s) in webhookPayments for this ref`,
      'This is the no-op handler. Confirms the wrong endpoint is configured.');
  } else if (Array.isArray(wrong)) {
    PASS('no webhookPayments rows (wrong-endpoint sink is empty)');
  }

  /* ══ STAGE 2 — ORDER ENGINE ══ */
  stage(2, 'ORDER ENGINE — order created exactly once');
  let orders = await runQuery(token, 'orders', 'paymentRef', 'EQUAL', REF);
  if (orders && orders.__err) {
    UNV('could not query orders by paymentRef', orders.__err + ' (a composite index may be required)');
    orders = [];
  }
  if (!orders.length) {
    /* Fall back: the client writes the order under its own id and may key it differently. */
    const alt = await runQuery(token, 'orders', 'ref', 'EQUAL', REF);
    if (Array.isArray(alt) && alt.length) orders = alt;
  }
  if (!orders.length) {
    FAIL('no order found for this payment reference',
      'NOTE: order creation is CLIENT-SIDE (checkout.html:2431). If the browser closed or lost ' +
      'network after payment but before the write, money moved with nothing to fulfil. ' +
      'Confirm manually before concluding the order is genuinely absent.');
  } else if (orders.length > 1) {
    FAIL(`${orders.length} orders reference this payment`, 'Duplicate order creation — must be exactly one.');
  } else {
    const o = flat(orders[0].fields);
    const oid = orders[0].name.split('/').pop();
    PASS('exactly one order', `orders/${oid}`);
    if (o.escrow) {
      const held = o.escrow.held;
      (Number(held) > 0 ? PASS : FAIL)(`escrow.held = ${held}`,
        Number(held) > 0 ? null : 'Payment confirmed but escrow holds 0 — settlement will compute nothing.');
    } else UNV('order has no escrow block');
    if (o.status) PASS(`order status = ${o.status}`);
    if (pay && o.total != null && Number(o.total) !== Number(pay.confirmedAmount)) {
      FAIL(`order total ${o.total} != confirmed amount ${pay.confirmedAmount}`, 'Amount mismatch.');
    } else if (o.total != null) PASS(`order total matches confirmed amount (${o.total})`);
  }

  /* ══ STAGE 3 — LEDGER ══ */
  stage(3, 'LEDGER — commission and balances');
  const ledRaw = await getDoc(token, `commissionLedger/${encodeURIComponent(REF)}`);
  if (!ledRaw) {
    FAIL(`commissionLedger/${REF} does not exist`, 'No commission entry. Settlement has nothing to derive from.');
  } else if (ledRaw.__err) {
    UNV('could not read commissionLedger', ledRaw.__err);
  } else {
    const L = flat(ledRaw.fields);
    PASS('commission ledger entry exists (deterministic id = one per payment)');
    const gross = Number(L.serviceTotal), cut = Number(L.sokoniCut), net = Number(L.providerNet);
    if (Number.isFinite(gross) && Number.isFinite(cut) && Number.isFinite(net)) {
      (cut + net === gross ? PASS : FAIL)(`balance: ${cut} + ${net} = ${cut + net} vs gross ${gross}`,
        cut + net === gross ? null : 'LEDGER DOES NOT BALANCE.');
    } else UNV('ledger amounts not all numeric', JSON.stringify({ gross, cut, net }));

    if (L.commissionPct === null || L.commissionPct === undefined) {
      FAIL('commissionPct is null/absent',
        'calculateCommission failed and the entry was flagged for manual review. Check commissionReviewQueue.');
    } else {
      PASS(`commission rate recorded = ${L.commissionPct}`);
      if (Number(L.commissionPct) === 0 && cut > 0) {
        FAIL('rate recorded as 0 against a non-zero cut', 'Known prior defect — rate/field mismatch.');
      }
    }
    if (pay && Number(L.serviceTotal) !== Number(pay.confirmedAmount)) {
      FAIL(`ledger gross ${L.serviceTotal} != confirmed amount ${pay.confirmedAmount}`);
    }
  }
  const rq = await runQuery(token, 'commissionReviewQueue', 'ref', 'EQUAL', REF);
  if (Array.isArray(rq) && rq.length) {
    FAIL(`${rq.length} commissionReviewQueue entry(s)`, 'Commission calculation FAILED and needs manual rate application.');
  } else if (Array.isArray(rq)) PASS('not flagged for manual commission review');

  /* ══ STAGE 4 — SETTLEMENT ══ */
  stage(4, 'SETTLEMENT — merchant amount and payout eligibility');
  let settled = false;
  for (const c of ['settlements', 'settlementQueue', 'payouts']) {
    const rows = await runQuery(token, c, 'ref', 'EQUAL', REF);
    if (Array.isArray(rows) && rows.length) {
      settled = true;
      PASS(`${rows.length} row(s) in ${c}`);
      rows.forEach((r) => {
        const s = flat(r.fields);
        if (s.amount != null) {
          (Number(s.amount) >= 0 ? PASS : FAIL)(`${c} amount = ${s.amount}`,
            Number(s.amount) >= 0 ? null : 'NEGATIVE settlement amount.');
        }
        if (s.status) PASS(`${c} status = ${s.status}`);
      });
      if (rows.length > 1) FAIL(`duplicate settlement eligibility in ${c} (${rows.length} rows)`);
    }
  }
  if (!settled) {
    UNV('no settlement record found',
      'RC1 pilot uses a MANUAL payout workflow, so this may be correct at this stage. ' +
      'Verify against the manual settlement process rather than treating as a defect.');
  }

  /* ══ STAGE 5 — NOTIFICATIONS ══ */
  stage(5, 'NOTIFICATIONS — buyer, seller, receipt, email, SMS');
  let anyNotif = false;
  for (const c of ['notifications', 'notificationLog', 'emailLog', 'smsLog', 'receipts']) {
    const rows = await runQuery(token, c, 'ref', 'EQUAL', REF);
    if (Array.isArray(rows) && rows.length) { anyNotif = true; PASS(`${rows.length} row(s) in ${c}`); }
    else if (Array.isArray(rows)) UNV(`no rows in ${c}`, 'may key on orderId rather than payment ref');
  }
  if (!anyNotif) {
    UNV('no notification artifacts keyed on the payment ref',
      'Notifications are likely keyed on orderId or uid. Verify delivery manually (inbox, handset) ' +
      'and treat this as UNVERIFIED, not as proof of non-delivery.');
  }

  /* ══ STAGE 6 — RECONCILIATION ══ */
  stage(6, 'RECONCILIATION — provider id ties to internal records');
  if (pay) {
    if (pay.checkoutId || pay.intasendInvoiceId) {
      PASS(`provider transaction id recorded = ${pay.checkoutId || pay.intasendInvoiceId}`);
    } else UNV('no provider transaction id on the payment document', 'cannot tie to the IntaSend dashboard');
    if (pay.uid) PASS(`payment bound to uid ${pay.uid}`);
    else FAIL('payment has no uid', 'cannot attribute to a buyer.');
  } else UNV('payment document unavailable — reconciliation cannot run');

  /* ── Report ── */
  if (JSON_OUT) { console.log(JSON.stringify({ ref: REF, stages }, null, 2)); process.exit(0); }

  console.log(`\n  PAYMENT CERTIFICATION TRACE — ref ${REF}   (project ${PROJECT}, READ-ONLY)\n`);
  for (const s of stages) {
    console.log(`  ── STAGE ${s.n}: ${s.title}   [${s.verdict}]`);
    for (const c of s.checks) {
      console.log(`     ${c.state.padEnd(11)}${c.msg}`);
      if (c.detail) c.detail.match(/.{1,84}(\s|$)/g).forEach((l) => console.log(`                 ${l.trim()}`));
    }
    console.log('');
  }
  const failed = stages.filter((s) => s.verdict === 'FAIL');
  const unv = stages.filter((s) => s.verdict === 'UNVERIFIED');
  console.log('  ' + (failed.length
    ? `CERTIFICATION FAILED — ${failed.length} stage(s) failed: ${failed.map((s) => s.n).join(', ')}`
    : unv.length
      ? `CERTIFICATION INCOMPLETE — ${unv.length} stage(s) unverified: ${unv.map((s) => s.n).join(', ')}`
      : 'CERTIFICATION PASSED — all six stages verified against production records.'));
  console.log('  UNVERIFIED means this tool could not read the evidence — never that the step failed.\n');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('\n  ERROR: ' + e.message + '\n'); process.exit(2); });
