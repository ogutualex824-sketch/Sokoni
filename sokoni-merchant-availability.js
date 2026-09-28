/* ══════════════════════════════════════════════════════════════════════════════
   sokoni-merchant-availability.js — merchant-v2 › Availability, the control centre (2026-09-29)
   ══════════════════════════════════════════════════════════════════════════════
   Everything that decides "is this shop open", in one place, saved ONLY through the server
   (kasshop.setShopAvailability) and previewed with the ONE evaluator the storefront uses
   (window.SokoniShopHours, /sokoni-shop-hours.js — byte-identical to functions/shared/shop-hours.js):

     · live switches — taking orders · online · delivery · pickup        (saved instantly)
     · temporary closure — 1 hour · rest of today · until a date/time · reopen now, with a PUBLIC note
     · mode — opening hours, or by appointment
     · weekly hours — several periods a day (the gaps are breaks), past-midnight shifts, presets, copy
     · special dates — closed (holidays) or special hours, with a label
     · timezone · orders while closed
     · preview — "this is how customers see your shop", from the same evaluator, live switches included
       (the old preview said "Open" while the shop was offline)

   WHO: the owner; or an employee whose role carries manageAvailability (server-checked). Anyone else
   at the shop sees it read-only. "Saved" appears only after the server confirmed.

   Mount:  SokoniMerchantAvailability.mount(host, ctx) → { refresh, destroy, state }
     ctx: { shopId?, callGet (getShopAvailability), callSave (setShopAvailability), onToast?, openStorefront? }
   ══════════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  var api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SokoniMerchantAvailability = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';
  var CSS_ID = 'sokoni-merchant-availability-css';
  var DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  var LABEL = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };
  var ZONES = [['Africa/Nairobi', 'Kenya (Nairobi)'], ['Africa/Kampala', 'Uganda (Kampala)'], ['Africa/Dar_es_Salaam', 'Tanzania (Dar es Salaam)'],
    ['Africa/Kigali', 'Rwanda (Kigali)'], ['Africa/Addis_Ababa', 'Ethiopia (Addis Ababa)'], ['Africa/Lagos', 'Nigeria (Lagos)'],
    ['Africa/Johannesburg', 'South Africa (Johannesburg)'], ['Asia/Dubai', 'UAE (Dubai)'], ['Europe/London', 'United Kingdom (London)']];
  var LIVE = [['acceptingOrders', 'Taking orders', 'Turn off to pause all new orders'], ['online', 'Shop online', 'Show as online in SOKONI'],
    ['delivery', 'Delivery', 'Offer delivery'], ['pickup', 'Pickup', 'Offer in-store pickup']];

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function H() { return root.SokoniShopHours || null; }
  function clone(o) { return JSON.parse(JSON.stringify(o == null ? null : o)); }
  function stdWeek() {
    var w = {}; DAYS.forEach(function (d) { w[d] = { closed: false, periods: [{ open: '08:00', close: '18:00' }] }; });
    w.sat = { closed: false, periods: [{ open: '09:00', close: '15:00' }] }; w.sun = { closed: true, periods: [] };
    return w;
  }
  function blankWeek() { var w = {}; DAYS.forEach(function (d) { w[d] = { closed: true, periods: [] }; }); return w; }

  /** Problems the owner can fix before saving (the server re-checks every one). */
  function validate(hours, overrides) {
    var e = [];
    var h = H();
    DAYS.forEach(function (d) {
      var c = hours && hours[d]; if (!c || c.closed) return;
      if (!c.periods || !c.periods.length) e.push(LABEL[d] + ' is open but has no hours.');
      (c.periods || []).forEach(function (p, i) {
        var a = h ? h.toMin(p.open) : null, b = h ? h.toMin(p.close) : null;
        if (a === null || b === null) e.push(LABEL[d] + ': period ' + (i + 1) + ' needs a start and an end.');
        else if (a === b) e.push(LABEL[d] + ': period ' + (i + 1) + ' starts and ends at the same time.');
      });
    });
    Object.keys(overrides || {}).forEach(function (k) {
      var o = overrides[k]; if (o && !o.closed && Array.isArray(o.periods)) o.periods.forEach(function (p) {
        if (!h || h.toMin(p.open) === null || h.toMin(p.close) === null) e.push('Special hours on ' + k + ' need a start and an end.');
      });
    });
    return e;
  }
  /** The breaks between a day's periods, as text ("13:00–14:00"). */
  function breaksOf(periods) {
    var h = H(); if (!h || !periods || periods.length < 2) return [];
    var s = periods.slice().sort(function (a, b) { return h.toMin(a.open) - h.toMin(b.open); });
    var out = [];
    for (var i = 1; i < s.length; i++) if (h.toMin(s[i].open) > h.toMin(s[i - 1].close)) out.push(h.fmt12(s[i - 1].close) + ' – ' + h.fmt12(s[i].open));
    return out;
  }

  var CSS = [
    '.mav{color:var(--txt,#f4f4f4);padding-bottom:96px}.mav *{box-sizing:border-box}',
    '.mav-hero{border-radius:20px;padding:18px;margin-bottom:14px;border:1px solid var(--line,rgba(255,255,255,.1));background:radial-gradient(120% 140% at 0% 0%,rgba(113,255,0,.12),rgba(255,255,255,.02) 60%)}',
    '.mav-hero.soon{background:radial-gradient(120% 140% at 0% 0%,rgba(255,180,0,.16),rgba(255,255,255,.02) 60%)}',
    '.mav-hero.break{background:radial-gradient(120% 140% at 0% 0%,rgba(255,214,0,.14),rgba(255,255,255,.02) 60%)}',
    '.mav-hero.closed{background:radial-gradient(120% 140% at 0% 0%,rgba(255,82,82,.14),rgba(255,255,255,.02) 60%)}',
    '.mav-hero.info{background:radial-gradient(120% 140% at 0% 0%,rgba(0,194,255,.14),rgba(255,255,255,.02) 60%)}',
    '.mav-k{font-size:11px;font-weight:800;letter-spacing:.8px;text-transform:uppercase;color:var(--txt2,#a8a8a8)}',
    '.mav-t{display:flex;align-items:center;gap:10px;font-size:22px;font-weight:900;margin:6px 0 2px}',
    '.mav-dot{width:12px;height:12px;border-radius:50%;background:#71ff00;box-shadow:0 0 0 4px rgba(113,255,0,.18)}',
    '.soon .mav-dot{background:#ffb400;box-shadow:0 0 0 4px rgba(255,180,0,.2)}.break .mav-dot{background:#ffd600;box-shadow:0 0 0 4px rgba(255,214,0,.2)}',
    '.closed .mav-dot{background:#ff5252;box-shadow:0 0 0 4px rgba(255,82,82,.2)}.info .mav-dot{background:#00c2ff;box-shadow:0 0 0 4px rgba(0,194,255,.2)}',
    '.mav-d{font-size:14px;color:var(--txt2,#a8a8a8)}',
    '.mav-card{border:1px solid var(--line,rgba(255,255,255,.09));border-radius:16px;padding:16px;margin:0 0 14px;background:rgba(255,255,255,.025)}',
    '.mav-h{font-size:16px;font-weight:800;margin:0 0 4px}.mav-sub{font-size:12.5px;color:var(--txt2,#a8a8a8);line-height:1.55;margin:0 0 12px}',
    '.mav-sw{display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(min(200px,100%),1fr))}',
    '.mav-tog{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:56px;padding:10px 14px;border-radius:14px;border:1px solid var(--line,rgba(255,255,255,.09));background:rgba(255,255,255,.03);cursor:pointer;font:inherit;color:inherit;text-align:left;width:100%}',
    '.mav-tog b{display:block;font-size:14px}.mav-tog small{display:block;font-size:11.5px;color:var(--txt2,#a8a8a8)}',
    '.mav-pill{flex:0 0 auto;width:46px;height:26px;border-radius:999px;background:rgba(255,255,255,.14);position:relative;transition:background .2s}',
    '.mav-pill::after{content:"";position:absolute;top:3px;left:3px;width:20px;height:20px;border-radius:50%;background:#fff;transition:transform .2s}',
    '.mav-tog[aria-checked="true"] .mav-pill{background:var(--acc,#71ff00)}.mav-tog[aria-checked="true"] .mav-pill::after{transform:translateX(20px)}',
    '.mav-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}',
    '.mav-btn{min-height:44px;padding:10px 14px;border-radius:12px;cursor:pointer;font:inherit;font-size:13px;font-weight:800;border:1px solid var(--line,rgba(255,255,255,.12));background:rgba(255,255,255,.05);color:var(--txt,#f4f4f4)}',
    '.mav-btn.solid{background:var(--acc,#71ff00);border-color:var(--acc,#71ff00);color:#050505}.mav-btn.warn{border-color:rgba(255,82,82,.5);color:#ff9d9d}',
    '.mav-btn[disabled]{opacity:.45;cursor:not-allowed}',
    '.mav-in{min-height:44px;padding:10px 12px;border-radius:12px;font-size:16px;border:1px solid var(--line,rgba(255,255,255,.09));background:rgba(255,255,255,.04);color:var(--txt,#f4f4f4);color-scheme:dark;max-width:100%}',
    '.mav-day{border-top:1px solid var(--line,rgba(255,255,255,.07));padding:12px 0}.mav-day:first-of-type{border-top:0}',
    '.mav-day-h{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}',
    '.mav-day-h b{font-size:14px;min-width:92px}',
    '.mav-per{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:8px}',
    '.mav-brk{font-size:12px;color:#ffd24d;margin-top:6px}',
    '.mav-seg{display:flex;gap:8px;flex-wrap:wrap}.mav-seg button{flex:1 1 150px}',
    '.mav-seg button[aria-pressed="true"]{border-color:var(--acc,#71ff00);background:rgba(113,255,0,.1)}',
    '.mav-week{display:grid;gap:6px}.mav-week div{display:flex;justify-content:space-between;gap:10px;font-size:13px;padding:8px 10px;border-radius:10px;background:rgba(255,255,255,.03)}',
    '.mav-week .today{outline:1px solid rgba(113,255,0,.45)}.mav-week span:last-child{color:var(--txt2,#a8a8a8);text-align:right}',
    '.mav-note{border-radius:12px;padding:11px 13px;font-size:12.5px;line-height:1.55;margin:10px 0;background:rgba(255,255,255,.04);border:1px solid var(--line,rgba(255,255,255,.09));color:var(--txt2,#a8a8a8)}',
    '.mav-note.ok{background:rgba(113,255,0,.07);border-color:rgba(113,255,0,.3);color:#b6ff7a}.mav-note.bad{background:rgba(255,68,68,.07);border-color:rgba(255,68,68,.3);color:#ffb3b3}',
    '.mav-note.warn{background:rgba(255,180,0,.07);border-color:rgba(255,180,0,.3);color:#ffd27a}',
    '.mav-cta{position:sticky;bottom:0;z-index:5;display:flex;gap:10px;align-items:center;justify-content:space-between;flex-wrap:wrap;padding:12px;margin-top:16px;border-radius:16px;border:1px solid var(--line,rgba(255,255,255,.1));background:rgba(8,8,8,.92);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px)}',
    '.mav-cta .st{font-size:12.5px;color:var(--txt2,#a8a8a8);flex:1 1 160px}',
    '.mav :focus-visible{outline:2px solid var(--acc,#71ff00);outline-offset:2px}',
    '@media (prefers-reduced-motion:reduce){.mav-pill,.mav-pill::after{transition:none}}',
  ].join('');
  function injectCSS(doc) {
    if (!doc || doc.getElementById(CSS_ID)) return;
    var s = doc.createElement('style'); s.id = CSS_ID; s.textContent = CSS; (doc.head || doc.documentElement).appendChild(s);
  }

  function mount(host, ctx) {
    ctx = ctx || {};
    injectCSS(host.ownerDocument || (typeof document !== 'undefined' ? document : null));
    var S = { phase: 'loading', err: null, canEdit: false, shopId: ctx.shopId || null, saved: null, draft: null, verdict: null,
      busy: false, result: null, errors: [], ovDate: '', ovKind: 'closed', ovLabel: '', ovOpen: '10:00', ovClose: '15:00',
      tcUntil: '', tcNote: '' };
    var tick = null;
    function toast(m) { if (typeof ctx.onToast === 'function') ctx.onToast(m); }
    function data(r) { return (r && r.data) || r || {}; }
    /* the owner saves their own shop; a staff session names it, and the server checks manageAvailability */
    function payloadShop() { return ctx.shopId ? { shopId: ctx.shopId } : {}; }

    function load() {
      S.phase = 'loading'; paint();
      return Promise.resolve(ctx.callGet(Object.assign({ settings: true }, ctx.shopId ? { shopId: ctx.shopId } : {}))).then(function (r) {
        var d = data(r);
        S.shopId = d.shopId || S.shopId; S.canEdit = !!d.canEdit; S.verdict = d.verdict || null;
        var st = d.settings || {};
        S.saved = { live: st.live || {}, hours: st.hours || null, overrides: st.overrides || {}, temporaryClosure: st.temporaryClosure || null,
          mode: st.mode || 'hours', timezone: st.timezone || 'Africa/Nairobi', ordersWhenClosed: st.ordersWhenClosed !== false };
        S.draft = clone(S.saved); if (!S.draft.hours) S.draft.hours = null;
        S.phase = 'ready'; paint();
      }).catch(function (e) {
        S.phase = (e && (e.code === 'not-found' || /not-found/.test(e.code || ''))) ? 'no_shop' : 'error';
        S.err = (e && e.message) || 'Could not load availability.'; paint();
      });
    }

    function preview() {
      var h = H(); if (!h || !S.draft) return null;
      return h.evaluate({ live: S.draft.live, hours: S.draft.hours, overrides: S.draft.overrides, temporaryClosure: S.draft.temporaryClosure,
        mode: S.draft.mode, timezone: S.draft.timezone }, Date.now());
    }
    function dirty() {
      if (!S.saved || !S.draft) return false;
      var pick = function (o) { return JSON.stringify([o.hours, o.overrides, o.mode, o.timezone, o.ordersWhenClosed]); };
      return pick(S.saved) !== pick(S.draft);
    }

    function heroHTML() {
      var h = H(); var v = preview();
      var hl = h ? h.headline(v) : { tone: 'info', title: 'Preview unavailable', detail: '' };
      var tone = hl.tone === 'open' ? '' : hl.tone;
      return '<div class="mav-hero ' + esc(tone) + '" role="status" aria-live="polite"><div class="mav-k">This is how customers see your shop' + (dirty() ? ' (with your unsaved changes)' : '') + '</div>' +
        '<div class="mav-t"><span class="mav-dot" aria-hidden="true"></span>' + esc(hl.title) + '</div>' +
        '<div class="mav-d">' + esc(hl.detail || '') + '</div>' +
        (v && v.state ? '<div class="mav-row" style="margin-top:10px">' +
          (v.state.delivery ? '<span class="mav-note" style="margin:0;padding:6px 10px">🚚 Delivery</span>' : '<span class="mav-note" style="margin:0;padding:6px 10px">🚚 No delivery</span>') +
          (v.state.pickup ? '<span class="mav-note" style="margin:0;padding:6px 10px">🏪 Pickup</span>' : '<span class="mav-note" style="margin:0;padding:6px 10px">🏪 No pickup</span>') +
          '<span class="mav-note" style="margin:0;padding:6px 10px">🕒 ' + esc(S.draft.timezone) + '</span></div>' : '') +
        (typeof ctx.openStorefront === 'function' ? '<button type="button" class="mav-btn" data-av="storefront" style="margin-top:10px">View my storefront ↗</button>' : '') + '</div>';
    }
    function liveHTML() {
      return '<div class="mav-card"><div class="mav-h">Right now</div><p class="mav-sub">These switch instantly for customers.</p><div class="mav-sw">' +
        LIVE.map(function (x) {
          var on = S.draft.live[x[0]] !== false;
          return '<button type="button" role="switch" aria-checked="' + on + '" class="mav-tog" data-av="live" data-k="' + x[0] + '"' + (S.canEdit && !S.busy ? '' : ' disabled') + '>' +
            '<span><b>' + esc(x[1]) + '</b><small>' + esc(x[2]) + '</small></span><span class="mav-pill" aria-hidden="true"></span></button>';
        }).join('') + '</div></div>';
    }
    function tempHTML() {
      var h = H(); var tc = S.draft.temporaryClosure;
      var active = h && tc && h.evaluate({ temporaryClosure: tc }, Date.now()).status === 'temporarily_closed';
      var dis = S.canEdit && !S.busy ? '' : ' disabled';
      return '<div class="mav-card"><div class="mav-h">Close temporarily</div><p class="mav-sub">Keeps your weekly hours — the shop reopens by itself when the time is up.</p>' +
        (active ? '<div class="mav-note warn">Closed ' + (tc.until ? 'until ' + esc(new Date(tc.until).toLocaleString()) : 'until you reopen') + (tc.note ? ' · “' + esc(tc.note) + '”' : '') + '</div>' +
          '<button type="button" class="mav-btn solid" data-av="reopen"' + dis + '>Reopen now</button>'
          : '<div class="mav-row"><button type="button" class="mav-btn" data-av="tc" data-m="60"' + dis + '>For 1 hour</button><button type="button" class="mav-btn" data-av="tc" data-m="today"' + dis + '>Rest of today</button></div>' +
            '<label class="mav-sub" style="display:block;margin:12px 0 6px" for="mav-tc-until">Or until</label><div class="mav-row"><input class="mav-in" type="datetime-local" id="mav-tc-until" data-avin="tcUntil" value="' + esc(S.tcUntil) + '"' + dis + '>' +
            '<button type="button" class="mav-btn" data-av="tc" data-m="until"' + dis + '>Close until then</button></div>') +
        '<label class="mav-sub" style="display:block;margin:12px 0 6px" for="mav-tc-note">Message for customers (optional, public)</label><input class="mav-in" style="width:100%" id="mav-tc-note" maxlength="120" data-avin="tcNote" placeholder="e.g. Back after stocktaking" value="' + esc(S.tcNote) + '"' + dis + '>' +
      '</div>';
    }
    function modeHTML() {
      var dis = S.canEdit ? '' : ' disabled';
      return '<div class="mav-card"><div class="mav-h">How customers reach you</div><div class="mav-seg" role="group" aria-label="Mode">' +
        '<button type="button" class="mav-btn" aria-pressed="' + (S.draft.mode === 'hours') + '" data-av="mode" data-m="hours"' + dis + '>🕒 Opening hours<br><small style="font-weight:500">Walk in or order during set hours</small></button>' +
        '<button type="button" class="mav-btn" aria-pressed="' + (S.draft.mode === 'appointment') + '" data-av="mode" data-m="appointment"' + dis + '>📅 By appointment<br><small style="font-weight:500">Consultants, photographers, trainers…</small></button>' +
      '</div></div>';
    }
    function weekHTML() {
      var dis = S.canEdit ? '' : ' disabled';
      if (!S.draft.hours) {
        return '<div class="mav-card"><div class="mav-h">Weekly hours</div><p class="mav-sub">No hours set — customers see you as open whenever you are online.</p>' +
          '<div class="mav-row"><button type="button" class="mav-btn solid" data-av="preset" data-m="std"' + dis + '>Start with a standard week</button><button type="button" class="mav-btn" data-av="preset" data-m="blank"' + dis + '>Start empty</button></div></div>';
      }
      var h = H();
      return '<div class="mav-card"><div class="mav-h">Weekly hours</div><p class="mav-sub">Add a second period for lunch or a break — customers see “On a break · reopens at …”. A close time earlier than the open time runs past midnight.</p>' +
        '<div class="mav-row" style="margin-bottom:6px"><button type="button" class="mav-btn" data-av="copyweek"' + dis + '>Copy Monday to weekdays</button><button type="button" class="mav-btn" data-av="preset" data-m="std"' + dis + '>Reset to standard week</button><button type="button" class="mav-btn warn" data-av="clearhours"' + dis + '>Remove hours</button></div>' +
        DAYS.map(function (d) {
          var c = S.draft.hours[d] || { closed: true, periods: [] };
          var open = !c.closed;
          return '<div class="mav-day"><div class="mav-day-h"><b>' + LABEL[d] + '</b>' +
            '<button type="button" role="switch" aria-checked="' + open + '" aria-label="' + LABEL[d] + ' open" class="mav-tog" style="width:auto;min-height:40px;padding:6px 10px;gap:8px" data-av="day" data-d="' + d + '"' + dis + '><small>' + (open ? 'Open' : 'Closed') + '</small><span class="mav-pill" aria-hidden="true"></span></button></div>' +
            (open ? (c.periods || []).map(function (p, i) {
              return '<div class="mav-per"><input class="mav-in" type="time" step="300" aria-label="' + LABEL[d] + ' period ' + (i + 1) + ' opens" data-avt="open" data-d="' + d + '" data-i="' + i + '" value="' + esc(p.open === '24:00' ? '23:59' : p.open) + '"' + dis + '>' +
                '<span aria-hidden="true">–</span><input class="mav-in" type="time" step="300" aria-label="' + LABEL[d] + ' period ' + (i + 1) + ' closes" data-avt="close" data-d="' + d + '" data-i="' + i + '" value="' + esc(p.close === '24:00' ? '23:59' : p.close) + '"' + dis + '>' +
                (c.periods.length > 1 ? '<button type="button" class="mav-btn" aria-label="Remove period" data-av="delp" data-d="' + d + '" data-i="' + i + '"' + dis + '>✕</button>' : '') + '</div>';
            }).join('') + (breaksOf(c.periods).length ? '<div class="mav-brk">☕ Break ' + esc(breaksOf(c.periods).join(', ')) + '</div>' : '') +
              '<button type="button" class="mav-btn" style="margin-top:8px" data-av="addp" data-d="' + d + '"' + dis + '>+ Add period / break</button>' : '') +
            '</div>';
        }).join('') + (h ? '' : '') + '</div>';
    }
    function specialHTML() {
      var dis = S.canEdit ? '' : ' disabled';
      var today = new Date().toISOString().slice(0, 10);
      var keys = Object.keys(S.draft.overrides || {}).filter(function (k) { return k >= today; }).sort();
      var h = H();
      return '<div class="mav-card"><div class="mav-h">Holidays &amp; special hours</div><p class="mav-sub">A date here replaces the weekly hours for that day — public holidays, stocktaking, events, extended opening.</p>' +
        (keys.length ? '<div class="mav-week" style="margin-bottom:12px">' + keys.map(function (k) {
          var o = S.draft.overrides[k];
          var txt = o.closed ? 'Closed' : (o.periods && o.periods.length ? (h ? h.periodsText(o.periods) : '') : 'Open all day');
          return '<div><span>' + esc(k) + (o.label ? ' · ' + esc(o.label) : '') + '</span><span>' + esc(txt) + ' <button type="button" class="mav-btn" style="min-height:32px;padding:4px 10px;margin-left:8px" aria-label="Remove ' + esc(k) + '" data-av="delov" data-k="' + esc(k) + '"' + dis + '>✕</button></span></div>';
        }).join('') + '</div>' : '<p class="mav-sub">No special dates coming up.</p>') +
        '<div class="mav-row"><input class="mav-in" type="date" aria-label="Date" data-avin="ovDate" min="' + today + '" value="' + esc(S.ovDate) + '"' + dis + '>' +
        '<select class="mav-in" aria-label="Kind" data-avin="ovKind"' + dis + '><option value="closed"' + (S.ovKind === 'closed' ? ' selected' : '') + '>Closed</option><option value="special"' + (S.ovKind === 'special' ? ' selected' : '') + '>Special hours</option><option value="allday"' + (S.ovKind === 'allday' ? ' selected' : '') + '>Open all day</option></select>' +
        (S.ovKind === 'special' ? '<input class="mav-in" type="time" step="300" aria-label="Opens" data-avin="ovOpen" value="' + esc(S.ovOpen) + '"' + dis + '><input class="mav-in" type="time" step="300" aria-label="Closes" data-avin="ovClose" value="' + esc(S.ovClose) + '"' + dis + '>' : '') +
        '<input class="mav-in" maxlength="60" aria-label="Label" placeholder="e.g. Mashujaa Day" data-avin="ovLabel" value="' + esc(S.ovLabel) + '"' + dis + '>' +
        '<button type="button" class="mav-btn" data-av="addov"' + dis + '>Add date</button></div></div>';
    }
    function settingsHTML() {
      var dis = S.canEdit ? '' : ' disabled';
      return '<div class="mav-card"><div class="mav-h">Settings</div><label class="mav-sub" style="display:block;margin-bottom:6px" for="mav-tz">Shop timezone</label>' +
        '<select class="mav-in" id="mav-tz" data-avin="timezone"' + dis + '>' + ZONES.map(function (z) { return '<option value="' + z[0] + '"' + (S.draft.timezone === z[0] ? ' selected' : '') + '>' + esc(z[1]) + '</option>'; }).join('') + '</select>' +
        '<button type="button" role="switch" aria-checked="' + (S.draft.ordersWhenClosed !== false) + '" class="mav-tog" style="margin-top:12px" data-av="owc"' + dis + '><span><b>Accept orders while closed</b><small>Orders placed out of hours are prepared when you open. Turn off to refuse them.</small></span><span class="mav-pill" aria-hidden="true"></span></button></div>';
    }
    function weekPreviewHTML() {
      var h = H(); if (!h || !S.draft.hours) return '';
      var v = preview(); var todayKey = h.DAYS[new Date(Date.parse(v.date + 'T12:00:00Z')).getUTCDay()];
      return '<div class="mav-card"><div class="mav-h">Your week, as customers see it</div><div class="mav-week">' + DAYS.map(function (d) {
        var c = S.draft.hours[d]; return '<div class="' + (d === todayKey ? 'today' : '') + '"><span>' + LABEL[d] + (d === todayKey ? ' · today' : '') + '</span><span>' + esc(c && !c.closed ? h.periodsText(c.periods) : 'Closed') + '</span></div>';
      }).join('') + '</div></div>';
    }
    function ctaHTML() {
      if (!S.canEdit) return '';
      var d = dirty();
      return '<div class="mav-cta"><div class="st" role="status" aria-live="polite">' + esc(S.busy ? 'Saving on the server…' : (d ? 'Unsaved changes to hours, dates or settings' : 'Hours saved')) + '</div>' +
        (d ? '<button type="button" class="mav-btn" data-av="discard"' + (S.busy ? ' disabled' : '') + '>Discard</button>' : '') +
        '<button type="button" class="mav-btn solid" data-av="save"' + (S.busy || !d ? ' disabled' : '') + '>' + (S.busy ? 'Saving…' : 'Save availability') + '</button></div>';
    }
    function paint() {
      if (S.phase === 'loading') { host.innerHTML = '<div class="mav"><div class="mav-card"><div class="mav-sub">Loading availability…</div></div></div>'; return; }
      if (S.phase === 'no_shop') { host.innerHTML = '<div class="mav"><div class="mav-card"><div class="mav-h">No shop yet</div><p class="mav-sub">Availability is set once SOKONI approves your business.</p></div></div>'; return; }
      if (S.phase === 'error') { host.innerHTML = '<div class="mav"><div class="mav-note bad">Availability could not be loaded: ' + esc(S.err) + '</div><button type="button" class="mav-btn" data-av="reload">Try again</button></div>'; return; }
      if (!H()) { host.innerHTML = '<div class="mav"><div class="mav-note bad">The hours engine did not load. Refresh the page.</div></div>'; return; }
      host.innerHTML = '<div class="mav">' + heroHTML() +
        (S.canEdit ? '' : '<div class="mav-note warn">You can view availability. Only the owner or a manager with permission can change it.</div>') +
        (S.result ? '<div class="mav-note ' + esc(S.result.kind) + '" role="status">' + esc(S.result.msg) + '</div>' : '') +
        (S.errors.length ? '<div class="mav-note bad" role="alert">' + S.errors.map(esc).join('<br>') + '</div>' : '') +
        liveHTML() + tempHTML() + modeHTML() + weekHTML() + specialHTML() + settingsHTML() + weekPreviewHTML() + ctaHTML() + '</div>';
    }

    function send(payload, okMsg) {
      if (!S.canEdit) return Promise.resolve();
      S.busy = true; S.result = null; paint();
      return Promise.resolve(ctx.callSave(Object.assign({}, payload, payloadShop()))).then(function (r) {
        var d = data(r); if (!d.success) throw new Error('The server did not confirm the change.');
        S.verdict = d.verdict || S.verdict;
        return load().then(function () { S.result = { kind: 'ok', msg: okMsg }; toast(okMsg); paint(); });
      }).catch(function (e) {
        S.result = { kind: 'bad', msg: 'NOT saved — ' + ((e && e.message) || 'unknown error') + '. Nothing changed for customers.' };
      }).then(function () { S.busy = false; paint(); });
    }
    function tcUntil(kind) {
      var h = H(); var now = Date.now();
      if (kind === '60') return now + 3600000;
      if (kind === 'today') {
        var off = h.tzOffsetMin(S.draft.timezone, now); var local = now + off * 60000;
        var mid = Date.UTC(new Date(local).getUTCFullYear(), new Date(local).getUTCMonth(), new Date(local).getUTCDate() + 1) - off * 60000;
        return mid;
      }
      if (!S.tcUntil) return null;
      var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(S.tcUntil); if (!m) return null;
      var guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
      return guess - h.tzOffsetMin(S.draft.timezone, guess) * 60000;   /* the time is in the SHOP's timezone */
    }

    function onClick(ev) {
      var t = ev.target && ev.target.closest ? ev.target.closest('[data-av]') : null;
      if (!t || !host.contains(t) || t.disabled) return;
      var a = t.getAttribute('data-av'), d = t.getAttribute('data-d'), i = +t.getAttribute('data-i');
      if (a === 'reload') return load();
      if (a === 'storefront') return ctx.openStorefront();
      if (!S.canEdit) return;
      if (a === 'live') { var k = t.getAttribute('data-k'); var live = {}; live[k] = !(S.draft.live[k] !== false); return send({ availability: live }, 'Updated — customers see it now.'); }
      if (a === 'tc') {
        var until = tcUntil(t.getAttribute('data-m'));
        if (t.getAttribute('data-m') === 'until' && (!until || until <= Date.now())) { S.result = { kind: 'bad', msg: 'Choose a date and time in the future.' }; return paint(); }
        return send({ temporaryClosure: { until: until, note: S.tcNote } }, 'Shop closed temporarily — it reopens by itself.');
      }
      if (a === 'reopen') return send({ temporaryClosure: null }, 'Shop reopened.');
      if (a === 'mode') { S.draft.mode = t.getAttribute('data-m'); return paint(); }
      if (a === 'preset') { S.draft.hours = t.getAttribute('data-m') === 'std' ? stdWeek() : blankWeek(); return paint(); }
      if (a === 'clearhours') { S.draft.hours = null; return paint(); }
      if (a === 'copyweek') { ['tue', 'wed', 'thu', 'fri'].forEach(function (x) { S.draft.hours[x] = clone(S.draft.hours.mon); }); return paint(); }
      if (a === 'day') { var c = S.draft.hours[d] || { closed: true, periods: [] }; c.closed = !c.closed; if (!c.closed && !c.periods.length) c.periods = [{ open: '08:00', close: '18:00' }]; S.draft.hours[d] = c; return paint(); }
      if (a === 'addp') { var ps = S.draft.hours[d].periods; var last = ps[ps.length - 1]; ps.push({ open: last ? last.close : '14:00', close: '18:00' }); return paint(); }
      if (a === 'delp') { S.draft.hours[d].periods.splice(i, 1); return paint(); }
      if (a === 'addov') {
        if (!S.ovDate) { S.result = { kind: 'bad', msg: 'Choose a date.' }; return paint(); }
        var o = S.ovKind === 'closed' ? { closed: true } : S.ovKind === 'special' ? { closed: false, periods: [{ open: S.ovOpen, close: S.ovClose }] } : { closed: false };
        if (S.ovLabel.trim()) o.label = S.ovLabel.trim().slice(0, 60);
        S.draft.overrides = S.draft.overrides || {}; S.draft.overrides[S.ovDate] = o; S.ovDate = ''; S.ovLabel = ''; S.result = null; return paint();
      }
      if (a === 'delov') { delete S.draft.overrides[t.getAttribute('data-k')]; return paint(); }
      if (a === 'owc') { S.draft.ordersWhenClosed = !(S.draft.ordersWhenClosed !== false); return paint(); }
      if (a === 'discard') { S.draft = clone(S.saved); S.errors = []; S.result = null; return paint(); }
      if (a === 'save') {
        S.errors = S.draft.hours ? validate(S.draft.hours, S.draft.overrides) : [];
        if (S.errors.length) return paint();
        var payload = { mode: S.draft.mode, timezone: S.draft.timezone, ordersWhenClosed: S.draft.ordersWhenClosed !== false };
        if (S.draft.hours) payload.schedule = { hours: S.draft.hours, overrides: S.draft.overrides || {} };
        else if (JSON.stringify(S.draft.overrides) !== JSON.stringify(S.saved.overrides)) {
          S.errors = ['Special dates need weekly hours — add hours first.']; return paint();
        }
        return send(payload, '✓ Availability updated — customers see it now.');
      }
    }
    function onInput(ev) {
      var el = ev.target; if (!el || !el.getAttribute) return;
      var k = el.getAttribute('data-avin');
      if (k) { if (k === 'timezone') { S.draft.timezone = el.value; paint(); } else { S[k] = el.value; if (k === 'ovKind') paint(); } return; }
      var tk = el.getAttribute('data-avt');
      if (tk) { var p = S.draft.hours[el.getAttribute('data-d')].periods[+el.getAttribute('data-i')]; p[tk] = el.value; }
    }
    function onChange(ev) {
      var el = ev.target; if (!el || !el.getAttribute) return;
      if (el.getAttribute('data-avt')) paint();   /* repaint on commit (not every keystroke): breaks + preview update */
    }
    host.addEventListener('click', onClick); host.addEventListener('input', onInput); host.addEventListener('change', onChange);
    load();
    tick = setInterval(function () { if (S.phase === 'ready' && !S.busy && host.isConnected !== false) { var he = host.querySelector('.mav-hero'); if (he) { var w = document.createElement('div'); w.innerHTML = heroHTML(); he.replaceWith(w.firstChild); } } }, 60000);
    return { refresh: load, state: function () { return S; }, destroy: function () {
      clearInterval(tick); host.removeEventListener('click', onClick); host.removeEventListener('input', onInput); host.removeEventListener('change', onChange);
    } };
  }
  return { mount: mount, CSS_ID: CSS_ID, _h: { validate: validate, breaksOf: breaksOf, stdWeek: stdWeek } };
}));
