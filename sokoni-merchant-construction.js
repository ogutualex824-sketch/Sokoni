/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI — MERCHANT V2 · CONSTRUCTION WORKSPACE  (hosting slice, 2026-10-03)
   ══════════════════════════════════════════════════════════════════════════════
   The contractor / supplier / equipment-rental side of the Construction hub, inside the
   merchant shell. Ten con-* routes (Construction group in sokoni-merchant-routes.js) mount
   THIS module with ctx.view naming the section. Sections that already exist in merchant-v2
   (Storefront, Products, Inventory, Orders, Customers, Messages, Delivery, Marketing, Wallet,
   Subscription, Staff) are LINKS to those routes — never a second copy of their module.

   AUTHORITIES (consumed as-is; this module decides no status, price, fee or role)
     Leads        contactRequests where sellerUid == uid — a direct read the rules allow the
                  seller. The ONE write this module makes: updateDoc on a lead with exactly
                  {status, respondedAt?, sellerNote?} — the keys the rule's affectedKeys() allows.
                  Buttons follow the f9a5c45 seller lifecycle (sokoni-f3 combined rules, leadNext()).
                  respondedAt is a server timestamp, stamped by the shell (SERVER_TIME token).
     Equipment &  commerceDispatch ops in functions/marketplace-extensions.js — the contract of
     Rentals      sokoni-f3's rentals line (functions/rentals-on-53100ff @ bb8634d, NOT deployed):
                  rentalOwnerListings {shopId} → {listings, hasMore} (Equipment), rentalProductCreate,
                  rentalGetAvailability, rentalList, rentalConfirm, rentalComplete, rentalCancel
                  (seller cancel through the shop authority). Owner lifecycle bb8634d: listings
                  draft → active (Available) ⇄ paused via rentalProductPublish / rentalProductPause;
                  bookings requested → accepted | declined → payment_pending → paid_held → active →
                  return_pending → returned → completed (rentalAccept / rentalDecline / rentalStart /
                  rentalConfirmReturn / rentalComplete; rentalCancel only while unpaid). Payment states are
                  written only by the payment authority (2f rental_booking + 5b webhook) and labelled
                  from the status alone. Errors are HttpsError reasons, shown verbatim.
                  Old server (live today: no rentalOwnerListings) → the direct rentalProducts read is the
                  fallback, chosen ONLY on an "Unknown commerce operation" refusal; it has no rules yet,
                  so a refused read says "Rentals become visible once access rules ship".
     Verification applications where uid == uid (owner-only read); the status shown is the
                  application's own field. "Verified" appears ONLY when verified === true (an
                  admin-only field under noAdminFields()).
     Plans        subGetPlans({hubType:'construction'}) — only a plan the catalog prices for the
                  construction hub is shown; otherwise '—'.
     RFQs/Quotes  sokoni-f3's 'rfqs' route (rfqDispatch) when the shell has it; otherwise an
                  honest "arrives with the B2B release" entry.
     Projects     the SOKONI Work engine (unbuilt): an honest entry, no records, no storage.

   ROLE VARIANTS: no server capability says whether this business is a contractor, a supplier or
   an equipment-rental company (the 5b MODULES hand-off). Until it does, the Overview shows all
   three layouts to the owner. The role is NEVER inferred from a browser-side category.

   DATA INTEGRITY: every figure is derived from what THIS page loaded from the server. Unknown
   is '—', never 0. A capped list makes its counts lower bounds ('N+').
   ══════════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var VIEWS = ['overview', 'leads', 'projects', 'rfqs', 'quotes', 'services',
               'equipment', 'availability', 'rentals', 'verification'];
  var ROUTE_OF = {};
  VIEWS.forEach(function (v) { ROUTE_OF[v] = 'con-' + v; });

  /* Existing merchant-v2 destinations the owner's layout REUSES. Keys are owner section names,
     values are route ids already in the registry. Nothing here is re-implemented. */
  var REUSED = {
    storefront: 'shop', products: 'products', inventory: 'inventory', orders: 'orders',
    customers: 'customers', messages: 'messages', delivery: 'deliveries', marketing: 'marketing',
    wallet: 'payments', subscription: 'plan', staff: 'staff'
  };
  /* Owner layout (sokoni-f3, 2026-10-03). [label, section key]; a key in REUSED links out, any
     other key is a con-* view of this module. */
  var LAYOUTS = [
    { key: 'contractor', label: 'Contractor', sections: [
      ['Overview', 'overview'], ['Storefront', 'storefront'], ['Services', 'services'], ['Products', 'products'],
      ['Projects', 'projects'], ['RFQs', 'rfqs'], ['Leads', 'leads'], ['Quotes', 'quotes'], ['Orders', 'orders'],
      ['Customers', 'customers'], ['Messages', 'messages'], ['Delivery', 'delivery'], ['Equipment', 'equipment'],
      ['Marketing', 'marketing'], ['Wallet', 'wallet'], ['Subscription', 'subscription'],
      ['Verification', 'verification'], ['Staff', 'staff']] },
    { key: 'supplier', label: 'Materials supplier', sections: [
      ['Products', 'products'], ['Inventory', 'inventory'], ['RFQs', 'rfqs'], ['Orders', 'orders'], ['Delivery', 'delivery']] },
    { key: 'rental', label: 'Equipment rental', sections: [
      ['Equipment', 'equipment'], ['Availability', 'availability'], ['Rentals', 'rentals']] }
  ];
  function routeFor (key) { return REUSED[key] || ROUTE_OF[key] || null; }

  /* ── LEADS — the f9a5c45 seller lifecycle, the subset the owner brief exposes ──
     The rule allows more (pending → contacted); the page offers only these. The server
     (rules) re-checks every move; this table only decides which buttons are drawn. */
  var LEAD_NEXT = {
    pending:         ['responded', 'qualified', 'lost'],
    responded:       ['qualified', 'quote_requested', 'quote_sent', 'lost'],
    contacted:       ['qualified', 'quote_requested', 'quote_sent', 'lost'],
    qualified:       ['quote_requested', 'quote_sent', 'lost'],
    quote_requested: ['quote_sent', 'lost'],
    quote_sent:      ['negotiating', 'won', 'lost'],
    negotiating:     ['quote_sent', 'won', 'lost']
  };
  var LEAD_TERMINAL = ['won', 'lost', 'cancelled', 'expired'];
  var LEAD_KEYS = ['status', 'respondedAt', 'sellerNote'];
  var LEADS_LIMIT = 200;
  var NOTE_MAX = 500;
  /* An opaque token: the SHELL swaps it for firestore serverTimestamp(). The browser clock is
     never written as respondedAt. */
  var SERVER_TIME = Object.freeze({ __sokoniServerTime: true });
  var LEAD_TX = 'product_enquiry';

  function titleCase (s) {
    return String(s || '').split('_').map(function (w) { return w ? w.charAt(0).toUpperCase() + w.slice(1) : w; }).join(' ');
  }
  function leadStatus (r) { return String((r && r.status) || 'pending'); }
  function leadLabel (st) {
    if (st === 'pending') return 'New';
    if (st === 'responded') return 'Contacted';
    return titleCase(st);
  }
  function leadActions (r) {
    var st = leadStatus(r);
    return LEAD_NEXT[st] ? LEAD_NEXT[st].slice() : [];
  }
  function isOpenLead (r) { return LEAD_TERMINAL.indexOf(leadStatus(r)) < 0; }
  /* The ONLY write shape. Anything else is a bug and is refused here before the shell (which
     refuses it again) or the rules (which refuse it a third time) see it. */
  function leadMovePayload (r, to) {
    if (leadActions(r).indexOf(to) < 0) return null;
    var p = { status: to };
    if (to === 'responded') p.respondedAt = SERVER_TIME;
    return p;
  }
  function leadNotePayload (text) {
    var t = String(text == null ? '' : text).trim();
    if (t.length > NOTE_MAX) t = t.slice(0, NOTE_MAX);
    return { sellerNote: t };
  }
  function chatAvailable (win) {
    var w = win || global, ib = w && w.SokoniInbox;
    return !!(ib && Array.isArray(ib.TX_TYPES) && ib.TX_TYPES.indexOf(LEAD_TX) >= 0 && typeof ib.openForTransaction === 'function');
  }

  /* ── RENTALS — server vocabulary (functions/marketplace-extensions.js) ── */
  var PRICING_TYPES = ['hourly', 'daily', 'weekly', 'monthly', 'flexible'];
  var RATE_FIELD = { hourly: 'hourlyRate', daily: 'dailyRate', weekly: 'weeklyRate', monthly: 'monthlyRate' };
  /* OWNER RENTAL LIFECYCLE (sokoni-f3 bb8634d, functions/rentals-on-53100ff, NOT deployed):
       requested → accepted | declined → payment_pending → paid_held → active → return_pending → returned → completed;
       terminal declined / cancelled / refunded. Legacy documents: pending = requested, confirmed = accepted.
     payment_pending and paid_held are written ONLY by the payment authority (2f rental_booking purpose + 5b webhook); the
     page labels payment from the STATUS alone — never from paymentStatus / paidAt / paymentMethod. */
  var RENTAL_LEGACY = { pending: 'requested', confirmed: 'accepted' };
  var RENTAL_LABEL = { requested: 'Requested', accepted: 'Accepted', payment_pending: 'Awaiting payment',
    paid_held: 'Paid — held by SOKONI', active: 'On hire', return_pending: 'Return reported', returned: 'Returned',
    completed: 'Completed', declined: 'Declined', cancelled: 'Cancelled', refunded: 'Refunded' };
  /* Seller buttons — ONLY these. Cancel only while unpaid (requested / accepted / payment_pending); never on paid_held
     (a paid cancellation is the payment authority's refund policy). rentalReportReturn is the renter's, not a button here. */
  var RENTAL_NEXT = { requested: ['accept', 'decline', 'cancel'], accepted: ['cancel'], payment_pending: ['cancel'],
    paid_held: ['start'], active: ['confirm-return'], return_pending: ['confirm-return'], returned: ['complete'] };
  var RENTAL_OP = { accept: 'rentalAccept', decline: 'rentalDecline', start: 'rentalStart', 'confirm-return': 'rentalConfirmReturn',
    complete: 'rentalComplete', cancel: 'rentalCancel' };
  var RENTAL_BTN = { accept: 'Accept', decline: 'Decline', start: 'Start hire', 'confirm-return': 'Confirm return',
    complete: 'Complete', cancel: 'Cancel' };
  var RENTAL_DONE = { accept: 'Accepted. SOKONI asks the renter to pay next.', decline: 'Declined.', start: 'Hire started.',
    'confirm-return': 'Return confirmed.', complete: 'Completed. SOKONI releases the held payment to you.', cancel: 'Cancelled.' };
  var LISTING_LABEL = { draft: 'Draft', active: 'Available', paused: 'Paused' };
  var LISTING_NEXT = { draft: ['publish'], paused: ['publish'], active: ['pause'] };
  var RENTAL_LIST_CAP = 100;      /* rentalList shop-side .limit(100) */
  var EQUIP_LIMIT = 200;          /* rentalOwnerListings cap (exact hasMore); the old-server direct read asks limit+1 */
  /* Rental payment IS priced on sokoni-2f's commercial line (64da94c: rental_booking purpose, construction_equipment_rental
     10% on the hire, never the deposit), so the old "paid rentals open once…" copy is gone. The flow is stated instead. */
  var RENTAL_FLOW_COPY = 'After you accept, SOKONI asks the renter to pay. SOKONI holds the payment and releases it to you when the rental is completed.';
  var RULES_COPY = 'Rentals become visible once access rules ship.';
  /* An op this server does not know (older commerceDispatch): the dispatcher answers not-found with
     "Unknown commerce operation". Only that answer selects the old-server fallback. */
  function isUnknownOp (e) {
    var c = String((e && e.code) || '');
    return (c === 'not-found' || c === 'functions/not-found') && /Unknown commerce operation/.test(String((e && e.message) || ''));
  }
  function rentalStatus (b) { var s = String((b && b.status) || ''); return RENTAL_LEGACY[s] || s; }
  function rentalLabel (b) { var s = rentalStatus(b); return RENTAL_LABEL[s] || (s ? titleCase(s) : '—'); }
  /* Payment line from STATUS only. */
  function paymentText (b) {
    var s = rentalStatus(b);
    if (s === 'payment_pending') return 'Awaiting payment';
    if (s === 'paid_held') return 'Paid — held by SOKONI';
    return null;
  }
  /* Method from the webhook only: '—' until set; 'none' is rentalBook's placeholder, not a method. Never a default. */
  function paymentMethodText (b) {
    var m = b && typeof b.paymentMethod === 'string' ? b.paymentMethod.trim() : '';
    return (m && m.toLowerCase() !== 'none') ? m : '—';
  }
  function listingStatus (e) { return String((e && e.status) || ''); }
  function listingActions (e) { var s = listingStatus(e); return LISTING_NEXT[s] ? LISTING_NEXT[s].slice() : []; }
  function rentalActions (b) { var s = rentalStatus(b); return RENTAL_NEXT[s] ? RENTAL_NEXT[s].slice() : []; }

  /* ── VERIFICATION ── */
  var APP_LABEL = { pending: 'Submitted — awaiting review', info_requested: 'More information requested',
    approved: 'Approved', rejected: 'Not approved', suspended: 'Suspended', withdrawn: 'Withdrawn' };
  function appLabel (a) { var s = String((a && a.status) || ''); return APP_LABEL[s] || (s ? titleCase(s) : '—'); }
  function isVerified (a) { return !!a && a.verified === true; }

  /* ── escaping: the canonical escapeHTML (security.js), identical fallback ── */
  function esc (s) {
    if (typeof global.escapeHTML === 'function') return global.escapeHTML(s);
    if (s === null || s === undefined) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#x27;').replace(/\//g, '&#x2F;').replace(/`/g, '&#x60;');
  }
  var isId = function (v) { return typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v); };
  function ms (t) {
    if (t == null) return null;
    if (t instanceof Date) return t.getTime();
    if (typeof t.toMillis === 'function') { try { return t.toMillis(); } catch (_) { return null; } }
    if (typeof t === 'number') return t;
    if (typeof t === 'string') { var d = Date.parse(t); return isNaN(d) ? null : d; }
    if (typeof t._seconds === 'number') return t._seconds * 1000;
    if (typeof t.seconds === 'number') return t.seconds * 1000;
    return null;
  }
  function fmtDate (t) {
    var m = ms(t); if (m == null) return '—';
    try { return new Date(m).toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' }); }
    catch (_) { return new Date(m).toISOString().slice(0, 10); }
  }
  /* Unknown is '—'. A real loaded zero is '0'. A count from a capped list is a lower bound: 'N+'. */
  function fmtCount (n, partial) { return (typeof n === 'number' && isFinite(n)) ? String(n) + (partial ? '+' : '') : '—'; }
  function fmtKes (n) { return (typeof n === 'number' && isFinite(n) && n >= 0) ? 'KES ' + n.toLocaleString('en-KE') : '—'; }
  function errCode (e) { return String((e && e.code) || '').replace(/^functions\//, '') || null; }
  /* Server reasons are shown VERBATIM (f3 74672f3: rental handlers throw HttpsError with a reason). Only a missing
     message falls back to the code. */
  /* Lead writes are Firestore rule decisions (no server reason text): a refusal is named as one. */
  function leadErrMsg (e) {
    return errCode(e) === 'permission-denied' ? 'SOKONI refused this (permission). Nothing was changed.' : errMsg(e);
  }
  function errMsg (e) {
    var m = e && e.message ? String(e.message) : (errCode(e) || 'error');
    if (errCode(e) === 'unauthenticated' && !(e && e.message)) m = 'Sign in again, then retry.';
    return m + (/[.!?]$/.test(m) ? '' : '.') + ' Nothing was changed.';
  }


  /* ── counts for Overview: only from loaded server data ── */
  function leadCounts (L) {
    if (!L || !Array.isArray(L.rows)) return { fresh: null, open: null, partial: false };
    var fresh = 0, open = 0;
    L.rows.forEach(function (r) { if (leadStatus(r) === 'pending') fresh++; if (isOpenLead(r)) open++; });
    return { fresh: fresh, open: open, partial: !!L.hasMore };
  }
  function rentalCounts (R) {
    if (!R || !Array.isArray(R.rows)) return { pending: null, partial: false };
    var n = 0; R.rows.forEach(function (b) { if (rentalStatus(b) === 'requested') n++; });
    return { pending: n, partial: !!R.capped };
  }
  function equipmentCount (E) {
    if (!E || !Array.isArray(E.rows)) return { n: null, partial: false };
    return { n: E.rows.length, partial: !!E.hasMore };
  }
  function constructionPlans (plans) {
    return (Array.isArray(plans) ? plans : []).filter(function (p) {
      return p && p.hubType === 'construction' && p.price && typeof p.price.monthly === 'number' && isFinite(p.price.monthly);
    });
  }

  /* ══ CSS — mobile-first (390px), the shell's tokens ══ */
  var CSS = [
    '.cw{padding:14px 14px 90px;max-width:980px;margin:0 auto;color:var(--txt,#f4f4f4);overflow-wrap:anywhere;min-width:0}',
    '.cw *{box-sizing:border-box;min-width:0}',
    '.cw h2{font-size:18px;margin:0 0 4px}.cw h3{font-size:15px;margin:14px 0 8px}.cw .cw-sub{color:var(--txt2,#a8a8a8);font-size:13px;margin:0 0 12px}',
    '.cw-tiles{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin:0 0 14px}',
    '@media(min-width:720px){.cw-tiles{grid-template-columns:repeat(4,minmax(0,1fr))}}',
    '.cw-tile{background:var(--surface-2,#141414);border:1px solid var(--line,rgba(255,255,255,.09));border-radius:12px;padding:10px}',
    '.cw-tile b{display:block;font-size:20px}.cw-tile small{color:var(--txt2,#a8a8a8);font-size:12px}',
    '.cw-card{background:var(--surface-2,#141414);border:1px solid var(--line,rgba(255,255,255,.09));border-radius:12px;padding:12px;margin:0 0 10px}',
    '.cw-row{display:flex;flex-wrap:wrap;gap:6px 8px;align-items:center;justify-content:space-between}',
    '.cw-badge{display:inline-block;font-size:12px;padding:2px 8px;border-radius:999px;background:var(--acc-dim,rgba(113,255,0,.12));color:var(--acc,#71ff00)}',
    '.cw-chip{display:inline-block;font-size:12px;padding:2px 8px;border-radius:999px;border:1px solid var(--line,rgba(255,255,255,.2));color:var(--txt2,#a8a8a8)}',
    '.cw-meta{color:var(--txt2,#a8a8a8);font-size:13px;margin:4px 0}',
    '.cw-msg{font-size:13.5px;margin-top:8px;white-space:pre-wrap}',
    '.cw-acts{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}',
    '.cw-btn{border:1px solid var(--line,rgba(255,255,255,.2));border-radius:10px;padding:8px 12px;min-height:40px;font-size:14px;background:transparent;color:inherit;cursor:pointer;font-family:inherit}',
    '.cw-btn.pri{background:var(--acc,#71ff00);color:#000;border-color:transparent;font-weight:700}',
    '.cw-btn.dan{border-color:var(--danger,#ff5252);color:var(--danger,#ff5252)}',
    '.cw-btn[disabled]{opacity:.5;cursor:not-allowed}',
    '.cw-note{font-size:13px;margin-top:8px;padding:8px 10px;border-radius:10px;border:1px solid var(--line,rgba(255,255,255,.12))}',
    '.cw-note.err{border-color:var(--danger,#ff5252);color:var(--danger,#ff8a8a)}',
    '.cw-note.warn{border-color:#e0a800;color:#ffd666}',
    '.cw-form{display:grid;gap:8px;margin:0 0 14px}',
    '.cw-form label{display:grid;gap:4px;font-size:13px;color:var(--txt2,#a8a8a8)}',
    '.cw input,.cw select,.cw textarea{width:100%;font:inherit;font-size:16px;padding:9px 10px;border-radius:10px;border:1px solid var(--line,rgba(255,255,255,.2));background:var(--surface,#0d0d0d);color:inherit}',
    '.cw-two{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:8px}',
    '.cw-secs{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px}',
    '@media(min-width:720px){.cw-secs{grid-template-columns:repeat(4,minmax(0,1fr))}}',
    '.cw-secs .cw-btn{text-align:left;width:100%}'
  ].join('\n');
  function injectCss (doc) {
    if (!doc || !doc.getElementById || doc.getElementById('cw-css')) return;
    var st = doc.createElement('style'); st.id = 'cw-css'; st.textContent = CSS; doc.head.appendChild(st);
  }

  /* ── one store per signed-in uid, shared by every view ── */
  var STORE = null;
  var SUBS = [];
  function store (uid) {
    if (!STORE || STORE.uid !== uid) {
      STORE = { uid: uid, leads: null, leadsLoading: false, leadNotes: {},
                equip: null, equipLoading: false, created: [],
                rentals: null, rentalsLoading: false, rentalNotes: {}, listingNotes: {},
                avail: {}, apps: null, appsLoading: false, plans: null, plansLoading: false };
    }
    return STORE;
  }
  function paintAll () { SUBS.slice().forEach(function (f) { try { f(); } catch (_) {} }); }

  /* ══ MOUNT ══ */
  function mount (host, ctx) {
    var c = ctx || {};
    var view = VIEWS.indexOf(c.view) >= 0 ? c.view : 'overview';
    var dead = false;
    var ui = { form: null, formNote: null, busy: false, cancelAsk: null, declineAsk: null, pick: '' };
    injectCss(host.ownerDocument || (global.document || null));
    function uid () { try { return typeof c.uid === 'function' ? c.uid() : null; } catch (_) { return null; } }
    function role () { try { return typeof c.role === 'function' ? c.role() : null; } catch (_) { return null; } }
    function shopId () { try { return typeof c.shopId === 'function' ? c.shopId() : null; } catch (_) { return null; } }
    function isStaff () { var r = role(); return !!r && r !== 'owner'; }
    function dispatch (op, payload) {
      if (typeof c.dispatch !== 'function') return Promise.reject({ code: 'unavailable', message: 'commerceDispatch is not wired' });
      return Promise.resolve(c.dispatch(Object.assign({ op: op }, payload || {})));
    }

    /* ── loaders ── */
    function loadLeads (S, force) {
      if (!S.uid || isStaff() || typeof c.readLeads !== 'function') return Promise.resolve();
      if (S.leadsLoading || (S.leads && !force)) return Promise.resolve();
      S.leadsLoading = true;
      return Promise.resolve(c.readLeads(LEADS_LIMIT + 1)).then(function (rows) {
        rows = Array.isArray(rows) ? rows.slice() : [];
        var hasMore = rows.length > LEADS_LIMIT;
        if (hasMore) rows = rows.slice(0, LEADS_LIMIT);
        rows.sort(function (a, b) { return (ms(b.createdAt) || 0) - (ms(a.createdAt) || 0); });
        S.leads = { rows: rows, hasMore: hasMore, err: null };
      }, function (e) { S.leads = { rows: null, hasMore: false, err: errCode(e) || 'read-failed' }; })
        .then(function () { S.leadsLoading = false; paintAll(); });
    }
    /* Equipment = commerceDispatch rentalOwnerListings {shopId} → {listings, hasMore} (every status, newest first, 200 cap,
       owner / staff / admin shop authority). The direct rentalProducts read is used ONLY when the server answers that it
       does not know the op (an older commerceDispatch) — never on any other failure. */
    function loadEquip (S, force) {
      var sid = shopId();
      if (!S.uid || !sid) return Promise.resolve();
      if (S.equipLoading || (S.equip && !force)) return Promise.resolve();
      S.equipLoading = true;
      return dispatch('rentalOwnerListings', { shopId: sid }).then(function (d) {
        var rows = d && Array.isArray(d.listings) ? d.listings : null;
        S.equip = rows ? { rows: rows, hasMore: d.hasMore === true, err: null, source: 'server' }
                       : { rows: null, hasMore: false, err: 'malformed', msg: 'The equipment list came back malformed. Nothing is guessed here.' };
      }, function (e) {
        if (!isUnknownOp(e) || typeof c.readEquipment !== 'function') { S.equip = { rows: null, hasMore: false, err: errCode(e) || 'failed', msg: e && e.message ? String(e.message) : null }; return; }
        return Promise.resolve(c.readEquipment(EQUIP_LIMIT + 1)).then(function (rows) {
          rows = Array.isArray(rows) ? rows.slice() : [];
          var hasMore = rows.length > EQUIP_LIMIT;
          S.equip = { rows: hasMore ? rows.slice(0, EQUIP_LIMIT) : rows, hasMore: hasMore, err: null, source: 'direct' };
        }, function (e2) { S.equip = { rows: null, hasMore: false, err: errCode(e2) || 'read-failed', source: 'direct' }; });
      }).then(function () { S.equipLoading = false; paintAll(); });
    }
    function loadRentals (S, force) {
      var sid = shopId();
      if (!S.uid || !sid) return Promise.resolve();
      if (S.rentalsLoading || (S.rentals && !force)) return Promise.resolve();
      S.rentalsLoading = true;
      return dispatch('rentalList', { shopId: sid }).then(function (d) {
        var rows = d && Array.isArray(d.bookings) ? d.bookings : null;
        S.rentals = rows ? { rows: rows, capped: rows.length >= RENTAL_LIST_CAP, err: null }
                         : { rows: null, capped: false, err: 'malformed' };
      }, function (e) { S.rentals = { rows: null, capped: false, err: errCode(e) || 'failed', msg: e && e.message ? String(e.message) : null }; })
        .then(function () { S.rentalsLoading = false; paintAll(); });
    }
    function loadApps (S, force) {
      if (!S.uid || isStaff() || typeof c.readApplications !== 'function') return Promise.resolve();
      if (S.appsLoading || (S.apps && !force)) return Promise.resolve();
      S.appsLoading = true;
      return Promise.resolve(c.readApplications()).then(function (rows) {
        rows = (Array.isArray(rows) ? rows : []).filter(function (a) { return a && a.hub === 'construction'; });
        rows.sort(function (a, b) { return (ms(b.createdAt) || 0) - (ms(a.createdAt) || 0); });
        S.apps = { rows: rows, err: null };
      }, function (e) { S.apps = { rows: null, err: errCode(e) || 'read-failed' }; })
        .then(function () { S.appsLoading = false; paintAll(); });
    }
    function loadPlans (S) {
      if (S.plans || S.plansLoading || typeof c.callPlans !== 'function') return Promise.resolve();
      S.plansLoading = true;
      return Promise.resolve(c.callPlans({ hubType: 'construction' })).then(function (d) {
        S.plans = { rows: constructionPlans(d && d.plans), err: null };
      }, function (e) { S.plans = { rows: null, err: errCode(e) || 'failed' }; })
        .then(function () { S.plansLoading = false; paintAll(); });
    }
    function ensure (force) {
      var S = store(uid());
      if (view === 'overview') { loadLeads(S, force); loadRentals(S, force); loadEquip(S, force); loadPlans(S); }
      if (view === 'leads') loadLeads(S, force);
      if (view === 'equipment' || view === 'availability') { loadEquip(S, force); loadRentals(S, force); }
      if (view === 'rentals') loadRentals(S, force);
      if (view === 'verification') loadApps(S, force);
    }

    /* ── shared fragments ── */
    function head (title, sub) { return '<h2>' + esc(title) + '</h2>' + (sub ? '<p class="cw-sub">' + esc(sub) + '</p>' : ''); }
    function note (n) { return n ? '<div class="cw-note' + (n.kind ? ' ' + n.kind : '') + '" role="status">' + esc(n.text) + '</div>' : ''; }
    function goBtn (route, label, pri) {
      return '<button type="button" class="cw-btn' + (pri ? ' pri' : '') + '" data-go-route="' + esc(route) + '">' + esc(label) + '</button>';
    }
    function loadingCard () { return '<div class="cw-card cw-meta">Loading…</div>'; }
    function tile (value, label) { return '<div class="cw-tile"><b>' + esc(value) + '</b><small>' + esc(label) + '</small></div>'; }
    function signedOut () { return '<div class="cw-card"><b>Not signed in on this device</b><div class="cw-meta">This workspace loads once you are signed in.</div></div>'; }
    function commercialCard (S) {
      var p = S.plans, planLine;
      if (!p) planLine = 'Construction plans: —';
      else if (p.err || !p.rows.length) planLine = 'Construction plans: — (SOKONI has not priced a construction plan)';
      else planLine = 'Construction plans: ' + p.rows.map(function (x) { return (x.name || x.id || 'Plan') + ' ' + fmtKes(x.price.monthly) + '/month'; }).join(' · ');
      return '<div class="cw-card"><b>Fees</b>' +
        '<div class="cw-meta">Owner-set terms, applied by SOKONI’s commission release (not yet live): building materials sold through SOKONI — the marketplace commission (15%); construction services — 0%; equipment rental — 10% of the hire, never the deposit.</div>' +
        '<div class="cw-meta">Featured listings, lead fees and construction plans are not priced and are switched OFF. Nothing is charged for them.</div>' +
        '<div class="cw-meta">' + esc(planLine) + '</div>' +
        '<div class="cw-acts">' + goBtn(REUSED.subscription, 'Open Plan') + '</div></div>';
    }

    /* ── OVERVIEW ── */
    function vOverview (S) {
      var lc = leadCounts(S.leads), rc = rentalCounts(S.rentals), ec = equipmentCount(S.equip);
      var h = head('Construction', 'Contractor, materials supplier and equipment rental — in one workspace.');
      h += '<div class="cw-tiles">' +
        tile(isStaff() ? '—' : fmtCount(lc.fresh, lc.partial), 'New leads') +
        tile(isStaff() ? '—' : fmtCount(lc.open, lc.partial), 'Open leads') +
        tile(fmtCount(rc.pending, rc.partial), 'Rental requests awaiting you') +
        tile(fmtCount(ec.n, ec.partial), 'Equipment listed') + '</div>';
      if (lc.partial || rc.partial || ec.partial) h += note({ kind: 'warn', text: 'Some lists hit their limit, so the counts marked + are at least that many.' });
      h += '<div class="cw-note">SOKONI does not yet tell this workspace whether your business is a contractor, a supplier or an equipment-rental company, so all three layouts are shown. It is never guessed from a category.</div>';
      LAYOUTS.forEach(function (L) {
        h += '<h3>' + esc(L.label) + '</h3><div class="cw-secs">' + L.sections.filter(function (s) { return s[1] !== 'overview'; }).map(function (s) {
          return goBtn(routeFor(s[1]), s[0]);
        }).join('') + '</div>';
      });
      h += '<h3>Fees</h3>' + commercialCard(S);
      return h;
    }

    /* ── LEADS ── */
    function leadCard (S, r) {
      var st = leadStatus(r), acts = leadActions(r), n = S.leadNotes[r.id];
      var chat = chatAvailable(c.window);
      return '<div class="cw-card" data-lead="' + esc(r.id) + '">' +
        '<div class="cw-row"><b>' + esc(r.productName || 'Product') + '</b><span class="cw-badge">' + esc(leadLabel(st)) + '</span></div>' +
        '<div class="cw-meta">' + esc(r.buyerName || '—') + (r.buyerPhone ? ' · ' + esc(r.buyerPhone) : '') + ' · ' + esc(fmtDate(r.createdAt)) + '</div>' +
        (r.message ? '<div class="cw-msg">' + esc(r.message) + '</div>' : '<div class="cw-meta">No message</div>') +
        '<div class="cw-acts">' +
          acts.map(function (to) {
            return '<button type="button" class="cw-btn' + (to === 'lost' ? ' dan' : (to === 'won' ? ' pri' : '')) + '" data-act="lead-move" data-id="' + esc(r.id) + '" data-to="' + esc(to) + '">' + esc(leadLabel(to)) + '</button>';
          }).join('') +
          (chat ? '<button type="button" class="cw-btn" data-act="lead-chat" data-id="' + esc(r.id) + '">Open chat</button>'
                : '<button type="button" class="cw-btn" disabled aria-disabled="true">Chat coming</button>') +
        '</div>' +
        '<label class="cw-meta" style="display:grid;gap:4px;margin-top:8px">Private note (only you see it)' +
          '<textarea rows="2" maxlength="' + NOTE_MAX + '" data-note="' + esc(r.id) + '">' + esc(r.sellerNote || '') + '</textarea></label>' +
        '<div class="cw-acts"><button type="button" class="cw-btn" data-act="lead-note" data-id="' + esc(r.id) + '">Save note</button></div>' +
        note(n) + '</div>';
    }
    function vLeads (S) {
      var h = head('Leads', 'Buyer enquiries on your products. Move each one along as you work it.');
      if (!S.uid) return h + signedOut();
      if (isStaff()) return h + '<div class="cw-card"><b>Leads go to the shop owner</b><div class="cw-meta">A buyer enquiry is addressed to the owner’s account, so it is not shown to staff. This is not an empty list.</div></div>';
      var L = S.leads;
      if (!L) return h + loadingCard();
      if (L.err) {
        var body = L.err === 'permission-denied'
          ? '<b>This account cannot read these leads</b><div class="cw-meta">The security rules refused the request. That is a permissions result, not an empty list.</div>'
          : '<b>Leads could not be loaded</b><div class="cw-meta">The request failed (' + esc(L.err) + '). Nothing is guessed here.</div>';
        return h + '<div class="cw-card">' + body + '<div class="cw-acts"><button type="button" class="cw-btn" data-act="reload">Try again</button></div></div>';
      }
      if (!L.rows.length) return h + '<div class="cw-card"><b>No leads yet</b><div class="cw-meta">When a buyer contacts you about one of your products, it appears here.</div></div>';
      return h + (L.hasMore ? note({ kind: 'warn', text: 'Showing the first ' + LEADS_LIMIT + ' leads — more exist.' }) : '') +
        L.rows.map(function (r) { return leadCard(S, r); }).join('');
    }
    function findLead (S, id) { return S.leads && S.leads.rows ? S.leads.rows.filter(function (r) { return r.id === id; })[0] || null : null; }
    function writeLead (S, id, payload, done) {
      if (!isId(id)) return Promise.resolve();
      if (typeof c.writeLead !== 'function') { S.leadNotes[id] = { kind: 'err', text: 'Saving leads is not available here.' }; return Promise.resolve(paintAll()); }
      S.leadNotes[id] = { text: 'Saving…' }; paintAll();
      return Promise.resolve(c.writeLead(id, payload)).then(function () {
        var r = findLead(S, id);
        if (r) { if ('status' in payload) r.status = payload.status; if ('sellerNote' in payload) r.sellerNote = payload.sellerNote; }
        S.leadNotes[id] = { text: done };
      }, function (e) { S.leadNotes[id] = { kind: 'err', text: leadErrMsg(e) }; }).then(paintAll);
    }
    function moveLead (S, id, to) {
      var r = findLead(S, id); if (!r) return Promise.resolve();
      var p = leadMovePayload(r, to);
      if (!p) { S.leadNotes[id] = { kind: 'err', text: 'That step is not available from "' + leadLabel(leadStatus(r)) + '".' }; return Promise.resolve(paintAll()); }
      return writeLead(S, id, p, 'Moved to ' + leadLabel(to) + '.');
    }
    function saveNote (S, id) {
      var r = findLead(S, id); if (!r) return Promise.resolve();
      var el = host.querySelector ? host.querySelector('[data-note="' + id + '"]') : null;
      return writeLead(S, id, leadNotePayload(el ? el.value : ''), 'Note saved.');
    }

    /* ── PROJECTS / SERVICES / RFQs / QUOTES — honest entries ── */
    function vProjects () {
      return head('Projects') + '<div class="cw-card"><b>Projects arrive with the SOKONI Work engine</b>' +
        '<div class="cw-meta">Construction projects, milestones and site work will run on SOKONI’s one Work engine, which is not built yet. Nothing is stored here in the meantime.</div></div>';
    }
    function vServices () {
      return head('Services') + '<div class="cw-card"><b>Construction services are not managed here yet</b>' +
        '<div class="cw-meta">Contractor and trade services (building, welding, fabrication, site work) are listed through SOKONI’s provider services, which this workspace cannot open yet. Your approved application decides which services you may offer.</div>' +
        '<div class="cw-acts">' + goBtn(ROUTE_OF.verification, 'Application status') + '</div></div>';
    }
    function rfqReady () {
      try { return typeof c.hasRoute === 'function' && c.hasRoute('rfqs') && typeof c.hasModule === 'function' && c.hasModule('SokoniMerchantRfq'); }
      catch (_) { return false; }
    }
    function vRfqs () {
      if (rfqReady()) return head('RFQs') + '<div class="cw-card"><b>Requests for quotation</b><div class="cw-meta">RFQs you send and receive live in RFQs &amp; Quotes.</div><div class="cw-acts">' + goBtn('rfqs', 'Open RFQs & Quotes', true) + '</div></div>';
      return head('RFQs') + '<div class="cw-card"><b>RFQs arrive with the B2B release</b><div class="cw-meta">Requests for quotation run on SOKONI’s RFQ service, which ships with the B2B release. Nothing is collected here in the meantime.</div>' +
        '<div class="cw-acts"><button type="button" class="cw-btn" disabled aria-disabled="true">RFQs coming</button></div></div>';
    }
    function vQuotes () {
      if (rfqReady()) return head('Quotes') + '<div class="cw-card"><b>Quotes are sent from RFQs &amp; Quotes</b><div class="cw-meta">Open an RFQ you received and send your quotation there — prices and VAT are on your quote, never assumed.</div><div class="cw-acts">' + goBtn('rfqs', 'Open RFQs & Quotes', true) + '</div></div>';
      return head('Quotes') + '<div class="cw-card"><b>Quotes arrive with the B2B release</b><div class="cw-meta">Quotations are answers to RFQs, so they open with the RFQ service. A lead you have quoted outside SOKONI can be marked "Quote Sent" in Leads.</div>' +
        '<div class="cw-acts">' + goBtn(ROUTE_OF.leads, 'Open Leads') + '</div></div>';
    }

    /* ── EQUIPMENT ── */
    function equipKnown (S) {
      var out = [], seen = {};
      function add (id, title) { if (isId(id) && !seen[id]) { seen[id] = 1; out.push({ id: id, title: title || id }); } }
      (S.equip && S.equip.rows || []).forEach(function (e) { add(e.id, e.title); });
      S.created.forEach(function (e) { add(e.id, e.title); });
      (S.rentals && S.rentals.rows || []).forEach(function (b) { add(b.rentalProductId, null); });
      return out;
    }
    function equipListBlock (S) {
      var E = S.equip;
      if (!shopId()) return '<div class="cw-card cw-meta">Your shop is still loading.</div>';
      if (!E) return loadingCard();
      if (E.err === 'permission-denied' && E.source === 'direct') return '<div class="cw-card"><b>' + esc(RULES_COPY) + '</b><div class="cw-meta">Your equipment list cannot be read yet. That is an access result, not an empty list.</div></div>';
      if (E.err) return '<div class="cw-card"><b>Equipment could not be loaded</b><div class="cw-meta">' + esc(E.msg || ('The request failed (' + E.err + ').')) + ' This is not an empty list.</div><div class="cw-acts"><button type="button" class="cw-btn" data-act="reload">Try again</button></div></div>';
      if (!E.rows.length) return '<div class="cw-card"><b>No equipment listed yet</b></div>';
      return (E.hasMore ? note({ kind: 'warn', text: 'Showing the first ' + EQUIP_LIMIT + ' — more exist.' }) : '') + E.rows.map(function (e) {
        var rate = RATE_FIELD[e.pricingType] ? e[RATE_FIELD[e.pricingType]] : null;
        var st = listingStatus(e), ln = S.listingNotes[e.id];
        var acts = (E.source === 'server' ? listingActions(e) : []).map(function (a) {
          return '<button type="button" class="cw-btn' + (a === 'publish' ? ' pri' : '') + '" data-act="listing-' + a + '" data-id="' + esc(e.id) + '">' + (a === 'publish' ? 'Make available' : 'Pause') + '</button>';
        }).join('');
        return '<div class="cw-card"><div class="cw-row"><b>' + esc(e.title || 'Equipment') + '</b><span class="cw-chip">' + esc(LISTING_LABEL[st] || titleCase(st || '—')) + '</span></div>' +
          '<div class="cw-meta">' + esc(titleCase(e.pricingType || '—')) + (typeof rate === 'number' ? ' · ' + esc(fmtKes(rate)) : '') +
          (typeof e.deposit === 'number' && e.deposit > 0 ? ' · deposit ' + esc(fmtKes(e.deposit)) : '') + '</div>' +
          (st === 'draft' || st === 'paused' ? '<div class="cw-meta">Renters cannot book a ' + esc((LISTING_LABEL[st] || st).toLowerCase()) + ' listing.</div>' : '') +
          (acts ? '<div class="cw-acts">' + acts + '</div>' : '') + note(ln) + '</div>';
      }).join('');
    }
    function equipForm () {
      var f = ui.form || {};
      function inp (k, label, type, extra) { return '<label>' + esc(label) + '<input data-f="' + k + '" type="' + (type || 'text') + '" value="' + esc(f[k] || '') + '"' + (extra || '') + '></label>'; }
      return '<div class="cw-card cw-form">' +
        inp('title', 'Equipment name *', 'text', ' maxlength="120"') +
        '<label>Description<textarea data-f="description" rows="2" maxlength="1000">' + esc(f.description || '') + '</textarea></label>' +
        inp('category', 'Category (e.g. excavators, scaffolding)', 'text', ' maxlength="60"') +
        '<label>Charged by *<select data-f="pricingType">' + PRICING_TYPES.map(function (p) { return '<option value="' + p + '"' + (f.pricingType === p ? ' selected' : '') + '>' + esc(titleCase(p)) + '</option>'; }).join('') + '</select></label>' +
        '<div class="cw-two">' + inp('hourlyRate', 'Per hour (KES)', 'number', ' min="0" inputmode="decimal"') + inp('dailyRate', 'Per day (KES)', 'number', ' min="0" inputmode="decimal"') + '</div>' +
        '<div class="cw-two">' + inp('weeklyRate', 'Per week (KES)', 'number', ' min="0" inputmode="decimal"') + inp('monthlyRate', 'Per month (KES)', 'number', ' min="0" inputmode="decimal"') + '</div>' +
        '<div class="cw-two">' + inp('deposit', 'Deposit (KES)', 'number', ' min="0" inputmode="decimal"') + inp('minDuration', 'Minimum hire (units)', 'number', ' min="1"') + '</div>' +
        '<label>Terms<textarea data-f="terms" rows="2" maxlength="1000">' + esc(f.terms || '') + '</textarea></label>' +
        '<div class="cw-meta">SOKONI calculates every hire price from these rates. The listing is saved as a Draft; make it available when you are ready.</div>' +
        '<div class="cw-acts"><button type="button" class="cw-btn pri" data-act="equip-create"' + (ui.busy ? ' disabled' : '') + '>Save listing</button>' +
        '<button type="button" class="cw-btn" data-act="equip-cancel">Cancel</button></div>' + note(ui.formNote) + '</div>';
    }
    function readForm () {
      var f = {};
      var els = host.querySelectorAll ? host.querySelectorAll('[data-f]') : [];
      for (var i = 0; i < els.length; i++) f[els[i].getAttribute('data-f')] = String(els[i].value == null ? '' : els[i].value).trim();
      return f;
    }
    /* Pure: form → rentalProductCreate payload, or {error}. Numbers only; never a price invented. */
    function equipPayload (f, sid) {
      var title = String(f.title || '').trim();
      if (title.length < 2 || title.length > 120) return { error: 'Give the equipment a name (2–120 characters).' };
      if (PRICING_TYPES.indexOf(f.pricingType) < 0) return { error: 'Choose how the equipment is charged.' };
      var p = { shopId: sid, title: title, pricingType: f.pricingType };
      var ok = true, any = false;
      ['hourlyRate', 'dailyRate', 'weeklyRate', 'monthlyRate', 'deposit', 'minDuration'].forEach(function (k) {
        var raw = f[k]; if (raw == null || raw === '') return;
        var n = Number(raw);
        if (!isFinite(n) || n < 0 || (k === 'minDuration' && (n < 1 || Math.floor(n) !== n))) { ok = false; return; }
        p[k] = n; if (/Rate$/.test(k) && n > 0) any = true;
      });
      if (!ok) return { error: 'Rates, deposit and minimum hire must be valid positive numbers.' };
      var need = RATE_FIELD[f.pricingType];
      if (need && !(p[need] > 0)) return { error: 'Enter the ' + titleCase(f.pricingType).toLowerCase() + ' rate.' };
      if (!need && !any) return { error: 'Enter at least one rate.' };
      if (f.description) p.description = String(f.description).slice(0, 1000);
      if (f.category) p.category = String(f.category).slice(0, 60);
      if (f.terms) p.terms = String(f.terms).slice(0, 1000);
      return { payload: p };
    }
    function vEquipment (S) {
      var h = head('Equipment', 'Machines and tools you hire out.');
      if (!S.uid) return h + signedOut();
      h += ui.form ? equipForm() : '<div class="cw-acts" style="margin:10px 0">' + (shopId() ? '<button type="button" class="cw-btn pri" data-act="equip-new">List equipment</button>' : '') + goBtn(ROUTE_OF.availability, 'Availability') + goBtn(ROUTE_OF.rentals, 'Rentals') + '</div>';
      if (S.created.length) h += '<div class="cw-card"><b>Listed in this session</b><div class="cw-meta">' + S.created.map(function (e) { return esc(e.title); }).join(' · ') + '</div><div class="cw-meta">Saved as a Draft. Renters cannot book it until you make it available.</div></div>';
      return h + equipListBlock(S);
    }
    function createEquip (S) {
      if (ui.busy) return Promise.resolve();
      var sid = shopId();
      var r = equipPayload(readForm(), sid);
      ui.form = readForm();
      if (!sid) r = { error: 'Your shop is still loading.' };
      if (r.error) { ui.formNote = { kind: 'err', text: r.error }; return Promise.resolve(paintAll()); }
      ui.busy = true; ui.formNote = { text: 'Saving…' }; paintAll();
      return dispatch('rentalProductCreate', r.payload).then(function (d) {
        var id = d && d.rentalProductId;
        if (isId(id)) S.created.push({ id: id, title: r.payload.title });
        ui.form = null; ui.formNote = null;
        if (typeof c.onToast === 'function') c.onToast('Saved as a draft.');
        return loadEquip(S, true);
      }, function (e) { ui.formNote = { kind: 'err', text: errMsg(e) }; })
        .then(function () { ui.busy = false; paintAll(); });
    }

    function listingOp (S, kind, id) {
      var e = (S.equip && S.equip.rows || []).filter(function (x) { return x.id === id; })[0];
      if (!e || listingActions(e).indexOf(kind) < 0) return Promise.resolve();
      S.listingNotes[id] = { text: 'Working…' }; paintAll();
      return dispatch(kind === 'publish' ? 'rentalProductPublish' : 'rentalProductPause', { rentalProductId: id, shopId: shopId() }).then(function () {
        S.listingNotes[id] = { text: kind === 'publish' ? 'Available to renters.' : 'Paused. Renters cannot book it.' };
        return loadEquip(S, true);
      }, function (err) { S.listingNotes[id] = { kind: 'err', text: errMsg(err) }; }).then(paintAll);
    }

    /* ── AVAILABILITY ── */
    function vAvailability (S) {
      var h = head('Availability', 'Dates each item is already requested or on hire.');
      if (!S.uid) return h + signedOut();
      var known = equipKnown(S);
      if (!known.length) {
        var why = (S.equip && S.equip.err === 'permission-denied' && S.equip.source === 'direct') ? RULES_COPY + ' Items you list in this session appear here.' : 'No equipment to show yet.';
        return h + '<div class="cw-card"><b>' + esc(why) + '</b></div>';
      }
      h += '<div class="cw-card cw-form"><label>Equipment<select data-pick="1"><option value="">Choose…</option>' +
        known.map(function (e) { return '<option value="' + esc(e.id) + '"' + (ui.pick === e.id ? ' selected' : '') + '>' + esc(e.title) + '</option>'; }).join('') +
        '</select></label></div>';
      var a = ui.pick ? S.avail[ui.pick] : null;
      if (!ui.pick) return h;
      if (!a || a.loading) return h + loadingCard();
      if (a.err) return h + '<div class="cw-card"><b>Availability could not be loaded</b><div class="cw-meta">' + esc(a.err) + '</div></div>';
      if (!a.periods.length) return h + '<div class="cw-card"><b>No requested or confirmed hire on record</b><div class="cw-meta">SOKONI checks the most recent 200 bookings of this item.</div></div>';
      return h + '<div class="cw-card"><b>Taken periods</b>' + a.periods.map(function (p) {
        return '<div class="cw-meta">' + esc(fmtDate(p.start)) + ' → ' + esc(fmtDate(p.end)) + '</div>';
      }).join('') + '<div class="cw-meta">SOKONI checks the most recent 200 bookings of this item.</div></div>';
    }
    function loadAvail (S, id) {
      if (!isId(id)) return Promise.resolve();
      S.avail[id] = { loading: true }; paintAll();
      return dispatch('rentalGetAvailability', { rentalProductId: id }).then(function (d) {
        S.avail[id] = { periods: d && Array.isArray(d.unavailablePeriods) ? d.unavailablePeriods : [] };
      }, function (e) { S.avail[id] = { err: errMsg(e) }; }).then(paintAll);
    }

    /* ── RENTALS ── */
    function rentalCard (S, b) {
      var acts = rentalActions(b), n = S.rentalNotes[b.id], pay = paymentText(b);
      var btns = acts.map(function (a) {
        if (a === 'cancel') {
          return ui.cancelAsk === b.id
            ? '<button type="button" class="cw-btn dan" data-act="rental-cancel" data-id="' + esc(b.id) + '">Confirm cancel</button><button type="button" class="cw-btn" data-act="rental-ask-no">Keep</button>'
            : '<button type="button" class="cw-btn dan" data-act="rental-cancel-ask" data-id="' + esc(b.id) + '">Cancel</button>';
        }
        if (a === 'decline') {
          return ui.declineAsk === b.id ? '' : '<button type="button" class="cw-btn dan" data-act="rental-decline-ask" data-id="' + esc(b.id) + '">Decline</button>';
        }
        return '<button type="button" class="cw-btn' + (a === 'accept' || a === 'complete' ? ' pri' : '') + '" data-act="rental-' + a + '" data-id="' + esc(b.id) + '">' + esc(RENTAL_BTN[a]) + '</button>';
      }).join('');
      var decline = ui.declineAsk === b.id
        ? '<label class="cw-meta" style="display:grid;gap:4px;margin-top:8px">Reason for declining (the renter sees it) *' +
          '<textarea rows="2" maxlength="500" data-decline-reason="' + esc(b.id) + '"></textarea></label>' +
          '<div class="cw-acts"><button type="button" class="cw-btn dan" data-act="rental-decline" data-id="' + esc(b.id) + '">Confirm decline</button>' +
          '<button type="button" class="cw-btn" data-act="rental-ask-no">Keep</button></div>'
        : '';
      return '<div class="cw-card"><div class="cw-row"><b>' + esc(b.customerName || 'Customer') + '</b><span class="cw-badge">' + esc(rentalLabel(b)) + '</span></div>' +
        '<div class="cw-meta">' + esc(fmtDate(b.startDate)) + ' → ' + esc(fmtDate(b.endDate)) + ' · ' + esc(titleCase(b.durationUnit || '—')) + '</div>' +
        '<div class="cw-meta">Hire price calculated by SOKONI: ' + esc(fmtKes(b.totalAmount)) + (typeof b.depositAmount === 'number' && b.depositAmount > 0 ? ' · deposit ' + esc(fmtKes(b.depositAmount)) : '') + '.</div>' +
        (pay ? '<div class="cw-meta">Payment: ' + esc(pay) + '</div>' : '') +
        '<div class="cw-meta">Payment method: ' + esc(paymentMethodText(b)) + '</div>' +
        (b.notes ? '<div class="cw-msg">' + esc(b.notes) + '</div>' : '') +
        (btns ? '<div class="cw-acts">' + btns + '</div>' : '') + decline + note(n) + '</div>';
    }
    function vRentals (S) {
      var h = head('Rentals', 'Hire requests for your equipment.');
      if (!S.uid) return h + signedOut();
      h += '<div class="cw-note">' + esc(RENTAL_FLOW_COPY) + '</div>';
      if (!shopId()) return h + '<div class="cw-card cw-meta">Your shop is still loading.</div>';
      var R = S.rentals;
      if (!R) return h + loadingCard();
      if (R.err) {
        var body = '<b>Rental requests could not be loaded</b><div class="cw-meta">' + esc(R.msg || R.err) + ' This is not an empty list.</div>';
        return h + '<div class="cw-card">' + body + '<div class="cw-acts"><button type="button" class="cw-btn" data-act="reload">Try again</button></div></div>';
      }
      if (!R.rows.length) return h + '<div class="cw-card"><b>No rental requests yet</b></div>';
      return h + (R.capped ? note({ kind: 'warn', text: 'Showing ' + R.rows.length + ' requests — more may exist.' }) : '') +
        R.rows.map(function (b) { return rentalCard(S, b); }).join('');
    }
    function rentalOp (S, kind, id) {
      var b = (S.rentals && S.rentals.rows || []).filter(function (x) { return x.id === id; })[0];
      if (!b || rentalActions(b).indexOf(kind) < 0) return Promise.resolve();
      var payload = kind === 'cancel' ? { bookingId: id } : { bookingId: id, shopId: shopId() };
      if (kind === 'decline') {
        var el = host.querySelector ? host.querySelector('[data-decline-reason="' + id + '"]') : null;
        var reason = el ? String(el.value || '').trim() : '';
        if (!reason) { S.rentalNotes[id] = { kind: 'err', text: 'Give the renter a reason before declining.' }; return Promise.resolve(paintAll()); }
        payload.reason = reason.slice(0, 500);
      }
      ui.cancelAsk = null; ui.declineAsk = null;
      S.rentalNotes[id] = { text: 'Working…' }; paintAll();
      var run = dispatch(RENTAL_OP[kind], payload);
      /* rentalAccept is new in bb8634d; an older server knows only its alias rentalConfirm. */
      if (kind === 'accept') run = run.catch(function (e) { if (isUnknownOp(e)) return dispatch('rentalConfirm', payload); throw e; });
      return run.then(function () {
        S.rentalNotes[id] = { text: RENTAL_DONE[kind] };
        return loadRentals(S, true);
      }, function (e) { S.rentalNotes[id] = { kind: 'err', text: errMsg(e) }; }).then(paintAll);
    }

    /* ── VERIFICATION ── */
    function vVerification (S) {
      var h = head('Verification', 'Your Construction application, as SOKONI recorded it.');
      if (!S.uid) return h + signedOut();
      if (isStaff()) return h + '<div class="cw-card"><b>Applications belong to the owner’s account</b><div class="cw-meta">Not shown to staff. This is not an empty list.</div></div>';
      var A = S.apps;
      if (!A) return h + loadingCard();
      if (A.err) return h + '<div class="cw-card"><b>Your application could not be loaded</b><div class="cw-meta">The request failed (' + esc(A.err) + '). Nothing is guessed here.</div><div class="cw-acts"><button type="button" class="cw-btn" data-act="reload">Try again</button></div></div>';
      if (!A.rows.length) return h + '<div class="cw-card"><b>No Construction application on this account</b><div class="cw-meta">Apply through SOKONI registration (Construction). SOKONI reviews each trade separately.</div></div>';
      return h + A.rows.map(function (a) {
        return '<div class="cw-card"><div class="cw-row"><b>' + esc(a.categoryLabel || a.category || 'Construction') + '</b><span class="cw-chip">' + esc(appLabel(a)) + '</span>' +
          (isVerified(a) ? '<span class="cw-badge">✓ Verified</span>' : '') + '</div>' +
          '<div class="cw-meta">Submitted ' + esc(fmtDate(a.createdAt || a.submittedAt)) + '</div>' +
          (a.reviewReason ? '<div class="cw-msg">' + esc(a.reviewReason) + '</div>' : '') + '</div>';
      }).join('') + '<div class="cw-meta">The decision is SOKONI’s; this page only shows it. Registration numbers (NCA / EBK / BORAQS) are checked by SOKONI, not by this page.</div>' +
        '<div class="cw-acts">' + goBtn('verification', 'Identity checks') + '</div>';
    }

    /* ── render ── */
    function render () {
      if (dead) return;
      var S = store(uid());
      var body;
      switch (view) {
        case 'leads': body = vLeads(S); break;
        case 'projects': body = vProjects(); break;
        case 'rfqs': body = vRfqs(); break;
        case 'quotes': body = vQuotes(); break;
        case 'services': body = vServices(); break;
        case 'equipment': body = vEquipment(S); break;
        case 'availability': body = vAvailability(S); break;
        case 'rentals': body = vRentals(S); break;
        case 'verification': body = vVerification(S); break;
        default: body = vOverview(S);
      }
      host.innerHTML = '<div class="cw">' + body + '</div>';
    }
    function onClick (e) {
      var t = e && e.target; if (!t || typeof t.closest !== 'function') return;
      var S = store(uid());
      var gr = t.closest('[data-go-route]');
      if (gr) { if (typeof c.go === 'function') c.go(gr.getAttribute('data-go-route')); return; }
      var b = t.closest('[data-act]'); if (!b || b.disabled) return;
      var act = b.getAttribute('data-act'), id = b.getAttribute('data-id');
      switch (act) {
        case 'lead-move': return moveLead(S, id, b.getAttribute('data-to'));
        case 'lead-note': return saveNote(S, id);
        case 'lead-chat':
          if (chatAvailable(c.window) && isId(id)) (c.window || global).SokoniInbox.openForTransaction(LEAD_TX, id);
          return;
        case 'equip-new': ui.form = {}; ui.formNote = null; return render();
        case 'equip-cancel': ui.form = null; ui.formNote = null; return render();
        case 'equip-create': return createEquip(S);
        case 'rental-accept': return rentalOp(S, 'accept', id);
        case 'rental-start': return rentalOp(S, 'start', id);
        case 'rental-confirm-return': return rentalOp(S, 'confirm-return', id);
        case 'rental-complete': return rentalOp(S, 'complete', id);
        case 'rental-decline-ask': ui.declineAsk = id; ui.cancelAsk = null; return render();
        case 'rental-decline': return rentalOp(S, 'decline', id);
        case 'rental-cancel-ask': ui.cancelAsk = id; ui.declineAsk = null; return render();
        case 'rental-ask-no': ui.cancelAsk = null; ui.declineAsk = null; return render();
        case 'rental-cancel': return rentalOp(S, 'cancel', id);
        case 'listing-publish': return listingOp(S, 'publish', id);
        case 'listing-pause': return listingOp(S, 'pause', id);
        case 'reload': ensure(true); return render();
      }
    }
    function onChange (e) {
      var t = e && e.target; if (!t || !t.getAttribute) return;
      if (t.getAttribute('data-pick')) { ui.pick = isId(t.value) ? t.value : ''; if (ui.pick) loadAvail(store(uid()), ui.pick); render(); }
    }
    host.addEventListener('click', onClick);
    host.addEventListener('change', onChange);
    SUBS.push(render);
    ensure(false);
    render();
    return {
      view: view,
      refresh: function () { ensure(false); render(); },
      destroy: function () {
        dead = true;
        var i = SUBS.indexOf(render); if (i >= 0) SUBS.splice(i, 1);
        try { host.removeEventListener('click', onClick); host.removeEventListener('change', onChange); } catch (_) {}
      },
      _act: { moveLead: function (id, to) { return moveLead(store(uid()), id, to); },
              saveNote: function (id) { return saveNote(store(uid()), id); },
              createEquip: function () { return createEquip(store(uid())); },
              rentalOp: function (k, id) { return rentalOp(store(uid()), k, id); },
              loadAvail: function (id) { ui.pick = id; return loadAvail(store(uid()), id); },
              ui: ui, render: render }
    };
  }

  global.SokoniMerchantConstruction = {
    mount: mount, VIEWS: VIEWS, ROUTE_OF: ROUTE_OF, REUSED: REUSED, LAYOUTS: LAYOUTS,
    SERVER_TIME: SERVER_TIME, LEAD_KEYS: LEAD_KEYS.slice(), LEAD_TX: LEAD_TX,
    _reset: function () { STORE = null; SUBS.length = 0; },
    _pure: { leadActions: leadActions, leadLabel: leadLabel, leadMovePayload: leadMovePayload, leadNotePayload: leadNotePayload,
             chatAvailable: chatAvailable, rentalActions: rentalActions, leadCounts: leadCounts, rentalCounts: rentalCounts,
             equipmentCount: equipmentCount, constructionPlans: constructionPlans, fmtCount: fmtCount, appLabel: appLabel,
             isVerified: isVerified, esc: esc, LEAD_NEXT: LEAD_NEXT, LEAD_TERMINAL: LEAD_TERMINAL, routeFor: routeFor,
             RULES_COPY: RULES_COPY, RENTAL_FLOW_COPY: RENTAL_FLOW_COPY, isUnknownOp: isUnknownOp, paymentText: paymentText,
             paymentMethodText: paymentMethodText, rentalStatus: rentalStatus, rentalLabel: rentalLabel, listingActions: listingActions,
             errMsg: errMsg, RENTAL_NEXT: RENTAL_NEXT, RENTAL_OP: RENTAL_OP }
  };
})(typeof window !== 'undefined' ? window : globalThis);
