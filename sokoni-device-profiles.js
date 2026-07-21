/**
 * SOKONI Device Profile Database v1.0
 *
 * Built-in device database. Adding a new device requires only adding a new
 * profile here — no changes to drivers, managers, or application code.
 *
 * Profile schema:
 *   id            {string}   Unique identifier — stable across releases
 *   name          {string}   Human-readable display name
 *   vendor        {string}   Manufacturer name
 *   model         {string}   Model string / series
 *   type          {string}   'printer' | 'scanner' | 'drawer' | 'display' | 'scale' | 'nfc' | 'terminal' | 'biometric'
 *   subtype       {string}   Optional: 'thermal58' | 'thermal80' | 'label' | 'keyboard' | 'laser' ...
 *   driver        {string}   Driver ID this profile targets
 *   protocol      {string}   'escpos' | 'starprnt' | 'zpl' | 'tspl' | 'cpcl' | 'hid' | 'serial-ascii' | 'cloud'
 *   usb           {object}   USB detection fingerprint
 *   bluetooth     {object}   Bluetooth detection fingerprint
 *   serial        {object}   Serial detection fingerprint
 *   network       {object}   Network defaults
 *   capabilities  {object}   Device capability flags and values
 *   connection    {object}   Per-transport connection tuning
 *   commands      {object}   Protocol command overrides (null = use driver default)
 */

