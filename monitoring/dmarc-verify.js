#!/usr/bin/env node
/**
 * SOKONI DMARC Verification Script
 *
 * Performs live DNS lookups to verify SPF, DKIM, and DMARC records
 * for mysokoni.co.ke are correctly configured.
 *
 * Usage:
 *   node monitoring/dmarc-verify.js
 *   node monitoring/dmarc-verify.js --json          # JSON output
 *   node monitoring/dmarc-verify.js --domain other.ke  # custom domain
 *
 * Prerequisites:
 *   Node.js 16+ (uses DNS-over-HTTPS — works behind any firewall / sandbox)
 */

"use strict";

const https = require("https");

/* ─── Config ─────────────────────────────────────────────────────────── */
const args    = process.argv.slice(2);
const JSON_OUT = args.includes("--json");
const DOMAIN  = (args.find(a => a.startsWith("--domain=")) || "--domain=mysokoni.co.ke")
                  .replace("--domain=", "");

/* Expected values */
const EXPECTED = {
  spf:   `v=spf1 ip4:46.165.235.143 include:relay.mailbaby.net include:sendgrid.net -all`,
  dmarc: `v=DMARC1; p=quarantine; rua=mailto:dmarc@${DOMAIN}; ruf=mailto:security@${DOMAIN}; fo=1; adkim=s; aspf=s; pct=100`,
  dkimSelectors: ["default", "s1", "s2"],
};

const results = { domain: DOMAIN, timestamp: new Date().toISOString(), checks: {} };

/* ─── Helpers ────────────────────────────────────────────────────────── */
const RESET  = "\x1b[0m";
const GREEN  = "\x1b[32m";
const RED    = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN   = "\x1b[36m";
const BOLD   = "\x1b[1m";

function pass(label, detail = "") {
  if (!JSON_OUT) console.log(`  ${GREEN}✅ PASS${RESET}  ${label}${detail ? `\n         ${detail}` : ""}`);
}
function fail(label, detail = "") {
  if (!JSON_OUT) console.log(`  ${RED}❌ FAIL${RESET}  ${label}${detail ? `\n         ${detail}` : ""}`);
}
function warn(label, detail = "") {
  if (!JSON_OUT) console.log(`  ${YELLOW}⚠️  WARN${RESET}  ${label}${detail ? `\n         ${detail}` : ""}`);
}
function info(label) {
  if (!JSON_OUT) console.log(`         ${label}`);
}
function section(title) {
  if (!JSON_OUT) console.log(`\n${BOLD}${CYAN}${title}${RESET}`);
  if (!JSON_OUT) console.log("─".repeat(60));
}

/* ── DNS over HTTPS via Google — avoids UDP port-53 sandbox blocks ── */
function dohQuery(name, type) {
  return new Promise((resolve, reject) => {
    const url  = `https://dns.google/resolve?name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}`;
    const opts = { headers: { Accept: "application/dns-json" } };
    https.get(url, opts, (res) => {
      let raw = "";
      res.on("data", c => raw += c);
      res.on("end", () => {
        try {
          const j = JSON.parse(raw);
          resolve(j.Status === 0 ? (j.Answer || []) : []);
        } catch { resolve([]); }
      });
    }).on("error", reject);
  });
}

async function resolveTXT(host) {
  try {
    const recs = await dohQuery(host, "TXT");
    return recs
      .filter(r => r.type === 16)
      /* Google wraps each 255-byte chunk in quotes — strip + join them */
      .map(r => r.data.replace(/^"|"$/g, "").replace(/" "/g, ""));
  } catch { return []; }
}

async function resolveCNAME(host) {
  try {
    const recs = await dohQuery(host, "CNAME");
    return recs.filter(r => r.type === 5).map(r => r.data.replace(/\.$/, ""));
  } catch { return []; }
}

async function resolveA(host) {
  try {
    const recs = await dohQuery(host, "A");
    return recs.filter(r => r.type === 1).map(r => r.data);
  } catch { return []; }
}

async function resolveMX(host) {
  try {
    const recs = await dohQuery(host, "MX");
    return recs.filter(r => r.type === 15).map(r => {
      const parts = r.data.trim().split(/\s+/);
      return { priority: parseInt(parts[0], 10), exchange: (parts[1] || "").replace(/\.$/, "") };
    });
  } catch { return []; }
}

