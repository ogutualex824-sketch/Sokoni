/* ══════════════════════════════════════════════════════════════════════
   SOKONI Avatar — the one canonical profile-image system.

   Replaces per-page avatar logic. Two jobs:

     1. RESOLVE — given a user, produce a URL that always renders. Every
        failure mode (null, '', invalid, 404, expired token, deleted
        object, offline) lands on the platform mark. A broken-image icon
        or an empty circle is never a reachable state.

     2. UPLOAD — put the image in Cloud Storage and store a URL.

   Why upload had to change: profile.html read the file with
   FileReader.readAsDataURL and wrote the base64 straight into
   users/{uid}.avatarUrl. Firestore documents are capped at 1 MiB and
   base64 inflates by ~1.37x, so any photo over ~730 KB — which is
   essentially every phone photo — made the write fail. The write was
   also fire-and-forget, so the success toast fired regardless and the
   avatar was simply gone on reload. That is the whole "upload is
   unreliable / avatar is blank" report.

   storage.rules already had the right home for these (profile-avatars/
   {uid}/, owner-only write, safeImageOnly(), < 5 MB, public read) — the
   client just never used it. This module uses it; no rules change.

   Everything here degrades safely: with no network, no Firebase, or an
   anonymous visitor, resolve() still returns a rendering URL.
══════════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  /* Absolute so it resolves identically from /shop/{handle} and /@{handle}
     as from the root — a relative path breaks on nested routes. */
  var DEFAULT_AVATAR = '/assets/logosokoni.png';

  var SDK        = 'https://www.gstatic.com/firebasejs/10.12.2/';
  var MAX_EDGE   = 512;               /* px — display is <= 160, 512 covers retina */
  var JPEG_Q     = 0.85;
  var MAX_BYTES  = 5 * 1024 * 1024;   /* must match storage.rules */
  var OK_TYPES   = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif'];
  var CHANNEL    = 'sokoni-avatar';
  var LS_KEY     = 'sokoniAvatarUrl';

  var _subs = [];
  var _bc   = null;
  try { _bc = ('BroadcastChannel' in root) ? new BroadcastChannel(CHANNEL) : null; } catch (_) { _bc = null; }

  /* ── Resolution ──────────────────────────────────────────────────────
     Order: Auth photoURL, then the Firestore profile mirror, then the
     platform mark. A data: URL left over from the old upload path is
     still honoured so existing users don't regress to the default the
     moment this ships. */
  function resolve(user) {
    var u = user || {};
    var candidates = [u.photoURL, u.avatarUrl, u.avatar, u.photo];
    for (var i = 0; i < candidates.length; i++) {
      var c = candidates[i];
      if (typeof c === 'string' && c.trim() && c !== 'null' && c !== 'undefined') return c.trim();
    }
    return DEFAULT_AVATAR;
  }

  /* Point an <img> at a user and guarantee it renders. The flag stops the
     handler re-entering if the default itself ever fails to load. */
  function bind(img, user) {
    if (!img) return;
    img.addEventListener('error', _onImgError);
    img.setAttribute('data-avatar', '1');
    var next = resolve(user);
    if (img.src !== next) img.src = next;
  }

  function _onImgError(e) {
    var img = e.target || this;
    if (!img || img.dataset.avatarFallback === '1') return;
    img.dataset.avatarFallback = '1';
    img.src = DEFAULT_AVATAR;
  }

  /* Safety net for markup this module never touched: any <img> that fails
     and looks like an avatar gets the default. Capture phase — image
     error events do not bubble. */
  function _installGlobalNet() {
    root.document.addEventListener('error', function (e) {
      var el = e.target;
      if (!el || el.tagName !== 'IMG') return;
      if (el.dataset.avatarFallback === '1') return;
      var looksLikeAvatar = el.hasAttribute('data-avatar') ||
        /avatar|profile|photo/i.test((el.className || '') + ' ' + (el.id || ''));
      if (!looksLikeAvatar) return;
      el.dataset.avatarFallback = '1';
      el.src = DEFAULT_AVATAR;
    }, true);
  }

  /* ── Downscale ───────────────────────────────────────────────────────
     Keeps the upload small and fast. If the browser cannot decode the
     format (iOS HEIC is the usual one), fall back to the original file
     rather than failing the upload — the rules cap already bounds it. */
  function _downscale(file) {
    return new Promise(function (done) {
      if (!root.document || !root.URL || !root.URL.createObjectURL) return done(file);
      var url = root.URL.createObjectURL(file);
      var img = new Image();
      var settled = false;
      var finish = function (v) {
        if (settled) return;
        settled = true;
        try { root.URL.revokeObjectURL(url); } catch (_) {}
        done(v);
      };
      /* A decode that never settles must not hang the upload forever. */
      setTimeout(function () { finish(file); }, 10000);
      img.onerror = function () { finish(file); };
      img.onload = function () {
        try {
          var w = img.naturalWidth, h = img.naturalHeight;
          if (!w || !h) return finish(file);
          var scale = Math.min(1, MAX_EDGE / Math.max(w, h));
          var cw = Math.max(1, Math.round(w * scale));
          var ch = Math.max(1, Math.round(h * scale));
          var canvas = root.document.createElement('canvas');
          canvas.width = cw; canvas.height = ch;
          var ctx = canvas.getContext('2d');
          if (!ctx) return finish(file);
          ctx.drawImage(img, 0, 0, cw, ch);
          canvas.toBlob(function (blob) {
            /* Only take the re-encode if it actually helped. */
            finish(blob && blob.size && blob.size < file.size ? blob : file);
          }, 'image/jpeg', JPEG_Q);
        } catch (_) { finish(file); }
      };
      img.src = url;
    });
  }

  /* ── Upload ──────────────────────────────────────────────────────────
     Returns the download URL, or throws with a message worth showing.
     Nothing here is fire-and-forget: the caller can await it and a
     failure is a rejected promise, not a console warning under a
     success toast. */
  async function upload(file, opts) {
    opts = opts || {};
    if (!file) throw new Error('No file selected.');

    var type = (file.type || '').toLowerCase();
    if (type && OK_TYPES.indexOf(type) === -1) {
      throw new Error('That file type is not supported. Use JPG, PNG or WebP.');
    }
    if (file.size > MAX_BYTES) {
      throw new Error('That image is larger than 5 MB. Please choose a smaller one.');
    }

    var auth = root.firebaseAuth;
    var uid  = opts.uid || (auth && auth.currentUser && auth.currentUser.uid);
    if (!uid) throw new Error('Please sign in to change your photo.');
    if (!root.firebaseStorage) throw new Error('Storage is unavailable. Check your connection and try again.');

    var blob = await _downscale(file);

    var storageMod = await import(SDK + 'firebase-storage.js');
    /* Timestamped name rather than a fixed one: the URL changes on every
       upload, so no CDN, service-worker or <img> cache can serve the
       previous photo. Cache invalidation by naming, not by busting. */
    var path = 'profile-avatars/' + uid + '/avatar_' + Date.now() + '.jpg';
    var ref  = storageMod.ref(root.firebaseStorage, path);

    await storageMod.uploadBytes(ref, blob, {
      contentType:  blob.type || 'image/jpeg',
      cacheControl: 'public,max-age=31536000,immutable',
    });
    var url = await storageMod.getDownloadURL(ref);

    /* Persist to both readers. Firestore is the profile mirror; Auth
       photoURL is what most surfaces read first. Storage already
       succeeded, so a failure here is reported, not swallowed. */
    if (root.firebaseDB) {
      var fs = await import(SDK + 'firebase-firestore.js');
      await fs.setDoc(fs.doc(root.firebaseDB, 'users', uid), {
        avatarUrl: url, photoURL: url, updatedAt: new Date().toISOString(),
      }, { merge: true });
    }
    if (auth && auth.currentUser) {
      try {
        var am = await import(SDK + 'firebase-auth.js');
        await am.updateProfile(auth.currentUser, { photoURL: url });
      } catch (_) { /* non-fatal: Firestore is already authoritative */ }
    }

    _broadcast(url);
    return url;
  }

  /* ── Propagation ─────────────────────────────────────────────────────
     Every open tab updates without a reload: same-tab subscribers get
     called directly, other tabs via BroadcastChannel, with the storage
     event as the fallback where BroadcastChannel is unavailable. */
  function _broadcast(url) {
    _emit(url);
    try { if (_bc) _bc.postMessage({ url: url, at: Date.now() }); } catch (_) {}
    try { root.localStorage.setItem(LS_KEY, url); } catch (_) {}
  }

  function _emit(url) {
    /* Repaint anything already bound before notifying subscribers. */
    try {
      var imgs = root.document.querySelectorAll('img[data-avatar]');
      for (var i = 0; i < imgs.length; i++) {
        delete imgs[i].dataset.avatarFallback;
        imgs[i].src = url;
      }
    } catch (_) {}
    for (var j = 0; j < _subs.length; j++) {
      try { _subs[j](url); } catch (_) {}
    }
  }

  function onChange(cb) {
    if (typeof cb !== 'function') return function () {};
    _subs.push(cb);
    return function () { _subs = _subs.filter(function (f) { return f !== cb; }); };
  }

  if (_bc) _bc.onmessage = function (e) { if (e && e.data && e.data.url) _emit(e.data.url); };
  root.addEventListener('storage', function (e) {
    if (e && e.key === LS_KEY && e.newValue) _emit(e.newValue);
  });

  if (root.document) {
    if (root.document.readyState === 'loading') {
      root.document.addEventListener('DOMContentLoaded', _installGlobalNet);
    } else {
      _installGlobalNet();
    }
  }

  root.SokoniAvatar = {
    DEFAULT: DEFAULT_AVATAR,
    resolve: resolve,
    bind:    bind,
    upload:  upload,
    onChange: onChange,
    MAX_BYTES: MAX_BYTES,
  };
})(typeof window !== 'undefined' ? window : this);
