'use strict';
/**
 * scripts/scan-admin-field-writes.js
 *
 * Finds client-side writes that carry a server-owned field and would therefore
 * be rejected wholesale by firestore.rules.
 *
 *   node scripts/scan-admin-field-writes.js
 *
 * THE BUG CLASS
 * noAdminFields() in firestore.rules fails on the PRESENCE of a key, not its
 * value:
 *
 *   !request.resource.data.keys().hasAny(['verified','featured','approved',…])
 *
 * So `verified: false` — which reads as a careful, honest default — makes the
 * entire create 403. Nothing surfaces: the SDK call rejects, the caller has a
 * `.catch(function(){})`, and the user sees a success screen. The record simply
 * never exists.
 *
 * This was live in three separate files writing `providers`, and it is why that
 * collection was empty despite two registration forms and an onboarding flow
 * pointing at it. Verified against production: the same payload with the key
 * returns 403, without it returns 200.
 *
 * WHAT IS AND IS NOT FLAGGED
 * Only client bundles are scanned. `functions/**` runs on the Admin SDK, and
 * `scripts/**` uses admin REST — both bypass rules legitimately and are
 * excluded. A match is a strong signal, not a proof: the field list is taken
 * from the rule, but this is a text scan and cannot tell which collection a
 * given object literal is bound for. Read the hit before changing anything.
 */
const fs = require('fs');
const path = require('path');

/* Keep in sync with noAdminFields() in firestore.rules. */
const ADMIN_FIELDS = [
  'isAdmin', 'suspended', 'banned', 'adminApproved', 'featured', 'verified',
  'flagged', 'adminNote', 'role', 'approved', 'approvedAt', 'approvedBy',
  'commissionRate',
];

/* Collections whose rules apply noAdminFields() on create. */
const GUARDED = ['providers', 'sellers', 'applications', 'bookings'];

const SKIP_DIRS = new Set(['node_modules', '.git', 'functions', 'scripts', 'docs', '.claude']);

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') && e.name !== '.') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(p, out); continue; }
    if (/\.(html|js)$/i.test(e.name)) out.push(p);
  }
  return out;
}

const files = walk('.', []);
const hits = [];
const seen = new Set();   /* overlapping write windows would report a line twice */

/* Anchor on an actual Firestore write that names a guarded collection. A bare
   field-name scan is unusable here: `role:` in a chat message array, a
   `{pending:…, approved:…}` CSS-class map and hardcoded demo listings all match
   the field names while having nothing to do with a write. */
/* updateDoc is deliberately absent: noAdminFields() gates CREATE only, and an
   admin flipping `verified` via updateDoc is the sanctioned approval path. */
const WRITE_RE = new RegExp(
  '(setDoc|addDoc|saveProvider|saveApplication)\\s*\\(' +
  '|collection\\s*\\([^)]*[\'"](' + GUARDED.join('|') + ')[\'"]' +
  '|doc\\s*\\([^)]*[\'"](' + GUARDED.join('|') + ')[\'"]');

/* How far after the write call the payload literal may extend. */
const WINDOW = 25;

for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  if (!GUARDED.some(c => src.includes("'" + c + "'") || src.includes('"' + c + '"'))) continue;

  const lines = src.split(/\r?\n/);
  lines.forEach((line, i) => {
    if (!WRITE_RE.test(line)) return;
    /* The write must plausibly target a guarded collection: named on this line
       or within the few lines above it. */
    const ctx = lines.slice(Math.max(0, i - 3), i + 1).join(' ');
    if (!GUARDED.some(c => ctx.includes("'" + c + "'") || ctx.includes('"' + c + '"'))) return;

    for (let j = i; j < Math.min(lines.length, i + WINDOW); j++) {
      const t = lines[j].trim();
      if (t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')) continue;
      /* An updateDoc on the same line is the admin approval path, not a create,
         so noAdminFields() does not apply to it. */
      if (/updateDoc\s*\(/.test(lines[j])) continue;
      for (const f of ADMIN_FIELDS) {
        /* Must look like an object KEY — start of line, `{` or `,` before it.
           Allowing plain whitespace also matched prose inside string literals,
           e.g. toast('Driver approved: ' + name), which is not a write. */
        const re = new RegExp('(^|[{,])\\s*' + f + '\\s*:\\s*(true|false|[\'"]|\\d)');
        const key = file + ':' + (j + 1) + ':' + f;
        if (re.test(lines[j]) && !seen.has(key)) {
          seen.add(key);
          hits.push({ file, line: j + 1, field: f, writeLine: i + 1, text: t.slice(0, 100) });
        }
      }
    }
  });
}

if (!hits.length) {
  console.log('\n  no client-side writes carry server-owned fields.\n');
  process.exit(0);
}

console.log('\n  Client writes carrying a server-owned field — each would 403 the whole write:\n');
let last = '';
for (const h of hits) {
  if (h.file !== last) { console.log('  ' + h.file); last = h.file; }
  console.log('    ' + String(h.line).padStart(5) + ':  ' + h.field.padEnd(14) + h.text);
}
console.log('\n  ' + hits.length + ' occurrence(s). Remove the key — absence already means false.');
console.log('  Confirm the object is bound for a guarded collection before editing.\n');
process.exit(1);
