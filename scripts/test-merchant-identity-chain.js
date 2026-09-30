#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════════
   SLICE 3 — the merchant identity chain, as it stands on the LIVE lineage
   ══════════════════════════════════════════════════════════════════════════════
   auth.uid -> users/{uid} -> sellerUid -> activeShopId -> shop

   This suite does NOT assert that a port happened. It asserts the property the
   port was supposed to deliver, so it stays meaningful whether the work arrives
   from a branch, from live, or from nowhere.

   Every check is source-level and therefore provable without credentials. The
   authenticated behaviour is NOT claimed here — see the UNPROVEN block at the
   end, which is deliberately not counted as a pass.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const rd = (f) => { try { return fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch (_) { return null; } };

let pass = 0, fail = 0, unproven = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '\n        [' + d + ']' : '')); ok ? pass++ : fail++; };
const un = (l, d) => { console.log('  UNPROVEN  ' + l + (d ? '\n        [' + d + ']' : '')); unproven++; };
const head = (t) => console.log('\n' + t);

const SHELL = rd('merchant-v2.html');
console.log('\n  MERCHANT IDENTITY CHAIN — live lineage');
console.log('  ' + '='.repeat(74));

head('0 - the fixture is real');
ck('CONTROL merchant-v2.html loaded', !!SHELL && SHELL.length > 100000, SHELL ? SHELL.length + ' chars' : 'MISSING');

head('1 - the chain resolves through ONE server authority');
ck('the shell asks a SERVER callable for identity', /_callable\('merchantIdentity'\)/.test(SHELL),
   'identity is resolved server-side, never assembled from local state');
ck('capabilities come from that answer, not from the page',
   /capabilities:\s*\[\]/.test(SHELL) && /merchantIdentity/.test(SHELL),
   'an empty default until the server answers');
ck('servedBy is passed through, never constructed',
   /servedBy:\s*S\.servedBy/.test(SHELL) && !/servedBy:\s*['"]/.test(SHELL),
   'the shell may forward the server value; it may never build one');

head('2 - scope resolution names its failures instead of collapsing them');
const scope = SHELL.slice(SHELL.indexOf('function _scope ('), SHELL.indexOf('function _scopeKey'));
ck('CONTROL the _scope body was isolated', scope.length > 200 && scope.length < 4000, scope.length + ' chars');
ck('"no sell capability" is its own answer', /no_sell_capability/.test(scope),
   'a cashier and a buyer must not land in the same state');
ck('"no merchant role" is its own answer', /no_merchant_role/.test(scope));
ck('a signed-in-but-uncapable account is NOT reported as no-shop',
   /S\.state === 'in' && S\.activeShopId && !can\('sell'\)/.test(scope),
   'collapsing these is what told a buyer to wait for a shop');
ck('scope delegates to the data module rather than deriving a shop itself',
   /SokoniMerchantData\.resolveScope/.test(scope));

head('3 - the boundary: activeShopId cannot be self-asserted');
ck('the shell never writes activeShopId from the client',
   !/set(Doc|)\([^)]*activeShopId/.test(SHELL) && !/activeShopId:\s*(prompt|input|location)/.test(SHELL),
   'a client-chosen shop id would BE the merchant boundary');
ck('identity is re-resolved against the shopId, server-side',
   /_callable\('merchantIdentity'\)\(\{\s*shopId:/.test(SHELL),
   'the server decides whether this uid may act for that shop');

head('4 - one scope key feeds every surface');
ck('a single _scopeKey derives the cache identity', (SHELL.match(/function _scopeKey/g) || []).length === 1);
ck('a failed scope produces a POISONED key, not a shared one',
   /'!' \+ \(\(s && s\.reason\)/.test(SHELL),
   'two different failures must not share one cache bucket');

head('5 - the surfaces resolve through the SAME authority');
const ctxUsers = (SHELL.match(/scope:\s*_scope\(\)/g) || []).length;
ck('every module ctx takes scope from _scope()', ctxUsers >= 4, ctxUsers + ' module contexts');
ck('no module is handed a raw uid as its shop authority',
   !/scope:\s*\{\s*shopId:\s*S\.uid/.test(SHELL),
   'a uid is not a shop');
{
  /* the wallet, ported in slice 2, must resolve the same way as the rest */
  const w = SHELL.slice(SHELL.indexOf("wallet:     { global: 'SokoniMerchantWallet'"));
  const wctx = w.slice(0, w.indexOf('onToast: toast }; } },') + 22);
  ck('WALLET resolves through the same _scope()', /scope:\s*_scope\(\)/.test(wctx));
  ck('WALLET is handed no db adapter', !/db:\s*_mdb/.test(wctx),
     'wallets is allow update: if isAdmin() — Cloud Functions only');
}

head('6 - identities stay separated');
ck('merchant capability is asked, not assumed', /can\('sell'\)/.test(SHELL));
ck('the shell does not treat a provider as a merchant',
   !/roles\.includes\('provider'\)[^\n]*sell/.test(SHELL));
ck('a buyer with no shop gets a NAMED state, not a merchant surface',
   /no_merchant_role/.test(SHELL) && /identity-/.test(SHELL));

head('7 - slice A (c548ff3) is already satisfied on this lineage');
ck('the canonical receipt renderer is loaded', /src="sokoni-receipt\.js"/.test(SHELL),
   'without it composedReceipt() returns null and no seller line can ever appear');
ck('servedBy reaches the sell module', /servedBy:\s*S\.servedBy/.test(SHELL));
ck('servedBy is populated from the server answer', /S\.servedBy = d\.servedBy \|\| null/.test(SHELL));

head('what this suite does NOT prove');
un('the authenticated chain end-to-end',
   'auth.uid -> users -> sellerUid -> activeShopId -> shop cannot be walked without credentials; ' +
   'no account was created and no production data was altered to obtain it');
un('that a cross-merchant activeShopId is refused AT RUNTIME',
   'the refusal lives in the merchantIdentity callable and the rules layer, neither of which ' +
   'this source-level suite executes');
un('the Wallet panel renders for a real merchant',
   'no module global registers in the offline harness — live modules included — so the panel ' +
   'is unverified end-to-end');

console.log('\n  ' + '='.repeat(74));
console.log('  ' + pass + ' passed, ' + fail + ' failed, ' + unproven + ' unproven');
console.log('  ' + '='.repeat(74) + '\n');
process.exit(fail ? 1 : 0);
