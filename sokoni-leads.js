/* ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
   SokoniLeads — service leads & quotes on the web (Tech Hub slice 4F, 2026-10-03)
   ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
   Server authority: functions/service-leads.js (providerDispatch ops lead*), docs/SERVICE_LEADS.md. This module renders
   and calls; it never decides a state or a price:
     ask(opts)              customer → leadCreate → opens the lead's conversation (messages.html?tx=service_lead)
     mountMine(el)          customer: my requests + quotes → accept / decline / ask to clarify / book / message / close
     mountProvider(el, o)   provider: leads → open (viewed) / decline / send quote / message
   "Book" on an accepted quote opens SokoniBookService with the leadId; bookingCreateService takes the price from the
   quote server-side. Nothing here says "sent" / "accepted" until the server answered.
   G7 (2026-10-03): the brief's lead / quote stages come from the server (l.stage / l.quoteStage — never derived here);
   an itemised quote is SENT as quantity / unit rate / discount / stated tax and the SERVER computes the total (no client
   total is sent); accept carries the quote version the customer is looking at.
   ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════ */
(function (G) {
  'use strict';
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var kes = function (c) { return 'KES ' + (Math.round(Number(c) || 0) / 100).toLocaleString('en-KE', { maximumFractionDigits: 2 }); };
  var call = function (op, data) { return G.firebase.functions().httpsCallable('providerDispatch')(Object.assign({ op: op }, data || {})).then(function (r) { return r.data; }); };
  var LABEL = { created: 'Sent', viewed: 'Seen by provider', qualified: 'Provider is preparing', quote_requested: 'Quote requested', quote_sent: 'Quote received',
    clarification_requested: 'You asked a question', quote_accepted: 'Quote accepted — book a time', quote_declined: 'Quote declined', declined: 'Provider declined',
    lost: 'Closed by provider', converted: 'Booked', closed: 'Cancelled' };
  var PLABEL = { created: 'New', viewed: 'Contacted', qualified: 'Qualified', quote_requested: 'Quote requested', quote_sent: 'Quote sent', clarification_requested: 'Negotiating',
    quote_accepted: 'Won — quote accepted', quote_declined: 'Lost — quote declined', declined: 'Declined', lost: 'Lost', converted: 'Won — booked', closed: 'Cancelled by customer' };
  var QLABEL = { draft: 'Draft (only you can see it)', sent: 'Sent', customer_viewed: 'Viewed by customer', negotiating: 'Negotiating', accepted: 'Accepted',
    declined: 'Declined', expired: 'Expired', cancelled: 'Withdrawn' };
  /* the server's derived stage wins where it says "expired" (a lapsed quote / an idle request) */
  var statusLabel = function (l, map) { return l.stage === 'expired' ? 'Expired' : (map[l.status] || l.status); };
  var MODE_LABEL = { WORKSHOP: 'At the workshop', ONSITE_SUPPORT: 'On-site', FIELD_SERVICE: 'Field service / site visit', PICKUP_DROP_OFF: 'Pickup & drop-off', REMOTE_SUPPORT: 'Remote' };
  var signedIn = function () { return !!(G.firebase && G.firebase.auth && G.firebase.auth().currentUser); };
  var msgUrl = function (id) { return 'messages.html?tx=service_lead&txId=' + encodeURIComponent(id); };
  var errText = function (e) { return (e && e.message) || 'Something went wrong — please try again.'; };

  /* ── a tiny modal (one at a time) ── */
  function modal(html) {
    close();
    var o = document.createElement('div'); o.id = 'skLeadModal'; o.setAttribute('role', 'dialog'); o.setAttribute('aria-modal', 'true');
    o.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px';
    o.innerHTML = '<div style="background:#111;color:#eee;border:1px solid #2a2a2a;border-radius:14px;max-width:440px;width:100%;padding:18px;font:14px/1.5 system-ui">' + html + '</div>';
    o.addEventListener('click', function (e) { if (e.target === o || (e.target.closest && e.target.closest('[data-lead-x]'))) close(); });
    document.body.appendChild(o);
    return o;
  }
  function close() { var m = document.getElementById('skLeadModal'); if (m && m.parentNode) m.parentNode.removeChild(m); }
  var inputCss = 'width:100%;box-sizing:border-box;background:#1a1a1a;border:1px solid #333;color:#eee;border-radius:8px;padding:9px;margin:6px 0';
  var btnCss = 'background:#71ff00;color:#000;border:0;border-radius:9px;padding:10px 14px;font-weight:800;cursor:pointer';
  var btn2Css = 'background:#222;color:#eee;border:1px solid #333;border-radius:9px;padding:9px 12px;cursor:pointer';

  /** Customer: ask a provider (optionally about one service). */
  function ask(opts) {
    var o = opts || {};
    if (!o.providerId) return;
    if (!signedIn()) { G.location.href = 'login.html?next=' + encodeURIComponent(G.location.pathname + G.location.search); return; }
    var m = modal('<div style="font-weight:800;font-size:16px;margin-bottom:4px">Ask ' + esc(o.providerName || 'the provider') + '</div>'
      + '<div style="opacity:.7;font-size:12px">Describe what you need. The provider can reply in SOKONI messages and send you a quote.</div>'
      + '<textarea id="skLeadMsg" rows="4" maxlength="1000" style="' + inputCss + '" placeholder="' + esc(o.placeholder || 'e.g. My Samsung A54 screen is cracked — how much and how long?') + '"></textarea>'
      + '<div id="skLeadErr" style="color:#ff6b6b;font-size:12px;min-height:16px"></div>'
      + '<div style="display:flex;gap:8px;justify-content:flex-end"><button type="button" data-lead-x style="' + btn2Css + '">Cancel</button><button type="button" id="skLeadSend" style="' + btnCss + '">Send request</button></div>');
    m.querySelector('#skLeadSend').addEventListener('click', function () {
      var b = this; var text = (m.querySelector('#skLeadMsg').value || '').trim();
      var err = m.querySelector('#skLeadErr');
      if (text.length < 5) { err.textContent = 'Describe what you need (a few words at least).'; return; }
      b.disabled = true; b.textContent = 'Sending…';
      call('leadCreate', { providerId: o.providerId, serviceId: o.serviceId || undefined, message: text, requestQuote: o.requestQuote === true || undefined }).then(function (r) {
        close(); G.location.href = msgUrl(r.leadId);
      }).catch(function (e) { b.disabled = false; b.textContent = 'Send request'; err.textContent = errText(e); });
    });
  }

  /* ── customer: my requests ── */
  function quoteBlock(q, qStage) {
    if (!q) return '';
    var lines = (Array.isArray(q.breakdown) && q.breakdown.length > 1) ? '<div style="font-size:12px;margin-top:6px">' + q.breakdown.map(function (b) {
      return '<div style="display:flex;justify-content:space-between;gap:8px"><span>' + esc(b.label) + '</span><span>' + esc(kes(b.amount)) + '</span></div>'; }).join('') + '</div>' : '';
    return '<div style="margin-top:8px;padding:10px;border:1px solid #2f3a20;border-radius:10px;background:rgba(113,255,0,.05)">'
      + '<div style="display:flex;justify-content:space-between;gap:8px"><b>Quote v' + esc(q.version) + (qStage && QLABEL[qStage] ? ' · ' + esc(QLABEL[qStage]) : '') + '</b><b style="color:#71ff00">' + esc(kes(q.amountCents)) + '</b></div>'
      + lines
      + (q.scope ? '<div style="font-size:13px;margin-top:4px"><b>Scope:</b> ' + esc(q.scope) + '</div>' : '')
      + (q.description ? '<div style="font-size:13px;margin-top:4px">' + esc(q.description) + '</div>' : '')
      + (q.paymentTerms && q.paymentTerms.text ? '<div style="font-size:12px;opacity:.75;margin-top:4px">' + esc(q.paymentTerms.text) + (q.paymentTerms.note ? ' — ' + esc(q.paymentTerms.note) : '') + '</div>' : '')
      + '<div style="font-size:12px;opacity:.7;margin-top:4px">' + esc(q.durationMins) + ' min' + (q.serviceMode ? ' · ' + esc(MODE_LABEL[q.serviceMode] || q.serviceMode) : '')
      + ' · valid until ' + esc(new Date(Number(q.validUntil)).toLocaleDateString('en-KE')) + '</div>' + (q.notes ? '<div style="font-size:12px;margin-top:4px">' + esc(q.notes) + '</div>' : '') + '</div>';
  }
  function mineCard(l) {
    var acts = [], expired = l.stage === 'expired';
    if (l.status === 'quote_sent' && !expired) acts.push(['accept', 'Accept quote', btnCss]);
    if (l.status === 'quote_sent') acts.push(['clarify', expired ? 'Ask for a new quote' : 'Ask a question', btn2Css], ['decline', 'Decline', btn2Css]);
    if (['created', 'viewed', 'qualified'].indexOf(l.status) > -1 && !expired) acts.push(['request_quote', 'Request a quote', btn2Css]);
    if (l.status === 'quote_accepted') acts.push(['book', 'Book a time', btnCss]);
    if (['converted', 'declined', 'quote_declined', 'closed', 'lost'].indexOf(l.status) === -1) acts.push(['close', 'Cancel request', btn2Css]);
    acts.push(['msg', '💬 Messages', btn2Css]);
    return '<div class="sk-lead" style="border:1px solid #262626;border-radius:12px;padding:12px;margin-bottom:10px">'
      + '<div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap"><b>' + esc(statusLabel(l, LABEL)) + '</b><span style="font-size:12px;opacity:.6">#' + esc(String(l.id).slice(-6)) + '</span></div>'
      + '<div style="font-size:13px;margin-top:4px;opacity:.85">“' + esc(l.message) + '”</div>' + quoteBlock(l.quote, l.quoteStage)
      + '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">' + acts.map(function (a) { return '<button type="button" data-lead-act="' + a[0] + '" data-lead-id="' + esc(l.id) + '" style="' + a[2] + '">' + esc(a[1]) + '</button>'; }).join('') + '</div></div>';
  }
  function mountMine(el) {
    if (!el) return Promise.resolve();
    el.innerHTML = '<div style="opacity:.6">Loading your requests…</div>';
    var byId = {};
    function load() {
      return call('leadListMine').then(function (r) {
        var list = (r && r.leads) || []; byId = {}; list.forEach(function (l) { byId[l.id] = l; });
        el.innerHTML = list.length ? list.map(mineCard).join('') : '<div style="opacity:.7">No service requests yet. Ask a provider from their listing or storefront.</div>';
        /* the customer now has the quote in front of them → Customer Viewed (server state, once per version, best-effort) */
        list.filter(function (l) { return l.status === 'quote_sent' && l.quoteStage === 'sent'; }).forEach(function (l) { call('leadViewQuote', { leadId: l.id }).catch(function () {}); });
      }).catch(function () { el.innerHTML = '<div style="opacity:.75">We couldn’t load your requests just now. This is not an empty list — please try again shortly.</div>'; });
    }
    if (!el.__leadBound) {
      el.__leadBound = true;
      el.addEventListener('click', function (e) {
        var b = e.target.closest ? e.target.closest('[data-lead-act]') : null; if (!b) return;
        var id = b.getAttribute('data-lead-id'), act = b.getAttribute('data-lead-act'), l = byId[id] || {};
        if (act === 'msg') { G.location.href = msgUrl(id); return; }
        if (act === 'book') {
          if (G.SokoniBookService && l.quote) G.SokoniBookService.open({ providerId: l.providerId, serviceId: l.quote.serviceId, leadId: id, providerName: '' });
          return;
        }
        var data = { leadId: id };
        var op = act === 'close' ? 'leadClose' : act === 'request_quote' ? 'leadRequestQuote' : 'leadRespond';
        if (op === 'leadRespond') data.action = act;
        /* accept names the version on screen — if the provider re-quoted meanwhile the server refuses and the list reloads */
        if (act === 'accept') { if (!l.quote) return; data.quoteVersion = l.quote.version; }
        if (act === 'clarify') { var q = G.prompt ? G.prompt('Your question for the provider:') : ''; if (!q) return; data.message = q; }
        b.disabled = true;
        call(op, data).then(load).catch(function (er) { b.disabled = false; G.alert && G.alert(errText(er)); if (act === 'accept') load(); });
      });
    }
    return load();
  }

  /* ── provider: leads ── */
  function provCard(l) {
    var acts = [], PRE = ['created', 'viewed', 'qualified', 'quote_requested', 'clarification_requested'], idle = l.stage === 'expired' && l.status !== 'quote_sent';
    if (!idle && PRE.concat(['quote_sent']).indexOf(l.status) > -1) acts.push(['quote', l.quoteDraft ? 'Continue draft' : (l.quote && !l.quote.cancelledAt ? 'Send a new quote' : 'Send a quote'), btnCss]);
    if (!idle && ['created', 'viewed'].indexOf(l.status) > -1) acts.push(['qualify', 'Mark qualified', btn2Css]);
    if (['quote_sent', 'clarification_requested'].indexOf(l.status) > -1) acts.push(['withdraw', 'Withdraw quote', btn2Css]);
    if (PRE.indexOf(l.status) > -1) acts.push(['decline', 'Decline', btn2Css]);
    if (PRE.concat(['quote_sent']).indexOf(l.status) > -1) acts.push(['lost', 'Mark lost', btn2Css]);
    acts.push(['msg', '💬 Message customer', btn2Css]);
    var rd = l.repairDetails;
    return '<div class="card" style="padding:12px 14px;margin-bottom:10px">'
      + '<div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap"><b>' + esc(statusLabel(l, PLABEL)) + '</b><span style="font-size:12px;opacity:.6">#' + esc(String(l.id).slice(-6)) + '</span></div>'
      + '<div style="font-size:13px;margin-top:4px">“' + esc(l.message) + '”</div>'
      + (rd ? '<div style="font-size:12px;opacity:.7;margin-top:4px">' + esc([rd.deviceType, rd.brand, rd.model].filter(Boolean).join(' · ')) + '</div>' : '')
      + quoteBlock(l.quote, l.quoteStage) + (l.quoteDraft ? '<div style="font-size:12px;opacity:.7;margin-top:6px">Draft saved · ' + esc(kes(l.quoteDraft.amountCents)) + ' (not sent)</div>' : '')
      + '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">' + acts.map(function (a) { return '<button type="button" data-plead-act="' + a[0] + '" data-lead-id="' + esc(l.id) + '" style="' + a[2] + '">' + esc(a[1]) + '</button>'; }).join('') + '</div></div>';
  }
  function quoteForm(l, o, onDone) {
    var svcs = (o.services && o.services()) || [];
    var modes = ((o.caps && o.caps()) || []).filter(function (c) { return MODE_LABEL[c]; });
    var dft = l.quoteDraft || {}, adj0 = (dft.adjustments || [])[0] || {}, tax0 = (dft.taxes || [])[0] || {};
    var num = function (c) { return c == null ? '' : String(Math.round(Number(c)) / 100); };
    var m = modal('<div style="font-weight:800;font-size:16px">Send a quote</div>'
      + '<label style="font-size:12px;opacity:.8">Service</label><select id="skQSvc" style="' + inputCss + '">' + svcs.map(function (s) { return '<option value="' + esc(s.id) + '"' + (dft.serviceId === s.id ? ' selected' : '') + '>' + esc(s.name) + '</option>'; }).join('') + '</select>'
      + '<div style="display:flex;gap:8px"><div style="flex:1"><label style="font-size:12px;opacity:.8">Quantity</label><input id="skQQty" type="number" min="1" step="1" value="' + esc(dft.quantity || 1) + '" style="' + inputCss + '"></div>'
      + '<div style="flex:2"><label style="font-size:12px;opacity:.8">Rate per unit (KES)</label><input id="skQAmt" type="number" min="1" step="1" value="' + esc(num(dft.unitRateCents)) + '" style="' + inputCss + '"></div></div>'
      + '<div style="display:flex;gap:8px"><div style="flex:2"><label style="font-size:12px;opacity:.8">Discount label (optional)</label><input id="skQAdjL" maxlength="60" value="' + esc(adj0.label || '') + '" style="' + inputCss + '"></div>'
      + '<div style="flex:1"><label style="font-size:12px;opacity:.8">Discount (KES)</label><input id="skQAdj" type="number" min="0" step="1" value="' + esc(adj0.amountCents ? num(-adj0.amountCents) : '') + '" style="' + inputCss + '"></div></div>'
      + '<div style="display:flex;gap:8px"><div style="flex:2"><label style="font-size:12px;opacity:.8">Tax you charge (optional, e.g. VAT)</label><input id="skQTaxL" maxlength="40" value="' + esc(tax0.label || '') + '" style="' + inputCss + '"></div>'
      + '<div style="flex:1"><label style="font-size:12px;opacity:.8">Rate %</label><input id="skQTax" type="number" min="0" max="30" step="0.01" value="' + esc(tax0.ratePct || '') + '" style="' + inputCss + '"></div></div>'
      + '<div style="font-size:11px;opacity:.65">SOKONI works out the total from these lines. Leave tax blank if you do not charge one — none is added for you.</div>'
      + '<label style="font-size:12px;opacity:.8">Scope of work</label><textarea id="skQScope" rows="2" maxlength="1000" style="' + inputCss + '">' + esc(dft.scope || '') + '</textarea>'
      + '<label style="font-size:12px;opacity:.8">What the price covers</label><input id="skQDesc" maxlength="500" value="' + esc(dft.description || '') + '" style="' + inputCss + '">'
      + '<label style="font-size:12px;opacity:.8">Payment note (optional)</label><input id="skQPay" maxlength="300" value="' + esc((dft.paymentTerms && dft.paymentTerms.note) || '') + '" style="' + inputCss + '">'
      + '<div style="font-size:11px;opacity:.65">Payment: paid in full through SOKONI when booked; held until the customer confirms completion with their PIN.</div>'
      + '<div style="display:flex;gap:8px"><div style="flex:1"><label style="font-size:12px;opacity:.8">Duration (min)</label><input id="skQDur" type="number" min="15" value="60" style="' + inputCss + '"></div>'
      + '<div style="flex:1"><label style="font-size:12px;opacity:.8">Valid for (days)</label><input id="skQDays" type="number" min="1" max="30" value="7" style="' + inputCss + '"></div></div>'
      + (modes.length ? '<label style="font-size:12px;opacity:.8">How</label><select id="skQMode" style="' + inputCss + '"><option value="">—</option>' + modes.map(function (c) { return '<option value="' + c + '">' + esc(MODE_LABEL[c]) + '</option>'; }).join('') + '</select>' : '')
      + '<div id="skQErr" style="color:#ff6b6b;font-size:12px;min-height:16px"></div>'
      + '<div style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap"><button type="button" data-lead-x style="' + btn2Css + '">Cancel</button><button type="button" id="skQDraft" style="' + btn2Css + '">Save draft</button><button type="button" id="skQSend" style="' + btnCss + '">Send quote</button></div>');
    if (!svcs.length) m.querySelector('#skQErr').textContent = 'Add a service first (Services → Rate cards) — a quote is for one of your services.';
    /* the request carries the LINES only — the server computes subtotal, tax and total (no client total is sent) */
    function payload() {
      var v = function (id) { var x = m.querySelector('#' + id); return x ? x.value : ''; };
      var rate = Math.round(Number(v('skQAmt')) * 100);
      if (!(rate >= 100)) { m.querySelector('#skQErr').textContent = 'Enter a rate of at least KES 1.'; return null; }
      var adj = Math.round(Number(v('skQAdj')) * 100), tax = Number(v('skQTax'));
      var d = { leadId: l.id, serviceId: v('skQSvc'), quantity: Math.max(1, Math.round(Number(v('skQQty')) || 1)), unitRateCents: rate,
        scope: v('skQScope'), description: v('skQDesc'), paymentTermsNote: v('skQPay'), durationMins: Number(v('skQDur')) || 60,
        validDays: Number(v('skQDays')) || 7, serviceMode: v('skQMode') || undefined };
      if (adj > 0) d.adjustments = [{ label: v('skQAdjL').trim() || 'Discount', amountCents: -adj }];
      if (tax > 0) { if (!v('skQTaxL').trim()) { m.querySelector('#skQErr').textContent = 'Name the tax you charge (e.g. VAT), or clear the rate.'; return null; } d.taxes = [{ label: v('skQTaxL').trim(), ratePct: tax }]; }
      return d;
    }
    function submit(op, b, idle, busy) {
      var d = payload(); if (!d) return;
      b.disabled = true; b.textContent = busy;
      call(op, d).then(function () { close(); onDone(); })
        .catch(function (e) { b.disabled = false; b.textContent = idle; m.querySelector('#skQErr').textContent = errText(e); });
    }
    m.querySelector('#skQSend').addEventListener('click', function () { submit('leadSendQuote', this, 'Send quote', 'Sending…'); });
    m.querySelector('#skQDraft').addEventListener('click', function () { submit('leadSaveQuoteDraft', this, 'Save draft', 'Saving…'); });
  }
  function mountProvider(el, o) {
    if (!el) return Promise.resolve();
    o = o || {};
    el.innerHTML = '<div style="opacity:.6;padding:12px 0">Loading leads…</div>';
    var byId = {};
    function load() {
      return call('leadListForProvider').then(function (r) {
        var list = (r && r.leads) || []; byId = {}; list.forEach(function (l) { byId[l.id] = l; });
        el.innerHTML = list.length ? list.map(provCard).join('') : '<div style="opacity:.7;padding:12px 0">No leads yet. Customers can ask you from your listing and storefront; each request appears here.</div>';
        /* opening the list marks new leads as seen — server-side state, best-effort */
        list.filter(function (l) { return l.status === 'created'; }).forEach(function (l) { call('leadMarkViewed', { leadId: l.id }).catch(function () {}); });
      }).catch(function () { el.innerHTML = '<div style="opacity:.75;padding:12px 0">We couldn’t load your leads just now. This is not an empty list — please try again shortly.</div>'; });
    }
    if (!el.__pleadBound) {
      el.__pleadBound = true;
      el.addEventListener('click', function (e) {
        var b = e.target.closest ? e.target.closest('[data-plead-act]') : null; if (!b) return;
        var id = b.getAttribute('data-lead-id'), act = b.getAttribute('data-plead-act'), l = byId[id];
        if (!l) return;
        if (act === 'msg') { G.location.href = msgUrl(id); return; }
        if (act === 'quote') {
          /* the page's service cache may not be loaded yet — ask the server rather than claim "no services" */
          var cached = (o.services && o.services()) || [];
          if (cached.length) { quoteForm(l, o, load); return; }
          b.disabled = true;
          call('providerListServices').then(function (r) {
            var list = ((r && r.services) || []).filter(function (s) { return s.active !== false && !s.removedAt; });
            b.disabled = false;
            quoteForm(l, Object.assign({}, o, { services: function () { return list; } }), load);
          }).catch(function (er) { b.disabled = false; G.alert && G.alert(errText(er)); });
          return;
        }
        var simple = { decline: 'leadDecline', qualify: 'leadQualify', withdraw: 'leadWithdrawQuote', lost: 'leadMarkLost' }[act];
        if (simple) {
          var data = { leadId: id };
          if (act === 'lost') { var why = G.prompt ? G.prompt('Why was this lead lost? (optional)') : ''; if (why === null) return; data.reason = why || ''; }
          if (act === 'withdraw' && G.confirm && !G.confirm('Withdraw this quote? The customer will no longer be able to accept it.')) return;
          b.disabled = true; call(simple, data).then(load).catch(function (er) { b.disabled = false; G.alert && G.alert(errText(er)); });
        }
      });
    }
    return load();
  }

  G.SokoniLeads = { ask: ask, mountMine: mountMine, mountProvider: mountProvider, _internal: { mineCard: mineCard, provCard: provCard, LABEL: LABEL, PLABEL: PLABEL, QLABEL: QLABEL } };
}(typeof window !== 'undefined' ? window : globalThis));
