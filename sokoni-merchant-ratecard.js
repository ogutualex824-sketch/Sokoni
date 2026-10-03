/* ════════════════════════════════════════════════════════════════════════════
   SOKONI Merchant Rate Card — the ONE generic provider rate-card editor

       merchant-v2 (#rates, provider session, gated on module:services)
       b2's mkt-rates (filtered to the marketing categories)
          ↓  mount(el, ctx)
       this surface
          ↓  providerDispatch {op, ...}
       providerListServices · providerAddService · providerUpdateService ·
       providerToggleService · providerUpdateServicePricing · bookingPreviewPrice
          ↓
       providerServices/{id}   (owner-only: providerId === auth.uid, server-checked)

   Contract (census 2026-10-03, byte-identical in the LIVE providerDispatch archive,
   functions/provider-ops.js — see docs/RATE_CARD_EDITOR.md):

   · providerUpdateServicePricing {serviceId, pricing} REPLACES providerServices/{id}.pricing
     with _sanitizePricing(pricing). It is NOT a merge: a field this editor leaves out is a
     field the provider loses. So the payload is ALWAYS the complete object that was loaded,
     plus the edits — never a diff. pricingPayload() below is that one rule.
   · Money is integer CENTS everywhere (basePrice, extraHourRate, flat rates, fixed deposits,
     travel fee/perKm, package/add-on prices; service price/fee/deposit). The provider types
     KES; kesToCents() converts by STRING arithmetic (no float multiply) and refuses fractions
     of a cent. The server coerces again (_cents); it is the authority.
   · Price PREVIEW is bookingPreviewPrice — the same computePrice the checkout runs. This file
     formats cents for display and does no price arithmetic of its own.
   · Booking prices are snapshotted server-side at creation. This editor never reads or writes
     bookings: changes apply to new bookings only.

   Read-only unless ctx.editable === true AND ctx.readOnly !== true (P0-F owner-state rule:
   anything but an explicit true is read-only). Every write path re-checks canEdit(), so a
   control re-enabled in devtools still cannot send. Previews are reads and stay available.

   Every client check here is a UX pre-check that mirrors the server sanitiser; a server
   refusal is shown VERBATIM (its own words), never rewritten into a guess.
   ════════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SokoniMerchantRateCard = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var CSS_ID = 'sokoni-merchant-ratecard-css';
  var NOTE_NEW_ONLY = 'Changes apply to new bookings only; existing bookings keep their price.';

  /* Server caps (provider-ops.js _sanitizePricing). Mirrored for UX only. */
  var CAP = { packages: 40, addOns: 60, holidays: 60, includes: 30, extras: 30,
              pkgName: 120, pkgDesc: 500, addName: 120, addDesc: 300, incl: 120,
              svcName: 200, svcDesc: 1000 };
  var RATES = [
    { key: 'weekendRate',     label: 'Weekend surcharge',     hours: false },
    { key: 'holidayRate',     label: 'Public holiday surcharge', hours: false },
    { key: 'peakRate',        label: 'Peak-hour surcharge',   hours: true },
    { key: 'offPeakDiscount', label: 'Off-peak discount',     hours: true }
  ];

  /* ── pure helpers ─────────────────────────────────────────────────────── */
  function esc (s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function clone (o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
  function isObj (x) { return !!x && typeof x === 'object' && !Array.isArray(x); }

  /* KES text → integer cents, by string arithmetic. '' → {ok:true, empty:true, cents:0}. */
  function kesToCents (raw) {
    var s = String(raw == null ? '' : raw).replace(/[\s,]/g, '').replace(/^KES/i, '');
    if (s === '') return { ok: true, empty: true, cents: 0 };
    if (/^-/.test(s)) return { ok: false, error: 'Amounts cannot be negative.' };
    var m = /^(\d{1,9})(?:\.(\d*))?$/.exec(s);
    if (!m) return { ok: false, error: 'Enter an amount in KES, e.g. 1500 or 1500.50.' };
    var frac = m[2] || '';
    if (frac.length > 2) return { ok: false, error: 'KES amounts go to the cent — at most 2 decimal places.' };
    var cents = parseInt(m[1], 10) * 100 + parseInt((frac + '00').slice(0, 2), 10);
    return { ok: true, empty: false, cents: cents };
  }
  /* Integer cents → the editable KES text (no float division). */
  function centsToKesInput (c) {
    var n = Math.round(Number(c) || 0); if (n < 0) n = 0;
    var w = Math.floor(n / 100), f = n % 100;
    return f ? w + '.' + (f < 10 ? '0' : '') + f : String(w);
  }
  /* Integer cents → display text. Formatting only. */
  function fmtKes (c) {
    var n = Math.round(Number(c) || 0), neg = n < 0; if (neg) n = -n;
    var w = String(Math.floor(n / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ','), f = n % 100;
    return (neg ? '− ' : '') + 'KES ' + w + (f ? '.' + (f < 10 ? '0' : '') + f : '');
  }
  function parseInt0 (raw, max) {
    var s = String(raw == null ? '' : raw).trim();
    if (s === '') return { ok: true, v: 0 };
    if (!/^\d+$/.test(s)) return { ok: false, error: 'Enter a whole number.' };
    var v = parseInt(s, 10);
    if (max != null && v > max) return { ok: false, error: 'At most ' + max + '.' };
    return { ok: true, v: v };
  }
  function parseNum (raw, max) {
    var s = String(raw == null ? '' : raw).trim();
    if (s === '') return { ok: true, v: 0 };
    if (!/^\d+(\.\d+)?$/.test(s)) return { ok: false, error: 'Enter a number (0 or more).' };
    var v = Number(s);
    if (max != null && v > max) return { ok: false, error: 'At most ' + max + '.' };
    return { ok: true, v: v };
  }
  var TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
  var DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
  function splitList (raw) {
    return String(raw == null ? '' : raw).split(/[\n,]/).map(function (x) { return x.trim(); })
      .filter(Boolean);
  }
  function newId (prefix) {
    var r = '';
    try {
      var a = new Uint32Array(2); (globalThis.crypto || {}).getRandomValues(a);
      r = a[0].toString(36) + a[1].toString(36);
    } catch (_) { r = Date.now().toString(36) + Math.floor(Math.random() * 1e9).toString(36); }
    return prefix + r.slice(0, 12);
  }

  /* THE edit rule (P0-F). Only an explicit editable === true, and not readOnly, edits. */
  function canEdit (ctx) { return !!ctx && ctx.readOnly !== true && ctx.editable === true; }
  function readOnlyReason (ctx) {
    if (ctx && ctx.reason) return String(ctx.reason);
    if (ctx && ctx.readOnly === true) return 'This view is read-only.';
    return 'Editing is not available for this account right now.';
  }

  /* ctx.filter. categories: [] declared = match nothing (fail closed); absent = no filter.
     serviceKind matches s.serviceKind only — the live writer stores no such field, so a
     declared serviceKind shows only services that carry it (documented). Deleted
     (removedAt) services are never editable and are not listed. */
  function filterServices (list, filter) {
    filter = filter || {};
    return (Array.isArray(list) ? list : []).filter(function (s) {
      if (!s || !s.id || s.removedAt) return false;
      if (filter.categories != null) {
        var cats = Array.isArray(filter.categories) ? filter.categories : [];
        if (cats.indexOf(s.category) < 0 && cats.indexOf(s.subcategory) < 0) return false;
      }
      if (filter.serviceKind != null && s.serviceKind !== filter.serviceKind) return false;
      return true;
    });
  }

  /* THE save payload: the COMPLETE loaded object plus edits — never a partial. Only
     editor scaffolding is removed (rate hours left blank on both ends). */
  function pricingPayload (draft) {
    var p = clone(draft) || {};
    RATES.forEach(function (r) {
      var x = p[r.key];
      if (isObj(x) && Array.isArray(x.hours) && !x.hours[0] && !x.hours[1]) delete x.hours;
    });
    return p;
  }

  /* Whole-object pre-check before a save. Returns plain-language problems. */
  function draftProblems (d) {
    var out = [];
    RATES.forEach(function (r) {
      var x = d[r.key]; if (!isObj(x)) return;
      if (!(Number(x.value) > 0)) out.push(r.label + ': enter a value above 0, or choose Off.');
      if (x.type === 'pct' && r.key === 'offPeakDiscount' && Number(x.value) > 100) out.push(r.label + ': a discount cannot exceed 100%.');
      if (Array.isArray(x.hours) && (!!x.hours[0] !== !!x.hours[1])) out.push(r.label + ': set both the start and end time, or neither.');
    });
    function depCheck (dep, where) {
      if (!isObj(dep)) return;
      if (dep.mode === 'pct' && !(Number(dep.value) >= 0 && Number(dep.value) <= 100)) out.push(where + ': a deposit percentage is between 0 and 100.');
    }
    depCheck(d.deposit, 'Deposit');
    if ((d.holidays || []).length > CAP.holidays) out.push('Holidays: at most ' + CAP.holidays + ' dates.');
    var pk = d.packages || [], ad = d.addOns || [];
    if (pk.length > CAP.packages) out.push('Packages: at most ' + CAP.packages + '.');
    if (ad.length > CAP.addOns) out.push('Add-ons: at most ' + CAP.addOns + '.');
    pk.forEach(function (p, i) {
      if (!p || !String(p.name || '').trim()) out.push('Package ' + (i + 1) + ': a name is required (a nameless package is dropped).');
      depCheck(p && p.deposit, 'Package ' + (i + 1) + ' deposit');
    });
    ad.forEach(function (a, i) {
      if (!a || !String(a.name || '').trim()) out.push('Add-on ' + (i + 1) + ': a name is required (a nameless add-on is dropped).');
    });
    return out;
  }

  function getPath (o, path) {
    return path.split('.').reduce(function (a, k) { return a == null ? undefined : a[k]; }, o);
  }
  function setPath (o, path, v) {
    var ks = path.split('.'), cur = o;
    for (var i = 0; i < ks.length - 1; i++) {
      if (cur[ks[i]] == null || typeof cur[ks[i]] !== 'object') cur[ks[i]] = /^\d+$/.test(ks[i + 1]) ? [] : {};
      cur = cur[ks[i]];
    }
    cur[ks[ks.length - 1]] = v;
  }

  /* What a pricing path holds, given the draft (rate/deposit value units follow their type). */
  function kindOf (d, path) {
    var ks = path.split('.'), last = ks[ks.length - 1];
    if (path === 'basePrice' || path === 'extraHourRate' || path === 'travel.fee' || path === 'travel.perKm') return 'money';
    if (path === 'durationMins') return 'int';
    if (path === 'holidays') return 'dates';
    if (path === 'travel.freeRadiusKm' || path === 'travel.maxKm') return 'km';
    if (RATES.some(function (r) { return r.key === ks[0]; })) {
      if (last === 'type') return 'rateType';
      if (ks[1] === 'hours') return 'time';
      if (last === 'value') return (d[ks[0]] && d[ks[0]].type === 'flat') ? 'money' : 'pct';
    }
    var depAt = ks.indexOf('deposit');
    if (depAt > -1) {
      if (last === 'mode') return 'depMode';
      if (last === 'balanceDue') return 'balanceDue';
      if (last === 'value') {
        var dep = getPath(d, ks.slice(0, depAt + 1).join('.'));
        return (dep && dep.mode === 'pct') ? 'pct' : 'money';
      }
    }
    if (ks[0] === 'packages' || ks[0] === 'addOns') {
      if (last === 'price') return 'money';
      if (last === 'durationMins' || last === 'qtyMax') return 'int';
      if (last === 'available') return 'bool';
      if (last === 'includes') return 'list';
      if (last === 'extras') return 'extras';
      if (last === 'name') return 'text:' + (ks[0] === 'packages' ? CAP.pkgName : CAP.addName);
      if (last === 'description') return 'text:' + (ks[0] === 'packages' ? CAP.pkgDesc : CAP.addDesc);
    }
    return null;
  }

  /* Apply one pricing input to the draft. Returns an error string, or null. On error the
     draft keeps its last valid value — an invalid entry is never half-written. */
  function applyPricing (d, path, raw, checked, val) {
    var k = kindOf(d, path);
    var ks = path.split('.');
    if (!k) return 'This field is not editable.';
    if (k === 'money') {
      var c = kesToCents(raw); if (!c.ok) return c.error;
      setPath(d, path, c.cents); return null;
    }
    if (k === 'int') { var n = parseInt0(raw, 100000); if (!n.ok) return n.error; setPath(d, path, n.v); return null; }
    if (k === 'km')  { var km = parseNum(raw, 100000); if (!km.ok) return km.error; setPath(d, path, km.v); return null; }
    if (k === 'pct') {
      var pc = parseNum(raw, 100000); if (!pc.ok) return pc.error;
      if (ks.indexOf('deposit') > -1 && pc.v > 100) return 'A deposit percentage is at most 100.';
      setPath(d, path, pc.v); return null;
    }
    if (k === 'time') {
      var t = String(raw || '').trim();
      if (t && !TIME_RE.test(t)) return 'Use 24-hour time, e.g. 18:00.';
      var rate = d[ks[0]]; if (!isObj(rate)) return 'Choose a rate type first.';
      if (!Array.isArray(rate.hours)) rate.hours = ['', ''];
      rate.hours[Number(ks[2])] = t; return null;
    }
    if (k === 'dates') {
      var ds = splitList(raw), bad = ds.filter(function (x) { return !DATE_RE.test(x); });
      if (bad.length) return 'Dates must look like 2026-12-25 (not: ' + bad.slice(0, 3).join(', ') + ').';
      if (ds.length > CAP.holidays) return 'At most ' + CAP.holidays + ' dates.';
      d.holidays = ds.filter(function (x, i) { return ds.indexOf(x) === i; }); return null;
    }
    if (k === 'list') {
      var li = splitList(raw);
      if (li.length > CAP.includes) return 'At most ' + CAP.includes + ' items.';
      if (li.some(function (x) { return x.length > CAP.incl; })) return 'Each item is at most ' + CAP.incl + ' characters.';
      setPath(d, path, li); return null;
    }
    if (k === 'extras') {
      var cur = getPath(d, path); cur = Array.isArray(cur) ? cur.slice() : [];
      var i = cur.indexOf(val);
      if (checked && i < 0) cur.push(val); if (!checked && i > -1) cur.splice(i, 1);
      if (cur.length > CAP.extras) return 'At most ' + CAP.extras + ' linked add-ons.';
      setPath(d, path, cur); return null;
    }
    if (k === 'bool') { setPath(d, path, checked === true); return null; }
    if (k.indexOf('text:') === 0) {
      var max = Number(k.slice(5)), s = String(raw == null ? '' : raw);
      if (s.length > max) return 'At most ' + max + ' characters.';
      if (/[<>]/.test(s)) return 'The characters < and > are not allowed.';
      setPath(d, path, s); return null;
    }
    if (k === 'rateType') {
      if (raw === 'off') { delete d[ks[0]]; return null; }
      if (raw !== 'pct' && raw !== 'flat') return 'Choose Off, a percentage or a fixed amount.';
      var prev = d[ks[0]];
      /* A type change changes the UNIT of value (percent vs cents): never carry the number over. */
      d[ks[0]] = { type: raw, value: (isObj(prev) && prev.type === raw) ? prev.value : 0 };
      if (isObj(prev) && Array.isArray(prev.hours)) d[ks[0]].hours = prev.hours.slice();
      return null;
    }
    if (k === 'depMode') {
      var depPath = ks.slice(0, -1).join('.');
      var holder = ks.length > 2 ? getPath(d, ks.slice(0, -2).join('.')) : d;
      if (raw === 'none') { delete holder.deposit; return null; }
      if (['fixed', 'pct', 'full'].indexOf(raw) < 0) return 'Choose a deposit type.';
      var old = getPath(d, depPath);
      var nd = { mode: raw };
      if (raw !== 'full') nd.value = (isObj(old) && old.mode === raw) ? old.value : 0;
      nd.balanceDue = (isObj(old) && old.balanceDue) || 'completion';
      setPath(d, depPath, nd); return null;
    }
    if (k === 'balanceDue') {
      if (raw !== 'before' && raw !== 'completion') return 'Choose when the balance is due.';
      setPath(d, path, raw); return null;
    }
    return 'This field is not editable.';
  }

  /* Basic service fields (providerUpdateService). Returns error or null. */
  function applyBasic (b, key, raw) {
    if (key === 'price' || key === 'fee' || key === 'deposit') {
      var c = kesToCents(raw); if (!c.ok) return c.error; b[key] = c.cents; return null;
    }
    if (key === 'durationMins') { var n = parseInt0(raw, 100000); if (!n.ok) return n.error; b[key] = n.v; return null; }
    if (key === 'name' || key === 'description') {
      var s = String(raw == null ? '' : raw);
      var max = key === 'name' ? CAP.svcName : CAP.svcDesc;
      if (s.length > max) return 'At most ' + max + ' characters.';
      if (/[<>]/.test(s)) return 'The characters < and > are not allowed.';
      if (key === 'name' && !s.trim()) return 'A service needs a name.';
      b[key] = s; return null;
    }
    return 'This field is not editable.';
  }
  var BASIC = ['name', 'description', 'price', 'fee', 'deposit', 'durationMins'];
  function basicOf (svc) {
    return { name: String(svc.name || ''), description: String(svc.description || ''),
             price: Math.round(Number(svc.price) || 0), fee: Math.round(Number(svc.fee) || 0),
             deposit: Math.round(Number(svc.deposit) || 0), durationMins: Math.round(Number(svc.durationMins) || 0) };
  }
  function basicChanges (svc, b) {
    var o = basicOf(svc), ch = {};
    BASIC.forEach(function (k) { if (o[k] !== b[k]) ch[k] = b[k]; });
    return ch;
  }
  function errText (e) {
    var m = e && (e.message || (e.details && e.details.message));
    return m ? String(m) : 'The request failed. Nothing was changed.';
  }
  function unwrap (r) { return (r && typeof r === 'object' && 'data' in r) ? r.data : r; }

  /* ── styles ───────────────────────────────────────────────────────────── */
  var CSS = [
    '.mrc{display:flex;flex-direction:column;gap:12px;padding:12px 14px 24px;max-width:860px;margin:0 auto;color:var(--txt,#f4f4f4)}',
    '.mrc-hd{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px}',
    '.mrc-hd h2{margin:0;font-size:17px}',
    '.mrc-note,.mrc-ro{font-size:12.5px;line-height:1.5;padding:10px 12px;border-radius:12px;border:1px solid var(--line,rgba(255,255,255,.09));color:var(--txt2,#bbb)}',
    '.mrc-ro{border-color:rgba(251,191,36,.35);background:rgba(251,191,36,.08)}',
    '.mrc-list{display:flex;flex-direction:column;gap:8px;margin:0;padding:0;list-style:none}',
    '.mrc-row{border:1px solid var(--line,rgba(255,255,255,.09));border-radius:14px;background:var(--panel,#0d0d0d)}',
    '.mrc-rowhd{display:flex;align-items:center;gap:10px;padding:10px 12px;min-height:56px}',
    '.mrc-rowhd .nm{flex:1;min-width:0}',
    '.mrc-rowhd .nm b{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.mrc-rowhd .nm small{color:var(--txt3,#888);font-size:11.5px}',
    '.mrc-chip{font-size:10.5px;font-weight:800;text-transform:uppercase;padding:4px 8px;border-radius:8px;border:1px solid var(--line,rgba(255,255,255,.09))}',
    '.mrc-chip.on{color:var(--acc,#71ff00);border-color:rgba(113,255,0,.35)}',
    '.mrc-btn{min-height:44px;padding:0 14px;border-radius:12px;border:1px solid var(--line,rgba(255,255,255,.09));background:rgba(255,255,255,.05);color:inherit;font:inherit;font-weight:700;cursor:pointer}',
    '.mrc-btn.pri{background:var(--acc,#71ff00);color:#061000;border-color:transparent}',
    '.mrc-btn[disabled]{opacity:.45;cursor:not-allowed}',
    '.mrc-body{padding:0 12px 12px;display:flex;flex-direction:column;gap:12px}',
    '.mrc-tabs{display:flex;gap:6px;overflow-x:auto}',
    '.mrc-tabs [aria-selected="true"]{border-color:var(--acc,#71ff00);color:var(--acc,#71ff00)}',
    '.mrc-grid{display:grid;grid-template-columns:1fr;gap:10px}',
    '@media(min-width:560px){.mrc-grid{grid-template-columns:1fr 1fr}}',
    '.mrc-f{display:flex;flex-direction:column;gap:4px;font-size:12.5px;color:var(--txt2,#bbb)}',
    '.mrc-f input,.mrc-f select,.mrc-f textarea{min-height:44px;padding:8px 10px;border-radius:10px;border:1px solid var(--line,rgba(255,255,255,.12));background:rgba(255,255,255,.04);color:var(--txt,#f4f4f4);font:inherit;width:100%;box-sizing:border-box}',
    '.mrc-f textarea{min-height:72px}',
    '.mrc-f [aria-invalid="true"]{border-color:var(--danger,#ff5252)}',
    '.mrc-err{color:var(--danger,#ff5252);font-size:12px;min-height:0}',
    '.mrc-chk{flex-direction:row;align-items:center;gap:8px;min-height:44px}',
    '.mrc-chk input{width:20px;height:20px;min-height:0}',
    '.mrc-sub{border:1px dashed var(--line,rgba(255,255,255,.12));border-radius:12px;padding:10px;display:flex;flex-direction:column;gap:10px}',
    '.mrc-sub h4{margin:0;font-size:13px}',
    '.mrc-acts{display:flex;flex-wrap:wrap;gap:8px}',
    '.mrc-msg{font-size:13px;line-height:1.5}',
    '.mrc-msg.err{color:var(--danger,#ff5252)}',
    '.mrc-msg.ok{color:var(--acc,#71ff00)}',
    '.mrc-pv table{width:100%;border-collapse:collapse;font-size:13px}',
    '.mrc-pv td{padding:6px 0;border-bottom:1px solid var(--line,rgba(255,255,255,.09))}',
    '.mrc-pv td:last-child{text-align:right;white-space:nowrap}',
    '.mrc-state{padding:32px 16px;text-align:center;color:var(--txt2,#bbb)}'
  ].join('\n');
  function injectCss () {
    if (typeof document === 'undefined' || !document.createElement || !document.head) return;
    if (document.getElementById && document.getElementById(CSS_ID)) return;
    var st = document.createElement('style'); st.id = CSS_ID; st.textContent = CSS;
    document.head.appendChild(st);
  }

  /* ── mount ────────────────────────────────────────────────────────────── */
  function mount (el, ctx) {
    ctx = ctx || {};
    if (!el) throw new Error('rate card: a host element is required');
    injectCss();
    var EDIT = canEdit(ctx);
    var dis = EDIT ? '' : ' disabled aria-disabled="true"';
    var gen = 1, destroyed = false;
    var st = { status: 'loading', error: null, services: [], cards: {}, open: null, tab: 'basic',
               add: null, notice: null };

    function dispatch (op, payload) {
      if (typeof ctx.callable !== 'function') return Promise.reject(new Error('The service connection is not available. Reload the page.'));
      var fn = ctx.callable('providerDispatch');
      if (typeof fn !== 'function') return Promise.reject(new Error('The service connection is not available. Reload the page.'));
      var body = Object.assign({ op: op }, payload || {});
      return Promise.resolve(fn(body)).then(unwrap);
    }
    function toast (m) { try { if (typeof ctx.onToast === 'function') ctx.onToast(m); } catch (_) {} }

    function cardFor (svc) {
      var saved = isObj(svc.pricing) ? clone(svc.pricing) : {};
      return { svc: svc, saved: saved, draft: clone(saved), errors: {}, basic: basicOf(svc), berrors: {},
               msg: null, busy: false,
               pv: { packageId: '', addOns: [], durationMins: '', date: '', startTime: '', distanceKm: '', result: null, error: null, busy: false } };
    }
    function dirty (c) {
      return JSON.stringify(c.draft) !== JSON.stringify(c.saved) || Object.keys(basicChanges(c.svc, c.basic)).length > 0;
    }

    function load () {
      var g = gen;
      if (!ctx.uid) { st.status = 'signedout'; render(); return Promise.resolve(); }
      if (!st.services.length) { st.status = 'loading'; render(); }
      return dispatch('providerListServices', {}).then(function (r) {
        if (destroyed || g !== gen) return;
        var list = filterServices(r && r.services, ctx.filter);
        list.sort(function (a, b) {
          var aa = a.active !== false ? 0 : 1, bb = b.active !== false ? 0 : 1;
          return aa - bb || String(a.name || '').localeCompare(String(b.name || ''));
        });
        var next = {};
        list.forEach(function (s) {
          var old = st.cards[s.id];
          next[s.id] = (old && dirty(old)) ? Object.assign(old, { svc: s }) : cardFor(s);
        });
        st.cards = next; st.services = list; st.status = 'ready'; st.error = null;
        if (st.open && !next[st.open]) st.open = null;
        render();
      }).catch(function (e) {
        if (destroyed || g !== gen) return;
        st.status = 'error'; st.error = errText(e); render();
      });
    }

    /* ── writes (each re-checks the edit rule) ── */
    function refuseIfReadOnly (c) {
      if (canEdit(ctx)) return false;
      if (c) { c.msg = { kind: 'err', text: readOnlyReason(ctx) }; render(); }
      return true;
    }
    function savePricing (id) {
      var c = st.cards[id]; if (!c || c.busy) return Promise.resolve();
      if (refuseIfReadOnly(c)) return Promise.resolve();
      var errs = Object.keys(c.errors).filter(function (k) { return c.errors[k]; });
      var probs = draftProblems(c.draft);
      if (errs.length || probs.length) {
        c.msg = { kind: 'err', text: 'Not saved. ' + (errs.length ? 'Fix the highlighted fields. ' : '') + probs.join(' ') };
        render(); return Promise.resolve();
      }
      c.busy = true; c.msg = { kind: 'info', text: 'Saving…' }; render();
      var g = gen;
      return dispatch('providerUpdateServicePricing', { serviceId: id, pricing: pricingPayload(c.draft) }).then(function (r) {
        if (destroyed || g !== gen) return;
        c.busy = false;
        if (!r || r.success !== true || !isObj(r.pricing)) { c.msg = { kind: 'err', text: 'SOKONI did not confirm the save. Nothing is shown as saved.' }; render(); return; }
        /* Adopt the SERVER's sanitised object as both baseline and draft. */
        c.saved = clone(r.pricing); c.draft = clone(r.pricing); c.errors = {};
        c.svc.pricing = clone(r.pricing);
        c.msg = { kind: 'ok', text: 'Pricing saved. ' + NOTE_NEW_ONLY };
        toast('Pricing saved'); render();
      }).catch(function (e) {
        if (destroyed || g !== gen) return;
        c.busy = false; c.msg = { kind: 'err', text: errText(e) }; render();
      });
    }
    function saveBasic (id) {
      var c = st.cards[id]; if (!c || c.busy) return Promise.resolve();
      if (refuseIfReadOnly(c)) return Promise.resolve();
      if (Object.keys(c.berrors).some(function (k) { return c.berrors[k]; })) {
        c.msg = { kind: 'err', text: 'Not saved. Fix the highlighted fields.' }; render(); return Promise.resolve();
      }
      var ch = basicChanges(c.svc, c.basic);
      if (!Object.keys(ch).length) { c.msg = { kind: 'info', text: 'Nothing to save — no details changed.' }; render(); return Promise.resolve(); }
      c.busy = true; c.msg = { kind: 'info', text: 'Saving…' }; render();
      var g = gen;
      return dispatch('providerUpdateService', Object.assign({ serviceId: id }, ch)).then(function (r) {
        if (destroyed || g !== gen) return;
        c.busy = false;
        if (!r || r.success !== true) { c.msg = { kind: 'err', text: 'SOKONI did not confirm the save. Nothing is shown as saved.' }; render(); return; }
        Object.keys(ch).forEach(function (k) { c.svc[k] = ch[k]; });
        c.msg = { kind: 'ok', text: 'Details saved. ' + NOTE_NEW_ONLY }; toast('Service details saved'); render();
      }).catch(function (e) {
        if (destroyed || g !== gen) return;
        c.busy = false; c.msg = { kind: 'err', text: errText(e) }; render();
      });
    }
    function toggle (id) {
      var c = st.cards[id]; if (!c || c.busy) return Promise.resolve();
      if (refuseIfReadOnly(c)) return Promise.resolve();
      var want = !(c.svc.active !== false);
      c.busy = true; render();
      var g = gen;
      return dispatch('providerToggleService', { serviceId: id, active: want }).then(function (r) {
        if (destroyed || g !== gen) return;
        c.busy = false;
        if (!r || r.success !== true || typeof r.active !== 'boolean') { c.msg = { kind: 'err', text: 'SOKONI did not confirm the change.' }; render(); return; }
        c.svc.active = r.active;
        c.msg = { kind: 'ok', text: r.active ? 'Service is live for new bookings.' : 'Service paused — it takes no new bookings.' };
        render();
      }).catch(function (e) {
        if (destroyed || g !== gen) return;
        c.busy = false; c.msg = { kind: 'err', text: errText(e) }; render();
      });
    }
    function addService () {
      var a = st.add; if (!a || a.busy) return Promise.resolve();
      if (!canEdit(ctx)) { a.msg = { kind: 'err', text: readOnlyReason(ctx) }; render(); return Promise.resolve(); }
      var bad = Object.keys(a.errors).filter(function (k) { return a.errors[k]; });
      if (bad.length || !a.v.name.trim()) { a.msg = { kind: 'err', text: 'Not added. ' + (a.v.name.trim() ? 'Fix the highlighted fields.' : 'A service needs a name.') }; render(); return Promise.resolve(); }
      var cats = ctx.filter && Array.isArray(ctx.filter.categories) ? ctx.filter.categories : null;
      var category = cats ? (cats.indexOf(a.v.category) > -1 ? a.v.category : (cats.length === 1 ? cats[0] : '')) : a.v.category;
      if (cats && !category) { a.msg = { kind: 'err', text: 'Not added. Choose a category.' }; render(); return Promise.resolve(); }
      a.busy = true; a.msg = { kind: 'info', text: 'Adding…' }; render();
      var g = gen;
      return dispatch('providerAddService', { name: a.v.name.trim(), description: a.v.description, category: category,
                                              price: a.v.price, durationMins: a.v.durationMins }).then(function (r) {
        if (destroyed || g !== gen) return;
        a.busy = false;
        if (!r || r.success !== true || !r.serviceId) { a.msg = { kind: 'err', text: 'SOKONI did not confirm the new service.' }; render(); return; }
        st.add = null; st.open = r.serviceId; st.tab = 'pricing'; toast('Service added');
        return load();
      }).catch(function (e) {
        if (destroyed || g !== gen) return;
        a.busy = false; a.msg = { kind: 'err', text: errText(e) }; render();
      });
    }
    /* Preview — a READ through the checkout engine. Allowed when read-only. */
    function preview (id) {
      var c = st.cards[id]; if (!c || c.pv.busy) return Promise.resolve();
      var pv = c.pv, sel = {}, cx = {};
      if (pv.packageId) sel.packageId = pv.packageId;
      if (pv.addOns.length) sel.addOns = pv.addOns.map(function (x) { return { id: x, qty: 1 }; });
      var dm = parseInt0(pv.durationMins, 100000); if (dm.ok && dm.v) sel.durationMins = dm.v;
      if (DATE_RE.test(pv.date)) cx.date = pv.date;
      if (TIME_RE.test(pv.startTime)) cx.startTime = pv.startTime;
      var km = parseNum(pv.distanceKm, 100000); if (km.ok && km.v) cx.distanceKm = km.v;
      pv.busy = true; pv.error = null; render();
      var g = gen;
      return dispatch('bookingPreviewPrice', { pricing: pricingPayload(c.draft), selection: sel, ctx: cx }).then(function (r) {
        if (destroyed || g !== gen) return;
        pv.busy = false;
        if (!r || typeof r.totalCents !== 'number') { pv.result = null; pv.error = 'SOKONI returned no price for this selection.'; render(); return; }
        pv.result = r; render();
      }).catch(function (e) {
        if (destroyed || g !== gen) return;
        pv.busy = false; pv.result = null; pv.error = errText(e); render();
      });
    }

    /* ── render ── */
    function fid (path) { return 'mrc-' + String(path).replace(/[^A-Za-z0-9_-]/g, '_'); }
    var RAW = {};   /* field id -> the raw text of a REJECTED entry (display only, never sent) */
    function keepRaw (scope, card, path, raw, err) {
      var id = fid(scope + '-' + (card || 'new') + '-' + path);
      if (err) RAW[id] = String(raw == null ? '' : raw); else delete RAW[id];
    }
    function field (opts) {
      /* opts: {scope:'p'|'b'|'pv'|'a', card, path, label, value, type, err, edit, inputmode, extra, options, rows} */
      var id = fid(opts.scope + '-' + (opts.card || 'new') + '-' + opts.path);
      /* A rejected entry stays on screen beside its error (the model keeps the last valid value). */
      if (opts.err && Object.prototype.hasOwnProperty.call(RAW, id)) opts.value = RAW[id];
      var off = opts.edit === false ? '' : dis;
      var attrs = ' id="' + id + '" data-s="' + esc(opts.scope) + '" data-card="' + esc(opts.card || '') + '" data-f="' + esc(opts.path) + '"' +
        (opts.err ? ' aria-invalid="true" aria-describedby="' + id + '-e"' : '') + off;
      var ctl;
      if (opts.options) {
        ctl = '<select' + attrs + '>' + opts.options.map(function (o) {
          return '<option value="' + esc(o[0]) + '"' + (String(opts.value) === String(o[0]) ? ' selected' : '') + '>' + esc(o[1]) + '</option>';
        }).join('') + '</select>';
      } else if (opts.rows) {
        ctl = '<textarea rows="' + opts.rows + '"' + attrs + (opts.max ? ' maxlength="' + opts.max + '"' : '') + '>' + esc(opts.value) + '</textarea>';
      } else {
        ctl = '<input type="' + (opts.type || 'text') + '"' + attrs + ' value="' + esc(opts.value) + '"' +
          (opts.inputmode ? ' inputmode="' + opts.inputmode + '"' : '') + (opts.max ? ' maxlength="' + opts.max + '"' : '') + ' autocomplete="off">';
      }
      return '<label class="mrc-f" for="' + id + '"><span>' + esc(opts.label) + '</span>' + ctl +
        '<span class="mrc-err" id="' + id + '-e"' + (opts.err ? ' role="alert"' : '') + '>' + esc(opts.err || '') + '</span></label>';
    }
    function money (scope, card, path, label, cents, err, edit) {
      return field({ scope: scope, card: card, path: path, label: label + ' (KES)', value: centsToKesInput(cents), err: err, inputmode: 'decimal', edit: edit });
    }
    function msgHtml (m) {
      if (!m) return '<div class="mrc-msg" role="status" aria-live="polite"></div>';
      return '<div class="mrc-msg ' + esc(m.kind) + '" role="' + (m.kind === 'err' ? 'alert' : 'status') + '" aria-live="polite">' + esc(m.text) + '</div>';
    }
    function depositBlock (c, base, dep, label) {
      var p = base ? base + '.deposit' : 'deposit', e = c.errors, mode = isObj(dep) ? dep.mode : 'none';
      var h = '<div class="mrc-grid">' + field({ scope: 'p', card: c.svc.id, path: p + '.mode', label: label, value: mode,
        options: [['none', 'No deposit'], ['fixed', 'Fixed amount'], ['pct', 'Percentage of the price'], ['full', 'Full price upfront']] });
      if (mode === 'fixed') h += money('p', c.svc.id, p + '.value', 'Deposit', dep.value, e[p + '.value']);
      if (mode === 'pct') h += field({ scope: 'p', card: c.svc.id, path: p + '.value', label: 'Deposit (%)', value: dep.value || 0, err: e[p + '.value'], inputmode: 'decimal' });
      if (mode !== 'none') h += field({ scope: 'p', card: c.svc.id, path: p + '.balanceDue', label: 'Balance due', value: dep.balanceDue || 'completion',
        options: [['completion', 'On completion'], ['before', 'Before the booking']] });
      return h + '</div>';
    }
    function pricingTab (c) {
      var d = c.draft, e = c.errors, id = c.svc.id, h = '';
      h += '<div class="mrc-grid">' +
        money('p', id, 'basePrice', 'Base price', d.basePrice, e.basePrice) +
        field({ scope: 'p', card: id, path: 'durationMins', label: 'Base duration (minutes)', value: d.durationMins || 0, err: e.durationMins, inputmode: 'numeric' }) +
        money('p', id, 'extraHourRate', 'Each extra hour', d.extraHourRate, e.extraHourRate) + '</div>';
      h += '<div class="mrc-sub"><h4>Surcharges and discounts</h4>';
      RATES.forEach(function (r) {
        var x = d[r.key], type = isObj(x) ? x.type : 'off';
        h += '<div class="mrc-grid">' + field({ scope: 'p', card: id, path: r.key + '.type', label: r.label, value: type,
          options: [['off', 'Off'], ['pct', 'Percentage of the base'], ['flat', 'Fixed amount']] });
        if (type === 'flat') h += money('p', id, r.key + '.value', 'Amount', x.value, e[r.key + '.value']);
        if (type === 'pct') h += field({ scope: 'p', card: id, path: r.key + '.value', label: 'Percent (%)', value: x.value || 0, err: e[r.key + '.value'], inputmode: 'decimal' });
        if (type !== 'off' && r.hours) {
          var hr = Array.isArray(x.hours) ? x.hours : ['', ''];
          h += field({ scope: 'p', card: id, path: r.key + '.hours.0', label: 'From (HH:MM)', value: hr[0] || '', err: e[r.key + '.hours.0'], type: 'time' }) +
               field({ scope: 'p', card: id, path: r.key + '.hours.1', label: 'Until (HH:MM)', value: hr[1] || '', err: e[r.key + '.hours.1'], type: 'time' });
        }
        h += '</div>';
      });
      h += field({ scope: 'p', card: id, path: 'holidays', label: 'Public holidays (one date per line, e.g. 2026-12-25)', value: (d.holidays || []).join('\n'), err: e.holidays, rows: 3 });
      h += '</div>';
      h += '<div class="mrc-sub"><h4>Deposit</h4>' + depositBlock(c, '', d.deposit, 'Deposit') + '</div>';
      var tv = isObj(d.travel) ? d.travel : {};
      h += '<div class="mrc-sub"><h4>Travel</h4><div class="mrc-grid">' +
        money('p', id, 'travel.fee', 'Call-out fee', tv.fee, e['travel.fee']) +
        money('p', id, 'travel.perKm', 'Per km beyond the free radius', tv.perKm, e['travel.perKm']) +
        field({ scope: 'p', card: id, path: 'travel.freeRadiusKm', label: 'Free radius (km)', value: tv.freeRadiusKm || 0, err: e['travel.freeRadiusKm'], inputmode: 'decimal' }) +
        field({ scope: 'p', card: id, path: 'travel.maxKm', label: 'Maximum distance (km, 0 = none)', value: tv.maxKm || 0, err: e['travel.maxKm'], inputmode: 'decimal' }) +
        '</div></div>';
      var ad = Array.isArray(d.addOns) ? d.addOns : [];
      var pk = Array.isArray(d.packages) ? d.packages : [];
      h += '<div class="mrc-sub"><h4>Packages (' + pk.length + '/' + CAP.packages + ')</h4>';
      pk.forEach(function (p, i) {
        var b = 'packages.' + i;
        h += '<div class="mrc-sub" aria-label="Package ' + (i + 1) + '"><div class="mrc-grid">' +
          field({ scope: 'p', card: id, path: b + '.name', label: 'Package name', value: p.name || '', err: e[b + '.name'], max: CAP.pkgName }) +
          money('p', id, b + '.price', 'Price', p.price, e[b + '.price']) +
          field({ scope: 'p', card: id, path: b + '.durationMins', label: 'Duration (minutes)', value: p.durationMins || 0, err: e[b + '.durationMins'], inputmode: 'numeric' }) +
          '</div>' +
          field({ scope: 'p', card: id, path: b + '.description', label: 'Description', value: p.description || '', err: e[b + '.description'], rows: 2, max: CAP.pkgDesc }) +
          field({ scope: 'p', card: id, path: b + '.includes', label: 'What is included (one per line)', value: (p.includes || []).join('\n'), err: e[b + '.includes'], rows: 2 });
        if (ad.length) {
          h += '<fieldset class="mrc-f"><legend>Add-ons offered with this package</legend>';
          ad.forEach(function (a) {
            var on = (p.extras || []).indexOf(a.id) > -1;
            h += '<label class="mrc-f mrc-chk"><input type="checkbox" data-s="p" data-card="' + esc(id) + '" data-f="' + esc(b + '.extras') + '" data-v="' + esc(a.id) + '"' + (on ? ' checked' : '') + dis + '> ' + esc(a.name || a.id) + '</label>';
          });
          h += '</fieldset>';
        }
        h += depositBlock(c, b, p.deposit, 'Package deposit (overrides the service deposit)') +
          '<div class="mrc-acts"><button type="button" class="mrc-btn" data-act="rm-pkg" data-card="' + esc(id) + '" data-i="' + i + '"' + dis + '>Remove package</button></div></div>';
      });
      h += '<div class="mrc-acts"><button type="button" class="mrc-btn" data-act="add-pkg" data-card="' + esc(id) + '"' + (pk.length >= CAP.packages ? ' disabled' : dis) + '>+ Add package</button></div></div>';
      h += '<div class="mrc-sub"><h4>Add-ons (' + ad.length + '/' + CAP.addOns + ')</h4>';
      ad.forEach(function (a, i) {
        var b = 'addOns.' + i;
        h += '<div class="mrc-sub" aria-label="Add-on ' + (i + 1) + '"><div class="mrc-grid">' +
          field({ scope: 'p', card: id, path: b + '.name', label: 'Add-on name', value: a.name || '', err: e[b + '.name'], max: CAP.addName }) +
          money('p', id, b + '.price', 'Price', a.price, e[b + '.price']) +
          field({ scope: 'p', card: id, path: b + '.qtyMax', label: 'Most per booking (0 = no limit)', value: a.qtyMax || 0, err: e[b + '.qtyMax'], inputmode: 'numeric' }) +
          '</div>' +
          field({ scope: 'p', card: id, path: b + '.description', label: 'Description', value: a.description || '', err: e[b + '.description'], rows: 2, max: CAP.addDesc }) +
          '<label class="mrc-f mrc-chk"><input type="checkbox" data-s="p" data-card="' + esc(id) + '" data-f="' + esc(b + '.available') + '"' + (a.available !== false ? ' checked' : '') + dis + '> Available to book</label>' +
          '<div class="mrc-acts"><button type="button" class="mrc-btn" data-act="rm-addon" data-card="' + esc(id) + '" data-i="' + i + '"' + dis + '>Remove add-on</button></div></div>';
      });
      h += '<div class="mrc-acts"><button type="button" class="mrc-btn" data-act="add-addon" data-card="' + esc(id) + '"' + (ad.length >= CAP.addOns ? ' disabled' : dis) + '>+ Add add-on</button></div></div>';
      h += '<p class="mrc-note">' + esc(NOTE_NEW_ONLY) + ' Saving replaces this service\'s whole rate card with what you see here.</p>';
      h += '<div class="mrc-acts"><button type="button" class="mrc-btn pri" data-act="save-pricing" data-card="' + esc(id) + '"' + (c.busy ? ' disabled' : dis) + '>Save pricing</button>' +
           '<button type="button" class="mrc-btn" data-act="discard" data-card="' + esc(id) + '"' + (c.busy ? ' disabled' : dis) + '>Discard changes</button></div>';
      return h;
    }
    function basicTab (c) {
      var b = c.basic, e = c.berrors, id = c.svc.id;
      return '<div class="mrc-grid">' +
        field({ scope: 'b', card: id, path: 'name', label: 'Service name', value: b.name, err: e.name, max: CAP.svcName }) +
        field({ scope: 'b', card: id, path: 'durationMins', label: 'Duration (minutes)', value: b.durationMins, err: e.durationMins, inputmode: 'numeric' }) +
        money('b', id, 'price', 'Listed price', b.price, e.price) +
        money('b', id, 'fee', 'Booking fee', b.fee, e.fee) +
        money('b', id, 'deposit', 'Upfront deposit', b.deposit, e.deposit) + '</div>' +
        field({ scope: 'b', card: id, path: 'description', label: 'Description', value: b.description, err: e.description, rows: 3, max: CAP.svcDesc }) +
        '<p class="mrc-note">' + esc(NOTE_NEW_ONLY) + '</p>' +
        '<div class="mrc-acts"><button type="button" class="mrc-btn pri" data-act="save-basic" data-card="' + esc(id) + '"' + (c.busy ? ' disabled' : dis) + '>Save details</button></div>';
    }
    function previewTab (c) {
      var d = c.draft, pv = c.pv, id = c.svc.id, h = '';
      var pk = Array.isArray(d.packages) ? d.packages : [], ad = Array.isArray(d.addOns) ? d.addOns : [];
      h += '<p class="mrc-note">Prices come from SOKONI\'s pricing engine — the same one checkout uses. Unsaved changes are previewed as a draft.</p><div class="mrc-grid">';
      if (pk.length) h += field({ scope: 'pv', card: id, path: 'packageId', label: 'Package', value: pv.packageId, edit: false,
        options: [['', 'Standard price']].concat(pk.filter(function (p) { return p && p.id; }).map(function (p) { return [p.id, p.name || p.id]; })) });
      h += field({ scope: 'pv', card: id, path: 'durationMins', label: 'Duration (minutes, blank = standard)', value: pv.durationMins, inputmode: 'numeric', edit: false }) +
        field({ scope: 'pv', card: id, path: 'date', label: 'Date', value: pv.date, type: 'date', edit: false }) +
        field({ scope: 'pv', card: id, path: 'startTime', label: 'Start time', value: pv.startTime, type: 'time', edit: false }) +
        field({ scope: 'pv', card: id, path: 'distanceKm', label: 'Distance (km)', value: pv.distanceKm, inputmode: 'decimal', edit: false }) + '</div>';
      if (ad.length) {
        h += '<fieldset class="mrc-f"><legend>Add-ons</legend>';
        ad.forEach(function (a) {
          if (!a || !a.id) return;
          h += '<label class="mrc-f mrc-chk"><input type="checkbox" data-s="pv" data-card="' + esc(id) + '" data-f="addOns" data-v="' + esc(a.id) + '"' + (pv.addOns.indexOf(a.id) > -1 ? ' checked' : '') + '> ' + esc(a.name || a.id) + '</label>';
        });
        h += '</fieldset>';
      }
      h += '<div class="mrc-acts"><button type="button" class="mrc-btn pri" data-act="preview" data-card="' + esc(id) + '"' + (pv.busy ? ' disabled' : '') + '>' + (pv.busy ? 'Calculating…' : 'Preview price') + '</button></div>';
      if (pv.error) h += '<div class="mrc-msg err" role="alert">' + esc(pv.error) + '</div>';
      if (pv.result) {
        var r = pv.result;
        h += '<div class="mrc-pv" role="status" aria-live="polite"><table><tbody>' +
          (Array.isArray(r.breakdown) ? r.breakdown : []).map(function (x) {
            return '<tr><td>' + esc(x && x.label) + '</td><td>' + esc(fmtKes(x && x.amount)) + '</td></tr>';
          }).join('') +
          '<tr><td><b>Total</b></td><td><b>' + esc(fmtKes(r.totalCents)) + '</b></td></tr>' +
          (r.depositMode && r.depositMode !== 'none'
            ? '<tr><td>Due upfront (deposit)</td><td>' + esc(fmtKes(r.depositCents)) + '</td></tr>' +
              '<tr><td>Balance due</td><td>' + esc(r.balanceDue === 'before' ? 'Before the booking' : 'On completion') + '</td></tr>'
            : '') +
          '</tbody></table></div>';
      }
      return h;
    }
    function addForm () {
      var a = st.add, e = a.errors, cats = ctx.filter && Array.isArray(ctx.filter.categories) ? ctx.filter.categories : null;
      var h = '<section class="mrc-row" aria-label="Add a service"><div class="mrc-body"><h3>Add a service</h3><div class="mrc-grid">' +
        field({ scope: 'a', card: '', path: 'name', label: 'Service name', value: a.v.name, err: e.name, max: CAP.svcName }) +
        money('a', '', 'price', 'Listed price', a.v.price, e.price) +
        field({ scope: 'a', card: '', path: 'durationMins', label: 'Duration (minutes)', value: a.v.durationMins, err: e.durationMins, inputmode: 'numeric' });
      if (cats && cats.length > 1) h += field({ scope: 'a', card: '', path: 'category', label: 'Category', value: a.v.category, options: [['', 'Choose…']].concat(cats.map(function (x) { return [x, x]; })) });
      else if (!cats) h += field({ scope: 'a', card: '', path: 'category', label: 'Category', value: a.v.category, max: 120 });
      h += '</div>' + field({ scope: 'a', card: '', path: 'description', label: 'Description', value: a.v.description, err: e.description, rows: 2, max: CAP.svcDesc }) +
        msgHtml(a.msg) +
        '<div class="mrc-acts"><button type="button" class="mrc-btn pri" data-act="add-save"' + (a.busy ? ' disabled' : dis) + '>Add service</button>' +
        '<button type="button" class="mrc-btn" data-act="add-cancel">Cancel</button></div></div></section>';
      return h;
    }
    function render () {
      if (destroyed) return;
      var active = null;
      try { active = (typeof document !== 'undefined' && document.activeElement && document.activeElement.id) || null; } catch (_) {}
      var h = '<div class="mrc" data-editable="' + (EDIT ? 'true' : 'false') + '">';
      h += '<div class="mrc-hd"><h2>Rates</h2>' + (EDIT && st.status === 'ready' && !st.add ? '<button type="button" class="mrc-btn" data-act="add-open">+ Add service</button>' : '') + '</div>';
      if (!EDIT) h += '<div class="mrc-ro" role="note"><b>Read-only.</b> ' + esc(readOnlyReason(ctx)) + '</div>';
      if (st.status === 'signedout') h += '<div class="mrc-state">Sign in to manage your rates.</div>';
      else if (st.status === 'loading') h += '<div class="mrc-state" role="status">Loading your services…</div>';
      else if (st.status === 'error') h += '<div class="mrc-state" role="alert">Your services could not be loaded: ' + esc(st.error) + '<br><button type="button" class="mrc-btn" data-act="retry">Try again</button></div>';
      else {
        if (st.add) h += addForm();
        if (!st.services.length) h += '<div class="mrc-state">' + (ctx.filter && (ctx.filter.categories || ctx.filter.serviceKind) ? 'No services in this category yet.' : 'You have no services yet.') + '</div>';
        h += '<ul class="mrc-list">';
        st.services.forEach(function (s) {
          var c = st.cards[s.id], open = st.open === s.id, on = s.active !== false;
          h += '<li class="mrc-row"><div class="mrc-rowhd"><div class="nm"><b>' + esc(s.name || 'Untitled service') + '</b><small>' +
            esc([s.category, s.subcategory].filter(Boolean).join(' · ')) + (isObj(s.pricing) ? '' : ' · no advanced pricing yet') + '</small></div>' +
            '<span class="mrc-chip' + (on ? ' on' : '') + '">' + (on ? 'Live' : 'Paused') + '</span>' +
            '<button type="button" class="mrc-btn" data-act="toggle" data-card="' + esc(s.id) + '"' + (c.busy ? ' disabled' : dis) + '>' + (on ? 'Pause' : 'Resume') + '</button>' +
            '<button type="button" class="mrc-btn" data-act="open" data-card="' + esc(s.id) + '" aria-expanded="' + open + '">' + (open ? 'Close' : (EDIT ? 'Edit' : 'View')) + '</button></div>';
          if (open) {
            h += '<div class="mrc-body"><div class="mrc-tabs" role="tablist">' +
              [['basic', 'Details'], ['pricing', 'Advanced pricing'], ['preview', 'Preview price']].map(function (t) {
                return '<button type="button" role="tab" class="mrc-btn" data-act="tab" data-tab="' + t[0] + '" aria-selected="' + (st.tab === t[0]) + '">' + t[1] + '</button>';
              }).join('') + '</div>' + msgHtml(c.msg) +
              (st.tab === 'pricing' ? pricingTab(c) : st.tab === 'preview' ? previewTab(c) : basicTab(c)) + '</div>';
          } else if (c.msg) h += '<div class="mrc-body">' + msgHtml(c.msg) + '</div>';
          h += '</li>';
        });
        h += '</ul>';
      }
      el.innerHTML = h + '</div>';
      if (active && typeof document !== 'undefined' && document.getElementById) {
        try { var f = document.getElementById(active); if (f && f.focus) f.focus(); } catch (_) {}
      }
    }

    /* ── events (delegated) ── */
    function attr (t, k) { return t && t.getAttribute ? t.getAttribute(k) : null; }
    function onChange (ev) {
      var t = ev && ev.target; if (!t) return;
      var scope = attr(t, 'data-s'), path = attr(t, 'data-f'); if (!scope || !path) return;
      var raw = t.value, checked = t.checked === true, val = attr(t, 'data-v');
      if (scope === 'pv') {
        var pc = st.cards[attr(t, 'data-card')]; if (!pc) return;
        if (path === 'addOns') {
          var i = pc.pv.addOns.indexOf(val);
          if (checked && i < 0) pc.pv.addOns.push(val); if (!checked && i > -1) pc.pv.addOns.splice(i, 1);
        } else if (['packageId', 'durationMins', 'date', 'startTime', 'distanceKm'].indexOf(path) > -1) pc.pv[path] = String(raw || '');
        return;
      }
      if (!canEdit(ctx)) return;   /* read-only: no edit ever reaches the model */
      if (scope === 'a') {
        if (!st.add) return;
        var ae = path === 'category' ? null : applyBasic(st.add.v, path, raw);
        if (path === 'category') st.add.v.category = String(raw || '').slice(0, 120);
        st.add.errors[path] = ae; keepRaw('a', '', path, raw, ae); render(); return;
      }
      var cid = attr(t, 'data-card'), c = st.cards[cid]; if (!c) return;
      var err = null;
      if (scope === 'b') { err = c.berrors[path] = applyBasic(c.basic, path, raw); }
      else if (scope === 'p') { err = c.errors[path] = applyPricing(c.draft, path, raw, checked, val); }
      else return;
      keepRaw(scope, cid, path, raw, err); c.msg = null; render();
    }
    function onClick (ev) {
      var t = ev && ev.target;
      if (t && t.closest) t = t.closest('[data-act]');
      var act = attr(t, 'data-act'); if (!act) return;
      if (t.disabled) return;
      var id = attr(t, 'data-card'), c = id ? st.cards[id] : null;
      if (act === 'retry') return load();
      if (act === 'open') { st.open = st.open === id ? null : id; st.tab = 'basic'; render(); return; }
      if (act === 'tab') { st.tab = attr(t, 'data-tab') || 'basic'; render(); return; }
      if (act === 'preview') return preview(id);
      if (act === 'save-pricing') return savePricing(id);
      if (act === 'save-basic') return saveBasic(id);
      if (act === 'toggle') return toggle(id);
      if (act === 'add-cancel') { st.add = null; render(); return; }
      if (!canEdit(ctx)) return;
      if (act === 'add-open') { st.add = { v: { name: '', description: '', price: 0, durationMins: 0, category: '' }, errors: {}, msg: null, busy: false }; render(); return; }
      if (act === 'add-save') return addService();
      if (!c) return;
      var d = c.draft, i = Number(attr(t, 'data-i'));
      if (act === 'discard') { RAW = {}; c.draft = clone(c.saved); c.errors = {}; c.basic = basicOf(c.svc); c.berrors = {}; c.msg = null; render(); return; }
      if (act === 'add-pkg') { d.packages = Array.isArray(d.packages) ? d.packages : []; if (d.packages.length < CAP.packages) d.packages.push({ id: newId('pkg_'), name: '', price: 0, durationMins: 0, description: '' }); render(); return; }
      if (act === 'add-addon') { d.addOns = Array.isArray(d.addOns) ? d.addOns : []; if (d.addOns.length < CAP.addOns) d.addOns.push({ id: newId('addon_'), name: '', price: 0, qtyMax: 0, available: true, description: '' }); render(); return; }
      if (act === 'rm-pkg' && Array.isArray(d.packages)) { d.packages.splice(i, 1); c.errors = reindexErrors(c.errors, 'packages', i); render(); return; }
      if (act === 'rm-addon' && Array.isArray(d.addOns)) {
        var gone = d.addOns[i] && d.addOns[i].id;
        d.addOns.splice(i, 1);
        (d.packages || []).forEach(function (p) { if (Array.isArray(p.extras)) p.extras = p.extras.filter(function (x) { return x !== gone; }); });
        c.errors = reindexErrors(c.errors, 'addOns', i); render();
      }
    }
    /* After removing row i, drop its errors and shift later rows' errors down by one. */
    function reindexErrors (errs, list, i) {
      var out = {};
      Object.keys(errs).forEach(function (k) {
        var m = new RegExp('^' + list + '\\.(\\d+)\\.(.*)$').exec(k);
        if (!m) { out[k] = errs[k]; return; }
        var n = Number(m[1]); if (n === i) return;
        out[list + '.' + (n > i ? n - 1 : n) + '.' + m[2]] = errs[k];
      });
      return out;
    }

    if (el.addEventListener) { el.addEventListener('change', onChange); el.addEventListener('click', onClick); }
    load();

    return {
      refresh: function () { return load(); },
      destroy: function () {
        destroyed = true; gen++;
        if (el.removeEventListener) { el.removeEventListener('change', onChange); el.removeEventListener('click', onClick); }
        el.innerHTML = '';
      },
      /* Test/automation seam — the same functions the controls call. */
      _state: st, _savePricing: savePricing, _saveBasic: saveBasic, _toggle: toggle, _preview: preview,
      _addService: addService, _onChange: onChange, _onClick: onClick
    };
  }

  return {
    mount: mount,
    NOTE_NEW_ONLY: NOTE_NEW_ONLY,
    _core: { esc: esc, kesToCents: kesToCents, centsToKesInput: centsToKesInput, fmtKes: fmtKes,
             canEdit: canEdit, filterServices: filterServices, pricingPayload: pricingPayload,
             draftProblems: draftProblems, applyPricing: applyPricing, applyBasic: applyBasic,
             basicChanges: basicChanges, kindOf: kindOf }
  };
}));
