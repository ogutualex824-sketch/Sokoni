/**
 * SOKONI Printer Driver v1.0
 *
 * Universal ESC/POS + StarPRNT + ZPL printer driver.
 * Registered with SokoniDriverManager as:
 *   'escpos-printer'   — all ESC/POS printers (P58E, Xprinter, Rongta, Sunmi, Epson, Bixolon, generic)
 *   'star-printer'     — Star Micronics StarPRNT
 *   'zpl-printer'      — Zebra ZPL label printers
 *
 * Commands dispatched via execute(command, data):
 *   'print'            data: { lines: [{text, align, bold, size}] } | {raw: Uint8Array}
 *   'testReceipt'      data: {storeName, receiptNo} (optional)
 *   'openDrawer'       data: {pin: 2|5}
 *   'feedLines'        data: {lines: number}
 *   'cut'              data: {partial: boolean}
 *   'beep'             data: {count: number}
 *   'status'           (alias for status())
 */

(function (global) {
    'use strict';

    var DB   = function () { return global.SokoniDriverBase; };
    var WAIT = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

    // ─── ESC/POS command table ─────────────────────────────────────────────────
    var ESCPOS = {
        INIT:        [0x1B, 0x40],
        LF:          [0x0A],
        FEED:        function (n) { return [0x1B, 0x64, n]; },
        CUT_FULL:    [0x1D, 0x56, 0x42, 0x00],
        CUT_PARTIAL: [0x1D, 0x56, 0x42, 0x01],
        ALIGN_L:     [0x1B, 0x61, 0x00],
        ALIGN_C:     [0x1B, 0x61, 0x01],
        ALIGN_R:     [0x1B, 0x61, 0x02],
        BOLD_ON:     [0x1B, 0x45, 0x01],
        BOLD_OFF:    [0x1B, 0x45, 0x00],
        SIZE_NORMAL: [0x1D, 0x21, 0x00],
        SIZE_DH:     [0x1D, 0x21, 0x01],   // Double height
        SIZE_DW:     [0x1D, 0x21, 0x10],   // Double width
        SIZE_DOUBLE: [0x1D, 0x21, 0x11],   // Double height + width
        UNDERLINE_ON: [0x1B, 0x2D, 0x01],
        UNDERLINE_OFF:[0x1B, 0x2D, 0x00],
        DRAWER_2:    [0x1B, 0x70, 0x00, 0x19, 0xFA],
        DRAWER_5:    [0x1B, 0x70, 0x01, 0x19, 0xFA],
        BEEP:        [0x1B, 0x42, 0x01, 0x01],
        BUZZER_ON:   [0x1B, 0x42, 0x03, 0x02],
        // QR code (model 2)
        QR_MODEL:    [0x1D, 0x28, 0x6B, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00],
        QR_SIZE:     function (s) { return [0x1D, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x43, s]; },
        QR_EC:       [0x1D, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x45, 0x31],
        QR_STORE:    function (d) {
            var len = d.length + 3;
            return [0x1D, 0x28, 0x6B, len & 0xFF, (len >> 8) & 0xFF, 0x31, 0x50, 0x30].concat(Array.from(d));
        },
        QR_PRINT:    [0x1D, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x51, 0x30],
    };

    // StarPRNT command table
    var STARPRNT = {
        INIT:        [0x1B, 0x40],
        LF:          [0x0A],
        FEED:        function (n) { return [0x1B, 0x64, n]; },
        CUT_FULL:    [0x1B, 0x64, 0x02],
        CUT_PARTIAL: [0x1B, 0x64, 0x03],
        ALIGN_L:     [0x1B, 0x1D, 0x61, 0x00],
        ALIGN_C:     [0x1B, 0x1D, 0x61, 0x01],
        ALIGN_R:     [0x1B, 0x1D, 0x61, 0x02],
        BOLD_ON:     [0x1B, 0x45],
        BOLD_OFF:    [0x1B, 0x46],
        SIZE_NORMAL: [0x1B, 0x69, 0x00, 0x00],
        SIZE_DOUBLE: [0x1B, 0x69, 0x01, 0x01],
        DRAWER_2:    [0x07],
        DRAWER_5:    [0x1A, 0x07],
    };

    // ─── Byte encoding ─────────────────────────────────────────────────────────

    function _encode(str) {
        // Best-effort ASCII encoding for thermal printers; CP437 extensions not covered
        var bytes = [];
        for (var i = 0; i < str.length; i++) {
            var c = str.charCodeAt(i);
            bytes.push(c < 256 ? c : 0x3F); // '?' for out-of-range
        }
        return bytes;
    }

    function _concat() {
        var arrays = Array.prototype.slice.call(arguments);
        var total  = 0;
        var i;
        for (i = 0; i < arrays.length; i++) total += arrays[i].length;
        var result = new Uint8Array(total);
        var offset = 0;
        for (i = 0; i < arrays.length; i++) {
            result.set(arrays[i] instanceof Array ? new Uint8Array(arrays[i]) : arrays[i], offset);
            offset += arrays[i].length;
        }
        return result;
    }

    // ─── Receipt builder ───────────────────────────────────────────────────────

    function ReceiptBuilder(cmds, profile) {
        this._cmds    = cmds;
        this._profile = profile;
        this._parts   = [];
    }

    ReceiptBuilder.prototype.raw = function (bytes) { this._parts.push(new Uint8Array(bytes)); return this; };
    ReceiptBuilder.prototype.init = function () { return this.raw(this._cmds.INIT); };
    ReceiptBuilder.prototype.lf   = function () { return this.raw(this._cmds.LF); };
    ReceiptBuilder.prototype.feed = function (n) { return this.raw(this._cmds.FEED(n)); };
    ReceiptBuilder.prototype.cut  = function (partial) { return this.raw(partial && this._cmds.CUT_PARTIAL ? this._cmds.CUT_PARTIAL : this._cmds.CUT_FULL); };
    ReceiptBuilder.prototype.align = function (a) {
        var m = { left: 'ALIGN_L', center: 'ALIGN_C', right: 'ALIGN_R' };
        return this.raw(this._cmds[m[a]] || this._cmds.ALIGN_L);
    };
    ReceiptBuilder.prototype.bold = function (on) { return this.raw(on ? this._cmds.BOLD_ON : this._cmds.BOLD_OFF); };
    ReceiptBuilder.prototype.size = function (s) {
        var m = { normal: 'SIZE_NORMAL', dh: 'SIZE_DH', dw: 'SIZE_DW', double: 'SIZE_DOUBLE' };
        return this.raw(this._cmds[m[s]] || this._cmds.SIZE_NORMAL);
    };
    ReceiptBuilder.prototype.text = function (str) { this._parts.push(new Uint8Array(_encode(str))); return this; };
    ReceiptBuilder.prototype.line = function (str, align, bold, sz) {
        if (align) this.align(align);
        if (bold)  this.bold(true);
        if (sz)    this.size(sz);
        this.text(str).lf();
        if (bold)  this.bold(false);
        if (sz)    this.size('normal');
        return this;
    };
    ReceiptBuilder.prototype.divider = function (ch) {
        var cols = (this._profile && this._profile.capabilities && this._profile.capabilities.maxColumns) || 32;
        return this.line((ch || '-').repeat(cols));
    };
    ReceiptBuilder.prototype.row = function (left, right) {
        var cols = (this._profile && this._profile.capabilities && this._profile.capabilities.maxColumns) || 32;
        var gap  = cols - left.length - right.length;
        if (gap < 1) gap = 1;
        return this.text(left + ' '.repeat(gap) + right).lf();
    };
    ReceiptBuilder.prototype.qr = function (data) {
        if (!this._cmds.QR_STORE) return this;
        var enc = new TextEncoder().encode(data);
        return this
            .raw(this._cmds.QR_MODEL)
            .raw(this._cmds.QR_SIZE(6))
            .raw(this._cmds.QR_EC)
            .raw(this._cmds.QR_STORE(enc))
            .raw(this._cmds.QR_PRINT);
    };
    ReceiptBuilder.prototype.build = function () {
        return _concat.apply(null, this._parts);
    };

    // ─── Test receipt template ─────────────────────────────────────────────────

    function _buildTestReceipt(cmds, profile, opts) {
        opts = opts || {};
        var store   = opts.storeName  || 'SOKONI';
        var rcptNo  = opts.receiptNo  || 'TEST-001';
        var now     = opts.timestamp  || new Date().toLocaleString();
        var cols    = (profile && profile.capabilities && profile.capabilities.maxColumns) || 32;

        var r = new ReceiptBuilder(cmds, profile);
        r.init()
         .align('center').size('double').bold(true).line(store).size('normal').bold(false)
         .align('center').line('Hardware Setup Test Print')
         .align('center').line('Receipt #' + rcptNo)
         .align('center').line(now)
         .lf()
         .align('left').divider('-')
         .align('left').row('ITEM', 'AMOUNT')
         .align('left').divider('-')
         .align('left').row('Test Item 1', 'KES 100.00')
         .align('left').row('Test Item 2', 'KES 250.00')
         .align('left').row('Discount', 'KES -50.00')
         .align('left').divider('-')
         .align('left').bold(true).row('TOTAL', 'KES 300.00').bold(false)
         .align('left').divider('-')
         .lf()
         .align('center').line('Thank you for using SOKONI')
         .align('center').line('sokoni.app');

        if (profile && profile.capabilities && profile.capabilities.qr) {
            r.lf().align('center').qr('https://sokoni.app');
        }

        r.lf().lf().feed(3).cut(false);
        return r.build();
    }

    // =========================================================================
    // ESC/POS Printer Driver
    // =========================================================================

    function ESCPosPrinterDriver() {
        var base = DB();
        base.DeviceDriver.call(this);
        this._cmds = ESCPOS;
    }

    ESCPosPrinterDriver.prototype          = Object.create((DB() && DB().DeviceDriver && DB().DeviceDriver.prototype) || {});
    ESCPosPrinterDriver.prototype.constructor = ESCPosPrinterDriver;

    ESCPosPrinterDriver.driverType          = 'printer';
    ESCPosPrinterDriver.driverId            = 'escpos-printer';
    ESCPosPrinterDriver.supportedTransports = ['usb', 'bluetooth', 'serial', 'network', 'android', 'browser'];
    ESCPosPrinterDriver.supportedProfileIds = [];  // supports any ESC/POS printer

    ESCPosPrinterDriver.detect = function (profile) {
        return profile && (profile.protocol === 'escpos' || profile.driver === 'escpos-printer');
    };

    ESCPosPrinterDriver.prototype.onConnect = function (connection, profile) {
        this._connection = connection;
        this._profile    = profile;
        this._connected  = true;
        this._cmds       = (profile && profile.commands) || ESCPOS;
        return Promise.resolve();
    };

    ESCPosPrinterDriver.prototype.test = async function () {
        var base = DB();
        try {
            var bytes = _buildTestReceipt(this._cmds, this._profile, {});
            await this._connection.write(bytes);
            return base.TestResult(true, 'Test receipt printed successfully');
        } catch (e) {
            return base.TestResult(false, 'Test print failed: ' + e.message, e);
        }
    };

    ESCPosPrinterDriver.prototype.status = async function () {
        var base = DB();
        // Send INIT — if it goes through the printer is responsive
        try {
            await this._connection.write(new Uint8Array(this._cmds.INIT));
            return base.StatusResult('online', 'Printer responded to ESC/POS INIT');
        } catch (e) {
            return base.StatusResult('error', 'Printer did not respond: ' + e.message);
        }
    };

    ESCPosPrinterDriver.prototype.execute = async function (command, data) {
        data = data || {};
        switch (command) {
            case 'print':
                return this._print(data);
            case 'testReceipt':
                return this._testReceipt(data);
            case 'openDrawer':
                return this._openDrawer(data.pin || 2);
            case 'feedLines':
                return this._connection.write(new Uint8Array(this._cmds.FEED(data.lines || 3)));
            case 'cut':
                return this._connection.write(new Uint8Array(data.partial ? (this._cmds.CUT_PARTIAL || this._cmds.CUT_FULL) : this._cmds.CUT_FULL));
            case 'beep':
                return this._beep(data.count || 1);
            case 'status':
                return this.status();
            case 'raw':
                return this._connection.write(data.bytes);
            default:
                return Promise.reject(new Error('Unknown printer command: ' + command));
        }
    };

    ESCPosPrinterDriver.prototype._print = async function (data) {
        if (data.raw) {
            return this._connection.write(data.raw instanceof Uint8Array ? data.raw : new Uint8Array(data.raw));
        }

        var r = new ReceiptBuilder(this._cmds, this._profile);
        r.init();

        var lines = data.lines || [];
        for (var i = 0; i < lines.length; i++) {
            var l = lines[i];
            if (l.divider) { r.divider(l.char); continue; }
            if (l.qr)      { r.lf().align('center').qr(l.qr).lf(); continue; }
            r.line(l.text || '', l.align || 'left', !!l.bold, l.size || 'normal');
        }

        if (data.cut !== false) {
            r.feed(data.feedLines || 3).cut(!!data.partialCut);
        }

        return this._connection.write(r.build());
    };

    ESCPosPrinterDriver.prototype._testReceipt = async function (data) {
        var bytes = _buildTestReceipt(this._cmds, this._profile, data);
        return this._connection.write(bytes);
    };

    ESCPosPrinterDriver.prototype._openDrawer = async function (pin) {
        var cmd = (pin === 5) ? this._cmds.DRAWER_5 : this._cmds.DRAWER_2;
        if (!cmd) return;
        return this._connection.write(new Uint8Array(cmd));
    };

    ESCPosPrinterDriver.prototype._beep = async function (count) {
        if (!this._cmds.BEEP) return;
        var bytes = [];
        for (var i = 0; i < count; i++) bytes = bytes.concat(this._cmds.BEEP);
        return this._connection.write(new Uint8Array(bytes));
    };

    ESCPosPrinterDriver.prototype.recover = async function () {
        try {
            await this._connection.write(new Uint8Array(this._cmds.INIT));
            return true;
        } catch (_) { return false; }
    };

    ESCPosPrinterDriver.prototype.diagnostics = async function () {
        var base = DB();
        var status = await this.status();
        return base.DiagnosticsResult(
            ESCPosPrinterDriver.driverId,
            this._connection ? this._connection.transport : 'none',
            this._profile ? this._profile.id : 'unknown',
            {
                connected:  this._connected,
                status:     status.state,
                paperWidth: this._profile && this._profile.capabilities && this._profile.capabilities.paperWidth,
                columns:    this._profile && this._profile.capabilities && this._profile.capabilities.maxColumns,
                qr:         this._profile && this._profile.capabilities && this._profile.capabilities.qr,
                cutter:     this._profile && this._profile.capabilities && this._profile.capabilities.cutter,
            },
            []
        );
    };

    ESCPosPrinterDriver.prototype.disconnect = async function () {
        this._connected = false;
        if (this._connection) {
            try { await this._connection.close(); } catch (_) {}
            this._connection = null;
        }
    };

    // =========================================================================
    // Star Micronics Printer Driver (StarPRNT)
    // =========================================================================

    function StarPrinterDriver() {
        ESCPosPrinterDriver.call(this);
        this._cmds = STARPRNT;
    }
    StarPrinterDriver.prototype          = Object.create(ESCPosPrinterDriver.prototype);
    StarPrinterDriver.prototype.constructor = StarPrinterDriver;

    StarPrinterDriver.driverType          = 'printer';
    StarPrinterDriver.driverId            = 'star-printer';
    StarPrinterDriver.supportedTransports = ['usb', 'bluetooth', 'serial', 'network'];
    StarPrinterDriver.supportedProfileIds = ['STAR_TSP100'];

    StarPrinterDriver.detect = function (profile) {
        return profile && (profile.protocol === 'starprnt' || profile.driver === 'star-printer');
    };

    StarPrinterDriver.prototype.onConnect = function (connection, profile) {
        this._connection = connection;
        this._profile    = profile;
        this._connected  = true;
        this._cmds       = STARPRNT;
        return Promise.resolve();
    };

    // =========================================================================
    // Zebra ZPL Label Printer Driver
    // =========================================================================

    function ZPLPrinterDriver() {
        var base = DB();
        base.DeviceDriver.call(this);
    }
    ZPLPrinterDriver.prototype          = Object.create((DB() && DB().DeviceDriver && DB().DeviceDriver.prototype) || {});
    ZPLPrinterDriver.prototype.constructor = ZPLPrinterDriver;

    ZPLPrinterDriver.driverType          = 'printer';
    ZPLPrinterDriver.driverId            = 'zpl-printer';
    ZPLPrinterDriver.supportedTransports = ['usb', 'network', 'serial'];
    ZPLPrinterDriver.supportedProfileIds = ['ZEBRA_ZD220'];

    ZPLPrinterDriver.detect = function (profile) {
        return profile && (profile.protocol === 'zpl' || profile.driver === 'zpl-printer');
    };

    ZPLPrinterDriver.prototype.onConnect = function (connection, profile) {
        this._connection = connection;
        this._profile    = profile;
        this._connected  = true;
        return Promise.resolve();
    };

    ZPLPrinterDriver.prototype.execute = async function (command, data) {
        data = data || {};
        switch (command) {
            case 'print':
                return this._printZPL(data);
            case 'testReceipt':
                return this._testLabel(data);
            case 'status':
                return this.status();
            default:
                return Promise.reject(new Error('ZPL does not support command: ' + command));
        }
    };

    ZPLPrinterDriver.prototype._printZPL = async function (data) {
        var zpl = data.zpl || data.raw;
        if (!zpl) return;
        var enc = new TextEncoder().encode(zpl);
        return this._connection.write(enc);
    };

    ZPLPrinterDriver.prototype._testLabel = async function () {
        var zpl = '^XA^FO50,50^A0N,50,50^FDSOKONI Label Test^FS^FO50,120^A0N,30,30^FDHardware Setup OK^FS^XZ';
        var enc = new TextEncoder().encode(zpl);
        return this._connection.write(enc);
    };

    ZPLPrinterDriver.prototype.test = function () {
        return this._testLabel().then(function () {
            return (DB() || { TestResult: function (ok, d) { return {ok:ok, detail:d}; } }).TestResult(true, 'ZPL test label sent');
        }).catch(function (e) {
            return (DB() || { TestResult: function (ok, d) { return {ok:ok, detail:d}; } }).TestResult(false, e.message);
        });
    };

    ZPLPrinterDriver.prototype.status = async function () {
        var base = DB();
        return base.StatusResult(this._connected ? 'online' : 'offline', 'ZPL status is connection-based only');
    };

    // =========================================================================
    // Register all printer drivers
    // =========================================================================

    function _registerAll() {
        var dm = global.SokoniDriverManager;
        if (!dm) return;
        dm.register(ESCPosPrinterDriver);
        dm.register(StarPrinterDriver);
        dm.register(ZPLPrinterDriver);
    }

    // Register immediately, and also on DOMContentLoaded in case DriverManager
    // is not yet loaded at parse time.
    if (global.SokoniDriverManager) {
        _registerAll();
    } else {
        global.addEventListener('DOMContentLoaded', function () {
            if (global.SokoniDriverManager) _registerAll();
        });
    }

    // =========================================================================
    // Export
    // =========================================================================

    global.SokoniPrinterDrivers = {
        ESCPosPrinterDriver: ESCPosPrinterDriver,
        StarPrinterDriver:   StarPrinterDriver,
        ZPLPrinterDriver:    ZPLPrinterDriver,
        ReceiptBuilder:      ReceiptBuilder,
        ESCPOS:              ESCPOS,
        STARPRNT:            STARPRNT,
    };

})(window);
