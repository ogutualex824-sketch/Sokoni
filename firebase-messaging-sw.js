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
  authDomain:        "sokoni-aeb26.firebaseapp.com",
  projectId:         "sokoni-aeb26",
  storageBucket:     "sokoni-aeb26.firebasestorage.app",
  messagingSenderId: "24799054989",
  appId:             "1:24799054989:web:e1cf6ca8c281bf1abf26c4",
  measurementId:     "G-QT32H65TJS"
});

const messaging = firebase.messaging();

/* ── Background Message Handler ── */
messaging.onBackgroundMessage(payload => {
  console.log("[SOKONI FCM] Background message:", payload);

  const notification = payload.notification || {};
  const data         = payload.data         || {};

  const title = notification.title || data.title || "SOKONI";
  const body  = notification.body  || data.body  || "You have a new notification from Sokoni";
  const icon  = notification.icon  || "/assets/logosokoni.png";
  const badge = "/assets/logosokoni.png";
  const url   = data.url || data.click_action || "/index.html";

  /* Show OS notification */
  return self.registration.showNotification(title, {
    body,
    icon,
    badge,
    vibrate: [200, 100, 200],
    tag:     data.tag || "sokoni-push-" + Date.now(),
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

  const url = event.notification.data?.url || "/index.html";

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
