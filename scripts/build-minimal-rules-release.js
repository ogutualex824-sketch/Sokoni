#!/usr/bin/env node
/* Build a MINIMAL rules release: the SERVED production ruleset plus exactly one
   authorized change.

     node scripts/build-minimal-rules-release.js <served.rules> <out.rules>

   WHY NOT DEPLOY THE REPO ARTIFACT
   scripts/gate-served-rules-parity.js established that firestore.rules.build differs from
   the served ruleset in three allow statements and three whole collections. Only ONE of
   those is this release's authorized change; the others belong to other workstreams and
   include a WIDENING on /posPrintJobs/. Deploying the repo artifact would ship them.

   WHY BUILD FROM SERVED RATHER THAN EDIT THE REPO SOURCE
   Editing the repo to match production would erase other people's pending work and make
   the diff disappear without deciding anything. The base here is what production actually
   enforces; the only delta is the authorized one.

   THE CHANGE: shopEmployees ownership anchor is immutable on update.
   `create` already constrains the NEW shopOwnerId; `update` constrained only the OLD one,
   so create-then-update moved the anchor onto a victim and made the caller an active
   manager of a shop they had no relationship to. Demonstrated in the emulator against this
   very ruleset.

   Refuses to write anything it cannot verify. */
'use strict';
const fs = require('fs');

const [, , SERVED, OUT] = process.argv;
if (!SERVED || !OUT) { console.error('usage: build-minimal-rules-release.js <served.rules> <out.rules>'); process.exit(2); }

const src = fs.readFileSync(SERVED, 'utf8');

/* The exact served text being replaced, and its replacement. Matched as a literal so a
   drifted ruleset fails loudly instead of being silently patched somewhere unintended. */
const FROM = [
  'allow update: if isAdmin()',
  '                    || (isAuthed() && resource.data.shopOwnerId == request.auth.uid);',
].join('\n');

/* The comment is deliberately ONE line. This artifact is deployed as-is with no build
   step to strip comments, and the served ruleset is already 257,537 bytes against a
   262,144 ceiling. Prose here is spent from the same budget as the rules; the reasoning
   lives in docs/findings/SHOPEMPLOYEES_ESCALATION.md instead. */
const TO = [
  '/* anchor immutable on update — see docs/findings/SHOPEMPLOYEES_ESCALATION.md */',
  '                    allow update: if isAdmin()',
  '                    || (isAuthed() && resource.data.shopOwnerId == request.auth.uid',
  '                        && request.resource.data.shopOwnerId == resource.data.shopOwnerId);',
].join('\n');

/* Locate the shopEmployees block and patch ONLY inside it. The same `allow update` text
   appears in other blocks — delete uses it too, and other collections share the shape — so
   a global replace would silently alter unrelated rules. */
/* The PATH ITSELF contains braces — `match /shopEmployees/{empUid} {` — so scanning for the
   first `{` after the path locks onto `{empUid}` and yields an empty block. That exact bug
   made an earlier comparison report "0 differing blocks" for a ruleset whose shopEmployees
   rule demonstrably differs. Match the whole header, then start at the brace AFTER it. */
const header = /match\s+\/shopEmployees\/\{[^}]*\}\s*\{/.exec(src);
if (!header) { console.error('ABORT: no shopEmployees block in the served ruleset'); process.exit(1); }
const blockStart = header.index;
let depth = 0, blockEnd = header.index + header[0].length - 1;
for (let i = blockEnd; i < src.length; i++) {
  if (src[i] === '{') depth++;
  else if (src[i] === '}') { depth--; if (depth === 0) { blockEnd = i; break; } }
}
const block = src.slice(blockStart, blockEnd + 1);
if (block.indexOf('allow update') === -1) { console.error('ABORT: block extraction produced no update rule'); process.exit(1); }

const occurrences = block.split(FROM).length - 1;
if (occurrences !== 1) {
  console.error('ABORT: expected exactly 1 occurrence of the update rule inside the shopEmployees block, found ' + occurrences);
  process.exit(1);
}
const patchedBlock = block.replace(FROM, TO);
const out = src.slice(0, blockStart) + patchedBlock + src.slice(blockEnd + 1);

/* Postconditions — refuse to emit an artifact that is not exactly the intended delta. */
const fail = [];
if (out.indexOf('request.resource.data.shopOwnerId == resource.data.shopOwnerId') === -1) fail.push('the new clause is absent');
if ((out.match(/request\.resource\.data\.shopOwnerId == resource\.data\.shopOwnerId/g) || []).length !== 1) fail.push('the new clause appears more than once');
const cnt = (s, re) => (s.match(re) || []).length;
if (cnt(out, /match\s+\//g) !== cnt(src, /match\s+\//g)) fail.push('match block count changed');
if (cnt(out, /allow[\s\S]*?;/g) !== cnt(src, /allow[\s\S]*?;/g)) fail.push('allow statement count changed');
if (cnt(out, /\{/g) !== cnt(src, /\{/g) || cnt(out, /\}/g) !== cnt(src, /\}/g)) fail.push('braces changed');
if (Buffer.byteLength(out, 'utf8') >= 256 * 1024) fail.push('artifact exceeds the 256 KiB ceiling');

if (fail.length) { console.error('ABORT: ' + fail.join('; ')); process.exit(1); }

fs.writeFileSync(OUT, out);
console.log('  base (served) bytes : ' + Buffer.byteLength(src, 'utf8'));
console.log('  minimal artifact    : ' + Buffer.byteLength(out, 'utf8') + ' bytes  -> ' + OUT);
console.log('  delta               : +' + (Buffer.byteLength(out, 'utf8') - Buffer.byteLength(src, 'utf8')) + ' bytes (one clause + its comment)');
console.log('  match blocks        : ' + cnt(out, /match\s+\//g) + ' (unchanged)');
console.log('  allow statements    : ' + cnt(out, /allow[\s\S]*?;/g) + ' (unchanged)');
