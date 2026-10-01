# Deploy evidence — Firestore rules emergency hotfix (verification badge + job create)

```
DEPLOY EVIDENCE — rules-hotfix-f259c0b5
Date (UTC)              : 2026-10-01T00:27:37Z
Operator                : prepared by sokoni-27; the release-pointer command was run by the OWNER (the session's
                          permission system refused it), on the owner's instruction "fix this or deploy the fix"
Target                  : Firestore rules, DEFAULT database only (releases/cloud.firestore). No indexes, no other
                          database, no CLI (Rules REST API: rulesets.create + releases.patch updateMask=rulesetName)
Source                  : LIVE b87c94e4 re-fetched at build time + exactly 3 hunks (sokoni-32's certified hunks,
                          comments dropped): verifications allow write:false; verificationRequests allow write:false;
                          /jobs create applicants tail parenthesised. Bytes 159009 → 158619 (-390).
Lineage check           : served source re-fetched immediately before; pointer was still b87c94e4 (updateTime
                          2026-09-29T20:43:02Z)

DEPLOY ENVIRONMENT
  Preflight             : hosting window NOT_READY on RAM (442 MB) — not applicable: two REST calls, no build,
                          no CLI, no browser, no emulator. No other deploy running (preflight: functions/hosting
                          deploy PASS, Cloud Build PASS).
  RAM at ruleset create : 186 MB free physical

DEPLOY
  rulesets.create       : projects/sokoni-aeb26/rulesets/f259c0b5-0a9e-49c5-8578-a628a40d946c (compiled OK, no issues)
  releases.patch        : run by the owner in their terminal (2026-10-01 ~00:27Z)

POST-DEPLOY
  Deployed revision     : releases/cloud.firestore → f259c0b5-0a9e-49c5-8578-a628a40d946c, updateTime 2026-10-01T00:27:37.561787Z
  Byte check            : live ruleset source == candidate byte-for-byte
  Behaviour check       : projects:test (real rules engine) against the LIVE source: 20 passed, 0 failed
                          counterproof against the previous live b87c94e4: all 4 hole cases ALLOW (forged approved
                          badge, direct verification request, signed-out job with applicants:0, job under another uid)
  Legit paths           : verificationSubmit / verificationDecide are server callables (Admin SDK, rules-exempt),
                          both live (401 unauthenticated); no client code writes either collection (census).
  Live write probe      : not performed — an unauthenticated write probe would create a production document if the
                          release had not taken; behaviour is evidenced by projects:test on the served bytes.

RESULT                  : LIVE-VERIFIED
Rollback                : point releases/cloud.firestore back to projects/sokoni-aeb26/rulesets/b87c94e4-33af-4af5-9ece-e7c1a103dec0
```
