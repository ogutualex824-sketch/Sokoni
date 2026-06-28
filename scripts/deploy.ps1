# ============================================================
#  SOKONI -- Full Platform Deployment Script
#
#  Deploys all platform components in the correct order:
#    1. Firestore Security Rules
#    2. Firestore Indexes
#    3. Cloud Functions
#    4. Hosting
#    5. Monitoring Alerts
#    6. Git Push (with confirmation)
#
#  Usage:
#    .\scripts\deploy.ps1                   # Full deployment (all steps)
#    .\scripts\deploy.ps1 -only functions   # Deploy functions only
#    .\scripts\deploy.ps1 -only hosting     # Deploy hosting only
#    .\scripts\deploy.ps1 -only rules       # Deploy Firestore rules only
#    .\scripts\deploy.ps1 -only indexes     # Deploy Firestore indexes only
#
#  Prerequisites:
#    firebase login
#    gcloud auth login
#    .\scripts\setup-secrets.ps1   (run once before first deploy)
# ============================================================

#Requires -Version 5.1
param(
    [ValidateSet('all', 'functions', 'hosting', 'rules', 'indexes')]
    [string]$only = 'all'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ── Step tracking ─────────────────────────────────────────────────────────────

$script:StepsPassed  = New-Object System.Collections.Generic.List[string]
$script:StepsFailed  = New-Object System.Collections.Generic.List[string]
$script:StepsSkipped = New-Object System.Collections.Generic.List[string]

function Record-Pass   { param([string]$Label) $script:StepsPassed.Add($Label)  }
function Record-Fail   { param([string]$Label) $script:StepsFailed.Add($Label)  }
function Record-Skip   { param([string]$Label) $script:StepsSkipped.Add($Label) }

# ── Output helpers ────────────────────────────────────────────────────────────

function Write-Banner {
    Write-Host ""
    Write-Host "============================================================" -ForegroundColor Cyan
    Write-Host "   SOKONI -- Full Platform Deployment" -ForegroundColor Cyan
    Write-Host "   Mode  : $only" -ForegroundColor Cyan
    Write-Host "   Time  : $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" -ForegroundColor Cyan
    Write-Host "============================================================" -ForegroundColor Cyan
    Write-Host ""
}

function Write-Step {
    param([string]$Msg)
    Write-Host ""
    Write-Host "------------------------------------------------------------" -ForegroundColor DarkGray
    Write-Host $Msg -ForegroundColor Cyan
    Write-Host "------------------------------------------------------------" -ForegroundColor DarkGray
}

function Write-OK   { param([string]$Msg) Write-Host "  [OK]   $Msg" -ForegroundColor Green }
function Write-Skip { param([string]$Msg) Write-Host "  [SKIP] $Msg" -ForegroundColor DarkGray }
function Write-Warn { param([string]$Msg) Write-Host "  [WARN] $Msg" -ForegroundColor Yellow }
function Write-Fail { param([string]$Msg) Write-Host "  [FAIL] $Msg" -ForegroundColor Red }

# ── Pre-flight checks ─────────────────────────────────────────────────────────

Write-Banner
Write-Step "Pre-flight Checks"

# 1. firebase CLI
Write-Host "  Checking firebase CLI..." -NoNewline
$firebaseVersion = firebase --version 2>$null
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($firebaseVersion)) {
    Write-Host ""
    Write-Fail "firebase CLI not found."
    Write-Host ""
    Write-Host "  Install it with:" -ForegroundColor Yellow
    Write-Host "    npm install -g firebase-tools" -ForegroundColor White
    Write-Host "  Then run: firebase login" -ForegroundColor White
    exit 1
}
Write-Host " $firebaseVersion" -ForegroundColor Green

# 2. gcloud CLI
Write-Host "  Checking gcloud CLI..." -NoNewline
gcloud version 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Fail "gcloud CLI not found."
    Write-Host ""
    Write-Host "  Install Google Cloud SDK from: https://cloud.google.com/sdk/docs/install" -ForegroundColor Yellow
    exit 1
}
Write-Host " OK (SDK found)" -ForegroundColor Green

