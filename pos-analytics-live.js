/* ============================================================
   SOKONI SmartPOS 2.1 — Live Analytics Widget
   Embeds into pos.html sidebar. Polls every 30s for today's metrics.
   Also powers the standalone pos-analytics-live.html dashboard.
============================================================ */
window.SokonPOSAnalytics = (function () {
  'use strict';

  var _cfFn       = null;
  var _pollTimer  = null;
  var _container  = null;
  var _currentView = 'today'; /* 'today' | '7days' | '30days' */

  /* ── Get Firebase callable ── */
  function _cf(name) {
    if (!_cfFn) {
      _cfFn = window.firebase
        ? window.firebase.functions()
        : (window.SPos && window.SPos._firebase ? window.SPos._firebase.functions() : null);
    }
    if (!_cfFn) throw new Error('Firebase not ready');
    /* SmartPOS ops are consolidated into smartPosDispatch — route transparently. */
    if (name === 'getPOSAnalytics' || name === 'getLivePOSMetrics') {
      var _d = _cfFn.httpsCallable('smartPosDispatch');
      return function (data) { return _d(Object.assign({ op: name }, data || {})); };
    }
    return _cfFn.httpsCallable(name);
  }

  /* ── Number formatting ── */
  function _fmt(n) {
    if (typeof n !== 'number') return '—';
    if (n >= 1000000) return 'KES ' + (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000)    return 'KES ' + (n / 1000).toFixed(1) + 'K';
    return 'KES ' + n.toLocaleString('en-KE', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  }
  function _fmtN(n) { return typeof n === 'number' ? n.toLocaleString() : '—'; }

  /* ── Bar chart (canvas-free, CSS bars) ── */
  function _barChart(points, maxVal, color) {
    if (!points || !points.length || maxVal === 0) return '<div style="color:#6b7899;font-size:12px;padding:8px 0;">No data</div>';
    return '<div style="display:flex;align-items:flex-end;gap:2px;height:60px;">' +
      points.map(function (p) {
        var h = Math.max(4, Math.round((p.revenue / maxVal) * 60));
        return '<div style="flex:1;background:' + color + ';height:' + h + 'px;border-radius:2px 2px 0 0;" title="' + p.label + ': ' + _fmt(p.revenue) + '"></div>';
      }).join('') +
    '</div>';
  }

  /* ── Hourly heat bar ── */
  function _hourHeat(hourData) {
    var max = Math.max.apply(null, hourData.map(function (h) { return h.revenue || 0; }));
    if (max === 0) return '<div style="color:#6b7899;font-size:12px;">No sales yet</div>';
    var colors = ['#1e3a5f','#1d4ed8','#3b82f6','#60a5fa','#93c5fd'];
    return '<div style="display:flex;gap:2px;flex-wrap:wrap;">' +
      hourData.map(function (h, i) {
        var level = max > 0 ? Math.round((h.revenue / max) * 4) : 0;
        var bg    = colors[level] || colors[0];
        var hr    = i < 10 ? '0' + i : '' + i;
        return '<div style="width:18px;height:18px;background:' + bg + ';border-radius:3px;" title="' + hr + ':00 — ' + _fmt(h.revenue) + '"></div>';
      }).join('') +
    '</div><div style="display:flex;justify-content:space-between;font-size:10px;color:#6b7899;margin-top:4px;"><span>12am</span><span>6am</span><span>12pm</span><span>6pm</span><span>11pm</span></div>';
  }

  /* ── Payment method pill ── */
  function _payPill(method, amount, total) {
    var pct = total > 0 ? Math.round((amount / total) * 100) : 0;
    var icons = { mpesa: '📱', card: '💳', cash: '💵', wallet: '👛', qr: '⬛' };
    var icon  = icons[method] || '💲';
    return '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">' +
      '<span>' + icon + '</span>' +
      '<div style="flex:1">' +
        '<div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px;"><span style="text-transform:capitalize">' + method + '</span><span>' + _fmt(amount) + '</span></div>' +
        '<div style="background:#161923;border-radius:3px;height:4px;overflow:hidden;">' +
          '<div style="background:#3b82f6;height:4px;width:' + pct + '%;border-radius:3px;"></div>' +
        '</div>' +
      '</div>' +
      '<span style="font-size:11px;color:#6b7899;">' + pct + '%</span>' +
    '</div>';
  }

  /* ── Render analytics data into a container element ── */
  function _render(container, data, live) {
    var s         = data.summary || {};
    var topProds  = data.topProducts || [];
    var staff     = data.staffPerformance || [];
    var payBreak  = data.paymentBreakdown || [];
    var hourly    = data.peakHours ? data.peakHours.data : [];
    var dailyData = data.daily || [];

    var dailyMax  = dailyData.reduce(function (m, d) { return Math.max(m, d.revenue); }, 0);
    var dailyPts  = dailyData.slice(-14).map(function (d) { return { revenue: d.revenue, label: d.date }; });
    var totalPay  = payBreak.reduce(function (s, p) { return s + p.amount; }, 0);

    container.innerHTML = [
      /* Live stats */
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:16px;">',
        _metricCard('Revenue', _fmt(s.totalRevenue || 0), '#22c55e'),
        _metricCard('Transactions', _fmtN(s.transactionCount || 0), '#3b82f6'),
        _metricCard('Avg Sale', _fmt(s.avgSale || 0), '#a855f7'),
        _metricCard('Profit', _fmt(s.totalProfit || 0) + ' (' + (s.profitMargin || 0).toFixed(0) + '%)', '#eab308'),
      '</div>',

      /* Revenue trend */
      dailyData.length > 1 ? [
        '<div style="margin-bottom:16px;">',
          '<div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#6b7899;margin-bottom:8px;">Revenue Trend</div>',
          _barChart(dailyPts, dailyMax, '#3b82f6'),
        '</div>',
      ].join('') : '',

      /* Peak hours */
      hourly.length ? [
        '<div style="margin-bottom:16px;">',
          '<div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#6b7899;margin-bottom:8px;">Peak Hours</div>',
          _hourHeat(hourly),
          data.peakHours ? '<div style="font-size:11px;color:#6b7899;margin-top:6px;">Busiest: ' + (data.peakHours.peakLabel || '—') + '</div>' : '',
        '</div>',
      ].join('') : '',

      /* Payment breakdown */
      payBreak.length ? [
        '<div style="margin-bottom:16px;">',
          '<div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#6b7899;margin-bottom:8px;">Payment Methods</div>',
          payBreak.map(function (p) { return _payPill(p.method, p.amount, totalPay); }).join(''),
        '</div>',
      ].join('') : '',

      /* Top products */
      topProds.length ? [
        '<div style="margin-bottom:16px;">',
          '<div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#6b7899;margin-bottom:8px;">Top Products</div>',
          topProds.slice(0, 5).map(function (p, i) {
            return '<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid #1e2533;">' +
              '<span style="font-size:11px;color:#6b7899;width:14px;">' + (i + 1) + '</span>' +
              '<span style="flex:1;font-size:13px;">' + (p.name || '—') + '</span>' +
              '<span style="font-size:12px;color:#6b7899;">x' + (p.qty || 0) + '</span>' +
              '<span style="font-size:12px;color:#22c55e;">' + _fmt(p.revenue) + '</span>' +
            '</div>';
          }).join(''),
        '</div>',
      ].join('') : '',

      /* Staff performance */
      staff.length > 1 ? [
        '<div>',
          '<div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#6b7899;margin-bottom:8px;">Staff Performance</div>',
          staff.map(function (c) {
            return '<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid #1e2533;">' +
              '<span style="font-size:16px;">👤</span>' +
              '<div style="flex:1"><div style="font-size:12px;">' + c.name + '</div><div style="font-size:11px;color:#6b7899;">' + c.transactions + ' sales</div></div>' +
              '<span style="font-size:12px;color:#3b82f6;">' + _fmt(c.revenue) + '</span>' +
            '</div>';
          }).join(''),
        '</div>',
      ].join('') : '',
    ].join('');
  }

  function _metricCard(label, value, color) {
    return '<div style="background:#161923;border:1px solid #1e2533;border-radius:10px;padding:12px;">' +
      '<div style="font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:#6b7899;margin-bottom:4px;">' + label + '</div>' +
      '<div style="font-size:16px;font-weight:700;color:' + color + ';">' + value + '</div>' +
    '</div>';
  }

  /* ── Fetch + render ── */
  async function _refresh(container, sellerId) {
    try {
      var days = _currentView === 'today' ? 1 : _currentView === '7days' ? 7 : 30;
      var endDate   = new Date().toISOString();
      var startDate = new Date(Date.now() - days * 86400000).toISOString();

      var res = await _cf('getPOSAnalytics')({ sellerId: sellerId || null, startDate, endDate });
      if (res && res.data) _render(container, res.data);

      /* Live metrics overlay (today only) */
      if (_currentView === 'today') {
        var liveRes = await _cf('getLivePOSMetrics')({ sellerId: sellerId || null });
        if (liveRes && liveRes.data) {
          var live = liveRes.data.today;
          /* Update first row metrics live */
          var cards = container.querySelectorAll('[data-metric]');
          if (cards.length) {
            cards[0].textContent = _fmt(live.revenue || 0);
            cards[1].textContent = _fmtN(live.transactions || 0);
            cards[2].textContent = _fmt(live.avgSale || 0);
          }
        }
      }
    } catch (e) {
      container.innerHTML = '<div style="color:#ef4444;font-size:12px;padding:12px;">Analytics unavailable: ' + e.message + '</div>';
    }
  }

  /* ── Public API ── */

  /**
   * mount(containerId, opts)
   * Mounts the analytics widget into the given container element.
   * opts: { sellerId, autoRefresh (default true), refreshIntervalMs (default 30000) }
   */
  function mount(containerId, opts) {
    opts = opts || {};
    var el = document.getElementById(containerId);
    if (!el) { console.warn('[POSAnalytics] Container not found:', containerId); return; }
    _container = el;

    /* View switcher */
    var switcher = document.createElement('div');
    switcher.style.cssText = 'display:flex;gap:4px;margin-bottom:12px;';
    ['today', '7days', '30days'].forEach(function (view) {
      var btn = document.createElement('button');
      btn.textContent = view === 'today' ? 'Today' : view === '7days' ? '7 Days' : '30 Days';
      btn.style.cssText = 'flex:1;background:#161923;border:1px solid #1e2533;color:#e4e8f0;padding:5px;border-radius:7px;cursor:pointer;font-size:11px;font-weight:600;';
      btn.onclick = function () {
        _currentView = view;
        switcher.querySelectorAll('button').forEach(function (b) { b.style.background = '#161923'; b.style.borderColor = '#1e2533'; b.style.color = '#e4e8f0'; });
        btn.style.background = '#1d4ed8'; btn.style.borderColor = '#3b82f6'; btn.style.color = '#fff';
        _refresh(el, opts.sellerId);
      };
      if (view === 'today') { btn.style.background = '#1d4ed8'; btn.style.borderColor = '#3b82f6'; btn.style.color = '#fff'; }
      switcher.appendChild(btn);
    });
    el.prepend(switcher);

    var content = document.createElement('div');
    el.appendChild(content);
    content.innerHTML = '<div style="color:#6b7899;font-size:12px;padding:16px 0;text-align:center;">Loading analytics...</div>';

    _refresh(content, opts.sellerId);

    if (opts.autoRefresh !== false) {
      _pollTimer = setInterval(function () { _refresh(content, opts.sellerId); }, opts.refreshIntervalMs || 30000);
    }
  }

  /** Stop polling */
  function destroy() {
    clearInterval(_pollTimer);
    _cfFn = null;
  }

  /** Manual refresh */
  function refresh(sellerId) {
    if (_container) _refresh(_container, sellerId);
  }

  return { mount, destroy, refresh };
}());
