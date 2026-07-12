/* ============================================================================
   SOKONI — Digital Acceptance Certificate (PDF renderer)
   sokoni-legal-certificate.js

     SokoniLegalCertificate.download(cert)   -> saves sokoni-certificate-<id>.pdf
     SokoniLegalCertificate.blob(cert)       -> Promise<Blob>

   `cert` is the object returned by legalGetCertificate / legalMyCertificates.
   NO new backend API is used — this renders what the server already issues.

   Why a hand-rolled PDF rather than a library
   -------------------------------------------
   • Zero new dependencies, and it works OFFLINE — a certificate the user cannot
     open without a CDN is not much of a certificate.
   • Real PDF text objects (Helvetica), so the certificate is selectable,
     searchable and machine-readable — not a screenshot of text.
   • Only the logo and the QR are rasterised, embedded as JPEG XObjects
     (/DCTDecode takes JPEG bytes verbatim, so no deflate is needed in-browser).

   The QR encodes a verification URL. It proves nothing on its own — verification
   is the SERVER checking the certificate id. The QR is a convenience, not evidence.
============================================================================ */
(function () {
  'use strict';
  if (window.SokoniLegalCertificate) return;

  var VERIFY_BASE = 'https://mysokoni.co.ke/legal-centre.html?verify=';

  /* ── Tiny PDF writer ─────────────────────────────────────────────────────── */
  function PDF() {
    this.objs = [];                       // 1-indexed object bodies
  }
  PDF.prototype.add = function (body) { this.objs.push(body); return this.objs.length; };

  /* Latin-1 escape for PDF string literals. */
  function pstr(s) {
    return String(s == null ? '' : s)
      .replace(/[\\()]/g, '\\$&')
      .replace(/[^\x20-\x7E]/g, '');       // drop non-ASCII: base-14 fonts can't show it
  }

  PDF.prototype.build = function () {
    var head = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
    var parts = [head];
    var offsets = [];
    var pos = head.length;

    for (var i = 0; i < this.objs.length; i++) {
      var s = (i + 1) + ' 0 obj\n' + this.objs[i] + '\nendobj\n';
      offsets.push(pos);
      parts.push(s);
      pos += s.length;
    }
    var xrefPos = pos;
    var xref = 'xref\n0 ' + (this.objs.length + 1) + '\n0000000000 65535 f \n';
    offsets.forEach(function (o) {
      xref += ('0000000000' + o).slice(-10) + ' 00000 n \n';
    });
    var trailer = 'trailer\n<< /Size ' + (this.objs.length + 1) + ' /Root 1 0 R >>\n' +
                  'startxref\n' + xrefPos + '\n%%EOF';
    parts.push(xref, trailer);

    /* Latin-1 → bytes. Image streams are inserted as binary-safe latin1 already. */
    var str = parts.join('');
    var bytes = new Uint8Array(str.length);
    for (var k = 0; k < str.length; k++) bytes[k] = str.charCodeAt(k) & 0xFF;
    return new Blob([bytes], { type: 'application/pdf' });
  };

  /* ── Canvas → JPEG bytes (latin1 string, ready for a PDF stream) ─────────── */
  function jpegFromCanvas(canvas, quality) {
    var url = canvas.toDataURL('image/jpeg', quality || 0.92);
    var b64 = url.split(',')[1];
    var bin = atob(b64);
    return { data: bin, width: canvas.width, height: canvas.height };
  }

  /* ── QR — reuses the qrcodejs already used elsewhere on the platform ─────── */
  function loadQrLib() {
    if (window.QRCode) return Promise.resolve();
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
      s.onload = resolve;
      s.onerror = function () { reject(new Error('qr-unavailable')); };
      document.head.appendChild(s);
    });
  }

  function qrCanvas(text) {
    return loadQrLib().then(function () {
      var host = document.createElement('div');
      host.style.cssText = 'position:absolute;left:-9999px;top:-9999px';
      document.body.appendChild(host);
      /* eslint-disable no-new */
      new window.QRCode(host, {
        text: text, width: 320, height: 320,
        colorDark: '#000000', colorLight: '#ffffff',
        correctLevel: window.QRCode.CorrectLevel.M,
      });
      return new Promise(function (resolve) {
        setTimeout(function () {
          var c = host.querySelector('canvas');
          if (!c) {                                  // qrcodejs fell back to <img>
            var img = host.querySelector('img');
            c = document.createElement('canvas');
            c.width = c.height = 320;
            var cx = c.getContext('2d');
            cx.fillStyle = '#fff'; cx.fillRect(0, 0, 320, 320);
            if (img && img.complete) cx.drawImage(img, 0, 0, 320, 320);
          }
          /* Flatten onto white — a transparent QR renders as a black square in PDF. */
          var flat = document.createElement('canvas');
          flat.width = flat.height = 320;
          var fx = flat.getContext('2d');
          fx.fillStyle = '#fff'; fx.fillRect(0, 0, 320, 320);
          fx.drawImage(c, 0, 0, 320, 320);
          host.remove();
          resolve(flat);
        }, 60);
      });
    }).catch(function () { return null; });          // offline → certificate still renders
  }

  /* ── Logo ────────────────────────────────────────────────────────────────────
     The SOKONI mark is DRAWN with canvas primitives rather than loaded from
     assets/sokoni-icon.svg. Two reasons, both real:
       1. Drawing an SVG <img> onto a canvas TAINTS it, so toDataURL() throws a
          SecurityError and the whole PDF fails to render. (Observed, not assumed.)
       2. A fetched asset makes the certificate un-generatable offline — and a
          certificate you cannot open without a network is not much of a certificate.
     Geometry mirrors sokoni-icon.svg: rounded bag (10,29 60x43 r9) + handle arc. */
  function logoCanvas() {
    var S = 220, k = S / 80;                       // icon viewBox is 80x80
    var c = document.createElement('canvas');
    c.width = c.height = S;
    var x = c.getContext('2d');
    x.fillStyle = '#fff'; x.fillRect(0, 0, S, S);

    var g = x.createLinearGradient(0, 29 * k, 0, 72 * k);
    g.addColorStop(0, '#71ff00');
    g.addColorStop(1, '#237000');

    /* Bag body */
    var bx = 10 * k, by = 29 * k, bw = 60 * k, bh = 43 * k, r = 9 * k;
    x.beginPath();
    x.moveTo(bx + r, by);
    x.lineTo(bx + bw - r, by);
    x.quadraticCurveTo(bx + bw, by, bx + bw, by + r);
    x.lineTo(bx + bw, by + bh - r);
    x.quadraticCurveTo(bx + bw, by + bh, bx + bw - r, by + bh);
    x.lineTo(bx + r, by + bh);
    x.quadraticCurveTo(bx, by + bh, bx, by + bh - r);
    x.lineTo(bx, by + r);
    x.quadraticCurveTo(bx, by, bx + r, by);
    x.closePath();
    x.fillStyle = g;
    x.fill();

    /* Handle */
    x.beginPath();
    x.moveTo(28 * k, 33 * k);
    x.lineTo(28 * k, 24 * k);
    x.arc(40 * k, 24 * k, 12 * k, Math.PI, 0);
    x.lineTo(52 * k, 33 * k);
    x.strokeStyle = '#71ff00';
    x.lineWidth = 6 * k;
    x.lineCap = 'round';
    x.stroke();

    return Promise.resolve(c);
  }

  function fmtTs(ts) {
    if (!ts) return '';
    var ms = ts._seconds ? ts._seconds * 1000
           : ts.seconds ? ts.seconds * 1000
           : (typeof ts === 'number' ? ts : Date.parse(ts));
    if (!ms || isNaN(ms)) return '';
    return new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  }

  /* ── Render ─────────────────────────────────────────────────────────────── */
  function blob(cert) {
    var id = cert.certificateId || cert.id || '';
    return Promise.all([logoCanvas(), qrCanvas(VERIFY_BASE + encodeURIComponent(id))])
      .then(function (r) {
        var logo = r[0], qr = r[1];
        var pdf = new PDF();

        /* Allocate object numbers UP FRONT. The logo and QR are optional (either can
           fail offline), so numbering them positionally would shift every later object
           and the page dict would point at the wrong ones — a corrupt PDF. */
        var N = { cat: 1, pages: 2, page: 3, content: 4, f1: 5, f2: 6 };
        var next = 6;
        if (logo) N.logo = ++next;
        if (qr)   N.qr   = ++next;

        var xobj = [];
        if (logo) xobj.push('/ImLogo ' + N.logo + ' 0 R');
        if (qr)   xobj.push('/ImQr ' + N.qr + ' 0 R');

        pdf.add('<< /Type /Catalog /Pages ' + N.pages + ' 0 R >>');
        pdf.add('<< /Type /Pages /Kids [' + N.page + ' 0 R] /Count 1 >>');
        pdf.add('<< /Type /Page /Parent ' + N.pages + ' 0 R /MediaBox [0 0 595 842] ' +
                '/Resources << /Font << /F1 ' + N.f1 + ' 0 R /F2 ' + N.f2 + ' 0 R >> ' +
                (xobj.length ? '/XObject << ' + xobj.join(' ') + ' >> ' : '') + '>> ' +
                '/Contents ' + N.content + ' 0 R >>');

        /* Content stream */
        var W = 595;
        var L = 56;                       // left margin
        var y = 786;
        var out = [];

        function text(font, size, tx, ty, s, gray) {
          out.push('BT /' + font + ' ' + size + ' Tf ' +
                   (gray != null ? gray + ' g ' : '0 g ') +
                   tx + ' ' + ty + ' Td (' + pstr(s) + ') Tj ET');
        }
        function line(ty, gray) {
          out.push((gray != null ? gray : 0.85) + ' G 0.7 w ' +
                   L + ' ' + ty + ' m ' + (W - L) + ' ' + ty + ' l S');
        }

        /* Header */
        if (logo) out.push('q 44 0 0 44 ' + L + ' ' + (y - 10) + ' cm /ImLogo Do Q');
        text('F2', 20, L + (logo ? 58 : 0), y + 12, 'SOKONI');
        text('F1', 9.5, L + (logo ? 58 : 0), y - 1, 'Digital Acceptance Certificate', 0.42);
        y -= 42;
        line(y);
        y -= 30;

        text('F2', 15, L, y, 'Certificate of Legal Acceptance');
        y -= 16;
        /* BRAND POLICY: the customer-facing issuer is SOKONI, full stop. This line sits
           directly under the certificate title — the most prominent position on the page —
           and used to carry a "Powered by <legal entity>" strapline. That breaks the policy
           twice over: it puts the legal entity in a customer-facing brand slot, and the
           name it used was not even the registered one.

           The legal entity IS legally required on this document — it issues a legal
           instrument — so it now appears in the footer with the other regulatory
           disclosures, which is exactly where the policy permits it. */
        text('F1', 9, L, y, 'Issued by SOKONI.', 0.45);
        y -= 30;

        /* Field table */
        var rows = [
          ['Certificate number', id],
          ['Acceptance ID', cert.acceptanceId || id],
          ['Declaration ID', cert.declarationAccepted
            ? (id + '-DECL-v' + (cert.declarationVersion || '1.0')) : 'Not applicable'],
          ['Name', cert.signedName || ''],
          ['Business', cert.businessName || cert.businessId || 'Not provided'],
          ['Merchant / Provider ID', cert.merchantId || cert.providerId || cert.businessId || 'Not issued'],
          ['Role', cert.role || ''],
          ['Signature type', cert.signatureType || ''],
          ['Signature hash (SHA-256)', cert.signatureHash || ''],
          ['Country', (cert.country || 'Unknown') +
            (cert.countrySource ? ' (' + cert.countrySource + ')' : '')],
          ['IP address', cert.ipAddress || ''],
          ['Server timestamp', fmtTs(cert.issuedAt) || 'Recorded server-side'],
          ['Status', (cert.status || 'valid').toUpperCase()],
        ];
        rows.forEach(function (rw) {
          text('F1', 9, L, y, rw[0], 0.45);
          var v = String(rw[1] == null ? '' : rw[1]);
          /* The SHA-256 hash is 64 chars — wrap rather than run off the page. */
          if (v.length > 44) {
            text('F2', 8.4, L + 165, y, v.slice(0, 44));
            y -= 11;
            text('F2', 8.4, L + 165, y, v.slice(44));
          } else {
            text('F2', 9, L + 165, y, v);
          }
          y -= 9;
          line(y, 0.92);
          y -= 13;
        });

        /* Agreements */
        y -= 8;
        text('F2', 11, L, y, 'Agreements accepted');
        y -= 16;
        (cert.agreements || []).forEach(function (a) {
          text('F1', 9, L, y, '• ' + (a.agreementId || a.id || '') + '   v' + (a.version || ''));
          y -= 13;
        });
        if (!(cert.agreements || []).length) { text('F1', 9, L, y, 'None recorded'); y -= 13; }

        /* Declaration */
        if (cert.declarationAccepted && Array.isArray(cert.declarationText)) {
          y -= 10;
          text('F2', 11, L, y, 'Professional declaration (v' + (cert.declarationVersion || '1.0') + ')');
          y -= 15;
          cert.declarationText.forEach(function (s) {
            text('F1', 8.4, L, y, '• ' + s, 0.25);
            y -= 11.5;
          });
        }

        /* QR + verification.
           Placed BELOW the flowing content, not at a fixed y — pinning it meant the
           QR block sat on top of the declaration text when the declaration was long.
           Floor at 80 so it always clears the footer rule at y=62. */
        var qy = Math.max(80, y - 104);
        if (qr) {
          out.push('q 92 0 0 92 ' + L + ' ' + qy + ' cm /ImQr Do Q');
          text('F1', 8, L + 104, qy + 74, 'Verify this certificate', 0.3);
          text('F1', 7.6, L + 104, qy + 62, 'Scan, or visit:', 0.5);
          text('F1', 7.6, L + 104, qy + 51, VERIFY_BASE.replace('https://', ''), 0.5);
          text('F1', 7.6, L + 104, qy + 40, id, 0.5);
          text('F1', 7, L + 104, qy + 22,
            'The QR is a convenience. Verification is the server confirming this id.', 0.6);
        }

        /* Footer — the ONE place on this document where the legal entity belongs.
           A certificate of legal acceptance must name the entity that issued it; that is a
           regulatory disclosure, not branding, and the policy explicitly permits it here.

           The name is read from CompanyIdentity rather than typed, because the literal that
           was hardcoded above had already drifted from the registered name. A legal document
           asserting the wrong company name is worse than one asserting none. */
        line(62, 0.88);
        text('F1', 7.4, L, 48,
          'This certificate records an electronic signature made under applicable Kenyan law.', 0.5);
        text('F1', 7.4, L, 38,
          'The authoritative record is held server-side by SOKONI and is append-only.', 0.5);
        text('F1', 7.4, L, 28,
          'SOKONI is operated by ' +
          ((window.SOKONI_COMPANY && window.SOKONI_COMPANY.legalName) || 'Bravilex International Co. Limited') +
          ', the legal issuer of this certificate.', 0.5);

        /* Emit in the SAME order the numbers were allocated: 4,5,6,[7],[8]. */
        var content = out.join('\n');
        pdf.add('<< /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream');            // 4
        pdf.add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');   // 5
        pdf.add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'); // 6

        if (logo) {
          var lj = jpegFromCanvas(logo);
          pdf.add('<< /Type /XObject /Subtype /Image /Width ' + lj.width + ' /Height ' + lj.height +
                  ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' +
                  lj.data.length + ' >>\nstream\n' + lj.data + '\nendstream');                          // 7
        }
        if (qr) {
          var qj = jpegFromCanvas(qr, 1.0);
          pdf.add('<< /Type /XObject /Subtype /Image /Width ' + qj.width + ' /Height ' + qj.height +
                  ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' +
                  qj.data.length + ' >>\nstream\n' + qj.data + '\nendstream');                          // 8
        }

        return pdf.build();
      });
  }

  function download(cert) {
    return blob(cert).then(function (b) {
      var a = document.createElement('a');
      a.href = URL.createObjectURL(b);
      a.download = 'sokoni-certificate-' + (cert.certificateId || cert.id || 'record') + '.pdf';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
      return b;
    });
  }

  window.SokoniLegalCertificate = { blob: blob, download: download };
})();