# 3. .firebaserc
Write-Host "  Checking .firebaserc..." -NoNewline
if (-not (Test-Path ".firebaserc")) {
    Write-Host ""
    Write-Fail ".firebaserc not found. Run this script from the SOKONI root directory."
    exit 1
}
try {
    $config  = Get-Content ".firebaserc" -Raw | ConvertFrom-Json
    $PROJECT = $config.projects.default
} catch {
    Write-Fail "Could not parse .firebaserc: $_"
    exit 1
}
if ([string]::IsNullOrWhiteSpace($PROJECT)) {
    Write-Fail ".firebaserc does not contain projects.default"
    exit 1
}
Write-Host " project: $PROJECT" -ForegroundColor Green

# 4. Git working tree status
Write-Host "  Checking git working tree..." -NoNewline
$gitDirty = git status --porcelain 2>$null
if ($LASTEXITCODE -eq 0) {
    if ([string]::IsNullOrWhiteSpace($gitDirty)) {
        Write-Host " clean" -ForegroundColor Green
    } else {
        Write-Host ""
        Write-Warn "Working tree has uncommitted changes. Deploying anyway (not blocked)."
        Write-Host "  Consider committing before deploying to keep deploy history aligned." -ForegroundColor DarkGray
    }
} else {
    Write-Host ""
    Write-Warn "Could not run git status -- not a git repo or git not installed."
}

# 5. Print current branch and last commit
$branch = git rev-parse --abbrev-ref HEAD 2>$null
$commit = git log -1 --format="%h -- %s" 2>$null
if ($LASTEXITCODE -eq 0) {
    Write-OK "Branch : $branch"
    Write-OK "Commit : $commit"
}

Write-OK "Pre-flight checks complete. Starting deployment."

# =============================================================================
# STEP 1 -- Firestore Security Rules
# =============================================================================

if ($only -eq 'all' -or $only -eq 'rules') {
    Write-Step "[1/6] Deploying Firestore Security Rules..."

    firebase deploy --only firestore:rules --project $PROJECT
    if ($LASTEXITCODE -ne 0) {
        Write-Fail "Firestore Rules deploy FAILED (exit $LASTEXITCODE)"
        Record-Fail "Rules"
        # Rules failure is critical -- abort to prevent deploying functions against broken rules
        Write-Host ""
        Write-Host "  Aborting deployment. Fix the rules error above and re-run." -ForegroundColor Red
        exit 1
    }
    Write-OK "Firestore Security Rules deployed successfully."
    Record-Pass "Rules"
} else {
    Write-Skip "[1/6] Rules -- not selected (mode: $only)"
    Record-Skip "Rules"
}

# =============================================================================
# STEP 2 -- Firestore Indexes
# =============================================================================

if ($only -eq 'all' -or $only -eq 'indexes') {
    Write-Step "[2/6] Deploying Firestore Indexes..."

    if (-not (Test-Path "firestore.indexes.json")) {
        Write-Fail "firestore.indexes.json not found."
        Record-Fail "Indexes"
        if ($only -eq 'indexes') { exit 1 }
    } else {
        $indexCount = -1
        try {
            $indexData  = Get-Content "firestore.indexes.json" -Raw | ConvertFrom-Json
            $indexCount = ($indexData.indexes | Measure-Object).Count
        } catch {
            Write-Fail "Could not parse firestore.indexes.json: $_"
            Record-Fail "Indexes"
            if ($only -eq 'indexes') { exit 1 }
        }

        if ($indexCount -gt 200) {
            Write-Host ""
            Write-Warn "firestore.indexes.json contains $indexCount indexes."
            Write-Warn "Firestore allows a maximum of 200 composite indexes per database."
            Write-Host ""
            Write-Host "  ACTION REQUIRED -- split indexes before deploying:" -ForegroundColor Yellow
            Write-Host "    1. Run:  node scripts/split-indexes.js" -ForegroundColor White
            Write-Host "       This separates indexes into:" -ForegroundColor White
            Write-Host "         firestore.indexes.json               -- primary database (<=200)" -ForegroundColor White
            Write-Host "         firestore.indexes.sokoni-ops.json    -- sokoni-ops database" -ForegroundColor White
            Write-Host "    2. Deploy primary:  firebase deploy --only firestore:indexes" -ForegroundColor White
            Write-Host "    3. Deploy ops DB:   firebase deploy --only firestore:indexes --database sokoni-ops" -ForegroundColor White
            Write-Host ""
            Write-Warn "Skipping index deploy until split is complete."
            Record-Skip "Indexes (over 200 - needs split)"
        } elseif ($indexCount -ge 0) {
            Write-OK "Index count: $indexCount (within 200 limit)"
            firebase deploy --only firestore:indexes --project $PROJECT
            if ($LASTEXITCODE -ne 0) {
                Write-Fail "Firestore Index deploy FAILED (exit $LASTEXITCODE)"
                Record-Fail "Indexes"
                if ($only -eq 'indexes') { exit 1 }
                Write-Warn "Continuing deployment despite index failure."
            } else {
                Write-OK "Firestore Indexes deployed successfully."
                Record-Pass "Indexes"
            }
        }
        # else: parse error already recorded above
    }
} else {
    Write-Skip "[2/6] Indexes -- not selected (mode: $only)"
    Record-Skip "Indexes"
}

