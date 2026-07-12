# SOKONI — Firestore & Storage Security Rules Review (H1)

**Date:** 2026-07-12 · **Scope:** `firestore.rules` (4,210 lines / 599 match blocks) + `storage.rules`
**Reviewer verdict:** **Score 4 / 5 — Minor.** One real defect found and **fixed**; one **HIGH** privacy leak found and **NOT** fixed (requires a path migration — flagged, not blind-patched).

---

## Assessment (JSON)

```json
{
  "score": 4,
  "summary": "Rules are well-constructed: role checks come from custom claims (never client data), money collections are Cloud-Function-only, wallets cannot be self-credited, orders are ownership-scoped, KYC/identity documents are owner+admin only, and Storage has a proper default-deny catch-all. Zero unrestricted writes exist. Two issues found: financial ledgers were client-writable by an admin token (FIXED, deployed), and chat attachments are readable by any authenticated user (HIGH, open — needs a path restructure).",
  "findings": [
    {
      "check": "Authority Source / ledger immutability",
      "severity": "major",
      "issue": "commissionLedger and sellerPayments were `allow write: if isAdmin()`. A client holding an admin token could mutate financial records and tamper with the commission ledger directly, defeating the audit trail.",
      "recommendation": "FIXED (1961616, deployed): set `allow write: if false`. Cloud Functions use the Admin SDK which bypasses rules, and 0 client files write these collections — so this is zero-impact and makes the ledger immutable from any client."
    },
    {
      "check": "Field-Level vs Identity-Level Security / cross-user leakage",
      "severity": "major",
      "issue": "storage.rules `match /chatAttachments/{uid}/{allPaths=**}` has `allow read: if request.auth != null`. ANY authenticated user can read ANY other user's private chat attachments. Path contains only the uploader uid, so rules cannot scope reads to conversation participants.",
      "recommendation": "OPEN. Restructure to `/chatAttachments/{conversationId}/{uid}/...` and gate reads on conversation membership (`firestore.get(/databases/(default)/documents/conversations/$(conversationId)).data.participants.hasAny([request.auth.uid])`). NOT patched here: narrowing to owner-only would break the recipient's ability to view attachments (a functional regression), and changing the path requires migrating existing attachment URLs."
    },
    {
      "check": "Storage Abuse / resource exhaustion",
      "severity": "minor",
      "issue": "Same authenticated-read pattern on creative-assets and community-media. Less sensitive than chat, but creative-assets is documented as holding receipts and delivery proof.",
      "recommendation": "Scope creative-assets reads to owner+admin unless an asset is explicitly published."
    }
  ]
}
```

---

## ✅ Verified SECURE (evidence)

| Control | Finding |
|---|---|
| **Privilege escalation** | Roles come from **custom claims** (`request.auth.token.admin / superAdmin`), **never** from client-supplied document data. Explicit `noPrivilegeEscalation()` and `noAdminFields()` helpers block role/admin fields in writes. |
| **Wallet self-credit** | `wallets` create requires **`request.resource.data.balance == 0`** — a user cannot mint a balance. All mutations `isAdmin()` (i.e. Cloud Functions). |
| **Payment collections** | `payments` and `posPayments` → **`allow write: if false`** (CF-only). |
| **Wallet transactions** | `walletTxns` → all writes admin/CF-only; reads owner-scoped. |
| **Cross-tenant leakage (orders)** | `orders` reads scoped to admin **or** buyer/seller/assigned-driver uid. No merchant can read another merchant's orders. |
| **KYC / identity documents** | `/kyc-documents/{uid}` and `/documents/{uid}` → read **owner or admin only**. National IDs, licences, KRA PINs are **not** exposed. |
| **Storage default** | `match /{allPaths=**} { allow read, write: if false; }` — proper **default-deny**. |
| **Unrestricted writes** | **ZERO.** No `allow write/create/update: if true` anywhere. |
| **Public reads (68)** | All are **catalog/marketing content** — products, listings, sellers, reviews, venues, campaigns. **No PII, no financial data.** Appropriate for a public marketplace. |
| **Wildcard catch-all** | The only `{document=**}` is **scoped** to `/tenants/{tenantId}/` and gated on tenant membership — not a global wildcard. |
| **Uploads** | Size caps + `safeImageOnly()` / `notExecutable()` (blocks SVG/XSS and executables) on every write path. |

---

## 🔴 SEC-F1 — FIXED & DEPLOYED (`1961616`)

**Financial ledgers were client-writable.**
```diff
  match /commissionLedger/{entryId} {
-   allow write: if isAdmin();
+   allow write: if false;   // CF-only (Admin SDK bypasses rules); ledger immutable
  }
  match /sellerPayments/{paymentId} {
-   allow write: if isAdmin();
+   allow write: if false;
  }
```
**Impact:** an admin token (or a compromised/over-scoped one) could rewrite commission entries and payment records from a browser, defeating the financial audit trail.
**Safety of the fix:** Cloud Functions use the Admin SDK, which **bypasses rules entirely**, and **0 client files** write either collection → **zero functional impact**. Deployed and validated.

---

## 🟠 SEC-F2 — OPEN (HIGH) — chat attachments readable by any signed-up user

```
match /chatAttachments/{uid}/{allPaths=**} {
  allow read: if request.auth != null;    // ← any authenticated user
}
```
Any registered user can read **any other user's** private chat attachments (IDs, invoices, photos shared in 1:1 chat). The path carries only the uploader's uid, so rules cannot check conversation membership.

**Why I did not patch it:** narrowing to owner-only (`request.auth.uid == uid`) would stop the **recipient** from viewing attachments sent to them — a real functional regression. The correct fix is a **path restructure + migration**, which must not be done blind.

**Recommended fix**
```
match /chatAttachments/{conversationId}/{uid}/{allPaths=**} {
  allow read: if request.auth != null
              && firestore.get(/databases/(default)/documents/conversations/$(conversationId))
                   .data.participants.hasAny([request.auth.uid]);
  allow write: if request.auth != null && request.auth.uid == uid && notExecutable()
               && request.resource.size < 100 * 1024 * 1024;
}
```
Requires: migrating existing attachment paths and updating the chat client's upload path.

---

## Status of H1

- **H1 (rules never reviewed) → REVIEW COMPLETE.** Rules are fundamentally sound (score 4/5).
- **SEC-F1 fixed and deployed.**
- **SEC-F2 remains open (HIGH).** It is a **privacy** leak, not a money leak — it does **not** block the money path, but it **must** be closed before broad public launch.

Related: [[RELEASE_v1.0.0_STATUS]] · [[MONEY_PATH_VERIFICATION]]
