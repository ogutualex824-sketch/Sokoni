/* ════════════════════════════════════════════════════════════════════════════
   SOKONI — POS boot decision
   ════════════════════════════════════════════════════════════════════════════
   Wires SokoniPosContext into /pos. It changes ONE thing: the decision about
   what /pos should show. It does not touch the sale engine, payments, the
   service worker, caching, or the 67-module load order.

   ── THE OLD DECISION ────────────────────────────────────────────────────────
   localStorage flags. A merchant on a new phone was pushed back through
   business registration, because device storage answers "new browser", never
   "new business".

   ── THE NEW ONE ─────────────────────────────────────────────────────────────
       auth resolves -> resolver -> business / branch / device -> decision

   ── IT FAILS TOWARD POS, ALWAYS ─────────────────────────────────────────────
   This runs on the page that is currently crashing on one device. If anything
   here is slow, throws, or cannot reach Firestore, it does NOTHING and lets POS
   boot exactly as it does today. It may only ever ADD a message for a decision
   it positively established. A diagnostic-grade addition must not become a new
   way for POS to fail to open.

   ── IT NEVER NAVIGATES ──────────────────────────────────────────────────────
   No location.replace, no redirect. The splash/redirect chain fighting itself
   is part of what made this page fragile; this renders in place instead.
   ════════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var AUTH_TIMEOUT_MS = 12000;
  var DONE = false;

  function log(m) { try { if (window.sokoniStage) window.sokoniStage('pos-boot:' + m); } catch (e) {} }

  /* ── wait for auth, bounded ──────────────────────────────────────────── */
  function whenAuth() {
    return new Promise(function (res) {
      var settled = false;
      var finish = function (uid) { if (!settled) { settled = true; res(uid || null); } };
      try {
        if (window.__sokoniAuthReady) return finish(window.__sokoniCurrentUid || null);
        document.addEventListener('sokoniAuthReady', function () {
          finish(window.__sokoniCurrentUid || null);
        }, { once: true });
      } catch (e) { /* fall through to the timeout */ }
      /* A page that never resolves auth must not be held here forever. */
      setTimeout(function () { finish(window.__sokoniCurrentUid || null); }, AUTH_TIMEOUT_MS);
    });
  }

  /* ── a compat-shaped db for the resolver ─────────────────────────────────
     SokoniPosContext is certified against `.collection().where().get()`. The
     app uses the MODULAR SDK, so the shim lives here rather than changing a
     module that is already proven — the adapter is the thing that should bend. */
  function compatDb(fs, db) {
    var rows = function (snap) {
      return { docs: snap.docs.map(function (d) { return { id: d.id, data: function () { return d.data(); } }; }) };
    };
    return {
      collection: function (name) {
        return {
          where: function (f, op, v) {
            return { get: function () {
              return fs.getDocs(fs.query(fs.collection(db, name), fs.where(f, op, v))).then(rows);
            } };
          },
          doc: function (id) {
            return { get: function () {
              return fs.getDoc(fs.doc(db, name, id)).then(function (d) {
                return { exists: d.exists(), data: function () { return d.data(); } };
              });
            } };
          }
        };
      }
    };
  }

  /* ── the message surface ─────────────────────────────────────────────────
     Rendered in place. Never replaces the page, never navigates. */
  function show(title, body, actionLabel, actionHref) {
    if (document.getElementById('sk-pos-boot-note')) return;
    var w = document.createElement('div');
    w.id = 'sk-pos-boot-note';
    w.setAttribute('role', 'status');
    w.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:2147483000;' +
      'background:#0b1017;border-top:2px solid #0af;color:#e8f2ff;padding:16px 16px 22px;' +
      'font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif';
    var h = document.createElement('div');
    h.style.cssText = 'font-weight:700;margin-bottom:4px'; h.textContent = title;
    var p = document.createElement('div');
    p.style.cssText = 'color:#8aa0b8;font-size:13px'; p.textContent = body;
    w.appendChild(h); w.appendChild(p);
    if (actionLabel && actionHref) {
      var a = document.createElement('a');
      a.href = actionHref; a.textContent = actionLabel;
      a.style.cssText = 'display:inline-block;margin-top:12px;padding:11px 18px;border-radius:10px;' +
        'background:#12233a;border:1px solid #1e4470;color:#9fd0ff;font-weight:600;text-decoration:none';
      w.appendChild(a);
    }
    document.body.appendChild(w);
  }

  /* ── the readout, OPT-IN via ?diag=context ───────────────────────────────
     Silence is ambiguous: a normal POS page means EITHER "open-pos" OR "the
     resolver failed and correctly failed toward POS". Those must never look the
     same when we are trying to prove the authenticated read works, so this
     prints exactly what the resolver returned — including whether the
     posDevices read SUCCEEDED, which is the end-to-end proof the rules repair
     still lacks.

     Reads only what resolve() already produced. No extra queries, no secrets —
     uids and ids are truncated. */
  function readout(r, err) {
    var box = document.createElement('div');
    box.id = 'sk-pos-context-diag';
    box.style.cssText = 'position:fixed;inset:0;z-index:2147483646;overflow:auto;' +
      'white-space:pre-wrap;word-break:break-word;background:#04121a;color:#8fe;' +
      'font:12px/1.5 ui-monospace,Menlo,monospace;padding:14px';
    var cut = function (v) { return v == null ? '—' : String(v).slice(0, 14) + (String(v).length > 14 ? '…' : ''); };
    var L = [];
    L.push('POS CONTEXT — what the resolver actually returned');
    L.push('');
    if (err) {
      L.push('RESOLVER THREW: ' + err);
      L.push('');
      L.push('POS still booted — this is the fail-toward-POS path.');
    } else if (!r) {
      L.push('resolver did not run (no uid, or the module was absent)');
      L.push('signed in: ' + (window.__sokoniCurrentUid ? 'YES ' + cut(window.__sokoniCurrentUid) : 'NO'));
    } else if (!r.ok) {
      L.push('DECISION   (refused)');
      L.push('reason     ' + r.reason);
    } else {
      L.push('DECISION   ' + r.decision);
      L.push('uid        ' + cut(r.uid));
      L.push('');
      L.push('businesses ' + (r.businesses.length
        ? r.businesses.map(function (b) { return b.id + ' (' + b.name + ')'; }).join(', ')
        : 'NONE — this account owns no business'));
      L.push('branches   ' + (r.branches.length
        ? r.branches.map(function (b) { return b.id + (b.isDefault ? ' *default' : ''); }).join(', ')
        : 'none'));
      L.push('');
      L.push('DEVICE');
      L.push('  deviceId   ' + cut(r.device && r.device.deviceId));
      L.push('  registered ' + (r.device && r.device.registered));
      L.push('  reason     ' + ((r.device && r.device.reason) || '—'));
      L.push('  merchantId ' + cut(r.device && r.device.merchantId));
      L.push('  branchId   ' + cut(r.device && r.device.branchId));
      L.push('  suspended  ' + !!(r.device && r.device.suspended));
      L.push('');
      /* THE B PROOF. "unreadable" means the rules refused the read; anything
         else means the client genuinely read posDevices. */
      var readOk = r.device && r.device.reason !== 'unreadable';
      L.push('posDevices READ BY THE BROWSER: ' + (readOk ? 'YES — rules repair works end to end'
                                                          : 'NO — the read was refused'));
    }
    L.push('');
    L.push('(tap to close)');
    box.textContent = L.join('\n');
    box.addEventListener('click', function () { box.remove(); });
    document.documentElement.appendChild(box);
    try { navigator.clipboard && navigator.clipboard.writeText(L.join('\n')); } catch (e) {}
  }

  var WANT_DIAG = /[?&]diag=context\b/.test(location.search);

  function act(r) {
    if (WANT_DIAG) readout(r, null);
    if (!r || !r.ok) return;                      /* unauthenticated: POS's own guard owns that */
    switch (r.decision) {
      case 'open-pos':
        log('open-pos');
        return;                                   /* the common case does NOTHING */
      case 'pair-device':
        log('pair-device');
        show('Connect this device',
          'Your business is already set up on SOKONI. This device just needs to be paired to ' +
          ((r.businesses[0] && r.businesses[0].name) || 'your shop') + '.',
          'Set up this device', '/pos-setup');
        return;
      case 'device-suspended':
        log('device-suspended');
        show('This device is suspended',
          'Selling is disabled on this device. An owner or manager can re-enable it. ' +
          'Pairing it again will not restore access.');
        return;
      case 'paired-elsewhere':
        log('paired-elsewhere');
        show('This device belongs to another business',
          'It is registered to a different merchant. Ask an owner to release it before pairing it here.');
        return;
      case 'retry':
        log('retry');
        show('Could not check this device',
          'SOKONI could not confirm whether this device is paired. This is not a setup problem — ' +
          'check the connection and reload.');
        return;
      case 'no-owned-business':
        log('no-owned-business');
        /* Deliberately silent. This account may be an EMPLOYEE, and employee
           resolution is not this slice's job. Saying "create a business" here
           is precisely the wrong answer, so nothing is said at all. */
        return;
      default:
        return;
    }
  }

  function run() {
    if (DONE) return; DONE = true;
    log('start');
    whenAuth().then(function (uid) {
      /* The readout must ALWAYS have something to say. Returning silently here
         is right for the product, but it is exactly the ambiguity the
         diagnostic exists to remove — "nothing happened" and "no user" have to
         be distinguishable when proving the authenticated path. */
      if (!uid) { log('no-uid'); if (WANT_DIAG) readout(null, null); return; }
      if (!window.SokoniPosContext) {
        log('no-resolver');
        if (WANT_DIAG) readout(null, 'SokoniPosContext was not loaded');
        return;
      }
      return import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js')
        .then(function (fs) {
          var db = window.firebaseDB || fs.getFirestore();
          if (!db) { log('no-db'); return; }
          return window.SokoniPosContext.resolve({ db: compatDb(fs, db), uid: uid });
        })
        .then(act);
    }).catch(function (e) {
      /* Fail toward POS. A boot decision that cannot be made is not a reason to
         stop the till from opening. The readout still reports it, so a failure
         is never mistaken for a healthy "open-pos". */
      log('failed:' + ((e && e.message) || e));
      if (WANT_DIAG) { try { readout(null, (e && e.message) || String(e)); } catch (_) {} }
    });
  }

  /* After load, so nothing here competes with the module graph or first paint. */
  if (document.readyState === 'complete') setTimeout(run, 600);
  else window.addEventListener('load', function () { setTimeout(run, 600); });
}());
