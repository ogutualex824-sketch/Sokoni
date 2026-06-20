/* ================================================================
   SOKONI — Firebase SDK
   Auth · Firestore · Storage · Cloud Messaging (FCM)
================================================================ */

import { initializeApp }   from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore }    from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getStorage }      from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";
import {
  getMessaging,
  getToken,
  onMessage
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging.js";

const firebaseConfig = {
  apiKey:            "AIzaSyDt_FRoTdE5OpfPhLB0DApIm7p-I45hzVE",
  authDomain:        "sokoni-aeb26.firebaseapp.com",
  projectId:         "sokoni-aeb26",
  storageBucket:     "sokoni-aeb26.firebasestorage.app",
  messagingSenderId: "24799054989",
  appId:             "1:24799054989:web:e1cf6ca8c281bf1abf26c4",
  measurementId:     "G-QT32H65TJS"
};

/* ── Initialize ── */
const app       = initializeApp(firebaseConfig);
const auth      = getAuth(app);
const db        = getFirestore(app);
const storage   = getStorage(app);
let messaging = null;

if (typeof window !== "undefined") {
  try {
    if ("Notification" in window && "serviceWorker" in navigator) {
      messaging = getMessaging(app);
    }
  } catch (e) {
    console.warn("[SOKONI] FCM not supported:", e.message);
  }
}

/* ── Expose globals for non-module scripts ── */
window.firebaseApp     = app;
window.firebaseAuth    = auth;
window.firebaseDB      = db;
window.firebaseStorage = storage;

/* ══════════════════════════════════════════════════════════════════
   AUTH STATE OBSERVER
   Keeps localStorage in sync with the real Firebase Auth session.
   Every page benefits: non-module scripts reading loggedIn/sokoniUser
   get the correct, up-to-date state without needing to know about
   Firebase Auth directly.
══════════════════════════════════════════════════════════════════ */
onAuthStateChanged(auth, async (user) => {
  /* Expose current UID for framework-agnostic consumers (e.g. sokoni-search-engine.js)
     without requiring them to import Firebase directly. */
  window.__sokoniCurrentUid = user?.uid || null;

  if (user) {
    localStorage.setItem("loggedIn", "true");

    try {
      const { getDoc, setDoc, doc, serverTimestamp } = await import(
        "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js"
      );
      const snap = await getDoc(doc(db, "users", user.uid));
      if (snap.exists()) {
        /* Refresh profile from Firestore into localStorage */
        localStorage.setItem("sokoniUser", JSON.stringify(snap.data()));
      } else {
        /* Profile missing — create it now from Firebase Auth data */
        const profile = {
          uid:          user.uid,
          name:         user.displayName || user.email.split("@")[0],
          email:        user.email,
          registeredAs: { buyer: true },
          role:         "buyer",
          joinedAt:     new Date().toLocaleDateString("en-KE", { day: "numeric", month: "short", year: "numeric" }),
        };
        await setDoc(doc(db, "users", user.uid), { ...profile, createdAt: serverTimestamp() });
        localStorage.setItem("sokoniUser", JSON.stringify(profile));
      }
    } catch (e) {
      /* Keep existing localStorage data if Firestore is temporarily unreachable */
    }

    /* ── SokoniSync: restore cross-device data on every login ── */
    _initSokoniSync(db, user.uid);

    /* ── Update lastSeen + sync any cached FCM token (fire-and-forget) ── */
    try {
      const { doc, setDoc, serverTimestamp } = await import(
        "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js"
      );
      const updates = { lastSeen: serverTimestamp() };
      const cachedFcmToken = localStorage.getItem("sokoni_fcm_token");
      if (cachedFcmToken) {
        updates.fcmToken = cachedFcmToken;
        updates.fcmUpdatedAt = serverTimestamp();
      }
      setDoc(doc(db, "users", user.uid), updates, { merge: true }).catch(() => {});
    } catch (_) {}

  } else {
    /* Firebase session gone — clear ALL auth-related storage */
    localStorage.removeItem("loggedIn");
    localStorage.removeItem("sokoniUser");
    localStorage.removeItem("sokoniSession_v2");
    localStorage.removeItem("sokoniEmployeeSession");
    try { sessionStorage.removeItem("sokoniPermCache"); } catch (_) {}
    /* Invalidate subscription cache */
    if (window.SokoniSubscriptions) window.SokoniSubscriptions.invalidateCache();
    /* Stop syncing */
    if (window.SokoniSync) window.SokoniSync.clear();
  }
});

/* ── SokoniSync wiring ──────────────────────────────────────────
   If SokoniSync is already loaded, init it immediately.
   If not (script not yet parsed), store pending state — sokoni-sync.js
   will pick it up via window._sokoniSyncPending on load.
─────────────────────────────────────────────────────────────── */
function _initSokoniSync(firestoreDb, uid) {
  if (window.SokoniSync) {
    window.SokoniSync.init(firestoreDb, uid);
    window.SokoniSync.pull(uid);
  } else {
    /* Queue for when sokoni-sync.js loads */
    window._sokoniSyncPending = { db: firestoreDb, uid };
    /* Also listen for the load event */
    window.addEventListener('sokoniSyncLoaded', function handler() {
      window.removeEventListener('sokoniSyncLoaded', handler);
      if (window.SokoniSync && window._sokoniSyncPending) {
        const { db: d, uid: u } = window._sokoniSyncPending;
        window._sokoniSyncPending = null;
        window.SokoniSync.init(d, u);
        window.SokoniSync.pull(u);
      }
    }, { once: true });
  }
}

/* ══════════════════════════════════════════════════════════════════
   SIGN OUT
   Call window.sokoniSignOut() from any page's logout button.
   It signs out of Firebase Auth, then clears the legacy localStorage
   keys so all pages immediately see the logged-out state.
══════════════════════════════════════════════════════════════════ */
/* All localStorage keys managed by SOKONI — cleared on every signout */
const _SOKONI_LS_KEYS = [
  "loggedIn", "sokoniUser", "sokoniCreds", "sokoniSessionId",
  "sokoniSession_v2", "sokoniAuditLog", "sokoniEmployeeSession",
  "sokoni_fcm_token", "sokoniBookingFees", "sokoniCommissionLedger",
  "sokoniPlatformBookings", "sokoniPhoneLeads", "sokoniLeadFees",
  "sokoniSubscriptions", "sokoniListingBoosts",
  /* Permission cache */
  "sokoniPermCache",
];

async function sokoniSignOut() {
  try {
    await signOut(auth);
  } catch (e) {
    /* Always clear local state even if the network call fails */
  }
  /* Clear ALL SOKONI-managed localStorage keys to prevent stale session reuse */
  _SOKONI_LS_KEYS.forEach(k => { try { localStorage.removeItem(k); } catch (_) {} });
  /* Clear sessionStorage caches */
  try {
    sessionStorage.removeItem("sokoniPermCache");
    sessionStorage.removeItem("_sk_pay_idem");
  } catch (_) {}
  /* Invalidate subscription cache */
  if (window.SokoniSubscriptions) window.SokoniSubscriptions.invalidateCache();
}
window.sokoniSignOut = sokoniSignOut;

/* ══════════════════════════════════════════════════════════════════
   PROFILE UPDATE HELPER
   Use this from any page (profile.js, role selectors, etc.) to keep
   both localStorage and Firestore in sync when profile data changes.

   Usage: await window.sokoniUpdateProfile({ name: "New Name", ... })
══════════════════════════════════════════════════════════════════ */
async function sokoniUpdateProfile(updates) {
  if (!updates || typeof updates !== "object") return;

  /* 1. Update localStorage immediately (synchronous) */
  try {
    const existing = JSON.parse(localStorage.getItem("sokoniUser") || "{}");
    const merged   = Object.assign({}, existing, updates);
    localStorage.setItem("sokoniUser", JSON.stringify(merged));
  } catch (e) { /* ignore */ }

  /* 2. Persist to Firestore if authenticated */
  const currentUser = auth.currentUser;
  if (!currentUser) return;

  try {
    const { doc, updateDoc, serverTimestamp } = await import(
      "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js"
    );
    await updateDoc(doc(db, "users", currentUser.uid), {
      ...updates,
      updatedAt: serverTimestamp()
    });
  } catch (e) {
    /* localStorage was already updated — Firestore sync is best-effort */
  }
}
window.sokoniUpdateProfile = sokoniUpdateProfile;

/* ── Request permission + get FCM token ── */
async function sokoniRequestPushPermission(vapidKey) {
  if (!messaging || !vapidKey || vapidKey === "YOUR_VAPID_KEY_HERE") return null;

  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") return null;

    const swReg = await navigator.serviceWorker.ready;
    const token = await getToken(messaging, {
      vapidKey,
      serviceWorkerRegistration: swReg,
    });

    if (token) {
      localStorage.setItem("sokoni_fcm_token", token);
      try {
        const { doc, setDoc, serverTimestamp } = await import(
          "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js"
        );
        /* Use auth.currentUser for JWT-verified identity — never localStorage */
        const currentUser = auth.currentUser;
        const platform    = navigator.userAgent.includes("iPhone") ? "ios" :
                            navigator.userAgent.includes("Android") ? "android" : "web";
        if (currentUser?.email) {
          /* Doc ID from verified JWT email — cannot be spoofed via localStorage */
          const safeId = currentUser.email.replace(/[^a-zA-Z0-9]/g, "_");
          await setDoc(doc(db, "fcm_tokens", safeId), {
            token, email: currentUser.email, name: currentUser.displayName || "",
            uid: currentUser.uid,
            updatedAt: serverTimestamp(), platform,
          }, { merge: true });
        }
        /* Save on users/{uid} for Cloud Function fan-out */
        if (currentUser?.uid) {
          await setDoc(doc(db, "users", currentUser.uid), {
            fcmToken: token, fcmPlatform: platform, fcmUpdatedAt: serverTimestamp()
          }, { merge: true });
        }
      } catch (e) {
        if (window.SokoniLogger) window.SokoniLogger.warn("[FCM] Token save failed:", e.message);
      }
      return token;
    }
  } catch (e) {
    console.warn("[SOKONI FCM] getToken failed:", e.message);
  }
  return null;
}

