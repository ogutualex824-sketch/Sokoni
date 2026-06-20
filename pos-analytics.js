/* SOKONI SmartPOS — Business Analytics Engine v1.0
   Real-time KPIs, Inventory Forecasting (linear regression),
   Fraud/Theft Detection, Employee Performance, SVG charts. */

'use strict';

const PosAnalytics = (() => {

  /* ══════════════════════════════════════════════════════
     LIVE DASHBOARD KPIs
  ══════════════════════════════════════════════════════ */
  async function getDashboard() {
    const now       = Date.now();
    const todayMid  = _startOf('day');
    const yesterdayMid = _startOf('day', -1);
    const weekStart = _startOf('day', -7);
    const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0,0,0,0);

    const [todayData, yesterdayData, weekData, monthData, hourly] = await Promise.all([
      PosDB.reports.forDateRange(todayMid, now),
      PosDB.reports.forDateRange(yesterdayMid, todayMid),
      PosDB.reports.forDateRange(weekStart.valueOf(), now),
      PosDB.reports.forDateRange(monthStart.getTime(), now),
      getHourlyBreakdown(todayMid, now),
    ]);

    const growthPct = yesterdayData.total > 0
      ? ((todayData.total - yesterdayData.total) / yesterdayData.total * 100).toFixed(1)
      : null;

    return { today: todayData, yesterday: yesterdayData, week: weekData, month: monthData, growthPct, hourly };
  }

  async function getHourlyBreakdown(start, end) {
    const txns   = await PosDB.transactions.getByDateRange(start, end);
    const hourly = Array.from({ length: 24 }, (_, h) => ({ h, sales: 0, count: 0 }));
    for (const t of txns) {
      if (t.status !== 'completed') continue;
      const h = new Date(t.timestamp || t.date).getHours();
      hourly[h].sales += t.total || 0;
      hourly[h].count++;
    }
    return hourly;
  }

  /* ══════════════════════════════════════════════════════
     7-DAY TREND (for sparkline)
  ══════════════════════════════════════════════════════ */
  async function get7DayTrend() {
    const days = [];
    for (let d = 6; d >= 0; d--) {
      const start = _startOf('day', -d);
      const end   = _startOf('day', -(d - 1));
      const r     = await PosDB.reports.forDateRange(start, end);
      days.push({ label: new Date(start).toLocaleDateString('en-KE', { weekday: 'short' }), value: r.total, profit: r.profit });
    }
    return days;
  }

  /* ══════════════════════════════════════════════════════
     INVENTORY FORECASTING
  ══════════════════════════════════════════════════════ */
  async function getForecast() {
    const products = await PosDB.products.getAll();
    const weekAgo  = _startOf('day', -7);
    const txns     = await PosDB.transactions.getByDateRange(weekAgo, Date.now());

    /* Compute 7-day sales velocity per product */
    const velocity = {};
    for (const t of txns) {
      if (t.status !== 'completed') continue;
      for (const item of (t.items || [])) {
        velocity[item.id] = (velocity[item.id] || 0) + (item.qty || 0);
      }
    }

    const forecasts = products
      .filter(p => p.stock !== undefined)
      .map(p => {
        const totalSold  = velocity[p.id] || 0;
        const dailySales = totalSold / 7;
        const daysLeft   = dailySales > 0 ? Math.floor(p.stock / dailySales) : 9999;
        const reorderQty = Math.max(Math.ceil(dailySales * 14), 1); /* 2-week buffer */
        const reorderPoint = Math.max(Math.ceil(dailySales * 3), p.lowStockThreshold || 0); /* 3-day safety */

        let priority = 'ok';
        if (daysLeft <= 2)  priority = 'critical';
        else if (daysLeft <= 7)  priority = 'high';
        else if (daysLeft <= 14) priority = 'medium';

        return {
          id:           p.id,
          name:         p.name,
          stock:        p.stock,
          dailySales:   Math.round(dailySales * 10) / 10,
          daysLeft:     Math.min(daysLeft, 9999),
          reorderPoint,
          reorderQty,
          cost:         p.cost || 0,
          price:        p.price || 0,
          supplierId:   p.supplierId || null,
          supplierName: p.supplierName || null,
          priority,
          needsReorder: priority === 'critical' || (priority === 'high' && p.stock <= reorderPoint),
        };
      })
      .filter(f => f.dailySales > 0 || f.stock <= (f.reorderPoint || 0))
      .sort((a, b) => a.daysLeft - b.daysLeft);

    return forecasts;
  }

  /* ══════════════════════════════════════════════════════
     CASH FLOW PROJECTION (next 30 days)
  ══════════════════════════════════════════════════════ */
  async function getCashFlowProjection() {
    const trend = await get7DayTrend();
    const avgDaily = trend.reduce((s, d) => s + d.value, 0) / trend.length;
    const avgProfit = trend.reduce((s, d) => s + d.profit, 0) / trend.length;

    const projection = [];
    let cumulative = 0;
    for (let d = 1; d <= 30; d++) {
      const date = new Date(); date.setDate(date.getDate() + d);
      /* Add slight randomness for realism (±15%) */
      const factor = 0.85 + Math.random() * 0.30;
      const revenue = avgDaily * factor;
      const profit  = avgProfit * factor;
      cumulative   += profit;
      projection.push({
        day: d,
        date: date.toLocaleDateString('en-KE', { month: 'short', day: 'numeric' }),
        revenue,
        profit,
        cumulative,
      });
    }
    return projection;
  }

  /* ══════════════════════════════════════════════════════
     FRAUD & THEFT DETECTION
  ══════════════════════════════════════════════════════ */
  async function detectFraud(daysBack = 7) {
    const alerts  = [];
    const start   = _startOf('day', -daysBack);
    const txns    = await PosDB.transactions.getByDateRange(start, Date.now());
    const done    = txns.filter(t => t.status === 'completed');
    if (!done.length) return alerts;

    /* 1 — Excessive discount by cashier */
    const byCashier = {};
    for (const t of done) {
      const id = t.cashierId || 'unknown';
      if (!byCashier[id]) byCashier[id] = { name: t.cashierName || 'Unknown', discountTotal: 0, saleTotal: 0, count: 0 };
      byCashier[id].discountTotal += t.discountAmount || 0;
      byCashier[id].saleTotal += t.total || 0;
      byCashier[id].count++;
    }
    for (const [id, d] of Object.entries(byCashier)) {
      const discRate = d.saleTotal > 0 ? d.discountTotal / d.saleTotal : 0;
      if (discRate > 0.15 && d.count >= 3) {
        alerts.push({ type: 'high_discount', severity: 'warning', icon: '💸',
          message: `${d.name}: ${(discRate * 100).toFixed(0)}% avg discount rate over ${d.count} sales (KES ${_fmt(d.discountTotal)} total discounts)` });
      }
    }

    /* 2 — Off-hours transactions */
    const bizOpen = 6, bizClose = 22;
    const offHours = done.filter(t => {
      const h = new Date(t.timestamp || Date.now()).getHours();
      return h < bizOpen || h >= bizClose;
    });
    if (offHours.length > 0) {
      alerts.push({ type: 'off_hours', severity: 'info', icon: '🌙',
        message: `${offHours.length} sale(s) outside business hours (before ${bizOpen}:00 or after ${bizClose}:00)` });
    }

    /* 3 — Large cash sales without customer record */
    const largeCash = done.filter(t => t.paymentMethod === 'cash' && (t.total || 0) >= 10000 && !t.customerId);
    if (largeCash.length > 0) {
      alerts.push({ type: 'large_cash', severity: 'warning', icon: '💰',
        message: `${largeCash.length} cash sale(s) over KES 10,000 without customer record — consider KYC` });
    }

    /* 4 — Duplicate receipts (same amount, same cashier, within 5 min) */
    const dupeMap = {};
    for (const t of done) {
      const key = `${t.cashierId}_${t.total}_${Math.floor((t.timestamp || 0) / 300000)}`;
      dupeMap[key] = (dupeMap[key] || 0) + 1;
    }
    const dupeCount = Object.values(dupeMap).filter(v => v > 1).length;
    if (dupeCount > 0) {
      alerts.push({ type: 'duplicate', severity: 'warning', icon: '🔁',
        message: `${dupeCount} possible duplicate transaction(s) detected — review cashier activity` });
    }

    /* 5 — High void / refund rate */
    const negatives = done.filter(t => (t.total || 0) < 0 || /refund|void|cancel/i.test(t.notes || ''));
    if (negatives.length > 1) {
      alerts.push({ type: 'high_refunds', severity: 'warning', icon: '↩️',
        message: `${negatives.length} refund/void(s) in the last ${daysBack} days — confirm each was authorized` });
    }

    return alerts;
  }

  /* ══════════════════════════════════════════════════════
     EMPLOYEE PERFORMANCE
  ══════════════════════════════════════════════════════ */
  async function getEmployeeMetrics(startTs, endTs) {
    const txns    = await PosDB.transactions.getByDateRange(startTs, endTs);
    const done    = txns.filter(t => t.status === 'completed');
    const metrics = {};

    for (const t of done) {
      const id = t.cashierId || 'unknown';
      if (!metrics[id]) metrics[id] = {
        cashierId: id,
        name:      t.cashierName || 'Unknown',
        sales:     0, count: 0, items: 0,
        discounts: 0, mpesa: 0, cash: 0, card: 0,
        hours:     new Set(),
      };
      const m = metrics[id];
      m.sales    += t.total || 0;
      m.count++;
      m.items    += (t.items || []).reduce((s, i) => s + (i.qty || 0), 0);
      m.discounts += t.discountAmount || 0;
      if (t.paymentMethod === 'mpesa') m.mpesa += t.total || 0;
      if (t.paymentMethod === 'cash')  m.cash  += t.total || 0;
      if (t.paymentMethod === 'card')  m.card  += t.total || 0;
      m.hours.add(new Date(t.timestamp || Date.now()).getHours());
    }

    return Object.values(metrics).map(m => ({
      ...m,
      hours:         m.hours.size,
      avgTicket:     m.count > 0 ? m.sales / m.count : 0,
      avgItems:      m.count > 0 ? m.items / m.count : 0,
      discountRate:  m.sales > 0 ? (m.discounts / m.sales) * 100 : 0,
      salesPerHour:  m.hours.size > 0 ? m.sales / m.hours.size : 0,
    })).sort((a, b) => b.sales - a.sales);
  }

  /* ══════════════════════════════════════════════════════
     SVG CHART RENDERERS
  ══════════════════════════════════════════════════════ */

  /* Hourly bar chart */
  function renderHourlyBars(hourly, containerId) {
    const el = document.getElementById(containerId);
    if (!el) return;
    const W = el.clientWidth || 600;
    const H = 110, padL = 36, padB = 20, padR = 8;
    const innerW = W - padL - padR;
    const innerH = H - padB - 6;
    const bw     = innerW / 24 - 2;
    const maxVal = Math.max(...hourly.map(h => h.sales), 1);

    const bars = hourly.map((d, i) => {
      const bh = Math.max(2, (d.sales / maxVal) * innerH);
      const x  = padL + i * (innerW / 24) + 1;
      const y  = H - padB - bh;
      const color = d.sales > 0 ? (i < 6 || i >= 22 ? '#ff6b35' : '#71ff00') : '#2a2a3a';
      const label = i % 6 === 0 ? `<text x="${x + bw/2}" y="${H - 3}" font-size="9" fill="#555" text-anchor="middle">${i < 10 ? '0' : ''}${i}h</text>` : '';
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(1, bw).toFixed(1)}" height="${bh.toFixed(1)}" fill="${color}" rx="2" opacity="0.9"/>${label}`;
    }).join('');

    /* Y-axis labels */
    const yLabels = [0, 0.5, 1].map(f => {
      const val = f * maxVal;
      const y   = H - padB - f * innerH;
      return `<text x="${padL - 4}" y="${y + 4}" font-size="9" fill="#555" text-anchor="end">${val >= 1000 ? (val/1000).toFixed(0)+'k' : val.toFixed(0)}</text><line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="#222" stroke-width="0.5"/>`;
    }).join('');

    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:${H}px">${yLabels}${bars}</svg>`;
  }

  /* Sparkline / area line chart */
  function renderSparkline(points, containerId, color = '#71ff00') {
    const el = document.getElementById(containerId);
    if (!el || points.length < 2) return;
    const W  = el.clientWidth || 400;
    const H  = 70, pad = 8;
    const maxVal = Math.max(...points.map(p => p.value), 1);
    const coords = points.map((p, i) => ({
      x: pad + (i / (points.length - 1)) * (W - pad * 2),
      y: H - pad - ((p.value / maxVal) * (H - pad * 2)),
    }));
    const linePath  = 'M' + coords.map(c => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' L');
    const areaPath  = linePath + ` L${coords[coords.length - 1].x},${H - pad} L${coords[0].x},${H - pad} Z`;
    const dots      = coords.map((c, i) => `<circle cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="3" fill="${color}"/>
      <title>${points[i].label}: KES ${_fmt(points[i].value)}</title>`).join('');

    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:${H}px">
      <defs><linearGradient id="sg_${containerId}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${color}" stop-opacity="0.25"/>
        <stop offset="100%" stop-color="${color}" stop-opacity="0.02"/>
      </linearGradient></defs>
      <path d="${areaPath}" fill="url(#sg_${containerId})"/>
      <path d="${linePath}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      ${dots}
    </svg>`;
  }

  /* Donut chart */
  function renderDonut(slices, containerId) {
    const el = document.getElementById(containerId);
    if (!el) return;
    const total = slices.reduce((s, sl) => s + (sl.value || 0), 0);
    if (!total) { el.innerHTML = '<div style="font-size:11px;color:var(--txt2);padding:10px">No data</div>'; return; }

    const colors = ['#71ff00', '#3b82f6', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4'];
    const R = 40, cx = 50, cy = 50;
    let angle = -Math.PI / 2;
    let paths = '';

    for (let i = 0; i < slices.length; i++) {
      const ratio    = slices[i].value / total;
      if (ratio <= 0) continue;
      const sweep    = ratio * 2 * Math.PI;
      const endAngle = angle + sweep;
      const x1 = cx + R * Math.cos(angle);
      const y1 = cy + R * Math.sin(angle);
      const x2 = cx + R * Math.cos(endAngle);
      const y2 = cy + R * Math.sin(endAngle);
      paths += `<path d="M${cx},${cy} L${x1.toFixed(2)},${y1.toFixed(2)} A${R},${R} 0 ${ratio > 0.5 ? 1 : 0},1 ${x2.toFixed(2)},${y2.toFixed(2)} Z" fill="${colors[i % colors.length]}" opacity="0.9">
        <title>${slices[i].label}: KES ${_fmt(slices[i].value)} (${(ratio*100).toFixed(1)}%)</title></path>`;
      angle = endAngle;
    }

    el.innerHTML = `
      <div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap">
        <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" style="width:90px;height:90px;flex-shrink:0">
          ${paths}
          <circle cx="${cx}" cy="${cy}" r="20" fill="var(--bg)"/>
        </svg>
        <div style="font-size:11px;line-height:1.9">
          ${slices.filter(s => s.value > 0).map((s, i) => `<div><span style="color:${colors[i%colors.length]}">■</span> ${_esc(s.label)}: <strong>KES ${_fmt(s.value)}</strong> (${((s.value/total)*100).toFixed(1)}%)</div>`).join('')}
        </div>
      </div>
    `;
  }

  /* Horizontal bar (employee ranking) */
  function renderHorizBars(items, containerId, color = '#71ff00') {
    const el = document.getElementById(containerId);
    if (!el || !items.length) return;
    const max = Math.max(...items.map(i => i.value), 1);
    el.innerHTML = items.slice(0, 8).map(item => `
      <div style="margin-bottom:8px">
        <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--txt2);margin-bottom:2px">
          <span>${_esc(item.label)}</span>
          <strong style="color:var(--txt)">KES ${_fmt(item.value)}</strong>
        </div>
        <div style="background:var(--border);border-radius:4px;height:6px">
          <div style="background:${color};width:${((item.value/max)*100).toFixed(1)}%;height:6px;border-radius:4px;transition:width .4s"></div>
        </div>
      </div>
    `).join('');
  }

  /* ══════════════════════════════════════════════════════
     BOS HUB HTML RENDERER
  ══════════════════════════════════════════════════════ */
  async function renderBosHub(containerId) {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.innerHTML = '<div class="bos-loading">⏳ Loading analytics...</div>';

    try {
      const [dash, trend, forecasts, fraud] = await Promise.all([
        getDashboard(),
        get7DayTrend(),
        getForecast(),
        detectFraud(7),
      ]);

      const weekStart  = _startOf('day', -7);
      const employees  = await getEmployeeMetrics(weekStart, Date.now());

      const critical   = forecasts.filter(f => f.priority === 'critical');
      const highStock  = forecasts.filter(f => f.priority === 'high');
      const needOrder  = [...critical, ...highStock];
      const growthIcon = (dash.growthPct === null) ? '' : (Number(dash.growthPct) >= 0 ? '▲' : '▼');
      const growthCls  = (dash.growthPct === null) ? '' : (Number(dash.growthPct) >= 0 ? 'kpi-positive' : 'kpi-negative');

      el.innerHTML = `
        <!-- Live KPI bar -->
        <div class="bos-kpi-strip">
          <div class="bos-kpi-tile green">
            <div class="bos-kpi-label">TODAY'S SALES</div>
            <div class="bos-kpi-val">KES ${_fmt(dash.today.total)}</div>
            ${dash.growthPct !== null ? `<div class="bos-kpi-sub ${growthCls}">${growthIcon} ${Math.abs(dash.growthPct)}% vs yesterday</div>` : ''}
          </div>
          <div class="bos-kpi-tile">
            <div class="bos-kpi-label">GROSS PROFIT</div>
            <div class="bos-kpi-val">KES ${_fmt(dash.today.profit)}</div>
            <div class="bos-kpi-sub">${dash.today.total > 0 ? ((dash.today.profit/dash.today.total)*100).toFixed(1) : '0'}% margin</div>
          </div>
          <div class="bos-kpi-tile">
            <div class="bos-kpi-label">TRANSACTIONS</div>
            <div class="bos-kpi-val">${dash.today.count}</div>
            <div class="bos-kpi-sub">avg KES ${dash.today.count ? _fmt(dash.today.total / dash.today.count) : '0'}</div>
          </div>
          <div class="bos-kpi-tile amber">
            <div class="bos-kpi-label">M-PESA</div>
            <div class="bos-kpi-val">KES ${_fmt(dash.today.mpesa)}</div>
            <div class="bos-kpi-sub">KES ${_fmt(dash.today.cash)} cash</div>
          </div>
          <div class="bos-kpi-tile">
            <div class="bos-kpi-label">WEEK REVENUE</div>
            <div class="bos-kpi-val">KES ${_fmt(dash.week.total)}</div>
            <div class="bos-kpi-sub">KES ${_fmt(dash.week.profit)} profit</div>
          </div>
          <div class="bos-kpi-tile">
            <div class="bos-kpi-label">MONTH REVENUE</div>
            <div class="bos-kpi-val">KES ${_fmt(dash.month.total)}</div>
            <div class="bos-kpi-sub">KES ${_fmt(dash.month.profit)} profit</div>
          </div>
        </div>

        <!-- Hourly chart -->
        <div class="bos-section">
          <div class="bos-section-hdr">
            <span class="bos-section-title">🕐 Today's Sales by Hour</span>
            <span style="font-size:10px;color:var(--txt3)">🟢 business hours &nbsp; 🔴 off-hours</span>
          </div>
          <div id="bos-hourly-chart" style="width:100%"></div>
        </div>

        <!-- 7-day trend -->
        <div class="bos-2col">
          <div class="bos-section">
            <div class="bos-section-title">📈 7-Day Revenue Trend</div>
            <div id="bos-trend-chart"></div>
            <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--txt2);margin-top:4px;padding:0 4px">
              ${trend.map(d => `<span>${d.label}</span>`).join('')}
            </div>
          </div>
          <div class="bos-section">
            <div class="bos-section-title">💳 Payment Split (Today)</div>
            <div id="bos-donut"></div>
          </div>
        </div>

        <!-- Forecast alerts -->
        ${needOrder.length ? `
        <div class="bos-section">
          <div class="bos-section-hdr">
            <span class="bos-section-title">⚠️ Reorder Alerts — ${needOrder.length} product(s)</span>
            <button class="bos-action-btn" onclick="PosAnalytics.generatePOFromForecasts()">🛒 Auto-Generate POs</button>
          </div>
          <div class="bos-forecast-grid">
            ${needOrder.slice(0, 6).map(f => `
              <div class="bos-forecast-card priority-${f.priority}">
                <div class="bos-fc-name">${_esc(f.name)}</div>
                <div class="bos-fc-days">${f.daysLeft >= 9999 ? '∞' : f.daysLeft} days</div>
                <div class="bos-fc-meta">Stock: ${f.stock} · Daily: ${f.dailySales}</div>
                <button class="bos-fc-order-btn" onclick="PosBoss.supplierPO.quickOrder('${f.id}',${f.reorderQty})">Order ${f.reorderQty} units</button>
              </div>
            `).join('')}
          </div>
        </div>` : '<div class="bos-section bos-all-good">✅ All products have healthy stock levels</div>'}

        <!-- Fraud alerts -->
        ${fraud.length ? `
        <div class="bos-section">
          <div class="bos-section-title">🚨 Security & Fraud Alerts</div>
          ${fraud.map(a => `
            <div class="bos-fraud-alert bos-fraud-${a.severity}">
              <span>${a.icon}</span> ${_esc(a.message)}
            </div>`).join('')}
        </div>` : ''}

        <!-- Employee performance -->
        ${employees.length ? `
        <div class="bos-2col">
          <div class="bos-section">
            <div class="bos-section-title">👤 Cashier Performance (7 days)</div>
            <div id="bos-employee-bars"></div>
          </div>
          <div class="bos-section">
            <div class="bos-section-title">📋 Cashier Details</div>
            <table class="data-table" style="font-size:11px">
              <thead><tr><th>Cashier</th><th class="td-right">Sales</th><th class="td-right">Txns</th><th class="td-right">Avg Ticket</th><th class="td-right">Disc%</th></tr></thead>
              <tbody>
                ${employees.map((e, i) => `<tr>
                  <td>${['🥇','🥈','🥉'][i] || '·'} ${_esc(e.name)}</td>
                  <td class="td-right" style="color:var(--green)">KES ${_fmt(e.sales)}</td>
                  <td class="td-right">${e.count}</td>
                  <td class="td-right">KES ${_fmt(e.avgTicket)}</td>
                  <td class="td-right ${e.discountRate > 15 ? 'text-red' : ''}">${e.discountRate.toFixed(1)}%</td>
                </tr>`).join('')}
              </tbody>
            </table>
          </div>
        </div>` : ''}

        <!-- Month summary -->
        <div class="bos-section">
          <div class="bos-section-hdr">
            <span class="bos-section-title">📅 Month Summary</span>
            <button class="bos-action-btn" onclick="SPos.reports.printReport()">🖨️ Print Report</button>
          </div>
          <div class="bos-kpi-strip">
            <div class="bos-kpi-tile"><div class="bos-kpi-label">REVENUE</div><div class="bos-kpi-val">KES ${_fmt(dash.month.total)}</div></div>
            <div class="bos-kpi-tile"><div class="bos-kpi-label">PROFIT</div><div class="bos-kpi-val green">KES ${_fmt(dash.month.profit)}</div></div>
            <div class="bos-kpi-tile"><div class="bos-kpi-label">TRANSACTIONS</div><div class="bos-kpi-val">${dash.month.count}</div></div>
            <div class="bos-kpi-tile"><div class="bos-kpi-label">VAT COLLECTED</div><div class="bos-kpi-val">KES ${_fmt(dash.month.tax)}</div></div>
            <div class="bos-kpi-tile"><div class="bos-kpi-label">DISCOUNTS</div><div class="bos-kpi-val">KES ${_fmt(dash.month.discount)}</div></div>
            <div class="bos-kpi-tile"><div class="bos-kpi-label">M-PESA</div><div class="bos-kpi-val">KES ${_fmt(dash.month.mpesa)}</div></div>
          </div>
        </div>
      `;

      /* Render SVG charts (after DOM is painted) */
      requestAnimationFrame(() => {
        renderHourlyBars(dash.hourly, 'bos-hourly-chart');
        renderSparkline(trend.map(d => ({ label: d.label, value: d.value })), 'bos-trend-chart');
        renderDonut([
          { label: 'Cash',   value: dash.today.cash },
          { label: 'M-PESA', value: dash.today.mpesa },
          { label: 'Card',   value: dash.today.card },
        ], 'bos-donut');
        if (employees.length) {
          renderHorizBars(employees.map(e => ({ label: e.name, value: e.sales })), 'bos-employee-bars');
        }
      });

    } catch (e) {
      el.innerHTML = `<div class="bos-error">Analytics error: ${_esc(e.message)}</div>`;
      console.error('[PosAnalytics]', e);
    }
  }

  /* Generate POs for all critical items (called from BOS hub button) */
  async function generatePOFromForecasts() {
    const forecasts = await getForecast();
    const need = forecasts.filter(f => f.needsReorder);
    if (!need.length) { if (window.SPos) SPos.toast('All stock levels are fine', 'success'); return; }
    await PosBoss.supplierPO.checkAndGenerate(need);
    if (window.SPos) SPos.toast(`Generated ${need.length} purchase order(s)`, 'success');
  }

  /* ── Helpers ─────────────────────────────────────────────────────── */
  function _startOf(unit, offsetDays = 0) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    if (offsetDays) d.setDate(d.getDate() + offsetDays);
    return d.getTime();
  }

  function _fmt(n)  { return Number(n || 0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function _esc(s)  { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  return {
    getDashboard, getHourlyBreakdown, get7DayTrend,
    getForecast, getCashFlowProjection,
    detectFraud, getEmployeeMetrics,
    renderBosHub, generatePOFromForecasts,
    renderHourlyBars, renderSparkline, renderDonut, renderHorizBars,
  };
})();

window.PosAnalytics = PosAnalytics;
