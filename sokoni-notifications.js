/* ================================================================
   SOKONI — Notification System  (sokoni-notifications.js)

   Features:
   1. In-app notification bell — mounts anywhere via mountBell(el, uid)
   2. Real-time unread badge from Firestore
   3. Notification drawer with mark-as-read
   4. push(targetUid, opts) — write notification to Firestore
   5. Web Push API support (VAPID) — registers service worker

   Collections used:
     notifications/{NTF-xxx}
       targetUid, type, icon, heading, sub, link, read, createdAt

   Exposes: window.SokoniNotifications  +  ES default export
================================================================ */
import { db } from './firebase.js';
import {
  doc, collection, query, where, orderBy, limit, onSnapshot,
  setDoc, updateDoc, writeBatch, serverTimestamp, getDocs,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

/* ── UID helper ── */
function _uid() {
  if (typeof window !== 'undefined' && window.firebaseAuth?.currentUser?.uid)
    return window.firebaseAuth.currentUser.uid;
  try { return JSON.parse(localStorage.getItem('sokoniUser') || 'null')?.uid ?? null; }
  catch { return null; }
}

/* ── Styles injected once ── */
let _stylesInjected = false;
function _injectStyles() {
  if (_stylesInjected || typeof document === 'undefined') return;
  _stylesInjected = true;
  const s = document.createElement('style');
  s.textContent = `
  /* ── Notification Bell ── */
  .snb-wrap{position:relative;display:inline-flex;align-items:center;justify-content:center;}
  .snb-btn{width:38px;height:38px;border-radius:12px;background:rgba(255,255,255,0.05);
    border:1px solid rgba(255,255,255,0.09);display:flex;align-items:center;justify-content:center;
    cursor:pointer;font-size:18px;color:white;transition:.15s;position:relative;
    -webkit-tap-highlight-color:transparent;padding:0;}
  .snb-btn:hover{background:rgba(113,255,0,0.1);border-color:rgba(113,255,0,0.25);}
  .snb-badge{position:absolute;top:-4px;right:-4px;min-width:17px;height:17px;border-radius:999px;
    background:#ff3c3c;color:white;font-size:9px;font-weight:900;display:none;
    align-items:center;justify-content:center;padding:0 3px;border:1.5px solid #060606;}
  .snb-badge.show{display:flex;}

  /* ── Notification Drawer ── */
  .snd-overlay{position:fixed;inset:0;z-index:2000;display:none;}
  .snd-overlay.open{display:block;}
  .snd-backdrop{position:absolute;inset:0;background:rgba(0,0,0,0.55);backdrop-filter:blur(3px);}
  .snd-panel{position:absolute;top:0;right:0;height:100%;width:min(380px,100vw);
    background:#0d0d0d;border-left:1px solid rgba(255,255,255,0.08);
    display:flex;flex-direction:column;overflow:hidden;
    animation:sndSlideIn .22s ease;}
  @keyframes sndSlideIn{from{transform:translateX(100%)}to{transform:translateX(0)}}
  .snd-header{padding:16px 18px;border-bottom:1px solid rgba(255,255,255,0.07);
    display:flex;align-items:center;justify-content:space-between;flex-shrink:0;}
  .snd-title{font-size:15px;font-weight:900;color:white;}
  .snd-mark-all{font-size:11px;font-weight:700;color:rgba(113,255,0,0.7);
    background:none;border:none;cursor:pointer;padding:6px 10px;border-radius:8px;font-family:inherit;}
  .snd-mark-all:hover{background:rgba(113,255,0,0.08);}
  .snd-close{width:30px;height:30px;border-radius:8px;background:rgba(255,255,255,0.06);
    border:1px solid rgba(255,255,255,0.1);color:rgba(255,255,255,0.5);cursor:pointer;
    font-size:16px;display:flex;align-items:center;justify-content:center;}
  .snd-list{flex:1;overflow-y:auto;padding:8px;}
  .snd-list::-webkit-scrollbar{width:4px;}
  .snd-list::-webkit-scrollbar-track{background:transparent;}
  .snd-list::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.1);border-radius:4px;}
  .snd-item{display:flex;gap:12px;padding:12px;border-radius:12px;cursor:pointer;
    transition:.15s;margin-bottom:4px;border:1px solid transparent;}
  .snd-item:hover{background:rgba(255,255,255,0.04);}
  .snd-item.unread{background:rgba(113,255,0,0.04);border-color:rgba(113,255,0,0.1);}
  .snd-item-icon{font-size:22px;flex-shrink:0;width:36px;text-align:center;margin-top:1px;}
  .snd-item-body{flex:1;min-width:0;}
  .snd-item-heading{font-size:13px;font-weight:800;color:white;margin-bottom:2px;}
  .snd-item.unread .snd-item-heading{color:#71ff00;}
  .snd-item-sub{font-size:11px;color:rgba(255,255,255,0.4);line-height:1.4;}
  .snd-item-time{font-size:10px;color:rgba(255,255,255,0.25);margin-top:4px;}
  .snd-dot{width:7px;height:7px;border-radius:50%;background:#71ff00;
    flex-shrink:0;margin-top:5px;}
  .snd-empty{padding:48px 20px;text-align:center;color:rgba(255,255,255,0.2);}
  .snd-empty-icon{font-size:40px;margin-bottom:12px;}
  `;
  document.head.appendChild(s);
}

/* ── Relative time ── */
function _relTime(ts) {
  if (!ts) return '';
  const date = ts?.toDate ? ts.toDate() : new Date(ts);
  const diff = (Date.now() - date.getTime()) / 1000;
  if (diff < 60)    return 'Just now';
  if (diff < 3600)  return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  return Math.floor(diff / 86400) + 'd ago';
}

/* ─────────────────────────────────────────────────────────────
   PUBLIC API
───────────────────────────────────────────────────────────── */
const SokoniNotifications = {

  /* ── push(targetUid, opts) ──
     Write a notification directly (for use by any module).
     opts: { icon, heading, sub, type?, link?, orderId? }
  */
  async push(targetUid, opts) {
    if (!targetUid) return;
    const id = 'NTF-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2, 5);
    await setDoc(doc(db, 'notifications', id), {
      id,
      targetUid,
      type:      opts.type    || 'general',
      orderId:   opts.orderId || null,
      deliveryRef: opts.deliveryRef || null,
      icon:      opts.icon    || '🔔',
      heading:   opts.heading || '',
      sub:       opts.sub     || '',
      link:      opts.link    || null,
      read:      false,
      createdAt: serverTimestamp(),
    }, { merge: true });
    return id;
  },

  /* ── broadcast(heading, sub, opts?) ──
     Send to all users (targetUid = 'broadcast').
  */
  async broadcast(heading, sub, opts) {
    return this.push('broadcast', { heading, sub, ...opts });
  },

  /* ── markRead(fsId) ── */
  async markRead(fsId) {
    await setDoc(doc(db, 'notifications', fsId), { read: true }, { merge: true });
  },

  /* ── markAllRead(uid) ── */
  async markAllRead(uid) {
    const q    = query(collection(db, 'notifications'),
      where('targetUid', 'in', [uid, 'broadcast']),
      where('read', '==', false)
    );
    const snap = await getDocs(q).catch(() => null);
    if (!snap?.docs?.length) return;
    const batch = writeBatch(db);
    snap.docs.forEach(d => batch.update(d.ref, { read: true }));
    await batch.commit();
  },

  /* ── listenForUid(uid, callback) → unsub ── */
  listenForUid(uid, callback, limitN) {
    if (!uid) { callback([]); return () => {}; }
    let q = query(
      collection(db, 'notifications'),
      where('targetUid', 'in', [uid, 'broadcast']),
      orderBy('createdAt', 'desc'),
      limit(limitN || 50)
    );
    return onSnapshot(q,
      snap => callback(snap.docs.map(d => ({ _fsId: d.id, ...d.data() }))),
      err  => console.warn('[SokoniNotifications] listen:', err.message)
    );
  },

  /* ── mountBell(containerEl, uid) ──
     Injects bell icon + drawer into any container element.
     Call once per page. Returns { destroy, refresh } controls.
  */
  mountBell(containerEl, uid) {
    if (!containerEl) return { destroy: () => {}, refresh: () => {} };
    _injectStyles();

    /* Bell HTML */
    const bellId    = 'snb-' + Math.random().toString(36).slice(2, 7);
    const drawerId  = 'snd-' + Math.random().toString(36).slice(2, 7);
    containerEl.innerHTML = `
      <div class="snb-wrap" id="${bellId}">
        <button class="snb-btn" onclick="document.getElementById('${drawerId}').classList.add('open')" aria-label="Notifications">
          🔔
          <span class="snb-badge" id="${bellId}-badge"></span>
        </button>
      </div>
      <div class="snd-overlay" id="${drawerId}">
        <div class="snd-backdrop" onclick="document.getElementById('${drawerId}').classList.remove('open')"></div>
        <div class="snd-panel">
          <div class="snd-header">
            <span class="snd-title">🔔 Notifications</span>
            <div style="display:flex;gap:8px;align-items:center;">
              <button class="snd-mark-all" onclick="_sndMarkAll_${bellId}()">Mark all read</button>
              <button class="snd-close" onclick="document.getElementById('${drawerId}').classList.remove('open')">✕</button>
            </div>
          </div>
          <div class="snd-list" id="${drawerId}-list"></div>
        </div>
      </div>`;

    let _unreadCount = 0;
    let _allNotifs   = [];

    const _renderList = (notifs) => {
      _allNotifs   = notifs;
      _unreadCount = notifs.filter(n => !n.read).length;
      const badgeEl = document.getElementById(`${bellId}-badge`);
      if (badgeEl) {
        badgeEl.textContent = _unreadCount > 99 ? '99+' : String(_unreadCount);
        badgeEl.classList.toggle('show', _unreadCount > 0);
      }
      const listEl = document.getElementById(`${drawerId}-list`);
      if (!listEl) return;
      if (!notifs.length) {
        listEl.innerHTML = `<div class="snd-empty"><div class="snd-empty-icon">🔔</div><div>No notifications yet</div></div>`;
        return;
      }
      listEl.innerHTML = notifs.map(n => `
        <div class="snd-item ${n.read ? '' : 'unread'}"
             onclick="_sndClick_${bellId}('${n._fsId}', '${(n.link||'').replace(/'/g,'')}')">
          <div class="snd-item-icon">${n.icon || '🔔'}</div>
          <div class="snd-item-body">
            <div class="snd-item-heading">${_esc(n.heading || '')}</div>
            <div class="snd-item-sub">${_esc(n.sub || '')}</div>
            <div class="snd-item-time">${_relTime(n.createdAt)}</div>
          </div>
          ${!n.read ? '<div class="snd-dot"></div>' : ''}
        </div>`).join('');
    };

    /* Global handlers scoped to this bell instance */
    window[`_sndClick_${bellId}`] = async (fsId, link) => {
      await SokoniNotifications.markRead(fsId).catch(() => {});
      document.getElementById(drawerId)?.classList.remove('open');
      if (link) window.location.href = link;
    };
    window[`_sndMarkAll_${bellId}`] = async () => {
      if (uid) await SokoniNotifications.markAllRead(uid).catch(() => {});
    };

    /* Start listener */
    let _unsub = () => {};
    const _startListen = (resolvedUid) => {
      _unsub();
      _unsub = SokoniNotifications.listenForUid(resolvedUid, _renderList, 50);
    };

    if (uid) {
      _startListen(uid);
    } else {
      /* Wait for Firebase Auth to resolve */
      const _tryAuth = setInterval(() => {
        const u = _uid();
        if (u) { clearInterval(_tryAuth); _startListen(u); }
      }, 1000);
      setTimeout(() => clearInterval(_tryAuth), 15000);
    }

    return {
      destroy() {
        _unsub();
        delete window[`_sndClick_${bellId}`];
        delete window[`_sndMarkAll_${bellId}`];
        containerEl.innerHTML = '';
      },
      refresh(newUid) {
        if (newUid) _startListen(newUid);
      },
    };
  },

  /* ── getUnreadCount(uid) → Promise<number> ── */
  async getUnreadCount(uid) {
    if (!uid) return 0;
    const q    = query(collection(db, 'notifications'),
      where('targetUid', 'in', [uid, 'broadcast']),
      where('read', '==', false)
    );
    const snap = await getDocs(q).catch(() => null);
    return snap?.size ?? 0;
  },
};

/* ── HTML escape ── */
function _esc(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* ── Global exposure ── */
if (typeof window !== 'undefined') {
  window.SokoniNotifications = SokoniNotifications;
  window.dispatchEvent(new CustomEvent('sokoniNotificationsReady'));
}

export default SokoniNotifications;
