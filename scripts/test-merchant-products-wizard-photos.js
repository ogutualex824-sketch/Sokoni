#!/usr/bin/env node
/**
 * PRODUCTS — the create wizard's photo step, and the card layout.
 *
 *   node scripts/test-merchant-products-wizard-photos.js
 *
 * Adding a product and photographing it used to be two separate errands: the create form
 * ended with "Photos are added separately", because the Storage path needs a product id
 * that does not exist until the product is written. The wizard now CHOOSES and EDITS
 * photos, holds them, and uploads them the moment the writer returns an id.
 *
 * The thing that must not slip: no message may claim a photo is saved before Storage has
 * returned an address, and a photo failure must never cast doubt on the product, which by
 * then genuinely exists.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'sokoni-merchant-products.js'), 'utf8');
const NL = String.fromCharCode(10);

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 94) + ']' : ''));
  ok ? pass++ : fail++;
};
const head = (t) => console.log(NL + t);

function grab (name) {
  let i = SRC.indexOf('function ' + name + ' (');
  if (i === -1) i = SRC.indexOf('function ' + name + '(');
  if (i === -1) return null;
  let d = 0, started = false;
  for (let k = i; k < SRC.length; k++) {
    const c = SRC[k];
    if (c === '{') { d++; started = true; }
    else if (c === '}') { d--; if (started && d === 0) return SRC.slice(i, k + 1); }
  }
  return null;
}

console.log(NL + 'PRODUCTS — WIZARD PHOTOS + CARD LAYOUT' + NL + '='.repeat(64));

/* ── 1 · the wizard offers the step ───────────────────────────────────────── */
head('1 · the create wizard offers photos, with the AI editor');
ck('a createPhotosHTML section exists', !!grab('createPhotosHTML'));
ck('the create form renders it', SRC.indexOf("(creating ? createPhotosHTML() : '')") > -1);
ck('the old "added separately" note no longer shows when creating',
   SRC.indexOf("(creating ? '' : '<div class=\"pr-note\">Photos are added separately") > -1,
   'it is still correct on the EDIT form, where photos really are a separate action');
ck('both photo surfaces use a real BUTTON, not the native file widget',
   (SRC.match(/pr-pickbtn/g) || []).length >= 3 &&
   (SRC.match(/class="pr-file"/g) || []).length === 2,
   'the native widget printed "No file chosen" beside a picked thumbnail');
ck('the input is clipped, NOT display:none — it must stay keyboard reachable',
   SRC.indexOf(".pr-file{position:absolute;width:1px") > -1 &&
   SRC.indexOf(".pr-file{display:none") === -1);
ck('the button label is driven by _picked, not by the input',
   /_picked\.length[\s\S]{0,160}Choose different photo/.test(SRC),
   'a repaint cannot restore a FileList, so the input can never be the source of truth');

