/* ================================================================================================
   SOKONI Delivery Hub — rider workspace (owner 2026-10-03)            sokoni-rider-hub.js
   ------------------------------------------------------------------------------------------------
   ONE module behind driver.html. It REUSES the existing delivery authorities; it adds none:
     identity      /api/rider-profile (Bearer)                       — server rider record
     presence      riderPresence {status|online|offline|heartbeat}   — the SERVER decides online
     board         /api/available-deliveries (Bearer) + claimAvailableDelivery
     assigned job  packageRequests (assignedDriverId) via SokoniDB    — existing lifecycle writes
     order job     orders via SokoniOrders.rider* transitions         — existing state machine
     completion    completeDeliveryWithPin | completeParcelWithPin    — server PIN check, no fallback
     failure       handleFailedDelivery (retry / reassign / return / refund / support — server decides)
     dispatch      dispatchQueue offers + respondToDispatch
     earnings      walletTransactions (type delivery_earning)         — the exactly-once ledger credit
     wallet        wallets/{uid}, payouts (entityId)                  — read only
     fuel          sysConfig/fuelPrices (EPRA) + triggerEPRAFuelFetch
     application   applications (uid, type driver) — read; applying goes to onboarding-driver.html
   Removed from the old portal (owner 2026-10-03): the legacy DeliveryHub `deliveries` pipeline (it
   showed the PIN to the rider and accepted a wrong PIN), insurance / referral / payout-schedule copy,
   the localStorage driver record, the browser "claimable orders" list (refused by rules anyway).
   HONEST STATE: unknown renders "—" / "Not available yet", never 0 or a guess; a failed read says so;
   success copy appears only after the server confirmed.
   ================================================================================================ */
import SokoniDB from './sokoni-db.js';
import SokoniOrders from './sokoni-orders.js';

const FS_URL = 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
const AUTH_URL = 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';

/* ── state ─────────────────────────────────────────────────────────────────────────────────── */
const S = {
  user: null, profileState: 'loading', rider: null, roles: [],
  presence: 'unknown', presenceAt: null,
  board: { state: 'idle', list: [], code: null },
  pkgJob: null, orderJob: null,
  ledger: { state: 'idle', rows: [] },
  wallet: { state: 'idle', balance: null }, payouts: { state: 'idle', rows: [] },
  jobs: { state: 'idle', pkgs: [], orders: [] }, csat: { state: 'idle', avg: null, n: 0 },
  fuel: { state: 'idle', doc: null }, app: { state: 'idle', doc: null },
  cats: null, view: 'overview', histTab: 'active', histQ: '',
};
const H = {};      /* rendered-on-demand hooks */
/* Vibrate only after the rider has interacted with the page — browsers block (and log) it otherwise. */
const buzz = (p) => { try { if (navigator.vibrate && (!navigator.userActivation || navigator.userActivation.hasBeenActive)) navigator.vibrate(p); } catch (_) {} };
let _heartbeat = null, _boardTimer = null, _gps = false, _unsub = [];

