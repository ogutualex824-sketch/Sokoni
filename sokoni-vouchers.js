/**
 * SOKONI Voucher System  v2.0  (Production)
 *
 * All voucher operations use Cloud Functions + Firestore atomic transactions.
 * Console-based redemption is impossible — requires:
 *   1. Firebase Authentication (active session)
 *   2. Server-side Cloud Function validation
 *   3. Atomic Firestore transaction (prevents race-condition double-redemption)
 *   4. Expiry check (server timestamp)
 *   5. Usage limit check (usageCount < maxUses)
 *
 * Firestore schema:
 *   /vouchers/{code}  {
 *     code:         string (uppercase, trimmed),
 *     discount:     number (percentage 0–100 or KES amount),
 *     discountType: 'percent'|'fixed',
 *     expiresAt:    Timestamp,
 *     maxUses:      number,
 *     usageCount:   number,
 *     redemptions:  string[] (UIDs who redeemed),
 *     createdBy:    string (admin UID),
 *     active:       boolean,
 *     category:     string|null (null = all categories),
 *     minAmount:    number,
 *   }
 */

(function (window) {
  'use strict';

  const log = window.SokoniLogger || { log:()=>{}, warn:()=>{}, error:()=>{} };

  /* ══════════════════════════════════════════════════════════════
     VALIDATION HELPERS
  ══════════════════════════════════════════════════════════════ */
  function _normalizeCode(code) {
    return String(code || '').trim().toUpperCase().replace(/[^A-Z0-9\-]/g, '');
  }

  function _authGuard() {
    const auth = window.firebaseAuth;
    if (!auth?.currentUser) throw new Error('You must be signed in to use a voucher.');
    return auth.currentUser;
  }

  /* ══════════════════════════════════════════════════════════════
     CLIENT-SIDE PREVIEW  — read-only, no redemption
     Shows discount information before the user commits.
  ══════════════════════════════════════════════════════════════ */
  async function previewVoucher(code) {
    const safeCode = _normalizeCode(code);
    if (!safeCode || safeCode.length < 4) throw new Error('Invalid voucher code.');

    _authGuard();
    const db = window.firebaseDB;
    if (!db) throw new Error('Database not ready.');

    const { doc, getDoc } = await import(
      'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
    );

    const snap = await getDoc(doc(db, 'vouchers', safeCode));
    if (!snap.exists()) throw new Error('Voucher code not found.');

    const data = snap.data();

    /* Client-side expiry check (server enforces authoritatively) */
    const expMs = data.expiresAt?.toMillis ? data.expiresAt.toMillis() : Infinity;
    if (expMs < Date.now()) throw new Error('This voucher has expired.');

    if (!data.active) throw new Error('This voucher is no longer active.');

    if (data.usageCount >= data.maxUses) throw new Error('This voucher has reached its usage limit.');

    return {
      code:         safeCode,
      discount:     data.discount,
      discountType: data.discountType || 'percent',
      minAmount:    data.minAmount    || 0,
      category:     data.category     || null,
      expiresAt:    expMs,
    };
  }

  /* ══════════════════════════════════════════════════════════════
     MAIN: redeemVoucher(code, context)
     Atomic server-side redemption via Cloud Function.
     context = { orderTotal, category }
     Returns applied discount details on success.
  ══════════════════════════════════════════════════════════════ */
  async function redeemVoucher(code, context) {
    const safeCode = _normalizeCode(code);
    if (!safeCode || safeCode.length < 4) throw new Error('Invalid voucher code.');

    const user = _authGuard();
    context = context || {};

    log.log('Redeeming voucher:', safeCode, 'uid:', user.uid);

    try {
      const { getFunctions, httpsCallable } = await import(
        'https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js'
      );
      const fns = getFunctions(window.firebaseApp, 'us-central1');
      const fn  = httpsCallable(fns, 'redeemVoucher');

      const result = await fn({
        code:       safeCode,
        orderTotal: Number(context.orderTotal) || 0,
        category:   String(context.category   || ''),
      });

      if (!result.data.success) {
        throw new Error(result.data.message || 'Voucher redemption failed.');
      }

      log.log('Voucher redeemed successfully:', safeCode);
      return result.data;

    } catch (err) {
      /* Re-throw Firebase HttpsError messages cleanly */
      throw new Error(err.message || 'Failed to redeem voucher. Please try again.');
    }
  }

  /* ══════════════════════════════════════════════════════════════
     APPLY DISCOUNT  — calculates discount amount from voucher
  ══════════════════════════════════════════════════════════════ */
  function applyDiscount(voucherInfo, orderTotal) {
    if (!voucherInfo) return { discount: 0, finalTotal: orderTotal };

    const total = Number(orderTotal) || 0;
    let discount = 0;

    if (voucherInfo.discountType === 'percent') {
      discount = Math.round(total * voucherInfo.discount / 100);
    } else if (voucherInfo.discountType === 'fixed') {
      discount = Math.min(voucherInfo.discount, total);
    }

    return {
      discount,
      finalTotal: Math.max(0, total - discount),
      discountType: voucherInfo.discountType,
      discountValue: voucherInfo.discount,
    };
  }

  /* ══════════════════════════════════════════════════════════════
     VOUCHER UI WIDGET  — inline voucher input + apply button
  ══════════════════════════════════════════════════════════════ */
  function renderVoucherWidget(containerId, onApplied) {
    const container = document.getElementById(containerId);
    if (!container) return;

    const div = document.createElement('div');
    div.style.cssText = 'margin-top:12px;';

    const input = document.createElement('input');
    input.type        = 'text';
    input.placeholder = 'Enter voucher code';
    input.maxLength   = 20;
    input.style.cssText = `
      width:calc(100% - 90px);padding:10px 12px;
      background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);
      border-radius:10px 0 0 10px;color:white;font-size:13px;outline:none;
      font-family:inherit;vertical-align:middle;
    `;
    input.addEventListener('input', () => { input.value = input.value.toUpperCase(); });

    const btn = document.createElement('button');
    btn.type      = 'button';
    btn.textContent = 'Apply';
    btn.style.cssText = `
      width:86px;padding:10px 8px;background:rgba(113,255,0,0.15);
      border:1px solid rgba(113,255,0,0.3);border-left:none;border-radius:0 10px 10px 0;
      color:#71ff00;font-weight:800;font-size:13px;cursor:pointer;font-family:inherit;
      vertical-align:middle;
    `;

    const msg = document.createElement('div');
    msg.style.cssText = 'font-size:11px;margin-top:6px;min-height:14px;';

    btn.addEventListener('click', async () => {
      const code = input.value.trim();
      if (!code) { msg.textContent = 'Enter a voucher code.'; msg.style.color = '#ff9800'; return; }

      btn.disabled    = true;
      btn.textContent = '...';
      msg.textContent = '';

      try {
        const info = await previewVoucher(code);
        msg.textContent = `&#10003; ${info.discountType === 'percent' ? info.discount + '% off' : 'KES ' + info.discount + ' off'} applied!`;
        msg.style.color = '#71ff00';
        input.disabled  = true;
        btn.textContent = 'Applied';
        if (onApplied) onApplied(info);
      } catch (err) {
        msg.textContent = err.message;
        msg.style.color = '#ff5555';
        btn.disabled    = false;
        btn.textContent = 'Apply';
      }
    });

    /* Allow Enter key */
    input.addEventListener('keydown', e => { if (e.key === 'Enter') btn.click(); });

    div.appendChild(input);
    div.appendChild(btn);
    div.appendChild(msg);
    container.appendChild(div);
  }

  /* ══════════════════════════════════════════════════════════════
     EXPORTS
  ══════════════════════════════════════════════════════════════ */
  window.SokoniVouchers = {
    previewVoucher,
    redeemVoucher,
    applyDiscount,
    renderVoucherWidget,
  };

})(window);
