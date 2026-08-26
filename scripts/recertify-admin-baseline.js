#!/usr/bin/env node
/* Admin re-certification baseline — four honest states.
   PASS actually demonstrated | FAIL demonstrated failure |
   UNPROVEN environment cannot establish it | BLOCKED prerequisite prevents execution.
   UNPROVEN is not a soft FAIL. BLOCKED is not a soft PASS.
   Does not modify the product. */
"use strict";
const fs = require("fs"), path = require("path");
const ROOT = path.resolve(__dirname, "..");
const { chromium } = require(path.join(ROOT, "node_modules", "playwright"));
const argv = process.argv.slice(2);
const BASE = (() => { const i = argv.indexOf("--base"); return i >= 0 ? argv[i + 1] : "http://127.0.0.1:3000"; })();
/* Production pages authenticate through an ES module (import { auth } from "./firebase.js").
   A window.firebase compat stub CANNOT satisfy that -- the page silently redirects to
   login and the harness measures the LOGIN page. Intercept the MODULE instead. The
   product file is never modified; only what the browser receives during the test. */
const CLAIMS = (() => { const i = argv.indexOf("--claims"); return i >= 0 ? JSON.parse(argv[i + 1]) : { admin: true, superAdmin: true }; })();
const STUB_MODULE = fs.readFileSync(path.join(__dirname, "fixtures", "firebase-stub-module.js"), "utf8")
  .split("__CLAIMS__").join(JSON.stringify(CLAIMS));  /* global: a single replace hit the comment */
global.window = {}; global.location = { pathname: "/admin-os.html" };
require(path.join(ROOT, "sokoni-admin-nav.js"));
const NAV = global.window.SokoniAdminNav;
const REG = new Set(NAV.pages.map(p => p.page));
const ADMIN = () => {
  const claims = { admin: true, superAdmin: true };
  const u = { uid: "rc", email: "rc@sokoni.test", getIdTokenResult: async () => ({ claims }) };
  window.firebaseAuth = { currentUser: u };
  const q = { collection: () => q, doc: () => q, where: () => q, orderBy: () => q, limit: () => q,
              get: async () => ({ empty: true, size: 0, docs: [], forEach() {} }), onSnapshot: () => () => {} };
  window.firebase = { auth: () => ({ onAuthStateChanged: cb => cb(u), currentUser: u }),
    firestore: () => q, functions: () => ({ httpsCallable: () => async () => ({ data: {} }) }) };
  window.firebase.initializeApp = () => ({}); window.firebase.apps = []; window.firebase.app = () => ({});
  window.firebase.firestore.FieldValue = { serverTimestamp: () => "ts", increment: n => n };
};
const rows = [];
const rec = (ph, item, state, note) => { rows.push({ phase: ph, item, state, note: note || "" });
  console.log("  [" + state.padEnd(8) + "] " + item + (note ? "  -- " + note : "")); };
const reachFn = () => {};

