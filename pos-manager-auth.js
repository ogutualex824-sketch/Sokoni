/* pos-manager-auth.js — SOKONI Manager Authorization Engine v1.0
 * ─────────────────────────────────────────────────────────────
 * Five approval methods: PIN · QR Badge · NFC Card · Mobile App · Biometric
 * Protected operations:  Refund · Void · Price Override · Large Discount ·
 *   Stock Adjustment · Cash Drawer · Shift Close · Inventory Correction
 * Every approval writes an immutable audit log (IndexedDB + Firestore)
 * Works on phone, tablet, and desktop POS environments
 */
'use strict';

window.ManagerAuth = (() => {

  /* ═══════════════════════════════════════════════════════════
     CONSTANTS
  ═══════════════════════════════════════════════════════════ */
  const OPERATIONS = {
    refund:               { label: 'Process Refund',       icon: '↩' },
    void:                 { label: 'Void Transaction',     icon: '⊗' },
    price_override:       { label: 'Price Override',       icon: '✏' },
    large_discount:       { label: 'Large Discount',       icon: '%' },
    stock_adjustment:     { label: 'Stock Adjustment',     icon: '📦' },
    cash_drawer:          { label: 'Cash Drawer Access',   icon: '💰' },
    shift_close:          { label: 'Close Shift',          icon: '⏻' },
    inventory_correction: { label: 'Inventory Correction', icon: '🗂' },
  };

  const METHODS = {
    pin:       { label: 'PIN',       icon: '🔢' },
    qr:        { label: 'QR Badge',  icon: '📷' },
    nfc:       { label: 'NFC Card',  icon: '📡' },
    mobile:    { label: 'Mobile',    icon: '📱' },
    biometric: { label: 'Biometric', icon: '👁' },
  };

  const DB_NAME   = 'sokoni-manager-auth-v1';
  const DB_VER    = 1;
  const QR_PREFIX = 'SOKONI-MGR:v1:';

  /* ─── Default config ─── */
  let _cfg = {
    enabled:                     true,
    largeDiscountPctThreshold:   15,   /* % discount that triggers guard        */
    largeDiscountAmtThreshold:   500,  /* KES flat discount that triggers guard */
    enabledOps:                  Object.keys(OPERATIONS),
    enabledMethods:              Object.keys(METHODS),
    maxPinAttempts:              3,
    mobilePinTimeoutSec:         300,
    requireManagerForCashDrawer: false,
  };

  /* ─── Runtime state ─── */
  let _db             = null;
  let _resolve        = null;
  let _overlay        = null;
  let _pinDigits      = '';
  let _pinAttempts    = 0;
  let _cameraStream   = null;
  let _cameraInterval = null;
  let _nfcAbort       = null;
  let _mobileUnsub    = null;
  let _mobileTimer    = null;
  let _activeMethod   = null;
  let _currentOp      = null;
  let _currentCtx     = null;
  let _cssInjected    = false;

  /* ═══════════════════════════════════════════════════════════
     CSS  (injected once on first request)
  ═══════════════════════════════════════════════════════════ */
  const _CSS = `
.mauth-overlay{position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.87);display:flex;align-items:flex-end;justify-content:center;animation:mauth-fi .2s ease;-webkit-tap-highlight-color:transparent}
@media(min-width:600px){.mauth-overlay{align-items:center}}
.mauth-card{background:#18181f;border-radius:20px 20px 0 0;width:100%;max-width:440px;max-height:90dvh;overflow-y:auto;animation:mauth-su .25s ease;padding:18px 18px 36px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#f0f0f6;box-sizing:border-box}
@media(min-width:600px){.mauth-card{border-radius:20px;max-height:82dvh}}
.mauth-drag{width:40px;height:4px;background:rgba(255,255,255,.14);border-radius:2px;margin:0 auto 14px}
.mauth-op-hdr{text-align:center;padding:6px 0 12px;border-bottom:1px solid rgba(255,255,255,.07);margin-bottom:12px}
.mauth-op-ico{font-size:32px;margin-bottom:4px}
.mauth-op-lbl{font-size:16px;font-weight:800;color:#f0f0f6}
.mauth-op-ctx{font-size:12px;color:#9898aa;margin-top:4px;line-height:1.45}
.mauth-tabs{display:flex;gap:3px;padding:4px;background:#111118;border-radius:12px;margin-bottom:12px}
.mauth-tab{flex:1;padding:7px 2px;border:none;border-radius:9px;background:transparent;color:#9898aa;font-size:9px;font-weight:700;cursor:pointer;transition:all .18s;display:flex;flex-direction:column;align-items:center;gap:2px;min-width:0;letter-spacing:.02em}
.mauth-tab .ti{font-size:15px}
.mauth-tab.active{background:#18181f;color:#71ff00;box-shadow:0 0 0 1px rgba(113,255,0,.2)}
.mauth-content{min-height:180px}
.mauth-pin-dots{display:flex;justify-content:center;gap:14px;margin:18px 0 20px}
.mauth-pin-dot{width:13px;height:13px;border-radius:50%;border:2px solid rgba(255,255,255,.2);transition:all .12s}
.mauth-pin-dot.f{background:#71ff00;border-color:#71ff00;transform:scale(1.1)}
.mauth-pin-dot.x{background:#ef4444;border-color:#ef4444}
.mauth-keypad{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;max-width:290px;margin:0 auto}
.mauth-key{padding:14px 0;border:1px solid rgba(255,255,255,.07);border-radius:12px;background:#1e1e28;color:#f0f0f6;font-size:21px;font-weight:600;cursor:pointer;transition:all .1s;text-align:center;user-select:none;-webkit-tap-highlight-color:transparent;touch-action:manipulation;width:100%}
.mauth-key:active,.mauth-key:hover{background:rgba(113,255,0,.1);border-color:rgba(113,255,0,.25);color:#71ff00}
.mauth-key.del{font-size:16px;color:#9898aa}
.mauth-key.clr{font-size:12px;color:#9898aa;font-weight:700}
.mauth-cam-wrap{border-radius:12px;overflow:hidden;background:#000;position:relative;margin-bottom:8px}
.mauth-cam-wrap video{width:100%;height:210px;object-fit:cover;display:block}
.mauth-cam-frame{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none}
.mauth-cam-target{width:145px;height:145px;border-radius:12px;box-shadow:0 0 0 2px #71ff00,0 0 0 4000px rgba(0,0,0,.4)}
.mauth-cam-hint{text-align:center;font-size:12px;color:#9898aa;padding:5px 0 8px}
.mauth-nfc-wrap{display:flex;flex-direction:column;align-items:center;padding:22px 0 14px}
.mauth-nfc-ring{position:relative;width:88px;height:88px;margin-bottom:12px}
.mauth-nfc-w{position:absolute;inset:0;border:2px solid #71ff00;border-radius:50%;opacity:0;animation:mauth-nfc 2s ease-in-out infinite}
.mauth-nfc-w:nth-child(2){animation-delay:.65s}
.mauth-nfc-w:nth-child(3){animation-delay:1.3s}
.mauth-nfc-core{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:34px}
@keyframes mauth-nfc{0%{transform:scale(.5);opacity:.8}100%{transform:scale(2.2);opacity:0}}
.mauth-mgr-list{display:flex;flex-direction:column;gap:7px;margin-bottom:12px;max-height:200px;overflow-y:auto}
.mauth-mgr-btn{padding:10px 13px;border:1px solid rgba(255,255,255,.07);border-radius:10px;background:#1e1e28;color:#f0f0f6;font-size:13px;font-weight:600;cursor:pointer;text-align:left;transition:all .15s;display:flex;align-items:center;gap:9px;width:100%}
.mauth-mgr-btn:hover{border-color:rgba(113,255,0,.3)}
.mauth-mgr-btn.sel{border-color:#71ff00;background:rgba(113,255,0,.07);color:#71ff00}
.mauth-role{font-size:10px;color:#9898aa;font-weight:400;margin-left:auto;text-transform:capitalize}
.mauth-wait{text-align:center;padding:14px 0 6px}
.mauth-countdown{font-size:40px;font-weight:900;color:#71ff00;line-height:1;margin:4px 0 8px;font-variant-numeric:tabular-nums}
.mauth-bio-wrap{display:flex;flex-direction:column;align-items:center;padding:18px 0 10px}
.mauth-bio-ico{font-size:54px;margin-bottom:10px;animation:mauth-bp 2s ease-in-out infinite}
@keyframes mauth-bp{0%,100%{transform:scale(1);opacity:1}50%{transform:scale(1.08);opacity:.7}}
.mauth-status{text-align:center;padding:9px 12px;border-radius:10px;font-size:13px;font-weight:600;min-height:38px;display:flex;align-items:center;justify-content:center;margin-top:10px;opacity:0;transition:opacity .2s}
.mauth-status.vis{opacity:1}
.mauth-status.err{background:rgba(239,68,68,.12);color:#ef4444}
.mauth-status.ok{background:rgba(113,255,0,.12);color:#71ff00}
.mauth-status.inf{background:rgba(96,165,250,.12);color:#60a5fa}
.mauth-cancel{width:100%;margin-top:12px;padding:12px;background:rgba(239,68,68,.07);border:1px solid rgba(239,68,68,.18);border-radius:12px;color:#ef4444;font-size:14px;font-weight:700;cursor:pointer;transition:all .18s}
.mauth-cancel:hover{background:#ef4444;color:#fff}
@keyframes mauth-fi{from{opacity:0}to{opacity:1}}
@keyframes mauth-su{from{transform:translateY(16px);opacity:0}to{transform:translateY(0);opacity:1}}
`;

  function _injectCSS() {
    if (_cssInjected || document.getElementById('mauth-css')) { _cssInjected = true; return; }
    const s = document.createElement('style');
    s.id = 'mauth-css';
    s.textContent = _CSS;
    document.head.appendChild(s);
    _cssInjected = true;
  }

  /* ═══════════════════════════════════════════════════════════
     CRYPTO
  ═══════════════════════════════════════════════════════════ */
  async function _sha256(text) {
    const buf  = new TextEncoder().encode(text);
    const hash = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  function _genId() {
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9);
  }

  function _genSalt() {
    return Array.from(crypto.getRandomValues(new Uint8Array(16)))
      .map(b => b.toString(16).padStart(2, '0')).join('');
  }

  function _genToken() {
    return Array.from(crypto.getRandomValues(new Uint8Array(24)))
      .map(b => b.toString(16).padStart(2, '0')).join('');
  }

  function _ab2b64url(ab) {
    return btoa(String.fromCharCode(...new Uint8Array(ab)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  }

  function _b64url2ab(str) {
    str = str.replace(/-/g, '+').replace(/_/g, '/');
    while (str.length % 4) str += '=';
    return Uint8Array.from(atob(str), c => c.charCodeAt(0)).buffer;
  }

  /* ═══════════════════════════════════════════════════════════
     INDEXEDDB
  ═══════════════════════════════════════════════════════════ */
  function _openDB() {
    if (_db) return Promise.resolve(_db);
    return new Promise((res, rej) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = ev => {
        const db = ev.target.result;
        if (!db.objectStoreNames.contains('managers')) {
          const ms = db.createObjectStore('managers', { keyPath: 'id' });
          ms.createIndex('active', 'active', { unique: false });
        }
        if (!db.objectStoreNames.contains('audit_log')) {
          const al = db.createObjectStore('audit_log', { keyPath: 'id' });
          al.createIndex('operation',  'operation',  { unique: false });
          al.createIndex('requestedAt','requestedAt',{ unique: false });
        }
        if (!db.objectStoreNames.contains('config')) {
          db.createObjectStore('config', { keyPath: 'key' });
        }
      };
      req.onsuccess = ev => { _db = ev.target.result; res(_db); };
      req.onerror   = () => rej(req.error);
    });
  }

  async function _dbGet(store, key) {
    const db = await _openDB();
    return new Promise((res, rej) => {
      const rq = db.transaction(store, 'readonly').objectStore(store).get(key);
      rq.onsuccess = () => res(rq.result);
      rq.onerror   = () => rej(rq.error);
    });
  }

  async function _dbPut(store, obj) {
    const db = await _openDB();
    return new Promise((res, rej) => {
      const rq = db.transaction(store, 'readwrite').objectStore(store).put(obj);
      rq.onsuccess = () => res(rq.result);
      rq.onerror   = () => rej(rq.error);
    });
  }

  async function _dbGetAll(store) {
    const db = await _openDB();
    return new Promise((res, rej) => {
      const rq = db.transaction(store, 'readonly').objectStore(store).getAll();
      rq.onsuccess = () => res(rq.result);
      rq.onerror   = () => rej(rq.error);
    });
  }

  /* ═══════════════════════════════════════════════════════════
     CONFIGURATION
  ═══════════════════════════════════════════════════════════ */
  async function _loadConfig() {
    try {
      const row = await _dbGet('config', 'main');
      if (row) Object.assign(_cfg, row.value);
    } catch (_) { /* use defaults */ }
  }

  async function _saveConfig() {
    await _dbPut('config', { key: 'main', value: _cfg });
  }

  /* ═══════════════════════════════════════════════════════════
     ENVIRONMENT HELPERS
  ═══════════════════════════════════════════════════════════ */
  function _fdb() {
    try { if (window.firebase?.firestore) return firebase.firestore(); } catch (_) {}
    return null;
  }

  function _shopId() {
    return window.state?.settings?.shopId
      || window._posShopId
      || localStorage.getItem('sokoni_shop_id')
      || 'default';
  }

  /* ── Server-side authorization plumbing ──────────────────────────
     PIN verification used to be performed entirely on the client: every manager's salted hash
     lived in IndexedDB and _checkPIN() compared against it locally, so anyone with devtools
     could approve their own refunds, voids, price overrides and stock adjustments.

     Verification is now server-first via the deployed validateDeviceAccess callable, which
     rate-limits (5 attempts / uid / 5 min), resolves the PIN against posStaff (a CF-only
     collection) and logs every attempt. The local hash remains ONLY as an offline fallback —
     see _checkPIN. High-risk operations refuse the fallback entirely. */
  function _merchantId() {
    return window._posMerchantId || localStorage.getItem('sokoni_merchant_id') || null;
  }
  function _branchId() {
    return window._posBranchId || localStorage.getItem('sokoni_branch_id') || null;
  }
  function _online() {
    return typeof navigator === 'undefined' ? true : navigator.onLine !== false;
  }

  /* Operations where a forged approval moves money or stock. These NEVER accept the offline
     fallback — an unverifiable approval is worse than making the cashier wait for signal. */
  const HIGH_RISK_OPS = ['refund', 'void', 'price_override', 'stock_adjustment', 'inventory_correction'];

  /** Verify a PIN against the server. Returns {valid, employee} or null when unreachable. */
  async function _verifyPinServer(pin) {
    const merchantId = _merchantId();
    const branchId   = _branchId();
    if (!merchantId || !branchId) return null;            // not provisioned — cannot verify
    let callable;
    try {
      if (!window.firebase?.functions) return null;
      callable = firebase.functions().httpsCallable('validateDeviceAccess');
    } catch (_) { return null; }

    try {
      const res = await callable({ merchantId, branchId, pin: String(pin) });
      const d = res && res.data ? res.data : {};
      return { valid: !!d.valid, employee: d.employee || null };
    } catch (e) {
      /* resource-exhausted = server rate limit tripped. Surface it rather than silently
         falling back to the local check, which would defeat the limit entirely. */
      if (e && (e.code === 'resource-exhausted' || e.code === 'functions/resource-exhausted')) {
        return { valid: false, employee: null, rateLimited: true };
      }
      return null;                                        // network/transport failure -> offline path
    }
  }

  function _cashier() {
    const c = window.state?.currentCashier || {};
    return { id: c.id || 'unknown', name: c.name || 'Cashier' };
  }

  function _rpId() {
    const h = window.location.hostname;
    return (!h || h === 'localhost') ? 'localhost' : h;
  }

  /* ═══════════════════════════════════════════════════════════
     AUDIT LOG
  ═══════════════════════════════════════════════════════════ */
  async function _writeAudit(entry) {
    const id  = _genId();
    const row = { id, ...entry, shopId: _shopId(), terminal: navigator.userAgent.slice(0, 60) };

    /* Always write locally first (works offline) */
    try { await _dbPut('audit_log', row); } catch (_) {}

    /* Firestore — immutable (security rules block update/delete) */
    try {
      const db = _fdb();
      if (db) {
        db.collection('managerAuditLog').doc(id).set({
          ...row,
          _createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        }).catch(() => {});
      }
    } catch (_) {}

    return id;
  }

  async function getAuditLog(limit = 100) {
    try {
      const rows = await _dbGetAll('audit_log');
      return rows.sort((a, b) => b.requestedAt - a.requestedAt).slice(0, limit);
    } catch (_) { return []; }
  }

  /* ═══════════════════════════════════════════════════════════
     MANAGER STORAGE
  ═══════════════════════════════════════════════════════════ */
  async function listManagers() {
    const all = await _dbGetAll('managers');
    return all.filter(m => m.active !== false);
  }

  async function _getMgr(id) {
    return _dbGet('managers', id);
  }

  async function _saveMgr(mgr) {
    await _dbPut('managers', { ...mgr, updatedAt: Date.now() });
  }

  async function addManager(profile) {
    const { name, role = 'supervisor', pin, operations } = profile;
    if (!name?.trim())               throw new Error('Manager name is required');
    if (!pin)                        throw new Error('PIN is required');
    if (!/^\d{4,8}$/.test(String(pin))) throw new Error('PIN must be 4–8 digits');

    const id      = _genId();
    const salt    = _genSalt();
    const pinHash = await _sha256(salt + ':' + String(pin));
    const qrToken = _genToken();
    const qrHash  = await _sha256(qrToken);

    const mgr = {
      id, name: name.trim(), role,
      pinHash, pinSalt: salt,
      qrToken, qrHash,
      nfcUidHash:     null,
      webAuthnCredId: null,
      canApprove:     operations || Object.keys(OPERATIONS),
      active:         true,
      createdAt:      Date.now(),
      updatedAt:      Date.now(),
    };
    await _saveMgr(mgr);
    return { id, qrToken, qrData: QR_PREFIX + qrToken };
  }

  async function updateManager(id, patch) {
    const mgr = await _getMgr(id);
    if (!mgr) throw new Error('Manager not found');
    if (patch.pin) {
      if (!/^\d{4,8}$/.test(String(patch.pin))) throw new Error('PIN must be 4–8 digits');
      const salt    = _genSalt();
      patch.pinHash = await _sha256(salt + ':' + String(patch.pin));
      patch.pinSalt = salt;
      delete patch.pin;
    }
    await _saveMgr({ ...mgr, ...patch });
  }

  async function removeManager(id) {
    const mgr = await _getMgr(id);
    if (!mgr) throw new Error('Manager not found');
    await _saveMgr({ ...mgr, active: false });
  }

  /* ═══════════════════════════════════════════════════════════
     BIOMETRIC (WebAuthn)
  ═══════════════════════════════════════════════════════════ */
  async function enrollBiometric(managerId) {
    if (!navigator.credentials?.create) throw new Error('WebAuthn not supported on this device');
    const mgr = await _getMgr(managerId);
    if (!mgr) throw new Error('Manager not found');

    const cred = await navigator.credentials.create({
      publicKey: {
        challenge:    crypto.getRandomValues(new Uint8Array(32)),
        rp:           { name: 'SOKONI SmartPOS', id: _rpId() },
        user:         { id: new TextEncoder().encode(managerId), name: mgr.name, displayName: mgr.name },
        pubKeyCredParams: [{ alg: -7, type: 'public-key' }, { alg: -257, type: 'public-key' }],
        authenticatorSelection: {
          authenticatorAttachment: 'platform',
          userVerification:        'required',
          residentKey:             'preferred',
        },
        timeout: 60000,
      },
    });
    await _saveMgr({ ...mgr, webAuthnCredId: _ab2b64url(cred.rawId) });
    return true;
  }

  /* ═══════════════════════════════════════════════════════════
     NFC ENROLLMENT
  ═══════════════════════════════════════════════════════════ */
  async function enrollNFC(managerId) {
    if (!('NDEFReader' in window)) throw new Error('Web NFC requires Chrome on Android');
    const mgr = await _getMgr(managerId);
    if (!mgr) throw new Error('Manager not found');

    return new Promise((res, rej) => {
      const reader = new NDEFReader();
      const ac     = new AbortController();
      const timer  = setTimeout(() => { ac.abort(); rej(new Error('NFC scan timed out')); }, 15000);

      reader.scan({ signal: ac.signal }).then(() => {
        reader.addEventListener('reading', async ({ serialNumber }) => {
          clearTimeout(timer);
          const uid  = serialNumber.replace(/:/g, '').toUpperCase();
          const hash = await _sha256(uid);
          await _saveMgr({ ...mgr, nfcUidHash: hash });
          res(true);
        }, { once: true });
      }).catch(e => { clearTimeout(timer); rej(e); });
    });
  }

  /* ═══════════════════════════════════════════════════════════
     MOBILE APPROVAL (Firestore real-time)
  ═══════════════════════════════════════════════════════════ */
  async function _createMobileReq(managerId, managerName, operation, context) {
    const db = _fdb();
    if (!db) throw new Error('Firebase unavailable — use PIN, QR, NFC or Biometric');
    const c       = _cashier();
    const reqId   = _genId();
    const expires = Date.now() + _cfg.mobilePinTimeoutSec * 1000;
    await db.collection('managerAuthRequests').doc(reqId).set({
      shopId:          _shopId(),
      cashierId:       c.id,
      cashierName:     c.name,
      managerId,
      managerName,
      operation,
      operationLabel:  OPERATIONS[operation]?.label || operation,
      context:         JSON.parse(JSON.stringify(context || {})),
      status:          'pending',
      requestedAt:     firebase.firestore.FieldValue.serverTimestamp(),
      expiresAt:       expires,
    });
    return reqId;
  }

  function _listenMobileReq(reqId, onResponse) {
    const db = _fdb();
    if (!db) return () => {};
    return db.collection('managerAuthRequests').doc(reqId)
      .onSnapshot(snap => {
        if (!snap.exists) return;
        const d = snap.data();
        if (d.status === 'approved' || d.status === 'denied') {
          onResponse({ approved: d.status === 'approved', respondedById: d.respondedById, respondedByName: d.respondedByName });
        }
      });
  }

  /* Called from manager-auth.html on the manager's device */
  async function respondMobileRequest(reqId, approved, managerPin) {
    const db = _fdb();
    if (!db) throw new Error('No network connection');
    const snap = await db.collection('managerAuthRequests').doc(reqId).get();
    if (!snap.exists) throw new Error('Request not found or expired');
    const req = snap.data();
    if (req.status !== 'pending') throw new Error('Request already handled');
    if (Date.now() > req.expiresAt) throw new Error('Request has expired');

    const mgr = await _getMgr(req.managerId);
    if (!mgr) throw new Error('Manager not found');

    if (managerPin) {
      const hash = await _sha256(mgr.pinSalt + ':' + String(managerPin));
      if (hash !== mgr.pinHash) throw new Error('Incorrect PIN');
    }

    await db.collection('managerAuthRequests').doc(reqId).update({
      status:          approved ? 'approved' : 'denied',
      respondedById:   mgr.id,
      respondedByName: mgr.name,
      respondedAt:     firebase.firestore.FieldValue.serverTimestamp(),
    });
  }

  /* ═══════════════════════════════════════════════════════════
     HTML BUILDERS
  ═══════════════════════════════════════════════════════════ */
  function _escH(s) {
    return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  function _ctxLine(operation, context) {
    const p = [];
    if (context?.amount  != null) p.push('KES ' + Number(context.amount).toLocaleString('en-KE', { minimumFractionDigits: 2 }));
    if (context?.product)         p.push(_escH(context.product));
    if (context?.discountPct)     p.push(context.discountPct + '% off');
    if (context?.reason)          p.push(_escH(context.reason));
    if (context?.items)           p.push(context.items + ' items');
    if (context?.cashier)         p.push('by ' + _escH(context.cashier));
    return p.join(' · ');
  }

  function _tabsHTML(methods, active) {
    return methods.map(m => `<button class="mauth-tab${m === active ? ' active' : ''}" data-method="${m}">
        <span class="ti">${METHODS[m].icon}</span>${METHODS[m].label}</button>`).join('');
  }

  function _pinContentHTML() {
    const dots = Array.from({ length: 6 }, (_, i) => `<div class="mauth-pin-dot" id="mauth-d${i}"></div>`).join('');
    return `<div class="mauth-pin-dots">${dots}</div>
      <div class="mauth-keypad" id="mauth-kp">
        ${[1,2,3,4,5,6,7,8,9].map(n=>`<button class="mauth-key" data-k="${n}">${n}</button>`).join('')}
        <button class="mauth-key clr" data-k="clr">CLR</button>
        <button class="mauth-key" data-k="0">0</button>
        <button class="mauth-key del" data-k="del">⌫</button>
      </div>`;
  }

  function _qrContentHTML() {
    return `<div class="mauth-cam-wrap">
        <video id="mauth-vid" playsinline autoplay muted></video>
        <div class="mauth-cam-frame"><div class="mauth-cam-target"></div></div>
      </div>
      <div class="mauth-cam-hint">Point camera at manager's QR badge</div>`;
  }

  function _nfcContentHTML() {
    return `<div class="mauth-nfc-wrap">
        <div class="mauth-nfc-ring">
          <div class="mauth-nfc-w"></div><div class="mauth-nfc-w"></div><div class="mauth-nfc-w"></div>
          <div class="mauth-nfc-core">📡</div>
        </div>
        <div style="font-size:14px;color:#f0f0f6;font-weight:700">Tap NFC manager card</div>
        <div style="font-size:12px;color:#9898aa;margin-top:5px">Hold card near the back of the device</div>
      </div>`;
  }

  function _mobileContentHTML(managers) {
    const list = managers.length
      ? managers.map(m => `<button class="mauth-mgr-btn" data-mgr="${_escH(m.id)}" data-name="${_escH(m.name)}">
            👤 ${_escH(m.name)}<span class="mauth-role">${_escH(m.role || 'supervisor')}</span>
          </button>`).join('')
      : '<div style="color:#9898aa;font-size:13px;text-align:center;padding:16px">No managers registered</div>';
    return `<div style="font-size:12px;color:#9898aa;margin-bottom:8px">Select manager to notify:</div>
      <div class="mauth-mgr-list" id="mauth-mgrlist">${list}</div>
      <div id="mauth-waitblock" style="display:none">
        <div class="mauth-wait">
          <div style="font-size:13px;color:#9898aa">Waiting for approval…</div>
          <div class="mauth-countdown" id="mauth-cd">5:00</div>
          <div style="font-size:12px;color:#9898aa">Request sent to manager's phone</div>
        </div>
      </div>`;
  }

  function _bioContentHTML(managers) {
    const eligible = managers.filter(m => m.webAuthnCredId);
    if (!eligible.length) return `<div class="mauth-bio-wrap">
        <div class="mauth-bio-ico">👁</div>
        <div style="color:#9898aa;font-size:13px;text-align:center">No managers have biometric enrolled.<br>
          Use PIN or go to <a href="manager-auth.html" style="color:#71ff00">Manager Setup</a> to enroll.</div>
      </div>`;
    return `<div class="mauth-bio-wrap">
        <div class="mauth-bio-ico">👁</div>
        <div style="font-size:13px;color:#9898aa;margin-bottom:10px;text-align:center">Select manager to verify:</div>
        <div class="mauth-mgr-list" style="width:100%">
          ${eligible.map(m=>`<button class="mauth-mgr-btn" data-mgr="${_escH(m.id)}" data-name="${_escH(m.name)}">
              👤 ${_escH(m.name)}<span class="mauth-role">${_escH(m.role||'supervisor')}</span>
            </button>`).join('')}
        </div>
      </div>`;
  }

  /* ═══════════════════════════════════════════════════════════
     MODAL LIFECYCLE
  ═══════════════════════════════════════════════════════════ */
  async function _renderModal(operation, context, managers) {
    _injectCSS();
    const op      = OPERATIONS[operation] || { label: operation, icon: '🔐' };
    const methods = (_cfg.enabledMethods || Object.keys(METHODS)).filter(m => m in METHODS);
    const defM    = methods[0] || 'pin';
    const ctxLine = _ctxLine(operation, context);

    const ov = document.createElement('div');
    ov.className = 'mauth-overlay';
    ov.id        = 'mauth-overlay';
    ov.setAttribute('role', 'dialog');
    ov.setAttribute('aria-modal', 'true');
    ov.setAttribute('aria-label', 'Manager Authorization');

    ov.innerHTML = `<div class="mauth-card">
        <div class="mauth-drag"></div>
        <div class="mauth-op-hdr">
          <div class="mauth-op-ico">${_escH(op.icon)}</div>
          <div class="mauth-op-lbl">Manager Authorization Required</div>
          <div class="mauth-op-ctx"><strong>${_escH(op.label)}</strong>${ctxLine ? '<br>' + ctxLine : ''}</div>
        </div>
        <div class="mauth-tabs" id="mauth-tabs">${_tabsHTML(methods, defM)}</div>
        <div class="mauth-content" id="mauth-content"></div>
        <div class="mauth-status" id="mauth-status"></div>
        <button class="mauth-cancel" id="mauth-cancel">Cancel</button>
      </div>`;

    document.body.appendChild(ov);
    _overlay = ov;

    ov.querySelector('#mauth-tabs').addEventListener('click', e => {
      const btn = e.target.closest('[data-method]');
      if (btn) _switchMethod(btn.dataset.method, managers);
    });
    ov.querySelector('#mauth-cancel').addEventListener('click', () => _closeModal(null));

    await _switchMethod(defM, managers);
  }

  async function _switchMethod(method, managers) {
    _stopActive();
    _clearStatus();
    _activeMethod = method;
    _pinDigits    = '';
    _pinAttempts  = 0;

    _overlay.querySelectorAll('.mauth-tab').forEach(t => t.classList.toggle('active', t.dataset.method === method));
    const content = _overlay.querySelector('#mauth-content');

    switch (method) {
      case 'pin':       content.innerHTML = _pinContentHTML();          _wirePIN();                 break;
      case 'qr':        content.innerHTML = _qrContentHTML();           _startQR();                 break;
      case 'nfc':       content.innerHTML = _nfcContentHTML();          _startNFC();                break;
      case 'mobile':    content.innerHTML = _mobileContentHTML(managers||[]); _wireMobile(managers||[]); break;
      case 'biometric': content.innerHTML = _bioContentHTML(managers||[]);    _wireBio(managers||[]);    break;
    }
  }

  function _closeModal(result) {
    _stopActive();
    if (_overlay) { _overlay.remove(); _overlay = null; }
    if (_resolve) { _resolve(result); _resolve = null; }
  }

  function _setStatus(msg, type = 'inf') {
    const el = _overlay?.querySelector('#mauth-status');
    if (!el) return;
    el.className = `mauth-status ${type} vis`;
    el.textContent = msg;
  }

  function _clearStatus() {
    const el = _overlay?.querySelector('#mauth-status');
    if (el) { el.className = 'mauth-status'; el.textContent = ''; }
  }

  function _stopActive() {
    /* Stop camera */
    if (_cameraInterval) { clearInterval(_cameraInterval); _cameraInterval = null; }
    if (_cameraStream)   { _cameraStream.getTracks().forEach(t => t.stop()); _cameraStream = null; }
    /* Stop NFC */
    if (_nfcAbort) { _nfcAbort.abort(); _nfcAbort = null; }
    /* Stop mobile timers */
    if (_mobileTimer)  { clearInterval(_mobileTimer); _mobileTimer = null; }
    if (_mobileUnsub)  { _mobileUnsub(); _mobileUnsub = null; }
  }

  /* ═══════════════════════════════════════════════════════════
     METHOD: PIN
  ═══════════════════════════════════════════════════════════ */
  function _wirePIN() {
    const kp = _overlay.querySelector('#mauth-kp');
    kp.addEventListener('click', e => {
      const btn = e.target.closest('[data-k]');
      if (!btn) return;
      const k = btn.dataset.k;
      if (k === 'del')       { _pinDigits = _pinDigits.slice(0, -1); _updateDots(); }
      else if (k === 'clr')  { _pinDigits = ''; _updateDots(); }
      else if (_pinDigits.length < 6) {
        _pinDigits += k;
        _updateDots();
        if (_pinDigits.length >= 4) _checkPIN();
      }
    });
    /* Prevent scroll-bounce on iOS */
    kp.addEventListener('touchstart', e => e.preventDefault(), { passive: false });
  }

  function _updateDots() {
    for (let i = 0; i < 6; i++) {
      const d = _overlay.querySelector(`#mauth-d${i}`);
      if (d) { d.classList.toggle('f', i < _pinDigits.length); d.classList.remove('x'); }
    }
  }

  async function _checkPIN() {
    const pin = _pinDigits;
    const op  = _currentOp || '';
    const highRisk = HIGH_RISK_OPS.indexOf(op) !== -1;

    /* ── 1. Server first — authoritative, rate-limited, audited ── */
    let server = null;
    if (_online()) {
      _setStatus('Verifying…');
      server = await _verifyPinServer(pin);
    }

    if (server && server.rateLimited) {
      _pinDigits = ''; _flashDots();
      _setStatus('Too many PIN attempts. Wait 5 minutes and try again.', 'err');
      return;
    }
    if (server && server.valid) {
      _pinDigits = '';
      const e = server.employee || {};
      _closeModal({
        approved: true,
        manager: { id: e.id, name: e.name || 'Manager', role: e.role || 'manager', permissions: e.permissions || [] },
        method: 'pin',
        verifiedBy: 'server',
      });
      return;
    }
    if (server && !server.valid) {                 // server reachable and said NO — authoritative
      _rejectPIN();
      return;
    }

    /* ── 2. Server unreachable ──
       High-risk operations must not proceed on an unverifiable approval: a forged local hash
       here would move money or stock. Everything else may fall back to the local hash so the
       shop keeps trading through a connectivity drop. */
    if (highRisk) {
      _pinDigits = ''; _flashDots();
      _setStatus('No connection. This action needs online manager approval.', 'err');
      return;
    }

    const managers = await listManagers();
    for (const mgr of managers) {
      const hash = await _sha256(mgr.pinSalt + ':' + pin);
      if (hash === mgr.pinHash) {
        _pinDigits = '';
        /* Queue a server-side audit record so the offline approval is reconciled on reconnect —
           an offline approval must still be accountable. */
        _queueOfflineAuthAudit(op, mgr);
        _closeModal({ approved: true, manager: mgr, method: 'pin', verifiedBy: 'offline-fallback' });
        return;
      }
    }
    _rejectPIN();
  }

  function _rejectPIN() {
    _pinAttempts++;
    _pinDigits = '';
    _flashDots();
    if (_pinAttempts >= _cfg.maxPinAttempts) {
      _setStatus('Too many incorrect attempts. Use another method.', 'err');
      _overlay.querySelector('#mauth-kp').querySelectorAll('.mauth-key').forEach(k => { k.disabled = true; });
    } else {
      _setStatus(`Incorrect PIN — ${_cfg.maxPinAttempts - _pinAttempts} attempt(s) left`, 'err');
    }
  }

  /** Record an offline approval locally; flushed to the server audit trail on reconnect. */
  function _queueOfflineAuthAudit(operation, mgr) {
    try {
      const q = JSON.parse(localStorage.getItem('sokoni_offline_auth_audit') || '[]');
      q.push({
        operation,
        managerId:  mgr && mgr.id,
        managerName: mgr && mgr.name,
        merchantId: _merchantId(),
        branchId:   _branchId(),
        verifiedBy: 'offline-fallback',
        at:         Date.now(),
      });
      localStorage.setItem('sokoni_offline_auth_audit', JSON.stringify(q.slice(-200)));
    } catch (_) { /* audit queue must never block the sale */ }
  }

  function _flashDots() {
    _overlay.querySelectorAll('.mauth-pin-dot').forEach(d => d.classList.add('x'));
    setTimeout(() => _overlay.querySelectorAll('.mauth-pin-dot').forEach(d => d.classList.remove('x', 'f')), 500);
  }

  /* ═══════════════════════════════════════════════════════════
     METHOD: QR BADGE
  ═══════════════════════════════════════════════════════════ */
  function _startQR() {
    const video = _overlay.querySelector('#mauth-vid');
    if (!video) return;

    if (!('BarcodeDetector' in window)) {
      _setStatus('QR scanning requires Chrome on Android or desktop Chrome 88+.', 'err');
      return;
    }

    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
      .then(stream => {
        _cameraStream = stream;
        video.srcObject = stream;
        const det = new BarcodeDetector({ formats: ['qr_code'] });
        _cameraInterval = setInterval(async () => {
          if (video.readyState < 2 || !_overlay) return;
          try {
            const codes = await det.detect(video);
            for (const c of codes) {
              if (c.rawValue.startsWith(QR_PREFIX)) {
                clearInterval(_cameraInterval); _cameraInterval = null;
                _stopActive();
                await _verifyQR(c.rawValue.slice(QR_PREFIX.length));
                return;
              }
            }
          } catch (_) {}
        }, 350);
      })
      .catch(e => _setStatus('Camera access denied: ' + e.message, 'err'));
  }

  async function _verifyQR(rawToken) {
    const hash     = await _sha256(rawToken);
    const managers = await listManagers();
    const mgr      = managers.find(m => m.qrHash === hash);
    if (mgr) { _closeModal({ approved: true, manager: mgr, method: 'qr' }); }
    else      { _setStatus('QR badge not recognised.', 'err'); _startQR(); }
  }

  /* ═══════════════════════════════════════════════════════════
     METHOD: NFC CARD
  ═══════════════════════════════════════════════════════════ */
  function _startNFC() {
    if (!('NDEFReader' in window)) {
      _setStatus('NFC card requires Chrome on Android.', 'err');
      return;
    }
    const reader = new NDEFReader();
    _nfcAbort    = new AbortController();

    reader.scan({ signal: _nfcAbort.signal }).then(() => {
      reader.addEventListener('reading', async ({ serialNumber }) => {
        const uid  = serialNumber.replace(/:/g, '').toUpperCase();
        const hash = await _sha256(uid);
        const mgrs = await listManagers();
        const mgr  = mgrs.find(m => m.nfcUidHash === hash);
        _nfcAbort.abort(); _nfcAbort = null;
        if (mgr) { _closeModal({ approved: true, manager: mgr, method: 'nfc' }); }
        else      { _setStatus('NFC card not recognised.', 'err'); _startNFC(); }
      });
    }).catch(e => _setStatus('NFC error: ' + (e.message || e), 'err'));
  }

  /* ═══════════════════════════════════════════════════════════
     METHOD: MOBILE APP
  ═══════════════════════════════════════════════════════════ */
  function _wireMobile(managers) {
    const list = _overlay.querySelector('#mauth-mgrlist');
    if (!list) return;
    list.addEventListener('click', async e => {
      const btn = e.target.closest('[data-mgr]');
      if (!btn) return;
      list.querySelectorAll('.mauth-mgr-btn').forEach(b => b.classList.remove('sel'));
      btn.classList.add('sel');
      await _sendMobile(btn.dataset.mgr, btn.dataset.name, managers);
    });
  }

  async function _sendMobile(managerId, managerName, managers) {
    try {
      _setStatus('Sending request…', 'inf');
      const reqId = await _createMobileReq(managerId, managerName, _currentOp, _currentCtx);

      _overlay.querySelector('#mauth-mgrlist').style.display   = 'none';
      _overlay.querySelector('#mauth-waitblock').style.display = '';

      let remaining = _cfg.mobilePinTimeoutSec;
      const tick = () => {
        const m = Math.floor(remaining / 60);
        const s = remaining % 60;
        const el = _overlay?.querySelector('#mauth-cd');
        if (el) el.textContent = `${m}:${String(s).padStart(2, '0')}`;
        remaining--;
        if (remaining < 0) {
          clearInterval(_mobileTimer); _mobileTimer = null;
          if (_mobileUnsub) { _mobileUnsub(); _mobileUnsub = null; }
          _setStatus('Approval request timed out.', 'err');
        }
      };
      tick();
      _mobileTimer = setInterval(tick, 1000);

      _mobileUnsub = _listenMobileReq(reqId, result => {
        clearInterval(_mobileTimer); _mobileTimer = null;
        if (_mobileUnsub) { _mobileUnsub(); _mobileUnsub = null; }
        const mgr = managers.find(m => m.id === managerId) || { id: managerId, name: managerName };
        _closeModal({ approved: result.approved, manager: mgr, method: 'mobile' });
      });

      _setStatus('Request sent — waiting for manager approval', 'inf');
    } catch (e) {
      _setStatus(e.message || 'Mobile approval unavailable', 'err');
    }
  }

  /* ═══════════════════════════════════════════════════════════
     METHOD: BIOMETRIC
  ═══════════════════════════════════════════════════════════ */
  function _wireBio(managers) {
    const wrap = _overlay.querySelector('.mauth-bio-wrap');
    if (!wrap) return;
    wrap.addEventListener('click', async e => {
      const btn = e.target.closest('[data-mgr]');
      if (!btn) return;
      wrap.querySelectorAll('.mauth-mgr-btn').forEach(b => b.classList.remove('sel'));
      btn.classList.add('sel');
      const mgr = managers.find(m => m.id === btn.dataset.mgr);
      if (!mgr?.webAuthnCredId) { _setStatus('No biometric enrolled for this manager.', 'err'); return; }
      await _verifyBio(mgr);
    });
  }

  async function _verifyBio(mgr) {
    if (!navigator.credentials?.get) { _setStatus('WebAuthn not supported.', 'err'); return; }
    _setStatus('Verifying biometric…', 'inf');
    try {
      const assertion = await navigator.credentials.get({
        publicKey: {
          challenge:        crypto.getRandomValues(new Uint8Array(32)),
          rpId:             _rpId(),
          allowCredentials: [{ id: _b64url2ab(mgr.webAuthnCredId), type: 'public-key' }],
          userVerification: 'required',
          timeout:          60000,
        },
      });
      if (assertion) _closeModal({ approved: true, manager: mgr, method: 'biometric' });
    } catch (e) {
      _setStatus(e.name === 'NotAllowedError' ? 'Biometric cancelled.' : 'Biometric error: ' + e.message, 'err');
    }
  }

  /* ═══════════════════════════════════════════════════════════
     MAIN REQUEST API
  ═══════════════════════════════════════════════════════════ */
  /**
   * Server-verified owner/manager PIN. The ONLY approval path that survives when no
   * manager is enrolled locally.
   *
   * Deliberately does not fall back to the local roster: the whole point is that the
   * local roster is empty or untrustworthy. _verifyPinServer() calls
   * validateDeviceAccess, which matches against posStaff (branchId, pinHash,
   * status='active') and is rate-limited server-side, so neither the PIN nor the
   * attempt count can be forged from the device.
   *
   * Returns false — never true — on any outcome that is not an explicit server YES.
   */
  /**
   * First-run PIN provisioning.
   *
   * createBusiness writes the owner's posStaff record with no pinHash, and no UI ever
   * called setStaffPin — so on a fresh merchant there is no PIN in existence and
   * validateDeviceAccess (which matches on pinHash) can never succeed. Requiring a PIN
   * without offering a way to create one would lock every existing merchant out of
   * refunds, which is worse than the hole it closes.
   *
   * Authorisation is decided by the server: setStaffPin runs _assertMerchantAccess and
   * then permits only an owner/manager (or a staff member changing their own PIN). It
   * also enforces the PIN policy — 4-6 digits, no repeated digit, no sequential run.
   * Nothing here is trusted; this only collects the value and asks.
   */
  async function _provisionManagerPin() {
    const merchantId = _merchantId();
    const branchId   = _branchId();
    let uid = null;
    try { uid = window.firebase?.auth?.().currentUser?.uid || null; } catch (_) {}

    if (!merchantId || !branchId || !uid) {
      alert('Cannot set a PIN on this device yet.\n\nComplete POS setup first, then try again.');
      return false;
    }

    const pin = window.prompt(
      'SET A MANAGER PIN\n\n' +
      'No manager PIN exists for this branch yet.\n' +
      'Choose a 4-6 digit PIN. It will be required to approve\n' +
      'refunds, voids and price overrides.\n\n' +
      'Cannot be repeated digits (1111) or a run (1234).'
    );
    if (pin === null || !String(pin).trim()) return false;

    try {
      const call = firebase.functions().httpsCallable('smartPosDispatch');
      await call({ op: 'setStaffPin', merchantId, staffId: branchId + '-' + uid, pin: String(pin).trim() });
      alert('Manager PIN saved.\n\nEnter it now to approve this operation.');
      return true;
    } catch (e) {
      /* The server refused — wrong role, weak PIN, or unreachable. Show its reason
         rather than a generic failure; the messages are already merchant-readable. */
      alert('Could not save the PIN.\n\n' + (e?.message || 'Unknown error') +
            '\n\nOnly the business owner or a manager can set a PIN.');
      return false;
    }
  }

  async function _serverVerifiedPin(operation) {
    const opLabel = OPERATIONS[operation]?.label || operation;
    const maxTries = Math.max(1, _cfg.maxPinAttempts || 3);

    for (let attempt = 1; attempt <= maxTries; attempt++) {
      const pin = window.prompt(
        'MANAGER AUTHORIZATION REQUIRED\n\n' + opLabel + '\n\n' +
        'No manager is enrolled on this device.\n' +
        'Enter the OWNER or MANAGER PIN to approve.\n\n' +
        'Attempt ' + attempt + ' of ' + maxTries
      );
      if (pin === null) return false;                    /* cancelled is a denial */
      if (!String(pin).trim()) continue;

      const res = await _verifyPinServer(String(pin).trim());

      if (res === null) {
        /* Unreachable. A money-moving operation must not be approved on a promise we
           cannot check — say so plainly instead of failing open. */
        alert('Cannot reach SOKONI to verify this authorization.\n\n' +
              'Connect to the internet and try again.\n\n' +
              'This operation cannot be approved offline.');
        return false;
      }
      if (res.rateLimited) {
        alert('Too many PIN attempts.\n\nWait a few minutes before trying again.');
        return false;
      }
      if (res.valid) {
        _writeAudit({
          operation, operationLabel: opLabel, method: 'pin_server',
          status: 'approved', managerId: res.employee?.uid || 'server-verified',
          managerName: res.employee?.name || 'Owner/Manager (server)',
          fallbackPath: 'no-local-manager',
        });
        return true;
      }
      /* Wrong PIN — loop and let the operator retry within the bounded count. */
    }

    /* Exhausted the attempts. Before denying outright, offer to create a PIN — on a
       fresh merchant there is nothing to match against, and "wrong PIN" is
       indistinguishable from "no PIN exists" from the client's side. The server still
       decides whether this caller is allowed to set one. */
    const setup = confirm(
      'Authorization denied.\n\n' +
      'The PIN did not match an active manager for this branch.\n\n' +
      'If no manager PIN has been set up yet, tap OK to create one now.\n' +
      '(Only the business owner or a manager can do this.)'
    );
    if (setup && await _provisionManagerPin()) {
      /* PIN now exists — give one immediate attempt so the merchant can complete the
         operation they were in the middle of, rather than starting over. */
      const pin = window.prompt('Enter the manager PIN to approve:\n\n' + opLabel);
      if (pin && String(pin).trim()) {
        const res = await _verifyPinServer(String(pin).trim());
        if (res && res.valid) {
          _writeAudit({
            operation, operationLabel: opLabel, method: 'pin_server',
            status: 'approved', managerId: res.employee?.uid || 'server-verified',
            managerName: res.employee?.name || 'Owner/Manager (server)',
            fallbackPath: 'first-run-provision',
          });
          return true;
        }
      }
    }
    return false;
  }

  async function request(operation, context = {}) {
    /* ── Containment: a money-moving gate can never be disabled by the device ──────
       _cfg is loaded from IndexedDB, which the person holding the till controls, so
       honouring _cfg.enabled / _cfg.enabledOps for high-risk operations meant any
       operator could switch off their own refund and void controls by editing local
       storage. Those two checks now apply only to low-risk operations.

       HIGH_RISK_OPS is the existing list of operations where a forged approval moves
       money or stock — it was already trusted for the offline decision, and it is the
       right boundary here too. */
    const highRisk = HIGH_RISK_OPS.includes(operation);

    if (!highRisk) {
      if (!_cfg.enabled)                         return true;
      if (!_cfg.enabledOps?.includes(operation)) return true;
    }

    const managers = await listManagers();

    if (!managers.length) {
      /* This branch used to return true unconditionally — it literally offered
         "Cancel to allow this operation without authorization". Clearing site data
         emptied the roster and every refund then approved itself, with the only
         record written to device-local IndexedDB the same operator could erase.

         Low-risk operations keep the old prompt so a shop that has not finished
         setup is not blocked from opening a drawer. High-risk operations now fall
         through to a server-verified PIN, which keeps merchants trading without
         letting the device authorise itself. */
      if (!highRisk) {
        const go = confirm(
          'Manager Authorization is not set up.\n\n' +
          'Tap OK to open Manager Setup now, or Cancel to continue without authorization.\n\n' +
          '(Set up a manager to require authorization for: refunds, discounts, voids, and more.)'
        );
        if (go) window.open('manager-auth.html', '_blank');
        return true;
      }
      return _serverVerifiedPin(operation);
    }

    const startTime = Date.now();
    const cashier   = _cashier();

    const result = await new Promise((res) => {
      _resolve    = res;
      _currentOp  = operation;
      _currentCtx = context;
      _renderModal(operation, context, managers);
    });

    const approved = !!(result?.approved);
    const status   = result === null ? 'cancelled' : (approved ? 'approved' : 'denied');

    await _writeAudit({
      operation,
      operationLabel: OPERATIONS[operation]?.label || operation,
      context:        JSON.parse(JSON.stringify(context)),
      method:         result?.method || 'unknown',
      status,
      managerId:      result?.manager?.id   || null,
      managerName:    result?.manager?.name || null,
      managerRole:    result?.manager?.role || null,
      cashierId:      cashier.id,
      cashierName:    cashier.name,
      requestedAt:    startTime,
      respondedAt:    Date.now(),
      durationMs:     Date.now() - startTime,
    });

    return approved;
  }

  async function guard(operation, context, fn) {
    const ok = await request(operation, context);
    if (ok) return fn();
    return null;
  }

  /* ═══════════════════════════════════════════════════════════
     PRICE OVERRIDE  (separate flow: auth first, then input)
  ═══════════════════════════════════════════════════════════ */
  async function requestPriceOverride(productId, productName, currentPrice) {
    const ok = await request('price_override', { product: productName, amount: currentPrice });
    if (!ok) return null;

    return new Promise(res => {
      _injectCSS();
      const ov = document.createElement('div');
      ov.className = 'mauth-overlay';
      ov.innerHTML = `<div class="mauth-card">
          <div class="mauth-drag"></div>
          <div class="mauth-op-hdr">
            <div class="mauth-op-ico">✏</div>
            <div class="mauth-op-lbl">Override Price</div>
            <div class="mauth-op-ctx">${_escH(productName)}<br>Current: KES ${Number(currentPrice).toFixed(2)}</div>
          </div>
          <div style="padding:6px 0 4px">
            <label style="font-size:12px;color:#9898aa;display:block;margin-bottom:6px">New Price (KES)</label>
            <input id="mauth-po-input" type="number" min="0" step="0.01" value="${Number(currentPrice).toFixed(2)}"
              style="width:100%;background:#1e1e28;border:1px solid rgba(255,255,255,.12);border-radius:10px;padding:12px 14px;color:#f0f0f6;font-size:22px;font-weight:700;box-sizing:border-box">
          </div>
          <div style="display:flex;gap:8px;margin-top:12px">
            <button id="mauth-poc" style="flex:1;padding:12px;background:rgba(239,68,68,.07);border:1px solid rgba(239,68,68,.18);border-radius:10px;color:#ef4444;font-size:14px;font-weight:700;cursor:pointer">Cancel</button>
            <button id="mauth-poa" style="flex:2;padding:12px;background:#71ff00;border:none;border-radius:10px;color:#111;font-size:14px;font-weight:800;cursor:pointer">Apply Override</button>
          </div>
        </div>`;
      document.body.appendChild(ov);
      const inp = ov.querySelector('#mauth-po-input');
      setTimeout(() => { inp.focus(); inp.select(); }, 50);
      ov.querySelector('#mauth-poc').onclick = () => { ov.remove(); res(null); };
      ov.querySelector('#mauth-poa').onclick = () => {
        const v = parseFloat(inp.value);
        ov.remove();
        res(isNaN(v) || v < 0 ? null : v);
      };
    });
  }

  /* ═══════════════════════════════════════════════════════════
     CONFIGURATION API
  ═══════════════════════════════════════════════════════════ */
  async function configure(opts = {}) {
    Object.assign(_cfg, opts);
    await _saveConfig();
  }

  function getConfig() {
    return { ..._cfg };
  }

  /* ═══════════════════════════════════════════════════════════
     GENERATE QR DATA URI  (for manager badge printing)
  ═══════════════════════════════════════════════════════════ */
  async function getManagerQRData(managerId) {
    const mgr = await _getMgr(managerId);
    if (!mgr) throw new Error('Manager not found');
    return { qrData: QR_PREFIX + mgr.qrToken, name: mgr.name, role: mgr.role };
  }

  /* ═══════════════════════════════════════════════════════════
     INIT
  ═══════════════════════════════════════════════════════════ */
  async function init() {
    await _loadConfig();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  /* ═══════════════════════════════════════════════════════════
     PUBLIC API
  ═══════════════════════════════════════════════════════════ */
  return {
    /* Core authorization */
    request,
    guard,
    requestPriceOverride,
    /* Manager management */
    addManager,
    updateManager,
    removeManager,
    listManagers,
    /* Enrollment */
    enrollBiometric,
    enrollNFC,
    getManagerQRData,
    /* Mobile approval (called from manager-auth.html) */
    respondMobileRequest,
    /* Audit */
    getAuditLog,
    /* Config */
    configure,
    getConfig,
    init,
  };

})();
