/* ══════════════════════════════════════════════════════════════════════════════
   PROFILE COVER UPLOAD — CERTIFICATION
   scripts/test-profile-cover-upload.js   node scripts/test-profile-cover-upload.js

   THE DEFECT THIS PINS
   `handleAvatarUpload` was repaired to upload through Cloud Storage; `handleCoverUpload`
   was left as the original implementation of the same bug:

       FileReader.readAsDataURL(file)  ->  _user.coverUrl = <base64>
                                       ->  saveToFirestore({coverUrl: <base64>})
                                       ->  upToast('Cover photo updated!', true)

   A Firestore document is capped at 1 MiB and base64 inflates by ~1.37x, so any cover over
   ~730 KB failed the write. `saveToFirestore` only console.warns, so the toast claimed
   success and the cover was gone on reload.

   THE ORACLE
   The corrected avatar handler lives in the same file. Most of this suite asserts that the
   cover handler now does what the avatar handler does — commit-on-resolve, roll back on
   failure, clean up, reset the input — so the two cannot drift apart again.

   The handler is EXTRACTED and EXECUTED against stub DOM/SDK objects: what is proven is
   what the shipped function does, not that a file contains a promising-looking string.
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
const avatarJs = fs.readFileSync(path.join(ROOT, 'sokoni-avatar.js'), 'utf8');

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
const COVER_SRC = extractFn(html, 'handleCoverUpload');
/* Read from the page: a test that restates the value proves only that the test agrees
   with itself. */
const DEFAULT_BG = (function () {
  /* Read from the page. A test that restates the value proves only that the test
     agrees with itself. Concatenated literals are joined the way the page joins them. */
  const m = html.match(/var COVER_DEFAULT_BG = ([\s\S]*?);\r?\n/);
  if (!m) return '';
  return (m[1].match(/"([^"]*)"/g) || []).map(x => x.slice(1, -1)).join('');
})();

/* Build a world for the handler and run it. `outcome` decides whether the upload
   resolves or rejects. Returns everything the handler touched. */
function run (outcome, opts) {
  opts = opts || {};
  const log = { toasts: [], saved: null, revoked: 0, uploadArgs: null };
  const img = { src: opts.initialSrc !== undefined ? opts.initialSrc : 'https://cdn/old-cover.jpg',
                style: { display: opts.initialDisplay !== undefined ? opts.initialDisplay : 'block' } };
  /* The cover AREA carries the default-logo background; the <img> alone cannot express
     "this buyer has no cover". */
  const area = { style: { background: opts.initialBg !== undefined ? opts.initialBg : '' } };
  const input = { files: [opts.file || { name: 'c.jpg', size: 2 * 1024 * 1024, type: 'image/jpeg' }],
                  value: 'C:\\fakepath\\c.jpg' };

  const sandbox = {
    document: { getElementById: (id) => (id === 'upCoverImg' ? img : (id === 'upCoverArea' ? area : null)) },
    URL: { createObjectURL: () => 'blob:preview', revokeObjectURL: () => { log.revoked++; } },
    upToast: (msg, okFlag) => log.toasts.push({ msg, ok: okFlag }),
    setUser: (u) => { log.saved = JSON.parse(JSON.stringify(u)); },
    saveToFirestore: (patch) => { log.firestoreDirect = patch; },
    _user: { name: 'Buyer' },
    COVER_DEFAULT_BG: DEFAULT_BG,
    window: {
      SokoniAvatar: {
        uploadCover: (f) => {
          log.uploadArgs = f;
          return outcome === 'ok'
            ? Promise.resolve('https://storage.googleapis.com/…/cover_123.jpg')
            : Promise.reject(new Error('Storage is unavailable. Check your connection and try again.'));
        },
        upload: () => Promise.reject(new Error('avatar upload must not be used for a cover')),
      },
    },
    FileReader: function () { log.usedFileReader = true; this.readAsDataURL = () => {}; },
  };

  /* eslint-disable no-new-func */
  const f = new Function('sandbox',
    'with (sandbox) { ' + COVER_SRC + '\n return handleCoverUpload; }');
  const handler = f(sandbox);
  handler({ target: input });
  return { log, img, area, input, sandbox };
}

const settle = () => new Promise(r => setTimeout(r, 0));

