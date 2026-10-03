/* AdminOS › Construction (sokoni-f3, 2026-10-03) — operational visibility for the Construction vertical inside the ONE
   canonical admin-os.html. READ-ONLY by design: every decision goes through its existing authority —
   applications → AdminOS › Applications (applicationDecide), RFQs → rfqDispatch, leads → contactRequests lifecycle,
   rentals → the marketplace rental callables. This module never writes. Reads rely on admin read rules
   (applications, rfqs, rfqRecipients, rfqQuotes, b2bLeads, contactRequests, rentalProducts, rentalBookings — combined
   rules candidate); a denied read is shown as an error, never as an empty list. */
(function (global) {
  'use strict';
  var CATS = {
    'contractor': 'Contractors', 'construction-company': 'Construction companies', 'hardware': 'Material suppliers',
    'welding-fabrication': 'Welders & fabricators', 'equipment-rental': 'Equipment providers', 'construction-services': 'Labour & site services',
    'construction-transport': 'Haulage', 'construction-architect': 'Architects / engineers / QS', 'architect': 'Architects (legacy id)',
  };
  var TABS = [['applications', 'Applications'], ['rfqs', 'RFQs'], ['leads', 'Leads'], ['leadfees', 'Lead fees'], ['rentals', 'Rentals']];
  var state = { tab: 'applications', catFilter: '' };

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function ms(t) { return t == null ? 0 : typeof t === 'number' ? t : t.toMillis ? t.toMillis() : t.seconds ? t.seconds * 1000 : Date.parse(t) || 0; }
  function when(t) { var m = ms(t); return m ? new Date(m).toLocaleString('en-KE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'; }
  function kes(n) { var v = Number(n); return n != null && isFinite(v) ? 'KES ' + v.toLocaleString('en-KE') : '—'; }
  function db() { return global.firebase.firestore(); }
  function body() { return document.getElementById('constructionAdminBody'); }
  function errBox(what, e) { return '<div class="aos-empty">Couldn\'t load ' + esc(what) + ' — ' + esc((e && e.message) || 'error') + '. This is not an empty list. <button type="button" class="aos-btn-sm" data-con-retry>Try again</button></div>'; }
  function tabs() {
    return '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px" role="tablist">' + TABS.map(function (t) {
      return '<button type="button" class="aos-btn-sm" role="tab" data-con-tab="' + t[0] + '"' + (state.tab === t[0] ? ' aria-current="true" style="font-weight:800"' : '') + '>' + esc(t[1]) + '</button>';
    }).join('') + '</div>';
  }
  function frame(html) { var b = body(); if (b) b.innerHTML = tabs() + html; }
  function table(head, rows) { return rows.length ? '<table class="aos-table"><thead><tr>' + head.map(function (h) { return '<th>' + esc(h) + '</th>'; }).join('') + '</tr></thead><tbody>' + rows.join('') + '</tbody></table>' : '<div class="aos-empty">Nothing here yet.</div>'; }

  function loadApplications() {
    frame('<div class="aos-spinner"><div></div></div>');
    db().collection('applications').where('hub', '==', 'construction').limit(300).get().then(function (snap) {
      var all = snap.docs.map(function (d) { return Object.assign({ _id: d.id }, d.data()); }).sort(function (a, b) { return ms(b.createdAt) - ms(a.createdAt); });
      var counts = {}; all.forEach(function (a) { counts[a.category] = (counts[a.category] || 0) + 1; });
      var chips = '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px"><button type="button" class="aos-btn-sm" data-con-cat="">All (' + all.length + ')</button>' +
        Object.keys(CATS).filter(function (k) { return counts[k]; }).map(function (k) { return '<button type="button" class="aos-btn-sm" data-con-cat="' + esc(k) + '">' + esc(CATS[k]) + ' (' + counts[k] + ')</button>'; }).join('') + '</div>';
      var list = state.catFilter ? all.filter(function (a) { return a.category === state.catFilter; }) : all;
      var rows = list.slice(0, 150).map(function (a) {
        var det = a.details && typeof a.details === 'object' ? Object.keys(a.details).slice(0, 6).map(function (k) { return '<div class="aos-muted">' + esc(k) + ': ' + esc(String(a.details[k]).slice(0, 120)) + '</div>'; }).join('') : '';
        return '<tr><td><b>' + esc(a.name || '—') + '</b><div class="aos-muted">' + esc(CATS[a.category] || a.categoryLabel || a.category || '—') + '</div></td>'
          + '<td>' + det + '</td><td><span class="status-badge">' + esc(a.status || '—') + '</span></td><td class="aos-muted">' + esc(when(a.createdAt || a.submittedAt)) + '</td>'
          + '<td><button type="button" class="aos-btn-sm" data-con-user="' + esc(a.uid || '') + '">Applicant</button></td></tr>';
      });
      frame('<div class="aos-muted" style="margin-bottom:8px">Approve, reject or request information in <b>AdminOS › Applications</b> — each declared trade is approved separately. This view is read-only.</div>'
        + chips + table(['Applicant', 'Declared (AdminOS verifies)', 'Status', 'Submitted', ''], rows));
    }).catch(function (e) { frame(errBox('construction applications', e)); });
  }

  function loadRfqs() {
    frame('<div class="aos-spinner"><div></div></div>');
    db().collection('rfqs').limit(200).get().then(function (snap) {
      var rows = snap.docs.map(function (d) { return d.data(); }).sort(function (a, b) { return (b.createdAtMs || 0) - (a.createdAtMs || 0); }).slice(0, 150).map(function (r) {
        return '<tr><td><b>' + esc(r.title || '—') + '</b><div class="aos-muted">' + esc(r.rfqId) + '</div></td>'
          + '<td>' + esc(r.buyerType === 'individual' ? 'Individual' : 'Business') + '<div class="aos-muted">' + esc(r.buyerName || '—') + '</div></td>'
          + '<td class="aos-muted">' + esc(r.category || r.mode || '—') + ' · ' + esc((r.recipientIds || []).length) + ' supplier(s)</td>'
          + '<td>' + esc(r.deliveryLocation || '—') + '</td><td><span class="status-badge">' + esc(r.status || '—') + '</span>' + (r.checkout ? '<div class="aos-muted">checkout: ' + esc(r.checkout) + '</div>' : '') + '</td>'
          + '<td>' + (r.acceptedQuote ? esc(kes(r.acceptedQuote.totalKES)) : '—') + '</td><td class="aos-muted">' + esc(when(r.createdAtMs)) + '</td>'
          + '<td><button type="button" class="aos-btn-sm" data-con-rfq="' + esc(r.rfqId) + '">Open</button></td></tr>';
      });
      frame(table(['RFQ', 'Buyer', 'Category / reach', 'Deliver to', 'Status', 'Accepted', 'Created', ''], rows));
    }).catch(function (e) { frame(errBox('RFQs', e)); });
  }

  function openRfq(id) {
    frame('<div class="aos-spinner"><div></div></div>');
    Promise.all([db().collection('rfqs').doc(id).get(), db().collection('rfqRecipients').where('rfqId', '==', id).limit(20).get(),
      db().collection('b2bLeads').where('rfqId', '==', id).limit(20).get()]).then(function (res) {
      var r = res[0].exists ? res[0].data() : {};
      var recips = res[1].docs.map(function (d) { return d.data(); });
      var leads = res[2].docs.map(function (d) { return d.data(); });
      var items = (r.items || []).map(function (i) { return '<li>' + esc(i.name) + ' × ' + esc(i.qty) + ' ' + esc(i.unit || '') + (i.targetPriceKES ? ' (target ' + esc(kes(i.targetPriceKES)) + ')' : '') + '</li>'; }).join('');
      var rec = recips.map(function (x) { return '<tr><td>' + esc(x.supplierName || x.supplierBusinessId) + '</td><td><span class="status-badge">' + esc(x.status) + '</span></td><td class="aos-muted">' + esc(when(x.receivedAtMs)) + '</td></tr>'; });
      var ld = leads.map(function (l) { return '<tr><td class="aos-muted">' + esc(l.commercialEventId || '—') + '</td><td>' + esc(l.hub || 'b2b') + ' · ' + esc(l.tier || 'standard') + '</td><td>' + esc(l.month || '—') + '</td><td>' + (l.priceKES != null ? esc(kes(l.priceKES)) : '— (priced at invoice)') + '</td></tr>'; });
      frame('<button type="button" class="aos-btn-sm" data-con-tab="rfqs">&larr; RFQs</button><h3 style="margin:10px 0 4px">' + esc(r.title || id) + '</h3>'
        + '<div class="aos-muted">' + esc(r.buyerType === 'individual' ? 'Individual buyer' : 'Business buyer') + ' · ' + esc(r.deliveryLocation || '—') + ' · needed by ' + esc(r.neededBy || '—') + ' · <b>' + esc(r.status || '—') + '</b></div>'
        + (items ? '<ul>' + items + '</ul>' : '') + (r.notes ? '<div>' + esc(r.notes) + '</div>' : '')
        + (r.acceptedQuote ? '<div style="margin-top:8px">Accepted: ' + esc(r.acceptedQuote.supplierName) + ' · ' + esc(kes(r.acceptedQuote.totalKES)) + ' (VAT ' + esc(r.acceptedQuote.vatRate) + '% as declared) · checkout: ' + esc(r.checkout || '—') + '</div>' : '')
        + '<h4 style="margin:12px 0 4px">Recipients</h4>' + table(['Supplier', 'Status', 'Received'], rec)
        + '<h4 style="margin:12px 0 4px">Lead obligations (one per supplier — commercialEventId)</h4>' + table(['Commercial event', 'Hub · tier', 'Month', 'Price'], ld));
    }).catch(function (e) { frame(errBox('this RFQ', e)); });
  }

  function loadLeads() {
    frame('<div class="aos-spinner"><div></div></div>');
    db().collection('contactRequests').limit(300).get().then(function (snap) {
      var rows = snap.docs.map(function (d) { return d.data(); }).sort(function (a, b) { return ms(b.createdAt) - ms(a.createdAt); }).slice(0, 150).map(function (q) {
        return '<tr><td>' + esc(q.productName || q.productId || '—') + '</td><td>' + esc(q.sellerName || '—') + '</td>'
          + '<td><span class="status-badge">' + esc(q.status === 'pending' ? 'New' : q.status === 'responded' ? 'Contacted' : (q.status || 'New')) + '</span></td>'
          + '<td class="aos-muted">' + esc(when(q.createdAt)) + '</td><td class="aos-muted">' + esc(q.source || '—') + '</td></tr>';
      });
      frame('<div class="aos-muted" style="margin-bottom:8px">Product-page enquiries (the ONE lead record, all hubs). Sellers move them through the lead lifecycle; buyers can cancel.</div>'
        + table(['Product', 'Seller', 'Lead stage', 'Created', 'Source'], rows));
    }).catch(function (e) { frame(errBox('leads', e)); });
  }

  function loadLeadFees() {
    frame('<div class="aos-spinner"><div></div></div>');
    db().collection('b2bLeads').where('hub', '==', 'construction').limit(300).get().then(function (snap) {
      var all = snap.docs.map(function (d) { return d.data(); });
      var rows = all.slice(0, 150).map(function (l) {
        return '<tr><td class="aos-muted">' + esc(l.commercialEventId || '—') + '</td><td>' + esc(l.supplierBusinessId || '—') + '</td><td>' + esc(l.buyerType || '—') + '</td>'
          + '<td>' + esc(l.tier || 'standard') + '</td><td>' + esc(l.month || '—') + '</td><td>' + (l.priceKES != null ? esc(kes(l.priceKES)) : '— (priced at invoice)') + '</td></tr>';
      });
      frame('<div class="aos-muted" style="margin-bottom:8px">Construction lead obligations. One per commercial event; the monthly lead invoice (commercial authority) bills them. The provider pays — never the buyer.</div>'
        + table(['Commercial event', 'Supplier business', 'Buyer type', 'Tier', 'Month', 'Price'], rows));
    }).catch(function (e) { frame(errBox('lead fees', e)); });
  }

  function loadRentals() {
    frame('<div class="aos-spinner"><div></div></div>');
    Promise.all([db().collection('rentalBookings').limit(200).get(), db().collection('rentalProducts').limit(200).get()]).then(function (res) {
      var bookings = res[0].docs.map(function (d) { return Object.assign({ _id: d.id }, d.data()); }).sort(function (a, b) { return ms(b.createdAt) - ms(a.createdAt); });
      var products = {}; res[1].docs.forEach(function (d) { products[d.id] = d.data(); });
      var rows = bookings.slice(0, 150).map(function (b) {
        var p = products[b.rentalProductId] || {};
        return '<tr><td>' + esc(p.title || b.rentalProductId || '—') + '</td><td class="aos-muted">' + esc(b.shopId || '—') + '</td>'
          + '<td>' + esc(when(b.startDate)) + ' → ' + esc(when(b.endDate)) + '</td><td>' + esc(kes(b.totalAmount)) + '</td><td>' + esc(kes(b.depositAmount)) + '</td>'
          + '<td><span class="status-badge">' + esc(b.status || '—') + '</span></td></tr>';
      });
      frame('<div class="aos-muted" style="margin-bottom:8px">Equipment listings: ' + res[1].size + '. Rental payment opens with the rental payment purpose (IntaSend) — no booking here is marked paid without it.</div>'
        + table(['Equipment', 'Shop', 'Period', 'Total', 'Deposit', 'Status'], rows));
    }).catch(function (e) { frame(errBox('rentals', e)); });
  }

  var LOADERS = { applications: loadApplications, rfqs: loadRfqs, leads: loadLeads, leadfees: loadLeadFees, rentals: loadRentals };
  function load(tab) { if (tab) state.tab = tab; (LOADERS[state.tab] || loadApplications)(); }

  function onClick(ev) {
    var t = ev.target; if (!t || !t.closest || !t.closest('#panel-construction')) return;
    var b;
    if ((b = t.closest('[data-con-tab]'))) { load(b.getAttribute('data-con-tab')); return; }
    if (t.closest('[data-con-retry]')) { load(); return; }
    if ((b = t.closest('[data-con-cat]'))) { state.catFilter = b.getAttribute('data-con-cat'); loadApplications(); return; }
    if ((b = t.closest('[data-con-rfq]'))) { openRfq(b.getAttribute('data-con-rfq')); return; }
    if ((b = t.closest('[data-con-user]'))) { var u = b.getAttribute('data-con-user'); if (u && global.SokoniAOS && global.SokoniAOS.viewUser) global.SokoniAOS.viewUser(u); return; }
  }
  if (typeof document !== 'undefined') document.addEventListener('click', onClick);
  global.SokoniAOSConstruction = { load: load, CATS: CATS, TABS: TABS };
})(typeof window !== 'undefined' ? window : this);
