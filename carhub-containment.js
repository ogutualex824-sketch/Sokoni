/* carhub-containment.js — Car Hub C1b (2026-10-03). Loaded LAST on car-hub.html (defer).
 *
 * car-hub.html grew a browser-only car economy: cars "listed" into localStorage, "rented" in the same browser with no
 * payment and a commission marked auto_collected, driving licences approved by the user on the same page, a simulated
 * GPS "live map", tracking plans with hard-coded prices, and roadside / finance / inspection / transport / parts forms
 * that wrote rule-less collections through unauthenticated second Firebase apps (or would have polluted
 * applications/). None of it reached a provider, a reviewer or a payment authority.
 *
 * This layer re-points every money, approval and record entry point at the canonical authority, or says honestly that
 * the feature is not available yet. It never writes Firestore or localStorage records and never decides a payment,
 * an approval or a price:
 *   rent a car            → car-rental.html (approved rental providers → SokoniBookService → IntaSend → booking PIN)
 *   my bookings           → bookings.html (providerBookings, server-written)
 *   list your car         → HubRegister car-rental (applications → AdminOS)
 *   register as mechanic  → HubRegister mechanic;  sell parts → HubRegister auto-parts
 *   mechanic booking      → mechanics.html (booking engine / leads)
 *   roadside SOS          → CRITICAL support ticket (reaches AdminOS) — never a "provider accepted" claim
 *   transport request     → support ticket (no transport authority yet)
 *   finance / inspection  → "not available yet" (no lender / inspection authority; never a fabricated approval)
 *   licence approval      → refused here (only SOKONI staff, server-side, verify a licence)
 *   tracking plans        → "not available yet" (activation only after verified payment + subscription; rules C2)
 *   vehicle sale listing  → "not available yet" (canonical vehicle-hub wiring = Car Hub C4)
 *   price estimate / financing calculator / transport quote → "not available" (invented numbers removed)
 * Commission on any real booking is server-side only (SOKONI 5%, provider-paid, at settlement).
 */
