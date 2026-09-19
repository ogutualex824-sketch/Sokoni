/* ══════════════════════════════════════════════════════════════════════════════
   EDIT PROFILE — PHOTO PERSISTENCE CERTIFICATION
   scripts/test-profile-inline-edit-photos.js

   THE DEFECT THIS PINS
   `handleAvatarUpload` and `handleCoverUpload` were repaired to upload through Cloud
   Storage. The Edit Profile form was a THIRD write path and kept the original bug for
   BOTH images:

       _ieBindPhoto -> _ieReadImage -> data URL
                    -> _ieAvatarData / _ieCoverData
       saveInlineEdit -> _user.avatarUrl = <base64>
                      -> payload.avatarUrl = <base64>  -> setDoc(users/{uid})

   A Firestore document is capped at 1 MiB and base64 inflates by ~1.37x, so any real photo
   failed the write — and the form is the primary way a buyer changes these images.

   WHAT IS ASSERTED
   The shipped functions are extracted and EXECUTED against stub DOM/SDK objects. What is
   proven is the payload the page actually produces, not that a file contains a
   promising-looking string.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (n, c, d) => {
  if (c) { pass++; console.log('  PASS  ' + n + (d ? '   [' + d + ']' : '')); }
  else { fail++; console.log('  FAIL  ' + n + (d ? '   [' + d + ']' : '')); }
};
const head = t => console.log('\n' + t);
const html = fs.readFileSync(path.join(ROOT, 'profile.html'), 'utf8');

function extractFn (src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start === -1) return null;
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return null;
}

const BIND_SRC = extractFn(html, '_ieBindPhoto');
const SAVE_SRC = extractFn(html, 'saveInlineEdit');

/* A file whose "bytes" would be far too large for a user document if they were ever
   inlined — the exact case the old path failed on. */
const bigFile = (name) => ({ name, type: 'image/jpeg', size: 3 * 1024 * 1024 });

/* ── HARNESS ─────────────────────────────────────────────────────────────────
   Builds a world, runs _ieBindPhoto's change handler for one input, then runs
   saveInlineEdit, and records every write that was attempted. */
function world (opts) {
  opts = opts || {};
  const log = { toasts: [], setUser: [], payloads: [], uploaded: [], revoked: 0 };
  const els = {};
  const mkEl = (extra) => Object.assign({ value: '', style: {}, src: '',
    addEventListener (t, fn) { this._h = fn; }, files: [] }, extra || {});

  ['ieNameInput', 'ieHandleInput', 'iePhoneInput', 'ieLocationInput', 'ieTillInput', 'ieBioInput']
    .forEach(id => { els[id] = mkEl({ value: id === 'ieNameInput' ? 'Buyer Name' : '' }); });
  els.ieAvatarInput = mkEl(); els.ieCoverInput = mkEl();
  els.ieAvatarPreview = mkEl(); els.ieCoverPreview = mkEl();

  const user = Object.assign({
    name: 'Buyer Name', username: 'buyer',
    avatarUrl: 'https://storage.googleapis.com/prev-avatar.jpg',
    coverUrl:  'https://storage.googleapis.com/prev-cover.jpg',
  }, opts.user || {});

  const sandbox = {
    document: { getElementById: (id) => els[id] || null,
                createElement: () => ({ getContext: () => ({ drawImage () {} }), toDataURL: () => 'data:image/jpeg;base64,AAAA' }) },
    URL: { createObjectURL: () => 'blob:preview', revokeObjectURL: () => { log.revoked++; } },
    upToast: (m, okFlag) => log.toasts.push({ msg: m, ok: okFlag }),
    getUser: () => JSON.parse(JSON.stringify(user)),
    setUser: (u) => { log.setUser.push(JSON.parse(JSON.stringify(u))); Object.assign(user, u); },
    saveToFirestore: (p) => { log.payloads.push(JSON.parse(JSON.stringify(p)));
                              return opts.firestoreFails ? Promise.reject(new Error('denied'))
                                                         : Promise.resolve(); },
    slugify: (s) => String(s).toLowerCase().replace(/\s+/g, '-'),
    renderHeaderCard: () => {},
    toggleInlineEdit: () => {},
    PROFILE_EDIT_MAX: 3,
    _profileEditGate: () => ({ allowed: true, nextCount: 1, nextStart: 'x', nextStartMs: 1,
                               remainingAfter: 2 }),
    _user: user,
    _ieAvatarFile: null, _ieCoverFile: null, _ieAvatarUrl: null, _ieCoverUrl: null,
    FileReader: function () { log.usedFileReader = true; this.readAsDataURL = () => {}; },
    Image: function () {},
    window: {
      SokoniAvatar: {
        upload: (f) => { log.uploaded.push({ kind: 'avatar', file: f });
          return opts.avatarFails ? Promise.reject(new Error('Storage is unavailable.'))
                                  : Promise.resolve('https://storage.googleapis.com/new-avatar.jpg'); },
        uploadCover: (f) => { log.uploaded.push({ kind: 'cover', file: f });
          return opts.coverFails ? Promise.reject(new Error('Storage is unavailable.'))
                                 : Promise.resolve('https://storage.googleapis.com/new-cover.jpg'); },
      },
    },
  };

  /* eslint-disable no-new-func */
  const build = new Function('sandbox',
    'with (sandbox) {' + BIND_SRC + '\n' + SAVE_SRC +
    '\n return { bind: _ieBindPhoto, save: saveInlineEdit, get state(){ return {' +
    ' af:_ieAvatarFile, cf:_ieCoverFile, au:_ieAvatarUrl, cu:_ieCoverUrl }; } }; }');
  const api = build(sandbox);

  /* Stage whichever photos this scenario selects. */
  if (opts.avatar) { api.bind('ieAvatarInput', 'ieAvatarPreview', 256, (f) => { sandbox._ieAvatarFile = f; });
                     els.ieAvatarInput.files = [opts.avatar]; els.ieAvatarInput._h(); }
  if (opts.cover)  { api.bind('ieCoverInput', 'ieCoverPreview', 900, (f) => { sandbox._ieCoverFile = f; });
                     els.ieCoverInput.files = [opts.cover]; els.ieCoverInput._h(); }

  return { api, log, sandbox, els, user };
}

