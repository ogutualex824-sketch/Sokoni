/* ================================================================
   SOKONI POS Reports & Analytics Engine v2.0
   Daily/weekly/monthly sales, P&L, tax, product & employee performance
   Works fully offline from IndexedDB — no Firestore reads required
================================================================ */
/* global PosSales, PosInventory, PosSuppliers, PosCustomers */
window.PosReports = (() => {
  'use strict';

  const KES = n => 'KES ' + Number(n || 0).toFixed(2);
  const pct = (n, d) => d ? ((n / d) * 100).toFixed(1) + '%' : '0%';

  /* ── Date helpers ── */
  function _startOf(unit, date = new Date()) {
    const d = new Date(date);
    if (unit === 'day')   { d.setHours(0,0,0,0); return d.getTime(); }
    if (unit === 'week')  { d.setHours(0,0,0,0); d.setDate(d.getDate() - d.getDay()); return d.getTime(); }
    if (unit === 'month') { d.setHours(0,0,0,0); d.setDate(1); return d.getTime(); }
    if (unit === 'year')  { d.setHours(0,0,0,0); d.setMonth(0, 1); return d.getTime(); }
    return 0;
  }

  function _endOf(unit, date = new Date()) {
    const start = _startOf(unit, date);
    if (unit === 'day')   return start + 86400000 - 1;
    if (unit === 'week')  return start + 7 * 86400000 - 1;
    if (unit === 'month') { const d = new Date(start); d.setMonth(d.getMonth() + 1); return d.getTime() - 1; }
    if (unit === 'year')  { const d = new Date(start); d.setFullYear(d.getFullYear() + 1); return d.getTime() - 1; }
    return Date.now();
  }

  function _dateLabel(ts) { return new Date(ts).toLocaleDateString('en-KE', { day: '2-digit', month: 'short', year: 'numeric' }); }

  /* ══════════════════════════════════════════
     SALES SUMMARY (core aggregation)
  ══════════════════════════════════════════ */
  async function _aggregateSales(sales) {
    const nonVoided  = sales.filter(s => s.status !== 'voided');
    const saleSales  = nonVoided.filter(s => s.type === 'sale');
    const refunds    = nonVoided.filter(s => s.type === 'refund');

    const grossRevenue  = saleSales.reduce((t, s) => t + s.total, 0);
    const refundTotal   = refunds.reduce((t, s) => t + Math.abs(s.total), 0);
    const netRevenue    = grossRevenue - refundTotal;
    const totalTax      = saleSales.reduce((t, s) => t + (s.taxAmount || 0), 0);
    const totalDiscount = saleSales.reduce((t, s) => t + (s.discountAmount || 0), 0);
    const totalCoupon   = saleSales.reduce((t, s) => t + (s.couponDiscount || 0), 0);

    /* Payment method breakdown */
    const payBreakdown = {};
    for (const s of saleSales) {
      for (const p of (s.payments || [])) {
        const k = p.method || 'other';
        payBreakdown[k] = (payBreakdown[k] || 0) + p.amount;
      }
    }

    /* Product performance */
    const productMap = {};
    for (const s of saleSales) {
      for (const item of (s.items || [])) {
        if (!productMap[item.productId]) {
          productMap[item.productId] = { productId: item.productId, name: item.name, qty: 0, revenue: 0, cost: 0, profit: 0 };
        }
        productMap[item.productId].qty     += item.qty;
        productMap[item.productId].revenue += item.lineTotal || (item.price * item.qty);
        productMap[item.productId].cost    += (item.cost || 0) * item.qty;
        productMap[item.productId].profit  += (item.lineTotal || (item.price * item.qty)) - ((item.cost || 0) * item.qty);
      }
    }
    const products = Object.values(productMap).sort((a, b) => b.revenue - a.revenue);

    /* Category breakdown */
    const catMap = {};
    for (const s of saleSales) {
      for (const item of (s.items || [])) {
        const cat = item.category || 'Uncategorized';
        catMap[cat] = (catMap[cat] || 0) + (item.lineTotal || item.price * item.qty);
      }
    }

    /* Cashier performance */
    const cashierMap = {};
    for (const s of saleSales) {
      const k = s.cashierId || 'unknown';
      if (!cashierMap[k]) cashierMap[k] = { cashierId: k, sales: 0, revenue: 0, transactions: 0, refunds: 0 };
      cashierMap[k].sales  += s.total;
      cashierMap[k].revenue += s.total;
      cashierMap[k].transactions++;
    }
    for (const s of refunds) {
      const k = s.cashierId || 'unknown';
      if (!cashierMap[k]) cashierMap[k] = { cashierId: k, sales: 0, revenue: 0, transactions: 0, refunds: 0 };
      cashierMap[k].refunds += Math.abs(s.total);
    }
    const cashiers = Object.values(cashierMap).sort((a, b) => b.revenue - a.revenue);

    /* Hourly distribution */
    const hourly = new Array(24).fill(0);
    for (const s of saleSales) { hourly[new Date(s.timestamp).getHours()] += s.total; }

    /* Cost of goods (from item.cost) */
    const cogs = products.reduce((t, p) => t + p.cost, 0);
    const grossProfit  = netRevenue - cogs;
    const profitMargin = netRevenue > 0 ? (grossProfit / netRevenue) * 100 : 0;

    return {
      transactions:   saleSales.length,
      voidedCount:    sales.filter(s => s.status === 'voided').length,
      refundCount:    refunds.length,
      grossRevenue,
      refundTotal,
      netRevenue,
      totalTax,
      totalDiscount,
      totalCoupon,
      cogs,
      grossProfit,
      profitMargin:   Math.round(profitMargin * 10) / 10,
      avgSaleValue:   saleSales.length ? grossRevenue / saleSales.length : 0,
      payBreakdown,
      products,
      topProducts:    products.slice(0, 10),
      slowProducts:   products.slice(-10).reverse(),
      categories:     Object.entries(catMap).map(([name, revenue]) => ({ name, revenue })).sort((a, b) => b.revenue - a.revenue),
      cashiers,
      hourlyRevenue:  hourly,
      peakHour:       hourly.indexOf(Math.max(...hourly)),
    };
  }

  /* ══════════════════════════════════════════
     PERIOD REPORTS
  ══════════════════════════════════════════ */
  async function getDailyReport(branchId, date = new Date()) {
    const from  = _startOf('day', date);
    const until = _endOf('day', date);
    const sales = await PosSales.getSalesInRange(branchId, from, until);
    const agg   = await _aggregateSales(sales);
    const expenses = window.PosSales ? (await PosSales.getExpenses(branchId)).filter(e => e.timestamp >= from && e.timestamp <= until) : [];
    const expenseTotal = expenses.reduce((t, e) => t + e.amount, 0);
    return {
      period: 'day', date: _dateLabel(from), from, until,
      branchId, ...agg, expenses, expenseTotal,
      netProfit: agg.grossProfit - expenseTotal,
    };
  }

  async function getWeeklyReport(branchId, date = new Date()) {
    const from  = _startOf('week', date);
    const until = _endOf('week', date);
    const sales = await PosSales.getSalesInRange(branchId, from, until);
    /* Daily breakdown */
    const daily = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(from + i * 86400000);
      const ds = _startOf('day', d);
      const de = _endOf('day', d);
      const dSales = sales.filter(s => s.timestamp >= ds && s.timestamp <= de && s.status !== 'voided' && s.type === 'sale');
      daily.push({ date: _dateLabel(ds), revenue: dSales.reduce((t, s) => t + s.total, 0), count: dSales.length });
    }
    const agg = await _aggregateSales(sales);
    return { period: 'week', from, until, branchId, ...agg, daily };
  }

  async function getMonthlyReport(branchId, year = new Date().getFullYear(), month = new Date().getMonth()) {
    const d     = new Date(year, month, 1);
    const from  = _startOf('month', d);
    const until = _endOf('month', d);
    const sales = await PosSales.getSalesInRange(branchId, from, until);
    /* Weekly breakdown */
    const weekly = [];
    let weekStart = from;
    while (weekStart <= until) {
      const weekEnd = Math.min(weekStart + 7 * 86400000 - 1, until);
      const wSales  = sales.filter(s => s.timestamp >= weekStart && s.timestamp <= weekEnd && s.status !== 'voided' && s.type === 'sale');
      weekly.push({ week: `W${weekly.length + 1}`, revenue: wSales.reduce((t, s) => t + s.total, 0), count: wSales.length });
      weekStart += 7 * 86400000;
    }
    const agg = await _aggregateSales(sales);
    return { period: 'month', year, month: month + 1, from, until, branchId, ...agg, weekly };
  }

  async function getCustomRangeReport(branchId, from, until) {
    const sales = await PosSales.getSalesInRange(branchId, from, until);
    const agg   = await _aggregateSales(sales);
    return { period: 'custom', from, until, branchId, ...agg };
  }

  /* ══════════════════════════════════════════
     P&L REPORT
  ══════════════════════════════════════════ */
  async function getProfitLossReport(branchId, from, until) {
    const sales       = await PosSales.getSalesInRange(branchId, from, until);
    const agg         = await _aggregateSales(sales.filter(s => s.status !== 'voided'));
    const expenses    = window.PosSales
      ? (await PosSales.getExpenses(branchId)).filter(e => e.timestamp >= from && e.timestamp <= until)
      : [];

    const expByCategory = {};
    for (const e of expenses) {
      expByCategory[e.category] = (expByCategory[e.category] || 0) + e.amount;
    }
    const totalExpenses = expenses.reduce((t, e) => t + e.amount, 0);

    /* Supplier costs from GRNs */
    let purchaseCost = 0;
    if (window.PosSuppliers) {
      const grns = await PosSuppliers.getAllGRNs();
      purchaseCost = grns
        .filter(g => g.receivedAt >= from && g.receivedAt <= until && g.branchId === branchId)
        .reduce((t, g) => t + g.totalCost, 0);
    }

    return {
      period:             { from, until },
      branchId,
      revenue:            agg.netRevenue,
      cogs:               Math.max(agg.cogs, purchaseCost),
      grossProfit:        agg.netRevenue - Math.max(agg.cogs, purchaseCost),
      grossMargin:        agg.netRevenue > 0 ? ((agg.netRevenue - Math.max(agg.cogs, purchaseCost)) / agg.netRevenue * 100).toFixed(1) : '0',
      operatingExpenses:  totalExpenses,
      expenseBreakdown:   Object.entries(expByCategory).map(([category, amount]) => ({ category, amount })),
      operatingProfit:    agg.netRevenue - Math.max(agg.cogs, purchaseCost) - totalExpenses,
      taxAmount:          agg.totalTax,
      netProfit:          agg.netRevenue - Math.max(agg.cogs, purchaseCost) - totalExpenses - agg.totalTax,
      summary:            agg,
    };
  }

  /* ══════════════════════════════════════════
     TAX REPORT
  ══════════════════════════════════════════ */
  async function getTaxReport(branchId, from, until) {
    const sales = await PosSales.getSalesInRange(branchId, from, until);
    const nonVoided = sales.filter(s => s.status !== 'voided' && s.type === 'sale');

    const taxByRate = {};
    for (const s of nonVoided) {
      for (const item of (s.items || [])) {
        const rate = item.taxRate || 0;
        const key  = String(rate);
        if (!taxByRate[key]) taxByRate[key] = { rate, taxableAmount: 0, taxAmount: 0, transactions: 0 };
        taxByRate[key].taxableAmount += item.lineTotal || (item.price * item.qty);
        taxByRate[key].taxAmount     += item.taxAmount || (item.lineTotal || item.price * item.qty) * rate / (100 + rate);
        taxByRate[key].transactions++;
      }
    }

    const totalTaxable = Object.values(taxByRate).reduce((t, r) => t + r.taxableAmount, 0);
    const totalTax     = Object.values(taxByRate).reduce((t, r) => t + r.taxAmount, 0);

    return {
      period:       { from, until },
      branchId,
      breakdown:    Object.values(taxByRate).sort((a, b) => b.rate - a.rate),
      totalTaxable,
      totalTax,
      transactions: nonVoided.length,
    };
  }

  /* ══════════════════════════════════════════
     PRODUCT PERFORMANCE REPORT
  ══════════════════════════════════════════ */
  async function getProductPerformanceReport(branchId, from, until, limit = 50) {
    const sales    = await PosSales.getSalesInRange(branchId, from, until);
    const nonVoided = sales.filter(s => s.status !== 'voided' && s.type === 'sale');
    const agg      = await _aggregateSales(nonVoided);
    const products = agg.products;

    /* Add stock levels */
    if (window.PosInventory) {
      for (const p of products) {
        const stock = await PosInventory.getStock(p.productId, branchId);
        p.currentStock = stock.qty;
      }
    }

    return {
      period:        { from, until },
      branchId,
      topSellers:    products.slice(0, limit),
      slowMovers:    products.slice(-limit).reverse(),
      categories:    agg.categories,
      totalProducts: products.length,
    };
  }

  /* ══════════════════════════════════════════
     EMPLOYEE PERFORMANCE REPORT
  ══════════════════════════════════════════ */
  async function getEmployeePerformanceReport(branchId, from, until) {
    const sales   = await PosSales.getSalesInRange(branchId, from, until);
    const nonVoid = sales.filter(s => s.status !== 'voided' && s.type === 'sale');
    const shifts  = window.PosSales ? (await PosSales.getShifts(branchId)).filter(s => s.startTime >= from && s.startTime <= until) : [];

    const empMap = {};
    for (const s of nonVoid) {
      const k = s.cashierId || 'unknown';
      if (!empMap[k]) empMap[k] = { cashierId: k, transactions: 0, revenue: 0, avgSale: 0, itemsSold: 0, refunds: 0 };
      empMap[k].transactions++;
      empMap[k].revenue   += s.total;
      empMap[k].itemsSold += (s.items || []).reduce((t, i) => t + i.qty, 0);
    }
    for (const s of sales.filter(r => r.type === 'refund')) {
      const k = s.cashierId || 'unknown';
      if (!empMap[k]) empMap[k] = { cashierId: k, transactions: 0, revenue: 0, avgSale: 0, itemsSold: 0, refunds: 0 };
      empMap[k].refunds += Math.abs(s.total);
    }
    for (const e of Object.values(empMap)) {
      e.avgSale = e.transactions ? e.revenue / e.transactions : 0;
      /* Hours worked from shifts */
      const empShifts = shifts.filter(s => s.cashierId === e.cashierId && s.endTime);
      e.hoursWorked = empShifts.reduce((t, s) => t + (s.endTime - s.startTime) / 3600000, 0);
      e.revenuePerHour = e.hoursWorked ? e.revenue / e.hoursWorked : 0;
    }

    return {
      period:    { from, until },
      branchId,
      employees: Object.values(empMap).sort((a, b) => b.revenue - a.revenue),
      shifts,
    };
  }

  /* ══════════════════════════════════════════
     COMMISSION REPORT
  ══════════════════════════════════════════ */
  async function getCommissionReport(branchId, from, until, commissionRates = {}) {
    /* commissionRates: { cashierId: percent } or flat { default: 2 } */
    const empReport = await getEmployeePerformanceReport(branchId, from, until);
    const rows = empReport.employees.map(e => {
      const rate  = commissionRates[e.cashierId] ?? commissionRates.default ?? 0;
      const earned = e.revenue * (rate / 100);
      return { ...e, commissionRate: rate, commissionEarned: Math.round(earned * 100) / 100 };
    });
    return { period: { from, until }, branchId, rows, totalCommission: rows.reduce((t, r) => t + r.commissionEarned, 0) };
  }

  /* ══════════════════════════════════════════
     CASH FLOW REPORT
  ══════════════════════════════════════════ */
  async function getCashFlowReport(branchId, from, until) {
    const sales    = await PosSales.getSalesInRange(branchId, from, until);
    const nonVoid  = sales.filter(s => s.status !== 'voided');
    const inflows  = nonVoid.filter(s => s.type === 'sale');
    const outflows = nonVoid.filter(s => s.type === 'refund');
    const expenses = window.PosSales
      ? (await PosSales.getExpenses(branchId)).filter(e => e.timestamp >= from && e.timestamp <= until)
      : [];

    /* Cash specifically */
    const cashIn  = inflows.reduce((t, s) => t + (s.payments || []).filter(p => p.method === 'cash').reduce((a, p) => a + p.amount, 0), 0);
    const cashOut = outflows.reduce((t, s) => t + Math.abs(s.total), 0);
    const cashExp = expenses.filter(e => e.paymentMethod === 'cash').reduce((t, e) => t + e.amount, 0);

    return {
      period:            { from, until },
      branchId,
      totalInflow:       inflows.reduce((t, s) => t + s.total, 0),
      totalOutflow:      outflows.reduce((t, s) => t + Math.abs(s.total), 0) + expenses.reduce((t, e) => t + e.amount, 0),
      netCashFlow:       inflows.reduce((t, s) => t + s.total, 0) - outflows.reduce((t, s) => t + Math.abs(s.total), 0) - expenses.reduce((t, e) => t + e.amount, 0),
      cashIn, cashOut, cashExpenses: cashExp,
      netCash:           cashIn - cashOut - cashExp,
      paymentBreakdown:  _paymentBreakdown(inflows),
      refunds:           outflows.reduce((t, s) => t + Math.abs(s.total), 0),
      expenses:          expenses.reduce((t, e) => t + e.amount, 0),
      expenseBreakdown:  _expenseBreakdown(expenses),
    };
  }

  function _paymentBreakdown(sales) {
    const m = {};
    for (const s of sales) {
      for (const p of (s.payments || [])) {
        m[p.method] = (m[p.method] || 0) + p.amount;
      }
    }
    return m;
  }

  function _expenseBreakdown(expenses) {
    const m = {};
    for (const e of expenses) { m[e.category] = (m[e.category] || 0) + e.amount; }
    return m;
  }

  /* ══════════════════════════════════════════
     LIVE DASHBOARD METRICS (< 2s response)
  ══════════════════════════════════════════ */
  async function getLiveDashboard(branchId) {
    const now       = Date.now();
    const todayFrom = _startOf('day');
    const weekFrom  = _startOf('week');
    const monthFrom = _startOf('month');

    /* Run all in parallel */
    const [todaySales, weekSales, monthSales] = await Promise.all([
      PosSales.getSalesInRange(branchId, todayFrom, now),
      PosSales.getSalesInRange(branchId, weekFrom, now),
      PosSales.getSalesInRange(branchId, monthFrom, now),
    ]);

    const todayAgg = await _aggregateSales(todaySales.filter(s => s.status !== 'voided'));
    const weekAgg  = await _aggregateSales(weekSales.filter(s => s.status !== 'voided'));
    const monthAgg = await _aggregateSales(monthSales.filter(s => s.status !== 'voided'));

    /* Yesterday for comparison */
    const yFrom  = todayFrom - 86400000;
    const yUntil = todayFrom - 1;
    const ySales = await PosSales.getSalesInRange(branchId, yFrom, yUntil);
    const yAgg   = await _aggregateSales(ySales.filter(s => s.status !== 'voided'));

    /* Low stock */
    const lowStock = window.PosInventory ? await PosInventory.getLowStockItems(branchId) : [];

    /* Expiring */
    const expiring = window.PosInventory ? await PosInventory.getExpiringItems(branchId, 7) : [];

    return {
      today: {
        revenue:      todayAgg.netRevenue,
        transactions: todayAgg.transactions,
        avgSale:      todayAgg.avgSaleValue,
        topProduct:   todayAgg.topProducts[0] || null,
        peakHour:     todayAgg.peakHour,
        change:       yAgg.netRevenue > 0 ? ((todayAgg.netRevenue - yAgg.netRevenue) / yAgg.netRevenue * 100).toFixed(1) : null,
      },
      week: {
        revenue:      weekAgg.netRevenue,
        transactions: weekAgg.transactions,
        profit:       weekAgg.grossProfit,
      },
      month: {
        revenue:      monthAgg.netRevenue,
        transactions: monthAgg.transactions,
        profit:       monthAgg.grossProfit,
        margin:       monthAgg.profitMargin,
      },
      inventory: {
        lowStockCount: lowStock.length,
        expiringCount: expiring.length,
        lowStockItems: lowStock.slice(0, 5),
      },
      payments: todayAgg.payBreakdown,
      timestamp: now,
    };
  }

  /* ══════════════════════════════════════════
     CUSTOMER REPORT
  ══════════════════════════════════════════ */
  async function getCustomerReport(branchId, from, until) {
    const sales = await PosSales.getSalesInRange(branchId, from, until);
    const nonVoid = sales.filter(s => s.status !== 'voided' && s.type === 'sale' && s.customerId);

    const custMap = {};
    for (const s of nonVoid) {
      const k = s.customerId;
      if (!custMap[k]) custMap[k] = { customerId: k, name: s.customerName || '', visits: 0, revenue: 0, loyaltyEarned: 0 };
      custMap[k].visits++;
      custMap[k].revenue      += s.total;
      custMap[k].loyaltyEarned += s.loyaltyEarned || 0;
    }

    const newCustomers = window.PosCustomers
      ? (await PosCustomers.getAllCustomers()).filter(c => c.joinedAt >= from && c.joinedAt <= until)
      : [];

    const topCustomers = Object.values(custMap).sort((a, b) => b.revenue - a.revenue).slice(0, 20);

    return {
      period:       { from, until },
      totalCustomerSales: nonVoid.length,
      uniqueCustomers:    Object.keys(custMap).length,
      newCustomers:       newCustomers.length,
      topCustomers,
      avgOrderValue:      nonVoid.length ? nonVoid.reduce((t, s) => t + s.total, 0) / nonVoid.length : 0,
      repeatRate:         pct(Object.values(custMap).filter(c => c.visits > 1).length, Object.keys(custMap).length),
    };
  }

  /* ══════════════════════════════════════════
     EXPORT HELPERS
  ══════════════════════════════════════════ */
  function toCSV(rows, headers) {
    const head = headers.join(',');
    const body = rows.map(r => headers.map(h => JSON.stringify(r[h] ?? '')).join(','));
    return [head, ...body].join('\n');
  }

  function downloadCSV(filename, content) {
    const blob = new Blob([content], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href  = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function exportDailySalesCSV(branchId, date) {
    const report = await getDailyReport(branchId, date);
    const rows   = report.products.map(p => ({
      product: p.name, qty: p.qty, revenue: p.revenue.toFixed(2), cost: p.cost.toFixed(2), profit: p.profit.toFixed(2),
    }));
    downloadCSV(`sales-${report.date}.csv`, toCSV(rows, ['product','qty','revenue','cost','profit']));
  }

  return {
    /* Period reports */
    getDailyReport, getWeeklyReport, getMonthlyReport, getCustomRangeReport,
    /* Detailed reports */
    getProfitLossReport, getTaxReport, getProductPerformanceReport,
    getEmployeePerformanceReport, getCommissionReport, getCashFlowReport,
    /* Live dashboard */
    getLiveDashboard,
    /* Customer */
    getCustomerReport,
    /* Export */
    exportDailySalesCSV, toCSV, downloadCSV,
    /* Helpers */
    KES, pct,
  };
})();
