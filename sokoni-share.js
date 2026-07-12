/* SOKONI Share — WhatsApp / Copy / Twitter / Native share sheet */
(function () {
  'use strict';

  var _styleId = 'sokoni-share-styles';

  function ensureStyles() {
    if (document.getElementById(_styleId)) return;
    var s = document.createElement('style');
    s.id = _styleId;
    s.textContent =
      '#sokoni-share-overlay{position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:99999;display:flex;align-items:flex-end;justify-content:center;animation:ssOverIn .18s ease;}'
      + '@keyframes ssOverIn{from{opacity:0}to{opacity:1}}'
      + '#sokoni-share-sheet{background:#1c1c1c;border:1px solid rgba(255,255,255,.1);border-radius:22px 22px 0 0;width:100%;max-width:480px;padding-bottom:max(env(safe-area-inset-bottom),8px);animation:ssSheetIn .25s cubic-bezier(.32,.72,0,1);overflow:hidden;}'
      + '@keyframes ssSheetIn{from{transform:translateY(100%)}to{transform:translateY(0)}}'
      + '.ss-handle{width:36px;height:4px;background:rgba(255,255,255,.18);border-radius:2px;margin:12px auto 0;}'
      + '.ss-preview{display:flex;align-items:center;gap:12px;padding:14px 18px;border-bottom:1px solid rgba(255,255,255,.07);}'
      + '.ss-thumb{width:52px;height:52px;border-radius:11px;object-fit:cover;background:rgba(255,255,255,.05);flex-shrink:0;}'
      + '.ss-name{font-size:14px;font-weight:800;color:#fff;margin:0 0 3px;}'
      + '.ss-price{font-size:13px;color:#71ff00;font-weight:700;margin:0;}'
      + '.ss-grid{display:grid;grid-template-columns:repeat(4,1fr);padding:12px 6px;}'
      + '.ss-btn{display:flex;flex-direction:column;align-items:center;gap:5px;padding:10px 6px;border-radius:12px;background:none;border:none;cursor:pointer;font-family:inherit;color:rgba(255,255,255,.75);font-size:11px;font-weight:600;transition:background .15s;-webkit-tap-highlight-color:transparent;}'
      + '.ss-btn:hover{background:rgba(255,255,255,.07);}'
      + '.ss-ico{width:46px;height:46px;border-radius:13px;display:flex;align-items:center;justify-content:center;font-size:21px;}'
      + '.ss-ico.wa{background:rgba(37,211,102,.14);}'
      + '.ss-ico.cp{background:rgba(113,255,0,.11);}'
      + '.ss-ico.tw{background:rgba(29,161,242,.13);}'
      + '.ss-ico.nt{background:rgba(255,255,255,.07);}'
      + '.ss-link-row{margin:0 14px 12px;display:flex;align-items:center;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.08);border-radius:11px;overflow:hidden;}'
      + '.ss-link-txt{flex:1;font-size:11px;color:rgba(255,255,255,.4);overflow:hidden;white-space:nowrap;text-overflow:ellipsis;padding:9px 12px;font-family:monospace;}'
      + '.ss-copy-btn{background:rgba(113,255,0,.12);border:none;cursor:pointer;color:#71ff00;font-size:11px;font-weight:800;padding:9px 13px;font-family:inherit;flex-shrink:0;transition:background .15s;}'
      + '.ss-copy-btn:hover{background:rgba(113,255,0,.22);}'
      + '.ss-cancel{display:block;width:calc(100% - 28px);margin:0 14px 14px;padding:13px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.09);border-radius:12px;color:rgba(255,255,255,.55);font-size:14px;font-weight:700;cursor:pointer;font-family:inherit;transition:background .15s;}'
      + '.ss-cancel:hover{background:rgba(255,255,255,.1);}';
    document.head.appendChild(s);
  }

  function destroy() {
    var el = document.getElementById('sokoni-share-overlay');
    if (el) el.remove();
  }

  function copyText(text, btn, resetLabel) {
    var fallback = function () {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    };
    (navigator.clipboard ? navigator.clipboard.writeText(text).catch(fallback) : Promise.resolve(fallback()));
    if (btn) {
      btn.textContent = 'Copied!';
      setTimeout(function () { btn.textContent = resetLabel || 'Copy'; }, 2000);
    }
  }

  function open(data) {
    ensureStyles();
    destroy();

    var name  = data.name        || 'Check this out';
    var price = data.price       ? 'KES ' + Number(data.price).toLocaleString() : '';
    var image = data.image       || 'assets/Sokoni Logo.png';
    var url   = data.url         || window.location.href;
    var desc  = data.description || (name + ' — on SOKONI Kenya\'s Marketplace');
    var waMsg = 'Check out "' + name + '"' + (price ? ' at ' + price : '') + ' on SOKONI: ' + url;
    var twTxt = '"' + name + '"' + (price ? ' at ' + price : '') + ' — SOKONI Kenya! ' + url;

    var overlay = document.createElement('div');
    overlay.id = 'sokoni-share-overlay';
    overlay.innerHTML =
      '<div id="sokoni-share-sheet">'
      + '<div class="ss-handle"></div>'
      + '<div class="ss-preview">'
      + '<img class="ss-thumb" src="' + image + '" alt="' + name + '" onerror="this.src=\'assets/Sokoni Logo.png\'">'
      + '<div><p class="ss-name">' + name + '</p>' + (price ? '<p class="ss-price">' + price + '</p>' : '') + '</div>'
      + '</div>'
      + '<div class="ss-grid">'
      + '<button class="ss-btn" id="_ss_wa"><span class="ss-ico wa">💬</span>WhatsApp</button>'
      + '<button class="ss-btn" id="_ss_cp"><span class="ss-ico cp">🔗</span>Copy Link</button>'
      + '<button class="ss-btn" id="_ss_tw"><span class="ss-ico tw">𝕏</span>Twitter</button>'
      + '<button class="ss-btn" id="_ss_nt"><span class="ss-ico nt">' + (navigator.share ? '↑' : '📧') + '</span>' + (navigator.share ? 'More' : 'Email') + '</button>'
      + '</div>'
      + '<div class="ss-link-row"><span class="ss-link-txt">' + url + '</span><button class="ss-copy-btn" id="_ss_lcp">Copy</button></div>'
      + '<button class="ss-cancel" id="_ss_cancel">Cancel</button>'
      + '</div>';

    overlay.addEventListener('click', function (e) { if (e.target === overlay) destroy(); });
    document.body.appendChild(overlay);

    document.getElementById('_ss_wa').addEventListener('click', function () {
      window.open('https://wa.me/?text=' + encodeURIComponent(waMsg), '_blank');
    });
    document.getElementById('_ss_tw').addEventListener('click', function () {
      window.open('https://twitter.com/intent/tweet?text=' + encodeURIComponent(twTxt), '_blank');
    });
    document.getElementById('_ss_cp').addEventListener('click', function () {
      copyText(url, document.getElementById('_ss_lcp'), 'Copy');
      var ico = this.querySelector('.ss-ico');
      if (ico) { ico.textContent = '✅'; setTimeout(function () { ico.textContent = '🔗'; }, 2000); }
    });
    document.getElementById('_ss_lcp').addEventListener('click', function () {
      copyText(url, this, 'Copy');
    });
    document.getElementById('_ss_cancel').addEventListener('click', destroy);
    document.getElementById('_ss_nt').addEventListener('click', function () {
      if (navigator.share) {
        navigator.share({ title: name, text: desc, url: url }).catch(function () {});
      } else {
        window.location.href = 'mailto:?subject=' + encodeURIComponent(name) + '&body=' + encodeURIComponent(desc + '\n\n' + url);
      }
    });
  }

  window.SokoniShare = { open: open };
})();
