/* PT — provider trust lock (2026-10-03). Emulator-backed, against a rules FILE.
   One hunk, three sources: sokoni-b2 Tech 4P (docs/RULES_PATCH_4P_PROVIDER_TRUST.md @ e5eb1d6, rows R-1..R-6),
   sokoni-5b security slice item 1 (owner: a provider cannot change its approved category directly),
   sokoni-e3 (providers.linkedBusinessId server-written only).

   Run (test the BUILT artefact — it is what Firebase serves):
     node scripts/build-firestore-rules.js
     RULES_FILE=firestore.rules.build FIRESTORE_PORT=<port> \
       firebase emulators:exec --only firestore --project demo-provider-trust "node scripts/zz-test-provider-trust.js"
   Baseline (the PT-D rows must FAIL there): RULES_FILE=firestore.rules.served-f259c0b5

   CONTRACT
     providers/{uid}  owner create: uid==self, status absent or 'pending', none of the trust keys.
                      owner update: never status / verified / suspended / approved / featured / providerVerified /
                      isVerified / badges / rating / reviewCount / jobsCompleted / verifiedFacets / verifiedName /
                      verificationReviewRequired / verificationProjectedAt / searchable / business /
                      sourceApplicationId / approvedAt / suspendedAt / category / linkedBusinessId.
                      Profile content (bio, phone, …) stays owner-editable. Admin raw writes: everything but business.
     services/{id}    owner create/update: never providerVerified / isVerified / badges / rating / reviewCount.
     verifications    write:false (already closed on this line and on served f259c0b5) — R-1/R-2 recorded. */
'use strict';
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const fs = require('fs'), path = require('path');
const { doc, setDoc, updateDoc } = require('firebase/firestore');

let pass = 0, fail = 0;
const ck = (id, ok, m, d) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + id + '  ' + m + (ok || !d ? '' : '   [' + String(d).slice(0, 90) + ']')); ok ? pass++ : fail++; };
const allows = async (id, m, p) => { try { await assertSucceeds(p); ck(id, true, m); } catch (e) { ck(id, false, m, e.message); } };
const denies = async (id, m, p) => { try { await assertFails(p); ck(id, true, m); } catch (e) { ck(id, false, m, e.message); } };

const LOCKED_UPDATE = {
  status: 'active', verified: true, suspended: false, approved: true, featured: true, providerVerified: true, isVerified: true,
  badges: ['verified'], rating: 5, reviewCount: 99, jobsCompleted: 500, verifiedFacets: { identity: 'approved' },
  verifiedName: 'Forged Name', verificationReviewRequired: false, verificationProjectedAt: 1, searchable: true,
  business: { category: 'it_services' }, sourceApplicationId: 'app-forged', approvedAt: 1, suspendedAt: null,
  category: 'mechanic', linkedBusinessId: 'biz-someone-else',
  healthcare: { category: 'facility' }, legalProviderId: 'lp-forged', provisionedBy: 'legal-verification', legalVerification: { state: 'verified' },
};

(async () => {
  const file = process.env.RULES_FILE || 'firestore.rules.build';
  const env = await initializeTestEnvironment({
    projectId: 'demo-provider-trust',
    firestore: { rules: fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8'), host: '127.0.0.1', port: Number(process.env.FIRESTORE_PORT || 8080) },
  });
  console.log('\nPT provider trust lock   RULES_FILE=' + file + '\n');
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (c) => {
    const d = c.firestore();
    await setDoc(doc(d, 'providers/alice'), { uid: 'alice', name: 'Alice Garage', bio: 'old', phone: '0700', status: 'pending', category: 'garage' });
    await setDoc(doc(d, 'services/svcA'), { uid: 'alice', name: 'Oil change', status: 'active', price: 1500 });
  });
  const alice = env.authenticatedContext('alice').firestore();
  const bob = env.authenticatedContext('bob').firestore();
  const admin = env.authenticatedContext('admin1', { admin: true }).firestore();

  console.log('── verifications (b2 R-1 / R-2) ──');
  await denies('PT-R1', 'owner creates verifications/{self} with facets.identity.state:approved', setDoc(doc(bob, 'verifications/bob'), { status: 'pending', facets: { identity: { state: 'approved' } } }));
  /* R-2 on THIS line: verifications is write:false entirely (owner 2026-10-01) — a plain pending create is refused too. */
  await denies('PT-R2', 'owner creates verifications/{self} {status:pending} — refused on this line (write:false; verificationSubmit is the writer)', setDoc(doc(bob, 'verifications/bob'), { status: 'pending' }));

  console.log('── providers create ──');
  await allows('PT-C1', 'onboarding create: uid==self, status pending, profile fields only', setDoc(doc(bob, 'providers/bob'), { uid: 'bob', name: 'Bob Mechanic', phone: '0711', status: 'pending' }));
  await denies('PT-C2', 'create with status active', setDoc(doc(env.authenticatedContext('carol').firestore(), 'providers/carol'), { uid: 'carol', status: 'active' }));
  for (const k of ['featured', 'providerVerified', 'rating', 'business', 'category', 'linkedBusinessId', 'searchable', 'jobsCompleted']) {
    const u = 'u_' + k; const v = LOCKED_UPDATE[k];
    await denies('PT-C-' + k, `create carrying ${k}`, setDoc(doc(env.authenticatedContext(u).firestore(), 'providers/' + u), { uid: u, status: 'pending', [k]: v }));
  }

  console.log('── providers update (b2 R-3 / R-4, 5b category, e3 linkedBusinessId) ──');
  await allows('PT-R4', 'owner edits bio / phone', updateDoc(doc(alice, 'providers/alice'), { bio: 'new bio', phone: '0722' }));
  for (const [k, v] of Object.entries(LOCKED_UPDATE)) {
    await denies('PT-D-' + k, `owner sets ${k}`, updateDoc(doc(alice, 'providers/alice'), { [k]: v }));
  }
  await denies('PT-X1', 'another user edits alice\'s profile', updateDoc(doc(bob, 'providers/alice'), { bio: 'pwned' }));

  console.log('── services (b2 R-5) ──');
  await allows('PT-S0', 'owner edits own service name', updateDoc(doc(alice, 'services/svcA'), { name: 'Full service' }));
  for (const k of ['providerVerified', 'isVerified', 'badges', 'rating', 'reviewCount']) {
    await denies('PT-S-' + k, `owner sets ${k} on own service`, updateDoc(doc(alice, 'services/svcA'), { [k]: k === 'badges' ? ['x'] : (k === 'rating' || k === 'reviewCount' ? 5 : true) }));
  }
  await denies('PT-S-create', 'owner creates a service already carrying providerVerified', setDoc(doc(alice, 'services/svcNew'), { uid: 'alice', name: 'Brakes', providerVerified: true }));

  console.log('── admin (b2 R-6) ──');
  await allows('PT-R6a', 'admin sets featured / rating / category / linkedBusinessId on providers', updateDoc(doc(admin, 'providers/alice'), { featured: true, rating: 4.5, category: 'mechanic', linkedBusinessId: 'biz1' }));
  await denies('PT-R6b', 'admin raw write of business stays refused (server-only: applicationDecide / bizAdminClassify)', updateDoc(doc(admin, 'providers/alice'), { business: { category: 'x' } }));
  await allows('PT-R6c', 'admin sets providerVerified on a service', updateDoc(doc(admin, 'services/svcA'), { providerVerified: true }));

  await env.cleanup();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR (not a rules result):', e.message); process.exit(2); });
