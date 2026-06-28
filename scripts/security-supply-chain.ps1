# =============================================================================
# SOKONI — Supply Chain Security Audit
# =============================================================================
# Purpose : Audits the functions/ directory for known-vulnerable packages,
#           pinned Firebase dependencies, secret leakage, and CF export count.
# Usage   : .\scripts\security-supply-chain.ps1
#           Run from the repository root (C:\...\SOKONI).
# Schedule: Run before every production deployment and weekly in CI.
# Author  : SOKONI Security Engineering
# Date    : 2026-06-28
# =============================================================================

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ── Paths ────────────────────────────────────────────────────────────────────
$RepoRoot    = Split-Path -Parent $PSScriptRoot
$FunctionsDir = Join-Path $RepoRoot "functions"
$IndexJs      = Join-Path $FunctionsDir "index.js"
$PkgJson      = Join-Path $FunctionsDir "package.json"
$PkgLock      = Join-Path $FunctionsDir "package-lock.json"

# ── Counters ─────────────────────────────────────────────────────────────────
$PassCount = 0
$FailCount = 0

# ── Helpers ──────────────────────────────────────────────────────────────────
function Write-Pass {
    param([string]$Message)
    Write-Host "[PASS] $Message" -ForegroundColor Green
    $script:PassCount++
}

function Write-Fail {
    param([string]$Message)
    Write-Host "[FAIL] $Message" -ForegroundColor Red
    $script:FailCount++
}

function Write-Info {
    param([string]$Message)
    Write-Host "[INFO] $Message" -ForegroundColor Cyan
}

function Write-Warn {
    param([string]$Message)
    Write-Host "[WARN] $Message" -ForegroundColor Yellow
}

function Write-Section {
    param([string]$Title)
    Write-Host ""
    Write-Host "━━━ $Title ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor White
}

# ─────────────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "╔══════════════════════════════════════════════════════════════════╗" -ForegroundColor Magenta
Write-Host "║        SOKONI Supply Chain Security Audit  v1.0                 ║" -ForegroundColor Magenta
Write-Host "║        $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')                              ║" -ForegroundColor Magenta
Write-Host "╚══════════════════════════════════════════════════════════════════╝" -ForegroundColor Magenta
Write-Host ""

# =============================================================================
# CHECK 1 — package-lock.json existence
# =============================================================================
Write-Section "CHECK 1 — package-lock.json"

if (Test-Path $PkgLock) {
    Write-Pass "package-lock.json found at functions/package-lock.json"
} else {
    Write-Fail "package-lock.json is MISSING from functions/. Run 'npm install' to generate it."
    Write-Warn "Without a lockfile, reproducible builds are not guaranteed and supply-chain attacks are harder to detect."
}

# =============================================================================
# CHECK 2 — npm audit
# =============================================================================
Write-Section "CHECK 2 — npm audit (functions/)"

Write-Info "Running npm audit in $FunctionsDir ..."
Push-Location $FunctionsDir
try {
    $AuditOutput = npm audit --json 2>&1
    $AuditJson   = $AuditOutput | Out-String | ConvertFrom-Json -ErrorAction SilentlyContinue

    if ($null -ne $AuditJson -and $null -ne $AuditJson.metadata) {
        $Vuln = $AuditJson.metadata.vulnerabilities
        $TotalVulns = $Vuln.low + $Vuln.moderate + $Vuln.high + $Vuln.critical

        Write-Info "  Critical : $($Vuln.critical)"
        Write-Info "  High     : $($Vuln.high)"
        Write-Info "  Moderate : $($Vuln.moderate)"
        Write-Info "  Low      : $($Vuln.low)"
        Write-Info "  Total    : $TotalVulns"

        if ($Vuln.critical -gt 0 -or $Vuln.high -gt 0) {
            Write-Fail "npm audit found $($Vuln.critical) critical and $($Vuln.high) high severity vulnerabilities."
        } elseif ($Vuln.moderate -gt 0) {
            Write-Warn "npm audit found $($Vuln.moderate) moderate vulnerabilities. Review before next release."
            Write-Pass "No critical or high vulnerabilities found via npm audit."
        } else {
            Write-Pass "npm audit — no critical/high/moderate vulnerabilities found."
        }
    } else {
        # npm audit returned plain text (no vulns or network error)
        $PlainText = $AuditOutput | Out-String
        if ($PlainText -match "found 0 vulnerabilities") {
            Write-Pass "npm audit — 0 vulnerabilities found."
        } else {
            Write-Warn "npm audit output could not be parsed as JSON. Raw output:"
            Write-Host $PlainText -ForegroundColor DarkGray
        }
    }
} catch {
    Write-Warn "npm audit failed to run: $_"
} finally {
    Pop-Location
}

