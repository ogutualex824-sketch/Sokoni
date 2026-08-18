/* ══════════════════════════════════════════════════════════════════════════════
   merchantAdjustStock — CLIENT ↔ SERVER CONTRACT AGREEMENT
   ══════════════════════════════════════════════════════════════════════════════
   `scripts/test-merchant-adjust-stock.js` proves the function's LOGIC against a
   Firestore double: ownership, idempotency, the floor, `sold` untouched. It
   proves nothing about whether the callers and the callable agree on the wire.

   That is the gap this closes, and it is the gap that actually bites after a
   deploy. The POS field divergence already in this repo is the same shape: a
   rule, a writer and a reader each believing a slightly different contract, so
   the writes land and simply never show up. Nothing there was "broken" in
   isolation.

   THIS IS ALSO A DEPLOY GUARD. `merchantAdjustStock` is called by shipped client
   code (`pos-mobile.js` restock, and Merchant v2's inventory surface) but is NOT
   yet deployed. Hosting must not go out ahead of it. Every assertion here is a
   precondition of that functions deploy:

     · the callable is re-exported BY NAME from functions/index.js
       (an orphan or missing export aborts a functions deploy outright)
     · both files parse
     · the reason vocabularies are IDENTICAL, not merely similar
     · every key a client sends is read by the server, and every key the server
       REQUIRES is sent by every client
     · region agreement: the server pins us-central1 and the clients resolve the
       default, which is us-central1 — an unpinned mismatch is a silent 404
     · App Check stays enforced on a surface that mutates canonical stock
     · the Sell module still cannot express a correction

   Run: node scripts/test-merchant-adjust-contract.js
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs   = require('fs');
const path = require('path');
const cp   = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const R    = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

let pass = 0, fail = 0, warn = 0;
const check = (label, ok, detail) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? '   [' + detail + ']' : ''));
  ok ? pass++ : fail++;
};
const note = (label, detail) => { console.log('  NOTE  ' + label + (detail ? '   [' + detail + ']' : '')); warn++; };

console.log('\nmerchantAdjustStock — CONTRACT AGREEMENT');
console.log('='.repeat(78));

const SRV = R('functions/merchant-inventory.js');
const IDX = R('functions/index.js');

/* ── 1. Deploy integrity ──────────────────────────────────────────────────── */
console.log('\n1. Deploy integrity (an orphan or missing export aborts the deploy)');

['functions/merchant-inventory.js', 'functions/index.js'].forEach(f => {
  let ok = true, msg = 'parses';
  try { cp.execFileSync(process.execPath, ['--check', path.join(ROOT, f)], { stdio: 'pipe' }); }
  catch (e) { ok = false; msg = String((e.stderr || '')).split('\n')[0].slice(0, 80); }
  check('parses: ' + f, ok, msg);
});

