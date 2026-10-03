/* ============================================================================
   SokoniReceipts — the platform transaction receipts, read-only views (owner decision 2026-10-03; sokoni-2f contract v2).
   ONE renderer for the buyer (Account → Payments → Receipts, receipts.html) and the provider (provider dashboard →
   Finance → Receipts). Data: the callable myTransactionReceipts, which returns ONLY the caller's own receipts (as client
   or as provider). Nothing here computes money: every figure is the server's receipt position; an absent value is "—".
     SokoniReceipts.mount(el, { role: 'client' | 'provider' | 'any' })
   ========================================================================== */
(function (G) {
  'use strict';
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); };
  var kes = function (c) { return c == null || !isFinite(Number(c)) ? '—' : 'KES ' + (Math.round(Number(c)) / 100).toLocaleString('en-KE', { maximumFractionDigits: 2 }); };
  var when = function (ms) { var n = Number(ms); return n ? new Date(n).toLocaleString('en-KE', { dateStyle: 'medium', timeStyle: 'short' }) : '—'; };
  var STATUS = { paid: 'Paid', paid_held: 'Paid — held by SOKONI', partially_released: 'Partly released', released: 'Completed — released',
    partially_refunded: 'Partly refunded', refunded: 'Refunded' };
  var KIND = { service_booking: 'Service booking', quote: 'Accepted quote', order: 'Order', b2b_order: 'Business order', enrolment: 'Enrolment' };
  var TAX = { provider_fiscal_invoice: 'Provider issues the tax invoice (eTIMS)', not_vat_registered: 'Provider not VAT-registered', unknown: '—' };
  var EV = { paid: 'Payment received', released: 'Released after completion', refunded: 'Refunded', adjusted: 'Adjusted' };

  function card(r, role) {
    var prov = role === 'provider';
    /* r.events: the immutable history from myTransactionReceipts (2f bb341b1), oldest first. An empty list is genuine (an event write may still be queued for retry). */
    var evs = Array.isArray(r.events) ? r.events : [];
    var hist = evs.length ? '<ul style="margin:6px 0 0;padding-left:18px">' + evs.map(function (e) {
          var ded = Array.isArray(e.deductions) && e.deductions.length ? ' · deductions ' + e.deductions.map(function (d) { return esc(d.kind) + ' ' + esc(kes(d.amountCents)); }).join(', ') + ' (not commission)' : '';
          return '<li>' + esc(EV[e.type] || e.type) + ' · ' + esc(kes(e.amountCents)) + (e.platformFeeCents != null ? ' · SOKONI fee ' + esc(kes(e.platformFeeCents)) : '') + ded + (e.reason ? ' · ' + esc(e.reason) : '') + ' · ' + esc(when(e.at)) + '</li>';
        }).join('') + '</ul>' : '<div style="opacity:.6">No history entries.</div>';
    var rows = [
      ['Transaction', (KIND[r.kind] || r.kind || '—') + ' · #' + String(r.sourceId || '').slice(-8)],
      [prov ? 'Client' : 'Provider', prov ? 'SOKONI customer' : (r.counterpartyName || '—')],
      ['Service', r.serviceLabel || '—'],
      ['Payment method', r.method || '—'],
      ['Payment reference', r.paymentRef || '—'],
      ['Paid', kes(r.paidCents)], ['Held by SOKONI', kes(r.heldCents)], ['Released', kes(r.releasedCents)], ['Refunded', kes(r.refundedCents)],
      ['SOKONI fee', kes(r.platformFeeCents)],
    ];
    if (prov) rows.push(['Your settlement', kes(r.providerNetCents)]);
    rows.push(['Tax treatment', TAX[r.taxTreatment] || '—'], ['Issued', when(r.issuedAt)]);
    return '<article class="rc-card" style="border:1px solid rgba(255,255,255,.1);border-radius:14px;padding:14px 16px;margin-bottom:12px">'
      + '<div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap"><strong>Receipt ' + esc(r.receiptNo || '—') + '</strong><span>' + esc(STATUS[r.status] || r.status || '—') + '</span></div>'
      + '<dl style="display:grid;grid-template-columns:auto 1fr;gap:4px 14px;margin:10px 0 0;font-size:13px">' + rows.map(function (x) { return '<dt style="opacity:.6">' + esc(x[0]) + '</dt><dd style="margin:0">' + esc(x[1]) + '</dd>'; }).join('') + '</dl>'
      + '<details style="margin-top:8px;font-size:13px"><summary>History</summary>' + hist + '</details></article>';
  }

  async function mount(el, opts) {
    if (!el) return;
    var role = (opts && opts.role) || 'any';
    el.innerHTML = '<div style="opacity:.6;padding:12px 0">Loading receipts…</div>';
    for (var i = 0; i < 80 && !(G.firebase && G.firebase.functions && G.firebase.auth); i++) await new Promise(function (r) { setTimeout(r, 100); });
    if (!(G.firebase && G.firebase.functions)) { el.innerHTML = '<div>Receipts could not load — please refresh.</div>'; return; }
    if (!G.firebase.auth().currentUser) { el.innerHTML = '<div><a href="login.html?next=' + encodeURIComponent(G.location.pathname) + '">Sign in</a> to see your receipts.</div>'; return; }
    var res;
    try { res = (await G.firebase.functions().httpsCallable('myTransactionReceipts')({ limit: 50 })).data || {}; }
    catch (e) { el.innerHTML = '<div>We couldn’t load your receipts just now. This is not an empty list — please try again.</div>'; return; }
    var list = (res.receipts || []).filter(function (r) { return role === 'any' || r.role === role; })
      .sort(function (a, b) { return (Number(b.issuedAt) || 0) - (Number(a.issuedAt) || 0); });
    el.innerHTML = list.length ? list.map(function (r) { return card(r, r.role); }).join('') : '<div style="opacity:.7;padding:12px 0">No receipts yet.</div>';
  }
  G.SokoniReceipts = { mount: mount, _card: card };
})(window);
