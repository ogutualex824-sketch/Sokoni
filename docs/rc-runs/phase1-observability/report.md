# RC1 Run — phase1-observability

- Backend: `production(admin)`
- Started: 2026-07-24T07:53:03.975Z
- Privileged claims: refused
- Summary: **2 pass · 1 fail · 2 blocked**

## Release Candidate Coverage

| Suite | Result |
|---|---|
| RC-07 GDPR Data Export (state-transition verified) | FAIL |

```
PASS:    2
FAIL:    1
BLOCKED: 2
```

**Untested capabilities:**

- GDPR: callable entry
- GDPR: status lifecycle
- GDPR: artifact delivery

## RC-07 — GDPR Data Export (state-transition verified)  →  FAIL

- ⊘ **Callable entry requestDataExport (real client path)** — BLOCKED: callable entry not exercisable here (functions/unauthenticated) — requestDataExport is enforceAppCheck:true and headless Chromium has no App Check token. The WO
    - `assertion`: {"type":"assertion","callable":{"ok":false,"code":"functions/unauthenticated","msg":"Unauthenticated"}}
- ✓ **Enqueue exactly what the callable writes (status + queue doc)** — PASS: enqueued for uid=uKV3G82KOUWxXDsgnEUb3CfEJet1
    - `firestore`: {"type":"firestore","req":"dataExportRequests/rc-gdpr-probe","queue":"dataExportQueue/rc-gdpr-probe","uid":"uKV3G82KOUWxXDsgnEUb3CfEJet1","seededStatus":"pendin
- ✓ **Worker fires and status advances beyond pending** — PASS: observed: pending → failed
    - `assertion`: {"type":"assertion","observedTransitions":[{"status":"pending","at":"2026-07-24T07:53:32.709Z"},{"status":"failed","at":"2026-07-24T07:53:36.072Z"}],"final":"fa
- ✗ **Lifecycle reaches ready (or fails with a reason, never silently)** — FAIL: EXECUTION DEFECT: export still fails (code=permission_denied). Diagnostics are present, so this is now actionable — but the export itself is NOT fixed.
    - `assertion`: {"type":"assertion","failed":true,"failureCode":"permission_denied","failureReason":"We could not complete your data export. Please request it again; if it keep
- ⊘ **Artifact exists and is reachable (download link honoured)** — BLOCKED: gated on the lifecycle reaching ready