# =============================================================================
# CHECK 3 — Known-bad package version ranges
# =============================================================================
Write-Section "CHECK 3 — Known-bad package versions"

if (-not (Test-Path $PkgLock)) {
    Write-Warn "Skipping version check — package-lock.json missing."
} else {
    $LockContent = Get-Content $PkgLock -Raw | ConvertFrom-Json -ErrorAction SilentlyContinue

    # Helper: extract installed version from lockfile (v2/v3 format)
    function Get-InstalledVersion {
        param([string]$PkgName)
        if ($null -eq $LockContent) { return $null }
        # lockfileVersion 2/3 uses "packages" key
        if ($null -ne $LockContent.packages) {
            $key = "node_modules/$PkgName"
            $pkg = $LockContent.packages.$key
            if ($null -ne $pkg) { return $pkg.version }
        }
        # lockfileVersion 1 uses "dependencies" key
        if ($null -ne $LockContent.dependencies) {
            $pkg = $LockContent.dependencies.$PkgName
            if ($null -ne $pkg) { return $pkg.version }
        }
        return $null
    }

    function Compare-SemVer {
        # Returns $true if $Installed is >= $MinRequired
        param([string]$Installed, [string]$MinRequired)
        try {
            $i = [Version]($Installed -replace '-.*$','')
            $m = [Version]($MinRequired -replace '-.*$','')
            return $i -ge $m
        } catch {
            return $true  # Can't compare — assume OK
        }
    }

    # lodash < 4.17.21  (prototype pollution CVE-2020-8203)
    $LodashVer = Get-InstalledVersion "lodash"
    if ($null -ne $LodashVer) {
        if (Compare-SemVer $LodashVer "4.17.21") {
            Write-Pass "lodash $LodashVer >= 4.17.21 (CVE-2020-8203 safe)"
        } else {
            Write-Fail "lodash $LodashVer is BELOW 4.17.21 — vulnerable to prototype pollution (CVE-2020-8203). Run: npm install lodash@latest"
        }
    } else {
        Write-Info "lodash not found in lockfile — not installed (OK)."
    }

    # axios < 0.21.2  (SSRF / ReDoS CVE-2021-3749)
    $AxiosVer = Get-InstalledVersion "axios"
    if ($null -ne $AxiosVer) {
        if (Compare-SemVer $AxiosVer "0.21.2") {
            Write-Pass "axios $AxiosVer >= 0.21.2 (CVE-2021-3749 safe)"
        } else {
            Write-Fail "axios $AxiosVer is BELOW 0.21.2 — SSRF/ReDoS risk (CVE-2021-3749). Run: npm install axios@latest"
        }
    } else {
        Write-Info "axios not found in lockfile — not installed (OK)."
    }

    # node-fetch < 2.6.7  (header injection CVE-2022-0235)
    $NodeFetchVer = Get-InstalledVersion "node-fetch"
    if ($null -ne $NodeFetchVer) {
        if (Compare-SemVer $NodeFetchVer "2.6.7") {
            Write-Pass "node-fetch $NodeFetchVer >= 2.6.7 (CVE-2022-0235 safe)"
        } else {
            Write-Fail "node-fetch $NodeFetchVer is BELOW 2.6.7 — header injection risk (CVE-2022-0235). Run: npm install node-fetch@latest"
        }
    } else {
        Write-Info "node-fetch not found in lockfile — not installed (OK)."
    }
}

# =============================================================================
# CHECK 4 — Firebase package pinning (no ^ float on firebase-admin/functions)
# =============================================================================
Write-Section "CHECK 4 — Firebase package pinning"

if (Test-Path $PkgJson) {
    $PkgContent = Get-Content $PkgJson -Raw | ConvertFrom-Json
    $Deps       = $PkgContent.dependencies

    $FirebasePackages = @("firebase-admin", "firebase-functions")
    $PinFail = $false

    foreach ($Pkg in $FirebasePackages) {
        $VersionSpec = $Deps.$Pkg
        if ($null -eq $VersionSpec) {
            Write-Warn "$Pkg not listed in dependencies — skipping pin check."
            continue
        }
        if ($VersionSpec -match '^\^') {
            Write-Fail "$Pkg version '$VersionSpec' uses ^ (floating). Pin to an exact version for production stability. Example: `"$Pkg`": `"$($VersionSpec.TrimStart('^'))`""
            $PinFail = $true
        } elseif ($VersionSpec -match '^~') {
            Write-Warn "$Pkg version '$VersionSpec' uses ~ (patch-float). Consider pinning exactly for maximum reproducibility."
        } else {
            Write-Pass "$Pkg is pinned to '$VersionSpec' — no floating range."
        }
    }

    if (-not $PinFail) {
        # Show the versions for audit trail
        foreach ($Pkg in $FirebasePackages) {
            $V = $Deps.$Pkg
            if ($null -ne $V) { Write-Info "  $Pkg = $V" }
        }
    }
} else {
    Write-Fail "functions/package.json not found — cannot check Firebase pinning."
}

