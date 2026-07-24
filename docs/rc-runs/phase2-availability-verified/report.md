# RC1 Run — phase2-availability-verified

- Backend: `production(admin)`
- Started: 2026-07-24T07:59:12.059Z
- Privileged claims: refused
- Summary: **4 pass · 0 fail · 1 blocked**

## Release Candidate Coverage

| Suite | Result |
|---|---|
| RC-07 GDPR Data Export (state-transition verified) | PASS (Partial) |

```
PASS:    4
FAIL:    0
BLOCKED: 1
```

**Untested capabilities:**

- GDPR: callable entry

## RC-07 — GDPR Data Export (state-transition verified)  →  PARTIAL

- ⊘ **Callable entry requestDataExport (real client path)** — BLOCKED: callable entry not exercisable here (functions/unauthenticated) — requestDataExport is enforceAppCheck:true and headless Chromium has no App Check token. The WO
    - `assertion`: {"type":"assertion","callable":{"ok":false,"code":"functions/unauthenticated","msg":"Unauthenticated"}}
- ✓ **Enqueue exactly what the callable writes (status + queue doc)** — PASS: enqueued for uid=uKV3G82KOUWxXDsgnEUb3CfEJet1
    - `firestore`: {"type":"firestore","req":"dataExportRequests/rc-gdpr-probe","queue":"dataExportQueue/rc-gdpr-probe","uid":"uKV3G82KOUWxXDsgnEUb3CfEJet1","seededStatus":"pendin
- ✓ **Worker fires and status advances beyond pending** — PASS: observed: pending → ready
    - `assertion`: {"type":"assertion","observedTransitions":[{"status":"pending","at":"2026-07-24T07:59:34.993Z"},{"status":"ready","at":"2026-07-24T07:59:38.285Z"}],"final":"rea
- ✓ **Lifecycle reaches ready (or fails with a reason, never silently)** — PASS: reached ready
- ✓ **Artifact exists and is reachable (download link honoured)** — PASS: downloadUrl + expiresAt present
    - `assertion`: {"type":"assertion","downloadUrl":"present","expiresAt":"2026-07-31T07:59:30.154Z"}
