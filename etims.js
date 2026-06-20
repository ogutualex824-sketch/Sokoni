/* ================================================================
   SOKONI — KRA eTIMS Integration
   Electronic Tax Invoice Management System (OSCU v3)

   SETUP (one-time):
   1. Register at https://etims.kra.go.ke → apply for OSCU
   2. KRA will give you: TIN (your KRA PIN), Branch ID, Device Serial
   3. Fill in ETIMS_CONFIG below
   4. Call SokoniETIMS.initDevice() once to register the device
================================================================ */
(function () {
  'use strict';

  /* ── CONFIG — fill these in after getting OSCU credentials ── */
  var ETIMS_CONFIG = {
    tin:      "",      // Your KRA PIN e.g. "P000111111A"
    bhfId:    "00",    // Branch ID — "00" for head office
    dvcSrlNo: "",      // Device serial number from KRA
    live:     false,   // false = KRA sandbox, true = live production
  };

  var BASE = ETIMS_CONFIG.live
    ? "https://etims-api.kra.go.ke/etims-api"
    : "https://etims-sbx.kra.go.ke/etims-api";

  /* ── Date helpers ── */
  function _pad(n) { return String(n).padStart(2, '0'); }
  function _kraDate(d) {
    d = d || new Date();
    return '' + d.getFullYear() + _pad(d.getMonth() + 1) + _pad(d.getDate());
  }
  function _kraDateTime(d) {
    d = d || new Date();
    return _kraDate(d) + _pad(d.getHours()) + _pad(d.getMinutes()) + _pad(d.getSeconds());
  }

  /* ── Payment type → KRA code ── */
  function _pmtCode(method) {
    var map = { mpesa: '04', card: '03', visa: '03', mastercard: '03', cash: '01', bank: '02', mobile: '04' };
    return map[String(method || '').toLowerCase()] || '01';
  }

  function _isConfigured() {
    return !!(ETIMS_CONFIG.tin && ETIMS_CONFIG.dvcSrlNo);
  }

  /* ── Next sequential invoice number (Firestore-persisted) ── */
  async function _nextInvoiceNo() {
    try {
      if (!window.firebaseDB) return Date.now();
      var fs = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
      var ref = fs.doc(window.firebaseDB, 'etims_config', 'counter');
      var snap = await fs.getDoc(ref);
      var next = snap.exists() ? (snap.data().invoiceNo || 0) + 1 : 1;
      await fs.setDoc(ref, { invoiceNo: next }, { merge: true });
      return next;
    } catch (e) {
      return Date.now();
    }
  }

  /* ════════════════════════════════════════════════════════════
     submitInvoice(order)
     Submits one completed order to KRA eTIMS.
     order: { id, total, items[], buyerName, paymentMethod, buyerKraPin }
  ════════════════════════════════════════════════════════════ */
  async function submitInvoice(order) {
    if (!_isConfigured()) {
      return { error: 'eTIMS not configured. Set tin and dvcSrlNo in etims.js.' };
    }

    var invoiceNo = await _nextInvoiceNo();
    var now = new Date();
    var amount = Number(order.total || order.amount || 0);

    /* VAT-inclusive amounts — 16% (Tax Type B) */
    var taxable = Math.round(amount / 1.16 * 100) / 100;
    var taxAmt  = Math.round((amount - taxable) * 100) / 100;

    var rawItems = order.items && order.items.length
      ? order.items
      : [{ name: 'Order ' + (order.id || ''), price: amount, qty: 1 }];

    var items = rawItems.map(function (item, i) {
      var lineTotal   = Number(item.price || 0) * Number(item.qty || item.quantity || 1);
      var lineTaxable = Math.round(lineTotal / 1.16 * 100) / 100;
      return {
        itemSeq:   i + 1,
        itemCd:    item.id || ('SKN' + String(i + 1).padStart(4, '0')),
        itemClsCd: '5020230602',
        itemNm:    item.name || item.productName || 'Product',
        bcd: null,
        pkgUnitCd: 'EA', pkg: Number(item.qty || item.quantity || 1),
        qtyUnitCd: 'EA', qty: Number(item.qty || item.quantity || 1),
        prc:       Number(item.price || 0),
        splyAmt:   lineTotal,
        dcRt: 0, dcAmt: 0,
        isrccCd: null, isrccNm: null, isrcRt: null, isrcAmt: null,
        taxTyCd:  'B',
        taxblAmt: lineTaxable,
        taxAmt:   Math.round((lineTotal - lineTaxable) * 100) / 100,
        totAmt:   lineTotal,
      };
    });

    var payload = {
      tin:   ETIMS_CONFIG.tin,
      bhfId: ETIMS_CONFIG.bhfId,
      invcNo:    invoiceNo,
      orgInvcNo: 0,
      cisInvcNo: '',
      custTin: order.buyerKraPin || null,
      custNm:  order.buyerName || order.customerName || 'Customer',
      rcptTyCd:    'S',
      pmtTyCd:     _pmtCode(order.paymentMethod),
      salesSttsCd: '02',
      cfmDt:   _kraDateTime(now),
      salesDt: _kraDate(now),
      stockRlsDt: null, cnclReqDt: null, cnclDt: null, rfdDt: null, rfdRsnCd: null,
      totItemCnt: items.length,
      taxblAmtA: 0, taxblAmtB: taxable, taxblAmtC: 0, taxblAmtD: 0, taxblAmtE: 0,
      taxRtA:   0, taxRtB:  16,       taxRtC:   0, taxRtD:   0, taxRtE:   0,
      taxAmtA:  0, taxAmtB: taxAmt,   taxAmtC:  0, taxAmtD:  0, taxAmtE:  0,
      totTaxblAmt: taxable,
      totTaxAmt:   taxAmt,
      totAmt:      amount,
      prchrAcptcYn: 'N',
      remark: 'SOKONI-' + String(order.id || order.ref || invoiceNo),
      rearrangedItems: items,
      payments: [{ payTyCd: _pmtCode(order.paymentMethod), payAmt: amount }],
    };

    try {
      var res = await fetch(BASE + '/saveTrnsSalesSdcInfo', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'tin': ETIMS_CONFIG.tin, 'bhfId': ETIMS_CONFIG.bhfId },
        body:    JSON.stringify(payload),
      });
      var data = await res.json();
      var accepted = String(data.resultCd) === '000';

      /* Persist result to Firestore */
      if (window.firebaseDB) {
        var fs = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
        await fs.setDoc(fs.doc(window.firebaseDB, 'etims_submissions', String(invoiceNo)), {
          invoiceNo:   invoiceNo,
          orderId:     order.id || order.ref || '',
          amount:      amount,
          taxable:     taxable,
          taxAmt:      taxAmt,
          buyerName:   order.buyerName || order.customerName || 'Customer',
          status:      accepted ? 'accepted' : 'rejected',
          kraResultCd: data.resultCd,
          kraResultMsg: data.resultMsg || '',
          cuin: (data.data && data.data.intrlData) || '',
          submittedAt: fs.serverTimestamp(),
        });
      }

      return {
        success:   accepted,
        invoiceNo: invoiceNo,
        cuin:      (data.data && data.data.intrlData) || '',
        kraResponse: data,
      };
    } catch (e) {
      return { error: e.message };
    }
  }

  /* ════════════════════════════════════════════════════════════
     getSubmissions(limit)
     Returns recent eTIMS submissions from Firestore.
  ════════════════════════════════════════════════════════════ */
  async function getSubmissions(limit) {
    limit = limit || 30;
    try {
      if (!window.firebaseDB) return [];
      var fs = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
      var q  = fs.query(
        fs.collection(window.firebaseDB, 'etims_submissions'),
        fs.orderBy('submittedAt', 'desc'),
        fs.limit(limit)
      );
      var snap = await fs.getDocs(q);
      return snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
    } catch (e) {
      console.warn('[eTIMS] getSubmissions error:', e.message);
      return [];
    }
  }

  /* ════════════════════════════════════════════════════════════
     initDevice()
     Run once after getting OSCU credentials from KRA.
     Registers the device on the eTIMS server.
  ════════════════════════════════════════════════════════════ */
  async function initDevice() {
    if (!_isConfigured()) return { error: 'Fill in tin and dvcSrlNo first.' };
    try {
      var res = await fetch(BASE + '/selectInitInfo', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'tin': ETIMS_CONFIG.tin, 'bhfId': ETIMS_CONFIG.bhfId },
        body:    JSON.stringify({ tin: ETIMS_CONFIG.tin, bhfId: ETIMS_CONFIG.bhfId, dvcSrlNo: ETIMS_CONFIG.dvcSrlNo }),
      });
      return await res.json();
    } catch (e) {
      return { error: e.message };
    }
  }

  /* ── Expose globally ── */
  window.SokoniETIMS = {
    submitInvoice:  submitInvoice,
    getSubmissions: getSubmissions,
    initDevice:     initDevice,
    isConfigured:   _isConfigured,
    config:         ETIMS_CONFIG,
  };
})();
