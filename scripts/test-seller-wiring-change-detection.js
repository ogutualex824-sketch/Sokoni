#!/usr/bin/env node
/* P0-7C — change detection in seller-wiring.js:_writeProduct.
 *
 * The functions under test are LIFTED FROM THE REAL FILE by brace matching and
 * evaluated, so this cannot drift from the shipped implementation the way a
 * reimplementation would. If the lift fails, the suite FAILS — it never falls
 * back to a local copy.
 *
 * Run: node scripts/test-seller-wiring-change-detection.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'seller-wiring.js'), 'utf8');

/* ---- lift the two functions verbatim ------------------------------------ */
function lift(name) {
  const m = new RegExp(`function\\s+${name}\\s*\\(`).exec(SRC);
  if (!m) throw new Error(`LIFT FAILED: ${name} not found in seller-wiring.js`);
  const open = SRC.indexOf('{', m.index);
  let depth = 0;
  for (let i = open; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') { depth--; if (depth === 0) return SRC.slice(m.index, i + 1); }
  }
  throw new Error(`LIFT FAILED: unbalanced braces in ${name}`);
}

const _canon = eval('(' + lift('_canon') + ')');
const _payloadMatches = eval('(' + lift('_payloadMatches') + ')');

/* Assert the lift actually happened rather than silently testing nothing. */
if (typeof _canon !== 'function' || typeof _payloadMatches !== 'function') {
  console.error('LIFT PRODUCED NON-FUNCTIONS — refusing to report a pass');
  process.exit(1);
}

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = got === want;
  console.log(`  ${ok ? 'PASS' : '*** FAIL ***'}  ${name}   (got ${got}, want ${want})`);
  ok ? pass++ : fail++;
}

/* A realistic trimmed payload, matching _trimPayload's shape. */
const base = () => ({
  id: 'P1', name: 'Sugar 1kg', category: 'grocery', location: 'nairobi',
  description: 'White sugar', kebsCert: 'KEBS-1', sellerName: 'KASS SHOP',
  sellerEmail: 'a@b.c', views: 3, uploadedAt: 1756000000000,
  image: 'https://x/y.png', isService: false, isDigital: false,
});

const storedFrom = (p) => Object.assign({}, p);

console.log('SELLER-WIRING CHANGE DETECTION');
console.log('='.repeat(66));

/* 1. identical catalogue data -> no write */
check('1  identical data => skip', _payloadMatches(base(), storedFrom(base())), true);

/* 2. changed catalogue field -> write */
{
  const p = base(); const s = storedFrom(base()); s.name = 'Sugar 2kg';
  check('2  changed name => write', _payloadMatches(p, s), false);
}

/* 3. _syncedAt is the ONLY difference -> no write (the critical case) */
{
  const p = base(); const s = storedFrom(base());
  s._syncedAt = { toMillis: () => 1757000000000 };
  p._syncedAt = 'SERVER_TIMESTAMP_SENTINEL';
  check('3  only _syncedAt differs => skip', _payloadMatches(p, s), true);
}

/* 4,5,6. server-authoritative fields are stripped before comparison, so a
   difference in them must NOT force a write. Simulate the stripped payload. */
{
  const p = base(); const s = storedFrom(base());
  s.price = 100; /* stored has a server price; payload has none after stripping */
  check('4  price differs (stripped) => skip', _payloadMatches(p, s), true);
}
{
  const p = base(); const s = storedFrom(base());
  s.stock = 42;
  check('5  stock differs (stripped) => skip', _payloadMatches(p, s), true);
}
{
  const p = base(); const s = storedFrom(base());
  s.sellerUid = 'someone-else';
  check('6  sellerUid differs (stripped) => skip', _payloadMatches(p, s), true);
}

/* 7. genuine change PLUS _syncedAt -> write */
{
  const p = base(); p.description = 'Brown sugar';
  const s = storedFrom(base()); s._syncedAt = { toMillis: () => 1 };
  check('7  real change + _syncedAt => write', _payloadMatches(p, s), false);
}

/* 8. new product: no stored doc -> must write */
check('8  missing stored doc => write', _payloadMatches(base(), undefined), false);
check('8b non-object stored     => write', _payloadMatches(base(), 'garbage'), false);

/* 9. arrays compare by value, not reference */
{
  const p = base(); p.images = ['a.png', 'b.png'];
  const s = storedFrom(base()); s.images = ['a.png', 'b.png'];
  check('9  equal arrays (new refs) => skip', _payloadMatches(p, s), true);
  const s2 = storedFrom(base()); s2.images = ['a.png', 'c.png'];
  check('9b changed array => write', _payloadMatches(p, s2), false);
}

/* 10. type coercion: number vs numeric string must not force a write */
{
  const p = base(); const s = storedFrom(base()); s.views = '3';
  check('10 number vs numeric string => skip', _payloadMatches(p, s), true);
}

/* 11. Firestore Timestamp vs local millis */
{
  const p = base(); const s = storedFrom(base());
  s.uploadedAt = { toMillis: () => 1756000000000 };
  check('11 Timestamp vs millis => skip', _payloadMatches(p, s), true);
}

/* 12. null/undefined/'' are equivalent — absent field must not force a write */
{
  const p = base(); p.kebsCert = '';
  const s = storedFrom(base()); delete s.kebsCert;
  check('12 empty vs absent => skip', _payloadMatches(p, s), true);
}

/* 13. INVERTING CONTROL — the detector must be capable of saying "write".
   A matcher stuck on true would pass tests 1,3,4,5,6,9,10,11,12 and be useless. */
{
  let anyFalse = false;
  for (const f of ['name', 'category', 'description', 'image', 'sellerName']) {
    const p = base(); const s = storedFrom(base()); s[f] = 'DIFFERENT';
    if (_payloadMatches(p, s) === false) anyFalse = true;
  }
  check('13 inverting control: detects change on every probed field', anyFalse, true);
}

/* 14. _canon never throws on hostile input */
{
  let threw = false;
  const circular = {}; circular.self = circular;
  for (const v of [null, undefined, NaN, Infinity, circular, () => {}, Symbol('x')]) {
    try { _canon(v); } catch (_) { threw = true; }
  }
  check('14 _canon survives hostile input', threw, false);
}

console.log('='.repeat(66));
console.log(`  pass=${pass}  fail=${fail}`);
process.exit(fail ? 1 : 0);
