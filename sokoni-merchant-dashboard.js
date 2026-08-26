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

  /* The billing period the server uses: YYYY-MM. Read from the same clock the merchant
     reads, because a shop in Nairobi at 23:00 on the 31st is still in that month. */
  function _period (d) {
    var x = d || new Date();
    return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0');
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
  /* Sum ledger entries inside a window. Used ONLY for today/week, where no server
     aggregate exists. Returns null when the window cannot be trusted — specifically when
     the sample hit its page limit, because a truncated sum is a wrong sum and a wrong
     commission figure is the merchant's money. */
  function _sumWindow (rows, sinceMs, limit) {
    if (!Array.isArray(rows)) return null;
    if (rows.length >= limit) return null;           /* truncated — refuse to total it */
    var gross = 0, comm = 0, n = 0;
    rows.forEach(function (e) {
      var ms = _millis(e && e.createdAt);
      if (ms === null || ms < sinceMs) return;
      var g = Number(e.grossAmount), c = Number(e.commissionKES);
      if (!isFinite(g) || !isFinite(c)) return;
      gross += g; comm += c; n++;
    });
    return { gross: gross, comm: comm, count: n };
  }

  async function loadFacts (ctx, window_) {
    var scope = ctx.scope || {};
    var out = {
      takings:   unknown('Till sales are not readable yet'),
      trend:     unknown('Needs yesterday’s takings'),
      orders:    unknown('Orders are not available'),
      customers: unknown('No customer aggregate yet'),
      /* DELIVERIES stay unknown on purpose. `deliveries` is readable by senderUid, but no
         server writer sets senderUid anywhere in functions/, so whether the SHOP is the
         sender is unverified. An empty result would then be indistinguishable from "the
         rules filtered everything out", and rendering 0 would assert a fact about the
         shop's dispatch activity that nothing establishes. See docs/findings. */
      deliveries: unknown('Delivery totals need the dispatch authority'),
      needsAttention: null,
      bestSeller: null, lowStock: null, waiting: null,
      /* MONEY. Separate from the operational figures on purpose: this is the merchant's
         income and SOKONI's cut, and it must never be mixed with counts that are partial. */
      sales:      unknown('No billing period yet'),
      commission: unknown('No billing period yet'),
      earnings:   unknown('No billing period yet'),
      rate:       null,      /* {pct, fixed, mixed} READ from the ledger, never assumed */
      pendingPayout: unknown('Payout requests not readable'),
      balance:       unknown('Wallet not readable'),
      period: null,
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
      /* NEEDS ATTENTION — an order the merchant still has to act on. Derived from the
         order's own status, which is the merchant-readable authority; shipped, completed,
         cancelled and refunded are done with. */
      var OPEN = ['pending', 'paid', 'confirmed', 'processing'];
      out.needsAttention = (rows || []).filter(function (o) {
        return o && OPEN.indexOf(String(o.status)) > -1;
      }).length;
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

    /* ── COMMISSION — from sellerBilling, the aggregate the SERVER maintains ──────
       sellerBilling/{uid}/monthly/{period} is incremented inside the same transaction
       that writes each commissionLedger entry, so its totals cannot drift from the
       ledger. It is readable by the seller, and it is pre-aggregated — which matters,
       because summing a page of ledger entries client-side would silently under-report
       the moment a merchant exceeded the page size. A truncated total is a wrong total. */
    var period = _period();
    out.period = period;
    var win = window_ || 'month';

    /* TODAY and THIS WEEK have no server aggregate — sellerBilling only totals by month.
       They are summed from ledger entries, and REFUSED when the sample was truncated,
       because a partial sum of money is not a smaller truth, it is a wrong number. */
    if (win !== 'month' && ctx.db.queryCommission) {
      var LIM = 200;
      var since = new Date();
      if (win === 'today') since.setHours(0, 0, 0, 0);
      else { since.setDate(since.getDate() - 7); since.setHours(0, 0, 0, 0); }
      jobs.push(ctx.db.queryCommission({
        collection: 'commissionLedger',
        where: [['sellerUid', '==', scope.sellerUid]],
        orderBy: ['createdAt', 'desc'], limit: LIM,
      }).then(function (rows) {
        var w = _sumWindow(rows, since.getTime(), LIM);
        if (!w) {
          var why = 'Too many entries to total for this window';
          out.sales = unknown(why); out.commission = unknown(why); out.earnings = unknown(why);
          return;
        }
        out.sales = known(w.gross);
        out.commission = known(w.comm);
        out.earnings = known(w.gross - w.comm);
      }).catch(function () { /* leave unknown */ }));
    } else if (ctx.db.readBilling) {
      jobs.push(ctx.db.readBilling(scope.sellerUid, period).then(function (b) {
        if (!b) {
          /* No document yet is not zero — it means nothing has been billed this period,
             which for a shop that has traded would be wrong to assert either way. */
          out.sales = unknown('No sales recorded this period');
          out.commission = unknown('No sales recorded this period');
          out.earnings = unknown('No sales recorded this period');
          return;
        }
        var gross = Number(b.grossSalesKES);
        var comm  = Number(b.totalCommissionKES);
        if (isFinite(gross)) out.sales = known(gross);
        if (isFinite(comm))  out.commission = known(comm);
        /* Earnings is DERIVED, and only when both inputs are real. Deriving from one
           known and one unknown would produce a confident number built on a guess. */
        if (isFinite(gross) && isFinite(comm)) out.earnings = known(gross - comm);
      }).catch(function () { /* leave unknown */ }));
    }

    /* ── THE RATE — read from the ledger entries, NEVER a constant ────────────────
       Each entry records the commissionPct actually applied to that payment, plus any
       fixedFee. The rate is a commercial authority that lives on the server and can
       differ by plan, hub and agreement; hardcoding "3%" or "5%" here would state as
       fact something this file has no standing to know. If the entries disagree, say
       so rather than picking one. */
    if (ctx.db.queryCommission) {
      jobs.push(ctx.db.queryCommission({
        collection: 'commissionLedger',
        where: [['sellerUid', '==', scope.sellerUid]],
        orderBy: ['createdAt', 'desc'], limit: 50,
      }).then(function (rows) {
        var pcts = {}, fixed = {}, n = 0;
        (rows || []).forEach(function (e) {
          var p = Number(e && e.commissionPct);
          if (!isFinite(p)) return;
          pcts[p] = 1; n++;
          var f = Number(e && e.fixedFee); if (isFinite(f) && f > 0) fixed[f] = 1;
        });
        var keys = Object.keys(pcts);
        if (!n || !keys.length) return;               /* no entries -> no rate claim */
        out.rate = {
          pct: keys.length === 1 ? Number(keys[0]) : null,
          mixed: keys.length > 1,
          fixed: Object.keys(fixed).length === 1 ? Number(Object.keys(fixed)[0]) : null,
          sampled: n,
        };
      }).catch(function () { /* leave null */ }));
    }

    /* ── PENDING PAYOUT — payoutRequests is seller-readable ───────────────────── */
    if (ctx.db.queryPayouts) {
      jobs.push(ctx.db.queryPayouts({
        collection: 'payoutRequests',
        where: [['sellerUid', '==', scope.sellerUid]],
        limit: 50,
      }).then(function (rows) {
        var pend = (rows || []).filter(function (r) {
          return r && ['pending', 'processing', 'requested'].indexOf(String(r.status)) > -1;
        });
        var sum = 0, ok = pend.length > 0 || (rows || []).length >= 0;
        pend.forEach(function (r) { var a = Number(r.amount); if (isFinite(a)) sum += a; });
        if (ok) out.pendingPayout = known(sum);
      }).catch(function () { /* leave unknown */ }));
    }

    /* ── AVAILABLE BALANCE — wallets/{uid}.balance, in shillings ──────────────── */
    if (ctx.db.readWallet) {
      jobs.push(ctx.db.readWallet(scope.sellerUid).then(function (w) {
        var b = w && Number(w.balance);
        if (isFinite(b)) out.balance = known(b);
        else out.balance = unknown('No wallet yet');
      }).catch(function () { /* leave unknown */ }));
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
    if (f.needsAttention !== null && f.needsAttention > 0) {
      out.push({ emoji: '🎯',
        text: f.needsAttention === 1 ? '1 order needs your attention'
                                     : f.needsAttention + ' orders need your attention',
        route: 'orders' });
    }
    /* Delivery activity earns a line only when the count is REAL. Today it never is, so
       no cheerful "4 deliveries are moving" appears — that sentence would be fiction. */
    if (f.deliveries && f.deliveries.state !== 'unknown' && f.deliveries.value > 0) {
      out.push({ emoji: '🚚',
        text: f.deliveries.value === 1 ? '1 delivery is currently moving'
                                       : f.deliveries.value + ' deliveries are currently moving',
        route: 'deliveries' });
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
  /* ── THE MAIN AREAS ───────────────────────────────────────────────────────────
     Each names a CONTRACT ROUTE ID. A tile whose id does not resolve is not rendered at
     all — a memorable navigation that leads somewhere broken is worse than a shorter one.
     'services' is deliberately absent: it is not in the merchant route contract, and
     inventing a destination for it would be a dead tile with a nice emoji. */
  var NAV = [
    { id: 'dashboard', emoji: '🏠', label: 'Home' },
    { id: 'shop',      emoji: '🛍️', label: 'Shop' },
    { id: 'messages',  emoji: '💬', label: 'Messages' },
    { id: 'deliveries', emoji: '🚚', label: 'Track' },
    { id: 'analytics', emoji: '📊', label: 'Insights' },
    { id: 'settings',  emoji: '⚙️', label: 'Settings' },
  ];

  /* The commission window. 'month' matches the server's billing period exactly; the
     shorter windows are DERIVED from ledger entries and are labelled as such, because
     sellerBilling only aggregates by month. */
  var PERIODS = [
    { id: 'today', label: 'Today' },
    { id: 'week',  label: 'This week' },
    { id: 'month', label: 'This month' },
  ];

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

  /* The rate, said only as strongly as the evidence allows. */
  function rateLine (r) {
    if (!r) return 'Commission rate — not recorded yet';
    if (r.mixed) return 'Commission rate varies across recent sales';
    var out = 'Commission rate ' + r.pct + '%';
    if (r.fixed) out += ' + ' + money(r.fixed) + ' per sale';
    return out;
  }

  function pulseTile (emoji, label, v, isMoney) {
    var isKnown = v && v.state !== 'unknown';
    var txt = isKnown ? (isMoney ? money(v.value) : String(v.value)) : UNKNOWN;
    return '<div class="sd-pt' + (isKnown ? '' : ' sd-pt-unknown') + '">' +
      '<div class="sd-pt-e" aria-hidden="true">' + emoji + '</div>' +
      '<div class="sd-pt-v' + (isKnown ? ' sd-num' : '') + '"' +
        (isKnown ? ' data-count="' + esc(String(v.value)) + '"' + (isMoney ? ' data-money="1"' : '') : '') +
        '>' + esc(txt) + '</div>' +
      '<div class="sd-pt-l">' + esc(label) +
        (v && v.state === 'partial' ? ' <span class="sd-part">partial</span>' : '') + '</div>' +
      (v && v.note && !isKnown ? '<div class="sd-pt-w">' + esc(v.note) + '</div>' : '') +
    '</div>';
  }

  function moneyTile (emoji, label, v) {
    var isKnown = v && v.state === 'known';
    return '<div class="sd-mt' + (isKnown ? '' : ' sd-mt-unknown') + '"' +
      (v && v.note ? ' title="' + esc(v.note) + '"' : '') + '>' +
      '<div class="sd-mt-l"><span aria-hidden="true">' + emoji + '</span> ' + esc(label) + '</div>' +
      '<div class="sd-mt-v' + (isKnown ? ' sd-num' : '') + '"' +
        (isKnown ? ' data-count="' + esc(String(v.value)) + '" data-money="1"' : '') + '>' +
        esc(isKnown ? money(v.value) : UNKNOWN) + '</div></div>';
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

      /* ── 🔥 BUSINESS PULSE ────────────────────────────────────────────────────
         The day's operational shape, promoted out of the hero into its own section so
         each figure carries its own label, its own state and its own reason. */
      '<section class="sd-sec">' +
        '<h2 class="sd-h"><span aria-hidden="true">🔥</span> Business pulse</h2>' +
        '<div class="sd-pulse">' +
          pulseTile('🛍️', 'Sales', f.takings, true) +
          pulseTile('📦', 'Orders', f.orders) +
          pulseTile('👥', 'Customers', f.customers) +
          pulseTile('🚚', 'Deliveries', f.deliveries) +
        '</div>' +
      '</section>' +

      /* ── 💰 MONEY ─────────────────────────────────────────────────────────────
         The flow stated as a flow, because that is the thing a merchant must be able to
         read in one glance:  customer pays -> SOKONI commission -> merchant receives.
         Commission is styled as a DEDUCTION and earnings as the merchant's own, so the
         two can never be misread for one another. Nothing here is a percentage this file
         invented: the rate is whatever the ledger entries actually recorded. */
      '<section class="sd-sec">' +
        '<h2 class="sd-h"><span aria-hidden="true">💰</span> Money</h2>' +
        '<div class="sd-pers" role="tablist" aria-label="Commission period">' +
          PERIODS.map(function (pr) {
            return '<button type="button" role="tab" class="sd-perb' +
              (S.period === pr.id ? ' sd-perb-on' : '') + '" data-period="' + esc(pr.id) + '"' +
              ' aria-selected="' + (S.period === pr.id ? 'true' : 'false') + '">' +
              esc(pr.label) + '</button>';
          }).join('') +
        '</div>' +
        '<div class="sd-comm">' +
          '<div class="sd-comm-l"><span aria-hidden="true">💰</span> SOKONI commission</div>' +
          '<div class="sd-comm-v' + (f.commission.state === 'known' ? ' sd-num' : '') + '"' +
            (f.commission.state === 'known'
              ? ' data-count="' + esc(String(f.commission.value)) + '" data-money="1"' : '') + '>' +
            esc(f.commission.state === 'known' ? money(f.commission.value) : UNKNOWN) + '</div>' +
          '<div class="sd-comm-r">' +
            /* When the figure is unknown, the REASON replaces the rate line. Dashes with
               no explanation leave a merchant wondering whether their money vanished. */
            esc(f.commission.state === 'unknown' && f.commission.note
                  ? f.commission.note : rateLine(f.rate)) + '</div>' +

          '<ol class="sd-flow">' +
            '<li class="sd-flow-i"><span class="sd-flow-e" aria-hidden="true">🛍️</span>' +
              '<span class="sd-flow-k">Sales</span>' +
              '<b class="sd-flow-v">' + esc(f.sales.state === 'known' ? money(f.sales.value) : UNKNOWN) + '</b></li>' +
            '<li class="sd-flow-i sd-flow-cut"><span class="sd-flow-e" aria-hidden="true">📉</span>' +
              '<span class="sd-flow-k">SOKONI commission</span>' +
              '<b class="sd-flow-v">' + (f.commission.state === 'known' ? '−' + esc(money(f.commission.value)) : UNKNOWN) + '</b></li>' +
            '<li class="sd-flow-i sd-flow-net"><span class="sd-flow-e" aria-hidden="true">💵</span>' +
              '<span class="sd-flow-k">Your earnings</span>' +
              '<b class="sd-flow-v">' + esc(f.earnings.state === 'known' ? money(f.earnings.value) : UNKNOWN) + '</b></li>' +
          '</ol>' +
          '<button type="button" class="sd-comm-a" data-go="revenue">View commission →</button>' +
        '</div>' +

        '<div class="sd-money2">' +
          moneyTile('⏳', 'Pending payout', f.pendingPayout) +
          moneyTile('🏦', 'Available balance', f.balance) +
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

      /* ── THE AREAS ────────────────────────────────────────────────────────── */
      '<nav class="sd-nav" aria-label="Main areas">' +
        NAV.filter(function (n) { return S.navOk[n.id]; }).map(function (n) {
          return '<button type="button" class="sd-navi" data-go="' + esc(n.id) + '">' +
            '<span class="sd-navi-e" aria-hidden="true">' + n.emoji + '</span>' +
            '<span class="sd-navi-l">' + esc(n.label) + '</span></button>';
        }).join('') +
      '</nav>' +

      '<button type="button" class="sd-deeper" data-go="orders">' +
        'Open Merchant V2 <span aria-hidden="true">→</span></button>' +
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
    /* Which areas actually resolve. Asked ONCE, at mount, through the same contract the
       shell uses — so a tile can never be drawn for a destination that does not exist. */
    var navOk = {};
    NAV.forEach(function (n) {
      navOk[n.id] = (typeof ctx.resolves === 'function') ? !!ctx.resolves(n.id) : true;
    });
    var S = { host: host, ctx: ctx, facts: null, insights: [], destroyed: false, navOk: navOk,
              period: 'month' };

    function onClick (e) {
      var pb = e.target && e.target.closest ? e.target.closest('[data-period]') : null;
      if (pb) {
        var next = pb.getAttribute('data-period');
        if (next && next !== S.period) { S.period = next; refresh(); }
        return;
      }
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
      try { S.facts = await loadFacts(ctx, S.period); }
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
    _rateLine: rateLine, _period: _period,
  };
})(typeof window !== 'undefined' ? window : globalThis);
