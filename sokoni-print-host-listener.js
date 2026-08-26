/* ═══════════════════════════════════════════════════════════════════════════════
   SokoniPrintHost — the desktop side of the phone→desktop print bridge
   ═══════════════════════════════════════════════════════════════════════════════
       PHONE  sale commits → posRetailSales/{saleId}
                                  │  (Firestore trigger)
                                  ▼
                       posPrintJobs/{shopId}__{saleId}   PENDING
                                  │  realtime
                                  ▼
       DESKTOP  onSnapshot → atomic CLAIM → SokoniReceiptDoc → P58E → PRINTED

   REALTIME IS NOTIFICATION, NOT AUTHORIZATION.

   That is the whole idea. onSnapshot is allowed to say exactly one thing: "there is possibly
   new work". It is never permitted to say "print this". Firestore will happily deliver the same
   document again on a reconnect, a metadata change, a tab regaining focus, or a fresh listener
   replaying its initial snapshot — and every one of those is indistinguishable from real new
   work at the client. So the decision is made server-side, once, by claimPrintJob.

   THE ONE GATE. Nothing reaches the printer except through:

       intent  →  claim  →  mayPrint === true  →  send bytes

   There is no second path. `_processJob` below is the ONLY function in this file that can
   reach a transport, and its very first act is the claim. A snapshot handler cannot print; it
   can only enqueue a job id.

   WHY THE WORK IS SERIALISED. Two snapshot events for one document, arriving a millisecond
   apart, would otherwise produce two concurrent claims from the SAME device — and the server
   would idempotently grant both, because they are the same host. Both would then hold
   mayPrint:true for a job in CLAIMED and both would send bytes. The server cannot distinguish
   those; only the client can, by never running two attempts at one job at once.

   THE PHONE KNOWS NOTHING ABOUT BLUETOOTH. It does not discover the P58E, connect to it, or
   talk to this desktop. It sells; the sale commits; Firestore carries the fact. This file is
   the only place that touches a printer.

   NOT A RECEIPT AUTHORITY. The intent carries routing metadata only. The receipt is rendered
   from the canonical sale through SokoniReceiptDoc, exactly like every other surface.
   ═══════════════════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  var FS_SDK = 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
  var FN_SDK = 'https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js';

  var S = {
    running: false,
    unsub: null,
    shopId: null,
    deviceId: null,
    seen: Object.create(null),   /* jobId -> true, this session */
    queue: [],
    working: false,
    stats: { notified: 0, claimed: 0, printed: 0, failed: 0, declined: 0 },
    onEvent: null,
  };

  function _emit (type, detail) {
    try { if (typeof S.onEvent === 'function') S.onEvent(type, detail || {}); } catch (_) {}
    try {
      if (root.dispatchEvent && typeof CustomEvent === 'function') {
        root.dispatchEvent(new CustomEvent('sokoni:printhost', { detail: { type: type, detail: detail || {} } }));
      }
    } catch (_) {}
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     THE GATE — the only route to a transport in this file
     ───────────────────────────────────────────────────────────────────────────
     Dependencies are injected rather than reached for, so this can be executed in a test
     against real assertions instead of read as source. `deps.send` is the printer.
     ═══════════════════════════════════════════════════════════════════════════ */
  async function _processJob (jobId, deps) {
    if (!jobId) return { printed: false, reason: 'no-job-id' };

    /* THE CLAIM COMES FIRST. Not after a render, not after a connectivity check, not after
       anything — because every line before it is a line that could grow a way to print. */
    var claim;
    try {
      claim = await deps.claim({ jobId: jobId, deviceId: S.deviceId });
    } catch (err) {
      var code = (err && (err.code || err.message)) || 'error';
      /* Someone else legitimately holds it, or it is already done. Not an error to report. */
      _emit('declined', { jobId: jobId, code: code });
      S.stats.declined++;
      return { printed: false, reason: 'claim-refused', code: code };
    }

    /* mayPrint is the ONLY signal that authorises paper. A job that is already PRINTING comes
       back mayPrint:false even to its own claimant, because after a crash mid-print nobody can
       know whether paper already came out. */
    if (!claim || claim.mayPrint !== true) {
      _emit('declined', { jobId: jobId, status: claim && claim.status });
      S.stats.declined++;
      return { printed: false, reason: 'not-granted', status: claim && claim.status };
    }

    var token = claim.claimToken;
    S.stats.claimed++;
    _emit('claimed', { jobId: jobId, tookOverStale: !!claim.tookOverStale });

    /* Reconstruct the receipt from the CANONICAL sale. The intent is routing metadata; it
       carries no totals and is not a receipt. */
    var sale = null;
    try { sale = await deps.loadSale(claim); } catch (e) { sale = null; }
    if (!sale) {
      await _fail(deps, jobId, token, 'canonical sale could not be read');
      return { printed: false, reason: 'no-sale' };
    }

    var doc;
    try { doc = deps.render(sale); } catch (e) {
      await _fail(deps, jobId, token, 'receipt render failed: ' + (e && e.message));
      return { printed: false, reason: 'render-failed' };
    }

    /* Declare PRINTING before the bytes go out, so a crash mid-print leaves a job that cannot
       be silently re-sent — it needs an explicit failure and an explicit retry. */
    try {
      await deps.advance({ jobId: jobId, to: 'PRINTING', claimToken: token });
    } catch (e) {
      _emit('declined', { jobId: jobId, code: 'fenced' });
      return { printed: false, reason: 'fenced-before-print' };
    }

    try {
      var res = await deps.send(doc, sale);
      /* NEVER report success on a transport that told us it failed. */
      if (res && res.ok === false) throw new Error(res.error || 'printer reported failure');
    } catch (e) {
      await _fail(deps, jobId, token, (e && e.message) || 'print failed');
      return { printed: false, reason: 'send-failed' };
    }

    try { await deps.advance({ jobId: jobId, to: 'PRINTED', claimToken: token }); }
    catch (e) { /* it printed; the record lagging is not a reason to print again */ }

    S.stats.printed++;
    _emit('printed', { jobId: jobId });
    return { printed: true };
  }

  async function _fail (deps, jobId, token, message) {
    S.stats.failed++;
    _emit('failed', { jobId: jobId, error: message });
    try { await deps.advance({ jobId: jobId, to: 'FAILED', claimToken: token, error: message }); }
    catch (_) {}
  }

  /* ── Serial worker ────────────────────────────────────────────────────────
     One job at a time, and one attempt per job id per pass. See the note above on why two
     concurrent claims from the same device are the dangerous case. */
  function _enqueue (jobId) {
    if (!jobId || S.seen[jobId]) return;
    S.seen[jobId] = true;
    S.queue.push(jobId);
    _emit('notified', { jobId: jobId });
    S.stats.notified++;
    _drain();
  }

  async function _drain () {
    if (S.working) return;
    S.working = true;
    try {
      while (S.queue.length && S.running) {
        var jobId = S.queue.shift();
        try { await _processJob(jobId, S.deps); }
        catch (e) { _emit('error', { jobId: jobId, error: (e && e.message) || String(e) }); }
      }
    } finally { S.working = false; }
  }

  /* ── Live wiring ──────────────────────────────────────────────────────────── */
  async function _defaultDeps () {
    var fnMod = await import(FN_SDK);
    var fsMod = await import(FS_SDK);
    var fbMod = await import('./firebase.js');
    var fns = fnMod.getFunctions(undefined, 'us-central1');
    var db  = fbMod.db;

    return {
      claim:   function (p) { return fnMod.httpsCallable(fns, 'claimPrintJob')(p).then(function (r) { return r.data; }); },
      advance: function (p) { return fnMod.httpsCallable(fns, 'advancePrintJob')(p).then(function (r) { return r.data; }); },
      loadSale: async function (claim) {
        var src = (claim && claim.source) || null;
        var col = (src && src.collection) || 'posRetailSales';
        var id  = (src && src.id) || (claim && claim.saleId);
        if (!id) return null;
        var snap = await fsMod.getDoc(fsMod.doc(db, col, id));
        return snap.exists() ? Object.assign({ id: snap.id }, snap.data()) : null;
      },
      render: function (sale) {
        if (!root.SokoniReceiptDoc || typeof root.SokoniReceiptDoc.render !== 'function') {
          throw new Error('SokoniReceiptDoc is not loaded');
        }
        return root.SokoniReceiptDoc.render(sale, {});
      },
      send: function (doc, sale) {
        if (!root.PosPrintService || typeof root.PosPrintService.printReceipt !== 'function') {
          throw new Error('PosPrintService is not loaded');
        }
        /* The EXISTING transport. No sixth Bluetooth implementation, and the print service
           keeps owning connection state, queueing and retries. */
        return root.PosPrintService.printReceipt(sale, { __fromPrintHost: true, doc: doc });
      },
      _fsMod: fsMod, _db: db,
    };
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     WHICH DEVICE AM I? — and why there is only one right answer
     ───────────────────────────────────────────────────────────────────────────
     Two localStorage keys look like a device id, and picking the wrong one silently breaks
     every claim:

       sokoni_device_id  crypto.randomUUID(), written by pos-setup.html and passed to
                         bootstrapDevice — so it IS the posDevices/{deviceId} document id.
       pos_device_id     'dev_<ts>_<rand>', written by pos-sync.js and never sent to any
                         device Cloud Function. It names nothing on the server.

     Only the first can be claimed with. Using pos_device_id would produce a not-found on every
     claim and look exactly like "the printer is not set up". Returns null rather than
     inventing one: a device this browser has never registered has no business claiming print
     work, and generating an id here would create a third vocabulary for the same thing.
     ═══════════════════════════════════════════════════════════════════════════ */
  function resolveDeviceId () {
    try {
      var id = root.localStorage && root.localStorage.getItem('sokoni_device_id');
      return id ? String(id) : null;
    } catch (_) { return null; }
  }

  async function start (opts) {
    opts = opts || {};
    if (S.running) return { ok: true, already: true };
    if (!opts.deviceId) opts.deviceId = resolveDeviceId();
    if (!opts.shopId || !opts.deviceId) throw new Error('shopId and deviceId are required');

    S.shopId = String(opts.shopId);
    S.deviceId = String(opts.deviceId);
    S.deps = opts.deps || await _defaultDeps();
    S.running = true;

    var fsMod = S.deps._fsMod;
    if (fsMod && S.deps._db) {
      var q = fsMod.query(
        fsMod.collection(S.deps._db, 'posPrintJobs'),
        /* BOTH discriminators. `kind` alone would be enough — legacy LAN-relay rows have no
           such field — and the uppercase status is enough on its own too. Keeping both means
           a refactor that drops one cannot start feeding historical network-print audit rows
           to a Bluetooth printer. */
        fsMod.where('kind', '==', 'printIntent'),
        fsMod.where('shopId', '==', S.shopId),
        fsMod.where('status', '==', 'PENDING'),
        fsMod.orderBy('createdAt', 'asc'),
        fsMod.limit(25),
      );
      S.unsub = fsMod.onSnapshot(q, function (snap) {
        /* NOTIFICATION ONLY. This handler cannot print; it can only name work. */
        snap.forEach(function (d) { _enqueue(d.id); });
      }, function (err) { _emit('error', { error: (err && err.message) || String(err) }); });
    }

    _emit('started', { shopId: S.shopId, deviceId: S.deviceId });
    return { ok: true };
  }

  function stop () {
    S.running = false;
    try { if (S.unsub) S.unsub(); } catch (_) {}
    S.unsub = null;
    S.queue.length = 0;
    _emit('stopped', {});
    return { ok: true };
  }

  /* A manual reprint is NOT a way around the gate: it goes through the same claim, and a
     PRINTED job simply refuses. Retrying a FAILED job is a server transition, deliberately not
     exposed here — an operator does it, and then the listener sees PENDING like any other work. */
  function reprint (jobId) {
    delete S.seen[jobId];
    _enqueue(jobId);
    return { ok: true, queued: true };
  }

  root.SokoniPrintHost = {
    start: start,
    stop: stop,
    resolveDeviceId: resolveDeviceId,
    reprint: reprint,
    stats: function () { return Object.assign({}, S.stats); },
    isRunning: function () { return !!S.running; },
    /* Exposed for tests and for the shell's diagnostics — executing the gate is the only
       honest way to prove nothing else can print. */
    _processJob: _processJob,
    _state: S,
  };
})(typeof window !== 'undefined' ? window : globalThis);