/* ─── SPF Check ─────────────────────────────────────────────────────── */
async function checkSPF() {
  section("SPF — Sender Policy Framework");
  const txts = await resolveTXT(DOMAIN);
  const spf  = txts.find(r => r.startsWith("v=spf1"));

  const r = { found: false, value: null, issues: [], warnings: [] };

  if (!spf) {
    fail("SPF record not found");
    r.issues.push("SPF record missing");
    results.checks.spf = r;
    return;
  }

  r.found = true;
  r.value = spf;
  info(`Record: ${spf}`);

  /* Check for good elements */
  if (spf.includes("include:sendgrid.net")) {
    pass("SendGrid included in SPF");
    r.sendgrid = true;
  } else {
    fail("SendGrid NOT in SPF — SendGrid emails will fail SPF check",
         "Add: include:sendgrid.net");
    r.issues.push("include:sendgrid.net missing");
    r.sendgrid = false;
  }

  if (spf.includes("ip4:46.165.235.143")) {
    pass("HostPinnacle IP authorised (46.165.235.143)");
  } else {
    warn("HostPinnacle IP 46.165.235.143 not in SPF — check if still in use");
    r.warnings.push("HostPinnacle IP missing from SPF");
  }

  if (spf.includes("include:relay.mailbaby.net")) {
    pass("MailBaby relay authorised");
  } else {
    warn("relay.mailbaby.net not in SPF — MailBaby relay emails may fail");
    r.warnings.push("relay.mailbaby.net missing");
  }

  /* Check for bad elements */
  if (spf.includes("+a") || spf.includes(" a ") || / a$/.test(spf)) {
    fail("SPF includes +a mechanism — authorises Firebase CDN to send email",
         "Remove +a from SPF record");
    r.issues.push("+a mechanism present (authorises Firebase CDN)");
  } else {
    pass("SPF does NOT include +a (Firebase CDN not authorised) ✓");
  }

  if (spf.includes("+mx") || spf.includes(" mx ") || / mx$/.test(spf)) {
    fail("SPF includes +mx mechanism — may authorise unexpected IPs",
         "Remove +mx from SPF record");
    r.issues.push("+mx mechanism present");
  } else {
    pass("SPF does NOT include +mx ✓");
  }

  if (spf.endsWith("-all")) {
    pass("SPF uses -all (hardfail) — unauthorized senders rejected ✓");
    r.qualifier = "hardfail";
  } else if (spf.endsWith("~all")) {
    warn("SPF uses ~all (softfail) — unauthorized senders not rejected",
         "Change ~all to -all for full DMARC enforcement");
    r.qualifier = "softfail";
    r.warnings.push("~all should be -all");
  } else if (spf.endsWith("+all")) {
    fail("SPF uses +all — EVERYONE is authorised! Critical security issue",
         "Immediately change to -all");
    r.issues.push("+all — allows any sender");
    r.qualifier = "allow_all";
  } else {
    warn("SPF qualifier unclear — verify manually");
  }

  /* Lookup count estimate */
  const lookups = (spf.match(/include:/g) || []).length
                + (spf.match(/redirect=/g) || []).length
                + (spf.includes("+mx") || spf.includes(" mx") ? 1 : 0);
  if (lookups > 8) {
    warn(`SPF has ~${lookups} DNS lookups — approaching 10-lookup limit`);
    r.warnings.push(`High DNS lookup count: ~${lookups}`);
  } else {
    pass(`DNS lookup count: ~${lookups}/10 — within limit`);
  }

  r.pass = r.issues.length === 0;
  results.checks.spf = r;
}

