/* ═══════════════════════════════════════════════════════════════════════════
   sokoni-ent-calendar.js — THE availability calendar (storefront + provider).

   One component over ONE server authority (functions/ent-availability.js):
     public   → bookingDispatch entAvailMonth / entAvailDay   (SAFE states only)
     provider → bookingDispatch entAvailProviderMonth / entAvailProviderDay
                + entAvailBlock / entAvailUnblock             (audited)

   The browser DISPLAYS availability; it never decides it. Whether a slot is free,
   booked, overlapping or bookable is the server's answer — this file renders it.

   REALTIME: two BOUNDED listeners — entAvailabilityPublic/{calKey} (configuration
   changed) and entAvailabilityPublic/{calKey}_{YYYY-MM} (the visible month changed).
   Those docs carry a counter and nothing else; on a change the component re-asks
   the server for the visible month and the open day. Re-subscribed on navigation,
   torn down on destroy(). No unbounded listener, no multi-year load.

   Usage:
     const cal = SokoniEntCalendar.mount(host, { providerId | venueId, serviceId,
       mode: 'public' | 'provider', onSelect({ date, start, end }) })
     cal.setService(id) · cal.refresh() · cal.destroy()
   ═══════════════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  const STATE_LABEL = {
    AVAILABLE: 'Available', LIMITED: 'Limited', BOOKED: 'Booked', UNAVAILABLE: 'Unavailable',
    BOOKING_NOT_OPEN: 'Booking not open', TEMPORARILY_HELD: 'Temporarily held',
    BLOCKED: 'Blocked', PENDING: 'Pending payment',
  };
  const STATE_CLASS = {
    AVAILABLE: 'ok', LIMITED: 'lim', BOOKED: 'bk', UNAVAILABLE: 'un', BOOKING_NOT_OPEN: 'no', TEMPORARILY_HELD: 'hd',
    BLOCKED: 'bl', PENDING: 'hd',
  };
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = (n) => String(n).padStart(2, '0');
  const nairobiToday = () => new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10);
  const fmtTime = (hhmm) => {
    const p = String(hhmm || '').split(':'); const h = Number(p[0]) || 0; const m = Number(p[1]) || 0;
    return ((h + 11) % 12 + 1) + ':' + pad(m) + (h < 12 ? ' AM' : ' PM');
  };

  function call(op, data) {
    const fn = root.firebase && root.firebase.functions && root.firebase.functions().httpsCallable('bookingDispatch');
    if (!fn) return Promise.reject(new Error('Availability is unavailable right now.'));
    return fn(Object.assign({ op }, data || {})).then((r) => r.data);
  }

  const CSS = `
  .skcal{--ok:#71ff00;--lim:#f5c542;--bk:#ff6b6b;--hd:#ffa94d;--un:#555;--no:#3a3a3a;--bl:#8e7cff;color:#eee;font-size:14px;max-width:100%}
  .skcal *{box-sizing:border-box}
  .skcal-nav{display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap}
  .skcal-nav button,.skcal-nav select{min-height:44px;min-width:44px;background:#141414;border:1px solid #262626;color:#eee;border-radius:10px;padding:6px 10px;font-size:15px;cursor:pointer}
  .skcal-title{font-weight:800;flex:1;min-width:120px}
  .skcal-grid{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:4px}
  .skcal-dow{font-size:11px;color:#8a8a8a;text-align:center;padding:4px 0}
  .skcal-day{position:relative;min-height:44px;border-radius:9px;border:1px solid #1f1f1f;background:#101010;color:#ddd;font-size:13px;cursor:pointer;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:2px}
  .skcal-day[disabled]{cursor:default;opacity:.55}
  .skcal-day .dot{width:7px;height:7px;border-radius:50%;margin-top:3px;background:var(--un)}
  .skcal-day.ok .dot{background:var(--ok)}.skcal-day.lim .dot{background:var(--lim)}.skcal-day.bk .dot{background:var(--bk)}
  .skcal-day.hd .dot{background:var(--hd)}.skcal-day.no .dot{background:var(--no)}.skcal-day.bl .dot{background:var(--bl)}
  .skcal-day.sel{outline:2px solid var(--ok)}
  .skcal-day.pad{visibility:hidden}
  .skcal-legend{display:flex;flex-wrap:wrap;gap:10px;margin:10px 0;font-size:12px;color:#aaa}
  .skcal-legend span::before{content:'';display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:5px;background:var(--c)}
  .skcal-slots{display:flex;flex-wrap:wrap;gap:7px;margin-top:8px}
  .skcal-slot{min-height:44px;background:#141414;border:1px solid #262626;color:#ddd;border-radius:9px;padding:6px 10px;font-size:13px;cursor:pointer;display:flex;flex-direction:column;align-items:flex-start}
  .skcal-slot small{font-size:11px;color:#9a9a9a}
  .skcal-slot.ok{border-color:rgba(113,255,0,.4)}.skcal-slot.sel{background:var(--ok);color:#04120a;font-weight:800}
  .skcal-slot[disabled]{cursor:not-allowed;opacity:.6}
  .skcal-msg{font-size:13px;color:#9a9a9a;padding:10px 0}
  .skcal-live{font-size:11px;color:#71ff00}
  .skcal-items{margin-top:10px;display:flex;flex-direction:column;gap:6px}
  .skcal-item{display:flex;justify-content:space-between;align-items:center;gap:8px;background:#121212;border:1px solid #222;border-radius:9px;padding:8px 10px;font-size:13px;flex-wrap:wrap}
  .skcal-form{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px;align-items:flex-end}
  .skcal-form input{min-height:44px;background:#141414;border:1px solid #262626;color:#eee;border-radius:9px;padding:6px 8px;font-size:16px;max-width:100%}
  .skcal-btn{min-height:44px;background:#71ff00;color:#04120a;border:none;border-radius:10px;padding:8px 14px;font-weight:800;cursor:pointer}
  .skcal-btn.ghost{background:#141414;color:#ddd;border:1px solid #262626}
  .skcal-views{display:flex;gap:6px;margin-bottom:8px;flex-wrap:wrap}.skcal-views .on{border-color:#71ff00;color:#71ff00}
  .skcal-week{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:4px;font-size:11px}
  .skcal-week .col{background:#101010;border:1px solid #1f1f1f;border-radius:8px;padding:4px;min-width:0}
  .skcal-week .cell{border-radius:5px;padding:2px 3px;margin:2px 0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
  .skcal-week .cell.ok{background:rgba(113,255,0,.12)}.skcal-week .cell.bk{background:rgba(255,107,107,.18)}.skcal-week .cell.hd{background:rgba(255,169,77,.18)}.skcal-week .cell.bl{background:rgba(142,124,255,.2)}.skcal-week .cell.un{background:#161616;color:#777}
  .skcal-year{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px}
  .skcal-year button{min-height:44px;text-align:left;background:#101010;border:1px solid #1f1f1f;border-radius:10px;color:#ddd;padding:8px;cursor:pointer}
  .skcal-year .bar{display:flex;height:6px;border-radius:3px;overflow:hidden;margin-top:6px;background:#1a1a1a}
  `;
  function injectCss() {
    if (document.getElementById('skcal-css')) return;
    const s = document.createElement('style'); s.id = 'skcal-css'; s.textContent = CSS; document.head.appendChild(s);
  }

  function mount(host, opts) {
    if (!host) return null;
    injectCss();
    const o = Object.assign({ mode: 'public' }, opts || {});
    const provider = o.mode === 'provider';
    const ident = o.venueId ? { venueId: o.venueId } : o.providerId ? { providerId: o.providerId } : {};
    const today = nairobiToday();
    let year = Number(today.slice(0, 4)); let month = Number(today.slice(5, 7));
    let serviceId = o.serviceId || null;
    let calKey = null; let days = {}; let bookable = true; let selDate = null; let daySlots = null; let dayItems = [];
    let unsubs = []; let lastRev = {}; let refreshTimer = null; let destroyed = false; let seq = 0;
    const cache = {};
    const MAX_YEAR = Number(today.slice(0, 4)) + 2;       /* bounded navigation: this year + the next two */

    host.innerHTML = '';
    const wrap = document.createElement('div'); wrap.className = 'skcal'; host.appendChild(wrap);
    wrap.innerHTML = `
      <div class="skcal-nav">
        <button type="button" data-prev aria-label="Previous month">‹</button>
        <div class="skcal-title" data-title aria-live="polite"></div>
        <select data-year aria-label="Year"></select>
        <button type="button" data-next aria-label="Next month">›</button>
      </div>
      <div class="skcal-views" data-views hidden><button type="button" class="skcal-btn ghost" data-view="month">Month</button><button type="button" class="skcal-btn ghost" data-view="week">Week</button><button type="button" class="skcal-btn ghost" data-view="year">Year</button></div>
      <div class="skcal-grid" data-grid role="grid"></div>
      <div data-alt></div>
      <div class="skcal-legend" data-legend></div>
      <div data-day></div>`;
    const $ = (sel) => wrap.querySelector(sel);
    const legendStates = provider ? ['AVAILABLE', 'BOOKED', 'PENDING', 'BLOCKED', 'UNAVAILABLE', 'BOOKING_NOT_OPEN'] : ['AVAILABLE', 'LIMITED', 'BOOKED', 'TEMPORARILY_HELD', 'UNAVAILABLE', 'BOOKING_NOT_OPEN'];
    $('[data-legend]').innerHTML = legendStates.map((s) => `<span style="--c:var(--${STATE_CLASS[s]})">${esc(STATE_LABEL[s])}</span>`).join('') + '<span class="skcal-live" data-live hidden>● live</span>';
    const ysel = $('[data-year]');
    for (let y = Number(today.slice(0, 4)); y <= MAX_YEAR; y++) { const op = document.createElement('option'); op.value = y; op.textContent = y; ysel.appendChild(op); }

    const monthKey = () => `${year}-${pad(month)}`;
    const canPrev = () => monthKey() > today.slice(0, 7);
    const canNext = () => year < MAX_YEAR || month < 12;

    function renderGrid() {
      $('[data-title]').textContent = `${MONTHS[month - 1]} ${year}`;
      ysel.value = String(year);
      $('[data-prev]').disabled = !canPrev(); $('[data-next]').disabled = !canNext();
      const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
      const n = new Date(Date.UTC(year, month, 0)).getUTCDate();
      let html = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => `<div class="skcal-dow">${d}</div>`).join('');
      for (let i = 0; i < first; i++) html += '<div class="skcal-day pad" aria-hidden="true"></div>';
      for (let d = 1; d <= n; d++) {
        const date = `${monthKey()}-${pad(d)}`;
        const st = dayState(date);
        const cls = STATE_CLASS[st] || 'un';
        const openable = provider ? st !== 'BOOKING_NOT_OPEN' : (st === 'AVAILABLE' || st === 'LIMITED' || st === 'BOOKED' || st === 'TEMPORARILY_HELD' || st === 'UNAVAILABLE');
        html += `<button type="button" class="skcal-day ${cls}${date === selDate ? ' sel' : ''}" data-date="${date}" ${openable && date >= today ? '' : 'disabled'}
          aria-label="${esc(date)} ${esc(STATE_LABEL[st] || '')}">${d}<span class="dot"></span></button>`;
      }
      $('[data-grid]').innerHTML = html;
    }
    function dayState(date) {
      const v = days[date];
      if (!v) return date < today ? 'UNAVAILABLE' : 'UNAVAILABLE';
      if (typeof v === 'string') return v;
      /* provider mode: counts of private states */
      if (v.beyondHorizon) return 'BOOKING_NOT_OPEN';
      const c = v.counts || {};
      if (c.AVAILABLE) return (c.BOOKED || c.PENDING || c.BLOCKED) ? 'LIMITED' : 'AVAILABLE';
      if (c.BOOKED) return 'BOOKED';
      if (c.PENDING) return 'PENDING';
      if (c.BLOCKED) return 'BLOCKED';
      return 'UNAVAILABLE';
    }

    async function loadMonth(force) {
      const key = `${serviceId || '-'}|${monthKey()}`;
      const my = ++seq;
      if (!force && cache[key] && Date.now() - cache[key].at < 60000) { applyMonth(cache[key].r); }
      else {
        $('[data-grid]').setAttribute('aria-busy', 'true');
        try {
          const r = await call(provider ? 'entAvailProviderMonth' : 'entAvailMonth', Object.assign({}, ident, { serviceId, month: monthKey() }));
          if (destroyed || my !== seq) return;
          cache[key] = { at: Date.now(), r };
          applyMonth(r);
        } catch (e) {
          if (destroyed || my !== seq) return;
          days = {};
          renderGrid();
          $('[data-day]').innerHTML = `<div class="skcal-msg">${esc((e && e.message) || 'Could not load availability.')}</div>`;
          return;
        } finally { $('[data-grid]').removeAttribute('aria-busy'); }
      }
      subscribe();
      /* prefetch the next month quietly (bounded: one month) */
      if (canNext()) {
        const ny = month === 12 ? year + 1 : year; const nm = month === 12 ? 1 : month + 1;
        const nk = `${serviceId || '-'}|${ny}-${pad(nm)}`;
        if (!cache[nk]) call(provider ? 'entAvailProviderMonth' : 'entAvailMonth', Object.assign({}, ident, { serviceId, month: `${ny}-${pad(nm)}` }))
          .then((r) => { cache[nk] = { at: Date.now(), r }; }).catch(() => {});
      }
    }
    function applyMonth(r) {
      calKey = r.calKey; bookable = r.bookable !== false && !(r.bookable && r.bookable.ok === false);
      days = r.days || {};
      dayItems = r.items || [];
      renderGrid();
      if (!bookable && !provider) $('[data-day]').innerHTML = '<div class="skcal-msg">This provider is not taking bookings right now.</div>';
      if (selDate && selDate.slice(0, 7) === monthKey()) loadDay(selDate, true);
      if (typeof o.onMonth === 'function') o.onMonth({ month: monthKey(), days, bookable });
    }

    async function loadDay(date, quiet) {
      selDate = date;
      renderGrid();
      const box = $('[data-day]');
      if (!quiet) box.innerHTML = '<div class="skcal-msg">Loading times…</div>';
      try {
        const r = await call(provider ? 'entAvailProviderDay' : 'entAvailDay', Object.assign({}, ident, { serviceId, date }));
        if (destroyed || selDate !== date) return;
        daySlots = r.slots || [];
        renderDay(date, r);
      } catch (e) { box.innerHTML = `<div class="skcal-msg">${esc((e && e.message) || 'Could not load times.')}</div>`; }
    }
    function renderDay(date, r) {
      const box = $('[data-day]');
      const nice = new Date(date + 'T12:00:00Z').toLocaleDateString('en-KE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
      if (!provider && r.state === 'BOOKING_NOT_OPEN') { box.innerHTML = `<h4 style="margin:12px 0 4px">${esc(nice)}</h4><div class="skcal-msg">Booking is not open for this date yet.</div>`; return; }
      if (!daySlots.length) { box.innerHTML = `<h4 style="margin:12px 0 4px">${esc(nice)}</h4><div class="skcal-msg">No times on this day.</div>`; return; }
      const slotsHtml = daySlots.map((s, i) => {
        const st = s.state; const free = st === 'AVAILABLE' || st === 'LIMITED';
        const clickable = provider || (free && bookable);
        return `<button type="button" class="skcal-slot ${STATE_CLASS[st] || 'un'}" data-slot="${i}" ${clickable ? '' : 'disabled'}
          aria-label="${esc(fmtTime(s.start))} ${esc(STATE_LABEL[st] || st)}">${esc(fmtTime(s.start))}<small>${esc(STATE_LABEL[st] || st)}</small></button>`;
      }).join('');
      let extra = '';
      if (provider) {
        const own = (dayItems || []).filter((it) => new Date(Number(it.start) + 3 * 3600000).toISOString().slice(0, 10) === date);
        extra = `<div class="skcal-items">${own.map((it) => `<div class="skcal-item"><span><strong>${esc(STATE_LABEL[it.kind] || it.kind)}</strong> · ${esc(fmtTime(new Date(Number(it.start) + 3 * 3600000).toISOString().slice(11, 16)))}–${esc(fmtTime(new Date(Number(it.end) + 3 * 3600000).toISOString().slice(11, 16)))}
            ${it.label ? ' · ' + esc(it.label) : ''}${it.ref ? ' · <span style="color:#8a8a8a">' + esc(String(it.ref).split('/').pop().slice(-8)) + '</span>' : ''}</span>
            ${it.kind === 'BLOCKED' ? `<button type="button" class="skcal-btn ghost" data-unblock="${esc(it.id)}">Open time</button>` : ''}</div>`).join('') || '<div class="skcal-msg">Nothing booked or blocked on this day.</div>'}</div>
          <form class="skcal-form" data-blockform>
            <label>From<br><input type="time" name="start" value="09:00" required></label>
            <label>To<br><input type="time" name="end" value="10:00" required></label>
            <label style="flex:1;min-width:140px">Private note (only you see it)<br><input name="label" maxlength="120" placeholder="e.g. travel, private event"></label>
            <button class="skcal-btn" type="submit">Block time</button>
          </form>`;
      }
      box.innerHTML = `<h4 style="margin:12px 0 4px">${esc(nice)}</h4><div class="skcal-slots">${slotsHtml}</div>${extra}`;
    }

    function subscribe() {
      unsubs.forEach((u) => { try { u(); } catch (_) {} }); unsubs = [];
      const fs = root.firebase && root.firebase.firestore && root.firebase.firestore();
      if (!fs || !calKey) return;
      const watch = (id) => {
        try {
          const u = fs.collection('entAvailabilityPublic').doc(id).onSnapshot((snap) => {
            const rev = snap && snap.exists ? (snap.data() || {}).rev : 0;
            const had = Object.prototype.hasOwnProperty.call(lastRev, id);
            lastRev[id] = rev;
            const live = wrap.querySelector('[data-live]'); if (live) live.hidden = false;
            if (had && rev !== undefined) scheduleRefresh();
          }, () => {});
          unsubs.push(u);
        } catch (_) { /* realtime unavailable → the view still works on demand */ }
      };
      watch(calKey);
      watch(`${calKey}_${monthKey()}`);
    }
    function scheduleRefresh() {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => { Object.keys(cache).forEach((k) => { if (k.endsWith('|' + monthKey())) delete cache[k]; }); loadMonth(true); }, 250);
    }

    wrap.addEventListener('click', async (ev) => {
      const b = ev.target.closest('button'); if (!b || b.disabled) return;
      if (b.hasAttribute('data-prev') && canPrev()) { month -= 1; if (month < 1) { month = 12; year -= 1; } selDate = null; $('[data-day]').innerHTML = ''; loadMonth(); return; }
      if (b.hasAttribute('data-next') && canNext()) { month += 1; if (month > 12) { month = 1; year += 1; } selDate = null; $('[data-day]').innerHTML = ''; loadMonth(); return; }
      if (b.dataset.date) { loadDay(b.dataset.date); return; }
      if (b.dataset.slot != null) {
        const s = daySlots[Number(b.dataset.slot)];
        if (!s) return;
        wrap.querySelectorAll('.skcal-slot.sel').forEach((x) => x.classList.remove('sel'));
        b.classList.add('sel');
        if (typeof o.onSelect === 'function') o.onSelect({ date: selDate, start: s.start, end: s.end, state: s.state, calKey });
        return;
      }
      if (b.dataset.unblock) {
        b.disabled = true;
        try { await call('entAvailUnblock', Object.assign({}, ident, { blockId: b.dataset.unblock, date: selDate })); scheduleRefresh(); }
        catch (e) { b.disabled = false; alert((e && e.message) || 'Could not open that time.'); }
      }
    });
    wrap.addEventListener('submit', async (ev) => {
      const f = ev.target; if (!f.matches('[data-blockform]')) return;
      ev.preventDefault();
      const btn = f.querySelector('button'); btn.disabled = true;
      try { await call('entAvailBlock', Object.assign({}, ident, { date: selDate, start: f.start.value, end: f.end.value, label: f.label.value })); scheduleRefresh(); }
      catch (e) { alert((e && e.message) || 'Could not block that time.'); }
      finally { btn.disabled = false; }
    });
    ysel.addEventListener('change', () => {
      year = Number(ysel.value);
      if (monthKey() < today.slice(0, 7)) month = Number(today.slice(5, 7));
      selDate = null; $('[data-day]').innerHTML = ''; loadMonth();
    });

    /* PROVIDER views: Month (grid) · Week (7 days of private slots, bounded: 7 day calls) · Year (12 months,
       bounded: 12 month calls, only when asked) · Day (the day panel). The public sees Month + Day only. */
    let view = 'month';
    if (provider) {
      const vs = $('[data-views]'); vs.hidden = false;
      vs.addEventListener('click', (ev) => { const b = ev.target.closest('[data-view]'); if (b) setView(b.dataset.view); });
    }
    function setView(v) {
      view = v;
      wrap.querySelectorAll('[data-view]').forEach((b) => b.classList.toggle('on', b.dataset.view === v));
      $('[data-grid]').hidden = v !== 'month'; $('[data-legend]').hidden = false;
      const alt = $('[data-alt]'); alt.innerHTML = '';
      if (v === 'week') renderWeek(alt);
      if (v === 'year') renderYear(alt);
    }
    async function renderWeek(alt) {
      const start = selDate || (monthKey() === today.slice(0, 7) ? today : monthKey() + '-01');
      const s0 = new Date(start + 'T12:00:00Z'); s0.setUTCDate(s0.getUTCDate() - s0.getUTCDay());
      const dates = []; for (let i = 0; i < 7; i++) { const d = new Date(s0); d.setUTCDate(s0.getUTCDate() + i); dates.push(d.toISOString().slice(0, 10)); }
      alt.innerHTML = '<div class="skcal-msg">Loading the week…</div>';
      const days = await Promise.all(dates.map((d) => call('entAvailProviderDay', Object.assign({}, ident, { serviceId, date: d })).catch(() => ({ slots: [] }))));
      if (destroyed || view !== 'week') return;
      alt.innerHTML = `<div class="skcal-week">${dates.map((d, i) => `<div class="col"><strong>${esc(new Date(d + 'T12:00:00Z').toLocaleDateString('en-KE', { weekday: 'short', day: 'numeric' }))}</strong>` +
        (days[i].slots || []).map((s) => `<div class="cell ${STATE_CLASS[s.state] || 'un'}" title="${esc(STATE_LABEL[s.state] || s.state)}">${esc(s.start)} ${esc((STATE_LABEL[s.state] || s.state).split(' ')[0])}</div>`).join('') + '</div>').join('')}</div>`;
    }
    async function renderYear(alt) {
      alt.innerHTML = '<div class="skcal-msg">Loading the year…</div>';
      const months = []; for (let m = 1; m <= 12; m++) months.push(`${year}-${pad(m)}`);
      const res = await Promise.all(months.map((mk) => mk < today.slice(0, 7) ? Promise.resolve(null) : call('entAvailProviderMonth', Object.assign({}, ident, { serviceId, month: mk })).catch(() => null)));
      if (destroyed || view !== 'year') return;
      alt.innerHTML = `<div class="skcal-year">${months.map((mk, i) => { const r = res[i]; if (!r) return `<button type="button" disabled>${esc(MONTHS[i])}<div class="skcal-msg">—</div></button>`;
        const c = { AVAILABLE: 0, BOOKED: 0, PENDING: 0, BLOCKED: 0 }; Object.values(r.days || {}).forEach((d) => Object.keys(c).forEach((k) => { c[k] += (d.counts && d.counts[k]) || 0; }));
        const tot = c.AVAILABLE + c.BOOKED + c.PENDING + c.BLOCKED || 1;
        return `<button type="button" data-yearmonth="${mk}">${esc(MONTHS[i])}<div class="skcal-msg" style="padding:2px 0">${c.BOOKED} booked · ${c.PENDING} pending · ${c.BLOCKED} blocked</div>` +
          `<div class="bar"><span style="width:${100 * c.BOOKED / tot}%;background:var(--bk)"></span><span style="width:${100 * c.PENDING / tot}%;background:var(--hd)"></span><span style="width:${100 * c.BLOCKED / tot}%;background:var(--bl)"></span><span style="width:${100 * c.AVAILABLE / tot}%;background:var(--ok)"></span></div></button>`; }).join('')}</div>`;
      alt.querySelectorAll('[data-yearmonth]').forEach((b) => b.addEventListener('click', () => { month = Number(b.dataset.yearmonth.slice(5)); setView('month'); loadMonth(); }));
    }

    renderGrid();
    loadMonth();
    if (provider) setView('month');
    return {
      setView(v) { if (provider) setView(v); },
      setService(id) { serviceId = id || null; selDate = null; $('[data-day]').innerHTML = ''; loadMonth(true); },
      refresh() { scheduleRefresh(); },
      get calKey() { return calKey; },
      destroy() { destroyed = true; clearTimeout(refreshTimer); unsubs.forEach((u) => { try { u(); } catch (_) {} }); unsubs = []; host.innerHTML = ''; },
    };
  }

  /**
   * Marketplace / marketing availability badges. Fills every [data-avail-provider] / [data-avail-venue]
   * under `scope` from ONE batched entAvailSummary call (≤ 24 calendars). Says only what the server
   * says: bookings open (with the next open date), limited slots, fully booked — never why.
   */
  function badges(scope) {
    const el = scope || document;
    const nodes = Array.prototype.slice.call(el.querySelectorAll('[data-avail-provider],[data-avail-venue]')).slice(0, 24);
    if (!nodes.length) return Promise.resolve(null);
    const cals = nodes.map((n) => (n.dataset.availVenue ? { venueId: n.dataset.availVenue } : { providerId: n.dataset.availProvider }));
    const fmt = (d) => { try { return new Date(d + 'T12:00:00Z').toLocaleDateString('en-KE', { day: 'numeric', month: 'short' }); } catch (_) { return d; } };
    return call('entAvailSummary', { calendars: cals }).then((r) => {
      const res = (r && r.results) || {};
      nodes.forEach((n) => {
        const key = n.dataset.availVenue ? 'ven_' + n.dataset.availVenue : 'svc_' + n.dataset.availProvider;
        const x = res[key];
        if (!x || x.state === 'NOT_BOOKABLE') { n.textContent = ''; n.hidden = true; return; }
        n.hidden = false;
        n.setAttribute('data-avail-state', x.state);
        n.textContent = x.state === 'FULLY_BOOKED' ? 'Fully booked' : (x.state === 'LIMITED' ? 'Limited slots' : 'Available') + (x.next ? ' · ' + fmt(x.next) : '');
      });
      return res;
    }).catch(() => { nodes.forEach((n) => { n.hidden = true; }); return null; });
  }

  root.SokoniEntCalendar = { mount, badges, STATE_LABEL, _esc: esc };
}(typeof window !== 'undefined' ? window : globalThis));
