/* ═══════════════════════════════════════════════════════════════════════════
   sokoni-event-ops.js — Event Manager's event-day workspace (organizer + temporary staff).

   window.SokoniEventOps.mount(host, section, ctx)
     section: 'quicksale' | 'admission' | 'staff' | 'sales' | 'finance' | 'policy'
     ctx: { ops(op,data) → eventOpsDispatch, cf(name,data) → other callables,
            events: [{eventId,title,status,startDate}], role: 'organizer'|staff role, toast(msg) }

   The page only renders what the server says; it decides nothing about money:
     · Quick Sale sends tier ids + quantities — the SERVER prices the sale, claims the sale key,
       decrements inventory and issues tickets + PINs (functions/event-sales.js);
     · PIN admission sends the typed PIN for the SELECTED event (functions/event-ops.js);
     · Finance figures come from settlements; unknown renders "—", never 0.
   ═══════════════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  const kes = (cents) => (cents == null || !Number.isFinite(Number(cents)) ? '—' : 'KES ' + (Number(cents) / 100).toLocaleString('en-KE', { minimumFractionDigits: 0, maximumFractionDigits: 2 }));
  const num = (v) => (v == null || !Number.isFinite(Number(v)) ? '—' : Number(v).toLocaleString('en-KE'));
  const errText = (e) => String((e && e.message) || 'Something went wrong.').replace(/^FirebaseError:\s*/, '');
  const newKey = () => 'qs-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  const STYLE_ID = 'eo-style';
  const CSS = [
    '.eo{display:flex;flex-direction:column;gap:14px;max-width:760px}',
    '.eo-card{background:var(--bg2,#161b22);border:1px solid var(--border,#30363d);border-radius:12px;padding:14px}',
    '.eo-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}',
    '.eo-tiers{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px}',
    '.eo-tier{border:1px solid var(--border,#30363d);border-radius:10px;padding:10px;display:flex;flex-direction:column;gap:6px}',
    '.eo-tier b{font-size:15px}.eo-qty{display:flex;align-items:center;gap:10px}',
    '.eo .eo-qty input{width:64px;text-align:center;font-weight:800;padding:0 4px}',
    '.eo-qty button:disabled,.eo-btn:disabled{opacity:.4;cursor:not-allowed}',
    '.eo-note{font-size:12px;opacity:.75;margin:0}',
    '.eo-qty button,.eo-pay button,.eo-btn{min-height:44px;min-width:44px;border-radius:10px;border:1px solid var(--border,#30363d);background:var(--bg3,#21262d);color:inherit;font-weight:700;font-size:15px;cursor:pointer;padding:0 14px}',
    '.eo-pay{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px}',
    '.eo-pay button.on{border-color:var(--blue,#58a6ff);color:var(--blue,#58a6ff)}',
    '.eo-btn.primary{background:var(--blue,#58a6ff);color:#000;border-color:transparent}',
    '.eo-total{font-size:22px;font-weight:800}',
    '.eo input,.eo select{min-height:44px;border-radius:10px;border:1px solid var(--border,#30363d);background:var(--bg,#0d1117);color:inherit;padding:0 12px;font-size:16px;max-width:100%;box-sizing:border-box}',
    '.eo-pin{font:800 28px/1.2 ui-monospace,Menlo,monospace;letter-spacing:2px;padding:10px 14px;border-radius:10px;background:var(--bg3,#21262d);display:inline-block}',
    '.eo-ok{color:var(--green,#3fb950)}.eo-bad{color:var(--red,#f85149)}',
    '.eo-tbl{width:100%;border-collapse:collapse;font-size:13px}.eo-tbl td,.eo-tbl th{padding:6px 8px;border-bottom:1px solid var(--border,#30363d);text-align:left}',
    '.eo-scroll{overflow-x:auto}',
    /* Narrow screens: every control fits its container; a long event title in a <select> must not
       widen the page (its intrinsic width is its longest option). */
    '.eo label{display:block;max-width:100%}.eo select,.eo input{max-width:100%}.eo-row>*{min-width:0;max-width:100%}',
    '@media (max-width:600px){.eo select,.eo-row input{width:100%}.eo-row{flex-direction:column;align-items:stretch}}',
  ].join('');
  function css() { if (!document.getElementById(STYLE_ID)) { const s = document.createElement('style'); s.id = STYLE_ID; s.textContent = CSS; document.head.appendChild(s); } }

  function eventSelect(ctx, id, filter) {
    const evs = (ctx.events || []).filter(filter || (() => true));
    return `<select id="${id}" aria-label="Event">${evs.length ? evs.map((e) => `<option value="${esc(e.eventId)}">${esc(e.title)}${e.startDate ? ' — ' + esc(new Date(e.startDate).toLocaleDateString('en-KE')) : ''}</option>`).join('') : '<option value="">No events available</option>'}</select>`;
  }

  /* ═══ QUICK SALE ═══ */
  function quicksale(host, ctx) {
    host.innerHTML = `<div class="eo">
      <div class="eo-pay" role="tablist" aria-label="Quick Sale mode">
        <button type="button" role="tab" data-qsmode="sale" class="on" aria-selected="true">New sale</button>
        <button type="button" role="tab" data-qsmode="check" aria-selected="false">Check ticket (PIN)</button></div>
      <div id="qsCheck" hidden></div>
      <div id="qsSale" style="display:flex;flex-direction:column;gap:14px">
      <div class="eo-card"><div class="eo-row"><label>Event ${eventSelect(ctx, 'qsEv', (e) => e.status === 'live')}</label></div></div>
      <div class="eo-card"><div id="qsTiers" class="eo-tiers">Loading tickets…</div></div>
      <div class="eo-card"><div class="eo-row" style="justify-content:space-between"><span>Total</span><span class="eo-total" id="qsTotal">KES 0</span></div>
        <p class="eo-note" id="qsLines" style="margin-top:6px"></p>
        <p style="font-size:12px;opacity:.7;margin:6px 0 0">The server prices the sale; this total is a preview.</p>
        <button type="button" class="eo-btn" id="qsClear" style="margin-top:8px" disabled>Clear tickets</button></div>
      <div class="eo-card"><div class="eo-pay" role="group" aria-label="Payment">
        <button type="button" data-tender="cash">Cash</button><button type="button" data-tender="intasend">M-PESA</button><button type="button" data-tender="card_external">Card (terminal)</button></div>
        <div id="qsTender" style="margin-top:10px"></div></div>
      <button type="button" class="eo-btn primary" id="qsDo" disabled>Complete sale</button>
      <div id="qsMsg" role="status" aria-live="polite"></div>
      <div id="qsOut"></div></div></div>`;
    const cart = {}; let tiers = []; let tender = null; let key = newKey();
    const $ = (id) => host.querySelector('#' + id);
    const total = () => tiers.reduce((a, t) => a + (cart[t.tierId] || 0) * Math.round(Number(t.price) * 100), 0);
    /* The most a cashier can put in the cart for one ticket type: what is left, and the server's
       50-per-line limit. The server re-checks both inside the sale transaction — this only keeps
       the cashier from building a cart that will be refused. */
    const maxFor = (t) => Math.max(0, Math.min(50, (Number(t.quantity) || 0) - (Number(t.sold) || 0)));
    const linesIn = () => tiers.filter((t) => (cart[t.tierId] || 0) > 0);
    /* M-PESA at the till is one ticket type per sale (a single order through the canonical intent). */
    const mpesaMixed = () => tender === 'intasend' && linesIn().length > 1;
    const setQty = (id, v) => {
      const t = tiers.find((x) => x.tierId === id); if (!t) return;
      const n = Math.max(0, Math.min(maxFor(t), Math.floor(Number(v) || 0)));
      if ((cart[id] || 0) !== n) key = newKey();          /* a different cart is a different sale */
      cart[id] = n;
    };
    const paint = () => {
      $('qsTotal').textContent = kes(total());
      const ls = linesIn();
      $('qsLines').textContent = ls.length ? ls.map((t) => `${cart[t.tierId]} × ${t.name}`).join(' · ') : 'No tickets selected.';
      tiers.forEach((t) => {
        const q = cart[t.tierId] || 0, max = maxFor(t);
        const inp = host.querySelector(`[data-q="${t.tierId}"]`); if (inp && document.activeElement !== inp) inp.value = String(q);
        const dec = host.querySelector(`[data-dec="${t.tierId}"]`), inc = host.querySelector(`[data-inc="${t.tierId}"]`);
        if (dec) dec.disabled = q <= 0;
        if (inc) inc.disabled = q >= max;
      });
      $('qsClear').disabled = !ls.length;
      $('qsDo').disabled = !(total() > 0 && tender) || mpesaMixed();
      if (mpesaMixed()) $('qsMsg').innerHTML = '<span class="eo-bad">M-PESA takes one ticket type per sale — remove the other type, or use Cash / Card.</span>';
      else if (/one ticket type per sale/.test($('qsMsg').textContent)) $('qsMsg').textContent = '';
      host.querySelectorAll('[data-tender]').forEach((b) => b.classList.toggle('on', b.dataset.tender === tender));
    };
    async function loadTiers() {
      const eventId = $('qsEv').value;
      Object.keys(cart).forEach((k) => delete cart[k]); key = newKey();
      if (!eventId) { $('qsTiers').textContent = 'No live event.'; return; }
      try {
        const ev = await ctx.cf('getEvent', { eventId });
        tiers = (ev.tiers || []).filter((t) => Number(t.price) > 0);
        $('qsTiers').innerHTML = tiers.length ? tiers.map((t) => `<div class="eo-tier"><b>${esc(t.name)}</b><span>${kes(Math.round(Number(t.price) * 100))} · <span data-left="${esc(t.tierId)}">${num(Number(t.quantity) - Number(t.sold))}</span> left</span>
          <div class="eo-qty"><button type="button" data-dec="${esc(t.tierId)}" aria-label="Remove one ${esc(t.name)}">−</button><input type="number" inputmode="numeric" min="0" max="${maxFor(t)}" step="1" value="0" data-q="${esc(t.tierId)}" aria-label="${esc(t.name)} quantity"><button type="button" data-inc="${esc(t.tierId)}" aria-label="Add one ${esc(t.name)}">+</button></div></div>`).join('') : 'No paid ticket types on sale.';
      } catch (e) { $('qsTiers').textContent = errText(e); }
      paint();
    }
    function tenderForm() {
      const f = $('qsTender');
      if (tender === 'cash') f.innerHTML = '<label>Cash received (KES) <input id="qsCash" type="number" inputmode="decimal" min="0"></label>';
      else if (tender === 'card_external') f.innerHTML = `<div class="eo-row"><label>Terminal <select id="qsProv">${['pesapal', 'kcb', 'equity', 'coop', 'absa', 'ncba', 'stanbic', 'dtb', 'ipay', 'flutterwave', 'other'].map((p) => `<option>${p}</option>`).join('')}</select></label>
        <label>Transaction reference <input id="qsRef" autocomplete="off" placeholder="from the terminal slip"></label></div>
        <p style="font-size:12px;opacity:.75">No reference yet? Leave it empty — the sale is held as pending and tickets are issued only when you record the reference.</p>`;
      else if (tender === 'intasend') f.innerHTML = '<label>Buyer M-PESA number <input id="qsPhone" type="tel" inputmode="tel" placeholder="07XX XXX XXX"></label>';
      else f.innerHTML = '';
    }
    let lastSale = null;
    /* SALE COMPLETE — one card per ticket (ticket number + its own PIN), with Show / Print / Send.
       The PIN comes from the server for this cashier's walk-in sale; nothing is kept in storage. */
    async function showTickets(eventId, saleId) {
      const r = await ctx.ops('eventSaleTickets', { eventId, saleId });
      /* the fiscal (KRA) state belongs to the SALE; every ticket of it shows the same one */
      r.tickets = r.tickets.map((t) => ({ ...t, fiscal: r.fiscal }));
      lastSale = r;
      const T = root.SokoniEventTicket;
      const issued = r.tickets.filter((t) => t.pin);
      $('qsOut').innerHTML = `<div class="eo-card"><b class="eo-ok">SALE COMPLETE</b> · ${issued.length} ticket${issued.length === 1 ? '' : 's'} — give each buyer their own PIN
        <div id="qsTix" style="margin-top:12px">${r.tickets.map((t) => (T ? T.html(t, r.event, { actions: !!t.pin })
          : `<div><div style="font-size:12px;opacity:.75">${esc(t.tierName)} · ${esc(t.ticketNumber || '')}</div>${t.pin ? `<span class="eo-pin">${esc(t.pin)}</span>` : '<span class="eo-bad">Not issued</span>'}</div>`)).join('')}</div></div>`;
      if (T) T.drawQr($('qsOut'));
    }
    const ticketOf = (num) => (lastSale && lastSale.tickets.find((t) => t.ticketNumber === num)) || null;
    const cardOf = (num) => [...host.querySelectorAll('.sk-ticket')].find((a) => a.dataset.ticket === num) || null;
    host.addEventListener('click', async (e) => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.qsmode) {
        const check = b.dataset.qsmode === 'check';
        host.querySelectorAll('[data-qsmode]').forEach((x) => { const on = x === b; x.classList.toggle('on', on); x.setAttribute('aria-selected', String(on)); });
        $('qsSale').style.display = check ? 'none' : 'flex';
        $('qsCheck').hidden = !check;
        /* the SAME admission screen and authority as the gate (eventVerifyPin / eventAdmitTicket) */
        if (check) { const box = document.createElement('div'); $('qsCheck').replaceChildren(box); admission(box, ctx); }
        return;
      }
      if (b.dataset.tkShow || b.dataset.tkPrint || b.dataset.tkSend) {
        const T = root.SokoniEventTicket; const num = b.dataset.tkShow || b.dataset.tkPrint || b.dataset.tkSend;
        const t = ticketOf(num); const card = cardOf(num);
        if (!T || !t || !card) return;
        if (b.dataset.tkPrint) { if (!T.printTickets(card)) $('qsMsg').textContent = 'Allow pop-ups to print the ticket.'; return; }
        if (b.dataset.tkSend) { await T.send(t, lastSale.event); return; }
        /* Show: the ticket full-screen so the buyer can photograph it */
        const ov = document.createElement('div');
        ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true'); ov.setAttribute('aria-label', 'Ticket ' + num);
        ov.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.85);overflow:auto;padding:16px;box-sizing:border-box';
        ov.innerHTML = T.html(t, lastSale.event, {}) + '<div style="text-align:center"><button type="button" class="eo-btn" data-tk-close="1">Close</button></div>';
        document.body.appendChild(ov); T.drawQr(ov);
        ov.addEventListener('click', (ev) => { if (ev.target === ov || ev.target.closest('[data-tk-close]')) ov.remove(); });
        ov.querySelector('[data-tk-close]').focus();
        return;
      }
      if (b.dataset.inc || b.dataset.dec) {
        const id = b.dataset.inc || b.dataset.dec;
        setQty(id, (cart[id] || 0) + (b.dataset.inc ? 1 : -1)); paint(); return;
      }
      if (b.id === 'qsClear') { Object.keys(cart).forEach((k) => setQty(k, 0)); paint(); return; }
      if (b.dataset.tender) { tender = b.dataset.tender; tenderForm(); paint(); return; }
      if (b.id === 'qsDo') {
        const eventId = $('qsEv').value; const items = Object.entries(cart).filter(([, q]) => q > 0).map(([tierId, qty]) => ({ tierId, qty }));
        const data = { eventId, items, tender, idempotencyKey: key };
        if (tender === 'cash') data.cashReceivedKes = Number($('qsCash').value);
        if (tender === 'card_external' && $('qsRef').value.trim()) data.card = { provider: $('qsProv').value, reference: $('qsRef').value.trim(), amountKes: total() / 100 };
        let phone = null;
        if (tender === 'intasend') { phone = String($('qsPhone').value || '').replace(/\s/g, ''); if (!/^(\+?254|0)[17]\d{8}$/.test(phone)) { $('qsMsg').textContent = 'Enter a valid Safaricom number.'; return; } phone = phone.replace(/^\+/, '').replace(/^0/, '254'); }
        b.disabled = true; $('qsMsg').textContent = 'Recording sale…'; $('qsOut').innerHTML = '';
        try {
          const r = await ctx.ops('eventQuickSale', data);
          if (r.status === 'COMPLETED') {
            $('qsMsg').innerHTML = `<span class="eo-ok">✓ Sale recorded${r.changeCents ? ' · change ' + kes(r.changeCents) : ''}</span>`;
            await showTickets(eventId, r.saleId);
          } else if (r.status === 'PENDING_EXTERNAL') {
            $('qsMsg').innerHTML = `Card sale held (seats reserved). Record the terminal reference to issue tickets.`;
            $('qsOut').innerHTML = `<div class="eo-card"><div class="eo-row"><select id="qsProv2">${['pesapal', 'kcb', 'equity', 'coop', 'absa', 'ncba', 'stanbic', 'dtb', 'ipay', 'flutterwave', 'other'].map((p) => `<option>${p}</option>`).join('')}</select><input id="qsRef2" placeholder="Transaction reference"><button type="button" class="eo-btn" id="qsConf" data-sale="${esc(r.saleId)}">Record reference</button><button type="button" class="eo-btn" id="qsCancel" data-sale="${esc(r.saleId)}">Cancel sale</button></div></div>`;
          } else if (r.status === 'AWAITING_PAYMENT') {
            $('qsMsg').textContent = 'Sending the M-PESA prompt to the buyer…';
            const intent = await ctx.cf('createPaymentIntent', { purpose: 'event_ticket', orderId: r.saleId, phone });
            await ctx.cf('initiateSTKPush', { phone, ref: intent.ref, amount: intent.amount, meta: { type: 'event_ticket' } });
            $('qsMsg').textContent = '📲 Ask the buyer to enter their M-PESA PIN. Tickets appear here when the payment is confirmed.';
            const until = Date.now() + 180000;
            while (Date.now() < until) {
              await new Promise((res) => setTimeout(res, 4000));
              const t = await ctx.ops('eventSaleTickets', { eventId, saleId: r.saleId }).catch(() => null);
              if (t && t.status === 'COMPLETED') { $('qsMsg').innerHTML = '<span class="eo-ok">✓ Payment confirmed</span>'; await showTickets(eventId, r.saleId); break; }
            }
          }
          /* Sold (or handed to M-PESA): empty the cart and re-read what is left from the server. */
          if (r.status === 'COMPLETED' || r.status === 'AWAITING_PAYMENT') await loadTiers();
        } catch (err) { $('qsMsg').innerHTML = `<span class="eo-bad">${esc(errText(err))}</span>`; }
        paint(); return;
      }
      if (b.id === 'qsConf') {
        try { const r = await ctx.ops('eventConfirmExternalCard', { eventId: $('qsEv').value, saleId: b.dataset.sale, provider: $('qsProv2').value, reference: $('qsRef2').value, amountKes: total() / 100 || undefined });
          $('qsMsg').innerHTML = '<span class="eo-ok">✓ Card sale recorded</span>'; await showTickets($('qsEv').value, r.saleId); }
        catch (err) { $('qsMsg').innerHTML = `<span class="eo-bad">${esc(errText(err))}</span>`; }
        return;
      }
      if (b.id === 'qsCancel') {
        try { await ctx.ops('eventCancelPendingSale', { eventId: $('qsEv').value, saleId: b.dataset.sale }); $('qsOut').innerHTML = ''; $('qsMsg').textContent = 'Pending sale cancelled; seats released.'; }
        catch (err) { $('qsMsg').innerHTML = `<span class="eo-bad">${esc(errText(err))}</span>`; }
      }
    });
    $('qsEv').addEventListener('change', loadTiers);
    /* A typed quantity: clamped to 0..what is left (and 50) when the cashier leaves the field. */
    host.addEventListener('input', (e) => { const i = e.target.closest('[data-q]'); if (i) { setQty(i.dataset.q, i.value); paint(); } });
    host.addEventListener('change', (e) => { const i = e.target.closest('[data-q]'); if (i) { setQty(i.dataset.q, i.value); i.value = String(cart[i.dataset.q] || 0); paint(); } });
    loadTiers();
  }

  /* ═══ PIN ADMISSION ═══ */
  function admission(host, ctx) {
    host.innerHTML = `<div class="eo">
      <div class="eo-card"><label>Event ${eventSelect(ctx, 'adEv')}</label></div>
      <div class="eo-card"><label for="adPin">Ticket PIN</label>
        <div class="eo-row"><input id="adPin" autocomplete="off" inputmode="numeric" pattern="[0-9]*" spellcheck="false" placeholder="0000" maxlength="5" aria-label="4-digit ticket PIN" style="font:800 28px ui-monospace,monospace;letter-spacing:6px;width:150px;text-align:center">
        <button type="button" class="eo-btn" id="adVerify">Check ticket</button></div></div>
      <div id="adOut" role="status" aria-live="polite"></div></div>`;
    const $ = (id) => host.querySelector('#' + id);
    const session = 'gate-' + Math.random().toString(36).slice(2, 10);
    let shown = null;
    async function verify() {
      const pin = $('adPin').value;
      $('adOut').textContent = 'Checking…';
      try {
        const r = await ctx.ops('eventVerifyPin', { eventId: $('adEv').value, pin });
        if (!r.valid) { $('adOut').innerHTML = `<div class="eo-card eo-bad">✗ ${esc(r.reason)}</div>`; return; }
        const t = r.ticket;
        shown = t.ticketNumber || null;
        /* CHECK TICKET → the PIN's ticket is shown by its NUMBER; staff confirm the attendee's ticket carries
           that number before admitting (the server refuses an admission without it). */
        $('adOut').innerHTML = `<div class="eo-card">
          <div style="font-size:12px;opacity:.75">EVENT</div><div><b>${esc(t.event || '')}</b></div>
          <div style="font-size:12px;opacity:.75;margin-top:8px">TICKET</div><div class="eo-tnum" style="font:800 20px ui-monospace,monospace;overflow-wrap:anywhere">${esc(t.ticketNumber || '—')}</div>
          <div style="font-size:12px;opacity:.75;margin-top:8px">TYPE</div><div>${esc(t.tierName || '')}${t.attendeeInitials ? ' · ' + esc(t.attendeeInitials) : ''}</div>
          <div style="font-size:12px;opacity:.75;margin-top:8px">STATUS</div><div>${esc(String(t.admissionStatus || '').replace('_', ' '))}${t.refundStatus && t.refundStatus !== 'NONE' ? ' · Refund: ' + esc(t.refundStatus) : ''}</div>
          ${r.admissible ? `<label style="display:flex;gap:10px;align-items:flex-start;margin-top:12px;font-weight:600">
              <input type="checkbox" id="adMatch" style="min-width:22px;min-height:22px;margin-top:2px"> The ticket the attendee shows has the number <span style="font-family:ui-monospace,monospace">${esc(t.ticketNumber || '')}</span></label>
            <div class="eo-row" style="margin-top:10px"><button type="button" class="eo-btn primary" id="adAdmit" disabled>CONFIRM ADMISSION</button>
              <button type="button" class="eo-btn" id="adNoMatch">Doesn't match</button></div>`
          : `<div class="eo-bad" style="margin-top:10px">${esc(r.reason)}</div>`}</div>`;
      } catch (e) { $('adOut').innerHTML = `<div class="eo-card eo-bad">${esc(errText(e))}</div>`; }
    }
    host.addEventListener('change', (e) => { if (e.target.id === 'adMatch') { const b = $('adAdmit'); if (b) b.disabled = !e.target.checked; } });
    host.addEventListener('click', async (e) => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.id === 'adVerify') return verify();
      if (b.id === 'adNoMatch') {
        b.disabled = true;
        try { await ctx.ops('eventAdmissionMismatch', { eventId: $('adEv').value, pin: $('adPin').value });
          $('adOut').innerHTML = '<div class="eo-card eo-bad">✗ Not admitted — the ticket number did not match. This has been recorded.</div>'; }
        catch (err) { $('adOut').innerHTML = `<div class="eo-card eo-bad">${esc(errText(err))}</div>`; }
        $('adPin').value = ''; $('adPin').focus(); shown = null;
        return;
      }
      if (b.id === 'adAdmit') {
        if (!$('adMatch') || !$('adMatch').checked) return;
        b.disabled = true;
        try { const r = await ctx.ops('eventAdmitTicket', { eventId: $('adEv').value, pin: $('adPin').value, confirmTicketNumber: shown, deviceSession: session });
          $('adOut').innerHTML = r.result === 'admitted' ? '<div class="eo-card eo-ok">✓ Admitted</div>' : `<div class="eo-card eo-bad">✗ ${esc(r.reason || (r.result === 'already_admitted' ? 'Already admitted' : r.result))}</div>`;
          $('adPin').value = ''; $('adPin').focus(); shown = null; }
        catch (err) { $('adOut').innerHTML = `<div class="eo-card eo-bad">${esc(errText(err))}</div>`; }
      }
    });
    $('adPin').addEventListener('keydown', (e) => { if (e.key === 'Enter') verify(); });
  }

  /* ═══ STAFF ═══ */
  function staff(host, ctx) {
    host.innerHTML = `<div class="eo">
      <div class="eo-card"><label>Event ${eventSelect(ctx, 'stEv')}</label></div>
      <div class="eo-card"><b>Add temporary staff</b>
        <div class="eo-row" style="margin-top:8px"><input id="stEmail" type="email" placeholder="staff email" autocomplete="off">
        <select id="stRole"><option value="cashier">Cashier</option><option value="admission">Admission / gate</option><option value="marketing">Marketing</option><option value="manager">Event manager</option></select>
        <button type="button" class="eo-btn primary" id="stAdd">Invite</button></div>
        <p style="font-size:12px;opacity:.75">Staff sign in with this email and open the invitation link. Access ends 12 hours after the event unless you revoke it sooner. Staff never see your wallet, payouts or other events.</p>
        <div id="stLink"></div></div>
      <div class="eo-card eo-scroll" id="stList">Loading…</div>
      <div id="stMsg" role="status" aria-live="polite"></div></div>`;
    const $ = (id) => host.querySelector('#' + id);
    async function list() {
      try {
        const r = await ctx.ops('eventStaffList', { eventId: $('stEv').value });
        const rows = r.staff.map((s) => `<tr><td>${esc(s.email || s.uid)}</td><td>${esc(s.role)}</td><td>${s.live ? '<span class="eo-ok">active</span>' : esc(s.status === 'revoked' ? 'revoked' : 'expired')}</td><td>${s.endAt ? esc(new Date(s.endAt).toLocaleString('en-KE')) : '—'}</td><td>${s.live ? `<button type="button" class="eo-btn" data-revoke="${esc(s.uid)}">Revoke</button>` : ''}</td></tr>`).join('')
          + r.invites.filter((i) => i.status === 'pending').map((i) => `<tr><td>${esc(i.email)}</td><td>${esc(i.role)}</td><td>invited</td><td>${i.endAt ? esc(new Date(i.endAt).toLocaleString('en-KE')) : '—'}</td><td><button type="button" class="eo-btn" data-revoke-email="${esc(i.email)}">Cancel</button></td></tr>`).join('');
        $('stList').innerHTML = rows ? `<table class="eo-tbl"><thead><tr><th>Staff</th><th>Role</th><th>Status</th><th>Access ends</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : 'No staff yet.';
      } catch (e) { $('stList').textContent = errText(e); }
    }
    host.addEventListener('click', async (e) => {
      const b = e.target.closest('button'); if (!b) return;
      try {
        if (b.id === 'stAdd') {
          await ctx.ops('eventStaffInvite', { eventId: $('stEv').value, email: $('stEmail').value, role: $('stRole').value });
          const link = location.origin + '/event-manager.html?staffInvite=' + encodeURIComponent($('stEv').value);
          $('stLink').innerHTML = `<p>Share this link with them: <input readonly value="${esc(link)}" style="width:100%"></p>`;
          $('stEmail').value = '';
        } else if (b.dataset.revoke) await ctx.ops('eventStaffRevoke', { eventId: $('stEv').value, uid: b.dataset.revoke, reason: 'revoked by organizer' });
        else if (b.dataset.revokeEmail) await ctx.ops('eventStaffRevoke', { eventId: $('stEv').value, email: b.dataset.revokeEmail });
        else return;
        $('stMsg').innerHTML = '<span class="eo-ok">Saved.</span>'; list();
      } catch (err) { $('stMsg').innerHTML = `<span class="eo-bad">${esc(errText(err))}</span>`; }
    });
    $('stEv').addEventListener('change', list);
    list();
  }

  /* ═══ SALES ═══ */
  function sales(host, ctx) {
    host.innerHTML = `<div class="eo"><div class="eo-card"><label>Event ${eventSelect(ctx, 'slEv')}</label></div><div id="slOut" class="eo-card eo-scroll">Loading…</div></div>`;
    const $ = (id) => host.querySelector('#' + id);
    async function load() {
      try {
        const r = await ctx.ops('eventListSales', { eventId: $('slEv').value });
        const by = Object.entries(r.byTender || {}).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${num(v.count)}</td><td>${num(v.tickets)}</td><td>${kes(v.grossCents)}</td></tr>`).join('');
        const rows = r.sales.slice(0, 200).map((s) => `<tr><td>${esc(s.createdAt ? new Date(s.createdAt).toLocaleString('en-KE') : '—')}</td><td>${esc(s.tender)}</td><td>${esc(s.status)}</td><td>${num(s.quantity)}</td><td>${kes(s.grossCents)}</td></tr>`).join('');
        $('slOut').innerHTML = `<b>${r.scope === 'mine' ? 'Your sales' : 'All sales at the door'}</b>${r.capped ? ' <span class="eo-bad">(showing the first 500)</span>' : ''}
          <table class="eo-tbl" style="margin:8px 0 16px"><thead><tr><th>Payment</th><th>Sales</th><th>Tickets</th><th>Total</th></tr></thead><tbody>${by || '<tr><td colspan="4">No completed sales yet.</td></tr>'}</tbody></table>
          <table class="eo-tbl"><thead><tr><th>Time</th><th>Payment</th><th>Status</th><th>Tickets</th><th>Total</th></tr></thead><tbody>${rows || '<tr><td colspan="5">—</td></tr>'}</tbody></table>`;
      } catch (e) { $('slOut').textContent = errText(e); }
    }
    $('slEv').addEventListener('change', load); load();
  }

  /* ═══ FINANCE ═══ */
  function finance(host, ctx) {
    host.innerHTML = `<div class="eo"><div class="eo-card"><label>Event ${eventSelect(ctx, 'fnEv')}</label></div><div id="fnOut" class="eo-card">Loading…</div>
      <p style="font-size:12px;opacity:.75">Online proceeds are paid to your SOKONI wallet 24 hours after the event ends. Withdraw from your <a href="/wallet.html">wallet</a>.</p></div>`;
    const $ = (id) => host.querySelector('#' + id);
    async function load() {
      try {
        const r = await ctx.ops('eventFinance', { eventId: $('fnEv').value });
        if (r.capped) { $('fnOut').textContent = 'Too many records to total here — contact support for a statement.'; return; }
        const row = (l, v) => `<tr><td>${esc(l)}</td><td style="text-align:right"><b>${v}</b></td></tr>`;
        $('fnOut').innerHTML = `<table class="eo-tbl">${
          row('Tickets sold (paid)', num(r.ticketsSold)) + row('Gross ticket sales', kes(r.grossCents))
          + row('Online sales', kes(r.online.grossCents)) + row('Payment-provider fees', kes(r.online.providerFeeCents))
          + row('SOKONI commission (online, 3%)', kes(r.online.commissionCents)) + row('Held — paid after the event', kes(r.online.heldCents))
          + row('Paid to your wallet', kes(r.online.releasedCents))
          + row('Door sales (you collected)', kes(r.door.grossCents)) + row('SOKONI commission on door sales', kes(r.door.commissionCents))
          + row('Door commission still owed', kes(r.commissionReceivable.outstandingCents)) + row('Door commission settled', kes(r.commissionReceivable.collectedCents))
          + row('Refund requests', num(r.refunds.requested)) + row('Refunded', `${num(r.refunds.refunded)} · ${kes(r.refunds.refundedCents)}`)
        }</table>${r.online.awaitingFeeCount ? `<p class="eo-bad">${num(r.online.awaitingFeeCount)} payment(s) await the provider fee; those figures show "—" until it is confirmed.</p>` : ''}`;
      } catch (e) { $('fnOut').textContent = errText(e); }
    }
    $('fnEv').addEventListener('change', load); load();
  }

  /* ═══ REFUND POLICY (organizer, before sales) ═══ */
  function policy(host, ctx) {
    const ev = ctx.event || {};
    const p = ev.refundPolicy || null;
    host.innerHTML = `<div class="eo-card"><b>Refund policy</b> ${p ? '' : '<span class="eo-bad">— required before publishing</span>'}
      <div class="eo-row" style="margin-top:8px">
        <label><input type="radio" name="rpMode" value="none" ${!p || p.mode === 'none' ? 'checked' : ''}> No refunds</label>
        <label><input type="radio" name="rpMode" value="before_cutoff" ${p && p.mode === 'before_cutoff' ? 'checked' : ''}> Refunds until a deadline</label></div>
      <label style="display:block;margin-top:8px">Refund deadline <input type="datetime-local" id="rpCut"></label>
      <label style="display:block;margin-top:8px"><input type="checkbox" id="rpNoShow" ${p && p.noShowRefund ? 'checked' : ''}> Allow refunds for tickets that were not used (no-shows)</label>
      <p style="font-size:12px;opacity:.75">Buyers see this before they pay. It locks once the first ticket is sold.</p>
      <button type="button" class="eo-btn primary" id="rpSave">Save refund policy</button> <span id="rpMsg" role="status"></span></div>`;
    host.querySelector('#rpSave').onclick = async () => {
      const mode = (host.querySelector('input[name=rpMode]:checked') || {}).value;
      const cut = host.querySelector('#rpCut').value;
      try { await ctx.ops('eventSetRefundPolicy', { eventId: ev.eventId, mode, cutoffAt: cut ? new Date(cut).toISOString() : null, noShowRefund: host.querySelector('#rpNoShow').checked });
        host.querySelector('#rpMsg').innerHTML = '<span class="eo-ok">Saved.</span>'; }
      catch (e) { host.querySelector('#rpMsg').innerHTML = `<span class="eo-bad">${esc(errText(e))}</span>`; }
    };
  }

  const RENDER = { quicksale, admission, staff, sales, finance, policy };
  function mount(host, section, ctx) {
    if (!host || !RENDER[section]) return false;
    css();
    /* Render into a FRESH element every time: each renderer attaches listeners to its host, and a
       section is re-mounted whenever it is shown — re-using the old element stacked listeners, so one
       tap on "Admit" fired two admissions (the second answering "Already admitted"). */
    const fresh = host.cloneNode(false);
    host.replaceWith(fresh);
    RENDER[section](fresh, ctx || {});
    return true;
  }
  /* Which sections a staff role may see (mirrors functions/event-ops.js STAFF_ROLES). The SERVER
     re-checks every call; this only avoids showing controls a role cannot execute. */
  const SECTIONS_FOR = Object.freeze({
    organizer: ['quicksale', 'admission', 'staff', 'sales', 'finance'],
    cashier: ['quicksale', 'sales'], admission: ['admission'], marketing: ['promo'], manager: ['quicksale', 'admission', 'sales', 'promo'],
  });
  root.SokoniEventOps = { mount, SECTIONS_FOR, _kes: kes };
}(typeof window !== 'undefined' ? window : globalThis));
