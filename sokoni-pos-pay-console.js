/* ═══════════════════════════════════════════════════════════════════════════
   SOKONI POS — PAYMENT CONSOLE
   sokoni-pos-pay-console.js

   The cashier's payment surface. One sale, any number of tenders, in any
   combination the customer asks for:

       TOTAL   KES 4,850.00
       ────────────────────────────────
       💵 Cash        1,000.00   ✎  ✕
       📱 M-PESA      2,000.00   ✎  ✕
       💳 Card        1,850.00   ✎  ✕
       ────────────────────────────────
       ALLOCATED      4,850.00
       BALANCE            0.00   ✓ ready

   ── WHAT THIS ADDS, AND WHAT IT LEAVES ALONE ───────────────────────────────

   ADDITIVE. The existing Cash / M-PESA / M-PESA Till / Card / Split / QR
   buttons in pos.html stay exactly where they are and keep working. This is a
   second, richer surface reached from one new button, so a cashier who knows
   the old flow loses nothing and a busy till has a fallback if this has a bad
   day. Cash is not merely kept — it is the default tender and the only one
   that can complete a sale without the network.

   ── AMOUNT AUTO-FILL ───────────────────────────────────────────────────────

   Opening the console puts the WHOLE balance on the first tender the cashier
   taps. Tap Cash on a KES 4,850 sale and 4,850 is already there. Type 1,000
   over it and the next method you tap auto-fills 3,850. The cashier types only
   when they want something other than the obvious, which on a real till is
   most of the time exactly once per sale.

   ── WHY THE ARITHMETIC IS NOT IN THIS FILE ─────────────────────────────────

   Every number comes from SPosTender (sokoni-pos-tender.js), which is pure and
   separately tested to 76 assertions. This file renders and collects; it never
   decides what something costs or whether it is settled. A UI that did its own
   money arithmetic would be a second authority, and the two would drift.

   ── WHAT THIS SURFACE MAY NEVER DO ─────────────────────────────────────────

   Mark a sale PAID. An external tender is confirmed by webhookIntasend and by
   nothing else — not by a tile turning green, not by IntaSend's SDK firing
   COMPLETE in this browser. The console shows "Awaiting confirmation" and
   means it. This is the defect the payment audit found at marketplace
   checkout, and it is not going to be reintroduced at the till.

   Show a card field. The cashier must never see, type or store a PAN or CVV.
   Card is collected on the CUSTOMER's device through IntaSend's hosted page,
   reached by phone link, QR, or by handing over a customer-facing screen.
═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const T = (typeof window !== 'undefined' && window.SPosTender) || null;

  /* ── State ──────────────────────────────────────────────────────────── */
  let sheet     = null;
  let editing   = null;      /* methodId currently taking numpad input */
  let buffer    = '';        /* raw digits typed for `editing` */
  let capability = null;     /* what the SERVER says IntaSend has enabled */
  let onSettled = null;      /* callback into pos.js */

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s)
    .replace(/[<>"'&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '&': '&amp;' }[c]));

  /* ── Capability ─────────────────────────────────────────────────────────
     Read from the server, never guessed, never cached across sessions. Until
     it answers, the till offers cash and Till code — both of which work with
     no gateway at all. An unreachable capability endpoint must degrade to
     "sell for cash", never to "show a card button that cannot charge".

     UNKNOWN IS NOT AVAILABLE. scripts/probe-intasend-capability.js reports
     ENABLED / REFUSED / UNKNOWN and only ENABLED is ever written here. */
  async function loadCapability() {
    try {
      const fns = window.SPosPayCapabilitySource;
      if (typeof fns !== 'function') { capability = null; return; }
      const res = await fns();
      capability = (res && Array.isArray(res.enabled)) ? res : null;
    } catch (_) {
      capability = null;           /* fail to cash, loudly in the UI below */
    }
  }

  /* ── Open ───────────────────────────────────────────────────────────── */
  async function open(totalShillings, opts) {
    if (!T) { _toast('Payment engine not loaded — use the standard payment panel.', 'error'); return; }
    const total = T.fromShillings(totalShillings);
    if (!(total > 0)) { _toast('Nothing to charge.', 'error'); return; }

    onSettled = (opts && opts.onSettled) || null;
    editing = null;
    buffer  = '';

    if (capability === null) await loadCapability();
    sheet = T.createSheet(total, T.methodsFor(capability));

    render();
    const ov = $('paycon-modal');
    if (ov) ov.classList.add('open');
  }

  function close() {
    const ov = $('paycon-modal');
    if (ov) ov.classList.remove('open');
    sheet = null; editing = null; buffer = '';
  }

  /* ── Tender interaction ─────────────────────────────────────────────── */

  /* Tapping a method auto-fills the balance onto it and hands it the numpad.
     Tapping one that already holds an amount just focuses it for editing —
     re-auto-filling would silently overwrite a figure the cashier typed. */
  function tap(methodId) {
    if (!sheet) return;
    const held = sheet.allocations.find((a) => a.methodId === methodId);
    if (!held) {
      const r = T.autoFill(sheet, methodId);
      if (!r.ok) { _toast(r.error, 'error'); return; }
      sheet = r.sheet;
    }
    editing = methodId;
    buffer  = '';
    render();
  }

  function edit(methodId) { editing = methodId; buffer = ''; render(); }

  function drop(methodId) {
    if (!sheet) return;
    sheet = T.remove(sheet, methodId);
    if (editing === methodId) { editing = null; buffer = ''; }
    render();
  }

  /* Numpad writes into the tender currently being edited. Shillings in the
     buffer, cents in the sheet — converted at this single boundary. */
  function key(k) {
    if (!sheet || !editing) return;
    if (k === 'clear')      buffer = '';
    else if (k === 'back')  buffer = buffer.slice(0, -1);
    else if (k === 'exact') { const r = T.autoFill(T.remove(sheet, editing), editing);
                              if (r.ok) { sheet = r.sheet; buffer = ''; render(); } return; }
    else if (k === '.')     { if (!buffer.includes('.')) buffer += buffer ? '.' : '0.'; }
    else                    buffer += k;

    const r = T.allocate(sheet, editing, T.fromShillings(buffer || 0));
    if (!r.ok) {
      /* Refusals here are ordinary — a cashier typing 10000 into a card tender
         on a 150 bill. Say why, keep the last good figure, do not clear their
         work. */
      _toast(r.error, 'warn');
      buffer = buffer.slice(0, -1);
      return;
    }
    sheet = r.sheet;
    render();
  }

  function setRef(methodId, value) {
    if (!sheet) return;
    const held = sheet.allocations.find((a) => a.methodId === methodId);
    if (!held) return;
    const r = T.allocate(sheet, methodId, held.cents, { ref: String(value || '').trim().toUpperCase() });
    if (r.ok) { sheet = r.sheet; _renderFooter(); }
  }

  /* ── Customer-present delivery mode ─────────────────────────────────────
     How the customer reaches IntaSend's hosted page. The cashier never
     collects card data on this device under ANY of them. */
  let deliveryMode = 'phone';    /* phone | qr | handover */
  function setDelivery(m) { deliveryMode = m; render(); }

  /* ── Render ─────────────────────────────────────────────────────────── */
  function render() {
    if (!sheet) return;
    _renderMethods();
    _renderTenders();
    _renderFooter();
  }

  function _renderMethods() {
    const host = $('paycon-methods');
    if (!host) return;
    const held = new Set(sheet.allocations.map((a) => a.methodId));
    host.innerHTML = sheet.methods.map((m) => {
      const on  = held.has(m.id);
      const cls = 'paycon-m' + (on ? ' on' : '') + (editing === m.id ? ' editing' : '');
      return `<button class="${cls}" data-kind="${esc(m.kind)}" onclick="SPosPayConsole.tap('${esc(m.id)}')">
                <span class="paycon-m-i">${esc(m.icon || '•')}</span>
                <span class="paycon-m-l">${esc(m.label)}</span>
              </button>`;
    }).join('');

    /* Say plainly why the grid is short, rather than letting a cashier wonder
       whether card is broken or simply not switched on. */
    const note = $('paycon-cap-note');
    if (note) {
      if (capability === null) {
        note.textContent = 'Card and other methods unavailable — payment provider capability not confirmed. Cash and M-PESA Till always work.';
        note.style.display = 'block';
      } else {
        note.style.display = 'none';
      }
    }
  }

  function _renderTenders() {
    const host = $('paycon-tenders');
    if (!host) return;
    if (!sheet.allocations.length) {
      host.innerHTML = '<div class="paycon-empty">Tap a payment method to begin. The full amount fills in automatically.</div>';
      return;
    }
    host.innerHTML = sheet.allocations.map((a) => {
      const spec = T.methodSpec(sheet, a.methodId) || {};
      const live = editing === a.methodId;
      const refRow = spec.needsRef
        ? `<input class="paycon-ref" placeholder="M-PESA code" value="${esc(a.ref || '')}"
             oninput="SPosPayConsole.setRef('${esc(a.methodId)}', this.value)">`
        : '';
      const await_ = a.kind === T.KIND.EXTERNAL
        ? '<span class="paycon-await">awaits confirmation</span>' : '';
      return `<div class="paycon-t${live ? ' live' : ''}">
          <span class="paycon-t-i">${esc(spec.icon || '•')}</span>
          <span class="paycon-t-l">${esc(spec.label || a.methodId)}${await_}</span>
          <span class="paycon-t-v" onclick="SPosPayConsole.edit('${esc(a.methodId)}')">${esc(T.fmtKES(a.cents))}</span>
          <button class="paycon-t-x" onclick="SPosPayConsole.drop('${esc(a.methodId)}')" aria-label="Remove">✕</button>
          ${refRow}
        </div>`;
    }).join('');
  }

  function _renderFooter() {
    const bal    = T.balanceCents(sheet);
    const change = T.changeDueCents(sheet);
    const v      = T.validate(sheet);

    const set = (id, text) => { const el = $(id); if (el) el.textContent = text; };
    set('paycon-total',     T.fmtKES(sheet.totalCents));
    set('paycon-allocated', T.fmtKES(T.allocatedCents(sheet)));
    set('paycon-balance',   T.fmtKES(bal));

    const chRow = $('paycon-change-row');
    if (chRow) chRow.style.display = change > 0 ? 'flex' : 'none';
    set('paycon-change', T.fmtKES(change));

    const dl = $('paycon-delivery');
    if (dl) dl.style.display = T.needsCustomerDevice(sheet) ? 'block' : 'none';

    const btn = $('paycon-go');
    if (btn) {
      btn.disabled = !v.ok;
      btn.textContent = v.ok
        ? (T.needsCustomerDevice(sheet) ? 'Send to customer' : `Complete · ${T.fmtKES(sheet.totalCents)}`)
        : (v.problems[0] || 'Incomplete');
    }
  }

  /* ── Submit ─────────────────────────────────────────────────────────── */
  function submit() {
    if (!sheet) return;
    const out = T.toPayload(sheet);
    if (!out.ok) { _toast(out.problems[0], 'error'); return; }

    /* The console's job ends HERE. It hands a described payment to pos.js,
       which owns the sale, the intent and the server round-trip. It does not
       write a sale, does not call IntaSend, and above all does not decide that
       anything has been paid. */
    const payload = Object.assign({}, out.payload, { deliveryMode });
    if (typeof onSettled === 'function') {
      onSettled(payload);
    } else if (window.SPos && window.SPos.payment && typeof window.SPos.payment.completeMultiTender === 'function') {
      window.SPos.payment.completeMultiTender(payload);
    } else {
      _toast('Payment handler not wired — nothing was charged.', 'error');
      return;
    }
    close();
  }

  function _toast(msg, kind) {
    if (window.SPos && typeof window.SPos.toast === 'function') return window.SPos.toast(msg, kind || 'info');
    if (typeof window.toast === 'function') return window.toast(msg, kind || 'info');
    console.warn('[paycon]', msg);
  }

  window.SPosPayConsole = {
    open, close, tap, edit, drop, key, setRef, setDelivery, submit,
    /* exposed for tests and for pos.js to inspect without reaching into state */
    _sheet: () => sheet,
    _setCapability: (c) => { capability = c; },
  };
}());
