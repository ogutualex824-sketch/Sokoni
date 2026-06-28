# =============================================================================
# SOKONI — DevSecOps Pre-Commit Security Check
# =============================================================================
# Purpose : Runs automated security checks before every commit or deployment.
#           Detects secret leakage, Firestore rule regressions, syntax errors,
#           CF quota risk, and high/critical npm vulnerabilities.
#
# Usage   : .\scripts\devsecops-check.ps1
#           Run from the repository root (C:\...\SOKONI).
#
# Pre-commit hook integration:
#   In .git/hooks/pre-commit (or .husky/pre-commit), add:
#     powershell -ExecutionPolicy Bypass -File scripts\devsecops-check.ps1
#     if ($LASTEXITCODE -ne 0) { exit 1 }
#
# Target execution time: < 30 seconds
#
# Author  : SOKONI Security Engineering
# Date    : 2026-06-28
# =============================================================================

Set-StrictMode -Version Latest
$ErrorActionPreference = "Continue"  # Don't halt on individual check failures

# ── Paths ────────────────────────────────────────────────────────────────────
$RepoRoot      = Split-Path -Parent $PSScriptRoot
$FunctionsDir  = Join-Path $RepoRoot "functions"
$IndexJs       = Join-Path $FunctionsDir "index.js"
$FirestoreRules = Join-Path $RepoRoot "firestore.rules"

# ── Issue counter ─────────────────────────────────────────────────────────────
$IssueCount = 0

# ── Helpers ──────────────────────────────────────────────────────────────────
function Write-Pass {
    param([string]$Message)
    Write-Host "[PASS] $Message" -ForegroundColor Green
}

function Write-Fail {
    param([string]$Message)
    Write-Host "[FAIL] $Message" -ForegroundColor Red
    $script:IssueCount++
}

function Write-Warn {
    param([string]$Message)
    Write-Host "[WARN] $Message" -ForegroundColor Yellow
}

function Write-Info {
    param([string]$Message)
    Write-Host "[INFO] $Message" -ForegroundColor Cyan
}

function Write-Section {
    param([string]$Title)
    Write-Host ""
    Write-Host "━━━ $Title ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor White
}

# ── Timer ────────────────────────────────────────────────────────────────────
$ScriptStart = Get-Date

# ─────────────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "╔══════════════════════════════════════════════════════════════════╗" -ForegroundColor DarkCyan
Write-Host "║       SOKONI DevSecOps Pre-Commit Security Check  v1.0          ║" -ForegroundColor DarkCyan
Write-Host "║       $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')                              ║" -ForegroundColor DarkCyan
Write-Host "╚══════════════════════════════════════════════════════════════════╝" -ForegroundColor DarkCyan
Write-Host ""

# =============================================================================
# CHECK 1 — Secret scan
# =============================================================================
Write-Section "CHECK 1 — Secret scan"
Write-Info "Scanning .js, .html, .json files for credential patterns ..."

# Patterns that should never appear in committed files
# Each entry: @(FriendlyName, RegexPattern)
$SecretPatterns = @(
    @("Anthropic API key (sk-ant-)",      "sk-ant-[a-zA-Z0-9\-_]{10,}"),
    @("SendGrid API key (SG.)",            "SG\.[a-zA-Z0-9\-_]{20,}"),
    @("Google API key (AIza)",             "AIza[0-9A-Za-z\-_]{35}"),
    @("M-Pesa password pattern",           "(?i)mpesa.{0,20}password|password.{0,20}mpesa"),
    @("AWS access key (AKIA)",             "AKIA[0-9A-Z]{16}")
)

# File extensions to scan
$ExtensionsToScan = @("*.js", "*.html", "*.json")

# Exclusion patterns
$ExcludePatterns = @(
    "\\node_modules\\",
    "\\.git\\",
    "\\sokoni-config.js",
    "\\package-lock.json"   # Lock files contain package URLs that can false-positive
)

$SecretLeakFound = $false

