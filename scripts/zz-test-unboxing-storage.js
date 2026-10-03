/* Unboxing photo storage — QUARANTINE then publish (owner 2026-10-03). Emulator-backed, against a rules FILE.
   Run: firebase emulators:exec --only storage --project demo-sokoni-unbox "node scripts/zz-test-unboxing-storage.js"
        STORAGE_RULES=<file> to test another rules file (default storage.rules).
   Contract:
     unboxing-pending/{uid}/{file}  owner create (safe image, < 8 MB); owner/admin read; no public read; no update;
                                    owner delete
     unboxing/{uid}/{file}          public read; NO browser write at all (server copies on AdminOS approve)
   Every allow has a matching deny on the same path, so no check passes against a rule that refuses everything. */
'use strict';
const fs = require('fs'), path = require('path');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
const { ref, uploadBytes, getBytes, deleteObject } = require('firebase/storage');

let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (ok ? '' : '   [' + d + ']')); ok ? pass++ : fail++; };
const allows = async (l, p) => { try { await assertSucceeds(p); ck(l, true); } catch (e) { ck(l, false, e.message); } };
const denies = async (l, p) => { try { await assertFails(p); ck(l, true); } catch (e) { ck(l, false, e.message); } };

const IMG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
const BIG = new Uint8Array(8 * 1024 * 1024 + 1);
const png = { contentType: 'image/png' };

(async () => {
  const file = process.env.STORAGE_RULES || 'storage.rules';
  const [host, port] = (process.env.FIREBASE_STORAGE_EMULATOR_HOST || '127.0.0.1:9199').split(':');
  const env = await initializeTestEnvironment({
    projectId: 'demo-sokoni-unbox',
    storage: { rules: fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8'), host, port: Number(port) },
  });
  console.log('\nUnboxing storage   STORAGE_RULES=' + file + '\n');
  await env.clearStorage();
  await env.withSecurityRulesDisabled(async (c) => {
    const s = c.storage();
    await uploadBytes(ref(s, 'unboxing-pending/alice/p1.png'), IMG, png);
    await uploadBytes(ref(s, 'unboxing/alice/approved.png'), IMG, png);
  });
  const st = (ctx) => ctx.storage();
  const anon = st(env.unauthenticatedContext());
  const alice = st(env.authenticatedContext('alice'));
  const bob = st(env.authenticatedContext('bob'));
  const admin = st(env.authenticatedContext('adm', { admin: true }));
  const superA = st(env.authenticatedContext('sup', { superAdmin: true }));

  console.log('[Q] quarantine upload — unboxing-pending/{uid}/');
  await allows('Q-1 alice uploads a PNG to unboxing-pending/alice', uploadBytes(ref(alice, 'unboxing-pending/alice/a.png'), IMG, png));
  await denies('Q-2 alice uploads to unboxing-pending/BOB (another uid)', uploadBytes(ref(alice, 'unboxing-pending/bob/a.png'), IMG, png));
  await denies('Q-3 unauthenticated upload', uploadBytes(ref(anon, 'unboxing-pending/alice/b.png'), IMG, png));
  await denies('Q-4 SVG (script vector) refused', uploadBytes(ref(alice, 'unboxing-pending/alice/x.svg'), IMG, { contentType: 'image/svg+xml' }));
  await denies('Q-5 non-image (text/html) refused', uploadBytes(ref(alice, 'unboxing-pending/alice/x.html'), IMG, { contentType: 'text/html' }));
  await denies('Q-6 oversized (> 8 MB) refused', uploadBytes(ref(alice, 'unboxing-pending/alice/big.png'), BIG, png));
  await denies('Q-7 overwrite an existing pending file (no update)', uploadBytes(ref(alice, 'unboxing-pending/alice/p1.png'), IMG, png));

  console.log('[R] quarantine read — private until approval');
  await allows('R-1 owner reads own pending photo', getBytes(ref(alice, 'unboxing-pending/alice/p1.png')));
  await allows('R-2 admin reads a pending photo (AdminOS inspects media)', getBytes(ref(admin, 'unboxing-pending/alice/p1.png')));
  await allows('R-3 superAdmin-only token reads a pending photo', getBytes(ref(superA, 'unboxing-pending/alice/p1.png')));
  await denies('R-4 another user reads a pending photo', getBytes(ref(bob, 'unboxing-pending/alice/p1.png')));
  await denies('R-5 public reads a pending photo', getBytes(ref(anon, 'unboxing-pending/alice/p1.png')));

  console.log('[P] publication — unboxing/{uid}/ is server-written only');
  await denies('P-1 owner writes straight to the PUBLIC path (self-publish)', uploadBytes(ref(alice, 'unboxing/alice/self.png'), IMG, png));
  await denies('P-2 admin-claimed BROWSER write to the public path', uploadBytes(ref(admin, 'unboxing/alice/adm.png'), IMG, png));
  await denies('P-3 owner deletes an approved public photo', deleteObject(ref(alice, 'unboxing/alice/approved.png')));
  await allows('P-4 public reads an approved (server-copied) photo', getBytes(ref(anon, 'unboxing/alice/approved.png')));

  console.log('[D] delete');
  await denies('D-1 another user deletes alice\'s pending photo', deleteObject(ref(bob, 'unboxing-pending/alice/p1.png')));
  await allows('D-2 owner deletes own pending photo', deleteObject(ref(alice, 'unboxing-pending/alice/p1.png')));

  console.log('[N] neighbour control');
  await denies('N-1 an unmatched path stays default-deny', uploadBytes(ref(alice, 'unboxing-other/alice/a.png'), IMG, png));

  await env.cleanup();
  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH ' + (e && e.stack || e)); process.exit(2); });
