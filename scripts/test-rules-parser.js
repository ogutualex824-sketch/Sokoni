#!/usr/bin/env node
/* ============================================================================
   The rules scanner must be trustworthy BEFORE it is allowed to authorize a
   production rules replacement. These fixtures are the three failures that
   actually happened, plus the cases that would hide a fourth.
   ========================================================================= */
'use strict';
const { scan } = require('./rules-blocks.js');
let pass = 0; const failures = [];
const ok = (n, c, d) => { if (c) { pass++; return true; } failures.push(n + (d ? '  — ' + d : '')); return false; };
const paths = (s) => scan(s).map((b) => b.path);

/* 1 — a `match` inside a LINE comment is not syntax. */
ok('a // comment mentioning match is ignored',
  JSON.stringify(paths('// match /fake/{id}\nmatch /real/{id} { allow read: if true; }'))
    === JSON.stringify(['/real/{id}']));

/* 2 — a `match` inside a BLOCK comment is not syntax. This is failure #3. */
ok('a block comment mentioning match is ignored',
  JSON.stringify(paths('/* match /fake/{id} merged here (was duplicated) */\nmatch /real/{id} { allow read: if true; }'))
    === JSON.stringify(['/real/{id}']));

/* 3 — prose before the real block, exactly as firestore.rules is written. */
{
  const src = `
    /* REMOVED (B-17 fix): duplicate match /digitalProducts/{productId} — this block
       permitted client-side create. Canonical block is below. */
    match /digitalProducts/{productId} { allow write: if false; }`;
  ok('prose naming a path does not become a block',
    JSON.stringify(paths(src)) === JSON.stringify(['/digitalProducts/{productId}']),
    JSON.stringify(paths(src)));
}

/* 4 — failure #1: the PATH wildcard is not the body brace. */
{
  const b = scan('match /shops/{storeId} { allow read: if true; allow write: if false; }')[0];
  ok('a path wildcard is not mistaken for the body', !!b && b.body.length > 30, b ? String(b.body.length) : 'none');
  ok('…and the path is read whole', b && b.path === '/shops/{storeId}', b && b.path);
}

/* 5 — failure #2: braces in a default/expression are not the body brace. */
ok('braces inside parentheses are not the body',
  JSON.stringify(paths('match /x/{id} { allow read: if f(a == {b: 1}); }')) === JSON.stringify(['/x/{id}']));

/* 6 — braces and `match` inside STRINGS are inert. */
{
  const src = 'match /real/{id} {\n  allow read: if request.auth.token.foo == "{not-a-path} match /fake/{x}";\n}';
  ok('a brace inside a string does not close the body',
    JSON.stringify(paths(src)) === JSON.stringify(['/real/{id}']), JSON.stringify(paths(src)));
}
ok('an escaped quote does not end a string early',
  JSON.stringify(paths('match /r/{id} { allow read: if x == "a\\" match /fake/{y}"; }')) === JSON.stringify(['/r/{id}']));

/* 7 — nested matches are found, outer first. */
{
  const p = paths('match /a/{x} { allow read: if true; match /b/{y} { allow read: if true; } }');
  ok('a nested match is found', p.length === 2 && p[0] === '/a/{x}' && p[1] === '/b/{y}', JSON.stringify(p));
}

/* 8 — `matches()` is not `match`. A word-boundary failure here would invent
      a block from every regex validation in the ruleset. */
ok('the matches() function is not read as a match block',
  paths("match /r/{id} { allow read: if s.matches('^[a-z]+$'); }").length === 1);
ok('…nor is a word merely containing match',
  paths('match /r/{id} { allow read: if rematched == true; }').length === 1);

/* 9 — CONTROL: the scanner CAN find blocks, so the absences above mean
      something. A parser that returned nothing would pass every test above. */
ok('CONTROL: the scanner finds real blocks',
  paths('match /a/{x} { allow read: if true; }\nmatch /b/{y} { allow read: if true; }').length === 2);

console.log('');
console.log('  SOKONI rules scanner — parser self-test');
console.log('  ' + '-'.repeat(60));
failures.forEach((f) => console.log('  FAIL  ' + f));
console.log('  ' + pass + ' passed, ' + failures.length + ' failed');
console.log('');
process.exit(failures.length ? 1 : 0);
