/* ================================================================
   SOKONI Printer Discovery Engine v2.0
   Auto-detects printers via: BLE, WebUSB, Web Serial, Network
   Also handles Android native enumeration & stored device recall
================================================================ */
window.SokoniPrinterDiscovery = (() => {
  'use strict';

  /* Known thermal printer USB vendor IDs */
  const USB_THERMAL_VENDORS = [
    { vendorId: 0x04B8, name: 'Epson'      },
    { vendorId: 0x0519, name: 'Star'       },
    { vendorId: 0x154F, name: 'Xprinter'   },
    { vendorId: 0x0FE6, name: 'Sunmi'      },
    { vendorId: 0x1FC9, name: 'HOIN'       },
    { vendorId: 0x0DD4, name: 'Custom'     },
    { vendorId: 0x0456, name: 'Citizen'    },
    { vendorId: 0x0C2E, name: 'Honeywell'  },
    { vendorId: 0x05CB, name: 'TSC'        },
    { vendorId: 0x0A5F, name: 'Zebra'      },
    { vendorId: 0x1B5F, name: 'GOOJPRT'    },
    { vendorId: 0x067B, name: 'Prolific'   }, /* USB-serial bridge */
    { vendorId: 0x0403, name: 'FTDI'       }, /* USB-serial bridge */
    { vendorId: 0x10C4, name: 'SiLabs'     }, /* USB-serial bridge */
    { vendorId: 0x1A86, name: 'CH340'      }, /* USB-serial bridge */
  ];

  /* BLE service UUIDs used by thermal printers */
  const BLE_PRINTER_SERVICES = [
    '0000ffe0-0000-1000-8000-00805f9b34fb',   /* Generic BLE serial (HM-10 style) */
    '000018f0-0000-1000-8000-00805f9b34fb',   /* Printer service */
    'e7810a71-73ae-499d-8c15-faa9aef0c3f2',   /* Epson BLE */
    '49535343-fe7d-4ae5-8fa9-9fafd205e455',   /* Microchip/Nordic UART */
    '00001101-0000-1000-8000-00805f9b34fb',   /* SPP (Classic BT) */
    '0000ff00-0000-1000-8000-00805f9b34fb',   /* Common alternative */
    '6e400001-b5a3-f393-e0a9-e50e24dcca9e',   /* Nordic UART NUS */
  ];

  /* Common network printer ports */
  const NETWORK_PRINTER_PORTS = [9100, 9101, 515, 631];

  /* Common local IP ranges to scan (first 10 hosts per subnet) */
  const LOCAL_SUBNETS = ['192.168.1', '192.168.0', '10.0.0', '172.16.0'];

  /* ── Helpers ── */
  function _cap(s) { return String(s||'').charAt(0).toUpperCase() + String(s||'').slice(1); }

  /* Match USB vendor to known name */
  function _usbVendorName(vendorId) {
    const match = USB_THERMAL_VENDORS.find(v => v.vendorId === vendorId);
    return match ? match.name : `USB-${vendorId.toString(16).toUpperCase()}`;
  }

  /* Determine driver language from USB product name */
  function _driverFromUSB(device) {
    const n = (device.productName || '').toUpperCase();
    if (['TSC','TTP','GODEX','BIXOLON','SATO'].some(k => n.includes(k))) return 'tspl';
    if (['ZEBRA','ZT','ZD','GK'].some(k => n.includes(k))) return 'zpl';
    if (['HONEYWELL','INTERMEC'].some(k => n.includes(k))) return 'cpcl';
    return 'escpos';
  }

  /* ── Bluetooth BLE Discovery ── */
  async function scanBluetooth(opts = {}) {
    const found = [];

    if (!navigator.bluetooth) {
      return { found, error: 'Web Bluetooth not available (requires Chrome/Edge on Android/Windows)' };
    }

    try {
      /* First: check already-authorised devices (no user gesture needed) */
      if (navigator.bluetooth.getDevices) {
        const known = await navigator.bluetooth.getDevices();
        for (const device of known) {
          found.push({
            id:         `ble-${device.id}`,
            name:       device.name || 'BLE Printer',
            type:       'bluetooth-ble',
            driver:     'auto',
            paperWidth: 80,
            status:     'stored',
            config: {
              deviceId:   device.id,
              deviceName: device.name,
            },
            meta: { source: 'stored', device },
          });
        }
      }

      /* If no stored devices or user requests new scan */
      if (found.length === 0 || opts.forceNew) {
        /* This REQUIRES a user gesture (button click) */
        const device = await navigator.bluetooth.requestDevice({
          acceptAllDevices: true,
          optionalServices: BLE_PRINTER_SERVICES,
        });
        if (device) {
          const existing = found.find(f => f.config.deviceId === device.id);
          if (!existing) {
            found.push({
              id:         `ble-${device.id}`,
              name:       device.name || 'BLE Printer',
              type:       'bluetooth-ble',
              driver:     'auto',
              paperWidth: 80,
              status:     'found',
              config: {
                deviceId:   device.id,
                deviceName: device.name,
              },
              meta: { source: 'scan', device },
            });
          }
        }
      }
    } catch (err) {
      if (err.name !== 'NotFoundError') {
        /* NotFoundError = user cancelled — not an error */
        return { found, error: err.message };
      }
    }

    return { found };
  }

  /* ── USB Discovery (WebUSB) ── */
  async function scanUSB(opts = {}) {
    const found = [];

    if (!navigator.usb) {
      return { found, error: 'WebUSB not available (requires Chrome/Edge on desktop)' };
    }

    try {
      /* Previously authorised devices — no gesture needed */
      const knownDevices = await navigator.usb.getDevices();
      for (const device of knownDevices) {
        const name = device.productName || _usbVendorName(device.vendorId);
        found.push({
          id:         `usb-${device.vendorId}-${device.productId}`,
          name:       name,
          type:       'usb',
          driver:     _driverFromUSB(device),
          paperWidth: 80,
          status:     'stored',
          config: {
            vendorId:  device.vendorId,
            productId: device.productId,
          },
          meta: { source: 'stored', device },
        });
      }

      /* Request new USB device */
      if (found.length === 0 || opts.forceNew) {
        const filters = USB_THERMAL_VENDORS.map(v => ({ vendorId: v.vendorId }));
        /* Also allow class 7 (printer) devices */
        filters.push({ classCode: 0x07 });
        const device = await navigator.usb.requestDevice({ filters });
        if (device) {
          const existing = found.find(f =>
            f.config.vendorId === device.vendorId && f.config.productId === device.productId
          );
          if (!existing) {
            found.push({
              id:         `usb-${device.vendorId}-${device.productId}`,
              name:       device.productName || _usbVendorName(device.vendorId),
              type:       'usb',
              driver:     _driverFromUSB(device),
              paperWidth: 80,
              status:     'found',
              config: {
                vendorId:  device.vendorId,
                productId: device.productId,
              },
              meta: { source: 'scan', device },
            });
          }
        }
      }
    } catch (err) {
      if (err.name !== 'NotFoundError') {
        return { found, error: err.message };
      }
    }

    return { found };
  }

  /* ── USB Serial Discovery (Web Serial API) ── */
  async function scanSerial(opts = {}) {
    const found = [];

    if (!navigator.serial) {
      return { found, error: 'Web Serial API not available (requires Chrome/Edge on desktop)' };
    }

    try {
      const ports = await navigator.serial.getPorts();
      ports.forEach((port, idx) => {
        const info = port.getInfo ? port.getInfo() : {};
        found.push({
          id:         `serial-${idx}`,
          name:       `Serial Printer (COM${idx + 1})`,
          type:       'usb-serial',
          driver:     'escpos',
          paperWidth: 80,
          status:     'stored',
          config: {
            portIndex: idx,
            baudRate:  115200,
            usbVendorId:  info.usbVendorId,
            usbProductId: info.usbProductId,
          },
          meta: { source: 'stored', port },
        });
      });

      if (found.length === 0 || opts.forceNew) {
        const port = await navigator.serial.requestPort({ filters: [] });
        if (port) {
          const info = port.getInfo ? port.getInfo() : {};
          found.push({
            id:         `serial-new-${Date.now()}`,
            name:       `Serial Printer`,
            type:       'usb-serial',
            driver:     'escpos',
            paperWidth: 80,
            status:     'found',
            config: {
              portIndex: found.length,
              baudRate:  115200,
              usbVendorId:  info.usbVendorId,
              usbProductId: info.usbProductId,
            },
            meta: { source: 'scan', port },
          });
        }
      }
    } catch (err) {
      if (err.name !== 'NotFoundError') {
        return { found, error: err.message };
      }
    }

    return { found };
  }

  /* ── Network/IP Discovery ── */
  async function scanNetwork(opts = {}) {
    const found = [];
    const targetHost = opts.host || null;
    const targetPort = opts.port || 9100;

    if (targetHost) {
      /* Probe a specific IP:port */
      const result = await _probeHost(targetHost, targetPort);
      if (result) found.push(result);
      return { found };
    }

    /* Scan common subnets (limited — browsers can't do raw TCP) */
    /* We probe via the local SOKONI Desktop bridge or via HTTP on port 80 */
    const localBridge = await _checkLocalBridge();
    if (localBridge) {
      /* Ask the local bridge to scan the network */
      try {
        const resp = await fetch('http://localhost:9101/scan-printers', {
          signal: AbortSignal.timeout(5000),
        });
        if (resp.ok) {
          const data = await resp.json();
          (data.printers || []).forEach(p => {
            found.push({
              id:         `net-${p.host}-${p.port}`,
              name:       p.name || `Network Printer (${p.host})`,
              type:       'network',
              driver:     'escpos',
              paperWidth: 80,
              status:     'found',
              config: { host: p.host, port: p.port || 9100 },
              meta: { source: 'bridge-scan', info: p },
            });
          });
        }
      } catch (_) {}
    }

    /* Manual IP entry always available */
    return { found, requiresManual: !localBridge };
  }

  async function _probeHost(host, port) {
    /* Can't open raw TCP from browser — use local bridge or HTTP probe */
    const localBridge = await _checkLocalBridge();
    if (localBridge) {
      try {
        const resp = await fetch(`http://localhost:9101/probe?host=${encodeURIComponent(host)}&port=${port}`, {
          signal: AbortSignal.timeout(3000),
        });
        if (resp.ok) {
          const info = await resp.json().catch(() => ({}));
          return {
            id:         `net-${host}-${port}`,
            name:       info.name || `Printer @ ${host}:${port}`,
            type:       'network',
            driver:     'escpos',
            paperWidth: info.paperWidth || 80,
            status:     'found',
            config:     { host, port },
            meta:       { source: 'probe', info },
          };
        }
      } catch (_) {}
    }

    /* No bridge — return the printer as manually-specified (not probed) */
    return {
      id:         `net-${host}-${port}`,
      name:       `Network Printer (${host})`,
      type:       'network',
      driver:     'escpos',
      paperWidth: 80,
      status:     'manual',
      config:     { host, port },
      meta:       { source: 'manual' },
    };
  }

  /* ── Android native printer enumeration ── */
  async function scanAndroid() {
    const found = [];
    if (!window.SokoniAndroid) return { found };

    try {
      const raw = window.SokoniAndroid.getPairedPrinters?.();
      if (raw) {
        const list = typeof raw === 'string' ? JSON.parse(raw) : raw;
        (list || []).forEach(p => {
          found.push({
            id:         `android-${p.address || p.name}`,
            name:       p.name || 'BT Printer',
            type:       'android',
            driver:     'escpos',
            paperWidth: p.paperWidth || 80,
            status:     'found',
            config:     { address: p.address, name: p.name },
            meta:       { source: 'android', info: p },
          });
        });
      }
    } catch (_) {}

    return { found };
  }

  /* ── Windows printer enumeration ── */
  function scanWindows() {
    const found = [];
    /* Windows shared printers can be used via window.print() with an iframe targeting the printer.
       There's no direct JS API for listing installed Windows printers in a browser.
       We add a generic "Windows Printer" entry to allow the user to use the OS print dialog. */
    found.push({
      id:         'windows-dialog',
      name:       'Windows Print Dialog',
      type:       'windows',
      driver:     'browser',
      paperWidth: 80,
      status:     'available',
      config:     {},
      meta:       { source: 'windows' },
    });
    return { found };
  }

  /* ── Local bridge probe ── */
  let _bridgeCache = null;
  async function _checkLocalBridge() {
    if (_bridgeCache !== null) return _bridgeCache;
    try {
      const resp = await fetch('http://localhost:9101/ping', { signal: AbortSignal.timeout(500) });
      _bridgeCache = resp.ok;
    } catch (_) { _bridgeCache = false; }
    return _bridgeCache;
  }

  /* ── Master scan ── */
  async function scan(types = ['bluetooth', 'usb', 'serial', 'network', 'android'], opts = {}) {
    const results = [];
    const errors  = {};
    const set     = new Set(Array.isArray(types) ? types : [types]);

    const tasks = [];
    if (set.has('bluetooth') || set.has('ble')) tasks.push(scanBluetooth(opts).then(r => { results.push(...r.found); if (r.error) errors.bluetooth = r.error; }));
    if (set.has('usb'))                         tasks.push(scanUSB(opts).then(r => { results.push(...r.found); if (r.error) errors.usb = r.error; }));
    if (set.has('serial'))                      tasks.push(scanSerial(opts).then(r => { results.push(...r.found); if (r.error) errors.serial = r.error; }));
    if (set.has('network'))                     tasks.push(scanNetwork(opts).then(r => { results.push(...r.found); if (r.error) errors.network = r.error; }));
    if (set.has('android'))                     tasks.push(scanAndroid().then(r => { results.push(...r.found); }));
    if (set.has('windows'))                     { const r = scanWindows(); results.push(...r.found); }

    await Promise.allSettled(tasks);

    /* Deduplicate by id */
    const seen = new Set();
    const unique = results.filter(p => {
      if (seen.has(p.id)) return false;
      seen.add(p.id);
      return true;
    });

    return { found: unique, errors };
  }

  /* ── Manual network printer builder ── */
  function buildNetworkPrinter(host, port = 9100, name = '') {
    return {
      id:         `net-${host}-${port}`,
      name:       name || `Network Printer (${host})`,
      type:       'network',
      driver:     'escpos',
      paperWidth: 80,
      status:     'manual',
      config:     { host, port },
      meta:       { source: 'manual' },
    };
  }

  /* ── Capability detection ── */
  function getCapabilities() {
    return {
      bluetooth: !!navigator.bluetooth,
      usb:       !!navigator.usb,
      serial:    !!navigator.serial,
      android:   !!window.SokoniAndroid,
      network:   true, /* always — even if requires bridge or CF proxy */
      windows:   typeof navigator !== 'undefined' && /Win/i.test(navigator.platform || ''),
      localBridge: _bridgeCache,
    };
  }

  return {
    scan,
    scanBluetooth,
    scanUSB,
    scanSerial,
    scanNetwork,
    scanAndroid,
    scanWindows,
    buildNetworkPrinter,
    getCapabilities,
    _checkLocalBridge,
  };
})();
