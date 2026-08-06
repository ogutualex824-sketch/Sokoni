# Firestore Rules Release — 409 Escalation Bundle

**Status:** default-database `cloud.firestore` rules release cannot be updated; named-database release updates
normally. Reproducible on the latest CLI with correct IAM and config. Strong evidence of a **firebaserules
API / firebase-tools issue**, not a project misconfiguration. Non-blocking to the app (Cloud Functions write
via Admin SDK, which bypasses rules); blocks client reads of new analytics docs.

Related: [[Analytics Engine Roadmap]] (Milestone B is gated on this).

## Symptom
`firebase deploy --only firestore:rules` fails:
```
Error: Request to https://firebaserules.googleapis.com/v1/projects/sokoni-aeb26/releases
had HTTP Error: 409, Requested entity already exists
```
The default `cloud.firestore` release has been frozen since **2026-08-03** (all default-DB rules deploys fail).

## Environment (all correct)
- **firebase-tools:** 15.26.0 (latest at time of capture)
- **Project:** `sokoni-aeb26`
- **Databases:** `(default)` and `sokoni-ops` (both exist)
- **IAM:** sufficient — the `sokoni-ops` rules release updates successfully with the same account/token
- **firebase.json `firestore`:** multi-database array —
  `[{database:"(default)", rules:"firestore.rules"}, {database:"sokoni-ops", rules:"firestore.rules.sokoni-ops"}]`
- `firestore.rules` **compiles successfully** every run.

## Root cause — exact API behavior (from `firebase deploy --only firestore:rules --debug`)
The CLI PATCHes both releases with an **identical** body `{release:{name, rulesetName}}`. The API responds
DIFFERENTLY by release name:
```
PATCH /v1/projects/sokoni-aeb26/releases/cloud.firestore
      {release:{name, rulesetName}}                         → 400 INVALID_ARGUMENT  "Request contains an invalid argument."
PATCH /v1/projects/sokoni-aeb26/releases/cloud.firestore/sokoni-ops
      {release:{name, rulesetName}}                         → 200 OK                (identical body shape!)
```
On the 400, firebase-tools falls back to create:
```
POST  /v1/projects/sokoni-aeb26/releases
      {name:"projects/sokoni-aeb26/releases/cloud.firestore", rulesetName:…}  → 409 ALREADY_EXISTS
```
**The core anomaly:** the same PATCH request is accepted for the named-DB release (`cloud.firestore/sokoni-ops`)
but rejected with 400 for the default release (`cloud.firestore`). Because create then 409s (the release exists
since 2026-05-24), there is no CLI/REST path to update the default release.

## Resources
- **Default release:** `projects/sokoni-aeb26/releases/cloud.firestore`
  - createTime `2026-05-24T23:21:33Z`, updateTime **`2026-08-03T11:13:21Z`** (frozen)
  - current rulesetName `projects/sokoni-aeb26/rulesets/6d708181-2794-4f03-af48-c08b810cef58`
  - the CLI attempted to point it at `…/rulesets/cd26b8b6-c1cc-465f-926b-fc40b74737f3` (PATCH 400)
- **Named release (works):** `projects/sokoni-aeb26/releases/cloud.firestore/sokoni-ops`
  - updated to `…/rulesets/c76c080c-5073-4b3d-94bc-53d6d8254516` @ `2026-08-06T19:43:43Z`
- ~100+ rulesets accumulated historically (orphans; NOT the cause — ruleset creation succeeds).

## Tried (safe, non-destructive) — all reproduce the failure
1. `firebase deploy --only firestore:rules` on CLI 15.24 and 15.26 → 409.
2. Direct REST PATCH of the release (multiple documented body/mask shapes) → 400 INVALID_ARGUMENT.
3. **Single-database `firebase.json` workaround** (temporarily reduced to only the `(default)` entry, deployed,
   then restored) → **same 409** (the CLI still PATCHes `cloud.firestore`, which the API 400s).

## Deliberately NOT done (would risk downtime)
- Deleting the `cloud.firestore` release (rules-less window = all Firestore access denied on a live app).
- Deleting the `(default)` database. Force-create hacks. Hand-editing production rules.

## Ask for Google/Firebase support
Why does `releases.patch` on **`cloud.firestore`** return 400 INVALID_ARGUMENT while the **identical** call on
`cloud.firestore/sokoni-ops` returns 200? The default release appears to be in a state that rejects updates.
Requested: repair/refresh the `cloud.firestore` release so it accepts a rulesetName update (or advise the correct
update call), without a delete/recreate that would interrupt client access.

## Bundle to attach
- Full `--debug` log (the PATCH/POST/409 sequence above)
- project `sokoni-aeb26`; databases `(default)`, `sokoni-ops`
- release names + ruleset IDs (above); firebase-tools 15.26.0; firebase.json firestore block (above)
