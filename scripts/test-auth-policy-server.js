/* ══════════════════════════════════════════════════════════════════════════════
   AUTH SLICE 6B — the server enforcement verdict, and three-way agreement
   ------------------------------------------------------------------------------
   The policy is implemented twice on purpose: `firebase deploy --only functions` uploads
   only the functions/ directory, so the deployed code cannot require the client file.
   Duplication is therefore a fact, and the job of this suite is to make drift impossible
   to ship rather than to pretend the duplication is not there.

   THREE RUNTIMES, ONE CONTRACT
     browser   sokoni-verify-policy.js  as a classic script in a vm sandbox
     node      sokoni-verify-policy.js  required as CommonJS
     server    functions/auth-policy.js required as CommonJS

   Every vector in scripts/auth-policy-vectors.json must produce the same verdict in all
   three, and the three must agree with each other.

   AND A SWEEP, BECAUSE 18 VECTORS ARE 18 SAMPLES
   ----------------------------------------------
   A fixture proves the cases somebody thought of. Drift usually appears somewhere nobody
   sampled — an off-by-one that only shows at a millisecond boundary, a parser that differs
   on one format. So after the vectors, several thousand generated timestamps are pushed
   through both implementations and compared pairwise. Deterministic, so a failure is
   reproducible rather than a Heisenbug.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const VECTORS = JSON.parse(read('scripts/auth-policy-vectors.json'));
const STATE = require('./auth-policy-state.js');

let pass = 0, fail = 0;
const failures = [];
function ok(label, cond, detail) {
  if (cond) { pass++; return true; }
  fail++; failures.push(label + (detail ? '  → ' + detail : ''));
  return false;
}
const eq = (l, a, e) => ok(l, a === e, 'expected ' + JSON.stringify(e) + ', got ' + JSON.stringify(a));
const head = (t) => console.log('\n\x1b[1m' + t + '\x1b[0m');

/* ── the three runtimes ──────────────────────────────────────────────────────── */
function loadBrowser() {
  const w = { console: { warn() { }, log() { } } };
  vm.createContext(w); w.window = w;
  vm.runInContext(read('sokoni-verify-policy.js'), w, { filename: 'sokoni-verify-policy.js' });
  return w.SokoniVerifyPolicy;
}
function loadNodeClient() {
  const p = require.resolve(path.join(ROOT, 'sokoni-verify-policy.js'));
  delete require.cache[p];
  return require(p);
}
function loadServer() {
  const p = require.resolve(path.join(ROOT, 'functions', 'auth-policy.js'));
  delete require.cache[p];
  return require(p);
}

const userFrom = (v) => (v.noMetadata ? { uid: 'u' } : { uid: 'u', metadata: { creationTime: v.creationTime } });

