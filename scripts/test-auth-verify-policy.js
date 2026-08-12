/* ══════════════════════════════════════════════════════════════════════════════
   AUTH SLICE 6A — enforcement policy, and the cross-runtime contract
   ------------------------------------------------------------------------------
   A byte-identical cutoff string on two sides proves the two sides agree about a STRING.
   It does not prove they agree about a DATE. Different parsing, a timezone assumption, or
   a `>` where the other has `>=` all survive that check and then diverge exactly at the
   boundary — the one place a mistake either locks somebody out or lets somebody through.

   So the contract is a table of dates and verdicts (scripts/auth-policy-vectors.json), and
   every runtime that evaluates the policy must reproduce it. Today:

     browser   sokoni-verify-policy.js loaded as a classic script in a vm sandbox
     node      the same file required as a CommonJS module

   Slice 6B adds the Functions runtime as a third consumer, and it must assert against this
   same fixture rather than against a copied constant.
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

/* ── the two runtimes ────────────────────────────────────────────────────────── */

/* browser: classic script, publishes window.SokoniVerifyPolicy */
function loadBrowser() {
  const w = { console: { warn() { }, log() { } } };
  vm.createContext(w); w.window = w;
  vm.runInContext(read('sokoni-verify-policy.js'), w, { filename: 'sokoni-verify-policy.js' });
  if (!w.SokoniVerifyPolicy) throw new Error('browser load published nothing');
  return w.SokoniVerifyPolicy;
}

/* node: CommonJS require of the same file, no cache */
function loadNode() {
  const p = require.resolve(path.join(ROOT, 'sokoni-verify-policy.js'));
  delete require.cache[p];
  const api = require(p);
  if (!api || typeof api.enforcementApplies !== 'function') throw new Error('node load failed');
  return api;
}

const userFrom = (v) => (v.noMetadata ? { uid: 'u' } : { uid: 'u', metadata: { creationTime: v.creationTime } });

