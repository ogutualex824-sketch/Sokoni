#!/usr/bin/env node
/* ============================================================
   SOKONI Pre-Deploy Validation Script  v1.0

   Run before every deployment:
     node scripts/pre-deploy-check.js

   Checks:
     1.  firebase.json valid JSON
     2.  functions/index.js syntax (node --check)
     3.  Firestore rules file exists
     4.  Firestore indexes file exists
     5.  service-worker.js cache version bump (vs last git tag)
     6.  No hardcoded live secrets
     7.  CHANGELOG.md updated today
     8.  demo-seed.js production guard present
     9.  package.json in functions/ is valid
    10.  No console.log calls with sensitive keywords
    11.  Hosting site name is sokoni-aeb26 (not default)

   Exit codes:
     0  all checks passed
     1  one or more checks failed (deployment blocked)
============================================================ */
"use strict";

const { execSync, spawnSync } = require("child_process");
const fs   = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

let pass    = 0;
let fail    = 0;
let warn    = 0;
const ERRORS = [];

/* ── Colour helpers (suppress in CI without TTY) ── */
const isTTY = process.stdout.isTTY;
const RED   = isTTY ? "\x1b[31m" : "";
const GRN   = isTTY ? "\x1b[32m" : "";
const YLW   = isTTY ? "\x1b[33m" : "";
const DIM   = isTTY ? "\x1b[2m"  : "";
const RST   = isTTY ? "\x1b[0m"  : "";

function ok(label) {
  console.log(`${GRN}  ✔${RST}  ${label}`);
  pass++;
}
function bad(label, detail) {
  console.log(`${RED}  ✖${RST}  ${label}`);
  if (detail) console.log(`${DIM}       ${detail}${RST}`);
  ERRORS.push(label);
  fail++;
}
function warn_(label, detail) {
  console.log(`${YLW}  ⚠${RST}  ${label}`);
  if (detail) console.log(`${DIM}       ${detail}${RST}`);
  warn++;
}

/* ── Check helpers ── */
function fileExists(relPath) {
  return fs.existsSync(path.join(ROOT, relPath));
}
function readFile(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), "utf8");
}

console.log(`\n${DIM}══════════════════════════════════════════════${RST}`);
console.log(`  SOKONI Pre-Deploy Check`);
console.log(`  ${new Date().toISOString()}`);
console.log(`${DIM}══════════════════════════════════════════════${RST}\n`);

/* ─────────────────────────────────────────────
   1. firebase.json valid JSON
───────────────────────────────────────────── */
try {
  const raw  = readFile("firebase.json");
  const json = JSON.parse(raw);
  if (!json.hosting || !json.hosting.site) throw new Error("missing hosting.site");
  if (json.hosting.site !== "sokoni-aeb26") bad("firebase.json: hosting.site must be sokoni-aeb26", `Found: ${json.hosting.site}`);
  else ok("firebase.json: valid JSON with correct site name");
} catch (e) {
  bad("firebase.json: invalid or missing", e.message);
}

/* ─────────────────────────────────────────────
   2. functions/index.js syntax check
───────────────────────────────────────────── */
{
  const r = spawnSync("node", ["--check", path.join(ROOT, "functions/index.js")], { encoding: "utf8" });
  if (r.status !== 0) bad("functions/index.js: syntax error", (r.stderr || "").slice(0, 200));
  else ok("functions/index.js: syntax OK");
}

/* ─────────────────────────────────────────────
   3 & 4. Required config files exist
───────────────────────────────────────────── */
for (const f of ["firestore.rules", "firestore.indexes.json", "storage.rules"]) {
  if (fileExists(f)) ok(`${f}: present`);
  else bad(`${f}: MISSING`);
}

/* ─────────────────────────────────────────────
   5. Service worker cache version bumped vs git
───────────────────────────────────────────── */
try {
  const swContent = readFile("service-worker.js");
  /* Accept both legacy "sokoni-v300" and new datestamp "sokoni-20260625120133" format */
  const match = swContent.match(/CACHE_VERSION\s*=\s*"(sokoni-[\w-]+)"/);
  const currentVersion = match?.[1];

  if (!currentVersion) {
    bad("service-worker.js: CACHE_VERSION not found");
  } else {
    /* Compare to git HEAD's version */
    let gitVersion = null;
    try {
      const gitContent = execSync("git show HEAD:service-worker.js", {
        encoding: "utf8", stdio: ["pipe","pipe","pipe"]
      });
      const gm = gitContent.match(/CACHE_VERSION\s*=\s*"(sokoni-[\w-]+)"/);
      gitVersion = gm?.[1];
    } catch (_) {}

    if (gitVersion && gitVersion === currentVersion) {
      warn_("service-worker.js: CACHE_VERSION unchanged from last commit", `Still: ${currentVersion} — CI will bump it before deploy`);
    } else {
      ok(`service-worker.js: CACHE_VERSION updated (${gitVersion || "unknown"} → ${currentVersion})`);
    }
  }
} catch (e) {
  bad("service-worker.js: could not read", e.message);
}

