/* SOKONI SmartPOS — Payment Terminal Management System
   Supports: Bluetooth PDQ, Wi-Fi/Network PDQ, Cloud-Connected,
   Manual Registration, Simulated (testing), SoftPOS NFC (stub).
   Manages devices, assignments, card payment flow, monitoring, recovery queue. */

window.PosTerminals = (() => {
  'use strict';

  /* ── Constants ──────────────────────────────────────────────── */
  const TYPE    = { PDQ:'pdq', PRINTER:'printer', SCANNER:'scanner', LABEL:'label', DRAWER:'cash_drawer' };
  const CONN    = { BT:'bluetooth', WIFI:'wifi', NET:'network', CLOUD:'cloud', MANUAL:'manual', SIM:'simulated', NFC:'softpos' };
  const STATUS  = { ON:'connected', OFF:'disconnected', PAIR:'pairing', ERR:'error', UPD:'updating' };

  const TYPE_ICONS = { pdq:'💳', printer:'🖨️', scanner:'📷', label:'🏷️', cash_drawer:'🗄️' };
  const CONN_ICONS = { bluetooth:'🔵', wifi:'📶', network:'🌐', cloud:'☁️', manual:'✏️', simulated:'🧪', softpos:'📲' };
  const STATUS_CLR = { connected:'#00a84e', disconnected:'#888', pairing:'#f59e0b', error:'#ef4444', updating:'#3b82f6' };

  /* ── Module state ───────────────────────────────────────────── */
  const _s = {
    devices:     [],
    assignments: {},      // tillId → { tillId, deviceId }
    active:      null,    // in-flight payment object
    monInterval: null,
    wiz:         { step:0, data:{} },
    onResult:    null,    // callback for card payment result
  };

  /* ── Helpers ─────────────────────────────────────────────────── */
  function _uid(p) { return p + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2,6); }
  function _delay(ms) { return new Promise(r => setTimeout(r, ms)); }
  function _el(id) { return document.getElementById(id); }
  function _setText(id, txt) { const e = _el(id); if (e) e.textContent = txt; }
  function _toast(msg, type) { if (typeof SPos?.toast === 'function') SPos.toast(msg, type); else console.warn('[PosTerminals]', msg); }

  /* ── Adapters ────────────────────────────────────────────────── */

  const BluetoothAdapter = {
    supported() { return !!navigator.bluetooth; },
    async discover() {
      if (!this.supported()) throw new Error('Web Bluetooth not available — use Chrome on Android or Windows');
      return navigator.bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices: [
          '0000ffe0-0000-1000-8000-00805f9b34fb',
          '0000ffe1-0000-1000-8000-00805f9b34fb',
        ],
      });
    },
    async connect(btDevice) {
      const server = await btDevice.gatt.connect();
      return server;
    },
  };

  const NetworkAdapter = {
    async probe(ip, port = 8080) {
      try {
        const res = await fetch(`http://${ip}:${port}/api/v1/status`, { signal: AbortSignal.timeout(3000) });
        if (!res.ok) return null;
        return await res.json();
      } catch { return null; }
    },
    async sendPayment(ip, port = 8080, payload) {
      const res = await fetch(`http://${ip}:${port}/api/v1/payment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(90000),
      });
      if (!res.ok) throw new Error(`Terminal rejected request: ${res.status}`);
      return res.json();
    },
    async cancel(ip, port = 8080) {
      try { await fetch(`http://${ip}:${port}/api/v1/cancel`, { method:'POST', signal: AbortSignal.timeout(5000) }); } catch { /* best-effort */ }
    },
  };

  const CloudAdapter = {
    async _fn(name) {
      const { getFunctions, httpsCallable } = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js');
      return httpsCallable(getFunctions(window.firebaseApp), name);
    },
    async initiate(terminalId, amount, ref) {
      const fn = await this._fn('posInitiateTerminalPayment');
      return (await fn({ terminalId, amount, reference: ref })).data;
    },
    async poll(ref) {
      const fn = await this._fn('posPollTerminalPayment');
      return (await fn({ reference: ref })).data;
    },
    async cancel(ref) {
      try { const fn = await this._fn('posCancelTerminalPayment'); await fn({ reference: ref }); } catch { /* best-effort */ }
    },
  };

  const SoftPOSAdapter = {
    supported() { return 'NDEFReader' in window; },
    async initiate(amount) {
      if (!this.supported()) throw new Error('NFC not available on this device — requires Android Chrome with NFC');
      throw new Error('SoftPOS requires a certified NFC payment SDK. Architecture is ready — contact your acquiring bank.');
    },
  };

  const SimulatedAdapter = {
    _active: null,
    async initiate(amount) {
      return new Promise(resolve => {
        const delay = 2500 + Math.random() * 2000;
        this._active = setTimeout(() => {
          this._active = null;
          const outcome = Math.random() > 0.1 ? 'approved' : 'declined';
          if (outcome === 'approved') {
            resolve({
              status: 'approved',
              authCode: 'SIM' + Math.random().toString(36).slice(2,8).toUpperCase(),
              cardLast4: '' + Math.floor(1000 + Math.random() * 9000),
              cardScheme: ['Visa','Mastercard','Amex'][Math.floor(Math.random()*3)],
              reference: 'TSIM' + Date.now(),
              amount,
            });
          } else {
            resolve({ status:'declined', reason:'Insufficient funds', reference:'TSIM' + Date.now() });
          }
        }, delay);
      });
    },
    cancel() { if (this._active) { clearTimeout(this._active); this._active = null; } },
  };

  /* ── IndexedDB wrappers ──────────────────────────────────────── */
  const _db = {
    async allDevices()      { return PosDB.devices.getAll(); },
    async saveDevice(d)     { return PosDB.devices.save(d); },
    async deleteDevice(id)  { return PosDB.devices.delete(id); },
    async allAssignments()  { return PosDB.terminal_assignments.getAll(); },
    async saveAssignment(a) { return PosDB.terminal_assignments.save(a); },
    async delAssignment(id) { return PosDB.terminal_assignments.delete(id); },
    async allQueue()        { return PosDB.terminal_queue.getAll(); },
    async saveQueue(q)      { return PosDB.terminal_queue.save(q); },
    async delQueue(id)      { return PosDB.terminal_queue.delete(id); },
  };

  /* ── Device management ──────────────────────────────────────── */
  const devices = {
    async all()     { return _s.devices; },
    async byType(t) { return _s.devices.filter(d => d.type === t); },
    async forTill(tillId) {
      const asgn = _s.assignments[tillId];
      if (!asgn) return null;
      return _s.devices.find(d => d.id === asgn.deviceId) || null;
    },
    async save(d) {
      if (!d.id) d.id = _uid('dev');
      d.updatedAt = Date.now();
      await _db.saveDevice(d);
      const idx = _s.devices.findIndex(x => x.id === d.id);
      if (idx >= 0) _s.devices[idx] = d; else _s.devices.push(d);
      return d;
    },
    async remove(id) {
      await _db.deleteDevice(id);
      _s.devices = _s.devices.filter(d => d.id !== id);
      for (const [k, v] of Object.entries(_s.assignments)) {
        if (v.deviceId === id) { delete _s.assignments[k]; await _db.delAssignment(k); }
      }
    },
  };

  /* ── Till assignments ────────────────────────────────────────── */
  const assignments = {
    async assign(tillId, deviceId) {
      const conflict = Object.entries(_s.assignments).find(([k, v]) => v.deviceId === deviceId && k !== String(tillId));
      if (conflict) throw new Error(`Terminal already assigned to Till ${conflict[0]}`);
      const a = { id: String(tillId), tillId: String(tillId), deviceId, assignedAt: Date.now() };
      await _db.saveAssignment(a);
      _s.assignments[String(tillId)] = a;
      const dev = _s.devices.find(d => d.id === deviceId);
      if (dev) { dev.tillId = String(tillId); await _db.saveDevice(dev); }
    },
    async unassign(tillId) {
      delete _s.assignments[String(tillId)];
      await _db.delAssignment(String(tillId));
    },
  };

  /* ── Card payment engine ─────────────────────────────────────── */
  const payment = {
    async initiate(amount, tillId = '1') {
      const device = await devices.forTill(String(tillId));
      if (!device) { _toast('No card terminal assigned to this till. Go to Settings → Devices.', 'error'); return null; }
      if (device.status === STATUS.OFF || device.status === STATUS.ERR) {
        _toast(`Terminal "${device.name}" is offline. Check connection.`, 'error');
        return null;
      }

      _s.active = { id: _uid('pay'), deviceId: device.id, amount, tillId: String(tillId), status:'pending', startedAt: Date.now() };
      _openCardModal(amount, device);

      try {
        _setCardStep('connecting', `Connecting to ${device.name}...`);
        await _delay(700);
        _setCardStep('sending', `Sending KES ${amount.toFixed(2)} to terminal...`);
        await _delay(500);
        _setCardStep('waiting', 'Waiting for card — Insert / Tap / Swipe');

        let result;
        if (device.connectionMethod === CONN.BT)   result = await _runBT(device, amount);
        else if (device.connectionMethod === CONN.NET || device.connectionMethod === CONN.WIFI) result = await _runNet(device, amount);
        else if (device.connectionMethod === CONN.CLOUD) result = await _runCloud(device, amount);
        else result = await SimulatedAdapter.initiate(amount); // manual / simulated

        _s.active.status = result.status;
        _s.active.result = result;
        _setCardStep(result.status, _stepLabel(result));
        _showCardResult(result);
        return result;
      } catch (err) {
        if (_s.active) _s.active.status = 'error';
        _setCardStep('error', err.message);
        _showCardResult({ status:'error', reason: err.message });
        return { status:'error', reason: err.message };
      }
    },

    async cancel() {
      if (!_s.active) return;
      const device = _s.devices.find(d => d.id === _s.active.deviceId);
      SimulatedAdapter.cancel();
      if (device?.connectionMethod === CONN.NET || device?.connectionMethod === CONN.WIFI) {
        NetworkAdapter.cancel(device.config?.ip, device.config?.port);
      }
      if (device?.connectionMethod === CONN.CLOUD) {
        CloudAdapter.cancel(_s.active.id).catch(() => {});
      }
      _s.active.status = 'cancelled';
      _s.active = null;
      SPos?.modal?.close('card-payment-modal');
    },
  };

  async function _runBT(device, amount) {
    /* Real Bluetooth PDQ: connect to GATT server, write payment request characteristic.
       Protocol is manufacturer-specific. Falls back to simulated until SDK is integrated. */
    return SimulatedAdapter.initiate(amount);
  }

  async function _runNet(device, amount) {
    const ref = 'N' + Date.now();
    return NetworkAdapter.sendPayment(device.config?.ip, device.config?.port || 8080, {
      amount: Math.ceil(amount), currency:'KES', reference: ref,
      merchantId: device.merchantId || '', terminalId: device.terminalId || '',
    });
  }

  async function _runCloud(device, amount) {
    const ref = 'C' + Date.now();
    await CloudAdapter.initiate(device.terminalId, amount, ref);
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      await _delay(3000);
      if (_s.active?.status === 'cancelled') return { status:'cancelled', reference: ref };
      const status = await CloudAdapter.poll(ref);
      if (status.status !== 'pending') return status;
    }
    return { status:'timeout', reference: ref };
  }

  function _stepLabel(r) {
    if (r.status === 'approved')  return `Approved — ${r.cardScheme || 'Card'} ****${r.cardLast4 || '????'}`;
    if (r.status === 'declined')  return `Declined — ${r.reason || 'Try another card'}`;
    if (r.status === 'timeout')   return 'No response from terminal — please retry';
    if (r.status === 'cancelled') return 'Payment cancelled';
    return r.reason || 'Error';
  }

  /* ── Card payment modal UI ───────────────────────────────────── */
  function _openCardModal(amount, device) {
    _setText('card-pay-amount',   `KES ${amount.toFixed(2)}`);
    _setText('card-pay-terminal', device.name);
    _setCardStep('connecting', 'Initializing...');
    const res = _el('card-pay-result');
    if (res) res.style.display = 'none';
    const btn = _el('card-cancel-btn');
    if (btn) btn.style.display = '';
    SPos?.modal?.open('card-payment-modal');
  }

  function _setCardStep(step, text) {
    const icons = { connecting:'🔌', sending:'📤', waiting:'💳', processing:'⚙️', approved:'✅', declined:'❌', timeout:'⏱️', cancelled:'🚫', error:'⚠️' };
    _setText('card-pay-step-icon', icons[step] || '⏳');
    _setText('card-pay-step-text', text);
  }

  function _showCardResult(r) {
    const el  = _el('card-pay-result');
    const btn = _el('card-cancel-btn');
    if (btn) btn.style.display = 'none';
    if (!el) return;
    const color = r.status === 'approved' ? 'var(--green)' : 'var(--red)';
    if (r.status === 'approved') {
      el.innerHTML = `<div style="color:var(--green);font-size:40px;text-align:center">✅</div>
        <div style="text-align:center;font-weight:700;font-size:20px;color:var(--green)">APPROVED</div>
        <div style="text-align:center;color:var(--txt2);font-size:13px;margin-top:6px">
          Auth: <strong>${r.authCode || 'N/A'}</strong> &nbsp;|&nbsp; ${r.cardScheme || 'Card'} ****${r.cardLast4 || '????'}
        </div>
        <div style="text-align:center;margin-top:14px">
          <button class="modal-btn modal-btn-primary" onclick="SPos.modal.close('card-payment-modal')">Done</button>
        </div>`;
    } else if (r.status === 'declined') {
      el.innerHTML = `<div style="color:var(--red);font-size:40px;text-align:center">❌</div>
        <div style="text-align:center;font-weight:700;font-size:20px;color:var(--red)">DECLINED</div>
        <div style="text-align:center;color:var(--txt2);font-size:13px;margin-top:6px">${r.reason || 'Payment declined by bank'}</div>
        <div style="text-align:center;margin-top:14px">
          <button class="modal-btn modal-btn-ghost" onclick="SPos.modal.close('card-payment-modal')">Close</button>
          <button class="modal-btn modal-btn-primary" onclick="SPos.modal.close('card-payment-modal');SPos.payment.process()">Retry</button>
        </div>`;
    } else {
      el.innerHTML = `<div style="font-size:40px;text-align:center">⏱️</div>
        <div style="text-align:center;font-weight:700;font-size:18px">${r.status === 'timeout' ? 'TIMEOUT' : 'ERROR'}</div>
        <div style="text-align:center;color:var(--txt2);font-size:13px;margin-top:6px">${r.reason || 'No response from terminal'}</div>
        <div style="text-align:center;margin-top:14px">
          <button class="modal-btn modal-btn-ghost" onclick="SPos.modal.close('card-payment-modal')">Cancel</button>
          <button class="modal-btn modal-btn-primary" onclick="SPos.modal.close('card-payment-modal');SPos.payment.process()">Retry</button>
        </div>`;
    }
    el.style.display = '';
  }

  /* ── Terminal status bar ─────────────────────────────────────── */
  function _refreshStatusBar() {
    const bar = _el('terminal-status-bar');
    if (!bar) return;
    const pdqs = _s.devices.filter(d => d.type === TYPE.PDQ);
    if (!pdqs.length) { bar.style.display = 'none'; return; }
    bar.style.display = 'flex';
    bar.innerHTML = pdqs.map(d => {
      const c = STATUS_CLR[d.status] || '#888';
      return `<span style="display:flex;align-items:center;gap:4px;font-size:11px;padding:2px 8px;border-radius:20px;background:${c}18;color:${c};border:1px solid ${c}33">
        <span style="width:7px;height:7px;border-radius:50%;background:${c};flex-shrink:0"></span>
        ${d.name}</span>`;
    }).join('');
  }

  /* ── Monitor ─────────────────────────────────────────────────── */
  const monitor = {
    start() {
      if (_s.monInterval) return;
      _s.monInterval = setInterval(() => monitor.tick(), 30000);
    },
    stop()  { clearInterval(_s.monInterval); _s.monInterval = null; },
    async tick() {
      for (const d of _s.devices.filter(x => x.type === TYPE.PDQ)) {
        const was = d.status;
        const alive = await monitor.ping(d);
        if (alive) { d.status = STATUS.ON; d.lastSeen = Date.now(); }
        else if (d.status === STATUS.ON) d.status = STATUS.OFF;
        if (d.status !== was) { await _db.saveDevice(d); ui._updateDeviceRow(d); }
      }
      _refreshStatusBar();
    },
    async ping(d) {
      if (d.connectionMethod === CONN.NET || d.connectionMethod === CONN.WIFI) {
        return !!(await NetworkAdapter.probe(d.config?.ip, d.config?.port));
      }
      if (d.connectionMethod === CONN.SIM || d.connectionMethod === CONN.MANUAL) {
        return d.status === STATUS.ON;
      }
      return d.status === STATUS.ON;
    },
  };

  /* ── Offline transaction queue ───────────────────────────────── */
  const queue = {
    async enqueue(payload) {
      const q = { id: _uid('q'), ...payload, status:'pending', retries:0, enqueuedAt: Date.now() };
      await _db.saveQueue(q);
      return q;
    },
    async flush() {
      const items = (await _db.allQueue()).filter(i => i.status === 'pending' && i.retries < 5);
      for (const item of items) {
        try {
          if (typeof SPos?.sync?.run === 'function') await SPos.sync.run();
          item.status = 'synced';
        } catch {
          item.retries++;
          item.lastAttempt = Date.now();
        }
        await _db.saveQueue(item);
      }
    },
    async reconcile() {
      const txns = await PosDB.transactions.getAll();
      const unsynced = txns.filter(t => !t.synced && t.status === 'completed' && t.paymentMethod === 'card');
      for (const t of unsynced) await queue.enqueue({ type:'card_transaction', txId: t.id });
    },
  };

  /* ── Pairing wizard ──────────────────────────────────────────── */
  const wizard = {
    open() {
      _s.wiz = { step:0, data:{} };
      wizard._render();
      SPos?.modal?.open('terminal-wizard-modal');
    },
    _render() {
      const body = _el('terminal-wizard-body');
      if (!body) return;
      const steps = [wizard._s0, wizard._s1, wizard._s2, wizard._s3, wizard._s4];
      body.innerHTML = (steps[_s.wiz.step] || (() => ''))();
    },
    _next(data = {}) { Object.assign(_s.wiz.data, data); _s.wiz.step++; wizard._render(); },
    _back()          { if (_s.wiz.step > 0) { _s.wiz.step--; wizard._render(); } },

    /* Step 0 — device type */
    _s0() {
      const opts = [['pdq','💳','Card Terminal (PDQ)'],['printer','🖨️','Receipt Printer'],['scanner','📷','Barcode Scanner'],['label','🏷️','Label Printer'],['cash_drawer','🗄️','Cash Drawer']];
      return `<div class="wiz-step">
        <div class="wiz-label">SELECT DEVICE TYPE</div>
        <div class="terminal-type-grid">
          ${opts.map(([t,i,n]) => `<div class="terminal-type-card" onclick="PosTerminals.wizard._next({type:'${t}'})">
            <div style="font-size:32px">${i}</div><div style="font-size:13px;font-weight:600;margin-top:6px">${n}</div>
          </div>`).join('')}
        </div></div>`;
    },

    /* Step 1 — connection method */
    _s1() {
      const t = _s.wiz.data.type;
      const all = [['bluetooth','🔵','Bluetooth'],['wifi','📶','Wi-Fi'],['network','🌐','Network / Ethernet'],['cloud','☁️','Cloud Provider'],['manual','✏️','Manual Registration'],['simulated','🧪','Simulated (Testing)']];
      const pdqOnly = all;
      const other   = [['bluetooth','🔵','Bluetooth'],['network','🌐','Network / USB'],['manual','✏️','Manual']];
      const opts = t === 'pdq' ? pdqOnly : other;
      return `<div class="wiz-step">
        <div class="wiz-label">CONNECTION METHOD</div>
        <div class="terminal-type-grid">
          ${opts.map(([m,i,n]) => `<div class="terminal-type-card" onclick="PosTerminals.wizard._next({connectionMethod:'${m}'})">
            <div style="font-size:28px">${i}</div><div style="font-size:12px;font-weight:600;margin-top:6px">${n}</div>
          </div>`).join('')}
        </div>
        <div style="margin-top:14px;text-align:center"><button class="modal-btn modal-btn-ghost" onclick="PosTerminals.wizard._back()">← Back</button></div>
      </div>`;
    },

    /* Step 2 — discovery / config */
    _s2() {
      const m = _s.wiz.data.connectionMethod;
      if (m === 'bluetooth') return wizard._btStep();
      if (m === 'network' || m === 'wifi') return wizard._netStep();
      if (m === 'cloud')     return wizard._cloudStep();
      if (m === 'simulated') { wizard._addSimulated(); return '<div style="text-align:center;padding:20px">⏳ Adding simulated terminal...</div>'; }
      return wizard._manualStep();
    },

    _btStep() {
      return `<div class="wiz-step">
        <div class="wiz-label">BLUETOOTH DISCOVERY</div>
        <p style="font-size:13px;color:var(--txt2)">Your browser will open a device picker. Select your PDQ terminal from the list.</p>
        <button class="modal-btn modal-btn-primary" style="width:100%;margin-top:12px" onclick="PosTerminals.wizard._scanBT()">🔵 Scan for Devices</button>
        <div id="bt-result" style="margin-top:12px"></div>
        <div style="margin-top:14px;text-align:center"><button class="modal-btn modal-btn-ghost" onclick="PosTerminals.wizard._back()">← Back</button></div>
      </div>`;
    },

    _netStep() {
      return `<div class="wiz-step">
        <div class="wiz-label">NETWORK TERMINAL</div>
        <div class="wiz-field"><div class="wiz-label">IP ADDRESS</div><input class="wiz-input" id="wiz-net-ip" placeholder="192.168.1.100" type="text"></div>
        <div class="wiz-field"><div class="wiz-label">PORT (default 8080)</div><input class="wiz-input" id="wiz-net-port" placeholder="8080" type="number" value="8080"></div>
        <button class="modal-btn modal-btn-primary" style="width:100%;margin-top:12px" onclick="PosTerminals.wizard._testNet()">Test Connection</button>
        <div id="net-result" style="margin-top:8px;font-size:13px"></div>
        <div style="margin-top:14px;text-align:center"><button class="modal-btn modal-btn-ghost" onclick="PosTerminals.wizard._back()">← Back</button></div>
      </div>`;
    },

    _cloudStep() {
      return `<div class="wiz-step">
        <div class="wiz-label">CLOUD PROVIDER</div>
        <div class="wiz-field"><div class="wiz-label">TERMINAL ID / SERIAL</div><input class="wiz-input" id="wiz-cloud-tid" placeholder="e.g. VFI123456789"></div>
        <div class="wiz-field"><div class="wiz-label">MERCHANT ID</div><input class="wiz-input" id="wiz-cloud-mid" placeholder="Provided by your acquiring bank"></div>
        <div class="wiz-field"><div class="wiz-label">ACQUIRING BANK / PROVIDER</div>
          <select class="wiz-input" id="wiz-cloud-prov">
            <option value="equity">Equity Bank</option>
            <option value="kcb">KCB</option>
            <option value="coop">Co-operative Bank</option>
            <option value="ncba">NCBA</option>
            <option value="absa">Absa Kenya</option>
            <option value="dpo">DPO Group</option>
            <option value="pesalink">Pesalink</option>
            <option value="custom">Custom / Other</option>
          </select>
        </div>
        <button class="modal-btn modal-btn-primary" style="width:100%;margin-top:12px" onclick="PosTerminals.wizard._next({terminalId:document.getElementById('wiz-cloud-tid').value,merchantId:document.getElementById('wiz-cloud-mid').value,provider:document.getElementById('wiz-cloud-prov').value})">Continue →</button>
        <div style="margin-top:14px;text-align:center"><button class="modal-btn modal-btn-ghost" onclick="PosTerminals.wizard._back()">← Back</button></div>
      </div>`;
    },

    _manualStep() {
      return `<div class="wiz-step">
        <div class="wiz-label">MANUAL REGISTRATION</div>
        <div class="wiz-field"><div class="wiz-label">SERIAL NUMBER / TID</div><input class="wiz-input" id="wiz-man-serial" placeholder="e.g. PAX-A920-123456"></div>
        <div class="wiz-field"><div class="wiz-label">MANUFACTURER</div>
          <select class="wiz-input" id="wiz-man-mfr">
            <option>Verifone</option><option>Ingenico</option><option>PAX</option><option>Castles</option><option>Newland</option><option>Other</option>
          </select>
        </div>
        <button class="modal-btn modal-btn-primary" style="width:100%;margin-top:12px" onclick="PosTerminals.wizard._next({serialNumber:_el('wiz-man-serial').value,manufacturer:_el('wiz-man-mfr').value})">Continue →</button>
        <div style="margin-top:14px;text-align:center"><button class="modal-btn modal-btn-ghost" onclick="PosTerminals.wizard._back()">← Back</button></div>
      </div>`;
    },

    /* Step 3 — name & assign */
    _s3() {
      return `<div class="wiz-step">
        <div class="wiz-label">NAME &amp; ASSIGN</div>
        <div class="wiz-field"><div class="wiz-label">DEVICE NAME *</div><input class="wiz-input" id="wiz-dev-name" placeholder="e.g. Till 1 Terminal"></div>
        <div class="wiz-field"><div class="wiz-label">BRANCH</div><input class="wiz-input" id="wiz-dev-branch" placeholder="Main Branch"></div>
        <div class="wiz-field"><div class="wiz-label">ASSIGN TO TILL</div>
          <select class="wiz-input" id="wiz-dev-till">
            ${Array.from({length:20},(_,i)=>`<option value="${i+1}">Till ${i+1}</option>`).join('')}
          </select>
        </div>
        <button class="modal-btn modal-btn-primary" style="width:100%;margin-top:16px" onclick="PosTerminals.wizard._save()">✓ Save Device</button>
        <div style="margin-top:14px;text-align:center"><button class="modal-btn modal-btn-ghost" onclick="PosTerminals.wizard._back()">← Back</button></div>
      </div>`;
    },

    /* Step 4 — success */
    _s4() {
      const d = _s.wiz.data;
      return `<div class="wiz-step" style="text-align:center;padding:24px 0">
        <div style="font-size:56px">✅</div>
        <div style="font-weight:700;font-size:18px;margin-top:14px">${d.name || 'Device'} Added</div>
        <div style="color:var(--txt2);font-size:13px;margin-top:6px">Till ${d.tillId || '?'} · ${d.branch || 'Main Branch'}</div>
        <div style="color:var(--txt2);font-size:12px;margin-top:4px">${CONN_ICONS[d.connectionMethod] || '🔌'} ${d.connectionMethod}</div>
        <button class="modal-btn modal-btn-primary" style="margin-top:24px;min-width:140px"
          onclick="SPos.modal.close('terminal-wizard-modal');PosTerminals.ui.renderDeviceHub('devices-hub-body')">Done</button>
      </div>`;
    },

    async _scanBT() {
      const el = _el('bt-result');
      if (!el) return;
      if (!BluetoothAdapter.supported()) {
        el.innerHTML = '<span style="color:var(--red)">Bluetooth not supported here. Try Chrome on Android or Windows.</span>';
        return;
      }
      el.innerHTML = '<span style="color:var(--txt2)">Opening device picker…</span>';
      try {
        const btDev = await BluetoothAdapter.discover();
        _s.wiz.data.btDevice = btDev;
        el.innerHTML = `<div style="padding:10px;background:var(--card);border-radius:8px;font-size:13px">
          Found: <strong>${btDev.name || 'Unknown Device'}</strong>
          <button class="modal-btn modal-btn-primary" style="margin-top:10px;width:100%"
            onclick="PosTerminals.wizard._next({serialNumber:'${btDev.id}',btName:'${btDev.name||''}'})">Select This Device →</button>
        </div>`;
      } catch (e) {
        el.innerHTML = '<span style="color:var(--red);font-size:13px"></span>';
        el.firstChild.textContent = e.name === 'NotFoundError' ? 'No device selected.' : (e.message || 'Bluetooth error');
      }
    },

    async _testNet() {
      const ip   = (_el('wiz-net-ip')?.value || '').trim();
      const port = parseInt(_el('wiz-net-port')?.value) || 8080;
      const el   = _el('net-result');
      if (!ip) { if (el) el.textContent = 'Enter an IP address first'; return; }
      if (el) el.innerHTML = '<span style="color:var(--txt2)">Testing…</span>';
      const info = await NetworkAdapter.probe(ip, port);
      if (info) {
        if (el) el.innerHTML = `<span style="color:var(--green)">✅ Connected — ${info.model||'Terminal'} (${info.firmware||''})</span>`;
        wizard._next({ ip, port, networkInfo: info });
      } else {
        if (el) el.innerHTML = `<span style="color:var(--red)">❌ Cannot reach ${ip}:${port} — check IP, port, and network</span>`;
      }
    },

    async _save() {
      const name   = (_el('wiz-dev-name')?.value  || '').trim();
      const branch = (_el('wiz-dev-branch')?.value || 'Main Branch').trim();
      const tillId = _el('wiz-dev-till')?.value   || '1';
      if (!name) { _toast('Enter a device name', 'error'); return; }

      const device = {
        name, branch, tillId,
        type:             _s.wiz.data.type            || TYPE.PDQ,
        connectionMethod: _s.wiz.data.connectionMethod || CONN.MANUAL,
        serialNumber:     _s.wiz.data.serialNumber     || '',
        manufacturer:     _s.wiz.data.manufacturer     || _s.wiz.data.btName || '',
        terminalId:       _s.wiz.data.terminalId       || '',
        merchantId:       _s.wiz.data.merchantId       || '',
        provider:         _s.wiz.data.provider         || '',
        status:           STATUS.ON,
        lastSeen:         Date.now(),
        batteryLevel:     null,
        config: { ip: _s.wiz.data.ip || '', port: _s.wiz.data.port || 8080 },
      };

      await devices.save(device);
      try { await assignments.assign(tillId, device.id); }
      catch (e) { _toast(e.message, 'error'); return; }

      wizard._next({ name, tillId, branch, connectionMethod: device.connectionMethod });
      _refreshStatusBar();
    },

    async _addSimulated() {
      const device = {
        name:'Simulated Terminal', branch:'Main Branch', tillId:'1',
        type: TYPE.PDQ, connectionMethod: CONN.SIM,
        serialNumber:'SIM-001', manufacturer:'Sokoni Test',
        terminalId:'SIM-001', merchantId:'TEST-MERCHANT', provider:'simulated',
        status: STATUS.ON, lastSeen: Date.now(), batteryLevel:100,
        config:{},
      };
      await devices.save(device);
      try { await assignments.assign('1', device.id); } catch { /* already assigned */ }
      _s.wiz.step = 4;
      _s.wiz.data = { name: device.name, tillId:'1', branch:'Main Branch', connectionMethod: CONN.SIM };
      wizard._render();
      _refreshStatusBar();
    },
  };

  /* ── Device Hub UI ───────────────────────────────────────────── */
  const ui = {
    async renderDeviceHub(containerId = 'devices-hub-body') {
      const container = _el(containerId);
      if (!container) return;
      await _loadAll();

      if (!_s.devices.length) {
        container.innerHTML = `<div class="pos-empty" style="padding:40px 20px">
          <div class="empty-icon">💳</div>
          <p style="margin-bottom:12px">No devices paired yet</p>
          <button class="modal-btn modal-btn-primary" onclick="PosTerminals.wizard.open()">+ Pair First Terminal</button>
        </div>`;
        return;
      }

      container.innerHTML = `
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px">
          <button class="modal-btn modal-btn-primary" onclick="PosTerminals.wizard.open()">+ Pair New Device</button>
          <button class="inv-btn inv-btn-outline" onclick="PosTerminals.monitor.tick().then(()=>PosTerminals.ui.renderDeviceHub())">↻ Refresh Status</button>
        </div>
        <div id="device-list-grid">${_s.devices.map(d => ui._card(d)).join('')}</div>`;
      _refreshStatusBar();
    },

    _card(d) {
      const sc = STATUS_CLR[d.status] || '#888';
      const ti = TYPE_ICONS[d.type]   || '📱';
      const ci = CONN_ICONS[d.connectionMethod] || '🔌';
      const ls = d.lastSeen ? new Date(d.lastSeen).toLocaleString() : 'Never';
      const tills = Object.entries(_s.assignments).filter(([,v])=>v.deviceId===d.id).map(([k])=>k).join(', ') || '—';
      return `<div id="dev-row-${d.id}" style="background:var(--card);border-radius:12px;padding:16px;margin-bottom:10px;border:1px solid var(--border)">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
          <div style="display:flex;align-items:center;gap:10px">
            <span style="font-size:28px">${ti}</span>
            <div>
              <div style="font-weight:700;font-size:14px">${d.name}</div>
              <div style="font-size:11px;color:var(--txt2)">${d.manufacturer||''} ${ci} ${d.connectionMethod}</div>
            </div>
          </div>
          <div style="text-align:right">
            <span class="dev-status" style="padding:3px 10px;border-radius:20px;font-size:11px;font-weight:700;background:${sc}20;color:${sc};border:1px solid ${sc}40">${d.status.toUpperCase()}</span>
            ${d.batteryLevel!=null?`<div style="font-size:11px;color:var(--txt2);margin-top:2px">🔋 ${d.batteryLevel}%</div>`:''}
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;font-size:12px;color:var(--txt2)">
          <div>Branch: <strong>${d.branch||'Main'}</strong></div>
          <div>Till: <strong>${tills}</strong></div>
          <div>Serial: <strong style="font-family:monospace">${(d.serialNumber||'N/A').slice(0,18)}</strong></div>
          <div>Last seen: <strong>${ls}</strong></div>
          ${d.connectionMethod===CONN.NET||d.connectionMethod===CONN.WIFI?`<div>IP: <strong>${d.config?.ip||'—'}</strong></div>`:''}
          ${d.provider?`<div>Provider: <strong>${d.provider}</strong></div>`:''}
        </div>
        <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
          ${d.type===TYPE.PDQ?`<button class="inv-btn inv-btn-green" style="font-size:12px" onclick="PosTerminals._testPay('${d.id}')">Test Payment</button>`:''}
          <button class="inv-btn inv-btn-outline" style="font-size:12px" onclick="PosTerminals._reassign('${d.id}')">Reassign Till</button>
          <button class="inv-btn" style="font-size:12px;background:var(--red-light,#fee2e2);color:var(--red,#ef4444);border-color:transparent" onclick="PosTerminals._remove('${d.id}')">Remove</button>
        </div>
      </div>`;
    },

    _updateDeviceRow(d) {
      const row = _el(`dev-row-${d.id}`);
      if (!row) return;
      const badge = row.querySelector('.dev-status');
      if (badge) {
        const sc = STATUS_CLR[d.status] || '#888';
        badge.textContent = d.status.toUpperCase();
        badge.style.color = sc;
        badge.style.background = sc + '20';
        badge.style.borderColor = sc + '40';
      }
    },
  };

  /* ── Public utility functions ────────────────────────────────── */
  async function _testPay(deviceId) {
    const device = _s.devices.find(d => d.id === deviceId);
    if (!device) return;
    _openCardModal(1.00, device);
    _setCardStep('waiting', 'TEST — Waiting for card…');
    const result = await SimulatedAdapter.initiate(1.00);
    _setCardStep(result.status, _stepLabel(result));
    _showCardResult(result);
  }

  async function _reassign(deviceId) {
    /* Use POS modal instead of window.prompt */
    const device = _s.devices.find(d => d.id === deviceId);
    const current = Object.entries(_s.assignments).find(([, a]) => a.deviceId === deviceId)?.[0] || '1';
    _showReassignModal(deviceId, device?.name || 'Terminal', current);
  }

  function _showReassignModal(deviceId, deviceName, currentTill) {
    const modalId = 'pos-reassign-modal';
    let m = document.getElementById(modalId);
    if (!m) {
      m = document.createElement('div');
      m.id = modalId;
      m.className = 'modal-overlay';
      m.innerHTML = `<div class="modal-box" style="max-width:340px">
        <div class="modal-title" id="_rm_title"></div>
        <div style="margin:14px 0 8px;font-size:12px;color:rgba(255,255,255,.45)">Till number (1–20)</div>
        <input id="_rm_till" type="number" min="1" max="20" class="pos-input"
               style="width:100%;margin-bottom:16px;font-size:16px;padding:10px 14px;border-radius:10px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);color:white;outline:none;">
        <div style="display:flex;gap:10px">
          <button class="pos-action-btn" style="flex:1;background:#222;border:1px solid rgba(255,255,255,.1)"
                  onclick="document.getElementById('${modalId}').classList.remove('open')">Cancel</button>
          <button class="pos-action-btn" style="flex:1;background:rgba(0,153,255,.2);border:1px solid rgba(0,153,255,.35)"
                  onclick="window._doReassign('${deviceId}','${modalId}')">Reassign</button>
        </div>
      </div>`;
      document.body.appendChild(m);
    }
    document.getElementById('_rm_title').textContent = `Reassign ${deviceName}`;
    document.getElementById('_rm_till').value = currentTill;
    m.classList.add('open');
  }

  window._doReassign = async function(deviceId, modalId) {
    const tillVal = document.getElementById('_rm_till')?.value;
    const till = parseInt(tillVal, 10);
    if (!tillVal || isNaN(till) || till < 1 || till > 20) {
      _toast('Enter a till number between 1 and 20', 'error'); return;
    }
    document.getElementById(modalId)?.classList.remove('open');
    try {
      await assignments.assign(String(till), deviceId);
      _toast(`Terminal reassigned to Till ${till}`, 'success');
      ui.renderDeviceHub('devices-hub-body');
    } catch (e) { _toast(e.message, 'error'); }
  };

  async function _remove(deviceId) {
    /* Use POS modal instead of window.confirm */
    const device = _s.devices.find(d => d.id === deviceId);
    _showRemoveConfirm(deviceId, device?.name || 'Terminal');
  }

  function _showRemoveConfirm(deviceId, deviceName) {
    const modalId = 'pos-remove-modal';
    let m = document.getElementById(modalId);
    if (!m) {
      m = document.createElement('div');
      m.id = modalId;
      m.className = 'modal-overlay';
      m.innerHTML = `<div class="modal-box" style="max-width:320px;text-align:center">
        <div class="modal-title" id="_del_title"></div>
        <p style="font-size:13px;color:rgba(255,255,255,.5);margin:12px 0 20px">
          This device will be unpaired. This cannot be undone.</p>
        <div style="display:flex;gap:10px">
          <button class="pos-action-btn" style="flex:1;background:#222;border:1px solid rgba(255,255,255,.1)"
                  onclick="document.getElementById('${modalId}').classList.remove('open')">Cancel</button>
          <button class="pos-action-btn" style="flex:1;background:rgba(255,50,50,.15);border:1px solid rgba(255,50,50,.3);color:#ff6666"
                  onclick="window._doRemove('${deviceId}','${modalId}')">Remove</button>
        </div>
      </div>`;
      document.body.appendChild(m);
    }
    document.getElementById('_del_title').textContent = `Remove ${deviceName}?`;
    m.classList.add('open');
  }

  window._doRemove = async function(deviceId, modalId) {
    document.getElementById(modalId)?.classList.remove('open');
    await devices.remove(deviceId);
    _toast('Device removed', 'info');
    ui.renderDeviceHub('devices-hub-body');
    _refreshStatusBar();
  };

  /* ── Load all data ───────────────────────────────────────────── */
  async function _loadAll() {
    _s.devices     = await _db.allDevices();
    const asgns    = await _db.allAssignments();
    _s.assignments = Object.fromEntries(asgns.map(a => [a.tillId, a]));
  }

  /* ── Init ────────────────────────────────────────────────────── */
  async function init() {
    await _loadAll();
    monitor.start();
    _refreshStatusBar();
    window.addEventListener('online', () => queue.flush());
  }

  /* expose _el for inline onclick in wizard steps */
  window._el = _el;

  return { init, devices, assignments, payment, queue, monitor, wizard, ui, _testPay, _reassign, _remove };
})();
