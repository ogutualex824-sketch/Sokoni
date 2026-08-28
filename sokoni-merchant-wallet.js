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
                  retry_scheduled · approval_failed
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
    approval_failed: 'pending',
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
    processing: 'Being sent',
    retry_scheduled: 'Retrying',
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

    function doWithdraw () {
      if (S.busy) return;
      S.formErr = null;

      if (S.values.dest !== 'mpesa') {
        S.formErr = 'Only withdrawals to an M-Pesa mobile number are available.'; return paint();
      }
      var amt = amountOf();
      if (amt === null || !Number.isInteger(amt)) {
        S.formErr = 'Enter a whole amount in shillings.'; return paint();
      }
      if (amt < PAYOUT_MIN) {
        S.formErr = 'The smallest withdrawal is ' + money(PAYOUT_MIN) + '.'; return paint();
      }
      var bal = S.wallet ? Number(S.wallet.balance || 0) : null;
      if (bal !== null && amt > bal) {
        S.formErr = 'That is more than your available balance.'; return paint();
      }
      if (!String(S.values.phone || '').trim()) {
        S.formErr = 'Enter the M-Pesa number to send to.'; return paint();
      }
      if (typeof ctx.callWithdraw !== 'function') {
        S.formErr = 'Withdrawal is not available in this workspace.'; return paint();
      }

      if (!S.idem) S.idem = newIdem();
      S.busy = true; paint();

      ctx.callWithdraw({
        amount: amt,
        method: 'mpesa',
        accountNumber: String(S.values.phone).trim(),
        idempotencyKey: S.idem,
      }).then(function (r) {
        if (!alive()) return;
        var d = (r && r.data) || r || {};
        S.busy = false;
        /* THE SERVER'S OWN SENTENCE. Never "sent", never "paid", never a status
           this screen decided. requestSellerPayout returns a `message` for every
           outcome it produces, including the instant path, and that is what the
           merchant reads. */
        S.serverSaid = d.message ||
          'Your withdrawal request was received. Its state will appear under Withdrawals.';
        if (d.deduplicated) {
          S.serverSaid = 'This request was already submitted — it has not been duplicated.';
        }
        S.idem = null;                 /* attempt concluded; a new one gets a new key */
        S.values.amount = '';
        /* The form closes and the merchant lands back on the wallet, where the
           request they just made is now one of the counted states. Leaving the
           form up would invite a second submission of the same withdrawal. */
        S.form = null;
        toast(S.serverSaid);
        paint();                       /* land back on the wallet immediately… */
        refresh();                     /* …then let the server's own state arrive */
      }).catch(function (e) {
        if (!alive()) return;
        S.busy = false;
        /* The key is KEPT on failure: if the request actually landed and only
           the response was lost, retrying with the same key returns the existing
           withdrawal instead of creating a second one. */
        S.formErr = serverMessage(e, 'The withdrawal request could not be submitted.');
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
      if (a === 'withdraw')    return openForm('withdraw');
      if (a === 'cancel')      { S.form = null; S.formErr = null; S.serverSaid = null; S.idem = null; return paint(); }
      if (a === 'do-topup')    return doTopUp();
      if (a === 'do-withdraw') return doWithdraw();
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
      return Promise.all([loadWallet(), loadTx(), loadPayouts()]).then(function () {
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
