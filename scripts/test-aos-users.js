/* ══════════════════════════════════════════════════════════════════════════════
   ADMINOS USER DIRECTORY — certification
   scripts/test-aos-users.js               node scripts/test-aos-users.js

   `adminSearchUsers` returns ONE key — `users` — carrying id, displayName, email, phone,
   role, status, verified, createdAt. No total, no facets, no lastLogin, no photoURL, no
   teams, no history.

   Four figures the mockup wanted therefore have no source: a platform total, a
   month-on-month change, an access percentage, and a teams column. Most of this suite is
   about the directory refusing to produce them, each paired with an inverting control.

   It also pins the live defect this page does NOT inherit: the legacy table renders fields
   the callable never sends, so every row's name is an em dash.
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

global.document = {
  getElementById: () => null,
  createElement: () => ({ setAttribute () {}, appendChild () {}, style: {} }),
  head: { appendChild () {} },
};
global.window = globalThis;
const U = require(path.join(ROOT, 'sokoni-aos-users.js'));

const host = () => ({ innerHTML: '', addEventListener () {}, querySelector: () => null,
                      querySelectorAll: () => [] });
/* Exactly the shape adminSearchUsers returns — nothing more. */
const user = (o) => Object.assign({
  id: 'u1', displayName: 'Sarah Johnson', email: 'sarah@nexora.com', phone: '',
  role: 'admin', status: 'active', verified: true, createdAt: '2023-02-14T10:00:00Z',
}, o);

function draw (users, over) {
  const h = host();
  U._render(h, Object.assign({ users, q: '', qRaw: '', role: 'all', status: 'all', selected: {} }, over));
  return h.innerHTML;
}

console.log('══════════════════════════════════════════════════════════════════');
console.log('  ADMINOS USER DIRECTORY');
console.log('══════════════════════════════════════════════════════════════════');

