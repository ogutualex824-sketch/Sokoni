/* SOKONI — Shop Setup persistence tracer (TEMPORARY, opt-in)
 * ---------------------------------------------------------------------------
 * Enable with ?shopdiag=1 on /seller. Off for everyone else, always.
 *
 * WHY
 * The backend is proven: test-kasshop-boundary.js shows save → fresh read returns the same
 * shopId and values against real Firestore. The device still loses them. So the value
 * disappears in exactly one of three places, and guessing which has already cost enough:
 *
 *     1. before getShopProfile   — the save never landed, or landed on another shop
 *     2. in its response          — Firestore returned different data
 *     3. after the response       — something overwrote the form
 *
 * This answers that directly rather than by inference:
 *
 *   · the BUILD the device is actually executing, read from /version.json with a cache-buster
 *     (a PWA can serve a stale bundle while the console insists the deploy succeeded)
 *   · the authenticated UID
 *   · every saveShopProfile / getShopProfile request and response, verbatim
 *   · every write to the shop-name and description inputs, WITH THE STACK that made it
 *
 * That last one is the point. If the form ends up blank, the recorder names the function that
 * blanked it. If nothing wrote after the Firestore response, the loss is upstream and the UI is
 * innocent.
 *
 * Reads and reports. It never writes to Firestore, never changes what is sent, and returns
 * every value it intercepts unchanged.
 */