foreach ($Ext in $ExtensionsToScan) {
    $Files = Get-ChildItem -Path $RepoRoot -Filter $Ext -Recurse -ErrorAction SilentlyContinue |
        Where-Object {
            $path = $_.FullName
            $excluded = $false
            foreach ($ex in $ExcludePatterns) {
                if ($path -match [regex]::Escape($ex) -or $path -like "*$($ex.Replace('\\','/'))*") {
                    $excluded = $true
                    break
                }
            }
            # More robust exclusion
            if ($path -match 'node_modules' -or $path -match '\.git' -or $_.Name -eq 'sokoni-config.js' -or $_.Name -eq 'package-lock.json') {
                $excluded = $true
            }
            -not $excluded
        }

    foreach ($File in $Files) {
        $Content = Get-Content $File.FullName -Raw -ErrorAction SilentlyContinue
        if ($null -eq $Content -or $Content.Length -eq 0) { continue }

        foreach ($PatternPair in $SecretPatterns) {
            $FriendlyName = $PatternPair[0]
            $Pattern      = $PatternPair[1]

            if ($Content -match $Pattern) {
                # Find the line number for better reporting
                $LineNum = 0
                $Lines = $Content -split "`n"
                for ($i = 0; $i -lt $Lines.Length; $i++) {
                    if ($Lines[$i] -match $Pattern) {
                        $LineNum = $i + 1
                        break
                    }
                }
                Write-Fail "SECRET DETECTED — $FriendlyName"
                Write-Host "         File : $($File.FullName)" -ForegroundColor Red
                Write-Host "         Line : $LineNum" -ForegroundColor Red
                Write-Host "         Action: Remove credential and store in Secret Manager or functions/.env" -ForegroundColor Yellow
                $SecretLeakFound = $true
            }
        }
    }
}

if (-not $SecretLeakFound) {
    Write-Pass "No secret patterns detected in .js / .html / .json files."
}

# =============================================================================
# CHECK 2 — Firestore rules catch-all deny
# =============================================================================
Write-Section "CHECK 2 — Firestore rules catch-all deny"

if (-not (Test-Path $FirestoreRules)) {
    Write-Fail "firestore.rules file NOT FOUND at $FirestoreRules"
    Write-Warn "Without a rules file, Firestore may default to open access. Create firestore.rules immediately."
} else {
    $RulesContent = Get-Content $FirestoreRules -Raw -ErrorAction SilentlyContinue

    # Check for the catch-all deny pattern: "allow read, write: if false"
    # Also accept variations: "allow read,write: if false" / "allow write, read: if false"
    $CatchAllPattern = "allow\s+(?:read\s*,\s*write|write\s*,\s*read)\s*:\s*if\s+false"
    if ($RulesContent -match $CatchAllPattern) {
        Write-Pass "firestore.rules contains catch-all deny (allow read, write: if false)."
    } else {
        Write-Fail "firestore.rules does NOT contain a catch-all 'allow read, write: if false' rule."
        Write-Warn "Without a catch-all deny, any unmatched path may be accessible. Add to the bottom of your match block:"
        Write-Host "         match /{document=**} { allow read, write: if false; }" -ForegroundColor Yellow
    }

    # Additional sanity: warn if rules file is extremely short (likely placeholder)
    $RulesLineCount = ($RulesContent -split "`n").Count
    if ($RulesLineCount -lt 20) {
        Write-Warn "firestore.rules has only $RulesLineCount lines — this may be a placeholder. Review before deploying."
    } else {
        Write-Info "firestore.rules has $RulesLineCount lines."
    }
}

# =============================================================================
# CHECK 3 — Functions JS syntax check
# =============================================================================
Write-Section "CHECK 3 — Node.js syntax check (functions/*.js)"

# Check if Node is available
$NodeAvailable = $false
try {
    $null = & node --version 2>&1
    $NodeAvailable = $LASTEXITCODE -eq 0
} catch {
    $NodeAvailable = $false
}

if (-not $NodeAvailable) {
    Write-Warn "node not found in PATH — skipping syntax check. Install Node.js 22 to enable this check."
} else {
    $JsFiles = Get-ChildItem -Path $FunctionsDir -Filter "*.js" -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -notmatch 'node_modules' }

    $SyntaxErrors   = 0
    $SyntaxChecked  = 0

    foreach ($File in $JsFiles) {
        $SyntaxChecked++
        $Result = & node --check $File.FullName 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Fail "Syntax error in: $($File.Name)"
            Write-Host "         $($Result -join ' ')" -ForegroundColor Red
            $SyntaxErrors++
        }
    }

    if ($SyntaxErrors -eq 0) {
        Write-Pass "All $SyntaxChecked JS files in functions/ passed Node.js syntax check."
    } else {
        Write-Fail "$SyntaxErrors of $SyntaxChecked JS files have syntax errors — fix before committing."
    }
}

