/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI TILL REGISTRY — one answer to "what hardware has this till SAVED?"
   ══════════════════════════════════════════════════════════════════════════════
   NOT sokoni-device-registry.js. That module already exists and models a LIVE device
   SESSION — connecting / connected / disconnected / error / recovering, with
   transports, drivers and connection handles. This one answers the durable question
   it deliberately does not: what has this merchant PAIRED before, and has this till
   finished its one-time setup.

   The two are complementary and must not be merged. Collapsing them is precisely how
   "saved" came to be mistaken for "connected".

   THE DEFECT THIS EXISTS TO END

   Devices showed a saved printer while Till Setup said "no printer", because the two
   surfaces were answering DIFFERENT QUESTIONS and neither knew it:

     Devices     read localStorage['sk_devices_<uid>']   → "we have seen this printer"
     Till Setup  read a postMessage broadcast            → "a printer is answering NOW"

   Both were correct. Neither was canonical. A printer that was saved but not currently
   connected therefore appeared as no printer at all — and opened standalone, where no
   broadcast is ever sent, Till Setup could never see one.

   SAVED IS NOT CONNECTED, AND THIS MODULE WILL NOT CONFLATE THEM

   `saved` is durable: the merchant has paired this device before. It survives a
   reload, a login, a new session.
   `connected` is momentary: a transport is answering right now. Web Bluetooth cannot
   re-open a GATT link without a user gesture, so after every reload a saved printer is
   legitimately NOT connected until the cashier reconnects.

   This module therefore NEVER infers `connected`. It is supplied by whoever holds the
   transport, and defaults to false. Inferring it is how a till claims a printer is
   ready and then silently fails to print a customer's receipt.

   SETUP COMPLETION IS DURABLE AND PER-MERCHANT

   `sokoni_setup_complete` was a single browser-global flag. On a shared till, one
   merchant's completed setup satisfied the next merchant's gate. It is keyed by uid
   here for the same reason the device list is.

   Completion is a ONE-TIME initialisation, never a recurring prerequisite: adding a
   device, editing settings, or a printer being disconnected must not revoke it. Only
   an explicit reset does.
   ══════════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SokoniTillRegistry = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var DEV_PREFIX   = 'sk_devices_';
  var SETUP_PREFIX = 'sk_pos_setup_';
  var TYPES = ['printer', 'scanner', 'drawer', 'terminal'];

  /* STATES. Ordered by strength; nothing here is a synonym for another. */
  var STATE = {
    NONE: 'none',            /* nothing has ever been paired            */
    SAVED: 'saved',          /* paired before; not answering now        */
    CONNECTED: 'connected',  /* a transport is answering right now      */
  };

  /* localStorage is per-browser and may throw (private mode, disabled storage).
     Every access is guarded: a till whose storage is unavailable must degrade to
     "nothing saved", never to an exception that blocks the POS from booting. */
  function _get (k) {
    try { return localStorage.getItem(k); } catch (_) { return null; }
  }
  function _set (k, v) {
    try { localStorage.setItem(k, v); return true; } catch (_) { return false; }
  }
  function _del (k) {
    try { localStorage.removeItem(k); return true; } catch (_) { return false; }
  }

  /* An anonymous key is deliberate, not a fallback bug: a signed-out till still needs
     somewhere to put a pairing, and it must not collide with a real uid. */
  function uidOf (uid) { return uid || 'anon'; }
  function key (uid) { return DEV_PREFIX + uidOf(uid); }
  function setupKey (uid) { return SETUP_PREFIX + uidOf(uid); }

  function load (uid) {
    var raw = _get(key(uid));
    if (!raw) return [];
    try {
      var v = JSON.parse(raw);
      return Array.isArray(v) ? v.filter(function (d) { return d && d.type; }) : [];
    } catch (_) {
      /* Corrupt storage is treated as empty, never as a crash. */
      return [];
    }
  }

  /* Save is idempotent per (type, id): re-pairing the same printer updates it rather
     than accumulating duplicates that would make "the" printer ambiguous. */
  function save (uid, device) {
    if (!device || !device.type) return load(uid);
    var d = {
      type: String(device.type),
      id: device.id == null ? null : String(device.id),
      name: device.name == null ? null : String(device.name),
      savedAt: device.savedAt || Date.now(),
    };
    var list = load(uid).filter(function (x) {
      return !(x.type === d.type && String(x.id) === String(d.id));
    });
    list.push(d);
    _set(key(uid), JSON.stringify(list));
    return list;
  }

  function remove (uid, type, id) {
    var list = load(uid).filter(function (x) {
      return !(x.type === type && String(x.id) === String(id));
    });
    _set(key(uid), JSON.stringify(list));
    return list;
  }

  function first (uid, type) {
    var m = load(uid).filter(function (d) { return d.type === type; });
    return m.length ? m[m.length - 1] : null;   /* most recently saved wins */
  }

  /* THE ONE QUESTION EVERY SURFACE ASKS.
     `liveConnected` is supplied by whoever holds the transport — the shell engine, or a
     page's own engine when running standalone. It is NEVER derived from the saved
     record, because "we have seen this printer" is not evidence that it is answering.
     Callers with no transport information pass nothing and get `saved`, which is the
     honest answer. */
  function describe (uid, type, liveConnected, liveName) {
    var saved = first(uid, type);
    var connected = liveConnected === true;
    var state = connected ? STATE.CONNECTED : (saved ? STATE.SAVED : STATE.NONE);
    return {
      type: type,
      state: state,
      saved: saved,
      connected: connected,
      /* The name of a live device wins — it is what is actually on the other end. */
      name: (connected && liveName) || (saved && saved.name) || null,
      /* Deliberately explicit so no caller has to re-derive the distinction. */
      hasEverBeenPaired: !!saved,
      needsReconnect: !!saved && !connected,
      label: connected ? 'Connected'
           : saved ? 'Saved — tap to reconnect'
           : 'No device paired',
    };
  }

  function printer (uid, liveConnected, liveName) {
    return describe(uid, 'printer', liveConnected, liveName);
  }

  /* ── setup completion ────────────────────────────────────────────────────── */

  /* Durable and per-merchant. Stores WHEN and WHAT completed it, so a later question
     ("was this till ever set up?") has an auditable answer rather than a bare '1'. */
  function markSetupComplete (uid, detail) {
    var rec = {
      complete: true,
      at: Date.now(),
      branchId: (detail && detail.branchId) || null,
      tillId: (detail && detail.tillId) || null,
    };
    _set(setupKey(uid), JSON.stringify(rec));
    return rec;
  }

  function setupState (uid) {
    var raw = _get(setupKey(uid));
    if (raw) {
      try {
        var v = JSON.parse(raw);
        if (v && v.complete === true) return v;
      } catch (_) { /* fall through to the legacy check */ }
    }
    /* LEGACY: the old browser-global flag. Honoured for READING so a till that completed
       setup before this module existed is not sent back through the wizard — but it is
       never written again, and it is not per-merchant, so it is reported as legacy
       rather than silently trusted as this merchant's. */
    if (_get('sokoni_setup_complete') === '1') {
      return { complete: true, at: null, legacy: true, branchId: null, tillId: null };
    }
    return { complete: false, at: null, branchId: null, tillId: null };
  }

  function isSetupComplete (uid) { return setupState(uid).complete === true; }

  /* Only an explicit reset clears it. There is deliberately no code path that revokes
     completion because a device went away — that is the recurring-setup defect this
     module exists to remove. */
  function resetSetup (uid) { _del(setupKey(uid)); }

  return {
    STATE: STATE, TYPES: TYPES,
    DEV_PREFIX: DEV_PREFIX, SETUP_PREFIX: SETUP_PREFIX,
    key: key, setupKey: setupKey,
    load: load, save: save, remove: remove, first: first,
    describe: describe, printer: printer,
    markSetupComplete: markSetupComplete, setupState: setupState,
    isSetupComplete: isSetupComplete, resetSetup: resetSetup,
  };
}));
