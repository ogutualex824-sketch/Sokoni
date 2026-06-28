# ============================================================
#  SOKONI -- Secret Manager Setup Script
#  Run once before first deployment to create all required
#  Firebase Secret Manager secrets for the SOKONI platform.
#
#  Prerequisites:
#    gcloud auth login
#    gcloud config set project sokoni-aeb26
#    firebase login
#
#  Usage:
#    .\scripts\setup-secrets.ps1
#
#  What this script does:
#    Section 1 -- Auto-generates cryptographically secure keys
#                 (LOYALTY_HMAC_SECRET, PAYMENT_HMAC_SECRET,
#                  PAYROLL_ENCRYPTION_KEY, SOKONI_HMAC_KEY)
#    Section 2 -- Prompts for secrets that require real API keys
#                 (SENDGRID_API_KEY, ANTHROPIC_API_KEY, INTASEND_PRIVATE_KEY)
#    Section 3 -- Grants Cloud Functions service account access
#                 to all secrets via IAM bindings
# ============================================================

#Requires -Version 5.1
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ── Helpers ──────────────────────────────────────────────────────────────────

function Write-Banner {
    Write-Host ""
    Write-Host "============================================================" -ForegroundColor Cyan
    Write-Host "   SOKONI Secret Manager Setup" -ForegroundColor Cyan
    Write-Host "   Setting up all required Firebase Secret Manager secrets" -ForegroundColor Cyan
    Write-Host "============================================================" -ForegroundColor Cyan
    Write-Host ""
}

function Write-Section {
    param([string]$Title)
    Write-Host ""
    Write-Host "---- $Title ----" -ForegroundColor Yellow
}

function Write-OK   { param([string]$Msg) Write-Host "  [OK]   $Msg" -ForegroundColor Green }
function Write-Skip { param([string]$Msg) Write-Host "  [SKIP] $Msg" -ForegroundColor DarkGray }
function Write-Warn { param([string]$Msg) Write-Host "  [WARN] $Msg" -ForegroundColor Yellow }
function Write-Fail { param([string]$Msg) Write-Host "  [FAIL] $Msg" -ForegroundColor Red }

function Secret-Exists {
    param([string]$Name, [string]$Project)
    gcloud secrets describe $Name --project $Project 2>$null | Out-Null
    return ($LASTEXITCODE -eq 0)
}

function Generate-HexSecret {
    # Generate 32 cryptographically random bytes -> 64-char hex string
    $bytes = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    return ($bytes | ForEach-Object { $_.ToString('x2') }) -join ''
}

function Create-AutoSecret {
    param([string]$Name, [string]$Project)

    if (Secret-Exists -Name $Name -Project $Project) {
        Write-Skip "$Name already exists - skipping"
        return
    }

    Write-Host "  Generating $Name ..." -NoNewline
    $hex = Generate-HexSecret
    # Pipe value through stdin to avoid value appearing in process list
    $hex | gcloud secrets create $Name --data-file=- --project $Project --quiet 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Host ""
        Write-Fail "$Name -- creation FAILED (exit $LASTEXITCODE)"
        throw "Failed to create secret: $Name"
    }
    Write-Host " done" -ForegroundColor Green
    Write-OK "$Name created (64-char hex)"
}

function Create-ManualSecret {
    param(
        [string]$Name,
        [string]$Project,
        [string]$Hint
    )

    if (Secret-Exists -Name $Name -Project $Project) {
        Write-Skip "$Name already exists - skipping"
        return
    }

    Write-Host ""
    Write-Host "  $Name" -ForegroundColor White
    Write-Host "  Source : $Hint" -ForegroundColor DarkGray
    $value = Read-Host "  Enter value (input will be visible - paste carefully)"
    $value = $value.Trim()

    if ([string]::IsNullOrEmpty($value)) {
        Write-Warn "$Name -- skipped (empty value). Functions using this secret WILL FAIL at runtime."
        return
    }

    $value | gcloud secrets create $Name --data-file=- --project $Project --quiet 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Fail "$Name -- creation FAILED (exit $LASTEXITCODE)"
        throw "Failed to create secret: $Name"
    }
    Write-OK "$Name created successfully"
}

# ── Entry Point ───────────────────────────────────────────────────────────────

Write-Banner

# ── Auth check ───────────────────────────────────────────────────────────────
Write-Host "Checking gcloud authentication..." -ForegroundColor Cyan

$authOutput = gcloud auth list --filter="status:ACTIVE" --format="value(account)" 2>$null
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($authOutput)) {
    Write-Host ""
    Write-Fail "No active gcloud account found."
    Write-Host ""
    Write-Host "  Run the following to authenticate, then re-run this script:" -ForegroundColor Yellow
    Write-Host "    gcloud auth login" -ForegroundColor White
    Write-Host "    gcloud config set project sokoni-aeb26" -ForegroundColor White
    Write-Host ""
    exit 1
}
Write-OK "Authenticated as: $authOutput"

# ── Read project ID from .firebaserc ─────────────────────────────────────────
if (-not (Test-Path ".firebaserc")) {
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

Write-OK "Firebase project: $PROJECT"

# ── Enable Secret Manager API (idempotent) ────────────────────────────────────
Write-Host ""
Write-Host "Ensuring Secret Manager API is enabled..." -ForegroundColor Cyan
gcloud services enable secretmanager.googleapis.com --project $PROJECT --quiet 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Warn "Could not enable Secret Manager API - it may already be enabled, or you lack permissions."
}

