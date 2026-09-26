/* sabotage-creator-hub.js — plant each attack the Creator Hub must stop, run the
 * suite that owns it, and require the EXPECTED case to go red.
 *
 *   CAUGHT        suite failed, and on the expected case
 *   CAUGHT-OTHER  suite failed, but not on the expected case (counted caught, flagged)
 *   MISSED        suite stayed green — the control is inert
 *   CRASHED       suite crashed — not a detection
 *   NO-ANCHOR     the code to sabotage is gone — the mutation proves nothing
 *
 * Every file is restored byte-for-byte in `finally`; a post-restore run proves
 * the tree is green again. Run with the worktree QUIESCENT (no other suite
 * running against these files).
 *
 *   node scripts/sabotage-creator-hub.js            (all, incl. emulator rules)
 *   node scripts/sabotage-creator-hub.js --no-rules (skip the emulator mutations)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SUITES = {
  royalty:    ['node', ['scripts/test-creator-royalty.js']],
  publishing: ['node', ['scripts/test-creator-publishing.js']],
  hub:        ['node', ['scripts/test-creator-hub.js']],
  rules:      ['node', ['scripts/run-creator-rules.js']],
};
const HUB = 'functions/creator-hub.js';
const ROY = 'functions/shared/creator-royalty.js';
const PUB = 'functions/shared/creator-publishing.js';
const WM  = 'functions/shared/creator-watermark.js';

const M = [
  /* ── forged percentages / participants ── */
  { name: 'forged royalty %: Σ > 100% accepted', file: ROY, suite: 'royalty',
    from: 'if (total > BPS_TOTAL) errors.push', to: 'if (false) errors.push', expect: /Σ > 100% refused/ },
  { name: 'forged royalty %: negative share accepted', file: ROY, suite: 'royalty',
    from: "else if (bps <= 0) errors.push(`${at}.bps must be > 0`);", to: '', expect: /negative share refused/ },
  { name: 'forged participant: duplicate uid+role accepted', file: ROY, suite: 'royalty',
    from: "if (uid && roles.has(roleKey)) errors.push", to: 'if (false) errors.push', expect: /same uid SAME role refused/ },
  { name: 'allocation drift: largest-remainder removed', file: ROY, suite: 'royalty',
    from: 'for (let i = 0; left > 0; i = (i + 1) % order.length) { order[i].amountCents += 1; left -= 1; }', to: '', expect: /Σ allocated == pool|Σ == pool|sums exactly/ },
  { name: 'locked agreement mutable: re-lock of LOCKED allowed', file: ROY, suite: 'royalty',
    from: "if (draft.status !== AGREEMENT_STATUS.DRAFT) throw", to: 'if (false) throw', expect: /locking a LOCKED version refused/ },
  /* ── double royalty ── */
  { name: 'double royalty: accrual claim create() → set(), no pre-check', file: HUB, suite: 'hub',
    edits: [['if (pre.exists) return { alreadyAccrued: true, status: pre.data().status };', ''],
            ['if (acc.exists) return { alreadyAccrued: true, status: acc.data().status };', ''],
            [/txn\.create\(accRef, \{\n        \.\.\.base, status: 'ACCRUED'/, "txn.set(accRef, {\n        ...base, status: 'ACCRUED'"],
            [/txn\.create\(L\.doc\(/g, 'txn.set(L.doc(']],
    expect: /concurrent accruals|replay → still ONE allocation|alreadyAccrued/ },
  { name: 'double withdrawal: distribution claim create() → set(), no reconcile', file: HUB, suite: 'hub',
    edits: [["txn.create(wtxRef, { uid: s.uid, type: 'royalty_release'", "txn.set(wtxRef, { uid: s.uid, type: 'royalty_release'"],
            ['if (wtx.exists) {', 'if (false) {'],
            ['if (c.released) return \'already\';', '']],
    expect: /NOT re-credited|credits NOTHING twice/ },
  /* ── payment completion / royalty without payment ── */
  { name: 'royalty credit without payment: honourable-payment check removed', file: HUB, suite: 'hub',
    from: "try { engine.assertPaymentHonourable(intent, payment); } catch (e) { return { refused: e.code || 'not_honourable' }; }", to: '',
    expect: /PENDING payment refused|payment by a different uid refused/ },
  { name: 'fee assumed zero when unreported', file: HUB, suite: 'hub',
    from: "return { cents: null, source: 'unreported' };", to: "return { cents: 0, source: 'unreported' };", expect: /unreported fee → accrual WITHHELD/ },
  { name: 'sellerUid leaks onto the film intent (webhook would credit a seller)', file: HUB, suite: 'hub',
    from: "type: PURPOSE, filmId, creatorUid: f.creatorUid,", to: "type: PURPOSE, sellerUid: f.creatorUid, filmId, creatorUid: f.creatorUid,", expect: /NO sellerUid/ },
  { name: 'webhook film branch removed (seller/buyer credit path reopens)', file: 'functions/index.js', suite: 'hub',
    from: '_fiSnap.exists && _fiSnap.data().purpose === "film_access"', to: 'false', expect: /webhook film branch exists/ },
  /* ── forged creator / ownership / cross-creator ── */
  { name: 'cross-creator: film ownership check removed', file: HUB, suite: 'hub',
    from: "if (f.creatorUid !== uid && !(allowAdmin && isAdmin)) fail('permission-denied', 'Not your film.');", to: '', expect: /cross-creator edit denied/ },
  { name: 'forged ownership: server-owned field accepted', file: PUB, suite: 'publishing',
    from: "if (refused.length) throw _err('field_server_owned'", to: "if (false) throw _err('field_server_owned'", expect: /server-owned "creatorUid" refused/ },
  { name: 'creator self-approval path added to the state machine', file: PUB, suite: 'publishing',
    from: "      DRAFT:     ['SUBMITTED'],", to: "      DRAFT:     ['SUBMITTED'],\n      SUBMITTED: ['APPROVED'],", expect: /no creator transition INTO APPROVED/ },
  { name: 'forged settlement: self-approval of a period allowed', file: ROY, suite: 'royalty',
    from: "if (to === PERIOD_STATUS.APPROVED && calculatedBy && actorUid === calculatedBy) {", to: 'if (false) {', expect: /self-approval refused/ },
  { name: 'forged payout: distribute admin guard removed', file: HUB, suite: 'hub',
    from: "_adminH.creatorAdminDistribute = async (req) => {\n  const actor = _admin(req);", to: "_adminH.creatorAdminDistribute = async (req) => {\n  const actor = (req.auth && req.auth.uid) || 'anon';", expect: /creatorAdmin\* ops refuse a non-admin/ },
  /* ── playback ── */
  { name: 'playback without entitlement: status check removed', file: PUB, suite: 'publishing',
    from: "if (entitlement.status !== 'ACTIVE') return", to: 'if (false) return', expect: /refunded \(REVOKED\) viewer denied/ },
  { name: 'playback: concurrent-session limit removed', file: PUB, suite: 'publishing',
    from: "if (live.length >= PLAYBACK.MAX_CONCURRENT_SESSIONS) return", to: 'if (false) return', expect: /third concurrent session denied/ },
  { name: 'watermark leaks the full email', file: WM, suite: 'publishing',
    from: "const ident = maskEmail(email) || maskPhone(phone) || 'viewer';", to: "const ident = email || maskPhone(phone) || 'viewer';", expect: /NO full email in payload/ },
  /* ── rules (real emulator) ── */
  { name: 'rules: participant can write the royalty ledger', file: 'firestore.rules.build', suite: 'rules', rules: true,
    from: /match \/royaltyLedger\/\{entryId\}\s*\{([\s\S]*?)allow write:\s*if false;/, to: (m) => m.replace(/allow write:\s*if false;/, 'allow write: if isAuthed();'),
    expect: /participant credits themselves in the ledger DENIED/ },
  { name: 'rules: buyer can write an entitlement', file: 'firestore.rules.build', suite: 'rules', rules: true,
    from: /match \/contentEntitlements\/\{paymentRef\}\s*\{([\s\S]*?)allow write:\s*if false;/, to: (m) => m.replace(/allow write:\s*if false;/, 'allow write: if isAuthed();'),
    expect: /buyer writes an entitlement DENIED/ },
  { name: 'storage: film masters become readable', file: 'storage.rules', suite: 'rules', rules: true,
    from: "match /creator-masters/{uid}/{filmId}/{uploadId} {\n      allow read:   if false;", to: "match /creator-masters/{uid}/{filmId}/{uploadId} {\n      allow read:   if request.auth != null;", expect: /viewer reads a master DENIED/ },
];

const noRules = process.argv.includes('--no-rules');
function run(suite) {
  const [cmd, args] = SUITES[suite];
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', timeout: 400000, maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
function apply(src, m) {
  const edits = m.edits || [[m.from, m.to]];
  let out = src;
  for (const [from, to] of edits) {
    if (typeof from === 'string') {
      const n = out.split(from).length - 1;
      if (n !== 1) return { error: `anchor found ${n}×: ${from.slice(0, 60)}` };
      out = out.replace(from, to);
    } else {
      const hits = out.match(from);
      if (!hits) return { error: `regex anchor not found: ${from}` };
      out = out.replace(from, typeof to === 'function' ? to : to);
    }
  }
  return { out };
}

const tally = { CAUGHT: 0, 'CAUGHT-OTHER': 0, MISSED: 0, CRASHED: 0, 'NO-ANCHOR': 0, SKIPPED: 0 };
for (const m of M) {
  if (m.rules && noRules) { tally.SKIPPED++; console.log(`  -  SKIPPED       ${m.name}`); continue; }
  const file = path.join(ROOT, m.file);
  const orig = fs.readFileSync(file);
  const res = apply(orig.toString('utf8'), m);
  if (res.error) { tally['NO-ANCHOR']++; console.log(`  ?  NO-ANCHOR     ${m.name}   [${res.error}]`); continue; }
  let verdict;
  try {
    fs.writeFileSync(file, res.out);
    const r = run(m.suite);
    const failLines = r.out.split('\n').filter((l) => /^\s+FAIL\s/.test(l));
    if (/HARNESS CRASHED|THREW/.test(r.out) && failLines.length === 0) verdict = 'CRASHED';
    else if (r.code === 0) verdict = 'MISSED';
    else if (failLines.some((l) => m.expect.test(l))) verdict = 'CAUGHT';
    else verdict = failLines.length ? 'CAUGHT-OTHER' : 'CRASHED';
    tally[verdict]++;
    const mark = verdict === 'CAUGHT' ? '✓' : verdict === 'CAUGHT-OTHER' ? '~' : '✗';
    console.log(`  ${mark}  ${verdict.padEnd(13)} ${m.name}` + (verdict !== 'CAUGHT' ? `   [${(failLines[0] || r.out.split('\n').slice(-3).join(' ')).trim().slice(0, 110)}]` : ''));
  } finally {
    fs.writeFileSync(file, orig);
  }
}

console.log('\n  post-restore:');
let green = true;
for (const s of ['royalty', 'publishing', 'hub'].concat(noRules ? [] : ['rules'])) {
  const r = run(s);
  const t = (r.out.match(/\d+ passed, \d+ failed/) || ['?'])[0];
  console.log(`    ${s.padEnd(11)} ${r.code === 0 ? 'GREEN' : 'RED'}  ${t}`);
  if (r.code !== 0) green = false;
}
const clean = spawnSync('git', ['diff', '--quiet', '--', ...new Set(M.map((m) => m.file))], { cwd: ROOT }).status === 0;
console.log(`    tree       ${clean ? 'byte-identical to HEAD for every sabotaged file' : 'DIRTY — restore failed'}`);
console.log('\n  ' + Object.entries(tally).map(([k, v]) => `${k}: ${v}`).join('   '));
const ok = tally.MISSED === 0 && tally.CRASHED === 0 && tally['NO-ANCHOR'] === 0 && green && clean;
process.exit(ok ? 0 : 1);
