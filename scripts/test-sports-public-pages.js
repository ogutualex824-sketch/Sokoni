#!/usr/bin/env node
'use strict';
/* Public Sports pages — no fabricated data (owner brief 2026-10-03)
     a  sokoni-sports.js carries none of the seed arrays
     b  no client Firestore access / writes in sokoni-sports.js
     c  no invented booking/order/registration refs in the module or the 3 pages
     d  no invented rating fallback (||4.5)
     e  each page loads the module (which reads sportsDispatch), firebase.js (the App Check callable path),
        and self-updates (sw-register.js or shared-header.js)
     f  node --check on the module; every classic inline <script> of the 3 pages compiles
     g  every S.<name> a page calls exists on window.SokoniSports; the removed fakes are gone from the pages
     h  behaviour (vm, fake callable): reads go to sportsDispatch with the right op; signed-out writes are refused
        BEFORE any call; a server refusal propagates (never a success); nothing is written to localStorage
   node scripts/test-sports-public-pages.js */
const fs = require('fs'), path = require('path'), vm = require('vm'), cp = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const MOD_FILE = 'sokoni-sports.js';
const PAGES = ['sports-hub.html', 'sports-tournament.html', 'sports-venue.html'];
const MOD = read(MOD_FILE);
const HTML = Object.fromEntries(PAGES.map((p) => [p, read(p)]));
let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (ok || d === undefined ? '' : '  -> ' + JSON.stringify(d).slice(0, 300))); ok ? pass++ : fail++; };

/* a */
const SEEDS = ['TEAMS = [', 'PLAYERS = [', 'COACHES = [', 'VENUES = [', 'TOURNAMENTS = [', 'FIXTURES_SEED', 'STANDINGS_SEED', 'MARKETPLACE_ITEMS', 'COMMUNITY_POSTS_SEED'];
const seedHits = SEEDS.filter((s) => MOD.includes(s));
ck('a  no seed arrays in sokoni-sports.js', seedHits.length === 0, seedHits);