(function run() {

  /* ══ A · the shipped default ═════════════════════════════════════════════ */
  head('A · what ships: enforcement OFF');
  {
    const b = loadBrowser(), n = loadNode();

    /* STATE — the shipped cutoff must be coherent, not necessarily the sentinel. */
    const st = STATE.shippedState();
    eq('A1  client and server ship the SAME cutoff', st.client, st.server);
    eq('A2  the sentinel value is unchanged', st.sentinel, '2099-01-01T00:00:00.000Z');
    ok('A3  the shipped cutoff is the sentinel OR a deliberate UTC instant',
       st.client === st.sentinel || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(st.client),
       st.client);
    eq('A3b both runtimes agree on the shipped value', b.CUTOFF_ISO, n.CUTOFF_ISO);
    ok('A4  describe() reports the state it is actually in',
       st.armed ? /enforcement ON from /.test(b.describe()) : /enforcement OFF/.test(b.describe()),
       b.describe());

    /* Passes SENTINEL explicitly. This asserts what the sentinel VALUE does — a permanent
       property of the code — rather than what the shipped constant happens to be today.
       Reading the shipped constant made this fail the moment the cutoff was armed, which
       is the one state the release exists to reach. */
    const SENT = b.SENTINEL_ISO;
    const dates = ['1999-01-01T00:00:00.000Z', '2026-08-12T00:00:00.000Z',
                   '2099-01-01T00:00:00.000Z', '2150-01-01T00:00:00.000Z'];
    ok('A5  the sentinel enforces nobody at ANY creation date',
       dates.every((d) => b.enforcementApplies({ metadata: { creationTime: d } },
                                               { cutoff: SENT }) === false));
    eq('A6  ...including an account created after the sentinel date itself',
       b.enforcementApplies({ metadata: { creationTime: '2099-06-01T00:00:00.000Z' } },
                            { cutoff: SENT }), false);
    eq('A7  ...and the server agrees',
       n.enforcementApplies({ metadata: { creationTime: '2099-06-01T00:00:00.000Z' } },
                            { cutoff: SENT }), false);
  }
  /* ══ B · the cross-runtime contract ══════════════════════════════════════ */
  head('B · cross-runtime contract — every vector, both runtimes');
  {
    const b = loadBrowser(), n = loadNode();
    const cut = VECTORS.cutoffs;

    ok('B0  the fixture carries vectors', VECTORS.vectors.length >= 15,
       String(VECTORS.vectors.length));
    ok('B0b the fixture cutoffs match the shipped sentinel', cut.sentinel === b.SENTINEL_ISO,
       cut.sentinel + ' vs ' + b.SENTINEL_ISO);

    let mismatches = 0;
    VECTORS.vectors.forEach((v, i) => {
      const cutoff = cut[v.cutoff];
      const user = userFrom(v);
      const rb = b.enforcementApplies(user, { cutoff });
      const rn = n.enforcementApplies(user, { cutoff });

      ok('B' + (i + 1) + '  browser · ' + v.label, rb === v.enforced,
         'expected ' + v.enforced + ', got ' + rb);
      ok('B' + (i + 1) + 'n node    · ' + v.label, rn === v.enforced,
         'expected ' + v.enforced + ', got ' + rn);
      if (rb !== rn) { mismatches++; }
    });
    eq('B·  the two runtimes never disagreed', mismatches, 0);
  }

  /* ══ C · the boundary, stated three ways ═════════════════════════════════ */
  head('C · the boundary is half-open [cutoff, ∞) and does not drift');
  {
    const p = loadBrowser();
    const CUT = '2026-09-01T00:00:00.000Z';
    const at = Date.parse(CUT);
    const at_ = (ms) => p.enforcementApplies({ metadata: { creationTime: new Date(ms).toISOString() } },
                                             { cutoff: CUT });

    eq('C1  cutoff − 1ms  → grandfathered', at_(at - 1), false);
    eq('C2  cutoff + 0ms  → ENFORCED', at_(at), true);
    eq('C3  cutoff + 1ms  → enforced', at_(at + 1), true);
    eq('C4  cutoff − 1 day → grandfathered', at_(at - 86400000), false);
    eq('C5  cutoff + 1 day → enforced', at_(at + 86400000), true);

    /* The same instant expressed three ways must give the same verdict — this is where a
       string comparison or a timezone assumption would show up. */
    const same = ['2026-09-01T00:00:00.000Z', 'Tue, 01 Sep 2026 00:00:00 GMT',
                  '2026-09-01T03:00:00.000+03:00'];
    const verdicts = same.map((c) => p.enforcementApplies({ metadata: { creationTime: c } }, { cutoff: CUT }));
    ok('C6  the cutoff instant in ISO, RFC-1123 and +03:00 all agree (all enforced)',
       verdicts.every((v) => v === true), JSON.stringify(verdicts));

    /* Comparison must be numeric. If it were lexical, RFC-1123 "Fri, ..." vs an ISO cutoff
       would sort nonsensically — this vector fails loudly under a string compare. */
    eq('C7  RFC-1123 date well before an ISO cutoff is grandfathered, not mis-sorted',
       p.enforcementApplies({ metadata: { creationTime: 'Fri, 31 Jul 2026 10:00:00 GMT' } },
                            { cutoff: CUT }), false);
  }

  /* ══ D · unknown relaxes ═════════════════════════════════════════════════ */
  head('D · an undateable account is grandfathered, never locked out');
  {
    const p = loadBrowser();
    const CUT = '2026-09-01T00:00:00.000Z';
    const cases = [
      ['no metadata object', { uid: 'u' }],
      ['metadata present, creationTime null', { metadata: { creationTime: null } }],
      ['creationTime empty', { metadata: { creationTime: '' } }],
      ['creationTime garbage', { metadata: { creationTime: 'not-a-date' } }],
      ['creationTime NaN-ish', { metadata: { creationTime: 'Invalid Date' } }],
      ['user is null', null],
      ['user is undefined', undefined],
    ];
    cases.forEach(([label, u], i) => {
      eq('D' + (i + 1) + '  ' + label + ' → not enforced',
         p.enforcementApplies(u, { cutoff: CUT }), false);
    });

    /* An unreadable CUTOFF must also enforce nothing, rather than enforcing everything. */
    eq('D8  an unparseable cutoff enforces nobody',
       p.enforcementApplies({ metadata: { creationTime: '2027-01-01T00:00:00.000Z' } },
                            { cutoff: 'nonsense' }), false);
  }

  /* ══ E · composition with the gate ═══════════════════════════════════════ */
  head('E · the gate composes the two without changing either');
  {
    function loadGate(policyCutoff, withPolicy) {
      const w = { console: { warn() { }, log() { } }, document: null };
      vm.createContext(w); w.window = w;
      if (withPolicy !== false) {
        vm.runInContext(read('sokoni-verify-policy.js'), w, { filename: 'policy.js' });
        if (policyCutoff) w.SokoniVerifyPolicy.CUTOFF_ISO = policyCutoff;
      }
      vm.runInContext(read('sokoni-verify-gate.js'), w, { filename: 'gate.js' });
      return w;
    }
    const pwUser = (created, verified) => ({
      uid: 'u', email: 'a@b.c', emailVerified: !!verified,
      providerData: [{ providerId: 'password' }],
      metadata: { creationTime: created },
    });

    const CUT = '2026-09-01T00:00:00.000Z';
    const on = loadGate(CUT);
    const legacy = pwUser('2026-07-15T00:00:00.000Z');
    const fresh = pwUser('2026-09-02T00:00:00.000Z');

    eq('E1  needsVerification is UNCHANGED — legacy account is still unverified',
       on.SokoniVerifyGate.needsVerification(legacy), true);
    eq('E2  ...and so is the new account', on.SokoniVerifyGate.needsVerification(fresh), true);
    eq('E3  but the legacy account is NOT gated', on.SokoniVerifyGate.isGated(legacy), false);
    eq('E4  and the new account IS', on.SokoniVerifyGate.isGated(fresh), true);
    eq('E5  a verified new account is not gated',
       on.SokoniVerifyGate.isGated(pwUser('2026-09-02T00:00:00.000Z', true)), false);

    /* Explicitly the sentinel, not "whatever ships today" — this block is about what
       the sentinel does. */
    const off = loadGate(loadBrowser().SENTINEL_ISO);
    eq('E6  under the sentinel the new account is not gated either',
       off.SokoniVerifyGate.isGated(fresh), false);
    eq('E7  ...while still being genuinely unverified',
       off.SokoniVerifyGate.needsVerification(fresh), true);

    /* Missing policy relaxes rather than locking out an entire population. */
    const none = loadGate(null, false);
    eq('E8  policy module absent → nothing is gated', none.SokoniVerifyGate.isGated(fresh), false);
    eq('E9  ...and needsVerification still answers honestly',
       none.SokoniVerifyGate.needsVerification(fresh), true);
  }

  /* ══ F · evaluate() spends no network on a grandfathered account ═════════ */
  head('F · policy is checked BEFORE the token refresh');
  {
    const w = { console: { warn() { }, log() { } } };
    vm.createContext(w); w.window = w;
    vm.runInContext(read('sokoni-verify-policy.js'), w, { filename: 'policy.js' });
    w.SokoniVerifyPolicy.CUTOFF_ISO = '2026-09-01T00:00:00.000Z';
    vm.runInContext(read('sokoni-verify-gate.js'), w, { filename: 'gate.js' });

    const mk = (created) => {
      const u = {
        uid: 'u', email: 'a@b.c', emailVerified: false,
        providerData: [{ providerId: 'password' }],
        metadata: { creationTime: created }, reloadCalls: 0,
      };
      u.reload = function () { u.reloadCalls++; return Promise.resolve(); };
      return u;
    };

    const legacy = mk('2026-07-01T00:00:00.000Z');
    const fresh = mk('2026-09-05T00:00:00.000Z');

    return Promise.all([
      w.SokoniVerifyGate.evaluate(legacy),
      w.SokoniVerifyGate.evaluate(fresh),
    ]).then(([rl, rf]) => {
      eq('F1  grandfathered account is not gated', rl.gated, false);
      eq('F2  ...with a reason that names why', rl.reason, 'grandfathered');
      eq('F3  ...and cost ZERO network round trips', legacy.reloadCalls, 0);
      eq('F4  the enforced account is gated', rf.gated, true);
      eq('F5  ...and did pay for its refresh', fresh.reloadCalls, 1);
      finish();
    });
  }
})();

