#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════
   A FAILED LOOKUP IS NOT AN ANSWER
   ══════════════════════════════════════════════════════════════════════════
   sokoni-pos-context.js caught every failure of the businesses query and
   returned [], which resolve() then reported as `no-owned-business`. A merchant
   with 103 products, 7 paired devices and an active subscription was told they
   do not own a shop — because a query failed, not because it answered.

   It reproduced only on the normal path: the ?diag=till path additionally
   awaits a second module before resolving, which gave the auth token time to
   attach. Same code, a few hundred milliseconds later, correct answer. That is
   a race, and a race that fails CLOSED into a confident wrong statement is
   worse than one that fails loudly.

   Every case here drives the REAL resolver with a fake db, so the assertions
   are about behaviour rather than about the shape of the source.
   ══════════════════════════════════════════════════════════════════════════ */
'use strict';
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  if (ok) { pass++; console.log('  \x1b[32mPASS\x1b[0m  ' + l); }
  else { fail++; console.log('  \x1b[31mFAIL\x1b[0m  ' + l + (d ? '   [' + d + ']' : '')); }
};
const head = (t) => console.log('\n' + t + '\n' + '-'.repeat(74));

const CTX = require(path.join(ROOT, 'sokoni-pos-context.js'));
const UID = 'D5Ql2EYr95bt79IpcGTmOMTK0P83';

/* A db whose businesses query behaves however the case needs. `calls` counts
   attempts so the retry can be observed rather than assumed. */
function makeDb(businessPlan, opts) {
  opts = opts || {};
  const calls = { businesses: 0 };
  const rows = (arr) => ({ docs: arr.map((o) => ({ id: o.id, data: () => o })) });
  return {
    calls,
    collection(name) {
      return {
        where: () => ({
          get: () => {
            if (name === 'businesses') {
              calls.businesses++;
              const outcome = typeof businessPlan === 'function'
                ? businessPlan(calls.businesses) : businessPlan;
              if (outcome instanceof Error) return Promise.reject(outcome);
              return Promise.resolve(rows(outcome));
            }
            if (name === 'branches') return Promise.resolve(rows(opts.branches || []));
            return Promise.resolve(rows([]));
          },
        }),
        doc: () => ({ get: () => Promise.resolve({ exists: false, data: () => null }) }),
      };
    },
  };
}
const denied = () => Object.assign(new Error('Missing or insufficient permissions.'),
                                   { code: 'permission-denied' });
const BIZ = [{ id: UID, name: 'KASS SHOP', ownerId: UID, status: 'active' }];

