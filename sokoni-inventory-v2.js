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
  });
})();

if (typeof module !== 'undefined') module.exports = SokoniInventoryV2;
