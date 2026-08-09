/* SOKONI SmartPOS — Extended Modules v1.0
   Requirements 26, 27, 30, 32, 33, 35, 36, 38:
   - Notifications (owner real-time alerts, FCM)
   - Delivery tracking (enhanced with live map)
   - Marketing automation (SMS, WhatsApp, Email)
   - Biometric authentication (WebAuthn)
   - Omnichannel inventory sync
   - Serial / IMEI / Warranty tracking
   - Advanced label printing (QR codes)
   - Repair & service center management */

'use strict';

/* ═══════════════════════════════════════════════════════════════
   REQUIREMENT 26 — Real-time Owner Notifications
════════════════════════════════════════════════════════════════ */
const PosNotify = (() => {
  const _queue = [];
  let   _badge = 0;

  function _updateBadge() {
    const el = document.getElementById('notify-badge');
    if (el) { el.textContent = _badge > 0 ? _badge : ''; el.style.display = _badge > 0 ? 'flex' : 'none'; }
  }

  async function send(type, data = {}) {
    const TYPES = {
      stock_low:    { icon: '📦', title: 'Low Stock Alert',        color: '#f59e0b' },
      sale_large:   { icon: '💰', title: 'Large Sale',             color: 'var(--green)' },
      fraud_alert:  { icon: '🚨', title: 'Fraud Alert',            color: 'var(--red)' },
      daily_summary:{ icon: '📊', title: 'Daily Business Summary', color: '#60a5fa' },
      shift_close:  { icon: '🌇', title: 'Shift Closed',           color: 'var(--txt2)' },
      mpesa_fail:   { icon: '📱', title: 'M-PESA Payment Failed',  color: 'var(--red)' },
      new_order:    { icon: '🛒', title: 'New Marketplace Order',  color: 'var(--green)' },
      delivery_done:{ icon: '🏍️', title: 'Delivery Completed',    color: 'var(--green)' },
    };

    const info = TYPES[type] || { icon: '🔔', title: type, color: 'var(--txt)' };
    const notification = { id: Date.now(), type, data, ts: Date.now(), read: false, ...info };

    _queue.unshift(notification);
    if (_queue.length > 50) _queue.pop();
    _badge++;
    _updateBadge();

    /* In-app toast for critical */
    if (['fraud_alert', 'mpesa_fail', 'stock_low'].includes(type) && window.SPos) {
      SPos.toast(`${info.icon} ${info.title}`, type === 'fraud_alert' ? 'error' : 'info');
    }

    /* Web Push Notification (if permission granted) */
    if (Notification.permission === 'granted') {
      try {
        const n = new Notification(`SOKONI: ${info.title}`, {
          icon:  '/assets/logosokoni.png',
          badge: '/assets/logosokoni.png',
          body:  _formatBody(type, data),
          tag:   type,
          renotify: type === 'fraud_alert',
        });
        n.onclick = () => { window.focus(); markRead(notification.id); };
      } catch (e) {}
    }
  }

  function _formatBody(type, data) {
    switch (type) {
      case 'stock_low':    return `${data.name} has only ${data.stock} units left.`;
      case 'sale_large':   return `Sale of KES ${(data.total||0).toLocaleString()} completed.`;
      case 'fraud_alert':  return data.message || 'Suspicious activity detected.';
      case 'daily_summary':return `Revenue: KES ${(data.revenue||0).toLocaleString()} | ${data.transactions||0} sales`;
      case 'new_order':    return `Order from ${data.customerName || 'customer'} — KES ${(data.total||0).toLocaleString()}`;
      default:             return JSON.stringify(data).slice(0, 100);
    }
  }

  /* Browsers only allow a permission prompt from a user gesture. pos.js calls this during
     boot, so an unconditional requestPermission() threw "Notification prompting can only be
     done from a user gesture." on every POS/Inventory/Cashier entry. Boot callers now get the
     current state without prompting; a real button passes { fromGesture: true }. */
  async function requestPermission(opts) {
    if (!('Notification' in window)) return 'unsupported';
    if (Notification.permission === 'granted') return 'granted';
    if (!(opts && opts.fromGesture)) return Notification.permission; /* 'default' | 'denied' */
    return await Notification.requestPermission();
  }

  function markRead(id) {
    const n = _queue.find(q => q.id === id);
    if (n && !n.read) { n.read = true; _badge = Math.max(0, _badge - 1); _updateBadge(); }
  }

  function markAllRead() {
    _queue.forEach(n => { n.read = true; }); _badge = 0; _updateBadge();
  }

  function renderPanel(containerId) {
    const el = document.getElementById(containerId);
    if (!el) return;
    markAllRead();
    el.innerHTML = _queue.length
      ? _queue.map(n => `
          <div class="notify-item ${n.read ? '' : 'notify-unread'}">
            <span class="notify-icon">${n.icon}</span>
            <div>
              <div class="notify-title">${n.title}</div>
              <div class="notify-body">${_formatBody(n.type, n.data)}</div>
              <div class="notify-time">${new Date(n.ts).toLocaleString()}</div>
            </div>
          </div>
        `).join('')
      : '<div style="padding:20px;text-align:center;color:var(--txt2)">No notifications</div>';
  }

  /* Send daily summary — call once per day e.g. at shift close */
  async function sendDailySummary() {
    const start = new Date().setHours(0,0,0,0);
    const end   = new Date().setHours(23,59,59,999);
    let report = {};
    try {
      /* Build summary from transactions store (PosDB.reports.forDateRange not available) */
      const all = await PosDB.transactions.getAll();
      const day = all.filter(t => t.completedAt >= start && t.completedAt <= end && t.status === 'completed');
      report = {
        total: day.reduce((s, t) => s + (t.total || 0), 0),
        count: day.length,
      };
    } catch (_) {}
    await send('daily_summary', { revenue: report.total || 0, transactions: report.count || 0 });
  }

  return { send, requestPermission, markRead, markAllRead, renderPanel, sendDailySummary };
})();
window.PosNotify = PosNotify;

