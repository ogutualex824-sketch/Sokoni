/* ================================================================
   SOKONI Education Hub — Client Engine  v1.0
   sokoni-education.js

   IIFE exposing window.SokoniEducation

   Requires:
     • Firebase JS SDK (compat v9) loaded via /__/firebase/init.js
     • Cloud Functions defined in functions/education.js (Gen2, onCall)

   Public surface:
     SokoniEducation.init()

   Security:
     • All user-supplied and Firestore-sourced text rendered through
       _esc() before innerHTML — XSS safe.
     • Thumbnail / video URLs validated before use.
     • Auth state via Firebase onAuthStateChanged — uid never from client.
================================================================ */
'use strict';

window.SokoniEducation = (() => {

  /* ─── State ──────────────────────────────────────────────────────────────── */

  let _uid              = null;
  let _user             = null;
  let _activeCategory   = 'all';
  let _activeLevel      = 'all';
  let _allCourses       = [];
  let _page             = 0;
  let _hasMore          = false;
  let _myEnrollments    = [];
  let _selectedCourseId = null;
  let _callableCache    = {};
  let _toastContainer   = null;
  let _loading          = false;

  /* ─── Constants ──────────────────────────────────────────────────────────── */

  const CATEGORIES = [
    { key: 'all',                  label: 'All',               icon: '📚' },
    { key: 'technology',           label: 'Technology',        icon: '💻' },
    { key: 'business',             label: 'Business',          icon: '💼' },
    { key: 'design',               label: 'Design',            icon: '🎨' },
    { key: 'marketing',            label: 'Marketing',         icon: '📣' },
    { key: 'personal-development', label: 'Self Dev',          icon: '🌱' },
    { key: 'language',             label: 'Language',          icon: '🌐' },
    { key: 'arts',                 label: 'Arts',              icon: '🎭' },
    { key: 'health',               label: 'Health',            icon: '❤️' },
    { key: 'cooking',              label: 'Cooking',           icon: '🍳' },
    { key: 'music',                label: 'Music',             icon: '🎵' },
    { key: 'other',                label: 'Other',             icon: '✨' },
  ];

  const LEVEL_COLORS = {
    beginner:     '#4caf50',
    intermediate: '#ff9800',
    advanced:     '#f44336',
  };

  const LEVEL_LABELS = {
    beginner:     'Beginner',
    intermediate: 'Intermediate',
    advanced:     'Advanced',
  };

  /* ─── Utility helpers ────────────────────────────────────────────────────── */

  /** XSS-safe escaping — wraps every user/Firestore value before innerHTML */
  function _esc(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g,  '&amp;')
      .replace(/</g,  '&lt;')
      .replace(/>/g,  '&gt;')
      .replace(/"/g,  '&quot;')
      .replace(/'/g,  '&#39;');
  }

  /** Format number with Kenya locale commas */
  function _fmt(n) {
    if (n == null || isNaN(Number(n))) return '0';
    return Number(n).toLocaleString('en-KE');
  }

  /** Relative time display */
  function _timeAgo(ts) {
    if (!ts) return '';
    let ms;
    if (typeof ts.toMillis === 'function') ms = ts.toMillis();
    else if (ts.seconds) ms = ts.seconds * 1000;
    else ms = Number(ts);
    const diff = Date.now() - ms;
    if (diff < 60000)      return 'just now';
    if (diff < 3600000)    return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000)   return `${Math.floor(diff / 3600000)}h ago`;
    if (diff < 2592000000) return `${Math.floor(diff / 86400000)}d ago`;
    return new Date(ms).toLocaleDateString('en-KE', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  /** Validate that a URL is https:// safe to display */
  function _safeUrl(url) {
    if (!url) return '';
    try {
      const u = new URL(String(url).trim());
      return ['https:', 'http:'].includes(u.protocol) ? u.href : '';
    } catch (_) { return ''; }
  }

  /** Convert a YouTube watch URL to an embed URL */
  function _youtubeEmbed(url) {
    if (!url) return '';
    try {
      const u = new URL(url);
      if (u.hostname.includes('youtube.com') && u.searchParams.get('v')) {
        return `https://www.youtube.com/embed/${u.searchParams.get('v')}`;
      }
      if (u.hostname === 'youtu.be') {
        return `https://www.youtube.com/embed${u.pathname}`;
      }
    } catch (_) {}
    return '';
  }

  /** Get/cache a Firebase callable function */
  function _callable(name) {
    if (!_callableCache[name]) {
      _callableCache[name] = firebase.functions().httpsCallable(name);
    }
    return _callableCache[name];
  }

  /** Render star rating HTML */
  function renderStars(rating) {
    const r = Math.round(Number(rating || 0));
    let html = '';
    for (let i = 1; i <= 5; i++) {
      html += `<span class="edu-star${i <= r ? ' filled' : ''}" aria-hidden="true">${i <= r ? '★' : '☆'}</span>`;
    }
    return html;
  }

  /* ─── Toast ──────────────────────────────────────────────────────────────── */

  function toast(msg, type = 'info', duration = 4000) {
    if (!_toastContainer) {
      _toastContainer = document.getElementById('eduToasts');
    }
    if (!_toastContainer) return;

    const colors = { info: '#3f51b5', success: '#4caf50', error: '#f44336', warn: '#ff9800' };
    const icons  = { info: 'ℹ️',      success: '✅',       error: '❌',      warn: '⚠️' };

    const el = document.createElement('div');
    el.className = 'edu-toast';
    el.style.cssText = `
      background:${colors[type] || colors.info};color:#fff;
      padding:12px 18px;border-radius:10px;font-size:14px;font-weight:500;
      display:flex;align-items:center;gap:8px;
      box-shadow:0 4px 20px rgba(0,0,0,.22);
      animation:toastIn .25s ease;pointer-events:auto;max-width:380px;
    `;
    el.innerHTML = `<span>${icons[type] || ''}</span><span>${_esc(msg)}</span>`;
    _toastContainer.appendChild(el);

    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transform = 'translateY(-8px)';
      el.style.transition = 'all .3s';
      setTimeout(() => el.remove(), 300);
    }, duration);
  }

  /* ─── Auth ───────────────────────────────────────────────────────────────── */

  function _watchAuth() {
    firebase.auth().onAuthStateChanged(user => {
      _uid  = user ? user.uid : null;
      _user = user || null;

      const myLearningBtn = document.getElementById('eduMyLearningBtn');
      const teachBtn      = document.getElementById('eduTeachBtn');
      const authActionEl  = document.getElementById('eduAuthAction');
      const loginPrompt   = document.getElementById('eduLoginPrompt');

      if (user) {
        if (myLearningBtn) myLearningBtn.classList.remove('hidden');
        if (teachBtn)      teachBtn.classList.remove('hidden');
        if (authActionEl)  { authActionEl.textContent = 'Sign Out'; authActionEl.onclick = () => firebase.auth().signOut(); }
        if (loginPrompt)   loginPrompt.classList.add('hidden');
        /* Refresh enrolments in background */
        _loadMyEnrollments().catch(() => {});
      } else {
        if (myLearningBtn) myLearningBtn.classList.add('hidden');
        if (teachBtn)      teachBtn.classList.add('hidden');
        if (authActionEl)  { authActionEl.textContent = 'Sign In'; authActionEl.href = 'login.html?return=education.html'; }
        if (loginPrompt)   loginPrompt.classList.remove('hidden');
        _myEnrollments = [];
      }
    });
  }

  /* ─── Load: featured courses ─────────────────────────────────────────────── */

  async function loadFeaturedCourses() {
    const container = document.getElementById('eduFeaturedList');
    if (!container) return;

    try {
      /* We use listCourses and filter isFeatured client-side
         since we cannot add a composite index for status+isFeatured */
      const res = await _callable('listCourses')({ page: 0 });
      const featured = (res.data.courses || []).filter(c => c.isFeatured).slice(0, 6);
      renderFeatured(featured);
    } catch (err) {
      console.warn('[Education] Featured load error:', err.message);
    }
  }

  /* ─── Load: course catalog ───────────────────────────────────────────────── */

  async function loadCourses(reset = false) {
    if (_loading) return;
    _loading = true;

    if (reset) {
      _page = 0;
      _allCourses = [];
    }

    const list   = document.getElementById('eduResultsList');
    const more   = document.getElementById('eduLoadMore');
    const count  = document.getElementById('eduResultsCount');

    if (list && reset) {
      list.innerHTML = '<div class="edu-loading">Loading courses…</div>';
    }

    try {
      const search = (document.getElementById('eduSearch') || {}).value || '';
      const level  = (document.getElementById('eduLevelFilter') || {}).value || 'all';

      const res = await _callable('listCourses')({
        category: _activeCategory !== 'all' ? _activeCategory : null,
        level:    level !== 'all' ? level : null,
        search:   search.trim() || null,
        page:     _page,
      });

      const courses = res.data.courses || [];
      _hasMore = res.data.hasMore || false;
      const total  = res.data.total || 0;

      if (reset) {
        _allCourses = courses;
      } else {
        _allCourses = [..._allCourses, ...courses];
      }

      renderCourses(_allCourses, reset);

      if (count) {
        count.textContent = total === 0
          ? 'No courses found'
          : `${_fmt(total)} course${total === 1 ? '' : 's'}`;
      }

      if (more) {
        more.style.display = _hasMore ? 'inline-flex' : 'none';
      }

      if (_hasMore) _page++;

    } catch (err) {
      console.error('[Education] loadCourses error:', err);
      if (list) list.innerHTML = '<div class="edu-empty">Could not load courses. Please try again.</div>';
      toast('Failed to load courses', 'error');
    } finally {
      _loading = false;
    }
  }

  /* ─── Filter by category ─────────────────────────────────────────────────── */

  function filterCategory(cat) {
    _activeCategory = cat;

    /* Update chip active state */
    document.querySelectorAll('.edu-cat-chip').forEach(chip => {
      chip.classList.toggle('active', chip.dataset.cat === cat);
    });

    loadCourses(true);
  }

  /* ─── Search ─────────────────────────────────────────────────────────────── */

  function searchCourses() {
    loadCourses(true);
  }

  /* ─── Load more ──────────────────────────────────────────────────────────── */

  function loadMore() {
    if (_hasMore) loadCourses(false);
  }

  /* ─── Course detail modal ────────────────────────────────────────────────── */

  async function openCourseDetail(courseId) {
    _selectedCourseId = courseId;

    const modal   = document.getElementById('eduDetailModal');
    const content = document.getElementById('eduDetailContent');
    if (!modal || !content) return;

    modal.style.display = 'flex';
    document.body.style.overflow = 'hidden';
    content.innerHTML = '<div class="edu-loading" style="padding:60px;text-align:center;color:var(--muted)">Loading course…</div>';

    try {
      const res = await _callable('getCourse')({ courseId });
      const { course, isEnrolled, reviews } = res.data;
      renderCourseDetail(course, isEnrolled, reviews);
    } catch (err) {
      console.error('[Education] getCourse error:', err);
      content.innerHTML = '<div class="edu-empty" style="padding:40px;text-align:center;color:var(--muted)">Could not load course details.</div>';
    }
  }

  function closeModal() {
    const modal = document.getElementById('eduDetailModal');
    if (modal) modal.style.display = 'none';
    document.body.style.overflow = '';
    _selectedCourseId = null;
  }

  /* ─── Enrol in a course ──────────────────────────────────────────────────── */

  async function enrollCourse(courseId) {
    if (!_uid) {
      window.location.href = `login.html?return=education.html`;
      return;
    }

    const btn = document.getElementById('eduEnrollBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Enrolling…'; }

    try {
      const res = await _callable('enrollCourse')({ courseId });
      const data = res.data;

      if (data.enrolled) {
        toast('You are now enrolled! Happy learning.', 'success');
        /* Refresh modal to show Continue Learning */
        await openCourseDetail(courseId);
        /* Refresh My Learning list in background */
        _loadMyEnrollments().catch(() => {});
      } else if (data.paymentRequired) {
        toast(`KSh ${_fmt(data.price)} required. Please top up your wallet.`, 'warn', 6000);
        if (btn) { btn.disabled = false; btn.textContent = `Enrol for KSh ${_fmt(data.price)}`; }
      }
    } catch (err) {
      console.error('[Education] enrollCourse error:', err);
      toast(err.message || 'Enrolment failed. Please try again.', 'error');
      if (btn) { btn.disabled = false; }
    }
  }

  /* ─── My Learning panel ──────────────────────────────────────────────────── */

  async function openMyLearning() {
    if (!_uid) {
      window.location.href = 'login.html?return=education.html';
      return;
    }

    const panel = document.getElementById('eduMyLearningPanel');
    if (!panel) return;

    panel.style.transform = 'translateX(0)';
    panel.setAttribute('aria-hidden', 'false');

    await _loadMyEnrollments();
    renderMyEnrollments(_myEnrollments);
  }

  function closeMyLearning() {
    const panel = document.getElementById('eduMyLearningPanel');
    if (!panel) return;
    panel.style.transform = 'translateX(100%)';
    panel.setAttribute('aria-hidden', 'true');
  }

  async function _loadMyEnrollments() {
    try {
      const res = await _callable('getMyEnrollments')({});
      _myEnrollments = res.data.enrollments || [];
    } catch (err) {
      console.warn('[Education] getMyEnrollments error:', err.message);
    }
  }

  /* ─── Create course form ─────────────────────────────────────────────────── */

  function showCreateForm() {
    if (!_uid) {
      window.location.href = 'login.html?return=education.html';
      return;
    }
    const form = document.getElementById('eduCreateForm');
    if (!form) return;
    form.classList.remove('hidden');
    form.scrollIntoView({ behavior: 'smooth' });
  }

  function hideCreateForm() {
    const form = document.getElementById('eduCreateForm');
    if (form) form.classList.add('hidden');
  }

  async function submitCourse() {
    if (!_uid) return;

    const title    = (document.getElementById('eduCreateTitle')    || {}).value || '';
    const category = (document.getElementById('eduCreateCategory') || {}).value || '';
    const level    = (document.getElementById('eduCreateLevel')    || {}).value || '';
    const price    = (document.getElementById('eduCreatePrice')    || {}).value || '0';
    const desc     = (document.getElementById('eduCreateDesc')     || {}).value || '';
    const video    = (document.getElementById('eduCreateVideo')    || {}).value || '';
    const thumb    = (document.getElementById('eduCreateThumb')    || {}).value || '';
    const lessons  = (document.getElementById('eduCreateLessons')  || {}).value || '1';
    const mins     = (document.getElementById('eduCreateMins')     || {}).value || '0';
    const tagsRaw  = (document.getElementById('eduCreateTags')     || {}).value || '';

    /* Client-side validation */
    if (!title.trim() || title.trim().length < 5) {
      toast('Title must be at least 5 characters', 'warn'); return;
    }
    if (!desc.trim() || desc.trim().length < 20) {
      toast('Description must be at least 20 characters', 'warn'); return;
    }
    if (!category) { toast('Please select a category', 'warn'); return; }
    if (!level)    { toast('Please select a level', 'warn'); return; }

    const submitBtn = document.getElementById('eduCreateSubmit');
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Submitting…'; }

    try {
      const tags = tagsRaw.split(',').map(t => t.trim()).filter(Boolean).slice(0, 10);

      const res = await _callable('createCourse')({
        title:           title.trim(),
        description:     desc.trim(),
        category,
        level,
        price:           Number(price) || 0,
        videoUrl:        video.trim(),
        thumbnail:       thumb.trim(),
        lessonCount:     Number(lessons) || 1,
        durationMinutes: Number(mins) || 0,
        tags,
      });

      toast(`Course "${res.data.course.title}" submitted for review!`, 'success', 6000);
      hideCreateForm();

      /* Reset form */
      ['eduCreateTitle','eduCreateCategory','eduCreateLevel','eduCreatePrice',
       'eduCreateDesc','eduCreateVideo','eduCreateThumb','eduCreateLessons',
       'eduCreateMins','eduCreateTags'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
      });

    } catch (err) {
      console.error('[Education] createCourse error:', err);
      toast(err.message || 'Failed to submit course. Please try again.', 'error');
    } finally {
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Submit for Review'; }
    }
  }

  /* ─── Render: course grid ────────────────────────────────────────────────── */

  function renderCourses(courses, reset = false) {
    const list = document.getElementById('eduResultsList');
    if (!list) return;

    if (!courses || courses.length === 0) {
      list.innerHTML = `
        <div class="edu-empty">
          <div style="font-size:48px;margin-bottom:12px">📚</div>
          <div style="font-size:17px;font-weight:700;color:var(--text);margin-bottom:6px">No courses found</div>
          <div style="font-size:14px;color:var(--muted)">Try a different category or search term.</div>
        </div>`;
      return;
    }

    /* Find enrolled course IDs for badge rendering */
    const enrolledIds = new Set(_myEnrollments.map(e => e.courseId));

    if (reset) {
      list.innerHTML = '';
    }

    const fragment = document.createDocumentFragment();
    courses.forEach(course => {
      const el = document.createElement('article');
      el.className = 'edu-card';
      el.setAttribute('role', 'listitem');
      el.setAttribute('tabindex', '0');
      el.setAttribute('aria-label', _esc(course.title));
      el.onclick = () => openCourseDetail(course.courseId);
      el.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') openCourseDetail(course.courseId); };

      const thumb   = _safeUrl(course.thumbnail);
      const price   = Number(course.price || 0);
      const rating  = Number(course.rating || 0).toFixed(1);
      const enrolled = enrolledIds.has(course.courseId);
      const levelColor = LEVEL_COLORS[course.level] || '#6b7280';

      el.innerHTML = `
        <div class="edu-card-thumb">
          <img
            src="${thumb ? _esc(thumb) : 'assets/course-placeholder.png'}"
            alt="${_esc(course.title)}"
            onerror="this.src='assets/course-placeholder.png'"
            loading="lazy"
          >
          ${course.isFeatured ? '<span class="edu-featured-badge">★ Featured</span>' : ''}
        </div>
        <div class="edu-card-body">
          <div class="edu-card-badges">
            <span class="edu-cat-badge">${_esc(_catLabel(course.category))}</span>
            <span class="edu-level-badge" style="background:${levelColor}20;color:${levelColor}">${_esc(LEVEL_LABELS[course.level] || course.level)}</span>
          </div>
          <h3 class="edu-card-title">${_esc(course.title)}</h3>
          <div class="edu-card-meta">
            <span class="edu-rating">
              <span class="edu-stars" aria-label="${rating} stars">${renderStars(rating)}</span>
              <span>${rating}</span>
            </span>
            <span>·</span>
            <span>${_fmt(course.enrollmentCount || 0)} enrolled</span>
            ${course.durationMinutes ? `<span>·</span><span>${_fmt(course.durationMinutes)}m</span>` : ''}
          </div>
          <div class="edu-card-footer">
            <div class="edu-card-price">
              ${price === 0
                ? '<span class="edu-free-badge">FREE</span>'
                : `<span>KSh ${_fmt(price)}</span>`
              }
            </div>
            ${enrolled
              ? '<span class="edu-enrolled-badge">✓ Enrolled</span>'
              : `<button class="edu-enroll-btn" onclick="event.stopPropagation(); SokoniEducation.enrollCourse('${_esc(course.courseId)}')" aria-label="Enrol in ${_esc(course.title)}">${price === 0 ? 'Enrol Free' : 'Enrol'}</button>`
            }
          </div>
        </div>`;

      fragment.appendChild(el);
    });

    if (reset) {
      list.innerHTML = '';
    }
    list.appendChild(fragment);
    list.setAttribute('role', 'list');
  }

  /* ─── Render: featured horizontal strip ──────────────────────────────────── */

  function renderFeatured(courses) {
    const container = document.getElementById('eduFeaturedList');
    const strip     = document.getElementById('eduFeaturedStrip');
    if (!container) return;

    if (!courses || courses.length === 0) {
      if (strip) strip.classList.add('hidden');
      return;
    }

    if (strip) strip.classList.remove('hidden');

    container.innerHTML = courses.map(c => {
      const thumb = _safeUrl(c.thumbnail);
      const price = Number(c.price || 0);
      return `
        <div class="edu-featured-card" role="listitem"
             onclick="SokoniEducation.openCourseDetail('${_esc(c.courseId)}')"
             tabindex="0"
             onkeydown="if(event.key==='Enter')SokoniEducation.openCourseDetail('${_esc(c.courseId)}')"
             aria-label="${_esc(c.title)}">
          <div class="edu-featured-thumb">
            <img src="${thumb || 'assets/course-placeholder.png'}"
                 alt="${_esc(c.title)}"
                 onerror="this.src='assets/course-placeholder.png'"
                 loading="lazy">
          </div>
          <div class="edu-featured-body">
            <div class="edu-cat-badge" style="margin-bottom:4px">${_esc(_catLabel(c.category))}</div>
            <div class="edu-featured-title">${_esc(c.title)}</div>
            <div class="edu-featured-meta">
              ${renderStars(c.rating || 0)}
              <span style="font-size:12px;color:var(--muted);margin-left:4px">${_fmt(c.enrollmentCount || 0)} enrolled</span>
            </div>
            <div class="edu-featured-price">
              ${price === 0 ? '<span class="edu-free-badge">FREE</span>' : `KSh ${_fmt(price)}`}
            </div>
          </div>
        </div>`;
    }).join('');
  }

  /* ─── Render: My Learning panel ──────────────────────────────────────────── */

  function renderMyEnrollments(enrollments) {
    const list = document.getElementById('eduMyEnrollmentsList');
    if (!list) return;

    if (!enrollments || enrollments.length === 0) {
      list.innerHTML = `
        <div style="text-align:center;padding:48px 16px;color:var(--muted)">
          <div style="font-size:40px;margin-bottom:10px">📖</div>
          <div style="font-weight:700;color:var(--text);margin-bottom:6px">No courses yet</div>
          <div style="font-size:13px">Enrol in a course to start learning.</div>
        </div>`;
      return;
    }

    list.innerHTML = enrollments.map(e => {
      const course  = e.course || {};
      const prog    = Number(e.progress || 0);
      const thumb   = _safeUrl(course.thumbnail);
      const done    = prog >= 100;

      return `
        <div class="edu-enrollment-card"
             onclick="SokoniEducation.openCourseDetail('${_esc(e.courseId)}')"
             role="listitem" tabindex="0"
             onkeydown="if(event.key==='Enter')SokoniEducation.openCourseDetail('${_esc(e.courseId)}')">
          <div class="edu-enroll-thumb">
            <img src="${thumb || 'assets/course-placeholder.png'}"
                 alt="${_esc(course.title || 'Course')}"
                 onerror="this.src='assets/course-placeholder.png'">
            ${done ? '<span class="edu-complete-badge">✓</span>' : ''}
          </div>
          <div class="edu-enroll-info">
            <div class="edu-enroll-title">${_esc(course.title || 'Unknown Course')}</div>
            <div class="edu-enroll-cat">${_esc(_catLabel(course.category))}</div>
            <div class="edu-progress-bar" role="progressbar"
                 aria-valuenow="${prog}" aria-valuemin="0" aria-valuemax="100"
                 aria-label="${prog}% complete">
              <div class="edu-progress-fill" style="width:${prog}%"></div>
            </div>
            <div style="font-size:11px;color:var(--muted);margin-top:3px">
              ${done ? 'Completed!' : `${prog}% complete`}
              ${e.lastAccessedAt ? ` · ${_timeAgo(e.lastAccessedAt)}` : ''}
            </div>
          </div>
        </div>`;
    }).join('');
  }

  /* ─── Render: course detail modal ────────────────────────────────────────── */

  function renderCourseDetail(course, isEnrolled, reviews) {
    const content   = document.getElementById('eduDetailContent');
    const enrollBtn = document.getElementById('eduEnrollBtn');
    if (!content) return;

    const thumb  = _safeUrl(course.thumbnail);
    const video  = _safeUrl(course.videoUrl);
    const embed  = video ? _youtubeEmbed(video) : '';
    const price  = Number(course.price || 0);
    const rating = Number(course.rating || 0).toFixed(1);
    const levelColor = LEVEL_COLORS[course.level] || '#6b7280';

    /* Build lesson list (lessonCount might be a number without lesson IDs in catalog) */
    const lessonCount = Number(course.lessonCount || 0);
    let lessonListHtml = '';
    if (lessonCount > 0) {
      const lessonsArr = Array.from({ length: lessonCount }, (_, i) => ({
        id: `lesson_${i + 1}`,
        title: `Lesson ${i + 1}`,
      }));
      lessonListHtml = `
        <div class="edu-lesson-list">
          <h3 style="font-size:15px;font-weight:700;margin-bottom:10px">Course Content (${lessonCount} lessons)</h3>
          ${lessonsArr.map((l, i) => `
            <div class="edu-lesson-row ${!isEnrolled && i > 0 ? 'edu-lesson-locked' : ''}">
              <span class="edu-lesson-num">${i + 1}</span>
              <span class="edu-lesson-title">${_esc(l.title)}</span>
              ${!isEnrolled && i > 0 ? '<span class="edu-lock-icon">🔒</span>' : '<span class="edu-lock-icon">▶</span>'}
            </div>`).join('')}
        </div>`;
    }

    /* Reviews */
    const reviewsHtml = reviews && reviews.length > 0
      ? `<div class="edu-reviews-section">
          <h3 style="font-size:15px;font-weight:700;margin-bottom:12px">Student Reviews</h3>
          ${reviews.map(r => `
            <div class="edu-review-card">
              <div class="edu-review-header">
                <span class="edu-review-stars">${renderStars(r.rating)}</span>
                <span style="font-size:12px;color:var(--muted);margin-left:6px">${_timeAgo(r.createdAt)}</span>
              </div>
              <div class="edu-review-comment">${_esc(r.comment)}</div>
            </div>`).join('')}
        </div>`
      : '';

    /* Media section */
    let mediaHtml = '';
    if (embed) {
      mediaHtml = `<div class="edu-video-wrap">
        <iframe src="${_esc(embed)}" title="${_esc(course.title)}"
          frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowfullscreen loading="lazy"></iframe>
      </div>`;
    } else if (thumb) {
      mediaHtml = `<img class="edu-detail-thumb" src="${_esc(thumb)}"
        alt="${_esc(course.title)}"
        onerror="this.src='assets/course-placeholder.png'">`;
    }

    content.innerHTML = `
      ${mediaHtml}
      <div class="edu-detail-header">
        <div class="edu-detail-badges">
          <span class="edu-cat-badge">${_esc(_catLabel(course.category))}</span>
          <span class="edu-level-badge" style="background:${levelColor}20;color:${levelColor}">${_esc(LEVEL_LABELS[course.level] || '')}</span>
          ${course.isFeatured ? '<span class="edu-featured-badge">★ Featured</span>' : ''}
        </div>
        <h2 class="edu-detail-title">${_esc(course.title)}</h2>
        <div class="edu-detail-meta">
          <span class="edu-rating">
            <span class="edu-stars">${renderStars(rating)}</span>
            <strong>${rating}</strong>
          </span>
          <span>·</span>
          <span>${_fmt(course.enrollmentCount || 0)} students</span>
          ${course.durationMinutes ? `<span>·</span><span>${_fmt(course.durationMinutes)} min</span>` : ''}
          ${course.lessonCount ? `<span>·</span><span>${_fmt(course.lessonCount)} lessons</span>` : ''}
        </div>
      </div>

      <div class="edu-detail-body">
        <div class="edu-detail-desc">
          <h3 style="font-size:15px;font-weight:700;margin-bottom:8px">About this Course</h3>
          <p style="font-size:14px;line-height:1.7;color:var(--muted)">${_esc(course.description || '')}</p>
        </div>

        ${lessonListHtml}
        ${reviewsHtml}
      </div>`;

    /* Update enrol button */
    if (enrollBtn) {
      if (isEnrolled) {
        enrollBtn.textContent = '▶ Continue Learning';
        enrollBtn.className = 'btn btn-primary';
        enrollBtn.onclick = () => { closeModal(); openMyLearning(); };
        enrollBtn.disabled = false;
      } else if (price === 0) {
        enrollBtn.textContent = 'Enrol Free';
        enrollBtn.className = 'btn btn-primary';
        enrollBtn.onclick = () => enrollCourse(course.courseId);
        enrollBtn.disabled = false;
      } else {
        enrollBtn.textContent = `Enrol for KSh ${_fmt(price)}`;
        enrollBtn.className = 'btn btn-primary';
        enrollBtn.onclick = () => enrollCourse(course.courseId);
        enrollBtn.disabled = false;
      }
    }
  }

  /* ─── Render: category chips ─────────────────────────────────────────────── */

  function _renderCategoryChips() {
    const container = document.getElementById('eduCategoryChips');
    if (!container) return;

    container.innerHTML = CATEGORIES.map(cat => `
      <button
        class="edu-cat-chip${_activeCategory === cat.key ? ' active' : ''}"
        data-cat="${_esc(cat.key)}"
        onclick="SokoniEducation.filterCategory('${_esc(cat.key)}')"
        aria-pressed="${_activeCategory === cat.key}"
        aria-label="Filter by ${_esc(cat.label)}"
      >
        <span aria-hidden="true">${cat.icon}</span> ${_esc(cat.label)}
      </button>`).join('');
  }

  /* ─── Helper: category label ─────────────────────────────────────────────── */

  function _catLabel(key) {
    const found = CATEGORIES.find(c => c.key === key);
    return found ? found.label : (key || 'Other');
  }

  /* ─── Init ───────────────────────────────────────────────────────────────── */

  function init() {
    _renderCategoryChips();
    _watchAuth();
    loadFeaturedCourses();
    loadCourses(true);

    /* Keyboard: Enter in search box triggers search */
    const searchInput = document.getElementById('eduSearch');
    if (searchInput) {
      searchInput.addEventListener('keydown', e => {
        if (e.key === 'Enter') searchCourses();
      });
    }

    /* Close modal on overlay click */
    const modal = document.getElementById('eduDetailModal');
    if (modal) {
      modal.addEventListener('click', e => {
        if (e.target === modal) closeModal();
      });
    }

    /* Close modal on Escape */
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        closeModal();
        closeMyLearning();
        hideCreateForm();
      }
    });
  }

  /* ─── Public API ─────────────────────────────────────────────────────────── */

  return {
    init,
    loadCourses,
    loadMore,
    filterCategory,
    searchCourses,
    openCourseDetail,
    closeModal,
    enrollCourse,
    openMyLearning,
    closeMyLearning,
    showCreateForm,
    hideCreateForm,
    submitCourse,
    renderCourses,
    renderFeatured,
    renderMyEnrollments,
    renderCourseDetail,
    renderStars,
  };

})();
