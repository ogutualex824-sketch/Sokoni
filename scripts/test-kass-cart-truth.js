#!/usr/bin/env node
/* Track 2.1 — KASS cart truth.
 *
 *   firebase emulators:exec --only firestore --project sokoni-kass-cart-test \
 *     "node scripts/test-kass-cart-truth.js"
 *
 * Runs the SHIPPED _execChatTool source from functions/index.js against a real Firestore
 * emulator. The handlers are not exported — Firebase deploys every export as a Cloud
 * Function, so adding a test seam would ship a phantom function — therefore the function
 * is sliced out of the source and evaluated in a vm sandbox with `db` injected. It is the
 * real code, not a copy: if the handler changes, this suite sees the change.
 *
 * What this proves is narrower than "the tools work". It proves the tools no longer make
 * claims the platform cannot keep:
 *
 *   - nothing is written to a store no buyer surface can read
 *   - no money figure originates anywhere but the catalogue
 *   - no reply uses success language for an action that did not occur
 *   - checkout.html is untouched
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'sokoni-kass-cart-test';

const path = require('path');
const fs = require('fs');
const vm = require('vm');
const cp = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const FN = path.join(ROOT, 'functions');
const admin = require(require.resolve('firebase-admin', { paths: [FN] }));
admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT });
const db = admin.firestore();
const { stripComments } = require('./scan-legacy-wishlist.js');

const U = 'kass-buyer-1';
const R = {};
let pass = 0, fail = 0;
function ck(g, l, ok, d) {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 95) + ']' : ''));
  ok ? pass++ : fail++;
  if (R[g] !== 'FAIL') R[g] = ok ? 'PASS' : 'FAIL';
}
const SRC = fs.readFileSync(path.join(FN, 'index.js'), 'utf8');

/* ── slice the shipped handler out of index.js ─────────────────────────────
   Brace-counted over a comment-stripped copy so a brace inside a comment or a
   string cannot end the function early — the same failure mode that made the
   Track 3 scanner report migrated files as unmigrated. Offsets are preserved by
   the stripper, so the slice is taken from the ORIGINAL text. */