check('functions/index.js requires ./merchant-inventory',
      /require\(["']\.\/merchant-inventory["']\)/.test(IDX));
check('functions/index.js re-exports merchantAdjustStock BY NAME',
      /exports\.merchantAdjustStock\s*=/.test(IDX),
      (IDX.match(/exports\.merchantAdjustStock\s*=\s*[^\n;]+/) || ['MISSING'])[0].trim());
check('the module actually defines it',
      /exports\.merchantAdjustStock\s*=\s*onCall\(/.test(SRV));

/* ── 2. Runtime configuration ─────────────────────────────────────────────── */
console.log('\n2. Runtime configuration');

const region = (SRV.match(/const REGION\s*=\s*'([a-z0-9-]+)'/) || [])[1];
check('server pins an explicit region', !!region, region || 'UNPINNED');
/* A client that calls getFunctions(app) with no region resolves us-central1. If
   the server ever moves, every one of these callers 404s silently. */
check('...and it is us-central1, which is what getFunctions(app) resolves to',
      region === 'us-central1', region);
['pos-db.js', 'merchant-v2.html'].forEach(f => {
  const src = R(f);
  if (!/merchantAdjustStock|_callable/.test(src)) return;
  check(f + ': resolves functions with no explicit region (matches the pin)',
        /getFunctions\(\s*window\.firebaseApp\s*\)/.test(src));
});

check('App Check is ENFORCED on this stock-mutating surface',
      /enforceAppCheck:\s*true/.test(SRV));

/* ── 3. The reason vocabulary is IDENTICAL ────────────────────────────────── */
console.log('\n3. Reason vocabulary (a client-only reason is rejected at the server)');

const sBlock = SRV.match(/const REASONS = Object\.freeze\(\[([\s\S]*?)\]\)/);
check('server REASONS parsed', !!sBlock);
const serverReasons = sBlock ? [...sBlock[1].matchAll(/'([a-z_]+)'/g)].map(m => m[1]).sort() : [];

const STOCK = R('sokoni-merchant-stock.js');
const cBlock = STOCK.match(/var REASONS = \[([\s\S]*?)\n\s*\];/);
check('client REASONS parsed', !!cBlock);
const clientReasons = cBlock ? [...cBlock[1].matchAll(/id:\s*'([a-z_]+)'/g)].map(m => m[1]).sort() : [];

check('client and server reason vocabularies are IDENTICAL',
      serverReasons.length > 0 && serverReasons.join(',') === clientReasons.join(','),
      serverReasons.join(',') === clientReasons.join(',')
        ? serverReasons.length + ' reasons'
        : 'server-only: ' + serverReasons.filter(r => !clientReasons.includes(r)).join(',') +
          ' | client-only: ' + clientReasons.filter(r => !serverReasons.includes(r)).join(','));

/* Any literal reason a caller passes must be in the server's list. */
const POSDB = R('pos-db.js');
const POSMOB = R('pos-mobile.js');
[['pos-db.js', POSDB], ['pos-mobile.js', POSMOB]].forEach(([name, src]) => {
  const lits = [...src.matchAll(/correctStock\([^)]*?,\s*'([a-z_]+)'/g)].map(m => m[1]);
  const dflt = (src.match(/reason:\s*reason\s*\|\|\s*'([a-z_]+)'/) || [])[1];
  const all = [...new Set([...lits, ...(dflt ? [dflt] : [])])];
  if (!all.length) return;
  check(name + ': every literal reason is in the server vocabulary',
        all.every(r => serverReasons.includes(r)),
        all.join(',') + (all.every(r => serverReasons.includes(r)) ? '' : ' <- REJECTED'));
});

/* ── 4. Wire shape ────────────────────────────────────────────────────────── */
console.log('\n4. Payload and result shape');

/* Keys the server reads out of req.data. */
const serverReads = [...SRV.matchAll(/_san\(d\.([a-zA-Z]+)|Number\(d\.([a-zA-Z]+)\)/g)]
  .map(m => m[1] || m[2]).filter(Boolean);
const serverRequired = ['productId', 'shopId', 'adjustmentId', 'delta', 'reason'];
check('server reads the expected keys', serverRequired.every(k => serverReads.includes(k)),
      [...new Set(serverReads)].join(','));

/* Each caller must send every REQUIRED key. */
const CALLERS = [
  { name: 'pos-db.js correctStock', src: POSDB, at: /callable\(\{([\s\S]*?)\}\);/ },
  { name: 'sokoni-merchant-stock.js buildAdjustment', src: STOCK, at: /return \{\s*\n\s*productId:([\s\S]*?)\n\s*\};/ },
];
/* Object-literal keys, BOTH forms. ES6 shorthand (`shopId,`) carries no colon, and a
   `key:` -only regex reports it missing — which it did, accusing pos-db.js of omitting
   shopId and adjustmentId that are plainly there. A detector that cannot see a standard
   language feature manufactures defects, which is worse than missing real ones. */
const literalKeys = (text) =>
  [...text.matchAll(/(?:^|[{,])\s*(\w+)\s*(?=[:,}])/g)].map(m => m[1]);

/* Negative control for the extractor itself, run before it is trusted. */
const probe = literalKeys('{ productId: id, shopId, adjustmentId, delta: 1, reason: r }');
check('key extractor sees BOTH explicit and shorthand keys',
      ['productId', 'shopId', 'adjustmentId', 'delta', 'reason'].every(k => probe.includes(k)),
      probe.join(','));
check('...and does not invent keys that are not there', !probe.includes('id') && !probe.includes('r'),
      probe.join(','));

CALLERS.forEach(c => {
  const m = c.src.match(c.at);
  if (!m) { check(c.name + ': payload located', false, 'not found'); return; }
  const sent = literalKeys(m[0]);
  const missing = serverRequired.filter(k => !sent.includes(k));
  check(c.name + ': sends every required key', missing.length === 0,
        missing.length ? 'MISSING ' + missing.join(',')
                       : [...new Set(sent.filter(k => serverRequired.includes(k)))].join(','));
});

/* Result keys the callers depend on must be the ones the server returns. */
const returns = ['ok', 'idempotent', 'before', 'after', 'inventoryVersion'];
check('server returns ok + the applied numbers',
      /return \{ ok: true, \.\.\.result \}/.test(SRV) &&
      /inventoryVersion: nextVersion/.test(SRV), returns.join(','));
check('pos-db.js reads the SERVER\'s after/inventoryVersion, never a local recompute',
      /r\.after/.test(POSDB) && /r\.inventoryVersion/.test(POSDB) &&
      !/p\.stock\s*\+=|p\.stock\s*=\s*p\.stock/.test(POSDB));

/* ── 5. The sale / correction wall ────────────────────────────────────────── */
console.log('\n5. The sale / correction wall');

check('the server never touches products.sold', !/\bsold\b\s*:/.test(SRV),
      'sold absent from every write');
check('the Sell module cannot express a correction',
      !/merchantAdjustStock/.test(R('sokoni-merchant-data.js')),
      'sokoni-merchant-data.js is clean');
check('a sale still routes to posCompleteCheckout, not here',
      /posCompleteCheckout/.test(SRV) && !/posCompleteCheckout\s*\(/.test(SRV),
      'referenced in prose only');

/* ── 6. Divergences worth knowing about ───────────────────────────────────── */
console.log('\n6. Divergences (non-blocking, but they should not be discovered by a merchant)');

const srvNote = Number((SRV.match(/_san\(d\.note,\s*(\d+)\)/) || [])[1] || 0);
const cliNote = Number((STOCK.match(/String\(o\.note\)\.slice\(0,\s*(\d+)\)/) || [])[1] || 0);
if (srvNote && cliNote && cliNote > srvNote) {
  note('client accepts a longer note than the server keeps — silently truncated',
       'client ' + cliNote + ' chars -> server ' + srvNote);
} else {
  check('note length agrees between client and server', srvNote === cliNote || !cliNote,
        'server ' + srvNote + ' / client ' + (cliNote || 'n/a'));
}

console.log('\n' + '='.repeat(78));
console.log('  ' + pass + ' passed, ' + fail + ' failed' + (warn ? ', ' + warn + ' note(s)' : ''));
console.log('='.repeat(78) + '\n');
process.exit(fail ? 1 : 0);
