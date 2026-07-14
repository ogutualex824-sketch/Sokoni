/**
 * SOKONI SmartPOS — iOS / Safari Print Module  v1.0
 *
 * Safari (iOS and macOS) does not implement the Web Bluetooth API,
 * Web Serial, or WebUSB. This module provides the alternative receipt
 * delivery path for iPhone/iPad cashiers:
 *
 *   1. HTML receipt rendered in-browser, matching ESC/POS layout
 *   2. AirPrint via window.print() — triggers iOS print dialog
 *   3. Web Share API — share receipt to Files, WhatsApp, Email, etc.
 *   4. Direct WhatsApp URL scheme — opens WhatsApp with receipt text
 *
 * Called automatically by PosPrintService when the platform is iOS.
 * Also used by the TEST-13c certification page (pos-ios-print-test.html).
 *
 * No external dependencies. ES5-compatible for broadest iOS support.
 */

(function (global) {
  'use strict';

  /* ════════════════════════════════════════════════════════════════
     1. Platform Detection
  ════════════════════════════════════════════════════════════════ */

  function _getPlatform () {
    const ua  = navigator.userAgent  || '';
    const pl  = navigator.platform   || '';
    const mt  = navigator.maxTouchPoints || 0;

    const isIOS     = /iP(hone|od|ad)/.test(ua) || (pl === 'MacIntel' && mt > 1);
    const isAndroid = /Android/.test(ua);
    const isSafari  = /^((?!chrome|android|crios|fxios).)*safari/i.test(ua);
    const isChrome  = /CriOS/.test(ua) || (/Chrome/.test(ua) && !isIOS);
    const isPWA     = (window.matchMedia &&
                        window.matchMedia('(display-mode: standalone)').matches) ||
                      window.navigator.standalone === true;

    /* iOS Chrome and iOS Firefox are still WebKit — same API restrictions */
    const iosWebKit = isIOS; // all iOS browsers run WebKit

    return {
      isIOS,
      isAndroid,
      isSafari,
      isChrome,
      isPWA,
      isDesktop: !isIOS && !isAndroid,
    };
  }

  /* ════════════════════════════════════════════════════════════════
     2. Capability Detection
  ════════════════════════════════════════════════════════════════ */

  function getCapabilities () {
    var p = _getPlatform();
    return {
      platform:      p,
      ble:           !!navigator.bluetooth && !p.isIOS,
      webSerial:     !!navigator.serial    && !p.isIOS,
      webUsb:        !!navigator.usb       && !p.isIOS,
      browserPrint:  typeof window.print === 'function',
      webShare:      typeof navigator.share === 'function',
      webShareFiles: !!(navigator.share && navigator.canShare),
      airPrint:      typeof window.print === 'function' && p.isIOS,
      whatsApp:      p.isIOS || p.isAndroid || p.isDesktop,
    };
  }

  /* ════════════════════════════════════════════════════════════════
     3. HTML Receipt Builder
     Produces a self-contained HTML receipt page that:
     • Looks like a thermal receipt in screen preview
     • Prints to any paper size via AirPrint / browser print
     • Can be shared as an .html file
  ════════════════════════════════════════════════════════════════ */

  function buildReceiptHTML (receipt, context) {
    context = context || {};

    var storeName   = (context.store && context.store.businessName) || 'SOKONI SmartPOS';
    var storeAddr   = (context.store && context.store.address)      || 'Nairobi, Kenya';
    var storePhone  = (context.store && context.store.phone)        || '';
    var kraPin      = (context.store && context.store.kraPin)       || '';
    var cashier     = context.cashierName  || receipt.cashier  || '—';
    var register    = context.registerName || receipt.register || 'Default';

    var receiptNo = receipt.receiptNo || receipt.receiptNumber || 'N/A';
    var ts        = receipt.timestamp ? new Date(receipt.timestamp) : new Date();
    var dateStr   = ts.toLocaleDateString ('en-KE', { day:'2-digit', month:'short', year:'numeric' });
    var timeStr   = ts.toLocaleTimeString ('en-KE', { hour:'2-digit', minute:'2-digit', hour12:false });

    var items    = receipt.items    || [];
    var subtotal = Number(receipt.subtotal  || 0).toFixed(2);
    var discount = Number(receipt.discount  || receipt.discountTotal || 0).toFixed(2);
    var tax      = Number(receipt.tax       || receipt.taxTotal      || 0).toFixed(2);
    var total    = Number(receipt.total     || receipt.grandTotal    || 0).toFixed(2);
    var payments = receipt.payments || [];

    /* ── Item rows ── */
    var itemsHTML = items.map(function (item) {
      var name  = _esc(item.name || 'Item');
      var qty   = Number(item.qty  || item.quantity || 1);
      var price = Number(item.unitPrice || item.price || 0);
      var line  = (qty * price).toFixed(2);
      return (
        '<tr>' +
        '<td style="padding:4px 8px 4px 0;vertical-align:top;max-width:180px;word-break:break-word">' + name + '</td>' +
        '<td style="padding:4px 8px;text-align:center;white-space:nowrap">×' + qty + '</td>' +
        '<td style="padding:4px 0 4px 8px;text-align:right;white-space:nowrap">KES ' + line + '</td>' +
        '</tr>'
      );
    }).join('');

    /* ── Payment rows ── */
    var paymentsHTML = payments.map(function (p) {
      var method = (p.method || 'Payment').toUpperCase();
      var amount = Number(p.amount || 0).toFixed(2);
      var extra  = '';
      if (p.method === 'cash' && p.tendered) {
        extra = '<br><span style="font-size:.8em;color:#555">Tendered: KES ' + Number(p.tendered).toFixed(2) +
                ' | Change: KES ' + Number(p.change || 0).toFixed(2) + '</span>';
      }
      if ((p.method === 'mpesa' || p.method === 'm-pesa') && p.ref) {
        extra = '<br><span style="font-size:.8em;color:#555">Ref: ' + _esc(p.ref) + '</span>';
      }
      return '<tr><td style="padding:3px 8px 3px 0"><b>' + method + '</b>' + extra + '</td>' +
             '<td style="padding:3px 0;text-align:right">KES ' + amount + '</td></tr>';
    }).join('');

    /* ── QR code placeholder ── */
    var receiptUrl = 'https://mysokoni.co.ke/receipt/' + receiptNo;
    var qrBlock = '<div style="border:1px dashed #bbb;padding:10px;text-align:center;margin:12px 0;font-size:.75em;color:#555">' +
                  '<div style="font-size:2em;margin-bottom:4px">⬛</div>' +
                  '<div>Scan for digital receipt</div>' +
                  '<div style="word-break:break-all;color:#0066cc;font-size:.9em;margin-top:4px">' + _esc(receiptUrl) + '</div>' +
                  '</div>';

    /* ── Loyalty ── */
    var loyaltyBlock = '';
    if (receipt.loyaltyAwarded && receipt.loyaltyAwarded > 0) {
      loyaltyBlock = '<tr><td colspan="2" style="padding:4px 0;border-top:1px dashed #ddd;color:#555;font-size:.85em">' +
                     '🌟 ' + receipt.loyaltyAwarded + ' loyalty points earned</td></tr>';
    }

    return '<!DOCTYPE html><html lang="en"><head>' +
      '<meta charset="UTF-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>Receipt #' + _esc(receiptNo) + ' — ' + _esc(storeName) + '</title>' +
      '<style>' +
        '* { box-sizing: border-box; margin: 0; padding: 0; }' +
        'body { font-family: "Courier New", Courier, monospace; font-size: 13px; ' +
               'background: #f0f0f0; display: flex; justify-content: center; padding: 20px; min-height: 100vh; }' +
        '.receipt { background: #fff; max-width: 320px; width: 100%; padding: 16px; ' +
                  'box-shadow: 0 2px 12px rgba(0,0,0,.15); }' +
        '.actions { margin-top: 16px; display: flex; flex-direction: column; gap: 8px; }' +
        '.btn { display: block; padding: 14px; border: none; border-radius: 8px; ' +
               'font-size: 15px; font-weight: 700; cursor: pointer; text-align: center; text-decoration: none; }' +
        '.btn-primary { background: #25d366; color: #fff; }' +
        '.btn-secondary { background: #007aff; color: #fff; }' +
        '.btn-outline { background: transparent; border: 1.5px solid #007aff; color: #007aff; }' +
        '.notice { background: #fffbe6; border: 1px solid #ffd700; border-radius: 6px; ' +
                 'padding: 10px; font-size: .8em; color: #665c00; margin-top: 12px; }' +
        '@media print {' +
          'body { background: #fff; padding: 0; }' +
          '.receipt { box-shadow: none; max-width: none; padding: 4mm; }' +
          '.actions, .notice { display: none; }' +
          '@page { size: 80mm auto; margin: 0; }' +
        '}' +
      '</style>' +
      '</head><body>' +
      '<div class="receipt">' +
        /* Store header */
        '<div style="text-align:center;padding-bottom:10px;border-bottom:1px dashed #ccc">' +
          '<div style="font-weight:700;font-size:1.15em;letter-spacing:.15em">' + _esc(storeName) + '</div>' +
          '<div style="font-size:.85em;color:#555;margin-top:2px">' + _esc(storeAddr) + '</div>' +
          (storePhone ? '<div style="font-size:.85em;color:#555">Tel: ' + _esc(storePhone) + '</div>' : '') +
          (kraPin    ? '<div style="font-size:.8em;color:#888">KRA PIN: ' + _esc(kraPin) + '</div>' : '') +
        '</div>' +
        /* Receipt meta */
        '<div style="padding:8px 0;border-bottom:1px dashed #ccc">' +
          '<table style="width:100%;font-size:.85em"><tbody>' +
            '<tr><td style="color:#555">Receipt #</td><td style="text-align:right;font-weight:700">' + _esc(receiptNo) + '</td></tr>' +
            '<tr><td style="color:#555">Date</td><td style="text-align:right">' + dateStr + ' ' + timeStr + '</td></tr>' +
            '<tr><td style="color:#555">Cashier</td><td style="text-align:right">' + _esc(cashier) + '</td></tr>' +
            '<tr><td style="color:#555">Register</td><td style="text-align:right">' + _esc(register) + '</td></tr>' +
          '</tbody></table>' +
        '</div>' +
        /* Items */
        '<div style="padding:8px 0;border-bottom:1px dashed #ccc">' +
          '<div style="font-weight:700;font-size:.8em;color:#888;text-transform:uppercase;margin-bottom:6px">Items</div>' +
          '<table style="width:100%"><tbody>' + itemsHTML + '</tbody></table>' +
        '</div>' +
        /* Totals */
        '<div style="padding:8px 0;border-bottom:1px dashed #ccc">' +
          '<table style="width:100%;font-size:.9em"><tbody>' +
            '<tr><td style="color:#555">Subtotal</td><td style="text-align:right">KES ' + subtotal + '</td></tr>' +
            (Number(discount) > 0 ? '<tr><td style="color:#c00">Discount</td><td style="text-align:right;color:#c00">- KES ' + discount + '</td></tr>' : '') +
            '<tr><td style="color:#555">VAT (16%)</td><td style="text-align:right">KES ' + tax + '</td></tr>' +
            '<tr style="border-top:1px solid #333;font-weight:700;font-size:1.1em">' +
              '<td style="padding-top:6px">TOTAL</td>' +
              '<td style="text-align:right;padding-top:6px">KES ' + total + '</td>' +
            '</tr>' +
            loyaltyBlock +
          '</tbody></table>' +
        '</div>' +
        /* Payment */
        (paymentsHTML ? '<div style="padding:8px 0;border-bottom:1px dashed #ccc">' +
          '<div style="font-weight:700;font-size:.8em;color:#888;text-transform:uppercase;margin-bottom:6px">Payment</div>' +
          '<table style="width:100%"><tbody>' + paymentsHTML + '</tbody></table>' +
        '</div>' : '') +
        /* QR */
        qrBlock +
        /* Footer */
        '<div style="text-align:center;font-size:.8em;color:#888;padding-top:8px">' +
          '<div>Thank you for shopping with us!</div>' +
          '<div style="margin-top:2px">www.mysokoni.co.ke</div>' +
          '<div style="margin-top:6px;font-size:.75em">Issued by Bravilex International Co. Ltd</div>' +
        '</div>' +
        /* Actions — sticky print bar (hidden on paper print) */
        '<div class="actions">' +
          '<button class="btn btn-secondary" onclick="window.print()">🖨 Print / AirPrint</button>' +
          '<button class="btn btn-outline" onclick="(function(){var rn=\'' + receiptNo.replace(/'/g,'') + '\';if(navigator.share){navigator.share({title:document.title,text:\'Receipt from ' + (storeName.replace(/'/g,'')||'SOKONI SmartPOS') + '\',url:\'https://mysokoni.co.ke/receipt/\'+rn})}else{alert(\'Share not available in this browser.\')}})()" >📤 Share</button>' +
        '</div>' +
        '<div class="notice">ℹ️ Bluetooth printing is not available in Safari. Your receipt is saved in SOKONI and can be printed or shared above.</div>' +
      '</div>' +
      '</body></html>';
  }

  /* ════════════════════════════════════════════════════════════════
     4. AirPrint via hidden iframe
  ════════════════════════════════════════════════════════════════ */

  function printAirPrint (receipt, context) {
    var html = buildReceiptHTML(receipt, context);
    var iframe = document.createElement('iframe');
    iframe.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;border:0';
    iframe.srcdoc = html;
    document.body.appendChild(iframe);
    iframe.onload = function () {
      try {
        iframe.contentWindow.focus();
        iframe.contentWindow.print();
      } catch (e) {
        /* Safari sometimes blocks cross-origin iframe print — fallback to popup */
        _printViaPopup(html);
      }
      setTimeout(function () {
        if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
      }, 3000);
    };
  }

  function _printViaPopup (html) {
    var w = window.open('', '_blank', 'width=380,height=600,toolbar=0,menubar=0,scrollbars=1');
    if (!w) { alert('Allow pop-ups for this site to print the receipt.'); return; }
    w.document.open();
    w.document.write(html);
    w.document.close();
    w.onload = function () { w.print(); };
  }

  /* ════════════════════════════════════════════════════════════════
     5. Web Share API
  ════════════════════════════════════════════════════════════════ */

  async function shareReceipt (receipt, context) {
    if (!navigator.share) throw new Error('Web Share API not supported');

    var html = buildReceiptHTML(receipt, context);
    var receiptNo = receipt.receiptNo || receipt.receiptNumber || 'receipt';
    var title     = 'Receipt #' + receiptNo;
    var storeName = (context && context.store && context.store.businessName) || 'SOKONI SmartPOS';

    /* Try file sharing (iOS 14+) */
    if (navigator.canShare) {
      var blob = new Blob([html], { type: 'text/html' });
      var file = new File([blob], 'sokoni-receipt-' + receiptNo + '.html', { type: 'text/html' });
      if (navigator.canShare({ files: [file] })) {
        return navigator.share({ files: [file], title: title, text: storeName + ' — ' + title });
      }
    }

    /* Fallback: share URL */
    var url = 'https://mysokoni.co.ke/receipt/' + receiptNo;
    return navigator.share({ title: title, text: storeName + ' receipt for KES ' + (receipt.total || receipt.grandTotal || 0), url: url });
  }

  /* ════════════════════════════════════════════════════════════════
     6. WhatsApp
  ════════════════════════════════════════════════════════════════ */

  function openWhatsApp (phone, receipt, context) {
    var storeName = (context && context.store && context.store.businessName) || 'SOKONI SmartPOS';
    var receiptNo = receipt.receiptNo || receipt.receiptNumber || '';
    var total     = Number(receipt.total || receipt.grandTotal || 0).toFixed(2);
    var ts        = receipt.timestamp ? new Date(receipt.timestamp) : new Date();
    var dateStr   = ts.toLocaleDateString('en-KE', { day:'2-digit', month:'short', year:'numeric' });

    var msg = '🧾 *' + storeName + '*\n' +
              'Receipt #' + receiptNo + '\n' +
              'Date: ' + dateStr + '\n' +
              '────────────────\n';

    (receipt.items || []).forEach(function (item) {
      var qty   = item.qty || item.quantity || 1;
      var price = Number(item.unitPrice || item.price || 0).toFixed(2);
      msg += (item.name || 'Item') + ' ×' + qty + ' — KES ' + (qty * price).toFixed(2) + '\n';
    });

    msg += '────────────────\n' +
           '*TOTAL: KES ' + total + '*\n\n' +
           'View digital receipt:\n' +
           'https://mysokoni.co.ke/receipt/' + receiptNo;

    var number = (phone || '').replace(/\D/g, '');
    /* Kenya numbers: 07xx → 2547xx */
    if (number.length === 10 && number.startsWith('0')) number = '254' + number.slice(1);
    if (number.length === 9) number = '254' + number;

    var url = number
      ? 'https://wa.me/' + number + '?text=' + encodeURIComponent(msg)
      : 'https://wa.me/?text=' + encodeURIComponent(msg);

    window.open(url, '_blank');
  }

  /* ════════════════════════════════════════════════════════════════
     7. Receipt Panel
     Compact bottom panel shown after a successful iOS sale.
     — No backdrop / no blocking overlay
     — Single primary "Print Receipt" button (opens receipt in new
       tab; window.print() fires with full user-gesture context)
     — Secondary row: WhatsApp | Share | Email (always visible)
     — Intelligent cascade: after print pressed, fallback row
       updates label to "No printer found? Use:"
     — BLE guidance note at bottom (informational, not an error)
  ════════════════════════════════════════════════════════════════ */

  function showReceiptOptions (receipt, context) {
    return new Promise(function (resolve) {
      var existing = document.getElementById('sk-ios-receipt-panel');
      if (existing) existing.remove();

      var receiptNo = receipt.receiptNo || receipt.receiptNumber || '';
      var total     = Number(receipt.total || receipt.grandTotal || 0).toFixed(2);
      var phone     = (context && context.customerPhone) ||
                      (receipt.customer && receipt.customer.phone) || '';
      var cap       = getCapabilities();

      var panel = document.createElement('div');
      panel.id  = 'sk-ios-receipt-panel';
      panel.style.cssText = [
        'position:fixed;left:0;right:0;bottom:0;z-index:99999',
        'background:#0f0f0f',
        'border-top:2px solid #71ff00',
        'border-radius:16px 16px 0 0',
        'padding:20px 16px',
        'padding-bottom:calc(20px + env(safe-area-inset-bottom))',
        'font-family:-apple-system,BlinkMacSystemFont,"Helvetica Neue",sans-serif',
        'box-shadow:0 -8px 40px rgba(0,0,0,.7)',
      ].join(';');

      panel.innerHTML = _buildPanelHTML(receiptNo, total, phone, cap);
      document.body.appendChild(panel);

      /* ── Lazy receipt HTML (built once on first need) ── */
      var _receiptHTML = null;
      var _getReceiptHTML = function () {
        if (!_receiptHTML) _receiptHTML = buildReceiptHTML(receipt, context);
        return _receiptHTML;
      };

      var _close = function (result) {
        panel.remove();
        resolve(result || { printed: false, method: 'dismissed' });
      };

      /* ── Print Receipt — opens receipt in new tab (user-gesture context) ── */
      var btnPrint = document.getElementById('sk-ios-btn-print');
      if (btnPrint) {
        btnPrint.addEventListener('click', function () {
          var html = _getReceiptHTML();
          var w    = window.open('', '_blank');
          if (w) {
            w.document.open();
            w.document.write(html);
            w.document.close();
            /* Update button to confirm action */
            btnPrint.innerHTML = '✓ Receipt opened — tap <b>Print</b> in that tab';
            btnPrint.style.background = '#0d2200';
            btnPrint.style.color      = '#71ff00';
            btnPrint.style.border     = '1.5px solid #71ff00';
          } else {
            /* Popup blocked (unlikely from click) — fall back to iframe */
            printAirPrint(receipt, context);
          }
          /* Update fallback label to cascade guidance */
          var fallbackLabel = document.getElementById('sk-ios-fallback-label');
          if (fallbackLabel) {
            fallbackLabel.textContent = 'No AirPrint printer found? Send digitally:';
            fallbackLabel.style.color = '#fff';
          }
        });
      }

      /* ── WhatsApp ── */
      var btnWa = document.getElementById('sk-ios-btn-whatsapp');
      if (btnWa) {
        btnWa.addEventListener('click', function () {
          openWhatsApp(phone, receipt, context);
          _close({ printed: false, method: 'whatsapp' });
        });
      }

      /* ── Share Sheet ── */
      var btnShare = document.getElementById('sk-ios-btn-share');
      if (btnShare) {
        btnShare.addEventListener('click', function () {
          shareReceipt(receipt, context)
            .then(function ()  { _close({ printed: true, method: 'share' }); })
            .catch(function (err) {
              if (err && err.name !== 'AbortError') {
                console.warn('[SokoniIOSPrint] Share failed:', err.message);
              }
              /* User cancelled — keep panel open so they can choose another option */
            });
        });
      }

      /* ── Email ── */
      var btnEmail = document.getElementById('sk-ios-btn-email');
      if (btnEmail) {
        btnEmail.addEventListener('click', function () {
          var storeName = (context && context.store && context.store.businessName) || 'SOKONI SmartPOS';
          var url       = 'https://mysokoni.co.ke/receipt/' + encodeURIComponent(receiptNo);
          window.location.href =
            'mailto:?subject=' + encodeURIComponent('Receipt #' + receiptNo + ' — ' + storeName) +
            '&body=' + encodeURIComponent('View your receipt:\n' + url);
        });
      }

      /* ── Close ── */
      var btnClose = document.getElementById('sk-ios-btn-panel-close');
      if (btnClose) btnClose.addEventListener('click', function () { _close(); });
    });
  }

  function _buildPanelHTML (receiptNo, total, phone, cap) {
    var waBtn = phone
      ? '<button id="sk-ios-btn-whatsapp" style="' + _iconBtnStyle('#25d366') + '" title="WhatsApp">💬</button>'
      : '';

    var shareBtn = cap.webShare
      ? '<button id="sk-ios-btn-share" style="' + _iconBtnStyle('#007aff') + '" title="Share Sheet">📤</button>'
      : '';

    return (
      /* Header */
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">' +
        '<div>' +
          '<div style="font-size:.8em;color:#71ff00;font-weight:700;text-transform:uppercase;letter-spacing:.08em">✓ Sale Complete</div>' +
          '<div style="font-size:1em;font-weight:700;color:#fff;margin-top:2px">Receipt #' + _esc(receiptNo) + ' · KES ' + total + '</div>' +
        '</div>' +
        '<button id="sk-ios-btn-panel-close" style="background:transparent;border:none;color:#555;font-size:1.6em;cursor:pointer;padding:4px 10px;min-width:44px;min-height:44px">✕</button>' +
      '</div>' +

      /* Primary action — single Print Receipt button */
      '<button id="sk-ios-btn-print" style="' + _btnStyle('#71ff00', '#000') + '">' +
        '🖨&nbsp; Print Receipt / AirPrint' +
      '</button>' +

      /* Secondary row — always visible, label updates after print pressed */
      '<div style="margin-top:14px">' +
        '<div id="sk-ios-fallback-label" style="font-size:.8em;color:#777;margin-bottom:8px">' +
          'No AirPrint printer? Send digitally:' +
        '</div>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
          waBtn +
          shareBtn +
          '<button id="sk-ios-btn-email" style="' + _iconBtnStyle('#444') + '" title="Email">✉</button>' +
        '</div>' +
      '</div>' +

      /* BLE guidance — informational, not an error */
      '<div style="margin-top:14px;padding:10px 12px;background:#161600;border-radius:8px;border-left:3px solid #ffd700;font-size:.78em;color:#aaa;line-height:1.55">' +
        '<span style="color:#ffd700;font-weight:700">ℹ</span> ' +
        'Direct Bluetooth receipt printing isn\'t available in Safari. ' +
        'Use AirPrint or a supported network printer instead. ' +
        '<span style="color:#555">(Safari / WebKit platform limitation)</span>' +
      '</div>'
    );
  }

  function _btnStyle (bg, color) {
    return 'display:block;width:100%;padding:16px;border:none;border-radius:12px;font-size:16px;' +
           'font-weight:700;cursor:pointer;background:' + bg + ';color:' + color + ';text-align:center;' +
           'min-height:52px;';
  }

  function _iconBtnStyle (bg) {
    return 'padding:12px 18px;border:none;border-radius:10px;font-size:20px;cursor:pointer;' +
           'background:' + bg + ';color:#fff;min-width:52px;min-height:52px;';
  }

  /* ════════════════════════════════════════════════════════════════
     8. BLE Guidance — shown when iOS merchant attempts BLE connection
     Not an error — an informational explanation of the platform limit.
  ════════════════════════════════════════════════════════════════ */

  function showBleGuidance () {
    var existing = document.getElementById('sk-ios-ble-notice');
    if (existing) { existing.remove(); }

    var banner = document.createElement('div');
    banner.id  = 'sk-ios-ble-notice';
    banner.setAttribute('role', 'status');
    banner.setAttribute('aria-live', 'polite');
    banner.style.cssText = [
      'position:fixed;top:calc(64px + env(safe-area-inset-top));left:16px;right:16px;z-index:99998',
      'background:#1a1200;border:1.5px solid #ffd700;border-radius:12px',
      'padding:14px 40px 14px 16px',
      'font-family:-apple-system,BlinkMacSystemFont,"Helvetica Neue",sans-serif',
      'font-size:.88em;line-height:1.55;color:#ffd700',
      'box-shadow:0 4px 24px rgba(0,0,0,.55)',
    ].join(';');

    banner.innerHTML =
      '<div style="font-weight:700;margin-bottom:4px">Bluetooth Printing — Safari Notice</div>' +
      '<div style="color:#cc9900">Direct Bluetooth receipt printing isn\'t available in Safari.</div>' +
      '<div style="color:#997700;margin-top:4px">Use <b style="color:#ffd700">AirPrint</b>, <b style="color:#ffd700">Share</b>, or a <b style="color:#ffd700">supported network printer</b> instead.</div>' +
      '<div style="font-size:.82em;color:#665500;margin-top:6px">This is a Safari / WebKit platform limitation — not a SOKONI error.</div>' +
      '<button onclick="document.getElementById(\'sk-ios-ble-notice\')&&document.getElementById(\'sk-ios-ble-notice\').remove()" ' +
        'style="position:absolute;top:8px;right:10px;background:none;border:none;color:#997700;font-size:1.3em;cursor:pointer;' +
        'min-width:36px;min-height:36px;padding:4px">✕</button>';

    document.body.appendChild(banner);

    /* Auto-dismiss after 10 s */
    setTimeout(function () {
      var el = document.getElementById('sk-ios-ble-notice');
      if (!el) return;
      el.style.transition = 'opacity .5s';
      el.style.opacity    = '0';
      setTimeout(function () { var e2 = document.getElementById('sk-ios-ble-notice'); if (e2) e2.remove(); }, 600);
    }, 10000);
  }

  /* ════════════════════════════════════════════════════════════════
     9. printAfterSale — integration point for PosPrintService
  ════════════════════════════════════════════════════════════════ */

  async function printAfterSale (receipt, context) {
    return showReceiptOptions(receipt, context);
  }

  /* ════════════════════════════════════════════════════════════════
     Helpers
  ════════════════════════════════════════════════════════════════ */

  function _esc (s) {
    return String(s || '')
      .replace(/&/g,  '&amp;')
      .replace(/</g,  '&lt;')
      .replace(/>/g,  '&gt;')
      .replace(/"/g,  '&quot;')
      .replace(/'/g,  '&#39;');
  }

  /* ════════════════════════════════════════════════════════════════
     Public API
  ════════════════════════════════════════════════════════════════ */

  global.SokoniIOSPrint = {
    getPlatform:         _getPlatform,
    getCapabilities:     getCapabilities,
    buildReceiptHTML:    buildReceiptHTML,
    printAirPrint:       printAirPrint,
    shareReceipt:        shareReceipt,
    openWhatsApp:        openWhatsApp,
    showReceiptOptions:  showReceiptOptions,
    showBleGuidance:     showBleGuidance,
    printAfterSale:      printAfterSale,
  };

})(window);