/* ═══════════════════════════════════════════════════════════════
   REQUIREMENT 30 — Marketing Automation
   SMS (Africa's Talking), WhatsApp broadcasts, EmailJS
════════════════════════════════════════════════════════════════ */
const PosMarketing = (() => {

  /* Segment customers by spending tier */
  async function segment() {
    const customers = await PosDB.customers.getAll();
    const txns      = await PosDB.transactions.getAll();

    const spend = {};
    for (const txn of txns) {
      if (txn.customerId) spend[txn.customerId] = (spend[txn.customerId] || 0) + (txn.total || 0);
    }

    return customers.map(c => ({
      ...c,
      totalSpend: spend[c.id] || 0,
      segment:    (spend[c.id] || 0) >= 50000 ? 'diamond'
                : (spend[c.id] || 0) >= 20000 ? 'gold'
                : (spend[c.id] || 0) >= 5000  ? 'silver'
                :                                'bronze',
    }));
  }

  /* WhatsApp broadcast — opens wa.me for each customer */
  async function broadcastWhatsApp(message, segmentFilter) {
    const segs  = await segment();
    const targets = segs.filter(c => !segmentFilter || c.segment === segmentFilter)
                        .filter(c => c.phone);
    if (!targets.length) { if (window.SPos) SPos.toast('No customers with phone numbers', 'error'); return; }

    let sent = 0;
    for (const c of targets.slice(0, 20)) {
      const phone = c.phone.replace(/\D/g, '').replace(/^0/, '254');
      const text  = message.replace('{name}', c.name || 'Customer');
      const url   = `https://wa.me/${phone}?text=${encodeURIComponent(text)}`;
      window.open(url, '_blank');
      sent++;
      await new Promise(r => setTimeout(r, 300));
    }
    if (window.SPos) SPos.toast(`WhatsApp sent to ${sent} customers`, 'success');
    await PosDB.marketing_campaigns?.add({ type: 'whatsapp', message, segmentFilter, sent, sentAt: Date.now() });
  }

  /* SMS via Africa's Talking (requires backend relay) */
  async function sendSMS(phones, message) {
    if (!navigator.onLine) { if (window.SPos) SPos.toast('No internet for SMS', 'error'); return; }
    try {
      const { getFunctions, httpsCallable } = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-functions.js');
      const fns  = getFunctions(window.firebaseApp);
      const call = httpsCallable(fns, 'posSendSMS');
      const res  = await call({ phones, message, businessId: window.SPos?.state?.settings?.bizPin });
      if (window.SPos) SPos.toast(`SMS sent to ${res.data?.sent || phones.length} recipients`, 'success');
    } catch (e) {
      if (window.SPos) SPos.toast('SMS failed: ' + e.message, 'error');
    }
  }

  /* Schedule a birthday campaign for today's birthdays */
  async function runBirthdayPromo() {
    const customers = await PosDB.customers.getAll();
    const today = new Date();
    const targets = customers.filter(c => {
      if (!c.birthday) return false;
      const bd = new Date(c.birthday);
      return bd.getMonth() === today.getMonth() && bd.getDate() === today.getDate();
    });
    for (const c of targets) {
      await broadcastWhatsApp(
        `🎂 Happy Birthday {name}! Enjoy 10% off your next purchase today at Sokoni. Show this message at checkout.`,
        null,
      );
    }
    return targets.length;
  }

  async function renderHub(containerId) {
    const el = document.getElementById(containerId);
    if (!el) return;
    const segs = await segment();
    const counts = { diamond: 0, gold: 0, silver: 0, bronze: 0 };
    segs.forEach(c => counts[c.segment]++);

    el.innerHTML = `
      <div class="bos-kpi-strip" style="margin-bottom:14px">
        <div class="bos-kpi-tile"><div class="bos-kpi-label">Total Customers</div><div class="bos-kpi-val">${segs.length}</div></div>
        <div class="bos-kpi-tile green"><div class="bos-kpi-label">Diamond</div><div class="bos-kpi-val green">${counts.diamond}</div></div>
        <div class="bos-kpi-tile"><div class="bos-kpi-label">Gold</div><div class="bos-kpi-val" style="color:#ffd700">${counts.gold}</div></div>
        <div class="bos-kpi-tile"><div class="bos-kpi-label">Silver</div><div class="bos-kpi-val" style="color:#c0c0c0">${counts.silver}</div></div>
      </div>
      <div class="bos-section">
        <div class="bos-section-title">📱 WhatsApp Broadcast</div>
        <select id="mkt-segment" class="form-inp" style="font-size:14px;margin-bottom:8px;width:100%">
          <option value="">All customers (with phone)</option>
          <option value="diamond">Diamond tier only</option>
          <option value="gold">Gold tier+</option>
          <option value="silver">Silver tier+</option>
        </select>
        <textarea id="mkt-message" class="form-inp" rows="4" style="font-size:14px;resize:vertical;width:100%"
          placeholder="Hello {name}! We have a special offer for you…"></textarea>
        <button class="pos-btn-primary" style="margin-top:8px;width:100%"
          onclick="PosMarketing._sendBroadcast()">Send WhatsApp Broadcast</button>
      </div>
      <div class="bos-section">
        <div class="bos-section-title">🎂 Birthday Campaign</div>
        <p style="font-size:12px;color:var(--txt2)">Auto-sends birthday greetings with 10% discount to customers whose birthday is today.</p>
        <button class="bos-action-btn" onclick="PosMarketing.runBirthdayPromo().then(n=>SPos.toast(n+' birthday messages sent','success'))">
          Run Birthday Campaign
        </button>
      </div>
    `;
  }

  async function _sendBroadcast() {
    const message = document.getElementById('mkt-message')?.value?.trim();
    const segment = document.getElementById('mkt-segment')?.value || null;
    if (!message) { if (window.SPos) SPos.toast('Enter a message', 'error'); return; }
    await broadcastWhatsApp(message, segment || null);
  }

  return { segment, broadcastWhatsApp, sendSMS, runBirthdayPromo, renderHub, _sendBroadcast };
})();
window.PosMarketing = PosMarketing;

