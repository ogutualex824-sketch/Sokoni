/* SOKONI SmartPOS — Finance Module v1.0
   Requirements 31, 37: Expense tracking, P&L, Cash flow,
   Payroll, Attendance (clock-in/out with PAYE calculation). */

'use strict';

const PosFinance = (() => {

  /* ── Expense categories ────────────────────────────────────── */
  const EXPENSE_CATEGORIES = [
    'Rent', 'Utilities', 'Salaries', 'Stock Purchase', 'Transport',
    'Marketing', 'Repairs & Maintenance', 'Security', 'Insurance',
    'Internet & Phone', 'Packaging', 'Bank Charges', 'Other',
  ];

  /* ── Kenya PAYE tax bands 2026 ─────────────────────────────── */
  function _calcPAYE(grossMonthly) {
    /* KRA tax bands (monthly) */
    const bands = [
      { limit: 24000,  rate: 0.10 },
      { limit: 32333,  rate: 0.25 },
      { limit: 500000, rate: 0.30 },
      { limit: 800000, rate: 0.325 },
      { limit: Infinity, rate: 0.35 },
    ];
    let remaining = grossMonthly;
    let tax       = 0;
    let start     = 0;
    for (const b of bands) {
      const slice = Math.min(remaining, b.limit - start);
      if (slice <= 0) break;
      tax       += slice * b.rate;
      remaining -= slice;
      start      = b.limit;
      if (remaining <= 0) break;
    }
    /* Personal relief KES 2400/month */
    return Math.max(0, tax - 2400);
  }

  /* ── NSSF (new rates 2024+) ────────────────────────────────── */
  function _calcNSSF(gross) {
    const tier1 = Math.min(gross, 7000)  * 0.06;
    const tier2 = Math.min(Math.max(gross - 7000, 0), 29000) * 0.06;
    return tier1 + tier2;
  }

  /* ── NHIF (simplified) ─────────────────────────────────────── */
  function _calcNHIF(gross) {
    if (gross <= 5999)   return 150;
    if (gross <= 7999)   return 300;
    if (gross <= 11999)  return 400;
    if (gross <= 14999)  return 500;
    if (gross <= 19999)  return 600;
    if (gross <= 24999)  return 750;
    if (gross <= 29999)  return 850;
    if (gross <= 34999)  return 900;
    if (gross <= 39999)  return 950;
    if (gross <= 44999)  return 1000;
    if (gross <= 49999)  return 1100;
    if (gross <= 59999)  return 1200;
    if (gross <= 69999)  return 1300;
    if (gross <= 79999)  return 1400;
    if (gross <= 89999)  return 1500;
    if (gross <= 99999)  return 1600;
    return 1700;
  }

  /* ═══════════════════════════════════════════════════════════
     EXPENSES
  ════════════════════════════════════════════════════════════ */
  const expenses = {
    async add(data) {
      if (!data.amount || data.amount <= 0) throw new Error('Amount required');
      return PosDB.expenses.add({
        ...data,
        amount:    parseFloat(data.amount),
        category:  data.category || 'Other',
        date:      data.date || Date.now(),
        createdAt: Date.now(),
        addedBy:   window.SPos?.state?.cashier?.name || 'System',
      });
    },

    async getForPeriod(startTs, endTs) {
      const all = await PosDB.expenses.getAll();
      return all.filter(e => e.date >= startTs && e.date <= endTs);
    },

    async getByCategory(startTs, endTs) {
      const list = await this.getForPeriod(startTs, endTs);
      const bycat = {};
      for (const e of list) {
        if (!bycat[e.category]) bycat[e.category] = 0;
        bycat[e.category] += e.amount;
      }
      return bycat;
    },

    async totalForPeriod(startTs, endTs) {
      const list = await this.getForPeriod(startTs, endTs);
      return list.reduce((s, e) => s + e.amount, 0);
    },

    async update(id, data) { return PosDB.expenses.update(id, data); },
    async delete(id)       { return PosDB.expenses.delete(id); },

    renderForm(containerId, onSave) {
      const el = document.getElementById(containerId);
      if (!el) return;
      const today = new Date().toISOString().slice(0, 10);
      el.innerHTML = `
        <div class="finance-form">
          <div class="form-row">
            <label class="form-lbl">Date</label>
            <input type="date" id="exp-date" class="form-inp" value="${today}" style="font-size:16px">
          </div>
          <div class="form-row">
            <label class="form-lbl">Category</label>
            <select id="exp-cat" class="form-inp" style="font-size:16px">
              ${EXPENSE_CATEGORIES.map(c => `<option>${c}</option>`).join('')}
            </select>
          </div>
          <div class="form-row">
            <label class="form-lbl">Description</label>
            <input type="text" id="exp-desc" class="form-inp" placeholder="e.g. Monthly rent paid" style="font-size:16px">
          </div>
          <div class="form-row">
            <label class="form-lbl">Amount (KES)</label>
            <input type="number" id="exp-amount" class="form-inp" placeholder="0" min="0" step="0.01" style="font-size:16px">
          </div>
          <div class="form-row">
            <label class="form-lbl">Receipt No. (optional)</label>
            <input type="text" id="exp-ref" class="form-inp" placeholder="INV-001" style="font-size:16px">
          </div>
          <button class="pos-btn-primary" style="width:100%;margin-top:12px"
            onclick="PosFinance.expenses._saveForm('${containerId}')">
            Save Expense
          </button>
        </div>
      `;
    },

    async _saveForm(containerId) {
      const amount = parseFloat(document.getElementById('exp-amount')?.value || 0);
      if (!amount) { if (window.SPos) SPos.toast('Enter an amount', 'error'); return; }
      const data = {
        date:        new Date(document.getElementById('exp-date')?.value).getTime(),
        category:    document.getElementById('exp-cat')?.value,
        description: document.getElementById('exp-desc')?.value,
        amount,
        receiptNo:   document.getElementById('exp-ref')?.value,
      };
      await this.add(data);
      if (window.SPos) SPos.toast('Expense saved', 'success');
    },
  };

  /* ═══════════════════════════════════════════════════════════
     PROFIT & LOSS STATEMENT
  ════════════════════════════════════════════════════════════ */
  const pnl = {
    async generate(startTs, endTs) {
      const [report, expenseTotal, expenseByCategory] = await Promise.all([
        PosDB.reports.forDateRange(startTs, endTs),
        expenses.totalForPeriod(startTs, endTs),
        expenses.getByCategory(startTs, endTs),
      ]);

      const revenue    = report.total      || 0;
      const cogs       = revenue - (report.profit || 0);
      const grossProfit = revenue - cogs;
      const opProfit   = grossProfit - expenseTotal;
      const taxRate    = 0.30;
      const taxAmount  = Math.max(0, opProfit * taxRate);
      const netProfit  = opProfit - taxAmount;
      const grossMargin = revenue > 0 ? (grossProfit / revenue * 100).toFixed(1) : 0;
      const netMargin   = revenue > 0 ? (netProfit  / revenue * 100).toFixed(1) : 0;

      return {
        period: { start: startTs, end: endTs },
        income: {
          revenue,
          cogs,
          grossProfit,
          grossMargin: parseFloat(grossMargin),
        },
        expenses: {
          total: expenseTotal,
          byCategory: expenseByCategory,
          operating: expenseTotal,
        },
        profit: {
          operating: opProfit,
          taxAmount,
          net: netProfit,
          netMargin: parseFloat(netMargin),
        },
        transactions: report.count || 0,
      };
    },

    async render(containerId, startTs, endTs) {
      const el = document.getElementById(containerId);
      if (!el) return;
      el.innerHTML = '<div class="bos-loading">Generating P&L…</div>';

      const data = await this.generate(startTs, endTs).catch(e => ({ error: e.message }));
      if (data.error) { el.innerHTML = '<div class="bos-error"></div>'; el.firstChild.textContent = data.error || 'Report failed'; return; }

      const _fmt = n => `KES ${(n || 0).toLocaleString('en-KE', { minimumFractionDigits: 0 })}`;
      const _color = n => n >= 0 ? 'var(--green)' : 'var(--red)';

      const catRows = Object.entries(data.expenses.byCategory)
        .sort((a, b) => b[1] - a[1])
        .map(([cat, amt]) => `<tr><td style="padding-left:16px;color:var(--txt2)">${cat}</td><td class="pnl-num" style="color:var(--red)">( ${_fmt(amt)} )</td></tr>`)
        .join('');

      el.innerHTML = `
        <div class="pnl-header">
          <div class="pnl-title">Income Statement (P&L)</div>
          <div class="pnl-period">${new Date(startTs).toLocaleDateString()} – ${new Date(endTs).toLocaleDateString()}</div>
        </div>
        <table class="pnl-table">
          <tbody>
            <tr class="pnl-section-hdr"><td colspan="2">REVENUE</td></tr>
            <tr><td>Net Sales</td><td class="pnl-num">${_fmt(data.income.revenue)}</td></tr>
            <tr><td>Cost of Goods Sold (COGS)</td><td class="pnl-num" style="color:var(--red)">( ${_fmt(data.income.cogs)} )</td></tr>
            <tr class="pnl-total"><td>Gross Profit <span class="pnl-margin">${data.income.grossMargin}%</span></td>
              <td class="pnl-num" style="color:${_color(data.income.grossProfit)}">${_fmt(data.income.grossProfit)}</td></tr>

            <tr class="pnl-section-hdr"><td colspan="2">OPERATING EXPENSES</td></tr>
            ${catRows}
            <tr class="pnl-subtotal"><td>Total Expenses</td><td class="pnl-num" style="color:var(--red)">( ${_fmt(data.expenses.total)} )</td></tr>

            <tr class="pnl-total"><td>Operating Profit</td>
              <td class="pnl-num" style="color:${_color(data.profit.operating)}">${_fmt(data.profit.operating)}</td></tr>
            <tr><td>Corporation Tax (30%)</td><td class="pnl-num" style="color:var(--red)">( ${_fmt(data.profit.taxAmount)} )</td></tr>
            <tr class="pnl-grand-total"><td>NET PROFIT <span class="pnl-margin">${data.profit.netMargin}%</span></td>
              <td class="pnl-num" style="color:${_color(data.profit.net)};font-size:16px">${_fmt(data.profit.net)}</td></tr>
          </tbody>
        </table>
        <div style="font-size:10px;color:var(--txt3);margin-top:10px">
          Based on ${data.transactions} transactions. Tax figure is an estimate.
        </div>
      `;
    },
  };

  /* ═══════════════════════════════════════════════════════════
     PAYROLL
  ════════════════════════════════════════════════════════════ */
  const payroll = {
    async computeSlip(employee, monthStart, monthEnd) {
      /* attendance hours */
      const logs = (await PosDB.attendance.getForEmployee(employee.id, monthStart, monthEnd));
      const hoursWorked = logs.reduce((s, l) => s + (l.duration || 0), 0) / 3600000;
      const daysWorked  = Math.round(hoursWorked / (employee.dailyHours || 8));

      const grossSalary = employee.salaryType === 'hourly'
        ? hoursWorked * (employee.hourlyRate || 0)
        : employee.baseSalary || 0;

      const allowances = employee.allowances || 0;
      const grossTotal  = grossSalary + allowances;
      const nssf        = _calcNSSF(grossTotal);
      const nhif        = _calcNHIF(grossTotal);
      const paye        = _calcPAYE(grossTotal - nssf);
      const netPay      = grossTotal - nssf - nhif - paye;

      return {
        employeeId:   employee.id,
        employeeName: employee.name || employee.id,
        period:       { start: monthStart, end: monthEnd },
        hoursWorked:  parseFloat(hoursWorked.toFixed(1)),
        daysWorked,
        grossSalary,
        allowances,
        grossTotal,
        deductions: { nssf, nhif, paye, total: nssf + nhif + paye },
        netPay,
      };
    },

    async runPayroll(monthStart, monthEnd) {
      const employees = await PosDB.cashiers.getAll();
      const slips = [];
      for (const emp of employees) {
        if (!emp.baseSalary && !emp.hourlyRate) continue;
        const slip = await this.computeSlip(emp, monthStart, monthEnd).catch(() => null);
        if (slip) slips.push(slip);
      }
      return slips;
    },

    async render(containerId, monthStart, monthEnd) {
      const el = document.getElementById(containerId);
      if (!el) return;
      el.innerHTML = '<div class="bos-loading">Computing payroll…</div>';

      const slips = await this.runPayroll(monthStart, monthEnd);
      if (!slips.length) {
        el.innerHTML = '<div class="bos-error">No employees with salary data. Add base salary in employee settings.</div>';
        return;
      }

      const totalGross = slips.reduce((s, x) => s + x.grossTotal, 0);
      const totalNet   = slips.reduce((s, x) => s + x.netPay, 0);

      el.innerHTML = `
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px">
          <div class="bos-kpi-tile"><div class="bos-kpi-label">Total Gross</div><div class="bos-kpi-val">KES ${totalGross.toLocaleString()}</div></div>
          <div class="bos-kpi-tile green"><div class="bos-kpi-label">Net to Pay</div><div class="bos-kpi-val green">KES ${totalNet.toLocaleString()}</div></div>
        </div>
        <table class="pos-table" style="font-size:12px">
          <thead><tr>
            <th>Employee</th><th>Gross</th><th>NSSF</th><th>NHIF</th><th>PAYE</th><th style="color:var(--green)">Net Pay</th><th>Days</th>
          </tr></thead>
          <tbody>
            ${slips.map(s => `
              <tr>
                <td>${s.employeeName}</td>
                <td>KES ${s.grossTotal.toLocaleString()}</td>
                <td style="color:var(--txt2)">-${s.deductions.nssf.toLocaleString()}</td>
                <td style="color:var(--txt2)">-${s.deductions.nhif.toLocaleString()}</td>
                <td style="color:var(--red)">-${s.deductions.paye.toLocaleString()}</td>
                <td style="color:var(--green);font-weight:700">KES ${s.netPay.toLocaleString()}</td>
                <td>${s.daysWorked}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `;
    },
  };

  /* ═══════════════════════════════════════════════════════════
     ATTENDANCE (Clock-in / Clock-out)
  ════════════════════════════════════════════════════════════ */
  const attendance = {
    async clockIn(employeeId, employeeName) {
      const existing = await PosDB.attendance.getActiveEntry(employeeId);
      if (existing) throw new Error('Already clocked in');
      const id = await PosDB.attendance.add({
        employeeId, employeeName,
        clockIn:   Date.now(),
        clockOut:  null,
        duration:  null,
        date:      new Date().toISOString().slice(0, 10),
      });
      if (window.PosAudit) PosAudit.log('clock_in', { employeeId, employeeName });
      return id;
    },

    async clockOut(employeeId) {
      const entry = await PosDB.attendance.getActiveEntry(employeeId);
      if (!entry) throw new Error('Not clocked in');
      const clockOut = Date.now();
      const duration = clockOut - entry.clockIn;
      await PosDB.attendance.update(entry.id, { clockOut, duration });
      if (window.PosAudit) PosAudit.log('clock_out', { employeeId, duration });
      return { hours: (duration / 3600000).toFixed(2) };
    },

    async getStatus(employeeId) {
      const active = await PosDB.attendance.getActiveEntry(employeeId);
      return active
        ? { in: true,  since: active.clockIn, entry: active }
        : { in: false, since: null, entry: null };
    },

    async renderPanel(containerId) {
      const el = document.getElementById(containerId);
      if (!el) return;
      const employees = await PosDB.cashiers.getAll();
      const today     = new Date().toISOString().slice(0, 10);

      const rows = await Promise.all(employees.map(async emp => {
        const status = await this.getStatus(emp.id);
        const logs   = await PosDB.attendance.getForEmployee(emp.id,
          new Date(today).getTime(),
          new Date(today).getTime() + 86399999,
        );
        const totalHrs = logs
          .filter(l => l.duration)
          .reduce((s, l) => s + l.duration, 0) / 3600000;

        return `
          <tr>
            <td>${emp.name || emp.id}</td>
            <td>
              <span class="att-badge ${status.in ? 'att-in' : 'att-out'}">
                ${status.in ? '🟢 In' : '🔴 Out'}
              </span>
              ${status.in ? `<span style="font-size:10px;color:var(--txt2)"> since ${new Date(status.since).toLocaleTimeString()}</span>` : ''}
            </td>
            <td>${totalHrs.toFixed(1)}h today</td>
            <td>
              ${status.in
                ? `<button class="bos-action-btn" onclick="PosFinance.attendance.clockOut('${emp.id}').then(()=>PosFinance.attendance.renderPanel('${containerId}'))">Clock Out</button>`
                : `<button class="bos-action-btn" onclick="PosFinance.attendance.clockIn('${emp.id}','${emp.name}').then(()=>PosFinance.attendance.renderPanel('${containerId}'))">Clock In</button>`
              }
            </td>
          </tr>
        `;
      }));

      el.innerHTML = `
        <table class="pos-table" style="font-size:12px">
          <thead><tr><th>Employee</th><th>Status</th><th>Hours</th><th></th></tr></thead>
          <tbody>${rows.join('')}</tbody>
        </table>
      `;
    },
  };

  /* ═══════════════════════════════════════════════════════════
     CASH FLOW STATEMENT
  ════════════════════════════════════════════════════════════ */
  const cashflow = {
    async generate(startTs, endTs) {
      const [report, expList] = await Promise.all([
        PosDB.reports.forDateRange(startTs, endTs),
        expenses.getForPeriod(startTs, endTs),
      ]);

      const cashInflows  = report.cash || 0;
      const mpesaInflows = report.mpesa || 0;
      const cashOutflows = expList.filter(e => e.paymentMethod !== 'mpesa').reduce((s,e) => s+e.amount, 0);

      const opening = 0; /* would come from previous period ending balance */
      const net     = cashInflows + mpesaInflows - cashOutflows;

      return {
        opening,
        inflows:  { cash: cashInflows, mpesa: mpesaInflows, total: cashInflows + mpesaInflows },
        outflows: { expenses: cashOutflows, total: cashOutflows },
        net,
        closing:  opening + net,
        period:   { start: startTs, end: endTs },
      };
    },
  };

  /* ═══════════════════════════════════════════════════════════
     RENDER FINANCE HUB TAB
  ════════════════════════════════════════════════════════════ */
  async function renderHub(containerId) {
    const el = document.getElementById(containerId);
    if (!el) return;

    const now       = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const monthEnd   = Date.now();

    el.innerHTML = `
      <div class="finance-tabs" style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap">
        <button class="finance-tab active" onclick="PosFinance._switchFTab(this,'finance-pnl')">P&L Statement</button>
        <button class="finance-tab" onclick="PosFinance._switchFTab(this,'finance-expenses')">Expenses</button>
        <button class="finance-tab" onclick="PosFinance._switchFTab(this,'finance-payroll')">Payroll</button>
        <button class="finance-tab" onclick="PosFinance._switchFTab(this,'finance-attendance')">Attendance</button>
        <button class="finance-tab" onclick="PosFinance._switchFTab(this,'finance-forecast')">Forecast</button>
      </div>

      <div id="finance-pnl">
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:10px;flex-wrap:wrap">
          <input type="date" id="finance-start" value="${new Date(monthStart).toISOString().slice(0,10)}" class="form-inp" style="font-size:14px">
          <span style="color:var(--txt2)">to</span>
          <input type="date" id="finance-end"   value="${new Date(monthEnd).toISOString().slice(0,10)}" class="form-inp" style="font-size:14px">
          <button class="bos-action-btn" onclick="PosFinance._refreshPnl()">Generate</button>
        </div>
        <div id="pnl-body"></div>
      </div>

      <div id="finance-expenses" style="display:none">
        <button class="bos-action-btn" style="margin-bottom:10px" onclick="PosFinance.expenses.renderForm('exp-form-body')">+ Add Expense</button>
        <div id="exp-form-body"></div>
        <div id="exp-list-body"></div>
      </div>

      <div id="finance-payroll" style="display:none">
        <div id="payroll-body"></div>
      </div>

      <div id="finance-attendance" style="display:none">
        <div id="attendance-body"></div>
      </div>

      <div id="finance-forecast" style="display:none">
        <div id="forecast-ai-body"></div>
      </div>
    `;

    /* Load defaults */
    await pnl.render('pnl-body', monthStart, monthEnd);
    await attendance.renderPanel('attendance-body');
    await payroll.render('payroll-body', monthStart, monthEnd);
    await PosAIEngine.forecasting.renderPanel('forecast-ai-body');
    await _renderExpenseList('exp-list-body', monthStart, monthEnd);
  }

  async function _refreshPnl() {
    const s = document.getElementById('finance-start')?.value;
    const e = document.getElementById('finance-end')?.value;
    if (!s || !e) return;
    const start = new Date(s).getTime();
    const end   = new Date(e).setHours(23, 59, 59, 999);
    await pnl.render('pnl-body', start, end);
    await _renderExpenseList('exp-list-body', start, end);
  }

  async function _renderExpenseList(containerId, startTs, endTs) {
    const el = document.getElementById(containerId);
    if (!el) return;
    const list = await expenses.getForPeriod(startTs, endTs);
    if (!list.length) { el.innerHTML = '<div class="bos-all-good" style="margin-top:10px">No expenses recorded for this period.</div>'; return; }
    const total = list.reduce((s, e) => s + e.amount, 0);
    el.innerHTML = `
      <div style="margin-top:14px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <span style="font-size:12px;font-weight:700">Recorded Expenses</span>
          <span style="color:var(--red);font-weight:700">Total: KES ${total.toLocaleString()}</span>
        </div>
        <table class="pos-table" style="font-size:12px">
          <thead><tr><th>Date</th><th>Category</th><th>Description</th><th>Amount</th><th></th></tr></thead>
          <tbody>
            ${list.sort((a,b) => b.date - a.date).map(e => `
              <tr>
                <td>${new Date(e.date).toLocaleDateString()}</td>
                <td>${e.category}</td>
                <td style="color:var(--txt2)">${e.description || '—'}</td>
                <td style="color:var(--red);font-weight:700">KES ${e.amount.toLocaleString()}</td>
                <td>
                  <button class="bos-action-btn" onclick="PosFinance.expenses.delete('${e.id}').then(()=>PosFinance._refreshPnl())"
                    style="color:var(--red)">Del</button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  function _switchFTab(btn, targetId) {
    ['finance-pnl','finance-expenses','finance-payroll','finance-attendance','finance-forecast']
      .forEach(id => { const el = document.getElementById(id); if (el) el.style.display = 'none'; });
    const target = document.getElementById(targetId);
    if (target) target.style.display = '';
    document.querySelectorAll('.finance-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  }

  return { expenses, pnl, payroll, attendance, cashflow, renderHub, _switchFTab, _refreshPnl, EXPENSE_CATEGORIES };
})();

window.PosFinance = PosFinance;
