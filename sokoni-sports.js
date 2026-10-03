/* ============================================================
   SOKONI SPORTS HUB — sokoni-sports.js
   window.SokoniSports IIFE module (public Sports pages)

   DATA INTEGRITY (owner brief 2026-10-03): every business record on the public Sports pages comes
   from the server. There is NO seed data, NO localStorage fallback for business records, and NO
   client Firestore write in this module.

   SERVER AUTHORITIES (read through firebase.js's window.sokoniCallable, App Check attached):
     sportsDispatch  teams.directory {sport?,county?}         public
                     tournaments.open {sport?}                 public
                     tournament.view {tournamentId}            public
                     me.overview                               signed-in
                     registration.apply {tournamentId,teamId}  signed-in (captain/manager of an approved team)
                     team.register {name,sport,county?,category?,submit:true}  signed-in → awaits admin review
     bookingDispatch venueGetPublic {venueId} · bookingGetAvailability {venueId,date}   (read-only here;
                     booking itself happens on venue-booking.html, the real venue engine)

   NO SERVER AUTHORITY on this line → neutral state on the pages, no writes:
     players, community posts, sports-gear listings (linked to the marketplace), coach list (linked to
     the provider directory), reviews, notifications (server-sent elsewhere).

   Unknown is '—', never 0. Success is only reported after the server call resolves.
============================================================ */
;(function(){
'use strict';

/* ── SPORT CATEGORIES — a static taxonomy (labels / icons / colours), NOT business data ── */
const SPORT_CATEGORIES = [
  {id:'all',        label:'All Sports',    icon:'🏆', color:'#f59e0b'},
  {id:'football',   label:'Football',      icon:'⚽', color:'#22c55e'},
  {id:'basketball', label:'Basketball',    icon:'🏀', color:'#f97316'},
  {id:'rugby',      label:'Rugby',         icon:'🏉', color:'#a8ff58'},
  {id:'athletics',  label:'Athletics',     icon:'🏃', color:'#06b6d4'},
  {id:'swimming',   label:'Swimming',      icon:'🏊', color:'#3b82f6'},
  {id:'boxing',     label:'Boxing / MMA',  icon:'🥊', color:'#ef4444'},
  {id:'volleyball', label:'Volleyball',    icon:'🏐', color:'#ec4899'},
  {id:'cricket',    label:'Cricket',       icon:'🏏', color:'#84cc16'},
  {id:'tennis',     label:'Tennis',        icon:'🎾', color:'#eab308'},
  {id:'golf',       label:'Golf',          icon:'⛳', color:'#10b981'},
  {id:'cycling',    label:'Cycling',       icon:'🚴', color:'#f59e0b'},
];

/* ── LINKS to the real surfaces that own what this hub does not ── */
const LINKS = Object.freeze({
  venues:  'venue-booking.html',          /* the venue engine: search, availability, booking (bookingDispatch) */
  coaches: 'services.html?cat=coaching',  /* the provider directory, coaching category */
  gear:    'category.html?cat=sports',    /* the canonical marketplace, Sports & Fitness category */
  myTeam:  'merchant-v2.html',            /* Sports workspace (My team / Fixtures / Tournaments) */
});

/* ── HELPERS ── */
function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]; }); }
function _sleep(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }
function _viewerKey(){ try { return JSON.parse(localStorage.getItem('sokoniUser') || '{}').uid || 'guest'; } catch(e){ return 'guest'; } }

/* firebase.js (a deferred module) publishes window.sokoniCallable and window.__sokoniAppCheckReady a
   moment after classic scripts run. Poll for the callable (bounded), then await the App Check token so
   every request carries it (sportsDispatch / bookingDispatch both enforce App Check). */
async function _callable(name){
  for (let i = 0; i < 100 && typeof window.sokoniCallable !== 'function'; i++) await _sleep(100);
  if (typeof window.sokoniCallable !== 'function') throw new Error('SOKONI is still starting up. Try again in a moment.');
  if (window.__sokoniAppCheckReady) { try { await window.__sokoniAppCheckReady; } catch(_){} }
  return window.sokoniCallable(name);
}
async function _call(name, payload){
  const fn = await _callable(name);
  const res = await fn(payload || {});
  return (res && res.data !== undefined) ? res.data : res;
}
function sports(op, data){ return _call('sportsDispatch', Object.assign({}, data || {}, {op: op})); }
function booking(op, data){ return _call('bookingDispatch', Object.assign({}, data || {}, {op: op})); }

/* The signed-in Firebase user, or null. Waits (bounded) for firebase.js's auth-ready signal. */
async function currentUser(){
  for (let i = 0; i < 100 && !window.firebaseAuth; i++) await _sleep(100);
  if (!window.firebaseAuth) return null;
  if (typeof window.waitForSokoniAuthReady === 'function') {
    try { await Promise.race([window.waitForSokoniAuthReady(), _sleep(8000)]); } catch(_){}
  }
  return window.firebaseAuth.currentUser || null;
}

