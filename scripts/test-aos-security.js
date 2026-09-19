/* ══════════════════════════════════════════════════════════════════════════════
   ADMINOS SECURITY CENTRE — certification
   scripts/test-aos-security.js            node scripts/test-aos-security.js

   A security console is the worst possible place for a decorative figure: an administrator
   acts on what it says. So most of this suite is about what the page REFUSES to show —
   a count it could not read, a score nobody computed, an adoption percentage this account
   is not permitted to calculate.

   Every absence assertion is paired with an inverting control, because "the page does not
   say 68%" passes just as well when the renderer produced nothing at all.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (n, c, d) => {
  if (c) { pass++; console.log('  PASS  ' + n + (d ? '   [' + d + ']' : '')); }
  else { fail++; console.log('  FAIL  ' + n + (d ? '   [' + d + ']' : '')); }
};
const head = t => console.log('\n' + t);
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/* A DOM stub: enough for the module to render into, and nothing more. */
global.document = {
  getElementById: () => null,
  createElement: () => ({ setAttribute () {}, appendChild () {}, style: {} }),
  head: { appendChild () {} },
};
global.window = globalThis;
const SEC = require(path.join(ROOT, 'sokoni-aos-security.js'));

/* A host that records what it was given. */
function host () {
  return { innerHTML: '', addEventListener () {}, querySelector: () => null };
}
const okRes = (docs) => ({ ok: true, docs: docs.map((o, i) => ({ id: o.id || 'd' + i, data: () => o })) });
const denied = () => ({ ok: false, denied: true, reason: 'permission-denied', docs: [] });
const empty = () => ({ ok: true, docs: [] });

const FULL = {
  alerts: okRes([{ status: 'open' }, { status: 'open' }]),
  incidents: okRes([{ severity: 'high', title: 'Credential stuffing', summary: 'Repeated failures' }]),
  sessions: okRes([{ email: 'a@b.com', device: 'Chrome', ip: '1.2.3.4', lastActive: Date.now() - 60000 }]),
  approvals: okRes([{ type: 'role_change', requestedByEmail: 'x@y.com', createdAt: Date.now() }]),
  events: okRes([{ type: 'bot_detected', ip: '9.9.9.9', ts: Date.now() - 5000, severity: 'high' }]),
  risk: okRes([{ email: 'r@s.com', score: 82 }, { email: 'q@s.com' }]),
  audit: okRes([{ action: 'admin_role_granted', actorEmail: 'admin@x.com', ts: Date.now() }]),
};
function renderWith (over) {
  const h = host();
  SEC._render(h, Object.assign({}, FULL, over || {}));
  return h.innerHTML;
}

console.log('══════════════════════════════════════════════════════════════════');
console.log('  ADMINOS SECURITY CENTRE');
console.log('══════════════════════════════════════════════════════════════════');

