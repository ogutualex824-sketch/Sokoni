/* ══════════════════════════════════════════════════════════════════════════════
   CHECKOUT — the saveAndRedirect fallback total (money path)
   ------------------------------------------------------------------------------
   THE DEFECT
     The fallback summed Number(p.price) across the cart and ignored quantity entirely.
     An order for three of something was recorded, receipted and credited to a referrer
     at the price of one. It fires whenever orderTotal was never computed.

   WHAT IS AND IS NOT AT STAKE
     The CHARGE is server-authoritative and untouched: createCheckoutSession recomputes
     the amount, _serverTotalOverride carries it back, and every payment call sends
     orderTotal / stkAmount / _serverTotalOverride. This value never reaches a provider.
     It reaches the order record, the printed receipt (grandTotal, payments[].amount) and
     SokoniReferral.recordReferredPurchase — which is why it is a money-path defect even
     though nobody was mischarged.

   THE FIX SHAPE
     One function, _ckLineTotal, used by BOTH the canonical displayed subtotal and the
     fallback. Copying the expression into the fallback would have recreated the second
     pricing authority that caused the drift. Block C proves the extraction changed no
     canonical value; block E proves the two can no longer disagree.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const STATE = require('./auth-policy-state.js');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const HTML = read('checkout.html');

let pass = 0, fail = 0;
const failures = [];
function ok(label, cond, detail) {
  if (cond) { pass++; return true; }
  fail++; failures.push(label + (detail ? '  → ' + detail : ''));
  return false;
}
const eq = (l, a, e) => ok(l, a === e, 'expected ' + JSON.stringify(e) + ', got ' + JSON.stringify(a));
const head = (t) => console.log('\n\x1b[1m' + t + '\x1b[0m');

/* Pull the SHIPPED helper out of the page and run it. Not a reimplementation: the source
   text is extracted verbatim and evaluated, so if the page changes, this changes. */
function extract(name) {
  const at = HTML.indexOf('function ' + name);
  if (at < 0) throw new Error(name + ' not found in checkout.html');
  const open = HTML.indexOf('{', at);
  let d = 0;
  for (let i = open; i < HTML.length; i++) {
    if (HTML[i] === '{') d++;
    else if (HTML[i] === '}') { d--; if (d === 0) return HTML.slice(at, i + 1); }
  }
  throw new Error(name + ' block not closed');
}
const SRC = extract('_ckLineTotal');
const sandbox = { };
vm.createContext(sandbox);
vm.runInContext(SRC + '; this.__f = _ckLineTotal;', sandbox);
const lineTotal = sandbox.__f;

/* The ORIGINAL canonical expression, verbatim from before the extraction. Block C compares
   the extracted helper against it — that is what proves the refactor moved no money. */
function originalCanonical(item) {
  const qty = Math.max(1, Math.round(Number(item.qty) || Number(item.quantity) || 1));
  return Number(item.price || 0) * qty;
}
/* The ORIGINAL fallback, verbatim — the defect, kept so the tests show what changed. */
const originalFallback = (cart) => cart.reduce((s, p) => s + Number(p.price || 0), 0);
/* The fallback as it now is. */
const fixedFallback = (cart) => cart.reduce((s, p) => s + lineTotal(p), 0);