/* ═══════════════════════════════════════════════════════════════
   REQUIREMENT 32 — Biometric Authentication (WebAuthn)
════════════════════════════════════════════════════════════════ */
const PosBiometric = (() => {
  const RP_ID   = window.location.hostname || 'localhost';
  const RP_NAME = 'Sokoni SmartPOS';

  function _isSupported() {
    return !!(window.PublicKeyCredential && window.navigator.credentials);
  }

  function _buf(base64url) {
    const b64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64.padEnd(b64.length + (4 - b64.length % 4) % 4, '='));
    return Uint8Array.from(bin, c => c.charCodeAt(0));
  }

  function _b64(buf) {
    return btoa(String.fromCharCode(...new Uint8Array(buf)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  }

  function _randomChallenge() {
    const arr = new Uint8Array(32);
    crypto.getRandomValues(arr);
    return arr;
  }

  async function register(cashier) {
    if (!_isSupported()) throw new Error('Biometric authentication not supported on this device.');

    const credential = await navigator.credentials.create({
      publicKey: {
        challenge:           _randomChallenge(),
        rp:                  { name: RP_NAME, id: RP_ID },
        user: {
          id:                new TextEncoder().encode(cashier.id),
          name:              cashier.pin || cashier.id,
          displayName:       cashier.name || cashier.id,
        },
        pubKeyCredParams:    [
          { type: 'public-key', alg: -7  },
          { type: 'public-key', alg: -257 },
        ],
        authenticatorSelection: {
          userVerification:  'required',
          residentKey:       'preferred',
        },
        timeout:             60000,
      },
    });

    const credId = _b64(credential.rawId);
    await PosDB.settings.set(`biometric_cred_${cashier.id}`, credId);
    return credId;
  }

  async function verify(cashierId) {
    if (!_isSupported()) throw new Error('Biometric not supported.');
    const credId = await PosDB.settings.get(`biometric_cred_${cashierId}`);
    if (!credId) throw new Error('No biometric registered for this cashier. Register first.');

    const assertion = await navigator.credentials.get({
      publicKey: {
        challenge:         _randomChallenge(),
        allowCredentials:  [{ type: 'public-key', id: _buf(credId) }],
        userVerification:  'required',
        timeout:           60000,
      },
    });

    return !!assertion;
  }

  async function isRegistered(cashierId) {
    const cred = await PosDB.settings.get(`biometric_cred_${cashierId}`);
    return !!cred;
  }

  async function remove(cashierId) {
    await PosDB.settings.delete(`biometric_cred_${cashierId}`);
  }

  return { register, verify, isRegistered, remove, isSupported: _isSupported };
})();
window.PosBiometric = PosBiometric;

/* ═══════════════════════════════════════════════════════════════
   REQUIREMENT 33 — Omnichannel Inventory Sync
════════════════════════════════════════════════════════════════ */
const PosOmni = (() => {
  let _unsub = null;

  async function startSync(bizPin) {
    if (_unsub) return;
    if (!navigator.onLine) return;
    try {
      const { getFirestore, collection, onSnapshot, query, where } =
        await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');
      const db = getFirestore(window.firebaseApp);
      const q  = query(collection(db, 'products'), where('sellerId', '==', bizPin));

      _unsub = onSnapshot(q, async (snap) => {
        /* One IndexedDB read per snapshot, not one per changed document.
           This previously called PosDB.products.getAll() — a full store read —
           inside the change loop, then scanned the result linearly, making the
           handler O(M x P). Unlike the pos-omni case this loop awaits, so peak
           memory was one array rather than M; the cost here is M full reads and
           M linear scans of CPU and IndexedDB latency. This query carries no
           limit(), so M is bounded only by the seller's catalogue size.

           Behaviour is unchanged: the same products match on the same key and
           the same stock field syncs. */
        const changes = snap.docChanges().filter(c => c.type === 'modified' && c.doc.data().stock !== undefined);
        if (!changes.length) return;

        const all = await PosDB.products.getAll();
        const byMarketplaceId = new Map();
        for (const p of all) {
          if (p && p.marketplaceId && !byMarketplaceId.has(p.marketplaceId)) {
            byMarketplaceId.set(p.marketplaceId, p);   /* first match wins, as find() did */
          }
        }

        for (const change of changes) {
          const data  = change.doc.data();
          const local = byMarketplaceId.get(change.doc.id);
          if (local && local.stock !== data.stock) {
            await PosDB.products.update(local.id, { stock: data.stock });
            if (window.SPos) SPos.toast(`Stock synced: ${data.name} → ${data.stock} units`, 'info');
          }
        }
      });
    } catch (e) {
      console.warn('[PosOmni] Sync start failed:', e.message);
    }
  }

  function stopSync() {
    if (_unsub) { _unsub(); _unsub = null; }
  }

  async function pushStock(productId) {
    const product = await PosDB.products.get(productId);
    if (!product?.marketplaceId) return;
    const { getFirestore, doc, updateDoc } =
      await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');
    const db = getFirestore(window.firebaseApp);
    await updateDoc(doc(db, 'products', product.marketplaceId), { stock: product.stock });
  }

  return { startSync, stopSync, pushStock };
})();
window.PosOmni = PosOmni;

/* ═══════════════════════════════════════════════════════════════
   REQUIREMENT 35 — Warranty / IMEI / Serial Number Tracking
════════════════════════════════════════════════════════════════ */
const PosSerial = (() => {

  async function add(data) {
    return PosDB.serial_numbers.add({
      ...data,
      addedAt:   Date.now(),
      status:    data.status || 'sold',
    });
  }

  async function getBySerial(serial) {
    const all = await PosDB.serial_numbers.getAll();
    return all.find(s => s.serial === serial || s.imei === serial) || null;
  }

  async function getForProduct(productId) {
    const all = await PosDB.serial_numbers.getAll();
    return all.filter(s => s.productId === productId);
  }

  async function getForTransaction(txnId) {
    const all = await PosDB.serial_numbers.getAll();
    return all.filter(s => s.transactionId === txnId);
  }

  async function checkWarranty(serial) {
    const item = await getBySerial(serial);
    if (!item) return { valid: false, message: 'Serial number not found.' };
    if (!item.warrantyMonths) return { valid: false, message: 'No warranty information on file.' };
    const expires = item.saleDate + item.warrantyMonths * 30 * 86400000;
    const now     = Date.now();
    if (now > expires) {
      return { valid: false, expired: true, expiresDate: new Date(expires).toLocaleDateString(), ...item };
    }
    const daysLeft = Math.ceil((expires - now) / 86400000);
    return { valid: true, daysLeft, expiresDate: new Date(expires).toLocaleDateString(), ...item };
  }

  /* Called after a sale to record serials for tracked products */
  async function recordSaleSerials(txn, serialMap) {
    for (const [productId, serials] of Object.entries(serialMap)) {
      const product = await PosDB.products.get(productId);
      for (const serial of serials) {
        await add({
          serial,
          productId,
          productName:   product?.name,
          transactionId: txn.id,
          receiptNo:     txn.receiptNo,
          customerName:  txn.customerName,
          customerPhone: txn.customerPhone,
          saleDate:      txn.completedAt || Date.now(),
          warrantyMonths: product?.warrantyMonths || 0,
          status:        'sold',
        });
      }
    }
  }

  async function renderWarrantyCheck(containerId) {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.innerHTML = `
      <div style="display:flex;gap:8px;margin-bottom:12px">
        <input type="text" id="warranty-serial-input" class="form-inp" style="font-size:16px;flex:1"
          placeholder="Enter serial number or IMEI…">
        <button class="bos-action-btn" onclick="PosSerial._check()">Check Warranty</button>
      </div>
      <div id="warranty-result"></div>
    `;
  }

  async function _check() {
    const serial = document.getElementById('warranty-serial-input')?.value?.trim();
    const res    = document.getElementById('warranty-result');
    if (!serial || !res) return;
    const result = await checkWarranty(serial);
    if (result.valid) {
      res.innerHTML = `
        <div style="background:rgba(113,255,0,.08);border:1px solid rgba(113,255,0,.2);border-radius:10px;padding:14px">
          <div style="color:var(--green);font-weight:700;margin-bottom:6px">✓ Valid Warranty</div>
          <div>Product: <b>${result.productName || 'Unknown'}</b></div>
          <div>Serial: <b>${result.serial}</b></div>
          <div>Customer: ${result.customerName || '—'} · ${result.customerPhone || '—'}</div>
          <div>Sale Date: ${new Date(result.saleDate).toLocaleDateString()}</div>
          <div>Expires: <span style="color:var(--green)">${result.expiresDate}</span> (${result.daysLeft} days left)</div>
        </div>`;
    } else if (result.expired) {
      res.innerHTML = '<div class="bos-error"></div>'; res.firstChild.textContent = 'Warranty expired on ' + (result.expiresDate || '');
    } else {
      res.innerHTML = '<div class="bos-error"></div>'; res.firstChild.textContent = result.message || 'Warranty not found';
    }
  }

  return { add, getBySerial, getForProduct, getForTransaction, checkWarranty, recordSaleSerials, renderWarrantyCheck, _check };
})();
window.PosSerial = PosSerial;

/* ═══════════════════════════════════════════════════════════════
   REQUIREMENT 36 — Advanced Barcode & QR Label Printing
════════════════════════════════════════════════════════════════ */
const PosLabels = (() => {

  function generateQRSVG(text, size = 120) {
    /* Minimal QR-code placeholder — in production use qrcode.js CDN */
    const cells = 25;
    const cs    = size / cells;
    const rects = [];
    /* Finder patterns (corners) */
    const _finder = (ox, oy) => {
      for (let r = 0; r < 7; r++) for (let c = 0; c < 7; c++) {
        if (r === 0 || r === 6 || c === 0 || c === 6 ||
           (r >= 2 && r <= 4 && c >= 2 && c <= 4)) {
          rects.push(`<rect x="${(ox+c)*cs}" y="${(oy+r)*cs}" width="${cs}" height="${cs}" fill="#000"/>`);
        }
      }
    };
    _finder(0, 0); _finder(cells - 7, 0); _finder(0, cells - 7);
    /* Data area — deterministic pseudo-random from text */
    let seed = 0; for (let i = 0; i < text.length; i++) seed = (seed * 31 + text.charCodeAt(i)) >>> 0;
    for (let r = 0; r < cells; r++) for (let c = 0; c < cells; c++) {
      if (r < 9 && (c < 9 || c >= cells - 8)) continue;
      seed = (seed * 1664525 + 1013904223) >>> 0;
      if (seed >>> 31) rects.push(`<rect x="${c*cs}" y="${r*cs}" width="${cs}" height="${cs}" fill="#000"/>`);
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
      <rect width="${size}" height="${size}" fill="#fff"/>
      ${rects.join('')}
    </svg>`;
  }

  async function loadQRLib() {
    if (window.QRCode) return;
    await new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
      s.onload = res; s.onerror = rej;
      document.head.appendChild(s);
    });
  }

  async function printProductLabels(products, template = 'standard') {
    const TEMPLATES = {
      standard: (p) => `
        <div style="width:58mm;height:38mm;border:1px solid #ccc;padding:4mm;font-family:sans-serif;display:inline-block;margin:2mm;page-break-inside:avoid;box-sizing:border-box">
          <div style="font-size:10pt;font-weight:bold;margin-bottom:2mm;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">${p.name}</div>
          <div style="text-align:center;margin-bottom:2mm">${p._barcodeSvg || ''}</div>
          <div style="font-size:8pt;text-align:center;margin-bottom:1mm">${p.barcode || p.id}</div>
          <div style="font-size:14pt;font-weight:900;color:#000;text-align:center">KES ${(p.price||0).toLocaleString()}</div>
          ${p.category ? `<div style="font-size:7pt;color:#666;text-align:right">${p.category}</div>` : ''}
        </div>
      `,
      qr: (p) => `
        <div style="width:58mm;height:50mm;border:1px solid #ccc;padding:3mm;font-family:sans-serif;display:inline-block;margin:2mm;page-break-inside:avoid;box-sizing:border-box">
          <div style="font-size:9pt;font-weight:bold;margin-bottom:1mm">${p.name}</div>
          <div style="display:flex;gap:2mm;align-items:center">
            <div style="font-size:12pt;font-weight:900">KES ${(p.price||0).toLocaleString()}</div>
            <div style="margin-left:auto">${generateQRSVG(p.id, 40)}</div>
          </div>
          <div style="font-size:7pt;color:#666;margin-top:1mm">Scan to view product</div>
        </div>
      `,
      shelf: (p) => `
        <div style="width:90mm;height:25mm;border:1px solid #ccc;padding:2mm 4mm;font-family:sans-serif;display:inline-block;margin:2mm;box-sizing:border-box;display:flex;align-items:center;gap:4mm">
          <div>
            <div style="font-size:11pt;font-weight:bold">${p.name}</div>
            <div style="font-size:8pt;color:#666">${p.category || ''} · ${p.unit || 'pcs'}</div>
          </div>
          <div style="margin-left:auto;text-align:right">
            <div style="font-size:16pt;font-weight:900">KES ${(p.price||0).toLocaleString()}</div>
            ${p._barcodeSvg ? `<div>${p._barcodeSvg}</div>` : ''}
          </div>
        </div>
      `,
    };

    const tpl = TEMPLATES[template] || TEMPLATES.standard;

    /* Enrich with barcode SVGs */
    const enriched = products.map(p => ({
      ...p,
      _barcodeSvg: p.barcode && window.PosBarcode ? PosBarcode.generateSVG(p.barcode, { width: 120, height: 30 }) : '',
    }));

    const html = `
      <!DOCTYPE html><html><head>
        <meta charset="UTF-8">
        <title>Labels — Sokoni POS</title>
        <style>body{margin:10mm}@media print{body{margin:5mm}}</style>
      </head><body>
        ${enriched.map(tpl).join('')}
        <script>window.print(); window.onafterprint=()=>window.close();<\/script>
      </body></html>
    `;

    const w = window.open('', '_blank', 'width=800,height=600');
    if (w) { w.document.write(html); w.document.close(); }
  }

  async function renderDesigner(containerId) {
    const el = document.getElementById(containerId);
    if (!el) return;
    const products = await PosDB.products.getAll();

    el.innerHTML = `
      <div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap">
        <select id="label-template" class="form-inp" style="font-size:14px">
          <option value="standard">Standard (58mm × 38mm)</option>
          <option value="qr">QR Code Label</option>
          <option value="shelf">Shelf Label (90mm × 25mm)</option>
        </select>
        <select id="label-category" class="form-inp" style="font-size:14px">
          <option value="">All categories</option>
          ${[...new Set(products.map(p => p.category).filter(Boolean))].map(c => `<option>${c}</option>`).join('')}
        </select>
        <button class="pos-btn-primary" onclick="PosLabels._printSelected()">🖨️ Print Labels</button>
      </div>
      <div id="label-product-list">
        ${products.map(p => `
          <label style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border);font-size:13px;cursor:pointer">
            <input type="checkbox" data-id="${p.id}" style="accent-color:var(--green)">
            <span style="flex:1">${p.name}</span>
            <span style="color:var(--green)">KES ${(p.price||0).toLocaleString()}</span>
            <span style="font-size:10px;color:var(--txt2)">${p.barcode || 'No barcode'}</span>
          </label>
        `).join('')}
      </div>
    `;
  }

  async function _printSelected() {
    const template = document.getElementById('label-template')?.value || 'standard';
    const checked  = [...document.querySelectorAll('#label-product-list input[type=checkbox]:checked')];
    if (!checked.length) { if (window.SPos) SPos.toast('Select at least one product', 'error'); return; }
    const ids      = checked.map(c => c.dataset.id);
    const products = await PosDB.products.getAll().then(all => all.filter(p => ids.includes(p.id)));
    await printProductLabels(products, template);
  }

  return { generateQRSVG, printProductLabels, renderDesigner, _printSelected };
})();
window.PosLabels = PosLabels;

/* ═══════════════════════════════════════════════════════════════
   REQUIREMENT 38 — Repair & Service Center Management
════════════════════════════════════════════════════════════════ */
const PosRepair = (() => {

  const STATUSES = ['Received', 'Diagnosing', 'Waiting Parts', 'In Repair', 'Ready', 'Collected', 'Cancelled'];

  async function createJob(data) {
    const jobNo = `JOB-${Date.now().toString(36).toUpperCase()}`;
    return PosDB.repairs.add({
      ...data,
      jobNo,
      status:      'Received',
      receivedAt:  Date.now(),
      updatedAt:   Date.now(),
      parts:       data.parts || [],
      laborCost:   data.laborCost || 0,
      totalCost:   0,
    });
  }

  async function updateStatus(jobId, status, note = '') {
    const job = await PosDB.repairs.get(jobId);
    if (!job) throw new Error('Job not found');
    const history = job.history || [];
    history.push({ status, note, ts: Date.now(), cashier: window.SPos?.state?.currentCashier?.name });
    await PosDB.repairs.update(jobId, { status, updatedAt: Date.now(), history });
    /* Notify customer */
    if (status === 'Ready' && job.customerPhone && window.PosBoss) {
      const msg = `Hello ${job.customerName || 'Customer'}, your ${job.deviceName} (Job: ${job.jobNo}) is ready for collection at Sokoni. Thank you!`;
      const phone = job.customerPhone.replace(/\D/g, '').replace(/^0/, '254');
      window.open(`https://wa.me/${phone}?text=${encodeURIComponent(msg)}`, '_blank');
    }
    if (window.PosAudit) PosAudit.log('repair_status', { jobId, jobNo: job.jobNo, status });
  }

  async function addPart(jobId, part) {
    const job   = await PosDB.repairs.get(jobId);
    const parts = [...(job?.parts || []), { ...part, addedAt: Date.now() }];
    const partsCost = parts.reduce((s, p) => s + (p.cost || 0) * (p.qty || 1), 0);
    const totalCost = partsCost + (job?.laborCost || 0);
    await PosDB.repairs.update(jobId, { parts, totalCost, updatedAt: Date.now() });
  }

  async function completeJob(jobId, paymentMethod = 'cash') {
    const job = await PosDB.repairs.get(jobId);
    if (!job) throw new Error('Job not found');

    /* Create transaction */
    const txnData = {
      items: [{
        productId: null, name: `Repair: ${job.deviceName} (${job.jobNo})`,
        qty: 1, price: job.totalCost, cost: 0,
      }],
      total:         job.totalCost,
      paymentMethod,
      receiptNo:     `R${job.jobNo}`,
      completedAt:   Date.now(),
      type:          'repair',
      customerId:    job.customerId,
      customerName:  job.customerName,
      status:        'completed',
      cashierId:     window.SPos?.state?.currentCashier?.id,
      cashierName:   window.SPos?.state?.currentCashier?.name,
    };
    const txnId = await PosDB.transactions.add(txnData);
    await PosDB.repairs.update(jobId, { status: 'Collected', paidAt: Date.now(), transactionId: txnId });
    return txnId;
  }

  async function renderHub(containerId) {
    const el = document.getElementById(containerId);
    if (!el) return;
    const jobs = await PosDB.repairs.getAll();

    const active = jobs.filter(j => !['Collected','Cancelled'].includes(j.status));
    const done   = jobs.filter(j =>  ['Collected'].includes(j.status));

    el.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <div class="bos-panel-title">🔧 Repair Center</div>
        <button class="bos-action-btn" onclick="PosRepair._openNewJob()">+ New Job</button>
      </div>
      <div style="display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap">
        ${STATUSES.map(s => {
          const count = active.filter(j => j.status === s).length;
          return `<span style="font-size:11px;padding:3px 10px;border-radius:10px;background:var(--card);border:1px solid var(--border)">${s} <b>${count}</b></span>`;
        }).join('')}
      </div>
      <table class="pos-table" style="font-size:12px">
        <thead><tr><th>Job No.</th><th>Device</th><th>Customer</th><th>Status</th><th>Cost</th><th>Received</th><th></th></tr></thead>
        <tbody>
          ${active.concat(done.slice(0,5)).map(j => `
            <tr>
              <td style="font-weight:700;color:var(--green)">${j.jobNo}</td>
              <td>${j.deviceName || '—'}</td>
              <td>${j.customerName || '—'}</td>
              <td><span class="repair-status repair-${j.status.toLowerCase().replace(' ','-')}">${j.status}</span></td>
              <td>KES ${(j.totalCost||0).toLocaleString()}</td>
              <td>${new Date(j.receivedAt).toLocaleDateString()}</td>
              <td>
                <button class="bos-action-btn" onclick="PosRepair._openJob('${j.id}')">View</button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      <div id="repair-job-form" style="display:none;margin-top:14px"></div>
      <div id="repair-job-detail" style="display:none;margin-top:14px"></div>
    `;
  }

  function _openNewJob() {
    const form = document.getElementById('repair-job-form');
    if (!form) return;
    form.style.display = '';
    form.innerHTML = `
      <div class="bos-section">
        <div class="bos-section-title">New Repair Job</div>
        <div class="form-row"><label class="form-lbl">Customer Name</label><input id="rj-cust-name" class="form-inp" placeholder="John Doe" style="font-size:16px"></div>
        <div class="form-row"><label class="form-lbl">Phone</label><input id="rj-phone" class="form-inp" placeholder="0712 345 678" type="tel" style="font-size:16px"></div>
        <div class="form-row"><label class="form-lbl">Device</label><input id="rj-device" class="form-inp" placeholder="iPhone 14, Samsung S22…" style="font-size:16px"></div>
        <div class="form-row"><label class="form-lbl">Serial / IMEI</label><input id="rj-serial" class="form-inp" placeholder="IMEI or serial" style="font-size:16px"></div>
        <div class="form-row"><label class="form-lbl">Problem Description</label>
          <textarea id="rj-problem" class="form-inp" rows="3" style="font-size:14px;resize:vertical" placeholder="Describe the fault…"></textarea></div>
        <div class="form-row"><label class="form-lbl">Estimated Cost (KES)</label><input id="rj-estimate" type="number" class="form-inp" placeholder="0" style="font-size:16px"></div>
        <div style="display:flex;gap:8px;margin-top:10px">
          <button class="pos-btn-primary" onclick="PosRepair._saveNewJob()">Create Job Card</button>
          <button class="bos-action-btn" onclick="document.getElementById('repair-job-form').style.display='none'">Cancel</button>
        </div>
      </div>
    `;
  }

  async function _saveNewJob() {
    const data = {
      customerName: document.getElementById('rj-cust-name')?.value?.trim(),
      customerPhone: document.getElementById('rj-phone')?.value?.trim(),
      deviceName:   document.getElementById('rj-device')?.value?.trim(),
      imei:         document.getElementById('rj-serial')?.value?.trim(),
      problem:      document.getElementById('rj-problem')?.value?.trim(),
      estimatedCost: parseFloat(document.getElementById('rj-estimate')?.value || 0),
    };
    if (!data.deviceName) { if (window.SPos) SPos.toast('Enter device name', 'error'); return; }
    const id = await createJob(data);
    if (window.SPos) SPos.toast(`Job created: ${id}`, 'success');
    if (window.PosAudit) PosAudit.log('product_created', { jobType: 'repair', device: data.deviceName });
    document.getElementById('repair-job-form').style.display = 'none';
    await renderHub('repair-body');
  }

  async function _openJob(jobId) {
    const detail = document.getElementById('repair-job-detail');
    if (!detail) return;
    const j = await PosDB.repairs.get(jobId);
    if (!j) return;
    detail.style.display = '';
    detail.innerHTML = `
      <div class="bos-section">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
          <div style="font-weight:700">${j.jobNo} — ${j.deviceName}</div>
          <button class="bos-action-btn" onclick="document.getElementById('repair-job-detail').style.display='none'">✕</button>
        </div>
        <div style="font-size:12px;color:var(--txt2);margin-bottom:10px">${j.customerName || ''} · ${j.customerPhone || ''}</div>
        <div style="margin-bottom:8px"><b>Problem:</b> ${j.problem || '—'}</div>
        <div style="margin-bottom:8px"><b>Status:</b> ${j.status}</div>
        <div style="margin-bottom:8px"><b>Total Cost:</b> KES ${(j.totalCost||0).toLocaleString()}</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <select id="repair-new-status-${jobId}" class="form-inp" style="font-size:14px">
            ${STATUSES.map(s => `<option ${s===j.status?'selected':''}>${s}</option>`).join('')}
          </select>
          <button class="bos-action-btn" onclick="PosRepair.updateStatus('${jobId}',document.getElementById('repair-new-status-${jobId}').value).then(()=>PosRepair._openJob('${jobId}'))">Update Status</button>
          ${j.status === 'Ready' ? `<button class="pos-btn-primary" onclick="PosRepair.completeJob('${jobId}').then(txnId=>SPos.toast('Job completed, receipt #'+txnId,'success'))">Complete & Bill</button>` : ''}
        </div>
      </div>
    `;
  }

  return { createJob, updateStatus, addPart, completeJob, renderHub, _openNewJob, _saveNewJob, _openJob, STATUSES };
})();
window.PosRepair = PosRepair;
