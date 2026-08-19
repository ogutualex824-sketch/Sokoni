/* ══════════════════════════════════════════════════════════════════════════════
   CONVERSATION PARTY CENSUS — which fields name a transaction's parties
   ══════════════════════════════════════════════════════════════════════════════
   READ-ONLY code census. No production data, no writes, nothing changed.

   createConversation currently accepts participantUids from the client and never
   checks them against the transaction. Fixing that means deriving parties from
   the transaction — which requires knowing, per collection, WHICH FIELDS name
   them. Those names must be MEASURED: they differ per collection, and guessing
   them would rebuild the same class of defect as the eight-spelling destination
   problem.

   Two independent sources are read and compared:
     · firestore.rules  — authoritative, because the rules already gate reads on
                          exactly the fields that identify a party
     · the writers      — what actually gets written

   A field the rules trust but no writer emits (or vice-versa) is a divergence
   worth seeing before any fix is designed.

   Run: node scripts/census-conversation-parties.js
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const RULES = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');
const MSGS = fs.readFileSync(path.join(ROOT, 'functions/messages.js'), 'utf8');

/* The mapping the messaging authority itself uses — read from source, never restated. */
const block = MSGS.match(/const TX_COLLECTIONS = \{([\s\S]*?)\n\};/);
if (!block) { console.error('TX_COLLECTIONS not found — messages.js shape changed.'); process.exit(2); }
const TX = {};
[...block[1].matchAll(/^\s*([a-z_]+):\s*'([A-Za-z]+)'/gm)].forEach((m) => { TX[m[1]] = m[2]; });

console.log('\nCONVERSATION PARTY CENSUS  (code, read-only)');
console.log('='.repeat(78));
console.log('  transaction types declared by functions/messages.js: ' + Object.keys(TX).length);

/* Pull the rules block for a collection: match /<col>/{id} { … } by brace balance. */
function rulesFor (col) {
  const at = RULES.search(new RegExp('match /' + col + '/\\{'));
  if (at < 0) return null;
  /* The body opener is NOT simply the next '{'. A rules path is written
     `match /orders/{orderId} {` — the first brace belongs to the PATH PLACEHOLDER,
     and counting it made every block 23 characters long and every collection look
     as though its rules named no party at all. The body opener is the brace that
     ends its line, so anchor on that. */
  const open = RULES.slice(at).search(/\{[ \t]*\r?\n/);
  if (open < 0) return null;
  let depth = 0;
  for (let i = at + open; i < RULES.length; i++) {
    if (RULES[i] === '{') depth++;
    else if (RULES[i] === '}') { depth--; if (!depth) return RULES.slice(at, i + 1); }
  }
  return null;
}

/* Any `resource.data.X == request.auth.uid` names a party. That comparison IS the
   definition of "this account is a party to this record". */
function partiesFromRules (src) {
  if (!src) return [];
  const s = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const out = new Set();
  for (const m of s.matchAll(/resource\.data\.([A-Za-z_][\w]*)\s*==\s*request\.auth\.uid/g)) out.add(m[1]);
  for (const m of s.matchAll(/request\.auth\.uid\s*==\s*resource\.data\.([A-Za-z_][\w]*)/g)) out.add(m[1]);
  /* array membership, e.g. participants */
  for (const m of s.matchAll(/request\.auth\.uid in resource\.data\.([A-Za-z_][\w]*)/g)) out.add(m[1] + '[]');
  return [...out].sort();
}

const ROLE = {
  buyer:  /^(uid|userId|buyerId|buyerUid|customerUid|patientUid|clientUid|applicantUid|senderUid|requesterUid)$/i,
  seller: /^(sellerUid|sellerId|merchantId|ownerId|providerUid|vendorUid|shopOwnerId|hostUid|lawyerUid|doctorUid|employerUid)$/i,
  /* assignedDriverId vs assignedDriverUid: orders and packageRequests name the SAME
     role differently. Both must classify as rider or the census hides the divergence. */
  rider:  /^(assignedDriverUid|assignedDriverId|assignedRiderId|riderId|riderUid|driverUid|driverId|courierUid)$/i,
};
const classify = (f) => (ROLE.buyer.test(f) ? 'buyer' : ROLE.seller.test(f) ? 'seller' : ROLE.rider.test(f) ? 'rider' : 'other');

const rows = [];
Object.keys(TX).forEach((type) => {
  const col = TX[type];
  const src = rulesFor(col);
  const fields = partiesFromRules(src);
  const by = { buyer: [], seller: [], rider: [], other: [] };
  fields.forEach((f) => by[classify(f)].push(f));
  rows.push({ type, col, hasRules: !!src, fields, by });
});

const pad = (s, n) => String(s).padEnd(n);
console.log('\n  TRANSACTION            COLLECTION            RULES  BUYER / SELLER / RIDER / OTHER');
console.log('  ' + '-'.repeat(74));
rows.forEach((r) => {
  console.log('  ' + pad(r.type, 22) + pad(r.col, 22) + pad(r.hasRules ? 'yes' : 'NO ', 7) +
    (r.fields.length ? [r.by.buyer.join(','), r.by.seller.join(','), r.by.rider.join(','), r.by.other.join(',')]
      .map((x) => x || '—').join(' / ') : '(no uid comparison in rules)'));
});

/* ── The findings that matter for the fix ─────────────────────────────────── */
const noRules = rows.filter((r) => !r.hasRules);
const noParty = rows.filter((r) => r.hasRules && !r.fields.length);
const noRider = rows.filter((r) => r.hasRules && r.fields.length && !r.by.rider.length);
const multiBuyer = rows.filter((r) => r.by.buyer.length > 1);

console.log('\n  FINDINGS');
console.log('  ' + '-'.repeat(74));
console.log('    types whose collection has NO rules block      : ' + noRules.length +
            (noRules.length ? '  [' + noRules.map((r) => r.col).join(', ') + ']' : ''));
console.log('    types whose rules name NO party field          : ' + noParty.length +
            (noParty.length ? '  [' + noParty.map((r) => r.col).join(', ') + ']' : ''));
console.log('    types with NO rider field (rider cannot join)  : ' + noRider.length);
console.log('    types with MORE THAN ONE buyer-ish field       : ' + multiBuyer.length +
            (multiBuyer.length ? '  [' + multiBuyer.map((r) => r.col + ':' + r.by.buyer.join('|')).join(', ') + ']' : ''));

console.log('\n  A collection with no rules block, or no uid comparison, cannot have its parties');
console.log('  derived server-side at all — those types must be handled explicitly rather than');
console.log('  silently producing an empty participant list.');
console.log('\n  MORE THAN ONE buyer-ish field is the destination problem in another guise: the');
console.log('  fix must read ALL of them, or it will drop a legitimate party.');
console.log('\n' + '='.repeat(78) + '\n');