/* ─── DKIM Check ────────────────────────────────────────────────────── */
async function checkDKIM() {
  section("DKIM — DomainKeys Identified Mail");

  const r = { selectors: {} };

  for (const sel of EXPECTED.dkimSelectors) {
    const host   = `${sel}._domainkey.${DOMAIN}`;
    const txts   = await resolveTXT(host);
    const cnames = await resolveCNAME(host);

    if (txts.length > 0) {
      const key = txts[0];
      if (key.startsWith("v=DKIM1")) {
        pass(`DKIM selector '${sel}' — TXT record found`, key.substring(0, 80) + "...");
        r.selectors[sel] = { type: "TXT", found: true, value: key.substring(0, 120) };
        if (key.includes("p=") && !key.includes("p=;")) {
          pass(`DKIM '${sel}' — public key present (not revoked)`);
        } else {
          fail(`DKIM '${sel}' — public key is EMPTY (revoked key!)`,
               "Generate and publish a new DKIM key");
          r.selectors[sel].revoked = true;
        }
      } else {
        warn(`DKIM selector '${sel}' — TXT record found but doesn't start with v=DKIM1`);
        r.selectors[sel] = { found: true, unexpected: key };
      }
    } else if (cnames.length > 0) {
      pass(`DKIM selector '${sel}' — CNAME record found → ${cnames[0]}`);
      r.selectors[sel] = { type: "CNAME", found: true, target: cnames[0] };
      /* Verify CNAME resolves to TXT */
      const resolved = await resolveTXT(cnames[0]);
      if (resolved.some(t => t.startsWith("v=DKIM1"))) {
        pass(`DKIM '${sel}' CNAME resolves to valid DKIM record ✓`);
      } else {
        fail(`DKIM '${sel}' CNAME does not resolve to a v=DKIM1 record`,
             `Check: ${cnames[0]}`);
        r.selectors[sel].resolves = false;
      }
    } else {
      if (sel === "default") {
        fail(`DKIM selector '${sel}' — NOT FOUND`, `Check: ${host}`);
        r.selectors[sel] = { found: false };
      } else {
        warn(`DKIM selector '${sel}' — NOT FOUND (SendGrid domain auth not yet configured)`,
             `Complete SendGrid domain authentication to add s1/s2 selectors`);
        r.selectors[sel] = { found: false, note: "SendGrid auth pending" };
      }
    }
  }

  results.checks.dkim = r;
}

/* ─── DMARC Check ───────────────────────────────────────────────────── */
async function checkDMARC() {
  section("DMARC — Domain-based Message Authentication");

  const host = `_dmarc.${DOMAIN}`;
  const txts = await resolveTXT(host);
  const rec  = txts.find(t => t.startsWith("v=DMARC1"));

  const r = { found: false, issues: [], warnings: [] };

  if (!rec) {
    fail("DMARC record not found", `_dmarc.${DOMAIN} TXT record missing`);
    r.issues.push("DMARC record missing");
    results.checks.dmarc = r;
    return;
  }

  r.found = true;
  r.value = rec;
  info(`Record: ${rec}`);

  /* Parse DMARC tags */
  const tags = {};
  rec.split(";").forEach(part => {
    const [k, ...v] = part.trim().split("=");
    if (k) tags[k.trim()] = (v.join("=") || "").trim();
  });

  /* Policy */
  const policy = tags["p"] || "none";
  if (policy === "reject") {
    pass("DMARC policy: p=reject (maximum enforcement) ✓");
    r.policy = "reject";
  } else if (policy === "quarantine") {
    pass("DMARC policy: p=quarantine (production-ready) ✓");
    r.policy = "quarantine";
  } else if (policy === "none") {
    warn("DMARC policy: p=none (monitoring only — no enforcement)",
         "Change to p=quarantine to enable enforcement");
    r.policy = "none";
    r.warnings.push("p=none — monitoring only");
  } else {
    fail(`Unknown DMARC policy: ${policy}`);
    r.issues.push(`Unknown policy: ${policy}`);
  }

  /* Reporting — aggregate */
  if (tags["rua"]) {
    pass(`Aggregate reports: ${tags["rua"]}`);
    r.rua = tags["rua"];
  } else {
    warn("rua (aggregate reports) not configured — you won't receive DMARC reports",
         `Add: rua=mailto:dmarc@${DOMAIN}`);
    r.warnings.push("rua missing");
  }

  /* Reporting — forensic */
  if (tags["ruf"]) {
    pass(`Forensic reports: ${tags["ruf"]}`);
    r.ruf = tags["ruf"];
  } else {
    warn("ruf (forensic reports) not configured",
         `Add: ruf=mailto:security@${DOMAIN}`);
    r.warnings.push("ruf missing");
  }

  /* Alignment */
  const adkim = tags["adkim"] || "r";
  if (adkim === "s") {
    pass("DKIM alignment: adkim=s (strict) ✓");
    r.adkim = "s";
  } else {
    warn("DKIM alignment: adkim=r (relaxed) — subdomains would pass",
         "Add: adkim=s for strict alignment");
    r.adkim = "r";
    r.warnings.push("adkim=r (relaxed)");
  }

  const aspf = tags["aspf"] || "r";
  if (aspf === "s") {
    pass("SPF alignment: aspf=s (strict) ✓");
    r.aspf = "s";
  } else {
    warn("SPF alignment: aspf=r (relaxed)",
         "Add: aspf=s for strict alignment");
    r.aspf = "r";
    r.warnings.push("aspf=r (relaxed)");
  }

  /* Failure options */
  const fo = tags["fo"] || "0";
  if (fo === "1") {
    pass("Failure reporting: fo=1 (report on any auth failure) ✓");
  } else {
    info(`Failure option: fo=${fo}`);
  }
  r.fo = fo;

  /* Percentage */
  const pct = parseInt(tags["pct"] || "100", 10);
  if (pct === 100) {
    pass("Coverage: pct=100 (all messages) ✓");
  } else {
    warn(`Coverage: pct=${pct} (only ${pct}% of failing messages affected)`,
         "Set pct=100 for full enforcement");
    r.warnings.push(`pct=${pct} (not 100%)`);
  }
  r.pct = pct;

  r.pass = r.issues.length === 0 && policy !== "none";
  results.checks.dmarc = r;
}

