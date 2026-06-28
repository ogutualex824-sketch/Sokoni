/* ============================================================
   SOKONI SmartPOS 2.0 — Universal Payment Terminal Driver System
   Modular driver architecture for all payment terminal vendors.
   Zero hard-coded vendor dependencies — each driver is a plugin.

   Usage:
     PosTerminalDriver.register(new IntaSendDriver());
     PosTerminalDriver.register(new StripeTerminalDriver());
     const terminal = await PosTerminalDriver.connect('intasend');
     const result = await terminal.charge({ amount: 1500, currency: 'KES', ref: 'ORD-001' });
============================================================ */
(function () {
  'use strict';

  /* ═══════════════════════════════════════════════════════════
     BASE DRIVER — Abstract interface all drivers must implement
  ═══════════════════════════════════════════════════════════ */
  function BaseTerminalDriver(config) {
    this.config     = config || {};
    this.vendorId   = 'base';
    this.vendorName = 'Generic Terminal';
    this.connected  = false;
    this.terminal   = null;
  }

  /* All methods return Promises. Drivers must override these. */
  BaseTerminalDriver.prototype = {
    /* Connect to the terminal and return { connected: bool } */
    connect:     function ()       { return Promise.reject(new Error('Not implemented')); },
    /* Disconnect from terminal */
    disconnect:  function ()       { return Promise.resolve(); },
    /* Check if terminal is responsive */
    ping:        function ()       { return Promise.resolve(this.connected); },
    /* Charge the customer { amount (KES), currency, ref, description } → { success, ref, receiptData } */
    charge:      function (opts)   { return Promise.reject(new Error('Not implemented')); },
    /* Cancel a pending charge */
    cancel:      function (ref)    { return Promise.reject(new Error('Not implemented')); },
    /* Refund a completed charge */
    refund:      function (opts)   { return Promise.reject(new Error('Not implemented')); },
    /* Print receipt via terminal (if supported) */
    printReceipt: function (data)  { return Promise.resolve({ printed: false }); },
    /* Get terminal status/battery/firmware */
    status:      function ()       { return Promise.resolve({ connected: this.connected, vendor: this.vendorName }); },
    /* Handle terminal events (called by the driver registry) */
    onEvent:     function (fn)     { this._eventHandler = fn; },
    _emit:       function (event, data) { if (this._eventHandler) this._eventHandler(event, data); },
  };

  /* ═══════════════════════════════════════════════════════════
     DRIVER REGISTRY — Global registry + connection manager
  ═══════════════════════════════════════════════════════════ */
  var _drivers     = {};   /* vendorId → driver class */
  var _active      = {};   /* vendorId → connected instance */
  var _eventBus    = [];   /* global event listeners */

  var PosTerminalDriver = {

    /* Register a driver class or instance */
    register: function (DriverClassOrInstance) {
      var inst = typeof DriverClassOrInstance === 'function'
        ? new DriverClassOrInstance()
        : DriverClassOrInstance;
      _drivers[inst.vendorId] = inst;
      console.log('[TerminalDriver] Registered:', inst.vendorName, '(' + inst.vendorId + ')');
      return this;
    },

    /* List registered drivers */
    list: function () {
      return Object.values(_drivers).map(function (d) {
        return { id: d.vendorId, name: d.vendorName, connected: !!_active[d.vendorId] };
      });
    },

    /* Connect to a specific terminal */
    connect: async function (vendorId) {
      var driver = _drivers[vendorId];
      if (!driver) throw new Error('Driver not found: ' + vendorId);
      if (_active[vendorId]) return _active[vendorId]; /* already connected */

      var result = await driver.connect(driver.config);
      if (result && result.connected !== false) {
        _active[vendorId] = driver;
        driver.onEvent(function (event, data) { PosTerminalDriver._emitGlobal(vendorId, event, data); });
        _emitGlobal(vendorId, 'connected', { vendor: driver.vendorName });
      }
      return driver;
    },

    /* Auto-detect and connect to first available terminal */
    autoConnect: async function () {
      var ids = Object.keys(_drivers);
      for (var i = 0; i < ids.length; i++) {
        try {
          var d = await this.connect(ids[i]);
          if (d.connected) return d;
        } catch (e) { /* try next */ }
      }
      throw new Error('No compatible payment terminal found');
    },

    /* Get connected terminal instance */
    get: function (vendorId) {
      return _active[vendorId] || null;
    },

    /* Get first connected terminal */
    primary: function () {
      var ids = Object.keys(_active);
      return ids.length ? _active[ids[0]] : null;
    },

    /* Charge via primary or specified terminal */
    charge: async function (opts, vendorId) {
      var terminal = vendorId ? this.get(vendorId) : this.primary();
      if (!terminal) throw new Error('No connected payment terminal');
      return terminal.charge(opts);
    },

    /* Listen to terminal events */
    on: function (fn) {
      _eventBus.push(fn);
      return function () { _eventBus = _eventBus.filter(function (f) { return f !== fn; }); };
    },

    _emitGlobal: function (vendorId, event, data) {
      _eventBus.forEach(function (fn) {
        try { fn(vendorId, event, data); } catch (e) {}
      });
    },
  };

  /* ═══════════════════════════════════════════════════════════
     DRIVER 1: IntaSend Software Terminal (M-Pesa + Cards)
     Default terminal for Kenya — no hardware required.
  ═══════════════════════════════════════════════════════════ */
  function IntaSendDriver(config) {
    BaseTerminalDriver.call(this, config);
    this.vendorId   = 'intasend';
    this.vendorName = 'IntaSend (M-Pesa & Cards)';
    this.connected  = true; /* Software terminal — always available */
  }
  IntaSendDriver.prototype = Object.create(BaseTerminalDriver.prototype);

  IntaSendDriver.prototype.connect = function () {
    this.connected = true;
    return Promise.resolve({ connected: true, vendor: this.vendorName });
  };

  IntaSendDriver.prototype.charge = function (opts) {
    var self = this;
    /* Delegate to existing SokoniPay infrastructure */
    if (opts.method === 'mpesa' || !opts.method) {
      /* Use SOKONI's existing STK push CF */
      var callCF = window.firebase && window.firebase.functions
        ? window.firebase.functions().httpsCallable('initiateSTKPush')
        : null;
      if (!callCF) return Promise.reject(new Error('Firebase not available'));

      self._emit('charge_started', { method: 'mpesa', amount: opts.amount });
      return callCF({
        amount:      opts.amount,
        phone:       opts.phone,
        reference:   opts.ref || opts.reference,
        description: opts.description || 'POS Payment',
      }).then(function (res) {
        self._emit('stk_sent', { phone: opts.phone });
        return { status: 'stk_initiated', ref: res.data.checkoutRequestId || opts.ref };
      });
    }
    /* Card — redirect to IntaSend checkout */
    return Promise.resolve({
      status:      'card_redirect',
      checkoutUrl: 'https://payment.intasend.com/pay/checkout/?ref=' + encodeURIComponent(opts.ref || ''),
    });
  };

  IntaSendDriver.prototype.refund = function (opts) {
    /* IntaSend refunds go through their API — handled server-side */
    return Promise.resolve({ status: 'pending_manual', message: 'Contact IntaSend support for refunds' });
  };

  IntaSendDriver.prototype.status = function () {
    return Promise.resolve({ connected: true, vendor: this.vendorName, type: 'software' });
  };

  /* ═══════════════════════════════════════════════════════════
     DRIVER STUB FACTORY — generates placeholder drivers for
     hardware terminals (Ingenico, Verifone, PAX, etc.)
     These show up in the UI and can be extended with real SDKs.
  ═══════════════════════════════════════════════════════════ */
  function _createHardwareStub(vendorId, vendorName, connectionTypes) {
    function HardwareDriver(config) {
      BaseTerminalDriver.call(this, config);
      this.vendorId        = vendorId;
      this.vendorName      = vendorName;
      this.connectionTypes = connectionTypes || ['usb', 'network'];
      this.connected       = false;
    }
    HardwareDriver.prototype = Object.create(BaseTerminalDriver.prototype);

    HardwareDriver.prototype.connect = function (config) {
      var self = this;
      /* Try WebUSB first if available */
      if (navigator.usb && this.connectionTypes.includes('usb')) {
        return navigator.usb.requestDevice({ filters: [] })
          .then(function (device) {
            self.terminal  = device;
            self.connected = true;
            return { connected: true, vendor: self.vendorName, device: device.productName };
          })
          .catch(function () {
            return { connected: false, error: 'User cancelled USB device selection' };
          });
      }
      /* Network fallback */
      if (config && config.ipAddress && this.connectionTypes.includes('network')) {
        return fetch('http://' + config.ipAddress + ':8080/status', { method: 'GET', timeout: 3000 })
          .then(function (r) {
            self.connected = r.ok;
            return { connected: r.ok, vendor: self.vendorName };
          })
          .catch(function () {
            return { connected: false, error: 'Terminal unreachable at ' + config.ipAddress };
          });
      }
      return Promise.resolve({ connected: false, error: 'No compatible connection method available. Please configure terminal IP address.' });
    };

    HardwareDriver.prototype.charge = function (opts) {
      if (!this.connected || !this.terminal) {
        return Promise.reject(new Error(this.vendorName + ' is not connected. Please pair the terminal first.'));
      }
      return Promise.resolve({ status: 'pending_hardware', message: 'Please follow the terminal prompts' });
    };

    return HardwareDriver;
  }

  /* ── Register hardware driver stubs ── */
  var HARDWARE_VENDORS = [
    { id: 'ingenico',     name: 'Ingenico',           types: ['usb', 'network', 'bluetooth'] },
    { id: 'verifone',     name: 'Verifone',            types: ['usb', 'network'] },
    { id: 'pax',          name: 'PAX Technology',      types: ['usb', 'network', 'wifi'] },
    { id: 'castles',      name: 'Castles Technology',  types: ['usb', 'bluetooth'] },
    { id: 'newland',      name: 'Newland Payment',     types: ['usb', 'network'] },
    { id: 'sunmi',        name: 'Sunmi Terminal',      types: ['network', 'wifi'] },
    { id: 'nexgo',        name: 'NEXGO',               types: ['usb', 'network'] },
    { id: 'bbpos',        name: 'BBPOS (Stripe)',       types: ['bluetooth', 'audio-jack'] },
    { id: 'miura',        name: 'Miura Systems',       types: ['bluetooth', 'usb'] },
    { id: 'stripe',       name: 'Stripe Terminal',     types: ['bluetooth', 'usb', 'wifi'] },
  ];

  HARDWARE_VENDORS.forEach(function (v) {
    PosTerminalDriver.register(_createHardwareStub(v.id, v.name, v.types));
  });

  /* ── Register the default IntaSend driver (always available in Kenya) ── */
  PosTerminalDriver.register(new IntaSendDriver());

  /* ═══════════════════════════════════════════════════════════
     PERIPHERAL MANAGER — USB/BT/Network device discovery
  ═══════════════════════════════════════════════════════════ */
  window.SokoniPeripherals = {

    /* Detect connected USB printers/scanners */
    detectUSB: async function () {
      if (!navigator.usb) return { supported: false, devices: [] };
      try {
        var devices = await navigator.usb.getDevices();
        return {
          supported: true,
          devices: devices.map(function (d) {
            return {
              name:    d.productName || 'Unknown USB Device',
              vendor:  d.manufacturerName || 'Unknown',
              vendorId: d.vendorId.toString(16).padStart(4, '0'),
              productId: d.productId.toString(16).padStart(4, '0'),
            };
          }),
        };
      } catch (e) {
        return { supported: true, devices: [], error: e.message };
      }
    },

    /* Request USB device pairing */
    requestUSB: async function (filters) {
      if (!navigator.usb) throw new Error('WebUSB not supported in this browser');
      return navigator.usb.requestDevice({ filters: filters || [] });
    },

    /* Detect Bluetooth devices */
    detectBluetooth: async function () {
      if (!navigator.bluetooth) return { supported: false, devices: [] };
      try {
        var available = await navigator.bluetooth.getAvailability();
        if (!available) return { supported: true, available: false, devices: [] };
        /* getDevices() requires user gesture — can only list paired devices */
        var devices = await navigator.bluetooth.getDevices();
        return {
          supported: true,
          available: true,
          devices: devices.map(function (d) {
            return { name: d.name || 'Unknown BT Device', id: d.id };
          }),
        };
      } catch (e) {
        return { supported: false, error: e.message };
      }
    },

    /* Request Bluetooth device pairing */
    requestBluetooth: async function (services) {
      if (!navigator.bluetooth) throw new Error('Web Bluetooth not supported in this browser');
      return navigator.bluetooth.requestDevice({
        acceptAllDevices: !services || !services.length,
        optionalServices: services || [],
      });
    },

    /* Network printer discovery (via mDNS — limited in browsers)
       Falls back to user-entered IP address */
    discoverNetworkPrinters: async function (subnet) {
      /* Browsers cannot do mDNS. Return guidance instead. */
      return {
        supported: false,
        message: 'Network printer auto-discovery requires the SOKONI POS Desktop App. ' +
                 'For web browser mode, enter your printer\'s IP address manually.',
        manual:  true,
      };
    },

    /* Test print to verify printer is connected */
    testPrint: async function (printerConfig) {
      if (window.SokoniUniversalPrinter) {
        return window.SokoniUniversalPrinter.printTestPage(printerConfig);
      }
      return { printed: false, error: 'Printer engine not loaded' };
    },

    /* Get a summary of all connected peripherals */
    summary: async function () {
      var usb = await this.detectUSB();
      var bt  = await this.detectBluetooth();
      return {
        usb:        usb,
        bluetooth:  bt,
        camera:     { supported: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) },
        nfc:        { supported: !!window.NDEFReader },
        serial:     { supported: !!navigator.serial },
        webHid:     { supported: !!navigator.hid },
      };
    },
  };

  /* ── Export ── */
  window.PosTerminalDriver = PosTerminalDriver;

}());
