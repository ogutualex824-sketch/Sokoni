/* ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
   SokoniTechEditor — Tech Hub slice 4b (2026-10-03): the device-repair service editor + Repairs view on provider-dashboard
   ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
   Server authority: providerServices.techProfile and providerBookings.repairDetails, validated by
   functions/shared/tech-service-profile.js (feat/tech-taxonomy-on-13f74f3). This module only renders and collects:
     · the fieldset appears ONLY when the workspace (providerDispatch businessWorkspace) grants a Tech capability, and
       shows only the service modes the provider was granted and device fields only for DEVICE_REPAIR / ELECTRONICS;
     · the server re-checks everything (a forged checkbox is refused there, not trusted here);
     · Repairs lists the provider's own bookings that carry repairDetails (providerGetBookings, owner-scoped). Status
       changes, PIN completion and settlement stay in the existing Bookings section — no second repair lifecycle.
   The vocabularies below mirror the server's (scripts/test-tech-directory.js T10 checks they are identical).
   ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════ */
(function (G) {
  'use strict';
  var DEVICE_TYPES = { phone: 'Phone', tablet: 'Tablet', laptop: 'Laptop', desktop: 'Desktop / PC', tv: 'TV', audio: 'Audio / speakers',
    console: 'Game console', smartwatch: 'Smartwatch', printer: 'Printer', appliance: 'Small appliance', other: 'Other device' };
  var REPAIR_TYPES = { diagnostics: 'Diagnostics / inspection', screen: 'Screen / display', battery: 'Battery', charging: 'Charging port / power',
    water: 'Water damage', software: 'Software / OS', data: 'Data recovery / transfer', keyboard: 'Keyboard / trackpad',
    board: 'Motherboard / board-level', camera: 'Camera', audio: 'Speaker / microphone', buttons: 'Buttons / housing',
    network: 'Network / Wi-Fi / SIM', upgrade: 'Upgrade (RAM / storage)', other: 'Other repair' };
  var BRANDS = ['Samsung', 'Apple', 'Tecno', 'Infinix', 'Itel', 'Xiaomi', 'Oppo', 'Vivo', 'Realme', 'Huawei', 'Nokia', 'Google',
    'OnePlus', 'Motorola', 'HP', 'Dell', 'Lenovo', 'Asus', 'Acer', 'Microsoft', 'Toshiba', 'LG', 'Sony', 'Hisense',
    'TCL', 'Vitron', 'Canon', 'Epson', 'Other'];
  var MODE_LABEL = { WORKSHOP: 'At my workshop', ONSITE_SUPPORT: 'On-site at the customer', FIELD_SERVICE: 'Field service / site visit',
    PICKUP_DROP_OFF: 'Pickup & drop-off', REMOTE_SUPPORT: 'Remote support' };
  var MODE_CAPS = ['WORKSHOP', 'ONSITE_SUPPORT', 'FIELD_SERVICE', 'PICKUP_DROP_OFF', 'REMOTE_SUPPORT'];
  var DEVICE_CAPS = ['DEVICE_REPAIR', 'ELECTRONICS'];

  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var caps = [];                      /* granted capabilities — from the server workspace only */
  var hasDevice = function () { return DEVICE_CAPS.some(function (c) { return caps.indexOf(c) > -1; }); };
  var modes = function () { return MODE_CAPS.filter(function (c) { return caps.indexOf(c) > -1; }); };
  var enabled = function () { return hasDevice() || modes().length > 0; };

  function checks(name, map, keys) {
    return keys.map(function (k) {
      return '<label style="display:inline-flex;align-items:center;gap:6px;margin:0 12px 6px 0;font-size:13px"><input type="checkbox" name="' + name + '" value="' + esc(k) + '"> ' + esc(map[k] || k) + '</label>';
    }).join('');
  }

  /* The fieldset, injected after the description field of the service form. Rebuilt when capabilities arrive. */
  function mountFieldset() {
    var host = document.getElementById('svDesc');
    var old = document.getElementById('svTech');
    if (old) old.parentNode.removeChild(old);
    if (!host || !enabled()) return;
    var fg = host.closest ? host.closest('.fg') : host.parentNode;
    var box = document.createElement('fieldset');
    box.id = 'svTech';
    box.style.cssText = 'margin-top:10px;border:1px solid rgba(255,255,255,0.12);border-radius:10px;padding:10px 12px';
    var html = '<legend style="font-size:12px;font-weight:800;padding:0 6px">Tech service details</legend>';
    if (hasDevice()) {
      html += '<div class="sk-lbl" style="margin-top:4px">Devices you repair</div>' + checks('svTechDev', DEVICE_TYPES, Object.keys(DEVICE_TYPES))
        + '<div class="sk-lbl" style="margin-top:6px">Repairs this service covers</div>' + checks('svTechRep', REPAIR_TYPES, Object.keys(REPAIR_TYPES))
        + '<div class="sk-lbl" style="margin-top:6px">Brands</div>' + checks('svTechBrand', {}, BRANDS)
        + '<div class="fg" style="margin-top:6px"><label class="sk-lbl" for="svTechModels">Models (comma-separated, optional)</label><input class="sk-in" id="svTechModels" maxlength="600" placeholder="e.g. Galaxy A54, iPhone 13"></div>';
    }
    if (modes().length) {
      html += '<div class="sk-lbl" style="margin-top:6px">How you deliver it <small style="opacity:.6">(only what SOKONI approved for your business)</small></div>'
        + checks('svTechMode', MODE_LABEL, modes());
    }
    html += '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:6px">'
      + '<div class="fg" style="flex:1;min-width:140px"><label class="sk-lbl" for="svTechTurn">Typical turnaround (hours, your estimate)</label><input class="sk-in" id="svTechTurn" type="number" min="1" max="720" step="1"></div>'
      + '<div class="fg" style="flex:2;min-width:180px"><label class="sk-lbl" for="svTechArea">Service area</label><input class="sk-in" id="svTechArea" maxlength="120" placeholder="e.g. Nairobi CBD, Westlands"></div></div>';
    box.innerHTML = html;
    fg.parentNode.insertBefore(box, fg.nextSibling);
  }

  function setChecks(name, vals) {
    var set = {}; (vals || []).forEach(function (v) { set[v] = 1; });
    Array.prototype.forEach.call(document.querySelectorAll('input[name="' + name + '"]'), function (i) { i.checked = !!set[i.value]; });
  }
  function getChecks(name) {
    return Array.prototype.filter.call(document.querySelectorAll('input[name="' + name + '"]'), function (i) { return i.checked; }).map(function (i) { return i.value; });
  }

  /** Fill the fieldset from a service's stored techProfile (or clear it). */
  function fill(tp) {
    if (!document.getElementById('svTech')) return;
    tp = tp || {};
    setChecks('svTechDev', tp.deviceTypes); setChecks('svTechRep', tp.repairTypes); setChecks('svTechBrand', tp.brands); setChecks('svTechMode', tp.serviceModes);
    var m = document.getElementById('svTechModels'); if (m) m.value = (tp.models || []).join(', ');
    var t = document.getElementById('svTechTurn'); if (t) t.value = tp.turnaroundHours || '';
    var a = document.getElementById('svTechArea'); if (a) a.value = tp.serviceArea || '';
  }

  /** The techProfile to send, or undefined when this business has no Tech capability (the field is then not sent). */
  function read() {
    if (!document.getElementById('svTech')) return undefined;
    var out = { serviceModes: getChecks('svTechMode') };
    if (hasDevice()) {
      out.deviceTypes = getChecks('svTechDev'); out.repairTypes = getChecks('svTechRep'); out.brands = getChecks('svTechBrand');
      var m = document.getElementById('svTechModels');
      out.models = m ? m.value.split(',').map(function (x) { return x.trim(); }).filter(Boolean).slice(0, 30) : [];
    }
    var t = document.getElementById('svTechTurn'); var tv = t && t.value ? Math.round(Number(t.value)) : null;
    out.turnaroundHours = tv || null;
    var a = document.getElementById('svTechArea'); out.serviceArea = a ? a.value.trim() : '';
    return out;
  }

  /* ── Repairs view ── */
  function statusLabel(b) { return String(b.status || '').replace(/_/g, ' ') || '—'; }
  function when(b) { return [b.date, b.startTime].filter(Boolean).join(' · ') || '—'; }
  function repairRow(b) {
    var rd = b.repairDetails || {};
    var dev = [DEVICE_TYPES[rd.deviceType] || rd.deviceType, rd.brand, rd.model].filter(Boolean).join(' · ');
    return '<div class="card" style="padding:12px 14px;margin-bottom:10px">'
      + '<div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap"><strong>' + esc(b.service || 'Repair') + '</strong><span class="badge">' + esc(statusLabel(b)) + '</span></div>'
      + '<div style="font-size:13px;opacity:.8;margin-top:4px">' + esc(dev || 'Device not stated') + (rd.repairType ? ' — ' + esc(REPAIR_TYPES[rd.repairType] || rd.repairType) : '') + '</div>'
      + (rd.problem ? '<div style="font-size:13px;margin-top:4px">“' + esc(rd.problem) + '”</div>' : '')
      + '<div style="font-size:12px;opacity:.65;margin-top:4px">' + esc(b.customerName || 'Customer') + ' · ' + esc(when(b)) + (rd.serviceMode ? ' · ' + esc(MODE_LABEL[rd.serviceMode] || rd.serviceMode) : '') + '</div>'
      + '<div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap"><button type="button" class="btn btn-s" data-tech-repair-open="' + esc(b.id) + '">Manage in Bookings</button>'
      + '<button type="button" class="btn btn-s" data-tech-repair-msg="' + esc(b.id) + '">💬 Message customer</button></div></div>';
  }
  function loadRepairs() {
    var box = document.getElementById('rpList');
    if (!box) return Promise.resolve();
    box.innerHTML = '<div style="opacity:.6;padding:12px 0">Loading repairs…</div>';
    if (typeof firebase === 'undefined' || !firebase.functions) { box.innerHTML = '<div style="opacity:.7">Repairs could not be loaded — please refresh.</div>'; return Promise.resolve(); }
    return firebase.functions().httpsCallable('providerDispatch')({ op: 'providerGetBookings', limit: 100 }).then(function (r) {
      var list = ((r && r.data && r.data.bookings) || []).filter(function (b) { return b && b.repairDetails; });
      box.innerHTML = list.length ? list.map(repairRow).join('')
        : '<div style="opacity:.7;padding:12px 0">No repair bookings yet. Customers book your device services from your storefront; each booking shows the device and problem here.</div>';
    }).catch(function () {
      box.innerHTML = '<div style="opacity:.7;padding:12px 0">We couldn’t load your repairs just now. This is not an empty list — please try again shortly.</div>';
    });
  }

  function onWorkspace(w) {
    caps = (w && Array.isArray(w.serviceCapabilities)) ? w.serviceCapabilities.slice() : [];
    mountFieldset();
  }

  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('sokoni:workspace', function (e) { onWorkspace(e && e.detail); });
    document.addEventListener('click', function (e) {
      var mb = e.target && e.target.closest ? e.target.closest('[data-tech-repair-msg]') : null;
      if (mb) {   /* Tech slice 4L — the booking's own conversation; the server checks the provider is its party */
        var bid = mb.getAttribute('data-tech-repair-msg');
        if (G.SokoniInbox && typeof G.SokoniInbox.openForTransaction === 'function') G.SokoniInbox.openForTransaction('service_booking', bid);
        else G.location.href = 'messages.html?tx=service_booking&txId=' + encodeURIComponent(bid);
        return;
      }
      var b = e.target && e.target.closest ? e.target.closest('[data-tech-repair-open]') : null;
      if (!b) return;
      var id = b.getAttribute('data-tech-repair-open');
      if (G.P && typeof G.P.show === 'function') G.P.show('bookings', null);
      setTimeout(function () { var s = document.getElementById('bkSearch'); if (s && G.B && typeof G.B.search === 'function') { s.value = id; G.B.search(id); } }, 300);
    });
    if (G.__sokoniWorkspace) onWorkspace(G.__sokoniWorkspace);
  }

  G.SokoniTechEditor = {
    fill: fill, read: read, loadRepairs: loadRepairs,
    _internal: { DEVICE_TYPES: DEVICE_TYPES, REPAIR_TYPES: REPAIR_TYPES, BRANDS: BRANDS, MODE_CAPS: MODE_CAPS, onWorkspace: onWorkspace, repairRow: repairRow },
  };
}(typeof window !== 'undefined' ? window : globalThis));
