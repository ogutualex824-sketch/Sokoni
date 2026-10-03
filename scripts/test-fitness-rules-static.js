#!/usr/bin/env node
/* test-fitness-rules-static.js — STATIC structural proof of the fitness rules candidate (2026-10-03).
 *
 *   node scripts/test-fitness-rules-static.js
 *
 * NOT an emulator test and NOT a semantic proof: it proves the TEXT is what the release claims. The behavioural proof
 * is scripts/test-fitness-rules-emulator.js (QUEUED — host free RAM below the 512 MB emulator floor on 2026-10-03).
 *
 * Inputs: firestore.rules.served-f259c0b5 (sha-pinned, the SERVED ruleset) and firestore.rules.fitness-candidate.
 * Named rows:
 *   S1  served input is the pinned served ruleset (sha256)
 *   S2  braces balance in the candidate (strings / comments / path wildcards excluded); match-block parse completes
 *   S3  no NEW duplicate match path at the same full nested path (duplicate blocks OR together); every fitness /
 *       membership / payout / providers path appears exactly once
 *   S4  every changed served line lies inside one of the intended blocks (fitness_* legacy collections) — every other
 *       served line is byte-identical (independent of the builder: line diff via `git diff --no-index`)
 *   S5  providerMemberships: read = signed-in && (buyerUid || providerId || isAdmin()); create, update, delete: false;
 *       NO other allow statement in the block
 *   S6  providerMemberships/attendance: read = parent buyerUid || parent providerId || isAdmin(); write false
 *   S7  providerMemberships/events + /releases: read = parent providerId || isAdmin() (no buyerUid); write false
 *   S8  fitnessMembershipClaims: read, write false and nothing else
 *   S9  eight legacy fitness_* collections: read isAdmin() only; write false; nothing else
 *   S10 fitness_gyms: create + update carry noGymLockedFields() covering rating, members, verified, status (+ moderation)
 *   S11 fitness_progress UNCHANGED and owner-only (read admin|own, create/update own, delete admin)
 *   S12 providerPayouts UNCHANGED: read = isAdmin() || own providerId; no write statement (no client writes)
 *   S13 providers UNCHANGED vs served (business lock is f3's rules/capability-decisions-on-f20be7d — not duplicated)
 *   S14 candidate size < 256 KiB (262144 B)
 * Negative controls (each mutates the candidate in memory; the NAMED row must fail, else the harness is blind):
 *   N1  `allow write: if true;` added to providerMemberships            → S5 must FAIL
 *   N2  a second `match /providerMemberships/{x}` block at the same depth → S3 must FAIL
 *   N3  an unbalanced `{` appended                                         → S2 must FAIL
 *   N4  events read widened with `|| ...buyerUid == request.auth.uid`     → S7 must FAIL
 *   N5  a served line outside the fitness blocks edited (providers)       → S4 and S13 must FAIL
 *   N6  `allow read: if true;` on fitness_classes                        → S9 must FAIL
 *   N7  providerPayouts gains `allow write: if isAuthed();`               → S12 must FAIL
 */
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto'), os = require('os');
const { execFileSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const SERVED_FILE = path.join(ROOT, 'firestore.rules.served-f259c0b5');
const CAND_FILE = path.join(ROOT, process.env.RULES_FILE || 'firestore.rules.fitness-candidate');
const SERVED_SHA = '78d938fd9785ab8fcd310f7a926f98f9aafab0231142a3f7cac8346ec301d447';
const LEGACY = ['fitness_bookings', 'fitness_classes', 'fitness_clubs', 'fitness_equipment', 'fitness_requests',
  'fitness_challenges', 'fitness_checkins', 'fitness_community_posts'];
const INTENDED_BLOCKS = [...LEGACY, 'fitness_gyms'];

/* ── parser: match blocks with full nested paths, direct allow statements per block ── */
function clean(line) {
  return line.replace(/\/\*.*?\*\//g, '').replace(/\/\/.*$/, '').replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');
}
function parse(text) {
  const lines = text.split('\n');
  const stack = []; const blocks = []; let inComment = false; let balanced = true;
  const stmtBuf = [];
  for (let i = 0; i < lines.length; i++) {
    let l = lines[i];
    if (inComment) { const e = l.indexOf('*/'); if (e < 0) continue; l = l.slice(e + 2); inComment = false; }
    l = clean(l);
    const s = l.indexOf('/*'); if (s >= 0) { l = l.slice(0, s); inComment = true; }
    const m = l.match(/^\s*match\s+(\S+)\s*\{\s*$/);
    if (m) {
      const parent = stack.filter((x) => x.match).map((x) => x.path).join('');
      const b = { path: m[1], full: parent + m[1], depth: stack.length, start: i, end: -1, allows: [], match: true };
      stack.push(b); blocks.push(b); continue;
    }
    const noWild = l.replace(/\{[A-Za-z_]\w*(=\*\*)?\}/g, '');
    const top = stack.length ? stack[stack.length - 1] : null;
    /* collect allow statements that belong directly to the innermost MATCH block */
    if (top && top.match && (/^\s*allow\b/.test(l) || stmtBuf.length)) {
      stmtBuf.push(l.trim());
      if (/;\s*$/.test(l)) { top.allows.push(stmtBuf.join(' ').replace(/\s+/g, ' ')); stmtBuf.length = 0; }
      continue;
    }
    for (const ch of noWild) {
      if (ch === '{') stack.push({ match: false });
      else if (ch === '}') { const b = stack.pop(); if (!b) { balanced = false; continue; } if (b.match) b.end = i; }
    }
  }
  if (stack.length || stmtBuf.length) balanced = false;
  return { blocks, balanced, lines };
}
const byFull = (p, full) => p.blocks.filter((b) => b.full === full);
const ALL = '/databases/{database}/documents';
const one = (p, rel) => { const b = byFull(p, ALL + rel); return b.length === 1 ? b[0] : null; };
const norm = (s) => s.replace(/\s+/g, ' ').trim();
const sameAllows = (b, expected) => !!b && b.allows.length === expected.length && expected.every((e, k) => norm(b.allows[k]) === norm(e));

/* ── line diff (independent of the builder) ── */
function changedServedLines(servedText, candText) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'fitrules-'));
  const a = path.join(d, 'a'), b = path.join(d, 'b');
  fs.writeFileSync(a, servedText); fs.writeFileSync(b, candText);
  let out = '';
  try { out = execFileSync('git', ['diff', '--no-index', '-U0', '--', a, b], { encoding: 'utf8' }); }
  catch (e) { out = e.stdout || ''; }
  fs.rmSync(d, { recursive: true, force: true });
  const ranges = [];
  for (const m of out.matchAll(/^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/gm)) {
    const start = Number(m[1]), len = m[2] === undefined ? 1 : Number(m[2]);
    ranges.push({ start, len }); // 1-based; len 0 = pure insertion after `start`
  }
  return ranges;
}

