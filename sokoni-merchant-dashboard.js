/* ═══════════════════════════════════════════════════════════════════════════════
   SokoniMerchantDashboard — the living business dashboard
   ═══════════════════════════════════════════════════════════════════════════════
   A surface a merchant WANTS to open. Merchant v2 stays the serious operational
   workspace behind it; this is the front door, and it talks to the merchant rather than
   printing database fields at them.

   ── THE RULE THAT SHAPES EVERY TILE ─────────────────────────────────────────────
   NO TILE MAY FABRICATE A BUSINESS METRIC. Revenue, orders, customers, deliveries and
   every percentage come from a canonical source or they render as an em dash. Not zero.
   An unknown shown as 0 is a claim about the shop — "you sold nothing today" — and it is
   the one lie this file must never tell. A real canonical 0 is fine; an unknown rendered
   as 0 is a defect.

   WHICH SOURCES ACTUALLY EXIST TODAY, measured against the served ruleset:

     productStats            public read              -> best seller           ✅
     products (shop-scoped)  merchant read            -> low stock             ✅
     orders                  resource.sellerUid == uid-> ONLINE orders         ⚠️ partial
     conversations           participant read         -> waiting replies       ✅
     posDailySummary         NO RULE AT ALL -> denied -> today's takings       ❌
     posRetailSales          isAdmin() only           -> till sales            ❌
     sellerStats             isAdmin() only           -> activity trend        ❌

   So the hero figure is UNKNOWN today, and it says so. `orders` is the subtle one: it is
   readable but INCOMPLETE, because POS till sales live in posRetailSales and never reach
   it (docs/findings/POS_RETAIL_SALES_OWNERSHIP.md). A confidently wrong count is worse
   than a missing one — a merchant cannot tell a partial total from a complete one — so a
   partial figure is LABELLED partial, every time, and never presented as the day's truth.

   ── THE PULSE, AND WHY UNKNOWNS DO NOT ANIMATE ──────────────────────────────────
   Known numbers count up when the dashboard opens: the day's activity flowing into view.
   Unknown ones stay still. That is deliberate. An animated em dash reads as "loading,
   nearly there"; a still one reads as "we do not know this", which is the truth. Motion
   is reserved for facts.

   Every animation is also gated on prefers-reduced-motion — the pulse is delight, and
   delight that a merchant cannot switch off is just noise.

   ── NAVIGATION ─────────────────────────────────────────────────────────────────
   Quick actions never navigate by URL. They call ctx.go(routeId), which resolves through
   the merchant route contract, so a tile cannot become an undeclared exit. That contract
   already caught one literal `location.href` in this codebase.

   Contract: mount(host, ctx) -> { refresh, destroy }
     ctx.scope        resolved shop scope { ok, shopId, sellerUid }
     ctx.db           read adapter: queryProducts / queryOrders-shaped _q specs
     ctx.go           route by contract id
     ctx.userName     display name, or null
     ctx.shopName     shop name, or null
   ═══════════════════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  var UNKNOWN = '—';

  /* ── Formatting ─────────────────────────────────────────────────────────── */
  function esc (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  /* KES, grouped, no decimals — shillings are what a merchant counts. */
  function money (n) {
    if (n === null || n === undefined || !isFinite(Number(n))) return UNKNOWN;
    return 'KES ' + Number(n).toLocaleString('en-KE', { maximumFractionDigits: 0 });
  }
  /* Every timestamp shape this codebase actually produces, and NO guessing beyond them.
     A Firestore Timestamp has toMillis(); the callables return epoch numbers; some older
     writers stored ISO strings. `Date.parse(1756226400000)` is NaN — coercing a number to
     a string first — which silently dropped every numeric timestamp until a test caught
     it. Returns null when the shape is unrecognised, so the caller can EXCLUDE rather
     than assume. */
  function _millis (v) {
    if (v === null || v === undefined) return null;
    if (typeof v.toMillis === 'function') { var m = v.toMillis(); return isFinite(m) ? m : null; }
    if (typeof v === 'number') return isFinite(v) ? v : null;
    if (v instanceof Date) { var d = v.getTime(); return isFinite(d) ? d : null; }
    if (typeof v.seconds === 'number') return v.seconds * 1000;   /* raw Timestamp shape */
    if (typeof v === 'string') { var p = Date.parse(v); return isFinite(p) ? p : null; }
    return null;
  }

  function greeting (d) {
    var h = (d || new Date()).getHours();
    if (h < 12) return 'Good morning';
    if (h < 17) return 'Good afternoon';
    return 'Good evening';
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     THE HONEST VALUE
     ───────────────────────────────────────────────────────────────────────────
     One place decides how a figure is presented, so no tile can invent its own answer.
       known     a canonical number  -> render it, animate it
       partial   real but incomplete -> render it, LABEL it, animate it
       unknown   no canonical source -> em dash, no animation, say why
     ═══════════════════════════════════════════════════════════════════════════ */
  function known (value, opts)   { return { state: 'known',   value: value, note: (opts || {}).note || null }; }
  function partial (value, why)  { return { state: 'partial', value: value, note: why }; }
  function unknown (why)         { return { state: 'unknown', value: null,  note: why }; }

  function renderValue (v, fmt) {
    if (!v || v.state === 'unknown') return UNKNOWN;
    var f = fmt || function (x) { return String(x); };
    return f(v.value);
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     DATA — every read is shop-scoped and every failure degrades to unknown
     ═══════════════════════════════════════════════════════════════════════════ */
  async function loadFacts (ctx) {
    var scope = ctx.scope || {};
    var out = {
      takings:   unknown('Till sales are not readable yet'),
      trend:     unknown('Needs yesterday’s takings'),
      orders:    unknown('Orders are not available'),
      customers: unknown('No customer aggregate yet'),
      deliveries: unknown('Delivery totals are not available'),
      bestSeller: null, lowStock: null, waiting: null,
    };
    if (!scope.ok) return out;

    /* ── TODAY'S TAKINGS — deliberately unknown ───────────────────────────────
       posDailySummary has NO rule in the served ruleset, so a client read is denied, and
       posRetailSales is isAdmin() only. There is no canonical client source for the day's
       money. Rather than sum something adjacent and call it revenue, this stays unknown
       until the POS ownership authority is repaired. When it is, replace THIS function —
       nothing else needs to change. */
    out.takings = unknown('Till sales are not readable yet');
    out.trend   = unknown('Needs yesterday’s takings');

    var jobs = [];

    /* ── ONLINE ORDERS — real, but not the whole day ─────────────────────────── */
    jobs.push(ctx.db.queryOrders({
      collection: 'orders',
      where: [['sellerUid', '==', scope.sellerUid]],
      limit: 200,
    }).then(function (rows) {
      var today = new Date(); today.setHours(0, 0, 0, 0);
      var t = (rows || []).filter(function (o) {
        var ms = _millis(o && o.createdAt);
        /* An UNPARSEABLE timestamp is excluded, never counted as today. Guessing would
           inflate the day's count, and an inflated count is the fabrication this file
           exists to prevent — even when the inflation is only one order. */
        return ms !== null && ms >= today.getTime();
      });
      out.orders = partial(t.length, 'Online orders only · till sales not included');
      var ids = {};
      t.forEach(function (o) { var b = o.buyerUid || o.buyerId || o.uid; if (b) ids[b] = 1; });
      out.customers = partial(Object.keys(ids).length, 'From online orders only');
    }).catch(function () { /* leave unknown */ }));

    /* ── LOW STOCK — products the shop owns, stock read from the canonical field ── */
    jobs.push(ctx.db.queryProducts({
      collection: 'products',
      where: [['sellerUid', '==', scope.sellerUid]],
      limit: 300,
    }).then(function (rows) {
      var low = (rows || []).filter(function (p) {
        /* An ABSENT stock is unknown, not low. Number(undefined) is NaN and Number(null)
           is 0 — the second is the trap, so presence is checked before value. */
        if (!p || p.stock === undefined || p.stock === null) return false;
        var n = Number(p.stock); if (!isFinite(n)) return false;
        var th = (p.lowStockThreshold !== undefined && p.lowStockThreshold !== null)
          ? Number(p.lowStockThreshold) : 5;
        return n <= (isFinite(th) ? th : 5);
      });
      out.lowStock = { count: low.length, names: low.slice(0, 3).map(function (p) { return p.name; }) };
    }).catch(function () { /* leave null */ }));

    /* ── BEST SELLER — productStats is public, and it is the canonical counter ── */
    if (ctx.db.queryStats) {
      jobs.push(ctx.db.queryStats({
        collection: 'productStats',
        where: [['sellerUid', '==', scope.sellerUid]],
        orderBy: ['sold', 'desc'], limit: 1,
      }).then(function (rows) {
        var top = (rows || [])[0];
        if (top && top.name && isFinite(Number(top.sold)) && Number(top.sold) > 0) {
          out.bestSeller = { name: top.name, sold: Number(top.sold) };
        }
      }).catch(function () { /* leave null */ }));
    }

    /* ── WAITING REPLIES — conversations this merchant is a participant in ────── */
    if (ctx.db.queryConversations) {
      jobs.push(ctx.db.queryConversations({
        collection: 'conversations',
        where: [['participants', 'array-contains', scope.sellerUid]],
        limit: 100,
      }).then(function (rows) {
        var w = (rows || []).filter(function (c) {
          return c && c.lastSenderId && c.lastSenderId !== scope.sellerUid;
        });
        out.waiting = w.length;
      }).catch(function () { /* leave null */ }));
    }

    await Promise.all(jobs.map(function (p) { return p.catch(function () {}); }));
    return out;
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     NARRATIVE — "Your shop today"
     ───────────────────────────────────────────────────────────────────────────
     Only facts become sentences. A line whose source is unavailable is OMITTED, not
     softened into a guess — the section shrinks rather than lying. If nothing is known
     the section says so plainly instead of rendering an encouraging void.
     ═══════════════════════════════════════════════════════════════════════════ */
  function insights (f) {
    var out = [];
    if (f.bestSeller) {
      out.push({ emoji: '🔥', text: 'Your best-selling product is ' + f.bestSeller.name });
    }
    if (f.lowStock && f.lowStock.count > 0) {
      out.push({ emoji: '📦',
        text: f.lowStock.count === 1 ? '1 product is running low' : f.lowStock.count + ' products are running low',
        route: 'products' });
    }
    if (f.waiting !== null && f.waiting > 0) {
      out.push({ emoji: '💬',
        text: f.waiting === 1 ? '1 customer is waiting for a reply'
                              : f.waiting + ' customers are waiting for replies',
        route: 'messages' });
    }
    if (f.orders && f.orders.state !== 'unknown' && f.orders.value > 0) {
      out.push({ emoji: '🛍️',
        text: f.orders.value === 1 ? '1 online order came in today'
                                   : f.orders.value + ' online orders came in today',
        route: 'orders' });
    }
    return out;
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     VIEW
     ═══════════════════════════════════════════════════════════════════════════ */
  var ACTIONS = [
    { id: 'pos',       emoji: '🛒', label: 'Sell',     tone: 'a' },
    { id: 'orders',    emoji: '📦', label: 'Orders',   tone: 'b' },
    { id: 'products',  emoji: '➕',       label: 'Products', tone: 'c' },
    { id: 'messages',  emoji: '💬', label: 'Messages', tone: 'd' },
    { id: 'deliveries', emoji: '🚚', label: 'Track',   tone: 'e' },
    { id: 'revenue',   emoji: '💰', label: 'Payments', tone: 'f' },
  ];

  function statChip (emoji, v, label) {
    var val = renderValue(v);
    var cls = (v && v.state === 'unknown') ? ' sd-chip-unknown' : '';
    var part = (v && v.state === 'partial') ? ' <span class="sd-part">partial</span>' : '';
    return '<span class="sd-chip' + cls + '"' +
      (v && v.note ? ' title="' + esc(v.note) + '"' : '') + '>' +
      '<span class="sd-chip-e" aria-hidden="true">' + emoji + '</span>' +
      '<b class="sd-num" data-count="' + (v && v.state !== 'unknown' ? esc(String(v.value)) : '') + '">' +
      esc(val) + '</b> ' + esc(label) + part + '</span>';
  }

  function view (S) {
    var f = S.facts, ctx = S.ctx;
    var name = ctx.userName ? String(ctx.userName).split(' ')[0] : null;
    var heroKnown = f.takings && f.takings.state !== 'unknown';

    return '' +
    '<div class="sd">' +
      '<header class="sd-hi">' +
        '<div class="sd-hi-t">👋 ' + esc(greeting()) + (name ? ', ' + esc(name) : '') + '</div>' +
        '<div class="sd-hi-s">' + esc(ctx.shopName || 'Your shop') + '</div>' +
      '</header>' +

      /* ── HERO ─────────────────────────────────────────────────────────────── */
      '<section class="sd-hero' + (heroKnown ? '' : ' sd-hero-unknown') + '">' +
        '<div class="sd-hero-l"><span aria-hidden="true">🛍️</span> Today’s business</div>' +
        '<div class="sd-hero-v' + (heroKnown ? ' sd-num' : '') + '"' +
          (heroKnown ? ' data-count="' + esc(String(f.takings.value)) + '" data-money="1"' : '') + '>' +
          esc(heroKnown ? money(f.takings.value) : UNKNOWN) +
        '</div>' +
        (heroKnown && f.trend && f.trend.state !== 'unknown'
          ? '<div class="sd-trend">' + (f.trend.value >= 0 ? '↑' : '↓') + ' ' +
            esc(Math.abs(f.trend.value).toFixed(1)) + '% from yesterday</div>'
          : '<div class="sd-why">' + esc((f.takings && f.takings.note) || '') + '</div>') +
        '<div class="sd-chips">' +
          statChip('🟢', f.orders, 'orders') +
          statChip('🔵', f.customers, 'customers') +
          statChip('🟠', f.deliveries, 'deliveries') +
        '</div>' +
      '</section>' +

      /* ── QUICK ACTIONS ────────────────────────────────────────────────────── */
      '<section class="sd-sec">' +
        '<h2 class="sd-h"><span aria-hidden="true">⚡</span> Quick actions</h2>' +
        '<div class="sd-acts">' +
          ACTIONS.map(function (a, i) {
            return '<button type="button" class="sd-act sd-t' + a.tone + '" data-go="' + esc(a.id) + '"' +
              ' style="--i:' + i + '">' +
              '<span class="sd-act-e" aria-hidden="true">' + a.emoji + '</span>' +
              '<span class="sd-act-l">' + esc(a.label) + '</span></button>';
          }).join('') +
        '</div>' +
      '</section>' +

      /* ── YOUR SHOP TODAY ──────────────────────────────────────────────────── */
      '<section class="sd-sec">' +
        '<h2 class="sd-h"><span aria-hidden="true">🧠</span> Your shop today</h2>' +
        (S.insights.length
          ? '<ul class="sd-ins">' + S.insights.map(function (n, i) {
              return '<li class="sd-in" style="--i:' + i + '"' +
                (n.route ? ' data-go="' + esc(n.route) + '" tabindex="0" role="button"' : '') + '>' +
                '<span class="sd-in-e" aria-hidden="true">' + n.emoji + '</span>' +
                '<span class="sd-in-t">' + esc(n.text) + '</span></li>';
            }).join('') + '</ul>'
          : '<p class="sd-empty">Nothing to report yet — as your shop trades today, ' +
            'this is where it will show up.</p>') +
      '</section>' +
    '</div>';
  }

  /* ── The pulse. Facts move; unknowns do not. ──────────────────────────────── */
  function pulse (host) {
    var reduce = false;
    try { reduce = root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches; }
    catch (e) { reduce = false; }
    var nodes = host.querySelectorAll('.sd-num[data-count]');
    [].forEach.call(nodes, function (el) {
      var target = Number(el.getAttribute('data-count'));
      /* An empty data-count is an UNKNOWN. It must not animate: a moving em dash reads
         as "still loading", which is a different claim from "we do not know this". */
      if (el.getAttribute('data-count') === '' || !isFinite(target)) return;
      if (reduce) return;
      var isMoney = el.getAttribute('data-money') === '1';
      var t0 = null, DUR = 900;
      var step = function (ts) {
        if (t0 === null) t0 = ts;
        var p = Math.min(1, (ts - t0) / DUR);
        var eased = 1 - Math.pow(1 - p, 3);
        var v = Math.round(target * eased);
        el.textContent = isMoney ? money(v) : String(v);
        if (p < 1) root.requestAnimationFrame(step);
      };
      el.textContent = isMoney ? money(0) : '0';
      root.requestAnimationFrame(step);
    });
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     MOUNT
     ═══════════════════════════════════════════════════════════════════════════ */
  function mount (host, ctx) {
    if (!host) throw new Error('dashboard: a host element is required');
    ctx = ctx || {};
    var S = { host: host, ctx: ctx, facts: null, insights: [], destroyed: false };

    function onClick (e) {
      var t = e.target && e.target.closest ? e.target.closest('[data-go]') : null;
      if (!t) return;
      var id = t.getAttribute('data-go');
      /* THROUGH THE CONTRACT. Never location.href — the shell's exit contract exists
         because a literal URL once shipped here, and a tile is not an exception. */
      if (typeof ctx.go === 'function') ctx.go(id);
    }
    host.addEventListener('click', onClick);

    function paint () {
      if (S.destroyed) return;
      S.insights = insights(S.facts);
      host.innerHTML = view(S);
      pulse(host);
    }

    async function refresh () {
      if (S.destroyed) return;
      try { S.facts = await loadFacts(ctx); }
      catch (e) {
        /* Everything unknown is a legitimate state and renders honestly. */
        S.facts = { takings: unknown('Could not load'), trend: unknown('Could not load'),
                    orders: unknown('Could not load'), customers: unknown('Could not load'),
                    deliveries: unknown('Could not load'),
                    bestSeller: null, lowStock: null, waiting: null };
      }
      paint();
    }

    refresh();
    return {
      refresh: refresh,
      destroy: function () {
        S.destroyed = true;
        host.removeEventListener('click', onClick);
        host.innerHTML = '';
      },
    };
  }

  root.SokoniMerchantDashboard = {
    mount: mount,
    /* Exposed so the honesty rules can be executed rather than read. */
    _known: known, _partial: partial, _unknown: unknown,
    _renderValue: renderValue, _insights: insights, _money: money, _greeting: greeting,
    _loadFacts: loadFacts, UNKNOWN: UNKNOWN, ACTIONS: ACTIONS,
  };
})(typeof window !== 'undefined' ? window : globalThis);
