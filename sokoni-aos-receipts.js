/* ============================================================================
   AdminOS — Finance → Receipts (owner 2026-10-03)
   ----------------------------------------------------------------------------
   READ-ONLY view of the platform transaction receipts (functions/transaction-receipts.js).
   • Search: receipt number, payment reference, booking / quote / order id, buyer uid, provider uid — through the
     callable adminSearchReceipts, which requires the admin claim and AUDITS every lookup (adminAudit 'receipt_view').
     Firestore rules deny raw reads of transactionReceipts to every client, admins included.
   • Shows header, money position (paid / held / released / refunded, SOKONI fee, provider share, deductions) and the
     immutable event history. Nothing here can change a receipt or an event.
   • Super Admin only: "Retry failed receipt writes" → adminRetryReceiptFailures (replays queued receipt writes; it never
     re-runs a payment — it completes a missing document step for an already-confirmed transaction). Audited server-side.
   Self-contained: it loads the first time its panel is shown, so sokoni-aos.js needs no change.
   ============================================================================ */
(function (W) {
  'use strict';
  var PANEL = 'panel-receipts';
  var FIELDS = [
    ['receiptNo', 'Receipt number'], ['paymentRef', 'Payment reference'], ['sourceId', 'Booking / quote / order ID'],
    ['clientUid', 'Buyer (uid)'], ['counterpartyId', 'Provider / seller (uid)'],
  ];
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); };
  var kes = function (c) { return (c == null || !isFinite(Number(c))) ? '—' : 'KES ' + (Number(c) / 100).toLocaleString('en-KE', { minimumFractionDigits: 0, maximumFractionDigits: 2 }); };
  var when = function (v) {
    if (!v) return '—';
    var ms = typeof v === 'number' ? v : (v._seconds ? v._seconds * 1000 : (v.seconds ? v.seconds * 1000 : Date.parse(v)));
    return isFinite(ms) ? new Date(ms).toLocaleString('en-KE') : '—';
  };
  var STATUS = { paid_held: 'Paid — held', partially_released: 'Partly released', released: 'Released', partially_refunded: 'Partly refunded', refunded: 'Refunded', paid: 'Paid' };
  var TAX = { provider_fiscal_invoice: "Provider's eTIMS invoice", not_vat_registered: 'Provider not VAT-registered', unknown: 'Not recorded' };

  function callable (name) { return W.firebase.functions().httpsCallable(name); }

  function render (host) {
    host.innerHTML =
      '<div class="panel-toolbar"><h2>Receipts</h2></div>' +
      '<p style="font-size:12px;color:var(--aos-muted,#9aa);margin:0 0 10px">Read-only financial history. Every lookup is recorded in the audit log.</p>' +
      '<form id="aosRcForm" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:12px">' +
        '<select id="aosRcField" aria-label="Search by">' + FIELDS.map(function (f) { return '<option value="' + f[0] + '">' + esc(f[1]) + '</option>'; }).join('') + '</select>' +
        '<input id="aosRcValue" type="search" required maxlength="160" placeholder="Value" aria-label="Search value" style="min-width:220px;flex:1">' +
        '<button class="aos-btn-sm" type="submit">Search</button>' +
        '<button class="aos-btn-sm" type="button" id="aosRcRetry" hidden>Retry failed receipt writes</button>' +
      '</form>' +
      '<div id="aosRcOut" aria-live="polite"><div style="font-size:13px;color:var(--aos-muted,#9aa)">Search to see receipts.</div></div>';
    var form = host.querySelector('#aosRcForm');
    form.addEventListener('submit', function (e) { e.preventDefault(); search(host); });
    showRetryIfSuperAdmin(host);
  }

  async function showRetryIfSuperAdmin (host) {
    try {
      var u = W.firebase.auth().currentUser; if (!u) return;
      var t = await u.getIdTokenResult();
      if (t && t.claims && t.claims.superAdmin === true) {
        var b = host.querySelector('#aosRcRetry'); b.hidden = false;
        b.addEventListener('click', async function () {
          b.disabled = true; var out = host.querySelector('#aosRcOut');
          try {
            var r = (await callable('adminRetryReceiptFailures')({})).data || {};
            out.insertAdjacentHTML('afterbegin', '<div class="aos-note" style="margin-bottom:8px">Retry finished — resolved ' + esc(r.resolved || 0) + ', still failing ' + esc(r.stillFailing || 0) + ', not replayable ' + esc(r.notReplayable || 0) + ' (scanned ' + esc(r.scanned || 0) + ').</div>');
          } catch (err) { out.insertAdjacentHTML('afterbegin', '<div class="aos-note" style="margin-bottom:8px">Retry could not run: ' + esc((err && err.message) || 'error') + '</div>'); }
          b.disabled = false;
        });
      }
    } catch (_) { /* no claim — button stays hidden */ }
  }

  async function search (host) {
    var field = host.querySelector('#aosRcField').value;
    var value = host.querySelector('#aosRcValue').value.trim();
    var out = host.querySelector('#aosRcOut');
    if (!value) return;
    out.innerHTML = '<div class="aos-spinner"><div></div></div>';
    var q = {}; q[field] = value;
    var r;
    try { r = (await callable('adminSearchReceipts')(q)).data || {}; }
    catch (err) {
      out.innerHTML = '<div class="aos-note">Receipts could not be loaded (' + esc((err && err.code) || 'error') + '). This is not an empty result — try again.</div>';
      return;
    }
    var rows = Array.isArray(r.receipts) ? r.receipts : [];
    if (!rows.length) { out.innerHTML = '<div style="font-size:13px">No receipt matches that ' + esc((FIELDS.find(function (f) { return f[0] === field; }) || [0, 'value'])[1].toLowerCase()) + '.</div>'; return; }
    out.innerHTML = rows.map(card).join('');
  }

  function card (x) {
    var events = (x.events || []).slice().sort(function (a, b) { return String(a.at || '').localeCompare(String(b.at || '')); });
    var links = x.links || {};
    var linkTxt = Object.keys(links).map(function (k) { return esc(k) + ': ' + esc(links[k]); }).join(' · ');
    return '<details class="aos-card" style="margin-bottom:10px;padding:10px 12px">' +
      '<summary style="cursor:pointer;display:flex;flex-wrap:wrap;gap:10px;align-items:center">' +
        '<strong>' + esc(x.receiptNo || x.receiptId) + '</strong>' +
        '<span>' + esc(x.kind) + ' ' + esc(x.sourceId) + '</span>' +
        '<span>' + kes(x.paidCents) + '</span>' +
        '<span class="aos-pill">' + esc(STATUS[x.status] || x.status || '—') + '</span>' +
        '<span style="color:var(--aos-muted,#9aa)">' + esc(when(x.issuedAt)) + '</span>' +
      '</summary>' +
      '<dl style="display:grid;grid-template-columns:minmax(140px,max-content) 1fr;gap:4px 12px;font-size:13px;margin:10px 0">' +
        dt('Buyer', x.clientUid) + dt('Provider / seller', (x.counterpartyName ? x.counterpartyName + ' · ' : '') + (x.counterpartyId || '—')) +
        dt('Service', x.serviceLabel) + dt('Quoted', kes(x.quotedCents), true) + dt('Paid', kes(x.paidCents), true) +
        dt('Held', kes(x.heldCents), true) + dt('Released', kes(x.releasedCents), true) + dt('Refunded', kes(x.refundedCents), true) +
        dt('SOKONI fee', kes(x.platformFeeCents), true) + dt('Provider share', kes(x.providerNetCents), true) +
        (x.deductionsCents ? dt('Deductions (not commission)', kes(x.deductionsCents), true) : '') +
        dt('Payment method', x.method || '—') + dt('Payment reference', x.paymentRef) + dt('Provider reference', x.providerRef) +
        dt('Tax treatment', TAX[x.taxTreatment] || x.taxTreatment || '—') + (linkTxt ? dt('Links', linkTxt, true) : '') +
      '</dl>' +
      '<div style="font-size:12px;font-weight:700;margin-top:6px">History (immutable)</div>' +
      '<table class="aos-table" style="width:100%;font-size:12px"><thead><tr><th>When</th><th>Event</th><th>Amount</th><th>Fee</th><th>Provider</th><th>Detail</th></tr></thead><tbody>' +
      (events.length ? events.map(function (e) {
        var ded = (e.deductions || []).map(function (d) { return esc(d.kind.replace(/_/g, ' ')) + ' ' + kes(d.amountCents); }).join(', ');
        return '<tr><td>' + esc(when(e.at)) + '</td><td>' + esc(e.type) + (e.milestoneId ? ' (' + esc(e.milestoneId) + ')' : '') + '</td><td>' + kes(e.amountCents) + '</td><td>' +
          (e.platformFeeCents != null ? kes(e.platformFeeCents) : '—') + '</td><td>' + (e.providerNetCents != null ? kes(e.providerNetCents) : '—') + '</td><td>' +
          esc(e.reason || '') + (ded ? (e.reason ? ' · ' : '') + ded : '') + '</td></tr>';
      }).join('') : '<tr><td colspan="6">No events recorded.</td></tr>') +
      '</tbody></table></details>';
  }
  function dt (k, v, raw) { return '<dt style="color:var(--aos-muted,#9aa)">' + esc(k) + '</dt><dd style="margin:0">' + (raw ? (v == null ? '—' : v) : esc(v == null || v === '' ? '—' : v)) + '</dd>'; }

  function boot () {
    var host = document.getElementById(PANEL);
    if (!host) return;
    var loaded = false;
    var load = function () { if (!loaded && !host.hidden) { loaded = true; render(host); } };
    new MutationObserver(load).observe(host, { attributes: true, attributeFilter: ['hidden'] });
    load();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
  W.SokoniAOSReceipts = { _card: card, _esc: esc, _kes: kes };
})(window);