const PARENT = 'get(/databases/$(database)/documents/providerMemberships/$(membershipId)).data';
function run(served, cand) {
  const rows = {};
  const row = (id, ok, d) => { rows[id] = { ok: !!ok, d: d || '' }; };
  const p = parse(cand), ps = parse(served);

  row('S1', crypto.createHash('sha256').update(served).digest('hex') === SERVED_SHA, 'served sha256');
  row('S2', p.balanced && p.blocks.every((b) => b.end >= 0), `balanced=${p.balanced}`);

  /* wildcard NAMES do not distinguish paths: /a/{x} and /a/{y} match the same documents and OR together */
  const wnorm = (s) => s.replace(/\{[A-Za-z_]\w*=\*\*\}/g, '{**}').replace(/\{[A-Za-z_]\w*\}/g, '{*}');
  const count = (pp) => { const c = {}; for (const b of pp.blocks) { const k = wnorm(b.full); c[k] = (c[k] || 0) + 1; } return c; };
  const cc = count(p), sc = count(ps);
  const newDup = Object.keys(cc).filter((k) => cc[k] > 1 && cc[k] > (sc[k] || 0));
  const mustOne = [...INTENDED_BLOCKS, 'fitness_progress', 'providerMemberships', 'fitnessMembershipClaims', 'providerPayouts', 'providers']
    .map((c) => Object.keys(cc).find((k) => k.startsWith(wnorm(ALL) + '/' + c + '/{') && k.split('/').length === ALL.split('/').length + 2) || ('MISSING:' + c));
  const notOne = mustOne.filter((k) => k.startsWith('MISSING') || cc[k] !== 1);
  row('S3', newDup.length === 0 && notOne.length === 0, `newDup=${newDup.join(',')} notOne=${notOne.join(',')}`);

  /* S4: every served line touched by the diff lies inside an intended served block */
  const ranges = changedServedLines(served, cand);
  const allowed = INTENDED_BLOCKS.map((c) => one(ps, `/${c}/{` + ps.blocks.find((b) => b.path.startsWith(`/${c}/{`)).path.split('{')[1].replace('}', '') + '}'))
    .filter(Boolean).map((b) => ({ s: b.start + 1, e: b.end + 1 }));
  const outside = ranges.filter((r) => {
    const s = r.len === 0 ? r.start : r.start, e = r.len === 0 ? r.start : r.start + r.len - 1;
    return !allowed.some((a) => s >= a.s && e <= a.e);
  });
  row('S4', ranges.length > 0 && outside.length === 0, `${ranges.length} hunks; outside=${outside.map((r) => r.start + ',' + r.len).join(' ')}`);

  const pm = one(p, '/providerMemberships/{membershipId}');
  row('S5', sameAllows(pm, [
    'allow read: if isAuthed() && (resource.data.buyerUid == request.auth.uid || resource.data.providerId == request.auth.uid || isAdmin());',
    'allow create, update, delete: if false;']), pm ? pm.allows.join(' | ') : 'missing');
  const att = one(p, '/providerMemberships/{membershipId}/attendance/{attendanceId}');
  row('S6', sameAllows(att, [
    `allow read: if isAuthed() && (${PARENT}.buyerUid == request.auth.uid || ${PARENT}.providerId == request.auth.uid || isAdmin());`,
    'allow write: if false;']), att ? att.allows.join(' | ') : 'missing');
  const gymOnly = (b) => sameAllows(b, [`allow read: if isAuthed() && (${PARENT}.providerId == request.auth.uid || isAdmin());`, 'allow write: if false;']);
  const ev = one(p, '/providerMemberships/{membershipId}/events/{eventId}'), rel = one(p, '/providerMemberships/{membershipId}/releases/{releaseId}');
  row('S7', gymOnly(ev) && gymOnly(rel), ev ? ev.allows.join(' | ') : 'missing');
  const cl = one(p, '/fitnessMembershipClaims/{claimHash}');
  row('S8', sameAllows(cl, ['allow read, write: if false;']), cl ? cl.allows.join(' | ') : 'missing');

  const legacyBad = LEGACY.filter((c) => {
    const b = p.blocks.find((x) => x.full.startsWith(ALL + `/${c}/{`) && x.full.split('/').length === ALL.split('/').length + 2);
    return !sameAllows(b, ['allow read: if isAdmin();', 'allow write: if false;']);
  });
  row('S9', legacyBad.length === 0, legacyBad.join(','));

  const gym = p.blocks.find((x) => x.full === ALL + '/fitness_gyms/{gymId}');
  const gymText = gym ? p.lines.slice(gym.start, gym.end + 1).join('\n') : '';
  const lockOk = ['rating', 'members', 'verified', 'status', 'moderationHold', 'moderationStatus'].every((f) => (gymText.match(new RegExp(`'${f}'`, 'g')) || []).length === 2);
  const cu = gym ? gym.allows.filter((a) => /^allow (create|update):/.test(a)) : [];
  row('S10', lockOk && cu.length === 2 && cu.every((a) => /noGymLockedFields\(\)/.test(a) && /request\.auth\.uid == gymId/.test(a)),
    `lock=${lockOk} cu=${cu.length}`);

  const fpS = ps.blocks.find((x) => x.path === '/fitness_progress/{userId}'), fpC = p.blocks.find((x) => x.path === '/fitness_progress/{userId}');
  row('S11', !!fpS && !!fpC && sameAllows(fpC, [
    'allow read: if isAdmin() || (isAuthed() && request.auth.uid == userId);',
    'allow create: if isAuthed() && request.auth.uid == userId;',
    'allow update: if isAuthed() && request.auth.uid == userId;',
    'allow delete: if isAdmin();']) && fpS.allows.join('|') === fpC.allows.join('|'), fpC ? fpC.allows.join(' | ') : 'missing');

  const ppS = ps.blocks.find((x) => x.path === '/providerPayouts/{payoutId}'), ppC = p.blocks.find((x) => x.path === '/providerPayouts/{payoutId}');
  row('S12', !!ppS && !!ppC && sameAllows(ppC, ['allow read: if isAdmin() || (isAuthed() && resource.data.providerId == request.auth.uid);'])
    && ppS.allows.join('|') === ppC.allows.join('|'), ppC ? ppC.allows.join(' | ') : 'missing');

  const prS = ps.blocks.find((x) => x.path === '/providers/{providerId}'), prC = p.blocks.find((x) => x.path === '/providers/{providerId}');
  row('S13', !!prS && !!prC && ps.lines.slice(prS.start, prS.end + 1).join('\n') === p.lines.slice(prC.start, prC.end + 1).join('\n'), 'providers block');

  const bytes = Buffer.byteLength(cand, 'utf8');
  row('S14', bytes < 262144, `${bytes} B`);
  return rows;
}