(function (global) {
    'use strict';

    // ─── Common BLE service/characteristic UUIDs ───────────────────────────────

    var BLE = {
        SVC: {
            GENERIC_ESCPOS: '000018f0-0000-1000-8000-00805f9b34fb',
            P58E_PRIMARY:   '0000ff00-0000-1000-8000-00805f9b34fb',
            EPSON_MOBILE:   'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
            MICROCHIP:      '49535343-fe7d-4ae5-8fa9-9fafd205e455',
            NORDIC_UART:    '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
            HM10:           '0000ffe0-0000-1000-8000-00805f9b34fb',
            STAR:           '00001101-0000-1000-8000-00805f9b34fb',
            HONEYWELL_SCAN: '00001101-0000-1000-8000-00805f9b34fb',
        },
        CHR: {
            P58E_WRITE:     '0000ff02-0000-1000-8000-00805f9b34fb',
            GENERIC_WRITE:  '00002af1-0000-1000-8000-00805f9b34fb',
            EPSON_WRITE:    'bef8d6c9-92a3-4e29-9f6a-d2cc7e0fc3d1',
            MICROCHIP_WRITE:'49535343-8841-43f4-a8d4-ecbe34729bb3',
            NORDIC_TX:      '6e400002-b5a3-f393-e0a9-e50e24dcca9e',
            HM10_WRITE:     '0000ffe1-0000-1000-8000-00805f9b34fb',
        },
        ALL_SERVICES:    [], // populated below
        ALL_WRITE_CHARS: [], // populated below
    };
    BLE.ALL_SERVICES    = Object.values(BLE.SVC);
    BLE.ALL_WRITE_CHARS = Object.values(BLE.CHR);

    // ─── Common ESC/POS commands ───────────────────────────────────────────────

    var ESCPOS_CMDS = {
        init:       [0x1B, 0x40],
        cut:        [0x1D, 0x56, 0x42, 0x00],
        partialCut: [0x1D, 0x56, 0x42, 0x01],
        drawer2:    [0x1B, 0x70, 0x00, 0x19, 0xFA],
        drawer5:    [0x1B, 0x70, 0x01, 0x19, 0xFA],
    };

    var STAR_CMDS = {
        init:       [0x1B, 0x40],
        cut:        [0x1B, 0x64, 0x02],          // StarPRNT cut
        partialCut: [0x1B, 0x64, 0x03],
        drawer2:    [0x07],                        // Star BEL kick
        drawer5:    [0x1A, 0x07],
    };

    // ─── Standard capability templates ────────────────────────────────────────

    var CAPS_THERMAL_58 = {
        paperWidth:  '58mm',
        maxColumns:  32,
        dpi:         203,
        encoding:    'cp437',
        images:      true,
        imageWidth:  384,
        qr:          true,
        barcodes:    ['CODE128', 'EAN13', 'EAN8', 'CODE39', 'ITF', 'UPCA'],
        cutter:      true,
        partialCut:  false,
        drawer:      true,
        buzzer:      false,
        color:       false,
    };

    var CAPS_THERMAL_80 = Object.assign({}, CAPS_THERMAL_58, {
        paperWidth: '80mm',
        maxColumns: 48,
        imageWidth: 576,
        partialCut: true,
        barcodes:   ['CODE128', 'EAN13', 'EAN8', 'CODE39', 'ITF', 'CODABAR', 'CODE93', 'UPCA'],
    });

    // ─── Standard connection settings ─────────────────────────────────────────

    var CONN_THERMAL_58 = {
        usb:       { chunkSize: 512,  delayMs: 0  },
        bluetooth: { chunkSize: 128,  delayMs: 20, useResponse: false },
        serial:    { baudRate: 115200, bufferSize: 4096 },
        network:   { port: 9100, timeout: 5000 },
    };

    var CONN_THERMAL_80 = Object.assign({}, CONN_THERMAL_58, {
        usb: { chunkSize: 512, delayMs: 0 },
    });

    // =========================================================================
    // PRINTER PROFILES
    // =========================================================================

    var PRINTERS = {

        // ── P58E (Generic 58mm ESC/POS — covers dozens of Chinese OEM printers)
        P58E: {
            id: 'P58E', name: 'P58E', vendor: 'Generic', model: 'P58E',
            type: 'printer', subtype: 'thermal58',
            driver: 'escpos-printer', protocol: 'escpos',
            usb: {
                vendorIds: [0x154F, 0x0FE6, 0x1FC9, 0x1B5F, 0x067B, 0x0403, 0x10C4, 0x1A86, 0x0DD4],
                classCode: 7,
            },
            bluetooth: {
                namePatterns: [/^P58/i, /^HOP/i, /^PTP/i, /^MTP/i, /^iPosPrinter$/i, /^BlueTooth Printer$/i],
                services:     [BLE.SVC.P58E_PRIMARY, BLE.SVC.GENERIC_ESCPOS, BLE.SVC.EPSON_MOBILE, BLE.SVC.MICROCHIP, BLE.SVC.NORDIC_UART, BLE.SVC.HM10],
                writeChars:   [BLE.CHR.P58E_WRITE, BLE.CHR.GENERIC_WRITE, BLE.CHR.EPSON_WRITE, BLE.CHR.MICROCHIP_WRITE, BLE.CHR.NORDIC_TX, BLE.CHR.HM10_WRITE],
            },
            serial: { baudRates: [115200, 9600] },
            network: { defaultPort: 9100 },
            capabilities: Object.assign({}, CAPS_THERMAL_58),
            connection:   Object.assign({}, CONN_THERMAL_58),
            commands:     ESCPOS_CMDS,
        },

        // ── XP-58 / XP-80 (Xprinter — common in Kenya/EA market)
        XP_58: {
            id: 'XP_58', name: 'Xprinter XP-58', vendor: 'Xprinter', model: 'XP-58',
            type: 'printer', subtype: 'thermal58',
            driver: 'escpos-printer', protocol: 'escpos',
            usb: { vendorIds: [0x154F], productIds: [0x0001, 0x0002, 0x0003, 0x0004, 0x0500], classCode: 7 },
            bluetooth: {
                namePatterns: [/^XP-58/i, /^Xprinter.*58/i, /^XPrinter/i],
                services:     [BLE.SVC.P58E_PRIMARY, BLE.SVC.GENERIC_ESCPOS],
                writeChars:   [BLE.CHR.P58E_WRITE, BLE.CHR.GENERIC_WRITE],
            },
            serial: { baudRates: [115200] },
            network: { defaultPort: 9100 },
            capabilities: Object.assign({}, CAPS_THERMAL_58),
            connection:   Object.assign({}, CONN_THERMAL_58),
            commands:     ESCPOS_CMDS,
        },

        XP_80: {
            id: 'XP_80', name: 'Xprinter XP-80', vendor: 'Xprinter', model: 'XP-80',
            type: 'printer', subtype: 'thermal80',
            driver: 'escpos-printer', protocol: 'escpos',
            usb: { vendorIds: [0x154F], productIds: [0x0501, 0x0502, 0x0503], classCode: 7 },
            bluetooth: {
                namePatterns: [/^XP-80/i, /^Xprinter.*80/i],
                services:     [BLE.SVC.P58E_PRIMARY, BLE.SVC.GENERIC_ESCPOS],
                writeChars:   [BLE.CHR.P58E_WRITE, BLE.CHR.GENERIC_WRITE],
            },
            serial: { baudRates: [115200] },
            network: { defaultPort: 9100 },
            capabilities: Object.assign({}, CAPS_THERMAL_80),
            connection:   Object.assign({}, CONN_THERMAL_80),
            commands:     ESCPOS_CMDS,
        },

        // ── Rongta (popular 58mm + 80mm)
        RONGTA_58: {
            id: 'RONGTA_58', name: 'Rongta RP58', vendor: 'Rongta', model: 'RP58',
            type: 'printer', subtype: 'thermal58',
            driver: 'escpos-printer', protocol: 'escpos',
            usb: { vendorIds: [0x2080], classCode: 7 },
            bluetooth: {
                namePatterns: [/^RP-?58/i, /^Rongta.*58/i, /^RPP300/i],
                services:     [BLE.SVC.GENERIC_ESCPOS, BLE.SVC.P58E_PRIMARY],
                writeChars:   [BLE.CHR.GENERIC_WRITE, BLE.CHR.P58E_WRITE],
            },
            serial: { baudRates: [115200, 9600] },
            network: { defaultPort: 9100 },
            capabilities: Object.assign({}, CAPS_THERMAL_58),
            connection:   Object.assign({}, CONN_THERMAL_58),
            commands:     ESCPOS_CMDS,
        },

        RONGTA_80: {
            id: 'RONGTA_80', name: 'Rongta RP80', vendor: 'Rongta', model: 'RP80',
            type: 'printer', subtype: 'thermal80',
            driver: 'escpos-printer', protocol: 'escpos',
            usb: { vendorIds: [0x2080], classCode: 7 },
            bluetooth: {
                namePatterns: [/^RP-?80/i, /^Rongta.*80/i, /^RPP350/i],
                services:     [BLE.SVC.GENERIC_ESCPOS],
                writeChars:   [BLE.CHR.GENERIC_WRITE],
            },
            serial: { baudRates: [115200] },
            network: { defaultPort: 9100 },
            capabilities: Object.assign({}, CAPS_THERMAL_80),
            connection:   Object.assign({}, CONN_THERMAL_80),
            commands:     ESCPOS_CMDS,
        },

        // ── Sunmi (Android-first but also USB)
        SUNMI_T2: {
            id: 'SUNMI_T2', name: 'Sunmi T2', vendor: 'Sunmi', model: 'T2',
            type: 'printer', subtype: 'thermal80',
            driver: 'escpos-printer', protocol: 'escpos',
            usb: { vendorIds: [0x0FE6, 0x2B4E], classCode: 7 },
            bluetooth: {
                namePatterns: [/^SUNMI/i, /^T2$/i],
                services:     [BLE.SVC.GENERIC_ESCPOS],
                writeChars:   [BLE.CHR.GENERIC_WRITE],
            },
            network: { defaultPort: 9100 },
            capabilities: Object.assign({}, CAPS_THERMAL_80, { images: true }),
            connection:   Object.assign({}, CONN_THERMAL_80),
            commands:     ESCPOS_CMDS,
        },

        // ── Epson (canonical ESC/POS)
        EPSON_TM_T20: {
            id: 'EPSON_TM_T20', name: 'Epson TM-T20III', vendor: 'Epson', model: 'TM-T20III',
            type: 'printer', subtype: 'thermal80',
            driver: 'escpos-printer', protocol: 'escpos',
            usb: {
                vendorIds:  [0x04B8],
                productIds: [0x0202, 0x0203, 0x0204, 0x0205, 0x0206, 0x0207, 0x0232],
                classCode:  7,
            },
            bluetooth: {
                namePatterns: [/^TM-T20/i, /^EPSON TM-T20/i],
                services:     [BLE.SVC.EPSON_MOBILE, BLE.SVC.GENERIC_ESCPOS],
                writeChars:   [BLE.CHR.EPSON_WRITE, BLE.CHR.GENERIC_WRITE],
            },
            serial: { baudRates: [115200, 38400] },
            network: { defaultPort: 9100 },
            capabilities: Object.assign({}, CAPS_THERMAL_80, {
                partialCut: true,
                barcodes:   ['CODE128', 'EAN13', 'EAN8', 'CODE39', 'ITF', 'CODABAR', 'CODE93', 'UPCA', 'PDF417'],
            }),
            connection: Object.assign({}, CONN_THERMAL_80),
            commands:   ESCPOS_CMDS,
        },

        EPSON_TM_T88: {
            id: 'EPSON_TM_T88', name: 'Epson TM-T88VII', vendor: 'Epson', model: 'TM-T88VII',
            type: 'printer', subtype: 'thermal80',
            driver: 'escpos-printer', protocol: 'escpos',
            usb: {
                vendorIds:  [0x04B8],
                productIds: [0x0101, 0x0102, 0x0103, 0x0104, 0x0105, 0x0202],
                classCode:  7,
            },
            bluetooth: {
                namePatterns: [/^TM-T88/i, /^EPSON TM-T88/i],
                services:     [BLE.SVC.EPSON_MOBILE],
                writeChars:   [BLE.CHR.EPSON_WRITE],
            },
            serial: { baudRates: [115200] },
            network: { defaultPort: 9100 },
            capabilities: Object.assign({}, CAPS_THERMAL_80, {
                partialCut: true,
                buzzer: true,
                density: 100,
            }),
            connection: Object.assign({}, CONN_THERMAL_80),
            commands:   ESCPOS_CMDS,
        },

        // ── Star Micronics (StarPRNT protocol)
        STAR_TSP100: {
            id: 'STAR_TSP100', name: 'Star TSP100', vendor: 'Star Micronics', model: 'TSP143III',
            type: 'printer', subtype: 'thermal80',
            driver: 'star-printer', protocol: 'starprnt',
            usb: { vendorIds: [0x0519], productIds: [0x0001, 0x0003, 0x0007, 0x000B], classCode: 7 },
            bluetooth: {
                namePatterns: [/^TSP100/i, /^mPOP/i, /^Star TSP/i],
                services:     [BLE.SVC.STAR],
                writeChars:   [],
            },
            serial: { baudRates: [115200, 9600] },
            network: { defaultPort: 9100 },
            capabilities: Object.assign({}, CAPS_THERMAL_80, { partialCut: true }),
            connection: Object.assign({}, CONN_THERMAL_80),
            commands:   STAR_CMDS,
        },

        // ── Zebra (ZPL — labels and wristbands)
        ZEBRA_ZD220: {
            id: 'ZEBRA_ZD220', name: 'Zebra ZD220', vendor: 'Zebra', model: 'ZD220',
            type: 'printer', subtype: 'label',
            driver: 'zpl-printer', protocol: 'zpl',
            usb: { vendorIds: [0x0A5F], classCode: 7 },
            bluetooth: {
                namePatterns: [/^Zebra/i, /^ZD220/i, /^ZT/i],
                services:     [BLE.SVC.GENERIC_ESCPOS],
                writeChars:   [BLE.CHR.GENERIC_WRITE],
            },
            network: { defaultPort: 9100 },
            capabilities: {
                paperWidth: '104mm', maxColumns: 0, dpi: 203,
                encoding: 'utf8', images: true, imageWidth: 832,
                qr: true, barcodes: ['CODE128', 'EAN13', 'QR', 'PDF417', 'DATAMATRIX'],
                cutter: false, partialCut: false, drawer: false,
            },
            connection: Object.assign({}, CONN_THERMAL_80),
            commands: { init: '', cut: '^XZ', label: '^XA%s^XZ' },
        },

        // ── Bixolon
        BIXOLON_SRP350: {
            id: 'BIXOLON_SRP350', name: 'Bixolon SRP-350V', vendor: 'Bixolon', model: 'SRP-350V',
            type: 'printer', subtype: 'thermal80',
            driver: 'escpos-printer', protocol: 'escpos',
            usb: { vendorIds: [0x1504], classCode: 7 },
            bluetooth: {
                namePatterns: [/^SRP-?350/i, /^Bixolon/i],
                services:     [BLE.SVC.GENERIC_ESCPOS],
                writeChars:   [BLE.CHR.GENERIC_WRITE],
            },
            serial: { baudRates: [115200] },
            network: { defaultPort: 9100 },
            capabilities: Object.assign({}, CAPS_THERMAL_80, { partialCut: true }),
            connection: Object.assign({}, CONN_THERMAL_80),
            commands:   ESCPOS_CMDS,
        },

        // ── Generic fallbacks
        GENERIC_58: {
            id: 'GENERIC_58', name: 'Generic 58mm Printer', vendor: 'Unknown', model: 'Generic 58mm',
            type: 'printer', subtype: 'thermal58',
            driver: 'escpos-printer', protocol: 'escpos',
            usb: { vendorIds: [], classCode: 7 },
            bluetooth: { namePatterns: [/printer/i, /thermal/i, /pos/i, /receipt/i], services: BLE.ALL_SERVICES, writeChars: BLE.ALL_WRITE_CHARS },
            serial: { baudRates: [115200, 9600, 19200, 38400] },
            network: { defaultPort: 9100 },
            capabilities: Object.assign({}, CAPS_THERMAL_58),
            connection:   Object.assign({}, CONN_THERMAL_58),
            commands:     ESCPOS_CMDS,
        },

        GENERIC_80: {
            id: 'GENERIC_80', name: 'Generic 80mm Printer', vendor: 'Unknown', model: 'Generic 80mm',
            type: 'printer', subtype: 'thermal80',
            driver: 'escpos-printer', protocol: 'escpos',
            usb: { vendorIds: [], classCode: 7 },
            bluetooth: { namePatterns: [/printer/i, /thermal/i], services: BLE.ALL_SERVICES, writeChars: BLE.ALL_WRITE_CHARS },
            serial: { baudRates: [115200] },
            network: { defaultPort: 9100 },
            capabilities: Object.assign({}, CAPS_THERMAL_80),
            connection:   Object.assign({}, CONN_THERMAL_80),
            commands:     ESCPOS_CMDS,
        },
    };

    // =========================================================================
    // SCANNER PROFILES
    // =========================================================================

    var SCANNERS = {

        HONEYWELL_VOYAGER: {
            id: 'HONEYWELL_VOYAGER', name: 'Honeywell Voyager 1202g', vendor: 'Honeywell', model: 'Voyager 1202g',
            type: 'scanner', subtype: 'barcode',
            driver: 'hid-scanner', protocol: 'hid',
            usb: { vendorIds: [0x0C2E], productIds: [0x0200, 0x0201, 0x0205, 0x0206], classCode: 3 },
            bluetooth: {
                namePatterns: [/^Voyager/i, /^Honeywell/i],
                services:     [BLE.SVC.HONEYWELL_SCAN],
                writeChars:   [],
            },
            capabilities: { symbologies: ['CODE128', 'EAN13', 'EAN8', 'CODE39', 'QR', 'PDF417', 'DATAMATRIX', 'AZTEC'], wireless: true },
            connection: { usb: { chunkSize: 64, delayMs: 0 }, bluetooth: { chunkSize: 64, delayMs: 0 } },
            commands: null,
        },

        DATALOGIC_GRYPHON: {
            id: 'DATALOGIC_GRYPHON', name: 'Datalogic Gryphon I GD4400', vendor: 'Datalogic', model: 'Gryphon I GD4400',
            type: 'scanner', subtype: 'barcode',
            driver: 'hid-scanner', protocol: 'hid',
            usb: { vendorIds: [0x05F9, 0x0483], classCode: 3 },
            bluetooth: { namePatterns: [/^Gryphon/i, /^Datalogic/i], services: [], writeChars: [] },
            capabilities: { symbologies: ['CODE128', 'EAN13', 'QR', 'PDF417'], wireless: false },
            connection: { usb: { chunkSize: 64, delayMs: 0 } },
            commands: null,
        },

        ZEBRA_LS2208: {
            id: 'ZEBRA_LS2208', name: 'Zebra LS2208', vendor: 'Zebra', model: 'LS2208',
            type: 'scanner', subtype: 'laser',
            driver: 'hid-scanner', protocol: 'hid',
            usb: { vendorIds: [0x05E0], productIds: [0x1200, 0x1300, 0x1900], classCode: 3 },
            bluetooth: { namePatterns: [/^LS2208/i, /^Zebra.*LS/i], services: [], writeChars: [] },
            capabilities: { symbologies: ['CODE128', 'EAN13', 'EAN8', 'CODE39', 'UPCA'], wireless: false },
            connection: { usb: { chunkSize: 64, delayMs: 0 } },
            commands: null,
        },

        KEYBOARD_WEDGE: {
            id: 'KEYBOARD_WEDGE', name: 'Keyboard Wedge Scanner', vendor: 'Generic', model: 'HID Keyboard',
            type: 'scanner', subtype: 'keyboard-wedge',
            driver: 'keyboard-scanner', protocol: 'keyboard',
            usb: { vendorIds: [], classCode: 3 },
            bluetooth: { namePatterns: [/scanner/i, /barcode/i], services: [], writeChars: [] },
            capabilities: { symbologies: ['all'], wireless: false },
            connection: { usb: { chunkSize: 64, delayMs: 0 } },
            commands: null,
        },
    };

    // =========================================================================
    // CASH DRAWER PROFILES
    // =========================================================================

    var DRAWERS = {

        APG_VASARIO: {
            id: 'APG_VASARIO', name: 'APG Vasario', vendor: 'APG', model: 'Vasario 1616',
            type: 'drawer', subtype: 'electric',
            driver: 'escpos-drawer', protocol: 'escpos',
            usb: { vendorIds: [0x0425], classCode: 7 },
            capabilities: { pins: [2, 5], sensorPort: true },
            connection: { usb: { chunkSize: 64, delayMs: 0 }, serial: { baudRate: 9600 } },
            commands: { kick2: [0x1B, 0x70, 0x00, 0x19, 0xFA], kick5: [0x1B, 0x70, 0x01, 0x19, 0xFA] },
        },

        MMF_225: {
            id: 'MMF_225', name: 'MMF Val-u Line', vendor: 'MMF', model: '226-1116-XX',
            type: 'drawer', subtype: 'electric',
            driver: 'escpos-drawer', protocol: 'escpos',
            usb: { vendorIds: [], classCode: 7 },
            capabilities: { pins: [2, 5], sensorPort: false },
            connection: { usb: { chunkSize: 64, delayMs: 0 } },
            commands: { kick2: [0x1B, 0x70, 0x00, 0x19, 0xFA], kick5: [0x1B, 0x70, 0x01, 0x19, 0xFA] },
        },

        PRINTER_DRAWER: {
            id: 'PRINTER_DRAWER', name: 'Drawer via Printer Port', vendor: 'Generic', model: 'Via ESC/POS Printer',
            type: 'drawer', subtype: 'via-printer',
            driver: 'printer-drawer', protocol: 'escpos',
            usb: { vendorIds: [], classCode: 7 },
            capabilities: { pins: [2, 5] },
            connection: {},
            commands: { kick2: [0x1B, 0x70, 0x00, 0x19, 0xFA], kick5: [0x1B, 0x70, 0x01, 0x19, 0xFA] },
        },
    };

    // =========================================================================
    // NFC / RFID PROFILES
    // =========================================================================

    var NFC_READERS = {

        ACR122U: {
            id: 'ACR122U', name: 'ACS ACR122U', vendor: 'Advanced Card Systems', model: 'ACR122U',
            type: 'nfc', subtype: 'pcsc',
            driver: 'hid-nfc', protocol: 'hid',
            usb: { vendorIds: [0x072F], productIds: [0x2200, 0x2201], classCode: 3 },
            capabilities: { protocols: ['ISO14443A', 'ISO14443B', 'ISO18092'], readRange: '5cm' },
            connection: { usb: { chunkSize: 64, delayMs: 0 } },
            commands: null,
        },

        WEB_NFC: {
            id: 'WEB_NFC', name: 'Device NFC (Web NFC)', vendor: 'Platform', model: 'NDEFReader',
            type: 'nfc', subtype: 'web-nfc',
            driver: 'web-nfc', protocol: 'ndef',
            usb: null,
            capabilities: { protocols: ['NDEF'], readRange: '4cm' },
            connection: {},
            commands: null,
        },
    };

    // =========================================================================
    // SCALE PROFILES
    // =========================================================================

    var SCALES = {

        OHAUS_RANGER: {
            id: 'OHAUS_RANGER', name: 'Ohaus Ranger 3000', vendor: 'Ohaus', model: 'Ranger 3000',
            type: 'scale', subtype: 'retail',
            driver: 'serial-scale', protocol: 'serial-ascii',
            usb: { vendorIds: [], classCode: 0 },
            serial: { baudRate: 9600, dataBits: 8, stopBits: 1, parity: 'none' },
            capabilities: { maxCapacityKg: 15, resolution: '0.001kg', units: ['kg', 'g', 'lb'] },
            connection: { serial: { baudRate: 9600 } },
            commands: { tare: 'T\r\n', read: 'P\r\n', zero: 'Z\r\n' },
        },

        CAS_SW1: {
            id: 'CAS_SW1', name: 'CAS SW-1', vendor: 'CAS', model: 'SW-1',
            type: 'scale', subtype: 'retail',
            driver: 'serial-scale', protocol: 'serial-ascii',
            usb: { vendorIds: [], classCode: 0 },
            serial: { baudRate: 9600, dataBits: 7, stopBits: 1, parity: 'even' },
            capabilities: { maxCapacityKg: 30, resolution: '0.005kg', units: ['kg', 'g'] },
            connection: { serial: { baudRate: 9600 } },
            commands: { tare: '\x05', read: '\x05', zero: '\x5A' },
        },
    };

    // =========================================================================
    // CUSTOMER DISPLAY PROFILES
    // =========================================================================

    var DISPLAYS = {

        EPSON_DM_D110: {
            id: 'EPSON_DM_D110', name: 'Epson DM-D110', vendor: 'Epson', model: 'DM-D110',
            type: 'display', subtype: 'vfd',
            driver: 'serial-display', protocol: 'serial-ascii',
            usb: { vendorIds: [0x04B8], classCode: 0 },
            serial: { baudRate: 9600 },
            capabilities: { rows: 2, columns: 20, charset: 'ascii' },
            connection: { serial: { baudRate: 9600 } },
            commands: { clear: '\x0C', cursor: '\x1B\x5B', write: null },
        },

        GENERIC_VFD: {
            id: 'GENERIC_VFD', name: 'Generic 2×20 VFD', vendor: 'Generic', model: '2x20 Customer Display',
            type: 'display', subtype: 'vfd',
            driver: 'serial-display', protocol: 'serial-ascii',
            usb: { vendorIds: [], classCode: 0 },
            serial: { baudRate: 9600 },
            capabilities: { rows: 2, columns: 20 },
            connection: { serial: { baudRate: 9600 } },
            commands: { clear: '\x0C', write: null },
        },
    };

    // =========================================================================
    // PAYMENT TERMINAL PROFILES
    // =========================================================================

    var TERMINALS = {

        INTASEND: {
            id: 'INTASEND', name: 'IntaSend (M-Pesa + Cards)', vendor: 'IntaSend', model: 'Cloud SDK',
            type: 'terminal', subtype: 'cloud',
            driver: 'intasend-terminal', protocol: 'cloud',
            usb: null, bluetooth: null, serial: null,
            network: { endpoint: 'https://sandbox.intasend.com' },
            capabilities: { methods: ['mpesa', 'card', 'bank'], currencies: ['KES'], online: true },
            connection: { network: { timeout: 30000 } },
            commands: null,
        },

        INGENICO_ICT: {
            id: 'INGENICO_ICT', name: 'Ingenico ICT 250', vendor: 'Ingenico', model: 'ICT 250',
            type: 'terminal', subtype: 'hardware',
            driver: 'ingenico-terminal', protocol: 'network',
            usb: { vendorIds: [0x0603] },
            bluetooth: { namePatterns: [/^iCT/i, /^Ingenico/i], services: [], writeChars: [] },
            network: { defaultPort: 8080 },
            capabilities: { methods: ['chip', 'swipe', 'contactless'], currencies: ['KES', 'USD'] },
            connection: { network: { port: 8080, timeout: 30000 } },
            commands: null,
        },

        VERIFONE_P400: {
            id: 'VERIFONE_P400', name: 'Verifone P400', vendor: 'Verifone', model: 'P400',
            type: 'terminal', subtype: 'hardware',
            driver: 'verifone-terminal', protocol: 'network',
            usb: { vendorIds: [0x16AE] },
            bluetooth: { namePatterns: [/^P400/i, /^Verifone/i], services: [], writeChars: [] },
            network: { defaultPort: 8080 },
            capabilities: { methods: ['chip', 'swipe', 'contactless'], currencies: ['KES'] },
            connection: { network: { port: 8080, timeout: 30000 } },
            commands: null,
        },

        PAX_A920: {
            id: 'PAX_A920', name: 'PAX A920', vendor: 'PAX Technology', model: 'A920',
            type: 'terminal', subtype: 'hardware',
            driver: 'pax-terminal', protocol: 'network',
            usb: { vendorIds: [0x1220] },
            network: { defaultPort: 8080 },
            capabilities: { methods: ['chip', 'swipe', 'contactless', 'qr'], built_in_printer: true },
            connection: { network: { port: 8080, timeout: 30000 } },
            commands: null,
        },
    };

    // =========================================================================
    // BIOMETRIC PROFILES
    // =========================================================================

    var BIOMETRICS = {

        WEBAUTHN_PLATFORM: {
            id: 'WEBAUTHN_PLATFORM', name: 'Device Biometric', vendor: 'Platform', model: 'WebAuthn',
            type: 'biometric', subtype: 'webauthn',
            driver: 'webauthn-biometric', protocol: 'webauthn',
            usb: null, bluetooth: null,
            capabilities: { methods: ['fingerprint', 'face', 'pin'] },
            connection: {},
            commands: null,
        },
    };

    // =========================================================================
    // Master profile map
    // =========================================================================

    var ALL_PROFILES = Object.assign({}, PRINTERS, SCANNERS, DRAWERS, NFC_READERS, SCALES, DISPLAYS, TERMINALS, BIOMETRICS);

    // =========================================================================
    // Profile lookup helpers
    // =========================================================================

    function findByUSBDevice(device) {
        var vid = device.vendorId;
        var pid = device.productId;

        for (var id in ALL_PROFILES) {
            var p = ALL_PROFILES[id];
            if (!p.usb) continue;

            var vids = p.usb.vendorIds || [];
            var pids = p.usb.productIds;

            if (vids.length && !vids.includes(vid)) continue;
            if (pids && pids.length && !pids.includes(pid)) continue;

            // Exact VID match (non-generic)
            if (vids.length && vids.includes(vid)) return p;
        }

        // Class-code fallback: USB printer class 7
        if (device.configuration) {
            var isClass7 = device.configuration.interfaces.some(function (intf) {
                return intf.alternates.some(function (alt) { return alt.interfaceClass === 7; });
            });
            if (isClass7) return ALL_PROFILES.GENERIC_58;
        }

        return null;
    }

    function findByBLEDevice(device) {
        var name = (device.name || '').trim();
        if (!name) return ALL_PROFILES.GENERIC_58;

        for (var id in ALL_PROFILES) {
            var p = ALL_PROFILES[id];
            if (!p.bluetooth || !p.bluetooth.namePatterns) continue;
            if (p.id === 'GENERIC_58' || p.id === 'GENERIC_80') continue; // check generics last

            for (var i = 0; i < p.bluetooth.namePatterns.length; i++) {
                if (p.bluetooth.namePatterns[i].test(name)) return p;
            }
        }

        // Pattern-based fallback for anything printer-like
        if (/printer|thermal|pos|receipt|esc/i.test(name)) return ALL_PROFILES.GENERIC_58;
        return null;
    }

    function findBySerialPort(portInfo) {
        var vid = portInfo && portInfo.usbVendorId;
        var pid = portInfo && portInfo.usbProductId;
        if (!vid) return ALL_PROFILES.GENERIC_58;

        for (var id in ALL_PROFILES) {
            var p = ALL_PROFILES[id];
            if (!p.usb || !p.usb.vendorIds) continue;
            var vids = p.usb.vendorIds;
            if (vids.includes(vid)) {
                if (!pid) return p;
                var pids = p.usb.productIds;
                if (!pids || !pids.length || pids.includes(pid)) return p;
            }
        }
        return ALL_PROFILES.GENERIC_58;
    }

    function getProfilesForType(type) {
        return Object.values(ALL_PROFILES).filter(function (p) { return p.type === type; });
    }

    function getProfileById(id) {
        return ALL_PROFILES[id] || null;
    }

    // =========================================================================
    // Export
    // =========================================================================

    global.SokoniDeviceProfiles = Object.freeze({
        ALL:        ALL_PROFILES,
        PRINTERS:   PRINTERS,
        SCANNERS:   SCANNERS,
        DRAWERS:    DRAWERS,
        NFC:        NFC_READERS,
        SCALES:     SCALES,
        DISPLAYS:   DISPLAYS,
        TERMINALS:  TERMINALS,
        BIOMETRICS: BIOMETRICS,
        BLE:        BLE,
        findByUSBDevice:    findByUSBDevice,
        findByBLEDevice:    findByBLEDevice,
        findBySerialPort:   findBySerialPort,
        getProfilesForType: getProfilesForType,
        getProfileById:     getProfileById,
    });

})(window);