/* A human message from an HttpsError (the server writes them for people), never a stack trace. */
function serverMessage(e){
  const m = e && e.message ? String(e.message).replace(/^(FirebaseError|Error):\s*/i, '').trim() : '';
  return m || 'That could not be completed. Nothing was changed.';
}

/* Per-page-load memo. A failed read is NOT cached, so "try again" really retries. */
const _memo = new Map();
function _cached(key, fn){
  if (_memo.has(key)) return _memo.get(key);
  const p = Promise.resolve().then(fn);
  _memo.set(key, p);
  p.catch(function(){ _memo.delete(key); });
  return p;
}
function clearCache(){ _memo.clear(); }

/* ══ TEAMS (teams.directory — approved, active teams; safe fields only) ══ */
async function getTeams(filter){
  const f = filter || {};
  const sport = f.sport && f.sport !== 'all' ? String(f.sport) : '';
  const r = await _cached('teams|' + sport, function(){ return sports('teams.directory', sport ? {sport: sport} : {}); });
  let list = (r && Array.isArray(r.teams)) ? r.teams.slice() : [];
  if (f.county) { const c = String(f.county).toLowerCase(); list = list.filter(function(t){ return String(t.county || '').toLowerCase().includes(c); }); }
  if (f.q) { const q = String(f.q).toLowerCase(); list = list.filter(function(t){ return [t.name, t.sport, t.county, t.category].join(' ').toLowerCase().includes(q); }); }
  return list;
}
async function getTeamById(id){ const all = await getTeams(); return all.find(function(t){ return t.teamId === id; }) || null; }
/* teamId → name map for fixtures/standings (unknown ids render as a short neutral label, never invented). */
async function teamNameMap(){
  try { const all = await getTeams(); const m = {}; all.forEach(function(t){ m[t.teamId] = t.name; }); return m; }
  catch(_){ return {}; }
}
function teamLabel(map, id){ return (map && map[id]) || ('Team ' + String(id || '—').slice(0, 6)); }

/* Signed-in: register a team. The server creates it as SUBMITTED; it goes live only after admin approval. */
async function createTeam(data){
  const u = await currentUser();
  if (!u) { const e = new Error('Sign in to register a team.'); e.code = 'unauthenticated'; throw e; }
  const d = data || {};
  const r = await sports('team.register', { name: d.name, sport: d.sport, county: d.county || undefined, category: d.category || undefined, submit: true });
  clearCache();
  return r;
}

/* ══ TOURNAMENTS ══ */
async function getTournaments(filter){
  const f = filter || {};
  const sport = f.sport && f.sport !== 'all' ? String(f.sport) : '';
  const r = await _cached('open|' + sport, function(){ return sports('tournaments.open', sport ? {sport: sport} : {}); });
  return (r && Array.isArray(r.tournaments)) ? r.tournaments.slice() : [];
}
/* {tournament, fixtures} from tournament.view — throws the server's error (not-found / not public yet). */
function getTournamentView(id){
  return _cached('view|' + id, function(){ return sports('tournament.view', {tournamentId: String(id || '')}); });
}
async function getTournamentById(id){ const v = await getTournamentView(id); return v && v.tournament ? v.tournament : null; }
/* Registration facts (capacity, entry fee, deadlines) exist only while the tournament is open. */
async function getOpenTournament(id){ const open = await getTournaments(); return open.find(function(t){ return t.tournamentId === id; }) || null; }
async function getFixtures(id){ const v = await getTournamentView(id); return (v && Array.isArray(v.fixtures)) ? v.fixtures : []; }
async function getStandings(id){
  const t = await getTournamentById(id);
  const s = (t && t.standings) || {};
  return Object.keys(s).map(function(k){ return Object.assign({teamId: k}, s[k]); })
    .sort(function(a, b){ return ((b.pts || 0) - (a.pts || 0)) || (((b.gf || 0) - (b.ga || 0)) - ((a.gf || 0) - (a.ga || 0))); });
}

/* Signed-in: the viewer's server-derived Sports roles/teams (null when signed out). */
async function getMyOverview(){
  const u = await currentUser();
  if (!u) return null;
  return _cached('me|' + u.uid, function(){ return sports('me.overview'); });
}
/* Teams this viewer captains/manages that are approved for this sport — the only teams the server will accept. */
async function getEligibleTeams(sport){
  const me = await getMyOverview();
  if (!me) return null;
  return (me.teams || []).filter(function(t){ return (t.myRole === 'captain' || t.myRole === 'manager') && t.status === 'approved' && (!sport || t.sport === sport); });
}

