/* ════════════════════════════════════════════════════════════════════════════
   SOKONI Merchant Tax — the native surface (2D-2 Tax Stage 2)

       merchant.html → this surface → etimsGetProfile / etimsRegisterSeller /
       etimsUpdateProfile / etimsValidatePin / etimsGetSellerStats /
       etimsGenerateInvoice / etimsBulkGenerate / etimsResubmitInvoice

   Native. No seller.html iframe, no localStorage, no Firestore access.

   ── Account-level, and it says so ───────────────────────────────────────────
   Tax identity is `etimsProfiles/{auth.uid}` — the uid IS the document id. A
   seller with two shops has one KRA PIN, one invoice prefix and one invoice
   sequence across both. The surface states that in the header rather than
   letting a two-shop merchant discover it as a bug. No shopId is sent by any
   call this screen makes; `SokoniMerchantTax.assertNoIdentity` refuses to.

   ── Failure and pending are first-class states ──────────────────────────────
   A tax screen that shows only successes is worse than no screen. Failed
   submissions get their own tab, their KRA error text verbatim, and a Resubmit
   action; pending submissions are labelled as awaiting KRA rather than counted
   as filed. `etimsProcessQueue` runs every five minutes server-side, so
   "queued" is a real state with a real horizon, and the screen says so.

   ── Figures come from the server or show a dash ─────────────────────────────
   Every figure is computed by `etimsGetSellerStats` from invoices the caller
   owns. Nothing is totalled locally — the server truncates its own queries, so
   a client-side sum would silently understate filed VAT. That is the
   fabricated-metric rule (CLAUDE.md) applied to the one screen where being
   wrong is a legal problem rather than a cosmetic one. The lists say they are
   capped instead of implying they are complete.

   ── Credentials are write-only ──────────────────────────────────────────────
   The taxpayer secret and device serial are sent once at registration, stored
   encrypted, and never returned by any bound callable. This surface therefore
   never displays them and never pre-fills them.
   ════════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SokoniMerchantTaxUI = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var CSS_ID = 'sokoni-merchant-tax-css';

  var CSS = [
    '#native-kra-tax{padding:0!important;overflow:hidden!important;display:flex;flex-direction:column}',
    '.mtx{display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden;position:relative;',
      'font-variant-numeric:tabular-nums}',

    '.mtx-top{flex:0 0 auto;padding:12px 14px;border-bottom:1px solid var(--line);background:var(--panel)}',
    '.mtx-scope{display:flex;align-items:center;gap:8px;font-size:11.5px;color:var(--txt3);margin-bottom:10px;line-height:1.4}',
    '.mtx-scope b{color:var(--txt2);font-weight:800}',
    '.mtx-tabs{display:flex;gap:8px;overflow-x:auto;scrollbar-width:none}',
    '.mtx-tabs::-webkit-scrollbar{display:none}',
    '.mtx-tab{flex:0 0 auto;min-height:44px;padding:0 15px;border-radius:12px;border:1px solid var(--line);',
      'background:rgba(255,255,255,.04);color:var(--txt2);font-weight:800;font-size:12.5px;cursor:pointer;font-family:inherit;',
      'display:inline-flex;align-items:center;gap:6px}',
    '.mtx-tab.on{border-color:rgba(113,255,0,.45);background:rgba(113,255,0,.12);color:var(--acc)}',
    '.mtx-tab .n{min-width:19px;height:19px;padding:0 5px;border-radius:9px;background:rgba(255,255,255,.1);',
      'font-size:10.5px;font-weight:900;display:inline-flex;align-items:center;justify-content:center}',
    '.mtx-tab .n.bad{background:rgba(255,92,92,.2);color:#ff9c9c}',

    '.mtx-body{flex:1;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:12px 14px 22px}',

    '.mtx-card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:14px;margin-bottom:11px}',
    '.mtx-card h4{margin:0 0 4px;font-size:13.5px;font-weight:900}',
    '.mtx-card .sub{font-size:11.5px;color:var(--txt3);line-height:1.5;margin-bottom:11px}',

    '.mtx-status{display:flex;align-items:center;gap:11px}',
    '.mtx-dot{flex:0 0 auto;width:11px;height:11px;border-radius:50%;background:var(--txt3)}',
    '.mtx-dot.ok{background:#37e07a;box-shadow:0 0 0 4px rgba(55,224,122,.14)}',
    '.mtx-dot.warn{background:#ffc65c;box-shadow:0 0 0 4px rgba(255,198,92,.14)}',
    '.mtx-statustx{flex:1;min-width:0}',
    '.mtx-statustx .l{font-size:15px;font-weight:900}',
    '.mtx-statustx .s{font-size:11.5px;color:var(--txt3);margin-top:2px;overflow-wrap:anywhere}',

    '.mtx-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(104px,100%),1fr));gap:9px;margin-bottom:12px}',
    '.mtx-kpi{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:11px 12px;min-width:0}',
    '.mtx-kpi .v{font-size:17px;font-weight:900;letter-spacing:-.4px;overflow-wrap:anywhere}',
    '.mtx-kpi .k{font-size:10.5px;color:var(--txt3);margin-top:3px;font-weight:700;text-transform:uppercase;letter-spacing:.4px}',
    '.mtx-kpi.bad .v{color:#ff9c9c}',

    '.mtx-row{display:flex;justify-content:space-between;gap:12px;padding:9px 0;border-bottom:1px solid var(--line);font-size:13px}',
    '.mtx-row:last-child{border-bottom:0}',
    '.mtx-row .k{color:var(--txt3);flex:0 0 auto;font-size:12px}',
    '.mtx-row .v{font-weight:800;text-align:right;overflow-wrap:anywhere;min-width:0}',

    '.mtx-f{margin-bottom:12px}',
    '.mtx-f label{display:block;font-size:11.5px;font-weight:800;color:var(--txt2);margin-bottom:5px}',
    '.mtx-f .hint{font-size:11px;color:var(--txt3);margin-top:4px;line-height:1.45}',
    '.mtx-in,.mtx-sel{width:100%;min-height:46px;padding:11px 12px;border-radius:12px;border:1px solid var(--line);',
      'background:rgba(255,255,255,.04);color:var(--txt);font-size:16px;font-family:inherit;-webkit-appearance:none}',
    '.mtx-in:focus,.mtx-sel:focus{outline:none;border-color:rgba(113,255,0,.5)}',
    '.mtx-in.err{border-color:rgba(255,92,92,.6)}',
    '.mtx-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.6px}',

    '.mtx-btn{width:100%;min-height:48px;border-radius:13px;border:0;background:var(--acc);color:#050505;',
      'font-weight:900;font-size:14px;cursor:pointer;font-family:inherit;display:inline-flex;align-items:center;',
      'justify-content:center;gap:8px}',
    '.mtx-btn[disabled]{opacity:.5;cursor:default}',
    '.mtx-btn.ghost{background:rgba(255,255,255,.06);color:var(--txt);border:1px solid var(--line)}',
    '.mtx-btn.sm{min-height:40px;font-size:12.5px;width:auto;padding:0 15px}',
    '.mtx-btns{display:flex;gap:9px;flex-wrap:wrap}',

    '.mtx-inv{border:1px solid var(--line);border-radius:14px;padding:12px;margin-bottom:9px;background:var(--card)}',
    '.mtx-inv .hd{display:flex;justify-content:space-between;gap:10px;align-items:baseline}',
    '.mtx-inv .no{font-size:13.5px;font-weight:900;overflow-wrap:anywhere;min-width:0}',
    '.mtx-inv .amt{font-size:13.5px;font-weight:900;flex:0 0 auto}',
    '.mtx-inv .meta{font-size:11.5px;color:var(--txt3);margin-top:5px;line-height:1.5;overflow-wrap:anywhere}',
    '.mtx-inv .err{font-size:11.5px;color:#ff9c9c;margin-top:7px;line-height:1.5;overflow-wrap:anywhere;',
      'background:rgba(255,92,92,.08);border:1px solid rgba(255,92,92,.2);border-radius:10px;padding:8px 10px}',
    '.mtx-inv .act{margin-top:10px}',

    '.mtx-note{font-size:11.5px;color:var(--txt3);line-height:1.55;margin-top:10px;overflow-wrap:anywhere}',
    '.mtx-warn{font-size:12px;line-height:1.55;color:#ffc65c;background:rgba(255,198,92,.08);',
      'border:1px solid rgba(255,198,92,.22);border-radius:12px;padding:10px 12px;margin-bottom:11px;overflow-wrap:anywhere}',
    '.mtx-bad{font-size:12.5px;line-height:1.55;color:#ff9c9c;background:rgba(255,92,92,.08);',
      'border:1px solid rgba(255,92,92,.22);border-radius:12px;padding:10px 12px;margin-bottom:11px;overflow-wrap:anywhere}',
    '.mtx-good{font-size:12.5px;line-height:1.55;color:#37e07a;background:rgba(55,224,122,.08);',
      'border:1px solid rgba(55,224,122,.22);border-radius:12px;padding:10px 12px;margin-bottom:11px;overflow-wrap:anywhere}',

    '.mtx-state{text-align:center;padding:40px 22px;color:var(--txt3);font-size:13px;line-height:1.6}',
    '.mtx-state .ic{font-size:34px;margin-bottom:11px}',
    '.mtx-state .hd{font-size:15px;font-weight:900;color:var(--txt);margin-bottom:6px}',
    '.mtx-busy{display:flex;align-items:center;justify-content:center;gap:10px;padding:13px;border-radius:12px;',
      'background:rgba(255,255,255,.05);border:1px solid var(--line);font-size:13px;font-weight:700;color:var(--txt2);margin-top:12px}',
    '.mtx-spin{width:17px;height:17px;flex:0 0 auto;border-radius:50%;border:2px solid rgba(255,255,255,.18);',
      'border-top-color:var(--acc);animation:mtxSpin .7s linear infinite}',
    '@keyframes mtxSpin{to{transform:rotate(360deg)}}',
    '@media (prefers-reduced-motion:reduce){.mtx-spin{animation:none}}',
    '@media (min-width:821px){.mtx-body{max-width:760px;margin:0 auto;width:100%}}',
  ].join('');

  function injectCSS(doc) {
    if (!doc || doc.getElementById(CSS_ID)) return;
    var s = doc.createElement('style');
    s.id = CSS_ID; s.textContent = CSS;
    (doc.head || doc.documentElement).appendChild(s);
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function mount(host, ctx) {
    if (!host) return null;
    var doc = host.ownerDocument || document;
    injectCSS(doc);
    ctx = ctx || {};

    var MT = (typeof globalThis !== 'undefined' && globalThis.SokoniMerchantTax) || null;
    if (!MT) {
      host.innerHTML = '<div class="mtx"><div class="mtx-state"><div class="ic">⚠️</div>' +
        '<div class="hd">Tax is unavailable</div>The tax module did not load. ' +
        'Reopen SOKONI Merchant.</div></div>';
      return null;
    }

    var S = {
      phase: 'loading',     /* loading | not_signed_in | setup | error | ready */
      error: null,
      tab: 'status',        /* status | invoices | failures | settings */
      profile: null,
      stats: null,
      recent: [],
      failed: [],
      recentCap: 0,
      failedCap: 0,
      statsError: null,
      draft: {},            /* settings form */
      reg: {},              /* registration form */
      busy: false,
      busyLabel: '',
      opError: null,
      opDone: null,
      orderId: '',
      bulkStart: '',
      bulkEnd: '',
    };

    function toast(m, k) {
      if (typeof ctx.onToast === 'function') { try { ctx.onToast(m, k); return; } catch (_) {} }
      if (k === 'error') console.error('[merchant tax] ' + m);
    }

    /* ── Load ────────────────────────────────────────────────────────────────
       etimsGetSellerStats returns the profile too, so one call answers both
       "am I set up" and "what has been filed". etimsGetProfile is the fallback
       when stats is unavailable — a merchant who is registered must not be
       shown the setup form because a figures query failed. */
    function load() {
      if (!ctx.scope || !ctx.scope.sellerUid) { S.phase = 'not_signed_in'; paint(); return Promise.resolve(); }
      S.phase = 'loading'; S.error = null; paint();
      return MT.loadStats({ callStats: ctx.callStats }).then(function (r) {
        if (r.ok) {
          if (!r.registered) return loadProfileOnly();
          applyStats(r);
          S.phase = 'ready'; paint();
          return;
        }
        S.statsError = r.error;
        return loadProfileOnly();
      }).catch(function (e) {
        S.statsError = (e && e.message) || 'Your eTIMS figures could not be loaded.';
        return loadProfileOnly();
      });
    }

    function loadProfileOnly() {
      return MT.loadProfile({ callProfile: ctx.callProfile }).then(function (p) {
        if (!p.ok) { S.phase = 'error'; S.error = p.error; paint(); return; }
        if (!p.registered) { S.phase = 'setup'; paint(); return; }
        S.profile = p.profile;
        S.draft = pickEditable(p.profile);
        S.phase = 'ready'; paint();
      }).catch(function (e) {
        S.phase = 'error';
        S.error = (e && e.message) || 'Your tax profile could not be loaded.';
        paint();
      });
    }

    function applyStats(r) {
      S.profile = r.profile;
      S.stats = r.stats;
      S.recent = r.recent || [];
      S.failed = r.failed || [];
      S.recentCap = r.recentCap || 0;
      S.failedCap = r.failedCap || 0;
      S.statsError = null;
      S.draft = pickEditable(r.profile);
    }

    function pickEditable(p) {
      var out = {};
      MT.EDITABLE_FIELDS.forEach(function (f) { out[f.id] = (p && p[f.id] != null) ? String(p[f.id]) : ''; });
      return out;
    }

    /* ── Actions ─────────────────────────────────────────────────────────────
       Every one of these shows its result from the SERVER's response. Nothing
       reports success before the call returns — on a tax screen an optimistic
       "Filed" is a false statement to a merchant about a KRA obligation. */
    function run(label, promiseFactory, onOk) {
      if (S.busy) return;
      S.busy = true; S.busyLabel = label; S.opError = null; S.opDone = null; paint();
      promiseFactory().then(function (r) {
        S.busy = false; S.busyLabel = '';
        if (!r || r.ok === false) {
          S.opError = (r && r.error) || 'That did not work.';
          toast(S.opError, 'error');
          paint();
          return;
        }
        if (onOk) onOk(r);
        paint();
      }).catch(function (e) {
        S.busy = false; S.busyLabel = '';
        S.opError = (e && e.message) || 'That did not work.';
        toast(S.opError, 'error');
        paint();
      });
    }

    function doRegister() {
      var payload;
      try { payload = Object.assign({}, S.reg); }
      catch (e) { S.opError = e.message; paint(); return; }
      run('Registering with KRA…', function () {
        return MT.register(Object.assign({ callRegister: ctx.callRegister }, payload));
      }, function () {
        S.opDone = 'eTIMS registration complete.';
        toast('eTIMS registered', 'ok');
        S.reg = {};
        load();
      });
    }

    function doSaveSettings() {
      var changed;
      try { changed = MT.changedFields(pickEditable(S.profile), S.draft); }
      catch (e) { S.opError = e.message; paint(); return; }
      if (!Object.keys(changed).length) { S.opError = 'Nothing has changed.'; paint(); return; }
      run('Saving…', function () {
        return MT.updateProfile({ callUpdate: ctx.callUpdate, fields: changed });
      }, function () {
        S.opDone = 'Tax settings saved.';
        toast('Saved', 'ok');
        load();
      });
    }

    function doGenerate() {
      run('Generating invoice…', function () {
        return MT.generateInvoice({ callInvoice: ctx.callInvoice, orderId: S.orderId });
      }, function (r) {
        S.opDone = r.invoiceNumber
          ? ('Invoice ' + r.invoiceNumber + ' created.')
          : 'Invoice created and queued for KRA.';
        S.orderId = '';
        toast('Invoice created', 'ok');
        load();
      });
    }

    function doBulk() {
      run('Generating…', function () {
        return MT.bulkGenerate({ callBulk: ctx.callBulk, periodStart: S.bulkStart, periodEnd: S.bulkEnd });
      }, function (r) {
        S.opDone = r.message || 'Bulk invoice created.';
        toast(S.opDone, 'ok');
        load();
      });
    }

    function doResubmit(invoiceId) {
      run('Resubmitting…', function () {
        return MT.resubmitInvoice({ callResubmit: ctx.callResubmit, invoiceId: invoiceId });
      }, function (r) {
        S.opDone = r.message || 'Queued for resubmission.';
        toast(S.opDone, 'ok');
        load();
      });
    }

    /* ── Paint ───────────────────────────────────────────────────────────── */
    function paint() {
      var body;
      if (S.phase === 'loading') {
        body = '<div class="mtx-state"><div class="ic">🧾</div><div class="hd">Loading your tax profile…</div></div>';
        host.innerHTML = '<div class="mtx"><div class="mtx-body">' + body + '</div></div>';
        return;
      }
      if (S.phase === 'not_signed_in') {
        body = '<div class="mtx-state"><div class="ic">🔒</div><div class="hd">Sign in required</div>' +
          'Your KRA tax profile belongs to your SOKONI account.</div>';
        host.innerHTML = '<div class="mtx"><div class="mtx-body">' + body + '</div></div>';
        return;
      }
      if (S.phase === 'error') {
        body = '<div class="mtx-state"><div class="ic">⚠️</div><div class="hd">Tax could not be loaded</div>' +
          esc(S.error || '') + '<div style="margin-top:14px"><button class="mtx-btn sm ghost" data-a="retry">Try again</button></div></div>';
        host.innerHTML = '<div class="mtx"><div class="mtx-body">' + body + '</div></div>';
        bind();
        return;
      }
      if (S.phase === 'setup') { host.innerHTML = '<div class="mtx">' + scopeBar() + '<div class="mtx-body">' + setupView() + '</div></div>'; bind(); return; }

      host.innerHTML = '<div class="mtx">' + scopeBar() + tabs() + '<div class="mtx-body">' + tabView() + '</div></div>';
      bind();
    }

    /* The account-level statement. It is in the chrome, not buried in a help
       panel, because a two-shop merchant needs it before they read a figure. */
    function scopeBar() {
      return '<div class="mtx-top">' +
        '<div class="mtx-scope">🧾&nbsp;<span><b>Account-level.</b> Your KRA PIN, invoice prefix and ' +
        'invoice numbering apply to your whole SOKONI account — every shop you run files under this ' +
        'one taxpayer identity.</span></div>' +
        (S.phase === 'setup' ? '' : tabsInner()) +
        '</div>';
    }
    function tabs() { return ''; }
    function tabsInner() {
      var failedN = (S.stats && S.stats.failedCount) || S.failed.length || 0;
      var t = [
        { id: 'status', label: 'Status' },
        { id: 'invoices', label: 'Invoices' },
        { id: 'failures', label: 'Failures', n: failedN, bad: true },
        { id: 'settings', label: 'Settings' },
      ];
      return '<div class="mtx-tabs" role="tablist">' + t.map(function (x) {
        return '<button class="mtx-tab' + (S.tab === x.id ? ' on' : '') + '" data-tab="' + x.id + '" role="tab"' +
          ' aria-selected="' + (S.tab === x.id ? 'true' : 'false') + '">' + esc(x.label) +
          (x.n ? '<span class="n' + (x.bad ? ' bad' : '') + '">' + esc(String(x.n)) + '</span>' : '') +
          '</button>';
      }).join('') + '</div>';
    }

    function opBanners() {
      var out = '';
      if (S.opError) out += '<div class="mtx-bad">' + esc(S.opError) + '</div>';
      if (S.opDone) out += '<div class="mtx-good">' + esc(S.opDone) + '</div>';
      if (S.busy) out += '<div class="mtx-busy"><span class="mtx-spin"></span>' + esc(S.busyLabel || 'Working…') + '</div>';
      return out;
    }

    function tabView() {
      if (S.tab === 'invoices') return opBanners() + invoicesView();
      if (S.tab === 'failures') return opBanners() + failuresView();
      if (S.tab === 'settings') return opBanners() + settingsView();
      return opBanners() + statusView();
    }

    /* ── Status ──────────────────────────────────────────────────────────── */
    function statusView() {
      var p = S.profile || {};
      var st = MT.statusOf(p);
      var out = '<div class="mtx-card"><div class="mtx-status">' +
        '<span class="mtx-dot ' + esc(st.tone) + '"></span>' +
        '<span class="mtx-statustx"><span class="l">' + esc(st.label) + '</span>' +
        '<span class="s">' + esc(p.businessName || '—') + ' · ' + esc(MT.vatLabel(p.vatStatus)) + '</span></span>' +
        '</div>' +
        '<div style="margin-top:12px">' +
        row('KRA PIN', p.kraPin || '—', true) +
        row('Branch', p.branchId || '—') +
        row('Tax category', p.taxCategory || '—') +
        row('Invoice prefix', p.invoicePrefix || '—') +
        row('Last submission', MT.formatDate(p.lastSubmissionAt)) +
        '</div></div>';

      if (S.statsError) {
        out += '<div class="mtx-warn">Your filed figures could not be loaded — ' + esc(S.statsError) +
          ' The profile above is accurate; the totals are simply unavailable right now.</div>';
      }

      var s = S.stats;
      out += '<div class="mtx-kpis">' +
        kpi(s ? MT.formatKes(s.totalRevenue) : '—', 'Invoiced') +
        kpi(s ? MT.formatKes(s.vatCollected) : '—', 'VAT') +
        kpi(s ? MT.formatCount(s.acceptedCount) : '—', 'Accepted') +
        kpi(s ? MT.formatCount(s.pendingCount) : '—', 'Pending') +
        kpi(s ? MT.formatCount(s.failedCount) : '—', 'Failed', (s && s.failedCount) > 0) +
        '</div>';

      out += '<div class="mtx-note">Figures cover invoices KRA has <b>accepted</b>. Pending submissions ' +
        'are not counted as filed — the submission queue runs every five minutes, and anything still ' +
        'pending after that is worth checking under Failures.</div>';
      return out;
    }

    function row(k, v, mono) {
      return '<div class="mtx-row"><span class="k">' + esc(k) + '</span>' +
        '<span class="v' + (mono ? ' mtx-mono' : '') + '">' + esc(v) + '</span></div>';
    }
    function kpi(v, k, bad) {
      return '<div class="mtx-kpi' + (bad ? ' bad' : '') + '"><div class="v">' + esc(v) + '</div>' +
        '<div class="k">' + esc(k) + '</div></div>';
    }

    /* ── Invoices ────────────────────────────────────────────────────────── */
    function invoicesView() {
      var out = '<div class="mtx-card"><h4>Invoice one order</h4>' +
        '<div class="sub">Creates a KRA invoice for a completed order you sold. The server checks the ' +
        'order belongs to you before anything is submitted.</div>' +
        '<div class="mtx-f"><label for="mtx-order">Order number</label>' +
        '<input class="mtx-in" id="mtx-order" data-f="orderId" value="' + esc(S.orderId) + '" ' +
        'placeholder="e.g. ORD-12345" autocomplete="off" enterkeyhint="go"></div>' +
        '<button class="mtx-btn" data-a="generate"' + (S.busy || !S.orderId ? ' disabled' : '') + '>Generate invoice</button>' +
        '</div>';

      out += '<div class="mtx-card"><h4>Invoice a period</h4>' +
        '<div class="sub">One consolidated invoice for every completed order in a date range. Running ' +
        'the same range twice returns the invoice already created rather than filing it again.</div>' +
        '<div class="mtx-f"><label for="mtx-bs">From</label>' +
        '<input class="mtx-in" id="mtx-bs" type="date" data-f="bulkStart" value="' + esc(S.bulkStart) + '"></div>' +
        '<div class="mtx-f"><label for="mtx-be">To</label>' +
        '<input class="mtx-in" id="mtx-be" type="date" data-f="bulkEnd" value="' + esc(S.bulkEnd) + '"></div>' +
        '<button class="mtx-btn ghost" data-a="bulk"' + (S.busy || !S.bulkStart || !S.bulkEnd ? ' disabled' : '') + '>Generate for period</button>' +
        '</div>';

      out += '<h4 style="margin:16px 0 9px;font-size:13.5px;font-weight:900">Accepted by KRA</h4>';
      if (!S.recent.length) {
        out += '<div class="mtx-state" style="padding:26px 18px"><div class="ic">📄</div>' +
          '<div class="hd">Nothing filed yet</div>Invoices KRA has accepted will appear here.</div>';
      } else {
        out += S.recent.map(invoiceCard).join('');
        if (S.recent.length >= S.recentCap) {
          out += '<div class="mtx-note">Showing the ' + esc(String(S.recentCap)) +
            ' most recent accepted invoices. This is not your full filing history.</div>';
        }
      }
      return out;
    }

    function invoiceCard(i) {
      return '<div class="mtx-inv"><div class="hd">' +
        '<span class="no">' + esc(i.invoiceNumber || i.invoiceId || '—') + '</span>' +
        '<span class="amt">' + esc(MT.formatKes(i.total)) + '</span></div>' +
        '<div class="meta">VAT ' + esc(MT.formatKes(i.vat)) +
        (i.orderId ? ' · Order ' + esc(i.orderId) : '') +
        ' · ' + esc(MT.formatDate(i.createdAt)) +
        (i.receiptNumber ? ' · Receipt ' + esc(i.receiptNumber) : '') + '</div></div>';
    }

    /* ── Failures ────────────────────────────────────────────────────────── */
    function failuresView() {
      if (!S.failed.length) {
        return '<div class="mtx-state"><div class="ic">✅</div><div class="hd">No failed submissions</div>' +
          'Every invoice KRA has responded to was accepted.</div>';
      }
      var out = '<div class="mtx-warn">These invoices were rejected by KRA. The message under each one ' +
        'is KRA\'s own. Fix the underlying cause where you can, then resubmit — resubmitting an invoice ' +
        'KRA already accepted does nothing.</div>';
      out += S.failed.map(function (i, idx) {
        return '<div class="mtx-inv"><div class="hd">' +
          '<span class="no">' + esc(i.invoiceNumber || i.invoiceId || '—') + '</span>' +
          '<span class="amt">' + esc(MT.formatDate(i.createdAt)) + '</span></div>' +
          (i.orderId ? '<div class="meta">Order ' + esc(i.orderId) + '</div>' : '') +
          (i.error ? '<div class="err">' + esc(i.error) + '</div>' : '') +
          (i.invoiceId ? '<div class="act"><button class="mtx-btn sm ghost" data-a="resubmit" data-i="' +
            esc(String(idx)) + '"' + (S.busy ? ' disabled' : '') + '>Resubmit</button></div>' : '') +
          '</div>';
      }).join('');
      if (S.failed.length >= S.failedCap) {
        out += '<div class="mtx-note">Showing the ' + esc(String(S.failedCap)) +
          ' most recent failures. There may be more.</div>';
      }
      return out;
    }

    /* ── Settings ────────────────────────────────────────────────────────── */
    function settingsView() {
      var out = '<div class="mtx-card"><h4>Invoice settings</h4>' +
        '<div class="sub">These apply to every invoice filed under your account.</div>';
      MT.EDITABLE_FIELDS.forEach(function (f) {
        var v = S.draft[f.id] == null ? '' : String(S.draft[f.id]);
        out += '<div class="mtx-f"><label for="mtx-' + esc(f.id) + '">' + esc(f.label) + '</label>';
        if (f.options) {
          out += '<select class="mtx-sel" id="mtx-' + esc(f.id) + '" data-d="' + esc(f.id) + '">' +
            f.options.map(function (o) {
              return '<option value="' + esc(o) + '"' + (v === o ? ' selected' : '') + '>' +
                esc(f.id === 'vatStatus' ? MT.vatLabel(o) : o) + '</option>';
            }).join('') + '</select>';
        } else {
          out += '<input class="mtx-in" id="mtx-' + esc(f.id) + '" data-d="' + esc(f.id) + '" ' +
            'value="' + esc(v) + '" maxlength="' + esc(String(f.max)) + '" autocomplete="off">';
        }
        if (f.hint) out += '<div class="hint">' + esc(f.hint) + '</div>';
        out += '</div>';
      });
      out += '<button class="mtx-btn" data-a="save"' + (S.busy ? ' disabled' : '') + '>Save settings</button></div>';

      out += '<div class="mtx-card"><h4>Taxpayer identity</h4>' +
        '<div class="sub">Your KRA PIN, branch and eTIMS device credentials were set when you registered ' +
        'and cannot be edited here. Changing a taxpayer identity is a KRA matter, not a settings toggle.</div>' +
        row('KRA PIN', (S.profile && S.profile.kraPin) || '—', true) +
        row('Branch', (S.profile && S.profile.branchId) || '—') +
        row('Registered', MT.formatDate(S.profile && S.profile.enabledAt)) +
        '<div class="mtx-note">Your taxpayer secret and device serial are stored encrypted and are never ' +
        'shown back to anyone, including you. To replace them, contact support.</div></div>';
      return out;
    }

    /* ── Setup ───────────────────────────────────────────────────────────── */
    function setupView() {
      var pinIssue = S.reg.kraPin ? MT.pinProblem(S.reg.kraPin) : null;
      var out = opBanners();
      out += '<div class="mtx-card"><h4>Set up KRA eTIMS</h4>' +
        '<div class="sub">SOKONI files your sales invoices to KRA electronically. You need your KRA PIN ' +
        'and the device serial and taxpayer secret KRA issued for eTIMS.</div>' +

        field('kraPin', 'KRA PIN', 'text', 'P051234567T', 'mtx-mono', pinIssue) +
        field('businessName', 'Business name', 'text', 'As registered with KRA') +
        field('branchId', 'Branch ID', 'text', '00') +
        field('deviceSerial', 'eTIMS device serial', 'text', 'From your KRA eTIMS registration') +
        field('taxpayerSecret', 'Taxpayer secret', 'password', 'Stored encrypted, never shown again') +
        field('invoicePrefix', 'Invoice prefix', 'text', 'INV') +
        field('address', 'Business address', 'text', '') +
        field('phone', 'Business phone', 'text', '') +

        '<div class="mtx-note">Your PIN is checked with KRA before the profile is activated. If KRA ' +
        'rejects it, nothing is saved and you will see their reason.</div>' +
        '<div style="margin-top:13px"><button class="mtx-btn" data-a="register"' +
        (S.busy ? ' disabled' : '') + '>Register with KRA</button></div>' +
        '</div>';
      return out;
    }

    function field(id, label, type, hint, cls, issue) {
      var v = S.reg[id] == null ? '' : String(S.reg[id]);
      return '<div class="mtx-f"><label for="mtx-r-' + esc(id) + '">' + esc(label) + '</label>' +
        '<input class="mtx-in ' + (cls || '') + (issue ? ' err' : '') + '" id="mtx-r-' + esc(id) + '" ' +
        'data-r="' + esc(id) + '" type="' + esc(type || 'text') + '" value="' + esc(v) + '" ' +
        'autocomplete="off" autocapitalize="' + (id === 'kraPin' ? 'characters' : 'off') + '">' +
        (issue ? '<div class="hint" style="color:#ff9c9c">' + esc(issue) + '</div>'
               : (hint ? '<div class="hint">' + esc(hint) + '</div>' : '')) +
        '</div>';
    }

    /* ── Binding ─────────────────────────────────────────────────────────────
       Actions carry an INDEX, never interpolated data — esc() is not safe in an
       inline handler position, and this surface has no inline handlers at all. */
    function bind() {
      host.querySelectorAll('[data-tab]').forEach(function (b) {
        b.addEventListener('click', function () {
          S.tab = b.getAttribute('data-tab'); S.opError = null; S.opDone = null; paint();
        });
      });
      host.querySelectorAll('[data-d]').forEach(function (el) {
        el.addEventListener('input', function () { S.draft[el.getAttribute('data-d')] = el.value; });
        el.addEventListener('change', function () { S.draft[el.getAttribute('data-d')] = el.value; });
      });
      host.querySelectorAll('[data-r]').forEach(function (el) {
        el.addEventListener('input', function () { S.reg[el.getAttribute('data-r')] = el.value; });
      });
      /* These fields never trigger a repaint. Rebuilding the panel while the
         merchant is filling it in destroys the field under their cursor — and
         on a date input, `change` fires on every picker interaction. Only the
         buttons' enabled state depends on them, so only that is updated. */
      function syncActionButtons() {
        var g = host.querySelector('[data-a="generate"]');
        if (g) g.disabled = S.busy || !S.orderId;
        var b = host.querySelector('[data-a="bulk"]');
        if (b) b.disabled = S.busy || !S.bulkStart || !S.bulkEnd;
      }
      host.querySelectorAll('[data-f]').forEach(function (el) {
        var k = el.getAttribute('data-f');
        var onEdit = function () { S[k] = el.value; syncActionButtons(); };
        el.addEventListener('input', onEdit);
        el.addEventListener('change', onEdit);
      });
      host.querySelectorAll('[data-a]').forEach(function (b) {
        b.addEventListener('click', function () {
          var a = b.getAttribute('data-a');
          if (a === 'retry') { load(); return; }
          if (a === 'register') { doRegister(); return; }
          if (a === 'save') { doSaveSettings(); return; }
          if (a === 'generate') { doGenerate(); return; }
          if (a === 'bulk') { doBulk(); return; }
          if (a === 'resubmit') {
            var i = S.failed[Number(b.getAttribute('data-i'))];
            if (i && i.invoiceId) doResubmit(i.invoiceId);
            return;
          }
        });
      });
    }

    load();

    return {
      refresh: load,
      state: function () { return S; },
      destroy: function () { try { host.innerHTML = ''; } catch (_) {} },
    };
  }

  return { mount: mount, CSS_ID: CSS_ID };
}));
