/* ================================================================
   SOKONI — Multi-Device Session Manager
   Tracks active sessions per user in Firestore.
   Features:
     • One session document per device/tab per login
     • Real-time revocation — kicked devices log out instantly
     • Profile page can list & revoke individual sessions
     • "Log out all other devices" support
================================================================ */
import { db } from './firebase.js';
import {
  doc, setDoc, updateDoc, deleteDoc, collection,
  query, where, getDocs, onSnapshot, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

/* ─── Helpers ─── */
function _getUser() {
  try { return JSON.parse(localStorage.getItem('sokoniUser')); } catch { return null; }
}

function _getSessionId() {
  return localStorage.getItem('sokoniSessionId');
}

function _makeSessionId() {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return 'SID_' + Array.from(arr).map(b => b.toString(16).padStart(2,'0')).join('');
}

function _getDeviceInfo() {
  const ua = navigator.userAgent;
  let deviceName = 'PC';
  let deviceType = 'desktop';
  let deviceIcon = '🖥️';

  if (/android/i.test(ua))       { deviceType = 'mobile';  deviceName = 'Android'; deviceIcon = '📱'; }
  else if (/iphone/i.test(ua))   { deviceType = 'mobile';  deviceName = 'iPhone';  deviceIcon = '📱'; }
  else if (/ipad/i.test(ua))     { deviceType = 'tablet';  deviceName = 'iPad';    deviceIcon = '📱'; }
  else if (/windows/i.test(ua))  { deviceName = 'Windows PC'; deviceIcon = '💻'; }
  else if (/macintosh/i.test(ua)){ deviceName = 'Mac';        deviceIcon = '💻'; }
  else if (/linux/i.test(ua))    { deviceName = 'Linux PC';   deviceIcon = '🖥️'; }

  let browser = 'Browser';
  if      (/edg\//i.test(ua))       browser = 'Edge';
  else if (/opr\//i.test(ua))       browser = 'Opera';
  else if (/chrome/i.test(ua))      browser = 'Chrome';
  else if (/firefox/i.test(ua))     browser = 'Firefox';
  else if (/safari/i.test(ua))      browser = 'Safari';

  return {
    deviceType, deviceName, deviceIcon, browser,
    displayName: `${browser} on ${deviceName}`,
  };
}

function _safeEmail(email) {
  return (email || '').toLowerCase().trim();
}

/* ─── Create session on login ─── */
async function createSession(userEmail) {
  if (!userEmail) return;
  let sid = _makeSessionId();
  localStorage.setItem('sokoniSessionId', sid);

  const device = _getDeviceInfo();
  try {
    await setDoc(doc(db, 'userSessions', sid), {
      sessionId: sid,
      userEmail: _safeEmail(userEmail),
      ...device,
      createdAt:  serverTimestamp(),
      lastActive: serverTimestamp(),
      active: true,
    });
  } catch (e) {
    console.warn('[SokoniSessions] createSession error:', e.message);
  }
  return sid;
}

/* ─── Touch session (update lastActive) ─── */
async function touchSession() {
  const sid  = _getSessionId();
  const user = _getUser();
  if (!sid || !user?.email) return;
  try {
    await setDoc(doc(db, 'userSessions', sid),
      { lastActive: serverTimestamp() }, { merge: true });
  } catch (_) {}
}

/* ─── Watch current session for remote revocation ─── */
let _unsubWatch = null;
function watchSession() {
  const sid  = _getSessionId();
  const user = _getUser();
  if (!sid || !user?.email) return;

  if (_unsubWatch) { _unsubWatch(); _unsubWatch = null; }

  _unsubWatch = onSnapshot(doc(db, 'userSessions', sid), snap => {
    /* Only force logout when explicitly revoked (active set to false by another device/admin).
       Treat snap.exists() === false as a transient state (write still in flight on login)
       so we never log the user out due to a race condition on page load. */
    if (snap.exists() && snap.data()?.active === false) {
      _forceLogout('Your session was ended from another device.');
    }
  }, err => console.warn('[SokoniSessions] watch error:', err.message));
}

/* ─── Delete current session on voluntary logout ─── */
async function deleteCurrentSession() {
  const sid = _getSessionId();
  if (sid) {
    try { await deleteDoc(doc(db, 'userSessions', sid)); } catch (_) {}
  }
  localStorage.removeItem('sokoniSessionId');
  if (_unsubWatch) { _unsubWatch(); _unsubWatch = null; }
}

/* ─── Get all active sessions for current user ─── */
async function getUserSessions() {
  const user = _getUser();
  if (!user?.email) return [];
  const currentSid = _getSessionId();

  try {
    const q    = query(collection(db, 'userSessions'),
                       where('userEmail', '==', _safeEmail(user.email)),
                       where('active', '==', true));
    const snap = await getDocs(q);
    return snap.docs
      .map(d => ({ ...d.data(), isCurrent: d.id === currentSid }))
      .sort((a, b) => {
        if (a.isCurrent) return -1;
        if (b.isCurrent) return 1;
        return (b.lastActive?.seconds||0) - (a.lastActive?.seconds||0);
      });
  } catch (e) {
    console.warn('[SokoniSessions] getUserSessions error:', e.message);
    return [];
  }
}

/* ─── Revoke a specific session ─── */
async function revokeSession(sessionId) {
  /* Set active:false so the watching device's onSnapshot detects revocation
     and calls _forceLogout — then the Firestore write has a chance to propagate
     before the document is cleaned up. */
  try { await updateDoc(doc(db, 'userSessions', sessionId), { active: false }); }
  catch (e) { console.warn('[SokoniSessions] revokeSession error:', e.message); }
}

/* ─── Revoke all OTHER sessions ─── */
async function revokeOtherSessions() {
  const user       = _getUser();
  const currentSid = _getSessionId();
  if (!user?.email) return 0;

  try {
    const q    = query(collection(db, 'userSessions'),
                       where('userEmail', '==', _safeEmail(user.email)),
                       where('active', '==', true));
    const snap = await getDocs(q);
    const others = snap.docs.filter(d => d.id !== currentSid);
    await Promise.all(others.map(d => updateDoc(doc(db, 'userSessions', d.id), { active: false })));
    return others.length;
  } catch (e) {
    console.warn('[SokoniSessions] revokeOtherSessions error:', e.message);
    return 0;
  }
}

/* ─── Force logout (called when this device's session is revoked remotely) ─── */
function _forceLogout(reason) {
  if (_unsubWatch) { _unsubWatch(); _unsubWatch = null; }
  localStorage.removeItem('sokoniSessionId');
  localStorage.removeItem('sokoniUser');
  localStorage.removeItem('loggedIn');
  /* Terminate Firebase Auth session so onAuthStateChanged doesn't re-set loggedIn */
  if (window.sokoniSignOut) window.sokoniSignOut().catch(function(){});

  /* Overlay */
  const overlay = document.createElement('div');
  overlay.style.cssText = [
    'position:fixed','inset:0','z-index:999999',
    "background:rgba(7,7,7,0.97)",
    "display:flex","flex-direction:column","align-items:center",
    "justify-content:center","gap:16px",
    "font-family:'Segoe UI',system-ui,sans-serif",
    "text-align:center","padding:32px",
    "animation:_skFade .35s ease",
  ].join(';');
  overlay.innerHTML = `
    <style>@keyframes _skFade{from{opacity:0}to{opacity:1}}</style>
    <div style="font-size:52px;line-height:1;">🔐</div>
    <div style="font-size:18px;font-weight:900;color:#fff;letter-spacing:-.01em;">Session Ended</div>
    <div style="font-size:13px;color:rgba(255,255,255,0.48);max-width:300px;line-height:1.6;">${reason}</div>
    <button onclick="window.location.href='login.html'"
      style="margin-top:8px;padding:13px 32px;background:linear-gradient(135deg,#71ff00,#4fc800);
             color:#000;border:none;border-radius:14px;font-weight:900;font-size:14px;
             cursor:pointer;font-family:inherit;box-shadow:0 4px 20px rgba(113,255,0,0.3);">
      Log In Again
    </button>
  `;
  document.body.appendChild(overlay);
  setTimeout(() => window.location.href = 'login.html', 5000);
}

/* ──────────────────────────────────────────────────────────────
   AUTO-INIT: runs on every page load
   • If logged in but no session doc → create one (covers users
     who were already logged in before this feature shipped)
   • If logged in + session exists → watch for revocation
   • Touch session every 5 min to update lastActive
────────────────────────────────────────────────────────────── */
(async function _autoInit() {
  const user = _getUser();
  if (!user?.email) return; /* not logged in */

  const sid = _getSessionId();
  if (!sid) {
    /* First visit after feature shipped — silently create session */
    await createSession(user.email);
  }
  /* Start real-time revocation watch */
  watchSession();
  /* Update lastActive now and every 5 min */
  touchSession();
  setInterval(touchSession, 5 * 60 * 1000);
})();

/* ─── Global API ─── */
const SokoniSessions = {
  createSession, deleteCurrentSession,
  watchSession, touchSession,
  getUserSessions, revokeSession, revokeOtherSessions,
};
window.SokoniSessions = SokoniSessions;
export { SokoniSessions };
