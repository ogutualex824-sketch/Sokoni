/* ══════════════════════════════════════════════════════════════════════════════
   The living dashboard — EXECUTED
   ══════════════════════════════════════════════════════════════════════════════
   A premium surface is easy to make dishonest: a big confident number is exactly the
   shape a fabricated metric wants to take. So the visual work is asserted alongside the
   one rule that outranks it —

       NO TILE MAY FABRICATE A BUSINESS METRIC.
       Canonical source, or an em dash. Never 0 standing in for an unknown.

   The hero figure is UNKNOWN today by design: posDailySummary has no rule in the served
   ruleset and posRetailSales is isAdmin() only, so there is no canonical client source
   for the day's takings. The interesting assertions are therefore about what the surface
   does when it does NOT know — including that unknown values must not animate, because a
   moving em dash reads as "loading" and that is a different claim.

   Run: node scripts/test-merchant-dashboard.js
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '\n          ' + d : '')); ok ? pass++ : fail++; };
const head = (t) => console.log('\n' + t);

/* ── A DOM stub good enough to render into and query ──────────────────────── */
function mkEl (tag) {
  const el = {
    tagName: (tag || 'div').toUpperCase(), _html: '', children: [], _listeners: {},
    attrs: {}, style: {},
    set innerHTML (v) { this._html = String(v); },
    get innerHTML () { return this._html; },
    addEventListener (t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); },
    removeEventListener (t, fn) {
      if (!this._listeners[t]) return;
      this._listeners[t] = this._listeners[t].filter((f) => f !== fn);
    },
    setAttribute (k, v) { this.attrs[k] = String(v); },
    getAttribute (k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
    appendChild (c) { this.children.push(c); return c; },
    /* querySelectorAll over the rendered HTML string — enough for the pulse assertions.
       MEMOISED per innerHTML. The first version rebuilt the node objects on every call, so
       whatever the pulse wrote to them was discarded before the assertion could read it:
       a "reduced motion writes nothing" check passed no matter what the code did. Returning
       the SAME objects is what makes the mutation observable. */
    querySelectorAll (sel) {
      const m = /\.sd-num\[data-count\]/.test(sel);
      if (!m) return [];
      if (this._qsaHtml === this._html && this._qsaCache) return this._qsaCache;
      const out = [];
      const re = /<[^>]*class="[^"]*sd-num[^"]*"[^>]*data-count="([^"]*)"[^>]*>/g;
      let x;
      while ((x = re.exec(this._html)) !== null) {
        const tagStr = x[0];
        out.push({
          _count: x[1],
          _money: /data-money="1"/.test(tagStr),
          textContent: '',
          getAttribute (k) { return k === 'data-count' ? this._count : (k === 'data-money' ? (this._money ? '1' : null) : null); },
        });
      }
      this._qsaHtml = this._html; this._qsaCache = out;
      return out;
    },
    fire (type, target) { (this._listeners[type] || []).forEach((f) => f({ target })); },
  };
  return el;
}

global.window = global;
global.requestAnimationFrame = (fn) => { setTimeout(() => fn(performance.now ? performance.now() : Date.now()), 0); return 1; };
global.matchMedia = () => ({ matches: false });

require(path.join(ROOT, 'sokoni-merchant-dashboard.js'));
const D = global.window.SokoniMerchantDashboard;

const SCOPE = { ok: true, shopId: 'SHOP_A', sellerUid: 'seller_1' };
const settle = () => new Promise((r) => setTimeout(r, 25));

function mkCtx (over) {
  const calls = { go: [], q: [] };
  const empty = async (spec) => { calls.q.push(spec.collection); return []; };
  return Object.assign({
    calls, scope: SCOPE, shopName: 'Mama Njeri Stores', userName: 'Alex Ogutu',
    go: (id) => calls.go.push(id),
    db: { queryOrders: empty, queryProducts: empty, queryStats: empty, queryConversations: empty,
          queryCommission: empty, queryPayouts: empty,
          readBilling: async () => null, readWallet: async () => null },
  }, over || {});
}

