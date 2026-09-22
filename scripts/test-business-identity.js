#!/usr/bin/env node
/* ============================================================================
   SOKONI — business display identity
   ============================================================================
   Phase A of the business-communication programme: a customer should read
   "KASS Shop · Business", not "seller", and never the name of the person who
   happens to operate the shop.

   The two properties this gate holds:

     1. A BUSINESS is named as a business. A PERSON is never named at all.
     2. The module DECIDES NOTHING. If every function returned a dash the
        platform would behave identically — so it cannot have become an
        authority by accident.
   ========================================================================= */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let pass = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; return true; }
  failures.push(name + (detail ? '  — ' + detail : ''));
  return false;
}
const eq = (n, a, b) => ok(n, a === b, 'expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a));

const g = {};
new Function('window', fs.readFileSync(path.join(ROOT, 'sokoni-business-identity.js'), 'utf8') +
  '\n;return window;')(g);
const BI = g.SokoniBusinessIdentity;
if (!BI) { console.error('FATAL: module published nothing'); process.exit(1); }

/* ── 1. Contract, both ways ─────────────────────────────────────────────── */
{
  const declared = BI.CONTRACT.slice().sort();
  const exported = Object.keys(BI).sort();
  ok('every declared name is exported', declared.join(',') === exported.join(','),
    declared.join(',') + ' vs ' + exported.join(','));
}

/* ── 2. A BUSINESS is named as a business ───────────────────────────────── */
{
  const d = BI.describe({ relationship: 'inquiry', counterpartyRole: 'seller',
    businessName: 'KASS Shop' });
  eq('a shop inquiry names the SHOP', d.label, 'KASS Shop');
  eq('…and says it is a business', d.sublabel, 'Business');
  eq('…with the context that brought them here', d.context, 'Product Inquiry');
  eq('…and reports that a real name was resolved', d.named, true);
  eq('…and is categorised as a business', d.kind, 'business');
}

/* ── 3. THE SUBSTITUTION THIS MODULE EXISTS TO PREVENT ──────────────────── */
{
  /* No name resolved. The fallback must be the CATEGORY, never a person and
     never an identifier. */
  const d = BI.describe({ relationship: 'inquiry', counterpartyRole: 'seller' });
  eq('an unnamed business is still a business', d.label, 'Business');
  eq('…and does NOT claim to be named', d.named, false);
  eq('…and carries no sublabel it cannot justify', d.sublabel, null);

  /* There is no input by which a person can become the label. */
  const poisoned = BI.describe({ relationship: 'inquiry', counterpartyRole: 'seller',
    businessName: '', ownerName: 'Donna', displayName: 'Donna', uid: 'uid_donna' });
  ok('an owner name in the input is IGNORED', poisoned.label === 'Business',
    poisoned.label);
  ok('…and no uid reaches the label', JSON.stringify(poisoned).indexOf('uid_donna') === -1);
  ok('…nor any personal name', JSON.stringify(poisoned).indexOf('Donna') === -1);
}

/* ── 4. SOKONI is one identity; an admin is never named ─────────────────── */
{
  const d = BI.describe({ relationship: 'support', counterpartyRole: 'admin',
    businessName: 'Should Be Ignored', adminName: 'Jane' });
  eq('support presents as SOKONI Support', d.label, 'SOKONI Support');
  eq('…categorised as the platform', d.kind, 'platform');
  ok('…and never names the administrator',
    JSON.stringify(d).indexOf('Jane') === -1 && JSON.stringify(d).indexOf('Should Be Ignored') === -1);
}

/* ── 5. A person is described by ROLE, never by name ────────────────────── */
{
  const rider = BI.describe({ relationship: 'delivery', counterpartyRole: 'rider',
    businessName: 'Not A Business', riderName: 'John' });
  eq('a rider is described by their role', rider.label, 'Your rider');
  eq('…and is not a business', rider.kind, 'person_role');
  ok('…and is never named', JSON.stringify(rider).indexOf('John') === -1);

  const customer = BI.describe({ relationship: 'order', counterpartyRole: 'buyer' });
  eq('a customer is described by their role', customer.label, 'Customer');
  ok('…and is never named', customer.named === false);
}

/* ── 6. An unknown pair renders as a DASH, not as a guess ───────────────── */
{
  const d = BI.describe({ relationship: 'teleport', counterpartyRole: 'wizard' });
  eq('an unknown relationship has no label', d.label, '—');
  eq('…and is categorised unknown', d.kind, 'unknown');
  eq('…with no context invented', d.context, null);
  /* CONTROL: the table CAN produce a rule, so the dash is a decision. */
  ok('CONTROL: a known pair does produce a rule',
    !!BI.presentationFor('inquiry', 'seller'));
  ok('CONTROL: …and an unknown pair does not',
    BI.presentationFor('teleport', 'wizard') === null);
}

/* ── 7. The name is DERIVED from the anchor, never accepted ─────────────── */
const async1 = (async () => {
  const readers = {
    readProduct: (id) => (id === 'p1' ? { sellerUid: 'seller_kass' } : null),
    readShop: (uid) => (uid === 'seller_kass' ? { name: 'KASS Shop' } : null),
    readOrder: (id) => (id === 'o1' ? { resolvedSellerUid: 'seller_kass' } : null),
  };

  eq('a product anchor resolves the shop name',
    await BI.resolveBusinessName({ anchorType: 'products', anchorId: 'p1' }, readers),
    'KASS Shop');
  eq('an order anchor resolves it only from a SERVER-resolved seller',
    await BI.resolveBusinessName({ anchorType: 'orders', anchorId: 'o1' }, readers),
    'KASS Shop');

  /* order.sellerUid is BUYER-WRITTEN. The module must not read it. */
  const buyerWritten = { readOrder: () => ({ sellerUid: 'attacker_uid' }),
    readShop: () => ({ name: 'Attacker Shop' }) };
  eq('a buyer-written order.sellerUid is NOT trusted',
    await BI.resolveBusinessName({ anchorType: 'orders', anchorId: 'o1' }, buyerWritten),
    null);

  eq('an unknown product yields no name',
    await BI.resolveBusinessName({ anchorType: 'products', anchorId: 'nope' }, readers), null);
  eq('a shop with no name yields no name',
    await BI.resolveBusinessName({ anchorType: 'products', anchorId: 'p1' },
      { readProduct: () => ({ sellerUid: 'x' }), readShop: () => ({}) }), null);
  eq('an anchor type with no rule yields no name',
    await BI.resolveBusinessName({ anchorType: 'shops', anchorId: 'seller_kass' }, readers), null);
  eq('a missing anchor id yields no name',
    await BI.resolveBusinessName({ anchorType: 'products' }, readers), null);

  /* A reader that throws must not take the conversation down with it. */
  eq('a throwing reader resolves to null, not a rejection',
    await BI.resolveBusinessName({ anchorType: 'products', anchorId: 'p1' },
      { readProduct: () => { throw new Error('offline'); } }), null);
  eq('…and so does a throwing shop reader',
    await BI.resolveBusinessName({ anchorType: 'products', anchorId: 'p1' },
      { readProduct: () => ({ sellerUid: 's' }), readShop: () => { throw new Error('denied'); } }),
    null);
  /* CONTROL: the resolver CAN return a name, so the nulls above are decisions. */
  ok('CONTROL: the resolver does return a name when one exists',
    (await BI.resolveBusinessName({ anchorType: 'products', anchorId: 'p1' }, readers)) === 'KASS Shop');
})();

/* ── 8. IT DECIDES NOTHING ──────────────────────────────────────────────── */
{
  const src = fs.readFileSync(path.join(ROOT, 'sokoni-business-identity.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok('CONTROL: the stripped source is readable', src.indexOf('function describe') !== -1);

  ok('it reaches no backend', !/fetch\(|httpsCallable|sokoniCallable|firebase\./.test(src));
  ok('it names no collection', !/collection\(/.test(src));
  ok('it authorizes nothing', !/allow|permission|authoriz/i.test(src));
  ok('it sends no message and starts no session',
    !/connectRequestSession|sendMessage|connectDispatch/.test(src));
  ok('it never handles a uid as a recipient',
    !/calleeUid|recipientUid|targetRole/.test(src));
  ok('it requires nothing', !/require\(/.test(src));

  /* The header is presentation and escapes through an INJECTED function, so
     this file carries no escaping rule of its own to drift from the platform's. */
  const html = BI.headerHtml(BI.describe({ relationship: 'inquiry',
    counterpartyRole: 'seller', businessName: '<img src=x onerror=1>' }),
    (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])));
  ok('the header escapes through the injected escaper',
    html.indexOf('<img') === -1 && html.indexOf('&lt;img') !== -1, html.slice(0, 80));
  ok('…and labels the business kind for styling', /cx-who-business/.test(html));
}

Promise.all([async1]).then(() => {
  console.log('');
  console.log('  SOKONI business display identity — programme phase A');
  console.log('  ' + '-'.repeat(60));
  failures.forEach((f) => console.log('  FAIL  ' + f));
  console.log('  ' + pass + ' passed, ' + failures.length + ' failed');
  console.log('');
  process.exit(failures.length ? 1 : 0);
}).catch((e) => {
  console.error('  SUITE CRASHED — a failure, not a skip');
  console.error(e && e.stack);
  process.exit(1);
});