function sliceFunction(src, signature) {
  const bare = stripComments(src);
  const start = bare.indexOf(signature);
  if (start === -1) throw new Error('not found: ' + signature);
  let i = bare.indexOf('{', start), depth = 0;
  for (; i < bare.length; i++) {
    if (bare[i] === '{') depth++;
    else if (bare[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error('unbalanced: ' + signature);
}

const EXEC_SRC = sliceFunction(SRC, 'async function _execChatTool');

function makeCtx(uid) {
  const ctx = { uid: uid, actions: [], results: [] };
  ctx.addAction = (a) => ctx.actions.push(a);
  ctx.addResult = (r) => ctx.results.push(r);
  return ctx;
}

/* Only the two cart branches are exercised; every other branch is dead code in this
   sandbox and its dependencies are never touched. */
function makeExec() {
  const sandbox = {
    db, admin, console, JSON, Date, Math, String, Number, Object, Array, Promise, Error, Set,
    isNaN, parseInt, parseFloat,
    _authRequired: () => ({ requiresAuth: true, error: 'This action requires you to be logged in.' }),
  };
  vm.createContext(sandbox);
  vm.runInContext(EXEC_SRC + '\nthis.__exec = _execChatTool;', sandbox);
  if (typeof sandbox.__exec !== 'function') throw new Error('_execChatTool did not evaluate');
  return sandbox.__exec;
}
const exec = makeExec();

/* The widget stamps a green success panel on any reply matching this. Kept in sync with
   kass-widget.js _isSuccessMsg — read from the file so it cannot drift. */
const WIDGET_SUCCESS_RE = (() => {
  const w = fs.readFileSync(path.join(ROOT, 'kass-widget.js'), 'utf8');
  const m = w.match(/_isSuccessMsg[\s\S]{0,200}?return\s+(\/[^/]+\/[gimsuy]*)\.test/);
  if (!m) throw new Error('could not read _isSuccessMsg regex from kass-widget.js');
  return eval(m[1]);   /* eslint-disable-line no-eval — reading the shipped literal */
})();

const PID = 'prod-unga-2kg';
const CATALOGUE_PRICE = 250;

(async () => {
  console.log('\nTRACK 2.1 — KASS CART TRUTH\n' + '='.repeat(64));
  await db.collection('products').doc(PID).set({
    name: 'Unga 2kg', price: CATALOGUE_PRICE, imageUrl: 'u.png', sellerName: 'Duka A',
  });

  /* ══ A. the orphaned collection is gone ══ */
  console.log('\nA. carts/{uid}/items is no longer written or read');
  {
    const fnSrc = stripComments(SRC);
    ck('A', 'zero references to the carts collection in functions/index.js',
       !/collection\(\s*["']carts["']\s*\)/.test(fnSrc),
       (fnSrc.match(/collection\(\s*["']carts["']\s*\)/g) || []).join(', '));
    const others = fs.readdirSync(FN).filter(f => f.endsWith('.js'));
    const hits = others.filter(f => /collection\(\s*["']carts["']\s*\)/
      .test(stripComments(fs.readFileSync(path.join(FN, f), 'utf8'))));
    ck('A', 'zero references anywhere else in functions/', hits.length === 0, hits.join(', '));
  }

  /* ══ B. add_to_cart does not claim to have added ══ */
  console.log('\nB. add_to_cart reports what it actually did');
  const ctxB = makeCtx(U);
  const rB = await exec('add_to_cart', { productId: PID, productName: 'Unga 2kg', quantity: 2 }, ctxB);
  ck('B', 'added is explicitly false', rB.added === false, JSON.stringify(rB.added));
  ck('B', 'flags that the USER must act', rB.requiresUserAction === true);
  ck('B', 'message does not claim the item is in the cart',
     !/\b(added|is in your cart|added to your cart)\b/i.test(rB.message), rB.message);
  ck('B', 'links to the product page', rB.url === 'product.html?id=' + PID, rB.url);
  ck('B', 'offers exactly one action, to that product',
     ctxB.actions.length === 1 && ctxB.actions[0].url === 'product.html?id=' + PID,
     JSON.stringify(ctxB.actions));
  ck('B', 'does NOT offer a checkout shortcut for an item that was never added',
     !ctxB.actions.some(a => /checkout/i.test(a.url || '')), JSON.stringify(ctxB.actions));

  /* ══ C. nothing was written ══ */
  console.log('\nC. No write reached any store');
  {
    const c = await db.collection('carts').doc(U).collection('items').get();
    ck('C', 'carts/{uid}/items is empty', c.size === 0, c.size);
    const all = await db.collection('carts').get();
    ck('C', 'the carts collection has no documents at all', all.size === 0, all.size);
  }

  /* ══ D. price comes from the catalogue, never from the model ══
     The old handler stored input.price verbatim and view_cart multiplied it into a KES
     total. Here the model supplies a deliberately wrong price and must be ignored. */
  console.log('\nD. Money figures originate in the catalogue');
  {
    const ctx = makeCtx(U);
    const r = await exec('add_to_cart',
      { productId: PID, productName: 'Unga 2kg', quantity: 1, price: 1, sellerUid: 'attacker' }, ctx);
    ck('D', 'returned price is the catalogue price, not the model\'s',
       r.price === CATALOGUE_PRICE, r.price);
    ck('D', 'the model-supplied price appears nowhere in the reply',
       !JSON.stringify(r).includes('"price":1'), JSON.stringify(r).slice(0, 90));
    ck('D', 'the result card is priced from the catalogue too',
       (ctx.results[0] || {}).price === CATALOGUE_PRICE, JSON.stringify(ctx.results[0]));
    ck('D', 'the display name comes from the catalogue document',
       r.productName === 'Unga 2kg', r.productName);
  }

  /* ══ E. a product that does not exist gets no link ══ */
  console.log('\nE. Unknown product produces no confident dead end');
  {
    const ctx = makeCtx(U);
    const r = await exec('add_to_cart', { productId: 'does-not-exist', productName: 'Ghost' }, ctx);
    ck('E', 'reports not found', r.found === false && r.added === false, JSON.stringify(r));
    ck('E', 'no product link is offered',
       !ctx.actions.some(a => /product\.html/.test(a.url || '')), JSON.stringify(ctx.actions));
    ck('E', 'no result card is fabricated', ctx.results.length === 0, ctx.results.length);
    ck('E', 'no price is invented for it', r.price === undefined, JSON.stringify(r.price));
  }

  /* ══ F. view_cart states nothing about the cart ══ */
  console.log('\nF. view_cart reports no count, total, or emptiness');
  {
    const ctx = makeCtx(U);
    const r = await exec('view_cart', {}, ctx);
    ck('F', 'declares it cannot read the cart', r.canRead === false, JSON.stringify(r.canRead));
    ck('F', 'no itemCount', r.itemCount === undefined, r.itemCount);
    ck('F', 'no total', r.total === undefined, r.total);
    ck('F', 'no items array', r.items === undefined, JSON.stringify(r.items));
    ck('F', 'never says the cart is empty', !/empty/i.test(JSON.stringify(r)), r.message);
    ck('F', 'no KES figure anywhere in the reply', !/KES/.test(JSON.stringify(r)), r.message);
    ck('F', 'still offers to open the cart',
       ctx.actions.some(a => a.url === 'cart.html'), JSON.stringify(ctx.actions));
    ck('F', 'no result cards invented from a cart it cannot see', ctx.results.length === 0);
  }

  /* ══ G. signed-out ══ */
  console.log('\nG. Signed-out callers');
  {
    const c1 = makeCtx(null), c2 = makeCtx(null);
    const r1 = await exec('add_to_cart', { productId: PID, productName: 'Unga 2kg' }, c1);
    const r2 = await exec('view_cart', {}, c2);
    ck('G', 'add_to_cart requires auth', r1.requiresAuth === true, JSON.stringify(r1));
    ck('G', 'view_cart requires auth', r2.requiresAuth === true, JSON.stringify(r2));
    ck('G', 'no writes for an anonymous caller', (await db.collection('carts').get()).size === 0);
  }

  /* ══ H. THE INVARIANT — success language implies buyer-readable state ══
     Neither handler produces state any buyer surface can read, so neither may produce a
     reply the widget will stamp with a green tick. */
  console.log('\nH. No success language for an action that did not occur');
  {
    const ctx1 = makeCtx(U), ctx2 = makeCtx(U);
    const r1 = await exec('add_to_cart', { productId: PID, productName: 'Unga 2kg', quantity: 3 }, ctx1);
    const r2 = await exec('view_cart', {}, ctx2);
    ck('H', 'widget success regex was read from the shipped file (control)',
       WIDGET_SUCCESS_RE.test('Added to cart'), String(WIDGET_SUCCESS_RE));
    ck('H', 'add_to_cart message would NOT trigger the green success panel',
       !WIDGET_SUCCESS_RE.test(r1.message), r1.message);
    ck('H', 'view_cart message would NOT trigger it either',
       !WIDGET_SUCCESS_RE.test(r2.message), r2.message);
    ck('H', 'neither reply carries success:true',
       r1.success === undefined && r2.success === undefined);
  }

  /* ══ I. the model is instructed, not just the code ══
     The handler cannot stop the model narrating "added to your cart" — the tool
     description is the only lever for that, so it is asserted as part of the fix. */
  console.log('\nI. Tool contracts tell the model not to claim a success');
  {
    const decl = (n) => {
      const i = SRC.indexOf('name: "' + n + '"');
      return i === -1 ? '' : SRC.slice(i, i + 1400);
    };
    const a = decl('add_to_cart'), v = decl('view_cart');
    ck('I', 'add_to_cart declaration found (control)', a.length > 0);
    ck('I', 'add_to_cart tells the model it does NOT add', /does NOT add/i.test(a));
    ck('I', 'add_to_cart forbids claiming it was added', /NEVER tell the user/i.test(a));
    ck('I', 'add_to_cart no longer accepts a model-supplied price',
       !/price:\s*\{\s*type:\s*"number"/.test(a.split('required')[0]), 'price still in schema');
    ck('I', 'add_to_cart no longer accepts sellerUid',
       !/sellerUid:\s*\{/.test(a.split('required')[0]), 'sellerUid still in schema');
    ck('I', 'view_cart declares it cannot read the cart', /CANNOT read the cart/i.test(v));
    ck('I', 'view_cart forbids stating a count or total', /NEVER state or guess/i.test(v));
    /* The FIRST "ACTION TOOLS" in the file is a comment above the tools array; the system
       prompt's copy is the later one. Slicing from indexOf() grabbed the comment and the
       assertion looked at the wrong block entirely. */
    const pStart = SRC.indexOf('ACTION TOOLS', SRC.indexOf('name: "add_to_cart"'));
    const prompt = SRC.slice(pStart, pStart + 900);
    ck('I', 'system prompt no longer advertises "show cart contents and subtotal"',
       !/show cart contents and subtotal/.test(prompt));
    ck('I', 'system prompt warns against claiming "added"', /Never say "added"/.test(prompt));
  }

  /* ══ J. blast radius ══ */
  console.log('\nJ. Nothing outside this slice moved');
  {
    const changed = cp.execSync('git diff --name-only HEAD', { cwd: ROOT, encoding: 'utf8' })
      .split('\n').map(s => s.trim()).filter(Boolean);
    ck('J', 'checkout.html untouched', !changed.includes('checkout.html'), changed.join(', '));
    ck('J', 'cart.js untouched by this slice', !changed.includes('cart.js'), changed.join(', '));
    /* cart.html is legitimately dirty from Track 4 (a CSS overflow fix), so "unchanged"
       is the wrong assertion — but `|| true` made this vacuous, which is worse than no
       assertion at all. Check what the diff actually contains instead: this slice must
       not have altered any markup or script wiring on the cart page. */
    const cartDiff = cp.execSync('git diff HEAD -- cart.html', { cwd: ROOT, encoding: 'utf8' })
      .split('\n').filter(l => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l));
    ck('J', 'cart.html diff is CSS only — no script or markup change from this slice',
       cartDiff.length > 0 && !cartDiff.some(l => /<script|<div|<button|localStorage/.test(l)),
       cartDiff.filter(l => /<script|<div|<button|localStorage/.test(l)).join(' | ') ||
         (cartDiff.length + ' CSS lines'));
    ck('J', 'no Track 3 wishlist file was modified',
       !changed.some(f => /wishlist/i.test(f)), changed.filter(f => /wishlist/i.test(f)).join(', '));
    ck('J', 'no new client cart writer was introduced',
       !changed.some(f => /^(product|category|script|market-actions)\.js$/.test(f)),
       changed.join(', '));
  }

  /* ── summary ── */
  console.log('\n' + '='.repeat(64));
  console.log('Track 2.1 acceptance\n');
  ['A','B','C','D','E','F','G','H','I','J'].forEach(k => console.log('  ' + k + ': ' + (R[k] || 'MISSING')));
  console.log('\n  TOTAL:   ' + (pass + fail) + '\n  PASSED:  ' + pass + '\n  FAILED:  ' + fail);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('\nHARNESS ERROR:', e); process.exit(2); });
