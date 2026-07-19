/* ================================================================
   SOKONI — Vehicle Tracking Module  (sokoni-tracking.js)

   Firestore collections:
     trackedVehicles/{vehicleId}     — registered vehicles + permissions
     vehicleLocations/{vehicleId}    — live GPS location (real-time)
     vehicleRoutes/{routeId}         — route history / trip records
     vehicleAlerts/{alertId}         — speed / geofence / theft alerts
     vehicleGeofences/{geofenceId}   — geofence zones
     gpsDevices/{deviceId}           — registered GPS tracker hardware
     trackingShares/{shareId}        — temporary public share tokens
     trackingSubscriptions/{uid}     — subscription plan records

   Permission model: owner → full control
                    fleetManagers[] → full live tracking + reports
                    authorizedDrivers[] → live location view only
                    familyMembers[] → live location view only

   Exposes: window.SokoniTracking  +  ES default export
================================================================ */
import { db, auth } from './firebase.js';
import {
  collection, doc, addDoc, setDoc, updateDoc, getDoc, getDocs,
  onSnapshot, query, where, orderBy, serverTimestamp,
  limit, deleteDoc, increment, arrayUnion, arrayRemove,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

function _uid() {
  if (auth.currentUser?.uid) return auth.currentUser.uid;
  try { return JSON.parse(localStorage.getItem('sokoniUser') || 'null')?.uid ?? null; }
  catch { return null; }
}
function _phone(p) { return String(p || '').replace(/\D/g, ''); }
function _id(prefix) {
  return prefix + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2, 5).toUpperCase();
}
function _canView(vehicle, uid) {
  if (!uid) return false;
  if (vehicle.ownerUid === uid) return true;
  if (vehicle.fleetManagers && vehicle.fleetManagers.includes(uid)) return true;
  if (vehicle.authorizedDrivers && vehicle.authorizedDrivers.includes(uid)) return true;
  if (vehicle.familyMembers && vehicle.familyMembers.includes(uid)) return true;
  return false;
}

