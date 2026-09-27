/* ═══════════════════════════════════════════════════════════════════════════
   sokoni-ent-conversation.js — keeps an Entertainment conversation CONNECTED to its
   transaction (chat.html).

   PRIVATE booking conversation (ent_booking_*):
     PROVIDER · BOOKING · STATUS · DATE · SERVICE · PIN (buyer only) · PAYMENT
     [ VIEW BOOKING ] [ MESSAGE ] [ CALL — only as SOKONI Connect allows ] [ REFUND ]
   PUBLIC enquiry conversation (ent_enquiry_*):
     ENQUIRY · STATUS · CATEGORY · SERVICE · DATE · the provider's QUOTE (accept / decline)
     [ REQUEST CALL ] (the provider accepts or schedules it — nobody is rung)

   Everything comes from the server (entBookingGet / entEnquiryGet / entQuoteList); the
   PIN is only ever returned to the buyer. Nothing is cached in localStorage.
   Usage: SokoniEntConversation.mount(conversation, uid)
   ═══════════════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const kes = (c) => (c == null || !Number.isFinite(Number(c)) ? '—' : 'KES ' + (Number(c) / 100).toLocaleString('en-KE'));
  const when = (ms) => (ms ? new Date(Number(ms)).toLocaleString('en-KE', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
  const fn = (name) => root.firebase.functions().httpsCallable(name);
  const dispatch = (name, op, data) => fn(name)(Object.assign({ op }, data || {})).then((r) => r.data);
  const CSS = `
  #ent-conv-card{margin:8px 12px;background:#0f0f0f;border:1px solid #1f1f1f;border-radius:14px;padding:12px;color:#eee;font-size:13px}
  #ent-conv-card .ecc-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:6px 12px}
  #ent-conv-card .ecc-l{color:#8a8a8a;font-size:11px;text-transform:uppercase;letter-spacing:.04em}
  #ent-conv-card .ecc-v{font-weight:700;word-break:break-word}
  #ent-conv-card .ecc-pin{font-size:1.4rem;letter-spacing:.3em;color:#71ff00}
  #ent-conv-card .ecc-acts{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
  #ent-conv-card .ecc-btn,#ent-conv-card .cc-call{min-height:44px;padding:8px 12px;border-radius:10px;border:1px solid #262626;background:#141414;color:#eee;font-weight:700;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center}
  #ent-conv-card .ecc-btn.pri{background:#71ff00;color:#04120a;border-color:#71ff00}
  #ent-conv-card .ecc-msg{margin-top:6px;color:#9a9a9a}
  `;
  function css() { if (!document.getElementById('ecc-css')) { const s = document.createElement('style'); s.id = 'ecc-css'; s.textContent = CSS; document.head.appendChild(s); } }
  function host() {
    let el = document.getElementById('ent-conv-card');
    if (el) return el;
    el = document.createElement('section'); el.id = 'ent-conv-card'; el.setAttribute('aria-label', 'Booking details');
    const banner = document.getElementById('ctx-banner');
    if (banner && banner.parentNode) banner.parentNode.insertBefore(el, banner.nextSibling); else document.body.prepend(el);
    return el;
  }
  const cell = (l, v, cls) => `<div><div class="ecc-l">${esc(l)}</div><div class="ecc-v ${cls || ''}">${v}</div></div>`;

  async function mountBooking(conv, uid) {
    const el = host();
    const ref = conv.metadata && conv.metadata.bookingRef;
    el.innerHTML = '<div class="ecc-msg">Loading booking…</div>';
    let b;
    try { b = (await dispatch('eventOpsDispatch', 'entBookingGet', { bookingRef: ref })).booking; }
    catch (e) { el.innerHTML = `<div class="ecc-msg">${esc((e && e.message) || 'Booking details are unavailable.')}</div>`; return; }
    const buyer = b.role === 'buyer';
    const refundable = buyer && ['CONFIRMED', 'PENDING'].includes(b.status) && b.payment && b.payment.state === 'CONFIRMED';
    el.innerHTML = `<div class="ecc-grid">
        ${cell(buyer ? 'Provider' : 'Customer', esc(buyer ? (b.providerName || conv.transactionTitle || '—') : ((b.buyer && b.buyer.initials) || '—')))}
        ${cell('Booking', esc(b.bookingRef))}
        ${cell('Status', esc(String(b.status || '—').replace(/_/g, ' ')))}
        ${cell('Date', esc(when(b.when && b.when.startMs)))}
        ${cell('Service', esc(b.title || '—'))}
        ${cell('Payment', esc(String((b.payment && b.payment.state) || '—').replace(/_/g, ' ')))}
        ${buyer && b.pin && b.pin !== '••••' ? cell(b.phrase || 'PIN YAKO NI BOOKING YAKO', esc(b.pin), 'ecc-pin') : ''}
      </div>
      <div class="ecc-acts">
        <a class="ecc-btn" href="/entertainment.html?tab=mine&booking=${encodeURIComponent(b.bookingRef)}">View booking</a>
        <button type="button" class="ecc-btn" data-ecc="msg">Message</button>
        <span data-ecc-call></span>
        ${refundable ? `<a class="ecc-btn" href="/entertainment.html?tab=mine&booking=${encodeURIComponent(b.bookingRef)}#refund">Refund</a>` : ''}
      </div><div class="ecc-msg" role="status" aria-live="polite" data-ecc-out></div>`;
    /* CALL: only what SOKONI Connect's surface AND authority allow for this booking (no phone numbers). */
    const slot = el.querySelector('[data-ecc-call]');
    if (root.SokoniConnectCall && conv.metadata && conv.metadata.anchorId) {
      root.SokoniConnectCall.mountForAnchor(slot, { anchorType: 'entBooking', anchorId: conv.metadata.anchorId,
        call: (op, payload) => fn('connectDispatch')(Object.assign({}, payload || {}, { op })).then((r) => (r && r.data) || {}),
        onSession: (r) => { if (r && r.sessionId) location.href = '/connect.html?session=' + encodeURIComponent(r.sessionId); } });
    }
  }

  async function mountEnquiry(conv, uid) {
    const el = host();
    el.innerHTML = '<div class="ecc-msg">Loading enquiry…</div>';
    let e;
    try { e = (await dispatch('bookingDispatch', 'entEnquiryGet', { enquiryId: conv.transactionId })).enquiry; }
    catch (err) { el.innerHTML = `<div class="ecc-msg">${esc((err && err.message) || 'Enquiry details are unavailable.')}</div>`; return; }
    const buyer = e.role === 'buyer';
    let quote = null;
    if (e.quoteId) {
      try { quote = ((await dispatch('bookingDispatch', 'entQuoteList', { as: buyer ? 'buyer' : 'provider' })).quotes || []).find((q) => q.id === e.quoteId) || null; } catch (_) { quote = null; }
    }
    const closed = ['CLOSED', 'EXPIRED', 'BLOCKED', 'CONVERTED'].includes(e.status);
    el.innerHTML = `<div class="ecc-grid">
        ${cell('Enquiry', esc(String(e.id).slice(0, 8).toUpperCase()))}
        ${cell('Status', esc(String(e.status).replace(/_/g, ' ')))}
        ${cell('About', esc(String(e.category || '').replace(/_/g, ' ').toLowerCase()))}
        ${cell('Service', esc(e.serviceName || '—'))}
        ${cell('Date', esc(e.desiredDate || '—'))}
        ${quote ? cell('Quote', `${esc(kes(quote.finalCents))} · ${esc(quote.status)}`) : ''}
      </div>
      ${quote ? `<div class="ecc-msg">${esc(quote.description || '')}${quote.date ? ' · ' + esc(quote.date) + (quote.startTime ? ' ' + esc(quote.startTime) : '') : ''}${quote.terms ? ' · Terms: ' + esc(quote.terms) : ''}</div>` : ''}
      <div class="ecc-acts">
        ${buyer && quote && quote.status === 'SENT' ? `<button type="button" class="ecc-btn pri" data-ecc="qaccept" data-q="${esc(quote.id)}">Accept quote</button><button type="button" class="ecc-btn" data-ecc="qdecline" data-q="${esc(quote.id)}">Decline</button>` : ''}
        ${buyer && quote && quote.status === 'ACCEPTED' ? `<a class="ecc-btn pri" href="/provider-profile.html?uid=${encodeURIComponent(e.counterparty)}&quote=${encodeURIComponent(quote.id)}">Reserve &amp; pay</a>` : ''}
        ${buyer && !closed ? '<button type="button" class="ecc-btn" data-ecc="callreq">Request a call</button>' : ''}
        ${!buyer && !closed ? '<a class="ecc-btn" href="/provider-dashboard.html#enquiries">Send a quote</a>' : ''}
        ${e.bookingId ? `<span class="ecc-msg">Booked ✓</span>` : ''}
      </div><div class="ecc-msg" role="status" aria-live="polite" data-ecc-out></div>`;
  }

  function mount(conv, uid) {
    if (!conv || !root.firebase) return;
    css();
    const t = conv.transactionType;
    if (t === 'ent_booking') mountBooking(conv, uid);
    else if (t === 'ent_enquiry') mountEnquiry(conv, uid);
  }

  document.addEventListener('click', async (ev) => {
    const b = ev.target.closest('#ent-conv-card [data-ecc]'); if (!b) return;
    const out = document.querySelector('#ent-conv-card [data-ecc-out]');
    const a = b.dataset.ecc;
    if (a === 'msg') { const i = document.getElementById('msg-input') || document.querySelector('textarea'); if (i) i.focus(); return; }
    b.disabled = true;
    try {
      if (a === 'qaccept' || a === 'qdecline') {
        const r = await dispatch('bookingDispatch', 'entQuoteRespond', { quoteId: b.dataset.q, accept: a === 'qaccept' });
        if (out) out.textContent = r.status === 'ACCEPTED' ? 'Quote accepted — reserve a time and pay to confirm. Accepting is not a payment.' : 'Quote declined.';
      }
      if (a === 'callreq') {
        const convId = new URLSearchParams(location.search).get('id') || '';
        const enquiryId = convId.replace(/^ent_enquiry_/, '');
        await dispatch('bookingDispatch', 'entCallRequest', { context: { type: 'enquiry', id: enquiryId } });
        if (out) out.textContent = 'Call requested. The provider will accept or schedule it — you will be notified.';
      }
    } catch (e) { if (out) out.textContent = (e && e.message) || 'That did not work.'; b.disabled = false; }
  });

  root.SokoniEntConversation = { mount };
}(typeof window !== 'undefined' ? window : globalThis));