(function run() {

  /* ══ A · quantity arithmetic ═════════════════════════════════════════════ */
  head('A · price × effective quantity');
  {
    eq('A1  qty 1 → unchanged', lineTotal({ price: 250, qty: 1 }), 250);
    eq('A2  qty 3 → multiplied', lineTotal({ price: 250, qty: 3 }), 750);
    eq('A3  qty 12 → multiplied', lineTotal({ price: 99, qty: 12 }), 1188);
    eq('A4  price 0 stays 0 at any qty', lineTotal({ price: 0, qty: 9 }), 0);

    /* The regression itself, stated as a comparison. */
    const three = [{ price: 250, qty: 3 }];
    eq('A5  THE DEFECT: the old fallback charged for one', originalFallback(three), 250);
    eq('A6  THE FIX: the new fallback charges for three', fixedFallback(three), 750);
    ok('A7  ...a 500 shilling under-report on a single line',
       fixedFallback(three) - originalFallback(three) === 500);
  }

  /* ══ B · effective-quantity semantics preserved ══════════════════════════ */
  head('B · missing / invalid quantity resolves exactly as before');
  {
    const cases = [
      ['qty absent',            { price: 100 },                        100],
      ['qty null',              { price: 100, qty: null },             100],
      ['qty undefined',         { price: 100, qty: undefined },        100],
      ['qty 0',                 { price: 100, qty: 0 },                100],
      ['qty negative',          { price: 100, qty: -4 },               100],
      ['qty non-numeric',       { price: 100, qty: 'abc' },            100],
      ['qty "3" (string)',      { price: 100, qty: '3' },              300],
      ['qty 2.4 → rounds to 2', { price: 100, qty: 2.4 },              200],
      ['qty 2.6 → rounds to 3', { price: 100, qty: 2.6 },              300],
      ['quantity used when qty absent', { price: 100, quantity: 5 },   500],
      ['qty wins over quantity', { price: 100, qty: 2, quantity: 9 },  200],
      ['price absent',          { qty: 3 },                            0],
      ['empty object',          { },                                   0],
    ];
    for (const [label, item, expected] of cases) {
      eq('B·  ' + label, lineTotal(item), expected);
    }

    /* A non-numeric price produces NaN — in the fallback AND in the displayed subtotal,
       because the original canonical expression did the same (Number("x")). Block C proves
       the two are identical across the whole matrix, so this is PRESERVED behaviour, not a
       regression introduced here. Turning it into 0 would change what the page displays for
       malformed catalogue data, which is a different decision from fixing arithmetic that
       forgot to use quantity. Recorded, not fixed. */
    ok('B15 a non-numeric price yields NaN, exactly as it did before',
       Number.isNaN(lineTotal({ price: 'x', qty: 3 })) &&
       Number.isNaN(originalCanonical({ price: 'x', qty: 3 })));
  }

  /* ══ C · the extraction moved no money ═══════════════════════════════════ */
  head('C · the extracted helper equals the original canonical expression, exactly');
  {
    const prices = [0, 1, 99, 250, 1999, 100000, -5, 'x', null, undefined, '250'];
    const qtys = [undefined, null, 0, 1, 2, 3, 12, -1, 2.4, 2.6, '3', 'abc', NaN, Infinity];
    let compared = 0, diffs = [];
    for (const price of prices) {
      for (const qty of qtys) {
        for (const quantity of [undefined, 5]) {
          const item = { price };
          if (qty !== undefined) item.qty = qty;
          if (quantity !== undefined) item.quantity = quantity;
          const a = lineTotal(item), b = originalCanonical(item);
          compared++;
          /* NaN === NaN is false; compare their string forms so NaN matches NaN. */
          if (String(a) !== String(b) && diffs.length < 5) {
            diffs.push(JSON.stringify(item) + ' → shipped=' + a + ' original=' + b);
          }
        }
      }
    }
    ok('C1  the comparison actually ran', compared === prices.length * qtys.length * 2,
       String(compared));
    ok('C2  ' + compared + ' item shapes, zero differences from the original canonical math',
       diffs.length === 0, diffs.join(' | '));
  }

  /* ══ D · carts ═══════════════════════════════════════════════════════════ */
  head('D · whole carts');
  {
    const mixed = [
      { price: 250, qty: 3 },      /*  750 */
      { price: 100 },              /*  100 — no qty */
      { price: 40, qty: 2 },       /*   80 */
      { price: 1000, qty: 1 },     /* 1000 */
    ];
    eq('D1  mixed quantities sum correctly', fixedFallback(mixed), 1930);
    eq('D2  the old fallback would have said', originalFallback(mixed), 1390);
    eq('D3  empty cart is 0', fixedFallback([]), 0);
    eq('D4  single qty-1 line matches the old behaviour exactly',
       fixedFallback([{ price: 250, qty: 1 }]), originalFallback([{ price: 250, qty: 1 }]));

    /* No double multiplication: the total must be linear in qty, not quadratic. */
    const one = fixedFallback([{ price: 250, qty: 1 }]);
    const two = fixedFallback([{ price: 250, qty: 2 }]);
    const four = fixedFallback([{ price: 250, qty: 4 }]);
    eq('D5  no double multiplication — qty 2 is exactly 2×', two, one * 2);
    eq('D6  ...and qty 4 is exactly 4×', four, one * 4);
    ok('D7  ...not qty²  (would be ' + (one * 16) + ')', four !== one * 16);

    /* Splitting a line into separate entries must total the same as one line with qty. */
    eq('D8  three lines of one == one line of three',
       fixedFallback([{ price: 250, qty: 1 }, { price: 250, qty: 1 }, { price: 250, qty: 1 }]),
       fixedFallback([{ price: 250, qty: 3 }]));
  }

  /* ══ E · one authority ═══════════════════════════════════════════════════ */
  head('E · the fallback and the displayed subtotal cannot disagree');
  {
    const code = HTML.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

    /* Both totalling sites must call the helper — not re-derive. */
    const calls = (code.match(/_ckLineTotal\(/g) || []).length;
    ok('E1  the helper is called from more than one site', calls >= 2, String(calls));
    ok('E2  the canonical subtotal uses it',
       /subtotal \+= lineTotal;/.test(code) && /const lineTotal = _ckLineTotal\(item\);/.test(code));
    ok('E3  the fallback uses it',
       /currentCart\.reduce\(\(s, p\) => s \+ _ckLineTotal\(p\), 0\)/.test(code));

    /* The defect must be gone, and no second copy of the arithmetic may exist. */
    ok('E4  the qty-blind reduce is gone',
       !/reduce\(\(s,\s*p\)\s*=>\s*s\s*\+\s*Number\(p\.price\s*\|\|\s*0\)\s*\)/.test(code) &&
       !/reduce\(\(s,p\)\s*=>\s*s\s*\+\s*Number\(p\.price\|\|0\)\)/.test(code));
    const inlineQty = (code.match(/Math\.max\(1,\s*Math\.round\(Number\(item[\s\S]{0,40}?qty/g) || []).length;
    eq('E5  the effective-quantity expression exists in exactly ONE place', inlineQty, 1);

    /* Structural equivalence: feed the same cart through both paths. */
    const carts = [
      [{ price: 250, qty: 3 }],
      [{ price: 99, qty: 12 }, { price: 5 }],
      [{ price: 100, quantity: 4 }],
      [],
    ];
    let mismatch = 0;
    for (const cart of carts) {
      let canonical = 0;
      cart.forEach((item) => { canonical += lineTotal(item); });   /* what the page displays */
      if (canonical !== fixedFallback(cart)) mismatch++;
    }
    eq('E6  displayed subtotal and fallback agree on every cart tested', mismatch, 0);
  }

  /* ══ F · the charge is untouched ═════════════════════════════════════════ */
  head('F · the payment path still sends the server-authoritative amount');
  {
    const code = HTML.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    ok('F1  the server total override still exists', /_serverTotalOverride/.test(code));
    ok('F2  STK still sends stkAmount ?? _serverTotalOverride ?? orderTotal',
       /amount:\s*stkAmount \?\? _serverTotalOverride \?\? orderTotal/.test(code));
    ok('F3  no payment call was rewired to the fallback',
       !/amount:\s*[^,\n]*_ckLineTotal/.test(code));
    ok('F4  the fallback value never leaves as an "amount" field directly',
       !/amount:\s*currentCart\.reduce/.test(code));
    ok('F5  createCheckoutSession/preview still price from subtotal',
       /orderAmountKES:\s*subtotal/.test(code));
  }

  /* ══ G · positive controls ═══════════════════════════════════════════════ */
  head('G · positive controls');
  {
    function mutant(from, to) {
      ok('G·  mutation target present: ' + from.slice(0, 34), SRC.indexOf(from) >= 0);
      const s = { };
      vm.createContext(s);
      vm.runInContext(SRC.replace(from, to) + '; this.__f = _ckLineTotal;', s);
      return s.__f;
    }

    /* Drop the multiplication — the original defect, reintroduced. */
    const m1 = mutant('return Number((item && item.price) || 0) * qty;',
                      'return Number((item && item.price) || 0);');
    eq('G1  a mutant that forgets qty reports 250 for three — so A2/A6 really bite',
       m1({ price: 250, qty: 3 }), 250);

    /* Multiply twice — the opposite error, which would OVERCHARGE the record. */
    const m2 = mutant('return Number((item && item.price) || 0) * qty;',
                      'return Number((item && item.price) || 0) * qty * qty;');
    eq('G2  a mutant that multiplies twice reports 2250 — so D5/D6 really bite',
       m2({ price: 250, qty: 3 }), 2250);

    /* Effective-quantity is defended TWICE — `|| 1` catches falsy, and Math.max(1, …)
       floors the rest — so removing either alone changes nothing. That redundancy is worth
       having, and it means the honest mutant is the realistic simplification that drops
       both at once. */
    const m3 = mutant('const qty = Math.max(1, Math.round(Number(item && item.qty) || Number(item && item.quantity) || 1));',
                      'const qty = Number(item && item.qty) || 0;');
    eq('G3  a mutant with no effective-quantity floor zeroes a qty-0 line — so B really bites',
       m3({ price: 100, qty: 0 }), 0);
    eq('G3b ...and loses the quantity fallback entirely',
       m3({ price: 100, quantity: 5 }), 0);
    eq('G4  the shipped helper survives both: qty 0 → one unit',
       lineTotal({ price: 100, qty: 0 }), 100);
    eq('G5  ...and quantity:5 still resolves', lineTotal({ price: 100, quantity: 5 }), 500);
  }

  /* ══ H · blast radius ════════════════════════════════════════════════════ */
  head('H · nothing else moved');
  {
    const cp = require('child_process');
    const changed = cp.execSync('git diff --name-only HEAD', { cwd: ROOT, encoding: 'utf8' })
      .split('\n').map((s) => s.trim()).filter(Boolean);

    /* The two policy files may legitimately carry an armed cutoff at release time, so
       they are excluded here and asserted separately (H5) to be cutoff-only. */
    ok('H1  only checkout.html changed among product files',
       !changed.some((f) => /\.(js|html)$/.test(f) && f !== 'checkout.html' &&
                            !f.startsWith('scripts/') && f !== 'availability-manager.html' &&
                            !STATE.POLICY_FILES.includes(f)),
       changed.join(', '));

    /* The carried items must NOT have been quietly fixed during a release pass. */
    ok('H2  the cart account-switch gap was not touched', !changed.includes('sokoni-cart.js'));
    ok('H3  the wishlist deferrals were not touched', !changed.includes('sokoni-wishlist.js'));
    ok('H4  firestore.rules untouched', !changed.includes('firestore.rules'));
    /* This money-path slice must not alter auth POLICY. It may coexist with an armed
       cutoff, so the durable claim is that any policy change is the cutoff line only. */
    const _cd = STATE.policyDiffIsCutoffOnly(STATE.CLIENT);
    const _sd = STATE.policyDiffIsCutoffOnly(STATE.SERVER);
    ok('H5  any auth-policy change is the cutoff line and nothing else',
       _cd.only && _sd.only, _cd.lines.concat(_sd.lines).join(' | '));
    const _st = STATE.shippedState();
    eq('H6  client and server ship the same cutoff', _st.client, _st.server);

    const plain = cp.execSync('git diff --numstat HEAD -- checkout.html', { cwd: ROOT, encoding: 'utf8' }).trim();
    const ign = cp.execSync('git diff --ignore-cr-at-eol --numstat HEAD -- checkout.html',
                            { cwd: ROOT, encoding: 'utf8' }).trim();
    eq('H7  checkout.html carries no line-ending flip', plain, ign);
  }

  console.log('\n' + '─'.repeat(70));
  if (fail) { console.log('\x1b[31mFAILURES\x1b[0m'); failures.forEach((f) => console.log('  ✗ ' + f)); }
  console.log((fail ? '\x1b[31m' : '\x1b[32m') + 'checkout fallback total: ' + pass + '/' + (pass + fail) + '\x1b[0m');
  process.exit(fail ? 1 : 0);
})();
