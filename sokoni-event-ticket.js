/* ═══════════════════════════════════════════════════════════════════════════
   sokoni-event-ticket.js — the ONE event-ticket presentation (buyer My Tickets,
   cashier Quick Sale: show / print / send).

   A ticket shows two identities and two QR areas that are NEVER the same thing:
     TICKET  SK-EVT-YYYY-NNNNNN   the permanent identity
     PIN     NNNN                 the event-day admission credential (staff type it; no scanner)
     SOKONI TICKET QR             optional convenience: encodes only SOKONI's ticket reference
                                  (sokoni-ticket:<ticketId>:<token>) — never the PIN
     KRA / FISCAL                 ONLY what KRA returned for this sale (event-fiscal view): the
                                  KRA-issued QR image and receipt number when CONFIRMED;
                                  otherwise the fiscal STATUS in words. Nothing is generated.

   All values are escaped; the KRA image must be an https URL (checked here AND by the server).
   The QR is drawn locally by sokoni-qr.js (no network). Without it, the QR area says so.
   ═══════════════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const httpsUrl = (u) => (typeof u === 'string' && /^https:\/\/[^\s"'<>]+$/.test(u) ? u : null);
  const STYLE_ID = 'sk-ticket-style';
  const CSS = [
    '.sk-ticket{max-width:360px;width:100%;box-sizing:border-box;margin:0 auto 14px;background:#fff;color:#111;border-radius:16px;padding:18px 16px;text-align:center;font-family:system-ui,-apple-system,Segoe UI,sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.25)}',
    '.sk-t-brand{font-size:11px;font-weight:800;letter-spacing:.18em;color:#1a7f37}',
    '.sk-t-event{font-size:18px;font-weight:800;margin-top:8px;overflow-wrap:anywhere}',
    '.sk-t-meta{font-size:13px;color:#444;margin-top:2px;overflow-wrap:anywhere}',
    '.sk-t-lbl{font-size:10px;font-weight:700;letter-spacing:.14em;color:#666;margin-top:14px}',
    '.sk-t-num{font:700 16px ui-monospace,Menlo,Consolas,monospace;letter-spacing:.04em;overflow-wrap:anywhere}',
    '.sk-t-pin{font:900 44px/1.1 ui-monospace,Menlo,Consolas,monospace;letter-spacing:.18em;padding:6px 0 0 .18em}',
    '.sk-t-state{display:inline-block;margin-top:6px;font-size:12px;font-weight:700;padding:3px 10px;border-radius:999px;background:#eef6ee;color:#1a7f37}',
    '.sk-t-state.warn{background:#fff4e5;color:#9a5b00}.sk-t-state.bad{background:#fdecec;color:#b42318}',
    '.sk-t-qr{margin:12px auto 0;width:150px;height:150px;display:flex;align-items:center;justify-content:center}.sk-t-qr canvas,.sk-t-qr img{width:150px;height:150px}',
    '.sk-t-cap{font-size:11px;color:#666;margin-top:4px}',
    '.sk-t-fiscal{margin-top:14px;border-top:1px dashed #bbb;padding-top:10px;font-size:12px;color:#333}',
    '.sk-t-fiscal img{width:130px;height:130px;display:block;margin:6px auto}',
    '.sk-t-tier{margin-top:14px;font-weight:800;font-size:15px}',
    '.sk-t-actions{display:flex;gap:8px;flex-wrap:wrap;justify-content:center;margin-top:12px}',
    '.sk-t-actions button{min-height:44px;padding:0 14px;border-radius:10px;border:1px solid #ccc;background:#f4f4f4;color:#111;font-weight:700;cursor:pointer}',
  ].join('');
  function css() { if (typeof document !== 'undefined' && !document.getElementById(STYLE_ID)) { const s = document.createElement('style'); s.id = STYLE_ID; s.textContent = CSS; document.head.appendChild(s); } }

  const STATE = {
    ACTIVE: ['Valid for admission', ''], ISSUED: ['Valid — admission opens on event day', ''],
    CONSUMED: ['Used — admitted', 'warn'], EXPIRED: ['Admission window closed', 'bad'],
    SUSPENDED_REFUND: ['Refund in progress — not valid for entry', 'bad'], INVALID_REFUNDED: ['Refunded — not valid', 'bad'],
    INVALID_CANCELLED: ['Event cancelled — not valid', 'bad'], INVALID: ['Not valid', 'bad'],
  };
  const FISCAL = {
    PENDING: 'Pending fiscal confirmation',
    FAILED: 'Fiscal confirmation delayed — SOKONI is reconciling it with KRA',
    NOT_REGISTERED: 'The organizer is not registered for KRA eTIMS — no fiscal receipt was issued',
    NOT_APPLICABLE: 'Free ticket — no fiscal receipt',
    NOT_RECORDED: 'Fiscal status unavailable',
  };

  function when(v) {
    const t = typeof v === 'number' ? v : Date.parse(v || '');
    return Number.isFinite(t) ? new Date(t).toLocaleString('en-KE', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  }
  function money(kes) { return kes == null || !Number.isFinite(Number(kes)) ? '' : 'KES ' + Number(kes).toLocaleString('en-KE'); }

  function fiscalHtml(f) {
    const v = f || { status: 'NOT_RECORDED' };
    if (v.status === 'CONFIRMED') {
      const img = httpsUrl(v.kraQrImage);
      const link = httpsUrl(v.verificationUrl);
      return `<div class="sk-t-fiscal" data-fiscal="CONFIRMED"><div class="sk-t-lbl" style="margin-top:0">KRA / FISCAL QR</div>
        ${img ? `<img src="${esc(img)}" alt="KRA fiscal QR (issued by KRA)" referrerpolicy="no-referrer">` : '<div>KRA did not supply a QR image for this receipt</div>'}
        ${v.receiptNumber ? `<div>KRA receipt: <b>${esc(v.receiptNumber)}</b></div>` : ''}${v.invoiceNumber ? `<div>Invoice: ${esc(v.invoiceNumber)}</div>` : ''}
        ${link ? `<div><a href="${esc(link)}" target="_blank" rel="noopener noreferrer">Verify with KRA</a></div>` : ''}</div>`;
    }
    return `<div class="sk-t-fiscal" data-fiscal="${esc(v.status)}"><div class="sk-t-lbl" style="margin-top:0">KRA STATUS</div><div>${esc(FISCAL[v.status] || FISCAL.NOT_RECORDED)}</div></div>`;
  }

  /**
   * @param t {ticketNumber, pin, pinState, tierName, priceKes|unitCents, qrData, fiscal, status}
   * @param ev {title, startDate, venue, city}
   * @param opts {actions: boolean}
   */
  function html(t, ev, opts) {
    css();
    const e = ev || {};
    const st = STATE[t.pinState] || (t.pin ? null : STATE.INVALID);
    const price = t.priceKes != null ? money(t.priceKes) : (t.unitCents != null ? money(t.unitCents / 100) : '');
    const showPin = t.pin && !/^INVALID|SUSPENDED/.test(t.pinState || '');
    return `<article class="sk-ticket" data-ticket="${esc(t.ticketNumber || '')}" aria-label="SOKONI event ticket ${esc(t.ticketNumber || '')}">
      <div class="sk-t-brand">SOKONI EVENT TICKET</div>
      <div class="sk-t-event">${esc(e.title || 'Event')}</div>
      <div class="sk-t-meta">${esc(when(e.startDate))}</div>
      <div class="sk-t-meta">${esc([e.venue, e.city].filter(Boolean).join(', '))}</div>
      <div class="sk-t-lbl">TICKET</div><div class="sk-t-num">${esc(t.ticketNumber || '—')}</div>
      <div class="sk-t-lbl">PIN</div><div class="sk-t-pin" aria-label="Admission PIN">${showPin ? esc(t.pin) : '————'}</div>
      ${st ? `<div class="sk-t-state ${st[1]}">${esc(st[0])}</div>` : ''}
      <div class="sk-t-qr" data-sokoni-qr="${esc(t.qrData && showPin ? t.qrData : '')}">${t.qrData && showPin ? '' : ''}</div>
      ${t.qrData && showPin ? '<div class="sk-t-cap">SOKONI TICKET QR — optional; the PIN is enough at the gate</div>' : ''}
      ${fiscalHtml(t.fiscal)}
      <div class="sk-t-tier">${esc(t.tierName || '')}${price ? ' • ' + esc(price) : ''}</div>
      ${opts && opts.actions ? `<div class="sk-t-actions"><button type="button" data-tk-show="${esc(t.ticketNumber || '')}">Show ticket</button><button type="button" data-tk-print="${esc(t.ticketNumber || '')}">Print ticket</button><button type="button" data-tk-send="${esc(t.ticketNumber || '')}">Send ticket</button></div>` : ''}
    </article>`;
  }

  /** Draw every pending SOKONI QR inside `el` (local encoder; no network). */
  function drawQr(el) {
    (el || document).querySelectorAll('[data-sokoni-qr]').forEach((box) => {
      const text = box.getAttribute('data-sokoni-qr');
      if (!text || box.dataset.drawn) return;
      box.dataset.drawn = '1';
      try {
        if (root.SokoniQR && typeof root.SokoniQR.generateCanvas === 'function') { box.innerHTML = ''; box.appendChild(root.SokoniQR.generateCanvas(text, 150)); }
        else box.textContent = 'QR unavailable — use the PIN';
      } catch (_) { box.textContent = 'QR unavailable — use the PIN'; }
    });
  }

  /** Printable copy: QR canvases become images so the print window needs no script. */
  function printTickets(el) {
    const clone = el.cloneNode(true);
    const src = el.querySelectorAll('canvas'); const dst = clone.querySelectorAll('canvas');
    dst.forEach((c, i) => { const img = document.createElement('img'); try { img.src = src[i].toDataURL('image/png'); } catch (_) { /* tainted — skip */ } img.alt = 'SOKONI ticket QR'; c.replaceWith(img); });
    clone.querySelectorAll('.sk-t-actions').forEach((a) => a.remove());
    const w = root.open('', '_blank');
    if (!w) return false;
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>SOKONI ticket</title><style>${CSS}body{background:#fff;margin:16px}@media print{.sk-ticket{box-shadow:none;border:1px solid #999;break-inside:avoid}}</style></head><body>${clone.outerHTML}<script>window.onload=function(){window.print()}<\/script></body></html>`);
    w.document.close();
    return true;
  }

  /** Text to hand the ticket over (Web Share, else WhatsApp). Carries the PIN: the buyer needs it. */
  function shareText(t, ev) {
    return `SOKONI EVENT TICKET\n${(ev && ev.title) || 'Event'} — ${when(ev && ev.startDate)}\nTicket: ${t.ticketNumber}\nPIN: ${t.pin}\n${t.tierName || ''}\nShow the PIN at the gate. Keep it private.`;
  }
  async function send(t, ev) {
    const text = shareText(t, ev);
    if (root.navigator && typeof root.navigator.share === 'function') { try { await root.navigator.share({ title: 'SOKONI ticket', text }); return 'shared'; } catch (_) { /* fall through */ } }
    root.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank', 'noopener');
    return 'whatsapp';
  }

  root.SokoniEventTicket = { html, fiscalHtml, drawQr, printTickets, send, shareText, css, STATE, FISCAL };
}(typeof window !== 'undefined' ? window : globalThis));