/* ── Listen for foreground messages ── */
function sokoniListenMessages(callback) {
  if (!messaging) return;
  onMessage(messaging, payload => {
    if (callback) callback(payload);
    else {
      const n = payload.notification || {};
      _showSokoniPushToast(n.title || "SOKONI", n.body || "", n.icon, payload.data?.url);
    }
  });
}

/* ── In-app push notification toast ── */
function _showSokoniPushToast(title, body, icon, url) {
  const existing = document.getElementById("sokoniPushToast");
  if (existing) existing.remove();

  const toast = document.createElement("div");
  toast.id    = "sokoniPushToast";
  toast.style.cssText = `
    position:fixed;top:80px;right:16px;z-index:999999;
    width:min(340px,calc(100vw - 32px));
    background:#111;border:1px solid rgba(113,255,0,0.28);
    border-radius:18px;padding:14px 16px;
    display:flex;align-items:flex-start;gap:12px;
    box-shadow:0 12px 40px rgba(0,0,0,0.6);
    animation:sokoniToastIn 0.35s cubic-bezier(0.34,1.56,0.64,1);
    cursor:${url ? "pointer" : "default"};
    font-family:'Segoe UI',system-ui,sans-serif;
  `;

  /* Use textContent for dynamic values to prevent XSS */
  const style = document.createElement("style");
  style.textContent = "@keyframes sokoniToastIn{from{opacity:0;transform:translateX(40px)}to{opacity:1;transform:translateX(0)}}";

  const img = document.createElement("img");
  img.src    = "assets/logosokoni.png"; /* safe default */
  img.style.cssText = "width:40px;height:40px;border-radius:10px;object-fit:cover;flex-shrink:0;";
  img.onerror = () => { img.src = "assets/logosokoni.png"; };
  /* Only set src from icon if it is a same-origin or HTTPS URL */
  if (icon && /^https:\/\//.test(icon)) img.src = icon;

  const textWrap  = document.createElement("div");
  textWrap.style.cssText = "flex:1;min-width:0;";

  const titleEl = document.createElement("div");
  titleEl.style.cssText = "font-size:13px;font-weight:800;color:white;margin-bottom:2px;";
  titleEl.textContent = title; /* textContent — safe */

  const bodyEl = document.createElement("div");
  bodyEl.style.cssText = "font-size:12px;color:rgba(255,255,255,0.55);line-height:1.4;";
  bodyEl.textContent = body; /* textContent — safe */

  const closeBtn = document.createElement("button");
  closeBtn.style.cssText = "background:none;border:none;color:rgba(255,255,255,0.3);font-size:18px;cursor:pointer;flex-shrink:0;padding:0;line-height:1;";
  closeBtn.textContent = "✕";
  closeBtn.onclick = e => { e.stopPropagation(); toast.remove(); };

  textWrap.appendChild(titleEl);
  textWrap.appendChild(bodyEl);
  toast.appendChild(style);
  toast.appendChild(img);
  toast.appendChild(textWrap);
  toast.appendChild(closeBtn);

  if (url) toast.addEventListener("click", e => {
    if (e.target.closest("button")) return;
    /* Allow same-origin relative paths and HTTPS same-host URLs only */
    try {
      const parsed = new URL(url, window.location.origin);
      if (parsed.origin === window.location.origin || parsed.protocol === 'https:' && parsed.hostname === window.location.hostname) {
        window.location.href = parsed.href;
      }
    } catch (_) { /* malformed URL — ignore */ }
  });
  document.body.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity    = "0";
    toast.style.transition = "opacity 0.4s";
    setTimeout(() => toast.remove(), 400);
  }, 6000);
}

/* ── Firestore audit writer (exposed for non-module security.js) ── */
window.sokoniFirestoreAudit = async function(entry = {}) {
  try {
    const { collection, addDoc, serverTimestamp } = await import(
      "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js"
    );
    await addDoc(collection(db, "auditLogs"), Object.assign({}, entry, {
      serverTs: serverTimestamp()
    }));
  } catch (e) {
    console.warn("[SOKONI] Audit write failed:", e && e.message);
  }
};

export {
  app, auth, db, storage, messaging,
  sokoniRequestPushPermission,
  sokoniListenMessages
};