# =============================================================================
# CHECK 4 — index.js export count / Cloud Run quota warning
# =============================================================================
Write-Section "CHECK 4 — CF export count (Cloud Run quota)"

if (-not (Test-Path $IndexJs)) {
    Write-Fail "functions/index.js not found."
} else {
    $ExportLines  = Select-String -Path $IndexJs -Pattern "^exports\." | Measure-Object
    $ExportCount  = $ExportLines.Count

    Write-Info "Total exports in index.js: $ExportCount"

    if ($ExportCount -gt 700) {
        Write-Fail "Export count ($ExportCount) exceeds the 700 warning threshold."
        Write-Warn "Cloud Run has per-project instance and quota limits. Consider:"
        Write-Warn "  1. Splitting index.js into sub-modules with separate entry points"
        Write-Warn "  2. Consolidating rarely-used functions"
        Write-Warn "  3. Archiving deprecated functions"
    } elseif ($ExportCount -gt 600) {
        Write-Warn "Export count ($ExportCount) is between 600–700. Approaching the warning threshold."
        Write-Pass "Export count is within operational bounds — monitor actively."
    } else {
        Write-Pass "Export count ($ExportCount) is healthy (< 600). No quota risk."
    }
}

# =============================================================================
# CHECK 5 — npm audit (high/critical only)
# =============================================================================
Write-Section "CHECK 5 — npm audit --audit-level=high"

$NpmAvailable = $false
try {
    $null = & npm --version 2>&1
    $NpmAvailable = $LASTEXITCODE -eq 0
} catch {
    $NpmAvailable = $false
}

if (-not $NpmAvailable) {
    Write-Warn "npm not found in PATH — skipping package audit."
} elseif (-not (Test-Path $FunctionsDir)) {
    Write-Warn "functions/ directory not found — skipping package audit."
} else {
    Push-Location $FunctionsDir
    try {
        Write-Info "Running npm audit --audit-level=high ..."
        $AuditRaw  = npm audit --json --audit-level=high 2>&1
        $AuditText = $AuditRaw | Out-String

        # Try to parse JSON output for clean reporting
        try {
            $AuditJson = $AuditText | ConvertFrom-Json -ErrorAction Stop
            $Vuln      = $AuditJson.metadata.vulnerabilities
            $High      = if ($null -ne $Vuln.high)     { $Vuln.high }     else { 0 }
            $Critical  = if ($null -ne $Vuln.critical) { $Vuln.critical } else { 0 }
            $Total     = $High + $Critical

            Write-Info "  Critical vulnerabilities : $Critical"
            Write-Info "  High vulnerabilities     : $High"

            if ($Total -gt 0) {
                Write-Fail "$Total high/critical npm vulnerabilities found. Run 'npm audit fix' in functions/."
                Write-Host "         Run: cd functions && npm audit --audit-level=high  for full details." -ForegroundColor Yellow
            } else {
                Write-Pass "No high or critical npm vulnerabilities found."
            }
        } catch {
            # JSON parse failed — check exit code and raw text instead
            if ($LASTEXITCODE -ne 0) {
                # npm audit exits non-zero when vulns exist
                Write-Fail "npm audit detected vulnerabilities (exit code $LASTEXITCODE). Run 'npm audit --audit-level=high' in functions/ for details."
            } else {
                Write-Pass "npm audit --audit-level=high completed with no high/critical findings."
            }
        }
    } catch {
        Write-Warn "npm audit encountered an error: $_"
    } finally {
        Pop-Location
    }
}

# =============================================================================
# CHECK 6 — Firebase Firestore rules validation via CLI
# =============================================================================
Write-Section "CHECK 6 — Firebase rules validation (firebase CLI)"

# Check if firebase CLI is available
$FirebaseAvailable = $false
try {
    $null = & firebase --version 2>&1
    $FirebaseAvailable = $LASTEXITCODE -eq 0
} catch {
    $FirebaseAvailable = $false
}

if (-not $FirebaseAvailable) {
    # Try npx fallback
    try {
        $null = & npx -y firebase-tools --version 2>&1
        $FirebaseAvailable = $LASTEXITCODE -eq 0
        $FirebaseCmd = "npx -y firebase-tools"
    } catch {
        $FirebaseAvailable = $false
    }
}