(async function () {
  console.log('══════════════════════════════════════════════════════════════════');
  console.log('  PROFILE COVER UPLOAD');
  console.log('══════════════════════════════════════════════════════════════════');

  head('0 - the shipped handler');
  ok('control — handleCoverUpload was extracted', !!COVER_SRC && COVER_SRC.length > 100,
     COVER_SRC ? COVER_SRC.length + ' chars' : 'NOT FOUND');

  /* ── 1. SUCCESSFUL UPLOAD ─────────────────────────────────────────────────── */
  head('1 - a successful cover upload');
  {
    const { log, img, input } = run('ok');
    await settle(); await settle();

    ok('it uploads through Storage, not FileReader', !log.usedFileReader);
    ok('the file is handed to uploadCover', !!log.uploadArgs);
    ok('the resolved URL is persisted to _user', log.saved && log.saved.coverUrl &&
       /^https:\/\/storage\./.test(log.saved.coverUrl), log.saved && log.saved.coverUrl);
    ok('no base64 is written anywhere', !(log.saved && /^data:/.test(log.saved.coverUrl || '')));
    ok('the image shows the uploaded URL', /^https:\/\/storage\./.test(img.src));
    ok('and is made visible', img.style.display === 'block');
    const success = log.toasts.filter(t => t.ok && /updated/i.test(t.msg));
    ok('a success toast fires exactly once', success.length === 1,
       log.toasts.map(t => (t.ok ? '+' : '-') + t.msg).join(' | '));
    ok('the preview object URL is revoked', log.revoked === 1);
    ok('the input is reset so the same file can be re-selected', input.value === '');
  }

  /* ── 2. FAILED UPLOAD ─────────────────────────────────────────────────────── */
  head('2 - a failed cover upload');
  {
    const { log, img, input } = run('fail');
    await settle(); await settle();

    ok('the previous cover is restored', img.src === 'https://cdn/old-cover.jpg', img.src);
    ok('and its visibility is restored too', img.style.display === 'block');
    ok('nothing is committed to _user', log.saved === null);
    const falseSuccess = log.toasts.filter(t => t.ok && /updated/i.test(t.msg));
    ok('NO success toast fires', falseSuccess.length === 0,
       log.toasts.map(t => (t.ok ? '+' : '-') + t.msg).join(' | '));
    ok('the failure is surfaced to the user',
       log.toasts.some(t => t.ok === false && /unavailable|could not/i.test(t.msg)));
    ok('the preview object URL is still revoked', log.revoked === 1);
    ok('the input is still reset', input.value === '');
  }

  /* A user with NO cover yet must not be left showing a dead preview. */
  head('2b - failure when there was no cover to begin with');
  {
    const { img } = run('fail', { initialSrc: '', initialDisplay: 'none' });
    await settle(); await settle();
    ok('the empty state is restored, not a dead blob URL', img.src === '' , img.src);
    ok('and it stays hidden', img.style.display === 'none');
  }

  /* ── 3. LARGE IMAGE ───────────────────────────────────────────────────────── */
  head('3 - a large image is never stuffed into the user document');
  {
    const big = { name: 'huge.jpg', size: 4 * 1024 * 1024, type: 'image/jpeg' };
    const { log } = run('ok', { file: big });
    await settle(); await settle();
    ok('FileReader is not used at any size', !log.usedFileReader);
    ok('saveToFirestore is not called directly with the image',
       !log.firestoreDirect, JSON.stringify(log.firestoreDirect || null));
    ok('what is stored is a URL, not image bytes',
       log.saved && log.saved.coverUrl.length < 500, String((log.saved||{}).coverUrl||'').length + ' chars');
  }

  /* ── 4. THE ORACLE — PARITY WITH THE REPAIRED AVATAR HANDLER ──────────────── */
  head('4 - the cover handler now matches the avatar handler it was drifting from');
  {
    const AV = extractFn(html, 'handleAvatarUpload');
    ok('control — the avatar oracle was extracted', !!AV);
    const both = (re) => re.test(AV) && re.test(COVER_SRC);
    ok('both take a preview via createObjectURL', both(/createObjectURL/));
    ok('both commit only inside .then()', both(/\.then\(function\s*\(url\)/));
    ok('both roll back in .catch()', both(/\.catch\(function\s*\(err\)/));
    ok('both revoke the object URL', both(/revokeObjectURL/));
    ok('both reset the file input', both(/e\.target\.value = ''/));
    ok('neither uses FileReader', !/FileReader/.test(AV) && !/FileReader/.test(COVER_SRC));
    ok('the cover does NOT call the avatar upload', !/SokoniAvatar\.upload\(/.test(COVER_SRC));
    ok('it calls uploadCover', /SokoniAvatar\.uploadCover\(/.test(COVER_SRC));
  }

  /* ── 5. THE MODULE SIDE ───────────────────────────────────────────────────── */
  head('5 - uploadCover writes a cover, and only a cover');
  {
    const fn = extractFn(avatarJs, 'uploadCover');
    ok('control — uploadCover exists', !!fn);
    ok('it writes a cover_ object', /'profile-avatars\/' \+ uid \+ '\/cover_'/.test(fn));
    ok('it persists coverUrl', /coverUrl: url/.test(fn));
    /* The whole reason it is not upload(): a cover must not become the avatar. */
    /* Asserted on the PROPERTY position, not the word: the comment above the write says
       "Not avatarUrl, not photoURL, and no _broadcast", and an unstripped word-match reads
       that explanation as the violation it denies. */
    ok('it does NOT write avatarUrl', !/avatarUrl\s*:/.test(fn));
    ok('it does NOT write photoURL', !/photoURL\s*:/.test(fn));
    ok('it does NOT update the Auth profile', !/updateProfile/.test(fn));
    ok('it does NOT broadcast to avatar subscribers', !/_broadcast\s*\(/.test(fn));
    /* CONTROL — the avatar upload DOES all of those, so the assertions discriminate. */
    const up = extractFn(avatarJs, 'upload');
    ok('control — the avatar upload does write photoURL', /photoURL\s*:/.test(up));
    ok('control — and does broadcast', /_broadcast\s*\(/.test(up));
    ok('the module exports it', /uploadCover: uploadCover/.test(avatarJs));

    /* storage.rules already permits this path — no rules change is required. */
    const rules = fs.readFileSync(path.join(ROOT, 'storage.rules'), 'utf8');
    ok('storage.rules already covers the path with a wildcard filename',
       /match \/profile-avatars\/\{uid\}\/\{filename\}/.test(rules));

    /* The avatar's downscale must be unchanged for existing callers. */
    ok('_downscale defaults to the avatar edge when no edge is passed',
       /function _downscale\(file, maxEdge\)/.test(avatarJs) &&
       /var EDGE = maxEdge \|\| MAX_EDGE;/.test(avatarJs));
    ok('the avatar upload still passes no edge (512 preserved)',
       /await _downscale\(file\);/.test(up));
    ok('the cover passes a larger edge', /_downscale\(file, COVER_EDGE\)/.test(fn));
  }

  /* ── 6. THE DEFAULT COVER ─────────────────────────────────────────────────── */
  head('6 - the default cover: the SOKONI wordmark on the field it was drawn on');
  {
    ok('control — COVER_DEFAULT_BG was read from the page', !!DEFAULT_BG, DEFAULT_BG);
    /* THE BACKGROUND MUST MAKE THE WORDMARK LEGIBLE. Sokoni Logo.png renders "SOKO" in
       WHITE; on a white backdrop the word disappears. So the default is asserted to be
       DARK, not merely "some colour". */
    ok('the default uses the SOKONI wordmark', /Sokoni%20Logo\.jpe?g/i.test(DEFAULT_BG), DEFAULT_BG);
    ok('it is NOT on a white background (the wordmark would vanish)',
       !/#fff\b|#ffffff|\bwhite\b/i.test(DEFAULT_BG), DEFAULT_BG);
    /* The JPEG has no transparency: its BLACK field is part of the image, so the backdrop
       must be black or a coloured rectangle appears around the logo. */
    ok('it sits on black, matching the JPEG\'s own field', /#000000|#000\b|\bblack\b/i.test(DEFAULT_BG), DEFAULT_BG);
    ok('and is contained, not cropped, in a short cover strip', /\bcontain\b/.test(DEFAULT_BG));

    /* THE ASSET MUST ACTUALLY EXIST, WITH EXACT CASE. This whole default was specified
       against /assets/sokonilogo.png, which does not exist — and a lookup only appeared to
       succeed because this filesystem is case-insensitive while Hosting is not. */
    const refs = (DEFAULT_BG.match(/url\('([^']+)'\)/) || [])[1] || '';
    ok('control — a referenced asset path was found', !!refs, refs);
    const onDisk = decodeURIComponent(refs.replace(/^\//, ''));
    ok('the referenced asset exists on disk', fs.existsSync(path.join(ROOT, onDisk)), onDisk);
    /* Exact case, read from git rather than the filesystem, because the filesystem lies. */
    const tracked = require('child_process')
      .execFileSync('git', ['-C', ROOT, 'ls-files', 'assets/'], { encoding: 'utf8' })
      .split('\n');
    ok('and is committed with EXACTLY that case', tracked.indexOf(onDisk) > -1, onDisk);

    /* The avatar keeps its own fallback — the basket mark, which is the one that works on
       a light surface. The two defaults are deliberately different ASSETS for that reason. */
    ok('the avatar still falls back to the basket mark', /logosokoni\.png/.test(avatarJs));


    /* THE RENDER PATH — no custom cover means white + logo, image hidden. */
    const render = html.slice(html.indexOf('var coverImg  = document.getElementById'),
                              html.indexOf('/* Verified */'));
    ok('control — the render branch was located', render.length > 80);
    ok('with a coverUrl the image is shown', /coverImg\.src=_user\.coverUrl/.test(render));
    ok('and the default background is cleared', /coverArea\.style\.background=''/.test(render));
    ok('with no coverUrl the image is hidden', /coverImg\.style\.display='none'/.test(render));
    ok('and the default background is applied', /coverArea\.style\.background = COVER_DEFAULT_BG/.test(render));
    /* The render path must use the shared constant, not its own copy. */
    ok('the render path uses the shared constant, not a literal',
       !/coverArea\.style\.background = "#/.test(render));
  }

  /* ── 7. THE DEFAULT AROUND AN UPLOAD ──────────────────────────────────────── */
  head('7 - the default across success and failure');
  {
    /* SUCCESS: the custom cover replaces the default. */
    const okRun = run('ok', { initialSrc: '', initialDisplay: 'none', initialBg: DEFAULT_BG });
    await settle(); await settle();
    ok('a successful upload clears the default background', okRun.area.style.background === '',
       JSON.stringify(okRun.area.style.background));
    ok('and shows the custom cover', /^https:\/\/storage\./.test(okRun.img.src));

    /* FAILURE FROM EMPTY: back to white + the mark, not a blank panel. */
    const emptyFail = run('fail', { initialSrc: '', initialDisplay: 'none', initialBg: DEFAULT_BG });
    await settle(); await settle();
    ok('a failed upload from empty restores the default background',
       emptyFail.area.style.background === DEFAULT_BG, emptyFail.area.style.background);
    ok('the restored default is not white', !/#ffffff|\bwhite\b/i.test(emptyFail.area.style.background));
    ok('and carries the wordmark on its black field',
       /Sokoni%20Logo\.jpe?g/i.test(emptyFail.area.style.background) &&
       /#000000|#000\b|black/i.test(emptyFail.area.style.background));
    ok('the image stays hidden', emptyFail.img.style.display === 'none');
    ok('and is not left on a dead blob URL', !/^blob:/.test(emptyFail.img.src), emptyFail.img.src);

    /* FAILURE WITH A PREVIOUS COVER: the previous state comes back, not the default. */
    const hadCover = run('fail', { initialSrc: 'https://cdn/old-cover.jpg',
                                   initialDisplay: 'block', initialBg: '' });
    await settle(); await settle();
    ok('a failed upload with a previous cover restores that cover',
       hadCover.img.src === 'https://cdn/old-cover.jpg');
    ok('and does NOT paint the default over it',
       hadCover.area.style.background === '', hadCover.area.style.background);

    /* THE DEFAULT IS NEVER DATA. */
    const persisted = [okRun, emptyFail, hadCover].map(r => r.log.saved).filter(Boolean);
    ok('the default logo is never written to _user.coverUrl',
       !persisted.some(u => /logosokoni|Sokoni%20Logo|#000|url\(/.test(String(u.coverUrl || ''))),
       JSON.stringify(persisted.map(u => u.coverUrl)));
    ok('nothing is persisted at all on a failure',
       emptyFail.log.saved === null && hadCover.log.saved === null);
    ok('and no direct Firestore write carries the default',
       !emptyFail.log.firestoreDirect && !hadCover.log.firestoreDirect);
  }

  console.log('\n  what this suite does NOT prove');
  console.log('  UNPROVEN  a live Storage round-trip   [needs an authenticated browser session]');
  console.log('  OUT OF SCOPE  the inline-edit Save path (_ieCoverData / _ieAvatarData) still');
  console.log('                stages base64 into _user. Separate finding, not repaired here.');

  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  console.log('══════════════════════════════════════════════════════════════════');
  process.exit(fail ? 1 : 0);
})();
