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

    function detailsHTML() {
      return '<div class="mst-body">' +
        '<div class="mst-banner">These details appear on your public storefront.</div>' +
        MS.TEXT_FIELDS.map(function (f) {
          var v = String(S.draft[f.id] == null ? '' : S.draft[f.id]);
          var over = v.length > f.max;
          return '<div class="mst-lbl">' + esc(f.label) + '</div>' +
            (f.hint ? '<div class="mst-hint">' + esc(f.hint) + '</div>' : '') +
            (f.rows > 1
              ? '<textarea class="mst-inp" id="mst-f-' + f.id + '" data-f="' + f.id + '" rows="' + f.rows + '"' +
                (S.busy ? ' disabled' : '') + '>' + esc(v) + '</textarea>'
              : '<input class="mst-inp" id="mst-f-' + f.id + '" data-f="' + f.id + '" value="' + esc(v) + '"' +
                (S.busy ? ' disabled' : '') + '>') +
            '<div class="mst-cnt' + (over ? ' over' : '') + '" id="mst-c-' + f.id + '">' + v.length + ' / ' + f.max + '</div>';
        }).join('') +
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

    function onClick(ev) {
      var el = ev.target && ev.target.closest ? ev.target.closest('[data-act]') : null;
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
      S.draft[f] = el.value;
      /* Update the counter and the save button in place — repainting would take
         the keyboard down mid-sentence. */
      var field = MS.TEXT_FIELDS.filter(function (x) { return x.id === f; })[0];
      var cnt = host.querySelector('#mst-c-' + f);
      if (cnt && field) {
        cnt.textContent = el.value.length + ' / ' + field.max;
        cnt.classList.toggle('over', el.value.length > field.max);
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
