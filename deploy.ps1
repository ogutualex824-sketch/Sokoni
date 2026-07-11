# SOKONI Deploy Script
# Usage: .\deploy.ps1            — deploy functions only
#        .\deploy.ps1 -target hosting  — deploy hosting only
#        .\deploy.ps1 -target all      — deploy everything
#
# FUNCTIONS_DISCOVERY_TIMEOUT: index.js loads in ~7s; the Firebase CLI default
# is 10s which is too tight. 30s gives headroom as the codebase grows.

param(
    [string]$target = "functions"
)

$env:FUNCTIONS_DISCOVERY_TIMEOUT = "30000"

switch ($target) {
    "functions" { firebase deploy --only functions --project sokoni-aeb26 }
    "hosting"   { firebase deploy --only hosting --project sokoni-aeb26 }
    "rules"     { firebase deploy --only firestore:rules,storage --project sokoni-aeb26 }
    "indexes"   { firebase deploy --only firestore:indexes --project sokoni-aeb26 }
    "all"       { firebase deploy --project sokoni-aeb26 }
    default     { firebase deploy --only $target --project sokoni-aeb26 }
}
