"use strict";

/**
 * SOKONI — Firestore Security Rules Static Audit
 *
 * Validates the firestore.rules file without a live emulator:
 *  - All critical collections have explicit rule declarations
 *  - No collection allows unauthenticated writes to financial data
 *  - Required helper functions are present
 *  - High-value collections use ownership or admin checks
 */

const fs   = require("fs");
const path = require("path");

const RULES_PATH = path.resolve(__dirname, "../../firestore.rules");
const rules = fs.readFileSync(RULES_PATH, "utf8");

/* ── Helpers ── */
function ruleContains(pattern) {
  return typeof pattern === "string"
    ? rules.includes(pattern)
    : pattern.test(rules);
}

function collectionHasRule(collectionName) {
  return rules.includes(`/${collectionName}/{`) || rules.includes(`/${collectionName}/{`);
}

/* ─────────────────────────────────────────────────────────────────────────── */

describe("Firestore rules — helper functions", () => {
  test("isAuthed() helper is defined", () => {
    expect(ruleContains("function isAuthed()")).toBe(true);
  });

  test("isAdmin() helper is defined", () => {
    expect(ruleContains("function isAdmin()")).toBe(true);
  });

  test("isAdmin() uses custom claim (not just email)", () => {
    /* Must check request.auth.token.admin rather than email string matching */
    expect(ruleContains(/function isAdmin\(\)[^}]*request\.auth\.token\.admin/s)).toBe(true);
  });

  test("isOwner() or ownership check pattern exists", () => {
    const hasOwner    = ruleContains("function isOwner");
    const hasOwnerOf  = ruleContains("resource.data.uid == request.auth.uid");
    expect(hasOwner || hasOwnerOf).toBe(true);
  });
});

describe("Firestore rules — financial collections locked from public write", () => {
  const financialCollections = [
    "orders",
    "payments",
    "paymentVerifications",
    "checkoutSessions",
    "subscriptions",
    "commissions",      /* used by wap.js — rule added */
    "commissionLedger", /* canonical revenue engine collection */
    "escrow",
    "securityEvents",
  ];

  for (const coll of financialCollections) {
    test(`${coll} has explicit rule block`, () => {
      expect(collectionHasRule(coll)).toBe(true);
    });
  }

  test("paymentVerifications blocks all client writes", () => {
    /* Rule must deny create/update/delete from clients */
    const hasAllowFalse = rules.match(/paymentVerifications[\s\S]{0,500}allow\s+write\s*:\s*if\s+false/);
    const hasCreateFalse = rules.match(/paymentVerifications[\s\S]{0,500}allow\s+create\s*:\s*if\s+false/);
    expect(!!(hasAllowFalse || hasCreateFalse)).toBe(true);
  });

  test("checkoutSessions blocks all client creates", () => {
    const match = rules.match(/checkoutSessions[\s\S]{0,500}allow\s+create\s*:\s*if\s+false/);
    expect(match).not.toBeNull();
  });

  test("rateLimits blocks all client writes", () => {
    const match = rules.match(/rateLimits[\s\S]{0,500}allow\s+write\s*:\s*if\s+false/);
    expect(match).not.toBeNull();
  });

  test("_systemConfig blocks all client writes", () => {
    const match = rules.match(/_systemConfig[\s\S]{0,500}allow\s+write\s*:\s*if\s+false/);
    expect(match).not.toBeNull();
  });
});

describe("Firestore rules — admin-only collections", () => {
  const adminCollections = ["securityEvents", "fraudLog", "auditLog", "_systemConfig", "rateLimits"];

  for (const coll of adminCollections) {
    test(`${coll} requires admin for read (or is not publicly readable)`, () => {
      /* Collection must exist in rules — absence from rules defaults to deny */
      const exists = collectionHasRule(coll);
      if (!exists) {
        /* Default-deny is acceptable for admin collections not explicitly listed */
        expect(true).toBe(true);
        return;
      }
      /* If the collection has explicit rules, verify it doesn't allow any()==read */
      const noPublicRead = !rules.match(
        new RegExp(`/${coll}/[^{]+[\\s\\S]{0,500}allow\\s+read\\s*:\\s*if\\s+true`)
      );
      expect(noPublicRead).toBe(true);
    });
  }
});

describe("Firestore rules — user data ownership", () => {
  test("orders readable only by owner or admin", () => {
    const ownerCheck = rules.match(/\/orders\/[^{]+[\s\S]{0,800}request\.auth\.uid/);
    expect(ownerCheck).not.toBeNull();
  });

  test("checkoutSessions readable only by owner", () => {
    const match = rules.match(/checkoutSessions[\s\S]{0,500}resource\.data\.uid\s*==\s*request\.auth\.uid/);
    expect(match).not.toBeNull();
  });

  test("paymentVerifications readable by owner or admin", () => {
    const ownerOrAdmin = rules.match(
      /paymentVerifications[\s\S]{0,600}(resource\.data\.uid\s*==\s*request\.auth\.uid|isAdmin\(\))/
    );
    expect(ownerOrAdmin).not.toBeNull();
  });
});

describe("Firestore rules — authentication requirements", () => {
  test("products can be read unauthenticated (public catalog)", () => {
    /* Browsing the marketplace must not require sign-in */
    const publicRead = rules.match(
      /\/products\/[\s\S]{0,300}allow\s+read\s*:/
    );
    expect(publicRead).not.toBeNull();
  });

  test("no collection allows unauthenticated write (allow write: if true)", () => {
    const dangerousWrite = /allow\s+write\s*:\s*if\s+true/.test(rules);
    expect(dangerousWrite).toBe(false);
  });

  test("no collection allows unauthenticated create (allow create: if true)", () => {
    const dangerousCreate = /allow\s+create\s*:\s*if\s+true/.test(rules);
    expect(dangerousCreate).toBe(false);
  });
});

describe("Firestore rules — security event logging", () => {
  test("securityEvents collection has a rule entry", () => {
    /* If present must deny client writes — injecting fake security events is an attack */
    const exists = collectionHasRule("securityEvents");
    if (exists) {
      const denyWrite = rules.match(/securityEvents[\s\S]{0,500}allow\s+write\s*:\s*if\s+false/);
      expect(denyWrite).not.toBeNull();
    } else {
      /* Default deny is also acceptable */
      expect(true).toBe(true);
    }
  });
});

describe("Firestore rules — file integrity", () => {
  test("rules file is non-empty", () => {
    expect(rules.length).toBeGreaterThan(1000);
  });

  test("rules file uses Firestore rules v2 format", () => {
    expect(ruleContains("rules_version = '2'")).toBe(true);
  });

  test("rules file has a service declaration", () => {
    expect(ruleContains("service cloud.firestore")).toBe(true);
  });

  test("rules file closes all braces consistently", () => {
    const opens  = (rules.match(/\{/g) || []).length;
    const closes = (rules.match(/\}/g) || []).length;
    expect(opens).toBe(closes);
  });
});
