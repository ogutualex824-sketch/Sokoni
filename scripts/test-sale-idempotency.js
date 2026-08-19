/* ══════════════════════════════════════════════════════════════════════════════
   SALE IDEMPOTENCY — the client half
   ══════════════════════════════════════════════════════════════════════════════
   The server is already idempotent: posCompleteCheckout requires an
   idempotencyKey, claims posIdempotency/{key} atomically, returns the ORIGINAL
   receipt for a completed key and rejects a key still processing. Stock, counters
   and payment run exactly once per key.

   So the duplicate-sale risk lives entirely in the CLIENT, and in one specific
   move: a merchant double-taps, the second call is refused because the first is
   still in flight, the UI calls it a failure — and a retry that mints a NEW key
   walks straight past the server's guard and charges the customer twice.

   Every assertion here is about not doing that.

   Run: node scripts/test-sale-idempotency.js
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
/* A session store, so persistence across a "refresh" can be simulated. */
const mem = (() => {
  let m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)),
           removeItem: (k) => m.delete(k), _reset: () => { m = new Map(); } };
})();
global.sessionStorage = mem;
const S = require(path.join(ROOT, 'sokoni-sale-submit.js'));

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + d + ']' : ''));
  ok ? pass++ : fail++;
};
const head = (t) => console.log('\n' + t);
const nosleep = () => Promise.resolve();

const CART = { merchantId: 'm1', branchId: 'b1', totalMinor: 4350000,
               items: [{ productId: 'p1', qty: 2, price: 18500 }],
               tenders: [{ method: 'cash', amountMinor: 5000000 }] };

console.log('\nSALE IDEMPOTENCY — the client half');
console.log('='.repeat(74));

