#!/usr/bin/env node
'use strict';
/* AdminOS Finance → Receipts (owner 2026-10-03)
     V1  admin-os.html: one nav entry, one panel, the module loaded after sokoni-aos.js; sokoni-aos.js untouched
     V2  the ONLY callables are adminSearchReceipts (read, audited server-side) and adminRetryReceiptFailures (Super Admin);
         no Firestore access to receipts from the browser
     V3  the retry button is hidden unless the token carries superAdmin
     V4  a failed load says it is NOT an empty result; an empty search says "No receipt matches"
     V5  rendering (real card()): every field escaped (no raw HTML from data); method null → "—"; B2B deduction shown as
         a deduction, not as the SOKONI fee; history rows render in order
   node scripts/test-aos-receipts.js */
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'admin-os.html'), 'utf8');
const SRC = fs.readFileSync(path.join(ROOT, 'sokoni-aos-receipts.js'), 'utf8');
let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (ok || d === undefined ? '' : '  -> ' + JSON.stringify(d).slice(0, 200))); ok ? pass++ : fail++; };

ck('V1 admin-os.html: one Receipts nav entry, one panel-receipts, module after sokoni-aos.js',
  (HTML.match(/data-section="receipts"/g) || []).length === 1 && (HTML.match(/id="panel-receipts"/g) || []).length === 1
  && HTML.indexOf('src="sokoni-aos-receipts.js"') > HTML.indexOf('src="sokoni-aos.js"'));
const calls = (SRC.match(/callable\('([A-Za-z]+)'\)/g) || []).map((m) => m.slice(10, -2));
ck('V2 only adminSearchReceipts + adminRetryReceiptFailures are called; no direct Firestore read of receipts',
  calls.length && calls.every((c) => c === 'adminSearchReceipts' || c === 'adminRetryReceiptFailures') && !/firestore\(\)/.test(SRC) && !/collection\(/.test(SRC), calls);
ck('V3 the retry button starts hidden and is shown only for claims.superAdmin === true',
  /id="aosRcRetry" hidden/.test(SRC) && /t\.claims\.superAdmin === true\) \{\s*var b = host\.querySelector\('#aosRcRetry'\); b\.hidden = false;/.test(SRC));
ck('V4 failed load ≠ empty result; empty search says so', /This is not an empty result/.test(SRC) && /No receipt matches/.test(SRC));

const win = {}; const ctx = { window: win, document: { readyState: 'complete', getElementById: () => null, addEventListener () {} }, MutationObserver: function () { this.observe = () => {}; } };
vm.createContext(ctx); vm.runInContext(SRC.replace('})(window);', '})(window);'), ctx);
const A = win.SokoniAOSReceipts;
const html = A._card({
  receiptNo: 'SKN-RCT-2026-000007', kind: 'b2b_order', sourceId: 'po1', status: 'released', paidCents: 50000000, heldCents: 0, releasedCents: 50000000,
  refundedCents: 0, platformFeeCents: 0, providerNetCents: 49930400, deductionsCents: 69600, method: null, clientUid: '<img src=x onerror=alert(1)>',
  counterpartyName: 'Wholesale <b>Ltd</b>', counterpartyId: 'sup1', serviceLabel: 'PO "po1"', paymentRef: 'API_PO1', taxTreatment: 'provider_fiscal_invoice', links: { purchaseOrderId: 'po1' },
  events: [{ type: 'paid', amountCents: 50000000, at: '2026-10-03T09:00:00Z' }, { type: 'released', amountCents: 50000000, platformFeeCents: 0, providerNetCents: 49930400,
    deductions: [{ kind: 'lead_fee_recovery', amountCents: 69600 }], at: '2026-10-04T09:00:00Z' }],
});
ck('V5a every field escaped — no raw tags from data', !/<img src=x/.test(html) && !/<b>Ltd<\/b>/.test(html) && /&lt;img src=x/.test(html));
ck('V5b method null renders "—"', /Payment method<\/dt><dd style="margin:0">—<\/dd>/.test(html));
ck('V5c B2B: deduction 696 shown as "Deductions (not commission)", SOKONI fee 0, provider 499,304; history row names lead fee recovery',
  /Deductions \(not commission\)<\/dt><dd style="margin:0">KES 696<\/dd>/.test(html) && /SOKONI fee<\/dt><dd style="margin:0">KES 0<\/dd>/.test(html)
  && /Provider share<\/dt><dd style="margin:0">KES 499,304<\/dd>/.test(html) && /lead fee recovery KES 696/.test(html));
ck('V5d history renders paid before released', html.indexOf('<td>paid</td>') > -1 && html.indexOf('<td>paid</td>') < html.indexOf('<td>released</td>'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
