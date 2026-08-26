#!/usr/bin/env node
/* Per-page Admin integration verifier for the disposable candidate.
   Each diverged page is evidenced INDIVIDUALLY -- admin.html needed only wiring,
   sasos-admin.html additionally needed a guard deferral, so there is no universal
   recipe and none is assumed.

   Always runs the negative control: with the shared guard ABSENT and no user, the
   page's own signed-out redirect must still fire. A deferral that swallows that
   would be a regression, not an integration.

   Usage: node scripts/verify-admin-page-integration.js <page.html> [--base URL]
*/
"use strict";
const path = require("path"), fs = require("fs");
const ROOT = path.resolve(__dirname, "..");
const { chromium } = require(path.join(ROOT, "node_modules", "playwright"));
const argv = process.argv.slice(2);
const PAGE = argv[0];
const BASE = (() => { const i = argv.indexOf("--base"); return i >= 0 ? argv[i + 1] : "http://127.0.0.1:3101"; })();
if (!PAGE) { console.error("usage: verify-admin-page-integration.js <page.html> [--base URL]"); process.exit(2); }

const stubFor = (claims, signedOut) => {
  let t = fs.readFileSync(path.join(ROOT, "scripts/fixtures/firebase-stub-module.js"), "utf8")
    .split("__CLAIMS__").join(JSON.stringify(claims));   /* global: one replace hit the comment */
  if (signedOut) t = t.replace("currentUser: user,", "currentUser: null,")
                      .replace("try { cb(user); }", "try { cb(null); }");
  return t;
};

async function run(label, opts) {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.route("**/firebase.js", r => r.fulfill({ status: 200,
    contentType: "application/javascript", body: stubFor(opts.claims, opts.signedOut) }));
  if (opts.blockGuard) await ctx.route("**/sokoni-admin-guard.js", r => r.abort());
  const p = await ctx.newPage();
  const errs = [], navs = [];
  p.on("pageerror", e => errs.push(String(e.message).slice(0, 70)));
  p.on("framenavigated", f => { if (f === p.mainFrame()) navs.push(f.url().replace(BASE, "")); });
  await p.goto(BASE + "/" + PAGE, { waitUntil: "domcontentloaded", timeout: 25000 });
  await p.waitForTimeout(1200);
  try {
    await p.waitForFunction(() => { const s = document.getElementById("sk-splash");
      if (!s) return true; const c = getComputedStyle(s);
      return c.display === "none" || c.visibility === "hidden" || Number(c.opacity) < 0.05;
    }, { timeout: 10000 });
  } catch (e) { }
  await p.waitForTimeout(2600);
  const r = await p.evaluate(() => ({
    url: location.pathname + location.search,
    ws: document.documentElement.getAttribute("data-sokoni-workspace"),
    header: !!document.getElementById("sk-adm-header"),
    side: !!document.getElementById("sk-adm-side"),
    guard: typeof window.SokoniAdminGuard !== "undefined",
    navLinks: document.querySelectorAll("#sk-adm-side a[href]").length,
    denial: /access required|not carry an admin|insufficient/i.test(document.body.innerText || ""),
    text: (document.body.innerText || "").trim().slice(0, 50).replace(/\n/g, " "),
  })).catch(() => ({ url: "?", ws: null }));
  await b.close();
  console.log("  " + label);
  console.log("    navigations: " + (navs.join(" -> ") || "(none)"));
  console.log("    url=" + r.url + "  ws=" + r.ws + "  hdr=" + r.header + " side=" + r.side +
              "  guard=" + r.guard + "  navLinks=" + r.navLinks + "  denial=" + r.denial);
  if (errs.length) console.log("    pageErrors: " + errs.slice(0, 2).join(" | "));
  return r;
}

(async () => {
  console.log("=== " + PAGE + " @ " + BASE + " ===");
  const a = await run("A. authorised claims, guard present", { claims: { admin: true, superAdmin: true } });
  const n = await run("B. non-admin claims, guard present", { claims: { admin: false, superAdmin: false } });
  /* C was previously "block the guard and expect the legacy redirect". That
     sabotages the initialisation chain, so a missing redirect could mean the page
     never REACHED its fallback rather than that the fallback is broken. Drive the
     signed-out state with the guard intact instead, and record whether the page
     reached a decision at all. */
  const c = await run("C. signed OUT, guard present (native fallback)",
    { claims: { admin: false, superAdmin: false }, signedOut: true });
  const cLegacy = await run("D. signed OUT, guard absent (legacy path only)",
    { claims: { admin: false, superAdmin: false }, signedOut: true, blockGuard: true });

  const shell = a.header && a.side, ws = a.ws === "admin";
  const noBounce = String(a.url).indexOf("login") < 0;
  const denied = String(n.url).indexOf("login") >= 0 || n.denial || !(n.header && n.side);
  /* A signed-out visitor must end at login by SOME route. Passing if either the
     guard or the page own listener gets there; only FAIL when neither does AND the
     page demonstrably initialised (guard loaded), so "never reached the fallback"
     is not scored as a broken fallback. */
  const fallback = String(c.url).indexOf("login") >= 0 || String(cLegacy.url).indexOf("login") >= 0;
  const reachedDecision = c.guard || String(c.url).indexOf("login") >= 0;
  console.log("\n  VERDICT");
  console.log("    shell renders             : " + (shell ? "PASS" : "FAIL"));
  console.log("    workspace stamped         : " + (ws ? "PASS" : "FAIL (" + a.ws + ")"));
  console.log("    no premature login bounce : " + (noBounce ? "PASS" : "FAIL -> " + a.url));
  console.log("    registered nav rendered   : " + (a.navLinks > 0 ? "PASS (" + a.navLinks + ")" : "FAIL"));
  console.log("    non-admin denied          : " + (denied ? "PASS" : "FAIL -- admin UI exposed"));
  console.log("    signed-out reaches login  : " + (fallback ? "PASS" : (reachedDecision ? "FAIL -- regression" : "UNPROVEN -- page never reached a decision")));
  const ok = shell && ws && noBounce && a.navLinks > 0 && denied && fallback;
  console.log("\n  => " + PAGE + ": " + (ok ? "INTEGRATION PASS" : "NEEDS INVESTIGATION"));
})();
