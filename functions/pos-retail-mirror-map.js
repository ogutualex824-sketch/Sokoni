/* Pure mapper: a posTransactions doc → the posRetailSales mirror shape that
   sokoni-order-service.js `_fromRetailSale` reads. No firebase deps, so it is unit-testable
   (scripts/test-pos-retail-mirror.js). The trigger adds only createdAt(serverTimestamp). */
'use strict';

function _num (n) { return Number(n || 0); }

function mapTxnToRetail (t, saleId) {
  t = t || {};
  var merchantId = t.sellerId || t.merchantId || t.uid || t.ownerId || null;
  var status = t.status === 'refunded' ? 'refunded' : ((t.voided || t.status === 'voided') ? 'voided' : 'completed');
  return {
    id:            String(saleId),
    merchantId:    merchantId,
    sellerId:      merchantId,           /* satisfies the posRetailSales read rule directly */
    branchId:      t.branchId || null,
    cashierId:     t.cashierId || null,
    cashierName:   t.cashierName || '',
    customer:      { name: t.customerName || 'Walk-in Customer', phone: t.customerPhone || t.customerId || '' },
    items:         (t.items || []).map(function (i) {
                     return { name: i.name || i.productName || 'Item', qty: _num(i.qty != null ? i.qty : i.quantity) || 1, unitPrice: _num(i.unitPrice != null ? i.unitPrice : i.price) };
                   }),
    subtotal:      _num(t.subtotal),
    discountTotal: _num(t.discountAmount != null ? t.discountAmount : t.discount),
    taxTotal:      _num(t.taxAmount != null ? t.taxAmount : t.tax),
    grandTotal:    _num(t.total != null ? t.total : t.grandTotal),
    payments:      [{ method: t.paymentMethod || 'cash' }],
    status:        status,
    saleDateMs:    _num(t.timestamp) || null,
    source:        'pos-mirror',
  };
}

module.exports = { mapTxnToRetail: mapTxnToRetail };
