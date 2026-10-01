# Deploy evidence — K13 application decision authority (functions)

## K13-A — applicationDecide + applicationReconcile
```
Date (UTC)              : 2026-10-01T01:47:19Z → 01:54:33Z
Target                  : firebase deploy --only functions:applicationDecide,functions:applicationReconcile
Source tree / commit    : C:/temp/sok-k13a @ 7df7817 (hotfix/k13a-application-decision-authority), clean
Lineage check           : parent 7df7817^ require-closure of application-lifecycle.js == live applicationDecide archive
                          (10/10 files identical); live generation re-confirmed unchanged immediately before deploy
DEPLOY ENVIRONMENT      : preflight READY twice (01:44Z, 669 MB); launch gated by an atomic preflight (525 MB at launch)
DEPLOY                  : exit 0; "Deploy complete!"; both "Successful update operation"
PREDEPLOY GATES         : NOT EXECUTED — quoted $RESOURCE_DIR hook form never runs on this machine (log shows hook
                          lines with zero output). Fixed afterwards in 03772ab. Code verified independently below.
POST-DEPLOY
  Revisions             : applicationdecide-00007-pex (01:54:23Z), applicationreconcile-00007-jeg (01:54:30Z), ACTIVE
  Served source         : downloaded live archives; application-lifecycle.js blob 5d658cd == 7df7817 (both)
  Function check        : unauthenticated POST → 401
  Behaviour (pre-deploy): test-k13a-decision-authority 11/0; counterproof on production code shows the defects
RESULT                  : LIVE-VERIFIED (code); gates not executed (recorded)
Rollback                : redeploy from 7df7817^ (live archive 09-09 generations 1787598887701693 / 1787598933636246)
```
Two earlier attempts were DEPLOYMENT NOT EXECUTED: 00:59Z killed by a 590 s tool timeout while still in predeploy
(nothing uploaded); 01:12Z launched at 248 MB without a fresh preflight and stopped pre-upload by the operator.

## K13-B — applicationLifecycle
```
Date (UTC)              : 2026-10-01T02:03:33Z → 02:11:01Z
Target                  : firebase deploy --only functions:applicationLifecycle
Source tree / commit    : C:/temp/sok-k13b @ f66f2c1 (hotfix/k13b-lifecycle-decision-authority), clean
Lineage check           : parent 055e509 require-closure == live applicationLifecycle archive (10/10); live generation
                          1788716739456910 re-confirmed immediately before deploy
DEPLOY ENVIRONMENT      : atomic preflight READY at launch (702 MB)
DEPLOY                  : exit 0; "Deploy complete!"; "Successful update operation"
PREDEPLOY GATES         : NOT EXECUTED (same hook defect; see 03772ab)
POST-DEPLOY
  Revision              : applicationlifecycle-00008-vaf (02:10:49Z), ACTIVE
  Served source         : application-lifecycle.js blob 8a6f453 == f66f2c1; contains the applicationDecisions check
  Behaviour (pre-deploy): test-k13b-lifecycle-authority 8/0; counterproof shows the defect on production code
RESULT                  : LIVE-VERIFIED (code); gates not executed (recorded)
Rollback                : redeploy from 055e509 (live archive generation 1788716739456910)
```
Effect: an application decision now projects only when a server decision record (applicationDecisions/{appId},
client-unwritable) names an administrator who is not the applicant; the self-approval path to claims.admin is closed.