# =============================================================================
# STEP 3 -- Cloud Functions
# =============================================================================

if ($only -eq 'all' -or $only -eq 'functions') {
    Write-Step "[3/6] Deploying Cloud Functions..."
    Write-Host "  This step typically takes 5-15 minutes for a full deployment." -ForegroundColor DarkGray
    Write-Host "  For individual functions use: firebase deploy --only functions:functionName" -ForegroundColor DarkGray
    Write-Host "  For batch deployment use:     bash scripts/batch_deploy.sh" -ForegroundColor DarkGray
    Write-Host ""

    $fnStart = Get-Date
    firebase deploy --only functions --project $PROJECT
    $fnElapsed = [int](New-TimeSpan -Start $fnStart -End (Get-Date)).TotalSeconds

    if ($LASTEXITCODE -ne 0) {
        Write-Fail "Cloud Functions deploy FAILED after ${fnElapsed}s (exit $LASTEXITCODE)"
        Record-Fail "Functions"
        Write-Host ""
        Write-Host "  Troubleshooting tips:" -ForegroundColor Yellow
        Write-Host "    - Check syntax errors:  node --check functions/index.js" -ForegroundColor White
        Write-Host "    - View logs:            firebase functions:log --project $PROJECT" -ForegroundColor White
        Write-Host "    - Deploy in batches:    bash scripts/batch_deploy.sh" -ForegroundColor White
        Write-Host "    - Check quota limits:   https://console.cloud.google.com/functions?project=$PROJECT" -ForegroundColor White
        if ($only -eq 'functions') { exit 1 }
        Write-Warn "Continuing deployment despite Functions failure."
    } else {
        Write-OK "Cloud Functions deployed successfully in ${fnElapsed}s."
        Record-Pass "Functions"
    }
} else {
    Write-Skip "[3/6] Functions -- not selected (mode: $only)"
    Record-Skip "Functions"
}

# =============================================================================
# STEP 4 -- Hosting
# =============================================================================

if ($only -eq 'all' -or $only -eq 'hosting') {
    Write-Step "[4/6] Deploying Hosting..."

    firebase deploy --only hosting --project $PROJECT
    if ($LASTEXITCODE -ne 0) {
        Write-Fail "Hosting deploy FAILED (exit $LASTEXITCODE)"
        Record-Fail "Hosting"
        if ($only -eq 'hosting') { exit 1 }
        Write-Warn "Continuing despite Hosting failure."
    } else {
        Write-OK "Hosting deployed successfully."
        Write-OK "Live URL: https://$PROJECT.web.app"
        Record-Pass "Hosting"
    }
} else {
    Write-Skip "[4/6] Hosting -- not selected (mode: $only)"
    Record-Skip "Hosting"
}

# =============================================================================
# STEP 5 -- Monitoring Alerts
# =============================================================================

if ($only -eq 'all') {
    Write-Step "[5/6] Setting up Monitoring Alerts..."

    $alertScript = "scripts/setup-monitoring-alerts.sh"
    if (Test-Path $alertScript) {
        # Locate bash (Git Bash or WSL)
        $bashCmd = Get-Command bash -ErrorAction SilentlyContinue
        if ($null -ne $bashCmd) {
            bash $alertScript
            if ($LASTEXITCODE -ne 0) {
                Write-Warn "Monitoring alerts script exited with code $LASTEXITCODE."
                Write-Warn "Check the output above. Alerts may be partially configured."
                Record-Skip "Monitoring (partial failure)"
            } else {
                Write-OK "Monitoring alerts configured successfully."
                Record-Pass "Monitoring"
            }
        } else {
            Write-Warn "bash not found on PATH -- cannot run $alertScript"
            Write-Warn "Run manually: bash scripts/setup-monitoring-alerts.sh"
            Record-Skip "Monitoring (bash not found)"
        }
    } else {
        Write-Warn "$alertScript not found -- skipping."
        Write-Warn "Run manually once available: bash scripts/setup-monitoring-alerts.sh"
        Record-Skip "Monitoring (script not found)"
    }
} else {
    Write-Skip "[5/6] Monitoring -- skipped (mode: $only)"
    Record-Skip "Monitoring"
}