/* ── 1. NOTHING IS INVENTED ─────────────────────────────────────────────────── */
head('1 - the figures the mockup wanted, and why they are not here');
{
  const html = renderWith();
  /* securityMFA and securityDevices are readable ONLY by the person they describe. An
     adoption percentage or a device-trust donut cannot be computed from an admin account,
     so neither is rendered — and the page says why. */
  /* ASSERT ON THE FIGURE, NOT THE WORD. A ban on "adoption" matched the page's own sentence
     explaining that there IS no adoption figure — prose counted as evidence, which is the
     exact trap this codebase has been bitten by. What must be absent is a rendered
     percentage, so that is what is checked. */
  ok('no percentage figure is rendered anywhere', !/\d+(\.\d+)?%/.test(html));
  ok('control — the page does discuss MFA, it just shows no number',
     /securityMFA/.test(html));
  ok('no security posture score is invented', !/posture score/i.test(html));
  ok('no device-trust count is invented', !/\btrusted\b/i.test(html));
  ok('the owner-scoped boundary is named instead', html.indexOf('Not an administrator') > -1);
  ok('and both collections are named', /securityMFA/.test(html) && /securityDevices/.test(html));
  /* The sentence that stops the empty panel being "fixed" by widening a privacy rule. */
  ok('it warns against widening the rule for a number',
     html.indexOf('trade every user') > -1);

  /* INVERTING CONTROL — the renderer really does emit figures when it has them. */
  ok('control — real counts ARE rendered', /secx-stat-n">2</.test(html), 'two open alerts');
}

/* ── 2. UNREADABLE IS NOT ZERO ──────────────────────────────────────────────── */
head('2 - a count that could not be read is a dash, never 0');
{
  const html = renderWith({ alerts: denied(), incidents: denied() });
  ok('a denied count renders as a dash', /secx-stat-n">—</.test(html));
  ok('and is styled as unknown, not calm', /secx-stat--unknown/.test(html));
  ok('and says it was not readable', html.indexOf('Not readable with this account') > -1);

  /* THE DISTINCTION THAT MATTERS MOST ON THIS PAGE. */
  const e = renderWith({ events: denied() });
  ok('a denied panel says nothing was read',
     e.indexOf('this is not an empty result. Nothing was read') > -1);
  const z = renderWith({ events: empty() });
  ok('control — a genuinely empty panel says so differently',
     z.indexOf('No security events recorded') > -1 &&
     z.indexOf('Nothing was read') === -1);

  /* A REAL zero must still read as zero — the rule is about unknowns. */
  const zero = renderWith({ alerts: empty() });
  ok('control — a real zero IS shown as 0', /secx-stat-n">0</.test(zero));
  ok('and is styled calm, not unknown',
     /secx-stat--calm/.test(zero) && !/secx-stat--unknown/.test(zero));
}

/* ── 3. RISK SCORES ─────────────────────────────────────────────────────────── */
head('3 - an unscored user is not a safe user');
{
  const html = renderWith();
  ok('a real score is shown', html.indexOf('>82<') > -1);
  ok('and banded by severity', /secx-band--crit/.test(html));
  /* A risk console printing 0 for "never scored" tells an administrator the account is fine. */
  ok('an absent score renders as a dash, not 0', /secx-band--info">—</.test(html));
  ok('no risk band is invented for it', !/secx-band--ok">—/.test(html));
}

/* ── 4. THE ORDERING DEFECT IS NOT INHERITED ────────────────────────────────── */
head('4 - events are ordered by the field the writers actually stamp');
{
  /* Every securityEvents writer in functions/index.js stamps `ts`. Firestore EXCLUDES
     documents missing the ordered field, so ordering by `createdAt` returns nothing on a
     platform that is recording events — the base panel's query does exactly that. */
  const fn = read('functions/index.js');
  const writes = (fn.match(/collection\("securityEvents"\)\.add\(\{[\s\S]{0,260}?\}\)/g) || []);
  ok('control — securityEvents writers were found', writes.length >= 4, writes.length + ' writers');
  ok('every writer stamps ts', writes.every(w => /\bts:\s*admin\.firestore\.FieldValue\.serverTimestamp/.test(w)));
  ok('and none stamps createdAt', writes.every(w => !/createdAt/.test(w)));

  const src = strip(read('sokoni-aos-security.js'));
  ok('the security centre orders events by ts', /ordered\('securityEvents', 'ts'/.test(src));
  ok('and falls back to an unordered read rather than a false empty',
     /return safeRead\(col\(name\)\.limit\(limit\)\.get\(\)\);/.test(src));
}

/* ── 5. SAFETY ──────────────────────────────────────────────────────────────── */
head('5 - hostile data cannot reach the DOM');
{
  const x = '<img src=x onerror=alert(1)>';
  const html = renderWith({
    events: okRes([{ type: x, ip: x, ts: Date.now() }]),
    sessions: okRes([{ email: x, device: x, ip: x, id: x }]),
    risk: okRes([{ email: x, score: 5 }]),
  });
  ok('event fields are escaped', html.indexOf('<img') === -1);
  ok('and the payload is present but inert', html.indexOf('&lt;img') > -1);
  /* The session id is spliced into a data attribute for the revoke button. */
  ok('the session id is escaped in the action attribute',
     !/data-id="[^"]*<img/.test(html));
}

/* ── 6. IT ADDS A SURFACE, NOT A SECOND WAY TO ACT ──────────────────────────── */
head('6 - actions delegate; no second revoke path is created');
{
  const src = strip(read('sokoni-aos-security.js'));
  ok('the module performs no delete of its own', !/\.delete\(\)/.test(src));
  ok('nor any write', !/\.set\(|\.update\(|\.add\(/.test(src));
  ok('it delegates revoke to AdminOS', /A\.revokeSession/.test(src));
  ok('and approvals too', /A\.approveRequest/.test(src) && /A\.rejectRequest/.test(src));
}

/* ── 7. ADDITIVE: NOTHING ELSE CHANGED ──────────────────────────────────────── */
head('7 - the rest of AdminOS is untouched');
{
  const aos = read('sokoni-aos.js');
  ok('the original security panel is still present as a fallback',
     aos.indexOf('Pending Approvals (') > -1 && aos.indexOf('Security Tools') > -1);
  ok('the centre is tried first, and falls through on error',
     /SokoniAOSSecurity[\s\S]{0,400}catch[\s\S]{0,160}using base panel/.test(aos));
  ok('no other section loader was modified',
     /security:\s+\(\) => _loadSecurity\(\)/.test(aos));

  const html = read('admin-os.html');
  /* Compared on the SCRIPT TAGS. A plain indexOf found the shell's filename inside the
     comment above the tags, so the order being checked was prose, not loading. */
  const tags = [...html.matchAll(/<script src="(sokoni-aos(?:-security)?\.js)"><\/script>/g)]
    .map(m => m[1]);
  ok('control — both script tags were found', tags.length === 2, tags.join(' then '));
  ok('admin-os.html loads the centre before the shell',
     tags[0] === 'sokoni-aos-security.js' && tags[1] === 'sokoni-aos.js', tags.join(' then '));
  ok('the Security nav item already existed and was not duplicated',
     (html.match(/data-section="security"/g) || []).length === 1);
}

/* ── 8. THE SUPER ADMIN ENTRY ───────────────────────────────────────────────── */
head('8 - Super Admin links to the canonical page, it does not rebuild it');
{
  const sa = read('super-admin.html');
  ok('a Security entry exists in the existing sidebar', /data-section="security"/.test(sa));
  ok('it is a LINK to AdminOS, not a second implementation',
     /href="admin-os\.html#security"/.test(sa));
  ok('and it does not call SA.nav', !/SA\.nav\('security'\)/.test(sa));
  /* ADMINOS IS THE CANONICAL ADMIN WORKSPACE. Two security consoles would be free to
     disagree about what is happening on the platform. */
  ok('no security panel markup was added to super-admin',
     !/securityBody|secx-/.test(sa));

  /* The deep link must actually work, or the entry is decorative. */
  const aos = strip(read('sokoni-aos.js'));
  ok('AdminOS honours a section named in the hash', /location\.hash/.test(aos));
  ok('the hash is validated against a real nav item',
     /nav-item\[data-section="' \+ _h \+ '"\]/.test(aos));
  ok('an unknown hash falls back to the dashboard',
     /_navigate\(_valid \? _h : "dashboard"\)/.test(aos));
  /* A hash is attacker-controllable; it must never reach a selector unsanitised. */
  ok('and a hostile hash cannot reach the selector', /\^\[a-z\]\+\$/.test(aos));
}

console.log('\n  what this suite does NOT prove');
console.log('  UNPROVEN  live Firestore reads   [proven by loading admin-os.html]');

console.log('\n══════════════════════════════════════════════════════════════════');
console.log('  ' + pass + ' passed, ' + fail + ' failed');
console.log('══════════════════════════════════════════════════════════════════');
process.exit(fail ? 1 : 0);
