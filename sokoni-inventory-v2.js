/* ═══════════════════════════════════════════════════════════════════════
   SOKONI INVENTORY V2 — World-Class Inventory & Supply Chain Extension
   Extends sokoni-inventory.js with enterprise capabilities:
   Health Scores · Digital Twin · Fraud Detection · Business Simulation
   Recall Management · AI Pricing · Voice Commands · Workflow Automation
   Import Engine · Sustainability · Developer Webhooks · Universal Commerce Graph
   ═══════════════════════════════════════════════════════════════════════ */

const SokoniInventoryV2 = (() => {
  'use strict';

  /* ── Constants ─────────────────────────────────────────────────── */
  const CF_PROJECT  = 'sokoni-aeb26';
  const CF_REGION   = 'us-central1';
  const CF_BASE     = `https://${CF_REGION}-${CF_PROJECT}.cloudfunctions.net`;
  const L1          = new Map();
  const EVT         = new EventTarget();

  /* ── V2 IndexedDB — offline-first stores for Variants, Batches, Serials, etc. ── */
  let _db2          = null;
  let _online       = navigator.onLine;
  let _expiryTimer  = null; /* managed — see initV2() */
  window.addEventListener('online',  () => { _online = true;  setTimeout(_flushQ2, 1000); });
  window.addEventListener('offline', () => { _online = false; });

  function _openDB2() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('sokoni_inv_v2', 1);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        const STORES = {
          variants:      [['productId', false], ['sku', false]],
          batches:       [['productId', false], ['batchNumber', false], ['expiryDate', false], ['warehouseId', false]],
          serials:       [['productId', false], ['serialNumber', true], ['status', false], ['warehouseId', false]],
          serialHistory: [['serialId', false]],
          bom:           [['productId', true]],
          workOrders:    [['status', false], ['productId', false]],
          transfers:     [['status', false], ['fromWarehouse', false], ['toWarehouse', false]],
          forecastData:  [['productId', false]],
          reorderRules:  [['productId', true]],
          notifications: [['status', false], ['createdAt', false]],
          syncQueue2:    [],
        };
        for (const [name, indexes] of Object.entries(STORES)) {
          if (db.objectStoreNames.contains(name)) continue;
          const store = db.createObjectStore(name, { keyPath: 'id' });
          for (const [field, unique] of indexes) store.createIndex(field, field, { unique });
        }
      };
      req.onsuccess = e => resolve(e.target.result);
      req.onerror   = e => reject(e.target.error);
    });
  }

  function _iGet(store, key) {
    return new Promise((res, rej) => {
      const r = _db2.transaction(store, 'readonly').objectStore(store).get(key);
      r.onsuccess = () => res(r.result || null);
      r.onerror   = () => rej(r.error);
    });
  }
  function _iPut(store, val) {
    return new Promise((res, rej) => {
      const r = _db2.transaction(store, 'readwrite').objectStore(store).put(val);
      r.onsuccess = () => res(r.result);
      r.onerror   = () => rej(r.error);
    });
  }
  function _iDel(store, key) {
    return new Promise((res, rej) => {
      const r = _db2.transaction(store, 'readwrite').objectStore(store).delete(key);
      r.onsuccess = () => res();
      r.onerror   = () => rej(r.error);
    });
  }
  function _iAll(store, idx, range) {
    return new Promise((res, rej) => {
      const os  = _db2.transaction(store, 'readonly').objectStore(store);
      const src = idx ? os.index(idx) : os;
      const r   = src.getAll(range || null);
      r.onsuccess = () => res(r.result || []);
      r.onerror   = () => rej(r.error);
    });
  }

  const _uid6      = () => Math.random().toString(36).slice(2, 8);
  const _nowISO    = () => new Date().toISOString();
  const _curUid    = () => window._firebaseAuth?.currentUser?.uid
                        || window.firebase?.auth?.()?.currentUser?.uid
                        || 'anon';
  /* Small secondary cache for IDB results */
  const _iC = new Map();
  const _cG = k => { const e = _iC.get(k); return (!e || Date.now() > e.exp) ? (_iC.delete(k), null) : e.v; };
  const _cS = (k, v, t = 3e4) => _iC.set(k, { v, exp: Date.now() + t });
  const _cD = p => { for (const k of _iC.keys()) if (k.startsWith(p)) _iC.delete(k); };

  async function _flushQ2() {
    if (!_db2) return;
    const items = await _iAll('syncQueue2');
    for (const item of items) {
      try { await _cf(item.fn, item.data); await _iDel('syncQueue2', item.id); } catch (_) { break; }
    }
  }
  async function _enqueueQ2(fn, data) {
    await _iPut('syncQueue2', { id: `sq_${_uid6()}`, fn, data, queuedAt: _nowISO() });
  }

  /* ── Call Cloud Function (callable or HTTP fallback) ─────────────── */
  async function _cf(name, data = {}) {
    try {
      if (typeof firebase !== 'undefined' && firebase.functions) {
        const fn = firebase.functions().httpsCallable(name);
        const r  = await fn(data);
        return r.data;
      }
    } catch (_) { /* fall through */ }
    const user  = firebase?.auth?.()?.currentUser;
    const token = user ? await user.getIdToken() : null;
    const res   = await fetch(`${CF_BASE}/${name}`, {
      method : 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body   : JSON.stringify({ data }),
    });
    if (!res.ok) throw new Error(`CF ${name} failed: ${res.status}`);
    const j = await res.json();
    return j.result ?? j;
  }

  /* ── L1 cache (in-memory, TTL) ───────────────────────────────────── */
  function _cacheGet(k) {
    const e = L1.get(k);
    if (!e || Date.now() > e.exp) { L1.delete(k); return null; }
    return e.v;
  }
  function _cacheSet(k, v, ttlMs = 300_000) {
    L1.set(k, { v, exp: Date.now() + ttlMs });
  }

  /* ── Tenant context ──────────────────────────────────────────────── */
  let _activeCompany = null;
  function _tenantId() {
    if (_activeCompany) return _activeCompany;
    const user = firebase?.auth?.()?.currentUser;
    return user?.uid ?? null;
  }

  /* ══════════════════════════════════════════════════════════════════
     1. INVENTORY HEALTH SCORE ENGINE
  ══════════════════════════════════════════════════════════════════ */

  async function getHealthScore(opts = {}) {
    const k = `health:${_tenantId()}`;
    const cached = _cacheGet(k);
    if (cached && !opts.refresh) return cached;
    const result = await _cf('inventoryCalculateHealth', { tenantId: _tenantId() });
    _cacheSet(k, result, 300_000);
    EVT.dispatchEvent(new CustomEvent('healthUpdated', { detail: result }));
    return result;
  }

  async function getHealthHistory(days = 30) {
    return _cf('inventoryGetHealthHistory', { tenantId: _tenantId(), days });
  }

  /* Health score computed locally for instant display while CF responds */
  function computeHealthScoreLocal(products = [], levels = [], movements = []) {
    if (!products.length) return { score: 0, grade: 'F', breakdown: {} };
    const total   = products.length;
    const active  = products.filter(p => p.active !== false).length;
    const oos     = levels.filter(l => (l.available || 0) <= 0).length;
    const low     = levels.filter(l => {
      const p = products.find(x => x.id === l.productId);
      return p && l.available > 0 && l.available <= (p.reorderPoint || 5);
    }).length;
    const recentDays = 30;
    const cutoff  = Date.now() - recentDays * 86_400_000;
    const recent  = movements.filter(m => (m.ts?.toMillis?.() || m.ts) > cutoff);
    const sales   = recent.filter(m => m.type === 'sale').length;
    const dmg     = recent.filter(m => m.type === 'damage' || m.type === 'write_off').length;
    const adj     = recent.filter(m => m.type === 'adjustment').length;

    const turnover    = Math.min(100, (sales / Math.max(total, 1)) * 10);
    const outstock    = Math.max(0, 100 - (oos / Math.max(total, 1)) * 200);
    const lowstock    = Math.max(0, 100 - (low / Math.max(total, 1)) * 150);
    const shrinkage   = Math.max(0, 100 - (dmg / Math.max(sales + 1, 1)) * 500);
    const dataQuality = Math.max(0, 100 - (adj / Math.max(recent.length + 1, 1)) * 200);

    const weights = { turnover: 0.25, outstock: 0.25, lowstock: 0.2, shrinkage: 0.2, dataQuality: 0.1 };
    const score = Math.round(
      turnover * weights.turnover +
      outstock * weights.outstock +
      lowstock * weights.lowstock +
      shrinkage * weights.shrinkage +
      dataQuality * weights.dataQuality
    );

    const grade = score >= 90 ? 'A+' : score >= 80 ? 'A' : score >= 70 ? 'B' : score >= 60 ? 'C' : score >= 50 ? 'D' : 'F';
    return { score, grade, breakdown: { turnover, outstock, lowstock, shrinkage, dataQuality }, computedAt: Date.now() };
  }

  /* ══════════════════════════════════════════════════════════════════
     2. DIGITAL TWIN WAREHOUSE MAP
  ══════════════════════════════════════════════════════════════════ */

  async function getWarehouseLayout(warehouseId) {
    const k = `twin:${warehouseId}`;
    const c = _cacheGet(k);
    if (c) return c;
    try {
      const db   = firebase.firestore();
      const doc  = await db.doc(`tenants/${_tenantId()}/inventory_digital_twin/${warehouseId}`).get();
      const data = doc.exists ? doc.data() : _defaultLayout(warehouseId);
      _cacheSet(k, data, 60_000);
      return data;
    } catch (_) { return _defaultLayout(warehouseId); }
  }

  async function saveWarehouseLayout(warehouseId, layout) {
    const db  = firebase.firestore();
    await db.doc(`tenants/${_tenantId()}/inventory_digital_twin/${warehouseId}`).set({ ...layout, updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true });
    L1.delete(`twin:${warehouseId}`);
  }

  function _defaultLayout(warehouseId) {
    return {
      warehouseId,
      width: 20, height: 12,
      zones: [
        { id: 'A', label: 'Zone A — Receiving', x: 0, y: 0, w: 5, h: 12, color: '#1a3a1a' },
        { id: 'B', label: 'Zone B — Storage',   x: 5, y: 0, w: 10, h: 12, color: '#0d1f2d' },
        { id: 'C', label: 'Zone C — Dispatch',  x: 15, y: 0, w: 5, h: 12, color: '#2d1a0d' },
      ],
      racks: [],
    };
  }

  function renderWarehouseMap(containerId, layout, levels = [], opts = {}) {
    const el = document.getElementById(containerId);
    if (!el) return;
    const CW = el.clientWidth || 800;
    const CH = opts.height || 400;
    const CELL = Math.floor(CW / layout.width);

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', CH);
    svg.setAttribute('viewBox', `0 0 ${CW} ${CH}`);
    svg.style.cssText = 'border-radius:12px;background:#050a10;display:block;';

    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    const grd  = document.createElementNS('http://www.w3.org/2000/svg', 'radialGradient');
    grd.setAttribute('id', 'glow');
    ['0%', '100%'].forEach((off, i) => {
      const s = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
      s.setAttribute('offset', off);
      s.setAttribute('stop-color', i === 0 ? 'rgba(113,255,0,0.15)' : 'transparent');
      grd.appendChild(s);
    });
    defs.appendChild(grd);
    svg.appendChild(defs);

    const colH = Math.floor(CH / layout.height);

    /* Draw zones */
    (layout.zones || []).forEach(z => {
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('x', z.x * CELL);
      rect.setAttribute('y', z.y * colH);
      rect.setAttribute('width', z.w * CELL);
      rect.setAttribute('height', z.h * colH);
      rect.setAttribute('fill', z.color || '#111');
      rect.setAttribute('stroke', 'rgba(255,255,255,0.05)');
      rect.setAttribute('stroke-width', '1');
      svg.appendChild(rect);
      const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      label.setAttribute('x', (z.x + z.w / 2) * CELL);
      label.setAttribute('y', (z.y + 0.4) * colH);
      label.setAttribute('text-anchor', 'middle');
      label.setAttribute('fill', 'rgba(255,255,255,0.3)');
      label.setAttribute('font-size', '10');
      label.textContent = z.label;
      svg.appendChild(label);
    });

    /* Draw racks */
    (layout.racks || []).forEach(rack => {
      const util = _rackUtilization(rack, levels);
      const col  = util > 0.9 ? '#ff3b3b' : util > 0.7 ? '#ffb800' : util > 0.3 ? '#71ff00' : '#1a2a1a';
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('x', rack.x * CELL + 2);
      rect.setAttribute('y', rack.y * colH + 2);
      rect.setAttribute('width', rack.w * CELL - 4);
      rect.setAttribute('height', rack.h * colH - 4);
      rect.setAttribute('fill', col);
      rect.setAttribute('rx', '4');
      rect.setAttribute('stroke', 'rgba(255,255,255,0.1)');
      rect.style.cursor = 'pointer';
      rect.addEventListener('mouseenter', () => {
        rect.setAttribute('filter', 'url(#glow)');
      });
      rect.addEventListener('mouseleave', () => rect.removeAttribute('filter'));
      rect.addEventListener('click', () => {
        EVT.dispatchEvent(new CustomEvent('rackClicked', { detail: { rack, util } }));
        if (opts.onRackClick) opts.onRackClick(rack, util);
      });
      svg.appendChild(rect);
      if (rack.label) {
        const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        t.setAttribute('x', (rack.x + rack.w / 2) * CELL);
        t.setAttribute('y', (rack.y + rack.h / 2) * colH + 4);
        t.setAttribute('text-anchor', 'middle');
        t.setAttribute('fill', '#fff');
        t.setAttribute('font-size', '9');
        t.setAttribute('font-weight', '700');
        t.textContent = rack.label;
        svg.appendChild(t);
      }
    });

    el.innerHTML = '';
    el.appendChild(svg);

    /* Legend */
    const leg = document.createElement('div');
    leg.style.cssText = 'display:flex;gap:12px;margin-top:8px;font-size:11px;color:rgba(255,255,255,0.5);flex-wrap:wrap;';
    [['#71ff00','Normal'], ['#ffb800','>70% Full'], ['#ff3b3b','>90% Full'], ['#1a2a1a','Empty']].forEach(([c, l]) => {
      const d = document.createElement('div');
      d.style.cssText = 'display:flex;align-items:center;gap:4px;';
      d.innerHTML = `<span style="width:10px;height:10px;background:${c};border-radius:2px;display:inline-block;"></span>${l}`;
      leg.appendChild(d);
    });
    el.appendChild(leg);
  }

  function _rackUtilization(rack, levels) {
    if (!rack.skus || !rack.capacity) return 0;
    const total = rack.skus.reduce((s, sku) => {
      const lv = levels.find(l => l.sku === sku || l.productId === sku);
      return s + (lv?.available || 0);
    }, 0);
    return Math.min(1, total / rack.capacity);
  }

  /* ══════════════════════════════════════════════════════════════════
     3. BUSINESS SIMULATION ENGINE
  ══════════════════════════════════════════════════════════════════ */

  async function simulate(scenario) {
    const result = await _cf('inventorySimulate', { tenantId: _tenantId(), scenario });
    EVT.dispatchEvent(new CustomEvent('simulationComplete', { detail: result }));
    return result;
  }

  async function getSimulationHistory(limit = 10) {
    return _cf('inventoryGetSimulations', { tenantId: _tenantId(), limit });
  }

  /* Quick client-side simulation for instant feedback */
  function simulateLocal(scenario, products, levels, movements) {
    const { type, params } = scenario;
    const days    = params.days   || 30;
    const factor  = params.factor || 1;
    const results = { type, params, projections: [], warnings: [] };

    if (type === 'demand_increase') {
      const avgDaily = movements.filter(m => m.type === 'sale').length / 30;
      const newDaily = avgDaily * factor;
      products.forEach(p => {
        const lv = levels.find(l => l.productId === p.id);
        const stock = lv?.available || 0;
        const stockoutDays = stock / Math.max(newDaily, 0.01);
        results.projections.push({
          productId: p.id, name: p.name, stock,
          projectedStockout: stockoutDays < days ? `Day ${Math.round(stockoutDays)}` : 'Safe',
          reorderQty: stockoutDays < days ? Math.ceil(newDaily * (params.leadTime || 7)) : 0,
        });
        if (stockoutDays < 7) results.warnings.push(`${p.name} will stock out in ${Math.round(stockoutDays)} days`);
      });
    }
    if (type === 'price_change') {
      results.projections = products.slice(0, 20).map(p => ({
        productId: p.id, name: p.name,
        currentPrice: p.price, newPrice: p.price * factor,
        estimatedRevenueDelta: ((p.price * factor) - p.price) * (p.monthlySales || 0),
      }));
    }
    return results;
  }

  /* ══════════════════════════════════════════════════════════════════
     4. FRAUD & LOSS PREVENTION ENGINE
  ══════════════════════════════════════════════════════════════════ */

  async function getFraudEvents(opts = {}) {
    const k = `fraud:${_tenantId()}:${opts.status || 'all'}`;
    const c = _cacheGet(k);
    if (c && !opts.refresh) return c;
    const r = await _cf('inventoryGetFraudEvents', { tenantId: _tenantId(), ...opts });
    _cacheSet(k, r, 60_000);
    return r;
  }

  async function reviewFraudEvent(eventId, decision, notes) {
    L1.delete(`fraud:${_tenantId()}:all`);
    L1.delete(`fraud:${_tenantId()}:pending`);
    return _cf('inventoryFraudReview', { eventId, decision, notes });
  }

  function computeLocalFraudScore(movement, context = {}) {
    let score = 0;
    const reasons = [];
    const { avgAdjustment = 0, userHistory = [], timeOfDay = new Date().getHours() } = context;

    if (movement.type === 'adjustment') {
      const delta = Math.abs(movement.qty);
      if (delta > avgAdjustment * 3) { score += 30; reasons.push('Unusually large adjustment'); }
      if (delta > 100) { score += 20; reasons.push('High-quantity single adjustment'); }
    }
    if (movement.type === 'damage' || movement.type === 'write_off') {
      if (movement.qty > 20) { score += 25; reasons.push('Large damage/write-off event'); }
    }
    if (timeOfDay >= 22 || timeOfDay <= 5) { score += 15; reasons.push('Off-hours transaction'); }
    if (!movement.reason || movement.reason.trim().length < 5) { score += 10; reasons.push('Missing or incomplete reason'); }
    if (movement.type === 'return_in' && movement.qty > 10) { score += 15; reasons.push('Bulk return'); }

    const level = score >= 60 ? 'HIGH' : score >= 30 ? 'MEDIUM' : 'LOW';
    return { score, level, reasons };
  }

  /* ══════════════════════════════════════════════════════════════════
     5. VOICE COMMAND PROCESSOR
  ══════════════════════════════════════════════════════════════════ */

  let _voiceRecognition = null;
  const VOICE_COMMANDS = [
    { pattern: /transfer\s+(\d+)\s+(.+)\s+to\s+(.+)/i, action: 'transfer', params: ['qty', 'product', 'warehouse'] },
    { pattern: /show\s+(low stock|out of stock|expired|overstock)/i, action: 'filter', params: ['filter'] },
    { pattern: /create\s+(?:a\s+)?(?:purchase\s+order|po)\s+for\s+(.+)/i, action: 'createPO', params: ['product'] },
    { pattern: /adjust\s+(.+)\s+(?:by|to)\s+([+-]?\d+)/i, action: 'adjust', params: ['product', 'qty'] },
    { pattern: /search\s+(?:for\s+)?(.+)/i, action: 'search', params: ['query'] },
    { pattern: /show\s+(?:me\s+)?analytics|analytics/i, action: 'navigate', params: ['tab:analytics'] },
    { pattern: /count\s+(?:today.s\s+)?(?:adjustments|movements)/i, action: 'countMovements', params: [] },
    { pattern: /forecast\s+(.+)/i, action: 'forecast', params: ['product'] },
  ];

  function startVoiceCommand(onResult, onError) {
    const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRec) { if (onError) onError('Voice recognition not supported'); return null; }
    if (_voiceRecognition) _voiceRecognition.stop();

    _voiceRecognition = new SpeechRec();
    _voiceRecognition.lang = 'en-KE';
    _voiceRecognition.continuous = false;
    _voiceRecognition.interimResults = false;

    _voiceRecognition.onresult = async e => {
      const text = e.results[0][0].transcript;
      const cmd  = parseVoiceCommand(text);
      if (onResult) onResult({ text, command: cmd });
    };
    _voiceRecognition.onerror = e => { if (onError) onError(e.error); };
    _voiceRecognition.start();
    return _voiceRecognition;
  }

  function stopVoiceCommand() {
    if (_voiceRecognition) { _voiceRecognition.stop(); _voiceRecognition = null; }
  }

  function parseVoiceCommand(text) {
    for (const cmd of VOICE_COMMANDS) {
      const m = text.match(cmd.pattern);
      if (m) {
        const params = {};
        cmd.params.forEach((p, i) => { params[p] = m[i + 1]; });
        return { action: cmd.action, params, raw: text };
      }
    }
    return { action: 'unknown', raw: text, suggestion: 'Try: "Transfer 10 bags of rice to Warehouse B"' };
  }

  /* ══════════════════════════════════════════════════════════════════
     6. PRODUCT PASSPORT
  ══════════════════════════════════════════════════════════════════ */

  async function getProductPassport(productId) {
    const k = `passport:${productId}`;
    const c = _cacheGet(k);
    if (c) return c;
    const r = await _cf('inventoryGetProductPassport', { productId, tenantId: _tenantId() });
    _cacheSet(k, r, 120_000);
    return r;
  }

  async function addPassportEvent(productId, event) {
    L1.delete(`passport:${productId}`);
    return _cf('inventoryAddPassportEvent', { productId, tenantId: _tenantId(), event });
  }

  function renderPassportTimeline(events, containerId) {
    const el = document.getElementById(containerId);
    if (!el) return;
    const icons = { purchase: '🛒', goods_received: '📦', sale: '💰', return: '↩️', repair: '🔧', warranty: '🛡️', transfer: '↔️', damage: '⚠️', disposal: '🗑️', recall: '🚨' };
    el.innerHTML = events.map((e, i) => `
      <div style="display:flex;gap:12px;padding:12px 0;border-bottom:1px solid rgba(255,255,255,0.05);">
        <div style="width:32px;height:32px;background:rgba(113,255,0,0.1);border-radius:50%;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:16px;">
          ${icons[e.type] || '📋'}
        </div>
        <div style="flex:1;">
          <div style="font-size:13px;font-weight:700;color:white;">${e.title || e.type}</div>
          <div style="font-size:11px;color:rgba(255,255,255,0.4);margin-top:2px;">${e.description || ''}</div>
          <div style="font-size:10px;color:rgba(113,255,0,0.6);margin-top:4px;">${_formatDate(e.ts)}</div>
        </div>
      </div>`).join('');
  }

  /* ══════════════════════════════════════════════════════════════════
     7. RECALL MANAGEMENT
  ══════════════════════════════════════════════════════════════════ */

  async function initiateRecall(params) {
    const result = await _cf('inventoryInitiateRecall', { tenantId: _tenantId(), ...params });
    EVT.dispatchEvent(new CustomEvent('recallInitiated', { detail: result }));
    return result;
  }

  async function getRecalls(opts = {}) {
    return _cf('inventoryGetRecalls', { tenantId: _tenantId(), ...opts });
  }

  async function updateRecallStatus(recallId, status, notes) {
    return _cf('inventoryUpdateRecallStatus', { recallId, status, notes });
  }

  async function generateRecallReport(recallId) {
    return _cf('inventoryRecallReport', { recallId, tenantId: _tenantId() });
  }

  /* ══════════════════════════════════════════════════════════════════
     8. AI IMPORT ENGINE
  ══════════════════════════════════════════════════════════════════ */

  async function parseImportFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = async e => {
        try {
          const text = e.target.result;
          let rows;
          if (file.name.endsWith('.json')) {
            rows = JSON.parse(text);
          } else {
            rows = _parseCSV(text);
          }
          resolve({ rows, filename: file.name, count: rows.length });
        } catch (err) { reject(err); }
      };
      reader.readAsText(file);
    });
  }

  function _parseCSV(text) {
    const lines = text.split('\n').filter(l => l.trim());
    if (!lines.length) return [];
    const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
    return lines.slice(1).map(line => {
      const vals = line.split(',').map(v => v.trim().replace(/^"|"$/g, ''));
      return Object.fromEntries(headers.map((h, i) => [h, vals[i] || '']));
    });
  }

  async function importPreview(rows, mappings) {
    return _cf('inventoryImportPreview', { tenantId: _tenantId(), rows: rows.slice(0, 50), mappings });
  }

  async function importCommit(jobId) {
    const result = await _cf('inventoryImportCommit', { jobId, tenantId: _tenantId() });
    EVT.dispatchEvent(new CustomEvent('importComplete', { detail: result }));
    return result;
  }

  async function importAiMap(headers, sampleRows) {
    return _cf('inventoryImportAiMap', { headers, sampleRows, tenantId: _tenantId() });
  }

  async function getImportJobs(limit = 10) {
    return _cf('inventoryGetImportJobs', { tenantId: _tenantId(), limit });
  }

  /* ══════════════════════════════════════════════════════════════════
     9. WORKFLOW AUTOMATION ENGINE
  ══════════════════════════════════════════════════════════════════ */

  const WORKFLOW_TRIGGERS = Object.freeze({
    STOCK_LOW      : 'stock.low',
    STOCK_OUT      : 'stock.out',
    PO_CREATED     : 'po.created',
    PO_APPROVED    : 'po.approved',
    MOVEMENT_LARGE : 'movement.large',
    FRAUD_DETECTED : 'fraud.detected',
    EXPIRY_NEAR    : 'expiry.near',
    RECALL_STARTED : 'recall.started',
    HEALTH_DROP    : 'health.drop',
    IMPORT_DONE    : 'import.done',
  });

  const WORKFLOW_ACTIONS = Object.freeze({
    SEND_NOTIFICATION : 'notify',
    CREATE_PO         : 'create_po',
    SEND_EMAIL        : 'email',
    SEND_WHATSAPP     : 'whatsapp',
    CREATE_ALERT      : 'alert',
    WEBHOOK           : 'webhook',
    AI_SUGGEST        : 'ai_suggest',
    MARK_PROMOTION    : 'promotion',
  });

  async function createWorkflow(workflow) {
    const result = await _cf('inventoryCreateWorkflow', { tenantId: _tenantId(), workflow });
    L1.delete(`workflows:${_tenantId()}`);
    return result;
  }

  async function getWorkflows(opts = {}) {
    const k = `workflows:${_tenantId()}`;
    const c = _cacheGet(k);
    if (c && !opts.refresh) return c;
    const r = await _cf('inventoryGetWorkflows', { tenantId: _tenantId() });
    _cacheSet(k, r, 120_000);
    return r;
  }

  async function toggleWorkflow(workflowId, active) {
    L1.delete(`workflows:${_tenantId()}`);
    return _cf('inventoryToggleWorkflow', { workflowId, active });
  }

  async function deleteWorkflow(workflowId) {
    L1.delete(`workflows:${_tenantId()}`);
    return _cf('inventoryDeleteWorkflow', { workflowId });
  }

  async function getWorkflowRuns(workflowId, limit = 20) {
    return _cf('inventoryGetWorkflowRuns', { workflowId, limit });
  }

  /* ══════════════════════════════════════════════════════════════════
     10. AI PRICING ENGINE
  ══════════════════════════════════════════════════════════════════ */

  async function getPricingRecommendations(productId) {
    const k = `pricing:${productId}`;
    const c = _cacheGet(k);
    if (c) return c;
    const r = await _cf('inventoryGetPricingRecommendations', { productId, tenantId: _tenantId() });
    _cacheSet(k, r, 600_000);
    return r;
  }

  async function setPricingRule(productId, rule) {
    L1.delete(`pricing:${productId}`);
    return _cf('inventorySetPricingRule', { productId, tenantId: _tenantId(), rule });
  }

  async function simulatePriceChange(productId, newPrice) {
    return _cf('inventorySimulatePriceChange', { productId, newPrice, tenantId: _tenantId() });
  }

  /* ══════════════════════════════════════════════════════════════════
     11. SUSTAINABILITY TRACKER
  ══════════════════════════════════════════════════════════════════ */

  async function getSustainabilityMetrics(period = 'month') {
    const k = `sustain:${_tenantId()}:${period}`;
    const c = _cacheGet(k);
    if (c) return c;
    const r = await _cf('inventoryGetSustainability', { tenantId: _tenantId(), period });
    _cacheSet(k, r, 3_600_000);
    return r;
  }

  async function logDisposal(productId, qty, method, notes = '') {
    return _cf('inventoryLogDisposal', { productId, qty, method, notes, tenantId: _tenantId() });
  }

  function computeSustainabilityLocal(movements) {
    const expired  = movements.filter(m => m.type === 'expiry').reduce((s, m) => s + Math.abs(m.qty), 0);
    const damaged  = movements.filter(m => m.type === 'damage').reduce((s, m) => s + Math.abs(m.qty), 0);
    const writeoff = movements.filter(m => m.type === 'write_off').reduce((s, m) => s + Math.abs(m.qty), 0);
    const donated  = movements.filter(m => m.type === 'donation').reduce((s, m) => s + Math.abs(m.qty), 0);
    const waste    = expired + damaged + writeoff;
    const recovery = donated / Math.max(waste, 1);
    const score    = Math.max(0, Math.round(100 - (waste / Math.max(movements.length, 1)) * 10 + recovery * 20));
    return { expired, damaged, writeoff, donated, waste, recovery: Math.round(recovery * 100), score };
  }

  /* ══════════════════════════════════════════════════════════════════
     12. PRODUCT TIMELINE REPLAY
  ══════════════════════════════════════════════════════════════════ */

  async function getProductTimeline(productId, opts = {}) {
    return _cf('inventoryGetProductTimeline', { productId, tenantId: _tenantId(), ...opts });
  }

  async function getInventoryTimeline(opts = {}) {
    const k = `timeline:${_tenantId()}:${JSON.stringify(opts)}`;
    const c = _cacheGet(k);
    if (c) return c;
    const r = await _cf('inventoryGetTimeline', { tenantId: _tenantId(), ...opts });
    _cacheSet(k, r, 30_000);
    return r;
  }

  /* ══════════════════════════════════════════════════════════════════
     13. MULTI-COMPANY SUPPORT
  ══════════════════════════════════════════════════════════════════ */

  async function getCompanies() {
    const user = firebase?.auth?.()?.currentUser;
    if (!user) return [];
    try {
      const db   = firebase.firestore();
      const snap = await db.collection('companies').where('owners', 'array-contains', user.uid).get();
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (_) { return []; }
  }

  async function switchCompany(companyId) {
    _activeCompany = companyId;
    L1.clear();
    EVT.dispatchEvent(new CustomEvent('companySwitch', { detail: { companyId } }));
  }

  function getActiveCompany() { return _activeCompany; }

  /* ══════════════════════════════════════════════════════════════════
     14. SUPPLIER MARKETPLACE
  ══════════════════════════════════════════════════════════════════ */

  async function searchSuppliers(query, filters = {}) {
    return _cf('inventorySearchSuppliers', { query, filters, tenantId: _tenantId() });
  }

  async function getSupplierCatalog(supplierId) {
    const k = `supplierCat:${supplierId}`;
    const c = _cacheGet(k);
    if (c) return c;
    const r = await _cf('inventoryGetSupplierCatalog', { supplierId });
    _cacheSet(k, r, 600_000);
    return r;
  }

  async function requestQuotation(supplierId, items) {
    return _cf('inventoryRequestQuotation', { supplierId, items, tenantId: _tenantId() });
  }

  async function compareSuppliers(productId) {
    return _cf('inventoryCompareSuppliers', { productId, tenantId: _tenantId() });
  }

  /* ══════════════════════════════════════════════════════════════════
     15. UNIVERSAL COMMERCE GRAPH
  ══════════════════════════════════════════════════════════════════ */

  let _graphUnsubscribes = [];

  function subscribeToCommerceGraph(tenantId, onUpdate) {
    if (!firebase?.firestore) return () => {};
    const db   = firebase.firestore();
    const unsub = db.collection(`tenants/${tenantId}/inventory_commerce_graph`).onSnapshot(snap => {
      snap.docChanges().forEach(ch => {
        if (ch.type === 'modified' || ch.type === 'added') {
          onUpdate(ch.doc.id, ch.doc.data());
        }
      });
    });
    _graphUnsubscribes.push(unsub);
    return unsub;
  }

  function unsubscribeCommerceGraph() {
    _graphUnsubscribes.forEach(u => u());
    _graphUnsubscribes = [];
  }

  async function syncEntityToGraph(entity, id, data) {
    return _cf('inventorySyncToGraph', { entity, id, data, tenantId: _tenantId() });
  }

  /* ══════════════════════════════════════════════════════════════════
     16. DEVELOPER WEBHOOKS
  ══════════════════════════════════════════════════════════════════ */

  const WEBHOOK_EVENTS = Object.freeze([
    'stock.low', 'stock.out', 'stock.adjusted', 'po.created', 'po.approved',
    'po.received', 'movement.recorded', 'fraud.detected', 'recall.initiated',
    'import.completed', 'workflow.triggered', 'health.score.changed',
  ]);

  async function registerWebhook(url, events, secret) {
    return _cf('inventoryRegisterWebhook', { url, events, secret, tenantId: _tenantId() });
  }

  async function listWebhooks() {
    return _cf('inventoryListWebhooks', { tenantId: _tenantId() });
  }

  async function deleteWebhook(webhookId) {
    return _cf('inventoryDeleteWebhook', { webhookId });
  }

  async function testWebhook(webhookId) {
    return _cf('inventoryTestWebhook', { webhookId });
  }

  /* ══════════════════════════════════════════════════════════════════
     17. MARKETPLACE INTELLIGENCE
  ══════════════════════════════════════════════════════════════════ */

  async function getMarketIntelligence(category) {
    const k = `market:${category}`;
    const c = _cacheGet(k);
    if (c) return c;
    const r = await _cf('inventoryGetMarketIntelligence', { category });
    _cacheSet(k, r, 3_600_000);
    return r;
  }

  async function getTrendingProducts(limit = 20) {
    const k = `trending:${limit}`;
    const c = _cacheGet(k);
    if (c) return c;
    const r = await _cf('inventoryGetTrending', { limit });
    _cacheSet(k, r, 1_800_000);
    return r;
  }

  /* ══════════════════════════════════════════════════════════════════
     18. INTELLIGENT RECALL ALERT BANNER
  ══════════════════════════════════════════════════════════════════ */

  async function checkActiveRecalls() {
    try {
      const r = await getRecalls({ status: 'active', limit: 5 });
      if (!r?.recalls?.length) return;
      _showRecallBanner(r.recalls);
    } catch (_) {}
  }

  function _showRecallBanner(recalls) {
    const existing = document.getElementById('inv-recall-banner');
    if (existing) existing.remove();
    const banner = document.createElement('div');
    banner.id = 'inv-recall-banner';
    banner.style.cssText = 'position:fixed;top:0;left:0;right:0;background:#ff3b3b;color:white;padding:10px 20px;z-index:9999;display:flex;align-items:center;justify-content:space-between;font-size:13px;font-weight:700;';
    banner.innerHTML = `
      <span>🚨 ${recalls.length} active recall${recalls.length > 1 ? 's' : ''}: ${recalls.map(r => r.productName).join(', ')}</span>
      <button onclick="this.parentElement.remove();window.location='#recalls';" style="background:rgba(255,255,255,0.2);border:none;color:white;padding:4px 12px;border-radius:6px;cursor:pointer;font-weight:700;">View Recalls</button>`;
    document.body.prepend(banner);
  }

  /* ══════════════════════════════════════════════════════════════════
     20. INIT — opens V2 IDB and starts background jobs
  ══════════════════════════════════════════════════════════════════ */

  async function initV2({ tenantId, industry = 'general' } = {}) {
    if (tenantId) _activeCompany = tenantId;
    _db2 = await _openDB2();
    setTimeout(_runExpiryAlerts, 6000);
    if (!_expiryTimer) {
      _expiryTimer = setInterval(_runExpiryAlerts, 3_600_000);
      window.addEventListener('pagehide', () => { clearInterval(_expiryTimer); _expiryTimer = null; }, { once: true });
    }
    EVT.dispatchEvent(new CustomEvent('v2:ready', { detail: { tenantId: _tenantId(), industry } }));
    return { tenantId: _tenantId(), industry };
  }

  /* ══════════════════════════════════════════════════════════════════
     21. PRODUCT VARIANTS
     Unlimited attribute dimensions: Color × Size × Material × etc.
     Each variant gets its own SKU, barcode, and stock level.
  ══════════════════════════════════════════════════════════════════ */

  async function saveVariant(variant) {
    if (!variant.productId) throw new Error('productId required');
    if (!variant.attributes || !Object.keys(variant.attributes).length)
      throw new Error('At least one variant attribute required e.g. { Color: "Red", Size: "M" }');

    const isNew = !variant.id;
    if (isNew) { variant.id = `var_${_uid6()}`; variant.createdAt = _nowISO(); variant.createdBy = _curUid(); }
    variant.updatedAt = _nowISO();
    variant.tenantId  = _tenantId();
    if (!variant.sku) {
      const attr = Object.values(variant.attributes).join('-').toUpperCase().replace(/\s+/g, '').slice(0, 12);
      variant.sku = `${variant.productId.slice(-5)}-${attr}`;
    }

    await _iPut('variants', variant);
    _cD(`var:${variant.productId}`);

    if (_online) {
      try { await _cf('inventorySaveVariant', { variant, tenantId: _tenantId() }); }
      catch (_) { await _enqueueQ2('inventorySaveVariant', { variant, tenantId: _tenantId() }); }
    }

    EVT.dispatchEvent(new CustomEvent('variantSaved', { detail: { variant, isNew } }));
    return variant;
  }

  async function getVariants(productId) {
    const k = `var:${productId}`;
    const h = _cG(k);
    if (h) return h;

    let variants = [];
    if (_online) {
      try {
        const res = await _cf('inventoryGetVariants', { productId, tenantId: _tenantId() });
        variants = res?.variants || [];
        await Promise.all(variants.map(v => _iPut('variants', v)));
      } catch (_) { variants = await _iAll('variants', 'productId', IDBKeyRange.only(productId)); }
    } else {
      variants = await _iAll('variants', 'productId', IDBKeyRange.only(productId));
    }

    _cS(k, variants);
    return variants;
  }

  async function deleteVariant(id) {
    const v = await _iGet('variants', id);
    if (v) _cD(`var:${v.productId}`);
    await _iDel('variants', id);
    if (_online) _cf('inventoryDeleteVariant', { id, tenantId: _tenantId() }).catch(() => {});
    EVT.dispatchEvent(new CustomEvent('variantDeleted', { detail: { id } }));
  }

  /* ══════════════════════════════════════════════════════════════════
     22. BATCH / LOT TRACKING
     FIFO, FEFO (nearest expiry first), LIFO rotation.
     Required for: pharmacy, grocery, restaurant, beauty, medical.
  ══════════════════════════════════════════════════════════════════ */

  const COSTING_METHODS = Object.freeze({ WAC: 'wac', FIFO: 'fifo', FEFO: 'fefo', LIFO: 'lifo' });

  async function createBatch(batch) {
    if (!batch.productId)   throw new Error('productId required');
    if (!batch.batchNumber) throw new Error('batchNumber required');

    batch.id           = `bat_${_uid6()}`;
    batch.warehouseId  = batch.warehouseId || 'main';
    batch.quantity     = Number(batch.quantity) || 0;
    batch.remainingQty = batch.quantity;
    batch.costPrice    = Number(batch.costPrice) || 0;
    batch.status       = 'active';
    batch.createdAt    = _nowISO();
    batch.createdBy    = _curUid();
    batch.tenantId     = _tenantId();

    await _iPut('batches', batch);
    _cD(`bat:${batch.productId}`);

    if (_online) {
      try { await _cf('inventoryCreateBatch', { batch, tenantId: _tenantId() }); }
      catch (_) { await _enqueueQ2('inventoryCreateBatch', { batch, tenantId: _tenantId() }); }
    }

    EVT.dispatchEvent(new CustomEvent('batchCreated', { detail: { batch } }));
    return batch;
  }

  async function getBatches(productId, { warehouseId, includeEmpty = false, costingMethod = COSTING_METHODS.FEFO } = {}) {
    const k = `bat:${productId}:${warehouseId}:${includeEmpty}`;
    const h = _cG(k);
    if (h) return h;

    let rows = await _iAll('batches', 'productId', IDBKeyRange.only(productId));
    if (warehouseId)    rows = rows.filter(b => b.warehouseId === warehouseId);
    if (!includeEmpty)  rows = rows.filter(b => b.status === 'active' && b.remainingQty > 0);

    if (costingMethod === COSTING_METHODS.FEFO) {
      rows.sort((a, b) => {
        if (!a.expiryDate) return 1;
        if (!b.expiryDate) return -1;
        return new Date(a.expiryDate) - new Date(b.expiryDate);
      });
    } else if (costingMethod === COSTING_METHODS.FIFO || costingMethod === COSTING_METHODS.WAC) {
      rows.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    } else {
      rows.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)); // LIFO
    }

    _cS(k, rows, 15_000);
    return rows;
  }

  async function getAllBatches({ warehouseId } = {}) {
    const all = await _iAll('batches');
    return warehouseId ? all.filter(b => b.warehouseId === warehouseId) : all;
  }

  async function deductBatch({ productId, warehouseId = 'main', quantity, costingMethod }) {
    const batches  = await getBatches(productId, { warehouseId, costingMethod: costingMethod || COSTING_METHODS.FEFO });
    if (!batches.length) throw new Error(`No available batches for product ${productId}`);

    let remaining = Math.abs(quantity);
    const deducted = [];

    for (const b of batches) {
      if (remaining <= 0) break;
      const take = Math.min(b.remainingQty, remaining);
      b.remainingQty -= take;
      if (b.remainingQty <= 0) b.status = 'depleted';
      remaining -= take;
      deducted.push({ batchId: b.id, batchNumber: b.batchNumber, qty: take, unitCost: b.costPrice });
      await _iPut('batches', b);
      _cD(`bat:${productId}`);
    }

    if (remaining > 0) throw new Error(`Insufficient batch stock — short by ${remaining} units`);
    return deducted;
  }

  async function getExpiringBatches(days = 30) {
    const cutoff = new Date(Date.now() + days * 86400000);
    const all    = await _iAll('batches');
    return all.filter(b =>
      b.status === 'active' && b.remainingQty > 0 && b.expiryDate &&
      new Date(b.expiryDate) <= cutoff
    ).sort((a, b) => new Date(a.expiryDate) - new Date(b.expiryDate));
  }

  /* ══════════════════════════════════════════════════════════════════
     23. SERIAL NUMBER TRACKING
     Full lifecycle: received → available → sold → returned/repaired/scrapped.
     Required for: electronics, medical, automotive.
  ══════════════════════════════════════════════════════════════════ */

  const SERIAL_STATES = Object.freeze({
    AVAILABLE:  'available',
    SOLD:       'sold',
    RETURNED:   'returned',
    REPAIRED:   'repaired',
    SCRAPPED:   'scrapped',
    LOST:       'lost',
    WARRANTY:   'under_warranty',
    QUARANTINE: 'quarantine',
  });

  async function registerSerials({ productId, variantId, warehouseId, serials, batchId, unitCost, supplierId }) {
    if (!productId)      throw new Error('productId required');
    if (!serials?.length) throw new Error('At least one serial number required');

    const created = [];
    for (const sn of serials) {
      const exists = await _iAll('serials', 'serialNumber', IDBKeyRange.only(String(sn).trim()));
      if (exists.length) continue;
      const serial = {
        id: `ser_${_uid6()}`, serialNumber: String(sn).trim(),
        productId, variantId: variantId || null, warehouseId: warehouseId || 'main',
        batchId: batchId || null, status: SERIAL_STATES.AVAILABLE,
        unitCost: Number(unitCost) || 0, supplierId: supplierId || null,
        receivedAt: _nowISO(), soldAt: null, soldTo: null,
        warrantyDays: 0, warrantyExpiry: null, notes: '',
        createdAt: _nowISO(), createdBy: _curUid(), tenantId: _tenantId(),
      };
      await _iPut('serials', serial);
      created.push(serial);
    }

    if (_online && created.length) {
      _cf('inventoryRegisterSerials', { serials: created, tenantId: _tenantId() }).catch(() => {});
    }
    EVT.dispatchEvent(new CustomEvent('serialsRegistered', { detail: { productId, count: created.length } }));
    return created;
  }

  async function getSerial(serialNumber) {
    const rows = await _iAll('serials', 'serialNumber', IDBKeyRange.only(serialNumber));
    return rows[0] || null;
  }

  async function getSerialsByProduct(productId, { status, warehouseId } = {}) {
    let rows = await _iAll('serials', 'productId', IDBKeyRange.only(productId));
    if (status)      rows = rows.filter(s => s.status === status);
    if (warehouseId) rows = rows.filter(s => s.warehouseId === warehouseId);
    return rows;
  }

  async function getAllSerials({ status, warehouseId } = {}) {
    let rows = await _iAll('serials');
    if (status)      rows = rows.filter(s => s.status === status);
    if (warehouseId) rows = rows.filter(s => s.warehouseId === warehouseId);
    return rows;
  }

  async function updateSerialStatus(serialId, { status, soldTo, orderId, warrantyDays, notes } = {}) {
    const serial = await _iGet('serials', serialId);
    if (!serial) throw new Error('Serial not found');

    const prev = serial.status;
    serial.status    = status;
    serial.updatedAt = _nowISO();
    if (soldTo)      serial.soldTo  = soldTo;
    if (orderId)     serial.orderId = orderId;
    if (notes)       serial.notes   = notes;
    if (status === SERIAL_STATES.SOLD) serial.soldAt = _nowISO();
    if (warrantyDays) {
      serial.warrantyDays   = warrantyDays;
      const exp = new Date();
      exp.setDate(exp.getDate() + warrantyDays);
      serial.warrantyExpiry = exp.toISOString();
    }

    await _iPut('serials', serial);

    const hist = { id: `sh_${_uid6()}`, serialId, fromStatus: prev, toStatus: status, changedBy: _curUid(), changedAt: _nowISO(), notes: notes || '' };
    await _iPut('serialHistory', hist);

    if (_online) _cf('inventoryUpdateSerial', { serialId, patch: { status, soldAt: serial.soldAt, soldTo, warrantyExpiry: serial.warrantyExpiry }, tenantId: _tenantId() }).catch(() => {});

    EVT.dispatchEvent(new CustomEvent('serialUpdated', { detail: { serial, history: hist } }));
    return serial;
  }

  async function getSerialHistory2(serialId) {
    const rows = await _iAll('serialHistory', 'serialId', IDBKeyRange.only(serialId));
    return rows.sort((a, b) => new Date(b.changedAt) - new Date(a.changedAt));
  }

  /* ══════════════════════════════════════════════════════════════════
     24. MANUFACTURING — BILL OF MATERIALS + WORK ORDERS
  ══════════════════════════════════════════════════════════════════ */

  const WO_STATUS = Object.freeze({ DRAFT: 'draft', IN_PROGRESS: 'in_progress', COMPLETED: 'completed', CANCELLED: 'cancelled' });

  async function saveBOM(bom) {
    if (!bom.productId)          throw new Error('productId required');
    if (!bom.components?.length) throw new Error('BOM requires at least one component');

    bom.id       = bom.id || `bom_${_uid6()}`;
    bom.yieldQty = bom.yieldQty || 1;
    bom.updatedAt = _nowISO();
    bom.tenantId  = _tenantId();
    if (!bom.createdAt) { bom.createdAt = _nowISO(); bom.createdBy = _curUid(); }

    await _iPut('bom', bom);
    if (_online) _cf('inventorySaveBOM', { bom, tenantId: _tenantId() }).catch(() => {});
    EVT.dispatchEvent(new CustomEvent('bomSaved', { detail: { bom } }));
    return bom;
  }

  async function getBOM2(productId) {
    const rows = await _iAll('bom', 'productId', IDBKeyRange.only(productId));
    return rows[0] || null;
  }

  async function createWorkOrder({ productId, quantity, warehouseId = 'main', scheduledDate, notes }) {
    if (!productId || !quantity) throw new Error('productId and quantity required');
    const bom = await getBOM2(productId);
    if (!bom) throw new Error('No Bill of Materials defined for this product. Create a BOM first.');

    const v1 = window.SokoniInventory;
    const shortages = [];
    for (const comp of bom.components) {
      const needed = (comp.quantity * quantity) / bom.yieldQty;
      let available = 0;
      try { available = (await v1?.getStockLevel?.(comp.productId, warehouseId))?.available || 0; } catch (_) {}
      if (available < needed) shortages.push({ productId: comp.productId, needed, available, shortfall: needed - available });
    }

    const wo = {
      id: `wo_${_uid6()}`, productId, quantity, warehouseId,
      bomId: bom.id, status: WO_STATUS.DRAFT,
      scheduledDate: scheduledDate || null, notes: notes || '',
      shortages, createdAt: _nowISO(), createdBy: _curUid(), tenantId: _tenantId(),
    };

    await _iPut('workOrders', wo);
    if (_online) _cf('inventoryCreateWorkOrder', { wo, tenantId: _tenantId() }).catch(() => {});
    EVT.dispatchEvent(new CustomEvent('workOrderCreated', { detail: { wo } }));
    return wo;
  }

  async function updateWorkOrderStatus(workOrderId, status, { notes, actualQty } = {}) {
    const wo = await _iGet('workOrders', workOrderId);
    if (!wo) throw new Error('Work order not found');
    wo.status = status;
    wo.updatedAt = _nowISO();
    if (notes)     wo.notes     = notes;
    if (actualQty) wo.actualQty = actualQty;
    if (status === WO_STATUS.COMPLETED) wo.completedAt = _nowISO();
    await _iPut('workOrders', wo);
    if (_online) _cf('inventoryUpdateWorkOrder', { workOrderId, status, tenantId: _tenantId() }).catch(() => {});
    EVT.dispatchEvent(new CustomEvent('workOrderUpdated', { detail: { wo } }));
    return wo;
  }

  async function getWorkOrders2({ status, productId } = {}) {
    let rows = await _iAll('workOrders', status ? 'status' : null, status ? IDBKeyRange.only(status) : null);
    if (productId) rows = rows.filter(w => w.productId === productId);
    return rows.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  /* ══════════════════════════════════════════════════════════════════
     25. WAREHOUSE TRANSFER WORKFLOW
     4-stage: pending → approved → shipped → received
  ══════════════════════════════════════════════════════════════════ */

  const TRANSFER_STATUS = Object.freeze({ PENDING: 'pending', APPROVED: 'approved', SHIPPED: 'shipped', RECEIVED: 'received', CANCELLED: 'cancelled' });

  async function requestTransfer2({ productId, variantId, fromWarehouse, toWarehouse, quantity, notes, priority = 'normal' }) {
    if (!productId || !fromWarehouse || !toWarehouse || !quantity) throw new Error('productId, fromWarehouse, toWarehouse, quantity required');
    const tr = {
      id: `tr_${_uid6()}`, productId, variantId: variantId || null,
      fromWarehouse, toWarehouse, quantity: Number(quantity),
      status: TRANSFER_STATUS.PENDING, priority, notes: notes || '',
      requestedBy: _curUid(), requestedAt: _nowISO(),
      approvedBy: null, approvedAt: null, shippedBy: null, shippedAt: null,
      receivedBy: null, receivedAt: null, receivedQty: null,
      tenantId: _tenantId(),
    };
    await _iPut('transfers', tr);
    if (_online) {
      try { await _cf('inventoryRequestTransfer', { tr, tenantId: _tenantId() }); }
      catch (_) { await _enqueueQ2('inventoryRequestTransfer', { tr, tenantId: _tenantId() }); }
    }
    EVT.dispatchEvent(new CustomEvent('transferRequested', { detail: { transfer: tr } }));
    return tr;
  }

  async function _patchTransfer(id, patch) {
    const tr = await _iGet('transfers', id);
    if (!tr) throw new Error('Transfer not found');
    Object.assign(tr, patch);
    await _iPut('transfers', tr);
    if (_online) _cf('inventoryPatchTransfer', { id, patch, tenantId: _tenantId() }).catch(() => {});
    return tr;
  }

  async function approveTransfer2(id) {
    const tr = await _patchTransfer(id, { status: TRANSFER_STATUS.APPROVED, approvedBy: _curUid(), approvedAt: _nowISO() });
    EVT.dispatchEvent(new CustomEvent('transferApproved', { detail: { transfer: tr } }));
    return tr;
  }

  async function shipTransfer2(id) {
    const tr = await _iGet('transfers', id);
    if (tr?.status !== TRANSFER_STATUS.APPROVED) throw new Error('Transfer must be approved before shipping');
    const updated = await _patchTransfer(id, { status: TRANSFER_STATUS.SHIPPED, shippedBy: _curUid(), shippedAt: _nowISO() });
    EVT.dispatchEvent(new CustomEvent('transferShipped', { detail: { transfer: updated } }));
    return updated;
  }

  async function receiveTransfer2(id, { receivedQty, notes } = {}) {
    const tr = await _iGet('transfers', id);
    if (tr?.status !== TRANSFER_STATUS.SHIPPED) throw new Error('Transfer must be in-transit before receiving');
    const patch = { status: TRANSFER_STATUS.RECEIVED, receivedBy: _curUid(), receivedAt: _nowISO(), receivedQty: receivedQty ?? tr.quantity };
    if (notes) patch.receiveNotes = notes;
    const updated = await _patchTransfer(id, patch);
    EVT.dispatchEvent(new CustomEvent('transferReceived', { detail: { transfer: updated } }));
    return updated;
  }

  async function cancelTransfer2(id, reason) {
    const tr = await _iGet('transfers', id);
    if (tr?.status === TRANSFER_STATUS.RECEIVED) throw new Error('Cannot cancel a completed transfer');
    const updated = await _patchTransfer(id, { status: TRANSFER_STATUS.CANCELLED, cancelReason: reason || '', cancelledAt: _nowISO(), cancelledBy: _curUid() });
    EVT.dispatchEvent(new CustomEvent('transferCancelled', { detail: { transfer: updated } }));
    return updated;
  }

  async function getTransfers2({ status, fromWarehouse, toWarehouse } = {}) {
    let rows = await _iAll('transfers', status ? 'status' : null, status ? IDBKeyRange.only(status) : null);
    if (fromWarehouse) rows = rows.filter(t => t.fromWarehouse === fromWarehouse);
    if (toWarehouse)   rows = rows.filter(t => t.toWarehouse   === toWarehouse);
    return rows.sort((a, b) => new Date(b.requestedAt) - new Date(a.requestedAt));
  }

  /* ══════════════════════════════════════════════════════════════════
     26. IN-BROWSER DEMAND FORECASTING
     Exponential smoothing + 7-day moving average.
     No external API call — works offline.
  ══════════════════════════════════════════════════════════════════ */

  function _expSmooth(series, alpha = 0.3) {
    if (!series.length) return [];
    const out = [series[0]];
    for (let i = 1; i < series.length; i++) out.push(alpha * series[i] + (1 - alpha) * out[i - 1]);
    return out;
  }
  function _movAvg(series, w = 7) {
    return series.map((_, i) => {
      const sl = series.slice(Math.max(0, i - w + 1), i + 1);
      return sl.reduce((s, v) => s + v, 0) / sl.length;
    });
  }

  async function forecastDemandLocal({ productId, warehouseId = 'main', forecastDays = 30 } = {}) {
    const v1 = window.SokoniInventory;
    if (!v1) return { forecast: [], dailyAvg: 0, suggestedReorderQty: 0 };

    const movements = await v1.getMovements({ productId, type: 'sale', limit: 500 }).catch(() => []);
    const byDay = {};
    for (const m of movements) {
      const d = m.timestamp?.slice(0, 10);
      if (d) byDay[d] = (byDay[d] || 0) + Math.abs(m.quantity);
    }
    const today = new Date();
    const series = Array.from({ length: 90 }, (_, i) => {
      const d = new Date(today);
      d.setDate(d.getDate() - (89 - i));
      return byDay[d.toISOString().slice(0, 10)] || 0;
    });

    const smoothed = _expSmooth(series, 0.3);
    const ma7      = _movAvg(series, 7);
    const dailyAvg = ((smoothed.at(-1) || 0) + (ma7.at(-1) || 0)) / 2;

    const forecast = Array.from({ length: forecastDays }, (_, i) => {
      const d = new Date(today);
      d.setDate(d.getDate() + i + 1);
      return { date: d.toISOString().slice(0, 10), predicted: Math.max(0, Math.round(dailyAvg * (0.85 + Math.random() * 0.3))) };
    });

    let currentStock = 0, reorderPoint = 0;
    try {
      const lvl = await v1.getStockLevel(productId, warehouseId);
      currentStock = lvl.available || 0;
      reorderPoint = lvl.reorderPoint || 0;
    } catch (_) {}

    const result = {
      id: `fc_${productId}_${warehouseId}`,
      productId, warehouseId,
      dailyAvg:            parseFloat(dailyAvg.toFixed(2)),
      forecast,
      daysOfStock:         dailyAvg > 0 ? Math.floor(currentStock / dailyAvg) : 999,
      suggestedReorderQty: Math.ceil(dailyAvg * 30),
      currentStock, reorderPoint,
      needsReorder: currentStock <= reorderPoint,
      generatedAt:  _nowISO(),
    };

    await _iPut('forecastData', result);
    EVT.dispatchEvent(new CustomEvent('forecastGenerated', { detail: result }));
    return result;
  }

  async function getAllForecasts() {
    return _iAll('forecastData');
  }

  /* ══════════════════════════════════════════════════════════════════
     27. AUTO REORDER RULES — client-side rule engine
  ══════════════════════════════════════════════════════════════════ */

  async function saveReorderRule(rule) {
    if (!rule.productId) throw new Error('productId required');
    const existing = await _iAll('reorderRules', 'productId', IDBKeyRange.only(rule.productId));
    rule.id       = existing[0]?.id || `rr_${_uid6()}`;
    rule.active   = rule.active !== false;
    rule.updatedAt = _nowISO();
    rule.tenantId  = _tenantId();
    await _iPut('reorderRules', rule);
    EVT.dispatchEvent(new CustomEvent('reorderRuleSaved', { detail: { rule } }));
    return rule;
  }

  async function getReorderRules2({ activeOnly = true } = {}) {
    const all = await _iAll('reorderRules');
    return activeOnly ? all.filter(r => r.active) : all;
  }

  async function deleteReorderRule(id) {
    await _iDel('reorderRules', id);
    EVT.dispatchEvent(new CustomEvent('reorderRuleDeleted', { detail: { id } }));
  }

  async function runReorderCheck() {
    const v1    = window.SokoniInventory;
    if (!v1) return [];
    const rules = await getReorderRules2({ activeOnly: true });
    const triggered = [];
    for (const rule of rules) {
      try {
        const lvl = await v1.getStockLevel(rule.productId, rule.warehouseId || 'main');
        if (lvl.available > (rule.reorderPoint || lvl.reorderPoint || 5)) continue;
        if (!rule.supplierId) continue;
        const po = await v1.createPO({
          supplierId:  rule.supplierId,
          warehouseId: rule.warehouseId || 'main',
          notes:       'Auto-generated by reorder rule engine',
          items: [{ productId: rule.productId, name: rule.productName || rule.productId, qty: rule.orderQty || 50, unitCost: rule.lastCost || 0 }],
        });
        triggered.push(po);
        rule.lastTriggeredAt = _nowISO();
        await _iPut('reorderRules', rule);
      } catch (_) {}
    }
    if (triggered.length) EVT.dispatchEvent(new CustomEvent('reordersGenerated', { detail: { count: triggered.length, orders: triggered } }));
    return triggered;
  }

  /* ══════════════════════════════════════════════════════════════════
     28. SMART NOTIFICATIONS — in-app + push
  ══════════════════════════════════════════════════════════════════ */

  async function pushNotif({ type, title, message, severity = 'info', productId, data = {} }) {
    const n = {
      id: `notif_${_uid6()}`, type, title, message, severity,
      productId: productId || null, data, status: 'unread', createdAt: _nowISO(),
    };
    await _iPut('notifications', n);
    EVT.dispatchEvent(new CustomEvent('notification', { detail: { notification: n } }));
    if (Notification?.permission === 'granted') {
      try { new Notification(`SOKONI Inventory: ${title}`, { body: message, icon: '/assets/icons/icon-192.png' }); } catch (_) {}
    }
    return n;
  }

  async function getNotifs({ unreadOnly = false, limit = 50 } = {}) {
    const all = await _iAll('notifications');
    return all
      .filter(n => !unreadOnly || n.status === 'unread')
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, limit);
  }

  async function markNotifRead(id) {
    const n = await _iGet('notifications', id);
    if (n) { n.status = 'read'; n.readAt = _nowISO(); await _iPut('notifications', n); }
  }

  async function markAllNotifsRead() {
    const unread = await _iAll('notifications', 'status', IDBKeyRange.only('unread'));
    await Promise.all(unread.map(n => { n.status = 'read'; n.readAt = _nowISO(); return _iPut('notifications', n); }));
  }

  async function requestPushPermission() {
    if (!('Notification' in window)) return 'unsupported';
    if (Notification.permission === 'default') await Notification.requestPermission();
    return Notification.permission;
  }

  /* Background expiry alert runner */
  async function _runExpiryAlerts() {
    if (!_db2) return;
    try {
      const expiring = await getExpiringBatches(30);
      for (const b of expiring) {
        const daysLeft = Math.ceil((new Date(b.expiryDate) - new Date()) / 86400000);
        if (daysLeft <= 0) {
          await pushNotif({ type: 'expired', title: 'Product Expired',
            message: `Batch ${b.batchNumber} has expired. ${b.remainingQty} units unsold.`,
            severity: 'critical', productId: b.productId, data: { batchId: b.id } });
        } else if (daysLeft <= 7) {
          await pushNotif({ type: 'expiry_warning', title: 'Expiry Alert',
            message: `Batch ${b.batchNumber} expires in ${daysLeft} day(s). Stock: ${b.remainingQty} units.`,
            severity: 'warning', productId: b.productId, data: { batchId: b.id, daysLeft } });
        }
      }
    } catch (_) {}
  }

  /* ══════════════════════════════════════════════════════════════════
     19. HELPERS & UTILITIES
  ══════════════════════════════════════════════════════════════════ */

  function _formatDate(ts) {
    if (!ts) return '—';
    const d = ts?.toDate ? ts.toDate() : new Date(ts);
    return d.toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  /* Event system */
  function on(event, handler) { EVT.addEventListener(event, handler); }
  function off(event, handler) { EVT.removeEventListener(event, handler); }
  function emit(event, detail) { EVT.dispatchEvent(new CustomEvent(event, { detail })); }

  /* ══════════════════════════════════════════════════════════════════
     PUBLIC API
  ══════════════════════════════════════════════════════════════════ */
  return Object.freeze({
    /* Health Score */    getHealthScore, getHealthHistory, computeHealthScoreLocal,
    /* Digital Twin */   renderWarehouseMap, getWarehouseLayout, saveWarehouseLayout,
    /* Simulation */     simulate, simulateLocal, getSimulationHistory,
    /* Fraud */          getFraudEvents, reviewFraudEvent, computeLocalFraudScore,
    /* Voice */          startVoiceCommand, stopVoiceCommand, parseVoiceCommand,
    /* Passport */       getProductPassport, addPassportEvent, renderPassportTimeline,
    /* Recalls */        initiateRecall, getRecalls, updateRecallStatus, generateRecallReport, checkActiveRecalls,
    /* Import */         parseImportFile, importPreview, importCommit, importAiMap, getImportJobs,
    /* Workflows */      createWorkflow, getWorkflows, toggleWorkflow, deleteWorkflow, getWorkflowRuns,
                         WORKFLOW_TRIGGERS, WORKFLOW_ACTIONS,
    /* Pricing */        getPricingRecommendations, setPricingRule, simulatePriceChange,
    /* Sustainability */ getSustainabilityMetrics, logDisposal, computeSustainabilityLocal,
    /* Timeline */       getProductTimeline, getInventoryTimeline,
    /* Multi-Company */  getCompanies, switchCompany, getActiveCompany,
    /* Suppliers */      searchSuppliers, getSupplierCatalog, requestQuotation, compareSuppliers,
    /* Commerce Graph */ subscribeToCommerceGraph, unsubscribeCommerceGraph, syncEntityToGraph,
    /* Webhooks */       registerWebhook, listWebhooks, deleteWebhook, testWebhook, WEBHOOK_EVENTS,
    /* Intelligence */   getMarketIntelligence, getTrendingProducts,
    /* Events */         on, off, emit,
    /* Utils */          tenantId: _tenantId,

    /* Init V2 */        init: initV2,

    /* Variants */       saveVariant, getVariants, deleteVariant,

    /* Batches */        createBatch, getBatches, getAllBatches, deductBatch, getExpiringBatches,
                         COSTING_METHODS,

    /* Serials */        registerSerials, getSerial, getSerialsByProduct, getAllSerials,
                         updateSerialStatus, getSerialHistory: getSerialHistory2, SERIAL_STATES,

    /* Manufacturing */  saveBOM, getBOM: getBOM2, createWorkOrder, updateWorkOrderStatus,
                         getWorkOrders: getWorkOrders2, WO_STATUS,

    /* Transfers */      requestTransfer: requestTransfer2, approveTransfer: approveTransfer2,
                         shipTransfer: shipTransfer2, receiveTransfer: receiveTransfer2,
                         cancelTransfer: cancelTransfer2, getTransfers: getTransfers2,
                         TRANSFER_STATUS,

    /* Forecasting */    forecastDemandLocal, getAllForecasts,

    /* Reorder Rules */  saveReorderRule, getReorderRules: getReorderRules2, deleteReorderRule, runReorderCheck,

    /* Notifications */  pushNotif, getNotifs, markNotifRead, markAllNotifsRead, requestPushPermission,
  });
})();

if (typeof module !== 'undefined') module.exports = SokoniInventoryV2;
window.SokoniInventoryV2 = SokoniInventoryV2;
