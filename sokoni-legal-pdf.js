/* ============================================================================
   SOKONI LEGAL PDF — generic multi-page PDF renderer for legal documents
   ----------------------------------------------------------------------------
   The Legal Hub generates 16 document types (demand letters, leases, employment
   contracts, affidavits, plaints...). Until now "Download" produced a .txt file
   and "Print / PDF" opened the browser print dialog. Neither is a document you
   can serve on a party or file in court.

   This renders real PDF 1.4 bytes in the browser.

   Why hand-rolled instead of jsPDF:
     - It is the established idiom here (sokoni-legal-certificate.js, po-pdf.js).
     - Zero dependencies, works offline, no CSP change, ~8KB instead of ~350KB.
     - Legal documents are text + rules. That is precisely what base-14 PDF does.

   What this adds over the two existing writers, both of which are single-page and
   would silently truncate a lease agreement:
     - true multi-page flow with automatic page breaks
     - word wrap using real Helvetica AFM widths (not character counts, which
       overflow on wide text like "WHEREAS" and under-fill on "lit i")
     - page numbering ("Page 2 of 5") resolved after layout
     - orphan control: a heading never renders as the last line of a page

   Public API (window.SokoniLegalPDF):
     blob({title, body, docType, reference})  -> Promise<Blob>   (application/pdf)
     download({...})                          -> Promise<Blob>   (saves the file)

   `body` is the plain text the user sees in #docOutput — including any edits they
   made in the textarea. It is rendered verbatim; this is not a template engine.
============================================================================ */
;(function (window) {
  'use strict';
  if (window.SokoniLegalPDF) return;

  /* ── Page geometry (A4, points) ─────────────────────────────────────────── */
  var PW = 595.28, PH = 841.89;
  var ML = 56, MR = 56, MT = 62, MB = 64;      // margins
  var BODY_W = PW - ML - MR;
  var LEAD = 13.2;                              // body line height
  var SIZE = 9.6;                               // body font size

  /* ── Helvetica AFM widths, ASCII 32..126, per 1000 units ────────────────── */
  var W_REG = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,
    556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,
    1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,
    667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,
    333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,
    556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
  var W_BOLD = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,
    556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,
    975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,
    667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,
    333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,
    611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];

  /* PDF base-14 fonts are single-byte. Non-ASCII would corrupt the stream, so it
     is transliterated where there is an obvious equivalent and dropped otherwise.
     Kenyan legal text is ASCII apart from curly quotes and dashes pasted from Word. */
  function ascii(s) {
    return String(s == null ? '' : s)
      .replace(/[‘’‛]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/[–—]/g, '-')
      .replace(/…/g, '...')
      .replace(/ /g, ' ')
      .replace(/[^\x20-\x7E]/g, '');
  }
  /* Escape for a PDF literal string. */
  function pstr(s) {
    return ascii(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  }
  function widthOf(s, size, bold) {
    var t = ascii(s), tab = bold ? W_BOLD : W_REG, w = 0;
    for (var i = 0; i < t.length; i++) {
      var c = t.charCodeAt(i) - 32;
      w += (c >= 0 && c < tab.length ? tab[c] : 556);
    }
    return w * size / 1000;
  }

  /* ── Word wrap to a pixel width, not a character count ──────────────────── */
  function wrap(line, size, bold, maxW) {
    if (!line.trim()) return [''];
    var words = ascii(line).split(/\s+/), out = [], cur = '';
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      var probe = cur ? cur + ' ' + w : w;
      if (widthOf(probe, size, bold) <= maxW) { cur = probe; continue; }
      if (cur) out.push(cur);
      /* A single word longer than the line (a long URL, an ID) — hard-split it
         rather than let it run off the page. */
      while (widthOf(w, size, bold) > maxW) {
        var cut = w.length;
        while (cut > 1 && widthOf(w.slice(0, cut), size, bold) > maxW) cut--;
        out.push(w.slice(0, cut));
        w = w.slice(cut);
      }
      cur = w;
    }
    if (cur) out.push(cur);
    return out.length ? out : [''];
  }

  /* A line is treated as a heading when the source text presents it as one:
     ALL CAPS, or a numbered clause like "3. INTERPRETATION". These render bold
     and are kept with the line that follows them. */
  function isHeading(s) {
    var t = s.trim();
    if (!t || t.length > 78) return false;
    if (/^[0-9]+\s*\.\s+[A-Z]/.test(t)) return true;
    var letters = t.replace(/[^A-Za-z]/g, '');
    return letters.length >= 3 && letters === letters.toUpperCase();
  }

  /* ── Minimal PDF object writer ──────────────────────────────────────────── */
  function PDF() { this.objs = []; }
  PDF.prototype.add = function (body) { this.objs.push(body); return this.objs.length; };
  PDF.prototype.build = function () {
    var out = '%PDF-1.4\n', offs = [];
    for (var i = 0; i < this.objs.length; i++) {
      offs.push(out.length);
      out += (i + 1) + ' 0 obj\n' + this.objs[i] + '\nendobj\n';
    }
    var xref = out.length;
    out += 'xref\n0 ' + (this.objs.length + 1) + '\n0000000000 65535 f \n';
    for (var j = 0; j < offs.length; j++) {
      out += ('0000000000' + offs[j]).slice(-10) + ' 00000 n \n';
    }
    out += 'trailer\n<< /Size ' + (this.objs.length + 1) + ' /Root 1 0 R >>\nstartxref\n'
        + xref + '\n%%EOF';
    var bytes = new Uint8Array(out.length);
    for (var k = 0; k < out.length; k++) bytes[k] = out.charCodeAt(k) & 0xFF;
    return new Blob([bytes], { type: 'application/pdf' });
  };

  /* ── Lay the text out into pages ────────────────────────────────────────── */
  function paginate(title, body, reference) {
    var srcLines = String(body || '').replace(/\r\n?/g, '\n').split('\n');

    /* Flatten to renderable lines first, so a page break can never land between
       a heading and its first line of text. */
    var flow = [];
    for (var i = 0; i < srcLines.length; i++) {
      var raw = srcLines[i];
      var head = isHeading(raw);
      var parts = wrap(raw, SIZE, head, BODY_W);
      for (var p = 0; p < parts.length; p++) {
        flow.push({ text: parts[p], bold: head, headStart: head && p === 0 });
      }
    }

    var pages = [], cur = [];
    var yStart = PH - MT - 34;                 // room for the running header
    var y = yStart;
    for (var f = 0; f < flow.length; f++) {
      var needBreak = y < MB + LEAD;
      /* Orphan control: don't leave a heading stranded at the foot of a page. */
      if (!needBreak && flow[f].headStart && y < MB + LEAD * 3) needBreak = true;
      if (needBreak) { pages.push(cur); cur = []; y = yStart; }
      cur.push({ t: flow[f].text, b: flow[f].bold, y: y });
      y -= LEAD;
    }
    pages.push(cur);
    return pages;
  }

  /* ── Content stream for one page ────────────────────────────────────────── */
  function pageStream(lines, pageNo, pageCount, title, reference, stamp) {
    var s = '';
    function text(font, size, x, yy, str, gray) {
      s += 'BT /' + font + ' ' + size + ' Tf ' + (gray == null ? 0 : gray) + ' g '
         + x + ' ' + yy + ' Td (' + pstr(str) + ') Tj ET\n';
    }
    function rule(yy, gray) {
      s += (gray == null ? 0.75 : gray) + ' G 0.6 w ' + ML + ' ' + yy + ' m '
         + (PW - MR) + ' ' + yy + ' l S\n';
    }

    /* Running header — the document title, and SOKONI as the issuing platform. */
    var hy = PH - MT + 6;
    text('F2', 10.5, ML, hy, title, 0.1);
    var brand = 'SOKONI Legal Hub';
    text('F1', 8.4, PW - MR - widthOf(brand, 8.4, false), hy, brand, 0.45);
    rule(hy - 7, 0.78);

    /* Body */
    for (var i = 0; i < lines.length; i++) {
      var L = lines[i];
      if (!L.t) continue;
      text(L.b ? 'F2' : 'F1', SIZE, ML, L.y, L.t, L.b ? 0.05 : 0.16);
    }

    /* Footer — page numbers, generation stamp, and an honest disclaimer.
       A generated document is a starting point, not legal advice. Saying so on
       every page is the difference between a useful tool and a liability. */
    var fy = MB - 20;
    rule(fy + 20, 0.85);
    var disc = 'Generated on SOKONI. This document is not legal advice — have an advocate review it before you rely on it.';
    text('F1', 6.9, ML, fy + 9, disc, 0.52);
    var left = reference ? 'Ref: ' + reference + '   ' + stamp : stamp;
    text('F1', 6.9, ML, fy - 1, left, 0.52);
    var pg = 'Page ' + pageNo + ' of ' + pageCount;
    text('F1', 6.9, PW - MR - widthOf(pg, 6.9, false), fy - 1, pg, 0.52);

    return s;
  }

  /* ── Public: build the Blob ─────────────────────────────────────────────── */
  function blob(opts) {
    opts = opts || {};
    var body = String(opts.body || '');
    if (!body.trim()) return Promise.reject(new Error('Nothing to render — the document is empty.'));

    var title = ascii(opts.title || 'Legal Document').toUpperCase();
    var reference = ascii(opts.reference || '');
    var stamp = new Date().toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' });

    var pages = paginate(title, body, reference);
    var pdf = new PDF();

    /* 1 catalog, 2 pages tree, 3 F1, 4 F2, then (page, content) per page. */
    var N = { cat: 1, tree: 2, f1: 3, f2: 4 };
    pdf.add('<< /Type /Catalog /Pages ' + N.tree + ' 0 R >>');           // 1
    pdf.add('');                                                          // 2 (patched below)
    pdf.add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');      // 3
    pdf.add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'); // 4

    var kids = [];
    for (var i = 0; i < pages.length; i++) {
      var stream = pageStream(pages[i], i + 1, pages.length, title, reference, stamp);
      var contentNo = pdf.add('<< /Length ' + stream.length + ' >>\nstream\n' + stream + 'endstream');
      var pageNo = pdf.add(
        '<< /Type /Page /Parent ' + N.tree + ' 0 R /MediaBox [0 0 ' + PW + ' ' + PH + ']'
        + ' /Resources << /Font << /F1 ' + N.f1 + ' 0 R /F2 ' + N.f2 + ' 0 R >> >>'
        + ' /Contents ' + contentNo + ' 0 R >>');
      kids.push(pageNo + ' 0 R');
    }
    pdf.objs[N.tree - 1] = '<< /Type /Pages /Count ' + kids.length
      + ' /Kids [' + kids.join(' ') + '] >>';

    return Promise.resolve(pdf.build());
  }

  function safeName(s) {
    return ascii(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48)
      || 'legal-document';
  }

  function download(opts) {
    return blob(opts).then(function (b) {
      var name = 'SOKONI-' + safeName(opts.docType || opts.title) + '-'
               + new Date().toISOString().slice(0, 10) + '.pdf';
      var url = URL.createObjectURL(b);
      var a = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      return b;
    });
  }

  window.SokoniLegalPDF = { blob: blob, download: download, _wrap: wrap, _widthOf: widthOf };
})(window);
