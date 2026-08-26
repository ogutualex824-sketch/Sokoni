/* ═══════════════════════════════════════════════════════════════════════════════
   SokoniPrinterHostUI — the desktop's "am I the printer host?" surface
   ═══════════════════════════════════════════════════════════════════════════════
   FIRST TIME   merchant chooses → Connect P58E → register this desktop as host
   LATER        open SOKONI → autoReconnect → connected → listen → print

   TWO RULES SHAPE EVERYTHING HERE.

   1. OPENING SOKONI MUST NEVER REGISTER THIS DESKTOP AS HOST. Registration is an explicit
      merchant action. `refresh()` is read-only and physically cannot register — the callable it
      uses (getPrinterHostStatus) has no write path. `register()` exists on its own and is
      reachable only from a button.

   2. THE LISTENER STARTS ONLY WHEN THE DESKTOP IS THE HOST **AND** THE PRINTER IS ACTUALLY
      CONNECTED. Otherwise: PWA opens → listener starts → jobs accumulate → printer connects →
      everything prints at once. `mayStartListener` is true for exactly one state, and
      `_apply()` is the only caller of start().

   SAVED IS NOT CONNECTED. A saved printer is a device the browser remembers, not a live GATT
   link. Showing them the same way is how a merchant believes they are ready to trade when they
   are not, so `saved` renders as "Reconnecting…" with a hollow dot — never as Connected.

   THE SHOP IS NEVER ASSERTED BY THIS BROWSER. It comes back from the server, read off the
   stored posDevices document. This file sends a deviceId and nothing else.

   NO BLUETOOTH LIVES HERE. Connecting is PosPrintService/SokoniDeviceHub's job; this decides
   what to show and when it is safe to listen.
   ═══════════════════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  /* ═══════════════════════════════════════════════════════════════════════════
     THE STATE MACHINE — a pure function, so every combination can be executed
     ───────────────────────────────────────────────────────────────────────────
     inputs
       deviceId      string|null   from localStorage 'sokoni_device_id' (see the two-keys note)
       host          object|null   the getPrinterHostStatus reply, or null if not yet asked
       printerState  string        the shell's honest 5-state printer value
       supported     boolean       Web Bluetooth + getDevices present
     ═══════════════════════════════════════════════════════════════════════════ */
  var ST = {
    NO_DEVICE:      'no-device',
    UNSUPPORTED:    'unsupported',
    UNKNOWN:        'unknown',
    NOT_REGISTERED: 'not-registered',
    NOT_HOST:       'not-host',
    OTHER_HOST:     'other-host',
    HOST_SAVED:     'host-saved',
    HOST_CONNECTING:'host-connecting',
    HOST_CONNECTED: 'host-connected',
  };

  function computeState (input) {
    var i = input || {};
    var host = i.host || null;
    var printerState = i.printerState || 'unknown';

    /* Browsers with no Web Bluetooth can never be a host. Say so once, plainly, instead of
       offering a Connect button that cannot work. */
    if (i.supported === false) {
      return _s(ST.UNSUPPORTED, 'Printing not supported',
        'This browser cannot connect to a Bluetooth printer. Use Chrome or Edge on a desktop.',
        [], false);
    }
    if (!i.deviceId) {
      return _s(ST.NO_DEVICE, 'This desktop is not set up',
        'Run POS setup on this computer first, then come back to make it the printing host.',
        ['setup'], false);
    }
    if (!host) {
      return _s(ST.UNKNOWN, 'Checking…', 'Asking the server about this desktop.', [], false);
    }
    if (host.registered === false) {
      return _s(ST.NOT_REGISTERED, 'This desktop is not registered',
        'Run POS setup on this computer first, then come back to make it the printing host.',
        ['setup'], false);
    }
    if (host.isHost !== true) {
      if (host.otherHost) {
        return _s(ST.OTHER_HOST, 'Another desktop is printing',
          (host.otherHost.printerName || 'Another computer') +
          ' is currently this shop’s printing host. Taking over will stop it printing.',
          ['connect-replace'], false);
      }
      return _s(ST.NOT_HOST, 'Printer not connected',
        'This desktop is not currently the printing host for this shop.',
        ['connect'], false);
    }

    /* It IS the host. Now the honest printer state decides what the merchant sees. */
    if (printerState === 'connected') {
      return _s(ST.HOST_CONNECTED, 'Connected',
        (host.printerName || 'Printer') + ' · Ready to print',
        ['test', 'change'], true);
    }
    if (printerState === 'connecting') {
      return _s(ST.HOST_CONNECTING, 'Reconnecting…',
        (host.printerName || 'Printer') + ' · Reconnecting…', ['change'], false);
    }
    /* saved / unknown / anything else — remembered, NOT live. */
    return _s(ST.HOST_SAVED, 'Saved printer',
      (host.printerName || 'Printer') + ' · Reconnecting…',
      ['reconnect', 'change'], false);
  }

  function _s (kind, title, detail, actions, mayStart) {
    return {
      kind: kind, title: title, detail: detail, actions: actions || [],
      /* ONE flag, one meaning: is it safe to begin consuming print intents? */
      mayStartListener: mayStart === true,
      /* Only two states get a filled dot, and only one of them means paper can come out. */
      dot: kind === ST.HOST_CONNECTED ? 'on' : 'off',
    };
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     Runtime
     ═══════════════════════════════════════════════════════════════════════════ */
  var S = {
    deviceId: null, host: null, view: null, deps: null,
    listenerStarted: false, mount: null, lastSeenAt: null,
  };

  function _deviceId () {
    /* sokoni_device_id ONLY — pos_device_id names nothing on the server.
       docs/findings/POS_DEVICE_ID_TWO_KEYS.md */
    if (root.SokoniPrintHost && typeof root.SokoniPrintHost.resolveDeviceId === 'function') {
      return root.SokoniPrintHost.resolveDeviceId();
    }
    try { return (root.localStorage && root.localStorage.getItem('sokoni_device_id')) || null; }
    catch (_) { return null; }
  }

  function _supported () {
    try { return !!(root.navigator && root.navigator.bluetooth && root.navigator.bluetooth.getDevices); }
    catch (_) { return false; }
  }

  /* READ-ONLY. There is no path from here to registration. */
  async function refresh () {
    S.deviceId = S.deviceId || _deviceId();
    if (S.deviceId && S.deps && S.deps.getStatus) {
      try { S.host = await S.deps.getStatus({ deviceId: S.deviceId }); }
      catch (e) { S.host = { registered: false, error: (e && e.message) || 'lookup failed' }; }
    }
    return _apply();
  }

  function _apply () {
    var view = computeState({
      deviceId: S.deviceId, host: S.host,
      printerState: (S.deps && S.deps.printerState && S.deps.printerState()) || 'unknown',
      supported: _supported(),
    });
    S.view = view;
    _render(view);

    /* THE GATE. Start only on the one state that means host + live printer, and never start
       twice. Stop as soon as that stops being true, so a dropped printer does not leave a
       listener claiming jobs it cannot print. */
    if (view.mayStartListener && !S.listenerStarted) {
      S.listenerStarted = true;
      try {
        S.deps.startListener({ shopId: S.host.shopId, deviceId: S.deviceId });
      } catch (e) { S.listenerStarted = false; }
    } else if (!view.mayStartListener && S.listenerStarted) {
      S.listenerStarted = false;
      try { S.deps.stopListener(); } catch (_) {}
    }
    return view;
  }

  /* EXPLICIT MERCHANT ACTION. Never called by refresh(), never called on load. */
  async function register (opts) {
    opts = opts || {};
    if (!S.deviceId) throw new Error('This desktop is not set up.');

    /* Connect the printer FIRST. Registering a host that cannot print is a promise the shop
       cannot keep, and the merchant would only find out at the next sale. */
    var connected = await S.deps.connectPrinter();
    if (!connected || connected.ok === false) {
      return { ok: false, reason: 'printer-not-connected' };
    }

    var res = await S.deps.registerHost({
      deviceId: S.deviceId,
      replace: !!opts.replace,
      printerIdentity: connected.identity || null,
    });
    await refresh();
    return { ok: true, registered: res };
  }

  function _render (view) {
    if (!S.mount || !view) return;
    var d = root.document;
    if (!d) return;
    S.mount.innerHTML = '';
    var wrap = d.createElement('div');
    wrap.className = 'sk-printer-host sk-ph-' + view.kind;
    wrap.setAttribute('data-state', view.kind);

    var h = d.createElement('div'); h.className = 'sk-ph-h'; h.textContent = 'PRINTER HOST';
    var row = d.createElement('div'); row.className = 'sk-ph-row';
    var dot = d.createElement('span');
    dot.className = 'sk-ph-dot sk-ph-dot-' + view.dot;
    /* The dot is decoration; the text is the fact. A screen reader must not depend on colour. */
    dot.setAttribute('aria-hidden', 'true');
    dot.textContent = view.dot === 'on' ? '●' : '○';
    var t = d.createElement('strong'); t.className = 'sk-ph-title'; t.textContent = view.title;
    row.appendChild(dot); row.appendChild(t);

    var det = d.createElement('div'); det.className = 'sk-ph-detail'; det.textContent = view.detail;

    wrap.appendChild(h); wrap.appendChild(row); wrap.appendChild(det);

    if (view.kind === ST.HOST_CONNECTED && S.lastSeenAt) {
      var ls = d.createElement('div'); ls.className = 'sk-ph-seen';
      ls.textContent = 'Last seen: ' + S.lastSeenAt;
      wrap.appendChild(ls);
    }

    var LABEL = {
      connect: 'Connect P58E', 'connect-replace': 'Print here instead',
      test: 'Test Print', change: 'Change Printer', reconnect: 'Reconnect',
      setup: 'Open POS setup',
    };
    view.actions.forEach(function (a) {
      var b = d.createElement('button');
      b.type = 'button';
      b.className = 'sk-ph-btn sk-ph-' + a;
      b.setAttribute('data-action', a);
      b.textContent = LABEL[a] || a;
      b.addEventListener('click', function () { _act(a); });
      wrap.appendChild(b);
    });
    S.mount.appendChild(wrap);
  }

  function _act (action) {
    if (action === 'connect')          return register({ replace: false });
    if (action === 'connect-replace')  return register({ replace: true });
    if (action === 'change')           return register({ replace: true });
    if (action === 'reconnect')        return S.deps.reconnect().then(refresh);
    if (action === 'test')             return S.deps.testPrint();
    if (action === 'setup')            return S.deps.openSetup && S.deps.openSetup();
    return null;
  }

  /* A fresh binding. `listenerStarted` is module state, and leaving it set across a re-mount —
     a shop switch, a re-login, a device change — would make _apply() believe a listener is
     already running and never start the new one. The surface would read "Connected" while
     nothing consumed print intents, which is the worst of both. So: stop whatever the previous
     deps had running, then start from a known-false flag. */
  function mount (el, deps) {
    if (S.listenerStarted && S.deps && typeof S.deps.stopListener === 'function') {
      try { S.deps.stopListener(); } catch (_) {}
    }
    S.listenerStarted = false;
    S.host = null;
    S.mount = el || null;
    S.deps = deps || S.deps;
    S.deviceId = _deviceId();
    return refresh();
  }

  root.SokoniPrinterHostUI = {
    mount: mount,
    refresh: refresh,
    register: register,
    computeState: computeState,
    STATES: ST,
    view: function () { return S.view; },
    _state: S,
  };
})(typeof window !== 'undefined' ? window : globalThis);