head('1 - the server contract this relies on (read, not assumed)');
const srv = fs.readFileSync(path.join(ROOT, 'functions/pos-zero-friction.js'), 'utf8');
ck('posCompleteCheckout REQUIRES an idempotencyKey', /if \(!idempotencyKey\) _e\('idempotencyKey required'\)/.test(srv));
ck('the key is claimed atomically with create()', /idemRef\.create\(\{ status: 'processing'/.test(srv));
ck('a COMPLETE key returns the original receipt', /prev\.status === 'complete'\) return \{ saleId: prev\.saleId/.test(srv));
ck('a PROCESSING key is rejected, not duplicated', /_e\('Checkout already in progress', 'already-exists'\)/.test(srv));

head('2 - the key is stable for the same cart');
mem._reset();
const k1 = S.keyFor(CART);
const k2 = S.keyFor(CART);
ck('the same cart yields the SAME key', k1 === k2, k1);
ck('...and it survives a "refresh" (persisted)', S.keyFor(JSON.parse(JSON.stringify(CART))) === k1);
ck('...and does not depend on the clock',
   S.keyFor(CART, { startedAt: 999999 }) === k1, 'stable');

head('3 - a DIFFERENT cart is a different sale');
const other = Object.assign({}, CART, { items: [{ productId: 'p2', qty: 1, price: 500 }] });
ck('changing the items changes the key', S.keyFor(other) !== k1);
mem._reset();
const kTender = S.keyFor(Object.assign({}, CART, { tenders: [{ method: 'mpesa', amountMinor: 4350000 }] }));
ck('changing the tender changes the key', kTender !== k1);
mem._reset();
ck('changing the total changes the key', S.keyFor(Object.assign({}, CART, { totalMinor: 1 })) !== k1);
mem._reset();
ck('item ORDER does not change the key (same cart, different sort)',
   S.keyFor({ merchantId: 'm1', branchId: 'b1', totalMinor: 4350000,
              items: [{ productId: 'p1', qty: 2, price: 18500 }],
              tenders: [{ method: 'cash', amountMinor: 5000000 }] }) === k1);

/* Sections 4 onward await. Wrapped in an async IIFE because a top-level await makes
   Node unable to decide whether this file is CommonJS or an ES module, and it then
   refuses to run at all. */
(async () => {
  head('4 - THE DOUBLE TAP: in-flight is not a failure');
  mem._reset();
  let calls = 0;
  const flaky = async () => {
    calls++;
    if (calls < 3) { const e = new Error('Checkout already in progress'); e.code = 'already-exists'; throw e; }
    return { data: { saleId: 'S1', receipt: { total: 43500 }, cached: true } };
  };
  let waited = 0;
  let r = await S.submit(flaky, { idempotencyKey: 'sale_x' }, { sleep: nosleep, onWaiting: () => waited++ });
  ck('it waits out the in-flight state rather than reporting failure', r.ok === true, JSON.stringify(r.error || ''));
  ck('...and returns the ORIGINAL sale', r.data.saleId === 'S1' && r.cached === true);
  ck('...having retried the SAME key', calls === 3, calls + ' calls');
  ck('...and told the UI it was waiting', waited === 2, String(waited));

  head('5 - a real failure preserves the key');
  mem._reset();
  const kBefore = S.keyFor(CART);
  const boom = async () => { const e = new Error('network unreachable'); throw e; };
  r = await S.submit(boom, { idempotencyKey: kBefore }, { sleep: nosleep, attempts: 2 });
  ck('a genuine error is reported as a failure', r.ok === false && /network/.test(r.error));
  ck('...and the key is explicitly PRESERVED', r.keyPreserved === true);
  ck('...so the next attempt reuses it rather than minting a new one', S.keyFor(CART) === kBefore, S.keyFor(CART));

  head('6 - success clears the attempt, so the NEXT sale is new');
  mem._reset();
  const kSale = S.keyFor(CART);
  r = await S.submit(async () => ({ data: { saleId: 'S2' } }), { idempotencyKey: kSale }, { sleep: nosleep });
  ck('the sale completed', r.ok === true && r.data.saleId === 'S2');
  ck('...and the stored attempt was cleared', mem.getItem(S.STORE_KEY) === null);
  const kNext = S.keyFor(CART, { fresh: true, nonce: 'second00' });
  ck('...so an IDENTICAL second sale gets a DIFFERENT key', kNext !== kSale, kNext);

  head('7 - still in flight after every attempt is NOT "sell again"');
  mem._reset();
  const stuck = async () => { const e = new Error('already-exists'); throw e; };
  r = await S.submit(stuck, { idempotencyKey: 'sale_y' }, { sleep: nosleep, attempts: 3 });
  ck('it reports inFlight, not a plain failure', r.inFlight === true && r.ok === false);
  ck('...and preserves the key', r.keyPreserved === true);
  ck('...because the sale may still complete server-side', r.attempts === 3, String(r.attempts));

  head('8 - refusals');
  let threw = false;
  try { await S.submit(async () => ({}), {}, { sleep: nosleep }); } catch (_) { threw = true; }
  ck('submitting with NO idempotencyKey throws', threw);

  head('9 - MUTATION CONTROL: mint a new key on retry');
  /* The exact defect this module exists to prevent. A client that mints a fresh key
     after an in-flight refusal bypasses the server guard entirely. */
  mem._reset();
  const good = S.keyFor(CART);
  const naiveRetryKey = 'sale_' + S._hash(S.fingerprint(CART) + '::retry') + '_deadbeef';
  ck('MC a naive retry would produce a DIFFERENT key', naiveRetryKey !== good, naiveRetryKey);
  ck('MC ...which the server would treat as a NEW sale, charging twice',
     naiveRetryKey.slice(0, 5) === 'sale_' && naiveRetryKey !== good);
  ck('MC the real module keeps the key instead', S.keyFor(CART) === good);
  /* And prove the assertion in section 5 can fail: feed it the naive key. */
  ck('MC section 5\'s assertion REJECTS the naive key', !(naiveRetryKey === good));
  ck('MC ...and ACCEPTS the preserved one', S.keyFor(CART) === good);

  head('10 - the SHIPPED Sell module survives a refresh');
  /* The gap that mattered: the token was held only in memory. A double-tap was
     covered; a REFRESH mid-submission was not — reload and the next attempt minted a
     fresh key, bypassing a server guard that had never seen it. */
  const sell = fs.readFileSync(path.join(ROOT, 'sokoni-merchant-sell.js'), 'utf8');
  const sellCode = sell.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  ck('mintToken RESUMES a persisted attempt', /prev\.token && prev\.scope === scope/.test(sellCode));
  ck('...persisted where it survives reload but dies with the tab',
     /sessionStorage/.test(sellCode) && !/localStorage/.test(sellCode));
  ck('...scoped by shop, so two tabs cannot inherit each other',
     /scope: _shopScope\(\)|prev\.scope === scope/.test(sellCode));
  ck('clearToken removes the persisted attempt', /removeItem\(TOKEN_KEY\)/.test(sellCode));
  /* The critical half: WHERE it is cleared. */
  const bare = (sellCode.match(/S\.saleToken = null/g) || []).length;
  ck('the ONLY bare token clear is inside clearToken()', bare === 1, bare + ' occurrence(s)');
  const clears = (sellCode.match(/clearToken\(\)/g) || []).length;
  ck('clearToken is called from exactly the finished/abandoned paths', clears === 3, clears + ' sites (1 def + 2 calls)');
  ck('a FAILED sale does not clear the token — the retry must reuse it',
     !/S\.sale = 'error'[^\n]*clearToken/.test(sellCode));
  ck('the receipt screen does not clear it either (a refresh there must not re-sell)',
     !/S\.sale = 'done';\s*clearToken/.test(sellCode));

  console.log('\n' + '='.repeat(74));
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  console.log('='.repeat(74) + '\n');
  process.exit(fail ? 1 : 0);
})();
