#!/usr/bin/env node
/* ============================================================================
   Release log — parser contract + staleness guard
   scripts/test-release-log.js

   1. PARSER: every heading shape CHANGELOG.md actually uses; type ONLY from the
      title's leading word; the deployment claim ONLY from the heading; commits
      are short/full shas (never a bare number, never a 16-hex hosting version);
      Files are read from the entry's own **Files** block; newest-first order.
   2. STALENESS: release-log.json must equal a regeneration from CHANGELOG.md.
      Hosting does not serve .md, so a stale JSON would show admins a log that
      disagrees with the tree they are looking at. Fix: run
      `node scripts/build-release-log.js` and commit the result.
   3. NEGATIVE CONTROL: a changelog with one extra entry must be detected as
      stale by the same comparison.

   Node only — no browser, no network, no Firebase.
   Run:  node scripts/test-release-log.js     Exit: 0 pass · 1 fail
   ========================================================================= */
'use strict';
const fs = require('fs');
const path = require('path');
const B = require('./build-release-log.js');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); }
};

console.log('\n[parser — heading shapes]');
const hs = [
  ['[2026-09-30] - BnB: pill strip — NOT deployed', '2026-09-30', 'BnB: pill strip — NOT deployed'],
  ['[2026-09-30] — Compact premium cards', '2026-09-30', 'Compact premium cards'],
  ['2026-09-30 — MV2-2a: Supply workspace', '2026-09-30', 'MV2-2a: Supply workspace'],
  ['[2.11.0] — 2026-06-20 — Wire All: Hyper-Scale Modules', '2026-06-20', 'Wire All: Hyper-Scale Modules'],
  ['[v1.2.0] — 2026-06-28', '2026-06-28', 'Release v1.2.0'],
  ['[1.x] — Prior Releases', null, 'Prior Releases'],
  ['[2026-02-30] - impossible date', null, '[2026-02-30] - impossible date'],
];
for (const [raw, date, title] of hs) {
  const p = B.parseHeading(raw);
  ok(`heading "${raw.slice(0, 44)}" -> ${date} / "${title.slice(0, 30)}"`, p.date === date && p.title === title, p);
}

console.log('\n[parser — type from the leading word only]');
ok('fix(scope): -> fix', B.inferType('fix(admin): x') === 'fix');
ok('HOTFIX to … -> fix', B.inferType('HOTFIX to the header unit') === 'fix');
ok('FIXED: … -> fix', B.inferType('FIXED: a discount') === 'fix');
ok('feat: -> feat', B.inferType('feat: thing') === 'feat');
ok('docs( -> docs', B.inferType('docs(merchant): census') === 'docs');
ok('test( -> test', B.inferType('test(release): runner') === 'test');
ok('DEPLOYED … -> deploy', B.inferType('DEPLOYED d55c112 → v646') === 'deploy');
ok('"Deploy guard: …" is NOT a deploy record', B.inferType('Deploy guard: not behind') === 'other');
ok('a fix word mid-title does not type it', B.inferType('Messages inbox: fix the panes') === 'other');
ok('"Prefix-less" titles are "other", never guessed', B.inferType('Uploader on phones') === 'other');

console.log('\n[parser — deployment claim + commits from the heading]');
ok('"NOT deployed" -> not-deployed', B.deployClaim('X — certified, NOT deployed') === 'not-deployed');
ok('"DEPLOYED as d55c112" -> deployed', B.deployClaim('Home — DEPLOYED as d55c112') === 'deployed');
ok('no word -> null (no claim, not "not deployed")', B.deployClaim('Track opens a list') === null);
ok('short shas picked, 16-hex hosting version and bare numbers ignored',
  JSON.stringify(B.headingCommits('DEPLOYED 2f3bb6f → release 1790737658252000 / version 6f7202bd5dd81d84; base 54b72cc')) === '["2f3bb6f","54b72cc"]',
  B.headingCommits('DEPLOYED 2f3bb6f → release 1790737658252000 / version 6f7202bd5dd81d84; base 54b72cc'));
ok('a 40-hex full sha is kept', B.headingCommits('at 72dca5621d7dff5f647bd175808cda282d432fba').length === 1);
ok('an all-letter word ("deadbeef"-like) is not a commit', B.headingCommits('facade accede').length === 0);