const settle = () => new Promise(r => setTimeout(r, 0));
const anyBase64 = (o) => JSON.stringify(o || {}).indexOf('data:image') > -1;

(async function () {
  console.log('══════════════════════════════════════════════════════════════════');
  console.log('  EDIT PROFILE — PHOTO PERSISTENCE');
  console.log('══════════════════════════════════════════════════════════════════');

  head('0 - the shipped functions');
  ok('control — _ieBindPhoto extracted', !!BIND_SRC && BIND_SRC.length > 100);
  ok('control — saveInlineEdit extracted', !!SAVE_SRC && SAVE_SRC.length > 300);

  /* ── 1. STAGING ───────────────────────────────────────────────────────────── */
  head('1 - choosing a photo stages the FILE, not its bytes');
  {
    const w = world({ avatar: bigFile('a.jpg') });
    ok('the file itself is staged', w.sandbox._ieAvatarFile && w.sandbox._ieAvatarFile.name === 'a.jpg');
    ok('no FileReader is used to stage it', !w.log.usedFileReader);
    ok('the preview is a local object URL', w.els.ieAvatarPreview.src === 'blob:preview');
    ok('and the preview is shown', w.els.ieAvatarPreview.style.display === 'block');
    ok('nothing base64 is held anywhere', !anyBase64(w.sandbox._ieAvatarFile));
    /* A non-image is refused at selection, as before. */
    const w2 = world({});
    w2.api.bind('ieAvatarInput', 'ieAvatarPreview', 256, (f) => { w2.sandbox._ieAvatarFile = f; });
    w2.els.ieAvatarInput.files = [{ name: 'x.pdf', type: 'application/pdf', size: 10 }];
    w2.els.ieAvatarInput._h();
    ok('a non-image is rejected', w2.sandbox._ieAvatarFile === null &&
       w2.log.toasts.some(t => /not an image/i.test(t.msg)));
    ok('and the input is cleared so the same file can be re-picked',
       w2.els.ieAvatarInput.value === '');
  }

  /* ── 2. SAVE WITH AN AVATAR ───────────────────────────────────────────────── */
  head('2 - saving a new avatar');
  {
    const w = world({ avatar: bigFile('a.jpg') });
    w.api.save(); await settle(); await settle(); await settle();

    ok('the avatar went through SokoniAvatar.upload',
       w.log.uploaded.some(u => u.kind === 'avatar'));
    ok('exactly one Firestore payload was written', w.log.payloads.length === 1,
       String(w.log.payloads.length));
    const p = w.log.payloads[0] || {};
    ok('the payload carries a Storage URL', /^https:\/\/storage\./.test(p.avatarUrl || ''), p.avatarUrl);
    ok('and NO base64 anywhere in it', !anyBase64(p));
    ok('the persisted value is small, not image bytes',
       String(p.avatarUrl || '').length < 300, String(p.avatarUrl || '').length + ' chars');
    ok('the cover is untouched when only the avatar changed', p.coverUrl === undefined);
  }

  /* ── 3. SAVE WITH A COVER ─────────────────────────────────────────────────── */
  head('3 - saving a new cover');
  {
    const w = world({ cover: bigFile('c.jpg') });
    w.api.save(); await settle(); await settle(); await settle();

    ok('the cover went through uploadCover', w.log.uploaded.some(u => u.kind === 'cover'));
    ok('and NOT through the avatar upload', !w.log.uploaded.some(u => u.kind === 'avatar'));
    const p = w.log.payloads[0] || {};
    ok('the payload carries a Storage URL', /^https:\/\/storage\./.test(p.coverUrl || ''), p.coverUrl);
    ok('and NO base64 anywhere in it', !anyBase64(p));
    ok('the avatar is untouched when only the cover changed', p.avatarUrl === undefined);
  }

  /* ── 4. BOTH AT ONCE ──────────────────────────────────────────────────────── */
  head('4 - saving both photos together');
  {
    const w = world({ avatar: bigFile('a.jpg'), cover: bigFile('c.jpg') });
    w.api.save(); await settle(); await settle(); await settle();
    ok('both uploads ran', w.log.uploaded.length === 2);
    const p = w.log.payloads[0] || {};
    ok('both URLs are persisted', /^https:\/\/storage\./.test(p.avatarUrl || '') &&
       /^https:\/\/storage\./.test(p.coverUrl || ''));
    ok('with no base64 in the document', !anyBase64(p));
  }

  /* ── 5. FAILURE ───────────────────────────────────────────────────────────── */
  head('5 - an upload failure persists nothing and keeps the previous image');
  {
    const w = world({ avatar: bigFile('a.jpg'), avatarFails: true });
    w.api.save(); await settle(); await settle(); await settle();

    ok('NOTHING is written to Firestore', w.log.payloads.length === 0,
       String(w.log.payloads.length));
    ok('the previous avatar is still the stored value',
       w.user.avatarUrl === 'https://storage.googleapis.com/prev-avatar.jpg', w.user.avatarUrl);
    ok('no success toast fires',
       !w.log.toasts.some(t => t.ok && /saved/i.test(t.msg)),
       w.log.toasts.map(t => (t.ok ? '+' : '-') + t.msg).join(' | '));
    ok('the failure is surfaced', w.log.toasts.some(t => t.ok === false && /unavailable|could not/i.test(t.msg)));
    /* The rate-limit gate must not be spent by a save that never happened. */
    ok('no edit is consumed by a failed upload',
       !w.log.setUser.some(u => u.profileEditCount === 1));

    /* Same for the cover. */
    const w2 = world({ cover: bigFile('c.jpg'), coverFails: true });
    w2.api.save(); await settle(); await settle(); await settle();
    ok('a cover failure writes nothing either', w2.log.payloads.length === 0);
    ok('and the previous cover is intact',
       w2.user.coverUrl === 'https://storage.googleapis.com/prev-cover.jpg');
  }

  /* ── 6. A BUYER WITH NO PHOTOS YET ────────────────────────────────────────── */
  head('6 - a first-time buyer, and the default cover');
  {
    const w = world({ cover: bigFile('c.jpg'), coverFails: true,
                      user: { avatarUrl: '', coverUrl: '' } });
    w.api.save(); await settle(); await settle(); await settle();
    ok('a failed first cover leaves coverUrl empty, not a data URL',
       w.user.coverUrl === '', w.user.coverUrl);
    ok('and nothing was persisted', w.log.payloads.length === 0);
    /* The default remains a VISUAL fallback only — it must never be written as data. */
    ok('the default cover is never written to the document',
       !w.log.payloads.some(p => /Sokoni%20Logo|#000|url\(/.test(JSON.stringify(p))));
  }

  /* ── 7. TEXT-ONLY EDIT STILL WORKS ────────────────────────────────────────── */
  head('7 - editing text with no photo is unaffected');
  {
    const w = world({});
    w.api.save(); await settle(); await settle();
    ok('no upload is attempted', w.log.uploaded.length === 0);
    ok('the save still happens', w.log.payloads.length === 1);
    const p = w.log.payloads[0] || {};
    ok('and no image field is sent', p.avatarUrl === undefined && p.coverUrl === undefined);
  }

  /* ── 8. THE BASE64 READER IS GONE ─────────────────────────────────────────── */
  head('8 - the staging helper that caused this cannot be reused');
  {
    ok('_ieReadImage no longer exists', !/function _ieReadImage\s*\(/.test(html));
    ok('the old staged-bytes variables are gone',
       !/_ieAvatarData|_ieCoverData/.test(html));
    ok('the form no longer reads files as data URLs',
       !/readAsDataURL/.test(BIND_SRC + SAVE_SRC));
    /* CONTROL — the repaired single-photo handlers are still the ones doing uploads. */
    ok('control — handleAvatarUpload still uses SokoniAvatar.upload',
       /SokoniAvatar\.upload\(/.test(extractFn(html, 'handleAvatarUpload') || ''));
    ok('control — handleCoverUpload still uses uploadCover',
       /SokoniAvatar\.uploadCover\(/.test(extractFn(html, 'handleCoverUpload') || ''));
  }

  console.log('\n  what this suite does NOT prove');
  console.log('  UNPROVEN  a live Storage round-trip   [needs an authenticated browser session]');

  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  console.log('══════════════════════════════════════════════════════════════════');
  process.exit(fail ? 1 : 0);
})();
