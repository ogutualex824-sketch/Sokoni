#!/usr/bin/env node
/* Rules release preflight — what would a deploy actually PROMOTE?
 *
 *   TOKEN_FILE=<path-to-access-token> node scripts/verify-rules-release-parity.js
 *
 * WHY
 * `firebase deploy --only firestore:rules` promotes the WHOLE local file. On 2026-08-11
 * that file had accumulated ~89 lines from several teams that had never been released,
 * and the release failed:
 *
 *     PATCH /releases/cloud.firestore  -> 400 INVALID_ARGUMENT
 *     POST  /releases                  -> 409 ALREADY_EXISTS   (the CLI's fallback)
 *
 * The 409 is the message operators see, so the failure reads as a tooling glitch rather
 * than "your deploy was rejected". A candidate containing the live baseline plus five
 * lines promoted cleanly, which is how the delivery fix reached production.
 *
 * This prints the promote-set BEFORE anyone deploys, so nobody ships another team's
 * unreviewed rules by accident or rediscovers the 400 the hard way. Read-only: it fetches
 * the live ruleset and compares. It never writes rules and never releases.
 *
 * Exit 1 when local and live differ — a rules deploy from this repo should be a deliberate,
 * reviewed act, not a side effect of `deploy:all`.
 */
'use strict';
const https = require('https');
const fs = require('fs');
const path = require('path');

const PROJECT = process.env.RULES_PROJECT || 'sokoni-aeb26';
const RELEASE = process.env.RULES_RELEASE || 'cloud.firestore';
const LOCAL = path.resolve(__dirname, '..', process.env.RULES_FILE || 'firestore.rules');
const LIMIT = 256 * 1024;

function api(p) {
  return new Promise((res, rej) => {
    let token;
    try { token = fs.readFileSync(process.env.TOKEN_FILE, 'utf8').trim(); }
    catch (e) { return rej(new Error('TOKEN_FILE not set or unreadable — `gcloud auth print-access-token > tok.txt`')); }
    https.get({ host: 'firebaserules.googleapis.com', path: p,
      headers: { Authorization: 'Bearer ' + token, 'x-goog-user-project': PROJECT } },
      (r) => {
        /* Collect Buffers. Concatenating chunks as strings splits multi-byte UTF-8 at
           chunk boundaries and silently corrupts the source — that is how 30 mojibake
           characters reached a production ruleset's comments. */
        const chunks = [];
        r.on('data', (d) => chunks.push(d));
        r.on('end', () => { try { res(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
                            catch (e) { rej(e); } });
      }).on('error', rej);
  });
}

(async () => {
  const rel = await api(`/v1/projects/${PROJECT}/releases/${RELEASE}`);
  if (rel.error) throw new Error('release: ' + rel.error.message);
  const id = rel.rulesetName.split('/rulesets/')[1];
  const rs = await api(`/v1/projects/${PROJECT}/rulesets/${id}`);
  if (rs.error) throw new Error('ruleset: ' + rs.error.message);

  const live = ((rs.source.files || [])[0] || {}).content || '';
  const local = fs.readFileSync(LOCAL, 'utf8');
  const bytes = (s) => Buffer.byteLength(s, 'utf8');

  console.log('RULES RELEASE PREFLIGHT');
  console.log('  release      :', RELEASE);
  console.log('  live ruleset :', id);
  console.log('  live bytes   :', bytes(live).toLocaleString(),
              '(' + ((100 * bytes(live)) / LIMIT).toFixed(1) + '% of 256 KiB)');
  console.log('  local file   :', path.basename(LOCAL));
  console.log('  local bytes  :', bytes(local).toLocaleString(),
              '(' + ((100 * bytes(local)) / LIMIT).toFixed(1) + '% of 256 KiB)');

  if (live === local) {
    console.log('\n  IDENTICAL — a deploy would be a no-op. Safe.');
    process.exit(0);
  }

  /* Multiset line diff: what a deploy would ADD to production. */
  const norm = (s) => s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const A = new Map(); norm(live).forEach((l) => A.set(l, (A.get(l) || 0) + 1));
  const B = new Map(); norm(local).forEach((l) => B.set(l, (B.get(l) || 0) + 1));
  const add = []; const drop = [];
  B.forEach((n, l) => { const m = A.get(l) || 0; for (let k = 0; k < n - m; k++) add.push(l); });
  A.forEach((n, l) => { const m = B.get(l) || 0; for (let k = 0; k < n - m; k++) drop.push(l); });

  /* Classify by walking the file with block-comment state. A per-line test that only
     looks for a leading // or /* counts every continuation line of a block comment as a
     rule, which turns a documentation edit into a scary "71 rule lines added". */
  const ruleLines = (src) => {
    const out = new Set();
    let inBlock = false;
    src.split(/\r?\n/).forEach((raw) => {
      const l = raw.trim();
      if (!l) return;
      let isComment = inBlock;
      if (!inBlock) {
        if (l.startsWith('//')) isComment = true;
        else if (l.startsWith('/*')) { isComment = true; if (!l.includes('*/')) inBlock = true; }
      } else if (l.includes('*/')) { inBlock = false; }
      if (!isComment) out.add(l);
    });
    return out;
  };
  const localRuleLines = ruleLines(local);
  const liveRuleLines = ruleLines(live);
  const addRules = add.filter((l) => localRuleLines.has(l));
  const dropRules = drop.filter((l) => liveRuleLines.has(l));

  console.log('\n  A DEPLOY WOULD PROMOTE:');
  console.log('    lines added  :', add.length, '(' + addRules.length + ' rule lines,', add.length - addRules.length, 'comment)');
  console.log('    lines removed:', drop.length, '(' + dropRules.length + ' rule lines,', drop.length - dropRules.length, 'comment)');

  if (addRules.length) {
    console.log('\n    RULE LINES THAT WOULD BE ADDED (first 25):');
    addRules.slice(0, 25).forEach((l) => console.log('      +', l.slice(0, 108)));
    if (addRules.length > 25) console.log('      …', addRules.length - 25, 'more');
  }
  if (dropRules.length) {
    console.log('\n    RULE LINES THAT WOULD BE REMOVED FROM PRODUCTION (first 25):');
    dropRules.slice(0, 25).forEach((l) => console.log('      -', l.slice(0, 108)));
    if (dropRules.length > 25) console.log('      …', dropRules.length - 25, 'more');
  }

  console.log('\n  Local and live DIFFER. See docs/RULES_RECONCILIATION.md.');
  console.log('  Release one reviewed category at a time from the live baseline');
  console.log('  (firestore.rules.live) rather than promoting this whole diff.');
  process.exit(1);
})().catch((e) => { console.error('preflight failed:', e.message); process.exit(2); });
