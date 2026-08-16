/* ════════════════════════════════════════════════════════════════════════════
   SOKONI Merchant Marketing — the native surface (2D-2 step 3)

       merchant.html → this surface → the SAFE authorities only

   Three tabs, and each one is bounded by what the backend can honestly do:

     Campaigns    shop-scoped create / list / pause / delete
     Promotions   shop-scoped create + update; the LIST is the public
                  storefront read, so it shows ACTIVE promotions only and says so
     Ads          ACCOUNT-scoped, labelled as such — not "this shop's ads"

   ── What it refuses to show ─────────────────────────────────────────────────
   No orders, no revenue, no ROI. Those counters are incremented by
   `trackCampaignClick`, an endpoint that requires no sign-in, so they are not
   business results and are not presented as any. Clicks and views appear as
   TRAFFIC, which is what they are. The data layer strips the rest before this
   file can reach it.

   Capabilities whose authority is blocked — bundle deals, A/B tests, platform
   coupon codes, per-campaign conversions — are shown as **not available yet**
   with the reason, rather than as buttons that fail or as screens that quietly
   omit them. A merchant should be able to see the edge of what works.

   ── Pause is the ordinary action ────────────────────────────────────────────
   Deleting a campaign destroys its click and view history with it. Pause is
   reversible and is therefore the primary control; delete sits behind an
   explicit confirmation that says what will be lost.
   ════════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SokoniMerchantMarketing = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var CSS_ID = 'sokoni-merchant-marketing-css';

  var CSS = [
    '#native-marketing{padding:0!important;overflow:hidden!important;display:flex;flex-direction:column}',
    '.mmk{display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden;font-variant-numeric:tabular-nums}',

    '.mmk-top{flex:0 0 auto;padding:12px 14px;border-bottom:1px solid var(--line);background:var(--panel)}',
    '.mmk-tabs{display:flex;gap:8px;overflow-x:auto;scrollbar-width:none}',
    '.mmk-tabs::-webkit-scrollbar{display:none}',
    '.mmk-tab{flex:0 0 auto;min-height:44px;padding:0 15px;border-radius:12px;border:1px solid var(--line);',
      'background:rgba(255,255,255,.04);color:var(--txt2);font-weight:800;font-size:12.5px;cursor:pointer;font-family:inherit}',
    '.mmk-tab.on{border-color:rgba(113,255,0,.45);background:rgba(113,255,0,.12);color:var(--acc)}',

    '.mmk-body{flex:1;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:12px 14px 18px}',

    '.mmk-card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:14px;margin-bottom:11px}',
    '.mmk-hd{display:flex;align-items:flex-start;gap:11px}',
    '.mmk-hd .info{flex:1;min-width:0}',
    '.mmk-nm{font-size:14px;font-weight:800;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.mmk-sub{font-size:11.5px;color:var(--txt3);margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.mmk-chip{flex:0 0 auto;font-size:10.5px;font-weight:800;text-transform:uppercase;letter-spacing:.04em;',
      'padding:5px 9px;border-radius:8px;border:1px solid var(--line);background:rgba(255,255,255,.06);color:var(--txt2)}',
    '.mmk-chip.active{color:var(--acc);border-color:rgba(113,255,0,.32);background:rgba(113,255,0,.10)}',
    '.mmk-chip.paused{color:#fbbf24;border-color:rgba(251,191,36,.32);background:rgba(251,191,36,.10)}',

    '.mmk-stats{display:flex;gap:10px;margin-top:12px}',
    '.mmk-stat{flex:1;min-width:0;background:rgba(255,255,255,.04);border:1px solid var(--line);',
      'border-radius:12px;padding:10px 12px}',
    '.mmk-stat .v{font-size:18px;font-weight:900;color:var(--acc);line-height:1.1}',
    '.mmk-stat .k{font-size:10px;color:var(--txt3);text-transform:uppercase;letter-spacing:.04em;margin-top:3px}',
    '.mmk-traffic{font-size:11px;color:var(--txt3);margin-top:9px;line-height:1.5}',

    '.mmk-acts{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap}',
    '.mmk-btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:44px;',
      'padding:0 15px;border-radius:12px;font-weight:800;font-size:13px;cursor:pointer;font-family:inherit;',
      'border:1px solid rgba(113,255,0,.32);background:rgba(113,255,0,.13);color:var(--acc)}',
    '.mmk-btn.ghost{background:rgba(255,255,255,.05);border-color:var(--line);color:var(--txt2)}',
    '.mmk-btn.solid{background:var(--acc);border-color:var(--acc);color:#000}',
    '.mmk-btn.danger{background:rgba(255,90,90,.10);border-color:rgba(255,90,90,.30);color:#ff9a9a}',
    '.mmk-btn[disabled]{opacity:.5;cursor:default}',
    '.mmk-btn.wide{width:100%}',
    '.mmk-btn.grow{flex:1;min-width:0}',

    '.mmk-state{padding:40px 24px;text-align:center;color:var(--txt2);font-size:13.5px;line-height:1.6}',
    '.mmk-state .ic{font-size:36px;margin-bottom:12px}',
    '.mmk-state .hd{font-weight:800;font-size:15px;color:var(--txt);margin-bottom:8px}',

    '.mmk-note{font-size:11.5px;color:var(--txt3);line-height:1.55;margin-top:10px}',
    '.mmk-banner{padding:11px 13px;border-radius:12px;background:rgba(255,255,255,.04);',
      'border:1px solid var(--line);font-size:11.5px;color:var(--txt2);line-height:1.55;margin-bottom:12px}',
    '.mmk-banner b{color:var(--txt)}',

    '.mmk-blocked{border:1px dashed var(--line);border-radius:14px;padding:13px;margin-bottom:10px;',
      'background:rgba(255,255,255,.02)}',
    '.mmk-blocked .t{font-size:13px;font-weight:800;color:var(--txt2)}',
    '.mmk-blocked .w{font-size:11.5px;color:var(--txt3);margin-top:4px;line-height:1.5}',
    '.mmk-blocked .tag{display:inline-block;font-size:10px;font-weight:800;text-transform:uppercase;',
      'letter-spacing:.05em;color:#fbbf24;border:1px solid rgba(251,191,36,.3);background:rgba(251,191,36,.08);',
      'padding:3px 8px;border-radius:7px;margin-bottom:7px}',

    '.mmk-cta{flex:0 0 auto;padding:11px 14px;border-top:1px solid var(--line);',
      'background:linear-gradient(180deg,#0c0c0c,#080808)}',

    '.mmk-scrim{position:absolute;inset:0;background:rgba(0,0,0,.62);z-index:60;animation:mmkFade .16s ease both}',
    '@keyframes mmkFade{from{opacity:0}to{opacity:1}}',
    '.mmk-sheet{position:absolute;left:0;right:0;bottom:0;z-index:61;background:var(--panel);',
      'border-top:1px solid var(--line);border-radius:20px 20px 0 0;max-height:92%;display:flex;',
      'flex-direction:column;animation:mmkUp .2s cubic-bezier(.2,.7,.3,1) both;',
      'padding-bottom:env(safe-area-inset-bottom,0px)}',
    '@keyframes mmkUp{from{transform:translateY(14px);opacity:.4}to{transform:none;opacity:1}}',
    '@media (prefers-reduced-motion:reduce){.mmk-sheet,.mmk-scrim{animation:none}}',
    '.mmk-sh-h{flex:0 0 auto;display:flex;align-items:center;gap:12px;padding:15px 16px 11px;border-bottom:1px solid var(--line)}',
    '.mmk-sh-h .t{flex:1;min-width:0;font-size:15px;font-weight:800;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.mmk-sh-x{width:44px;height:44px;flex:0 0 auto;border-radius:12px;border:1px solid var(--line);',
      'background:rgba(255,255,255,.05);color:var(--txt2);font-size:17px;cursor:pointer;font-family:inherit}',
    '.mmk-sh-b{flex:1;min-height:0;overflow-y:auto;padding:14px 16px}',
    '.mmk-sh-f{flex:0 0 auto;padding:12px 16px 16px;border-top:1px solid var(--line);display:flex;flex-direction:column;gap:9px}',

    '.mmk-lbl{font-size:11px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:var(--txt3);margin:14px 0 7px}',
    '.mmk-lbl:first-child{margin-top:0}',
    '.mmk-inp{width:100%;min-height:52px;background:rgba(255,255,255,.06);border:1px solid var(--line);',
      'border-radius:13px;padding:14px;color:var(--txt);font-size:16px;font-family:inherit;outline:none;resize:none}',
    '.mmk-inp:focus{border-color:rgba(113,255,0,.42)}',
    '.mmk-opts{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(140px,100%),1fr));gap:8px}',
    '.mmk-opt{min-height:48px;padding:9px 12px;border-radius:12px;border:1px solid var(--line);',
      'background:rgba(255,255,255,.04);color:var(--txt2);cursor:pointer;font-family:inherit;text-align:left;font-size:12.5px;font-weight:700}',
    '.mmk-opt.on{border-color:rgba(113,255,0,.45);background:rgba(113,255,0,.10);color:var(--acc)}',
    '.mmk-row2{display:flex;gap:9px}',
    '.mmk-row2 > *{flex:1;min-width:0}',

    '.mmk-link{display:flex;gap:8px;margin-top:8px}',
    '.mmk-link input{flex:1;min-width:0;height:48px;background:rgba(255,255,255,.06);border:1px solid var(--line);',
      'border-radius:12px;padding:0 12px;color:var(--txt);font-size:12.5px;font-family:inherit;outline:none}',

    '.mmk-prog{display:flex;align-items:center;gap:11px;padding:13px 14px;border-radius:13px;',
      'background:rgba(255,255,255,.05);border:1px solid var(--line);font-size:13px;font-weight:700;color:var(--txt2);margin-top:12px}',
    '.mmk-spin{width:17px;height:17px;flex:0 0 auto;border-radius:50%;border:2px solid rgba(255,255,255,.18);',
      'border-top-color:var(--acc);animation:mmkSpin .7s linear infinite}',
    '@keyframes mmkSpin{to{transform:rotate(360deg)}}',
    '.mmk-err{padding:13px 14px;border-radius:13px;background:rgba(255,90,90,.10);border:1px solid rgba(255,90,90,.34);',
      'color:#ff9a9a;font-size:13px;font-weight:700;line-height:1.5;margin-top:12px}',
    '.mmk-ok{text-align:center;padding:16px 6px 6px}',
    '.mmk-ok .ic{font-size:38px;margin-bottom:10px}',
    '.mmk-ok .hd{font-size:17px;font-weight:900;color:var(--acc)}',
    '@media (min-width:821px){.mmk-sheet{left:50%;transform:translateX(-50%);width:min(560px,100%)}}',
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

    var MC = (typeof globalThis !== 'undefined' && globalThis.SokoniMerchantCampaigns) || null;
    if (!MC) {
      host.innerHTML = '<div class="mmk"><div class="mmk-state"><div class="ic">⚠️</div>' +
        '<div class="hd">Marketing is unavailable</div>The campaigns module did not load. ' +
        'Reopen SOKONI Merchant.</div></div>';
      return null;
    }

    var S = {
      phase: 'loading',        /* loading | no_shop | error | ready */
      error: null,
      tab: 'campaigns',        /* campaigns | promotions | ads */
      campaigns: [],
      promotions: [],
      promoActiveOnly: true,
      promoError: null,
      sheet: null,             /* null | 'campaign' | 'promotion' | 'ad' | 'confirm-delete' */
      target: null,
      form: {},
      busy: false,
      opError: null,
      created: null,
      copied: false,
    };

    function toast(msg, kind) {
      if (typeof ctx.onToast === 'function') { try { ctx.onToast(msg, kind); return; } catch (_) {} }
      if (kind === 'error') console.error('[merchant marketing] ' + msg);
    }

    function load() {
      if (!ctx.scope || !ctx.scope.ok) { S.phase = 'no_shop'; paint(); return Promise.resolve(); }
      S.phase = 'loading'; paint();
      return MC.listCampaigns({ scope: ctx.scope, callList: ctx.callList }).then(function (r) {
        if (!r.ok) { S.phase = 'error'; S.error = r.error; paint(); return; }
        S.campaigns = r.campaigns || [];
        S.phase = 'ready'; paint();
        return loadPromotions();
      }).catch(function (e) {
        S.phase = 'error'; S.error = (e && e.message) || 'Marketing could not be loaded.'; paint();
      });
    }

    function loadPromotions() {
      if (typeof ctx.callPromos !== 'function') return Promise.resolve();
      return MC.listPromotions({ scope: ctx.scope, callPromos: ctx.callPromos }).then(function (r) {
        if (!r.ok) { S.promoError = r.error; S.promotions = []; }
        else { S.promotions = r.promotions || []; S.promoActiveOnly = r.activeOnly; S.promoError = null; }
        if (S.phase === 'ready') paint();
      }).catch(function () {});
    }

    /* ── Render ───────────────────────────────────────────────────────────── */
    function paint() {
      host.innerHTML = '<div class="mmk">' + topHTML() + bodyHTML() + ctaHTML() + '</div>' + sheetHTML();
    }

    function topHTML() {
      return '<div class="mmk-top"><div class="mmk-tabs">' +
        '<button class="mmk-tab' + (S.tab === 'campaigns' ? ' on' : '') + '" data-act="tab" data-t="campaigns">' +
          'Campaigns' + (S.campaigns.length ? ' · ' + S.campaigns.length : '') + '</button>' +
        '<button class="mmk-tab' + (S.tab === 'promotions' ? ' on' : '') + '" data-act="tab" data-t="promotions">' +
          'Promotions' + (S.promotions.length ? ' · ' + S.promotions.length : '') + '</button>' +
        '<button class="mmk-tab' + (S.tab === 'ads' ? ' on' : '') + '" data-act="tab" data-t="ads">Ads</button>' +
      '</div></div>';
    }

    function ctaHTML() {
      if (S.phase !== 'ready') return '';
      var label = S.tab === 'promotions' ? '＋ New promotion' : S.tab === 'ads' ? '＋ New ad' : '＋ New campaign';
      var act = S.tab === 'promotions' ? 'open-promotion' : S.tab === 'ads' ? 'open-ad' : 'open-campaign';
      return '<div class="mmk-cta"><button class="mmk-btn solid wide" data-act="' + act + '">' + label + '</button></div>';
    }

    function bodyHTML() {
      if (S.phase === 'loading') {
        return '<div class="mmk-body"><div class="sk-line" style="width:70%"></div>' +
          '<div class="sk-line" style="width:52%"></div><div class="sk-line" style="width:62%"></div></div>';
      }
      if (S.phase === 'no_shop') {
        return '<div class="mmk-body"><div class="mmk-state"><div class="ic">🏪</div>' +
          '<div class="hd">No shop is active yet</div>' +
          'Campaigns and promotions belong to a shop. Once your merchant account has an approved ' +
          'shop, you can market it from here.</div></div>';
      }
      if (S.phase === 'error') {
        return '<div class="mmk-body"><div class="mmk-state"><div class="ic">⚠️</div>' +
          '<div class="hd">Marketing could not be loaded</div>' + esc(S.error || '') +
          '<div style="margin-top:18px"><button class="mmk-btn" data-act="reload">Try again</button></div>' +
          '</div></div>';
      }
      if (S.tab === 'promotions') return promotionsHTML();
      if (S.tab === 'ads') return adsHTML();
      return campaignsHTML();
    }

    function campaignsHTML() {
      var blocked = MC.UNAVAILABLE.filter(function (u) { return u.id === 'conversions'; });
      if (!S.campaigns.length) {
        return '<div class="mmk-body"><div class="mmk-state"><div class="ic">📣</div>' +
          '<div class="hd">No campaigns yet</div>' +
          'A campaign gives you a trackable link to share on WhatsApp, Instagram or anywhere else, ' +
          'so you can see which one actually brings people to your shop.' +
          '</div>' + blockedHTML(blocked) + '</div>';
      }
      return '<div class="mmk-body">' + S.campaigns.map(function (c, i) {
        var st = c.status === 'paused' ? 'paused' : 'active';
        return '<div class="mmk-card">' +
          '<div class="mmk-hd"><div class="info">' +
            '<div class="mmk-nm">' + esc(c.name) + '</div>' +
            '<div class="mmk-sub">' + esc(MC.typeLabel(c.type)) + '</div>' +
          '</div><span class="mmk-chip ' + st + '">' + (st === 'paused' ? 'Paused' : 'Active') + '</span></div>' +
          '<div class="mmk-stats">' +
            '<div class="mmk-stat"><div class="v">' + esc(MC.formatCount(c.clicks)) + '</div><div class="k">Clicks</div></div>' +
            '<div class="mmk-stat"><div class="v">' + esc(MC.formatCount(c.views)) + '</div><div class="k">Views</div></div>' +
          '</div>' +
          '<div class="mmk-traffic">Traffic only — these count link opens, not sales.</div>' +
          '<div class="mmk-acts">' +
            '<button class="mmk-btn ghost grow" data-act="copy-campaign" data-i="' + i + '">⧉ Copy link</button>' +
            '<button class="mmk-btn ' + (st === 'paused' ? 'solid' : 'ghost') + ' grow" data-act="toggle" data-i="' + i + '">' +
              (st === 'paused' ? '▶ Resume' : '⏸ Pause') + '</button>' +
            '<button class="mmk-btn danger" data-act="ask-delete" data-i="' + i + '" aria-label="Delete campaign">🗑</button>' +
          '</div>' +
        '</div>';
      }).join('') + blockedHTML(blocked) + '</div>';
    }

    function promotionsHTML() {
      var head = '';
      if (S.promoError) {
        head += '<div class="mmk-err" style="margin:0 0 12px">' + esc(S.promoError) +
          ' <button class="mmk-btn ghost" style="min-height:36px;margin-left:6px" data-act="reload-promos">Retry</button></div>';
      }
      /* The list is the PUBLIC storefront read. Saying so is the difference
         between an honest partial list and a screen that implies completeness. */
      if (S.promoActiveOnly) {
        head += '<div class="mmk-banner">Showing <b>active promotions only</b> — this is the same list ' +
          'shoppers see on your storefront. Paused and expired promotions are not listed here yet.</div>';
      }
      var blocked = MC.UNAVAILABLE.filter(function (u) { return u.id === 'coupons_engine' || u.id === 'bundles'; });
      if (!S.promotions.length) {
        return '<div class="mmk-body">' + head + '<div class="mmk-state"><div class="ic">🏷️</div>' +
          '<div class="hd">No active promotions</div>' +
          'A promotion shows on your storefront and can carry a code shoppers type at checkout.' +
          '</div>' + blockedHTML(blocked) + '</div>';
      }
      return '<div class="mmk-body">' + head + S.promotions.map(function (p, i) {
        var disc = p.discountType === 'fixed'
          ? 'KES ' + Number(p.discountValue || 0).toLocaleString('en-KE') + ' off'
          : Number(p.discountValue || 0) + '% off';
        return '<div class="mmk-card">' +
          '<div class="mmk-hd"><div class="info">' +
            '<div class="mmk-nm">' + esc(p.title || 'Promotion') + '</div>' +
            '<div class="mmk-sub">' + esc(disc) + (p.code ? ' · code ' + esc(p.code) : '') + '</div>' +
          '</div><span class="mmk-chip active">Active</span></div>' +
          '<div class="mmk-acts">' +
            '<button class="mmk-btn ghost grow" data-act="pause-promo" data-i="' + i + '">⏸ Pause</button>' +
          '</div>' +
        '</div>';
      }).join('') + blockedHTML(blocked) + '</div>';
    }

    function adsHTML() {
      var sc = MC.adScope();
      var blocked = MC.UNAVAILABLE.filter(function (u) { return u.id === 'abtests'; });
      return '<div class="mmk-body">' +
        '<div class="mmk-banner"><b>' + esc(sc.label) + '.</b> ' + esc(sc.note) + '</div>' +
        '<div class="mmk-state" style="padding:26px 20px"><div class="ic">📢</div>' +
          '<div class="hd">Promote across SOKONI</div>' +
          'An ad reaches shoppers browsing the marketplace, not only the people who already know your ' +
          'shop. Every ad is reviewed before it runs, and nothing is charged until it does.' +
        '</div>' + blockedHTML(blocked) + '</div>';
    }

    function blockedHTML(list) {
      if (!list || !list.length) return '';
      return list.map(function (u) {
        return '<div class="mmk-blocked"><div class="tag">Not available yet</div>' +
          '<div class="t">' + esc(u.label) + '</div>' +
          '<div class="w">' + esc(u.why) + '</div></div>';
      }).join('');
    }

    /* ── Sheets ───────────────────────────────────────────────────────────── */
    function sheetHTML() {
      if (!S.sheet) return '';
      var inner = S.sheet === 'campaign' ? campaignSheet()
        : S.sheet === 'promotion' ? promotionSheet()
        : S.sheet === 'ad' ? adSheet()
        : confirmDeleteSheet();
      return '<div class="mmk-scrim" data-act="close"></div>' +
        '<div class="mmk-sheet" role="dialog" aria-modal="true">' + inner + '</div>';
    }

    function createdSheet(title, body, footer) {
      return '<div class="mmk-sh-h"><div class="t">' + title + '</div>' +
        '<button class="mmk-sh-x" data-act="close" aria-label="Close">×</button></div>' +
        '<div class="mmk-sh-b">' + body + '</div>' +
        '<div class="mmk-sh-f">' + footer + '</div>';
    }

    function campaignSheet() {
      if (S.created && S.created.campaignUrl) {
        return createdSheet('Campaign ready',
          '<div class="mmk-ok"><div class="ic">📣</div><div class="hd">Share this link</div></div>' +
          '<div class="mmk-note" style="text-align:center">Every open of this link is counted, so you can ' +
          'see which channel actually brings people in.</div>' +
          '<div class="mmk-link"><input id="mmk-link" readonly value="' + esc(S.created.campaignUrl) + '" aria-label="Campaign link">' +
          '<button class="mmk-btn ghost" data-act="copy-created" style="min-height:48px">' + (S.copied ? '✓ Copied' : 'Copy') + '</button></div>',
          '<button class="mmk-btn solid wide" data-act="close">Done</button>');
      }
      var f = S.form;
      return '<div class="mmk-sh-h"><div class="t">New campaign</div>' +
          '<button class="mmk-sh-x" data-act="close" aria-label="Close"' + (S.busy ? ' disabled' : '') + '>×</button></div>' +
        '<div class="mmk-sh-b">' +
          '<div class="mmk-lbl">Campaign name</div>' +
          '<input class="mmk-inp" id="mmk-name" placeholder="April weekend sale" value="' + esc(f.name || '') + '"' +
            (S.busy ? ' disabled' : '') + '>' +
          '<div class="mmk-lbl">What kind?</div>' +
          '<div class="mmk-opts">' + MC.CAMPAIGN_TYPES.map(function (t) {
            return '<button class="mmk-opt' + (f.type === t.id ? ' on' : '') + '" data-act="ctype" data-v="' + t.id + '"' +
              (S.busy ? ' disabled' : '') + '>' + esc(t.label) + '</button>';
          }).join('') + '</div>' +
          (S.opError ? '<div class="mmk-err">' + esc(S.opError) + '</div>' : '') +
          (S.busy ? '<div class="mmk-prog"><span class="mmk-spin"></span>Creating the campaign…</div>' : '') +
        '</div>' +
        '<div class="mmk-sh-f">' +
          '<button class="mmk-btn solid wide" data-act="save-campaign"' + (S.busy || !f.name || !f.type ? ' disabled' : '') + '>' +
            (S.busy ? 'Creating…' : (!f.type ? 'Choose a type' : 'Create campaign')) + '</button>' +
          '<button class="mmk-btn ghost wide" data-act="close"' + (S.busy ? ' disabled' : '') + '>Cancel</button>' +
        '</div>';
    }

    function promotionSheet() {
      if (S.created && S.created.promoId) {
        return createdSheet('Promotion live',
          '<div class="mmk-ok"><div class="ic">🏷️</div><div class="hd">' + esc(S.created.title || 'Promotion') + '</div></div>' +
          '<div class="mmk-note" style="text-align:center">It is showing on your storefront now' +
          (S.created.code ? ', with the code <b>' + esc(S.created.code) + '</b>' : '') + '.</div>',
          '<button class="mmk-btn solid wide" data-act="close">Done</button>');
      }
      var f = S.form;
      return '<div class="mmk-sh-h"><div class="t">New promotion</div>' +
          '<button class="mmk-sh-x" data-act="close" aria-label="Close"' + (S.busy ? ' disabled' : '') + '>×</button></div>' +
        '<div class="mmk-sh-b">' +
          '<div class="mmk-lbl">Title</div>' +
          '<input class="mmk-inp" id="mmk-title" placeholder="Weekend 20% off" value="' + esc(f.title || '') + '"' + (S.busy ? ' disabled' : '') + '>' +
          '<div class="mmk-lbl">Type</div>' +
          '<div class="mmk-opts">' + MC.PROMO_TYPES.map(function (t) {
            return '<button class="mmk-opt' + (f.type === t.id ? ' on' : '') + '" data-act="ptype" data-v="' + t.id + '"' +
              (S.busy ? ' disabled' : '') + '>' + esc(t.label) + '</button>';
          }).join('') + '</div>' +
          '<div class="mmk-lbl">Discount</div>' +
          '<div class="mmk-row2">' +
            '<button class="mmk-opt' + (f.discountType !== 'fixed' ? ' on' : '') + '" data-act="dtype" data-v="percent"' + (S.busy ? ' disabled' : '') + '>Percent %</button>' +
            '<button class="mmk-opt' + (f.discountType === 'fixed' ? ' on' : '') + '" data-act="dtype" data-v="fixed"' + (S.busy ? ' disabled' : '') + '>KES off</button>' +
          '</div>' +
          '<input class="mmk-inp" id="mmk-value" inputmode="numeric" pattern="[0-9]*" style="margin-top:9px" ' +
            'placeholder="' + (f.discountType === 'fixed' ? '200' : '20') + '" value="' + esc(f.discountValue || '') + '"' + (S.busy ? ' disabled' : '') + '>' +
          '<div class="mmk-lbl">Ends on</div>' +
          '<input class="mmk-inp" id="mmk-until" type="date" value="' + esc(f.validUntil || '') + '"' + (S.busy ? ' disabled' : '') + '>' +
          '<div class="mmk-lbl">Code (optional)</div>' +
          '<input class="mmk-inp" id="mmk-code" placeholder="WEEKEND20" value="' + esc(f.code || '') + '"' + (S.busy ? ' disabled' : '') + '>' +
          (S.opError ? '<div class="mmk-err">' + esc(S.opError) + '</div>' : '') +
          (S.busy ? '<div class="mmk-prog"><span class="mmk-spin"></span>Creating the promotion…</div>' : '') +
        '</div>' +
        '<div class="mmk-sh-f">' +
          '<button class="mmk-btn solid wide" data-act="save-promotion"' + (S.busy ? ' disabled' : '') + '>' +
            (S.busy ? 'Creating…' : 'Create promotion') + '</button>' +
          '<button class="mmk-btn ghost wide" data-act="close"' + (S.busy ? ' disabled' : '') + '>Cancel</button>' +
        '</div>';
    }

    function adSheet() {
      if (S.created && S.created.adId) {
        return createdSheet('Ad submitted',
          '<div class="mmk-ok"><div class="ic">📢</div><div class="hd">In review</div></div>' +
          '<div class="mmk-note" style="text-align:center">SOKONI reviews every ad before it runs. ' +
          'Nothing is charged until it goes live.</div>',
          '<button class="mmk-btn solid wide" data-act="close">Done</button>');
      }
      var f = S.form, sc = MC.adScope();
      return '<div class="mmk-sh-h"><div class="t">New ad</div>' +
          '<button class="mmk-sh-x" data-act="close" aria-label="Close"' + (S.busy ? ' disabled' : '') + '>×</button></div>' +
        '<div class="mmk-sh-b">' +
          '<div class="mmk-banner">' + esc(sc.note) + '</div>' +
          '<div class="mmk-lbl">Headline</div>' +
          '<input class="mmk-inp" id="mmk-adtitle" placeholder="Fresh stock every Friday" value="' + esc(f.title || '') + '"' + (S.busy ? ' disabled' : '') + '>' +
          '<div class="mmk-lbl">Budget (KES)</div>' +
          '<input class="mmk-inp" id="mmk-budget" inputmode="numeric" pattern="[0-9]*" placeholder="2000" value="' + esc(f.budgetKES || '') + '"' + (S.busy ? ' disabled' : '') + '>' +
          (S.opError ? '<div class="mmk-err">' + esc(S.opError) + '</div>' : '') +
          (S.busy ? '<div class="mmk-prog"><span class="mmk-spin"></span>Submitting for review…</div>' : '') +
        '</div>' +
        '<div class="mmk-sh-f">' +
          '<button class="mmk-btn solid wide" data-act="save-ad"' + (S.busy || !f.title || !f.budgetKES ? ' disabled' : '') + '>' +
            (S.busy ? 'Submitting…' : 'Submit for review') + '</button>' +
          '<button class="mmk-btn ghost wide" data-act="close"' + (S.busy ? ' disabled' : '') + '>Cancel</button>' +
        '</div>';
    }

    /* Delete is destructive and irreversible, so it says exactly what is lost. */
    function confirmDeleteSheet() {
      var c = S.target || {};
      return '<div class="mmk-sh-h"><div class="t">Delete this campaign?</div>' +
          '<button class="mmk-sh-x" data-act="close" aria-label="Close"' + (S.busy ? ' disabled' : '') + '>×</button></div>' +
        '<div class="mmk-sh-b">' +
          '<div class="mmk-nm" style="font-size:15px">' + esc(c.name || '') + '</div>' +
          '<div class="mmk-err" style="margin-top:14px">Deleting removes the campaign and ' +
            '<b>its ' + esc(MC.formatCount(c.clicks)) + ' clicks and ' + esc(MC.formatCount(c.views)) +
            ' views permanently</b>. The link stops working for anyone who already has it.</div>' +
          '<div class="mmk-note">If you only want it to stop, <b>pause</b> it instead — that is ' +
          'reversible and keeps the history.</div>' +
          (S.opError ? '<div class="mmk-err">' + esc(S.opError) + '</div>' : '') +
          (S.busy ? '<div class="mmk-prog"><span class="mmk-spin"></span>Deleting…</div>' : '') +
        '</div>' +
        '<div class="mmk-sh-f">' +
          '<button class="mmk-btn ghost wide" data-act="pause-instead"' + (S.busy ? ' disabled' : '') + '>⏸ Pause instead</button>' +
          '<button class="mmk-btn danger wide" data-act="confirm-delete"' + (S.busy ? ' disabled' : '') + '>' +
            (S.busy ? 'Deleting…' : 'Delete permanently') + '</button>' +
        '</div>';
    }

    /* ── Actions ──────────────────────────────────────────────────────────── */
    function op(promise, onOk) {
      S.busy = true; S.opError = null; paint();
      return promise.then(function (r) {
        S.busy = false;
        if (!r.ok) { S.opError = r.error; paint(); return; }
        onOk(r);
      }).catch(function (e) {
        S.busy = false;
        S.opError = (e && e.message) || 'That did not work.';
        paint();
      });
    }

    function saveCampaign() {
      if (S.busy) return;
      try { MC.buildCampaign({ scope: ctx.scope, name: S.form.name, type: S.form.type }); }
      catch (e) { S.opError = e.message; paint(); return; }
      op(MC.createCampaign({ scope: ctx.scope, name: S.form.name, type: S.form.type, callCreate: ctx.callCreate }),
        function (r) { S.created = r; S.copied = false; paint(); toast('Campaign created', 'success'); load(); });
    }

    function savePromotion() {
      if (S.busy) return;
      var f = S.form;
      try { MC.buildPromotion({ scope: ctx.scope, title: f.title, type: f.type, discountType: f.discountType,
        discountValue: f.discountValue, validUntil: f.validUntil, code: f.code }); }
      catch (e) { S.opError = e.message; paint(); return; }
      op(MC.createPromotion({ scope: ctx.scope, title: f.title, type: f.type, discountType: f.discountType,
        discountValue: f.discountValue, validUntil: f.validUntil, code: f.code, callCreatePromo: ctx.callCreatePromo }),
        function (r) { S.created = r; paint(); toast('Promotion created', 'success'); loadPromotions(); });
    }

    function saveAd() {
      if (S.busy) return;
      try { MC.buildAd({ title: S.form.title, budgetKES: S.form.budgetKES }); }
      catch (e) { S.opError = e.message; paint(); return; }
      op(MC.createAd({ title: S.form.title, budgetKES: S.form.budgetKES, callCreateAd: ctx.callCreateAd }),
        function (r) { S.created = r; paint(); toast('Ad submitted for review', 'success'); });
    }

    function toggle(i) {
      var c = S.campaigns[i]; if (!c || S.busy) return;
      op(MC.setCampaignPaused({ campaignId: c.campaignId, pause: c.status !== 'paused', callPause: ctx.callPause }),
        function () { toast(c.status === 'paused' ? 'Campaign resumed' : 'Campaign paused', 'success'); load(); });
    }

    function confirmDelete() {
      var c = S.target; if (!c || S.busy) return;
      op(MC.deleteCampaign({ campaignId: c.campaignId, callDelete: ctx.callDelete }),
        function () { S.sheet = null; S.target = null; toast('Campaign deleted', 'success'); load(); });
    }

    function pausePromo(i) {
      var p = S.promotions[i]; if (!p || S.busy) return;
      op(MC.updatePromotion({ promoId: p.promoId || p.id, action: 'pause', callUpdatePromo: ctx.callUpdatePromo }),
        function () { toast('Promotion paused', 'success'); loadPromotions(); });
    }

    function copy(text, label) {
      var nav = (typeof navigator !== 'undefined') ? navigator : null;
      if (nav && nav.clipboard && nav.clipboard.writeText) {
        nav.clipboard.writeText(text).then(function () { S.copied = true; paint(); toast(label, 'success'); })
          .catch(function () { toast('The link could not be copied.', 'error'); });
        return;
      }
      toast('Copying is not available on this device.', 'error');
    }

    function onClick(ev) {
      var el = ev.target && ev.target.closest ? ev.target.closest('[data-act]') : null;
      if (!el || !host.contains(el)) return;
      var act = el.getAttribute('data-act');
      var i = parseInt(el.getAttribute('data-i'), 10);
      var v = el.getAttribute('data-v');

      if (act === 'tab')            { S.tab = el.getAttribute('data-t') || 'campaigns'; paint(); return; }
      if (act === 'reload')         { load(); return; }
      if (act === 'reload-promos')  { S.promoError = null; paint(); loadPromotions(); return; }
      if (act === 'close')          { if (S.busy) return; S.sheet = null; S.target = null; S.created = null;
                                      S.form = {}; S.opError = null; paint(); return; }
      if (act === 'open-campaign')  { S.sheet = 'campaign'; S.form = { type: null }; S.created = null; S.opError = null; paint(); return; }
      if (act === 'open-promotion') { S.sheet = 'promotion'; S.form = { discountType: 'percent' }; S.created = null; S.opError = null; paint(); return; }
      if (act === 'open-ad')        { S.sheet = 'ad'; S.form = {}; S.created = null; S.opError = null; paint(); return; }
      if (act === 'ctype')          { S.form.type = v; S.opError = null; paint(); return; }
      if (act === 'ptype')          { S.form.type = v; S.opError = null; paint(); return; }
      if (act === 'dtype')          { S.form.discountType = v; S.opError = null; paint(); return; }
      if (act === 'save-campaign')  { saveCampaign(); return; }
      if (act === 'save-promotion') { savePromotion(); return; }
      if (act === 'save-ad')        { saveAd(); return; }
      if (act === 'toggle')         { toggle(i); return; }
      if (act === 'pause-promo')    { pausePromo(i); return; }
      if (act === 'ask-delete')     { S.target = S.campaigns[i] || null; if (S.target) { S.sheet = 'confirm-delete'; S.opError = null; paint(); } return; }
      if (act === 'confirm-delete') { confirmDelete(); return; }
      if (act === 'pause-instead')  { var t = S.target; S.sheet = null;
                                      var idx = S.campaigns.indexOf(t); if (idx >= 0) toggle(idx); else paint(); return; }
      if (act === 'copy-campaign')  { var c = S.campaigns[i]; if (c && c.campaignUrl) copy(c.campaignUrl, 'Campaign link copied'); return; }
      if (act === 'copy-created')   { if (S.created && S.created.campaignUrl) copy(S.created.campaignUrl, 'Campaign link copied'); return; }
    }

    /* Form fields write straight into S.form; the sheet is not repainted on every
       keystroke, so focus and caret survive. The footer button is refreshed in
       place because its enabled state depends on the field. */
    var FIELDS = { 'mmk-name': 'name', 'mmk-title': 'title', 'mmk-value': 'discountValue',
      'mmk-until': 'validUntil', 'mmk-code': 'code', 'mmk-adtitle': 'title', 'mmk-budget': 'budgetKES' };
    function onInput(ev) {
      var el = ev.target; if (!el || !FIELDS[el.id]) return;
      S.form[FIELDS[el.id]] = el.value;
      var f = host.querySelector('.mmk-sh-f [data-act^="save-"]');
      if (!f) return;
      if (S.sheet === 'campaign') { f.disabled = !!(S.busy || !S.form.name || !S.form.type);
        f.textContent = S.busy ? 'Creating…' : (!S.form.type ? 'Choose a type' : 'Create campaign'); }
      else if (S.sheet === 'ad')  { f.disabled = !!(S.busy || !S.form.title || !S.form.budgetKES); }
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