/* ── utils ─────────────────────────────────────────────────────────────────────────────────── */
const $ = (s, r = document) => r.querySelector(s);
const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const idSafe = (v) => String(v == null ? '' : v).replace(/[^A-Za-z0-9_-]/g, '');
const num = (v) => (v === null || v === undefined || v === '' || !isFinite(Number(v))) ? null : Number(v);
const kes = (v) => { const n = num(v); return n === null ? '—' : 'KES ' + Math.round(n).toLocaleString('en-KE'); };
const ms = (v) => { if (!v) return null; if (typeof v === 'number') return v > 1e12 ? v : v * 1000; if (typeof v.toMillis === 'function') return v.toMillis(); if (typeof v.seconds === 'number') return v.seconds * 1000; const t = Date.parse(v); return isNaN(t) ? null : t; };
const when = (v) => { const t = ms(v); return t ? new Date(t).toLocaleString('en-KE', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'; };
function toast (msg, bad) { const t = $('#dhToast'); if (!t) return; t.textContent = msg; t.className = 'dh-toast on' + (bad ? ' bad' : ''); clearTimeout(t._h); t._h = setTimeout(() => { t.className = 'dh-toast'; }, 3800); }
function modal (html) { $('#dhModalBody').innerHTML = html; $('#dhModal').classList.add('on'); setTimeout(() => { const f = $('#dhModalBody [data-autofocus]') || $('#dhModalX'); f && f.focus(); }, 30); }
function closeModal () { $('#dhModal').classList.remove('on'); }
const skel = (n = 3) => Array.from({ length: n }, () => '<div class="dh-skel" style="margin-bottom:10px"></div>').join('');
const empty = (ic, txt, act) => `<div class="dh-card dh-empty"><span class="ei">${ic}</span>${txt}${act ? `<div style="margin-top:12px">${act}</div>` : ''}</div>`;
const errBox = (txt, retry) => `<div class="dh-err"><span>${esc(txt)}</span>${retry ? `<button class="btn sm" data-act="${retry}">Retry</button>` : ''}</div>`;

async function ready () {
  if (typeof window.waitForFirebaseReady === 'function') await Promise.race([window.waitForFirebaseReady(), new Promise((r) => setTimeout(r, 9000))]);
}
function callable (name) {
  if (window.firebaseFunctions && window.firebaseFunctions.httpsCallable) return window.firebaseFunctions.httpsCallable(name);
  if (window.firebase && window.firebase.functions) return window.firebase.functions().httpsCallable(name);
  return null;
}
async function call (name, data) {
  const fn = callable(name);
  if (!fn) throw Object.assign(new Error('Cannot reach SOKONI right now.'), { code: 'unavailable' });
  const r = await fn(data || {});
  return (r && r.data) || {};
}
async function fs () { const m = await import(FS_URL); return { m, db: window.firebaseDB }; }
function uid () { return (window.firebaseAuth && window.firebaseAuth.currentUser && window.firebaseAuth.currentUser.uid) || null; }
const isRider = () => !!(S.rider && S.rider.exists);
const isApproved = () => isRider() && (S.rider.approved === true || ['approved', 'active', 'online', 'verified'].includes(String(S.rider.status || '').toLowerCase()));

/* ── router ────────────────────────────────────────────────────────────────────────────────── */
const VIEWS = {
  overview: 'Overview', drive: 'Rider Drive', available: 'Available Deliveries', deliveries: 'My Deliveries', map: 'Live Map',
  earnings: 'Earnings', wallet: 'Wallet & Settlements', performance: 'Performance', fuel: 'Fuel prices (EPRA)',
  categories: 'Delivery Categories', application: 'Rider Application', documents: 'Documents & Verification',
  notifications: 'Notifications', messages: 'Messages', support: 'Support', settings: 'Settings',
};
const RIDER_ONLY = ['drive', 'available', 'deliveries', 'map', 'earnings', 'wallet', 'performance'];
/* Until the server profile has answered, a rider-only section is NOT refused — it renders its loading state.
   Refusing at boot bounced every rider's deep link (#/available, #/drive) to Application before the profile
   could say they are a rider. Once the profile is known, the gate applies (loadProfile re-checks). */
function allowed (v) { return !RIDER_ONLY.includes(v) || isRider() || S.profileState === 'loading'; }
function go (v, push = true) {
  if (!VIEWS[v]) v = 'overview';
  if (!allowed(v)) v = isRider() ? 'overview' : 'application';
  S.view = v;
  document.querySelectorAll('.dh-view').forEach((el) => el.classList.toggle('on', el.dataset.view === v));
  document.querySelectorAll('[data-go]').forEach((el) => { if (el.classList.contains('dh-item') || el.closest('.dh-bnav')) { if (el.dataset.go === v) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current'); } });
  $('#dhTitle').textContent = VIEWS[v];
  document.title = VIEWS[v] + ' · SOKONI Delivery Hub';
  if (push) { try { history.replaceState(null, '', '#/' + v); } catch (_) {} }
  try { localStorage.setItem('dhLastView', v); } catch (_) {}
  drawer(false);
  render(v);
  const m = $('#dhMain'); if (m && push) m.focus({ preventScroll: true });
  window.scrollTo(0, 0);
}
function drawer (open) {
  $('#dhSide').classList.toggle('open', open); $('#dhScrim').classList.toggle('on', open);
  $('#dhMenuBtn').setAttribute('aria-expanded', String(open));
}
function render (v) {
  const el = document.querySelector(`.dh-view[data-view="${v}"]`); if (!el || !R[v]) return;
  if (RIDER_ONLY.includes(v) && S.profileState === 'loading') { el.innerHTML = `<h1 class="dh-h1">${esc(VIEWS[v])}</h1><p class="dh-sub">Loading your rider profile…</p>${skel(3)}`; return; }
  el.innerHTML = R[v](); if (H[v]) H[v]();
}
function rerender (...vs) { if (vs.includes(S.view)) render(S.view); paintChrome(); }

/* ── chrome: presence chip, badges, nav visibility ─────────────────────────────────────────── */
const PRES = {
  online: ['🟢', 'Online', 'ok', 'Online — you are visible for new deliveries'],
  on_delivery: ['🔵', 'On delivery', 'busy', 'Online — on a delivery'],
  offline: ['⚪', 'Offline', '', 'Offline — go online to receive deliveries'],
  stale: ['🟠', 'Connection lost', 'warn', 'Connection lost — tap Go Online to reconnect'],
  not_eligible: ['🔒', 'Not cleared', 'bad', 'Your rider account is not cleared for deliveries yet (approval or documents pending)'],
  suspended: ['⛔', 'Suspended', 'bad', 'Your rider account is suspended — contact support'],
  unknown: ['', 'Status unknown', '', 'Checking your status with SOKONI…'],
};
function presMeta () { return PRES[S.presence] || PRES.unknown; }
function paintChrome () {
  const p = presMeta();
  $('#dhPresDot').className = 'dh-dot ' + p[2]; $('#dhPresTxt').textContent = isRider() ? p[1] : (S.user ? 'Not a rider yet' : 'Signed out');
  $('#dhSideDot').className = 'dh-dot ' + p[2]; $('#dhSidePres').textContent = isRider() ? p[3] : '—';
  $('#dhSideWho').textContent = (S.rider && S.rider.name) || (S.user && (S.user.displayName || S.user.email)) || '—';
  document.querySelectorAll('[data-rider]').forEach((el) => { el.style.display = isRider() ? '' : 'none'; });
  const active = (S.pkgJob ? 1 : 0) + (S.orderJob ? 1 : 0);
  const bd = $('#dhBadgeDrive'); bd.textContent = active; bd.classList.toggle('on', active > 0);
  const ba = $('#dhBadgeAvail'); const n = S.board.state === 'ok' ? S.board.list.length : 0; ba.textContent = n; ba.classList.toggle('on', n > 0);
}

/* ═══════════════════════════════ VIEWS ═══════════════════════════════════════════════════════ */
const R = {};

R.overview = () => {
  if (S.profileState === 'loading') return `<h1 class="dh-h1">Delivery Hub</h1><p class="dh-sub">Loading your rider profile…</p>${skel(3)}`;
  if (!S.user) return `<h1 class="dh-h1">Delivery Hub</h1>${empty('🔑', 'Sign in with your SOKONI account to open the Delivery Hub — one login for everything.', '<a class="btn pri" href="/login.html?redirect=%2Fdriver">Sign in</a>')}`;
  if (S.profileState === 'error') return `<h1 class="dh-h1">Delivery Hub</h1>${errBox('Could not load your rider profile.', 'reload-profile')}`;
  const first = String((S.rider && S.rider.name) || S.user.displayName || 'there').trim().split(/\s+/)[0];
  if (!isRider()) {
    return `<h1 class="dh-h1">Hello ${esc(first)} 👋</h1><p class="dh-sub">You're signed in. Become a SOKONI rider to start delivering.</p>
      ${appCta()}
      <div class="dh-sec-h"><h2>What you can deliver</h2><button class="btn sm" data-go="categories">All categories</button></div>${catChips()}`;
  }
  const p = presMeta();
  const job = S.pkgJob || S.orderJob;
  const led = ledgerSums();
  return `
    <div class="dh-hero">
      <div class="dh-av" style="${S.rider.photo && /^https:\/\//.test(S.rider.photo) ? `background-image:url('${esc(S.rider.photo)}')` : ''}">${S.rider.photo && /^https:\/\//.test(S.rider.photo) ? '' : esc(initials(S.rider.name || first))}</div>
      <div class="dh-hero-id"><b>Hello ${esc(first)} 👋</b><span>${isApproved() ? '<span class="st ok">✓ Approved rider</span>' : '<span class="st warn">⏳ Pending review</span>'} ${S.rider.zone ? ' · 📍 ' + esc(S.rider.zone) : ''}${S.rider.vehicle ? ' · ' + esc(vehLabel(S.rider.vehicle)) : ''}</span></div>
      <button class="dh-toggle" id="dhToggle" type="button" data-act="toggle-online" data-state="${esc(S.presence)}" ${S.presence === 'unknown' ? 'disabled' : ''}>${toggleLabel()}</button>
      <div class="dh-pres-line" aria-live="polite">${esc(p[3])}${S.presenceAt ? ' · updated ' + esc(when(S.presenceAt)) : ''}</div>
    </div>
    <div class="dh-sec-h"><h2>Today</h2></div>
    <div class="dh-kpis">
      ${kpi(led.state === 'ok' ? led.todayN : '—', 'Deliveries today', 'credited deliveries')}
      ${kpi(led.state === 'ok' ? kes(led.today) : '—', 'Earnings today', 'from your wallet ledger')}
      ${kpi(job ? '1' : '0', 'Active delivery', job ? esc(job.label) : 'none right now')}
      ${kpi(S.board.state === 'ok' ? S.board.list.length : '—', 'Available', boardNote())}
    </div>
    <div class="dh-2col" style="margin-top:4px">
      <div>
        <div class="dh-sec-h"><h2>Active delivery</h2>${job ? '<button class="btn sm blue" data-go="drive">Open Rider Drive</button>' : ''}</div>
        ${job ? jobSummary(job) : empty('🛵', S.presence === 'online' ? 'No active delivery. New jobs appear in Available Deliveries.' : 'No active delivery. Go online to receive deliveries.', '<button class="btn" data-go="available">View available deliveries</button>')}
        <div class="dh-sec-h"><h2>Available deliveries</h2><button class="btn sm" data-go="available">See all</button></div>
        ${boardList(3)}
      </div>
      <div>
        <div class="dh-sec-h"><h2>Wallet</h2><button class="btn sm" data-go="wallet">Open</button></div>
        <div class="dh-card"><div class="row"><span class="k">Available balance</span><span class="v">${S.wallet.state === 'ok' ? kes(S.wallet.balance) : (S.wallet.state === 'error' ? 'Unavailable' : '—')}</span></div>
        <div class="row"><span class="k">This week (credited)</span><span class="v">${led.state === 'ok' ? kes(led.week) : '—'}</span></div></div>
        <div class="dh-sec-h"><h2>Delivery categories</h2><button class="btn sm" data-go="categories">All</button></div>${catChips()}
      </div>
    </div>`;
};
function initials (n) { const p = String(n || 'R').trim().split(/\s+/).filter(Boolean); return ((p[0] || 'R')[0] + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase(); }
const VEH = { bicycle: 'Bicycle', ebike: 'E-bike', motorcycle: 'Boda boda', boda: 'Boda boda', tuktuk: 'Tuk-tuk', car: 'Car', van: 'Van', pickup: 'Pickup', canter: 'Canter', lorry: 'Lorry', truck: 'Truck' };
const vehLabel = (v) => VEH[String(v).toLowerCase()] || String(v);
const kpi = (v, l, n) => `<div class="dh-kpi"><div class="v">${v}</div><div class="l">${l}</div>${n ? `<div class="n">${n}</div>` : ''}</div>`;
function toggleLabel () { return ({ online: '🟢 Online — tap to go offline', on_delivery: '🔵 On a delivery', stale: '🟠 Reconnect', not_eligible: '🔒 Not cleared yet', suspended: '⛔ Suspended', offline: '⚪ Go online', unknown: 'Checking…' })[S.presence] || '⚪ Go online'; }
function boardNote () { if (S.board.state !== 'ok') return ({ offline: 'go online to see jobs', refused: 'not cleared yet', error: 'could not load' })[S.board.state] || '—'; return 'jobs you can claim'; }
function appCta () {
  const a = S.app;
  if (a.state === 'loading' || a.state === 'idle') return skel(1);
  const st = appState();
  const btn = { none: '<a class="btn pri" href="onboarding-driver.html">Apply to become a rider</a>', submitted: '<button class="btn" data-go="application">View application</button>', info: '<a class="btn warn" href="onboarding-driver.html">Complete application</a>', rejected: '<button class="btn" data-go="application">View decision</button>', approved: '<button class="btn pri" data-go="drive">Open Rider Drive</button>' }[st.key];
  return `<div class="dh-card"><div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap"><div><b style="font-size:16px">Become a SOKONI rider</b><div class="dh-note">${esc(st.text)}</div></div>${btn || ''}</div></div>`;
}

/* ── Rider Drive ─────────────────────────────────────────────────────────────────────────────── */
R.drive = () => {
  const jobs = [S.pkgJob, S.orderJob].filter(Boolean);
  if (!jobs.length) return `<h1 class="dh-h1">Rider Drive</h1><p class="dh-sub">Your current delivery, step by step: pickup → navigate → customer → completion.</p>
    ${empty('🛵', S.presence === 'online' ? 'No active delivery yet. Claim one from Available Deliveries.' : 'Go online, then claim a delivery to start driving.', '<button class="btn pri" data-go="available">Find a delivery</button>')}`;
  return `<h1 class="dh-h1">Rider Drive</h1><p class="dh-sub">Pickup → navigate → customer → completion. The delivery completes only when SOKONI verifies the customer's PIN.</p>${jobs.map(driveCard).join('')}`;
};
const STAGES = { driver_assigned: 0, rider_assigned: 0, driver_accepted: 1, rider_en_route: 1, driver_at_seller: 2, picked_up: 2, in_transit: 3 };
function driveCard (j) {
  const s = STAGES[j.status] != null ? STAGES[j.status] : 0;
  const nav = j.status === 'in_transit' || j.status === 'picked_up' ? j.dropNav : j.pickNav;
  const chat = j.chat ? `<a class="btn sm" href="${esc(j.chat)}">💬 Message</a>` : '';
  const call = j.phone ? `<a class="btn sm" href="tel:${esc(String(j.phone).replace(/[^\d+]/g, ''))}">📞 Call</a>` : '';
  return `<div class="job" id="drv_${idSafe(j.key)}">
    <div class="job-h"><div><div class="job-id">${esc(j.icon)} ${esc(j.label)}</div><div class="job-meta">${esc(statusText(j.status))}</div></div><div class="job-earn">${j.earn}</div></div>
    <div class="drive-stages" aria-hidden="true">${[0, 1, 2, 3].map((i) => `<div class="${i <= s ? 'on' : ''}"></div>`).join('')}</div>
    <div class="drive-labels" aria-hidden="true"><span>Assigned</span><span>To pickup</span><span>Picked up</span><span>To customer</span></div>
    <div class="route"><span class="pt a"></span><span class="tx"><small>Pickup</small>${esc(j.pickup || '—')}${j.seller ? ' · ' + esc(j.seller) : ''}</span><span class="ln"></span><span></span><span class="pt b"></span><span class="tx"><small>Customer</small>${esc(j.drop || '—')}${j.buyer ? ' · ' + esc(j.buyer) : ''}</span></div>
    ${j.items ? `<div class="dh-note">🛒 ${esc(j.items)}</div>` : ''}${j.notes ? `<div class="dh-note">📝 ${esc(j.notes)}</div>` : ''}
    <div class="dh-note">${j.km != null ? '📏 ' + esc(j.km) + ' km' : '📏 Distance —'}</div>
    <div class="btn-row"><button class="btn sm blue" data-act="nav" data-dest="${esc(nav || '')}" ${nav ? '' : 'disabled'}>🧭 Navigate</button>${call}${chat}
      <button class="btn sm" type="button" disabled title="Proof photos are not available yet">📷 Proof photo — not available yet</button>
      <button class="btn sm danger" data-act="problem" data-key="${esc(j.key)}">🚨 Problem</button></div>
    ${stageAction(j)}
  </div>`;
}
function stageAction (j) {
  const k = esc(j.key);
  const pair = (a, b) => `<div class="btn-row">${a}${b || ''}</div>`;
  switch (j.status) {
    case 'driver_assigned': return `<button class="btn pri block" data-act="pkg-accept" data-key="${k}">✅ Accept delivery</button><p class="dh-note" style="margin:6px 0 0">Can't take it? Use 🚨 Problem → "My vehicle broke down" and SOKONI reassigns it.</p>`;
    case 'rider_assigned': return pair(`<button class="btn pri" data-act="ord-accept" data-key="${k}">✅ Accept delivery</button>`, `<button class="btn danger" data-act="ord-pass" data-key="${k}">Pass</button>`);
    case 'driver_accepted': return `<button class="btn blue block" data-act="pkg-at-seller" data-key="${k}">📍 I'm at the pickup</button>`;
    case 'rider_en_route': return `<button class="btn blue block" data-act="ord-picked" data-key="${k}">📦 Picked up</button>`;
    case 'driver_at_seller': return `<button class="btn blue block" data-act="pkg-picked" data-key="${k}">📦 Picked up — start delivery</button>`;
    case 'picked_up': return `<button class="btn blue block" data-act="ord-transit" data-key="${k}">🚗 Start delivery to customer</button>`;
    case 'in_transit': return `<div><label class="dh-note" for="pin_${idSafe(j.key)}">Ask the customer for their delivery PIN at handover</label>
      <input class="pin-in" id="pin_${idSafe(j.key)}" inputmode="numeric" autocomplete="one-time-code" maxlength="8" pattern="[0-9]*" placeholder="••••••" aria-label="Customer delivery PIN">
      <button class="btn pri block" style="margin-top:8px" data-act="complete" data-key="${k}">🎉 Verify PIN &amp; complete</button></div>`;
    default: return '';
  }
}
const ST_TXT = { driver_assigned: 'New delivery for you — accept or pass', rider_assigned: 'New delivery for you — accept or pass', driver_accepted: 'Heading to pickup', rider_en_route: 'Heading to pickup', driver_at_seller: 'At pickup', picked_up: 'Picked up', in_transit: 'On the way to the customer', delivered: 'Delivered', completed: 'Completed', buyer_confirmed: 'Confirmed by customer', cancelled: 'Cancelled', return_in_progress: 'Return in progress', retry_scheduled: 'Retry scheduled', refund_initiated: 'Refund initiated', support_required: 'With SOKONI support', ready_for_pickup: 'Waiting for a rider' };
const statusText = (s) => ST_TXT[s] || String(s || '—').replace(/_/g, ' ');
function jobSummary (j) { return `<div class="job"><div class="job-h"><div><div class="job-id">${esc(j.icon)} ${esc(j.label)}</div><div class="job-meta">${esc(statusText(j.status))}</div></div><div class="job-earn">${j.earn}</div></div><div class="route"><span class="pt a"></span><span class="tx"><small>Pickup</small>${esc(j.pickup || '—')}</span><span class="ln"></span><span></span><span class="pt b"></span><span class="tx"><small>Customer</small>${esc(j.drop || '—')}</span></div></div>`; }

/* normalise the two job sources into one card model */
const CAT_IC = { marketplace: '🛒', food: '🍱', pharmacy: '💊', property: '📑', general: '📦', parcel: '📦' };
function navOf (c, addr) { if (c && num(c.lat) !== null && num(c.lng) !== null) return c.lat + ',' + c.lng; return addr || ''; }
function fromPkg (r) {
  const dRef = r.deliveryRef || r.ref || r._fsId;
  return { kind: 'pkg', key: 'p_' + idSafe(r._fsId || dRef), dRef, raw: r, status: r.status, icon: CAT_IC[r.kind === 'parcel' ? 'parcel' : r.category] || '📦',
    label: (r.kind === 'parcel' ? 'Parcel ' : 'Delivery ') + String(dRef || '').slice(0, 14),
    pickup: r.pickupAddress, drop: r.deliveryAddress, seller: r.sellerName, buyer: r.buyerName, phone: r.buyerPhone || r.customerPhone || '',
    km: num(r.distanceKm) !== null ? Number(r.distanceKm).toFixed(1) : null, earn: kes(r.riderEarning != null ? r.riderEarning : r.driverNet),
    pickNav: navOf(r.pickupCoords, r.pickupAddress), dropNav: navOf(r.deliveryCoords, r.deliveryAddress),
    chat: r._fsId ? 'chat.html?tx=logistics_request&txId=' + encodeURIComponent(idSafe(r._fsId)) : '', notes: r.deliveryNotes || r.instructions || '', parcel: r.kind === 'parcel' };
}
function fromOrder (o) {
  const oId = o.id || o._fsId;
  return { kind: 'order', key: 'o_' + idSafe(oId), oId, dRef: o.deliveryRef || o.deliveryId || null, raw: o, status: o.status, icon: CAT_IC[o.category] || '🛒',
    label: 'Order ' + String(oId || '').slice(0, 14), pickup: o.pickupAddress, drop: o.deliveryAddress, seller: o.sellerName, buyer: o.buyerName, phone: '',
    items: (o.items || []).slice(0, 3).map((i) => `${i.qty || 1}× ${i.name || 'Item'}`).join(', '),
    km: num(o.distanceKm) !== null ? Number(o.distanceKm).toFixed(1) : null, earn: kes(o.driverNet),
    pickNav: navOf(o.pickupCoords, o.pickupAddress), dropNav: navOf(o.deliveryCoords, o.deliveryAddress),
    chat: oId ? 'chat.html?tx=order&txId=' + encodeURIComponent(idSafe(oId)) : '', notes: o.deliveryNotes || '', parcel: o.kind === 'parcel' };
}
const jobByKey = (k) => [S.pkgJob, S.orderJob].find((j) => j && j.key === k) || null;

/* ── Available ───────────────────────────────────────────────────────────────────────────────── */
R.available = () => `<h1 class="dh-h1">Available Deliveries</h1><p class="dh-sub">Jobs ready for a rider. You see the pickup shop and the delivery area — the customer's details arrive after you claim.</p>
  <div class="filters"><select class="sel" id="avCat" aria-label="Category"><option value="">All categories</option>${Object.keys(CAT_IC).filter((c) => c !== 'parcel').map((c) => `<option value="${c}">${c[0].toUpperCase() + c.slice(1)}</option>`).join('')}<option value="parcel">Parcel</option></select>
  <input class="inp" id="avQ" placeholder="Search delivery ID or area" aria-label="Search available deliveries"><button class="btn sm" data-act="board-refresh">↻ Refresh</button></div>
  <div id="avList">${boardList(50)}</div>`;
H.available = () => { const f = () => { $('#avList').innerHTML = boardList(50); }; $('#avCat') && ($('#avCat').onchange = f); $('#avQ') && ($('#avQ').oninput = f); };
function boardList (limit) {
  const b = S.board;
  if (!isRider()) return empty('🛵', 'Available deliveries are for SOKONI riders.', '<button class="btn pri" data-go="application">Become a rider</button>');
  if (b.state === 'idle' || b.state === 'loading') return skel(2);
  if (b.state === 'offline') return empty('⚪', S.presence === 'stale' ? 'Your connection to SOKONI was lost, so you are not being offered jobs. Reconnect to see deliveries.' : 'Go online to see available deliveries.', '<button class="btn pri" data-act="toggle-online">Go online</button>');
  if (b.state === 'refused') return empty('🔒', 'Your rider account is not cleared for deliveries yet (approval or documents pending). Once it is, jobs appear here.', '<button class="btn" data-go="documents">Check verification</button>');
  if (b.state === 'signin') return empty('🔑', 'Sign in again to see available deliveries.', '<a class="btn pri" href="/login.html?redirect=%2Fdriver">Sign in</a>');
  if (b.state === 'error') return errBox('Could not load available deliveries.', 'board-refresh');
  const cat = ($('#avCat') || {}).value || '', q = String(($('#avQ') || {}).value || '').toLowerCase();
  const list = b.list.filter((d) => (!cat || (cat === 'parcel' ? d.kind === 'parcel' : d.category === cat)) && (!q || [d.id, d.orderId, d.deliveryArea, d.sellerName].join(' ').toLowerCase().includes(q))).slice(0, limit);
  if (!list.length) return empty('📭', b.list.length ? 'No jobs match your filter.' : 'No deliveries right now — check back shortly. This list refreshes every 20 seconds.');
  return list.map((d) => {
    const net = kes(d.riderEarning != null ? d.riderEarning : d.driverNet); const parcel = d.kind === 'parcel';
    return `<div class="job"><div class="job-h"><div><div class="job-id">${parcel ? '📦 Parcel' : (CAT_IC[d.category] || '🛒') + ' Delivery'} #${esc(String(d.orderId || d.id).slice(0, 12))}</div><div class="job-meta">${esc(d.category || (parcel ? 'parcel' : 'marketplace'))}${d.vehicleType ? ' · ' + esc(d.vehicleType) : ''}</div></div><div class="job-earn">${net}<div class="dh-muted" style="font-size:11px;font-weight:700;text-align:right">estimated to you</div></div></div>
      <div class="route"><span class="pt a"></span><span class="tx"><small>Pickup</small>${esc(d.sellerName || 'Shop')}</span><span class="ln"></span><span></span><span class="pt b"></span><span class="tx"><small>Delivery area</small>${esc(String(d.deliveryArea || 'Area not recorded').slice(0, 60))}</span></div>
      <div class="dh-note">📦 ${num(d.itemCount) !== null ? Number(d.itemCount) : '—'} item(s)${num(d.distanceKm) !== null ? ' · 📏 ' + Number(d.distanceKm).toFixed(1) + ' km to pickup' : ' · 📏 Distance —'}${parcel && d.tripKm ? ' · ' + esc(String(d.tripKm)) + ' km trip' : ''}</div>
      <button class="btn pri block" data-act="claim" data-ref="${esc(d.id)}">Claim delivery${net !== '—' ? ' — ' + net : ''}</button></div>`;
  }).join('');
}

/* ── My Deliveries ───────────────────────────────────────────────────────────────────────────── */
const TABS = { active: ['driver_assigned', 'driver_accepted', 'driver_at_seller', 'in_transit', 'rider_assigned', 'rider_en_route', 'picked_up'], upcoming: ['retry_scheduled'], completed: ['delivered', 'completed', 'buyer_confirmed'], cancelled: ['cancelled', 'refund_initiated'], returned: ['return_in_progress', 'returned'], disputed: ['support_required', 'disputed'] };
R.deliveries = () => {
  const j = S.jobs;
  const tabs = Object.keys(TABS).map((t) => `<button class="tab" role="tab" aria-selected="${S.histTab === t}" data-act="hist-tab" data-tab="${t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('');
  let body;
  if (j.state === 'idle' || j.state === 'loading') body = skel(3);
  else if (j.state === 'error') body = errBox('Could not load your deliveries.', 'reload-jobs');
  else {
    const all = [...j.pkgs.map((r) => ({ src: 'pkg', id: r.deliveryRef || r._fsId, ref: r.orderId || '', status: r.status, at: r.updatedAt || r.createdAt, pickup: r.pickupAddress, drop: r.deliveryAddress, earn: r.riderEarning != null ? r.riderEarning : r.driverNet, issue: r.deliveryIssue || r.failReason })),
      ...j.orders.map((o) => ({ src: 'order', id: o.id || o._fsId, ref: o.id || o._fsId, status: o.status, at: o.updatedAt || o.createdAt, pickup: o.pickupAddress, drop: o.deliveryAddress, earn: o.driverNet, issue: null }))];
    const q = S.histQ.toLowerCase();
    const rows = all.filter((x) => (TABS[S.histTab] || []).includes(x.status) || (S.histTab === 'disputed' && x.issue)).filter((x) => !q || (String(x.id) + ' ' + String(x.ref)).toLowerCase().includes(q)).sort((a, b) => (ms(b.at) || 0) - (ms(a.at) || 0));
    body = rows.length ? rows.map((x) => `<div class="job"><div class="job-h"><div><div class="job-id">${x.src === 'pkg' ? '📦' : '🛒'} ${esc(String(x.id).slice(0, 16))}</div><div class="job-meta">${x.ref ? 'Order ' + esc(String(x.ref).slice(0, 14)) + ' · ' : ''}${esc(when(x.at))}</div></div><div style="text-align:right"><div class="job-earn" style="font-size:15px">${kes(x.earn)}</div><span class="st ${stClass(x.status)}">${esc(statusText(x.status))}</span></div></div>
      <div class="route"><span class="pt a"></span><span class="tx"><small>Pickup</small>${esc(x.pickup || '—')}</span><span class="ln"></span><span></span><span class="pt b"></span><span class="tx"><small>Customer</small>${esc(x.drop || '—')}</span></div>${x.issue ? `<div class="dh-note">🚨 ${esc(x.issue)}</div>` : ''}</div>`).join('') : empty('📭', 'Nothing here yet.');
  }
  return `<h1 class="dh-h1">My Deliveries</h1><p class="dh-sub">Every delivery assigned to you, from SOKONI's delivery records.</p><div class="tabs" role="tablist" aria-label="Delivery status">${tabs}</div>
    <div class="filters"><input class="inp" id="histQ" placeholder="Search delivery ID or order reference" aria-label="Search deliveries" value="${esc(S.histQ)}"></div><div id="histBody">${body}</div>`;
};
H.deliveries = () => { if (S.jobs.state === 'idle') loadJobs(); const q = $('#histQ'); if (q) q.oninput = () => { S.histQ = q.value; const pos = q.selectionStart; render('deliveries'); const n = $('#histQ'); n.focus(); try { n.setSelectionRange(pos, pos); } catch (_) {} }; };
function stClass (s) { if (TABS.completed.includes(s)) return 'ok'; if (TABS.active.includes(s)) return 'info'; if (TABS.cancelled.includes(s) || TABS.disputed.includes(s)) return 'bad'; if (TABS.returned.includes(s) || s === 'retry_scheduled') return 'warn'; return ''; }

/* ── Live Map ────────────────────────────────────────────────────────────────────────────────── */
R.map = () => {
  const loc = window._drvLastLoc && num(window._drvLastLoc.lat) !== null ? window._drvLastLoc : null;
  const job = S.pkgJob || S.orderJob;
  return `<h1 class="dh-h1">Live Map</h1><p class="dh-sub">Your position and the active delivery route.</p>
    <div class="dh-card"><div class="row"><span class="k">Your location</span><span class="v">${loc ? esc(Number(loc.lat).toFixed(4) + ', ' + Number(loc.lng).toFixed(4)) : 'Location unavailable'}</span></div>
    <div class="row"><span class="k">Active delivery</span><span class="v">${job ? esc(job.label) : 'None'}</span></div>
    <div class="row"><span class="k">Pickup</span><span class="v">${job ? esc(job.pickup || '—') : '—'}</span></div>
    <div class="row"><span class="k">Destination</span><span class="v">${job ? esc(job.drop || '—') : '—'}</span></div></div>
    <div class="btn-row" style="margin-top:12px"><a class="btn pri" href="rider-nav.html">🗺️ Open turn-by-turn navigation</a>${job ? `<button class="btn blue" data-act="nav" data-dest="${esc((job.status === 'in_transit' || job.status === 'picked_up') ? job.dropNav : job.pickNav)}">🧭 Navigate in Maps</button>` : ''}</div>
    <p class="dh-note" style="margin-top:12px">Location is shared with SOKONI only while you are online. ${loc ? '' : 'Allow location access and go online to share it.'}</p>`;
};

/* ── Earnings / Wallet / Performance ─────────────────────────────────────────────────────────── */
function ledgerSums () {
  const L = S.ledger; if (L.state !== 'ok') return { state: L.state };
  const now = new Date(); const day0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const wk0 = day0 - ((now.getDay() + 6) % 7) * 86400000; const mo0 = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const r = { state: 'ok', today: 0, week: 0, month: 0, total: 0, todayN: 0, n: 0 };
  for (const t of L.rows) { const a = num(t.amount) || 0, at = ms(t.createdAt) || 0; r.total += a; r.n++; if (at >= day0) { r.today += a; r.todayN++; } if (at >= wk0) r.week += a; if (at >= mo0) r.month += a; }
  return r;
}
R.earnings = () => {
  const s = ledgerSums();
  if (s.state === 'idle' || s.state === 'loading') return `<h1 class="dh-h1">Earnings</h1>${skel(2)}`;
  if (s.state === 'error') return `<h1 class="dh-h1">Earnings</h1>${errBox('Could not load your earnings.', 'reload-ledger')}`;
  const rows = S.ledger.rows.slice(0, 30).map((t) => `<div class="row"><span class="k">${esc(when(t.createdAt))}${t.orderId ? ' · Order ' + esc(String(t.orderId).slice(0, 12)) : ''}</span><span class="v" style="color:var(--acc)">+${kes(t.amount)}</span></div>`).join('');
  return `<h1 class="dh-h1">Earnings</h1><p class="dh-sub">Delivery earnings credited to your SOKONI wallet — one credit per completed delivery.</p>
    <div class="dh-kpis">${kpi(kes(s.today), 'Today', s.todayN + ' deliveries')}${kpi(kes(s.week), 'This week')}${kpi(kes(s.month), 'This month')}${kpi(kes(s.total), 'All time', s.n + ' credits')}</div>
    <div class="dh-sec-h"><h2>Breakdown</h2></div>
    <div class="dh-card"><div class="row"><span class="k">Delivery earnings</span><span class="v">${kes(s.total)}</span></div>
      <div class="row"><span class="k">Bonuses</span><span class="v dh-muted">Not available yet</span></div>
      <div class="row"><span class="k">Adjustments &amp; return adjustments</span><span class="v dh-muted">Not available yet</span></div>
      <div class="row"><span class="k">Platform fee</span><span class="v dh-muted">Deducted before your earning is credited</span></div></div>
    <div class="dh-sec-h"><h2>Recent credits</h2></div><div class="dh-card">${rows || '<div class="dh-empty">No delivery earnings credited yet.</div>'}</div>`;
};
R.wallet = () => {
  const w = S.wallet;
  const pays = S.payouts.state === 'ok' ? (S.payouts.rows.length ? S.payouts.rows.slice(0, 15).map((p) => `<div class="row"><span class="k">${esc(when(p.createdAt || p.requestedAt))}</span><span class="v">${kes(p.amount)} <span class="st ${/paid|complet|success/i.test(p.status) ? 'ok' : /fail|reject/i.test(p.status) ? 'bad' : 'warn'}">${esc(p.status || '—')}</span></span></div>`).join('') : '<div class="dh-empty">No payouts yet.</div>') : (S.payouts.state === 'error' ? errBox('Could not load payouts.', 'reload-wallet') : skel(1));
  return `<h1 class="dh-h1">Wallet &amp; Settlements</h1><p class="dh-sub">Your SOKONI wallet. Money moves only through SOKONI's server — withdrawals happen in your Financial Center.</p>
    <div class="dh-kpis">${kpi(w.state === 'ok' ? kes(w.balance) : (w.state === 'error' ? 'Unavailable' : '—'), 'Available balance')}${kpi('<span class="dh-muted" style="font-size:15px">Not available yet</span>', 'Pending')}${kpi(S.payouts.state === 'ok' ? kes(S.payouts.rows.filter((p) => /paid|complet|success/i.test(p.status)).reduce((a, p) => a + (num(p.amount) || 0), 0)) : '—', 'Paid out')}${kpi(S.payouts.state === 'ok' ? S.payouts.rows.length : '—', 'Payouts')}</div>
    <div class="btn-row" style="margin:12px 0"><a class="btn pri" href="wallet.html">Open Financial Center</a></div>
    <div class="dh-sec-h"><h2>Settlement history</h2></div><div class="dh-card">${pays}</div>`;
};
R.performance = () => {
  const j = S.jobs;
  if (j.state === 'idle' || j.state === 'loading') return `<h1 class="dh-h1">Performance</h1>${skel(2)}`;
  if (j.state === 'error') return `<h1 class="dh-h1">Performance</h1>${errBox('Could not load your performance.', 'reload-jobs')}`;
  const since = Date.now() - 30 * 86400000;
  const all = [...j.pkgs, ...j.orders].filter((x) => (ms(x.createdAt) || 0) >= since);
  const done = all.filter((x) => TABS.completed.includes(x.status)).length;
  const closed = all.filter((x) => !TABS.active.includes(x.status)).length;
  const ret = all.filter((x) => TABS.returned.includes(x.status)).length;
  const disp = j.pkgs.filter((x) => (ms(x.createdAt) || 0) >= since && (x.deliveryIssue || TABS.disputed.includes(x.status))).length;
  const na = '<span class="dh-muted" style="font-size:14px">Not yet available</span>';
  return `<h1 class="dh-h1">Performance</h1><p class="dh-sub">Last 30 days, from your delivery records.</p>
    <div class="dh-kpis">${kpi(done, 'Completed')}${kpi(closed ? Math.round(done / closed * 100) + '%' : '—', 'Completion rate', closed ? done + ' of ' + closed + ' closed' : 'no closed deliveries')}${kpi(S.csat.state === 'ok' ? (S.csat.n ? S.csat.avg.toFixed(1) + ' / 5' : '—') : '—', 'Average rating', S.csat.state === 'ok' ? S.csat.n + ' ratings' : '')}${kpi(na, 'Acceptance rate')}</div>
    <div class="dh-kpis" style="margin-top:10px">${kpi(na, 'On-time delivery')}${kpi(ret, 'Returns')}${kpi(disp, 'Problems / disputes')}${kpi(S.csat.state === 'ok' ? S.csat.n : '—', 'Customer feedback')}</div>
    <div class="dh-sec-h"><h2>Rider tier &amp; bonuses</h2></div>
    <div class="dh-card"><div class="row"><span class="k">Rider tier</span><span class="v dh-muted">Not available yet</span></div><div class="row"><span class="k">Bonus tracker</span><span class="v dh-muted">Not available yet</span></div>
    <p class="dh-note" style="margin:8px 0 0">Tiers and bonuses will appear here once SOKONI runs a bonus programme with real payouts. Nothing shown here is an estimate.</p></div>`;
};

/* ── Fuel (EPRA) ─────────────────────────────────────────────────────────────────────────────── */
/* sysConfig/fuelPrices, as fetchEPRAFuelPrices writes it (fix/epra-pump-prices): current.<fuel>.<town> per EPRA's
   published table, effectiveFrom/effectiveTo = the period EPRA published. Shown EXACTLY as stored — no estimate, no
   trend, no fill-in. The rider's zone town is used when EPRA lists it, otherwise Nairobi. */
function fuelView () {
  const d = (S.fuel && S.fuel.doc) || {};
  const cur = d.current && typeof d.current === 'object' ? d.current : null;
  const zoneKey = String((S.rider && S.rider.zone) || '').toLowerCase().split(/[^a-z]+/).filter(Boolean)[0] || '';
  const town = cur && cur.super_petrol && zoneKey && num(cur.super_petrol[zoneKey]) !== null ? zoneKey : 'nairobi';
  const at = (f) => (cur && cur[f] ? num(cur[f][town]) : null);
  const to = d.effectiveTo ? Date.parse(d.effectiveTo + 'T23:59:59+03:00') : null;
  return { d, town, pms: at('super_petrol'), ago: at('diesel'), ik: at('kerosene'), from: d.effectiveFrom || null, to: d.effectiveTo || null, ended: !!(to && Date.now() > to) };
}
const fmtDay = (iso) => { const t = iso ? Date.parse(iso + 'T00:00:00+03:00') : NaN; return isNaN(t) ? '—' : new Date(t).toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' }); };
R.fuel = () => {
  const f = S.fuel;
  if (f.state === 'idle' || f.state === 'loading') return `<h1 class="dh-h1">Fuel prices (EPRA)</h1>${skel(2)}`;
  const v = fuelView(), d = v.d;
  const have = v.pms !== null || v.ago !== null || v.ik !== null;
  const status = d.scraperStatus === 'failed' ? `<div class="dh-err" style="margin-bottom:12px"><span>${have ? 'SOKONI could not check EPRA for newer prices' : 'EPRA prices unavailable — SOKONI\'s automatic check failed'}${d.scraperLastAttempt ? ' at ' + esc(when(d.scraperLastAttempt)) : ''}.</span><button class="btn sm" data-act="fuel-refresh">Check again</button></div>` : '';
  const ended = have && v.ended ? `<div class="dh-err" style="margin-bottom:12px;background:var(--amber-dim);border-color:rgba(255,180,0,.3);color:#ffd27a"><span>These are EPRA's prices for ${esc(fmtDay(v.from))} – ${esc(fmtDay(v.to))}. That period has ended and EPRA has not yet published newer prices.</span></div>` : '';
  const card = (lbl, n) => `<div class="dh-kpi"><div class="v">${n !== null ? 'KES ' + n.toFixed(2) : '—'}</div><div class="l">${lbl}</div><div class="n">per litre</div></div>`;
  const townLbl = v.town.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  return `<h1 class="dh-h1">Fuel prices (EPRA)</h1><p class="dh-sub">Maximum pump prices published by the Energy &amp; Petroleum Regulatory Authority${have ? ' — ' + esc(townLbl) : ''}.</p>${status}${ended}
    ${have ? `<div class="fuel-grid">${card('Super petrol', v.pms)}${card('Diesel', v.ago)}${card('Kerosene', v.ik)}</div>
      <div class="dh-card" style="margin-top:12px"><div class="row"><span class="k">Source</span><span class="v">${esc(d.source || 'EPRA')}</span></div><div class="row"><span class="k">Pricing period</span><span class="v">${v.from ? esc(fmtDay(v.from)) + ' – ' + esc(fmtDay(v.to)) : '—'}</span></div><div class="row"><span class="k">Last checked</span><span class="v">${esc(when(d.scraperLastSuccess || d.updatedAt))}</span></div></div>
      <div class="dh-sec-h"><h2>Trip fuel estimate</h2></div><div class="dh-card"><div class="filters"><input class="inp" id="fuelKm" type="number" min="0" step="0.1" inputmode="decimal" placeholder="Trip distance in km" aria-label="Trip distance in km"><input class="inp" id="fuelEff" type="number" min="1" step="0.5" inputmode="decimal" placeholder="Your km per litre" aria-label="Your vehicle km per litre"><select class="sel" id="fuelType" aria-label="Fuel type"><option value="pms">Super petrol</option><option value="ago">Diesel</option></select></div><div class="dh-note" id="fuelOut">Enter the distance and your vehicle's km per litre.</div></div>`
    : (status ? '' : empty('⛽', 'Fuel prices are currently unavailable.', '<button class="btn" data-act="fuel-refresh">Check for updates</button>'))}
    <p class="dh-note" style="margin-top:12px">Prices are shown exactly as EPRA published them — no estimates, no trends.</p>`;
};
H.fuel = () => {
  if (S.fuel.state === 'idle') loadFuel();
  const out = $('#fuelOut'); if (!out) return;
  const v = fuelView();
  const f = () => { const km = num($('#fuelKm').value), eff = num($('#fuelEff').value); const pr = $('#fuelType').value === 'ago' ? v.ago : v.pms;
    out.textContent = (km !== null && eff && pr !== null) ? `About ${(km / eff).toFixed(2)} L ≈ KES ${Math.round(km / eff * pr).toLocaleString('en-KE')} at the published price.` : 'Enter the distance and your vehicle\'s km per litre.'; };
  ['fuelKm', 'fuelEff', 'fuelType'].forEach((id) => { const e = $('#' + id); if (e) e.oninput = f; });
};

/* ── Categories ──────────────────────────────────────────────────────────────────────────────── */
function catChips () {
  if (!S.cats) return skel(1);
  return `<div class="tabs">${Object.entries(S.cats).map(([k, c]) => `<button class="tab" data-go="categories">${esc(c.icon || '')} ${esc(shortCat(k, c))}</button>`).join('')}</div>`;
}
const shortCat = (k, c) => ({ marketplace: 'Marketplace', food: 'Food', pharmacy: 'Pharmacy', property: 'Property documents', general: 'Parcels & general' })[k] || c.label || k;
const CAT_DESC = { marketplace: 'Products bought on the SOKONI marketplace, collected from the shop.', food: 'Restaurant and food orders — express, time-sensitive.', pharmacy: 'Pharmacy orders — express; handle with care.', property: 'Property documents between parties.', general: 'General packages and parcels sent through SOKONI.' };
R.categories = () => {
  if (!S.cats) return `<h1 class="dh-h1">Delivery Categories</h1>${skel(2)}`;
  const counts = {}; if (S.board.state === 'ok') S.board.list.forEach((d) => { const k = d.kind === 'parcel' ? 'general' : (d.category || 'marketplace'); counts[k] = (counts[k] || 0) + 1; });
  const st = isApproved() ? '<span class="st ok">You can take these</span>' : (isRider() ? '<span class="st warn">Pending clearance</span>' : '<span class="st">Apply to participate</span>');
  return `<h1 class="dh-h1">Delivery Categories</h1><p class="dh-sub">The delivery types SOKONI runs today. Every category uses the same rider account and the same PIN-verified completion.</p>
    <div class="cats">${Object.entries(S.cats).map(([k, c]) => `<div class="cat"><div class="ci">${esc(c.icon || '📦')}</div><b>${esc(shortCat(k, c))}</b><div class="dh-note">${esc(CAT_DESC[k] || c.label || '')}</div>
      <div class="row"><span class="k">Active jobs</span><span class="v">${S.board.state === 'ok' ? (counts[k] || 0) : '—'}</span></div><div class="row"><span class="k">Speed</span><span class="v">${esc(String(c.defaultSpeed || '—').replace('_', ' '))}</span></div>
      <div class="row"><span class="k">Requirements</span><span class="v" style="font-weight:600;font-size:12.5px">Approved rider · verified documents</span></div><div style="margin-top:10px">${st}</div>
      ${isApproved() ? `<button class="btn sm block" style="margin-top:10px" data-act="cat-jobs" data-cat="${esc(k)}">See ${esc(shortCat(k, c))} jobs</button>` : (!isRider() ? '<a class="btn sm block pri" style="margin-top:10px" href="onboarding-driver.html">Apply</a>' : '')}</div>`).join('')}</div>`;
};
H.categories = () => { if (!S.cats) loadCats(); };

/* ── Application / Documents ─────────────────────────────────────────────────────────────────── */
function appState () {
  if (isApproved()) return { key: 'approved', label: 'Approved', cls: 'ok', text: 'You are an approved SOKONI rider.' };
  const a = S.app.doc; const s = String((a && a.status) || '').toLowerCase();
  if (isRider() && ['suspended', 'banned'].includes(String(S.rider.status || '').toLowerCase())) return { key: 'rejected', label: 'Suspended', cls: 'bad', text: 'Your rider account is suspended. Contact support.' };
  if (!a) return isRider() ? { key: 'submitted', label: 'Under review', cls: 'warn', text: 'Your rider record exists and is being reviewed.' } : { key: 'none', label: 'Not applied', cls: '', text: 'You have not applied yet.' };
  if (['draft'].includes(s)) return { key: 'info', label: 'Draft', cls: 'warn', text: 'Your application is not finished.' };
  if (['needs_info', 'more_info', 'request_changes', 'needs_information', 'info_requested'].includes(s)) return { key: 'info', label: 'More information required', cls: 'warn', text: 'SOKONI needs more information to review your application.' };
  if (['rejected', 'declined', 'denied'].includes(s)) return { key: 'rejected', label: 'Rejected', cls: 'bad', text: 'Your application was not approved.' };
  if (['approved', 'active', 'verified'].includes(s)) return { key: 'approved', label: 'Approved', cls: 'ok', text: 'Approved — your rider profile is being prepared.' };
  if (['reviewing', 'under_review', 'in_review'].includes(s)) return { key: 'submitted', label: 'Under review', cls: 'warn', text: 'Your application is under review.' };
  return { key: 'submitted', label: 'Submitted', cls: 'warn', text: 'Your application has been submitted and is waiting for review.' };
}
R.application = () => {
  if (S.app.state === 'idle' || S.app.state === 'loading') return `<h1 class="dh-h1">Rider Application</h1>${skel(2)}`;
  const st = appState(); const a = S.app.doc || {};
  const reason = st.key === 'rejected' && (a.decisionReason || a.rejectionReason || a.reviewReasonPublic);
  const btn = { none: '<a class="btn pri" href="onboarding-driver.html">Apply to become a rider</a>', info: '<a class="btn warn" href="onboarding-driver.html">Complete application</a>', approved: '<button class="btn pri" data-go="drive">Open Rider Drive</button>', submitted: '', rejected: '<a class="btn" href="support.html?topic=rider_application">Ask support</a>' }[st.key];
  return `<h1 class="dh-h1">Rider Application</h1><p class="dh-sub">${S.app.state === 'error' ? 'Your application status could not be loaded right now.' : 'Your application to deliver with SOKONI.'}</p>
    <div class="dh-card"><div class="row"><span class="k">Status</span><span class="v"><span class="st ${st.cls}">${esc(st.label)}</span></span></div>
      ${a.createdAt ? `<div class="row"><span class="k">Submitted</span><span class="v">${esc(when(a.createdAt))}</span></div>` : ''}
      ${a.vehicle || a.vehicleType ? `<div class="row"><span class="k">Vehicle</span><span class="v">${esc(vehLabel(a.vehicle || a.vehicleType))}</span></div>` : ''}
      ${reason ? `<div class="row"><span class="k">Reason</span><span class="v" style="font-weight:600">${esc(reason)}</span></div>` : ''}
      <p class="dh-note" style="margin:10px 0">${esc(st.text)}</p><div class="btn-row">${btn || ''}</div></div>
    <div class="dh-sec-h"><h2>Requirements</h2></div>
    <div class="dh-card"><div class="row"><span class="k">Identity</span><span class="v" style="font-weight:600">National ID</span></div><div class="row"><span class="k">Licence</span><span class="v" style="font-weight:600">Valid driving licence (motorised vehicles)</span></div><div class="row"><span class="k">Vehicle</span><span class="v" style="font-weight:600">Type, plate and details</span></div><div class="row"><span class="k">Payout</span><span class="v" style="font-weight:600">M-Pesa number</span></div>
    <p class="dh-note" style="margin:10px 0 0">SOKONI reviews every application. Approval is decided by SOKONI, never by this page.</p></div>`;
};
H.application = () => { if (S.app.state === 'idle') loadApp(); };
R.documents = () => {
  const cleared = S.presence === 'online' || S.presence === 'on_delivery' || S.presence === 'offline' || S.presence === 'stale';
  const ver = !isRider() ? ['Missing', ''] : S.presence === 'not_eligible' ? ['Pending', 'warn'] : S.presence === 'suspended' ? ['Suspended', 'bad'] : (isApproved() && cleared ? ['Verified', 'ok'] : ['Pending', 'warn']);
  return `<h1 class="dh-h1">Documents &amp; Verification</h1><p class="dh-sub">SOKONI checks your identity, licence and vehicle before you can take deliveries.</p>
    <div class="dh-card"><div class="row"><span class="k">Rider record</span><span class="v"><span class="st ${isRider() ? 'ok' : ''}">${isRider() ? 'On file' : 'Missing'}</span></span></div>
      <div class="row"><span class="k">Approval</span><span class="v"><span class="st ${isApproved() ? 'ok' : (isRider() ? 'warn' : '')}">${isApproved() ? 'Approved' : (isRider() ? 'Pending' : 'Not applied')}</span></span></div>
      <div class="row"><span class="k">Verification (identity, licence, vehicle)</span><span class="v"><span class="st ${ver[1]}">${ver[0]}</span></span></div>
      <div class="row"><span class="k">Vehicle</span><span class="v">${isRider() && S.rider.vehicle ? esc(vehLabel(S.rider.vehicle)) : '—'}</span></div>
      <div class="row"><span class="k">Document expiry</span><span class="v dh-muted">Not available yet</span></div></div>
    <p class="dh-note" style="margin-top:12px">For your security SOKONI does not show which individual check is outstanding. If you are not cleared, contact support with your rider account and we will tell you what is missing.</p>
    <div class="btn-row" style="margin-top:10px">${isRider() ? '<a class="btn" href="support.html?topic=rider_verification">Contact support about verification</a>' : '<a class="btn pri" href="onboarding-driver.html">Apply to become a rider</a>'}</div>`;
};

/* ── Account sections ────────────────────────────────────────────────────────────────────────── */
const linkCard = (href, ic, t, s) => `<a class="link-card" href="${href}"><span class="ic">${ic}</span><span>${t}<small>${s}</small></span></a>`;
R.notifications = () => `<h1 class="dh-h1">Notifications</h1><p class="dh-sub">New deliveries, application updates, settlements and SOKONI messages.</p><div class="links">${linkCard('notifications.html', '🔔', 'Notification centre', 'All your SOKONI notifications')}</div>
  <div class="dh-sec-h"><h2>Live on this page</h2></div><div class="dh-card"><div class="row"><span class="k">New delivery offers</span><span class="v">Shown as a banner while you are online</span></div><div class="row"><span class="k">Assigned deliveries</span><span class="v">Appear in Rider Drive instantly</span></div></div>`;
R.messages = () => `<h1 class="dh-h1">Messages</h1><p class="dh-sub">Talk to customers, sellers and SOKONI inside SOKONI — no phone numbers shared.</p><div class="links">${linkCard('messages.html', '💬', 'Inbox', 'All your conversations')}${S.pkgJob && S.pkgJob.chat ? linkCard(esc(S.pkgJob.chat), '📦', 'Current delivery', 'Message about this delivery') : ''}${S.orderJob && S.orderJob.chat ? linkCard(esc(S.orderJob.chat), '🛒', 'Current order', 'Message about this order') : ''}${linkCard('support.html?topic=delivery', '🛟', 'SOKONI operations', 'Open a support conversation')}</div>`;
R.support = () => `<h1 class="dh-h1">Support</h1><p class="dh-sub">Get help from SOKONI. Every request is tracked as a support ticket.</p><div class="links">
  ${linkCard('help.html', '❓', 'FAQ & help', 'Answers to common questions')}${linkCard('support.html?topic=delivery_issue', '📦', 'Delivery issue', 'A problem with a delivery')}${linkCard('support.html?topic=rider_payment', '💰', 'Payment or earnings', 'Wallet, payouts, earnings')}
  ${linkCard('support.html?topic=customer_issue', '👤', 'Customer issue', 'Customer unavailable or unhappy')}${linkCard('support.html?topic=vehicle_issue', '🛵', 'Vehicle issue', 'Breakdown or vehicle details')}${linkCard('support.html?topic=technical', '🛠️', 'Technical issue', 'The app is not working')}</div>`;
R.settings = () => `<h1 class="dh-h1">Settings</h1><p class="dh-sub">Your SOKONI account.</p>
  <div class="dh-card"><div class="row"><span class="k">Signed in as</span><span class="v">${esc((S.user && (S.user.email || S.user.phoneNumber || S.user.displayName)) || '—')}</span></div><div class="row"><span class="k">Rider name</span><span class="v">${esc((S.rider && S.rider.name) || '—')}</span></div><div class="row"><span class="k">Zone</span><span class="v">${esc((S.rider && S.rider.zone) || '—')}</span></div></div>
  <div class="links" style="margin-top:12px">${linkCard('profile.html', '👤', 'Profile', 'Name, photo, contact details')}${linkCard('notifications.html', '🔔', 'Notification preferences', 'Choose how SOKONI reaches you')}</div>
  <div class="btn-row" style="margin-top:14px">${isRider() && (S.presence === 'online' || S.presence === 'on_delivery') ? '<button class="btn" data-act="toggle-online">Go offline</button>' : ''}<button class="btn danger" data-act="exit">Leave Delivery Hub</button></div>`;

/* ═══════════════════════════════ DATA ════════════════════════════════════════════════════════ */
/* The FIRST auth callback is authoritative (Firebase fires it once persistence has been restored), so a
   signed-out visitor sees the sign-in gate at once instead of after a long wait. A session that restores
   later (iOS redirect sign-in) still lands: the listener stays on and reloads the profile when it appears. */
let _authWatch = false;
async function waitUser (maxMs) {
  await ready();
  const a = window.firebaseAuth; if (!a) return null;
  if (a.currentUser) return a.currentUser;
  return new Promise((res) => {
    let done = false; const t = setTimeout(() => { if (!done) { done = true; res(a.currentUser || null); } }, maxMs);
    try {
      a.onAuthStateChanged((u) => {
        if (!done) { done = true; clearTimeout(t); res(u || null); return; }
        if (u && !S.user && !_authWatch) { _authWatch = true; loadProfile(); }
      });
    } catch (_) {}
  });
}
async function finalizeRedirect () { try { const m = await import(AUTH_URL); if (window.firebaseAuth) await m.getRedirectResult(window.firebaseAuth).catch(() => null); } catch (_) {} }
async function loadProfile () {
  S.profileState = 'loading'; rerender('overview');
  await finalizeRedirect();
  const u = await waitUser(12000); S.user = u;
  if (!u) { S.profileState = 'signedout'; rerender('overview', 'application'); paintChrome(); return; }
  try {
    const tok = await u.getIdToken();
    const r = await fetch('/api/rider-profile', { headers: { Authorization: 'Bearer ' + tok }, cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    S.rider = j.rider && j.rider.exists ? j.rider : { exists: false }; S.roles = j.roles || [];
    S.profileState = 'ok';
  } catch (e) { S.profileState = 'error'; console.warn('[rider-hub] profile', e && e.message); }
  window.currentDriver = isRider() ? { id: S.rider.id || u.uid, ...S.rider } : null;   /* read by sokoni-gps / tracking modules */
  paintChrome(); render(S.view);
  loadApp();
  if (isRider()) {
    startJobListeners(); loadLedger(); loadWallet(); loadJobs(); loadCsat(); subscribeDispatch();
    /* Presence FIRST, then the board: polling before the server answered showed "Go online" to a rider who was
       already online, until the next 20 s tick. onPresenceChanged resumes heartbeat + GPS for an online rider. */
    await refreshPresence(); onPresenceChanged(); startBoard();
  }
  if (!allowed(S.view)) go(isRider() ? 'overview' : 'application');
}

/* presence — the SERVER's answer is the only state shown */
function applyPresence (res) {
  const st = (res && res.state) || 'offline';
  S.presence = ({ ineligible: 'not_eligible' })[st] || st; S.presenceAt = Date.now();
  rerender('overview', 'documents', 'available'); paintChrome();
  return S.presence;
}
async function presenceCall (action, loc) { const d = { action }; if (loc && num(loc.lat) !== null && num(loc.lng) !== null) { d.lat = loc.lat; d.lng = loc.lng; } return call('riderPresence', d); }
async function refreshPresence () { try { applyPresence(await presenceCall('status')); } catch (_) { S.presence = 'unknown'; paintChrome(); } }
async function toggleOnline () {
  if (!isRider()) return;
  const want = (S.presence === 'online' || S.presence === 'on_delivery') ? 'offline' : 'online';
  document.querySelectorAll('[data-act="toggle-online"]').forEach((b) => { b.disabled = true; });
  try {
    let loc = null;
    if (want === 'online' && window.SokoniGeo && window.SokoniGeo.getLocationAsync) { try { loc = await window.SokoniGeo.getLocationAsync({ timeout: 5000, enableHighAccuracy: true }); } catch (_) {} }
    if (loc) window._drvLastLoc = loc;
    applyPresence(await presenceCall(want, loc));
    /* users/{uid}.driverProfile.shiftStatus mirrors what the SERVER decided (kept from the old portal). */
    try { const { m, db } = await fs(); const u = uid(); if (db && u) await m.setDoc(m.doc(db, 'users', u), { driverProfile: { shiftStatus: (S.presence === 'online' || S.presence === 'on_delivery') ? 'online' : 'offline', lastShiftAt: m.serverTimestamp() }, updatedAt: m.serverTimestamp() }, { merge: true }).catch(() => {}); } catch (_) {}
  } catch (e) { toast('Could not change your status — check your connection and try again.', true); }
  finally { document.querySelectorAll('[data-act="toggle-online"]').forEach((b) => { b.disabled = false; }); }
  onPresenceChanged();
}
function onPresenceChanged () {
  const on = S.presence === 'online' || S.presence === 'on_delivery';
  if (on) {
    if (!_gps && window.currentDriver) { _gps = true; try { SokoniDB.startGPSTracking(window.currentDriver.id, (lat, lng) => { window._drvLastLoc = { lat, lng }; }); } catch (_) {} }
    if (!_heartbeat) _heartbeat = setInterval(() => { if (S.presence === 'online' || S.presence === 'on_delivery') presenceCall('heartbeat', window._drvLastLoc).then(applyPresence).catch(() => {}); }, 60000);
  } else {
    if (_heartbeat) { clearInterval(_heartbeat); _heartbeat = null; }
    if (_gps) { _gps = false; try { SokoniDB.stopGPSTracking(); } catch (_) {} }
  }
  pollBoard();
}

/* board */
function startBoard () { pollBoard(); if (_boardTimer) clearInterval(_boardTimer); _boardTimer = setInterval(() => { if (document.visibilityState !== 'hidden') pollBoard(); }, 20000); }
async function pollBoard () {
  if (!isRider()) return;
  if (!(S.presence === 'online' || S.presence === 'on_delivery')) { S.board = { state: 'offline', list: [], code: null }; rerender('available', 'overview', 'categories'); return; }
  if (S.board.state !== 'ok') { S.board.state = 'loading'; }
  let tok = null; try { tok = await window.firebaseAuth.currentUser.getIdToken(); } catch (_) {}
  if (!tok) { S.board = { state: 'signin', list: [], code: 401 }; rerender('available', 'overview'); return; }
  try {
    const r = await fetch('/api/available-deliveries?cb=' + Date.now(), { cache: 'no-store', headers: { Authorization: 'Bearer ' + tok } });
    if (r.status === 401) S.board = { state: 'signin', list: [], code: 401 };
    else if (r.status === 403) S.board = { state: 'refused', list: [], code: 403 };
    else if (r.status === 409) { let j = null; try { j = await r.json(); } catch (_) {} S.board = { state: 'offline', list: [], code: 409 }; applyPresence({ state: (j && j.state) || 'offline' }); }
    else { const j = r.ok ? await r.json() : null; S.board = (j && j.ok && Array.isArray(j.deliveries)) ? { state: 'ok', list: j.deliveries, code: 200 } : { state: 'error', list: [], code: r.status }; }
  } catch (_) { S.board = { state: 'error', list: [], code: null }; }
  rerender('available', 'overview', 'categories');
}
async function claim (ref, btn) {
  const orig = btn.textContent; btn.disabled = true; btn.textContent = 'Claiming…';
  try {
    const res = await call('claimAvailableDelivery', { deliveryRef: ref });
    if (res && res.ok) { toast('Delivery claimed. Collect the customer\'s PIN at handover.'); pollBoard(); go('drive'); return; }
    btn.disabled = false; btn.textContent = orig; toast('Could not claim — please try again.', true);
  } catch (e) {
    btn.disabled = false; btn.textContent = orig;
    const c = String((e && e.code) || '').replace(/^functions\//, '');
    toast(c === 'permission-denied' ? (e.message || 'Your rider account is not cleared yet.') : c === 'failed-precondition' ? (e.message || 'This delivery was just taken.') : c === 'unauthenticated' ? 'Please sign in again.' : (e && e.message) || 'Unable to claim this delivery.', true);
  }
}

/* assigned jobs (existing listeners) */
function startJobListeners () {
  _unsub.forEach((f) => { try { f(); } catch (_) {} }); _unsub = [];
  const u = uid(); if (!u) return;
  try { _unsub.push(SokoniDB.listenDriverDeliveryRequests(u, (list) => { S.pkgJob = list.length ? fromPkg(list[0]) : null; onJobsChanged(list.length && list[0].status === 'driver_assigned'); })); } catch (_) {}
  try { _unsub.push(SokoniDB.listenRiderActiveOrders(u, (list) => { S.orderJob = list.length ? fromOrder(list[0]) : null; onJobsChanged(list.length && list[0].status === 'rider_assigned'); })); } catch (_) {}
}
function onJobsChanged (isNew) { if (isNew) buzz([100, 50, 100]); rerender('drive', 'overview', 'map', 'messages'); paintChrome(); }
async function loadJobs () {
  const u = uid(); if (!u) return;
  S.jobs.state = 'loading'; rerender('deliveries', 'performance');
  try {
    const { m, db } = await fs();
    const [p, o] = await Promise.all([
      m.getDocs(m.query(m.collection(db, 'packageRequests'), m.where('assignedDriverId', '==', u), m.limit(150))),
      m.getDocs(m.query(m.collection(db, 'orders'), m.where('assignedDriverUid', '==', u), m.limit(150))),
    ]);
    S.jobs = { state: 'ok', pkgs: p.docs.map((d) => ({ _fsId: d.id, ...d.data() })), orders: o.docs.map((d) => ({ _fsId: d.id, id: d.id, ...d.data() })) };
  } catch (e) { S.jobs = { state: 'error', pkgs: [], orders: [] }; }
  rerender('deliveries', 'performance');
}
async function loadLedger () {
  const u = uid(); if (!u) return; S.ledger.state = 'loading';
  try { const { m, db } = await fs(); const s = await m.getDocs(m.query(m.collection(db, 'walletTransactions'), m.where('uid', '==', u), m.limit(300)));
    S.ledger = { state: 'ok', rows: s.docs.map((d) => d.data()).filter((t) => t.type === 'delivery_earning').sort((a, b) => (ms(b.createdAt) || 0) - (ms(a.createdAt) || 0)) };
  } catch (_) { S.ledger = { state: 'error', rows: [] }; }
  rerender('earnings', 'overview');
}
async function loadWallet () {
  const u = uid(); if (!u) return;
  try { const { m, db } = await fs(); const w = await m.getDoc(m.doc(db, 'wallets', u)); S.wallet = { state: 'ok', balance: w.exists() ? num(w.data().balance) : null }; } catch (_) { S.wallet = { state: 'error', balance: null }; }
  try { const { m, db } = await fs(); const s = await m.getDocs(m.query(m.collection(db, 'payouts'), m.where('entityId', '==', u), m.limit(50))); S.payouts = { state: 'ok', rows: s.docs.map((d) => d.data()).sort((a, b) => (ms(b.createdAt) || 0) - (ms(a.createdAt) || 0)) }; } catch (_) { S.payouts = { state: 'error', rows: [] }; }
  rerender('wallet', 'overview');
}
async function loadCsat () {
  const u = uid(); if (!u) return;
  try { const { m, db } = await fs(); const s = await m.getDocs(m.query(m.collection(db, 'csatRatings'), m.where('riderId', '==', u), m.limit(200))); const r = s.docs.map((d) => num(d.data().rating)).filter((x) => x && x > 0); S.csat = { state: 'ok', n: r.length, avg: r.length ? r.reduce((a, b) => a + b, 0) / r.length : null }; } catch (_) { S.csat = { state: 'error', n: 0, avg: null }; }
  rerender('performance');
}
async function loadFuel () {
  S.fuel.state = 'loading';
  try { const { m, db } = await fs(); m.onSnapshot(m.doc(db, 'sysConfig', 'fuelPrices'), (s) => { S.fuel = { state: 'ok', doc: s.exists() ? s.data() : null }; rerender('fuel'); }, () => { S.fuel = { state: 'ok', doc: null }; rerender('fuel'); }); } catch (_) { S.fuel = { state: 'ok', doc: null }; rerender('fuel'); }
}
async function loadApp () {
  const u = uid(); if (!u) { S.app = { state: 'ok', doc: null }; return; }
  S.app.state = 'loading';
  try { const { m, db } = await fs(); const s = await m.getDocs(m.query(m.collection(db, 'applications'), m.where('uid', '==', u), m.where('type', '==', 'driver'), m.limit(5)));
    const docs = s.docs.map((d) => d.data()).sort((a, b) => (ms(b.createdAt) || 0) - (ms(a.createdAt) || 0)); S.app = { state: 'ok', doc: docs[0] || null };
  } catch (_) { S.app = { state: 'error', doc: null }; }
  rerender('application', 'overview');
}
async function loadCats () { try { await import('./sokoni-delivery.js'); } catch (_) {} const c = window.SokoniDelivery && window.SokoniDelivery.CATEGORY_CONFIG; S.cats = c && typeof c === 'object' ? c : {}; rerender('categories', 'overview'); }

/* dispatch offers (existing dispatchQueue + respondToDispatch) */
function subscribeDispatch () {
  const u = uid(); if (!u) return;
  fs().then(({ m, db }) => {
    try { _unsub.push(m.onSnapshot(m.query(m.collection(db, 'dispatchQueue'), m.where('status', '==', 'offered')), (snap) => {
      snap.docChanges().forEach((ch) => { if (ch.type === 'removed') return; const q = ch.doc.data(); const c = q.rankedRiders && q.rankedRiders[q.currentIndex]; if (c && c.riderId === u) showOffer(ch.doc.id, c); });
    }, () => {})); } catch (_) {}
  }).catch(() => {});
}
function showOffer (ref, c) {
  document.getElementById('dhOffer')?.remove();
  const el = document.createElement('div'); el.className = 'offer'; el.id = 'dhOffer'; el.setAttribute('role', 'alertdialog'); el.setAttribute('aria-label', 'New delivery offer');
  el.innerHTML = `<b style="color:var(--acc)">New delivery offer</b><div class="dh-note">${num(c.distKm) !== null ? esc(c.distKm) + ' km away' : 'Distance —'}${num(c.etaMin) !== null ? ' · about ' + esc(c.etaMin) + ' min' : ''}</div>
    <div class="btn-row" style="margin-top:10px"><button class="btn pri" data-act="offer" data-ref="${esc(ref)}" data-accept="1">Accept</button><button class="btn danger" data-act="offer" data-ref="${esc(ref)}" data-accept="0">Decline</button></div>`;
  document.body.appendChild(el);
  buzz([100, 50, 100]);
}

/* ═══════════════════════════════ ACTIONS ═════════════════════════════════════════════════════ */
async function pkgUpdate (j, data, okMsg) {
  try { await SokoniDB.updatePackageRequest(j.dRef, data); if (okMsg) toast(okMsg); } catch (e) { toast('Could not update this delivery: ' + ((e && e.message) || 'try again'), true); }
}
async function ordStep (j, fn, okMsg) {
  try { const r = await SokoniOrders[fn](j.oId, uid()); if (r && r.ok === false) toast(r.error || 'Could not update this order.', true); else if (okMsg) toast(okMsg); } catch (e) { toast((e && e.message) || 'Could not update this order.', true); }
}
async function complete (j, btn) {
  const inp = document.getElementById('pin_' + idSafe(j.key)); const pin = String((inp && inp.value) || '').trim();
  if (!/^\d{4,8}$/.test(pin)) { toast('Enter the delivery PIN from the customer.', true); inp && inp.focus(); return; }
  const dRef = j.dRef; if (!dRef) { toast('No delivery record for this order — ask support to check it.', true); return; }
  /* shadow gate (kept from the old portal): records the server-verified would-decision; never gates, releases nothing */
  try { const l = window._drvLastLoc || {}; call('deliveryVerifyShadow', { deliveryRef: dRef, pin, stage: 'delivery', lat: num(l.lat), lng: num(l.lng), method: 'pin' }).catch(() => {}); } catch (_) {}
  btn.disabled = true; const o = btn.textContent; btn.textContent = 'Verifying…';
  try {
    const res = await call(j.parcel ? 'completeParcelWithPin' : 'completeDeliveryWithPin', { deliveryRef: dRef, pin });
    if (!res || !res.ok) { btn.disabled = false; btn.textContent = o; toast('Delivery could not be confirmed. Try again.', true); return; }
    toast(res.alreadyDelivered ? 'Already confirmed.' : 'Delivery confirmed by SOKONI. Your earning is credited to your wallet.');
    if (inp) inp.value = '';
    btn.textContent = 'Completed ✓';   /* stays disabled — the job leaves Rider Drive when its record updates */
    setTimeout(() => { loadLedger(); loadWallet(); loadJobs(); }, 2500);
  } catch (e) {
    btn.disabled = false; btn.textContent = o;
    /* A parcel completes only through sokoni-e3's completeParcelWithPin. If that function is not reachable the
       answer is "unavailable" — never a client-side fallback that marks the parcel delivered. */
    const c = String((e && e.code) || '').replace(/^functions\//, '');
    if (j.parcel && ['not-found', 'unavailable', 'internal', 'unimplemented'].includes(c)) { toast('Parcel completion is temporarily unavailable. Keep the parcel and try again shortly, or contact support.', true); return; }
    toast((e && (e.message || e.code)) || 'Delivery could not be confirmed.', true);
  }
}
const FAIL_REASONS = [
  ['customer_unavailable', 'Customer unavailable', 'SOKONI schedules a retry; after repeated attempts the package is returned.'],
  ['wrong_address', 'Wrong address', 'SOKONI starts a refund for the customer.'],
  ['rejected_order', 'Customer refused the order', 'SOKONI starts a refund for the customer.'],
  ['rider_breakdown', 'My vehicle broke down', 'The delivery is reassigned to another rider.'],
  ['seller_delay', 'Seller delay at pickup', 'SOKONI schedules a retry.'],
];
function problemModal (j) {
  const failable = j.kind === 'pkg' && j.dRef;
  modal(`<h2 id="dhModalTitle" style="margin:0 0 6px;font-size:18px">Report a problem</h2><p class="dh-note">${esc(j.label)}</p>
    ${failable ? `<div class="dh-sec-h"><h2>Delivery can't be completed</h2></div>${FAIL_REASONS.map(([k, l, d]) => `<button class="btn block" style="justify-content:flex-start;text-align:left;margin-bottom:8px;min-height:56px" data-act="fail" data-key="${esc(j.key)}" data-reason="${k}"><span><b>${l}</b><br><span class="dh-muted" style="font-size:12px;font-weight:600">${d}</span></span></button>`).join('')}` : ''}
    <div class="dh-sec-h"><h2>Something else</h2></div>
    <textarea class="inp" id="issueTxt" rows="3" style="width:100%;padding:10px" placeholder="Describe the issue (e.g. damaged package, can't reach the customer)" data-autofocus></textarea>
    <button class="btn block" style="margin-top:8px" data-act="issue" data-key="${esc(j.key)}">Send to SOKONI support</button>`);
}
/* The SERVER decides the outcome (handleFailedDelivery → SokoniDispatch.getFailedDeliveryAction): the rider
   picks only the reason. Before sending, the UI states SOKONI's published policy for that reason; after, it shows
   the decision the server actually returned — never a status the browser chose. */
const FAIL_DECISION = {
  retry: (n) => 'SOKONI scheduled a retry' + (n > 0 ? ` (${n} attempt${n === 1 ? '' : 's'} left)` : '') + '.',
  reassign: () => 'SOKONI is reassigning this delivery to another rider.',
  return: () => 'SOKONI started a return to the seller.',
  refund: () => 'SOKONI started a refund for the customer.',
  support: () => 'SOKONI support will review this delivery.',
};
async function fail (j, reason) {
  const r = FAIL_REASONS.find((x) => x[0] === reason); if (!r) return;
  if (!window.confirm(`${r[1]}?\n\nSOKONI's policy for this: ${r[2]}\n\nSOKONI records the attempt and makes the final decision.`)) return;
  try {
    const res = await call('handleFailedDelivery', { deliveryRef: j.dRef, reason, note: null });
    const fn = res && FAIL_DECISION[res.action];
    closeModal();
    if (fn) modal(`<h2 id="dhModalTitle" style="margin:0 0 6px;font-size:18px">Recorded</h2><p class="dh-note" style="font-size:14px">${esc(fn(Number(res.attemptsLeft) || 0))}</p><button class="btn pri block" style="margin-top:12px" data-autofocus data-act="close-modal">OK</button>`);
    else toast('Recorded. SOKONI will review this delivery.');
  } catch (e) { toast((e && e.message) || 'Could not record this — contact support.', true); }
}
async function issue (j) {
  const txt = String(($('#issueTxt') || {}).value || '').trim().slice(0, 500);
  if (!txt) { toast('Describe the issue first.', true); return; }
  /* driverNote is the rider-writable note field; deliveryIssue* is refused by the served rules (the old portal's
     report silently failed). */
  if (j.kind === 'pkg' && j.dRef) { await pkgUpdate(j, { driverNote: txt }, 'Issue noted on the delivery — SOKONI support can see it.'); closeModal(); return; }
  closeModal(); location.href = 'support.html?topic=delivery_issue&ref=' + encodeURIComponent(j.oId || '') + '&desc=' + encodeURIComponent(txt);
}

/* ═══════════════════════════════ WIRING ══════════════════════════════════════════════════════ */
document.addEventListener('click', (ev) => {
  const g = ev.target.closest('[data-go]'); if (g) { ev.preventDefault(); go(g.dataset.go); return; }
  const gh = ev.target.closest('.dh-grp-h'); if (gh) { const grp = gh.parentElement; const c = grp.dataset.collapsed === '1'; grp.dataset.collapsed = c ? '0' : '1'; gh.setAttribute('aria-expanded', String(c)); return; }
  const b = ev.target.closest('[data-act]'); if (!b) return;
  const a = b.dataset.act, j = b.dataset.key ? jobByKey(b.dataset.key) : null;
  switch (a) {
    case 'toggle-online': toggleOnline(); break;
    case 'board-refresh': pollBoard(); break;
    case 'claim': claim(b.dataset.ref, b); break;
    case 'nav': { const d = b.dataset.dest; if (!d) { toast('No destination location yet.', true); break; } window.open('https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(d) + '&travelmode=driving', '_blank', 'noopener'); break; }
    /* The served packageRequests rules let the ASSIGNED rider change only status / acceptedAt / arrivedAtSellerAt /
       pickedUpAt / driverNote (+ timeline/updatedAt). The old portal also wrote driverName and, on "Pass",
       assignedDriverId:null — both refused, so Accept and Pass failed silently. Only allowed fields are written now;
       a rider cannot unassign themselves (declining is the dispatch offer, or Report a problem → breakdown, which
       the SERVER reassigns). */
    case 'pkg-accept': if (j) pkgUpdate(j, { status: 'driver_accepted', acceptedAt: SokoniDB.serverTimestamp() }, 'Delivery accepted — head to the pickup.'); break;
    case 'pkg-at-seller': if (j) pkgUpdate(j, { status: 'driver_at_seller', arrivedAtSellerAt: new Date().toISOString() }); break;
    case 'pkg-picked': if (j) pkgUpdate(j, { status: 'in_transit', pickedUpAt: new Date().toISOString() }, 'Picked up — navigate to the customer.'); break;
    case 'ord-accept': if (j) ordStep(j, 'riderAccept', 'Delivery accepted — head to the pickup.'); break;
    case 'ord-pass': if (j) ordStep(j, 'riderReject', 'Passed.'); break;
    case 'ord-picked': if (j) ordStep(j, 'riderPickedUp', 'Package picked up.'); break;
    case 'ord-transit': if (j) ordStep(j, 'riderInTransit', 'On the way to the customer.'); break;
    case 'complete': if (j) complete(j, b); break;
    case 'problem': if (j) problemModal(j); break;
    case 'fail': if (j) fail(j, b.dataset.reason); break;
    case 'issue': if (j) issue(j); break;
    case 'offer': { const acc = b.dataset.accept === '1'; b.disabled = true; call('respondToDispatch', { deliveryRef: b.dataset.ref, accept: acc }).then(() => { document.getElementById('dhOffer')?.remove(); if (acc) { toast('Offer accepted.'); go('drive'); } }).catch((e) => { b.disabled = false; toast((e && e.message) || 'Could not respond to the offer.', true); }); break; }
    case 'hist-tab': S.histTab = b.dataset.tab; render('deliveries'); break;
    case 'cat-jobs': go('available'); setTimeout(() => { const s = $('#avCat'); if (s) { s.value = b.dataset.cat === 'general' ? 'parcel' : b.dataset.cat; s.onchange && s.onchange(); } }, 0); break;
    case 'fuel-refresh': b.disabled = true; call('triggerEPRAFuelFetch', {}).then((r) => toast(r && r.success ? 'EPRA prices updated.' : 'EPRA prices are still unavailable.', !(r && r.success))).catch(() => toast('Could not check EPRA right now.', true)).finally(() => { b.disabled = false; }); break;
    case 'reload-profile': loadProfile(); break;
    case 'reload-jobs': loadJobs(); break;
    case 'reload-ledger': loadLedger(); break;
    case 'reload-wallet': loadWallet(); break;
    case 'close-modal': closeModal(); break;
    case 'exit': try { SokoniDB.stopGPSTracking(); } catch (_) {} location.href = '/'; break;
    default: break;
  }
});
document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { if ($('#dhModal').classList.contains('on')) closeModal(); else drawer(false); } });
$('#dhMenuBtn').addEventListener('click', () => drawer(!$('#dhSide').classList.contains('open')));
$('#dhBnavMore').addEventListener('click', () => drawer(true));
$('#dhScrim').addEventListener('click', () => drawer(false));
$('#dhModalX').addEventListener('click', closeModal);
$('#dhModal').addEventListener('click', (ev) => { if (ev.target.id === 'dhModal') closeModal(); });
/* Both "#/earnings" (this hub) and "#earnings" (links already sent in rider emails — functions/email-templates.js)
   open the section; an unknown hash falls back to Overview. */
const hashView = () => { const v = (location.hash.match(/^#\/?(\w+)/) || [])[1]; return v && VIEWS[v] ? v : null; };
window.addEventListener('hashchange', () => { const v = hashView(); if (v && v !== S.view) go(v, false); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && isRider()) { refreshPresence(); pollBoard(); } });

/* boot */
(function boot () {
  let v = hashView();
  if (!v) { try { v = localStorage.getItem('dhLastView') || 'overview'; } catch (_) { v = 'overview'; } }
  S.view = VIEWS[v] ? v : 'overview';
  go(S.view, false); paintChrome();
  loadCats(); loadFuel(); loadProfile();
})();

/* test seam (scripts/test-delivery-hub.js) — exposes the pure pieces, never data or actions */
window.__SokoniRiderHub = { S, R, fromPkg, fromOrder, appState, ledgerSums, boardList, stageAction, esc, kes, applyPresence, go, allowed };