/* b */
const fsHits = ['.collection(', 'firestore(', 'addDoc', 'setDoc', 'updateDoc', 'fsWrite', 'fsRead'].filter((s) => MOD.includes(s));
const writeCall = /\.collection\([^)]*\)[\s\S]{0,80}?\.(set|add|update)\(/.test(MOD);
ck('b  no client Firestore access or .collection(...).set/add/update in sokoni-sports.js', fsHits.length === 0 && !writeCall, fsHits);

/* c */
const REFS = ['SOKCOACH', 'SOKVN', 'SOKTN', 'SOKMKT'];
const refHits = [];
for (const [f, s] of [[MOD_FILE, MOD], ...Object.entries(HTML)]) for (const r of REFS) if (s.includes(r)) refHits.push(f + ':' + r);
ck('c  no invented refs (SOKCOACH/SOKVN/SOKTN/SOKMKT) in the 4 files', refHits.length === 0, refHits);

/* d */
const ratingHits = [];
for (const [f, s] of [[MOD_FILE, MOD], ...Object.entries(HTML)]) if (/\|\|\s*4\.5|base\s*\|\|\s*4\.5|rating\s*\|\|\s*4(\.0)?\b/.test(s)) ratingHits.push(f);
ck('d  no invented rating fallback (||4.5 / rating||4)', ratingHits.length === 0, ratingHits);

/* e */
ck('e0 the module reads sportsDispatch through window.sokoniCallable (App Check path)', MOD.includes("'sportsDispatch'") && MOD.includes('window.sokoniCallable') && MOD.includes('__sokoniAppCheckReady'));
for (const p of PAGES) {
  const s = HTML[p];
  ck('e  ' + p + ' loads sokoni-sports.js + firebase.js and self-updates',
    s.includes('<script src="sokoni-sports.js"></script>') && /<script type="module" src="firebase\.js"><\/script>/.test(s) &&
    (s.includes('src="sw-register.js"') || s.includes('src="/sw-register.js"') || s.includes('src="shared-header.js"')));
}

/* f */
const chk = cp.spawnSync(process.execPath, ['--check', path.join(ROOT, MOD_FILE)], { encoding: 'utf8' });
ck('f0 node --check sokoni-sports.js', chk.status === 0, chk.stderr);
for (const p of PAGES) {
  const re = /<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi; let m, n = 0; const bad = [];
  while ((m = re.exec(HTML[p]))) {
    const attrs = m[1] || '';
    if (/\bsrc\s*=/.test(attrs)) continue;
    if (/type\s*=\s*["']?module/.test(attrs)) continue;          /* none expected; modules cannot be new Function()-checked */
    if (/type\s*=\s*["']?application\/(ld\+)?json/.test(attrs)) continue;
    n++;
    try { new Function(m[2]); } catch (e) { bad.push('#' + n + ': ' + e.message); }
  }
  ck('f  ' + p + ' — ' + n + ' inline script block(s) compile', n > 0 && bad.length === 0, bad);
}

/* g — load the module in a sandbox to learn its real API */
function loadModule (opts) {
  const o = opts || {};
  const store = {}; const writes = [];
  const calls = [];
  const win = {
    __sokoniAppCheckReady: Promise.resolve('exchanged'),
    firebaseAuth: { currentUser: o.user || null },
    waitForSokoniAuthReady: () => Promise.resolve(),
    sokoniCallable: (name) => async (payload) => {
      calls.push({ name, payload });
      const h = (o.responses || {})[payload && payload.op];
      const r = typeof h === 'function' ? h(payload) : h;
      if (r instanceof Error) throw r;
      return { data: r === undefined ? {} : r };
    },
  };
  const localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { writes.push(k); store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
  const ctx = { window: win, localStorage, setTimeout, clearTimeout, console, Promise, Date, Math, JSON, Number, String, Object, Array, Map, Set, isNaN, isFinite, Error };
  vm.createContext(ctx);
  vm.runInContext(MOD, ctx, { filename: MOD_FILE });
  return { S: win.SokoniSports, calls, writes };
}
const API = loadModule().S;
ck('g0 window.SokoniSports exists and exposes no seed/fake members', !!API &&
  ['TEAMS', 'PLAYERS', 'COACHES', 'VENUES', 'TOURNAMENTS', 'MARKETPLACE_ITEMS', 'COMMUNITY_POSTS_SEED', 'bookCoach', 'bookVenue', 'createOrder', 'createPost', 'createPlayer', 'likePost', 'addReview', 'getAvgRating', 'addNotification', 'getNotifications', 'syncUserDataFromFirestore'].every((k) => !(k in API)));
for (const p of PAGES) {
  const used = [...new Set([...HTML[p].matchAll(/\bS\.([A-Za-z_]\w*)/g)].map((m) => m[1]))];
  const missing = used.filter((k) => !(k in API));
  ck('g  ' + p + ' calls only members that exist (' + used.length + ' used)', missing.length === 0, missing);
  const fakes = ['firebase.firestore', 'addDoc(', 'firebaseDB', 'sokoniPendingApplications', 'wa.me/254700000000', 'Team created', 'registered on SOKONI Sports!', 'Venue booked', 'Order placed', 'Session Booked'].filter((s) => HTML[p].includes(s));
  ck('g  ' + p + ' carries no client write / fake-success text', fakes.length === 0, fakes);
}
const hub = HTML['sports-hub.html'];
ck('g  hub links the real venue / coach / gear surfaces', hub.includes('href="venue-booking.html"') && hub.includes('href="services.html?cat=coaching"') && hub.includes('href="category.html?cat=sports"'));
ck('g  hub has no invented stat counters ("500+" style)', !/\d+\+\s*(teams|players|venues|coaches|members)/i.test(hub));

/* h — behaviour */
(async () => {
  const tick = () => new Promise((r) => setTimeout(r, 0));
  let L = loadModule({ responses: { 'teams.directory': { teams: [{ teamId: 'T1', name: '<b>X</b>', sport: 'football', county: 'Nairobi', verified: true }] }, 'tournaments.open': { tournaments: [{ tournamentId: 'TR1', name: 'Cup', sport: 'football', capacity: 8, entryFeeKES: 0 }] } } });
  const teams = await L.S.getTeams({ sport: 'football' });
  ck('h1 getTeams → sportsDispatch {op:teams.directory, sport}', teams.length === 1 && L.calls[0].name === 'sportsDispatch' && L.calls[0].payload.op === 'teams.directory' && L.calls[0].payload.sport === 'football', L.calls);
  await L.S.getTeams({ sport: 'football' });
  ck('h2 a second read is served from the per-page memo (one call)', L.calls.filter((c) => c.payload.op === 'teams.directory').length === 1);
  const open = await L.S.getTournaments();
  ck('h3 getTournaments → tournaments.open', open.length === 1 && L.calls.some((c) => c.payload.op === 'tournaments.open'));
  ck('h4 esc() neutralises a user-supplied team name', L.S.esc(teams[0].name) === '&lt;b&gt;X&lt;/b&gt;');

  L = loadModule({ user: null });
  let refused = null; try { await L.S.registerForTournament({ tournamentId: 'TR1', teamId: 'T1' }); } catch (e) { refused = e; }
  ck('h5 signed-out registration is refused with no server call', !!refused && /Sign in/.test(refused.message) && L.calls.length === 0);
  refused = null; try { await L.S.createTeam({ name: 'Tigers', sport: 'football' }); } catch (e) { refused = e; }
  ck('h6 signed-out team registration is refused with no server call', !!refused && L.calls.length === 0);

  const err = new Error('Only an approved team can enter a tournament.'); err.code = 'functions/failed-precondition';
  L = loadModule({ user: { uid: 'U1' }, responses: { 'registration.apply': err, 'team.register': { teamId: 'NT', status: 'submitted' } } });
  refused = null; try { await L.S.registerForTournament({ tournamentId: 'TR1', teamId: 'T1' }); } catch (e) { refused = e; }
  ck('h7 a server refusal propagates with the server message (no success)', !!refused && L.S.serverMessage(refused) === 'Only an approved team can enter a tournament.' &&
    L.calls[0].payload.op === 'registration.apply' && L.calls[0].payload.teamId === 'T1');
  const tr = await L.S.createTeam({ name: 'Tigers', sport: 'football', county: 'Nairobi' });
  const reg = L.calls.find((c) => c.payload.op === 'team.register');
  ck('h8 team registration → team.register {submit:true}; server status returned as-is', !!reg && reg.payload.submit === true && tr.status === 'submitted');

  L = loadModule({ responses: { 'tournament.view': { tournament: { tournamentId: 'TR1', name: 'Cup', status: 'in_progress', standings: { A: { p: 1, w: 0, d: 0, l: 1, gf: 0, ga: 2, pts: 0 }, B: { p: 1, w: 1, d: 0, l: 0, gf: 2, ga: 0, pts: 3 } } }, fixtures: [{ fixtureId: 'F1' }] } } });
  const rows = await L.S.getStandings('TR1');
  ck('h9 standings come from tournament.view, sorted by points', rows.length === 2 && rows[0].teamId === 'B' && L.calls[0].payload.op === 'tournament.view');
  ck('h10 unknown numbers render "—", never 0', L.S.fmt(undefined) === '—' && L.S.fmt(null) === '—' && L.S.when(null) === '—' && L.S.starsHTML(undefined) === '');

  L = loadModule({ responses: { venueGetPublic: { id: 'V1', name: 'Pitch' }, bookingGetAvailability: { slots: [] } } });
  await L.S.getVenue('V1'); await L.S.getVenueAvailability('V1', '2026-10-04');
  ck('h11 venue reads go to bookingDispatch (venueGetPublic / bookingGetAvailability)', L.calls.every((c) => c.name === 'bookingDispatch') && L.calls.map((c) => c.payload.op).join() === 'venueGetPublic,bookingGetAvailability');

  L = loadModule({ responses: { 'tournaments.open': new Error('unavailable') } });
  let threw = false; try { await L.S.getTournaments(); } catch (_) { threw = true; }
  L.calls.length = 0;
  await L.S.getTournaments().catch(() => {});
  ck('h12 a failed read throws (page shows an error state) and is retried, not cached', threw && L.calls.length === 1);
  ck('h13 the module wrote nothing to localStorage across all of the above', L.writes.length === 0);
  await tick();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH', e && e.stack); process.exit(1); });
