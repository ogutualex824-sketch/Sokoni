'use strict';

/**
 * SOKONI Device Management Engine v1.0
 *
 * "One Person. One Identity. One Account For Life."
 *
 * Tracks every device a user signs in from. Provides:
 *   - Device registration on login (platform, browser, IP, geo)
 *   - Device list with last-active timestamps
 *   - Individual or bulk device logout
 *   - Device trust marking for low-friction re-auth
 *   - Activity heartbeat for presence tracking
 *
 * Firestore Collection:
 *   userDevices/{uid}_{deviceId}   — indexed by uid (single-field, no composite needed)
 *
 * Security: every CF is scoped to req.auth.uid; users can only manage their own devices.
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');

if (!admin.apps.length) admin.initializeApp();

const db        = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

/* ── Internal helpers ─────────────────────────────────────────── */

function _assertAuth(req) {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
  return req.auth.uid;
}

function _ip(req) {
  return req.rawRequest?.headers?.['x-forwarded-for']?.split(',')[0]?.trim()
       || req.rawRequest?.ip
       || null;
}

function _platform(ua = '') {
  if (/Android/i.test(ua)) return 'Android';
  if (/iPhone/i.test(ua))  return 'iPhone';
  if (/iPad/i.test(ua))    return 'iPad';
  if (/Win/i.test(ua))     return 'Windows';
  if (/Mac OS X/i.test(ua) && !/iPhone|iPad/i.test(ua)) return 'macOS';
  if (/Linux/i.test(ua))   return 'Linux';
  return 'Unknown';
}

