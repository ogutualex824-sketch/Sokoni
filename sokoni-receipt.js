/**
 * SOKONI RECEIPT LAYOUT ENGINE — 58mm ESC/POS
 * =============================================================================
 * ONE composition pipeline for every receipt (sales, dispatch, pickup, refund,
 * test, cash-up, end-of-day). It builds a device-independent document, then:
 *   • renderTo(enc)  — drives the ESC/POS encoder with NATIVE alignment
 *                      (enc.ac/al/ar), never manual space-padding, so centering
 *                      is exact regardless of the printer's font metrics.
 *   • toText()       — renders the same document to a fixed-width monospace
 *                      string for an on-screen PREVIEW (WYSIWYG before printing).
 *
 * Fixes the three composition defects seen on real receipts:
 *   1. "?" glyphs   — the encoder maps any charcode >=256 to '?'. We sanitize to
 *                     ASCII first (✓→OK, — → -, curly quotes → straight, emoji
 *                     dropped) so nothing unsupported ever reaches the driver.
 *   2. mid-word wrap— builders used width 48 (80mm). 58mm is 32 chars. We wrap
 *                     deterministically at the REAL width, breaking on spaces.
 *   3. miscentering — no hand-rolled space padding; the printer centers natively.
 *
 * The TRANSPORT (Bluetooth/GATT, ESC/POS command bytes) is untouched — this is
 * purely the layer that composes text BEFORE it reaches the driver.
 *
 * Usage:
 *   var r = SokoniReceipt.doc({ width: 32 });
 *   r.center('KASS SHOP', { bold:true, size:'big' })
 *    .center('SOKONI Receipt')
 *    .rule()
 *    .row('Receipt', 'SKN14CIAER')
 *    .row('TOTAL', 'KES 97')
 *    .rule()
 *    .qr('https://mysokoni.co.ke/r/SKN14CIAER', 'Verify Setup')
 *    .center('Thank you!')
 *    .feed(2);
 *   SokoniPrinter.print('custom', { build: function(enc){ r.renderTo(enc); } });
 *   // preview:  document.getElementById('pv').textContent = r.toText();
 */
