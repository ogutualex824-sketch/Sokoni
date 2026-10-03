/* ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
   SokoniVehicles — Car Hub buy & sell on the web (Car Hub C4, 2026-10-03)
   ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
   Server authority: functions/vehicle-hub.js (vehicleListings / vehicleEnquiries / vehicleReports, Cloud-Function-only
   rules). Owner 2026-10-03: MARKETPLACE FIRST — a buyer finds a listing, enquires in SOKONI, inspects and agrees the sale
   with the seller OUTSIDE SOKONI; basic listing is FREE; nothing is public until AdminOS approves it. This module renders
   and calls; it never decides a status, a price, a commission or a verification:
     browse(opts)      listVehicles / searchVehicles → ACTIVE listings only (server-filtered)
     enquire(id)       submitVehicleEnquiry (in-app; the seller sees it with your account, no WhatsApp)
     report(id)        reportVehicleListing → AdminOS
     sell()            createVehicleListing → publishVehicleListing = submitted for REVIEW (never live at once)
     mountMine(el)     listMyVehicleListings (every status) + close as sold / withdrawn + enquiries + message buyer
   A listing's logbook / duty / condition fields are the SELLER'S DECLARATIONS — never shown as verified.
   ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════ */
(function (G) {
  'use strict';
  var d = G.document;
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var call = function (name, data) { return G.firebase.functions().httpsCallable(name)(data || {}).then(function (r) { return r.data; }); };
  var signedIn = function () { return !!(G.firebase && G.firebase.auth && G.firebase.auth().currentUser); };
  var goLogin = function () { G.location.href = 'login.html?next=' + encodeURIComponent(G.location.pathname + '?tab=buysell'); };
  var money = function (n, cur) { var v = Number(n); return isFinite(v) && v > 0 ? (cur === 'USD' ? 'USD ' : 'KES ') + v.toLocaleString('en-KE') : '—'; };
  var errText = function (e) { return (e && e.message) || 'Something went wrong — please try again.'; };
  var STATUS = { draft: 'Draft', pending_review: 'Under review by SOKONI', active: 'Live', rejected: 'Not approved', suspended: 'Suspended by SOKONI', sold: 'Sold', withdrawn: 'Withdrawn' };
  var COND = { new: 'New', used_excellent: 'Used', used_good: 'Used', used_fair: 'Used (fair)', salvage: 'Salvage' };
  var TYPE = { car: 'sedan', motorbike: 'motorbike', truck: 'truck', van: 'van', bus: 'bus', machinery: 'other', commercial: 'other' };
  var val = function (id) { var e = d.getElementById(id); return e && e.value != null ? String(e.value).trim() : ''; };
  function note(el, msg, color) { if (el) { el.innerHTML = msg; el.style.color = color || 'rgba(255,255,255,0.7)'; } }

  /* ── browse ── */
  var _last = [];
  function card(v) {
    var img = (v.images && v.images[0] && /^https:\/\//.test(v.images[0])) ? '<img src="' + esc(v.images[0]) + '" alt="" loading="lazy" style="width:100%;height:150px;object-fit:cover;border-radius:12px 12px 0 0;">' : '<div style="height:110px;display:flex;align-items:center;justify-content:center;font-size:42px;background:rgba(255,255,255,0.03);border-radius:12px 12px 0 0;">🚗</div>';
    return '<div class="ch-card" style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:14px;overflow:hidden;">' + img
      + '<div style="padding:12px 14px;"><div style="font-weight:900;color:#fff;">' + esc(v.year) + ' ' + esc(v.make) + ' ' + esc(v.model) + '</div>'
      + '<div style="font-size:16px;font-weight:900;color:#71ff00;margin:4px 0;">' + money(v.price, v.currency) + (v.negotiable ? ' <span style="font-size:11px;color:rgba(255,255,255,0.45);font-weight:600;">negotiable</span>' : '') + '</div>'
      + '<div style="font-size:12px;color:rgba(255,255,255,0.55);">' + [COND[v.condition] || '', v.mileageKm ? Number(v.mileageKm).toLocaleString('en-KE') + ' km' : '', v.transmission || '', v.fuelType || '', v.county || ''].filter(Boolean).map(esc).join(' · ') + '</div>'
      + '<div style="display:flex;gap:6px;margin-top:10px;"><button type="button" data-veh-enq="' + esc(v.listingId) + '" style="flex:1;padding:9px;background:#71ff00;color:#000;border:0;border-radius:9px;font-weight:800;cursor:pointer;">💬 Enquire</button>'
      + '<button type="button" data-veh-rep="' + esc(v.listingId) + '" title="Report this listing" aria-label="Report this listing" style="padding:9px 11px;background:none;border:1px solid rgba(255,255,255,0.15);border-radius:9px;color:#ccc;cursor:pointer;">⚑</button></div></div></div>';
  }
  function browse(opts) {
    var grid = d.getElementById((opts && opts.grid) || 'bsGrid'); if (!grid) return Promise.resolve();
    grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:30px;color:rgba(255,255,255,0.4);">Loading vehicles…</div>';
    var q = val('bsSearch');
    var p = q ? call('searchVehicles', { query: q.slice(0, 80) }).then(function (r) { return (r && r.results) || []; })
              : call('listVehicles', { limit: 48 }).then(function (r) { return (r && r.listings) || []; });
    return p.then(function (list) {
      var cond = val('bsCondition'), sort = val('bsSort');
      if (cond === 'Brand New') list = list.filter(function (v) { return v.condition === 'new'; });
      else if (cond) list = list.filter(function (v) { return v.condition && v.condition !== 'new'; });
      if (sort === 'priceasc') list.sort(function (a, b) { return (a.price || 0) - (b.price || 0); });
      if (sort === 'pricedesc') list.sort(function (a, b) { return (b.price || 0) - (a.price || 0); });
      _last = list;
      grid.innerHTML = list.length ? list.map(card).join('')
        : '<div style="grid-column:1/-1;text-align:center;padding:40px 20px;color:rgba(255,255,255,0.45);">No vehicles listed' + (q || cond ? ' for this search' : ' yet') + '. Every listing is reviewed by SOKONI before it appears.</div>';
    }).catch(function () {
      grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:40px 20px;color:rgba(255,255,255,0.55);">Could not load vehicles — this is a connection problem, not an empty marketplace. <button type="button" onclick="SokoniVehicles.browse()" style="color:#71ff00;background:none;border:0;cursor:pointer;font-weight:800;">Retry</button></div>';
    });
  }

  /* ── enquire / report (modal) ── */
  function modal(html) {
    close();
    var o = d.createElement('div'); o.id = 'skVehModal'; o.setAttribute('role', 'dialog'); o.setAttribute('aria-modal', 'true');
    o.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:100001;display:flex;align-items:center;justify-content:center;padding:16px';
    o.innerHTML = '<div style="background:#111;color:#eee;border:1px solid #2a2a2a;border-radius:14px;max-width:440px;width:100%;padding:18px;font:14px/1.5 system-ui">' + html + '</div>';
    o.addEventListener('click', function (e) { if (e.target === o || (e.target.closest && e.target.closest('[data-veh-x]'))) close(); });
    d.body.appendChild(o); return o;
  }
  function close() { var m = d.getElementById('skVehModal'); if (m && m.parentNode) m.parentNode.removeChild(m); }
  var inCss = 'width:100%;box-sizing:border-box;background:#1a1a1a;border:1px solid #333;color:#eee;border-radius:8px;padding:9px;margin:6px 0';
  function enquire(id) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(String(id || ''))) return;
    if (!signedIn()) { goLogin(); return; }
    var v = _last.filter(function (x) { return x.listingId === id; })[0] || {};
    var m = modal('<div style="font-weight:800;font-size:16px;margin-bottom:4px">Enquire about ' + esc((v.year || '') + ' ' + (v.make || '') + ' ' + (v.model || '')) + '</div>'
      + '<div style="opacity:.7;font-size:12px">Your message goes to the seller in SOKONI. Inspect the vehicle and agree the sale directly with the seller — SOKONI does not take payment for the car.</div>'
      + '<textarea id="skVehMsg" rows="4" maxlength="1000" style="' + inCss + '" placeholder="e.g. Is it still available? Can I view it this weekend?"></textarea>'
      + '<input id="skVehOffer" type="number" min="0" inputmode="numeric" style="' + inCss + '" placeholder="Your offer in KES (optional)">'
      + '<div id="skVehErr" style="color:#ff6b6b;font-size:12px;min-height:16px"></div>'
      + '<div style="display:flex;gap:8px;justify-content:flex-end"><button type="button" data-veh-x style="background:#222;color:#eee;border:1px solid #333;border-radius:9px;padding:9px 12px;cursor:pointer">Cancel</button><button type="button" id="skVehSend" style="background:#71ff00;color:#000;border:0;border-radius:9px;padding:10px 14px;font-weight:800;cursor:pointer">Send enquiry</button></div>');
    m.querySelector('#skVehSend').addEventListener('click', function () {
      var b = this, msg = (m.querySelector('#skVehMsg').value || '').trim(), offer = (m.querySelector('#skVehOffer').value || '').replace(/[^0-9]/g, '');
      if (msg.length < 5) { m.querySelector('#skVehErr').textContent = 'Write a short message to the seller.'; return; }
      b.disabled = true; b.textContent = 'Sending…';
      call('submitVehicleEnquiry', { listingId: id, message: msg, offerPrice: offer ? Number(offer) : undefined }).then(function () {
        m.querySelector('#skVehErr').style.color = '#71ff00'; m.querySelector('#skVehErr').textContent = 'Sent — the seller sees your enquiry in SOKONI.'; setTimeout(close, 1800);
      }).catch(function (e) { b.disabled = false; b.textContent = 'Send enquiry'; m.querySelector('#skVehErr').textContent = errText(e); });
    });
  }
  function report(id) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(String(id || ''))) return;
    if (!signedIn()) { goLogin(); return; }
    var m = modal('<div style="font-weight:800;font-size:16px;margin-bottom:4px">Report this listing</div><div style="opacity:.7;font-size:12px">SOKONI reviews reports in AdminOS.</div>'
      + '<textarea id="skVehRep" rows="3" maxlength="500" style="' + inCss + '" placeholder="What is wrong with this listing?"></textarea><div id="skVehErr" style="color:#ff6b6b;font-size:12px;min-height:16px"></div>'
      + '<div style="display:flex;gap:8px;justify-content:flex-end"><button type="button" data-veh-x style="background:#222;color:#eee;border:1px solid #333;border-radius:9px;padding:9px 12px;cursor:pointer">Cancel</button><button type="button" id="skVehRepGo" style="background:#ff6b6b;color:#000;border:0;border-radius:9px;padding:10px 14px;font-weight:800;cursor:pointer">Report</button></div>');
    m.querySelector('#skVehRepGo').addEventListener('click', function () {
      var b = this, reason = (m.querySelector('#skVehRep').value || '').trim();
      if (reason.length < 5) { m.querySelector('#skVehErr').textContent = 'Tell us what is wrong.'; return; }
      b.disabled = true;
      call('reportVehicleListing', { listingId: id, reason: reason }).then(function () { m.querySelector('#skVehErr').style.color = '#71ff00'; m.querySelector('#skVehErr').textContent = 'Reported — thank you.'; setTimeout(close, 1500); })
        .catch(function (e) { b.disabled = false; m.querySelector('#skVehErr').textContent = errText(e); });
    });
  }

  /* ── sell: draft → submitted for review ── */
  function sell() {
    var msg = d.getElementById('bsMsg');
    if (!signedIn()) { note(msg, 'Sign in to list your vehicle.', '#ff9800'); setTimeout(goLogin, 900); return Promise.resolve(); }
    var make = val('bsMake'), model = val('bsModel'), year = parseInt(val('bsYear'), 10), price = Number(String(val('bsPrice')).replace(/[^0-9.]/g, ''));
    if (!make || !model || !(year > 1950) || !(price > 0)) { note(msg, 'Fill in make, model, year and price.', '#ff9800'); return Promise.resolve(); }
    var condSel = val('bsConditionSell'), origin = condSel === 'Foreign Used' ? 'Foreign used' : condSel === 'Locally Used' ? 'Locally used' : '';
    var photo = val('bsPhoto');
    var data = {
      make: make, model: model, year: year, listingType: 'for_sale', price: price,
      vehicleType: TYPE[val('bsVehicleType')] || 'other',
      condition: condSel === 'Brand New' ? 'new' : 'used_good',
      transmission: (val('bsTrans') || '').toLowerCase(), fuelType: (val('bsFuel') || '').toLowerCase(),
      mileageKm: parseInt(String(val('bsMileage')).replace(/[^0-9]/g, ''), 10) || 0,
      location: val('bsCity'), county: val('bsCity'),
      description: (origin ? '[' + origin + '] ' : '') + val('bsDesc'),
      images: /^https:\/\/[^\s"'<>]{4,490}$/.test(photo) ? [photo] : [],
    };
    note(msg, 'Saving…');
    return call('createVehicleListing', data).then(function (r) {
      return call('publishVehicleListing', { listingId: r.listingId });
    }).then(function () {
      note(msg, '✅ Submitted for review. SOKONI checks every listing before it goes live — you will see its status under <b>My vehicle listings</b>.', '#71ff00');
      var mine = d.getElementById('skVehMine'); if (mine) mountMine(mine);
    }).catch(function (e) { note(msg, '⚠️ ' + esc(errText(e)), '#ff6b6b'); });
  }

  /* ── my listings (seller) ── */
  function mountMine(el) {
    if (!el) return Promise.resolve();
    if (!signedIn()) { el.innerHTML = '<div style="color:rgba(255,255,255,0.5);font-size:13px;">Sign in to see your vehicle listings.</div>'; return Promise.resolve(); }
    el.innerHTML = '<div style="opacity:.6">Loading your listings…</div>';
    return call('listMyVehicleListings').then(function (r) {
      var list = (r && r.listings) || [];
      el.innerHTML = list.length ? list.map(function (v) {
        var open = ['draft', 'pending_review', 'active', 'rejected'].indexOf(v.status) !== -1;
        return '<div style="padding:12px 14px;border:1px solid rgba(255,255,255,0.08);border-radius:12px;margin-bottom:8px;background:rgba(255,255,255,0.02);">'
          + '<div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;"><b style="color:#fff">' + esc(v.year) + ' ' + esc(v.make) + ' ' + esc(v.model) + '</b><span style="font-size:12px;color:#fbbf24;">' + esc(STATUS[v.status] || v.status) + '</span></div>'
          + '<div style="font-size:12px;color:rgba(255,255,255,0.55);margin-top:2px;">' + money(v.price, v.currency) + ' · ' + Number(v.enquiryCount || 0) + ' enquiries · ' + Number(v.viewCount || 0) + ' views</div>'
          + (v.lastModeration && v.lastModeration.reason && (v.status === 'rejected' || v.status === 'suspended') ? '<div style="font-size:12px;color:#ff9a9a;margin-top:4px;">SOKONI: ' + esc(v.lastModeration.reason) + '</div>' : '')
          + '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;">'
          + (v.enquiryCount ? '<button type="button" data-veh-enqs="' + esc(v.listingId) + '" style="padding:7px 10px;border:1px solid rgba(255,255,255,0.15);background:none;color:#ddd;border-radius:8px;cursor:pointer;">View enquiries</button>' : '')
          + (open ? '<button type="button" data-veh-close="' + esc(v.listingId) + '" data-outcome="sold" style="padding:7px 10px;border:1px solid rgba(113,255,0,0.3);background:none;color:#71ff00;border-radius:8px;cursor:pointer;">Mark sold</button>'
                  + '<button type="button" data-veh-close="' + esc(v.listingId) + '" data-outcome="withdrawn" style="padding:7px 10px;border:1px solid rgba(255,255,255,0.15);background:none;color:#ccc;border-radius:8px;cursor:pointer;">Withdraw</button>' : '')
          + '</div><div data-veh-enqbox="' + esc(v.listingId) + '"></div></div>';
      }).join('') : '<div style="color:rgba(255,255,255,0.5);font-size:13px;">No vehicle listings yet. Listing is free; SOKONI reviews each one before it is public.</div>';
    }).catch(function () { el.innerHTML = '<div style="color:rgba(255,255,255,0.6);font-size:13px;">We couldn’t load your listings just now. This is not an empty list — please try again shortly.</div>'; });
  }
  function showEnquiries(id) {
    var box = d.querySelector('[data-veh-enqbox="' + (G.CSS && CSS.escape ? CSS.escape(id) : id) + '"]'); if (!box) return;
    box.innerHTML = '<div style="opacity:.6;font-size:12px;margin-top:6px;">Loading enquiries…</div>';
    call('getVehicleEnquiries', { listingId: id }).then(function (r) {
      var list = (r && r.enquiries) || [];
      box.innerHTML = list.length ? list.map(function (q) {
        return '<div style="margin-top:8px;padding:9px 10px;border-left:2px solid rgba(113,255,0,0.35);font-size:12px;color:#ddd;">' + esc(q.message)
          + (q.offerPrice ? '<div style="color:#71ff00;margin-top:2px;">Offer: ' + money(q.offerPrice) + '</div>' : '')
          + (/^[A-Za-z0-9_-]{1,128}$/.test(String(q.buyerUid || '')) ? '<button type="button" data-veh-msg="' + esc(q.buyerUid) + '" style="margin-top:6px;padding:6px 10px;border:1px solid rgba(255,255,255,0.15);background:none;color:#ddd;border-radius:8px;cursor:pointer;">💬 Message buyer</button>' : '') + '</div>';
      }).join('') : '<div style="opacity:.6;font-size:12px;margin-top:6px;">No enquiries yet.</div>';
    }).catch(function (e) { box.innerHTML = '<div style="color:#ff9a9a;font-size:12px;margin-top:6px;">' + esc(errText(e)) + '</div>'; });
  }

  d.addEventListener('click', function (e) {
    var t = e.target && e.target.closest ? e.target : null; if (!t) return;
    var b;
    if ((b = t.closest('[data-veh-enq]'))) return enquire(b.getAttribute('data-veh-enq'));
    if ((b = t.closest('[data-veh-rep]'))) return report(b.getAttribute('data-veh-rep'));
    if ((b = t.closest('[data-veh-enqs]'))) return showEnquiries(b.getAttribute('data-veh-enqs'));
    if ((b = t.closest('[data-veh-msg]'))) { var uid = b.getAttribute('data-veh-msg'); if (G.SokoniInbox && G.SokoniInbox.openChat) G.SokoniInbox.openChat({ otherUid: uid, otherName: 'Buyer', type: 'customer-provider', context: 'Car Hub vehicle enquiry' }); else G.location.href = 'messages.html'; return; }
    if ((b = t.closest('[data-veh-close]'))) {
      var id = b.getAttribute('data-veh-close'), outcome = b.getAttribute('data-outcome');
      if (!G.confirm || !G.confirm(outcome === 'sold' ? 'Mark this vehicle as sold? It will be removed from the marketplace.' : 'Withdraw this listing?')) return;
      b.disabled = true;
      call('closeVehicleListing', { listingId: id, outcome: outcome }).then(function () { mountMine(d.getElementById('skVehMine')); })
        .catch(function (er) { b.disabled = false; G.alert && G.alert(errText(er)); });
    }
  });

  G.SokoniVehicles = { browse: browse, enquire: enquire, report: report, sell: sell, mountMine: mountMine };
})(window);
