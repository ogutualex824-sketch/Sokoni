/* SOKONI SmartPOS — AI Engine v1.0
   Requirements 22, 23, 29, 34: Product recommendations, OCR,
   AI pricing optimization, sales forecasting.
   Requirements 25 (kiosk): Self-checkout product display support. */

'use strict';

const PosAIEngine = (() => {

  /* ─────────────────────────────────────────────────────────────
     REQUIREMENT 22 — AI Product Recommendations / Cart Upselling
     Market basket analysis using co-occurrence from past txns
  ─────────────────────────────────────────────────────────────── */
  const recommendations = {
    _matrix: null,  /* productId → Map<productId, count> */
    _built:  false,

    async build() {
      const txns = await PosDB.transactions.getAll();
      const mat  = new Map();

      for (const txn of txns) {
        if (!Array.isArray(txn.items) || txn.items.length < 2) continue;
        const ids = txn.items.map(i => i.productId).filter(Boolean);
        /* Record every pair */
        for (let a = 0; a < ids.length; a++) {
          for (let b = 0; b < ids.length; b++) {
            if (a === b) continue;
            if (!mat.has(ids[a])) mat.set(ids[a], new Map());
            const inner = mat.get(ids[a]);
            inner.set(ids[b], (inner.get(ids[b]) || 0) + 1);
          }
        }
      }
      this._matrix = mat;
      this._built  = true;
    },

    /* Top N recommendations for a list of cart product IDs */
    async getForCart(cartProductIds, n = 4) {
      if (!this._built) await this.build();
      if (!this._matrix) return [];

      const scores = new Map();
      for (const id of cartProductIds) {
        const related = this._matrix.get(id);
        if (!related) continue;
        for (const [otherId, count] of related) {
          if (cartProductIds.includes(otherId)) continue;
          scores.set(otherId, (scores.get(otherId) || 0) + count);
        }
      }
      if (!scores.size) return [];

      const sorted = [...scores.entries()].sort((a, b) => b[1] - a[1]);
      const topIds = sorted.slice(0, n).map(([id]) => id);

      const all = await PosDB.products.getAll();
      return all.filter(p => topIds.includes(p.id) && p.stock > 0);
    },

    invalidate() { this._built = false; this._matrix = null; },
  };

  /* ─────────────────────────────────────────────────────────────
     REQUIREMENT 23 — OCR Product Creation from Invoices/Packaging
     Extends pos-ai.js with camera capture → Cloud Function
  ─────────────────────────────────────────────────────────────── */
  const ocr = {
    _stream: null,
    _video:  null,

    async captureFromCamera(containerId) {
      const container = document.getElementById(containerId);
      if (!container) throw new Error('Container not found');

      container.innerHTML = `
        <div class="ocr-capture-ui">
          <video id="ocr-video" autoplay playsinline style="width:100%;border-radius:10px;max-height:260px;object-fit:cover"></video>
          <div style="display:flex;gap:8px;margin-top:10px">
            <button class="inv-btn" onclick="PosAIEngine.ocr.snap()">📸 Capture</button>
            <button class="inv-btn" onclick="PosAIEngine.ocr.stop()">✕ Cancel</button>
          </div>
          <canvas id="ocr-canvas" style="display:none"></canvas>
          <div id="ocr-status" style="font-size:12px;color:var(--txt2);margin-top:8px"></div>
        </div>
      `;

      this._video = document.getElementById('ocr-video');
      this._stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      this._video.srcObject = this._stream;
    },

    async snap() {
      if (!this._video) return;
      const canvas = document.getElementById('ocr-canvas');
      const status = document.getElementById('ocr-status');
      canvas.width  = this._video.videoWidth;
      canvas.height = this._video.videoHeight;
      canvas.getContext('2d').drawImage(this._video, 0, 0);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
      this.stop();
      if (status) status.textContent = 'Analyzing image with AI…';

      try {
        const products = await this._sendToAI(dataUrl);
        if (window.PosAI) await PosAI._showPreview(products);
        else if (status) status.textContent = `Found ${products.length} product(s). Review and import.`;
      } catch (e) {
        if (status) status.textContent = 'AI analysis failed: ' + e.message;
      }
    },

    stop() {
      if (this._stream) { this._stream.getTracks().forEach(t => t.stop()); this._stream = null; }
    },

    async _sendToAI(dataUrl) {
      /* Uses same Cloud Function as pos-ai.js importImage */
      if (!navigator.onLine) throw new Error('No internet connection for AI analysis.');
      const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
      const { getFunctions, httpsCallable } = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-functions.js');
      const fns  = getFunctions(window._firebaseApp);
      const call = httpsCallable(fns, 'posExtractProductsFromImage');
      const res  = await call({ imageBase64: base64 });
      if (!Array.isArray(res.data)) throw new Error('Invalid response from AI');
      return res.data;
    },
  };

  /* ─────────────────────────────────────────────────────────────
     REQUIREMENT 29 — AI Pricing Optimization
     Analyzes margin, velocity, and elasticity to suggest prices
  ─────────────────────────────────────────────────────────────── */
  const pricing = {
    async optimize(productId) {
      const [product, txns] = await Promise.all([
        PosDB.products.get(productId),
        PosDB.transactions.getAll(),
      ]);
      if (!product) return null;

      const cutoff    = Date.now() - 30 * 86400000;
      const relevant  = txns.filter(t => t.completedAt >= cutoff && t.status === 'completed');
      let   unitsSold = 0;
      let   revenue   = 0;
      let   discounts = 0;

      for (const txn of relevant) {
        for (const item of (txn.items || [])) {
          if (item.productId === productId) {
            unitsSold += item.qty || 1;
            revenue   += (item.price || 0) * (item.qty || 1);
            discounts += item.discount || 0;
          }
        }
      }

      const avgPrice    = unitsSold > 0 ? revenue / unitsSold : product.price;
      const dailyVel    = unitsSold / 30;
      const costPrice   = product.costPrice || product.price * 0.65;
      const currentMargin = ((product.price - costPrice) / product.price * 100).toFixed(1);

      /* Simple elasticity heuristic */
      let suggestedPrice = product.price;
      let reason         = '';

      if (dailyVel > 5 && discounts / revenue < 0.05) {
        /* High velocity, low discounting → price can go up */
        suggestedPrice = Math.round(product.price * 1.05 / 10) * 10;
        reason         = 'High demand — price can be increased 5%.';
      } else if (dailyVel < 0.5 && product.stock > 50) {
        /* Slow mover, high stock → reduce price */
        suggestedPrice = Math.round(product.price * 0.92 / 5) * 5;
        reason         = 'Slow mover with excess stock — reduce price to clear.';
      } else if (discounts / revenue > 0.12) {
        /* Being discounted heavily → underlying price is too high */
        suggestedPrice = Math.round(avgPrice / 5) * 5;
        reason         = 'Frequently discounted — suggested price matches average selling price.';
      } else {
        reason = 'Price appears optimal for current demand.';
      }

      const newMargin = ((suggestedPrice - costPrice) / suggestedPrice * 100).toFixed(1);

      return {
        productId, productName: product.name,
        currentPrice: product.price, suggestedPrice,
        currentMargin: parseFloat(currentMargin),
        newMargin:     parseFloat(newMargin),
        unitsSold30d:  unitsSold,
        dailyVelocity: parseFloat(dailyVel.toFixed(2)),
        reason,
        applyNow: () => PosDB.products.update(productId, { price: suggestedPrice }),
      };
    },

    async optimizeAll() {
      const products = await PosDB.products.getAll();
      const results  = [];
      for (const p of products.slice(0, 50)) {
        const r = await this.optimize(p.id).catch(() => null);
        if (r && r.suggestedPrice !== r.currentPrice) results.push(r);
      }
      return results.sort((a, b) => Math.abs(b.suggestedPrice - b.currentPrice) - Math.abs(a.suggestedPrice - a.currentPrice));
    },

    renderPanel(containerId, results) {
      const el = document.getElementById(containerId);
      if (!el) return;
      if (!results?.length) {
        el.innerHTML = '<div class="bos-all-good">✓ All prices appear optimal.</div>';
        return;
      }
      el.innerHTML = `
        <table class="pos-table" style="font-size:12px">
          <thead><tr>
            <th>Product</th><th>Current</th><th>Suggested</th><th>Margin</th><th>Reason</th><th></th>
          </tr></thead>
          <tbody>
            ${results.map((r, i) => `
              <tr>
                <td>${r.productName}</td>
                <td>KES ${r.currentPrice.toLocaleString()}</td>
                <td style="color:var(--green);font-weight:700">KES ${r.suggestedPrice.toLocaleString()}</td>
                <td>${r.currentMargin}% → ${r.newMargin}%</td>
                <td style="color:var(--txt2)">${r.reason}</td>
                <td><button class="bos-action-btn" onclick="PosAIEngine.pricing.applyResult(${i})">Apply</button></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `;
      this._lastResults = results;
    },

    _lastResults: [],
    async applyResult(idx) {
      const r = this._lastResults[idx];
      if (!r) return;
      await PosDB.products.update(r.productId, { price: r.suggestedPrice });
      if (window.SPos) SPos.toast(`✓ Price updated: ${r.productName} → KES ${r.suggestedPrice}`, 'success');
    },
  };

  /* ─────────────────────────────────────────────────────────────
     REQUIREMENT 34 — Sales Forecasting (Exponential Smoothing)
     Predicts next 7 / 30 / 90 days sales with seasonal factors
  ─────────────────────────────────────────────────────────────── */
  const forecasting = {
    /* α = smoothing factor, β = trend factor */
    async forecast(days = 30, alpha = 0.3, beta = 0.1) {
      const history = await this._getDailyHistory(90);
      if (history.length < 7) return { error: 'Not enough history for forecasting.' };

      const values = history.map(d => d.total);
      /* Holt's linear exponential smoothing */
      let level = values[0];
      let trend = values[1] - values[0];

      const smoothed = [level];
      for (let i = 1; i < values.length; i++) {
        const prevLevel = level;
        level = alpha * values[i] + (1 - alpha) * (level + trend);
        trend = beta * (level - prevLevel) + (1 - beta) * trend;
        smoothed.push(level);
      }

      /* Day-of-week seasonal adjustment */
      const dowFactors = this._computeDOWFactors(history);

      const projections = [];
      const startDate   = new Date();
      startDate.setDate(startDate.getDate() + 1);

      for (let i = 0; i < days; i++) {
        const date  = new Date(startDate);
        date.setDate(date.getDate() + i);
        const dow   = date.getDay();
        const base  = level + (i + 1) * trend;
        const adj   = base * dowFactors[dow];
        projections.push({
          date:  date.toISOString().slice(0, 10),
          label: date.toLocaleDateString('en-KE', { weekday: 'short', month: 'short', day: 'numeric' }),
          predicted: Math.max(0, Math.round(adj)),
          low:       Math.max(0, Math.round(adj * 0.85)),
          high:      Math.round(adj * 1.15),
          dow,
        });
      }

      const totalPredicted = projections.reduce((s, d) => s + d.predicted, 0);
      const period7  = projections.slice(0, 7).reduce((s, d) => s + d.predicted, 0);

      return {
        projections,
        summary: {
          next7days:  period7,
          next30days: totalPredicted,
          avgDaily:   Math.round(totalPredicted / days),
          confidence: history.length >= 60 ? 'High' : history.length >= 30 ? 'Medium' : 'Low',
        },
        history: history.slice(-30),
      };
    },

    async _getDailyHistory(daysBack) {
      const end   = Date.now();
      const start = end - daysBack * 86400000;
      const txns  = await PosDB.transactions.getAll();

      const buckets = {};
      for (const txn of txns) {
        if (txn.completedAt < start || txn.status !== 'completed') continue;
        const day = new Date(txn.completedAt).toISOString().slice(0, 10);
        if (!buckets[day]) buckets[day] = { date: day, total: 0, count: 0 };
        buckets[day].total += txn.total || 0;
        buckets[day].count++;
      }

      const result = [];
      for (let d = 0; d < daysBack; d++) {
        const dt  = new Date(start + d * 86400000).toISOString().slice(0, 10);
        result.push(buckets[dt] || { date: dt, total: 0, count: 0 });
      }
      return result;
    },

    _computeDOWFactors(history) {
      const totals  = [0,0,0,0,0,0,0];
      const counts  = [0,0,0,0,0,0,0];
      const overall = history.reduce((s, d) => s + d.total, 0) / history.length || 1;

      for (const d of history) {
        const dow = new Date(d.date).getDay();
        totals[dow] += d.total;
        counts[dow]++;
      }
      return totals.map((t, i) => {
        const avg = counts[i] > 0 ? t / counts[i] : overall;
        return avg / overall;
      });
    },

    async renderPanel(containerId) {
      const el = document.getElementById(containerId);
      if (!el) return;
      el.innerHTML = '<div class="bos-loading">Building forecast…</div>';

      const result = await this.forecast(30).catch(e => ({ error: e.message }));
      if (result.error) {
        el.innerHTML = '<div class="bos-error"></div>'; el.firstChild.textContent = result.error || 'Forecast failed'; return;
      }

      const { summary, projections } = result;
      const conf = { High: 'var(--green)', Medium: '#f59e0b', Low: 'var(--txt2)' }[summary.confidence];

      const maxVal = Math.max(...projections.map(d => d.high), 1);
      const bars = projections.slice(0, 14).map(d => {
        const pct = Math.round(d.predicted / maxVal * 100);
        const lo  = Math.round(d.low  / maxVal * 100);
        const hi  = Math.round(d.high / maxVal * 100);
        return `
          <div style="display:flex;flex-direction:column;align-items:center;gap:2px;flex:1;min-width:0">
            <div style="height:80px;width:100%;display:flex;align-items:flex-end;justify-content:center;gap:1px">
              <div style="width:10px;background:rgba(113,255,0,.15);border-radius:2px;height:${hi}%;position:relative">
                <div style="position:absolute;bottom:0;width:100%;height:${pct}%;background:var(--green);border-radius:2px;opacity:.8"></div>
              </div>
            </div>
            <div style="font-size:8px;color:var(--txt3);text-align:center;transform:rotate(-45deg);transform-origin:top left;white-space:nowrap;margin-top:12px;margin-left:8px">
              ${d.label.split(',')[0]}
            </div>
          </div>
        `;
      }).join('');

      el.innerHTML = `
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:14px">
          <div class="bos-kpi-tile green">
            <div class="bos-kpi-label">Next 7 Days</div>
            <div class="bos-kpi-val green">KES ${summary.next7days.toLocaleString()}</div>
          </div>
          <div class="bos-kpi-tile">
            <div class="bos-kpi-label">Next 30 Days</div>
            <div class="bos-kpi-val">KES ${summary.next30days.toLocaleString()}</div>
          </div>
          <div class="bos-kpi-tile">
            <div class="bos-kpi-label">Confidence</div>
            <div class="bos-kpi-val" style="color:${conf}">${summary.confidence}</div>
          </div>
        </div>
        <div style="overflow:hidden">
          <div style="font-size:11px;color:var(--txt2);margin-bottom:8px">14-day projection (green = predicted, light = range)</div>
          <div style="display:flex;align-items:flex-end;gap:2px;height:100px;padding-bottom:4px">${bars}</div>
        </div>
        <div style="font-size:10px;color:var(--txt3);margin-top:16px">
          Based on ${result.history.length} days of sales history. Forecast uses Holt-Winters exponential smoothing with day-of-week seasonal adjustment.
        </div>
      `;
    },
  };

  /* ─────────────────────────────────────────────────────────────
     RECOMMENDATION WIDGET — renders upsell chips below cart
  ─────────────────────────────────────────────────────────────── */
  async function renderUpsellChips(containerId, cartProductIds) {
    const el = document.getElementById(containerId);
    if (!el) return;

    const recs = await recommendations.getForCart(cartProductIds, 4);
    if (!recs.length) { el.innerHTML = ''; return; }

    el.innerHTML = `
      <div class="upsell-strip">
        <div class="upsell-label">💡 Customers also buy:</div>
        <div class="upsell-chips">
          ${recs.map(p => `
            <button class="upsell-chip" onclick="SPos.cart.addItem('${p.id}');PosAIEngine.renderUpsellChips('${containerId}',[])">
              <span class="upsell-chip-name">${_esc(p.name)}</span>
              <span class="upsell-chip-price">KES ${(p.price||0).toLocaleString()}</span>
            </button>
          `).join('')}
        </div>
      </div>
    `;
  }

  function _esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  return { recommendations, ocr, pricing, forecasting, renderUpsellChips };
})();

window.PosAIEngine = PosAIEngine;