(async () => {
  head('1 — a query that FAILS must not be reported as "no shop"');
  const dbFail = makeDb(() => denied());
  const rFail = await CTX.resolve({ db: dbFail, uid: UID });
  ck('L1 the decision is NOT no-owned-business', rFail.decision !== 'no-owned-business',
     String(rFail.decision));
  ck('L2 ...it is lookup-failed', rFail.decision === 'lookup-failed', String(rFail.decision));
  ck('L3 ...and it is reported as NOT ok, so no caller mistakes it for an answer',
     rFail.ok === false, String(rFail.ok));
  ck('L4 the underlying error survives for a log', /permission/i.test(String(rFail.reason)),
     String(rFail.reason).slice(0, 60));

  head('2 — the RACE it exists for: fails once, succeeds on retry');
  const dbRace = makeDb((n) => (n === 1 ? denied() : BIZ), { branches: [{ id: 'B-main', isDefault: true }] });
  const rRace = await CTX.resolve({ db: dbRace, uid: UID });
  ck('L5 it retried rather than giving up on the first failure', dbRace.calls.businesses === 2,
     dbRace.calls.businesses + ' attempt(s)');
  ck('L6 ...and recovered to a real answer', rRace.decision !== 'lookup-failed' &&
     rRace.businesses.length === 1, String(rRace.decision));
  ck('L7 ...selecting the business that actually has a branch',
     rRace.selected && rRace.selected.merchantId === UID,
     rRace.selected && rRace.selected.merchantId);

  head('3 — a GENUINELY empty result is still reported honestly');
  const dbEmpty = makeDb([]);
  const rEmpty = await CTX.resolve({ db: dbEmpty, uid: UID });
  ck('L8 NC an empty query is still no-owned-business — the fix did not mask it',
     rEmpty.decision === 'no-owned-business', String(rEmpty.decision));
  ck('L9 NC ...and it is ok:true, because that IS an answer', rEmpty.ok === true);
  ck('L10 NC ...and it did NOT waste a retry on a successful query',
     dbEmpty.calls.businesses === 1, dbEmpty.calls.businesses + ' attempt(s)');

  head('4 — a healthy lookup is unchanged');
  const dbOk = makeDb(BIZ, { branches: [{ id: 'B-main', isDefault: true }] });
  const rOk = await CTX.resolve({ db: dbOk, uid: UID });
  ck('L11 one attempt, one answer', dbOk.calls.businesses === 1);
  ck('L12 the business is returned', rOk.businesses.length === 1);
  ck('L13 NC no-db is still refused up front',
     (await CTX.resolve({ uid: UID })).reason === 'no-db');
  ck('L14 NC no-uid is still refused up front',
     (await CTX.resolve({ db: dbOk })).decision === 'sign-in');

  head('5 — branchesOf() has the SAME failure class, and the SAME treatment');
  /* A transient branch failure used to make a business look branchless. With
     two owned business records that does not merely lose the branch — it hands
     the till the OTHER business. */
  const dbBranchFail = {
    calls: { b: 0 },
    collection(name) {
      const self = this;
      const rows = (arr) => ({ docs: arr.map((o) => ({ id: o.id, data: () => o })) });
      return {
        where: () => ({ get: () => {
          if (name === 'businesses') return Promise.resolve(rows(BIZ));
          if (name === 'branches') { self.calls.b++; return Promise.reject(denied()); }
          return Promise.resolve(rows([]));
        } }),
        doc: () => ({ get: () => Promise.resolve({ exists: false, data: () => null }) }),
      };
    },
  };
  const rBranch = await CTX.resolve({ db: dbBranchFail, uid: UID });
  ck('L17 a failed BRANCH lookup is lookup-failed, not a branchless business',
     rBranch.decision === 'lookup-failed', String(rBranch.decision));
  ck('L18 ...and it retried before giving up', dbBranchFail.calls.b >= 2,
     dbBranchFail.calls.b + ' attempt(s)');
  ck('L19 ...and it did NOT quietly select a business it could not verify',
     !rBranch.selected, JSON.stringify(rBranch.selected || null));

  /* the recoverable case */
  let bTries = 0;
  const dbBranchRace = {
    collection(name) {
      const rows = (arr) => ({ docs: arr.map((o) => ({ id: o.id, data: () => o })) });
      return {
        where: () => ({ get: () => {
          if (name === 'businesses') return Promise.resolve(rows(BIZ));
          if (name === 'branches') { bTries++; return bTries === 1
            ? Promise.reject(denied())
            : Promise.resolve(rows([{ id: 'SOK-E7J2Y8-main', merchantId: UID, isDefault: true }])); }
          return Promise.resolve(rows([]));
        } }),
        doc: () => ({ get: () => Promise.resolve({ exists: false, data: () => null }) }),
      };
    },
  };
  const rbRace = await CTX.resolve({ db: dbBranchRace, uid: UID });
  ck('L20 a TRANSIENT branch failure recovers on retry',
     rbRace.decision !== 'lookup-failed' && rbRace.branches.length === 1,
     String(rbRace.decision));
  ck('L21 ...and the real branch is the one selected',
     rbRace.selected && rbRace.selected.branchId === 'SOK-E7J2Y8-main',
     rbRace.selected && rbRace.selected.branchId);
  /* L22 was written as ck('…', (async () => true)()) — a PROMISE OBJECT, which
     is always truthy. It passed without testing anything. A vacuous assertion is
     worse than a missing one: it reports coverage that does not exist. */
  const dbNoBranches = makeDb(BIZ, { branches: [] });
  const rNoBr = await CTX.resolve({ db: dbNoBranches, uid: UID });
  ck('L22 NC a business genuinely WITHOUT branches is not an error',
     rNoBr.decision !== 'lookup-failed' && rNoBr.ok !== false, String(rNoBr.decision));
  ck('L23 NC ...it still returns the business and falls back to the first id',
     rNoBr.businesses.length === 1 && rNoBr.selected &&
     rNoBr.selected.merchantId === UID, JSON.stringify(rNoBr.selected || null));

  head('5 — the till must RENDER the difference');
  const fs2 = require('fs');
  const till = fs2.readFileSync(path.join(ROOT, 'till.html'), 'utf8');
  ck('L15 the till handles lookup-failed separately from no-owned-business',
     /decision === 'lookup-failed'/.test(till));
  /* THE ORDERING BUG. lookup-failed carries ok:false on purpose, so if the
     generic !ok guard is tested FIRST the honest message is unreachable and the
     merchant sees 'Could not open the till'. That is exactly what shipped in the
     first version of this fix and exactly what the phone reported. */
  const iLookup = till.indexOf("decision === 'lookup-failed'");
  const iNotOk = till.indexOf('!ctxResult.ok');
  ck('L24 lookup-failed is tested BEFORE the generic !ok guard',
     iLookup > -1 && iNotOk > -1 && iLookup < iNotOk,
     'lookup-failed@' + iLookup + '  !ok@' + iNotOk);
  ck('L25 the underlying error CODE reaches the screen — a phone has no console',
     /ctxResult.reason/.test(till));
  ck('L16 ...and offers a RETRY rather than a verdict about their account',
     /Could not check your shop/.test(till) && /Try again/.test(till));

  console.log('\n' + '='.repeat(74));
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  console.log('='.repeat(74) + '\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR: ' + (e && e.stack || e)); process.exit(1); });