let fail = 0;
const served = fs.readFileSync(SERVED_FILE, 'utf8');
const cand = fs.readFileSync(CAND_FILE, 'utf8');
console.log(`CANDIDATE ${path.basename(CAND_FILE)} vs SERVED ${path.basename(SERVED_FILE)}`);
const rows = run(served, cand);
for (const [id, r] of Object.entries(rows)) { console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${id}  ${r.d}`); if (!r.ok) fail++; }

const PM_OPEN = '  match /providerMemberships/{membershipId} {\n';
const CONTROLS = [
  { id: 'N1', must: ['S5'], mut: (t) => t.replace(PM_OPEN, PM_OPEN + '  allow write: if true;\n') },
  { id: 'N2', must: ['S3'], mut: (t) => t.replace('  match /fitnessMembershipClaims/{claimHash} {', '  match /providerMemberships/{x} {\n  allow read: if false;\n  }\n  match /fitnessMembershipClaims/{claimHash} {') },
  { id: 'N3', must: ['S2'], mut: (t) => t + '\n{\n' },
  { id: 'N4', must: ['S7'], mut: (t) => t.replace(`  match /events/{eventId} {\n  allow read:   if isAuthed()\n  && (${PARENT}.providerId == request.auth.uid`,
    `  match /events/{eventId} {\n  allow read:   if isAuthed()\n  && (${PARENT}.buyerUid == request.auth.uid || ${PARENT}.providerId == request.auth.uid`) },
  { id: 'N5', must: ['S4', 'S13'], mut: (t) => t.replace("  .hasAny(['status', 'verified', 'suspended', 'approved']));", "  .hasAny(['status', 'verified']));") },
  { id: 'N6', must: ['S9'], mut: (t) => t.replace('  match /fitness_classes/{classId} {\n  allow read:   if isAdmin();', '  match /fitness_classes/{classId} {\n  allow read:   if true;') },
  { id: 'N7', must: ['S12'], mut: (t) => t.replace('  match /providerPayouts/{payoutId} {\n', '  match /providerPayouts/{payoutId} {\n  allow write: if isAuthed();\n') },
];
console.log('NEGATIVE CONTROLS (the named row must FAIL on the mutated text)');
for (const c of CONTROLS) {
  const m = c.mut(cand);
  if (m === cand) { console.log(`  FAIL  ${c.id}  mutation did not apply (control is blind)`); fail++; continue; }
  const r = run(served, m);
  const caught = c.must.every((id) => r[id] && !r[id].ok);
  console.log(`  ${caught ? 'PASS' : 'FAIL'}  ${c.id}  ${c.must.map((id) => id + '=' + (r[id].ok ? 'pass' : 'FAIL')).join(' ')}`);
  if (!caught) fail++;
}
console.log(fail ? `\n${fail} FAILED` : '\nALL PASS (static only — emulator suite QUEUED)');
process.exit(fail ? 1 : 0);
