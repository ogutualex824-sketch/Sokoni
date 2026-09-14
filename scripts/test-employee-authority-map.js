#!/usr/bin/env node
/**
 * EMPLOYEE AUTHORITY MAP — characterization, not aspiration.
 *
 *   node scripts/test-employee-authority-map.js
 *
 * There are TWO complete employment stacks in this codebase, not two spellings of one:
 *
 *   Stack A (POS/shop)        shopEmployees -> ROLE_CAPABILITIES -> posShifts
 *                             tenant key: shopOwnerId
 *   Stack B (Workforce v1.0)  workspaceMemberships -> permissions[] -> shiftSessions
 *                             tenant key: businessId
 *
 * Stack B is the designed enterprise layer. Stack A is what the POS money path actually
 * runs on. NEITHER IS CHANGED HERE. Choosing a canonical stack is an architecture decision
 * with a live blast radius; this suite exists so the current state cannot drift silently
 * while that decision is pending, and so a repair is verifiable when it is authorised.
 *
 * THE DEFECT IT RECORDS
 * shopEmployees has ONE writer (index.js, invite acceptance). It keys by auth.uid and
 * stores shopOwnerId. Five of its six consumers look it up by fields that writer never
 * produces — shopId, userId, or a composite {shopId}_{uid} doc id. Those reads cannot
 * resolve for any record the writer has ever created.
 *
 * WHY IT IS RECORDED AND NOT HOT-FIXED
 * It FAILS CLOSED: a missed read denies rather than grants, so this is a functionality
 * defect, not a privilege escalation. Every available repair converts DENY into ALLOW.
 * That is an authorisation expansion across five subsystems and needs explicit
 * authorisation plus real employment data — not a plausible-looking edit.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const FDIR = path.join(ROOT, 'functions');
const F = (p) => fs.readFileSync(path.join(FDIR, p), 'utf8');
const NL = String.fromCharCode(10);

let pass = 0, fail = 0, unproven = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 96) + ']' : ''));
  ok ? pass++ : fail++;
};
const un = (l, why) => { console.log('  UNPROVEN  ' + l + '   [' + why + ']'); unproven++; };
const head = (t) => console.log(NL + t);

const IDX = F('index.js');

console.log(NL + 'EMPLOYEE AUTHORITY MAP' + NL + '='.repeat(60));

/* ── 1 · the sole writer, and proof we can actually see it ────────────────── */
head('1 · shopEmployees has exactly one writer');
const WRITE_ANCHOR = 'collection("shopEmployees").doc(request.auth.uid).set({';
const at = IDX.indexOf(WRITE_ANCHOR);
ck('the writer was located', at > -1, 'if this fails every verdict below is vacuous');

const body = at > -1 ? IDX.slice(at + WRITE_ANCHOR.length, IDX.indexOf('});', at)) : '';
const written = [];
body.split(NL).forEach((line) => {
  const t = line.trim();
  if (!t || t.indexOf('//') === 0 || t.indexOf('*') === 0) return;
  const c = t.indexOf(':');
  if (c <= 0) return;
  const k = t.slice(0, c).trim();
  if (k && k.indexOf(' ') === -1 && k.indexOf('"') === -1 && k.indexOf("'") === -1) written.push(k);
});

/* CONTROL. A silent [] would make every consumer look dead, and the suite would "prove" a
   catastrophe that is really a parse bug. This is the assertion that makes the rest mean
   something — it must name fields we independently know are written. */
ck('CONTROL the field extractor works',
   written.indexOf('uid') > -1 && written.indexOf('role') > -1 && written.length >= 6,
   written.join(','));
ck('the writer stores shopOwnerId as its tenant key', written.indexOf('shopOwnerId') > -1);
ck('NEGATIVE the writer does NOT store shopId', written.indexOf('shopId') === -1,
   'three consumers query on it');
ck('NEGATIVE the writer does NOT store userId', written.indexOf('userId') === -1,
   'two consumers query on it');

/* ── 2 · the consumers, and whether their lookup can ever resolve ─────────── */
head('2 · five of six lookups can never resolve');
const CONSUMERS = [
  { m: 'analytics-engine.js',       needs: ['DOC:composite'] },
  { m: 'finance-os-sprint43.js',    needs: ['shopId', 'userId'] },
  { m: 'logistics-plus.js',         needs: ['shopId', 'userId'] },
  { m: 'marketplace-extensions.js', needs: ['shopId', 'uid'] },
  { m: 'pos-completeness.js',       needs: ['shopId', 'uid'] },
  { m: 'merchant-identity.js',      needs: ['DOC:uid', 'shopOwnerId'] },
];
const resolves = (needs) => needs.every((n) =>
  n === 'DOC:uid' ? true
  : n === 'DOC:composite' ? false
  : written.indexOf(n) > -1);

CONSUMERS.forEach((c) => ck(c.m + ' still reads shopEmployees', F(c.m).indexOf('shopEmployees') > -1));

