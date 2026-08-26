/* Phase 3/4 measurement helper — real assertions, not fixed sentences.
   Uses the technique proven on admin.html: intercept the ES module firebase.js so
   `import { auth }` resolves, then observe what the PAGE actually does.

   Everything here is SYNTHETIC INTEGRATION EVIDENCE. Stubbed claims prove the
   wiring executes; they prove NOTHING about whether Firebase and the security
   rules enforce authorization. Never relabel these as authorization certification.
*/
"use strict";
const fs = require("fs"), path = require("path");

function stubModule(root, claims, opts) {
  opts = opts || {};
  let t = fs.readFileSync(path.join(root, "scripts/fixtures/firebase-stub-module.js"), "utf8")
    .split("__CLAIMS__").join(JSON.stringify(claims));
  if (opts.signedOut) t = t.replace("currentUser: user,", "currentUser: null,")
                           .replace("try { cb(user); }", "try { cb(null); }");
  /* deliberate failure mode: token verification throws, so the page must DENY */
  if (opts.tokenError) t = t.replace("getIdTokenResult: async () => ({ claims, token: \"stub\" })",
    "getIdTokenResult: async () => { throw new Error('stub: verification unavailable'); }");
  return t;
}

async function observe(chromium, root, base, page, claims, opts) {
  opts = opts || {};
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.route("**/firebase.js", r => r.fulfill({ status: 200,
    contentType: "application/javascript", body: stubModule(root, claims, opts) }));
  const p = await ctx.newPage();
  const errs = [];
  p.on("pageerror", e => errs.push(String(e.message).slice(0, 60)));
  let r = { loadError: null };
  try {
    await p.goto(base + "/" + page, { waitUntil: "domcontentloaded", timeout: 25000 });
    await p.waitForTimeout(1200);
    try { await p.waitForFunction(() => { const s = document.getElementById("sk-splash");
      if (!s) return true; const c = getComputedStyle(s);
      return c.display === "none" || c.visibility === "hidden" || Number(c.opacity) < 0.05;
    }, { timeout: 10000 }); } catch (e) {}
    await p.waitForTimeout(2800);
    r = await p.evaluate(() => ({
      url: location.pathname + location.search,
      entryLoaded: typeof window.SokoniAdminEntry !== "undefined",
      guardLoaded: typeof window.SokoniAdminGuard !== "undefined",
      claimedRole: window._admClaimedRole || null,
      adminCtx: !!(window.SokoniAdminEntry && (window.__adminContext || window._adminContext ||
                   (typeof window.SokoniAdminEntry.context === "function" ? window.SokoniAdminEntry.context() : null))),
      shell: !!document.getElementById("sk-adm-header") && !!document.getElementById("sk-adm-side"),
      denial: /access required|not carry an admin|insufficient|cannot verify/i.test(document.body.innerText || ""),
      passcodePrompt: /passcode|enter pin|master code/i.test(document.body.innerText || ""),
      bodyText: (document.body.innerText || "").trim().slice(0, 60).replace(/\n/g, " "),
    }));
  } catch (e) { r.loadError = String(e.message).slice(0, 50); }
  await b.close();
  r.pageErrors = errs;
  return r;
}
module.exports = { observe, stubModule };
