/* ================================================================
   SOKONI — Firebase Cloud Messaging Service Worker
   This file MUST live at the root of the site (/firebase-messaging-sw.js)

   SETUP:
   1. Go to Firebase Console → Project Settings → Cloud Messaging
   2. Under "Web Push certificates", generate a key pair
   3. Copy the VAPID public key → paste in sw-register.js (SOKONI_VAPID_KEY)
   4. That's it — background push notifications will work!
================================================================ */

importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js");

/* ── Same config as firebase.js ── */
firebase.initializeApp({
  apiKey:            "AIzaSyDt_FRoTdE5OpfPhLB0DApIm7p-I45hzVE",
  authDomain: "mysokoni.co.ke",
  projectId:         "sokoni-aeb26",
  storageBucket:     "sokoni-aeb26.firebasestorage.app",
  messagingSenderId: "24799054989",
  appId:             "1:24799054989:web:e1cf6ca8c281bf1abf26c4",
  measurementId:     "G-QT32H65TJS"
});

const messaging = firebase.messaging();

/* ── Background Message Handler ── */
messaging.onBackgroundMessage(payload => {
  const notification = payload.notification || {};
  const data         = payload.data         || {};

  const title = notification.title || data.title || "SOKONI";
  const body  = notification.body  || data.body  || "You have a new notification from Sokoni";
  /* The official icon set, generated from assets/logosokoni.png. The source itself is a
     512px, 300 KB image — shipping it as a 24px status-bar badge downloaded a third of a
     megabyte per notification on a Kenyan mobile connection. */
  const icon  = notification.icon  || "/assets/icons/icon-192.png";
  const badge = "/assets/icons/icon-96.png";

  /* deepLink is what the notification engine sends. `url`/`click_action` are the
     older keys — kept so pushes from anything not yet migrated still land somewhere.
     Reading only `url` is why an engine push would have opened the homepage. */
  const url   = data.deepLink || data.url || data.click_action || "/index.html";

  /* One thread per order: `group` collapses "Rider assigned" → "Picked up" → "Near
     you" into a single, updating notification rather than a stack of eleven. Falling
     back to a unique tag preserves the old behaviour for ungrouped pushes. */
  const tag   = data.group || data.tag || "sokoni-push-" + Date.now();

  /* Show OS notification */
  return self.registration.showNotification(title, {
    body,
    icon,
    badge,
    ...(data.image ? { image: data.image } : {}),
    vibrate: [200, 100, 200],
    tag,
    renotify: Boolean(data.group),
    data:    { url, ...data },
    actions: [
      { action: "open",    title: "Open SOKONI" },
      { action: "dismiss", title: "Dismiss"     },
    ],
    requireInteraction: false,
  });
});

/* ── Notification Click Handler ── */
self.addEventListener("notificationclick", event => {
  event.notification.close();
  if (event.action === "dismiss") return;

  const d   = event.notification.data || {};
  const url = d.deepLink || d.url || "/index.html";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true })
      .then(clients => {
        /* Focus existing window if open */
        for (const client of clients) {
          if (client.url.includes(self.location.origin) && "focus" in client) {
            client.navigate(url);
            return client.focus();
          }
        }
        /* Otherwise open a new window */
        if (self.clients.openWindow) return self.clients.openWindow(url);
      })
  );
});
