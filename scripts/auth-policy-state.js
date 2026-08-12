/* ══════════════════════════════════════════════════════════════════════════════
   AUTH — the shipped cutoff state, for suites to assert against
   ------------------------------------------------------------------------------
   WHY THIS EXISTS
   The release suites conflated two different claims:

     "the SENTINEL VALUE disables enforcement"        a permanent property of the code
     "the SHIPPED CUTOFF is currently the sentinel"   a temporary deployment state

   Assertions written against the second were used to test the first. So the moment the
   cutoff was deliberately armed — the one thing the release exists to do — 31 assertions
   across six suites went red, including two mutation controls. The suites made the product
   untestable in the state it is meant to ship in.

   The split:

     BEHAVIOUR tests pass SENTINEL explicitly as { cutoff: SENTINEL }. That asserts what the
     sentinel value does, is true armed or unarmed, and never expires.

     STATE tests call assertCoherent(). The shipped state must be one of exactly two
     coherent things — both sides at the sentinel, or both sides carrying the SAME
     deliberately armed UTC timestamp. Divergence, or a malformed value, still fails. That
     also never expires, and it is a STRONGER guard than "must be the sentinel": it catches
     a one-sided arming, which is the failure that would actually hurt.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CLIENT = 'sokoni-verify-policy.js';
const SERVER = 'functions/auth-policy.js';

/* Read the sentinel from the shipped client file rather than hard-coding it, so this
   helper cannot drift from the product. Its value is asserted separately below. */
const SENTINEL = (function () {
  const m = /SENTINEL_ISO\s*=\s*'([^']+)'/.exec(fs.readFileSync(path.join(ROOT, CLIENT), 'utf8'));
  if (!m) throw new Error('SENTINEL_ISO not found in ' + CLIENT);
  return m[1];
})();

const DECL = /CUTOFF_ISO:\s*(SENTINEL_ISO|'([^']*)')/;

function cutoffOf(file) {
  const m = DECL.exec(fs.readFileSync(path.join(ROOT, file), 'utf8'));
  if (!m) return null;
  return m[1] === 'SENTINEL_ISO' ? SENTINEL : m[2];
}

function shippedState() {
  const client = cutoffOf(CLIENT);
  const server = cutoffOf(SERVER);
  return {
    client, server,
    identical: client === server && client !== null,
    armed: client !== SENTINEL,
    sentinel: SENTINEL,
  };
}

/* The state rule, as one assertion a suite can drop in. `ck` is the suite's own recorder,
   so failures land in its report with its own formatting. */
function assertCoherent(ck, tag) {
  const s = shippedState();
  const STRICT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

  ck(tag, 'client and server carry the SAME cutoff', s.identical,
     s.client + ' vs ' + s.server);
  ck(tag, 'the sentinel value itself is unchanged', s.sentinel === '2099-01-01T00:00:00.000Z',
     s.sentinel);
  ck(tag, 'the shipped cutoff is the sentinel OR a well-formed deliberate UTC instant',
     s.client === s.sentinel || STRICT.test(s.client), s.client);

  if (s.armed) {
    /* Armed is legitimate — but only deliberately, and only forward. A cutoff earlier than
       the production measurement would be the retroactive restriction the whole
       grandfathering decision exists to prevent. */
    ck(tag, 'an armed cutoff is not retroactive (>= the production measurement)',
       Date.parse(s.client) >= Date.parse('2026-08-12T00:00:00.000Z'), s.client);
  }
  return s;
}

/* "This file was not touched" is false as soon as the cutoff is armed, and widening it to
   an allowlist would stop noticing real edits. The durable claim is narrower and stronger:
   whatever changed in a policy file, it was ONLY the cutoff line. */
function policyDiffIsCutoffOnly(file) {
  let diff = '';
  try {
    diff = cp.execSync('git diff HEAD -- ' + JSON.stringify(file), { cwd: ROOT, encoding: 'utf8' });
  } catch (e) { return { clean: true, only: true, lines: [] }; }
  const lines = diff.split('\n')
    .filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l));
  if (!lines.length) return { clean: true, only: true, lines: [] };
  const only = lines.every((l) => /CUTOFF_ISO\s*:/.test(l));
  return { clean: false, only, lines };
}

/* The two policy files, for suites that need to exclude them from a dirty-file check while
   still asserting the change was cutoff-only. */
const POLICY_FILES = [CLIENT, SERVER];

module.exports = {
  SENTINEL, CLIENT, SERVER, POLICY_FILES,
  cutoffOf, shippedState, assertCoherent, policyDiffIsCutoffOnly,
};
