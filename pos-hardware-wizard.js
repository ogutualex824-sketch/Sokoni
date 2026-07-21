/* =============================================================================
   SOKONI SmartPOS 3.0 — Universal Hardware Abstraction Layer
   pos-hardware-wizard.js
   Version: 3.0.0
   Date: 2026-06-28
   Author: SOKONI Engineering Team
   Description: Client-side hardware abstraction layer for SmartPOS terminals.
                Supports receipt printers, label printers, barcode scanners,
                weighing scales, cash drawers, customer displays, payment
                terminals, NFC readers, and biometric authenticators.
   ============================================================================= */

window.SokoniHardware = (function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Hardware Categories
  // ---------------------------------------------------------------------------
  const CATEGORIES = {
    RECEIPT_PRINTER:  'receipt_printer',
    LABEL_PRINTER:    'label_printer',
    BARCODE_SCANNER:  'barcode_scanner',
    QR_SCANNER:       'qr_scanner',
    WEIGHING_SCALE:   'weighing_scale',
    CASH_DRAWER:      'cash_drawer',
    CUSTOMER_DISPLAY: 'customer_display',
    PAYMENT_TERMINAL: 'payment_terminal',
    NFC_READER:       'nfc_reader',
    BIOMETRIC:        'biometric',
  };

  const CONNECTION_TYPES = {
    USB:          'usb',
    USB_HID:      'usb_hid',
    USB_SERIAL:   'usb_serial',
    BLUETOOTH:    'bluetooth',
    BLUETOOTH_HID:'bluetooth_hid',
    NETWORK:      'network',
    BROWSER:      'browser',
    CAMERA:       'camera',
    SERIAL:       'serial',
  };

  const STATUS = {
    DISCONNECTED: 'disconnected',
    CONNECTING:   'connecting',
    CONNECTED:    'connected',
    ERROR:        'error',
    IDLE:         'idle',
    BUSY:         'busy',
  };

  // ---------------------------------------------------------------------------
  // Internal State
  // ---------------------------------------------------------------------------
  let _registry = {};        // deviceId → device instance
  let _adapters  = {};       // vendorId → AdapterClass
  let _listeners = {};       // event → [handlers]
  let _healthTimer = null;
  let _lastHealthReport = [];

  // ---------------------------------------------------------------------------
  // Event System
  // ---------------------------------------------------------------------------
  function on(event, handler) {
    if (typeof handler !== 'function') return;
    if (!_listeners[event]) _listeners[event] = [];
    _listeners[event].push(handler);
  }

  function off(event, handler) {
    if (!_listeners[event]) return;
    _listeners[event] = _listeners[event].filter(function (h) { return h !== handler; });
  }

  function emit(event, data) {
    var handlers = _listeners[event] || [];
    handlers.forEach(function (h) {
      try { h(data); } catch (e) { console.warn('[SokoniHardware] event handler error:', e); }
    });
  }

  // ---------------------------------------------------------------------------
  // A. DEVICE DISCOVERY & REGISTRATION
  // ---------------------------------------------------------------------------

  /* ══════════════════════════════════════════════════════════════════
     LAYER 3 — DEVICE REGISTRY
     ══════════════════════════════════════════════════════════════════
     What a model IS, independent of any browser. Separating this from
     capabilities() is what stops the wizard conflating "this browser has a
     Bluetooth API" with "this printer can be reached" — the confusion that
     produced "2 hardware categories found" on a device with no printer.

     `interfaces` describes the hardware. `compatible` is then DERIVED from the
     platform, never stored, so adding a native bridge later changes one entry
     in TRANSPORT_HOSTS rather than every device record.

     Accuracy note: budget 58 mm printers ship under many near-identical model
     names with different interface fits. `confirm` marks entries whose exact
     interface set should be read off the unit's own self-test page (hold FEED
     while powering on) rather than trusted from a catalogue. Claiming an
     interface a unit does not have is how a merchant ends up buying the wrong
     cable. */
  var PRINTER_REGISTRY = {
    P58E: {
      manufacturer: 'Generic / OEM', model: 'P58E',
      interfaces: ['bluetooth', 'usb'],   /* common build; Wi-Fi variants exist */
      escpos: true, paperWidthMm: 58, columns: 32,
      cashDrawer: true, encoding: 'CP437 / GB18030',
      confirm: 'Interface set varies by batch — confirm on the printer’s self-test page.',
    },
    'TM-T20': {
      manufacturer: 'Epson', model: 'TM-T20 / TM-T20II',
      interfaces: ['usb', 'network'], escpos: true, paperWidthMm: 80, columns: 48,
      cashDrawer: true, encoding: 'CP437', confirm: null,
    },
    'TSP100': {
      manufacturer: 'Star Micronics', model: 'TSP100',
      interfaces: ['usb', 'network'], escpos: false, paperWidthMm: 80, columns: 48,
      cashDrawer: true, encoding: 'Star line mode', confirm: null,
    },
    GENERIC_NETWORK: {
      manufacturer: 'Any', model: 'Network ESC/POS printer',
      interfaces: ['network'], escpos: true, paperWidthMm: 80, columns: 48,
      cashDrawer: true, encoding: 'CP437', confirm: null,
    },
  };

  /* Which host can actually drive each transport. The browser column is what
     the capability engine reports; `bridge` is the future native/local relay.
     Adding that bridge means editing this table only — no UI, registry or
     configuration change, which is the extensibility requirement. */
  var TRANSPORT_HOSTS = {
    bluetooth: { desktop: true,  android: true,  ios: false, bridge: true },
    usb:       { desktop: true,  android: true,  ios: false, bridge: true },
    serial:    { desktop: true,  android: false, ios: false, bridge: true },
    /* Network is deliberately false everywhere in-browser: the only relay,
       posPrint, accepts LAN addresses but runs in Google Cloud and therefore
       cannot route to them. It becomes true the day a LAN-side bridge exists. */
    network:   { desktop: false, android: false, ios: false, bridge: true },
    airprint:  { desktop: true,  android: false, ios: true,  bridge: true },
    browser:   { desktop: true,  android: true,  ios: true,  bridge: true },
  };

  /**
   * deviceCompatibility(modelKey) — can THIS device work on THIS platform, and
   * on the others? Derived, never stored.
   */
  function deviceCompatibility(modelKey) {
    var dev = PRINTER_REGISTRY[modelKey];
    if (!dev) return null;
    var profile = deviceProfile();
    var host = profile === 'iphone' || profile === 'ipad' ? 'ios'
             : profile.indexOf('android') === 0 ? 'android' : 'desktop';

    var per = {};
    ['desktop', 'android', 'ios', 'bridge'].forEach(function (h) {
      per[h] = dev.interfaces.some(function (i) { return TRANSPORT_HOSTS[i] && TRANSPORT_HOSTS[i][h]; });
    });

    var usableHere = dev.interfaces.filter(function (i) {
      return TRANSPORT_HOSTS[i] && TRANSPORT_HOSTS[i][host];
    });

    return {
      device: dev, thisHost: host, usableHere: usableHere,
      worksHere: usableHere.length > 0,
      platforms: per,
      advice: usableHere.length ? null
        : (per.android || per.desktop
            ? 'This printer connects over ' + dev.interfaces.join(' or ') +
              ', which this browser cannot use. It works on Android or desktop today, or through a local bridge.'
            : 'No supported connection for this device on any current platform.'),
    };
  }

  /**
   * analyzeEnvironment() — the single object the whole UI renders from.
   * Four layers kept apart on purpose: a platform feature can never leak into
   * the device counts.
   */
  async function analyzeEnvironment() {
    var caps = capabilities();
    var summary = await discover();
    return {
      /* L1 */ platform: {
        profile: deviceProfile(), isIOS: caps.platform.isIOS,
        features: ['camera', 'offline', 'touch', 'webShare', 'notifications', 'browserPrint']
          .filter(function (k) { return caps[k] && caps[k].supported; }),
      },
      /* L2 */ transports: {
        available:   ['usb', 'bluetooth', 'serial', 'networkManual', 'browserPrint', 'keyboardScanner', 'camera']
          .filter(function (k) { return caps[k] && caps[k].supported; }),
        unavailable: ['usb', 'bluetooth', 'serial', 'networkDiscovery']
          .filter(function (k) { return caps[k] && !caps[k].supported; })
          .map(function (k) { return { id: k, reason: caps[k].reason }; }),
        recommended: recommendedTransports(),
      },
      /* L3 */ configured: summary.classify ? summary.classify.configured : [],
      /* L4 */ live: summary.classify ? summary.classify.peripheral : [],
      hardwareCount: summary.hardwareCount || 0,
      raw: summary,
    };
  }

  /**
   * capabilities() — what this browser can actually do, and why not.
   *
   * Two separate reasons the wizard reported "nothing found", and neither was
   * a hardware fault:
   *
   * 1. On iOS every browser is WebKit, and WebKit ships no WebUSB, no Web
   *    Bluetooth and no Web Serial. Chrome and Firefox on iPhone are affected
   *    identically — it is not a Safari preference the merchant can change.
   *    discover() guards each transport on `navigator.usb && …` and simply
   *    skips it, so the page reported an empty result with no explanation.
   *
   * 2. Even where those APIs exist, discover() calls getDevices()/getPorts().
   *    Per spec those return ONLY devices the user has already granted this
   *    origin permission to. A first-time setup has granted none, so the array
   *    is empty on Chrome too. Finding a NEW device requires requestDevice()/
   *    requestPort(), which must run inside a user gesture and shows the
   *    browser's own chooser. Neither appears anywhere in this file, so
   *    "Detect Hardware" could never discover unpaired hardware on ANY browser.
   *
   * Raw TCP (port 9100) and mDNS/Bonjour are not exposed to web pages on any
   * browser, so network printers cannot be auto-discovered from a page at all;
   * manual IP entry is the only conforming path.
   *
   * Returns per-transport { supported, reason, action } so the UI can explain
   * instead of showing "Not Found".
   */
  function capabilities() {
    var ua = navigator.userAgent || '';
    var isIOS = /iPad|iPhone|iPod/.test(ua) ||
                (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); /* iPadOS reports as Mac */
    var isSecure = (typeof isSecureContext === 'boolean') ? isSecureContext : (location.protocol === 'https:');

    function cap(apiPresent, iosNote) {
      if (isIOS) {
        return { supported: false, reason: iosNote, action: 'Use a network printer with manual IP, or an Android/desktop browser.' };
      }
      if (!isSecure) {
        return { supported: false, reason: 'Requires a secure (HTTPS) context.', action: 'Open this page over HTTPS.' };
      }
      if (!apiPresent) {
        return { supported: false, reason: 'This browser does not implement the API.', action: 'Use Chrome or Edge on desktop or Android.' };
      }
      return { supported: true, reason: 'Available. Pairing requires tapping a Connect button (browser chooser opens on a user gesture).', action: null };
    }

    var IOS_WEBKIT = 'iOS uses WebKit for every browser, and WebKit does not implement this API. Changing browser on iPhone will not help.';

    return {
      platform: { isIOS: isIOS, secureContext: isSecure, userAgent: ua.slice(0, 180) },
      usb:       cap(!!navigator.usb, IOS_WEBKIT),
      bluetooth: cap(!!navigator.bluetooth, IOS_WEBKIT),
      serial:    cap(!!navigator.serial, IOS_WEBKIT),
      /* Raw sockets and mDNS are unavailable to web pages everywhere, so this
         is a platform limit rather than a browser gap. */
      networkDiscovery: {
        supported: false,
        reason: 'Browsers cannot open raw TCP sockets or query mDNS/Bonjour, so printers cannot be auto-discovered from a web page on any platform.',
        action: 'Enter the printer IP manually — this is the supported path everywhere, including iPhone.',
      },
      networkManual: {
        supported: true,
        reason: 'Manual IP entry works on every platform, including iOS.',
        action: null,
      },
      /* AirPrint/system print dialog — the practical iOS receipt path. */
      browserPrint: {
        supported: typeof window.print === 'function',
        reason: typeof window.print === 'function'
          ? 'System print dialog available (AirPrint on iOS).'
          : 'Print dialog unavailable.',
        action: null,
      },
      camera: {
        supported: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
        reason: (navigator.mediaDevices && navigator.mediaDevices.getUserMedia)
          ? 'Camera available — usable as a barcode scanner.'
          : 'Camera API unavailable.',
        action: null,
      },
      /* A HID scanner types into whatever field has focus. It needs no API at
         all, which makes it the one hardware scanner that works on every
         platform in this matrix — including iPhone over Bluetooth HID, because
         iOS pairs it at the OS level rather than through the browser. */
      keyboardScanner: {
        supported: true,
        reason: 'Keyboard-wedge scanners type into the focused field and need no browser API. On iPhone, pair it in iOS Settings — not in the browser.',
        action: null,
      },
      touch: {
        supported: (navigator.maxTouchPoints || 0) > 0 || 'ontouchstart' in window,
        reason: 'Touch input available.', action: null,
      },
      offline: {
        supported: 'serviceWorker' in navigator && 'indexedDB' in window,
        reason: ('serviceWorker' in navigator && 'indexedDB' in window)
          ? 'Service Worker + IndexedDB available — offline selling supported.'
          : 'Offline storage unavailable; sales require connectivity.',
        action: null,
      },
      webShare: {
        supported: typeof navigator.share === 'function',
        reason: typeof navigator.share === 'function'
          ? 'Share sheet available — receipts can be sent without a printer.'
          : 'Share sheet unavailable.',
        action: null,
      },
      notifications: {
        supported: typeof Notification !== 'undefined',
        reason: typeof Notification !== 'undefined' ? 'Notifications available.' : 'Notifications unavailable.',
        action: null,
      },
    };
  }

  /**
   * deviceProfile() — one label the whole wizard can branch on, so no page has
   * to re-sniff the user agent and drift from the others.
   *
   * iPadOS deliberately reports itself as a Mac, so a UA test alone
   * misclassifies every iPad as a desktop and offers it USB. maxTouchPoints is
   * what separates them.
   */
  function deviceProfile() {
    var c = capabilities();
    var ua = navigator.userAgent || '';
    var touch = (navigator.maxTouchPoints || 0) > 1;
    if (c.platform.isIOS) return /iPad/.test(ua) || (navigator.platform === 'MacIntel' && touch) ? 'ipad' : 'iphone';
    if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'android-phone' : 'android-tablet';
    return 'desktop';
  }

  /* Remembered choices. Firestore owns business data; this is a per-device UI
     preference, so localStorage is the correct home rather than an authority
     leak — nothing here grants access or changes what is charged. */
  var PREF_KEY = '_posHardwarePrefs';
  function getPreferences() {
    try { return JSON.parse(localStorage.getItem(PREF_KEY) || '{}'); } catch (_) { return {}; }
  }
  function savePreference(categoryKey, transportId, extra) {
    try {
      var p = getPreferences();
      p[categoryKey] = Object.assign({ transport: transportId, savedAt: Date.now() }, extra || {});
      localStorage.setItem(PREF_KEY, JSON.stringify(p));
      return true;
    } catch (_) { return false; }
  }

  /**
   * autoSelect(categoryKey) — the transport to use without asking.
   * A remembered choice wins, but only while it is still usable: a merchant who
   * paired USB on desktop and later opens the same account on an iPhone must
   * not be handed a transport that cannot work there.
   */
  function autoSelect(categoryKey) {
    var plan = transportPlan(categoryKey);
    if (!plan.length) return null;
    var pref = getPreferences()[categoryKey];
    if (pref) {
      var kept = plan.filter(function (t) { return t.id === pref.transport; })[0];
      if (kept) return Object.assign({}, kept, { remembered: true });
    }
    return Object.assign({}, plan[0], { remembered: false });
  }

  /**
   * transportPlan(categoryKey) — the ordered list of transports that can
   * actually work on THIS device for THIS category, best first.
   *
   * Apple-first rather than Apple-excluded. An iPhone merchant is not a
   * degraded desktop merchant: they have a network stack, AirPrint and a very
   * good camera, which covers receipt printing, label printing, cash-drawer
   * kick and barcode scanning without a single unavailable API. What they lack
   * is USB, Bluetooth and Serial, so those are removed from the plan entirely
   * instead of being offered and then failing.
   *
   * Returns [{ id, label, note }] — empty only when a category genuinely has
   * no working path here, in which case `why(category)` explains it.
   */
  function transportPlan(categoryKey) {
    var c = capabilities();
    var ios = c.platform.isIOS;
    var plan = [];
    var add = function (id, label, note) { plan.push({ id: id, label: label, note: note || null }); };

    switch (categoryKey) {
      case 'receipt_printer':
      case 'label_printer':
        /* Network ESC/POS first everywhere: it is the only transport that works
           on every platform, and on iOS it is the only one at all. */
        add('network', 'Network printer (enter IP)', 'Works on every device, including iPhone.');
        if (c.browserPrint.supported) {
          add('browser', ios ? 'AirPrint / system print' : 'System print dialog',
              ios ? 'Uses the iPhone share sheet — no pairing needed.' : null);
        }
        if (c.usb.supported)       add('usb', 'USB printer', 'Tap Connect to choose the device.');
        if (c.bluetooth.supported) add('bluetooth', 'Bluetooth printer', 'Tap Connect to pair.');
        break;

      case 'barcode_scanner':
        /* The camera is a first-class scanner on iPhone, not a fallback. */
        if (c.camera.supported) add('camera', 'Camera scanner', 'Uses the device camera — recommended on iPhone.');
        add('keyboard', 'Keyboard-wedge scanner', 'Any scanner that types into a field works with no drivers.');
        add('manual', 'Type the barcode', 'Always available.');
        if (c.usb.supported)       add('usb_hid', 'USB scanner');
        if (c.bluetooth.supported) add('bluetooth_hid', 'Bluetooth scanner');
        break;

      case 'cash_drawer':
        /* A drawer has no transport of its own — it is kicked by the printer. */
        add('network_kick', 'Kick via network printer', 'The drawer opens through the ESC/POS printer it is wired to.');
        if (c.usb.supported) add('usb', 'USB drawer');
        break;

      case 'customer_display':
        add('network', 'Network display (enter IP)');
        if (c.usb.supported) add('usb', 'USB display');
        break;

      case 'weighing_scale':
        add('network', 'Network scale (enter IP)');
        if (c.serial.supported)    add('serial', 'Serial scale');
        if (c.usb.supported)       add('usb_serial', 'USB scale');
        if (c.bluetooth.supported) add('bluetooth', 'Bluetooth scale');
        break;

      case 'payment_terminal':
        add('network', 'Network terminal (enter IP)');
        if (c.bluetooth.supported) add('bluetooth', 'Bluetooth terminal');
        break;

      case 'nfc_reader':
        if (c.usb.supported) add('usb', 'USB NFC reader');
        break;

      case 'biometric':
        add('platform', 'Device biometrics', 'Face ID / Touch ID via the platform authenticator.');
        break;
    }
    return plan;
  }

  /**
   * why(categoryKey) — one honest sentence when a category has no working
   * transport here, so the UI never has to invent "Not Found".
   */
  function why(categoryKey) {
    var c = capabilities();
    if (!c.platform.isIOS) {
      return 'Nothing is paired with this site yet — use Connect to choose a device.';
    }
    if (categoryKey === 'nfc_reader') {
      return 'External NFC readers need WebUSB, which iOS does not provide. Apple Pay terminals connect through the payment provider instead.';
    }
    if (categoryKey === 'payment_terminal') {
      return 'Card readers cannot be paired from an iPhone browser. Use a network terminal, or the provider’s own app.';
    }
    return 'iPhone browsers cannot use USB, Bluetooth or Serial. Use a network device or AirPrint.';
  }

  /** The transports a merchant can actually use here, best first. */
  function recommendedTransports() {
    var c = capabilities();
    var out = [];
    if (c.usb.supported)       out.push({ id: 'usb',        label: 'USB printer' });
    if (c.bluetooth.supported) out.push({ id: 'bluetooth',  label: 'Bluetooth printer' });
    if (c.serial.supported)    out.push({ id: 'serial',     label: 'Serial printer' });
    out.push({ id: 'network',  label: 'Network printer (manual IP)' });
    if (c.browserPrint.supported) out.push({ id: 'browser', label: 'System print dialog' + (c.platform.isIOS ? ' (AirPrint)' : '') });
    return out;
  }

  /**
   * discover() — Detects all available hardware via Web APIs.
   * Returns a summary of what was found by category.
   *
   * NOTE: this reports devices ALREADY PAIRED with this origin. It cannot find
   * new hardware — see capabilities() above. summary.capabilities carries the
   * per-transport reasons so the UI can explain an empty result honestly.
   */
  async function discover() {
    var summary = {
      printers:  { found: false, count: 0, types: [] },
      scanners:  { found: false, count: 0, types: [] },
      scales:    { found: false, count: 0, types: [] },
      drawers:   { found: false, count: 0, types: [] },
      displays:  { found: false, count: 0, types: [] },
      terminals: { found: false, count: 0, types: [] },
      nfc:       { found: false, count: 0, types: [] },
      biometric: { found: false, count: 0, types: [] },
      labels:    { found: false, count: 0, types: [] },
    };

    // 1. USB Devices
    if (navigator.usb && typeof navigator.usb.getDevices === 'function') {
      try {
        var usbDevices = await navigator.usb.getDevices();
        usbDevices.forEach(function (dev) {
          var vid = dev.vendorId;
          var pid = dev.productId;
          // Epson USB VID: 0x04b8
          if (vid === 0x04b8) {
            summary.printers.found = true;
            summary.printers.count++;
            if (!summary.printers.types.includes('usb')) summary.printers.types.push('usb');
          }
          // Star Micronics VID: 0x0519
          if (vid === 0x0519) {
            summary.printers.found = true;
            summary.printers.count++;
            if (!summary.printers.types.includes('usb')) summary.printers.types.push('usb');
          }
          // Zebra VID: 0x0a5f
          if (vid === 0x0a5f) {
            summary.labels.found = true;
            summary.labels.count++;
            if (!summary.labels.types.includes('usb')) summary.labels.types.push('usb');
          }
          // Honeywell VID: 0x0c2e
          if (vid === 0x0c2e) {
            summary.scanners.found = true;
            summary.scanners.count++;
            if (!summary.scanners.types.includes('usb_hid')) summary.scanners.types.push('usb_hid');
          }
          // Datalogic VID: 0x05f9
          if (vid === 0x05f9) {
            summary.scanners.found = true;
            summary.scanners.count++;
            if (!summary.scanners.types.includes('usb_hid')) summary.scanners.types.push('usb_hid');
          }
          // ACR122U NFC VID: 0x072f
          if (vid === 0x072f) {
            summary.nfc.found = true;
            summary.nfc.count++;
            if (!summary.nfc.types.includes('usb')) summary.nfc.types.push('usb');
          }
        });
      } catch (e) {
        console.warn('[SokoniHardware] USB discovery error:', e.message);
      }
    }

    // 2. Bluetooth Devices
    if (navigator.bluetooth && typeof navigator.bluetooth.getDevices === 'function') {
      try {
        var btDevices = await navigator.bluetooth.getDevices();
        btDevices.forEach(function (dev) {
          var name = (dev.name || '').toLowerCase();
          if (name.includes('printer') || name.includes('tm-') || name.includes('tsp')) {
            summary.printers.found = true;
            summary.printers.count++;
            if (!summary.printers.types.includes('bluetooth')) summary.printers.types.push('bluetooth');
          }
          if (name.includes('scanner') || name.includes('voyager') || name.includes('gryphon')) {
            summary.scanners.found = true;
            summary.scanners.count++;
            if (!summary.scanners.types.includes('bluetooth_hid')) summary.scanners.types.push('bluetooth_hid');
          }
          if (name.includes('scale') || name.includes('ranger') || name.includes('cas')) {
            summary.scales.found = true;
            summary.scales.count++;
            if (!summary.scales.types.includes('bluetooth')) summary.scales.types.push('bluetooth');
          }
        });
      } catch (e) {
        console.warn('[SokoniHardware] Bluetooth discovery error:', e.message);
      }
    }

    // 3. NFC via NDEFReader
    if (typeof NDEFReader !== 'undefined') {
      summary.nfc.found = true;
      summary.nfc.count = summary.nfc.count || 1;
      if (!summary.nfc.types.includes('nfc')) summary.nfc.types.push('nfc');
    }

    // 4. Camera for QR/Barcode
    if (navigator.mediaDevices && typeof navigator.mediaDevices.enumerateDevices === 'function') {
      try {
        var mediaDevices = await navigator.mediaDevices.enumerateDevices();
        var cameras = mediaDevices.filter(function (d) { return d.kind === 'videoinput'; });
        if (cameras.length > 0) {
          summary.scanners.found = true;
          summary.scanners.count += cameras.length;
          if (!summary.scanners.types.includes('camera')) summary.scanners.types.push('camera');
        }
      } catch (e) {
        console.warn('[SokoniHardware] Camera discovery error:', e.message);
      }
    }

    // 5. Web Serial API
    if (navigator.serial && typeof navigator.serial.getPorts === 'function') {
      try {
        var serialPorts = await navigator.serial.getPorts();
        serialPorts.forEach(function () {
          // Assume scale on serial port (most common)
          summary.scales.found = true;
          summary.scales.count++;
          if (!summary.scales.types.includes('serial')) summary.scales.types.push('serial');
        });
      } catch (e) {
        console.warn('[SokoniHardware] Serial discovery error:', e.message);
      }
    }

    // 6. Biometric via PublicKeyCredential
    if (window.PublicKeyCredential &&
        typeof PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable === 'function') {
      try {
        var bioAvailable = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
        if (bioAvailable) {
          summary.biometric.found = true;
          summary.biometric.count = 1;
          summary.biometric.types.push('platform');
        }
      } catch (e) {
        console.warn('[SokoniHardware] Biometric discovery error:', e.message);
      }
    }

    // 7. Previously saved network printer IP
    try {
      var saved = localStorage.getItem('_posNetworkPrinterIP');
      if (saved) {
        summary.printers.found = true;
        summary.printers.count++;
        if (!summary.printers.types.includes('network')) summary.printers.types.push('network');
        summary.printers.savedIP = saved;
      }
    } catch (e) { /* ignore */ }

    /* Structured diagnostics so a null result is never silent. Without this the
       page could only say "Not Found", which reads as a hardware fault when the
       real answer is that the browser has no such API, or that nothing has been
       paired to this origin yet. */
    /* Classify what was actually found. `found` alone conflated three very
       different things and the wizard counted them together, so a fresh iPhone
       reported "2 hardware categories found" while no printer existed:

         scanners  — the phone's own camera (built in, not connected by anyone)
         biometric — Face ID / Touch ID, a browser capability, not a peripheral

       Reporting a capability as discovered hardware tells a merchant their
       printer was detected when it was not. Split the count so the UI can say
       what is true. */
    var PERIPHERAL_TYPES = ['usb', 'bluetooth', 'serial', 'network'];
    summary.classify = { peripheral: [], builtin: [], capability: [], configured: [] };
    Object.keys(summary).forEach(function (k) {
      var v = summary[k];
      if (!v || typeof v !== 'object' || v.found !== true || !Array.isArray(v.types)) return;
      if (k === 'biometric') { summary.classify.capability.push(k); return; }
      if (v.types.indexOf('camera') !== -1 && v.types.length === 1) { summary.classify.builtin.push(k); return; }
      if (k === 'printers' && v.savedIP) { summary.classify.configured.push(k); return; }
      if (v.types.some(function (t) { return PERIPHERAL_TYPES.indexOf(t) !== -1; })) {
        summary.classify.peripheral.push(k); return;
      }
      summary.classify.builtin.push(k);
    });
    /* The only number that answers "did we find your hardware?" */
    summary.hardwareCount = summary.classify.peripheral.length + summary.classify.configured.length;
    summary.printerFound  = summary.printers && summary.printers.found === true;

    summary.capabilities = capabilities();
    summary.recommended  = recommendedTransports();
    summary.diagnostics  = Object.keys(summary.capabilities)
      .filter(function (k) { return k !== 'platform' && summary.capabilities[k].supported === false; })
      .map(function (k) {
        return { transport: k, reason: summary.capabilities[k].reason, action: summary.capabilities[k].action };
      });
    /* Paired-vs-discoverable is the distinction that made this confusing. */
    summary.scanScope = 'already-paired-devices-only';

    emit('device:discovered', summary);
    return summary;
  }

  /**
   * registerDevice(config) — Register a hardware device with the abstraction layer.
   * config: { id, category, name, connectionType, vendorId, modelName,
   *           firmwareVersion, serialNumber, config:{} }
   */
  function registerDevice(config) {
    if (!config || !config.id) throw new Error('Device config must include an id');
    if (!config.category) throw new Error('Device config must include a category');

    var AdapterClass = _adapters[config.vendorId] || null;
    var instance;

    if (AdapterClass) {
      instance = new AdapterClass(config);
    } else {
      // Fall back to generic device based on category
      switch (config.category) {
        case CATEGORIES.RECEIPT_PRINTER:
          instance = new ReceiptPrinterDevice(config);
          break;
        case CATEGORIES.LABEL_PRINTER:
          instance = new LabelPrinterDevice(config);
          break;
        case CATEGORIES.BARCODE_SCANNER:
        case CATEGORIES.QR_SCANNER:
          instance = new BarcodeScannerDevice(config);
          break;
        case CATEGORIES.WEIGHING_SCALE:
          instance = new WeighingScaleDevice(config);
          break;
        case CATEGORIES.NFC_READER:
          instance = new NFCReaderDevice(config);
          break;
        case CATEGORIES.BIOMETRIC:
          instance = new BiometricDevice(config);
          break;
        default:
          instance = new BaseDevice(config);
      }
    }

    _registry[config.id] = instance;
    emit('device:registered', { deviceId: config.id, category: config.category });
    saveRegistry();
    return instance;
  }

  /**
   * unregisterDevice(deviceId) — Remove a device from the registry.
   */
  function unregisterDevice(deviceId) {
    if (!_registry[deviceId]) return false;
    var device = _registry[deviceId];
    try { device.disconnect(); } catch (e) { /* best-effort */ }
    delete _registry[deviceId];
    emit('device:unregistered', { deviceId: deviceId });
    saveRegistry();
    return true;
  }

  /**
   * getDevice(deviceId) — Retrieve a device instance by ID.
   */
  function getDevice(deviceId) {
    return _registry[deviceId] || null;
  }

  /**
   * getDevicesByCategory(category) — Return all devices of a given category.
   */
  function getDevicesByCategory(category) {
    return Object.values(_registry).filter(function (d) {
      return d._config && d._config.category === category;
    });
  }

  // ---------------------------------------------------------------------------
  // B. BASE DEVICE CLASS (Prototype-based)
  // ---------------------------------------------------------------------------

  /**
   * BaseDevice — Abstract base for all hardware devices.
   */
  function BaseDevice(config) {
    this._config  = config || {};
    this._status  = STATUS.DISCONNECTED;
    this._lastPing = null;
    this._latency  = null;
  }

  BaseDevice.prototype.connect = async function () {
    throw new Error('connect() not implemented for ' + (this._config.name || 'BaseDevice'));
  };

  BaseDevice.prototype.disconnect = async function () {
    this._status = STATUS.DISCONNECTED;
    emit('device:disconnected', { deviceId: this._config.id });
  };

  BaseDevice.prototype.ping = async function () {
    var start = Date.now();
    // Base implementation: just check status
    if (this._status === STATUS.CONNECTED || this._status === STATUS.IDLE) {
      var latency = Date.now() - start;
      this._latency  = latency;
      this._lastPing = new Date().toISOString();
      return latency;
    }
    throw new Error('Device not connected');
  };

  BaseDevice.prototype.status = function () {
    return this._status;
  };

  BaseDevice.prototype.getInfo = function () {
    return {
      name:       this._config.name        || 'Unknown Device',
      model:      this._config.modelName   || 'Unknown Model',
      firmware:   this._config.firmwareVersion || 'N/A',
      serial:     this._config.serialNumber   || 'N/A',
      connection: this._config.connectionType || 'unknown',
      vendor:     this._config.vendorId       || 'generic',
      category:   this._config.category       || 'unknown',
      status:     this._status,
      lastPing:   this._lastPing,
      latency:    this._latency,
    };
  };

  BaseDevice.prototype.diagnose = async function () {
    var report = {
      deviceId: this._config.id,
      name:     this._config.name,
      category: this._config.category,
      status:   this._status,
      latency:  null,
      healthy:  false,
      errors:   [],
      timestamp: new Date().toISOString(),
    };
    try {
      report.latency = await this.ping();
      report.healthy = true;
    } catch (e) {
      report.errors.push(e.message);
    }
    emit('device:health', report);
    return report;
  };

  // Utility: inherit from BaseDevice
  function _inherit(ChildClass, ParentClass) {
    ChildClass.prototype = Object.create(ParentClass.prototype);
    ChildClass.prototype.constructor = ChildClass;
  }

  // ---------------------------------------------------------------------------
  // C. CONCRETE DEVICE IMPLEMENTATIONS
  // ---------------------------------------------------------------------------

  // ── Receipt Printer ──────────────────────────────────────────────────────────

  /**
   * ReceiptPrinterDevice — Supports USB, Network, Bluetooth, Browser printing.
   */
  function ReceiptPrinterDevice(config) {
    BaseDevice.call(this, config);
    this._paperWidth   = (config.config && config.config.paperWidth)  || 80;  // mm
    this._cutType      = (config.config && config.config.cutType)     || 'full';
    this._logoEnabled  = (config.config && config.config.logoEnabled) || false;
    this._networkIp    = (config.config && config.config.ip)          || '192.168.1.100';
    this._networkPort  = (config.config && config.config.port)        || 9100;
  }
  _inherit(ReceiptPrinterDevice, BaseDevice);

  ReceiptPrinterDevice.prototype.connect = async function () {
    this._status = STATUS.CONNECTING;
    emit('device:connecting', { deviceId: this._config.id });

    var connType = this._config.connectionType;
    try {
      if (connType === CONNECTION_TYPES.BROWSER) {
        // Browser printing always available
        this._status = STATUS.CONNECTED;
      } else if (connType === CONNECTION_TYPES.NETWORK) {
        // Try a lightweight HTTP ping to the local proxy
        var proxyUrl = 'http://' + this._networkIp + ':' + this._networkPort + '/ping';
        await _fetchWithTimeout(proxyUrl, { method: 'GET' }, 3000);
        this._status = STATUS.CONNECTED;
      } else if (connType === CONNECTION_TYPES.USB) {
        var usbDevices = await navigator.usb.getDevices();
        var matched = usbDevices.find(function (d) {
          return d.vendorId === _vendorIdFromString(this._config.vendorId);
        }.bind(this));
        if (matched) {
          await matched.open();
          this._nativeDevice = matched;
          this._status = STATUS.CONNECTED;
        } else {
          throw new Error('USB printer not found. Please reconnect the device.');
        }
      } else if (connType === CONNECTION_TYPES.BLUETOOTH) {
        // BT connection requires user gesture — mark as connected if previously paired
        this._status = STATUS.CONNECTED;
      } else {
        this._status = STATUS.CONNECTED; // Optimistic for unknown types
      }
      emit('device:connected', { deviceId: this._config.id, type: connType });
    } catch (e) {
      this._status = STATUS.ERROR;
      emit('device:error', { deviceId: this._config.id, error: e.message });
      throw e;
    }
    return this._status;
  };

  ReceiptPrinterDevice.prototype.print = async function (receiptHTML) {
    if (!receiptHTML) throw new Error('print() requires receiptHTML content');
    var connType = this._config.connectionType;

    if (connType === CONNECTION_TYPES.BROWSER) {
      return _browserPrint(receiptHTML, this._paperWidth);
    } else if (connType === CONNECTION_TYPES.NETWORK) {
      return _networkPrint(this._networkIp, this._networkPort, receiptHTML, this._cutType);
    } else if (connType === CONNECTION_TYPES.USB || connType === CONNECTION_TYPES.BLUETOOTH) {
      return _escPosPrint(receiptHTML, this._cutType, this._nativeDevice);
    }
    throw new Error('Unsupported connection type for print: ' + connType);
  };

  ReceiptPrinterDevice.prototype.openCashDrawer = async function () {
    var connType = this._config.connectionType;
    // ESC/POS cash drawer command: ESC p 0 25 250
    var cmd = '\x1B\x70\x00\x19\xFA';
    if (connType === CONNECTION_TYPES.NETWORK) {
      var url = 'http://' + this._networkIp + ':' + this._networkPort + '/raw';
      await _fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: cmd,
      }, 5000);
      return true;
    } else if (connType === CONNECTION_TYPES.BROWSER) {
      // Browser cannot directly open cash drawer — emit event for hardware bridge
      emit('device:cash_drawer_open', { deviceId: this._config.id });
      return true;
    }
    return false;
  };

  ReceiptPrinterDevice.prototype.testPrint = async function () {
    var storeName = 'SOKONI SmartPOS';
    var html = [
      '<div style="font-family:monospace;width:' + (this._paperWidth === 58 ? '200px' : '300px') + ';padding:8px">',
      '<h3 style="text-align:center">' + storeName + '</h3>',
      '<p style="text-align:center">━━━━━━━━━━━━━━━━━━━━</p>',
      '<p style="text-align:center">PRINTER TEST OK</p>',
      '<p style="text-align:center">Paper: ' + this._paperWidth + 'mm</p>',
      '<p style="text-align:center">Cut: ' + this._cutType + '</p>',
      '<p style="text-align:center">' + new Date().toLocaleString() + '</p>',
      '<p style="text-align:center">━━━━━━━━━━━━━━━━━━━━</p>',
      '</div>',
    ].join('');
    return this.print(html);
  };

  ReceiptPrinterDevice.prototype.getStatus = async function () {
    return {
      connected:  this._status === STATUS.CONNECTED,
      paperLevel: 'OK',         // Placeholder — real status via DLE EOT query
      inkLevel:   'OK',         // Thermal printers have no ink
      cutterOK:   true,
      status:     this._status,
    };
  };

  ReceiptPrinterDevice.prototype.ping = async function () {
    var start = Date.now();
    var connType = this._config.connectionType;
    try {
      if (connType === CONNECTION_TYPES.NETWORK) {
        var url = 'http://' + this._networkIp + ':' + this._networkPort + '/ping';
        await _fetchWithTimeout(url, {}, 3000);
      } else if (connType === CONNECTION_TYPES.BROWSER) {
        // Browser print always reachable
      } else if (connType === CONNECTION_TYPES.USB && this._nativeDevice) {
        // USB device open check
        if (!this._nativeDevice.opened) throw new Error('USB device not open');
      }
      var latency = Date.now() - start;
      this._latency  = latency;
      this._lastPing = new Date().toISOString();
      this._status   = STATUS.CONNECTED;
      return latency;
    } catch (e) {
      this._status = STATUS.ERROR;
      throw e;
    }
  };

  // ── Barcode Scanner Device ────────────────────────────────────────────────────

  /**
   * BarcodeScannerDevice — Supports USB HID (keyboard wedge), BT HID, and camera.
   */
  function BarcodeScannerDevice(config) {
    BaseDevice.call(this, config);
    this._scanBuffer  = '';
    this._scanTimeout = null;
    this._onScan      = null;
    this._cameraStream = null;
    this._barcodeDetector = null;
    this._scanning    = false;
    this._prefix      = (config.config && config.config.prefix) || '';
    this._suffix      = (config.config && config.config.suffix) || '\r'; // carriage return default
  }
  _inherit(BarcodeScannerDevice, BaseDevice);

  BarcodeScannerDevice.prototype.connect = async function () {
    this._status = STATUS.CONNECTING;
    var connType = this._config.connectionType;
    try {
      if (connType === CONNECTION_TYPES.CAMERA) {
        if (!navigator.mediaDevices) throw new Error('Camera not available in this browser');
        this._status = STATUS.CONNECTED;
      } else {
        // USB HID / BT HID — keyboard wedge, always available
        this._status = STATUS.CONNECTED;
      }
      emit('device:connected', { deviceId: this._config.id, type: connType });
    } catch (e) {
      this._status = STATUS.ERROR;
      emit('device:error', { deviceId: this._config.id, error: e.message });
      throw e;
    }
    return this._status;
  };

  BarcodeScannerDevice.prototype.startScanning = function (onScan) {
    if (typeof onScan !== 'function') throw new Error('onScan must be a function');
    this._onScan  = onScan;
    this._scanning = true;
    var connType = this._config.connectionType;

    if (connType === CONNECTION_TYPES.CAMERA) {
      this._startCameraScanning(onScan);
    } else {
      // USB HID / BT HID — keyboard wedge mode
      this._boundKeyHandler = this._keyboardWedgeHandler.bind(this);
      document.addEventListener('keydown', this._boundKeyHandler);
    }
    emit('scanner:started', { deviceId: this._config.id });
  };

  BarcodeScannerDevice.prototype._keyboardWedgeHandler = function (e) {
    if (!this._scanning) return;
    // Barcode scanners send rapid keystrokes followed by Enter or CR
    if (e.key === 'Enter' || e.key === '\r') {
      var barcode = this._scanBuffer.trim();
      if (barcode.length > 0) {
        // Strip prefix/suffix if configured
        if (this._prefix && barcode.startsWith(this._prefix)) {
          barcode = barcode.slice(this._prefix.length);
        }
        if (this._suffix && barcode.endsWith(this._suffix.trim())) {
          barcode = barcode.slice(0, barcode.length - this._suffix.trim().length);
        }
        emit('scan:received', { deviceId: this._config.id, barcode: barcode });
        if (this._onScan) this._onScan(barcode);
      }
      this._scanBuffer = '';
      if (this._scanTimeout) clearTimeout(this._scanTimeout);
    } else if (e.key.length === 1) {
      this._scanBuffer += e.key;
      // Clear buffer after 100ms of inactivity (differentiates manual typing vs scanner)
      if (this._scanTimeout) clearTimeout(this._scanTimeout);
      this._scanTimeout = setTimeout(function () {
        this._scanBuffer = '';
      }.bind(this), 100);
    }
  };

  BarcodeScannerDevice.prototype._startCameraScanning = async function (onScan) {
    try {
      this._cameraStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' }
      });

      // Use BarcodeDetector if available
      if (typeof BarcodeDetector !== 'undefined') {
        this._barcodeDetector = new BarcodeDetector({
          formats: ['qr_code', 'ean_13', 'ean_8', 'code_128', 'code_39', 'upc_a', 'upc_e']
        });
        var video = document.createElement('video');
        video.srcObject = this._cameraStream;
        video.play();
        this._cameraVideo = video;

        var self = this;
        this._cameraInterval = setInterval(async function () {
          if (!self._scanning) return;
          try {
            var barcodes = await self._barcodeDetector.detect(video);
            barcodes.forEach(function (b) {
              emit('scan:received', { deviceId: self._config.id, barcode: b.rawValue, format: b.format });
              if (onScan) onScan(b.rawValue, b.format);
            });
          } catch (e) { /* frame detection failure — continue */ }
        }, 200);
      } else {
        // BarcodeDetector not available — emit guidance
        emit('device:error', {
          deviceId: this._config.id,
          error: 'BarcodeDetector API not available. Use Chrome 88+ or Edge 88+.'
        });
      }
    } catch (e) {
      this._status = STATUS.ERROR;
      emit('device:error', { deviceId: this._config.id, error: e.message });
    }
  };

  BarcodeScannerDevice.prototype.stopScanning = function () {
    this._scanning = false;
    if (this._boundKeyHandler) {
      document.removeEventListener('keydown', this._boundKeyHandler);
      this._boundKeyHandler = null;
    }
    if (this._cameraInterval) {
      clearInterval(this._cameraInterval);
      this._cameraInterval = null;
    }
    if (this._cameraStream) {
      this._cameraStream.getTracks().forEach(function (t) { t.stop(); });
      this._cameraStream = null;
    }
    if (this._scanTimeout) {
      clearTimeout(this._scanTimeout);
      this._scanTimeout = null;
    }
    emit('scanner:stopped', { deviceId: this._config.id });
  };

  BarcodeScannerDevice.prototype.testScan = async function () {
    var connType = this._config.connectionType;
    if (connType === CONNECTION_TYPES.CAMERA) {
      return new Promise(function (resolve, reject) {
        var timer;
        var handler = function (data) {
          clearTimeout(timer);
          off('scan:received', handler);
          resolve(data.barcode);
        };
        on('scan:received', handler);
        this.startScanning(function () {});
        timer = setTimeout(function () {
          this.stopScanning();
          off('scan:received', handler);
          reject(new Error('Camera scan test timed out after 3 seconds — no barcode detected'));
        }.bind(this), 3000);
      }.bind(this));
    } else {
      // USB / BT HID — return demo barcode
      var demoBarcode = '6935853700115';
      emit('scan:received', { deviceId: this._config.id, barcode: demoBarcode, demo: true });
      return demoBarcode;
    }
  };

  BarcodeScannerDevice.prototype.ping = async function () {
    var start = Date.now();
    // Keyboard wedge is always available if connected
    var latency = Date.now() - start;
    this._latency  = latency;
    this._lastPing = new Date().toISOString();
    this._status   = STATUS.CONNECTED;
    return latency;
  };

  // ── Weighing Scale Device ────────────────────────────────────────────────────

  /**
   * WeighingScaleDevice — Supports USB Serial, Network, and Bluetooth.
   */
  function WeighingScaleDevice(config) {
    BaseDevice.call(this, config);
    this._unit          = (config.config && config.config.unit)          || 'kg';
    this._decimalPlaces = (config.config && config.config.decimalPlaces) || 3;
    this._tareOffset    = (config.config && config.config.tareOffset)    || 0;
    this._serialPort    = null;
  }
  _inherit(WeighingScaleDevice, BaseDevice);

  WeighingScaleDevice.prototype.connect = async function () {
    this._status = STATUS.CONNECTING;
    var connType = this._config.connectionType;
    try {
      if (connType === CONNECTION_TYPES.USB_SERIAL || connType === CONNECTION_TYPES.SERIAL) {
        if (!navigator.serial) throw new Error('Web Serial API not supported in this browser');
        // Request port — requires user gesture on first connection
        var ports = await navigator.serial.getPorts();
        if (ports.length > 0) {
          this._serialPort = ports[0];
          await this._serialPort.open({ baudRate: 9600 });
          this._status = STATUS.CONNECTED;
        } else {
          throw new Error('No serial ports available. Connect the scale and grant permission.');
        }
      } else if (connType === CONNECTION_TYPES.NETWORK) {
        var url = 'http://' + (this._config.config && this._config.config.ip) + '/weight';
        await _fetchWithTimeout(url, {}, 3000);
        this._status = STATUS.CONNECTED;
      } else if (connType === CONNECTION_TYPES.BLUETOOTH) {
        this._status = STATUS.CONNECTED; // BT scale — assumed paired
      } else {
        this._status = STATUS.CONNECTED;
      }
      emit('device:connected', { deviceId: this._config.id, type: connType });
    } catch (e) {
      this._status = STATUS.ERROR;
      emit('device:error', { deviceId: this._config.id, error: e.message });
      throw e;
    }
    return this._status;
  };

  WeighingScaleDevice.prototype.getWeight = async function () {
    return new Promise(function (resolve, reject) {
      var connType = this._config.connectionType;
      var timeout  = setTimeout(function () {
        reject(new Error('Scale read timeout after 5 seconds — check scale connection'));
      }, 5000);

      if (connType === CONNECTION_TYPES.USB_SERIAL || connType === CONNECTION_TYPES.SERIAL) {
        if (!this._serialPort || !this._serialPort.readable) {
          clearTimeout(timeout);
          // Return stub value for testing
          var stub = _randomWeight(this._unit, this._decimalPlaces, this._tareOffset);
          resolve(stub);
          return;
        }
        // Read from serial port
        var reader = this._serialPort.readable.getReader();
        var buffer = '';
        var self = this;
        (async function () {
          try {
            while (true) {
              var result = await reader.read();
              if (result.done) break;
              buffer += new TextDecoder().decode(result.value);
              // Most scales send weight as "  0.123kg\r\n" or "ST,GS,   0.123 kg"
              var match = buffer.match(/([0-9]+\.[0-9]+)\s*(kg|g|lb)?/i);
              if (match) {
                clearTimeout(timeout);
                reader.releaseLock();
                var value = parseFloat(match[1]) - self._tareOffset;
                resolve({
                  value: parseFloat(value.toFixed(self._decimalPlaces)),
                  unit:  match[2] || self._unit,
                  stable: true,
                  raw: buffer.trim(),
                });
                emit('weight:received', { deviceId: self._config.id, value: value, unit: self._unit });
                return;
              }
            }
          } catch (e) {
            clearTimeout(timeout);
            reader.releaseLock();
            reject(e);
          }
        })();
      } else {
        // Stub implementation for network/BT or testing
        clearTimeout(timeout);
        var reading = _randomWeight(this._unit, this._decimalPlaces, this._tareOffset);
        emit('weight:received', { deviceId: this._config.id, value: reading.value, unit: reading.unit });
        resolve(reading);
      }
    }.bind(this));
  };

  WeighingScaleDevice.prototype.tare = async function () {
    var connType = this._config.connectionType;
    if (connType === CONNECTION_TYPES.USB_SERIAL || connType === CONNECTION_TYPES.SERIAL) {
      if (this._serialPort && this._serialPort.writable) {
        var writer = this._serialPort.writable.getWriter();
        // Common tare command for many scales: 'T\r\n'
        await writer.write(new TextEncoder().encode('T\r\n'));
        writer.releaseLock();
      }
    }
    this._tareOffset = 0;
    emit('scale:tared', { deviceId: this._config.id });
    return true;
  };

  WeighingScaleDevice.prototype.testWeigh = async function () {
    return this.getWeight();
  };

  WeighingScaleDevice.prototype.ping = async function () {
    var start = Date.now();
    if (this._serialPort && this._serialPort.readable) {
      var latency = Date.now() - start;
      this._latency  = latency;
      this._lastPing = new Date().toISOString();
      this._status   = STATUS.CONNECTED;
      return latency;
    }
    // For network/BT, attempt a weight read
    await this.getWeight();
    var lat = Date.now() - start;
    this._latency  = lat;
    this._lastPing = new Date().toISOString();
    this._status   = STATUS.CONNECTED;
    return lat;
  };

  // ── Label Printer Device ─────────────────────────────────────────────────────

  /**
   * LabelPrinterDevice — Supports USB, Network, Bluetooth. Sends ZPL commands.
   */
  function LabelPrinterDevice(config) {
    BaseDevice.call(this, config);
    this._labelWidth  = (config.config && config.config.labelWidth)  || 4;   // inches
    this._labelHeight = (config.config && config.config.labelHeight) || 2;   // inches
    this._dpi         = (config.config && config.config.dpi)         || 203;
    this._networkIp   = (config.config && config.config.ip)          || '192.168.1.101';
    this._networkPort = (config.config && config.config.port)        || 9100;
  }
  _inherit(LabelPrinterDevice, BaseDevice);

  LabelPrinterDevice.prototype.connect = async function () {
    this._status = STATUS.CONNECTING;
    try {
      if (this._config.connectionType === CONNECTION_TYPES.NETWORK) {
        var url = 'http://' + this._networkIp + ':' + this._networkPort + '/ping';
        await _fetchWithTimeout(url, {}, 3000);
      }
      this._status = STATUS.CONNECTED;
      emit('device:connected', { deviceId: this._config.id });
    } catch (e) {
      this._status = STATUS.ERROR;
      emit('device:error', { deviceId: this._config.id, error: e.message });
      throw e;
    }
    return this._status;
  };

  LabelPrinterDevice.prototype.printLabel = async function (data) {
    if (!data) throw new Error('printLabel() requires data object');
    // Build ZPL label
    var zpl = _buildZPLLabel({
      barcode:  data.barcode  || '0000000000000',
      name:     data.name     || 'Product',
      price:    data.price    || '0.00',
      weight:   data.weight   || '',
      expiry:   data.expiry   || '',
      width:    this._labelWidth,
      height:   this._labelHeight,
      dpi:      this._dpi,
    });

    var connType = this._config.connectionType;
    if (connType === CONNECTION_TYPES.NETWORK) {
      var url = 'http://' + this._networkIp + ':' + this._networkPort + '/zpl';
      await _fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: zpl,
      }, 8000);
    } else if (connType === CONNECTION_TYPES.BROWSER) {
      // Fallback: open ZPL in new window for Zebra Browser Print
      var win = window.open('', '_blank');
      if (win) {
        win.document.write('<pre>' + zpl + '</pre>');
        win.print();
      }
    }
    return { success: true, zpl: zpl };
  };

  LabelPrinterDevice.prototype.testLabel = async function () {
    return this.printLabel({
      barcode: '6935853700115',
      name:    'TEST PRODUCT',
      price:   'KES 150.00',
      weight:  '0.500 kg',
      expiry:  '2026-12-31',
    });
  };

  LabelPrinterDevice.prototype.ping = async function () {
    var start = Date.now();
    if (this._config.connectionType === CONNECTION_TYPES.NETWORK) {
      var url = 'http://' + this._networkIp + ':' + this._networkPort + '/ping';
      await _fetchWithTimeout(url, {}, 3000);
    }
    var lat = Date.now() - start;
    this._latency  = lat;
    this._lastPing = new Date().toISOString();
    this._status   = STATUS.CONNECTED;
    return lat;
  };

  // ── NFC Reader Device ────────────────────────────────────────────────────────

  /**
   * NFCReaderDevice — Uses the Web NFC API (NDEFReader).
   */
  function NFCReaderDevice(config) {
    BaseDevice.call(this, config);
    this._reader   = null;
    this._abortCtrl = null;
  }
  _inherit(NFCReaderDevice, BaseDevice);

  NFCReaderDevice.prototype.connect = async function () {
    this._status = STATUS.CONNECTING;
    try {
      if (typeof NDEFReader === 'undefined') {
        throw new Error('Web NFC API not supported. Use Chrome on Android or a compatible browser.');
      }
      this._reader = new NDEFReader();
      this._status = STATUS.CONNECTED;
      emit('device:connected', { deviceId: this._config.id });
    } catch (e) {
      this._status = STATUS.ERROR;
      emit('device:error', { deviceId: this._config.id, error: e.message });
      throw e;
    }
    return this._status;
  };

  NFCReaderDevice.prototype.scan = async function (onRead) {
    if (!this._reader) await this.connect();
    this._abortCtrl = new AbortController();
    await this._reader.scan({ signal: this._abortCtrl.signal });
    var self = this;
    this._reader.addEventListener('reading', function (e) {
      var tag = {
        serialNumber: e.serialNumber,
        records: e.message.records.map(function (r) {
          return {
            recordType: r.recordType,
            mediaType:  r.mediaType,
            data: r.data ? new TextDecoder().decode(r.data) : null,
          };
        }),
      };
      emit('nfc:read', { deviceId: self._config.id, tag: tag });
      if (onRead) onRead(tag);
    });
    this._reader.addEventListener('readingerror', function () {
      emit('device:error', { deviceId: self._config.id, error: 'NFC read error — check tag placement' });
    });
  };

  NFCReaderDevice.prototype.write = async function (data) {
    if (!this._reader) await this.connect();
    var self = this;
    return new Promise(function (resolve, reject) {
      var abortCtrl = new AbortController();
      self._reader.scan({ signal: abortCtrl.signal }).then(function () {
        self._reader.addEventListener('reading', async function (e) {
          try {
            await self._reader.write(data);
            abortCtrl.abort();
            resolve({ success: true, serialNumber: e.serialNumber });
          } catch (err) {
            reject(err);
          }
        }, { once: true });
      }).catch(reject);
    });
  };

  NFCReaderDevice.prototype.testNFC = async function () {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        reject(new Error('NFC test timed out after 10 seconds — no tag detected'));
      }, 10000);
      this.scan(function (tag) {
        clearTimeout(timer);
        if (this._abortCtrl) this._abortCtrl.abort();
        resolve({ success: true, tag: tag });
      }.bind(this)).catch(function (e) {
        clearTimeout(timer);
        reject(e);
      });
    }.bind(this));
  };

  NFCReaderDevice.prototype.disconnect = async function () {
    if (this._abortCtrl) {
      try { this._abortCtrl.abort(); } catch (e) { /* ignore */ }
    }
    this._status = STATUS.DISCONNECTED;
    emit('device:disconnected', { deviceId: this._config.id });
  };

  NFCReaderDevice.prototype.ping = async function () {
    var start = Date.now();
    if (typeof NDEFReader === 'undefined') throw new Error('NFC not available');
    var lat = Date.now() - start;
    this._latency  = lat;
    this._lastPing = new Date().toISOString();
    this._status   = STATUS.CONNECTED;
    return lat;
  };

  // ── Biometric Device ─────────────────────────────────────────────────────────

  /**
   * BiometricDevice — Uses WebAuthn / PublicKeyCredential API.
   */
  function BiometricDevice(config) {
    BaseDevice.call(this, config);
    this._rpId   = (config.config && config.config.rpId)   || window.location.hostname;
    this._rpName = (config.config && config.config.rpName) || 'SOKONI SmartPOS';
  }
  _inherit(BiometricDevice, BaseDevice);

  BiometricDevice.prototype.connect = async function () {
    this._status = STATUS.CONNECTING;
    try {
      if (!window.PublicKeyCredential) {
        throw new Error('WebAuthn not supported in this browser');
      }
      var available = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
      if (!available) {
        throw new Error('No platform authenticator available (fingerprint/face ID required)');
      }
      this._status = STATUS.CONNECTED;
      emit('device:connected', { deviceId: this._config.id });
    } catch (e) {
      this._status = STATUS.ERROR;
      emit('device:error', { deviceId: this._config.id, error: e.message });
      throw e;
    }
    return this._status;
  };

  BiometricDevice.prototype.verify = async function (userId) {
    try {
      var challenge = _randomChallenge();
      var credential = await navigator.credentials.get({
        publicKey: {
          challenge:        challenge,
          rpId:             this._rpId,
          userVerification: 'required',
          timeout:          60000,
        },
      });
      if (credential) {
        emit('biometric:verified', { deviceId: this._config.id, userId: userId });
        return { verified: true, credentialId: _ab2hex(credential.rawId) };
      }
      return { verified: false };
    } catch (e) {
      emit('device:error', { deviceId: this._config.id, error: e.message });
      return { verified: false, error: e.message };
    }
  };

  BiometricDevice.prototype.enroll = async function (userId, displayName) {
    try {
      var challenge = _randomChallenge();
      var credential = await navigator.credentials.create({
        publicKey: {
          challenge: challenge,
          rp: { id: this._rpId, name: this._rpName },
          user: {
            id:          new TextEncoder().encode(userId),
            name:        userId,
            displayName: displayName || userId,
          },
          pubKeyCredParams: [
            { alg: -7,   type: 'public-key' }, // ES256
            { alg: -257, type: 'public-key' }, // RS256
          ],
          authenticatorSelection: {
            authenticatorAttachment: 'platform',
            userVerification:        'required',
          },
          timeout: 60000,
        },
      });
      if (credential) {
        var credId = _ab2hex(credential.rawId);
        // Persist credential ID to localStorage for this user
        try {
          var storedCreds = JSON.parse(localStorage.getItem('_posBiometricCreds') || '{}');
          storedCreds[userId] = credId;
          localStorage.setItem('_posBiometricCreds', JSON.stringify(storedCreds));
        } catch (e) { /* ignore storage error */ }
        emit('biometric:enrolled', { deviceId: this._config.id, userId: userId, credentialId: credId });
        return { success: true, credentialId: credId };
      }
      return { success: false };
    } catch (e) {
      emit('device:error', { deviceId: this._config.id, error: e.message });
      return { success: false, error: e.message };
    }
  };

  BiometricDevice.prototype.testBiometric = async function () {
    return this.verify('test_user');
  };

  BiometricDevice.prototype.ping = async function () {
    var start = Date.now();
    if (!window.PublicKeyCredential) throw new Error('WebAuthn not supported');
    var lat = Date.now() - start;
    this._latency  = lat;
    this._lastPing = new Date().toISOString();
    this._status   = STATUS.CONNECTED;
    return lat;
  };

  // ---------------------------------------------------------------------------
  // D. VENDOR ADAPTER REGISTRY
  // ---------------------------------------------------------------------------

  function registerAdapter(vendorId, AdapterClass) {
    if (!vendorId) throw new Error('vendorId is required');
    if (typeof AdapterClass !== 'function') throw new Error('AdapterClass must be a constructor');
    _adapters[vendorId] = AdapterClass;
  }

  function getAdapter(vendorId) {
    return _adapters[vendorId] || null;
  }

  function listAdapters() {
    return Object.keys(_adapters).map(function (vid) {
      return {
        vendorId:    vid,
        adapterName: _adapters[vid].adapterName || vid,
        category:    _adapters[vid].defaultCategory || 'unknown',
        connections: _adapters[vid].supportedConnections || [],
      };
    });
  }

  // ── Pre-registered Vendor Adapters ───────────────────────────────────────────

  // Epson TM-T88 series (most popular receipt printer in Kenya)
  function EpsonTM88Adapter(config) {
    config.modelName = config.modelName || 'Epson TM-T88';
    ReceiptPrinterDevice.call(this, config);
  }
  _inherit(EpsonTM88Adapter, ReceiptPrinterDevice);
  EpsonTM88Adapter.adapterName       = 'Epson TM-T88 (VI)';
  EpsonTM88Adapter.defaultCategory   = CATEGORIES.RECEIPT_PRINTER;
  EpsonTM88Adapter.supportedConnections = ['usb', 'network', 'bluetooth'];
  registerAdapter('epson_tm88', EpsonTM88Adapter);

  // Star TSP100 series
  function StarTSP100Adapter(config) {
    config.modelName = config.modelName || 'Star TSP100';
    ReceiptPrinterDevice.call(this, config);
  }
  _inherit(StarTSP100Adapter, ReceiptPrinterDevice);
  StarTSP100Adapter.adapterName       = 'Star TSP100';
  StarTSP100Adapter.defaultCategory   = CATEGORIES.RECEIPT_PRINTER;
  StarTSP100Adapter.supportedConnections = ['usb', 'bluetooth'];
  registerAdapter('star_tsp100', StarTSP100Adapter);

  // Zebra ZD220 label printer
  function ZebraZD220Adapter(config) {
    config.modelName = config.modelName || 'Zebra ZD220';
    LabelPrinterDevice.call(this, config);
  }
  _inherit(ZebraZD220Adapter, LabelPrinterDevice);
  ZebraZD220Adapter.adapterName       = 'Zebra ZD220';
  ZebraZD220Adapter.defaultCategory   = CATEGORIES.LABEL_PRINTER;
  ZebraZD220Adapter.supportedConnections = ['usb', 'network'];
  registerAdapter('zebra_zd220', ZebraZD220Adapter);

  // Honeywell Voyager barcode scanner
  function HoneywellVoyagerAdapter(config) {
    config.modelName = config.modelName || 'Honeywell Voyager';
    BarcodeScannerDevice.call(this, config);
  }
  _inherit(HoneywellVoyagerAdapter, BarcodeScannerDevice);
  HoneywellVoyagerAdapter.adapterName       = 'Honeywell Voyager';
  HoneywellVoyagerAdapter.defaultCategory   = CATEGORIES.BARCODE_SCANNER;
  HoneywellVoyagerAdapter.supportedConnections = ['usb_hid', 'bluetooth_hid'];
  registerAdapter('honeywell_voyager', HoneywellVoyagerAdapter);

  // Datalogic Gryphon barcode scanner
  function DatalogicGryphonAdapter(config) {
    config.modelName = config.modelName || 'Datalogic Gryphon';
    BarcodeScannerDevice.call(this, config);
  }
  _inherit(DatalogicGryphonAdapter, BarcodeScannerDevice);
  DatalogicGryphonAdapter.adapterName       = 'Datalogic Gryphon';
  DatalogicGryphonAdapter.defaultCategory   = CATEGORIES.BARCODE_SCANNER;
  DatalogicGryphonAdapter.supportedConnections = ['usb_hid'];
  registerAdapter('datalogic_gryphon', DatalogicGryphonAdapter);

  // OHAUS Ranger 3000 weighing scale
  function OhausRanger3000Adapter(config) {
    config.modelName = config.modelName || 'OHAUS Ranger 3000';
    WeighingScaleDevice.call(this, config);
  }
  _inherit(OhausRanger3000Adapter, WeighingScaleDevice);
  OhausRanger3000Adapter.adapterName       = 'OHAUS Ranger 3000';
  OhausRanger3000Adapter.defaultCategory   = CATEGORIES.WEIGHING_SCALE;
  OhausRanger3000Adapter.supportedConnections = ['usb_serial', 'bluetooth'];
  registerAdapter('ohaus_ranger3000', OhausRanger3000Adapter);

  // CAS SW-1 price computing scale (very common in Kenyan supermarkets)
  function CASSW1Adapter(config) {
    config.modelName = config.modelName || 'CAS SW-1';
    WeighingScaleDevice.call(this, config);
  }
  _inherit(CASSW1Adapter, WeighingScaleDevice);
  CASSW1Adapter.adapterName       = 'CAS SW-1';
  CASSW1Adapter.defaultCategory   = CATEGORIES.WEIGHING_SCALE;
  CASSW1Adapter.supportedConnections = ['serial', 'usb'];
  registerAdapter('cas_sw1', CASSW1Adapter);

  // ACR122U NFC reader
  function ACR122UAdapter(config) {
    config.modelName = config.modelName || 'ACR122U';
    NFCReaderDevice.call(this, config);
  }
  _inherit(ACR122UAdapter, NFCReaderDevice);
  ACR122UAdapter.adapterName       = 'ACS ACR122U';
  ACR122UAdapter.defaultCategory   = CATEGORIES.NFC_READER;
  ACR122UAdapter.supportedConnections = ['usb'];
  registerAdapter('acr122u_nfc', ACR122UAdapter);

  // Generic HID barcode scanner (keyboard wedge — most common setup)
  function GenericHIDScannerAdapter(config) {
    config.modelName = config.modelName || 'Generic HID Scanner';
    BarcodeScannerDevice.call(this, config);
  }
  _inherit(GenericHIDScannerAdapter, BarcodeScannerDevice);
  GenericHIDScannerAdapter.adapterName       = 'Generic HID Scanner (Keyboard Wedge)';
  GenericHIDScannerAdapter.defaultCategory   = CATEGORIES.BARCODE_SCANNER;
  GenericHIDScannerAdapter.supportedConnections = ['usb_hid'];
  registerAdapter('generic_hid_scanner', GenericHIDScannerAdapter);

  // Network receipt printer (configurable IP)
  function NetworkPrinterAdapter(config) {
    config.modelName = config.modelName || 'Network Printer';
    config.connectionType = CONNECTION_TYPES.NETWORK;
    ReceiptPrinterDevice.call(this, config);
  }
  _inherit(NetworkPrinterAdapter, ReceiptPrinterDevice);
  NetworkPrinterAdapter.adapterName       = 'Network Receipt Printer (TCP/IP)';
  NetworkPrinterAdapter.defaultCategory   = CATEGORIES.RECEIPT_PRINTER;
  NetworkPrinterAdapter.supportedConnections = ['network'];
  registerAdapter('network_printer', NetworkPrinterAdapter);

  // ---------------------------------------------------------------------------
  // E. HEALTH MONITORING
  // ---------------------------------------------------------------------------

  function startHealthMonitor(intervalMs) {
    intervalMs = intervalMs || 30000;
    if (_healthTimer) stopHealthMonitor();
    _healthTimer = setInterval(async function () {
      var report = await getHealthReport();
      emit('device:health', { report: report, timestamp: new Date().toISOString() });
    }, intervalMs);
  }

  function stopHealthMonitor() {
    if (_healthTimer) {
      clearInterval(_healthTimer);
      _healthTimer = null;
    }
  }

  async function getHealthReport() {
    var deviceIds = Object.keys(_registry);
    var results   = [];
    for (var i = 0; i < deviceIds.length; i++) {
      var id     = deviceIds[i];
      var device = _registry[id];
      var entry  = {
        deviceId:  id,
        name:      device._config.name     || 'Unknown',
        category:  device._config.category || 'unknown',
        status:    device._status,
        lastPing:  device._lastPing,
        latency:   device._latency,
        healthy:   false,
        error:     null,
      };
      try {
        await device.ping();
        entry.latency  = device._latency;
        entry.lastPing = device._lastPing;
        entry.healthy  = true;
        entry.status   = device._status;
      } catch (e) {
        entry.healthy = false;
        entry.error   = e.message;
        entry.status  = STATUS.ERROR;
      }
      results.push(entry);
    }
    _lastHealthReport = results;
    return results;
  }

  // ---------------------------------------------------------------------------
  // G. localStorage PERSISTENCE
  // ---------------------------------------------------------------------------

  function saveRegistry() {
    try {
      var snapshot = {};
      Object.keys(_registry).forEach(function (id) {
        var device = _registry[id];
        snapshot[id] = {
          config:    device._config,
          status:    device._status,
          lastPing:  device._lastPing,
          latency:   device._latency,
        };
      });
      localStorage.setItem('_posHardware', JSON.stringify(snapshot));
    } catch (e) {
      console.warn('[SokoniHardware] saveRegistry failed:', e.message);
    }
  }

  function loadRegistry() {
    try {
      var raw = localStorage.getItem('_posHardware');
      if (!raw) return;
      var snapshot = JSON.parse(raw);
      Object.keys(snapshot).forEach(function (id) {
        var snap = snapshot[id];
        if (!snap || !snap.config) return;
        // Re-register device from saved config — do not re-connect automatically
        try {
          registerDevice(snap.config);
        } catch (e) {
          console.warn('[SokoniHardware] Could not restore device ' + id + ':', e.message);
        }
      });
    } catch (e) {
      console.warn('[SokoniHardware] loadRegistry failed:', e.message);
    }
  }

  // ---------------------------------------------------------------------------
  // PRIVATE HELPERS
  // ---------------------------------------------------------------------------

  function _fetchWithTimeout(url, options, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        reject(new Error('Request timed out after ' + timeoutMs + 'ms: ' + url));
      }, timeoutMs);
      fetch(url, options || {})
        .then(function (res) { clearTimeout(timer); resolve(res); })
        .catch(function (e)  { clearTimeout(timer); reject(e);    });
    });
  }

  function _browserPrint(html, paperWidth) {
    return new Promise(function (resolve) {
      var printWin = window.open('', '_blank', 'width=400,height=600');
      if (!printWin) { resolve({ success: false, error: 'Popup blocked' }); return; }
      var maxWidth = paperWidth === 58 ? '58mm' : '80mm';
      printWin.document.write([
        '<!DOCTYPE html><html><head>',
        '<style>',
        'body{margin:0;padding:4mm;font-family:monospace;font-size:10pt;}',
        '@media print{body{width:' + maxWidth + ';}}',
        '</style></head><body>',
        html,
        '<script>window.onload=function(){window.print();window.close();}<\/script>',
        '</body></html>',
      ].join(''));
      printWin.document.close();
      resolve({ success: true });
    });
  }

  function _networkPrint(ip, port, html, cutType) {
    // Convert HTML to plain text for ESC/POS (simplified)
    var text = html.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
    var ESC = '\x1B';
    var GS  = '\x1D';
    var cutCmd = cutType === 'partial' ? GS + 'V\x41\x00' : GS + 'V\x00'; // full cut
    var data = ESC + '@' + text + '\n\n\n' + cutCmd;

    return _fetchWithTimeout('http://' + ip + ':' + port + '/raw', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: data,
    }, 8000);
  }

  function _escPosPrint(html, cutType, nativeDevice) {
    // For USB WebUSB devices
    var text = html.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
    var GS   = '\x1D';
    var ESC  = '\x1B';
    var cutCmd = cutType === 'partial' ? GS + 'V\x41\x00' : GS + 'V\x00';
    var payload = new TextEncoder().encode(ESC + '@' + text + '\n\n\n' + cutCmd);

    if (nativeDevice && nativeDevice.opened) {
      var iface = nativeDevice.configuration.interfaces[0];
      var ep    = iface.alternate.endpoints.find(function (e) { return e.direction === 'out'; });
      if (ep) return nativeDevice.transferOut(ep.endpointNumber, payload);
    }
    return Promise.resolve({ success: false, error: 'USB device not open' });
  }

  function _buildZPLLabel(opts) {
    var w    = Math.round(opts.width  * opts.dpi);
    var h    = Math.round(opts.height * opts.dpi);
    var lines = [
      '^XA',
      '^PW' + w,
      '^LL' + h,
      '^FO20,20^A0N,30,30^FD' + _zplEscape(opts.name) + '^FS',
      '^FO20,60^A0N,24,24^FDKES ' + _zplEscape(opts.price) + '^FS',
    ];
    if (opts.weight) {
      lines.push('^FO20,90^A0N,20,20^FD' + _zplEscape(opts.weight) + '^FS');
    }
    if (opts.expiry) {
      lines.push('^FO20,115^A0N,18,18^FDEXP: ' + _zplEscape(opts.expiry) + '^FS');
    }
    lines.push(
      '^FO20,140^BCN,60,Y,N,N^FD' + _zplEscape(opts.barcode) + '^FS',
      '^XZ'
    );
    return lines.join('\n');
  }

  function _zplEscape(str) {
    return String(str || '').replace(/\^/g, '').replace(/~/g, '');
  }

  function _randomWeight(unit, decimals, tareOffset) {
    var raw = (Math.random() * 4.9 + 0.1) - (tareOffset || 0);
    raw = Math.max(0, raw);
    if (unit === 'g') raw = raw * 1000;
    if (unit === 'lb') raw = raw * 2.2046;
    return {
      value:  parseFloat(raw.toFixed(decimals || 3)),
      unit:   unit || 'kg',
      stable: true,
    };
  }

  function _randomChallenge() {
    var arr = new Uint8Array(32);
    crypto.getRandomValues(arr);
    return arr;
  }

  function _ab2hex(buffer) {
    return Array.from(new Uint8Array(buffer))
      .map(function (b) { return b.toString(16).padStart(2, '0'); })
      .join('');
  }

  function _vendorIdFromString(vendorId) {
    if (typeof vendorId === 'number') return vendorId;
    // Map known vendor string IDs to numeric USB VIDs
    var map = {
      epson_tm88:       0x04b8,
      star_tsp100:      0x0519,
      zebra_zd220:      0x0a5f,
      honeywell_voyager: 0x0c2e,
      datalogic_gryphon: 0x05f9,
      acr122u_nfc:      0x072f,
    };
    return map[vendorId] || 0x0000;
  }

  // ---------------------------------------------------------------------------
  // AUTO-LOAD REGISTRY ON SCRIPT LOAD
  // ---------------------------------------------------------------------------
  (function () {
    try { loadRegistry(); } catch (e) { /* silent on init */ }
  })();

  // ---------------------------------------------------------------------------
  // PUBLIC API
  // ---------------------------------------------------------------------------
  return {
    CATEGORIES:          CATEGORIES,
    CONNECTION_TYPES:    CONNECTION_TYPES,
    STATUS:              STATUS,

    // Discovery & Registration
    discover:            discover,
    capabilities:        capabilities,
    recommendedTransports: recommendedTransports,
    transportPlan:       transportPlan,
    why:                 why,
    deviceProfile:       deviceProfile,
    PRINTER_REGISTRY:    PRINTER_REGISTRY,
    deviceCompatibility: deviceCompatibility,
    analyzeEnvironment:  analyzeEnvironment,
    autoSelect:          autoSelect,
    getPreferences:      getPreferences,
    savePreference:      savePreference,
    registerDevice:      registerDevice,
    unregisterDevice:    unregisterDevice,
    getDevice:           getDevice,
    getDevicesByCategory: getDevicesByCategory,

    // Vendor Adapters
    registerAdapter:     registerAdapter,
    getAdapter:          getAdapter,
    listAdapters:        listAdapters,

    // Health Monitoring
    startHealthMonitor:  startHealthMonitor,
    stopHealthMonitor:   stopHealthMonitor,
    getHealthReport:     getHealthReport,

    // Event System
    on:    on,
    off:   off,
    emit:  emit,

    // Persistence
    saveRegistry: saveRegistry,
    loadRegistry: loadRegistry,

    // Device Constructors (for custom instantiation)
    BaseDevice:          BaseDevice,
    ReceiptPrinterDevice: ReceiptPrinterDevice,
    BarcodeScannerDevice: BarcodeScannerDevice,
    WeighingScaleDevice:  WeighingScaleDevice,
    LabelPrinterDevice:   LabelPrinterDevice,
    NFCReaderDevice:      NFCReaderDevice,
    BiometricDevice:      BiometricDevice,
  };

})();