(function (G) {
  'use strict';
  var d = G.document;
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function note(msg) {
    var t = d.getElementById('chContainNote');
    if (!t) {
      t = d.createElement('div'); t.id = 'chContainNote'; t.setAttribute('role', 'status');
      t.style.cssText = 'position:fixed;left:50%;bottom:84px;transform:translateX(-50%);max-width:min(92vw,520px);z-index:100000;background:#111;color:#eee;border:1px solid #2a2a2a;border-radius:12px;padding:12px 14px;font:13px/1.45 system-ui;box-shadow:0 8px 30px rgba(0,0,0,.5)';
      d.body.appendChild(t);
    }
    t.innerHTML = msg; t.hidden = false;
    clearTimeout(note._t); note._t = setTimeout(function () { t.hidden = true; }, 6000);
  }
  var NA = function (what) { return function () { note(esc(what) + ' is not available in SOKONI yet. Nothing was saved and nothing was charged.'); return false; }; };
  function hubRegister(category, label) {
    return function () {
      if (G.HubRegister && typeof G.HubRegister.open === 'function') { G.HubRegister.open({ hub: 'car', category: category }); return; }
      note('The ' + esc(label) + ' application is still loading — please try again in a moment.');
    };
  }
  function supportTicket(topic, desc) { G.location.href = 'support.html?topic=' + encodeURIComponent(topic) + '&desc=' + encodeURIComponent(desc); }
  function val(id) { var e = d.getElementById(id); return e && e.value ? String(e.value).trim() : ''; }

  /* ── rentals: the browser-only "rent" flow → approved rental providers ── */
  function goRent() { G.location.href = 'car-rental.html'; }
  G.openBookingModal = function () { goRent(); };
  G.confirmBooking = function () { goRent(); };
  G.calcBookingTotal = function () {};
  G.renderBookings = function () {
    var list = d.getElementById('myBookingsList'); if (!list) return;
    list.innerHTML = '<div style="text-align:center;padding:40px 20px;color:rgba(255,255,255,0.6);"><div style="font-size:40px;margin-bottom:10px;">📋</div>'
      + 'Your rentals, mechanic bookings, payments and booking PINs are in My Bookings.<br><a href="bookings.html" style="color:#71ff00;font-weight:800;">Open My Bookings</a></div>';
  };
  G.cancelBooking = G._doCancelBooking = function () { G.location.href = 'bookings.html'; };
  G.triggerSOS = function () { supportTicket('sos', 'SOKONI Car Hub roadside SOS — describe where you are and what happened: '); };

  /* ── "List your car" / fleet manager (localStorage cars with random coordinates) → become an approved rental provider ── */
  G.addCarToFleet = hubRegister('car-rental', 'car rental');
  G.renderFleetManager = function () {
    var el = d.getElementById('fleetDash'); if (!el) return;
    el.innerHTML = '<div style="padding:24px;border:1px solid rgba(255,255,255,0.08);border-radius:16px;background:rgba(255,255,255,0.02);color:rgba(255,255,255,0.7);font-size:13px;line-height:1.5;">'
      + '<div style="font-size:16px;font-weight:900;color:#fff;margin-bottom:6px;">Rent out your vehicles on SOKONI</div>'
      + 'Apply as a car-rental provider. Once SOKONI approves you, you manage your vehicles, bookings and earnings from your provider dashboard, and customers book and pay in SOKONI.'
      + '<div style="margin-top:14px;display:flex;gap:8px;flex-wrap:wrap;"><button type="button" onclick="addCarToFleet()" style="padding:11px 18px;background:#71ff00;color:#000;border:0;border-radius:10px;font-weight:800;cursor:pointer;">Apply as a rental provider</button>'
      + '<a href="provider-dashboard.html" style="padding:11px 18px;border:1px solid rgba(255,255,255,0.15);border-radius:10px;color:#fff;text-decoration:none;font-weight:700;">Open my provider dashboard</a></div></div>';
  };
  G.handleRequest = G.toggleCarStatus = function () { note('Vehicle bookings are managed from your provider dashboard once you are an approved rental provider.'); };

  /* ── driving licence: never approved by the user on this page ── */
  G.approveDLFromQueue = G.rejectDLFromQueue = function () { note('Driving licences are verified by SOKONI staff — not on this page.'); };
  var _getDL = G.getDLStatus;
  G.getDLStatus = function () {
    var r = typeof _getDL === 'function' ? _getDL() : null;
    if (r && r.status === 'approved') r = Object.assign({}, r, { status: 'unverified' });   /* a browser "approval" is not a verification */
    return r;
  };

  /* ── live map / tracking ── */
  G.startLiveTracking = function () {};
  G.trkSubscribe = NA('Vehicle tracking plans');
  G.trackMyCar = function () { note('Live vehicle location is not available — SOKONI shows a location only from a registered tracking device.'); };

  /* ── buy & sell — Car Hub C4: the canonical vehicle-hub authority (sokoni-vehicles.js). Was localStorage "listings". ── */
  G.submitCarForSale = function () { if (G.SokoniVehicles) return G.SokoniVehicles.sell(); note('Vehicle listing is still loading — please try again in a moment.'); };
  G.renderBuySellGrid = function () { if (G.SokoniVehicles) return G.SokoniVehicles.browse(); };
  G.setBuySellCategory = function (cat, btn) {
    try { d.querySelectorAll('[onclick^="setBuySellCategory"]').forEach(function (b) { b.classList.remove('active'); }); if (btn) btn.classList.add('active'); } catch (e) {}
    if (G.SokoniVehicles) G.SokoniVehicles.browse();
  };
  function mountVehicles() {
    var panel = d.getElementById('tab-buysell'); if (!panel || !G.SokoniVehicles) return;
    if (!d.getElementById('skVehMine')) {
      var wrap = d.createElement('div');
      wrap.style.cssText = 'max-width:1100px;margin:0 auto;padding:0 20px 30px;';
      wrap.innerHTML = '<div style="font-size:16px;font-weight:900;color:#fff;margin:10px 0;">🚗 My vehicle listings</div><div id="skVehMine"></div>';
      panel.appendChild(wrap);
    }
    G.SokoniVehicles.browse(); G.SokoniVehicles.mountMine(d.getElementById('skVehMine'));
  }

  /* ── mechanics registration in the hub ── */
  G.submitRegisterMechanic = hubRegister('mechanic', 'mechanic');
  G.openRegisterMechanic = hubRegister('mechanic', 'mechanic');

  /* ── CarHubPro: patch the methods that write, take money or invent numbers (runs after sokoni-carhub-pro.js) ── */
  function patchPro() {
    var P = G.CarHubPro; if (!P || P.__contained) return !!P;
    P.submitRoadsideRequest = function () {
      var loc = val('rsLocation'), phone = val('rsPhone');
      supportTicket('sos', 'SOKONI Car Hub roadside SOS' + (loc ? ' — location: ' + loc : '') + (phone ? ' — phone: ' + phone : '') + '. Details: ');
    };
    P.submitTransportRequest = function () { supportTicket('request', 'SOKONI Car Hub vehicle transport request — from / to / vehicle: '); };
    P.submitFinancingApplication = NA('Car finance applications');
    P.calcFinancing = NA('The financing calculator');
    P.submitInspectionBooking = NA('Booking a vehicle inspection');
    P.calcTransportQuote = NA('Instant transport quotes');
    P.estimateVehiclePrice = NA('Vehicle price estimates');
    P.submitSellPart = P.openSellPartForm = hubRegister('auto-parts', 'auto-parts seller');
    P.openMechBooking = P.confirmMechBooking = function () { G.location.href = 'mechanics.html'; };
    P.renderBuyerDashboard = P.renderDealerAnalytics = function () {
      ['buyerDashContent', 'dealerAnalyticsPanel'].forEach(function (id) { var el = d.getElementById(id);
      if (el) el.innerHTML = '<div style="padding:20px;color:rgba(255,255,255,0.7);font-size:13px;">Your bookings and payments are in <a href="bookings.html" style="color:#71ff00;font-weight:800;">My Bookings</a>. Business revenue appears in your provider dashboard from completed, paid SOKONI bookings only.</div>'; });
    };
    P.__contained = true;
    return true;
  }
  if (!patchPro()) { var n = 0, iv = setInterval(function () { if (patchPro() || ++n > 40) clearInterval(iv); }, 150); }

  /* ── C3: every Car Hub service tab offers ITS application (the ONE intake, category-specific questions, AdminOS review).
        Nothing here grants anything: an application is a request until SOKONI approves it server-side. ── */
  var APPLY = {
    'tab-buysell':   ['car-dealer', 'Sell vehicles as a dealer'],
    'tab-ntsa':      ['ntsa-agent', 'Offer NTSA / vehicle document services'],
    'tab-insurance': ['insurance-auto', 'Offer car insurance (licensed agents / brokers)'],
    'tab-fleet':     ['fleet-operator', 'Register your fleet'],
    'tab-mechanics': ['mechanic', 'List your garage or mechanic service'],
    'tab-parts':     ['auto-parts', 'Sell auto parts'],
    'tab-roadside':  ['towing-roadside', 'Offer towing / roadside assistance'],
    'tab-finance':   ['car-finance', 'Offer car finance (licensed lenders / brokers)'],
    'tab-inspect':   ['vehicle-inspection', 'Offer vehicle inspections'],
    'tab-transport': ['vehicle-transport', 'Offer vehicle transport'],
    'tab-tracking-hub': ['vehicle-tracking', 'Offer tracking devices / installation'],
    'tab-browse':    ['car-rental', 'Rent out your vehicles'],
  };
  function addApplyCards() {
    Object.keys(APPLY).forEach(function (pid) {
      var panel = d.getElementById(pid); if (!panel || panel.querySelector('[data-ch-apply]')) return;
      var cat = APPLY[pid][0], label = APPLY[pid][1];
      var box = d.createElement('div'); box.setAttribute('data-ch-apply', cat);
      box.style.cssText = 'margin:18px 0;padding:16px 18px;border:1px solid rgba(113,255,0,0.2);border-radius:16px;background:rgba(113,255,0,0.04);display:flex;align-items:center;gap:12px;flex-wrap:wrap;';
      box.innerHTML = '<div style="flex:1;min-width:200px;"><div style="font-size:14px;font-weight:900;color:#fff;">' + esc(label) + ' on SOKONI</div>'
        + '<div style="font-size:12px;color:rgba(255,255,255,0.5);">Apply once — SOKONI reviews your application; after approval you get your business dashboard and appear here.</div></div>'
        + '<button type="button" style="padding:10px 18px;background:#71ff00;color:#000;border:0;border-radius:10px;font-weight:800;cursor:pointer;">Apply</button>';
      box.querySelector('button').addEventListener('click', hubRegister(cat, label.toLowerCase()));
      panel.appendChild(box);
    });
  }

  /* Re-render the contained panels once, so the old localStorage views are not left on screen. */
  function rerender() {
    try { G.renderBookings(); } catch (e) {} try { G.renderFleetManager(); } catch (e) {} try { addApplyCards(); } catch (e) {}
    try { mountVehicles(); } catch (e) {}
    /* the seller's own listings need the Auth session, which may land after this runs */
    try { if (G.firebase && G.firebase.auth) G.firebase.auth().onAuthStateChanged(function (u) { if (u && G.SokoniVehicles) G.SokoniVehicles.mountMine(d.getElementById('skVehMine')); }); } catch (e) {}
  }
  if (d.readyState === 'loading') d.addEventListener('DOMContentLoaded', rerender); else rerender();
  G.__carhubContained = true;
})(window);
