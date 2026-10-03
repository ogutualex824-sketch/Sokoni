#!/usr/bin/env node
'use strict';
/* Merchant-v2 Sports workspace (sokoni-merchant-sports.js) — owner 2026-10-03
     W1  wiring: five sports-* routes in ONE 'Sports' group, appended last; five MODULES → SokoniMerchantSports; script loaded
     W2  only sportsDispatch (via ctx.dispatch) — no Firestore, no fetch, no localStorage
     W3  role-aware from the SERVER answer: a player sees invitations / matches; a captain sees invite + submit; an organiser sees
         the next lifecycle action; nobody sees organiser buttons without organising
     W4  a load failure is labelled as NOT an empty account; every field is escaped
     W5  an action calls the right op with the right ids, then reloads; a refusal says "Not changed"
   node scripts/test-merchant-sports.js */
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'sokoni-merchant-sports.js'), 'utf8');
const ROUTES = fs.readFileSync(path.join(ROOT, 'sokoni-merchant-routes.js'), 'utf8');
const MV2 = fs.readFileSync(path.join(ROOT, 'merchant-v2.html'), 'utf8');
let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (ok || d === undefined ? '' : '  -> ' + JSON.stringify(d).slice(0, 200))); ok ? pass++ : fail++; };

const ids = ['sports-overview', 'sports-team', 'sports-fixtures', 'sports-tournaments', 'sports-organise'];
ck('W1 five sports routes, ONE Sports group (last), five MODULES, script loaded',
  ids.every((id) => ROUTES.includes("id:'" + id + "'") && MV2.includes("'" + id + "':")) && /\{ key:'sports',\s+label:'Sports',/.test(ROUTES)
  && MV2.includes('<script src="sokoni-merchant-sports.js"></script>') && /_callable\('sportsDispatch'\)/.test(MV2));
ck('W2 the module never touches Firestore / fetch / localStorage', !/firestore|fetch\(|localStorage/.test(SRC.replace(/\/\*[\s\S]*?\*\//g, '')));

const ctxWin = {}; const ctx = { window: ctxWin }; vm.createContext(ctx); vm.runInContext(SRC, ctx);
const M = ctxWin.SokoniMerchantSports;
function host () { const h = { innerHTML: '', _h: {}, addEventListener (t, f) { h._h[t] = f; }, removeEventListener () {} }; return h; }
const tick = () => new Promise((r) => setTimeout(r, 0));
async function mounted (view, answers, calls) {
  const h = host();
  const dispatch = async (d) => { calls && calls.push(d); const a = answers[d.op]; if (a instanceof Error) throw a; return { data: typeof a === 'function' ? a(d) : a }; };
  const ui = M.mount(h, { view, dispatch });
  await tick(); await tick();
  return { h, ui };
}
const PLAYER = { ok: true, roles: { player: true, captain: false, organiser: false }, teams: [{ teamId: 'T1', name: 'Lions <b>FC</b>', sport: 'football', status: 'approved', verification: 'verified', myStatus: 'active', myRole: 'player' },
  { teamId: 'T9', name: 'Eagles', sport: 'football', status: 'approved', myStatus: 'invited', myRole: 'player' }], invitations: [{ teamId: 'T9', name: 'Eagles', sport: 'football' }],
  organising: [], registrations: [], fixtures: [{ fixtureId: 'F1', homeTeamId: 'T1', awayTeamId: 'T2', startsAt: Date.parse('2026-11-16T15:00:00Z'), status: 'scheduled' }] };
const CAPTAIN = Object.assign({}, PLAYER, { roles: { player: true, captain: true, organiser: false }, teams: [{ teamId: 'T1', name: 'Lions', sport: 'football', status: 'approved', myStatus: 'active', myRole: 'captain' }], invitations: [] });
const ORG = Object.assign({}, PLAYER, { roles: { player: false, captain: false, organiser: true }, teams: [], invitations: [], fixtures: [],
  organising: [{ tournamentId: 'TR1', name: 'Cup', sport: 'football', status: 'approved' }, { tournamentId: 'TR2', name: 'League', sport: 'football', status: 'registration_closed' }] });

(async () => {
  let m = await mounted('overview', { 'me.overview': PLAYER });
  ck('W3a player overview: Player chip, invitation with Accept, upcoming match; no organiser actions', /Player/.test(m.h.innerHTML) && /data-sp="accept" data-team="T9"/.test(m.h.innerHTML)
    && /Lions &lt;b&gt;FC&lt;\/b&gt; vs/.test(m.h.innerHTML) && !/data-sp="t-next"/.test(m.h.innerHTML));
  m = await mounted('team', { 'me.overview': CAPTAIN });
  ck('W3b captain team view: invite form on the approved team', /data-sp-form="invite" data-team="T1"/.test(m.h.innerHTML));
  m = await mounted('team', { 'me.overview': PLAYER });
  ck('W3c a plain player gets NO invite form', !/data-sp-form="invite"/.test(m.h.innerHTML));
  m = await mounted('organise', { 'me.overview': ORG });
  ck('W3d organiser: "Open registration" for an approved cup; "Publish fixtures" for a closed one', /data-to="registration_open" data-tournament="TR1"/.test(m.h.innerHTML) && /data-sp="publish" data-tournament="TR2"/.test(m.h.innerHTML));
  m = await mounted('organise', { 'me.overview': PLAYER });
  ck('W3e a non-organiser sees no lifecycle buttons', !/data-sp="t-next"|data-sp="publish"/.test(m.h.innerHTML));
  m = await mounted('overview', { 'me.overview': new Error('functions/unavailable: down') });
  ck('W4 a failed load says it is NOT an empty account', /This is not an empty account/.test(m.h.innerHTML));
  const calls = [];
  m = await mounted('overview', { 'me.overview': PLAYER, 'team.respond': { ok: true } }, calls);
  await m.h._h.click({ target: { closest: () => ({ getAttribute: (k) => ({ 'data-sp': 'accept', 'data-team': 'T9' })[k] || null }) } });
  await tick(); await tick();
  ck('W5a Accept → team.respond {teamId T9, accept true}, then reloads me.overview', calls.some((c) => c.op === 'team.respond' && c.teamId === 'T9' && c.accept === true) && calls.filter((c) => c.op === 'me.overview').length >= 2, calls);
  const calls2 = [];
  m = await mounted('organise', { 'me.overview': ORG, 'tournament.transition': new Error('failed-precondition: A approved tournament cannot move to x.') }, calls2);
  await m.h._h.click({ target: { closest: () => ({ getAttribute: (k) => ({ 'data-sp': 't-next', 'data-to': 'registration_open', 'data-tournament': 'TR1' })[k] || null }) } });
  await tick(); await tick();
  ck('W5b a server refusal is shown as "Not changed"', /Not changed:/.test(m.h.innerHTML));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH', e && e.stack); process.exit(1); });
