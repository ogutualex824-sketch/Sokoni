# Deploy evidence record (template)

Owner rule, 2026-10-01: a deploy command that exits successfully is **not** proof. Every production deploy records the fields below, filled from observation.

- **No record** means **DEPLOYMENT NOT EXECUTED**. It never means "failed", and it never means "passed".
- A field that could not be observed says `not observed` with the reason. It is never left blank or guessed.

Copy this block per deploy into `docs/release-gates/<slug>.md`.

```
DEPLOY EVIDENCE — <slug>
Date (UTC)              :
Operator session        : sokoni-27
Target                  : <firebase deploy --only …  (exact, no blanket targets)>
Source tree / commit    : <path> @ <full sha>   clean: <yes/no — git status --short output>
Lineage check           : <functions: live-archive closure diff result | hosting: live commit is ancestor (yes/no)>

DEPLOY ENVIRONMENT
  Preflight (before)    : <environment-preflight --for <window> RESULT, record path>
  RAM before deploy     : <free physical MB / free virtual MB>
  RAM at deploy         : <free physical MB at command start>
  Peer deploys running  : <none | who>

DEPLOY
  Command               :
  Exit code             :
  CLI "Deploy complete" : <present / absent>

POST-DEPLOY
  Deployed revision     : <functions: gcloud revision + updateTime | hosting: version.json commit + cacheVersion>
  HTTP check            : <exact URL + status + marker/byte digest>
  Function check        : <unauthenticated call → expected 401/403 JSON | describe state ACTIVE>
  Header check          : <live header values that the change was meant to set>
  Behaviour check       : <what was exercised live, or "not observed" + reason>

RESULT                  : <LIVE-VERIFIED | DEPLOYED-UNVERIFIED (what is missing) | DEPLOYMENT NOT EXECUTED>
Rollback                : <previous revision / hosting version to restore>
```

The environment preflight already writes a JSON record per check under `%LOCALAPPDATA%\Temp\sokoni-preflight\`. Cite the path in "Preflight (before)".
