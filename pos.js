/* SOKONI SmartPOS — Main Controller v1.0
   Orchestrates: Setup wizard, Checkout, Inventory, Reports,
   Customers, Cashiers, Shifts, M-PESA, Printing, Offline sync. */

'use strict';

const SPos = (function () {

  /* ═══════════════════════════════════════════════════════════
     STATE
  ═══════════════════════════════════════════════════════════ */
  const state = {
    ready:        false,
    currentTab:   'pos',
    currentCashier: null,
    currentShift:   null,
    currentCustomer:null,
    cartItems:    [],
    heldCarts:    [],
    discountType: 'pct',  // 'pct' | 'amt'
    discountVal:  0,
    payMethod:    'cash',
    numpadStr:    '0',
    settings:     {},
    allProducts:  [],
    categoryFilter: '',
    productSearch:  '',
    wizardStep:    1,
    scannerForField: null,  // field ID to populate from scan
    mpesaPollTimer: null,
    mpesaCheckoutId: null,
    invTab:        'products',
  };

  /* ═══════════════════════════════════════════════════════════
     BOOT
  ═══════════════════════════════════════════════════════════ */
  async function boot() {
    try {
      await PosDB.init();
      state.settings = await PosDB.settings.getAll();

      /* Seed defaults if first run */
      await PosDB.categories.seedDefaults();

      const isSetup = state.settings.setupComplete === true || state.settings.setupComplete === 'true';
      if (isSetup) {
        await launchApp();
      } else {
        document.getElementById('pos-wizard').style.display = 'flex';
      }

      /* Init barcode scanner (hardware interceptor always on) */
      await PosBarcode.init();
      PosBarcode.setCallback(handleBarcodeGlobal);

      /* Clock */
      setInterval(updateClock, 1000);
      updateClock();

      /* Online/offline watcher */
      window.addEventListener('online',  () => updateOnlineStatus(true));
      window.addEventListener('offline', () => updateOnlineStatus(false));
      updateOnlineStatus(navigator.onLine);

      /* Background sync every 2 min */
      setInterval(() => sync.run(true), 120000);

    } catch (e) {
      console.error('[SmartPOS] Boot error:', e);
      const _errDiv = document.createElement('div');
      _errDiv.style.cssText = 'color:red;padding:40px;font-family:monospace';
      _errDiv.textContent = 'SmartPOS boot error: ' + (e.message || 'Unknown error');
      document.body.innerHTML = '';
      document.body.appendChild(_errDiv);
    }
  }

  async function launchApp() {
    state.settings = await PosDB.settings.getAll();
    const wiz = document.getElementById('pos-wizard');
    wiz.style.transition = 'opacity 0.18s ease';
    wiz.style.opacity = '0';
    wiz.style.pointerEvents = 'none';
    setTimeout(() => { wiz.style.display = 'none'; }, 190);
    document.getElementById('pos-app').classList.remove('hidden');

    /* Populate header */
    _setVal('hdr-biz-name', state.settings.bizName || 'SOKONI SmartPOS');

    /* Load products */
    await products.reload();

    /* Sync the merchant's CANONICAL products into the POS. The POS store was fed only by the
       separate `posProducts` collection, so a shop whose products live in the canonical
       `products` collection (marketplace / seller dashboard) showed a BLANK POS. Non-blocking;
       re-render once seeded. */
    _seedCatalogueFromCanonical().then(n => { if (n > 0) products.reload(); }).catch(() => {});

    /* Load category chips */
    await ui.loadCategories();

    /* Init BOS modules */
    if (window.PosBoss) {
      PosBoss.branch.init(state.settings);
    }

    /* Sync merchant branding into the Unified Print Engine */
    if (window.SokoniPrint) {
      SokoniPrint.setBrand({
        businessName:    state.settings.bizName,
        businessAddress: state.settings.bizAddress,
        businessPhone:   state.settings.bizPhone,
        businessPin:     state.settings.bizPin,
        logoUrl:         state.settings.logoUrl || '',
        receiptFooter:   state.settings.receiptFooter || 'Thank you for shopping with us!',
        paperWidth:      parseInt(state.settings.paperWidth) || 80,
        website:         state.settings.website || 'mysokoni.co.ke',
      });
    }

    /* Boot new modules */
    if (window.PosPlugins) {
      PosPlugins.installBuiltins();
      await PosPlugins.restoreEnabled();
    }
    if (window.PosNotify) {
      await PosNotify.requestPermission().catch(() => {});
    }
    if (window.PosOmni && state.settings.bizPin) {
      PosOmni.startSync(state.settings.bizPin);
    }

    /* Cashier login. Restore a still-valid session first so POS does NOT re-prompt for the
       PIN on every reload/navigation (the session lived only in memory before, so each page
       load reset it). The PIN still gates the FIRST login and switching cashiers; the
       separate manager-PIN still gates refunds/voids/discounts. Only prompt if nothing valid
       was restored. */
    const cashiers = await PosDB.cashiers.getAll();
    if (cashiers.length > 0) {
      const restored = await cashier.restoreSession(cashiers);
      if (!restored) cashier.showSwitchDialog();
    }

    /* Load settings into settings panel */
    settings.loadIntoForm();

    /* Bind POS to the signed-in SOKONI account: reflect the owner in the header
       pill (instead of a dead "Login"), seed a blank business profile from their
       account so receipts/branding match, and prefill the settings form. All
       non-destructive and offline-safe. */
    try {
      profile.reflectInHeader();
      await profile.seedBusinessDefaults();
      profile.syncBusinessProfile({ persist: false });
    } catch (e) { console.warn('[SmartPOS] profile bind skipped:', e && e.message); }

    /* Check pending sync */
    sync.run(true);

    /* Seed bell badge with initial low-stock count */
    PosDB.products.getLowStock().then(low => {
      const badge = document.getElementById('notify-badge');
      if (badge && low.length > 0) {
        badge.textContent = low.length > 9 ? '9+' : low.length;
        badge.style.display = 'flex';
      }
    }).catch(() => {});

    /* Boot mobile controller (phone-first UI) */
    if (window.PosMobile) PosMobile.init();

    /* Boot terminal management */
    if (window.PosTerminals) await PosTerminals.init();

    /* Wire the navigation service: URL-hash deep-linking + Back/Forward. */
    nav.init();

    state.ready = true;
    if (window.PosPlugins) PosPlugins.emit('boot:after', { settings: state.settings });
  }

  /* ═══════════════════════════════════════════════════════════
     WIZARD
  ═══════════════════════════════════════════════════════════ */
  const wizard = {
    next() {
      /* Validate step 1 */
      if (state.wizardStep === 1) {
        const name = _v('biz-name').trim();
        const type = _v('biz-type');
        if (!name || !type) { toast('Please fill in business name and type', 'error'); return; }
      }
      state.wizardStep++;
      wizard.showStep(state.wizardStep);
    },

    skip() {
      state.wizardStep++;
      wizard.showStep(state.wizardStep);
    },

    showStep(n) {
      document.querySelectorAll('.wizard-panel').forEach(p => p.classList.remove('active'));
      document.querySelectorAll('.wizard-step').forEach((s, i) => {
        s.classList.toggle('done',   i < n - 1);
        s.classList.toggle('active', i === n - 1);
      });
      const panel = document.getElementById(`wpanel-${n}`);
      if (panel) panel.classList.add('active');
      if (n === 3) wizard._markPrinterSupport();
    },

    _markPrinterSupport() {
      const btBtn  = document.getElementById('wiz-printer-bt');
      const usbBtn = document.getElementById('wiz-printer-usb');
      if (btBtn && !navigator.bluetooth) {
        btBtn.style.opacity = '0.4';
        btBtn.title = 'Requires Chrome on Android';
        const lbl = document.getElementById('wiz-bt-note');
        if (lbl) lbl.textContent = 'Chrome Android only';
      }
      if (usbBtn && !navigator.usb) {
        usbBtn.style.opacity = '0.4';
        usbBtn.title = 'Requires Chrome on desktop';
        const lbl = document.getElementById('wiz-usb-note');
        if (lbl) lbl.textContent = 'Chrome desktop only';
      }
    },

    onMpesaTypeChange(val) {
      document.getElementById('mpesa-account-row').style.display = val === 'paybill' ? 'block' : 'none';
    },

    async verifyMpesa() {
      const ck         = _v('mpesa-ck').trim();
      const cs         = _v('mpesa-cs').trim();
      const passkey    = _v('mpesa-passkey').trim();
      const shortcode  = _v('mpesa-shortcode').trim();
      const type       = _v('mpesa-type');

      if (!ck || !cs || !passkey || !shortcode) {
        toast('Please fill in all M-PESA fields', 'error');
        return;
      }

      const btn = document.getElementById('mpesa-verify-btn');
      btn.disabled = true;
      btn.textContent = 'Verifying...';

      try {
        /* Save credentials via Cloud Function for verification */
        const saved = await mpesa.saveCredentials({ ck, cs, passkey, shortcode, type });
        if (saved) {
          toast('M-PESA connected successfully!', 'success');
          await PosDB.settings.setMany({ mpesaConfigured: true, mpesaShortcode: shortcode, mpesaType: type });
          state.wizardStep++;
          wizard.showStep(state.wizardStep);
        }
      } catch (e) {
        toast('Verification failed: ' + e.message, 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = 'Verify & Connect';
      }
    },

    async connectPrinter(type) {
      const statusEl = document.getElementById('printer-status');

      if (type === 'network') {
        document.getElementById('printer-network-row').style.display = 'block';
        return;
      }

      if (type === 'bluetooth' && !navigator.bluetooth) {
        statusEl.style.color = 'var(--amber)';
        statusEl.textContent = '⚠ Bluetooth not available here — use Chrome on Android. Network or Browser print works on any device.';
        return;
      }
      if (type === 'usb' && !navigator.usb) {
        statusEl.style.color = 'var(--amber)';
        statusEl.textContent = '⚠ USB not available here — use Chrome on desktop. Network or Browser print works on any device.';
        return;
      }

      statusEl.style.color = 'var(--txt2)';
      statusEl.textContent = 'Connecting...';
      try {
        let name;
        if (type === 'bluetooth') name = await PosPrinter.connectBluetooth();
        else if (type === 'usb')  name = await PosPrinter.connectUSB();
        else                      name = PosPrinter.connectBrowser();

        await PosDB.settings.set('printerType', type);
        statusEl.style.color = 'var(--green)';
        statusEl.textContent = '✓ Connected: ' + name;
        toast('Printer connected: ' + name, 'success');
      } catch (e) {
        statusEl.style.color = 'var(--red)';
        statusEl.textContent = '✗ ' + e.message;
      }
    },

    async connectPrinterNetwork() {
      const host = _v('printer-ip').trim();
      const port = parseInt(_v('printer-port')) || 9100;
      if (!host) { toast('Enter printer IP address', 'error'); return; }
      const name = await PosPrinter.connectNetwork(host, port);
      await PosDB.settings.setMany({ printerType: 'network', printerIp: host, printerPort: port });
      document.getElementById('printer-status').textContent = '✓ Network printer: ' + name;
      document.getElementById('printer-status').style.color = 'var(--green)';
    },

    async testAndNext() {
      const paperW = parseInt(_v('paper-width')) || 58;
      PosPrinter.setPaperWidth(paperW);
      await PosDB.settings.set('paperWidth', paperW);

      try {
        await PosPrinter.testPrint({ businessName: _v('biz-name') || 'SOKONI SmartPOS' });
      } catch (_) { /* browser fallback already shows window */ }

      state.wizardStep++;
      wizard.showStep(state.wizardStep);
    },

    async createCashier() {
      const name = _v('cashier-name').trim();
      const pin  = _v('cashier-pin').trim();
      const pin2 = _v('cashier-pin2').trim();

      if (!name)      { toast('Enter your name', 'error'); return; }
      if (pin.length !== 4 || !/^\d{4}$/.test(pin)) { toast('PIN must be exactly 4 digits', 'error'); return; }
      if (pin !== pin2) { toast('PINs do not match', 'error'); return; }

      await PosDB.cashiers.save({ name, pin, role: 'admin', active: true, createdAt: Date.now() });

      /* Save all wizard settings */
      await PosDB.settings.setMany({
        bizName:       _v('biz-name').trim(),
        bizType:       _v('biz-type'),
        bizCounty:     _v('biz-county'),
        bizAddress:    _v('biz-address').trim(),
        bizPhone:      _v('biz-phone').trim(),
        bizPin:        _v('biz-pin').trim(),
        paperWidth:    _v('paper-width') || '58',
        setupComplete: true,
        taxRate:       16,
        autoPrint:     false,
        loyaltyRate:   1,
      });

      /* Seed demo products */
      await PosDB.products.seedDemo();

      state.wizardStep++;
      wizard.showStep(state.wizardStep);
    },

    async finish() {
      await launchApp();
    },
  };

  /* ═══════════════════════════════════════════════════════════
     UI
  ═══════════════════════════════════════════════════════════ */
  const ui = {
    switchTab(tab, opts) {
      opts = opts || {};
      if (!tab) return;
      const prev = state.currentTab;
      /* No-op guard: re-selecting the active view does no work — prevents redundant
         re-renders, listener churn and history spam on repeated switching. */
      if (prev === tab && !opts.force) return;
      /* Tear down the view being left. One-shot IndexedDB readers register nothing;
         any future view that opens a live listener MUST SPos.nav.registerTeardown()
         its unsub here so repeated switching can never accumulate listeners. */
      if (prev && prev !== tab) nav._runTeardown(prev);
      state.currentTab = tab;
      document.querySelectorAll('.pos-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
      document.querySelectorAll('.pos-panel').forEach(p => p.classList.remove('active'));
      document.getElementById(`panel-${tab}`)?.classList.add('active');

      if (tab === 'orders')    orders.render();
      if (tab === 'more')      more.render();
      if (tab === 'inventory') inv.showTab(state.invTab);
      if (tab === 'customers') customers.loadTable();
      if (tab === 'settings')  { settings.loadIntoForm(); _bootSettingsPanels(); }
      if (tab === 'reports')   reports.setRange('today');
      if (tab === 'bos') {
        if (window.PosBoss)      PosBoss.hub.renderActions('bos-quick-actions');
        if (window.PosAnalytics) PosAnalytics.renderBosHub('bos-analytics-body');
      }
      if (tab === 'finance' && window.PosFinance) {
        const el = document.getElementById('finance-hub-body');
        if (el && !el.dataset.loaded) { el.dataset.loaded = '1'; PosFinance.renderHub('finance-hub-body'); }
      }
      if (tab === 'repair' && window.PosRepair) {
        PosRepair.renderHub('repair-body');
      }
      if (tab === 'audit' && window.PosAudit) {
        PosAudit.renderHub('audit-hub-body');
      }
      /* Deep-link + predictable Back/Forward. pushState (not location.hash=) so this
         never re-enters via hashchange; popstate restores the view on Back/Forward. */
      if (!opts.fromHistory) {
        try { const h = '#' + tab; if (location.hash !== h) history.pushState({ tab }, '', h); } catch (_) {}
      }
      if (window.PosPlugins) PosPlugins.emit('tab:switch', { tab });
      nav._analytics(tab, prev);
    },

    async loadCategories() {
      const cats = await PosDB.categories.getAll();
      const container = document.getElementById('category-chips');
      container.innerHTML = `<div class="cat-chip active" data-cat="" onclick="SPos.products.filterCategory(this,'')">All</div>`;
      cats.forEach(c => {
        const chip = document.createElement('div');
        chip.className = 'cat-chip';
        chip.dataset.cat = c.id;
        chip.onclick = () => products.filterCategory(chip, c.id);
        chip.textContent = (c.icon || '') + ' ' + c.name;
        container.appendChild(chip);
      });
    },

    showAlerts() {
      PosDB.products.getLowStock().then(low => {
        /* Update bell badge */
        const badge = document.getElementById('notify-badge');
        if (badge) {
          if (low.length > 0) {
            badge.textContent = low.length > 9 ? '9+' : low.length;
            badge.style.display = 'flex';
          } else {
            badge.style.display = 'none';
          }
        }
        /* Delegate rendering to Phase 7 helper */
        if (typeof _p7ShowAlertsModal === 'function') {
          _p7ShowAlertsModal(low);
        } else if (!low.length) {
          toast('No low-stock alerts', 'info');
        } else {
          confirm.show(
            '⚠️ Low Stock Alert',
            '<strong>' + low.length + ' products</strong> are low or out of stock:<br><br>' +
            low.map(p => `• ${p.name} — ${p.stock} ${p.unit || 'units'} left`).join('<br>'),
            () => ui.switchTab('inventory')
          );
        }
      });
    },

    /* ── Mobile/tablet payment panel ── */
    openPaymentPanel() {
      document.querySelector('.pos-payment')?.classList.add('mobile-open');
      document.getElementById('pos-pay-overlay')?.classList.add('open');
    },

    closePaymentPanel() {
      document.querySelector('.pos-payment')?.classList.remove('mobile-open');
      document.getElementById('pos-pay-overlay')?.classList.remove('open');
    },
  };

  /* Pull the merchant's CANONICAL products (the `products` collection — same source as the
     marketplace / seller dashboard) into the POS IndexedDB via the App-Check-free
     /api/catalogue endpoint (works on any device). Additive + idempotent (upsert by id);
     canonical stock stays authoritative (posCompleteCheckout writes products.stock). This is
     the inventory single-source fix: the POS now shows the shop's real catalogue. */
  async function _seedCatalogueFromCanonical () {
    try {
      let u = null; try { u = JSON.parse(localStorage.getItem('sokoniUser') || 'null'); } catch (_) {}
      const uid = (u && (u.uid || u.id)) || window.currentUser?.uid
               || (window.firebaseAuth && window.firebaseAuth.currentUser && window.firebaseAuth.currentUser.uid)
               || localStorage.getItem('sokoni_merchant_id');
      if (!uid) return 0;
      const r = await fetch('/api/catalogue?sellerUid=' + encodeURIComponent(uid) + '&cb=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) return 0;
      const j = await r.json();
      const list = Array.isArray(j) ? j : (j.products || j.items || j.catalogue || []);
      if (!Array.isArray(list) || !list.length) return 0;
      let n = 0;
      for (const p of list) {
        const id = String(p.id || p._id || p.productId || '');
        if (!id) continue;
        const canonicalStock = (p.stock != null) ? Number(p.stock) : null;
        /* NEVER overwrite local stock on re-seed: a product already in the POS keeps its
           local stock (which reflects POS sale deductions), so a reboot can't reset it.
           Only NEW products take the canonical stock. (POS sales also push to canonical —
           see _posSyncCanonicalStock — so the two stay converged going forward.) */
        const existing = await PosDB.products.get(id).catch(() => null);
        const stock = (existing && existing.stock != null) ? Number(existing.stock) : canonicalStock;
        await PosDB.products.save({
          id,
          name:     p.name || p.title || 'Product',
          price:    Number(p.price || p.sellingPrice || 0),
          cost:     Number(p.cost || p.costPrice || 0) || 0,
          stock,
          track:    stock != null,
          category: p.category || 'general',
          barcode:  p.barcode || '',
          sku:      p.sku || '',
          image:    p.image || (Array.isArray(p.images) ? p.images[0] : '') || '',
          unit:     p.unit || 'pc',
          source:   'canonical',
        }).catch(() => {});
        n++;
      }
      return n;
    } catch (_) { return 0; }
  }

  /* Push a POS stock change to the CANONICAL products.stock so in-store sales/edits reflect on
     the marketplace + seller dashboard (interim inventory convergence). Proper transaction —
     read → floor at 0 → write stock + inventoryVersion + updatedAt together (the inventory
     guardrail) — best-effort + online-only, never blocks the sale. Full convergence (routing
     the terminal through posCompleteCheckout) is planned separately. */
  window._posSyncCanonicalStock = async function (id, delta, reason) {
    try {
      if (!id || !delta || !window.firebaseDB || (typeof navigator !== 'undefined' && navigator.onLine === false)) return;
      const m   = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
      const ref = m.doc(window.firebaseDB, 'products', String(id));
      await m.runTransaction(window.firebaseDB, async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists()) return;                        /* not a canonical product — skip */
        const next = Math.max(0, Number(snap.data().stock || 0) + Number(delta));   /* floored at zero */
        tx.update(ref, {
          stock: next,
          inventoryVersion: m.increment(1),
          lastStockSource: 'pos:' + (reason || 'adjust'),
          updatedAt: m.serverTimestamp(),
        });
      });
    } catch (_) { /* best-effort — local IndexedDB stock stays authoritative for the session */ }
  };

  /* Checkout-convergence SHADOW (Phase 1) — dry-run the canonical posCompleteCheckout and store a
     structured comparison of what it WOULD produce vs this legacy sale. Feature-flagged
     (window.POS_CHECKOUT_SHADOW), fire-and-forget, side-effect-free (dryRun). Evidence only. */
  async function _posCheckoutShadow (txn) {
    try {
      if (!window.firebaseApp || !window.firebaseDB || (typeof navigator !== 'undefined' && navigator.onLine === false)) return;
      let u = null; try { u = JSON.parse(localStorage.getItem('sokoniUser') || 'null'); } catch (_) {}
      const merchantId = (u && (u.uid || u.id)) || window.currentUser?.uid || localStorage.getItem('sokoni_merchant_id');
      if (!merchantId) return;
      const items = (txn.items || []).map(i => ({ productId: i.id, qty: i.qty, unitPrice: i.price }));
      if (!items.length) return;
      const payload = {
        dryRun: true,
        idempotencyKey: txn.idempotencyKey || txn.id,
        merchantId,
        branchId: (state.settings && state.settings.branchId) || 'default',
        shiftId:  txn.shiftId || undefined,
        items,
        payments: [{ method: txn.paymentMethod || 'cash', amount: Number(txn.total || 0) }],
        subtotal: Number(txn.subtotal || 0),
        discountTotal: Number(txn.discountAmount || 0),
        taxTotal: Number(txn.taxAmount || 0),
        grandTotal: Number(txn.total || 0),
        metadata: { source: 'pos.js', localTxnId: txn.id, shadow: true },
      };
      const fnMod = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js');
      const _shadowT0 = Date.now();
      const res = (await fnMod.httpsCallable(fnMod.getFunctions(window.firebaseApp), 'posCompleteCheckout')(payload)).data || {};
      const shadowMs = Date.now() - _shadowT0;

      const expected = {
        items: items.map(i => ({ productId: i.productId, qty: i.qty, unitPrice: i.unitPrice })),
        subtotal: Number(txn.subtotal || 0), discount: Number(txn.discountAmount || 0),
        tax: Number(txn.taxAmount || 0), total: Number(txn.total || 0),
        stockDelta: items.map(i => ({ productId: i.productId, delta: -Number(i.qty || 0) })),
      };
      const canonical = {
        orderId: res.saleId || null,                 /* dry-run creates no order — expected null */
        items: res.items || [], subtotal: Number(res.serverSubtotal || 0), total: Number(res.grandTotal || 0),
        stockDelta: (res.stockDeltas || []).map(s => ({ productId: s.productId, delta: Number(s.delta || 0) })),
      };
      const differences = [];
      if (Math.abs(expected.subtotal - canonical.subtotal) > 1) differences.push({ field: 'subtotal', expected: expected.subtotal, canonical: canonical.subtotal });
      if (Math.abs(expected.total    - canonical.total)    > 1) differences.push({ field: 'total',    expected: expected.total,    canonical: canonical.total });
      const cmap = {}; canonical.stockDelta.forEach(s => { cmap[s.productId] = s.delta; });
      expected.stockDelta.forEach(e => {
        if (cmap[e.productId] == null)          differences.push({ field: 'stockDelta', productId: e.productId, expected: e.delta, canonical: null });
        else if (cmap[e.productId] !== e.delta) differences.push({ field: 'stockDelta', productId: e.productId, expected: e.delta, canonical: cmap[e.productId] });
      });
      if (Array.isArray(res.differences)) res.differences.forEach(d => differences.push({ field: 'canonical', ...d }));

      const record = {
        txnId: txn.id,
        shadowRunId: (window.PosIdempotency && PosIdempotency.generateTxnId) ? PosIdempotency.generateTxnId() : ('shadow_' + txn.id),
        idempotencyKey: payload.idempotencyKey, at: Date.now(), merchantId,
        expected, canonical,
        comparison: differences.length === 0 ? 'PASS' : 'FAIL',
        differences,
        /* Timing evidence (does NOT gate correctness): canonical dry-run round-trip vs the legacy
           local commit, to surface any latency surprises before cutover. */
        timing: { shadowMs, legacyMs: (typeof txn._legacyMs === 'number' ? txn._legacyMs : null),
                  diffMs: (typeof txn._legacyMs === 'number' ? shadowMs - txn._legacyMs : null) },
      };
      const m = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
      await m.setDoc(m.doc(window.firebaseDB, 'posCheckoutShadow', String(txn.id)), record).catch(() => {});
    } catch (e) {
      /* A shadow FAILURE is itself evidence — record it; never surface to the cashier. */
      try {
        const m = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
        await m.setDoc(m.doc(window.firebaseDB, 'posCheckoutShadow', String(txn.id)),
          { txnId: txn.id, at: Date.now(), comparison: 'ERROR', error: String((e && e.message) || e).slice(0, 200) }).catch(() => {});
      } catch (_) {}
    }
  }

  /* ═══════════════════════════════════════════════════════════
     PRODUCTS
  ═══════════════════════════════════════════════════════════ */
  const products = {
    async reload() {
      state.allProducts = await PosDB.products.getAll();
      products.render(state.allProducts);
    },

    async search(query) {
      state.productSearch = query;
      const results = await PosDB.products.search(query);
      const filtered = state.categoryFilter
        ? results.filter(p => p.category === state.categoryFilter)
        : results;
      products.render(filtered);
    },

    async searchEnter(query) {
      /* If barcode-length (8-13 digits), treat as scan */
      if (/^\d{8,14}$/.test(query.trim())) {
        handleBarcodeGlobal(query.trim());
        document.getElementById('product-search').value = '';
        return;
      }
      products.search(query);
    },

    async filterCategory(el, catId) {
      state.categoryFilter = catId;
      document.querySelectorAll('.cat-chip').forEach(c => c.classList.toggle('active', c.dataset.cat === catId));
      const list = catId
        ? await PosDB.products.getByCategory(catId)
        : state.allProducts;
      const query = state.productSearch;
      const filtered = query
        ? list.filter(p => p.name?.toLowerCase().includes(query.toLowerCase()) || p.barcode?.includes(query))
        : list;
      products.render(filtered);
    },

    render(list) {
      const grid = document.getElementById('product-grid');
      if (!list.length) {
        grid.innerHTML = `<div class="pos-empty" style="grid-column:1/-1"><div class="empty-icon">🔍</div><p>No products found</p></div>`;
        return;
      }
      grid.innerHTML = list.map(p => {
        const catIcons = { cat_food:'🍎', cat_electronics:'💻', cat_pharma:'💊', cat_cleaning:'🧹', cat_personal:'🪥', cat_stationery:'📝', cat_clothing:'👕', cat_wholesale:'🏭' };
        const icon = catIcons[p.category] || '📦';
        const stockClass = !p.stock || p.stock === 0 ? 'out-stock' : (p.lowStockThreshold && p.stock <= p.lowStockThreshold ? 'low-stock' : '');
        return `<div class="product-tile ${stockClass}" onclick="SPos.cart.addItem('${p.id}')">
          <div class="product-tile-cat">${icon}</div>
          <div class="product-tile-name">${_esc(p.name)}</div>
          <div class="product-tile-price">KES ${Number(p.price).toFixed(2)}</div>
          <div class="product-tile-stock">${p.stock !== undefined ? p.stock + ' ' + (p.unit || 'pcs') : ''}</div>
          <div class="product-tile-add">+</div>
        </div>`;
      }).join('');
    },
  };

  /* ═══════════════════════════════════════════════════════════
     CART
  ═══════════════════════════════════════════════════════════ */
  const cart = {
    async addItem(productId) {
      const p = await PosDB.products.getById(productId);
      if (!p) return;
      if (p.stock === 0) { toast('Out of stock', 'error'); return; }

      /* Pharmacy: block expired products */
      if (p.expiryDate && new Date(p.expiryDate) < new Date()) {
        toast(`⚠ ${p.name} has expired (${p.expiryDate}) — cannot sell`, 'error');
        return;
      }
      /* Pharmacy: warn on near-expiry (≤30 days) */
      if (p.expiryDate) {
        const daysLeft = Math.ceil((new Date(p.expiryDate) - Date.now()) / 86400000);
        if (daysLeft <= 30 && daysLeft > 0) {
          toast(`⚠ ${p.name} expires in ${daysLeft} day(s) (batch ${p.batchNumber || '—'})`, 'warn');
        }
      }

      const existing = state.cartItems.find(i => i.id === productId);
      if (existing) {
        existing.qty++;
      } else {
        state.cartItems.push({
          id: p.id, name: p.name, price: p.price, cost: p.cost || 0, qty: 1,
          taxRate: p.taxRate || 0, unit: p.unit,
          /* carry pharmacy/electronics metadata for checkout */
          batchNumber:          p.batchNumber      || null,
          expiryDate:           p.expiryDate       || null,
          requiresPrescription: p.requiresPrescription || false,
          requiresSerial:       p.requiresSerial   || false,
          requiresIMEI:         p.requiresIMEI     || false,
          warrantyMonths:       p.warrantyMonths   || null,
        });
      }
      cart.render();
    },

    addByProduct(p) {
      const existing = state.cartItems.find(i => i.id === p.id);
      if (existing) existing.qty++;
      else state.cartItems.push({ id: p.id, name: p.name, price: p.price, cost: p.cost || 0, qty: 1, taxRate: p.taxRate || 0, unit: p.unit });
      cart.render();
    },

    /* Used by Phase 7 long-press quick-add */
    _addById(productId) { cart.addItem(productId); },

    updateQty(id, delta) {
      const item = state.cartItems.find(i => i.id === id);
      if (!item) return;
      item.qty = Math.max(0, item.qty + delta);
      if (item.qty === 0) state.cartItems = state.cartItems.filter(i => i.id !== id);
      cart.render();
    },

    setQty(id, qty) {
      const q = parseFloat(qty);
      if (isNaN(q) || q < 0) return;
      const item = state.cartItems.find(i => i.id === id);
      if (!item) return;
      if (q === 0) state.cartItems = state.cartItems.filter(i => i.id !== id);
      else item.qty = q;
      cart.render();
    },

    removeItem(id) {
      state.cartItems = state.cartItems.filter(i => i.id !== id);
      cart.render();
    },

    async overridePrice(id, name, currentPrice) {
      if (!window.ManagerAuth) {
        toast('Manager Authorization module not loaded', 'error');
        return;
      }
      const newPrice = await ManagerAuth.requestPriceOverride(id, name, currentPrice);
      if (newPrice === null) return;
      const item = state.cartItems.find(i => i.id === id);
      if (!item) return;
      const oldPrice = item.price;
      item.price = newPrice;
      cart.render();
      toast(`Price override: KES ${oldPrice.toFixed(2)} → KES ${newPrice.toFixed(2)}`, 'info');
    },

    clear() {
      if (!state.cartItems.length) return;
      state.cartItems   = [];
      state.discountVal  = 0;
      state.discountType = 'pct';
      state.currentCustomer = null;
      const cb = document.getElementById('customer-btn');
      if (cb) { cb.textContent = '👤 Walk-in Customer'; cb.classList.remove('active'); }
      cart.render();
    },

    hold() {
      if (!state.cartItems.length) { toast('Cart is empty', 'error'); return; }
      state.heldCarts.push({ items: [...state.cartItems], discount: state.discountVal, discountType: state.discountType, customer: state.currentCustomer });
      toast(`Cart held (${state.heldCarts.length} held)`, 'info');
      cart.clear();
    },

    recall() {
      if (!state.heldCarts.length) { toast('No held carts', 'info'); return; }
      const held = state.heldCarts.pop();
      state.cartItems   = held.items;
      state.discountVal = held.discount;
      state.discountType = held.discountType;
      state.currentCustomer = held.customer;
      cart.render();
      toast('Cart recalled', 'success');
    },

    getSubtotal() {
      return state.cartItems.reduce((s, i) => s + i.qty * i.price, 0);
    },

    getTax() {
      return state.cartItems.reduce((s, i) => {
        if (!i.taxRate) return s;
        const inc = state.settings.taxInclusive;
        const lineTotal = i.qty * i.price;
        return s + (inc ? lineTotal - lineTotal / (1 + i.taxRate / 100) : lineTotal * i.taxRate / 100);
      }, 0);
    },

    getDiscountAmount(subtotal) {
      if (!state.discountVal) return 0;
      if (state.discountType === 'pct') return subtotal * (state.discountVal / 100);
      return Math.min(state.discountVal, subtotal);
    },

    getTotal() {
      const sub  = cart.getSubtotal();
      const disc = cart.getDiscountAmount(sub);
      const tax  = cart.getTax();
      const inc  = state.settings.taxInclusive;
      return inc ? sub - disc : sub - disc + tax;
    },

    render() {
      const items = state.cartItems;
      const container = document.getElementById('cart-items');

      if (!items.length) {
        container.innerHTML = `<div class="cart-empty"><div class="cart-empty-icon">🛒</div><p>Scan or tap products<br>to add to cart</p></div>`;
        cart.updateTotalsUI(0, 0, 0, 0);
        return;
      }

      container.innerHTML = items.map(item => `
        <div class="cart-item" data-id="${item.id}">
          <div class="cart-item-name">
            ${_esc(item.name)}
            <small>KES ${Number(item.price).toFixed(2)} / ${item.unit || 'piece'}
              <button class="cart-price-override" title="Override price" onclick="SPos.cart.overridePrice('${item.id}','${_esc(item.name)}',${item.price})" style="background:none;border:none;cursor:pointer;color:var(--txt3);font-size:11px;padding:0 2px;margin-left:2px">✏</button>
            </small>
          </div>
          <div class="cart-item-qty">
            <button class="qty-btn remove" onclick="SPos.cart.updateQty('${item.id}',-1)">−</button>
            <input class="qty-num" type="number" value="${item.qty}" min="0"
              onchange="SPos.cart.setQty('${item.id}',this.value)"
              onclick="this.select()">
            <button class="qty-btn" onclick="SPos.cart.updateQty('${item.id}',1)">+</button>
          </div>
          <div class="cart-item-price">KES ${(item.qty * item.price).toFixed(2)}</div>
          <button class="cart-item-del" onclick="SPos.cart.removeItem('${item.id}')">✕</button>
        </div>
      `).join('');

      const sub  = cart.getSubtotal();
      const disc = cart.getDiscountAmount(sub);
      const tax  = cart.getTax();
      const total = cart.getTotal();

      cart.updateTotalsUI(sub, disc, tax, total);
      document.getElementById('cart-count').textContent = items.reduce((s, i) => s + i.qty, 0) + ' items';
    },

    updateTotalsUI(sub, disc, tax, total) {
      _setVal('cart-total', 'KES ' + total.toFixed(2));
      _setVal('pay-total-display', total.toFixed(2));
      _setVal('pay-btn', total > 0 ? `Charge KES ${total.toFixed(2)}` : 'Charge KES 0.00');
      document.getElementById('pay-btn').disabled = total <= 0;
      /* Sync mobile charge button */
      const _mBtn = document.getElementById('mobile-pay-btn');
      if (_mBtn) { _mBtn.textContent = total > 0 ? `Charge KES ${total.toFixed(2)}` : 'Charge KES 0.00'; _mBtn.disabled = total <= 0; _mBtn.className = 'cart-mobile-pay-btn'; }

      document.getElementById('row-subtotal').style.display = disc > 0 || tax > 0 ? '' : 'none';
      document.getElementById('row-discount').style.display = disc > 0 ? '' : 'none';
      document.getElementById('row-tax').style.display      = tax  > 0 ? '' : 'none';

      if (disc > 0 || tax > 0) _setVal('cart-subtotal', 'KES ' + sub.toFixed(2));
      if (disc > 0) _setVal('cart-discount', '-KES ' + disc.toFixed(2));
      if (tax  > 0) _setVal('cart-tax',      'KES '  + tax.toFixed(2));

      /* Update numpad display if method === exact */
      if (state.numpadStr === '0' || state.numpadStr === '') {
        _setVal('numpad-val', total > 0 ? total.toFixed(2) : '0');
      }
    },

    discount() {
      if (!state.cartItems.length) { toast('Cart is empty', 'error'); return; }
      _setVal('disc-value', state.discountVal || '');
      _setVal('disc-subtotal', cart.getSubtotal().toFixed(2));
      cart.setDiscountType(state.discountType);
      modal.open('discount-modal');
    },

    setDiscountType(type) {
      state.discountType = type;
      const isPct = type === 'pct';
      document.getElementById('disc-pct-btn').classList.toggle('modal-btn-primary', isPct);
      document.getElementById('disc-pct-btn').classList.toggle('modal-btn-ghost',   !isPct);
      document.getElementById('disc-amt-btn').classList.toggle('modal-btn-primary', !isPct);
      document.getElementById('disc-amt-btn').classList.toggle('modal-btn-ghost',   isPct);
      document.getElementById('disc-value').placeholder = isPct ? 'e.g. 10' : 'e.g. 50';
    },

    async applyDiscount() {
      const val = parseFloat(_v('disc-value')) || 0;
      const isPct = state.discountType === 'pct';

      /* Manager authorization for large discounts */
      if (window.ManagerAuth && val > 0) {
        const cfg   = ManagerAuth.getConfig();
        const sub   = cart.getSubtotal();
        const pctThreshold = cfg.largeDiscountPctThreshold || 15;
        const amtThreshold = cfg.largeDiscountAmtThreshold || 500;
        const isLarge = isPct
          ? val >= pctThreshold
          : val >= amtThreshold;

        if (isLarge) {
          const ok = await ManagerAuth.request('large_discount', {
            discountPct: isPct ? val : null,
            amount: isPct ? null : val,
            cashier: state.currentCashier?.name,
          });
          if (!ok) { modal.close('discount-modal'); toast('Discount cancelled — authorization denied', 'error'); return; }
        }
      }

      state.discountVal = val;
      cart.render();
      modal.close('discount-modal');
      if (val > 0) toast(`Discount applied: ${state.discountType === 'pct' ? val + '%' : 'KES ' + val}`, 'success');
    },

    removeDiscount() {
      state.discountVal = 0;
      cart.render();
      modal.close('discount-modal');
      toast('Discount removed', 'info');
    },
  };

  /* ═══════════════════════════════════════════════════════════
     PAYMENT
  ═══════════════════════════════════════════════════════════ */
  const payment = {
    setMethod(method) {
      state.payMethod   = method;
      state.numpadStr   = '0';
      _setVal('numpad-val', '0');

      document.querySelectorAll('.pay-method-btn').forEach(b => b.classList.toggle('active', b.dataset.method === method));

      const total = cart.getTotal();
      const isM   = method === 'mpesa';
      const isC   = method === 'card';
      const payBtn = document.getElementById('pay-btn');
      payBtn.className = 'pos-pay-btn' + (isM ? ' mpesa' : isC ? ' card' : '');
      payBtn.textContent = isM
        ? `📱 Pay KES ${total.toFixed(2)} via M-PESA`
        : isC
        ? `💳 Charge KES ${total.toFixed(2)} via Card`
        : `Charge KES ${total.toFixed(2)}`;
      payBtn.disabled = total <= 0;
      /* Sync mobile charge button label + style */
      const _mBtn2 = document.getElementById('mobile-pay-btn');
      if (_mBtn2) { _mBtn2.textContent = payBtn.textContent; _mBtn2.className = 'cart-mobile-pay-btn' + (isM ? ' mpesa' : ''); }

      _setVal('numpad-label', method === 'cash' ? 'Amount tendered' : 'Amount');
    },

    numpad(key) {
      let s = state.numpadStr === '0' ? '' : state.numpadStr;
      if (key === 'back')  { s = s.slice(0, -1) || '0'; }
      else if (key === 'clear') { s = '0'; }
      else if (key === 'exact') { s = cart.getTotal().toFixed(2); }
      else if (key === '.' && s.includes('.')) { /* already has dot */ }
      else { s = (s + key); if (s.startsWith('0') && !s.startsWith('0.')) s = s.slice(1); }
      state.numpadStr = s || '0';
      _setVal('numpad-val', state.numpadStr);
    },

    async process() {
      const total = cart.getTotal();
      if (total <= 0 || !state.cartItems.length) { toast('Cart is empty', 'error'); return; }
      if (!state.currentCashier) { cashier.showSwitchDialog(); return; }
      if (!state.currentShift)   { shift.showDialog(); return; }

      const method = state.payMethod;

      if (method === 'mpesa') {
        modal.open('mpesa-modal');
        _setVal('mpesa-amount-disp', total.toFixed(2));
        /* Pre-fill with customer phone if available */
        if (state.currentCustomer?.phone) _setVal('mpesa-phone', state.currentCustomer.phone);
        return;
      }

      if (method === 'split') {
        split.open(total);
        return;
      }

      if (method === 'card') {
        if (!window.PosTerminals) { toast('Terminal module not loaded', 'error'); return; }
        const tillId = state.settings.tillId || '1';
        const result = await PosTerminals.payment.initiate(total, tillId);
        if (!result) return; // no terminal assigned — error shown by module
        if (result.status === 'approved') {
          await payment.complete({
            method:      'card',
            amountPaid:  total,
            change:      0,
            mpesaRef:    null,
            mpesaPhone:  null,
            cardAuthCode: result.authCode,
            cardLast4:    result.cardLast4,
            cardScheme:   result.cardScheme,
            cardRef:      result.reference,
          });
          modal.close('card-payment-modal');
        }
        // declined / timeout / error: modal already shows the result with retry option
        return;
      }

      const tendered = parseFloat(state.numpadStr) || total;
      if (method === 'cash' && tendered < total) {
        toast(`Tendered KES ${tendered.toFixed(2)} is less than total KES ${total.toFixed(2)}`, 'error');
        return;
      }

      const change = method === 'cash' ? Math.max(0, tendered - total) : 0;
      await payment.complete({ method, amountPaid: tendered, change, mpesaRef: null, mpesaPhone: null });
    },

    async complete(payInfo) {
      /* ── Idempotency gate: prevent double-submit ───────────── */
      if (window.PosIdempotency && PosIdempotency.isPayButtonLocked()) {
        toast('Payment already in progress', 'warning'); return;
      }
      if (window.PosIdempotency) PosIdempotency.lockPayButton('Processing…');
      const _checkoutStart = window.PosHealth ? PosHealth.startCheckoutTimer() : Date.now();

      const total = cart.getTotal();
      const sub   = cart.getSubtotal();
      const disc  = cart.getDiscountAmount(sub);
      const tax   = cart.getTax();
      const cost  = state.cartItems.reduce((s, i) => s + i.qty * (i.cost || 0), 0);

      /* ── Collision-resistant IDs ───────────────────────────── */
      const txnId     = window.PosIdempotency ? PosIdempotency.generateTxnId()    : ('txn_' + Date.now() + '_' + Math.random().toString(36).slice(2,7));
      const receiptNo = window.PosIdempotency ? PosIdempotency.generateReceiptNo() : ('R' + Date.now().toString().slice(-8));

      /* ── Idempotency: detect duplicate receipt ─────────────── */
      if (window.PosIdempotency && await PosIdempotency.hasKey(receiptNo)) {
        if (window.PosIdempotency) PosIdempotency.unlockPayButton();
        toast('Duplicate transaction detected — please try again', 'error'); return;
      }

      const txn = {
        id:             txnId,
        idempotencyKey: txnId,   /* stable per-sale key — reused by the shadow (Phase 1) and, later, canonical settlement */
        items:          state.cartItems.map(i => ({ ...i })),
        subtotal:       sub,
        discountAmount: disc,
        taxAmount:      tax,
        total,
        costTotal:      cost,
        paymentMethod:  payInfo.method,
        amountPaid:     payInfo.amountPaid,
        change:         payInfo.change || 0,
        mpesaRef:       payInfo.mpesaRef,
        mpesaPhone:     payInfo.mpesaPhone,
        cashierId:      state.currentCashier?.id,
        cashierName:    state.currentCashier?.name,
        shiftId:        state.currentShift?.id,
        customerId:     state.currentCustomer?.id,
        customerName:   state.currentCustomer?.name,
        status:         'completed',
        synced:         false,
        receiptNo,
        timestamp:      Date.now(),
      };

      /* ── Electronics: capture IMEI / serial numbers before committing ── */
      const electronicsItems = txn.items.filter(i => i.requiresSerial || i.requiresIMEI);
      if (electronicsItems.length > 0) {
        const serialMap = {};
        for (const item of electronicsItems) {
          const captured = await _captureSerialForItem(item);
          if (captured === null) {
            /* User cancelled serial capture — abort checkout */
            if (window.PosIdempotency) PosIdempotency.unlockPayButton();
            toast('Checkout cancelled — serial number required for ' + item.name, 'error');
            return;
          }
          serialMap[item.id] = captured;
        }
        /* Attach captured serials to txn items */
        for (const item of txn.items) {
          if (serialMap[item.id]) Object.assign(item, serialMap[item.id]);
        }
      }

      /* ── Saga: atomic multi-step write with compensating txns ─ */
      const stockSnapshot = [];  // for rollback
      const _legacyT0 = Date.now();   /* legacy local-commit timing (for the shadow comparison) */
      try {
        /* Step 1: Save transaction record */
        await PosDB.transactions.save(txn);

        /* Step 2: Deduct stock — collect pre-deduction values for rollback */
        for (const item of txn.items) {
          const before = (await PosDB.products.get(item.id))?.stock ?? 0;
          stockSnapshot.push({ id: item.id, before, delta: item.qty });
          await PosDB.products.adjustStock(item.id, -item.qty, 'sale:' + txn.id, txn.cashierId);
        }

      /* Update shift totals */
      if (state.currentShift) {
        await PosDB.shifts.addTransaction(state.currentShift.id, txn);
      }

      /* Loyalty points */
      if (state.currentCustomer) {
        const pts = Math.floor(total / 100) * (state.settings.loyaltyRate || 1);
        await PosDB.customers.recordPurchase(state.currentCustomer.id, total, pts);
      }

      txn._legacyMs = Date.now() - _legacyT0;   /* local commit duration — recorded in the shadow comparison */

        /* Step 3: Queue for cloud sync */
        await PosDB.syncQueue.add('transaction', txn);
        /* Show offline queue count if not connected */
        if (!navigator.onLine) {
          PosDB.syncQueue.getPending().then(function(q){ _p7UpdateOfflineCount(q.length); }).catch(function(){});
        }

        /* Step 4: Register idempotency key (prevent replay) */
        if (window.PosIdempotency) await PosIdempotency.recordKey(receiptNo, { txnId, total });

        /* Step 5: Save serial/IMEI records for electronics */
        if (window.PosSerial) {
          for (const item of txn.items) {
            if (item.serial || item.imei) {
              await PosSerial.add({
                productId:     item.id,
                serial:        item.serial     || null,
                imei:          item.imei       || null,
                transactionId: txn.id,
                customerId:    txn.customerId  || null,
                soldAt:        Date.now(),
                warrantyExpiry: item.warrantyMonths
                  ? new Date(Date.now() + item.warrantyMonths * 30 * 86400000).toISOString()
                  : null,
              }).catch(() => {});
            }
          }
        }

        /* ── All writes committed ─────────────────────────────── */
      } catch (err) {
        /* ROLLBACK: restore stock for any items already deducted */
        for (const snap of stockSnapshot) {
          try { await PosDB.products.adjustStock(snap.id, snap.delta, 'rollback:' + txnId, txn.cashierId); } catch (_) {}
        }
        /* Mark transaction as failed if it was saved */
        try { await PosDB.transactions.save({ ...txn, status: 'failed', failReason: err.message }); } catch (_) {}

        if (window.PosHealth)     PosHealth.recordError('payment_failed', err.message, { txnId, total });
        if (window.PosIdempotency) PosIdempotency.unlockPayButton();
        if (window.PosHealth)     PosHealth.endCheckoutTimer(_checkoutStart, false);
        toast('Payment error — transaction rolled back. Try again.', 'error');
        console.error('[POS] payment.complete saga failed:', err);
        return;
      }

      if (window.PosIdempotency) PosIdempotency.unlockPayButton();
      if (window.PosHealth)     PosHealth.endCheckoutTimer(_checkoutStart, true);

      /* Receipt data */
      const receiptData = {
        ...txn,
        businessName:    state.settings.bizName,
        businessAddress: state.settings.bizAddress,
        businessPhone:   state.settings.bizPhone,
        businessPin:     state.settings.bizPin,
        branchName:      window._currentBranchName || 'Main Branch',
        footerMessage:   state.settings.receiptFooter || 'Thank you for shopping with us!',
        date:            new Date().toLocaleString('en-KE'),
        taxRate:         state.settings.taxRate || 16,
        paperWidth:      parseInt(state.settings.paperWidth) || 32,
      };

      /* Save receipt record */
      const receiptRecord = { transactionId: txn.id, receiptNo: txn.receiptNo, data: receiptData, ts: Date.now() };
      await PosDB.receipts.save(receiptRecord).catch(() => {});

      /* Print receipt — route through the single public print API (PosPrintService),
         which owns transport selection, queue, telemetry and the legacy fallback.
         Fire-and-forget: a print failure must never interrupt order completion. */
      if (state.settings.autoPrint || payInfo.method === 'card') {
        if (window.PosPrintService && typeof PosPrintService.printReceipt === 'function') {
          PosPrintService.printReceipt(receiptData, { method: payInfo.method, payments: txn.payments })
            .catch(() => { /* service already falls back internally; last-ditch guard below */
              if (window.SokoniPrint) SokoniPrint.print('receipt', receiptData).catch(() => window.PosPrinter && PosPrinter.printBrowser(receiptData));
            });
        } else if (window.SokoniPrint) {
          SokoniPrint.print('receipt', receiptData).catch(() => PosPrinter.printBrowser(receiptData));
        } else if (window.PosPrinter) {
          PosPrinter.print(receiptData).catch(() => {});
        }
      }

      /* Cash drawer */
      if (payInfo.method === 'cash' && state.settings.openCashDrawer) {
        PosPrinter.openCashDrawer();
      }

      /* Apply loyalty tier discount notification */
      if (window.PosBoss && state.currentCustomer) {
        const tier = PosBoss.loyalty.getTier(state.currentCustomer.totalSpent);
        if (tier.discount > 0 && !state.discountVal) {
          toast(`${tier.icon} ${tier.name} member — ${tier.discount}% loyalty discount applied next visit`, 'info');
        }
      }

      /* Close mobile payment panel before showing success overlay */
      ui.closePaymentPanel();

      /* Show success overlay — always wire up buttons */
      _showSuccessOverlay(receiptData);
      if (window.PosBoss) PosBoss.showSuccess(receiptData, state.settings);

      /* Checkout-convergence SHADOW (Phase 1): fire-and-forget, feature-flagged, dry-run only.
         Runs the CANONICAL posCompleteCheckout in dry-run and records a structured comparison
         (posCheckoutShadow/{txnId}) of what it WOULD have produced vs this legacy sale. Never
         affects the sale, inventory, the cashier, or anything customer-visible — evidence only. */
      if (window.POS_CHECKOUT_SHADOW === true ||
          (function () { try { return localStorage.getItem('POS_CHECKOUT_SHADOW') === '1'; } catch (_) { return false; } })()) {
        try { _posCheckoutShadow(txn); } catch (_) {}   /* per-terminal flag; default OFF → zero behaviour change */
      }

      /* Emit plugin hooks */
      if (window.PosPlugins) {
        PosPlugins.emit('sale:after', txn);
        PosPlugins.emit('payment:after', { txn, payInfo });
      }

      /* Notify owner of large sales */
      if (window.PosNotify && total >= 10000) {
        PosNotify.send('sale_large', { total, receiptNo: txn.receiptNo });
      }

      /* Audit log */
      if (window.PosAudit) {
        PosAudit.log('sale', { receiptNo: txn.receiptNo, total, method: payInfo.method, items: txn.items.length });
      }

      /* Recommendations invalidation */
      if (window.PosAIEngine) PosAIEngine.recommendations.invalidate();

      /* Omnichannel stock push for marketplace-linked products */
      if (window.PosOmni) {
        for (const item of txn.items) {
          if (item.marketplaceId) PosOmni.pushStock(item.id).catch(() => {});
        }
      }

      /* Check for low stock and notify */
      for (const item of txn.items) {
        const updated = await PosDB.products.get(item.id);
        if (updated && updated.stock <= (updated.lowStockThreshold || 5)) {
          if (window.PosPlugins) PosPlugins.emit('stock:low', updated);
        }
      }

      /* Reset cart */
      cart.clear();
      if (window.PosMobile) PosMobile.resetCartBadge();
      payment.setMethod('cash');
      state.numpadStr = '0';
      _setVal('numpad-val', '0');

      /* Refresh products (stock levels changed) */
      await products.reload();

      /* Background sync */
      sync.run(true);
    },

    cancelCard() {
      if (window.PosTerminals) PosTerminals.payment.cancel();
      else modal.close('card-payment-modal');
    },
  };

  /* ═══════════════════════════════════════════════════════════
     M-PESA
  ═══════════════════════════════════════════════════════════ */
  const mpesa = {
    /* RETIRED — the POS no longer stores merchant M-Pesa credentials.
       This wrote darajaConsumerSecret and darajaPassKey to Firestore from the
       till device: live API secrets, in plaintext, on shared shop hardware.
       Collections are moving to one central SOKONI account whose keys live in
       Secret Manager and never reach a client (functions/payment-config.js →
       collectionRoute).

       Kept as a rejecting stub rather than deleted so any caller fails loudly
       and immediately instead of silently appearing to save. Audited 2026-07-22:
       shopSettings held ZERO documents, so no till loses a working setup. */
    async saveCredentials() {
      throw new Error(
        'M-Pesa collection is managed by SOKONI centrally — per-merchant Daraja ' +
        'credentials are no longer stored on the device.'
      );
    },

    async sendSTK() {
      const phone  = _v('mpesa-phone').replace(/\s/g, '');
      const total  = cart.getTotal();

      if (!phone || phone.length < 9) { toast('Enter valid phone number', 'error'); return; }

      const cleanPhone = phone.startsWith('0') ? '254' + phone.slice(1) : phone.startsWith('+') ? phone.slice(1) : phone;

      document.getElementById('mpesa-send-btn').disabled = true;
      document.getElementById('mpesa-send-btn').textContent = 'Sending...';

      /* Step 1: active */
      _setMpesaStep(1, 'active');

      try {
        const fn = window.firebaseApp
          ? (await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js'))
          : null;

        let checkoutId = null;

        if (fn && window.firebaseApp) {
          const { getFunctions, httpsCallable } = fn;
          const functions = getFunctions(window.firebaseApp);
          const call = httpsCallable(functions, 'darajaSTKPush');
          const uid  = window.currentUser?.uid;
          const result = await call({
            sellerUid:   uid,
            phone:       cleanPhone,
            amount:      Math.ceil(total),
            description: 'SOKONI SmartPOS Sale',
            hub:         'pos',
          });
          checkoutId = result.data?.checkoutId;
        }

        if (!checkoutId) {
          /* Dev mode: simulate STK push */
          checkoutId = 'SIMULATED_' + Date.now();
        }

        state.mpesaCheckoutId = checkoutId;
        _setMpesaStep(1, 'done');
        _setMpesaStep(2, 'active');

        /* Poll for confirmation */
        let attempts = 0;
        state.mpesaPollTimer = setInterval(async () => {
          attempts++;
          if (attempts > 24) { /* 2 min timeout */
            clearInterval(state.mpesaPollTimer);
            _setMpesaStep(2, 'failed');
            _setMpesaStep(3, 'failed');
            document.getElementById('mpesa-result').style.display = 'block';
            document.getElementById('mpesa-result').style.background = 'rgba(239,68,68,0.1)';
            document.getElementById('mpesa-result').style.color = 'var(--red)';
            document.getElementById('mpesa-result').textContent = 'Payment timed out. Ask customer to try again.';
            document.getElementById('mpesa-send-btn').disabled = false;
            document.getElementById('mpesa-send-btn').textContent = '📱 Send M-PESA Request';
            return;
          }

          try {
            let confirmed = false, mpesaRef = '';

            if (fn && window.firebaseApp && !checkoutId.startsWith('SIMULATED_')) {
              const { getFunctions, httpsCallable } = fn;
              const functions = getFunctions(window.firebaseApp);
              const call = httpsCallable(functions, 'verifyPaymentStatus');
              const result = await call({ checkoutId });
              confirmed = result.data?.status === 'completed';
              mpesaRef  = result.data?.mpesaCode;
            } else if (checkoutId.startsWith('SIMULATED_') && attempts >= 3) {
              /* Simulation: confirm after 3 polls (~15s) */
              confirmed = true;
              mpesaRef  = 'SIM' + Date.now().toString().slice(-8);
            }

            if (confirmed) {
              clearInterval(state.mpesaPollTimer);
              _setMpesaStep(2, 'done');
              _setMpesaStep(3, 'done');

              document.getElementById('mpesa-result').style.display = 'block';
              document.getElementById('mpesa-result').style.background = 'rgba(0,168,78,0.1)';
              document.getElementById('mpesa-result').style.color = '#00a84e';
              document.getElementById('mpesa-result').textContent = `✓ M-PESA confirmed. Ref: ${mpesaRef}`;

              setTimeout(async () => {
                modal.close('mpesa-modal');
                await payment.complete({ method: 'mpesa', amountPaid: total, change: 0, mpesaRef, mpesaPhone: cleanPhone });
              }, 1500);
            }
          } catch (_) {}
        }, 5000);

      } catch (e) {
        _setMpesaStep(1, 'failed');
        document.getElementById('mpesa-result').style.display = 'block';
        document.getElementById('mpesa-result').style.background = 'rgba(239,68,68,0.1)';
        document.getElementById('mpesa-result').style.color = 'var(--red)';
        document.getElementById('mpesa-result').textContent = 'Error: ' + e.message;
        document.getElementById('mpesa-send-btn').disabled = false;
        document.getElementById('mpesa-send-btn').textContent = '📱 Send M-PESA Request';
      }
    },

    cancelSTK() {
      if (state.mpesaPollTimer) { clearInterval(state.mpesaPollTimer); state.mpesaPollTimer = null; }
      state.mpesaCheckoutId = null;
      const sendBtn = document.getElementById('mpesa-send-btn');
      if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = '📱 Send M-PESA Request'; }
      const result = document.getElementById('mpesa-result');
      if (result) result.style.display = 'none';
      [1,2,3].forEach(n => _setMpesaStep(n, null));
      modal.close('mpesa-modal');
    },

    setupDialog() {
      /* Pre-fill shortcode from settings if available */
      const sc = state.settings.mpesaShortcode || '';
      if (sc) document.getElementById('cfg-mpesa-shortcode').value = sc;
      modal.open('mpesa-config-modal');
    },

    async saveConfig() {
      const ck       = (_v('cfg-mpesa-ck')       || '').trim();
      const cs       = (_v('cfg-mpesa-cs')       || '').trim();
      const passkey  = (_v('cfg-mpesa-passkey')  || '').trim();
      const shortcode= (_v('cfg-mpesa-shortcode')|| '').trim();
      const type     = _v('cfg-mpesa-type')       || 'CustomerPayBillOnline';
      const env      = _v('cfg-mpesa-env')        || 'production';

      if (!ck || !cs || !passkey || !shortcode) {
        toast('Fill in all required fields', 'error');
        return;
      }

      const btn = document.getElementById('cfg-mpesa-save-btn');
      btn.disabled = true;
      btn.textContent = 'Saving...';

      try {
        await mpesa.saveCredentials({ ck, cs, passkey, shortcode, type, env });
        await PosDB.settings.setMany({ mpesaConfigured: true, mpesaShortcode: shortcode, mpesaType: type });
        state.settings.mpesaConfigured = true;
        state.settings.mpesaShortcode  = shortcode;

        /* Validate with Cloud Function (test OAuth token generation) */
        if (window.firebaseApp) {
          const { getFunctions, httpsCallable } = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js');
          const fn = getFunctions(window.firebaseApp);
          await httpsCallable(fn, 'validateDarajaCredentials')({});
        }

        const statusEl = document.getElementById('mpesa-config-status');
        if (statusEl) statusEl.textContent = 'Connected ✓';
        modal.close('mpesa-config-modal');
        toast('M-PESA configured successfully!', 'success');
      } catch (e) {
        toast('Save failed: ' + e.message, 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = 'Save & Verify';
      }
    },
  };

  function _setMpesaStep(n, status) {
    const el = document.getElementById(`mpesa-step-${n}`);
    if (!el) return;
    el.classList.remove('active', 'done', 'failed');
    if (status) el.classList.add(status);
    const defaults = ['📱','⏳','✅'];
    const icons    = { active: defaults[n-1], done: '✅', failed: '❌' };
    const iconEl   = el.querySelector('.mpesa-step-icon');
    if (iconEl) iconEl.textContent = (status && icons[status]) ? icons[status] : defaults[n-1];
  }

  /* ═══════════════════════════════════════════════════════════
     BARCODE
  ═══════════════════════════════════════════════════════════ */
  const barcode = {
    scannerOpen: false,

    async toggleScanner() {
      /* On mobile use the full-screen AI scanner */
      if (window.PosMobile && PosMobile.isMobile() && window.PosScanner) {
        PosScanner.open('auto', result => {
          if (result && result.value) handleBarcodeGlobal(result.value);
        });
        return;
      }
      /* Desktop: legacy camera modal */
      if (barcode.scannerOpen) {
        barcode.closeScanner();
        return;
      }
      barcode.scannerOpen = true;
      document.getElementById('scan-btn').classList.add('active');
      modal.open('scanner-modal');
      state.scannerForField = null;
      PosBarcode.setCallback(handleBarcodeGlobal);
      await PosBarcode.startCamera(document.getElementById('scanner-video'), handleBarcodeGlobal);
    },

    closeScanner() {
      barcode.scannerOpen = false;
      document.getElementById('scan-btn').classList.remove('active');
      modal.close('scanner-modal');
      PosBarcode.stopCamera();
      state.scannerForField = null;
      PosBarcode.setCallback(handleBarcodeGlobal);
    },

    async scanForField(fieldId) {
      state.scannerForField = fieldId;
      modal.open('scanner-modal');
      await PosBarcode.startCamera(document.getElementById('scanner-video'), code => {
        const field = document.getElementById(fieldId);
        if (field) field.value = code;
        barcode.closeScanner();
      });
    },

    manualEntry(code) {
      if (!code) return;
      handleBarcodeGlobal(code);
      modal.close('scanner-modal');
    },
  };

  async function handleBarcodeGlobal(code) {
    if (!code) return;

    /* If scanning for a specific field, fill it and stop */
    if (state.scannerForField) {
      const field = document.getElementById(state.scannerForField);
      if (field) { field.value = code; }
      state.scannerForField = null;
      return;
    }

    /* Only handle in checkout mode */
    if (state.currentTab !== 'pos') return;

    const p = await PosDB.products.getByBarcode(code);
    if (p) {
      cart.addByProduct(p);
      if (barcode.scannerOpen) barcode.closeScanner();
    } else {
      /* Unknown barcode — prompt to register */
      document.getElementById('unknown-barcode-val').textContent = code;
      document.getElementById('ub-name').value = '';
      document.getElementById('ub-price').value = '';
      document.getElementById('ub-stock').value = '0';
      /* Store barcode for registration */
      window._pendingBarcode = code;
      modal.open('unknown-barcode-modal');
    }
  }

  /* ═══════════════════════════════════════════════════════════
     INVENTORY
  ═══════════════════════════════════════════════════════════ */
  const inv = {
    async showTab(tab, el) {
      state.invTab = tab;
      document.querySelectorAll('.inv-tab').forEach(b => b.classList.toggle('active', b.dataset.invTab === tab));
      if (el) el.classList.add('active');

      const body = document.getElementById('inv-body');
      body.innerHTML = '<div class="pos-empty" style="padding:40px"><div class="empty-icon">⏳</div><p>Loading...</p></div>';

      switch (tab) {
        case 'products':   await inv.renderProducts(); break;
        case 'low-stock':  await inv.renderLowStock();  break;
        case 'expiry':     await inv.renderExpiry();    break;
        case 'movements':  await inv.renderMovements(); break;
        case 'suppliers':  await inv.renderSuppliers(); break;
      }
    },

    async search(query) {
      const results = await PosDB.products.search(query);
      inv.renderProductTable(results);
    },

    async renderProducts() {
      const all = await PosDB.products.getAll();
      inv.renderProductTable(all);
    },

    renderProductTable(list) {
      const body = document.getElementById('inv-body');
      if (!list.length) { body.innerHTML = '<div class="pos-empty" style="padding:60px"><div class="empty-icon">📦</div><p>No products yet. Click + Add Product to start.</p></div>'; return; }
      body.innerHTML = `<table class="data-table">
        <thead><tr><th>Name</th><th>Barcode</th><th>Category</th><th class="td-right">Price</th><th class="td-right">Cost</th><th class="td-right">Stock</th><th>Unit</th><th>Expiry</th><th>Actions</th></tr></thead>
        <tbody>${list.map(p => {
          const stk = p.stock || 0;
          const cls = stk === 0 ? 'stock-badge stock-out' : (p.lowStockThreshold && stk <= p.lowStockThreshold ? 'stock-badge stock-low' : 'stock-badge stock-ok');
          return `<tr>
            <td><strong>${_esc(p.name)}</strong></td>
            <td style="font-family:monospace;font-size:11px">${p.barcode || '-'}</td>
            <td>${p.category || '-'}</td>
            <td class="td-right">KES ${Number(p.price).toFixed(2)}</td>
            <td class="td-right">${p.cost ? 'KES ' + Number(p.cost).toFixed(2) : '-'}</td>
            <td class="td-right"><span class="${cls}">${stk}</span></td>
            <td>${p.unit || '-'}</td>
            <td style="font-size:11px">${p.expiryDate || '-'}</td>
            <td><div class="row-actions">
              <button class="row-btn" onclick="SPos.inv.editDialog('${p.id}')">Edit</button>
              <button class="row-btn" onclick="SPos.inv.stockInForProduct('${p.id}')">+Stock</button>
              <button class="row-btn" onclick="SPos.inv.printLabel('${p.id}')">Label</button>
              <button class="row-btn danger" onclick="SPos.inv.deleteProduct('${p.id}')">Del</button>
            </div></td>
          </tr>`;
        }).join('')}</tbody>
      </table>`;
    },

    async renderLowStock() {
      const low = await PosDB.products.getLowStock();
      inv.renderProductTable(low);
    },

    async renderExpiry() {
      const exp = await PosDB.products.getExpiringSoon(30);
      inv.renderProductTable(exp);
    },

    async renderMovements() {
      const all = await PosDB.stock_movements.getAll();
      const body = document.getElementById('inv-body');
      if (!all.length) { body.innerHTML = '<div class="pos-empty" style="padding:60px"><div class="empty-icon">📋</div><p>No stock movements yet</p></div>'; return; }
      const sorted = [...all].sort((a, b) => b.timestamp - a.timestamp).slice(0, 200);
      body.innerHTML = `<table class="data-table">
        <thead><tr><th>Date</th><th>Product</th><th>Type</th><th class="td-right">Qty</th><th class="td-right">Before</th><th class="td-right">After</th><th>Reason</th></tr></thead>
        <tbody>${sorted.map(m => `<tr>
          <td style="font-size:11px;white-space:nowrap">${new Date(m.timestamp).toLocaleString('en-KE')}</td>
          <td>${_esc(m.productName || m.productId)}</td>
          <td><span class="stock-badge ${m.type === 'in' ? 'stock-ok' : 'stock-low'}">${m.type}</span></td>
          <td class="td-right">${m.qty}</td>
          <td class="td-right">${m.before}</td>
          <td class="td-right">${m.after}</td>
          <td style="font-size:11px">${m.reason || '-'}</td>
        </tr>`).join('')}</tbody></table>`;
    },

    async renderSuppliers() {
      const all  = await PosDB.suppliers.getAll();
      const body = document.getElementById('inv-body');
      body.innerHTML = `
        <div style="padding:10px;display:flex;gap:8px">
          <button class="inv-btn inv-btn-green" onclick="SPos.inv.addSupplierDialog()">+ Add Supplier</button>
          <button class="inv-btn inv-btn-outline" onclick="SPos.inv.purchaseOrderDialog()">+ Purchase Order</button>
        </div>
        ${all.length ? `<table class="data-table">
          <thead><tr><th>Name</th><th>Phone</th><th>Email</th><th>Actions</th></tr></thead>
          <tbody>${all.map(s => `<tr>
            <td><strong>${_esc(s.name)}</strong></td>
            <td>${s.phone || '-'}</td>
            <td>${s.email || '-'}</td>
            <td><button class="row-btn danger" onclick="SPos.inv.deleteSupplier('${s.id}')">Delete</button></td>
          </tr>`).join('')}</tbody></table>`
        : '<div class="pos-empty" style="padding:40px"><div class="empty-icon">🏭</div><p>No suppliers yet</p></div>'}`;
    },

    addProductDialog() {
      document.getElementById('product-modal-title').textContent = 'Add Product';
      _clearForm(['prod-id','prod-name','prod-barcode','prod-sku','prod-price','prod-cost','prod-stock','prod-low-stock','prod-batch','prod-expiry']);
      _setVal('prod-tax','0');
      inv.populateCategorySelect();
      modal.open('product-modal');
    },

    async editDialog(id) {
      const p = await PosDB.products.getById(id);
      if (!p) return;
      document.getElementById('product-modal-title').textContent = 'Edit Product';
      _setVal('prod-id', p.id);
      _setVal('prod-name', p.name || '');
      _setVal('prod-barcode', p.barcode || '');
      _setVal('prod-sku', p.sku || '');
      _setVal('prod-price', p.price || '');
      _setVal('prod-cost', p.cost || '');
      _setVal('prod-stock', p.stock || 0);
      _setVal('prod-low-stock', p.lowStockThreshold || '');
      _setVal('prod-tax', p.taxRate || 0);
      _setVal('prod-expiry', p.expiryDate || '');
      _setVal('prod-batch', p.batch || '');
      await inv.populateCategorySelect(p.category);
      document.getElementById('prod-unit').value = p.unit || 'piece';
      modal.open('product-modal');
    },

    async populateCategorySelect(selected) {
      const cats = await PosDB.categories.getAll();
      const sel  = document.getElementById('prod-category');
      sel.innerHTML = cats.map(c => `<option value="${_esc(c.id)}" ${c.id === selected ? 'selected' : ''}>${_esc(c.icon || '')} ${_esc(c.name)}</option>`).join('');
    },

    async saveProduct() {
      const name  = _v('prod-name').trim();
      const price = parseFloat(_v('prod-price'));
      if (!name)       { toast('Product name is required', 'error'); return; }
      if (isNaN(price)) { toast('Enter a valid price', 'error'); return; }

      const p = {
        id:             _v('prod-id') || null,
        name,
        barcode:        _v('prod-barcode').trim() || null,
        sku:            _v('prod-sku').trim() || null,
        price,
        cost:           parseFloat(_v('prod-cost'))     || 0,
        stock:          parseFloat(_v('prod-stock'))    || 0,
        lowStockThreshold: parseFloat(_v('prod-low-stock')) || null,
        taxRate:        parseFloat(_v('prod-tax'))      || 0,
        category:       _v('prod-category')             || 'cat_food',
        unit:           _v('prod-unit')                 || 'piece',
        expiryDate:     _v('prod-expiry')               || null,
        batch:          _v('prod-batch').trim()         || null,
      };

      /* Auto-generate barcode if none provided — use timestamp to avoid duplicates */
      if (!p.barcode) {
        const seq = parseInt(Date.now().toString().slice(-7));
        p.barcode = PosBarcode.generateProductBarcode(seq);
      }

      await PosDB.products.save(p);
      await products.reload();
      await inv.renderProducts();
      modal.close('product-modal');
      toast('Product saved', 'success');
    },

    async deleteProduct(id) {
      confirm.show('Delete Product', 'Are you sure you want to delete this product? This cannot be undone.', async () => {
        await PosDB.products.delete(id);
        await products.reload();
        await inv.renderProducts();
        toast('Product deleted', 'info');
      });
    },

    stockInDialog() {
      _clearForm(['si-product-search','si-product-id','si-qty','si-cost','si-expiry','si-notes']);
      _setVal('si-qty', '1');
      document.getElementById('si-product-results').innerHTML = '';
      modal.open('stock-in-modal');
    },

    async stockInForProduct(productId) {
      const p = await PosDB.products.getById(productId);
      if (!p) return;
      inv.stockInDialog();
      _setVal('si-product-search', p.name);
      _setVal('si-product-id', p.id);
    },

    async stockInSearch(query) {
      const results = await PosDB.products.search(query);
      const container = document.getElementById('si-product-results');
      container.innerHTML = results.slice(0, 5).map(p =>
        `<div onclick="document.getElementById('si-product-search').value='${_esc(p.name)}';document.getElementById('si-product-id').value='${p.id}';document.getElementById('si-product-results').innerHTML=''"
          style="padding:8px 10px;border-radius:8px;cursor:pointer;background:var(--card);margin-bottom:4px;font-size:13px">
          ${_esc(p.name)} <span style="color:var(--txt2)">(stock: ${p.stock})</span>
        </div>`
      ).join('');
    },

    async confirmStockIn() {
      const productId = _v('si-product-id');
      const qty       = parseFloat(_v('si-qty')) || 0;
      if (!productId)  { toast('Select a product', 'error'); return; }
      if (qty <= 0)    { toast('Enter quantity > 0', 'error'); return; }

      /* Manager authorization required for stock adjustments */
      if (window.ManagerAuth) {
        const productName = _v('si-product-search') || productId;
        const ok = await ManagerAuth.request('stock_adjustment', {
          product: productName,
          amount: qty,
          cashier: state.currentCashier?.name,
        });
        if (!ok) { toast('Stock adjustment cancelled — authorization denied', 'error'); return; }
      }

      const cost    = parseFloat(_v('si-cost'))   || null;
      const expiry  = _v('si-expiry')            || null;
      const notes   = _v('si-notes').trim()      || 'manual_stock_in';

      await PosDB.products.adjustStock(productId, qty, notes, state.currentCashier?.id);
      if (cost) {
        const p = await PosDB.products.getById(productId);
        if (p) { p.cost = cost; if (expiry) p.expiryDate = expiry; await PosDB.products.save(p); }
      }

      await products.reload();
      await inv.renderProducts();
      modal.close('stock-in-modal');
      toast(`Stock added: +${qty} units`, 'success');
    },

    purchaseOrderDialog() {
      inv.showTab('suppliers');
      ui.switchTab('inventory');
      modal.open('po-modal');
      PosDB.suppliers.getAll().then(sups => {
        const sel = document.getElementById('po-supplier');
        if (sel) sel.innerHTML = sups.map(s => `<option value="${s.id}">${_esc(s.name)}</option>`).join('') || '<option value="">No suppliers yet</option>';
      });
      document.getElementById('po-items-body').innerHTML = '';
      po._addLine();
    },

    async printLabels() {
      const all = await PosDB.products.getAll();
      if (!all.length) { toast('No products to print', 'error'); return; }
      PosPrinter.printLabel(all.slice(0, 30), { businessName: state.settings.bizName });
    },

    async printLabel(id) {
      const p = await PosDB.products.getById(id);
      if (!p) return;
      PosPrinter.printLabel([p], { businessName: state.settings.bizName });
    },

    async registerUnknownBarcode() {
      const code  = window._pendingBarcode;
      const name  = _v('ub-name').trim();
      const price = parseFloat(_v('ub-price')) || 0;
      const stock = parseInt(_v('ub-stock'))   || 0;

      if (!name)       { toast('Enter product name', 'error'); return; }
      if (price <= 0)  { toast('Enter a price', 'error'); return; }

      const p = await PosDB.products.save({ name, barcode: code, price, stock, unit: 'piece', category: 'cat_general' });
      cart.addByProduct(p);
      await products.reload();
      modal.close('unknown-barcode-modal');
      toast('Product registered and added to cart', 'success');
    },

    async addSupplierDialog() {
      modal.open('supplier-modal');
      _clearForm(['sup-name','sup-phone','sup-email','sup-address']);
    },

    async saveSupplier() {
      const name = _v('sup-name').trim();
      if (!name) { toast('Supplier name is required', 'error'); return; }
      await PosDB.suppliers.save({
        name,
        phone:   _v('sup-phone').trim()   || '',
        email:   _v('sup-email').trim()   || '',
        address: _v('sup-address').trim() || '',
      });
      modal.close('supplier-modal');
      await inv.renderSuppliers();
      toast('Supplier added', 'success');
    },

    async deleteSupplier(id) {
      confirm.show('Delete Supplier', 'Remove this supplier?', async () => {
        await PosDB.suppliers.delete(id);
        await inv.renderSuppliers();
      });
    },

    exportCSV: async () => {
      const all = await PosDB.products.getAll();
      const headers = ['Name','Barcode','SKU','Price','Cost','Stock','Unit','Category','Tax%','ExpiryDate'];
      const rows    = all.map(p => [p.name, p.barcode||'', p.sku||'', p.price||0, p.cost||0, p.stock||0, p.unit||'', p.category||'', p.taxRate||0, p.expiryDate||''].join(','));
      const csv     = [headers.join(','), ...rows].join('\n');
      const a       = document.createElement('a');
      a.href        = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
      a.download    = 'inventory_' + new Date().toISOString().split('T')[0] + '.csv';
      a.click();
    },
  };

  /* ═══════════════════════════════════════════════════════════
     REPORTS
  ═══════════════════════════════════════════════════════════ */
  const reports = {
    setRange(range) {
      const _localISO = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      const now   = new Date();
      const from  = new Date();
      if (range === 'week')  from.setDate(now.getDate() - 7);
      if (range === 'month') from.setDate(1);
      document.getElementById('rep-date-from').value = _localISO(from);
      document.getElementById('rep-date-to').value   = _localISO(now);
      /* Respect active sub-tab */
      const activeSubTab = document.querySelector('.rep-subtab.active')?.dataset.subtab;
      if (activeSubTab === 'transactions') sales.showHistory();
      else reports.load();
    },

    switchSubTab(subtab) {
      document.querySelectorAll('.rep-subtab').forEach(b => b.classList.toggle('active', b.dataset.subtab === subtab));
      if (subtab === 'summary')      reports.load();
      if (subtab === 'transactions') sales.showHistory();
    },

    async load() {
      const fromStr = _v('rep-date-from');
      const toStr   = _v('rep-date-to');
      const from    = fromStr ? new Date(fromStr).setHours(0,0,0,0) : new Date().setHours(0,0,0,0);
      const to      = toStr   ? new Date(toStr).setHours(23,59,59,999) : new Date().setHours(23,59,59,999);

      const body   = document.getElementById('reports-body');
      body.innerHTML = '<div class="pos-empty"><div class="empty-icon">⏳</div><p>Generating...</p></div>';

      const r = await PosDB.reports.forDateRange(from, to);
      const margin = r.total > 0 ? ((r.profit / r.total) * 100).toFixed(1) : '0.0';

      body.innerHTML = `
        <div class="kpi-grid">
          <div class="kpi-card"><div class="kpi-label">TOTAL SALES</div><div class="kpi-val green">KES ${_fmt(r.total)}</div><div class="kpi-sub">${r.count} transactions</div></div>
          <div class="kpi-card"><div class="kpi-label">GROSS PROFIT</div><div class="kpi-val green">KES ${_fmt(r.profit)}</div><div class="kpi-sub">${margin}% margin</div></div>
          <div class="kpi-card"><div class="kpi-label">CASH</div><div class="kpi-val">KES ${_fmt(r.cash)}</div></div>
          <div class="kpi-card"><div class="kpi-label">M-PESA</div><div class="kpi-val">KES ${_fmt(r.mpesa)}</div></div>
          <div class="kpi-card"><div class="kpi-label">CARD</div><div class="kpi-val">KES ${_fmt(r.card)}</div></div>
          <div class="kpi-card"><div class="kpi-label">VAT COLLECTED</div><div class="kpi-val amber">KES ${_fmt(r.tax)}</div></div>
          <div class="kpi-card"><div class="kpi-label">DISCOUNTS GIVEN</div><div class="kpi-val">KES ${_fmt(r.discount)}</div></div>
          <div class="kpi-card"><div class="kpi-label">AVG SALE</div><div class="kpi-val">KES ${r.count ? _fmt(r.total / r.count) : '0.00'}</div></div>
        </div>
        <div class="section-title">Top Products</div>
        ${r.topProducts.length ? `<table class="data-table">
          <thead><tr><th>#</th><th>Product</th><th class="td-right">Qty Sold</th><th class="td-right">Revenue</th><th class="td-right">Profit</th></tr></thead>
          <tbody>${r.topProducts.map((p, i) => `<tr>
            <td style="color:var(--txt2)">${i+1}</td>
            <td><strong>${_esc(p.name)}</strong></td>
            <td class="td-right">${p.qty}</td>
            <td class="td-right">KES ${_fmt(p.revenue)}</td>
            <td class="td-right" style="color:var(--green)">KES ${_fmt(p.profit)}</td>
          </tr>`).join('')}</tbody>
        </table>` : '<div class="pos-empty"><p>No sales in this period</p></div>'}
      `;
    },

    async printReport() {
      const body = document.getElementById('reports-body').innerHTML;
      const html = `<html><head><title>Sales Report</title><style>body{font-family:Arial,sans-serif;padding:20px}table{width:100%;border-collapse:collapse}th,td{padding:8px;border:1px solid #ddd;text-align:left}th{background:#f5f5f5}.kpi-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:20px}.kpi-card{border:1px solid #ddd;padding:12px;border-radius:8px}.kpi-val{font-size:18px;font-weight:bold}</style></head><body>${body}<script>window.print()<\/script></body></html>`;
      const bu = URL.createObjectURL(new Blob([html], {type:'text/html;charset=utf-8'}));
      const w  = window.open(bu, '_blank', 'width=700,height=600');
      if (w) setTimeout(() => URL.revokeObjectURL(bu), 10000); else URL.revokeObjectURL(bu);
    },
  };

  /* ═══════════════════════════════════════════════════════════
     CUSTOMERS
  ═══════════════════════════════════════════════════════════ */
  const customers = {
    async loadTable() {
      const all  = await PosDB.customers.getAll();
      const body = document.getElementById('customers-body');
      if (!all.length) { body.innerHTML = '<div class="pos-empty"><div class="empty-icon">👤</div><p>No customers yet</p></div>'; return; }
      body.innerHTML = `<table class="data-table">
        <thead><tr><th>Name</th><th>Phone</th><th>Email</th><th class="td-right">Total Spent</th><th class="td-right">Points</th><th>Last Visit</th><th>Actions</th></tr></thead>
        <tbody>${all.map(c => `<tr>
          <td><strong>${_esc(c.name || '-')}</strong></td>
          <td>${c.phone || '-'}</td>
          <td>${c.email || '-'}</td>
          <td class="td-right">KES ${_fmt(c.totalSpent || 0)}</td>
          <td class="td-right">${c.points || 0}</td>
          <td style="font-size:11px">${c.lastVisit ? new Date(c.lastVisit).toLocaleDateString('en-KE') : '-'}</td>
          <td><div class="row-actions"><button class="row-btn" onclick="SPos.customers.viewHistory('${c.id}')">History</button><button class="row-btn danger" onclick="SPos.customers.delete('${c.id}')">Del</button></div></td>
        </tr>`).join('')}</tbody></table>`;
    },

    async viewHistory(customerId) {
      const c   = await PosDB.customers.getById(customerId);
      if (!c) return;
      const all = await PosDB.transactions.getAll();
      const txns = all.filter(t => t.customerId === customerId && t.status === 'completed')
                      .sort((a, b) => b.completedAt - a.completedAt)
                      .slice(0, 50);
      const body = `
        <div style="margin-bottom:12px;font-size:13px;color:var(--txt2)">
          <strong>${_esc(c.name || c.phone)}</strong> · ${c.phone || ''} · 🎯 ${c.points || 0} points · KES ${_fmt(c.totalSpent || 0)} spent
        </div>
        ${txns.length ? `<table class="data-table">
          <thead><tr><th>Date</th><th>Receipt</th><th>Items</th><th class="td-right">Total</th><th>Payment</th><th>Actions</th></tr></thead>
          <tbody>${txns.map(t => `<tr>
            <td style="font-size:11px">${new Date(t.completedAt || t.timestamp).toLocaleString('en-KE')}</td>
            <td style="font-family:monospace;font-size:11px">${t.receiptNo || '-'}</td>
            <td>${(t.items||[]).length}</td>
            <td class="td-right">KES ${_fmt(t.total)}</td>
            <td><span class="stock-badge ${t.paymentMethod==='mpesa'?'stock-ok':'stock-low'}">${(t.paymentMethod||'cash').toUpperCase()}</span></td>
            <td><button class="row-btn" onclick="SPos.sales.reprint('${t.id}')">Reprint</button><button class="row-btn" onclick="SPos.sales.refundDialog('${t.id}')">Refund</button></td>
          </tr>`).join('')}</tbody>
        </table>` : '<div class="pos-empty"><p>No transactions</p></div>'}
      `;
      confirm.show('Customer History — ' + (c.name || c.phone), body, null);
    },

    async search(query) {
      const results = await PosDB.customers.search(query);
      const body    = document.getElementById('customers-body');
      if (!results.length) { body.innerHTML = '<div class="pos-empty"><p>No matching customers</p></div>'; return; }
      body.innerHTML = `<table class="data-table">
        <thead><tr><th>Name</th><th>Phone</th><th>Email</th><th class="td-right">Total Spent</th><th class="td-right">Points</th><th>Last Visit</th><th>Actions</th></tr></thead>
        <tbody>${results.map(c => `<tr>
          <td><strong>${_esc(c.name || '-')}</strong></td>
          <td>${c.phone || '-'}</td>
          <td>${c.email || '-'}</td>
          <td class="td-right">KES ${_fmt(c.totalSpent || 0)}</td>
          <td class="td-right">${c.points || 0}</td>
          <td style="font-size:11px">${c.lastVisit ? new Date(c.lastVisit).toLocaleDateString('en-KE') : '-'}</td>
          <td><div class="row-actions"><button class="row-btn" onclick="SPos.customers.viewHistory('${c.id}')">History</button><button class="row-btn danger" onclick="SPos.customers.delete('${c.id}')">Del</button></div></td>
        </tr>`).join('')}</tbody></table>`;
    },

    selectDialog() {
      _clearForm(['cust-modal-name','cust-modal-phone','cust-modal-email','cust-modal-search']);
      document.getElementById('cust-modal-results').innerHTML = '';
      modal.open('customer-modal');
    },

    async modalSearch(query) {
      if (query.length < 2) return;
      const results = await PosDB.customers.search(query);
      const container = document.getElementById('cust-modal-results');
      container.innerHTML = results.slice(0, 5).map(c =>
        `<div onclick="SPos.customers.selectExisting('${c.id}')" style="padding:8px 10px;border-radius:8px;cursor:pointer;background:var(--card);margin-bottom:4px;font-size:12px">
          <strong>${_esc(c.name || '-')}</strong> · ${c.phone || '-'} · 🎯 ${c.points || 0} pts
        </div>`
      ).join('');
    },

    async selectExisting(id) {
      const c = await PosDB.customers.getById(id);
      if (!c) return;
      state.currentCustomer = c;
      const btn = document.getElementById('customer-btn');
      btn.textContent = `👤 ${c.name || c.phone}`;
      btn.classList.add('active');
      modal.close('customer-modal');
      toast('Customer: ' + (c.name || c.phone), 'success');
    },

    selectWalkin() {
      state.currentCustomer = null;
      document.getElementById('customer-btn').textContent = '👤 Walk-in Customer';
      document.getElementById('customer-btn').classList.remove('active');
      modal.close('customer-modal');
    },

    async saveAndSelect() {
      const phone = _v('cust-modal-phone').replace(/\s/g, '');
      const name  = _v('cust-modal-name').trim();
      if (!phone) { toast('Phone number required', 'error'); return; }

      let c = await PosDB.customers.getByPhone(phone);
      if (!c) {
        c = await PosDB.customers.save({ name: name || 'Customer', phone, email: _v('cust-modal-email').trim(), points: 0, totalSpent: 0, visits: 0 });
      }
      await customers.selectExisting(c.id);
    },

    addDialog() { customers.selectDialog(); },

    async delete(id) {
      confirm.show('Delete Customer', 'Remove this customer? Their purchase history is preserved.', async () => {
        await PosDB.customers.save(await PosDB.customers.getById(id).then(c => ({ ...c, active: false })));
        await customers.loadTable();
      });
    },

    exportCSV: async () => {
      const all = await PosDB.customers.getAll();
      const rows = all.map(c => [c.name||'',c.phone||'',c.email||'',c.totalSpent||0,c.points||0,c.visits||0].join(','));
      const csv  = ['Name,Phone,Email,TotalSpent,Points,Visits', ...rows].join('\n');
      const a    = document.createElement('a');
      a.href     = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
      a.download = 'customers_' + new Date().toISOString().split('T')[0] + '.csv';
      a.click();
    },
  };

  /* ═══════════════════════════════════════════════════════════
     CASHIER
  ═══════════════════════════════════════════════════════════ */
  const cashier = {
    _pinBuffer: '',

    /* Cashier login session — persisted so POS does not re-prompt for the PIN on every
       reload/navigation. Stores identity ONLY (never the PIN/hash). Sliding TTL: an active
       cashier stays logged in; after this idle window POS re-prompts. This is operator
       identity (SOKONI "Auth" layer) — NOT money authorization; refunds/voids/discounts keep
       their own independent manager-PIN gate, which is never persisted here. */
    _SESSION_KEY: 'sokoni_pos_cashier_session',
    _SESSION_TTL_MS: 14 * 60 * 60 * 1000,   /* 14h — one long workday */

    _persistSession(c) {
      try {
        localStorage.setItem(cashier._SESSION_KEY, JSON.stringify({
          id: c.id, name: c.name, role: c.role || 'cashier', at: Date.now(),
        }));
      } catch (_) {}
    },
    _clearSession() { try { localStorage.removeItem(cashier._SESSION_KEY); } catch (_) {} },

    /* Restore a still-valid cashier session on boot so we skip the PIN. Returns true only if
       the session exists, is within the TTL, AND the cashier still exists and is active
       locally. Slides the TTL on success and silently restores an open shift. */
    async restoreSession(cashiers) {
      let s;
      try { s = JSON.parse(localStorage.getItem(cashier._SESSION_KEY) || 'null'); } catch (_) { s = null; }
      if (!s || !s.id || !s.at) return false;
      if (Date.now() - s.at > cashier._SESSION_TTL_MS) { cashier._clearSession(); return false; }
      const roster = cashiers || await PosDB.cashiers.getAll();
      const c = roster.find(x => x.id === s.id && x.active !== false);
      if (!c) { cashier._clearSession(); return false; }
      state.currentCashier = c;
      cashier._persistSession(c);                 /* slide the idle window */
      _setVal('cashier-avatar', c.name ? c.name[0].toUpperCase() : '?');
      _setVal('cashier-name-hdr', c.name || 'Cashier');
      try {
        const existingShift = await PosDB.shifts.getCurrent(c.id);
        if (existingShift) { state.currentShift = existingShift; shift.updateBadge(); }
      } catch (_) {}
      return true;
    },

    /* Explicit sign-out: clear the persisted session and re-show the PIN. */
    logout() {
      cashier._clearSession();
      state.currentCashier = null;
      cashier.showSwitchDialog();
    },

    showSwitchDialog() {
      cashier._pinBuffer = '';
      cashier.updatePinDots();
      document.getElementById('pin-error').textContent = '';
      try { profile.fillPinModal(); } catch (_) {}
      modal.open('pin-modal');
    },

    pin(key) {
      if (key === 'clear') { cashier._pinBuffer = ''; cashier.updatePinDots(); return; }
      if (key === 'back')  { cashier._pinBuffer = cashier._pinBuffer.slice(0, -1); cashier.updatePinDots(); return; }
      if (cashier._pinBuffer.length >= 4) return;
      cashier._pinBuffer += key;
      cashier.updatePinDots();
      if (cashier._pinBuffer.length === 4) {
        setTimeout(cashier.verifyPin, 200);
      }
    },

    updatePinDots() {
      for (let i = 1; i <= 4; i++) {
        document.getElementById(`pd-${i}`).classList.toggle('filled', i <= cashier._pinBuffer.length);
      }
    },

    async verifyPin() {
      /* Brute-force lockout check */
      if (window.PosHealth) {
        const lockStatus = PosHealth.isPinLocked('all');
        if (lockStatus?.locked) {
          document.getElementById('pin-error').textContent =
            `Too many attempts — locked for ${lockStatus.remainSec}s`;
          cashier._pinBuffer = ''; cashier.updatePinDots(); return;
        }
      }

      const c = await PosDB.cashiers.authenticate(cashier._pinBuffer);
      if (c) {
        if (window.PosHealth) await PosHealth.recordPinAttempt('all', true);
        state.currentCashier = c;
        cashier._persistSession(c);
        _setVal('cashier-avatar', c.name ? c.name[0].toUpperCase() : '?');
        _setVal('cashier-name-hdr', c.name || 'Cashier');
        modal.close('pin-modal');
        toast(`Welcome, ${c.name}!`, 'success');

        /* Auto-open/check shift */
        const existingShift = await PosDB.shifts.getCurrent(c.id);
        if (!existingShift) shift.showDialog();
        else { state.currentShift = existingShift; shift.updateBadge(); }
      } else {
        const lockResult = window.PosHealth ? await PosHealth.recordPinAttempt('all', false) : false;
        const errMsg = lockResult === 'locked'
          ? 'Too many failed attempts — locked for 5 minutes'
          : 'Incorrect PIN. Try again.';
        document.getElementById('pin-error').textContent = errMsg;
        cashier._pinBuffer = '';
        cashier.updatePinDots();
      }
    },

    addDialog() {
      modal.open('cashier-add-modal');
      _clearForm(['new-cashier-name','new-cashier-pin','new-cashier-pin2']);
      document.getElementById('new-cashier-role').value = 'cashier';
    },

    async saveNew() {
      const name  = _v('new-cashier-name').trim();
      const pin   = _v('new-cashier-pin').trim();
      const pin2  = _v('new-cashier-pin2').trim();
      const role  = _v('new-cashier-role');
      if (!name)                           { toast('Name is required', 'error'); return; }
      if (!/^\d{4}$/.test(pin))            { toast('PIN must be exactly 4 digits', 'error'); return; }
      if (pin !== pin2)                    { toast('PINs do not match', 'error'); return; }
      /* Check duplicate PIN */
      const existing = await PosDB.cashiers.authenticate(pin);
      if (existing) { toast('This PIN is already in use — choose another', 'error'); return; }
      await PosDB.cashiers.save({ name, pin, role: role || 'cashier', active: true, createdAt: Date.now() });
      modal.close('cashier-add-modal');
      cashier.renderList();
      toast('Cashier added: ' + name, 'success');
      if (window.PosAudit) PosAudit.log('cashier_added', { name, role });
    },

    async renderList() {
      const all = await PosDB.cashiers.getAll();
      const container = document.getElementById('cashiers-list');
      container.innerHTML = all.map(c =>
        `<div class="settings-row">
          <div class="settings-row-label"><strong>${_esc(c.name)}</strong><span>${c.role} · PIN: ****</span></div>
          <button class="row-btn danger" onclick="SPos.cashier.delete('${c.id}')">Remove</button>
        </div>`
      ).join('');
    },

    async delete(id) {
      confirm.show('Remove Cashier', 'Remove this cashier account?', async () => {
        await PosDB.cashiers.delete(id);
        cashier.renderList();
      });
    },
  };

  /* ═══════════════════════════════════════════════════════════
     SHIFT
  ═══════════════════════════════════════════════════════════ */
  const shift = {
    updateBadge() {
      const badge = document.getElementById('shift-badge');
      if (state.currentShift) {
        badge.textContent = 'Shift Open';
        badge.classList.remove('closed');
      } else {
        badge.textContent = 'No Shift';
        badge.classList.add('closed');
      }
    },

    showDialog() {
      if (!state.currentCashier) { cashier.showSwitchDialog(); return; }

      const isOpen = !!state.currentShift;
      document.getElementById('shift-modal-title').textContent = isOpen ? 'End Shift' : 'Open Shift';
      document.getElementById('shift-modal-btn').textContent   = isOpen ? 'End Shift' : 'Open Shift';

      if (isOpen) {
        const s = state.currentShift;
        document.getElementById('shift-modal-body').innerHTML = `
          <div style="font-size:13px;color:var(--txt2);line-height:2">
            <div><strong>Cashier:</strong> ${s.cashierName}</div>
            <div><strong>Opened:</strong> ${new Date(s.openTime).toLocaleString('en-KE')}</div>
            <div><strong>Transactions:</strong> ${s.transactionCount}</div>
            <div><strong>Total Sales:</strong> KES ${_fmt(s.totalSales)}</div>
            <div><strong>Cash:</strong> KES ${_fmt(s.totalCash)}</div>
            <div><strong>M-PESA:</strong> KES ${_fmt(s.totalMpesa)}</div>
          </div>
          <div class="form-field" style="margin-top:12px">
            <label class="form-label">CLOSING CASH AMOUNT (KES)</label>
            <input class="form-input" id="shift-close-amount" type="number" min="0" placeholder="Count cash in drawer">
          </div>`;
      } else {
        document.getElementById('shift-modal-body').innerHTML = `
          <div style="font-size:13px;color:var(--txt2);margin-bottom:12px">Opening a shift starts a new sales session for ${state.currentCashier.name}.</div>
          <div class="form-field">
            <label class="form-label">OPENING CASH AMOUNT (KES)</label>
            <input class="form-input" id="shift-open-amount" type="number" min="0" placeholder="Float amount" value="0">
          </div>`;
      }

      modal.open('shift-modal');
    },

    async modalAction() {
      if (state.currentShift) {
        const closeAmt = parseFloat(document.getElementById('shift-close-amount')?.value) || 0;

        /* Manager authorization required to close shift */
        if (window.ManagerAuth) {
          const ok = await ManagerAuth.request('shift_close', {
            amount: closeAmt,
            cashier: state.currentCashier?.name,
          });
          if (!ok) { toast('Shift close cancelled — authorization denied', 'error'); return; }
        }

        const closed   = await PosDB.shifts.close(state.currentShift.id, closeAmt);
        state.currentShift = null;
        shift.updateBadge();
        modal.close('shift-modal');
        toast('Shift ended. Total: KES ' + _fmt(closed?.totalSales || 0), 'info');
        if (closed) PosPrinter.printBrowser({ businessName: state.settings.bizName, receiptNo: 'SHIFT-' + closed.id.slice(-6), cashierName: closed.cashierName, items: [], subtotal: 0, total: closed.totalSales, paymentMethod: 'shift_summary', amountPaid: closed.totalSales, footerMessage: `Cash: KES ${_fmt(closed.totalCash)} | M-PESA: KES ${_fmt(closed.totalMpesa)} | Variance: KES ${_fmt(closed.variance||0)}` });
      } else {
        const openAmt = parseFloat(document.getElementById('shift-open-amount')?.value) || 0;
        const s = await PosDB.shifts.open(state.currentCashier.id, state.currentCashier.name, openAmt);
        state.currentShift = s;
        shift.updateBadge();
        modal.close('shift-modal');
        toast('Shift opened', 'success');
      }
    },
  };

  /* ═══════════════════════════════════════════════════════════
     SUCCESS OVERLAY — always wired regardless of PosBoss
  ═══════════════════════════════════════════════════════════ */
  function _showSuccessOverlay(receiptData) {
    const el = document.getElementById('success-overlay');
    if (!el) return;

    _setVal('suc-total',      'KES ' + _fmt(receiptData.total));
    _setVal('suc-method',     (receiptData.paymentMethod || 'CASH').toUpperCase());
    _setVal('suc-receipt-no', receiptData.receiptNo || '');
    _setVal('suc-customer',   receiptData.customerName || 'Walk-in');
    _setVal('suc-cashier',    receiptData.cashierName  || '');

    const changeRow = document.getElementById('suc-change-row');
    if (changeRow) {
      changeRow.style.display = (receiptData.change || 0) > 0 ? '' : 'none';
      _setVal('suc-change', 'KES ' + _fmt(receiptData.change || 0));
    }
    const mpesaRow = document.getElementById('suc-mpesa-row');
    if (mpesaRow) {
      mpesaRow.style.display = receiptData.mpesaRef ? '' : 'none';
      _setVal('suc-mpesa-ref', receiptData.mpesaRef || '');
    }

    /* Wire Print button — order-centric: the tap ensures the printer is connected (silent →
       chooser) THEN prints, so the cashier never sees a reconnect screen after a sale. */
    const printBtn = document.getElementById('suc-print-btn');
    if (printBtn) {
      printBtn.onclick = () => {
        if (window.PosPrintService && typeof PosPrintService.smartPrint === 'function') {
          PosPrintService.smartPrint(receiptData, { fromSuccess: true }).catch(() => { try { PosPrinter.print(receiptData); } catch (_) {} });
        } else {
          PosPrinter.print(receiptData).catch(() => {});
        }
      };
    }

    /* Wire WhatsApp button */
    const waBtn = document.getElementById('suc-whatsapp-btn');
    if (waBtn) {
      waBtn.onclick = () => {
        const phone = receiptData.mpesaPhone || state.currentCustomer?.phone || '';
        const cleaned = phone.replace(/\D/g, '');
        const e164 = cleaned.startsWith('254') ? cleaned : cleaned.startsWith('0') ? '254' + cleaned.slice(1) : cleaned;
        const lines = [
          `*${receiptData.businessName || 'SOKONI SmartPOS'}*`,
          `Receipt: ${receiptData.receiptNo}`,
          `Date: ${new Date().toLocaleString('en-KE')}`,
          '',
          ...(receiptData.items || []).map(i => `${i.name} x${i.qty} — KES ${_fmt(i.qty * i.price)}`),
          '',
          `*TOTAL: KES ${_fmt(receiptData.total)}*`,
          `Payment: ${(receiptData.paymentMethod || 'Cash').toUpperCase()}`,
          receiptData.mpesaRef ? `M-PESA Ref: ${receiptData.mpesaRef}` : '',
          '',
          'Thank you for shopping with us!',
        ].filter(l => l !== undefined);
        const msg = encodeURIComponent(lines.join('\n'));
        window.open(`https://wa.me/${e164}?text=${msg}`, '_blank');
      };
    }

    /* Pass receipt data to Phase 7 preview helper */
    if (typeof _p7SetReceiptData === 'function') _p7SetReceiptData(receiptData);

    el.classList.add('open');
    const autoClose = setTimeout(() => el.classList.remove('open'), 8000);

    /* Robust close: a single canonical closer used by the ✕/"Tap to close" button AND by
       tapping the backdrop (outside the modal). Guarantees an escape even if the modal is
       taller than the screen. Idempotent; clears the auto-close timer. */
    const closeSuccess = () => { clearTimeout(autoClose); el.classList.remove('open'); };
    el.onclick = (e) => { if (e.target === el) closeSuccess(); };   /* backdrop tap */
    const closeBtn = el.querySelector('.suc-close-btn');
    if (closeBtn) closeBtn.onclick = closeSuccess;
  }

  /* ═══════════════════════════════════════════════════════════
     SALES HISTORY & REPRINT
  ═══════════════════════════════════════════════════════════ */
  /* ═══════════════════════════════════════════════════════════════════
     MORE — merchant control center (R1.1). Surfaces every module so the
     merchant never has to "leave the POS". In-shell modules route through
     SPos.ui.switchTab (no reload — printer, cart, listeners preserved).
     Management pages navigate SAME-TAB (never a new window/PWA — single
     instance), and the printer silently auto-reconnects on return.
  ═══════════════════════════════════════════════════════════════════ */
  const more = {
    _stylesInjected: false,
    _injectStyles() {
      if (more._stylesInjected) return;
      more._stylesInjected = true;
      const css = `
        .more-wrap{padding:14px 14px 100px;max-width:860px;margin:0 auto}
        .more-group{margin-bottom:20px}
        .more-group-title{font-size:11px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:var(--txt3);margin:0 4px 10px}
        .more-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(104px,1fr));gap:10px}
        .more-card{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:15px 10px;display:flex;flex-direction:column;align-items:center;gap:8px;cursor:pointer;text-align:center;transition:transform .12s ease,border-color .12s ease,background .12s ease;color:var(--txt);text-decoration:none}
        .more-card:hover{transform:translateY(-2px);border-color:rgba(113,255,0,.4);background:rgba(113,255,0,.05)}
        .more-card:active{transform:translateY(0)}
        .more-ico{font-size:24px;line-height:1}
        .more-lbl{font-size:11.5px;font-weight:700;line-height:1.25}
        .more-card .more-ext{position:absolute}
        .more-card.ext .more-lbl::after{content:' ↗';color:var(--txt3);font-size:10px}`;
      const s = document.createElement('style'); s.id = 'more-styles'; s.textContent = css;
      document.head.appendChild(s);
    },

    /* Each item: [icon, label, kind, target]
       kind 'tab'    → in-shell SPos.ui.switchTab (no reload)
       kind 'nav'    → same-tab navigation to a management page (single instance)
       kind 'action' → an in-POS overlay (printer menu / device hub) */
    /* Every entry routes to a VERIFIED destination — in-shell tab, an existing page, or a
       seller-dashboard section deep-link (seller.html#<data-sdtab>; the dashboard reads
       location.hash). No dead links. */
    _groups: [
      ['Operations', [
        ['🛒', 'Checkout', 'tab', 'pos'],
        ['🧾', 'Orders', 'tab', 'orders'],
        ['🚚', 'Dispatch', 'nav', 'dispatch.html'],
        ['📦', 'Inventory', 'tab', 'inventory'],
        ['👥', 'Customers', 'tab', 'customers'],
        ['🔧', 'Repairs', 'tab', 'repair'],
      ]],
      ['Business', [
        ['🏪', 'Shop Dashboard', 'nav', 'seller.html'],
        ['💰', 'Finance', 'tab', 'finance'],
        ['📊', 'Reports', 'tab', 'reports'],
        ['📈', 'Analytics', 'nav', 'analytics.html'],
        ['👨‍🔧', 'Employees', 'nav', 'seller.html#team'],
        ['🎁', 'Promotions', 'nav', 'seller.html#flash'],
        ['⭐', 'Loyalty', 'nav', 'loyalty.html'],
        ['📣', 'Marketing', 'nav', 'seller.html#market'],
        ['🧾', 'Tax / KRA', 'nav', 'seller.html#kra'],
      ]],
      ['Orders & Money', [
        ['🧾', 'Receipts', 'tab', 'orders'],
        ['🔄', 'Refunds', 'tab', 'orders'],
        ['⚖️', 'Disputes', 'nav', 'seller.html#disputes'],
      ]],
      ['Communications', [
        ['💬', 'Messages', 'nav', 'seller.html#inbox'],
        ['🔔', 'Notifications', 'nav', 'notifications.html'],
      ]],
      ['System', [
        ['🖨️', 'Printer', 'action', 'printer'],
        ['🔌', 'Devices', 'action', 'devices'],
        ['☁️', 'Sync & Data', 'tab', 'settings'],
        ['📡', 'BOS Hub', 'tab', 'bos'],
        ['📋', 'Audit', 'tab', 'audit'],
        ['⚙️', 'POS Settings', 'tab', 'settings'],
        ['⛶', 'Full Screen', 'action', 'fullscreen'],
      ]],
    ],

    render() {
      more._injectStyles();
      const body = document.getElementById('more-body');
      if (!body) return;
      body.innerHTML = '<div class="more-wrap">' + more._groups.map(([title, items]) => `
        <div class="more-group">
          <div class="more-group-title">${title}</div>
          <div class="more-grid">${items.map(([ico, lbl, kind, target]) =>
            `<div class="more-card ${kind === 'nav' ? 'ext' : ''}" role="button" tabindex="0"
                 onclick="SPos.more.go('${kind}','${target}')"
                 onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();SPos.more.go('${kind}','${target}')}">
               <span class="more-ico">${ico}</span><span class="more-lbl">${_esc(lbl)}</span>
             </div>`).join('')}</div>
        </div>`).join('') + '</div>';
    },

    go(kind, target) {
      if (kind === 'tab') { ui.switchTab(target); return; }
      if (kind === 'nav') { window.location.href = target; return; }   /* same tab — single instance */
      if (kind === 'action') {
        if (target === 'printer') { if (window.openPrinterMenu) window.openPrinterMenu(); return; }
        if (target === 'devices') { try { SPos.deviceHub && SPos.deviceHub.showPanel && SPos.deviceHub.showPanel(); } catch (_) {} return; }
        if (target === 'fullscreen') { try { window.posToggleFullscreen && window.posToggleFullscreen(); } catch (_) {} return; }
      }
    },
  };

  /* ═══════════════════════════════════════════════════════════════════
     ORDERS HUB (R1.1 Phase 1) — one place for every completed transaction.
     Phase 1: live In-Store POS sales (canonical PosDB.transactions) with
     reprint / refund / details, plus scaffolded channel tabs. Online /
     Delivery / Pickup marketplace orders wire in Phase 2. No fabricated
     metrics — unknown online figures render as "—", never 0.
  ═══════════════════════════════════════════════════════════════════ */
  const orders = {
    _filter: 'all',
    _inStore: [],
    _stylesInjected: false,

    _injectStyles() {
      if (orders._stylesInjected) return;
      orders._stylesInjected = true;
      const css = `
        .ord-wrap{padding:12px 14px 90px;max-width:820px;margin:0 auto}
        .ord-summary{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:14px}
        .ord-summary-wide{grid-template-columns:repeat(auto-fill,minmax(94px,1fr))}
        .ord-stat{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:12px 10px;text-align:center}
        .ord-stat-n{font-size:19px;font-weight:900;color:#71ff00;line-height:1.1}
        .ord-stat-l{font-size:10.5px;color:var(--txt2);text-transform:uppercase;letter-spacing:.04em;margin-top:4px}
        .ord-tabs{display:flex;gap:7px;overflow-x:auto;padding-bottom:8px;margin-bottom:6px;scrollbar-width:none}
        .ord-tabs::-webkit-scrollbar{display:none}
        .ord-tab{flex:0 0 auto;background:var(--card);border:1px solid var(--border);color:var(--txt2);border-radius:20px;padding:7px 13px;font-size:12px;font-weight:700;cursor:pointer;white-space:nowrap}
        .ord-tab.active{background:rgba(113,255,0,.12);border-color:rgba(113,255,0,.4);color:#71ff00}
        .ord-list{display:flex;flex-direction:column;gap:10px}
        .ord-card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:13px 15px}
        .ord-card-top{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin-bottom:10px}
        .ord-card-id{font-weight:800;font-size:14px}
        .ord-card-sub{font-size:11.5px;color:var(--txt2);margin-top:2px}
        .ord-card-amt{font-weight:900;font-size:15px}
        .ord-card-when{font-size:10.5px;color:var(--txt3);margin-top:2px;white-space:nowrap}
        .ord-card-foot{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap}
        .ord-card-actions{display:flex;gap:6px;flex-wrap:wrap}
        .ord-badge{font-size:10.5px;font-weight:800;padding:3px 9px;border-radius:20px}
        .ord-ok{background:rgba(113,255,0,.13);color:#71ff00}
        .ord-warn{background:rgba(255,180,0,.14);color:#ffb400}
        .ord-bad{background:rgba(255,80,80,.14);color:#ff6464}
        .ord-det-overlay{position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:100000;display:flex;align-items:center;justify-content:center;padding:16px}
        .ord-det-card{background:var(--bg2,#0d0d0d);border:1px solid var(--border);border-radius:16px;width:100%;max-width:400px;max-height:86vh;overflow:auto}
        .ord-det-head{display:flex;justify-content:space-between;align-items:center;padding:14px 16px;border-bottom:1px solid var(--border);position:sticky;top:0;background:var(--bg2,#0d0d0d)}
        .ord-det-head button{background:none;border:none;color:var(--txt2);font-size:16px;cursor:pointer}
        .ord-det-body{padding:14px 16px}
        .ord-det-row{display:flex;justify-content:space-between;gap:12px;font-size:13px;padding:4px 0;color:var(--txt)}
        .ord-det-row span:first-child{color:var(--txt2)}
        .ord-det-total{font-weight:900;font-size:15px;border-top:1px solid var(--border);margin-top:6px;padding-top:9px}
        .ord-det-body hr{border:none;border-top:1px solid var(--border);margin:9px 0}
        .ord-det-foot{padding:12px 16px;border-top:1px solid var(--border)}`;
      const s = document.createElement('style'); s.id = 'ord-styles'; s.textContent = css;
      document.head.appendChild(s);
    },

    _range: 'today',

    async render() {
      orders._injectStyles();
      const body = document.getElementById('orders-body');
      if (!body) return;
      body.innerHTML = '<div class="pos-empty"><div class="empty-icon">⏳</div><p>Loading orders…</p></div>';
      /* Load by the selected range. Past orders were invisible because this was hardcoded to
         TODAY only — now Today / Week / Month / All. "All" reads the full store so historical
         sales always appear. */
      let txns = [];
      try {
        if (orders._range === 'all') {
          txns = await PosDB.transactions.getAll();
        } else {
          const now = new Date();
          const to  = now.getTime();
          let from;
          if (orders._range === 'week')       { const d = new Date(now); d.setDate(d.getDate() - 6); from = d.setHours(0,0,0,0); }
          else if (orders._range === 'month') { const d = new Date(now); d.setDate(d.getDate() - 29); from = d.setHours(0,0,0,0); }
          else                                { from = new Date(now).setHours(0,0,0,0); }   /* today */
          txns = await PosDB.transactions.getByDateRange(from, to);
        }
      } catch (_) { txns = []; }
      /* Accept every finalised sale. Status vocabulary varies (completed/complete/paid/done/
         delivered/finished) — normalise so historical rows aren't dropped by a strict match. */
      const DONE = /^(completed|complete|paid|done|finished|delivered|closed|success|fulfilled)$/i;
      orders._inStore = (txns || [])
        .filter(t => DONE.test(String(t.status || '')) || t.refunded || t.voided || t.completedAt)
        .sort((a, b) => (b.completedAt || b.timestamp || 0) - (a.completedAt || a.timestamp || 0));
      /* Low-stock count from canonical inventory (one read, no listener — perf-safe). */
      let lowStock = null;
      try {
        const prods = await PosDB.products.getAll();
        lowStock = (prods || []).filter(p => {
          const s = Number(p.stock != null ? p.stock : (p.quantity || 0));
          const thr = Number(p.lowStockThreshold != null ? p.lowStockThreshold : (p.reorderLevel != null ? p.reorderLevel : 5));
          return p.trackStock !== false && s <= thr;
        }).length;
      } catch (_) { lowStock = null; }
      orders._lowStock = lowStock;
      orders._paint();
    },

    _paint() {
      const body = document.getElementById('orders-body');
      if (!body) return;
      body.innerHTML = `<div class="ord-wrap">${orders._summary()}${orders._rangeHtml()}${orders._tabsHtml()}<div id="ord-list" class="ord-list"></div></div>`;
      orders._paintList();
    },

    _rangeHtml() {
      const R = [['today', 'Today'], ['week', 'This Week'], ['month', 'This Month'], ['all', 'All Time']];
      return `<div class="ord-tabs" style="margin-bottom:4px">${R.map(([k, l]) =>
        `<button class="ord-tab ${orders._range === k ? 'active' : ''}" onclick="SPos.orders.setRange('${k}')">${l}</button>`).join('')}</div>`;
    },

    setRange(r) { orders._range = r; orders.render(); },

    _summary() {
      const sold = orders._inStore.filter(t => !t.voided);
      const revenue = sold.reduce((s, t) => s + Number(t.total || 0), 0);
      const refunds = orders._inStore.filter(t => t.refunded && !t.voided).length;
      const low = orders._lowStock;
      /* Live device/connectivity chips — read once (no listener). Online-only metrics
         (Online Orders, Awaiting Rider, Ready Pickup) render "—" until Phase 2 wires the
         marketplace feed — never a fabricated 0. */
      let printerOn = false;
      try { printerOn = !!((window.SokoniPrinter && window.SokoniPrinter.connected) || (window.PrinterManager && window.PrinterManager.connected)); } catch (_) {}
      const online = (typeof navigator !== 'undefined') ? navigator.onLine !== false : true;
      const dash = (val, label, accent) =>
        `<div class="ord-stat"><div class="ord-stat-n"${accent ? ` style="color:${accent}"` : ''}>${val}</div><div class="ord-stat-l">${label}</div></div>`;
      return `<div class="ord-summary ord-summary-wide">
        ${dash('KES ' + _fmt(revenue), 'Revenue Today')}
        ${dash(String(sold.length), 'Walk-in Sales')}
        ${dash('<span style="color:var(--txt3)">—</span>', 'Online Orders')}
        ${dash(low == null ? '<span style="color:var(--txt3)">—</span>' : String(low), 'Low Stock', low ? '#ffb400' : null)}
        ${dash(String(refunds), 'Refunds Today', refunds ? '#ffb400' : null)}
        ${dash(printerOn ? '🟢' : '⚪', 'Printer', printerOn ? '#71ff00' : null)}
        ${dash(online ? '🟢' : '🔴', 'Sync', online ? '#71ff00' : '#ff6464')}
      </div>`;
    },

    _tabsHtml() {
      const T = [['all', '🟢 All'], ['online', '🛒 Online'], ['instore', '🏪 In-Store'],
                 ['delivery', '🚚 Delivery'], ['pickup', '📦 Pickup'], ['cancelled', '❌ Cancelled'], ['refunded', '↩ Refunded']];
      return `<div class="ord-tabs">${T.map(([k, l]) =>
        `<button class="ord-tab ${orders._filter === k ? 'active' : ''}" onclick="SPos.orders.setFilter('${k}')">${l}</button>`).join('')}</div>`;
    },

    setFilter(f) { orders._filter = f; orders._paint(); },

    _paintList() {
      const list = document.getElementById('ord-list');
      if (!list) return;
      const f = orders._filter;
      if (f === 'online' || f === 'delivery' || f === 'pickup') { list.innerHTML = orders._placeholder(f); return; }
      let rows = orders._inStore;
      if (f === 'instore')   rows = rows.filter(t => !t.voided && !t.refunded);
      if (f === 'cancelled') rows = rows.filter(t => t.voided);
      if (f === 'refunded')  rows = rows.filter(t => t.refunded && !t.voided);
      if (!rows.length) { list.innerHTML = '<div class="pos-empty" style="padding:34px 20px"><div class="empty-icon">🧾</div><p>No orders in this view yet</p></div>'; return; }
      list.innerHTML = rows.map(orders._card).join('');
    },

    _placeholder(kind) {
      const label = kind === 'online' ? 'Online marketplace orders' : kind === 'delivery' ? 'Delivery orders' : 'Pickup orders';
      return `<div class="pos-empty" style="padding:38px 20px">
        <div class="empty-icon">🛰️</div>
        <p style="margin-bottom:6px"><strong>${label}</strong></p>
        <p style="font-size:12.5px;color:var(--txt2);max-width:330px;margin:0 auto;line-height:1.55">Live marketplace orders (accept, prepare, ready-for-rider, chat buyer) arrive here in the next update. Your in-store sales are live now under the <strong>In-Store</strong> tab.</p>
      </div>`;
    },

    _card(t) {
      const when = new Date(t.completedAt || t.timestamp || Date.now())
        .toLocaleString('en-KE', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' });
      const status = t.voided ? '<span class="ord-badge ord-bad">Voided</span>'
        : t.refunded ? '<span class="ord-badge ord-warn">Refunded</span>'
        : '<span class="ord-badge ord-ok">Completed</span>';
      const method = (t.paymentMethod || 'cash').toUpperCase();
      const n = (t.items || []).length;
      const idLabel = t.receiptNo || ('POS-' + String(t.id || '').slice(-6));
      return `<div class="ord-card">
        <div class="ord-card-top">
          <div>
            <div class="ord-card-id">Sale #${_esc(idLabel)}</div>
            <div class="ord-card-sub">${_esc(t.customerName || 'Walk-in Customer')} · ${_esc(method)} · ${n} item${n === 1 ? '' : 's'}</div>
          </div>
          <div style="text-align:right">
            <div class="ord-card-amt">KES ${_fmt(t.total)}</div>
            <div class="ord-card-when">${when}</div>
          </div>
        </div>
        <div class="ord-card-foot">
          ${status}
          <div class="ord-card-actions">
            <button class="row-btn" onclick="SPos.sales.reprint('${t.id}')">🖨 Print</button>
            ${!t.refunded && !t.voided ? `<button class="row-btn" onclick="SPos.sales.refundDialog('${t.id}')">Refund</button>` : ''}
            <button class="row-btn" onclick="SPos.orders.details('${t.id}')">Details</button>
          </div>
        </div>
      </div>`;
    },

    async details(txnId) {
      const t = await PosDB.transactions.getById(txnId);
      if (!t) { toast('Order not found', 'error'); return; }
      const items = (t.items || []).map(i => {
        const qty = i.qty || 1;
        const line = (i.unitPrice != null ? i.unitPrice : (i.price || 0)) * qty;
        return `<div class="ord-det-row"><span>${_esc(i.name || i.productName || 'Item')} ×${qty}</span><span>KES ${_fmt(line)}</span></div>`;
      }).join('') || '<div class="ord-det-row"><span>No line items recorded</span><span></span></div>';
      const payState = t.voided ? 'Voided' : t.refunded ? 'Refunded' : 'Paid';
      const ov = document.createElement('div');
      ov.className = 'ord-det-overlay';
      ov.onclick = e => { if (e.target === ov) ov.remove(); };
      ov.innerHTML = `<div class="ord-det-card">
        <div class="ord-det-head"><strong>Sale #${_esc(t.receiptNo || String(t.id || '').slice(-6))}</strong><button aria-label="Close" onclick="this.closest('.ord-det-overlay').remove()">✕</button></div>
        <div class="ord-det-body">
          <div class="ord-det-row"><span>Customer</span><span>${_esc(t.customerName || 'Walk-in')}</span></div>
          <div class="ord-det-row"><span>Cashier</span><span>${_esc(t.cashierName || '-')}</span></div>
          <div class="ord-det-row"><span>Date</span><span>${new Date(t.completedAt || t.timestamp).toLocaleString('en-KE')}</span></div>
          <hr>
          ${items}
          <hr>
          <div class="ord-det-row"><span>Subtotal</span><span>KES ${_fmt(t.subtotal != null ? t.subtotal : t.total)}</span></div>
          ${t.discount ? `<div class="ord-det-row"><span>Discount</span><span>-KES ${_fmt(t.discount)}</span></div>` : ''}
          ${t.tax ? `<div class="ord-det-row"><span>Tax</span><span>KES ${_fmt(t.tax)}</span></div>` : ''}
          <div class="ord-det-row ord-det-total"><span>Total</span><span>KES ${_fmt(t.total)}</span></div>
          <div class="ord-det-row"><span>Payment</span><span>${_esc((t.paymentMethod || 'cash').toUpperCase())} · ${payState}</span></div>
        </div>
        <div class="ord-det-foot">
          <button class="modal-btn modal-btn-primary" style="width:100%" onclick="SPos.sales.reprint('${t.id}')">🖨 Print receipt</button>
        </div>
      </div>`;
      document.body.appendChild(ov);
    },
  };

  const sales = {
    async showHistory() {
      const body = document.getElementById('reports-body');
      body.innerHTML = '<div class="pos-empty"><div class="empty-icon">⏳</div><p>Loading...</p></div>';

      const fromStr = _v('rep-date-from');
      const toStr   = _v('rep-date-to');
      const from = fromStr ? new Date(fromStr).setHours(0,0,0,0) : new Date().setHours(0,0,0,0);
      const to   = toStr   ? new Date(toStr).setHours(23,59,59,999) : new Date().setHours(23,59,59,999);

      const all   = await PosDB.transactions.getByDateRange(from, to);
      const txns  = all.filter(t => t.status === 'completed').sort((a, b) => (b.completedAt||b.timestamp) - (a.completedAt||a.timestamp));

      if (!txns.length) { body.innerHTML = '<div class="pos-empty"><div class="empty-icon">📋</div><p>No transactions in this period</p></div>'; return; }

      body.innerHTML = `<table class="data-table">
        <thead><tr><th>Date &amp; Time</th><th>Receipt</th><th>Cashier</th><th>Customer</th><th>Items</th><th class="td-right">Total</th><th>Method</th><th>Actions</th></tr></thead>
        <tbody>${txns.map(t => `<tr>
          <td style="font-size:11px;white-space:nowrap">${new Date(t.completedAt||t.timestamp).toLocaleString('en-KE')}</td>
          <td style="font-family:monospace;font-size:11px">${t.receiptNo||'-'}</td>
          <td style="font-size:11px">${_esc(t.cashierName||'-')}</td>
          <td style="font-size:11px">${_esc(t.customerName||'Walk-in')}</td>
          <td style="font-size:11px">${(t.items||[]).length}</td>
          <td class="td-right"><strong>KES ${_fmt(t.total)}</strong></td>
          <td><span class="stock-badge ${t.paymentMethod==='mpesa'?'stock-ok':t.paymentMethod==='card'?'stock-low':''}">${(t.paymentMethod||'cash').toUpperCase()}</span></td>
          <td><div class="row-actions">
            <button class="row-btn" onclick="SPos.sales.reprint('${t.id}')">Reprint</button>
            <button class="row-btn" onclick="SPos.sales.refundDialog('${t.id}')" ${t.refunded?'disabled style="opacity:.4"':''}>Refund</button>
            ${!t.voided && !t.refunded ? `<button class="row-btn danger" onclick="SPos.sales.voidDialog('${t.id}')">Void</button>` : (t.voided ? '<span style="font-size:11px;color:var(--txt3)">VOIDED</span>' : '')}
          </div></td>
        </tr>`).join('')}</tbody>
      </table>`;
    },

    async reprint(txnId) {
      const t = await PosDB.transactions.getById(txnId);
      if (!t) { toast('Transaction not found', 'error'); return; }
      const rcpt = await PosDB.receipts.getByTransaction(txnId);
      const data = rcpt?.data || {
        ...t,
        businessName:    state.settings.bizName,
        businessAddress: state.settings.bizAddress,
        businessPhone:   state.settings.bizPhone,
        businessPin:     state.settings.bizPin,
        footerMessage:   state.settings.receiptFooter || 'Thank you for shopping with us!',
        date:            new Date(t.completedAt || t.timestamp).toLocaleString('en-KE'),
        taxRate:         state.settings.taxRate || 16,
        paperWidth:      parseInt(state.settings.paperWidth) || 32,
      };
      /* Order-centric print: ensure the printer is connected (silent → chooser) THEN print,
         so the merchant taps once and never sees a reconnect screen. Falls back to the legacy
         browser print if the smart path is unavailable. */
      if (window.PosPrintService && typeof PosPrintService.smartPrint === 'function') {
        PosPrintService.smartPrint(data, { reprint: true }).catch(() => { try { PosPrinter.print(data); } catch (_) {} });
      } else {
        PosPrinter.print(data).catch(() => {});
      }
      if (window.PosAudit) PosAudit.log('receipt_reprint', { receiptNo: t.receiptNo });
    },

    async refundDialog(txnId) {
      const t = await PosDB.transactions.getById(txnId);
      if (!t) { toast('Transaction not found', 'error'); return; }
      if (t.refunded) { toast('This transaction has already been refunded', 'error'); return; }

      const itemsHtml = (t.items || []).map((item, idx) => `
        <div style="display:flex;align-items:center;gap:10px;padding:8px;border-radius:8px;background:var(--card);margin-bottom:4px">
          <input type="checkbox" id="ref-item-${idx}" data-id="${item.id}" data-price="${item.price}" data-qty="${item.qty}" data-name="${_esc(item.name)}" data-cost="${item.cost||0}" checked style="width:18px;height:18px">
          <label for="ref-item-${idx}" style="flex:1;font-size:13px">${_esc(item.name)} × ${item.qty}</label>
          <span style="font-size:13px;font-weight:700">KES ${_fmt(item.qty * item.price)}</span>
        </div>
      `).join('');

      const body = `
        <div style="font-size:12px;color:var(--txt2);margin-bottom:10px">
          Receipt <strong>${t.receiptNo}</strong> · KES ${_fmt(t.total)} · ${new Date(t.completedAt||t.timestamp).toLocaleString('en-KE')}
        </div>
        <div style="font-size:11px;font-weight:800;letter-spacing:.05em;color:var(--txt3);margin-bottom:6px">SELECT ITEMS TO REFUND</div>
        ${itemsHtml}
        <div style="margin-top:12px">
          <label style="font-size:11px;font-weight:800;color:var(--txt3)">REASON</label>
          <select class="form-select" id="refund-reason" style="width:100%;margin-top:4px;padding:10px;font-size:14px">
            <option value="customer_request">Customer Request</option>
            <option value="defective">Defective Product</option>
            <option value="wrong_item">Wrong Item</option>
            <option value="exchange">Exchange</option>
            <option value="other">Other</option>
          </select>
        </div>
        <div style="margin-top:8px">
          <label style="font-size:11px;font-weight:800;color:var(--txt3)">REFUND METHOD</label>
          <select class="form-select" id="refund-method" style="width:100%;margin-top:4px;padding:10px;font-size:14px">
            <option value="cash">Cash</option>
            <option value="mpesa">M-PESA</option>
            <option value="credit">Store Credit</option>
          </select>
        </div>
      `;

      confirm.show('Process Refund', body, async () => {
        await sales._processRefund(t);
      });
    },

    async _processRefund(originalTxn) {
      const checkboxes = document.querySelectorAll('[id^="ref-item-"]:checked');
      if (!checkboxes.length) { toast('Select at least one item to refund', 'error'); return; }

      /* Manager authorization required */
      if (window.ManagerAuth) {
        const refundPreview = Array.from(checkboxes).reduce((s, cb) => s + (parseInt(cb.dataset.qty) * parseFloat(cb.dataset.price)), 0);
        const ok = await ManagerAuth.request('refund', {
          amount: refundPreview,
          reason: document.getElementById('refund-reason')?.value || 'customer_request',
          items: checkboxes.length,
          cashier: state.currentCashier?.name,
        });
        if (!ok) { toast('Refund cancelled — authorization denied', 'error'); return; }
      }

      const reason = document.getElementById('refund-reason')?.value || 'customer_request';
      const method = document.getElementById('refund-method')?.value || 'cash';
      const refundItems = [];
      let   refundTotal = 0;

      checkboxes.forEach(cb => {
        const qty   = parseInt(cb.dataset.qty);
        const price = parseFloat(cb.dataset.price);
        const cost  = parseFloat(cb.dataset.cost || 0);
        refundItems.push({ id: cb.dataset.id, name: cb.dataset.name, qty, price, cost });
        refundTotal += qty * price;
      });

      /* Restore stock */
      for (const item of refundItems) {
        await PosDB.products.adjustStock(item.id, item.qty, 'refund:' + originalTxn.id, state.currentCashier?.id);
      }

      /* Save refund transaction */
      const refundTxn = {
        type:            'refund',
        originalTxnId:   originalTxn.id,
        originalReceiptNo: originalTxn.receiptNo,
        items:           refundItems,
        total:           refundTotal,
        paymentMethod:   method,
        reason,
        cashierId:       state.currentCashier?.id,
        cashierName:     state.currentCashier?.name,
        customerId:      originalTxn.customerId,
        customerName:    originalTxn.customerName,
        status:          'refunded',
        receiptNo:       window.PosIdempotency ? PosIdempotency.generateReceiptNo('REF-') : ('REF-' + Date.now().toString(36).toUpperCase().slice(-6) + Math.random().toString(36).slice(2,5).toUpperCase()),
      };
      await PosDB.transactions.save(refundTxn);

      /* Mark original as refunded */
      const orig = await PosDB.transactions.getById(originalTxn.id);
      if (orig) { orig.refunded = true; orig.refundTxnId = refundTxn.id; await PosDB.transactions.save(orig); }

      /* Update shift refund total */
      if (state.currentShift) {
        const s = await PosDB.shifts.getCurrent();
        if (s) { s.totalRefunds = (s.totalRefunds || 0) + refundTotal; await PosDB.shifts.update(s); }
      }

      /* Deduct loyalty points if customer */
      if (originalTxn.customerId) {
        const c = await PosDB.customers.getById(originalTxn.customerId);
        if (c) {
          const pts = Math.floor(refundTotal / 100) * (state.settings.loyaltyRate || 1);
          c.points    = Math.max(0, (c.points || 0) - pts);
          c.totalSpent = Math.max(0, (c.totalSpent || 0) - refundTotal);
          c.updatedAt  = Date.now();
          await PosDB.customers.save(c);
        }
      }

      if (window.PosAudit) PosAudit.log('refund', { receiptNo: refundTxn.receiptNo, total: refundTotal, reason, original: originalTxn.receiptNo });

      await products.reload();
      toast(`Refund processed: KES ${_fmt(refundTotal)}`, 'success');

      /* Print refund receipt */
      PosPrinter.print({
        ...refundTxn,
        businessName:    state.settings.bizName,
        businessAddress: state.settings.bizAddress,
        businessPhone:   state.settings.bizPhone,
        footerMessage:   'REFUND RECEIPT — ' + reason.replace('_', ' ').toUpperCase(),
        date:            new Date().toLocaleString('en-KE'),
        taxRate:         0,
        paperWidth:      parseInt(state.settings.paperWidth) || 32,
      }).catch(() => {});
    },

    async voidDialog(txnId) {
      const t = await PosDB.transactions.getById(txnId);
      if (!t) { toast('Transaction not found', 'error'); return; }
      if (t.voided)   { toast('This transaction is already voided', 'error'); return; }
      if (t.refunded) { toast('Refunded transactions cannot be voided', 'error'); return; }

      const body = `
        <div style="font-size:13px;color:var(--txt2);margin-bottom:12px">
          Voiding will mark this transaction as cancelled and restore all stock.
          This action cannot be undone.
        </div>
        <div style="background:var(--card);border-radius:10px;padding:10px 12px;margin-bottom:12px;font-size:13px">
          Receipt <strong>${_esc(t.receiptNo || t.id)}</strong><br>
          Total: <strong>KES ${_fmt(t.total)}</strong> · ${new Date(t.completedAt || t.timestamp).toLocaleString('en-KE')}
        </div>
        <div>
          <label style="font-size:11px;font-weight:800;color:var(--txt3)">VOID REASON</label>
          <select class="form-select" id="void-reason" style="width:100%;margin-top:4px;padding:10px;font-size:14px">
            <option value="manager_error">Manager / Cashier Error</option>
            <option value="customer_cancel">Customer Cancelled</option>
            <option value="duplicate_entry">Duplicate Entry</option>
            <option value="system_error">System Error</option>
            <option value="other">Other</option>
          </select>
        </div>`;

      confirm.show('Void Transaction', body, async () => {
        await sales._processVoid(t);
      });
    },

    async _processVoid(txn) {
      /* Manager authorization required */
      if (window.ManagerAuth) {
        const ok = await ManagerAuth.request('void', {
          amount: txn.total,
          reason: document.getElementById('void-reason')?.value || 'manager_error',
          cashier: state.currentCashier?.name,
        });
        if (!ok) { toast('Void cancelled — authorization denied', 'error'); return; }
      }

      const reason = document.getElementById('void-reason')?.value || 'manager_error';

      /* Restore stock for all items */
      for (const item of (txn.items || [])) {
        await PosDB.products.adjustStock(item.id, item.qty, 'void:' + txn.id, state.currentCashier?.id);
      }

      /* Mark transaction as voided */
      txn.voided    = true;
      txn.voidedAt  = Date.now();
      txn.voidReason = reason;
      txn.voidedBy   = state.currentCashier?.id;
      txn.voidedByName = state.currentCashier?.name;
      await PosDB.transactions.save(txn);

      if (window.PosAudit) PosAudit.log('void', { receiptNo: txn.receiptNo, total: txn.total, reason });

      await products.reload();
      await sales.showHistory();
      toast(`Transaction ${txn.receiptNo || txn.id} voided`, 'info');
    },
  };

  /* ═══════════════════════════════════════════════════════════
     SETTINGS
  ═══════════════════════════════════════════════════════════ */
  const settings = {
    loadIntoForm() {
      const s = state.settings;
      _setVal('s-biz-name',       s.bizName        || '');
      _setVal('s-biz-address',    s.bizAddress     || '');
      _setVal('s-biz-phone',      s.bizPhone       || '');
      _setVal('s-biz-pin',        s.bizPin         || '');
      _setVal('s-receipt-footer', s.receiptFooter  || '');
      _setVal('s-tax-rate',       s.taxRate        || 16);
      _setVal('s-loyalty-rate',   s.loyaltyRate    || 1);

      const pw = document.getElementById('s-paper-width');
      if (pw) pw.value = s.paperWidth || '58';

      const ap = document.getElementById('s-auto-print');
      if (ap) ap.checked = s.autoPrint === true || s.autoPrint === 'true';

      const cd = document.getElementById('s-cash-drawer');
      if (cd) cd.checked = s.openCashDrawer === true || s.openCashDrawer === 'true';

      const ti = document.getElementById('s-tax-inclusive');
      if (ti) ti.checked = s.taxInclusive === true || s.taxInclusive === 'true';

      const pst = document.getElementById('printer-status-txt');
      if (pst) pst.textContent = PosPrinter.isConnected() ? '✓ ' + PosPrinter.getType() : 'Not connected';

      const mcs = document.getElementById('mpesa-config-status');
      if (mcs) mcs.textContent = (s.mpesaConfigured === true || s.mpesaConfigured === 'true') ? '✓ Configured (shortcode: ' + (s.mpesaShortcode || '-') + ')' : 'Not configured';

      cashier.renderList();
    },

    async save() {
      const updates = {
        bizName:       _v('s-biz-name').trim(),
        bizAddress:    _v('s-biz-address').trim(),
        bizPhone:      _v('s-biz-phone').trim(),
        bizPin:        _v('s-biz-pin').trim(),
        receiptFooter: _v('s-receipt-footer').trim(),
        taxRate:       parseFloat(_v('s-tax-rate'))    || 16,
        loyaltyRate:   parseFloat(_v('s-loyalty-rate'))|| 1,
      };
      await PosDB.settings.setMany(updates);
      Object.assign(state.settings, updates);
      _setVal('hdr-biz-name', updates.bizName || 'SOKONI SmartPOS');
      toast('Settings saved', 'success');
    },

    async saveToggle(key, val) {
      state.settings[key] = val;
      await PosDB.settings.set(key, val);
    },

    async savePaperWidth(val) {
      PosPrinter.setPaperWidth(parseInt(val));
      state.settings.paperWidth = val;
      await PosDB.settings.set('paperWidth', val);
    },
  };

  /* ═══════════════════════════════════════════════════════════
     SOKONI PROFILE — bind this POS device to the signed-in account
     POS is offline-first, so localStorage.sokoniUser is the primary read (the
     same identity every other page uses); Firestore users/{uid} enriches it
     (phone / business name / KRA PIN) when online. This makes the header account
     pill reflect the real owner and gives the Business Profile a one-tap sync,
     instead of a dead "Login" pill and a blank, manually-retyped business form.
  ═══════════════════════════════════════════════════════════ */
  const profile = {
    get() {
      let u = null;
      try { u = JSON.parse(localStorage.getItem('sokoniUser') || 'null'); } catch (_) {}
      return (u && typeof u === 'object') ? u : null;
    },
    displayName() {
      const u = profile.get();
      if (!u) return null;
      return u.name || u.displayName || u.businessName || u.shopName ||
             (u.email ? String(u.email).split('@')[0] : null) || null;
    },
    businessName() {
      const u = profile.get() || {};
      return u.businessName || u.shopName || u.name || '';
    },
    phone() {
      const u = profile.get() || {};
      return u.phoneNumber || u.phone || '';
    },
    /* Open the canonical SOKONI profile (same page the rest of the app uses). */
    open() { window.open('profile.html', '_self'); },

    /* Reflect WHO is signed in on the header pill when no cashier has logged in,
       so the account surface shows the owner instead of a dead "Login". An
       explicit cashier login always wins. */
    reflectInHeader() {
      if (state.currentCashier) return;
      const name = profile.displayName();
      if (!name) return;
      _setVal('cashier-avatar', name[0].toUpperCase());
      _setVal('cashier-name-hdr', name);
    },

    /* Populate the account strip inside the cashier PIN modal. */
    fillPinModal() {
      const box = document.getElementById('pin-acct');
      if (!box) return;
      const name = profile.displayName();
      const u = profile.get();
      if (!u || !name) { box.style.display = 'none'; return; }
      _setVal('pin-acct-name', name);
      _setVal('pin-acct-sub', profile.phone() || u.email || '');
      box.style.display = '';
    },

    /* Seed blank business settings from the account so receipts/header/branding
       match the owner's profile without manual entry. Non-destructive: only
       fills empties, then persists so the change survives reload. */
    async seedBusinessDefaults() {
      const u = profile.get();
      if (!u) return;
      const want = { bizName: profile.businessName(), bizPhone: profile.phone() };
      let changed = false;
      for (const k in want) {
        if (want[k] && !String(state.settings[k] || '').trim()) {
          state.settings[k] = want[k];
          try { await PosDB.settings.set(k, want[k]); } catch (_) {}
          changed = true;
        }
      }
      if (changed) _setVal('hdr-biz-name', state.settings.bizName || 'SOKONI SmartPOS');
    },

    /* Prefill the BUSINESS PROFILE settings form from the SOKONI account.
       Never overwrites values the merchant already typed unless force:true.
       force+persist (the "Sync from my profile" button) also saves. Returns the
       number of fields filled. */
    async syncBusinessProfile(opts) {
      opts = opts || {};
      const u = profile.get();
      if (!u) { if (opts.interactive) toast('Sign in to sync your profile', 'info'); return 0; }

      let doc = {};
      try {
        if (navigator.onLine && u.uid && window.firebase && firebase.firestore) {
          const snap = await firebase.firestore().collection('users').doc(String(u.uid)).get();
          if (snap && snap.exists) doc = snap.data() || {};
        }
      } catch (_) { /* offline / rules — localStorage alone is enough */ }

      const src = Object.assign({}, u, doc);
      const map = {
        's-biz-name':    src.businessName || src.shopName || src.name || '',
        's-biz-phone':   src.phoneNumber  || src.phone    || '',
        's-biz-address': src.address      || src.location || '',
        's-biz-pin':     src.kraPin       || src.kra_pin  || '',
      };
      let filled = 0;
      Object.keys(map).forEach(function (id) {
        const el = document.getElementById(id);
        if (!el || !map[id]) return;
        if (opts.force || !String(el.value || '').trim()) { el.value = map[id]; filled++; }
      });
      if (filled && opts.persist === true) { try { await settings.save(); } catch (_) {} }
      if (opts.interactive) {
        toast(filled ? ('Synced ' + filled + ' field' + (filled === 1 ? '' : 's') + ' from your profile')
                     : 'Business profile already matches your account', filled ? 'success' : 'info');
      }
      return filled;
    },
  };

  /* ═══════════════════════════════════════════════════════════
     SYNC
  ═══════════════════════════════════════════════════════════ */
  const sync = {
    async run(silent = false) {
      if (!navigator.onLine) return;
      try {
        /* Delegate entirely to PosSyncEngine — idempotent setDoc writes to posTransactions.
           The previous addDoc path to businesses/{bizPin}/pos_transactions is removed:
           it was non-idempotent, had no security rules, and duplicated PosSyncEngine's work. */
        if (window.PosSyncEngine) {
          const r = await PosSyncEngine.processQueue({ reason: 'manual' });
          if (!silent) {
            if (r.skipped) toast('All data is synced ✓', 'success');
            else if (r.success > 0) toast(`Sync complete ✓ (${r.success} uploaded)`, 'success');
            else toast('All data is synced ✓', 'success');
          }
        } else {
          const pending = await PosDB.syncQueue.getPending();
          if (!silent) toast(pending.length ? `${pending.length} item(s) queued — connect to sync` : 'All data is synced ✓', pending.length ? 'info' : 'success');
        }
      } catch (e) {
        if (!silent) toast('Sync failed: ' + e.message, 'error');
      }
    },
  };

  /* ═══════════════════════════════════════════════════════════
     DATA
  ═══════════════════════════════════════════════════════════ */
  const data = {
    async exportAll() {
      const products     = await PosDB.products.getAll();
      const transactions = await PosDB.transactions.getAll();
      const customers    = await PosDB.customers.getAll();
      const settings     = await PosDB.settings.getAll();

      const backup = { products, transactions, customers, settings, exportedAt: new Date().toISOString() };
      const a      = document.createElement('a');
      a.href       = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }));
      a.download   = 'sokoni_pos_backup_' + new Date().toISOString().split('T')[0] + '.json';
      a.click();
      toast('Backup exported', 'success');
    },

    resetDialog() {
      confirm.show('Reset POS', '⚠️ This will delete ALL local data including products, transactions and settings. This cannot be undone. Continue?', async () => {
        indexedDB.deleteDatabase('sokoni_smartpos');
        location.reload();
      });
    },
  };

  /* ═══════════════════════════════════════════════════════════
     MODAL HELPERS
  ═══════════════════════════════════════════════════════════ */
  const modal = {
    open(id) {
      const el = document.getElementById(id);
      if (el) { el.classList.add('open'); }
    },
    close(id) {
      const el = document.getElementById(id);
      if (el) el.classList.remove('open');
    },
  };

  /* Click outside modal to close */
  document.addEventListener('click', e => {
    if (e.target.classList.contains('modal-overlay')) {
      e.target.classList.remove('open');
      if (e.target.id === 'scanner-modal') barcode.closeScanner();
    }
  });

  const confirm = {
    _cb: null,
    show(title, body, onConfirm) {
      document.getElementById('confirm-title').textContent = title;
      document.getElementById('confirm-body').innerHTML    = body;
      confirm._cb = onConfirm;
      const okBtn = document.getElementById('confirm-ok-btn');
      if (okBtn) okBtn.style.display = onConfirm ? '' : 'none';
      modal.open('confirm-modal');
    },
  };
  document.getElementById('confirm-ok-btn').addEventListener('click', () => {
    modal.close('confirm-modal');
    if (confirm._cb) { confirm._cb(); confirm._cb = null; }
  });

  /* ═══════════════════════════════════════════════════════════
     PRINTER SETUP (from settings)
  ═══════════════════════════════════════════════════════════ */
  function printerSetup() {
    const type = prompt('Choose printer type: bluetooth, usb, network, browser');
    if (!type) return;
    wizard.connectPrinter(type.toLowerCase().trim());
  }

  /* ═══════════════════════════════════════════════════════════
     UTILITIES
  ═══════════════════════════════════════════════════════════ */
  function toast(msg, type = 'info') {
    const existing = document.getElementById('_pos_toast');
    if (existing) existing.remove();
    const el = document.createElement('div');
    el.id    = '_pos_toast';
    el.className = `pos-toast ${type}`;
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transition = 'opacity .3s';
      setTimeout(() => el.remove(), 320);
    }, 2800);
  }

  function updateClock() {
    const now = new Date();
    _setVal('pos-clock', now.toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit' }));
  }

  function updateOnlineStatus(online) {
    const bar = document.getElementById('offline-bar');
    const dot = document.getElementById('pos-online-dot');
    if (bar) bar.classList.toggle('hidden', online);
    if (dot) { dot.classList.toggle('offline', !online); dot.title = online ? 'Online' : 'Offline'; }
    if (online) {
      sync.run(true);
      /* Clear offline queue counter once back online */
      _p7UpdateOfflineCount(0);
    }
  }

  function _p7UpdateOfflineCount(n) {
    const bar = document.getElementById('offline-bar');
    if (!bar) return;
    let badge = bar.querySelector('.offline-queue-count');
    if (n <= 0) { if (badge) badge.remove(); return; }
    if (!badge) { badge = document.createElement('span'); badge.className = 'offline-queue-count'; bar.appendChild(badge); }
    badge.textContent = n + ' queued';
    /* Update bell badge too */
    const bell = document.getElementById('notify-badge');
    if (bell && bell.style.display === 'none') {
      bell.textContent = n; bell.style.display = 'flex';
    }
    /* Save sync timestamp when uploading */
    if (navigator.onLine) localStorage.setItem('posLastSync', Date.now().toString());
  }

  /* ── IMEI / Serial capture dialog (called at checkout for electronics) ── */
  function _captureSerialForItem(item) {
    return new Promise(resolve => {
      const ov = document.createElement('div');
      ov.style.cssText = 'position:fixed;inset:0;z-index:99990;background:rgba(0,0,0,.87);display:flex;align-items:flex-end;justify-content:center';
      const needsIMEI  = item.requiresIMEI;
      const needsSerial = item.requiresSerial;
      ov.innerHTML = `
        <div style="background:#18181f;border-radius:20px 20px 0 0;width:100%;max-width:420px;padding:20px 20px 36px;font-family:-apple-system,sans-serif;color:#f0f0f6">
          <div style="font-size:17px;font-weight:800;margin-bottom:4px">📱 Register Device</div>
          <div style="font-size:12px;color:#9898aa;margin-bottom:16px">${_esc(item.name)}</div>
          ${needsIMEI ? `<label style="font-size:12px;font-weight:700;color:#9898aa;display:block;margin-bottom:4px">IMEI Number</label>
            <input id="imei-input" type="tel" maxlength="15" placeholder="15-digit IMEI" autocomplete="off"
              style="width:100%;padding:12px;border-radius:10px;border:1px solid rgba(255,255,255,.12);background:#1e1e28;color:#f0f0f6;font-size:16px;margin-bottom:10px;outline:none">` : ''}
          ${needsSerial ? `<label style="font-size:12px;font-weight:700;color:#9898aa;display:block;margin-bottom:4px">Serial Number</label>
            <input id="serial-input" type="text" placeholder="Serial number" autocomplete="off"
              style="width:100%;padding:12px;border-radius:10px;border:1px solid rgba(255,255,255,.12);background:#1e1e28;color:#f0f0f6;font-size:16px;margin-bottom:12px;outline:none">` : ''}
          <div style="font-size:11px;color:#9898aa;margin-bottom:14px">Required for warranty registration</div>
          <button id="serial-confirm" style="width:100%;padding:14px;background:#71ff00;color:#111;border:none;border-radius:12px;font-size:15px;font-weight:800;cursor:pointer;margin-bottom:8px">Confirm</button>
          <button id="serial-skip" style="width:100%;padding:12px;background:transparent;border:1px solid rgba(255,255,255,.08);border-radius:12px;font-size:13px;font-weight:600;color:#9898aa;cursor:pointer">Skip (no warranty)</button>
        </div>`;
      document.body.appendChild(ov);

      function luhnCheck(n) {
        if (!/^\d{15}$/.test(n)) return false;
        let s = 0, alt = false;
        for (let i = n.length - 1; i >= 0; i--) {
          let d = parseInt(n[i]);
          if (alt) { d *= 2; if (d > 9) d -= 9; }
          s += d; alt = !alt;
        }
        return s % 10 === 0;
      }

      ov.querySelector('#serial-confirm').addEventListener('click', () => {
        const imei   = needsIMEI   ? (ov.querySelector('#imei-input')?.value || '').trim() : null;
        const serial = needsSerial ? (ov.querySelector('#serial-input')?.value || '').trim() : null;
        if (needsIMEI && imei && !luhnCheck(imei)) {
          toast('Invalid IMEI — must be 15 digits (Luhn check failed)', 'error'); return;
        }
        ov.remove();
        resolve({ imei: imei || null, serial: serial || null });
      });
      ov.querySelector('#serial-skip').addEventListener('click', () => { ov.remove(); resolve({ imei: null, serial: null }); });
    });
  }

  function _v(id)          { return (document.getElementById(id)?.value || ''); }
  function _setVal(id, v)  { const el = document.getElementById(id); if (el) { if ('value' in el && el.tagName !== 'DIV' && el.tagName !== 'SPAN') el.value = v; else el.textContent = v; } }
  function _esc(s)         { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function _fmt(n)         { return Number(n || 0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function _clearForm(ids) { ids.forEach(id => _setVal(id, '')); }
  function _debounce(fn, ms) {
    let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  /* Debounced versions for search inputs */
  const _debouncedProductSearch = _debounce(q => products.search(q), 200);
  const _debouncedInvSearch     = _debounce(q => inv.search(q), 200);
  const _debouncedCustSearch    = _debounce(q => customers.search(q), 200);

  /* ═══════════════════════════════════════════════════════════
     PURCHASE ORDERS
  ═══════════════════════════════════════════════════════════ */
  const po = {
    _lineCount: 0,

    _addLine() {
      const tbody = document.getElementById('po-items-body');
      if (!tbody) return;
      const idx = po._lineCount++;
      const row = document.createElement('tr');
      row.id = `po-line-${idx}`;
      row.innerHTML = `
        <td><input class="form-input" placeholder="Product name" id="po-item-name-${idx}" style="width:100%"></td>
        <td><input class="form-input" type="number" min="1" value="1" id="po-item-qty-${idx}" style="width:70px"></td>
        <td><input class="form-input" type="number" min="0" id="po-item-cost-${idx}" placeholder="0" style="width:100px"></td>
        <td><button class="row-btn danger" onclick="document.getElementById('po-line-${idx}').remove()">✕</button></td>
      `;
      tbody.appendChild(row);
    },

    async save() {
      const supplierId = _v('po-supplier');
      const notes      = _v('po-notes').trim();
      const lines      = document.querySelectorAll('[id^="po-line-"]');
      const items      = [];

      lines.forEach(row => {
        const idx  = row.id.replace('po-line-', '');
        const name = document.getElementById(`po-item-name-${idx}`)?.value.trim();
        const qty  = parseFloat(document.getElementById(`po-item-qty-${idx}`)?.value)  || 0;
        const cost = parseFloat(document.getElementById(`po-item-cost-${idx}`)?.value) || 0;
        if (name && qty > 0) items.push({ name, qty, cost });
      });

      if (!items.length) { toast('Add at least one item to the order', 'error'); return; }

      const poData = {
        supplierId: supplierId || null,
        items,
        notes,
        totalValue: items.reduce((s, i) => s + i.qty * i.cost, 0),
        status:     'pending',
        createdAt:  Date.now(),
        cashierId:  state.currentCashier?.id,
      };

      await PosDB.purchase_orders.save(poData);
      modal.close('po-modal');
      if (window.PosAudit) PosAudit.log('purchase_order', { items: items.length, supplierId });
      toast('Purchase order saved', 'success');
    },
  };

  /* ═══════════════════════════════════════════════════════════
     CATEGORIES MANAGEMENT
  ═══════════════════════════════════════════════════════════ */
  const cats = {
    async renderManager(containerId) {
      const el  = document.getElementById(containerId);
      if (!el) return;
      const all = await PosDB.categories.getAll();
      el.innerHTML = `
        <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap">
          ${all.map(c => `
            <div style="display:flex;align-items:center;gap:6px;padding:6px 12px;background:var(--card);border:1px solid var(--border);border-radius:20px;font-size:13px">
              ${c.icon || '📦'} ${_esc(c.name)}
              <button onclick="SPos.cats.delete('${c.id}')" style="background:none;border:none;color:var(--txt3);cursor:pointer;font-size:12px;padding:0 0 0 4px">✕</button>
            </div>
          `).join('')}
        </div>
        <div style="display:flex;gap:8px">
          <input class="form-input" id="new-cat-icon" placeholder="🏷️" style="width:56px">
          <input class="form-input" id="new-cat-name" placeholder="Category name" style="flex:1">
          <button class="inv-btn inv-btn-green" onclick="SPos.cats.add()">+ Add</button>
        </div>
      `;
    },

    async add() {
      const name = _v('new-cat-name').trim();
      const icon = _v('new-cat-icon').trim() || '📦';
      if (!name) { toast('Category name required', 'error'); return; }
      await PosDB.categories.save({ name, icon });
      await ui.loadCategories();
      toast('Category added: ' + name, 'success');
      cats.renderManager('cats-manager-container');
    },

    async delete(id) {
      confirm.show('Delete Category', 'Remove this category? Products using it will show no category.', async () => {
        await PosDB.categories.delete(id);
        await ui.loadCategories();
        cats.renderManager('cats-manager-container');
        toast('Category removed', 'info');
      });
    },
  };

  /* ═══════════════════════════════════════════════════════════
     BOS — wires AI import, analytics, and boss modules
  ═══════════════════════════════════════════════════════════ */
  const bos = {
    openAIImport() {
      /* Reset AI modal */
      const preview = document.getElementById('ai-preview-body');
      if (preview) preview.innerHTML = '';
      const status = document.getElementById('ai-status-msg');
      if (status) { status.textContent = ''; status.className = 'ai-status-info'; }
      modal.open('ai-import-modal');
    },

    handleFileSelect(file) {
      if (!file) return;
      const dropZone = document.getElementById('ai-drop-zone');
      if (dropZone) dropZone.querySelector('.ai-drop-title').textContent = file.name;
      PosAI.importFile(file, async (imported, updated) => {
        await products.reload();
        await ui.loadCategories();
        await inv.renderProducts();
        toast(`✓ ${imported} new · ${updated} updated`, 'success');
      }).catch(e => {
        const s = document.getElementById('ai-status-msg');
        if (s) { s.textContent = '✗ ' + e.message; s.className = 'ai-status-error'; }
        toast(e.message, 'error');
      });
    },

    handleFileDrop(event) {
      const file = event.dataTransfer?.files?.[0];
      if (file) bos.handleFileSelect(file);
    },
  };

  /* ═══════════════════════════════════════════════════════════
     SETTINGS PANEL — boot settings-tab widgets
  ═══════════════════════════════════════════════════════════ */
  function _bootSettingsPanels() {
    /* Voice panel */
    if (window.PosVoice) {
      PosVoice.renderPanel('voice-panel-container');
    }
    /* Plugin manager */
    if (window.PosPlugins) {
      PosPlugins.renderManager('plugins-manager-body');
    }
    /* Marketing hub */
    if (window.PosMarketing) {
      PosMarketing.renderHub('marketing-hub-body');
    }
    /* Label designer */
    if (window.PosLabels) {
      PosLabels.renderDesigner('labels-designer-body');
    }
    /* Warranty checker */
    if (window.PosSerial) {
      PosSerial.renderWarrantyCheck('warranty-check-container');
    }
    /* Categories manager */
    cats.renderManager('cats-manager-container');
    /* Device hub */
    if (window.PosTerminals) PosTerminals.ui.renderDeviceHub('devices-hub-body');
  }

  /* Wire up registerBiometric on the settings module */
  const _settingsSaveOrig = settings.save.bind(settings);
  settings.registerBiometric = async function() {
    if (!window.PosBiometric) { toast('Biometric module not loaded', 'error'); return; }
    if (!PosBiometric.isSupported()) { toast('Biometric auth not supported on this device', 'error'); return; }
    const cashier = state.currentCashier;
    if (!cashier) { toast('Please login first, then register biometrics', 'error'); return; }
    try {
      await PosBiometric.register(cashier);
      toast('✓ Biometric registered for ' + cashier.name, 'success');
      if (window.PosAudit) PosAudit.log('cashier_added', { cashierId: cashier.id, method: 'biometric' });
    } catch (e) {
      toast('Biometric registration failed: ' + e.message, 'error');
    }
  };

  /* ═══════════════════════════════════════════════════════════
     SPLIT PAYMENT
  ═══════════════════════════════════════════════════════════ */
  const split = {
    _total: 0,

    open(total) {
      split._total = total;
      document.getElementById('split-total').textContent = 'KES ' + total.toFixed(2);
      document.getElementById('split-cash').value  = '';
      document.getElementById('split-mpesa').value = total.toFixed(0);
      document.getElementById('split-warn').style.display = 'none';
      modal.open('split-modal');
    },

    onCashInput() {
      const cash  = parseFloat(document.getElementById('split-cash').value)  || 0;
      const rem   = Math.max(0, split._total - cash);
      document.getElementById('split-mpesa').value = rem > 0 ? rem.toFixed(0) : '';
      split._validate();
    },

    onMpesaInput() {
      const mpesa = parseFloat(document.getElementById('split-mpesa').value) || 0;
      const rem   = Math.max(0, split._total - mpesa);
      document.getElementById('split-cash').value  = rem > 0 ? rem.toFixed(0) : '';
      split._validate();
    },

    _validate() {
      const cash  = parseFloat(document.getElementById('split-cash').value)  || 0;
      const mpesa = parseFloat(document.getElementById('split-mpesa').value) || 0;
      const warn  = document.getElementById('split-warn');
      const diff  = Math.abs((cash + mpesa) - split._total);
      if (diff > 0.5) {
        warn.textContent = `Cash + M-PESA = KES ${(cash + mpesa).toFixed(2)} — must equal KES ${split._total.toFixed(2)}`;
        warn.style.display = 'block';
        return false;
      }
      warn.style.display = 'none';
      return true;
    },

    async proceed() {
      if (!split._validate()) return;
      const cash  = parseFloat(document.getElementById('split-cash').value)  || 0;
      const mpesa = parseFloat(document.getElementById('split-mpesa').value) || 0;
      modal.close('split-modal');

      if (mpesa <= 0) {
        /* Cash only — process directly */
        await payment.complete({ method: 'cash', amountPaid: cash, change: 0, mpesaRef: null, mpesaPhone: null });
        return;
      }

      /* Store cash portion in state, then open M-PESA modal for the remainder */
      state._splitCashPortion = cash;
      state._splitMpesaAmount = mpesa;

      const mpesaModal = document.getElementById('mpesa-modal');
      document.getElementById('mpesa-amount-disp').textContent = mpesa.toFixed(2);
      if (state.currentCustomer?.phone) _setVal('mpesa-phone', state.currentCustomer.phone);

      /* Monkey-patch mpesa.sendSTK for this split transaction */
      state._splitMode = true;
      modal.open('mpesa-modal');
      toast(`Collect KES ${cash.toFixed(2)} cash, then confirm M-PESA for KES ${mpesa.toFixed(2)}`, 'info');
    },
  };

  /* ── Wire split-mode into M-PESA confirmation ── */
  const _origMpesaComplete = payment.complete.bind(payment);
  (function _patchMpesaForSplit() {
    /* After STK confirms in split mode, use original total + merge payment methods */
    const origSendSTK = mpesa.sendSTK.bind(mpesa);
    mpesa.sendSTK = async function splitAwareSendSTK() {
      if (!state._splitMode) { return origSendSTK(); }
      /* Override the amount display to just the M-PESA portion */
      const cashPortion  = state._splitCashPortion || 0;
      const mpesaPortion = state._splitMpesaAmount || cart.getTotal();
      /* Let original STK logic run; after completion, payment.complete patches the total */
      state._splitMode = false;
      state._splitCashPortion = 0;
      state._splitMpesaAmount = 0;
      /* We delegate to original; payment.complete will be called from within with mpesa total */
      /* Wrap complete to inject split metadata */
      const origComplete = payment.complete;
      payment.complete = async function(payInfo) {
        payment.complete = origComplete;
        await origComplete.call(payment, {
          ...payInfo,
          method: 'split',
          amountPaid: cashPortion + (payInfo.amountPaid || mpesaPortion),
          splitCash:  cashPortion,
          splitMpesa: payInfo.amountPaid || mpesaPortion,
        });
      };
      return origSendSTK();
    };
  })();

  /* AI Pricing modal loader */
  function openAIPricing() {
    modal.open('ai-pricing-modal');
    if (window.PosAIEngine) {
      PosAIEngine.pricing.optimizeAll().then(results => {
        PosAIEngine.pricing.renderPanel('ai-pricing-body', results);
      });
    }
  }

  /* ═══════════════════════════════════════════════════════════
     PUBLIC API
  ═══════════════════════════════════════════════════════════ */
  /* ═══════════════════════════════════════════════════════════
     NAVIGATION SERVICE — the single path for all in-shell POS navigation.
     ui.switchTab() is the router; `nav` owns view lifecycle: teardown of the
     view being left, URL-hash deep-linking, Back/Forward, and a nav analytics
     event. Every future POS surface should be a lazily-loaded panel reached via
     this service — never a new window/tab.
  ═══════════════════════════════════════════════════════════ */
  const nav = {
    KNOWN: ['pos', 'orders', 'more', 'inventory', 'reports', 'customers', 'bos', 'finance', 'repair', 'audit', 'settings'],
    _teardowns: {},
    /* A panel that opens a live listener registers its unsub here so leaving the
       panel releases it — the structural guarantee against listener/memory growth. */
    registerTeardown(tab, fn) {
      if (typeof fn !== 'function') return;
      (this._teardowns[tab] = this._teardowns[tab] || []).push(fn);
    },
    _runTeardown(tab) {
      const fns = this._teardowns[tab];
      if (!fns || !fns.length) return;
      this._teardowns[tab] = [];
      fns.forEach(fn => { try { fn(); } catch (_) {} });
    },
    _analytics(tab, from) {
      try { if (window.SokoniAnalytics && typeof SokoniAnalytics.track === 'function') SokoniAnalytics.track('pos_nav', { tab, from }); } catch (_) {}
    },
    /* Semantic alias for switchTab — the single navigate entry-point. */
    go(tab) { ui.switchTab(tab); },
    init() {
      /* Back/Forward: restore the view named in the URL, without pushing a new entry. */
      window.addEventListener('popstate', () => {
        const t = (location.hash || '').replace(/^#/, '') || 'pos';
        if (nav.KNOWN.includes(t)) ui.switchTab(t, { fromHistory: true });
      });
      /* Deep-link on boot: honour an incoming #view (Phase-4 standalone→shell redirects rely on this). */
      const boot = (location.hash || '').replace(/^#/, '');
      if (boot && nav.KNOWN.includes(boot) && boot !== 'pos') ui.switchTab(boot, { fromHistory: true });
    },
  };

  return {
    state, wizard, ui, nav, products, cart, payment, mpesa,
    barcode, inv, reports, customers, cashier, shift,
    settings, profile, sync, data, modal, printerSetup, bos,
    sales, orders, more, po, cats, split,
    toast, printer: PosPrinter, openAIPricing,
    boot,
    /* Debounced helpers for HTML oninput handlers */
    _debouncedProductSearch,
    _debouncedInvSearch,
    _debouncedCustSearch,
  };
})();

/* Boot on DOM ready */
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', SPos.boot);
} else {
  SPos.boot();
}
