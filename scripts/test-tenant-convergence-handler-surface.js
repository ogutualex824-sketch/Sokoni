#!/usr/bin/env node
/* TENANT CONVERGENCE — _requireSeller, proven against the affected handler surface.
 *
 * WHY THIS SUITE EXISTS
 * `registerClientShift` (committed as bc44f33) depends on the converged `_requireSeller`.
 * That function has 20 call sites across 22 handlers and feeds 15 queries keyed on the value
 * it returns. Deploying P15C therefore changes the tenant key EVERY live shift, cash and
 * approval handler resolves to. That is a material boundary, not an implementation detail,
 * so it is proven on its own before any production deploy.
 *
 * HOW IT EXECUTES
 * `_requireSeller` is module-private, so both the PRE-convergence and POST-convergence
 * versions are sliced out of their real sources and compiled with dependencies injected —
 * the shipping bytes, not a paraphrase. The resolver itself is the REAL
 * `tenant-identity.js`, driven by a fake Firestore. Old and new run against IDENTICAL
 * fixtures so the behavioural delta is observed rather than described.
 *
 * WHAT IT DOES NOT DO
 * It performs NO migration and NO backfill, and it does not guess a mapping for any legacy
 * record. Whether real production documents carry legacy uid tenancy is a PRODUCTION DATA
 * question that requires a read-only credential; it is reported UNPROVEN here rather than
 * estimated. See docs/ADR013_IMPLEMENTATION_MAP.md.
 */
'use strict';
const path   = require('path');
const fs     = require('fs');
const Module = require('module');
const ROOT   = path.resolve(__dirname, '..');
const PSO    = path.join(ROOT, 'functions/pos-staff-ops.js');

let pass = 0, fail = 0, unproven = 0;
function head (t) { console.log('\n' + t); }
function ck (label, cond, note) {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (note ? '   [' + note + ']' : '')); }
}
function unk (label, why) { unproven++; console.log('  UNPROVEN  ' + label + '   [' + why + ']'); }

async function caught (fn) {
  try { const value = await fn(); return { ok: true, value, err: null }; }
  catch (err) { return { ok: false, value: null, err: err || new Error('unknown') }; }
}

class HttpsError extends Error {
  constructor (code, message) { super(message); this.code = code; }
}

/* ── The REAL resolver, driven by a fake Firestore ───────────────────────────── */
function loadResolver (businesses) {
  const real = Module._load;
  Module._load = function (request) {
    if (request === 'firebase-admin') {
      /* `apps` must be non-empty or the module calls initializeApp() on the stub. */
      return { apps: [{}], initializeApp: () => {}, firestore: () => ({
        collection: () => ({
          where: (f, op, v) => ({
            /* `limit` MUST be honoured. A fake that ignored it made the ambiguity
               assertion pass for the wrong reason: narrowing the real limit(2) to
               limit(1) drew zero failures, because slice(0,2) was hardcoded here. */
            limit: (n) => ({
              get: async () => {
                const rows = Object.keys(businesses)
                  .filter((id) => businesses[id][f] === v)
                  .slice(0, n)
                  .map((id) => ({ id, data: () => businesses[id] }));
                return { empty: rows.length === 0, size: rows.length, docs: rows };
              },
            }),
          }),
        }),
      }) };
    }
    return real.apply(this, arguments);
  };
  try {
    const p = path.join(ROOT, 'functions/tenant-identity.js');
    delete require.cache[require.resolve(p)];
    return require(p);
  } finally { Module._load = real; }
}

/* ── Slice a named function out of a source string and compile it ────────────── */
function compileRequireSeller (src, deps) {
  const a = src.indexOf('async function _requireSeller');
  if (a < 0) return null;
  /* Take up to the first line that is exactly "}" at column 0 — the function's end. */
  const rest = src.slice(a);
  const end  = rest.indexOf('\n}\n');
  if (end < 0) return null;
  const body = rest.slice(0, end + 3);
  const names = Object.keys(deps);
  // eslint-disable-next-line no-new-func
  const factory = new Function(...names, body + '\nreturn _requireSeller;');
  return factory(...names.map((n) => deps[n]));
}

const OWNER = 'uid_owner_1';
const CASHIER = 'uid_cashier_9';
const MERCHANT = 'MID-abc123';
const BUSINESSES = { [MERCHANT]: { ownerId: OWNER, status: 'active' } };

/* A permission stub that records what it was asked, so "membership was consulted" is
   observed rather than assumed. */
function makePerm (allowed) {
  const calls = [];
  return {
    calls,
    fn: async (uid, mid) => {
      calls.push({ uid, mid });
      if (!allowed.some((a) => a.uid === uid && a.mid === mid)) {
        throw new HttpsError('permission-denied', 'not a member');
      }
      return true;
    },
  };
}

