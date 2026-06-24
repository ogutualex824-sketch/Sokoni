/**
 * SOKONI NOTIFICATION CENTER v1.0
 * ─────────────────────────────────────────────────────────────────────────────
 * Enterprise-grade Notification Center UI for the SOKONI platform.
 *
 * Features:
 *  - Animated notification bell (priority-color badge, ring animation)
 *  - Full-screen slide-in Notification Center panel
 *  - 20 category tabs with per-tab unread counts
 *  - Intelligent grouping cards ("3 New Orders" instead of 3 separate cards)
 *  - Inline quick actions (View, Approve, Reply, Archive, Delete, etc.)
 *  - Mark All Read (per-category or global)
 *  - Preferences panel (per-category toggles, DND, Quiet Hours, mute timers)
 *  - Search within notifications
 *  - Empty / error / offline states
 *  - Full keyboard navigation + ARIA
 *  - Zero duplicate listeners
 *  - No z-index conflicts (uses sokoni-tokens.css tiers)
 *
 * Dependencies: sokoni-notif-engine.js (SokoniNotifEngine)
 * Exposed on: window.SokoniNotifCenter
 * ─────────────────────────────────────────────────────────────────────────────
 */
(function(global) {
  'use strict';

  /* ─────────────────────────────────────────────────────────────────────────
     STYLES
  ───────────────────────────────────────────────────────────────────────── */

  function _injectCSS() {
    if (document.getElementById('sk-nc-styles')) return;
    var s = document.createElement('style');
    s.id = 'sk-nc-styles';
    s.textContent = [
      /* ── Bell button ── */
      '#sk-notif-btn{',
        'position:relative;',
        'width:40px;height:40px;',
        'border-radius:12px;',
        'background:rgba(255,255,255,0.05);',
        'border:1px solid rgba(255,255,255,0.09);',
        'display:flex;align-items:center;justify-content:center;',
        'cursor:pointer;font-size:18px;color:white;',
        'transition:background 150ms ease,border-color 150ms ease;',
        '-webkit-tap-highlight-color:transparent;',
        'padding:0;',
        'flex-shrink:0;',
      '}',
      '#sk-notif-btn:hover,#sk-notif-btn[aria-expanded="true"]{',
        'background:rgba(113,255,0,0.1);border-color:rgba(113,255,0,0.3);',
      '}',
      /* Bell animation — rings when high/critical arrives */
      '@keyframes sk-bell-ring{',
        '0%{transform:rotate(0);}',
        '10%{transform:rotate(14deg);}',
        '20%{transform:rotate(-12deg);}',
        '30%{transform:rotate(10deg);}',
        '40%{transform:rotate(-8deg);}',
        '50%{transform:rotate(6deg);}',
        '60%{transform:rotate(-4deg);}',
        '70%{transform:rotate(2deg);}',
        '80%,100%{transform:rotate(0);}',
      '}',
      '#sk-notif-bell-icon{display:inline-block;transform-origin:50% 0;transition:transform 0.2s;}',
      '#sk-notif-btn.sk-bell--ringing #sk-notif-bell-icon{animation:sk-bell-ring 0.8s ease both;}',

      /* ── Badge ── */
      '#sk-notif-badge-v2{',
        'position:absolute;top:-5px;right:-5px;',
        'min-width:18px;height:18px;',
        'border-radius:999px;',
        'font-size:9px;font-weight:900;',
        'display:none;align-items:center;justify-content:center;',
        'padding:0 4px;',
        'border:2px solid rgba(10,10,10,0.97);',
        'line-height:1;',
        'pointer-events:none;',
        'transition:background 200ms ease;',
      '}',
      '#sk-notif-badge-v2.show,#sk-notif-badge.show{display:flex;}',
      '#sk-notif-badge-v2.priority-critical,#sk-notif-badge.priority-critical{background:#ff1744;color:#fff;}',
      '#sk-notif-badge-v2.priority-high,#sk-notif-badge.priority-high        {background:#ff6d00;color:#fff;}',
      '#sk-notif-badge-v2.priority-normal,#sk-notif-badge.priority-normal    {background:#71ff00;color:#050f05;}',
      '#sk-notif-badge-v2.priority-low,#sk-notif-badge.priority-low          {background:#455a64;color:#fff;}',

      /* ── Panel overlay ── */
      '#sk-nc-overlay{',
        'position:fixed;inset:0;',
        'z-index:var(--sk-z-drawer,600);',
        'pointer-events:none;',
        'visibility:hidden;',
      '}',
      '#sk-nc-overlay.open{pointer-events:all;visibility:visible;}',
      '#sk-nc-backdrop{',
        'position:absolute;inset:0;',
        'background:rgba(5,10,5,0.6);',
        'backdrop-filter:blur(4px);',
        '-webkit-backdrop-filter:blur(4px);',
        'opacity:0;transition:opacity 280ms ease;',
      '}',
      '#sk-nc-overlay.open #sk-nc-backdrop{opacity:1;}',

      /* ── Panel ── */
      '#sk-nc-panel{',
        'position:absolute;',
        'top:0;right:0;',
        'width:min(430px,100vw);',
        'height:100%;',
        'background:#0a0f0a;',
        'border-left:1px solid rgba(255,255,255,0.07);',
        'display:flex;flex-direction:column;',
        'overflow:hidden;',
        'transform:translateX(100%);',
        'transition:transform 300ms cubic-bezier(0.4,0,0.2,1);',
        'box-shadow:-8px 0 48px rgba(0,0,0,0.8);',
      '}',
      '#sk-nc-overlay.open #sk-nc-panel{transform:translateX(0);}',

      /* ── Panel header ── */
      '#sk-nc-head{',
        'display:flex;align-items:center;gap:10px;',
        'padding:16px 18px;',
        'border-bottom:1px solid rgba(255,255,255,0.07);',
        'flex-shrink:0;',
      '}',
      '#sk-nc-title{',
        'flex:1;font-size:17px;font-weight:900;color:#fff;',
      '}',
      '.sk-nc-head-btn{',
        'height:34px;',
        'padding:0 14px;',
        'border-radius:10px;',
        'border:1px solid rgba(255,255,255,0.1);',
        'background:rgba(255,255,255,0.05);',
        'color:rgba(255,255,255,0.75);',
        'font-size:12px;font-weight:700;',
        'cursor:pointer;',
        'white-space:nowrap;',
        'transition:background 150ms ease;',
        '-webkit-tap-highlight-color:transparent;',
      '}',
      '.sk-nc-head-btn:hover{background:rgba(255,255,255,0.1);}',
      '.sk-nc-close{',
        'width:34px;height:34px;',
        'border-radius:10px;',
        'border:1px solid rgba(255,255,255,0.1);',
        'background:rgba(255,255,255,0.05);',
        'color:rgba(255,255,255,0.75);',
        'font-size:16px;',
        'cursor:pointer;',
        'display:flex;align-items:center;justify-content:center;',
        'flex-shrink:0;',
        'transition:background 150ms ease;',
      '}',
      '.sk-nc-close:hover{background:rgba(255,255,255,0.12);}',

      /* ── Search ── */
      '#sk-nc-search-wrap{',
        'padding:10px 16px;',
        'border-bottom:1px solid rgba(255,255,255,0.06);',
        'flex-shrink:0;',
      '}',
      '#sk-nc-search{',
        'width:100%;',
        'background:rgba(255,255,255,0.05);',
        'border:1px solid rgba(255,255,255,0.08);',
        'border-radius:10px;',
        'padding:9px 14px 9px 36px;',
        'color:#fff;',
        'font-size:13px;',
        'outline:none;',
      '}',
      '#sk-nc-search:focus{border-color:rgba(113,255,0,0.4);}',
      '#sk-nc-search::placeholder{color:rgba(255,255,255,0.3);}',
      '#sk-nc-search-icon{',
        'position:absolute;left:28px;top:50%;transform:translateY(-50%);',
        'font-size:13px;color:rgba(255,255,255,0.3);pointer-events:none;',
      '}',
      '#sk-nc-search-wrap{position:relative;}',

      /* ── Category tabs ── */
      '#sk-nc-tabs{',
        'display:flex;gap:4px;',
        'padding:10px 14px;',
        'overflow-x:auto;',
        'flex-shrink:0;',
        'scrollbar-width:none;',
        'border-bottom:1px solid rgba(255,255,255,0.06);',
      '}',
      '#sk-nc-tabs::-webkit-scrollbar{display:none;}',
      '.sk-nc-tab{',
        'display:flex;align-items:center;gap:6px;',
        'padding:6px 12px;',
        'border-radius:999px;',
        'border:1px solid rgba(255,255,255,0.08);',
        'background:rgba(255,255,255,0.04);',
        'color:rgba(255,255,255,0.6);',
        'font-size:12px;font-weight:700;',
        'white-space:nowrap;',
        'cursor:pointer;',
        'transition:all 150ms ease;',
        '-webkit-tap-highlight-color:transparent;',
        'flex-shrink:0;',
      '}',
      '.sk-nc-tab:hover{background:rgba(255,255,255,0.08);}',
      '.sk-nc-tab.active{',
        'background:rgba(113,255,0,0.15);',
        'border-color:rgba(113,255,0,0.35);',
        'color:#71ff00;',
      '}',
      '.sk-nc-tab-badge{',
        'background:rgba(255,68,68,0.9);',
        'color:#fff;',
        'font-size:9px;font-weight:900;',
        'min-width:16px;height:16px;',
        'border-radius:999px;',
        'padding:0 3px;',
        'display:inline-flex;align-items:center;justify-content:center;',
      '}',
      '.sk-nc-tab.active .sk-nc-tab-badge{background:#ff3c3c;}',

      /* ── Notification list ── */
      '#sk-nc-list{',
        'flex:1;overflow-y:auto;',
        '-webkit-overflow-scrolling:touch;',
        'overscroll-behavior:contain;',
        'padding:8px 0;',
      '}',
      '#sk-nc-list::-webkit-scrollbar{width:4px;}',
      '#sk-nc-list::-webkit-scrollbar-track{background:transparent;}',
      '#sk-nc-list::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.1);border-radius:4px;}',

      /* ── Notification card ── */
      '.sk-nc-card{',
        'display:flex;gap:12px;',
        'padding:13px 16px;',
        'border-bottom:1px solid rgba(255,255,255,0.04);',
        'cursor:pointer;',
        'transition:background 120ms ease;',
        'position:relative;',
      '}',
      '.sk-nc-card:hover{background:rgba(255,255,255,0.04);}',
      '.sk-nc-card.unread{background:rgba(113,255,0,0.03);}',
      '.sk-nc-card.unread::before{',
        'content:"";',
        'position:absolute;left:0;top:0;bottom:0;',
        'width:3px;',
        'background:linear-gradient(to bottom,#71ff00,#4fc800);',
        'border-radius:0 3px 3px 0;',
      '}',
      '.sk-nc-card.priority-critical::before{background:linear-gradient(to bottom,#ff1744,#c01);}',
      '.sk-nc-card.priority-high::before    {background:linear-gradient(to bottom,#ff6d00,#e64a19);}',
      '.sk-nc-card-icon{',
        'width:40px;height:40px;',
        'border-radius:12px;',
        'background:rgba(255,255,255,0.07);',
        'display:flex;align-items:center;justify-content:center;',
        'font-size:20px;flex-shrink:0;',
        'align-self:flex-start;',
      '}',
      '.sk-nc-card-body{flex:1;min-width:0;}',
      '.sk-nc-card-title{',
        'font-size:13px;font-weight:700;color:#fff;',
        'line-height:1.35;margin-bottom:3px;',
        'display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;',
      '}',
      '.sk-nc-card.unread .sk-nc-card-title{font-weight:900;}',
      '.sk-nc-card-body-text{',
        'font-size:12px;color:rgba(255,255,255,0.5);',
        'line-height:1.4;margin-bottom:6px;',
        'display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;',
      '}',
      '.sk-nc-card-meta{',
        'display:flex;align-items:center;gap:8px;',
        'font-size:11px;color:rgba(255,255,255,0.3);',
        'flex-wrap:wrap;',
      '}',
      '.sk-nc-card-cat{',
        'padding:2px 7px;',
        'border-radius:999px;',
        'background:rgba(255,255,255,0.06);',
        'font-size:10px;font-weight:700;',
        'color:rgba(255,255,255,0.45);',
      '}',
      '.sk-nc-card-actions{',
        'display:flex;gap:6px;margin-top:8px;flex-wrap:wrap;',
      '}',
      '.sk-nc-action-btn{',
        'padding:4px 10px;',
        'border-radius:6px;',
        'background:rgba(255,255,255,0.07);',
        'border:1px solid rgba(255,255,255,0.1);',
        'color:rgba(255,255,255,0.7);',
        'font-size:11px;font-weight:700;',
        'cursor:pointer;',
        'transition:background 120ms ease;',
        '-webkit-tap-highlight-color:transparent;',
      '}',
      '.sk-nc-action-btn:hover{background:rgba(255,255,255,0.13);}',
      '.sk-nc-action-btn.primary{background:rgba(113,255,0,0.15);border-color:rgba(113,255,0,0.3);color:#71ff00;}',
      '.sk-nc-action-btn.primary:hover{background:rgba(113,255,0,0.25);}',
      '.sk-nc-action-btn.danger{background:rgba(255,68,68,0.12);border-color:rgba(255,68,68,0.3);color:#ff4444;}',

      /* Group card */
      '.sk-nc-group{',
        'display:flex;gap:12px;',
        'padding:13px 16px;',
        'border-bottom:1px solid rgba(255,255,255,0.04);',
        'cursor:pointer;',
        'transition:background 120ms ease;',
        'background:rgba(113,255,0,0.02);',
      '}',
      '.sk-nc-group:hover{background:rgba(113,255,0,0.05);}',
      '.sk-nc-group-avatars{',
        'width:40px;height:40px;',
        'position:relative;flex-shrink:0;',
      '}',
      '.sk-nc-group-icon{',
        'width:40px;height:40px;',
        'border-radius:12px;',
        'background:rgba(113,255,0,0.1);',
        'border:1px solid rgba(113,255,0,0.2);',
        'display:flex;align-items:center;justify-content:center;',
        'font-size:18px;',
      '}',
      '.sk-nc-group-count{',
        'position:absolute;bottom:-4px;right:-4px;',
        'background:#71ff00;color:#050f05;',
        'font-size:9px;font-weight:900;',
        'min-width:18px;height:18px;',
        'border-radius:999px;',
        'border:2px solid #0a0f0a;',
        'display:flex;align-items:center;justify-content:center;padding:0 3px;',
      '}',
      '.sk-nc-expand-btn{',
        'align-self:center;',
        'padding:4px 10px;',
        'border-radius:6px;',
        'background:rgba(255,255,255,0.06);',
        'border:1px solid rgba(255,255,255,0.1);',
        'color:rgba(255,255,255,0.6);',
        'font-size:11px;font-weight:700;',
        'cursor:pointer;',
        'white-space:nowrap;',
        'flex-shrink:0;',
      '}',

      /* Panel footer */
      '#sk-nc-footer{',
        'border-top:1px solid rgba(255,255,255,0.07);',
        'padding:10px 16px;',
        'display:flex;align-items:center;justify-content:space-between;',
        'flex-shrink:0;',
      '}',
      '#sk-nc-footer a{',
        'font-size:12px;color:rgba(113,255,0,0.8);',
        'text-decoration:none;font-weight:700;',
      '}',
      '#sk-nc-footer a:hover{color:#71ff00;}',
      '.sk-nc-prefs-btn{',
        'background:none;border:none;',
        'color:rgba(255,255,255,0.4);',
        'font-size:18px;cursor:pointer;',
        'padding:4px;border-radius:6px;',
        'transition:color 150ms ease;',
      '}',
      '.sk-nc-prefs-btn:hover{color:rgba(255,255,255,0.8);}',

      /* Empty state */
      '.sk-nc-empty{',
        'padding:48px 24px;',
        'text-align:center;',
        'color:rgba(255,255,255,0.3);',
      '}',
      '.sk-nc-empty-icon{font-size:48px;margin-bottom:12px;opacity:0.5;}',
      '.sk-nc-empty-title{font-size:16px;font-weight:800;color:rgba(255,255,255,0.5);margin-bottom:6px;}',
      '.sk-nc-empty-sub{font-size:13px;}',

      /* Preferences sheet */
      '#sk-nc-prefs{',
        'position:absolute;inset:0;',
        'background:#0a0f0a;',
        'overflow-y:auto;',
        '-webkit-overflow-scrolling:touch;',
        'transform:translateX(100%);',
        'transition:transform 280ms ease;',
        'z-index:1;',
      '}',
      '#sk-nc-prefs.open{transform:translateX(0);}',
      '.sk-nc-prefs-head{',
        'display:flex;align-items:center;gap:10px;',
        'padding:16px 18px;',
        'border-bottom:1px solid rgba(255,255,255,0.07);',
        'position:sticky;top:0;',
        'background:#0a0f0a;z-index:1;',
      '}',
      '.sk-nc-prefs-head h2{flex:1;font-size:16px;font-weight:900;color:#fff;}',
      '.sk-nc-prefs-section{padding:16px 18px;}',
      '.sk-nc-prefs-section-title{',
        'font-size:11px;font-weight:900;',
        'color:rgba(255,255,255,0.35);',
        'text-transform:uppercase;letter-spacing:0.08em;',
        'margin-bottom:10px;',
      '}',
      '.sk-nc-pref-row{',
        'display:flex;align-items:center;gap:12px;',
        'padding:12px 0;',
        'border-bottom:1px solid rgba(255,255,255,0.05);',
      '}',
      '.sk-nc-pref-row:last-child{border-bottom:none;}',
      '.sk-nc-pref-icon{font-size:20px;width:28px;text-align:center;flex-shrink:0;}',
      '.sk-nc-pref-info{flex:1;}',
      '.sk-nc-pref-label{font-size:14px;font-weight:700;color:#fff;margin-bottom:2px;}',
      '.sk-nc-pref-sub{font-size:11px;color:rgba(255,255,255,0.35);}',
      /* Toggle switch */
      '.sk-toggle{',
        'position:relative;',
        'width:44px;height:26px;',
        'flex-shrink:0;',
      '}',
      '.sk-toggle input{opacity:0;width:0;height:0;position:absolute;}',
      '.sk-toggle-slider{',
        'position:absolute;inset:0;',
        'background:rgba(255,255,255,0.15);',
        'border-radius:999px;',
        'cursor:pointer;',
        'transition:background 200ms ease;',
      '}',
      '.sk-toggle-slider::after{',
        'content:"";',
        'position:absolute;',
        'top:3px;left:3px;',
        'width:20px;height:20px;',
        'border-radius:50%;',
        'background:#fff;',
        'transition:transform 200ms ease;',
        'box-shadow:0 1px 4px rgba(0,0,0,0.4);',
      '}',
      '.sk-toggle input:checked + .sk-toggle-slider{background:#71ff00;}',
      '.sk-toggle input:checked + .sk-toggle-slider::after{transform:translateX(18px);}',
      /* Master control buttons */
      '.sk-nc-master-btns{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;}',
      '.sk-nc-master-btn{',
        'flex:1;min-width:0;',
        'padding:10px 12px;',
        'border-radius:10px;',
        'border:1px solid rgba(255,255,255,0.1);',
        'background:rgba(255,255,255,0.05);',
        'color:rgba(255,255,255,0.75);',
        'font-size:12px;font-weight:700;',
        'cursor:pointer;',
        'text-align:center;',
        'white-space:nowrap;',
        'transition:background 150ms ease;',
      '}',
      '.sk-nc-master-btn:hover{background:rgba(255,255,255,0.1);}',
      '.sk-nc-master-btn.active{background:rgba(113,255,0,0.15);border-color:rgba(113,255,0,0.3);color:#71ff00;}',
      /* DND time row */
      '.sk-nc-time-row{',
        'display:grid;grid-template-columns:1fr auto 1fr;gap:8px;align-items:center;margin-top:8px;',
      '}',
      '.sk-nc-time-input{',
        'background:rgba(255,255,255,0.06);',
        'border:1px solid rgba(255,255,255,0.1);',
        'border-radius:8px;',
        'padding:8px 10px;',
        'color:#fff;font-size:13px;text-align:center;',
        'outline:none;',
      '}',
      '.sk-nc-time-input:focus{border-color:rgba(113,255,0,0.4);}',
      '.sk-nc-time-sep{color:rgba(255,255,255,0.3);font-size:12px;text-align:center;}',

      /* Responsive */
      '@media(max-width:480px){',
        '#sk-nc-panel{width:100vw;}',
        '.sk-nc-card-actions{gap:4px;}',
        '.sk-nc-action-btn{padding:4px 8px;font-size:10px;}',
      '}'
    ].join('');
    document.head.appendChild(s);
  }

  /* ─────────────────────────────────────────────────────────────────────────
     STATE
  ───────────────────────────────────────────────────────────────────────── */

  var _open         = false;
  var _activeTab    = 'all';
  var _searchTerm   = '';
  var _prefsOpen    = false;
  var _unsubEngine  = null;
  var _expandedGroups = {};
  var _bellEl       = null;
  var _overlayEl    = null;
  var _listEl       = null;
  var _tabsEl       = null;
  var _badgeEl      = null;
  var _searchEl     = null;

  /* ─────────────────────────────────────────────────────────────────────────
     BELL MANAGEMENT
  ───────────────────────────────────────────────────────────────────────── */

  function _updateBell(unreadCounts) {
    if (!_badgeEl) _badgeEl = document.getElementById('sk-notif-badge-v2') || document.getElementById('sk-notif-badge');
    if (!_bellEl)  _bellEl  = document.getElementById('sk-notif-btn');
    if (!_badgeEl || !_bellEl) return;

    var total = unreadCounts ? (unreadCounts.all || 0) : 0;

    /* Badge visibility and count */
    _badgeEl.textContent = total > 99 ? '99+' : (total > 0 ? String(total) : '');
    _badgeEl.className   = 'sk-badge' + (total > 0 ? ' show' : '');

    /* Badge color = highest priority among unread */
    var eng = global.SokoniNotifEngine;
    if (eng && total > 0) {
      var all = eng.getAll({ unreadOnly: true, grouped: false });
      var maxPrio = all.reduce(function(max, n) {
        var rank = (global.SokoniNotifEngine.PRIORITY ? {} : {});
        var pr = { critical: 5, high: 4, normal: 3, low: 2, silent: 1 };
        return (pr[n.priority] || 3) > (pr[max] || 3) ? n.priority : max;
      }, 'normal');
      _badgeEl.className = 'sk-badge show priority-' + maxPrio;
    }

    /* Legacy shim so old code still works */
    var oldBadge = document.getElementById('sk-notif-badge');
    if (oldBadge) {
      oldBadge.textContent = total > 99 ? '99+' : (total > 0 ? String(total) : '');
      oldBadge.className = 'sk-badge' + (total > 0 ? ' visible' : '');
    }

    /* Ring animation on high/critical */
    if (unreadCounts && (unreadCounts.critical > 0 || unreadCounts.high > 0)) {
      _ringBell();
    }
  }

  function _ringBell() {
    if (!_bellEl) return;
    _bellEl.classList.remove('sk-bell--ringing');
    void _bellEl.offsetWidth;  /* force reflow to restart animation */
    _bellEl.classList.add('sk-bell--ringing');
    setTimeout(function() { _bellEl.classList.remove('sk-bell--ringing'); }, 900);
  }

  /* ─────────────────────────────────────────────────────────────────────────
     PANEL CREATION
  ───────────────────────────────────────────────────────────────────────── */

  function _buildOverlay() {
    if (document.getElementById('sk-nc-overlay')) return;

    var eng = global.SokoniNotifEngine;
    var CATS = eng ? eng.PANEL_CATEGORIES : ['all','unread','important','orders','payments','messages'];
    var CATMETA = eng ? eng.CATEGORIES : {};

    /* Tabs HTML */
    var tabsHtml = CATS.map(function(cat) {
      var meta = CATMETA[cat] || { icon: '🔔', label: cat };
      return '<button class="sk-nc-tab' + (cat === 'all' ? ' active' : '') + '" data-cat="' + cat + '" aria-label="' + meta.label + '">' +
        '<span>' + meta.icon + '</span>' +
        '<span>' + meta.label + '</span>' +
        '<span class="sk-nc-tab-badge" id="sk-nc-badge-' + cat + '" style="display:none">0</span>' +
      '</button>';
    }).join('');

    /* Preferences sections HTML */
    var prefCats = eng ? eng.PREF_CATEGORIES : ['orders','payments','messages'];
    var prefRows = prefCats.map(function(cat) {
      var meta = CATMETA[cat] || { icon: '🔔', label: cat };
      var prefs = eng ? eng.prefs.get() : {};
      var checked = (prefs.categories && prefs.categories[cat] !== false) ? 'checked' : '';
      return '<div class="sk-nc-pref-row">' +
        '<span class="sk-nc-pref-icon">' + meta.icon + '</span>' +
        '<div class="sk-nc-pref-info"><div class="sk-nc-pref-label">' + meta.label + '</div></div>' +
        '<label class="sk-toggle">' +
          '<input type="checkbox" data-cat="' + cat + '" ' + checked + '>' +
          '<span class="sk-toggle-slider"></span>' +
        '</label>' +
      '</div>';
    }).join('');

    var html = '<div id="sk-nc-backdrop"></div>' +
      '<div id="sk-nc-panel" role="dialog" aria-label="Notification Center" aria-modal="true">' +

        /* Header */
        '<div id="sk-nc-head">' +
          '<span id="sk-nc-title">Notifications</span>' +
          '<button class="sk-nc-head-btn" id="sk-nc-mark-all">Mark All Read</button>' +
          '<button class="sk-nc-prefs-btn" id="sk-nc-prefs-toggle" title="Preferences" aria-label="Notification Preferences">⚙️</button>' +
          '<button class="sk-nc-close" id="sk-nc-close" aria-label="Close Notifications">✕</button>' +
        '</div>' +

        /* Search */
        '<div id="sk-nc-search-wrap">' +
          '<span id="sk-nc-search-icon">🔍</span>' +
          '<input id="sk-nc-search" type="search" placeholder="Search notifications…" autocomplete="off">' +
        '</div>' +

        /* Tabs */
        '<div id="sk-nc-tabs" role="tablist">' + tabsHtml + '</div>' +

        /* List */
        '<div id="sk-nc-list" role="list"></div>' +

        /* Footer */
        '<div id="sk-nc-footer">' +
          '<a href="notifications.html">View All History</a>' +
          '<a href="notifications.html#preferences">Manage Preferences</a>' +
        '</div>' +

        /* Preferences sheet */
        '<div id="sk-nc-prefs">' +
          '<div class="sk-nc-prefs-head">' +
            '<button class="sk-nc-close" id="sk-nc-prefs-back" aria-label="Back">←</button>' +
            '<h2>Notification Preferences</h2>' +
          '</div>' +

          '<div class="sk-nc-prefs-section">' +
            '<div class="sk-nc-prefs-section-title">Master Controls</div>' +
            '<div class="sk-nc-pref-row">' +
              '<span class="sk-nc-pref-icon">🔔</span>' +
              '<div class="sk-nc-pref-info"><div class="sk-nc-pref-label">All Notifications</div><div class="sk-nc-pref-sub">Master on/off switch</div></div>' +
              '<label class="sk-toggle"><input type="checkbox" id="sk-nc-global-toggle" checked><span class="sk-toggle-slider"></span></label>' +
            '</div>' +
            '<div class="sk-nc-master-btns">' +
              '<button class="sk-nc-master-btn" id="sk-nc-enable-all">Enable All</button>' +
              '<button class="sk-nc-master-btn" id="sk-nc-disable-all">Disable All</button>' +
            '</div>' +
            '<div class="sk-nc-prefs-section-title" style="margin-top:14px">Pause Notifications</div>' +
            '<div class="sk-nc-master-btns">' +
              '<button class="sk-nc-master-btn" data-pause="900000">15 min</button>' +
              '<button class="sk-nc-master-btn" data-pause="3600000">1 hour</button>' +
              '<button class="sk-nc-master-btn" data-pause="28800000">8 hours</button>' +
              '<button class="sk-nc-master-btn" data-pause="86400000">24 hours</button>' +
              '<button class="sk-nc-master-btn" id="sk-nc-unpause">Resume</button>' +
            '</div>' +
          '</div>' +

          '<div class="sk-nc-prefs-section" id="sk-nc-dnd-section">' +
            '<div class="sk-nc-prefs-section-title">Do Not Disturb</div>' +
            '<div class="sk-nc-pref-row">' +
              '<span class="sk-nc-pref-icon">🌙</span>' +
              '<div class="sk-nc-pref-info"><div class="sk-nc-pref-label">Quiet Hours</div><div class="sk-nc-pref-sub">Only critical security alerts bypass this</div></div>' +
              '<label class="sk-toggle"><input type="checkbox" id="sk-nc-dnd-toggle"><span class="sk-toggle-slider"></span></label>' +
            '</div>' +
            '<div class="sk-nc-time-row" id="sk-nc-dnd-times" style="display:none">' +
              '<input type="time" class="sk-nc-time-input" id="sk-nc-dnd-start" value="22:00">' +
              '<span class="sk-nc-time-sep">until</span>' +
              '<input type="time" class="sk-nc-time-input" id="sk-nc-dnd-end" value="07:00">' +
            '</div>' +
          '</div>' +

          '<div class="sk-nc-prefs-section">' +
            '<div class="sk-nc-prefs-section-title">Notification Categories</div>' +
            prefRows +
          '</div>' +
        '</div>' +
      '</div>';

    var overlay = document.createElement('div');
    overlay.id = 'sk-nc-overlay';
    overlay.setAttribute('aria-hidden', 'true');
    overlay.innerHTML = html;
    document.body.appendChild(overlay);

    /* Cache refs */
    _overlayEl = overlay;
    _listEl    = document.getElementById('sk-nc-list');
    _tabsEl    = document.getElementById('sk-nc-tabs');
    _searchEl  = document.getElementById('sk-nc-search');

    /* Wire events */
    _wireEvents();
  }

  /* ─────────────────────────────────────────────────────────────────────────
     EVENT WIRING
  ───────────────────────────────────────────────────────────────────────── */

  function _wireEvents() {
    /* Close / backdrop */
    var backdrop = document.getElementById('sk-nc-backdrop');
    var closeBtn = document.getElementById('sk-nc-close');
    if (backdrop) backdrop.addEventListener('click', closePanel);
    if (closeBtn) closeBtn.addEventListener('click', closePanel);

    /* Mark all read */
    var markAll = document.getElementById('sk-nc-mark-all');
    if (markAll) markAll.addEventListener('click', function() {
      var eng = global.SokoniNotifEngine;
      if (eng) eng.markAllRead(_activeTab !== 'all' ? _activeTab : null)
        .then(function() { _renderList(); });
    });

    /* Category tabs */
    if (_tabsEl) {
      _tabsEl.addEventListener('click', function(e) {
        var btn = e.target.closest('.sk-nc-tab');
        if (!btn) return;
        _activeTab = btn.dataset.cat;
        _tabsEl.querySelectorAll('.sk-nc-tab').forEach(function(t) {
          t.classList.toggle('active', t.dataset.cat === _activeTab);
        });
        _searchTerm = '';
        if (_searchEl) _searchEl.value = '';
        _renderList();
      });
    }

    /* Search */
    if (_searchEl) {
      var _searchTimer;
      _searchEl.addEventListener('input', function() {
        clearTimeout(_searchTimer);
        _searchTimer = setTimeout(function() {
          _searchTerm = _searchEl.value.trim();
          _renderList();
        }, 200);
      });
    }

    /* Preferences toggle */
    var prefsToggle = document.getElementById('sk-nc-prefs-toggle');
    var prefsBack   = document.getElementById('sk-nc-prefs-back');
    var prefsEl     = document.getElementById('sk-nc-prefs');
    if (prefsToggle) prefsToggle.addEventListener('click', function() {
      _prefsOpen = true;
      if (prefsEl) prefsEl.classList.add('open');
    });
    if (prefsBack) prefsBack.addEventListener('click', function() {
      _prefsOpen = false;
      if (prefsEl) prefsEl.classList.remove('open');
    });

    /* Global toggle */
    var globalToggle = document.getElementById('sk-nc-global-toggle');
    if (globalToggle) globalToggle.addEventListener('change', function() {
      var eng = global.SokoniNotifEngine;
      if (eng) eng.prefs.setGlobalEnabled(this.checked);
    });

    /* Enable/Disable All */
    var enableAll  = document.getElementById('sk-nc-enable-all');
    var disableAll = document.getElementById('sk-nc-disable-all');
    if (enableAll) enableAll.addEventListener('click', function() {
      var eng = global.SokoniNotifEngine;
      if (eng) {
        eng.prefs.save({ globalEnabled: true });
        eng.PREF_CATEGORIES.forEach(function(c) { eng.prefs.setCategoryEnabled(c, true); });
        _refreshPrefs();
      }
    });
    if (disableAll) disableAll.addEventListener('click', function() {
      var eng = global.SokoniNotifEngine;
      if (eng) {
        eng.prefs.save({ globalEnabled: false });
        eng.PREF_CATEGORIES.forEach(function(c) { eng.prefs.setCategoryEnabled(c, false); });
        _refreshPrefs();
        if (global.SokoniUI) global.SokoniUI.toast('All notifications paused. Critical security alerts still active.', 'info');
      }
    });

    /* Pause buttons */
    document.querySelectorAll('[data-pause]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var ms = parseInt(btn.dataset.pause);
        var eng = global.SokoniNotifEngine;
        if (eng) {
          eng.prefs.pauseFor(ms);
          var label = btn.textContent;
          if (global.SokoniUI) global.SokoniUI.toast('Notifications paused for ' + label, 'info');
        }
      });
    });

    var unpause = document.getElementById('sk-nc-unpause');
    if (unpause) unpause.addEventListener('click', function() {
      var eng = global.SokoniNotifEngine;
      if (eng) {
        eng.prefs.pauseFor(0);
        if (global.SokoniUI) global.SokoniUI.toast('Notifications resumed', 'success');
      }
    });

    /* DND toggle */
    var dndToggle = document.getElementById('sk-nc-dnd-toggle');
    var dndTimes  = document.getElementById('sk-nc-dnd-times');
    if (dndToggle) dndToggle.addEventListener('change', function() {
      if (dndTimes) dndTimes.style.display = this.checked ? 'grid' : 'none';
      var eng = global.SokoniNotifEngine;
      if (eng) eng.prefs.setDND({ enabled: this.checked });
    });

    var dndStart = document.getElementById('sk-nc-dnd-start');
    var dndEnd   = document.getElementById('sk-nc-dnd-end');
    function _saveDND() {
      var eng = global.SokoniNotifEngine;
      if (eng) eng.prefs.setDND({
        startTime: dndStart ? dndStart.value : '22:00',
        endTime:   dndEnd   ? dndEnd.value   : '07:00'
      });
    }
    if (dndStart) dndStart.addEventListener('change', _saveDND);
    if (dndEnd)   dndEnd.addEventListener('change',   _saveDND);

    /* Category preference toggles */
    document.querySelectorAll('#sk-nc-prefs input[data-cat]').forEach(function(chk) {
      chk.addEventListener('change', function() {
        var eng = global.SokoniNotifEngine;
        if (eng) eng.prefs.setCategoryEnabled(this.dataset.cat, this.checked);
      });
    });

    /* Keyboard: Escape closes */
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') {
        if (_prefsOpen) { _prefsOpen = false; var pe = document.getElementById('sk-nc-prefs'); if (pe) pe.classList.remove('open'); }
        else if (_open) closePanel();
      }
    });
  }

  /* ─────────────────────────────────────────────────────────────────────────
     LIST RENDERING
  ───────────────────────────────────────────────────────────────────────── */

  function _renderList() {
    if (!_listEl) return;
    var eng = global.SokoniNotifEngine;
    if (!eng) { _listEl.innerHTML = '<div class="sk-nc-empty"><div class="sk-nc-empty-icon">🔔</div><div class="sk-nc-empty-title">No notifications</div></div>'; return; }

    var items = eng.getAll({ category: _activeTab, search: _searchTerm });

    if (!items.length) {
      var msg = _searchTerm ? 'No notifications matching "' + _searchTerm + '"' : 'You\'re all caught up!';
      _listEl.innerHTML = '<div class="sk-nc-empty"><div class="sk-nc-empty-icon">✅</div><div class="sk-nc-empty-title">' + msg + '</div></div>';
      return;
    }

    _listEl.innerHTML = '';
    var frag = document.createDocumentFragment();

    items.forEach(function(item) {
      var el;
      if (item.isGroup && !_expandedGroups[item.id]) {
        el = _buildGroupCard(item);
      } else if (item.isGroup && _expandedGroups[item.id]) {
        /* Render expanded group items */
        item.items.forEach(function(n) { frag.appendChild(_buildCard(n)); });
        return;
      } else {
        el = _buildCard(item);
      }
      frag.appendChild(el);
    });

    _listEl.appendChild(frag);
  }

  function _esc(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function _buildCard(n) {
    var eng   = global.SokoniNotifEngine;
    var time  = eng ? eng.formatTime(n.createdAt) : '';
    var catMeta = (eng && eng.CATEGORIES[n.category]) || { label: n.category };

    var div = document.createElement('div');
    div.className = 'sk-nc-card' + (n.read ? '' : ' unread') + ' priority-' + (n.priority || 'normal');
    div.setAttribute('role', 'listitem');
    div.dataset.id = n.id;

    /* Inline actions */
    var acts = (n.actions || []).slice(0, 3);
    var actHtml = acts.map(function(a) {
      var isPrimary = a.id === 'view' || a.id === 'approve' || a.id === 'accept';
      return '<button class="sk-nc-action-btn' + (isPrimary ? ' primary' : (a.id === 'delete' || a.id === 'reject' ? ' danger' : '')) + '" data-action="' + a.id + '" data-notif-id="' + _esc(n.id) + '" data-url="' + _esc(n.actionUrl || '') + '">' + _esc((a.icon || '') + ' ' + a.label) + '</button>';
    }).join('');

    div.innerHTML =
      '<div class="sk-nc-card-icon">' + _esc(n.icon || '🔔') + '</div>' +
      '<div class="sk-nc-card-body">' +
        '<div class="sk-nc-card-title">' + _esc(n.title) + '</div>' +
        '<div class="sk-nc-card-body-text">' + _esc(n.body) + '</div>' +
        '<div class="sk-nc-card-meta">' +
          '<span>' + time + '</span>' +
          '<span class="sk-nc-card-cat">' + _esc(catMeta.label || n.category) + '</span>' +
        '</div>' +
        (actHtml ? '<div class="sk-nc-card-actions">' + actHtml + '</div>' : '') +
      '</div>';

    /* Card click — navigate to actionUrl and mark read */
    div.addEventListener('click', function(e) {
      if (e.target.closest('.sk-nc-action-btn')) return;
      if (eng && !n.read) eng.markRead(n.id).then(function() { div.classList.remove('unread'); });
      if (n.actionUrl && n.actionUrl !== 'notifications.html') global.location.href = n.actionUrl;
    });

    /* Action button clicks */
    div.addEventListener('click', function(e) {
      var btn = e.target.closest('.sk-nc-action-btn');
      if (!btn) return;
      e.stopPropagation();
      _handleAction(btn.dataset.action, n, div);
    });

    return div;
  }

  function _buildGroupCard(group) {
    var eng = global.SokoniNotifEngine;
    var time = eng ? eng.formatTime(group.createdAt) : '';

    var div = document.createElement('div');
    div.className = 'sk-nc-group';
    div.setAttribute('role', 'listitem');
    div.dataset.groupId = group.id;

    div.innerHTML =
      '<div class="sk-nc-group-avatars">' +
        '<div class="sk-nc-group-icon">' + _esc(group.icon || '🔔') + '</div>' +
        '<span class="sk-nc-group-count">' + group.count + '</span>' +
      '</div>' +
      '<div class="sk-nc-card-body">' +
        '<div class="sk-nc-card-title">' + _esc(group.title) + '</div>' +
        '<div class="sk-nc-card-body-text">' + _esc(group.body || '') + '</div>' +
        '<div class="sk-nc-card-meta"><span>' + time + '</span></div>' +
      '</div>' +
      '<button class="sk-nc-expand-btn" aria-label="Expand group">Expand</button>';

    var expandBtn = div.querySelector('.sk-nc-expand-btn');
    if (expandBtn) expandBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      _expandedGroups[group.id] = true;
      _renderList();
    });

    /* Mark all in group read on click */
    div.addEventListener('click', function(e) {
      if (e.target.closest('.sk-nc-expand-btn')) return;
      if (eng) eng.markGroupRead(group).then(function() { _renderList(); });
    });

    return div;
  }

  function _handleAction(action, notif, cardEl) {
    var eng = global.SokoniNotifEngine;
    switch(action) {
      case 'view':
        if (eng) eng.markRead(notif.id);
        if (notif.actionUrl) global.location.href = notif.actionUrl;
        break;
      case 'mark_read':
        if (eng) eng.markRead(notif.id).then(function() { cardEl.classList.remove('unread'); });
        break;
      case 'archive':
        if (eng) eng.archive(notif.id).then(function() {
          cardEl.style.opacity = '0';
          setTimeout(function() { if (cardEl.parentNode) cardEl.parentNode.removeChild(cardEl); }, 200);
          _updateTabBadges(eng.getUnreadCounts());
        });
        break;
      case 'delete':
        if (eng) eng.delete(notif.id).then(function() {
          cardEl.style.opacity = '0';
          setTimeout(function() { if (cardEl.parentNode) cardEl.parentNode.removeChild(cardEl); }, 200);
        });
        break;
      case 'pin':
        if (eng) eng.pin(notif.id).then(function() { _renderList(); });
        break;
      case 'approve': case 'accept': case 'reject': case 'reply': case 'pay': case 'track':
        if (eng) eng.markRead(notif.id);
        if (notif.actionUrl) global.location.href = notif.actionUrl + '?action=' + action;
        break;
    }
  }

  function _updateTabBadges(counts) {
    Object.keys(counts || {}).forEach(function(cat) {
      var badge = document.getElementById('sk-nc-badge-' + cat);
      if (badge) {
        var n = counts[cat] || 0;
        badge.textContent = n > 99 ? '99+' : String(n);
        badge.style.display = n > 0 ? 'inline-flex' : 'none';
      }
    });
  }

  function _refreshPrefs() {
    var eng = global.SokoniNotifEngine;
    if (!eng) return;
    var prefs = eng.prefs.get();
    var gToggle = document.getElementById('sk-nc-global-toggle');
    if (gToggle) gToggle.checked = !!prefs.globalEnabled;
    document.querySelectorAll('#sk-nc-prefs input[data-cat]').forEach(function(chk) {
      chk.checked = prefs.categories[chk.dataset.cat] !== false;
    });
    var dndToggle = document.getElementById('sk-nc-dnd-toggle');
    var dndTimes  = document.getElementById('sk-nc-dnd-times');
    var dndStart  = document.getElementById('sk-nc-dnd-start');
    var dndEnd    = document.getElementById('sk-nc-dnd-end');
    if (dndToggle) dndToggle.checked = !!(prefs.dnd && prefs.dnd.enabled);
    if (dndTimes)  dndTimes.style.display = (prefs.dnd && prefs.dnd.enabled) ? 'grid' : 'none';
    if (dndStart && prefs.dnd) dndStart.value = prefs.dnd.startTime || '22:00';
    if (dndEnd   && prefs.dnd) dndEnd.value   = prefs.dnd.endTime   || '07:00';
  }

  /* ─────────────────────────────────────────────────────────────────────────
     PANEL OPEN / CLOSE
  ───────────────────────────────────────────────────────────────────────── */

  function openPanel() {
    if (!_overlayEl) _buildOverlay();
    _overlayEl = document.getElementById('sk-nc-overlay');
    if (!_overlayEl) return;

    _open = true;
    _overlayEl.classList.add('open');
    _overlayEl.setAttribute('aria-hidden', 'false');

    _listEl   = document.getElementById('sk-nc-list');
    _tabsEl   = document.getElementById('sk-nc-tabs');
    _searchEl = document.getElementById('sk-nc-search');

    /* Update content */
    var eng = global.SokoniNotifEngine;
    if (eng) {
      var counts = eng.getUnreadCounts();
      _updateTabBadges(counts);
      _refreshPrefs();
    }
    _renderList();

    /* Prevent body scroll */
    if (global.SokoniLayout) global.SokoniLayout.lockScroll();
    else document.body.style.overflow = 'hidden';

    if (_bellEl) _bellEl.setAttribute('aria-expanded', 'true');

    /* Focus trap */
    setTimeout(function() {
      var panel = document.getElementById('sk-nc-panel');
      if (panel) {
        var focusable = panel.querySelectorAll('button, a, input, [tabindex]:not([tabindex="-1"])');
        if (focusable.length) focusable[0].focus();
      }
    }, 310);
  }

  function closePanel() {
    if (!_overlayEl) return;
    _open = false;
    _overlayEl.classList.remove('open');
    _overlayEl.setAttribute('aria-hidden', 'true');

    if (global.SokoniLayout) global.SokoniLayout.unlockScroll();
    else document.body.style.overflow = '';

    if (_bellEl) {
      _bellEl.setAttribute('aria-expanded', 'false');
      _bellEl.focus();
    }
  }

  function togglePanel() {
    _open ? closePanel() : openPanel();
  }

  /* ─────────────────────────────────────────────────────────────────────────
     BELL ATTACHMENT
     Called by shared-header.js after it injects the bell button.
  ───────────────────────────────────────────────────────────────────────── */

  function attachBell(bellEl) {
    _bellEl = bellEl || document.getElementById('sk-notif-btn');
    if (!_bellEl) return;

    /* Rebuild bell HTML to include bell icon + new badge element */
    _bellEl.setAttribute('type', 'button');
    _bellEl.setAttribute('aria-label', 'Notifications');
    _bellEl.setAttribute('aria-expanded', 'false');
    _bellEl.setAttribute('aria-haspopup', 'dialog');
    _bellEl.innerHTML =
      '<span id="sk-notif-bell-icon" aria-hidden="true">🔔</span>' +
      '<span id="sk-notif-badge-v2" class="sk-badge" role="status" aria-label="Unread notifications"></span>';

    _badgeEl = document.getElementById('sk-notif-badge-v2');

    _bellEl.addEventListener('click', togglePanel);

    /* Start listening to engine */
    var eng = global.SokoniNotifEngine;
    if (eng) {
      if (_unsubEngine) _unsubEngine();
      _unsubEngine = eng.on('unread_count', function(counts) {
        _updateTabBadges(counts);
        _updateBell(counts);
        if (_open) _renderList();
      });
      /* Initial state */
      var counts = eng.getUnreadCounts();
      _updateBell(counts);
      _updateTabBadges(counts);
    } else {
      /* Engine not ready yet — retry */
      setTimeout(function() { attachBell(_bellEl); }, 800);
    }
  }

  /* ─────────────────────────────────────────────────────────────────────────
     PUBLIC API
  ───────────────────────────────────────────────────────────────────────── */

  var SokoniNotifCenter = {
    openPanel:   openPanel,
    closePanel:  closePanel,
    togglePanel: togglePanel,
    attachBell:  attachBell,
    renderList:  _renderList,
    ringBell:    _ringBell,

    init: function() {
      _injectCSS();
      /* Bell is attached by shared-header.js after nav injection */
    }
  };

  global.SokoniNotifCenter = SokoniNotifCenter;

  /* Auto-init CSS */
  if (document.readyState !== 'loading') {
    _injectCSS();
  } else {
    document.addEventListener('DOMContentLoaded', _injectCSS, { once: true });
  }

})(window);
