/* ══════════════════════════════════════════════════════════════════════════════
   FINANCE INVOICES — DISPATCH CALLER CERTIFICATION
   scripts/test-finance-invoices-dispatch.js    node scripts/test-finance-invoices-dispatch.js

   THE DEFECT THIS PINS
   The 37 Finance OS Sprint 4.3 callables were consolidated into ONE Cloud Run service.
   `functions/index.js` — the deploy entry point ("main": "index.js") — exports
   `financeSprintDispatch` and NONE of invoiceCreate / invoiceList / invoiceSend /
   invoiceMarkPaid / invoiceVoid. `finance-invoices.html` called all five BY NAME, so every
   button on a live, header-linked page targeted a function that does not exist. Its sibling
   clients (budget, expenses, reconcile) were migrated; this one was missed.

   WHY THE WRAPPER IS EXECUTED, NOT READ
   A regex that finds the string 'financeSprintDispatch' in the file proves only that the
   word is present — a comment mentioning it would satisfy that. So the real `_cf` is
   extracted from the page, evaluated against a STUB firebase, and CALLED. What is asserted
   is the payload it actually produces.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (n, c, d) => {
  if (c) { pass++; console.log('  PASS  ' + n + (d ? '   [' + d + ']' : '')); }
  else { fail++; console.log('  FAIL  ' + n + (d ? '   [' + d + ']' : '')); }
};
const head = t => console.log('\n' + t);
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

const PAGE = 'finance-invoices.html';
const OPS = ['invoiceCreate', 'invoiceList', 'invoiceSend', 'invoiceMarkPaid', 'invoiceVoid'];
const html = read(PAGE);

/* Extract `function _cf(...) { … }` by brace matching, so a multi-line body is captured
   whole and the next function is not swallowed. */
function extractFn (src, name) {
  const start = src.indexOf('function ' + name);
  if (start === -1) return null;
  const open = src.indexOf('{', start);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return null;
}

console.log('══════════════════════════════════════════════════════════════════');
console.log('  FINANCE INVOICES — DISPATCH CALLER');
console.log('══════════════════════════════════════════════════════════════════');

/* ── 1. THE CALL SITES ARE UNCHANGED ────────────────────────────────────────── */
head('1 - the five operations are still requested by name');
{
  OPS.forEach(op => ok('call site _cf(\'' + op + '\') still present',
                       html.indexOf("_cf('" + op + "')") > -1));
  /* The op names must match what the dispatcher can actually route. */
  const h = require(path.join(ROOT, 'functions', 'finance-os-sprint43.js'))._h || {};
  OPS.forEach(op => ok('op "' + op + '" exists in the dispatcher registry',
                       typeof h[op] === 'function'));
  ok('control — the registry is populated and a typo would fail',
     typeof h.invoiceTypo !== 'function' && Object.keys(h).length > 5,
     Object.keys(h).length + ' handlers');
}

/* ── 2. THE WRAPPER, EXECUTED ───────────────────────────────────────────────── */
head('2 - what the wrapper actually does when called');
{
  const src = extractFn(html, '_cf');
  ok('control — the _cf wrapper was extracted', !!src && src.length > 30,
     src ? src.length + ' chars' : 'NOT FOUND');

  const calls = [];
  const firebase = {
    functions: () => ({
      httpsCallable: (name) => {
        const target = name;
        return (payload) => { calls.push({ target, payload }); return Promise.resolve({ data: {} }); };
      },
    }),
  };
  /* eslint-disable no-new-func */
  const make = new Function('firebase', src + '\n return _cf;');
  const _cf = make(firebase);

  return_block: {
    const fn = _cf('invoiceList');
    ok('_cf returns a callable', typeof fn === 'function');
    fn({ shopId: 's1', status: 'sent' });

    ok('control — exactly one dispatch was made', calls.length === 1, String(calls.length));
    const c = calls[0];

    /* THE TARGET. */
    ok('it resolves financeSprintDispatch', c.target === 'financeSprintDispatch', c.target);
    ok('and NOT the legacy invoice function name', c.target !== 'invoiceList');
    ok('nor any of the five legacy names', OPS.indexOf(c.target) === -1);

    /* THE OP INJECTION — asserted separately from the target, so the two can fail apart. */
    ok('the op is injected into the payload', c.payload && c.payload.op === 'invoiceList',
       JSON.stringify(c.payload));

    /* THE CALLER'S DATA SURVIVES. */
    ok('caller data survives unchanged (shopId)', c.payload.shopId === 's1');
    ok('caller data survives unchanged (status)', c.payload.status === 'sent');
    ok('no caller field is dropped', Object.keys(c.payload).sort().join(',') === 'op,shopId,status',
       Object.keys(c.payload).join(','));
  }

  /* EVERY op routes through the same single target. */
  calls.length = 0;
  OPS.forEach(op => _cf(op)({ shopId: 's1' }));
  ok('all five operations dispatch to one target',
     calls.length === 5 && calls.every(c => c.target === 'financeSprintDispatch'));
  ok('and each carries its own op',
     calls.map(c => c.payload.op).join(',') === OPS.join(','),
     calls.map(c => c.payload.op).join(','));

  /* A call with NO data must still carry the op — `data || {}`. */
  calls.length = 0;
  _cf('invoiceList')();
  ok('a dataless call still carries its op', calls[0].payload.op === 'invoiceList');
}

/* ── 3. THE EXPORT CONTRACT THIS DEPENDS ON ─────────────────────────────────── */
head('3 - the deployed surface, re-proven rather than assumed');
{
  const index = read('functions/index.js');
  ok('financeSprintDispatch IS exported', /exports\.financeSprintDispatch\s*=/.test(index));
  OPS.forEach(op => ok('legacy "' + op + '" is NOT exported',
                       !new RegExp('exports\\.' + op + '\\b').test(index)));
  /* index.js is genuinely the deploy surface. */
  const pkg = JSON.parse(read('functions/package.json'));
  ok('control — index.js is the deploy entry point', pkg.main === 'index.js', pkg.main);
}

/* ── 4. SHAPE PARITY WITH THE MIGRATED SIBLINGS ─────────────────────────────── */
head('4 - the same wrapper the already-migrated clients use');
{
  const siblings = ['finance-budget.html', 'finance-expenses.html', 'finance-reconcile.html'];
  const norm = s => s.replace(/\s+/g, ' ').trim();
  const mine = norm(extractFn(html, '_cf') || '');
  siblings.forEach(f => {
    const theirs = norm(extractFn(read(f), '_cf') || '');
    ok(f + ' uses an identical wrapper', theirs.length > 0 && theirs === mine,
       theirs === mine ? 'identical' : theirs.slice(0, 70));
  });
}

console.log('\n  what this suite does NOT prove');
console.log('  UNPROVEN  a live dispatcher round-trip   [needs an authenticated shop member]');

console.log('\n══════════════════════════════════════════════════════════════════');
console.log('  ' + pass + ' passed, ' + fail + ' failed');
console.log('══════════════════════════════════════════════════════════════════');
process.exit(fail ? 1 : 0);
