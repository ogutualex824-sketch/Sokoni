/* ═══════════════════════════════════════════════════════════════════════════
   sokoni-ent-storefront.js — a bookable provider's storefront actions.

     BOOK NOW · CHECK AVAILABILITY · ASK A QUESTION · VIEW RATE CARD · REQUEST CALL
   shown ONLY as the server allows (bookingDispatch entMessagingPublic / entRateCardsPublic):
   no "Book now" for a provider that is not bookable, no "Ask a question" when public
   enquiries are off, no online claim without business hours.

   Book:     service → calendar (SokoniEntCalendar, safe states, realtime) → time →
             rate card + discount code → CHECKOUT (entCheckoutQuote — the server's total)
             → CONFIRM & PAY → bookingCreateService { expectedTotalCents } → payment
             (SokoniBookService.payFor). A price that moved → "Price changed"; a time that
             was taken → "That time was just booked." The buyer is never charged a
             client-side figure.
   Enquire:  structured enquiry (category · question · service · date · time · budget)
             → entEnquirySend → the conversation the SERVER opened.

   Usage: SokoniEntStorefront.mount(host, { providerId, name })
   ═══════════════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const kes = (c) => (c == null || !Number.isFinite(Number(c)) ? '—' : 'KES ' + (Number(c) / 100).toLocaleString('en-KE'));
  const RESPONSE = { WITHIN_15_MIN: 'Typically replies within 15 minutes', WITHIN_1_HOUR: 'Typically replies within 1 hour', SAME_DAY: 'Typically replies the same day', WITHIN_24_HOURS: 'Typically replies within 24 hours' };
  const CAT = { AVAILABILITY: 'Availability', PRICING: 'Pricing', SERVICE_DETAILS: 'Service details', LOCATION: 'Location', CUSTOM_REQUEST: 'Custom request', EVENT_QUESTION: 'Event question', COLLABORATION: 'Collaboration', OTHER: 'Other' };
  function call(op, data) {
    const fn = root.firebase && root.firebase.functions && root.firebase.functions().httpsCallable('bookingDispatch');
    if (!fn) return Promise.reject(new Error('This is unavailable right now.'));
    return fn(Object.assign({ op }, data || {})).then((r) => r.data);
  }
  const signedIn = () => !!(root.firebase && root.firebase.auth && root.firebase.auth().currentUser);
  const toLogin = () => { location.href = 'login.html?next=' + encodeURIComponent(location.pathname + location.search); };

  const CSS = `
  .sksf{color:#eee;font-size:14px}
  .sksf *{box-sizing:border-box}
  .sksf-acts{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0}
  .sksf-btn{min-height:44px;padding:10px 16px;border-radius:11px;border:1px solid #262626;background:#141414;color:#eee;font-weight:700;cursor:pointer;font-size:14px}
  .sksf-btn.pri{background:#71ff00;color:#04120a;border-color:#71ff00}
  .sksf-btn[disabled]{opacity:.5;cursor:not-allowed}
  .sksf-card{background:#0f0f0f;border:1px solid #1d1d1d;border-radius:14px;padding:14px;margin:10px 0}
  .sksf-row{display:flex;justify-content:space-between;gap:10px;padding:6px 0;border-bottom:1px solid #1a1a1a;flex-wrap:wrap}
  .sksf-row:last-child{border-bottom:none}
  .sksf-muted{color:#9a9a9a;font-size:13px}
  .sksf-chips{display:flex;flex-wrap:wrap;gap:6px}
  .sksf-chip{min-height:44px;padding:8px 12px;border-radius:22px;border:1px solid #262626;background:#141414;color:#ddd;cursor:pointer}
  .sksf-chip.on{border-color:#71ff00;color:#71ff00}
  .sksf-in{width:100%;min-height:44px;background:#141414;border:1px solid #262626;color:#eee;border-radius:10px;padding:10px;font-size:16px;margin-top:6px}
  .sksf-total{font-size:1.3rem;font-weight:800;color:#71ff00}
  .sksf-err{color:#ff6b6b;font-size:13px;margin-top:6px}
  .sksf-ok{color:#71ff00;font-size:13px;margin-top:6px}
  `;
  function css() { if (!document.getElementById('sksf-css')) { const s = document.createElement('style'); s.id = 'sksf-css'; s.textContent = CSS; document.head.appendChild(s); } }

  function mount(host, opts) {
    if (!host) return null;
    css();
    const o = Object.assign({}, opts || {});
    const ident = o.venueId ? { venueId: o.venueId } : { providerId: o.providerId };
    /* a shared service link (p.html → ?service=) opens with that service selected */
    const sharedSvc = (() => { try { const v = new URLSearchParams(location.search).get('service'); return /^[A-Za-z0-9_-]{1,128}$/.test(v || '') ? v : null; } catch (_) { return null; } })();
    const st = { info: null, cards: [], services: [], serviceId: o.serviceId || sharedSvc || null, slot: null, rateCardId: null, coupon: '', quote: null, cal: null, view: null };
    host.innerHTML = '<div class="sksf"><div data-top></div><div data-body></div></div>';
    const top = host.querySelector('[data-top]'); const body = host.querySelector('[data-body]');

    async function load() {
      top.innerHTML = '<div class="sksf-muted">Loading…</div>';
      try {
        const [info, cards] = await Promise.all([call('entMessagingPublic', ident), call('entRateCardsPublic', ident).catch(() => ({ cards: [] }))]);
        st.info = info; st.cards = cards.cards || [];
      } catch (e) { top.innerHTML = `<div class="sksf-err">${esc((e && e.message) || 'Could not load this provider.')}</div>`; return; }
      /* services from the server (works signed-out; only public fields) */
      if (o.providerId) {
        try { st.services = (await call('entServicesPublic', { providerId: o.providerId })).services || []; }
        catch (_) { st.services = []; }
      }
      renderTop();
      /* Arriving from an accepted quote (chat → Reserve & pay): open checkout on the quote's own terms. */
      const qid = new URLSearchParams(location.search).get('quote');
      if (qid && signedIn()) {
        try {
          const q = ((await call('entQuoteList', {})).quotes || []).find((x) => x.id === qid && x.status === 'ACCEPTED');
          if (q) { st.quote = q.id; if (q.serviceId) st.serviceId = q.serviceId; renderBook(false); if (q.date && q.startTime) { st.slot = { date: q.date, start: q.startTime }; renderCheckout(); } }
        } catch (_) { /* the storefront still works without it */ }
      }
    }
    function renderTop() {
      const i = st.info || {};
      const acts = [];
      if (i.bookable && !o.hideBook) acts.push('<button type="button" class="sksf-btn pri" data-act="book">Book now</button>');
      if (!o.hideCheck) acts.push('<button type="button" class="sksf-btn" data-act="check">Check availability</button>');
      if (i.enquiriesOpen) acts.push('<button type="button" class="sksf-btn" data-act="ask">Ask a question</button>');
      if (st.cards.length) acts.push('<button type="button" class="sksf-btn" data-act="rates">View rate card</button>');
      const pi = i.publicInfo || {};
      const facts = [
        i.responseTime ? (RESPONSE[i.responseTime] || i.responseTimeCustom || '') : null,
        i.openNow === false ? 'Provider is currently unavailable.' : null,
        pi.location ? 'Location: ' + pi.location : null,
        pi.minimumNotice ? 'Minimum notice: ' + pi.minimumNotice : null,
        pi.pricingFromCents != null ? 'Pricing from ' + kes(pi.pricingFromCents) : null,
      ].filter(Boolean);
      top.innerHTML = `<div class="sksf-acts">${acts.join('')}</div>
        ${facts.length ? `<div class="sksf-muted">${facts.map(esc).join(' · ')}</div>` : ''}
        ${pi.serviceDescription || pi.cancellationPolicy || pi.bookingRequirements || (pi.faqs || []).length ? `<details class="sksf-card"><summary style="cursor:pointer;min-height:44px">About bookings</summary>
          ${pi.serviceDescription ? `<p>${esc(pi.serviceDescription)}</p>` : ''}${pi.bookingRequirements ? `<p><strong>Requirements:</strong> ${esc(pi.bookingRequirements)}</p>` : ''}
          ${pi.cancellationPolicy ? `<p><strong>Cancellation:</strong> ${esc(pi.cancellationPolicy)}</p>` : ''}
          ${(pi.faqs || []).map((f) => `<p><strong>${esc(f.q)}</strong><br>${esc(f.a)}</p>`).join('')}</details>` : ''}`;
    }

    /* ── rate card ── */
    function renderRates() {
      body.innerHTML = `<div class="sksf-card"><h4 style="margin:0 0 8px">Rate card</h4>${st.cards.map((c) => `<div class="sksf-row"><span><strong>${esc(c.name)}</strong>${c.description ? `<br><span class="sksf-muted">${esc(c.description)}</span>` : ''}${c.durationMins ? `<br><span class="sksf-muted">${esc(c.durationMins)} min</span>` : ''}</span>
        <span>${c.quote ? '<button type="button" class="sksf-btn" data-act="ask" data-cat="PRICING">Request a quote</button>' : c.priceAtCheckout ? '<span class="sksf-muted">Price shown at checkout</span>' : `<strong>${esc(kes(c.priceCents))}</strong>${c.unit && c.unit !== 'booking' ? ' / ' + esc(c.unit) : ''}`}</span></div>`).join('') || '<div class="sksf-muted">No public rates.</div>'}</div>`;
    }

    /* ── booking ── */
    function renderBook(checkOnly) {
      if (!st.info.bookable && !checkOnly) { body.innerHTML = '<div class="sksf-card sksf-muted">This provider is not taking bookings right now.</div>'; return; }
      const svcChips = st.services.length ? `<div class="sksf-muted" style="margin-bottom:6px">Service</div><div class="sksf-chips">${st.services.map((s) => `<button type="button" class="sksf-chip${s.id === st.serviceId ? ' on' : ''}" data-svc="${esc(s.id)}">${esc(s.name || 'Service')}</button>`).join('')}</div>` : '';
      body.innerHTML = `<div class="sksf-card">${svcChips}<div data-cal style="margin-top:10px"></div>${checkOnly ? '' : '<div data-checkout></div>'}</div>`;
      if (!st.serviceId && st.services.length) st.serviceId = st.services[0].id;
      body.querySelectorAll('[data-svc]').forEach((b) => b.classList.toggle('on', b.dataset.svc === st.serviceId));
      if (st.cal) st.cal.destroy();
      st.cal = root.SokoniEntCalendar.mount(body.querySelector('[data-cal]'), Object.assign({}, ident, { serviceId: st.serviceId, mode: 'public',
        onSelect: checkOnly ? null : (slot) => { st.slot = slot; renderCheckout(); } }));
    }
    function bookableCards() { return st.cards.filter((c) => !c.quote && (!c.serviceId || c.serviceId === st.serviceId)); }
    async function renderCheckout(note) {
      const box = body.querySelector('[data-checkout]'); if (!box || !st.slot) return;
      if (!signedIn()) { box.innerHTML = '<div class="sksf-card"><button type="button" class="sksf-btn pri" data-act="login">Sign in to book</button></div>'; return; }
      box.innerHTML = '<div class="sksf-muted" style="margin-top:10px">Preparing checkout…</div>';
      let q;
      try { q = await call('entCheckoutQuote', Object.assign({}, ident, { serviceId: st.serviceId, date: st.slot.date, startTime: st.slot.start, rateCardId: st.rateCardId, couponCode: st.coupon || undefined, quoteId: st.quote || undefined })); }
      catch (e) { box.innerHTML = `<div class="sksf-err">${esc((e && e.message) || 'Could not prepare checkout.')}</div>`; return; }
      st.view = q;
      const cards = bookableCards();
      const taken = q.slotState !== 'AVAILABLE' && q.slotState !== 'LIMITED';
      box.innerHTML = `<div class="sksf-card" data-co>
        <h4 style="margin:0 0 8px">Checkout</h4>
        ${note ? `<div class="sksf-err">${esc(note)}</div>` : ''}
        ${taken ? '<div class="sksf-err">That time was just booked. Please choose another time.</div>' : ''}
        <div class="sksf-row"><span>Service</span><strong>${esc(q.serviceName)}</strong></div>
        <div class="sksf-row"><span>Date</span><strong>${esc(q.date)}</strong></div>
        <div class="sksf-row"><span>Time</span><strong>${esc(q.start)}–${esc(q.end)}</strong></div>
        ${cards.length ? `<div class="sksf-row"><span>Rate card</span><select class="sksf-in" data-rc style="max-width:260px"><option value="">Standard price</option>${cards.map((c) => `<option value="${esc(c.id)}" ${c.id === st.rateCardId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>` : ''}
        <div class="sksf-row"><span>Base price${q.rateCard ? ' (' + esc(q.rateCard.name) + ', v' + esc(q.rateCard.version) + ')' : ''}</span><strong>${esc(kes(q.baseCents))}</strong></div>
        <div class="sksf-row"><span>Discount</span><strong>${q.discountCents ? '−' + esc(kes(q.discountCents)) : '—'}</strong></div>
        ${q.feeCents ? `<div class="sksf-row"><span>Service fee</span><strong>${esc(kes(q.feeCents))}</strong></div>` : ''}
        <div class="sksf-row"><span>Final price</span><span class="sksf-total">${esc(kes(q.totalCents))}</span></div>
        <div class="sksf-row"><span>Payment method</span><span class="sksf-muted">${esc(q.paymentMethod)}</span></div>
        <div class="sksf-row"><span>Refund policy</span><span class="sksf-muted" style="max-width:360px">${esc(q.refundPolicy)}</span></div>
        <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap"><input class="sksf-in" data-coupon placeholder="Discount code" value="${esc(st.coupon)}" style="max-width:200px"><button type="button" class="sksf-btn" data-act="coupon">Apply</button></div>
        ${q.couponNote ? `<div class="sksf-err">${esc(q.couponNote)}</div>` : ''}
        <button type="button" class="sksf-btn pri" data-act="pay" style="width:100%;margin-top:12px" ${taken ? 'disabled' : ''}>Confirm &amp; pay ${esc(kes(q.totalCents))}</button>
        <div data-pay-msg class="sksf-muted" role="status" aria-live="polite"></div></div>`;
    }
    async function confirmAndPay(btn) {
      const q = st.view; if (!q) return;
      btn.disabled = true; btn.textContent = 'Reserving…';
      const msg = body.querySelector('[data-pay-msg]');
      try {
        const r = await root.firebase.functions().httpsCallable('providerDispatch')({ op: 'bookingCreateService', providerId: o.providerId, serviceId: st.serviceId,
          date: q.date, startTime: q.start, rateCardId: st.rateCardId || undefined, couponCode: st.coupon || undefined, quoteId: st.quote || undefined,
          expectedTotalCents: q.totalCents, idempotencyKey: 'sf_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8) }).then((x) => x.data);
        msg.textContent = 'Reserved. Opening payment…';
        if (root.SokoniBookService && root.SokoniBookService.payFor) root.SokoniBookService.payFor({ bookingId: r.bookingId, providerId: o.providerId, serviceName: q.serviceName, date: q.date, time: q.start, expiresAt: r.expiresAt });
        if (st.cal) st.cal.refresh();
      } catch (e) {
        const details = (e && e.details) || {};
        if (details.code === 'PRICE_CHANGED') return renderCheckout('Price changed. The new total is ' + kes(details.totalCents) + ' — please review and confirm again.');
        if ((e && e.code) === 'functions/already-exists' || details.code === 'SLOT_UNAVAILABLE') { if (st.cal) st.cal.refresh(); return renderCheckout('That time was just booked. Please choose another time.'); }
        btn.disabled = false; btn.textContent = 'Confirm & pay';
        msg.textContent = (e && e.message) || 'Could not reserve that time.';
      }
    }

    /* ── enquiry ── */
    function renderAsk(cat) {
      if (!signedIn()) { body.innerHTML = '<div class="sksf-card"><button type="button" class="sksf-btn pri" data-act="login">Sign in to ask a question</button></div>'; return; }
      const cats = (st.info.enquiryCategories || Object.keys(CAT));
      body.innerHTML = `<form class="sksf-card" data-ask>
        <h4 style="margin:0 0 8px">Have a question?</h4>
        <label>What is it about?<select class="sksf-in" name="category" required>${cats.map((c) => `<option value="${esc(c)}" ${c === cat ? 'selected' : ''}>${esc(CAT[c] || c)}</option>`).join('')}</select></label>
        ${st.services.length ? `<label>Service<select class="sksf-in" name="serviceId"><option value="">Any</option>${st.services.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}</select></label>` : ''}
        <label>Your question<textarea class="sksf-in" name="question" rows="4" minlength="10" maxlength="1500" required></textarea></label>
        <div style="display:flex;gap:8px;flex-wrap:wrap"><label style="flex:1;min-width:140px">Date (optional)<input class="sksf-in" type="date" name="desiredDate"></label>
          <label style="flex:1;min-width:120px">Time (optional)<input class="sksf-in" type="time" name="preferredTime"></label>
          <label style="flex:1;min-width:140px">Budget, KES (optional)<input class="sksf-in" type="number" min="0" name="budget" inputmode="numeric"></label></div>
        <button class="sksf-btn pri" type="submit" style="width:100%;margin-top:10px">Send enquiry</button>
        <div data-ask-msg role="status" aria-live="polite"></div></form>`;
    }
    async function sendAsk(f) {
      const btn = f.querySelector('button[type=submit]'); btn.disabled = true;
      const m = f.querySelector('[data-ask-msg]');
      try {
        const r = await call('entEnquirySend', Object.assign({}, ident, { category: f.category.value, serviceId: f.serviceId ? f.serviceId.value || undefined : undefined,
          question: f.question.value, desiredDate: f.desiredDate.value || undefined, preferredTime: f.preferredTime.value || undefined,
          budgetCents: f.budget.value ? Math.round(Number(f.budget.value) * 100) : undefined }));
        m.className = 'sksf-ok';
        m.innerHTML = `Sent. <a href="/chat.html?id=${encodeURIComponent(r.conversationId)}" style="color:#71ff00">Open the conversation</a>` +
          (st.info.callRequestsOpen ? ` · <button type="button" class="sksf-btn" data-act="callreq" data-enq="${esc(r.enquiryId)}">Request a call</button>` : '');
      } catch (e) { btn.disabled = false; m.className = 'sksf-err'; m.textContent = (e && e.message) || 'Could not send your enquiry.'; }
    }

    host.addEventListener('click', async (ev) => {
      const b = ev.target.closest('button'); if (!b || b.disabled) return;
      const a = b.dataset.act;
      if (a === 'book') return renderBook(false);
      if (a === 'check') return renderBook(true);
      if (a === 'ask') return renderAsk(b.dataset.cat || null);
      if (a === 'rates') return renderRates();
      if (a === 'login') return toLogin();
      if (a === 'coupon') { st.coupon = (body.querySelector('[data-coupon]') || {}).value || ''; return renderCheckout(); }
      if (a === 'pay') return confirmAndPay(b);
      if (a === 'callreq') {
        b.disabled = true;
        try { await call('entCallRequest', { context: { type: 'enquiry', id: b.dataset.enq } }); b.textContent = 'Call requested — the provider will accept or schedule it'; }
        catch (e) { b.disabled = false; alert((e && e.message) || 'Could not request a call.'); }
        return undefined;
      }
      if (b.dataset.svc) { st.serviceId = b.dataset.svc; st.slot = null; body.querySelectorAll('[data-svc]').forEach((x) => x.classList.toggle('on', x === b)); if (st.cal) st.cal.setService(st.serviceId); const co = body.querySelector('[data-checkout]'); if (co) co.innerHTML = ''; }
      return undefined;
    });
    host.addEventListener('change', (ev) => { if (ev.target.matches('[data-rc]')) { st.rateCardId = ev.target.value || null; renderCheckout(); } });
    host.addEventListener('submit', (ev) => { if (ev.target.matches('[data-ask]')) { ev.preventDefault(); sendAsk(ev.target); } });

    load();
    return { reload: load, destroy() { if (st.cal) st.cal.destroy(); host.innerHTML = ''; } };
  }

  root.SokoniEntStorefront = { mount };
}(typeof window !== 'undefined' ? window : globalThis));
