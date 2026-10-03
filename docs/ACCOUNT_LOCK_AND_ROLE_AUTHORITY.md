# Account lock (suspension · ban) and role authority

Owner rulings 2026-10-04. Status: **built and unit-tested, NOT deployed.** Related: [[Authentication]] · [[SECURITY]] · [[USERS_DOCUMENT_INTEGRITY]] · [[AdminOS]].

## One contract for every account lock

`functions/shared/account-suspension.js` `setSuspension()` is the **only** writer of account-lock state. Callers:

| Caller | Surface | Kinds |
|---|---|---|
| `suspendUser` (super-admin.js) | AdminOS Users, Super Admin Users | suspend, lift, `kind:'ban'` lift |
| `tsBanUser` (trust-safety.js) | Trust & Safety console | `ban`, `suspend`, `restore` (lift suspension), `unban` (lift ban) |
| `tsReviewReport` `banUser:true` | Trust & Safety reports | ban (previously a status-only write) |
| `expireSuspensions` (account-suspension-expiry.js) | hourly scheduler | lift an **expired suspension** only |

### Kinds

| | Suspension | Ban |
|---|---|---|
| `users/{uid}.status` | `suspended` | `banned` (+ `banReason`, `bannedBy`, `bannedAt`) |
| Auth | disabled + refresh tokens revoked | the same |
| Duration | `SUSPENSION_DAYS` (14), server-fixed → `suspendedUntil` | permanent (`suspendedUntil: null`) |
| Auto-lift | yes, by the scheduler, through the same contract | **never** |
| Lift | "Reinstate" (reason required) | "Lift ban" — a separate decision (reason required) |

A suspension call never downgrades or lifts a ban, and a ban lift never ends a suspension. A ban on a suspended account escalates it.
Clients cannot choose a length (`durationDays` is refused everywhere). The UIs show the server's `suspendedUntil`, or `—` when it is unknown.

### Records (one `eventId` across all of them)
Every real change writes `accountSuspensions` (history), `adminAudit`, `auditLog` (severity `high`, which Super Admin's Audit Log
reads), and `trustSafetyAudit`. Each carries the actor, target, action, timestamp, reason, resulting state and `eventId`. A repeated
call that changes nothing writes nothing.

### Authorization
- The actor must hold the `superAdmin` claim **and** have an active account (`shared/account-state.js`).
- Self-actions and locking another super admin are refused.
- The `{ system: true }` actor may only lift an expired suspension (`source:'auto_expiry'`). It can never suspend, ban or lift a ban.

### Auto-expiry safety
- **Exactly once.** A lift claims `suspensionLifts/{uid}_{untilMs}` with `create()` before Auth is touched. A concurrent job run or a simultaneous manual reinstate loses the claim and writes nothing. Only ALREADY_EXISTS counts as a lost race; any other claim failure aborts the lift. A claim abandoned for more than 10 minutes may be taken over.
- **Fails closed.** A missing or unreadable `suspendedUntil` is never lifted. The 00:xx UTC run flags such accounts in `suspensionExpiryFlags/{uid}`.
- **Bounded.** Each run processes 100 × 5 pages; the remainder waits for the next hourly run. Index: `users (status ASC, suspendedUntil ASC)`.

### Legacy `banned` records
Records written by the old `tsBanUser` (`status:'banned'`, Auth still enabled):
- **Treated as banned.** The server (`assertAccountActive`) and Firestore rules (f3) deny them.
- **Locking.** Re-banning completes the Auth lockout.
- **Lifting.** An explicit unban restores them.
- **No automatic conversion.** Normalisation is a separate, controlled operation.

## One role authority

- **`setUserRole` = the live AdminOS Authority Core (05df4c9), carried line for line.** `authority-control-events.js` is byte-identical to live. It:
  - preserves every non-role claim;
  - keeps `permsVersion` monotonic (never downgraded);
  - writes a `controlEvents` precondition, then lets exactly one execution win;
  - is idempotent per `requestId`;
  - uses a fenced finalize;
  - writes an `auditLog` severity-high entry.
- **Stated adaptations:** the handler is named (`_setUserRoleHandler`); the audit carries the operator's `reason`; the actor's account must be active.
- **`adminUpdateUserRole` (AdminOS) delegates to the same handler.** Live, it **overwrote** the claims with `{[role]: true, ...additional}`. `additionalClaims` is refused.
- **Both UIs send a per-dialog `requestId`.** `provider` is not a role here: provider status comes from the approval authority.

## Deploy guard
`scripts/deploy/guard-tree-scope.js` is the **first** functions predeploy hook. Together with `deploy-scope.json`, it refuses:
- an unscoped deploy;
- any function outside the allow-list;
- any function in `reconciliationRequired` without a `reconciled` record (`live`, `candidate` = HEAD, `approvedBy`);
- a dirty `functions/` tree.

Launch only via `node scripts/deploy/deploy-scoped.js <fns> --config firebase.json`.

## Tests (offline, firewalled)
| Suite | Rows | Mutants |
|---|---|---|
| `test-account-suspension.js` | 22 | 9/9 killed |
| `test-suspension-expiry.js` | 9 | 6/6 |
| `test-set-user-role.js` | 9 | 7/7 |
| `test-deploy-reconciliation-guard.js` | 10 | 3/3 |
| `test-admin-users-workspace.js` | 14 | — |

**Not yet run:**
- the rules emulator suites and deliberate breaks (f3; memory-gated);
- browser E2E at ≥700 MB from both UIs;
- the production census of legacy `banned` accounts;
- the live comparison for `tsReviewReport` and `expireSuspensions` (new).