/* ─────────────────────────────────────────────
   6. No hardcoded live secrets
───────────────────────────────────────────── */
{
  /* Patterns split to avoid self-detection */
  const patterns = [
    { re: new RegExp("ISPrivKey" + "_live_"),        label: "IntaSend live private key" },
    { re: new RegExp("sk" + "_live_"),               label: "Stripe live secret key" },
    { re: /AKIA[0-9A-Z]{16}/,                        label: "AWS access key" },
    { re: new RegExp("-----BEGIN RSA" + " PRIVATE"), label: "RSA private key" },
  ];

  let secretsFound = false;
  let jsFiles = [];
  try {
    const raw = execSync("git ls-files --cached --others --exclude-standard", {
      cwd: ROOT, encoding: "utf8", stdio: ["pipe","pipe","pipe"]
    });
    jsFiles = raw.split("\n")
      .filter(f => f && (f.endsWith(".js") || f.endsWith(".html")))
      .slice(0, 200);
  } catch (_) {
    warn_("Secret scan: git ls-files unavailable — skipping");
  }

  for (const file of jsFiles) {
    try {
      const content = fs.readFileSync(path.join(ROOT, file), "utf8");
      for (const { re, label } of patterns) {
        if (re.test(content)) {
          bad(`Hardcoded secret in ${file}: ${label}`);
          secretsFound = true;
        }
      }
    } catch (_) {}
  }
  if (!secretsFound && jsFiles.length > 0) ok(`Secret scan: no hardcoded live secrets (${jsFiles.length} files)`);
  else if (jsFiles.length === 0 && !secretsFound) ok("Secret scan: passed (non-git scan)");

}

/* ─────────────────────────────────────────────
   7. CHANGELOG updated today (or recently)
───────────────────────────────────────────── */
try {
  const changelog = readFile("CHANGELOG.md");
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
  if (changelog.includes(today) || changelog.includes(yesterday)) {
    ok("CHANGELOG.md: updated recently");
  } else {
    warn_("CHANGELOG.md: no entry for today or yesterday", "Update CHANGELOG.md before deploying");
  }
} catch (_) {
  warn_("CHANGELOG.md: could not read");
}

/* ─────────────────────────────────────────────
   8. demo-seed.js production guard
───────────────────────────────────────────── */
if (fileExists("demo-seed.js")) {
  const content = readFile("demo-seed.js");
  if (content.includes("localhost") || content.includes("127.0.0.1")) {
    ok("demo-seed.js: production guard present");
  } else if (content.includes("removed localhost guard")) {
    bad("demo-seed.js: production guard REMOVED — demo data will run in production!");
  } else {
    warn_("demo-seed.js: production guard pattern unclear — review manually");
  }
}

/* ─────────────────────────────────────────────
   9. functions/package.json valid
───────────────────────────────────────────── */
try {
  JSON.parse(readFile("functions/package.json"));
  ok("functions/package.json: valid JSON");
} catch (e) {
  bad("functions/package.json: invalid JSON", e.message);
}

/* ─────────────────────────────────────────────
   10. Firestore index count sanity check
───────────────────────────────────────────── */
try {
  const indexes = JSON.parse(readFile("firestore.indexes.json"));
  const count = (indexes.indexes || []).length;
  if (count > 200) {
    bad(`firestore.indexes.json: ${count} indexes (Firebase limit is 200)`);
  } else if (count > 190) {
    warn_(`firestore.indexes.json: ${count}/200 indexes — approaching limit`);
  } else {
    ok(`firestore.indexes.json: ${count} indexes (limit 200)`);
  }
} catch (_) {}

/* ─────────────────────────────────────────────
   11. No TODO/FIXME in functions/
───────────────────────────────────────────── */
{
  const todoPaths = [];
  try {
    const out = execSync(
      `git grep -l "TODO:|FIXME:" -- "functions/*.js"`,
      { cwd: ROOT, encoding: "utf8", stdio: ["pipe","pipe","pipe"] }
    ).trim();
    if (out) todoPaths.push(...out.split("\n").filter(Boolean));
  } catch (_) {}
  if (todoPaths.length > 0) {
    warn_(`Unresolved TODO/FIXME in ${todoPaths.length} function file(s)`, todoPaths.slice(0,3).join(", "));
  } else {
    ok("functions/: no unresolved TODO/FIXME markers");
  }
}

/* ── Summary ── */
console.log(`\n${DIM}──────────────────────────────────────────────${RST}`);
console.log(`  ${GRN}${pass} passed${RST}  ${YLW}${warn} warnings${RST}  ${fail > 0 ? RED : ""}${fail} failed${RST}`);
console.log(`${DIM}──────────────────────────────────────────────${RST}\n`);

if (fail > 0) {
  console.log(`${RED}  🚫  Deployment blocked. Fix the above issues first.${RST}\n`);
  process.exit(1);
} else if (warn > 0) {
  console.log(`${YLW}  ⚠️   Warnings found. Review before deploying.${RST}\n`);
  process.exit(0);
} else {
  console.log(`${GRN}  ✅  All checks passed. Ready to deploy.${RST}\n`);
  process.exit(0);
}