/* Signed-in: apply to an open tournament. Resolves only when the server accepted it. */
async function registerForTournament(data){
  const u = await currentUser();
  if (!u) { const e = new Error('Sign in to register your team.'); e.code = 'unauthenticated'; throw e; }
  const d = data || {};
  const r = await sports('registration.apply', { tournamentId: d.tournamentId, teamId: d.teamId });
  clearCache();
  return r;
}

/* ══ VENUES (read-only; booking happens on venue-booking.html) ══ */
function getVenue(venueId){ return _cached('venue|' + venueId, function(){ return booking('venueGetPublic', {venueId: String(venueId || '')}); }); }
function getVenueAvailability(venueId, date){
  return _cached('avail|' + venueId + '|' + date, function(){ return booking('bookingGetAvailability', {venueId: String(venueId || ''), date: date}); });
}

/* ══ SAVED (a per-viewer convenience — not business data) ══ */
function saveItem(type, id){
  try {
    const key = 'spt_saved_' + type + '_' + _viewerKey(); const arr = JSON.parse(localStorage.getItem(key) || '[]');
    if (arr.includes(id)) { localStorage.setItem(key, JSON.stringify(arr.filter(function(x){ return x !== id; }))); return false; }
    arr.unshift(id); localStorage.setItem(key, JSON.stringify(arr.slice(0, 100))); return true;
  } catch(e){ return false; }
}
function isSaved(type, id){ try { return JSON.parse(localStorage.getItem('spt_saved_' + type + '_' + _viewerKey()) || '[]').includes(id); } catch(e){ return false; } }

/* ══ UTILS ══ */
function fmt(n){ return (n == null || n === '' || isNaN(Number(n))) ? '—' : Number(n).toLocaleString('en-KE'); }
function when(ms){ if (!ms) return '—'; const d = new Date(typeof ms === 'object' && ms && ms._seconds ? ms._seconds * 1000 : Number(ms)); return isNaN(d.getTime()) ? '—' : d.toLocaleString('en-KE', {dateStyle: 'medium', timeStyle: 'short'}); }
function whenDate(ms){ if (!ms) return '—'; const d = new Date(typeof ms === 'object' && ms && ms._seconds ? ms._seconds * 1000 : Number(ms)); return isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-KE', {dateStyle: 'medium'}); }
function timeSince(ts){ const d = Date.now() - ts; const m = Math.floor(d / 60000); if (m < 1) return 'Just now'; if (m < 60) return m + 'm ago'; if (m < 1440) return Math.floor(m / 60) + 'h ago'; return Math.floor(m / 1440) + 'd ago'; }
function starsHTML(r){ const n = Number(r); if (!isFinite(n) || n <= 0) return ''; return [1,2,3,4,5].map(function(i){ return '<span style="color:' + (i <= Math.round(n) ? '#f59e0b' : 'rgba(255,255,255,0.15)') + '">★</span>'; }).join(''); }
function sportColor(sport){ const c = SPORT_CATEGORIES.find(function(s){ return s.id === sport; }); return c ? c.color : '#f59e0b'; }
function sportIcon(sport){ const c = SPORT_CATEGORIES.find(function(s){ return s.id === sport; }); return c ? c.icon : '🏆'; }
/* Server tournament/fixture statuses → label + colour. */
function statusBadge(status){
  const m = {
    registration_open:{l:'Registration Open',c:'#00aaff'}, registration_closed:{l:'Registration Closed',c:'#f59e0b'},
    fixtures_published:{l:'Fixtures Published',c:'#f59e0b'}, approved:{l:'Upcoming',c:'#f59e0b'},
    in_progress:{l:'In Progress',c:'#22c55e'}, completed:{l:'Completed',c:'rgba(255,255,255,0.4)'}, archived:{l:'Archived',c:'rgba(255,255,255,0.4)'},
    scheduled:{l:'Scheduled',c:'#f59e0b'}, confirmed:{l:'Confirmed',c:'#f59e0b'}, live:{l:'Live',c:'#22c55e'},
    postponed:{l:'Postponed',c:'#f97316'}, cancelled:{l:'Cancelled',c:'#ef4444'},
  };
  return m[status] || {l: String(status || '—').replace(/_/g, ' '), c: 'white'};
}

/* ── PUBLIC API ── */
window.SokoniSports = {
  SPORT_CATEGORIES, LINKS,
  getTeams, getTeamById, teamNameMap, teamLabel, createTeam,
  getTournaments, getTournamentView, getTournamentById, getOpenTournament, getFixtures, getStandings,
  getMyOverview, getEligibleTeams, registerForTournament,
  getVenue, getVenueAvailability,
  saveItem, isSaved,
  currentUser, serverMessage, clearCache,
  esc, fmt, when, whenDate, timeSince, starsHTML, sportColor, sportIcon, statusBadge,
};
})();
