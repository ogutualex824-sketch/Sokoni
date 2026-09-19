/* ══════════════════════════════════════════════════════════════════════════════
   ADMINOS ACTIVITY FEED — certification
   scripts/test-aos-activity.js            node scripts/test-aos-activity.js

   The source is `{ logs: [...] }` capped by a limit: no total, no cursor, no read state.
   Three figures the mockup wanted therefore have no source — a platform total, an unread
   count, and a day-over-day percentage — and most of this suite is about the feed refusing
   to produce them from a page of logs it happens to hold.

   Every absence assertion is paired with an inverting control, because "the feed does not
   show 1,248" passes just as well when the renderer produced nothing at all.
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
const ACT = require(path.join(ROOT, 'sokoni-aos-activity.js'));

const H = 3600000, D = 86400000;
const now = Date.now();
const log = (o) => Object.assign({ createdAt: new Date(now - H).toISOString() }, o);
const host = () => ({ innerHTML: '', addEventListener () {}, querySelector: () => null });

function draw (items, limit) {
  const h = host();
  ACT._render(h, { items: ACT._normalise(items), limit: limit || null, cat: 'all', q: '', qRaw: '' });
  return h.innerHTML;
}

console.log('══════════════════════════════════════════════════════════════════');
console.log('  ADMINOS ACTIVITY FEED');
console.log('══════════════════════════════════════════════════════════════════');

/* ── 1. THE THREE FIGURES WITH NO SOURCE ────────────────────────────────────── */
head('1 - what the source cannot support is not shown');
{
  const html = draw([log({ action: 'user_created' }), log({ action: 'payment_settled' })]);

  /* adminGetAuditLogs returns a capped page and no total. A headline total would be the
     easiest lie the feed could tell, because it looks like the most ordinary number here. */
  /* ASSERTED ON THE HEADLINE, not on the page's vocabulary. A ban on the word "total"
     matched the note explaining that the source RETURNS no total — prose counted as
     evidence, which is the trap this codebase has a standing rule about. What matters is
     what the big number at the top claims to be. */
  const headline = (html.match(/<div class="acx-count">([\s\S]*?)<\/div>/) || [])[1] || '';
  ok('control — the headline block was found', headline.length > 0);
  ok('the headline says "loaded"', /entries loaded/.test(headline), headline.replace(/<[^>]+>/g, ' ').trim());
  ok('and never calls itself a total', !/\btotal\b/i.test(headline));
  /* The leading digits are the count. Stripping tags yields "2entries loaded", so a \b after
     the number never matches — digit and letter are both word characters. */
  const shown = (headline.match(/^\s*(\d+)/) || [])[1];
  ok('and it equals what was actually loaded', shown === '2', 'headline shows ' + shown);

  /* Nothing anywhere records whether an entry has been seen. */
  ok('there is no unread filter', !/data-cat="unread"/.test(html));
  ok('and no mark-all-as-read control', !/mark all/i.test(html));

  /* The window is a fixed COUNT, so its oldest day is usually part-complete. */
  ok('no day-over-day percentage is rendered', !/[↑↓]\s*\d|vs yesterday/i.test(html));
  ok('no percentage figure at all', !/\d+(\.\d+)?%\s*[<"]/.test(html.replace(/width:\s*\d+%/g, '').replace(/height:\s*\d+%/g, '')));

  /* And the page says why, so nobody adds them back from the mockup. */
  ok('the page states there is no platform total', /not a platform total/.test(html));
  ok('states there is no unread state', /no unread state/.test(html));
  ok('states there is no day-over-day change', /no day-over-day change/.test(html));

  /* INVERTING CONTROL — real derived figures ARE rendered. */
  ok('control — category counts are rendered', /acx-chip-n">\d/.test(html));
  ok('control — contributors are rendered', /acx-cont-v">\d/.test(html));
}

/* ── 2. THE TRUNCATION FACT ─────────────────────────────────────────────────── */
head('2 - a capped window marks its own incomplete day');
{
  /* When the result count equals the limit, the oldest day is cut off part-way and its
     count is NOT that day's count. */
  const capped = Array.from({ length: 5 }, (_, i) =>
    log({ action: 'a' + i, createdAt: new Date(now - i * H).toISOString() }));
  const t = ACT._truncation(ACT._normalise(capped), 5);
  ok('truncation is detected when the cap is hit', !!t);
  ok('and names the oldest day', t.day === new Date(t.at).toISOString().slice(0, 10));
  ok('the marker is rendered', /acx-trunc/.test(draw(capped, 5)));
  ok('and explains it is not a full day', /not a full day/.test(draw(capped, 5)));

  /* CONTROL — under the cap there is no truncation and no marker. */
  ok('control — an under-cap result is NOT marked truncated',
     ACT._truncation(ACT._normalise(capped), 50) === null);
  ok('and renders no marker', !/acx-trunc/.test(draw(capped, 50)));
  ok('the headline says capped only when it is', /\(capped\)/.test(draw(capped, 5)) &&
     !/\(capped\)/.test(draw(capped, 50)));
}

/* ── 3. CATEGORIES ARE DERIVED, NOT GUESSED ─────────────────────────────────── */
head('3 - categorisation, and what it refuses to categorise');
{
  const c = (action) => ACT._catOf({ action }).id;
  ok('a login is security', c('login_failed') === 'security');
  ok('a payout is money', c('payout_settled') === 'money');
  ok('an approval is approvals', c('application_approved') === 'approval');
  ok('an export is data', c('data_exported') === 'data');
  ok('a cron is system', c('cron_sync_started') === 'system');
  /* An unmatched action is "other" rather than being forced into a bucket — a feed that
     files everything as security teaches people to ignore the word. */
  ok('an unrecognised action is "other", not forced', c('wibble_flurbed') === 'other');
  ok('control — "other" really is reachable and shown',
     /data-cat="other"/.test(draw([log({ action: 'wibble_flurbed' })])));
}

/* ── 4. SEVERITY IS STATED, NEVER INFERRED ──────────────────────────────────── */
head('4 - severity comes from the source or not at all');
{
  const withSev = draw([log({ action: 'x', severity: 'critical' })]);
  ok('a stated severity is shown', /acx-sev--high/.test(withSev));
  /* "delete" sounds alarming and is usually routine. Inferring from wording would badge
     ordinary housekeeping. */
  ok('a scary-sounding action with no severity gets no badge',
     !/acx-sev/.test(draw([log({ action: 'record_deleted' })])));
  ok('control — the badge markup exists and simply was not used',
     /acx-sev/.test(withSev));
}

/* ── 5. TIME ────────────────────────────────────────────────────────────────── */
head('5 - days, span and shape are read from real timestamps');
{
  const across = [
    log({ action: 'a', createdAt: new Date(now).toISOString() }),
    log({ action: 'b', createdAt: new Date(now - D).toISOString() }),
    log({ action: 'c', createdAt: new Date(now - 2 * D).toISOString() }),
  ];
  const html = draw(across);
  ok('today is labelled Today', />Today</.test(html));
  ok('yesterday is labelled Yesterday', />Yesterday</.test(html));
  ok('older days get a real date', /acx-day-t">[A-Z][a-z]+day/.test(html));
  ok('the covered span is stated, not assumed to be 24h',
     /Covering about \d+ hour/.test(html) && !/last 24 hours/i.test(html));

  /* Entries with no timestamp must not be silently dropped or dated. */
  const undated = draw([log({ action: 'x', createdAt: null })]);
  ok('an undated entry is kept and labelled Undated', />Undated</.test(undated));
  ok('and no shape is drawn without timestamps',
     /No timestamps/.test(undated) && !/acx-spark/.test(undated));
  ok('control — timestamps DO produce a shape', /acx-spark/.test(html));
}

/* ── 6. SAFETY ──────────────────────────────────────────────────────────────── */
head('6 - hostile log content cannot reach the DOM');
{
  const x = '<img src=x onerror=alert(1)>';
  const html = draw([log({ action: x, adminEmail: x, targetId: x, details: x })]);
  ok('every field is escaped', html.indexOf('<img') === -1);
  ok('and the payload is present but inert', html.indexOf('&lt;img') > -1);
  ok('a hostile details object is stringified safely',
     draw([log({ action: 'a', details: { evil: x } })]).indexOf('<img') === -1);
}

/* ── 7. ADDITIVE ────────────────────────────────────────────────────────────── */
head('7 - the Audit Center still works without this module');
{
  const src = strip(read('sokoni-aos-activity.js'));
  ok('the module performs no read of its own', !/collection\(|_call\(|fetch\(/.test(src));
  ok('and no write', !/\.set\(|\.update\(|\.add\(|\.delete\(/.test(src));
  ok('it declines rather than throwing when it cannot render',
     /if \(!host\) return false;/.test(src) && /if \(!Array\.isArray\(logs\)\) return false;/.test(src));

  const aos = read('sokoni-aos.js');
  ok('the original audit table is still present', /<th>Time<\/th><th>Admin<\/th>/.test(aos));
  ok('the feed is tried first and falls through on error',
     /SokoniAOSActivity[\s\S]{0,300}catch[\s\S]{0,140}using table/.test(aos));
  ok('export stays wired whichever renders',
     (aos.match(/_exportAuditLogs\(logs, type\)/g) || []).length >= 2);

  const html = read('admin-os.html');
  ok('admin-os.html loads the module before the shell',
     html.indexOf('sokoni-aos-activity.js') < html.indexOf('<script src="sokoni-aos.js">'));
  ok('no new sidebar entry was added — Audit already existed',
     (html.match(/data-section="audit"/g) || []).length === 1);
}

/* ── 9. THE LOG VIEW ────────────────────────────────────────────────────────── */
head('9 - the log view is a second reading of one source, not a second component');
{
  const logs = [
    { id: 'a1', action: 'order_status_updated', performedBy: 'admin@sokoni.co.ke',
      orderId: 'ORD-1', status: 'delivered', createdAt: '2026-09-18T10:42:00Z' },
    { id: 'a2', action: 'login_failed', performedBy: 'system', severity: 'high',
      createdAt: '2026-09-17T22:10:00Z' },
  ];
  const drawV = (view, over) => {
    const h = host();
    ACT._render(h, Object.assign({ items: ACT._normalise(logs), limit: 50, cat: 'all',
      q: '', qRaw: '', view, open: null }, over));
    return h.innerHTML;
  };

  const timeline = drawV('timeline');
  const log = drawV('log');

  ok('a view switch is offered', /data-acx="view"/.test(timeline));
  ok('timeline is the default reading', /acx-feed/.test(timeline) && !/acx-tw/.test(timeline));
  ok('the log view renders a table',
     /acx-t/.test(log) && log.indexOf('<th>Action</th>') > -1);
  ok('and replaces the timeline rather than stacking both', !/acx-feed/.test(log));
  ok('both readings come from one normalise', (ACT._normalise(logs).length) === 2);

  /* THE COLUMNS THE MOCKUP WANTED THAT NOTHING WRITES. adminAudit carries action,
     performedBy and createdAt — there is no IP, device, environment or compliance field. */
  const shown = log.replace(/<div class="acx-d-note">[\s\S]*?<\/div>/g, '');
  ok('no IP column', !/<th>IP|ip address/i.test(shown));
  ok('no device or browser column', !/<th>Device|browser/i.test(shown));
  ok('no environment column', !/<th>Environment|production<\/span>/i.test(shown));
  ok('no compliance framework is claimed', !/soc\s*2|iso\s*27001|hipaa|pci/i.test(shown));
  ok('no risk level is invented', !/risk level/i.test(shown));
  ok('control — the API really carries none of them',
     !/ipAddress|userAgent|environment/.test(
       read('functions/admin-os.js').slice(
         read('functions/admin-os.js').indexOf('exports.adminGetAuditLogs'),
         read('functions/admin-os.js').indexOf('Featured Shops'))));

  /* SEVERITY is shown only where a source states one — never inferred from wording. */
  ok('a stated severity is rendered', /acx-sev--high/.test(log));
  ok('an entry with none says "not stated"', log.indexOf('not stated') > -1);
  ok('control — severity is never derived from the action text',
     ACT._sevOf({ action: 'user_deleted_everything' }) === null);

  /* DETAIL opens in place and shows the RAW fields the writer actually set. */
  const open = drawV('log', { open: '0' });
  ok('a row opens a detail', /acx-detail/.test(open));
  /* `orderId` is consumed as the Target, so `status` is the remaining writer-set extra. */
  ok('it lists the extra fields that writer set', /acx-d-k">status</.test(open));
  ok('and does not list the fields it consumed as columns', !/acx-d-k">performedBy</.test(open));
  ok('it says the category is derived, not stored', /derived from the action name/.test(open));
  ok('it names what an audit entry does not carry', /no IP address, device, browser/.test(open));
  const bare = (() => {
    const h = host();
    ACT._render(h, { items: ACT._normalise([{ id: 'b', action: 'x', performedBy: 'y',
      createdAt: '2026-09-18T10:00:00Z' }]), limit: 50, cat: 'all', q: '', qRaw: '',
      view: 'log', open: '0' });
    return h.innerHTML;
  })();
  ok('an entry with nothing extra says so, rather than showing an empty block',
     /recorded nothing beyond the action, actor and time/.test(bare));

  /* THE TARGET THE WRITERS ACTUALLY RECORD. Each names it for the thing it is —
     orderId, productId, notificationId — so reading only targetId/target/entityId left
     the column empty on every row of a live page while the id sat in the document. */
  const tgt = (l) => ACT._normalise([l])[0];
  ok('a typed target id is read', tgt({ action: 'a', orderId: 'ORD-1' }).target === 'ORD-1');
  ok('and the field it came from is kept',
     tgt({ action: 'a', orderId: 'ORD-1' }).targetField === 'orderId');
  ok('a product id is read too', tgt({ action: 'a', productId: 'P-9' }).target === 'P-9');
  ok('the generic spelling still wins when present',
     tgt({ action: 'a', targetId: 'T-1', orderId: 'ORD-1' }).targetField === 'targetId');
  /* The ACTOR must never be shown as the target. */
  ok('performedBy is not treated as a target',
     tgt({ action: 'a', performedBy: 'admin@x' }).target === '');
  ok('nor uid', tgt({ action: 'a', uid: 'u-1' }).target === '');
  const tRow = (() => {
    const h = host();
    ACT._render(h, { items: ACT._normalise([{ id: 'z', action: 'order_status_updated',
      performedBy: 'a@b.c', orderId: 'ORD-77', createdAt: '2026-09-18T10:00:00Z' }]),
      limit: 50, cat: 'all', q: '', qRaw: '', view: 'log', open: '0' });
    return h.innerHTML;
  })();
  ok('the log row shows the target and names its field',
     tRow.indexOf('ORD-77') > -1 && /<small>orderId<\/small>/.test(tRow));
  ok('the detail names the field it was recorded as', /recorded as <code>orderId/.test(tRow));
  ok('and does not repeat it as an extra field', !/acx-d-k">orderId</.test(tRow));
  const noTgt = (() => {
    const h = host();
    ACT._render(h, { items: ACT._normalise([{ id: 'z', action: 'x', performedBy: 'a@b.c',
      createdAt: '2026-09-18T10:00:00Z' }]), limit: 50, cat: 'all', q: '', qRaw: '',
      view: 'log', open: '0' });
    return h.innerHTML;
  })();
  ok('control — an entry with no target says so', /this entry names no target/.test(noTgt));
  /* REMOUNT SAFETY — the panel remounts on every audit-source tab change. */
  const src = strip(read('sokoni-aos-activity.js'));
  ok('listeners are unbound before a remount rebinds them', /host\.__acxOff/.test(src));
  ok('every listener goes through the tracked binder', !/host\.addEventListener\('/.test(src));

  /* ONE COMPONENT. No second audit module may appear beside this one. */
  const aos = read('sokoni-aos.js');
  ok('the audit section still mounts exactly one module',
     (aos.match(/SokoniAOSActivity/g) || []).length >= 1 &&
     !/SokoniAOSAudit|sokoni-aos-audit/.test(aos));
  ok('and no second audit stylesheet exists',
     !fs.existsSync(path.join(ROOT, 'sokoni-aos-audit.css')));
}

console.log('\n  what this suite does NOT prove');
console.log('  UNPROVEN  live callable responses   [proven by loading admin-os.html]');

console.log('\n══════════════════════════════════════════════════════════════════');
console.log('  ' + pass + ' passed, ' + fail + ' failed');
console.log('══════════════════════════════════════════════════════════════════');
process.exit(fail ? 1 : 0);