# =============================================================================
# SECTION 1 -- Auto-generated secrets (no user input required)
# =============================================================================
Write-Section "Section 1 -- Auto-Generated Cryptographic Keys"
Write-Host "  These secrets are generated locally and stored securely in Secret Manager."
Write-Host "  They are skipped automatically if they already exist."

$autoSecrets = @(
    'LOYALTY_HMAC_SECRET',
    'PAYMENT_HMAC_SECRET',
    'PAYROLL_ENCRYPTION_KEY',
    'SOKONI_HMAC_KEY'
)

foreach ($secret in $autoSecrets) {
    Create-AutoSecret -Name $secret -Project $PROJECT
}

# =============================================================================
# SECTION 2 -- Secrets requiring real API credentials
# =============================================================================
Write-Section "Section 2 -- API Keys (Manual Entry Required)"
Write-Host "  You will be prompted to paste each key."
Write-Host "  Press ENTER with no value to skip a key (functions using it will fail at runtime)."

Create-ManualSecret `
    -Name    'SENDGRID_API_KEY' `
    -Project $PROJECT `
    -Hint    'sendgrid.com -> Settings -> API Keys (starts with SG.)'

Create-ManualSecret `
    -Name    'ANTHROPIC_API_KEY' `
    -Project $PROJECT `
    -Hint    'console.anthropic.com -> API Keys (starts with sk-ant-)'

Create-ManualSecret `
    -Name    'INTASEND_PRIVATE_KEY' `
    -Project $PROJECT `
    -Hint    'intasend.com -> Dashboard -> API Keys -> Private Key (PEM format)'

# =============================================================================
# SECTION 3 -- Grant Cloud Functions service account access to all secrets
# =============================================================================
Write-Section "Section 3 -- IAM Bindings (Cloud Functions Access)"
Write-Host "  Granting roles/secretmanager.secretAccessor to the Cloud Functions service account."

$SA = "sokoni-firebase@$PROJECT.iam.gserviceaccount.com"
Write-Host "  Service account: $SA"
Write-Host ""

$allSecrets = @(
    'LOYALTY_HMAC_SECRET',
    'PAYMENT_HMAC_SECRET',
    'PAYROLL_ENCRYPTION_KEY',
    'SOKONI_HMAC_KEY',
    'SENDGRID_API_KEY',
    'ANTHROPIC_API_KEY',
    'INTASEND_PRIVATE_KEY'
)

foreach ($secret in $allSecrets) {
    # Only bind if the secret actually exists (may have been skipped above)
    if (Secret-Exists -Name $secret -Project $PROJECT) {
        Write-Host "  Binding $secret ..." -NoNewline
        gcloud secrets add-iam-policy-binding $secret `
            --project $PROJECT `
            --member "serviceAccount:$SA" `
            --role roles/secretmanager.secretAccessor `
            --quiet 2>$null
        if ($LASTEXITCODE -ne 0) {
            Write-Host " FAILED" -ForegroundColor Red
            Write-Warn "Could not bind $secret - check IAM permissions and retry."
        } else {
            Write-Host " done" -ForegroundColor Green
        }
    } else {
        Write-Skip "Skipping IAM binding for $secret (secret does not exist)"
    }
}

# ── Verification ──────────────────────────────────────────────────────────────
Write-Section "Verification"
Write-Host "  Checking all secrets are accessible..."
Write-Host ""

$requiredSecrets = @(
    'LOYALTY_HMAC_SECRET',
    'PAYMENT_HMAC_SECRET',
    'PAYROLL_ENCRYPTION_KEY',
    'SOKONI_HMAC_KEY',
    'SENDGRID_API_KEY',
    'ANTHROPIC_API_KEY',
    'INTASEND_PRIVATE_KEY'
)

$allOk   = $true
$missing = @()

foreach ($secret in $requiredSecrets) {
    if (Secret-Exists -Name $secret -Project $PROJECT) {
        Write-OK $secret
    } else {
        Write-Fail "$secret -- NOT FOUND"
        $allOk   = $false
        $missing += $secret
    }
}

# ── Summary ───────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "   Setup Complete" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host ""

if ($allOk) {
    Write-Host "  All secrets are set. You are ready to deploy Cloud Functions." -ForegroundColor Green
} else {
    Write-Host "  The following secrets are still missing:" -ForegroundColor Yellow
    foreach ($s in $missing) {
        Write-Host "    - $s" -ForegroundColor Red
    }
    Write-Host ""
    Write-Host "  Cloud Functions that reference missing secrets will crash on cold start." -ForegroundColor Yellow
    Write-Host "  Re-run this script after obtaining the missing keys." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "  Next steps:" -ForegroundColor Cyan
Write-Host "    .\scripts\deploy.ps1                     # Full platform deployment"
Write-Host "    .\scripts\deploy.ps1 -only functions     # Functions only"
Write-Host "    bash scripts/setup-monitoring-alerts.sh  # Monitoring alerts"
Write-Host ""