console.log('\n[parser — body]');
const body = 'First para with `code` and **bold** and [a link](http://x).\n\nSecond.\n\n**Files:** `a.html`, `dir/b.js` (new), `docs/C.md`, not-a-file `npm run x`.\n\n**Files:** `ignored.js`';
ok('summary = first paragraph, markdown stripped', B.summaryOf(body) === 'First para with code and bold and a link.', B.summaryOf(body));
ok('files = the first **Files** block, file-shaped tokens only', JSON.stringify(B.filesOf(body)) === '["a.html","dir/b.js","docs/C.md"]', B.filesOf(body));
const listBody = '**Files.**\n- `x.js` — thing\n- `y/z.css`\n\nlater `q.js`';
ok('a **Files.** bullet list directly under the label is read', JSON.stringify(B.filesOf(listBody)) === '["x.js","y/z.css"]', B.filesOf(listBody));
ok('a body without a Files block has no files (none invented)', B.filesOf('just text `a.js`').length === 0);

console.log('\n[parser — order and fences]');
const md = [
  '## [2026-09-01] — older', 'a', '',
  '## [2026-09-30] — newest A', 'b', '```', '## not a heading inside a fence', '```', '',
  '## [2026-09-30] — newest B', 'c', '',
  '## [1.x] — Prior Releases', 'd',
].join('\r\n');
const es = B.parseChangelog(md);
ok('4 entries (a ## inside a code fence is not a heading)', es.length === 4, es.map((e) => e.title));
ok('newest date first; same date keeps changelog order; undated last',
  JSON.stringify(es.map((e) => e.title)) === JSON.stringify(['newest A', 'newest B', 'older', 'Prior Releases']), es.map((e) => e.title));
ok('ids are unique', new Set(es.map((e) => e.id)).size === es.length);

console.log('\n[the committed artefact]');
const text = fs.readFileSync(B.SRC, 'utf8');
let committed = null;
try { committed = JSON.parse(fs.readFileSync(B.OUT, 'utf8')); } catch (e) { committed = null; }
ok('release-log.json exists at the site root and parses', !!committed);
const fresh = JSON.parse(B.serialise(B.buildReleaseLog(text)));
ok('release-log.json is CURRENT with CHANGELOG.md (else: node scripts/build-release-log.js)',
  committed && JSON.stringify(committed) === JSON.stringify(fresh),
  committed ? { committedSha: committed.sourceSha256, changelogSha: fresh.sourceSha256, committedCount: committed.entryCount, changelogCount: fresh.entryCount } : 'missing');
if (committed) {
  const heads = (text.replace(/\r\n?/g, '\n').match(/^## (?!#)/gm) || []).length;
  ok(`entry count covers every "## " heading outside fences (${committed.entryCount} vs ${heads} raw)`, committed.entryCount <= heads && committed.entryCount >= heads - 5, { entryCount: committed.entryCount, heads });
  const dated = committed.entries.filter((e) => e.date);
  ok('entries are in date order, newest first', dated.every((e, i) => i === 0 || dated[i - 1].date >= e.date));
  ok('every entry has an id, a title and a known type', committed.entries.every((e) => e.id && e.title && ['fix', 'feat', 'docs', 'test', 'deploy', 'other'].includes(e.type)));
  ok('claim is only deployed / not-deployed / null', committed.entries.every((e) => [null, 'deployed', 'not-deployed'].includes(e.claim)));
  ok('no generatedAt timestamp (output is a pure function of the changelog)', !('generatedAt' in committed));
  ok('the artefact is not hosting-ignored (served at /release-log.json)', (() => {
    const ign = (JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'firebase.json'), 'utf8')).hosting || {}).ignore || [];
    return !ign.some((g) => g === 'release-log.json' || g === '*.json' || g === '**/*.json');
  })());
}

console.log('\n[negative control — a new changelog entry makes the artefact stale]');
const bumped = '## [2099-01-01] — canary entry\n\nbody\n\n' + text;
const staleCmp = JSON.stringify(JSON.parse(B.serialise(B.buildReleaseLog(bumped)))) === JSON.stringify(committed);
ok('the staleness comparison detects one added entry', committed && !staleCmp);

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
