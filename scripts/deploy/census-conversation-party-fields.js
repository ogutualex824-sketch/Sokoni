#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════════
   WHICH TRANSACTIONS CAN NAME THEIR OWN PARTIES?
   scripts/deploy/census-conversation-party-fields.js
   ══════════════════════════════════════════════════════════════════════════════
   `createConversation` derives participants from the transaction document via
   PARTY_FIELDS. That table covers 8 of the 17 anchor types; the other 9 are refused
   with failed-precondition — deliberately, because an empty participant list would
   create a conversation nobody can read, which is a different bug rather than a fix.

   But "refused" is only correct if those 9 genuinely cannot name their parties. If a
   collection DOES carry a uid and the table simply missed it, then a legitimate
   conversation is being refused — the fail-closed direction, but still wrong, and
   invisible because refusing looks exactly like being careful.

   So this reads the WRITERS in functions/ for each anchor collection and reports the
   uid-shaped fields they actually write. Evidence for extending the table, or evidence
   that the refusal is right.

   Read-only. Reports; changes nothing.
   Usage: node scripts/deploy/census-conversation-party-fields.js
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const FN = path.join(ROOT, 'functions');

/* the anchor table, read from the module itself so the two cannot drift */
const msgs = require(path.join(FN, 'messages.js'));
const PARTY_FIELDS = msgs._PARTY_FIELDS || {};

/* TX_COLLECTIONS is not exported; read it from the source rather than duplicating it,
   so a new anchor type cannot be silently missed by this census */
const src = fs.readFileSync(path.join(FN, 'messages.js'), 'utf8');
const block = /const TX_COLLECTIONS = \{([\s\S]*?)\n\};/.exec(src);
if (!block) { console.error('TX_COLLECTIONS not found — refusing to guess'); process.exit(2); }
const TX = {};
for (const m of block[1].matchAll(/(\w+)\s*:\s*'([^']+)'/g)) TX[m[1]] = m[2];

/* uid-shaped field names, as this codebase spells them */
const UIDISH = /\b([a-zA-Z]*(?:[Uu]id|UserId|DriverId|RiderId|ProviderId|SellerId|BuyerId|OwnerId|ClientId|CustomerId|MerchantId|RestaurantId|HostId|AgentId|LandlordId|DoctorId|LawyerId))\b/g;

const files = fs.readdirSync(FN).filter((f) => f.endsWith('.js'));
const sources = files.map((f) => ({ f, s: fs.readFileSync(path.join(FN, f), 'utf8') }));

console.log('\nCONVERSATION ANCHORS — can each one name its parties?\n');
const covered = [], gap = [], none = [];

for (const [type, coll] of Object.entries(TX)) {
  const has = PARTY_FIELDS[type];
  /* find writers: any file that writes to this collection */
  const writers = sources.filter(({ s }) =>
    new RegExp("collection\\(\\s*['\"]" + coll + "['\"]").test(s));
  /* uid-shaped fields appearing anywhere near that collection's name in those files */
  const fields = new Set();
  for (const { s } of writers) {
    const re = new RegExp("collection\\(\\s*['\"]" + coll + "['\"][\\s\\S]{0,1400}", 'g');
    let m;
    while ((m = re.exec(s))) {
      for (const f of m[0].matchAll(UIDISH)) fields.add(f[1]);
    }
  }
  const list = Array.from(fields).sort();
  const row = { type, coll, writers: writers.map((w) => w.f), fields: list, has: !!has };
  if (has) covered.push(row);
  else if (list.length) gap.push(row);
  else none.push(row);
}

const show = (title, rows, note) => {
  console.log('-- ' + title + ' (' + rows.length + ') --' + (note ? '  ' + note : ''));
  for (const r of rows) {
    console.log('  ' + r.type.padEnd(24) + r.coll.padEnd(24) +
      (r.has ? 'DERIVES: ' + PARTY_FIELDS[r.type].join(', ') : 'candidates: ' + (r.fields.join(', ') || '(none)')));
    if (!r.has && r.writers.length) console.log('    writers: ' + r.writers.join(', '));
  }
  console.log('');
};

show('COVERED — the table derives parties', covered);
show('REFUSED, but the collection DOES carry uid-shaped fields', gap,
  '<- review: a legitimate conversation may be refused');
show('REFUSED, and nothing uid-shaped found', none, '<- refusal looks correct');

console.log('  ' + covered.length + ' covered · ' + gap.length + ' refused-with-candidates · ' +
  none.length + ' refused-with-nothing   (of ' + Object.keys(TX).length + ' anchors)\n');
