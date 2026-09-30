/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI MERCHANT — WALLET (native, inside the Payments destination)
   ══════════════════════════════════════════════════════════════════════════════
   The Wallet backend was NOT built for this surface. It already existed, it is
   deployed, its money paths are proven, and it carries the freeze tag
   `wallet-backend-v1.0-frozen` (20163a1, an ancestor of HEAD). See
   docs/WALLET_PAYMENTS_AUDIT.md — 21/0.

   So this file is a SURFACE and nothing else. It moves no money, computes no
   balance, and holds no authority. Every number it shows was written by a Cloud
   Function; every refusal it shows is the server's own sentence.

   ── WHERE EACH FIGURE COMES FROM ────────────────────────────────────────────
       available balance   wallets/{uid}.balance          SHILLINGS, canonical
       being withdrawn     wallets/{uid}.pendingPayout    SHILLINGS, reserved
       ledger              walletTransactions  uid == me
       withdrawals         payoutRequests      sellerUid == me

   All four are read DIRECTLY from Firestore, owner-scoped in the query, exactly
   as Orders, Payments and Flash Sales already read. Two reasons, and the second
   is the load-bearing one:

     1. it is the same document the callable returns — `getWalletBalance` is a
        thin wrapper that returns `data.balance ?? 0` and computes nothing;
     2. `getWalletBalance` and `getPayoutHistory` are BLOCKED AT CLOUD RUN today.
        Measured 2026-08-20 by unauthenticated probe: both answer 403 with an
        HTML body, which means Cloud Run rejects the request before the function
        runs (roles/run.invoker not granted to allUsers). A browser cannot reach
        them at all, and the Firebase SDK surfaces that as a bare "internal".
        Building the balance on them would have produced a surface that fails
        100% of the time in production. See scripts/probe-wallet-callables.js.

   The served ruleset authorises every one of these reads to the owner:
       wallets/{uid}          read if request.auth.uid == uid
       walletTransactions     read if resource.data.uid == request.auth.uid
       payoutRequests         read if resource.data.sellerUid == request.auth.uid

   ── WHAT IT CALLS, AND WHY ONLY THESE ───────────────────────────────────────
   Money only ever moves through a callable. The three used here were probed and
   are reachable from a browser:

       initiateWalletTopUp    reachable   starts the M-Pesa STK push
       confirmWalletTopUp     reachable   asks the server whether it completed
       requestSellerPayout    reachable   submits a withdrawal REQUEST

   `spendFromWallet` is deliberately NOT wired. It is reachable-blocked at Cloud
   Run, but that is not the reason — the reason is that it takes an `orderId` and
   only DEBITS. It credits no one. A free-form "Pay from Wallet" button in a
   merchant workspace would let a merchant destroy their own money against an
   arbitrary id. The real merchant spend path is a subscription payment, which
   has its own authority (`payIntentWithWallet`) on the Plan surface. Reported,
   not improvised.

   ── THE FOUR STATES THIS SURFACE MUST NEVER BLUR ────────────────────────────
   Auto-B2C is OFF: `PAYOUT_CONFIG_DEFAULTS.autoB2C === false`, opt-in only via
   `config/payouts`. A withdrawal is therefore a REQUEST that an admin processes,
   and the server labels even the approved state "manual disbursement (auto-B2C
   off)". So:

       PENDING    pending · scheduled · approving · approved · processing ·
                  retry_scheduled · approval_failed · outcome_unknown
       COMPLETED  paid · settled_manually
       FAILED     failed · rejected
       REVERSED   reversed        ← its own state, never folded into COMPLETED

   `approved` sits under PENDING on purpose. It is the exact word that would
   tempt a surface into saying "sent", and with auto-B2C off no money has moved.

   Contract: mount(host, ctx) -> { refresh, destroy }
   ══════════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SokoniMerchantWallet = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var CSS_ID = 'sokoni-merchant-wallet-css';
  /* Scoped by CLASS, never by host id — the shell names panels one way and
     merchant.html another, and this surface mounts inside the Payments panel
     rather than owning a panel of its own. */
  var HOST_CLASS = 'sk-mwal';

  var CSS = [
    '.sk-mwal{padding:2px 0 20px}',
    '.wa-card{background:var(--card,#0e0e0e);border:1px solid var(--line,rgba(255,255,255,.12));',
    'border-radius:16px;padding:16px 15px;margin-bottom:12px}',
    '.wa-lab{font-size:11.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--txt2,rgba(255,255,255,.5))}',
    '.wa-bal{font-size:32px;font-weight:800;letter-spacing:-.02em;margin-top:6px;line-height:1.1}',
    '.wa-cur{font-size:15px;font-weight:700;opacity:.6;margin-right:4px}',
    '.wa-sub{font-size:12.5px;color:var(--txt2,rgba(255,255,255,.55));margin-top:8px;line-height:1.6}',
    /* The five figures, and the three streams. Both are LISTS of one fact per row rather
       than a dashboard of tiles: a merchant reads down them, and a grid of equal boxes makes
       the important number no easier to find than the rest. */
    '.wa-fig{margin-top:12px;border-top:1px solid var(--line,rgba(255,255,255,.10));padding-top:4px}',
    '.wa-fig-r{display:flex;align-items:center;justify-content:space-between;gap:10px;',
    'padding:7px 0;font-size:12.5px;border-bottom:1px solid rgba(255,255,255,.05)}',
    '.wa-fig-r:last-child{border-bottom:0}',
    '.wa-fig-r span{color:var(--txt2,rgba(255,255,255,.6))}',
    '.wa-fig-r b{font-weight:800;white-space:nowrap}',
    '.wa-chan{margin-top:12px;border-top:1px solid var(--line,rgba(255,255,255,.10));padding-top:4px}',
    '.wa-chan-r{display:flex;align-items:center;justify-content:space-between;gap:10px;',
    'padding:9px 0;border-bottom:1px solid rgba(255,255,255,.05)}',
    '.wa-chan-r--tot{border-bottom:0;border-top:1px solid var(--line,rgba(255,255,255,.14));',
    'margin-top:2px;padding-top:11px}',
    '.wa-chan-n{font-size:12.5px;font-weight:700;min-width:0}',
    '.wa-chan-v{text-align:right;min-width:0}',
    '.wa-chan-v b{display:block;font-size:14px;font-weight:800;white-space:nowrap}',
    '.wa-chan-v small{display:block;font-size:10.5px;color:var(--txt2,rgba(255,255,255,.45));',
    'margin-top:2px;white-space:nowrap}',
    /* `.wa-split` — a two-column grid for "online vs shop" — is gone with the markup it
       styled. That split was the earlier two-stream model; POS and Till are now told apart,
       so the breakdown is three rows and a total rather than two boxes. */
    '.wa-res{display:flex;align-items:center;gap:8px;margin-top:12px;padding-top:12px;',
    'border-top:1px solid var(--line,rgba(255,255,255,.1));font-size:13px}',
    '.wa-res b{font-weight:700}',
    '.wa-acts{display:flex;gap:9px;margin:14px 0 18px;flex-wrap:wrap}',
    '.wa-btn{flex:1 1 140px;min-height:46px;border-radius:13px;border:1px solid var(--line,rgba(255,255,255,.14));',
    'background:var(--card,#0e0e0e);color:inherit;font:inherit;font-size:14.5px;font-weight:700;cursor:pointer}',
    '.wa-btn.pri{background:var(--brand,#71ff00);border-color:var(--brand,#71ff00);color:#050505}',
    '.wa-btn:disabled{opacity:.45;cursor:not-allowed}',
    '.wa-segs{display:flex;gap:6px;overflow-x:auto;margin-bottom:12px;padding-bottom:2px}',
    '.wa-segs::-webkit-scrollbar{display:none}',
    /* 40px, not 36. Measured in Chromium at both viewports: at 36 these were the
       only controls on the surface a thumb could miss. */
    '.wa-seg{flex:0 0 auto;min-height:40px;padding:0 14px;border-radius:11px;font:inherit;font-size:13px;',
    'font-weight:600;cursor:pointer;background:var(--card,#0e0e0e);color:inherit;',
    'border:1px solid var(--line,rgba(255,255,255,.12))}',
    '.wa-seg.on{background:var(--brand,#71ff00);border-color:var(--brand,#71ff00);color:#050505}',
    '.wa-list{display:flex;flex-direction:column;gap:9px}',
    '.wa-row{display:flex;align-items:center;gap:12px;padding:12px 13px;border-radius:13px;min-width:0;',
    'background:var(--card,#0e0e0e);border:1px solid var(--line,rgba(255,255,255,.12))}',
    '.wa-i{flex:1;min-width:0}',
    '.wa-t{font-size:13.5px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.wa-m{font-size:11.5px;color:var(--txt2,rgba(255,255,255,.5));margin-top:3px}',
    '.wa-amt{font-size:14px;font-weight:800;white-space:nowrap}',
    '.wa-amt.in{color:var(--brand,#71ff00)}',
    '.wa-badge{display:inline-block;font-size:10.5px;font-weight:700;padding:3px 8px;border-radius:999px;',
    'border:1px solid var(--line,rgba(255,255,255,.16));margin-top:5px}',
    '.wa-badge.pend{border-color:rgba(255,196,0,.45);color:#ffc400}',
    '.wa-badge.done{border-color:rgba(113,255,0,.45);color:var(--brand,#71ff00)}',
    '.wa-badge.bad{border-color:rgba(255,86,86,.45);color:#ff5656}',
    '.wa-badge.rev{border-color:rgba(160,160,255,.45);color:#a0a0ff}',
    '.wa-state{text-align:center;padding:34px 18px;border-radius:14px;',
    'background:var(--card,#0e0e0e);border:1px solid var(--line,rgba(255,255,255,.1))}',
    '.wa-state .ico{font-size:26px;display:block;margin-bottom:8px}',
    '.wa-state b{display:block;font-size:14.5px;margin-bottom:5px}',
    '.wa-state small{display:block;font-size:12.5px;color:var(--txt2,rgba(255,255,255,.55));line-height:1.65}',
    '.wa-sk{height:58px;border-radius:13px;background:var(--card,#0e0e0e);',
    'border:1px solid var(--line,rgba(255,255,255,.08));animation:wa-p 1.2s ease-in-out infinite}',
    '@keyframes wa-p{0%,100%{opacity:.45}50%{opacity:.85}}',
    '.wa-form{display:flex;flex-direction:column;gap:11px;margin-top:2px}',
    '.wa-f{display:flex;flex-direction:column;gap:5px}',
    '.wa-f label{font-size:12px;font-weight:600;color:var(--txt2,rgba(255,255,255,.6))}',
    '.wa-f input{min-height:46px;border-radius:12px;padding:0 14px;font:inherit;font-size:16px;',
    'background:var(--bg,#050505);border:1px solid var(--line,rgba(255,255,255,.14));color:inherit}',
    '.wa-dest{display:flex;flex-direction:column;gap:7px}',
    '.wa-d{display:flex;align-items:flex-start;gap:10px;padding:11px 12px;border-radius:12px;cursor:pointer;',
    'background:var(--bg,#050505);border:1px solid var(--line,rgba(255,255,255,.12))}',
    '.wa-d.on{border-color:var(--brand,#71ff00)}',
    '.wa-d.off{opacity:.5;cursor:not-allowed}',
    '.wa-d input{margin-top:3px;flex:0 0 auto}',
    '.wa-d .dn{font-size:13.5px;font-weight:700}',
    '.wa-d .dd{font-size:11.5px;color:var(--txt2,rgba(255,255,255,.5));margin-top:2px;line-height:1.5}',
    '.wa-err{font-size:12.5px;color:#ff5656;line-height:1.6}',
    '.wa-note{font-size:12px;color:var(--txt2,rgba(255,255,255,.5));line-height:1.7;margin-top:16px}',
    '.wa-note code{font-size:11px;opacity:.85}',
    '.wa-srv{font-size:13px;line-height:1.65;padding:12px 13px;border-radius:12px;margin-top:2px;',
    'background:var(--bg,#050505);border:1px solid var(--line,rgba(255,255,255,.14))}',
  ].join('');

  function css () {
    if (typeof document === 'undefined' || document.getElementById(CSS_ID)) return;
    var s = document.createElement('style');
    s.id = CSS_ID; s.textContent = CSS;
    document.head.appendChild(s);
  }

  function esc (v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* An unknown amount is `—`. Number(null) is 0, and `isFinite(null)` is TRUE,
     so a bare isFinite() check renders an unknown balance as KES 0 — the exact
     fabricated-figure defect this programme has now found six times. */
  function money (n) {
    if (n === null || n === undefined || n === '') return null;
    var v = Number(n);
    if (!isFinite(v)) return null;
    return 'KES ' + v.toLocaleString('en-KE', { maximumFractionDigits: 0 });
  }

  function ts (v) {
    if (!v) return null;
    if (typeof v.toDate === 'function') { try { return v.toDate(); } catch (_) { return null; } }
    if (v instanceof Date) return v;
    if (typeof v === 'object' && typeof v.seconds === 'number') return new Date(v.seconds * 1000);
    if (typeof v === 'number') return new Date(v);
    return null;
  }

  function when (d) {
    if (!d) return '';
    var s = Math.floor((Date.now() - d.getTime()) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    if (s < 604800) return Math.floor(s / 86400) + 'd ago';
    return d.toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  /* ── THE WITHDRAWAL STATE MAP ─────────────────────────────────────────────
     Copied from the statuses functions/wallet.js actually writes, not from what
     a withdrawal "should" have. `approved` is PENDING, deliberately: with
     auto-B2C off, an approved payout is one an admin has agreed to send by hand
     and no money has moved. Anything unrecognised is PENDING too — an unknown
     state must never be optimistically drawn as money received. */
  var PAYOUT_STATE = {
    pending: 'pending', scheduled: 'pending', approving: 'pending',
    approved: 'pending', processing: 'pending', retry_scheduled: 'pending',
    outcome_unknown: 'pending',
    approval_failed: 'pending',
    owner_confirmed: 'pending',                  /* Secure Release: the owner released it; not paid yet */
    cancelled: 'failed', expired: 'failed',      /* funds returned to the wallet */
    paid: 'completed', settled_manually: 'completed',
    failed: 'failed', rejected: 'failed',
    reversed: 'reversed',
  };
  function payoutState (s) { return PAYOUT_STATE[String(s || '').toLowerCase()] || 'pending'; }

  var STATE_LABEL = {
    pending: 'Pending', completed: 'Completed', failed: 'Failed', reversed: 'Reversed',
  };
  var STATE_CLASS = {
    pending: 'pend', completed: 'done', failed: 'bad', reversed: 'rev',
  };

  /* Human wording for the raw server status. The server's own `message` is
     preferred wherever we have one — this table is only for a stored record
     being listed after the fact, where no message was kept. */
  var STATUS_WORD = {
    pending: 'Awaiting review',
    scheduled: 'Scheduled',
    approving: 'Being approved',
    approved: 'Approved — awaiting manual disbursement',
    owner_confirmed: 'Released by you — being sent',
    cancelled: 'Cancelled — returned to your wallet',
    expired: 'Approval expired — returned to your wallet',
    processing: 'Being sent',
    retry_scheduled: 'Retrying',
    outcome_unknown: 'Being confirmed with M-PESA — funds held',
    approval_failed: 'Approval failed — under review',
    paid: 'Paid out',
    settled_manually: 'Paid out manually',
    failed: 'Failed — returned to your wallet',
    rejected: 'Rejected — returned to your wallet',
    reversed: 'Reversed',
  };

  /* Masking mirrors getPayoutHistory's server-side `_mask` so a stored request
     reads the same here as it does anywhere else the callable is used. This is
     presentation of the merchant's OWN number, not an authority. */
  function mask (acc) {
    var s = String(acc || '');
    if (s.length < 6) return s;
    var local = s.indexOf('254') === 0 ? '0' + s.slice(3) : s;
    return local.slice(0, 4) + '****' + local.slice(-3);
  }

  /* Server limits, mirrored ONLY to give an early, kind message. Every one of
     them is enforced again by the Cloud Function, which is the authority; if
     these ever drift the server still refuses and its sentence is what shows. */
  var TOPUP_MIN = 10, TOPUP_MAX = 70000, PAYOUT_MIN = 100;

  function mount (host, ctx) {
    css();
    ctx = ctx || {};
    if (host && host.classList) host.classList.add(HOST_CLASS);

    var S = {
      destroyed: false,
      view: 'overview',              /* overview | ledger | withdrawals */
      wallet: null, walletErr: null,
      /* The BUSINESS wallet, kept in its own state beside the personal one — never merged.
         `null` means not yet loaded; an error string is a stated failure, not a zero. */
      biz: null, bizErr: null,
      /* WHERE the business money came from, and the shop's own ledger. Separate state from
         `biz` because they come from separate callables that own separate questions — one
         what the wallet holds, one where it came from. */
      bd: null, bdErr: null,
      tx: null, txErr: null,
      payouts: null, payoutsErr: null,
      ent: undefined,                /* undefined = not asked, null = UNKNOWN */
      form: null,                    /* 'topup' | 'withdraw' */
      busy: false,
      values: { amount: '', phone: '', dest: 'mpesa' },
      serverSaid: null,              /* the last server sentence, rendered verbatim */
      formErr: null,
      idem: null,                    /* stable across retries of the SAME attempt */
    };

    function alive () { return !S.destroyed && host && host.isConnected !== false; }

    /* ── LOADS ──────────────────────────────────────────────────────────────
       Each records its own error. A failed read renders as a stated failure in
       its own section; it never blanks the whole surface and never falls back
       to a plausible number. */
    function loadWallet () {
      if (typeof ctx.readWallet !== 'function') { S.walletErr = 'unavailable'; return Promise.resolve(); }
      return ctx.readWallet().then(function (w) {
        if (!alive()) return;
        S.wallet = w || null; S.walletErr = w ? null : 'no-wallet';
      }).catch(function (e) {
        if (!alive()) return;
        S.walletErr = (e && e.code) || 'read-failed';
      });
    }

    /* The business wallet is read through its own ctx callback, exactly like the personal
       one. A failure here must not blank the personal wallet, and vice versa — they are two
       accounts and two independent reads. */
    function loadBiz () {
      if (typeof ctx.readBusinessWallet !== 'function') { S.bizErr = 'unavailable'; return Promise.resolve(); }
      return ctx.readBusinessWallet().then(function (w) {
        if (!alive()) return;
        S.biz = w || null;
        S.bizErr = w ? null : 'no-business';
      }).catch(function (e) {
        if (!alive()) return;
        S.bizErr = (e && e.code) || 'read-failed';
      });
    }

    function loadBreakdown () {
      if (typeof ctx.readWalletBreakdown !== 'function') { S.bdErr = 'unavailable'; return Promise.resolve(); }
      return ctx.readWalletBreakdown({}).then(function (r) {
        if (!alive()) return;
        var d = (r && r.data) || r || {};
        /* A named absence is not a failure: a merchant still onboarding has no business
           account yet, and the card says so rather than showing zeroes. */
        S.bd = d.ok ? d : null;
        S.bdErr = d.ok ? null : (d.reason || 'no-business');
      }).catch(function (e) {
        if (!alive()) return;
        S.bdErr = (e && e.code) || 'read-failed';
      });
    }

    function loadTx () {
      if (typeof ctx.readTransactions !== 'function') { S.txErr = 'unavailable'; return Promise.resolve(); }
      return ctx.readTransactions().then(function (rows) {
        if (!alive()) return;
        S.tx = (rows || []).slice().sort(function (a, b) {
          return (ts(b.createdAt) ? ts(b.createdAt).getTime() : 0) -
                 (ts(a.createdAt) ? ts(a.createdAt).getTime() : 0);
        });
        S.txErr = null;
      }).catch(function (e) {
        if (!alive()) return;
        S.txErr = (e && e.code) || 'read-failed';
      });
    }

    function loadPayouts () {
      if (typeof ctx.readPayouts !== 'function') { S.payoutsErr = 'unavailable'; return Promise.resolve(); }
      return ctx.readPayouts().then(function (rows) {
        if (!alive()) return;
        S.payouts = (rows || []).slice().sort(function (a, b) {
          return (ts(b.createdAt) ? ts(b.createdAt).getTime() : 0) -
                 (ts(a.createdAt) ? ts(a.createdAt).getTime() : 0);
        });
        S.payoutsErr = null;
      }).catch(function (e) {
        if (!alive()) return;
        S.payoutsErr = (e && e.code) || 'read-failed';
      });
    }

    /* ── ENTITLEMENT ────────────────────────────────────────────────────────
       `walletEnabled` is the catalogue's flag, but the client-reachable
       projection (`getMerchantEntitlements`) does not return `features` at all —
       it returns `premium`, defined server-side as `active && plan !== 'FREE'`.
       Under the deployed catalogue that is the SAME predicate as walletEnabled
       (FREE false, STARTER/GROWTH/ENTERPRISE true), which is asserted by
       scripts/test-merchant-wallet.js so a future plan that sets one without
       the other breaks the gate instead of silently unlocking the Wallet.

       null means UNKNOWN — signed out, offline, server unreachable. Unknown is
       NOT "not entitled", and it is NOT "entitled". It renders as a neutral
       checking state with no balance and no buttons. */
    function loadEnt () {
      if (typeof ctx.entitlement !== 'function') { S.ent = null; return Promise.resolve(); }
      return ctx.entitlement().then(function (e) {
        if (!alive()) return;
        S.ent = e || null;
      }).catch(function () { if (alive()) S.ent = null; });
    }

    function entitled () {
      if (!S.ent) return null;                       /* unknown */
      return !!S.ent.premium;
    }

    /* ── RENDER ─────────────────────────────────────────────────────────────── */

    function skeleton () {
      host.innerHTML =
        '<div class="wa-card"><div class="wa-lab">Available balance</div>' +
          '<div class="wa-bal">—</div>' +
          '<div class="wa-sub">Reading your wallet…</div></div>' +
        '<div class="wa-list"><div class="wa-sk"></div><div class="wa-sk"></div></div>';
    }

    function paint () {
      if (!alive()) return;

      var ok = entitled();
      if (ok === null && S.ent === undefined) return skeleton();
      if (ok === null) return paintUnknownPlan();
      if (ok === false) return paintLocked();

      if (S.form === 'topup')    return paintForm('topup');
      if (S.form === 'withdraw') return paintForm('withdraw');

      host.innerHTML =
        /* The server's last sentence survives the form closing. It is the record
           of what actually happened, in the server's words, and it is the thing
           a merchant will quote to support. */
        (S.serverSaid ? '<div class="wa-srv">' + esc(S.serverSaid) + '</div>' : '') +
        businessCard() +
        bizLedgerHTML() +
        balanceCard() +
        actions() +
        segs() +
        '<div id="wa-body"></div>';
      paintBody();
    }

    function paintUnknownPlan () {
      host.innerHTML =
        '<div class="wa-state"><span class="ico">⏳</span>' +
          '<b>Checking your plan</b>' +
          '<small>Your wallet opens once your subscription has been confirmed. ' +
          'Nothing is shown until then — a balance drawn before the plan is known ' +
          'would be a guess.</small>' +
          '<div style="margin-top:14px"><button class="wa-btn" data-wa="retry-ent">↻ Try again</button></div>' +
        '</div>';
    }

    function paintLocked () {
      var plan = (S.ent && S.ent.plan) || null;
      host.innerHTML =
        '<div class="wa-state"><span class="ico">🔒</span>' +
          '<b>Wallet is part of a paid plan</b>' +
          '<small>Your SOKONI Wallet — balance, M-Pesa top-ups and withdrawals — is ' +
          'included on every paid plan.' +
          (plan ? ' You are on <b>' + esc(plan) + '</b>.' : '') +
          '</small>' +
          '<div style="margin-top:14px"><button class="wa-btn pri" data-wa="plans">See plans</button></div>' +
        '</div>';
    }

    /* ── THE BUSINESS WALLET ────────────────────────────────────────────────
       TWO WALLETS, SHOWN AS TWO WALLETS.

           businessWallets/{businessId}   what the SHOP has earned     CENTS
           wallets/{uid}                  what the OWNER can spend     SHILLINGS

       Marketplace settlement and POS/Till sales both land in the first. It is a
       different account from the second — different keyspace, different unit,
       and different obligations attached — so it is rendered as its own card
       rather than folded into one number. Adding them together would recreate
       exactly the confusion the split exists to end: a merchant cannot answer
       "what does my shop owe?" from a figure that has already been mixed with
       their personal money.

       ── THE RESERVE IS SHOWN, NOT SUBTRACTED SILENTLY ───────────────────────
       POS commission still owed is funded from this balance, so it is held
       back. A merchant seeing only "available" would think the rest had
       vanished. Held / reserved / available are three separate lines because
       they answer three separate questions.

       ── NOTHING HERE IS COMPUTED ────────────────────────────────────────────
       Every figure is a field the server wrote. `available` is the server's own
       subtraction, returned by the same callable that enforces it, so the
       number shown and the number enforced cannot drift. When the read fails
       the card says so; it never renders 0 for an unknown.

       ── WHY A CALLABLE AND NOT A DOCUMENT READ ──────────────────────────────
       The personal wallet above is read straight from Firestore because the
       SERVED ruleset authorises it. `businessWallets` is different: measured
       2026-09-09 against the deployed ruleset (release
       projects/sokoni-aeb26/releases/cloud.firestore, ruleset 1cf1f3f2), there
       is NO match block for `businessWallets` or `businessWalletEntries` and no
       catch-all — so production is default-DENY on both. Writes being denied is
       correct and is the protection we want; reads being denied means a direct
       getDoc here would fail for every merchant until a rules deploy lands.

       So the callable is not a preference, it is the only thing that works
       today: it runs on the Admin SDK and bypasses rules entirely. The repo's
       firestore.rules already carries the owner-scoped read for when rules next
       deploy, and this surface will keep working either way. */
    /* ── THE THREE SALES STREAMS ────────────────────────────────────────────
       POS, Till and Online are DIMENSIONS of the one wallet ledger, not three
       wallets, and they are rendered that way: under the single balance rather
       than beside it.

       Each row carries what the merchant is actually comparing — what came in,
       what SOKONI took, what they kept. Gross and commission come from the
       entry itself, so "Till commission" is a fact the ledger already holds
       rather than a subtraction this file performs. */
    var CHANNEL_ROWS = [
      { key: 'POS',    emoji: '🏪', label: 'Shop / POS' },
      { key: 'TILL',   emoji: '📱', label: 'Till / QR' },
      { key: 'ONLINE', emoji: '🌐', label: 'Online orders' },
    ];

    /* One labelled figure. Rendered at zero too — a row that disappears when it is nil
       makes a reader wonder whether it was omitted or is genuinely nothing. */
    function figRow (emoji, label, minor) {
      return '<div class="wa-fig-r"><span>' + emoji + ' ' + esc(label) + '</span>' +
        '<b>' + esc(money(Number(minor || 0) / 100)) + '</b></div>';
    }

    function channelsHTML (b) {
      if (!b || !b.channels || !b.salesTotals) return '';
      var any = CHANNEL_ROWS.some(function (r) {
        var c = b.channels[r.key];
        return c && (c.grossMinor || c.netMinor || c.count);
      });
      if (!any) {
        return '<div class="wa-note" style="margin-top:12px">No sales in this wallet yet. ' +
               'Shop, Till and online sales will appear here separately.</div>';
      }
      var k = function (m) { return money(Number(m || 0) / 100); };
      return '<div class="wa-chan">' +
        CHANNEL_ROWS.map(function (r) {
          var c = b.channels[r.key] || { grossMinor: 0, commissionMinor: 0, netMinor: 0 };
          return '<div class="wa-chan-r">' +
            '<div class="wa-chan-n">' + r.emoji + ' ' + esc(r.label) + '</div>' +
            '<div class="wa-chan-v">' +
              '<b>' + esc(k(c.netMinor)) + '</b>' +
              '<small>' + esc(k(c.grossMinor)) + ' less ' + esc(k(c.commissionMinor)) +
              ' commission</small>' +
            '</div></div>';
        }).join('') +
        '<div class="wa-chan-r wa-chan-r--tot">' +
          '<div class="wa-chan-n">Σ Combined sales</div>' +
          '<div class="wa-chan-v"><b>' + esc(k(b.salesTotals.netMinor)) + '</b>' +
            '<small>' + esc(k(b.salesTotals.grossMinor)) + ' less ' +
            esc(k(b.salesTotals.commissionMinor)) + ' commission</small></div>' +
        '</div>' +
      '</div>' +
      (b.salesComplete === false
        ? '<div class="wa-note">Your most recent movements. Older history is not included ' +
          'in these totals.</div>'
        : '');
    }

    function businessCard () {
      if (S.bizErr === 'unavailable') return '';      /* surface not wired — say nothing */

      if (S.bizErr === 'no-business') {
        return '<div class="wa-card">' +
          '<div class="wa-lab">Business wallet</div>' +
          '<div class="wa-bal">—</div>' +
          '<div class="wa-sub">No business account is linked to you yet. Shop earnings are ' +
          'paid into a business wallet, which is created when your merchant application is ' +
          'approved.</div>' +
        '</div>';
      }
      if (S.biz === null && !S.bizErr) {
        return '<div class="wa-card"><div class="wa-lab">Business wallet</div>' +
               '<div class="wa-list"><div class="wa-sk"></div></div></div>';
      }
      if (S.bizErr) {
        return '<div class="wa-card">' +
          '<div class="wa-lab">Business wallet</div>' +
          '<div class="wa-bal">—</div>' +
          '<div class="wa-sub">Your shop balance could not be read (<code>' +
          esc(S.bizErr) + '</code>). Nothing is estimated in its place.</div>' +
        '</div>';
      }

      /* Minor units in, shillings on screen — converted once, here. */
      var heldMinor = Number(S.biz.balanceMinor || 0);
      var resMinor  = Number(S.biz.reservedMinor || 0);
      var availMinor = Number(
        S.biz.availableMinor === undefined ? Math.max(0, heldMinor - resMinor) : S.biz.availableMinor);
      var debtMinor = Number(S.biz.recoveryDebtMinor || 0);
      var canDraw = availMinor >= 100;                /* a draw is whole shillings */

      return '<div class="wa-card">' +
        '<div class="wa-lab">Business wallet — your shop’s earnings</div>' +
        '<div class="wa-bal"><span class="wa-cur">KES</span>' +
          esc(money(heldMinor / 100).replace(/^KES\s*/, '')) + '</div>' +
        '<div class="wa-sub">Paid in by your online orders and your POS/Till sales, after ' +
        'SOKONI’s commission. This is the shop’s money — separate from your personal ' +
        'wallet below.</div>' +
        /* ONE BALANCE, THREE STREAMS. A merchant sells in three places and the money lands in
           one account — that is right, it is one business. But "how is the shop doing?", "is
           the Till worth having?" and "does the marketplace pay?" are three questions a single
           balance answers none of.

           Every figure below is the SERVER's, derived from the same ledger entries that
           produced the balance. Nothing here is added up in the browser: a total computed
           beside the money is a total that eventually disagrees with it, and this surface has
           no authority to be the one that is right. Shown only when the server could read the
           breakdown — null means unread, and a rendered 0 would tell a merchant they have
           earned nothing when they may simply have a long statement. */
        channelsHTML(S.biz) +
        /* ── THE FIVE FIGURES, STATED RATHER THAN LEFT TO BE INFERRED ────────────────────
           A merchant looking at one balance cannot tell what of it is theirs to move today.
           Each of these is the SERVER's own number — none is subtracted here — and each is
           shown even at zero, because "there is no pending money" is information and a
           missing row is something a reader has to guess about.

           Withdrawable is listed beside available although the two are equal today: the draw
           is the only way out and has no further floor of its own. They are separate fields
           on purpose — the moment a minimum or a holding period is introduced they diverge,
           and every reader should already be asking for the right one. */
        '<div class="wa-fig">' +
          figRow('💰', 'Total balance', heldMinor) +
          figRow('⏳', 'Pending', Number(S.biz.pendingMinor || 0)) +
          figRow('🧾', 'Reserved for commission', resMinor) +
          figRow('✅', 'Available', availMinor) +
          figRow('🏧', 'Withdrawable now',
                 Number(S.biz.withdrawableMinor === undefined ? availMinor : S.biz.withdrawableMinor)) +
        '</div>' +
        breakdownHTML() +
        (resMinor > 0
          ? '<div class="wa-res">🧾 <span><b>' + esc(money(resMinor / 100)) + '</b> is held back ' +
            'for POS commission you still owe. It stays here so your till is not blocked at ' +
            'the morning gate.</span></div>'
          : '') +
        (debtMinor > 0
          ? '<div class="wa-res">↩︎ <span><b>' + esc(money(debtMinor / 100)) + '</b> is owed from ' +
            'a refunded sale that was already settled to you. It is cleared automatically from ' +
            'your next earnings, before anything becomes available.</span></div>'
          : '') +
        '<div class="wa-res">✅ <span><b>' + esc(money(availMinor / 100)) + '</b> is available to ' +
        'move to your personal wallet, where you can spend or withdraw it.</span></div>' +
        '<div class="wa-acts" style="margin-top:12px">' +
          '<button class="wa-btn pri" data-wa="draw"' + (canDraw ? '' : ' disabled') + '>' +
          '↓ Move to my wallet</button>' +
        '</div>' +
        (canDraw ? '' :
          '<div class="wa-note" style="margin-top:-4px">A transfer starts at KES 1.</div>') +
      '</div>';
    }

    /* ── WHERE THE MONEY CAME FROM ────────────────────────────────────────────
       One balance, several sources. A merchant who delivers as well as sells cannot tell
       from a single figure whether the deliveries are worth doing — and a rider's whole
       wallet is delivery earnings, so without this their statement is a number with no
       explanation at all.

       EVERY FIGURE IS THE SERVER'S, summed from the same ledger entries that produced the
       balance. Nothing is added up in this browser: a total computed beside the money is
       a total that eventually disagrees with it, and this surface has no authority to be
       the one that is right. */
    function breakdownHTML () {
      if (S.bd === null && !S.bdErr) {
        return '<div class="wa-fig"><div class="wa-sk"></div></div>';
      }
      if (S.bdErr) {
        /* Absent, never zero. "You have earned nothing from deliveries" is a claim, and a
           read that did not complete is not evidence for it. */
        return '<div class="wa-note" style="margin-top:12px">Where this money came from ' +
               'could not be read (<code>' + esc(S.bdErr) + '</code>). Nothing is estimated ' +
               'in its place.</div>';
      }
      var b = S.bd.breakdown;
      if (!b) return '';
      return '<div class="wa-fig" style="margin-top:10px">' +
        '<div class="wa-fig-r" style="opacity:.7"><span>Where it came from</span><b></b></div>' +
        figRow('🛵', 'Delivery earnings', b.deliveryEarningsMinor) +
        figRow('🛒', 'Sales proceeds', b.salesProceedsMinor) +
        figRow('🏷️', 'SOKONI commission', b.commissionMinor) +
        (Number(b.otherMinor || 0) !== 0 ? figRow('•', 'Other movements', b.otherMinor) : '') +
      '</div>' +
      /* A lifetime total and a last-200-movements total are different facts, and a card
         that shows one while implying the other is lying quietly. */
      (b.truncated
        ? '<div class="wa-note">From your most recent ' + esc(b.fromEntries) + ' movements.</div>'
        : '');
    }

    /* THE SHOP'S OWN LEDGER. The list below this one is the PERSONAL wallet's
       (walletTransactions); these are the business wallet's entries, which is where a
       delivery earning or a settled order actually lands. Two ledgers, shown separately,
       because merging them would make "what has my shop earned?" unanswerable. */
    function bizLedgerHTML () {
      if (!S.bd || !S.bd.transactions || !S.bd.transactions.length) return '';
      var rows = S.bd.transactions.slice(0, 12).map(function (t) {
        var sign = t.direction === 'debit' ? '−' : '+';
        var what = t.stream === 'delivery' ? '🛵 Delivery'
                 : t.stream === 'sales' ? '🛒 Sale'
                 : t.stream === 'commission' ? '🏷️ Commission' : '• Movement';
        var refText = t.deliveryId || t.orderId || '';
        return '<div class="wa-fig-r">' +
          '<span>' + esc(what) + (refText ? ' <code>' + esc(String(refText).slice(-10)) + '</code>' : '') + '</span>' +
          '<b>' + esc(sign + ' ' + money(Number(t.amountMinor || 0) / 100)) + '</b></div>';
      }).join('');
      return '<div class="wa-card">' +
        '<div class="wa-lab">Business wallet transactions</div>' +
        '<div class="wa-fig">' + rows + '</div>' +
      '</div>';
    }

    function balanceCard () {
      var bal = S.wallet ? money(S.wallet.balance) : null;
      var pend = S.wallet ? Number(S.wallet.pendingPayout || 0) : 0;
      var known = bal !== null;

      var body;
      if (S.walletErr === 'no-wallet') {
        /* A wallet document is created on first use by the server. Absent is a
           real, meaningful state — it is not zero and it is not an error. */
        body = '<div class="wa-bal">—</div>' +
               '<div class="wa-sub">Your wallet has not been opened yet. It is created the ' +
               'first time money reaches it, or the first time you top up.</div>';
      } else if (!known) {
        body = '<div class="wa-bal">—</div>' +
               '<div class="wa-sub">Your balance could not be read' +
               (S.walletErr ? ' (<code>' + esc(S.walletErr) + '</code>)' : '') +
               '. Nothing is estimated in its place.</div>';
      } else {
        body = '<div class="wa-bal"><span class="wa-cur">KES</span>' +
               esc(bal.replace(/^KES\s*/, '')) + '</div>' +
               '<div class="wa-sub">Yours to spend or withdraw. Money already requested for ' +
               'withdrawal is not counted here.</div>';
      }

      return '<div class="wa-card">' +
        '<div class="wa-lab">Available balance</div>' + body +
        (pend > 0
          ? '<div class="wa-res">⏳ <span><b>' + esc(money(pend)) + '</b> is reserved for a ' +
            'withdrawal you have requested. It leaves your available balance immediately and ' +
            'is returned if the withdrawal is rejected.</span></div>'
          : '') +
      '</div>';
    }

    function actions () {
      var canWithdraw = !!(S.wallet && Number(S.wallet.balance || 0) >= PAYOUT_MIN);
      return '<div class="wa-acts">' +
        '<button class="wa-btn pri" data-wa="topup">＋ Top up</button>' +
        '<button class="wa-btn" data-wa="withdraw"' + (canWithdraw ? '' : ' disabled') + '>↑ Withdraw</button>' +
      '</div>' +
      (canWithdraw ? '' :
        '<div class="wa-note" style="margin-top:-8px">Withdrawals start at ' +
        esc(money(PAYOUT_MIN)) + '.</div>');
    }

    var VIEWS = [
      { k: 'overview',    label: 'Overview' },
      { k: 'ledger',      label: 'Transactions' },
      { k: 'withdrawals', label: 'Withdrawals' },
    ];

    function segs () {
      return '<div class="wa-segs">' + VIEWS.map(function (v) {
        return '<button class="wa-seg' + (S.view === v.k ? ' on' : '') + '" data-wav="' + v.k + '">' +
          esc(v.label) + '</button>';
      }).join('') + '</div>';
    }

    function paintBody () {
      var b = host.querySelector('#wa-body');
      if (!b) return;
      if (S.view === 'ledger')      b.innerHTML = ledgerView();
      else if (S.view === 'withdrawals') b.innerHTML = withdrawalsView();
      else                          b.innerHTML = overviewView();
    }

    /* ── OVERVIEW ─────────────────────────────────────────────────────────── */
    function overviewView () {
      var groups = groupPayouts();
      var recent = (S.tx || []).slice(0, 5);

      var out = '';

      /* The four states, always named, always counted — including when a count
         is zero, because "no failed withdrawals" is information and a missing
         row is not. A count is only omitted when the read FAILED, which is a
         different thing and says so. */
      if (S.payoutsErr) {
        out += stateBox('🔒', 'Withdrawals could not be read',
          'The request reached the server and failed (<code>' + esc(S.payoutsErr) + '</code>). ' +
          'This is a read result, not an empty history.');
      } else if (S.payouts === null) {
        out += '<div class="wa-list"><div class="wa-sk"></div></div>';
      } else {
        out += '<div class="wa-list">' +
          ['pending', 'completed', 'failed', 'reversed'].map(function (k) {
            var g = groups[k];
            if (k === 'reversed' && !g.length) return '';   /* rare; shown only when real */
            var total = g.reduce(function (a, p) { return a + Number(p.amount || 0); }, 0);
            return '<div class="wa-row">' +
              '<div class="wa-i">' +
                '<div class="wa-t">' + esc(STATE_LABEL[k]) + ' withdrawals</div>' +
                '<div class="wa-m">' + (g.length
                  ? esc(String(g.length)) + ' request' + (g.length === 1 ? '' : 's')
                  : 'None') + '</div>' +
              '</div>' +
              '<div class="wa-amt">' + (g.length ? esc(money(total)) : '—') + '</div>' +
            '</div>';
          }).join('') +
        '</div>';
      }

      out += '<div class="wa-note">' + pendingSentence(groups.pending.length) + '</div>';

      if (recent.length) {
        out += '<div class="wa-lab" style="margin:20px 0 9px">Recent activity</div>' +
               '<div class="wa-list">' + recent.map(txRow).join('') + '</div>';
      }

      out += sourceNote();
      return out;
    }

    function pendingSentence (n) {
      if (!n) {
        return 'Withdrawals are reviewed before the money is sent. Nothing is described as ' +
               '“sent” here until the server records it as paid.';
      }
      return '<b>' + esc(String(n)) + ' withdrawal' + (n === 1 ? ' is' : 's are') + ' still in progress.</b> ' +
             'Automatic disbursement is switched off on this platform, so a withdrawal is a request ' +
             'that is processed by hand — including one already marked <i>approved</i>. Approved ' +
             'means agreed, not sent.';
    }

    /* ── LEDGER ───────────────────────────────────────────────────────────── */
    function ledgerView () {
      if (S.txErr) {
        return stateBox('🔒', 'Transactions could not be read',
          'The request failed (<code>' + esc(S.txErr) + '</code>). Nothing is estimated in its place.');
      }
      if (S.tx === null) return '<div class="wa-list"><div class="wa-sk"></div><div class="wa-sk"></div></div>';
      if (!S.tx.length) {
        return stateBox('🧾', 'No wallet transactions yet',
          'Top-ups, payments and payouts appear here once they happen.');
      }
      return '<div class="wa-list">' + S.tx.map(txRow).join('') + '</div>' + sourceNote();
    }

    function txRow (t) {
      /* `type` is what the server wrote: credit / debit / pending / payout.
         An incoming amount is only styled as incoming when the record says so —
         never inferred from the sign of a number we did not compute. */
      var type = String(t.type || '').toLowerCase();
      var incoming = type === 'credit' || type === 'topup' || type === 'refund';
      var amt = money(t.amount);
      var st = String(t.status || '').toLowerCase();
      var cls = st === 'completed' ? 'done' : st === 'failed' ? 'bad' : 'pend';
      var d = ts(t.createdAt);
      return '<div class="wa-row">' +
        '<div class="wa-i">' +
          '<div class="wa-t">' + esc(t.description || (incoming ? 'Money in' : 'Money out')) + '</div>' +
          '<div class="wa-m">' + esc(when(d)) +
            (t.mpesaRef ? ' · ' + esc(t.mpesaRef) : '') + '</div>' +
          (st ? '<span class="wa-badge ' + cls + '">' + esc(st) + '</span>' : '') +
        '</div>' +
        '<div class="wa-amt' + (incoming ? ' in' : '') + '">' +
          (amt === null ? '—' : esc((incoming ? '+' : '−') + amt)) + '</div>' +
      '</div>';
    }

    /* ── WITHDRAWALS ──────────────────────────────────────────────────────── */
    function groupPayouts () {
      var g = { pending: [], completed: [], failed: [], reversed: [] };
      (S.payouts || []).forEach(function (p) { g[payoutState(p.status)].push(p); });
      return g;
    }

    function withdrawalsView () {
      if (S.payoutsErr) {
        return stateBox('🔒', 'Withdrawals could not be read',
          'The request failed (<code>' + esc(S.payoutsErr) + '</code>). This is a read result, ' +
          'not an empty history.');
      }
      if (S.payouts === null) return '<div class="wa-list"><div class="wa-sk"></div><div class="wa-sk"></div></div>';
      if (!S.payouts.length) {
        return stateBox('↑', 'No withdrawals yet',
          'When you withdraw, every request appears here with the state the server recorded for it.');
      }
      return '<div class="wa-list">' + S.payouts.map(payoutRow).join('') + '</div>' + sourceNote();
    }

    function payoutRow (p) {
      var state = payoutState(p.status);
      var amt = money(p.netAmount != null ? p.netAmount : p.amount);
      var d = ts(p.createdAt);
      var raw = String(p.status || '').toLowerCase();
      return '<div class="wa-row">' +
        '<div class="wa-i">' +
          '<div class="wa-t">To ' + esc(mask(p.accountNumber)) +
            (p.method ? ' · ' + esc(String(p.method).toUpperCase()) : '') + '</div>' +
          '<div class="wa-m">' + esc(when(d)) + ' · ' +
            esc(STATUS_WORD[raw] || raw || 'Unknown state') + '</div>' +
          '<span class="wa-badge ' + STATE_CLASS[state] + '">' + esc(STATE_LABEL[state]) + '</span>' +
          (raw === 'approved' && p.secureRelease ? ' <button class="wa-btn pri" data-wa="release">🔐 Ready to release — open your Wallet</button>' : '') +
        '</div>' +
        '<div class="wa-amt">' + (amt === null ? '—' : esc(amt)) + '</div>' +
      '</div>';
    }

    function stateBox (ico, title, sub) {
      return '<div class="wa-state"><span class="ico">' + ico + '</span><b>' + esc(title) + '</b>' +
        '<small>' + sub + '</small></div>';
    }

    function sourceNote () {
      return '<div class="wa-note"><b>Where these figures come from.</b> Your balance is ' +
        '<code>wallets/{you}.balance</code>, transactions are <code>walletTransactions</code> and ' +
        'withdrawals are <code>payoutRequests</code> — all written by SOKONI’s servers. This screen ' +
        'calculates nothing: an amount it cannot read is shown as —, never as 0.</div>';
    }

    /* ── FORMS ────────────────────────────────────────────────────────────── */
    function paintForm (kind) {
      var topup = kind === 'topup';
      host.innerHTML =
        '<div class="wa-card">' +
          '<div class="wa-lab">' + (topup ? 'Top up your wallet' : 'Withdraw to M-Pesa') + '</div>' +
          '<div class="wa-sub">' + (topup
            ? 'An M-Pesa prompt is sent to your phone. Your balance changes only after SOKONI’s ' +
              'server confirms the payment — never because this screen thinks it worked.'
            : 'This submits a withdrawal <b>request</b>. Automatic disbursement is switched off, so ' +
              'the money is sent by hand after review. Nothing here will tell you it has been sent ' +
              'until the server says so.') +
          '</div>' +
        '</div>' +

        (S.serverSaid
          ? '<div class="wa-srv">' + esc(S.serverSaid) + '</div>'
          : '') +

        '<div class="wa-form">' +
          (topup ? '' : destinationPicker()) +
          '<div class="wa-f"><label for="wa-amt">Amount (KES)</label>' +
            '<input id="wa-amt" type="number" inputmode="numeric" step="1" min="' +
              (topup ? TOPUP_MIN : PAYOUT_MIN) + '"' +
              (topup ? ' max="' + TOPUP_MAX + '"' : '') +
              ' value="' + esc(S.values.amount) + '" autocomplete="off"></div>' +
          '<div class="wa-f"><label for="wa-phone">M-Pesa number</label>' +
            '<input id="wa-phone" type="tel" inputmode="tel" placeholder="07XX XXX XXX" value="' +
              esc(S.values.phone) + '" autocomplete="tel"></div>' +
          (S.formErr ? '<div class="wa-err">' + esc(S.formErr) + '</div>' : '') +
          '<div class="wa-acts" style="margin:6px 0 0">' +
            '<button class="wa-btn" data-wa="cancel">Cancel</button>' +
            '<button class="wa-btn pri" data-wa="' + (topup ? 'do-topup' : 'do-withdraw') + '"' +
              (S.busy ? ' disabled' : '') + '>' +
              (S.busy ? 'Working…' : (topup ? 'Send M-Pesa prompt' : 'Request withdrawal')) +
            '</button>' +
          '</div>' +
        '</div>' +

        (topup
          ? '<div class="wa-note">Top-ups are between ' + esc(money(TOPUP_MIN)) + ' and ' +
            esc(money(TOPUP_MAX)) + '.</div>'
          : '<div class="wa-note">Minimum withdrawal ' + esc(money(PAYOUT_MIN)) + '. The amount ' +
            'leaves your available balance as soon as the request is accepted, and returns to it ' +
            'if the request is rejected.</div>');

      var a = host.querySelector('#wa-amt');
      var p = host.querySelector('#wa-phone');
      /* Values live in S, not in the DOM: a repaint that re-reads the DOM would
         discard whatever the merchant had typed since the last one. */
      if (a) a.addEventListener('input', function (e) { S.values.amount = e.target.value; });
      if (p) p.addEventListener('input', function (e) { S.values.phone = e.target.value; });
    }

    /* ── DESTINATION ──────────────────────────────────────────────────────────
       Till and PayBill are DRAWN and DISABLED with the reason on them, rather
       than hidden. Hiding them would make the Wallet look finished; offering
       them against `requestSellerPayout` would be worse — that function
       validates the account as a phone number, so a till number would be
       rejected or, if it happened to look like a phone, would pay a stranger.
       PayBill cannot be expressed at all: it needs a number AND an account
       reference, and there is one `accountNumber` field. */
    var DESTS = [
      /* "Goes to", not "Sent to". On a withdrawal screen where nothing has been
         disbursed yet, "sent" is the one word that must not appear. */
      { id: 'mpesa',   name: 'M-Pesa mobile number', on: true,
        note: 'Goes to a Kenyan mobile number.' },
      { id: 'till',    name: 'M-Pesa Till (Buy Goods)', on: false,
        note: 'Not available yet. Withdrawals are validated as mobile numbers, so a till ' +
              'number cannot be sent correctly today.' },
      { id: 'paybill', name: 'M-Pesa PayBill', on: false,
        note: 'Not available yet. A PayBill needs both a business number and an account ' +
              'reference, and only one destination field exists.' },
    ];

    function destinationPicker () {
      return '<div class="wa-dest">' + DESTS.map(function (d) {
        return '<label class="wa-d' + (d.on ? (S.values.dest === d.id ? ' on' : '') : ' off') + '">' +
          '<input type="radio" name="wa-dest" value="' + d.id + '"' +
            (S.values.dest === d.id ? ' checked' : '') +
            (d.on ? '' : ' disabled') + '>' +
          '<span><span class="dn">' + esc(d.name) + '</span>' +
          '<span class="dd">' + esc(d.note) + '</span></span>' +
        '</label>';
      }).join('') + '</div>';
    }

    /* ── ACTIONS ──────────────────────────────────────────────────────────── */

    function toast (m) { if (typeof ctx.onToast === 'function') ctx.onToast(m); }

    /* One key per ATTEMPT. Regenerated when the merchant opens the form, kept
       across a retry of that same attempt, so a double-tap or a retry after a
       timeout maps to the SAME deterministic payoutRequests id and the server
       returns the existing request instead of creating a second withdrawal. */
    function newIdem () {
      var r;
      try {
        var g = (typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : null));
        var b = new Uint8Array(9);
        g.crypto.getRandomValues(b);
        r = Array.prototype.map.call(b, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
      } catch (_) {
        r = String(Date.now()) + '-' + String(Math.floor(Math.random() * 1e9));
      }
      return 'w' + Date.now().toString(36) + r;
    }

    function amountOf () {
      var v = String(S.values.amount || '').trim();
      if (!v) return null;
      var n = Number(v);
      if (!isFinite(n)) return null;
      return n;
    }

    function doTopUp () {
      if (S.busy) return;
      S.formErr = null;
      var amt = amountOf();
      if (amt === null || !Number.isInteger(amt)) {
        S.formErr = 'Enter a whole amount in shillings.'; return paint();
      }
      if (amt < TOPUP_MIN || amt > TOPUP_MAX) {
        S.formErr = 'Top-ups are between ' + money(TOPUP_MIN) + ' and ' + money(TOPUP_MAX) + '.';
        return paint();
      }
      if (!String(S.values.phone || '').trim()) {
        S.formErr = 'Enter the M-Pesa number to charge.'; return paint();
      }
      if (typeof ctx.callTopUp !== 'function') {
        S.formErr = 'Top-up is not available in this workspace.'; return paint();
      }

      S.busy = true; paint();
      ctx.callTopUp({ amount: amt, phone: String(S.values.phone).trim() })
        .then(function (r) {
          if (!alive()) return;
          var d = (r && r.data) || r || {};
          S.busy = false;
          /* The server's sentence, verbatim. It says a prompt was SENT — which
             is true and is not a claim that money arrived. The balance is not
             touched here; only the server credits it. */
          S.serverSaid = d.message || 'M-Pesa prompt sent. Enter your PIN on your phone.';
          S.values.amount = '';
          paint();
          if (d.txId) pollTopUp(d.txId);
        })
        .catch(function (e) {
          if (!alive()) return;
          S.busy = false;
          S.formErr = serverMessage(e, 'The M-Pesa prompt could not be started.');
          paint();
        });
    }

    /* Ask the SERVER whether the top-up completed. The wallet is re-read from
       Firestore afterwards, so the new balance is the server's number and never
       the old one plus what we hoped for. */
    function pollTopUp (txId) {
      if (typeof ctx.callConfirmTopUp !== 'function') return;
      var tries = 0;
      var tick = function () {
        if (!alive() || tries >= 10) return;
        tries++;
        ctx.callConfirmTopUp({ txId: txId }).then(function (r) {
          if (!alive()) return;
          var d = (r && r.data) || r || {};
          if (d.status === 'completed') {
            S.serverSaid = 'Top-up confirmed by SOKONI.';
            return refresh();
          }
          if (d.status === 'failed') {
            S.serverSaid = 'The top-up did not complete. Nothing was added to your wallet.';
            return paint();
          }
          setTimeout(tick, 4000);
        }).catch(function () {
          /* A failed poll says nothing about the payment. Stay silent, keep the
             prompt message on screen, and let the next tick or a manual refresh
             answer. Announcing a failure here would be inventing an outcome. */
          setTimeout(tick, 6000);
        });
      };
      setTimeout(tick, 5000);
    }

    /* SOKONI Secure Release (owner decision 2026-09-30): a withdrawal is requested, PIN-verified, approved and RELEASED in
       the ONE premium wallet (profile Wallet tab) — the same personal wallet (wallets/{uid}) this screen shows. This
       module no longer submits withdrawals itself: its old form had no PIN and no release step, so the server would
       refuse it. Withdraw opens the one wallet; "Release" of an approved request happens there too. */
    function openOneWallet (sub) {
      var to = '/profile.html#wallet:' + (sub === 'payouts' ? 'payouts' : 'withdraw');
      try { (window.top || window).location.href = to; } catch (_) { location.href = to; }
    }

    /* ── THE DRAW: business wallet → personal wallet ────────────────────────
       Moves the whole AVAILABLE amount. Deliberately not an amount field: the
       server already computes what is available (balance minus the POS
       commission it reserves), and offering a box invites a merchant to type a
       number the server will then refuse. One button, one meaning.

       This screen still decides nothing about money. It sends the figure the
       server itself reported as available, and the server re-checks it inside
       the transaction — so a stale card cannot authorise a transfer. */
    function doDraw () {
      if (S.busy) return;
      if (typeof ctx.callDraw !== 'function') {
        toast('Transfers are not available in this workspace.'); return;
      }
      var availMinor = S.biz
        ? Number(S.biz.availableMinor === undefined
            ? Math.max(0, Number(S.biz.balanceMinor || 0) - Number(S.biz.reservedMinor || 0))
            : S.biz.availableMinor)
        : 0;
      /* WHOLE SHILLINGS ONLY. The two wallets use different units and the server
         refuses a fraction rather than rounding it, so the floor happens here
         and the remaining cents stay in the business wallet where they belong —
         they are not lost, they are simply not yet a whole shilling. */
      var amt = Math.floor(availMinor / 100);
      if (amt < 1) { toast('There is nothing available to move yet.'); return; }

      if (!S.idem) S.idem = newIdem();
      S.busy = true; paint();

      ctx.callDraw({ amount: amt, idempotencyKey: S.idem }).then(function (r) {
        if (!alive()) return;
        var d = (r && r.data) || r || {};
        S.busy = false;
        S.serverSaid = d.idempotent
          ? 'This transfer had already been made — it has not been duplicated.'
          : money(d.amountShillings || amt) + ' moved to your personal wallet.';
        S.idem = null;
        toast(S.serverSaid);
        paint();
        refresh();
      }).catch(function (e) {
        if (!alive()) return;
        S.busy = false;
        /* The key is KEPT on failure, for the same reason as a withdrawal: if the
           transfer landed and only the response was lost, retrying with the same
           key returns the existing movement instead of making a second one. */
        S.serverSaid = serverMessage(e, 'The transfer could not be completed.');
        toast(S.serverSaid);
        paint();
      });
    }

    /* A callable's refusal carries the server's wording. Show it: it is more
       accurate than anything this screen could compose, and it is the sentence
       support will be asked about. Only fall back when there is none. */
    function serverMessage (e, fallback) {
      var m = e && (e.message || (e.details && e.details.message));
      if (!m) return fallback;
      m = String(m);
      /* The SDK prefixes some errors; strip the code but keep the sentence. */
      m = m.replace(/^(FirebaseError:\s*)?(functions\/)?[a-z-]+:\s*/i, '');
      if (/^internal$/i.test(m.trim())) {
        return 'The server could not be reached for this request. Nothing was submitted.';
      }
      return m;
    }

    function openForm (kind) {
      S.form = kind;
      S.formErr = null;
      S.serverSaid = null;
      S.values.amount = '';
      S.values.dest = 'mpesa';
      S.idem = kind === 'withdraw' ? newIdem() : null;
      paint();
    }

    /* ── EVENTS ───────────────────────────────────────────────────────────── */
    function onClick (e) {
      var v = e.target.closest && e.target.closest('[data-wav]');
      if (v) { S.view = v.dataset.wav; paint(); return; }

      var b = e.target.closest && e.target.closest('[data-wa]');
      if (!b) return;
      var a = b.dataset.wa;
      if (a === 'topup')       return openForm('topup');
      if (a === 'withdraw')    return openOneWallet('withdraw');   /* Secure Release: the one wallet */
      if (a === 'release')     return openOneWallet('payouts');
      if (a === 'cancel')      { S.form = null; S.formErr = null; S.serverSaid = null; S.idem = null; return paint(); }
      if (a === 'do-topup')    return doTopUp();
      if (a === 'draw')        return doDraw();
      if (a === 'retry-ent')   { S.ent = undefined; paint(); return loadEnt().then(paint); }
      if (a === 'plans') {
        if (typeof ctx.onGoPlan === 'function') return ctx.onGoPlan();
        toast('Open Plan from the menu to change your subscription.');
      }
    }

    function onChange (e) {
      if (e.target && e.target.name === 'wa-dest') {
        S.values.dest = e.target.value;
        paint();
      }
    }

    host.addEventListener('click', onClick);
    host.addEventListener('change', onChange);

    function refresh () {
      if (!alive()) return Promise.resolve();
      return Promise.all([loadWallet(), loadBiz(), loadBreakdown(), loadTx(), loadPayouts()]).then(function () {
        if (S.form) return;            /* never yank a form the merchant is filling in */
        paint();
      });
    }

    /* First paint: the skeleton is up immediately, the plan answer decides what
       the surface even is, and the three reads fill it in. */
    skeleton();
    loadEnt().then(function () {
      if (!alive()) return;
      paint();
      if (entitled() === true) return refresh();
    });

    return {
      refresh: refresh,
      destroy: function () {
        S.destroyed = true;
        try {
          host.removeEventListener('click', onClick);
          host.removeEventListener('change', onChange);
        } catch (_) {}
      },
    };
  }

  return { mount: mount, _internal: { payoutState: payoutState, money: money, mask: mask, PAYOUT_STATE: PAYOUT_STATE } };
}));
