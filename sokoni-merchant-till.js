/* ================================================================
   SOKONI Merchant V2 — Till & QR surface (Till Approval Automation, Part 2)

   window.SokoniMerchantTill.mount(host, ctx) -> { refresh, destroy }
   Same module-adapter contract every other Merchant V2 "ported surface"
   uses (merchant-v2.html's MODULES table / renderModule).

   ctx supplies: scope ({ok, sellerUid, shopId}), shopName, and the
   callables this surface needs (callMyTill, callActivity,
   callMintDynamicQR, callCreateIntent, callSetStatus, onToast).

   THE INVARIANT THIS FILE EXISTS TO PRESERVE: the Till shown here is
   ALWAYS resolved from ctx.scope (the shell's own, auth-corroborated
   shop resolution) — never from a Till id typed into a URL, a query
   string, or any field this page itself renders. getMySokoniTill's own
   server-side check (functions/sokoni-till.js) is the actual authority;
   this file never tries to be a second one.

   Till creation is NOT a control on this page, deliberately — Till
   Approval Automation (docs/TILL_APPROVAL_AUTOMATION.md) issues it
   server-side on merchant approval. A merchant who sees "no Till yet"
   is told why, not handed a "Generate" button that would resurrect the
   exact self-service dependency this feature replaces.
================================================================ */
(function (root) {
  'use strict';

  var CSS_ID = 'sk-till-css';
  var CSS = [
    '.sk-till-grid{display:grid;grid-template-columns:1fr;gap:14px;padding:14px}',
    '@media (min-width:821px){.sk-till-grid{grid-template-columns:1fr 1fr}}',
    '.sk-till-card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:16px}',
    '.sk-till-card h3{margin:0 0 10px;font-size:15px;font-weight:800;color:var(--txt)}',
    '.sk-till-card dl{display:grid;grid-template-columns:auto 1fr;gap:6px 12px;margin:0;font-size:13px}',
    '.sk-till-card dt{color:var(--txt3)}',
    '.sk-till-card dd{margin:0;color:var(--txt);font-weight:700;text-align:right}',
    '.sk-till-status.ok{color:var(--acc)}',
    '.sk-till-status.warn{color:#ffc45e}',
    '.sk-till-hint{font-size:12px;color:var(--txt3);line-height:1.5;margin:0 0 10px}',
    '.sk-till-qr{min-height:200px;display:flex;align-items:center;justify-content:center}',
    '.sk-till-qr canvas{max-width:100%;border-radius:10px;background:#fff;padding:8px}',
    '.sk-till-dynamic{display:flex;flex-direction:column;gap:8px;margin-bottom:10px}',
    '.sk-till-dynamic input{background:var(--surface);border:1px solid var(--line);border-radius:10px;',
      'padding:10px 12px;color:var(--txt);font-size:14px}',
    '.sk-till-dynamic button{background:var(--acc);color:#050505;border:none;border-radius:10px;',
      'padding:10px;font-weight:800;cursor:pointer}',
    '.sk-till-dynamic-msg{font-size:12.5px;color:var(--txt2);margin-bottom:10px}',
    '.sk-till-activity{position:relative}',
    '.sk-till-refresh{position:absolute;top:14px;right:16px;background:transparent;border:1px solid var(--line);',
      'color:var(--txt2);border-radius:8px;padding:4px 10px;font-size:11.5px;cursor:pointer}',
    '.sk-till-activity-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}',
    '.sk-till-activity-list li{display:flex;justify-content:space-between;font-size:13px;',
      'border-bottom:1px solid var(--line);padding-bottom:8px}',
    '.sk-till-activity-date{color:var(--txt3);font-size:12px}',
    '.sk-till-state{padding:32px 16px;text-align:center;color:var(--txt2);font-size:13px}',
    '.sk-till-state b{display:block;color:var(--txt);font-size:15px;margin-bottom:6px}',
    '.sk-till-err button{margin-top:10px;background:transparent;border:1px solid var(--line);',
      'color:var(--txt);border-radius:8px;padding:8px 14px;cursor:pointer}',
  ].join('');

  function injectCSS(doc) {
    if (!doc || doc.getElementById(CSS_ID)) return;
    var s = doc.createElement('style');
    s.id = CSS_ID; s.textContent = CSS;
    (doc.head || doc.documentElement).appendChild(s);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fmtAmount(amount, currency) {
    var n = Number(amount || 0);
    return (currency || 'KES') + ' ' + n.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function fmtDate(ms) {
    if (!ms) return '—';
    try { return new Date(ms).toLocaleString('en-KE', { dateStyle: 'medium', timeStyle: 'short' }); }
    catch (_) { return '—'; }
  }

  var STATUS_LABEL = { ACTIVE: 'Active', DISABLED: 'Disabled', RETIRED: 'Retired' };

  function mount(host, ctx) {
    var destroyed = false;
    var state = { till: null, activity: [], loading: true, error: null };

    injectCSS(host.ownerDocument);
    host.innerHTML = '<div class="sk-till"></div>';
    var root = host.querySelector('.sk-till');

    function toast(msg, kind) {
      if (ctx.onToast) { try { ctx.onToast(msg, kind); } catch (_) {} }
    }

    function renderLoading() {
      root.innerHTML = '<div class="sk-till-state"><span>Loading your Till…</span></div>';
    }

    function renderNoScope() {
      root.innerHTML = '<div class="sk-till-state"><b>No shop resolved yet.</b>' +
        '<p>Sign in to your shop to see its SOKONI Till.</p></div>';
    }

    function renderNoTill() {
      root.innerHTML =
        '<div class="sk-till-state">' +
        '<b>Your SOKONI Till has not been issued yet.</b>' +
        '<p>A Till is issued automatically once your shop application is approved — ' +
        'there is nothing to press here. If your shop is already approved and this ' +
        'message persists, contact SOKONI support.</p>' +
        '</div>';
    }

    function renderError(message) {
      root.innerHTML = '<div class="sk-till-state sk-till-err"><b>Could not load your Till.</b>' +
        '<p>' + esc(message || 'Something went wrong.') + '</p>' +
        '<button type="button" data-act="retry">Try again</button></div>';
      var btn = root.querySelector('[data-act="retry"]');
      if (btn) btn.addEventListener('click', load);
    }

    function drawQR(canvasHost, url) {
      canvasHost.innerHTML = '';
      if (!(root.ownerDocument.defaultView.SokoniQR && url)) {
        canvasHost.textContent = 'QR unavailable';
        return;
      }
      try {
        var canvas = root.ownerDocument.defaultView.SokoniQR.generateCanvas(url, 200);
        canvasHost.appendChild(canvas);
      } catch (e) {
        canvasHost.textContent = 'QR could not be drawn.';
      }
    }

    function renderMain() {
      var t = state.till;
      var statusLabel = STATUS_LABEL[t.status] || t.status;
      var statusClass = t.status === 'ACTIVE' ? 'ok' : 'warn';

      root.innerHTML =
        '<div class="sk-till-grid">' +
          '<section class="sk-till-card">' +
            '<h3>SOKONI Till</h3>' +
            '<dl>' +
              '<dt>Till ID</dt><dd>' + esc(t.sokoniTillId) + '</dd>' +
              '<dt>Shop</dt><dd>' + esc(ctx.shopName || t.shopId) + '</dd>' +
              '<dt>Branch</dt><dd>' + esc(t.branchId) + '</dd>' +
              '<dt>Status</dt><dd class="sk-till-status ' + statusClass + '">' + esc(statusLabel) + '</dd>' +
            '</dl>' +
          '</section>' +

          '<section class="sk-till-card">' +
            '<h3>Permanent QR</h3>' +
            '<p class="sk-till-hint">Print this once. Every scan lets a customer pay whatever amount they enter.</p>' +
            '<div class="sk-till-qr" data-qr="permanent"></div>' +
          '</section>' +

          '<section class="sk-till-card">' +
            '<h3>Dynamic QR (POS sale)</h3>' +
            '<p class="sk-till-hint">Enter the sale amount, generate a one-time QR for this exact sale.</p>' +
            '<div class="sk-till-dynamic">' +
              '<input type="number" min="1" step="1" placeholder="Amount (KES)" data-f="amount">' +
              '<input type="text" maxlength="120" placeholder="What is this sale for? (optional)" data-f="note">' +
              '<button type="button" data-act="gen-dynamic">Generate QR</button>' +
            '</div>' +
            '<div class="sk-till-dynamic-msg" data-el="dynamic-msg" hidden></div>' +
            '<div class="sk-till-qr" data-qr="dynamic" hidden></div>' +
          '</section>' +

          '<section class="sk-till-card sk-till-activity">' +
            '<h3>Payment activity</h3>' +
            '<button type="button" class="sk-till-refresh" data-act="refresh-activity">↻ Refresh</button>' +
            '<div data-el="activity-list">' + renderActivityList() + '</div>' +
          '</section>' +
        '</div>';

      drawQR(root.querySelector('[data-qr="permanent"]'), t.qrUrl);

      var genBtn = root.querySelector('[data-act="gen-dynamic"]');
      if (genBtn) genBtn.addEventListener('click', onGenerateDynamic);

      var refreshBtn = root.querySelector('[data-act="refresh-activity"]');
      if (refreshBtn) refreshBtn.addEventListener('click', function () {
        refreshBtn.disabled = true;
        loadActivity().then(function () {
          var el = root.querySelector('[data-el="activity-list"]');
          if (el) el.innerHTML = renderActivityList();
          refreshBtn.disabled = false;
        });
      });
    }

    function renderActivityList() {
      if (!state.activity.length) {
        return '<p class="sk-till-hint">No payments recorded for this Till yet.</p>';
      }
      return '<ul class="sk-till-activity-list">' + state.activity.map(function (a) {
        return '<li><span>' + fmtAmount(a.amount, a.currency) + '</span>' +
          '<span class="sk-till-activity-date">' + fmtDate(a.paidAt) + '</span></li>';
      }).join('') + '</ul>';
    }

    function onGenerateDynamic() {
      var amountEl = root.querySelector('[data-f="amount"]');
      var noteEl = root.querySelector('[data-f="note"]');
      var msgEl = root.querySelector('[data-el="dynamic-msg"]');
      var qrEl = root.querySelector('[data-qr="dynamic"]');
      var amount = Number(amountEl && amountEl.value);

      msgEl.hidden = true;
      qrEl.hidden = true;

      if (!(amount > 0)) {
        msgEl.hidden = false; msgEl.textContent = 'Enter a valid amount.';
        return;
      }
      var note = (noteEl && noteEl.value || '').trim();
      var genBtn = root.querySelector('[data-act="gen-dynamic"]');
      if (genBtn) { genBtn.disabled = true; genBtn.textContent = 'Generating…'; }

      /* Server derives everything from here: createPaymentIntent's own
         pos_till_sale pricer sums `items` itself — this page's `amount`
         field is only the SEED for one free-form line item, never trusted
         downstream as-is (functions/sokoni-qr-authority.js priceTillSale). */
      ctx.callCreateIntent({
        purpose: 'pos_till_sale',
        sokoniTillId: state.till.sokoniTillId,
        items: [{ name: note || 'Sale', price: amount, qty: 1 }],
      }).then(function (r) {
        return ctx.callMintDynamicQR({ ref: r.data.ref });
      }).then(function (r) {
        qrEl.hidden = false;
        drawQR(qrEl, r.data.qrUrl);
        msgEl.hidden = false;
        msgEl.textContent = 'QR ready — ' + fmtAmount(r.data.amount, r.data.currency) + '. Let the customer scan it.';
      }).catch(function (e) {
        msgEl.hidden = false;
        msgEl.textContent = (e && e.message) || 'Could not generate the QR.';
      }).finally(function () {
        if (genBtn) { genBtn.disabled = false; genBtn.textContent = 'Generate QR'; }
      });
    }

    function loadActivity() {
      if (!state.till) return Promise.resolve();
      return ctx.callActivity({ sokoniTillId: state.till.sokoniTillId })
        .then(function (r) { state.activity = (r.data && r.data.items) || []; })
        .catch(function () { state.activity = []; });
    }

    function load() {
      if (destroyed) return;
      var scope = ctx.scope;
      if (!scope || !scope.ok) { renderNoScope(); return; }

      renderLoading();
      ctx.callMyTill({ shopId: scope.shopId })
        .then(function (r) {
          if (destroyed) return;
          if (!r.data || !r.data.exists) { renderNoTill(); return; }
          state.till = r.data;
          return loadActivity().then(function () {
            if (!destroyed) renderMain();
          });
        })
        .catch(function (e) {
          if (!destroyed) renderError(e && e.message);
        });
    }

    load();

    return {
      refresh: load,
      destroy: function () { destroyed = true; },
    };
  }

  root.SokoniMerchantTill = { mount: mount };
})(typeof window !== 'undefined' ? window : globalThis);