# =============================================================================
# STEP 6 -- Git Push
# =============================================================================

if ($only -eq 'all') {
    Write-Step "[6/6] Git Push..."

    $aheadOutput = git rev-list --count origin/main..HEAD 2>$null
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($aheadOutput)) {
        $aheadCount = '?'
    } else {
        $aheadCount = $aheadOutput.Trim()
    }

    Write-Host "  Current branch   : $branch"
    Write-Host "  Commits ahead    : $aheadCount"
    Write-Host "  Last commit      : $commit"
    Write-Host ""

    if ($aheadCount -eq '0') {
        Write-OK "Already up to date with origin/main. Nothing to push."
        Record-Skip "Git Push (already up to date)"
    } else {
        $confirm = Read-Host "  Push $aheadCount commit(s) to origin/main? (y/N)"
        if ($confirm -eq 'y' -or $confirm -eq 'Y') {
            git push origin main
            if ($LASTEXITCODE -ne 0) {
                Write-Fail "git push FAILED (exit $LASTEXITCODE)"
                Record-Fail "Git Push"
            } else {
                Write-OK "Pushed to origin/main successfully."
                Record-Pass "Git Push"
            }
        } else {
            Write-Skip "Git push skipped by user."
            Write-Host "  Push manually when ready:  git push origin main" -ForegroundColor DarkGray
            Record-Skip "Git Push (user declined)"
        }
    }
} else {
    Write-Skip "[6/6] Git push -- skipped (mode: $only)"
    Record-Skip "Git Push"
}

# =============================================================================
# FINAL SUMMARY
# =============================================================================

Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "   Deployment Summary" -ForegroundColor Cyan
Write-Host "   $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host ""

if ($script:StepsPassed.Count -gt 0) {
    Write-Host "  Deployed:" -ForegroundColor Green
    foreach ($s in $script:StepsPassed) {
        Write-Host "    [OK]   $s" -ForegroundColor Green
    }
}

if ($script:StepsSkipped.Count -gt 0) {
    Write-Host ""
    Write-Host "  Skipped / Pending:" -ForegroundColor DarkGray
    foreach ($s in $script:StepsSkipped) {
        Write-Host "    [--]   $s" -ForegroundColor DarkGray
    }
}

if ($script:StepsFailed.Count -gt 0) {
    Write-Host ""
    Write-Host "  Failed:" -ForegroundColor Red
    foreach ($s in $script:StepsFailed) {
        Write-Host "    [FAIL] $s" -ForegroundColor Red
    }
}

Write-Host ""
if ($script:StepsFailed.Count -eq 0) {
    Write-Host "  Status: DEPLOYMENT SUCCESSFUL" -ForegroundColor Green
} else {
    Write-Host "  Status: DEPLOYMENT COMPLETED WITH ERRORS" -ForegroundColor Yellow
    Write-Host "  Review the failures listed above before considering this deployment stable." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "  Post-deployment checklist:" -ForegroundColor Cyan
Write-Host "    [ ] Verify live site:     https://$PROJECT.web.app"
Write-Host "    [ ] Check Functions log:  firebase functions:log --project $PROJECT"
Write-Host "    [ ] Check Firestore:      https://console.firebase.google.com/project/$PROJECT/firestore"
Write-Host "    [ ] Run pre-deploy check: node scripts/pre-deploy-check.js"
Write-Host "    [ ] Verify monitoring:    https://console.cloud.google.com/monitoring?project=$PROJECT"
Write-Host ""
Write-Host "  Manual steps still required:" -ForegroundColor Yellow
Write-Host "    [ ] Enable PITR on Firestore (bash scripts/enable-pitr.sh)"
Write-Host "    [ ] Confirm 18+ Cloud Monitoring alerts are active"
Write-Host "    [ ] Update CHANGELOG.md with this deployment entry"
Write-Host "    [ ] Rotate any placeholder API keys (SENDGRID, ANTHROPIC, INTASEND)"
Write-Host "    [ ] Split indexes if count exceeds 200 (node scripts/split-indexes.js)"
Write-Host ""