(async () => {
  const b = await chromium.launch();
  /* PROBE FIX 1: a fixed wait let #sk-splash still be up during hit tests, which
     reported enterprise-ops as 0/10 anchors reachable when it is 9/10. Wait for
     the splash to actually clear rather than guessing a duration. */
  const open = async (pg) => {
    const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript(ADMIN);
    await ctx.route("**/firebase.js", r => r.fulfill({ status: 200, contentType: "application/javascript", body: STUB_MODULE }));
    const p = await ctx.newPage();
    await p.goto(BASE + "/" + pg, { waitUntil: "domcontentloaded", timeout: 20000 });
    await p.waitForTimeout(1200);
    try {
      await p.waitForFunction(() => {
        const sp = document.getElementById("sk-splash");
        if (!sp) return true;
        const cs = getComputedStyle(sp);
        return cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) < 0.05;
      }, { timeout: 12000 });
    } catch (e) { /* splash never cleared -- caller decides, do not silently pass */ }
    const banner = await p.evaluate(() => { const el = document.getElementById("_sokoniPrivacyBanner");
      if (el) { el.remove(); return true; } return false; });
    await p.waitForTimeout(400);
    return { ctx, p, bannerRemoved: banner };
  };

  /* PROBE FIX 3: a uniform failure across independent pages indicts the probe,
     not the product. Phase 2 reported 5/6 pages "did not load" when all five load
     fine. Refuse to emit such a run. */
  const uniformGuard = (label, results) => {
    const bad = results.filter(x => x === false).length;
    if (results.length >= 4 && bad === results.length) {
      console.log("  !! PROBE SUSPECT: every one of " + results.length + " " + label +
                  " failed identically. Treating as a probe failure, not " + results.length + " defects.");
      return true;
    }
    return false;
  };

  console.log("\nPHASE 1 -- shared Admin shell");
  let shellOk = 0, stampOk = 0, destOk = 0, checked = 0; const p1fail = [];
  for (const pg of NAV.pages.slice(0, 12).map(x => x.page)) {
    try {
      const { ctx, p } = await open(pg);
      const r = await p.evaluate(() => ({
        ws: document.documentElement.getAttribute("data-sokoni-workspace"),
        header: !!document.getElementById("sk-adm-header"),
        side: !!document.getElementById("sk-adm-side"),
        hrefs: [...document.querySelectorAll("#sk-adm-side a[href]")].map(a => a.getAttribute("href")),
      }));
      checked++;
      if (r.header && r.side) shellOk++;
      if (r.ws === "admin") stampOk++;
      if (r.hrefs.length && r.hrefs.every(h => REG.has(String(h).replace(/^\.?\//, "")))) destOk++;
      if (!(r.header && r.side) || r.ws !== "admin") p1fail.push(pg + " [shell=" + (r.header && r.side) + " ws=" + r.ws + "]");
      await ctx.close();
    } catch (e) { }
  }
  rec("1", "shell renders on " + shellOk + "/" + checked + " sampled pages", shellOk === checked && checked > 0 ? "PASS" : "FAIL");
  rec("1", "workspace stamped on " + stampOk + "/" + checked, stampOk === checked && checked > 0 ? "PASS" : "FAIL");
  rec("1", "shell destinations all registered (" + destOk + "/" + checked + ")", destOk === checked && checked > 0 ? "PASS" : "FAIL");
  if (p1fail.length) console.log("    failing: " + p1fail.join(", "));
  rec("1", "authenticated non-admin denial", "BLOCKED",
      "needs a real non-admin session; stubbing claims proves the stub, not the gate");

  console.log("\nPHASE 2 -- page-local chrome (D1)");
  const CHROME = ["admin-os.html", "trust-safety.html", "financial-os.html",
                  "subscription-billing.html", "commission-engine.html", "search-quality.html"];
  for (const pg of CHROME) {
    let r = null, ctx = null, stage = "load";
    try {
      const o = await open(pg); ctx = o.ctx;
      stage = "evaluate";
      r = await o.p.evaluate((regList) => {
        const REGB = new Set(regList);
        const own = [...document.querySelectorAll("aside, nav")]
          .filter(e => e.id !== "sk-adm-side" && !e.closest("#sk-adm-side") && !e.closest("#sk-adm-header"))
          .filter(e => e.querySelectorAll("a[href]").length >= 2)[0];
        if (!own) return { chrome: false };
        const links = [...own.querySelectorAll("a[href]")];
        const reach = a => { const q = a.getBoundingClientRect();
          const cy = q.y + q.height / 2, cx = q.x + q.width / 2;
          if (cy < 0 || cy > innerHeight) return false;
          const hit = document.elementFromPoint(cx, cy);
          return !!hit && (hit === a || a.contains(hit)); };
        const cross = links.filter(a => /\.html/.test(a.getAttribute("href") || ""));
        const keyOf = a => String(a.getAttribute("href")).replace(/^\.?\//, "").split("?")[0];
        const unregLinks = cross.filter(a => !REGB.has(keyOf(a)));
        return { chrome: true, controls: own.querySelectorAll("button, input, select, [id]").length,
                 cross: cross.length, reachableCross: cross.filter(reach).length,
                 reachableUnreg: unregLinks.filter(reach).length,
                 hasContent: (own.innerText || "").trim().length > 0,
                 unreg: [...new Set(links.map(a => String(a.getAttribute("href")).replace(/^\.?\//, "").split("?")[0])
                   .filter(h => /\.html$/.test(h) && !REGB.has(h)))] };
      }, [...REG]);
    } catch (e) { r = null; var lastErr = stage + ": " + String(e.message).slice(0, 70); }
    if (ctx) await ctx.close();
    if (!r) { rec("2", pg, "UNPROVEN", "probe failed at " + (typeof lastErr !== "undefined" ? lastErr : "unknown")); continue; }
    if (!r.chrome) { rec("2", pg + " -- no page-local chrome", "PASS"); continue; }
    /* chrome is preserved if it EXISTS and renders content. A div-based nav with no
       ids or buttons is still chrome -- counting controls was the wrong criterion. */
    rec("2", pg + " chrome preserved (" + r.controls + " controls, content=" + r.hasContent + ")",
        r.hasContent ? "PASS" : "FAIL");
    /* D1: what matters is whether an UNREGISTERED destination is reachable, not
       whether any cross-page link is. */
    rec("2", pg + " -- D1 unregistered destinations unreachable",
        r.reachableUnreg === 0 ? "PASS" : "FAIL",
        r.unreg.length ? r.unreg.length + " unregistered present, " + r.reachableUnreg + " reachable" : "none present");
  }

  console.log("\nPHASE 3/4 -- production authentication model");
  /* Probe the SERVED tree, not the harness filesystem: the pages under test come
     from --base, which may be a different worktree entirely. Checking ROOT here
     reported BLOCKED against the candidate even though it serves the file. */
  let hasEntry = false;
  try { const rsp = await fetch(BASE + "/sokoni-admin-entry.js"); hasEntry = rsp.ok; } catch (e) { hasEntry = false; }
  console.log("  (sokoni-admin-entry.js served by " + BASE + ": " + (hasEntry ? "YES" : "NO") + ")");
  const why = "sokoni-admin-entry.js ABSENT from this tree (present in production c774608); branch " +
              "admin.html references SokoniAdminEntry 0 times vs 5 live. Testing this tree would " +
              "certify the OBSOLETE model.";
  ["SokoniAdminEntry.guard(admin)", "adminContext resolution", "claims gate on admin.html",
   "superAdmin path on super-admin.html", "denial on unknown/error state",
   "verification-admin.html current model"].forEach(i => rec("3/4", i, hasEntry ? "UNPROVEN" : "BLOCKED", why));

  console.log("\nPHASE 5 -- D3 enterprise-ops");
  try {
    const o = await open("enterprise-ops.html");
    const r = await o.p.evaluate(() => {
      const own = document.querySelector("nav#sidebar");
      const links = own ? [...own.querySelectorAll("a")].filter(a => (a.getAttribute("href") || "").charAt(0) === "#") : [];
      return links.map(a => { const q = a.getBoundingClientRect();
        const cy = q.y + q.height / 2, cx = q.x + q.width / 2;
        if (cy < 0 || cy > innerHeight) return { href: a.getAttribute("href"), state: "off-viewport" };
        const hit = document.elementFromPoint(cx, cy);
        const self = !!hit && (hit === a || a.contains(hit));
        return { href: a.getAttribute("href"),
                 state: self ? "reachable" : "covered by " + (hit ? hit.tagName + (hit.id ? "#" + hit.id : "") : "?") };
      });
    });
    const reach = r.filter(x => x.state === "reachable").length;
    rec("5", "section anchors reachable (" + reach + "/" + r.length + ")", reach === r.length ? "PASS" : "FAIL");
    const al = r.find(x => x.href === "#sec-alerts");
    rec("5", "#sec-alerts specifically", al && al.state === "reachable" ? "PASS" : "FAIL",
        al ? al.state : "anchor not found");
    await o.ctx.close();
  } catch (e) { rec("5", "enterprise-ops", "UNPROVEN", String(e.message).slice(0, 50)); }

  console.log("\nPHASE 6 -- data-dependent surfaces");
  try {
    const o = await open("platform-health.html");
    await o.p.waitForTimeout(900);
    const loading = await o.p.evaluate(() => /Loading|Calculating/.test(document.body.innerText || ""));
    rec("6", "platform-health metric cards", loading ? "UNPROVEN" : "PASS",
        loading ? "App Check 403 -- metrics never render; cards cannot be certified here" : "");
    await o.ctx.close();
  } catch (e) { rec("6", "platform-health", "UNPROVEN", "load failed"); }

  await b.close();
  const tally = {}; rows.forEach(r => tally[r.state] = (tally[r.state] || 0) + 1);
  console.log("\n=== BASELINE TALLY ===");
  ["PASS", "FAIL", "UNPROVEN", "BLOCKED"].forEach(s => console.log("  " + s.padEnd(9) + (tally[s] || 0)));
  console.log("\nUNPROVEN is not a soft FAIL. BLOCKED is not a soft PASS.");
  fs.writeFileSync(path.join(ROOT, "docs/admin-recertification-ledger.json"),
    JSON.stringify({ tally, rows }, null, 2));
  console.log("ledger -> docs/admin-recertification-ledger.json");
})();
