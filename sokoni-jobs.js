/* ================================================================
   SOKONI Jobs Marketplace — Client Engine  v1.0
   sokoni-jobs.js

   IIFE exposing window.SokoniJobs

   Requires:
     • Firebase JS SDK (compat v9)  loaded via /__/firebase/init.js
     • Cloud Functions defined in functions/jobs.js (Gen2, onCall)

   Public surface:
     SokoniJobs.initPublic()     — jobs.html bootstrap
     SokoniJobs.initEmployer()   — job-post.html bootstrap

   Security:
     • All user-supplied text rendered through _esc() before innerHTML
     • CV URLs validated as https:// before display
     • Auth state via Firebase onAuthStateChanged — never trust client uid
================================================================ */
'use strict';

window.SokoniJobs = (() => {

  // ─── Shared state ───────────────────────────────────────────────────────────

  let _uid             = null;
  let _user            = null;
  let _currentJobId    = null;
  let _allJobs         = [];
  let _activeCategory  = 'all';
  let _activeType      = 'all';
  let _myApplications  = [];
  let _myJobs          = [];
  let _page            = 0;
  let _hasMore         = false;
  let _searchKeyword   = '';
  let _searchLocation  = '';
  let _sortMode        = 'latest'; // 'latest' | 'salary'
  let _callableCache   = {};

  // ─── Constants ──────────────────────────────────────────────────────────────

  const CATEGORIES = [
    'technology','finance','healthcare','retail','logistics',
    'education','hospitality','marketing','legal','engineering','admin','other',
  ];

  const CAT_ICONS = {
    technology:'💻', finance:'💰', healthcare:'🏥', retail:'🛒',
    logistics:'🚚', education:'📚', hospitality:'🍽️', marketing:'📣',
    legal:'⚖️', engineering:'⚙️', admin:'📋', other:'💼',
  };

  const JOB_TYPES = ['full-time','part-time','contract','internship','remote'];

  const TYPE_LABELS = {
    'full-time':'Full-time','part-time':'Part-time',
    'contract':'Contract','internship':'Internship','remote':'Remote',
  };

  const STATUS_COLORS = {
    pending:'#ff9800', reviewing:'#2196f3', shortlisted:'#7c4dff',
    rejected:'#f44336', hired:'#4caf50',
  };

  const STATUS_LABELS = {
    pending:'Pending', reviewing:'Reviewing', shortlisted:'Shortlisted',
    rejected:'Rejected', hired:'Hired',
  };

  // ─── Utility helpers ────────────────────────────────────────────────────────

  /** XSS-safe escaping — MUST wrap every user-supplied value before innerHTML */
  function _esc(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /** Format numbers KE-locale, e.g. 50000 → "50,000" */
  function _fmtN(n) {
    if (n == null || isNaN(Number(n))) return '0';
    return Number(n).toLocaleString('en-KE');
  }

  /** Human-friendly relative time */
  function _timeAgo(ts) {
    let ms;
    if (!ts) return '';
    if (ts && typeof ts.toMillis === 'function') ms = ts.toMillis();
    else if (ts && ts.seconds) ms = ts.seconds * 1000;
    else ms = Number(ts);
    const diff = Date.now() - ms;
    if (diff < 60000)       return 'just now';
    if (diff < 3600000)     return `${Math.floor(diff/60000)}m ago`;
    if (diff < 86400000)    return `${Math.floor(diff/3600000)}h ago`;
    if (diff < 2592000000)  return `${Math.floor(diff/86400000)}d ago`;
    return new Date(ms).toLocaleDateString('en-KE',{month:'short',day:'numeric',year:'numeric'});
  }

  /** Sanitise and validate a URL — only https:// allowed */
  function _safeUrl(url) {
    if (!url) return '';
    const trimmed = String(url).trim();
    try {
      const u = new URL(trimmed);
      if (u.protocol !== 'https:') return '';
      return trimmed;
    } catch(_) { return ''; }
  }

  let _sdDispatch = null;
  function _callable(name) {
    if (!_sdDispatch) _sdDispatch = firebase.functions().httpsCallable('servicesDispatch');
    return (data) => _sdDispatch(Object.assign({ op: name }, data || {}));
  }

  /** Capitalise first letter */
  function _cap(s) {
    if (!s) return '';
    return String(s).charAt(0).toUpperCase() + String(s).slice(1);
  }

  // ─── Toast notifications ─────────────────────────────────────────────────────

  let _toastContainer = null;

  function toast(msg, type = 'info', duration = 4000) {
    if (!_toastContainer) {
      _toastContainer = document.getElementById('jobsToasts')
        || document.getElementById('jpToasts');
    }
    if (!_toastContainer) return;

    const colors = { info:'#2196f3', success:'#4caf50', error:'#f44336', warn:'#ff9800' };
    const icons  = { info:'ℹ️', success:'✅', error:'❌', warn:'⚠️' };

    const el = document.createElement('div');
    el.style.cssText = `
      background:${colors[type]||colors.info};color:#fff;
      padding:12px 16px;border-radius:10px;font-size:14px;font-weight:500;
      display:flex;align-items:center;gap:8px;box-shadow:0 4px 16px rgba(0,0,0,.2);
      animation:toastIn .25s ease;pointer-events:auto;max-width:380px;
    `;
    el.innerHTML = `<span>${icons[type]||''}</span><span>${_esc(msg)}</span>`;
    _toastContainer.appendChild(el);

    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transform = 'translateY(-8px)';
      el.style.transition = 'all .3s';
      setTimeout(() => el.remove(), 300);
    }, duration);
  }

  // ─── Auth state ──────────────────────────────────────────────────────────────

  function _watchAuth(onLogin, onLogout) {
    firebase.auth().onAuthStateChanged(user => {
      _uid  = user ? user.uid : null;
      _user = user || null;
      if (user) onLogin(user);
      else onLogout();
    });
  }

  // ─── Render: Job card (public grid) ─────────────────────────────────────────

  function _renderJobCard(job) {
    const initial    = _esc((job.companyName || 'C')[0].toUpperCase());
    const title      = _esc(job.title || '');
    const company    = _esc(job.companyName || '');
    const location   = _esc(job.location || 'Kenya');
    const type       = _esc(job.type || '');
    const typeLabel  = _esc(TYPE_LABELS[job.type] || _cap(job.type));
    const apps       = Number(job.applicationCount || 0);
    const timeStr    = _timeAgo(job.postedAt);
    const jobId      = _esc(job.jobId || job.id || '');

    const salaryHtml = (job.salaryMin != null)
      ? `<div class="job-salary">KSh ${_fmtN(job.salaryMin)}${job.salaryMax ? ' – ' + _fmtN(job.salaryMax) : '+'} /mo</div>`
      : '';

    const featuredBadge = job.featured
      ? `<span class="job-featured-badge">★ Featured</span>`
      : '';

    return `
      <article class="job-card" onclick="SokoniJobs.openJobDetail('${jobId}')" tabindex="0"
               onkeydown="if(event.key==='Enter'||event.key===' ')SokoniJobs.openJobDetail('${jobId}')">
        <div class="job-card-header">
          <div class="job-avatar" aria-hidden="true">${initial}</div>
          <div class="job-card-titles">
            <div class="job-title">${title}</div>
            <div class="job-company">${company}</div>
          </div>
          ${featuredBadge}
        </div>
        <div class="job-meta">
          <span class="job-meta-item">📍 ${location}</span>
          <span class="job-type-badge job-type-${_esc(type)}">${typeLabel}</span>
        </div>
        ${salaryHtml}
        <div class="job-footer">
          <span class="job-apps">${_esc(String(apps))} applied</span>
          <span class="job-date">${_esc(timeStr)}</span>
        </div>
      </article>`;
  }

  // ─── Render: Featured card (compact horizontal) ───────────────────────────────

  function _renderFeaturedCard(job) {
    const initial   = _esc((job.companyName || 'C')[0].toUpperCase());
    const title     = _esc(job.title || '');
    const company   = _esc(job.companyName || '');
    const location  = _esc(job.location || 'Kenya');
    const typeLabel = _esc(TYPE_LABELS[job.type] || _cap(job.type));
    const jobId     = _esc(job.jobId || job.id || '');

    return `
      <article class="featured-card" onclick="SokoniJobs.openJobDetail('${jobId}')" tabindex="0"
               onkeydown="if(event.key==='Enter'||event.key===' ')SokoniJobs.openJobDetail('${jobId}')">
        <div class="featured-card-header">
          <div class="job-avatar featured-avatar" aria-hidden="true">${initial}</div>
          <div>
            <div class="featured-title">${title}</div>
            <div class="featured-company">${company}</div>
          </div>
        </div>
        <div class="featured-meta">
          <span>📍 ${location}</span>
          <span class="job-type-badge job-type-${_esc(job.type||'')}">${typeLabel}</span>
        </div>
        <div class="featured-cta">View Job →</div>
      </article>`;
  }

  // ─── PUBLIC PAGE ─────────────────────────────────────────────────────────────

  async function initPublic() {
    _buildCategoryChips();
    _buildTypeChips();
    _wirePublicEvents();

    await Promise.all([
      loadFeaturedJobs(),
      loadJobs(true),
    ]);

    _watchAuth(
      user => {
        _updateAuthUI(user);
        loadSeekerProfile();
        openMyApps._preloaded = false;
      },
      () => {
        _updateAuthUI(null);
        _hideSeekerPanel();
      }
    );
  }

  function _buildCategoryChips() {
    const container = document.getElementById('jobsCategoryFilters');
    if (!container) return;

    const chips = [
      `<button class="filter-chip active" data-cat="all" onclick="SokoniJobs.filterCategory('all')">All</button>`,
      ...CATEGORIES.map(c =>
        `<button class="filter-chip" data-cat="${_esc(c)}" onclick="SokoniJobs.filterCategory('${_esc(c)}')">
           ${CAT_ICONS[c] || ''} ${_esc(_cap(c))}
         </button>`
      ),
    ];
    container.innerHTML = chips.join('');
  }

  function _buildTypeChips() {
    const container = document.getElementById('jobsTypeFilters');
    if (!container) return;

    const chips = [
      `<button class="filter-chip type-chip active" data-type="all" onclick="SokoniJobs.filterType('all')">All Types</button>`,
      ...JOB_TYPES.map(t =>
        `<button class="filter-chip type-chip" data-type="${_esc(t)}" onclick="SokoniJobs.filterType('${_esc(t)}')">
           ${_esc(TYPE_LABELS[t] || _cap(t))}
         </button>`
      ),
    ];
    container.innerHTML = chips.join('');
  }

  function _wirePublicEvents() {
    const searchInput    = document.getElementById('jobsSearch');
    const locationInput  = document.getElementById('jobsLocation');
    const loadMoreBtn    = document.getElementById('jobsLoadMore');
    const seekerForm     = document.getElementById('jobSeekerForm');
    const applyForm      = document.getElementById('jobApplyForm');
    const modalOverlay   = document.getElementById('jobDetailModal');
    const myAppsPanel    = document.getElementById('myAppsPanel');

    if (searchInput) {
      searchInput.addEventListener('keydown', e => { if (e.key === 'Enter') searchJobs(); });
    }
    if (locationInput) {
      locationInput.addEventListener('keydown', e => { if (e.key === 'Enter') searchJobs(); });
    }
    if (loadMoreBtn) {
      loadMoreBtn.addEventListener('click', () => loadJobs(false));
    }
    if (seekerForm) {
      seekerForm.addEventListener('submit', e => { e.preventDefault(); saveSeekerProfile(); });
    }
    if (applyForm) {
      applyForm.addEventListener('submit', e => { e.preventDefault(); submitApplication(); });
    }
    if (modalOverlay) {
      modalOverlay.addEventListener('click', e => {
        if (e.target === modalOverlay) closeModal();
      });
    }
    if (myAppsPanel) {
      myAppsPanel.addEventListener('click', e => {
        if (e.target === myAppsPanel) closeMyApps();
      });
    }

    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') { closeModal(); closeMyApps(); }
    });
  }

  function _updateAuthUI(user) {
    const seekerSection = document.getElementById('jobSeekerForm');
    const myAppsBtn     = document.querySelector('[data-my-apps]');
    const loginPrompts  = document.querySelectorAll('[data-login-prompt]');

    if (user) {
      if (seekerSection) seekerSection.closest('.seeker-section')?.classList.remove('hidden');
      if (myAppsBtn) myAppsBtn.classList.remove('hidden');
      loginPrompts.forEach(el => el.classList.add('hidden'));
    } else {
      if (seekerSection) seekerSection.closest('.seeker-section')?.classList.add('hidden');
      if (myAppsBtn) myAppsBtn.classList.add('hidden');
      loginPrompts.forEach(el => el.classList.remove('hidden'));
    }
  }

  function _hideSeekerPanel() {
    const el = document.getElementById('jobSeekerForm');
    if (el) el.closest('.seeker-section')?.classList.add('hidden');
  }

  // ─── Load jobs ───────────────────────────────────────────────────────────────

  async function loadFeaturedJobs() {
    const container = document.getElementById('jobsFeaturedList');
    if (!container) return;

    try {
      const fn   = _callable('getFeaturedJobs');
      const res  = await fn({});
      const jobs = (res.data && res.data.jobs) || [];

      if (jobs.length === 0) {
        container.closest('.featured-strip')?.classList.add('hidden');
        return;
      }
      container.innerHTML = jobs.map(_renderFeaturedCard).join('');
    } catch (err) {
      console.warn('[SokoniJobs] Featured jobs load failed:', err.message);
      container.closest('.featured-strip')?.classList.add('hidden');
    }
  }

  async function loadJobs(reset = false) {
    if (reset) {
      _page    = 0;
      _allJobs = [];
    }

    const countEl   = document.getElementById('jobsResultsCount');
    const listEl    = document.getElementById('jobsResultsList');
    const loadMoreEl = document.getElementById('jobsLoadMore');

    if (listEl && reset) {
      listEl.innerHTML = '<div class="jobs-loading">Loading jobs…</div>';
    }

    try {
      const fn  = _callable('listJobs');
      const res = await fn({
        category: _activeCategory === 'all' ? undefined : _activeCategory,
        type:     _activeType     === 'all' ? undefined : _activeType,
        location: _searchLocation || undefined,
        page:     _page,
      });

      const data = res.data || {};
      let jobs   = data.jobs || [];

      // Client-side keyword filter (CF does not support full-text)
      if (_searchKeyword) {
        const kw = _searchKeyword.toLowerCase();
        jobs = jobs.filter(j =>
          (j.title       || '').toLowerCase().includes(kw) ||
          (j.companyName || '').toLowerCase().includes(kw) ||
          (j.category    || '').toLowerCase().includes(kw)
        );
      }

      // Client-side sort
      if (_sortMode === 'salary') {
        jobs.sort((a, b) => (b.salaryMax || b.salaryMin || 0) - (a.salaryMax || a.salaryMin || 0));
      }

      if (reset) {
        _allJobs = jobs;
      } else {
        _allJobs = [..._allJobs, ...jobs];
      }

      _hasMore = data.hasMore && !_searchKeyword;
      _page++;

      if (countEl) {
        countEl.textContent = `${data.total || _allJobs.length} jobs found`;
      }

      if (listEl) {
        if (_allJobs.length === 0) {
          listEl.innerHTML = `
            <div class="empty-state">
              <div class="empty-icon">🔍</div>
              <div class="empty-title">No jobs found</div>
              <div class="empty-sub">Try different filters or check back later.</div>
            </div>`;
        } else {
          listEl.innerHTML = _allJobs.map(_renderJobCard).join('');
        }
      }

      if (loadMoreEl) {
        loadMoreEl.style.display = _hasMore ? 'block' : 'none';
      }

    } catch (err) {
      console.error('[SokoniJobs] loadJobs error:', err);
      if (listEl && reset) {
        listEl.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><div class="empty-title">Could not load jobs</div><div class="empty-sub">${_esc(err.message)}</div></div>`;
      }
      toast('Failed to load jobs. Please try again.', 'error');
    }
  }

  function filterCategory(cat) {
    _activeCategory = cat || 'all';
    document.querySelectorAll('[data-cat]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.cat === _activeCategory);
    });
    loadJobs(true);
  }

  function filterType(type) {
    _activeType = type || 'all';
    document.querySelectorAll('[data-type]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.type === _activeType);
    });
    loadJobs(true);
  }

  function searchJobs() {
    _searchKeyword  = (document.getElementById('jobsSearch')?.value  || '').trim();
    _searchLocation = (document.getElementById('jobsLocation')?.value || '').trim();
    loadJobs(true);
  }

  function setSortMode(mode) {
    _sortMode = mode || 'latest';
    loadJobs(true);
  }

  // ─── Job detail modal ────────────────────────────────────────────────────────

  async function openJobDetail(jobId) {
    if (!jobId) return;
    _currentJobId = jobId;

    const modal        = document.getElementById('jobDetailModal');
    const contentEl    = document.getElementById('jobDetailContent');
    const applySection = document.getElementById('jobApplySection');

    if (!modal || !contentEl) return;

    // Reset apply section
    if (applySection) applySection.style.display = 'none';

    contentEl.innerHTML = '<div class="modal-loading">Loading…</div>';
    modal.style.display = 'flex';
    document.body.style.overflow = 'hidden';

    try {
      const fn  = _callable('getJob');
      const res = await fn({ jobId });
      const job = (res.data && res.data.job) || null;

      if (!job) {
        contentEl.innerHTML = '<p class="modal-error">Job not found.</p>';
        return;
      }

      const hasApplied = !!(res.data && res.data.hasApplied);
      _renderJobDetail(job, hasApplied);

    } catch (err) {
      console.error('[SokoniJobs] getJob error:', err);
      contentEl.innerHTML = `<p class="modal-error">Could not load job details. ${_esc(err.message)}</p>`;
    }
  }

  function _renderJobDetail(job, hasApplied) {
    const contentEl = document.getElementById('jobDetailContent');
    const applyBtn  = document.getElementById('jobApplyBtn');

    const salary = job.salaryMin != null
      ? `KSh ${_fmtN(job.salaryMin)}${job.salaryMax ? ' – ' + _fmtN(job.salaryMax) : '+'} /mo`
      : 'Competitive';

    const typeLabel  = TYPE_LABELS[job.type] || _cap(job.type || '');
    const catLabel   = `${CAT_ICONS[job.category] || ''} ${_cap(job.category || '')}`;

    const descHtml   = _esc(job.description  || '').replace(/\n/g, '<br>');
    const reqHtml    = _esc(job.requirements || '').replace(/\n/g, '<br>');

    contentEl.innerHTML = `
      <div class="job-detail-hero">
        <div class="job-detail-avatar">${_esc((job.companyName||'C')[0].toUpperCase())}</div>
        <div class="job-detail-heading">
          <h2 class="job-detail-title">${_esc(job.title)}</h2>
          <div class="job-detail-company">${_esc(job.companyName || '')}</div>
        </div>
        ${job.featured ? '<span class="job-featured-badge">★ Featured</span>' : ''}
      </div>

      <div class="job-detail-meta-grid">
        <div class="job-detail-meta-item"><span class="meta-icon">📍</span>${_esc(job.location || 'Kenya')}</div>
        <div class="job-detail-meta-item"><span class="meta-icon">💼</span>${_esc(typeLabel)}</div>
        <div class="job-detail-meta-item"><span class="meta-icon">🏷️</span>${catLabel}</div>
        <div class="job-detail-meta-item"><span class="meta-icon">💰</span>${_esc(salary)}</div>
        <div class="job-detail-meta-item"><span class="meta-icon">👥</span>${_esc(String(job.applicationCount || 0))} applicants</div>
        <div class="job-detail-meta-item"><span class="meta-icon">🕒</span>${_esc(_timeAgo(job.postedAt))}</div>
      </div>

      <section class="job-detail-section">
        <h3 class="job-detail-section-title">About this Role</h3>
        <div class="job-detail-body">${descHtml}</div>
      </section>

      ${job.requirements ? `
      <section class="job-detail-section">
        <h3 class="job-detail-section-title">Requirements</h3>
        <div class="job-detail-body">${reqHtml}</div>
      </section>` : ''}
    `;

    // Apply button state
    if (applyBtn) {
      if (hasApplied) {
        applyBtn.textContent = '✅ Applied';
        applyBtn.disabled    = true;
        applyBtn.classList.add('applied');
      } else {
        applyBtn.textContent = 'Apply Now';
        applyBtn.disabled    = false;
        applyBtn.classList.remove('applied');
        applyBtn.onclick = () => openApplyForm(job.jobId || _currentJobId);
      }
    }
  }

  function closeModal() {
    const modal = document.getElementById('jobDetailModal');
    if (modal) modal.style.display = 'none';
    document.body.style.overflow = '';
    _currentJobId = null;
    const applySection = document.getElementById('jobApplySection');
    if (applySection) applySection.style.display = 'none';
  }

  // ─── Apply form ──────────────────────────────────────────────────────────────

  function openApplyForm(jobId) {
    if (!_uid) {
      toast('Please sign in to apply for jobs.', 'warn');
      setTimeout(() => { window.location.href = 'login.html?return=' + encodeURIComponent(window.location.pathname); }, 1200);
      return;
    }

    _currentJobId = jobId || _currentJobId;
    const section = document.getElementById('jobApplySection');
    if (section) {
      section.style.display = 'block';
      section.scrollIntoView({ behavior:'smooth', block:'start' });
    }

    // Reset form
    const coverEl = document.getElementById('jobCoverLetter');
    const cvEl    = document.getElementById('jobCvUrl');
    if (coverEl) coverEl.value = '';
    if (cvEl)    cvEl.value   = '';
  }

  async function submitApplication() {
    if (!_uid) {
      toast('Please sign in to apply.', 'warn');
      return;
    }

    const coverEl  = document.getElementById('jobCoverLetter');
    const cvEl     = document.getElementById('jobCvUrl');
    const submitEl = document.getElementById('jobApplyBtn');

    const coverLetter = (coverEl?.value || '').trim();
    const cvUrl       = (cvEl?.value   || '').trim();

    if (coverLetter.length < 20) {
      toast('Your cover letter must be at least 20 characters.', 'warn');
      coverEl?.focus();
      return;
    }
    if (coverLetter.length > 2000) {
      toast('Cover letter must be under 2000 characters.', 'warn');
      return;
    }
    if (cvUrl && !_safeUrl(cvUrl)) {
      toast('CV URL must start with https://', 'warn');
      cvEl?.focus();
      return;
    }

    if (submitEl) {
      submitEl.disabled    = true;
      submitEl.textContent = 'Submitting…';
    }

    try {
      const fn  = _callable('applyForJob');
      const res = await fn({
        jobId:       _currentJobId,
        coverLetter,
        cvUrl:       cvUrl || null,
      });

      if (res.data && res.data.alreadyApplied) {
        toast('You have already applied for this job.', 'info');
      } else {
        toast('Application submitted! Good luck 🎉', 'success');
        if (submitEl) {
          submitEl.textContent = '✅ Applied';
          submitEl.classList.add('applied');
        }
        const section = document.getElementById('jobApplySection');
        if (section) section.style.display = 'none';
      }
    } catch (err) {
      console.error('[SokoniJobs] applyForJob error:', err);
      toast(err.message || 'Failed to submit application.', 'error');
      if (submitEl) {
        submitEl.disabled    = false;
        submitEl.textContent = 'Apply Now';
      }
    }
  }

  // ─── My Applications panel ───────────────────────────────────────────────────

  async function openMyApps() {
    if (!_uid) {
      toast('Please sign in to view your applications.', 'warn');
      return;
    }

    const panel = document.getElementById('myAppsPanel');
    if (panel) {
      panel.style.transform = 'translateX(0)';
      panel.setAttribute('aria-hidden', 'false');
    }
    document.body.style.overflow = 'hidden';

    await _loadMyApplications();
  }

  function closeMyApps() {
    const panel = document.getElementById('myAppsPanel');
    if (panel) {
      panel.style.transform = 'translateX(100%)';
      panel.setAttribute('aria-hidden', 'true');
    }
    document.body.style.overflow = '';
  }

  async function _loadMyApplications() {
    const listEl = document.getElementById('myAppsList');
    if (!listEl) return;

    listEl.innerHTML = '<div class="apps-loading">Loading your applications…</div>';

    try {
      const fn  = _callable('getMyApplications');
      const res = await fn({});
      const apps = (res.data && res.data.applications) || [];
      _myApplications = apps;

      if (apps.length === 0) {
        listEl.innerHTML = `
          <div class="empty-state-sm">
            <div class="empty-icon">📭</div>
            <div>You haven't applied to any jobs yet.</div>
            <div class="empty-sub">Browse jobs and hit Apply Now!</div>
          </div>`;
        return;
      }

      listEl.innerHTML = apps.map(app => {
        const job       = app.job || {};
        const statusCol = STATUS_COLORS[app.status] || '#6b7280';
        const statusLbl = STATUS_LABELS[app.status]  || _cap(app.status || 'pending');

        return `
          <div class="my-app-card">
            <div class="my-app-header">
              <div class="my-app-avatar">${_esc((job.companyName||'C')[0].toUpperCase())}</div>
              <div class="my-app-info">
                <div class="my-app-title">${_esc(job.title || 'Unknown Job')}</div>
                <div class="my-app-company">${_esc(job.companyName || '')}</div>
                <div class="my-app-loc">${_esc(job.location || '')}</div>
              </div>
            </div>
            <div class="my-app-footer">
              <span class="status-badge" style="background:${statusCol}20;color:${statusCol};border:1px solid ${statusCol}40">
                ${_esc(statusLbl)}
              </span>
              <span class="my-app-date">${_esc(_timeAgo(app.appliedAt))}</span>
            </div>
          </div>`;
      }).join('');

    } catch (err) {
      console.error('[SokoniJobs] getMyApplications error:', err);
      listEl.innerHTML = `<div class="apps-error">Could not load applications. ${_esc(err.message)}</div>`;
    }
  }

  // ─── Seeker profile ──────────────────────────────────────────────────────────

  async function loadSeekerProfile() {
    if (!_uid) return;

    try {
      const fn  = _callable('getJobSeekerProfile');
      const res = await fn({});
      const p   = (res.data && res.data.profile) || null;

      if (!p) return;

      const fields = {
        seekerName:         p.name         || '',
        seekerHeadline:     p.headline     || '',
        seekerSkills:       (p.skills || []).join(', '),
        seekerBio:          p.bio          || '',
        seekerCvUrl:        p.cvUrl        || '',
        seekerLocation:     p.location     || '',
        seekerAvailability: p.availability || '',
      };

      for (const [id, val] of Object.entries(fields)) {
        const el = document.getElementById(id);
        if (el) el.value = val;
      }
    } catch (err) {
      console.warn('[SokoniJobs] loadSeekerProfile failed:', err.message);
    }
  }

  async function saveSeekerProfile() {
    if (!_uid) {
      toast('Please sign in to save your profile.', 'warn');
      return;
    }

    const name         = (document.getElementById('seekerName')?.value         || '').trim();
    const headline     = (document.getElementById('seekerHeadline')?.value     || '').trim();
    const skillsRaw    = (document.getElementById('seekerSkills')?.value        || '').trim();
    const bio          = (document.getElementById('seekerBio')?.value           || '').trim();
    const cvUrl        = (document.getElementById('seekerCvUrl')?.value         || '').trim();
    const location     = (document.getElementById('seekerLocation')?.value      || '').trim();
    const availability = (document.getElementById('seekerAvailability')?.value  || '').trim();

    if (name.length < 2) {
      toast('Please enter your full name (at least 2 characters).', 'warn');
      document.getElementById('seekerName')?.focus();
      return;
    }

    if (cvUrl && !_safeUrl(cvUrl)) {
      toast('CV URL must start with https://', 'warn');
      document.getElementById('seekerCvUrl')?.focus();
      return;
    }

    const skills = skillsRaw
      ? skillsRaw.split(',').map(s => s.trim()).filter(Boolean).slice(0, 20)
      : [];

    const saveBtn = document.querySelector('#jobSeekerForm [type="submit"]');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }

    try {
      const fn = _callable('saveJobSeekerProfile');
      await fn({ name, headline, bio, skills, cvUrl: cvUrl || null, location, availability });
      toast('Profile saved successfully!', 'success');
    } catch (err) {
      console.error('[SokoniJobs] saveJobSeekerProfile error:', err);
      toast(err.message || 'Failed to save profile.', 'error');
    } finally {
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save Profile'; }
    }
  }

  // ─── EMPLOYER PAGE ───────────────────────────────────────────────────────────

  async function initEmployer() {
    _watchAuth(
      user  => { _uid = user.uid; _user = user; _initEmployerUI(); },
      ()    => { _redirectToLogin(); }
    );
  }

  function _redirectToLogin() {
    toast('Please sign in to access the employer dashboard.', 'warn');
    setTimeout(() => {
      window.location.href = 'login.html?return=' + encodeURIComponent(window.location.pathname);
    }, 1200);
  }

  function _initEmployerUI() {
    _wireEmployerTabs();
    _wireJobForm();
    loadMyJobs();
  }

  function _wireEmployerTabs() {
    const tabs    = document.querySelectorAll('[data-tab]');
    const panels  = document.querySelectorAll('[data-tab-panel]');

    tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        tabs.forEach(t  => t.classList.remove('active'));
        panels.forEach(p => p.classList.remove('active'));
        tab.classList.add('active');
        const panelId = tab.dataset.tab;
        const panel   = document.querySelector(`[data-tab-panel="${panelId}"]`);
        if (panel) panel.classList.add('active');

        if (panelId === 'my-jobs')      loadMyJobs();
        if (panelId === 'applications') {
          const selector = document.getElementById('jpAppJobSelector');
          if (selector && selector.value) loadApplications(selector.value);
        }
      });
    });
  }

  function _wireJobForm() {
    const form = document.getElementById('jpJobForm');
    if (form) form.addEventListener('submit', e => { e.preventDefault(); postJob(); });
  }

  // ─── Post job ─────────────────────────────────────────────────────────────────

  async function postJob() {
    const title       = (document.getElementById('jpTitle')?.value       || '').trim();
    const category    = (document.getElementById('jpCategory')?.value    || '').trim();
    const type        = (document.getElementById('jpType')?.value        || '').trim();
    const location    = (document.getElementById('jpLocation')?.value    || '').trim();
    const salaryMin   = document.getElementById('jpSalaryMin')?.value;
    const salaryMax   = document.getElementById('jpSalaryMax')?.value;
    const description = (document.getElementById('jpDescription')?.value || '').trim();
    const reqs        = (document.getElementById('jpRequirements')?.value || '').trim();
    const expiresIn   = Number(document.getElementById('jpExpiresIn')?.value  || 30);

    // ── Validation ──
    if (title.length < 3 || title.length > 100) {
      toast('Job title must be between 3 and 100 characters.', 'warn');
      document.getElementById('jpTitle')?.focus();
      return;
    }
    if (!CATEGORIES.includes(category)) {
      toast('Please select a valid category.', 'warn');
      document.getElementById('jpCategory')?.focus();
      return;
    }
    if (!JOB_TYPES.includes(type)) {
      toast('Please select a valid job type.', 'warn');
      document.getElementById('jpType')?.focus();
      return;
    }
    if (description.length < 20 || description.length > 5000) {
      toast('Description must be 20–5000 characters.', 'warn');
      document.getElementById('jpDescription')?.focus();
      return;
    }

    const sMin = salaryMin ? Number(salaryMin) : null;
    const sMax = salaryMax ? Number(salaryMax) : null;

    if (sMin !== null && isNaN(sMin)) {
      toast('Salary minimum must be a number.', 'warn'); return;
    }
    if (sMax !== null && isNaN(sMax)) {
      toast('Salary maximum must be a number.', 'warn'); return;
    }
    if (sMin !== null && sMax !== null && sMax < sMin) {
      toast('Salary maximum cannot be less than the minimum.', 'warn'); return;
    }

    const submitBtn = document.getElementById('jpSubmitBtn');
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Posting…'; }

    try {
      const fn  = _callable('createJob');
      const res = await fn({
        title, category, type,
        location:      location || null,
        salaryMin:     sMin,
        salaryMax:     sMax,
        description,
        requirements:  reqs || null,
        expiresInDays: expiresIn,
      });

      toast('Job posted successfully! It is now live.', 'success');

      // Clear form
      ['jpTitle','jpLocation','jpSalaryMin','jpSalaryMax','jpDescription','jpRequirements'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
      });

      // Switch to My Jobs tab
      const myJobsTab = document.querySelector('[data-tab="my-jobs"]');
      if (myJobsTab) myJobsTab.click();
      else loadMyJobs();

    } catch (err) {
      console.error('[SokoniJobs] createJob error:', err);
      toast(err.message || 'Failed to post job. Please try again.', 'error');
    } finally {
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Post Job'; }
    }
  }

  // ─── My posted jobs ──────────────────────────────────────────────────────────

  async function loadMyJobs() {
    if (!_uid) return;

    const listEl = document.getElementById('jpMyJobsList');
    if (!listEl) return;

    listEl.innerHTML = '<div class="employer-loading">Loading your jobs…</div>';

    try {
      // Direct Firestore client query — rules allow owner reads (employerUid == uid)
      // Order is done in JS to avoid requiring a composite index
      const snap = await firebase.firestore()
        .collection('jobs')
        .where('employerUid', '==', _uid)
        .limit(50)
        .get();

      _myJobs = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (b.postedAt?.toMillis() || 0) - (a.postedAt?.toMillis() || 0));

      // Populate applications job-selector dropdown
      const selector = document.getElementById('jpAppJobSelector');
      if (selector) {
        selector.innerHTML = '<option value="">— Select a job —</option>'
          + _myJobs.map(j => `<option value="${_esc(j.id)}">${_esc(j.title)}</option>`).join('');
      }

      if (_myJobs.length === 0) {
        listEl.innerHTML = `
          <div class="empty-state">
            <div class="empty-icon">📋</div>
            <div class="empty-title">No jobs posted yet</div>
            <div class="empty-sub">Use the "Post Job" tab to list your first opening.</div>
          </div>`;
        return;
      }

      listEl.innerHTML = _myJobs.map(job => _renderEmployerJobCard(job)).join('');

    } catch (err) {
      console.error('[SokoniJobs] loadMyJobs error:', err);
      listEl.innerHTML = `<div class="employer-error">Could not load jobs. ${_esc(err.message)}</div>`;
      toast('Failed to load your jobs.', 'error');
    }
  }

  function _renderEmployerJobCard(job) {
    const id        = _esc(job.id);
    const title     = _esc(job.title || '');
    const type      = _esc(TYPE_LABELS[job.type] || _cap(job.type || ''));
    const apps      = Number(job.applicationCount || 0);
    const timeStr   = _esc(_timeAgo(job.postedAt));

    const status    = job.status === 'active' && job.expiresAt
      ? (job.expiresAt.toMillis() < Date.now() ? 'expired' : 'active')
      : (job.status || 'active');

    const statusColors = { active:'#4caf50', closed:'#6b7280', expired:'#f44336' };
    const statusCol    = statusColors[status] || '#6b7280';
    const statusLabel  = _cap(status);

    return `
      <div class="employer-job-card">
        <div class="employer-job-main">
          <div class="employer-job-title">${title}</div>
          <div class="employer-job-meta">
            <span class="job-type-badge job-type-${_esc(job.type||'')}">${type}</span>
            <span class="status-badge" style="background:${statusCol}20;color:${statusCol};border:1px solid ${statusCol}40">
              ${_esc(statusLabel)}
            </span>
            <span class="employer-apps-count">👥 ${_esc(String(apps))} applicants</span>
            <span class="employer-posted">Posted ${timeStr}</span>
          </div>
        </div>
        <div class="employer-job-actions">
          <button class="btn btn-sm btn-outline" onclick="SokoniJobs.selectJobForApps('${id}')">
            View Applications
          </button>
          ${status !== 'closed' ? `
          <button class="btn btn-sm btn-danger" onclick="SokoniJobs.closeMyJob('${id}')">
            Close Job
          </button>` : ''}
        </div>
      </div>`;
  }

  // ─── Applications (employer view) ─────────────────────────────────────────────

  async function selectJobForApps(jobId) {
    // Switch to Applications tab
    const appsTab = document.querySelector('[data-tab="applications"]');
    if (appsTab) appsTab.click();

    // Set selector value
    const selector = document.getElementById('jpAppJobSelector');
    if (selector) selector.value = jobId;

    await loadApplications(jobId);
  }

  async function loadApplications(jobId) {
    if (!jobId) return;
    _currentJobId = jobId;

    const listEl = document.getElementById('jpAppsList');
    if (!listEl) return;

    listEl.innerHTML = '<div class="employer-loading">Loading applications…</div>';

    try {
      const fn  = _callable('getJobApplications');
      const res = await fn({ jobId });
      const apps = (res.data && res.data.applications) || [];

      if (apps.length === 0) {
        listEl.innerHTML = `
          <div class="empty-state">
            <div class="empty-icon">📭</div>
            <div class="empty-title">No applications yet</div>
            <div class="empty-sub">Share your job listing to attract candidates!</div>
          </div>`;
        return;
      }

      listEl.innerHTML = apps.map(app => _renderApplicationCard(app)).join('');

    } catch (err) {
      console.error('[SokoniJobs] loadApplications error:', err);
      listEl.innerHTML = `<div class="employer-error">Could not load applications. ${_esc(err.message)}</div>`;
      toast('Failed to load applications.', 'error');
    }
  }

  function _renderApplicationCard(app) {
    const id       = _esc(app.id);
    const seeker   = app.seekerProfile || {};
    const name     = _esc(seeker.name     || 'Anonymous Applicant');
    const headline = _esc(seeker.headline || '');
    const location = _esc(seeker.location || '');
    const skills   = (seeker.skills || []).slice(0, 8);
    const cover    = _esc(app.coverLetter || '');
    const cvUrl    = _safeUrl(app.cvUrl);
    const timeStr  = _esc(_timeAgo(app.appliedAt));
    const status   = app.status || 'pending';

    const statusOptions = ['pending','reviewing','shortlisted','rejected','hired'];
    const statusOptHtml = statusOptions.map(s =>
      `<option value="${_esc(s)}" ${s === status ? 'selected' : ''}>${_esc(STATUS_LABELS[s] || _cap(s))}</option>`
    ).join('');

    const skillsHtml = skills.length
      ? skills.map(s => `<span class="skill-tag">${_esc(s)}</span>`).join('')
      : '';

    // Truncate cover letter for card view
    const coverShort  = cover.length > 250 ? cover.slice(0, 250) + '…' : cover;
    const coverFull   = cover;
    const hasCoverMore = cover.length > 250;

    return `
      <div class="app-card" id="app-${id}">
        <div class="app-card-header">
          <div class="app-avatar">${_esc((seeker.name||'A')[0].toUpperCase())}</div>
          <div class="app-info">
            <div class="app-name">${name}</div>
            ${headline ? `<div class="app-headline">${headline}</div>` : ''}
            ${location ? `<div class="app-location">📍 ${location}</div>` : ''}
          </div>
          <div class="app-meta-right">
            <div class="app-date">${timeStr}</div>
          </div>
        </div>

        ${skillsHtml ? `<div class="app-skills">${skillsHtml}</div>` : ''}

        <div class="app-cover">
          <div class="app-cover-label">Cover Letter</div>
          <div class="app-cover-text" id="cover-${id}">${_esc(coverShort)}</div>
          ${hasCoverMore ? `
          <button class="app-read-more"
            data-short="${_esc(coverShort)}"
            data-full="${_esc(coverFull)}"
            onclick="
              var el=document.getElementById('cover-${id}');
              var btn=this;
              if(btn.dataset.expanded==='1'){
                el.textContent=btn.dataset.short;
                btn.textContent='Read more';
                btn.dataset.expanded='';
              }else{
                el.textContent=btn.dataset.full;
                btn.textContent='Show less';
                btn.dataset.expanded='1';
              }
            ">Read more</button>` : ''}
        </div>

        ${cvUrl ? `
        <div class="app-cv">
          <a href="${cvUrl}" target="_blank" rel="noopener noreferrer" class="cv-link">
            📄 View CV / Portfolio
          </a>
        </div>` : ''}

        <div class="app-status-row">
          <label class="status-label">Application Status</label>
          <div class="status-controls">
            <select class="status-select" id="status-${id}">
              ${statusOptHtml}
            </select>
            <button class="btn btn-sm btn-primary" onclick="SokoniJobs.updateAppStatus('${id}', document.getElementById('status-${id}').value)">
              Update
            </button>
          </div>
        </div>
      </div>`;
  }

  async function updateAppStatus(appId, status) {
    if (!appId || !status) return;

    const btn = document.querySelector(`#app-${CSS.escape(appId)} .btn-primary`);
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

    try {
      const fn = _callable('updateApplicationStatus');
      await fn({ applicationId: appId, status });
      toast(`Status updated to "${STATUS_LABELS[status] || status}".`, 'success');
    } catch (err) {
      console.error('[SokoniJobs] updateAppStatus error:', err);
      toast(err.message || 'Failed to update status.', 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Update'; }
    }
  }

  // ─── Close job ───────────────────────────────────────────────────────────────

  async function closeMyJob(jobId) {
    if (!jobId) return;

    if (!confirm('Close this job listing? It will no longer accept new applications.')) return;

    try {
      const fn = _callable('closeJob');
      await fn({ jobId });
      toast('Job closed successfully.', 'success');
      loadMyJobs();
    } catch (err) {
      console.error('[SokoniJobs] closeJob error:', err);
      toast(err.message || 'Failed to close job.', 'error');
    }
  }

  // ─── Public API ──────────────────────────────────────────────────────────────

  return {
    initPublic,
    initEmployer,
    // Public page
    loadFeaturedJobs,
    loadJobs,
    filterCategory,
    filterType,
    searchJobs,
    setSortMode,
    openJobDetail,
    closeModal,
    openApplyForm,
    submitApplication,
    openMyApps,
    closeMyApps,
    loadSeekerProfile,
    saveSeekerProfile,
    // Employer page
    postJob,
    loadMyJobs,
    loadApplications,
    selectJobForApps,
    updateAppStatus,
    closeMyJob,
    // Shared
    toast,
  };

})();