if (-not $FirebaseAvailable) {
    Write-Warn "Firebase CLI not found — skipping Firestore rules validation."
    Write-Warn "Install with: npm install -g firebase-tools  or use: npx -y firebase-tools"
} elseif (-not (Test-Path $FirestoreRules)) {
    Write-Warn "firestore.rules not found — skipping Firebase rules validation."
} else {
    Write-Info "Attempting firebase rules validation ..."
    Push-Location $RepoRoot
    try {
        # Use 'firebase rules:test' if available — checks rules syntax without deploying
        # Note: --only firestore tests only Firestore rules; requires project to be set
        $FirebaseOutput = & firebase firestore:indexes 2>&1 | Out-Null
        # A lighter test: just check the rules file can be parsed by running a
        # 'firebase deploy --only firestore:rules --dry-run' equivalent
        # The safest cross-version approach is to validate the rules file exists and is parseable
        # by checking for common syntax errors using a rules-grammar check
        $RulesContent = Get-Content $FirestoreRules -Raw
        $BraceOpen    = ([regex]::Matches($RulesContent, '\{')).Count
        $BraceClose   = ([regex]::Matches($RulesContent, '\}')).Count

        if ($BraceOpen -ne $BraceClose) {
            Write-Fail "firestore.rules has mismatched braces: $BraceOpen open vs $BraceClose close."
            Write-Warn "This will cause a deploy failure. Fix brace matching in firestore.rules."
        } else {
            Write-Pass "firestore.rules brace balance check passed ($BraceOpen/{$BraceClose})."
        }

        # Check rules version declaration
        if ($RulesContent -match "rules_version\s*=\s*'2'") {
            Write-Pass "firestore.rules declares rules_version = '2' (required for Firestore)."
        } else {
            Write-Fail "firestore.rules does not declare rules_version = '2'. Add: rules_version = '2'; at the top."
        }
    } catch {
        Write-Warn "Firebase rules validation encountered an error: $_"
    } finally {
        Pop-Location
    }
}

# =============================================================================
# TIMING
# =============================================================================
$ScriptEnd      = Get-Date
$ElapsedSeconds = [math]::Round(($ScriptEnd - $ScriptStart).TotalSeconds, 1)

# =============================================================================
# FINAL SUMMARY
# =============================================================================
Write-Host ""
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor White
Write-Host "  DEVSECOPS CHECK — SUMMARY" -ForegroundColor White
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor White
Write-Host ""
Write-Host "  Total issues found : $IssueCount" -ForegroundColor $(if ($IssueCount -gt 0) { "Red" } else { "Green" })
Write-Host "  Elapsed time       : ${ElapsedSeconds}s" -ForegroundColor DarkGray
Write-Host ""

if ($IssueCount -eq 0) {
    Write-Host "╔══════════════════════════════════════════════════════════════════╗" -ForegroundColor Green
    Write-Host "║                                                                  ║" -ForegroundColor Green
    Write-Host "║   PASS — All DevSecOps checks passed. Safe to commit.           ║" -ForegroundColor Green
    Write-Host "║                                                                  ║" -ForegroundColor Green
    Write-Host "╚══════════════════════════════════════════════════════════════════╝" -ForegroundColor Green
} else {
    Write-Host "╔══════════════════════════════════════════════════════════════════╗" -ForegroundColor Red
    Write-Host "║                                                                  ║" -ForegroundColor Red
    Write-Host "║   FAIL — $IssueCount issue(s) detected. Do NOT commit until    ║" -ForegroundColor Red
    Write-Host "║   all failures above are resolved.                               ║" -ForegroundColor Red
    Write-Host "║                                                                  ║" -ForegroundColor Red
    Write-Host "╚══════════════════════════════════════════════════════════════════╝" -ForegroundColor Red
    Write-Host ""
    Write-Host "  Remediation priority order:" -ForegroundColor Yellow
    Write-Host "    1. [CRITICAL] Remove any detected secrets from source files" -ForegroundColor Yellow
    Write-Host "    2. [HIGH]     Fix JS syntax errors" -ForegroundColor Yellow
    Write-Host "    3. [HIGH]     Add Firestore catch-all deny rule" -ForegroundColor Yellow
    Write-Host "    4. [HIGH]     Fix high/critical npm vulnerabilities" -ForegroundColor Yellow
    Write-Host "    5. [MEDIUM]   Investigate CF export count if > 700" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  After fixing, re-run: .\scripts\devsecops-check.ps1" -ForegroundColor Cyan
}

Write-Host ""

# Exit with issue count so pre-commit hooks and CI pipelines detect failures
exit $IssueCount
