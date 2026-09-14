#!/usr/bin/env node
/* SELLERS NEAR YOU — city normalisation certification.
 *
 * The defect: index.html's ACTIVE picker writes `sokoniDeliveryCity` as a DISPLAY NAME
 * ("Nyali"); script.js's reveal read `sokoniBuyerCity` as a CITY KEY ("mombasa"). Two
 * mismatches — key and shape — either of which alone hides the section permanently.
 *
 * THE PROPERTY UNDER TEST is restraint, not coverage. `_canonicalCityKey` must resolve
 * only what it can justify, and return null for everything else, because null preserves
 * the existing no-location behaviour while a wrong guess tells a shopper a seller is
 * nearby when they are a two-hour drive away.
 *
 * The function is extracted from the live script.js rather than re-typed, so this tests
 * the shipped implementation and cannot drift from it.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const NL = String.fromCharCode(10);
const src = fs.readFileSync(path.join(__dirname, '..', 'script.js'), 'utf8');

/* pull KENYA_CITIES, CITY_ALIAS and _canonicalCityKey out of the real file */
function extract (startRe, endRe) {
  const lines = src.split(NL);
  const s = lines.findIndex((l) => startRe.test(l));
  if (s < 0) return null;
  for (let i = s; i < lines.length; i++) if (endRe.test(lines[i])) return lines.slice(s, i + 1).join(NL);
  return null;
}
const cities = extract(/^const KENYA_CITIES = \{/, /^\};/);
const alias  = extract(/^const CITY_ALIAS = \{/, /^\};/);
const fn     = extract(/^function _canonicalCityKey/, /^\}/);

let pass = 0, fail = 0;
const ok = (label, cond, note) => {
  if (cond) pass++;
  else { fail++; console.log('  FAIL  ' + label + (note ? '   [' + note + ']' : '')); }
};

console.log('');
console.log('  SELLERS NEAR YOU — city normalisation');
console.log('');

if (!cities || !alias || !fn) {
  console.log('  BLOCKED — could not extract from script.js:' +
    ' KENYA_CITIES=' + !!cities + ' CITY_ALIAS=' + !!alias + ' _canonicalCityKey=' + !!fn);
  process.exit(1);
}
/* eslint-disable no-eval */
const _canonicalCityKey = eval('(function(){' + cities + NL + alias + NL + fn +
                               NL + 'return _canonicalCityKey;})()');
const KENYA_CITIES = eval('(function(){' + cities + ';return KENYA_CITIES;})()');
const CITY_ALIAS = eval('(function(){' + alias + ';return CITY_ALIAS;})()');

const SUPPORTED = Object.keys(KENYA_CITIES);
console.log('  supported cities: ' + SUPPORTED.join(', '));
console.log('  reviewed aliases: ' + (Object.keys(CITY_ALIAS).length || 'none (empty by design)'));
console.log('');

/* ── 1 · every supported city resolves, by key AND by display name ─────────── */
SUPPORTED.forEach((key) => {
  ok(key + ' (key) resolves', _canonicalCityKey(key) === key, String(_canonicalCityKey(key)));
  const name = KENYA_CITIES[key].name;
  ok(name + ' (display name) resolves to ' + key,
     _canonicalCityKey(name) === key, String(_canonicalCityKey(name)));
  ok(name + ' is case-insensitive',
     _canonicalCityKey(name.toUpperCase()) === key && _canonicalCityKey(name.toLowerCase()) === key);
  ok(name + ' tolerates surrounding space', _canonicalCityKey('  ' + name + '  ') === key);
});

/* ── 2 · labels that CONTAIN a supported city ──────────────────────────────── */
[['Nairobi CBD', 'nairobi'], ['Mombasa Island', 'mombasa'],
 ['Old Nairobi', 'nairobi'], ['Kisumu Town', 'kisumu']].forEach(([label, key]) => {
  ok('"' + label + '" -> ' + key, _canonicalCityKey(label) === key, String(_canonicalCityKey(label)));
});