const SokoniTracking = {

  /* ════════════════════════════════════════
     VEHICLE REGISTRATION
  ════════════════════════════════════════ */

  async registerVehicle(vehicle) {
    const uid = _uid();
    if (!uid) throw new Error('Login required to register a vehicle');
    const id = vehicle.id || _id('VEH-');
    await setDoc(doc(db, 'trackedVehicles', id), {
      ...vehicle, id,
      ownerUid:          uid,
      fleetManagers:     vehicle.fleetManagers     || [],
      authorizedDrivers: vehicle.authorizedDrivers || [],
      familyMembers:     vehicle.familyMembers     || [],
      status:            vehicle.status            || 'active',
      theftMode:         false,
      gpsDeviceId:       vehicle.gpsDeviceId       || null,
      serviceReminderKm: vehicle.serviceReminderKm || 5000,
      insuranceExpiry:   vehicle.insuranceExpiry   || null,
      inspectionExpiry:  vehicle.inspectionExpiry  || null,
      nextServiceDate:   vehicle.nextServiceDate   || null,
      createdAt:         vehicle.createdAt         || serverTimestamp(),
      updatedAt:         serverTimestamp(),
    }, { merge: true });
    return id;
  },

  async updateVehicle(vehicleId, data) {
    const uid = _uid();
    const snap = await getDoc(doc(db, 'trackedVehicles', vehicleId));
    if (!snap.exists()) throw new Error('Vehicle not found');
    if (snap.data().ownerUid !== uid) throw new Error('Not authorised');
    await updateDoc(doc(db, 'trackedVehicles', vehicleId), { ...data, updatedAt: serverTimestamp() });
  },

  async deleteVehicle(vehicleId) {
    const uid = _uid();
    const snap = await getDoc(doc(db, 'trackedVehicles', vehicleId));
    if (!snap.exists()) throw new Error('Vehicle not found');
    if (snap.data().ownerUid !== uid) throw new Error('Not authorised');
    await deleteDoc(doc(db, 'trackedVehicles', vehicleId));
    try { await deleteDoc(doc(db, 'vehicleLocations', vehicleId)); } catch {}
  },

  /* onError is OPTIONAL and additive: existing single-argument callers keep the
     previous behaviour (callback([]) on failure, so they still paint an empty
     state). Callers that pass it — SokoniAsync.bindSection — get the real error
     and can distinguish "no vehicles" from "could not load vehicles", which the
     old signature made impossible. */
  listenMyVehicles(callback, onError) {
    const uid = _uid();
    if (!uid) { callback([]); return () => {}; }
    const q = query(
      collection(db, 'trackedVehicles'),
      where('ownerUid', '==', uid),
      orderBy('createdAt', 'desc')
    );
    return onSnapshot(q,
      s => callback(s.docs.map(d => ({ _fsId: d.id, ...d.data() }))),
      e => {
        /* THE BLANK PAGE. This previously only warned, so on error the callback
           never ran, the renderer never executed, and the list element was left
           exactly as the page shipped it — empty. A user who had just saved a
           vehicle saw "Saved successfully" and then nothing at all, with no
           empty state and no error, because the UI was never told anything had
           happened.

           The trigger was a missing composite index: this query is
           where(ownerUid) + orderBy(createdAt), and trackedVehicles had NO
           composite indexes, so onSnapshot failed with failed-precondition on
           every call. The index is now declared in firestore.indexes.json.

           Invoking the callback on error is what makes the failure survivable:
           the renderer runs, sees no vehicles, and draws its empty state rather
           than leaving a blank region. The error is still surfaced for
           diagnosis — but never as an absence of UI. */
        console.error('[SokoniTracking] myVehicles listener failed:', e && (e.code || e.message), e);
        /* Prefer a real error arm when the caller supplied one — it can then
           show "could not load" rather than "no vehicles", which are very
           different messages to a user who just saved a vehicle. */
        if (typeof onError === 'function') { try { onError(e); return; } catch (_) {} }
        try { callback([], { error: e && (e.code || e.message) || 'unknown' }); }
        catch (cbErr) { console.error('[SokoniTracking] callback threw:', cbErr && cbErr.message); }
      }
    );
  },

  listenAuthorisedVehicles(callback) {
    const uid = _uid();
    if (!uid) { callback([]); return () => {}; }
    const q = query(
      collection(db, 'trackedVehicles'),
      where('authorizedDrivers', 'array-contains', uid)
    );
    const q2 = query(
      collection(db, 'trackedVehicles'),
      where('familyMembers', 'array-contains', uid)
    );
    const results = new Map();
    const merge = (docs) => callback([...results.values()]);

    const unsub1 = onSnapshot(q, s => {
      s.docs.forEach(d => results.set(d.id, { _fsId: d.id, ...d.data() }));
      merge();
    }, e => console.warn('[SokoniTracking] authVehicles1:', e.message));
    const unsub2 = onSnapshot(q2, s => {
      s.docs.forEach(d => results.set(d.id, { _fsId: d.id, ...d.data() }));
      merge();
    }, e => console.warn('[SokoniTracking] authVehicles2:', e.message));

    return () => { unsub1(); unsub2(); };
  },

  /* ════════════════════════════════════════
     PERMISSIONS MANAGEMENT
  ════════════════════════════════════════ */

  async addAuthorizedDriver(vehicleId, driverUid) {
    const uid = _uid();
    const snap = await getDoc(doc(db, 'trackedVehicles', vehicleId));
    if (!snap.exists() || snap.data().ownerUid !== uid) throw new Error('Not authorised');
    await updateDoc(doc(db, 'trackedVehicles', vehicleId), {
      authorizedDrivers: arrayUnion(driverUid), updatedAt: serverTimestamp(),
    });
  },

  async removeAuthorizedDriver(vehicleId, driverUid) {
    const uid = _uid();
    const snap = await getDoc(doc(db, 'trackedVehicles', vehicleId));
    if (!snap.exists() || snap.data().ownerUid !== uid) throw new Error('Not authorised');
    await updateDoc(doc(db, 'trackedVehicles', vehicleId), {
      authorizedDrivers: arrayRemove(driverUid), updatedAt: serverTimestamp(),
    });
  },

  async addFamilyMember(vehicleId, memberUid) {
    const uid = _uid();
    const snap = await getDoc(doc(db, 'trackedVehicles', vehicleId));
    if (!snap.exists() || snap.data().ownerUid !== uid) throw new Error('Not authorised');
    await updateDoc(doc(db, 'trackedVehicles', vehicleId), {
      familyMembers: arrayUnion(memberUid), updatedAt: serverTimestamp(),
    });
  },

  async addFleetManager(vehicleId, managerUid) {
    const uid = _uid();
    const snap = await getDoc(doc(db, 'trackedVehicles', vehicleId));
    if (!snap.exists() || snap.data().ownerUid !== uid) throw new Error('Not authorised');
    await updateDoc(doc(db, 'trackedVehicles', vehicleId), {
      fleetManagers: arrayUnion(managerUid), updatedAt: serverTimestamp(),
    });
  },

  /* ════════════════════════════════════════
     LIVE GPS LOCATION
  ════════════════════════════════════════ */

  async updateLocation(vehicleId, { lat, lng, speed = 0, heading = 0, accuracy = 0, engineOn = true, driverId = null }) {
    const uid = _uid();
    const snap = await getDoc(doc(db, 'trackedVehicles', vehicleId));
    if (!snap.exists()) throw new Error('Vehicle not found');
    const vehicle = snap.data();
    if (!_canView(vehicle, uid)) throw new Error('Not authorised to update location');

    const locationData = {
      vehicleId, lat, lng, speed, heading, accuracy, engineOn,
      driverId: driverId || uid,
      updatedAt: serverTimestamp(),
    };
    await setDoc(doc(db, 'vehicleLocations', vehicleId), locationData, { merge: true });

    /* speed alert: >120 km/h */
    if (speed > 120) {
      await this.createAlert(vehicleId, 'speed', `Speed alert: ${speed} km/h`, { lat, lng, speed });
    }
    return locationData;
  },

  listenVehicleLocation(vehicleId, callback) {
    const uid = _uid();
    return onSnapshot(doc(db, 'vehicleLocations', vehicleId),
      async (snap) => {
        if (!snap.exists()) { callback(null); return; }
        /* permission check */
        try {
          const vSnap = await getDoc(doc(db, 'trackedVehicles', vehicleId));
          if (!vSnap.exists() || !_canView(vSnap.data(), uid)) { callback(null); return; }
        } catch { callback(null); return; }
        callback({ _fsId: snap.id, ...snap.data() });
      },
      e => console.warn('[SokoniTracking] location:', e.message)
    );
  },

  /* ════════════════════════════════════════
     ROUTE HISTORY
  ════════════════════════════════════════ */

  async saveRoute(route) {
    const uid = _uid();
    const id = route.id || _id('RTE-');
    await setDoc(doc(db, 'vehicleRoutes', id), {
      ...route, id, uid,
      createdAt: route.createdAt || serverTimestamp(),
    }, { merge: true });
    return id;
  },

  listenVehicleRoutes(vehicleId, callback, limitN = 30) {
    const q = query(
      collection(db, 'vehicleRoutes'),
      where('vehicleId', '==', vehicleId),
      orderBy('createdAt', 'desc'),
      limit(limitN)
    );
    return onSnapshot(q,
      s => callback(s.docs.map(d => ({ _fsId: d.id, ...d.data() }))),
      e => console.warn('[SokoniTracking] routes:', e.message)
    );
  },

  /* ════════════════════════════════════════
     GEOFENCES
  ════════════════════════════════════════ */

  async saveGeofence(geofence) {
    const uid = _uid();
    const id = geofence.id || _id('GEO-');
    await setDoc(doc(db, 'vehicleGeofences', id), {
      ...geofence, id, ownerUid: uid,
      active: geofence.active ?? true,
      createdAt: geofence.createdAt || serverTimestamp(),
      updatedAt: serverTimestamp(),
    }, { merge: true });
    return id;
  },

  async deleteGeofence(geofenceId) {
    const uid = _uid();
    const snap = await getDoc(doc(db, 'vehicleGeofences', geofenceId));
    if (!snap.exists() || snap.data().ownerUid !== uid) throw new Error('Not authorised');
    await deleteDoc(doc(db, 'vehicleGeofences', geofenceId));
  },

  listenVehicleGeofences(vehicleId, callback) {
    const q = query(
      collection(db, 'vehicleGeofences'),
      where('vehicleId', '==', vehicleId),
      where('active', '==', true)
    );
    return onSnapshot(q,
      s => callback(s.docs.map(d => ({ _fsId: d.id, ...d.data() }))),
      e => console.warn('[SokoniTracking] geofences:', e.message)
    );
  },

  /* ════════════════════════════════════════
     ALERTS
  ════════════════════════════════════════ */

  async createAlert(vehicleId, type, message, extra = {}) {
    const id = _id('ALT-');
    await setDoc(doc(db, 'vehicleAlerts', id), {
      id, vehicleId, type, message,
      ...extra, read: false,
      createdAt: serverTimestamp(),
    });
    /* push notification to owner */
    try {
      const vSnap = await getDoc(doc(db, 'trackedVehicles', vehicleId));
      if (vSnap.exists() && window.SokoniNotifications) {
        await window.SokoniNotifications.push(vSnap.data().ownerUid, {
          type:    'alert',
          icon:    type === 'theft' ? '🚨' : type === 'speed' ? '⚡' : '📍',
          heading: type === 'theft' ? 'Theft Alert!' : type === 'speed' ? 'Speed Alert' : 'Geofence Alert',
          sub:     message,
          link:    'car-hub.html#tracking',
        });
      }
    } catch {}
    return id;
  },

  async markAlertRead(alertId) {
    await updateDoc(doc(db, 'vehicleAlerts', alertId), { read: true });
  },

  listenVehicleAlerts(vehicleId, callback, limitN = 50) {
    const q = query(
      collection(db, 'vehicleAlerts'),
      where('vehicleId', '==', vehicleId),
      orderBy('createdAt', 'desc'),
      limit(limitN)
    );
    return onSnapshot(q,
      s => callback(s.docs.map(d => ({ _fsId: d.id, ...d.data() }))),
      e => console.warn('[SokoniTracking] alerts:', e.message)
    );
  },

  listenOwnerAlerts(callback, limitN = 100) {
    const uid = _uid();
    if (!uid) { callback([]); return () => {}; }
    /* get all vehicles owned by uid first, then listen alerts */
    const q = query(
      collection(db, 'vehicleAlerts'),
      where('read', '==', false),
      orderBy('createdAt', 'desc'),
      limit(limitN)
    );
    return onSnapshot(q,
      async s => {
        const allAlerts = s.docs.map(d => ({ _fsId: d.id, ...d.data() }));
        /* filter to owned vehicles */
        const vehicleIds = [...new Set(allAlerts.map(a => a.vehicleId))];
        const owned = new Set();
        await Promise.all(vehicleIds.map(async (vid) => {
          try {
            const vs = await getDoc(doc(db, 'trackedVehicles', vid));
            if (vs.exists() && _canView(vs.data(), uid)) owned.add(vid);
          } catch {}
        }));
        callback(allAlerts.filter(a => owned.has(a.vehicleId)));
      },
      e => console.warn('[SokoniTracking] ownerAlerts:', e.message)
    );
  },

  /* ════════════════════════════════════════
     THEFT MODE
  ════════════════════════════════════════ */

  async enableTheftMode(vehicleId) {
    const uid = _uid();
    const snap = await getDoc(doc(db, 'trackedVehicles', vehicleId));
    if (!snap.exists() || snap.data().ownerUid !== uid) throw new Error('Not authorised');
    await updateDoc(doc(db, 'trackedVehicles', vehicleId), {
      theftMode: true, theftModeAt: serverTimestamp(), updatedAt: serverTimestamp(),
    });
    await this.createAlert(vehicleId, 'theft', 'Theft recovery mode activated. Tracking intensified.');
  },

  async disableTheftMode(vehicleId) {
    const uid = _uid();
    const snap = await getDoc(doc(db, 'trackedVehicles', vehicleId));
    if (!snap.exists() || snap.data().ownerUid !== uid) throw new Error('Not authorised');
    await updateDoc(doc(db, 'trackedVehicles', vehicleId), {
      theftMode: false, updatedAt: serverTimestamp(),
    });
  },

  /* ════════════════════════════════════════
     GPS DEVICES
  ════════════════════════════════════════ */

  async registerGPSDevice(device) {
    const uid = _uid();
    const id = device.id || _id('GPS-');
    await setDoc(doc(db, 'gpsDevices', id), {
      ...device, id, ownerUid: uid,
      status:    device.status    || 'unlinked',
      vehicleId: device.vehicleId || null,
      createdAt: device.createdAt || serverTimestamp(),
      updatedAt: serverTimestamp(),
    }, { merge: true });
    return id;
  },

  async linkDeviceToVehicle(deviceId, vehicleId) {
    const uid = _uid();
    const dSnap = await getDoc(doc(db, 'gpsDevices', deviceId));
    if (!dSnap.exists() || dSnap.data().ownerUid !== uid) throw new Error('Device not found or not yours');
    await updateDoc(doc(db, 'gpsDevices', deviceId), {
      vehicleId, status: 'active', updatedAt: serverTimestamp(),
    });
    await updateDoc(doc(db, 'trackedVehicles', vehicleId), {
      gpsDeviceId: deviceId, updatedAt: serverTimestamp(),
    });
  },

  listenMyGPSDevices(callback) {
    const uid = _uid();
    if (!uid) { callback([]); return () => {}; }
    const q = query(
      collection(db, 'gpsDevices'),
      where('ownerUid', '==', uid),
      orderBy('createdAt', 'desc')
    );
    return onSnapshot(q,
      s => callback(s.docs.map(d => ({ _fsId: d.id, ...d.data() }))),
      e => console.warn('[SokoniTracking] devices:', e.message)
    );
  },

  /* ════════════════════════════════════════
     TEMPORARY SHARE LINKS
  ════════════════════════════════════════ */

  async createShareLink(vehicleId, expiryHours = 24) {
    const uid = _uid();
    const snap = await getDoc(doc(db, 'trackedVehicles', vehicleId));
    if (!snap.exists() || snap.data().ownerUid !== uid) throw new Error('Not authorised');
    const id = _id('SHR-');
    const _tb = new Uint8Array(12);
    crypto.getRandomValues(_tb);
    const token = Array.from(_tb, b => b.toString(16).padStart(2,'0')).join('').toUpperCase();
    const expiresAt = new Date(Date.now() + expiryHours * 3600000);
    await setDoc(doc(db, 'trackingShares', id), {
      id, vehicleId, token, createdBy: uid,
      expiresAt: expiresAt.toISOString(),
      createdAt: serverTimestamp(),
    });
    return { id, token, link: `car-hub.html?share=${token}`, expiresAt };
  },

  async validateShareLink(token) {
    const q = query(collection(db, 'trackingShares'), where('token', '==', token), limit(1));
    const snap = await getDocs(q);
    if (!snap.docs.length) return null;
    const share = { _fsId: snap.docs[0].id, ...snap.docs[0].data() };
    if (new Date(share.expiresAt) < new Date()) return null;
    return share;
  },

  /* ════════════════════════════════════════
     SUBSCRIPTIONS
  ════════════════════════════════════════ */

  async getSubscription() {
    const uid = _uid();
    if (!uid) return null;
    const snap = await getDoc(doc(db, 'trackingSubscriptions', uid));
    return snap.exists() ? { _fsId: snap.id, ...snap.data() } : null;
  },

  async saveSubscription(plan) {
    const uid = _uid();
    if (!uid) throw new Error('Login required');
    await setDoc(doc(db, 'trackingSubscriptions', uid), {
      uid, plan, vehicleLimit: plan === 'basic' ? 1 : plan === 'pro' ? 5 : 50,
      activatedAt: serverTimestamp(),
      updatedAt:   serverTimestamp(),
    }, { merge: true });
  },

  /* ════════════════════════════════════════
     VEHICLE MAINTENANCE RECORDS
  ════════════════════════════════════════ */

  async addServiceRecord(vehicleId, record) {
    const uid = _uid();
    const snap = await getDoc(doc(db, 'trackedVehicles', vehicleId));
    if (!snap.exists() || snap.data().ownerUid !== uid) throw new Error('Not authorised');
    const id = _id('SVC-');
    await setDoc(doc(db, 'vehicleServiceHistory', id), {
      ...record, id, vehicleId, uid,
      createdAt: serverTimestamp(),
    });
    return id;
  },

  listenServiceHistory(vehicleId, callback, limitN = 50) {
    const q = query(
      collection(db, 'vehicleServiceHistory'),
      where('vehicleId', '==', vehicleId),
      orderBy('createdAt', 'desc'),
      limit(limitN)
    );
    return onSnapshot(q,
      s => callback(s.docs.map(d => ({ _fsId: d.id, ...d.data() }))),
      e => console.warn('[SokoniTracking] serviceHistory:', e.message)
    );
  },

  /* ════════════════════════════════════════
     DRIVER MONITORING
  ════════════════════════════════════════ */

  async logDriverSession(vehicleId, session) {
    const uid = _uid();
    const id = _id('DRV-');
    await setDoc(doc(db, 'driverSessions', id), {
      ...session, id, vehicleId, driverUid: uid,
      createdAt: serverTimestamp(),
    });
    return id;
  },

  listenDriverSessions(vehicleId, callback, limitN = 20) {
    const q = query(
      collection(db, 'driverSessions'),
      where('vehicleId', '==', vehicleId),
      orderBy('createdAt', 'desc'),
      limit(limitN)
    );
    return onSnapshot(q,
      s => callback(s.docs.map(d => ({ _fsId: d.id, ...d.data() }))),
      e => console.warn('[SokoniTracking] driverSessions:', e.message)
    );
  },
};

window.SokoniTracking = SokoniTracking;
export default SokoniTracking;