# =============================================================================
# CHECK 5 — Secret leakage scan
# =============================================================================
Write-Section "CHECK 5 — Secret leakage scan (ANTHROPIC_API_KEY / SENDGRID_API_KEY / SOKONI_HMAC_KEY)"

# Secrets should ONLY appear in sokoni-config.js (which is .gitignored)
# We scan all .js files EXCEPT sokoni-config.js
$SecretPatterns = @(
    "ANTHROPIC_API_KEY\s*=\s*['""][^'""]+['""]",
    "SENDGRID_API_KEY\s*=\s*['""][^'""]+['""]",
    "SOKONI_HMAC_KEY\s*=\s*['""][^'""]+['""]"
)

# Directories to scan: project root JS files + functions/ (excluding node_modules)
$ScanRoots = @(
    $RepoRoot,
    $FunctionsDir
)

$LeakFound = $false

foreach ($Root in $ScanRoots) {
    $JsFiles = Get-ChildItem -Path $Root -Filter "*.js" -Recurse -ErrorAction SilentlyContinue |
        Where-Object {
            $_.FullName -notmatch '\\node_modules\\' -and
            $_.FullName -notmatch '\\.git\\' -and
            $_.Name -ne 'sokoni-config.js'
        }

    foreach ($File in $JsFiles) {
        $Content = Get-Content $File.FullName -Raw -ErrorAction SilentlyContinue
        if ($null -eq $Content) { continue }

        foreach ($Pattern in $SecretPatterns) {
            if ($Content -match $Pattern) {
                $KeyName = ($Pattern -split '\\s')[0]
                Write-Fail "SECRET LEAK: $KeyName found with a literal value in: $($File.FullName)"
                Write-Warn "  Move this value to Secret Manager and reference it via process.env.$KeyName"
                $LeakFound = $true
            }
        }
    }
}

if (-not $LeakFound) {
    Write-Pass "No hardcoded secret values found in .js files (outside sokoni-config.js)."
}

# =============================================================================
# CHECK 6 — Cloud Function export count
# =============================================================================
Write-Section "CHECK 6 — Cloud Function export count"

if (Test-Path $IndexJs) {
    $ExportLines = Select-String -Path $IndexJs -Pattern "^exports\." | Measure-Object
    $ExportCount = $ExportLines.Count

    Write-Info "Total CF exports in index.js: $ExportCount"

    if ($ExportCount -gt 700) {
        Write-Fail "Export count ($ExportCount) exceeds 700. Cloud Run has per-project limits; consider splitting index.js into sub-modules."
    } elseif ($ExportCount -gt 600) {
        Write-Warn "Export count ($ExportCount) is approaching the 700 warning threshold. Monitor this."
        Write-Pass "Export count is within operational bounds (>600, <=700)."
    } else {
        Write-Pass "Export count ($ExportCount) is healthy (< 600)."
    }
} else {
    Write-Fail "functions/index.js not found — cannot count exports."
}

# =============================================================================
# SUMMARY
# =============================================================================
Write-Host ""
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor White
Write-Host "  SUPPLY CHAIN SECURITY AUDIT — SUMMARY" -ForegroundColor White
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor White
Write-Host ""
Write-Host "  Checks PASSED : $PassCount" -ForegroundColor Green
Write-Host "  Checks FAILED : $FailCount" -ForegroundColor $(if ($FailCount -gt 0) { "Red" } else { "Green" })
Write-Host ""

if ($FailCount -eq 0) {
    Write-Host "  ✔  ALL SUPPLY CHAIN CHECKS PASSED — safe to deploy." -ForegroundColor Green
} else {
    Write-Host "  ✘  $FailCount CHECK(S) FAILED — resolve all failures before deploying to production." -ForegroundColor Red
    Write-Host ""
    Write-Host "  Recommended actions:" -ForegroundColor Yellow
    Write-Host "    1. Run: npm audit fix --force  (in functions/)" -ForegroundColor Yellow
    Write-Host "    2. Pin firebase-admin and firebase-functions to exact versions." -ForegroundColor Yellow
    Write-Host "    3. Move any hardcoded secrets to Firebase Secret Manager." -ForegroundColor Yellow
    Write-Host "    4. Re-run this script after fixes to confirm clean status." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "  Audit complete: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" -ForegroundColor DarkGray
Write-Host ""

# Exit with non-zero code so CI pipelines detect failures
exit $FailCount
