/* SOKONI Foundation media — Storage rules, emulator-backed (2026-10-01).

   Run (from this tree; the testing lib lives in the main checkout's node_modules):
     NODE_PATH=C:/Users/USER1/OneDrive/Desktop/SOKONI/node_modules \
     firebase emulators:exec --only storage --project sokoni-found-storage-test \
       "node scripts/test-foundation-storage-rules.js"

   Pins:
     * a participant uploads only under THEIR OWN foundation-media/{uid}/ — photo ≤15 MB, video ≤80 MB,
       JPEG/PNG/WebP/MP4/WebM/MOV only; SVG / HTML / oversize refused
     * nobody (not even the owner) READS foundation-media/ through rules
     * foundation-media/admin/ needs an admin claim; a user whose uid is literally 'admin' is refused
       (rules OR across blocks — this is the case sokoni-32 asked to prove)
     * foundation-published/ is closed to every client (admin SDK + download tokens only)
     * an existing live path (community-media) still behaves as before — the edit did not widen it
*/
'use strict';
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + String(d).slice(0, 120) + ']' : '')); ok ? pass++ : fail++; };
const check = async (label, p) => { try { await p; ck(label, true); } catch (e) { ck(label, false, e.message); } };
const bytes = (n) => new Uint8Array(n);

(async () => {
  const env = await initializeTestEnvironment({
    projectId: 'sokoni-found-storage-test',
    storage: { rules: fs.readFileSync(process.env.RULES_FILE || path.join(__dirname, '..', 'storage.rules'), 'utf8') },
  });
  const user = env.authenticatedContext('u1').storage();
  const other = env.authenticatedContext('u2').storage();
  const literalAdmin = env.authenticatedContext('admin').storage();
  const adm = env.authenticatedContext('adm1', { admin: true }).storage();
  const anon = env.unauthenticatedContext().storage();
  const up = (st, p, size, type) => st.ref(p).put(bytes(size), { contentType: type });

  console.log('\nFoundation media — storage rules\n');
  await check('1 participant uploads a JPEG to their own folder', assertSucceeds(up(user, 'foundation-media/u1/a.jpg', 1000, 'image/jpeg')));
  await check('2 participant uploads an MP4 to their own folder', assertSucceeds(up(user, 'foundation-media/u1/v.mp4', 2000, 'video/mp4')));
  await check('3 cannot upload into someone else\'s folder', assertFails(up(user, 'foundation-media/u2/x.jpg', 1000, 'image/jpeg')));
  await check('4 SVG refused', assertFails(up(user, 'foundation-media/u1/x.svg', 100, 'image/svg+xml')));
  await check('5 HTML refused', assertFails(up(user, 'foundation-media/u1/x.html', 100, 'text/html')));
  await check('6 GIF refused (not in the Foundation list)', assertFails(up(user, 'foundation-media/u1/x.gif', 100, 'image/gif')));
  await check('7 photo over 15 MB refused', assertFails(up(user, 'foundation-media/u1/big.jpg', 15 * 1024 * 1024 + 1, 'image/jpeg')));
  await check('8 signed-out upload refused', assertFails(up(anon, 'foundation-media/u1/y.jpg', 100, 'image/jpeg')));
  await check('9 the OWNER cannot read their upload through rules', assertFails(user.ref('foundation-media/u1/a.jpg').getDownloadURL()));
  await check('10 another user cannot read it', assertFails(other.ref('foundation-media/u1/a.jpg').getMetadata()));
  await check('11 owner can delete their upload', assertSucceeds(user.ref('foundation-media/u1/v.mp4').delete()));
  await check('12 a user whose uid is literally "admin" cannot write to foundation-media/admin/', assertFails(up(literalAdmin, 'foundation-media/admin/z.jpg', 100, 'image/jpeg')));
  await check('13 a plain user cannot write to foundation-media/admin/', assertFails(up(user, 'foundation-media/admin/z.jpg', 100, 'image/jpeg')));
  await check('14 an admin can upload to the Media House', assertSucceeds(up(adm, 'foundation-media/admin/visit.webp', 1000, 'image/webp')));
  await check('15 an admin video over 80 MB is refused', assertFails(up(adm, 'foundation-media/admin/huge.mp4', 80 * 1024 * 1024 + 1, 'video/mp4')));
  await check('16 nobody (even admin) writes foundation-published/', assertFails(up(adm, 'foundation-published/S_1/0.jpg', 100, 'image/jpeg')));
  await check('17 nobody reads foundation-published/ through rules', assertFails(user.ref('foundation-published/S_1/0.jpg').getMetadata()));
  await check('18 unchanged live path: community-media owner upload still works', assertSucceeds(up(user, 'community-media/u1/p.jpg', 1000, 'image/jpeg')));
  await check('19 unchanged default: an unknown path is still denied', assertFails(up(user, 'random/u1/p.jpg', 1000, 'image/jpeg')));

  await env.cleanup();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(2); });