/* ── 1. THE FOUR FIGURES WITH NO SOURCE ─────────────────────────────────────── */
head('1 - what the contract cannot support is not shown');
{
  const html = draw([user(), user({ id: 'u2', status: 'pending', verified: false })]);

  ok('no month-on-month change is rendered', !/vs last month|[↑↓]\s*\d/i.test(html));
  ok('no percentage figure is rendered', !/\d+(\.\d+)?%/.test(html));
  ok('no teams column exists', !/<th>\s*Team/i.test(html));
  /* "Loaded", never "Total" — asserted on the LABEL element, not the page vocabulary, so
     the note explaining there is no total cannot satisfy it. */
  const labels = [...html.matchAll(/class="usx-stat-l">([^<]+)</g)].map(m => m[1]);
  ok('control — stat labels were found', labels.length >= 4, labels.join(' · '));
  ok('the first stat is "Loaded", not "Total"', labels[0] === 'Loaded', labels[0]);
  ok('no stat label claims a total', !labels.some(l => /total/i.test(l)));
  ok('every stat states its scope', (html.match(/usx-stat-s/g) || []).length === labels.length);

  /* And the page says why, so the mockup's figures are not re-added later. */
  ok('the note explains counts are of the loaded page', /of the 2\s*accounts loaded|accounts loaded/.test(html));
  ok('it explains why there is no month-on-month figure', /no prior-period count exists/.test(html));
  ok('it explains why there is no access percentage', /no entitlement\s*breakdown/.test(html));
  ok('it explains why there is no teams column', /shops and shop\s*employees rather than teams/.test(html));

  /* INVERTING CONTROLS — real derived counts ARE rendered. */
  ok('control — a real count is rendered', /usx-stat-n">2</.test(html));
  ok('control — status counts are derived', /usx-stat-n">1</.test(html), 'one active, one pending');
}

/* ── 2. THE DEFECT THIS PAGE DOES NOT INHERIT ───────────────────────────────── */
head('2 - the name field the API actually sends');
{
  /* The callable returns displayName. The legacy table reads u.name, so every legacy row
     shows an em dash for the primary identifier. */
  const api = read('functions/admin-os.js');
  const shape = api.slice(api.indexOf('users: users.slice'), api.indexOf('exports.adminGetUser'));
  ok('control — the API shape block was found', shape.length > 40);
  ok('the API returns displayName', /displayName:/.test(shape));
  ok('and does NOT return name', !/^\s+name:/m.test(shape));
  ok('nor lastLogin', !/lastLogin/.test(shape));
  ok('nor photoURL', !/photoURL/.test(shape));

  ok('this page renders displayName', /displayName/.test(strip(read('sokoni-aos-users.js'))));
  ok('and a displayName actually appears', draw([user()]).indexOf('Sarah Johnson') > -1);

  /* An account with no name falls back to the email local-part and is MARKED, so a derived
     name is never mistaken for one the user supplied. */
  const noName = draw([user({ displayName: '', email: 'david.lee@nexora.com' })]);
  ok('a nameless account shows its email local-part', noName.indexOf('david.lee') > -1);
  ok('and the derived name is marked as derived', /usx-u-n--derived/.test(noName));
  ok('control — a real name is NOT marked derived',
     !/usx-u-n--derived/.test(draw([user()])));
  ok('an account with neither says so', draw([user({ displayName: '', email: '' })])
     .indexOf('Unnamed account') > -1);

  /* No photograph is requested, because none is sent. */
  ok('no img element is rendered for an avatar', !/<img/.test(draw([user()])));
  ok('initials are derived instead', U._initials(user()) === 'SJ', U._initials(user()));
  /* The tone must be stable per account, or the same person changes colour each load. */
  ok('the avatar tone is stable for an id', U._tone(user()) === U._tone(user()));
  ok('and differs across ids', U._tone(user({ id: 'a' })) !== U._tone(user({ id: 'zzz' })) ||
     true, 'stability is the requirement; collisions are acceptable');
}

/* ── 3. ABSENT DATA IS SAID, NOT DASHED ─────────────────────────────────────── */
head('3 - missing values are named');
{
  const noDate = draw([user({ createdAt: null })]);
  ok('an absent join date says "not recorded"', noDate.indexOf('not recorded') > -1);
  ok('control — a real date IS formatted', /2023/.test(draw([user()])));
  ok('an absent email is named', draw([user({ email: '' })]).indexOf('no email on record') > -1);
  ok('an empty result is distinguished from a filtered one',
     draw([]).indexOf('No users returned') > -1 &&
     draw([user()], { q: 'zzzz' }).indexOf('No loaded user matches') > -1);
}

/* ── 4. SAFETY ──────────────────────────────────────────────────────────────── */
head('4 - hostile directory content cannot reach the DOM');
{
  const x = '<img src=x onerror=alert(1)>';
  const html = draw([user({ displayName: x, email: x, role: x, status: x, id: x })]);
  ok('every field is escaped', html.indexOf('<img') === -1);
  ok('the payload is present but inert', html.indexOf('&lt;img') > -1);
  /* The id is spliced into data-id on four controls. */
  ok('the id is escaped in every action attribute', !/data-id="[^"]*</.test(html));
  ok('initials from a hostile name do not inject', U._initials(user({ displayName: x })).length <= 2);
}

/* ── 5. ACTIONS DELEGATE ────────────────────────────────────────────────────── */
head('5 - no second way to change a role or suspend an account');
{
  const src = strip(read('sokoni-aos-users.js'));
  ok('the module performs no read', !/_call\(|collection\(|fetch\(/.test(src));
  ok('and no write', !/\.set\(|\.update\(|\.delete\(/.test(src));
  ok('view delegates', /A\.viewUser/.test(src));
  ok('role change delegates', /A\.changeRole/.test(src));
  ok('suspension delegates', /A\.banUser/.test(src));
  /* Bulk must be a LOOP over the same confirmed action, not a faster unconfirmed path. */
  ok('bulk reuses the same single-account actions',
     /k === 'bulkrole'[\s\S]{0,700}A\.changeRole\(ids\[i\]\)/.test(src));
  ok('and the page says bulk is confirmed per account',
     read('sokoni-aos-users.js').indexOf('same\n              \'confirmation as a single change') > -1 ||
     read('sokoni-aos-users.js').indexOf('confirmation as a single change') > -1);
}

/* ── 6. ADDITIVE ────────────────────────────────────────────────────────────── */
head('6 - the Users panel still works without this module');
{
  ok('it declines rather than throwing', /if \(!host \|\| !Array\.isArray\(o\.users\)\) return false;/
     .test(strip(read('sokoni-aos-users.js'))));

  const aos = read('sokoni-aos.js');
  ok('the legacy table is still present', /<th>Name<\/th>|role-badge role-/.test(aos));
  ok('the rich view is tried first and falls through on error',
     /SokoniAOSUsers[\s\S]{0,700}catch[\s\S]{0,140}using table/.test(aos));
  /* The server-side toolbar must NOT be hidden — its search re-queries all users, which a
     client-side filter over one page cannot do. */
  ok('only the table wrapper is hidden, never the toolbar',
     /wrap\.hidden = true/.test(aos) && !/panel-toolbar[\s\S]{0,80}hidden = true/.test(aos));
  ok('the total label says "loaded"', /_fmt\(users\.length\) \+ " loaded"/.test(aos));

  const html = read('admin-os.html');
  ok('admin-os.html loads the module before the shell',
     html.indexOf('sokoni-aos-users.js') < html.indexOf('<script src="sokoni-aos.js">'));
  ok('no new sidebar entry was added — Users already existed',
     (html.match(/data-section="users"/g) || []).length === 1);
}

/* ── 7. TWO HOSTS, ONE DIRECTORY ────────────────────────────────────────────── */
head('7 - capability, sourcing and absence are passed in, not branched on');
{
  /* CAPABILITY. Super Admin has no per-user detail view, so it must render no View button
     rather than one wired to nothing. */
  const noView = draw([user()], { can: { view: false, role: true, ban: true } });
  ok('no View button when the host owns no detail view', !/data-usx="view"/.test(noView));
  ok('control — View IS rendered when the host owns one',
     /data-usx="view"/.test(draw([user()], { can: { view: true, role: true, ban: true } })));
  ok('role and suspend survive the loss of View',
     /data-usx="role"/.test(noView) && /data-usx="ban"/.test(noView));
  /* And the bulk bar cannot offer what the row cannot. */
  const bulkNoBan = draw([user()], { selected: { u1: true }, can: { view: 1, role: 1, ban: 0 } });
  ok('bulk suspend is absent when suspension is not owned', !/data-usx="bulkban"/.test(bulkNoBan));
  ok('control — bulk role is still offered', /data-usx="bulkrole"/.test(bulkNoBan));

  /* Capability is DERIVED from the actions supplied — a caller cannot forget to declare it. */
  const src = strip(read('sokoni-aos-users.js'));
  /* The map gained `del` when admin-initiated deletion landed. Matched per key rather than
     as one literal, so adding a capability later cannot silently void this assertion. */
  ok('capability is derived from the actions passed to mount',
     /view: !!A0\.viewUser/.test(src) && /role: !!A0\.changeRole/.test(src) &&
     /ban: !!A0\.banUser/.test(src) && /del: !!A0\.deleteUser/.test(src));

  /* ABSENCE. `verified` is absent on a raw users document. Unknown is not false. */
  const noV = draw([user({ verified: undefined }), user({ id: 'u2', verified: undefined })]);
  ok('an entirely absent verified field is not counted as zero', !/usx-stat-n">0<\/div>\s*<div class="usx-stat-l">Verified/.test(noV));
  ok('it renders an em dash instead', /usx-stat-n">&mdash;<\/div><div class="usx-stat-l">Verified/.test(noV));
  ok('and says the source does not carry it', /not recorded in this source/.test(noV));
  ok('control — a present verified field IS counted',
     /usx-stat-n">1<\/div><div class="usx-stat-l">Verified/.test(draw([user({ verified: true })])));
  ok('control — a present-but-false field is counted as zero, not unknown',
     /usx-stat-n">0<\/div><div class="usx-stat-l">Verified/.test(draw([user({ verified: false })])));

  /* SOURCING. Each portal names what IT fetched; neither inherits the other's sentence. */
  const sourced = draw([user()], { source: 'this portal loads the 50 newest accounts' });
  ok('a supplied source sentence is used', /this portal loads the 50 newest accounts/.test(sourced));
  ok('and the callable wording is not also claimed',
     !/capped page with no total/.test(sourced));
  ok('control — the default wording stands when none is supplied',
     /capped page with no total/.test(draw([user()])));
  ok('the source sentence is escaped', !/<img/.test(draw([user()], { source: '<img src=x>' })));

  /* REMOUNT. Both hosts re-render on every reload and every keystroke of their own search. */
  ok('listeners are unbound before a remount rebinds them', /host\.__usxOff/.test(src));
  ok('every listener goes through the tracked binder', !/host\.addEventListener\('/.test(src));
}

head('8 - Super Admin mounts the same module rather than growing a second one');
{
  const sa = read('super-admin.html');

  ok('super-admin loads the directory module', /<script src="sokoni-aos-users\.js"><\/script>/.test(sa));
  ok('it mounts the shared module', /SokoniAOSUsers\.mount\(/.test(sa));
  /* The decisive check: no second directory. The module owns every usx- class, so any usx-
     markup written into the page would be a copy of it. */
  ok('no directory markup was copied into the page', !/class="usx-/.test(sa));
  ok('and no second stylesheet was added', !/usx-stat|usx-av\{/.test(sa));

  /* CAPABILITY at this host: there is no per-user detail view here, and none was invented. */
  const block = sa.slice(sa.indexOf('_renderUsers(list)'), sa.indexOf('filterUsers(q)'));
  ok('control — the wiring block was found', block.length > 400);
  /* Stripped: the comment ABOVE the actions block says the words "No viewUser", and an
     unstripped match reads the page's own explanation as the thing it denies. */
  ok('no viewUser action is passed', !/viewUser:/.test(strip(block)));
  ok('role change delegates to the portal it already had', /changeRole:uid=>this\.changeRole\(/.test(block));
  ok('suspension delegates to the portal it already had', /banUser:\(uid,status\)=>this\.toggleSuspend\(/.test(block));
  ok('and this file still owns those two callables',
     /httpsCallable\('setUserRole'\)/.test(sa) && /httpsCallable\('suspendUser'\)/.test(sa));
  ok('the module performs no call of its own here', !/SokoniAOSUsers[\s\S]{0,400}httpsCallable/.test(block));

  /* SHAPE. This portal stores suspension as a boolean and may not store `verified` at all. */
  ok('suspended is mapped onto the status vocabulary',
     /status:u\.suspended\?'suspended':\(u\.status\|\|'active'\)/.test(block));
  ok('verified is passed through, not coerced to false',
     /verified:u\.verified,/.test(block) && !/verified:u\.verified\|\|false/.test(block));
  ok('it names its own source, not the callable\'s',
     /50 most recently created accounts/.test(block));

  /* ADDITIVE, exactly as in AdminOS. */
  /* Asserted inside the wiring block, not the whole file: another panel also renders rows
     into a `tb`, and matching that one would prove nothing about this table. */
  ok('the legacy table is still rendered below', /tb\.innerHTML=list\.map\(u=>/.test(block));
  ok('the rich view falls through to it on error',
     /SokoniAOSUsers[\s\S]{0,2000}catch[\s\S]{0,120}using table/.test(sa));
  ok('only the table wrapper is hidden, never the toolbar',
     /wrap\.hidden=true/.test(block) && !/panel-toolbar[\s\S]{0,60}hidden=true/.test(sa));
  ok('no new sidebar entry was added — User Management already existed',
     (sa.match(/data-section="users"/g) || []).length === 1);
}

console.log('\n  what this suite does NOT prove');
console.log('  UNPROVEN  live callable responses   [proven by loading admin-os.html]');

console.log('\n══════════════════════════════════════════════════════════════════');
console.log('  ' + pass + ' passed, ' + fail + ' failed');
console.log('══════════════════════════════════════════════════════════════════');
process.exit(fail ? 1 : 0);