function finish() {
  /* ══ G · positive controls ═════════════════════════════════════════════ */
  head('G · positive controls');
  {
    const src = read('sokoni-verify-policy.js');
    function mutant(from, to) {
      ok('G·  mutation target present: ' + from.slice(0, 40), src.indexOf(from) >= 0);
      const w = { console: { warn() { }, log() { } } };
      vm.createContext(w); w.window = w;
      vm.runInContext(src.replace(from, to), w, { filename: 'mutant.js' });
      return w.SokoniVerifyPolicy;
    }
    const CUT = '2026-09-01T00:00:00.000Z';
    const at = { metadata: { creationTime: CUT } };
    const before = { metadata: { creationTime: '2026-08-31T23:59:59.999Z' } };

    /* Off-by-one at the boundary: > instead of >=. */
    const m1 = mutant('return created >= cutoff;', 'return created > cutoff;');
    eq('G1  the mutant lets the exact-cutoff account through — so C2 really bites',
       m1.enforcementApplies(at, { cutoff: CUT }), false);

    /* Lexical comparison instead of epoch millis. */
    const m2 = mutant('return created >= cutoff;',
                      'return String(user.metadata.creationTime) >= String(cutoffIso);');
    ok('G2  a string comparison misjudges RFC-1123 — so C7 really bites',
       m2.enforcementApplies({ metadata: { creationTime: 'Fri, 31 Jul 2026 10:00:00 GMT' } },
                             { cutoff: CUT }) === true);

    /* Unknown creation time enforcing instead of relaxing — the lockout direction. */
    const m3 = mutant('if (created === null) return false;', 'if (created === null) return true;');
    ok('G3  the mutant locks out an undateable account — so D1-D7 really bite',
       m3.enforcementApplies({ uid: 'u' }, { cutoff: CUT }) === true);

    /* Sentinel not short-circuiting. */
    const m4 = mutant('if (cutoffIso === SENTINEL_ISO) return false;', '');
    ok('G4  without the sentinel short-circuit a post-2099 account is enforced — so A6 bites',
       m4.enforcementApplies({ metadata: { creationTime: '2099-06-01T00:00:00.000Z' } }) === true);

    ok('G5  ...and the real file short-circuits on the sentinel',
       loadBrowserSafe().enforcementApplies({ metadata: { creationTime: '2099-06-01T00:00:00.000Z' } },
                                            { cutoff: loadBrowserSafe().SENTINEL_ISO }) === false);
  }

  /* ══ H · the policy writes nothing, anywhere ═════════════════════════════ */
  head('H · the policy decides who is asked — it cannot decide who is verified');
  {
    const src = read('sokoni-verify-policy.js');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    ok('H1  it never touches emailVerified', !/emailVerified/.test(code));
    ok('H2  it never writes storage', !/localStorage|sessionStorage/.test(code));
    ok('H3  it reads no cached profile', !/sokoniUser|loggedIn/.test(code));
    ok('H4  it makes no network call', !/fetch|XMLHttpRequest|httpsCallable|sokoniCallable/.test(code));
    ok('H5  it calls no Admin SDK', !/admin\.|updateUser|setCustomUserClaims/.test(code));

    const gate = read('sokoni-verify-gate.js');
    /* An ASSIGNMENT, not a comparison — `emailVerified\s*=` also matches the `===` the gate
       legitimately uses to read the flag, which failed this for the wrong reason. */
    ok('H6  the gate still marks nobody verified (no assignment to the flag)',
       !/emailVerified\s*=(?!=)/.test(gate));
    ok('H6b ...and the comparison it does use is still there',
       /emailVerified\s*===\s*true/.test(gate));
    ok('H7  the verification rule is unchanged by this slice',
       /function needsVerification[\s\S]{0,700}?ids\.indexOf\('password'\) !== -1/.test(gate));

    /* No product file may set the cutoff at runtime — only the shipped constant and the
       suites do. A page that could move the cutoff could grandfather itself. */
    const productSetters = fs.readdirSync(ROOT)
      .filter((f) => /\.(js|html)$/.test(f) && f !== 'sokoni-verify-policy.js')
      .filter((f) => /SokoniVerifyPolicy\s*\.\s*CUTOFF_ISO\s*=/.test(read(f)));
    eq('H8  no shipped file reassigns the cutoff', productSetters.join(',') || '(none)', '(none)');
  }

  console.log('\n' + '─'.repeat(70));
  if (fail) { console.log('\x1b[31mFAILURES\x1b[0m'); failures.forEach((f) => console.log('  ✗ ' + f)); }
  console.log((fail ? '\x1b[31m' : '\x1b[32m') + 'auth verify policy: ' + pass + '/' + (pass + fail) + '\x1b[0m');
  process.exit(fail ? 1 : 0);
}

function loadBrowserSafe() {
  const w = { console: { warn() { }, log() { } } };
  vm.createContext(w); w.window = w;
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'sokoni-verify-policy.js'), 'utf8'), w,
                  { filename: 'policy.js' });
  return w.SokoniVerifyPolicy;
}
