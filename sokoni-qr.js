/* ============================================================
   SOKONI QR  —  QR code generation, download, and modal
   Covers: product, order, pickup, seller, table, venue, profile
   Lazy-loads qrcode library on first use (no initial cost).
============================================================ */
(function (global) {
  'use strict';

  const BASE      = 'https://mysokoni.co.ke/scan';
  const QR_CDN    = 'https://unpkg.com/qrcode@1.5.3/build/qrcode.min.js';
  const DARK      = '#0a0a12';

  let _ready      = false;
  let _readyP     = null;

  function _load() {
    if (_ready)  return Promise.resolve();
    if (_readyP) return _readyP;
    _readyP = new Promise((res, rej) => {
      const s    = document.createElement('script');
      s.src      = QR_CDN;
      s.onload   = () => { _ready = true; res(); };
      s.onerror  = () => rej(new Error('[SokoniQR] failed to load qrcode library'));
      document.head.appendChild(s);
    });
    return _readyP;
  }

  function _url(type, id, extra) {
    const p = new URLSearchParams({ t: type, id: String(id) });
    if (extra) Object.entries(extra).forEach(([k, v]) => p.set(k, String(v)));
    return `${BASE}?${p}`;
  }

  function _esc(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function _toast(msg) {
    const t = document.createElement('div');
    t.textContent = msg;
    Object.assign(t.style, {
      position:'fixed', bottom:'80px', left:'50%', transform:'translateX(-50%)',
      background:'#1a1a2e', border:'1px solid rgba(124,58,237,.35)',
      borderRadius:'12px', padding:'11px 20px', fontSize:'13px',
      fontWeight:'700', color:'white', zIndex:'99999', whiteSpace:'nowrap',
      fontFamily:'inherit', pointerEvents:'none',
    });
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2600);
  }

  const SokoniQR = {

    /* ─── URL builders ─── */
    url: {
      product  : (id)               => _url('product',  id),
      order    : (id)               => _url('order',    id),
      seller   : (id)               => _url('seller',   id),
      venue    : (id)               => _url('venue',    id),
      profile  : (id)               => _url('profile',  id),
      table    : (restaurantId, n)  => _url('table',    restaurantId, { n }),
      pickup   : (orderId, token)   => _url('pickup',   orderId, { v: token }),
    },

    /* ─── Core: render into an existing <canvas> ─── */
    async renderCanvas(canvas, text, opts = {}) {
      await _load();
      await window.QRCode.toCanvas(canvas, text, {
        width: opts.size || 240,
        margin: opts.margin ?? 2,
        color: { dark: opts.dark || DARK, light: opts.light || '#ffffff' },
        errorCorrectionLevel: opts.ec || 'M',
      });
    },

    /* ─── Core: return data URL ─── */
    async toDataURL(text, opts = {}) {
      await _load();
      return window.QRCode.toDataURL(text, {
        width: opts.size || 400,
        margin: opts.margin ?? 2,
        color: { dark: opts.dark || '#000000', light: opts.light || '#ffffff' },
        errorCorrectionLevel: opts.ec || 'M',
      });
    },

    /* ─── Show full-screen modal with QR ─── */
    async showModal(type, id, label, extra) {
      await _load();
      const qrUrl = extra ? _url(type, id, extra) : _url(type, id);

      document.getElementById('_sqr_modal')?.remove();

      const overlay = document.createElement('div');
      overlay.id    = '_sqr_modal';
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-label', 'QR Code');
      overlay.style.cssText = [
        'position:fixed;inset:0;background:rgba(0,0,0,.82);z-index:9999',
        'display:flex;align-items:center;justify-content:center;padding:16px',
      ].join(';');

      overlay.innerHTML = `
        <div style="background:#13131f;border:1px solid rgba(255,255,255,.1);border-radius:24px;
                    padding:28px 24px 24px;text-align:center;max-width:320px;width:100%;position:relative;">
          <button id="_sqr_close"
            style="position:absolute;top:14px;right:14px;background:rgba(255,255,255,.07);
                   border:none;color:rgba(255,255,255,.55);width:32px;height:32px;
                   border-radius:50%;font-size:18px;cursor:pointer;display:flex;
                   align-items:center;justify-content:center;">×</button>
          <div style="font-size:11px;font-weight:800;color:rgba(255,255,255,.4);
                      text-transform:uppercase;letter-spacing:.08em;margin-bottom:14px;">
            Scan with any camera
          </div>
          <div style="background:#fff;border-radius:14px;padding:10px;display:inline-block;margin-bottom:14px;">
            <canvas id="_sqr_canvas"></canvas>
          </div>
          <div style="font-size:15px;font-weight:900;color:white;margin-bottom:4px;">${_esc(label || '')}</div>
          <div style="font-size:10px;color:rgba(255,255,255,.3);word-break:break-all;margin-bottom:18px;
                      max-height:36px;overflow:hidden;">${_esc(qrUrl)}</div>
          <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap;">
            <button id="_sqr_dl"
              style="padding:10px 18px;background:rgba(124,58,237,.18);border:1px solid rgba(124,58,237,.4);
                     border-radius:10px;color:#a78bfa;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit;">
              Download PNG
            </button>
            <button id="_sqr_copy"
              style="padding:10px 18px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);
                     border-radius:10px;color:rgba(255,255,255,.55);font-size:13px;font-weight:700;cursor:pointer;font-family:inherit;">
              Copy Link
            </button>
          </div>
        </div>`;

      document.body.appendChild(overlay);

      // Events
      document.getElementById('_sqr_close').onclick = () => overlay.remove();
      overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

      document.getElementById('_sqr_dl').onclick = async () => {
        const url = await this.toDataURL(qrUrl, { size: 600 });
        const a   = document.createElement('a');
        a.href     = url;
        a.download = `sokoni-qr-${type}-${id}.png`;
        a.click();
      };

      document.getElementById('_sqr_copy').onclick = () => {
        navigator.clipboard.writeText(qrUrl).then(() => _toast('Link copied!')).catch(() => {
          prompt('Copy this link:', qrUrl);
        });
      };

      // Render QR
      const canvas = document.getElementById('_sqr_canvas');
      await this.renderCanvas(canvas, qrUrl, { size: 200, dark: '#000000', light: '#ffffff' });
    },

    /* ─── Inline: render QR into any element by id ─── */
    async renderInto(elementId, type, id, extra, opts = {}) {
      const el = document.getElementById(elementId);
      if (!el) return;
      const qrUrl = extra ? _url(type, id, extra) : _url(type, id);
      await _load();
      el.innerHTML = '';
      const canvas = document.createElement('canvas');
      el.appendChild(canvas);
      await this.renderCanvas(canvas, qrUrl, opts);
    },

    /* ─── Batch: render array of {elementId, type, id, extra?, opts?} ─── */
    async renderBatch(items) {
      await _load();
      await Promise.all(items.map(it => this.renderInto(it.elementId, it.type, it.id, it.extra, it.opts)));
    },

    /* ─── Expose _toast for use by other modules ─── */
    toast: _toast,
  };

  global.SokoniQR = SokoniQR;
})(window);