(function run() {

  /* ══ A · the server exists and ships OFF ═════════════════════════════════ */
  head('A · the server policy, as shipped');
  {
    const srv = loadServer(), cli = loadNodeClient();
    const st = STATE.shippedState();

    /* STATE — coherent, not necessarily unarmed. This is a STRONGER guard than
       "must be the sentinel": it still catches the failure that would actually hurt,
       a one-sided arming, and it keeps working once the release arms deliberately. */
    eq('A1  client and server ship the SAME cutoff', srv.CUTOFF_ISO, cli.CUTOFF_ISO);
    eq('A2  ...and the helper agrees with both', st.client, srv.CUTOFF_ISO);
    eq('A3  the two SENTINEL constants are identical', srv.SENTINEL_ISO, cli.SENTINEL_ISO);
    eq('A4  the sentinel value is unchanged', srv.SENTINEL_ISO, '2099-01-01T00:00:00.000Z');
    eq('A5  describe() matches word for word', srv.describe(), cli.describe());
    ok('A6  the shipped cutoff is the sentinel OR a deliberate UTC instant',
       st.client === st.sentinel || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(st.client),
       st.client);
    ok('A7  an armed cutoff is never retroactive',
       !st.armed || Date.parse(st.client) >= Date.parse('2026-08-12T00:00:00.000Z'), st.client);
    eq('A8  enforcement flags agree across the two runtimes',
       srv.isEnforcementEnabled(), cli.isEnforcementEnabled());
  }
  /* ══ B · every vector, all three runtimes ════════════════════════════════ */
  head('B · every vector · browser · node · server');
  {
    const b = loadBrowser(), n = loadNodeClient(), s = loadServer();
    const cut = VECTORS.cutoffs;
    let disagreements = 0;

    VECTORS.vectors.forEach((v, i) => {
      const cutoff = cut[v.cutoff];
      const u = userFrom(v);
      const rb = b.enforcementApplies(u, { cutoff });
      const rn = n.enforcementApplies(u, { cutoff });
      const rs = s.enforcementApplies(u, { cutoff });

      ok('B' + (i + 1) + 's  server · ' + v.label, rs === v.enforced,
         'expected ' + v.enforced + ', got ' + rs);
      if (!(rb === rn && rn === rs)) {
        disagreements++;
        ok('B' + (i + 1) + 'x  runtimes agree · ' + v.label, false,
           'browser=' + rb + ' node=' + rn + ' server=' + rs);
      } else {
        ok('B' + (i + 1) + 'x  all three runtimes agree · ' + v.label, true);
      }
    });
    eq('B·  zero disagreements across all vectors', disagreements, 0);

    /* The boundary cases named in the acceptance, called out individually so a reader can
       see them rather than trusting a count. */
    const at = '2026-09-01T00:00:00.000Z';
    eq('B-lt  < cutoff  → not enforced (server)',
       s.enforcementApplies({ metadata: { creationTime: '2026-08-31T23:59:59.999Z' } }, { cutoff: at }), false);
    eq('B-eq  === cutoff → ENFORCED (server)',
       s.enforcementApplies({ metadata: { creationTime: at } }, { cutoff: at }), true);
    eq('B-gt  > cutoff  → enforced (server)',
       s.enforcementApplies({ metadata: { creationTime: '2026-09-01T00:00:00.001Z' } }, { cutoff: at }), true);
    eq('B-off sentinel → not enforced even for a future account (server)',
       s.enforcementApplies({ metadata: { creationTime: '2150-01-01T00:00:00.000Z' } },
                            { cutoff: s.SENTINEL_ISO }), false);
    eq('B-rfc RFC-1123 at the cutoff instant → ENFORCED (server)',
       s.enforcementApplies({ metadata: { creationTime: 'Tue, 01 Sep 2026 00:00:00 GMT' } },
                            { cutoff: at }), true);
    eq('B-unk unparseable → grandfathered (server)',
       s.enforcementApplies({ metadata: { creationTime: 'not-a-date' } }, { cutoff: at }), false);
    eq('B-nul missing → grandfathered (server)',
       s.enforcementApplies({ uid: 'u' }, { cutoff: at }), false);
  }

  /* ══ C · the sweep ═══════════════════════════════════════════════════════ */
  head('C · sweep — thousands of generated instants, compared pairwise');
  {
    const n = loadNodeClient(), s = loadServer();
    const CUTOFFS = ['2026-09-01T00:00:00.000Z', '2020-02-29T23:59:59.999Z',
                     '2027-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z'];
    /* Offsets clustered where an off-by-one lives, plus a wide spread. Deterministic. */
    const OFFSETS = [];
    for (let d = -3; d <= 3; d++) OFFSETS.push(d);                       /* ±3 ms */
    for (let k = 1; k <= 60; k++) OFFSETS.push(k * 1000, -k * 1000);     /* ±seconds */
    for (let k = 1; k <= 48; k++) OFFSETS.push(k * 3600000, -k * 3600000);   /* ±hours */
    for (let k = 1; k <= 60; k++) OFFSETS.push(k * 86400000, -k * 86400000); /* ±days */
    for (let k = 1; k <= 25; k++) OFFSETS.push(k * 31536000000, -k * 31536000000); /* ±years */

    let compared = 0, mismatches = [];
    for (const c of CUTOFFS) {
      const base = Date.parse(c);
      for (const off of OFFSETS) {
        const t = base + off;
        /* Both formats Firebase can hand us, for the same instant. */
        for (const fmt of [new Date(t).toISOString(), new Date(t).toUTCString()]) {
          const u = { metadata: { creationTime: fmt } };
          const rn = n.enforcementApplies(u, { cutoff: c });
          const rs = s.enforcementApplies(u, { cutoff: c });
          compared++;
          if (rn !== rs && mismatches.length < 5) {
            mismatches.push('cutoff=' + c + ' created=' + fmt + ' client=' + rn + ' server=' + rs);
          }
        }
      }
    }
    /* The exact expected count, not an arbitrary floor. A floor is a number somebody
       guessed, and when the loop shrinks the honest fix looks identical to lowering the
       bar. This asserts the sweep ran to COMPLETION — every offset, every cutoff, both
       formats — so a silently truncated loop fails instead of passing smaller. */
    const expected = OFFSETS.length * CUTOFFS.length * 2;
    eq('C1  the sweep ran to completion (' + OFFSETS.length + ' offsets × ' + CUTOFFS.length +
       ' cutoffs × 2 formats)', compared, expected);
    ok('C2  client and server never disagreed', mismatches.length === 0, mismatches.join(' | '));
    console.log('     ' + compared + ' instants compared across ' + CUTOFFS.length + ' cutoffs');

    /* toUTCString() drops milliseconds — so an instant 1ms after the cutoff is, in RFC-1123,
       the cutoff instant itself. Both sides must reach the same (correct) answer from the
       same lossy input rather than one of them compensating. */
    const c = '2026-09-01T00:00:00.000Z';
    const lossy = new Date(Date.parse(c) - 1).toUTCString();   /* → 31 Aug 23:59:59 GMT */
    eq('C3  a millisecond lost to RFC-1123 rounding is handled identically',
       n.enforcementApplies({ metadata: { creationTime: lossy } }, { cutoff: c }),
       s.enforcementApplies({ metadata: { creationTime: lossy } }, { cutoff: c }));
  }

  /* ══ D · the dispatcher reports it, and does not act on it ═══════════════ */
  head('D · emailChallengeStatus reports the verdict; issue/verify ignore it');
  {
    const src = read('functions/auth-dispatch.js');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

    ok('D1  the dispatcher requires the SERVER policy, not the client file',
       /require\(['"]\.\/auth-policy['"]\)/.test(code) &&
       !/sokoni-verify-policy/.test(code));

    const status = code.slice(code.indexOf('async function emailChallengeStatus'));
    ok('D2  status computes the verdict server-side', /policy\.enforcementApplies\(user\)/.test(status));
    ok('D3  ...and reports enabled + cutoff alongside it',
       /enabled:\s*policy\.isEnforcementEnabled\(\)/.test(status) && /cutoff:\s*policy\.CUTOFF_ISO/.test(status));

    /* The deliberate omission: a grandfathered account may still verify voluntarily, which
       is what makes a re-verification campaign possible without a new endpoint. */
    const issue = code.slice(code.indexOf('async function emailChallengeIssue'),
                             code.indexOf('function _maskEmail'));
    const verify = code.slice(code.indexOf('async function emailChallengeVerify'),
                              code.indexOf('async function emailChallengeStatus'));
    ok('D4  issue() does NOT consult the policy', !/policy\./.test(issue),
       (issue.match(/policy\.[a-zA-Z]+/g) || []).join(','));
    ok('D5  verify() does NOT consult the policy', !/policy\./.test(verify),
       (verify.match(/policy\.[a-zA-Z]+/g) || []).join(','));

    /* 6B must not have wandered into 6C or into the verification model. */
    ok('D6  the policy never writes a user record',
       !/policy[\s\S]{0,80}updateUser|updateUser[\s\S]{0,80}policy/.test(code));
    ok('D7  emailVerified is still only set by verify()',
       (code.match(/updateUser\([^)]*emailVerified/g) || []).length === 1);
    ok('D8  the server policy file writes nothing at all',
       !/admin\.|updateUser|firestore|setCustomUserClaims/.test(read('functions/auth-policy.js')));
  }

  /* ══ E · blast radius ════════════════════════════════════════════════════ */
  head('E · 6B changed nothing it was told not to');
  {
    const cp = require('child_process');
    const changed = cp.execSync('git diff --name-only HEAD', { cwd: ROOT, encoding: 'utf8' })
      .split('\n').map((s) => s.trim()).filter(Boolean);

    /* RETIRED at 6C — "auth.js untouched by 6B" and "the signup path still writes its own
       session". Both recorded that the signup work had not started, which was the correct
       boundary for 6B and is now false by authorisation: 6C IS that work.

       Replaced by the constraint that outlives it — signup may hold a session, but it must
       reach that decision through the shared verdict rather than a second copy of the
       policy. That is the thing 6B exists to make possible, and it does not expire. */
    const au = read('auth.js');
    ok('E1  signup decides via the shared gate, not its own policy',
       /SokoniVerifyGate\.enforce\(cred\.user/.test(au));
    ok('E2  ...and auth.js still declares no cutoff of its own',
       !/SENTINEL_ISO|CUTOFF_ISO\s*=|enforcementApplies/.test(
         au.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')));
    ok('E3  firestore.rules untouched', !changed.includes('firestore.rules'));
    ok('E4  no Stories file touched', !changed.some((f) => /stor(y|ies)/i.test(f)));
    /* A policy file MAY change — but only its cutoff line. "Untouched" expires the
       moment the release arms; "cutoff-only" does not, and catches more. */
    const cd = STATE.policyDiffIsCutoffOnly(STATE.CLIENT);
    ok('E5  any change to the client policy is the cutoff line and nothing else',
       cd.only, cd.lines.join(' | '));
    ok('E6  the vectors fixture was NOT edited to make this pass',
       !changed.includes('scripts/auth-policy-vectors.json'), changed.join(', '));

    const sd = STATE.policyDiffIsCutoffOnly(STATE.SERVER);
    ok('E7  any change to the server policy is the cutoff line and nothing else',
       sd.only, sd.lines.join(' | '));
    ok('E8  and the two sides are still identical', STATE.shippedState().identical,
       JSON.stringify(STATE.shippedState()));

    /* index.js must still export authDispatch by name — a new require inside the module
       does not change that, but the deploy depends on it. */
    ok('E9  authDispatch is still re-exported by name',
       /exports\.authDispatch\s*=/.test(read('functions/index.js')));
  }

  /* ══ F · positive controls ═══════════════════════════════════════════════ */
  head('F · positive controls — drift must be detectable');
  {
    const srvSrc = read('functions/auth-policy.js');
    function mutantServer(from, to) {
      ok('F·  mutation target present: ' + from.slice(0, 36), srvSrc.indexOf(from) >= 0);
      const m = { exports: {} };
      const ctx = { module: m, exports: m.exports, require, console };
      vm.createContext(ctx);
      vm.runInContext(srvSrc.replace(from, to), ctx, { filename: 'mutant-server.js' });
      return m.exports;
    }
    const n = loadNodeClient();
    const CUT = '2026-09-01T00:00:00.000Z';
    const at = { metadata: { creationTime: CUT } };

    /* The classic drift: server uses > where the client uses >=. Byte-identical constants
       would not notice; the vectors do. */
    const m1 = mutantServer('return created >= cutoff;', 'return created > cutoff;');
    const dm1 = m1.enforcementApplies(at, { cutoff: CUT });
    ok('F1  a > / >= drift is caught at the exact cutoff — so B-eq really bites',
       dm1 === false && n.enforcementApplies(at, { cutoff: CUT }) === true,
       'server=' + dm1);

    /* Server enforcing an undateable account while the client grandfathers it. */
    const m2 = mutantServer('if (created === null) return false;', 'if (created === null) return true;');
    ok('F2  an unknown-date divergence is caught — so B-nul really bites',
       m2.enforcementApplies({ uid: 'u' }, { cutoff: CUT }) === true &&
       n.enforcementApplies({ uid: 'u' }, { cutoff: CUT }) === false);

    /* Server ignoring the sentinel. */
    /* Both sides evaluated against the SENTINEL explicitly, so this control keeps
       working when the shipped cutoff is armed. */
    const m3 = mutantServer('if (cutoffIso === SENTINEL_ISO) return false;', '');
    const SENT3 = n.SENTINEL_ISO;
    const far = { metadata: { creationTime: '2150-01-01T00:00:00.000Z' } };
    ok('F3  a sentinel divergence is caught — so B-off really bites',
       m3.enforcementApplies(far, { cutoff: SENT3 }) === true &&
       n.enforcementApplies(far, { cutoff: SENT3 }) === false);

    /* And the sweep would catch a drift the fixture never samples: a server that is correct
       at every vector but wrong one day either side of an unsampled cutoff. */
    const m4 = mutantServer('return created >= cutoff;',
                            'return created >= cutoff + 86400000;');
    let sweepCaught = 0;
    const base = Date.parse('2027-01-01T00:00:00.000Z');
    for (let k = 0; k < 200; k++) {
      const u = { metadata: { creationTime: new Date(base + k * 3600000).toISOString() } };
      if (m4.enforcementApplies(u, { cutoff: '2027-01-01T00:00:00.000Z' }) !==
          n.enforcementApplies(u, { cutoff: '2027-01-01T00:00:00.000Z' })) sweepCaught++;
    }
    ok('F4  a one-day skew the fixture never samples is caught by the sweep',
       sweepCaught > 0, 'divergences seen: ' + sweepCaught);
  }

  /* ── result ────────────────────────────────────────────────────────────── */
  console.log('\n' + '─'.repeat(70));
  if (fail) { console.log('\x1b[31mFAILURES\x1b[0m'); failures.forEach((f) => console.log('  ✗ ' + f)); }
  console.log((fail ? '\x1b[31m' : '\x1b[32m') + 'auth policy server: ' + pass + '/' + (pass + fail) + '\x1b[0m');
  process.exit(fail ? 1 : 0);
})();
