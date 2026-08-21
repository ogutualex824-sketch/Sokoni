# Administrative Surface Reconciliation — `superadmin.html` vs `super-admin.html`

> **Status:** before-proof COMPLETE · **decision OUTSTANDING** · no file changed
> Register items 13 and F4 are the same question. Treat this as an authorization
> decision, not a duplicate-file cleanup.

Related: [[Access Control Matrix]] · [[Admin Console Integrity]] · [[Authentication]] · [[Users Document Integrity]]

---

## Why this exists

The F4 work brought three administrative surfaces under one model:

```
claims  →  adminContext  →  admin surface
```

It enumerated `admin.html`, `admin-os.html`, `super-admin.html`. There is a **fourth**:
`superadmin.html` (no hyphen), which never entered that census because it sits in
shared-header's `EXCLUDED` list.

It gates on the **claim alone**:

```js
if (!token.claims.superAdmin && !token.claims.admin) { _showDenied(...); }
```

So an administrator who switches to a workspace role still opens it — the exact defect F4
closed elsewhere. Measured by `scripts/before-admin-surface-gate.mjs` (S3, S5 FAIL).

---

## Question 1 — which surface is canonical?

**`super-admin.html`, decisively.**

| | `super-admin.html` | `superadmin.html` |
|---|---|---|
| bytes | 96,733 | 47,402 |
| commits | 17 | 11 |
| last touched | 2026-08-21 | 2026-08-12 |
| panes / sections | 54 | 22 |
| callables + collections | 19 | 7 |
| `adminHomeFor()` target | **yes** (`sokoni-permissions.js:362`) | no |
| in `sokoni-nav-engine.js` role map | **yes** | no |
| in command palette | **yes** | no |

`super-admin.html` is what the platform's own authority resolves to. `sokoni-permissions.js`
returns it from `adminHomeFor()`, `sokoni-nav-engine.js` maps `superAdmin` to it, and the command
palette, `profile.html`, `admin-os.html`, `splash.js` and `index.html` all point at it.

---

## Question 2 — which callers still reference `superadmin.html`?

Five sites, and only **one** is a user-facing entry point:

| site | kind | migratable |
|---|---|---|
| `admin.html:728` | sidebar link "👑 Super Admin ↗" | **yes** — repoint to `super-admin.html` |
| `navigation-registry.json:6652, 7385` | registry entries | yes — registry bookkeeping |
| `nav-active.js:147` | maps the page to `profile.html` | yes — drop the row |
| `vision-2030.html:509` | a page list | yes — list content |
| `shared-header.js:556` | `EXCLUDED` list | yes — drop the row |

No Cloud Function, security rule, or redirect targets it.

---

## Question 3 — can those callers migrate safely?

**Yes — no pane is unique to `superadmin.html`.** Every one is covered elsewhere:

| pane | covered by |
|---|---|
| users | `super-admin.html`, `admin.html`, `admin-os.html` |
| sellers | `super-admin.html`, `admin.html` |
| orders | `admin.html`, `admin-os.html` |
| payments | `admin.html`, `admin-os.html`, `payments.html` |
| moderation | `admin.html`, `moderation.html` |
| admins | `admin.html` |
| config | `super-admin.html`, `admin-os.html` |
| audit | `super-admin.html`, `admin-os.html` |
| monitor | `monitor.html` |

An earlier reading of this file inferred it was *not* a subset, from collection names
(`payments`, `reports`, `sellers`) absent from the canonical page. Pane coverage is the better
measure and contradicts that: the collections differ, the **capabilities** do not.

---

## The second inconsistency — and what it is not

```
super-admin.html   requires  superAdmin === true
superadmin.html    accepts   admin OR superAdmin
```

Two surfaces named for the same role disagree about who may open them. `superadmin.html` also
invokes `setUserRole` — the privilege-granting callable.

**This is not a privilege-escalation path.** `functions/super-admin.js:106` opens with
`_requireSuperAdmin(request)`, so a plain admin pressing that control is refused by the server.
The client-side inconsistency admits an administrator into a surface whose primary operation the
server will decline — a confusing failure, not an open door.

Recorded honestly: this was raised as a possible escalation and measurement says it is not one.

---

## Recommendation (decision is the owner's)

**Retire `superadmin.html`.** The evidence supports it: not canonical, one user-facing caller,
zero unique capability, no server or rule depends on it, and it is the only administrative surface
outside the F4 model.

Order, if that is the decision:

1. Repoint `admin.html:728` to `super-admin.html`.
2. Remove the `navigation-registry.json`, `nav-active.js`, `vision-2030.html` and
   `shared-header.js` EXCLUDED entries.
3. Prove no live caller remains — grep plus a browser pass over `admin.html`.
4. Only then remove the file, in its own commit.

**The alternative that must be rejected explicitly:** copying the F4 guard into `superadmin.html`.
That would bring it under the model while *preserving* two administrative entry points with
different admission rules — settling the duplication question by accident, in favour of keeping
both.

Do not act on this document without that decision being made deliberately.