(async () => {

const NEW_SRC = fs.readFileSync(PSO, 'utf8');
/* The pre-convergence version, captured verbatim from the deployed lineage. */
const OLD_SRC = [
  'async function _requireSeller(auth, data) {',
  '  const sellerId = data && data.sellerId;',
  "  if (!sellerId || typeof sellerId !== 'string')",
  "    throw new HttpsError('invalid-argument', 'sellerId is required');",
  '  if (auth.uid === sellerId) return sellerId;',
  "  await _assertBusinessPermission(auth.uid, sellerId, 'pos');",
  '  return sellerId;',
  '}',
  '',
].join('\n');

/* ── 1 · CONTROL ─────────────────────────────────────────────────────────────── */
head('1 · CONTROL — both versions must compile and run');
const R = loadResolver(BUSINESSES);
ck('CONTROL the REAL resolver loaded', typeof R.resolveMerchantIdForOwner === 'function');
{
  const r = await R.resolveMerchantIdForOwner(OWNER);
  ck('CONTROL the resolver maps the owner uid to the canonical merchant id',
     r.ok === true && r.merchantId === MERCHANT, JSON.stringify(r));
}
const permNew = makePerm([{ uid: CASHIER, mid: MERCHANT }]);
const permOld = makePerm([{ uid: CASHIER, mid: MERCHANT }]);
const NEW = compileRequireSeller(NEW_SRC, {
  HttpsError, looksLikeOwnerForm: R.looksLikeOwnerForm,
  resolveMerchantIdForOwner: R.resolveMerchantIdForOwner,
  TENANT_REASON: R.REASON, _assertBusinessPermission: permNew.fn,
});
const OLD = compileRequireSeller(OLD_SRC, { HttpsError, _assertBusinessPermission: permOld.fn });
ck('CONTROL the converged version compiled', typeof NEW === 'function');
ck('CONTROL the pre-convergence version compiled', typeof OLD === 'function');

/* ── 2 · THE BEHAVIOURAL DELTA, executed on identical input ──────────────────── */
head('2 · owner sends their own uid — the change that moves the tenant key');
{
  const oldOut = await caught(() => OLD({ uid: OWNER }, { sellerId: OWNER }));
  const newOut = await caught(() => NEW({ uid: OWNER }, { sellerId: OWNER }));
  ck('BEFORE: the owner uid was returned unchanged', oldOut.ok && oldOut.value === OWNER,
     'old -> ' + oldOut.value);
  ck('AFTER: the canonical merchant id is returned', newOut.ok && newOut.value === MERCHANT,
     'new -> ' + newOut.value);
  ck('THE DELTA IS REAL: the two versions return DIFFERENT tenant keys',
     oldOut.value !== newOut.value,
     'every one of the 15 sellerId-keyed queries changes key for this caller');
}

/* ── 3 · LEGACY REACHABILITY — the consequence, executed ─────────────────────── */
head('3 · records written under the legacy key');
{
  /* A shift written by the OLD code, then looked up by the NEW code. No migration is
     performed here; this only establishes what the lookup does. */
  const legacyRows = [{ id: 'shift_legacy', sellerId: OWNER }];
  const findBy = (key) => legacyRows.filter((r) => r.sellerId === key);

  /* Wrapped: a sabotage that makes either version throw must be REPORTED, not crash the
     harness and take every later assertion with it. */
  const oldR = await caught(() => OLD({ uid: OWNER }, { sellerId: OWNER }));
  const newR = await caught(() => NEW({ uid: OWNER }, { sellerId: OWNER }));
  const oldKey = oldR.ok ? oldR.value : '__OLD_THREW__';
  const newKey = newR.ok ? newR.value : '__NEW_THREW__';

  ck('a legacy record IS found under the old key', findBy(oldKey).length === 1,
     oldR.ok ? 'key=' + oldKey : 'old threw ' + String(oldR.err.code));
  ck('THE RISK: the same record is NOT found under the converged key',
     newR.ok && findBy(newKey).length === 0,
     newR.ok ? 'a historical record becomes unreachable unless migrated or dual-read'
             : 'new threw ' + String(newR.err.code));
  unk('how many REAL production records carry legacy uid tenancy',
      'requires a read-only production credential; not estimated, not guessed');
  unk('whether every legacy record can be deterministically mapped',
      'unmappable records must be classified unresolved, never guessed');
}

/* ── 4 · OWNER AND EMPLOYEE PATHS ────────────────────────────────────────────── */
head('4 · owner and employee/cashier resolution');
{
  const asMerchant = await caught(() => NEW({ uid: OWNER }, { sellerId: MERCHANT }));
  ck('the owner may also send the merchant id explicitly',
     asMerchant.ok && asMerchant.value === MERCHANT);
  ck('NEGATIVE that path did NOT need a membership read',
     permNew.calls.every((c) => c.uid !== OWNER),
     'the owner is recognised by ownership, not membership');

  const before = permNew.calls.length;
  const emp = await caught(() => NEW({ uid: CASHIER }, { sellerId: MERCHANT }));
  ck('a cashier who is a member resolves to the same merchant',
     emp.ok && emp.value === MERCHANT);
  ck('the cashier path DID consult membership', permNew.calls.length > before &&
     permNew.calls[permNew.calls.length - 1].uid === CASHIER);
}

/* ── 5 · REFUSALS — nothing client-supplied becomes authority ────────────────── */
head('5 · cross-tenant refusal and client-identity refusal');
{
  const cross = await caught(() => NEW({ uid: CASHIER }, { sellerId: 'MID-someone-else' }));
  ck('NEGATIVE a cashier cannot reach another merchant',
     !cross.ok && cross.err.code === 'permission-denied',
     cross.ok ? 'it RESOLVED to ' + cross.value : String(cross.err.code));

  const spoof = await caught(() => NEW({ uid: CASHIER }, { sellerId: OWNER }));
  ck('NEGATIVE naming the owner uid does not grant the owner tenancy',
     !spoof.ok && spoof.err.code === 'permission-denied',
     spoof.ok ? 'it RESOLVED to ' + spoof.value : String(spoof.err.code));

  const missing = await caught(() => NEW({ uid: OWNER }, {}));
  ck('a missing sellerId is refused', !missing.ok && missing.err.code === 'invalid-argument');

  /* Ambiguity and unlinked accounts must REFUSE, never pick one. */
  const R2 = loadResolver({ 'MID-a': { ownerId: OWNER, status: 'active' },
                            'MID-b': { ownerId: OWNER, status: 'active' } });
  const NEW2 = compileRequireSeller(NEW_SRC, {
    HttpsError, looksLikeOwnerForm: R2.looksLikeOwnerForm,
    resolveMerchantIdForOwner: R2.resolveMerchantIdForOwner,
    TENANT_REASON: R2.REASON, _assertBusinessPermission: makePerm([]).fn,
  });
  const amb = await caught(() => NEW2({ uid: OWNER }, { sellerId: OWNER }));
  ck('NEGATIVE two businesses for one owner REFUSES rather than picking one',
     !amb.ok && amb.err.code === 'failed-precondition',
     amb.ok ? 'it silently chose ' + amb.value : String(amb.err.code));

  const R3 = loadResolver({});
  const NEW3 = compileRequireSeller(NEW_SRC, {
    HttpsError, looksLikeOwnerForm: R3.looksLikeOwnerForm,
    resolveMerchantIdForOwner: R3.resolveMerchantIdForOwner,
    TENANT_REASON: R3.REASON, _assertBusinessPermission: makePerm([]).fn,
  });
  const unl = await caught(() => NEW3({ uid: OWNER }, { sellerId: OWNER }));
  ck('NEGATIVE an unlinked account is refused, not defaulted to its uid',
     !unl.ok && unl.err.code === 'failed-precondition');

  const R4 = loadResolver({ 'MID-x': { ownerId: OWNER, status: 'suspended' } });
  const NEW4 = compileRequireSeller(NEW_SRC, {
    HttpsError, looksLikeOwnerForm: R4.looksLikeOwnerForm,
    resolveMerchantIdForOwner: R4.resolveMerchantIdForOwner,
    TENANT_REASON: R4.REASON, _assertBusinessPermission: makePerm([]).fn,
  });
  const ina = await caught(() => NEW4({ uid: OWNER }, { sellerId: OWNER }));
  ck('NEGATIVE an inactive business does not resolve', !ina.ok);
}

/* ── 6 · HANDLER SURFACE — every call site uses the RESOLVED value ───────────── */
head('6 · the affected handler surface');
{
  const SRC = fs.readFileSync(PSO, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');   /* never assert on prose */
  const sites = (SRC.match(/_requireSeller\(/g) || []).length - 1;     /* minus the definition */
  ck('CONTROL the call sites were counted', sites > 10, sites + ' call sites');
  ck('every call site binds the RESULT to sellerId',
     (SRC.match(/const sellerId = await _requireSeller\(/g) || []).length === sites,
     sites + ' sites, ' + (SRC.match(/const sellerId = await _requireSeller\(/g) || []).length + ' bound');
  ck('NEGATIVE no handler queries on the RAW client value',
     SRC.indexOf("where('sellerId', '==', data.sellerId)") === -1);
  const keyed = (SRC.match(/where\('sellerId', '==', sellerId\)/g) || []).length;
  ck('the sellerId-keyed queries all use the resolved identity', keyed >= 10, keyed + ' queries');
}

head('RESULT');
console.log('  ' + pass + ' passed, ' + fail + ' failed, ' + unproven + ' unproven');
process.exit(fail > 0 ? 1 : 0);

})().catch((e) => { console.error('HARNESS CRASH', e); process.exit(2); });
