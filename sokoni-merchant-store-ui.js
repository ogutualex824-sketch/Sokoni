/* ════════════════════════════════════════════════════════════════════════════
   SOKONI Merchant Store — the native surface (2D-2 Store Stage 2)

       merchant.html → this surface → getMyMinishop / saveMinishopConfig /
       claimMinishopHandle / getMinishopAnalytics / generateMinishopShareCard

   Native. No seller.html iframe, no localStorage, no Firestore access.

   ── The shopId is learned, not assumed ──────────────────────────────────────
   `getMyMinishop` resolves the shop from the signed-in account and returns its
   id. Every later call passes that value back, where the server verifies it
   again. Nothing here reads `SokoniShell.activeShopId`, and an account with no
   shop gets an honest empty state rather than a screen scoped to a guess.

   ── One follower count, from the authority ──────────────────────────────────
   `getMinishopAnalytics` is the only source. The surface does not count
   followers and does not cache the number — Store Stage 1B removed the second
   authority, and adding one back on the client would be the same defect wearing
   a different hat.

   ── Save states a merchant can trust ────────────────────────────────────────
   A save shows Saving → Saved from the SERVER's response, never optimistically.
   On refusal the form keeps the merchant's text, states the server's reason, and
   the previously-saved values remain what they were — a screen that clears a
   rejected edit loses work and teaches the merchant not to trust it.
   ════════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SokoniMerchantStoreUI = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var CSS_ID = 'sokoni-merchant-store-css';

  var CSS = [
    '#native-shop{padding:0!important;overflow:hidden!important;display:flex;flex-direction:column}',
    '.mst{display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden;position:relative;',
      'font-variant-numeric:tabular-nums}',

    '.mst-top{flex:0 0 auto;padding:12px 14px;border-bottom:1px solid var(--line);background:var(--panel)}',
    '.mst-tabs{display:flex;gap:8px;overflow-x:auto;scrollbar-width:none}',
    '.mst-tabs::-webkit-scrollbar{display:none}',
    '.mst-tab{flex:0 0 auto;min-height:44px;padding:0 15px;border-radius:12px;border:1px solid var(--line);',
      'background:rgba(255,255,255,.04);color:var(--txt2);font-weight:800;font-size:12.5px;cursor:pointer;font-family:inherit}',
    '.mst-tab.on{border-color:rgba(113,255,0,.45);background:rgba(113,255,0,.12);color:var(--acc)}',

    '.mst-body{flex:1;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:12px 14px 18px}',

    '.mst-card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:14px;margin-bottom:11px}',
    '.mst-id{display:flex;align-items:center;gap:13px}',
    '.mst-av{flex:0 0 auto;width:54px;height:54px;border-radius:17px;background:rgba(113,255,0,.12);',
      'border:1px solid rgba(113,255,0,.3);color:var(--acc);display:flex;align-items:center;',
      'justify-content:center;font-weight:900;font-size:18px}',
    '.mst-idinfo{flex:1;min-width:0}',
    '.mst-nm{font-size:16px;font-weight:900;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.mst-handle{font-size:12.5px;color:var(--acc);margin-top:3px;overflow-wrap:anywhere}',
    '.mst-nohandle{font-size:12px;color:var(--txt3);margin-top:3px}',

    '.mst-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(96px,100%),1fr));gap:9px;margin-bottom:12px}',
    '.mst-kpi{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:11px 12px}',
    '.mst-kpi .v{font-size:19px;font-weight:900;color:var(--acc);line-height:1.1}',
    '.mst-kpi .k{font-size:10px;color:var(--txt3);text-transform:uppercase;letter-spacing:.04em;margin-top:3px}',

    '.mst-lbl{font-size:11px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:var(--txt3);margin:16px 0 7px}',
    '.mst-lbl:first-child{margin-top:0}',
    '.mst-hint{font-size:11px;color:var(--txt3);margin:-3px 0 7px;line-height:1.45}',
    '.mst-inp{width:100%;min-height:52px;background:rgba(255,255,255,.06);border:1px solid var(--line);',
      'border-radius:13px;padding:14px;color:var(--txt);font-size:16px;font-family:inherit;outline:none;resize:vertical}',
    '.mst-inp:focus{border-color:rgba(113,255,0,.42)}',
    '.mst-inp[disabled]{opacity:.6}',
    '.mst-cnt{font-size:10.5px;color:var(--txt3);text-align:right;margin-top:4px}',
    '.mst-cnt.over{color:#ff9a9a;font-weight:800}',

    '.mst-btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:48px;',
      'padding:0 20px;border-radius:13px;font-weight:800;font-size:14px;cursor:pointer;font-family:inherit;',
      'border:1px solid rgba(113,255,0,.32);background:rgba(113,255,0,.13);color:var(--acc)}',
    '.mst-btn.ghost{background:rgba(255,255,255,.05);border-color:var(--line);color:var(--txt2)}',
    '.mst-btn.solid{background:var(--acc);border-color:var(--acc);color:#000}',
    '.mst-btn[disabled]{opacity:.5;cursor:default}',
    '.mst-btn.wide{width:100%}',
    '.mst-cta{flex:0 0 auto;padding:11px 14px;border-top:1px solid var(--line);',
      'background:linear-gradient(180deg,#0c0c0c,#080808)}',

    '.mst-link{display:flex;gap:8px;margin-top:8px}',
    '.mst-link input{flex:1;min-width:0;height:48px;background:rgba(255,255,255,.06);border:1px solid var(--line);',
      'border-radius:12px;padding:0 12px;color:var(--txt);font-size:12.5px;font-family:inherit;outline:none}',

    '.mst-state{padding:40px 24px;text-align:center;color:var(--txt2);font-size:13.5px;line-height:1.6}',
    '.mst-state .ic{font-size:36px;margin-bottom:12px}',
    '.mst-state .hd{font-weight:800;font-size:15px;color:var(--txt);margin-bottom:8px}',
    '.mst-banner{padding:11px 13px;border-radius:12px;background:rgba(255,255,255,.04);border:1px solid var(--line);',
      'font-size:11.5px;color:var(--txt2);line-height:1.55;margin-bottom:12px}',
    '.mst-banner b{color:var(--txt)}',
    '.mst-err{padding:12px 14px;border-radius:13px;background:rgba(255,90,90,.10);border:1px solid rgba(255,90,90,.34);',
      'color:#ff9a9a;font-size:12.5px;font-weight:700;line-height:1.5;margin-top:12px}',
    '.mst-ok{padding:12px 14px;border-radius:13px;background:rgba(113,255,0,.10);border:1px solid rgba(113,255,0,.3);',
      'color:var(--acc);font-size:12.5px;font-weight:800;margin-top:12px}',
    '.mst-prog{display:flex;align-items:center;gap:11px;padding:13px 14px;border-radius:13px;',
      'background:rgba(255,255,255,.05);border:1px solid var(--line);font-size:13px;font-weight:700;color:var(--txt2);margin-top:12px}',
    '.mst-spin{width:17px;height:17px;flex:0 0 auto;border-radius:50%;border:2px solid rgba(255,255,255,.18);',
      'border-top-color:var(--acc);animation:mstSpin .7s linear infinite}',
    '@keyframes mstSpin{to{transform:rotate(360deg)}}',
    '@media (prefers-reduced-motion:reduce){.mst-spin{animation:none}}',
    /* ── Grouped, premium form ──────────────────────────────────────────────── */
    '.mst-group{background:var(--card);border:1px solid var(--line);border-radius:16px;',
      'padding:14px 14px 4px;margin-bottom:12px}',
    '.mst-gt{margin:0;font-size:13px;font-weight:900;letter-spacing:.01em;color:var(--txt)}',
    '.mst-gh{margin:4px 0 10px;font-size:11.5px;color:var(--txt3);line-height:1.5}',
    '.mst-field{margin-bottom:14px}',
    '.mst-fe{margin-top:6px;font-size:11.5px;font-weight:700;color:#ff9a9a;line-height:1.45}',

    /* Previews: the merchant sees the effect, not just a URL. */
    '.mst-pv{margin:0 0 9px;border-radius:13px;border:1px solid var(--line);background-size:cover;',
      'background-position:center;background-repeat:no-repeat;display:flex;align-items:center;',
      'justify-content:center;color:var(--txt3);font-size:11px;background-color:rgba(255,255,255,.04)}',
    '.mst-pv-logo{width:84px;height:84px;border-radius:22px}',
    '.mst-pv-cover{width:100%;aspect-ratio:16/6}',
    '.mst-pv.empty{border-style:dashed}',

    /* Colour: a swatch, a native picker and a text field — ONE draft value. */
    '.mst-color{display:flex;align-items:center;gap:9px;flex-wrap:wrap}',
    '.mst-sw{flex:0 0 auto;width:34px;height:34px;border-radius:10px;border:1px solid var(--line)}',
    '.mst-cp{flex:0 0 auto;width:46px;height:44px;padding:0;border:1px solid var(--line);',
      'border-radius:10px;background:transparent;cursor:pointer}',
    '.mst-color-tx{flex:1;min-width:120px;min-height:44px}',

    /* Chips: array fields, added and removed one at a time. */
    '.mst-chips{display:flex;flex-wrap:wrap;gap:7px;align-items:center;padding:9px;border-radius:13px;',
      'border:1px solid var(--line);background:rgba(255,255,255,.05)}',
    '.mst-chip{display:inline-flex;align-items:center;gap:6px;padding:7px 8px 7px 11px;border-radius:999px;',
      'background:rgba(113,255,0,.12);border:1px solid rgba(113,255,0,.3);color:var(--acc);',
      'font-size:12.5px;font-weight:800;max-width:100%;overflow-wrap:anywhere}',
    '.mst-chip-x{min-width:26px;min-height:26px;border:0;border-radius:50%;background:rgba(0,0,0,.28);',
      'color:inherit;font-size:15px;line-height:1;cursor:pointer;font-family:inherit}',
    '.mst-chip-in{flex:1;min-width:110px;min-height:38px;background:transparent;border:0;outline:none;',
      'color:var(--txt);font-size:15px;font-family:inherit}',

    '@media (min-width:821px){.mst-body{max-width:760px;margin:0 auto;width:100%}}',
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

  function initials(s) {
    var t = String(s || '').trim();
    if (!t) return '🏬';
    var p = t.split(/\s+/).filter(Boolean);
    return ((p[0] || '').charAt(0) + (p.length > 1 ? (p[p.length - 1] || '').charAt(0) : '')).toUpperCase() || '🏬';
  }

  function mount(host, ctx) {
    if (!host) return null;
    var doc = host.ownerDocument || document;
    injectCSS(doc);
    ctx = ctx || {};

    var MS = (typeof globalThis !== 'undefined' && globalThis.SokoniMerchantStore) || null;
    if (!MS) {
      host.innerHTML = '<div class="mst"><div class="mst-state"><div class="ic">⚠️</div>' +
        '<div class="hd">Store is unavailable</div>The store module did not load. ' +
        'Reopen SOKONI Merchant.</div></div>';
      return null;
    }

    var S = {
      phase: 'loading',       /* loading | not_signed_in | no_shop | error | ready */
      error: null,
      tab: 'storefront',      /* storefront | details | share */
      shopId: null,           /* learned from the SERVER, never assumed */
      handle: null,
      url: null,
      saved: {},              /* what the server last returned */
      draft: {},              /* what the merchant has typed */
      analytics: null,
      analyticsError: null,
      busy: false,
      opError: null,
      opDone: null,
      handleDraft: '',
      share: null,
    };

    function toast(m, k) {
      if (typeof ctx.onToast === 'function') { try { ctx.onToast(m, k); return; } catch (_) {} }
      if (k === 'error') console.error('[merchant store] ' + m);
    }

    function load() {
      if (!ctx.scope || !ctx.scope.sellerUid) { S.phase = 'not_signed_in'; paint(); return Promise.resolve(); }
      S.phase = 'loading'; paint();
      return MS.loadIdentity({ callIdentity: ctx.callIdentity }).then(function (r) {
        if (!r.ok) { S.phase = 'error'; S.error = r.error; paint(); return; }
        if (!r.hasShop) { S.phase = 'no_shop'; paint(); return; }
        S.shopId = r.shopId;
        S.handle = r.handle;
        S.url = r.url;
        S.saved = r.config || {};
        S.draft = Object.assign({}, S.saved);
        S.phase = 'ready'; paint();
        return loadAnalytics();
      }).catch(function (e) {
        S.phase = 'error'; S.error = (e && e.message) || 'Your shop could not be loaded.'; paint();
      });
    }

    /* Analytics is a secondary read: its failure must not blank the shop. */
    function loadAnalytics() {
      if (typeof ctx.callAnalytics !== 'function' || !S.shopId) return Promise.resolve();
      return MS.loadAnalytics({ shopId: S.shopId, callAnalytics: ctx.callAnalytics }).then(function (r) {
        if (r.ok) { S.analytics = r; S.analyticsError = null; }
        else { S.analytics = null; S.analyticsError = r.error; }
        if (S.phase === 'ready') paint();
      }).catch(function () {});
    }

    /* ── Render ───────────────────────────────────────────────────────────── */
    function paint() {
      host.innerHTML = '<div class="mst">' + topHTML() + bodyHTML() + ctaHTML() + '</div>';
    }

    function topHTML() {
      if (S.phase !== 'ready') return '';
      return '<div class="mst-top"><div class="mst-tabs">' +
        '<button class="mst-tab' + (S.tab === 'storefront' ? ' on' : '') + '" data-act="tab" data-t="storefront">Storefront</button>' +
        '<button class="mst-tab' + (S.tab === 'details' ? ' on' : '') + '" data-act="tab" data-t="details">Details</button>' +
        '<button class="mst-tab' + (S.tab === 'share' ? ' on' : '') + '" data-act="tab" data-t="share">Share</button>' +
      '</div></div>';
    }

    function ctaHTML() {
      if (S.phase !== 'ready' || S.tab !== 'details') return '';
      var changed = Object.keys(MS.changedFields(S.saved, S.draft)).length;
      return '<div class="mst-cta"><button class="mst-btn solid wide" data-act="save"' +
        (S.busy || !changed ? ' disabled' : '') + '>' +
        (S.busy ? 'Saving…' : (changed ? 'Save ' + changed + ' change' + (changed === 1 ? '' : 's') : 'No changes to save')) +
      '</button></div>';
    }

    function bodyHTML() {
      if (S.phase === 'loading') {
        return '<div class="mst-body"><div class="sk-line" style="width:70%"></div>' +
          '<div class="sk-line" style="width:52%"></div><div class="sk-line" style="width:62%"></div></div>';
      }
      if (S.phase === 'not_signed_in') {
        return '<div class="mst-body"><div class="mst-state"><div class="ic">🔒</div>' +
          '<div class="hd">Sign in to manage your shop</div></div></div>';
      }
      if (S.phase === 'no_shop') {
        /* The honest answer, and deliberately NOT a fallback to the uid. */
        return '<div class="mst-body"><div class="mst-state"><div class="ic">🏬</div>' +
          '<div class="hd">You do not have a shop yet</div>' +
          'A storefront belongs to an approved shop. Once your merchant application is approved, ' +
          'your shop appears here and you can name it, claim a handle and share it.' +
          '</div></div>';
      }
      if (S.phase === 'error') {
        return '<div class="mst-body"><div class="mst-state"><div class="ic">⚠️</div>' +
          '<div class="hd">Your shop could not be loaded</div>' + esc(S.error || '') +
          '<div style="margin-top:18px"><button class="mst-btn" data-act="reload">Try again</button></div>' +
          '</div></div>';
      }
      if (S.tab === 'details') return detailsHTML();
      if (S.tab === 'share') return shareHTML();
      return storefrontHTML();
    }

    function identityCard() {
      var name = S.saved.tagline || S.handle || 'Your shop';
      return '<div class="mst-card"><div class="mst-id">' +
        '<div class="mst-av">' + esc(initials(S.saved.tagline || S.handle)) + '</div>' +
        '<div class="mst-idinfo">' +
          '<div class="mst-nm">' + esc(name) + '</div>' +
          (S.handle
            ? '<div class="mst-handle">' + esc(MS.storefrontUrl(S.handle, ctx.origin)) + '</div>'
            : '<div class="mst-nohandle">No handle yet — claim one so people can find you</div>') +
        '</div>' +
      '</div></div>';
    }

    function storefrontHTML() {
      var a = S.analytics;
      var tiles = a ? [
        ['Followers', a.followerCount], ['Views', a.views],
        ['Visits', a.visits], ['Shares', a.shares],
      ].filter(function (t) { return t[1] !== null && t[1] !== undefined; }) : [];

      return '<div class="mst-body">' +
        identityCard() +
        (tiles.length
          ? '<div class="mst-kpis">' + tiles.map(function (t) {
              return '<div class="mst-kpi"><div class="v">' + esc(MS.formatCount(t[1])) + '</div>' +
                '<div class="k">' + esc(t[0]) + '</div></div>';
            }).join('') + '</div>'
          : (S.analyticsError
              ? '<div class="mst-banner">Your shop figures could not be loaded. ' + esc(S.analyticsError) +
                ' <button class="mst-btn ghost" style="min-height:36px;margin-left:4px" data-act="reload-analytics">Retry</button></div>'
              : '')) +

        '<div class="mst-lbl">Your handle</div>' +
        (S.handle
          ? '<div class="mst-banner"><b>@' + esc(S.handle) + '</b> is yours. A handle cannot be changed here — ' +
            'links, share cards and campaigns already point at it.</div>' +
            '<div class="mst-link"><input id="mst-url" readonly value="' + esc(MS.storefrontUrl(S.handle, ctx.origin) || '') + '" aria-label="Storefront link">' +
            '<button class="mst-btn ghost" data-act="copy-url" style="min-height:48px">Copy</button></div>'
          : '<div class="mst-hint">Your handle is your storefront address. Lowercase letters, numbers, ' +
            'hyphens and underscores, ' + MS.HANDLE_MIN + '–' + MS.HANDLE_MAX + ' characters.</div>' +
            '<input class="mst-inp" id="mst-handle" inputmode="url" autocapitalize="none" autocorrect="off" ' +
              'placeholder="my-shop" value="' + esc(S.handleDraft) + '"' + (S.busy ? ' disabled' : '') + '>' +
            (S.opError ? '<div class="mst-err">' + esc(S.opError) + '</div>' : '') +
            (S.busy ? '<div class="mst-prog"><span class="mst-spin"></span>Claiming…</div>' : '') +
            '<button class="mst-btn solid wide" style="margin-top:10px" data-act="claim"' +
              (S.busy || !!MS.handleProblem(S.handleDraft) ? ' disabled' : '') + '>Claim this handle</button>') +
        (S.opDone === 'handle' ? '<div class="mst-ok">Handle claimed — your storefront is live.</div>' : '') +
      '</div>';
    }

    /* ONE field renderer, switched on type. Every control writes to the same draft and
       saves through the same changedFields -> saveMinishopConfig path — a second
       persistence route is exactly what would let two settings disagree. */
    function fieldHTML(f) {
      var raw = S.draft[f.id];
      var isChips = f.type === 'chips';
      var arr = Array.isArray(raw) ? raw : [];
      var v = isChips ? '' : String(raw == null ? '' : raw);
      var err = MS.validateField ? MS.validateField(f, isChips ? arr : v) : null;
      var over = !isChips && v.length > f.max;
      var dis = S.busy ? ' disabled' : '';

      var head = '<div class="mst-lbl">' + esc(f.label) + '</div>' +
        (f.hint ? '<div class="mst-hint">' + esc(f.hint) + '</div>' : '');

      /* A preview sits ABOVE its input so a merchant sees the effect, not just the URL. */
      var pv = '';
      if (f.preview) {
        var ok = v && !err;
        pv = '<div class="mst-pv mst-pv-' + f.preview + (ok ? '' : ' empty') + '" id="mst-p-' + f.id + '"' +
             (ok ? ' style="background-image:url(&quot;' + esc(v) + '&quot;)"' : '') + '>' +
             (ok ? '' : '<span>No ' + esc(f.label.toLowerCase()) + ' yet</span>') + '</div>';
      }

      var input;
      if (isChips) {
        input = '<div class="mst-chips" id="mst-ch-' + f.id + '">' +
          arr.map(function (c, i) {
            return '<span class="mst-chip">' + esc(c) +
              '<button type="button" class="mst-chip-x" data-chip-del="' + f.id + '" data-i="' + i +
              '" aria-label="Remove ' + esc(c) + '">&times;</button></span>';
          }).join('') +
          '<input class="mst-chip-in" data-chip-add="' + f.id + '" placeholder="Add…"' + dis +
          ' aria-label="Add to ' + esc(f.label) + '">' +
          '</div>' +
          '<div class="mst-cnt" id="mst-c-' + f.id + '">' + arr.length + ' / ' + f.max + '</div>';
      } else if (f.type === 'select') {
        input = '<select class="mst-inp" id="mst-f-' + f.id + '" data-f="' + f.id + '"' + dis + '>' +
          (f.options || []).map(function (o) {
            return '<option value="' + esc(o) + '"' + (o === v ? ' selected' : '') + '>' +
                   esc(o || '— default —') + '</option>';
          }).join('') + '</select>';
      } else if (f.type === 'color') {
        /* Two controls, ONE value: the picker is a convenience over the text field, and
           both write the same draft key. A colour the picker cannot express still types. */
        input = '<div class="mst-color">' +
          '<span class="mst-sw" id="mst-sw-' + f.id + '" style="background:' + esc(v || 'transparent') + '"></span>' +
          '<input type="color" class="mst-cp" id="mst-cp-' + f.id + '" data-f="' + f.id + '" value="' +
            esc(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v) ? v : '#71ff00') + '"' + dis +
            ' aria-label="' + esc(f.label) + ' picker">' +
          '<input class="mst-inp mst-color-tx" id="mst-f-' + f.id + '" data-f="' + f.id +
            '" value="' + esc(v) + '" placeholder="#71ff00"' + dis + '>' +
          '</div>';
      } else if (f.rows > 1) {
        input = '<textarea class="mst-inp" id="mst-f-' + f.id + '" data-f="' + f.id +
          '" rows="' + f.rows + '"' + dis + '>' + esc(v) + '</textarea>' +
          '<div class="mst-cnt' + (over ? ' over' : '') + '" id="mst-c-' + f.id + '">' + v.length + ' / ' + f.max + '</div>';
      } else {
        input = '<input class="mst-inp" id="mst-f-' + f.id + '" data-f="' + f.id + '" value="' + esc(v) +
          '"' + (f.type === 'url' ? ' inputmode="url" placeholder="https://…"' : '') +
          (f.type === 'email' ? ' inputmode="email"' : '') + dis + '>' +
          '<div class="mst-cnt' + (over ? ' over' : '') + '" id="mst-c-' + f.id + '">' + v.length + ' / ' + f.max + '</div>';
      }

      return '<div class="mst-field">' + head + pv + input +
        '<div class="mst-fe" id="mst-e-' + f.id + '"' + (err ? '' : ' style="display:none"') + '>' +
        esc(err || '') + '</div></div>';
    }

    function detailsHTML() {
      var groups = MS.FIELD_GROUPS || [{ id: 'more', title: '', hint: '' }];
      var known = {};
      groups.forEach(function (g) { known[g.id] = true; });

      var body = groups.map(function (g) {
        var fields = MS.TEXT_FIELDS.filter(function (f) {
          /* A field whose group is unknown lands in "More" rather than vanishing — a
             silently dropped setting is worse than an oddly placed one. */
          return (f.group && known[f.group] ? f.group : 'more') === g.id;
        });
        if (!fields.length) return '';
        return '<section class="mst-group">' +
          '<h3 class="mst-gt">' + esc(g.title) + '</h3>' +
          (g.hint ? '<p class="mst-gh">' + esc(g.hint) + '</p>' : '') +
          fields.map(fieldHTML).join('') +
          '</section>';
      }).join('');

      return '<div class="mst-body">' +
        '<div class="mst-banner">These details appear on your public storefront.</div>' +
        body +
        (S.opError ? '<div class="mst-err">' + esc(S.opError) + '</div>' : '') +
        (S.opDone === 'config' ? '<div class="mst-ok">Saved.</div>' : '') +
        (S.busy ? '<div class="mst-prog"><span class="mst-spin"></span>Saving on the server…</div>' : '') +
      '</div>';
    }

    function shareHTML() {
      if (!S.handle) {
        return '<div class="mst-body"><div class="mst-state"><div class="ic">🔗</div>' +
          '<div class="hd">Claim a handle first</div>' +
          'A share card needs a storefront address. Claim your handle on the Storefront tab.' +
          '</div></div>';
      }
      var s = S.share;
      return '<div class="mst-body">' +
        identityCard() +
        '<div class="mst-lbl">Your storefront link</div>' +
        '<div class="mst-link"><input id="mst-url2" readonly value="' + esc(MS.storefrontUrl(S.handle, ctx.origin) || '') + '" aria-label="Storefront link">' +
        '<button class="mst-btn ghost" data-act="copy-url" style="min-height:48px">Copy</button></div>' +
        (s && s.shareText
          ? '<div class="mst-lbl">Ready to send</div>' +
            '<div class="mst-card" style="font-size:13px;line-height:1.55;overflow-wrap:anywhere">' + esc(s.shareText) + '</div>' +
            '<button class="mst-btn ghost wide" data-act="copy-text">Copy this message</button>'
          : '<button class="mst-btn solid wide" style="margin-top:14px" data-act="share"' + (S.busy ? ' disabled' : '') + '>' +
            (S.busy ? 'Preparing…' : 'Create a share card') + '</button>') +
        (S.opError ? '<div class="mst-err">' + esc(S.opError) + '</div>' : '') +
      '</div>';
    }

    /* ── Actions ──────────────────────────────────────────────────────────── */
    function save() {
      if (S.busy) return;
      var changed = MS.changedFields(S.saved, S.draft);
      if (!Object.keys(changed).length) return;
      S.busy = true; S.opError = null; S.opDone = null; paint();
      MS.saveConfig({ shopId: S.shopId, config: changed, callSave: ctx.callSave }).then(function (r) {
        S.busy = false;
        if (!r.ok) {
          /* The draft is KEPT. A rejected save that wipes the merchant's text
             loses work and teaches them not to trust the screen. */
          S.opError = r.error; paint(); return;
        }
        S.saved = Object.assign({}, S.saved, changed);
        S.draft = Object.assign({}, S.saved);
        S.opDone = 'config'; paint();
        toast('Saved', 'success');
      }).catch(function (e) {
        S.busy = false; S.opError = (e && e.message) || 'Your changes could not be saved.'; paint();
      });
    }

    function claim() {
      if (S.busy) return;
      var problem = MS.handleProblem(S.handleDraft);
      if (problem) { S.opError = problem; paint(); return; }
      S.busy = true; S.opError = null; S.opDone = null; paint();
      MS.claimHandle({ handle: S.handleDraft, callClaim: ctx.callClaim }).then(function (r) {
        S.busy = false;
        if (!r.ok) { S.opError = r.error; paint(); return; }
        S.opDone = 'handle';
        toast('Handle claimed', 'success');
        /* Re-read identity from the server rather than assuming the claim's
           echo — the server owns handle, shopId and url together. */
        load();
      }).catch(function (e) {
        S.busy = false; S.opError = (e && e.message) || 'That handle could not be claimed.'; paint();
      });
    }

    function makeShare() {
      if (S.busy) return;
      S.busy = true; S.opError = null; paint();
      MS.shareCard({ shopId: S.shopId, callShare: ctx.callShare }).then(function (r) {
        S.busy = false;
        if (!r.ok) { S.opError = r.error; paint(); return; }
        S.share = r; paint();
      }).catch(function (e) {
        S.busy = false; S.opError = (e && e.message) || 'The share card could not be created.'; paint();
      });
    }

    function copy(text, label) {
      var nav = (typeof navigator !== 'undefined') ? navigator : null;
      if (nav && nav.clipboard && nav.clipboard.writeText) {
        nav.clipboard.writeText(text).then(function () { toast(label, 'success'); })
          .catch(function () { toast('That could not be copied.', 'error'); });
        return;
      }
      toast('Copying is not available on this device.', 'error');
    }

    /* Chip removal. Repaints, because a chip leaving changes the layout — unlike typing,
       there is no keyboard to lose. The draft array is replaced rather than mutated so
       changedFields compares against the saved array cleanly. */
    function onChipClick(ev) {
      var x = ev.target && ev.target.closest ? ev.target.closest('[data-chip-del]') : null;
      if (!x || !host.contains(x)) return false;
      var id = x.getAttribute('data-chip-del');
      var i = parseInt(x.getAttribute('data-i'), 10);
      var arr = Array.isArray(S.draft[id]) ? S.draft[id].slice() : [];
      if (i >= 0 && i < arr.length) { arr.splice(i, 1); S.draft[id] = arr; paint(); }
      return true;
    }

    /* Enter or comma commits a chip. Comma matters: a merchant listing delivery areas
       types them the way they would write them down, and swallowing the comma into the
       value would store "Westlands, Kilimani" as one area. */
    function onChipKey(ev) {
      var el = ev.target;
      if (!el || !el.getAttribute || !el.getAttribute('data-chip-add')) return;
      if (ev.key !== 'Enter' && ev.key !== ',') return;
      ev.preventDefault();
      var id = el.getAttribute('data-chip-add');
      var f = MS.TEXT_FIELDS.filter(function (x) { return x.id === id; })[0];
      var val = String(el.value || '').trim().replace(/,$/, '');
      if (!val) return;
      var arr = Array.isArray(S.draft[id]) ? S.draft[id].slice() : [];
      if (arr.indexOf(val) > -1) { el.value = ''; return; }      /* no silent duplicates */
      arr.push(val);
      var err = MS.validateField ? MS.validateField(f, arr) : null;
      if (err) {
        var msg = host.querySelector('#mst-e-' + id);
        if (msg) { msg.textContent = err; msg.style.display = 'block'; }
        return;                                   /* refuse rather than send a rejection */
      }
      S.draft[id] = arr; el.value = ''; paint();
      var again = host.querySelector('[data-chip-add="' + id + '"]');
      if (again) again.focus();                   /* keep the merchant typing the list */
    }

    function onClick(ev) {
      if (onChipClick(ev)) return;
      var el = ev.target && ev.target.closest ? ev.target.closest('[data-act]'): null;
      if (!el || !host.contains(el)) return;
      var act = el.getAttribute('data-act');
      if (act === 'tab')              { S.tab = el.getAttribute('data-t') || 'storefront'; S.opError = null; S.opDone = null; paint(); return; }
      if (act === 'reload')           { load(); return; }
      if (act === 'reload-analytics') { S.analyticsError = null; paint(); loadAnalytics(); return; }
      if (act === 'save')             { save(); return; }
      if (act === 'claim')            { claim(); return; }
      if (act === 'share')            { makeShare(); return; }
      if (act === 'copy-url')         { copy(MS.storefrontUrl(S.handle, ctx.origin), 'Storefront link copied'); return; }
      if (act === 'copy-text')        { if (S.share && S.share.shareText) copy(S.share.shareText, 'Message copied'); return; }
    }

    function onInput(ev) {
      var el = ev.target; if (!el) return;
      if (el.id === 'mst-handle') {
        S.handleDraft = el.value || '';
        var btn = host.querySelector('[data-act="claim"]');
        if (btn) btn.disabled = !!(S.busy || MS.handleProblem(S.handleDraft));
        return;
      }
      var f = el.getAttribute && el.getAttribute('data-f');
      if (!f) return;
      var field = MS.TEXT_FIELDS.filter(function (x) { return x.id === f; })[0];
      S.draft[f] = el.value;

      /* Counter, validation message and live preview all update IN PLACE — repainting
         would take the keyboard down mid-sentence. */
      var cnt = host.querySelector('#mst-c-' + f);
      if (cnt && field && field.type !== 'chips') {
        cnt.textContent = el.value.length + ' / ' + field.max;
        cnt.classList.toggle('over', el.value.length > field.max);
      }

      var err = field ? MS.validateField(field, el.value) : null;
      var msg = host.querySelector('#mst-e-' + f);
      if (msg) { msg.textContent = err || ''; msg.style.display = err ? 'block' : 'none'; }

      /* A preview is only honest once the value validates. Painting a broken image for
         every keystroke of a half-typed URL reads as "your logo is wrong". */
      var pv = host.querySelector('#mst-p-' + f);
      if (pv && field && field.preview) {
        if (el.value && !err) { pv.style.backgroundImage = 'url("' + String(el.value).replace(/"/g, '%22') + '")'; pv.className = 'mst-pv mst-pv-' + field.preview; }
        else { pv.style.backgroundImage = ''; pv.className = 'mst-pv mst-pv-' + field.preview + ' empty'; }
      }
      if (field && field.type === 'color' && !err) {
        var sw = host.querySelector('#mst-sw-' + f);
        if (sw) sw.style.background = el.value;
        var cp = host.querySelector('#mst-cp-' + f);
        if (cp && cp.value !== el.value) cp.value = el.value;
      }
      var save = host.querySelector('[data-act="save"]');
      if (save) {
        var n = Object.keys(MS.changedFields(S.saved, S.draft)).length;
        save.disabled = !!(S.busy || !n);
        save.textContent = S.busy ? 'Saving…' : (n ? 'Save ' + n + ' change' + (n === 1 ? '' : 's') : 'No changes to save');
      }
    }

    host.addEventListener('click', onClick);
    host.addEventListener('input', onInput);
    host.addEventListener('keydown', onChipKey);

    load();

    return {
      refresh: load,
      state: function () { return S; },
      destroy: function () {
        host.removeEventListener('click', onClick);
        host.removeEventListener('input', onInput);
      },
    };
  }

  return { mount: mount, CSS_ID: CSS_ID };
}));