window.SokoniReceipt = (function () {
  'use strict';

  var DEFAULT_WIDTH = 32;   // 58mm, Font A. 80mm ≈ 48. Override per printer config.

  /* Non-ASCII → ASCII. Anything not mapped and outside printable ASCII is dropped,
     because enc.text() would otherwise emit 0x3F ("?") for it. */
  var MAP = {
    '✓':'OK', '✔':'OK', '☑':'OK', '✗':'X', '✘':'X', '×':'x',
    '–':'-', '—':'-', '‑':'-', '•':'*', '·':'-', '…':'...',
    '“':'"', '”':'"', '„':'"', '‘':"'", '’':"'", ' ':' ',
    '€':'EUR', '£':'GBP', '™':'(TM)', '®':'(R)', '©':'(C)', '°':'deg',
  };
  function sanitize(s) {
    s = String(s == null ? '' : s);
    var out = '';
    for (var i = 0; i < s.length; i++) {
      var ch = s[i], code = s.charCodeAt(i);
      if (code === 9) { out += ' '; }                 // tab → space
      else if (code >= 32 && code < 127) out += ch;   // printable ASCII, kept verbatim
      else if (MAP[ch]) out += MAP[ch];               // known transliteration
      /* else: unsupported (emoji, box-drawing…) — dropped, never sent as "?" */
    }
    return out;
  }

  /* Deterministic word-wrap at `w`. Breaks on spaces; hard-splits any single token
     longer than the line so nothing ever overflows into a mid-word wrap. */
  function wrapText(s, w) {
    s = sanitize(s).replace(/\s+/g, ' ').trim();
    if (!s) return [''];
    var words = s.split(' '), lines = [], cur = '';
    for (var i = 0; i < words.length; i++) {
      var word = words[i];
      while (word.length > w) {
        if (cur) { lines.push(cur); cur = ''; }
        lines.push(word.slice(0, w));
        word = word.slice(w);
      }
      if (!cur) cur = word;
      else if ((cur + ' ' + word).length <= w) cur += ' ' + word;
      else { lines.push(cur); cur = word; }
    }
    if (cur) lines.push(cur);
    return lines.length ? lines : [''];
  }

  function padCenter(s, w) { s = s.slice(0, w); var t = w - s.length, l = Math.floor(t / 2); return new Array(l + 1).join(' ') + s + new Array(t - l + 1).join(' '); }
  function padRightTo(s, w) { s = s.slice(0, w); return s + new Array(w - s.length + 1).join(' '); }
  function padLeftTo(s, w)  { s = s.slice(0, w); return new Array(w - s.length + 1).join(' ') + s; }

  function Doc(opts) {
    opts = opts || {};
    this.w  = Math.max(24, Math.min(48, opts.width || DEFAULT_WIDTH));
    this.ops = [];
  }
  function _push(self, a, text, o) {
    o = o || {};
    wrapText(text, self.w).forEach(function (ln) {
      self.ops.push({ a: a, t: ln, bold: !!o.bold, size: o.size || 'normal' });
    });
    return self;
  }
  Doc.prototype.center = function (t, o) { return _push(this, 'center', t, o); };
  Doc.prototype.left   = function (t, o) { return _push(this, 'left',   t, o); };
  Doc.prototype.right  = function (t, o) { return _push(this, 'right',  t, o); };

  /* Left-justified key + right-justified value on one line (totals, meta). If the
     value alone is too wide, the pair is stacked (key line, value line) instead of
     being crushed — never truncated into nonsense. */
  Doc.prototype.row = function (l, r) {
    l = sanitize(l); r = sanitize(r);
    var maxL = this.w - r.length - 1;
    if (maxL < 1) { this.left(l); return this.right(r); }
    var left = l.length > maxL ? l.slice(0, maxL) : l;
    this.ops.push({ a: 'left', t: padRightTo(left, maxL) + ' ' + r, bold: false, size: 'normal' });
    return this;
  };

  Doc.prototype.rule  = function (ch) { this.ops.push({ a: 'left', t: new Array(this.w + 1).join((ch || '-').slice(0, 1)), bold: false, size: 'normal' }); return this; };
  Doc.prototype.blank = function (n) { n = n || 1; for (var i = 0; i < n; i++) this.ops.push({ a: 'left', t: '', size: 'normal' }); return this; };
  Doc.prototype.feed  = function (n) { this.ops.push({ type: 'feed', n: n || 2 }); return this; };
  Doc.prototype.qr    = function (data, label) { this.ops.push({ type: 'qr', data: String(data || ''), label: label ? sanitize(label) : '' }); return this; };

  /* Drive the ESC/POS encoder with its own alignment commands. */
  Doc.prototype.renderTo = function (enc) {
    if (!enc) return this;
    this.ops.forEach(function (op) {
      if (op.type === 'feed') { enc.lf(op.n || 2); return; }
      if (op.type === 'qr') {
        if (enc.ac) enc.ac();
        if (enc.qr) { try { enc.qr(op.data, 6); enc.lf(); } catch (_) {} }
        if (op.label) { if (enc.ac) enc.ac(); enc.text(op.label).lf(); }
        if (enc.al) enc.al();
        return;
      }
      if (op.size && op.size !== 'normal' && enc.sz) enc.sz(op.size);
      if (op.bold && enc.bold) enc.bold(true);
      if (enc.line) enc.line(op.t, op.a);
      else {
        var fn = op.a === 'center' ? enc.ac : op.a === 'right' ? enc.ar : enc.al;
        if (fn) fn.call(enc);
        enc.text(op.t).lf();
      }
      if (op.bold && enc.bold) enc.bold(false);
      if (op.size && op.size !== 'normal' && enc.sz) enc.sz('normal');
    });
    return this;
  };

  /* Fixed-width monospace render for an on-screen preview (WYSIWYG). */
  Doc.prototype.toText = function () {
    var self = this, out = [];
    this.ops.forEach(function (op) {
      if (op.type === 'feed') { for (var i = 0; i < (op.n || 2); i++) out.push(''); return; }
      if (op.type === 'qr') { out.push(padCenter('[ QR CODE ]', self.w)); if (op.label) out.push(padCenter(op.label, self.w)); return; }
      var t = op.t || '';
      out.push(op.a === 'center' ? padCenter(t, self.w) : op.a === 'right' ? padLeftTo(t, self.w) : t);
    });
    return out.join('\n');
  };

  /* Persisted printer width (58mm=32). Falls back to the default. */
  function savedWidth() {
    try { var w = parseInt(localStorage.getItem('posReceiptWidth'), 10); if (w >= 24 && w <= 48) return w; } catch (_) {}
    return DEFAULT_WIDTH;
  }

  return {
    WIDTH: DEFAULT_WIDTH,
    sanitize: sanitize,
    wrap: wrapText,
    savedWidth: savedWidth,
    doc: function (opts) { opts = opts || {}; if (!opts.width) opts.width = savedWidth(); return new Doc(opts); },
  };
})();
