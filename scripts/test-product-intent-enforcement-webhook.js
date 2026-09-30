'use strict';
/**
 * CERTIFICATION — owner repair #1, Unit 4b (2026-09-30): webhookIntasend refuses an INTENT-LESS payment
 * that would finalise a marketplace order. Pure: exercises assessProductOrderPayment and
 * wouldFinalizeMarketplaceOrder (functions/payment-attribution.js), and asserts against comment-stripped
 * source that the webhook wires both.
 *
 *   node scripts/test-product-intent-enforcement-webhook.js            (this tree)
 *   WH_ROOT=<Unit 2 draft tree> node scripts/...                       (baseline — the 4b rows must FAIL)
 *
 * The emulator-level proof (zero commission / credit / stock / order effects on the parked payment, and
 * the POS / booking / SokoniPay controls settling unchanged) is rows C-1a..C-4 of
 * scripts/test-b1-online-checkout-chain.js as updated for Unit 4b.
 */
const path = require('path'), fs = require('fs'), { execFileSync } = require('child_process');
const ROOT = path.resolve(process.env.WH_ROOT || path.join(__dirname, '..'));
const A = require(path.join(ROOT, 'functions', 'payment-attribution.js'));
let pass = 0, fail = 0;
const ck = (id, c, m, got) => { c ? pass++ : fail++; console.log('  ' + (c ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (c || got === undefined ? '' : '   [got ' + JSON.stringify(got) + ']')); };
const G = (intent, meta, extra) => A.assessProductOrderPayment(intent, Object.assign({ apiRef: 'ord-1', grossAmount: 390, currency: 'KES', legacyMeta: meta }, extra || {}));
const refused = (r) => r && r.applies === true && r.ok === false && r.reason === 'missing_intent';
const untouched = (r) => r && r.applies === false;
const show = (m) => (m === undefined ? 'undefined' : JSON.stringify(m));

console.log('\nUnit 4b — intent-less payments that would finalise an order   WH=' + ROOT + '\n');

/* P-1/P-2 — refused: the pre-Unit-3 checkout's exact meta, and every relabel that would still finalise. */
const LEGACY_CHECKOUT = { category: 'product', orderId: 'ord-1', sellerUid: 'S1', items: [{ id: 'p', qty: 1 }], hub: 'marketplace' };
ck('P-1 ', refused(G(null, LEGACY_CHECKOUT)), 'no intent + the pre-Unit-3 checkout meta → REVIEW(missing_intent)', G(null, LEGACY_CHECKOUT));
for (const [m, label] of [
  [{ category: 'default', orderId: 'ord-1', sellerUid: 'S1' }, 'relabelled category "default" + orderId'],
  [{ orderId: 'ord-1', sellerUid: 'attacker' }, 'no category at all + orderId'],
  [{ category: 'electronics', orderId: 'ord-1' }, 'a product catalogue category + orderId'],
  [{ category: ' SUBSCRIPTION ', orderId: 'ord-1' }, 'padded "subscription" (settlement does not trim, so it WOULD finalise)'],
]) ck('P-2 ', refused(G(null, m)), 'no intent + ' + label + ' → refused', G(null, m));

/* P-3 — CONTROLS: every intent-less caller that finalises no order is untouched. */
for (const [m, label] of [
  [undefined, 'absent meta'], [null, 'null meta'], [{}, 'empty meta'],
  [{ category: 'product', providerName: 'Shop', serviceDesc: 'Product inquiry: x' }, 'SokoniPay deposit labelled "product" by product.js (NO orderId) — the census collision'],
  [{ category: 'electronics', providerName: 'Shop' }, 'SokoniPay deposit with a product category'],
  [{ category: 'default', type: 'booking', providerId: 'P1' }, 'SokoniPay bookNow'],
  [{ type: 'service-booking', bookingId: 'b1', providerId: 'P1' }, 'sokoni-book-service'],
  [{ type: 'booking', orderId: 'ord-1', providerId: 'P1' }, 'booking that also carries an orderId'],
  [{ category: 'pos_checkout' }, 'pos-checkout.html'], [{ category: 'pos_till_sale' }, 'Till'],
  [{ category: 'subscription', orderId: 'ord-1' }, 'subscription with an orderId'],
  [{ category: 'wallet_topup', orderId: 'x' }, 'wallet top-up'], [{ category: 'food', providerName: 'Kitchen' }, 'food hub'],
  [{ category: 'delivery_parcel' }, 'delivery'], [{ category: 'ai_credits' }, 'AI subscriptions'],
]) ck('P-3 ', untouched(G(null, m)), 'CONTROL no intent + ' + label + ' → untouched', G(null, m));

/* P-4 — the Unit 2 gate is unchanged when a product_order intent exists. */
const I = { purpose: 'product_order', amountCents: 39000, currency: 'KES', status: 'pending', resourceId: 'ord-1', metadata: { orderId: 'ord-1' } };
ck('P-4a', (() => { const r = G(I, LEGACY_CHECKOUT); return r.applies && r.ok; })(), 'valid intent + exact gross settles');
ck('P-4b', G(I, LEGACY_CHECKOUT, { grossAmount: 389.6 }).reason === 'amount_mismatch', 'valid intent + short gross still amount_mismatch');
ck('P-4c', G(I, null).ok === true, 'valid intent with no meta still settles (meta never required when the intent exists)');
/* P-5 — an intent of ANOTHER purpose is not this gate's business (attribution comes from that intent). */
ck('P-5 ', untouched(G({ purpose: 'subscription', amountCents: 39000 }, LEGACY_CHECKOUT)), 'non-product intent + order meta → untouched');
/* P-6 — the refusal never carries a browser amount or seller. */
ck('P-6 ', (() => { const r = G(null, Object.assign({ amount: 1 }, LEGACY_CHECKOUT)); return r.expectedCents === null && !('sellerUid' in r) && !('confirmedCents' in r); })(), 'refusal carries no browser amount or seller');

/* P-7 — DRIFT-PROOF REFACTOR: the shared predicate equals the settlement expression it replaced, taken
   verbatim from 68811e1 (the live webhookIntasend source), over a matrix of edge values. */
(() => {
  if (typeof A.wouldFinalizeMarketplaceOrder !== 'function') { ck('P-7 ', false, 'wouldFinalizeMarketplaceOrder is exported'); return; }
  let orig = '';
  try { orig = execFileSync('git', ['-C', ROOT, 'show', '68811e1:functions/index.js'], { encoding: 'utf8', maxBuffer: 64 << 20 }); } catch (e) { orig = ''; }
  const mt = orig.match(/const _cat = (String\(_pm\.category \|\| ""\)\.toLowerCase\(\));\s*const _isProductPay = (!!_pm\.orderId[\s\S]*?\.includes\(_cat\));/);
  if (!mt) { ck('P-7 ', false, 'the original 68811e1 settlement expression was found'); return; }
  const ORIGINAL = new Function('_pm', 'const _cat = ' + mt[1] + '; return ' + mt[2] + ';');
  const cats = [undefined, null, '', 'product', 'PRODUCT', 'subscription', 'Subscription', ' subscription', 'wallet_topup', 'TOPUP', 'topup ', ['subscription'], 7, 'default'];
  const types = [undefined, 'booking', 'Booking', 'service-booking', ''];
  const orders = [undefined, '', 'ord-1', 0, 1];
  let n = 0, bad = [];
  for (const category of cats) for (const type of types) for (const orderId of orders) {
    const m = { category, type, orderId }; n++;
    if (ORIGINAL(m) !== A.wouldFinalizeMarketplaceOrder(m)) bad.push(m);
  }
  ck('P-7 ', bad.length === 0, 'shared predicate == the 68811e1 settlement expression on ' + n + ' edge cases', bad.slice(0, 3));
})();

/* W — wiring, comment-stripped. */
const idx = fs.readFileSync(path.join(ROOT, 'functions', 'index.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const call = (idx.match(/assessProductOrderPayment\(\s*_gSnap[\s\S]*?\}\);/) || [''])[0];
ck('W-1 ', /legacyMeta:\s*existing\.meta\b/.test(call), 'webhookIntasend feeds payments/{ref}.meta to the gate', call.slice(0, 160));
/* W-2 — the gate sits BEFORE the COMPLETE claim, inside webhookIntasend's own handler (index.js holds a
   second webhook, intasendWebhook, with its own `let claimed = false` earlier in the file). */
const gAt = idx.indexOf('assessProductOrderPayment(_gSnap');
const hStart = idx.lastIndexOf('exports.webhookIntasend', gAt), hEnd = idx.indexOf('\nexports.', gAt);
const cAt = idx.indexOf('let claimed = false', gAt);
const txBefore = gAt > 0 && hStart >= 0 ? idx.slice(hStart, gAt).includes('runTransaction') : true;
ck('W-2 ', gAt > 0 && hStart >= 0 && cAt > gAt && (hEnd < 0 || cAt < hEnd) && !txBefore,
  'inside webhookIntasend the gate runs before the COMPLETE claim (no transaction precedes it)', { gAt, hStart, cAt, hEnd, txBefore });
/* W-3 — webhookIntasend's settlement branch decides "finalise?" with the SAME predicate. */
const hBody = hStart >= 0 ? idx.slice(hStart, hEnd < 0 ? undefined : hEnd) : '';
ck('W-3 ', /const _isProductPay = require\("\.\/payment-attribution"\)\.wouldFinalizeMarketplaceOrder\(_pm\)/.test(hBody)
  && !/const _isProductPay = !!_pm\.orderId/.test(hBody), 'settlement and gate share one predicate (no inline copy left in webhookIntasend)');

console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
