/* ============================================================================
   SOKONI — Pricing Studio (Slice C)   sokoni-pricing-studio.js
   The provider's pricing workspace: General / Dynamic / Travel / Duration / Packages /
   Add-ons, with a LIVE preview that calls the SAME server engine (bookingPreviewPrice)
   so what the provider sees is exactly what the customer will be charged.

   Usage: SokoniPricingStudio.open(serviceId, pricing, onSaved)
   Money is shown in KES and converted to cents (×100) before sending. ========================================================================== */
(function () {
  'use strict';
  function _call(payload) {
    if (typeof window.sokoniCallable === 'function') return window.sokoniCallable('providerDispatch')(payload).then(function (r) { return (r && r.data) || r; });
    if (window.firebase && window.firebase.functions) return window.firebase.functions().httpsCallable('providerDispatch')(payload).then(function (r) { return r.data; });
    return Promise.reject(new Error('No callable bridge.'));
  }
  var K2C = function (v) { return Math.max(0, Math.round((parseFloat(v) || 0) * 100)); };
  var C2K = function (v) { return (Number(v) || 0) / 100; };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); };
  function _toast(m, ok) { if (window.toast) window.toast(m, ok ? 'ok' : 'err'); else if (window.showToast) window.showToast(m, !ok); }

  var IN = 'width:100%;padding:9px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.14);border-radius:9px;color:#fff;font-size:14px;font-family:inherit;box-sizing:border-box;';
  var LB = 'font-size:11px;font-weight:700;color:rgba(255,255,255,.55);display:block;margin:8px 0 4px;';
  var H = 'font-size:13px;font-weight:800;color:#71ff00;margin:16px 0 6px;text-transform:uppercase;letter-spacing:.05em;';
  var BTN = 'padding:8px 12px;border-radius:9px;font-size:12px;font-weight:800;cursor:pointer;font-family:inherit;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.05);color:#fff;';

  function rateRow(key, label, r) {
    r = r || {}; var hasHours = key === 'peakRate' || key === 'offPeakDiscount';
    return '<div style="display:flex;gap:6px;align-items:end;flex-wrap:wrap;margin-bottom:6px;" data-rate="' + key + '">' +
      '<div style="flex:1;min-width:120px;"><label style="' + LB + '">' + esc(label) + '</label>' +
        '<select data-f="type" style="' + IN + '"><option value="">Off</option>' +
          '<option value="pct"' + (r.type === 'pct' ? ' selected' : '') + '>% percent</option>' +
          '<option value="flat"' + (r.type === 'flat' ? ' selected' : '') + '>KES flat</option></select></div>' +
      '<div style="width:90px;"><label style="' + LB + '">Value</label><input data-f="value" type="number" min="0" value="' + (r.type === 'flat' ? C2K(r.value) : (r.value || '')) + '" style="' + IN + '"></div>' +
      (hasHours ? '<div style="width:80px;"><label style="' + LB + '">From</label><input data-f="h0" type="time" value="' + esc((r.hours && r.hours[0]) || '') + '" style="' + IN + '"></div>' +
                  '<div style="width:80px;"><label style="' + LB + '">To</label><input data-f="h1" type="time" value="' + esc((r.hours && r.hours[1]) || '') + '" style="' + IN + '"></div>' : '') +
    '</div>';
  }
  function readRate(scope, key) {
    var el = scope.querySelector('[data-rate="' + key + '"]'); if (!el) return undefined;
    var type = el.querySelector('[data-f=type]').value; if (!type) return undefined;
    var val = parseFloat(el.querySelector('[data-f=value]').value) || 0; if (val <= 0) return undefined;
    var o = { type: type, value: type === 'flat' ? K2C(val) : val };
    var h0 = el.querySelector('[data-f=h0]'), h1 = el.querySelector('[data-f=h1]');
    if (h0 && h1 && h0.value && h1.value) o.hours = [h0.value, h1.value];
    return o;
  }
  function pkgRow(p) {
    p = p || {};
    return '<div class="_pkg" style="border:1px solid rgba(255,255,255,.1);border-radius:10px;padding:10px;margin-bottom:8px;">' +
      '<div style="display:flex;gap:6px;"><input data-f="name" placeholder="Package name" value="' + esc(p.name || '') + '" style="' + IN + '">' +
      '<button type="button" class="_del" style="' + BTN + 'color:#ff8098;">✕</button></div>' +
      '<div style="display:flex;gap:6px;margin-top:6px;"><input data-f="price" type="number" min="0" placeholder="Price KES" value="' + (p.price ? C2K(p.price) : '') + '" style="' + IN + '">' +
      '<input data-f="dur" type="number" min="0" placeholder="Duration min" value="' + (p.durationMins || '') + '" style="' + IN + '">' +
      '<input data-f="dep" type="number" min="0" placeholder="Deposit KES" value="' + (p.deposit && p.deposit.mode === 'fixed' ? C2K(p.deposit.value) : '') + '" style="' + IN + '"></div>' +
      '<input data-f="desc" placeholder="Description" value="' + esc(p.description || '') + '" style="' + IN + 'margin-top:6px;">' +
      '<span data-id="' + esc(p.id || '') + '" style="display:none"></span></div>';
  }
  function addonRow(a) {
    a = a || {};
    return '<div class="_addon" style="border:1px solid rgba(255,255,255,.1);border-radius:10px;padding:10px;margin-bottom:8px;">' +
      '<div style="display:flex;gap:6px;"><input data-f="name" placeholder="Add-on name" value="' + esc(a.name || '') + '" style="' + IN + '">' +
      '<input data-f="price" type="number" min="0" placeholder="Price KES" value="' + (a.price ? C2K(a.price) : '') + '" style="' + IN + 'max-width:110px;">' +
      '<button type="button" class="_del" style="' + BTN + 'color:#ff8098;">✕</button></div>' +
      '<div style="display:flex;gap:6px;margin-top:6px;align-items:center;"><input data-f="qtyMax" type="number" min="0" placeholder="Max qty" value="' + (a.qtyMax || '') + '" style="' + IN + 'max-width:110px;">' +
      '<label style="font-size:12px;color:rgba(255,255,255,.7);display:flex;gap:5px;align-items:center;"><input data-f="avail" type="checkbox"' + (a.available !== false ? ' checked' : '') + '> Available</label></div>' +
      '<span data-id="' + esc(a.id || '') + '" style="display:none"></span></div>';
  }

  function collect(scope) {
    var g = function (id) { var e = scope.querySelector('#ps_' + id); return e ? e.value : ''; };
    var pricing = {
      currency: g('cur') || 'KES', basePrice: K2C(g('base')), durationMins: parseInt(g('dur')) || 0, extraHourRate: K2C(g('extra')),
      travel: { fee: K2C(g('tfee')), perKm: K2C(g('tperkm')), freeRadiusKm: parseFloat(g('tfree')) || 0 },
      holidays: (g('hols') || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean),
      packages: [], addOns: [],
    };
    var depMode = g('depmode');
    if (depMode) pricing.deposit = { mode: depMode, balanceDue: g('baldue') || 'completion' };
    if (depMode === 'fixed') pricing.deposit.value = K2C(g('depval'));
    else if (depMode === 'pct') pricing.deposit.value = parseFloat(g('depval')) || 0;
    ['weekendRate', 'holidayRate', 'peakRate', 'offPeakDiscount'].forEach(function (k) { var r = readRate(scope, k); if (r) pricing[k] = r; });
    scope.querySelectorAll('._pkg').forEach(function (el, i) {
      var name = el.querySelector('[data-f=name]').value.trim(); if (!name) return;
      /* fallback id matches the server sanitiser's index-based id so draft previews resolve the package */
      var o = { id: el.querySelector('[data-id]').getAttribute('data-id') || ('pkg_' + i), name: name,
        price: K2C(el.querySelector('[data-f=price]').value), durationMins: parseInt(el.querySelector('[data-f=dur]').value) || 0,
        description: el.querySelector('[data-f=desc]').value };
      var dep = el.querySelector('[data-f=dep]').value; if (dep) o.deposit = { mode: 'fixed', value: K2C(dep) };
      pricing.packages.push(o);
    });
    scope.querySelectorAll('._addon').forEach(function (el, i) {
      var name = el.querySelector('[data-f=name]').value.trim(); if (!name) return;
      pricing.addOns.push({ id: el.querySelector('[data-id]').getAttribute('data-id') || ('addon_' + i), name: name,
        price: K2C(el.querySelector('[data-f=price]').value), qtyMax: parseInt(el.querySelector('[data-f=qtyMax]').value) || 0,
        available: el.querySelector('[data-f=avail]').checked });
    });
    return pricing;
  }

  function open(serviceId, pricing, onSaved) {
    pricing = pricing || {};
    var back = document.createElement('div');
    back.style.cssText = 'position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.8);display:flex;align-items:flex-start;justify-content:center;padding:16px;overflow:auto;';
    var dep = pricing.deposit || {};
    back.innerHTML =
      '<div style="background:#0d0d0d;border:1px solid rgba(255,255,255,.12);border-radius:16px;max-width:560px;width:100%;padding:20px;color:#fff;font-family:inherit;margin:auto;">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;"><div style="font-size:17px;font-weight:800;">💰 Pricing Studio</div><button id="ps_x" style="' + BTN + '">Close</button></div>' +
        '<div style="' + H + '">General</div>' +
        '<div style="display:flex;gap:6px;"><div style="flex:1"><label style="' + LB + '">Base price (KES)</label><input id="ps_base" type="number" min="0" value="' + (pricing.basePrice ? C2K(pricing.basePrice) : '') + '" style="' + IN + '"></div>' +
        '<div style="width:90px"><label style="' + LB + '">Duration (min)</label><input id="ps_dur" type="number" min="0" value="' + (pricing.durationMins || '') + '" style="' + IN + '"></div>' +
        '<div style="width:70px"><label style="' + LB + '">Currency</label><input id="ps_cur" value="' + esc(pricing.currency || 'KES') + '" style="' + IN + '"></div></div>' +
        '<div style="display:flex;gap:6px;margin-top:6px;"><div style="flex:1"><label style="' + LB + '">Deposit type</label><select id="ps_depmode" style="' + IN + '"><option value="">None</option>' +
          '<option value="pct"' + (dep.mode === 'pct' ? ' selected' : '') + '>% of total</option><option value="fixed"' + (dep.mode === 'fixed' ? ' selected' : '') + '>Fixed KES</option><option value="full"' + (dep.mode === 'full' ? ' selected' : '') + '>Full payment</option></select></div>' +
        '<div style="width:110px"><label style="' + LB + '">Deposit value</label><input id="ps_depval" type="number" min="0" value="' + (dep.value != null ? (dep.mode === 'fixed' ? C2K(dep.value) : dep.value) : '') + '" style="' + IN + '"></div>' +
        '<div style="width:120px"><label style="' + LB + '">Balance due</label><select id="ps_baldue" style="' + IN + '"><option value="completion"' + (dep.balanceDue !== 'before' ? ' selected' : '') + '>On completion</option><option value="before"' + (dep.balanceDue === 'before' ? ' selected' : '') + '>Before service</option></select></div></div>' +
        '<div style="' + H + '">Dynamic pricing</div>' + rateRow('weekendRate', 'Weekend', pricing.weekendRate) + rateRow('holidayRate', 'Public holiday', pricing.holidayRate) + rateRow('peakRate', 'Peak hour', pricing.peakRate) + rateRow('offPeakDiscount', 'Off-peak discount', pricing.offPeakDiscount) +
        '<label style="' + LB + '">Public holidays (YYYY-MM-DD, comma-separated)</label><input id="ps_hols" value="' + esc((pricing.holidays || []).join(', ')) + '" style="' + IN + '">' +
        '<div style="' + H + '">Travel</div><div style="display:flex;gap:6px;"><div style="flex:1"><label style="' + LB + '">Free radius (km)</label><input id="ps_tfree" type="number" min="0" value="' + ((pricing.travel && pricing.travel.freeRadiusKm) || '') + '" style="' + IN + '"></div>' +
        '<div style="flex:1"><label style="' + LB + '">Travel fee (KES)</label><input id="ps_tfee" type="number" min="0" value="' + (pricing.travel && pricing.travel.fee ? C2K(pricing.travel.fee) : '') + '" style="' + IN + '"></div>' +
        '<div style="flex:1"><label style="' + LB + '">Per km (KES)</label><input id="ps_tperkm" type="number" min="0" value="' + (pricing.travel && pricing.travel.perKm ? C2K(pricing.travel.perKm) : '') + '" style="' + IN + '"></div></div>' +
        '<div style="' + H + '">Duration</div><label style="' + LB + '">Extra-hour rate (KES)</label><input id="ps_extra" type="number" min="0" value="' + (pricing.extraHourRate ? C2K(pricing.extraHourRate) : '') + '" style="' + IN + '">' +
        '<div style="' + H + '">Packages</div><div id="ps_pkgs">' + (pricing.packages || []).map(pkgRow).join('') + '</div><button id="ps_addpkg" style="' + BTN + '">+ Add package</button>' +
        '<div style="' + H + '">Add-ons</div><div id="ps_addons">' + (pricing.addOns || []).map(addonRow).join('') + '</div><button id="ps_addaddon" style="' + BTN + '">+ Add add-on</button>' +
        '<div style="' + H + '">Preview</div><div style="font-size:11px;color:rgba(255,255,255,.5);margin-bottom:6px;">Uses the same server engine customers are charged with.</div>' +
        '<div id="ps_preview" style="background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:10px;padding:12px;font-size:13px;min-height:24px;">Tap “Preview”.</div>' +
        '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px;"><button id="ps_preview_btn" style="' + BTN + '">Preview</button><button id="ps_save" style="padding:10px 18px;border-radius:10px;border:none;background:#71ff00;color:#04120a;font-weight:800;cursor:pointer;font-family:inherit;">Save pricing</button></div>' +
      '</div>';
    document.body.appendChild(back);
    var scope = back;
    var close = function () { back.remove(); };
    scope.querySelector('#ps_x').onclick = close;
    back.addEventListener('click', function (e) { if (e.target === back) close(); });
    scope.querySelector('#ps_addpkg').onclick = function () { var d = document.createElement('div'); d.innerHTML = pkgRow({}); scope.querySelector('#ps_pkgs').appendChild(d.firstChild); wireDels(); };
    scope.querySelector('#ps_addaddon').onclick = function () { var d = document.createElement('div'); d.innerHTML = addonRow({}); scope.querySelector('#ps_addons').appendChild(d.firstChild); wireDels(); };
    function wireDels() { scope.querySelectorAll('._del').forEach(function (b) { b.onclick = function () { b.closest('._pkg, ._addon').remove(); }; }); }
    wireDels();
    scope.querySelector('#ps_preview_btn').onclick = function () {
      var pv = scope.querySelector('#ps_preview'); pv.textContent = 'Computing…';
      var draft = collect(scope);
      var firstPkg = (draft.packages[0] || {});
      var sel = { packageId: firstPkg.id || undefined, addOns: draft.addOns.filter(function (a) { return a.available !== false; }).slice(0, 2).map(function (a) { return { id: a.id, qty: 1 }; }) };
      var d = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
      _call({ op: 'bookingPreviewPrice', pricing: draft, selection: sel, ctx: { date: d, startTime: '14:00', distanceKm: 15 } }).then(function (b) {
        pv.innerHTML = (b.breakdown || []).map(function (x) { return '<div style="display:flex;justify-content:space-between;"><span>' + esc(x.label) + '</span><span>' + (x.amount < 0 ? '−' : '') + 'KES ' + Math.abs(Math.round(x.amount / 100)).toLocaleString() + '</span></div>'; }).join('') +
          '<div style="border-top:1px solid rgba(255,255,255,.15);margin-top:6px;padding-top:6px;display:flex;justify-content:space-between;font-weight:800;color:#71ff00;"><span>Total</span><span>KES ' + Math.round(b.totalCents / 100).toLocaleString() + '</span></div>' +
          (b.depositCents ? '<div style="display:flex;justify-content:space-between;font-size:12px;color:rgba(255,255,255,.6);"><span>Deposit now</span><span>KES ' + Math.round(b.depositCents / 100).toLocaleString() + '</span></div>' : '');
      }).catch(function (e) { pv.textContent = (e && e.message) || 'Preview failed.'; });
    };
    scope.querySelector('#ps_save').onclick = function () {
      var btn = scope.querySelector('#ps_save'); btn.disabled = true; btn.textContent = 'Saving…';
      _call({ op: 'providerUpdateServicePricing', serviceId: serviceId, pricing: collect(scope) })
        .then(function () { _toast('Pricing saved.', true); close(); if (typeof onSaved === 'function') onSaved(); })
        .catch(function (e) { _toast((e && e.message) || 'Save failed.', false); btn.disabled = false; btn.textContent = 'Save pricing'; });
    };
  }

  window.SokoniPricingStudio = { open: open };
})();
