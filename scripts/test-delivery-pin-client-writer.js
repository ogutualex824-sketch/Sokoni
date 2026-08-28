#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════════
   THE DELIVERY PIN IS ISSUED BY THE SERVER, AND ONLY BY THE SERVER
   ══════════════════════════════════════════════════════════════════════════════
   A possession PIN minted in the browser was never an authorisation. The client
   that generates it also writes it, and it landed on a document the assigned
   rider can read IN FULL — verified against the ruleset actually served:

       match /packageRequests/{pkgId}
         allow read: ... || (isAuthed() && resource.data.assignedDriverId
                                            == request.auth.uid);

   Firestore cannot project fields on read, so the PIN reached the one party it
   exists to defend against. It was weak on its own terms too: Math.random() is
   not a CSPRNG, and 1000..9999 is 9,000 possibilities.

   This suite asserts the ABSENCE holds, and that the server lifecycle it depends
   on is really there — because "the client stopped writing it" is only safe if
   something else issues it.

   Every check reads COMMENT-STRIPPED source. An earlier version of this fix
   reported three false failures by matching its own explanatory prose.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const rd = (f) => { try { return fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch (_) { return null; } };
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

let pass = 0, fail = 0, unproven = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '\n        [' + d + ']' : '')); ok ? pass++ : fail++; };
const un = (l, d) => { console.log('  UNPROVEN  ' + l + (d ? '\n        [' + d + ']' : '')); unproven++; };
const head = (t) => console.log('\n' + t);

const rawDelivery = rd('sokoni-delivery.js');
const rawOrders = rd('sokoni-orders.js');
const pinFn = rd('functions/delivery-pin.js');
const fnIndex = rd('functions/index.js');

console.log('\n  DELIVERY PIN — server-issued, never client-minted');
console.log('  ' + '='.repeat(72));

head('0 - the fixtures are real, and the stripper works');
ck('CONTROL sokoni-delivery.js loaded', !!rawDelivery && rawDelivery.length > 5000, rawDelivery ? rawDelivery.length + ' chars' : 'MISSING');
const code = strip(rawDelivery || '');
ck('CONTROL the stripper removed prose but kept code',
   rawDelivery.length - code.length > 300 && /status:\s*'order_placed'/.test(code),
   (rawDelivery.length - code.length) + ' chars stripped, order_placed still present');

head('1 - the client mints nothing');
ck('no PIN generator is defined in the client', !/function\s+_generatePIN/.test(code),
   'the helper is deleted, not merely unused — an unused helper invites the next writer');
ck('no PIN generator is called', !/_generatePIN\s*\(/.test(code));
ck('no proofPin is written at delivery creation', !/proofPin\s*:/.test(code),
   'packageRequests grants the assigned rider a FULL-DOCUMENT read');
ck('Math.random() is not used anywhere in this module', !/Math\.random/.test(code),
   'it is not a CSPRNG; a possession code must never come from it');
{
  const oc = strip(rawOrders || '');
  ck('sokoni-orders.js does not MINT a PIN either',
     !/_generatePIN\s*\(/.test(oc) && !/Math\.random/.test(oc),
     'the second client MINTER must not survive the first being removed');
  /* sokoni-orders.js does still WRITE proofPin — but it is not minting one. In
     riderDelivered() the value is proofData?.pin: the code the rider TYPED IN,
     recorded as delivery proof. That is a different defect, reported in section 4
     rather than folded into this slice. */
}

head('2 - the server lifecycle it depends on actually exists');
ck('functions/delivery-pin.js is present', !!pinFn, pinFn ? pinFn.length + ' chars' : 'MISSING');
if (pinFn) {
  const pc = strip(pinFn);
  ck('the PIN is generated with a CSPRNG', /crypto\.randomInt\(/.test(pc), 'not Math.random');
  ck('...and is 6 digits, not 4', /padStart\(6/.test(pc), '1,000,000 possibilities, not 9,000');
  ck('the delivery document stores a HASH, never the plaintext',
     /deliveryPinHash:\s*_hash\(/.test(pc) && !/deliveryPin:\s*pin\b/.test(pc));
  ck('the hash is KEYED, so the 6 digits are not brute-forceable from it',
     /createHmac|SOKONI_HMAC_KEY/.test(pc));
  ck('the plaintext goes to deliveryPins/{orderId}', /collection\("deliveryPins"\)/.test(pc));
  ck('issuance is triggered on ASSIGNMENT, not on creation',
     /onDocumentUpdated/.test(pc) && /deliveryPinOnAccept/.test(pc),
     'a PIN minted at creation exists before there is a rider to withhold it from');
  ck('the buyer retrieves it through an identity-checked callable',
     /getMyDeliveryPin/.test(pc) && /onCall/.test(pc));
}
ck('all three functions are exported by name from index.js',
   !!fnIndex && ['deliveryPinOnAccept', 'getMyDeliveryPin', 'deliveryVerifyShadow'].every((n) => fnIndex.indexOf(n) > -1),
   'a Cloud Function that is not re-exported is not deployed');

head('3 - the collection holding the plaintext is unreachable by clients');
{
  const served = (function () {
    for (const p of ['C:/temp/sok-mv2/firestore.rules.SERVED', path.join(ROOT, 'firestore.rules.SERVED')]) {
      try { return fs.readFileSync(p, 'utf8'); } catch (_) { /* next */ }
    }
    return null;
  }());
  if (!served) {
    un('deliveryPins is deny-by-default in the SERVED ruleset',
       'the fetched served ruleset is not present here; re-fetch with scripts/verify-served-rules.js');
  } else {
    ck('CONTROL the served ruleset is loaded and non-trivial', served.length > 100000, served.length + ' chars');
    ck('deliveryPins has NO match block, so it is deny-by-default',
       served.indexOf('match /deliveryPins/') < 0,
       'no rule means no client can read the plaintext — that is the design, not an omission');
    ck('CONTROL the ruleset DOES contain packageRequests, so absence is meaningful',
       served.indexOf('match /packageRequests/') > -1,
       'without this, "not found" could just mean the wrong file');
  }
}

head('4 - SEPARATE FINDING: delivery proof is client-asserted, not server-verified');
{
  const oc = strip(rawOrders || '');
  const clientWrites = /proofPin:\s*proofData\?\.pin/.test(oc);
  const usesVerifier = /deliveryVerifyShadow|verifyDeliveryPin/.test(oc);
  ck('CONTROL sokoni-orders.js was read', oc.length > 5000, oc.length + ' chars of code');
  ck('RECORDED: riderDelivered writes the rider-typed PIN straight onto the order',
     clientWrites, 'asserted as PRESENT so this finding cannot be quietly lost');
  ck('RECORDED: no server verifier is called on that path', !usesVerifier,
     'deliveryVerifyShadow is DEPLOYED but unused here — a rider can submit any PIN ' +
     'and transitionOrder, which is client-side, will move the order to DELIVERED');
  un('this second defect is fixed',
     'OUT OF SCOPE for this slice by instruction. It is a different failure — proof ' +
     'ASSERTED by the client rather than a secret MINTED by it — and changing the ' +
     'completion path needs its own controlled release');
}

head('what this suite does NOT prove');
un('historical records carry no leaked PIN',
   'documents created before this fix may still hold a client-minted proofPin; that is a data question, not a code one');
un('the rider cannot obtain the PIN by another route', 'needs an authenticated rider session against production');

console.log('\n  ' + '='.repeat(72));
console.log('  ' + pass + ' passed, ' + fail + ' failed, ' + unproven + ' unproven');
console.log('  ' + '='.repeat(72) + '\n');
process.exit(fail ? 1 : 0);