(function (root, doc) {
  'use strict';
  if (!root || !doc) return;
  try { if (!/[?&]shopdiag=1\b/.test(root.location.search)) return; } catch (_) { return; }

  var LOG = [];
  var t0 = Date.now();
  var ms = function () { return String(Date.now() - t0).padStart(5, ' ') + 'ms'; };

  function rec(kind, text, detail) {
    LOG.push({ t: ms(), kind: kind, text: text, detail: detail || null });
    try { console.info('[shopdiag ' + ms() + '] ' + kind + ' :: ' + text, detail || ''); } catch (_) {}
    paint();
  }

  /* ── Panel ──────────────────────────────────────────────────────────────── */
  var panel, body;
  function ensure() {
    if (panel) return;
    panel = doc.createElement('div');
    panel.id = '_shopDiag';
    panel.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;'
      + 'max-height:47vh;overflow:auto;background:#07130a;color:#c9ffd2;'
      + 'font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;'
      + 'border-top:2px solid #71ff00;padding:8px 10px 14px;'
      + '-webkit-overflow-scrolling:touch;overscroll-behavior:contain;';
    var head = doc.createElement('div');
    head.style.cssText = 'display:flex;gap:8px;align-items:center;margin-bottom:6px;'
      + 'position:sticky;top:0;background:#07130a;padding-bottom:4px;';
    head.innerHTML = '<strong style="color:#71ff00">SHOP PERSISTENCE TRACE</strong>';
    var copy = doc.createElement('button');
    copy.textContent = 'Copy';
    copy.style.cssText = 'margin-left:auto;background:#71ff00;color:#000;border:0;border-radius:6px;'
      + 'padding:5px 12px;font-weight:800;font-size:11px;font-family:inherit;';
    copy.onclick = function () {
      var text = LOG.map(function (l) {
        return l.t + '  ' + l.kind + '  ' + l.text + (l.detail ? '\n        ' + l.detail : '');
      }).join('\n');
      try { navigator.clipboard.writeText(text); copy.textContent = 'Copied'; }
      catch (_) { copy.textContent = 'Select manually'; }
      setTimeout(function () { copy.textContent = 'Copy'; }, 1800);
    };
    var hide = doc.createElement('button');
    hide.textContent = 'Hide';
    hide.style.cssText = copy.style.cssText.replace('#71ff00', '#333').replace('color:#000', 'color:#fff');
    hide.onclick = function () { panel.style.display = 'none'; };
    head.appendChild(copy); head.appendChild(hide);
    body = doc.createElement('pre');
    body.style.cssText = 'margin:0;white-space:pre-wrap;word-break:break-word;';
    panel.appendChild(head); panel.appendChild(body);
    (doc.body || doc.documentElement).appendChild(panel);
  }

  var COLOR = { BUILD: '#8ecbff', AUTH: '#ffd479', CALL: '#71ff00', RESP: '#71ff00',
                ERROR: '#ff6b6b', WRITE: '#ff9de2', NOTE: '#c9ffd2' };
  function paint() {
    ensure();
    if (!body) return;
    body.innerHTML = LOG.map(function (l) {
      var c = COLOR[l.kind] || '#c9ffd2';
      var esc = function (s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      };
      return '<span style="opacity:.5">' + esc(l.t) + '</span> '
           + '<span style="color:' + c + ';font-weight:700">' + esc(l.kind) + '</span> '
           + esc(l.text)
           + (l.detail ? '\n         <span style="opacity:.75">' + esc(l.detail) + '</span>' : '');
    }).join('\n');
  }

  var short = function (v, n) {
    try { var s = typeof v === 'string' ? v : JSON.stringify(v); return s.length > (n || 400) ? s.slice(0, n || 400) + '…' : s; }
    catch (_) { return String(v); }
  };

  /* ── 1. WHICH BUILD IS THIS DEVICE ACTUALLY RUNNING? ────────────────────────
     Never trust "the deploy succeeded". A PWA can hold an older bundle while the server has a
     newer one, so the page reports the build it is executing AND what the server currently
     serves. If these disagree, everything below is being observed on the wrong code. */
  rec('BUILD', 'page loaded from ' + location.pathname + location.search);
  try {
    fetch('/version.json?cb=' + Math.random().toString(36).slice(2), { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (v) {
        rec('BUILD', 'server build: ' + v.commitShort + '  (' + (v.buildTime || '?') + ')');
        var sw = (root.__SOKONI_CACHE_VERSION || (root.SOKONI && root.SOKONI.cacheVersion) || null);
        if (sw) rec('BUILD', 'page cache version: ' + sw);
        try {
          if (navigator.serviceWorker && navigator.serviceWorker.controller) {
            rec('BUILD', 'controlled by a service worker — a stale bundle is possible; '
              + 'hard-reload if the build below is not the one you deployed');
          } else {
            rec('BUILD', 'no service-worker controller — this document came from the network');
          }
        } catch (_) {}
      })
      .catch(function (e) { rec('ERROR', 'version.json unreadable', String(e && e.message || e)); });
  } catch (e) { rec('ERROR', 'version fetch threw', String(e && e.message || e)); }

  /* ── 2. AUTH ───────────────────────────────────────────────────────────── */
  (function watchAuth() {
    var reported = null, tries = 0;
    (function poll() {
      tries++;
      var a = null;
      try { a = root.firebaseAuth || (root.firebase && root.firebase.auth && root.firebase.auth()); } catch (_) {}
      var uid = null;
      try { uid = a && a.currentUser && a.currentUser.uid; } catch (_) {}
      if (uid && uid !== reported) { reported = uid; rec('AUTH', 'uid = ' + uid); }
      if (!uid && tries === 40) rec('AUTH', 'still no uid after ~10s — reads will resolve to "no shop"');
      if (tries < 200) setTimeout(poll, 250);
    })();
  })();

  /* ── 3. EVERY CALLABLE REQUEST AND RESPONSE ─────────────────────────────── */
  (function wrapCallable() {
    var installed = false;
    (function poll() {
      if (!installed && typeof root.sokoniCallable === 'function') {
        installed = true;
        var orig = root.sokoniCallable;
        root.sokoniCallable = function (name) {
          var fn = orig(name);
          if (!/^(getShopProfile|saveShopProfile|setShopAvailability|getMyMinishop)$/.test(name)) return fn;
          return function (payload) {
            rec('CALL', name + ' →', short(payload));
            var started = Date.now();
            return fn(payload).then(function (res) {
              var d = res && res.data;
              rec('RESP', name + ' ← ' + (Date.now() - started) + 'ms', short(d, 700));
              /* Call out the two fields under test so the answer is readable at a glance. */
              if (d && d.profile) {
                rec('NOTE', 'returned name="' + (d.profile.name || '') + '"  about="'
                  + (d.profile.about || '') + '"  shopId=' + (d.shopId || 'null')
                  + '  exists=' + d.exists);
              } else if (d && d.shopId) {
                rec('NOTE', 'save returned shopId=' + d.shopId + '  created=' + d.created);
              }
              return res;
            }).catch(function (e) {
              rec('ERROR', name + ' FAILED after ' + (Date.now() - started) + 'ms',
                  (e && (e.code || '')) + ' ' + (e && e.message || e));
              throw e;
            });
          };
        };
        rec('NOTE', 'callable tracer installed');
      }
      if (!installed) setTimeout(poll, 100);
    })();
  })();

  /* ── 4. WHO WRITES THE FORM FIELDS ──────────────────────────────────────────
     The decisive instrument. Every assignment to these inputs is recorded with the stack that
     performed it, so "the form went blank" stops being a mystery: whatever wrote last is named.
     A write of '' after the Firestore response is the bug; no write after it means the value
     never arrived and the UI is innocent. */
  (function watchFields() {
    var WATCH = ['swStoreName', 'swAbout', 'swTagline', 'swPhone', 'swCity'];
    var done = {};
    (function poll() {
      WATCH.forEach(function (id) {
        if (done[id]) return;
        var el = doc.getElementById(id);
        if (!el) return;
        done[id] = true;
        var proto = Object.getPrototypeOf(el);
        var desc = Object.getOwnPropertyDescriptor(proto, 'value');
        if (!desc || !desc.set) return;
        try {
          Object.defineProperty(el, 'value', {
            configurable: true,
            get: function () { return desc.get.call(this); },
            set: function (v) {
              var where = '';
              try {
                where = (new Error().stack || '').split('\n').slice(2, 5)
                  .map(function (s) { return s.trim().replace(/^at\s+/, ''); })
                  .filter(Boolean).join(' ← ');
              } catch (_) {}
              rec('WRITE', id + ' = "' + String(v == null ? '' : v).slice(0, 60) + '"'
                  + (String(v || '') === '' ? '   ← BLANKED' : ''), where);
              return desc.set.call(this, v);
            },
          });
        } catch (_) {}
      });
      if (Object.keys(done).length < WATCH.length) setTimeout(poll, 200);
      else rec('NOTE', 'field recorder installed on ' + WATCH.join(', '));
    })();
  })();

  /* ── 5. What the cache held at boot ─────────────────────────────────────── */
  try {
    var cached = localStorage.getItem('sokoniStore');
    rec('NOTE', 'localStorage.sokoniStore at boot: ' + (cached ? short(JSON.parse(cached).name + ' / ' + JSON.parse(cached).about, 120) : 'ABSENT'));
  } catch (_) { rec('NOTE', 'localStorage.sokoniStore unreadable'); }

  root.__shopDiagLog = LOG;
  paint();
})(typeof window !== 'undefined' ? window : null,
   typeof document !== 'undefined' ? document : null);