const dead = CONSUMERS.filter((c) => !resolves(c.needs));
ck('exactly five lookups are dead', dead.length === 5, dead.map((d) => d.m).join(' '));
ck('merchant-identity is the one that resolves', resolves(['DOC:uid', 'shopOwnerId']));
ck('CONTROL merchant-identity binds the tenant AFTER the read',
   F('merchant-identity.js').indexOf("!== shopId) return { ok: false") > -1,
   'a doc(uid) read alone would authorise across shops');

/* ── 3 · it fails closed ──────────────────────────────────────────────────── */
head('3 · a missed read denies, never grants');
ck('analytics-engine ends in Access denied',
   F('analytics-engine.js').indexOf("throw new Error('Access denied')") > -1);
['finance-os-sprint43.js', 'logistics-plus.js', 'marketplace-extensions.js', 'pos-completeness.js']
  .forEach((m) => ck(m + ' throws on an empty read', F(m).indexOf("throw new Error('forbidden')") > -1));
ck('CONTROL no consumer treats an empty read as permission',
   CONSUMERS.every((c) => {
     const s = F(c.m);
     return s.indexOf('empty) return true') === -1 && s.indexOf('|| true') === -1;
   }),
   'this is the line between a functionality bug and an escalation');

/* ── 4 · the two stacks stay separate until a decision is taken ───────────── */
head('4 · no accidental bridge between the stacks');
const WI = F('workforce-identity.js');
const MI = F('merchant-identity.js');
ck('Stack B never reads shopEmployees', WI.indexOf('shopEmployees') === -1,
   'a bridge would silently make one stack authoritative for the other');
ck('Stack A never reads workspaceMemberships', MI.indexOf('workspaceMemberships') === -1);
ck('Stack B keys on businessId', WI.indexOf("'businessId'") > -1);
ck('Stack A keys on shopOwnerId', MI.indexOf('shopOwnerId') > -1);
/* This control used to name three stores it guessed might exist (shopStaff, employeeRecords,
   staffMembers), found none, and reported "exactly two stacks". It was wrong: posStaff,
   orgRoles, hrStaff, posRoles, posStaffAvailability and platformEmployees all existed and
   none was on the guess list. A control that enumerates its own expectations can only
   confirm them. It now CENSUSES by pattern and pins the count. */
const STORES = (function () {
  const found = {};
  const re = /collection\('([a-zA-Z]*(?:[Ss]taff|[Ee]mploye|[Mm]ember|[Rr]oles)[a-zA-Z]*)'\)/g;
  fs.readdirSync(FDIR).filter((f) => f.slice(-3) === '.js').forEach((f) => {
    let s; try { s = F(f); } catch (_) { return; }
    let m; while ((m = re.exec(s)) !== null) { found[m[1]] = (found[m[1]] || 0) + 1; }
  });
  return found;
})();
const STORE_NAMES = Object.keys(STORES).sort();
ck('CONTROL the store census finds the ones we know exist',
   STORE_NAMES.indexOf('shopEmployees') > -1 &&
   STORE_NAMES.indexOf('workspaceMemberships') > -1 &&
   STORE_NAMES.indexOf('posStaff') > -1,
   'if this fails the regex is broken and every count below is meaningless');
ck('the employment/role store count is pinned',
   STORE_NAMES.length === 8,
   STORE_NAMES.join(' '));
ck('THREE separate stores gate three POS money operations',
   F('merchant-identity.js').indexOf("collection('shopEmployees')") > -1 &&
   F('workforce-identity.js').indexOf("collection('workspaceMemberships')") > -1 &&
   F('pos-zero-friction.js').indexOf("collection('posStaff')") > -1,
   'checkout / shifts+approvals / refunds each answer to a different authority');

/* ── 5 · the fifth shift store ────────────────────────────────────────────── */
head('5 · shiftSessions exists and is NOT posShifts');
const PSO = F('pos-staff-ops.js');
ck('Stack A shift store is posShifts', PSO.indexOf("collection('posShifts')") > -1);
ck('Stack B shift store is shiftSessions', WI.indexOf("collection('shiftSessions')") > -1);
ck('NEGATIVE they are not the same collection',
   PSO.indexOf('shiftSessions') === -1 && WI.indexOf('posShifts') === -1,
   'the shift audit counted four implementations; this is a fifth');

/* ── 6 · decisions, not bugs ──────────────────────────────────────────────── */
head('6 · what needs an authority decision');
un('which stack is canonical',
   'architecture decision — Stack B is designed, Stack A carries the money path');
un('the five dead reads are repaired',
   'every repair converts DENY into ALLOW; needs authorisation plus real employment data');
un('an employee actually passes analytics authorization',
   'needs a deployed function and a real shopEmployees record');
un('shift convergence',
   'BLOCKED — five stores; converging before the employee decision would encode the wrong one');

console.log(NL + '  ' + pass + ' passed, ' + fail + ' failed, ' + unproven + ' unproven');
console.log('  NOTE: characterization only. Nothing here changes an authorization path.');
process.exit(fail ? 1 : 0);
