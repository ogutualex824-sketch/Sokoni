/* ================================================================
   sokoni-inbox.js  — Universal Sokoni Inbox Integration Layer v1.0
   Used by all hubs to open/create conversations.

   USAGE (from any hub page):
     SokoniInbox.openChat({
       otherUid:    'uid_of_other_user',
       otherName:   'Seller Name',
       type:        SokoniInbox.HUB_TYPES.BUYER_SELLER,
       context:     'Blue Dress - Order #1234',
       contextId:   'order_abc123',
     });

   FIRESTORE SECURITY RULES required in firestore.rules:
   ──────────────────────────────────────────────────────
   match /conversations/{convId} {
     allow read, update: if request.auth != null &&
       request.auth.uid in resource.data.participants;
     allow create: if request.auth != null &&
       request.auth.uid in request.resource.data.participants;
     match /messages/{msgId} {
       allow read: if request.auth != null &&
         request.auth.uid in get(/databases/$(database)/documents/conversations/$(convId)).data.participants;
       allow create: if request.auth != null &&
         request.auth.uid == request.resource.data.senderId &&
         request.auth.uid in get(/databases/$(database)/documents/conversations/$(convId)).data.participants;
     }
   }
   ──────────────────────────────────────────────────────
================================================================ */
(function(global) {
'use strict';

const SokoniInbox = {};

// ── Hub Conversation Types ──────────────────────────────────────
SokoniInbox.HUB_TYPES = {
  BUYER_SELLER:       'buyer-seller',
  CUSTOMER_PROVIDER:  'customer-provider',
  RIDER_PASSENGER:    'rider-passenger',
  TENANT_LANDLORD:    'tenant-landlord',
  PATIENT_DOCTOR:     'patient-doctor',
  CLIENT_LAWYER:      'client-lawyer',
  MARKETING:          'marketing',
  GENERAL:            'general',
};

// ── Badge config per type ───────────────────────────────────────
SokoniInbox.TYPE_CONFIG = {
  'buyer-seller':      { icon:'🛍️', label:'Buyer · Seller',       color:'#fb923c' },
  'customer-provider': { icon:'🛠️', label:'Customer · Provider',  color:'#8b5cf6' },
  'rider-passenger':   { icon:'🛵', label:'Rider · Passenger',    color:'#3b82f6' },
  'tenant-landlord':   { icon:'🏠', label:'Tenant · Landlord',    color:'#10b981' },
  'patient-doctor':    { icon:'🏥', label:'Patient · Doctor',     color:'#ef4444' },
  'client-lawyer':     { icon:'⚖️', label:'Client · Lawyer',     color:'#eab308' },
  'marketing':         { icon:'🎯', label:'Client · Marketer',    color:'#f43f5e' },
  'general':           { icon:'💬', label:'Message',              color:'#6366f1' },
};

// ── Deterministic conversation ID ─────────────────────────────
SokoniInbox.convId = (uid1, uid2) => [uid1, uid2].sort().join('_');

// ── Navigate to inbox with context ────────────────────────────
SokoniInbox.openChat = function(params) {
  const { otherUid, otherName, type, context, contextId } = params || {};
  if (!otherUid) { window.location.href = 'messages.html'; return; }
  const q = new URLSearchParams({
    with:  otherUid,
    name:  otherName  || '',
    type:  type       || SokoniInbox.HUB_TYPES.GENERAL,
    ctx:   context    || '',
    ctxId: contextId  || '',
  });
  window.location.href = 'messages.html?' + q.toString();
};

// ── Create or open conversation in Firestore ──────────────────
SokoniInbox.createOrOpen = async function(db, params) {
  if (!db || !params.myUid || !params.otherUid) return null;
  const { collection, doc, setDoc, getDoc } = await import(
    'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
  ).catch(() => ({}));
  if (!setDoc) return null;

  const cid = SokoniInbox.convId(params.myUid, params.otherUid);
  const ref = doc(db, 'conversations', cid);
  const snap = await getDoc(ref).catch(() => null);

  const payload = {
    participants: [params.myUid, params.otherUid].sort(),
    names:        { [params.myUid]: params.myName || 'Me', [params.otherUid]: params.otherName || 'User' },
    type:         params.type    || SokoniInbox.HUB_TYPES.GENERAL,
    context:      params.context || '',
    contextId:    params.contextId || '',
    lastMessage:  snap?.exists() ? snap.data().lastMessage : '',
    lastAt:       snap?.exists() ? snap.data().lastAt      : Date.now(),
    unread:       snap?.exists() ? snap.data().unread      : {},
    createdAt:    snap?.exists() ? snap.data().createdAt   : Date.now(),
  };
  await setDoc(ref, payload, { merge: true }).catch(() => {});
  return cid;
};

// ── Real-time unread count subscription ──────────────────────
SokoniInbox.subscribeUnread = function(uid, db, callback) {
  if (!uid || !db) return () => {};
  let unsub = () => {};
  import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js')
    .then(({ collection, query, where, onSnapshot }) => {
      const q = query(collection(db, 'conversations'), where('participants', 'array-contains', uid));
      unsub = onSnapshot(q, snap => {
        let total = 0;
        snap.forEach(d => {
          if (!(d.data().spam || {})[uid]) total += (d.data().unread || {})[uid] || 0;
        });
        callback(total);
        try { localStorage.setItem('_sokoniUnread', String(total)); } catch(e) {}
        // Fire for notification center
        global.dispatchEvent(new CustomEvent('sokoniInboxUnread', { detail: { uid, count: total } }));
      }, () => {});
    }).catch(() => {});
  return () => unsub();
};

// ── Notification center hook ──────────────────────────────────
// Future notification center subscribes to these events:
//   window.addEventListener('sokoniInboxUnread',  e => { /* e.detail.count */ });
//   window.addEventListener('sokoniNewMessage',   e => { /* e.detail: {convId, msg} */ });
SokoniInbox.fireNewMessage = function(convId, msg) {
  global.dispatchEvent(new CustomEvent('sokoniNewMessage', { detail: { convId, msg } }));
};

// ── Push notification subscription helper ────────────────────
SokoniInbox.requestPushPermission = async function() {
  if (!('Notification' in window) || !('serviceWorker' in navigator)) return false;
  const perm = await Notification.requestPermission().catch(() => 'denied');
  return perm === 'granted';
};

SokoniInbox.savePushToken = async function(uid, db) {
  // Store FCM-style token placeholder — wire to FCM when backend is ready
  if (!uid || !db) return;
  try {
    const sw = await navigator.serviceWorker.ready;
    const sub = await sw.pushManager.getSubscription();
    if (sub) {
      const { doc, setDoc } = await import(
        'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
      );
      await setDoc(doc(db, 'pushTokens', uid), {
        endpoint: sub.endpoint, uid, updatedAt: Date.now(),
      }, { merge: true });
    }
  } catch(e) {}
};

global.SokoniInbox = SokoniInbox;
})(window);