(async () => {
  head('0 - controls');
  ck('CONTROL: the module loaded', !!D && typeof D.mount === 'function');
  const SRC = fs.readFileSync(path.join(ROOT, 'sokoni-merchant-dashboard.js'), 'utf8');
  ck('CONTROL: it is a real implementation', SRC.length > 8000);

  /* ── 1. THE RULE ────────────────────────────────────────────────────────── */
  head('1 - no tile may fabricate a business metric');
  ck('an unknown renders as an em dash', D._renderValue(D._unknown('x')) === '—');
  ck('and NEVER as 0', D._renderValue(D._unknown('x')) !== '0',
     'an unknown shown as 0 is a claim about the shop');
  ck('a canonical 0 is preserved as 0', D._renderValue(D._known(0)) === '0',
     'a real zero is a fact and must not become a dash');
  ck('money formats an unknown as a dash', D._money(null) === '—' && D._money(undefined) === '—');
  ck('money does NOT turn NaN into a figure', D._money(NaN) === '—');
  ck('money renders a real zero', D._money(0) === 'KES 0');

  head('2 - the hero is unknown today, and says why');
  let ctx = mkCtx(); let host = mkEl('div');
  let inst = D.mount(host, ctx); await settle();
  ck("today's takings render as an em dash", /sd-hero-v[^>]*>\s*—/.test(host.innerHTML),
     'posDailySummary has no rule; posRetailSales is admin-only');
  ck('the hero wears the quieter unknown treatment', /sd-hero-unknown/.test(host.innerHTML),
     'an unknown must not wear the same confident skin as a real figure');
  ck('it states the reason rather than hiding it', /Till sales are not readable yet/.test(host.innerHTML));
  ck('no trend percentage is invented', !/% from yesterday/.test(host.innerHTML),
     'a trend needs yesterday, which is equally unreadable');
  ck('the hero value carries NO data-count, so it cannot animate',
     !/sd-hero-v[^>]*data-count/.test(host.innerHTML));
  inst.destroy();

  /* ── 3. PARTIAL IS LABELLED, ALWAYS ─────────────────────────────────────── */
  head('3 - a partial figure is never presented as the whole truth');
  const now = Date.now();
  ctx = mkCtx({ db: {
    queryOrders: async () => ([
      { createdAt: now, buyerUid: 'b1' }, { createdAt: now, buyerUid: 'b2' },
      { createdAt: now, buyerUid: 'b1' },
      { createdAt: now - 3 * 86400000, buyerUid: 'b9' },   /* not today */
    ]),
    queryProducts: async () => [], queryStats: async () => [], queryConversations: async () => [],
  } });
  host = mkEl('div'); inst = D.mount(host, ctx); await settle();
  ck('today\'s online orders are counted', />3<\/b> orders/.test(host.innerHTML.replace(/\s+/g, ' ')) ||
     /data-count="3"/.test(host.innerHTML), 'older orders excluded');
  ck('and the count is LABELLED partial', /sd-part">partial/.test(host.innerHTML),
     'till sales are absent from `orders` — an unlabelled count reads as the whole day');
  ck('the reason is available on the chip', /till sales not included/i.test(host.innerHTML));
  ck('distinct customers are derived, not invented', /data-count="2"/.test(host.innerHTML),
     'b1 appears twice and counts once');
  inst.destroy();

  /* ── 4. THE NARRATIVE ───────────────────────────────────────────────────── */
  head('4 - "Your shop today" speaks only from facts');
  ck('a fact becomes a sentence', D._insights({
    bestSeller: { name: 'Nike Air Max', sold: 9 }, lowStock: null, waiting: null,
    orders: D._unknown('x'),
  }).some((i) => /best-selling product is Nike Air Max/.test(i.text)));
  ck('an absent source produces NO line', D._insights({
    bestSeller: null, lowStock: null, waiting: null, orders: D._unknown('x'),
  }).length === 0, 'the section shrinks rather than softening a guess');
  ck('zero low-stock products produces no line', D._insights({
    bestSeller: null, lowStock: { count: 0, names: [] }, waiting: null, orders: D._unknown('x'),
  }).length === 0);
  const many = D._insights({
    bestSeller: null, lowStock: { count: 3, names: [] }, waiting: 2, orders: D._known(4),
  });
  ck('plural and singular are both correct',
     many.some((i) => i.text === '3 products are running low') &&
     many.some((i) => i.text === '2 customers are waiting for replies'));
  const one = D._insights({ bestSeller: null, lowStock: { count: 1, names: [] }, waiting: 1, orders: D._unknown('x') });
  ck('one is not "1 products"', one.some((i) => i.text === '1 product is running low') &&
     one.some((i) => i.text === '1 customer is waiting for a reply'));

  head('5 - low stock never invents a shelf count');
  ctx = mkCtx({ db: {
    queryOrders: async () => [], queryStats: async () => [], queryConversations: async () => [],
    queryProducts: async () => ([
      { name: 'A', stock: 2 },                 /* low        */
      { name: 'B', stock: 40 },                /* fine       */
      { name: 'C' },                           /* UNKNOWN    */
      { name: 'D', stock: null },              /* UNKNOWN    */
      { name: 'E', stock: 0 },                 /* low, real  */
      { name: 'F', stock: 9, lowStockThreshold: 10 },  /* low by its own threshold */
    ]),
  } });
  host = mkEl('div'); inst = D.mount(host, ctx); await settle();
  ck('absent stock is NOT counted as low', /3 products are running low/.test(host.innerHTML),
     'A, E and F are low; C and D are unknown, not low — Number(null) is 0 and that is the trap');
  inst.destroy();

  /* ── 6. EMPTY STATE ─────────────────────────────────────────────────────── */
  head('6 - an empty shop is told the truth kindly');
  ctx = mkCtx(); host = mkEl('div'); inst = D.mount(host, ctx); await settle();
  ck('the narrative says nothing to report', /Nothing to report yet/.test(host.innerHTML));
  ck('it does not fake encouragement with invented numbers',
     !/\b0 orders\b|\b0 products\b/.test(host.innerHTML));
  inst.destroy();

  /* ── 7. THE PULSE ───────────────────────────────────────────────────────── */
  head('7 - facts move; unknowns do not');
  ctx = mkCtx({ db: {
    queryOrders: async () => ([{ createdAt: Date.now(), buyerUid: 'b1' }]),
    queryProducts: async () => [], queryStats: async () => [], queryConversations: async () => [],
  } });
  host = mkEl('div'); inst = D.mount(host, ctx); await settle();
  const nums = host.querySelectorAll('.sd-num[data-count]');
  ck('CONTROL: animatable nodes were found', nums.length > 0, nums.length + ' node(s)');
  const animatable = nums.filter((n) => n.getAttribute('data-count') !== '');
  const inert = nums.filter((n) => n.getAttribute('data-count') === '');
  ck('a known figure carries a count target', animatable.length > 0);
  ck('every UNKNOWN carries an empty target, so the pulse skips it',
     inert.every((n) => n.getAttribute('data-count') === ''),
     'a moving em dash reads as "loading", which is a different claim');
  const PSRC = SRC.slice(SRC.indexOf('function pulse'), SRC.indexOf('function mount'));
  ck('the pulse returns early on an empty target',
     /data-count'\) === ''[\s\S]{0,40}return/.test(PSRC));
  ck('and it honours prefers-reduced-motion', /prefers-reduced-motion/.test(PSRC));
  inst.destroy();

  /* ── 8. NAVIGATION THROUGH THE CONTRACT ─────────────────────────────────── */
  head('8 - a tile can never become an undeclared exit');
  ctx = mkCtx(); host = mkEl('div'); inst = D.mount(host, ctx); await settle();
  host.fire('click', { closest: (s) => (s === '[data-go]' ? { getAttribute: () => 'orders' } : null) });
  ck('a tap routes through ctx.go', ctx.calls.go.length === 1 && ctx.calls.go[0] === 'orders');
  const clean = SRC.replace(/\/\*[\s\S]*?\*\//g, '');
  ck('the module contains NO literal URL navigation',
     !/location\.href|location\.assign|location\.replace/.test(clean),
     'the shell exit contract exists because one shipped here before');
  ck('every quick action names a route id, not a path',
     D.ACTIONS.every((a) => /^[a-z][a-z-]*$/.test(a.id)),
     D.ACTIONS.map((a) => a.id).join(','));
  inst.destroy();

  head('9 - the surface is what was asked for');
  ctx = mkCtx(); host = mkEl('div'); inst = D.mount(host, ctx); await settle();
  ['👋', '🛍️', '⚡', '🧠'].forEach((e) => {
    ck('carries ' + e, host.innerHTML.indexOf(e) > -1);
  });
  ck('greeting is time-aware', ['Good morning', 'Good afternoon', 'Good evening']
     .indexOf(D._greeting(new Date(2020, 0, 1, 9))) === 0);
  ck('evening after 17:00', D._greeting(new Date(2020, 0, 1, 19)) === 'Good evening');
  ck('the first name is used, never the full string',
     /Good [a-z]+, Alex</.test(host.innerHTML), 'Alex, not "Alex Ogutu"');
  ck('all six quick actions render', (host.innerHTML.match(/class="sd-act /g) || []).length === 6);
  ck('the shop name is shown', /Mama Njeri Stores/.test(host.innerHTML));
  inst.destroy();

  head('10 - it degrades rather than breaking');
  ctx = mkCtx({ db: {
    queryOrders: async () => { throw new Error('denied'); },
    queryProducts: async () => { throw new Error('denied'); },
    queryStats: async () => { throw new Error('denied'); },
    queryConversations: async () => { throw new Error('denied'); },
  } });
  host = mkEl('div'); inst = D.mount(host, ctx); await settle();
  ck('every read failing still renders a surface', host.innerHTML.length > 500);
  ck('and every figure is an em dash, not a zero',
     !/>0<\/b>/.test(host.innerHTML), 'a denied read is unknown, not zero');
  inst.destroy();

  ctx = mkCtx({ scope: { ok: false } });
  host = mkEl('div'); inst = D.mount(host, ctx); await settle();
  ck('an unresolved shop scope renders honestly, not blank', /sd-hero/.test(host.innerHTML));
  ck('and invents nothing', !/KES [0-9]/.test(host.innerHTML));
  inst.destroy();

  head('10b - the gaps three sabotages found');
  /* Each of these existed because a branch was never exercised: the trend only renders when
     takings is KNOWN (and today it never is), the timestamp guard only matters for an
     unparseable value, and prefers-reduced-motion was hard-false in the stub. A sabotage
     that changes nothing is not proof the code is right — it is proof the test never looked. */

  /* TREND — the sabotage `out.trend = known(18.6)` passed because the trend only renders
     when takings is ALSO known, and today it never is. So the invented value was real and
     invisible. Assert the guard itself, and that the source stays unknown. */
  {
    const SRCX = fs.readFileSync(path.join(ROOT, 'sokoni-merchant-dashboard.js'), 'utf8');
    ck('the trend renders ONLY when takings AND trend are both known',
       SRCX.indexOf("heroKnown && f.trend && f.trend.state !== 'unknown'") > -1,
       'guarding on heroKnown alone would let an invented trend through');
    ck('and loadFacts marks the trend unknown, with a reason',
       SRCX.indexOf("out.trend   = unknown('Needs yesterday") > -1,
       'a trend needs yesterday, which is as unreadable as today');
  }

  /* TIMESTAMP — an unparseable createdAt must be EXCLUDED, never counted as today. */
  ctx = mkCtx({ db: {
    queryOrders: async () => ([
      { createdAt: Date.now(), buyerUid: 'b1' },
      { createdAt: 'not-a-date', buyerUid: 'b2' },
      { createdAt: {}, buyerUid: 'b3' },
      { buyerUid: 'b4' },
    ]),
    queryProducts: async () => [], queryStats: async () => [], queryConversations: async () => [],
  } });
  host = mkEl('div'); inst = D.mount(host, ctx); await settle();
  ck('only the parseable order counts as today', /data-count="1"/.test(host.innerHTML),
     'three unparseable timestamps must be excluded, not assumed to be today');
  inst.destroy();

  /* REDUCED MOTION — with the preference set, nothing animates. */
  {
    const realMM = global.matchMedia;
    global.matchMedia = () => ({ matches: true });
    const c2 = mkCtx({ db: {
      queryOrders: async () => ([{ createdAt: Date.now(), buyerUid: 'b1' }]),
      queryProducts: async () => [], queryStats: async () => [], queryConversations: async () => [],
    } });
    const h2 = mkEl('div');
    const i2 = D.mount(h2, c2); await settle();
    const animated = h2.querySelectorAll('.sd-num[data-count]')
      .filter((n) => n.getAttribute('data-count') !== '');
    ck('CONTROL: there IS something animatable', animated.length > 0);
    ck('with prefers-reduced-motion, the pulse writes nothing',
       animated.every((n) => n.textContent === ''),
       'delight a merchant cannot switch off is noise');
    i2.destroy();
    global.matchMedia = realMM;
  }

  head('12 - 💰 money: the merchant must see what SOKONI earned and what they earned');
  const MONEY = (over) => mkCtx({ db: Object.assign({
    queryOrders: async () => [], queryProducts: async () => [], queryStats: async () => [],
    queryConversations: async () => [], queryCommission: async () => [], queryPayouts: async () => [],
    readBilling: async () => null, readWallet: async () => null,
  }, over || {}) });

  /* The real shape: sellerBilling is the aggregate the SERVER increments inside the same
     transaction as each ledger entry, so its totals cannot drift from the ledger. */
  ctx = MONEY({ readBilling: async () => ({ grossSalesKES: 48240, totalCommissionKES: 1842.5 }) });
  host = mkEl('div'); inst = D.mount(host, ctx); await settle();
  ck('sales come from the billing aggregate', /KES 48,240/.test(host.innerHTML));
  ck('commission is shown as its own headline figure', /KES 1,843|KES 1,842/.test(host.innerHTML));
  ck('earnings are DERIVED from both, not guessed', /KES 46,398|KES 46,397/.test(host.innerHTML),
     '48,240 − 1,842.50 = 46,397.50');
  ck('the deduction is signed as a deduction', /−KES 1,84/.test(host.innerHTML),
     'a merchant must never misread the cut for the net');
  /* Scoped to the flow LIST. Searching the whole card matched the headline
     "💰 SOKONI commission" above the list, so the ordering check was reading the wrong
     occurrence and would have passed on any arrangement. */
  {
    const fl = host.innerHTML.slice(host.innerHTML.indexOf('sd-flow"'),
                                    host.innerHTML.indexOf('sd-comm-a'));
    ck('CONTROL: the flow list was located', fl.length > 200, fl.length + ' chars');
    ck('the flow reads pays → commission → receives',
       fl.indexOf('>Sales<') < fl.indexOf('>SOKONI commission<') &&
       fl.indexOf('>SOKONI commission<') < fl.indexOf('>Your earnings<'),
       'the order IS the explanation');
  }
  ck('"View commission" routes by contract id', /data-go="revenue"/.test(host.innerHTML));
  inst.destroy();

  head('13 - the commission RATE is read, never assumed');
  ck('no rate at all → it says so, and names no number', D._rateLine(null) === 'Commission rate — not recorded yet');
  ck('a single recorded rate is stated', D._rateLine({ pct: 5, mixed: false, fixed: null }) === 'Commission rate 5%');
  ck('a fixed fee rides along when recorded',
     D._rateLine({ pct: 5, mixed: false, fixed: 20 }) === 'Commission rate 5% + KES 20 per sale');
  ck('DISAGREEING entries are reported as varying, not averaged',
     D._rateLine({ pct: null, mixed: true, fixed: null }) === 'Commission rate varies across recent sales',
     'picking one would state a commercial fact this file cannot know');
  const CSRC = fs.readFileSync(path.join(ROOT, 'sokoni-merchant-dashboard.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  ck('no commission percentage is hardcoded anywhere',
     CSRC.indexOf('3%') < 0 && CSRC.indexOf('5%') < 0 && CSRC.indexOf('commissionPct:') < 0,
     'the rate is a server authority — Track A set production truth, not this file');

  ctx = MONEY({
    readBilling: async () => ({ grossSalesKES: 1000, totalCommissionKES: 50 }),
    queryCommission: async () => ([{ commissionPct: 5 }, { commissionPct: 5 }, { commissionPct: 5 }]),
  });
  host = mkEl('div'); inst = D.mount(host, ctx); await settle();
  ck('the rate rendered is the one the LEDGER recorded', /Commission rate 5%/.test(host.innerHTML));
  inst.destroy();

  ctx = MONEY({
    readBilling: async () => ({ grossSalesKES: 1000, totalCommissionKES: 50 }),
    queryCommission: async () => ([{ commissionPct: 5 }, { commissionPct: 3 }]),
  });
  host = mkEl('div'); inst = D.mount(host, ctx); await settle();
  ck('mixed ledger rates render as "varies"', /varies across recent sales/.test(host.innerHTML));
  inst.destroy();

  /* The FACT, not only the rendering. Setting pct while mixed stayed true produced
     byte-identical output, so asserting the rendered line could never catch it — the
     sabotage passed cleanly. rateLine() checks mixed FIRST, which masks the value. */
  {
    const mixedFacts = await D._loadFacts(MONEY({
      queryCommission: async () => ([{ commissionPct: 5 }, { commissionPct: 3 }]),
    }));
    ck('with disagreeing entries, NO single rate is chosen',
       !!mixedFacts.rate && mixedFacts.rate.mixed === true && mixedFacts.rate.pct === null,
       'pct=' + (mixedFacts.rate && mixedFacts.rate.pct) +
       ' — choosing one averages away a real commercial difference');
    const agreeFacts = await D._loadFacts(MONEY({
      queryCommission: async () => ([{ commissionPct: 5 }, { commissionPct: 5 }]),
    }));
    ck('CONTROL: agreeing entries DO yield a single rate',
       !!agreeFacts.rate && agreeFacts.rate.mixed === false && agreeFacts.rate.pct === 5,
       'without this control, the check above would pass on a rate that is always null');
  }

  head('14 - money degrades honestly');
  ctx = MONEY();   /* no billing document yet */
  host = mkEl('div'); inst = D.mount(host, ctx); await settle();
  /* Scoped to the COMMISSION CARD. Checking the whole surface caught the pending-payout
     tile, which legitimately renders KES 0: the query succeeded and found no pending
     requests, so zero is a canonical fact there. Sales/commission/earnings are the ones
     that must stay dashes when nothing has been billed. */
  {
    const card = host.innerHTML.slice(host.innerHTML.indexOf('sd-comm"'),
                                      host.innerHTML.indexOf('sd-money2'));
    ck('CONTROL: the commission card was located', card.length > 200);
    ck('no billing document is NOT zero earnings',
       card.indexOf('KES 0') < 0, 'nothing billed yet is not "you earned nothing"');
  }
  ck('the money figures render as em dashes', (host.innerHTML.match(/—/g) || []).length >= 3);
  inst.destroy();

  ctx = MONEY({ readBilling: async () => ({ grossSalesKES: 5000 }) });   /* commission absent */
  host = mkEl('div'); inst = D.mount(host, ctx); await settle();
  {
    /* Read the earnings ROW directly. The previous check used a windowed lookahead whose
       escapes had been mangled to [sS] — it matched literal s/S characters, so it could
       not fail however wrong the value was. A scoped substring says the same thing and
       cannot be corrupted the same way. */
    const h = host.innerHTML;
    const row = h.slice(h.indexOf('sd-flow-net'), h.indexOf('sd-comm-a'));
    ck('CONTROL: the earnings row was located', row.length > 60, row.length + ' chars');
    ck('sales are known', h.indexOf('KES 5,000') > -1);
    ck('but earnings stay UNKNOWN when commission is missing',
       row.indexOf('—') > -1 && row.indexOf('KES') < 0,
       'deriving from one known and one unknown is a confident number built on a guess');
  }
  inst.destroy();

  ctx = MONEY({ readWallet: async () => ({ balance: 12500 }),
                queryPayouts: async () => ([{ status: 'pending', amount: 3000 },
                                            { status: 'paid', amount: 9999 }]) });
  host = mkEl('div'); inst = D.mount(host, ctx); await settle();
  ck('available balance comes from the wallet', /KES 12,500/.test(host.innerHTML));
  ck('pending payout counts only pending states', /KES 3,000/.test(host.innerHTML),
     'a paid payout is not pending');
  inst.destroy();

  head('11 - shell wiring');
  const MV2 = fs.readFileSync(path.join(ROOT, 'merchant-v2.html'), 'utf8');
  ck('the module and stylesheet are loaded', /sokoni-merchant-dashboard\.js/.test(MV2)
     && /sokoni-merchant-dashboard\.css/.test(MV2));
  ck('renderDashboard prefers the module', /root_hasDashboardModule\(\)\) return mountDashboardModule/.test(MV2));
  ck('the legacy renderer is kept as a fallback', /renderDashboardLegacy/.test(MV2),
     'a dashboard that renders nothing is worse than a plain one');
  ck('the shell passes go() and not a URL', /go: function \(id\) \{ go\(id\); \}/.test(MV2));

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\n  aborted: ' + (e && e.stack)); process.exit(1); });
