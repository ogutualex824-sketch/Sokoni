/* ================================================================
   SOKONI — Media Engine  v1.0.0
   Central upload center, pre-processing pipeline, asset library,
   and offline upload queue. Used by every Sokoni module:
   Marketplace, SmartPOS, Food, Logistics, Events, Property,
   Vehicles, Services, Advertising, and Seller Dashboard.

   Key capabilities:
   • Drag-and-drop / multi-select / bulk / folder upload
   • SHA-256 deduplication — one master copy per unique file
   • Browser-native compression → WebP with thumbnail generation
   • Chunked resumable uploads with background progress
   • IndexedDB offline queue — auto-flush when connectivity returns
   • Firestore asset library: search, tag, tier management
   • Storage cost analytics (bytes saved, compression ratio)

   Pattern : IIFE → window.SokoniMedia
   Requires: window.SokoniUpload (sokoni-upload.js)
             window.firebaseDB   (firebase.js)
             window.firebaseAuth (firebase.js)
             window.firebaseStorage (firebase.js)
================================================================ */
(function (global) {
  'use strict';

  const VERSION  = '1.0.0';
  const IDB_NAME = 'sokoni-media-v1';
  const IDB_VER  = 1;

  /* ── Upload limits (MB) ─────────────────────────────────────── */
  const LIMITS = {
    image:    15,
    video:   150,
    audio:    30,
    document: 20,
    max:     200,
  };

  /* ── Storage paths per asset destination ─────────────────────── */
  const PATHS = {
    product:   uid => `product-images/${uid}`,
    story:     uid => `provider-stories/${uid}`,
    banner:    uid => `creative-assets/${uid}/banners`,
    logo:      uid => `creative-assets/${uid}/logos`,
    poster:    uid => `creative-assets/${uid}/posters`,
    brand:     uid => `creative-assets/${uid}/brand`,
    document:  uid => `documents/${uid}`,
    receipt:   uid => `creative-assets/${uid}/receipts`,
    menu:      uid => `creative-assets/${uid}/menus`,
    event:     uid => `creative-assets/${uid}/events`,
    property:  uid => `creative-assets/${uid}/property`,
    vehicle:   uid => `creative-assets/${uid}/vehicles`,
    delivery:  uid => `creative-assets/${uid}/delivery`,
    community: uid => `community-media/${uid}`,
    avatar:    uid => `profile-avatars/${uid}`,
    seller:    uid => `seller-assets/${uid}`,
    ai:        uid => `creative-assets/${uid}/ai-generated`,
  };

  /* ── Firestore dynamic import helper ────────────────────────── */
  let _fsCache = null;
  async function fs() {
    if (_fsCache) return _fsCache;
    _fsCache = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
    return _fsCache;
  }

  function db()   { return global.firebaseDB; }
  function auth() { return global.firebaseAuth; }
  function uid()  { return auth()?.currentUser?.uid || null; }

  /* ================================================================
     IndexedDB — offline upload queue + asset cache
  ================================================================ */
  let _idb = null;

  function openIDB() {
    if (_idb) return Promise.resolve(_idb);
    return new Promise((res, rej) => {
      const req = indexedDB.open(IDB_NAME, IDB_VER);
      req.onupgradeneeded = e => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains('uploadQueue')) {
          const os = d.createObjectStore('uploadQueue', { keyPath: 'id', autoIncrement: true });
          os.createIndex('status', 'status');
          os.createIndex('uid',    'uid');
        }
        if (!d.objectStoreNames.contains('hashCache')) {
          d.createObjectStore('hashCache', { keyPath: 'hash' });
        }
      };
      req.onsuccess = e => { _idb = e.target.result; res(_idb); };
      req.onerror   = e => rej(e.target.error);
    });
  }

  async function idbPut(store, record) {
    const d = await openIDB();
    return new Promise((res, rej) => {
      const tx  = d.transaction(store, 'readwrite');
      const req = tx.objectStore(store).put(record);
      req.onsuccess = () => res(req.result);
      req.onerror   = () => rej(req.error);
    });
  }

  async function idbGet(store, key) {
    const d = await openIDB();
    return new Promise((res, rej) => {
      const req = d.transaction(store, 'readonly').objectStore(store).get(key);
      req.onsuccess = () => res(req.result || null);
      req.onerror   = () => rej(req.error);
    });
  }

  async function idbGetByIndex(store, index, value) {
    const d = await openIDB();
    return new Promise((res, rej) => {
      const req = d.transaction(store, 'readonly').objectStore(store).index(index).getAll(value);
      req.onsuccess = () => res(req.result || []);
      req.onerror   = () => rej(req.error);
    });
  }

  async function idbDelete(store, key) {
    const d = await openIDB();
    return new Promise((res, rej) => {
      const req = d.transaction(store, 'readwrite').objectStore(store).delete(key);
      req.onsuccess = () => res();
      req.onerror   = () => rej(req.error);
    });
  }

  async function idbPatch(store, id, patch) {
    const d = await openIDB();
    return new Promise((res, rej) => {
      const tx = d.transaction(store, 'readwrite');
      const os = tx.objectStore(store);
      const get = os.get(id);
      get.onsuccess = () => {
        const updated = { ...(get.result || {}), ...patch, id };
        const put = os.put(updated);
        put.onsuccess = () => res();
        put.onerror   = () => rej(put.error);
      };
      get.onerror = () => rej(get.error);
    });
  }

  /* ================================================================
     SHA-256 fingerprinting — deduplication
  ================================================================ */
  async function hashFile(file) {
    const buf    = await file.arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(digest))
                .map(b => b.toString(16).padStart(2, '0'))
                .join('');
  }

  /* ================================================================
     Duplicate detection
     Checks local IDB cache first, then Firestore.
  ================================================================ */
  async function checkDuplicate(hash) {
    const local = await idbGet('hashCache', hash);
    if (local) return local;
    try {
      const { collection, query, where, getDocs, limit } = await fs();
      const q    = query(collection(db(), 'mediaAssets'), where('hash', '==', hash), limit(1));
      const snap = await getDocs(q);
      if (!snap.empty) {
        const data = { id: snap.docs[0].id, ...snap.docs[0].data() };
        await idbPut('hashCache', { hash, ...data });
        return data;
      }
    } catch { /* network unavailable */ }
    return null;
  }

  /* ================================================================
     Pre-processing pipeline
     Compress → WebP → thumbnail → metadata strip → hash
  ================================================================ */
  async function preProcess(file, dest) {
    const hash = await hashFile(file);
    const dup  = await checkDuplicate(hash);
    if (dup) return { duplicate: dup, hash, processed: file, thumb: null, meta: {} };

    const isImg = file.type.startsWith('image/');
    let processed = file;
    let thumb     = null;
    const meta    = { originalSize: file.size, format: file.type };

    if (isImg && global.SokoniUpload?.compressImage) {
      try {
        const full = await global.SokoniUpload.compressImage(file, {
          maxW: 1920, maxH: 1920, quality: 0.85, format: 'webp',
        });
        processed = new File([full], file.name.replace(/\.[^.]+$/, '.webp'), { type: 'image/webp' });
        meta.processedSize = full.size;
        meta.savings       = Math.round((1 - full.size / file.size) * 100);
        meta.format        = 'webp';

        const t = await global.SokoniUpload.compressImage(file, {
          maxW: 320, maxH: 320, quality: 0.72, format: 'webp',
        });
        thumb = new File([t], `th_${processed.name}`, { type: 'image/webp' });
      } catch { /* keep original on compress failure */ }
    }

    const u    = uid() || 'anon';
    const base = PATHS[dest] ? PATHS[dest](u) : `creative-assets/${u}`;
    const ts   = Date.now();
    const ext  = processed.name.split('.').pop();
    const path = `${base}/${ts}_${hash.slice(0, 10)}.${ext}`;

    return { duplicate: null, hash, processed, thumb, meta, path };
  }

  /* ================================================================
     Core upload — single file
  ================================================================ */
  async function upload(file, dest = 'product', opts = {}) {
    const { onProgress, tags = [], context = {}, skipDedupe = false } = opts;
    const u = uid();
    if (!u) throw new Error('Authentication required to upload.');

    const limitKey = file.type.startsWith('image/') ? 'image'
                   : file.type.startsWith('video/') ? 'video'
                   : file.type.startsWith('audio/') ? 'audio'
                   : 'document';
    const limitMB = LIMITS[limitKey];
    if (file.size > limitMB * 1024 * 1024) {
      throw new Error(`File exceeds ${limitMB} MB limit for ${limitKey} uploads.`);
    }

    const pp = skipDedupe
      ? {
          duplicate: null, hash: await hashFile(file),
          processed: file, thumb: null, meta: {},
          path: `${PATHS[dest]?.(u) || `creative-assets/${u}`}/${Date.now()}_${file.name}`,
        }
      : await preProcess(file, dest);

    if (pp.duplicate) {
      _emitEvent('duplicate-hit', { hash: pp.hash, dest });
      return { ...pp.duplicate, fromCache: true };
    }

    /* Upload processed file */
    const url = await global.SokoniUpload.uploadToStorage(pp.processed, pp.path, onProgress);

    /* Upload thumbnail silently in background */
    let thumbUrl = url;
    if (pp.thumb) {
      const tPath = pp.path.replace(/\/([^/]+)$/, '/th_$1');
      global.SokoniUpload.uploadToStorage(pp.thumb, tPath)
        .then(tu => { thumbUrl = tu; })
        .catch(() => {});
    }

    /* Persist asset record */
    const asset = {
      uid:          u,
      hash:         pp.hash,
      url,
      thumbUrl,
      path:         pp.path,
      dest,
      fileName:     file.name,
      mimeType:     pp.processed.type,
      originalSize: file.size,
      storedSize:   pp.processed.size || file.size,
      savings:      pp.meta.savings || 0,
      tags,
      context,
      tier:         'hot',
      aiMetadata:   null,
      createdAt:    Date.now(),
      accessCount:  0,
      lastAccessed: Date.now(),
    };

    try {
      const { collection: col, addDoc } = await fs();
      const ref = await addDoc(col(db(), 'mediaAssets'), asset);
      asset.id = ref.id;
      await idbPut('hashCache', { hash: pp.hash, ...asset });
    } catch { /* Firestore unavailable — local cache only */ }

    _trackAnalytic('upload', {
      uid: u, dest, mimeType: asset.mimeType,
      originalSize: file.size, storedSize: asset.storedSize,
      savings: asset.savings,
    });

    _emitEvent('upload-complete', asset);
    return asset;
  }

  /* ================================================================
     Bulk upload
  ================================================================ */
  async function uploadBulk(files, dest, opts = {}) {
    const { onProgress, onEach } = opts;
    const arr     = Array.from(files);
    const results = [];
    let done = 0;

    for (const file of arr) {
      try {
        const asset = await upload(file, dest, {
          ...opts,
          onProgress: pct => {
            if (onProgress) {
              onProgress(Math.round(((done + pct / 100) / arr.length) * 100));
            }
          },
        });
        const r = { ok: true, asset, file };
        results.push(r);
        if (onEach) onEach(r);
      } catch (err) {
        const r = { ok: false, error: err.message, file };
        results.push(r);
        if (onEach) onEach(r);
      }
      done++;
      if (onProgress) onProgress(Math.round((done / arr.length) * 100));
    }
    return results;
  }

  /* ================================================================
     Offline queue — enqueue when offline, auto-flush when online
  ================================================================ */
  async function enqueue(file, dest, opts = {}) {
    if (navigator.onLine) return upload(file, dest, opts);
    const u = uid() || 'anon';
    const id = await idbPut('uploadQueue', {
      uid:        u,
      dest,
      opts:       { tags: opts.tags || [], context: opts.context || {} },
      fileName:   file.name,
      mimeType:   file.type,
      size:       file.size,
      blob:       file,
      status:     'pending',
      enqueuedAt: Date.now(),
    });
    _emitEvent('queued', { id, fileName: file.name });
    return { queued: true, id };
  }

  async function flushQueue() {
    if (!navigator.onLine) return { flushed: 0, remaining: 0 };
    const u = uid();
    if (!u) return { flushed: 0, remaining: 0 };
    const jobs = await idbGetByIndex('uploadQueue', 'uid', u);
    const pending = jobs.filter(j => j.status === 'pending');
    let flushed = 0;

    for (const job of pending) {
      try {
        await idbPatch('uploadQueue', job.id, { status: 'uploading' });
        const file = new File([job.blob], job.fileName, { type: job.mimeType });
        await upload(file, job.dest, job.opts);
        await idbDelete('uploadQueue', job.id);
        flushed++;
      } catch {
        await idbPatch('uploadQueue', job.id, { status: 'failed', failedAt: Date.now() });
      }
    }
    return { flushed, remaining: pending.length - flushed };
  }

  global.addEventListener('online', () => flushQueue().catch(() => {}));

  /* ================================================================
     Asset library — Firestore queries
  ================================================================ */
  async function getAssets(filters = {}) {
    const u = uid();
    if (!u) return [];
    try {
      const { collection, query, where, orderBy, limit: lim, getDocs } = await fs();
      const constraints = [where('uid', '==', u), orderBy('createdAt', 'desc')];
      if (filters.dest)  constraints.push(where('dest', '==', filters.dest));
      if (filters.tier)  constraints.push(where('tier', '==', filters.tier));
      constraints.push(lim(filters.limit || 50));
      const snap = await getDocs(query(collection(db(), 'mediaAssets'), ...constraints));
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch { return []; }
  }

  async function searchAssets(keyword, opts = {}) {
    const assets = await getAssets({ limit: 200, ...opts });
    const kw = keyword.toLowerCase().trim();
    if (!kw) return assets;
    return assets.filter(a =>
      a.fileName?.toLowerCase().includes(kw) ||
      a.dest?.toLowerCase().includes(kw) ||
      a.tags?.some(t => t.toLowerCase().includes(kw)) ||
      a.aiMetadata?.title?.toLowerCase().includes(kw) ||
      a.aiMetadata?.tags?.some(t => t.toLowerCase().includes(kw))
    );
  }

  async function tagAsset(assetId, tags) {
    try {
      const { doc, updateDoc } = await fs();
      await updateDoc(doc(db(), 'mediaAssets', assetId), { tags, updatedAt: Date.now() });
      return true;
    } catch { return false; }
  }

  async function deleteAsset(assetId) {
    try {
      const { doc, deleteDoc } = await fs();
      await deleteDoc(doc(db(), 'mediaAssets', assetId));
      return true;
    } catch { return false; }
  }

  async function updateAssetTier(assetId, tier) {
    try {
      const { doc, updateDoc } = await fs();
      await updateDoc(doc(db(), 'mediaAssets', assetId), { tier, tieredAt: Date.now() });
      return true;
    } catch { return false; }
  }

  /* ================================================================
     Analytics
  ================================================================ */
  async function _trackAnalytic(event, data) {
    try {
      const { collection: col, addDoc } = await fs();
      await addDoc(col(db(), 'mediaAnalytics'), { event, ...data, ts: Date.now() });
    } catch { /* non-critical */ }
  }

  async function getStats(targetUid) {
    const u = targetUid || uid();
    if (!u) return {};
    try {
      const { collection, query, where, getDocs } = await fs();
      const snap = await getDocs(query(collection(db(), 'mediaAnalytics'), where('uid', '==', u)));
      const stats = { uploads: 0, storageSaved: 0, totalSize: 0, byType: {} };
      snap.forEach(d => {
        const r = d.data();
        if (r.event === 'upload') {
          stats.uploads++;
          stats.totalSize    += (r.originalSize || 0);
          stats.storageSaved += (r.originalSize || 0) - (r.storedSize || 0);
          const t = r.mimeType?.split('/')[0] || 'other';
          stats.byType[t] = (stats.byType[t] || 0) + 1;
        }
      });
      stats.avgSavings = stats.totalSize > 0
        ? Math.round((stats.storageSaved / stats.totalSize) * 100) : 0;
      return stats;
    } catch { return {}; }
  }

  /* ================================================================
     Event bus
  ================================================================ */
  const _listeners = {};

  function on(event, fn) {
    (_listeners[event] = _listeners[event] || []).push(fn);
    return () => off(event, fn);
  }

  function off(event, fn) {
    _listeners[event] = (_listeners[event] || []).filter(f => f !== fn);
  }

  function _emitEvent(event, data) {
    (_listeners[event] || []).forEach(fn => { try { fn(data); } catch { /* ignore */ } });
    global.dispatchEvent(new CustomEvent(`sokoniMedia:${event}`, { detail: data }));
  }

  /* ================================================================
     Upload Center Modal
     Opens a self-contained drag-and-drop upload panel.
     Any Sokoni module can call SokoniMedia.openCenter({ dest, onUpload }).
  ================================================================ */
  function openCenter(opts = {}) {
    const {
      dest     = 'product',
      multiple = true,
      accept   = 'image/*,video/*,application/pdf',
      title    = 'Upload Media',
      onUpload,
      onClose,
    } = opts;

    if (!uid()) {
      alert('Please sign in to upload media.');
      return;
    }

    document.getElementById('_sm-overlay')?.remove();

    const overlay = document.createElement('div');
    overlay.id        = '_sm-overlay';
    overlay.innerHTML = `
<style>
#_sm-overlay{position:fixed;inset:0;background:rgba(0,0,0,.88);z-index:99999;display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;font-family:system-ui,-apple-system,sans-serif}
#_sm-box{background:#111;border:1px solid rgba(113,255,0,.18);border-radius:18px;width:100%;max-width:560px;max-height:92vh;overflow-y:auto;padding:26px;color:#fff}
#_sm-box::-webkit-scrollbar{width:4px}#_sm-box::-webkit-scrollbar-thumb{background:rgba(113,255,0,.3);border-radius:2px}
._smh{display:flex;justify-content:space-between;align-items:center;margin-bottom:22px}
._smttl{font-size:18px;font-weight:800;color:#71ff00;letter-spacing:-.3px}
._smx{background:none;border:none;color:rgba(255,255,255,.4);font-size:22px;cursor:pointer;line-height:1;padding:2px 6px}
._smx:hover{color:#fff}
._smzone{border:2px dashed rgba(113,255,0,.28);border-radius:14px;padding:38px 20px;text-align:center;cursor:pointer;transition:.2s;background:rgba(113,255,0,.03);margin-bottom:16px}
._smzone:hover,._smzone.drag{border-color:#71ff00;background:rgba(113,255,0,.07)}
._smzone-ico{font-size:38px;margin-bottom:10px;color:rgba(255,255,255,.3)}
._smzone p{font-size:13px;color:rgba(255,255,255,.55);line-height:1.7;margin:0}
._smzone p b{color:#71ff00}
._smzone p small{color:rgba(255,255,255,.3)}
._smq{display:flex;flex-direction:column;gap:8px;margin-bottom:16px}
._smitem{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.07);border-radius:11px;padding:11px 14px;display:flex;align-items:center;gap:12px}
._smthumb{width:42px;height:42px;border-radius:8px;object-fit:cover;background:#1a1a1a;flex-shrink:0}
._sminfo{flex:1;min-width:0}
._smfn{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:2px}
._smfs{font-size:11px;color:rgba(255,255,255,.35)}
._smbar{height:3px;background:rgba(255,255,255,.08);border-radius:2px;margin-top:7px;overflow:hidden}
._smfill{height:100%;background:linear-gradient(90deg,#71ff00,#4fc800);border-radius:2px;width:0;transition:width .25s}
._smst{font-size:11px;font-weight:700;flex-shrink:0;min-width:52px;text-align:right}
._smbtn{display:block;width:100%;padding:14px;background:#71ff00;color:#000;border:none;border-radius:12px;font-size:15px;font-weight:800;cursor:pointer;letter-spacing:.4px;transition:.15s}
._smbtn:hover{background:#5de600}
._smbtn:disabled{background:rgba(113,255,0,.25);color:rgba(0,0,0,.4);cursor:not-allowed}
._smlink{text-align:center;margin-top:12px;font-size:12px;color:rgba(255,255,255,.35);cursor:pointer;text-decoration:underline}
._smlink:hover{color:rgba(255,255,255,.6)}
._smtabs{display:flex;gap:6px;margin-bottom:14px}
._smtab{flex:1;padding:7px;border:1px solid rgba(255,255,255,.1);border-radius:8px;background:none;color:rgba(255,255,255,.4);font-size:12px;font-weight:600;cursor:pointer;transition:.15s}
._smtab.active,._smtab:hover{border-color:#71ff00;color:#71ff00;background:rgba(113,255,0,.06)}
@media(max-width:480px){#_sm-box{padding:16px}._smzone{padding:26px 14px}}
</style>
<div id="_sm-box">
  <div class="_smh">
    <div class="_smttl">${_esc(title)}</div>
    <button class="_smx" id="_smx">&#x2715;</button>
  </div>
  <div class="_smtabs">
    <button class="_smtab active" data-tab="upload">Upload</button>
    <button class="_smtab" data-tab="history">History</button>
    <button class="_smtab" data-tab="library">Library</button>
  </div>
  <div id="_sm-upload-tab">
    <div class="_smzone" id="_smzone">
      <div class="_smzone-ico">&#128247;</div>
      <p><b>Drag files here</b> or tap to browse<br>Images, videos, PDFs &amp; documents<br><small>Max ${LIMITS[dest === 'video' ? 'video' : 'image']} MB &bull; Auto-compressed to WebP</small></p>
      <input id="_sminput" type="file" ${multiple ? 'multiple' : ''} accept="${_esc(accept)}" style="display:none">
    </div>
    <div class="_smq" id="_smq"></div>
    <button class="_smbtn" id="_smbtn" disabled>Upload Files</button>
  </div>
  <div id="_sm-history-tab" style="display:none"></div>
  <div id="_sm-library-tab" style="display:none"></div>
  <div class="_smlink" id="_smadv">Open Creative Studio</div>
</div>`;

    document.body.appendChild(overlay);

    const box   = overlay.querySelector('#_sm-box');
    const zone  = overlay.querySelector('#_smzone');
    const input = overlay.querySelector('#_sminput');
    const q     = overlay.querySelector('#_smq');
    const btn   = overlay.querySelector('#_smbtn');
    let fileList = [];

    /* Close */
    const close = () => { overlay.remove(); if (onClose) onClose(); };
    overlay.querySelector('#_smx').onclick = close;
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

    /* Tab switching */
    overlay.querySelectorAll('._smtab').forEach(tab => {
      tab.addEventListener('click', () => {
        overlay.querySelectorAll('._smtab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        ['upload', 'history', 'library'].forEach(t => {
          const el = overlay.querySelector(`#_sm-${t}-tab`);
          if (el) el.style.display = tab.dataset.tab === t ? '' : 'none';
        });
        if (tab.dataset.tab === 'history') _renderHistory(overlay.querySelector('#_sm-history-tab'));
        if (tab.dataset.tab === 'library') _renderLibrary(overlay.querySelector('#_sm-library-tab'), dest);
      });
    });

    /* Drag-and-drop */
    zone.addEventListener('click', () => input.click());
    zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag'));
    zone.addEventListener('drop', e => {
      e.preventDefault(); zone.classList.remove('drag');
      addFiles(Array.from(e.dataTransfer.files));
    });
    input.addEventListener('change', () => addFiles(Array.from(input.files)));

    function fmtBytes(b) {
      if (b < 1024)       return b + ' B';
      if (b < 1048576)    return (b / 1024).toFixed(1) + ' KB';
      return (b / 1048576).toFixed(1) + ' MB';
    }

    function addFiles(files) {
      files.forEach((f, i) => {
        const idx = fileList.length;
        if (fileList.some(x => x.name === f.name && x.size === f.size)) return;
        fileList.push(f);
        const preview = f.type.startsWith('image/') ? URL.createObjectURL(f) : '';
        const row = document.createElement('div');
        row.className = '_smitem';
        row.id        = `_smf-${idx}`;
        row.innerHTML = `
          <img class="_smthumb" id="_smth-${idx}" src="${preview}" alt="" onerror="this.style.opacity='.2'">
          <div class="_sminfo">
            <div class="_smfn">${_esc(f.name)}</div>
            <div class="_smfs">${fmtBytes(f.size)} &bull; ${f.type || 'file'}</div>
            <div class="_smbar"><div class="_smfill" id="_smfi-${idx}"></div></div>
          </div>
          <div class="_smst" id="_smst-${idx}" style="color:rgba(255,255,255,.4)">Ready</div>`;
        q.appendChild(row);
      });
      btn.disabled = fileList.length === 0;
    }

    /* Upload all */
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'Uploading…';
      const uploaded = [];

      for (let i = 0; i < fileList.length; i++) {
        const st = overlay.querySelector(`#_smst-${i}`);
        const fi = overlay.querySelector(`#_smfi-${i}`);
        if (st) { st.textContent = '…'; st.style.color = '#71ff00'; }
        try {
          const asset = await upload(fileList[i], dest, {
            onProgress: pct => { if (fi) fi.style.width = pct + '%'; },
          });
          if (fi) fi.style.width = '100%';
          if (st) st.textContent = 'Done';
          uploaded.push(asset);
          if (onUpload) onUpload(asset);
        } catch (err) {
          if (st) { st.textContent = 'Error'; st.style.color = '#ff4444'; }
          console.error('[SokoniMedia] upload error:', err);
        }
      }

      btn.textContent = `Done (${uploaded.length}/${fileList.length}) — Close`;
      btn.disabled    = false;
      btn.onclick     = close;
    });

    overlay.querySelector('#_smadv').addEventListener('click', () => {
      close();
      if (global.SokoniCreative?.openStudio) global.SokoniCreative.openStudio();
    });
  }

  /* ── History panel ──────────────────────────────────────────── */
  async function _renderHistory(container) {
    container.innerHTML = '<div style="color:rgba(255,255,255,.4);font-size:13px;padding:10px 0">Loading…</div>';
    const assets = await getAssets({ limit: 20 });
    if (!assets.length) {
      container.innerHTML = '<div style="color:rgba(255,255,255,.3);font-size:13px;padding:16px 0;text-align:center">No uploads yet.</div>';
      return;
    }
    container.innerHTML = '<div style="display:flex;flex-direction:column;gap:8px">' +
      assets.map(a => `
        <div style="display:flex;align-items:center;gap:10px;padding:10px;border:1px solid rgba(255,255,255,.07);border-radius:10px;background:rgba(255,255,255,.03)">
          <img src="${_esc(a.thumbUrl || a.url)}" style="width:40px;height:40px;border-radius:7px;object-fit:cover;background:#1a1a1a" alt="" onerror="this.style.opacity='.1'">
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${_esc(a.fileName || 'Asset')}</div>
            <div style="font-size:11px;color:rgba(255,255,255,.35)">${a.dest || ''} ${a.savings ? '&bull; ' + a.savings + '% saved' : ''}</div>
          </div>
          <div style="font-size:11px;color:#71ff00;font-weight:700">${new Date(a.createdAt).toLocaleDateString()}</div>
        </div>`).join('') + '</div>';
  }

  /* ── Library panel ──────────────────────────────────────────── */
  async function _renderLibrary(container, dest) {
    container.innerHTML = '<div style="color:rgba(255,255,255,.4);font-size:13px;padding:10px 0">Loading library…</div>';
    const assets = await getAssets({ limit: 30 });
    if (!assets.length) {
      container.innerHTML = '<div style="color:rgba(255,255,255,.3);font-size:13px;padding:16px 0;text-align:center">Your media library is empty.</div>';
      return;
    }
    container.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px">
        ${assets.map(a => `
          <div style="position:relative;border-radius:10px;overflow:hidden;aspect-ratio:1;background:#1a1a1a;cursor:pointer" data-url="${_esc(a.url)}" data-id="${_esc(a.id)}">
            <img src="${_esc(a.thumbUrl || a.url)}" style="width:100%;height:100%;object-fit:cover" alt="" onerror="this.style.opacity='.1'">
            <div style="position:absolute;bottom:0;left:0;right:0;padding:4px 6px;background:linear-gradient(transparent,rgba(0,0,0,.7));font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:rgba(255,255,255,.7)">${_esc(a.fileName || '')}</div>
          </div>`).join('')}
      </div>`;
  }

  /* ── XSS-safe escaper ──────────────────────────────────────── */
  function _esc(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /* ================================================================
     Public API
  ================================================================ */
  const SokoniMedia = {
    version:      VERSION,
    upload,
    uploadBulk,
    enqueue,
    flushQueue,
    openCenter,
    checkDuplicate,
    hashFile,
    preProcess,
    getAssets,
    searchAssets,
    tagAsset,
    deleteAsset,
    updateAssetTier,
    getStats,
    on,
    off,
    PATHS,
    LIMITS,
  };

  global.SokoniMedia = SokoniMedia;
  global.dispatchEvent(new CustomEvent('sokoniMediaReady'));

})(window);