function _browser(ua = '') {
  if (/Edg\//i.test(ua))                              return 'Edge';
  if (/OPR\//i.test(ua) || /Opera/i.test(ua))         return 'Opera';
  if (/Chrome\//i.test(ua) && !/Chromium/i.test(ua))  return 'Chrome';
  if (/Firefox\//i.test(ua))                          return 'Firefox';
  if (/Safari\//i.test(ua) && !/Chrome/i.test(ua))    return 'Safari';
  return 'Unknown';
}

function _deviceName(ua = '', hint = '') {
  if (hint && hint.length > 0) return hint;
  const m = ua.match(/\(([^)]+)\)/);
  if (!m) return 'Unknown Device';
  const parts = m[1].split(';').map(s => s.trim());
  if (/Android/i.test(ua))       return parts[1] || parts[0] || 'Android Device';
  if (/iPhone|iPad/i.test(ua))   return parts[0] || 'Apple Device';
  return parts[0] || 'Desktop';
}

function _deviceType(ua = '') {
  if (/Mobile|Android|iPhone/i.test(ua)) return 'mobile';
  if (/iPad|Tablet/i.test(ua))           return 'tablet';
  return 'desktop';
}

/* ═══════════════════════════════════════════════════════════════
   REGISTER / UPDATE DEVICE ON LOGIN
   ─────────────────────────────────────────────────────────────
   Called from shared-header.js on every page load (after auth).
   Uses merge so subsequent calls only update lastActiveAt + loginCount.
   Returns the deviceDocId so the client can store it for revoking.
   ─────────────────────────────────────────────────────────────── */
exports.deviceRegister = onCall({ region: 'us-central1' }, async (req) => {
  const uid = _assertAuth(req);
  const { deviceId, deviceName: nameHint, city, country } = req.data || {};

  if (!deviceId || typeof deviceId !== 'string' || deviceId.length < 8) {
    throw new HttpsError('invalid-argument', 'A stable deviceId (min 8 chars) is required.');
  }

  const ua  = req.rawRequest?.headers?.['user-agent'] || '';
  const ip  = _ip(req);
  const dId = `${uid}_${deviceId.slice(0, 64)}`;
  const ref = db.collection('userDevices').doc(dId);
  const snap = await ref.get();

  if (!snap.exists) {
    await ref.set({
      uid,
      deviceId,
      userAgent:    ua,
      ip,
      platform:     _platform(ua),
      browser:      _browser(ua),
      deviceName:   _deviceName(ua, nameHint || ''),
      deviceType:   _deviceType(ua),
      city:         city    || null,
      country:      country || null,
      firstSeenAt:  FieldValue.serverTimestamp(),
      lastActiveAt: FieldValue.serverTimestamp(),
      isActive:     true,
      isTrusted:    false,
      loginCount:   1,
    });
  } else {
    await ref.update({
      userAgent:    ua,
      ip,
      platform:     _platform(ua),
      browser:      _browser(ua),
      deviceName:   _deviceName(ua, nameHint || '') || snap.data().deviceName,
      deviceType:   _deviceType(ua),
      city:         city    || snap.data().city    || null,
      country:      country || snap.data().country || null,
      lastActiveAt: FieldValue.serverTimestamp(),
      isActive:     true,
      loginCount:   FieldValue.increment(1),
    });
  }

  return { deviceDocId: dId };
});

/* ═══════════════════════════════════════════════════════════════
   LIST ALL ACTIVE DEVICES
   ─────────────────────────────────────────────────────────────── */
exports.deviceList = onCall({ region: 'us-central1' }, async (req) => {
  const uid = _assertAuth(req);

  const snap = await db.collection('userDevices')
    .where('uid', '==', uid)
    .where('isActive', '==', true)
    .get();

  const devices = snap.docs
    .map(d => {
      const data = d.data();
      return {
        docId:        d.id,
        deviceId:     data.deviceId      || '',
        deviceName:   data.deviceName    || 'Unknown Device',
        deviceType:   data.deviceType    || 'desktop',
        platform:     data.platform      || 'Unknown',
        browser:      data.browser       || 'Unknown',
        ip:           data.ip            || null,
        city:         data.city          || null,
        country:      data.country       || null,
        isTrusted:    data.isTrusted     || false,
        loginCount:   data.loginCount    || 1,
        firstSeenAt:  data.firstSeenAt   || null,
        lastActiveAt: data.lastActiveAt  || null,
      };
    })
    .sort((a, b) => (b.lastActiveAt?.seconds || 0) - (a.lastActiveAt?.seconds || 0));

  return { devices };
});

/* ═══════════════════════════════════════════════════════════════
   LOGOUT A SPECIFIC DEVICE
   ─────────────────────────────────────────────────────────────── */
exports.deviceLogout = onCall({ region: 'us-central1' }, async (req) => {
  const uid = _assertAuth(req);
  const { deviceDocId } = req.data || {};
  if (!deviceDocId) throw new HttpsError('invalid-argument', 'deviceDocId is required.');

  const ref  = db.collection('userDevices').doc(deviceDocId);
  const snap = await ref.get();

  if (!snap.exists) throw new HttpsError('not-found', 'Device record not found.');
  if (snap.data().uid !== uid) throw new HttpsError('permission-denied', 'Cannot manage another user\'s device.');

  await ref.update({
    isActive:    false,
    loggedOutAt: FieldValue.serverTimestamp(),
  });

  return { ok: true };
});

/* ═══════════════════════════════════════════════════════════════
   LOGOUT ALL DEVICES (except current)
   ─────────────────────────────────────────────────────────────── */
exports.deviceLogoutAll = onCall({ region: 'us-central1' }, async (req) => {
  const uid = _assertAuth(req);
  const { currentDeviceDocId } = req.data || {};

  const snap = await db.collection('userDevices')
    .where('uid', '==', uid)
    .where('isActive', '==', true)
    .get();

  const batch = db.batch();
  let count = 0;
  snap.docs.forEach(d => {
    if (d.id !== currentDeviceDocId) {
      batch.update(d.ref, {
        isActive:    false,
        loggedOutAt: FieldValue.serverTimestamp(),
      });
      count++;
    }
  });

  if (count > 0) await batch.commit();
  return { count };
});

/* ═══════════════════════════════════════════════════════════════
   MARK DEVICE AS TRUSTED
   ─────────────────────────────────────────────────────────────── */
exports.deviceTrust = onCall({ region: 'us-central1' }, async (req) => {
  const uid = _assertAuth(req);
  const { deviceDocId } = req.data || {};
  if (!deviceDocId) throw new HttpsError('invalid-argument', 'deviceDocId is required.');

  const ref  = db.collection('userDevices').doc(deviceDocId);
  const snap = await ref.get();

  if (!snap.exists) throw new HttpsError('not-found', 'Device record not found.');
  if (snap.data().uid !== uid) throw new HttpsError('permission-denied', 'Cannot manage another user\'s device.');

  await ref.update({
    isTrusted: true,
    trustedAt: FieldValue.serverTimestamp(),
  });

  return { ok: true };
});

/* ═══════════════════════════════════════════════════════════════
   REMOVE TRUST FROM A DEVICE
   ─────────────────────────────────────────────────────────────── */
exports.deviceUntrust = onCall({ region: 'us-central1' }, async (req) => {
  const uid = _assertAuth(req);
  const { deviceDocId } = req.data || {};
  if (!deviceDocId) throw new HttpsError('invalid-argument', 'deviceDocId is required.');

  const ref  = db.collection('userDevices').doc(deviceDocId);
  const snap = await ref.get();

  if (!snap.exists) throw new HttpsError('not-found', 'Device record not found.');
  if (snap.data().uid !== uid) throw new HttpsError('permission-denied', 'Cannot manage another user\'s device.');

  await ref.update({ isTrusted: false });

  return { ok: true };
});

/* ═══════════════════════════════════════════════════════════════
   ACTIVITY HEARTBEAT
   Called periodically to keep lastActiveAt current.
   Low-cost: only writes if the doc belongs to the caller.
   ─────────────────────────────────────────────────────────────── */
exports.devicePing = onCall({ region: 'us-central1' }, async (req) => {
  const uid = _assertAuth(req);
  const { deviceDocId } = req.data || {};
  if (!deviceDocId) return { ok: true };

  const ref  = db.collection('userDevices').doc(deviceDocId);
  const snap = await ref.get();

  if (snap.exists && snap.data().uid === uid && snap.data().isActive) {
    await ref.update({ lastActiveAt: FieldValue.serverTimestamp() });
  }

  return { ok: true };
});
