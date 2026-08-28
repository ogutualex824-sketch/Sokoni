#!/usr/bin/env node
/* The merchant-authority primitive and its application. EXECUTED, not matched.
 *
 * A regex assertion is not enough here: earlier in this workstream a source
 * pattern passed even when `if (!normPhone)` had been replaced with `if (false)`,
 * because it only proved a throw was nearby. So the primitive is run against
 * fixtures, and the vulnerable call sites are checked for the SHAPE that made
 * them vulnerable rather than for the presence of a reassuring line.
 *
 *   node scripts/test-merchant-authority.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const Module = require('module');

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + d + ']' : ''));
  ok ? pass++ : fail++;
};
const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/* ── Load the primitive with firebase-admin and HttpsError stubbed ───────── */
function loadPrimitive(docs) {
  const src = read('functions', 'merchant-authority.js');
  const m = new Module('merchant-authority', null);
  const fake = {
    'firebase-functions/v2/https': {
      HttpsError: class extends Error {
        constructor(code, msg) { super(msg); this.code = code; }
      },
    },
    'firebase-admin': {
      firestore: () => ({
        collection: (c) => ({
          doc: (id) => ({
            get: async () => {
              const d = docs[c + '/' + id];
              return { exists: d !== undefined, data: () => d };
            },
          }),
        }),
      }),
    },
  };
  m.require = (id) => (fake[id] ? fake[id] : require(id));
  m._compile(src, path.join(ROOT, 'functions', 'merchant-authority.js'));
  return m.exports;
}

const OWNER = 'owner-uid';
const OTHER = 'other-uid';
const MID   = 'SOK-TESTAA';
const DOCS  = { ['businesses/' + MID]: { ownerId: OWNER } };

const run = async (auth, requested, docs) => {
  const { assertMerchantAccess } = loadPrimitive(docs || DOCS);
  try { return { ok: true, value: await assertMerchantAccess(auth, requested) }; }
  catch (e) { return { ok: false, code: e.code }; }
};

(async () => {
  console.log('\nA. The primitive, executed\n');
  {
    ck('owner may act for their merchant',
       (await run({ uid: OWNER }, MID)).value === MID);
    ck('a NON-owner is DENIED',
       (await run({ uid: OTHER }, MID)).code === 'permission-denied');
    ck('unauthenticated is refused',
       (await run(null, MID)).code === 'unauthenticated');
    ck('a caller acting for THEMSELVES is allowed without a lookup',
       (await run({ uid: OTHER }, OTHER)).value === OTHER,
       'merchants operating under their own uid must keep working');
    ck('merchantId defaults to the caller when omitted',
       (await run({ uid: OTHER }, undefined)).value === OTHER);

    /* FAIL CLOSED — the whole point. */
    ck('a MISSING authority document DENIES',
       (await run({ uid: OTHER }, 'SOK-NOSUCH')).code === 'permission-denied');
    ck('  ...even for a doc that exists but has no ownerId',
       (await run({ uid: OTHER }, MID, { ['businesses/' + MID]: {} })).code === 'permission-denied');

    /* The fail-open being replaced: adminUids ABSENT must not grant. */
    ck('adminUids ABSENT does NOT grant a non-owner',
       (await run({ uid: OTHER }, MID, { ['businesses/' + MID]: { ownerId: OWNER } })).code === 'permission-denied',
       'the crm.js bug');
    ck('adminUids present but not containing the caller DENIES',
       (await run({ uid: OTHER }, MID, { ['businesses/' + MID]: { ownerId: OWNER, adminUids: ['someone'] } })).code === 'permission-denied');
    ck('adminUids containing the caller ALLOWS',
       (await run({ uid: OTHER }, MID, { ['businesses/' + MID]: { ownerId: OWNER, adminUids: [OTHER] } })).value === MID);
    ck('a non-array adminUids cannot grant',
       (await run({ uid: OTHER }, MID, { ['businesses/' + MID]: { ownerId: OWNER, adminUids: OTHER } })).code === 'permission-denied',
       'truthy string must not be treated as membership');

    /* Admin bypass — claims only. */
    ck('admin CLAIM bypasses', (await run({ uid: OTHER, token: { admin: true } }, MID)).value === MID);
    ck('superAdmin CLAIM bypasses', (await run({ uid: OTHER, token: { superAdmin: true } }, MID)).value === MID);
    ck('a truthy-but-not-true admin claim does NOT bypass',
       (await run({ uid: OTHER, token: { admin: 'true' } }, MID)).code === 'permission-denied');
    ck('a users-document role can NEVER bypass (no such input exists)',
       !/\.role\b/.test(strip(read('functions', 'merchant-authority.js'))));

    /* Document-id safety. */
    ck('an id containing "/" is refused',
       (await run({ uid: OTHER }, 'a/b')).code === 'invalid-argument');
    ck('an over-long id is refused',
       (await run({ uid: OTHER }, 'x'.repeat(250))).code === 'invalid-argument');
  }

  console.log('\nB. The vulnerable shapes are gone from the call sites\n');
  {
    const per = strip(read('functions', 'pos-peripherals.js'));
    ck('pos-peripherals no longer reads users.merchantId for authz',
       !/userData\.merchantId\s*!==/.test(per));
    ck('  ...and all three callables assert the primitive',
       (per.match(/assertMerchantAccess\(request\.auth, merchantId\)/g) || []).length === 3);

    const zf = strip(read('functions', 'pos-zero-friction.js'));
    ck('posGetQueueMetrics asserts the primitive',
       /assertMerchantAccess\(auth, merchantId\)/.test(zf));

    const bh = strip(read('functions', 'business-health-score.js'));
    ck('all three health-score callables assert the primitive',
       (bh.match(/assertMerchantAccess\(request\.auth, merchantId\)/g) || []).length === 3);

    const crm = strip(read('functions', 'crm.js'));
    ck('crm fail-open corrected to an explicit array test',
       /Array\.isArray\(data\.adminUids\) && data\.adminUids\.includes\(uid\)/.test(crm));
    ck('  ...the fail-open shape is gone',
       !/data\.adminUids && !data\.adminUids\.includes/.test(crm));
  }

  console.log('\nC. Already-safe implementations left alone\n');
  {
    const sf = strip(read('functions', 'sfos-engine.js'));
    ck('sfos-engine still verifies shops.ownerUid', /shopSnap\.data\(\)\.ownerUid !== uid/.test(sf));
    ck('sfos-engine does NOT import the new primitive', !/merchant-authority/.test(sf));
    ck('self-heal untouched by this change', !/merchant-authority/.test(strip(read('functions', 'self-heal.js'))));
  }

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('  SUITE CRASHED: ' + (e && e.stack || e)); process.exit(1); });