/* ── 3 · THE RESTRAINT: unresolvable towns return null ─────────────────────── */
const UNMAPPED = ['Nyali', 'Mtwapa', 'Bamburi', 'Likoni', 'Malindi', 'Watamu', 'Diani',
                  'Kwale', 'Lamu', 'Kilifi', 'Ukunda', 'Voi', 'Kondele', 'Mamboleo',
                  'Ahero', 'Maseno', 'Siaya', 'Bondo', 'Kakamega', 'Westlands',
                  'Kilimani', 'Karen', 'Langata', 'Kasarani', 'Ruaka', 'Githurai'];
let leaked = [];
UNMAPPED.forEach((t) => { if (_canonicalCityKey(t) !== null) leaked.push(t + '->' + _canonicalCityKey(t)); });
ok('none of ' + UNMAPPED.length + ' unreviewed towns resolves by guesswork',
   leaked.length === 0, leaked.join(', '));
ok('Diani does NOT become mombasa (30km away is not "near")',
   _canonicalCityKey('Diani') === null);
ok('Malindi does NOT become mombasa (120km away)',
   _canonicalCityKey('Malindi') === null);

/* ── 4 · junk and hostile input return null, never throw ───────────────────── */
[null, undefined, '', '   ', 0, 42, {}, [], true, 'not a place',
 '__proto__', 'constructor', 'toString', 'nairobiX', 'Xnairobi'].forEach((bad) => {
  let r, threw = false;
  try { r = _canonicalCityKey(bad); } catch (_) { threw = true; }
  ok('input ' + JSON.stringify(bad) + ' -> null, no throw', !threw && r === null,
     threw ? 'THREW' : String(r));
});
ok('a substring match alone is not enough ("nairobiX")', _canonicalCityKey('nairobiX') === null);

/* ── 5 · resolves to something a product can actually match ────────────────── */
{
  /* production `.location` values, measured: nairobi 55, mombasa 1, remote 4 */
  const PRODUCT_LOCATIONS = ['nairobi', 'mombasa', 'remote'];
  const resolvable = SUPPORTED.filter((k) => PRODUCT_LOCATIONS.indexOf(k) > -1);
  ok('resolved keys are the same shape products carry',
     resolvable.length >= 2, resolvable.join(','));
  ok('"remote" is not a supported city and stays unresolved',
     _canonicalCityKey('remote') === null);
}

/* ══ CONTROLS ═════════════════════════════════════════════════════════════ */
console.log('  CONTROLS');
let controlsOk = true;
{
  const before = fail;
  ok('__negative_control__ (expected to fail)', 1 === 2);
  const detected = fail === before + 1;
  fail = before;
  console.log('    ' + (detected ? 'PASS' : 'FAIL') + '  assertions can fail');
  if (!detected) controlsOk = false;
}
{
  /* the ORIGINAL defect: comparing a display name to a product's city key */
  const brokenCompare = ('Nyali' === 'nairobi');
  const fixedCompare  = (_canonicalCityKey('Nairobi CBD') === 'nairobi');
  console.log('    ' + (!brokenCompare && fixedCompare ? 'PASS' : 'FAIL') +
              '  a raw display name never equals a product location key; a normalised one can');
  if (brokenCompare || !fixedCompare) controlsOk = false;
}
{
  /* prove the restraint test could fail: a permissive matcher WOULD leak */
  const permissive = (s) => {
    const t = String(s || '').toLowerCase();
    for (const k of SUPPORTED) if (t.indexOf(k[0]) === 0) return k;   /* first-letter match */
    return null;
  };
  const wouldLeak = UNMAPPED.filter((t) => permissive(t) !== null).length;
  console.log('    ' + (wouldLeak > 0 ? 'PASS' : 'FAIL') +
              '  a permissive matcher leaks ' + wouldLeak + ' towns — the restraint test can fail');
  if (wouldLeak === 0) controlsOk = false;
}

console.log('');
console.log('  ' + pass + ' passed, ' + fail + ' failed');
console.log('');
console.log('  COVERAGE, stated honestly: ' + SUPPORTED.length + ' of 106 offered towns resolve.');
console.log('  The other ~100 keep the existing no-location behaviour until someone decides');
console.log('  which city\'s sellers each town should see. That is a commercial decision about');
console.log('  proximity, and CITY_ALIAS is where it gets recorded.');
if (!controlsOk) {
  console.log('');
  console.log('  BLOCKED — a control misbehaved; the result above cannot be trusted.');
  process.exit(1);
}
process.exit(fail > 0 ? 1 : 0);
