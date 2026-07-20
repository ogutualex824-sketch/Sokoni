/* ================================================================
   SOKONI — Universal M-Pesa Payment Engine v2.0
   Daraja STK Push — Payment goes DIRECTLY to seller's M-Pesa.
   SOKONI never holds or intermediates customer funds.
================================================================ */

(function (G) {
  'use strict';

  let _unsub      = null;
  let _lastTs     = 0;
  const RATE_MS   = 30000;   // 30 s min between STK pushes
  const TIMEOUT_S = 120;     // 2 min for PIN entry

  /* ── XSS-safe escape ── */
  const _e = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

  /* ── Lazy Firestore handle ── */
  async function _fsdb() {
    if (G.firebaseDB) return G.firebaseDB;
    const { getFirestore } = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
    const { app } = await import('./firebase.js');
    return getFirestore(app);
  }

  /* ── One-time CSS injection ── */
  function _css() {
    if (document.getElementById('_smCSS')) return;
    const s = document.createElement('style');
    s.id = '_smCSS';
    s.textContent = `
      @keyframes _smFI{from{opacity:0}to{opacity:1}}
      @keyframes _smSU{from{transform:translateY(100%)}to{transform:translateY(0)}}
      @keyframes _smSP{to{transform:rotate(360deg)}}
      @keyframes _smPL{0%,100%{opacity:1}50%{opacity:.45}}
      #_smModal{position:fixed;inset:0;background:rgba(0,0,0,.88);z-index:999999;display:flex;align-items:flex-end;justify-content:center;backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);animation:_smFI .2s ease;}
      #_smSheet{width:100%;max-width:520px;background:#111;border-radius:24px 24px 0 0;border-top:1px solid rgba(113,255,0,.18);padding:0 0 calc(env(safe-area-inset-bottom,0px)+28px);animation:_smSU .32s cubic-bezier(.34,1.2,.64,1);font-family:'Segoe UI',system-ui,sans-serif;}
      ._smHnd{width:40px;height:4px;background:rgba(255,255,255,.15);border-radius:2px;margin:14px auto 0;}
      ._smHd{padding:16px 24px 0;display:flex;align-items:center;gap:12px;}
      ._smBdy{padding:18px 24px 0;}
      ._smInp{width:100%;padding:16px;background:rgba(255,255,255,.06);border:1.5px solid rgba(255,255,255,.12);color:#fff;font-size:20px;border-radius:14px;font-family:inherit;letter-spacing:2px;outline:none;box-sizing:border-box;-webkit-appearance:none;margin-bottom:0;}
      ._smInp:focus{border-color:rgba(76,175,80,.6);background:rgba(76,175,80,.05);}
      ._smBtn{display:block;width:100%;padding:17px;border:none;border-radius:14px;font-size:15px;font-weight:900;cursor:pointer;font-family:inherit;text-align:center;transition:opacity .15s,transform .1s;-webkit-tap-highlight-color:transparent;touch-action:manipulation;box-sizing:border-box;}
      ._smBtn:active{transform:scale(.97);}
      ._smBtn:disabled{opacity:.5;cursor:not-allowed;transform:none;}
      ._smPri{background:linear-gradient(135deg,#4caf50,#2e7d32);color:#fff;box-shadow:0 4px 18px rgba(76,175,80,.38);}
      ._smSec{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);color:rgba(255,255,255,.45);margin-top:10px;}
      ._smSpin{display:inline-block;width:38px;height:38px;border:3px solid rgba(76,175,80,.18);border-top-color:#4caf50;border-radius:50%;animation:_smSP .75s linear infinite;}
      ._smStep{display:flex;align-items:center;gap:12px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.07);border-radius:12px;padding:11px 14px;margin-bottom:8px;font-size:13px;color:rgba(255,255,255,.7);}
      ._smSN{width:26px;height:26px;border-radius:50%;background:rgba(76,175,80,.15);border:1px solid rgba(76,175,80,.3);color:#4caf50;font-size:11px;font-weight:900;display:flex;align-items:center;justify-content:center;flex-shrink:0;}
      ._smAmtBox{background:rgba(76,175,80,.08);border:1px solid rgba(76,175,80,.2);border-radius:14px;padding:14px 18px;margin-bottom:18px;text-align:center;}
      ._smCode{background:rgba(76,175,80,.1);border:1px solid rgba(76,175,80,.25);border-radius:14px;padding:14px 18px;text-align:center;margin:12px 0 6px;}
    `;
    document.head.appendChild(s);
  }

  /* ── Open the bottom sheet ── */
  function _open(inner) {
    _css();
    document.getElementById('_smModal')?.remove();
    const el = document.createElement('div');
    el.id = '_smModal';
    el.innerHTML = `<div id="_smSheet"><div class="_smHnd"></div>${inner}</div>`;
    document.body.appendChild(el);
  }

  /* ── Close ── */
  function _close() {
    const m = document.getElementById('_smModal');
    if (m) { m.style.opacity='0'; m.style.transition='opacity .22s'; setTimeout(()=>m.remove(), 230); }
    if (_unsub) { _unsub(); _unsub = null; }
  }

  /* ── Swap the inner body section ── */
  function _body(html) {
    const b = document.getElementById('_smBody');
    if (b) b.innerHTML = html;
  }

  /* ─────────────────────────────────────────────────────
     TEMPLATES
  ───────────────────────────────────────────────────── */

  function _tplPhone({ amount, sellerName, description, initVal }) {
    return `
      <div class="_smHd">
        <div style="width:44px;height:44px;background:rgba(76,175,80,.15);border:1px solid rgba(76,175,80,.3);border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:24px;flex-shrink:0;">📱</div>
        <div>
          <div style="font-size:15px;font-weight:900;color:#fff;">M-Pesa Payment</div>
          <div style="font-size:11px;color:rgba(255,255,255,.4);">to ${_e(sellerName)} · Safaricom Daraja</div>
        </div>
      </div>
      <div class="_smBdy">
        <div class="_smAmtBox">
          <div style="font-size:11px;font-weight:800;color:rgba(255,255,255,.4);letter-spacing:.5px;margin-bottom:4px;">AMOUNT DUE</div>
          <div style="font-size:36px;font-weight:900;color:#4caf50;">KES ${Number(amount).toLocaleString()}</div>
          <div style="font-size:11px;color:rgba(255,255,255,.35);margin-top:2px;">${_e(description)}</div>
        </div>
        <div id="_smBody">
          <label style="font-size:10.5px;font-weight:800;color:rgba(255,255,255,.4);letter-spacing:.6px;display:block;margin-bottom:8px;">YOUR SAFARICOM NUMBER</label>
          <input id="_smPhInp" class="_smInp" type="tel" inputmode="numeric" placeholder="07XXXXXXXX" value="${_e(initVal)}" maxlength="13" autocomplete="tel" style="margin-bottom:8px;">
          <div style="font-size:11px;color:rgba(255,255,255,.3);margin-bottom:18px;">You'll receive an M-Pesa PIN prompt on this number.</div>
          <button id="_smSubBtn" class="_smBtn _smPri" type="button">📲 Send STK Push</button>
          <button class="_smBtn _smSec" type="button" onclick="window._smCan()">Cancel</button>
        </div>
      </div>
    `;
  }

  const _tplSending = () => `
    <div style="text-align:center;padding:30px 0 8px;">
      <div class="_smSpin" style="margin:0 auto 18px;"></div>
      <div style="font-size:18px;font-weight:900;color:#fff;margin-bottom:6px;">Connecting…</div>
      <div style="font-size:13px;color:rgba(255,255,255,.4);">Sending request to Safaricom Daraja</div>
    </div>
  `;

  const _tplWaiting = (phone) => {
    const d = String(phone).replace(/^254/,'0').replace(/^(\d{4})(\d{3})(\d{3})$/,'$1 $2 $3');
    return `
      <div style="text-align:center;padding:10px 0 4px;">
        <div style="font-size:52px;margin-bottom:14px;animation:_smPL 2s ease-in-out infinite;">📱</div>
        <div style="font-size:19px;font-weight:900;color:#fff;margin-bottom:8px;">Check Your Phone</div>
        <div style="font-size:13px;color:rgba(255,255,255,.5);margin-bottom:20px;line-height:1.65;">STK prompt sent to<br><strong style="color:#fff;font-size:16px;">${_e(d)}</strong><br>Enter your M-Pesa PIN to pay.</div>
        <div class="_smStep"><div class="_smSN">1</div>Open the M-Pesa PIN prompt on your screen</div>
        <div class="_smStep"><div class="_smSN">2</div>Enter your 4-digit M-Pesa PIN</div>
        <div class="_smStep"><div class="_smSN">3</div>Payment goes directly to seller's M-Pesa</div>
        <div style="margin-top:18px;font-size:11px;color:rgba(255,255,255,.22);">Awaiting confirmation · <span id="_smTimer">${TIMEOUT_S}</span>s</div>
      </div>
    `;
  };

  const _tplSuccess = ({ mpesaCode, amount, paidPhone, sellerName }) => {
    const d = paidPhone ? String(paidPhone).replace(/^254/,'0') : '';
    return `
      <div style="text-align:center;padding:14px 0 6px;">
        <div style="font-size:56px;margin-bottom:14px;">✅</div>
        <div style="font-size:21px;font-weight:900;color:#4caf50;margin-bottom:6px;">Payment Confirmed!</div>
        <div style="font-size:13px;color:rgba(255,255,255,.5);margin-bottom:18px;">KES ${Number(amount||0).toLocaleString()} paid directly to ${_e(sellerName)}</div>
        ${mpesaCode ? `
          <div class="_smCode">
            <div style="font-size:10px;font-weight:800;color:rgba(255,255,255,.4);letter-spacing:.6px;margin-bottom:6px;">M-PESA RECEIPT</div>
            <div style="font-size:24px;font-weight:900;color:#4caf50;letter-spacing:3px;">${_e(mpesaCode)}</div>
          </div>
          <div style="font-size:11px;color:rgba(255,255,255,.3);margin-bottom:18px;">Save this code as your payment proof</div>` : ''}
        ${d ? `<div style="font-size:12px;color:rgba(255,255,255,.35);margin-bottom:18px;">From ${_e(d)}</div>` : ''}
        <button class="_smBtn _smPri" onclick="window._smClose()">Done</button>
      </div>
    `;
  };

  const _tplError = ({ message }) => `
    <div style="text-align:center;padding:14px 0 6px;">
      <div style="font-size:56px;margin-bottom:14px;">❌</div>
      <div style="font-size:19px;font-weight:900;color:#ef4444;margin-bottom:8px;">Payment Failed</div>
      <div style="font-size:13px;color:rgba(255,255,255,.5);margin-bottom:22px;line-height:1.6;">${_e(message || 'Something went wrong. Please try again.')}</div>
      <button class="_smBtn _smSec" onclick="window._smClose()">Close</button>
    </div>
  `;

  /* ─────────────────────────────────────────────────────
     FIRESTORE REAL-TIME LISTENER
  ───────────────────────────────────────────────────── */
  async function _listen(checkoutId, { onSuccess, onFailure, amount, sellerName }) {
    const db = await _fsdb();
    const { doc, onSnapshot } = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');

    return new Promise(resolve => {
      /* Hard timeout */
      const timer = setTimeout(() => {
        if (_unsub) { _unsub(); _unsub = null; }
        _body(_tplError({ message: 'Payment timed out. Check your M-Pesa inbox. If charged, share the receipt code with the seller.' }));
        if (onFailure) onFailure('timeout');
        resolve('timeout');
      }, TIMEOUT_S * 1000);

      /* Countdown display */
      let secs = TIMEOUT_S;
      const tick = setInterval(() => {
        const el = document.getElementById('_smTimer');
        if (el) el.textContent = --secs;
        if (secs <= 0) clearInterval(tick);
      }, 1000);

      _unsub = onSnapshot(doc(db, 'posPayments', checkoutId), snap => {
        if (!snap.exists()) return;
        const d = snap.data();

        if (d.status === 'completed' || d.status === 'paid') {
          clearTimeout(timer); clearInterval(tick);
          if (_unsub) { _unsub(); _unsub = null; }
          _body(_tplSuccess({ mpesaCode: d.mpesaCode, amount: d.paidAmount ?? amount, paidPhone: d.paidPhone, sellerName }));
          if (onSuccess) onSuccess({ mpesaCode: d.mpesaCode, amount: d.paidAmount, phone: d.paidPhone, checkoutId });
          resolve('success');
        }

        if (d.status === 'failed' || d.status === 'cancelled') {
          clearTimeout(timer); clearInterval(tick);
          if (_unsub) { _unsub(); _unsub = null; }
          _body(_tplError({ message: d.resultDesc || 'Payment cancelled or failed. Please try again.' }));
          if (onFailure) onFailure(d.resultDesc || 'failed');
          resolve('failed');
        }
      }, err => {
        clearTimeout(timer); clearInterval(tick);
        _body(_tplError({ message: 'Connection lost. Check your M-Pesa for status.' }));
        if (onFailure) onFailure(err.message);
        resolve('error');
      });
    });
  }

  /* ═══════════════════════════════════════════════════════
     PUBLIC API
  ══════════════════════════════════════════════════════ */
  const SokoniMpesa = {

    /**
     * Request M-Pesa payment — customer to seller via Daraja STK Push.
     *
     * @param {Object}   opts
     * @param {string}   opts.sellerUid    Seller's Firestore UID (holds Daraja credentials)
     * @param {number}   opts.amount       Amount in KES
     * @param {string}   [opts.phone]      Pre-fill customer phone
     * @param {string}   [opts.orderId]    Order reference (used for dedup)
     * @param {string}   [opts.hub]        'marketplace'|'restaurant'|'delivery'|'car'|'healthcare'|'property'|'freelance'|'legal'|'b2b'
     * @param {string}   [opts.description] Short payment description
     * @param {string}   [opts.sellerName] Business display name
     * @param {Function} [opts.onSuccess]  Called with {mpesaCode, amount, phone, checkoutId}
     * @param {Function} [opts.onFailure]  Called with reason string
     * @returns {Promise<'success'|'failed'|'cancelled'|'timeout'|'error'>}
     */
    async pay(opts = {}) {
      const {
        sellerUid, amount, phone: initPhone = '',
        orderId = null, hub = 'marketplace',
        description = 'SOKONI Payment', sellerName = 'SOKONI',
        onSuccess, onFailure,
        /* Catalogue line items. When present the server prices the sale from
           the products collection and ignores `amount` as the charge basis.
           Absent for SmartPOS tills, where the operator keys the amount. */
        items = null, deliveryFee = 0,
      } = opts;

      if (!sellerUid) throw new Error('SokoniMpesa: sellerUid required');
      if (!amount || Number(amount) <= 0) throw new Error('SokoniMpesa: valid amount required');

      /* Rate limit */
      if (Date.now() - _lastTs < RATE_MS) {
        const wait = Math.ceil((RATE_MS - (Date.now() - _lastTs)) / 1000);
        if (G._showToast) G._showToast(`Please wait ${wait}s before retrying.`, 'warning');
        else (window._skToast||alert)(`Please wait ${wait}s before sending another payment request.`);
        return 'cancelled';
      }

      /* Collect phone */
      const initVal = initPhone ? String(initPhone).replace(/\D/g,'').replace(/^254/,'0') : '';
      const rawPhone = await new Promise(resolve => {
        _open(_tplPhone({ amount, sellerName, description, initVal }));

        document.getElementById('_smModal').addEventListener('click', e => {
          if (e.target.id === '_smModal') { _close(); resolve(null); }
        });

        const btn = document.getElementById('_smSubBtn');
        const inp = document.getElementById('_smPhInp');
        if (inp) setTimeout(() => inp.focus(), 320);

        if (btn) btn.onclick = () => {
          const raw = (inp?.value || '').replace(/\D/g,'');
          if (raw.length < 9) { if(inp){inp.style.borderColor='#f44336';inp.focus();} return; }
          resolve(raw);
        };

        if (inp) inp.addEventListener('keydown', e => { if (e.key === 'Enter') btn?.click(); });

        G._smCan = () => { _close(); resolve(null); };
      });

      if (!rawPhone) return 'cancelled';
      _lastTs = Date.now();

      try {
        _body(_tplSending());

        /* Call Cloud Function */
        const { getFunctions, httpsCallable } = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js');
        const { app: fbApp } = await import('./firebase.js');
        const fn = httpsCallable(getFunctions(fbApp), 'darajaSTKPush');

        const result = await fn({
          sellerUid,
          phone: rawPhone,
          amount: Math.round(Number(amount)),
          ...(Array.isArray(items) && items.length ? { items, deliveryFee } : {}),
          orderId,
          description,
          hub,
        });

        const { checkoutId } = result.data;
        _body(_tplWaiting(rawPhone));

        const outcome = await _listen(checkoutId, { onSuccess, onFailure, amount, sellerName });
        return outcome;

      } catch (err) {
        const msg = err?.message || 'Payment request failed. Check your internet and try again.';
        _body(_tplError({ message: msg }));
        if (onFailure) onFailure(msg);
        return 'failed';
      }
    },

    close: _close,
  };

  G._smClose = _close;
  G.SokoniMpesa = SokoniMpesa;

})(window);

