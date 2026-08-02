'use strict';
/* ============================================================================
   SOKONI — Canonical service-booking flow (Phase E WS2)
   A THIN orchestration layer over the authoritative backend. It owns NO business
   logic: slots come from getAvailabilitySlots, the booking from bookingCreateService,
   the payable amount from createPaymentIntent, and EVERY visible state derives from
   the providerBookings document (single source of truth) observed in real time.

   Usage:  SokoniBookService.open({ providerId, serviceId, serviceName, providerName })
   Both services.html and provider-profile.html call this — one customer journey.
   ========================================================================== */
(function (global) {
  const K = 'sok_active_service_booking';           /* resume key (survives refresh) */
  const call = (name, data) => firebase.functions().httpsCallable(name)(data).then(r => r.data);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtKES = (cents) => 'KSh ' + (Math.round(Number(cents) || 0) / 100).toLocaleString();   /* cents → KES, UI only */
  /* HH:MM (24h, the server/canonical value) → "10:00 AM" for display ONLY. data-time stays 24h. */
  const fmtTime = (hhmm) => {
    if (!hhmm || typeof hhmm !== 'string' || hhmm.indexOf(':') < 0) return hhmm || '';
    const parts = hhmm.split(':'); const h = Number(parts[0]) || 0; const m = Number(parts[1]) || 0;
    const ap = h < 12 ? 'AM' : 'PM'; const h12 = ((h + 11) % 12) + 1;
    return h12 + ':' + String(m).padStart(2, '0') + ' ' + ap;
  };

  let _unsub = null, _ctx = null, _holdTimer = null;

  /* ── Every visible state is derived from the booking doc — never a local timer. ── */
  function stateOf(b) {
    if (!b) return { label: 'Loading…', done: false };
    if (b.paymentStatus === 'settled' || b.status === 'completed') return { label: '✅ Completed', done: true, tone: 'ok' };
    if (b.paymentStatus === 'refunded') return { label: '↩ Refunded', done: true, tone: 'warn' };
    if (b.status === 'cancelled') return { label: b.cancelReason === 'payment-expired' ? '⌛ Expired — please rebook' : '✖ Cancelled', done: true, tone: 'warn' };
    if (b.paymentStatus === 'paid_held') return { label: '💰 Paid • Held — awaiting provider', done: true, tone: 'ok' };
    return { label: '⏳ Awaiting payment…', done: false, tone: 'pending' };
  }

  function ui() {
    let el = document.getElementById('sbsModal');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'sbsModal';
    el.innerHTML = `
      <div class="sbs-back" onclick="SokoniBookService.close()"></div>
      <div class="sbs-card" role="dialog" aria-modal="true">
        <button class="sbs-x" onclick="SokoniBookService.close()">×</button>
        <div class="sbs-title" id="sbsTitle">Book a service</div>
        <div class="sbs-body" id="sbsBody"></div>
      </div>
      <style>
        #sbsModal{position:fixed;inset:0;z-index:99999;display:flex;align-items:flex-end;justify-content:center}
        #sbsModal .sbs-back{position:absolute;inset:0;background:rgba(0,0,0,.6)}
        #sbsModal .sbs-card{position:relative;background:#0b0b0b;border:1px solid #1c1c1c;border-radius:18px 18px 0 0;width:100%;max-width:460px;max-height:88vh;overflow:auto;padding:18px;color:#eee}
        @media(min-width:560px){#sbsModal{align-items:center}#sbsModal .sbs-card{border-radius:18px}}
        #sbsModal .sbs-x{position:absolute;top:10px;right:12px;background:none;border:none;color:#888;font-size:26px;cursor:pointer}
        #sbsModal .sbs-title{font-weight:800;font-size:1.05rem;margin-bottom:12px;padding-right:26px}
        #sbsModal .sbs-day{margin:10px 0 4px;font-size:.78rem;color:#9a9a9a}
        #sbsModal .sbs-slots{display:flex;flex-wrap:wrap;gap:7px}
        #sbsModal .sbs-slot{background:#141414;border:1px solid #262626;color:#ddd;border-radius:9px;padding:8px 11px;font-size:.82rem;cursor:pointer}
        #sbsModal .sbs-slot:hover{border-color:#71ff00}
        #sbsModal .sbs-slot.sel{background:#71ff00;color:#04120a;font-weight:700;border-color:#71ff00}
        #sbsModal .sbs-btn{width:100%;background:#71ff00;color:#04120a;border:none;border-radius:11px;padding:13px;font-weight:800;font-size:.95rem;cursor:pointer;margin-top:14px}
        #sbsModal .sbs-btn[disabled]{opacity:.5;cursor:not-allowed}
        #sbsModal .sbs-in{width:100%;background:#141414;border:1px solid #262626;color:#eee;border-radius:10px;padding:12px;font-size:16px;margin-top:8px}
        #sbsModal .sbs-price{font-size:1.4rem;font-weight:800;color:#71ff00;margin:6px 0}
        #sbsModal .sbs-note{font-size:.76rem;color:#9a9a9a;margin-top:6px}
        #sbsModal .sbs-state{font-size:1.05rem;font-weight:700;text-align:center;padding:20px 0}
        #sbsModal .sbs-empty{color:#9a9a9a;font-size:.85rem;padding:14px 0}
      </style>`;
    document.body.appendChild(el);
    return el;
  }
  const show = () => { ui().style.display = 'flex'; document.body.style.overflow = 'hidden'; };
  const body = (html) => { ui(); document.getElementById('sbsBody').innerHTML = html; };
  const title = (t) => { ui(); document.getElementById('sbsTitle').textContent = t; };

  /* ── 0. Service picker — when the caller didn't pass a serviceId. Prices shown are
     the service price field only (a hint); the AUTHORITATIVE payable comes from the
     server payment intent later — the client never sums the total. ── */
  async function loadServices() {
    title('Choose a service');
    body('<div class="sbs-empty">Loading services…</div>');
    let snap;
    try { snap = await firebase.firestore().collection('providerServices').where('providerId', '==', _ctx.providerId).limit(50).get(); }
    catch (e) { body(`<div class="sbs-empty">Couldn’t load services. ${esc(e.message || '')}</div>`); return; }
    const svcs = snap.docs.map(d => Object.assign({ id: d.id }, d.data())).filter(s => s.active !== false && !s.removedAt);
    if (!svcs.length) { body('<div class="sbs-empty">This provider has no bookable services yet.</div>'); return; }
    body(svcs.map(s => `
      <button type="button" class="sbs-slot" style="display:block;width:100%;text-align:left;margin-bottom:8px"
        onclick="SokoniBookService._pickSvc('${esc(s.id)}', this.getAttribute('data-n'))" data-n="${esc(s.name || 'Service')}">
        <strong>${esc(s.name || 'Service')}</strong> — ${s.priceType === 'quotation' ? 'On quote' : 'from ' + fmtKES(s.price)}${s.durationMins ? ` · ${s.durationMins} min` : ''}
      </button>`).join(''));
  }
  function pickSvc(id, name) { _ctx.serviceId = id; _ctx.serviceName = name; loadSlots(); }

  /* ── 1. Slot picker — renders exactly what getAvailabilitySlots returns. ── */
  async function loadSlots() {
    title('Pick a time' + (_ctx.serviceName ? ' — ' + _ctx.serviceName : ''));
    body('<div class="sbs-empty">Loading available times…</div>');
    let res;
    try { res = await call('bookingDispatch', { op: 'getAvailabilitySlots', providerId: _ctx.providerId, serviceId: _ctx.serviceId, days: 14 }); }
    catch (e) { body(`<div class="sbs-empty">Couldn’t load availability. ${esc(e.message || '')}</div>`); return; }
    const days = (res && (res.days || res.results || res.availability)) || [];
    const open = days.filter(d => d.available && (d.slots || []).length);
    if (!open.length) { body('<div class="sbs-empty">No open times in the next two weeks. Please check back later.</div>'); return; }
    const html = open.map(d => `
      <div class="sbs-day">${esc(d.date)}</div>
      <div class="sbs-slots">${(d.slots || [])
        .filter(s => (typeof s === 'string') || s.available !== false)   /* only bookable slots */
        .map(s => {
          const t24 = typeof s === 'string' ? s : (s.startTime || s.start || s.time || '');   /* canonical field is startTime */
          if (!t24) return '';
          return `<button type="button" class="sbs-slot" data-date="${esc(d.date)}" data-time="${esc(t24)}" onclick="SokoniBookService._pick(this)">${esc(fmtTime(t24))}</button>`;
        }).join('')}</div>`).join('');
    body(html + `<button class="sbs-btn" id="sbsGo" disabled onclick="SokoniBookService._chooseOptions()">Select a time</button>`);
  }
  function pick(el) {
    document.querySelectorAll('#sbsModal .sbs-slot.sel').forEach(s => s.classList.remove('sel'));
    el.classList.add('sel');
    _ctx.date = el.dataset.date; _ctx.time = el.dataset.time;
    const go = document.getElementById('sbsGo'); go.disabled = false; go.textContent = `Continue — ${_ctx.date} at ${fmtTime(_ctx.time)}`;
  }

  /* ── 1b. Options (Slice D) — package / add-ons / duration + LIVE server preview.
     THIN: NO pricing math here. Skipped automatically for a service with no advanced pricing
     (goes straight to create() = today's behavior). The client sends only the SELECTION; the
     server (bookingPreviewPrice → same computePrice) returns the authoritative breakdown. ── */
  async function chooseOptions() {
    const go = document.getElementById('sbsGo'); if (go && go.disabled) return;
    let svc;
    try { svc = (await firebase.firestore().collection('providerServices').doc(_ctx.serviceId).get()).data() || {}; }
    catch (e) { return create(); }
    const p = svc.pricing;
    const advanced = p && ((p.packages && p.packages.length) || (p.addOns && p.addOns.filter(a => a.available !== false).length) || p.extraHourRate);
    if (!advanced) return create();                       /* simple/legacy service → unchanged flow */
    _ctx.pricing = p;
    _ctx.baseDuration = Number(p.durationMins || svc.durationMins || 60);
    _ctx.selection = { packageId: null, addOns: [], durationMins: _ctx.baseDuration };
    renderOptions();
  }
  function renderOptions() {
    const p = _ctx.pricing;
    title('Choose your options');
    let html = '';
    if (p.packages && p.packages.length) {
      html += '<div class="sbs-day">Package</div>';
      html += '<label style="display:block;margin:5px 0"><input type="radio" name="sbsPkg" value="" checked onchange="SokoniBookService._opt()"> Custom / base</label>';
      html += p.packages.map(pk => `<label style="display:block;margin:5px 0"><input type="radio" name="sbsPkg" value="${esc(pk.id)}" onchange="SokoniBookService._opt()"> ${esc(pk.name)}</label>`).join('');
    }
    const addons = (p.addOns || []).filter(a => a.available !== false);
    if (addons.length) {
      html += '<div class="sbs-day">Add-ons</div>';
      html += addons.map(a => {
        const maxQ = Number(a.qtyMax) || 1;
        const qtyCtl = maxQ > 1 ? ` <input type="number" min="1" max="${maxQ}" value="1" data-qty="${esc(a.id)}" onchange="SokoniBookService._opt()" style="width:52px;background:#141414;border:1px solid #262626;color:#eee;border-radius:6px;padding:3px" disabled>` : '';
        return `<label style="display:block;margin:5px 0"><input type="checkbox" data-addon="${esc(a.id)}" onchange="SokoniBookService._opt()"> ${esc(a.name)} (+${fmtKES(a.price)})${qtyCtl}</label>`;
      }).join('');
    }
    if (p.extraHourRate) {
      const base = _ctx.baseDuration;
      html += '<div class="sbs-day">Duration</div><select class="sbs-in" id="sbsDur" onchange="SokoniBookService._opt()">';
      [0, 60, 120, 180, 240].forEach(add => { const d = base + add; html += `<option value="${d}">${(d / 60)}h${add ? ` (+${add / 60}h)` : ''}</option>`; });
      html += '</select>';
    }
    html += '<div class="sbs-day">Price</div><div id="sbsPreview" class="sbs-empty">Calculating…</div>';
    html += '<button class="sbs-btn" id="sbsGo2" onclick="SokoniBookService._continue()">Continue to payment</button>';
    body(html);
    updatePreview();
  }
  function readSelection() {
    const pkgEl = document.querySelector('#sbsModal input[name=sbsPkg]:checked');
    const addOns = [];
    document.querySelectorAll('#sbsModal input[data-qty]').forEach(q => {   /* enable/disable qty with its checkbox */
      const cb = document.querySelector('#sbsModal input[data-addon="' + q.getAttribute('data-qty') + '"]');
      q.disabled = !(cb && cb.checked);
    });
    document.querySelectorAll('#sbsModal input[data-addon]:checked').forEach(cb => {
      const id = cb.getAttribute('data-addon');
      const q = document.querySelector('#sbsModal input[data-qty="' + id + '"]');
      addOns.push({ id, qty: q ? Math.max(1, parseInt(q.value) || 1) : 1 });
    });
    const durEl = document.getElementById('sbsDur');
    _ctx.selection = { packageId: (pkgEl && pkgEl.value) || null, addOns, durationMins: durEl ? parseInt(durEl.value) : _ctx.baseDuration };
    return _ctx.selection;
  }
  async function updatePreview() {
    readSelection();
    const pv = document.getElementById('sbsPreview'); if (!pv) return;
    pv.textContent = 'Calculating…';
    try {
      const b = await call('providerDispatch', { op: 'bookingPreviewPrice', serviceId: _ctx.serviceId, selection: _ctx.selection,
        ctx: { date: _ctx.date, startTime: _ctx.time, distanceKm: Number(_ctx.distanceKm) || 0 } });
      pv.innerHTML = (b.breakdown || []).map(x => `<div style="display:flex;justify-content:space-between"><span>${esc(x.label)}</span><span>${x.amount < 0 ? '−' : ''}${fmtKES(Math.abs(x.amount))}</span></div>`).join('')
        + `<div style="display:flex;justify-content:space-between;font-weight:800;color:#71ff00;border-top:1px solid #262626;margin-top:6px;padding-top:6px"><span>Total</span><span>${fmtKES(b.totalCents)}</span></div>`
        + (b.depositCents ? `<div style="display:flex;justify-content:space-between;font-size:.8rem;color:#9a9a9a"><span>Deposit today</span><span>${fmtKES(b.depositCents)}</span></div>` : '');
    } catch (e) { pv.textContent = (e && e.message) || 'Couldn’t price that selection.'; }
  }
  function continueToBooking() { readSelection(); create(); }

  /* ── 2. Create booking FIRST (recommendation) — then price + intent. ── */
  async function create() {
    const go = document.getElementById('sbsGo') || document.getElementById('sbsGo2');   /* either entry: slot or options */
    if (go && go.disabled) return;
    if (go) { go.disabled = true; go.textContent = 'Reserving…'; }     /* dup-click lock */
    let bk;
    try {
      /* The client sends the SELECTION only — never an amount. The server computes the
         authoritative total (computePrice) and snapshots it on the booking. */
      const sel = _ctx.selection || {};
      bk = await call('providerDispatch', { op: 'bookingCreateService', providerId: _ctx.providerId, serviceId: _ctx.serviceId, date: _ctx.date, startTime: _ctx.time,
        packageId: sel.packageId || undefined, addOns: sel.addOns || [], durationMins: sel.durationMins || undefined, distanceKm: Number(_ctx.distanceKm) || undefined });
    } catch (e) { if (go) { go.disabled = false; go.textContent = 'Try another time'; } title('Slot unavailable'); alert(e.message || 'That slot is no longer available.'); return loadSlots(); }
    _ctx.bookingId = bk.bookingId;
    _ctx.expiresAt = Number(bk.expiresAt) || null;                     /* pre-payment hold deadline (epoch ms) */
    _ctx.settled = false;
    sessionStorage.setItem(K, JSON.stringify({ bookingId: bk.bookingId, providerId: _ctx.providerId, serviceName: _ctx.serviceName }));
    observe(bk.bookingId);                                             /* single source of truth from here */
    await preparePayment();
  }

  /* ── 3. Immutable pricing snapshot + payment intent (server amount only). ── */
  async function preparePayment() {
    title('Confirm & pay');
    body('<div class="sbs-empty">Preparing payment…</div>');
    let intent;
    try { intent = await call('createPaymentIntent', { purpose: 'service_booking', bookingId: _ctx.bookingId }); }
    catch (e) { body(`<div class="sbs-empty">${esc(e.message || 'Could not start payment.')}</div>`); return; }
    _ctx.ref = intent.ref; _ctx.amountKES = intent.amount;            /* KES from the server snapshot */
    const phone = (firebase.auth().currentUser && firebase.auth().currentUser.phoneNumber || '').replace('+', '');
    body(`
      <div class="sbs-note">${esc(_ctx.serviceName || 'Service')} · ${esc(_ctx.date)} ${esc(_ctx.time)}</div>
      <div class="sbs-price">KSh ${Number(_ctx.amountKES).toLocaleString()}</div>
      <div class="sbs-note">Paid to SOKONI and held until the service is completed. Deposit is refundable per the cancellation policy.</div>
      <input class="sbs-in" id="sbsPhone" inputmode="numeric" placeholder="M-Pesa number e.g. 0712345678" value="${esc(phone || '')}">
      <button class="sbs-btn" id="sbsPay" onclick="SokoniBookService._pay()">Pay with M-Pesa</button>
      <div class="sbs-note" id="sbsHold"></div>
      <div class="sbs-note" id="sbsPayNote"></div>`);
    startHoldCountdown();
  }

  /* Live countdown of the pre-payment hold. Purely informational — the SERVER hold
     (expiresAt) and the sweep are authoritative; this just tells the customer how long
     they have and disables Pay when the window closes (the snapshot then flips the slot
     to "expired — rebook" on its own). Self-cleans when the element is gone or on close. */
  function startHoldCountdown() {
    if (_holdTimer) { clearInterval(_holdTimer); _holdTimer = null; }
    if (!_ctx || !_ctx.expiresAt) return;
    const tick = () => {
      const el = document.getElementById('sbsHold');
      if (!el) { clearInterval(_holdTimer); _holdTimer = null; return; }
      const left = Math.max(0, Math.round((_ctx.expiresAt - Date.now()) / 1000));
      if (left <= 0) {
        clearInterval(_holdTimer); _holdTimer = null;
        el.textContent = '⌛ Reservation expired — pick another time.';
        const pay = document.getElementById('sbsPay'); if (pay) { pay.disabled = true; pay.textContent = 'Reservation expired'; }
        return;
      }
      const m = Math.floor(left / 60), s = left % 60;
      el.textContent = `Slot reserved — please pay within ${m}:${String(s).padStart(2, '0')}`;
    };
    tick();
    _holdTimer = setInterval(tick, 1000);
  }

  /* ── 4. STK push (amount is server-enforced against the intent). ── */
  async function pay() {
    const btn = document.getElementById('sbsPay'); const note = document.getElementById('sbsPayNote');
    const raw = (document.getElementById('sbsPhone').value || '').trim();
    const phone = raw.replace(/\D/g, '').replace(/^0/, '254');
    if (!/^254[17]\d{8}$/.test(phone)) { note.textContent = 'Enter a valid Kenyan M-Pesa number.'; return; }
    if (!global.SokoniIntaSend) { note.textContent = 'Payment unavailable right now. Please try again.'; return; }
    btn.disabled = true; btn.textContent = 'Check your phone…';        /* dup-click lock */
    try {
      await global.SokoniIntaSend.initiateSTKPush(phone, _ctx.amountKES, _ctx.ref,
        { meta: { type: 'service-booking', bookingId: _ctx.bookingId, providerId: _ctx.providerId } });
      note.textContent = 'Enter your M-Pesa PIN to confirm. This screen updates automatically.';
    } catch (e) { btn.disabled = false; btn.textContent = 'Pay with M-Pesa'; note.textContent = e.message || 'Could not send the M-Pesa request.'; }
  }

  /* ── Review surface (WS3) — a completed booking may be reviewed exactly once.
     Gated on b.status==='completed' (mirrors the server gate); b.reviewedAt (a
     server stamp) is the single source of truth for "already reviewed", so the
     snapshot re-fire after submit flips this to the thank-you state on its own. ── */
  function reviewPrompt(b) {
    const name = esc(_ctx.serviceName || b.service || 'your service');
    return `<div class="sbs-state" style="padding:8px 0">✅ Completed</div>
      <div class="sbs-note" style="text-align:center;margin-bottom:2px">How was ${name}? Your review helps other customers.</div>
      <div id="sbsStars" style="display:flex;justify-content:center;gap:6px;margin:12px 0">
        ${[1, 2, 3, 4, 5].map(n => `<button type="button" data-n="${n}" onclick="SokoniBookService._star(${n})" style="background:none;border:none;font-size:30px;line-height:1;cursor:pointer;filter:grayscale(1);opacity:.5" aria-label="${n} star${n === 1 ? '' : 's'}">⭐</button>`).join('')}
      </div>
      <textarea class="sbs-in" id="sbsReviewText" rows="3" placeholder="Add a comment (optional)"></textarea>
      <button class="sbs-btn" id="sbsReviewGo" disabled onclick="SokoniBookService._review()">Submit review</button>
      <button class="sbs-btn" style="background:#141414;color:#9a9a9a;margin-top:8px" onclick="SokoniBookService.close()">Maybe later</button>
      <div class="sbs-note" id="sbsReviewNote"></div>`;
  }
  function reviewDone(b) {
    return `<div class="sbs-state">✅ Completed</div>
      <div class="sbs-note" style="text-align:center">Thanks for your review${b.reviewRating ? ' · ' + b.reviewRating + '★' : ''}.</div>
      <button class="sbs-btn" onclick="SokoniBookService.close()">Done</button>`;
  }
  function star(n) {
    _ctx.reviewRating = n;
    document.querySelectorAll('#sbsStars button').forEach(b => { const on = Number(b.dataset.n) <= n; b.style.filter = on ? 'none' : 'grayscale(1)'; b.style.opacity = on ? '1' : '.5'; });
    const go = document.getElementById('sbsReviewGo'); if (go) go.disabled = false;
  }
  async function submitReview() {
    const go = document.getElementById('sbsReviewGo'); const note = document.getElementById('sbsReviewNote');
    const rating = Number(_ctx.reviewRating || 0);
    if (!(rating >= 1 && rating <= 5)) { if (note) note.textContent = 'Please choose a star rating.'; return; }
    const text = (document.getElementById('sbsReviewText') || {}).value || '';
    go.disabled = true; go.textContent = 'Submitting…';                 /* dup-click lock */
    try {
      await call('providerDispatch', { op: 'bookingSubmitReview', bookingId: _ctx.bookingId, rating, text });
      /* The server stamps reviewedAt → observe() re-fires and renders reviewDone().
         Fallback text in case the listener is momentarily detached: */
      if (note) note.textContent = 'Thank you for your review!';
    } catch (e) { go.disabled = false; go.textContent = 'Submit review'; if (note) note.textContent = e.message || 'Could not submit your review.'; }
  }

  /* ── 5. Observe the booking doc — every state comes from Firestore. ── */
  function observe(bookingId) {
    _ctx.bookingId = bookingId;
    if (_unsub) { _unsub(); _unsub = null; }
    _unsub = firebase.firestore().collection('providerBookings').doc(bookingId).onSnapshot(snap => {
      if (!snap.exists) return;
      const b = snap.data(); const st = stateOf(b);
      /* Once the booking leaves the unpaid-hold state, remember it so close() never
         releases a paid/terminal slot, and stop the hold countdown. */
      if (b.paymentStatus === 'paid_held' || b.paymentStatus === 'settled' || b.status === 'completed' || b.status === 'cancelled') {
        if (_ctx) _ctx.settled = true;
        if (_holdTimer) { clearInterval(_holdTimer); _holdTimer = null; }
      }
      if (b.paymentStatus === 'paid_held' || st.done) {
        /* A completed booking becomes reviewable (or shows the thank-you once reviewed). */
        if (b.status === 'completed') {
          title('Booking completed');
          body(b.reviewedAt ? reviewDone(b) : reviewPrompt(b));
          sessionStorage.removeItem(K);
          return;
        }
        title(st.tone === 'warn' ? 'Booking update' : 'Booking confirmed');
        body(`<div class="sbs-state">${st.label}</div>
          <div class="sbs-note" style="text-align:center">${esc(_ctx.serviceName || '')}${b.date ? ' · ' + esc(b.date) + ' ' + esc(b.startTime || '') : ''}</div>
          <button class="sbs-btn" onclick="SokoniBookService.close()">Done</button>`);
        if (b.paymentStatus === 'paid_held' || b.paymentStatus === 'settled' || b.status === 'cancelled') sessionStorage.removeItem(K);
      }
    }, () => { /* listener error — leave the last rendered state */ });
  }

  const Api = {
    open(opts) {
      _ctx = Object.assign({}, opts || {});
      if (!firebase.auth().currentUser) { location.href = 'login.html?next=' + encodeURIComponent(location.pathname + location.search); return; }
      show();
      if (_ctx.serviceId) loadSlots(); else loadServices();   /* per-service card → slots; generic → pick service first */
    },
    /* Open the modal directly on an existing booking to leave a review (WS4b — the
       persistent entry from the profile "My Bookings" list). Reuses the SAME observe()
       → reviewPrompt/reviewDone path and the same bookingSubmitReview submit, so there
       is exactly one review UI and one server gate. */
    review(opts) {
      _ctx = Object.assign({}, opts || {});
      if (!firebase.auth().currentUser) { location.href = 'login.html?next=' + encodeURIComponent(location.pathname + location.search); return; }
      if (!_ctx.bookingId) return;
      show(); title('Your booking'); body('<div class="sbs-empty">Loading…</div>');
      observe(_ctx.bookingId);                 /* renders reviewPrompt (completed+unreviewed) or reviewDone */
    },
    /* Resume an in-flight booking after a refresh — recover from the doc, not the flow. */
    resume() {
      let saved; try { saved = JSON.parse(sessionStorage.getItem(K) || 'null'); } catch (_) { saved = null; }
      if (!saved || !saved.bookingId || !firebase.auth().currentUser) return false;
      _ctx = Object.assign({}, saved);
      show(); title('Your booking'); body('<div class="sbs-empty">Restoring your booking…</div>');
      observe(saved.bookingId);
      return true;
    },
    close() {
      /* Leaving with an unpaid hold → free the slot NOW so it doesn't sit "ghost booked"
         until the sweep. Fire-and-forget; the server releases only an unpaid hold owned by
         this customer and no-ops otherwise, so this is safe even if payment just landed. */
      if (_ctx && _ctx.bookingId && !_ctx.settled) {
        try { call('providerDispatch', { op: 'bookingReleaseHold', bookingId: _ctx.bookingId }).catch(function () {}); } catch (_) {}
        try { sessionStorage.removeItem(K); } catch (_) {}
      }
      if (_holdTimer) { clearInterval(_holdTimer); _holdTimer = null; }
      if (_unsub) { _unsub(); _unsub = null; }
      const el = document.getElementById('sbsModal'); if (el) el.style.display = 'none'; document.body.style.overflow = '';
    },
    _pick: pick, _pickSvc: pickSvc, _create: create, _pay: pay, _star: star, _review: submitReview,
    _chooseOptions: chooseOptions, _opt: updatePreview, _continue: continueToBooking,   /* Slice D */
  };
  global.SokoniBookService = Api;
  /* Auto-resume if the customer refreshed mid-booking. */
  if (typeof firebase !== 'undefined' && firebase.auth) firebase.auth().onAuthStateChanged(u => { if (u) { try { Api.resume(); } catch (_) {} } });
})(window);