/* ── 2 · picking and AI editing are shared, not forked ────────────────────── */
head('2 · one photo implementation, two surfaces');
const picks = grab('picksPhotos');
ck('picksPhotos gates both surfaces', !!picks);
if (picks) {
  const sb = {};
  vm.createContext(sb);
  vm.runInContext(picks + '; var r = {create:picksPhotos({mode:"create"}), photos:picksPhotos({mode:"photos"}),' +
    ' edit:picksPhotos({mode:"edit"}), del:picksPhotos({mode:"delete"}), detail:picksPhotos({mode:"detail"}),' +
    ' none:picksPhotos(null)};', sb);
  ck('create and the photo sheet may pick', sb.r.create === true && sb.r.photos === true);
  ck('CONTROL edit / delete / detail may NOT', !sb.r.edit && !sb.r.del && !sb.r.detail,
     'or a delete confirmation would start accepting files');
  ck('CONTROL a closed editor may not', sb.r.none === false);
}
ck('the AI tools are the SAME list, not a second one',
   (SRC.match(/var AI_TOOLS = \[/g) || []).length === 1);
ck('applyAiTool uses the shared gate',
   /async function applyAiTool[\s\S]{0,140}picksPhotos\(E\)/.test(SRC));

/* ── 3 · the upload happens AFTER the product exists ──────────────────────── */
head('3 · photos upload against the id the writer returned');
const attach = grab('attachAfterCreate');
const createText = grab('createText');
ck('attachAfterCreate exists', !!attach);
/* The gate suite asserts exactly ONE attachProductImages call site, and it is right to:
   a second upload path is a second place the ownership-then-Storage-then-record sequence
   could be skipped. Adding the wizard created a second one and the deploy was refused. */
ck('there is exactly ONE media entry point',
   SRC.split('attachProductImages(').length - 1 === 1,
   'both surfaces delegate to uploadPicked');
ck('...and BOTH surfaces call it — the sheet and the wizard',
   SRC.split('uploadPicked(').length - 1 === 2 && !!grab('uploadPicked'),
   'two call sites plus one definition; a single caller would mean a surface still forks');
ck('CONTROL the module still never touches the Storage SDK itself',
   !/uploadBytes|getDownloadURL|putString|firebase-storage/.test(SRC));

ck('create routes through it only when photos were chosen',
   SRC.indexOf("mode === 'create' && _picked.length && res && res.id") > -1,
   'a product with no photos must not wait on an upload path');

function runAttach (opts) {
  const said = [];
  let usedId = null, loaded = 0;
  const sb = {
    S: { destroyed: false, editor: { mode: 'create' }, rows: [1] },
    _picked: [{ name: 'a.jpg' }], _originals: [],
    say: (m) => said.push(m),
    load: () => { loaded++; },
    paint: () => {},
    ctx: { scope: {}, db: {}, storage: {} },
    mediaModule: () => {
      if (opts.noMedia) throw new Error('uploader unavailable');
      return {};
    },
    md: () => ({
      attachProductImages: (o) => {
        usedId = o.id;
        return opts.fail
          ? Promise.reject(new Error('network'))
          : Promise.resolve({ complete: !opts.partial, urls: ['u1'] });
      },
    }),
    Promise, Object, console,
  };
  vm.createContext(sb);
  /* The REAL uploadPicked runs too — the single media entry point is part of what is
     under test, not something the harness may substitute. */
  vm.runInContext(createText + NL + grab('uploadPicked') + NL + attach +
    '; attachAfterCreate(' + JSON.stringify(opts.res) + ');', sb);
  return new Promise((r) => setTimeout(() => r({ said, usedId, loaded, sb }), 40));
}

(async () => {
  const RES = { id: 'P123', complete: true, mirrors: {} };

  const ok = await runAttach({ res: RES });
  ck('it uploads against res.id', ok.usedId === 'P123', ok.usedId);
  ck('ONE message, carrying the product outcome AND the photo outcome',
     ok.said.length === 1 && /Product added/.test(ok.said[0]) && /Photo added/.test(ok.said[0]),
     ok.said[0]);
  ck('the list is re-read, never patched from what we believe we wrote', ok.loaded === 1);
  ck('the held files are released', ok.sb._picked.length === 0);

  const bad = await runAttach({ res: RES, fail: true });
  ck('a photo failure still reports the product as ADDED',
     bad.said.length === 1 && /Product added/.test(bad.said[0]), bad.said[0]);
  ck('...and says plainly that the photos did not upload',
     /could not be uploaded/.test(bad.said[0]),
     'the product exists; casting doubt on it would be the lie');
  ck('CONTROL it never claims a photo was added when the upload threw',
     !/Photo added/.test(bad.said[0]), bad.said[0]);

  const part = await runAttach({ res: RES, partial: true });
  ck('a partial sync is reported as such, not as complete',
     /has not reached the till/.test(part.said[0]), part.said[0]);

  const nomedia = await runAttach({ res: RES, noMedia: true });
  ck('no uploader ⇒ the product is still reported, the photos are not claimed',
     /Product added/.test(nomedia.said[0]) && !/Photo added/.test(nomedia.said[0]), nomedia.said[0]);

  /* ── 4 · createText ─────────────────────────────────────────────────────── */
  head('4 · the product outcome is text, so nothing overwrites the caveat');
  {
    const sb = {};
    vm.createContext(sb);
    vm.runInContext(createText + '; var a=createText({replayed:true}), b=createText({complete:true}),' +
      ' c=createText({mirrors:{pos:{state:"pending"}}});', sb);
    ck('a replay says no duplicate was created', /no duplicate/.test(sb.a), sb.a);
    ck('a complete write says it is ready at the till', /ready at the till/.test(sb.b));
    ck('an incomplete mirror names what has not synced', /the till/.test(sb.c), sb.c);
    ck('CONTROL the three outcomes differ', sb.a !== sb.b && sb.b !== sb.c);
  }

  /* ── 5 · card layout ────────────────────────────────────────────────────── */
  head('5 · the card is a row, and its actions are not trapped in the text column');
  ck('the mobile card restates its direction',
     SRC.indexOf(".pr-card{display:grid;grid-template-columns:104px") > -1,
     'display:flex alone does NOT override the base flex-direction:column');
  ck('the actions are a child of the CARD, not of .pr-b',
     /'<\/div>' \+[\s\S]{0,600}'<div class="pr-acts">'/.test(SRC),
     'inside the ~200px text column "+ Photo" wrapped and then ellipsised');
  ck('...and they span the whole card on mobile',
     SRC.indexOf(".pr-card>.pr-acts{grid-column:1 / -1") > -1);
  ck('the stock pill does not stretch in the column flex',
     SRC.indexOf(".pr-b>.pr-tag{align-self:flex-start}") > -1,
     'flex items stretch by default, which made the tag look like a progress bar');

  /* ── 6 · the shell no longer crushes a module's rows ────────────────────── */
  head('6 · the shell panel must not shrink what a module renders');
  const SHELL = fs.readFileSync(path.join(ROOT, 'merchant-v2.html'), 'utf8');
  ck('panel-scroll children keep their natural height',
     SHELL.indexOf('.panel.show.panel-scroll > *{ flex-shrink:0; }') > -1,
     'the Products filter chips measured 4px tall while the chip inside them was 20px');
  ck('...and the panel scrolls instead',
     /\.panel\.show\.panel-scroll\{[\s\S]{0,700}overflow-y:auto/.test(SHELL));
  ck('CONTROL it still gives the panel a definite height',
     /\.panel\.show\.panel-scroll\{[\s\S]{0,900}height:calc\(100dvh/.test(SHELL),
     'without it a module pinning a bar to its bottom edge falls below the fold');

  console.log(NL + '  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('SUITE ERROR: ' + (e && e.stack || e)); process.exit(1); });
