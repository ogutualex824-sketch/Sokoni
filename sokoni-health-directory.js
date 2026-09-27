/* ═══════════════════════════════════════════════════════════════════════════
   sokoni-health-directory.js — the SOKONI Healthcare directory + My Health  (CHANGELOG 229)

   Renders ONLY what the server returns:
     · healthcareDirectory (functions/healthcare-directory.js) — canonical providers/{uid} that AdminOS
       approved and the server classified as healthcare; a public projection, no phone / email / licence.
     · getHealthRecords / getPrescriptions — the signed-in patient's OWN records (patient-only rules).
   There is no sample data, no fallback list and no local "booking": zero approved providers renders an
   honest empty state. Every link is built from a server-returned providerId — never a client-made id.
   Booking goes to the provider's canonical profile (SokoniBookService → bookingCreateService → IntaSend);
   contact goes to SOKONI messages. No WhatsApp, no tel: to a provider.
   ═══════════════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ICON = { clinician: '👩‍⚕️', facility: '🏥', pharmacy: '💊', laboratory: '🔬', telemedicine: '📱', home_care: '🏠' };
  const EMPTY_COPY = {
    '': 'No verified healthcare providers are listed on SOKONI yet.',
    clinician: 'No verified doctors or clinicians are currently available.',
    facility: 'No verified clinics, hospitals or facilities are currently available.',
    pharmacy: 'No verified pharmacies are currently available.',
    laboratory: 'No verified laboratories are currently available.',
    telemedicine: 'No verified telemedicine providers are currently available.',
    home_care: 'No verified home-care providers are currently available.',
  };
  /* `?tab=` deep links from the old page keep working, mapped onto the real categories. */
  const TAB_TO_CATEGORY = { specialists: 'clinician', teleconsult: 'telemedicine', labs: 'laboratory', pharmacy: 'pharmacy' };
  const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

  let state = { category: '', rows: null, query: '' };

  async function callable(name, data) {
    for (let i = 0; i < 80 && typeof root.sokoniCallable !== 'function'; i++) await new Promise((r) => setTimeout(r, 100));
    if (typeof root.sokoniCallable !== 'function') throw new Error('SOKONI is still loading. Please try again.');
    const r = await root.sokoniCallable(name)(data || {});
    return r && r.data;
  }
  const $ = (id) => document.getElementById(id);

  function setStatus(kind, message) {
    const box = $('hcDirState'); const grid = $('hcGrid');
    if (!box || !grid) return;
    box.dataset.state = kind;
    if (kind === 'ready') { box.hidden = true; box.innerHTML = ''; return; }
    box.hidden = false;
    if (kind === 'loading') { grid.innerHTML = ''; box.innerHTML = '<div class="hc-dir-skel" aria-busy="true" aria-live="polite">Loading verified providers…</div>'; return; }
    if (kind === 'error') {
      grid.innerHTML = '';
      box.innerHTML = `<p role="alert">We couldn't load the directory: ${esc(message)}</p><button type="button" class="hc-book-btn" data-hc-retry>Try again</button>`;
      return;
    }
    if (kind === 'empty') {
      grid.innerHTML = '';
      box.innerHTML = `<div style="font-size:44px;margin-bottom:10px" aria-hidden="true">🔍</div><p>${esc(message)}</p>
        <p class="hc-dir-sub">Providers appear here only after SOKONI has reviewed and approved them.</p>
        <button type="button" class="hc-book-btn" data-hc-register>Are you a provider? Apply to join</button>`;
    }
  }

  function card(p) {
    if (!p || !ID_RE.test(String(p.providerId || ''))) return '';      /* never render a link we cannot trust */
    const id = encodeURIComponent(p.providerId);
    const where = [p.area, p.city].filter(Boolean).join(', ');
    const rating = p.rating != null && p.reviewCount > 0
      ? `<div class="hc-card-rating"><span class="star" aria-hidden="true">⭐</span> ${esc(p.rating)} <span>(${esc(p.reviewCount)} review${p.reviewCount === 1 ? '' : 's'})</span></div>`
      : '<div class="hc-card-rating" style="opacity:.55">No reviews yet</div>';
    return `<article class="hc-card" data-provider-id="${esc(p.providerId)}">
      <div class="hc-card-head">
        <div class="hc-card-emoji" aria-hidden="true">${ICON[p.category] || '🏥'}</div>
        <div class="hc-card-meta">
          <h3 class="hc-card-name">${esc(p.name)}</h3>
          <span class="hc-card-type">${esc(p.categoryLabel)}</span>
          ${where ? `<div class="hc-card-location">📍 ${esc(where)}</div>` : ''}
        </div>
      </div>
      <div class="hc-card-body">
        ${p.description ? `<div class="hc-card-desc">${esc(p.description)}</div>` : ''}
        <div class="hc-card-footer">
          <div class="hc-card-info-row">${rating}</div>
          <div class="hc-card-actions">
            <a class="hc-book-btn" href="provider-profile.html?uid=${id}">${p.acceptsBookings ? '📅 View &amp; book' : '👁️ View profile'}</a>
            <a class="hc-book-btn hc-btn-alt" href="provider-profile.html?uid=${id}&amp;ask=1">💬 Ask a question</a>
          </div>
        </div>
      </div>
    </article>`;
  }

  function render() {
    const grid = $('hcGrid'); const label = $('hcResultLabel');
    if (!grid || !state.rows) return;
    const q = state.query.trim().toLowerCase();
    const rows = q ? state.rows.filter((p) => [p.name, p.categoryLabel, p.city, p.area, p.description].join(' ').toLowerCase().includes(q)) : state.rows;
    if (label) label.textContent = (state.category ? (rows[0] && rows[0].categoryLabel) || 'Providers' : 'Verified healthcare providers') + (rows.length ? ` · ${rows.length}` : '');
    if (!rows.length) { setStatus('empty', q ? 'No verified provider matches your search.' : EMPTY_COPY[state.category] || EMPTY_COPY['']); return; }
    setStatus('ready');
    grid.innerHTML = rows.map(card).join('');
  }

  async function load(category) {
    state.category = category || '';
    state.rows = null;
    document.querySelectorAll('[data-hc-cat]').forEach((b) => {
      const on = (b.dataset.hcCat || '') === state.category;
      b.classList.toggle('active', on); b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    setStatus('loading');
    try {
      const r = await callable('healthcareDirectory', { category: state.category || null, limit: 60 });
      state.rows = Array.isArray(r && r.providers) ? r.providers : [];
      render();
    } catch (e) {
      setStatus('error', (e && e.message) || 'Something went wrong.');
    }
  }

  /* ── My Health: the patient's OWN server records, and bookings on the canonical page ── */
  async function loadMyHealth() {
    const box = $('hcMyRecords'); if (!box) return;
    const signedIn = !!(root.firebaseAuth && root.firebaseAuth.currentUser);
    if (!signedIn) {
      box.innerHTML = '<p>Sign in to see your health records and prescriptions.</p><a class="hc-book-btn" href="login.html?redirect=' + encodeURIComponent('/healthcare.html?tab=myhealth') + '">Sign in</a>';
      return;
    }
    box.innerHTML = '<div class="hc-dir-skel" aria-busy="true">Loading your records…</div>';
    try {
      const [rec, rx] = await Promise.all([callable('getHealthRecords', { limit: 20 }), callable('getPrescriptions', {})]);
      const records = (rec && rec.records) || []; const pres = (rx && rx.prescriptions) || [];
      const when = (v) => { const t = v && (v._seconds || v.seconds) ? (v._seconds || v.seconds) * 1000 : Date.parse(v); return Number.isFinite(t) ? new Date(t).toLocaleDateString('en-KE') : ''; };
      box.innerHTML =
        '<h3 class="hc-section-h">🩺 My health records</h3>' +
        (records.length ? records.map((r) => `<div class="hc-record-card"><strong>${esc(r.providerName || 'Provider')}</strong> · ${esc(when(r.createdAt))}<div>${esc(r.diagnosis)}</div>${r.treatment ? `<div class="hc-dir-sub">${esc(r.treatment)}</div>` : ''}</div>`).join('')
          : '<p class="hc-dir-sub">No health records yet. A provider adds a record after a confirmed, paid consultation with you.</p>') +
        '<h3 class="hc-section-h">💊 My prescriptions</h3>' +
        (pres.length ? pres.map((p) => `<div class="hc-record-card"><strong>${esc(p.providerName || 'Provider')}</strong> · ${esc(when(p.createdAt))}<div>${(p.medications || []).map((m) => esc([m.name, m.dosage, m.frequency, m.duration].filter(Boolean).join(' · '))).join('<br>')}</div></div>`).join('')
          : '<p class="hc-dir-sub">No prescriptions yet.</p>');
    } catch (e) {
      box.innerHTML = `<p role="alert">We couldn't load your records: ${esc((e && e.message) || 'error')}</p><button type="button" class="hc-book-btn" data-hc-records-retry>Try again</button>`;
    }
  }

  function showTab(tab) {
    const panelTab = TAB_TO_CATEGORY[tab] ? 'findcare' : (['findcare', 'myhealth', 'providers'].includes(tab) ? tab : 'findcare');
    document.querySelectorAll('.hc-tab-panel').forEach((p) => p.classList.toggle('active', p.id === 'hctabpanel-' + panelTab));
    document.querySelectorAll('[data-hc-tab]').forEach((b) => { const on = b.dataset.hcTab === panelTab; b.classList.toggle('active', on); b.setAttribute('aria-selected', on ? 'true' : 'false'); });
    if (panelTab === 'findcare') load(TAB_TO_CATEGORY[tab] || state.category);
    if (panelTab === 'myhealth') loadMyHealth();
  }

  function openRegister() {
    if (root.HubRegister && typeof root.HubRegister.open === 'function') root.HubRegister.open({ hub: 'healthcare' });
    else location.href = 'onboarding-professional.html';
  }

  function init() {
    document.addEventListener('click', (ev) => {
      const t = ev.target.closest('[data-hc-cat],[data-hc-tab],[data-hc-retry],[data-hc-records-retry],[data-hc-register]');
      if (!t) return;
      if (t.hasAttribute('data-hc-cat')) { ev.preventDefault(); load(t.dataset.hcCat || ''); }
      else if (t.hasAttribute('data-hc-tab')) { ev.preventDefault(); showTab(t.dataset.hcTab); }
      else if (t.hasAttribute('data-hc-retry')) load(state.category);
      else if (t.hasAttribute('data-hc-records-retry')) loadMyHealth();
      else if (t.hasAttribute('data-hc-register')) openRegister();
    });
    const s = $('hcSearch');
    if (s) s.addEventListener('input', () => { state.query = s.value || ''; render(); });
    const tab = new URLSearchParams(location.search).get('tab') || 'findcare';
    showTab(tab);
  }

  root.SokoniHealthDirectory = { load, loadMyHealth, showTab, card, _state: () => state };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
}(typeof window !== 'undefined' ? window : globalThis));