/* ─── MX Check ──────────────────────────────────────────────────────── */
async function checkMX() {
  section("MX Records — Mail Exchange");

  const mxRecords = await resolveMX(DOMAIN);
  const r = { records: [] };

  if (!mxRecords.length) {
    warn("No MX records found",
         "Ensure HostPinnacle has MX records configured for inbound email delivery");
    r.found = false;
    results.checks.mx = r;
    return;
  }

  r.found = true;
  for (const mx of mxRecords.sort((a, b) => a.priority - b.priority)) {
    info(`MX ${mx.priority}: ${mx.exchange}`);
    r.records.push({ priority: mx.priority, exchange: mx.exchange });

    /* Warn if MX points to domain itself (likely Firebase) */
    if (mx.exchange === DOMAIN || mx.exchange === `${DOMAIN}.`) {
      fail(`MX ${mx.priority} points to domain itself (${mx.exchange})`,
           "This likely routes email to Firebase CDN which cannot receive email. " +
           "Set MX to your HostPinnacle mail server.");
      r.selfReference = true;
    } else {
      const ips = await resolveA(mx.exchange);
      pass(`MX ${mx.priority} ${mx.exchange} → ${ips.join(", ") || "(resolves)"}`);
    }
  }

  results.checks.mx = r;
}

/* ─── Firebase Hosting Check ────────────────────────────────────────── */
async function checkFirebase() {
  section("Firebase Hosting — Website Integrity");

  const a   = await resolveA(DOMAIN);
  const txt = await resolveTXT(DOMAIN);

  if (a.includes("199.36.158.100")) {
    pass("A record → 199.36.158.100 (Firebase Hosting CDN) ✓");
  } else {
    warn(`A record → ${a.join(", ")} (expected 199.36.158.100)`,
         "Firebase Hosting A record may have changed — verify in Firebase Console");
  }

  if (txt.some(t => t.includes("hosting-site=sokoni-aeb26"))) {
    pass("Firebase Hosting verification TXT record present ✓");
  } else {
    warn("Firebase Hosting verification TXT not found — website may not be claimed");
  }

  results.checks.firebase = { aRecords: a };
}

