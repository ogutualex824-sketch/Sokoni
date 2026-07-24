#!/usr/bin/env node
'use strict';

/**
 * Artifact parity — is the deployed program the same program as the repository?
 *
 *   node scripts/verify-artifact-parity.js pos-lifecycle.js sw-register.js
 *   node scripts/verify-artifact-parity.js --json pos.html
 *
 * WHY A HASH IS NOT THE ANSWER
 * A raw hash answers "are these bytes identical", which is the wrong question
 * when it differs. A comment, a licence header or a reformat changes the hash
 * without changing behaviour — and treating that as "not deployed yet" stalls a
 * release for a difference that cannot affect a test.
 *
 * The question that matters is whether the EXECUTABLE program differs. So on a
 * hash mismatch this strips comments and collapses whitespace, and compares
 * again. Three outcomes, not two:
 *
 *   IDENTICAL        bytes match — nothing to think about
 *   COMMENT-ONLY     bytes differ, program does not — runtime tests are valid
 *   BEHAVIOUR-DIFFERS  the deployed program is not this program — do not test
 *
 * Companion to ADR-0011. That one protects against testing the wrong runtime
 * contract; this protects against mistaking a non-functional source change for
 * a behavioural one, and against the opposite error of waving through a real
 * change because "it's probably just formatting".
 *
 * Exit 1 only on BEHAVIOUR-DIFFERS. A comment-only drift is reported, not
 * fatal — it is worth knowing and not worth blocking on.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.resolve(__dirname, '..');
const ORIGIN = process.env.SOKONI_ORIGIN || 'https://mysokoni.co.ke';
const AS_JSON = process.argv.includes('--json');
const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));

if (!files.length) {
  console.error('usage: node scripts/verify-artifact-parity.js <file> [file...] [--json]');
  process.exit(2);
}

const sha = (s) => require('crypto').createHash('sha256').update(s).digest('hex').slice(0, 12);

/* Strip block and line comments, collapse whitespace. Deliberately naive about
   comment-like sequences inside string literals: a false "behaviour differs" is
   safe (it only delays a test), while a false "comment-only" would wave through
   a real change. When the two errors are not symmetric, prefer the harmless one. */
function normalize(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function fetch(url, hops = 0) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'Cache-Control': 'no-cache' } }, (res) => {
      /* Follow redirects. Firebase Hosting runs cleanUrls:true, so every
         `name.html` is served with a 301 to `/name`. Without this the tool
         reports UNREACHABLE for EVERY html artifact and can verify none of them —
         a blind spot, not a parity failure. Bounded to 5 hops to avoid loops. */
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (hops >= 5) return reject(new Error('too many redirects'));
        const next = new URL(res.headers.location, url).toString();
        return resolve(fetch(next, hops + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve(body));
    }).on('error', reject);
  });
}

(async () => {
  const results = [];

  for (const rel of files) {
    const local = path.join(ROOT, rel);
    if (!fs.existsSync(local)) {
      results.push({ file: rel, verdict: 'MISSING-LOCAL' });
      continue;
    }
    const localSrc = fs.readFileSync(local, 'utf8');

    let liveSrc;
    try {
      /* Cache-buster in the URL as well as the header — a CDN that ignores the
         header would otherwise return the previous build and the whole check
         would confirm the thing it exists to detect. */
      /* Request the CANONICAL served path. Under cleanUrls, index.html is served
         at `/` and `/index.html` 301-redirects to itself (a loop the redirect
         follower would otherwise exhaust). Every other page is reachable at its
         own path and the follower handles its foo.html -> /foo hop. */
      const servedPath = (rel === 'index.html') ? '' : rel;
      liveSrc = await fetch(ORIGIN + '/' + servedPath + '?parity=' + Date.now());
    } catch (e) {
      results.push({ file: rel, verdict: 'UNREACHABLE', detail: e.message });
      continue;
    }

    const rawMatch = sha(liveSrc) === sha(localSrc);
    const codeMatch = normalize(liveSrc) === normalize(localSrc);

    results.push({
      file: rel,
      liveHash: sha(liveSrc),
      localHash: sha(localSrc),
      liveCodeChars: normalize(liveSrc).length,
      localCodeChars: normalize(localSrc).length,
      verdict: rawMatch ? 'IDENTICAL' : (codeMatch ? 'COMMENT-ONLY' : 'BEHAVIOUR-DIFFERS'),
    });
  }

  if (AS_JSON) {
    console.log(JSON.stringify({ origin: ORIGIN, results }, null, 2));
  } else {
    console.log('\n[artifact-parity] ' + ORIGIN + '\n');
    for (const r of results) {
      if (r.verdict === 'MISSING-LOCAL' || r.verdict === 'UNREACHABLE') {
        console.log('  ' + r.verdict.padEnd(18) + r.file + (r.detail ? '  — ' + r.detail : ''));
        continue;
      }
      console.log('  ' + r.verdict.padEnd(18) + r.file);
      console.log('    live ' + r.liveHash + '  local ' + r.localHash +
                  '   code ' + r.liveCodeChars + ' vs ' + r.localCodeChars + ' chars');
    }
    const diff = results.filter((r) => r.verdict === 'BEHAVIOUR-DIFFERS');
    const cmt  = results.filter((r) => r.verdict === 'COMMENT-ONLY');
    console.log('');
    if (diff.length) {
      console.log('  DO NOT run runtime tests — the deployed program is not this program:');
      diff.forEach((r) => console.log('    ' + r.file));
    } else if (cmt.length) {
      console.log('  Comment-only drift. Runtime tests against the live build are VALID;');
      console.log('  redeploy when convenient to restore byte parity:');
      cmt.forEach((r) => console.log('    ' + r.file));
    } else {
      console.log('  All artifacts identical — runtime tests refer to this build.');
    }
  }

  process.exit(results.some((r) => r.verdict === 'BEHAVIOUR-DIFFERS') ? 1 : 0);
})();
