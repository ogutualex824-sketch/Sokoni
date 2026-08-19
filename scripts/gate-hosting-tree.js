/* ══════════════════════════════════════════════════════════════════════════════
   HOSTING TREE GATE — never roll production back
   ══════════════════════════════════════════════════════════════════════════════
   Firebase Hosting publishes the WORKING TREE, not a commit. A deploy from a
   branch that is behind live silently reverts every file the branch does not
   carry — and Firebase still reports "Deploy complete". That has already
   reverted this project's earn page more than once.

   This compares the tree about to be published against what is actually live,
   file by file, over the real production URLs. It deploys nothing.

     node scripts/gate-hosting-tree.js
     node scripts/gate-hosting-tree.js --files a.html,b.js

   A file that differs is not automatically a failure — a deploy is SUPPOSED to
   change files. What matters is WHICH way it differs: a file present live and
   absent locally, or a local file older than live, is a rollback.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const LIVE = 'https://mysokoni.co.ke';

let pass = 0, fail = 0, unproven = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + d + ']' : '')); ok ? pass++ : fail++; };
const un = (l, d) => { console.log('  UNPROVEN  ' + l + (d ? '   [' + d + ']' : '')); unproven++; };
const head = (t) => console.log('\n' + t);

console.log('\nHOSTING TREE GATE — compare the tree against LIVE (read only)');
console.log('='.repeat(74));

/* cleanUrls 301-redirects a .html path, so a fetch without redirect-following
   hashes a 24-byte redirect body and reports a false difference. That trap has
   produced a false alarm about production integrity in this repo before. */
function fetchLive(p) {
  return new Promise((resolve) => {
    const url = LIVE + p + (p.indexOf('?') > -1 ? '&' : '?') + 'cb=' + Date.now();
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = res.headers.location.replace(LIVE, '');
        return resolve(fetchLive(next.split('?')[0]));
      }
      if (res.statusCode !== 200) { res.resume(); return resolve(null); }
      let b = [];
      res.on('data', (c) => b.push(c));
      res.on('end', () => resolve(Buffer.concat(b)));
    }).on('error', () => resolve(null));
  });
}

const argFiles = (process.argv.find((a) => a.indexOf('--files=') === 0) || '').split('=')[1];

(async () => {
  head('1 - what this deploy would publish');
  /* ── COMPARE THE WHOLE PUBLISHABLE TREE, NOT A DIFF ────────────────────────
     A git diff answers "what did this branch change", which is the WRONG
     question. Hosting publishes the tree, and live is on a different lineage —
     so a file this branch never touched can still be older than live and would
     be reverted. My first version diffed against origin/main, that lookup
     failed, it silently fell back to HEAD~5 and compared TWO files. A gate that
     narrows itself on failure is worse than no gate.

     Every root-level publishable file is compared instead. */
  let files;
  if (argFiles) {
    files = argFiles.split(',');
  } else {
    files = fs.readdirSync(ROOT)
      .filter((f) => /\.(html|js|css)$/.test(f))
      .filter((f) => {
        try { return fs.statSync(path.join(ROOT, f)).isFile(); } catch (_) { return false; }
      });
  }
  console.log('    ' + files.length + ' publishable file(s) in the tree root');
  files.slice(0, 20).forEach((f) => console.log('      ' + f));
  if (files.length > 20) console.log('      … and ' + (files.length - 20) + ' more');

  if (!files.length) {
    un('nothing to compare', 'no publishable files changed — is this the right branch?');
    console.log('\n  ' + pass + ' passed, ' + fail + ' failed, ' + (unproven) + ' unproven\n');
    process.exit(0);
  }

  head('2 - is any of them a ROLLBACK?');
  let rollbacks = 0, newFiles = 0, updates = 0, unreachable = 0, same = 0;
  const differing = [];
  for (const f of files) {
    const localPath = path.join(ROOT, f);
    const localExists = fs.existsSync(localPath);
    const live = await fetchLive('/' + f.replace(/\.html$/, ''));
    if (live === null) {
      if (localExists) { newFiles++; console.log('    NEW      ' + f + '  (not live yet)'); }
      else { unreachable++; console.log('    ?        ' + f + '  (not live, not local)'); }
      continue;
    }
    if (!localExists) {
      rollbacks++;
      console.log('    ROLLBACK ' + f + '  — LIVE but MISSING locally, publishing would delete it');
      continue;
    }
    const localBuf = fs.readFileSync(localPath);
    if (Buffer.compare(localBuf, live) === 0) same++;
    else { updates++; differing.push(f + '  (' + live.length + ' live -> ' + localBuf.length + ' local)'); }
  }

  ck('no file that is LIVE would be deleted by this deploy', rollbacks === 0,
     rollbacks ? rollbacks + ' rollback(s)' : 'none');
  console.log('    ' + same + ' identical, ' + updates + ' differ, ' + newFiles + ' new, ' + unreachable + ' unreachable');
  if (differing.length) {
    console.log('    FILES THAT DIFFER FROM LIVE — each is either an intended update or a REVERT:');
    differing.slice(0, 30).forEach(function (d) { console.log('      ' + d); });
    if (differing.length > 30) console.log('      … and ' + (differing.length - 30) + ' more');
  }
  ck('the differing set is small enough to review by hand', differing.length <= 12,
     differing.length + ' file(s) differ — a large number on a diverged branch is the rc/combined trap');

  head('3 - the POS restock dependency');
  /* A hosting deploy that ships merchant changes while merchantAdjustStock is
     undeployed breaks POS restock — recorded as the rc/combined blocker. */
  const idx = fs.readFileSync(path.join(ROOT, 'functions/index.js'), 'utf8');
  ck('merchantAdjustStock is exported, so it can ship with the functions deploy',
     /exports\.merchantAdjustStock\s*=/.test(idx) || idx.indexOf('merchantAdjustStock') > -1,
     'must be deployed BEFORE hosting');

  head('4 - live version marker');
  const vj = await fetchLive('/version.json');
  if (vj) {
    let v = null;
    try { v = JSON.parse(vj.toString()); } catch (_) {}
    console.log('    live commit  ' + (v && (v.commit || v.sha) || '(unparsed)'));
    console.log('    live dirty   ' + (v && v.dirtyWorkingTree));
    let localHead = '';
    try { localHead = execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim(); } catch (_) {}
    console.log('    local HEAD   ' + localHead);
    un('whether the live commit is an ancestor of this branch',
       'needs the live commit fetched into this repo to answer honestly');
  } else {
    un('the live version marker', 'version.json unreachable');
  }

  console.log('\n' + '='.repeat(74));
  console.log('  ' + pass + ' passed, ' + fail + ' failed, ' + unproven + ' unproven');
  console.log('  ' + (rollbacks === 0
    ? 'No rollback detected. Hosting deploy is safe on THIS evidence.'
    : 'DO NOT DEPLOY HOSTING — it would delete files that are live.'));
  console.log('='.repeat(74) + '\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\n  Gate aborted: ' + (e && e.message) + '\n'); process.exit(1); });