/* ─── Summary ───────────────────────────────────────────────────────── */
function printSummary() {
  if (JSON_OUT) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  console.log(`\n${"═".repeat(60)}`);
  console.log(`${BOLD}DMARC VERIFICATION SUMMARY — ${DOMAIN}${RESET}`);
  console.log("═".repeat(60));

  const spf   = results.checks.spf;
  const dkim  = results.checks.dkim;
  const dmarc = results.checks.dmarc;

  const spfOk   = spf?.pass === true;
  const s1Ok    = dkim?.selectors?.["default"]?.found;
  const sgOk    = dkim?.selectors?.["s1"]?.found || dkim?.selectors?.["s2"]?.found;
  const dmarcOk = dmarc?.pass === true;

  const rows = [
    ["SPF Record",              spfOk  ? "✅ PASS" : "❌ FAIL"],
    ["SPF -all (hardfail)",     spf?.qualifier === "hardfail" ? "✅ PASS" : "⚠️  WARN"],
    ["SPF includes SendGrid",   spf?.sendgrid   ? "✅ PASS" : "❌ FAIL"],
    ["DKIM (HostPinnacle)",     s1Ok  ? "✅ PASS" : "❌ FAIL"],
    ["DKIM (SendGrid s1/s2)",   sgOk  ? "✅ PASS" : "⚠️  PENDING (SendGrid auth needed)"],
    ["DMARC Record",            dmarc?.found ? "✅ FOUND" : "❌ MISSING"],
    ["DMARC Policy",            dmarc?.policy === "quarantine" || dmarc?.policy === "reject"
                                  ? `✅ p=${dmarc.policy}` : `⚠️  p=${dmarc?.policy || "none"}`],
    ["DMARC adkim=s (strict)",  dmarc?.adkim === "s" ? "✅ PASS" : "⚠️  NOT SET"],
    ["DMARC aspf=s (strict)",   dmarc?.aspf  === "s" ? "✅ PASS" : "⚠️  NOT SET"],
    ["DMARC Aggregate Reports",  dmarc?.rua ? "✅ SET"  : "⚠️  MISSING"],
    ["DMARC Forensic Reports",  dmarc?.ruf ? "✅ SET"  : "⚠️  MISSING"],
    ["Firebase Hosting A",      results.checks.firebase?.aRecords?.includes("199.36.158.100")
                                  ? "✅ INTACT" : "⚠️  CHECK"],
  ];

  rows.forEach(([label, status]) => {
    console.log(`  ${status.padEnd(40)} ${label}`);
  });

  /* Overall score */
  const pass_count  = rows.filter(([, s]) => s.startsWith("✅")).length;
  const score = Math.round((pass_count / rows.length) * 100);
  const scoreColor = score >= 90 ? GREEN : score >= 70 ? YELLOW : RED;

  console.log(`\n${"─".repeat(60)}`);
  console.log(`${BOLD}Score: ${scoreColor}${score}%${RESET}${BOLD} (${pass_count}/${rows.length} checks passed)${RESET}`);

  if (!spf?.sendgrid) {
    console.log(`\n${YELLOW}Next action:${RESET}`);
    console.log("  1. Complete SendGrid domain authentication for mysokoni.co.ke");
    console.log("  2. Update SPF record (remove +a +mx, add include:sendgrid.net, use -all)");
    console.log("  3. Add s1._domainkey + s2._domainkey CNAME records");
    console.log("  4. Update DMARC record to p=quarantine with reporting addresses");
    console.log("  See: docs/DMARC.md for exact values\n");
  } else if (!dmarcOk) {
    console.log(`\n${YELLOW}Next action:${RESET} Update _dmarc TXT to p=quarantine with rua/ruf/alignment tags\n`);
  } else {
    console.log(`\n${GREEN}Email authentication is fully configured. Monitor dmarc@mysokoni.co.ke for aggregate reports.${RESET}\n`);
  }

  results.score = score;
}

/* ─── Main ───────────────────────────────────────────────────────────── */
async function main() {
  if (!JSON_OUT) {
    console.log(`\n${BOLD}${CYAN}SOKONI DMARC Verification — ${DOMAIN}${RESET}`);
    console.log(`Timestamp: ${new Date().toISOString()}`);
  }

  await checkSPF();
  await checkDKIM();
  await checkDMARC();
  await checkMX();
  await checkFirebase();

  printSummary();

  const hasFailures = Object.values(results.checks).some(c => c.issues?.length > 0);
  process.exit(hasFailures ? 1 : 0);
}

main().catch(e => {
  console.error("Verification failed:", e.message);
  process.exit(2);
});
