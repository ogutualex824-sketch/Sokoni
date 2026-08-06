/* SOKONI SmartPOS — Business Operating System v1.0
   Multi-branch sync, WhatsApp receipts, Supplier auto-PO,
   Customer loyalty tiers, Marketplace push, Delivery dispatch,
   Payment success overlay. */

'use strict';

const PosBoss = (() => {

  /* ══════════════════════════════════════════════════════
     MULTI-BRANCH MANAGEMENT
  ══════════════════════════════════════════════════════ */
  const branch = {
    current: 'main',
    all: [],

    async init(settings) {
      branch.current = settings.branchId || 'main';
      if (!window.firebaseApp) return;
      try {
        const { getFirestore, collection, onSnapshot, query, where } = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
        const db    = getFirestore(window.firebaseApp);
        const bizId = settings.businessId || settings.bizPin || 'default';
        onSnapshot(
          query(collection(db, 'pos_branches'), where('businessId', '==', bizId)),
          snap => {
            branch.all = snap.docs.map(d => ({ id: d.id, ...d.data() }));
            branch._updateSelector();
          }
        );
      } catch (_) {}
    },

    _updateSelector() {
      const el = document.getElementById('branch-name-el');
      if (!el) return;
      if (branch.all.length > 1) {
        el.innerHTML = `<select class="branch-select" onchange="PosBoss.branch.switchTo(this.value)">
          ${branch.all.map(b => `<option value="${b.id}" ${b.id === branch.current ? 'selected' : ''}>${_esc(b.name)}</option>`).join('')}
        </select>`;
      } else {
        el.textContent = branch.all[0]?.name || 'Main Branch';
      }
    },

    async switchTo(branchId) {
      await PosDB.settings.set('branchId', branchId);
      branch.current = branchId;
      const name = branch.all.find(b => b.id === branchId)?.name || branchId;
      _toast(`Switched to: ${name}`, 'info');
    },

    async syncInventory() {
      if (!window.firebaseApp) { _toast('Cloud sync requires internet', 'error'); return; }
      const settings = await PosDB.settings.getAll();
      const products = await PosDB.products.getAll();
      const { getFirestore, writeBatch, doc, collection } = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
      const db    = getFirestore(window.firebaseApp);
      const bizId = settings.businessId || settings.bizPin || 'default';
      const batches = [];
      let   curr   = writeBatch(db);
      let   count  = 0;

      for (const p of products) {
        const ref = doc(db, 'pos_inventory', `${bizId}_${branch.current}_${p.id}`);
        curr.set(ref, { ...p, branchId: branch.current, businessId: bizId, syncedAt: new Date() }, { merge: true });
        count++;
        if (count % 450 === 0) { batches.push(curr.commit()); curr = writeBatch(db); }
      }
      batches.push(curr.commit());
      await Promise.all(batches);
      _toast(`✓ ${products.length} products synced to cloud`, 'success');
    },
  };

  /* ══════════════════════════════════════════════════════
     WHATSAPP RECEIPT DELIVERY
  ══════════════════════════════════════════════════════ */
  const whatsapp = {
    buildReceiptText(txn, bizSettings) {
      const lines = [
        `*${bizSettings.bizName || 'SOKONI SmartPOS'}*`,
        `📋 Receipt No: ${txn.receiptNo || 'N/A'}`,
        `📅 ${new Date(txn.timestamp || Date.now()).toLocaleString('en-KE')}`,
        `👤 Cashier: ${txn.cashierName || 'N/A'}`,
        txn.customerName ? `🤝 Customer: ${txn.customerName}` : null,
        '',
        '*ITEMS*',
        ...(txn.items || []).map(i => `  • ${i.name} × ${i.qty} @ KES ${Number(i.price).toFixed(2)} = *KES ${(i.qty * i.price).toFixed(2)}*`),
        '',
        txn.discountAmount > 0 ? `Discount: *-KES ${txn.discountAmount.toFixed(2)}*` : null,
        txn.taxAmount      > 0 ? `VAT: KES ${txn.taxAmount.toFixed(2)}` : null,
        `*TOTAL: KES ${Number(txn.total || 0).toFixed(2)}*`,
        `Paid via: *${(txn.paymentMethod || 'CASH').toUpperCase()}*`,
        txn.mpesaRef ? `M-PESA Ref: \`${txn.mpesaRef}\`` : null,
        txn.change > 0 ? `Change: KES ${txn.change.toFixed(2)}` : null,
        '',
        bizSettings.receiptFooter || 'Thank you for shopping with us! 🙏',
        '_Powered by SOKONI SmartPOS_',
      ].filter(l => l !== null);

      return encodeURIComponent(lines.join('\n'));
    },

    send(txn, bizSettings, phone) {
      const text  = whatsapp.buildReceiptText(txn, bizSettings);
      let   url   = `https://wa.me/?text=${text}`;

      if (phone) {
        const clean = phone.replace(/\D/g, '');
        const e164  = clean.startsWith('254') ? clean : '254' + clean.replace(/^0/, '');
        url = `https://wa.me/${e164}?text=${text}`;
      }

      window.open(url, '_blank', 'noopener,noreferrer');
    },
  };

  /* ══════════════════════════════════════════════════════
     SUPPLIER AUTO PURCHASE ORDERS
  ══════════════════════════════════════════════════════ */
  const supplierPO = {
    async checkAndGenerate(forecasts) {
      if (!forecasts) forecasts = await PosAnalytics.getForecast();
      const needReorder = (forecasts || []).filter(f => f.needsReorder);
      if (!needReorder.length) return [];

      const bySupplier = {};
      for (const f of needReorder) {
        const key = f.supplierId || 'unassigned';
        if (!bySupplier[key]) bySupplier[key] = { supplierId: f.supplierId, items: [] };
        bySupplier[key].items.push(f);
      }

      const poList = [];
      for (const [key, group] of Object.entries(bySupplier)) {
        let supplierName = 'General Supplier', supplierPhone = '', supplierEmail = '';
        if (group.supplierId) {
          const sup = await PosDB.suppliers.getById(group.supplierId);
          supplierName  = sup?.name  || supplierName;
          supplierPhone = sup?.phone || '';
          supplierEmail = sup?.email || '';
        }

        const po = {
          supplierId:    group.supplierId || null,
          supplierName,
          supplierPhone,
          supplierEmail,
          items: group.items.map(f => ({
            productId:   f.id,
            productName: f.name,
            qty:         f.reorderQty,
            cost:        f.cost,
            lineTotal:   f.reorderQty * f.cost,
          })),
          totalCost: group.items.reduce((s, f) => s + f.reorderQty * f.cost, 0),
          status:    'draft',
          auto:      true,
          note:      `Auto PO — ${group.items.length} item(s) running low`,
        };

        await PosDB.purchase_orders.save(po);
        poList.push(po);
      }

      return poList;
    },

    async quickOrder(productId, qty) {
      const p   = await PosDB.products.getById(productId);
      if (!p) return;
      let sup = null;
      if (p.supplierId) sup = await PosDB.suppliers.getById(p.supplierId);

      const po = {
        supplierId:    p.supplierId || null,
        supplierName:  sup?.name  || 'Supplier',
        supplierPhone: sup?.phone || '',
        items: [{ productId: p.id, productName: p.name, qty, cost: p.cost || 0, lineTotal: qty * (p.cost || 0) }],
        totalCost: qty * (p.cost || 0),
        status: 'draft', auto: false,
      };
      await PosDB.purchase_orders.save(po);

      if (sup?.phone) {
        supplierPO.sendWhatsApp(po);
      } else {
        _toast(`PO created for ${qty}× ${p.name}. Add supplier phone to send via WhatsApp.`, 'info');
      }
    },

    sendWhatsApp(po) {
      const lines = [
        `*Purchase Order — ${new Date().toLocaleDateString('en-KE')}*`,
        `To: *${_esc(po.supplierName)}*`,
        '',
        '*Items Required:*',
        ...(po.items || []).map(i => `  • ${_esc(i.productName)}: *${i.qty} units* @ KES ${Number(i.cost || 0).toFixed(2)}`),
        '',
        `*Estimated Total: KES ${Number(po.totalCost || 0).toFixed(2)}*`,
        '',
        'Please confirm availability and expected delivery date.',
        '_SOKONI SmartPOS_',
      ];
      const text  = encodeURIComponent(lines.join('\n'));
      const phone = (po.supplierPhone || '').replace(/\D/g, '');
      const url   = phone.length >= 9 ? `https://wa.me/${phone.startsWith('254') ? phone : '254' + phone.replace(/^0/, '')}?text=${text}` : `https://wa.me/?text=${text}`;
      window.open(url, '_blank', 'noopener,noreferrer');
    },
  };

  /* ══════════════════════════════════════════════════════
     CUSTOMER LOYALTY TIERS
  ══════════════════════════════════════════════════════ */
  const loyalty = {
    TIERS: [
      { name: 'Bronze',  icon: '🥉', minSpend: 0,     color: '#cd7f32', discount: 0,  multiplier: 1   },
      { name: 'Silver',  icon: '🥈', minSpend: 5000,  color: '#c0c0c0', discount: 2,  multiplier: 1.5 },
      { name: 'Gold',    icon: '🥇', minSpend: 20000, color: '#ffd700', discount: 5,  multiplier: 2   },
      { name: 'Diamond', icon: '💎', minSpend: 50000, color: '#b9f2ff', discount: 10, multiplier: 3   },
    ],

    getTier(totalSpent) {
      return [...loyalty.TIERS].reverse().find(t => (totalSpent || 0) >= t.minSpend) || loyalty.TIERS[0];
    },

    getNextTier(totalSpent) {
      return loyalty.TIERS.find(t => t.minSpend > (totalSpent || 0)) || null;
    },

    getLoyaltyDiscount(customer) {
      if (!customer) return 0;
      return loyalty.getTier(customer.totalSpent).discount;
    },

    async renderCard(customer) {
      if (!customer) return '';
      const tier     = loyalty.getTier(customer.totalSpent || 0);
      const nextTier = loyalty.getNextTier(customer.totalSpent || 0);
      const progress = nextTier
        ? Math.min(100, ((customer.totalSpent - tier.minSpend) / (nextTier.minSpend - tier.minSpend)) * 100)
        : 100;

      return `<div class="loyalty-card" style="border-color:${tier.color}44">
        <div class="loyalty-card-top">
          <span class="loyalty-tier-icon">${tier.icon}</span>
          <div>
            <div class="loyalty-tier-name" style="color:${tier.color}">${tier.name} Member</div>
            <div class="loyalty-customer-name">${_esc(customer.name || 'Customer')}</div>
          </div>
          <div class="loyalty-points-badge">${(customer.points || 0).toLocaleString()} pts</div>
        </div>
        ${tier.discount > 0 ? `<div class="loyalty-discount-line" style="color:${tier.color}">✓ ${tier.discount}% loyalty discount active</div>` : ''}
        ${nextTier ? `
          <div class="loyalty-progress-row">
            <span>KES ${((nextTier.minSpend - (customer.totalSpent||0)).toLocaleString())} to ${nextTier.icon} ${nextTier.name}</span>
            <div class="loyalty-progress-bar"><div style="width:${progress.toFixed(0)}%;background:${tier.color}"></div></div>
          </div>` : `<div style="font-size:10px;color:${tier.color};margin-top:4px">💎 Top tier — maximum benefits!</div>`}
      </div>`;
    },
  };

  /* ══════════════════════════════════════════════════════
     SOKONI MARKETPLACE INTEGRATION
  ══════════════════════════════════════════════════════ */
  const marketplace = {
    async pushProducts(productIds) {
      if (!window.firebaseApp) throw new Error('Marketplace sync requires internet connection');
      const settings = await PosDB.settings.getAll();
      const products = (await Promise.all(productIds.map(id => PosDB.products.getById(id)))).filter(Boolean);
      if (!products.length) throw new Error('No valid products selected');

      const { getFirestore, doc, setDoc, serverTimestamp } = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
      const db    = getFirestore(window.firebaseApp);
      const bizId = settings.bizPin || settings.businessId || 'pos';

      for (const p of products) {
        await setDoc(doc(db, 'products', `pos_${bizId}_${p.id}`), {
          name:        p.name,
          price:       p.price,
          category:    p.category,
          barcode:     p.barcode,
          unit:        p.unit,
          inStock:     (p.stock || 0) > 0,
          stockQty:    p.stock || 0,
          sellerId:    bizId,
          sellerName:  settings.bizName || 'SOKONI POS',
          source:      'smartpos',
          updatedAt:   serverTimestamp(),
        }, { merge: true });
      }
      return products.length;
    },

    async pullOrders() {
      if (!window.firebaseApp) return [];
      const settings = await PosDB.settings.getAll();
      const { getFirestore, collection, query, where, getDocs, orderBy, limit } = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
      const db  = getFirestore(window.firebaseApp);
      const bizId = settings.bizPin || settings.businessId || 'pos';
      const q   = query(collection(db, 'orders'), where('sellerId', '==', bizId), where('status', '==', 'paid'), orderBy('createdAt', 'desc'), limit(50));
      const snap = await getDocs(q);
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    },

    async renderOrders(containerId) {
      const el = document.getElementById(containerId);
      if (!el) return;
      el.innerHTML = '<div class="pos-empty" style="padding:20px"><div class="empty-icon">⏳</div><p>Loading marketplace orders...</p></div>';
      try {
        const orders = await marketplace.pullOrders();
        if (!orders.length) { el.innerHTML = '<div class="pos-empty" style="padding:40px"><div class="empty-icon">🛒</div><p>No pending marketplace orders</p></div>'; return; }
        el.innerHTML = `<table class="data-table">
          <thead><tr><th>Order</th><th>Customer</th><th class="td-right">Total</th><th>Status</th><th>Actions</th></tr></thead>
          <tbody>${orders.map(o => `<tr>
            <td style="font-family:monospace;font-size:11px">#${o.id.slice(-6)}</td>
            <td>${_esc(o.buyerName || o.buyerId || '-')}</td>
            <td class="td-right">KES ${_fmt(o.totalAmount || 0)}</td>
            <td><span class="stock-badge stock-ok">${o.status}</span></td>
            <td><button class="row-btn" onclick="PosBoss.delivery.promptDispatch('${o.id}','${_esc(o.deliveryAddress||'')}')">Dispatch</button></td>
          </tr>`).join('')}</tbody>
        </table>`;
      } catch (e) {
        el.innerHTML = `<div class="pos-empty" style="padding:20px;color:var(--red)">${_esc(e.message)}</div>`;
      }
    },
  };

  /* ══════════════════════════════════════════════════════
     DELIVERY DISPATCH
  ══════════════════════════════════════════════════════ */
  const delivery = {
    async dispatch(txn, dropAddress) {
      if (!window.firebaseApp) { _toast('Delivery requires internet connection', 'error'); return null; }
      const settings = await PosDB.settings.getAll();
      const { getFirestore, collection, addDoc, serverTimestamp } = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
      const db = getFirestore(window.firebaseApp);

      const ref = await addDoc(collection(db, 'rides'), {
        type:          'delivery',
        status:        'pending',
        pickupAddress: settings.bizAddress || 'Store',
        dropAddress,
        items:         (txn.items || []).map(i => ({ name: i.name, qty: i.qty })),
        totalValue:    txn.total,
        customerId:    txn.customerId || null,
        customerPhone: txn.mpesaPhone || null,
        sellerId:      settings.bizPin || null,
        sellerName:    settings.bizName || null,
        receiptNo:     txn.receiptNo,
        source:        'smartpos',
        createdAt:     serverTimestamp(),
      });

      _toast('✓ Delivery dispatched! Rider will be assigned shortly.', 'success');
      return ref.id;
    },

    promptDispatch(orderId, defaultAddress) {
      const addr = prompt('Customer delivery address:', defaultAddress || '');
      if (!addr) return;
      delivery.dispatch({ receiptNo: orderId, items: [], total: 0 }, addr);
    },
  };

  /* ══════════════════════════════════════════════════════
     PAYMENT SUCCESS OVERLAY
  ══════════════════════════════════════════════════════ */
  function showSuccess(txn, bizSettings) {
    const overlay = document.getElementById('success-overlay');
    if (!overlay) return;

    /* Fill fields */
    _setText('suc-total',       `KES ${Number(txn.total || 0).toFixed(2)}`);
    _setText('suc-method',      (txn.paymentMethod || 'cash').toUpperCase());
    _setText('suc-receipt-no',  txn.receiptNo || '');
    _setText('suc-cashier',     txn.cashierName || '');
    _setText('suc-customer',    txn.customerName || 'Walk-in');

    const changeEl = document.getElementById('suc-change-row');
    if (changeEl) {
      changeEl.style.display = (txn.change || 0) > 0 ? 'flex' : 'none';
      _setText('suc-change', `KES ${(txn.change || 0).toFixed(2)}`);
    }

    const mpesaEl = document.getElementById('suc-mpesa-row');
    if (mpesaEl) {
      mpesaEl.style.display = txn.mpesaRef ? 'flex' : 'none';
      _setText('suc-mpesa-ref', txn.mpesaRef || '');
    }

    /* WhatsApp button */
    const waBtn = document.getElementById('suc-whatsapp-btn');
    if (waBtn) {
      const phone = txn.mpesaPhone || txn.customerPhone;
      waBtn.style.display = 'flex';
      waBtn.onclick = () => whatsapp.send(txn, bizSettings, phone);
    }

    /* Print button */
    const pBtn = document.getElementById('suc-print-btn');
    if (pBtn) pBtn.onclick = () => {
      const d = { ...txn, ...bizSettings };
      /* Route through the single public print API (PosPrintService); fall back to the
         legacy chain if the service is absent. Fire-and-forget. */
      if (window.PosPrintService && typeof PosPrintService.printReceipt === 'function') {
        PosPrintService.printReceipt(d, {}).catch(() => {
          if (window.SokoniPrint) SokoniPrint.print('receipt', d).catch(() => window.PosPrinter && PosPrinter.printBrowser(d));
        });
      } else if (window.SokoniPrint) {
        SokoniPrint.print('receipt', d).catch(() => PosPrinter.printBrowser(d));
      } else if (window.PosPrinter) {
        PosPrinter.print(d).catch(() => PosPrinter.printBrowser(d));
      }
    };

    /* Delivery button */
    const dBtn = document.getElementById('suc-delivery-btn');
    if (dBtn) {
      dBtn.style.display = txn.customerId ? 'flex' : 'none';
      dBtn.onclick = () => {
        const addr = prompt('Delivery address:');
        if (addr) delivery.dispatch(txn, addr);
      };
    }

    overlay.classList.add('open');

    /* Auto-close after 5 seconds unless user interacted */
    const timer = setTimeout(() => overlay.classList.remove('open'), 5000);
    overlay.querySelector('.suc-close-btn')?.addEventListener('click', () => { clearTimeout(timer); overlay.classList.remove('open'); }, { once: true });
  }

  /* ══════════════════════════════════════════════════════
     BOS QUICK-ACCESS HUB PANEL
  ══════════════════════════════════════════════════════ */
  const hub = {
    async renderActions(containerId) {
      const el = document.getElementById(containerId);
      if (!el) return;
      const forecasts = await PosAnalytics.getForecast();
      const reorderCount = forecasts.filter(f => f.needsReorder).length;

      el.innerHTML = `
        <div class="bos-actions-grid">
          <button class="bos-action-tile green" onclick="PosBoss.branch.syncInventory()">
            <span class="bos-action-icon">☁️</span>
            <span>Sync Inventory<br><small>Push to cloud</small></span>
          </button>
          <button class="bos-action-tile ${reorderCount > 0 ? 'amber' : ''}" onclick="PosAnalytics.generatePOFromForecasts()">
            <span class="bos-action-icon">🛒</span>
            <span>Auto-Order${reorderCount > 0 ? `<br><small style="color:var(--amber)">${reorderCount} items needed</small>` : '<br><small>Stock is healthy</small>'}</span>
          </button>
          <button class="bos-action-tile" onclick="PosBoss.marketplace.renderOrders('mkt-orders-body');SPos.modal.open('marketplace-modal')">
            <span class="bos-action-icon">🛍️</span>
            <span>Marketplace<br><small>View orders</small></span>
          </button>
          <button class="bos-action-tile" onclick="SPos.modal.open('push-products-modal');PosBoss.hub.renderPushList()">
            <span class="bos-action-icon">📤</span>
            <span>Push to Market<br><small>List products online</small></span>
          </button>
        </div>
      `;
    },

    async renderPushList() {
      const products = await PosDB.products.getAll();
      const container = document.getElementById('push-products-list');
      if (!container) return;
      container.innerHTML = `
        <div style="max-height:320px;overflow-y:auto">
          <div style="padding:8px 0"><label style="font-size:12px"><input type="checkbox" id="push-all" onchange="document.querySelectorAll('.push-chk').forEach(c=>c.checked=this.checked)" checked> Select all (${products.length})</label></div>
          ${products.map(p => `
            <label class="push-product-row">
              <input type="checkbox" class="push-chk" value="${p.id}" checked style="accent-color:var(--green)">
              <span class="push-name">${_esc(p.name)}</span>
              <span class="push-price">KES ${Number(p.price||0).toFixed(2)}</span>
              <span class="push-stock ${(p.stock||0) > 0 ? 'stock-ok' : 'stock-out'}">${p.stock||0} in stock</span>
            </label>
          `).join('')}
        </div>
      `;
    },

    async confirmPush() {
      const ids = [...document.querySelectorAll('.push-chk:checked')].map(c => c.value);
      if (!ids.length) { _toast('Select at least one product', 'error'); return; }
      const btn = document.getElementById('push-confirm-btn');
      if (btn) { btn.disabled = true; btn.textContent = 'Pushing...'; }
      try {
        const count = await marketplace.pushProducts(ids);
        _toast(`✓ ${count} products listed on Sokoni marketplace`, 'success');
        if (window.SPos) SPos.modal.close('push-products-modal');
      } catch (e) {
        _toast('Push failed: ' + e.message, 'error');
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Push to Marketplace'; }
      }
    },
  };

  /* ── Helpers ─────────────────────────────────────────────────────── */
  function _setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }
  function _esc(s)  { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function _fmt(n)  { return Number(n || 0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function _toast(msg, type) { if (window.SPos) SPos.toast(msg, type); }

  return { branch, whatsapp, supplierPO, loyalty, marketplace, delivery, showSuccess, hub };
})();

window.PosBoss = PosBoss;
